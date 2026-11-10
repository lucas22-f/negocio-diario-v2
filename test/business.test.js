import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../server.js';

// T3 of odd/tasks/stock-v2.md (S2/S4-S6): the app is Supabase-only, for the
// fixed identity pochoclos@negocio.com with an explicit allowed user id, and
// it reaches its data through the v2 sales RPC contract. Every test is public
// HTTP with a deterministic in-process fake of the PostgREST boundary and
// synthetic business data: no cloud, no real account and no v1 endpoint
// (public.sales) is ever touched. The stateful, real-SQL version of this
// contract lives in test/stock-api.test.js.

const ALLOWED_UID = '33333333-3333-3333-3333-333333333333';
const EMAIL = 'pochoclos@negocio.com';
const PASSWORD = 'contraseña-sintética-de-prueba';

const env = (extra = {}) => ({
  SUPABASE_URL: 'https://auth.test',
  SUPABASE_ANON_KEY: 'anon-key-for-tests',
  SUPABASE_ALLOWED_USER_ID: ALLOWED_UID,
  SUPABASE_SESSION_KEY: 'k'.repeat(32),
  ...extra,
});

// A deterministic fake of the exact PostgREST surface the app may use:
// /auth/v1 for the one identity, /rest/v1/rpc/v2_* for writes and GETs on the
// v2_sales table only. Direct table writes (POST/PATCH/DELETE on /rest/v1/v2_sales)
// are recorded as contract violations and never served, so any bypass of the
// RPC atomicity would be visible; the v1 table /rest/v1/sales is recorded and
// never served either.
function fakeSupabase() {
  let serial = 0;
  let rowSeq = 0;
  const rows = new Map(); // id -> sale row with row_seq
  const controls = { failAll: false };
  const rest = {
    calls: 0, mutations: 0, inserts: 0, updates: 0, deletes: 0, violations: 0, v1: 0,
  }; // mutations = write RPC attempts received; inserts/updates/deletes = write RPC successes
  const allUrls = [];
  const respond = (status, body) => new Response(
    status === 204 ? null : JSON.stringify(body),
    { status, headers: { 'content-type': 'application/json' } },
  );
  const row = entry => ({
    id: entry.id, date: entry.date, product: entry.product,
    payment: entry.payment, amount_cents: Number(entry.amountCents ?? entry.amount_cents),
    product_id: null, quantity: 1, row_seq: entry.row_seq,
  });
  const rpcError = (code, message) => respond(400, { code, message, details: null, hint: null });
  const fetchImpl = async (url, options = {}) => {
    allUrls.push(url);
    const parsed = new URL(url);
    assert.equal(parsed.host, 'auth.test');
    if (controls.failAll) throw new TypeError('fetch failed');
    if (parsed.pathname === '/rest/v1/sales') { rest.v1 += 1; throw new Error('unexpected v1 table call'); }
    const bearer = (options.headers?.authorization || '').replace(/^Bearer /, '');
    if (parsed.pathname === '/auth/v1/token' && parsed.searchParams.get('grant_type') === 'password') {
      const body = options.body ? JSON.parse(options.body) : {};
      if (body.email !== EMAIL || body.password !== PASSWORD) {
        return respond(400, { error: 'invalid_grant', message: 'Invalid login credentials' });
      }
      return respond(200, { access_token: `at-${++serial}`, refresh_token: `rt-${serial}`, token_type: 'bearer' });
    }
    if (parsed.pathname === '/auth/v1/user') {
      return respond(200, { id: ALLOWED_UID, email: EMAIL });
    }
    if (parsed.pathname === '/auth/v1/logout') {
      return respond(204, null);
    }
    const method = options.method || 'GET';
    if (parsed.pathname === '/rest/v1/v2_sales' && method !== 'GET') {
      rest.violations += 1; // direct table writes must never be attempted
      return respond(405, { message: 'writes go through the v2 RPC contract' });
    }
    if (parsed.pathname === '/rest/v1/v2_sales' && method === 'GET'
        && (parsed.searchParams.get('id') || parsed.searchParams.get('date'))) {
      rest.calls += 1;
      const id = parsed.searchParams.get('id')?.replace(/^eq\./, '');
      const date = parsed.searchParams.get('date')?.replace(/^eq\./, '');
      const found = [...rows.values()]
        .filter(entry => (id ? entry.id === id : entry.date === date))
        .sort((a, b) => a.row_seq - b.row_seq);
      return respond(200, found.map(row));
    }
    if (parsed.pathname === '/rest/v1/rpc/v2_create_sale' && method === 'POST') {
      rest.calls += 1;
      rest.mutations += 1;
      const p = JSON.parse(options.body);
      const current = rows.get(p.p_sale_id);
      if (current) {
        const sameContent = current.date === p.p_date && current.product === p.p_product
          && current.payment === p.p_payment
          && current.amount_cents === p.p_amount_cents
          && (current.product_id ?? null) === (p.p_product_id ?? null)
          && current.quantity === p.p_quantity;
        if (sameContent) return respond(200, row(current)); // idempotent replay, no new movement
        return rpcError('23505', 'Ese identificador ya corresponde a otra venta. No se guardaron cambios.');
      }
      const entry = {
        id: p.p_sale_id, date: p.p_date, product: p.p_product, payment: p.p_payment,
        amountCents: p.p_amount_cents, product_id: p.p_product_id ?? null,
        quantity: p.p_quantity, row_seq: ++rowSeq,
      };
      rows.set(entry.id, entry);
      rest.inserts += 1;
      return respond(200, row(entry));
    }
    if (parsed.pathname === '/rest/v1/rpc/v2_edit_sale' && method === 'POST') {
      rest.calls += 1;
      rest.mutations += 1;
      const p = JSON.parse(options.body);
      const current = rows.get(p.p_sale_id);
      if (!current) return rpcError('P0002', 'La venta ya no existe o se elimino desde otro dispositivo.');
      const matches = current.date === p.p_prev_date && current.product === p.p_prev_product
        && current.payment === p.p_prev_payment
        && current.amountCents === p.p_prev_amount_cents
        && (current.product_id ?? null) === (p.p_prev_product_id ?? null)
        && current.quantity === p.p_prev_quantity;
      if (!matches) return rpcError('40001', 'La venta cambio desde otro dispositivo. Cancela la edicion y volve a abrirla con los datos actualizados.');
      rest.updates += 1;
      const next = {
        ...current, date: p.p_date, product: p.p_product, payment: p.p_payment,
        amountCents: p.p_amount_cents, row_seq: ++rowSeq,
      };
      rows.set(next.id, next);
      return respond(200, row(next));
    }
    if (parsed.pathname === '/rest/v1/rpc/v2_delete_sale' && method === 'POST') {
      rest.calls += 1;
      rest.mutations += 1;
      const p = JSON.parse(options.body);
      const current = rows.get(p.p_sale_id);
      if (!current) return rpcError('P0002', 'La venta ya no existe o se elimino desde otro dispositivo.');
      const matches = current.date === p.p_prev_date && current.product === p.p_prev_product
        && current.payment === p.p_prev_payment
        && current.amountCents === p.p_prev_amount_cents
        && (current.product_id ?? null) === (p.p_prev_product_id ?? null)
        && current.quantity === p.p_prev_quantity;
      if (!matches) return rpcError('40001', 'La venta cambio desde otro dispositivo. Cancela la edicion y volve a abrirla con los datos actualizados.');
      rest.deletes += 1;
      rows.delete(current.id);
      return respond(200, row(current));
    }
    throw new Error(`unexpected Supabase call: ${parsed.pathname} ${method}`);
  };
  return {
    fetchImpl, rest, allUrls, controls,
    get stored() { return [...rows.values()].sort((a, b) => a.row_seq - b.row_seq); },
  };
}

