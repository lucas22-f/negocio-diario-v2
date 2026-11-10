# v2 Supabase schema (pochoclos-1)

Isolated v2-only schema. It never touches, reads or references v1 tables: the
SAME Supabase project legitimately also serves the v1 generation (its
`public.sales` table stays there, owned by the other business), and nothing in
this directory creates, reads, writes or grants on it. Everything lives in
this directory's migration and is applied once to the existing Supabase
project by the parent (task T6). No deployment and no v1 mutation are in
scope.

## Applying the schema (T6, authorized run only)

```sh
psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -f supabase/migrations/0001_v2_stock.sql
```

The migration is idempotent (`if not exists` everywhere) and takes no
arguments. After applying, verify the functional probe below.

## Tables

| Table | Purpose |
| --- | --- |
| `v2_products` | Stock catalogue. `id`, `name` (1–160 chars, unique while active), `price_cents` **nullable** (optional price), `stock` integer default 0 (bounded ±1 000 000 000), `archived` boolean default false (chosen over `archived_at`; restore is a plain flag flip). |
| `v2_sales` | Existing public shape kept: `id`, `date`, `product`, `payment`, `amount_cents`, `row_seq` (generated identity, ordering). Added: `product_id` **nullable** link (free-text sales have none) and `quantity` integer default 1. `product` and `amount_cents` remain verbatim snapshots of the sale moment; edits never rewrite history, they change the row and audit the delta. |
| `v2_stock_movements` | Append-only audit. Signed `delta` (never 0), `reason` in `sale_create` / `sale_edit` / `sale_delete` / `adjust`. No FK on `sale_id` so the audit survives sale deletion. Partial unique index `(sale_id) where reason = 'sale_create'` makes a duplicate initial decrement impossible. |
| `v2_business_account` | Private singleton registry binding the owner uuid to the exact email `pochoclos@negocio.com`. A `unique (is_registry)` constraint guarantees at most one row. |

## Security model

- **Fail closed identity.** The migration seeds the registry with
  `insert … select from auth.users` **only** when a *confirmed* identity with
  the exact approved email already exists. Today no such account exists, so
  the migration inserts **zero rows** and every RPC and SELECT stays denied
  until the owner binds a real account (below). No UID is fabricated and no
  row is ever inserted into `auth.users` via SQL.
- **RLS reads.** All four tables enable RLS. `v2_products`, `v2_sales` and
  `v2_stock_movements` have a single `for select to authenticated` policy
  backed by `v2_identity_ok()`, which requires the JWT `sub` **and** `email`
  claims to match the bound registry row — never the email alone. The
  registry table itself has no policy: invisible to clients.
- **Modern JWT transport.** Identity is read exclusively through the
  Supabase-managed helpers `auth.uid()` and `auth.jwt()` (verified against
  the hosted `pg_get_functiondef` definitions): `auth.jwt()` decodes the
  single `request.jwt.claims` JSON GUC that modern PostgREST delivers, and
  `auth.uid()` resolves the sub from it (falling back to the legacy
  individual sub GUC). The v2 helpers never parse transport-specific GUCs
  themselves. Malformed claims (unparseable JSON or a non-uuid `sub`) fail
  closed with `28000` on writes and zero rows on reads; only
  `invalid_text_representation` is caught — any other database error
  propagates and is never silently turned into an anonymous session. Note
  that a request carrying ONLY the legacy individual GUCs
  (`request.jwt.claim.sub/email`) no longer authenticates: `auth.jwt()`
  cannot see the legacy email GUC.
- **Writes only through RPCs.** Direct INSERT/UPDATE/DELETE is revoked from
  `anon` and `authenticated` on every table; clients get `SELECT` only. All
  mutations happen inside transactional `security definer` functions with
  `set search_path = ''` that re-assert the identity (`v2_assert_identity`,
  SQLSTATE `28000` on failure), lock rows explicitly and append movements.
- **Function hygiene.** Every RPC revokes `execute` from `public` and `anon`
  and grants it to `authenticated`. Helpers are revoked from everyone and are
  only callable inside definer functions. No secrets are stored or logged.

### Binding the real account (parent, T6, private step)

After creating the Supabase Auth user privately (dashboard or admin invite —
never SQL into `auth.users`), bind it while the registry is empty:

```sql
insert into public.v2_business_account (owner, email)
select id, lower(email) from auth.users
where lower(email) = 'pochoclos@negocio.com'
  and email_confirmed_at is not null
  and not exists (select 1 from public.v2_business_account);
```

Zero rows matched ⇒ nothing bound ⇒ access stays closed. If the registry is
already bound, a re-bind is a deliberate manual `delete` + re-insert by the
owner and is out of scope here.

## RPC contract (consumed by T3)

All RPCs run as one transaction, return the ordinary table row
(snake_case: `id, date, product, payment, amount_cents, row_seq, product_id,
quantity` for sales; `id, name, price_cents, stock, archived` for products)
and are invoked through PostgREST `/rest/v1/rpc/<name>` with named `p_*`
parameters.

| Function | Parameters (order) | Returns |
| --- | --- | --- |
| `v2_create_sale` | `p_sale_id uuid, p_date date, p_product text, p_payment text, p_amount_cents bigint, p_product_id uuid default null, p_quantity integer default 1, p_allow_negative boolean default false` | the created (or replayed) sale row |
| `v2_edit_sale` | `p_sale_id, p_prev_date, p_prev_product, p_prev_payment, p_prev_amount_cents, p_prev_product_id, p_prev_quantity, p_date, p_product, p_payment, p_amount_cents, p_product_id, p_quantity, p_allow_negative` | the updated sale row |
| `v2_delete_sale` | `p_sale_id, p_prev_date, p_prev_product, p_prev_payment, p_prev_amount_cents, p_prev_product_id, p_prev_quantity` | the removed sale row |
| `v2_create_product` | `p_name text, p_price_cents bigint default null, p_stock integer default 0` | the created product row |
| `v2_edit_product` | `p_product_id uuid, p_prev_name text, p_prev_price_cents bigint, p_prev_stock integer, p_name text, p_price_cents bigint, p_stock integer, p_allow_negative boolean default false` | the updated product row |
| `v2_archive_product` | `p_product_id uuid, p_prev_stock integer, p_archived boolean` | the updated product row |

