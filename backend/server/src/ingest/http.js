// OTLP/HTTP ingestion (feature 4, owner: A). Listens on :4318 (OTLP_HTTP_PORT) - the port the demo services export to.
//   POST /v1/traces   POST /v1/logs      Content-Type: application/json | application/x-protobuf
const express = require('express');
const { parseTraces, parseLogs, decodeTraces, decodeLogs } = require('./otlp-parser');
const { batcher } = require('./batcher');

function createIngestApp() {
  const app = express();
  app.use(express.json({ limit: '20mb' }));
  app.use(express.raw({ type: ['application/x-protobuf', 'application/protobuf'], limit: '20mb' }));

  const handler = (table, decode, parse) => (req, res) => {
    try {
      const isProto = req.is(['application/x-protobuf', 'application/protobuf']);
      const body = isProto ? decode(req.body) : req.body;
      if (!body || typeof body !== 'object') throw new Error('empty or invalid body');
      batcher.enqueue(table, parse(body));
      // success = empty ExportServiceResponse (0 bytes in protobuf, {} in JSON)
      if (isProto) res.status(200).type('application/x-protobuf').send(Buffer.alloc(0));
      else res.status(200).json({});
    } catch (e) {
      res.status(400).json({ error: `invalid OTLP ${table} payload: ${e.message}` });
    }
  };

  app.post('/v1/traces', handler('spans', decodeTraces, parseTraces));
  app.post('/v1/logs', handler('logs', decodeLogs, parseLogs));
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
