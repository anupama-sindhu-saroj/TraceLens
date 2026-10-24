// Tests for the seed generator (no DuckDB needed): npm run test:seed -w backend/server
const test = require('node:test');
const assert = require('node:assert');
const { generate, percentile } = require('../scripts/seed-data');

const NOW = 1_800_000_000_000;
const data = generate({ now: NOW, minutes: 30, flowsPerMin: 10, seed: 7 });

test('same seed gives the same data, different seed does not', () => {
  const again = generate({ now: NOW, minutes: 30, flowsPerMin: 10, seed: 7 });
  assert.deepStrictEqual(again.summary, data.summary);
  assert.strictEqual(again.spans[100].span_id, data.spans[100].span_id);
  assert.notStrictEqual(generate({ now: NOW, minutes: 30, flowsPerMin: 10, seed: 8 }).spans[100].span_id, data.spans[100].span_id);
});

test('rows are valid and match the schema contract', () => {
  for (const s of data.spans) {
    assert.match(s.trace_id, /^[0-9a-f]{32}$/);
    assert.match(s.span_id, /^[0-9a-f]{16}$/);
    assert.ok(['gateway', 'cart', 'inventory', 'payment'].includes(s.service_name));
    assert.ok(['SERVER', 'CLIENT', 'INTERNAL'].includes(s.kind));
    assert.ok(['OK', 'ERROR', 'UNSET'].includes(s.status_code));
    assert.ok(Number.isInteger(s.start_time_ms) && s.start_time_ms > 0, 'span was never finished');
    assert.ok(s.duration_ms > 0);
    assert.ok(!('_start' in s));
  }
  for (const l of data.logs) {
    assert.ok(['DEBUG', 'INFO', 'WARN', 'ERROR'].includes(l.level));
    assert.ok(Number.isInteger(l.time_ms));
    assert.ok(l.message.length > 0);
    if (l.trace_id) assert.match(l.span_id, /^[0-9a-f]{16}$/);
  }
});

test('every trace has one root (gateway SERVER) and children sit inside their parents', () => {
  const byTrace = new Map();
  for (const s of data.spans) (byTrace.get(s.trace_id) ?? byTrace.set(s.trace_id, []).get(s.trace_id)).push(s);
  for (const spans of byTrace.values()) {
    const ids = new Map(spans.map((s) => [s.span_id, s]));
    const roots = spans.filter((s) => !s.parent_span_id);
    assert.strictEqual(roots.length, 1);
    assert.strictEqual(roots[0].service_name, 'gateway');
    assert.strictEqual(roots[0].kind, 'SERVER');
    for (const s of spans) {
      if (!s.parent_span_id) continue;
      const p = ids.get(s.parent_span_id);
      assert.ok(p, 'parent span missing from trace');
      assert.ok(s.start_time_ms >= p.start_time_ms - 1.5, 'child starts before parent');
      assert.ok(s.start_time_ms + s.duration_ms <= p.start_time_ms + p.duration_ms + 1.5, `${s.service_name} ${s.name} ends after parent ${p.name}`);
    }
  }
});

test('logs point at real spans of the same trace and service', () => {
  const spanById = new Map(data.spans.map((s) => [s.span_id, s]));
  for (const l of data.logs.filter((x) => x.trace_id)) {
    const s = spanById.get(l.span_id);
    assert.ok(s, 'log refers to unknown span');
    assert.strictEqual(s.trace_id, l.trace_id);
    assert.strictEqual(s.service_name, l.service_name);
  }
});

test('payment slow incident: p99 spikes, errors cluster, ERROR logs appear', () => {
  const { incidentStart, payment } = data.summary;
  assert.strictEqual(incidentStart, NOW - 6 * 60_000);
  assert.ok(payment.baselineP99 < 400, `baseline p99 ${payment.baselineP99}`);
  assert.ok(payment.currentP99 > 1500, `incident p99 ${payment.currentP99}`);
  assert.ok(payment.currentErrorRate > 5 * payment.baselineErrorRate);
  const injected = data.spans.filter((s) => s.attributes['fault.injected']);
  assert.ok(injected.length > 0 && injected.every((s) => s.service_name === 'payment' && s.start_time_ms >= incidentStart));
  const errorLogs = data.logs.filter((l) => l.level === 'ERROR' && l.time_ms >= incidentStart);
  assert.ok(errorLogs.some((l) => l.service_name === 'payment' && l.message === 'payment gateway timeout'));
  assert.ok(errorLogs.some((l) => l.service_name === 'gateway' && l.message === 'checkout failed'));
  assert.ok(data.logs.some((l) => l.message === 'fault injected' && l.service_name === 'payment'));
});

test('anomaly rows describe the payment incident', () => {
  const [p99, err, gw] = data.anomalies;
  assert.deepStrictEqual(data.anomalies.map((a) => a.id), ['seed-payment-p99', 'seed-payment-errors', 'seed-gateway-p99']);
  assert.strictEqual(p99.severity, 'CRITICAL');
  assert.ok(p99.ratio >= 5);
  assert.strictEqual(err.metric, 'error_rate');
  assert.strictEqual(gw.severity, 'WARNING');
  for (const a of data.anomalies) {
    assert.strictEqual(a.root_cause, 'payment');
    assert.ok(a.detected_at_ms > data.summary.incidentStart && a.detected_at_ms <= NOW);
    assert.ok(a.details.related_trace_ids.length > 0);
  }
});

test('--no-incident / --no-anomalies options', () => {
  const calm = generate({ now: NOW, minutes: 30, flowsPerMin: 10, seed: 7, incident: false });
  assert.strictEqual(calm.anomalies.length, 0);
  assert.strictEqual(calm.summary.incidentStart, null);
  assert.ok(!calm.spans.some((s) => s.attributes['fault.injected']));
  const p99 = percentile(calm.spans.filter((s) => s.service_name === 'payment' && s.kind === 'SERVER').map((s) => s.duration_ms), 0.99);
  assert.ok(p99 < 400);
  assert.strictEqual(generate({ now: NOW, minutes: 30, flowsPerMin: 10, seed: 7, anomalies: false }).anomalies.length, 0);
});

test('healthy baseline looks like the demo services', () => {
  const calm = generate({ now: NOW, minutes: 60, flowsPerMin: 20, seed: 3, incident: false });
  const pay = calm.spans.filter((s) => s.service_name === 'payment' && s.kind === 'SERVER');
  const rate = (pred) => pay.filter(pred).length / pay.length;
  assert.ok(pay.length > 200);
  assert.ok(rate((s) => s.http_status >= 500) < 0.03);
  assert.ok(rate((s) => s.http_status === 402) < 0.06);
  assert.ok(calm.spans.some((s) => s.service_name === 'inventory' && s.http_status === 404), 'expected some invalid-sku 404s');
  assert.ok(calm.logs.some((l) => l.attributes['order.id'] && l.attributes['payment.id'] && l.message === 'checkout completed'));
});
