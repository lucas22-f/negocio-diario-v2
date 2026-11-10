import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createStockDb, applyMigration, seedAuthUser, become, expectSqlError,
  runProbe, TEST_UID, TEST_EMAIL,
} from './helpers/stock-db.js';

// T2 functional execution of the v2 stock schema against real SQL (PGlite
// in-memory PostgreSQL 0.5.8). The fixture stubs only the Supabase surface the
// migration touches: an auth schema with SYNTHETIC users (in-memory only —
// cloud auth.users is never written), plus anon/authenticated roles, and a v1
// public.sales sentinel because the SAME Supabase project legitimately serves
// both generations. No secrets, no cloud, no v1 data beyond the sentinel.

const SALE_ID = '11111111-1111-1111-1111-111111111111';
const SALE_ID_2 = '22222222-2222-2222-2222-222222222222';
const SALE_ID_3 = '33333333-3333-3333-3333-333333333332';
const DATE = '2026-01-15';

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

const scalar = async (query, params) =>
  Number((await db().then(d => d.query(query, params))).rows[0][Object.keys((await db().then(d => d.query(query, params))).rows[0])[0]]);

const countRows = (table, where = 'true', params = []) =>
  db().then(d => d.query(`select count(*)::int as n from public.${table} where ${where}`, params))
    .then(r => r.rows[0].n);

const productId = name =>
  db().then(d => d.query('select id from public.v2_products where name = $1', [name]))
    .then(r => r.rows[0]?.id ?? null);

test.after(async () => {
  if (sharedDb) await sharedDb.close();
});

test('migration applies cleanly with the v1 sentinel present and binds nothing yet', async () => {
  const d = await db();
  const registry = await countRows('v2_business_account');
  assert.equal(registry, 0); // no confirmed auth identity exists yet: fail closed
  const sentinel = await d.query('select id, note from public.sales order by id');
  assert.deepEqual(sentinel.rows, [{ id: 1, note: 'venta v1 centinela' }]);
});

test('fail closed without registry binding: RPC 28000, RLS empty, registry invisible', async () => {
  const d = await db();
  await become(d, 'authenticated'); // claims exist, but no registry row
  await expectSqlError(
    () => d.query('select * from public.v2_create_sale($1,$2,$3,$4,$5,$6,$7,$8)',
      [SALE_ID, DATE, 'X', 'efectivo', 100, null, 1, false]),
    '28000', 'IDENTIDAD_NO_AUTORIZADA');
  assert.equal(await countRows('v2_sales'), 0);
  assert.equal(await countRows('v2_products'), 0);
  assert.equal(await countRows('v2_stock_movements'), 0);
  await expectSqlError(() => d.query('select 1 from public.v2_business_account'), '42501');
});

test('direct DML denied even for the claimed identity (atomicity cannot be bypassed)', async () => {
  const d = await db();
  await become(d, 'authenticated');
  await expectSqlError(() => d.query(
    "insert into public.v2_sales (id, date, product, payment, amount_cents) values ($1,$2,$3,'efectivo',100)",
    [SALE_ID, DATE, ' directo ']), '42501');
  await expectSqlError(() => d.query('update public.v2_products set stock = 0'), '42501');
  await expectSqlError(() => d.query('delete from public.v2_stock_movements'), '42501');
});

test('anon role denied everywhere: no table grants and no RPC execute', async () => {
  const d = await db();
  await become(d, 'anon');
  await expectSqlError(() => d.query('select count(*) from public.v2_sales'), '42501');
  await expectSqlError(() => d.query('select count(*) from public.v2_products'), '42501');
  await expectSqlError(() => d.query('select count(*) from public.v2_stock_movements'), '42501');
  await expectSqlError(
    () => d.query('select * from public.v2_create_product($1,$2,$3)', ['X', null, 0]),
    '42501');
});

test('binding: a confirmed synthetic auth identity is seeded by the idempotent re-apply', async () => {
  const d = await db();
  await seedAuthUser(d); // confirmed pochoclos@negocio.com, synthetic uid
  await applyMigration(sharedDb); // must be fully idempotent
  assert.equal(await countRows('v2_business_account'), 1);
});

test('unconfirmed identity is never bound (fail closed stays closed)', async () => {
  const d = await db();
  // A different, unconfirmed identity with the approved email must not bind:
  // the registry keeps exactly the one confirmed row.
  await seedAuthUser(d, { uid: '99999999-9999-9999-9999-999999999998', confirmed: false });
  await applyMigration(sharedDb);
  assert.equal(await countRows('v2_business_account'), 1);
});

