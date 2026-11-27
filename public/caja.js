(() => {
  const IDLE_MS = 300000;
  const g = id => document.getElementById(id);
  const [idle, sale, banner, pend, lines, totalEl, payBtn, chips, grid, search, scanBox] =
    ['idle', 'sale', 'banner', 'pend', 'lines', 'total', 'pay', 'chips', 'grid', 'search', 'scan'].map(g);

  let mode = 'online', items = [], total = 0, version = -1, inflight = 0, polling = false, paying = false;
  let localItems = [], seed = {}, targets = null;
  let catalog = { categories: [], products: [] };
  let cat = null, stopScan = null, inSale = false, lastAct = Date.now(), audio, reauthing;

  try { catalog = JSON.parse(store.get('catalog')) || catalog; } catch {}

  const queue = createQueue({ getItem: store.get, setItem: store.set }, send);
  const qtys = a => Object.fromEntries(a.map(i => [i.product_id, i.qty]));
  const same = (a, b) => JSON.stringify(Object.entries(a).sort()) === JSON.stringify(Object.entries(b).sort());
  const norm = s => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  const uuid = () => crypto.randomUUID?.() ??
    '10000000-1000-4000-8000-100000000000'.replace(/[018]/g, c => (c ^ crypto.getRandomValues(new Uint8Array(1))[0] & 15 >> c / 4).toString(16));
  const localNow = () => new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 19).replace('T', ' ');
  const rejected = () => { try { return JSON.parse(store.get('sales_rejected')) || []; } catch { return []; } };
  const offline = e => e.status || toast('Sin conexión al PC', 'error');
  const qtyText = it => it.unit === 'kg' ? (it.qty < 1 ? Math.round(it.qty * 1000) + ' g' : it.qty + ' kg') : it.qty;
  const toItem = p => ({ product_id: p.id, name: p.name, unit: p.unit, price: p.price });

  const beep = () => {
    try {
      audio ||= new AudioContext();
      audio.resume();
      const o = audio.createOscillator();
      o.frequency.value = 1000;
      o.connect(audio.destination);
      o.start();
      o.stop(audio.currentTime + .08);
    } catch {}
  };

  const call = async (path, body) => {
    try { return await api(path, body); } catch (e) {
      if (e.status !== 401) throw e;
      reauthing ||= (store.set('token', null), pinLogin()).finally(() => (reauthing = null));
      await reauthing;
      return api(path, body);
    }
  };

  async function send(s) {
    try { await call('/sales', s); } catch (e) {
      if (!e.status || e.status >= 500 || e.status === 401) throw e;
      store.set('sales_rejected', JSON.stringify([...rejected(), { sale: s, error: e.message }]));
      uploadRejected();
    }
  }

  let uploading = null;
  const uploadRejected = () => uploading ||= (async () => {
    for (const r of rejected().filter(r => !r.uploaded)) {
      let uploaded = true;
      try { await call('/rejected', { payload: r.sale, reason: r.error }); } catch (e) {
        if (e.status >= 400 && e.status < 500 && e.status !== 401) uploaded = 'failed'; else continue;
      }
      store.set('sales_rejected', JSON.stringify(rejected().map(x => x.sale.client_uuid === r.sale.client_uuid ? { ...x, uploaded } : x)));
    }
  })().finally(() => { uploading = null; });

  const showPending = () => {
    const n = queue.pending().length;
    pend.hidden = !n;
    pend.textContent = n === 1 ? '1 pendiente' : n + ' pendientes';
  };

  async function flush() {
    uploadRejected();
    if (!queue.pending().length) return;
    const r = await queue.flush();
    showPending();
    if (r.sent) toast(r.sent === 1 ? '1 venta enviada' : r.sent + ' ventas enviadas', 'ok');
  }

  function render() {
    lines.innerHTML = items.length ? items.map(it => `<div class="line" data-id="${it.product_id}">
      <div class="nm"><b>${esc(it.name)}</b><small>${money(it.price)}${it.unit === 'kg' ? '/kg' : ' c/u'}</small><strong>${money(it.subtotal)}</strong></div>
      <div class="stepper"><button data-a="-" aria-label="Quitar uno">−</button><button class="q" data-a="q" aria-label="Cambiar cantidad">${qtyText(it)}</button><button data-a="+" aria-label="Agregar uno">+</button></div>
      <button class="rm" data-a="x" aria-label="Quitar">✕</button></div>`).join('')
      : '<div class="empty"><span>🛒</span><p>Escanea un producto</p></div>';
    totalEl.textContent = money(total);
    payBtn.disabled = !items.length;
  }

  function paint(c) {
    items = c.items;
    total = c.total;
    version = c.version;
    render();
    return c;
  }

  function setLocal(arr) {
    localItems = arr;
    items = arr.map(i => ({ ...i, subtotal: lineSubtotal(i.price, i.qty) }));
    total = cartTotal(arr);
    render();
  }

  function goLocal() {
    if (mode === 'local') return;
    mode = 'local';
    banner.hidden = false;
    localItems = items.map(({ product_id, name, unit, price, qty }) => ({ product_id, name, unit, price, qty }));
    seed = qtys(localItems);
  }

  async function mutate(path, body, localFn) {
    if (mode === 'online') {
      inflight++;
      try { return paint(await call(path, body)); } catch (e) { if (e.status) return; goLocal(); } finally { inflight--; }
    }
    setLocal(localFn(localItems));
  }

  const addQty = (p, qty) => mutate('/cart/add', { product_id: p.id, qty }, l => cartAdd(l, toItem(p), qty));
  const setQty = (it, qty) => mutate('/cart/set', { product_id: it.product_id, qty }, l => cartSet(l, it.product_id, qty));

  async function pick(p) {
    let qty = 1;
    if (p.unit === 'kg') {
      const gr = await keypad('Gramos · ' + p.name, { grams: true });
      if (!gr) return;
      qty = gramsToQty(gr);
    } else if (p.ask_qty) {
      qty = await keypad('Cantidad · ' + p.name);
      if (!qty) return;
    }
    await addQty(p, qty);
    focusScan();
  }

  function focusScan() {
    if (matchMedia('(pointer: fine)').matches && !document.querySelector('.overlay')) scanBox.querySelector('input')?.focus();
  }

  async function onCode(code) {
    if (document.querySelector('.overlay')) return;
    lastAct = Date.now();
    const find = () => catalog.products.find(p => String(p.barcode) === code);
    let p = find();
    if (!p && mode === 'online') { await loadCatalog(); p = find(); }
    if (!p) return toast('Producto no registrado: ' + code, 'error');
    beep();
    await pick(p);
  }

  async function enterSale() {
    if (inSale) return;
    inSale = true;
    idle.hidden = true;
    sale.hidden = false;
    lastAct = Date.now();
    stopScan = await startScanner(scanBox, onCode);
  }

  function leaveSale() {
    if (!inSale) return;
    inSale = false;
    stopScan?.();
    stopScan = null;
    sale.hidden = true;
    idle.hidden = false;
  }

  function renderChips() {
    const ids = new Set(catalog.products.map(p => p.cat_id || 0));
    const cats = [...catalog.categories.filter(c => ids.has(c.id)), ...(ids.has(0) ? [{ id: 0, name: 'Otros' }] : [])];
    chips.innerHTML = cats.map(c => `<button class="chip ${c.id === cat ? 'on' : ''}" data-c="${c.id}">${esc(c.name)}</button>`).join('');
  }

  function renderGrid() {
    const q = norm(search.value.trim());
    const list = q ? catalog.products.filter(p => norm(p.name + ' ' + p.brand).includes(q))
      : cat === null ? [] : catalog.products.filter(p => (p.cat_id || 0) === cat);
    grid.innerHTML = list.slice(0, 60).map(p => `<button class="pbtn" data-id="${p.id}"><span>${esc(p.name)}</span><b>${money(p.price)}${p.unit === 'kg' ? '/kg' : ''}</b></button>`).join('');
  }

  async function loadCatalog() {
    try {
      const c = await call('/catalog');
      catalog = {
        categories: c.categories,
        products: c.products.filter(p => p.active).map(({ id, barcode, name, brand, cat_id, unit, price, ask_qty }) => ({ id, barcode, name, brand, cat_id, unit, price, ask_qty })),
      };
      store.set('catalog', JSON.stringify(catalog));
      renderChips();
      renderGrid();
    } catch {}
  }

  async function reconnect(c) {
    flush();
    if (!targets) {
      let loc = qtys(localItems);
      if (localItems.length && !same(loc, seed)) {
        const s = sheet(`<h2>Venta sin enviar</h2><p class="muted">Hay ${localItems.length} producto(s) en el carrito de este equipo. ¿Los subes a la venta compartida?</p>
          <div class="row2"><button class="btn danger" data-v="drop">Descartar</button><button class="btn primary" data-v="up">Subir</button></div>`, 'small');
        s.el.querySelectorAll('[data-v]').forEach(b => (b.onclick = () => s.close(b.dataset.v)));
        if ((await s.done) === 'drop') loc = seed;
      }
      const srv = qtys(c.items);
      targets = {};
      for (const id of new Set([...Object.keys(srv), ...Object.keys(seed), ...Object.keys(loc)])) {
        targets[id] = Math.max(0, Math.round(((srv[id] || 0) - (seed[id] || 0) + (loc[id] || 0)) * 1000) / 1000);
      }
    }
    for (const [id, q] of Object.entries(targets)) {
      if (q !== (qtys(c.items)[id] || 0)) c = await call('/cart/set', { product_id: +id, qty: q });
    }
    targets = null;
    seed = {};
    localItems = [];
    mode = 'online';
    banner.hidden = true;
    paint(c);
  }

  async function poll() {
    if (polling || inflight || paying) return;
    polling = true;
    try {
      const c = await call('/cart');
      if (mode === 'local') await reconnect(c);
      else if (c.version !== version) {
        paint(c);
        if (items.length) enterSale();
      }
    } catch (e) { if (!e.status) goLocal(); } finally { polling = false; }
  }

  function success(amount, extra, sub) {
    const el = document.createElement('div');
    el.className = 'success';
    el.innerHTML = `<div class="success-box">
      <svg class="check" viewBox="0 0 52 52" aria-hidden="true"><circle cx="26" cy="26" r="24"/><path d="M15 27l7 7 15-16"/></svg>
      <div class="total-big">${money(amount)}</div>${extra ? `<p class="change-big">${extra}</p>` : ''}<p class="muted">${sub}</p></div>`;
    document.body.append(el);
    const close = () => { el.classList.add('out'); setTimeout(() => el.remove(), 300); };
    el.onclick = close;
    setTimeout(close, extra ? 2800 : 1600);
  }

  function receiptSheet(id) {
    const s = sheet(`<h2>Comprobante</h2><p class="muted">Venta #${id} · QR</p>
      <label class="btn primary big full upl">📷 Foto<input type="file" accept="image/*" capture="environment" hidden></label>
      <label class="btn big full upl">🖼 Subir imagen<input type="file" accept="image/*" hidden></label>
      <button class="btn ghost full" id="skip" style="margin-top:10px">Omitir</button>`, 'small');
    s.el.querySelectorAll('input').forEach(inp => (inp.onchange = async () => {
      if (!inp.files[0]) return;
      try {
        await call(`/sales/${id}/receipt`, { image: await shrink(inp.files[0]) });
      } catch (e) { return offline(e); }
      toast('Comprobante guardado', 'ok');
      s.close(true);
    }));
    s.$('#skip').onclick = () => s.close(false);
    return s.done;
  }

  async function pendingSheet() {
    let list;
    try { list = await call('/receipts/pending'); } catch (e) { return offline(e); }
    const s = sheet(`<h2>Comprobantes pendientes</h2>${list.length ? `<div class="menu-list">${list.map(v =>
      `<button data-id="${v.id}"><span>#${v.id} · ${esc(v.created_at.slice(11, 16))}<small>${money(v.total)}</small></span><span>Adjuntar</span></button>`).join('')}</div>`
      : '<p class="muted">No hay comprobantes pendientes.</p>'}`);
    s.el.querySelectorAll('[data-id]').forEach(b => (b.onclick = async () => {
      if (await receiptSheet(+b.dataset.id)) { s.close(); pendingSheet(); }
    }));
  }

  function rejectedSheet() {
    const list = rejected();
    const s = sheet(`<h2>Ventas rechazadas</h2>${list.length ? `<div class="menu-list">${list.map((r, i) =>
      `<div><span>${esc(r.sale.created_at)} · ${money(cartTotal(r.sale.items))}<small>${esc(r.error)}</small></span>${r.uploaded === true ? `<button class="btn" data-i="${i}">Revisada</button>` : '<small>sin subir</small>'}</div>`).join('')}</div>`
      : '<p class="muted">No hay ventas rechazadas.</p>'}`);
    s.el.querySelectorAll('[data-i]').forEach(b => (b.onclick = async () => {
      if (!await confirmSheet('¿Marcar como revisada?', 'Revisada', 'Se quita de la lista.')) return;
      store.set('sales_rejected', JSON.stringify(rejected().filter((_, i) => i !== +b.dataset.i)));
      s.close();
      rejectedSheet();
    }));
  }

  function checkout() {
    if (!items.length || document.querySelector('.overlay')) return;
    const t = total;
    const s = sheet(`<p class="muted" style="margin:0">Total a cobrar</p><div class="pay-total">${money(t)}</div>
      <div class="pay-methods"><button class="btn primary big" data-pay="efectivo" autofocus>💵 Efectivo</button><button class="btn big qr" data-pay="qr">▦ QR</button></div>
      <button class="btn full" data-pay="exacto" style="margin-top:10px">Efectivo exacto</button>`, 'small');
    s.el.querySelectorAll('[data-pay]').forEach(b => (b.onclick = async () => {
      const m = b.dataset.pay;
      let received = null;
      if (m === 'efectivo') {
        received = await keypad('Recibido (Bs)');
        if (received == null) return;
        if (change(t, received) === null) return toast('Falta dinero · total ' + money(t), 'error');
      }
      s.close();
      finish(m === 'qr' ? 'qr' : 'efectivo', received);
    }));
  }

  async function finish(pay, received) {
    if (paying) return;
    paying = true;
    const client_uuid = uuid();
    try {
      let s = null;
      if (mode === 'online') {
        try { s = await call('/cart/checkout', { pay, client_uuid }); } catch (e) {
          if (e.status) return void (version = -1);
          goLocal();
        }
      }
      const amount = s ? s.total : total;
      const vuelto = received == null ? null : change(amount, received);
      const extra = received == null ? '' : vuelto === null ? 'Faltan ' + money(amount - received) : vuelto ? 'Vuelto ' + money(vuelto) : '';
      if (s) {
        items = []; total = 0; version = -1;
        render();
        if (pay === 'qr') { await receiptSheet(s.id); toast('Venta registrada', 'ok'); } else success(amount, extra, 'Efectivo');
      } else {
        queue.enqueue({ client_uuid, pay, items: localItems.map(({ product_id, qty, price }) => ({ product_id, qty, price })), created_at: localNow() });
        setLocal([]);
        showPending();
        success(amount, extra, 'Guardada · se envía al volver la conexión');
      }
    } finally { paying = false; }
  }

  lines.onclick = async e => {
    const b = e.target.closest('[data-a]');
    const it = b && items.find(i => i.product_id === +b.closest('.line').dataset.id);
    if (!it) return;
    const step = it.unit === 'kg' ? .1 : 1;
    const a = b.dataset.a;
    if (a === 'x') setQty(it, 0);
    else if (a === '+') setQty(it, it.qty + step);
    else if (a === '-') setQty(it, it.qty - step);
    else {
      const n = await keypad(it.name, { grams: it.unit === 'kg' });
      if (n) setQty(it, it.unit === 'kg' ? gramsToQty(n) : n);
    }
  };
  grid.onclick = e => {
    const b = e.target.closest('[data-id]');
    if (b) pick(catalog.products.find(p => p.id === +b.dataset.id));
  };
  chips.onclick = e => {
    const b = e.target.closest('[data-c]');
    if (!b) return;
    cat = cat === +b.dataset.c ? null : +b.dataset.c;
    renderChips();
    renderGrid();
  };
  search.oninput = renderGrid;
  payBtn.onclick = checkout;
  g('clear').onclick = async () => {
    if (items.length && await confirmSheet('¿Limpiar la venta?', 'Limpiar')) mutate('/cart/clear', {}, () => []);
  };
  g('end').onclick = leaveSale;
  g('start').onclick = enterSale;
  g('cash').onclick = () => cashSheet();
  g('out').onclick = async () => {
    await flush();
    if (queue.pending().length && !await confirmSheet(`Hay ${queue.pending().length} venta(s) sin enviar`, 'Salir igual', 'Quedan guardadas en este equipo y se envían al volver la conexión.')) return;
    logout();
  };
  g('more').onclick = () => {
    const n = rejected().length;
    const s = sheet(`<h2>Opciones</h2><div class="menu-list">
      <button data-a="rec">🧾 Comprobantes pendientes</button>
      ${n ? `<button data-a="rej">⚠ ${n === 1 ? '1 venta rechazada' : n + ' ventas rechazadas'}</button>` : ''}</div>`);
    s.el.querySelectorAll('[data-a]').forEach(b => (b.onclick = () => { s.close(); b.dataset.a === 'rec' ? pendingSheet() : rejectedSheet(); }));
  };

  ['pointerdown', 'keydown'].forEach(ev => document.addEventListener(ev, () => (lastAct = Date.now())));
  addEventListener('online', poll);

  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});

  (async () => {
    const user = await pinLogin();
    g('who').textContent = '👤 ' + user.name;
    renderChips();
    showPending();
    setInterval(poll, 1000);
    setInterval(flush, 10000);
    setInterval(loadCatalog, 60000);
    setInterval(() => { if (inSale && !items.length && !document.querySelector('.overlay') && Date.now() - lastAct > IDLE_MS) leaveSale(); }, 10000);
    poll();
    loadCatalog();
    flush();
  })();
})();
