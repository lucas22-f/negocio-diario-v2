import { SalesError, validateDate } from '../lib/sales.js';
import { createSupabaseStockDaysApi, validateDailyAction } from '../lib/stock-days.js';
import { assertSameOrigin, createSessionManager } from '../lib/session.js';
import { readJson, sendJson } from './sales.js';

export const config = { api: { bodyParser: false } };

// T2 of odd/tasks/daily-stand-stock.md (S1-S5): the per-day/per-stand stock
// endpoint. It reuses the exact session flow (createSessionManager), the
// Origin guard for mutations, the body limit and the validation-before-auth
// precedence of /api/sales and /api/products (readJson/sendJson), and reaches
// Supabase only through the daily RPC contract of lib/stock-days.js. Without
// configuration it fails closed with 503 SESSION_CONFIG. The daily channel
// never consults the global product stock.
//
// Public contract (exact; T3 consumes this verbatim):
//   GET /api/stock-days?date=YYYY-MM-DD
//     -> 200 {date, currency:"ARS", storage:"supabase", rows:[
//          {productId, product, priceCents, stand, initialLoad, loaded,
//           sold, available}]}
//     One read returns BOTH stands (one row per product/stand, ordered by
//     product name then stand); T3 filters by stand client-side. Every active
//     product appears with explicit zeros for an unconfigured day; historical
//     loads are never synthesized and legacy (untagged) sales never appear in
//     the daily sold/available figures.
//   POST /api/stock-days  -> 200 {storage:"supabase", action, applied}
//     body {action:"load",     date, stand, items:[{productId, initial,
//            prevInitial}], allowNegative?}
//          {action:"replenish", date, stand, items:[{productId, replenished,
//            prevReplenished}], allowNegative?}
//          {action:"copy", date, stand}
//     `applied` is the number of items applied (load/replenish) or rows
//     copied (copy; 0 = the previous day had no load). PUT is not part of
//     this endpoint and answers 405.
//
// Errors: 400 INVALID_DATE / INVALID_STAND / INVALID_ITEMS / INVALID_ACTION /
// INVALID_ALLOW_NEGATIVE / INVALID_PRODUCT_ID / INVALID_JSON (all before any
// session check), 401 UNAUTHENTICATED, 403 FORBIDDEN_ORIGIN / FORBIDDEN,
// 409 LOAD_CONFLICT (per-item CAS loss, day untouched), 409 DAY_ALREADY_LOADED
// (conflicting copy, nothing overwritten), 409 INSUFFICIENT_STOCK (message
// carries the daily stock=/solicitado= numbers; retry the SAME list with
// allowNegative:true), 415 CONTENT_TYPE, 413 BODY_TOO_LARGE, 503
// SESSION_CONFIG / SESSION_UNAVAILABLE / STORAGE_UNAVAILABLE (never retried
// automatically).
export function createStockDaysHandler({ env = process.env, supabaseFetch = globalThis.fetch } = {}) {
  const session = createSessionManager({ env, supabaseFetch });
  return async (req, res) => {
    try {
      if (req.method === 'POST') {
        assertSameOrigin(req, env); // cross-origin mutations are rejected before any body is read
      }
      let date;
      let action;
      // Validate first, even if storage is unavailable. Invalid input never reads it.
      if (req.method === 'GET') {
        const dates = new URL(req.url, 'http://localhost').searchParams.getAll('date');
        date = validateDate(dates.length === 1 ? dates[0] : null);
      } else if (req.method === 'POST') {
        action = validateDailyAction(await readJson(req));
      } else {
        res.setHeader('Allow', 'GET, POST');
        throw new SalesError(405, 'METHOD_NOT_ALLOWED', 'Método no permitido.');
      }
      // The session gate always runs before any data access, and the very
      // token it verified is the one used against PostgREST (never the
      // service_role key). Validation already ran, so the exact public
      // precedence holds: bad requests fail before any identity check.
      const tokens = await session.authenticate(req, res);
      const api = createSupabaseStockDaysApi({ env, accessToken: tokens.access, supabaseFetch });
      if (action) {
        const applied = action.action === 'copy'
          ? await api.copy(action.date, action.stand)
          : action.action === 'load'
            ? await api.load(action.date, action.stand, action.items, action.allowNegative)
            : await api.replenish(action.date, action.stand, action.items, action.allowNegative);
        sendJson(res, 200, { storage: 'supabase', action: action.action, applied });
      } else {
        sendJson(res, 200, { date, currency: 'ARS', storage: 'supabase', rows: await api.read(date) });
      }
    } catch (error) {
      if (error instanceof SalesError) sendJson(res, error.status, { error: { code: error.code, message: error.message } });
      else sendJson(res, 503, { error: {
        code: 'STORAGE_UNAVAILABLE', message: 'No se pudo acceder al stock del día. Reintentá en unos momentos.',
      } });
    }
  };
}

export default createStockDaysHandler();
