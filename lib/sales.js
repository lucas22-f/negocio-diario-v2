export class SalesError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function validateDate(value) {
  if (typeof value !== 'string' || !/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(value)
      || value.startsWith('0000') || Number.isNaN(Date.parse(`${value}T00:00:00Z`))
      || new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value) {
    throw new SalesError(400, 'INVALID_DATE', 'Elegí una fecha válida (AAAA-MM-DD).');
  }
  return value;
}

export function validateSaleId(data) {
  const value = data && typeof data === 'object' && !Array.isArray(data) ? data : {};
  if (typeof value.id !== 'string' || !value.id.trim()) {
    throw new SalesError(400, 'INVALID_ID', 'El identificador de la venta no es válido.');
  }
  return value.id.trim();
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// T3 (odd/tasks/stock-v2.md): a sale may link one stock product. The link is
// optional and explicit; a sale without productId (free text) always carries
// quantity 1, exactly as the no-product contract always behaved.
export function validateProductId(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || !UUID_RE.test(value.trim())) {
    throw new SalesError(400, 'INVALID_PRODUCT_ID', 'Elegí un producto del stock válido o dejá el campo vacío.');
  }
  return value.trim().toLowerCase();
}

function validateQuantity(value, productId) {
  const quantity = value.quantity === undefined ? 1 : value.quantity;
  if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > 1000000) {
    throw new SalesError(400, 'INVALID_QUANTITY', 'La cantidad debe ser un entero de 1 a 1000000.');
  }
  if (productId === null && quantity !== 1) {
    throw new SalesError(400, 'INVALID_QUANTITY', 'La cantidad mayor a 1 requiere un producto del stock.');
  }
  return quantity;
}

// Touching stock below zero is a deliberate business decision: the boolean
// confirmation must arrive as a real JSON boolean, never a truthy string.
function validateAllowNegative(value) {
  const allow = value.allowNegative;
  if (allow === undefined) return false;
  if (typeof allow !== 'boolean') {
    throw new SalesError(400, 'INVALID_ALLOW_NEGATIVE', 'El descuento fuera de stock debe confirmarse en forma explícita.');
  }
  return allow;
}

function validateSaleProductText(text) {
  if (typeof text !== 'string' || !text.trim()
      || text.trim().length > 160 || text.includes('\0')) {
    throw new SalesError(400, 'INVALID_PRODUCT', 'Ingresá un producto de 1 a 160 caracteres.');
  }
  return text.trim();
}

export function validateSale(data) {
  const value = data && typeof data === 'object' && !Array.isArray(data) ? data : {};
  const date = validateDate(value.date);
  const product = validateSaleProductText(value.product);
  if (!['efectivo', 'transferencia'].includes(value.payment)) {
    throw new SalesError(400, 'INVALID_PAYMENT', 'Elegí efectivo o transferencia.');
  }
  // Strings only: decimal separators, never floating-point money or thousands.
  if (typeof value.amount !== 'string' || !/^[0-9]{1,9}([,.][0-9]{1,2})?$/.test(value.amount)) {
    throw invalidAmount();
  }
  const [pesos, fraction = ''] = value.amount.split(/[,.]/);
  const amountCents = Number(pesos) * 100 + Number(fraction.padEnd(2, '0'));
  if (amountCents < 1 || amountCents > 99999999999) throw invalidAmount();
  if (typeof value.requestId !== 'string'
      || !UUID_RE.test(value.requestId)) {
    throw new SalesError(400, 'INVALID_ID', 'El identificador de la venta no es válido.');
  }
  const productId = validateProductId(value.productId);
  const quantity = validateQuantity(value, productId);
  const allowNegative = validateAllowNegative(value);
  if (value.stand !== undefined && value.stand !== null && !['fixed', 'mobile'].includes(value.stand)) {
    throw new SalesError(400, 'INVALID_STAND', 'Elegí Puesto fijo o Móvil.');
  }
  // Daily stock opt-in (T2 of odd/tasks/daily-stand-stock.md): an additive
  // explicit boolean routes the sale into the per-day/per-stand channel. When
  // it is a real true, a stand is required; when the key is absent the exact
  // legacy global-stock contract applies untouched. Like allowNegative, the
  // flag is never a truthy string.
  if (value.dailyStock !== undefined && typeof value.dailyStock !== 'boolean') {
    throw new SalesError(400, 'INVALID_DAILY_STOCK', 'El canal de venta diaria debe confirmarse en forma explícita.');
  }
  if (value.dailyStock === true && !['fixed', 'mobile'].includes(value.stand)) {
    throw new SalesError(400, 'INVALID_STAND', 'Elegí Puesto fijo o Móvil.');
  }
  return {
    id: value.requestId.toLowerCase(), date, product,
    payment: value.payment, amountCents, productId, quantity, allowNegative,
    ...(value.stand === undefined ? {} : { stand: value.stand }),
    // T4 (odd/tasks/daily-stand-stock.md): an explicit false stays in the
    // parsed sale — it is a caller decision, so the storage layer can refuse
    // it as a channel contradiction on a daily row instead of silently
    // dropping it (which would make the contradiction look like metadata
    // omission). Absent stays absent: the legacy contract is untouched.
    ...(value.dailyStock === undefined ? {} : { dailyStock: value.dailyStock }),
  };
}

