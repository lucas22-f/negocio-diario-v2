const form = document.getElementById('sale-form');
const dateInput = document.getElementById('sale-date');
const product = document.getElementById('product');
const listbox = document.getElementById('product-listbox');
const quantity = document.getElementById('quantity');
const negativeConfirm = document.getElementById('negative-confirm');
const amount = document.getElementById('amount');
const listDate = document.getElementById('list-date');
const save = document.getElementById('save');
const cancelEdit = document.getElementById('cancel-edit');
const entryTitle = document.getElementById('entry-title');
const syncStatus = document.getElementById('sync-status');
const rows = document.getElementById('sales');
const dailyTotal = document.getElementById('daily-total');
const dailyTotalAmount = document.getElementById('daily-total-amount');
dailyTotal.hidden = true;
const table = document.getElementById('ledger-table');
const storageStatus = document.getElementById('storage-status');
const listStatus = document.getElementById('list-status');
const saveStatus = document.getElementById('save-status');
const saveFeedback = document.getElementById('save-feedback');
const saveSuccessIcon = document.getElementById('save-success-icon');
saveSuccessIcon.hidden = true;
const workspace = document.getElementById('workspace');
const loginSection = document.getElementById('login-section');
const loginForm = document.getElementById('login-form');
const loginEmail = document.getElementById('login-email');
const loginPassword = document.getElementById('login-password');
const loginButton = document.getElementById('login-button');
const loginStatus = document.getElementById('login-status');
const logoutButton = document.getElementById('logout');
const menuButton = document.getElementById('menu-button');
const appMenu = document.getElementById('app-menu');
const menuSales = document.getElementById('menu-sales');
const menuStock = document.getElementById('menu-stock');
const stockPanel = document.getElementById('stock-panel');
const stockForm = document.getElementById('stock-form');
const stockName = document.getElementById('stock-name');
const stockPrice = document.getElementById('stock-price');
const stockStock = document.getElementById('stock-stock');
const stockButton = document.getElementById('stock-button');
const stockCancel = document.getElementById('stock-cancel');
const stockStatus = document.getElementById('stock-status');
const stockTable = document.getElementById('stock-table');
const productRows = document.getElementById('products');
const stockNegativeConfirm = document.getElementById('stock-negative-confirm');
const today = new Date();
const localDate = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
dateInput.value = listDate.value = localDate;
let saving = false;
let deleting = false;
let editing = null;
let savedDraft = null;
let requestId = null;
let cancelConfirm = null;
let readNotice = null;
let rowsDate = localDate;
let read = null;
let queuedRead = false;
let loggingIn = false;
let loggingOut = false;
let timer = null;
const readTimeout = 12000;
// T4 (S1): the stock screen shares this same quiet-connection discipline.
let screenName = 'sales';
let catalogue = null; // every product row (archived included), latest observed
let selectedProduct = null; // the product linked by selection in a new draft
let suggestionItems = [];
let suggestionIndex = -1;
let suggestionOpen = false;
let stockLoading = false;
let stockSaving = false;
let stockDeleting = false;
let editingProduct = null; // { id, name, priceCents, stock } observed snapshot
let savedProductDraft = null;
let productConfirm = null;
let pendingNegative = null; // sale draft awaiting an explicit allowance
let pendingNegativeProduct = null; // product draft awaiting the same

function message(element, text, failed = false) {
  if (element === saveStatus) {
    saveSuccessIcon.hidden = true;
    saveFeedback.dataset.success = 'false';
  }
  element.textContent = text;
  element.dataset.error = String(failed);
}

// An authenticated read is the badge's own evidence; no extra session request
// is made and no backend name, mode or session sentence decorates the screen.
// The gate change also re-draws the shared indicator: it must never surface
// business traffic over the login screen.
function showStorage() {
  logoutButton.hidden = false;
  menuButton.hidden = false;
}

// Anonymous system: the business screen is confidential, so only the login
// stays visible; reason (when present) explains why sign-in is needed again.
function enterLogin(reason) {
  queuedRead = false;
  readNotice = null;
  if (cancelConfirm) cancelConfirm();
  if (productConfirm) productConfirm();
  if (editingProduct) finishProductEdit();
  hideNegative();
  hideProductNegative();
  closeSuggestions();
  closeMenu(false);
  stockPanel.hidden = true;
  workspace.hidden = true;
  menuButton.hidden = true;
  logoutButton.hidden = true;
  loginSection.hidden = false;
  loginPassword.value = '';
  message(loginStatus, reason || '');
  syncBusyness(); // a still-pending call stays counted, never shown here
}

function enterAuthenticated() {
  logoutButton.hidden = false;
  menuButton.hidden = false;
  loginSection.hidden = true;
  loginPassword.value = '';
  message(loginStatus, '');
  // A previous session's refused-write notice never survives the relogin.
  message(saveStatus, '');
  // The chosen screen returns; the sales ledger is the default one.
  workspace.hidden = screenName !== 'sales';
  stockPanel.hidden = screenName !== 'stock';
  if (loginSection.hidden) syncBusyness(); // an awaited call may now be shown
}

