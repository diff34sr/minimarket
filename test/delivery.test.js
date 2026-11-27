const { start } = require('./helper');
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const db = require('../db');

let app, A, C, n = 0;
const post = (path, body, token = A) => app.call(path, { body, token });
const get = (path, token = A) => app.call(path, { token });
const find = async id => (await get('/api/catalog')).json.products.find(p => p.id === id);
const product = async (stock = 0, cost = 0, extra = {}) => {
  const p = (await post('/api/products', { name: 'P', price: 10, cost, barcode: 'd' + ++n, ...extra })).json;
  if (stock) await post('/api/stock/adjust', { product_id: p.id, qty: stock, note: 'inicial' });
  return p;
};
const deliver = (items, extra = {}, token = C) => post('/api/deliveries', { payment: 'pendiente', items, ...extra }, token);
const log = id => db.db.prepare("SELECT * FROM price_log WHERE product_id = ? AND field = 'cost' ORDER BY id").all(id);

before(async () => {
  app = await start();
  A = app.tokens.admin;
  C = app.tokens.cajero;
});
after(() => app.stop());

test('costo promedio ponderado y price_log con el cajero', async () => {
  const p = await product(10, 4);
  const r = await deliver([{ product_id: p.id, qty: 10, unit_cost: 6 }]);
  assert.equal(r.status, 200);
  const q = await find(p.id);
  assert.deepEqual([q.stock, q.cost], [20, 5]);
  const l = log(p.id).at(-1);
  assert.deepEqual([l.old, l.new, l.user_id], [4, 5, 2]);
  assert.equal(r.json.items[0].prev_cost, 4);
});

test('stock negativo cuenta como base 0', async () => {
  const p = await product(0, 4);
  await post('/api/stock/adjust', { product_id: p.id, qty: -2, note: 'x' });
  await deliver([{ product_id: p.id, qty: 10, unit_cost: 6 }]);
  const q = await find(p.id);
  assert.deepEqual([q.stock, q.cost], [8, 6]);
});

test('conteo genera merma a costo del momento', async () => {
  const p = await product(10, 4);
  const r = await deliver([{ product_id: p.id, qty: 5, unit_cost: 4, counted: 7 }]);
  const it = r.json.items[0];
  assert.deepEqual([it.counted, it.diff], [7, -3]);
  assert.equal((await find(p.id)).stock, 12);
  const m = (await get('/api/stock/moves?product_id=' + p.id)).json.find(x => x.type === 'conteo');
  assert.deepEqual([m.qty, m.cost, m.note], [-3, 4, `Conteo en entrega #${r.json.id}`]);
});

test('conteo igual al stock no genera move; sin conteo diff es null', async () => {
  const p = await product(10, 4);
  const r = await deliver([{ product_id: p.id, qty: 1, unit_cost: 4, counted: 10 }]);
  assert.equal(r.json.items[0].diff, 0);
  const r2 = await deliver([{ product_id: p.id, qty: 1, unit_cost: 4 }]);
  assert.equal(r2.json.items[0].diff, null);
  const moves = (await get('/api/stock/moves?product_id=' + p.id)).json;
  assert.deepEqual(moves.map(m => m.type), ['ajuste']);
});

test('kg redondea a 3 decimales', async () => {
  const p = await product(0, 0, { unit: 'kg' });
  assert.equal((await deliver([{ product_id: p.id, qty: 1.2345, unit_cost: 2 }])).json.items[0].qty, 1.235);
  assert.equal((await find(p.id)).stock, 1.235);
});

