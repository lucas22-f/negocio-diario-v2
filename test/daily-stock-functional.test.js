import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createStockDb, applyMigration, seedAuthUser, become, expectSqlError,
} from './helpers/stock-db.js';

// T1 functional execution of the daily stock schema (odd/tasks/
// daily-stand-stock.md, S1-S5) against real SQL (PGlite in-memory PostgreSQL).
// Same isolated fixture rules as test/stock-functional.test.js: synthetic auth
// users only, a v1 public.sales sentinel, no cloud access and no real secrets.

const PROD_A = 'Pochoclos grandes';
const PROD_B = 'Nachos';
const PROD_DEAD = 'Caramelo viejo';

const D1 = '44444444-4444-4444-4444-444444444401';
const D2 = '44444444-4444-4444-4444-444444444402';
const D3 = '44444444-4444-4444-4444-444444444403';
const D4 = '44444444-4444-4444-4444-444444444406';
const D5 = '44444444-4444-4444-4444-444444444407';
const L1 = '44444444-4444-4444-4444-444444444404';
const L2 = '44444444-4444-4444-4444-444444444405';

const UNKNOWN_PID = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee';

let sharedDb;

async function db() {
  if (!sharedDb) {
    sharedDb = await createStockDb();
    await sharedDb.exec('create table public.sales (id int primary key, note text)');
    await sharedDb.query('insert into public.sales values (1, $1)', ['venta v1 centinela']);
    await applyMigration(sharedDb);
  }
  return sharedDb;
}

const scalar = async (sql, params = []) => {
  const d = await db();
  const { rows } = await d.query(sql, params);
  return rows[0][Object.keys(rows[0])[0]];
};

const countRows = (table, where = 'true', params = []) =>
  scalar(`select count(*)::int from public.${table} where ${where}`, params);

const productId = async name =>
  scalar('select id::text from public.v2_products where name = $1', [name]);

const dailyRead = async date => {
  const d = await db();
  const { rows } = await d.query('select * from public.v2_read_daily_stock($1)', [date]);
  return rows;
};

const readRow = async (date, name, stand) => {
  const rows = await dailyRead(date);
  const row = rows.find(r => r.product === name && r.stand === stand);
  return row ?? null;
};

const asItems = items => JSON.stringify(items);

const loadDay = async (date, stand, items, allowNegative = false) => {
  const d = await db();
  const { rows } = await d.query('select public.v2_load_daily_stock($1,$2,$3,$4) as n',
    [date, stand, asItems(items), allowNegative]);
  return rows[0].n;
};

const replenishDay = async (date, stand, items, allowNegative = false) => {
  const d = await db();
  const { rows } = await d.query('select public.v2_replenish_daily_stock($1,$2,$3,$4) as n',
    [date, stand, asItems(items), allowNegative]);
  return rows[0].n;
};

const copyDay = async (date, stand) => {
  const d = await db();
  const { rows } = await d.query('select * from public.v2_copy_daily_stock($1,$2)', [date, stand]);
  return rows;
};

const createDailySale = async (id, date, product, payment, amountCents, productIdValue, quantity, allowNegative, stand) => {
  const d = await db();
  const { rows } = await d.query(
    'select * from public.v2_create_daily_sale($1,$2,$3,$4,$5,$6,$7,$8,$9)',
    [id, date, product, payment, amountCents, productIdValue, quantity, allowNegative, stand]);
  return rows[0];
};

const editDailySale = async (sale, previous) => {
  const d = await db();
  const { rows } = await d.query('select * from public.v2_edit_daily_sale($1,$2)',
    [JSON.stringify(sale), JSON.stringify(previous)]);
  return rows[0];
};

const deleteDailySale = async previous => {
  const d = await db();
  const { rows } = await d.query('select * from public.v2_delete_daily_sale($1)',
    [JSON.stringify(previous)]);
  return rows[0];
};

