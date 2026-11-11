import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

// T3 (odd/tasks/daily-stand-stock.md S1-S5): frontend tests for the daily
// stock view (date + stand), the load/replenish/copy actions with their CAS
// confirmations, and the daily sale opt-in. The VM harness is the same
// discipline as test/frontend.test.js (real markup ids and handlers, faked
// fetch responses, no server and no browser), extended additively so the
// fake network also accepts /api/stock-days without weakening assertions.

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
const dayRow = (productId, productName, stand, initialLoad, loaded, sold, extra = {}) =>
  ({ productId, product: productName, priceCents: null, stand, initialLoad, loaded, sold, available: loaded - sold, ...extra });
const dayList = (date, ...rows) => ({ date, currency: 'ARS', storage: 'supabase', rows });

// Same minimal DOM as the shared frontend harness: fields/events, status
// attributes and table cells only. No app internals, actual server, browser
// storage or network.
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
  if (elements.get('stock-day-form')) {
    elements.get('stock-day-form').querySelectorAll = () => formInputsOf('stock-day-form');
    elements.get('stock-day-form').reportValidity = () => true;
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
  const stockDayRows = makeTableBody();
  elements.set('stock-rows', stockDayRows);
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
      assert.match(url, /^\/api\/(?:sales(?:\?|$)|session$|products$|stock-days(?:\?|$))/, 'mock is the only network destination');
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
    dayReads: () => requests.filter(request => request.method === 'GET' && request.url.startsWith('/api/stock-days?')),
    dayPosts: () => requests.filter(request => request.url === '/api/stock-days' && request.method === 'POST'),
    productGets: () => requests.filter(request => request.url === '/api/products' && request.method === 'GET'),
    productPosts: () => requests.filter(request => request.url === '/api/products' && request.method === 'POST'),
    productPuts: () => requests.filter(request => request.url === '/api/products' && request.method === 'PUT'),
    posts: () => requests.filter(request => request.url === '/api/sales' && request.method === 'POST'),
    puts: () => requests.filter(request => request.url === '/api/sales' && request.method === 'PUT'),
    dels: () => requests.filter(request => request.url === '/api/sales' && request.method === 'DELETE'),
    sessionPosts: () => requests.filter(request => request.url === '/api/session' && request.method === 'POST'),
    stockInputs: formInputsOf('stock-form'),
    draft() {
      elements.get('sale-date').value = '2026-11-02';
      elements.get('product').value = 'Borrador sin guardar';
      elements.get('amount').value = '1500,10';
      formInputs.find(input => input.value === 'transferencia').checked = true;
      elements.get('product').focus();
    },
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
  };
}

function openStock(app) {
  app.el('menu-button').emit('click');
  app.el('menu-stock').emit('click');
}

const bolsasId = '21111111-1111-4111-8111-111111111111';
const caramelosId = '21111111-1111-4111-8111-222222222222';
const viejoId = '21111111-1111-4111-8111-333333333333';

// S1/S2: the daily view opens with one read of the selected date that returns
// BOTH stands, shows the selected date/stand visibly and keeps the other
// stand one control away without a second read.
test('the stock screen opens with one daily read for both stands and switching the view stand needs no second read', async () => {
  const app = screen();
  await app.reply(app.reads()[0], ledger());
  openStock(app); await flush();
  assert.equal(app.dayReads().length, 1, 'exactly one stock-days read when the panel opens');
  assert.equal(app.dayReads()[0].url, '/api/stock-days?date=2026-11-03');
  assert.equal(app.el('stock-date').value, '2026-11-03');
  await app.reply(app.dayReads()[0], dayList('2026-11-03',
    dayRow(bolsasId, 'Bolsas', 'fixed', 5, 5, 2),
    dayRow(bolsasId, 'Bolsas', 'mobile', 0, 0, 0),
  ));
  const fixedRows = app.el('stock-rows').children;
  assert.equal(fixedRows.length, 1, 'the view shows only the selected stand');
  assert.equal(fixedRows[0].cells[0].textContent, 'Bolsas');
  assert.deepEqual(fixedRows[0].cells.slice(1, 4).map(cell => cell.textContent), ['5', '2', '3'], 'cargado · vendido · disponible');
  assert.match(app.el('stock-day-caption').textContent, /03\/11\/2026/);
  assert.match(app.el('stock-day-caption').textContent, /Puesto fijo/);
  assert.equal(app.el('stock-view-fixed').checked, true, 'the selected view stand is visible');

  app.el('stock-view-mobile').checked = true;
  app.el('stock-view-fixed').checked = false;
  app.el('stock-view-mobile').emit('change'); await flush();
  assert.equal(app.dayReads().length, 1, 'the one read already carried both stands');
  const mobileRows = app.el('stock-rows').children;
  assert.deepEqual(mobileRows[0].cells.slice(1, 4).map(cell => cell.textContent), ['0', '0', '0'], 'the mobile view holds its own independent zeros');
  assert.match(app.el('stock-day-caption').textContent, /Móvil/);
  app.el('stock-view-fixed').checked = true; app.el('stock-view-mobile').checked = false;
  app.el('stock-view-fixed').emit('change'); await flush();
  assert.equal(app.dayReads().length, 1);
  assert.deepEqual(app.el('stock-rows').children[0].cells.slice(1, 4).map(cell => cell.textContent), ['5', '2', '3']);
});

