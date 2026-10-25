// Run: node --test frontend/src/lib/logQuery.test.js
import test from 'node:test';
import assert from 'node:assert';
import { isTagActive, parseQuery, setToken, tagToken, toggleTag, toggleToken, tokenAt, tokenize, toLiveFilter, toParams } from './logQuery.js';

test('tokenize keeps quotes and /regex/ literals together, also after a key', () => {
  assert.deepStrictEqual(tokenize('service:payment "card declined" /a b+/ user.id:"x y" order:/o- [0-9]+/ tail'),
    ['service:payment', '"card declined"', '/a b+/', 'user.id:"x y"', 'order:/o- [0-9]+/', 'tail']);
  assert.deepStrictEqual(tokenize('/unfinished foo'), ['/unfinished', 'foo'], 'no closing slash yet = plain words');
  assert.deepStrictEqual(tokenize('  '), []);
});

test('fields, tags and free text', () => {
  const f = parseQuery('svc:payment severity:WARN,ERROR trace:abc user.id:user-38 -sku:sku-9 qty:* order.id:/^o-1/ timeout "card declined"');
  assert.strictEqual(f.service, 'payment');
  assert.strictEqual(f.level, 'WARN,ERROR');
  assert.strictEqual(f.traceId, 'abc');
  assert.strictEqual(f.q, 'timeout card declined');
  assert.strictEqual(f.regex, false);
  assert.deepStrictEqual(f.tags, [
    { key: 'user.id', op: 'eq', value: 'user-38' },
    { key: 'sku', op: 'ne', value: 'sku-9' },
    { key: 'qty', op: 'has', value: '' },
    { key: 'order.id', op: 're', value: '^o-1' },
  ]);
});

test('regex: a /literal/ or the regex button turns the free text into a regular expression', () => {
  const lit = parseQuery('level:ERROR /card (declined|refused)/');
  assert.deepStrictEqual([lit.q, lit.regex, lit.level], ['card (declined|refused)', true, 'ERROR']);
  const btn = parseQuery('time(out|d out) 5\\d\\d', { regexMode: true });
  assert.deepStrictEqual([btn.q, btn.regex], ['time(out|d out) 5\\d\\d', true]);
  assert.strictEqual(parseQuery('', { regexMode: true }).regex, false, 'nothing to match, nothing to flag');
  const two = parseQuery('/a+/ word');
  assert.deepStrictEqual([two.q, two.ignored], ['a+', ['word']]);
  assert.strictEqual(parseQuery('http://x').tags[0].key, 'http', 'colon in a word is a tag: quote it to search for it');
  assert.strictEqual(parseQuery('"http://x"').q, 'http://x');
});

test('toParams sends only what the API understands', () => {
  const f = parseQuery('service:cart /x+/ sku:sku-1');
  const p = new URLSearchParams(toParams(f, { from: 1, to: 2 }));
  assert.strictEqual(p.get('service'), 'cart');
  assert.strictEqual(p.get('q'), 'x+');
  assert.strictEqual(p.get('regex'), '1');
  assert.deepStrictEqual(JSON.parse(p.get('tags')), [{ key: 'sku', op: 'eq', value: 'sku-1' }]);
  assert.strictEqual(p.get('ignored'), null);
  assert.strictEqual(new URLSearchParams(toParams(parseQuery('plain'))).has('regex'), false);
  assert.deepStrictEqual(Object.keys(toLiveFilter(f)).sort(), ['level', 'q', 'regex', 'service', 'spanId', 'tags', 'traceId']);
});

test('editing the text: set/toggle fields and tags', () => {
  assert.strictEqual(setToken('service:cart level:ERROR', 'service', 'payment'), 'level:ERROR service:payment');
  assert.strictEqual(setToken('service:cart x', 'service', ''), 'x');
  assert.strictEqual(toggleToken('service:cart', 'service', 'cart'), '');
  const tag = { key: 'user.id', op: 'eq', value: 'user 38' };
  assert.strictEqual(tagToken(tag), 'user.id:"user 38"');
  const added = toggleTag('timeout', tag);
  assert.strictEqual(added, 'timeout user.id:"user 38"');
  assert.ok(isTagActive(added, tag));
  assert.strictEqual(toggleTag(added, tag), 'timeout', 'second click removes it');
  assert.strictEqual(toggleTag('sku:a', { key: 'sku', op: 'ne', value: 'a' }), '-sku:a', '= and != on the same value replace each other');
  assert.strictEqual(tagToken({ key: 'k', op: 'has', value: '' }), 'k:*');
  assert.strictEqual(tagToken({ key: 'k', op: 're', value: 'a|b' }), 'k:/a|b/');
});

test('tokenAt finds the word under the caret', () => {
  assert.deepStrictEqual(tokenAt('level:ERROR us', 14), { start: 12, end: 14, text: 'us' });
  assert.deepStrictEqual(tokenAt('abc def', 2), { start: 0, end: 3, text: 'abc' });
});