const saleRow = async id =>
  (await db()).query('select id::text, date::text as date, product, payment, amount_cents, product_id::text as product_id, quantity, stand, daily_stock from public.v2_sales where id = $1', [id])
    .then(r => r.rows[0] ?? null);

test.after(async () => {
  if (sharedDb) await sharedDb.close();
});

test('migration applies cleanly with the v1 sentinel present and binds the confirmed identity', async () => {
  const d = await db();
  assert.equal(await countRows('v2_business_account'), 0);
  const sentinel = await d.query('select id, note from public.sales order by id');
  assert.deepEqual(sentinel.rows, [{ id: 1, note: 'venta v1 centinela' }]);
  await seedAuthUser(d);
  await applyMigration(sharedDb); // idempotent re-apply binds the confirmed user
  assert.equal(await countRows('v2_business_account'), 1);
});

test('catalog: two active products and one archived product for the daily scenarios', async () => {
  const d = await db();
  await become(d, 'authenticated');
  const a = await d.query('select * from public.v2_create_product($1,$2,$3)', [PROD_A, 5000, 10]);
  assert.equal(a.rows[0].stock, 10);
  await d.query('select * from public.v2_create_product($1,$2,$3)', [PROD_B, null, 4]);
  const dead = await d.query('select * from public.v2_create_product($1,$2,$3)', [PROD_DEAD, 100, 0]);
  await d.query('select * from public.v2_archive_product($1,$2,$3)', [dead.rows[0].id, 0, true]);
});

// --- S1: daily stock by date -------------------------------------------------

test('S1: unconfigured date defaults to zero load/sold/available for every active product and stand', async () => {
  const d = await db();
  await become(d, 'authenticated');
  const rows = await dailyRead('2026-06-01');
  const active = rows.filter(r => r.product !== PROD_DEAD);
  assert.deepEqual(active.map(r => [r.product, r.stand]).sort(),
    [[PROD_A, 'fixed'], [PROD_A, 'mobile'], [PROD_B, 'fixed'], [PROD_B, 'mobile']].sort());
  for (const row of active) {
    assert.equal(row.initial_load, 0);
    assert.equal(row.loaded, 0);
    assert.equal(row.sold, 0);
    assert.equal(row.available, 0);
  }
  assert.equal(typeof (await readRow('2026-06-01', PROD_A, 'fixed')).price_cents, 'number');
  assert.equal(rows.some(r => r.product === PROD_DEAD), false); // archived stays out of the day view
});

test('S1: loading one date leaves other dates untouched (independent calendar days)', async () => {
  await become(await db(), 'authenticated');
  const applied = await loadDay('2026-06-01', 'fixed',
    [{ productId: await productId(PROD_A), initial: 30, prevInitial: null }]);
  assert.equal(applied, 1);
  const row = await readRow('2026-06-01', PROD_A, 'fixed');
  assert.deepEqual([row.initial_load, row.loaded, row.sold, row.available], [30, 30, 0, 30]);
  const mobile = await readRow('2026-06-01', PROD_A, 'mobile');
  assert.equal(mobile.loaded, 0); // the load is for the fixed stand only
  const nextDay = await readRow('2026-06-02', PROD_A, 'fixed');
  assert.deepEqual([nextDay.initial_load, nextDay.loaded, nextDay.sold, nextDay.available], [0, 0, 0, 0]);
  assert.equal(await countRows('v2_daily_stock', "date = '2026-06-02'"), 0);
});

test('S1: load replay is idempotent and a stale observed snapshot is rejected with CAS', async () => {
  const pid = await productId(PROD_A);
  await become(await db(), 'authenticated');
  assert.equal(await loadDay('2026-06-01', 'fixed', [{ productId: pid, initial: 30, prevInitial: 30 }]), 1);
  const row = await readRow('2026-06-01', PROD_A, 'fixed');
  assert.equal(row.initial_load, 30); // replay changed nothing
  await expectSqlError(
    () => loadDay('2026-06-01', 'fixed', [{ productId: pid, initial: 31, prevInitial: 29 }]),
    '40001', 'carga cambió desde otro dispositivo');
  await expectSqlError(
    () => loadDay('2026-06-01', 'fixed', [{ productId: pid, initial: 31, prevInitial: null }]),
    '40001', 'carga cambió desde otro dispositivo');
  assert.equal((await readRow('2026-06-01', PROD_A, 'fixed')).initial_load, 30);
  assert.equal(await loadDay('2026-06-01', 'fixed', [{ productId: pid, initial: 25, prevInitial: 30 }]), 1);
  assert.equal((await readRow('2026-06-01', PROD_A, 'fixed')).initial_load, 25);
});

