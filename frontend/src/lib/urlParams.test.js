// Run: node --test frontend/src/lib/urlParams.test.js
import test from 'node:test';
import assert from 'node:assert';
import { withParam } from './urlParams.js';

// Simulates a click handler that calls several URL setters in a row, the way the real hook does:
// every setter starts from the URL as it is RIGHT NOW (the previous setter's result).
const run = (start, steps) => steps.reduce((url, [k, v, d]) => `?${withParam(url, k, v, d)}`, start);

test('turning Live tail on keeps live=1 even though it also clears from/to (the Logs page toggleLive)', () => {
  const url = run('?q=level%3AERROR&from=100&to=200', [['live', '1', ''], ['from', '', ''], ['to', '', '']]);
  const p = new URLSearchParams(url);
  assert.strictEqual(p.get('live'), '1');
  assert.strictEqual(p.get('q'), 'level:ERROR');
  assert.strictEqual(p.get('from'), null);
  assert.strictEqual(p.get('to'), null);
});

test('zooming the timeline sets both from and to (and stops live)', () => {
  const url = run('?live=1&range=6h', [['from', 1000], ['to', 2000], ['live', '', '']]);
  const p = new URLSearchParams(url);
  assert.deepStrictEqual([p.get('from'), p.get('to'), p.get('live'), p.get('range')], ['1000', '2000', null, '6h']);
});

test('default value and empty value remove the key', () => {
  assert.strictEqual(withParam('?range=5m', 'range', '1h', '1h').has('range'), false);
  assert.strictEqual(withParam('?q=x', 'q', '').has('q'), false);
  assert.strictEqual(withParam('', 'q', 'a b').toString(), 'q=a+b');
});
