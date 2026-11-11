import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../server.js';
import { SalesError } from '../lib/sales.js';
import { createSupabaseStockDaysApi } from '../lib/stock-days.js';
import { createSupabaseSalesApi } from '../lib/supabase.js';
import {
  createStockDb, applyMigration, seedAuthUser, createRestStockFetch,
  TEST_UID, TEST_EMAIL,
} from './helpers/stock-db.js';

// T2 of odd/tasks/daily-stand-stock.md (S1-S5): public HTTP tests for the
// daily stock API and the daily-sale channel, executed against REAL SQL. The
// in-memory PGlite fixture is wrapped in the minimal PostgREST boundary of
// test/helpers/stock-db.js, so these tests observe the exact contract the SQL
// layer enforces: RPC-only writes, the additive dailyStock sale opt-in with
// exact legacy shapes preserved, and the load/replenish/copy CAS behavior.
// Everything is synthetic: no cloud, no real account, no v1 access.

const EMAIL = TEST_EMAIL;
const PASSWORD = 'contraseña-sintética-de-prueba';

const env = (extra = {}) => ({
  SUPABASE_URL: 'https://auth.test',
  SUPABASE_ANON_KEY: 'anon-key-for-tests',
  SUPABASE_ALLOWED_USER_ID: TEST_UID,
  SUPABASE_SESSION_KEY: 'k'.repeat(32),
  ...extra,
});

let sharedDb;
let bridge; // bound to sharedDb, default object row shape
test.before(async () => {
  sharedDb = await createStockDb();
  await seedAuthUser(sharedDb);
  await applyMigration(sharedDb);
  bridge = createRestStockFetch(sharedDb);
});

test.after(async () => {
  if (sharedDb) await sharedDb.close();
});

function createAuthFetch() {
  let serial = 0;
  const respond = (status, body) => new Response(
    status === 204 ? null : JSON.stringify(body),
    { status, headers: { 'content-type': 'application/json' } },
  );
  return async (url, init = {}) => {
    const parsed = new URL(url);
    const bearer = (init.headers?.authorization || '').replace(/^Bearer /, '');
    if (parsed.pathname === '/auth/v1/token' && parsed.searchParams.get('grant_type') === 'password') {
      const body = init.body ? JSON.parse(init.body) : {};
      if (body.email !== EMAIL || body.password !== PASSWORD) {
        return respond(400, { error: 'invalid_grant', message: 'Invalid login credentials' });
      }
      return respond(200, { access_token: `at-${++serial}`, refresh_token: `rt-${serial}`, token_type: 'bearer' });
    }
    if (parsed.pathname === '/auth/v1/user') {
      if (!bearer) return respond(401, { error: 'bad_jwt' });
      return respond(200, { id: TEST_UID, email: EMAIL });
    }
    throw new Error(`unexpected auth call: ${parsed.pathname}`);
  };
}

function stockOptions(bridgeInstance) {
  const auth = createAuthFetch();
  const fetchImpl = (url, init) => new URL(url).pathname.startsWith('/auth/v1/')
    ? auth(url, init)
    : bridgeInstance.fetchImpl(url, init);
  return { env: env(), supabaseFetch: fetchImpl };
}

// Records the RAW wire body of every RPC call (the exact JSON the client
// handed to fetch) so tests can assert the transport shape a hosted
// PostgREST would see, not just the decoded SQL result.
function recordingOptions(bridgeInstance, tape) {
  const options = stockOptions(bridgeInstance);
  const inner = options.supabaseFetch;
  options.supabaseFetch = async (url, init = {}) => {
    const path = new URL(url).pathname;
    if (path.startsWith('/rest/v1/rpc/') && init.body !== undefined) {
      tape.push({ rpc: path.slice('/rest/v1/rpc/'.length), body: JSON.parse(init.body) });
    }
    return inner(url, init);
  };
  return options;
}

// Simulates the OLD broken transport: the known jsonb RPC arguments are
// pre-stringified to JSON text before hitting the wire, exactly what a
// hosted PostgREST receives as a jsonb STRING scalar (never decoded back).
function legacyStringifiedFetch(options) {
  const inner = options.supabaseFetch;
  return (url, init = {}) => {
    const path = new URL(url).pathname;
    if (path.startsWith('/rest/v1/rpc/') && init.body !== undefined) {
      const body = JSON.parse(init.body);
      const stringified = {};
      let changed = false;
      for (const key of ['p_items', 'p_sale', 'p_previous']) {
        if (body[key] !== undefined && typeof body[key] === 'object') {
          stringified[key] = JSON.stringify(body[key]);
          changed = true;
        }
      }
      if (changed) return inner(url, { ...init, body: JSON.stringify({ ...body, ...stringified }) });
    }
    return inner(url, init);
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
  async function enter() {
    const response = await request('/api/session', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: base },
      body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
    });
    assert.equal(response.status, 200, 'the synthetic identity logs in');
    const cookie = response.setCookie[0].split(';')[0];
    const headers = { cookie, 'content-type': 'application/json', origin: base };
    const send = (method, path, body) => request(path, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const get = path => request(path, { headers: { cookie } });
    return { send, get, cookie };
  }
  return { base, request, enter };
}

// --- shared SQL state helpers --------------------------------------------

const productRow = async name => {
  const { rows } = await sharedDb.query('select stock, archived from public.v2_products where name = $1', [name]);
  return rows[0] ?? null;
};
const countSales = async () => (await sharedDb.query('select count(*)::int as n from public.v2_sales')).rows[0].n;
const totalMovements = async () => {
  const { rows } = await sharedDb.query('select count(*)::int as n from public.v2_stock_movements');
  return rows[0].n;
};
const dailyStockRows = async (date, stand) => {
  const { rows } = await sharedDb.query(
    'select initial_load, replenished from public.v2_daily_stock where date = $1 and stand = $2 order by product_id',
    [date, stand]);
  return rows;
};

// ---------------------------------------------------------------------------