test('efectivo_caja crea un gasto con el proveedor; qr_dueno no', async () => {
  const s = (await post('/api/suppliers', { name: 'Coca', phone: '1' }, C)).json;
  const a = await product(), b = await product();
  const items = [{ product_id: a.id, qty: 2, unit_cost: 3.5 }, { product_id: b.id, qty: 1, unit_cost: 1 }];
  const r = await deliver(items, { payment: 'efectivo_caja', supplier_id: s.id });
  assert.equal(r.json.total, 8);
  assert.equal(r.json.supplier, 'Coca');
  const g = db.db.prepare('SELECT * FROM cash_moves WHERE id = ?').get(r.json.cash_move_id);
  assert.deepEqual([g.type, g.amount, g.note, g.user_id], ['gasto', 8, 'Coca', 2]);
  const before = db.db.prepare('SELECT COUNT(*) AS c FROM cash_moves').get().c;
  await deliver(items, { payment: 'qr_dueno' });
  assert.equal(db.db.prepare('SELECT COUNT(*) AS c FROM cash_moves').get().c, before);
  const sin = await deliver(items, { payment: 'efectivo_caja' });
  assert.equal(db.db.prepare('SELECT note FROM cash_moves WHERE id = ?').get(sin.json.cash_move_id).note, `Entrega #${sin.json.id}`);
});

test('anular: cajero 403; admin revierte stock, costo y gasto; repetir 409', async () => {
  const p = await product(10, 4);
  const r = await deliver([{ product_id: p.id, qty: 10, unit_cost: 6 }], { payment: 'efectivo_caja' });
  assert.equal((await post(`/api/deliveries/${r.json.id}/void`, {}, C)).status, 403);
  const v = await post(`/api/deliveries/${r.json.id}/void`, {});
  assert.equal(v.status, 200);
  const q = await find(p.id);
  assert.deepEqual([q.stock, q.cost], [10, 4]);
  assert.ok(db.db.prepare('SELECT voided_at FROM cash_moves WHERE id = ?').get(r.json.cash_move_id).voided_at);
  assert.equal(v.json.status, 'anulada');
  assert.equal((await post(`/api/deliveries/${r.json.id}/void`, {})).status, 409);
});

test('anular una entrega no última deja el costo', async () => {
  const p = await product(10, 4);
  const d1 = await deliver([{ product_id: p.id, qty: 10, unit_cost: 6 }]);
  await deliver([{ product_id: p.id, qty: 20, unit_cost: 8 }]);
  const cost = (await find(p.id)).cost;
  await post(`/api/deliveries/${d1.json.id}/void`, {});
  const q = await find(p.id);
  assert.deepEqual([q.stock, q.cost], [30, cost]);
});

test('no existe edición de entregas', async () => {
  assert.equal((await post('/api/deliveries/1', { payment: 'qr_dueno' })).status, 404);
});

test('validaciones dan 400 y hacen rollback', async () => {
  const p = await product(5, 2);
  const ok = { product_id: p.id, qty: 1, unit_cost: 1 };
  assert.equal((await deliver([{ ...ok, expires_at: '25/12' }])).status, 400);
  assert.equal((await deliver([ok, { ...ok, unit_cost: -1 }])).status, 400);
  assert.equal((await deliver([ok], { payment: 'x' })).status, 400);
  assert.equal((await deliver([])).status, 400);
  assert.equal((await deliver([ok], { supplier_id: 999 })).status, 400);
  assert.equal((await deliver([{ ...ok, counted: -1 }])).status, 400);
  assert.equal((await deliver([{ ...ok, qty: 0 }])).status, 400);
  assert.equal((await deliver([ok, { product_id: 9999, qty: 1, unit_cost: 1 }])).status, 404);
  const q = await find(p.id);
  assert.deepEqual([q.stock, q.cost], [5, 2]);
  assert.equal((await deliver([{ ...ok, expires_at: '2026-12-25' }])).status, 200);
});