test('bound identity reads the empty v2 tables through RLS', async () => {
  const d = await db();
  await become(d, 'authenticated');
  assert.equal(await countRows('v2_sales'), 0);
  assert.equal(await countRows('v2_products'), 0);
  assert.equal(await countRows('v2_stock_movements'), 0);
});

test('create product: nullable price, initial stock audited, row shape exact', async () => {
  const d = await db();
  await become(d, 'authenticated');
  const { rows } = await d.query('select * from public.v2_create_product($1,$2,$3)',
    ['Pochoclos grandes', 5000, 10]);
  const row = rows[0];
  assert.equal(row.name, 'Pochoclos grandes');
  assert.equal(row.price_cents, 5000);
  assert.equal(row.stock, 10);
  assert.equal(row.archived, false);
  assert.ok(typeof row.id === 'string');
  await d.query('select * from public.v2_create_product($1,$2,$3)', ['Nachos', null, 4]);
  const nachos = (await d.query('select * from public.v2_products where name = $1', ['Nachos'])).rows[0];
  assert.equal(nachos.price_cents, null); // price is optional
  assert.equal(await countRows('v2_stock_movements', "reason = 'adjust'"), 2);
});

test('duplicate active product name rejected 23505 (whitespace-insensitive)', async () => {
  const d = await db();
  await become(d, 'authenticated');
  await expectSqlError(
    () => d.query('select * from public.v2_create_product($1,$2,$3)', ['  pochoclos grandes  ', 6000, 1]),
    '23505');
  assert.equal(await countRows('v2_products'), 2); // nothing inserted
});

test('sale create decrements stock and audits exactly one movement', async () => {
  const d = await db();
  await become(d, 'authenticated');
  const pid = await productId('Pochoclos grandes');
  const { rows } = await d.query(
    'select * from public.v2_create_sale($1,$2,$3,$4,$5,$6,$7,$8)',
    [SALE_ID, DATE, 'Pochoclos grandes', 'efectivo', 15000, pid, 3, false]);
  const row = rows[0];
  const rowDate = row.date instanceof Date ? row.date.toISOString().slice(0, 10) : String(row.date);
  assert.deepEqual(
    {
      id: row.id, date: rowDate, product: row.product, payment: row.payment,
      amount_cents: Number(row.amount_cents), product_id: row.product_id,
      quantity: row.quantity,
    },
    { id: SALE_ID, date: DATE, product: 'Pochoclos grandes', payment: 'efectivo',
      amount_cents: 15000, product_id: pid, quantity: 3 });
  assert.ok(Number.isInteger(Number(row.row_seq)));
  assert.equal(await scalar('select stock from public.v2_products where id = $1', [pid]), 7);
  assert.equal(await countRows('v2_stock_movements', 'sale_id = $1 and reason = $2 and delta = $3',
    [SALE_ID, 'sale_create', -3]), 1);
});

test('idempotent replay: same content returns the stored row, zero new movements', async () => {
  const d = await db();
  await become(d, 'authenticated');
  const pid = await productId('Pochoclos grandes');
  const before = await countRows('v2_stock_movements');
  const { rows } = await d.query(
    'select * from public.v2_create_sale($1,$2,$3,$4,$5,$6,$7,$8)',
    [SALE_ID, DATE, 'Pochoclos grandes', 'efectivo', 15000, pid, 3, false]);
  assert.equal(rows[0].id, SALE_ID);
  assert.equal(await countRows('v2_stock_movements'), before);
});

test('same id with different content is a real conflict 23505', async () => {
  const d = await db();
  await become(d, 'authenticated');
  const pid = await productId('Pochoclos grandes');
  await expectSqlError(
    () => d.query('select * from public.v2_create_sale($1,$2,$3,$4,$5,$6,$7,$8)',
      [SALE_ID, DATE, 'Pochoclos grandes', 'efectivo', 99999, pid, 3, false]),
    '23505', 'otra venta');
});

test('free-text sale: no product link, quantity forced to 1, no stock movement', async () => {
  const d = await db();
  await become(d, 'authenticated');
  await d.query('select * from public.v2_create_sale($1,$2,$3,$4,$5,$6,$7,$8)',
    [SALE_ID_2, DATE, 'Combo sorpresa', 'transferencia', 7000, null, 1, false]);
  const row = (await d.query('select * from public.v2_sales where id = $1', [SALE_ID_2])).rows[0];
  assert.equal(row.product_id, null);
  assert.equal(row.quantity, 1);
  assert.equal(await countRows('v2_stock_movements', 'sale_id = $1', [SALE_ID_2]), 0);
});

