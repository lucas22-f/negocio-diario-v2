import { SalesError, validateDate, validateProductId } from './sales.js';
import { supabaseStoreConfig, createRestAccess, rpcCall } from './supabase.js';

// T2 of odd/tasks/daily-stand-stock.md (S1-S5): the per-day/per-stand stock
// ledger. Exactly like sales and products: writes go only through the
// transactional v2_*_daily_stock RPCs (documented in supabase/README.md,
// "Daily RPC contract"), reads go through v2_read_daily_stock (both stands in
// one call), no direct table write is ever attempted, and the daily channel
// NEVER consults the global product stock — neither for validation nor for
// display. Global stock remains the non-authoritative legacy mirror.

const STANDS = ['fixed', 'mobile'];

// snake_case daily read row -> public camelCase figure row. Response payloads
// never trust untyped rows (the same rule as toSale/toProduct).
export function toDailyRow(row) {
  const badRow = () => new Error('Supabase respondió una fila de stock diario inesperada.');
  if (!row || typeof row !== 'object' || Array.isArray(row)
      || typeof row.product_id !== 'string' || !row.product_id
      || typeof row.product !== 'string'
      || !STANDS.includes(row.stand)) {
    throw badRow();
  }
  const priceCents = row.price_cents === undefined || row.price_cents === null
    ? null : Number(row.price_cents);
  if (priceCents !== null && !Number.isSafeInteger(priceCents)) throw badRow();
  const figures = {};
  for (const key of ['initial_load', 'loaded', 'sold', 'available']) {
    const value = Number(row[key]);
    if (!Number.isSafeInteger(value)) throw badRow();
    figures[key] = value;
  }
  return {
    productId: row.product_id,
    product: row.product,
    priceCents,
    stand: row.stand,
    initialLoad: figures.initial_load,
    loaded: figures.loaded,
    sold: figures.sold,
    available: figures.available,
  };
}

// The POST action envelope {action, date, stand, items?, allowNegative?}.
// Validation is strict and coercion-free: quantities and observed snapshots
// must be real JSON numbers (integers in range), never numeric strings, and
// the negative confirmation must be a real boolean. `copy` carries no items:
// copying anything else is refused, never guessed.
export function validateDailyAction(data) {
  const value = data && typeof data === 'object' && !Array.isArray(data) ? data : {};
  if (!['load', 'replenish', 'copy'].includes(value.action)) {
    throw new SalesError(400, 'INVALID_ACTION', 'Elegí una acción de stock diario válida (load, replenish o copy).');
  }
  const date = validateDate(value.date);
  if (!STANDS.includes(value.stand)) {
    throw new SalesError(400, 'INVALID_STAND', 'Elegí Puesto fijo o Móvil.');
  }
  if (value.allowNegative !== undefined && typeof value.allowNegative !== 'boolean') {
    throw new SalesError(400, 'INVALID_ALLOW_NEGATIVE', 'La carga fuera de stock debe confirmarse en forma explícita.');
  }
  if (value.action === 'copy') {
    if (value.items !== undefined) {
      throw new SalesError(400, 'INVALID_ITEMS', 'La copia no lleva lista de productos.');
    }
    return { action: 'copy', date, stand: value.stand };
  }
  const isLoad = value.action === 'load';
  const quantityKey = isLoad ? 'initial' : 'replenished';
  const prevKey = isLoad ? 'prevInitial' : 'prevReplenished';
  const rangeMessage = isLoad
    ? 'La carga inicial debe estar entre 0 y 1000000.'
    : 'El agregado del día debe estar entre 0 y 1000000.';
  if (!Array.isArray(value.items) || value.items.length === 0) {
    throw new SalesError(400, 'INVALID_ITEMS', 'La lista de productos no puede estar vacía.');
  }
  const seen = new Set();
  const items = value.items.map(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new SalesError(400, 'INVALID_ITEMS', 'Cada carga necesita un producto y una cantidad.');
    }
    if (item.productId === undefined || item.productId === null) {
      throw new SalesError(400, 'INVALID_ITEMS', 'Cada carga necesita un producto.');
    }
    const productId = validateProductId(item.productId);
    const quantity = item[quantityKey];
    if (!Number.isSafeInteger(quantity) || quantity < 0 || quantity > 1000000) {
      throw new SalesError(400, 'INVALID_ITEMS', rangeMessage);
    }
    // An absent observed value means "I saw nothing yet" and is sent as an
    // explicit JSON null (the SQL contract compares through the same null).
    const prev = item[prevKey];
    if (prev !== undefined && prev !== null
        && (!Number.isSafeInteger(prev) || prev < 0 || prev > 1000000)) {
      throw new SalesError(400, 'INVALID_ITEMS',
        isLoad ? 'La carga observada no es válida.' : 'El agregado observado no es válido.');
    }
    if (seen.has(productId)) {
      throw new SalesError(400, 'INVALID_ITEMS', 'La lista tiene productos repetidos.');
    }
    seen.add(productId);
    return {
      productId,
      [quantityKey]: quantity,
      [prevKey]: prev === undefined ? null : prev,
    };
  });
  return {
    action: value.action, date, stand: value.stand, items,
    allowNegative: value.allowNegative ?? false,
  };
}

const appliedOf = payload => {
  const applied = Number(payload);
  if (!Number.isSafeInteger(applied) || applied < 0) {
    throw new Error('Supabase devolvió un conteo de carga inesperado.');
  }
  return applied;
};

const readRowsOf = async (call, name, params) => {
  const payload = await rpcCall(call, name, params, 'daily-stock');
  if (!Array.isArray(payload)) throw new Error('Supabase devolvió una lista de stock diario inesperada.');
  return payload;
};

export function createSupabaseStockDaysApi({ env = process.env, accessToken, supabaseFetch = globalThis.fetch } = {}) {
  const configs = supabaseStoreConfig(env);
  const call = createRestAccess({ configs, accessToken, supabaseFetch });

  return {
    // One read for BOTH stands (the SQL returns one row per product/stand);
    // T3 filters by stand client-side. An unconfigured day returns explicit
    // zeros — absence of rows is the zero default, never a fabricated load.
    async read(date) {
      return (await readRowsOf(call, 'v2_read_daily_stock', { p_date: date })).map(toDailyRow);
    },

    // Defines/rewrites the day's initial load with the per-item observed
    // compare-and-swap; the whole call is all-or-none. p_items travels as a
    // RAW JSON array: a hosted PostgREST jsonb parameter keeps the wire JSON
    // type, so pre-stringifying here would arrive as a jsonb STRING scalar
    // and be rejected by the SQL instead of becoming the item list.
    async load(date, stand, items, allowNegative) {
      return appliedOf(await rpcCall(call, 'v2_load_daily_stock', {
        p_date: date, p_stand: stand, p_items: items, p_allow_negative: allowNegative,
      }, 'daily-stock'));
    },

    // Sets the day's NEW cumulative added total (never a delta); the initial
    // load is never rewritten here. p_items travels as a raw array (see load).
    async replenish(date, stand, items, allowNegative) {
      return appliedOf(await rpcCall(call, 'v2_replenish_daily_stock', {
        p_date: date, p_stand: stand, p_items: items, p_allow_negative: allowNegative,
      }, 'daily-stock'));
    },

    // Copies the PREVIOUS calendar day's initial quantities for the same
    // stand. A day that already has its own load is refused atomically
    // (409 DAY_ALREADY_LOADED); a previous day without load is a no-op (0).
    async copy(date, stand) {
      const rows = await readRowsOf(call, 'v2_copy_daily_stock', { p_date: date, p_stand: stand });
      return rows.length;
    },
  };
}
