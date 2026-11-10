import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../server.js';
import { encodeContainer } from '../lib/session.js';

const SESSION_KEY = 'k'.repeat(32);
const IDLE_LIMIT_MS = 60 * 60 * 1000;

// T2 spec S4/S6 (odd/tasks/supabase-sales.md): a simple business login for the
// one approved identity. Every test is HTTP through the public routes with a
// deterministic fake of the Supabase Auth service; the fake never stores the
// password and revokes tokens so expired/revoked/foreign handling is observed
// exactly like the real service (verify via /auth/v1/user before any use).

const ALLOWED_UID = '11111111-1111-1111-1111-111111111111';
const FOREIGN_UID = '22222222-2222-2222-2222-222222222222';
// v2 T1 (odd/tasks/stock-v2.md): the allowed business email is fixed in the
// app code, so no env var selects the identity anymore.
const EMAIL = 'pochoclos@negocio.com';
const FOREIGN_EMAIL = 'otra@negocio.com';
const PASSWORD = 'correct password';

const env = (extra = {}) => ({
  SUPABASE_URL: 'https://auth.test',
  SUPABASE_ANON_KEY: 'anon-key-for-tests',
  SUPABASE_ALLOWED_USER_ID: ALLOWED_UID,
  SUPABASE_SESSION_KEY: 'k'.repeat(32),
  ...extra,
});

// A fake of only the Supabase Auth surface the app may use. /rest/v1 calls are
// unexpected in these tests and are recorded, never served.
function fakeSupabaseAuth() {
  const users = {
    [ALLOWED_UID]: { id: ALLOWED_UID, email: EMAIL },
    [FOREIGN_UID]: { id: FOREIGN_UID, email: FOREIGN_EMAIL },
  };
  const accessTokens = new Map(); // access token -> { uid, generation, revoked }
  const refreshTokens = new Map(); // refresh token -> { uid, revoked }
  const controls = {
    generation: 0, failAll: false, breakRefresh: false,
    // When set, a stale presented access token (expired/revoked for the
    // fake's records) is answered with this exact status/body, like real
    // GoTrue answers an expired JWT.
    staleAnswer: null,
    // When set, EVERY /auth/v1/user call is answered this way: a
    // service-wide error, not a per-token verdict.
    userAnswer: null,
    // When set (a status number), the refresh grant answers with that status.
    refreshStatus: null,
  };
  const counts = { password: 0, refresh: 0, user: 0, logout: 0, rest: 0 };
  let lastLogoutMethod = null;
  let serial = 0;
  const respond = (status, payload) => new Response(
    status === 204 ? null : JSON.stringify(payload),
    { status, headers: { 'content-type': 'application/json' } },
  );
  function issue(uid) {
    const access = `at-${++serial}`;
    const refresh = `rt-${serial}`;
    accessTokens.set(access, { uid, generation: controls.generation, revoked: false });
    refreshTokens.set(refresh, { uid, revoked: false });
    return { access_token: access, refresh_token: refresh, expires_in: 3600 };
  }
  const fetchImpl = async (url, options = {}) => {
    const parsed = new URL(url);
    assert.equal(parsed.host, 'auth.test');
    const body = options.body ? JSON.parse(options.body) : {};
    const bearer = (options.headers?.authorization || '').replace(/^Bearer /, '');
    if (parsed.pathname === '/rest/v1/sales') {
      counts.rest += 1;
      throw new Error(`unexpected Supabase REST call: ${parsed.search}`);
    }
    if (controls.failAll) throw new TypeError('fetch failed');
    if (parsed.pathname === '/auth/v1/token' && parsed.searchParams.get('grant_type') === 'password') {
      counts.password += 1;
      const user = Object.values(users).find(entry => entry.email === body.email);
      if (!user || body.password !== PASSWORD) {
        return respond(400, { error: 'invalid_grant', message: 'Invalid login credentials' });
      }
      return respond(200, { ...issue(user.id), token_type: 'bearer', user });
    }
    if (parsed.pathname === '/auth/v1/token' && parsed.searchParams.get('grant_type') === 'refresh_token') {
      counts.refresh += 1;
      if (controls.refreshStatus !== null) return respond(controls.refreshStatus, { message: `simulated ${controls.refreshStatus} from the Auth service` });
      const record = refreshTokens.get(body.refresh_token);
      if (controls.breakRefresh || !record || record.revoked) {
        return respond(400, { error: 'invalid_grant', message: 'Invalid Refresh Token' });
      }
      record.revoked = true; // real rotation revokes the used refresh token
      return respond(200, { ...issue(record.uid), token_type: 'bearer', user: users[record.uid] });
    }
    if (parsed.pathname === '/auth/v1/user') {
      counts.user += 1;
      if (controls.userAnswer) return respond(controls.userAnswer.status, controls.userAnswer.body);
      const record = accessTokens.get(bearer);
      if (!record || record.revoked || record.generation !== controls.generation) {
        if (controls.staleAnswer) return respond(controls.staleAnswer.status, controls.staleAnswer.body);
        return respond(401, { message: 'invalid claim: missing sub claim', code: 401 });
      }
      return respond(200, users[record.uid]);
    }
    if (parsed.pathname === '/auth/v1/logout') {
      counts.logout += 1;
      lastLogoutMethod = options.method || 'GET';
      if (lastLogoutMethod !== 'POST') {
        // Real GoTrue only accepts POST /auth/v1/logout; GET would leak a
        // successful revoke that never happened.
        return respond(405, { message: 'HTTP method not allowed' });
      }
      const record = accessTokens.get(bearer);
      if (record) {
        record.revoked = true;
        for (const entry of refreshTokens.values()) if (entry.uid === record.uid) entry.revoked = true;
      }
      return respond(204, undefined);
    }
    throw new Error(`unexpected Supabase call: ${parsed.pathname}`);
  };
  return { fetchImpl, controls, counts, get lastLogoutMethod() { return lastLogoutMethod; } };
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
  const login = (email = EMAIL, password = PASSWORD, headers = {}) => request('/api/session', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: base, ...headers },
    body: JSON.stringify({ email, password }),
  });
  const cookie = response => response.setCookie[0].split(';')[0];

  const withSession = (response, headers = {}) => ({ headers: { cookie: cookie(response), ...headers } });
  return { base, request, login, cookie, withSession };
}