// S7: the only network entrypoint of the app. Every Supabase-backed call is
// awaited here, so one counter over these calls is the honest 'Actualizando…'
// evidence: shown while at least one real call is in flight, cleared exactly
// when the last settles — success, HTTP error, network error, unreadable body
// or abort — and never carried by a static or timed label.
let pendingRequests = 0;

// One shared-shell indicator for every awaited request, Sales and Stock alike:
// it never decorates the anonymous login screen, keeps no idle copy and leaves
// the operation-specific messages (Guardando…, Eliminando…, Entrando…) alone.
function syncBusyness() {
  const visible = pendingRequests > 0 && loginSection.hidden;
  // aria-busy mirrors the live counter of awaited calls even when the gate
  // keeps the indicator hidden; the copy only exists while it is visible.
  syncStatus.setAttribute('aria-busy', String(pendingRequests > 0));
  syncStatus.hidden = !visible;
  syncStatus.textContent = visible ? 'Actualizando…' : '';
}

async function api(url, options) {
  pendingRequests++;
  syncBusyness();
  try {
    const response = await fetch(url, { cache: 'no-store', ...options });
    const data = await response.json();
    if (!response.ok) {
      const error = new Error(data.error?.message || 'No se pudo completar la operación. Reintentá.');
      error.status = response.status;
      error.code = data.error?.code ?? null;
      throw error;
    }
    return data;
  } finally {
    pendingRequests = Math.max(0, pendingRequests - 1);
    syncBusyness();
  }
}

function moneyText(cents) {
  // The plain input format: no thousands separators, always two decimals.
  return `${Math.floor(cents / 100)},${String(cents % 100).padStart(2, '0')}`;
}

function currentProductId() {
  return editing ? editing.link : (selectedProduct ? selectedProduct.id : null);
}

// A free-text sale never carries a quantity decision: the field parks at 1.
function applyQuantityEnabled(productId) {
  if (productId === null || productId === undefined) {
    quantity.disabled = true;
    quantity.value = '1';
  } else {
    quantity.disabled = false;
  }
}

function parseQuantity(raw) {
  const quantityValue = Number.parseInt(raw, 10);
  return Number.isSafeInteger(quantityValue) ? Math.min(Math.max(quantityValue, 1), 1000000) : 1;
}

function renderSales(sales) {
  const totalCents = sales.reduce((total, sale) => total + sale.amountCents, 0);
  dailyTotalAmount.textContent = formatMoney(totalCents);
  dailyTotal.hidden = false;
  rows.replaceChildren();
  cancelConfirm = null; // Rebuilt rows never inherit a pending confirm state.
  if (!sales.length) {
    const row = rows.insertRow();
    const cell = row.insertCell();
    cell.colSpan = 4;
    cell.className = 'empty';
    cell.textContent = 'Todavía no hay ventas para esta fecha. Agregá la primera.';
    return;
  }
  for (const sale of sales) {
    const row = rows.insertRow();
    const values = [sale.product, sale.payment === 'efectivo' ? 'Efectivo' : 'Transferencia', formatMoney(sale.amountCents)];
    ['product', 'payment', 'money'].forEach((name, index) => {
      const cell = row.insertCell();
      cell.className = name;
      cell.textContent = values[index];
    });
    mountActions(row.insertCell(), sale);
  }
}

// Destructive actions always require an explicit inline confirmation.
function mountActions(cell, sale) {
  cell.className = 'actions';
  cell.replaceChildren();
  cell.textContent = '';
  cell.dataset.confirm = 'false';
  const confirmState = () => {
    if (saving || deleting || editing) return;
    if (cancelConfirm) cancelConfirm();
    cell.replaceChildren();
    cell.textContent = '¿Borrar?';
    cell.dataset.confirm = 'true';
    const yes = document.createElement('button');
    yes.type = 'button';
    yes.className = 'row-delete';
    yes.textContent = '¡Sí, borrar!';
    const no = document.createElement('button');
    no.type = 'button';
    no.className = 'row-cancel';
    no.textContent = 'Cancelar';
    const leave = () => {
      cancelConfirm = null;
      mountActions(cell, sale);
    };
    cancelConfirm = leave;
    yes.addEventListener('click', () => deleteShownSale(sale));
    no.addEventListener('click', leave);
    cell.appendChild(yes);
    cell.appendChild(no);
  };
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'row-delete icon-button';
  button.setAttribute('aria-label', `Borrar ${sale.product}`);
  button.setAttribute('title', 'Borrar venta');
  button.appendChild(actionIcon('M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7'));
  button.addEventListener('click', confirmState);
  cell.appendChild(button);
  const edit = document.createElement('button');
  edit.type = 'button';
  edit.className = 'row-edit icon-button';
  edit.setAttribute('aria-label', `Modificar ${sale.product}`);
  edit.setAttribute('title', 'Modificar venta');
  edit.appendChild(actionIcon('m16 3 5 5M3 21l5-1L21 7a2 2 0 0 0-5-5L3 16Z'));
  edit.addEventListener('click', () => startEdit(sale));
  cell.appendChild(edit);
}