test('S1: load input validation is strict (stand, date, list shape, values, product state)', async () => {
  const d = await db();
  await become(d, 'authenticated');
  const pid = await productId(PROD_A);
  const dead = await productId(PROD_DEAD);
  await expectSqlError(() => loadDay('2026-06-01', 'kiosk', [{ productId: pid, initial: 1 }]), '22023', 'Elegí Puesto fijo o Móvil.');
  await expectSqlError(() => loadDay(null, 'fixed', []), '22023', 'Elegí una fecha válida.');
  await expectSqlError(() => loadDay('2026-06-01', 'fixed', 'no-array'), '22023', 'lista');
  await expectSqlError(() => loadDay('2026-06-01', 'fixed', [{ productId: pid, initial: -1 }]), '22023', 'entre 0 y 1000000');
  await expectSqlError(() => loadDay('2026-06-01', 'fixed',
    [{ productId: pid, initial: 1 }, { productId: pid, initial: 2 }]), '22023', 'repetidos');
  await expectSqlError(() => loadDay('2026-06-01', 'fixed', [{ productId: UNKNOWN_PID, initial: 1 }]), '23503', 'ya no existe');
  await expectSqlError(() => loadDay('2026-06-01', 'fixed', [{ productId: dead, initial: 1 }]), 'P0001', 'PRODUCTO_INACTIVO');
  assert.equal(await countRows('v2_daily_stock', "date = '2026-06-01' and stand = 'kiosk'"), 0);
});

// --- S2: separate stands and sale consumption ---------------------------------

test('S2: fixed and mobile hold independent balances for the same date and product', async () => {
  const pid = await productId(PROD_A);
  await become(await db(), 'authenticated');
  assert.equal(await loadDay('2026-06-03', 'fixed', [{ productId: pid, initial: 10, prevInitial: null }]), 1);
  assert.equal(await loadDay('2026-06-03', 'mobile', [{ productId: pid, initial: 5, prevInitial: null }]), 1);
  assert.equal((await readRow('2026-06-03', PROD_A, 'fixed')).loaded, 10);
  assert.equal((await readRow('2026-06-03', PROD_A, 'mobile')).loaded, 5);
});

test('S2: a daily sale consumes only its date and stand and never touches global stock', async () => {
  const pid = await productId(PROD_A);
  await become(await db(), 'authenticated');
  const movementsBefore = await countRows('v2_stock_movements');
  const stockBefore = await scalar('select stock from public.v2_products where id::text = $1', [pid]);
  const row = await createDailySale(D1, '2026-06-03', PROD_A, 'efectivo', 200000, pid, 4, false, 'fixed');
  assert.equal(row.id, D1);
  assert.equal(row.stand, 'fixed');
  assert.equal(row.daily_stock, true);
  const stored = await saleRow(D1);
  assert.equal(stored.daily_stock, true);
  assert.equal((await readRow('2026-06-03', PROD_A, 'fixed')).sold, 4);
  assert.equal((await readRow('2026-06-03', PROD_A, 'fixed')).available, 6);
  assert.equal((await readRow('2026-06-03', PROD_A, 'mobile')).sold, 0);
  assert.equal(await scalar('select stock from public.v2_products where id::text = $1', [pid]), stockBefore);
  assert.equal(await countRows('v2_stock_movements'), movementsBefore); // mirror untouched

  // A free-text daily sale is recorded but consumes nothing (no product link).
  const free = await createDailySale(D3, '2026-06-03', 'Combo especial', 'transferencia', 300000, null, 1, false, 'mobile');
  assert.equal(free.daily_stock, true);
  assert.equal(free.product_id, null);
  assert.equal((await readRow('2026-06-03', PROD_A, 'mobile')).sold, 0);
});

