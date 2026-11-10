import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../server.js';
import {
  createStockDb, applyMigration, seedAuthUser, createRestStockFetch,
  TEST_UID, TEST_EMAIL,
} from './helpers/stock-db.js';

// T3 of odd/tasks/stock-v2.md (S1,S3-S5): public HTTP tests for the stock
// API/lib contracts, executed against REAL SQL. The in-memory PGlite fixture
// (already exercised by T2) is wrapped in the minimal PostgREST boundary of
// test/helpers/stock-db.js, so what these tests observe is the exact contract
// the SQL layer enforces: RPC-only writes, table-only GETs, full-snapshot CAS
// behavior and rejected-state invariants. Everything is synthetic: no cloud,
// no real account, no v1 access.

const EMAIL = TEST_EMAIL;
const PASSWORD = 'contraseña-sintética-de-prueba';

const env = (extra = {}) => ({
  SUPABASE_URL: 'https://auth.test',
  SUPABASE_ANON_KEY: 'anon-key-for-tests',
  SUPABASE_ALLOWED_USER_ID: TEST_UID,
  SUPABASE_SESSION_KEY: 'k'.repeat(32),
  ...extra,
});

// One shared SQL database per test file: every mutation lives in distinct,
// uniquely named rows so tests stay independent while keeping PGlite startup
// out of each test's edge.
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

// Expected Supabase Auth surface of the one-identity session flow, kept tiny
// and deterministic; stock data always flows through the real SQL bridge.
function createAuthFetch() {
  let serial = 0;
  const revoked = new Set();
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
    if (parsed.pathname === '/auth/v1/token' && parsed.searchParams.get('grant_type') === 'refresh_token') {
      const body = init.body ? JSON.parse(init.body) : {};
      if (!body.refresh_token || revoked.has(body.refresh_token)) return respond(400, { error: 'invalid_grant' });
      return respond(200, { access_token: `at-${++serial}`, refresh_token: `rt-${serial}` });
    }
    if (parsed.pathname === '/auth/v1/user') {
      if (!bearer || revoked.has(`session:${bearer}`)) return respond(401, { error: 'bad_jwt' });
      return respond(200, { id: TEST_UID, email: EMAIL });
    }
    if (parsed.pathname === '/auth/v1/logout') {
      revoked.add(`session:${bearer}`);
      return respond(204, null);
    }
    throw new Error(`unexpected auth call: ${parsed.pathname}`);
  };
}

// App options whose supabaseFetch routes /auth/v1/* to the tiny deterministic
// auth fake and everything else to the real-SQL PostgREST bridge.
function stockOptions(bridgeInstance) {
  const auth = createAuthFetch();
  const fetchImpl = (url, init) => new URL(url).pathname.startsWith('/auth/v1/')
    ? auth(url, init)
    : bridgeInstance.fetchImpl(url, init);
  return { env: env(), supabaseFetch: fetchImpl };
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
    // Verified-session request helper: exact public HTTP contract.
    const send = (method, path, body) => request(path, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const get = path => request(path, { headers: { cookie } });
    return { send, get, cookie };
  }

  const withSession = response => ({ headers: { cookie: response.setCookie[0].split(';')[0] } });
  return { base, request, enter, withSession };
}

// --- real SQL state helpers ----------------------------------------------

// Local amount parser mirroring the public amount rule (integer cents).
const toCents = amount => {
  const [pesos, fraction = ''] = amount.split(/[,.]/);
  return Number(pesos) * 100 + Number(fraction.padEnd(2, '0'));
};

// A stored sale's canonical response shape (id alias of a payload's requestId,
// integer amountCents instead of the editable decimal string).
const currentSalesShape = payload => ({
  id: payload.requestId, date: payload.date, product: payload.product,
  payment: payload.payment, amountCents: toCents(payload.amount),
  productId: payload.productId ?? null, quantity: payload.quantity ?? 1,
});

const productRow = async name => {
  const { rows } = await sharedDb.query('select stock, archived from public.v2_products where name = $1', [name]);
  return rows[0] ?? null;
};
const totalMovements = async () => {
  const { rows } = await sharedDb.query('select count(*)::int as n from public.v2_stock_movements');
  return rows[0].n;
};
const movementCount = async (where = 'true', params = []) => {
  const { rows } = await sharedDb.query(
    `select count(*)::int as n from public.v2_stock_movements where ${where}`, params);
  return rows[0].n;
};
const countSales = async () => (await sharedDb.query('select count(*)::int as n from public.v2_sales')).rows[0].n;

