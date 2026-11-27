const { start } = require('./helper');
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

let app, A, C;
const post = (path, body, token = A) => app.call(path, { body, token });
const product = async (extra = {}) => (await post('/api/products', { name: 'P', price: 10, ...extra })).json;
const find = async id => (await app.call('/api/catalog', { token: A })).json.products.find(p => p.id === id);

before(async () => {
  app = await start();
  A = app.tokens.admin;
  C = app.tokens.cajero;
});
after(() => app.stop());

test('barcode duplicado da 409', async () => {
  assert.equal((await post('/api/products', { name: 'A', barcode: '7790001', price: 5 })).status, 200);
  const r = await post('/api/products', { name: 'B', barcode: '7790001', price: 5 });
  assert.equal(r.status, 409);
  assert.equal(r.json.error, 'Ese código ya existe');
});

test('barcode vacío dos veces no choca', async () => {
  assert.equal((await post('/api/products', { name: 'A', barcode: '', price: 5 })).status, 200);
  assert.equal((await post('/api/products', { name: 'B', barcode: '', price: 5 })).status, 200);
});

test('ajuste guarda el costo del momento', async () => {
  const p = await product({ cost: 4.5 });
  const r = await post('/api/stock/adjust', { product_id: p.id, qty: 10, note: 'inicial' });
  assert.equal(r.json.stock, 10);
  const moves = (await app.call('/api/stock/moves?product_id=' + p.id, { token: A })).json;
  assert.deepEqual([moves.length, moves[0].type, moves[0].cost], [1, 'ajuste', 4.5]);
});

test('ajustes son delta', async () => {
  const p = await product();
  await post('/api/stock/adjust', { product_id: p.id, qty: 10, note: 'inicial' });
  await post('/api/stock/adjust', { product_id: p.id, qty: -3, note: 'rotura' });
  const r = await post('/api/stock/adjust', { product_id: p.id, qty: -2, note: 'rotura' });
  assert.equal(r.json.stock, 5);
});

test('ajuste sin motivo o con qty 0 da 400', async () => {
  const p = await product();
  const r = await post('/api/stock/adjust', { product_id: p.id, qty: 1, note: '  ' });
  assert.equal(r.status, 400);
  assert.equal(r.json.error, 'Motivo requerido');
  assert.equal((await post('/api/stock/adjust', { product_id: p.id, qty: 0, note: 'x' })).status, 400);
});

test('saveProduct ignora stock del body', async () => {
  const p = await product();
  await post('/api/stock/adjust', { product_id: p.id, qty: 2, note: 'inicial' });
  await post('/api/products', { id: p.id, name: 'P2', price: 10, stock: 99 });
  assert.equal((await find(p.id)).stock, 2);
});

test('producto kg acepta 1.25', async () => {
  const p = await product({ unit: 'kg' });
  assert.equal((await post('/api/stock/adjust', { product_id: p.id, qty: 1.25, note: 'x' })).json.stock, 1.25);
});

test('cajero crea producto; no ajusta ni crea categoría', async () => {
  const p = await post('/api/products', { name: 'C', price: 3 }, C);
  assert.equal(p.status, 200);
  assert.equal((await post('/api/stock/adjust', { product_id: p.json.id, qty: 1, note: 'x' }, C)).status, 403);
  assert.equal((await post('/api/categories', { name: 'Bebidas' }, C)).status, 403);
});

test('borrar categoría con productos da 409; sin productos 200; cajero 403', async () => {
  const c = (await post('/api/categories', { name: 'Lácteos' })).json;
  await product({ cat_id: c.id });
  assert.equal((await post(`/api/categories/${c.id}/delete`, {})).status, 409);
  assert.equal((await post(`/api/categories/${c.id}/delete`, {}, C)).status, 403);
  const e = (await post('/api/categories', { name: 'Vacía' })).json;
  assert.equal((await post(`/api/categories/${e.id}/delete`, {})).status, 200);
});

test('validación de entrada del cliente da 400', async () => {
  const bad = [
    { name: 'X', price: -1 },
    { name: 'X', price: 1, cost: -1 },
    { name: 'X', price: 1, unit: 'lt' },
    { name: 'X', price: 'abc' },
    { name: '', price: 1 },
    { name: 'X', price: 1, cat_id: 9999 },
  ];
  for (const b of bad) assert.equal((await post('/api/products', b)).status, 400, JSON.stringify(b));
  const p = await product();
  for (const qty of [0, 'x', null, Infinity]) assert.equal((await post('/api/stock/adjust', { product_id: p.id, qty, note: 'a' })).status, 400);
  assert.equal((await post('/api/stock/adjust', { product_id: 9999, qty: 1, note: 'a' })).status, 404);
});

test('editar solo el precio conserva el resto', async () => {
  const c = (await post('/api/categories', { name: 'Conserva' })).json;
  const p = await product({ barcode: '779', brand: 'Marca', unit: 'kg', cat_id: c.id, cost: 3, ask_qty: 1, active: 0 });
  const r = (await post('/api/products', { id: p.id, price: 2 })).json;
  assert.deepEqual([r.price, r.barcode, r.brand, r.unit, r.cat_id, r.cost, r.ask_qty, r.active, r.name], [2, '779', 'Marca', 'kg', c.id, 3, 1, 0, 'P']);
});

test('flags y cat_id vacíos', async () => {
  const p = await product({ ask_qty: '0', active: '0', cat_id: '' });
  assert.deepEqual([p.ask_qty, p.active, p.cat_id], [0, 0, null]);
  assert.equal((await post('/api/categories', { name: 'SinOrden', sort: null })).json.sort, 0);
});

test('cantidad según unidad', async () => {
  const u = await product();
  assert.equal((await post('/api/stock/adjust', { product_id: u.id, qty: 1.5, note: 'x' })).status, 400);
  assert.equal((await post('/api/stock/adjust', { product_id: u.id, qty: -0.5, note: 'x' })).status, 400);
  const kg = await product({ unit: 'kg' });
  assert.equal((await post('/api/stock/adjust', { product_id: kg.id, qty: 0.12345, note: 'x' })).json.stock, 0.123);
});
