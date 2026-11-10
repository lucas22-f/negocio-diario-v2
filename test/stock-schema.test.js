import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// v2 T2 of odd/tasks/stock-v2.md (S1,S3-S5): structural contract for the
// isolated v2 stock schema. These tests verify the authored migration file
// (tables, RLS, RPC guards, grants, locking and CAS invariants) as the public
// SQL contract. They can never execute SQL: functional proof is the separate
// rollback-only probe (test/stock-probe.sql) run by the parent/verifier, and
// unexecuted SQL is reported as unverified, never as passing here.

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const MIGRATION_DIR = join(root, 'supabase', 'migrations');

function loadMigration() {
  let files = [];
  try {
    files = readdirSync(MIGRATION_DIR).filter(f => f.endsWith('_v2_stock.sql'));
  } catch {
    return null;
  }
  if (files.length !== 1) return null;
  return readFileSync(join(MIGRATION_DIR, files[0]), 'utf8');
}

let cached = loadMigration();
const norm = () => cached.replace(/\s+/g, ' ');

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

const RPCS = [
  'v2_create_sale', 'v2_edit_sale', 'v2_delete_sale',
  'v2_create_product', 'v2_edit_product', 'v2_archive_product',
];

test('exactly one v2 stock migration exists and is non-empty', () => {
  const files = readdirSync(MIGRATION_DIR).filter(f => f.endsWith('_v2_stock.sql'));
  assert.equal(files.length, 1, `expected one *_v2_stock.sql, found: ${files.join(', ')}`);
  assert.ok(cached.trim().length > 0);
});

// --- v2_products ------------------------------------------------------------

test('v2_products: id, name, nullable price_cents, stock, archived boolean', () => {
  const block = tableBlock('v2_products');
  assert.match(block, /id uuid primary key default gen_random_uuid\(\)/);
  assert.match(block, /name text not null/);
  // price_cents is optional: column present but never NOT NULL.
  assert.match(block, /price_cents bigint/);
  assert.doesNotMatch(block, /price_cents bigint not null/);
  assert.match(block, /stock integer not null default 0/);
  assert.match(block, /archived boolean not null default false/);
});

test('v2_products: integer ranges and name length are protected by checks', () => {
  const block = tableBlock('v2_products');
  assert.match(block, /stock between -1000000000 and 1000000000/);
  assert.match(block, /price_cents is null or price_cents between 1 and 99999999999/);
  assert.match(block, /char_length\(btrim\(name\)\) between 1 and 160/);
});

test('v2_products: active names are unique (partial unique index, archived exempt)', () => {
  const text = norm();
  assert.match(text, /create unique index.*on public\.v2_products.*lower\(btrim\(name\)\).*where not archived/i);
});

// --- v2_sales ---------------------------------------------------------------

test('v2_sales: keeps id,date,product,payment,amount_cents,row_seq and adds product_id,quantity', () => {
  const block = tableBlock('v2_sales');
  assert.match(block, /id uuid primary key/);
  assert.match(block, /date date not null/);
  assert.match(block, /product text not null/);
  assert.match(block, /payment text not null/);
  assert.match(block, /amount_cents bigint not null/);
  assert.match(block, /row_seq bigint generated always as identity/);
  // Nullable product link (free-text sales have no product) and quantity default 1.
  assert.match(block, /product_id uuid references public\.v2_products\(id\)/);
  assert.doesNotMatch(block, /product_id uuid[^,]*not null/);
  assert.match(block, /quantity integer not null default 1/);
});

test('v2_sales: payment, amount, quantity and free-text checks', () => {
  const block = tableBlock('v2_sales');
  assert.match(block, /payment in \('efectivo', 'transferencia'\)/);
  assert.match(block, /amount_cents between 1 and 99999999999/);
  assert.match(block, /quantity between 1 and 1000000/);
  assert.match(block, /product_id is null and quantity = 1/);
});

test('v2_sales: listing index on (date, row_seq) for the existing ordered read', () => {
  assert.match(norm(), /create index.*on public\.v2_sales \(date, row_seq\)/i);
});

// --- v2_stock_movements ------------------------------------------------------

test('v2_stock_movements: append-only audit with product, signed delta and reason', () => {
  const block = tableBlock('v2_stock_movements');
  assert.match(block, /id bigint generated always as identity primary key/);
  assert.match(block, /sale_id uuid/); // no FK: audit must survive sale deletion
  assert.match(block, /product_id uuid not null references public\.v2_products\(id\)/);
  assert.match(block, /delta bigint not null check \(delta <> 0 and delta between -2000000000 and 2000000000\)/);
  assert.match(block, /reason text not null check \(reason in \('sale_create', 'sale_edit', 'sale_delete', 'adjust'\)\)/);
  assert.match(block, /created_at timestamptz not null default now\(\)/);
});

