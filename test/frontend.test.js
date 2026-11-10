import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const [source, html, css] = await Promise.all([
  readFile(new URL('../public/app.js', import.meta.url), 'utf8'),
  readFile(new URL('../public/index.html', import.meta.url), 'utf8'),
  readFile(new URL('../public/styles.css', import.meta.url), 'utf8'),
]);
const flush = () => new Promise(setImmediate);
const failure = 'No se pudo actualizar. Los datos pueden estar desactualizados.';
const sale = (product = 'Cuaderno de prueba', id = '00000000-0000-4000-8000-000000000001', extra = {}) =>
  ({ id, product, payment: 'efectivo', amountCents: 200010, ...extra });
const product = (name = 'Bolsa', priceCents = 1250, stock = 10, extra = {}, id = '11111111-1111-4111-8111-111111111111') =>
  ({ id, name, priceCents, stock, archived: false, ...extra });
const catalogue = (...items) => ({ storage: 'supabase', products: items });
const ledger = (...sales) => ({ storage: 'blob', sales });

// Only the DOM operations used by this screen: fields/events, status attributes
// and table cells. No app internals, actual server, browser storage or network.
function screen({ storage = new Map([['pochoclos-v2:stand', 'fixed']]) } = {}) {
  let now = 0;
  let nextTimer = 0;
  let activeReads = 0;
  let maxReads = 0;
  let uuidCount = 0;
  const timers = new Map();
  const requests = [];
  const elements = new Map();
  function element() {
    const listeners = new Map();
    return {
      value: '', textContent: '', dataset: {}, disabled: false, checked: false, attributes: {}, children: [],
      addEventListener(type, fn) { listeners.set(type, [...(listeners.get(type) || []), fn]); },
      appendChild(child) { this.children.push(child); return child; },
      replaceChildren(...kept) {
        this.children.length = 0;
        for (const child of kept || []) this.children.push(child);
      },
      emit(type, event) { for (const fn of listeners.get(type) || []) fn({ preventDefault() {}, ...event }); },
      setAttribute(name, value) { this.attributes[name] = String(value); },
      getAttribute(name) { return this.attributes[name] ?? null; },
      removeAttribute(name) { delete this.attributes[name]; },
      focus() { document.activeElement = this; },
    };
  }
  for (const [, id] of html.matchAll(/\bid="([^"]+)"/g)) elements.set(id, element());
  const document = Object.assign(element(), {
    visibilityState: 'visible', activeElement: null,
    getElementById: id => elements.get(id) || null,
    createElement: () => element(),
    createElementNS: () => element(),
  });
  const window = element();
  const inputs = [...html.matchAll(/<input\b[^>]*>/g)].map(([tag]) => {
    const attr = name => tag.match(new RegExp(`\\b${name}="([^"]*)"`))?.[1];
    const input = elements.get(attr('id')) || element();
    return Object.assign(input, { id: attr('id'), name: attr('name'), type: attr('type'), value: attr('value') || '' });
  });
  const formInputs = inputs.filter(input => input.name);
  // Each form sweeps only its own named inputs (the vm keeps no real DOM tree).
  const formIds = new Map();
  for (const [, attrs, body] of html.matchAll(/<form\b([^>]*)>([\s\S]*?)<\/form>/g)) {
    formIds.set(attrs.match(/id="([^"]*)"/)?.[1], [...body.matchAll(/<input\b[^>]*>/g)].map(([tag]) => ({
      id: tag.match(/\bid="([^"]*)"/)?.[1],
      name: tag.match(/\bname="([^"]*)"/)?.[1],
      type: tag.match(/\btype="([^"]*)"/)?.[1],
      value: tag.match(/\bvalue="([^"]*)"/)?.[1],
    })));
  }
  const formInputsOf = formId => (formIds.get(formId) || []).map(ref => inputs.find(input =>
    (ref.id ? input.id === ref.id : true)
    && (ref.name ? input.name === ref.name : true)
    && (ref.type ? input.type === ref.type : true)
    && (ref.value !== undefined ? input.value === ref.value : true))).filter(Boolean);
  const form = elements.get('sale-form');
  form.querySelectorAll = () => formInputsOf('sale-form');
  form.reportValidity = () => true;
  if (elements.get('login-form')) elements.get('login-form').reportValidity = () => true;
  if (elements.get('stock-form')) {
    elements.get('stock-form').querySelectorAll = () => formInputsOf('stock-form');
    elements.get('stock-form').reportValidity = () => true;
  }
  const makeTableBody = () => {
    const body = element();
    body.children = [];
    body.replaceChildren = () => { body.children = []; };
    body.insertRow = () => {
      const row = { cells: [], insertCell() { const cell = element(); this.cells.push(cell); return cell; } };
      body.children.push(row);
      return row;
    };
    return body;
  };
  const rows = makeTableBody();
  elements.set('sales', rows);
  const productRows = makeTableBody();
  elements.set('products', productRows);
  const context = {
    document, window, AbortController, encodeURIComponent, console,
    localStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, String(value)) },
    Date: class extends Date {
      constructor(...args) { super(...(args.length ? args : [Date.UTC(2026, 10, 3, 12) + now])); }
      static now() { return now; }
    },
    crypto: { randomUUID: () => `00000000-0000-4000-8000-${String(++uuidCount).padStart(12, '0')}` },
    FormData: class {
      constructor() { this.fields = new Map(formInputs.filter(input => !input.disabled && (input.type !== 'radio' || input.checked)).map(input => [input.name, input.value])); }
      get(name) { return this.fields.get(name) ?? null; }
    },
    setTimeout(fn, delay) { const id = ++nextTimer; timers.set(id, { at: now + delay, fn }); return id; },
    clearTimeout(id) { timers.delete(id); },
    fetch(url, options = {}) {
      assert.match(url, /^\/api\/(?:sales(?:\?|$)|session$|products$)/, 'mock is the only network destination');
      const method = options.method || 'GET';
      if (method === 'GET') maxReads = Math.max(maxReads, ++activeReads);
      return new Promise((resolve, reject) => {
        let settled = false;
        const finish = fn => value => {
          if (settled) return;
          settled = true;
          if (method === 'GET') activeReads--;
          fn(value);
        };
        const done = finish(resolve);
        const fail = finish(reject);
        const request = { url, method, options, ignoreAbort: false,
          reply(data, status = 200) { done({ ok: status < 400, status, json: async () => data }); },
          reject: fail,
        };
        options.signal?.addEventListener('abort', () => {
          if (!request.ignoreAbort) fail(Object.assign(new Error('Aborted'), { name: 'AbortError' }));
        });
        requests.push(request);
      });
    },
  };
  vm.runInNewContext(source, context, { filename: 'public/app.js' });
  return {
    el: id => elements.get(id) || null, document, window, requests, formInputs, storage,
    reads: () => requests.filter(request => request.method === 'GET'),
    salesReads: () => requests.filter(request => request.method === 'GET' && /^\/api\/sales\?/.test(request.url)),
    productGets: () => requests.filter(request => request.url === '/api/products' && request.method === 'GET'),
    posts: () => requests.filter(request => request.url === '/api/sales' && request.method === 'POST'),
    salePosts: () => requests.filter(request => request.url === '/api/sales' && request.method === 'POST'),
    puts: () => requests.filter(request => request.url === '/api/sales' && request.method === 'PUT'),
    dels: () => requests.filter(request => request.url === '/api/sales' && request.method === 'DELETE'),
    productPosts: () => requests.filter(request => request.url === '/api/products' && request.method === 'POST'),
    productPuts: () => requests.filter(request => request.url === '/api/products' && request.method === 'PUT'),
    productDels: () => requests.filter(request => request.url === '/api/products' && request.method === 'DELETE'),
    stockInputs: formInputsOf('stock-form'),
    saleFormInputs: () => formInputsOf('sale-form'),
    sessionPosts: () => requests.filter(request => request.url === '/api/session' && request.method === 'POST'),
    sessionDels: () => requests.filter(request => request.url === '/api/session' && request.method === 'DELETE'),
    products: () => rows.children.map(row => row.cells[0]?.textContent),
    maxReads: () => maxReads,
    async tick(ms) {
      const end = now + ms;
      while (true) {
        const next = [...timers].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        const [id, timer] = next;
        timers.delete(id); now = timer.at; timer.fn(); await flush();
      }
      now = end; await flush();
    },
    async reply(request, data, status) { request.reply(data, status); await flush(); },
    draft() {
      elements.get('sale-date').value = '2026-11-02';
      elements.get('product').value = 'Borrador sin guardar';
      elements.get('amount').value = '1500,10';
      formInputs.find(input => input.value === 'transferencia').checked = true;
      elements.get('product').focus();
    },
  };
}
function busy(app, value) {
  assert.equal(app.el('ledger-table')?.getAttribute('aria-busy'), String(value),
    'ledger-table busy state belongs only to the shown sales read');
}
// S7: the shared 'Actualizando…' indicator is the live count of requests the
// app is genuinely awaiting through the one api() wrapper: visible only while
// at least one call exists, with its copy only during flight and none after.
function syncing(app, value, why, counterLive = value) {
  const status = app.el('sync-status');
  assert.ok(status, 'the shared indicator exists');
  // aria-busy mirrors the live counter of awaited calls, even when the login
  // gate keeps the indicator itself hidden.
  assert.equal(status.getAttribute('aria-busy'), String(counterLive), why);
  assert.equal(status.hidden, !value, why);
  assert.equal(status.textContent, value ? 'Actualizando…' : '', why);
}
function actions(app) {
  return app.el('sales').children.map(row => {
    const cell = row.cells[row.cells.length - 1];
    return {
      cell, text: cell.textContent, confirm: cell.dataset.confirm,
      buttons: cell.children.filter(child => child.className !== 'row-edit icon-button').map(child => child.className === 'row-delete icon-button' ? 'Borrar' : child.textContent),
      label: cell.children[0]?.getAttribute('aria-label'),
    };
  });
}
function intactDraft(app) {
  assert.equal(app.el('sale-date').value, '2026-11-02');
  assert.equal(app.el('product').value, 'Borrador sin guardar');
  assert.equal(app.el('amount').value, '1500,10');
  assert.equal(app.formInputs.find(input => input.value === 'transferencia').checked, true);
  assert.equal(app.document.activeElement, app.el('product'));
  // The stock quantity stays parked at 1 while a free-text sale is the draft.
  assert.ok(app.formInputs.every(input => !input.disabled || input.id === 'quantity'));
  assert.equal(app.el('quantity').value, '1');
}