function actionIcon(path) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  const shape = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  shape.setAttribute('d', path);
  svg.appendChild(shape);
  return svg;
}

function saleFields(sale) {
  return {
    requestId: sale.id, date: sale.date, product: sale.product, payment: sale.payment,
    amount: moneyText(sale.amountCents),
    productId: sale.productId ?? null, quantity: sale.quantity ?? 1,
  };
}

function startEdit(sale) {
  if (saving || deleting) return;
  if (editing) {
    message(saveStatus, 'Guardá o cancelá la edición actual antes de modificar otra venta.', true);
    return;
  }
  if (cancelConfirm) cancelConfirm();
  hideNegative();
  const inputs = [...form.querySelectorAll('input')];
  savedDraft = inputs.map(input => ({ input, value: input.value, checked: input.checked }));
  const snapshot = saleFields(sale);
  // The previous row is frozen here: edits never relink the product by name,
  // they only move the working link if the user deliberately selects one.
  editing = { ...snapshot, previous: snapshot, link: snapshot.productId };
  for (const input of inputs) {
    if (input.type === 'radio') input.checked = input.value === editing.payment;
    else input.value = editing[input.name];
  }
  applyQuantityEnabled(editing.link);
  if (editing.link !== null) quantity.value = String(editing.quantity);
  entryTitle.textContent = 'Modificar venta';
  save.textContent = 'Guardar cambios';
  cancelEdit.hidden = false;
  message(saveStatus, 'Estás modificando una venta. Podés cambiar todos sus campos.');
  product.focus();
}

function finishEdit() {
  editing = null;
  for (const field of savedDraft || []) {
    field.input.value = field.value;
    field.input.checked = field.checked;
  }
  savedDraft = null;
  applyQuantityEnabled(null);
  entryTitle.textContent = 'Agregar venta';
  save.textContent = 'Guardar venta';
  cancelEdit.hidden = true;
}

cancelEdit.addEventListener('click', () => {
  if (saving || deleting) return;
  finishEdit();
  hideNegative();
  message(saveStatus, 'Edición cancelada.');
  product.focus();
});

// The refused draft is only allowed to become a deliberate negative-stock sale
// through this in-app confirmation, which voids itself on any later edit.
function hideNegative() {
  pendingNegative = null;
  negativeConfirm.hidden = true;
}

negativeConfirm.addEventListener('click', () => {
  if (saving || deleting || !pendingNegative) return;
  const retained = pendingNegative;
  hideNegative();
  const now = buildSalePayload();
  const sameDraft = ['requestId', 'date', 'product', 'payment', 'amount', 'productId', 'quantity']
    .every(key => String(now[key]) === String(retained[key]));
  if (sameDraft) submitSale(retained, true); // any later edit voids it instead
});

[dateInput, quantity, amount].forEach(element => element.addEventListener('input', () => {
  if (pendingNegative) hideNegative();
}));

// The stock screen follows the same request discipline as the sales ledger:
// one listing read at a time, one explicit confirm, no polling of any kind.
function closeMenu(refocus) {
  if (appMenu.hidden) return;
  appMenu.hidden = true;
  menuButton.setAttribute('aria-expanded', 'false');
  if (refocus) menuButton.focus();
}

function openMenu() {
  if (!appMenu.hidden) return;
  appMenu.hidden = false;
  menuButton.setAttribute('aria-expanded', 'true');
  menuSales.focus();
}

menuButton.addEventListener('click', () => {
  if (appMenu.hidden) openMenu();
  else closeMenu(true);
});

const onMenuEscape = event => {
  if (event.key === undefined || event.key === 'Escape') closeMenu(true);
};
menuButton.addEventListener('keydown', onMenuEscape);
appMenu.addEventListener('keydown', onMenuEscape);

function showScreen(next) {
  screenName = next;
  workspace.hidden = next !== 'sales';
  stockPanel.hidden = next !== 'stock';
  closeSuggestions();
  closeMenu(false);
  (next === 'stock' ? stockPanel : workspace).focus();
  if (next === 'stock') loadProducts(false);
}

menuSales.addEventListener('click', () => showScreen('sales'));
menuStock.addEventListener('click', () => showScreen('stock'));

function closeSuggestions() {
  suggestionOpen = false;
  suggestionIndex = -1;
  listbox.hidden = true;
  listbox.replaceChildren();
  product.setAttribute('aria-expanded', 'false');
  product.removeAttribute('aria-activedescendant');
}

