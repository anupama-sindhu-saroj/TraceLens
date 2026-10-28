'use strict';
// End to end: the REAL backend routers and the real detector-shaped seed data (in-memory DuckDB), driven through MCP.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const server = path.join(__dirname, '..', '..', 'backend', 'server');
const express = require(require.resolve('express', { paths: [server] }));
const db = require(path.join(server, 'src', 'db'));
const { generate } = require(path.join(server, 'scripts', 'seed-data'));
const api = (n) => require(path.join(server, 'src', 'api', n));
const { connect } = require('./helpers');

let http; let mcp; let sampleTrace;

test.before(async () => {
  await db.init(':memory:');
  const d = generate({ now: Date.now(), minutes: 40, flowsPerMin: 30, anomalies: true });
  for (let i = 0; i < d.spans.length; i += 5000) await db.insertSpans(d.spans.slice(i, i + 5000));
  await db.insertLogs(d.logs);
  await db.insertAnomalies(d.anomalies);
  const app = express();
  app.use('/api/traces', api('traces').tracesRouter);
  app.use('/api/stats', api('stats').statsRouter);
  app.use('/api/logs', api('logs').logsRouter);
  app.use('/api/anomalies', api('anomalies').anomaliesRouter);
  app.use('/api/topology', api('topology').topologyRouter);
  http = app.listen(0);
  mcp = await connect(`http://localhost:${http.address().port}`);
  sampleTrace = d.anomalies.find((a) => a.id === 'seed-payment-p99').details.related_trace_ids[0];
});
test.after(async () => { await mcp.close(); http.close(); await db.close(); });

test('health: the faulty service is first and flagged, healthy ones are not', async () => {
  const r = await mcp.call('get_service_health', {});
  assert.equal(r.isError, false);
  assert.match(r.text, /payment {2,}FAILING/);
  assert.match(r.text, /cart {2,}HEALTHY/);
  assert.match(r.text, /Needs attention: .*payment \(failing\)/);
  assert.match(r.text, /seed-payment-p99/, 'recent anomalies are listed next to the numbers');
  const one = await mcp.call('get_service_health', { service: 'cart' });
  assert.doesNotMatch(one.text, /payment/);
});