// ---------------------------------------------------------------------------

test('products: canonical camelCase catalogue, explicit archived visibility, create and CAS edit', async t => {
  const app = await listen(t, stockOptions(bridge));
  const { send, get } = await app.enter();

  const created = await send('POST', '/api/products', { name: 'Bolsa grande', price: '12,50', stock: 10 });
  assert.equal(created.status, 201, 'a priced product is created');
  assert.deepEqual(created.body, {
    storage: 'supabase',
    product: { id: created.body.product.id, name: 'Bolsa grande', priceCents: 1250, stock: 10, archived: false },
  }, 'the canonical camelCase product shape is exact');

  const cheap = await send('POST', '/api/products', { name: 'Caramelo' });
  assert.deepEqual(cheap.body.product, { id: cheap.body.product.id, name: 'Caramelo', priceCents: null, stock: 0, archived: false },
    'price is optional and stock defaults to 0');

  const listed = await get('/api/products');
  assert.deepEqual(listed.body, {
    storage: 'supabase',
    products: [created.body.product, cheap.body.product],
  }, 'GET lists every product ordered by name with the canonical camelCase shape');

  const edited = await send('PUT', '/api/products', {
    id: created.body.product.id,
    previous: { id: created.body.product.id, name: 'Bolsa grande', priceCents: 1250, stock: 10 },
    name: 'Bolsa grande', price: '13', stock: 5,
  });
  assert.equal(edited.status, 200, 'a CAS edit with the full previous snapshot succeeds');
  assert.deepEqual(edited.body, {
    storage: 'supabase',
    product: { id: created.body.product.id, name: 'Bolsa grande', priceCents: 1300, stock: 5, archived: false },
  });

  const stale = await send('PUT', '/api/products', {
    id: created.body.product.id,
    previous: { id: created.body.product.id, name: 'Bolsa grande', priceCents: 1250, stock: 10 },
    name: 'Bolsa grande', price: '14', stock: 6,
  });
  assert.deepEqual(stale, {
    status: 409, body: { error: { code: 'PRODUCT_CONFLICT', message: 'El producto cambió desde otro dispositivo. Volvé a abrirlo con los datos actualizados.' } }, setCookie: stale.setCookie,
  }, 'a stale previous snapshot loses the CAS without rewriting');

  const duplicate = await send('POST', '/api/products', { name: 'bolsa grande ', stock: 99 });
  assert.deepEqual(duplicate.body, {
    error: { code: 'PRODUCT_CONFLICT', message: 'Ya existe un producto activo con ese nombre.' },
  }, 'a duplicate active name is rejected (trimmed comparisons)');
  assert.deepEqual(await productRow('Bolsa grande'), { stock: 5, archived: false },
    'the rejected duplicate left the real product untouched');
  assert.equal(await movementCount('product_id = $1', [created.body.product.id]), 2,
    'exactly the create (10) and edit (+5) audits exist');

  const removed = await send('DELETE', '/api/products', {
    id: created.body.product.id, previous: { stock: 5 },
  });
  assert.equal(removed.status, 200, 'delete archives the product (no hard delete)');
  assert.deepEqual(removed.body, {
    storage: 'supabase',
    product: { id: created.body.product.id, name: 'Bolsa grande', priceCents: 1300, stock: 5, archived: true },
  });
  const listedAfter = await get('/api/products');
  assert.equal(listedAfter.body.products.some(p => p.id === created.body.product.id && p.archived === true), true,
    'archived products stay visible in the list for existing-sale lookup');

  const reborn = await send('POST', '/api/products', { name: 'Bolsa grande', price: '9', stock: 1 });
  assert.equal(reborn.status, 201, 'an archived name frees the active catalogue');
  assert.equal((await send('DELETE', '/api/products', { id: cheap.body.product.id, previous: {} })).status, 400,
    'archive-without-stock CAS is rejected as invalid input');
  assert.equal((await send('POST', '/api/products', { name: 'Negativo', stock: -1 })).body.error.code,
    'INVALID_STOCK', 'a negative initial stock never creates the product');
  assert.equal((await send('POST', '/api/products', { name: '', stock: 1 })).body.error.code,
    'INVALID_NAME', 'an empty product name is rejected');
  assert.equal((await send('POST', '/api/products', { name: 'Precio x', price: '12,345' })).body.error.code,
    'INVALID_PRICE', 'a third decimal breaks the amount-style price rule');
  assert.equal(bridge.calls.violations, 0, 'the library never attempted a direct table write');
  assert.equal(bridge.calls.v1, 0, 'the v1 public.sales table was never touched');
});

