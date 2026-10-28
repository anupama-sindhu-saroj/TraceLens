'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const F = require('../src/format');
const { parseTime, windowOf, ToolInputError } = require('../src/tools');

const span = (o) => ({ kind: 'SERVER', statusCode: 'UNSET', httpStatus: 200, attributes: {}, missingParent: false, ...o });

test('fmtMs / fmtPct / ago', () => {
  assert.equal(F.fmtMs(0.4), '0.4 ms');
  assert.equal(F.fmtMs(42.4), '42 ms');
  assert.equal(F.fmtMs(1540), '1.5 s');
  assert.equal(F.fmtMs(12_000), '12 s');
  assert.equal(F.fmtMs(null), 'n/a');
  assert.equal(F.fmtPct(0.0123), '1.2%');
  assert.equal(F.fmtPct(0.345), '35%'.replace('35', String(Math.round(34.5))));
  assert.equal(F.ago(1000, 1000), 'just now');
  assert.equal(F.ago(0, 90_000), '2m ago');
  assert.equal(F.ago(0, 3 * 3600_000), '3h ago');
});

test('selfTimes: waiting on a child is not own time; parallel children are not double counted', () => {
  const spans = [
    span({ spanId: 'a', parentSpanId: null, startMs: 0, durationMs: 100 }),
    span({ spanId: 'b', parentSpanId: 'a', startMs: 10, durationMs: 50 }),   // 10..60
    span({ spanId: 'c', parentSpanId: 'a', startMs: 30, durationMs: 50 }),   // 30..80 overlaps b -> union 10..80 = 70
    span({ spanId: 'd', parentSpanId: 'c', startMs: 30, durationMs: 50 }),   // c waits for d the whole time
  ];
  const self = F.selfTimes(spans);
  assert.equal(self.get('a'), 30);
  assert.equal(self.get('b'), 50);
  assert.equal(self.get('c'), 0);
  assert.equal(self.get('d'), 50);
});

test('selfTimes: a child that runs past its parent is clipped', () => {
  const self = F.selfTimes([
    span({ spanId: 'a', parentSpanId: null, startMs: 0, durationMs: 100 }),
    span({ spanId: 'b', parentSpanId: 'a', startMs: 90, durationMs: 50 }),
  ]);
  assert.equal(self.get('a'), 90);
});

function sampleTrace() {
  return {
    traceId: 'abcdef0123456789', startMs: 1_700_000_000_000, durationMs: 1000, spanCount: 3, errorSpans: 1, logCount: 2,
    services: ['gateway', 'payment'],
    spans: [
      span({ spanId: 'g', parentSpanId: null, serviceName: 'gateway', name: 'POST /api/checkout', startMs: 1_700_000_000_000, offsetMs: 0, durationMs: 1000, httpStatus: 502 }),
      span({ spanId: 'gc', parentSpanId: 'g', serviceName: 'gateway', name: 'POST', kind: 'CLIENT', startMs: 1_700_000_000_010, offsetMs: 10, durationMs: 980 }),
      span({ spanId: 'p', parentSpanId: 'gc', serviceName: 'payment', name: 'POST /charge', startMs: 1_700_000_000_020, offsetMs: 20, durationMs: 960, httpStatus: 500, attributes: { 'fault.injected': true } }),
    ],
  };
}

test('renderTrace: tree, own time, error flag, bottleneck, logs', () => {
  const logs = { logs: [
    { time_ms: 1_700_000_000_100, level: 'INFO', service_name: 'gateway', message: 'checkout started', attributes: { 'user.id': 'u1' } },
    { time_ms: 1_700_000_000_900, level: 'ERROR', service_name: 'payment', message: 'payment gateway timeout', attributes: {} },
  ] };
  const out = F.renderTrace(sampleTrace(), logs, { now: 1_700_000_060_000 });
  assert.match(out, /^Trace abcdef0123456789/);
  assert.match(out, /1\.0 s total, 3 spans, services: gateway, payment, 1 error span, 2 logs/);
  assert.match(out, /\n {4}payment POST \/charge \[SERVER\].*own 960 ms.*HTTP 500.*ERROR.*<-- most own time/);
  assert.match(out, /attributes: fault\.injected=true/);
  assert.match(out, /Most own time: payment POST \/charge 960 ms/);
  assert.match(out, /ERROR payment {2}payment gateway timeout/);
  // indentation follows the call chain
  assert.match(out, /\ngateway POST \/api\/checkout/);
  assert.match(out, /\n {2}gateway POST \[CLIENT\]/);
});