test('shortage without acknowledgement: exact P0001 error, sale/stock/movements unchanged', async () => {
  const d = await db();
  await become(d, 'authenticated');
  const pid = await productId('Nachos');
  const before = {
    sales: await countRows('v2_sales'),
    stock: await scalar('select stock from public.v2_products where id = $1', [pid]),
    movements: await countRows('v2_stock_movements'),
  };
  const error = await expectSqlError(
    () => d.query('select * from public.v2_create_sale($1,$2,$3,$4,$5,$6,$7,$8)',
      ['33333333-3333-3333-3333-333333333331', DATE, 'Nachos', 'efectivo', 9000, pid, 5, false]),
    'P0001', 'STOCK_INSUFICIENTE: stock=4, solicitado=5');
  assert.match(error.message, /STOCK_INSUFICIENTE: stock=4, solicitado=5/);
  assert.equal(await countRows('v2_sales'), before.sales);
  assert.equal(await scalar('select stock from public.v2_products where id = $1', [pid]), before.stock);
  assert.equal(await countRows('v2_stock_movements'), before.movements);
});

test('explicit allowNegative acknowledgement sells into negative stock', async () => {
  const d = await db();
  await become(d, 'authenticated');
  const pid = await productId('Nachos');
  await d.query('select * from public.v2_create_sale($1,$2,$3,$4,$5,$6,$7,$8)',
    [SALE_ID_3, DATE, 'Nachos', 'efectivo', 9000, pid, 5, true]);
  assert.equal(await scalar('select stock from public.v2_products where id = $1', [pid]), -1);
});

test('edit with product switch applies exact reversals and audits both sides', async () => {
  const d = await db();
  await become(d, 'authenticated');
  const pidNachos = await productId('Nachos');
  const pidPochoclos = await productId('Pochoclos grandes');
  const { rows } = await d.query(
    'select * from public.v2_edit_sale($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)',
    [SALE_ID_3, DATE, 'Nachos', 'efectivo', 9000, pidNachos, 5,
      DATE, 'Pochoclos grandes', 'efectivo', 10000, pidPochoclos, 2, false]);
  assert.equal(rows[0].product_id, pidPochoclos);
  assert.equal(rows[0].quantity, 2);
  assert.equal(await scalar('select stock from public.v2_products where id = $1', [pidNachos]), 4); // +5 back
  assert.equal(await scalar('select stock from public.v2_products where id = $1', [pidPochoclos]), 5); // 7-2
  assert.equal(await countRows('v2_stock_movements',
    'sale_id = $1 and reason = $2 and delta = $3', [SALE_ID_3, 'sale_edit', 5]), 1);
  assert.equal(await countRows('v2_stock_movements',
    'sale_id = $1 and reason = $2 and delta = $3', [SALE_ID_3, 'sale_edit', -2]), 1);
});

test('stale CAS snapshot on edit rejected 40001 with nothing changed', async () => {
  const d = await db();
  await become(d, 'authenticated');
  const pidNachos = await productId('Nachos');
  const pidPochoclos = await productId('Pochoclos grandes');
  const before = {
    stockN: await scalar('select stock from public.v2_products where id = $1', [pidNachos]),
    stockP: await scalar('select stock from public.v2_products where id = $1', [pidPochoclos]),
    movements: await countRows('v2_stock_movements'),
  };
  await expectSqlError(
    () => d.query('select * from public.v2_edit_sale($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)',
      [SALE_ID_3, DATE, 'Nachos', 'efectivo', 9000, pidNachos, 5, // previous state no longer current
        DATE, 'Pochoclos grandes', 'efectivo', 10000, pidPochoclos, 2, false]),
    '40001', 'otro dispositivo');
  assert.equal(await scalar('select stock from public.v2_products where id = $1', [pidNachos]), before.stockN);
  assert.equal(await scalar('select stock from public.v2_products where id = $1', [pidPochoclos]), before.stockP);
  assert.equal(await countRows('v2_stock_movements'), before.movements);
});

test('archived product selection rejected even with stock; restore works', async () => {
  const d = await db();
  await become(d, 'authenticated');
  const pid = await productId('Nachos');
  await d.query('select * from public.v2_archive_product($1,$2,$3)', [pid, 4, true]);
  await expectSqlError(
    () => d.query('select * from public.v2_create_sale($1,$2,$3,$4,$5,$6,$7,$8)',
      ['44444444-4444-4444-4444-444444444444', DATE, 'Nachos', 'efectivo', 9000, pid, 1, false]),
    'P0001', 'PRODUCTO_INACTIVO');
  await d.query('select * from public.v2_archive_product($1,$2,$3)', [pid, 4, false]);
  assert.equal((await d.query('select archived from public.v2_products where id = $1', [pid])).rows[0].archived, false);
});

