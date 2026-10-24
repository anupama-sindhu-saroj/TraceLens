// Tests for B's backend: logs API, anomalies API, root-cause correlation. In-memory DB + seed-data.
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const db = require('../src/db');
const { generate } = require('../scripts/seed-data');
const { logsRouter } = require('../src/api/logs');
const { anomaliesRouter } = require('../src/api/anomalies');
const { runDetection } = require('../src/anomaly/detector');
const { findRootCause, analyzeTraces, errorOrigin } = require('../src/anomaly/rootcause');

let server; let base;
const get = async (p) => { const r = await fetch(base + p); return { status: r.status, body: await r.json() }; };
const load = async (d) => {
  for (let i = 0; i < d.spans.length; i += 5000) await db.insertSpans(d.spans.slice(i, i + 5000));
  await db.insertLogs(d.logs);
  if (d.anomalies.length) await db.insertAnomalies(d.anomalies);
};
const reset = async () => { for (const t of ['spans', 'logs', 'anomalies']) await db.exec(`DELETE FROM ${t}`); };

test.before(async () => {
  await db.init(':memory:');
  const app = express();
  app.use('/api/logs', logsRouter);
  app.use('/api/anomalies', anomaliesRouter);
  server = app.listen(0);
  base = `http://localhost:${server.address().port}`;
});
test.after(async () => { server.close(); await db.close(); });

test('logs API: filters, order, limit, attributes parsed', async () => {
  await reset();
  await load(generate({ now: Date.now(), minutes: 20, flowsPerMin: 20, anomalies: true }));

  const all = await get('/api/logs?limit=50');
  assert.equal(all.status, 200);
  assert.equal(all.body.logs.length, 50);
  assert.equal(all.body.count, 50);
  const times = all.body.logs.map((l) => l.time_ms);
  assert.deepEqual(times, [...times].sort((a, b) => b - a), 'newest first');
  assert.equal(typeof all.body.logs[0].attributes, 'object');

  const asc = (await get('/api/logs?limit=20&order=asc')).body.logs.map((l) => l.time_ms);
  assert.deepEqual(asc, [...asc].sort((a, b) => a - b));

  const errs = await get('/api/logs?level=ERROR&limit=100');
  assert.ok(errs.body.logs.length > 0 && errs.body.logs.every((l) => l.level === 'ERROR'));
  const warnErr = await get('/api/logs?level=warn,error&limit=200');
  assert.ok(warnErr.body.logs.every((l) => ['WARN', 'ERROR'].includes(l.level)));

  const pay = await get('/api/logs?service=payment&limit=100');
  assert.ok(pay.body.logs.length > 0 && pay.body.logs.every((l) => l.service_name === 'payment'));

  const sample = all.body.logs.find((l) => l.trace_id && l.span_id);
  const byTrace = await get(`/api/logs?traceId=${sample.trace_id}&spanId=${sample.span_id}`);
  assert.ok(byTrace.body.logs.length >= 1);
  assert.ok(byTrace.body.logs.every((l) => l.trace_id === sample.trace_id && l.span_id === sample.span_id));

  const word = sample.message.split(' ')[0];
  const search = await get(`/api/logs?q=${encodeURIComponent(word.toUpperCase())}&limit=20`);
  assert.ok(search.body.logs.length > 0, 'case-insensitive text search');

  const none = await get(`/api/logs?from=${Date.now() + 60000}`);
  assert.equal(none.body.count, 0);
  const capped = await get('/api/logs?limit=999999');
  assert.ok(capped.body.logs.length <= 1000);
  const bad = await get('/api/logs?level=nonsense&limit=5'); // unknown level is ignored, not a crash
  assert.equal(bad.status, 200);
});