test('S2: daily create replay is idempotent; different content under the same id is refused', async () => {
  const pid = await productId(PROD_A);
  await become(await db(), 'authenticated');
  const replayed = await createDailySale(D1, '2026-06-03', PROD_A, 'efectivo', 200000, pid, 4, false, 'fixed');
  assert.equal(replayed.id, D1);
  assert.equal((await readRow('2026-06-03', PROD_A, 'fixed')).sold, 4); // no double consumption
  await expectSqlError(
    () => createDailySale(D1, '2026-06-03', PROD_A, 'efectivo', 200000, pid, 5, false, 'fixed'),
    '23505', 'Ese identificador ya corresponde a otra venta');
  assert.equal((await readRow('2026-06-03', PROD_A, 'fixed')).sold, 4);
});

test('S2: daily edit moves quantity/date/stand with CAS, and availability is re-derived', async () => {
  const pid = await productId(PROD_A);
  await become(await db(), 'authenticated');
  const observed = { id: D1, date: '2026-06-03', product: PROD_A, payment: 'efectivo', amountCents: 200000, productId: pid, quantity: 4, stand: 'fixed' };
  const edited = await editDailySale({ ...observed, quantity: 6 }, observed);
  assert.equal(edited.quantity, 6);
  let fixed = await readRow('2026-06-03', PROD_A, 'fixed');
  assert.deepEqual([fixed.sold, fixed.available], [6, 4]);
  await expectSqlError(
    () => editDailySale({ ...observed, quantity: 8 }, observed), // stale snapshot (cur is 6)
    '40001', 'cambió desde otro dispositivo');
  fixed = await readRow('2026-06-03', PROD_A, 'fixed');
  assert.deepEqual([fixed.sold, fixed.available], [6, 4]); // rejected edit left data unchanged
  // Moving to mobile exceeds its load of 5: needs the explicit confirmation.
  await expectSqlError(
    () => editDailySale({ ...observed, quantity: 6, stand: 'mobile' }, { ...observed, quantity: 6 }),
    'P0001', 'STOCK_INSUFICIENTE');
  const moved = await editDailySale(
    { ...observed, quantity: 6, stand: 'mobile', allowNegative: true },
    { ...observed, quantity: 6 });
  assert.equal(moved.stand, 'mobile');
  fixed = await readRow('2026-06-03', PROD_A, 'fixed');
  assert.deepEqual([fixed.sold, fixed.available], [0, 10]);
  const mobile = await readRow('2026-06-03', PROD_A, 'mobile');
  assert.deepEqual([mobile.sold, mobile.available], [6, -1]);
  // Now move the sale to the next day (no load there) keeping the confirmation.
  const next = await editDailySale(
    { ...observed, date: '2026-06-04', quantity: 6, stand: 'mobile', allowNegative: true },
    { ...observed, quantity: 6, stand: 'mobile' });
  assert.equal(next.date instanceof Date ? next.date.toISOString().slice(0, 10) : next.date, '2026-06-04');
  assert.equal((await readRow('2026-06-03', PROD_A, 'mobile')).sold, 0);
  const day4 = await readRow('2026-06-04', PROD_A, 'mobile');
  assert.deepEqual([day4.sold, day4.available], [6, -6]);
  await expectSqlError(
    () => editDailySale({ ...observed, stand: '' }, {}),
    '22023'); // required stand must be fixed or mobile
});