test('stock-days GET: an unloaded day reads as zero for both stands in exactly one call, invalid dates fail before auth', async t => {
  const app = await listen(t, stockOptions(bridge));
  const { send, get } = await app.enter();
  const product = (await send('POST', '/api/products', { name: 'Diaria Bolsa' })).body.product;
  const DATE = '2030-01-01';

  const rpcBefore = bridge.calls.rpc;
  const listed = await get(`/api/stock-days?date=${DATE}`);
  assert.equal(listed.status, 200);
  assert.deepEqual(listed.body, {
    date: DATE, currency: 'ARS', storage: 'supabase',
    rows: [
      { productId: product.id, product: 'Diaria Bolsa', priceCents: null, stand: 'fixed', initialLoad: 0, loaded: 0, sold: 0, available: 0 },
      { productId: product.id, product: 'Diaria Bolsa', priceCents: null, stand: 'mobile', initialLoad: 0, loaded: 0, sold: 0, available: 0 },
    ],
  }, 'an unconfigured day is an explicit zero for both stands, no load is fabricated');
  assert.equal(bridge.calls.rpc, rpcBefore + 1,
    'both stands arrive in exactly one v2_read_daily_stock call (no second read)');

  const anonymous = await app.request(`/api/stock-days?date=${DATE}`);
  assert.equal(anonymous.status, 401, 'a well-formed read still needs a session');
  assert.equal(anonymous.body.error.code, 'UNAUTHENTICATED');

  const malformedNoAuth = [
    ['/api/stock-days?date=2030-13-01', 'INVALID_DATE'],
    ['/api/stock-days?date=2030-01-01&date=2030-01-02', 'INVALID_DATE'],
    ['/api/stock-days', 'INVALID_DATE'],
  ];
  const rpcAfterValid = bridge.calls.rpc;
  for (const [path, code] of malformedNoAuth) {
    const result = await app.request(path);
    assert.equal(result.status, 400, `${path} fails as invalid input`);
    assert.equal(result.body.error.code, code);
  }
  assert.equal(bridge.calls.rpc, rpcAfterValid, 'invalid dates never touch storage');
});

test('stock-days load defines the initial load with per-item CAS; replenish adds units without touching it', async t => {
  const app = await listen(t, stockOptions(bridge));
  const { send, get } = await app.enter();
  const product = (await send('POST', '/api/products', { name: 'Carga Diaria', price: '10', stock: 999 })).body.product;
  const DATE = '2030-01-02';

  const loaded = await send('POST', '/api/stock-days', {
    action: 'load', date: DATE, stand: 'fixed',
    items: [{ productId: product.id, initial: 5, prevInitial: null }],
  });
  assert.deepEqual(loaded.body, { storage: 'supabase', action: 'load', applied: 1 });

  const readRow = async stand => {
    const listed = await get(`/api/stock-days?date=${DATE}`);
    return listed.body.rows.find(row => row.productId === product.id && row.stand === stand);
  };
  assert.deepEqual(await readRow('fixed'), {
    productId: product.id, product: 'Carga Diaria', priceCents: 1000, stand: 'fixed',
    initialLoad: 5, loaded: 5, sold: 0, available: 5,
  }, 'the initial load shows as Cantidad cargada with zero sold');
  assert.equal((await readRow('mobile')).loaded, 0, 'the other stand is untouched');

  // Rewrite with the observed previous value: still defines the day's initial.
  const rewritten = await send('POST', '/api/stock-days', {
    action: 'load', date: DATE, stand: 'fixed', items: [{ productId: product.id, initial: 7, prevInitial: 5 }],
  });
  assert.deepEqual(rewritten.body, { storage: 'supabase', action: 'load', applied: 1 });
  assert.equal((await readRow('fixed')).initialLoad, 7);

  // A stale observed value loses the CAS and leaves the whole day untouched.
  const stale = await send('POST', '/api/stock-days', {
    action: 'load', date: DATE, stand: 'fixed', items: [{ productId: product.id, initial: 2, prevInitial: 5 }],
  });
  assert.deepEqual(stale, {
    status: 409,
    body: { error: { code: 'LOAD_CONFLICT', message: 'La carga cambió desde otro dispositivo. Volvé a abrir el día con los datos actualizados.' } },
    setCookie: stale.setCookie,
  });
  assert.equal((await readRow('fixed')).initialLoad, 7, 'a lost CAS load never rewrote the day');

  // An exact replay of the observed state is naturally idempotent.
  const replay = await send('POST', '/api/stock-days', {
    action: 'load', date: DATE, stand: 'fixed', items: [{ productId: product.id, initial: 7, prevInitial: 7 }],
  });
  assert.equal(replay.status, 200);
  assert.equal((await readRow('fixed')).initialLoad, 7);

  // Replenish adds units during the day and never rewrites the initial load.
  const replenished = await send('POST', '/api/stock-days', {
    action: 'replenish', date: DATE, stand: 'fixed',
    items: [{ productId: product.id, replenished: 2, prevReplenished: null }],
  });
  assert.deepEqual(replenished.body, { storage: 'supabase', action: 'replenish', applied: 1 });
  assert.deepEqual(await readRow('fixed'), {
    productId: product.id, product: 'Carga Diaria', priceCents: 1000, stand: 'fixed',
    initialLoad: 7, loaded: 9, sold: 0, available: 9,
  }, 'initial stays 7; loaded is initial + replenished');
  assert.equal((await dailyStockRows(DATE, 'fixed'))[0].replenished, 2,
    'replenished is kept as its own separate column');

  const staleReplenish = await send('POST', '/api/stock-days', {
    action: 'replenish', date: DATE, stand: 'fixed',
    items: [{ productId: product.id, replenished: 4, prevReplenished: 0 }],
  });
  assert.equal(staleReplenish.status, 409);
  assert.equal(staleReplenish.body.error.code, 'LOAD_CONFLICT');
  assert.equal((await dailyStockRows(DATE, 'fixed'))[0].replenished, 2,
    'a lost replenish CAS changed nothing');

  // Replenishing a stand with no initial load creates its own row.
  const mobileAdd = await send('POST', '/api/stock-days', {
    action: 'replenish', date: DATE, stand: 'mobile',
    items: [{ productId: product.id, replenished: 3, prevReplenished: null }],
  });
  assert.equal(mobileAdd.status, 200);
  assert.deepEqual(await readRow('mobile'), {
    productId: product.id, product: 'Carga Diaria', priceCents: 1000, stand: 'mobile',
    initialLoad: 0, loaded: 3, sold: 0, available: 3,
  });
  assert.equal((await productRow('Carga Diaria')).stock, 999,
    'the daily channel never consumed the global stock');
});

