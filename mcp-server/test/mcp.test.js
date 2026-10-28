'use strict';
// Protocol-level tests with a fake REST API: what the tools ask the API for, and how failures are reported.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { connect } = require('./helpers');

const calls = [];
let routes = {};
let fake; let base; let mcp;

test.before(async () => {
  fake = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    calls.push({ path: u.pathname, q: Object.fromEntries(u.searchParams) });
    const hit = routes[u.pathname];
    const out = typeof hit === 'function' ? hit(u) : hit;
    if (!out) { res.writeHead(404, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ error: 'not found' })); }
    res.writeHead(out.status ?? 200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(out.body));
  }).listen(0);
  base = `http://localhost:${fake.address().port}`;
  mcp = await connect(base);
});
test.after(async () => { await mcp.close(); fake.close(); });
test.beforeEach(() => { calls.length = 0; routes = {}; });

test('lists the seven tools, all read-only, plus the investigation prompt', async () => {
  const { tools } = await mcp.client.listTools();
  assert.deepEqual(tools.map((t) => t.name).sort(), [
    'explain_anomaly', 'get_service_health', 'get_topology', 'get_trace', 'list_anomalies', 'search_logs', 'search_traces',
  ]);
  for (const t of tools) {
    assert.equal(t.annotations.readOnlyHint, true, t.name);
    assert.ok(t.description.length > 40, `${t.name} needs a real description`);
    assert.equal(t.inputSchema.type, 'object');
  }
  const { prompts } = await mcp.client.listPrompts();
  assert.deepEqual(prompts.map((p) => p.name), ['investigate_incident']);
  const p = await mcp.client.getPrompt({ name: 'investigate_incident', arguments: { service: 'payment' } });
  assert.match(p.messages[0].content.text, /starting with the payment service/);
});

test('search_logs sends the right query: regex, levels, tags, window, order', async () => {
  routes['/api/logs'] = { body: { logs: [], count: 0, hasMore: false } };
  const r = await mcp.call('search_logs', {
    query: 'time.*out', regex: true, service: 'payment', level: ['WARN', 'ERROR'],
    tags: [{ key: 'user.id', op: 'eq', value: 'user-38' }, { key: 'sku', op: 'has' }], minutes: 5, limit: 7, order: 'asc',
  });
  assert.equal(r.isError, false);
  assert.match(r.text, /No logs matched in the last 5 minutes/);
  const q = calls[0].q;
  assert.equal(q.q, 'time.*out');
  assert.equal(q.regex, '1');
  assert.equal(q.service, 'payment');
  assert.equal(q.level, 'WARN,ERROR');
  assert.equal(q.limit, '7');
  assert.equal(q.order, 'asc');
  assert.deepEqual(JSON.parse(q.tags), [{ key: 'user.id', op: 'eq', value: 'user-38' }, { key: 'sku', op: 'has' }]);
  const age = Date.now() - Number(q.from);
  assert.ok(age >= 5 * 60_000 - 2000 && age <= 5 * 60_000 + 5000, 'from is "5 minutes ago"');
  assert.equal(q.to, undefined);
});

test('search_logs by trace id is not hidden behind the default time window', async () => {
  routes['/api/logs'] = { body: { logs: [], count: 0, hasMore: false } };
  await mcp.call('search_logs', { trace_id: 'abcdef0123456789' });
  assert.equal(calls[0].q.traceId, 'abcdef0123456789');
  assert.equal(calls[0].q.from, undefined);
});

test('explicit ISO from/to override minutes', async () => {
  routes['/api/anomalies'] = { body: { anomalies: [], count: 0 } };
  await mcp.call('list_anomalies', { from: '2026-10-23T11:00:00Z', to: '2026-10-23T12:00:00Z', minutes: 5, service: 'payment', severity: 'CRITICAL', metric: 'error_rate' });
  const q = calls[0].q;
  assert.equal(q.from, String(Date.parse('2026-10-23T11:00:00Z')));
  assert.equal(q.to, String(Date.parse('2026-10-23T12:00:00Z')));
  assert.equal(q.service, 'payment');
  assert.equal(q.severity, 'CRITICAL');
  assert.equal(q.metric, 'error_rate');
});

test('search_traces maps sort/status/min duration to the REST names', async () => {
  routes['/api/traces'] = { body: { total: 0, traces: [] } };
  await mcp.call('search_traces', { sort: 'slowest', status: 'error', min_duration_ms: 500, query: 'checkout', service: 'cart' });
  const q = calls[0].q;
  assert.equal(q.sort, 'duration');
  assert.equal(q.status, 'error');
  assert.equal(q.minDurationMs, '500');
  assert.equal(q.q, 'checkout');
  assert.equal(q.service, 'cart');
});

