// OTLP/HTTP ingestion (feature 4, owner: A). Listens on :4318 (OTLP_HTTP_PORT) - the port the demo services export to.
//   POST /v1/traces   POST /v1/logs      Content-Type: application/json | application/x-protobuf
const express = require('express');
const { parseTracesDetailed, parseLogs, decodeTraces, decodeLogs, encodeTraceResponse } = require('./otlp-parser');
const { batcher } = require('./batcher');

function createIngestApp() {
  const app = express();
  app.use(express.json({ limit: '20mb' }));
  app.use(express.raw({ type: ['application/x-protobuf', 'application/protobuf'], limit: '20mb' }));

  // `parse` returns { rows, rejected }. Reply meaning:
  //   200  accepted into the batcher queue (+ partialSuccess when some spans were malformed)
  //   400  body is not valid OTLP        503 + Retry-After  queue full, nothing was taken -> exporter should retry
  const handler = (table, decode, parse) => (req, res) => {
    try {
      const isProto = req.is(['application/x-protobuf', 'application/protobuf']);
      const body = isProto ? decode(req.body) : req.body;
      if (!body || typeof body !== 'object') throw new Error('empty or invalid body');
      const { rows, rejected } = parse(body);
      if (!batcher.enqueue(table, rows)) {
        res.set('Retry-After', '1');
        return res.status(503).json({ error: `ingest queue full, retry later (${table})` });
      }
      const errorMessage = rejected ? `${rejected} ${table === 'spans' ? 'span(s)' : 'record(s)'} rejected: invalid trace/span id` : '';
      if (isProto) {
        res.status(200).type('application/x-protobuf').send(rejected && table === 'spans' ? encodeTraceResponse(rejected, errorMessage) : Buffer.alloc(0));
      } else if (rejected) {
        res.status(200).json({ partialSuccess: { rejectedSpans: String(rejected), errorMessage } });
      } else {
        res.status(200).json({}); // empty ExportServiceResponse
      }
    } catch (e) {
      res.status(400).json({ error: `invalid OTLP ${table} payload: ${e.message}` });
    }
  };

  app.post('/v1/traces', handler('spans', decodeTraces, parseTracesDetailed));
  app.post('/v1/logs', handler('logs', decodeLogs, (b) => ({ rows: parseLogs(b), rejected: 0 })));
  app.use((err, _req, res, _next) => res.status(400).json({ error: err.message })); // body-parser errors
  return app;
}

function startHttpIngest(port = Number(process.env.OTLP_HTTP_PORT ?? 4318)) {
  return new Promise((resolve, reject) => {
    const server = createIngestApp().listen(port, () => {
      console.log(`[ingest] OTLP/HTTP listening on :${port}`);
      resolve(server);
    });
    server.on('error', reject);
  });
}

module.exports = { createIngestApp, startHttpIngest };
