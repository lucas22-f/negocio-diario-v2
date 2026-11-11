import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';

// In-memory PostgreSQL fixture for the v2 stock schema (T2 functional runs).
// It stubs only the tiny slice of Supabase that the migration legitimately
// touches — the auth schema with a synthetic users table, the anon /
// authenticated roles and the two Supabase-managed identity helpers
// auth.uid()/auth.jwt() (copied verbatim from the HOSTED definitions read via
// pg_get_functiondef, so the v2 identity gate is tested against the real
// claim transport) — inside an isolated memory database. No real secrets,
// users or cloud access are involved, and cloud auth.users/auth schema is
// never written or modified: these definitions exist only in this memory DB.

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

export const TEST_UID = '99999999-9999-9999-9999-999999999999';
export const TEST_EMAIL = 'pochoclos@negocio.com';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function createStockDb() {
  const db = new PGlite();
  await db.exec(`
    create schema auth;
    create table auth.users (id uuid primary key, email text, email_confirmed_at timestamptz);
    create role anon nologin;
    create role authenticated nologin;
    -- Hosted Supabase grants client roles usage of the auth schema (the
    -- helpers are publicly executable there); mirror it so tests may call
    -- auth.uid()/auth.jwt() directly as a request role.
    grant usage on schema auth to anon, authenticated;
    -- Exact hosted Supabase definitions (never modified in production):
    -- modern PostgREST delivers the verified JWT as ONE JSON GUC, and these
    -- helpers are the supported read path for it.
    create function auth.jwt() returns jsonb language sql stable as
      $$ select coalesce(nullif(current_setting('request.jwt.claim', true), ''), nullif(current_setting('request.jwt.claims', true), ''))::jsonb $$;
    create function auth.uid() returns uuid language sql stable as
      $$ select coalesce(nullif(current_setting('request.jwt.claim.sub', true), ''), nullif(current_setting('request.jwt.claims', true), '')::jsonb->>'sub')::uuid $$;
  `);
  return db;
}

function migrationPath() {
  const dir = join(root, 'supabase', 'migrations');
  const files = readdirSync(dir).filter(f => /^\d+_.*\.sql$/.test(f)).sort();
  if (!files.length) throw new Error('expected versioned SQL migrations');
  return files.map(file => join(dir, file));
}

export async function applyMigration(db) {
  await db.exec('reset role'); // DDL always runs as the owner, never as a leftover request role
  for (const path of migrationPath()) await db.exec(readFileSync(path, 'utf8'));
}

// Synthetic auth identity for the in-memory fixture only.
export async function seedAuthUser(db, { uid = TEST_UID, email = TEST_EMAIL, confirmed = true } = {}) {
  await db.exec('reset role');
  await db.query(
    'insert into auth.users (id, email, email_confirmed_at) values ($1, $2, $3)',
    [uid, email, confirmed ? new Date() : null],
  );
}

// Switch the single connection to a role exactly as a request would arrive.
// Role names are fixed literals. Modern PostgREST delivers the verified JWT
// as ONE JSON GUC (request.jwt.claims); every identity GUC — the JSON one and
// the legacy individual ones — is cleared FIRST so a fresh call can never
// inherit a leftover claim from the shared connection and hide fresh input.
//   claims: object payload, default { sub: uid, email }.
//   claims: null          -> no claims at all (missing-identity case).
//   claimsText: raw string -> malformed-claim cases (not validated).
export async function become(db, role, { uid = TEST_UID, email = TEST_EMAIL, claims, claimsText } = {}) {
  await db.exec('reset role');
  if (role !== 'postgres') await db.exec(`set role ${role}`);
  await db.exec('reset request.jwt.claims');
  await db.exec('reset request.jwt.claim');
  await db.exec('reset request.jwt.claim.sub');
  await db.exec('reset request.jwt.claim.email');
  if (role !== 'authenticated' || claims === null) return;
  const sub = claims?.sub ?? uid;
  if (!claimsText && !UUID_RE.test(sub)) throw new Error(`test uid is not a uuid: ${sub}`);
  const text = claimsText ?? JSON.stringify(claims ?? { sub, email });
  await db.query('select set_config($1, $2, false)', ['request.jwt.claims', text]);
}

export async function expectSqlError(fn, expectedSqlstate, expectedFragment = null) {
  let error = null;
  try {
    await fn();
  } catch (caught) {
    error = caught;
  }
  assert.ok(error, `expected SQL error ${expectedSqlstate}, but the call succeeded`);
  const code = error.code ?? error.cause?.code ?? null;
  if (code === null || code === undefined) {
    // PGlite surfaces some states only in the message; be strict about the
    // fragment in that case and record the actual message for diagnosis.
    assert.match(
      error.message,
      new RegExp(expectedFragment ? escapeRe(expectedFragment) : escapeRe(expectedSqlstate)),
      `expected fragment for ${expectedSqlstate}, got: ${error.message}`,
    );
    return error;
  }
  assert.equal(code, expectedSqlstate, `expected ${expectedSqlstate}, got ${code}: ${error.message}`);
  if (expectedFragment) assert.match(error.message, new RegExp(escapeRe(expectedFragment)));
  return error;
}

