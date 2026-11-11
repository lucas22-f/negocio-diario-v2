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

## Additive sale stand migration

`0002_sale_stand.sql` adds nullable `v2_sales.stand` with values
`fixed` / `mobile`; historical rows remain null, with no backfill.
Apply it after `0001_v2_stock.sql`, before the new server is deployed.

Separate guarded RPC names avoid changing or overloading the legacy signatures:
- `v2_create_sale_at_stand`: existing create parameters plus `p_stand`.
- `v2_edit_sale_at_stand(p_sale jsonb, p_previous jsonb)`: normalized API
  sale objects (`id, date, product, payment, amountCents, productId, quantity, stand`).
- `v2_delete_sale_at_stand(p_previous jsonb)`: the observed normalized row.

Create replay equality includes stand; edit/delete lock the sale and compare
the observed stand before delegating existing atomic stock operations.
Execution stays authenticated-only with the unchanged exact UID+email gate.
Old callers retain their signatures and cannot silently clear attribution.
No v1 table, product, stock movement or auth policy is changed.

## Daily stock by date and stand (0003, T1)

`0003_daily_stock.sql` is strictly additive over 0001/0002 (byte-for-byte
unchanged). Each calendar day starts with NO load: absence of rows in the new
table IS the zero default, and no historical load is ever fabricated or
backfilled. Historical (null/unknown-stand) sales are never assigned to a
stand and never appear in daily figures.

### Legacy global stock/movement mirror strategy (decided before implementation)

The daily channel is an entirely separate ledger:

- `v2_products.stock` and `v2_stock_movements` keep serving the legacy global
  balance exactly as before. Daily RPCs never read, write or audit them, so a
  global shortage can never block a daily sale and daily balances NEVER
  consult global stock as authority. Global stock becomes a
  **non-authoritative mirror for legacy clients**; there is no backfill and
  no reconciliation between the two ledgers.
- Every sale created by the daily RPCs is tagged `v2_sales.daily_stock = true`
  (and always carries a stand, enforced by a check constraint). Daily sold
  and available figures derive ONLY from these tagged rows.
- The legacy sale RPCs (`v2_create_sale`, `v2_edit_sale`, `v2_delete_sale`,
  `v2_create_sale_at_stand`, and the at-stand edit/delete that delegate into
  them) are re-created in 0003 with their EXACT original signatures plus one
  fail-closed addition: any legacy operation on a daily-tagged row raises
  `55006` instead of silently corrupting the mirror. Symmetrically, the daily
  RPCs refuse untagged (legacy) rows with the same code. Untagged rows keep
  the exact legacy behavior (global stock consumption + movement audit).
- There is deliberately no reset/clear/delete-stock feature.

### Tables

| Object | Purpose |
| --- | --- |
| `v2_daily_stock` | One row per `(product_id, date, stand)` that has a load. `initial_load` is the day's original load (defined at start or copied); `replenished` is the cumulative total added later during the day — kept as a separate column, never merged into the initial value. RLS select policy identical to the other tables; all client DML revoked. |
| `v2_sales.daily_stock` | Channel tag, `boolean not null default false`. A daily sale always has `stand` (`v2_sales_daily_requires_stand`). |
| `v2_sales_daily_sold_idx` | Partial index `(date, stand, product_id) where daily_stock` backing the derived sold aggregation. |

### Daily RPC contract (consumed by T2)

All new RPCs are security definer with `search_path = ''`, re-assert identity,
are authenticated-only, and use fresh additive names (no overload ambiguity).
Invoke through PostgREST `/rest/v1/rpc/<name>` with every `p_*` parameter
explicit, null included.

| Function | Parameters (order) | Returns |
| --- | --- | --- |
| `v2_read_daily_stock` | `p_date date` | set of rows `(product_id uuid, product text, price_cents bigint, stand text, initial_load integer, loaded integer, sold integer, available integer)` |
| `v2_load_daily_stock` | `p_date date, p_stand text, p_items jsonb, p_allow_negative boolean default false` | integer (items applied) |
| `v2_replenish_daily_stock` | `p_date date, p_stand text, p_items jsonb, p_allow_negative boolean default false` | integer (items applied) |
| `v2_copy_daily_stock` | `p_date date, p_stand text` | set of `v2_daily_stock` rows copied |
| `v2_create_daily_sale` | `p_sale_id uuid, p_date date, p_product text, p_payment text, p_amount_cents bigint, p_product_id uuid default null, p_quantity integer default 1, p_allow_negative boolean default false, p_stand text` | the created (or replayed) sale row |
| `v2_edit_daily_sale` | `p_sale jsonb, p_previous jsonb` | the updated sale row |
| `v2_delete_daily_sale` | `p_previous jsonb` | the removed sale row |

