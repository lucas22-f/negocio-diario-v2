import { SalesError, validateDate, validateSale, validateSaleId } from '../lib/sales.js';
import { createSupabaseSalesApi } from '../lib/supabase.js';
import { assertSameOrigin, createSessionManager } from '../lib/session.js';

const bodyLimit = 4096;
export const config = { api: { bodyParser: false } };

export function sendJson(res, status, body) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
  });
  res.end(JSON.stringify(body));
}

async function readJson(req) {
  if ((req.headers['content-type'] || '').split(';')[0].trim().toLowerCase() !== 'application/json') {
    throw new SalesError(415, 'CONTENT_TYPE', 'Usá Content-Type: application/json.');
  }
  const tooLarge = () => new SalesError(413, 'BODY_TOO_LARGE', 'La solicitud es demasiado grande.');
  if (Number(req.headers['content-length']) > bodyLimit) throw tooLarge();
  let text;
  if (req.body !== undefined) {
    text = typeof req.body === 'string' ? req.body : Buffer.isBuffer(req.body)
      ? req.body.toString('utf8') : JSON.stringify(req.body);
    if (Buffer.byteLength(text) > bodyLimit) throw tooLarge();
  } else {
    const chunks = [];
    let size = 0;
    for await (const chunk of req.iterator({ destroyOnReturn: false })) {
      size += chunk.length;
      if (size > bodyLimit) {
        req.resume();
        throw tooLarge();
      }
      chunks.push(chunk);
    }
    text = Buffer.concat(chunks).toString('utf8');
  }
  try { return JSON.parse(text); }
  catch { throw new SalesError(400, 'INVALID_JSON', 'La solicitud debe ser JSON válido.'); }
}

export { readJson };

// v2 T3 (odd/tasks/stock-v2.md): Supabase-only through the stock RPC contract.
// There is no Blob or local storage mode and no fallback: an unconfigured
// request fails closed with 503 SESSION_CONFIG before any data access. The
// public request/response contract (validation, origin guard, one session
// flow, sale shapes) is kept; sales may now link a stock product
// (productId + quantity, default 1) and every PUT/DELETE carries the full
// previous snapshot (productId and quantity included) as compare-and-swap.
export function createSalesHandler({ env = process.env, supabaseFetch = globalThis.fetch } = {}) {
  const session = createSessionManager({ env, supabaseFetch });
  return async (req, res) => {
    try {
      if (['POST', 'PUT', 'DELETE'].includes(req.method)) {
        assertSameOrigin(req, env); // cross-origin mutations are rejected before any body is read
      }
      let date;
      let sale;
      let saleId;
      let previous;
      // Validate first, even if storage is unavailable. Invalid input never reads it.
      if (req.method === 'GET') {
        const dates = new URL(req.url, 'http://localhost').searchParams.getAll('date');
        date = validateDate(dates.length === 1 ? dates[0] : null);
      } else if (req.method === 'POST') {
        sale = validateSale(await readJson(req));
      } else if (req.method === 'PUT') {
        const body = await readJson(req);
        sale = validateSale(body);
        previous = validateSale(body.previous);
        if (sale.id !== previous.id) throw new SalesError(400, 'INVALID_ID', 'El identificador de la venta no es válido.');
      } else if (req.method === 'DELETE') {
        // Deletes now carry the full previous row (productId and quantity
        // included): the SQL validates it inside the transaction and refuses
        // to delete what the client no longer observed.
        const body = await readJson(req);
        saleId = validateSaleId(body);
        previous = validateSale(body.previous);
        if (saleId !== previous.id) throw new SalesError(400, 'INVALID_ID', 'El identificador de la venta no es válido.');
      } else {
        res.setHeader('Allow', 'GET, POST, PUT, DELETE');
        throw new SalesError(405, 'METHOD_NOT_ALLOWED', 'Método no permitido.');
      }
      // The session gate always runs before any data access, and the very
      // token it verified is the one used against PostgREST (never the
      // service_role key). Validation already ran, so the exact public
      // precedence holds: bad requests fail before any identity check.
      const tokens = await session.authenticate(req, res);
      const api = createSupabaseSalesApi({ env, accessToken: tokens.access, supabaseFetch });
      // DELETE is matched by saleId first because it now carries `previous`
      // too (the full snapshot CAS); PUT is the only mutation with previous
      // but a null saleId.
      if (saleId) {
        sendJson(res, 200, { sale: await api.remove(saleId, previous), storage: 'supabase' });
      } else if (previous) {
        sendJson(res, 200, { sale: await api.update(sale, previous), storage: 'supabase' });
      } else if (sale) {
        const saved = await api.append(sale);
        sendJson(res, saved.replayed ? 200 : 201, { ...saved, storage: 'supabase' });
      } else {
        sendJson(res, 200, { date, currency: 'ARS', storage: 'supabase', sales: await api.list(date) });
      }
    } catch (error) {
      if (error instanceof SalesError) sendJson(res, error.status, { error: { code: error.code, message: error.message } });
      else sendJson(res, 503, { error: {
        code: 'STORAGE_UNAVAILABLE', message: 'No se pudo acceder a las ventas. Reintentá en unos momentos.',
      } });
    }
  };
}

export default createSalesHandler();
