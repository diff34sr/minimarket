process.env.DB_PATH = ':memory:';
const server = require('../server');

exports.start = async () => {
  await new Promise(r => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (path, { body, token } = {}) => {
    const res = await fetch(base + path, {
      method: body ? 'POST' : 'GET',
      headers: { 'content-type': 'application/json', ...(token && { 'x-token': token }) },
      body: body && JSON.stringify(body),
    });
    return { status: res.status, json: await res.json() };
  };
  const tokens = {
    admin: (await call('/api/login', { body: { pin: '1234' } })).json.token,
    cajero: (await call('/api/login', { body: { pin: '0000' } })).json.token,
  };
  return { base, call, tokens, stop: () => server.close() };
};