test('sales linked to stock consume atomically, replay exactly once, and reject shortages without mutations', async t => {
  const app = await listen(t, stockOptions(bridge));
  const { send, get } = await app.enter();
  const product = (await send('POST', '/api/products', { name: 'Caja v2', stock: 2 })).body.product;

  const SALE_A = '00000000-0000-4000-8000-0000000000aa';
  const DATE = '2026-02-01';
  const payload = { requestId: SALE_A, date: DATE, product: 'Caja v2', payment: 'efectivo', amount: '5000', productId: product.id, quantity: 5 };
  const beforeMovements = await totalMovements();

  const shortage = await send('POST', '/api/sales', payload);
  assert.equal(shortage.status, 409, 'a stock shortage without allowNegative rejects');
  assert.equal(shortage.body.error.code, 'INSUFFICIENT_STOCK');
  assert.equal(shortage.body.error.message, 'STOCK_INSUFICIENTE: stock=2, solicitado=5',
    'the SQL detail (stock/solicitado) passes through for the confirm-overwrite UX');
  assert.equal((await productRow('Caja v2')).stock, 2,
    'a rejected sale never mutated the product stock');
  assert.equal(await totalMovements(), beforeMovements, 'a rejected sale appended no movement');

  const allowed = await send('POST', '/api/sales', { ...payload, allowNegative: true });
  assert.equal(allowed.status, 201);
  assert.deepEqual(allowed.body, {
    sale: { id: SALE_A, date: DATE, product: 'Caja v2', payment: 'efectivo', amountCents: 500000, productId: product.id, quantity: 5 },
    replayed: false, storage: 'supabase',
  }, 'an explicit allowNegative acknowledgement stores the sale');
  assert.equal((await productRow('Caja v2')).stock, -3, 'stock went to -3 (2 - 5)');
  assert.equal(await movementCount('reason = \'sale_create\' and sale_id = $1 and delta = -5', [SALE_A]), 1,
    'exactly one sale_create movement was audited');

  const replay = await send('POST', '/api/sales', payload);
  assert.equal(replay.status, 200, 'an exact replay answers 200');
  assert.deepEqual(replay.body, { sale: allowed.body.sale, replayed: true, storage: 'supabase' });
  assert.equal(await movementCount('reason = \'sale_create\' and sale_id = $1', [SALE_A]), 1,
    'the replay did not decrement stock twice');

  const conflict = await send('POST', '/api/sales', { ...payload, amount: '6000' });
  assert.equal(conflict.status, 409);
  assert.equal(conflict.body.error.code, 'ID_CONFLICT',
    'different content under a taken sale id is a hard conflict, never a rewrite');

  const underStock = await send('POST', '/api/sales', {
    requestId: '00000000-0000-4000-8000-0000000000ab', date: DATE,
    product: 'Caja v2', payment: 'transferencia', amount: '1000', productId: product.id, quantity: 2,
  });
  assert.equal(underStock.status, 409, 'a second sale hits the real current stock (-3)');
  assert.equal(underStock.body.error.code, 'INSUFFICIENT_STOCK');
  assert.equal(await countSales(), 1, 'the rejected sale never created a row');
  assert.equal(await movementCount('sale_id = $1', ['00000000-0000-4000-8000-0000000000ab']), 0,
    'no movement exists for a sale that never happened');

  const list = await get(`/api/sales?date=${DATE}`);
  assert.deepEqual(list.body.sales, [allowed.body.sale],
    'GET keeps the list contract and surfaces productId/quantity per sale');
});