// S1: date navigation reads the chosen day, clears the previous one and never
// lets an older in-flight answer paint over the newer intent.
test('a stock date change reads the chosen day, clears the old rows and ignores the stale answer', async () => {
  const app = screen();
  await app.reply(app.reads()[0], ledger());
  openStock(app); await flush();
  const firstRead = app.dayReads()[0];
  await app.reply(firstRead, dayList('2026-11-03', dayRow(bolsasId, 'Bolsas', 'fixed', 5, 5, 2)));
  assert.equal(app.el('stock-rows').children[0].cells[0].textContent, 'Bolsas');
  app.el('stock-date').value = '2026-11-01';
  app.el('stock-date').emit('change'); await flush();
  assert.equal(app.dayReads().length, 2, 'the changed date reads its own day');
  assert.equal(app.dayReads()[1].url, '/api/stock-days?date=2026-11-01');
  assert.equal(app.el('stock-rows').children.length, 0, 'another day’s rows never linger during the new read');
  await app.reply(app.dayReads()[1], dayList('2026-11-01', dayRow(bolsasId, 'Bolsas', 'fixed', 9, 9, 0)));
  assert.deepEqual(app.el('stock-rows').children[0].cells.slice(1, 4).map(cell => cell.textContent), ['9', '0', '9']);
  assert.match(app.el('stock-day-caption').textContent, /01\/11\/2026/);
  // The stale 2026-11-03 answer settles late: it must not repaint the view.
  await app.reply(firstRead, dayList('2026-11-03', dayRow(bolsasId, 'Bolsas', 'fixed', 5, 5, 2)));
  assert.deepEqual(app.el('stock-rows').children[0].cells.slice(1, 4).map(cell => cell.textContent), ['9', '0', '9'], 'a stale async response is ignored');
  assert.equal(app.dayReads().length, 2, 'no replacement read follows the stale settle');
});

// S1/S5: an unconfigured day is an explicit zero and never the global stock;
// archived history stays visible but read-only.
test('an unconfigured day shows explicit zeros, never global stock, and archived history rows stay read-only', async () => {
  const app = screen();
  await app.reply(app.reads()[0], ledger());
  openStock(app); await flush();
  await app.reply(app.productGets()[0], catalogue(
    product('Bolsas', 1250, 99, {}, bolsasId),
    product('Revista vieja', 100, 4, { archived: true }, viejoId),
  ));
  await app.reply(app.dayReads()[0], dayList('2026-11-03',
    dayRow(bolsasId, 'Bolsas', 'fixed', 0, 0, 0),
    dayRow(viejoId, 'Revista vieja', 'fixed', 6, 6, 1),
  ));
  const rows = app.el('stock-rows').children;
  assert.deepEqual(rows.map(row => row.cells[0].textContent), ['Bolsas', 'Revista vieja · Archivado']);
  assert.deepEqual(rows[0].cells.slice(1, 4).map(cell => cell.textContent), ['0', '0', '0'], 'an unconfigured day is an explicit zero');
  assert.ok(!rows.map(row => row.cells.map(cell => cell.textContent)).flat().some(text => text.includes('99')), 'global stock never becomes the daily authority');
  const actionsOf = row => row.cells[row.cells.length - 1].children;
  assert.equal(actionsOf(rows[1]).length, 0, 'archived history is read-only');
  assert.equal(actionsOf(rows[0]).length, 2, 'an active product offers the load edit and add-units actions');
  assert.match(actionsOf(rows[0])[0].getAttribute('aria-label'), /Modificar carga/);
  assert.match(actionsOf(rows[0])[1].getAttribute('aria-label'), /Agregar unidades/);
});

