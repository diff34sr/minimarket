(() => {
  const pad = n => String(n).padStart(2, '0');
  const ymd = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const ago = n => { const d = new Date(); d.setDate(d.getDate() - n); return ymd(d); };
  const hhmm = s => String(s ?? '').slice(11, 16);
  const num = n => Number(Number(n).toFixed(3));
  const pct = (v, max) => (max > 0 ? Math.max(0, Math.min(100, (v / max) * 100)) : 0);
  const neg = v => (v < 0 ? ' class="neg"' : '');
  const call = (path, body) => api(path, body).catch(e => { if (e.status === 401) { logout(); throw e; } return null; });
  const R = { seq: 0, tab: 'resumen', preset: 'hoy', from: ago(0), to: ago(0), day: ago(0), month: ago(0).slice(0, 7) };

  const tbl = (heads, rows, left = 1) => rows.length
    ? `<div class="tw"><table class="list"><thead><tr>${heads.map((h, i) => `<th class="${i < left ? '' : 'num'}">${h}</th>`).join('')}</tr></thead><tbody>${rows.map(r => `<tr>${r.map((c, i) => `<td class="${i < left ? '' : 'num'}">${c}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`
    : '<p class="empty-msg">Sin datos</p>';
  const panel = (title, html) => `<section class="panel"><h3>${title}</h3>${html}</section>`;
  const stat = (label, v, cls = '') => `<div class="stat"><small>${label}</small><b class="${cls}">${v}</b></div>`;
  const bar = (v, max, cls = '') => `<div class="bar ${cls}"><i style="width:${pct(v, max).toFixed(1)}%"></i></div>`;
  const head = (title, extra = '') => `<div class="head"><h1>${title}</h1>${extra}</div>`;
  const dateInput = (id, v) => `<input class="input" type="date" id="${id}" value="${v}" max="${ago(0)}" style="width:auto">`;

  async function resumen(body) {
    const range = () => ({ hoy: [ago(0), ago(0)], 7: [ago(6), ago(0)], 30: [ago(29), ago(0)], libre: [R.from, R.to] })[R.preset];
    body.innerHTML = `<div class="chips" id="rp">${[['hoy', 'Hoy'], [7, '7 días'], [30, '30 días'], ['libre', 'Libre']].map(([k, l]) => `<button class="chip ${String(k) === String(R.preset) ? 'on' : ''}" data-p="${k}">${l}</button>`).join('')}</div>
      <div class="head" id="rl" ${R.preset === 'libre' ? '' : 'hidden'}>${dateInput('rf', R.from)}<span>a</span>${dateInput('rt', R.to)}</div><div id="rd"></div>`;
    const load = async () => {
      const n = ++R.seq;
      const [from, to] = range();
      if (from > to) return void ($('#rd').innerHTML = '<p class="empty-msg">Rango inválido</p>');
      const r = await call(`/report?from=${from}&to=${to}`);
      if (!r || n !== R.seq) return;
      const maxS = Math.max(0, ...r.by_category.map(c => c.total));
      $('#rd').innerHTML = `<div class="cards">${stat('Ventas', money(r.total))}${stat('Margen', money(r.margin), r.margin < 0 ? 'neg' : '')}${stat('Efectivo esperado', money(r.efectivo_esperado))}${stat('Gastos / ingresos', `${money(r.gastos)} / ${money(r.ingresos)}`)}${stat('Comprobantes pendientes', r.pending_receipts, r.pending_receipts ? 'neg' : '')}</div>
        ${panel('Por categoría', r.by_category.map(c => `<div class="brow"><div class="bh"><b>${esc(c.name)}</b><span>${money(c.total)} · margen <span${neg(c.margin)}>${money(c.margin)}</span></span></div>${bar(c.total, maxS)}${bar(c.margin, maxS, 'm')}</div>`).join('') || '<p class="empty-msg">Sin ventas</p>')}
        <div class="two">
          ${panel('Más ganancia', tbl(['Producto', 'Margen', 'Ventas'], r.top_profit.map(p => [esc(p.name), `<span${neg(p.margin)}>${money(p.margin)}</span>`, money(p.total)])))}
          ${panel('Medio de pago', tbl(['Medio', 'Total'], [['Efectivo', money(r.by_pay.efectivo)], ['QR', money(r.by_pay.qr)]]))}
          ${panel('Por cajero', tbl(['Cajero', 'Total'], r.by_user.map(u => [esc(u.name), money(u.total)])))}
          ${panel('Sin ventas en el rango', tbl(['Producto', 'Stock'], r.no_sales.map(p => [esc(p.name), num(p.stock)])))}
        </div>
        ${panel('Por producto', tbl(['Producto', 'Cant.', 'Ventas', 'Margen'], r.by_product.map(p => [esc(p.name), num(p.qty), money(p.total), `<span${neg(p.margin)}>${money(p.margin)}</span>`])))}
        ${panel('Qué reponer', tbl(['Producto', 'Stock', 'Mínimo'], r.low_stock.map(p => [esc(p.name), `<span${neg(p.stock)}>${num(p.stock)} ${esc(p.unit)}</span>`, num(p.min_stock)])))}`;
    };
    $('#rp').onclick = e => {
      const b = e.target.closest('[data-p]');
      if (!b) return;
      R.preset = b.dataset.p;
      resumen(body);
    };
    $('#rf').onchange = e => { R.from = e.target.value || R.from; load(); };
    $('#rt').onchange = e => { R.to = e.target.value || R.to; load(); };
    load();
  }

  async function cierre(body) {
    const n = ++R.seq;
    const [r, closures] = await Promise.all([call(`/report?from=${R.day}&to=${R.day}`), call(`/closures?month=${R.day.slice(0, 7)}`)]);
    if (!r || !closures || n !== R.seq) return;
    const done = closures.find(c => c.day === R.day);
    const form = done
      ? `<div class="cards">${stat('Esperado', money(done.expected))}${stat('Contado', money(done.counted))}${stat('Diferencia', money(done.diff), done.diff < 0 ? 'neg' : '')}</div>
         <p class="muted">Cerrado por ${esc(done.user)}${done.note ? ` · ${esc(done.note)}` : ''}</p>`
      : `<div class="cards">${stat('Efectivo esperado', money(r.efectivo_esperado))}</div>
         <label class="field"><span>Contado (Bs)</span><input class="input" id="cnt" type="number" inputmode="decimal" min="0" step="0.01"></label>
         <label class="field"><span>Nota</span><input class="input" id="note" autocomplete="off"></label>
         <button class="btn primary big full" id="close">Cerrar el día</button>`;
    body.innerHTML = `<div class="head">${dateInput('cd', R.day)}</div><div class="two">
      ${panel(`Cierre del ${esc(R.day)}`, form)}
      ${panel('Cierres del mes', tbl(['Día', 'Esperado', 'Contado', 'Dif.'], closures.map(c => [`<button class="lnk" data-d="${esc(c.day)}">${esc(c.day)}</button>`, money(c.expected), money(c.counted), `<span${neg(c.diff)}>${money(c.diff)}</span>`])))}</div>`;
    $('#cd').onchange = e => { R.day = e.target.value || R.day; cierre(body); };
    body.querySelectorAll('[data-d]').forEach(b => (b.onclick = () => { R.day = b.dataset.d; cierre(body); }));
    if (done) return;
    $('#close').onclick = async () => {
      const cnt = $('#cnt');
      if (!(cnt.valueAsNumber >= 0)) return shake(cnt);
      const note = $('#note').value.trim();
      const diff = Math.round((cnt.valueAsNumber - r.efectivo_esperado) * 100) / 100;
      if (!(await confirmSheet(`¿Cerrar el ${R.day}?`, 'Cerrar', `Contado ${money(cnt.valueAsNumber)} · esperado ${money(r.efectivo_esperado)} · diferencia ${money(diff)}${note ? ` · Nota: ${note}` : ''}. El cierre no se puede modificar ni borrar.`))) return;
      if (await call('/closures', { day: R.day, counted: cnt.valueAsNumber, note })) toast('Día cerrado', 'ok');
      cierre(body);
    };
  }

  async function mensual(body) {
    const n = ++R.seq;
    const m = await call(`/report/monthly?month=${R.month}`);
    if (!m || n !== R.seq) return;
    const max = Math.max(0, ...m.by_category.map(c => c.sales));
    const t = m.totals;
    body.innerHTML = `<div class="head"><button class="iconbtn" data-mv="-1" aria-label="Mes anterior">‹</button><b>${esc(R.month)}</b><button class="iconbtn" data-mv="1" aria-label="Mes siguiente">›</button></div>
      <div class="cards">${stat('Ventas', money(t.sales))}${stat('Ganancia', money(t.profit), t.profit < 0 ? 'neg' : '')}${stat('Margen', `${t.margin_pct}%`)}${stat('Compras', money(t.purchases))}${stat('Dif. de cierres', money(t.closures_diff), t.closures_diff < 0 ? 'neg' : '')}</div>
      ${panel('Por categoría', tbl(['Categoría', 'Ventas', 'Costo', 'Mermas', 'Ganancia', 'Margen'], [
        ...m.by_category.map(c => [`${esc(c.name)}${bar(c.sales, max)}`, money(c.sales), money(c.cogs), money(c.shrink), `<span${neg(c.profit)}>${money(c.profit)}</span>`, `${c.margin_pct}%`]),
        ...(m.by_category.length ? [[`<b>Total</b>`, money(t.sales), money(t.cogs), money(t.shrink), `<span${neg(t.profit)}>${money(t.profit)}</span>`, `${t.margin_pct}%`]] : [])]))}`;
    body.onclick = e => {
      const b = e.target.closest('[data-mv]');
      if (!b) return;
      const [y, mo] = R.month.split('-').map(Number);
      const d = new Date(y, mo - 1 + Number(b.dataset.mv), 1);
      R.month = `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
      mensual(body);
    };
  }

  async function alertas(body) {
    const n = ++R.seq;
    const r = await call(`/report?from=${ago(29)}&to=${ago(0)}`);
    if (!r || n !== R.seq) return;
    const btn = (k, id, label) => `<button class="btn" data-${k}="${id}" style="min-height:40px">${label}</button>`;
    body.innerHTML = `<div class="two">
      ${panel('Pedir', tbl(['Producto', 'Stock', 'Mínimo'], r.low_stock.map(p => [esc(p.name), `<span${neg(p.stock)}>${num(p.stock)} ${esc(p.unit)}</span>`, num(p.min_stock)])))}
      ${panel('Por vencer (7 días)', tbl(['Producto', 'Vence', 'Stock'], r.expiring.map(p => [esc(p.name), esc(p.expires_at), num(p.stock)])))}
      ${panel('Nuevos por revisar', tbl(['Producto', 'Precio / costo', 'Creó', ''], r.to_review.map(p => [esc(p.name), `${money(p.price)} / ${money(p.cost)}`, esc(p.created_by_name || '—'), btn('rev', p.id, 'Revisado')]), 1))}
      ${panel('Conteos con diferencia (30 días)', tbl(['Producto', 'Dif.', 'Recibió', 'Fecha'], r.count_diffs.map(c => [esc(c.product), `<span${neg(c.diff)}>${num(c.diff)}</span>`, esc(c.user_name || '—'), esc(c.at.slice(0, 16))])))}
    </div>${panel('Ventas rechazadas', tbl(['Fecha', 'Cajero', 'Motivo', 'Venta', ''], r.rejected.map(x => [esc(x.at.slice(0, 16)), esc(x.user_name || '—'), esc(x.reason), x.total == null ? 'ilegible' : `${x.items} ítems · ${money(x.total)}`, btn('rej', x.id, 'Revisada')]), 3))}`;
    body.onclick = async e => {
      const b = e.target.closest('[data-rev],[data-rej]');
      if (!b) return;
      b.disabled = true;
      await call(b.dataset.rev ? `/products/${b.dataset.rev}/reviewed` : `/rejected/${b.dataset.rej}/reviewed`, {});
      alertas(body);
    };
  }

  const TABS = { resumen: ['Resumen', resumen], cierre: ['Cierre del día', cierre], mensual: ['Mensual', mensual], alertas: ['Alertas', alertas] };

  async function reportes() {
    content.innerHTML = `<section class="view">${head('Reportes')}<div class="chips" id="tabs">${Object.entries(TABS).map(([k, [l]]) => `<button class="chip ${k === R.tab ? 'on' : ''}" data-t="${k}">${l}</button>`).join('')}</div><div id="rb"></div></section>`;
    $('#tabs').onclick = e => {
      const b = e.target.closest('[data-t]');
      if (!b) return;
      R.tab = b.dataset.t;
      reportes();
    };
    await TABS[R.tab][1]($('#rb'));
  }

  const pickImage = () => new Promise(res => {
    const i = Object.assign(document.createElement('input'), { type: 'file', accept: 'image/*' });
    i.onchange = () => res(i.files[0]);
    i.click();
  });

  let saleDay = ago(0);
  async function ventas() {
    const n = ++R.seq;
    const res = await call(`/sales?date=${saleDay}`);
    if (n !== R.seq) return;
    const list = res || [];
    const paid = list.filter(s => s.status === 'pagado');
    const tok = encodeURIComponent(store.get('token') || '');
    content.innerHTML = `<section class="view">${head('Ventas', dateInput('sd', saleDay))}
      <div class="cards">${stat('Total del día', money(Math.round(paid.reduce((t, s) => t + s.total, 0) * 100) / 100))}${stat('Ventas', paid.length)}</div>
      <div class="rows">${list.map(s => `<div class="prow ${s.status === 'anulado' ? 'void' : ''}" data-id="${s.id}">
        <div class="main"><b>#${s.id} · ${hhmm(s.created_at)} · ${esc(s.user || '—')} <span class="tag">${s.pay === 'qr' ? 'QR' : 'Efectivo'}</span></b>
          <small>${s.items.map(i => `${esc(i.name)} × ${num(i.qty)}${i.unit === 'kg' ? ' kg' : ''}`).join(', ')}</small>
          ${s.status === 'anulado' ? `<small class="neg">Anulada por ${esc(s.voided_by_name || '—')} · ${esc(String(s.voided_at ?? '').slice(0, 16))}</small>` : ''}</div>
        <span class="stk">${money(s.total)}</span>
        <div class="acts">${s.pay === 'qr' && s.receipt ? `<a class="btn" target="_blank" rel="noopener" href="/receipts/${s.id}.jpg?t=${tok}">Ver comprobante</a>` : ''}
          ${s.pay === 'qr' && !s.receipt && s.status === 'pagado' ? '<span class="tag">Comprobante pendiente</span><button class="btn" data-att>Adjuntar</button>' : ''}
          ${s.status === 'pagado' ? '<button class="btn danger" data-void>Anular</button>' : ''}</div></div>`).join('') || '<p class="empty-msg">Sin ventas</p>'}</div></section>`;
    $('#sd').onchange = e => { saleDay = e.target.value || saleDay; ventas(); };
    content.querySelector('.rows').onclick = async e => {
      const id = +e.target.closest('.prow')?.dataset.id;
      if (e.target.closest('[data-void]') && await confirmSheet(`¿Anular la venta #${id}?`, 'Anular', 'El stock vuelve al inventario.')) {
        await call(`/sales/${id}/void`, {});
        ventas();
      } else if (e.target.closest('[data-att]')) {
        const f = await pickImage();
        if (f && await call(`/sales/${id}/receipt`, { image: await shrink(f) })) toast('Comprobante guardado', 'ok');
        ventas();
      }
    };
  }

  let cashDay = ago(0);
  async function caja() {
    const n = ++R.seq;
    const res = await call(`/cash?date=${cashDay}`);
    if (n !== R.seq) return;
    const list = res || [];
    const live = list.filter(c => !c.voided_at);
    const sum = t => Math.round(live.filter(c => c.type === t).reduce((a, c) => a + c.amount, 0) * 100) / 100;
    content.innerHTML = `<section class="view">${head('Caja', dateInput('cd2', cashDay))}
      <div class="cards">${stat('Ingresos', money(sum('ingreso')))}${stat('Gastos', money(sum('gasto')))}</div>
      <div class="rows">${list.map(c => `<div class="prow ${c.voided_at ? 'void' : ''}" data-id="${c.id}">
        <div class="main"><b>${c.type === 'gasto' ? '− Gasto' : '+ Ingreso'} · ${hhmm(c.created_at)} · ${esc(c.user || '—')}</b>
          <small>${esc(c.note)}</small>${c.voided_at ? `<small class="neg">Anulado ${esc(c.voided_at.slice(0, 16))}</small>` : ''}</div>
        <span class="stk">${money(c.amount)}</span>
        ${c.voided_at ? '' : '<div class="acts"><button class="btn danger" data-void>Anular</button></div>'}</div>`).join('') || '<p class="empty-msg">Sin movimientos</p>'}</div></section>`;
    $('#cd2').onchange = e => { cashDay = e.target.value || cashDay; caja(); };
    content.querySelector('.rows').onclick = async e => {
      const id = +e.target.closest('.prow')?.dataset.id;
      if (!e.target.closest('[data-void]') || !(await confirmSheet('¿Anular este movimiento?', 'Anular'))) return;
      await call(`/cash/${id}/void`, {});
      caja();
    };
  }

  Object.assign(views, { reportes, ventas, caja });
})();
