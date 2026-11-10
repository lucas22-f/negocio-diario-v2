-- v2 stock schema functional probe, T2 of odd/tasks/stock-v2.md (S1,S3-S5).
--
-- !! LOCAL-ONLY PROBE — NEVER RUN IT AGAINST THE SUPABASE PROJECT !!
-- It drops the registry FK and inserts a SYNTHETIC registry row with a fake
-- uid inside its transaction (undone only by the rollback). On the real
-- cloud project that must never happen; the safe hosted rollback-probe PLAN
-- (DML-only, real bound uid, JSON claims, no registry/FK/auth mutation) is
-- documented in supabase/README.md and is intentionally NOT implemented here.
--
-- ROLLBACK-ONLY functional probe for the parent or an independent verifier
-- against a real PostgreSQL (Supabase psql) or the in-memory PGlite fixture
-- (test/helpers/stock-db.js strips the psql meta commands and supplies the
-- transaction). The probe has been EXECUTED against PGlite; a Supabase run
-- with psql remains the pending independent proof.
--
-- Properties of this probe:
--   * Single transaction, always rolled back: it leaves zero state behind.
--   * No writes to auth.users, ever. The synthetic test identity exists only
--     as a registry row created inside this transaction (its FK constraint is
--     dropped locally for that purpose and restored by the rollback).
--   * The SAME Supabase project legitimately contains the v1 public.sales
--     table. The runner must provide it (real cloud has it; the PGlite
--     fixture creates a sentinel). The probe fingerprints its columns, rows
--     and privileges BEFORE anything runs and asserts the fingerprint is
--     IDENTICAL after every migration-era operation — never absent.
--   * Failure sentinels use SQLSTATE P9999 (errcode = 'P9999'), a code no
--     expected-error handler below matches, so a probe bug can never swallow
--     its own failure through a P0001/P0002/40001/23505/28000 handler.
--   * Public-interface checks: results and rejected invariants are observed
--     through the RPCs and RLS SELECTs, not by inspecting internal counters.
--
-- Expected run: psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -f test/stock-probe.sql
-- Every failure aborts the transaction, so a clean run plus the final ROLLBACK
-- means all assertions below held.

\set TEST_UID '99999999-9999-9999-9999-999999999999'

begin;

set local role postgres;

-- v1 fingerprint BEFORE: shape, row count and privileges of public.sales.
create temp table v1_fingerprint_before as
select case
  when to_regclass('public.sales') is null then 'absent'
  else 'columns=' || (select count(*)::text from information_schema.columns
                      where table_schema = 'public' and table_name = 'sales')
       || ';rows=' || (select count(*)::text from public.sales)
       || ';acl=' || coalesce((select relacl::text from pg_class
                               where oid = 'public.sales'::regclass), 'null')
end as fingerprint;

-- The registry FK points at auth.users; for the synthetic uid we lift it
-- inside this transaction only (no auth.users row is created or modified).
alter table public.v2_business_account drop constraint v2_business_account_owner_fkey;

insert into public.v2_business_account (owner, email)
values (:'TEST_UID', 'pochoclos@negocio.com');

-- The registry is a singleton: a second binding must fail.
do $$
begin
  begin
    insert into public.v2_business_account (owner, email)
    values ('99999999-9999-9999-9999-999999999998', 'pochoclos@negocio.com');
    raise exception 'FALLO: se acepto un segundo registro de negocio' using errcode = 'P9999';
  exception when unique_violation then
    null; -- esperado
  end;
end $$;

-- Simulate the authenticated caller exactly as modern PostgREST would: role
-- plus the verified JWT claims delivered as ONE JSON GUC (request.jwt.claims).
set local role authenticated;
set local request.jwt.claims = '{"sub":"99999999-9999-9999-9999-999999999999","email":"pochoclos@negocio.com"}';

-- 1. RLS: empty lists before any write, through the public SELECT interface.
do $$
begin
  if exists (select 1 from public.v2_sales)
  or exists (select 1 from public.v2_products)
  or exists (select 1 from public.v2_stock_movements) then
    raise exception 'FALLO: las tablas v2 deberian empezar vacias' using errcode = 'P9999';
  end if;
end $$;

-- 2. Product create: nullable price, initial stock audited.
select * from public.v2_create_product('Pochoclos grandes', 5000, 10);
select * from public.v2_create_product('Nachos', null, 4);
do $$
declare
  p record;