test('sale edits and deletes are full-snapshot CAS and reverse stock in order', async t => {
  const app = await listen(t, stockOptions(bridge));
  const { send, get } = await app.enter();
  const productA = (await send('POST', '/api/products', { name: 'Alfa', stock: 10 })).body.product;
  const productB = (await send('POST', '/api/products', { name: 'Beta', stock: 4 })).body.product;

  const SALE = '00000000-0000-4000-8000-0000000000ff';
  const DATE = '2026-02-02';
  const createPost = { requestId: SALE, date: DATE, product: 'Alfa', payment: 'efectivo', amount: '2000', productId: productA.id, quantity: 3 };
  await send('POST', '/api/sales', createPost);
  assert.equal((await productRow('Alfa')).stock, 7);

  const edited = await send('PUT', '/api/sales', { ...createPost, quantity: 2, previous: createPost });
  assert.equal(edited.status, 200, 'an edit with the exact full previous snapshot succeeds');
  // responses use the canonical id key, not the payload's requestId alias
  assert.deepEqual(edited.body.sale, { ...currentSalesShape(createPost), quantity: 2 });
  assert.equal((await productRow('Alfa')).stock, 8, 'reducing the quantity returned 1 unit');
  assert.equal(await movementCount('reason = \'sale_edit\' and sale_id = $1 and delta = 1', [SALE]), 1,
    'the reversal was audited');

  const lost = await send('PUT', '/api/sales', { ...createPost, quantity: 5, previous: createPost });
  assert.equal(lost.status, 409, 'an edit against the stale first snapshot loses');
  assert.equal(lost.body.error.code, 'SALE_CONFLICT');
  assert.equal(lost.body.error.message, 'La venta cambió desde otro dispositivo. Cancelá la edición y volvé a abrirla con los datos actualizados.');
  assert.equal((await productRow('Alfa')).stock, 8, 'the lost CAS never changed stock');

  const currentSnapshot = { ...createPost, quantity: 2 };
  const switched = await send('PUT', '/api/sales', {
    requestId: SALE, date: DATE, product: 'Beta', payment: 'efectivo', amount: '2000',
    productId: productB.id, quantity: 2,
    previous: currentSnapshot,
  });
  assert.equal(switched.status, 200, 'switching products with the exact previous snapshot succeeds');
  assert.equal((await productRow('Alfa')).stock, 10, 'the previous product was fully refunded');
  assert.equal((await productRow('Beta')).stock, 2, 'the new product consumed 2 units');
  assert.equal(await movementCount('reason = \'sale_edit\' and delta = 2 and product_id = $1', [productA.id]), 1,
    'the refund movement for Alfa is audited (+2: the current quantity is 2 after the first edit)');

  const deleted = await send('DELETE', '/api/sales', {
    id: SALE, previous: { ...currentSnapshot, product: 'Beta', productId: productB.id },
  });
  assert.equal(deleted.status, 200, 'a delete with the exact previous snapshot removes the sale');
  assert.deepEqual(deleted.body.sale, {
    id: SALE, date: DATE, product: 'Beta', payment: 'efectivo', amountCents: 200000, productId: productB.id, quantity: 2,
  }, 'the removed row keeps its verbatim snapshots');
  assert.equal((await productRow('Beta')).stock, 4, 'the delete returned the consumed stock');
  assert.equal(await movementCount('reason = \'sale_delete\' and sale_id = $1', [SALE]), 1);

  const again = await send('DELETE', '/api/sales', {
    id: SALE, previous: { ...currentSnapshot, product: 'Beta', productId: productB.id },
  });
  assert.equal(again.status, 404, 'deleting twice fails closed');
  assert.equal(again.body.error.code, 'NOT_FOUND');
  assert.equal((await productRow('Beta')).stock, 4, 'the repeated delete changed nothing');
});

