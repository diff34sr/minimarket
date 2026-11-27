const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const os = require('node:os');
const db = require('./db');

const tokens = new Map();
const publicDir = path.join(__dirname, 'public');
const contentTypes = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json'
};

const server = http.createServer(async (req, res) => {
  try {
    if (req.url.startsWith('/api/')) {
      await handleApi(req, res);
    } else if (req.url.startsWith('/receipts/')) {
      serveReceipt(req, res);
    } else {
      await serveStatic(req, res);
    }
  } catch (err) {
    handleError(res, err);
  }
});

const ADMIN = new Set(['GET /api/users', 'POST /api/users', 'POST /api/categories', 'POST /api/categories/:id/delete', 'GET /api/sales', 'POST /api/sales/:id/void', 'POST /api/cash/:id/void', 'POST /api/stock/adjust', 'POST /api/products/:id/reviewed', 'POST /api/deliveries/:id/void', 'GET /api/deliveries', 'GET /api/report', 'GET /api/report/monthly', 'POST /api/closures', 'GET /api/closures', 'POST /api/rejected/:id/reviewed']);

async function handleApi(req, res) {
  const { method } = req;
  const u = new URL(req.url, 'http://x');
  const url = u.pathname;
  req.query = u.searchParams;
  req.body = method === 'POST' ? await parseBody(req) : {};
  const user = tokens.get(req.headers['x-token']);
  const idMatch = url.match(/\/(\d+)(?=\/|$)/);
  const id = idMatch && Number(idMatch[1]);
  const key = method + ' ' + url.replace(/\/\d+(?=\/|$)/, '/:id');

  if (key === 'POST /api/login') return handleLogin(req, res);
  if (key === 'GET /api/info') return sendJson(res, { urls: lanUrls() });
  if (!user) return sendError(res, 401, 'Token requerido');
  if (ADMIN.has(key) && user.role !== 'admin') return sendError(res, 403, 'Solo admin');
  if (key === 'GET /api/users') return sendJson(res, db.listUsers());
  if (key === 'POST /api/users') return sendJson(res, db.saveUser(req.body));
  if (key === 'GET /api/catalog') return sendJson(res, db.catalog());
  if (key === 'POST /api/products') return sendJson(res, db.saveProduct(req.body, user));
  if (key === 'POST /api/categories') return sendJson(res, db.saveCategory(req.body));
  if (key === 'POST /api/categories/:id/delete') return db.deleteCategory(id), sendJson(res, { ok: true });
  if (key === 'POST /api/products/:id/reviewed') return sendJson(res, db.markReviewed(id));
  if (key === 'POST /api/deliveries') return sendJson(res, db.delivery(req.body, user.id));
  if (key === 'POST /api/deliveries/:id/void') return sendJson(res, db.voidDelivery(id, user.id));
  if (key === 'GET /api/deliveries') return sendJson(res, db.listDeliveries({ from: req.query.get('from'), to: req.query.get('to') }));
  if (key === 'GET /api/suppliers') return sendJson(res, db.listSuppliers(req.query.get('all') === '1'));
  if (key === 'POST /api/suppliers') return sendJson(res, db.saveSupplier(req.body));
  if (key === 'POST /api/stock/adjust') return sendJson(res, db.stockAdjust({ ...req.body, user_id: user.id }));
  if (key === 'GET /api/stock/moves') return sendJson(res, db.listStockMoves(req.query.get('product_id') && Number(req.query.get('product_id'))));
  if (key === 'GET /api/cart') return sendJson(res, db.getCart(user.id));
  if (key === 'POST /api/cart/add') return sendJson(res, db.cartAdd(user.id, req.body));
  if (key === 'POST /api/cart/set') return sendJson(res, db.cartSet(user.id, req.body));
  if (key === 'POST /api/cart/clear') return sendJson(res, db.cartClear(user.id));
  if (key === 'POST /api/cart/checkout') return sendJson(res, db.checkout(user.id, req.body));
  if (key === 'POST /api/sales') return sendJson(res, db.createSale({ ...req.body, user_id: user.id }));
  if (key === 'GET /api/sales') return sendJson(res, db.listSales(req.query.get('date')));
  if (key === 'POST /api/sales/:id/receipt') return sendJson(res, db.attachReceipt(id, req.body.image));
  if (key === 'POST /api/sales/:id/void') return sendJson(res, db.voidSale(id, user.id));
  if (key === 'GET /api/receipts/pending') return sendJson(res, db.pendingReceipts());
  if (key === 'POST /api/cash') return sendJson(res, db.addCash({ ...req.body, user_id: user.id }));
  if (key === 'GET /api/cash') return sendJson(res, db.listCash(req.query.get('date')));
  if (key === 'POST /api/cash/:id/void') return sendJson(res, db.voidCash(id, user.id));
  if (key === 'GET /api/report') return sendJson(res, db.report(req.query.get('from'), req.query.get('to')));
  if (key === 'GET /api/report/monthly') return sendJson(res, db.monthly(req.query.get('month')));
  if (key === 'POST /api/closures') return sendJson(res, db.closeDay(req.body, user.id));
  if (key === 'GET /api/closures') return sendJson(res, db.listClosures(req.query.get('month')));
  if (key === 'POST /api/rejected') return sendJson(res, db.addRejected(req.body, user.id));
  if (key === 'POST /api/rejected/:id/reviewed') return sendJson(res, db.markRejected(id, user.id));
  sendError(res, 404, 'Ruta no encontrada');
}