begin
  select * into p from public.v2_products where name = 'Pochoclos grandes';
  if p.stock <> 10 or p.price_cents <> 5000 or p.archived then
    raise exception 'FALLO: producto creado con datos inesperados' using errcode = 'P9999';
  end if;
  if (select count(*) from public.v2_stock_movements where product_id = p.id and delta = 10 and reason = 'adjust') <> 1 then
    raise exception 'FALLO: el stock inicial no quedo auditado' using errcode = 'P9999';
  end if;
end $$;

-- 3. Product uniqueness among active products.
do $$
begin
  begin
    perform public.v2_create_product('  pochoclos grandes  ', 6000, 1);
    raise exception 'FALLO: se acepto un producto duplicado' using errcode = 'P9999';
  exception when unique_violation then
    null; -- esperado
  end;
end $$;

-- 4. Sale create with product: stock decremented and audited once.
select * from public.v2_create_sale(
  '11111111-1111-1111-1111-111111111111', '2026-01-15', 'Pochoclos grandes',
  'efectivo', 15000, (select id from public.v2_products where name = 'Pochoclos grandes'), 3, false);
do $$
declare
  p record;
begin
  select * into p from public.v2_products where name = 'Pochoclos grandes';
  if p.stock <> 7 then
    raise exception 'FALLO: el stock debio quedar en 7, quedo en %', p.stock using errcode = 'P9999';
  end if;
  if (select count(*) from public.v2_stock_movements
      where sale_id = '11111111-1111-1111-1111-111111111111' and reason = 'sale_create') <> 1 then
    raise exception 'FALLO: movimiento de venta duplicado o ausente' using errcode = 'P9999';
  end if;
end $$;

-- 5. Idempotent replay: same id and same content returns the stored row and
-- adds NO movement.
do $$
declare
  again public.v2_sales;
  movements_before bigint;
begin
  select count(*) into movements_before from public.v2_stock_movements;
  select * into again from public.v2_create_sale(
    '11111111-1111-1111-1111-111111111111', '2026-01-15', 'Pochoclos grandes',
    'efectivo', 15000, (select id from public.v2_products where name = 'Pochoclos grandes'), 3, false);
  if again.id <> '11111111-1111-1111-1111-111111111111' then
    raise exception 'FALLO: la reproduccion no devolvio la venta guardada' using errcode = 'P9999';
  end if;
  if (select count(*) from public.v2_stock_movements) <> movements_before then
    raise exception 'FALLO: la reproduccion agrego un movimiento duplicado' using errcode = 'P9999';
  end if;
end $$;

-- 6. Idempotency conflict: same id with different content is rejected 23505.
do $$
begin
  begin
    perform public.v2_create_sale(
      '11111111-1111-1111-1111-111111111111', '2026-01-15', 'Pochoclos grandes',
      'efectivo', 99999, (select id from public.v2_products where name = 'Pochoclos grandes'), 3, false);
    raise exception 'FALLO: se acepto contenido distinto bajo el mismo id' using errcode = 'P9999';
  exception when sqlstate '23505' then
    null; -- esperado
  end;
end $$;

-- 7. Free-text sale without product: no stock, no movement, quantity forced to 1.
select * from public.v2_create_sale(
  '22222222-2222-2222-2222-222222222222', '2026-01-15', 'Combo sorpresa', 'transferencia', 7000, null, 1, false);
do $$
declare
  s record;
begin
  select * into s from public.v2_sales where id = '22222222-2222-2222-2222-222222222222';
  if s.product_id is not null or s.quantity <> 1 then
    raise exception 'FALLO: la venta de texto libre debia quedar sin producto y quantity 1' using errcode = 'P9999';
  end if;
  if exists (select 1 from public.v2_stock_movements where sale_id = s.id) then
    raise exception 'FALLO: la venta de texto libre no debia mover stock' using errcode = 'P9999';
  end if;
end $$;

-- 8. Stock shortage without acknowledgement is rejected (P0001) and leaves
-- both the sale and the stock unchanged.
do $$
declare
  stock_before integer;
begin
  select stock into stock_before from public.v2_products where name = 'Nachos';
  begin
    perform public.v2_create_sale(
      '33333333-3333-3333-3333-333333333331', '2026-01-15', 'Nachos', 'efectivo', 9000,
      (select id from public.v2_products where name = 'Nachos'), 5, false);
    raise exception 'FALLO: se acepto una venta sin stock suficiente' using errcode = 'P9999';
  exception when sqlstate 'P0001' then
    null; -- esperado
  end;
  if (select stock from public.v2_products where name = 'Nachos') <> stock_before then
    raise exception 'FALLO: el stock cambio en una venta rechazada' using errcode = 'P9999';
  end if;
  if exists (select 1 from public.v2_sales where id = '33333333-3333-3333-3333-333333333331') then
    raise exception 'FALLO: la venta rechazada quedo guardada' using errcode = 'P9999';
  end if;