test('get_trace fetches the trace and its logs, and can skip the logs', async () => {
  routes['/api/traces/abcdef0123456789'] = { body: { traceId: 'abcdef0123456789', startMs: Date.now(), durationMs: 5, spanCount: 1, errorSpans: 0, logCount: 0, services: ['gateway'], spans: [
    { spanId: 's1', parentSpanId: null, missingParent: false, serviceName: 'gateway', name: 'GET /', kind: 'SERVER', startMs: Date.now(), offsetMs: 0, durationMs: 5, statusCode: 'UNSET', httpStatus: 200, attributes: {} }] } };
  routes['/api/logs'] = { body: { logs: [], count: 0, hasMore: false } };
  const a = await mcp.call('get_trace', { trace_id: 'abcdef0123456789' });
  assert.equal(a.isError, false);
  assert.match(a.text, /Logs for this trace: none stored/);
  assert.deepEqual(calls.map((c) => c.path).sort(), ['/api/logs', '/api/traces/abcdef0123456789']);
  calls.length = 0;
  const b = await mcp.call('get_trace', { trace_id: 'abcdef0123456789', include_logs: false });
  assert.doesNotMatch(b.text, /Logs for this trace/);
  assert.deepEqual(calls.map((c) => c.path), ['/api/traces/abcdef0123456789']);
});

test('get_service_health still answers when the anomalies call fails; unknown service is explained', async () => {
  routes['/api/stats/services'] = { body: { windowMinutes: 15, services: [
    { service: 'payment', requests: 100, errors: 20, errorRate: 0.2, avgLatencyMs: 900, p99LatencyMs: 1800, lastSeenMs: Date.now(), health: 'failing' },
    { service: 'cart', requests: 100, errors: 0, errorRate: 0, avgLatencyMs: 20, p99LatencyMs: 40, lastSeenMs: Date.now(), health: 'healthy' },
  ] } };
  // /api/anomalies is not routed -> the fake answers 404
  const r = await mcp.call('get_service_health', {});
  assert.equal(r.isError, false);
  assert.match(r.text, /payment {2,}FAILING/);
  assert.ok(r.text.indexOf('payment') < r.text.indexOf('cart'), 'unhealthy first');
  assert.match(r.text, /Needs attention: payment \(failing\)/);

  const none = await mcp.call('get_service_health', { service: 'nope' });
  assert.equal(none.isError, false);
  assert.match(none.text, /No traffic for "nope".*payment, cart|No traffic for "nope".*cart, payment/);
});

test('empty results explain themselves', async () => {
  routes['/api/anomalies'] = { body: { anomalies: [], count: 0 } };
  routes['/api/topology'] = { body: { nodes: [], edges: [] } };
  routes['/api/stats/services'] = { body: { services: [] } };
  assert.match((await mcp.call('list_anomalies', {})).text, /No anomalies in the last 60 minutes.*1 to 2 minutes/);
  assert.match((await mcp.call('get_topology', {})).text, /No services have reported traffic/);
  assert.match((await mcp.call('get_service_health', {})).text, /No service reported any requests/);
});

test('API errors become readable tool errors, not crashes', async () => {
  routes['/api/logs'] = { status: 400, body: { error: 'invalid regular expression: missing )' } };
  const bad = await mcp.call('search_logs', { query: '(', regex: true });
  assert.equal(bad.isError, true);
  assert.match(bad.text, /invalid regular expression: missing \)/);

  const missing = await mcp.call('get_trace', { trace_id: 'ffffffffffffffff' });
  assert.equal(missing.isError, true);
  assert.match(missing.text, /^Not found: /);

  routes['/api/topology'] = { status: 500, body: { error: 'db exploded' } };
  const boom = await mcp.call('get_topology', {});
  assert.equal(boom.isError, true);
  assert.match(boom.text, /db exploded/);
});

test('bad arguments are rejected with a clear message', async () => {
  const t = await mcp.call('search_logs', { from: 'not a time' }).catch((e) => ({ isError: true, text: String(e.message) }));
  assert.equal(t.isError, true);
  assert.match(t.text, /ISO 8601/);

  const range = await mcp.call('list_anomalies', { from: '2026-10-23T12:00:00Z', to: '2026-10-23T11:00:00Z' });
  assert.equal(range.isError, true);
  assert.match(range.text, /to must be after from/);

  const schema = await mcp.call('search_logs', { minutes: 0 }).catch((e) => ({ isError: true, text: String(e.message) }));
  assert.equal(schema.isError, true);
});

