// Run: node --test frontend/src/lib/topologyLayout.test.js
import test from 'node:test';
import assert from 'node:assert';
import { NODE_H, NODE_W, assignLayers, layout } from './topologyLayout.js';

const n = (...names) => names.map((service) => ({ service }));
const e = (pairs) => pairs.map(([source, target]) => ({ source, target }));

test('callers go left of what they call, longest chain decides the column', () => {
  const L = assignLayers(['gateway', 'cart', 'inventory', 'payment'], e([['gateway', 'cart'], ['gateway', 'inventory'], ['gateway', 'payment'], ['cart', 'inventory']]));
  assert.deepStrictEqual([L.get('gateway'), L.get('cart'), L.get('payment'), L.get('inventory')], [0, 1, 1, 2], 'inventory is after cart, not beside it');
});

test('cycles do not hang and still give every service a column', () => {
  const L = assignLayers(['a', 'b', 'c'], e([['a', 'b'], ['b', 'c'], ['c', 'a']]));
  assert.strictEqual(L.size, 3);
  assert.ok([...L.values()].every(Number.isInteger));
  const self = assignLayers(['a'], e([['a', 'a']]));
  assert.strictEqual(self.get('a'), 0);
});

test('disconnected and edge-less graphs', () => {
  assert.strictEqual(layout([], []).size, 0);
  const pos = layout(n('x', 'y'), []);
  assert.strictEqual(pos.size, 2);
  assert.notDeepStrictEqual(pos.get('x'), pos.get('y'), 'two lone services must not sit on top of each other');
  assert.strictEqual(assignLayers(['a', 'b'], e([['a', 'zzz'], ['q', 'b']])).get('b'), 0, 'edges to unknown services are ignored');
});

test('positions never overlap and columns are centred', () => {
  const nodes = n('gateway', 'cart', 'inventory', 'payment');
  const pos = layout(nodes, e([['gateway', 'cart'], ['gateway', 'inventory'], ['gateway', 'payment'], ['cart', 'inventory']]));
  const list = [...pos.values()];
  for (let i = 0; i < list.length; i += 1) {
    for (let j = i + 1; j < list.length; j += 1) {
      const apart = Math.abs(list[i].x - list[j].x) >= NODE_W || Math.abs(list[i].y - list[j].y) >= NODE_H;
      assert.ok(apart, `boxes ${i} and ${j} overlap`);
    }
  }
  assert.ok(pos.get('gateway').x < pos.get('cart').x && pos.get('cart').x < pos.get('inventory').x);
  assert.ok(pos.get('gateway').y > 0, 'the lone gateway is vertically centred against the taller column');
});

test('a wide fan-out stays tidy', () => {
  const names = Array.from({ length: 8 }, (_, i) => `s${i}`);
  const pos = layout(n('root', ...names), e(names.map((s) => ['root', s])));
  assert.strictEqual(pos.size, 9);
  const ys = names.map((s) => pos.get(s).y);
  assert.strictEqual(new Set(ys).size, 8);
});
