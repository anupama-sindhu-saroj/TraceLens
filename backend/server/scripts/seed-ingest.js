// Send seed data through the REAL ingestion endpoints (owner: B).
//
//   const { sendThroughIngestion, createSenders } = require('./seed-ingest');
//
// Paths (the "--via" option of seed.js):
//   http         POST /v1/traces|/v1/logs  application/json          -> src/ingest/http.js
//   http-proto   POST /v1/traces|/v1/logs  application/x-protobuf    -> src/ingest/http.js (decodeTraces/decodeLogs)
//   grpc         TraceService/LogsService.Export on :4317            -> src/ingest/grpc.js
//   mixed        requests rotate http -> http-proto -> grpc, so ONE run exercises all three paths
//
// Unlike a direct seed, the server must be RUNNING (it owns the DuckDB file); we never open the database here.
const { toTraceRequest, toLogRequest } = require('./seed-otlp');

const PATHS = ['http', 'http-proto', 'grpc'];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const TYPES = {
  spans: { url: '/v1/traces', build: toTraceRequest, proto: 'opentelemetry.proto.collector.trace.v1.ExportTraceServiceRequest' },
  logs: { url: '/v1/logs', build: toLogRequest, proto: 'opentelemetry.proto.collector.logs.v1.ExportLogsServiceRequest' },
};

function retryable(e) {
  // Back-pressure from the server: HTTP 429/503, or gRPC UNAVAILABLE "ingest queue full" (see ingest/grpc.js).
  return e.retryable === true || /queue full/i.test(String(e.message));
}

async function withRetry(fn) {
  for (let attempt = 0; ; attempt++) {
    try { return await fn(); } catch (e) {
      if (!retryable(e) || attempt >= 6) throw e;
      await sleep(250 * 2 ** attempt); // exporters do the same: back off, then try again
    }
  }
}

async function post(url, contentType, body) {
  let res;
  try {
    res = await fetch(url, { method: 'POST', headers: { 'content-type': contentType }, body });
  } catch (e) {
    throw new Error(`cannot reach ${url} (${e.cause?.code ?? e.message}). Is the server running? (npm run server)`);
  }
  if (!res.ok) {
    const err = new Error(`${url} answered ${res.status}: ${(await res.text()).slice(0, 200)}`);
    err.retryable = res.status === 429 || res.status === 503;
    throw err;
  }
}

/** One sender per path: send(table, rows) -> Promise. Call close() when done. */
function createSenders({ httpEndpoint = 'http://localhost:4318', grpcEndpoint = 'localhost:4317' } = {}) {
  const http = httpEndpoint.replace(/\/+$/, '');
  const grpcAddr = grpcEndpoint.replace(/^https?:\/\//, '');
  let protoRoot = null;
  let grpcClients = null;

  const getGrpc = () => {
    if (grpcClients) return grpcClients;
    const grpc = require('@grpc/grpc-js');
    const { loadProto } = require('../src/ingest/grpc'); // same proto + loader options as the server
    const { TraceService, LogsService } = loadProto();
    const opts = { 'grpc.max_send_message_length': 20 * 1024 * 1024 };
    grpcClients = {
      spans: new TraceService(grpcAddr, grpc.credentials.createInsecure(), opts),
      logs: new LogsService(grpcAddr, grpc.credentials.createInsecure(), opts),
    };
    return grpcClients;
  };

  const senders = {
    http: (table, rows) => post(http + TYPES[table].url, 'application/json', JSON.stringify(TYPES[table].build(rows))),

    'http-proto': (table, rows) => {
      protoRoot ??= require('../src/ingest/otlp-parser').root; // reuse the server's protobufjs root
      const T = protoRoot.lookupType(TYPES[table].proto);
      const bytes = T.encode(T.fromObject(TYPES[table].build(rows, { binaryIds: true }))).finish();
      return post(http + TYPES[table].url, 'application/x-protobuf', bytes);
    },

    grpc: (table, rows) => new Promise((resolve, reject) => {
      getGrpc()[table].Export(TYPES[table].build(rows, { binaryIds: true }), (err) => (err ? reject(err) : resolve()));
    }),
  };

  return {
    send: (via, table, rows) => withRetry(() => senders[via](table, rows)),
    // fail early with a clear message instead of hanging on the first request
    async checkGrpc(timeoutMs = 3000) {
      await new Promise((resolve, reject) => getGrpc().spans.waitForReady(Date.now() + timeoutMs, (err) =>
        (err ? reject(new Error(`cannot reach OTLP/gRPC at ${grpcAddr}. Is the server running? (npm run server)`)) : resolve())));
    },
    close() { if (grpcClients) { grpcClients.spans.close(); grpcClients.logs.close(); grpcClients = null; } },
  };
}

// ---- server health: used to pace the upload and to check nothing was lost ------------------------------------------

async function getHealth(api) {
  const res = await fetch(`${api.replace(/\/+$/, '')}/api/health`, { signal: AbortSignal.timeout(5000) });
  if (!res.ok) throw new Error(`/api/health answered ${res.status}`);
  return res.json(); // { status, db, spans, batcher: { queued: {spans, logs}, spans: {written, dropped}, logs: {...} } }
}

async function waitUntilDrained(api, timeoutMs = 30_000) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const h = await getHealth(api);
    if (h.batcher.queued.spans === 0 && h.batcher.queued.logs === 0) return h;
    if (Date.now() > end) return h;
    await sleep(200);
  }
}