function openSuggestions() {
  suggestionItems = (catalogue || []).filter(item => !item.archived
    && item.name.toLowerCase().includes(product.value.toLowerCase()));
  listbox.replaceChildren();
  suggestionIndex = -1;
  if (!suggestionItems.length) {
    closeSuggestions();
    return;
  }
  suggestionItems.forEach((item, index) => {
    const option = document.createElement('li');
    option.id = `product-option-${index}`;
    option.setAttribute('role', 'option');
    option.setAttribute('aria-selected', 'false');
    const name = document.createElement('span');
    name.className = 'option-name';
    name.textContent = item.name;
    const meta = document.createElement('span');
    meta.className = 'option-meta';
    meta.textContent = item.priceCents === null || item.priceCents === undefined
      ? ` · quedan ${item.stock} · sin precio`
      : ` · quedan ${item.stock} · ${formatMoney(item.priceCents)}`;
    option.appendChild(name);
    option.appendChild(meta);
    option.addEventListener('click', () => chooseProduct(item));
    listbox.appendChild(option);
  });
  listbox.hidden = false;
  product.setAttribute('aria-expanded', 'true');
  suggestionOpen = true;
}

function setHighlightedOption(index) {
  if (!suggestionOpen) return;
  suggestionIndex = Math.min(Math.max(index, 0), suggestionItems.length - 1);
  [...listbox.children].forEach((option, position) => {
    option.setAttribute('aria-selected', String(position === suggestionIndex));
  });
  const highlighted = listbox.children[suggestionIndex];
  if (highlighted) product.setAttribute('aria-activedescendant', highlighted.id);
}

// Selecting an existing active product sets the product id, parks quantity at
// its default of 1 and prefills the amount with quantity × optional price.
function chooseProduct(item) {
  if (editing) editing.link = item.id;
  else selectedProduct = item;
  product.value = item.name;
  applyQuantityEnabled(item.id);
  quantity.value = '1';
  if (item.priceCents !== null && item.priceCents !== undefined) {
    amount.value = moneyText(item.priceCents * parseQuantity(quantity.value));
  }
  closeSuggestions();
  hideNegative();
}

function clearSelection() {
  selectedProduct = null;
  if (editing) editing.link = null;
  applyQuantityEnabled(null);
}

product.addEventListener('input', () => {
  // Typing inside the name unlinks the product: free text stays safe at qty 1
  // and never relinks an archived or similarly named row silently.
  clearSelection();
  hideNegative();
  if (catalogue === null) loadProducts(true, () => openSuggestions());
  else openSuggestions();
});

product.addEventListener('keydown', event => {
  if (!suggestionOpen) return;
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault();
    setHighlightedOption(suggestionIndex + (event.key === 'ArrowDown' ? 1 : -1));
  } else if (event.key === 'Enter' && suggestionIndex >= 0) {
    event.preventDefault();
    chooseProduct(suggestionItems[suggestionIndex]);
  } else if (event.key === 'Escape') {
    closeSuggestions();
  }
});

async function loadProducts(silent, after) {
  if (stockLoading) return;
  stockLoading = true;
  if (!silent) {
    stockTable.setAttribute('aria-busy', 'true');
    message(stockStatus, 'Cargando productos…');
  }
  try {
    const data = await api('/api/products');
    catalogue = data.products;
    renderProducts();
    if (!silent) message(stockStatus, ''); // the fresh listing is its own result
    if (after) after();
  } catch (error) {
    if (error.status === 401) enterLogin(error.message);
    else if (!silent) {
      message(stockStatus, `No se pudieron cargar los productos. ${error.message || 'Reintentá en unos momentos.'}`, true);
    }
  } finally {
    stockLoading = false;
    if (!silent) stockTable.setAttribute('aria-busy', 'false');
  }
}

function renderProducts() {
  productRows.replaceChildren();
  productConfirm = null; // Rebuilt rows never inherit a pending confirm state.
  stockTable.setAttribute('aria-busy', 'false');
  if (!catalogue.length) {
    const row = productRows.insertRow();
    const cell = row.insertCell();
    cell.colSpan = 4;
    cell.className = 'empty';
    cell.textContent = 'Todavía no hay productos en el stock. Agregá el primero.';
    return;
  }
  for (const item of catalogue) {
    const row = productRows.insertRow();
    const productCell = row.insertCell();
    productCell.className = 'product';
    productCell.textContent = item.name;
    const priceCell = row.insertCell();
    priceCell.className = 'money';
    priceCell.textContent = item.priceCents === null || item.priceCents === undefined ? '—' : formatMoney(item.priceCents);
    const stockCell = row.insertCell();
    stockCell.className = 'stock-units';
    stockCell.textContent = String(item.stock);
    mountProductActions(row.insertCell(), item);
    if (item.archived) {
      row.className = 'archived-row';
      productCell.textContent = `${item.name} · Archivado`;
    }
  }
}

