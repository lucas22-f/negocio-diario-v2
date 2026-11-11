# Negocio Diario v2

Independent v2 app for the pochoclos-1 business identity. It shares nothing
with the v1 deployment: no storage, no cookies, no identity, and no v1 tables
(never `public.sales`). Its only persistence is **Supabase**, through the
`v2_sales` table. T2 adds the remaining tables and columns.

## Schema (T2)

The v2-only database schema, RPC contract, security model and account-binding
steps are documented in [`supabase/README.md`](supabase/README.md). The
rollback-only functional probe is `test/stock-probe.sql`: it executes against
the in-memory PGlite fixture (`test/stock-functional.test.js`) and a Supabase
psql run remains the pending independent proof.

## Runtime contract

- **Supabase-only.** There is no Blob/CSV/local storage mode and no fallback.
  Without configuration every endpoint answers `503 SESSION_CONFIG`: the app
  fails closed, it never serves or stores data through another path.
- **Fixed identity.** The only allowed business identity is
  `pochoclos@negocio.com` — hardcoded in `lib/session.js` (a deployment cannot
  switch identity via env vars). The Supabase Auth user id must be supplied
  explicitly through the environment; there is no default.
- **Sessions.** Same one-hour server-enforced idle window as before, an
  encrypted HttpOnly/SameSite=Lax/Secure cookie now named `v2_session`, and
  the same Origin guard for mutating requests. Cookies from other
  deployments are never read.

## Environment

There is **no `.env.example`** (and no committed env sample file of any
kind): the server reads `process.env` directly and loads no `.env` file
itself. Run it locally with the environment loaded explicitly:

```sh
node --env-file=.env.local server.js
```

There is no `npm start` script; `npm run dev` runs bare `node server.js`,
which fails closed (503 on every endpoint) without configuration.

| Variable | Role |
| --- | --- |
| `SUPABASE_URL` | Supabase project URL. |
| `SUPABASE_ANON_KEY` | Publishable (anon) key; the service_role key is never used. |
| `SUPABASE_ALLOWED_USER_ID` | UUID of the single allowed Supabase Auth user. Required, no default. |
| `SUPABASE_SESSION_KEY` | Server key (≥32 chars) that encrypts session cookie containers. |
| `SUPABASE_APP_ORIGIN` | Canonical app origin behind a proxy (e.g. Vercel). Required there. |

The allowed email is not configurable: it is the fixed v2 identity above. A
legacy `SUPABASE_ALLOWED_EMAIL` value is ignored.

## Commands

```sh
npm test        # node --test over public HTTP with deterministic Supabase fakes
npm run check   # syntax check of every existing source and test file
npm run dev     # node server.js (fails closed without configuration)
node --env-file=.env.local server.js   # explicit env loading (no start script exists)
```

All tests use synthetic identities and in-process fakes of Supabase Auth and
PostgREST; no real cloud access, accounts or data are involved.

## HTTP stock contract (T3, exact — T4 consumes this verbatim)

Both `/api/sales` and `/api/products` reuse the session flow (`v2_session`
cookie), the Origin guard for mutations, and validation-before-auth
precedence. Every error answer is `{error: {code, message}}` with a stable
code. Storage errors (network, 429, 5xx) answer honest `503 STORAGE_UNAVAILABLE`
and the server never retries or resubmits anything automatically (product
create has no request-id idempotency, so an uncertain create is a plain 503).

Sales (`/api/sales`):

```jsonc
// POST -> 201 (200 + replayed:true on an exact same-requestId replay)
{"requestId":"00000000-0000-4000-8000-0000000000aa","date":"2026-02-01",
 "product":"Bolsa","payment":"efectivo","amount":"5000",
 "productId":"<uuid|null>","quantity":2,"allowNegative":false}
// -> {"sale":{"id":"…","date":"…","product":"…","payment":"…",
//        "amountCents":500000,"productId":"…|null","quantity":2},
//      "replayed":false,"storage":"supabase"}
// PUT -> 200  body: the new sale (same keys) + "previous": the full previous
//      editable snapshot (requestId/date/product/payment/amount + productId,
//      quantity). A lost race answers 409 SALE_CONFLICT.
// DELETE -> 200  body: {"id":"…","previous":full previous snapshot};
//      404 NOT_FOUND when the snapshot id no longer exists.
// GET /api/sales?date=YYYY-MM-DD -> {date, currency:"ARS", storage, sales:[…]}
```