test('stock-days validation: malformed bodies answer before auth and never touch storage', async t => {
  const app = await listen(t, stockOptions(bridge));
  const session = await app.enter();
  const productId = (await session.send('POST', '/api/products', { name: 'Validación diaria' })).body.product.id;
  const DATE = '2030-01-03';

  // Requests below deliberately carry NO cookie: validation-before-auth means
  // a malformed body answers 400 before the session gate is ever consulted.
  const anonymousPost = (body, extraHeaders = {}) => app.request('/api/stock-days', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: app.base, ...extraHeaders },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

  const cases = [
    [{ action: 'load', date: DATE, stand: 'fixed', items: [] }, 'INVALID_ITEMS'],
    [{ action: 'load', date: DATE, stand: 'fixed' }, 'INVALID_ITEMS'],
    [{ action: 'load', date: DATE, stand: 'fixed', items: 'no' }, 'INVALID_ITEMS'],
    [{ action: 'load', date: DATE, items: [{ productId, initial: 5, prevInitial: null }] }, 'INVALID_STAND'],
    [{ action: 'load', date: DATE, stand: 'other', items: [{ productId, initial: 5, prevInitial: null }] }, 'INVALID_STAND'],
    [{ action: 'load', date: '2030-02-30', stand: 'fixed', items: [{ productId, initial: 5, prevInitial: null }] }, 'INVALID_DATE'],
    [{ action: 'load', stand: 'fixed', items: [{ productId, initial: 5, prevInitial: null }] }, 'INVALID_DATE'],
    [{ action: 'load', date: DATE, stand: 'fixed', items: [{ productId, initial: '5', prevInitial: null }] }, 'INVALID_ITEMS'],
    [{ action: 'load', date: DATE, stand: 'fixed', items: [{ productId, initial: 1000001, prevInitial: null }] }, 'INVALID_ITEMS'],
    [{ action: 'load', date: DATE, stand: 'fixed', items: [{ productId, initial: -1, prevInitial: null }] }, 'INVALID_ITEMS'],
    [{ action: 'load', date: DATE, stand: 'fixed', items: [{ initial: 5, prevInitial: null }] }, 'INVALID_ITEMS'],
    [{ action: 'load', date: DATE, stand: 'fixed', items: [{ productId: 'not-a-uuid', initial: 5, prevInitial: null }] }, 'INVALID_PRODUCT_ID'],
    [{ action: 'load', date: DATE, stand: 'fixed', items: [
      { productId, initial: 1, prevInitial: null }, { productId, initial: 2, prevInitial: null },
    ] }, 'INVALID_ITEMS'],
    [{ action: 'replenish', date: DATE, stand: 'fixed', items: [{ productId, replenished: '2', prevReplenished: null }] }, 'INVALID_ITEMS'],
    [{ action: 'replenish', date: DATE, stand: 'fixed', items: [{ productId, replenished: 2, prevReplenished: 'x' }] }, 'INVALID_ITEMS'],
    [{ action: 'copy', date: DATE, stand: 'fixed', items: [{ productId, initial: 1 }] }, 'INVALID_ITEMS'],
    [{ action: 'copy', date: DATE, stand: 'fixed', allowNegative: 'sí' }, 'INVALID_ALLOW_NEGATIVE'],
    [{ action: 'delete', date: DATE, stand: 'fixed' }, 'INVALID_ACTION'],
    [{ date: DATE, stand: 'fixed' }, 'INVALID_ACTION'],
    [{ action: 'load', date: DATE, stand: 'fixed', items: [{ productId, initial: 1, prevInitial: null }], allowNegative: 'sí' }, 'INVALID_ALLOW_NEGATIVE'],
  ];
  const rpcBefore = bridge.calls.rpc;
  for (const [body, code] of cases) {
    const result = await anonymousPost(body);
    assert.equal(result.status, 400, `malformed body must fail before auth: ${JSON.stringify(body)}`);
    assert.equal(result.body.error.code, code, `unexpected code for ${JSON.stringify(body)}`);
  }
  assert.equal(bridge.calls.rpc, rpcBefore, 'no malformed body reached storage');

  const crossOrigin = await anonymousPost(
    { action: 'load', date: DATE, stand: 'fixed', items: [{ productId, initial: 1, prevInitial: null }] },
    { origin: 'https://invasor.example' });
  assert.equal(crossOrigin.status, 403);
  assert.equal(crossOrigin.body.error.code, 'FORBIDDEN_ORIGIN');

  const wrongType = await app.request('/api/stock-days', {
    method: 'POST', headers: { 'content-type': 'text/plain', origin: app.base }, body: '{}',
  });
  assert.equal(wrongType.status, 415);
  assert.equal(wrongType.body.error.code, 'CONTENT_TYPE');

  const put = await app.request('/api/stock-days', {
    method: 'PUT', headers: { 'content-type': 'application/json', origin: app.base }, body: '{}',
  });
  assert.equal(put.status, 405);
  assert.equal(put.body.error.code, 'METHOD_NOT_ALLOWED');
});

