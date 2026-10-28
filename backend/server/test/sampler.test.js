const test = require('node:test');
const assert = require('node:assert');
const db = require('../src/db');
const { Batcher } = require('../src/ingest/batcher');
const { createSampler, unitHash } = require('../src/ingest/sampler');
const { createRedactor } = require('../src/ingest/redactor');

const tid = (i) => i.toString(16).padStart(32, '0');
const span = (i, o = {}) => ({ trace_id: tid(i), span_id: `s${i}`.padEnd(16, '0'), service_name: 'cart', name: 'GET /x', start_time_ms: 1, duration_ms: 10, status_code: 'OK', http_status: 200, ...o });
const log = (i, o = {}) => ({ time_ms: 1, service_name: 'cart', level: 'INFO', message: 'hi', trace_id: tid(i), ...o });

function harness(opts) {
  const released = { spans: [], logs: [] };
  let t = 1_000_000;
  const s = createSampler({ waitMs: 5000, now: () => t, onRelease: (table, rows) => released[table].push(...rows), ...opts });
  return { s, released, advance: (ms) => { t += ms; s.sweep(); } };
}

test('sampleRate 1 is a pass-through and buffers nothing', () => {
  const { s, released } = harness({ sampleRate: 1 });
  const rows = [span(1), span(2)];
  assert.strictEqual(s.process('spans', rows), rows);
  assert.strictEqual(s.stats().waitingTraces, 0);
  assert.strictEqual(released.spans.length, 0);
});

test('an error trace is always kept, and the spans and logs it was holding come out with it', () => {
  const { s, released } = harness({ sampleRate: 0 }); // sample nothing: only "interesting" traces survive
  assert.deepStrictEqual(s.process('spans', [span(1)]), []);
  assert.deepStrictEqual(s.process('logs', [log(1)]), []);
  assert.strictEqual(s.stats().waitingTraces, 1);
  s.process('spans', [span(1, { span_id: 'e'.repeat(16), status_code: 'ERROR' })]);
  assert.strictEqual(released.spans.length, 2);
  assert.strictEqual(released.logs.length, 1);
  // later spans of the same trace are kept straight away
  assert.strictEqual(s.process('spans', [span(1, { span_id: 'f'.repeat(16) })]).length, 1);
});

test('http 5xx, a slow span and an ERROR log all make a trace interesting', () => {
  const { s, released } = harness({ sampleRate: 0, slowMs: 500 });
  s.process('spans', [span(1, { http_status: 503 })]);
  s.process('spans', [span(2, { duration_ms: 900 })]);
  s.process('logs', [log(3, { level: 'ERROR' })]);
  assert.strictEqual(released.spans.length, 2);
  assert.strictEqual(released.logs.length, 1);
  assert.strictEqual(s.stats().tracesKeptInteresting, 3);
});

test('a boring trace is dropped after the wait time when sampleRate is 0, with its logs', () => {
  const { s, released, advance } = harness({ sampleRate: 0 });
  s.process('spans', [span(1)]);
  s.process('logs', [log(1)]);
  advance(4000);
  assert.strictEqual(s.stats().waitingTraces, 1);
  advance(1500);
  assert.strictEqual(s.stats().waitingTraces, 0);
  assert.strictEqual(released.spans.length + released.logs.length, 0);
  assert.strictEqual(s.stats().spansDropped, 1);
  assert.strictEqual(s.stats().logsDropped, 1);
  // a late span of a dropped trace is dropped too
  assert.deepStrictEqual(s.process('spans', [span(1, { span_id: '9'.repeat(16) })]), []);
});

test('boring traces are kept at about sampleRate, and a trace is all-or-nothing', () => {
  const { s, released, advance } = harness({ sampleRate: 0.25 });
  const N = 4000;
  for (let i = 1; i <= N; i++) { s.process('spans', [span(i)]); s.process('logs', [log(i)]); }
  advance(6000);
  const keptTraces = new Set(released.spans.map((r) => r.trace_id));
  assert.ok(keptTraces.size > N * 0.2 && keptTraces.size < N * 0.3, `kept ${keptTraces.size} of ${N}`);
  for (const l of released.logs) assert.ok(keptTraces.has(l.trace_id), 'a kept log must belong to a kept trace');
  assert.strictEqual(released.logs.length, released.spans.length);
});

test('the decision is stable: same trace id, same answer', () => {
  assert.strictEqual(unitHash('abc'), unitHash('abc'));
  assert.ok(unitHash('abc') >= 0 && unitHash('abc') < 1);
});

test('logs without a trace id: WARN and ERROR kept, INFO sampled', () => {
  const { s } = harness({ sampleRate: 0 });
  const out = s.process('logs', [
    { time_ms: 1, service_name: 'a', level: 'INFO', message: 'x' },
    { time_ms: 1, service_name: 'a', level: 'WARN', message: 'y' },
    { time_ms: 1, service_name: 'a', level: 'ERROR', message: 'z' },
  ]);
  assert.deepStrictEqual(out.map((r) => r.level), ['WARN', 'ERROR']);
});