test('anomalies: list, then explain, then trace, then logs - the whole investigation walk', async () => {
  const list = await mcp.call('list_anomalies', { minutes: 120 });
  assert.match(list.text, /3 anomalies in the last 120 minutes \(2 critical\); root cause: payment/);
  assert.match(list.text, /seed-gateway-p99.*gateway p99_latency/);

  // the alarm was raised on the gateway, the cause is payment
  const ex = await mcp.call('explain_anomaly', { anomaly_id: 'seed-gateway-p99' });
  assert.equal(ex.isError, false);
  assert.match(ex.text, /Root cause: payment {2}\(the alarm was raised on gateway/);
  assert.match(ex.text, /Votes: payment 3\/3/);
  assert.ok(ex.text.includes(sampleTrace), 'sample trace ids are given');

  const tr = await mcp.call('get_trace', { trace_id: sampleTrace });
  assert.equal(tr.isError, false);
  assert.match(tr.text, /payment POST \/charge \[SERVER\].*<-- most own time/);
  assert.match(tr.text, /fault\.injected=true/);
  assert.match(tr.text, /Logs for this trace:/);

  const logs = await mcp.call('search_logs', { trace_id: sampleTrace });
  assert.match(logs.text, /payment succeeded|payment/);
});

test('explain_anomaly: unknown id is a clean not-found', async () => {
  const r = await mcp.call('explain_anomaly', { anomaly_id: 'no-such-anomaly' });
  assert.equal(r.isError, true);
  assert.match(r.text, /anomaly not found/);
});

test('search_traces: errors only, and slowest first', async () => {
  const errs = await mcp.call('search_traces', { status: 'error', minutes: 120, limit: 5 });
  assert.match(errs.text, /matching traces in the last 120 minutes, newest first/);
  const rows = errs.text.split('\n').filter((l) => /^[0-9a-f]{32}\s/.test(l));
  assert.ok(rows.length > 0);
  for (const row of rows) assert.doesNotMatch(row, /\s0\s+\S+$/, 'every row has at least one error span');

  const slow = await mcp.call('search_traces', { sort: 'slowest', service: 'payment', minutes: 120, limit: 3 });
  const secs = slow.text.split('\n').filter((l) => /^[0-9a-f]{32}\s/.test(l)).map((l) => l.match(/\s(\d+(?:\.\d)?) (ms|s)\s/)).map((m) => (m[2] === 's' ? m[1] * 1000 : Number(m[1])));
  assert.deepEqual(secs, [...secs].sort((a, b) => b - a), 'slowest first');
});

test('search_logs: text, regex, tags, levels and a bad pattern', async () => {
  const plain = await mcp.call('search_logs', { query: 'timeout', minutes: 120, limit: 3 });
  assert.match(plain.text, /payment gateway timeout/);

  const re = await mcp.call('search_logs', { query: '^payment (gateway )?timeout$', regex: true, minutes: 120, limit: 3 });
  assert.match(re.text, /payment gateway timeout/);

  const lv = await mcp.call('search_logs', { service: 'payment', level: ['ERROR'], minutes: 120, limit: 20 });
  assert.match(lv.text, /\d+ ERROR; newest first/);
  assert.doesNotMatch(lv.text, / INFO /);

  const any = await mcp.call('search_logs', { query: 'user-1', minutes: 120, limit: 1 });
  const user = any.text.match(/user\.id=(user-\d+)/)[1];
  const tag = await mcp.call('search_logs', { tags: [{ key: 'user.id', op: 'eq', value: user }], minutes: 120, limit: 10 });
  const ids = [...tag.text.matchAll(/user\.id=(user-\d+)/g)].map((m) => m[1]);
  assert.ok(ids.length > 0);
  assert.ok(ids.every((x) => x === user), 'only that user');

  const bad = await mcp.call('search_logs', { query: '(', regex: true });
  assert.equal(bad.isError, true);
  assert.match(bad.text, /invalid regular expression/);
});

test('topology: edges with health, and the unhealthy callee is named', async () => {
  const r = await mcp.call('get_topology', { minutes: 60 });
  assert.equal(r.isError, false);
  assert.match(r.text, /gateway \[\w+\] \(entry point\)/);
  assert.match(r.text, /gateway -> payment \[FAILING\]/);
  assert.match(r.text, /cart -> inventory/);
  assert.match(r.text, /Unhealthy: .*payment \(failing\)/);
});

test('structured output from the real backend: same facts as the text, valid against the schemas', async () => {
  const health = (await mcp.call('get_service_health', {})).data;
  const payment = health.services.find((x) => x.service === 'payment');
  assert.equal(payment.health, 'failing');
  assert.ok(payment.p99LatencyMs > 1000);
  assert.ok(health.needsAttention.some((x) => x.service === 'payment'));

  const an = (await mcp.call('list_anomalies', { minutes: 120 })).data;
  assert.equal(an.count, 3);
  assert.ok(an.anomalies.every((a) => a.rootCause === 'payment'));

  const ex = (await mcp.call('explain_anomaly', { anomaly_id: 'seed-gateway-p99' })).data;
  assert.equal(ex.service, 'gateway');
  assert.equal(ex.rootCause, 'payment');
  assert.equal(ex.method, 'self-time');
  assert.ok(ex.samples.length >= 1);

  const tr = (await mcp.call('get_trace', { trace_id: sampleTrace })).data;
  assert.equal(tr.bottleneck.service, 'payment');
  assert.ok(tr.spans.some((s) => s.service === 'payment' && s.attributes['fault.injected'] === true));
  assert.ok(tr.spans.every((s) => typeof s.ownMs === 'number'));
  assert.ok(tr.logs.length > 0);

  const topo = (await mcp.call('get_topology', { minutes: 60 })).data;
  assert.ok(topo.edges.some((e) => e.source === 'gateway' && e.target === 'payment' && e.health === 'failing'));
  assert.ok(topo.unhealthy.some((u) => u.service === 'payment' && u.affectedCallers.includes('gateway')));

  const logs = (await mcp.call('search_logs', { service: 'payment', level: ['ERROR'], minutes: 120, limit: 5 })).data;
  assert.ok(logs.count > 0 && logs.logs.every((l) => l.level === 'ERROR' && l.service === 'payment'));
  assert.equal(logs.levels.ERROR, logs.count);

  const traces = (await mcp.call('search_traces', { status: 'error', minutes: 120, limit: 3 })).data;
  assert.ok(traces.traces.length > 0 && traces.traces.every((t) => t.errorSpans > 0));
});

test('resources read from the real backend', async () => {
  const health = await mcp.client.readResource({ uri: 'tracelens://health' });
  assert.match(health.contents[0].text, /payment {2,}FAILING/);
  const an = await mcp.client.readResource({ uri: 'tracelens://anomalies' });
  assert.match(an.contents[0].text, /seed-payment-p99/);
  const trace = await mcp.client.readResource({ uri: `tracelens://trace/${sampleTrace}` });
  assert.match(trace.contents[0].text, /<-- most own time/);
});