// Destructive archive moves require an explicit inline confirmation.
function mountProductActions(cell, item) {
  cell.className = 'actions';
  cell.replaceChildren();
  cell.textContent = '';
  cell.dataset.confirm = 'false';
  // Archived products are history: they render without any row action.
  if (item.archived) return;
  const confirmState = () => {
    if (stockSaving || stockDeleting || editingProduct) return;
    if (productConfirm) productConfirm();
    cell.replaceChildren();
    cell.textContent = '¿Archivar?';
    cell.dataset.confirm = 'true';
    const yes = document.createElement('button');
    yes.type = 'button';
    yes.className = 'row-delete';
    yes.textContent = '¡Sí, archivar!';
    const no = document.createElement('button');
    no.type = 'button';
    no.className = 'row-cancel';
    no.textContent = 'Cancelar';
    const leave = () => {
      productConfirm = null;
      mountProductActions(cell, item);
    };
    productConfirm = leave;
    yes.addEventListener('click', () => archiveProduct(item));
    no.addEventListener('click', leave);
    cell.appendChild(yes);
    cell.appendChild(no);
  };
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'row-delete icon-button';
  button.setAttribute('aria-label', `Archivar ${item.name}`);
  button.setAttribute('title', 'Archivar producto');
  button.appendChild(actionIcon('M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7'));
  button.addEventListener('click', confirmState);
  cell.appendChild(button);
  const edit = document.createElement('button');
  edit.type = 'button';
  edit.className = 'row-edit icon-button';
  edit.setAttribute('aria-label', `Modificar ${item.name}`);
  edit.setAttribute('title', 'Modificar producto');
  edit.appendChild(actionIcon('m16 3 5 5M3 21l5-1L21 7a2 2 0 0 0-5-5L3 16Z'));
  edit.addEventListener('click', () => startProductEdit(item));
  cell.appendChild(edit);
}

function startProductEdit(item) {
  if (stockSaving || stockDeleting) return;
  if (editingProduct) {
    message(stockStatus, 'Guardá o cancelá la edición actual antes de modificar otro producto.', true);
    return;
  }
  if (productConfirm) productConfirm();
  const inputs = [...stockForm.querySelectorAll('input')];
  savedProductDraft = inputs.map(input => ({ input, value: input.value }));
  editingProduct = { id: item.id, name: item.name, priceCents: item.priceCents ?? null, stock: item.stock };
  stockName.value = item.name;
  stockPrice.value = item.priceCents === null || item.priceCents === undefined ? '' : moneyText(item.priceCents);
  stockStock.value = String(item.stock);
  stockButton.textContent = 'Guardar cambios';
  stockCancel.hidden = false;
  hideProductNegative();
  message(stockStatus, 'Estás modificando un producto. No se reescribe el historial de ventas.');
  stockName.focus();
}

function finishProductEdit() {
  editingProduct = null;
  for (const field of savedProductDraft || []) field.input.value = field.value;
  savedProductDraft = null;
  stockButton.textContent = 'Guardar producto';
  stockCancel.hidden = true;
  hideProductNegative();
}

stockCancel.addEventListener('click', () => {
  if (stockSaving || stockDeleting) return;
  finishProductEdit();
  message(stockStatus, 'Edición cancelada.');
  stockName.focus();
});

function hideProductNegative() {
  pendingNegativeProduct = null;
  stockNegativeConfirm.hidden = true;
}

function buildProductPayload() {
  if (stockSaving || stockDeleting || !stockForm.reportValidity()) return null;
  const fields = new FormData(stockForm);
  const payload = { name: fields.get('name') };
  const price = fields.get('price');
  if (typeof price === 'string' && price.trim()) payload.price = price.trim();
  const stockValue = Number(fields.get('stock'));
  if (!Number.isSafeInteger(stockValue)) {
    message(stockStatus, 'Ingresá las unidades como número entero.', true);
    return null;
  }
  payload.stock = stockValue;
  if (editingProduct) {
    payload.id = editingProduct.id;
    payload.previous = { ...editingProduct };
  }
  return payload;
}

stockNegativeConfirm.addEventListener('click', () => {
  if (stockSaving || stockDeleting || !pendingNegativeProduct) {
    if (!stockSaving && !stockDeleting && pendingNegativeProduct) hideProductNegative();
    return;
  }
  const retained = pendingNegativeProduct;
  const now = buildProductPayload();
  if (!now
    || now.name !== retained.name || now.price !== retained.price || now.stock !== retained.stock
    || (now.previous ? JSON.stringify(now.previous) : null) !== JSON.stringify(retained.previous)) {
    hideProductNegative(); // a changed draft needs a fresh decision
    return;
  }
  hideProductNegative();
  submitProduct(retained, true);
});

stockForm.addEventListener('submit', event => {
  event.preventDefault();
  if (stockSaving || stockDeleting) return;
  const payload = buildProductPayload();
  if (payload) submitProduct(payload, false);
});