test('delete sale reverses the consumed stock and audits sale_delete once', async () => {
  const d = await db();
  await become(d, 'authenticated');
  const pid = await productId('Pochoclos grandes');
  const { rows } = await d.query(
    'select * from public.v2_delete_sale($1,$2,$3,$4,$5,$6,$7)',
    [SALE_ID, DATE, 'Pochoclos grandes', 'efectivo', 15000, pid, 3]);
  assert.equal(rows[0].id, SALE_ID);
  assert.equal(await countRows('v2_sales', 'id = $1', [SALE_ID]), 0);
  assert.equal(await scalar('select stock from public.v2_products where id = $1', [pid]), 8);
  assert.equal(await countRows('v2_stock_movements',
    'sale_id = $1 and reason = $2 and delta = $3', [SALE_ID, 'sale_delete', 3]), 1);
});

test('product rename keeps sale snapshots verbatim; stock-only change audits adjust', async () => {
  const d = await db();
  await become(d, 'authenticated');
  await d.query('select * from public.v2_create_product($1,$2,$3)', ['Caramelos', 500, 20]);
  const pid = await productId('Caramelos');
  await d.query('select * from public.v2_create_sale($1,$2,$3,$4,$5,$6,$7,$8)',
    ['55555555-5555-5555-5555-555555555555', DATE, 'Caramelos', 'efectivo', 1000, pid, 2, false]);
  await d.query('select * from public.v2_edit_product($1,$2,$3,$4,$5,$6,$7,$8)',
    [pid, 'Caramelos', 500, 18, 'Caramelos de fresa', 600, 16, false]);
  const sale = (await d.query('select product, amount_cents from public.v2_sales where id = $1',
    ['55555555-5555-5555-5555-555555555555'])).rows[0];
  assert.equal(sale.product, 'Caramelos'); // snapshot preserved after rename
  assert.equal(Number(sale.amount_cents), 1000);
  const prod = (await d.query('select * from public.v2_products where id = $1', [pid])).rows[0];
  assert.equal(prod.name, 'Caramelos de fresa');
  assert.equal(prod.price_cents, 600);
  assert.equal(await countRows('v2_stock_movements',
    'product_id = $1 and reason = $2 and delta = $3', [pid, 'adjust', -2]), 1);
});

test('product stock below zero without ack rejected 40001-free exact P0001; ack proceeds', async () => {
  const d = await db();
  await become(d, 'authenticated');
  const pid = await productId('Caramelos de fresa');
  await expectSqlError(
    () => d.query('select * from public.v2_edit_product($1,$2,$3,$4,$5,$6,$7,$8)',
      [pid, 'Caramelos de fresa', 600, 16, 'Caramelos de fresa', 600, -3, false]),
    'P0001', 'STOCK_INSUFICIENTE: stock=16, solicitado=-3');
  await d.query('select * from public.v2_edit_product($1,$2,$3,$4,$5,$6,$7,$8)',
    [pid, 'Caramelos de fresa', 600, 16, 'Caramelos de fresa', 600, -3, true]);
  assert.equal(await scalar('select stock from public.v2_products where id = $1', [pid]), -3);
});

test('wrong email with bound uid fails closed 28000 and vice versa', async () => {
  const d = await db();
  await become(d, 'authenticated', { uid: TEST_UID, email: 'otro@negocio.com' });
  await expectSqlError(
    () => d.query('select * from public.v2_create_sale($1,$2,$3,$4,$5,$6,$7,$8)',
      ['66666666-6666-6666-6666-666666666666', DATE, 'X', 'efectivo', 100, null, 1, false]),
    '28000', 'IDENTIDAD_NO_AUTORIZADA');
  await become(d, 'authenticated', { uid: '88888888-8888-8888-8888-888888888888', email: TEST_EMAIL });
  await expectSqlError(
    () => d.query('select * from public.v2_create_sale($1,$2,$3,$4,$5,$6,$7,$8)',
      ['66666666-6666-6666-6666-666666666667', DATE, 'X', 'efectivo', 100, null, 1, false]),
    '28000', 'IDENTIDAD_NO_AUTORIZADA');
  assert.equal(await countRows('v2_sales', 'id = $1', ['66666666-6666-6666-6666-666666666666']), 0);
});