test('anomalies API: list, filter, details parsed, by id, 404', async () => {
  await reset();
  await load(generate({ now: Date.now(), minutes: 60, flowsPerMin: 10, incidentMinutes: 6, anomalies: true }));
  const list = await get('/api/anomalies?limit=10');
  assert.equal(list.status, 200);
  assert.equal(list.body.anomalies.length, 3);
  const at = list.body.anomalies.map((a) => a.detected_at_ms);
  assert.deepEqual(at, [...at].sort((a, b) => b - a));
  assert.ok(Array.isArray(list.body.anomalies[0].details.related_trace_ids));

  const crit = await get('/api/anomalies?severity=critical');
  assert.ok(crit.body.anomalies.length > 0 && crit.body.anomalies.every((a) => a.severity === 'CRITICAL'));
  const gw = await get('/api/anomalies?service=gateway');
  assert.equal(gw.body.anomalies.length, 1);
  const one = await get('/api/anomalies/seed-payment-p99');
  assert.equal(one.body.service_name, 'payment');
  assert.equal((await get('/api/anomalies/nope')).status, 404);
  assert.equal((await get(`/api/anomalies?from=${Date.now() + 60000}`)).body.count, 0);
});

test('root cause: a slow payment is blamed even when the alarm was raised on the gateway', async () => {
  await reset();
  await load(generate({ now: Date.now(), minutes: 60, flowsPerMin: 20, incidentMinutes: 6, anomalies: false }));
  const found = await runDetection();
  assert.ok(found.length > 0);
  for (const a of found.filter((x) => x.metric === 'p99_latency')) {
    assert.equal(a.root_cause, 'payment', `${a.service_name} ${a.metric} -> ${a.root_cause}`);
  }
  const gw = found.find((a) => a.service_name === 'gateway' && a.metric === 'p99_latency');
  if (gw) assert.equal(await findRootCause(gw), 'payment', 'gateway is only a victim');
  const stored = await db.query("SELECT root_cause FROM anomalies WHERE metric = 'p99_latency'");
  assert.ok(stored.every((r) => r.root_cause === 'payment'));
});

test('root cause: deepest error wins, votes decide, fallbacks', async () => {
  const sp = (id, parent, service, start, dur, http) => ({
    trace_id: 't', span_id: id, parent_span_id: parent, service_name: service, name: id, kind: 'SERVER',
    start_time_ms: start, duration_ms: dur, status_code: http >= 500 ? 'ERROR' : 'OK', http_status: http,
  });
  // gateway 502 <- cart 502 <- inventory 500 (the origin)
  const chain = [sp('a', null, 'gateway', 0, 100, 502), sp('b', 'a', 'cart', 5, 90, 502), sp('c', 'b', 'inventory', 10, 50, 500)];
  const r = analyzeTraces(new Map([['t', chain]]), 'error_rate', 'gateway');
  assert.equal(r.service, 'inventory');

  // latency: parallel children are not double counted; slow child owns the time
  const lat = [sp('a', null, 'gateway', 0, 1600, 200), sp('b', 'a', 'cart', 10, 50, 200), sp('c', 'a', 'payment', 20, 1500, 200)];
  assert.equal(analyzeTraces(new Map([['t', lat]]), 'p99_latency', 'gateway').service, 'payment');

  // 2 traces vs 1: majority wins
  const t2 = [sp('a', null, 'gateway', 0, 600, 200), sp('b', 'a', 'cart', 10, 550, 200)];
  const maj = analyzeTraces(new Map([['1', lat], ['2', lat], ['3', t2]]), 'p99_latency', 'gateway');
  assert.equal(maj.service, 'payment');
  assert.equal(maj.votes.payment, 2);

  assert.equal(analyzeTraces(new Map(), 'p99_latency', 'x'), null);
  assert.equal(await findRootCause({ service_name: 'cart', metric: 'p99_latency', details: {} }), 'cart');
  assert.equal(await findRootCause({ service_name: 'cart', metric: 'p99_latency', details: { related_trace_ids: ['missing'] } }), 'cart');
});

