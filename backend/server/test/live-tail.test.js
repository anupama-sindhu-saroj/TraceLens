// Live Tail WebSocket + log histogram/facets. Fake batcher (an EventEmitter) so no database writes are needed for the stream.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { EventEmitter } = require('node:events');
const express = require('express');
const { WebSocket } = require('ws');
const db = require('../src/db');
const { generate } = require('../scripts/seed-data');
const { logsRouter } = require('../src/api/logs');
const { attachLiveTail, matches, normalizeFilter } = require('../src/ws/logs');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let server; let base; let port; let fake; let tail;

const row = (o = {}) => ({ time_ms: Date.now(), service_name: 'payment', level: 'INFO', message: 'hello', trace_id: null, span_id: null, attributes: {}, ...o });

async function connect(filter) {
  const ws = new WebSocket(`ws://localhost:${port}/ws/logs`);
  const frames = [];
  ws.on('message', (d) => frames.push(JSON.parse(String(d))));
  await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
  if (filter) ws.send(JSON.stringify({ type: 'filter', ...filter }));
  await sleep(60);
  return { ws, frames, rows: () => frames.filter((f) => f.type === 'logs').flatMap((f) => f.rows) };
}

test.before(async () => {
  await db.init(':memory:');
  const d = generate({ now: Date.now(), minutes: 30, flowsPerMin: 20, anomalies: false });
  await db.insertSpans(d.spans.slice(0, 1000));
  await db.insertLogs(d.logs);
  const app = express();
  app.use('/api/logs', logsRouter);
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, r));
  port = server.address().port;
  base = `http://localhost:${port}`;
  fake = new EventEmitter();
  tail = attachLiveTail(server, { batcher: fake, flushMs: 20, maxPending: 50, pingMs: 200 });
});
test.after(async () => { await tail.close(); server.close(); await db.close(); });

test('filter matching', () => {
  const f = normalizeFilter({ service: 'payment', level: 'warn,error', q: 'TIMEOUT' });
  assert.ok(matches(row({ level: 'ERROR', message: 'gateway timeout' }), f));
  assert.ok(matches(row({ level: 'WARN', attributes: { why: 'timeout' } }), f), 'q also searches attributes');
  assert.ok(!matches(row({ level: 'INFO', message: 'timeout' }), f));
  assert.ok(!matches(row({ level: 'ERROR', service_name: 'cart', message: 'timeout' }), f));
  assert.ok(matches(row(), normalizeFilter()), 'empty filter matches everything');
});

test('streams only matching rows and applies filter changes without reconnecting', async () => {
  const c = await connect({ service: 'payment', level: 'ERROR' });
  assert.equal(c.frames[0].type, 'hello');
  fake.emit('logs', [row({ level: 'ERROR', message: 'card declined' }), row({ level: 'INFO' }), row({ service_name: 'cart', level: 'ERROR' })]);
  await sleep(80);
  assert.deepEqual(c.rows().map((r) => r.message), ['card declined']);

  c.ws.send(JSON.stringify({ type: 'filter', service: 'cart' }));
  await sleep(60);
  fake.emit('logs', [row({ service_name: 'cart', message: 'cart row' }), row({ message: 'payment row' })]);
  await sleep(80);
  assert.deepEqual(c.rows().map((r) => r.message), ['card declined', 'cart row']);
  c.ws.close();
});

test('parses string attributes and shapes rows like the REST API', async () => {
  const c = await connect({});
  fake.emit('logs', [row({ attributes: '{"order.id":"o-1"}', trace_id: 'abc' })]);
  await sleep(80);
  assert.deepEqual(c.rows()[0].attributes, { 'order.id': 'o-1' });
  assert.equal(c.rows()[0].trace_id, 'abc');
  c.ws.close();
});

test('a flood is bounded: oldest rows are dropped and the client is told', async () => {
  const c = await connect({});
  fake.emit('logs', Array.from({ length: 500 }, (_, i) => row({ message: `m${i}` })));
  await sleep(120);
  const got = c.rows();
  assert.ok(got.length <= 50, `got ${got.length}`);
  assert.equal(got.at(-1).message, 'm499', 'newest kept');
  assert.ok(c.frames.some((f) => f.dropped >= 450));
  c.ws.close();
});

