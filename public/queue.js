(function (root, f) { typeof module === 'object' ? module.exports = f() : Object.assign(root, f()); })(this, () => {
  const createQueue = (storage, send, key = 'sales_queue') => {
    const load = () => {
      try { const a = JSON.parse(storage.getItem(key)); return Array.isArray(a) ? a : []; } catch { return []; }
    };
    const save = a => storage.setItem(key, JSON.stringify(a));
    let running = null;

    const run = async () => {
      let sent = 0;
      for (let q = load(); q.length; q = load()) {
        try { await send(q[0]); } catch { break; }
        save(load().slice(1));
        sent++;
      }
      return { sent, left: load().length };
    };

    return {
      enqueue: sale => save([...load(), sale]),
      pending: load,
      flush: () => running || (running = run().finally(() => { running = null; })),
    };
  };
  return { createQueue };
});