end $$;

-- 9. With the explicit allowNegative acknowledgement the sale goes through
-- and stock goes negative within the protected integer range.
select * from public.v2_create_sale(
  '33333333-3333-3333-3333-333333333332', '2026-01-15', 'Nachos', 'efectivo', 9000,
  (select id from public.v2_products where name = 'Nachos'), 5, true);
do $$
begin
  if (select stock from public.v2_products where name = 'Nachos') <> -1 then
    raise exception 'FALLO: el stock negativo reconocido debio quedar en -1' using errcode = 'P9999';
  end if;
end $$;

-- 10. Edit with CAS: correct previous snapshot applies product switch with
-- exact reversals ( Nachos -1 -> +5 back, Pochoclos 7 -> 7-2 ).
select * from public.v2_edit_sale(
  '33333333-3333-3333-3333-333333333332',
  '2026-01-15', 'Nachos', 'efectivo', 9000,
  (select id from public.v2_products where name = 'Nachos'), 5,
  '2026-01-15', 'Pochoclos grandes', 'efectivo', 10000,
  (select id from public.v2_products where name = 'Pochoclos grandes'), 2, false);
do $$
declare
  nachos integer;
  pochoclos integer;
begin
  select stock into nachos from public.v2_products where name = 'Nachos';
  select stock into pochoclos from public.v2_products where name = 'Pochoclos grandes';
  if nachos <> 4 or pochoclos <> 5 then
    raise exception 'FALLO: reversion del cambio de producto incorrecta (nachos=%, pochoclos=%)', nachos, pochoclos using errcode = 'P9999';
  end if;
end $$;

-- 11. CAS rejects a stale previous snapshot with 40001 and changes nothing.
do $$
begin
  begin
    perform public.v2_edit_sale(
      '33333333-3333-3333-3333-333333333332',
      '2026-01-15', 'Nachos', 'efectivo', 9000,
      (select id from public.v2_products where name = 'Nachos'), 5,
      '2026-01-16', 'Pochoclos grandes', 'efectivo', 10000,
      (select id from public.v2_products where name = 'Pochoclos grandes'), 2, false);
    raise exception 'FALLO: se acepto una edicion con foto vieja' using errcode = 'P9999';
  exception when sqlstate '40001' then
    null; -- esperado
  end;
end $$;

-- 12. Selecting an archived product is rejected even with stock available.
do $$
declare
  pid uuid;
begin
  select id into pid from public.v2_products where name = 'Nachos';
  perform public.v2_archive_product(pid, 4, true);
  begin
    perform public.v2_create_sale(
      '44444444-4444-4444-4444-444444444444', '2026-01-15', 'Nachos', 'efectivo', 9000, pid, 1, false);
    raise exception 'FALLO: se acepto vender un producto archivado' using errcode = 'P9999';
  exception when sqlstate 'P0001' then
    null; -- esperado
  end;
end $$;

-- 13. Delete reverses the consumed stock exactly and audits the reversal.
select * from public.v2_delete_sale(
  '11111111-1111-1111-1111-111111111111',
  '2026-01-15', 'Pochoclos grandes', 'efectivo', 15000,
  (select id from public.v2_products where name = 'Pochoclos grandes'), 3);
do $$
declare
  pochoclos integer;
begin
  select stock into pochoclos from public.v2_products where name = 'Pochoclos grandes';
  if pochoclos <> 8 then
    raise exception 'FALLO: la baja debia devolver 3 unidades, stock=%', pochoclos using errcode = 'P9999';
  end if;
  if (select count(*) from public.v2_stock_movements
      where sale_id = '11111111-1111-1111-1111-111111111111' and reason = 'sale_delete' and delta = 3) <> 1 then
    raise exception 'FALLO: la baja no quedo auditada' using errcode = 'P9999';
  end if;
end $$;

-- 14. Direct DML must not bypass atomicity: INSERT/UPDATE/DELETE on the tables
-- is denied to the authenticated role even with the bound identity.
do $$
begin
  begin
    insert into public.v2_sales (id, date, product, payment, amount_cents)
    values ('55555555-5555-5555-5555-555555555555', '2026-01-15', ' directo ', 'efectivo', 100);
    raise exception 'FALLO: el INSERT directo no fue bloqueado' using errcode = 'P9999';
  exception when insufficient_privilege then
    null; -- esperado
  end;
  begin
    update public.v2_products set stock = 0;
    raise exception 'FALLO: el UPDATE directo no fue bloqueado' using errcode = 'P9999';
  exception when insufficient_privilege then
    null; -- esperado
  end;
  begin
    delete from public.v2_stock_movements;
    raise exception 'FALLO: el DELETE directo del audit no fue bloqueado' using errcode = 'P9999';
  exception when insufficient_privilege then
    null; -- esperado
  end;
  begin
    perform 1 from public.v2_business_account;
    raise exception 'FALLO: el registro privado es visible para clientes' using errcode = 'P9999';
  exception when insufficient_privilege then
    null; -- esperado
  end;
