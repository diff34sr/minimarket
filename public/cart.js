(function (root, f) { typeof module === 'object' ? module.exports = f() : Object.assign(root, f()); })(this, () => {
  const lineSubtotal = (price, qty) => Math.round(Math.round(price * 100) * qty) / 100;
  const gramsToQty = g => round3(g / 1000);
  const round3 = n => Math.round(n * 1000) / 1000;

  const cartAdd = (items, product, qty = 1) => {
    const i = items.findIndex(it => it.product_id === product.product_id);
    if (i < 0) {
      const { product_id, name, unit, price } = product;
      return [...items, { product_id, name, unit, price, qty: round3(qty) }];
    }
    return items.map((it, j) => j === i ? { ...it, qty: round3(it.qty + qty) } : it);
  };

  const cartSet = (items, product_id, qty) => !(qty > 0)
    ? items.filter(it => it.product_id !== product_id)
    : items.map(it => it.product_id === product_id ? { ...it, qty: round3(qty) } : it);

  const cartTotal = items => Math.round(items.reduce((s, it) => s + lineSubtotal(it.price, it.qty), 0) * 100) / 100;

  const change = (total, received) =>
    typeof received !== 'number' || !Number.isFinite(received) || received < total ? null : Math.round((received - total) * 100) / 100;

  return { lineSubtotal, gramsToQty, cartAdd, cartSet, cartTotal, change };
});
