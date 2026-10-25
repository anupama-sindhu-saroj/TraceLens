const test = require('node:test');
const assert = require('node:assert');
const db = require('../src/db');

test.before(() => db.init(':memory:'));
test.after(() => db.close());

test('bulk insert + query, BigInt safe for JSON', async () => {
  const now = Date.now();
  await db.insertSpans([
    { trace_id: 't1', span_id: 's1', service_name: 'gateway', name: 'POST /api/checkout', kind: 'SERVER', start_time_ms: now, duration_ms: 20, status_code: 'OK', http_status: 200, attributes: { 'user.id': 'u1' } },
    { trace_id: 't1', span_id: 's2', parent_span_id: 's1', service_name: 'payment', name: 'charge', start_time_ms: now, duration_ms: 1800, status_code: 'ERROR', http_status: 500 },
  ]);
  const rows = await db.query('SELECT service_name, count(*) AS n, sum(duration_ms)::HUGEINT AS total FROM spans GROUP BY 1 ORDER BY 1');
  assert.doesNotThrow(() => JSON.stringify(rows));
  assert.strictEqual(typeof rows[0].n, 'number');
  assert.strictEqual(typeof rows[0].total, 'number');
  const [r] = await db.query("SELECT json_extract_string(attributes, '$.\"user.id\"') AS u FROM spans WHERE span_id = ?", ['s1']);
  assert.strictEqual(r.u, 'u1');
});

test('logs and anomalies insert', async () => {
  assert.strictEqual(await db.insertLogs([{ time_ms: 1, service_name: 'payment', level: 'ERROR', message: 'boom', trace_id: 't1', span_id: 's2' }]), 1);
  assert.strictEqual(await db.insertAnomalies([{ id: 'a1', detected_at_ms: 1, service_name: 'payment', metric: 'p99_latency', baseline: 200, current: 1800, ratio: 9, severity: 'CRITICAL' }]), 1);
  const [a] = await db.query('SELECT * FROM anomalies');
  assert.strictEqual(a.root_cause, null);
});

test('concurrent writes and reads do not collide', async () => {
  const mk = (i) => ({ trace_id: `c${i}`, span_id: 'x', service_name: 'cart', name: 'n', start_time_ms: i, duration_ms: 1 });
  await Promise.all([
    ...Array.from({ length: 20 }, (_, i) => db.insertSpans([mk(i)])),
    ...Array.from({ length: 20 }, () => db.query('SELECT count(*) AS n FROM spans')),
  ]);
  const [{ n }] = await db.query("SELECT count(*) AS n FROM spans WHERE trace_id LIKE 'c%'");
  assert.strictEqual(n, 20);
});

test('missing service_name is rejected and later writes still work', async () => {
  await assert.rejects(db.insertSpans([{ trace_id: 'bad', span_id: 'b', name: 'n', start_time_ms: 1, duration_ms: 1 }]));
  assert.strictEqual(await db.insertSpans([{ trace_id: 'ok', span_id: 'o', service_name: 'cart', name: 'n', start_time_ms: 1, duration_ms: 1 }]), 1);
});