/**
 * @param {Object} o
 * @param {'http'|'http-proto'|'grpc'|'mixed'} o.via
 * @param {Array} o.spans  @param {Array} o.logs   rows from generate()
 * @param {number} [o.batchSize]    rows per request (an OTel exporter sends ~512)
 * @param {string} [o.api]          server REST base URL, used for pacing + verification. null = skip both.
 * @param {number} [o.maxBacklog]   pause sending while the server's batcher queue is longer than this
 */
async function sendThroughIngestion({ via, spans, logs, batchSize = 500, api = 'http://localhost:8080', maxBacklog = 20_000, httpEndpoint, grpcEndpoint, log = console.log }) {
  if (via !== 'mixed' && !PATHS.includes(via)) throw new Error(`unknown path "${via}" (use ${[...PATHS, 'mixed'].join(' | ')})`);
  const rotation = via === 'mixed' ? PATHS : [via];
  const senders = createSenders({ httpEndpoint, grpcEndpoint });
  const stats = Object.fromEntries(rotation.map((p) => [p, { requests: 0, spans: 0, logs: 0, ms: 0 }]));

  let before = null;
  if (api) {
    try { before = await getHealth(api); } catch (e) {
      throw new Error(`cannot reach the server API at ${api} (${e.cause?.code ?? e.message}). Is the server running? (npm run server)\nUse --no-verify to skip this check.`);
    }
  }
  try {
    if (rotation.includes('grpc')) await senders.checkGrpc();

    let n = 0;
    for (const [table, rows] of [['spans', spans], ['logs', logs]]) {
      for (let i = 0; i < rows.length; i += batchSize) {
        const via1 = rotation[n++ % rotation.length];
        const part = rows.slice(i, i + batchSize);
        if (api && n % 5 === 0) {
          // HTTP never says "queue full" (only gRPC does), so slow down here instead of letting the batcher drop rows
          for (let h = await getHealth(api); h.batcher.queued[table] > maxBacklog; h = await getHealth(api)) await sleep(250);
        }
        const t0 = Date.now();
        await senders.send(via1, table, part);
        const s = stats[via1];
        s.requests++; s[table] += part.length; s.ms += Date.now() - t0;
      }
      log(`[seed] sent ${rows.length} ${table}`);
    }
  } finally {
    senders.close();
  }

  const report = { stats, sent: { spans: spans.length, logs: logs.length }, verified: null };
  if (api) {
    const after = await waitUntilDrained(api);
    const delta = (t, k) => after.batcher[t][k] - before.batcher[t][k];
    report.verified = {
      spans: { written: delta('spans', 'written'), dropped: delta('spans', 'dropped'), dbRows: after.spans - before.spans },
      logs: { written: delta('logs', 'written'), dropped: delta('logs', 'dropped') },
      drained: after.batcher.queued.spans === 0 && after.batcher.queued.logs === 0,
    };
    const v = report.verified;
    report.ok = v.drained && v.spans.written === spans.length && v.logs.written === logs.length && v.spans.dropped === 0 && v.logs.dropped === 0;
  }
  return report;
}

module.exports = { sendThroughIngestion, createSenders, PATHS };