test('free-text sales keep the original no-product contract, and product selection rejects archived links', async t => {
  const app = await listen(t, stockOptions(bridge));
  const { send } = await app.enter();
  const DATE = '2026-02-03';
  const SALE_V = '00000000-0000-4000-8000-0000000000ee';

  const free = await send('POST', '/api/sales', {
    requestId: SALE_V, date: DATE, product: 'Algo variado', payment: 'transferencia', amount: '777',
  });
  assert.equal(free.status, 201, 'a free-text sale without any product link is accepted');
  assert.deepEqual(free.body.sale, {
    id: SALE_V, date: DATE, product: 'Algo variado', payment: 'transferencia', amountCents: 77700, productId: null, quantity: 1,
  }, 'the no-product contract is preserved: quantity stays 1, productId stays null');

  const tooMany = await send('POST', '/api/sales', {
    requestId: '00000000-0000-4000-8000-0000000000e1', date: DATE,
    product: 'Algo variado', payment: 'efectivo', amount: '7', quantity: 2,
  });
  // The database is shared across the file's tests: rejected-state invariants
  // compare against the count observed before each rejected payload.
  const rejectedSaleRowsBefore = await countSales();
  const rejectedMovementsBefore = await totalMovements();
  assert.equal(tooMany.body.error.code, 'INVALID_QUANTITY', 'quantity > 1 without a stock product is rejected');
  assert.equal((await send('POST', '/api/sales', {
    requestId: '00000000-0000-4000-8000-0000000000e2', date: DATE,
    product: 'X', payment: 'efectivo', amount: '7', productId: 'not-a-uuid',
  })).body.error.code, 'INVALID_PRODUCT_ID');
  assert.equal((await send('POST', '/api/sales', {
    requestId: '00000000-0000-4000-8000-0000000000e3', date: DATE,
    product: 'X', payment: 'efectivo', amount: '7', allowNegative: 'sí',
  })).body.error.code, 'INVALID_ALLOW_NEGATIVE', 'allowNegative must be an explicit boolean');
  assert.equal(await countSales(), rejectedSaleRowsBefore, 'the three rejected payloads created no sale row');
  assert.equal(await totalMovements(), rejectedMovementsBefore, 'and added no movement');

  const archivedProduct = (await send('POST', '/api/products', { name: 'Chico', stock: 5 })).body.product;
  await send('DELETE', '/api/products', { id: archivedProduct.id, previous: { stock: 5 } });
  const soldArchived = await send('POST', '/api/sales', {
    requestId: '00000000-0000-4000-8000-0000000000e4', date: DATE,
    product: 'Chico', payment: 'efectivo', amount: '500', productId: archivedProduct.id, quantity: 1,
  });
  assert.equal(soldArchived.status, 409, 'selling an archived product is rejected');
  assert.equal(soldArchived.body.error.code, 'PRODUCT_ARCHIVED');
  assert.equal(await movementCount('sale_id = $1', ['00000000-0000-4000-8000-0000000000e4']), 0,
    'no stock moved for the archived selection');

  const editedToArchived = await send('PUT', '/api/sales', {
    requestId: SALE_V, date: DATE, product: 'Algo variado', payment: 'transferencia', amount: '777',
    productId: archivedProduct.id, quantity: 1,
    previous: { requestId: SALE_V, date: DATE, product: 'Algo variado', payment: 'transferencia', amount: '777', productId: null, quantity: 1 },
  });
  assert.equal(editedToArchived.status, 409, 'linking an archived product by edit is rejected identically');
  assert.equal(editedToArchived.body.error.code, 'PRODUCT_ARCHIVED');
});

test('auth and origin guards protect the product endpoint with the shared session behavior', async t => {
  const app = await listen(t, stockOptions(bridge));
  const callsBefore = { gets: bridge.calls.gets, rpc: bridge.calls.rpc };
  const anonymous = await app.request('/api/products');
  assert.equal(anonymous.status, 401);
  assert.equal(anonymous.body.error.code, 'UNAUTHENTICATED');
  assert.equal(bridge.calls.gets + bridge.calls.rpc, callsBefore.gets + callsBefore.rpc,
    'no data access before the session is verified');

  const { send, cookie } = await app.enter();
  const crossOrigin = await app.request('/api/products', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'https://invasor.example', cookie },
    body: JSON.stringify({ name: 'Robo', stock: 1 }),
  });
  assert.deepEqual(crossOrigin, {
    status: 403, body: { error: { code: 'FORBIDDEN_ORIGIN', message: 'Origen no autorizado.' } }, setCookie: [],
  }, 'cross-origin product mutations are rejected before any body handling');
  const afterGuard = { gets: bridge.calls.gets, rpc: bridge.calls.rpc };
  assert.equal(afterGuard.rpc, callsBefore.rpc, 'guard-blocked requests never wrote');

  const invalid = await send('POST', '/api/products', { name: 'x-valid-name', stock: 'diez' });
  assert.equal(invalid.status, 400, 'a non-integer stock is invalid input');
  assert.equal(bridge.calls.rpc, afterGuard.rpc, 'validated-out requests never wrote');

  const wrongType = await app.request('/api/products', {
    method: 'POST',
    headers: { 'content-type': 'text/plain', origin: app.base },
    body: '{}',
  });
  assert.equal(wrongType.status, 415, 'the shared content-type contract holds for products too');
});