test('save success check appears only after acknowledgement, resets on submit and stays hidden after failure', async () => {
  const app = screen();
  assert.equal(app.el('save-success-icon')?.hidden, true);
  await app.reply(app.reads()[0], ledger());
  app.draft();
  app.el('sale-form').emit('submit'); await flush();
  assert.equal(app.el('save-success-icon').hidden, true, 'pending is not success');
  await app.reply(app.posts()[0], { storage: 'blob', sale: { date: '2026-11-02' }, replayed: false }, 201);
  assert.equal(app.el('save-success-icon').hidden, false);
  assert.equal(app.el('save-feedback').dataset.success, 'true');
  assert.equal(app.el('save-status').textContent, 'Venta guardada.');
  await app.reply(app.reads()[1], { error: { message: 'Temporal' } }, 503);
  assert.equal(app.el('save-success-icon').hidden, false, 'a failed refresh does not undo confirmed persistence');
  app.draft();
  app.el('sale-form').emit('submit'); await flush();
  assert.equal(app.el('save-success-icon').hidden, true, 'another submission resets the animation');
  assert.equal(app.el('save-feedback').dataset.success, 'false');
  await app.reply(app.posts()[1], { error: { message: 'No se pudo guardar' } }, 503);
  assert.equal(app.el('save-success-icon').hidden, true);
  assert.equal(app.el('save-status').dataset.error, 'true');
  app.el('sale-form').emit('submit'); await flush();
  await app.reply(app.posts()[2], { storage: 'blob', sale: { date: '2026-11-02' }, replayed: true });
  assert.equal(app.el('save-success-icon').hidden, false);
  assert.equal(app.el('save-status').textContent, 'Venta ya guardada. No se duplicó.');
  assert.match(html, /id="save-success-icon"[^>]*aria-hidden="true"[\s\S]*?<svg[^>]*focusable="false"/);
  assert.match(css, /prefers-reduced-motion:\s*reduce[\s\S]*#save-success-icon[\s\S]*animation:\s*none/);
});

test('daily total sums both payments in integer cents for the selected day, including empty and stale lists', async () => {
  const app = screen();
  assert.equal(app.el('daily-total')?.hidden, true, 'no total before a successful read');
  await app.reply(app.reads()[0], ledger(
    { ...sale('Efectivo'), amountCents: 10 },
    { ...sale('Transferencia', '2'), payment: 'transferencia', amountCents: 20 },
    { ...sale('Importe grande', '3'), amountCents: 123456789 },
  ));
  assert.equal(app.el('daily-total').hidden, false);
  assert.equal(app.el('daily-total-amount').textContent, '$ 1.234.568,19');
  assert.deepEqual(app.products(), ['Efectivo', 'Transferencia', 'Importe grande'], 'summary is not an editable sale');
  app.el('list-date').emit('change'); await flush();
  await app.reply(app.reads()[1], { error: { message: 'Temporal' } }, 503);
  assert.equal(app.el('daily-total-amount').textContent, '$ 1.234.568,19', 'same-day stale rows keep their matching total');
  assert.equal(app.el('list-status').textContent, failure);
  app.el('list-date').value = '2026-11-04';
  app.el('list-date').emit('change'); await flush();
  assert.equal(app.el('daily-total').hidden, true, 'never show the previous date total during loading');
  assert.equal(app.el('daily-total-amount').textContent, '');
  await app.reply(app.reads()[2], ledger());
  assert.equal(app.el('daily-total').hidden, false);
  assert.equal(app.el('daily-total-amount').textContent, '$ 0,00');
});

test('no polling: after the initial read, time alone never triggers another GET or POST', async () => {
  const app = screen();
  await app.reply(app.reads()[0], ledger(sale('Primera')));
  app.draft();
  busy(app, false);
  assert.equal(app.el('list-status').textContent, 'Listado actualizado.');
  // No technical badge: an authenticated read proves storage and offers logout.
  assert.equal(app.el('storage-status').textContent, '');
  await app.tick(60000);
  await app.tick(60000);
  assert.equal(app.reads().length, 1, 'any number of ticks produces no additional GET');
  assert.equal(app.posts().length, 0);
  assert.deepEqual(app.products(), ['Primera']);
  intactDraft(app);
  assert.equal(app.maxReads(), 1);
});

test('a confirmed save resets to the saved day and one GET brings other-device sales', async () => {
  const app = screen();
  await app.reply(app.reads()[0], ledger(sale('Existente')));
  assert.equal(app.el('quantity')?.disabled, true, 'the parked quantity is the free-text default at boot');
  app.draft();
  app.el('list-date').emit('change'); await flush(); // an active read is in flight
  assert.equal(app.reads().length, 2);
  busy(app, true);
  app.el('sale-form').emit('submit'); app.el('sale-form').emit('submit'); await flush();
  assert.equal(app.posts().length, 1, 'duplicate submits while saving are blocked');
  assert.equal(app.reads()[1].options.signal.aborted, true, 'submit cancels the in-flight GET');
  busy(app, false);
  assert.equal(app.el('save').getAttribute('aria-busy'), 'true');
  assert.equal(app.el('save').textContent, 'Guardando…');
  assert.ok(app.saleFormInputs().every(input => input.disabled), 'the whole submitted draft freezes during the POST');
  assert.deepEqual(app.products(), ['Existente']);
  await app.tick(30000);
  assert.equal(app.reads().length, 2, 'no time-based read can start during the POST');
  assert.equal(app.el('list-status').textContent, 'La lista se actualizará después del guardado.');
  const payload = JSON.parse(app.posts()[0].options.body);
  assert.equal(payload.date, '2026-11-02');
  assert.equal(payload.payment, 'transferencia');
  await app.reply(app.posts()[0], { storage: 'blob', sale: { date: payload.date }, replayed: false }, 201);
  assert.equal(app.el('save').getAttribute('aria-busy'), 'false');
  assert.equal(app.el('save-status').textContent, 'Venta guardada.');
  assert.equal(app.el('save').textContent, 'Guardar venta');
  assert.equal(app.el('product').value, ''); assert.equal(app.el('amount').value, '');
  assert.equal(app.el('sale-date').value, payload.date);
  assert.equal(app.el('list-date').value, payload.date);
  assert.equal(app.document.activeElement, app.el('product'));
  assert.ok(app.formInputs.every(input => !input.disabled || input.id === 'quantity'));
  assert.equal(app.formInputs.find(input => input.value === 'transferencia').checked, true);
  assert.equal(app.reads().length, 3, 'exactly one GET after the confirmed save');
  assert.match(app.reads()[2].url, /date=2026-11-02$/);
  busy(app, true);
  await app.reply(app.reads()[2], ledger(sale('Existente'), sale('Desde otro dispositivo')));
  busy(app, false);
  assert.deepEqual(app.products(), ['Existente', 'Desde otro dispositivo'], 'the post-save read brings other-device sales');
  assert.equal(app.el('list-status').textContent, 'Listado actualizado.');
  await app.tick(60000);
  assert.equal(app.reads().length, 3, 'no polling after the post-save read');
  assert.equal(app.posts().length, 1);
  assert.equal(app.maxReads(), 1);
});

test('a failed save triggers no GET, ever; the list waits for the next confirmed save or date change', async () => {
  const app = screen();
  await app.reply(app.reads()[0], ledger(sale('Existente')));
  app.draft();
  const payload = {
    requestId: '00000000-0000-4000-8000-000000000001', date: '2026-11-02',
    product: 'Borrador sin guardar', payment: 'transferencia', amount: '1500,10',
    productId: null, quantity: 1, stand: 'fixed',
  };
  app.el('sale-form').emit('submit'); await flush();
  app.posts()[0].reject(new Error('Respuesta perdida')); await flush();
  assert.equal(app.posts().length, 1);
  await app.tick(60000);
  assert.equal(app.reads().length, 1, 'a failed POST never fires a GET, even over time');
  app.el('list-date').value = '2026-11-01'; app.el('list-date').emit('change');
  assert.equal(app.reads().length, 2);
  assert.match(app.reads()[1].url, /date=2026-11-01$/);
  app.el('sale-form').emit('submit'); await flush();
  assert.equal(app.posts().length, 2, 'a user-driven retry reuses the kept identity');
  assert.deepEqual(JSON.parse(app.posts()[1].options.body), payload);
});

test('rapid date switches and in-flight aborts serialize the latest intent and suppress stale rows', async () => {
  const app = screen();
  const old = app.reads()[0]; old.ignoreAbort = true;
  app.draft();
  app.el('list-date').value = '2026-11-01'; app.el('list-date').emit('change');
  app.el('list-date').value = '2026-11-02'; app.el('list-date').emit('change');
  assert.deepEqual(app.products(), [], 'different-day rows disappear before the new read');
  assert.match(app.el('day-caption').textContent, /02\/11\/2026/);
  assert.equal(app.reads().length, 1, 'no new GET until the aborted old read settles');
  assert.equal(old.options.signal.aborted, true);
  await app.reply(old, ledger(sale('Resultado obsoleto')));
  assert.equal(app.reads().length, 2, 'the queued latest-date read starts only after the old read settles');
  assert.match(app.reads()[1].url, /date=2026-11-02$/);
  busy(app, true);
  assert.deepEqual(app.products(), []);
  await app.reply(app.reads()[1], ledger(sale('Fecha elegida')));
  busy(app, false);
  assert.deepEqual(app.products(), ['Fecha elegida']);
  intactDraft(app);
  assert.equal(app.maxReads(), 1);
});

test('a failed re-read of the shown date keeps rows and exact copy; the next date change clears and reads', async () => {
  const app = screen();
  await app.reply(app.reads()[0], ledger(sale('Correcta')));
  app.draft();
  app.el('list-date').emit('change'); await flush();
  assert.equal(app.reads().length, 2);
  busy(app, true);
  app.el('list-date').emit('change'); await flush();
  assert.equal(app.reads().length, 2, 'same-date requests share the active GET');
  assert.equal(app.maxReads(), 1);
  await app.reply(app.reads()[1], { error: { message: 'Sin acceso' } }, 503);
  busy(app, false);
  assert.equal(app.el('list-status').textContent, failure);
  assert.equal(app.el('list-status').dataset.error, 'true');
  assert.equal(app.el('storage-status').textContent, 'Almacenamiento no disponible o sin confirmar.', 'the one honest storage error stays');
  assert.deepEqual(app.products(), ['Correcta']);
  intactDraft(app);
  await app.tick(60000);
  assert.equal(app.reads().length, 2, 'no timer retries the failed read');
  app.el('list-date').value = '2026-11-01'; app.el('list-date').emit('change');
  assert.deepEqual(app.products(), [], 'a changed date clears other-day rows immediately');
  await app.reply(app.reads()[2], ledger(sale('Otro día')));
  busy(app, false);
  assert.equal(app.el('list-status').textContent, 'Listado actualizado.');
  assert.equal(app.el('list-status').dataset.error, 'false');
  assert.equal(app.el('storage-status').textContent, '', 'a recovered read clears the storage error; no badge returns');
  assert.deepEqual(app.products(), ['Otro día']);
});

test('the single GET aborts at its 12s deadline without clearing same-day rows', async () => {
  const app = screen();
  await app.reply(app.reads()[0], ledger(sale('Anterior')));
  app.draft();
  app.el('list-date').emit('change'); await flush();
  const pending = app.reads()[1];
  await app.tick(11999);
  assert.equal(pending.options.signal.aborted, false);
  await app.tick(1);
  assert.equal(pending.options.signal.aborted, true, 'the 12s deadline aborts the read');
  assert.equal(app.reads().length, 2, 'the timeout fires no replacement read');
  busy(app, false);
  assert.equal(app.el('list-status').textContent, failure);
  assert.equal(app.el('list-status').dataset.error, 'true');
  assert.deepEqual(app.products(), ['Anterior']);
  intactDraft(app);
});

test('an uncertain POST keeps draft and requestId; a failed POST never reads; retries keep or replace identity correctly', async () => {
  const app = screen();
  await app.reply(app.reads()[0], ledger());
  app.draft();
  app.el('sale-form').emit('submit'); await flush();
  const payload = JSON.parse(app.posts()[0].options.body);
  assert.deepEqual(payload, {
    requestId: payload.requestId, date: '2026-11-02', product: 'Borrador sin guardar', payment: 'transferencia', amount: '1500,10',
    productId: null, quantity: 1, stand: 'fixed',
  });
  app.posts()[0].reject(new Error('Respuesta perdida')); await flush();
  assert.equal(app.el('save').getAttribute('aria-busy'), 'false');
  assert.equal(app.el('save-status').dataset.error, 'true');
  assert.match(app.el('save-status').textContent, /Tus datos siguen en el formulario.*sin cambiar los datos/);
  intactDraft(app);
  await app.tick(60000);
  assert.equal(app.reads().length, 1, 'no read of any kind follows a failed POST');
  assert.equal(app.posts().length, 1, 'no automatic action retries a POST');
  app.el('sale-form').emit('submit'); await flush();
  assert.deepEqual(JSON.parse(app.posts()[1].options.body), payload, 'a retry reuses the identity');
  await app.reply(app.posts()[1], { storage: 'blob', sale: { date: payload.date }, replayed: true });
  assert.equal(app.el('save-status').textContent, 'Venta ya guardada. No se duplicó.');
  await app.reply(app.reads()[1], ledger(sale('Una sola venta')));
  assert.deepEqual(app.products(), ['Una sola venta']);
  app.draft(); app.el('sale-form').emit('submit'); await flush();
  assert.notEqual(JSON.parse(app.posts()[2].options.body).requestId, payload.requestId, 'a new draft gets a fresh identity');
});

test('an acknowledged save stays successful when the post-save read fails', async () => {
  const app = screen();
  await app.reply(app.reads()[0], ledger());
  app.draft(); app.el('sale-form').emit('submit'); await flush();
  await app.reply(app.posts()[0], { storage: 'blob', sale: { date: '2026-11-02' }, replayed: false }, 201);
  await app.reply(app.reads()[1], { error: { message: 'Temporal' } }, 503);
  assert.equal(app.el('save-status').textContent, 'Venta guardada.');
  assert.equal(app.el('save-status').dataset.error, 'false');
  assert.equal(app.el('save').getAttribute('aria-busy'), 'false');
  assert.equal(app.el('product').value, '');
  assert.equal(app.el('amount').value, '');
  busy(app, false);
  assert.equal(app.el('list-status').textContent, failure);
  assert.equal(app.el('list-status').dataset.error, 'true');
  assert.deepEqual(app.products(), [], 'the changed saved day had its old rows cleared');
});

test('the delete control confirms in the app one row at a time and cancels on date change, save or busy rows', async () => {
  const app = screen();
  await app.reply(app.reads()[0], ledger(sale('Cuaderno', '1'), sale('Lápiz', '2')));
  let acts = actions(app);
  assert.deepEqual(acts.map(item => item.buttons), [['Borrar'], ['Borrar']]);
  assert.deepEqual(acts.map(item => item.confirm), ['false', 'false']);
  assert.deepEqual(acts.map(item => item.label), ['Borrar Cuaderno', 'Borrar Lápiz']);
  acts[0].cell.children[0].emit('click'); await flush();
  assert.deepEqual(acts[0].cell.textContent, '¿Borrar?');
  assert.deepEqual(actions(app).map(item => item.confirm), ['true', 'false']);
  assert.deepEqual(actions(app)[0].buttons, ['¡Sí, borrar!', 'Cancelar']);
  // Only one row may hold the confirm state: starting another cancels the first.
  acts[1].cell.children[0].emit('click'); await flush();
  assert.deepEqual(actions(app).map(item => item.confirm), ['false', 'true']);
  assert.deepEqual(actions(app)[0].buttons, ['Borrar']);
  acts[1].cell.children.find(child => child.textContent === 'Cancelar').emit('click'); await flush();
  assert.deepEqual(actions(app).map(item => item.confirm), ['false', 'false']);
  // Changing the date clears the shown rows and with them the confirm state.
  acts[0].cell.children[0].emit('click'); await flush();
  app.el('list-date').value = '2026-11-01'; app.el('list-date').emit('change'); await flush();
  assert.equal(app.reads().length, 2, 'a date change reads the chosen day');
  await app.reply(app.reads()[1], ledger(sale('Otro día', '3')));
  assert.deepEqual(actions(app).map(item => item.confirm), ['false'], 'the confirm state never survives a date change');
  // Starting a save is another action; it cancels the pending confirm first.
  let rowDelete = actions(app)[0].cell.children[0];
  rowDelete.emit('click'); await flush();
  assert.deepEqual(actions(app).map(item => item.confirm), ['true']);
  app.draft();
  app.el('sale-form').emit('submit'); await flush();
  assert.deepEqual(actions(app).map(item => item.confirm), ['false'], 'saving cancels the confirm state');
  assert.equal(app.posts().length, 1);
  // While a sale is saving, the delete control is inert: never an overlapping save.
  rowDelete = actions(app)[0].cell.children[0];
  rowDelete.emit('click'); await flush();
  assert.deepEqual(actions(app).map(item => item.confirm), ['false'], 'Borrar is inert while saving');
  app.posts()[0].reject(new Error('Respuesta perdida')); await flush();
  assert.equal(app.posts().length, 1);
});

test('confirmed delete cancels the active read, never overlaps a save and refreshes exactly once', async () => {
  const app = screen();
  await app.reply(app.reads()[0], ledger(sale('Primera', '1', { date: '2026-11-03' }), sale('Segunda', '2', { date: '2026-11-03' })));
  app.el('list-date').emit('change'); await flush();
  assert.equal(app.reads().length, 2);
  const pendingRead = app.reads()[1];
  actions(app)[0].cell.children[0].emit('click'); await flush();
  const yes = actions(app)[0].cell.children[0];
  assert.equal(yes.textContent, '¡Sí, borrar!');
  yes.emit('click'); await flush();
  assert.equal(pendingRead.options.signal.aborted, true, 'the delete begins with the in-flight GET cancelled, like a save');
  busy(app, true);
  assert.equal(app.el('list-status').textContent, 'Eliminando…');
  assert.equal(app.dels().length, 1);
  const del = app.dels()[0];
  // Deletes now carry the full observed snapshot (productId and quantity too):
  // the server refuses to delete what the client no longer sees.
  assert.deepEqual(JSON.parse(del.options.body), { id: '1', previous: {
    requestId: '1', date: '2026-11-03', product: 'Primera', payment: 'efectivo', amount: '2000,10',
    productId: null, quantity: 1,
  } });
  app.el('sale-form').emit('submit'); await flush();
  assert.equal(app.posts().length, 0, 'no save overlaps a delete');
  await app.tick(30000);
  assert.equal(app.reads().length, 2, 'no time-based read runs during the DELETE');
  await app.reply(del, { storage: 'blob', sale: { id: '1' } }, 200);
  await flush();
  assert.equal(app.reads().length, 3, 'exactly one GET refreshes after the confirmed delete');
  assert.match(app.reads()[2].url, /date=2026-11-03$/);
  busy(app, true);
  await app.reply(app.reads()[2], ledger(sale('Otra venta', '9')));
  busy(app, false);
  assert.deepEqual(app.products(), ['Otra venta'], 'the deleted row is gone and the other row survives');
  assert.equal(app.el('list-status').textContent, 'Venta eliminada.');
  assert.equal(app.el('list-status').dataset.error, 'false');
  assert.equal(app.el('daily-total-amount').textContent, '$ 2.000,10');
  await app.tick(60000);
  assert.equal(app.reads().length, 3, 'no polling follows the post-delete read');
});

test('a gone sale refreshes with honest copy; a failed delete keeps the row and only pressing again retries', async () => {
  const app = screen();
  await app.reply(app.reads()[0], ledger(sale('Unica', '1')));
  actions(app)[0].cell.children[0].emit('click'); await flush();
  actions(app)[0].cell.children[0].emit('click'); await flush(); // ¡Sí, borrar!
  assert.equal(app.el('list-status').textContent, 'Eliminando…');
  // Already deleted from another device: refresh the list, admit it, mutate nothing.
  await app.reply(app.dels()[0], {
    error: { code: 'NOT_FOUND', message: 'La venta ya no existe o se eliminó desde otro dispositivo.' },
  }, 404);
  await flush();
  assert.equal(app.reads().length, 2, 'a gone sale still refreshes exactly once');
  await app.reply(app.reads()[1], ledger(sale('Desde otro dispositivo', '8')));
  assert.deepEqual(app.products(), ['Desde otro dispositivo'], 'the gone row and any other rows are refreshed');
  assert.equal(app.el('list-status').textContent, 'No pudimos borrar la venta. Ya no existe o se eliminó desde otro dispositivo.');
  assert.equal(app.el('list-status').dataset.error, 'true');
  // Network/storage failure: keep the row, show an honest error, retry nothing.
  actions(app)[0].cell.children[0].emit('click'); await flush();
  actions(app)[0].cell.children[0].emit('click'); await flush();
  assert.equal(app.el('list-status').textContent, 'Eliminando…');
  busy(app, true);
  await app.reply(app.dels()[1], { error: { message: 'Sin acceso' } }, 503);
  await flush();
  busy(app, false);
  assert.equal(app.el('list-status').textContent, 'No se pudo borrar la venta. Sin acceso');
  assert.equal(app.el('list-status').dataset.error, 'true');
  assert.deepEqual(app.products(), ['Desde otro dispositivo'], 'a failed delete keeps the row');
  assert.equal(app.reads().length, 2, 'a failed delete triggers no read');
  await app.tick(60000);
  assert.equal(app.reads().length, 2, 'no automatic retry over time');
  assert.equal(app.dels().length, 2);
  // Only pressing the control again sends a new DELETE.
  actions(app)[0].cell.children[0].emit('click'); await flush();
  actions(app)[0].cell.children[0].emit('click'); await flush();
  assert.equal(app.dels().length, 3);
  await app.reply(app.dels()[2], { storage: 'blob', sale: { id: '8' } }, 200);
  await flush();
  assert.equal(app.reads().length, 3, 'a later success refreshes exactly once');
  await app.reply(app.reads()[2], ledger());
  assert.equal(app.el('sales').children[0].cells[0].textContent, 'Todavía no hay ventas para esta fecha. Agregá la primera.');
  assert.equal(app.el('list-status').textContent, 'Venta eliminada.');
  assert.equal(app.el('list-status').dataset.error, 'false');
});

test('loading UI has decorative reserved spinners, accessible busy/text and static reduced-motion fallback', () => {
  assert.doesNotMatch(html, /id="refresh"|tocar Actualizar|Automático · 15 s|15 s|cada 15/);
  // S7: no idle copy is shipped at all — no permanent hidden 'Actualizando…'
  // label and no stale loading placeholder; JS writes the text only while a
  // actual request is awaited, so anonymous/idle screens stay quiet.
  assert.doesNotMatch(html, /Actualizando|Cargando ventas/);
  assert.match(html, /<header[^>]*>[\s\S]*?<p id="sync-status" class="sync-status" role="status" aria-live="polite" aria-busy="false" hidden><span class="spinner" aria-hidden="true"><\/span><\/p>[\s\S]*?<\/header>/);
  assert.match(html, /cada vez que guardás una venta/);
  assert.match(html, /id="save"[^>]*aria-busy="false"/);
  assert.match(html, /id="list-status" role="status" aria-live="polite"/);
  assert.match(css, /\.spinner, #save::before\s*\{[^}]*box-sizing:\s*border-box[^}]*visibility:\s*hidden/s);
  assert.match(css, /#save::before\s*\{[^}]*position:\s*absolute/s);
  assert.match(css, /prefers-reduced-motion:\s*reduce[\s\S]*animation:\s*none/);
  assert.doesNotMatch(source, /refreshDelay|scheduleRefresh|suspendRefresh|resumeRefresh|visibilitychange|pageshow|pagehide|addEventListener\('focus'/);
});


function editFirst(app) {
  const buttons = app.el('sales').children[0].cells[3].children;
  const edit = buttons.find(button => button.getAttribute('aria-label')?.startsWith('Modificar '));
  assert.ok(edit, 'accessible edit action exists');
  edit.emit('click');
}

test('row icons are accessible and editing all fields submits PUT, then selects the new day', async () => {
  const app = screen();
  const original = { ...sale(), date: '2026-11-03' };
  await app.reply(app.reads()[0], ledger(original));
  const actionCell = app.el('sales').children[0].cells[3];
  assert.equal(actionCell.className, 'actions');
  const buttons = actionCell.children;
  assert.equal(buttons.length, 2);
  for (const button of buttons) {
    assert.ok(button.getAttribute('aria-label'));
    assert.equal(button.children[0].getAttribute('aria-hidden'), 'true');
    assert.equal(button.textContent, '');
  }
  editFirst(app);
  assert.equal(app.el('entry-title').textContent, 'Modificar venta');
  assert.equal(app.el('save').textContent, 'Guardar cambios');
  assert.equal(app.el('product').value, original.product);
  assert.equal(app.el('amount').value, '2000,10');
  assert.equal(app.el('sale-date').value, original.date);
  assert.equal(app.formInputs.find(i => i.value === 'efectivo').checked, true);
  app.draft();
  app.el('sale-form').emit('submit'); await flush();
  const put = app.requests.find(r => r.method === 'PUT');
  assert.ok(put);
  assert.deepEqual(JSON.parse(put.options.body), {
    requestId: original.id, date: '2026-11-02', product: 'Borrador sin guardar', payment: 'transferencia', amount: '1500,10',
    productId: null, quantity: 1,
    previous: { requestId: original.id, date: original.date, product: original.product, payment: 'efectivo', amount: '2000,10',
      productId: null, quantity: 1 },
  });
  assert.equal(app.posts().length, 0);
  assert.equal(app.el('cancel-edit').disabled, true);
  await app.reply(put, { storage: 'blob', sale: { ...original, date: '2026-11-02' } });
  assert.equal(app.el('save-status').textContent, 'Venta modificada.');
  assert.equal(app.el('list-date').value, '2026-11-02');
  assert.equal(app.el('save').textContent, 'Guardar venta');
  assert.equal(app.el('cancel-edit').hidden, true);
  assert.equal(app.reads().length, 2);
});

test('cancel edit restores the previous draft; failed updates keep edit fields and retry identity', async () => {
  const app = screen();
  const original = { ...sale(), date: '2026-11-03' };
  await app.reply(app.reads()[0], ledger(original));
  app.draft();
  editFirst(app);
  app.el('cancel-edit').emit('click');
  intactDraft(app);
  assert.equal(app.el('entry-title').textContent, 'Agregar venta');
  editFirst(app);
  app.el('product').value = 'Modificada';
  app.el('sale-form').emit('submit'); await flush();
  const put = app.requests.find(r => r.method === 'PUT');
  await app.reply(put, { error: { message: 'Temporal' } }, 503);
  assert.equal(app.el('product').value, 'Modificada');
  assert.equal(app.el('save').textContent, 'Guardar cambios');
  assert.equal(app.el('cancel-edit').disabled, false);
  assert.equal(app.el('save-status').dataset.error, 'true');
  assert.equal(app.reads().length, 1);
  app.el('sale-form').emit('submit'); await flush();
  const puts = app.requests.filter(r => r.method === 'PUT');
  assert.equal(puts[1].options.body, puts[0].options.body);
  assert.equal(app.posts().length, 0);
});

test('the first refused GET gates the screen behind login; a confirmed login clears the password and refreshes the day', async () => {
  const app = screen();
  await app.reply(app.reads()[0], { error: { message: 'Iniciá sesión para continuar.' } }, 401);
  assert.equal(app.el('login-section').hidden, false, 'the login replaces the gated screen');
  assert.equal(app.el('workspace').hidden, true, 'the confidential table is hidden from anonymous');
  assert.equal(app.el('menu-button').hidden, true, 'no business menu while anonymous');
  assert.equal(app.el('logout').hidden, true);
  assert.equal(app.el('login-password').value, '');
  assert.equal(app.el('login-status').textContent, 'Iniciá sesión para continuar.');
  assert.equal(app.el('login-status').dataset.error, 'false');
  app.el('login-email').value = 'pochoclos@negocio.com';
  app.el('login-password').value = 'contraseña-sintética-de-prueba';
  app.el('login-form').emit('submit'); await flush();
  assert.equal(app.sessionPosts().length, 1);
  assert.equal(app.sessionPosts()[0].options.method, 'POST');
  assert.deepEqual(JSON.parse(app.sessionPosts()[0].options.body), {
    email: 'pochoclos@negocio.com', password: 'contraseña-sintética-de-prueba',
  });
  assert.equal(app.el('login-button').getAttribute('aria-busy'), 'true');
  assert.equal(app.el('login-button').textContent, 'Entrando…');
  assert.ok(app.el('login-button').disabled, 'resubmits while entering are blocked');
  assert.ok(app.el('login-email').disabled);
  assert.ok(app.el('login-password').disabled);
  await app.reply(app.sessionPosts()[0], {
    error: { code: 'INVALID_CREDENTIALS', message: 'Correo o contraseña incorrectos.' },
  }, 401);
  assert.equal(app.el('login-status').textContent, 'Correo o contraseña incorrectos.');
  assert.equal(app.el('login-status').dataset.error, 'true');
  assert.equal(app.el('login-password').value, '', 'the typed password never lingers beyond its use');
  assert.equal(app.el('login-button').textContent, 'Entrar');
  assert.equal(app.el('login-button').disabled, false);
  assert.equal(app.el('workspace').hidden, true, 'a failed login keeps the gate');
  app.el('login-form').emit('submit'); await flush();
  assert.equal(app.sessionPosts().length, 2);
  await app.reply(app.sessionPosts()[1], { status: 'authenticated' });
  assert.equal(app.el('login-section').hidden, true);
  assert.equal(app.el('workspace').hidden, false, 'the business screen returns after sign-in');
  assert.equal(app.el('menu-button').hidden, false, 'an authenticated session offers the menu');
  assert.equal(app.reads().length, 2, 'the selected day is refreshed after login');
  await app.reply(app.reads()[1], { date: '2026-11-03', storage: 'supabase', sales: [sale('Real día', '4')] });
  assert.equal(app.el('storage-status').textContent, '', 'no SUPABASE badge: machine details are off the screen');
  assert.equal(app.el('logout').hidden, false);
  assert.deepEqual(app.products(), ['Real día']);
  assert.equal(app.el('list-status').textContent, 'Listado actualizado.');
  await app.tick(60000);
  assert.equal(app.reads().length, 2, 'no polling follows the post-login read');
});

test('a session expiry during save shows login, preserves the draft identity and never resubmits automatically', async () => {
  const app = screen();
  await app.reply(app.reads()[0], { date: '2026-11-03', storage: 'supabase', sales: [sale('Guardada', '5')] });
  app.draft();
  app.el('sale-form').emit('submit'); await flush();
  const payload = JSON.parse(app.salePosts()[0].options.body);
  await app.reply(app.salePosts()[0], {
    error: { code: 'SESSION_INVALID', message: 'La sesión no es válida o venció. Iniciá sesión nuevamente.' },
  }, 401);
  assert.equal(app.el('login-section').hidden, false);
  assert.equal(app.el('workspace').hidden, true);
  assert.equal(app.el('login-status').textContent, 'La sesión no es válida o venció. Iniciá sesión nuevamente.');
  assert.equal(app.el('login-status').dataset.error, 'false');
  assert.equal(app.el('save-success-icon').hidden, true, 'a refused write is never success');
  assert.equal(app.salePosts().length, 1, 'no automatic resubmission after the refused save');
  assert.equal(app.reads().length, 1, 'no read follows the refused save');
  assert.equal(app.el('product').value, 'Borrador sin guardar', 'the draft resumes unchanged after reauth');
  assert.equal(app.el('amount').value, '1500,10');
  assert.equal(app.el('sale-date').value, '2026-11-02');
  assert.ok(app.formInputs.every(input => !input.disabled || input.id === 'quantity'));
  app.el('login-form').emit('submit'); await flush();
  await app.reply(app.sessionPosts()[0], { status: 'authenticated' });
  assert.equal(app.el('workspace').hidden, false);
  assert.equal(app.reads().length, 2, 'reauth refreshes the selected day exactly once');
  assert.equal(app.salePosts().length, 1, 'reauth resends nothing');
  assert.match(app.reads()[1].url, /date=2026-11-03$/);
  await app.reply(app.reads()[1], { date: '2026-11-03', storage: 'supabase', sales: [] });
  app.el('sale-form').emit('submit'); await flush();
  assert.equal(app.salePosts().length, 2, 'only an explicit submit resends the draft');
  const retried = JSON.parse(app.salePosts()[1].options.body);
  assert.equal(retried.requestId, payload.requestId, 'the retained identity is reused');
  assert.equal(retried.product, 'Borrador sin guardar');
  assert.equal(retried.amount, '1500,10');
});

test('logout hides and clears the business data; a failed logout never fakes the anonymous state', async () => {
  const app = screen();
  await app.reply(app.reads()[0], { date: '2026-11-03', storage: 'supabase', sales: [sale('Visible', '7')] });
  assert.equal(app.el('storage-status').textContent, '', 'no storage badge on the proved session');
  assert.equal(app.el('logout').hidden, false, 'an authenticated read offers the logout');
  app.draft();
  app.el('sale-form').emit('submit'); await flush();
  await app.reply(app.salePosts()[0], { storage: 'supabase', sale: { date: '2026-11-02' }, replayed: false }, 201);
  await app.reply(app.reads()[1], { date: '2026-11-02', storage: 'supabase', sales: [sale('Nueva', '8')] });
  assert.equal(app.el('save-status').textContent, 'Venta guardada.');
  assert.equal(app.el('save-success-icon').hidden, false);
  app.el('logout').emit('click'); await flush();
  const del = app.sessionDels()[0];
  assert.equal(del.options.method, 'DELETE');
  assert.equal(app.el('list-status').textContent, 'Cerrando sesión…');
  await app.reply(del, {
    error: { code: 'SESSION_UNAVAILABLE', message: 'No se pudo contactar Supabase. Reintentá en unos momentos.' },
  }, 503);
  assert.equal(app.el('workspace').hidden, false, 'a failed logout keeps the authenticated screen');
  assert.equal(app.el('logout').hidden, false);
  assert.equal(app.el('login-section').hidden, true);
  assert.deepEqual(app.products(), ['Nueva'], 'rows are untouched by the failed logout');
  assert.equal(app.el('save-success-icon').hidden, false, 'the confirmed success is still true');
  assert.equal(app.el('list-status').dataset.error, 'true');
  await app.tick(60000);
  assert.equal(app.sessionDels().length, 1, 'no automatic logout retry over time');
  app.el('logout').emit('click'); await flush();
  await app.reply(app.sessionDels()[1], { status: 'anonymous' });
  assert.equal(app.el('workspace').hidden, true);
  assert.equal(app.el('login-section').hidden, false);
  assert.deepEqual(app.products(), [], 'rows are cleared, never merely hidden');
  assert.equal(app.el('daily-total').hidden, true, 'the total is hidden');
  assert.equal(app.el('daily-total-amount').textContent, '', 'the total amount is cleared');
  assert.equal(app.el('save-success-icon').hidden, true, 'the success treatment is cleared');
  assert.equal(app.el('save-status').textContent, '');
  assert.equal(app.el('list-status').textContent, '');
  assert.equal(app.el('login-password').value, '', 'the password field is cleared at logout');
  assert.equal(app.el('logout').hidden, true);
  assert.equal(app.reads().length, 2, 'logout triggers no read');
  assert.equal(app.sessionPosts().length, 0);
  assert.equal(app.salePosts().length, 1);
});

test('an authenticated reload (valid cookie) ships no open-test notice and fires no extra session request', async () => {
  const app = screen();
  assert.equal(app.el('open-test-warning'), null, 'the unsupported open-testing notice is gone from this production app');
  await app.reply(app.reads()[0], { date: '2026-11-03', storage: 'supabase', sales: [sale('Día cargado', '1')] });
  assert.equal(app.el('storage-status').textContent, '');
  assert.equal(app.el('logout').hidden, false);
  assert.deepEqual(app.products(), ['Día cargado'], 'the reload keeps ordinary boot read behavior');
  assert.equal(app.sessionPosts().length, 0, 'no session request beyond the data read');
  assert.equal(app.sessionDels().length, 0);
  await app.tick(60000);
  assert.equal(app.reads().length, 1, 'no polling after the authenticated boot read');
});

test('the boot screen ships no open-testing copy and sends zero session traffic', async () => {
  const app = screen();
  await app.reply(app.reads()[0], ledger(sale('Reba', 'Real 2')));
  assert.equal(app.el('open-test-warning'), null, 'no open-testing notice exists in the business production UI');
  assert.equal(app.el('storage-status').textContent, '');
  assert.equal(app.el('logout').hidden, false, 'a proven read offers logout without naming the backend');
  assert.equal(app.sessionPosts().length, 0);
  assert.equal(app.sessionDels().length, 0);
});

test('login markup matches the screen: panel language, labels, autocomplete, live status and no import surface', () => {
  assert.match(html, /<section id="login-section" class="entry login"[^>]*hidden>/);
  assert.match(html, /<label for="login-email">[^<]*<\/label>\s*<input id="login-email" [^>]*autocomplete="username"/);
  assert.match(html, /<label for="login-password">[^<]*<\/label>\s*<input id="login-password" [^>]*type="password"[^>]*autocomplete="current-password"/);
  assert.doesNotMatch(html, /id="login-password"[^>]*value=/, 'no password value is shipped');
  assert.match(html, /<button id="login-button" type="submit" aria-busy="false">Entrar<\/button>/);
  assert.match(html, /id="login-status" role="status" aria-live="polite" aria-atomic="true"/);
  assert.match(html, /<div class="workspace" id="workspace"[^>]*>/);
  assert.match(html, /<button id="logout" type="button" hidden>Cerrar sesión<\/button>/);
  assert.doesNotMatch(source, /sessionStorage|document\.cookie/);
  assert.equal((source.match(/localStorage/g) || []).length, 2, 'only the stand preference can use browser storage');
  assert.match(source, /getItem\(standKey\)/);
  assert.match(source, /setItem\(standKey, selectedStand\(\)\)/);
  assert.doesNotMatch(html, /\bimport\b|[Cc][Ss][Vv]/, 'no import surface appears anywhere');
  // v2 identity T1: the pre-filled business identity is the pochoclos one.
  assert.match(html, /id="login-email"[^>]*value="pochoclos\@negocio\.com"/);
  assert.doesNotMatch(html, /libreriamarta/, 'no v1 business identity ships in v2');
  assert.match(css, /\.login\s*\{/);
  assert.match(css, /#logout\s*\{/);
});

function openStock(app) {
  app.el('menu-button').emit('click');
  app.el('menu-stock').emit('click');
}

function rowActions(app, tableId, index) {
  const row = app.el(tableId).children[index];
  const cell = row.cells[row.cells.length - 1];
  return {
    cell, text: cell.textContent, confirm: cell.dataset.confirm,
    children: cell.children,
    buttons: cell.children.map(child => child.className === 'row-delete icon-button' || child.className === 'row-archive icon-button' ? 'destructive' : child.textContent),
  };
}

test('the app menu is the accessible switch between the sales and stock panels and closes on selection and Escape', async () => {
  // Hamburger menu markup: an accessible toggle button and two named entries.
  assert.match(html, /<button id="menu-button" type="button"[^>]*aria-haspopup="true"[^>]*aria-expanded="false"[^>]*aria-controls="app-menu"/);
  assert.match(html, /<nav id="app-menu"[^>]*aria-label="[^"]*"[^>]*hidden>/);
  assert.match(html, /<section id="stock-panel"[^>]*aria-labelledby="stock-title"[^>]*\bhidden[^>]*>/);

  const app = screen();
  assert.equal(app.el('menu-button').hidden, true, 'the menu appears only for a proven business session');
  await app.reply(app.reads()[0], ledger(sale('Ventas hoy')));
  assert.equal(app.el('menu-button').hidden, false);
  assert.equal(app.el('app-menu').hidden, true);
  app.el('menu-button').emit('click');
  assert.equal(app.el('app-menu').hidden, false, 'opening shows the two screens');
  assert.equal(app.el('menu-button').getAttribute('aria-expanded'), 'true');
  assert.equal(app.document.activeElement, app.el('menu-sales'), 'opening puts focus on the first entry');

  openStock(app); await flush();
  assert.equal(app.el('workspace').hidden, true, 'the sales panel yields to the stock one');
  assert.equal(app.el('stock-panel').hidden, false);
  assert.equal(app.el('app-menu').hidden, true, 'a selection closes the menu');
  assert.equal(app.el('menu-button').getAttribute('aria-expanded'), 'false');
  assert.equal(app.el('stock-table').getAttribute('aria-busy'), 'true');
  await app.reply(app.productGets()[0], catalogue(product('Bolsa', 1250, 10)));
  assert.equal(app.el('stock-table').getAttribute('aria-busy'), 'false', 'the stock listing done busy state');
  assert.equal(app.document.activeElement, app.el('stock-panel'), 'the stock panel takes focus on entry');
  assert.doesNotMatch(app.el('stock-status').textContent || '', /SUPABASE/);

  app.el('menu-button').emit('click');
  assert.equal(app.el('app-menu').hidden, false);
  app.el('menu-sales').emit('click'); await flush();
  assert.equal(app.el('workspace').hidden, false, 'sales choice returns to the ledger');
  assert.equal(app.el('stock-panel').hidden, true);
  assert.equal(app.el('app-menu').hidden, true);

  app.el('menu-button').emit('click');
  app.el('app-menu').emit('keydown', { key: 'Escape' });
  assert.equal(app.el('app-menu').hidden, true, 'Escape closes the open menu');
  assert.equal(app.el('menu-button').getAttribute('aria-expanded'), 'false');
  assert.equal(app.document.activeElement, app.el('menu-button'), 'Escape returns focus to the toggle');
});

test('the stock screen lists every product when opened, then creates and modifies with the exact previous snapshot, honest notices and no technical badges', async () => {
  const app = screen();
  await app.reply(app.reads()[0], ledger());
  openStock(app); await flush();
  await app.reply(app.productGets()[0], catalogue(
    product('Bolsa', 1250, 10, {}, '21111111-1111-4111-8111-111111111111'),
    product('Recibo viejo', null, 0, { archived: true }, '21111111-1111-4111-8111-222222222222'),
  ));
  const rows = app.el('products').children;
  assert.equal(rows.length, 2);
  assert.equal(rows[0].cells[0].textContent, 'Bolsa');
  assert.equal(rows[0].cells[1].textContent, '$ 12,50');
  assert.equal(rows[0].cells[2].textContent, '10');
  assert.equal(rowActions(app, 'products', 0).buttons.filter(t => t === 'destructive').length, 1);
  assert.equal(rows[1].cells[0].textContent, 'Recibo viejo · Archivado', 'the archived flag is business-visible');
  assert.match(rows[1].cells[0].textContent, /Recibo viejo/);
  assert.equal(rows[1].cells[1].textContent, '—', 'no price stays empty');
  assert.equal(rowActions(app, 'products', 1).buttons.length, 0, 'an archived product is read-only');

  // Create.
  app.el('stock-name').value = 'Caramelos';
  app.el('stock-price').value = '8,50';
  app.el('stock-stock').value = '4';
  app.el('stock-form').emit('submit'); await flush();
  assert.deepEqual(JSON.parse(app.productPosts()[0].options.body), { name: 'Caramelos', price: '8,50', stock: 4 });
  assert.equal(app.el('stock-status').textContent, 'Guardando…');
  await app.reply(app.productPosts()[0], { storage: 'supabase', product: product('Caramelos', 850, 4, {}, '21111111-1111-4111-8111-333333333333') }, 201);
  assert.equal(app.el('stock-status').textContent, 'Producto guardado.');
  assert.equal(app.el('stock-button').textContent, 'Guardar producto', 'the form returns to create mode');
  assert.equal(app.el('stock-cancel').hidden, true);
  assert.equal(app.el('stock-name').value, '', 'a created product clears the form');
  assert.equal(app.el('stock-price').value, '');
  assert.equal(app.el('stock-stock').value, '0');
  assert.equal(app.productGets().length, 2, 'the confirmed create refreshes the shown list exactly once');
  await app.reply(app.productGets()[1], catalogue(
    product('Bolsa', 1250, 10, {}, '21111111-1111-4111-8111-111111111111'),
    product('Caramelos', 850, 4, {}, '21111111-1111-4111-8111-333333333333'),
  ));
  assert.deepEqual(app.el('products').children.map(row => row.cells[0].textContent), ['Bolsa', 'Caramelos']);
  await app.tick(60000);
  assert.equal(app.productGets().length, 2, 'no polling ever re-reads the stock list');

  // Modify with the observed previous row (full CAS entries).
  const edit = rowActions(app, 'products', 0).children.find(button => button.getAttribute('aria-label')?.startsWith('Modificar '));
  edit.emit('click');
  assert.equal(app.document.activeElement, app.el('stock-name'), 'editing a product focuses its name');
  assert.equal(app.el('stock-name').value, 'Bolsa');
  assert.equal(app.el('stock-price').value, '12,50');
  assert.equal(app.el('stock-stock').value, '10');
  assert.equal(app.el('stock-stock').disabled, false);
  app.el('stock-stock').value = '-2';
  app.el('stock-form').emit('submit'); await flush();
  const put = app.productPuts()[0];
  assert.deepEqual(JSON.parse(put.options.body), {
    id: '21111111-1111-4111-8111-111111111111',
    previous: { id: '21111111-1111-4111-8111-111111111111', name: 'Bolsa', priceCents: 1250, stock: 10 },
    name: 'Bolsa', price: '12,50', stock: -2,
  });
  await app.reply(put, { storage: 'supabase', product: product('Bolsa', 1250, -2) }, 200);
  assert.equal(app.el('stock-status').textContent, 'Producto modificado.');
  // Like an edit in the sales ledger, the form returns to the pre-edit draft.
  assert.equal(app.el('stock-name').value, '');
  assert.equal(app.el('stock-button').textContent, 'Guardar producto');
  assert.equal(app.el('stock-cancel').hidden, true);
});

test('a negative stock change is a deliberate confirmation: first the 409, then the explicit allowNegative put', async () => {
  const app = screen();
  await app.reply(app.reads()[0], ledger());
  openStock(app); await flush();
  await app.reply(app.productGets()[0], catalogue(product('Bolsa', 1250, 3, {}, '21111111-1111-4111-8111-111111111111')));
  const edit = rowActions(app, 'products', 0).children.find(button => button.getAttribute('aria-label')?.startsWith('Modificar '));
  edit.emit('click');
  app.el('stock-stock').value = '-2';
  app.el('stock-form').emit('submit'); await flush();
  const refused = app.productPuts()[0];
  await app.reply(refused, {
    error: { code: 'INSUFFICIENT_STOCK', message: 'STOCK_INSUFICIENTE: stock=3, solicitado=5' },
  }, 409);
  assert.equal(app.el('stock-negative-confirm').hidden, false, 'the explicit confirm appears in the app');
  assert.match(app.el('stock-status').textContent, /stock=3, solicitado=5/, 'the server numbers reach the notice');
  assert.equal(app.el('stock-name').value, 'Bolsa', 'the draft stays unchanged behind the confirm');
  assert.equal(app.el('stock-stock').value, '-2');
  app.el('stock-negative-confirm').emit('click'); await flush();
  const confirmed = app.productPuts()[1];
  const body = JSON.parse(confirmed.options.body);
  assert.equal(body.id, JSON.parse(refused.options.body).id, 'the same product row is retried');
  assert.equal(body.allowNegative, true, 'the explicit acknowledgement travels in the retry');
  assert.deepEqual(body.previous, JSON.parse(refused.options.body).previous, 'same content, same observed snapshot');
  await app.reply(confirmed, { storage: 'supabase', product: product('Bolsa', 1250, -2) }, 200);
  assert.equal(app.el('stock-negative-confirm').hidden, true, 'a confirmed outcome clears the pending confirm');
  // A later edit is a fresh decision: the allowance is never sticky.
  const editAgain = rowActions(app, 'products', 0).children.find(button => button.getAttribute('aria-label')?.startsWith('Modificar '));
  editAgain.emit('click');
  app.el('stock-stock').value = '-2';
  app.el('stock-form').emit('submit'); await flush();
  const later = JSON.parse(app.productPuts()[2].options.body);
  assert.equal(later.allowNegative, undefined, 'a later edit is a fresh decision, not sticky allowance');
  assert.equal(later.stock, -2);
});

test('the stock edit refusal leaves the stale-name duplicate to the server: a lost race is an honest error and nothing else', async () => {
  const app = screen();
  await app.reply(app.reads()[0], ledger());
  openStock(app); await flush();
  await app.reply(app.productGets()[0], catalogue(product('Bolsa', 1250, 10, {}, '21111111-1111-4111-8111-111111111111')));
  const edit = rowActions(app, 'products', 0).children.find(button => button.getAttribute('aria-label')?.startsWith('Modificar '));
  edit.emit('click');
  app.el('stock-name').value = 'Caramelos';
  app.el('stock-form').emit('submit'); await flush();
  await app.reply(app.productPuts()[0], {
    error: { code: 'PRODUCT_CONFLICT', message: 'Ya existe un producto activo con ese nombre.' },
  }, 409);
  assert.equal(app.el('stock-status').textContent, 'Ya existe un producto activo con ese nombre. Los datos siguen en el formulario.', 'the loss passes through with the keep-what-you-typed tail');
  assert.equal(app.el('stock-status').dataset.error, 'true');
  assert.equal(app.el('stock-name').value, 'Caramelos', 'the retype stays for correction');
  assert.equal(app.productGets().length, 1, 'a refused put triggers no automatic list read');
  // Only an explicit submit retries.
  app.el('stock-form').emit('submit'); await flush();
  assert.equal(app.productPuts().length, 2);
  assert.equal(JSON.parse(app.productPuts()[1].options.body).name, 'Caramelos');
});

test('archiving a product is an in-app confirmed archive that preserves the sale history steps and the stock snapshot', async () => {
  const app = screen();
  await app.reply(app.reads()[0], ledger());
  openStock(app); await flush();
  await app.reply(app.productGets()[0], catalogue(
    product('Bolsa', 1250, 10, {}, '21111111-1111-4111-8111-111111111111'),
    product('Cuaderno', 500, 2, {}, '21111111-1111-4111-8111-222222222222'),
  ));
  const trash = rowActions(app, 'products', 0).children.find(button => button.getAttribute('aria-label')?.startsWith('Archivar '));
  trash.emit('click');
  const confirm = rowActions(app, 'products', 0).cell;
  assert.equal(confirm.dataset.confirm, 'true');
  assert.equal(confirm.textContent, '¿Archivar?');
  const cancel = confirm.children.find(child => child.textContent === 'Cancelar');
  cancel.emit('click');
  assert.equal(rowActions(app, 'products', 0).cell.dataset.confirm, 'false', 'cancel returns to the quiet icon');
  trash.emit('click');
  const yes = rowActions(app, 'products', 0).cell.children.find(child => child.textContent === '¡Sí, archivar!');
  assert.equal(rowActions(app, 'products', 1).cell.dataset.confirm, 'false', 'one confirm at a time across rows');
  yes.emit('click'); await flush();
  assert.equal(app.el('stock-status').textContent, 'Archivando…');
  const del = app.productDels()[0];
  assert.deepEqual(JSON.parse(del.options.body), {
    id: '21111111-1111-4111-8111-111111111111',
    previous: { stock: 10 },
  });
  await app.reply(del, { storage: 'supabase', product: product('Bolsa', 1250, 10, { archived: true }) }, 200);
  assert.equal(app.el('stock-status').textContent, 'Producto archivado. Sus ventas anteriores quedan intactas.');
  assert.equal(app.productGets().length, 2, 'the confirmed archive reads the list once more');
  await app.reply(app.productGets()[1], catalogue(product('Bolsa', 1250, 10, { archived: true }), product('Cuaderno', 500, 2)));
  assert.equal(rowActions(app, 'products', 0).buttons.length, 0, 'the archived row loses every action');

  // A product removed elsewhere stays an honest 404.
  const trash2 = rowActions(app, 'products', 1).children.find(button => button.getAttribute('aria-label')?.startsWith('Archivar '));
  trash2.emit('click');
  rowActions(app, 'products', 1).cell.children.find(child => child.textContent === '¡Sí, archivar!').emit('click');
  await flush();
  await app.reply(app.productDels()[1], { error: { code: 'NOT_FOUND', message: 'El producto ya no existe o se archivó desde otro dispositivo.' } }, 404);
  assert.equal(app.el('stock-status').textContent, 'No pudimos archivar el producto. Ya no existe o se archivó desde otro dispositivo.');
});

test('product suggestions come from the stock list: choosing an existing active product links it, sets quantity 1 and lets the price prefill the amount', async () => {
  const app = screen();
  assert.equal(app.el('sale-date').value, '2026-11-03');
  assert.equal(app.el('quantity').value, '1');
  assert.equal(app.el('quantity').disabled, true, 'a free-text sale has no quantity decision yet');
  await app.reply(app.reads()[0], ledger());
  app.el('product').value = 'bol';
  app.el('product').emit('input'); await flush();
  assert.equal(app.productGets().length, 1, 'the first typed query reads the catalogue once');
  await app.reply(app.productGets()[0], catalogue(
    product('Bolsa', 1250, 7, {}, '11111111-1111-4111-8111-000000000001'),
    product('Bolígrafo', null, 2, {}, '11111111-1111-4111-8111-000000000002'),
    product('Bolsón viejo', 100, 1, { archived: true }, '11111111-1111-4111-8111-000000000003'),
  ));
  const listbox = app.el('product-listbox');
  assert.equal(listbox.hidden, false);
  assert.equal(app.el('product').getAttribute('aria-expanded'), 'true');
  const names = listbox.children.map(li => li.children[0].textContent);
  assert.deepEqual(names, ['Bolsa', 'Bolígrafo'], 'archived products are never suggested');
  const bolsa = listbox.children[0];
  assert.equal(bolsa.getAttribute('role'), 'option');

  bolsa.emit('click'); await flush();
  assert.equal(app.el('product').value, 'Bolsa');
  assert.equal(app.el('product-listbox').hidden, true, 'a selection closes the suggestion list');
  assert.equal(app.el('quantity').disabled, false);
  assert.equal(app.el('quantity').value, '1', 'a selected product defaults quantity 1');
  assert.equal(app.el('amount').value, '12,50', 'the optional price prefills the amount with qty × price');
  assert.equal(app.el('save-feedback').dataset.success, 'false');

  app.el('quantity').value = '3';
  app.el('quantity').emit('input');
  assert.equal(app.el('amount').value, '37,50', 'quantity updates the amount immediately using integer-cent price');
  app.el('sale-form').emit('submit'); await flush();
  const payload = JSON.parse(app.salePosts()[0].options.body);
  assert.equal(payload.productId, '11111111-1111-4111-8111-000000000001');
  assert.equal(payload.quantity, 3);
  assert.equal(payload.amount, '37,50', 'the submitted total is quantity multiplied by the selected product price');
  assert.equal(payload.allowNegative, undefined, 'a normal sale never claims the negative allowance');
  await app.reply(app.salePosts()[0], { storage: 'supabase', sale: { date: '2026-11-02' }, replayed: false }, 201);
  await flush();
});

test('typing over a selected product clears the link, so a free-text sale always stays quantity 1 and safe', async () => {
  const app = screen();
  await app.reply(app.reads()[0], ledger());
  app.el('product').value = 'Bols';
  app.el('product').emit('input'); await flush();
  await app.reply(app.productGets()[0], catalogue(product('Bolsa', 1250, 7, {}, '11111111-1111-4111-8111-000000000001')));
  app.el('product-listbox').children[0].emit('click'); await flush();
  assert.equal(app.el('amount').value, '12,50');
  app.el('product').value = 'Bolsa grande casera';
  app.el('product').emit('input');
  assert.equal(app.el('quantity').disabled, true, 'a free-text draft parks quantity at 1');
  assert.equal(app.el('quantity').value, '1');
  assert.equal(app.el('product').getAttribute('aria-expanded'), 'false', 'a later narrowed query may reopen the list, but the link is gone');
  app.draft();
  app.el('sale-form').emit('submit'); await flush();
  const payload = JSON.parse(app.salePosts()[0].options.body);
  assert.deepEqual(payload, {
    requestId: payload.requestId, date: '2026-11-02', product: 'Borrador sin guardar', payment: 'transferencia',
    amount: '1500,10', productId: null, quantity: 1, stand: 'fixed',
  }, 'a free-text sale relinked nothing despite a matching product name');
});

test('editing a linked sale keeps the historical snapshot: the previous row keeps id and quantity and typing never relinks by name', async () => {
  const linked = sale('Bolsa', '9', {
    productId: '11111111-1111-4111-8111-000000000001', quantity: 3, amountCents: 5000, payment: 'efectivo', date: '2026-11-03',
  });
  const app = screen();
  await app.reply(app.reads()[0], ledger(linked));
  editFirst(app);
  assert.equal(app.el('product').value, 'Bolsa');
  assert.equal(app.el('quantity').disabled, false);
  assert.equal(app.el('quantity').value, '3', 'the historical quantity comes back editable');
  app.el('quantity').value = '2';
  app.el('quantity').emit('input');
  assert.equal(app.el('amount').value, '50,00', 'editing history does not invent a current unit price');
  app.el('sale-form').emit('submit'); await flush();
  const put = app.puts()[0];
  assert.deepEqual(JSON.parse(put.options.body), {
    requestId: '9', date: '2026-11-03', product: 'Bolsa', payment: 'efectivo', amount: '50,00',
    productId: '11111111-1111-4111-8111-000000000001', quantity: 2,
    previous: {
      requestId: '9', date: '2026-11-03', product: 'Bolsa', payment: 'efectivo', amount: '50,00',
      productId: '11111111-1111-4111-8111-000000000001', quantity: 3,
    },
  });
  await app.reply(put, { storage: 'supabase', sale: { ...linked, date: '2026-11-02' } }, 200);
  await flush();
  await app.reply(app.salesReads()[1], ledger(linked));
  editFirst(app);
  app.el('product').value = 'Bolsón'; // exactly the historical rule: name never relinks
  app.el('product').emit('input'); await flush(); // a typed change unlinks, like a real keystroke
  app.el('sale-form').emit('submit'); await flush();
  const renamed = JSON.parse(app.puts()[1].options.body);
  assert.equal(renamed.productId, null, 'an edited name becomes free text, never a name lookup');
  assert.equal(renamed.quantity, 1, 'a free-text edit parks quantity at 1');
  assert.deepEqual(renamed.previous.productId, '11111111-1111-4111-8111-000000000001');
  assert.deepEqual(renamed.previous.quantity, 3, 'the previous snapshot stays the observed history');
  await app.reply(app.puts()[1], { storage: 'supabase', sale: { ...linked, date: '2026-11-02' } }, 200);
  await flush();
  await app.reply(app.salesReads()[2], ledger(linked));
  // And the delete carries the same full observed row.
  app.el('cancel-edit').emit('click');
  const trash = app.el('sales').children[0].cells[3].children[0];
  trash.emit('click');
  app.el('sales').children[0].cells[3].children[0].emit('click'); // ¡Sí, borrar!
  await flush();
  const del = app.dels()[0];
  assert.deepEqual(JSON.parse(del.options.body), { id: '9', previous: {
    requestId: '9', date: '2026-11-03', product: 'Bolsa', payment: 'efectivo', amount: '50,00',
    productId: '11111111-1111-4111-8111-000000000001', quantity: 3,
  } });
});

test('announced-insufficiency sale flow keeps the draft and retries the same requestId with an explicit allowNegative true', async () => {
  const app = screen();
  await app.reply(app.reads()[0], ledger());
  app.el('product').value = 'Bols';
  app.el('product').emit('input'); await flush();
  await app.reply(app.productGets()[0], catalogue(product('Bolsa', 1250, 7, {}, '11111111-1111-4111-8111-000000000001')));
  app.el('product-listbox').children[0].emit('click'); await flush();
  app.el('quantity').value = '5';
  app.el('sale-form').emit('submit'); await flush();
  const refused = app.salePosts()[0];
  const first = JSON.parse(refused.options.body);
  await app.reply(refused, { error: { code: 'INSUFFICIENT_STOCK', message: 'STOCK_INSUFICIENTE: stock=7, solicitado=12' } }, 409);
  assert.equal(app.el('negative-confirm').hidden, false, 'the in-app explicit confirm appears');
  assert.match(app.el('save-status').textContent, /stock=7, solicitado=12/, 'the server numbers reach the notice');
  assert.equal(app.el('product').value, 'Bolsa');
  assert.equal(app.el('quantity').value, '5');
  assert.equal(app.el('amount').value, '12,50', 'the refused draft keeps every value');
  assert.equal(app.salesReads().length, 1, 'a refused sale triggers no automatic ledger read');
  app.el('negative-confirm').emit('click'); await flush();
  const retried = app.salePosts()[1];
  const second = JSON.parse(retried.options.body);
  assert.equal(second.requestId, first.requestId, 'the SAME sale identity retries');
  const restOfSecond = { ...second };
  delete restOfSecond.allowNegative;
  assert.deepEqual(restOfSecond, first, 'same content otherwise');
  assert.equal(second.allowNegative, true, 'the explicit acknowledgement is the only delta');
  await app.reply(retried, { storage: 'supabase', sale: { date: '2026-11-02' }, replayed: false }, 201);
  assert.equal(app.el('save-status').textContent, 'Venta guardada.');
  assert.equal(app.el('negative-confirm').hidden, true);
  assert.equal(app.productGets().length, 2, 'an acknowledged linked sale refreshes the cached stock so the next suggestion is fresh');
});

test('a changed draft voids the negative-stock confirm instead of consenting for it', async () => {
  const app = screen();
  await app.reply(app.reads()[0], ledger());
  app.el('product').value = 'Bols';
  app.el('product').emit('input'); await flush();
  await app.reply(app.productGets()[0], catalogue(product('Bolsa')));
  app.el('product-listbox').children[0].emit('click'); await flush();
  app.el('sale-form').emit('submit'); await flush();
  await app.reply(app.salePosts()[0], { error: { code: 'INSUFFICIENT_STOCK', message: 'STOCK_INSUFICIENTE: stock=0, solicitado=1' } }, 409);
  assert.equal(app.el('negative-confirm').hidden, false);
  const identity = JSON.parse(app.salePosts()[0].options.body).requestId;
  app.el('amount').value = '9999,00'; // any later modification kills the consent
  app.el('sale-form').emit('submit'); await flush();
  assert.equal(app.el('negative-confirm').hidden, true, 'edits clear the pending confirmation');
  assert.equal(app.salePosts().length, 2);
  const edited = JSON.parse(app.salePosts()[1].options.body);
  assert.equal(edited.allowNegative, undefined, 'the edited sale never inherits the allowance');
  assert.equal(edited.amount, '9999,00');
  await app.reply(app.salePosts()[1], { error: { code: 'INSUFFICIENT_STOCK', message: 'STOCK_INSUFICIENTE: stock=0, solicitado=1' } }, 409);
  assert.equal(app.el('negative-confirm').hidden, false, 'a refused edit can be confirmed anew');
  app.el('negative-confirm').emit('click'); await flush();
  const retried = JSON.parse(app.salePosts()[2].options.body);
  assert.equal(retried.requestId, identity, 'the request id stays with the draft through both refusals');
  assert.equal(retried.amount, '9999,00');
  assert.equal(retried.allowNegative, true);
});

// S7: 'Actualizando…' shows exactly while a real Supabase-backed call is being
// awaited through the shared api() wrapper — and clears on every settle path.
test('the Actualizando indicator is live only while a request is awaited: success, HTTP error, network error and unreadable body all clear it', async () => {
  const app = screen();
  syncing(app, true, 'the boot read is genuinely awaited');
  await app.reply(app.reads()[0], ledger(sale('Normal')));
  syncing(app, false, 'no idle label survives the settled read');
  assert.equal(app.el('list-status').textContent, 'Listado actualizado.', 'the queue copy is not a second loader');
  busy(app, false);

  // An HTTP error answer is still one awaited call that has settled.
  app.el('list-date').value = '2026-11-01'; app.el('list-date').emit('change'); await flush();
  syncing(app, true);
  await app.reply(app.reads()[1], { error: { message: 'Cualquiera' } }, 503);
  syncing(app, false, 'an HTTP error clears the indicator too');

  // A network failure clears it as well; rows stay honest.
  app.el('list-date').value = '2026-11-02'; app.el('list-date').emit('change'); await flush();
  syncing(app, true);
  app.reads()[2].reject(new Error('Respuesta perdida')); await flush();
  syncing(app, false, 'a network error clears the indicator');

  // An unreadable body is still one awaited call that has settled.
  app.el('list-date').value = '2026-11-03'; app.el('list-date').emit('change'); await flush();
  syncing(app, true);
  const unreadable = Object.create(null, { sales: { get() { throw new Error('respuesta no parseable'); } } });
  await app.reply(app.reads()[3], unreadable);
  syncing(app, false, 'a body error clears the indicator');
  assert.equal(app.el('list-status').textContent, failure);
  assert.equal(app.el('list-status').dataset.error, 'true');
});


test('the Actualizando indicator survives a settle only while another call is still awaited (reads + catalogue overlap and the post-save refresh)', async () => {
  const app = screen();
  const boot = app.reads()[0];
  app.el('product').value = 'Bols';
  app.el('product').emit('input'); await flush();
  assert.equal(app.productGets().length, 1);
  syncing(app, true, 'boot read and catalogue read are both awaited');
  await app.reply(app.productGets()[0], catalogue(product('Bolsa')));
  syncing(app, true, 'the boot read is still awaited after the catalogue settles');
  await app.reply(boot, ledger());
  syncing(app, false, 'hides only after the last outstanding call settles');

  app.draft();
  app.el('sale-form').emit('submit'); await flush();
  assert.equal(app.posts().length, 1);
  syncing(app, true, 'the save POST is awaited');
  assert.equal(app.el('save-status').textContent, 'Guardando venta…', 'the operation keeps its own copy');
  await app.reply(app.posts()[0], { storage: 'blob', sale: { date: '2026-11-02' }, replayed: false }, 201);
  await flush();
  // The acknowledged save starts both refresh calls, so the real await count
  // is two before either settles.
  assert.equal(app.salesReads().length, 2);
  assert.equal(app.productGets().length, 2);
  syncing(app, true, 'the post-save refreshes (list and stock) are awaited');
  busy(app, true);
  await app.reply(app.salesReads()[1], ledger(sale('Ya guardada')));
  syncing(app, true, 'the stock refresh is still awaited after the list read settles');
  await app.reply(app.productGets()[1], catalogue(product('Bolsa')));
  syncing(app, false, 'hides when the last refresh settles');
  busy(app, false);
  assert.equal(app.el('save-status').textContent, 'Venta guardada.');
});

test('the 12s deadline aborts the awaited read and settles the indicator exactly once, with no restart and no polling', async () => {
  const app = screen();
  await app.reply(app.reads()[0], ledger(sale('Anterior')));
  syncing(app, false);
  app.el('list-date').value = '2026-11-01'; app.el('list-date').emit('change'); await flush();
  const pending = app.reads()[1];
  syncing(app, true, 'the changed-day read is awaited');
  await app.tick(11999);
  syncing(app, true, 'nothing expires early: the deadline alone settles it');
  await app.tick(1);
  assert.equal(pending.options.signal.aborted, true, 'the deadline aborts the read');
  syncing(app, false, 'the aborted await settles and the indicator clears');
  assert.equal(app.el('list-status').textContent, failure);
  await app.tick(60000);
  assert.equal(app.reads().length, 2, 'one settle clears once: nothing restarts over time');
  syncing(app, false);
});

test('an aborted read stays counted until it settles and the queued replacement keeps the indicator live', async () => {
  const app = screen();
  const boot = app.reads()[0]; boot.ignoreAbort = true; // a slow first-day answer
  app.el('list-date').value = '2026-11-01'; app.el('list-date').emit('change');
  await flush();
  syncing(app, true, 'the aborted old read is still counted until its await settles');
  assert.equal(boot.options.signal.aborted, true);
  await app.reply(boot, ledger(sale('Obsoleto')));
  await flush();
  syncing(app, true, 'the replacement read started: each settle is counted once');
  assert.equal(app.reads().length, 2, 'exactly one replacement GET started');
  await app.reply(app.reads()[1], ledger(sale('Elegida')));
  syncing(app, false);
  assert.equal(app.el('list-status').textContent, 'Listado actualizado.');
});

test('the anonymous gate hides every awaited call: no Actualizando over the login screen, which keeps its own Entrando copy', async () => {
  const app = screen();
  const boot = app.reads()[0];
  app.el('product').value = 'Bols'; app.el('product').emit('input'); await flush();
  syncing(app, true, 'both calls are real, but the panels are still shown');
  await app.reply(boot, { error: { message: 'Iniciá sesión para continuar.' } }, 401);
  assert.equal(app.el('login-section').hidden, false);
  syncing(app, false, 'the gate hides business traffic even while the catalogue call is still pending', true);
  await app.reply(app.productGets()[0], catalogue(product('Bolsa')));
  syncing(app, false, 'a fully settled screen behind the gate stays quiet');
  app.el('login-password').value = 'contraseña-sintética-de-prueba';
  app.el('login-form').emit('submit'); await flush();
  syncing(app, false, 'the login POST is counted but never shown as Actualizando', true);
  assert.equal(app.el('login-status').textContent, 'Comprobando la sesión…', 'login keeps its own operation copy');
  await app.reply(app.sessionPosts()[0], { status: 'authenticated' });
  syncing(app, true, 'the post-login read is awaited on the returned panels');
  await app.reply(app.salesReads()[1], ledger(sale('Real')));
  syncing(app, false);
});

test('stand UI: a fresh device chooses explicitly, remembers only its own choice and freezes it in flight', async () => {
  assert.match(html, /name="stand"/);
  const app = screen({ storage: new Map() });
  await app.reply(app.reads()[0], ledger());
  app.draft();
  app.el('sale-form').emit('submit'); await flush();
  assert.equal(app.posts().length, 0);
  assert.equal(app.el('save-status').textContent, 'Elegí Puesto fijo o Móvil.');
  app.el('stand-mobile').checked = true;
  app.el('stand-mobile').emit('change');
  app.el('sale-form').emit('submit'); await flush();
  assert.equal(JSON.parse(app.posts()[0].options.body).stand, 'mobile');
  assert.equal(app.el('stand-mobile').disabled, true);
  assert.equal(app.storage.get('pochoclos-v2:stand'), 'mobile');
  await app.reply(app.posts()[0], { error: { message: 'Sin conexión' } }, 503);
  assert.equal(app.el('stand-mobile').checked, true);
  assert.equal(app.el('stand-mobile').disabled, false);
  const reloaded = screen({ storage: app.storage });
  assert.equal(reloaded.el('stand-mobile').checked, true);
});

test('stand UI: every row shows its stored stand regardless of the device preference', async () => {
  const a = screen(), b = screen({ storage: new Map([['pochoclos-v2:stand', 'mobile']]) });
  const data = ledger(sale('Fijo', 'a', { stand: 'fixed' }), sale('Móvil', 'b', { stand: 'mobile' }), sale('Anterior', 'c'));
  for (const app of [a, b]) {
    await app.reply(app.reads()[0], data);
    assert.deepEqual(app.el('sales').children.map(row => row.cells[0].children[0]?.textContent), ['Puesto fijo', 'Móvil', 'Sin puesto']);
  }
  assert.equal(a.el('stand-fixed').checked, true);
  assert.equal(b.el('stand-mobile').checked, true);
  b.el('stand-fixed').checked = true; b.el('stand-mobile').checked = false;
  b.el('stand-fixed').emit('change');
  assert.equal(a.storage.get('pochoclos-v2:stand'), 'fixed');
});

test('stand UI: edit/cancel preserves device preference and sends observed stand in CAS', async () => {
  const app = screen();
  const original = sale('Venta móvil', '00000000-0000-4000-8000-000000000005', { date: '2026-11-02', stand: 'mobile' });
  await app.reply(app.reads()[0], ledger(original));
  app.el('sales').children[0].cells[3].children.find(button => button.getAttribute('title') === 'Modificar venta').emit('click');
  assert.equal(app.el('stand-mobile').checked, true);
  app.el('cancel-edit').emit('click');
  assert.equal(app.el('stand-fixed').checked, true);
  app.el('sales').children[0].cells[3].children.find(button => button.getAttribute('title') === 'Modificar venta').emit('click');
  app.el('stand-fixed').checked = true; app.el('stand-mobile').checked = false;
  app.el('stand-fixed').emit('change');
  app.el('sale-form').emit('submit'); await flush();
  const payload = JSON.parse(app.puts()[0].options.body);
  assert.equal(payload.stand, 'fixed'); assert.equal(payload.previous.stand, 'mobile');
  assert.equal(app.storage.get('pochoclos-v2:stand'), 'fixed');
});

test('stand UI: invalid or blocked preference storage never prevents an explicit sale', async () => {
  for (const storage of [new Map([['pochoclos-v2:stand', 'invalid']]), {
    get() { throw new Error('Storage blocked'); }, set() { throw new Error('Storage blocked'); },
  }]) {
    const app = screen({ storage });
    await app.reply(app.reads()[0], ledger());
    assert.equal(app.el('stand-fixed').checked, false);
    assert.equal(app.el('stand-mobile').checked, false);
    app.el('stand-fixed').checked = true; app.el('stand-fixed').emit('change');
    app.draft(); app.el('sale-form').emit('submit'); await flush();
    assert.equal(JSON.parse(app.posts()[0].options.body).stand, 'fixed');
    await app.reply(app.posts()[0], { sale: sale('Guardada', '1', { stand: 'fixed' }) });
    assert.equal(app.el('stand-fixed').checked, true, 'a confirmed save retains the explicit choice');
    assert.equal(app.el('product').value, '');
    assert.equal(app.el('save-status').textContent, 'Venta guardada.');
  }
});

test('stand UI: changing stand voids negative-stock consent; explicit retry keeps stand and request identity', async () => {
  const app = screen();
  await app.reply(app.reads()[0], ledger()); app.draft();
  app.el('sale-form').emit('submit'); await flush();
  const initial = JSON.parse(app.posts()[0].options.body);
  const refusal = { error: { code: 'INSUFFICIENT_STOCK', message: 'Stock insuficiente.' } };
  await app.reply(app.posts()[0], refusal, 409);
  assert.equal(app.el('negative-confirm').hidden, false);
  app.el('stand-fixed').checked = false; app.el('stand-mobile').checked = true;
  app.el('stand-mobile').emit('change');
  assert.equal(app.el('negative-confirm').hidden, true);
  app.el('negative-confirm').emit('click'); await flush();
  assert.equal(app.posts().length, 1, 'stale consent sends nothing');
  app.el('sale-form').emit('submit'); await flush();
  assert.equal(JSON.parse(app.posts()[1].options.body).stand, 'mobile');
  await app.reply(app.posts()[1], refusal, 409);
  app.el('negative-confirm').emit('click'); await flush();
  const retry = JSON.parse(app.posts()[2].options.body);
  assert.equal(retry.requestId, initial.requestId);
  assert.equal(retry.stand, 'mobile'); assert.equal(retry.allowNegative, true);
  assert.deepEqual([...app.storage], [['pochoclos-v2:stand', 'mobile']], 'only the non-secret enum is persisted');
});

test('sale quantity: every ledger row shows its stored quantity, with one for legacy rows', async () => {
  const app = screen();
  await app.reply(app.reads()[0], ledger(sale('Caja', 'a', { quantity: 3, stand: 'fixed' }), sale('Bolsa', 'b', { quantity: 2, stand: 'mobile' }), sale('Anterior', 'c')));
  assert.deepEqual(app.el('sales').children.map(row => row.cells[0].children[1]?.textContent), ['Cantidad: 3', 'Cantidad: 2', 'Cantidad: 1']);
  assert.deepEqual(app.el('sales').children.map(row => row.cells[0].children[0]?.textContent), ['Puesto fijo', 'Móvil', 'Sin puesto']);
  assert.equal(app.el('sales').children[0].cells.length, 4, 'quantity does not add horizontal columns or displace actions');
});

test('automatic amount: unpriced products and deliberate manual amounts remain editable', async () => {
  for (const price of [null, 1250]) {
    const app = screen(); await app.reply(app.reads()[0], ledger()); app.draft();
    app.el('product').value = 'Bol'; app.el('product').emit('input'); await flush();
    await app.reply(app.productGets()[0], catalogue(product('Bolsa', price, 10)));
    app.el('product-listbox').children[0].emit('click');
    app.el('amount').value = '42,00';
    app.el('quantity').value = '2'; app.el('quantity').emit('input');
    assert.equal(app.el('amount').value, price === null ? '42,00' : '25,00');
    app.el('amount').value = '30,00'; app.el('amount').emit('input');
    app.el('sale-form').emit('submit'); await flush();
    assert.equal(JSON.parse(app.posts()[0].options.body).amount, '30,00', 'a deliberate manual adjustment is not overwritten on submit');
  }
});

test('automatic amount: deliberately reselecting a product in an edit uses its price without changing the previous snapshot', async () => {
  const original = sale('Bolsa', '9', { amountCents: 5000, quantity: 3 });
  const app = screen(); await app.reply(app.reads()[0], ledger(original)); editFirst(app);
  assert.equal(app.el('amount').value, '50,00');
  app.el('product').value = 'Bol'; app.el('product').emit('input'); await flush();
  await app.reply(app.productGets()[0], catalogue(product('Bolsa', 1250, 10)));
  app.el('product-listbox').children[0].emit('click');
  app.el('quantity').value = '3'; app.el('quantity').emit('input');
  assert.equal(app.el('amount').value, '37,50');
  app.el('sale-form').emit('submit'); await flush();
  const payload = JSON.parse(app.puts()[0].options.body);
  assert.equal(payload.amount, '37,50'); assert.equal(payload.quantity, 3);
  assert.equal(payload.previous.amount, '50,00'); assert.equal(payload.previous.quantity, 3);
});
