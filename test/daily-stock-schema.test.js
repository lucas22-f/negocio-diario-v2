import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { RPC_PARAMS } from './helpers/stock-db.js';

// T1 of odd/tasks/daily-stand-stock.md (S1-S5): structural contract for the
// additive daily-stock migration 0003_daily_stock.sql. These tests verify the
// authored migration text (tables, tags, guards, RLS, grants, locking and the
// no-reset/no-backfill invariants) as the public SQL contract; functional
// proof lives in test/daily-stock-functional.test.js over real PGlite SQL.

const MIGRATION = '0003_daily_stock.sql';
let sql = null;
try {
  sql = readFileSync(new URL('../supabase/migrations/' + MIGRATION, import.meta.url), 'utf8');
} catch {
  sql = null;
}
const norm = () => (sql ?? '').replace(/\s+/g, ' ');

// Extracts the balanced-paren block of a `create table` statement.
function tableBlock(name) {
  const text = norm();
  const start = text.indexOf(`create table if not exists public.${name} (`);
  assert.ok(start >= 0, `migration must create table public.${name}`);
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    if (text[i] === '(') depth += 1;
    else if (text[i] === ')') {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  assert.fail(`unbalanced create table for ${name}`);
}

// Function bodies up to the next `create or replace function` marker, used to
// scope invariants (guards, locking) to the right RPC.
function functionBody(name) {
  const text = norm();
  const start = text.indexOf(`create or replace function public.${name}(`);
  assert.ok(start >= 0, `migration must define public.${name}`);
  let next = text.indexOf('create or replace function', start + 10);
  if (next < 0) next = text.length;
  return text.slice(start, next);
}

const NEW_RPCS = [
  'v2_read_daily_stock', 'v2_load_daily_stock', 'v2_copy_daily_stock',
  'v2_replenish_daily_stock', 'v2_create_daily_sale',
  'v2_edit_daily_sale', 'v2_delete_daily_sale',
];

test('0003 migration exists, is non-empty and stays strictly additive', () => {
  assert.ok(sql !== null, `expected supabase/migrations/${MIGRATION}`);
  assert.ok(sql.trim().length > 0);
  const text = norm();
  assert.doesNotMatch(text, /drop\s+(table|function|index|constraint)\b/i);
  assert.doesNotMatch(text, /insert into auth\.users/i);
  assert.doesNotMatch(text, /delete from public\.v2_daily_stock/i); // no reset/clear feature
  assert.doesNotMatch(text, /alter table public\.v2_products\b/i); // global stock untouched
});

test('v2_daily_stock: per product/date/stand, separate initial load and replenishment', () => {
  const block = tableBlock('v2_daily_stock');
  assert.match(block, /product_id uuid not null references public\.v2_products\(id\)/);
  assert.match(block, /date date not null/);
  assert.match(block, /stand text not null check \(stand in \('fixed', 'mobile'\)\)/);
  // The day's original load is persisted separately from later additions.
  assert.match(block, /initial_load integer not null default 0 check \(initial_load between 0 and 1000000\)/);
  assert.match(block, /replenished integer not null default 0 check \(replenished between 0 and 1000000\)/);
  assert.match(block, /primary key \(product_id, date, stand\)/);
});

test('v2_sales gains the daily tag and a daily sale must always carry a stand', () => {
  const text = norm();
  assert.match(text, /add column if not exists daily_stock boolean not null default false/);
  assert.match(text, /v2_sales_daily_requires_stand check \(not daily_stock or stand is not null\)/);
});

test('partial index supports deriving sold from tagged v2_sales rows', () => {
  assert.match(norm(), /create index if not exists v2_sales_daily_sold_idx on public\.v2_sales \(date, stand, product_id\) where daily_stock/);
});

test('v2_daily_stock: RLS enabled, identity-backed select policy, fail-closed grants', () => {
  const text = norm();
  assert.match(text, /alter table public\.v2_daily_stock enable row level security/);
  assert.match(text, /create policy v2_daily_stock_select on public\.v2_daily_stock for select to authenticated using \(public\.v2_identity_ok\(\)\)/);
  assert.match(text, /revoke all on public\.v2_daily_stock from anon, authenticated/);
  assert.match(text, /grant select on public\.v2_daily_stock to authenticated/);
});

test('new RPCs: additive distinct names, security definer with empty search_path', () => {
  const text = norm();
  for (const name of NEW_RPCS) {
    const defs = text.split(`create or replace function public.${name}(`).length - 1;
    assert.equal(defs, 1, `${name} must be defined exactly once (no PostgREST overload ambiguity)`);
    assert.match(text, new RegExp(`create or replace function public\\.${name}\\([^)]*\\) returns[^$]*security definer set search_path = ''`));
  }
});

test('legacy RPC signatures are unchanged while gaining the daily-sale guard', () => {
  const text = norm();
  assert.match(text, /create or replace function public\.v2_create_sale\(p_sale_id uuid, p_date date, p_product text, p_payment text, p_amount_cents bigint, p_product_id uuid default null, p_quantity integer default 1, p_allow_negative boolean default false\) returns public\.v2_sales/);
  assert.match(text, /create or replace function public\.v2_edit_sale\(p_sale_id uuid, p_prev_date date, p_prev_product text, p_prev_payment text, p_prev_amount_cents bigint, p_prev_product_id uuid, p_prev_quantity integer, p_date date, p_product text, p_payment text, p_amount_cents bigint, p_product_id uuid default null, p_quantity integer default 1, p_allow_negative boolean default false\) returns public\.v2_sales/);
  assert.match(text, /create or replace function public\.v2_delete_sale\(p_sale_id uuid, p_prev_date date, p_prev_product text, p_prev_payment text, p_prev_amount_cents bigint, p_prev_product_id uuid, p_prev_quantity integer\) returns public\.v2_sales/);
  assert.match(text, /create or replace function public\.v2_create_sale_at_stand\(p_sale_id uuid, p_date date, p_product text, p_payment text, p_amount_cents bigint, p_product_id uuid default null, p_quantity integer default 1, p_allow_negative boolean default false, p_stand text default null\) returns public\.v2_sales/);
  for (const name of ['v2_create_sale', 'v2_edit_sale', 'v2_delete_sale', 'v2_create_sale_at_stand']) {
    assert.match(functionBody(name), /VENTA_DIARIA:.*55006/s, `${name} must reject daily-tagged rows`);
  }
});

test('daily mutations lock shared product rows deterministically before deriving balances', () => {
  for (const name of ['v2_load_daily_stock', 'v2_replenish_daily_stock', 'v2_copy_daily_stock', 'v2_edit_daily_sale']) {
    assert.match(functionBody(name), /order by (p\.)?id for update/, `${name} must lock product rows in ascending uuid order`);
  }
  // The create path locks exactly one product row; a single-row lock has no
  // ordering to protect, but it must still be taken before the balance read.
  const create = functionBody('v2_create_daily_sale');
  const lockAt = create.indexOf('for update');
  assert.ok(lockAt >= 0, 'create must lock the product row');
  assert.ok(create.indexOf('v2_daily_available') > lockAt, 'balance must be derived after the lock');
});

test('daily balances are derived after locking, never from global stock', () => {
  const daily = functionBody('v2_create_daily_sale');
  assert.match(daily, /v2_daily_available/);
  assert.doesNotMatch(daily, /v_prod\.stock/); // global stock is not the daily authority
  const read = functionBody('v2_read_daily_stock');
  assert.match(read, /coalesce\(d\.initial_load, 0\) \+ coalesce\(d\.replenished, 0\)/);
  assert.match(read, /sum\(sl\.quantity\)/); // sold derived from tagged sales
  const copy = functionBody('v2_copy_daily_stock');
  assert.match(copy, /d\.initial_load, 0/); // copies the initial load only
  assert.match(copy, /not p\.archived/); // archived products are not reloaded
});

test('copy refuses a populated destination without overwriting', () => {
  const copy = functionBody('v2_copy_daily_stock');
  assert.match(copy, /EL_DIA_YA_TIENE_CARGA/);
  assert.match(copy, /unique_violation/); // PK constraint backstops the race
});

test('load and replenish use per-item CAS against the observed snapshot', () => {
  assert.match(functionBody('v2_load_daily_stock'), /cargó cambió|carga cambió desde otro dispositivo/);
  assert.match(functionBody('v2_replenish_daily_stock'), /carga cambió desde otro dispositivo/);
  assert.match(functionBody('v2_load_daily_stock'), /prevInitial/);
  assert.match(functionBody('v2_replenish_daily_stock'), /prevReplenished/);
});

test('daily sale edit/delete keep full-snapshot CAS and channel-purity both ways', () => {
  const edit = functionBody('v2_edit_daily_sale');
  assert.match(edit, /40001/);
  assert.match(edit, /not cur\.daily_stock/); // refuses legacy rows on the daily channel
  const del = functionBody('v2_delete_daily_sale');
  assert.match(del, /40001/);
  assert.match(del, /not cur\.daily_stock/);
});

test('stock-shortage reuses the exact existing error shape with explicit confirmation', () => {
  for (const name of ['v2_create_daily_sale', 'v2_edit_daily_sale', 'v2_load_daily_stock', 'v2_replenish_daily_stock']) {
    assert.match(functionBody(name), /STOCK_INSUFICIENTE: stock=%, solicitado=%/);
    // p_allow_negative (scalar RPCs) or the parsed allowNegative (jsonb edit).
    assert.match(functionBody(name), /p_allow_negative|v_allow/);
  }
});

test('new RPCs and grants follow the existing fail-closed privilege model', () => {
  const text = norm();
  for (const name of NEW_RPCS) {
    assert.match(text, new RegExp(`revoke execute on function public\\.${name}\\([^)]*\\) from public, anon`));
  }
  assert.match(text, /grant execute on function public\.v2_create_daily_sale\([^)]*\) to authenticated/);
  assert.match(text, /grant execute on function public\.v2_load_daily_stock\([^)]*\) to authenticated/);
  assert.match(text, /grant execute on function public\.v2_copy_daily_stock\([^)]*\) to authenticated/);
  assert.match(text, /grant execute on function public\.v2_read_daily_stock\([^)]*\) to authenticated/);
  assert.match(text, /revoke execute on function public\.v2_daily_available\([^)]*\) from public, anon, authenticated/);
});

test('rest-boundary RPC registry exposes the new contracts for T2', () => {
  assert.deepEqual(RPC_PARAMS.v2_read_daily_stock, ['p_date']);
  assert.deepEqual(RPC_PARAMS.v2_load_daily_stock, ['p_date', 'p_stand', 'p_items', 'p_allow_negative']);
  assert.deepEqual(RPC_PARAMS.v2_replenish_daily_stock, ['p_date', 'p_stand', 'p_items', 'p_allow_negative']);
  assert.deepEqual(RPC_PARAMS.v2_copy_daily_stock, ['p_date', 'p_stand']);
  assert.deepEqual(RPC_PARAMS.v2_create_daily_sale,
    ['p_sale_id', 'p_date', 'p_product', 'p_payment', 'p_amount_cents', 'p_product_id', 'p_quantity', 'p_allow_negative', 'p_stand']);
  assert.deepEqual(RPC_PARAMS.v2_edit_daily_sale, ['p_sale', 'p_previous']);
  assert.deepEqual(RPC_PARAMS.v2_delete_daily_sale, ['p_previous']);
});