async function submitProduct(payload, isRetry) {
  stockSaving = true;
  hideProductNegative();
  const updating = Boolean(editingProduct);
  const body = isRetry ? { ...payload, allowNegative: true } : payload;
  stockButton.disabled = true;
  stockButton.setAttribute('aria-busy', 'true');
  stockButton.textContent = 'Guardando…';
  const inputs = [...stockForm.querySelectorAll('input')];
  inputs.forEach(input => { input.disabled = true; });
  message(stockStatus, 'Guardando…');
  let done = false;
  try {
    const data = await api('/api/products', {
      method: updating ? 'PUT' : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    done = true;
    if (updating) finishProductEdit();
    else {
      stockName.value = '';
      stockPrice.value = '';
      stockStock.value = '0';
    }
    message(stockStatus, updating ? 'Producto modificado.' : 'Producto guardado.');
  } catch (error) {
    if (error.status === 401) {
      message(stockStatus, '');
      enterLogin(error.message); // nothing was saved; the draft waits
    } else if (error.code === 'INSUFFICIENT_STOCK' && !isRetry) {
      // Going below zero only happens through the visible explicit confirm;
      // the same draft is retried unchanged with allowNegative true.
      pendingNegativeProduct = payload;
      stockNegativeConfirm.hidden = false;
      message(stockStatus, `${error.message} Confirmá para llevar el stock a negativo.`, true);
    } else {
      message(stockStatus, `${error.message || 'No pudimos guardar el producto.'} Los datos siguen en el formulario.`, true);
    }
  } finally {
    inputs.forEach(input => { input.disabled = false; });
    stockSaving = false;
    stockButton.disabled = false;
    stockButton.setAttribute('aria-busy', 'false');
    stockButton.textContent = editingProduct ? 'Guardar cambios' : 'Guardar producto';
    // An acknowledged stock change refreshes the cached catalogue once; the
    // next sale suggestion then sees the current stock. No polling follows.
    if (done) loadProducts(true);
  }
}

async function archiveProduct(item) {
  if (stockDeleting || stockSaving || editingProduct) return;
  productConfirm = null;
  stockDeleting = true;
  message(stockStatus, 'Archivando…');
  let done = false;
  try {
    await api('/api/products', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: item.id, previous: { stock: item.stock } }),
    });
    done = true;
    message(stockStatus, 'Producto archivado. Sus ventas anteriores quedan intactas.');
  } catch (error) {
    if (error.status === 401) {
      message(stockStatus, '');
      enterLogin(error.message);
    } else if (error.status === 404) {
      message(stockStatus, 'No pudimos archivar el producto. Ya no existe o se archivó desde otro dispositivo.', true);
    } else {
      message(stockStatus, `No se pudo archivar el producto. ${error.message || 'Reintentá en unos momentos.'}`, true);
    }
  } finally {
    stockDeleting = false;
    if (done) loadProducts(true); // one silent reload, no automatic retry
  }
}

async function deleteShownSale(sale) {
  // A DELETE never overlaps a save/POST or an active GET: same quiet-connection
  // rule as saves, in-flight reads are cancelled first.
  if (deleting || saving || editing) return;
  deleting = true;
  cancelConfirm = null;
  cancelRead();
  reading(true);
  message(listStatus, 'Eliminando…');
  let outcome = null;
  try {
    await api('/api/sales', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      // Deletes now carry the full observed row (productId and quantity
      // included): the server refuses to delete what we no longer observed.
      body: JSON.stringify({ id: sale.id, previous: saleFields(sale) }),
    });
    outcome = { text: 'Venta eliminada.', failed: false };
  } catch (error) {
    if (error.status === 401) {
      // Nothing was deleted: keep the row, show the gate again.
      message(listStatus, '');
      enterLogin(error.message);
    } else if (error.status === 404) {
      // Already removed from another device: the row's data was not touched here.
      outcome = {
        text: 'No pudimos borrar la venta. Ya no existe o se eliminó desde otro dispositivo.',
        failed: true,
      };
    } else {
      message(listStatus, `No se pudo borrar la venta. ${error.message || 'Reintentá en unos momentos.'}`, true);
    }
  } finally {
    deleting = false;
    reading(false);
    // Success and gone-elsewhere finish with exactly one list read; a failed
    // delete triggers none and keeps the row: only pressing again retries.
    if (outcome) {
      readNotice = outcome;
      loadSales();
    } else if (queuedRead && !saving) {
      loadSales();
    }
  }
}

function formatMoney(cents) {
  // Format integer parts, without accumulating binary fractions.
  const pesos = Math.floor(cents / 100).toLocaleString('es-AR');
  return `$ ${pesos},${String(cents % 100).padStart(2, '0')}`;
}

function stopTimer() {
  clearTimeout(timer);
  timer = null;
}

function reading(busy) {
  // The table's busy state belongs only to the shown sales read: every awaited
  // call, including this one, is already covered by the shared indicator.
  table.setAttribute('aria-busy', String(busy));
}

function cancelRead() {
  stopTimer();
  if (read) {
    read.cancelled = true;
    read.controller.abort();
  }
  reading(false);
}