test('closed clients are cleaned up; garbage messages are ignored', async () => {
  const c = await connect({});
  c.ws.send('not json');
  await sleep(40);
  assert.ok(tail.clients() >= 1);
  c.ws.close();
  await sleep(100);
  assert.equal(tail.clients(), 0);
});

test('histogram: buckets cover the range, counts add up and respect filters', async () => {
  const to = Date.now();
  const from = to - 30 * 60_000;
  const all = await (await fetch(`${base}/api/logs/histogram?from=${from}&to=${to}&buckets=30`)).json();
  assert.ok(all.bucketMs >= 1000 && all.buckets.length >= 29 && all.buckets.length <= 31);
  const sum = all.buckets.reduce((a, b) => a + b.DEBUG + b.INFO + b.WARN + b.ERROR, 0);
  assert.equal(sum, all.total);
  const [{ n }] = await db.query('SELECT count(*) AS n FROM logs WHERE time_ms >= ? AND time_ms < ?', [from, to]);
  assert.equal(all.total, Number(n));

  const errs = await (await fetch(`${base}/api/logs/histogram?from=${from}&to=${to}&level=ERROR`)).json();
  assert.ok(errs.total > 0 && errs.total < all.total);
  assert.ok(errs.buckets.every((b) => b.INFO === 0 && b.WARN === 0 && b.DEBUG === 0));
  assert.equal((await fetch(`${base}/api/logs/histogram?from=10&to=5`)).status, 400);
});

test('facets: counts per service and level, each ignoring its own filter', async () => {
  const f = await (await fetch(`${base}/api/logs/facets`)).json();
  assert.ok(f.service.length >= 2 && f.level.length >= 2);
  assert.ok(f.service[0].count >= f.service.at(-1).count, 'sorted by count');
  const filtered = await (await fetch(`${base}/api/logs/facets?service=payment&level=ERROR`)).json();
  const onlyLevel = await (await fetch(`${base}/api/logs/facets?level=ERROR`)).json();
  assert.deepEqual(filtered.service, onlyLevel.service, 'service list ignores the service filter but keeps the level filter');
  const payAll = filtered.level.reduce((a, l) => a + l.count, 0); // level list ignores the level filter
  const [{ n }] = await db.query("SELECT count(*) AS n FROM logs WHERE service_name = 'payment'");
  assert.equal(payAll, Number(n), 'level counts are for payment only');
});

test('cursor paging walks every log exactly once, even with many rows on the same millisecond', async () => {
  await db.exec('DELETE FROM logs');
  const base0 = Date.now() - 60_000;
  const rows = [];
  for (let i = 0; i < 1000; i++) rows.push({ time_ms: base0 + Math.floor(i / 7) * 3, service_name: 'cart', level: 'INFO', message: `row-${i}`, attributes: {} }); // 7 rows per ms
  await db.insertLogs(rows);

  const seen = [];
  let cursor = '';
  for (let guard = 0; guard < 20; guard++) {
    const r = await (await fetch(`${base}/api/logs?limit=150${cursor}`)).json();
    seen.push(...r.logs);
    if (!r.hasMore) break;
    const last = r.logs.at(-1).time_ms;
    const skip = seen.filter((l) => l.time_ms === last).length;
    cursor = `&before=${last}&skip=${skip}`;
  }
  assert.equal(seen.length, 1000);
  assert.equal(new Set(seen.map((l) => l.message)).size, 1000, 'no duplicates, none missing');
  const times = seen.map((l) => l.time_ms);
  assert.deepEqual(times, [...times].sort((a, b) => b - a), 'stays newest first');
  const first = await (await fetch(`${base}/api/logs?limit=1000`)).json();
  assert.equal(first.hasMore, false);
});

// ---- regex search + dynamic tag filters ----
const getJson = async (path) => { const r = await fetch(base + path); return { status: r.status, body: await r.json() }; };
const tagsQs = (tags) => `tags=${encodeURIComponent(JSON.stringify(tags))}`;