async function listen(t, options) {
  const server = createApp(options);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
    server.closeAllConnections();
  }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = async (path, requestInit = {}) => {
    const response = await fetch(base + path, requestInit);
    const body = await response.json().catch(() => null);
    return { status: response.status, body, setCookie: response.headers.getSetCookie() };
  };
  const login = () => request('/api/session', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: base },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  const cookie = response => response.setCookie[0].split(';')[0];
  const withSession = (response, headers = {}) => ({ headers: { cookie: cookie(response), ...headers } });
  return { base, request, login, cookie, withSession };
}

const salePayload = (overrides = {}) => ({
  requestId: '00000000-0000-4000-8000-00000000000a', date: '2026-11-10',
  product: 'Bolsa pochoclos', payment: 'efectivo', amount: '2000', ...overrides,
});

test('configured v2 app serves the sales contract only through RPC and v2_sales GETs, with the distinct v2_session cookie', async t => {
  const fake = fakeSupabase();
  const app = await listen(t, { env: env(), supabaseFetch: fake.fetchImpl });

  const login = await app.login();
  assert.equal(login.status, 200, 'the fixed synthtetic identity logs in through the same public session flow');
  assert.match(login.setCookie[0], /^v2_session=/, 'the v2 cookie name is distinct from any other deployment');
  assert.doesNotMatch(login.setCookie[0], /^session=/);
  const oldName = await app.request('/api/session', {
    headers: { cookie: `session=${app.cookie(login).slice('v2_session='.length)}` },
  });
  assert.deepEqual(oldName, { status: 200, body: { status: 'anonymous' }, setCookie: [] },
    'a foreign-named cookie is never read: the v2 container name is exclusive');

  const anonymous = await app.request('/api/sales?date=2026-11-10');
  assert.deepEqual(anonymous, {
    status: 401, body: { error: { code: 'UNAUTHENTICATED', message: 'Iniciá sesión para continuar.' } }, setCookie: [],
  });
  assert.equal(fake.rest.calls, 0, 'no data access before the session is verified');

  const sale = await app.request('/api/sales', {
    method: 'POST', headers: { 'content-type': 'application/json', origin: app.base, ...app.withSession(login).headers },
    body: JSON.stringify(salePayload()),
  });
  assert.equal(sale.status, 201, 'a new sale is stored');
  assert.deepEqual(sale.body, {
    sale: {
      id: salePayload().requestId, date: '2026-11-10', product: 'Bolsa pochoclos',
      payment: 'efectivo', amountCents: 200000, productId: null, quantity: 1,
    },
    replayed: false, storage: 'supabase',
  }, 'the public sale shape keeps its original keys and adds the stock link fields');

  const replay = await app.request('/api/sales', {
    method: 'POST', headers: { 'content-type': 'application/json', origin: app.base, ...app.withSession(login).headers },
    body: JSON.stringify(salePayload()),
  });
  assert.equal(replay.status, 200);
  assert.deepEqual(replay.body, {
    sale: sale.body.sale, replayed: true, storage: 'supabase',
  }, 'an exact replay of the same idempotency id is a replay');

  const conflict = await app.request('/api/sales', {
    method: 'POST', headers: { 'content-type': 'application/json', origin: app.base, ...app.withSession(login).headers },
    body: JSON.stringify(salePayload({ product: 'Otro producto' })),
  });
  assert.equal(conflict.status, 409);
  assert.deepEqual(conflict.body.error, {
    code: 'ID_CONFLICT', message: 'Ese identificador ya corresponde a otra venta. No se guardaron cambios.',
  }, 'a different sale under a taken id rejects without changing stored data');
  assert.equal(conflict.setCookie.length, 1, 'the verified session is deliberately reissued');
  assert.equal(fake.rest.inserts, 1, 'exactly one create RPC succeeded');
  assert.equal(fake.rest.mutations, 1, 'the replay and the conflict were answered from the honest GET and never wrote again');
  assert.equal(fake.rest.calls, 4, 'each append attempt consulted the table exactly once (GET), plus the single write RPC for the only new content');

  const list = await app.request('/api/sales?date=2026-11-10', app.withSession(login));
  assert.deepEqual(list.body, {
    date: '2026-11-10', currency: 'ARS', storage: 'supabase',
    sales: [sale.body.sale],
  }, 'the GET keeps the existing public list contract');

  const edited = await app.request('/api/sales', {
    method: 'PUT', headers: { 'content-type': 'application/json', origin: app.base, ...app.withSession(login).headers },
    body: JSON.stringify({ ...salePayload({ amount: '2500,50' }), previous: salePayload() }),
  });
  assert.equal(edited.status, 200, 'an edit with the exact previous snapshot succeeds');
  assert.deepEqual(JSON.parse(JSON.stringify(edited.body.sale)), {
    id: sale.body.sale.id, date: '2026-11-10', product: 'Bolsa pochoclos',
    payment: 'efectivo', amountCents: 250050, productId: null, quantity: 1,
  });
  assert.equal(fake.rest.updates, 1, 'exactly one edit RPC ran');

  const lostRace = await app.request('/api/sales', {
    method: 'PUT', headers: { 'content-type': 'application/json', origin: app.base, ...app.withSession(login).headers },
    body: JSON.stringify({ ...salePayload({ amount: '3000' }), previous: salePayload() }),
  });
  assert.equal(lostRace.status, 409);
  assert.deepEqual(lostRace.body.error, {
    code: 'SALE_CONFLICT',
    message: 'La venta cambió desde otro dispositivo. Cancelá la edición y volvé a abrirla con los datos actualizados.',
  }, 'an edit against a stale previous snapshot loses instead of overwriting');

  const removed = await app.request('/api/sales', {
    method: 'DELETE', headers: { 'content-type': 'application/json', origin: app.base, ...app.withSession(login).headers },
    body: JSON.stringify({ id: sale.body.sale.id, previous: salePayload({ amount: '2500,50' }) }),
  });
  assert.deepEqual(removed.body.sale, { ...edited.body.sale },
    'the delete sends the full previous snapshot and returns the removed row');
  assert.equal(fake.rest.deletes, 1, 'exactly one delete RPC ran');
  assert.deepEqual(await app.request('/api/sales?date=2026-11-10', app.withSession(login)).then(r => r.body.sales), []);

  assert.equal(fake.rest.v1, 0, 'the v1 public.sales table is never touched');
  assert.equal(fake.rest.violations, 0, 'the app never attempted a direct table write');
  assert.ok(fake.allUrls.every(url => url.includes('/rest/v1/v2_sales') || url.includes('/rest/v1/rpc/v2_') || url.includes('/auth/v1')),
    'every data call is a v2_sales GET or a documented v2 RPC');
  assert.ok(fake.allUrls.filter(url => url.includes('/rest/v1')).length > 0, 'the v2 boundary was really exercised');
});