test('an unbound identity fails closed with honest 403 and zero side effects', async t => {
  const unboundDb = await createStockDb();
  await applyMigration(unboundDb); // no seedAuthUser: the registry stays empty
  t.after(() => unboundDb.close());
  const unboundBridge = createRestStockFetch(unboundDb);
  const app = await listen(t, stockOptions(unboundBridge));
  const { send, get } = await app.enter();

  const sale = await send('POST', '/api/sales', {
    requestId: '00000000-0000-4000-8000-0000000000bb', date: '2026-02-04',
    product: 'Sin acceso', payment: 'efectivo', amount: '1',
  });
  assert.equal(sale.status, 403, 'the RPC identity denial is a business-access 403');
  assert.equal(sale.body.error.code, 'FORBIDDEN');
  const product = await send('POST', '/api/products', { name: 'Sin acceso', stock: 1 });
  assert.equal(product.status, 403);
  assert.equal(product.body.error.code, 'FORBIDDEN');

  const listed = await get('/api/products');
  assert.deepEqual(listed.body, { storage: 'supabase', products: [] },
    'RLS keeps every table invisible to the unbound identity');
  assert.equal(unboundBridge.calls.rpc, 2, 'both write attempts reached PostgreSQL exactly once each');
});

test('a real transport outage is honest: 503, no automatic retry on the store call, nothing stored', async t => {
  const app = await listen(t, stockOptions(bridge));
  const { send } = await app.enter();
  const saleCountBefore = await countSales();
  const movementsBefore = await totalMovements();
  const getsBefore = bridge.calls.gets;
  const rpcBefore = bridge.calls.rpc;

  bridge.controls.failAll = true;
  const outage = await send('POST', '/api/sales', {
    requestId: '00000000-0000-4000-8000-0000000000cc', date: '2026-02-05',
    product: 'Caida', payment: 'efectivo', amount: '11',
  });
  assert.deepEqual(outage, {
    status: 503, body: { error: { code: 'STORAGE_UNAVAILABLE', message: 'No se pudo acceder a las ventas. Reintentá en unos momentos.' } }, setCookie: outage.setCookie,
  }, 'a transport failure is a plain 503, never a partial answer');
  const productOutage = await send('POST', '/api/products', { name: 'Caida', stock: 1 });
  assert.equal(productOutage.status, 503, 'product writes fail closed the same way');
  assert.equal(productOutage.body.error.code, 'STORAGE_UNAVAILABLE');
  assert.equal(bridge.calls.gets, getsBefore, 'the outage answered before any table call was recorded');
  assert.equal(bridge.calls.rpc, rpcBefore, 'no write attempt completed');
  bridge.controls.failAll = false;

  const recovered = await send('POST', '/api/sales', {
    requestId: '00000000-0000-4000-8000-0000000000cd', date: '2026-02-05',
    product: 'Caida', payment: 'efectivo', amount: '11',
  });
  assert.equal(recovered.status, 201, 'an explicit user retry after recovery succeeds');
  assert.equal(bridge.calls.rpc, rpcBefore + 1, 'recovery took exactly one create attempt');
  assert.equal(await countSales(), saleCountBefore + 1);
  assert.equal(await totalMovements(), movementsBefore, 'a free-text sale adds no movement');
});

test('RPC rows shaped as a one-row array are honored too', async t => {
  const arrayBridge = createRestStockFetch(sharedDb, { rowShape: 'array' });
  const app = await listen(t, stockOptions(arrayBridge));
  const { send, get } = await app.enter();
  const SALE = '00000000-0000-4000-8000-00000000001a';
  const DATE = '2026-02-06';
  const created = await send('POST', '/api/sales', {
    requestId: SALE, date: DATE, product: 'Array shape', payment: 'efectivo', amount: '150',
  });
  assert.equal(created.status, 201, 'the array-shaped composite row parses like the object shape');
  assert.deepEqual(created.body.sale, {
    id: SALE, date: DATE, product: 'Array shape', payment: 'efectivo', amountCents: 15000, productId: null, quantity: 1,
  });
  const list = await get(`/api/sales?date=${DATE}`);
  assert.equal(list.body.sales.find(s => s.id === SALE).id, SALE, 'table GETs shift shape independently of RPC rows');
});