// S3: the copy is one explicit POST carrying only the target date and the
// stock-view stand — never item lists, sale counts or balances.
test('the copy button posts only the copy action for the stock date and stand; a previous day without load says so', async () => {
  const app = screen();
  await app.reply(app.reads()[0], ledger());
  openStock(app); await flush();
  await app.reply(app.dayReads()[0], dayList('2026-11-03', dayRow(bolsasId, 'Bolsas', 'fixed', 0, 0, 0)));
  app.el('copy-previous').emit('click'); await flush();
  assert.equal(app.dayPosts().length, 1);
  assert.deepEqual(JSON.parse(app.dayPosts()[0].options.body), {
    action: 'copy', date: '2026-11-03', stand: 'fixed',
  }, 'the copy carries the target date and the stock-view stand only');
  assert.equal(app.el('copy-previous').disabled, true, 'the copy is one action at a time');
  await app.reply(app.dayPosts()[0], { storage: 'supabase', action: 'copy', applied: 0 });
  assert.equal(app.el('stock-day-status').textContent, 'El día anterior no tiene carga para copiar.');
  assert.equal(app.el('copy-previous').disabled, false);
  assert.equal(app.dayReads().length, 2, 'the acknowledged copy refreshes the shown day exactly once');
  await app.reply(app.dayReads()[1], dayList('2026-11-03', dayRow(bolsasId, 'Bolsas', 'fixed', 0, 0, 0)));
  await app.tick(60000);
  assert.equal(app.dayReads().length, 2, 'time alone never re-reads or re-copies');
  assert.equal(app.dayPosts().length, 1);
});

// S3: a successful copy brings the previous day's prepared quantities and the
// figures refresh from a fresh read.
test('a confirmed copy applies the previous day load and reports the copied products', async () => {
  const app = screen();
  await app.reply(app.reads()[0], ledger());
  openStock(app); await flush();
  await app.reply(app.dayReads()[0], dayList('2026-11-03', dayRow(bolsasId, 'Bolsas', 'fixed', 0, 0, 0)));
  app.el('copy-previous').emit('click'); await flush();
  await app.reply(app.dayPosts()[0], { storage: 'supabase', action: 'copy', applied: 2 });
  assert.equal(app.el('stock-day-status').textContent, 'Copia lista: 2 productos del día anterior.');
  await app.reply(app.dayReads()[1], dayList('2026-11-03', dayRow(bolsasId, 'Bolsas', 'fixed', 4, 4, 0)));
  assert.deepEqual(app.el('stock-rows').children[0].cells.slice(1, 4).map(cell => cell.textContent), ['4', '0', '4'], 'the copied figures come from the refreshed day');
});

// S3: a day that already has its own load is never overwritten.
test('copying onto a day that already has its own load is refused explicitly and triggers no refresh', async () => {
  const app = screen();
  await app.reply(app.reads()[0], ledger());
  openStock(app); await flush();
  await app.reply(app.dayReads()[0], dayList('2026-11-03', dayRow(bolsasId, 'Bolsas', 'fixed', 4, 4, 0)));
  app.el('copy-previous').emit('click'); await flush();
  await app.reply(app.dayPosts()[0], {
    error: { code: 'DAY_ALREADY_LOADED', message: 'EL_DIA_YA_TIENE_CARGA: el día ya tiene su propia carga y no se pisa.' },
  }, 409);
  assert.equal(app.el('stock-day-status').textContent, 'Ese día ya tiene su propia carga y no se pisa. No se sobrescribió nada.');
  assert.equal(app.el('stock-day-status').dataset.error, 'true');
  assert.equal(app.dayReads().length, 1, 'a refused copy triggers no refresh read');
  assert.equal(app.el('copy-previous').disabled, false, 'the button recovers for another explicit attempt');
});

