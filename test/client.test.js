require('./helper');
const test = require('node:test');
const assert = require('node:assert/strict');
const cart = require('../public/cart.js');
const { createQueue } = require('../public/queue.js');
const { lineSubtotal } = require('../db.js');

const mem = (init = {}) => ({ d: { ...init }, getItem(k) { return k in this.d ? this.d[k] : null; }, setItem(k, v) { this.d[k] = String(v); } });

test('lineSubtotal igual que el servidor', () => {
  assert.equal(cart.lineSubtotal(32, 0.25), 8);
  for (const [p, q] of [[32, .25], [.1, 3], [37.3, 1], [12.5, 0.333], [1.05, 7]]) {
    assert.equal(cart.lineSubtotal(p, q), lineSubtotal(p, q));
  }
});

test('gramsToQty', () => {
  assert.equal(cart.gramsToQty(250), 0.25);
  assert.equal(cart.gramsToQty(333.3333), 0.333);
});

test('cartAdd fusiona sin mutar', () => {
  const p = { product_id: 1, name: 'Pan', unit: 'u', price: 2 };
  const a = [];
  const b = cart.cartAdd(cart.cartAdd(a, p), p);
  assert.equal(b.length, 1);
  assert.equal(b[0].qty, 2);
  assert.equal(a.length, 0);
  const k = { product_id: 2, name: 'Queso', unit: 'kg', price: 30 };
  assert.equal(cart.cartAdd(cart.cartAdd([], k, 0.1), k, 0.2)[0].qty, 0.3);
  const c = cart.cartAdd(b, p);
  assert.equal(b[0].qty, 2);
  assert.equal(c[0].qty, 3);
});

test('cartSet y cartTotal', () => {
  const p = { product_id: 1, name: 'Pan', unit: 'u', price: 2 };
  const items = cart.cartAdd([], p, 3);
  assert.equal(cart.cartSet(items, 1, 5)[0].qty, 5);
  assert.equal(items[0].qty, 3);
  assert.deepEqual(cart.cartSet(items, 1, 0), []);
  assert.deepEqual(cart.cartSet(items, 1, NaN), []);
  assert.equal(cart.cartSet(items, 1, 0.3333)[0].qty, 0.333);
  assert.equal(cart.cartTotal(items), 6);
  assert.equal(cart.cartTotal([{ price: 0.1, qty: 3 }, { price: 0.2, qty: 1 }]), 0.5);
});

test('change', () => {
  assert.equal(cart.change(37.3, 100), 62.7);
  assert.equal(cart.change(37.3, 30), null);
  assert.equal(cart.change(37.3, NaN), null);
  assert.equal(cart.change(37.3, undefined), null);
});

test('cola: envía todo', async () => {
  const sent = [];
  const q = createQueue(mem(), async s => { sent.push(s); });
  q.enqueue({ n: 1 }); q.enqueue({ n: 2 });
  assert.equal(q.pending().length, 2);
  assert.deepEqual(await q.flush(), { sent: 2, left: 0 });
  assert.deepEqual(sent, [{ n: 1 }, { n: 2 }]);
});

test('cola: corta en el primer error', async () => {
  const st = mem();
  const q = createQueue(st, async s => { if (s.n === 2) throw new Error('x'); });
  q.enqueue({ n: 1 }); q.enqueue({ n: 2 });
  assert.deepEqual(await q.flush(), { sent: 1, left: 1 });
  assert.deepEqual(createQueue(st, async () => {}).pending(), [{ n: 2 }]);
});

test('cola: flush concurrente comparte promesa', async () => {
  let calls = 0;
  const q = createQueue(mem(), async () => { calls++; await new Promise(r => setTimeout(r, 10)); });
  q.enqueue({ n: 1 }); q.enqueue({ n: 2 });
  const [a, b] = await Promise.all([q.flush(), q.flush()]);
  assert.equal(calls, 2);
  assert.deepEqual(a, b);
  assert.deepEqual(await q.flush(), { sent: 0, left: 0 });
});

test('cola: JSON corrupto arranca vacía', () => {
  assert.deepEqual(createQueue(mem({ sales_queue: '{no' }), async () => {}).pending(), []);
  assert.deepEqual(createQueue(mem({ sales_queue: '{"a":1}' }), async () => {}).pending(), []);
});
