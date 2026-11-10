import { SalesError, sameSale } from './sales.js';

// v2 T3 of odd/tasks/stock-v2.md (S1,S3-S5): all sales writes go through the
// transactional v2_* RPC endpoints (documented in supabase/README.md), and
// only the GET side reads the v2 tables directly. Direct INSERT/PATCH/DELETE
// on the tables is never attempted — PostgREST itself revokes it, so pushing
// a write there would simply fail and hide the real atomicity contract. Every
// call carries the publishable key plus the user's own verified access token;
// the service_role key is never used and the v1 public.sales table is never
// read or written. Composite rows may come back as a single object or as a
// one-row array (both are legitimate PostgREST shapes) and both are accepted.

const SELECT_SALES = 'id,date,product,payment,amount_cents,row_seq,product_id,quantity,stand';

export function supabaseStoreConfig(env = process.env) {
  const value = name => (typeof env[name] === 'string' ? env[name].trim() : '');
  const url = value('SUPABASE_URL');
  const anonKey = value('SUPABASE_ANON_KEY');
  let parsedUrl = null;
  try { parsedUrl = url ? new URL(url) : null; } catch { parsedUrl = null; }
  if (!parsedUrl || !['http:', 'https:'].includes(parsedUrl.protocol) || !anonKey) {
    throw new SalesError(503, 'SESSION_CONFIG', 'Falta configurar Supabase (URL y clave pública).');
  }
  return { url: url.replace(/\/+$/, ''), anonKey };
}

// snake_case database row -> public camelCase sale. Response payloads must
// never leak database internals (row_seq) or trust untyped rows.
export function toSale(row) {
  const badRow = () => new Error('Supabase respondió una fila de ventas inesperada.');
  if (!row || typeof row !== 'object' || Array.isArray(row)
      || typeof row.id !== 'string' || !row.id || typeof row.date !== 'string'
      || typeof row.product !== 'string' || !['efectivo', 'transferencia'].includes(row.payment)
      || !Number.isSafeInteger(Number(row.amount_cents))) {
    throw badRow();
  }
  const productId = row.product_id === undefined ? null : row.product_id;
  if (productId !== null && typeof productId !== 'string') throw badRow();
  if (row.stand != null && !['fixed', 'mobile'].includes(row.stand)) throw badRow();
  const quantity = Number(row.quantity);
  if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > 1000000) throw badRow();
  return {
    id: row.id,
    date: row.date,
    product: row.product,
    payment: row.payment,
    amountCents: Number(row.amount_cents),
    productId: productId ?? null,
    quantity,
    ...(row.stand == null ? {} : { stand: row.stand }),
  };
}

// ---------------------------------------------------------------------
// Shared REST access: one builder used by the sales and the products API.
// ---------------------------------------------------------------------

