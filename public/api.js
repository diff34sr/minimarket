const store = {
  get: k => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch {} },
};

const applyTheme = t => {
  if (t) document.documentElement.dataset.theme = t;
  else delete document.documentElement.dataset.theme;
};
applyTheme(store.get('theme'));

const toggleTheme = () => {
  const dark = document.documentElement.dataset.theme
    ? document.documentElement.dataset.theme === 'dark'
    : matchMedia('(prefers-color-scheme: dark)').matches;
  document.documentElement.classList.add('theming');
  applyTheme(dark ? 'light' : 'dark');
  store.set('theme', dark ? 'light' : 'dark');
  setTimeout(() => document.documentElement.classList.remove('theming'), 450);
};

document.addEventListener('DOMContentLoaded', () => {
  document.querySelectorAll('[data-theme-toggle]').forEach(b => b.addEventListener('click', toggleTheme));
});

const esc = v => String(v ?? '').replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);
const money = n => 'Bs ' + Number(n || 0).toFixed(2);
const $ = (s, root = document) => root.querySelector(s);

const api = async (path, body) => {
  const token = store.get('token');
  const res = await fetch('/api' + path, {
    method: body ? 'POST' : 'GET',
    headers: { 'content-type': 'application/json', ...(token && { 'x-token': token }) },
    body: body && JSON.stringify(body),
    signal: AbortSignal.timeout?.(5000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = Object.assign(new Error(data.error || 'Error de conexión'), { status: res.status });
    if (res.status !== 401) toast(err.message, 'error');
    throw err;
  }
  return data;
};

const toast = (msg, kind = '') => {
  const el = document.createElement('div');
  el.className = 'toast ' + kind;
  el.setAttribute('role', 'status');
  el.textContent = msg;
  document.body.append(el);
  setTimeout(() => el.classList.add('out'), 2600);
  setTimeout(() => el.remove(), 3000);
};

const animateNumber = (el, to, fmt = money) => {
  const from = Number(el.dataset.v || 0);
  el.dataset.v = to;
  if (from === to || matchMedia('(prefers-reduced-motion: reduce)').matches) return void (el.textContent = fmt(to));
  const t0 = performance.now();
  const step = t => {
    const k = Math.min(1, (t - t0) / 320);
    el.textContent = fmt(from + (to - from) * (1 - (1 - k) ** 3));
    if (k < 1 && el.dataset.v == to) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
};

const sheet = (html, cls = '') => {
  const wrap = document.createElement('div');
  wrap.className = 'overlay';
  wrap.innerHTML = `<div class="sheet ${cls}" role="dialog" aria-modal="true"><button class="x" aria-label="Cerrar">✕</button>${html}</div>`;
  document.body.append(wrap);
  requestAnimationFrame(() => requestAnimationFrame(() => wrap.classList.add('open')));
  let resolve;
  const done = new Promise(r => (resolve = r));
  const top = () => wrap === [...document.querySelectorAll('.overlay')].pop();
  const onKey = e => { if (e.key === 'Escape' && top()) close(); };
  const close = v => {
    if (wrap.dataset.closing) return;
    wrap.dataset.closing = 1;
    wrap.classList.remove('open');
    document.removeEventListener('keydown', onKey);
    setTimeout(() => wrap.remove(), 260);
    resolve(v);
  };
  document.addEventListener('keydown', onKey);
  wrap.addEventListener('pointerdown', e => { if (e.target === wrap) close(); });
  wrap.querySelector('.x').onclick = () => close();
  const el = wrap.querySelector('.sheet');
  setTimeout(() => el.querySelector('[autofocus]')?.focus(), 60);
  return { el, close, done, $: s => el.querySelector(s) };
};

const confirmSheet = (title, okLabel = 'Confirmar', detail = '') => {
  const s = sheet(`<h2>${esc(title)}</h2>${detail ? `<p class="muted">${esc(detail)}</p>` : ''}
    <div class="row2"><button class="btn ghost" data-v="">Cancelar</button><button class="btn danger" data-v="1">${esc(okLabel)}</button></div>`, 'small');
  s.el.querySelectorAll('[data-v]').forEach(b => (b.onclick = () => s.close(!!b.dataset.v)));
  return s.done.then(Boolean);
};

const keypad = (title, { grams = false } = {}) => {
  let n = '';
  const s = sheet(`<h2>${esc(title)}</h2><div class="kp-display" aria-live="polite"></div>
    <div class="kp">${[1, 2, 3, 4, 5, 6, 7, 8, 9, '⌫', 0, 'OK'].map(k => `<button class="${k === 'OK' ? 'ok' : ''}" data-k="${k}"${k === '⌫' ? ' aria-label="Borrar"' : ''}>${k}</button>`).join('')}</div>`, 'small');
  const out = s.$('.kp-display');
  const paint = () => (out.textContent = (n || '0') + (grams ? ' g' : ''));
  const press = k => {
    if (k === '⌫') n = n.slice(0, -1);
    else if (k === 'OK') return +n > 0 ? s.close(+n) : shake(out);
    else if (n.length < 7) n = (n + k).replace(/^0+/, '');
    paint();
  };
  const onKey = e => {
    const k = /^\d$/.test(e.key) ? e.key : e.key === 'Backspace' ? '⌫' : e.key === 'Enter' ? 'OK' : null;
    if (k) { e.preventDefault(); press(k); }
  };
  s.el.querySelectorAll('[data-k]').forEach(b => (b.onclick = () => press(b.dataset.k)));
  document.addEventListener('keydown', onKey);
  paint();
  return s.done.then(v => { document.removeEventListener('keydown', onKey); return v ?? null; });
};

async function shrink(file) {
  const bmp = await createImageBitmap(file);
  const k = Math.min(1, 1280 / Math.max(bmp.width, bmp.height));
  const c = Object.assign(document.createElement('canvas'), { width: Math.round(bmp.width * k), height: Math.round(bmp.height * k) });
  const x = c.getContext('2d');
  x.fillStyle = '#fff';
  x.fillRect(0, 0, c.width, c.height);
  x.drawImage(bmp, 0, 0, c.width, c.height);
  return c.toDataURL('image/jpeg', .7);
}

const shake = el => { el.classList.remove('shake'); void el.offsetWidth; el.classList.add('shake'); };

const cashSheet = (type = 'gasto') => {
  const s = sheet(`<h2>Movimiento de caja</h2>
    <div class="seg"><button data-t="gasto">− Gasto</button><button data-t="ingreso">+ Ingreso</button></div>
    <label class="field"><span>Monto (Bs)</span><input class="input big" type="number" inputmode="decimal" min="0" step="0.5" autofocus></label>
    <label class="field"><span>Detalle</span><input class="input" placeholder="Ej: gas, bolsas, cambio inicial"></label>
    <button class="btn primary big full">Guardar</button>`);
  const [amount, note] = s.el.querySelectorAll('input');
  const seg = s.el.querySelectorAll('.seg button');
  const pick = t => { type = t; seg.forEach(b => b.classList.toggle('on', b.dataset.t === t)); };
  seg.forEach(b => (b.onclick = () => pick(b.dataset.t)));
  pick(type);
  const save = async () => {
    if (!(Number(amount.value) > 0)) return shake(amount);
    if (!note.value.trim()) return shake(note);
    try {
      await api('/cash', { type, amount: Number(amount.value), note: note.value });
    } catch (e) {
      return e.status || toast('Sin conexión al PC', 'error');
    }
    toast(type === 'gasto' ? 'Gasto registrado' : 'Ingreso registrado', 'ok');
    s.close(true);
  };
  s.$('.btn.primary').onclick = save;
  s.el.addEventListener('keydown', e => e.key === 'Enter' && save());
  return s.done;
};

const BRAND = '<span class="brand"><span class="chick" aria-hidden="true">🛒</span>Minimarket</span>';
const THEME_BTN = '<button class="iconbtn" data-theme-toggle aria-label="Cambiar tema"><span class="sun">☀︎</span><span class="moon">☾</span></button>';

const pinLogin = async role => {
  if (store.get('token')) {
    const expired = await api('/catalog').then(() => false, e => e.status === 401);
    let user = null;
    try { user = JSON.parse(store.get('user')); } catch {}
    if (!expired && user && (!role || user.role === role)) return user;
    store.set('token', null);
    store.set('user', null);
  }
  return new Promise(resolve => {
    const scr = document.createElement('div');
    scr.className = 'pin-screen';
    scr.innerHTML = `
      <a class="back" href="index.html">← Inicio</a>
      <div class="pin-box">
        ${BRAND}
        <p class="muted">${role === 'admin' ? 'PIN de administrador' : 'Ingresa tu PIN'}</p>
        <div class="dots">${'<i></i>'.repeat(4)}</div>
        <p class="pin-err" aria-live="polite"></p>
        <div class="pad">${[1, 2, 3, 4, 5, 6, 7, 8, 9, '', 0, '⌫'].map(n => n === '' ? '<span></span>' : `<button data-k="${n}" aria-label="${n === '⌫' ? 'Borrar' : n}">${n}</button>`).join('')}</div>
        <p class="muted small">También puedes usar el teclado · Esc para salir</p>
      </div>`;
    document.body.append(scr);
    const dotsBox = $('.dots', scr);
    const dots = dotsBox.querySelectorAll('i');
    const err = $('.pin-err', scr);
    let pin = '', busy = false;
    const paint = () => dots.forEach((d, i) => d.classList.toggle('on', i < pin.length));
    const fail = msg => {
      err.textContent = msg;
      shake(dotsBox);
      setTimeout(() => { pin = ''; paint(); }, 380);
    };
    const press = async k => {
      if (busy) return;
      if (k === '⌫') pin = pin.slice(0, -1);
      else if (pin.length < 4) pin += k;
      err.textContent = '';
      paint();
      if (pin.length < 4) return;
      busy = true;
      try {
        const { token, user } = await api('/login', { pin });
        if (role && user.role !== role) return fail('Este PIN no es de administrador');
        store.set('token', token);
        store.set('user', JSON.stringify(user));
        document.removeEventListener('keydown', onKey);
        scr.classList.add('out');
        setTimeout(() => scr.remove(), 350);
        resolve(user);
      } catch (e) { fail(e.status ? 'PIN incorrecto' : 'Sin conexión al PC'); }
      finally { busy = false; }
    };
    scr.querySelectorAll('[data-k]').forEach(b => b.addEventListener('click', () => press(b.dataset.k)));
    const onKey = e => {
      if (/^\d$/.test(e.key)) press(e.key);
      else if (e.key === 'Backspace') press('⌫');
      else if (e.key === 'Escape') location.href = 'index.html';
    };
    document.addEventListener('keydown', onKey);
  });
};

const logout = () => {
  store.set('token', null);
  store.set('user', null);
  location.href = 'index.html';
};