const sessionValue = header => header.split(';')[0].slice('v2_session='.length);

test('missing or incomplete session configuration fails closed everywhere', async t => {
  const fake = fakeSupabaseAuth();
  const variants = [
    ['SUPABASE_URL'], ['SUPABASE_ANON_KEY'], ['SUPABASE_ALLOWED_USER_ID'],
    ['SUPABASE_SESSION_KEY'],
  ].map(([key]) => {
    const incomplete = env();
    delete incomplete[key];
    return incomplete;
  });

  variants.push({ ...env(), SUPABASE_SESSION_KEY: 'short' });
  variants.push({ ...env(), SUPABASE_ALLOWED_USER_ID: 'not-a-uuid' });
  for (const environment of variants) {
    const app = await listen(t, { env: environment, supabaseFetch: fake.fetchImpl });
    await expectConfig(app, `config: ${JSON.stringify(environment)}`);
  }
  assert.equal(fake.counts.rest, 0, 'no data access while unconfigured');
  async function expectConfig(app, label) {
    const expected = { status: 503, body: { error: { code: 'SESSION_CONFIG', message: 'Falta configurar la sesión de Supabase.' } }, setCookie: [] };
    assert.deepEqual(await app.request('/api/session'), expected, label);
    assert.deepEqual(await app.request('/api/sales?date=2026-11-07'), expected, label);
    const login = await app.request('/api/session', {
      method: 'POST', headers: { 'content-type': 'application/json', origin: app.base },
      body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
    });
    assert.deepEqual(login, expected, label);
  }
});

test('the cookie carries the distinct v2 name: another deployment\'s session cookie is never read', async t => {
  const fake = fakeSupabaseAuth();
  const app = await listen(t, { env: env(), supabaseFetch: fake.fetchImpl });
  const login = await app.login();
  assert.match(login.setCookie[0], /^v2_session=/, 'the issued cookie uses the v2 name');
  const foreignName = await app.request('/api/session', {
    headers: { cookie: `session=${sessionValue(login.setCookie[0])}` },
  });
  assert.deepEqual(foreignName, { status: 200, body: { status: 'anonymous' }, setCookie: [] },
    'a cookie under any other name stays unread and anonymous');
  const foreignSales = await app.request('/api/sales?date=2026-11-07', {
    headers: { cookie: `session=${sessionValue(login.setCookie[0])}` },
  });
  assert.equal(foreignSales.status, 401);
  assert.equal(fake.counts.rest, 0);
});

test('the v2 identity is the fixed business account: a matching uid with a different email is rejected', async t => {
  const fake = fakeSupabaseAuth();
  const app = await listen(t, { env: env(), supabaseFetch: fake.fetchImpl });
  const login = await app.login();
  assert.equal(login.status, 200);
  // Supabase answers with the same allowed user id but another business's
  // email: the identity must fail closed before any data access.
  fake.controls.userAnswer = { status: 200, body: { id: ALLOWED_UID, email: FOREIGN_EMAIL } };
  const spoofed = await app.request('/api/session', app.withSession(login));
  assert.deepEqual(spoofed, { status: 200, body: { status: 'anonymous' }, setCookie: [] });
  const spoofedSales = await app.request('/api/sales?date=2026-11-07', app.withSession(login));
  assert.equal(spoofedSales.status, 401);
  assert.deepEqual(spoofedSales.body, {
    error: { code: 'SESSION_INVALID', message: 'La sesión no es válida o venció. Iniciá sesión nuevamente.' },
  });
  assert.ok(spoofedSales.setCookie.length > 0, 'a failed identity clears the cookie');
  assert.equal(fake.counts.rest, 0, 'a wrong-email identity never reaches data');
});

