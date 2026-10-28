const test = require('node:test');
const assert = require('node:assert');
const { withWindow } = require('../src/api/logs');

const HOUR = 3_600_000;

test('a request with no from gets a default window instead of scanning the whole table', () => {
  const q = withWindow({});
  assert.ok(Number.isFinite(q.from));
  assert.ok(Math.abs(Date.now() - 24 * HOUR - q.from) < 5000);
});

test('an explicit from/to is left alone', () => {
  const to = Date.now();
  assert.strictEqual(withWindow({ from: String(to - HOUR), to: String(to) }).from, to - HOUR);
});

test('a window longer than the maximum is rejected with 400', () => {
  const now = Date.now();
  assert.throws(() => withWindow({ from: String(now - 30 * 24 * HOUR), to: String(now) }), (e) => e.status === 400 && /too large/.test(e.message));
});

test('looking up one trace is exempt from the window rules', () => {
  const q = { traceId: 'abc' };
  assert.strictEqual(withWindow(q), q);
});
