const { start } = require('./helper');
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const db = require('../db');

let app, A, C, n = 0;
const post = (path, body, token = A) => app.call(path, { body, token });
const get = (path, token = A) => app.call(path, { token });
const q = (sql, ...a) => db.db.prepare(sql).run(...a);
const sqlDate = mod => db.db.prepare(`SELECT date('now','localtime','${mod}') AS d`).get().d;
const report = async (from, to = from) => (await get(`/api/report?from=${from}&to=${to}`)).json;
const category = async name => (await post('/api/categories', { name })).json.id;
const product = async (extra = {}) => (await post('/api/products', { name: 'P' + ++n, price: 10, cost: 0, barcode: 'r' + n, ...extra })).json;
const stock = (product_id, qty, token = A) => post('/api/stock/adjust', { product_id, qty, note: 'x' }, token);
const sale = (day, pay, items, user_id = 1) => db.createSale({ client_uuid: 'r' + ++n, user_id, pay, items, created_at: day + ' 10:00:00' });
const cash = (day, type, amount, voided) => q('INSERT INTO cash_moves (type, amount, note, user_id, voided_at, created_at) VALUES (?, ?, ?, 1, ?, ?)', type, amount, 'n', voided ? day + ' 11:00:00' : null, day + ' 09:00:00');

let catA, catB, p1, p2;

before(async () => {
  app = await start();
  A = app.tokens.admin;
  C = app.tokens.cajero;
  catA = await category('A');
  catB = await category('B');
  p1 = await product({ cat_id: catA, price: 10, cost: 2 });
  p2 = await product({ cat_id: catB, price: 100, cost: 95 });
});
after(() => app.stop());

test('total, margen, categorías y top_profit excluyen anuladas', async () => {
  const D = '2026-01-10';
  sale(D, 'efectivo', [{ product_id: p1.id, qty: 3 }, { product_id: p2.id, qty: 1 }]);
  sale(D, 'qr', [{ product_id: p1.id, qty: 2 }], 2);
  db.voidSale(sale(D, 'efectivo', [{ product_id: p1.id, qty: 5 }]).id, 1);
  const r = await report(D);
  assert.equal(r.total, 150);
  assert.equal(r.margin, 45);
  assert.deepEqual(r.by_pay, { efectivo: 130, qr: 20 });
  assert.deepEqual(r.by_category, [{ cat_id: catB, name: 'B', total: 100, margin: 5 }, { cat_id: catA, name: 'A', total: 50, margin: 40 }]);
  assert.deepEqual(r.top_profit.map(x => [x.product_id, x.qty, x.total, x.margin]), [[p1.id, 5, 50, 40], [p2.id, 1, 100, 5]]);
  assert.deepEqual(r.by_user.map(u => [u.name, u.total]).sort(), [['Admin', 130], ['Cajero', 20]]);
  assert.equal(r.by_product.length, 2);
});

test('producto sin categoría va como "Sin categoría"', async () => {
  const p = await product({ price: 4, cost: 1 });
  sale('2026-01-11', 'efectivo', [{ product_id: p.id, qty: 1 }]);
  assert.deepEqual((await report('2026-01-11')).by_category, [{ cat_id: null, name: 'Sin categoría', total: 4, margin: 3 }]);
});

test('efectivo_esperado cuenta gastos e ingresos y omite anulados', async () => {
  const D = '2026-01-12';
  sale(D, 'efectivo', [{ product_id: p2.id, qty: 1 }]);
  sale(D, 'qr', [{ product_id: p2.id, qty: 1 }]);
  cash(D, 'gasto', 15);
  cash(D, 'gasto', 7, true);
  cash(D, 'ingreso', 5);
  const r = await report(D);
  assert.deepEqual([r.gastos, r.ingresos, r.efectivo_esperado], [15, 5, 90]);
});

