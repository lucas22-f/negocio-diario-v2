import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import { SalesError } from './sales.js';

// v2 T1 of odd/tasks/stock-v2.md (S2/S4-S6): a simple login for exactly one
// business identity, fixed in code to the pochoclos-1 account. The browser
// only ever holds an encrypted, HttpOnly, SameSite=Lax, Secure container with
// the Supabase tokens: it can never read or forge them, and neither the
// plaintext password nor any token is stored, logged or trusted. Every
// acceptance decision verifies the access token against Supabase Auth
// /auth/v1/user, so expired, revoked or foreign sessions fail closed before
// any data access. The v2 cookie name is distinct so cookies of other
// deployments are never read here.

export const SESSION_COOKIE = 'v2_session';
// The identity is part of the app, never a configuration value: a deployment
// cannot be pointed at another business's account by changing an env var.
const ALLOWED_EMAIL = 'pochoclos@negocio.com';
// T1 (odd/tasks/session-expiry-fix.md): the accepted one-hour inactivity
// limit. The browser-side Max-Age is only a mirror; the deadline itself is
// the encrypted last-authenticated-request timestamp checked server-side.
const idleLimitMs = 60 * 60 * 1000;
const containerVersion = 1;
const cookieLifetimeSeconds = 60 * 60; // renewed after every verified auth

export function sessionConfig(environment) {
  const value = name => (typeof environment[name] === 'string' ? environment[name].trim() : '');
  const url = value('SUPABASE_URL');
  const anonKey = value('SUPABASE_ANON_KEY');
  // The v2 user id is always explicit: there is no default identity to fall
  // back on, so an unconfigured app fails closed everywhere.
  const userId = value('SUPABASE_ALLOWED_USER_ID');
  const sessionKey = typeof environment.SUPABASE_SESSION_KEY === 'string' ? environment.SUPABASE_SESSION_KEY : '';
  const appOriginRaw = typeof environment.SUPABASE_APP_ORIGIN === 'string' ? environment.SUPABASE_APP_ORIGIN.trim() : '';
  let parsedUrl = null;
  let appOrigin = null;
  try {
    parsedUrl = url ? new URL(url) : null;
    appOrigin = appOriginRaw ? new URL(appOriginRaw) : null; // canonical app origin behind a proxy
  } catch { parsedUrl = null; appOrigin = null; }
  if (!parsedUrl || !['http:', 'https:'].includes(parsedUrl.protocol) || !anonKey
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(userId)
      || sessionKey.length < 32
      || (appOriginRaw && (!appOrigin || !['http:', 'https:'].includes(appOrigin.protocol)))) {
    throw new SalesError(503, 'SESSION_CONFIG', 'Falta configurar la sesión de Supabase.');
  }
  return {
    url: url.replace(/\/+$/, ''),
    anonKey,
    userId: userId.toLowerCase(),
    email: ALLOWED_EMAIL,
    key: sessionKey,
    appOrigin: (appOriginRaw && appOrigin) || null,
  };
}

// Encrypting is per-cookie, so derive the wrapping key once per session key.
const derivedKeys = new Map();
function containerKey(sessionKey) {
  let key = derivedKeys.get(sessionKey);
  if (!key) {
    key = scryptSync(sessionKey, 'negocio-diario-v2:sesion:v2', 32);
    derivedKeys.set(sessionKey, key);
  }
  return key;
}

export function encodeContainer(tokens, sessionKey) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', containerKey(sessionKey), iv);
  const payload = Buffer.concat([cipher.update(JSON.stringify({ v: containerVersion, ...tokens }), 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), payload].map(part => part.toString('base64url')).join('.');
}

export function decodeContainer(value, sessionKey) {
  const parts = String(value).split('.');
  if (parts.length !== 3) return null;
  const [iv, tag, payload] = parts.map(part => Buffer.from(part, 'base64url'));
  if (iv.length !== 12 || tag.length !== 16 || payload.length === 0) return null;
  try {
    const decipher = createDecipheriv('aes-256-gcm', containerKey(sessionKey), iv);
    decipher.setAuthTag(tag);
    const container = JSON.parse(Buffer.concat([decipher.update(payload), decipher.final()]).toString('utf8'));
    if (container?.v !== containerVersion
        || typeof container.access !== 'string' || !container.access
        || typeof container.refresh !== 'string' || !container.refresh) {
      return null;
    }
    const tokens = { access: container.access, refresh: container.refresh };
    if (container.last !== undefined) tokens.last = container.last; // validated by the session manager before any Auth use
    return tokens;
  } catch {
    return null;
  }
}

function cookieHeader(value, maxAge) {
  return `${SESSION_COOKIE}=${value}; Path=/; Max-Age=${maxAge}; HttpOnly; SameSite=Lax; Secure`;
}