// S4: the safe per-product adjustments are the CAS-edited initial load and
// the units added during the day.
test('editing the initial load defines the day with per-item CAS and one refreshing read after success', async () => {
  const app = screen();
  await app.reply(app.reads()[0], ledger());
  openStock(app); await flush();
  await app.reply(app.dayReads()[0], dayList('2026-11-03', dayRow(bolsasId, 'Bolsas', 'fixed', 5, 5, 2)));
  app.el('stock-rows').children[0].cells[4].children[0].emit('click');
  assert.equal(app.el('stock-day-form').hidden, false);
  assert.equal(app.el('stock-day-label').textContent, 'Cantidad cargada');
  assert.equal(app.el('stock-day-quantity').value, '5', 'the observed load prefills the edit');
  assert.match(app.el('stock-day-product').textContent, /Bolsas/);
  assert.match(app.el('stock-day-product').textContent, /Puesto fijo/);
  app.el('stock-day-quantity').value = '8';
  app.el('stock-day-form').emit('submit'); await flush();
  assert.equal(app.dayPosts().length, 1);
  assert.deepEqual(JSON.parse(app.dayPosts()[0].options.body), {
    action: 'load', date: '2026-11-03', stand: 'fixed',
    items: [{ productId: bolsasId, initial: 8, prevInitial: 5 }],
  }, 'the edit carries the observed initial load as CAS');
  assert.equal(app.el('stock-day-quantity').disabled, true, 'the day edit freezes during the save');
  await app.reply(app.dayPosts()[0], { storage: 'supabase', action: 'load', applied: 1 });
  assert.equal(app.el('stock-day-status').textContent, 'Carga guardada.');
  assert.equal(app.el('stock-day-form').hidden, true, 'the edit closes after the acknowledged save');
  assert.equal(app.dayReads().length, 2, 'exactly one refreshing read follows the acknowledged load');
  await app.reply(app.dayReads()[1], dayList('2026-11-03', dayRow(bolsasId, 'Bolsas', 'fixed', 8, 8, 2)));
  assert.deepEqual(app.el('stock-rows').children[0].cells.slice(1, 4).map(cell => cell.textContent), ['8', '2', '6']);
  assert.equal(app.el('stock-day-quantity').disabled, false);
});

test('adding units during the day adjusts the cumulative replenished total and never rewrites the initial load', async () => {
  const app = screen();
  await app.reply(app.reads()[0], ledger());
  openStock(app); await flush();
  await app.reply(app.dayReads()[0], dayList('2026-11-03', dayRow(bolsasId, 'Bolsas', 'fixed', 5, 7, 2)));
  app.el('stock-rows').children[0].cells[4].children[1].emit('click');
  assert.equal(app.el('stock-day-label').textContent, 'Unidades a agregar');
  assert.equal(app.el('stock-day-quantity').value, '1', 'adding units starts at one');
  app.el('stock-day-quantity').value = '3';
  app.el('stock-day-form').emit('submit'); await flush();
  assert.deepEqual(JSON.parse(app.dayPosts()[0].options.body), {
    action: 'replenish', date: '2026-11-03', stand: 'fixed',
    items: [{ productId: bolsasId, replenished: 5, prevReplenished: 2 }],
  }, 'the new cumulative total is observed + added, with the observed value as CAS');
  await app.reply(app.dayPosts()[0], { storage: 'supabase', action: 'replenish', applied: 1 });
  assert.equal(app.el('stock-day-status').textContent, 'Unidades agregadas.');
  await app.reply(app.dayReads()[1], dayList('2026-11-03', dayRow(bolsasId, 'Bolsas', 'fixed', 5, 10, 2)));
  assert.deepEqual(app.el('stock-rows').children[0].cells.slice(1, 4).map(cell => cell.textContent), ['10', '2', '8'], 'the initial load stays 5');
});