test('too many waiting traces: the oldest are decided early (memory stays bounded)', () => {
  const { s } = harness({ sampleRate: 0, maxTraces: 10 });
  for (let i = 1; i <= 50; i++) s.process('spans', [span(i)]);
  assert.ok(s.stats().waitingTraces <= 10);
});

test('Batcher: errors reach the database, boring traces do not, live tail still sees everything', async () => {
  await db.init(':memory:');
  const b = new Batcher({ maxBatch: 1000, flushIntervalMs: 20, sampling: { sampleRate: 0, waitMs: 30 } });
  const live = [];
  b.on('logs', (rows) => live.push(...rows));
  b.start();
  b.enqueue('spans', [span(1), span(2, { status_code: 'ERROR' })]);
  b.enqueue('logs', [log(1), log(2)]);
  await new Promise((r) => setTimeout(r, 200));
  await b.stop();
  const spans = await db.query('SELECT trace_id FROM spans');
  const logs = await db.query('SELECT trace_id FROM logs');
  assert.deepStrictEqual(spans.map((r) => r.trace_id), [tid(2)]);
  assert.deepStrictEqual(logs.map((r) => r.trace_id), [tid(2)]);
  assert.strictEqual(live.length, 2, 'live tail saw both logs');
  assert.strictEqual(b.stats().sampling.tracesDropped, 1);
  await db.close();
});

test('Batcher.stop() decides traces that are still waiting instead of losing them', async () => {
  await db.init(':memory:');
  const b = new Batcher({ sampling: { sampleRate: 1 - 1e-9, waitMs: 60_000 } }); // on, but keeps (almost) every boring trace
  b.enqueue('spans', [span(5)]);
  assert.strictEqual(b.stats().sampling.waitingTraces, 1);
  await b.stop();
  const [{ n }] = await db.query('SELECT count(*) n FROM spans');
  assert.strictEqual(n, 1);
  await db.close();
});

// ---------- redactor ----------

test('redactor masks sensitive attribute keys and leaves the rest alone', () => {
  const r = createRedactor();
  const [row] = r.redact('logs', [{
    time_ms: 1, service_name: 's', level: 'INFO', message: 'ok',
    attributes: { 'user.id': 'u1', password: 'p', 'http.request.header.authorization': 'Bearer abc', apiKey: 'k', 'cart.id': 'c9', 'llm.tokens': 42 },
  }]);
  assert.deepStrictEqual(row.attributes, {
    'user.id': 'u1', password: '***', 'http.request.header.authorization': '***', apiKey: '***', 'cart.id': 'c9', 'llm.tokens': 42,
  });
  assert.strictEqual(r.stats().redactedRows, 1);
});

test('redactor masks secrets inside log messages, but keeps order ids that only look like numbers', () => {
  const r = createRedactor();
  const [row] = r.redact('logs', [{ message: 'charge failed password=hunter2 Bearer abc.def card 4111 1111 1111 1111 order 1234567890123', attributes: null }]);
  assert.strictEqual(row.message, 'charge failed password=*** Bearer *** card *** order 1234567890123');
});

test('redactor works on spans, on JSON-string attributes, nested objects, and does not mutate its input', () => {
  const r = createRedactor();
  const input = [{ trace_id: 't', attributes: JSON.stringify({ db: { password: 'x', host: 'h' } }) }];
  const copy = JSON.stringify(input);
  const [row] = r.redact('spans', input);
  assert.deepStrictEqual(JSON.parse(row.attributes), { db: { password: '***', host: 'h' } });
  assert.strictEqual(JSON.stringify(input), copy);
});

test('redactor returns the same array when nothing needs masking, and can be turned off', () => {
  const rows = [{ message: 'fine', attributes: { 'user.id': 'u' } }];
  assert.strictEqual(createRedactor().redact('logs', rows), rows);
  const off = createRedactor({ enabled: false });
  const secret = [{ message: 'password=abc', attributes: { password: 'x' } }];
  assert.strictEqual(off.redact('logs', secret), secret);
});

test('Batcher redacts before the database and before the live tail', async () => {
  await db.init(':memory:');
  const b = new Batcher({ flushIntervalMs: 20 });
  const live = [];
  b.on('logs', (rows) => live.push(...rows));
  b.enqueue('logs', [{ time_ms: 1, service_name: 's', level: 'INFO', message: 'login', attributes: { token: 'abc', 'user.id': 'u1' } }]);
  await b.stop();
  const [row] = await db.query('SELECT attributes FROM logs');
  assert.strictEqual(JSON.parse(row.attributes).token, '***');
  assert.strictEqual(live[0].attributes.token, '***');
  await db.close();
});
