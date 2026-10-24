// Topology API on seeded data (in-memory DB).
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const db = require('../src/db');
const { generate } = require('../scripts/seed-data');
const { topologyRouter } = require('../src/api/topology');

let server; let base;
const get = async (p) => { const r = await fetch(base + p); return { status: r.status, body: await r.json() }; };
const load = async (d) => { for (let i = 0; i < d.spans.length; i += 5000) await db.insertSpans(d.spans.slice(i, i + 5000)); await db.insertLogs(d.logs); };
const reset = async () => { for (const t of ['spans', 'logs', 'anomalies']) await db.exec(`DELETE FROM ${t}`); };
const edge = (t, s, d) => t.edges.find((e) => e.source === s && e.target === d);
const node = (t, s) => t.nodes.find((n) => n.service === s);

test.before(async () => {
  await db.init(':memory:');
  const app = express();
  app.use('/api/topology', topologyRouter);
  server = app.listen(0);
  base = `http://localhost:${server.address().port}`;
});
test.after(async () => { server.close(); await db.close(); });

test('empty database gives an empty graph', async () => {
  await reset();
  const { status, body } = await get('/api/topology');
  assert.equal(status, 200);
  assert.deepEqual([body.nodes, body.edges], [[], []]);
});

test('healthy traffic: gateway the gateway fans out and cart calls inventory, everything green', async () => {
  await reset();
  await load(generate({ now: Date.now(), minutes: 30, flowsPerMin: 30, incident: false, anomalies: false }));
  const { body: t } = await get('/api/topology?minutes=30');

  assert.deepEqual(t.nodes.map((n) => n.service), ['cart', 'gateway', 'inventory', 'payment']);
  assert.ok(t.nodes.every((n) => n.health === 'healthy' && n.requests > 0 && n.p99Ms > 0 && n.rps > 0), JSON.stringify(t.nodes.map((n) => [n.service, n.health])));
  assert.equal(node(t, 'gateway').entry, true, 'the gateway receives outside traffic');
  assert.equal(node(t, 'payment').entry, false);

  const pairs = t.edges.map((e) => `${e.source}>${e.target}`).sort();
  assert.deepEqual(pairs, ['cart>inventory', 'gateway>cart', 'gateway>inventory', 'gateway>payment']);
  for (const e of t.edges) {
    assert.ok(e.calls > 0 && e.avgMs > 0 && e.p95Ms >= e.p50Ms && e.p99Ms >= e.p95Ms, JSON.stringify(e));
    assert.equal(e.health, 'healthy');
  }
  // every call the gateway made to payment was served by payment
  assert.equal(edge(t, 'gateway', 'payment').calls, node(t, 'payment').requests);
});

test('payment incident: the payment node and its edge turn red, the others stay green', async () => {
  await reset();
  await load(generate({ now: Date.now(), minutes: 40, flowsPerMin: 30, incidentMinutes: 6, anomalies: false }));
  const { body: t } = await get('/api/topology?minutes=3');
  assert.equal(node(t, 'payment').health, 'failing');
  assert.ok(node(t, 'payment').p99Ms >= 1000);
  assert.equal(edge(t, 'gateway', 'payment').health, 'failing');
  assert.notEqual(edge(t, 'gateway', 'cart').health, 'failing');
  assert.equal(node(t, 'inventory').health, 'healthy');
});

test('the time window is respected and bad values are clamped', async () => {
  const none = (await get('/api/topology?minutes=1')).body;
  const wide = (await get('/api/topology?minutes=60')).body;
  assert.ok(wide.edges[0].calls >= none.edges[0].calls);
  assert.equal((await get('/api/topology?minutes=0')).body.windowMinutes, 1);
  assert.equal((await get('/api/topology?minutes=abc')).body.windowMinutes, 15);
  assert.equal((await get('/api/topology?minutes=99999')).body.windowMinutes, 1440);
});

test('a one-service trace creates no edge', async () => {
  await reset();
  const now = Date.now();
  await db.insertSpans([
    { trace_id: 'a'.repeat(32), span_id: '1'.repeat(16), parent_span_id: null, service_name: 'solo', name: 'GET /', kind: 'SERVER', start_time_ms: now - 1000, duration_ms: 10, status_code: 'OK', http_status: 200, attributes: {} },
    { trace_id: 'a'.repeat(32), span_id: '2'.repeat(16), parent_span_id: '1'.repeat(16), service_name: 'solo', name: 'inner', kind: 'INTERNAL', start_time_ms: now - 1000, duration_ms: 5, status_code: 'OK', http_status: null, attributes: {} },
  ]);
  const { body: t } = await get('/api/topology');
  assert.deepEqual([t.nodes.length, t.edges.length], [1, 0]);
});