// S4: going below the sold figure is only possible through the explicit
// in-app confirmation, which retries the same items with allowNegative true.
test('a load below the sold figure needs the explicit negative confirmation and retries the same items', async () => {
  const app = screen();
  await app.reply(app.reads()[0], ledger());
  openStock(app); await flush();
  await app.reply(app.dayReads()[0], dayList('2026-11-03', dayRow(bolsasId, 'Bolsas', 'fixed', 5, 5, 7)));
  app.el('stock-rows').children[0].cells[4].children[0].emit('click');
  app.el('stock-day-quantity').value = '3';
  app.el('stock-day-form').emit('submit'); await flush();
  await app.reply(app.dayPosts()[0], {
    error: { code: 'INSUFFICIENT_STOCK', message: 'STOCK_INSUFICIENTE: stock=-2, solicitado=3' },
  }, 409);
  assert.equal(app.el('day-negative-confirm').hidden, false, 'the explicit confirm appears in the app');
  assert.match(app.el('stock-day-status').textContent, /stock=-2, solicitado=3/, 'the server numbers reach the notice');
  assert.equal(app.el('stock-day-quantity').value, '3', 'the draft stays behind the confirm');
  assert.equal(app.dayReads().length, 1, 'a refused load triggers no refresh');
  app.el('day-negative-confirm').emit('click'); await flush();
  assert.equal(app.dayPosts().length, 2);
  const retry = JSON.parse(app.dayPosts()[1].options.body);
  assert.deepEqual(retry.items, [{ productId: bolsasId, initial: 3, prevInitial: 5 }], 'the same items retry');
  assert.equal(retry.allowNegative, true, 'the explicit acknowledgement is the only delta');
  await app.reply(app.dayPosts()[1], { storage: 'supabase', action: 'load', applied: 1 });
  assert.equal(app.el('day-negative-confirm').hidden, true);
  // A changed draft voids the confirm instead of consenting for it.
  app.el('stock-rows').children[0].cells[4].children[0].emit('click');
  app.el('stock-day-quantity').value = '2';
  app.el('stock-day-form').emit('submit'); await flush();
  await app.reply(app.dayPosts()[2], {
    error: { code: 'INSUFFICIENT_STOCK', message: 'STOCK_INSUFICIENTE: stock=-3, solicitado=2' },
  }, 409);
  assert.equal(app.el('day-negative-confirm').hidden, false);
  app.el('stock-day-quantity').value = '4';
  app.el('stock-day-quantity').emit('input');
  assert.equal(app.el('day-negative-confirm').hidden, true, 'any later edit voids the confirm');
  app.el('day-negative-confirm').emit('click'); await flush();
  assert.equal(app.dayPosts().length, 3, 'a voided confirm sends nothing');
});

// CAS losses and archived refusals are explicit errors; nothing retries.
test('a CAS loss on the day figures is an explicit error that keeps the draft and triggers no refresh', async () => {
  const app = screen();
  await app.reply(app.reads()[0], ledger());
  openStock(app); await flush();
  await app.reply(app.dayReads()[0], dayList('2026-11-03', dayRow(bolsasId, 'Bolsas', 'fixed', 5, 5, 2)));
  app.el('stock-rows').children[0].cells[4].children[0].emit('click');
  app.el('stock-day-quantity').value = '8';
  app.el('stock-day-form').emit('submit'); await flush();
  await app.reply(app.dayPosts()[0], {
    error: { code: 'LOAD_CONFLICT', message: 'La carga cambió desde otro dispositivo. Volvé a abrir el día con los datos actualizados.' },
  }, 409);
  assert.equal(app.el('stock-day-status').dataset.error, 'true');
  assert.match(app.el('stock-day-status').textContent, /cambió desde otro dispositivo/);
  assert.equal(app.el('stock-day-form').hidden, false, 'the edit stays open for correction');
  assert.equal(app.el('stock-day-quantity').value, '8');
  assert.equal(app.dayReads().length, 1, 'a CAS loss triggers no automatic refresh');
  // An archived product is refused explicitly too.
  app.el('stock-day-cancel').emit('click');
  app.el('stock-rows').children[0].cells[4].children[0].emit('click');
  app.el('stock-day-form').emit('submit'); await flush();
  await app.reply(app.dayPosts()[1], {
    error: { code: 'PRODUCT_ARCHIVED', message: 'Ese producto está archivado. Elegí otro producto del stock.' },
  }, 409);
  assert.match(app.el('stock-day-status').textContent, /archivado/);
  assert.equal(app.dayReads().length, 1);
  // Invalid input never leaves the app.
  app.el('stock-day-quantity').value = '-2';
  app.el('stock-day-form').emit('submit'); await flush();
  assert.equal(app.dayPosts().length, 2, 'a negative quantity is refused in the app');
  assert.match(app.el('stock-day-status').textContent, /número entero/);
  // Switching the day or the stand cancels an open edit.
  app.el('stock-day-quantity').value = '8';
  app.el('stock-date').value = '2026-11-01';
  app.el('stock-date').emit('change'); await flush();
  assert.equal(app.el('stock-day-form').hidden, true, 'a changed date cancels the day edit');
});