test('no_sales, low_stock y expiring', async () => {
  const idle = await product(), inactive = await product({ active: 0 });
  const neg = await product(), three = await product(), ten = await product(), tenMin = await product({ min_stock: 20 });
  await stock(neg.id, -2);
  await stock(three.id, 3);
  await stock(ten.id, 10);
  await stock(tenMin.id, 10);
  const r = await report('2026-01-10');
  const ids = r.no_sales.map(x => x.id);
  assert.ok(ids.includes(idle.id) && !ids.includes(inactive.id) && !ids.includes(p1.id));
  assert.deepEqual(r.no_sales.find(x => x.id === idle.id), { id: idle.id, name: idle.name, stock: 0 });
  const mine = new Set([neg.id, three.id, ten.id, tenMin.id]);
  assert.deepEqual(r.low_stock.filter(x => mine.has(x.id)).map(x => x.id), [neg.id, three.id, tenMin.id]);
  assert.deepEqual(Object.keys(r.low_stock[0]), ['id', 'name', 'unit', 'stock', 'min_stock']);

  const soon = await product(), empty = await product(), far = await product();
  const dl = (p, days) => post('/api/deliveries', { payment: 'pendiente', items: [{ product_id: p.id, qty: 5, unit_cost: 1, expires_at: sqlDate(`+${days} day`) }] }, C);
  await dl(soon, 3);
  await dl(empty, 3);
  await dl(far, 30);
  await stock(empty.id, -5);
  const ex = (await report('2026-01-10')).expiring;
  assert.deepEqual(ex.filter(x => [soon.id, empty.id, far.id].includes(x.product_id)).map(x => [x.product_id, x.stock]), [[soon.id, 5]]);
});

test('to_review y count_diffs', async () => {
  const p = (await post('/api/products', { name: 'Nuevo', price: 5, cost: 2, barcode: 'nuevo' }, C)).json;
  const rv = (await report('2026-01-12')).to_review.find(x => x.id === p.id);
  assert.deepEqual(rv, { id: p.id, name: 'Nuevo', price: 5, cost: 2, created_by_name: 'Cajero' });
  await stock(p.id, 10);
  const d = (await post('/api/deliveries', { payment: 'pendiente', items: [{ product_id: p.id, qty: 1, unit_cost: 2, counted: 7 }] }, C)).json;
  q("UPDATE deliveries SET at = '2026-01-13 09:00:00' WHERE id = ?", d.id);
  const r = await report('2026-01-13');
  assert.deepEqual(r.count_diffs, [{ delivery_id: d.id, at: '2026-01-13 09:00:00', product: 'Nuevo', diff: -3, cost: 2, user_name: 'Cajero' }]);
});

test('rango sin ventas: todo en 0 o []', async () => {
  const r = await report('2000-01-01', '2000-01-02');
  assert.deepEqual([r.total, r.margin, r.gastos, r.ingresos, r.efectivo_esperado], [0, 0, 0, 0, 0]);
  assert.deepEqual(r.by_pay, { efectivo: 0, qr: 0 });
  for (const k of ['by_product', 'by_user', 'by_category', 'top_profit', 'count_diffs']) assert.deepEqual(r[k], [], k);
});

test('cierre de caja inmutable', async () => {
  const D = '2026-01-20';
  sale(D, 'efectivo', [{ product_id: p2.id, qty: 1 }]);
  cash(D, 'gasto', 10);
  const r = await post('/api/closures', { day: D, counted: 100, note: 'ok' });
  assert.equal(r.status, 200);
  assert.deepEqual([r.json.expected, r.json.counted, r.json.diff, r.json.user_id], [90, 100, 10, 1]);
  const again = await post('/api/closures', { day: D, counted: 90 });
  assert.deepEqual([again.status, again.json.error], [409, 'El día ya está cerrado']);
  assert.equal((await post('/api/closures/1', { counted: 1 })).status, 404);
  assert.equal((await post('/api/closures', { day: '2026-01-21', counted: 1 }, C)).status, 403);
  assert.equal((await post('/api/closures', { day: 'x', counted: 1 })).status, 400);
  for (const day of ['2026-02-30', sqlDate('+1 day')]) assert.equal((await post('/api/closures', { day, counted: 1 })).status, 400, day);
  assert.equal(db.db.prepare('SELECT COUNT(*) AS c FROM cash_closures').get().c, 1);
  assert.equal((await post('/api/closures', { day: '2026-01-21', counted: 'a' })).status, 400);
  const list = (await get('/api/closures?month=2026-01')).json;
  assert.deepEqual(list.map(c => [c.day, c.diff]), [[D, 10]]);
  assert.equal(db.db.prepare('SELECT counted FROM cash_closures WHERE day = ?').get(D).counted, 100);
});