test('stock-days copy: the previous calendar day initial quantities only, refusal when the day already has its own load', async t => {
  const app = await listen(t, stockOptions(bridge));
  const { send, get } = await app.enter();
  const product = (await send('POST', '/api/products', { name: 'Copia Diaria' })).body.product;
  const SOURCE = '2030-01-04', DEST = '2030-01-05', ORPHAN = '2030-01-07';
  const readRow = async (date, stand) => {
    const listed = await get(`/api/stock-days?date=${date}`);
    return listed.body.rows.find(row => row.productId === product.id && row.stand === stand);
  };

  await send('POST', '/api/stock-days', {
    action: 'load', date: SOURCE, stand: 'fixed', items: [{ productId: product.id, initial: 4, prevInitial: null }],
  });
  await send('POST', '/api/stock-days', {
    action: 'replenish', date: SOURCE, stand: 'fixed', items: [{ productId: product.id, replenished: 1, prevReplenished: null }],
  });

  const copied = await send('POST', '/api/stock-days', { action: 'copy', date: DEST, stand: 'fixed' });
  assert.deepEqual(copied.body, { storage: 'supabase', action: 'copy', applied: 1 });
  assert.deepEqual(await readRow(DEST, 'fixed'), {
    productId: product.id, product: 'Copia Diaria', priceCents: null, stand: 'fixed',
    initialLoad: 4, loaded: 4, sold: 0, available: 4,
  }, 'the copy carries the prepared initial quantities, never the replenishments');

  const again = await send('POST', '/api/stock-days', { action: 'copy', date: DEST, stand: 'fixed' });
  assert.deepEqual(again, {
    status: 409,
    body: { error: { code: 'DAY_ALREADY_LOADED', message: 'EL_DIA_YA_TIENE_CARGA: el día ya tiene su propia carga y no se pisa.' } },
    setCookie: again.setCookie,
  }, 'a conflicting copy is refused, never silently overwritten');
  assert.equal((await readRow(DEST, 'fixed')).initialLoad, 4, 'the refused copy changed nothing');

  const crossStand = await send('POST', '/api/stock-days', { action: 'copy', date: DEST, stand: 'mobile' });
  assert.equal(crossStand.status, 200, 'a copy always reads the SAME stand of the previous day only');
  assert.deepEqual(crossStand.body, { storage: 'supabase', action: 'copy', applied: 0 },
    'the previous day has no mobile load: a successful no-op, never a fabricated one');

  const empty = await send('POST', '/api/stock-days', { action: 'copy', date: ORPHAN, stand: 'fixed' });
  assert.deepEqual(empty.body, { storage: 'supabase', action: 'copy', applied: 0 },
    'a previous day without load copies nothing');
  assert.equal((await dailyStockRows(ORPHAN, 'fixed')).length, 0,
    'absence of rows IS the zero default: no load rows were fabricated');
});

test('daily sales: the dailyStock opt-in consumes the daily load, never the global stock, and legacy shapes stay exact', async t => {
  const app = await listen(t, stockOptions(bridge));
  const { send, get } = await app.enter();
  const product = (await send('POST', '/api/products', { name: 'Venta Diaria', stock: 0 })).body.product;
  const DATE = '2030-02-01';
  await send('POST', '/api/stock-days', {
    action: 'load', date: DATE, stand: 'fixed', items: [{ productId: product.id, initial: 5, prevInitial: null }],
  });
  const dailyDraft = {
    requestId: 'dddd0000-0000-4000-8000-0000000000aa', date: DATE, product: 'Venta Diaria',
    payment: 'efectivo', amount: '3000', productId: product.id, quantity: 3, stand: 'fixed', dailyStock: true,
  };
  const movementsBeforeSale = await totalMovements();

  const saved = await send('POST', '/api/sales', dailyDraft);
  assert.equal(saved.status, 201);
  assert.deepEqual(saved.body.sale, {
    id: 'dddd0000-0000-4000-8000-0000000000aa', date: DATE, product: 'Venta Diaria', payment: 'efectivo',
    amountCents: 300000, productId: product.id, quantity: 3, stand: 'fixed', dailyStock: true,
  }, 'a daily sale is tagged and attributed');
  assert.equal((await productRow('Venta Diaria')).stock, 0,
    'the daily sale never touched the global stock (which is 0 here)');
  assert.equal(await totalMovements(), movementsBeforeSale,
    'the daily channel writes no global movement');

  const shortage = await send('POST', '/api/sales', {
    ...dailyDraft, requestId: 'dddd0000-0000-4000-8000-0000000000ab', quantity: 5,
  });
  assert.equal(shortage.status, 409);
  assert.equal(shortage.body.error.code, 'INSUFFICIENT_STOCK');
  assert.equal(shortage.body.error.message, 'STOCK_INSUFICIENTE: stock=2, solicitado=5',
    'the shortage reports the DAILY availability, not the global stock');
  assert.equal(await countSales(), 1);

  const oversold = await send('POST', '/api/sales', {
    ...dailyDraft, requestId: 'dddd0000-0000-4000-8000-0000000000ac', quantity: 5, allowNegative: true,
  });
  assert.equal(oversold.status, 201, 'an explicit negative confirmation stores the oversell');

  const day = await get(`/api/stock-days?date=${DATE}`);
  const row = day.body.rows.find(r => r.productId === product.id && r.stand === 'fixed');
  assert.deepEqual({ sold: row.sold, available: row.available, loaded: row.loaded }, { sold: 8, available: -3, loaded: 5 });

  const list = await get(`/api/sales?date=${DATE}`);
  assert.deepEqual(list.body.sales.map(sale => ({
    id: sale.id, dailyStock: sale.dailyStock ?? null, stand: sale.stand,
  })), [
    { id: 'dddd0000-0000-4000-8000-0000000000aa', dailyStock: true, stand: 'fixed' },
    { id: 'dddd0000-0000-4000-8000-0000000000ac', dailyStock: true, stand: 'fixed' },
  ], 'tagged sales expose dailyStock:true; the key never appears on legacy rows');

  // Validation of the opt-in happens before auth and never touches storage.
  const optInCases = [
    [{ ...dailyDraft, requestId: 'dddd0000-0000-4000-8000-0000000000ad', dailyStock: 'yes' }, 'INVALID_DAILY_STOCK'],
    [{ ...dailyDraft, requestId: 'dddd0000-0000-4000-8000-0000000000ae', dailyStock: 1 }, 'INVALID_DAILY_STOCK'],
    [{ ...dailyDraft, requestId: 'dddd0000-0000-4000-8000-0000000000af', dailyStock: true, stand: undefined }, 'INVALID_STAND'],
  ];
  const rpcBefore = bridge.calls.rpc;
  for (const [body] of optInCases) {
    const payload = JSON.parse(JSON.stringify(body));
    const result = await app.request('/api/sales', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: app.base },
      body: JSON.stringify(payload),
    });
    assert.equal(result.status, 400, `daily opt-in must validate: ${JSON.stringify(payload)}`);
  }
  assert.equal(bridge.calls.rpc, rpcBefore, 'rejected opt-ins never reached storage');

  // A legacy sale (no dailyStock key) keeps the exact original contract.
  const legacy = await send('POST', '/api/sales', {
    requestId: 'dddd0000-0000-4000-8000-0000000000b0', date: DATE,
    product: 'Venta libre sin stock', payment: 'efectivo', amount: '100',
  });
  assert.equal(legacy.status, 201, 'the legacy channel still works exactly as before');
  assert.equal(!('dailyStock' in legacy.body.sale), true, 'legacy responses never carry the daily tag');
});

