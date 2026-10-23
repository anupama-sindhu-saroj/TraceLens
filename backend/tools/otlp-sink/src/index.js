// Dev-only OTLP/HTTP sink so you can verify the demo services BEFORE your own
// ingestion gateway exists. Accepts JSON and protobuf on :4318, prints a
// summary every 5s. Delete / ignore once your real otlp ingestion (feature 4) is up.
// NOTE: gRPC (:4317) is NOT handled here - gRPC is B's feature 5.
const express = require('express');

const PORT = Number(process.env.SINK_PORT ?? 4318);
const app = express();
app.use(express.raw({ type: ['application/x-protobuf', 'application/protobuf'], limit: '20mb' }));
app.use(express.json({ limit: '20mb' }));

const counts = {
  traces: { requests: 0, spans: 0, json: 0, proto: 0, bytes: 0 },
  logs: { requests: 0, records: 0, json: 0, proto: 0, bytes: 0 },
};
const services = new Set();
const traceIds = new Set();
let sample = null;

const svcOf = (rs) =>
  rs.resource?.attributes?.find((a) => a.key === 'service.name')?.value?.stringValue;

app.post('/v1/traces', (req, res) => {
  const isJson = req.is('application/json');
  counts.traces.requests++;
  counts.traces[isJson ? 'json' : 'proto']++;
  if (isJson) {
    for (const rs of req.body?.resourceSpans ?? []) {
      const s = svcOf(rs);
      if (s) services.add(s);
      for (const ss of rs.scopeSpans ?? []) {
        for (const sp of ss.spans ?? []) {
          counts.traces.spans++;
          traceIds.add(sp.traceId);
          sample ??= sp;
        }
      }
    }
  } else {
    counts.traces.bytes += req.body?.length ?? 0; // protobuf: just count bytes
  }
  res.status(200).json({});
});

app.post('/v1/logs', (req, res) => {
  const isJson = req.is('application/json');
  counts.logs.requests++;
  counts.logs[isJson ? 'json' : 'proto']++;
  if (isJson) {
    for (const rl of req.body?.resourceLogs ?? []) {
      for (const sl of rl.scopeLogs ?? []) counts.logs.records += (sl.logRecords ?? []).length;
    }
  } else {
    counts.logs.bytes += req.body?.length ?? 0;
  }
  res.status(200).json({});
});

setInterval(() => {
  console.log(
    `[sink] traces: ${JSON.stringify(counts.traces)} | logs: ${JSON.stringify(counts.logs)} | services: [${[...services].join(', ')}] | distinct traceIds(json): ${traceIds.size}`,
  );
}, 5000);

app.get('/sample', (_req, res) => res.json(sample));
app.listen(PORT, () => console.log(`[sink] OTLP/HTTP sink listening on :${PORT} (GET /sample shows one span)`));