test('a backend that is down gives an actionable message', async () => {
  const dead = await connect('http://localhost:1');
  try {
    const r = await dead.call('get_service_health', {});
    assert.equal(r.isError, true);
    assert.match(r.text, /Cannot reach the observability API at http:\/\/localhost:1/);
    assert.match(r.text, /npm run server/);
  } finally { await dead.close(); }
});

test('server identity and instructions', async () => {
  const v = mcp.client.getServerVersion();
  assert.equal(v.name, 'tracelens');
  assert.match(mcp.client.getInstructions(), /structured JSON/);
});

test('every successful tool answer carries structured JSON that matches its outputSchema', async () => {
  const now = Date.now();
  routes['/api/stats/services'] = { body: { services: [
    { service: 'payment', requests: 100, errors: 20, errorRate: 0.2, avgLatencyMs: 900, p99LatencyMs: 1800, lastSeenMs: now, health: 'failing' }] } };
  routes['/api/anomalies'] = { body: { anomalies: [
    { id: 'a1', detected_at_ms: now, service_name: 'payment', metric: 'p99_latency', baseline: 250, current: 1800, ratio: 7.2, severity: 'CRITICAL', root_cause: 'payment',
      details: { bad_spans: 5, spans_in_window: 90, related_trace_ids: ['t1'] } }] } };
  routes['/api/anomalies/a1'] = { body: { id: 'a1', detected_at_ms: now, service_name: 'gateway', metric: 'p99_latency', baseline: 300, current: 1800, ratio: 6, severity: 'WARNING', root_cause: 'payment', details: {} } };
  routes['/api/anomalies/a1/explain'] = { body: { rootCause: 'payment', method: 'self-time', tracesAnalyzed: 1, votes: { payment: 1 }, evidence: {}, summary: 'payment did the slow work',
    correlation: { summary: 'The latency spike and an error cluster belong together.', latencyWithErrors: true,
      slowOperations: [{ service: 'payment', operation: 'POST /charge', kind: 'SERVER', baselineP99Ms: 80, currentP99Ms: 2400, ratio: 30, spans: 40, errors: 9, errorRate: 0.225, inRootCause: true }],
      relatedAnomalies: [{ id: 'a2', service: 'payment', metric: 'error_rate', severity: 'CRITICAL', ratio: 14, rootCause: 'payment', detectedAtMs: now + 30000, offsetSec: 30, relation: 'same-cause' }] },
    samples: [{ traceId: 't1', service: 'payment', spanId: 's1', spanName: 'POST /charge', spanDurationMs: 1700, selfMs: 1500, traceDurationMs: 1900 }] } };
  routes['/api/traces'] = { body: { total: 1, traces: [{ traceId: 't1', startMs: now, durationMs: 1900, rootName: 'POST /api/checkout', rootService: 'gateway', httpStatus: 200, spanCount: 2, errorSpans: 0, services: ['gateway', 'payment'] }] } };
  routes['/api/traces/t1xxxxxxxx'] = { body: { traceId: 't1xxxxxxxx', startMs: now, durationMs: 1900, spanCount: 2, errorSpans: 0, logCount: 1, services: ['gateway', 'payment'], spans: [
    { spanId: 'g', parentSpanId: null, missingParent: false, serviceName: 'gateway', name: 'POST /api/checkout', kind: 'SERVER', startMs: now, offsetMs: 0, durationMs: 1900, statusCode: 'UNSET', httpStatus: 200, attributes: {} },
    { spanId: 'p', parentSpanId: 'g', missingParent: false, serviceName: 'payment', name: 'POST /charge', kind: 'SERVER', startMs: now + 10, offsetMs: 10, durationMs: 1700, statusCode: 'UNSET', httpStatus: 200, attributes: { 'fault.injected': true } }] } };
  routes['/api/logs'] = { body: { logs: [{ time_ms: now, service_name: 'payment', level: 'ERROR', message: 'boom', trace_id: 't1xxxxxxxx', span_id: null, attributes: { 'user.id': 'u1' } }], count: 1, hasMore: false } };
  routes['/api/topology'] = { body: { nodes: [{ service: 'payment', health: 'failing', entry: false, requests: 100, rps: 1, errors: 20, errorRate: 0.2, avgMs: 900, p50Ms: 800, p95Ms: 1700, p99Ms: 1800, lastSeenMs: now }],
    edges: [{ source: 'gateway', target: 'payment', health: 'failing', calls: 100, rps: 1, errors: 20, errorRate: 0.2, avgMs: 900, p50Ms: 800, p95Ms: 1700, p99Ms: 1800 }] } };

  const calls2 = [
    ['get_service_health', {}], ['list_anomalies', {}], ['explain_anomaly', { anomaly_id: 'a1' }], ['search_traces', {}],
    ['get_trace', { trace_id: 't1xxxxxxxx' }], ['search_logs', {}], ['get_topology', {}],
  ];
  for (const [name, args] of calls2) {
    const r = await mcp.call(name, args);
    assert.equal(r.isError, false, `${name}: ${r.text}`);
    assert.ok(r.data && typeof r.data === 'object', `${name} has structuredContent`);
  }
  const health = (await mcp.call('get_service_health', {})).data;
  assert.equal(health.services[0].service, 'payment');
  assert.deepEqual(health.needsAttention, [{ service: 'payment', health: 'failing' }]);
  assert.equal(health.anomalies[0].rootCause, 'payment');
  const ex = (await mcp.call('explain_anomaly', { anomaly_id: 'a1' })).data;
  assert.equal(ex.rootCause, 'payment');
  assert.deepEqual(ex.votes, { payment: 1 });
  assert.equal(ex.correlation.latencyWithErrors, true);
  assert.equal(ex.correlation.slowOperations[0].ratio, 30);
  assert.equal(ex.correlation.relatedAnomalies[0].relation, 'same-cause');
  const exText = (await mcp.call('explain_anomaly', { anomaly_id: 'a1' })).text;
  assert.match(exText, /Correlation: The latency spike and an error cluster belong together/);
  assert.match(exText, /payment POST \/charge \[SERVER\]: p99 80 ms -> 2\.4 s \(30x\), 40 spans, 9 failed {2}<-- root-cause service/);
  assert.match(exText, /a2: payment error_rate \[CRITICAL\].*30 s later - same root cause/);
  const trace = (await mcp.call('get_trace', { trace_id: 't1xxxxxxxx' })).data;
  assert.equal(trace.bottleneck.service, 'payment');
  assert.equal(trace.spans.find((s) => s.spanId === 'p').ownMs, 1700);
  assert.equal(trace.logs[0].attributes['user.id'], 'u1');
  const topo = (await mcp.call('get_topology', {})).data;
  assert.deepEqual(topo.unhealthy, [{ service: 'payment', health: 'failing', affectedCallers: ['gateway'] }]);
});