test('daily sale replay and cross-channel id conflicts are exact and change nothing', async t => {
  const app = await listen(t, stockOptions(bridge));
  const { send } = await app.enter();
  const product = (await send('POST', '/api/products', { name: 'Replay Diario' })).body.product;
  const DATE = '2030-02-02';
  await send('POST', '/api/stock-days', {
    action: 'load', date: DATE, stand: 'fixed', items: [{ productId: product.id, initial: 9, prevInitial: null }],
  });
  const daily = {
    requestId: 'dddd0000-0000-4000-8000-0000000000ca', date: DATE, product: 'Replay Diario',
    payment: 'efectivo', amount: '500', productId: product.id, quantity: 1, stand: 'fixed', dailyStock: true,
  };
  assert.equal((await send('POST', '/api/sales', daily)).status, 201);
  const rowsAfterCreate = await countSales();

  const replay = await send('POST', '/api/sales', daily);
  assert.equal(replay.status, 200);
  assert.equal(replay.body.replayed, true);
  assert.equal(await countSales(), rowsAfterCreate, 'the replay stored no second row');

  const conflict = await send('POST', '/api/sales', { ...daily, amount: '600' });
  assert.equal(conflict.status, 409);
  assert.equal(conflict.body.error.code, 'ID_CONFLICT');

  // A legacy request replaying a daily sale id is a channel conflict, never a replay.
  const legacyOfDaily = await send('POST', '/api/sales', {
    requestId: 'dddd0000-0000-4000-8000-0000000000ca', date: DATE, product: 'Replay Diario',
    payment: 'efectivo', amount: '500', productId: product.id, quantity: 1,
  });
  assert.equal(legacyOfDaily.status, 409);
  assert.equal(legacyOfDaily.body.error.code, 'DAILY_SALE_CHANNEL');

  // A daily request on a legacy sale id is refused the same way.
  const legacySale = {
    requestId: 'dddd0000-0000-4000-8000-0000000000cb', date: DATE, product: 'Replay Diario',
    payment: 'transferencia', amount: '100',
  };
  assert.equal((await send('POST', '/api/sales', legacySale)).status, 201);
  const dailyOfLegacy = await send('POST', '/api/sales', { ...legacySale, stand: 'fixed', dailyStock: true });
  assert.equal(dailyOfLegacy.status, 409);
  assert.equal(dailyOfLegacy.body.error.code, 'DAILY_SALE_CHANNEL');
  assert.equal(await countSales(), rowsAfterCreate + 1, 'neither conflict created a row');
});