end $$;

-- 15. Identity guard: a bound uid with the WRONG email fails closed with 28000.
set local request.jwt.claims = '{"sub":"99999999-9999-9999-9999-999999999999","email":"otro@negocio.com"}';
do $$
begin
  begin
    perform public.v2_create_sale(
      '66666666-6666-6666-6666-666666666666', '2026-01-15', 'X', 'efectivo', 100, null, 1, false);
    raise exception 'FALLO: se acepto un email no vinculado' using errcode = 'P9999';
  exception when sqlstate '28000' then
    null; -- esperado
  end;
end $$;

-- 16. A completely unknown uid fails closed too.
set local request.jwt.claims = '{"sub":"88888888-8888-8888-8888-888888888888","email":"pochoclos@negocio.com"}';
do $$
begin
  begin
    perform public.v2_create_sale(
      '66666666-6666-6666-6666-666666666667', '2026-01-15', 'X', 'efectivo', 100, null, 1, false);
    raise exception 'FALLO: se acepto un uid no vinculado' using errcode = 'P9999';
  exception when sqlstate '28000' then
    null; -- esperado
  end;
end $$;

-- 17. RLS also fails closed for reads: unknown uid sees zero v2 rows.
do $$
begin
  if exists (select 1 from public.v2_sales) or exists (select 1 from public.v2_products) then
    raise exception 'FALLO: un uid no vinculado ve filas del negocio' using errcode = 'P9999';
  end if;
end $$;

-- 16b. Missing and malformed MODERN claims fail closed with 28000, and no
-- sale/movement counter ever moves (rejected invariants, public interface).
set local request.jwt.claims = ''; -- PostgREST never sends an empty JWT; helpers treat it as absent
do $$
begin
  begin
    perform public.v2_create_sale(
      '66666666-6666-6666-6666-666666666668', '2026-01-15', 'X', 'efectivo', 100, null, 1, false);
    raise exception 'FALLO: se acepto una sesion sin reclamos' using errcode = 'P9999';
  exception when sqlstate '28000' then
    null; -- esperado
  end;
end $$;
set local request.jwt.claims = 'no-es-json';
do $$
begin
  begin
    perform public.v2_create_sale(
      '66666666-6666-6666-6666-666666666669', '2026-01-15', 'X', 'efectivo', 100, null, 1, false);
    raise exception 'FALLO: se acepto un reclamo JSON malformado' using errcode = 'P9999';
  exception when sqlstate '28000' then
    null; -- esperado
  end;
end $$;
set local request.jwt.claims = '{"sub":"no-es-uuid","email":"pochoclos@negocio.com"}';
do $$
begin
  begin
    perform public.v2_create_sale(
      '66666666-6666-6666-6666-66666666666a', '2026-01-15', 'X', 'efectivo', 100, null, 1, false);
    raise exception 'FALLO: se acepto un sub que no es uuid' using errcode = 'P9999';
  exception when sqlstate '28000' then
    null; -- esperado
  end;
  if exists (select 1 from public.v2_sales) or exists (select 1 from public.v2_products)
  or exists (select 1 from public.v2_stock_movements) then
    raise exception 'FALLO: reclamos malformados ven filas del negocio' using errcode = 'P9999';
  end if;
end $$;

-- v1 fingerprint AFTER (as postgres: information_schema visibility is
-- role-dependent, so the owner does the final comparison): identical shape,
-- rows and privileges proves v1 was never touched.
set local role postgres;
do $$
declare
  after_fp text;
  before_fp text;
begin
  select fingerprint into before_fp from v1_fingerprint_before;
  select case
    when to_regclass('public.sales') is null then 'absent'
    else 'columns=' || (select count(*)::text from information_schema.columns
                        where table_schema = 'public' and table_name = 'sales')
         || ';rows=' || (select count(*)::text from public.sales)
         || ';acl=' || coalesce((select relacl::text from pg_class
                                 where oid = 'public.sales'::regclass), 'null')
  end into after_fp;
  if after_fp <> before_fp then
    raise exception 'FALLO AISLAMIENTO V1: public.sales cambio (antes=%, despues=%)', before_fp, after_fp using errcode = 'P9999';
  end if;
end $$;

rollback;
