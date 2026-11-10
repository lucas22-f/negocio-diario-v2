import { SalesError } from './sales.js';
import { supabaseStoreConfig, createRestAccess, rowOf, storageError } from './supabase.js';

// v2 T3 of odd/tasks/stock-v2.md (S1,S3-S5): product CRUD for the stock
// screen. Exactly like sales: all writes go through the transactional
// v2_create_product / v2_edit_product / v2_archive_product RPCs, GETs read the
// v2_products table, no direct INSERT/PATCH/DELETE is ever attempted, and no
// product is ever hard-deleted (archive flips the flag and keeps history).
// The catalogue list returns every product — archived ones included and
// explicitly flagged — so the sale screen can keep matching names that
// already exist in stock.

const SELECT_PRODUCTS = 'id,name,price_cents,stock,archived';

// snake_case database row -> public camelCase product.
export function toProduct(row) {
  const badProduct = () => new Error('Supabase respondió una fila de productos inesperada.');
  if (!row || typeof row !== 'object' || Array.isArray(row)
      || typeof row.id !== 'string' || !row.id || typeof row.name !== 'string'
      || typeof row.archived !== 'boolean') {
    throw badProduct();
  }
  const priceCents = row.price_cents === undefined || row.price_cents === null
    ? null : Number(row.price_cents);
  if (priceCents !== null && (!Number.isSafeInteger(priceCents) || priceCents < 1 || priceCents > 99999999999)) {
    throw badProduct();
  }
  const stock = Number(row.stock);
  if (!Number.isSafeInteger(stock) || stock < -1000000000 || stock > 1000000000) throw badProduct();
  return { id: row.id, name: row.name, priceCents, stock, archived: row.archived };
}

const NAME_ERROR = new SalesError(400, 'INVALID_NAME', 'Ingresá un producto de 1 a 160 caracteres.');

function validateName(value) {
  if (typeof value !== 'string' || !value.trim()
      || value.trim().length > 160 || value.includes('\0')) {
    throw NAME_ERROR;
  }
  return value.trim();
}

// The editable price uses the same amount-style decimal rule as sales
// (`price` as a string, max 2 decimals, comma or dot accepted) and is
// converted to integer cents; an absent/null price stores null.
export function validatePriceCents(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || !/^[0-9]{1,9}([,.][0-9]{1,2})?$/.test(value)) {
    throw new SalesError(400, 'INVALID_PRICE', 'Ingresá un precio mayor a 0 y hasta 999999999,99, con hasta 2 decimales y sin miles (o dejalo vacío).');
  }
  const [pesos, fraction = ''] = value.split(/[,.]/);
  return Number(pesos) * 100 + Number(fraction.padEnd(2, '0'));
}

// Bounded integer stock; ±1 000 000 000 matches the SQL column constraint.
// A negative stock in a create/edit request reaches the SQL for its explicit
// allowNegative decision (create always rejects it as invalid stock).
export function validateStockNumber(value, { code = 'INVALID_STOCK', message = 'Ingresá un stock entero entre -1000000000 y 1000000000.' } = {}) {
  if (!Number.isSafeInteger(value) || value < -1000000000 || value > 1000000000) {
    throw new SalesError(400, code, message);
  }
  return value;
}

export function validateProductIdValue(value) {
  if (typeof value !== 'string'
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value.trim())) {
    throw new SalesError(400, 'INVALID_ID', 'El identificador del producto no es válido.');
  }
  return value.trim().toLowerCase();
}

export function validateAllowNegative(value) {
  if (value === undefined) return false;
  if (typeof value !== 'boolean') {
    throw new SalesError(400, 'INVALID_ALLOW_NEGATIVE', 'El stock negativo debe confirmarse en forma explícita.');
  }
  return value;
}

// The editable payload of a create/edit request {name, price?, stock?,
// allowNegative?}; `price` is an amount-style decimal string (see above) and
// `stock` defaults to 0.
export function validateProductPayload(data) {
  const value = data && typeof data === 'object' && !Array.isArray(data) ? data : {};
  return {
    name: validateName(value.name),
    priceCents: validatePriceCents(value.price),
    stock: validateStockNumber(value.stock === undefined ? 0 : value.stock),
    allowNegative: validateAllowNegative(value.allowNegative),
  };
}

// The previous snapshot the client must repeat for CAS: the exact canonical
// product row {name, priceCents, stock} as the GET delivered it. priceCents
// may be (and defaults to) null; the stock is a compare-and-swap guard, so
// any drift answers 409 PRODUCT_CONFLICT instead of a blind rewrite.
export function validateProductSnapshot(data) {
  const value = data && typeof data === 'object' && !Array.isArray(data) ? data : null;
  if (!value) {
    throw new SalesError(400, 'INVALID_ID', 'Falta el producto previo para comparar cambios.');
  }
  return {
    name: validateName(value.name),
    priceCents: value.priceCents === undefined || value.priceCents === null
      ? null : validateStockNumber(value.priceCents, { code: 'INVALID_PRICE', message: 'El precio previo debe ser null o un entero de centavos.' }),
    stock: validateStockNumber(value.stock),
  };
}

export function createSupabaseProductsApi({ env = process.env, accessToken, supabaseFetch = globalThis.fetch } = {}) {
  const configs = supabaseStoreConfig(env);
  const call = createRestAccess({ configs, accessToken, supabaseFetch });

  async function rpc(name, params) {
    const { status, payload } = await call(`rpc/${name}`, { method: 'POST', body: params });
    if (status >= 400) throw storageError(status, payload, { domain: 'product' });
    if (payload && !Array.isArray(payload) && typeof payload.code === 'string' && typeof payload.message === 'string') {
      const row = payload;
      if (!('id' in row) && !('name' in row)) throw storageError(status, payload, { domain: 'product' });
    }
    return payload;
  }

  return {
    async list() {
      const { status, payload } = await call(`v2_products?select=${SELECT_PRODUCTS}&order=name.asc`, { method: 'GET' });
      if (status >= 400) throw storageError(status, payload, { domain: 'product' });
      if (!Array.isArray(payload)) throw new Error('Supabase devolvió una lista de productos inesperada.');
      return payload.map(toProduct);
    },

    async create(product) {
      return toProduct(rowOf(await rpc('v2_create_product', {
        p_name: product.name,
        p_price_cents: product.priceCents,
        p_stock: product.stock,
      }), 'La creación del producto devolvió una fila inesperada.'));
    },

    // Full-snapshot CAS inside the SQL transaction; a stock change is audited
    // there, and crossing zero downwards requires the explicit acknowledgement.
    async update(id, previous, next) {
      return toProduct(rowOf(await rpc('v2_edit_product', {
        p_product_id: id,
        p_prev_name: previous.name,
        p_prev_price_cents: previous.priceCents,
        p_prev_stock: previous.stock,
        p_name: next.name,
        p_price_cents: next.priceCents,
        p_stock: next.stock,
        p_allow_negative: next.allowNegative ?? false,
      }), 'La edición del producto devolvió una fila inesperada.'));
    },

    // Archive (never a hard delete): CAS on the stock the client observed.
    async archive(id, previousStock) {
      return toProduct(rowOf(await rpc('v2_archive_product', {
        p_product_id: id,
        p_prev_stock: previousStock,
        p_archived: true,
      }), 'El archivo del producto devolvió una fila inesperada.'));
    },
  };
}