Rules: `productId` absent/null means a free-text sale and forces `quantity`
1; `quantity` defaults to 1 (1..1000000 with a product); `allowNegative`
must be an explicit JSON boolean (default false) and is required to confirm
a deliberate negative stock. The previous snapshot is compare-and-swapped
inside the SQL transaction on edits AND deletes. Under a concurrent
same-requestId race the sequential `replayed:true` flag may turn into a
plain successful create (201); the data contract (one stored sale, one stock
movement) never depends on that flag.

Products (`/api/products`):

```jsonc
// GET -> 200 {storage, products:[{"id","name","priceCents","stock","archived"}]}
//      lists ALL products ordered by name; archived ones stay visible and
//      explicitly flagged (chosen so sales can still match existing names).
// POST -> 201 {storage, product}
//      {"name":"Bolsa","price":"12,50","stock":10}; price optional
//      (same amount-style decimal rule as sales, absent -> priceCents null),
//      stock optional (default 0, may not be negative).
// PUT -> 200 {storage, product}
//      {"id":"…","previous":{"id":"…","name":"…","priceCents":1250,
//       "stock":10},"name":"…","price":"13","stock":5,"allowNegative":false}
//      full-snapshot CAS against the canonical previous row (as GET returned
//      it); 409 PRODUCT_CONFLICT on a lost race or a duplicate active name.
// DELETE -> 200 {storage, product}
//      {"id":"…","previous":{"stock":5}} -> archives the product (never a
//      hard delete); CAS on the observed stock.
```

Stable error codes: `400 INVALID_DATE / INVALID_PRODUCT / INVALID_PAYMENT /
INVALID_AMOUNT / INVALID_ID / INVALID_NAME / INVALID_PRICE / INVALID_STOCK /
INVALID_QUANTITY / INVALID_PRODUCT_ID / INVALID_ALLOW_NEGATIVE / INVALID_JSON`,
`401 UNAUTHENTICATED`, `403 FORBIDDEN_ORIGIN / FORBIDDEN (28000/42501, no
business access)`, `404 NOT_FOUND`, `409 ID_CONFLICT (sale replay content
mismatch, same id kept working) / SALE_CONFLICT (CAS) / PRODUCT_CONFLICT
(product CAS or duplicate active name) / INSUFFICIENT_STOCK (message carries
`stock=`/`solicitado=` numbers; the UI may confirm and retry the SAME sale id
with `allowNegative:true`) / PRODUCT_ARCHIVED`, `405 METHOD_NOT_ALLOWED`,
`415 CONTENT_TYPE`, `413 BODY_TOO_LARGE`, `503 SESSION_CONFIG /
SESSION_UNAVAILABLE / STORAGE_UNAVAILABLE`.

## HTTP daily stock contract (T2, exact — T3 consumes this verbatim)

`/api/stock-days` reuses the exact session flow (`v2_session` cookie), the
Origin guard for mutations, and the validation-before-auth precedence: every
malformed body answers `400` before the session gate is consulted and never
reaches storage. Both methods require Supabase configuration and fail closed
with `503 SESSION_CONFIG` without it; transport failures answer honest `503
STORAGE_UNAVAILABLE` and nothing is ever retried automatically.

The daily channel NEVER consults the global product stock — neither to
validate nor to display. Every read returns BOTH stands in one call (one row
per product/stand, ordered by product name then stand); T3 filters by stand
client-side. Historical loads are never synthesized, legacy (untagged) sales
never appear in the daily figures, and an unconfigured day is an explicit
zero, never a fabricated load.

```jsonc
// GET /api/stock-days?date=YYYY-MM-DD -> 200
{"date":"2026-02-01","currency":"ARS","storage":"supabase","rows":[
  {"productId":"<uuid>","product":"Bolsa","priceCents":null,"stand":"fixed",
   "initialLoad":5,"loaded":5,"sold":2,"available":3},
  {"productId":"<uuid>","product":"Bolsa","priceCents":null,"stand":"mobile",
   "initialLoad":0,"loaded":0,"sold":0,"available":0}]}
// loaded = initialLoad + replenished; sold derives from that date/stand's
// tagged sales; available = loaded - sold (it may go negative after an
// explicit allowNegative oversell). priceCents mirrors the product's
// optional price (null when unset) and is display data only.
```

