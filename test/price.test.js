const { start } = require('./helper');
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const db = require('../db');

let app, A, C, n = 0;
const post = (path, body, token = A) => app.call(path, { body, token });
const find = async id => (await app.call('/api/catalog', { token: A })).json.products.find(p => p.id === id);
const mk = async (extra = {}, token = A) => (await post('/api/products', { name: 'P', price: 5, cost: 3, barcode: 'x' + ++n, ...extra }, token)).json;
const log = id => db.db.prepare('SELECT field, old, new, user_id FROM price_log WHERE product_id = ? ORDER BY id').all(id).map(r => ({ ...r }));
const sell = (items, extra = {}) => post('/api/sales', { client_uuid: crypto.randomUUID(), pay: 'efectivo', items, ...extra }, C);

before(async () => {
  app = await start();
  A = app.tokens.admin;
  C = app.tokens.cajero;
});
after(() => app.stop());

test('cajero edita el nombre y reenvía el mismo precio: 200', async () => {
  const p = await mk();
  assert.equal((await post('/api/products', { id: p.id, name: 'Nuevo' }, C)).status, 200);
  const r = await post('/api/products', { id: p.id, name: 'Otro', price: 5, cost: 3 }, C);
  assert.equal(r.status, 200);
  assert.equal(r.json.name, 'Otro');
  assert.deepEqual(log(p.id), []);
});

test('cajero no cambia precio ni costo', async () => {
  const p = await mk();
  for (const patch of [{ price: 6 }, { cost: 4 }]) {
    const r = await post('/api/products', { id: p.id, name: 'Hack', ...patch }, C);
    assert.equal(r.status, 403);
    assert.equal(r.json.error, 'Solo admin cambia precio, costo, unidad, código o estado');
  }
  const cur = await find(p.id);
  assert.deepEqual([cur.price, cur.cost, cur.name], [5, 3, 'P']);
});

test('cajero no cambia unit, barcode ni active; mismos valores 200; admin sí', async () => {
  const p = await mk();
  for (const patch of [{ unit: 'kg' }, { barcode: 'otro' + p.id }, { active: 0 }]) {
    const r = await post('/api/products', { id: p.id, ...patch }, C);
    assert.equal(r.status, 403, JSON.stringify(patch));
    assert.equal(r.json.error, 'Solo admin cambia precio, costo, unidad, código o estado');
  }
  const same = await post('/api/products', { id: p.id, unit: 'u', barcode: p.barcode, active: 1, price: 5, cost: 3, name: 'Igual' }, C);
  assert.equal(same.status, 200);
  const r = await post('/api/products', { id: p.id, unit: 'kg', barcode: 'nuevo' + p.id, active: 0 });
  assert.equal(r.status, 200);
  assert.deepEqual([r.json.unit, r.json.barcode, r.json.active], ['kg', 'nuevo' + p.id, 0]);
});

test('price se redondea a 2 decimales y cost a 4 al crear y editar', async () => {
  const p = await mk({ price: 5.004, cost: 3.00004 });
  assert.deepEqual([p.price, p.cost], [5, 3]);
  const r = await post('/api/products', { id: p.id, price: 5.004, cost: 3.12345 });
  assert.deepEqual([r.json.price, r.json.cost], [5, 3.1235]);
  assert.deepEqual(log(p.id).map(x => x.field), ['cost']);
});

test('cajero crea producto con precio y costo; no se registra en el log', async () => {
  const p = await mk({ price: 5, cost: 3 }, C);
  assert.deepEqual([p.price, p.cost], [5, 3]);
  assert.deepEqual(log(p.id), []);
});

test('admin: una fila por campo que cambió', async () => {
  const p = await mk();
  await post('/api/products', { id: p.id, price: 6 });
  assert.deepEqual(log(p.id), [{ field: 'price', old: 5, new: 6, user_id: 1 }]);
  await post('/api/products', { id: p.id, price: 7, cost: 4 });
  assert.equal(log(p.id).length, 3);
  assert.deepEqual(log(p.id).slice(1).map(r => [r.field, r.old, r.new]), [['price', 6, 7], ['cost', 3, 4]]);
  await post('/api/products', { id: p.id, price: 7, cost: 4, name: 'Z' });
  assert.equal(log(p.id).length, 3);
});

test('cajero no hace stock/adjust', async () => {
  const p = await mk();
  assert.equal((await post('/api/stock/adjust', { product_id: p.id, qty: 1, note: 'x' }, C)).status, 403);
});

test('venta usa el precio del servidor y marca price_mismatch', async () => {
  const p = await mk();
  const a = await sell([{ product_id: p.id, qty: 1, price: 4.5 }]);
  assert.deepEqual([a.json.items[0].price, a.json.price_mismatch, a.json.total], [5, 1, 5]);
  const b = await sell([{ product_id: p.id, qty: 1, price: 5 }]);
  assert.equal(b.json.price_mismatch, 0);
  const c = await sell([{ product_id: p.id, qty: 1 }]);
  assert.equal(c.json.price_mismatch, 0);
});

test('total se redondea a centavos: 0.1 + 0.2 = 0.3', async () => {
  const a = await mk({ price: 0.1 });
  const b = await mk({ price: 0.2 });
  assert.equal((await sell([{ product_id: a.id, qty: 1 }, { product_id: b.id, qty: 1 }])).json.total, 0.3);
  await post('/api/cart/add', { product_id: a.id }, C);
  assert.equal((await post('/api/cart/add', { product_id: b.id }, C)).json.total, 0.3);
  await post('/api/cart/clear', {}, C);
});