test('regex search: matches message and attributes, case-insensitive, rejects bad patterns with 400', async () => {
  await db.exec('DELETE FROM logs');
  const t = Date.now() - 1000;
  await db.insertLogs([
    { time_ms: t, service_name: 'payment', level: 'ERROR', message: 'Card declined for order o-17', attributes: { 'order.id': 'o-17', sku: 'sku-001' } },
    { time_ms: t + 1, service_name: 'payment', level: 'ERROR', message: 'card refused', attributes: { 'order.id': 'o-18', sku: 'sku-002' } },
    { time_ms: t + 2, service_name: 'cart', level: 'INFO', message: 'item added', attributes: { sku: 'sku-001', qty: 2, 'user.id': 'user-5' } },
    { time_ms: t + 3, service_name: 'cart', level: 'INFO', message: 'cart cleared', attributes: {} },
  ]);
  const msgs = (r) => r.body.logs.map((l) => l.message).sort();

  assert.deepEqual(msgs(await getJson(`/api/logs?q=${encodeURIComponent('card (declined|refused)')}&regex=1`)), ['Card declined for order o-17', 'card refused']);
  assert.deepEqual(msgs(await getJson(`/api/logs?q=${encodeURIComponent('^cart')}&regex=1`)), ['cart cleared']);
  assert.deepEqual(msgs(await getJson(`/api/logs?q=${encodeURIComponent('o-1[78]')}&regex=1`)).length, 2, 'also searches the attributes');
  assert.deepEqual(msgs(await getJson(`/api/logs?q=${encodeURIComponent('(?-i)^card')}&regex=1`)), ['card refused'], '(?-i) turns case sensitivity off');
  assert.equal((await getJson(`/api/logs?q=${encodeURIComponent('^cart')}`)).body.count, 0, 'without regex=1 the pattern is plain text');

  const badRe = await getJson(`/api/logs?q=${encodeURIComponent('(unclosed')}&regex=1`);
  assert.equal(badRe.status, 400);
  assert.match(badRe.body.error, /invalid regular expression/);
  assert.equal((await getJson(`/api/logs/histogram?q=${encodeURIComponent('[')}&regex=1`)).status, 400);
  assert.equal((await getJson(`/api/logs?q=${encodeURIComponent('a'.repeat(501))}&regex=1`)).status, 400);
});

test('tag filters: eq / ne / re / has, combined, and bad input', async () => {
  const get = async (tags, extra = '') => (await getJson(`/api/logs?${tagsQs(tags)}${extra}`));
  const msgs = (r) => r.body.logs.map((l) => l.message).sort();

  assert.deepEqual(msgs(await get([{ key: 'sku', op: 'eq', value: 'sku-001' }])), ['Card declined for order o-17', 'item added']);
  assert.deepEqual(msgs(await get([{ key: 'sku', op: 'ne', value: 'sku-001' }])), ['card refused', 'cart cleared'], 'ne also keeps logs that have no such tag');
  assert.deepEqual(msgs(await get([{ key: 'user.id', op: 'has' }])), ['item added']);
  assert.deepEqual(msgs(await get([{ key: 'order.id', op: 're', value: '^o-1[78]$' }])), ['Card declined for order o-17', 'card refused']);
  assert.deepEqual(msgs(await get([{ key: 'qty', op: 'eq', value: '2' }])), ['item added'], 'numbers compare as text');
  assert.deepEqual(msgs(await get([{ key: 'sku', op: 'eq', value: 'sku-001' }, { key: 'order.id', op: 'eq', value: 'o-17' }])), ['Card declined for order o-17'], 'tags are ANDed');
  assert.deepEqual(msgs(await get([{ key: 'sku', op: 'eq', value: 'sku-001' }], '&service=cart')), ['item added'], 'combines with the other filters');
  assert.equal((await get([{ key: 'nope', op: 'eq', value: 'x' }])).body.count, 0);

  assert.equal((await getJson('/api/logs?tags=notjson')).status, 400);
  assert.equal((await getJson('/api/logs?tags=%7B%7D')).status, 400, 'must be an array');
  assert.equal((await get([{ key: 'bad"key', op: 'eq', value: 'x' }])).status, 400);
  assert.equal((await get([{ key: 'k', op: 're', value: '(' }])).status, 400, 'bad regex inside a tag');
  assert.equal((await get(Array.from({ length: 11 }, () => ({ key: 'a', op: 'has' })))).status, 400);

  // the same filters drive the timeline and the Fields counts
  const to = Date.now() + 1000; const from = to - 60_000;
  const h = await getJson(`/api/logs/histogram?from=${from}&to=${to}&${tagsQs([{ key: 'sku', op: 'eq', value: 'sku-001' }])}`);
  assert.equal(h.body.total, 2);
  const f = await getJson(`/api/logs/facets?${tagsQs([{ key: 'sku', op: 'eq', value: 'sku-001' }])}`);
  assert.deepEqual(f.body.service.map((s) => s.value).sort(), ['cart', 'payment']);
});

