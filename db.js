const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');
const db = new DatabaseSync(process.env.DB_PATH || __dirname + '/minimarket.db');
db.exec('PRAGMA foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  pin TEXT UNIQUE NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('admin', 'cajero'))
);
CREATE TABLE IF NOT EXISTS categories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  sort INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS products (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  barcode TEXT UNIQUE,
  name TEXT NOT NULL,
  brand TEXT DEFAULT '',
  cat_id INTEGER REFERENCES categories(id),
  unit TEXT NOT NULL DEFAULT 'u' CHECK(unit IN ('u','kg')),
  price REAL NOT NULL,
  cost REAL NOT NULL DEFAULT 0,
  stock REAL NOT NULL DEFAULT 0,
  ask_qty INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  min_stock REAL NOT NULL DEFAULT 5,
  created_by INTEGER,
  reviewed_at TEXT
);
CREATE TABLE IF NOT EXISTS stock_moves (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id INTEGER NOT NULL REFERENCES products(id),
  type TEXT NOT NULL CHECK(type IN ('ajuste','conteo')),
  qty REAL NOT NULL,
  cost REAL NOT NULL,
  note TEXT,
  user_id INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE TABLE IF NOT EXISTS sales (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_uuid TEXT UNIQUE NOT NULL,
  user_id INTEGER NOT NULL,
  pay TEXT NOT NULL CHECK(pay IN ('efectivo','qr')),
  total REAL NOT NULL,
  price_mismatch INTEGER NOT NULL DEFAULT 0,
  receipt TEXT,
  status TEXT NOT NULL DEFAULT 'pagado' CHECK(status IN ('pagado','anulado')),
  voided_by INTEGER,
  voided_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE TABLE IF NOT EXISTS sale_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sale_id INTEGER NOT NULL REFERENCES sales(id),
  product_id INTEGER NOT NULL REFERENCES products(id),
  name TEXT NOT NULL,
  unit TEXT NOT NULL,
  qty REAL NOT NULL,
  price REAL NOT NULL,
  cost REAL NOT NULL,
  subtotal REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS price_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id INTEGER NOT NULL REFERENCES products(id),
  field TEXT NOT NULL CHECK(field IN ('price','cost')),
  old REAL NOT NULL,
  new REAL NOT NULL,
  user_id INTEGER NOT NULL,
  at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE TABLE IF NOT EXISTS carts (
  user_id INTEGER PRIMARY KEY,
  items TEXT NOT NULL DEFAULT '[]',
  version INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS cash_moves (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL CHECK(type IN ('gasto','ingreso')),
  amount REAL NOT NULL,
  note TEXT NOT NULL,
  user_id INTEGER NOT NULL,
  voided_by INTEGER,
  voided_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE TABLE IF NOT EXISTS suppliers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  phone TEXT DEFAULT '',
  note TEXT DEFAULT '',
  active INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS deliveries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  supplier_id INTEGER REFERENCES suppliers(id),
  payment TEXT NOT NULL CHECK(payment IN ('efectivo_caja','qr_dueno','pendiente')),
  total REAL NOT NULL,
  note TEXT,
  cash_move_id INTEGER REFERENCES cash_moves(id),
  user_id INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'ok' CHECK(status IN ('ok','anulada')),
  voided_by INTEGER,
  voided_at TEXT,
  at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE TABLE IF NOT EXISTS delivery_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  delivery_id INTEGER NOT NULL REFERENCES deliveries(id),
  product_id INTEGER NOT NULL REFERENCES products(id),
  qty REAL NOT NULL,
  unit_cost REAL NOT NULL,
  prev_cost REAL NOT NULL,
  expires_at TEXT,
  counted REAL,
  diff REAL
);
CREATE TABLE IF NOT EXISTS cash_closures (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  day TEXT NOT NULL UNIQUE,
  expected REAL NOT NULL,
  counted REAL NOT NULL,
  diff REAL NOT NULL,
  note TEXT,
  user_id INTEGER NOT NULL,
  at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE TABLE IF NOT EXISTS rejected_sales (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  payload TEXT NOT NULL,
  reason TEXT NOT NULL,
  user_id INTEGER NOT NULL,
  reviewed_by INTEGER,
  reviewed_at TEXT,
  at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
`);

const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };
const isNum = v => typeof v === 'number' && Number.isFinite(v);
const round2 = x => Math.round(x * 100) / 100;
const round3 = x => Math.round(x * 1000) / 1000;
const round4 = x => Math.round(x * 1e4) / 1e4;

function tx(fn) {
  db.exec('BEGIN');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

const sum = (rows, f) => round2(rows.reduce((t, r) => t + f(r), 0));
const pct = (profit, sales) => sales ? Math.round(profit / sales * 1000) / 10 : 0;
const NO_CAT = 'Sin categoría';

const unitQty = (p, qty) => {
  if (p.unit === 'kg') return Math.round(qty * 1000) / 1000;
  if (!Number.isInteger(qty)) fail(400, 'Cantidad inválida');
  return qty;
};

const getProduct = id => db.prepare('SELECT * FROM products WHERE id = ?').get(id) || fail(404, 'Producto no encontrado');

const lineSubtotal = (price, qty) => Math.round(Math.round(price * 100) * qty) / 100;

const cartQty = (p, qty) => {
  if (!isNum(qty)) fail(400, 'Cantidad inválida');
  return unitQty(p, qty);
};

const readCart = user_id => db.prepare('SELECT items, version FROM carts WHERE user_id = ?').get(user_id) || { items: '[]', version: 0 };

const writeCart = (user_id, items) => {
  db.prepare(`INSERT INTO carts (user_id, items, version) VALUES (?, ?, 1)
    ON CONFLICT(user_id) DO UPDATE SET items = excluded.items, version = version + 1`).run(user_id, JSON.stringify(items));
  return getCart(user_id);
};

function getCart(user_id) {
  const { items, version } = readCart(user_id);
  const rows = JSON.parse(items).map(({ product_id, qty }) => {
    const p = getProduct(product_id);
    return { product_id, name: p.name, unit: p.unit, price: p.price, ask_qty: p.ask_qty, qty, subtotal: lineSubtotal(p.price, qty) };
  });
  return { version, items: rows, total: Math.round(rows.reduce((t, r) => t + r.subtotal, 0) * 100) / 100 };
}

const cartItems = user_id => JSON.parse(readCart(user_id).items);

function getSale(id) {
  const sale = db.prepare('SELECT * FROM sales WHERE id = ?').get(id) || fail(404, 'Venta no encontrada');
  return { ...sale, items: db.prepare('SELECT * FROM sale_items WHERE sale_id = ? ORDER BY id').all(id) };
}

const LOCAL_DATE = /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/;

function insertSale({ client_uuid, user_id, pay, items, created_at }) {
  if (typeof client_uuid !== 'string' || !client_uuid) fail(400, 'client_uuid requerido');
  const existing = db.prepare('SELECT id FROM sales WHERE client_uuid = ?').get(client_uuid);
  if (existing) return getSale(existing.id);
  if (!['efectivo', 'qr'].includes(pay)) fail(400, 'Medio de pago inválido');
  if (!Array.isArray(items) || !items.length) fail(400, 'Venta sin ítems');
  const merged = new Map();
  let mismatch = 0;
  for (const it of items) {
    if (it.price !== undefined && it.price !== null && (!isNum(it.price) || it.price < 0)) fail(400, 'Precio inválido');
    const p = getProduct(it.product_id);
    const qty = cartQty(p, it.qty);
    if (qty <= 0) fail(400, 'Cantidad inválida');
    if (it.price != null && Math.round(it.price * 100) !== Math.round(p.price * 100)) mismatch = 1;
    const m = merged.get(p.id) || { p, qty: 0 };
    m.qty = unitQty(p, m.qty + qty);
    merged.set(p.id, m);
  }
  const lines = [...merged.values()].map(({ p, qty }) => ({ p, qty, subtotal: lineSubtotal(p.price, qty) }));
  const total = Math.round(lines.reduce((t, l) => t + l.subtotal, 0) * 100) / 100;
  const { id } = db.prepare('INSERT INTO sales (client_uuid, user_id, pay, total, price_mismatch, created_at) VALUES (?, ?, ?, ?, ?, COALESCE(?, datetime(\'now\',\'localtime\'))) RETURNING id')
    .get(client_uuid, user_id, pay, total, mismatch, LOCAL_DATE.test(created_at) ? created_at : null);
  for (const { p, qty, subtotal } of lines) {
    db.prepare('INSERT INTO sale_items (sale_id, product_id, name, unit, qty, price, cost, subtotal) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, p.id, p.name, p.unit, qty, p.price, p.cost, subtotal);
    db.prepare('UPDATE products SET stock = stock - ? WHERE id = ?').run(qty, p.id);
  }
  return getSale(id);
}

const logPriceChange = (product_id, field, old, new_, user_id) =>
  db.prepare('INSERT INTO price_log (product_id, field, old, new, user_id) VALUES (?, ?, ?, ?, ?)').run(product_id, field, old, new_, user_id);

const dayOf = date => LOCAL_DATE.test(date + ' 00:00:00') ? date : db.prepare("SELECT date('now','localtime') AS d").get().d;

const monthOf = m => /^\d{4}-\d\d$/.test(m) ? m : dayOf().slice(0, 7);

const receiptsDir = () => process.env.RECEIPTS_DIR || path.join(__dirname, 'receipts');

const getDelivery = id => {
  const d = db.prepare(`SELECT d.*, u.name AS user, s.name AS supplier FROM deliveries d LEFT JOIN users u ON u.id = d.user_id
    LEFT JOIN suppliers s ON s.id = d.supplier_id WHERE d.id = ?`).get(id) || fail(404, 'Entrega no encontrada');
  return { ...d, items: db.prepare('SELECT i.*, p.name AS product FROM delivery_items i JOIN products p ON p.id = i.product_id WHERE i.delivery_id = ? ORDER BY i.id').all(id) };
};

const cashMove = id => db.prepare('SELECT * FROM cash_moves WHERE id = ?').get(id) || fail(404, 'Movimiento no encontrado');

if (db.prepare('SELECT COUNT(*) AS count FROM users').get().count === 0) {
  db.exec(`INSERT INTO users (name, pin, role) VALUES ('Admin', '1234', 'admin'), ('Cajero', '0000', 'cajero')`);
}

module.exports = {
  db,
  logPriceChange,
  lineSubtotal,
  getCart,
  getSale,
  receiptsDir,

  cartAdd(user_id, { product_id, barcode, qty = 1 }) {
    const p = barcode !== undefined && product_id === undefined
      ? db.prepare('SELECT * FROM products WHERE barcode = ?').get(String(barcode)) || fail(404, 'Producto no registrado')
      : getProduct(product_id);
    return tx(() => {
      const items = cartItems(user_id);
      const cur = items.find(i => i.product_id === p.id);
      const q = unitQty(p, (cur?.qty ?? 0) + cartQty(p, qty));
      if (q <= 0) fail(400, 'Cantidad inválida');
      if (cur) cur.qty = q; else items.push({ product_id: p.id, qty: q });
      return writeCart(user_id, items);
    });
  },

  cartSet(user_id, { product_id, qty }) {
    const p = getProduct(product_id);
    const q = cartQty(p, qty);
    return tx(() => {
      const items = cartItems(user_id).filter(i => i.product_id !== p.id);
      if (q > 0) items.push({ product_id: p.id, qty: q });
      return writeCart(user_id, items);
    });
  },

  cartClear(user_id) {
    return writeCart(user_id, []);
  },

  createSale(input) {
    return tx(() => insertSale(input));
  },

  checkout(user_id, { pay, client_uuid }) {
    if (typeof client_uuid !== 'string' || !client_uuid) fail(400, 'client_uuid requerido');
    return tx(() => {
      const existing = db.prepare('SELECT id FROM sales WHERE client_uuid = ?').get(client_uuid);
      if (existing) return getSale(existing.id);
      const items = cartItems(user_id);
      if (!items.length) fail(400, 'Carrito vacío');
      const sale = insertSale({ client_uuid, user_id, pay, items });
      writeCart(user_id, []);
      return sale;
    });
  },

  listSales(date) {
    return db.prepare(`SELECT s.*, u.name AS user, v.name AS voided_by_name FROM sales s LEFT JOIN users u ON u.id = s.user_id
      LEFT JOIN users v ON v.id = s.voided_by WHERE date(s.created_at) = ? ORDER BY s.id DESC`).all(dayOf(date))
      .map(s => ({ ...s, items: db.prepare('SELECT * FROM sale_items WHERE sale_id = ? ORDER BY id').all(s.id) }));
  },

  voidSale(id, user_id) {
    return tx(() => {
      const sale = getSale(id);
      if (sale.status === 'anulado') fail(409, 'La venta ya está anulada');
      for (const it of sale.items) db.prepare('UPDATE products SET stock = stock + ? WHERE id = ?').run(it.qty, it.product_id);
      db.prepare("UPDATE sales SET status = 'anulado', voided_by = ?, voided_at = datetime('now','localtime') WHERE id = ?").run(user_id, id);
      return getSale(id);
    });
  },

  attachReceipt(id, dataUrl) {
    const sale = getSale(id);
    if (sale.pay !== 'qr' || sale.receipt || sale.status !== 'pagado') fail(409, 'No se puede adjuntar comprobante');
    const m = /^data:image\/(?:jpeg|png);base64,/.exec(typeof dataUrl === 'string' ? dataUrl : '');
    const bytes = m && Buffer.from(dataUrl.slice(m[0].length), 'base64');
    if (!bytes?.length) fail(400, 'Imagen inválida');
    fs.mkdirSync(receiptsDir(), { recursive: true });
    fs.writeFileSync(path.join(receiptsDir(), `${id}.jpg`), bytes);
    db.prepare('UPDATE sales SET receipt = ? WHERE id = ?').run(`receipts/${id}.jpg`, id);
    return getSale(id);
  },

  pendingReceipts() {
    return db.prepare("SELECT * FROM sales WHERE pay = 'qr' AND receipt IS NULL AND status = 'pagado' ORDER BY id").all();
  },

  addCash({ type, amount, note, user_id }) {
    if (!['gasto', 'ingreso'].includes(type)) fail(400, 'Tipo inválido');
    if (!isNum(amount) || amount <= 0) fail(400, 'Monto inválido');
    note = String(note ?? '').trim();
    if (!note) fail(400, 'Comentario requerido');
    return db.prepare('INSERT INTO cash_moves (type, amount, note, user_id) VALUES (?, ?, ?, ?) RETURNING *').get(type, amount, note, user_id);
  },

  listCash(date) {
    return db.prepare(`SELECT c.*, u.name AS user FROM cash_moves c LEFT JOIN users u ON u.id = c.user_id
      WHERE date(c.created_at) = ? ORDER BY c.id DESC`).all(dayOf(date));
  },

  voidCash(id, user_id) {
    if (cashMove(id).voided_at) fail(409, 'El movimiento ya está anulado');
    if (db.prepare("SELECT 1 FROM deliveries WHERE cash_move_id = ? AND status = 'ok'").get(id)) fail(409, 'Anule la entrega');
    db.prepare("UPDATE cash_moves SET voided_by = ?, voided_at = datetime('now','localtime') WHERE id = ?").run(user_id, id);
    return cashMove(id);
  },

  login(pin) {
    return db.prepare('SELECT id, name, role FROM users WHERE pin = ?').get(pin);
  },

  listUsers() {
    return db.prepare('SELECT id, name, role FROM users ORDER BY name').all();
  },

  saveUser({ id, name, pin, role }) {
    if ((pin || !id) && !/^\d{4}$/.test(pin || '')) throw Object.assign(new Error('PIN debe tener 4 dígitos'), { status: 400 });
    if (!['admin', 'cajero'].includes(role)) throw Object.assign(new Error('Rol inválido'), { status: 400 });

    if (id) {
      try {
        db.prepare('UPDATE users SET name = ?, pin = COALESCE(?, pin), role = ? WHERE id = ?').run(name, pin || null, role, id);
      } catch (e) {
        throw /UNIQUE/.test(e.message) ? Object.assign(new Error('Ese PIN ya está en uso'), { status: 409 }) : e;
      }
      return db.prepare('SELECT id, name, role FROM users WHERE id = ?').get(id);
    } else {
      try {
        return db.prepare('INSERT INTO users (name, pin, role) VALUES (?, ?, ?) RETURNING id, name, role').get(name, pin, role);
      } catch (e) {
        throw /UNIQUE/.test(e.message) ? Object.assign(new Error('Ese PIN ya está en uso'), { status: 409 }) : e;
      }
    }
  },

  catalog() {
    return {
      categories: db.prepare('SELECT * FROM categories ORDER BY sort, name').all(),
      products: db.prepare('SELECT * FROM products ORDER BY cat_id, name').all()
    };
  },

  saveProduct(input, user) {
    const cur = input.id ? getProduct(input.id) : { unit: 'u', cost: 0, ask_qty: 0, active: 1, min_stock: 5 };
    const { id, barcode, name: rawName, brand, cat_id, unit, price: rawPrice, cost: rawCost, ask_qty, active, min_stock } = { ...cur, ...Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined)) };
    const name = String(rawName ?? '').trim();
    if (!name) fail(400, 'Nombre requerido');
    if (!['u', 'kg'].includes(unit)) fail(400, 'Unidad inválida');
    if (!isNum(rawPrice) || rawPrice < 0) fail(400, 'Precio inválido');
    if (!isNum(rawCost) || rawCost < 0) fail(400, 'Costo inválido');
    if (!isNum(min_stock) || min_stock < 0) fail(400, 'Stock mínimo inválido');
    const price = Math.round(rawPrice * 100) / 100;
    const cost = Math.round(rawCost * 10000) / 10000;
    const flag = v => [1, true, '1'].includes(v) ? 1 : 0;
    const vals = [String(barcode ?? '').trim() || null, name, String(brand ?? '').trim(), cat_id === '' ? null : cat_id ?? null, unit, price, cost, flag(ask_qty), flag(active), min_stock];
    try {
      if (id) {
        const next = { price, cost, unit, barcode: vals[0], active: vals[8] };
        if (user.role !== 'admin' && Object.keys(next).some(f => next[f] !== cur[f])) fail(403, 'Solo admin cambia precio, costo, unidad, código o estado');
        const changed = ['price', 'cost'].filter(f => next[f] !== cur[f]);
        return tx(() => {
          db.prepare('UPDATE products SET barcode = ?, name = ?, brand = ?, cat_id = ?, unit = ?, price = ?, cost = ?, ask_qty = ?, active = ?, min_stock = ? WHERE id = ?').run(...vals, id);
          for (const f of changed) logPriceChange(id, f, cur[f], next[f], user.id);
          return getProduct(id);
        });
      }
      return db.prepare("INSERT INTO products (barcode, name, brand, cat_id, unit, price, cost, ask_qty, active, min_stock, created_by, reviewed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CASE WHEN ? THEN datetime('now','localtime') END) RETURNING *").get(...vals, user.id, user.role === 'admin' ? 1 : 0);
    } catch (e) {
      if (/UNIQUE/.test(e.message)) fail(409, 'Ese código ya existe');
      if (/FOREIGN KEY/.test(e.message)) fail(400, 'Categoría inválida');
      throw e;
    }
  },

  saveCategory({ id, name, sort }) {
    sort ??= 0;
    name = String(name ?? '').trim();
    if (!name) fail(400, 'Nombre requerido');
    if (!Number.isInteger(sort)) fail(400, 'Orden inválido');
    try {
      if (id) {
        db.prepare('UPDATE categories SET name = ?, sort = ? WHERE id = ?').run(name, sort, id);
        return db.prepare('SELECT * FROM categories WHERE id = ?').get(id) || fail(404, 'Categoría no encontrada');
      }
      return db.prepare('INSERT INTO categories (name, sort) VALUES (?, ?) RETURNING *').get(name, sort);
    } catch (e) {
      throw /UNIQUE/.test(e.message) ? Object.assign(new Error('Esa categoría ya existe'), { status: 409 }) : e;
    }
  },

  deleteCategory(id) {
    if (db.prepare('SELECT 1 FROM products WHERE cat_id = ?').get(id)) fail(409, 'La categoría tiene productos');
    db.prepare('DELETE FROM categories WHERE id = ?').run(id);
  },

  stockAdjust({ product_id, qty, note, user_id }) {
    if (!isNum(qty)) fail(400, 'Cantidad inválida');
    note = String(note ?? '').trim();
    if (!note) fail(400, 'Motivo requerido');
    return tx(() => {
      qty = unitQty(getProduct(product_id), qty);
      if (qty === 0) fail(400, 'Cantidad inválida');
      db.prepare('UPDATE products SET stock = stock + ? WHERE id = ?').run(qty, product_id);
      db.prepare("INSERT INTO stock_moves (product_id, type, qty, cost, note, user_id) SELECT id, 'ajuste', ?, cost, ?, ? FROM products WHERE id = ?").run(qty, note, user_id, product_id);
      return getProduct(product_id);
    });
  },

  markReviewed(id) {
    getProduct(id);
    db.prepare("UPDATE products SET reviewed_at = datetime('now','localtime') WHERE id = ?").run(id);
    return getProduct(id);
  },

  saveSupplier({ id, name, phone, note, active }) {
    const cur = id ? db.prepare('SELECT * FROM suppliers WHERE id = ?').get(id) || fail(404, 'Proveedor no encontrado') : { phone: '', note: '', active: 1 };
    name = String(name ?? cur.name ?? '').trim();
    if (!name) fail(400, 'Nombre requerido');
    const vals = [name, String(phone ?? cur.phone).trim(), String(note ?? cur.note).trim(), [1, true, '1'].includes(active ?? cur.active) ? 1 : 0];
    if (id) {
      db.prepare('UPDATE suppliers SET name = ?, phone = ?, note = ?, active = ? WHERE id = ?').run(...vals, id);
      return db.prepare('SELECT * FROM suppliers WHERE id = ?').get(id);
    }
    return db.prepare('INSERT INTO suppliers (name, phone, note, active) VALUES (?, ?, ?, ?) RETURNING *').get(...vals);
  },

  listSuppliers(all) {
    return db.prepare(`SELECT * FROM suppliers ${all ? '' : 'WHERE active = 1'} ORDER BY name`).all();
  },

  delivery({ supplier_id, payment, note, items }, user_id) {
    if (!['efectivo_caja', 'qr_dueno', 'pendiente'].includes(payment)) fail(400, 'Medio de pago inválido');
    if (!Array.isArray(items) || !items.length) fail(400, 'Entrega sin ítems');
    return tx(() => {
      const supplier = supplier_id == null ? null : db.prepare('SELECT * FROM suppliers WHERE id = ?').get(supplier_id) || fail(400, 'Proveedor inválido');
      const lines = items.map(it => {
        const p = getProduct(it?.product_id);
        if (!isNum(it.qty)) fail(400, 'Cantidad inválida');
        const qty = unitQty(p, it.qty);
        if (qty <= 0) fail(400, 'Cantidad inválida');
        if (!isNum(it.unit_cost) || it.unit_cost < 0) fail(400, 'Costo inválido');
        const expires_at = it.expires_at ?? null;
        if (expires_at !== null && !(/^\d{4}-\d\d-\d\d$/.test(expires_at) && !Number.isNaN(Date.parse(expires_at)))) fail(400, 'Vencimiento inválido');
        const counted = it.counted ?? null;
        if (counted !== null && (!isNum(counted) || counted < 0)) fail(400, 'Conteo inválido');
        return { product_id: p.id, qty, unit_cost: it.unit_cost, expires_at, counted: counted === null ? null : unitQty(p, counted) };
      });
      const total = round2(lines.reduce((t, l) => t + l.qty * l.unit_cost, 0));
            const { id } = db.prepare('INSERT INTO deliveries (supplier_id, payment, total, note, user_id) VALUES (?, ?, ?, ?, ?) RETURNING id')
        .get(supplier?.id ?? null, payment, total, String(note ?? '').trim() || null, user_id);
      for (const l of lines) {
        const p = getProduct(l.product_id);
        let stock = p.stock;
        let diff = null;
        if (l.counted !== null) {
          diff = round3(l.counted - stock);
          if (diff !== 0) db.prepare("INSERT INTO stock_moves (product_id, type, qty, cost, note, user_id) VALUES (?, 'conteo', ?, ?, ?, ?)").run(p.id, diff, p.cost, `Conteo en entrega #${id}`, user_id);
          stock = l.counted;
        }
        const base = Math.max(stock, 0);
        const newCost = round4((base * p.cost + l.qty * l.unit_cost) / (base + l.qty));
        if (newCost !== p.cost) logPriceChange(p.id, 'cost', p.cost, newCost, user_id);
        db.prepare('UPDATE products SET stock = ?, cost = ? WHERE id = ?').run(round3(stock + l.qty), newCost, p.id);
        db.prepare('INSERT INTO delivery_items (delivery_id, product_id, qty, unit_cost, prev_cost, expires_at, counted, diff) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
          .run(id, p.id, l.qty, l.unit_cost, p.cost, l.expires_at, l.counted, diff);
      }
      if (payment === 'efectivo_caja' && total > 0) {
        const { id: cash } = db.prepare("INSERT INTO cash_moves (type, amount, note, user_id) VALUES ('gasto', ?, ?, ?) RETURNING id").get(total, supplier?.name || `Entrega #${id}`, user_id);
        db.prepare('UPDATE deliveries SET cash_move_id = ? WHERE id = ?').run(cash, id);
      }
      return getDelivery(id);
    });
  },

  voidDelivery(id, user_id) {
    return tx(() => {
      const d = getDelivery(id);
      if (d.status === 'anulada') fail(409, 'La entrega ya está anulada');
      for (const it of [...d.items].reverse()) {
        const p = getProduct(it.product_id);
        const last = !db.prepare("SELECT 1 FROM delivery_items i JOIN deliveries x ON x.id = i.delivery_id WHERE i.product_id = ? AND x.status = 'ok' AND x.id > ?").get(it.product_id, id);
        // shortcut: el promedio no se deshace si hubo entregas posteriores; recalcular desde delivery_items si hace falta
        const cost = last ? it.prev_cost : p.cost;
        if (cost !== p.cost) logPriceChange(p.id, 'cost', p.cost, cost, user_id);
        db.prepare('UPDATE products SET stock = ?, cost = ? WHERE id = ?').run(round3(p.stock - it.qty), cost, p.id);
      }
      db.prepare("UPDATE deliveries SET status = 'anulada', voided_by = ?, voided_at = datetime('now','localtime') WHERE id = ?").run(user_id, id);
      if (d.cash_move_id) db.prepare("UPDATE cash_moves SET voided_by = ?, voided_at = datetime('now','localtime') WHERE id = ? AND voided_at IS NULL").run(user_id, d.cash_move_id);
      return getDelivery(id);
    });
  },

  listDeliveries({ from, to } = {}) {
    return db.prepare('SELECT id FROM deliveries WHERE date(at) BETWEEN ? AND ? ORDER BY id DESC').all(dayOf(from), dayOf(to)).map(r => getDelivery(r.id));
  },

  report(from, to) {
    from = dayOf(from);
    to = dayOf(to);
    const lines = db.prepare(`SELECT i.product_id, i.name, i.qty, i.cost, i.subtotal AS total, p.cat_id, c.name AS cat_name
      FROM sale_items i JOIN sales s ON s.id = i.sale_id LEFT JOIN products p ON p.id = i.product_id LEFT JOIN categories c ON c.id = p.cat_id
      WHERE s.status = 'pagado' AND date(s.created_at) BETWEEN ? AND ?`).all(from, to).map(l => ({ ...l, margin: l.total - lineSubtotal(l.cost, l.qty) }));
    const sales = db.prepare("SELECT s.pay, s.total, s.user_id, u.name AS user_name FROM sales s LEFT JOIN users u ON u.id = s.user_id WHERE s.status = 'pagado' AND date(s.created_at) BETWEEN ? AND ?").all(from, to)
      .map(s => ({ ...s, qty: 0, margin: 0 }));
    // shortcut: categoría actual del producto; recategorizar reescribe la historia. Guardar cat en sale_items si pasa a importar
    const group = (rows, key, init) => {
      const m = new Map();
      for (const r of rows) {
        const g = m.get(key(r)) || m.set(key(r), { ...init(r), qty: 0, total: 0, margin: 0 }).get(key(r));
        g.qty += r.qty;
        g.total += r.total;
        g.margin += r.margin;
      }
      return [...m.values()].map(g => ({ ...g, qty: round3(g.qty), total: round2(g.total), margin: round2(g.margin) })).sort((a, b) => b.total - a.total);
    };
    const sold = new Set(lines.map(l => l.product_id));
    const by_product = group(lines, l => l.product_id, l => ({ product_id: l.product_id, name: l.name }));
    const by_pay = { efectivo: 0, qr: 0 };
    for (const s of sales) by_pay[s.pay] += s.total;
    by_pay.efectivo = round2(by_pay.efectivo);
    by_pay.qr = round2(by_pay.qr);
    const cashSum = type => db.prepare("SELECT COALESCE(SUM(amount), 0) AS t FROM cash_moves WHERE type = ? AND voided_at IS NULL AND date(created_at) BETWEEN ? AND ?").get(type, from, to).t;
    const gastos = round2(cashSum('gasto'));
    const ingresos = round2(cashSum('ingreso'));
    const rejected = db.prepare('SELECT r.id, r.at, r.reason, r.payload, u.name AS user_name FROM rejected_sales r LEFT JOIN users u ON u.id = r.user_id WHERE r.reviewed_at IS NULL ORDER BY r.id').all().map(({ payload, ...r }) => {
      let items = null, total = null;
      try {
        const list = JSON.parse(payload).items;
        items = list.length;
        total = sum(list, it => lineSubtotal(it.price, it.qty));
      } catch {}
      return { ...r, total, items };
    });
    return {
      total: sum(sales, s => s.total),
      margin: sum(lines, l => l.margin),
      by_product,
      by_user: group(sales, s => s.user_id, s => ({ name: s.user_name || 'Sin usuario' })).map(({ name, total }) => ({ name, total })),
      by_pay,
      by_category: group(lines, l => l.cat_id, l => ({ cat_id: l.cat_id, name: l.cat_name || NO_CAT })).map(({ qty, ...g }) => g),
      top_profit: [...by_product].sort((a, b) => b.margin - a.margin).slice(0, 10),
      no_sales: db.prepare('SELECT id, name, stock FROM products WHERE active = 1 ORDER BY name').all().filter(p => !sold.has(p.id)),
      low_stock: db.prepare('SELECT id, name, unit, stock, min_stock FROM products WHERE active = 1 AND stock <= min_stock ORDER BY stock, name').all(),
      // shortcut: sin lotes, el vencimiento es aproximado; rastrear lotes si las mermas por vencimiento pesan
      expiring: db.prepare(`SELECT i.product_id, p.name, i.expires_at, p.stock FROM delivery_items i JOIN deliveries d ON d.id = i.delivery_id JOIN products p ON p.id = i.product_id
        WHERE d.status = 'ok' AND i.expires_at IS NOT NULL AND i.expires_at <= date('now','localtime','+7 day') AND p.stock > 0 ORDER BY i.expires_at, p.name`).all(),
      gastos,
      ingresos,
      efectivo_esperado: round2(by_pay.efectivo + ingresos - gastos),
      pending_receipts: db.prepare("SELECT COUNT(*) AS n FROM sales WHERE pay = 'qr' AND receipt IS NULL AND status = 'pagado'").get().n,
      to_review: db.prepare('SELECT p.id, p.name, p.price, p.cost, u.name AS created_by_name FROM products p LEFT JOIN users u ON u.id = p.created_by WHERE p.reviewed_at IS NULL ORDER BY p.id').all(),
      count_diffs: db.prepare(`SELECT d.id AS delivery_id, d.at, p.name AS product, i.diff, i.prev_cost AS cost, u.name AS user_name
        FROM delivery_items i JOIN deliveries d ON d.id = i.delivery_id JOIN products p ON p.id = i.product_id LEFT JOIN users u ON u.id = d.user_id
        WHERE i.diff IS NOT NULL AND i.diff != 0 AND date(d.at) BETWEEN ? AND ? ORDER BY d.id DESC, i.id`).all(from, to),
      rejected
    };
  },

  closeDay({ day, counted, note }, user_id) {
    if (day !== undefined) {
      if (dayOf(day) !== day || db.prepare('SELECT date(?) AS d').get(day).d !== day) fail(400, 'Día inválido');
      if (day > dayOf()) fail(400, 'No se puede cerrar un día futuro');
    }
    if (!isNum(counted) || counted < 0) fail(400, 'Monto contado inválido');
    day = dayOf(day);
    return tx(() => {
      if (db.prepare('SELECT 1 FROM cash_closures WHERE day = ?').get(day)) fail(409, 'El día ya está cerrado');
      const expected = module.exports.report(day, day).efectivo_esperado;
      return db.prepare('INSERT INTO cash_closures (day, expected, counted, diff, note, user_id) VALUES (?, ?, ?, ?, ?, ?) RETURNING *')
        .get(day, expected, round2(counted), round2(counted - expected), String(note ?? '').trim() || null, user_id);
    });
  },

  listClosures(month) {
    return db.prepare("SELECT c.*, u.name AS user FROM cash_closures c LEFT JOIN users u ON u.id = c.user_id WHERE strftime('%Y-%m', c.day) = ? ORDER BY c.day").all(monthOf(month));
  },

  monthly(month) {
    month = monthOf(month);
    const rows = new Map();
    const row = name => rows.get(name) || rows.set(name, { name, sales: 0, cogs: 0, shrink: 0 }).get(name);
    const items = db.prepare(`SELECT i.qty, i.cost, i.subtotal, c.name AS cat FROM sale_items i JOIN sales s ON s.id = i.sale_id
      LEFT JOIN products p ON p.id = i.product_id LEFT JOIN categories c ON c.id = p.cat_id WHERE s.status = 'pagado' AND strftime('%Y-%m', s.created_at) = ?`).all(month);
    for (const i of items) {
      const r = row(i.cat || NO_CAT);
      r.sales += i.subtotal;
      r.cogs += lineSubtotal(i.cost, i.qty);
    }
    const moves = db.prepare(`SELECT c.name AS cat, SUM(g.shrink) AS shrink FROM
      (SELECT product_id, MAX(0, ROUND(-SUM(qty * cost), 6)) AS shrink FROM stock_moves WHERE strftime('%Y-%m', created_at) = ? GROUP BY product_id) g
      JOIN products p ON p.id = g.product_id LEFT JOIN categories c ON c.id = p.cat_id GROUP BY p.cat_id HAVING shrink > 0`).all(month);
    for (const m of moves) row(m.cat || NO_CAT).shrink += m.shrink;
    const fin = ({ name, sales, cogs, shrink }) => {
      const profit = round2(sales - cogs - shrink);
      return { name, sales: round2(sales), cogs: round2(cogs), shrink: round2(shrink), profit, margin_pct: pct(profit, round2(sales)) };
    };
    const by_category = [...rows.values()].map(fin).sort((a, b) => b.sales - a.sales);
    const t = fin(by_category.reduce((a, r) => ({ name: '', sales: a.sales + r.sales, cogs: a.cogs + r.cogs, shrink: a.shrink + r.shrink }), { name: '', sales: 0, cogs: 0, shrink: 0 }));
    const one = sql => db.prepare(sql).get(month).t;
    const { name, ...totals } = t;
    return {
      by_category,
      totals: {
        ...totals,
        purchases: round2(one("SELECT COALESCE(SUM(total), 0) AS t FROM deliveries WHERE status = 'ok' AND strftime('%Y-%m', at) = ?")),
        closures_diff: round2(one("SELECT COALESCE(SUM(diff), 0) AS t FROM cash_closures WHERE strftime('%Y-%m', day) = ?"))
      }
    };
  },

  addRejected({ payload, reason }, user_id) {
    if (payload === undefined) fail(400, 'Venta requerida');
    const text = JSON.stringify(payload);
    if (text.length > 100000) fail(413, 'Venta demasiado grande');
    return db.prepare('INSERT INTO rejected_sales (payload, reason, user_id) VALUES (?, ?, ?) RETURNING id').get(text, String(reason ?? '').slice(0, 500), user_id);
  },

  markRejected(id, user_id) {
    const r = db.prepare("UPDATE rejected_sales SET reviewed_by = COALESCE(reviewed_by, ?), reviewed_at = COALESCE(reviewed_at, datetime('now','localtime')) WHERE id = ? RETURNING id, reviewed_by, reviewed_at").get(user_id, id);
    return r || fail(404, 'Venta rechazada no encontrada');
  },

  listStockMoves(product_id) {
    return db.prepare(`SELECT m.*, p.name AS product, u.name AS user FROM stock_moves m
      JOIN products p ON p.id = m.product_id LEFT JOIN users u ON u.id = m.user_id
      WHERE (?1 IS NULL OR m.product_id = ?1) ORDER BY m.id DESC LIMIT 100`).all(product_id ?? null);
  }
};
