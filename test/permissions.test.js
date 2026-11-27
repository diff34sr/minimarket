const { start } = require('./helper');
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

let app;
before(async () => { app = await start(); });
after(() => app.stop());

const req = async (route, token) => {
  const [method, path] = route.split(' ');
  const res = await fetch(app.base + path, {
    method,
    headers: { 'content-type': 'application/json', ...(token && { 'x-token': token }) },
    body: method === 'POST' ? '{}' : undefined,
  });
  return res.status;
};

const adminOnly = ['GET /api/sales', 'POST /api/sales/1/void', 'POST /api/cash/1/void', 'GET /api/report', 'GET /api/report/monthly', 'POST /api/closures', 'GET /api/closures', 'POST /api/deliveries/1/void', 'POST /api/products/1/reviewed', 'GET /api/deliveries', 'POST /api/stock/adjust', 'GET /api/users', 'POST /api/users', 'POST /api/categories', 'POST /api/categories/1/delete', 'POST /api/rejected/1/reviewed', 'GET /receipts/1.jpg'];
const cashier = ['GET /api/catalog', 'POST /api/products', 'POST /api/deliveries', 'GET /api/suppliers', 'POST /api/suppliers', 'GET /api/cart', 'POST /api/cart/add', 'POST /api/cash', 'POST /api/sales', 'GET /api/receipts/pending', 'POST /api/rejected'];
const noEdit = ['POST /api/sales/1', 'POST /api/cash/1', 'POST /api/closures/1', 'POST /api/deliveries/1'];

test('rutas de solo admin: cajero 403, sin token 401, admin pasa', async () => {
  for (const route of adminOnly) {
    assert.equal(await req(route, app.tokens.cajero), 403, `${route} con cajero`);
    assert.equal(await req(route), 401, `${route} sin token`);
    const s = await req(route, app.tokens.admin);
    assert.ok(s !== 401 && s !== 403, `${route} con admin dio ${s}`);
  }
});

test('rutas del cajero: no dan 401 ni 403', async () => {
  for (const route of cashier) {
    const s = await req(route, app.tokens.cajero);
    assert.ok(s !== 401 && s !== 403, `${route} con cajero dio ${s}`);
  }
});

test('no existe ruta que edite ventas, dinero, cierres ni entregas', async () => {
  for (const route of noEdit) {
    assert.equal(await req(route, app.tokens.admin), 404, route);
  }
});