// S2 (sale integration): new sales opt into the daily channel explicitly.
test('new sales send dailyStock true with the selected stand and consume the daily availability', async () => {
  const app = screen();
  await app.reply(app.reads()[0], ledger());
  app.draft();
  app.el('sale-form').emit('submit'); await flush();
  const payload = JSON.parse(app.posts()[0].options.body);
  assert.equal(payload.dailyStock, true, 'a new sale opts into the daily channel');
  assert.equal(payload.stand, 'fixed');
  await app.reply(app.posts()[0], { error: { code: 'INSUFFICIENT_STOCK', message: 'STOCK_INSUFICIENTE: stock=0, solicitado=1' } }, 409);
  assert.equal(app.el('negative-confirm').hidden, false, 'a daily shortage keeps the explicit confirm flow');
  app.el('negative-confirm').emit('click'); await flush();
  const retry = JSON.parse(app.posts()[1].options.body);
  assert.equal(retry.dailyStock, true);
  assert.equal(retry.allowNegative, true, 'the daily allowance is explicit');
  assert.equal(retry.requestId, payload.requestId, 'the same sale identity retries');
});

// S2/S5: each stored row keeps its own channel on edits and deletes.
test('editing a daily sale preserves its channel tag and a legacy sale never gains one', async () => {
  const daily = sale('Venta diaria', '00000000-0000-4000-8000-00000000000a', {
    date: '2026-11-03', stand: 'fixed', dailyStock: true, quantity: 2, amountCents: 5000,
  });
  const legacy = sale('Venta histórica', '00000000-0000-4000-8000-00000000000b', { date: '2026-11-03' });
  const app = screen();
  await app.reply(app.reads()[0], ledger(daily, legacy));
  const edit = app.el('sales').children[0].cells[3].children.find(button => button.getAttribute('title') === 'Modificar venta');
  edit.emit('click');
  app.el('quantity').value = '3';
  app.el('quantity').emit('input');
  app.el('sale-form').emit('submit'); await flush();
  const put = JSON.parse(app.puts()[0].options.body);
  assert.equal(put.dailyStock, true, 'the daily edit stays in the daily channel');
  assert.equal(put.stand, 'fixed');
  assert.equal(put.previous.dailyStock, true, 'the observed snapshot preserves the tag');
  assert.equal(put.previous.stand, 'fixed');
  await app.reply(app.puts()[0], { storage: 'supabase', sale: daily }, 200);
  await flush();
  // A legacy row is edited and deleted exactly through the legacy shape.
  const editLegacy = app.el('sales').children[1].cells[3].children.find(button => button.getAttribute('title') === 'Modificar venta');
  editLegacy.emit('click');
  app.el('sale-form').emit('submit'); await flush();
  const legacyPut = JSON.parse(app.puts()[1].options.body);
  assert.equal(legacyPut.dailyStock, undefined, 'a legacy edit never claims the daily channel');
  assert.equal(legacyPut.previous.dailyStock, undefined);
  await app.reply(app.puts()[1], { storage: 'supabase', sale: legacy }, 200);
  await flush();
  const trash = app.el('sales').children[0].cells[3].children[0];
  trash.emit('click');
  app.el('sales').children[0].cells[3].children[0].emit('click'); // ¡Sí, borrar!
  await flush();
  const del = JSON.parse(app.dels()[0].options.body);
  assert.equal(del.previous.dailyStock, true, 'the daily delete preserves the observed tag');
});

// Contextual availability: suggestions show the sale date + sale stand.
test('suggestions show availability for the sale date and sale stand, never global stock or the stock view', async () => {
  const app = screen();
  await app.reply(app.reads()[0], ledger());
  app.el('product').emit('click'); await flush();
  assert.equal(app.dayReads().length, 1, 'the product field prepares the sale day availability');
  assert.equal(app.dayReads()[0].url, '/api/stock-days?date=2026-11-03');
  await app.reply(app.dayReads()[0], dayList('2026-11-03',
    dayRow(bolsasId, 'Bolsas', 'fixed', 5, 5, 2),
    dayRow(bolsasId, 'Bolsas', 'mobile', 0, 0, 0),
  ));
  app.el('product').value = 'Bols';
  app.el('product').emit('input'); await flush();
  await app.reply(app.productGets()[0], catalogue(product('Bolsas', 1250, 99, {}, bolsasId)));
  const listbox = app.el('product-listbox');
  assert.equal(listbox.hidden, false);
  assert.equal(listbox.children[0].children[1].textContent, 'quedan 3 · $ 12,50', 'the availability is the sale date + fixed stand, not the global 99');
  // Changing the sale stand re-serves the other stand from the same read.
  app.el('stand-mobile').checked = true;
  app.el('stand-fixed').checked = false;
  app.el('stand-mobile').emit('change'); await flush();
  assert.equal(listbox.children[0].children[1].textContent, 'quedan 0 · $ 12,50', 'the mobile availability of the sale date');
  assert.equal(app.dayReads().length, 1, 'both stands came from the one read');
});

