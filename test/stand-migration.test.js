import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createStockDb, seedAuthUser, become, expectSqlError } from './helpers/stock-db.js';

const migration = name => readFileSync(new URL('../supabase/migrations/' + name, import.meta.url), 'utf8');
test('stand migration preserves populated legacy rows, signatures, security and initial quantities', async () => {
  const db = await createStockDb();
  try {
    await seedAuthUser(db);
    await db.exec(migration('0001_v2_stock.sql'));
    await become(db, 'authenticated');
    const id = 'bbbb0000-0000-4000-8000-000000000001';
    const create = [id, '2026-03-01', 'Legacy populated', 'efectivo', 200000, null, 1, false];
    await db.query('select public.v2_create_sale($1,$2,$3,$4,$5,$6,$7,$8)', create);
    await db.exec('reset role');
    const sql = migration('0002_sale_stand.sql');
    await db.exec(sql);
    await db.exec(sql);
    await become(db, 'authenticated');
    assert.deepEqual((await db.query('select product, amount_cents, quantity, stand from public.v2_sales')).rows,
      [{ product: 'Legacy populated', amount_cents: 200000, quantity: 1, stand: null }]);
    const old = await db.query('select * from public.v2_create_sale($1,$2,$3,$4,$5,$6,$7,$8)', create);
    assert.equal(old.rows[0].stand, null);
    const call = () => db.query('select public.v2_create_sale_at_stand($1,$2,$3,$4,$5,$6,$7,$8,$9)',
      ['bbbb0000-0000-4000-8000-000000000002', ...create.slice(1), 'mobile']);
    await become(db, 'anon');
    await expectSqlError(call, '42501');
    await become(db, 'authenticated', { email: 'different@example.test' });
    await expectSqlError(call, '28000');
    await become(db, 'authenticated');
    assert.equal((await db.query('select count(*)::int as n from public.v2_sales')).rows[0].n, 1);
    assert.equal((await db.query('select count(*)::int as n from public.v2_stock_movements')).rows[0].n, 0);
  } finally { await db.close(); }
});
