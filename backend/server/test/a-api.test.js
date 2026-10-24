// Tests for A's features: trace API, stats API, anomaly detector. Uses seed-data (B) on an in-memory DB.
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const db = require('../src/db');
const { generate } = require('../scripts/seed-data');
const { tracesRouter } = require('../src/api/traces');
const { statsRouter } = require('../src/api/stats');
const { runDetection } = require('../src/anomaly/detector');
const { classifyHealth } = require('../src/shared/health');

let server; let base;
const get = async (p) => { const r = await fetch(base + p); return { status: r.status, body: await r.json() }; };
const load = async (data) => {
  for (let i = 0; i < data.spans.length; i += 5000) await db.insertSpans(data.spans.slice(i, i + 5000));
  await db.insertLogs(data.logs);
};
const reset = async () => { await db.exec('DELETE FROM spans'); await db.exec('DELETE FROM logs'); await db.exec('DELETE FROM anomalies'); };

test.before(async () => {
  await db.init(':memory:');
  const app = express();
  app.use('/api/traces', tracesRouter);
  app.use('/api/stats', statsRouter);
  server = app.listen(0);
  base = `http://localhost:${server.address().port}`;
});
test.after(async () => { server.close(); await db.close(); });

test('health rule', () => {
  assert.equal(classifyHealth({ requests: 0 }), 'unknown');
  assert.equal(classifyHealth({ requests: 50, errorRate: 0.01, p99Ms: 250 }), 'healthy');
  assert.equal(classifyHealth({ requests: 50, errorRate: 0.05, p99Ms: 250 }), 'degraded');
  assert.equal(classifyHealth({ requests: 50, errorRate: 0.01, p99Ms: 1800 }), 'failing');
});

test('healthy data: APIs work and detector raises NOTHING', async () => {
  await reset();
  await load(generate({ now: Date.now(), minutes: 40, flowsPerMin: 30, incident: false, anomalies: false }));

  const list = await get('/api/traces?limit=10');
  assert.equal(list.status, 200);
  assert.equal(list.body.traces.length, 10);
  assert.ok(list.body.total > 100);
  const t = list.body.traces[0];
  assert.ok(t.traceId && t.rootName && t.durationMs > 0 && t.spanCount > 0 && t.services.length > 0);

  const byService = await get('/api/traces?service=payment&limit=5');
  assert.ok(byService.body.traces.every((x) => x.services.includes('payment')));
  const only5xx = await get('/api/traces?status=5xx&limit=20');
  assert.ok(only5xx.body.traces.every((x) => x.httpStatus >= 500 && x.httpStatus < 600));
  const slow = await get('/api/traces?minDurationMs=150&sort=duration&limit=5');
  assert.ok(slow.body.traces.every((x) => x.durationMs >= 150));
  const future = await get(`/api/traces?from=${Date.now() + 60000}`);
  assert.equal(future.body.total, 0);

  const detail = await get(`/api/traces/${t.traceId}`);
  assert.equal(detail.status, 200);
  assert.equal(detail.body.spans.length, t.spanCount);
  assert.equal(detail.body.spans.filter((s) => s.parentSpanId === null).length, 1);
  assert.equal((await get('/api/traces/nope')).status, 404);

  const ov = await get('/api/stats/overview?minutes=30');
  assert.ok(ov.body.totalRequests > 0 && ov.body.errorRate < 0.1 && ov.body.activeServices === 4);
  const ts = await get('/api/stats/timeseries?minutes=30');
  assert.ok(ts.body.points.length > 10);
  const sv = await get('/api/stats/services?minutes=30');
  assert.equal(sv.body.services.length, 4);
  assert.ok(sv.body.services.every((s) => s.health === 'healthy'), JSON.stringify(sv.body.services));

  assert.deepEqual(await runDetection(), []);
});

test('payment-slow incident: detector raises CRITICAL for payment', async () => {
  await reset();
  await load(generate({ now: Date.now(), minutes: 60, flowsPerMin: 20, incidentMinutes: 6, anomalies: false }));
  const found = await runDetection();
  const pay = found.find((a) => a.service_name === 'payment' && a.metric === 'p99_latency');
  assert.ok(pay, 'payment p99 anomaly expected, got ' + JSON.stringify(found.map((a) => a.id)));
  assert.equal(pay.severity, 'CRITICAL');
  assert.ok(pay.ratio >= 5);
  assert.ok(pay.details.related_trace_ids.length > 0);
  const stored = await db.query("SELECT count(*) AS n FROM anomalies WHERE service_name = 'payment'");
  assert.ok(stored[0].n >= 1);
  assert.deepEqual((await runDetection()).filter((a) => a.service_name === 'payment' && a.metric === 'p99_latency'), [], 'cooldown');
  const sv = await get('/api/stats/services?minutes=3');
  assert.equal(sv.body.services.find((s) => s.service === 'payment').health, 'failing');
});