test('explain: says why a service was blamed, from the alarm\'s own sample traces', async () => {
  await reset();
  await load(generate({ now: Date.now(), minutes: 60, flowsPerMin: 20, incidentMinutes: 6, anomalies: false }));
  const found = await runDetection();
  const gw = found.find((a) => a.service_name === 'gateway' && a.metric === 'p99_latency');
  assert.ok(gw, 'the gateway alarm exists in this scenario');

  const r = await get(`/api/anomalies/${encodeURIComponent(gw.id)}/explain`);
  assert.equal(r.status, 200);
  assert.equal(r.body.rootCause, 'payment');
  assert.equal(r.body.storedRootCause, 'payment');
  assert.equal(r.body.method, 'self-time');
  assert.ok(r.body.tracesAnalyzed >= 1 && r.body.votes.payment === r.body.tracesAnalyzed);
  assert.match(r.body.summary, /payment spent the most time on its own work/);
  const s = r.body.samples[0];
  assert.ok(s.traceId && s.service === 'payment' && s.selfMs > 1000 && s.traceDurationMs >= s.spanDurationMs - 1, JSON.stringify(s));
  assert.equal((await get('/api/anomalies/nope/explain')).status, 404);
});

test('explainTraces: error case, empty case, summary wording', () => {
  const { explainTraces } = require('../src/anomaly/rootcause');
  const sp = (id, parent, service, start, dur, http) => ({ trace_id: 't', span_id: id, parent_span_id: parent, service_name: service, name: `${service}-op`, kind: 'SERVER', start_time_ms: start, duration_ms: dur, status_code: http >= 500 ? 'ERROR' : 'OK', http_status: http });
  const chain = [sp('a', null, 'gateway', 0, 100, 502), sp('b', 'a', 'cart', 5, 90, 502), sp('c', 'b', 'inventory', 10, 50, 500)];
  const e = explainTraces(new Map([['t', chain]]), 'error_rate', 'gateway');
  assert.deepEqual([e.rootCause, e.method, e.tracesAnalyzed], ['inventory', 'deepest-error', 1]);
  assert.match(e.summary, /1 of 1 sample failing traces, the first error came from inventory/);
  assert.equal(e.samples[0].selfMs, null);
  const none = explainTraces(new Map(), 'p99_latency', 'cart');
  assert.deepEqual([none.rootCause, none.tracesAnalyzed], ['cart', 0]);
  assert.match(none.summary, /No sample traces were stored/);
});
// Real traces (from the demo services) have a non-failing INTERNAL handler span between a failing caller and the failing callee.
// A rule that only looked at direct children blamed the gateway for every payment error.
test('root cause (errors): the failing callee is blamed even with non-failing spans in between', () => {
  const sp = (span_id, parent_span_id, service_name, name, kind, http_status, status_code, start) =>
    ({ span_id, parent_span_id, service_name, name, kind, http_status, status_code, start_time_ms: start, duration_ms: 100 });
  const trace = [
    sp('g1', null, 'gateway', 'POST /api/checkout', 'SERVER', 502, 'ERROR', 0),
    sp('g2', 'g1', 'gateway', 'request handler - /api/checkout', 'INTERNAL', null, 'UNSET', 1),
    sp('g3', 'g2', 'gateway', 'POST', 'CLIENT', 500, 'ERROR', 2),
    sp('p1', 'g3', 'payment', 'POST /charge', 'SERVER', 500, 'ERROR', 3),
    sp('p2', 'p1', 'payment', 'request handler - /charge', 'INTERNAL', null, 'UNSET', 4),
  ];
  const r = analyzeTraces(new Map([['t1', trace], ['t2', trace]]), 'error_rate', 'payment');
  assert.equal(r.service, 'payment');
  assert.deepEqual(r.votes, { payment: 2 });
  assert.equal(errorOrigin(trace).span.span_id, 'p1');

  // a call that failed without ever reaching the callee has no callee span: the caller's CLIENT span is the origin
  const noCallee = trace.slice(0, 3);
  assert.equal(errorOrigin(noCallee).span.span_id, 'g3');
  assert.equal(errorOrigin(noCallee).service, 'gateway');

  // no errors at all -> no origin
  assert.equal(errorOrigin([sp('a', null, 'cart', 'GET', 'SERVER', 200, 'UNSET', 0)]), null);
});