export function setSessionCookie(tokens, res, sessionKey) {
  res.appendHeader('Set-Cookie', cookieHeader(encodeContainer(tokens, sessionKey), cookieLifetimeSeconds));
}

export function clearSessionCookie(res) {
  res.appendHeader('Set-Cookie', cookieHeader('', 0));
}

// Cross-site posts and deletes never reach mutating endpoints: competent
// browsers attach an accurate Origin to them, so a missing, untrustworthy or
// foreign one is rejected before the request body is even read. GET stays safe.
// Supplied forwarding headers are NEVER trusted to grant anything: the allow
// list is the browser's Origin matched against the configured canonical app
// origin (SUPABASE_APP_ORIGIN, e.g. on a proxying platform like Vercel), or in
// deliberate direct mode the request Host itself.
export function assertSameOrigin(req, env = process.env) {
  const forwardedHost = typeof req.headers['x-forwarded-host'] === 'string'
    ? req.headers['x-forwarded-host'].split(',')[0].trim() : undefined;
  let canonical = null;
  const raw = typeof env.SUPABASE_APP_ORIGIN === 'string' ? env.SUPABASE_APP_ORIGIN.trim() : '';
  if (raw) {
    try { canonical = new URL(raw); } catch { canonical = null; }
    if (!canonical || !['http:', 'https:'].includes(canonical.protocol)) {
      throw new SalesError(503, 'SESSION_CONFIG', 'Falta configurar la sesión de Supabase.');
    }
  }
  const host = req.headers.host || '';
  let origin = null;
  try { origin = req.headers.origin ? new URL(req.headers.origin) : null; } catch { origin = null; }
  const trustworthy = origin && (origin.protocol === 'https:'
    || ['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname));
  if (!trustworthy) throw new SalesError(403, 'FORBIDDEN_ORIGIN', 'Origen no autorizado.');
  // The Origin value is the only thing that grants access; forwarded headers
  // may only CONFIRM the matching host, never widen the allow list.
  const originOk = canonical
    ? (origin.protocol === canonical.protocol && origin.host === canonical.host)
    : !!host && origin.host === host;
  const forwardedOk = forwardedHost === undefined
    || forwardedHost === (canonical ? canonical.host : host);
  if (!originOk || !forwardedOk) {
    throw new SalesError(403, 'FORBIDDEN_ORIGIN', 'Origen no autorizado.');
  }
}

function requestCookie(req) {
  const header = req.headers.cookie;
  if (typeof header !== 'string') return null;
  for (const pair of header.split(';')) {
    const [name, ...rest] = pair.split('=');
    if (name.trim() === SESSION_COOKIE && rest.length > 0) {
      return rest.join('=').trim() || null;
    }
  }
  return null;
}

const unavailableError = () => new SalesError(503, 'SESSION_UNAVAILABLE',
  'No se pudo contactar Supabase. Reintentá en unos momentos.');

export function createSessionManager({ env = process.env, supabaseFetch = globalThis.fetch } = {}) {
  const config = () => sessionConfig(env);
  const credentialsError = () => new SalesError(401, 'INVALID_CREDENTIALS', 'Correo o contraseña incorrectos.');
  const invalidError = () => new SalesError(401, 'SESSION_INVALID',
    'La sesión no es válida o venció. Iniciá sesión nuevamente.');

  async function call(path, init = {}) {
    const configs = config();
    let response;
    try {
      response = await supabaseFetch(`${configs.url}${path}`, {
        ...init,
        headers: { apikey: configs.anonKey, ...(init.headers || {}) },
      });
    } catch {
      throw unavailableError();
    }
    let body = null;
    try { body = await response.json(); } catch { body = null; }
    return { status: response.status, body };
  }

  const bearerHeaders = access => ({ authorization: `Bearer ${access}` });
  const unavailableOrBad = status => (status === 401 ? invalidError() : unavailableError());

  // The provider reports an expired/unusable JWT itself: 401 always, or a 403
  // carrying exactly the `bad_jwt` identifier (body.error_code or body.code in
  // either field spelling GoTrue uses; a plain 403 or HTML service error is
  // never a token verdict). Only those enter the existing single refresh path.
  const rejectedJwt = (status, body) => status === 400 || status === 401
    || (status === 403 && !!body && (body.error_code === 'bad_jwt' || body.code === 'bad_jwt'));

  // Only the identity Supabase itself answers with is accepted (S4/S6).
  async function verifyIdentity(access) {
    const { status, body } = await call('/auth/v1/user', { headers: bearerHeaders(access) });
    if (status !== 200) {
      if (rejectedJwt(status, body)) throw invalidError();
      throw unavailableError(); // 429/5xx/network-adjacent answers stay honest
    }
    const configs = config();
    if (!body || body.id !== configs.userId || typeof body.email !== 'string'
        || body.email.toLowerCase() !== configs.email) {
      throw invalidError();
    }
    return body;
  }

  // Resolves the request session: verifies the token, refreshes exactly once
  // with the server-held refresh token when Supabase reports it unusable, and
  // reissues the rotated cookie. Revoked/foreign sessions reject with 401,
  // and the data path runs only with the same verified token.
  async function verify(req, res) {
    const configs = config();
    const value = requestCookie(req);
    if (!value) throw new SalesError(401, 'UNAUTHENTICATED', 'Iniciá sesión para continuar.');
    const tokens = decodeContainer(value, configs.key);
    if (!tokens) throw new SalesError(401, 'UNAUTHENTICATED', 'Iniciá sesión para continuar.');
    // One-hour server-enforced idle deadline, checked before any Auth call and
    // any data access. The timestamp is signed inside the server-issued
    // container; a missing one (pre-deploy cookies) or a future one can never
    // bootstrap or prolong a deadline — they fail closed to a fresh login.
    const last = tokens.last;
    if (typeof last !== 'number' || !Number.isInteger(last) || last < 0
        || last > Date.now() || Date.now() - last >= idleLimitMs) {
      throw invalidError();
    }
    try {
      await verifyIdentity(tokens.access);
    } catch (error) {
      if (!(error instanceof SalesError && error.code === 'SESSION_INVALID')) throw error;
      // Expired or revoked access token: try the held refresh token once.
      const grant = await call('/auth/v1/token?grant_type=refresh_token', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ refresh_token: tokens.refresh }),
      });
      if (grant.status !== 200) {
        if (rejectedJwt(grant.status, grant.body)) throw invalidError(); // revoked/invalid refresh token
        throw unavailableError(); // 429/5xx/network-adjacent answers stay honest
      }
      const refreshed = { access: grant.body?.access_token, refresh: grant.body?.refresh_token };
      if (!refreshed.access || !refreshed.refresh) throw invalidError();
      await verifyIdentity(refreshed.access);
      refreshed.last = Date.now();
      setSessionCookie(refreshed, res, configs.key);
      return refreshed;
    }
    // Successful verified auth reissues the deadline deliberately: activity
    // slides the one-hour idle window (and the mirrored cookie lifetime).
    const renewed = { access: tokens.access, refresh: tokens.refresh, last: Date.now() };
    setSessionCookie(renewed, res, configs.key);
    return renewed;
  }

  async function authenticate(req, res) {
    try {
      return await verify(req, res);
    } catch (error) {
      if (error instanceof SalesError && error.code === 'SESSION_INVALID') clearSessionCookie(res);
      throw error;
    }
  }

  async function status(req, res) {
    try {
      await verify(req, res);
      return { status: 'authenticated' };
    } catch (error) {
      if (error instanceof SalesError
          && (error.code === 'UNAUTHENTICATED' || error.code === 'SESSION_INVALID')) {
        return { status: 'anonymous' }; // status only reports; it never mutates cookies
      }
      throw error;
    }
  }

  async function login(email, password, res) {
    const configs = config();
    const grant = await call('/auth/v1/token?grant_type=password', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    if ([400, 401, 403].includes(grant.status)) throw credentialsError();
    if (grant.status !== 200) throw unavailableOrBad(grant.status);
    const tokens = { access: grant.body?.access_token, refresh: grant.body?.refresh_token };
    if (!tokens.access || !tokens.refresh) throw unavailableError();
    try {
      await verifyIdentity(tokens.access);
    } catch (error) {
      // A foreign account is rejected exactly like wrong credentials, so the
      // response reveals nothing about which part failed. Anything else
      // (service down, inconsistent grant) keeps its honest status.
      if (error instanceof SalesError && error.code === 'SESSION_INVALID') throw credentialsError();
      throw error;
    }
    tokens.last = Date.now();
    setSessionCookie(tokens, res, configs.key);
    return { status: 'authenticated' };
  }

  async function logout(req, res) {
    const configs = config();
    const value = requestCookie(req);
    const tokens = value ? decodeContainer(value, configs.key) : null;
    if (value && tokens) {
      // Best-effort revoke, but only on a confirmed answer do we drop the
      // cookie: a down Supabase keeps the session and reports 503 honestly.
      // GoTrue only accepts POST; a GET would fake a revoke that never runs.
      const response = await call('/auth/v1/logout', {
        method: 'POST',
        headers: bearerHeaders(tokens.access),
        body: '',
      });
      if (![200, 204, 401].includes(response.status)) throw unavailableOrBad(response.status);
    }
    if (value) clearSessionCookie(res); // also drops unreadable containers
    return { status: 'anonymous' };
  }

  return { authenticate, status, login, logout };
}
