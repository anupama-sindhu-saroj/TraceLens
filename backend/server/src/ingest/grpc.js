// OTLP/gRPC ingestion (feature 5, owner: B). Listens on :4317 (OTLP_GRPC_PORT), the port the demo services export to
// when <SERVICE>_PROTOCOL=grpc.
//
// It does NOT parse anything itself: it hands the request to A's otlp-parser (parseTraces / parseLogs) and then to
// batcher.enqueue(), exactly like the HTTP endpoint does. So HTTP and gRPC always produce identical rows.
//
//   const { startGrpcIngest } = require('./ingest/grpc');
//   const grpcIngest = await startGrpcIngest();   // after db.init() and batcher.start()
//   await grpcIngest.close();                     // on shutdown, BEFORE batcher.stop() so queued data is flushed
const path = require('node:path');
const grpc = require('@grpc/grpc-js');
const protoLoader = require('@grpc/proto-loader');
const { parseTracesDetailed, parseLogs } = require('./otlp-parser');
const { batcher } = require('./batcher');

const PROTO_DIR = path.join(__dirname, '..', '..', 'proto');
const MAX_MESSAGE_BYTES = 20 * 1024 * 1024; // same limit as the HTTP endpoint (20mb)

// These options make grpc-js hand us the SAME shape the parser already understands:
//   keepCase:false -> camelCase fields (resourceSpans, traceId, startTimeUnixNano ...)
//   bytes: Buffer  -> trace/span ids as Buffers (parser's idHex() turns them into hex)
//   longs: String  -> fixed64 timestamps as strings (parser's nanos() turns them into BigInt)
//   enums (default) -> numbers (kind/status.code are int32 in our protos)
//   defaults:false -> absent fields stay undefined (a missing parent_span_id means "root span")
const LOADER_OPTIONS = {
  includeDirs: [PROTO_DIR],
  keepCase: false,
  longs: String,
  bytes: Buffer,
  defaults: false,
  arrays: true,
  oneofs: false,
};

function loadProto() {
  const definition = protoLoader.loadSync([
    'opentelemetry/proto/collector/trace/v1/trace_service.proto',
    'opentelemetry/proto/collector/logs/v1/logs_service.proto',
  ], LOADER_OPTIONS);
  const pkg = grpc.loadPackageDefinition(definition).opentelemetry.proto.collector;
  return { TraceService: pkg.trace.v1.TraceService, LogsService: pkg.logs.v1.LogsService };
}

// Back-pressure: if the whole request does not fit in the batcher backlog, tell the exporter to retry later instead of
// silently dropping part of it (batcher.enqueue() takes all rows or none).
// UNAVAILABLE is used (not RESOURCE_EXHAUSTED) because OTLP exporters retry UNAVAILABLE with backoff by default,
// while RESOURCE_EXHAUSTED is only retried when the server sends RetryInfo.
function exportHandler(table, parse, noun) {
  return (call, callback) => {
    let parsed;
    try {
      parsed = parse(call.request);
    } catch (e) {
      return callback({ code: grpc.status.INVALID_ARGUMENT, message: `invalid OTLP ${noun} payload: ${e.message}` });
    }
    if (!batcher.enqueue(table, parsed.rows)) {
      return callback({ code: grpc.status.UNAVAILABLE, message: `ingest queue full, retry later (${table})` });
    }
    if (parsed.rejected) { // OTLP partial_success: tell the exporter some records were malformed (do not retry those)
      const errorMessage = `${parsed.rejected} ${noun} rejected: invalid trace/span id`;
      return callback(null, table === 'spans'
        ? { partialSuccess: { rejectedSpans: parsed.rejected, errorMessage } }
        : { partialSuccess: { rejectedLogRecords: parsed.rejected, errorMessage } });
    }
    callback(null, {}); // success = empty ExportServiceResponse
  };
}

/**
 * @param {Object} [o]
 * @param {number} [o.port]  default OTLP_GRPC_PORT or 4317 (0 = random free port, handy for tests)
 * @param {string} [o.host]  default OTLP_GRPC_HOST or 0.0.0.0
 * @returns {Promise<{ server: grpc.Server, port: number, close: () => Promise<void> }>}
 */
function startGrpcIngest({ port = Number(process.env.OTLP_GRPC_PORT ?? 4317), host = process.env.OTLP_GRPC_HOST ?? '0.0.0.0' } = {}) {
  const { TraceService, LogsService } = loadProto();
  const server = new grpc.Server({ 'grpc.max_receive_message_length': MAX_MESSAGE_BYTES });
  server.addService(TraceService.service, { Export: exportHandler('spans', parseTracesDetailed, 'spans') });
  server.addService(LogsService.service, { Export: exportHandler('logs', (r) => ({ rows: parseLogs(r), rejected: 0 }), 'logs') });

  return new Promise((resolve, reject) => {
    server.bindAsync(`${host}:${port}`, grpc.ServerCredentials.createInsecure(), (err, boundPort) => {
      if (err) return reject(err);
      // grpc-js >= 1.10 starts serving after bindAsync; server.start() is deprecated and not needed.
      console.log(`[ingest] OTLP/gRPC listening on :${boundPort}`);
      const close = () => new Promise((done) => {
        const timer = setTimeout(() => { server.forceShutdown(); done(); }, 3000); // don't hang on open streams
        timer.unref();
        server.tryShutdown(() => { clearTimeout(timer); done(); });
      });
      resolve({ server, port: boundPort, close });
    });
  });
}

module.exports = { startGrpcIngest, loadProto };
