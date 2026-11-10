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

export function validateSale(data) {
  const value = data && typeof data === 'object' && !Array.isArray(data) ? data : {};
  const date = validateDate(value.date);
  if (typeof value.product !== 'string' || !value.product.trim()
      || value.product.trim().length > 160 || value.product.includes('\0')) {
    throw new SalesError(400, 'INVALID_PRODUCT', 'Ingresá un producto de 1 a 160 caracteres.');
  }
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
  return {
    id: value.requestId.toLowerCase(), date, product: value.product.trim(),
    payment: value.payment, amountCents, productId, quantity, allowNegative,
    ...(value.stand === undefined ? {} : { stand: value.stand }),
  };
}

function invalidAmount() {
  return new SalesError(400, 'INVALID_AMOUNT', 'Ingresá un monto mayor a 0 y hasta 999999999,99, con hasta 2 decimales y sin miles.');
}

// The sale identity for replay/compare-and-swap now includes the stock link:
// the same content under the same id means the product reference and quantity
// too, so a replay can never reuse a stale stock decision.
export function sameSale(first, second) {
  return ['id', 'date', 'product', 'payment', 'amountCents', 'productId', 'quantity']
    .every(key => first[key] === second[key])
    && (second.stand === undefined || (first.stand ?? null) === second.stand);
}