```jsonc
// POST /api/stock-days -> 200 {"storage":"supabase","action":"<action>","applied":N}
// `applied` is the number of items applied (load/replenish) or rows copied
// (copy; 0 = the previous day had no load). PUT answers 405.
{"action":"load","date":"2026-02-01","stand":"fixed",
 "items":[{"productId":"<uuid>","initial":5,"prevInitial":null}],"allowNegative":false}
//   load defines the day's INITIAL load (S1). prevInitial is the observed
//   current initial load per item (null = no load yet): any mismatch loses
//   a per-item CAS and answers 409 LOAD_CONFLICT with the day untouched.
{"action":"replenish","date":"2026-02-01","stand":"fixed",
 "items":[{"productId":"<uuid>","replenished":2,"prevReplenished":null}],"allowNegative":false}
//   replenish sets the NEW cumulative added total of the day (never a
//   delta); the initial load is never rewritten. Same per-item CAS.
{"action":"copy","date":"2026-02-02","stand":"fixed"}
//   copy (S3) loads the PREVIOUS CALENDAR DAY's initial quantities for the
//   SAME stand: quantities prepared, never sold balances, and never an
//   automatic carryover. It carries no items.
```

Rules: `stand` is `"fixed" | "mobile"`; item quantities are integers 0..1000000
and real JSON numbers (never numeric strings); each list has no repeated
products; `allowNegative` is an explicit JSON boolean (default false) and is
required to confirm a load/replenish that would push the visible available
below zero. Copying onto a day that already has its own load is refused
atomically with `409 DAY_ALREADY_LOADED` — nothing is ever overwritten, and a
previous day without load is a successful no-op (`applied: 0`). Quantities are
validated 0..1000000 before storage; archived products are refused with `409
PRODUCT_ARCHIVED`.

**Daily sales opt-in.** A sale POSTed to `/api/sales` with `dailyStock: true`
(real boolean, requires `stand`) routes into the per-day/per-stand channel: it
consumes that day/stand's availability (never the global stock, never a
movement row), is stored tagged (`dailyStock: true` echoed on the row), and
reports shortages against the DAILY availability. The flag is additive: sales
without it keep the exact legacy global-stock contract, and historical legacy
sales remain editable/deletable through the legacy paths (`requestId` +
`amount` decimal string). Edits/deletes of a daily row may use either the
canonical stored shape (`id` + integer `amountCents`, the exact row GET
returned) or the existing frontend legacy shape (`requestId` + `amount`) — the
stored channel always decides the RPC, never a caller-provided flag. Snapshots
that omit the `dailyStock` tag adopt the stored channel, so editing the current
daily row never false-conflicts; an explicitly contradictory tag never
converts the channel and fails like any other stale field (409). The observed
`stand` in `previous` is compare-and-swapped too and is never inferred.

Stable daily error codes (same envelope `{error:{code,message}}`): `400
INVALID_DATE / INVALID_STAND / INVALID_ITEMS / INVALID_ACTION /
INVALID_ALLOW_NEGATIVE / INVALID_PRODUCT_ID / INVALID_JSON / INVALID_DAILY /
INVALID_STOCK`, `401 UNAUTHENTICATED`, `403 FORBIDDEN_ORIGIN / FORBIDDEN`,
`409 LOAD_CONFLICT` (per-item CAS loss, day untouched) / `DAY_ALREADY_LOADED`
(conflicting copy) / `INSUFFICIENT_STOCK` (message carries the daily
`stock=`/`solicitado=` numbers; retry the SAME list with `allowNegative:true`)
/ `PRODUCT_ARCHIVED`, `405 METHOD_NOT_ALLOWED`, `415 CONTENT_TYPE`, `413
BODY_TOO_LARGE`, `503 SESSION_CONFIG / SESSION_UNAVAILABLE /
STORAGE_UNAVAILABLE`.

**Deployment ordering (no migration is executed here).** Apply
`supabase/migrations/0003_daily_stock.sql` in the Supabase project BEFORE
deploying the new server code: older servers never call the daily RPCs, but a
new server without the migration fails closed (503) on `/api/stock-days` and
daily sale opt-ins. Migrations are applied in version order (0001 → 0002 →
0003) and are additive: no historical v1 or v2 rows are reset, backfilled or
destructively changed.

## Daily stock UI (T3 — `public/`)

The catalogue below the daily view is name/price/actions only: the legacy
global product stock stays internal for the legacy sale channel and the
product/archive CAS (creation sends `stock: 0`, edits re-send the observed
stock unchanged), and it is never editable, displayed or treated as the
daily authority.
The Stock panel now opens with the **daily stock view** and keeps the
catalogue below it:

