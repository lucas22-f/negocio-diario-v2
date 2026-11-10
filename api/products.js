import { SalesError } from '../lib/sales.js';
import {
  createSupabaseProductsApi, validateProductPayload, validateProductSnapshot,
  validateProductIdValue, validateStockNumber,
} from '../lib/products.js';
import { assertSameOrigin, createSessionManager } from '../lib/session.js';
import { readJson, sendJson } from './sales.js';

export const config = { api: { bodyParser: false } };

// v2 T3 of odd/tasks/stock-v2.md (S1,S3-S5): the stock screen's product
// endpoint. It reuses the exact session flow, Origin guard, body-limit and
// validation-before-auth precedence of /api/sales (createSessionManager,
// assertSameOrigin, readJson/sendJson), and reaches Supabase only through the
// RPC contract of lib/products.js. Without configuration it fails closed with
// 503 SESSION_CONFIG; every write requires the verified identity.
//
// Public contract (exact; T4 consumes this verbatim):
//   GET    /api/products            -> 200 {storage, products:[{id,name,priceCents,stock,archived}]}
//        lists ALL products ordered by name, archived ones included and
//        explicitly flagged (chosen so the sale screen can still match names
//        that already exist in stock).
//   POST   /api/products            -> 201 {storage, product}
//        body {name, price?, stock?}; price absent -> null; stock default 0.
//   PUT    /api/products            -> 200 {storage, product}
//        body {id, previous:{id,name,priceCents,stock}, name, price?, stock?,
//        allowNegative?}; full compare-and-swap against the canonical
//        previous row; a lost race answers 409 PRODUCT_CONFLICT.
//   DELETE /api/products            -> 200 {storage, product}
//        body {id, previous:{stock}} -> archive RPC (never a hard delete).
export function createProductsHandler({ env = process.env, supabaseFetch = globalThis.fetch } = {}) {
  const session = createSessionManager({ env, supabaseFetch });
  return async (req, res) => {
    try {
      if (['POST', 'PUT', 'DELETE'].includes(req.method)) {
        assertSameOrigin(req, env); // cross-origin mutations are rejected before any body is read
      }
      let product;
      let previous;
      let productId;
      let previousStock;
      // Validate first, even if storage is unavailable. Invalid input never reads it.
      if (req.method === 'GET') {
        // Nothing to validate: the catalogue has no query contract yet.
      } else if (req.method === 'POST') {
        product = validateProductPayload(await readJson(req));
      } else if (req.method === 'PUT') {
        const body = await readJson(req);
        productId = validateProductIdValue(body.id);
        product = validateProductPayload(body);
        previous = validateProductSnapshot(body.previous);
        if (body.previous && body.previous.id !== undefined
            && body.previous.id !== productId) {
          throw new SalesError(400, 'INVALID_ID', 'El identificador del producto no es válido.');
        }
      } else if (req.method === 'DELETE') {
        const body = await readJson(req);
        productId = validateProductIdValue(body.id);
        previous = body.previous && typeof body.previous === 'object' && !Array.isArray(body.previous)
          ? body.previous : null;
        // The archive CAS compares the stock the client saw; nothing else.
        previousStock = validateStockNumber(previous?.stock);
      } else {
        res.setHeader('Allow', 'GET, POST, PUT, DELETE');
        throw new SalesError(405, 'METHOD_NOT_ALLOWED', 'Método no permitido.');
      }
      // The session gate always runs before any data access, and the token it
      // verified is the one used against PostgREST (never the service_role key).
      // Validation already ran, so the exact public precedence holds: bad
      // requests fail before any identity check.
      const tokens = await session.authenticate(req, res);
      const api = createSupabaseProductsApi({ env, accessToken: tokens.access, supabaseFetch });
      if (previousStock !== undefined) {
        sendJson(res, 200, { product: await api.archive(productId, previousStock), storage: 'supabase' });
      } else if (productId) {
        sendJson(res, 200, { product: await api.update(productId, previous, product), storage: 'supabase' });
      } else if (product) {
        sendJson(res, 201, { product: await api.create(product), storage: 'supabase' });
      } else {
        sendJson(res, 200, { storage: 'supabase', products: await api.list() });
      }
    } catch (error) {
      if (error instanceof SalesError) sendJson(res, error.status, { error: { code: error.code, message: error.message } });
      else sendJson(res, 503, { error: {
        code: 'STORAGE_UNAVAILABLE', message: 'No se pudo acceder a los productos. Reintentá en unos momentos.',
      } });
    }
  };
}

export default createProductsHandler();