function serveReceipt(req, res) {
  const u = new URL(req.url, 'http://x');
  const user = tokens.get(req.headers['x-token'] || u.searchParams.get('t'));
  if (!user) return sendError(res, 401, 'Token requerido');
  if (user.role !== 'admin') return sendError(res, 403, 'Solo admin');
  const name = u.pathname.slice('/receipts/'.length);
  const file = path.join(db.receiptsDir(), name);
  if (!/^\d+\.jpg$/.test(name) || !fs.existsSync(file)) return sendError(res, 404, 'Archivo no encontrado');
  res.writeHead(200, { 'Content-Type': 'image/jpeg' });
  fs.createReadStream(file).on('error', () => res.destroy()).pipe(res);
}

const lanUrls = () => Object.values(os.networkInterfaces()).flat()
  .filter(i => i.family === 'IPv4' && !i.internal)
  .map(i => `http://${i.address}:${server.address()?.port || process.env.PORT || 3000}`);

async function handleLogin(req, res) {
  const body = req.body;
  if (!body?.pin) {
    sendError(res, 400, 'PIN requerido');
    return;
  }

  const user = await db.login(body.pin);
  if (!user) {
    sendError(res, 401, 'PIN incorrecto');
    return;
  }

  const token = crypto.randomUUID();
  tokens.set(token, user);
  sendJson(res, { token, user });
}

async function serveStatic(req, res) {
  let pathname = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  const filePath = path.normalize(path.join(publicDir, pathname === '/' ? 'index.html' : pathname));

  if (!filePath.startsWith(publicDir + path.sep)) {
    sendError(res, 403, 'Acceso denegado');
    return;
  }

  if (!fs.statSync(filePath, { throwIfNoEntry: false })?.isFile()) {
    sendError(res, 404, 'Archivo no encontrado');
    return;
  }

  const ext = path.extname(filePath);
  const contentType = contentTypes[ext] || 'application/octet-stream';
  const fileStream = fs.createReadStream(filePath);

  res.writeHead(200, { 'Content-Type': contentType });
  fileStream.pipe(res);
}

async function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (body.length > 5e6) {
        req.destroy();
        reject(Object.assign(new Error('Body demasiado grande'), { status: 413 }));
      }
    });
    req.on('end', () => {
      try {
        const v = body ? JSON.parse(body) : {};
        resolve(v && typeof v === 'object' ? v : {});
      } catch {
        reject(Object.assign(new Error('JSON inválido'), { status: 400 }));
      }
    });
  });
}

function sendJson(res, data) {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function sendError(res, status, message) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: message }));
}

function handleError(res, err) {
  if (!err.status) console.error(err);
  const status = err.status || 500;
  sendError(res, status, err.message || 'Error interno');
}

if (require.main === module) {
  const port = process.env.PORT || 3000;
  server.listen(port, '0.0.0.0', () => {
    const addresses = lanUrls();

    console.log(`Minimarket listo:\n  esta PC: http://localhost:${port}\n  red local:  ${addresses.join('  ')}`);
  });
}

module.exports = server;
