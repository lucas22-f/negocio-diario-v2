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
  ALL products, archived ones flagged and read-only). Create/Edit uses the
  exact T3 product contract above (`previous: {id,name,priceCents,stock}` on
  PUT, `previous: {stock}` on archive DELETE, archived rows never editable);
  archive is an in-app two-step confirm (¿Archivar? → ¡Sí, archivar!) and
  notices are honest (guardado / modificado / archivado / 404 ya existe).
  A product PUT refused with `409 INSUFFICIENT_STOCK` shows an explicit
  in-app confirm that resends the SAME draft with `allowNegative:true`; any
  later edit voids the confirm.
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
