// Run: node --test frontend/src/lib/incidents.test.js
import test from 'node:test';
import assert from 'node:assert';
import { GAP_MS, groupIncidents, logsLink, topologyLink, topologyRange } from './incidents.js';

const MIN = 60_000;
const alarm = (id, service, metric, at, o = {}) => ({
  id, service_name: service, metric, detected_at_ms: at, severity: 'WARNING', root_cause: 'payment',
  details: { window: { from_ms: at - 2 * MIN, to_ms: at }, related_trace_ids: [`t-${id}`] }, ...o,
});

test('alarms with the same root cause, close in time, become one incident', () => {
  const t0 = 1_000_000_000;
  const inc = groupIncidents([
    alarm('c', 'gateway', 'p99_latency', t0 + 3 * MIN),
    alarm('a', 'payment', 'p99_latency', t0, { severity: 'CRITICAL' }),
    alarm('b', 'payment', 'error_rate', t0 + MIN),
  ]);
  assert.strictEqual(inc.length, 1);
  const i = inc[0];
  assert.deepStrictEqual([i.rootCause, i.severity, i.alarms.length], ['payment', 'CRITICAL', 3]);
  assert.deepStrictEqual(i.alarms.map((a) => a.id), ['a', 'b', 'c'], 'alarms in time order');
  assert.deepStrictEqual(i.affected, ['gateway'], 'the root cause is not an "affected" service');
  assert.strictEqual(i.primary.id, 'a', 'primary alarm = the one raised on the root-cause service');
  assert.deepStrictEqual(i.traceIds, ['t-a', 't-b', 't-c']);
  assert.deepStrictEqual([i.startMs, i.endMs], [t0, t0 + 3 * MIN]);
});

test('a long quiet gap, or a different root cause, starts a new incident; newest first', () => {
  const t0 = 5_000_000_000;
  const inc = groupIncidents([
    alarm('1', 'payment', 'p99_latency', t0),
    alarm('2', 'payment', 'p99_latency', t0 + GAP_MS + MIN),
    alarm('3', 'inventory', 'error_rate', t0 + 2 * MIN, { root_cause: 'inventory' }),
  ]);
  assert.strictEqual(inc.length, 3);
  assert.deepStrictEqual(inc.map((i) => i.rootCause), ['payment', 'inventory', 'payment']);
  assert.ok(inc[0].endMs > inc[1].endMs && inc[1].endMs > inc[2].endMs);
});

test('missing root cause falls back to the alarm service; missing details do not crash', () => {
  const inc = groupIncidents([{ id: 'x', service_name: 'cart', metric: 'error_rate', detected_at_ms: 10_000, severity: 'WARNING', root_cause: null }]);
  assert.strictEqual(inc[0].rootCause, 'cart');
  assert.deepStrictEqual(inc[0].traceIds, []);
  assert.deepStrictEqual(inc[0].window, { from: 10_000, to: 10_000 });
  assert.deepStrictEqual(groupIncidents([]), []);
});

test('trace ids are de-duplicated and capped', () => {
  const many = Array.from({ length: 5 }, (_, i) => alarm(`m${i}`, 'payment', 'p99_latency', 1000 + i, { details: { related_trace_ids: ['same', `u${i}`, `v${i}`] } }));
  const [i] = groupIncidents(many);
  assert.strictEqual(i.traceIds.length, 6);
  assert.strictEqual(new Set(i.traceIds).size, 6);
});

test('links carry the service and the time window', () => {
  const [i] = groupIncidents([alarm('a', 'payment', 'p99_latency', 10 * MIN)]);
  const url = new URL(logsLink(i), 'http://x');
  assert.strictEqual(url.searchParams.get('q'), 'service:payment level:WARN,ERROR');
  assert.ok(Number(url.searchParams.get('from')) < i.window.from && Number(url.searchParams.get('to')) > i.window.to);
  assert.match(topologyLink(i, 10 * MIN + 30_000), /^\/topology\?range=2m&select=node%3Apayment$/);
  assert.deepStrictEqual([0.5, 1.5, 4, 14, 50, 300, 4000].map((m) => topologyRange(m * MIN)), ['1m', '2m', '5m', '15m', '1h', '6h', '24h']);
});
