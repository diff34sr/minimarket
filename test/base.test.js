const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { start } = require('./helper');

let app;
before(async () => { app = await start(); });
after(() => app.stop());

test('login con PIN 1234 da rol admin', async () => {
  const r = await app.call('/api/login', { body: { pin: '1234' } });
  assert.equal(r.status, 200);
  assert.equal(r.json.user.role, 'admin');
});

test('PIN 9999 da 401', async () => {
  assert.equal((await app.call('/api/login', { body: { pin: '9999' } })).status, 401);
});

test('GET /api/users sin token da 401', async () => {
  assert.equal((await app.call('/api/users')).status, 401);
});

test('GET /api/users como cajero da 403', async () => {
  assert.equal((await app.call('/api/users', { token: app.tokens.cajero })).status, 403);
});

test('GET /../db.js da 404', async () => {
  assert.equal((await fetch(app.base + '/../db.js')).status, 404);
});

test('GET / sirve el lanzador', async () => {
  const res = await fetch(app.base + '/');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/html/);
});