export function createRestAccess({ configs, accessToken, supabaseFetch = globalThis.fetch }) {
  if (typeof accessToken !== 'string' || !accessToken) {
    throw new SalesError(401, 'UNAUTHENTICATED', 'Iniciá sesión para continuar.');
  }
  return async function call(path = '', { method = 'GET', body } = {}) {
    let response;
    try {
      response = await supabaseFetch(`${configs.url}/rest/v1/${path}`, {
        method,
        headers: {
          'apikey': configs.anonKey,
          'authorization': `Bearer ${accessToken}`,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch (error) {
      throw new Error('No se pudo contactar Supabase REST.', { cause: error });
    }
    let payload = null;
    try { payload = await response.json(); } catch { payload = null; }
    return { status: response.status, payload };
  };
}

export function rowOf(payload, context) {
  if (Array.isArray(payload)) {
    if (payload.length === 1 && payload[0] && typeof payload[0] === 'object' && !Array.isArray(payload[0])) {
      return rowOf(payload[0], context);
    }
    throw new Error(`${context}: fila compuesta inesperada.`);
  }
  if (payload && typeof payload === 'object') return payload;
  throw new Error(`${context}: fila compuesta inesperada.`);
}

// Stable SQLSTATE -> public HTTP error mapping (supabase/README.md "Error
// codes"): identity denials are 403, an explicit stock shortage is a 409 the
// UI may confirm and retry under the same sale id with allowNegative, CAS
// losses and content conflicts are 409s, absent rows are 404s and genuine
// network/rate/5xx failures are honest 503s. Nothing is ever silently
// retried or re-submitted here.
export function storageError(status, payload, { domain = 'sale' } = {}) {
  const code = payload && typeof payload === 'object' && typeof payload.code === 'string' ? payload.code : null;
  const message = payload && typeof payload === 'object' && typeof payload.message === 'string' && payload.message
    ? payload.message : null;
  if (code === '28000' || code === '42501') {
    return new SalesError(403, 'FORBIDDEN', 'Supabase rechazó la operación para esta identidad.');
  }
  if (code === 'P0001') {
    if (message?.startsWith('STOCK_INSUFICIENTE')) {
      return new SalesError(409, 'INSUFFICIENT_STOCK', message);
    }
    if (message?.startsWith('PRODUCTO_INACTIVO')) {
      return new SalesError(409, 'PRODUCT_ARCHIVED', 'Ese producto está archivado. Elegí otro producto del stock.');
    }
  }
  if (code === 'P0002') {
    return new SalesError(404, 'NOT_FOUND', domain === 'product'
      ? 'El producto ya no existe o se eliminó desde otro dispositivo.'
      : 'La venta ya no existe o se eliminó desde otro dispositivo.');
  }
  // A linked product row vanished: honest not-found for the referenced data.
  if (code === '23503') {
    return new SalesError(404, 'NOT_FOUND', 'El producto vinculado ya no existe.');
  }
  if (code === '40001') {
    return new SalesError(409, domain === 'product' ? 'PRODUCT_CONFLICT' : 'SALE_CONFLICT',
      domain === 'product'
        ? 'El producto cambió desde otro dispositivo. Volvé a abrirlo con los datos actualizados.'
        : 'La venta cambió desde otro dispositivo. Cancelá la edición y volvé a abrirla con los datos actualizados.');
  }
  if (code === '23505') {
    return new SalesError(409, domain === 'product' ? 'PRODUCT_CONFLICT' : 'ID_CONFLICT',
      domain === 'product'
        ? 'Ya existe un producto activo con ese nombre.'
        : 'Ese identificador ya corresponde a otra venta. No se guardaron cambios.');
  }
  if (code === '22023') {
    return new SalesError(400, 'INVALID_STOCK', 'El stock inicial no puede ser negativo.');
  }
  // The provider reports an expired/unusable token or a policy denial itself.
  if (status === 401) {
    return new SalesError(401, 'UNAUTHENTICATED', 'La sesión no es válida o venció. Iniciá sesión nuevamente.');
  }
  if (status === 403) {
    return new SalesError(403, 'FORBIDDEN', 'Supabase rechazó la operación para esta identidad.');
  }
  // Rate limiting and backend outages stay honest and are never retried here.
  if (status === 429 || status >= 500) {
    return new SalesError(503, 'STORAGE_UNAVAILABLE', 'No se pudo acceder a los datos. Reintentá en unos momentos.');
  }
  throw new Error(`Supabase devolvió una respuesta inesperada (${status}).`);
}

async function rpcCall(call, name, params, domain) {
  const { status, payload } = await call(`rpc/${name}`, { method: 'POST', body: params });
  if (status >= 400) throw storageError(status, payload, { domain });
  // Some PostgREST front ends answer an unhandled error with a JSON body on a
  // success status; treat a bare error shape as the failure it is.
  if (payload && !Array.isArray(payload) && typeof payload.code === 'string' && typeof payload.message === 'string') {
    const row = payload;
    if (!('id' in row) && !('name' in row) && !('archived' in row)) {
      throw storageError(status, payload, { domain });
    }
  }
  return payload;
}

async function select(call, path, domain) {
  const { status, payload } = await call(path, { method: 'GET' });
  if (status >= 400) throw storageError(status, payload, { domain });
  const rows = payload && typeof payload === 'object' && payload.message !== undefined ? null : payload;
  if (!Array.isArray(rows)) throw new Error('Supabase devolvió una lista inesperada.');
  return rows;
}

// ---------------------------------------------------------------------
// Sales API: RPC-only writes, table GETs, full-snapshot CAS everywhere.
// ---------------------------------------------------------------------

export function createSupabaseSalesApi({ env = process.env, accessToken, supabaseFetch = globalThis.fetch } = {}) {
  const configs = supabaseStoreConfig(env);
  const call = createRestAccess({ configs, accessToken, supabaseFetch });

  const notFoundError = () => new SalesError(404, 'NOT_FOUND', 'La venta ya no existe o se eliminó desde otro dispositivo.');

  async function selectById(id) {
    const rows = await select(call, `v2_sales?select=${SELECT_SALES}&id=eq.${encodeURIComponent(id)}`, 'sale');
    return rows.length ? toSale(rows[0]) : null;
  }

  return {
    async list(date) {
      const rows = await select(call, `v2_sales?select=${SELECT_SALES}&date=eq.${encodeURIComponent(date)}&order=row_seq.asc`, 'sale');
      return rows.map(toSale);
    },

    // Idempotent create with exactly one write attempt: the pre-check turns a
    // sequential exact replay into the {replayed: true} answer without a second
    // SQL write; an exact-replay race behind the pre-check is still answered
    // idempotently by the RPC itself (same row, no second stock movement).
    async append(sale) {
      const current = await selectById(sale.id);
      if (current) {
        if (!sameSale(current, sale)) {
          throw new SalesError(409, 'ID_CONFLICT', 'Ese identificador ya corresponde a otra venta. No se guardaron cambios.');
        }
        return { sale: current, replayed: true };
      }
      const payload = await rpcCall(call, sale.stand ? 'v2_create_sale_at_stand' : 'v2_create_sale', {
        p_sale_id: sale.id,
        p_date: sale.date,
        p_product: sale.product,
        p_payment: sale.payment,
        p_amount_cents: sale.amountCents,
        p_product_id: sale.productId,
        p_quantity: sale.quantity,
        p_allow_negative: sale.allowNegative ?? false,
        ...(sale.stand ? { p_stand: sale.stand } : {}),
      }, 'sale');
      return { sale: toSale(rowOf(payload, 'La creación de la venta devolvió una fila inesperada.')), replayed: false };
    },

    // Edits never rewrite blindly: the previous full snapshot (including
    // productId and quantity) is compare-and-swapped inside the SQL
    // transaction, and the stock reversal+consumption is audited there too.
    async update(sale, previous) {
      const current = await selectById(sale.id);
      if (!current) throw notFoundError();
      if (sameSale(current, sale)) return current;
      if (!sameSale(current, previous)) {
        throw new SalesError(409, 'SALE_CONFLICT', 'La venta cambió desde otro dispositivo. Cancelá la edición y volvé a abrirla con los datos actualizados.');
      }
      if (sale.stand !== undefined || previous.stand !== undefined) {
        const next = { ...sale, stand: sale.stand === undefined ? current.stand ?? null : sale.stand };
        const payload = await rpcCall(call, 'v2_edit_sale_at_stand', { p_sale: next, p_previous: previous }, 'sale');
        return toSale(rowOf(payload, 'La edición de la venta devolvió una fila inesperada.'));
      }
      const payload = await rpcCall(call, 'v2_edit_sale', {
        p_sale_id: sale.id,
        p_prev_date: previous.date,
        p_prev_product: previous.product,
        p_prev_payment: previous.payment,
        p_prev_amount_cents: previous.amountCents,
        p_prev_product_id: previous.productId,
        p_prev_quantity: previous.quantity,
        p_date: sale.date,
        p_product: sale.product,
        p_payment: sale.payment,
        p_amount_cents: sale.amountCents,
        p_product_id: sale.productId,
        p_quantity: sale.quantity,
        p_allow_negative: sale.allowNegative ?? false,
      }, 'sale');
      return toSale(rowOf(payload, 'La edición de la venta devolvió una fila inesperada.'));
    },

    // Deletes carry the previous full snapshot: without it the SQL never
    // runs, so a stale delete can never subtract stock twice or drop a row it
    // did not really observe.
    async remove(id, previous) {
      if (previous.stand !== undefined) {
        const payload = await rpcCall(call, 'v2_delete_sale_at_stand', { p_previous: previous }, 'sale');
        return toSale(rowOf(payload, 'La eliminación de la venta devolvió una fila inesperada.'));
      }
      const payload = await rpcCall(call, 'v2_delete_sale', {
        p_sale_id: id,
        p_prev_date: previous.date,
        p_prev_product: previous.product,
        p_prev_payment: previous.payment,
        p_prev_amount_cents: previous.amountCents,
        p_prev_product_id: previous.productId,
        p_prev_quantity: previous.quantity,
      }, 'sale');
      return toSale(rowOf(payload, 'La eliminación de la venta devolvió una fila inesperada.'));
    },
  };
}