test('login accepts only the approved identity and issues an encrypted HttpOnly cookie', async t => {
  const fake = fakeSupabaseAuth();
  const app = await listen(t, { env: env(), supabaseFetch: fake.fetchImpl });
  const wrongPassword = await app.request('/api/session', {
    method: 'POST', headers: { 'content-type': 'application/json', origin: app.base },
    body: JSON.stringify({ email: EMAIL, password: 'incorrect password' }),
  });
  assert.deepEqual(wrongPassword, { status: 401, body: { error: { code: 'INVALID_CREDENTIALS', message: 'Correo o contraseña incorrectos.' } }, setCookie: [] });
  const foreign = await app.login(FOREIGN_EMAIL);
  assert.deepEqual(foreign, {
    status: 401, body: { error: { code: 'INVALID_CREDENTIALS', message: 'Correo o contraseña incorrectos.' } }, setCookie: [],
  }, 'a foreign Supabase Auth account is not distinguishable from a wrong password');
  assert.equal(fake.counts.password, 2);
  assert.equal(fake.counts.user, 1, 'identity verified against Supabase exactly when credentials granted a token');
  const success = await app.login();
  assert.equal(success.status, 200);
  assert.deepEqual(success.body, { status: 'authenticated' });
  const setCookie = success.setCookie[0];
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /SameSite=Lax/);
  assert.match(setCookie, /Secure/);
  assert.match(setCookie, /Path=\//);
  const value = sessionValue(setCookie);
  assert.ok(value.length > 60, 'the cookie carries an opaque container');
  assert.ok(!value.includes('at-'), 'no access token appears in the cookie');
  assert.ok(!value.includes(PASSWORD), 'the password never reaches the cookie');
  assert.ok(!value.includes(EMAIL), 'the identity is not stored in plaintext');
  assert.ok(fake.counts.user >= 2);
});

test('status reports anonymous without the cookie and authenticated with it; sales reject the missing session', async t => {
  const fake = fakeSupabaseAuth();
  const app = await listen(t, { env: env(), supabaseFetch: fake.fetchImpl });
  assert.deepEqual(await app.request('/api/session'), { status: 200, body: { status: 'anonymous' }, setCookie: [] });
  const anonymousSales = await app.request('/api/sales?date=2026-11-07');
  assert.deepEqual(anonymousSales, {
    status: 401, body: { error: { code: 'UNAUTHENTICATED', message: 'Iniciá sesión para continuar.' } }, setCookie: [],
  });
  assert.equal(fake.counts.rest, 0, 'unauthenticated access is rejected before any data access');
  const guest = await app.request('/api/sales', {
    method: 'POST', headers: { 'content-type': 'application/json', origin: app.base },
    body: JSON.stringify({ requestId: '00000000-0000-4000-8000-000000000001', date: '2026-11-07', product: 'Prueba', payment: 'efectivo', amount: '1' }),
  });
  assert.equal(guest.status, 401);
  assert.equal(fake.counts.rest, 0, 'no writes are attempted without a session');
  const login = await app.login();
  const status = await app.request('/api/session', app.withSession(login));
  assert.deepEqual(status.body, { status: 'authenticated' });
  assert.equal(status.setCookie.length, 1, 'verified activity deliberately renews the one-hour deadline');
  assert.match(status.setCookie[0], /Max-Age=3600/);
  assert.equal(fake.counts.rest, 0, 'status never opens the data plane');
  const forged = await app.request('/api/session', { headers: { cookie: 'v2_session=forged-garbage' } });
  assert.equal(forged.status, 200);
  assert.deepEqual(forged.body, { status: 'anonymous' }, 'a forged container is simply anonymous');
  const forgedSales = await app.request('/api/sales?date=2026-11-07', { headers: { cookie: 'v2_session=forged-garbage' } });
  assert.equal(forgedSales.status, 401);
  assert.equal(fake.counts.rest, 0, 'forged containers never unlock data');
});

