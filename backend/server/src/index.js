const express = require('express');
const cors = require('cors');
const { demoRouter } = require('./api/demo');
const { tracesRouter } = require('./api/traces');
const { statsRouter } = require('./api/stats');
const { logsRouter } = require('./api/logs');
const { anomaliesRouter } = require('./api/anomalies');
const { topologyRouter } = require('./api/topology');
const { startDetector } = require('./anomaly/detector');
const db = require('./db');
const { batcher } = require('./ingest/batcher');
const { startHttpIngest } = require('./ingest/http');
const { startGrpcIngest } = require('./ingest/grpc');
const { attachLiveTail } = require('./ws/logs');
const { startRetention } = require('./retention/retention');

let retention = null; // set after db.init(); stays null when RETENTION_DAYS is not set

const PORT = Number(process.env.PORT ?? 8080);
const app = express();

app.use(cors());
app.use(express.json({ limit: '20mb' }));

app.get('/api/health', async (_req, res) => {
  try {
    const [{ n }] = await db.query('SELECT count(*) AS n FROM spans');
    res.json({ status: 'ok', db: 'ok', spans: n, batcher: batcher.stats(), retention: retention ? retention.stats() : { enabled: false } });
  } catch (e) {
    res.status(500).json({ status: 'error', db: String(e.message) });
  }
});
app.use('/api/demo', demoRouter);
app.use('/api/traces', tracesRouter);
app.use('/api/stats', statsRouter);
app.use('/api/logs', logsRouter);
app.use('/api/anomalies', anomaliesRouter);
app.use('/api/topology', topologyRouter);

app.use((_req, res) => res.status(404).json({ error: 'not found' }));
app.use((err, _req, res, _next) => { console.error('[server]', err); res.status(500).json({ error: String(err.message || err) }); });

db.init().then(async () => {
  batcher.start();
  retention = startRetention();
  const detector = startDetector();
  const ingest = await startHttpIngest();
  const grpcIngest = await startGrpcIngest();
  const server = app.listen(PORT, () => console.log(`[server] API listening on :${PORT}`));
  const liveTail = attachLiveTail(server, { batcher });
  const shutdown = async () => { await liveTail.close(); server.close(); detector.stop(); if (retention) retention.stop(); ingest.close(); await grpcIngest.close(); await batcher.stop(); await db.close(); process.exit(0); };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}).catch((e) => { console.error('[server] db init failed:', e); process.exit(1); });