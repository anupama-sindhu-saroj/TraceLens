// Runs A's REAL services (start-all) + a capture sink + the demo API, then injects faults.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const express = require('express');
const { demoRouter } = require('../src/api/demo');

const GATEWAY = 'http://localhost:3000';
const spans = [];
const logs = [];
let services, sink, apiServer, api;

const attr = (o, key) => o.attributes?.find((a) => a.key === key)?.value;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const json = async (url, opts) => {
  const r = await fetch(url, opts);
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
const post = (p, body) =>
  json(`${api}${p}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const timed = async (fn) => {
  const t = Date.now();
  const r = await fn();
  return { ...r, ms: Date.now() - t };
};
const products = () => timed(() => json(`${GATEWAY}/api/products`));

before(async () => {
  // capture sink on :4318 (JSON)
  const s = express();
  s.use(express.json({ limit: '20mb' }));
  s.post('/v1/traces', (req, res) => {
    for (const rs of req.body.resourceSpans ?? []) {
      const service = attr(rs.resource, 'service.name')?.stringValue;
      for (const ss of rs.scopeSpans ?? []) for (const sp of ss.spans ?? []) spans.push({ service, ...sp });
    }
    res.json({});
  });
  s.post('/v1/logs', (req, res) => {
    for (const rl of req.body.resourceLogs ?? []) {
      const service = attr(rl.resource, 'service.name')?.stringValue;
      for (const sl of rl.scopeLogs ?? []) for (const lr of sl.logRecords ?? []) logs.push({ service, ...lr });
    }
    res.json({});
  });
  sink = s.listen(4318);

  services = spawn(process.execPath, [path.join(__dirname, '../../demo-services/src/start-all.js')], {
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  for (let i = 0; i < 50; i++) {
    const ok = await Promise.all([3000, 3001, 3002, 3003].map((p) =>
      fetch(`http://localhost:${p}/health`).then((r) => r.ok).catch(() => false)));
    if (ok.every(Boolean)) break;
    await sleep(200);
  }

  const app = express();
  app.use(express.json());
  app.use('/api/demo', demoRouter);
  apiServer = app.listen(0);
  await new Promise((r) => apiServer.once('listening', r));
  api = `http://localhost:${apiServer.address().port}/api/demo`;
});

after(async () => {
  await json(`${api}/faults`, { method: 'DELETE' });
  services.kill('SIGTERM');
  apiServer.close();
  sink.close();
  await sleep(1600);
});

test('healthy baseline: no faults, all 4 reachable', async () => {
  const { body } = await json(`${api}/faults`);
  assert.deepEqual(body.map((r) => r.service).sort(), ['cart', 'gateway', 'inventory', 'payment']);
  assert.ok(body.every((r) => r.fault === null && r.reachable));
  const r = await products();
  assert.equal(r.status, 200);
});

test('latency on payment slows checkout by ~1.5s', async () => {
  const user = 'u-fault-1';
  await json(`${GATEWAY}/api/cart/${user}/items`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sku: 'sku-001', qty: 1 }),
  });
  const checkout = () => timed(() => json(`${GATEWAY}/api/checkout`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ userId: user }),
  }));

  const injected = await post('/faults', { service: 'payment', type: 'latency', latencyMs: 1500 });
  assert.equal(injected.status, 201);
  const slow = await checkout();
  assert.ok(slow.ms >= 1500, `checkout took ${slow.ms}ms (status ${slow.status})`);

  await json(`${api}/faults/payment`, { method: 'DELETE' });
  await sleep(2500); // exporters flush every 1s
  // payment span on a faulted request carries the marker
  assert.ok(spans.some((sp) => sp.service === 'payment' && attr(sp, 'fault.injected')?.boolValue === true));
});

test('error fault: gateway sees 500, span is ERROR, log shares the trace id', async () => {
  spans.length = 0; logs.length = 0;
  await post('/faults', { service: 'inventory', type: 'error', errorRate: 1 });
  const r = await products();
  assert.equal(r.status, 502, 'gateway maps a failing downstream to 502');
  await sleep(2500); // exporters flush every 1s

  const bad = spans.find((sp) => sp.service === 'inventory' && attr(sp, 'fault.injected')?.boolValue === true);
  assert.ok(bad, 'inventory span with fault.injected not found');
  assert.equal(bad.status?.code, 2, 'span status should be ERROR (2)');

  const errLog = logs.find((l) => l.service === 'inventory' && l.severityText === 'ERROR'
    && l.body?.stringValue === 'Injected fault: request failed');
  assert.ok(errLog, 'injected ERROR log not found');
  assert.equal(errLog.traceId, bad.traceId, 'log must share the span trace id (Log to Trace Jump)');

  await json(`${api}/faults/inventory`, { method: 'DELETE' });
  assert.equal((await products()).status, 200);
});

test('durationSec auto-clears on a real service', async () => {
  await post('/faults', { service: 'inventory', type: 'error', errorRate: 1, durationSec: 1 });
  assert.equal((await products()).status, 502);
  await sleep(1300);
  assert.equal((await products()).status, 200);
});

test('clear all and validation / 400 / 404', async () => {
  await post('/faults', { service: 'payment', type: 'latency', latencyMs: 200 });
  await post('/faults', { service: 'cart', type: 'error', errorRate: 0.5 });
  assert.deepEqual((await json(`${api}/faults`, { method: 'DELETE' })).body, { ok: true, cleared: 2 });
  assert.equal((await post('/faults', { service: 'nope', type: 'latency', latencyMs: 1 })).status, 400);
  assert.equal((await post('/faults', { service: 'payment', type: 'error', errorRate: 2 })).status, 400);
  assert.equal((await json(`${api}/faults/nope`, { method: 'DELETE' })).status, 404);
});