test('v2_stock_movements: one sale_create movement per sale id (idempotency guard)', () => {
  assert.match(norm(), /create unique index.*on public\.v2_stock_movements \(sale_id\).*where reason = 'sale_create'/i);
});

// --- v2_business_account registry ---------------------------------------------

test('v2_business_account: singleton registry bound to the exact approved email', () => {
  const block = tableBlock('v2_business_account');
  assert.match(block, /owner uuid primary key references auth\.users\(id\)/);
  assert.match(block, /email text not null check \(email = 'pochoclos@negocio\.com'\)/);
  assert.match(block, /constraint v2_business_account_singleton unique \(is_registry\)/);
});

test('registry seed: SELECT from auth.users only for a matching CONFIRMED identity, fail closed', () => {
  const text = norm();
  const seed = text.match(/insert into public\.v2_business_account[\s\S]*?;/);
  assert.ok(seed, 'migration must seed the registry from auth.users');
  assert.match(seed[0], /from auth\.users/);
  assert.match(seed[0], /email_confirmed_at is not null/);
  assert.match(seed[0], /lower\(u\.email\) = 'pochoclos@negocio\.com'/);
  assert.match(seed[0], /not exists \(select 1 from public\.v2_business_account\)/);
  assert.doesNotMatch(seed[0], /insert into auth\.users/);
});

// --- RLS and direct-DML denial -------------------------------------------------

test('row level security enabled on every v2 table', () => {
  const text = norm();
  for (const name of ['v2_products', 'v2_sales', 'v2_stock_movements', 'v2_business_account']) {
    assert.match(text, new RegExp(`alter table public\\.${name} enable row level security`));
  }
});

test('SELECT policies enforce uid+email through the registry; no direct write policies', () => {
  const text = norm();
  for (const name of ['v2_products', 'v2_sales', 'v2_stock_movements']) {
    assert.match(text, new RegExp(
      `create policy ${name}_select on public\\.${name} for select to authenticated using \\(public\\.v2_identity_ok\\(\\)\\)`));
  }
  assert.doesNotMatch(text, /for insert to|for update to|for delete to/);
  // Direct DML must not bypass atomicity: writes only through RPCs.
  for (const name of ['v2_products', 'v2_sales', 'v2_stock_movements', 'v2_business_account']) {
    assert.match(text, new RegExp(`revoke all on public\\.${name} from anon, authenticated`));
  }
  assert.match(text, /grant select on public\.v2_products, public\.v2_sales, public\.v2_stock_movements to authenticated/);
  assert.doesNotMatch(text, /grant (insert|update|delete|all)[^;]*v2_(sales|products|stock_movements|business_account)[^;]*to authenticated/);
});

// --- Helper functions -----------------------------------------------------------

function functionBody(fn) {
  const text = norm();
  const start = text.indexOf(`function public.${fn}(`);
  assert.ok(start >= 0, `${fn} must exist`);
  const end = text.indexOf('$$ ;', start);
  assert.ok(end > start, `${fn} must end with $$ ;`);
  return text.slice(start, end + 4);
}

test('v2_identity_ok: security definer, locked search_path, identity from auth.uid/auth.jwt', () => {
  const body = functionBody('v2_identity_ok');
  assert.match(body, /security definer/);
  assert.match(body, /set search_path = ''/);
  // Identity is read exclusively through the Supabase-managed helpers (the
  // supported path for the modern request.jwt.claims JSON transport), never
  // by parsing transport-specific GUCs itself.
  assert.match(body, /auth\.uid\(\)/);
  assert.match(body, /auth\.jwt\(\)/);
  assert.doesNotMatch(body, /request\.jwt\.claim/);
  assert.match(body, /public\.v2_business_account/);
});

test('v2_assert_identity: security definer and fails closed with 28000 when unbound', () => {
  const body = functionBody('v2_assert_identity');
  assert.match(body, /security definer/);
  assert.match(body, /set search_path = ''/);
  assert.match(body, /auth\.uid\(\)/);
  assert.match(body, /auth\.jwt\(\)/);
  assert.doesNotMatch(body, /request\.jwt\.claim/);
  // Malformed claims (invalid JSON or non-uuid sub) deny narrowly via 28000;
  // only invalid_text_representation is caught, never a blanket handler.
  assert.match(body, /invalid_text_representation/);
  assert.doesNotMatch(body, /when others/);
  assert.match(body, /errcode = '28000'/);
});

test('helper functions are never callable by clients', () => {
  const text = norm();
  assert.match(text, /revoke execute on function public\.v2_identity_ok\(\) from public, anon, authenticated/);
  assert.match(text, /revoke execute on function public\.v2_assert_identity\(\) from public, anon, authenticated/);
});

// --- Transactional RPCs ----------------------------------------------------------