// T2 daily sale canonical row (the exact shape GET returns for a tagged
// sale): { id, date, product, payment, amountCents, productId, quantity,
// stand, dailyStock:true } — integer cents instead of the editable decimal
// string, and the row id instead of a requestId alias. The daily edit/delete
// JSON never uses requestId/amount. `dailyStock` and `allowNegative` are
// optional echoes that must be real booleans when present.
export function validateDailySaleRow(data) {
  const value = data && typeof data === 'object' && !Array.isArray(data) ? data : {};
  if (typeof value.id !== 'string' || !UUID_RE.test(value.id.trim())) {
    throw new SalesError(400, 'INVALID_ID', 'El identificador de la venta no es válido.');
  }
  const date = validateDate(value.date);
  const product = validateSaleProductText(value.product);
  if (!['efectivo', 'transferencia'].includes(value.payment)) {
    throw new SalesError(400, 'INVALID_PAYMENT', 'Elegí efectivo o transferencia.');
  }
  if (!Number.isSafeInteger(value.amountCents) || value.amountCents < 1 || value.amountCents > 99999999999) {
    throw new SalesError(400, 'INVALID_AMOUNT', 'El monto de la venta no es válido.');
  }
  const productId = validateProductId(value.productId);
  const quantity = validateQuantity(value, productId);
  if (!['fixed', 'mobile'].includes(value.stand)) {
    throw new SalesError(400, 'INVALID_STAND', 'Elegí Puesto fijo o Móvil.');
  }
  if (value.dailyStock !== undefined && typeof value.dailyStock !== 'boolean') {
    throw new SalesError(400, 'INVALID_DAILY_STOCK', 'El canal de venta diaria debe confirmarse en forma explícita.');
  }
  const allowNegative = validateAllowNegative(value);
  return {
    id: value.id.trim().toLowerCase(), date, product, payment: value.payment,
    amountCents: value.amountCents, productId, quantity,
    stand: value.stand, allowNegative,
    // Same rule as validateSale: an explicit false is kept as a caller
    // decision (rejectable channel contradiction), only absence normalizes.
    ...(value.dailyStock === undefined ? {} : { dailyStock: value.dailyStock }),
  };
}

function invalidAmount() {
  return new SalesError(400, 'INVALID_AMOUNT', 'Ingresá un monto mayor a 0 y hasta 999999999,99, con hasta 2 decimales y sin miles.');
}

// The sale identity for replay/compare-and-swap now includes the stock link:
// the same content under the same id means the product reference and quantity
// too, so a replay can never reuse a stale stock decision.
// The daily channel tag participates in the identity so an exact replay can
// never cross channels: a legacy request replaying a daily sale id (or the
// reverse) compares unequal here and is answered as a channel conflict by the
// storage layer, never as a replayed row.
export function sameSale(first, second) {
  return ['id', 'date', 'product', 'payment', 'amountCents', 'productId', 'quantity']
    .every(key => first[key] === second[key])
    && (second.stand === undefined || (first.stand ?? null) === second.stand)
    && (first.dailyStock ?? false) === (second.dailyStock ?? false);
}

// T2 (odd/tasks/daily-stand-stock.md): the STORED row owns the channel. In
// edit/no-op comparisons a snapshot that OMITS the daily tag is missing
// metadata, not a caller decision: it adopts the trusted channel, so editing
// the current daily row with a pre-tag UI snapshot never false-conflicts.
// A tag the caller explicitly sent keeps its value: an explicit contradiction
// can never convert the channel — sameSale answers unequal (or the stored row
// keeps routing), exactly as before. Create/replay identity (sameSale inside
// append) is never normalized through this helper; it stays strict.
export function normalizeSaleChannel(sale, trustedDaily) {
  if (!sale || sale.dailyStock !== undefined) return sale;
  return trustedDaily ? { ...sale, dailyStock: true } : sale;
}