test('S2: daily delete with CAS restores availability; unknown or stale deletes are refused', async () => {
  const pid = await productId(PROD_A);
  await become(await db(), 'authenticated');
  const observed = { id: D1, date: '2026-06-04', product: PROD_A, payment: 'efectivo', amountCents: 200000, productId: pid, quantity: 6, stand: 'mobile' };
  await expectSqlError(
    () => deleteDailySale({ ...observed, quantity: 4 }), // stale CAS
    '40001', 'cambió desde otro dispositivo');
  assert.equal((await readRow('2026-06-04', PROD_A, 'mobile')).sold, 6);
  const removed = await deleteDailySale(observed);
  assert.equal(removed.id, D1);
  assert.equal(await saleRow(D1), null);
  const day4 = await readRow('2026-06-04', PROD_A, 'mobile');
  assert.deepEqual([day4.sold, day4.available], [0, 0]);
  await expectSqlError(() => deleteDailySale(observed), 'P0002', 'ya no existe');
});

test('legacy channel stays pure: global RPCs reject daily sales, daily RPCs reject global sales', async () => {
  const d = await db();
  await become(d, 'authenticated');
  const pid = await productId(PROD_A);
  // A loaded daily day must NOT block legacy global sales (independent mirror).
  const legacyArgs = [L1, '2026-06-05', PROD_A, 'efectivo', 10000, pid, 2, false];
  const legacy = await d.query('select * from public.v2_create_sale($1,$2,$3,$4,$5,$6,$7,$8)', legacyArgs);
  assert.equal(legacy.rows[0].stand, null);
  assert.equal(await scalar('select stock from public.v2_products where id::text = $1', [pid]), 8);
  assert.equal(await countRows('v2_stock_movements', "reason = 'sale_create'"), 1);
  const edited = await d.query('select * from public.v2_edit_sale($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)',
    [...legacyArgs.slice(0, 7), '2026-06-05', PROD_A, 'efectivo', 10000, pid, 3, false]);
  assert.equal(edited.rows[0].quantity, 3);
  assert.equal(await scalar('select stock from public.v2_products where id::text = $1', [pid]), 7);
  // Legacy mutations of a daily sale are refused instead of corrupting the mirror.
  await loadDay('2026-06-05', 'fixed', [{ productId: pid, initial: 2, prevInitial: null }]);
  await createDailySale(D2, '2026-06-05', PROD_A, 'efectivo', 5000, pid, 1, false, 'fixed');
  const dailyObserved = { id: D2, date: '2026-06-05', product: PROD_A, payment: 'efectivo', amountCents: 5000, productId: pid, quantity: 1, stand: 'fixed' };
  await expectSqlError(
    () => d.query('select * from public.v2_edit_sale($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)',
      [D2, '2026-06-05', PROD_A, 'efectivo', 5000, pid, 1, '2026-06-05', PROD_A, 'efectivo', 5000, pid, 2, false]),
    '55006', 'VENTA_DIARIA');
  await expectSqlError(
    () => d.query('select * from public.v2_delete_sale($1,$2,$3,$4,$5,$6,$7)',
      [D2, '2026-06-05', PROD_A, 'efectivo', 5000, pid, 1]),
    '55006', 'VENTA_DIARIA');
  await expectSqlError(
    () => d.query('select * from public.v2_create_sale($1,$2,$3,$4,$5,$6,$7,$8)',
      [D2, '2026-06-05', PROD_A, 'efectivo', 5000, pid, 1, false]),
    '55006', 'VENTA_DIARIA');
  await expectSqlError(
    () => d.query('select * from public.v2_create_sale_at_stand($1,$2,$3,$4,$5,$6,$7,$8,$9)',
      [D2, '2026-06-05', PROD_A, 'efectivo', 5000, pid, 1, false, 'fixed']),
    '55006', 'VENTA_DIARIA');
  await expectSqlError(
    () => d.query('select * from public.v2_edit_sale_at_stand($1,$2)',
      [JSON.stringify({ ...dailyObserved, quantity: 2 }), JSON.stringify(dailyObserved)]),
    '55006', 'VENTA_DIARIA');
  await expectSqlError(
    () => d.query('select * from public.v2_delete_sale_at_stand($1)', [JSON.stringify(dailyObserved)]),
    '55006', 'VENTA_DIARIA');
  // And the reverse: daily RPCs refuse legacy (untagged) sale rows.
  const legacyNull = await d.query('select * from public.v2_create_sale($1,$2,$3,$4,$5,$6,$7,$8)',
    [L2, '2026-06-06', PROD_A, 'transferencia', 7000, pid, 1, false]);
  assert.equal(legacyNull.rows[0].daily_stock, false);
  assert.equal(legacyNull.rows[0].stand, null);
  const legacyObserved = { id: L2, date: '2026-06-06', product: PROD_A, payment: 'transferencia', amountCents: 7000, productId: pid, quantity: 1, stand: null };
  await expectSqlError(
    () => editDailySale({ ...legacyObserved, quantity: 2 }, legacyObserved),
    '55006', 'VENTA_DIARIA');
  await expectSqlError(() => deleteDailySale(legacyObserved), '55006', 'VENTA_DIARIA');
  // A null-stand historical sale is never attributed to a stand.
  for (const stand of ['fixed', 'mobile']) {
    assert.equal((await readRow('2026-06-06', PROD_A, stand)).sold, 0);
  }
  // Legacy delete of the untagged rows still works (mirror restored).
  await d.query('select * from public.v2_delete_sale($1,$2,$3,$4,$5,$6,$7)',
    [L2, '2026-06-06', PROD_A, 'transferencia', 7000, pid, 1]);
  await d.query('select * from public.v2_delete_sale($1,$2,$3,$4,$5,$6,$7)',
    [L1, '2026-06-05', PROD_A, 'efectivo', 10000, pid, 3]);
  assert.equal(await scalar('select stock from public.v2_products where id::text = $1', [pid]), 10);
});

