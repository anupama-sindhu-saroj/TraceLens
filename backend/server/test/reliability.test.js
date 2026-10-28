// Reliability behaviour: retry on failed write, all-or-nothing admission, idempotent spans, strict ids, 503 + partial success.
const test = require('node:test');
const assert = require('node:assert');
const db = require('../src/db');
const { Batcher } = require('../src/ingest/batcher');
const { parseTracesDetailed } = require('../src/ingest/otlp-parser');
const { createIngestApp } = require('../src/ingest/http');

const TID = '0af7651916cd43dd8448eb211c80319c';
const span = (spanId, extra = {}) => ({
  trace_id: TID, span_id: spanId, parent_span_id: null, service_name: 'svc', name: 'op', kind: 'SERVER',
  start_time_ms: 1000, duration_ms: 5, status_code: 'OK', http_status: null, attributes: {}, ...extra,
});
const count = async () => (await db.query('SELECT count(*) n FROM spans'))[0].n;

test.before(async () => { await db.init(':memory:'); });
test.after(async () => { await db.close(); });
test.beforeEach(async () => { await db.exec('DELETE FROM spans'); });

test('span insert is idempotent: in-batch and already-stored duplicates are skipped', async () => {
  await db.insertSpans([span('1111111111111111'), span('1111111111111111'), span('2222222222222222')]);
  assert.strictEqual(await count(), 2);
  await db.insertSpans([span('1111111111111111'), span('3333333333333333')]); // retry of an earlier batch + one new span
  assert.strictEqual(await count(), 3);
});

test('a failed write is retried, not dropped', async () => {
  const b = new Batcher({ flushIntervalMs: 10_000, retryBaseMs: 1 });
  let fail = true;
  const real = db.insertSpans;
  db.insertSpans = async (rows) => { if (fail) { fail = false; throw new Error('boom'); } return real(rows); };
  try {
    b.enqueue('spans', [span('4444444444444444')]);
    await b.flush(); // fails -> batch kept
    assert.deepStrictEqual(b.stats().queued, { spans: 1, logs: 0 });
    assert.strictEqual(b.stats().retried.spans, 1);
    await b.flush(undefined, { force: true }); // succeeds
    assert.deepStrictEqual(b.stats().spans, { written: 1, dropped: 0 });
    assert.strictEqual(await count(), 1);
  } finally { db.insertSpans = real; }
});

test('a batch that keeps failing is dropped after maxFlushRetries and reported', async () => {
  const b = new Batcher({ flushIntervalMs: 10_000, retryBaseMs: 1, maxFlushRetries: 2 });
  const real = db.insertSpans;
  db.insertSpans = async () => { throw new Error('disk gone'); };
  const errors = [];
  b.on('flush-error', (e) => errors.push(e));
  try {
    b.enqueue('spans', [span('5555555555555555')]);
    await b.stop(); // force-flushes until retries are used up
    assert.strictEqual(errors.length, 1);
    assert.deepStrictEqual(b.stats().spans, { written: 0, dropped: 1 });
  } finally { db.insertSpans = real; }
});

test('admission is all-or-nothing: an oversized request is refused whole', () => {
  const b = new Batcher({ maxQueue: 2, flushIntervalMs: 10_000 });
  assert.strictEqual(b.enqueue('spans', [span('6666666666666661'), span('6666666666666662'), span('6666666666666663')]), false);
  assert.strictEqual(b.stats().queued.spans, 0);
  assert.strictEqual(b.stats().rejectedRequests.spans, 1);
  assert.strictEqual(b.enqueue('spans', [span('6666666666666661'), span('6666666666666662')]), true);
});

test('strict ids: malformed spans are counted as rejected, valid ones kept', () => {
  const mk = (traceId, spanId, parentSpanId) => ({ traceId, spanId, parentSpanId, name: 'x' });
  const { rows, rejected } = parseTracesDetailed({ resourceSpans: [{ scopeSpans: [{ spans: [
    mk(TID, 'b7ad6b7169203331'),             // ok
    mk('abc', 'b7ad6b7169203331'),           // trace id too short
    mk(TID, 'zzzzzzzzzzzzzzzz'),             // span id not hex
    mk(TID, 'b7ad6b7169203332', 'beef'),     // bad parent id
  ] }] }] });
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rejected, 3);
});

test('HTTP: 503 + Retry-After when queue is full, partialSuccess when some spans are malformed', async () => {
  const { batcher } = require('../src/ingest/batcher');
  const server = createIngestApp().listen(0);
  const url = `http://127.0.0.1:${server.address().port}/v1/traces`;
  const post = (body) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const req = (spans) => ({ resourceSpans: [{ scopeSpans: [{ spans }] }] });
  const good = { traceId: TID, spanId: 'b7ad6b7169203331', name: 'x' };
  const saved = batcher.maxQueue;
  try {
    const partial = await post(req([good, { traceId: 'abc', spanId: '1', name: 'bad' }]));
    assert.strictEqual(partial.status, 200);
    assert.strictEqual((await partial.json()).partialSuccess.rejectedSpans, '1');

    batcher.maxQueue = 0;
    const full = await post(req([good]));
    assert.strictEqual(full.status, 503);
    assert.strictEqual(full.headers.get('retry-after'), '1');
  } finally { batcher.maxQueue = saved; server.close(); await batcher.flush(); }
});