test('renderTrace: truncation is announced, orphan spans are marked, no logs section when not asked', () => {
  const t = sampleTrace();
  t.spans[1].missingParent = true;
  const out = F.renderTrace(t, null, { maxSpans: 2 });
  assert.match(out, /1 more span not shown \(raise max_spans\)/);
  assert.match(out, /parent span missing/);
  assert.doesNotMatch(out, /Logs for this trace/);
});

test('renderTrace: logs are capped with errors and warnings kept first', () => {
  const logs = { logs: [
    ...Array.from({ length: 10 }, (_, i) => ({ time_ms: i, level: 'INFO', service_name: 's', message: `info ${i}`, attributes: {} })),
    { time_ms: 99, level: 'ERROR', service_name: 's', message: 'boom', attributes: {} },
  ] };
  const t = sampleTrace(); t.logCount = 11;
  const out = F.renderTrace(t, logs, { maxLogs: 3 });
  assert.match(out, /showing 3 of 11; errors and warnings first/);
  assert.match(out, /boom/);
});

test('parseTime / windowOf', () => {
  assert.equal(parseTime('2026-10-23T11:55:00Z', 'from'), Date.parse('2026-10-23T11:55:00Z'));
  assert.equal(parseTime('1761220500000', 'from'), 1761220500000);
  assert.equal(parseTime(undefined, 'from'), null);
  assert.throws(() => parseTime('yesterday-ish', 'from'), ToolInputError);
  const w = windowOf({ minutes: 5 }, 15, 1_000_000);
  assert.deepEqual([w.from, w.to], [1_000_000 - 300_000, null]);
  assert.throws(() => windowOf({ from: '2026-10-23T12:00:00Z', to: '2026-10-23T11:00:00Z' }, 15), /after/);
});

test('spanAttrs: fault and error attributes survive the clip, routine ones are dropped', () => {
  const attrs = {
    'http.request.method': 'POST', 'http.route': '/reserve', 'url.path': '/reserve', 'url.scheme': 'http', 'server.port': 3002,
    'http.response.status_code': 200, 'some.long.attribute': 'x'.repeat(500),
    'fault.injected': true, 'fault.type': 'latency', 'fault.latency_ms': 1500,
  };
  const out = F.spanAttrs(attrs, 120);
  assert.match(out, /^fault\.injected=true fault\.type=latency fault\.latency_ms=1500/);
  assert.doesNotMatch(out, /url\.scheme|server\.port|http\.request\.method/);
  assert.ok(out.length <= 120);
  assert.equal(F.spanAttrs(null), '');
});

test('renderTrace: a slow call that repeats is flagged as a group, with attributes shown once', () => {
  const base = 1_700_000_000_000;
  const spans = [span({ spanId: 'g', parentSpanId: null, serviceName: 'gateway', name: 'POST /checkout', startMs: base, offsetMs: 0, durationMs: 8000 })];
  for (let i = 0; i < 5; i += 1) {
    spans.push(span({
      spanId: `r${i}`, parentSpanId: 'g', serviceName: 'inventory', name: 'POST /reserve', startMs: base + i * 1550, offsetMs: i * 1550, durationMs: 1500,
      attributes: { 'http.route': '/reserve', 'server.port': 3002, 'fault.injected': true, 'fault.type': 'latency' },
    }));
  }
  const trace = { traceId: 'repeat0123456789ab', startMs: base, durationMs: 8000, spanCount: 6, errorSpans: 0, logCount: 0, services: ['gateway', 'inventory'], spans };
  const out = F.renderTrace(trace, null);
  // each single call is under 30% of the trace, but together they are the bottleneck
  assert.equal((out.match(/<-- most own time \(x5 in this trace\)/g) || []).length, 5);
  assert.equal((out.match(/attributes \(first of 5\): fault\.injected=true fault\.type=latency/g) || []).length, 1);
  assert.match(out, /Most own time: inventory POST \/reserve 7\.5 s \(5 spans, 1\.5 s each\)/);
});