test('daily RPCs fail closed: anon, foreign email and malformed claims', async () => {
  const d = await db();
  const probes = [
    ["select * from public.v2_read_daily_stock('2026-06-01')", []],
    ["select public.v2_load_daily_stock('2026-06-01','fixed','[]',false)", []],
    ["select * from public.v2_copy_daily_stock('2026-06-01','fixed')", []],
    ["select * from public.v2_create_daily_sale(gen_random_uuid(),'2026-06-01','X','efectivo',100,null,1,false,'fixed')", []],
    ["select * from public.v2_edit_daily_sale('{}','{}')", []],
    ["select * from public.v2_delete_daily_sale('{}')", []],
  ];
  await become(d, 'anon');
  for (const [sql] of probes) await expectSqlError(() => d.query(sql), '42501');
  await become(d, 'authenticated', { email: 'different@example.test' });
  for (const [sql] of probes) await expectSqlError(() => d.query(sql), '28000', 'IDENTIDAD_NO_AUTORIZADA');
  await become(d, 'authenticated', { claimsText: 'not-json' });
  for (const [sql] of probes) await expectSqlError(() => d.query(sql), '28000');
  await become(d, 'authenticated'); // restore for later tests
});

// --- S3: optional copy of the previous day ------------------------------------

test('S3: copy brings the previous calendar day initial load to the same stand only', async () => {
  await become(await db(), 'authenticated');
  const [pidA, pidB] = [await productId(PROD_A), await productId(PROD_B)];
  await loadDay('2026-06-10', 'fixed', [
    { productId: pidA, initial: 50, prevInitial: null },
    { productId: pidB, initial: 20, prevInitial: null },
  ]);
  await replenishDay('2026-06-10', 'fixed', [{ productId: pidA, replenished: 10, prevReplenished: null }]);
  // A sale on the source day must not be copied either.
  await createDailySale(D4, '2026-06-10', PROD_A, 'efectivo', 9000, pidA, 2, false, 'fixed');
  const copied = await copyDay('2026-06-11', 'fixed');
  assert.deepEqual(copied.map(r => [r.product_id === pidA ? PROD_A : PROD_B, r.initial_load, r.replenished]).sort(),
    [[PROD_A, 50, 0], [PROD_B, 20, 0]].sort());
  const a = await readRow('2026-06-11', PROD_A, 'fixed');
  assert.deepEqual([a.initial_load, a.loaded, a.sold, a.available], [50, 50, 0, 50]);
  assert.equal((await readRow('2026-06-11', PROD_A, 'mobile')).loaded, 0); // same stand only
  const source = await readRow('2026-06-10', PROD_A, 'fixed');
  assert.deepEqual([source.initial_load, source.loaded, source.sold], [50, 60, 2]); // source untouched
});