test('daily edit and delete use the stored channel and the canonical JSON shape', async t => {
  const app = await listen(t, stockOptions(bridge));
  const { send, get } = await app.enter();
  const productA = (await send('POST', '/api/products', { name: 'Edición Diaria A' })).body.product;
  const productB = (await send('POST', '/api/products', { name: 'Edición Diaria B' })).body.product;
  const DATE = '2030-02-03';
  await send('POST', '/api/stock-days', {
    action: 'load', date: DATE, stand: 'fixed',
    items: [{ productId: productA.id, initial: 10, prevInitial: null }, { productId: productB.id, initial: 4, prevInitial: null }],
  });
  const daily = {
    requestId: 'dddd0000-0000-4000-8000-0000000000da', date: DATE, product: 'Edición Diaria A',
    payment: 'efectivo', amount: '1000', productId: productA.id, quantity: 4, stand: 'fixed', dailyStock: true,
  };
  assert.equal((await send('POST', '/api/sales', daily)).status, 201);
  const observed = (await get(`/api/sales?date=${DATE}`)).body.sales.find(sale => sale.id === daily.requestId);
  assert.ok(observed.dailyStock === true, 'the read exposes the tag the edits must echo');

  // PUT with the exact T2 daily canonical shape (id + amountCents, never requestId/amount).
  const edited = await send('PUT', '/api/sales', {
    id: observed.id, date: DATE, product: 'Edición Diaria A', payment: 'efectivo',
    amountCents: 100000, productId: productA.id, quantity: 2, stand: 'fixed', dailyStock: true,
    previous: observed,
  });
  assert.equal(edited.status, 200);
  assert.equal(edited.body.sale.dailyStock, true);
  assert.equal(edited.body.sale.quantity, 2);

  const rowAfter = (await get(`/api/stock-days?date=${DATE}`)).body.rows
    .find(r => r.productId === productA.id && r.stand === 'fixed');
  assert.deepEqual({ sold: rowAfter.sold, available: rowAfter.available }, { sold: 2, available: 8 },
    'the daily figures re-derive from the edit');

  const stale = await send('PUT', '/api/sales', {
    id: observed.id, date: DATE, product: 'Edición Diaria A', payment: 'efectivo',
    amountCents: 100000, productId: productA.id, quantity: 5, stand: 'fixed', dailyStock: true,
    previous: observed,
  });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.error.code, 'SALE_CONFLICT');

  // A legacy-shaped (requestId + amount) edit of a daily row stays daily.
  const hybrid = await send('PUT', '/api/sales', {
    requestId: observed.id, date: DATE, product: 'Edición Diaria A', payment: 'efectivo',
    amount: '1200', productId: productA.id, quantity: 2, stand: 'fixed', dailyStock: true,
    previous: {
      requestId: observed.id, date: DATE, product: 'Edición Diaria A', payment: 'efectivo',
      amount: '1000', productId: productA.id, quantity: 2, stand: 'fixed', dailyStock: true,
    },
  });
  assert.equal(hybrid.status, 200);
  assert.equal(hybrid.body.sale.dailyStock, true, 'the edit was routed by the stored channel, not the caller');
  assert.equal(hybrid.body.sale.amountCents, 120000);

  // An idempotent edit (content equal to the stored row) answers without a write.
  const current = (await get(`/api/sales?date=${DATE}`)).body.sales.find(sale => sale.id === daily.requestId);
  const rpcBefore = bridge.calls.rpc;
  const idempotent = await send('PUT', '/api/sales', { ...current, previous: current });
  assert.equal(idempotent.status, 200);
  assert.equal(bridge.calls.rpc, rpcBefore, 'a no-op edit never called the RPC');

  // Delete with the canonical observed snapshot.
  const deleted = await send('DELETE', '/api/sales', { id: observed.id, previous: current });
  assert.equal(deleted.status, 200);
  assert.equal(deleted.body.sale.dailyStock, true);
  const rowAfterDelete = (await get(`/api/stock-days?date=${DATE}`)).body.rows
    .find(r => r.productId === productA.id && r.stand === 'fixed');
  assert.deepEqual({ sold: rowAfterDelete.sold, available: rowAfterDelete.available }, { sold: 0, available: 10 },
    'the delete returns the daily availability without any restore operation');

  const again = await send('DELETE', '/api/sales', { id: observed.id, previous: current });
  assert.equal(again.status, 404);
  assert.equal(again.body.error.code, 'NOT_FOUND');

  // An old historical (legacy) sale keeps editing through the legacy channel.
  const legacyProduct = (await send('POST', '/api/products', { name: 'Legacy Canal', stock: 5 })).body.product;
  const legacySale = {
    requestId: 'dddd0000-0000-4000-8000-0000000000db', date: DATE, product: 'Legacy Canal',
    payment: 'efectivo', amount: '200', productId: legacyProduct.id, quantity: 2,
  };
  assert.equal((await send('POST', '/api/sales', legacySale)).status, 201);
  assert.equal((await productRow('Legacy Canal')).stock, 3, 'the legacy channel consumes the global stock');
  const legacyEdit = await send('PUT', '/api/sales', { ...legacySale, amount: '250', previous: legacySale });
  assert.equal(legacyEdit.status, 200);
  assert.equal(!('dailyStock' in legacyEdit.body.sale), true,
    'a legacy edit stays legacy even while daily sales exist');
  assert.equal((await productRow('Legacy Canal')).stock, 3,
    'the legacy edit kept consuming only the global stock');
  assert.equal(await totalMovements() > 0, true, 'the legacy channel still audits global movements');
});

