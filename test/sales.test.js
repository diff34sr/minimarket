const { start } = require('./helper');
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const crypto = require('node:crypto');
const db = require('../db');

const dir = `/tmp/claude-1000/receipts-test-${process.pid}`;
process.env.RECEIPTS_DIR = dir;
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

let app, A, C, n = 0;
const post = (path, body, token = A) => app.call(path, { body, token });
const get = (path, token = A) => app.call(path, { token });
const product = async (extra = {}) => (await post('/api/products', { name: 'P', price: 10, barcode: 'b' + ++n, ...extra })).json;
const find = async id => (await get('/api/catalog')).json.products.find(p => p.id === id);
const stocked = async (extra, qty = 10) => {
  const p = await product(extra);
  await post('/api/stock/adjust', { product_id: p.id, qty, note: 'inicial' });
  return p;
};
const sell = (items, extra = {}) => post('/api/sales', { client_uuid: crypto.randomUUID(), pay: 'efectivo', items, ...extra }, C);

before(async () => {
  app = await start();
  A = app.tokens.admin;
  C = app.tokens.cajero;
});
after(() => {
  app.stop();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('lineSubtotal redondea a centavos', () => {
  assert.equal(db.lineSubtotal(32, 0.25), 8);
  assert.equal(db.lineSubtotal(0.1, 3), 0.3);
  assert.equal(db.lineSubtotal(37.3, 1), 37.3);
});

test('carrito: agregar por barcode suma, sube version; código desconocido 404', async () => {
  const p = await product();
  assert.deepEqual((await get('/api/cart', C)).json, { version: 0, items: [], total: 0 });
  const r1 = (await post('/api/cart/add', { barcode: p.barcode }, C)).json;
  const r2 = (await post('/api/cart/add', { barcode: p.barcode }, C)).json;
  assert.equal(r2.items[0].qty, 2);
  assert.equal(r2.total, 20);
  assert.equal(r2.version, r1.version + 1);
  const bad = await post('/api/cart/add', { barcode: 'nope' }, C);
  assert.equal(bad.status, 404);
  assert.equal(bad.json.error, 'Producto no registrado');
  await post('/api/cart/clear', {}, C);
});

test('carrito: cantidad según unidad', async () => {
  const u = await product();
  const kg = await product({ unit: 'kg', price: 32 });
  assert.equal((await post('/api/cart/add', { product_id: u.id, qty: 1.5 }, C)).status, 400);
  const r = await post('/api/cart/add', { product_id: kg.id, qty: 0.25 }, C);
  assert.equal(r.status, 200);
  assert.equal(r.json.items[0].subtotal, 8);
  await post('/api/cart/clear', {}, C);
});

test('cartSet qty 0 quita el ítem; el carrito se comparte por usuario', async () => {
  const p = await product();
  await post('/api/cart/add', { product_id: p.id, qty: 3 }, C);
  const other = (await post('/api/login', { pin: '0000' }, null)).json.token;
  assert.equal((await get('/api/cart', other)).json.items[0].qty, 3);
  assert.equal((await get('/api/cart', A)).json.items.length, 0);
  assert.equal((await post('/api/cart/set', { product_id: p.id, qty: 5 }, other)).json.items[0].qty, 5);
  assert.equal((await post('/api/cart/set', { product_id: p.id, qty: 0 }, C)).json.items.length, 0);
});

test('checkout: congela precio y costo, baja stock, vacía carrito; segundo checkout 400', async () => {
  const p = await stocked({ price: 10, cost: 4 });
  await post('/api/cart/add', { product_id: p.id, qty: 2 }, C);
  const r = await post('/api/cart/checkout', { pay: 'efectivo', client_uuid: crypto.randomUUID() }, C);
  assert.equal(r.status, 200);
  assert.equal(r.json.total, 20);
  assert.deepEqual([r.json.items[0].price, r.json.items[0].cost, r.json.items[0].subtotal], [10, 4, 20]);
  await post('/api/products', { id: p.id, price: 99, cost: 50 });
  assert.equal(db.getSale(r.json.id).items[0].price, 10);
  assert.equal((await find(p.id)).stock, 8);
  assert.equal((await get('/api/cart', C)).json.items.length, 0);
  const again = await post('/api/cart/checkout', { pay: 'efectivo', client_uuid: crypto.randomUUID() }, C);
  assert.equal(again.status, 400);
  assert.equal(again.json.error, 'Carrito vacío');
});

test('client_uuid idempotente', async () => {
  const p = await stocked();
  const body = { client_uuid: crypto.randomUUID(), pay: 'efectivo', items: [{ product_id: p.id, qty: 2 }] };
  const a = await post('/api/sales', body, C);
  const b = await post('/api/sales', body, C);
  assert.equal(a.json.id, b.json.id);
  assert.equal((await find(p.id)).stock, 8);
});

test('checkout: reintento con el mismo uuid devuelve la misma venta; sin uuid 400', async () => {
  const p = await stocked();
  await post('/api/cart/add', { product_id: p.id, qty: 2 }, C);
  assert.equal((await post('/api/cart/checkout', { pay: 'efectivo' }, C)).json.error, 'client_uuid requerido');
  const client_uuid = crypto.randomUUID();
  const a = await post('/api/cart/checkout', { pay: 'efectivo', client_uuid }, C);
  const b = await post('/api/cart/checkout', { pay: 'efectivo', client_uuid }, C);
  assert.equal(b.status, 200);
  assert.equal(a.json.id, b.json.id);
  assert.equal((await find(p.id)).stock, 8);
});

test('venta sin stock suficiente deja stock negativo', async () => {
  const p = await stocked({}, 1);
  assert.equal((await sell([{ product_id: p.id, qty: 3 }])).status, 200);
  assert.equal((await find(p.id)).stock, -2);
});

test('price del ítem se ignora; costo del servidor; repetidos se fusionan', async () => {
  const p = await stocked({ cost: 4 });
  const r = await sell([{ product_id: p.id, qty: 1, price: 7.5 }, { product_id: p.id, qty: 1 }]);
  assert.equal(r.json.items.length, 1);
  assert.deepEqual([r.json.items[0].qty, r.json.items[0].price, r.json.items[0].cost, r.json.total], [2, 10, 4, 20]);
});

test('venta: validaciones y created_at', async () => {
  const p = await stocked();
  assert.equal((await sell([])).status, 400);
  assert.equal((await sell([{ product_id: p.id, qty: 1.5 }])).status, 400);
  assert.equal((await sell([{ product_id: p.id, qty: 1 }], { pay: 'tarjeta' })).status, 400);
  assert.equal((await sell([{ product_id: 9999, qty: 1 }])).status, 404);
  const ok = await sell([{ product_id: p.id, qty: 1 }], { created_at: '2020-01-02 03:04:05' });
  assert.equal(ok.json.created_at, '2020-01-02 03:04:05');
  const bad = await sell([{ product_id: p.id, qty: 1 }], { created_at: 'ayer' });
  assert.match(bad.json.created_at, /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/);
  assert.notEqual(bad.json.created_at, 'ayer');
});

test('comprobante: pendiente, adjuntar, 409, 400, y servirlo solo a admin', async () => {
  const p = await stocked();
  const s = (await sell([{ product_id: p.id, qty: 1 }], { pay: 'qr' })).json;
  assert.ok((await get('/api/receipts/pending', C)).json.some(x => x.id === s.id));
  assert.equal((await post(`/api/sales/${s.id}/receipt`, { image: 'data:text/plain;base64,aGk=' }, C)).status, 400);
  const r = await post(`/api/sales/${s.id}/receipt`, { image: PNG }, C);
  assert.equal(r.status, 200);
  assert.equal(r.json.receipt, `receipts/${s.id}.jpg`);
  assert.ok(fs.existsSync(`${dir}/${s.id}.jpg`));
  assert.ok(!(await get('/api/receipts/pending', C)).json.some(x => x.id === s.id));
  assert.equal((await post(`/api/sales/${s.id}/receipt`, { image: PNG }, C)).status, 409);
  const voided = (await sell([{ product_id: p.id, qty: 1 }], { pay: 'qr' })).json;
  await post(`/api/sales/${voided.id}/void`, {});
  assert.equal((await post(`/api/sales/${voided.id}/receipt`, { image: PNG }, C)).status, 409);
  const cash = (await sell([{ product_id: p.id, qty: 1 }])).json;
  assert.equal((await post(`/api/sales/${cash.id}/receipt`, { image: PNG }, C)).status, 409);

  const file = `${app.base}/receipts/${s.id}.jpg`;
  assert.equal((await fetch(file)).status, 401);
  assert.equal((await fetch(file, { headers: { 'x-token': C } })).status, 403);
  assert.equal((await fetch(`${file}?t=${C}`)).status, 403);
  const ok = await fetch(`${file}?t=${A}`);
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get('content-type'), 'image/jpeg');
  assert.equal((await fetch(file, { headers: { 'x-token': A } })).status, 200);
  assert.equal((await fetch(`${app.base}/receipts/999.jpg?t=${A}`)).status, 404);
  for (const bad of ['..%2Fdb.js', '1.png', 'a.jpg', '%2e%2e%2f%2e%2e%2fserver.js']) assert.ok([403, 404].includes((await fetch(`${app.base}/receipts/${bad}?t=${A}`)).status), bad);
});

test('anular: cajero 403, admin restaura stock, otra vez 409; lista solo admin', async () => {
  const p = await stocked();
  const s = (await sell([{ product_id: p.id, qty: 4 }])).json;
  assert.equal((await find(p.id)).stock, 6);
  assert.equal((await post(`/api/sales/${s.id}/void`, {}, C)).status, 403);
  const v = await post(`/api/sales/${s.id}/void`, {});
  assert.equal(v.status, 200);
  assert.equal(v.json.status, 'anulado');
  assert.equal((await find(p.id)).stock, 10);
  assert.equal((await post(`/api/sales/${s.id}/void`, {})).status, 409);
  assert.equal((await post('/api/sales/9999/void', {})).status, 404);
  assert.equal((await get('/api/sales', C)).status, 403);
  const list = (await get('/api/sales')).json;
  assert.ok(list.find(x => x.id === s.id).items.length === 1);
});

test('gastos e ingresos', async () => {
  assert.equal((await post('/api/cash', { type: 'gasto', amount: 5, note: ' ' }, C)).status, 400);
  assert.equal((await post('/api/cash', { type: 'gasto', amount: 5 }, C)).json.error, 'Comentario requerido');
  assert.equal((await post('/api/cash', { type: 'otro', amount: 5, note: 'x' }, C)).status, 400);
  assert.equal((await post('/api/cash', { type: 'gasto', amount: -5, note: 'x' }, C)).status, 400);
  const g = await post('/api/cash', { type: 'gasto', amount: 5, note: 'bolsas' }, C);
  assert.equal(g.status, 200);
  assert.ok((await get('/api/cash', C)).json.some(x => x.id === g.json.id));
  assert.equal((await post(`/api/cash/${g.json.id}/void`, {}, C)).status, 403);
  assert.equal((await post(`/api/cash/${g.json.id}/void`, {})).status, 200);
  assert.equal((await post(`/api/cash/${g.json.id}/void`, {})).status, 409);
});
