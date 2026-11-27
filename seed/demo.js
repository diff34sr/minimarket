const mulberry32 = seed => () => {
  seed = (seed + 0x6D2B79F5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

const CATEGORIES = ['Bebidas', 'Abarrotes', 'Lácteos', 'Panadería', 'Snacks y dulces', 'Limpieza', 'Frutas y verduras', 'Carnes'];

const SUPPLIERS = [
  ['Distribuidora Andina', '70012345', 'Entrega los martes'],
  ['Lácteos del Valle', '70023456', 'Pedido el día anterior'],
  ['Mercado Central (frutas y carnes)', '70034567', ''],
];

// [name, category, price, flag] flag: nb = sin código, ask = pide cantidad, kg = por kilo, c = creado por el cajero
const PRODUCTS = [
  ['Agua Cristal 2L', 0, 7], ['Gaseosa Cola 2L', 0, 12], ['Gaseosa Naranja 2L', 0, 11], ['Jugo de Durazno 1L', 0, 9], ['Cerveza Clara 620ml', 0, 16], ['Agua con Sabor 600ml', 0, 5],
  ['Arroz Grano de Oro 1kg', 1, 9], ['Azúcar Blanca 1kg', 1, 8], ['Fideo Spaghetti 400g', 1, 6], ['Aceite Vegetal 1L', 1, 18], ['Harina de Trigo 1kg', 1, 7], ['Sal Yodada 1kg', 1, 4], ['Fósforos Caja', 1, 1.5, 'ask'],
  ['Leche Entera 1L', 2, 9], ['Yogur Frutilla 1L', 2, 14], ['Queso Fresco 500g', 2, 22], ['Mantequilla 200g', 2, 13],
  ['Marraqueta', 3, 0.5, 'nb'], ['Salteña', 3, 6, 'nb'], ['Cuñapé', 3, 2, 'nb'], ['Empanada de Queso', 3, 5, 'nb'], ['Pan de Molde', 3, 17],
  ['Papas Fritas 90g', 4, 8], ['Galletas Rellenas', 4, 6], ['Chocolate en Barra', 4, 10], ['Caramelos Surtidos', 4, 0.5, 'ask'], ['Cigarro Suelto', 4, 1.5, 'ask'],
  ['Detergente en Polvo 1kg', 5, 22], ['Lavandina 1L', 5, 8], ['Jabón de Tocador', 5, 5], ['Papel Higiénico 4u', 5, 14], ['Esponja de Cocina', 5, 4, 'c'],
  ['Tomate', 6, 10, 'kg'], ['Papa', 6, 7, 'kg'], ['Limones Bolsa', 6, 6, 'c'], ['Zanahoria Atado', 6, 5],
  ['Carne Molida', 7, 48, 'kg'], ['Pollo Entero', 7, 22, 'kg'], ['Chorizo Parrillero 500g', 7, 25], ['Salchicha Pack 12u', 7, 18],
];

const EXPENSES = ['Bolsas y cinta', 'Pasaje de reparto', 'Luz del local', 'Artículos de limpieza', 'Reparación de la balanza', 'Agua potable'];
const TINY_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const ADMIN = { id: 1, role: 'admin' };
const CASHIER = { id: 2, role: 'cajero' };
const DAYS = 14;

const ean13 = body => {
  const sum = [...body].reduce((t, d, i) => t + Number(d) * (i % 2 ? 3 : 1), 0);
  return body + (10 - (sum % 10)) % 10;
};

function run(db) {
  const raw = db.db;
  if (raw.prepare('SELECT COUNT(*) AS n FROM products').get().n) return;

  const rng = mulberry32(42);
  const int = (a, b) => a + Math.floor(rng() * (b - a + 1));
  const pick = list => list[Math.floor(rng() * list.length)];
  const money = x => Math.round(x * 100) / 100;
  const pad = n => String(n).padStart(2, '0');
  const dayAt = n => raw.prepare("SELECT date('now','localtime', ?) AS d").get(`${n < 0 ? '+' : '-'}${Math.abs(n)} day`).d;
  const TABLES = [['deliveries', 'at'], ['cash_moves', 'created_at'], ['stock_moves', 'created_at'], ['price_log', 'at'], ['cash_closures', 'at']];
  const stamp = (when, fn) => {
    const marks = TABLES.map(([t]) => raw.prepare(`SELECT COALESCE(MAX(id), 0) AS m FROM ${t}`).get().m);
    const result = fn();
    TABLES.forEach(([t, c], i) => raw.prepare(`UPDATE ${t} SET ${c} = ? WHERE id > ?`).run(when, marks[i]));
    return result;
  };
  const stockOf = id => raw.prepare('SELECT stock FROM products WHERE id = ?').get(id).stock;

  const cats = CATEGORIES.map((name, sort) => db.saveCategory({ name, sort }).id);
  const suppliers = SUPPLIERS.map(([name, phone, note]) => db.saveSupplier({ name, phone, note }).id);

  const codes = new Set();
  const products = PRODUCTS.map(([name, cat, price, flag = '']) => {
    let barcode = null;
    if (flag !== 'nb') {
      do barcode = ean13('775' + String(int(0, 999999999)).padStart(9, '0')); while (codes.has(barcode));
      codes.add(barcode);
    }
    const cost = Math.round(price * (1 - (0.15 + rng() * 0.25)) * 1000) / 1000;
    const kg = flag === 'kg';
    const p = db.saveProduct({
      barcode, name, cat_id: cats[cat], price, cost, unit: kg ? 'kg' : 'u', ask_qty: flag === 'ask' ? 1 : 0,
      min_stock: kg ? pick([5, 8, 10]) : pick([3, 5, 8, 10, 15, 20]),
    }, flag === 'c' ? CASHIER : ADMIN);
    return { id: p.id, name, kg, ask: flag === 'ask', price, cost, weight: 0.2 + rng() ** 2 * 3 };
  });

  const qtyOf = p => {
    if (p.kg) return int(4, 30) * 50 / 1000;
    if (p.ask) return p.name.startsWith('Fósforos') ? int(1, 3) : int(2, 12);
    return rng() < 0.7 ? 1 : int(2, 3);
  };
  const totalWeight = products.reduce((t, p) => t + p.weight, 0);
  const pickWeighted = () => {
    let r = rng() * totalWeight;
    return products.find(p => (r -= p.weight) < 0) || products[products.length - 1];
  };

  const lineEstimate = DAYS * 45 * 2.2;
  stamp(`${dayAt(DAYS + 1)} 12:00:00`, () => db.delivery({
    supplier_id: suppliers[0], payment: 'pendiente', note: 'Stock inicial',
    items: products.map(p => {
      const avg = p.kg ? 0.7 : p.ask ? 5 : 1.4;
      const demand = lineEstimate * p.weight / totalWeight * avg;
      return { product_id: p.id, qty: p.kg ? Math.max(10, Math.round(demand * (0.75 + rng() * 0.8))) : Math.max(8, Math.round(demand * (0.75 + rng() * 0.8))), unit_cost: p.cost };
    }),
  }, ADMIN.id));

  const restock = (back, payment, { counted, expiring } = {}) => {
    const low = [...products].sort((a, b) => stockOf(a.id) / (a.kg ? 10 : 20) - stockOf(b.id) / (b.kg ? 10 : 20));
    const chosen = low.slice(0, payment === 'efectivo_caja' ? 2 : 4);
    const items = chosen.map(p => ({ product_id: p.id, qty: p.kg ? int(10, 20) : p.ask ? int(100, 200) : int(20, 40), unit_cost: money(p.cost * (0.97 + rng() * 0.06)) }));
    if (counted) {
      const p = low.slice(4).find(x => stockOf(x.id) >= 6);
      items.push({ product_id: p.id, qty: p.kg ? 10 : 24, unit_cost: p.cost, counted: stockOf(p.id) - int(2, 5) });
    }
    if (expiring) {
      for (const [name, days] of [['Yogur Frutilla 1L', 5], ['Leche Entera 1L', 20]]) {
        const p = products.find(x => x.name === name);
        const line = items.find(i => i.product_id === p.id) || items[items.push({ product_id: p.id, qty: 24, unit_cost: p.cost }) - 1];
        line.expires_at = dayAt(-days);
      }
    }
    stamp(`${dayAt(back)} 08:${pad(int(0, 59))}:00`, () => db.delivery({ supplier_id: suppliers[back % 3], payment, items, note: counted ? 'Con conteo' : undefined }, pick([ADMIN.id, CASHIER.id])));
  };

  const DELIVERIES = { 12: ['efectivo_caja'], 10: ['pendiente', { counted: true }], 8: ['qr_dueno', { counted: true }], 6: ['qr_dueno'], 4: ['efectivo_caja'], 2: ['pendiente', { expiring: true }] };
  const SHRINK = { 9: ['Pan de Molde', -2, 'Vencido'], 3: ['Gaseosa Cola 2L', -1, 'Botella rota'] };
  const itemsPerSale = () => { const r = rng(); return r < 0.35 ? 1 : r < 0.65 ? 2 : r < 0.83 ? 3 : r < 0.93 ? 4 : 5; };

  for (let back = DAYS; back >= 1; back--) {
    const day = dayAt(back);
    for (let i = 0, n = int(30, 60); i < n; i++) {
      const items = Array.from({ length: itemsPerSale() }, () => { const p = pickWeighted(); return { product_id: p.id, qty: qtyOf(p) }; });
      const pay = rng() < 0.7 ? 'efectivo' : 'qr';
      const withReceipt = rng() < 0.6;
      const sale = db.createSale({
        client_uuid: `demo-${back}-${i}`, user_id: rng() < 0.75 ? CASHIER.id : ADMIN.id, pay, items,
        created_at: `${day} ${pad(int(8, 21))}:${pad(int(0, 59))}:${pad(int(0, 59))}`,
      });
      if (pay === 'qr' && withReceipt && process.env.RECEIPTS_DIR) db.attachReceipt(sale.id, TINY_PNG);
    }
    if (DELIVERIES[back]) restock(back, ...DELIVERIES[back]);
    if (SHRINK[back]) {
      const [name, qty, note] = SHRINK[back];
      stamp(`${day} 19:00:00`, () => db.stockAdjust({ product_id: products.find(p => p.name === name).id, qty, note, user_id: ADMIN.id }));
    }
    if ([2, 5].includes(back % 7)) {
      stamp(`${day} 17:00:00`, () => db.addCash({ type: 'gasto', amount: int(20, 150), note: pick(EXPENSES), user_id: CASHIER.id }));
    }
    const expected = db.report(day, day).efectivo_esperado;
    stamp(`${day} 22:00:00`, () => db.closeDay({ day, counted: Math.max(0, money(expected + int(-10, 10) / 2)), note: null }, ADMIN.id));
  }
}

module.exports = { run, ean13 };

if (require.main === module) {
  if (!process.env.DB_PATH) {
    console.error('Falta DB_PATH (ej: DB_PATH=demo.db node seed/demo.js). No se toca la base real.');
    process.exit(1);
  }
  if (process.env.DB_PATH !== ':memory:') process.env.RECEIPTS_DIR ??= process.env.DB_PATH + '-receipts';
  const db = require('../db');
  const had = db.db.prepare('SELECT COUNT(*) AS n FROM products').get().n;
  run(db);
  const count = t => db.db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n;
  console.log(had ? 'La base ya tiene productos: no se hizo nada.' : `Demo cargada: ${count('products')} productos, ${count('sales')} ventas, ${count('deliveries')} entregas, ${count('cash_closures')} cierres.`);
  if (!had && process.env.DB_PATH !== ':memory:') console.log(`Comprobantes en ${process.env.RECEIPTS_DIR} (arrancar el servidor con el mismo RECEIPTS_DIR para verlos).`);
}