test('dynamic tags: fields lists the keys that exist, field-values their most common values', async () => {
  const fields = await getJson('/api/logs/fields');
  const byKey = Object.fromEntries(fields.body.keys.map((k) => [k.key, k.count]));
  assert.deepEqual(byKey, { sku: 3, 'order.id': 2, qty: 1, 'user.id': 1 });
  assert.equal(fields.body.keys[0].key, 'sku', 'most common first');

  const vals = await getJson('/api/logs/field-values?key=sku');
  assert.deepEqual(vals.body.values, [{ value: 'sku-001', count: 2 }, { value: 'sku-002', count: 1 }]);
  const scoped = await getJson('/api/logs/field-values?key=sku&service=payment');
  assert.deepEqual(scoped.body.values.map((v) => v.value).sort(), ['sku-001', 'sku-002']);
  const narrowed = await getJson(`/api/logs/fields?${tagsQs([{ key: 'user.id', op: 'has' }])}`);
  assert.deepEqual(narrowed.body.keys.map((k) => k.key).sort(), ['qty', 'sku', 'user.id'], 'follows the active filters');
  assert.equal((await getJson('/api/logs/field-values')).status, 400);
  assert.deepEqual((await getJson('/api/logs/field-values?key=missing')).body.values, []);
});

test('live tail understands regex and tags, and reports bad filters', async () => {
  const c = await connect({ q: 'card (declined|refused)', regex: true, tags: [{ key: 'order.id', op: 're', value: '^o-1' }] });
  fake.emit('logs', [
    row({ message: 'Card declined', attributes: { 'order.id': 'o-12' } }),
    row({ message: 'Card declined', attributes: { 'order.id': 'x-12' } }),
    row({ message: 'all good', attributes: { 'order.id': 'o-13' } }),
  ]);
  await sleep(80);
  assert.deepEqual(c.rows().map((r) => r.attributes['order.id']), ['o-12']);

  c.ws.send(JSON.stringify({ type: 'filter', q: '(oops', regex: true }));
  await sleep(60);
  assert.ok(c.frames.some((f) => f.type === 'error' && /invalid regular expression/.test(f.message)));
  const before = c.rows().length;
  fake.emit('logs', [row({ message: 'anything' })]);
  await sleep(80);
  assert.equal(c.rows().length, before, 'nothing streams until a valid filter arrives');

  c.ws.send(JSON.stringify({ type: 'filter', tags: [{ key: 'sku', op: 'eq', value: 'sku-9' }, { key: 'region', op: 'ne', value: 'eu' }] }));
  await sleep(60);
  fake.emit('logs', [row({ message: 'a', attributes: { sku: 'sku-9' } }), row({ message: 'b', attributes: { sku: 'sku-9', region: 'eu' } }), row({ message: 'c', attributes: { sku: 'sku-1' } })]);
  await sleep(80);
  assert.deepEqual(c.rows().slice(before).map((r) => r.message), ['a']);
  c.ws.close();
});