async function loadSales() {
  const selectedDate = listDate.value;
  // Clear only a different day's rows, even if a save or delete delays its read.
  if (rowsDate !== selectedDate) {
    dailyTotal.hidden = true;
    dailyTotalAmount.textContent = '';
    rows.replaceChildren();
    rowsDate = selectedDate;
    cancelConfirm = null; // A changed date also cancels a pending delete confirm.
    readNotice = null;
    message(listStatus, 'Esperando para cargar esta fecha…');
  }
  document.getElementById('day-caption').textContent = selectedDate
    ? `${selectedDate.split('-').reverse().join('/')} · Pesos argentinos (ARS)`
    : 'Elegí una fecha · ARS';
  if (saving || deleting) {
    queuedRead = true;
    return;
  }
  if (read) {
    if (read.date !== selectedDate || read.cancelled) {
      queuedRead = true;
      cancelRead();
    }
    return; // Same-date requests share the active GET.
  }
  stopTimer();
  queuedRead = false;
  const current = { date: selectedDate, controller: new AbortController(), cancelled: false, timedOut: false };
  read = current;
  reading(true);
  // The shared indicator is the live loading evidence while this GET is
  // awaited; the copy is reserved for the settled outcome.
  message(listStatus, '');
  // The one timer is the 12s deadline of the single active GET, never a poll.
  timer = setTimeout(() => {
    current.timedOut = true;
    current.controller.abort();
  }, readTimeout);
  try {
    const data = await api(`/api/sales?date=${encodeURIComponent(selectedDate)}`, { signal: current.controller.signal });
    if (current.cancelled || selectedDate !== listDate.value || saving || deleting) return;
    if (current.timedOut) throw new Error('Read timeout');
    showStorage();
    message(storageStatus, ''); // a proven read clears any stale storage error
    renderSales(data.sales);
    // A notice from a finished action (e.g. 'Venta eliminada.') survives its
    // own refreshing read and is the final status.
    const notice = readNotice;
    readNotice = null;
    message(listStatus, notice ? notice.text : 'Listado actualizado.', Boolean(notice?.failed));
  } catch (error) {
    if (current.cancelled || selectedDate !== listDate.value || saving || deleting) return;
    if (error.status === 401) {
      // Session required or expired: regardless of stale rows behind it, the
      // gate wins. The visible rows are merely hidden, never faked into fresh.
      enterLogin(error.message);
      return;
    }
    const notice = readNotice;
    readNotice = null;
    message(listStatus, notice ? notice.text : 'No se pudo actualizar. Los datos pueden estar desactualizados.', true);
    message(storageStatus, 'Almacenamiento no disponible o sin confirmar.', true);
  } finally {
    read = null;
    stopTimer();
    // A delete in flight owns the busy indicator; the cancelled read settles after.
    if (!deleting) reading(false);
    if (queuedRead && !saving && !deleting) loadSales();
  }
}

// The sale payload keeps the exact T3 HTTP contract: productId absent/null is
// a free-text sale that always carries quantity 1, and the explicit in-app
// allowance is the only key that can differ on a second send.
function buildSalePayload() {
  const fields = new FormData(form);
  const productId = currentProductId();
  return {
    requestId: editing ? editing.requestId : requestId,
    date: fields.get('date'), product: fields.get('product'), payment: fields.get('payment'),
    amount: fields.get('amount'), productId,
    quantity: productId ? parseQuantity(fields.get('quantity')) : 1,
  };
}