test('stock-days guards: outage honesty with no automatic retry, and an unbound identity fails closed', async t => {
  const app = await listen(t, stockOptions(bridge));
  const { send, get } = await app.enter();
  const outageProduct = (await send('POST', '/api/products', { name: 'Caida Diaria' })).body.product;
  const DATE = '2030-02-04';
  const rpcBefore = bridge.calls.rpc;
  bridge.controls.failAll = true;
  const readOutage = await get(`/api/stock-days?date=${DATE}`);
  assert.deepEqual(readOutage, {
    status: 503,
    body: { error: { code: 'STORAGE_UNAVAILABLE', message: 'No se pudo acceder al stock del día. Reintentá en unos momentos.' } },
    setCookie: readOutage.setCookie,
  }, 'a transport failure on the daily read is a plain honest 503');
  const loadOutage = await send('POST', '/api/stock-days', {
    action: 'load', date: DATE, stand: 'fixed',
    items: [{ productId: outageProduct.id, initial: 1, prevInitial: null }],
  });
  assert.equal(loadOutage.status, 503);
  assert.equal(loadOutage.body.error.code, 'STORAGE_UNAVAILABLE');
  assert.equal(bridge.calls.rpc, rpcBefore, 'the outage answered before any RPC completed: no automatic retry');
  bridge.controls.failAll = false;
  const recovered = await send('POST', '/api/stock-days', { action: 'copy', date: DATE, stand: 'fixed' });
  assert.equal(recovered.status, 200, 'an explicit user retry after recovery works');

  const unboundDb = await createStockDb();
  await applyMigration(unboundDb); // no seedAuthUser: the registry stays empty
  t.after(() => unboundDb.close());
  const unboundBridge = createRestStockFetch(unboundDb);
  const unboundApp = await listen(t, stockOptions(unboundBridge));
  const unbound = await unboundApp.enter();
  const denied = await unbound.send('POST', '/api/stock-days', {
    action: 'load', date: '2030-03-01', stand: 'fixed',
    items: [{ productId: 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', initial: 1, prevInitial: null }],
  });
  assert.equal(denied.status, 403);
  assert.equal(denied.body.error.code, 'FORBIDDEN', 'the identity gate fails closed before any data work');
  const deniedRead = await unbound.get('/api/stock-days?date=2030-03-01');
  assert.equal(deniedRead.status, 403);
  assert.equal(deniedRead.body.error.code, 'FORBIDDEN', 'the RPC read asserts the identity too');
});

test('stock-days transport: jsonb parameters travel as real JSON values on the wire, never pre-stringified text', async t => {
  const tape = [];
  const app = await listen(t, recordingOptions(bridge, tape));
  const { send, get } = await app.enter();
  const product = (await send('POST', '/api/products', { name: 'Transporte Diaria' })).body.product;
  const DATE = '2030-04-01';

  const loaded = await send('POST', '/api/stock-days', {
    action: 'load', date: DATE, stand: 'fixed',
    items: [{ productId: product.id, initial: 3, prevInitial: null }],
  });
  assert.equal(loaded.status, 200);
  const loadCall = tape.find(entry => entry.rpc === 'v2_load_daily_stock');
  assert.ok(loadCall, 'the load RPC was observed on the raw wire');
  assert.ok(Array.isArray(loadCall.body.p_items),
    `the hosted jsonb binding keeps the wire JSON type: p_items must be a raw array, got ${typeof loadCall.body.p_items}`);
  assert.deepEqual(loadCall.body.p_items,
    [{ productId: product.id, initial: 3, prevInitial: null }]);

  const replenished = await send('POST', '/api/stock-days', {
    action: 'replenish', date: DATE, stand: 'fixed',
    items: [{ productId: product.id, replenished: 1, prevReplenished: null }],
  });
  assert.equal(replenished.status, 200);
  const replenishCall = tape.find(entry => entry.rpc === 'v2_replenish_daily_stock');
  assert.ok(Array.isArray(replenishCall.body.p_items), 'replenish also sends the raw array');

  // p_sale/p_previous are jsonb objects cast to records by the SQL: they must
  // arrive as JSON objects too, or every daily edit would break on hosting.
  const daily = {
    requestId: 'dddd0000-0000-4000-8000-0000000000ea', date: DATE, product: 'Transporte Diaria',
    payment: 'efectivo', amount: '100', productId: product.id, quantity: 1, stand: 'fixed', dailyStock: true,
  };
  assert.equal((await send('POST', '/api/sales', daily)).status, 201);
  const observed = (await get(`/api/sales?date=${DATE}`)).body.sales[0];
  const edited = await send('PUT', '/api/sales', {
    id: observed.id, date: DATE, product: 'Transporte Diaria', payment: 'efectivo',
    amountCents: 20000, productId: product.id, quantity: 1, stand: 'fixed', dailyStock: true,
    previous: observed,
  });
  assert.equal(edited.status, 200);
  const editCall = tape.find(entry => entry.rpc === 'v2_edit_daily_sale');
  assert.ok(editCall, 'the daily edit RPC was observed on the raw wire');
  assert.ok(editCall.body.p_sale && typeof editCall.body.p_sale === 'object' && !Array.isArray(editCall.body.p_sale),
    `p_sale must be a real JSON object on the wire, got ${typeof editCall.body.p_sale}`);
  assert.ok(editCall.body.p_previous && typeof editCall.body.p_previous === 'object' && !Array.isArray(editCall.body.p_previous),
    'p_previous must be a real JSON object on the wire');
});

test('transport parity: a pre-stringified jsonb argument is rejected by the SQL as the wrong JSON type, never silently decoded', async t => {
  const app = await listen(t, stockOptions(bridge));
  const { send, get } = await app.enter();
  const product = (await send('POST', '/api/products', { name: 'Cadena Rechazada' })).body.product;
  const DATE = '2030-04-02';
  await send('POST', '/api/stock-days', {
    action: 'load', date: DATE, stand: 'fixed', items: [{ productId: product.id, initial: 5, prevInitial: null }],
  });
  const draft = {
    requestId: 'dddd0000-0000-4000-8000-0000000000eb', date: DATE, product: 'Cadena Rechazada',
    payment: 'efectivo', amount: '2000', productId: product.id, quantity: 2, stand: 'fixed', dailyStock: true,
  };
  assert.equal((await send('POST', '/api/sales', draft)).status, 201);

  const options = stockOptions(bridge);
  const stringifiedFetch = legacyStringifiedFetch(options);
  const stockApi = createSupabaseStockDaysApi({ env: env(), accessToken: 'at-test', supabaseFetch: stringifiedFetch });
  const salesApi = createSupabaseSalesApi({ env: env(), accessToken: 'at-test', supabaseFetch: stringifiedFetch });

  // p_items as JSON text is a jsonb STRING scalar on this transport: the SQL
  // must reject it instead of decoding the string back into an array.
  await assert.rejects(
    () => stockApi.load(DATE, 'fixed', [{ productId: product.id, initial: 7, prevInitial: null }], false),
    error => error instanceof SalesError && error.status === 400 && error.code === 'INVALID_DAILY'
      && error.message === 'La carga debe enviarse como una lista de productos.',
  );
  const rows = await stockApi.read(DATE);
  assert.equal(rows.find(row => row.productId === product.id && row.stand === 'fixed').loaded, 5,
    'the rejected string transport never rewrote the load');

  // The same parity proof for the sale-edit jsonb objects.
  const sale = {
    id: draft.requestId, date: DATE, product: 'Cadena Rechazada', payment: 'efectivo',
    amountCents: 300000, productId: product.id, quantity: 2, stand: 'fixed', allowNegative: false,
  };
  const previous = {
    id: draft.requestId, date: DATE, product: 'Cadena Rechazada', payment: 'efectivo',
    amountCents: 200000, productId: product.id, quantity: 2, stand: 'fixed',
  };
  await assert.rejects(
    () => salesApi.update(sale, previous),
    error => error instanceof SalesError && error.status === 400 && error.code === 'INVALID_STOCK',
  );
  const after = (await get(`/api/sales?date=${DATE}`)).body.sales[0];
  assert.equal(after.amountCents, 200000, 'the rejected string transport never edited the sale');
});

test('daily edits accept snapshots that omit the channel tag; a tag-omission no-op emits zero write RPCs', async t => {
  const app = await listen(t, stockOptions(bridge));
  const { send, get } = await app.enter();
  const product = (await send('POST', '/api/products', { name: 'Sin Etiqueta' })).body.product;
  const DATE = '2030-04-03';
  await send('POST', '/api/stock-days', {
    action: 'load', date: DATE, stand: 'fixed', items: [{ productId: product.id, initial: 6, prevInitial: null }],
  });
  const daily = {
    requestId: 'dddd0000-0000-4000-8000-0000000000fa', date: DATE, product: 'Sin Etiqueta',
    payment: 'efectivo', amount: '2000', productId: product.id, quantity: 3, stand: 'fixed', dailyStock: true,
  };
  assert.equal((await send('POST', '/api/sales', daily)).status, 201);
  const observed = (await get(`/api/sales?date=${DATE}`)).body.sales.find(sale => sale.id === daily.requestId);
  // The current public UI saleFields omit the tag: a snapshot built from that
  // shape carries no dailyStock key at all.
  const omitTag = row => {
    const { dailyStock, ...rest } = row;
    return rest;
  };

  // Editing the current daily row with an untagged previous snapshot is NOT a
  // conflict: the trusted stored row already promised this routing.
  const edited = await send('PUT', '/api/sales', {
    requestId: observed.id, date: DATE, product: 'Sin Etiqueta', payment: 'efectivo',
    amount: '2500', productId: product.id, quantity: 2, stand: 'fixed',
    previous: { ...omitTag(observed), requestId: observed.id, amount: '2000' },
  });
  assert.equal(edited.status, 200, `an untagged previous snapshot must not false-conflict: ${JSON.stringify(edited.body)}`);
  assert.equal(edited.body.error?.code, undefined);
  assert.equal(edited.body.sale.dailyStock, true, 'the stored channel tag is echoed back');
  assert.equal(edited.body.sale.amountCents, 250000);

  const day = (await get(`/api/stock-days?date=${DATE}`)).body.rows
    .find(row => row.productId === product.id && row.stand === 'fixed');
  assert.deepEqual({ sold: day.sold, available: day.available }, { sold: 2, available: 4 },
    'the daily figures re-derive after the untagged edit');

  // No-op with the tag omitted everywhere: zero write RPCs.
  const rpcBefore = bridge.calls.rpc;
  const noop = await send('PUT', '/api/sales', {
    requestId: observed.id, date: DATE, product: 'Sin Etiqueta', payment: 'efectivo',
    amount: '2500', productId: product.id, quantity: 2, stand: 'fixed',
    previous: {
      requestId: observed.id, date: DATE, product: 'Sin Etiqueta', payment: 'efectivo',
      amount: '2500', productId: product.id, quantity: 2, stand: 'fixed',
    },
  });
  assert.equal(noop.status, 200);
  assert.equal(noop.body.sale.dailyStock, true);
  assert.equal(bridge.calls.rpc, rpcBefore, 'a tag-omission no-op emits zero write RPCs');

  // Safety is preserved: an untagged but STALE snapshot still loses the CAS.
  const stale = await send('PUT', '/api/sales', {
    requestId: observed.id, date: DATE, product: 'Sin Etiqueta', payment: 'efectivo',
    amount: '9999', productId: product.id, quantity: 2, stand: 'fixed',
    previous: { requestId: observed.id, date: DATE, product: 'Sin Etiqueta', payment: 'efectivo', amount: '1000', productId: product.id, quantity: 2, stand: 'fixed' },
  });
  assert.equal(stale.status, 409, 'an omitted tag never bypasses the previous-snapshot CAS');
  assert.equal(stale.body.error.code, 'SALE_CONFLICT');

  // The existing frontend requestId/amount delete shape still deletes a daily
  // row through its stored channel.
  const deleted = await send('DELETE', '/api/sales', {
    id: observed.id,
    previous: {
      requestId: observed.id, date: DATE, product: 'Sin Etiqueta', payment: 'efectivo',
      amount: '2500', productId: product.id, quantity: 2, stand: 'fixed',
    },
  });
  assert.equal(deleted.status, 200, `the legacy-shaped delete still routes daily: ${JSON.stringify(deleted.body)}`);
  assert.equal(deleted.body.sale.dailyStock, true);
  const after = (await get(`/api/stock-days?date=${DATE}`)).body.rows
    .find(row => row.productId === product.id && row.stand === 'fixed');
  assert.deepEqual({ sold: after.sold, available: after.available }, { sold: 0, available: 6 });
});

test('an explicit contradictory channel tag never converts the stored channel', async t => {
  const app = await listen(t, stockOptions(bridge));
  const { send, get } = await app.enter();
  const product = (await send('POST', '/api/products', { name: 'Canal Contradicho', stock: 5 })).body.product;
  const DATE = '2030-04-04';
  const legacy = {
    requestId: 'dddd0000-0000-4000-8000-0000000000fb', date: DATE, product: 'Canal Contradicho',
    payment: 'efectivo', amount: '500', productId: product.id, quantity: 1, stand: 'fixed',
  };
  assert.equal((await send('POST', '/api/sales', legacy)).status, 201);

  // Editing a LEGACY row while claiming the daily channel on the new row AND
  // the observed snapshot: the tag is refused as a stale contradiction (it
  // can never convert the row or flip the routing).
  const contradictory = await send('PUT', '/api/sales', {
    requestId: legacy.requestId, date: DATE, product: 'Canal Contradicho', payment: 'efectivo',
    amount: '600', productId: product.id, quantity: 1, stand: 'fixed', dailyStock: true,
    previous: { ...legacy, dailyStock: true },
  });
  assert.equal(contradictory.status, 409);
  assert.equal(contradictory.body.error.code, 'SALE_CONFLICT');
  const untouched = (await get(`/api/sales?date=${DATE}`)).body.sales[0];
  assert.equal(untouched.amountCents, 50000, 'the refused contradictory edit changed nothing');
  assert.equal(!('dailyStock' in untouched), true, 'the row stayed legacy');

  // A tag only on the NEW body (not on the observed snapshot) is not a
  // channel decision either: the edit goes through the stored legacy channel
  // and the row stays legacy, never converted.
  const claimedOnly = await send('PUT', '/api/sales', {
    requestId: legacy.requestId, date: DATE, product: 'Canal Contradicho', payment: 'efectivo',
    amount: '600', productId: product.id, quantity: 1, stand: 'fixed', dailyStock: true,
    previous: legacy,
  });
  assert.equal(claimedOnly.status, 200);
  assert.equal(!('dailyStock' in claimedOnly.body.sale), true,
    'an explicit contradictory tag never converted the stored channel');
});
