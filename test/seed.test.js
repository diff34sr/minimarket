require('./helper');
const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const db = require('../db');
const { run } = require('../seed/demo');

const one = (sql, ...a) => db.db.prepare(sql).get(...a);
const day = mod => one(`SELECT date('now','localtime','${mod}') AS d`).d;
const validEan = c => /^\d{13}$/.test(c) && [...c.slice(0, 12)].reduce((t, d, i) => t + Number(d) * (i % 2 ? 3 : 1), 0) % 10 === (10 - Number(c[12])) % 10;

before(() => {
  process.env.RECEIPTS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-receipts-'));
  run(db);
});

test('crea 40 productos, 8 categorías y 14 días de ventas', () => {
  assert.equal(one('SELECT COUNT(*) AS n FROM products').n, 40);
  assert.equal(one('SELECT COUNT(*) AS n FROM categories').n, 8);
  assert.equal(one('SELECT COUNT(DISTINCT date(created_at)) AS n FROM sales').n, 14);
  assert.equal(one('SELECT COUNT(*) AS n FROM cash_closures').n, 14);
  assert.equal(one('SELECT COUNT(*) AS n FROM suppliers').n, 3);
});

test('códigos: todos EAN-13 válidos, 4 productos sin código, 3 ask_qty, 4 kg', () => {
  const codes = db.db.prepare('SELECT barcode FROM products WHERE barcode IS NOT NULL').all().map(r => r.barcode);
  assert.ok(codes.length >= 30);
  assert.ok(codes.every(validEan));
  assert.equal(one('SELECT COUNT(*) AS n FROM products WHERE barcode IS NULL').n, 4);
  assert.equal(one('SELECT COUNT(*) AS n FROM products WHERE ask_qty = 1').n, 3);
  assert.equal(one("SELECT COUNT(*) AS n FROM products WHERE unit = 'kg'").n, 4);
});

test('correrlo otra vez no duplica nada', () => {
  run(db);
  assert.equal(one('SELECT COUNT(*) AS n FROM products').n, 40);
  assert.equal(one('SELECT COUNT(*) AS n FROM deliveries').n, 7);
});

test('report de los 14 días trae datos para todo Administración', () => {
  const r = db.report(day('-14 day'), day('-1 day'));
  assert.equal(r.top_profit.length, 10);
  assert.ok(r.low_stock.length > 0);
  assert.ok(r.count_diffs.length >= 2);
  assert.ok(r.expiring.length >= 1);
  assert.equal(r.to_review.length, 2);
  assert.ok(r.pending_receipts > 0);
  assert.ok(r.by_pay.qr > 0);
});

test('monthly: compras, merma y ventas sobre costo', () => {
  const months = [...new Set([day('-15 day'), day('+0 day')].map(d => d.slice(0, 7)))].map(m => db.monthly(m).totals);
  const t = k => months.reduce((s, m) => s + m[k], 0);
  assert.ok(t('purchases') > 0);
  assert.ok(t('shrink') > 0);
  assert.ok(t('sales') > t('cogs'));
});

test('sin DB_PATH el script sale con error y no crea minimarket.db', () => {
  const real = path.join(__dirname, '../minimarket.db');
  const existed = fs.existsSync(real);
  const { DB_PATH, ...env } = process.env;
  const r = spawnSync(process.execPath, [path.join(__dirname, '../seed/demo.js')], { env, encoding: 'utf8' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /DB_PATH/);
  assert.equal(fs.existsSync(real), existed);
});