test('wrong-email identity sees zero v2 rows through RLS while bound sees them', async () => {
  const d = await db();
  await become(d, 'authenticated', { uid: TEST_UID, email: 'otro@negocio.com' });
  assert.equal(await countRows('v2_sales'), 0);
  assert.equal(await countRows('v2_products'), 0);
  await become(d, 'authenticated');
  assert.ok((await countRows('v2_sales')) > 0);
});

test('modern JSON-only claims: the bound identity operates through the supported transport', async () => {
  const d = await db();
  await become(d, 'authenticated'); // one request.jwt.claims JSON GUC, legacy GUCs cleared
  const claims = (await d.query('select auth.jwt()')).rows[0].jwt;
  assert.deepEqual(claims, { sub: TEST_UID, email: TEST_EMAIL },
    'the fixture delivers exactly one JSON claims GUC and no legacy GUCs');
  const { rows } = await d.query('select * from public.v2_create_product($1,$2,$3)',
    ['Reclamos JSON', 100, 1]);
  assert.equal(rows[0].name, 'Reclamos JSON');
});

test('missing and malformed JSON claims fail closed 28000 with counters unchanged', async () => {
  const d = await db();
  await become(d, 'postgres');
  const before = {
    sales: await countRows('v2_sales'),
    products: await countRows('v2_products'),
    movements: await countRows('v2_stock_movements'),
  };
  // No claims at all: the JSON GUC and every legacy GUC unset.
  await become(d, 'authenticated', { claims: null });
  await expectSqlError(
    () => d.query('select * from public.v2_create_sale($1,$2,$3,$4,$5,$6,$7,$8)',
      ['77777777-7777-7777-7777-777777777771', DATE, 'X', 'efectivo', 100, null, 1, false]),
    '28000', 'IDENTIDAD_NO_AUTORIZADA');
  // Malformed claims JSON (not parseable) must deny, not crash anonymously.
  await become(d, 'authenticated', { claimsText: 'not-json' });
  await expectSqlError(
    () => d.query('select * from public.v2_create_sale($1,$2,$3,$4,$5,$6,$7,$8)',
      ['77777777-7777-7777-7777-777777777772', DATE, 'X', 'efectivo', 100, null, 1, false]),
    '28000', 'IDENTIDAD_NO_AUTORIZADA');
  // Well-formed JSON whose sub is not a uuid must deny the same way.
  await become(d, 'authenticated', { claimsText: JSON.stringify({ sub: 'not-a-uuid', email: TEST_EMAIL }) });
  await expectSqlError(
    () => d.query('select * from public.v2_create_sale($1,$2,$3,$4,$5,$6,$7,$8)',
      ['77777777-7777-7777-7777-777777777773', DATE, 'X', 'efectivo', 100, null, 1, false]),
    '28000', 'IDENTIDAD_NO_AUTORIZADA');
  // RLS read path with malformed claims: zero rows visible.
  await become(d, 'authenticated', { claimsText: 'not-json' });
  assert.equal(await countRows('v2_sales'), 0, 'malformed claims see zero rows through RLS');
  // Rejected identity attempts left every counter untouched.
  await become(d, 'postgres');
  assert.equal(await countRows('v2_sales'), before.sales);
  assert.equal(await countRows('v2_products'), before.products);
  assert.equal(await countRows('v2_stock_movements'), before.movements);
});

test('the v1 sentinel survives every migration re-apply and RPC unchanged', async () => {
  const d = await db();
  await become(d, 'authenticated');
  await d.query('select * from public.v2_create_product($1,$2,$3)', ['Sentinela check', 100, 1]);
  // v1 belongs to the other business: the v2 identity has no privileges there.
  await expectSqlError(() => d.query('select 1 from public.sales'), '42501');
  // The sentinel inspection itself runs as the owner (fixture) role.
  await become(d, 'postgres');
  const sentinel = await d.query('select id, note from public.sales order by id');
  assert.deepEqual(sentinel.rows, [{ id: 1, note: 'venta v1 centinela' }]);
  const columns = await d.query(
    "select column_name from information_schema.columns where table_schema='public' and table_name='sales' order by column_name");
  assert.deepEqual(columns.rows.map(r => r.column_name), ['id', 'note']);
});

test('committed probe runs end-to-end in a fresh isolated database', async () => {
  const probeDb = await createStockDb();
  try {
    await probeDb.exec('create table public.sales (id int primary key, note text)');
    await probeDb.query('insert into public.sales values (1, $1)', ['venta v1 centinela']);
    await applyMigration(probeDb);
    await runProbe(probeDb); // rolls back; any FALLO aborts with an error
  } finally {
    await probeDb.close();
  }
});