test('proveedores: cajero crea y edita; active 0 lo oculta', async () => {
  const s = (await post('/api/suppliers', { name: 'Pil' }, C)).json;
  assert.equal((await post('/api/suppliers', { id: s.id, name: 'Pil SA', phone: '77' }, C)).json.name, 'Pil SA');
  assert.ok((await get('/api/suppliers', C)).json.some(x => x.id === s.id));
  await post('/api/suppliers', { id: s.id, name: 'Pil SA', active: 0 }, C);
  assert.ok(!(await get('/api/suppliers', C)).json.some(x => x.id === s.id));
  assert.ok((await get('/api/suppliers?all=1', C)).json.some(x => x.id === s.id));
  assert.equal((await post('/api/suppliers', { name: ' ' }, C)).status, 400);
});

test('GET /api/deliveries es solo admin y trae líneas', async () => {
  assert.equal((await get('/api/deliveries', C)).status, 403);
  const r = await get('/api/deliveries');
  assert.equal(r.status, 200);
  assert.ok(r.json.length > 0 && r.json[0].items.length > 0 && r.json[0].user);
});

test('productos nuevos: created_by y revisión', async () => {
  const c = (await post('/api/products', { name: 'N', price: 1 }, C)).json;
  assert.deepEqual([c.created_by, c.reviewed_at, c.min_stock], [2, null, 5]);
  assert.ok((await post('/api/products', { name: 'N', price: 1 })).json.reviewed_at);
  assert.equal((await post(`/api/products/${c.id}/reviewed`, {}, C)).status, 403);
  assert.ok((await post(`/api/products/${c.id}/reviewed`, {})).json.reviewed_at);
});

test('min_stock lo edita el cajero y se valida', async () => {
  const p = await product();
  assert.equal((await post('/api/products', { id: p.id, min_stock: 12 }, C)).json.min_stock, 12);
  assert.equal((await post('/api/products', { id: p.id, min_stock: -1 }, C)).status, 400);
});

test('el gasto de una entrega no se anula por /cash/:id/void; al anular la entrega queda anulado por el admin', async () => {
  const p = await product(1, 1);
  const r = await deliver([{ product_id: p.id, qty: 1, unit_cost: 2 }], { payment: 'efectivo_caja' });
  const cash = r.json.cash_move_id;
  const v = await post(`/api/cash/${cash}/void`, {});
  assert.equal(v.status, 409);
  assert.equal(v.json.error, 'Anule la entrega');
  await post(`/api/deliveries/${r.json.id}/void`, {});
  const g = db.db.prepare('SELECT voided_by, voided_at FROM cash_moves WHERE id = ?').get(cash);
  assert.equal(g.voided_by, 1);
  assert.ok(g.voided_at);
});

test('efectivo_caja con total 0 se registra sin gasto', async () => {
  const p = await product(1, 1);
  const before = db.db.prepare('SELECT COUNT(*) AS c FROM cash_moves').get().c;
  const r = await deliver([{ product_id: p.id, qty: 1, unit_cost: 0 }], { payment: 'efectivo_caja' });
  assert.equal(r.status, 200);
  assert.equal(r.json.cash_move_id, null);
  assert.equal(db.db.prepare('SELECT COUNT(*) AS c FROM cash_moves').get().c, before);
});

test('anular con el mismo producto dos veces restaura costo y stock', async () => {
  const p = await product(10, 4);
  const r = await deliver([{ product_id: p.id, qty: 10, unit_cost: 6 }, { product_id: p.id, qty: 10, unit_cost: 8 }]);
  assert.equal((await post(`/api/deliveries/${r.json.id}/void`, {})).status, 200);
  const q = await find(p.id);
  assert.deepEqual([q.stock, q.cost], [10, 4]);
});

test('anular conserva el conteo y deja el stock en counted', async () => {
  const p = await product(10, 4);
  const r = await deliver([{ product_id: p.id, qty: 5, unit_cost: 4, counted: 7 }]);
  await post(`/api/deliveries/${r.json.id}/void`, {});
  assert.equal((await find(p.id)).stock, 7);
  const moves = (await get('/api/stock/moves?product_id=' + p.id)).json;
  assert.ok(moves.some(m => m.type === 'conteo' && m.qty === -3));
});