test('a confirmed daily sale invalidates only its own day availability: the next read is fresh and nothing polls', async () => {
  const app = screen();
  await app.reply(app.reads()[0], ledger());
  app.el('product').emit('click'); await flush();
  await app.reply(app.dayReads()[0], dayList('2026-11-03', dayRow(bolsasId, 'Bolsas', 'fixed', 5, 5, 2)));
  app.draft();
  app.el('sale-form').emit('submit'); await flush();
  await app.reply(app.posts()[0], { storage: 'supabase', sale: { date: '2026-11-03' }, replayed: false }, 201);
  await flush();
  assert.equal(app.dayReads().length, 1, 'the acknowledged sale refreshes the ledger, not a hidden day read');
  await app.reply(app.salesReads()[1], ledger());
  await app.tick(60000);
  assert.equal(app.dayReads().length, 1, 'no polling of the day availability over time');
  app.el('product').emit('click'); await flush();
  assert.equal(app.dayReads().length, 2, 'the next explicit availability read is fresh');
  assert.equal(app.dayReads()[1].url, '/api/stock-days?date=2026-11-02', 'the fresh read follows the draft\'s sale date');
});

// Draft safety: view and date switches never overwrite the sale draft.
test('stock view, stock date and sale date changes never overwrite the sale draft', async () => {
  const app = screen();
  await app.reply(app.reads()[0], ledger());
  app.draft();
  openStock(app); await flush();
  app.el('stock-view-mobile').checked = true;
  app.el('stock-view-mobile').emit('change');
  app.el('stock-date').value = '2026-11-01';
  app.el('stock-date').emit('change'); await flush();
  app.el('menu-sales').emit('click');
  assert.equal(app.el('sale-date').value, '2026-11-02', 'the draft date is intact');
  assert.equal(app.el('product').value, 'Borrador sin guardar');
  assert.equal(app.el('amount').value, '1500,10');
  app.el('sale-date').value = '2026-11-05';
  app.el('sale-date').emit('change'); await flush();
  assert.equal(app.el('product').value, 'Borrador sin guardar', 'a sale date change never overwrites the draft');
  assert.equal(app.el('amount').value, '1500,10');
  assert.equal(app.el('quantity').value, '1');
});

// No polling on the daily view either.
test('the daily stock view never polls: time alone produces no reads or posts', async () => {
  const app = screen();
  await app.reply(app.reads()[0], ledger());
  openStock(app); await flush();
  await app.reply(app.dayReads()[0], dayList('2026-11-03', dayRow(bolsasId, 'Bolsas', 'fixed', 5, 5, 2)));
  await app.tick(60000);
  await app.tick(60000);
  assert.equal(app.dayReads().length, 1);
  assert.equal(app.dayPosts().length, 0);
  assert.equal(app.dayReads()[0].options.signal, undefined, 'the shown read runs without a deadline or poll timer');
  assert.equal(app.el('stock-rows').children[0].cells[1].textContent, '5');
});