### Error codes (exact, for T3 mapping)

| SQLSTATE | Meaning | Message prefix |
| --- | --- | --- |
| `28000` | Caller is not the bound uid+email identity (fail closed). | `IDENTIDAD_NO_AUTORIZADA:` |
| `23505` | Sale-id replay with different content, or duplicate active product name. | `Ese identificador ya corresponde a otra venta.` |
| `40001` | CAS conflict: the previous snapshot sent by the client no longer matches. | `La venta cambio desde otro dispositivo.` / `El producto cambio desde otro dispositivo.` |
| `P0001` | Stock shortage without `allowNegative`, or archived product selection. | `STOCK_INSUFICIENTE: stock=%, solicitado=%` / `PRODUCTO_INACTIVO:` |
| `P0002` | Sale or product not found. | `La venta ya no existe` / `El producto ya no existe` |
| `22023` | Negative initial stock on product creation. | `El stock inicial no puede ser negativo.` |
| `23503` | Linked product row vanished (foreign-key style guard). | `El producto vinculado ya no existe.` |

### Concurrency rules implemented

- Product switches lock both product rows in **ascending uuid order**
  (`order by id for update`) before any stock update, preventing deadlocks.
- Sale edits/deletes take a row lock plus compare-and-swap against the full
  previous snapshot (`40001` on mismatch) — the SQL-side twin of the HTTP
  layer's compare-and-swap.
- Idempotent create: same id + same content replays the stored row with **no**
  new movement; the DB-level partial unique index backstops the race.
- Stock going below zero requires the explicit `p_allow_negative`
  acknowledgement; without it the whole transaction (sale + movement) rolls
  back and stock is untouched.

### T3 HTTP-layer mapping (consumer contract)

The application layer (`lib/supabase.js`, `lib/products.js`, exercised end to
end by `test/stock-api.test.js` over real PGlite SQL using the fixture as a
minimal PostgREST boundary) invokes every RPC through PostgREST
`POST /rest/v1/rpc/<name>` with all `p_*` named parameters explicit (null
included, so no SQL default masks a client bug) and uses table GETs for
reads; composite rows are accepted both as a single object and as a one-row
array. SQLSTATE mapping used by the HTTP layer: `28000`/`42501` → 403
`FORBIDDEN`; `P0001 STOCK_INSUFICIENTE` → 409 `INSUFFICIENT_STOCK` (message
passesthrough with the stock/solicitado numbers); `P0001
PRODUCTO_INACTIVO` → 409 `PRODUCT_ARCHIVED`; `P0002`/`23503` → 404
`NOT_FOUND`; `40001` → 409 `SALE_CONFLICT`/`PRODUCT_CONFLICT`; `23505` →
409 `ID_CONFLICT` (sales, exact existing message) / `PRODUCT_CONFLICT`
(products); `22023` → 400 `INVALID_STOCK`; genuine network/429/5xx → honest
503 with noautomatic retry or resubmit. The exact hosted-PostgREST error
body shape for unhandled exceptions (status plus `{code, message}`) is a
pending T5 hosted check; the layer keys on the SQLSTATE code and falls back
by status only.

## Functional probe

`test/stock-probe.sql` is a rollback-only probe exercising the public
interface (RPC results, rejected invariants, RLS visibility, direct-DML
denials, v1-isolation fingerprinting). It uses psql meta commands that the
in-memory loader (`test/helpers/stock-db.js`) strips without changing SQL
behavior. It has been **EXECUTED against PGlite 0.5.8**; it is **LOCAL-ONLY**
and must NEVER be executed against the Supabase project: it drops the
registry foreign key and inserts a synthetic registry row with a fake uid
inside its transaction — acceptable only in a disposable in-memory database
undone by the rollback, never on cloud.

### Planned hosted rollback probe (T6, documentation only — not implemented)

A safe hosted probe for the real account is a DML-only single transaction
run by the parent AFTER the real owner is bound. Plan (not implemented here;
no cloud fixture exists in this task):

```sql
begin;
set local role authenticated;
set local request.jwt.claims = '{"sub":"<real confirmed uid>","email":"pochoclos@negocio.com"}';
select count(*) from public.v2_products;              -- RLS read (0 rows on day one)
-- optional write check through the real RPCs, then always:
rollback;
```

Rules: `begin`/`rollback` only; no inserts into `v2_business_account`, no FK
drops, no writes to `auth.users`, no registry changes — every mutation is
undone by the final `rollback` and the v1 fingerprint comparison above stays
the isolation proof. Any `FALLO:` exception aborts the transaction and
pinpoints the broken invariant. A clean run ends with `ROLLBACK`; failure
sentinels use SQLSTATE `P9999`, which no expected-error handler matches, so a
probe bug can never swallow its own failure.

## Known SQL-execution boundary

PGlite is a single connection: lock-based concurrency protections (the
deterministic `order by id for update` ordering, the `for update` CAS row
locks) are exercised logically but can NOT be proven to prevent deadlock or
lost updates without simultaneous connections. That proof needs either the
Supabase psql run with two sessions or a dedicated multi-connection harness,
and remains open for the verifier (T5).