test('every RPC is security definer with locked search_path, revokes PUBLIC, granted to authenticated', () => {
  const text = norm();
  for (const fn of RPCS) {
    const re = new RegExp(`create or replace function public\\.${fn}\\([^)]*\\) returns [^ ]+`);
    const m = text.match(re);
    assert.ok(m, `RPC ${fn} must exist with its signature`);
    const body = functionBody(fn);
    assert.match(body, /security definer/, `${fn} must be security definer`);
    assert.match(body, /set search_path = ''/, `${fn} must lock search_path`);
    assert.match(text, new RegExp(`revoke execute on function public\\.${fn}\\([^)]*\\) from public, anon`), `${fn} revoked from PUBLIC`);
    assert.match(text, new RegExp(`grant execute on function public\\.${fn}\\([^)]*\\) to authenticated`), `${fn} granted to authenticated`);
  }
});

test('sale RPCs: explicit identity check inside every transactional operation', () => {
  const text = norm();
  for (const fn of ['v2_create_sale', 'v2_edit_sale', 'v2_delete_sale', 'v2_create_product', 'v2_edit_product', 'v2_archive_product']) {
    const start = text.indexOf(`function public.${fn}(`);
    assert.ok(start >= 0, `${fn} exists`);
    const body = text.slice(start, text.indexOf('$$ ;', start) + 4);
    assert.match(body, /perform public\.v2_assert_identity\(\)/, `${fn} must assert identity`);
  }
});

test('create sale: idempotent replay, allowNegative acknowledgement, archived rejection', () => {
  const text = norm();
  const body = text.slice(text.indexOf('function public.v2_create_sale('), text.indexOf('$$ ;', text.indexOf('function public.v2_create_sale(')));
  assert.match(body, /p_allow_negative boolean default false/);
  assert.match(body, /p_quantity integer default 1/);
  assert.match(body, /coalesce\(p_allow_negative, false\)/);
  assert.match(body, /PRODUCTO_INACTIVO/);
  assert.match(body, /STOCK_INSUFICIENTE/);
  assert.match(body, /errcode = '23505'/); // content conflict on replay
  // Replay of the exact same content returns the stored row without new movements.
  assert.match(body, /return existing/);
});

test('edit/delete sale: CAS on the previous snapshot and explicit reversals', () => {
  const text = norm();
  for (const fn of ['v2_edit_sale', 'v2_delete_sale']) {
    const body = text.slice(text.indexOf(`function public.${fn}(`), text.indexOf('$$ ;', text.indexOf(`function public.${fn}(`)));
    assert.match(body, /p_prev_date date/, `${fn} takes previous date`);
    assert.match(body, /p_prev_product text/, `${fn} takes previous product`);
    assert.match(body, /p_prev_payment text/, `${fn} takes previous payment`);
    assert.match(body, /p_prev_amount_cents bigint/, `${fn} takes previous amount`);
    assert.match(body, /p_prev_product_id uuid/, `${fn} takes previous product link`);
    assert.match(body, /p_prev_quantity integer/, `${fn} takes previous quantity`);
    assert.match(body, /errcode = '40001'/, `${fn} raises CAS conflict`);
  }
  const edit = text.slice(text.indexOf('function public.v2_edit_sale('), text.indexOf('$$ ;', text.indexOf('function public.v2_edit_sale(')));
  assert.match(edit, /p_allow_negative boolean default false/);
  assert.match(edit, /sale_edit/);
  const del = text.slice(text.indexOf('function public.v2_delete_sale('), text.indexOf('$$ ;', text.indexOf('function public.v2_delete_sale(')));
  assert.match(del, /sale_delete/);
});

test('product switches lock products in deterministic ascending uuid order', () => {
  const text = norm();
  assert.match(text, /order by id for update/);
});

test('product edits use the optimistic previous snapshot; stock changes are audited', () => {
  const text = norm();
  const body = text.slice(text.indexOf('function public.v2_edit_product('), text.indexOf('$$ ;', text.indexOf('function public.v2_edit_product(')));
  assert.match(body, /p_prev_name text/);
  assert.match(body, /p_prev_price_cents bigint/);
  assert.match(body, /p_prev_stock integer/);
  assert.match(body, /p_allow_negative boolean default false/);
  assert.match(body, /'adjust'/);
});

test('archive preserves sale history: no sale mutation on archive, sale rows keep snapshots', () => {
  const text = norm();
  const body = text.slice(text.indexOf('function public.v2_archive_product('), text.indexOf('$$ ;', text.indexOf('function public.v2_archive_product(')));
  assert.match(body, /set archived = p_archived/);
  assert.doesNotMatch(body, /v2_sales/); // archiving never rewrites sales
});

// --- v1 isolation ----------------------------------------------------------------

test('migration never references or alters the v1 public.sales table', () => {
  const text = norm();
  assert.doesNotMatch(text, /\bpublic\.sales\b/);
  assert.doesNotMatch(text, /\balter table[^;]*\bsales\b(?!_)/i);
  assert.doesNotMatch(text, /drop table/i);
});