// S1, odd/tasks/sale-stand.md: attribution travels with the row, not the login.
test('stand: two sessions persist independent stands and mismatched replay changes nothing', async t => {
  const app = await listen(t, stockOptions(bridge));
  const a = await app.enter(), b = await app.enter();
  assert.notEqual(a.cookie, b.cookie);
  const product = (await a.send('POST', '/api/products', { name: 'Stand shared stock', stock: 10 })).body.product;
  const fixed = { requestId: 'aaaa0000-0000-4000-8000-000000000001', date: '2026-02-03', product: product.name, payment: 'efectivo', amount: '2000', productId: product.id, quantity: 1, stand: 'fixed' };
  const mobile = { ...fixed, requestId: 'aaaa0000-0000-4000-8000-000000000002', stand: 'mobile' };
  for (const [client, draft] of [[a, fixed], [b, mobile]]) {
    const saved = await client.send('POST', '/api/sales', draft);
    assert.equal(saved.status, 201); assert.equal(saved.body.sale.stand, draft.stand);
  }
  const listed = await b.get('/api/sales?date=2026-02-03');
  assert.deepEqual(listed.body.sales.filter(s => [fixed.requestId, mobile.requestId].includes(s.id)).map(s => s.stand), ['fixed', 'mobile']);
  assert.equal((await productRow(product.name)).stock, 8);
  const before = [await countSales(), await totalMovements(), await productRow(product.name)];
  assert.equal((await a.send('POST', '/api/sales', fixed)).status, 200);
  const rejected = await b.send('POST', '/api/sales', { ...fixed, stand: 'mobile' });
  assert.equal(rejected.status, 409); assert.equal(rejected.body.error.code, 'ID_CONFLICT');
  assert.deepEqual([await countSales(), await totalMovements(), await productRow(product.name)], before);
});

test('stand: invalid values fail before storage; legacy missing stand stays unchanged', async t => {
  const { send } = await (await listen(t, stockOptions(bridge))).enter();
  const draft = { requestId: 'aaaa0000-0000-4000-8000-000000000003', date: '2026-02-04', product: 'Legacy stand', payment: 'efectivo', amount: '2000' };
  const before = [await countSales(), await totalMovements()];
  for (const stand of ['', 'other', 2, {}, true]) {
    const result = await send('POST', '/api/sales', { ...draft, stand });
    assert.equal(result.status, 400); assert.equal(result.body.error.code, 'INVALID_STAND');
  }
  assert.deepEqual([await countSales(), await totalMovements()], before);
  const legacy = await send('POST', '/api/sales', draft);
  assert.equal(legacy.status, 201); assert.deepEqual(legacy.body.sale, currentSalesShape(draft));
});

test('stand: changing attribution participates in edit/delete CAS without changing stock', async t => {
  const { send } = await (await listen(t, stockOptions(bridge))).enter();
  const draft = { requestId: 'aaaa0000-0000-4000-8000-000000000004', date: '2026-02-05', product: 'Stand CAS', payment: 'efectivo', amount: '2000', stand: 'fixed' };
  assert.equal((await send('POST', '/api/sales', draft)).status, 201);
  const before = await totalMovements();
  const edited = await send('PUT', '/api/sales', { ...draft, stand: 'mobile', previous: draft });
  assert.equal(edited.status, 200); assert.equal(edited.body.sale.stand, 'mobile');
  for (const [method, body] of [['PUT', { ...draft, amount: '3000', previous: draft }], ['DELETE', { id: draft.requestId, previous: draft }]]) {
    const stale = await send(method, '/api/sales', body);
    assert.equal(stale.status, 409); assert.equal(stale.body.error.code, 'SALE_CONFLICT');
  }
  assert.equal(await totalMovements(), before);
  const removed = await send('DELETE', '/api/sales', { id: draft.requestId, previous: { ...draft, stand: 'mobile' } });
  assert.equal(removed.status, 200); assert.equal(removed.body.sale.stand, 'mobile');
});