- **Day and stand.** A date picker (`#stock-date`) and a radio view control
  (`#stock-view-fixed` / `#stock-view-mobile`, fieldset “Puesto”) choose the
  day and the stand; the table caption always shows the selected date and
  stand. One `GET /api/stock-days?date=…` read carries BOTH stands, so
  switching the view never reads again; changing the date reads the chosen
  day once, clears the other day's rows and ignores stale in-flight answers.
- **Figures.** Each active product row shows the approved
  “Cantidad cargada · Vendido · Disponible” figures for that date and stand.
  An unconfigured day is an explicit zero. Rows for later-archived products
  stay visible as read-only history; the catalogue join decides the archive
  flag, and until the catalogue loads the day rows stay plain and the server
  still refuses an archived edit.
- **Load edits (CAS).** “Modificar carga” opens the day edit form and edits
  the INITIAL load of that date and stand (`action: "load"` with the
  observed `prevInitial`); “Agregar unidades” adds units during the day
  (`action: "replenish"` sending the NEW cumulative total = observed
  replenished + units, with the observed value as `prevReplenished`). The
  observed row is the only CAS source, so nothing is ever overwritten by a
  lost race: a stale snapshot answers `409 LOAD_CONFLICT` with the day
  untouched, and a refused edit keeps the draft. Each acknowledged load,
  replenish or copy refreshes the shown figures with exactly one silent
  read; a refused one triggers no read.
- **Optional copy (S3).** “Copiar carga del día anterior” sends one
  `POST /api/stock-days` with `action: "copy"` and ONLY the stock date and
  the stock-view stand (never item lists, sale counts or balances). A
  previous day without load answers `applied: 0` (“El día anterior no tiene
  carga para copiar.”); copying onto a day that already has its own load
  answers `409 DAY_ALREADY_LOADED` and the UI says nothing was overwritten.
  There is no automatic carryover and no destructive reset anywhere.
- **Negative availability.** A load that would push the visible availability
  below the sold figure answers `409 INSUFFICIENT_STOCK` (the message
  carries the daily `stock=`/`solicitado=` numbers) and shows the in-app
  confirm “Aplicar igual y permitir disponibilidad negativa”, which retries
  the SAME payload with `allowNegative: true`; any later edit voids the
  confirm. Archived-product refusals (`409 PRODUCT_ARCHIVED`) and CAS
  losses are shown explicitly.
- **Daily sales opt-in.** Every new sale from the sale form sends
  `dailyStock: true` plus the selected stand: it consumes that date/stand's
  availability (never the global stock), so an unloaded day reports the
  daily shortage and the existing explicit confirm flow retries the same
  `requestId` with `allowNegative: true`. Legacy historical rows keep the
  legacy channel: `saleFields` preserves `dailyStock` when the stored row
  carries it and never adds it to an untagged row, so edits/deletes of a
  daily row keep the daily channel and a legacy row never gains the tag.
- **Contextual availability.** Product suggestions show availability for the
  SALE date + SALE stand (engaging the product field or changing the sale
  date with the list open is the only trigger; both stands come from one
  cached read, so changing the stand never re-reads). The global catalogue
  stock is never displayed as the daily authority. An acknowledged daily
  mutation drops that date's cache entry so the next availability read is
  fresh; the stock panel always re-reads when shown. No polling, no auto
  resubmits, and view/date switches never overwrite the sale draft.

## UI contract (T4 — `public/`)

- **Identification.** The business heading is `pochoclos-1`. There is no
  open-testing notice, no backend badge, no storage mode and no session
  sentence on the screen: an authenticated read keeps the layout and offers
  logout plus the menu; errors keep their full copy. Business data loading
  never polls.
- **Live loading indicator (S7).** The header carries one shared
  `#sync-status` indicator that shows `Actualizando…` only while at least one
  real API call is actually awaited through the single `api()` wrapper (reads,
  saves, deletes, session calls), across the Sales and Stock panels alike. It
  clears the moment the last call settles — success, HTTP error, network
  error, unreadable body or timeout abort — counts overlapping calls, shows
  nothing idle on anonymous screens, keeps the operation-specific messages
  (`Guardando…`, `Eliminando…`, `Entrando…`, `Cerrando sesión…`) unchanged, and
  stays table-scoped (`aria-busy` on the ledger table belongs only to the
  shown sales read).
- **Hamburger menu.** The header toggle (`#menu-button`, `aria-expanded`) opens
  `#app-menu` (Ventas / Stock). Opening focuses the first entry; choosing an
  entry switches the visible panel (one at a time), closes the menu and moves
  focus to the chosen panel; Escape closes and returns focus to the toggle.
  The menu only exists for a proven business session.