test('resources: three fixed documents and a trace template, readable as text', async () => {
  const { resources } = await mcp.client.listResources();
  assert.deepEqual(resources.map((r) => r.uri).sort(), ['tracelens://anomalies', 'tracelens://health', 'tracelens://topology']);
  const { resourceTemplates } = await mcp.client.listResourceTemplates();
  assert.deepEqual(resourceTemplates.map((t) => t.uriTemplate), ['tracelens://trace/{traceId}']);

  routes['/api/stats/services'] = { body: { services: [
    { service: 'cart', requests: 10, errors: 0, errorRate: 0, avgLatencyMs: 20, p99LatencyMs: 40, lastSeenMs: Date.now(), health: 'healthy' }] } };
  const h = await mcp.client.readResource({ uri: 'tracelens://health' });
  assert.equal(h.contents[0].mimeType, 'text/plain');
  assert.match(h.contents[0].text, /cart {2,}HEALTHY/);

  routes['/api/traces/abcdef0123456789'] = { body: { traceId: 'abcdef0123456789', startMs: Date.now(), durationMs: 5, spanCount: 1, errorSpans: 0, logCount: 0, services: ['gateway'], spans: [
    { spanId: 's1', parentSpanId: null, missingParent: false, serviceName: 'gateway', name: 'GET /', kind: 'SERVER', startMs: Date.now(), offsetMs: 0, durationMs: 5, statusCode: 'UNSET', httpStatus: 200, attributes: {} }] } };
  routes['/api/logs'] = { body: { logs: [], count: 0, hasMore: false } };
  const t = await mcp.client.readResource({ uri: 'tracelens://trace/abcdef0123456789' });
  assert.match(t.contents[0].text, /^Trace abcdef0123456789/);
});