function escapeRe(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// The committed probe is plain SQL plus three psql-only conveniences that the
// loader strips WITHOUT changing SQL behavior:
//   * lines starting with backslash (psql meta commands, e.g. \set),
//   * the probe's own `begin;` / `rollback;` statements (they carry a
//     semicolon; plpgsql `begin` never does, so blocks are untouched) — the
//     PGlite transaction wrapper is the transaction: on success it commits
//     (nothing persists), on any error it rolls back, which is the probe's
//     required rollback-only semantics,
//   * the :'TEST_UID' psql variable, substituted with the literal uuid.
export function loadProbeSql() {
  const raw = readFileSync(join(root, 'test', 'stock-probe.sql'), 'utf8');
  return raw
    .split('\n')
    .filter(line => !/^\s*\\/.test(line))
    .filter(line => !/^begin\s*;\s*$/i.test(line) && !/^rollback\s*;\s*$/i.test(line))
    .join('\n')
    .replace(/:'TEST_UID'/g, `'${TEST_UID}'`);
}

export async function runProbe(db) {
  const sql = loadProbeSql();
  await db.transaction(async tx => {
    await tx.exec(sql);
  });
}

// ---------------------------------------------------------------------------
// Minimal stateful PostgREST boundary for T3 (odd/tasks/stock-v2.md).
// Maps the exact REST surface the v2 API/lib layer may use onto real SQL run
// by PGlite through this fixture: GETs read the v2 tables (RLS enforced through
// the request claims), writes are only the documented RPC endpoints (each RPC
// runs as one transaction inside PostgreSQL), and any direct table write is
// recorded as a contract violation instead of being served. Responses mirror
// PostgREST shapes: GETs return row arrays; RPCs return the composite row as a
// single object (or a one-row array with { rowShape: 'array' }); SQL failures
// come back as { code: SQLSTATE, message } on HTTP 400 exactly like an
// unhandled PostgREST database error.
// ---------------------------------------------------------------------------

export const RPC_PARAMS = {
  v2_create_sale: ['p_sale_id', 'p_date', 'p_product', 'p_payment', 'p_amount_cents', 'p_product_id', 'p_quantity', 'p_allow_negative'],
  v2_edit_sale: ['p_sale_id', 'p_prev_date', 'p_prev_product', 'p_prev_payment', 'p_prev_amount_cents', 'p_prev_product_id', 'p_prev_quantity', 'p_date', 'p_product', 'p_payment', 'p_amount_cents', 'p_product_id', 'p_quantity', 'p_allow_negative'],
  v2_delete_sale: ['p_sale_id', 'p_prev_date', 'p_prev_product', 'p_prev_payment', 'p_prev_amount_cents', 'p_prev_product_id', 'p_prev_quantity'],
  v2_create_product: ['p_name', 'p_price_cents', 'p_stock'],
  v2_edit_product: ['p_product_id', 'p_prev_name', 'p_prev_price_cents', 'p_prev_stock', 'p_name', 'p_price_cents', 'p_stock', 'p_allow_negative'],
  v2_archive_product: ['p_product_id', 'p_prev_stock', 'p_archived'],
};

RPC_PARAMS.v2_create_sale_at_stand = [...RPC_PARAMS.v2_create_sale, 'p_stand'];
RPC_PARAMS.v2_edit_sale_at_stand = ['p_sale', 'p_previous'];
RPC_PARAMS.v2_delete_sale_at_stand = ['p_previous'];
// Daily stock contracts (T1 of odd/tasks/daily-stand-stock.md). Additive:
// existing entries and createRestStockFetch behavior are unchanged.
RPC_PARAMS.v2_read_daily_stock = ['p_date'];
RPC_PARAMS.v2_load_daily_stock = ['p_date', 'p_stand', 'p_items', 'p_allow_negative'];
RPC_PARAMS.v2_replenish_daily_stock = ['p_date', 'p_stand', 'p_items', 'p_allow_negative'];
RPC_PARAMS.v2_copy_daily_stock = ['p_date', 'p_stand'];
RPC_PARAMS.v2_create_daily_sale = [...RPC_PARAMS.v2_create_sale, 'p_stand'];
RPC_PARAMS.v2_edit_daily_sale = ['p_sale', 'p_previous'];
RPC_PARAMS.v2_delete_daily_sale = ['p_previous'];

const SET_RETURNING_RPCS = new Set(['v2_read_daily_stock', 'v2_copy_daily_stock']);

const stripEq = value => (value === null ? null : value.replace(/^eq\./, ''));

export function createRestStockFetch(db, { rowShape } = {}) {
  const rpcRowShape = rowShape === 'array' ? 'array' : 'object';
  const calls = { gets: 0, rpc: 0, violations: 0, v1: 0 };
  const controls = { failAll: false };
  const visits = [];
  const respond = (status, body) => new Response(
    status === 204 ? null : JSON.stringify(body),
    { status, headers: { 'content-type': 'application/json' } },
  );
  const sqlErrorBody = error => ({
    code: error.code ?? error.cause?.code ?? 'P0000',
    message: error.message,
    details: null, hint: null,
  });
  // A hosted PostgREST renders date columns as plain YYYY-MM-DD strings.
  const postgrestRow = row => {
    if (row.date instanceof Date) row.date = row.date.toISOString().slice(0, 10);
    return row;
  };
  const fetchImpl = async (url, init = {}) => {
    if (controls.failAll) throw new TypeError('fetch failed');
    const parsed = new URL(url);
    visits.push(`${parsed.pathname}${parsed.search}`);
    const method = init.method || 'GET';
    if (parsed.pathname === '/rest/v1/sales') {
      calls.v1 += 1;
      throw new Error('unexpected v1 public.sales call');
    }
    if (parsed.pathname.startsWith('/rest/v1/rpc/')) {
      const fn = parsed.pathname.slice('/rest/v1/rpc/'.length);
      const params = RPC_PARAMS[fn];
      if (!params) return respond(404, sqlErrorBody(new Error(`unexpected rpc ${fn}`)));
      calls.rpc += 1;
      const body = init.body === undefined ? {} : JSON.parse(init.body);
      // PostgREST rejects calls whose named parameters are missing; the v2 lib
      // must send every p_* key explicitly (null included) so no SQL default
      // can mask a client bug.
      const missing = params.filter(name => !(name in body));
      if (missing.length) return respond(400, { code: 'PGRST206', message: `missing parameter(s): ${missing.join(', ')}` });
      // Known jsonb parameters are serialized exactly once, HERE at the SQL
      // binding boundary, so the fixture preserves the JSON type the wire
      // carried (hosted PostgREST parity): an object/array binds as its JSON
      // text, while a pre-stringified JSON TEXT argument binds as a jsonb
      // STRING scalar — which the SQL then rejects as the wrong type instead
      // of silently decoding it back into an array/object.
      const JSONB_PARAMS = new Set(['p_items', 'p_sale', 'p_previous']);
      const values = params.map(name => JSONB_PARAMS.has(name) ? JSON.stringify(body[name]) : body[name]);
      const placeholders = params.map((_, i) => `$${i + 1}`).join(',');
      try {
        await become(db, 'authenticated');
        const { rows } = await db.query(`select * from public."${fn}"(${placeholders})`, values);
        // Set-returning daily RPCs (the T1 read/copy contracts) answer with a
        // row ARRAY like a hosted PostgREST setof, empty sets included.
        if (SET_RETURNING_RPCS.has(fn)) return respond(200, rows.map(postgrestRow));
        if (!rows.length) throw new Error(`rpc ${fn} returned no row`);
        const row = postgrestRow(rows[0]);
        // A scalar-returning RPC (the daily load/replenish counters) comes
        // back from PGlite as { "fn": value }; a hosted PostgREST answers
        // with the bare value, so mirror that exact shape.
        const keys = Object.keys(row);
        const scalar = keys.length === 1 && keys[0] === fn && (typeof row[keys[0]] !== 'object' || row[keys[0]] === null)
          ? row[keys[0]] : null;
        if (scalar !== null) return respond(200, scalar);
        return respond(200, rpcRowShape === 'array' ? [row] : row);
      } catch (error) {
        return respond(400, sqlErrorBody(error));
      }
    }
    const table = parsed.pathname === '/rest/v1/v2_sales' ? 'v2_sales'
      : parsed.pathname === '/rest/v1/v2_products' ? 'v2_products' : null;
    if (table) {
      if (method !== 'GET') {
        calls.violations += 1;
        return respond(405, { message: 'direct table writes are outside the v2 contract: all writes go through RPC' });
      }
      calls.gets += 1;
      const params = [];
      const where = [];
      const addEq = (raw, sql, cast = '') => {
        const value = stripEq(raw);
        if (value !== null) {
          params.push(value);
          where.push(`${sql} = $${params.length}${cast}`);
        }
      };
      if (table === 'v2_sales') {
        addEq(parsed.searchParams.get('date'), 'date', '::date');
        addEq(parsed.searchParams.get('id'), 'id::text');
      }
      const columns = table === 'v2_sales'
        // daily_stock is the additive T1 channel tag, read by the T2 sales
        // layer so routing uses the trusted stored row.
        ? 'id, date::text as date, product, payment, amount_cents, row_seq, product_id, quantity, stand, daily_stock'
        : 'id, name, price_cents, stock, archived';
      try {
        await become(db, 'authenticated');
        const { rows } = await db.query(
          `select ${columns} from public."${table}"${where.length ? ` where ${where.join(' and ')}` : ''}`
          + ` order by ${table === 'v2_sales' ? 'row_seq asc' : 'name asc'}`,
          params,
        );
        return respond(200, rows);
      } catch (error) {
        return respond(400, sqlErrorBody(error));
      }
    }
    return respond(404, sqlErrorBody(new Error(`unexpected path ${parsed.pathname}`)));
  };
  return { fetchImpl, calls, controls, visits };
}