test('S3: copy refuses a populated destination atomically, without overwriting', async () => {
  await become(await db(), 'authenticated');
  const before = await countRows('v2_daily_stock', "date = '2026-06-11' and stand = 'fixed'");
  await expectSqlError(() => copyDay('2026-06-11', 'fixed'), '23505', 'EL_DIA_YA_TIENE_CARGA');
  assert.equal(await countRows('v2_daily_stock', "date = '2026-06-11' and stand = 'fixed'"), before);
  const a = await readRow('2026-06-11', PROD_A, 'fixed');
  assert.equal(a.initial_load, 50); // nothing was overwritten
  await expectSqlError(() => copyDay('2026-06-11', 'kiosk'), '22023', 'Elegí Puesto fijo o Móvil.');
  await expectSqlError(() => copyDay(null, 'fixed'), '22023', 'Elegí una fecha válida.');
});

test('S3: copying from a day without load succeeds as a no-op', async () => {
  await become(await db(), 'authenticated');
  const copied = await copyDay('2026-06-13', 'fixed'); // 2026-06-12 has no load
  assert.deepEqual(copied, []);
  assert.equal(await countRows('v2_daily_stock', "date = '2026-06-13'"), 0);
  const row = await readRow('2026-06-13', PROD_A, 'fixed');
  assert.deepEqual([row.initial_load, row.loaded, row.sold, row.available], [0, 0, 0, 0]);
});

test('S3: copy crosses leap days, non-leap Februaries and the year boundary', async () => {
  const pid = await productId(PROD_A);
  await become(await db(), 'authenticated');
  // Leap year: the previous calendar day of 2024-03-01 is 2024-02-29.
  await loadDay('2024-02-29', 'fixed', [{ productId: pid, initial: 7, prevInitial: null }]);
  assert.equal((await copyDay('2024-03-01', 'fixed')).length, 1);
  assert.equal((await readRow('2024-03-01', PROD_A, 'fixed')).initial_load, 7);
  // Non-leap year: the previous calendar day of 2023-03-01 is 2023-02-28.
  await loadDay('2023-02-28', 'fixed', [{ productId: pid, initial: 8, prevInitial: null }]);
  assert.equal((await copyDay('2023-03-01', 'fixed')).length, 1);
  assert.equal((await readRow('2023-03-01', PROD_A, 'fixed')).initial_load, 8);
  // Year boundary: the previous calendar day of 2026-01-01 is 2025-12-31.
  await loadDay('2025-12-31', 'fixed', [{ productId: pid, initial: 9, prevInitial: null }]);
  assert.equal((await copyDay('2026-01-01', 'fixed')).length, 1);
  assert.equal((await readRow('2026-01-01', PROD_A, 'fixed')).initial_load, 9);
});

// --- S4: replenish during the day and visible figures --------------------------