- **Stock panel.** Opens with exactly one visible `GET /api/products` (list of
  ALL products, archived ones flagged and read-only). The catalogue shows
  name, price and actions only: the legacy global units are internal
  compatibility data, never displayed or edited (creation sends the legacy
  `stock: 0`; a name/price edit re-sends the observed stock untouched, and
  the archive DELETE keeps its observed `previous: {stock}` CAS). Create/Edit
  keeps the exact T3 product contract above (`previous:
  {id,name,priceCents,stock}` on PUT, archived rows never editable); archive
  is an in-app two-step confirm (¿Archivar? → ¡Sí, archivar!) and notices are
  honest (guardado / modificado / archivado / 404 ya existe). No
  negative-global-stock edit UI exists, so the UI never sends
  `allowNegative` for a product.
- **Sale product link.** Typing in the product field streams suggestions from
  the cached active products (never archived ones; no technical language).
  Choosing a suggestion sets `productId`, parks quantity at its default 1,
  enables the quantity field and — when the product has an optional price —
  prefills the amount with quantity × price, still editable. Any further
  typing clears the link so a free-text sale stays safe at quantity 1 and
  `productId` null.
- **Historical sales.** Editing a linked sale loads its snapshot quantity and
  never relinks by name: PUT/DELETE always carry the observed previous row
  (`requestId/date/product/payment/amount + productId/quantity`), the
  read-only snapshot stays with the row, and only a deliberate selection or a
  typed change moves the working link.
- **Negative stock sales.** A `409 INSUFFICIENT_STOCK` answer to a sale
  keeps the whole draft visible and shows an explicit confirm ("Vender igual y
  permitir stock negativo"). Confirming retries the SAME `requestId` with
  `allowNegative:true` and nothing else changed; editing the draft or
  resending it manually starts a fresh decision.
- **Stock freshness.** The cached product list is read once more after each
  acknowledged sale/product mutation so suggestions show real stock; there is
  no polling, no auto resubmit and no refresh after uncertain or failed
  mutations. Drafts, identities and notices keep the pre-existing coding
  rules (no relinking, no duplicate writes).

## Scope notes

- No historical v1 import; all data arrives through the v2 API itself (T2/T3).
- Sales keep their existing public shape (`id`, `date`, `product`, `payment`,
  `amountCents`) and add `productId` (null for free-text sales) and `quantity`
  (always 1 without a product link).
- All stock mutations go through the transactional v2 RPCs (atomic decrement,
  audited movements, CAS); table writes are never used.
- Hosted PostgREST parity (error-body shape for unhandled SQL errors) and
  multi-session concurrency remain pending for the T5 independent verification
  and the T6 cloud apply.

## Automatic sale amount

Selecting a priced product sets the amount to its unit price. Changing quantity
recalculates the total immediately as quantity × price, using integer cents.
Free-text sales and products without a price retain manual amounts; a deliberate
manual adjustment remains editable until quantity changes again. Opening a
historical sale never reprices it: select a product again to use its current price.
No saved sales, stock rules or API contracts are changed by this calculation.
Each ledger row also displays its stored quantity below the product and stand;
legacy rows without quantity display one. The mobile layout keeps four columns.

## Sale stand (fixed / mobile)

Sales may carry optional `stand: "fixed" | "mobile" | null` in POST/PUT and
the previous snapshot in PUT/DELETE. Other values answer
`400 INVALID_STAND` / `Elegí Puesto fijo o Móvil.` before storage access.
A non-null stand is returned with the sale; unknown legacy attribution is
omitted, never guessed. Replay identity and modern edit/delete CAS include it.
Legacy requests omitting the field still work and never clear stored attribution.
No new accounts, separate inventory, filters or seller names are introduced.

The sales form requires an explicit **Puesto fijo** or **Móvil** choice on a
new device. Only that non-secret preference is remembered locally under
`pochoclos-v2:stand`; blocked storage does not prevent sales. A second device
keeps its own choice. Each ledger row displays its saved stand, or **Sin puesto**
for historical rows. Editing uses the row's attribution, not the device's choice;
canceling or saving an edit restores the original device draft. Historical edits
may remain unassigned unless a stand is deliberately selected. Shared stock and
the existing refresh-on-save behavior are unchanged.

Apply `supabase/migrations/0002_sale_stand.sql` **before** deploying the new
server. The migration leaves old RPC signatures available for rolling clients.
Local fixtures apply versioned migrations in order; cloud application and
publication are separate, explicitly authorized delivery operations.