Read semantics: one row per (product, stand) for the date — every active
product (zero default for an unconfigured day) plus any product with a load or
a tagged sale that day, so history stays readable even if the product was
later archived. `loaded = initial_load + replenished`; `sold` is derived by
aggregating the tagged sale quantities of that date/stand/product;
`available = loaded − sold` (it may be negative after a confirmed
overselling operation). Stand is required to be `fixed` or `mobile` wherever
a stand parameter exists.

`p_items` for load is a JSON array of
`{ "productId": uuid, "initial": integer 0..1000000, "prevInitial": integer|null }`
where `prevInitial` is the observed current initial load and `null` means
"observed zero/absent". For replenish it is
`{ "productId": uuid, "replenished": integer 0..1000000, "prevReplenished": integer|null }`
where `replenished` is the NEW cumulative total added that day (not a delta).
Both are per-item compare-and-swap calls: any mismatch raises `40001` and the
whole call leaves the day untouched; replays with matching observed values
are naturally idempotent (no duplicated rows or counters). Duplicated
products inside one list are refused. The initial load is never rewritten by
replenish, and replenished is never rewritten by load.

`p_previous` / `p_sale` for the daily edit/delete use the normalized API sale
object `{ id, date, product, payment, amountCents, productId, quantity, stand }`
(plus `allowNegative` on `p_sale` only), matching the existing at-stand jsonb
convention.

Copy semantics: copies the PREVIOUS CALENDAR DAY's `initial_load` values for
the SAME stand only — never the replenishments, never sold/available, never
across stands, never for archived products, and never zero-value rows. A day
that already has any of its own loads is refused atomically (nothing is
inserted, nothing is overwritten) with `23505 EL_DIA_YA_TIENE_CARGA:`. A
previous day without load is a successful no-op returning zero rows. Leap
days and the year boundary are plain calendar arithmetic (`p_date - 1`).

### Concurrency rules implemented

- Load, replenish, edit and create lock every involved `v2_products` row in
  ascending uuid order BEFORE deriving any balance, so in READ COMMITTED the
  availability is re-read on fresh data after serialization; concurrent
  daily sales for the same product cannot oversell silently, and copies
  cannot interleave with loads.
- Copy is atomic against a concurrent destination write through the
  `(product_id, date, stand)` primary key: a losing insert aborts the whole
  copy with the same `EL_DIA_YA_TIENE_CARGA` error.
- Sold/available are derived, not stored counters: daily edits, deletes and
  stand/product/date moves only re-derive, so idempotency, CAS and the
  allow-negative confirmations behave like the legacy sale RPCs.
- These protections are logically exercised in PGlite (single connection);
  true multi-connection deadlock/lost-update proof stays open for the
  verifier, exactly like the 0001 boundary note above.

### Error codes added (exact, for T2 mapping)

| SQLSTATE | Meaning | Message prefix |
| --- | --- | --- |
| `55006` | Channel mismatch: a legacy RPC touched a daily-tagged sale, or a daily RPC touched an untagged (legacy) sale. | `VENTA_DIARIA:` |
| `23505` | Copy refused because the destination day already has its own load (this specific case only; sale/product id-replay keeps its existing meaning). | `EL_DIA_YA_TIENE_CARGA:` |
| `22023` | Invalid daily input: missing/invalid stand (`Elegí Puesto fijo o Móvil.`), missing date (`Elegí una fecha válida.`), non-list or duplicate items, out-of-range load (`entre 0 y 1000000`), missing sale fields (`Faltan datos de la venta.`). | — |
| `40001` | CAS conflict on a load/replenish item (`La carga cambió desde otro dispositivo...`) or a daily edit/delete (`La venta cambió desde otro dispositivo...`). | — |
| `23503` / `P0001 PRODUCTO_INACTIVO` / `P0002` / `P0001 STOCK_INSUFICIENTE` | Same shapes as the legacy contract, but `STOCK_INSUFICIENTE` now reports the DAILY availability (for loads/replenish: `stock` = current available, `solicitado` = proposed loaded total). | — |

Suggested (T2-owned) HTTP mapping for the new codes: `55006` → `409
DAILY_SALE_CHANNEL` (passthrough message); `23505 EL_DIA_YA_TIENE_CARGA` →
`409 DAY_ALREADY_LOADED`; the daily CAS `40001` variants reuse
`SALE_CONFLICT`/a `409 LOAD_CONFLICT`; everything else follows the existing
mapping table above. T2 must send every named parameter explicitly and may
rely on `v2_read_daily_stock` for calendar/date navigation reads, filtering
by stand client-side (both stands arrive in one call).