// The catalogue is name and price only: the legacy global balance is
// internal compatibility data (create sends stock 0, an edit re-sends the
// observed stock untouched for CAS) and never editable or displayed.
test('the catalogue shows name and price only: the global balance is neither editable nor displayed and edits preserve it', async () => {
  const app = screen();
  await app.reply(app.reads()[0], ledger());
  openStock(app); await flush();
  await app.reply(app.productGets()[0], catalogue(product('Bolsas', 1250, 99, {}, bolsasId)));
  const rows = app.el('products').children;
  assert.equal(rows[0].cells.length, 3, 'name, price and actions only — no global units cell');
  assert.equal(rows[0].cells[1].textContent, '$ 12,50');
  assert.equal(rows[0].cells[2].className, 'actions');
  assert.equal(app.el('stock-stock'), null, 'no global units input ships in the catalogue UI');
  assert.equal(app.el('stock-negative-confirm'), null, 'no negative-global-stock edit UI exists');
  assert.doesNotMatch(html, /<label for="stock-stock">/, 'no global units label');
  assert.doesNotMatch(html, /Stock global del catálogo/, 'no misleading global-stock hint');
  assert.doesNotMatch(html, /<th scope="col">Unidades<\/th>/, 'no global units column');

  // Editing name/price preserves the observed legacy stock for the CAS and
  // the archive compatibility; no allowance is ever claimed from the UI.
  const edit = app.el('products').children[0].cells[2].children.find(button => button.getAttribute('aria-label')?.startsWith('Modificar '));
  edit.emit('click');
  assert.equal(app.el('stock-name').value, 'Bolsas');
  app.el('stock-name').value = 'Bolsas grandes';
  app.el('stock-form').emit('submit'); await flush();
  const put = JSON.parse(app.productPuts()[0].options.body);
  assert.equal(put.name, 'Bolsas grandes');
  assert.equal(put.price, '12,50');
  assert.equal(put.stock, 99, 'the observed global stock travels unchanged');
  assert.deepEqual(put.previous, { id: bolsasId, name: 'Bolsas', priceCents: 1250, stock: 99 });
  assert.equal(put.allowNegative, undefined, 'a product edit never claims the negative allowance');
  await app.reply(app.productPuts()[0], { storage: 'supabase', product: product('Bolsas grandes', 1250, 99, {}, bolsasId) }, 200);
  assert.equal(app.el('stock-status').textContent, 'Producto modificado.');
  assert.equal(app.el('stock-name').value, '');

  // Creation sends the legacy global stock 0: the daily initial load lives
  // only in the daily view above.
  app.el('stock-name').value = 'Caramelos';
  app.el('stock-form').emit('submit'); await flush();
  assert.deepEqual(JSON.parse(app.productPosts()[0].options.body), { name: 'Caramelos', stock: 0 });
});

// The anonymous gate and the failed logout keep the daily view honest.
test('logout clears the daily view with the rest of the business data', async () => {
  const app = screen();
  await app.reply(app.reads()[0], ledger());
  openStock(app); await flush();
  await app.reply(app.dayReads()[0], dayList('2026-11-03', dayRow(bolsasId, 'Bolsas', 'fixed', 5, 5, 2)));
  app.el('logout').emit('click'); await flush();
  await app.reply(app.requests.find(request => request.url === '/api/session' && request.method === 'DELETE'), { status: 'anonymous' });
  assert.equal(app.el('stock-panel').hidden, true);
  assert.equal(app.el('stock-rows').children.length, 0, 'the daily rows are cleared, never merely hidden');
  assert.equal(app.el('stock-day-form').hidden, true);
});

// Markup and CSS: accessible controls, exact approved copy and a mobile
// layout that keeps the three figures identified without the table header.
test('the daily view ships accessible controls, approved copy and an identified mobile layout', () => {
  assert.match(html, /<label for="stock-date">[^<]*<\/label>\s*<input id="stock-date" type="date"/);
  assert.match(html, /<legend>Puesto<\/legend>/);
  assert.match(html, /<input id="stock-view-fixed" name="stock-stand" type="radio" value="fixed" checked>/);
  assert.match(html, /<input id="stock-view-mobile" name="stock-stand" type="radio" value="mobile">/);
  assert.match(html, /<button id="copy-previous" type="button">Copiar carga del día anterior<\/button>/);
  assert.match(html, /<caption id="stock-day-caption">/);
  assert.match(html, /<th scope="col"[^>]*>Cantidad cargada<\/th>/);
  assert.match(html, /<th scope="col"[^>]*>Vendido<\/th>/);
  assert.match(html, /<th scope="col"[^>]*>Disponible<\/th>/);
  assert.match(html, /<label id="stock-day-label" for="stock-day-quantity">/);
  assert.match(html, /id="day-negative-confirm"[^>]*hidden>Aplicar igual y permitir disponibilidad negativa<\/button>/);
  assert.match(html, /<form id="stock-day-form" hidden>/);
  assert.match(css, /#stock-day-table td\.day-figure\s*\{[^}]*font-variant-numeric:\s*tabular-nums/);
  // Mobile: the figures keep their meaning via the data labels.
  assert.match(css, /@media \(max-width: 560px\)[\s\S]*#stock-day-table tr\s*\{[^}]*grid-template-columns:[^}]*\}/);
  assert.match(css, /@media \(max-width: 560px\)[\s\S]*#stock-day-table td\.day-figure::before\s*\{[^}]*content:\s*attr\(data-label\)/);
  // No destructive reset exists for the daily stock.
  assert.doesNotMatch(html, /id="reset-stock"|Reiniciar stock|Borrar carga|Vaciar día/);
  assert.doesNotMatch(source, /confirm\(.*\)|clearStock|resetDay/);
});