test('rejected sales never touch Supabase, and an unconfigured app fails closed with no blob or local fallback', async t => {
  const unconfiguredApp = await listen(t, { env: {}, supabaseFetch: () => { throw new Error('no network expected'); } });
  assert.deepEqual(await unconfiguredApp.request('/api/sales?date=2026-11-10'), {
    status: 503, body: { error: { code: 'SESSION_CONFIG', message: 'Falta configurar la sesión de Supabase.' } }, setCookie: [],
  }, 'without configuration the GET fails closed, it never serves a local file or a v1 fallback');
  const rejectedWrite = await unconfiguredApp.request('/api/sales', {
    method: 'POST', headers: { 'content-type': 'application/json', origin: unconfiguredApp.base },
    body: JSON.stringify(salePayload()),
  });
  assert.equal(rejectedWrite.status, 503, 'without configuration the POST fails closed too');
  assert.equal(rejectedWrite.body.error.code, 'SESSION_CONFIG');

  // Explicit allowed user id is mandatory: there is no v1 default identity.
  const noUserEnv = env();
  delete noUserEnv.SUPABASE_ALLOWED_USER_ID;
  const noUser = await listen(t, {
    env: noUserEnv,
    supabaseFetch: () => { throw new Error('no network expected'); },
  });
  const noUserResponse = await noUser.request('/api/sales?date=2026-11-10');
  assert.deepEqual(noUserResponse, {
    status: 503, body: { error: { code: 'SESSION_CONFIG', message: 'Falta configurar la sesión de Supabase.' } }, setCookie: [],
  }, 'a missing explicit v2 user id must not fall back to any default identity');
  const malformedUser = await listen(t, { env: env({ SUPABASE_ALLOWED_USER_ID: 'not-a-uuid' }), supabaseFetch: () => { throw new Error('no network expected'); } });
  assert.equal((await malformedUser.request('/api/sales?date=2026-11-10')).status, 503);

  const fake = fakeSupabase();
  const app = await listen(t, { env: env(), supabaseFetch: fake.fetchImpl });
  const login = await app.login();
  const storedBefore = fake.stored.length;
  const receiptsBefore = fake.rest.mutations;
  const invalid = await app.request('/api/sales', {
    method: 'POST', headers: { 'content-type': 'application/json', origin: app.base, ...app.withSession(login).headers },
    body: JSON.stringify(salePayload({ amount: '0' })),
  });
  assert.equal(invalid.status, 400);
  assert.deepEqual(invalid.body.error, {
    code: 'INVALID_AMOUNT',
    message: 'Ingresá un monto mayor a 0 y hasta 999999999,99, con hasta 2 decimales y sin miles.',
  }, 'an invalid sale reuses the same public validation contract');
  assert.equal(invalid.setCookie.length, 0, 'validation precedes any identity work: an invalid body never renews a session');
  assert.equal(fake.rest.inserts, 0, 'a validated-out sale never reaches Supabase');
  assert.equal(fake.rest.mutations, receiptsBefore, 'no write attempt even reaches the RPC for an invalid request');
  assert.equal(fake.stored.length, storedBefore, 'rejected input leaves stored data unchanged');

  const missing = await app.request('/api/sales', {
    method: 'DELETE', headers: { 'content-type': 'application/json', origin: app.base, ...app.withSession(login).headers },
    body: JSON.stringify({ id: '00000000-0000-4000-8000-999999999999', previous: salePayload({ requestId: '00000000-0000-4000-8000-999999999999' }) }),
  });
  assert.equal(missing.status, 404);
  assert.deepEqual(missing.body.error, {
    code: 'NOT_FOUND', message: 'La venta ya no existe o se eliminó desde otro dispositivo.',
  }, 'an unknown sale id keeps the existing public contract');
  assert.equal(fake.rest.mutations, receiptsBefore + 1, 'the unknown-id delete attempted its RPC exactly once');
  assert.equal(fake.rest.deletes, 0, 'removing an absent row changes nothing');
  assert.equal(fake.stored.length, storedBefore, 'the table stays unchanged after the honest 404');

  const missingPrevious = await app.request('/api/sales', {
    method: 'DELETE', headers: { 'content-type': 'application/json', origin: app.base, ...app.withSession(login).headers },
    body: JSON.stringify({ id: '00000000-0000-4000-8000-999999999998' }),
  });
  assert.equal(missingPrevious.status, 400, 'a delete without the full previous snapshot is rejected as invalid input');
  // Validation precedence is uniform: the date/type fields of the missing
  // previous snapshot are reached before the id match, so INVALID_DATE wins —
  // the same precedence a PUT without previous has always had.
  assert.equal(missingPrevious.body.error.code, 'INVALID_DATE');
  assert.equal(fake.rest.mutations, receiptsBefore + 1, 'a rejected delete never wrote');

  const crossOrigin = await app.request('/api/sales', {
    method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://invasor.example' },
    body: JSON.stringify(salePayload({ requestId: '00000000-0000-4000-8000-00000000000b' })),
  });
  assert.deepEqual(crossOrigin, {
    status: 403, body: { error: { code: 'FORBIDDEN_ORIGIN', message: 'Origen no autorizado.' } }, setCookie: [],
  }, 'cross-origin mutations stay rejected exactly as before');
  assert.equal(fake.rest.mutations, receiptsBefore + 1, 'cross-origin mutations never reach the RPC');
});