test('mutating endpoints require same-origin requests; GET status is unaffected', async t => {
  const fake = fakeSupabaseAuth();
  const app = await listen(t, { env: env(), supabaseFetch: fake.fetchImpl });
  const expected = { status: 403, body: { error: { code: 'FORBIDDEN_ORIGIN', message: 'Origen no autorizado.' } }, setCookie: [] };
  assert.deepEqual(await app.request('/api/session', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  }), expected, 'a login without Origin is rejected');
  assert.deepEqual(await app.request('/api/session', {
    method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://invasor.example' },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  }), expected, 'a cross-origin login is rejected');
  const miss = await app.request('/api/sales', {
    method: 'POST', headers: { 'content-type': 'application/json', origin: 'http://localhost:9999' },
    body: JSON.stringify({ requestId: '00000000-0000-4000-8000-000000000002', date: '2026-11-07', product: 'Prueba', payment: 'efectivo', amount: '1' }),
  });
  assert.deepEqual(miss, expected);
  assert.equal(fake.counts.rest, 0, 'cross-origin mutations never touch data');
  assert.deepEqual(await app.request('/api/session'), { status: 200, body: { status: 'anonymous' }, setCookie: [] });
  assert.equal(fake.counts.logout, 0);
  assert.deepEqual(await app.request('/api/session', { method: 'DELETE', headers: { origin: 'https://invasor.example' } }), expected, 'cross-origin logout is rejected');
});

test('an expired access token refreshes transparently and reissues the cookie', async t => {
  const fake = fakeSupabaseAuth();
  const app = await listen(t, { env: env(), supabaseFetch: fake.fetchImpl });
  const login = await app.login();
  const before = sessionValue(login.setCookie[0]);
  fake.controls.generation += 1; // every issued access token becomes expired
  const refreshed = await app.request('/api/session', app.withSession(login));
  assert.equal(refreshed.status, 200);
  assert.deepEqual(refreshed.body, { status: 'authenticated' });
  assert.equal(fake.counts.refresh, 1, 'exactly one refresh grant');
  assert.equal(fake.counts.rest, 0);
  assert.equal(refreshed.setCookie.length, 1, 'the refreshed container is reissued');
  const after = sessionValue(refreshed.setCookie[0]);
  assert.notEqual(after, before, 'rotated tokens replace the cookie value');
  assert.match(refreshed.setCookie[0], /HttpOnly/);
  assert.equal(fake.counts.refresh, 1, 'the following call reuses the rotated tokens without another refresh');
  const again = await app.request('/api/session', { headers: { cookie: `v2_session=${after}` } });
  assert.equal(again.status, 200);
  assert.deepEqual(again.body, { status: 'authenticated' });
  assert.equal(again.setCookie.length, 1, 'the renewed deadline is reissued deliberately');
  assert.notEqual(sessionValue(again.setCookie[0]), after, 'a later timestamp is wrapped into a fresh container');
  // The stale container can no longer ride on the rotated refresh token.
  const stale = await app.request('/api/session', { headers: { cookie: `v2_session=${before}` } });
  assert.deepEqual(stale, { status: 200, body: { status: 'anonymous' }, setCookie: [] }, 'an old rotated container is not authenticated');
});

test('revoked sessions fail closed with the exact status and clear the cookie', async t => {
  const fake = fakeSupabaseAuth();
  const app = await listen(t, { env: env(), supabaseFetch: fake.fetchImpl });
  const login = await app.login();
  await app.request('/api/session', { method: 'DELETE', headers: { origin: app.base, ...app.withSession(login).headers } });
  assert.equal(fake.counts.logout, 1, 'Supabase logout is called to revoke server-side');
  const revokedSales = await app.request('/api/sales?date=2026-11-07', app.withSession(login));
  assert.equal(revokedSales.status, 401);
  assert.deepEqual(revokedSales.body, {
    error: { code: 'SESSION_INVALID', message: 'La sesión no es válida o venció. Iniciá sesión nuevamente.' },
  });
  assert.match(revokedSales.setCookie[0], /v2_session=; Path=\//);
  assert.match(revokedSales.setCookie[0], /Max-Age=0/);
  assert.equal(fake.counts.rest, 0, 'a revoked session never reaches data');
  const revokedStatus = await app.request('/api/session', app.withSession(login));
  assert.deepEqual(revokedStatus, { status: 200, body: { status: 'anonymous' }, setCookie: [] });
  fake.controls.breakRefresh = true;
  fake.controls.generation += 1; // access token expired and refresh is broken
  const broken = await app.request('/api/sales?date=2026-11-07', app.withSession(login));
  assert.equal(broken.status, 401);
  assert.deepEqual(broken.body, { error: { code: 'SESSION_INVALID', message: 'La sesión no es válida o venció. Iniciá sesión nuevamente.' } });
  assert.match(broken.setCookie[0], /Max-Age=0/);
  assert.equal(fake.counts.rest, 0);
});

test('logout revokes through POST and any later use of the old cookie is revoked', async t => {
  const fake = fakeSupabaseAuth();
  const app = await listen(t, { env: env(), supabaseFetch: fake.fetchImpl });
  // The fake itself must reject the wrong verb, so the test cannot pass while
  // the app revokes with GET.
  const wrongMethod = await fake.fetchImpl(`https://auth.test/auth/v1/logout`, { headers: { authorization: 'Bearer at-1' } });
  assert.equal(wrongMethod.status, 405, 'GET /auth/v1/logout must not succeed');
  const login = await app.login();
  const out = await app.request('/api/session', { method: 'DELETE', headers: { origin: app.base, ...app.withSession(login).headers } });
  assert.equal(out.status, 200);
  assert.deepEqual(out.body, { status: 'anonymous' });
  assert.equal(fake.counts.logout, 2, 'one wrong-method probe plus the app logout');
  assert.equal(fake.lastLogoutMethod, 'POST', 'GoTrue revocations use POST /auth/v1/logout');
  assert.match(out.setCookie[0], /Max-Age=0/, 'the cookie is cleared on confirmation');
  const revokedSales = await app.request('/api/sales?date=2026-11-07', app.withSession(login));
  assert.equal(revokedSales.status, 401, 'the old session is revoked server-side: verification fails');
  assert.deepEqual(revokedSales.body.error.code, 'SESSION_INVALID');
  assert.equal(fake.counts.rest, 0, 'a logged-out token never reaches data');
});

test('the configured app origin governs proxied requests; forwarded headers never grant anything', async t => {
  const fake = fakeSupabaseAuth();
  const app = await listen(t, { env: { ...env(), SUPABASE_APP_ORIGIN: 'https://app.example.com' }, supabaseFetch: fake.fetchImpl });
  // legitimate browser request through the deployment proxy
  const proxied = await app.login(EMAIL, PASSWORD, { origin: 'https://app.example.com', 'x-forwarded-host': 'app.example.com' });
  assert.deepEqual(proxied.body, { status: 'authenticated' }, 'a legit proxy request with the canonical origin succeeds');
  // a trusted proxy might not forward host headers in every platform
  const withoutForwarding = await app.request('/api/session', {
    method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://app.example.com' },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  assert.deepEqual(withoutForwarding.body, { status: 'authenticated' });
  // foreign origin never passes, whatever forwarded headers claim
  const foreign = await app.login(EMAIL, PASSWORD, { origin: 'https://invasor.example', 'x-forwarded-host': 'app.example.com' });
  assert.deepEqual(foreign, { status: 403, body: { error: { code: 'FORBIDDEN_ORIGIN', message: 'Origen no autorizado.' } }, setCookie: [] });
  // a forged forwarded host cannot grant a foreign origin either
  const forgedForwarded = await app.login(EMAIL, PASSWORD, { origin: 'https://app.example.com', 'x-forwarded-host': 'invasor.example' });
  assert.deepEqual(forgedForwarded, { status: 403, body: { error: { code: 'FORBIDDEN_ORIGIN', message: 'Origen no autorizado.' } }, setCookie: [] });
  assert.equal(fake.counts.password, 2, 'rejected requests never reach Supabase');
  // direct mode keeps the strict Origin==Host rule and a forged forwarded
  // host cannot grant a foreign origin there either
  const direct = await listen(t, { env: env(), supabaseFetch: fake.fetchImpl });
  assert.deepEqual(await direct.login(EMAIL, PASSWORD, { origin: 'https://invasor.example', 'x-forwarded-host': direct.base.replace(/^http:\/\//, '') }), {
    status: 403, body: { error: { code: 'FORBIDDEN_ORIGIN', message: 'Origen no autorizado.' } }, setCookie: [],
  });
  // malformed canonical origin fails closed before any session work
  const broken = await listen(t, { env: { ...env(), SUPABASE_APP_ORIGIN: 'not-a-url' }, supabaseFetch: fake.fetchImpl });
  assert.deepEqual(await broken.request('/api/session'), {
    status: 503, body: { error: { code: 'SESSION_CONFIG', message: 'Falta configurar la sesión de Supabase.' } }, setCookie: [],
  });
  assert.deepEqual(await broken.request('/api/session', {
    method: 'POST', headers: { 'content-type': 'application/json', origin: broken.base },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  }), {
    status: 503, body: { error: { code: 'SESSION_CONFIG', message: 'Falta configurar la sesión de Supabase.' } }, setCookie: [],
  });
});

test('logout is idempotent, forged containers are anonymous and failures stay honest', async t => {
  const fake = fakeSupabaseAuth();
  const app = await listen(t, { env: env(), supabaseFetch: fake.fetchImpl });
  assert.deepEqual(await app.request('/api/session', { method: 'DELETE', headers: { origin: app.base } }), {
    status: 200, body: { status: 'anonymous' }, setCookie: [],
  }, 'logout without a session succeeds');
  const forged = await app.request('/api/session', { method: 'DELETE', headers: { origin: app.base, cookie: 'v2_session=forged' } });
  assert.equal(forged.status, 200);
  assert.deepEqual(forged.body, { status: 'anonymous' }, 'an unreadable container is anonymous and dropped');
  assert.match(forged.setCookie[0], /v2_session=; Path=\//);
  assert.match(forged.setCookie[0], /Max-Age=0/);
  assert.equal(fake.counts.logout, 0, 'nothing is revoked for an unreadable container');
  fake.controls.failAll = true;
  const login = await app.login(); // auth is still reachable in this fake? No:
  assert.equal(login.status, 503, 'a down Supabase reports an unavailable session');
  assert.deepEqual(login.body, { error: { code: 'SESSION_UNAVAILABLE', message: 'No se pudo contactar Supabase. Reintentá en unos momentos.' } });
  const plain = await app.request('/api/session', { method: 'DELETE', headers: { origin: app.base } });
  assert.deepEqual(plain, {
    status: 200, body: { status: 'anonymous' }, setCookie: [],
  }, 'logout of a session-less request needs no service call');
  fake.controls.failAll = false;
  const realLogin = await app.login();
  fake.controls.failAll = true;
  const failedLogout = await app.request('/api/session', { method: 'DELETE', headers: { origin: app.base, ...app.withSession(realLogin).headers } });
  assert.deepEqual(failedLogout, {
    status: 503, body: { error: { code: 'SESSION_UNAVAILABLE', message: 'No se pudo contactar Supabase. Reintentá en unos momentos.' } }, setCookie: [],
  }, 'an unconfirmed logout keeps the cookie instead of pretending success');
});

test('a 403 bad_jwt answer enters the one existing refresh path exactly once; service errors and refresh outages stay honest', async t => {
  const badJwt = body => body && (body.code === 'bad_jwt' || body.error_code === 'bad_jwt');

  const fake = fakeSupabaseAuth();
  const app = await listen(t, { env: env(), supabaseFetch: fake.fetchImpl });
  // Real GoTrue reports an expired access token as 403 bad_jwt (diagnostic L3);
  // both provider identifier spellings must behave like the 401 path.
  for (const staleAnswer of [
    { status: 403, body: { error_code: 'bad_jwt', message: 'Invalid JWT: unable to parse or verify signature' } },
    { status: 403, body: { error: 'invalid_grant', code: 'bad_jwt', message: 'Invalid JWT' } },
  ]) {
    fake.controls.staleAnswer = staleAnswer;
    const login = await app.login();
    fake.controls.generation += 1; // every issued access token goes stale
    const renewed = await app.request('/api/session', app.withSession(login));
    assert.deepEqual(renewed.body, { status: 'authenticated' });
    assert.equal(renewed.status, 200, `403 bad_jwt (${badJwt(staleAnswer.body) ? 'identified' : 'unidentified'}) renews through the existing refresh path`);
    assert.equal(renewed.setCookie.length, 1, 'the renewed session is deliberately reissued');
    const next = await app.request('/api/session', { headers: { cookie: app.cookie(renewed) } });
    assert.equal(next.status, 200, 'the rotated tokens verify directly afterwards');
  }
  assert.equal(fake.counts.refresh, 2, 'exactly one refresh grant per staleness episode');
  assert.equal(fake.counts.rest, 0);

  // A plain 403 (service hiccup or HTML error page, no provider identifier)
  // is genuine service trouble: 503, cookie untouched, no refresh, no data.
  fake.controls.staleAnswer = null;
  const login = await app.login();
  fake.controls.userAnswer = { status: 403, body: { code: 403, message: 'service error, not a token verdict' } };
  const priorRefreshes = fake.counts.refresh;
  const priorUsers = fake.counts.user;
  fake.controls.generation += 1;
  const outage = await app.request('/api/sales?date=2026-11-07', app.withSession(login));
  assert.deepEqual(outage, {
    status: 503, body: { error: { code: 'SESSION_UNAVAILABLE', message: 'No se pudo contactar Supabase. Reintentá en unos momentos.' } }, setCookie: [],
  }, 'an unidentified 403 is an honest 503, not an expired session');
  assert.equal(fake.counts.refresh, priorRefreshes, 'no refresh is attempted for a plain service 403');
  assert.equal(fake.counts.user, priorUsers + 1, 'exactly the failed verification ran');
  assert.equal(fake.counts.rest, 0);
  fake.controls.userAnswer = null;

  // When the token itself is rejected (bad_jwt) but the held refresh token is
  // revoked, the protected route answers the exact 401 and clears the cookie.
  fake.controls.staleAnswer = { status: 403, body: { error_code: 'bad_jwt', message: 'Invalid JWT: token expired' } };
  fake.controls.breakRefresh = true;
  fake.controls.generation += 1;
  const rejected = await app.request('/api/sales?date=2026-11-07', app.withSession(login));
  assert.equal(rejected.status, 401);
  assert.deepEqual(rejected.body, { error: { code: 'SESSION_INVALID', message: 'La sesión no es válida o venció. Iniciá sesión nuevamente.' } });
  assert.match(rejected.setCookie[0], /v2_session=; Path=\//);
  assert.match(rejected.setCookie[0], /Max-Age=0/);
  assert.equal(fake.counts.refresh, priorRefreshes + 1, 'the rejected refresh ran once through the existing path');
  assert.equal(fake.counts.rest, 0, 'no data access during the failed episode');

  // A genuine outage (429/5xx/network) during refresh stays 503 with the
  // cookie unchanged; a later retry with the same cookie still works.
  const healthy = await app.login();
  fake.controls.breakRefresh = false;
  fake.controls.refreshStatus = 429;
  fake.controls.generation += 1;
  const overwhened = await app.request('/api/session', app.withSession(healthy));
  assert.deepEqual(overwhened, {
    status: 503, body: { error: { code: 'SESSION_UNAVAILABLE', message: 'No se pudo contactar Supabase. Reintentá en unos momentos.' } }, setCookie: [],
  }, 'a throttling outage during refresh is never misread as a dead session');
  fake.controls.refreshStatus = null; // the outage passes
  const recovered = await app.request('/api/session', app.withSession(healthy));
  assert.equal(recovered.status, 200, 'the unchanged cookie still works after the outage passes');
});

test('the server-enforced one-hour idle deadline expires before any Auth or data call and activity slides it', async t => {
  const fake = fakeSupabaseAuth();
  const app = await listen(t, { env: env(), supabaseFetch: fake.fetchImpl });
  const realNow = Date.now;
  let clock = 1800000000000;
  Date.now = () => clock; // deterministic time through public HTTP, never a real sleep
  t.after(() => { Date.now = realNow; });

  const login = await app.login();
  assert.match(login.setCookie[0], /Max-Age=3600/, 'the cookie mirrors the accepted one-hour inactivity window');
  const originalCookie = { headers: { cookie: app.cookie(login) } };
  assert.equal(fake.counts.user, 1, 'the login verified the identity once');

  // Before the hour: verified activity renews the encrypted deadline.
  clock += 59 * 60000;
  const slide = await app.request('/api/session', originalCookie);
  assert.equal(slide.status, 200, '59 idle minutes still authenticate');
  assert.equal(slide.setCookie.length, 1, 'verified activity deliberately renews the cookie');
  assert.match(slide.setCookie[0], /Max-Age=3600/);
  const slidCookie = { headers: { cookie: app.cookie(slide) } };
  assert.equal(fake.counts.user, 2, 'the sliding activity happened through a verified Auth call');

  // Activity from the renewed deadline keeps it alive indefinitely.
  clock += 90 * 60000;
  const active = await app.request('/api/session', slidCookie);
  assert.equal(active.status, 200, 'the renewal carried a fresh inside-the-hour timestamp');

  // The ORIGINAL snapshot expires at its own deadline: 1h of real inactivity.
  clock += 3600000;
  const usersBefore = fake.counts.user;
  const refreshesBefore = fake.counts.refresh;
  const expired = await app.request('/api/sales?date=2026-11-07', originalCookie);
  assert.equal(expired.status, 401, 'after one idle hour the session is dead');
  assert.deepEqual(expired.body, { error: { code: 'SESSION_INVALID', message: 'La sesión no es válida o venció. Iniciá sesión nuevamente.' } });
  assert.match(expired.setCookie[0], /v2_session=; Path=\//);
  assert.match(expired.setCookie[0], /Max-Age=0/);
  assert.equal(fake.counts.user, usersBefore, 'no Auth verification runs on the expired deadline');
  assert.equal(fake.counts.refresh, refreshesBefore, 'no refresh grant runs on the expired deadline');
  assert.equal(fake.counts.rest, 0, 'no data access runs on the expired deadline');
  assert.deepEqual(await app.request('/api/session', originalCookie), {
    status: 200, body: { status: 'anonymous' }, setCookie: [],
  }, 'the expired session is simply anonymous to status');

  // Exact boundary, one fresh container: 1ms before the hour is alive, the
  // exact hour mark is expired, and past it stays expired.
  const fresh = await app.login();
  const boundaryCookie = { headers: { cookie: app.cookie(fresh) } };
  clock += (IDLE_LIMIT_MS - 1);
  assert.equal((await app.request('/api/session', boundaryCookie)).status, 200, 'one millisecond before the hour is still alive');
  clock += 1;
  const atHour = await app.request('/api/sales?date=2026-11-07', boundaryCookie);
  assert.equal(atHour.status, 401, 'exactly one idle hour rejects');
  assert.deepEqual(atHour.body.error.code, 'SESSION_INVALID');
  clock += 60000;
  assert.equal((await app.request('/api/sales?date=2026-11-07', boundaryCookie)).status, 401, 'still rejected past the hour');
  const usersAfterBoundary = fake.counts.user;
  clock += 120000;
  await app.request('/api/sales?date=2026-11-07', boundaryCookie);
  assert.equal(fake.counts.user, usersAfterBoundary, 'expiry answers never call Auth');
});

test('containers without the trusted one-hour timestamp (or with an implausible one) fail closed to a fresh login', async t => {
  const fake = fakeSupabaseAuth();
  const app = await listen(t, { env: env(), supabaseFetch: fake.fetchImpl });
  const login = await app.login();
  const verifiedUsers = fake.counts.user;

  // A pre-deploy 30-day cookie style container: same key and helpers, no
  // timestamp field. It must never bootstrap a deadline: fresh login.
  const old = { headers: { cookie: `v2_session=${encodeContainer({ access: 'at-1', refresh: 'rt-1' }, SESSION_KEY)}` } };
  const oldSales = await app.request('/api/sales?date=2026-11-07', old);
  assert.equal(oldSales.status, 401);
  assert.deepEqual(oldSales.body, { error: { code: 'SESSION_INVALID', message: 'La sesión no es válida o venció. Iniciá sesión nuevamente.' } });
  assert.match(oldSales.setCookie[0], /v2_session=; Path=\//);
  assert.match(oldSales.setCookie[0], /Max-Age=0/);
  assert.equal(fake.counts.user, verifiedUsers, 'the timestampless container verified nothing');
  assert.equal(fake.counts.refresh, 0, 'no refresh grant runs for a timestampless container');
  assert.equal(fake.counts.rest, 0, 'no data access for a timestampless container');

  // An implausibly future timestamp cannot prolong authentication either.
  const forged = { headers: { cookie: `v2_session=${encodeContainer({ access: 'at-1', refresh: 'rt-1', last: Date.now() + 10 * 60000 }, SESSION_KEY)}` } };
  const forgedSales = await app.request('/api/sales?date=2026-11-07', forged);
  assert.equal(forgedSales.status, 401, 'a future timestamp is rejected instead of extending idle time');
  assert.deepEqual(forgedSales.body.error.code, 'SESSION_INVALID');
  assert.equal(fake.counts.user, verifiedUsers, 'no Auth call trusts a future timestamp');
  assert.equal(fake.counts.refresh, 0);
  assert.equal(fake.counts.rest, 0);

  // A structurally valid, plausible server-issued timestamp still works: the
  // supported normal use of the helpers is preserved.
  const plausible = { headers: { cookie: `v2_session=${encodeContainer({ access: 'at-1', refresh: 'rt-1', last: Date.now() - 30 * 60000 }, SESSION_KEY)}` } };
  const plausibleStatus = await app.request('/api/session', plausible);
  assert.equal(plausibleStatus.status, 200);
  assert.deepEqual(plausibleStatus.body, { status: 'authenticated' });
  assert.equal(fake.counts.user, verifiedUsers + 1, 'the plausible container verified against Auth as always');
});

test('the session endpoint keeps the public contract: methods, types, bodies and fail-closed without configuration (Supabase-only)', async t => {
  const fake = fakeSupabaseAuth();
  const app = await listen(t, { env: env(), supabaseFetch: fake.fetchImpl });
  await expectSessionContract(app);
  async function expectSessionContract(app) {
    const unallowed = await fetch(`${app.base}/api/session`, { method: 'PATCH' });
    assert.equal(unallowed.status, 405);
    assert.equal(unallowed.headers.get('allow'), 'GET, POST, DELETE');
    assert.deepEqual(await unallowed.json(), { error: { code: 'METHOD_NOT_ALLOWED', message: 'Método no permitido.' } });
    assert.deepEqual(await app.request('/api/session', { method: 'POST', headers: { 'content-type': 'text/plain', origin: app.base }, body: '{}' }), {
      status: 415, body: { error: { code: 'CONTENT_TYPE', message: 'Usá Content-Type: application/json.' } }, setCookie: [],
    });
    assert.deepEqual(await app.request('/api/session', { method: 'POST', headers: { 'content-type': 'application/json', origin: app.base }, body: '{' }), {
      status: 400, body: { error: { code: 'INVALID_JSON', message: 'La solicitud debe ser JSON válido.' } }, setCookie: [],
    });
    assert.deepEqual(await app.request('/api/session', { method: 'POST', headers: { 'content-type': 'application/json', origin: app.base }, body: '{}' }), {
      status: 400, body: { error: { code: 'INVALID_LOGIN', message: 'Ingresá un correo y una contraseña.' } }, setCookie: [],
    });
  }
  // Supabase-only v2: there is no other runtime mode, so every endpoint
  // exists everywhere but fails closed without configuration.
  const unconfigured = await listen(t, { env: {} });
  const configError = { status: 503, body: { error: { code: 'SESSION_CONFIG', message: 'Falta configurar la sesión de Supabase.' } }, setCookie: [] };
  assert.deepEqual(await unconfigured.request('/api/session'), configError, 'status fails closed without configuration');
  assert.deepEqual(await unconfigured.request('/api/session', { method: 'DELETE', headers: { origin: unconfigured.base } }), configError, 'logout fails closed without configuration');
});