async function submitSale(payload, allowedNegative) {
  const body = allowedNegative ? { ...payload, allowNegative: true } : payload;
  const updating = Boolean(editing);
  if (updating) body.previous = editing.previous;
  saving = true;
  hideNegative();
  cancelEdit.disabled = true;
  cancelRead();
  message(listStatus, 'La lista se actualizará después del guardado.');
  save.disabled = true;
  save.setAttribute('aria-busy', 'true');
  save.textContent = 'Guardando…';
  // Freeze the submitted draft during flight; failures leave every value intact.
  const inputs = [...form.querySelectorAll('input')];
  inputs.forEach(input => { input.disabled = true; });
  message(saveStatus, 'Guardando venta…');
  let saved = false;
  try {
    const data = await api('/api/sales', {
      method: updating ? 'PUT' : 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    saved = true;
    if (updating) finishEdit();
    else {
      requestId = null;
      product.value = '';
      amount.value = '';
      selectedProduct = null;
    }
    hideNegative();
    listDate.value = data.sale.date;
    showStorage();
    message(saveStatus, updating ? 'Venta modificada.' : data.replayed ? 'Venta ya guardada. No se duplicó.' : 'Venta guardada.');
    saveSuccessIcon.hidden = false;
    saveFeedback.dataset.success = 'true';
    // An acknowledged mutation moves stock; the cached product list is read
    // once more so the next suggestion shows the real stock. No polling runs.
    if (catalogue !== null) loadProducts(true);
  } catch (error) {
    // Keep the identity until acknowledgment, including validation failures after
    // an earlier uncertain response. Changing it could duplicate that earlier sale.
    if (error.status === 401) {
      // Refused for lack of session: the whole draft and its id stay as they
      // are. Reauth refreshes the list; only an explicit submit resends it.
      message(saveStatus, '');
      enterLogin(error.message);
    } else if (error.code === 'INSUFFICIENT_STOCK' && !allowedNegative) {
      // The sale itself is fine; dropping stock below zero needs the in-app
      // explicit confirm, which then retries the SAME requestId unchanged.
      pendingNegative = payload;
      negativeConfirm.hidden = false;
      message(saveStatus, `${error.message} Confirmá para venderlas igual.`, true);
    } else {
      message(saveStatus, `${error.message || 'No pudimos confirmar el guardado.'} Tus datos siguen en el formulario.${updating ? '' : ' Reintentá sin cambiar los datos para evitar duplicados.'}`, true);
    }
    if (updating && (error.status === 409 || error.status === 404)) queuedRead = true;
  } finally {
    inputs.forEach(input => { input.disabled = false; });
    saving = false;
    save.disabled = false;
    save.setAttribute('aria-busy', 'false');
    cancelEdit.disabled = false;
    save.textContent = editing ? 'Guardar cambios' : 'Guardar venta';
    applyQuantityEnabled(currentProductId());
    if (saved) product.focus();
    // The only automatic list read: the confirmed save (or a date change queued
    // during it). No polling or visibility rescuing runs after an uncertain save.
    if (saved || queuedRead) loadSales();
  }
}

form.addEventListener('submit', event => {
  event.preventDefault();
  if (saving || deleting || !form.reportValidity()) return;
  if (cancelConfirm) cancelConfirm(); // Starting a save cancels a row's pending confirm.
  if (!editing && !globalThis.crypto?.randomUUID) {
    message(saveStatus, 'Abrí la app con HTTPS o localhost para guardar de forma segura.', true);
    return;
  }
  if (!editing) requestId ||= crypto.randomUUID();
  submitSale(buildSalePayload(), false);
});
listDate.addEventListener('change', loadSales);

loginForm.addEventListener('submit', async event => {
  event.preventDefault();
  if (loggingIn || saving || deleting || !loginForm.reportValidity()) return;
  loggingIn = true;
  loginButton.disabled = true;
  loginButton.setAttribute('aria-busy', 'true');
  loginButton.textContent = 'Entrando…';
  loginEmail.disabled = true;
  loginPassword.disabled = true;
  message(loginStatus, 'Comprobando la sesión…');
  try {
    // The password goes straight into this one request and is dropped from the
    // field immediately after: it is never stored, retried from storage or kept.
    await api('/api/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: loginEmail.value.trim(), password: loginPassword.value }),
    });
    message(saveStatus, '');
    message(listStatus, '');
    enterAuthenticated();
    loadSales(); // One refresh of the selected day; no polling follows it.
    if (screenName === 'stock') loadProducts(false);
  } catch (error) {
    message(loginStatus, error.message || 'No se pudo iniciar sesión. Reintentá en unos momentos.', true);
  } finally {
    loggingIn = false;
    loginButton.disabled = false;
    loginButton.setAttribute('aria-busy', 'false');
    loginButton.textContent = 'Entrar';
    loginEmail.disabled = false;
    loginPassword.disabled = false;
    loginPassword.value = '';
  }
});

logoutButton.addEventListener('click', async () => {
  if (loggingIn || loggingOut || saving || deleting) return;
  if (cancelConfirm) cancelConfirm(); // Leaving the ledger cancels any confirm state.
  loggingOut = true;
  logoutButton.disabled = true;
  cancelRead();
  message(listStatus, 'Cerrando sesión…');
  try {
    await api('/api/session', { method: 'DELETE' });
    // Confirmed anonymous state: clear, don't just hide the business data.
    rows.replaceChildren();
    cancelConfirm = null;
    dailyTotal.hidden = true;
    dailyTotalAmount.textContent = '';
    message(saveStatus, ''); // also drops any pending success icon
    message(listStatus, '');
    readNotice = null;
    queuedRead = false;
    catalogue = null; // An anonymous screen holds no business catalogue.
    hideNegative();
    hideProductNegative();
    if (editingProduct) finishProductEdit();
    enterLogin();
  } catch (error) {
    // A failed logout keeps every business row and message: the session may
    // still be usable, so nothing is hidden based on a guess.
    message(listStatus, `No se pudo cerrar la sesión. ${error.message || 'Reintentá en unos momentos.'}`, true);
  } finally {
    loggingOut = false;
    logoutButton.disabled = false;
  }
});

// Explicit boot session state; only the first data read can reveal the gate.
workspace.hidden = false;
loginSection.hidden = true;
logoutButton.hidden = true;
menuButton.hidden = true;
appMenu.hidden = true;
stockPanel.hidden = true;
save.disabled = false;
applyQuantityEnabled(null); // the parked quantity of a free-text sale
stockCancel.hidden = true;
stockNegativeConfirm.hidden = true;
negativeConfirm.hidden = true;
saveFeedback.dataset.success = 'false';
reading(false);
loadSales();