test('ventas rechazadas en el servidor', async () => {
  const payload = { client_uuid: 'zz', pay: 'efectivo', items: [{ product_id: 1, qty: 2, price: 3.5 }] };
  const r = await post('/api/rejected', { payload, reason: 'Producto no encontrado' }, C);
  assert.equal(r.status, 200);
  const list = (await report('2026-01-10')).rejected;
  assert.equal(list.length, 1);
  assert.deepEqual([list[0].user_name, list[0].reason, list[0].total, list[0].items], ['Cajero', 'Producto no encontrado', 7, 1]);
  assert.equal((await post('/api/rejected', { payload: { x: 'a'.repeat(100001) }, reason: 'x' }, C)).status, 413);
  assert.equal((await post('/api/rejected', { reason: 'x' }, C)).status, 400);
  assert.equal((await post(`/api/rejected/${list[0].id}/reviewed`, {}, C)).status, 403);
  assert.equal((await post(`/api/rejected/${list[0].id}/reviewed`, {})).status, 200);
  assert.deepEqual((await report('2026-01-10')).rejected, []);
});

test('reporte mensual: ventas, costo, merma y compras', async () => {
  const cat = await category('M');
  const p = await product({ cat_id: cat, price: 10, cost: 6 });
  await stock(p.id, 10);
  sale('2026-03-04', 'efectivo', [{ product_id: p.id, qty: 1 }]);
  await stock(p.id, -1);
  const d = (await post('/api/deliveries', { payment: 'pendiente', items: [{ product_id: p.id, qty: 5, unit_cost: 6 }] }, C)).json;
  q("UPDATE stock_moves SET created_at = '2026-03-05 10:00:00' WHERE product_id = ? AND qty < 0", p.id);
  q("UPDATE deliveries SET at = '2026-03-06 10:00:00' WHERE id = ?", d.id);
  await post('/api/closures', { day: '2026-03-04', counted: 12 });
  await post('/api/closures', { day: '2026-03-05', counted: 3 });
  const r = (await get('/api/report/monthly?month=2026-03')).json;
  assert.deepEqual(r.by_category, [{ name: 'M', sales: 10, cogs: 6, shrink: 6, profit: -2, margin_pct: -20 }]);
  assert.deepEqual(r.totals, { sales: 10, cogs: 6, shrink: 6, profit: -2, margin_pct: -20, purchases: 30, closures_diff: 5 });
  const empty = (await get('/api/report/monthly?month=2000-01')).json;
  assert.deepEqual(empty, { by_category: [], totals: { sales: 0, cogs: 0, shrink: 0, profit: 0, margin_pct: 0, purchases: 0, closures_diff: 0 } });
});

test('merma neta: +10 y -10 en el mismo mes no es merma', async () => {
  const p = await product({ cat_id: await category('N1'), cost: 2 });
  await stock(p.id, 10);
  await stock(p.id, -10);
  q("UPDATE stock_moves SET created_at = '2026-04-02 10:00:00' WHERE product_id = ?", p.id);
  assert.equal((await get('/api/report/monthly?month=2026-04')).json.totals.shrink, 0);
});

test('merma neta: -3 y +1 a costo 2 es 4', async () => {
  const p = await product({ cat_id: await category('N2'), cost: 2 });
  await stock(p.id, -3);
  await stock(p.id, 1);
  q("UPDATE stock_moves SET created_at = '2026-05-02 10:00:00' WHERE product_id = ?", p.id);
  const r = (await get('/api/report/monthly?month=2026-05')).json;
  assert.deepEqual([r.by_category[0].name, r.by_category[0].shrink, r.totals.shrink], ['N2', 4, 4]);
});