test('S4: replenishing adds units during the day with CAS, keeping the initial load separate', async () => {
  const pid = await productId(PROD_A);
  await become(await db(), 'authenticated');
  assert.equal(await replenishDay('2026-06-15', 'fixed', [{ productId: pid, replenished: 5, prevReplenished: null }]), 1);
  let row = await readRow('2026-06-15', PROD_A, 'fixed');
  assert.deepEqual([row.initial_load, row.loaded, row.sold, row.available], [0, 5, 0, 5]);
  await expectSqlError(
    () => replenishDay('2026-06-15', 'fixed', [{ productId: pid, replenished: 8, prevReplenished: 4 }]),
    '40001', 'carga cambió desde otro dispositivo');
  assert.equal((await readRow('2026-06-15', PROD_A, 'fixed')).loaded, 5); // rejected add left data unchanged
  assert.equal(await replenishDay('2026-06-15', 'fixed', [{ productId: pid, replenished: 8, prevReplenished: 5 }]), 1);
  row = await readRow('2026-06-15', PROD_A, 'fixed');
  assert.deepEqual([row.initial_load, row.loaded], [0, 8]); // initial load never rewritten
  const dead = await productId(PROD_DEAD);
  await expectSqlError(
    () => replenishDay('2026-06-15', 'fixed', [{ productId: dead, replenished: 1, prevReplenished: null }]),
    'P0001', 'PRODUCTO_INACTIVO');
  await expectSqlError(
    () => replenishDay('2026-06-15', 'fixed', [{ productId: UNKNOWN_PID, replenished: 1, prevReplenished: null }]),
    '23503', 'ya no existe');
});

test('S4: lowering a load below what was sold requires the explicit negative confirmation', async () => {
  const pid = await productId(PROD_A);
  await become(await db(), 'authenticated');
  await createDailySale(D5, '2026-06-16', PROD_A, 'efectivo', 1000, pid, 3, true, 'fixed'); // no load: confirmed
  assert.equal((await readRow('2026-06-16', PROD_A, 'fixed')).sold, 3);
  await expectSqlError(
    () => loadDay('2026-06-16', 'fixed', [{ productId: pid, initial: 2, prevInitial: null }]),
    'P0001', 'STOCK_INSUFICIENTE');
  assert.equal(await countRows('v2_daily_stock', "date = '2026-06-16'"), 0); // rejected load left data unchanged
  assert.equal(await loadDay('2026-06-16', 'fixed', [{ productId: pid, initial: 2, prevInitial: null }], true), 1);
  const row = await readRow('2026-06-16', PROD_A, 'fixed');
  assert.deepEqual([row.loaded, row.sold, row.available], [2, 3, -1]);
});

// --- S5: history is preserved, nothing resets ---------------------------------

test('S5: past days keep their figures after later activity, and the mirror never moved', async () => {
  await become(await db(), 'authenticated');
  const day3 = await dailyRead('2026-06-03');
  const fixedA = day3.find(r => r.product === PROD_A && r.stand === 'fixed');
  assert.deepEqual([fixedA.initial_load, fixedA.loaded, fixedA.sold, fixedA.available], [10, 10, 0, 10]);
  const day10 = await readRow('2026-06-10', PROD_A, 'fixed');
  assert.deepEqual([day10.initial_load, day10.loaded, day10.sold, day10.available], [50, 60, 2, 58]);
  const day11 = await readRow('2026-06-11', PROD_A, 'fixed');
  assert.deepEqual([day11.initial_load, day11.loaded, day11.sold, day11.available], [50, 50, 0, 50]);
  // No fabricated loads for unconfigured days; the free-text daily sale exists
  // but attributes nothing per-product.
  assert.equal(await countRows('v2_daily_stock', "date in ('2026-06-02','2026-06-12','2026-06-13','2026-06-14')"), 0);
  assert.equal(await saleRow(D3).then(r => r.daily_stock), true);
  // Legacy global mirror: exactly the three legacy-sale movements, nothing more.
  assert.equal(await countRows('v2_stock_movements'), 7); // 2 product adjust + the five legacy-sale movements
  const [stockA, stockB] = await Promise.all([
    scalar("select stock from public.v2_products where name = $1", [PROD_A]),
    scalar("select stock from public.v2_products where name = $1", [PROD_B]),
  ]);
  assert.equal(stockA, 10);
  assert.equal(stockB, 4);
  // v1 sentinel still intact (read as the owner, outside the request role).
  const d = await db();
  await d.exec('reset role');
  const sentinel = await d.query('select id, note from public.sales order by id');
  assert.deepEqual(sentinel.rows, [{ id: 1, note: 'venta v1 centinela' }]);
});
