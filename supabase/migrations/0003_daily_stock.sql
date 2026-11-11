-- Daily stock by date and stand, T1 of odd/tasks/daily-stand-stock.md (S1-S5).
--
-- Strictly additive over 0001/0002 (which stay byte-for-byte unchanged). It
-- introduces a per-product/date/stand daily load so each calendar day starts
-- with NO load, keeps the day's original load separate from later
-- replenishments, and derives sold/available from the v2_sales rows that the
-- daily channel created — never from the legacy global stock.
--
-- LEGACY GLOBAL MIRROR STRATEGY (decided before implementation, L5):
--   * v2_products.stock and v2_stock_movements remain the legacy global
--     ledger. Daily RPCs NEVER read, write or audit them, so a global
--     shortage can never block a daily sale and daily balances never consult
--     global stock as authority. Global stock becomes a non-authoritative
--     mirror for legacy clients; there is no backfill and no reconciliation.
--   * Every sale row created by the daily RPCs is tagged daily_stock = true
--     (and always carries a stand). Legacy RPCs — re-created below with their
--     EXACT original signatures — refuse any operation on a daily-tagged row
--     (SQLSTATE 55006, VENTA_DIARIA:) instead of silently corrupting the
--     mirror, and the daily RPCs refuse untagged (legacy) rows the same way.
--     Untagged sales keep the exact legacy behavior (global stock movements).
--   * Historical sales are untouched: no backfill, no stand assignment for
--     null/unknown historical stands, no fabricated historical loads.

-- ---------------------------------------------------------------------------
-- Tables and tags
-- ---------------------------------------------------------------------------

-- One row per product/date/stand that has been given a load. A day starts
-- with no rows at all: absence IS the zero default, never a fabricated load.
create table if not exists public.v2_daily_stock (
  product_id uuid not null references public.v2_products(id),
  date date not null,
  stand text not null check (stand in ('fixed', 'mobile')),
  -- The day's original load (defined at start or copied). Kept separate from
  -- the units added later during the day (replenished).
  initial_load integer not null default 0 check (initial_load between 0 and 1000000),
  replenished integer not null default 0 check (replenished between 0 and 1000000),
  created_at timestamptz not null default now(),
  primary key (product_id, date, stand)
);

alter table public.v2_sales add column if not exists daily_stock boolean not null default false;

-- A daily sale is always attributed to a stand; legacy rows keep null.
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'v2_sales_daily_requires_stand') then
    alter table public.v2_sales
      add constraint v2_sales_daily_requires_stand check (not daily_stock or stand is not null);
  end if;
end $$;

-- Sold is derived by aggregating the tagged sales; this index keeps it cheap.
create index if not exists v2_sales_daily_sold_idx on public.v2_sales (date, stand, product_id) where daily_stock;

-- ---------------------------------------------------------------------------
-- Internal helpers (never callable by clients)
-- ---------------------------------------------------------------------------

-- Daily availability for one product/date/stand: loaded minus the quantity of
-- daily-tagged sales. MUST be called only after the caller locked the shared
-- product rows, so READ COMMITTED re-derives the balance on fresh data.
create or replace function public.v2_daily_available(p_product_id uuid, p_date date, p_stand text, p_exclude_sale uuid default null) returns integer
security definer set search_path = '' language plpgsql stable as $$
declare
  v_loaded integer;
  v_sold integer;
begin
  select coalesce(initial_load, 0) + coalesce(replenished, 0) into v_loaded
    from public.v2_daily_stock
    where product_id = p_product_id and date = p_date and stand = p_stand;
  select coalesce(sum(quantity), 0) into v_sold
    from public.v2_sales
    where daily_stock and date = p_date and stand = p_stand
      and product_id = p_product_id
      and (p_exclude_sale is null or id <> p_exclude_sale);
  return coalesce(v_loaded, 0) - coalesce(v_sold, 0);
end $$ ;

-- ---------------------------------------------------------------------------
-- Daily read (S1, S4)
-- ---------------------------------------------------------------------------

-- One row per (product, stand) for the requested date: every active product
-- (zero default for an unconfigured day) plus any product that has a load or
-- a tagged sale that day (history stays readable even if later archived).
-- Columns match the approved view: initial · loaded (cargada) · sold (vendido)
-- · available (disponible), with the catalog identity and current price.
create or replace function public.v2_read_daily_stock(p_date date) returns table(product_id uuid, product text, price_cents bigint, stand text, initial_load integer, loaded integer, sold integer, available integer)
security definer set search_path = '' language plpgsql stable as $$
begin
  perform public.v2_assert_identity();
  if p_date is null then
    raise exception 'Elegí una fecha válida.' using errcode = '22023';
  end if;
  return query
    select p.id, p.name, p.price_cents, s.stand,
      coalesce(d.initial_load, 0),
      coalesce(d.initial_load, 0) + coalesce(d.replenished, 0),
      coalesce(x.sold, 0)::integer,
      (coalesce(d.initial_load, 0) + coalesce(d.replenished, 0) - coalesce(x.sold, 0))::integer
    from (values ('fixed'::text), ('mobile'::text)) as s(stand)
    cross join (
      select pr.id, pr.name, pr.price_cents from public.v2_products pr where not pr.archived
      union
      select pr.id, pr.name, pr.price_cents
        from public.v2_daily_stock ds join public.v2_products pr on pr.id = ds.product_id
        where ds.date = p_date
      union
      select distinct pr.id, pr.name, pr.price_cents
        from public.v2_sales sl join public.v2_products pr on pr.id = sl.product_id
        where sl.daily_stock and sl.date = p_date
    ) p
    left join public.v2_daily_stock d
      on d.product_id = p.id and d.date = p_date and d.stand = s.stand
    left join lateral (
      select sum(sl.quantity) as sold from public.v2_sales sl
      where sl.daily_stock and sl.date = p_date and sl.stand = s.stand and sl.product_id = p.id
    ) x on true
    order by p.name, s.stand;
end $$ ;

-- ---------------------------------------------------------------------------
-- Daily load and replenishment (S1, S4)
-- ---------------------------------------------------------------------------

-- Defines the day's initial load. p_items is a JSON array of
--   { "productId": uuid, "initial": integer 0..1000000, "prevInitial": integer|null }
-- where prevInitial is the observed current initial load (null = the product
-- had no load yet). Per-item compare-and-swap: any mismatch raises 40001 and
-- the whole call leaves the day untouched. Replenished values are never
-- touched here. Returns the number of items applied.
create or replace function public.v2_load_daily_stock(p_date date, p_stand text, p_items jsonb, p_allow_negative boolean default false) returns integer
security definer set search_path = '' language plpgsql as $$
declare
  v_item jsonb;
  v_ids uuid[] := '{}';
  v_initials integer[] := '{}';
  v_prevs integer[] := '{}';
  v_pid uuid;
  v_initial integer;
  v_prev integer;
  v_i integer;
  v_prod public.v2_products;
  v_row public.v2_daily_stock;
  v_sold integer;
  v_loaded integer;
begin
  perform public.v2_assert_identity();
  if p_date is null then
    raise exception 'Elegí una fecha válida.' using errcode = '22023';
  end if;
  if p_stand is null or p_stand not in ('fixed', 'mobile') then
    raise exception 'Elegí Puesto fijo o Móvil.' using errcode = '22023';
  end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array' then
    raise exception 'La carga debe enviarse como una lista de productos.' using errcode = '22023';
  end if;

  -- Validate every item first, then lock all involved product rows in
  -- ascending uuid order before any balance is derived.
  for v_item in select * from jsonb_array_elements(p_items) loop
    if v_item is null or jsonb_typeof(v_item) <> 'object' then
      raise exception 'Cada carga necesita un producto y una cantidad.' using errcode = '22023';
    end if;
    if v_item ->> 'productId' is null then
      raise exception 'Cada carga necesita un producto.' using errcode = '22023';
    end if;
    v_pid := (v_item ->> 'productId')::uuid;
    if jsonb_typeof(v_item -> 'initial') is distinct from 'number'
       or (v_item ->> 'initial')::integer is null
       or (v_item ->> 'initial')::integer < 0
       or (v_item ->> 'initial')::integer > 1000000 then
      raise exception 'La carga inicial debe estar entre 0 y 1000000.' using errcode = '22023';
    end if;
    -- An explicit JSON null counts as absent (clients send named keys with
    -- null included), so only non-number, non-null values are invalid.
    if v_item -> 'prevInitial' is not null
       and jsonb_typeof(v_item -> 'prevInitial') not in ('number', 'null') then
      raise exception 'La carga observada no es válida.' using errcode = '22023';
    end if;
    v_initial := (v_item ->> 'initial')::integer;
    v_prev := (v_item ->> 'prevInitial')::integer;
    if v_pid = any(v_ids) then
      raise exception 'La lista de carga tiene productos repetidos.' using errcode = '22023';
    end if;
    v_ids := array_append(v_ids, v_pid);
    v_initials := array_append(v_initials, v_initial);
    v_prevs := array_append(v_prevs, v_prev);
  end loop;

  perform 1 from public.v2_products p where p.id = any(v_ids) order by p.id for update;

  v_i := 0;
  while v_i < cardinality(v_ids) loop
    v_i := v_i + 1;
    v_pid := v_ids[v_i];
    v_initial := v_initials[v_i];
    v_prev := v_prevs[v_i];

    select * into v_prod from public.v2_products where id = v_pid;
    if not found then
      raise exception 'El producto vinculado ya no existe.' using errcode = '23503';
    end if;
    if v_prod.archived then
      raise exception 'PRODUCTO_INACTIVO: ese producto esta archivado.' using errcode = 'P0001';
    end if;

    select * into v_row from public.v2_daily_stock
      where product_id = v_pid and date = p_date and stand = p_stand for update;
    -- A null observed value means "no load yet" (zero); an absent row IS zero,
    -- so both sides are compared through the same coalesce.
    if coalesce(v_prev, 0) is distinct from coalesce(v_row.initial_load, 0) then
      raise exception 'La carga cambió desde otro dispositivo. Volvé a abrir el día con los datos actualizados.' using errcode = '40001';
    end if;

    -- Redefining a day may not silently swallow what was already sold.
    select coalesce(sum(quantity), 0) into v_sold from public.v2_sales
      where daily_stock and date = p_date and stand = p_stand and product_id = v_pid;
    v_loaded := v_initial + coalesce(v_row.replenished, 0);
    if v_loaded < v_sold and not coalesce(p_allow_negative, false) then
      raise exception 'STOCK_INSUFICIENTE: stock=%, solicitado=%',
        coalesce(v_row.initial_load, 0) + coalesce(v_row.replenished, 0) - v_sold, v_loaded
        using errcode = 'P0001';
    end if;

    if not found and v_initial = 0 then
      continue; -- absence is the zero default: never fabricate a load row
    end if;
    insert into public.v2_daily_stock (product_id, date, stand, initial_load, replenished)
      values (v_pid, p_date, p_stand, v_initial, coalesce(v_row.replenished, 0))
      on conflict (product_id, date, stand) do update set initial_load = excluded.initial_load;
  end loop;
  return v_i;
end $$ ;

-- Adds units during the day (S4: "agregar unidades"). p_items is a JSON array
-- of { "productId": uuid, "replenished": integer 0..1000000, "prevReplenished":
-- integer|null } where replenished is the NEW cumulative total added that day
-- (not a delta) and prevReplenished the observed one (null = no additions yet).
-- The initial load is never rewritten. Same CAS, validation and locking rules.
create or replace function public.v2_replenish_daily_stock(p_date date, p_stand text, p_items jsonb, p_allow_negative boolean default false) returns integer
security definer set search_path = '' language plpgsql as $$
declare
  v_item jsonb;
  v_ids uuid[] := '{}';
  v_values integer[] := '{}';
  v_prevs integer[] := '{}';
  v_pid uuid;
  v_value integer;
  v_prev integer;
  v_i integer;
  v_prod public.v2_products;
  v_row public.v2_daily_stock;
  v_sold integer;
begin
  perform public.v2_assert_identity();
  if p_date is null then
    raise exception 'Elegí una fecha válida.' using errcode = '22023';
  end if;
  if p_stand is null or p_stand not in ('fixed', 'mobile') then
    raise exception 'Elegí Puesto fijo o Móvil.' using errcode = '22023';
  end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array' then
    raise exception 'El agregado debe enviarse como una lista de productos.' using errcode = '22023';
  end if;

  for v_item in select * from jsonb_array_elements(p_items) loop
    if v_item is null or jsonb_typeof(v_item) <> 'object' then
      raise exception 'Cada agregado necesita un producto y una cantidad.' using errcode = '22023';
    end if;
    if v_item ->> 'productId' is null then
      raise exception 'Cada agregado necesita un producto.' using errcode = '22023';
    end if;
    v_pid := (v_item ->> 'productId')::uuid;
    if jsonb_typeof(v_item -> 'replenished') is distinct from 'number'
       or (v_item ->> 'replenished')::integer is null
       or (v_item ->> 'replenished')::integer < 0
       or (v_item ->> 'replenished')::integer > 1000000 then
      raise exception 'El agregado del día debe estar entre 0 y 1000000.' using errcode = '22023';
    end if;
    if v_item -> 'prevReplenished' is not null
       and jsonb_typeof(v_item -> 'prevReplenished') not in ('number', 'null') then
      raise exception 'El agregado observado no es válido.' using errcode = '22023';
    end if;
    v_value := (v_item ->> 'replenished')::integer;
    v_prev := (v_item ->> 'prevReplenished')::integer;
    if v_pid = any(v_ids) then
      raise exception 'La lista de agregados tiene productos repetidos.' using errcode = '22023';
    end if;
    v_ids := array_append(v_ids, v_pid);
    v_values := array_append(v_values, v_value);
    v_prevs := array_append(v_prevs, v_prev);
  end loop;

  perform 1 from public.v2_products p where p.id = any(v_ids) order by p.id for update;

  v_i := 0;
  while v_i < cardinality(v_ids) loop
    v_i := v_i + 1;
    v_pid := v_ids[v_i];
    v_value := v_values[v_i];
    v_prev := v_prevs[v_i];

    select * into v_prod from public.v2_products where id = v_pid;
    if not found then
      raise exception 'El producto vinculado ya no existe.' using errcode = '23503';
    end if;
    if v_prod.archived then
      raise exception 'PRODUCTO_INACTIVO: ese producto esta archivado.' using errcode = 'P0001';
    end if;

    select * into v_row from public.v2_daily_stock
      where product_id = v_pid and date = p_date and stand = p_stand for update;
    if coalesce(v_prev, 0) is distinct from coalesce(v_row.replenished, 0) then
      raise exception 'La carga cambió desde otro dispositivo. Volvé a abrir el día con los datos actualizados.' using errcode = '40001';
    end if;

    select coalesce(sum(quantity), 0) into v_sold from public.v2_sales
      where daily_stock and date = p_date and stand = p_stand and product_id = v_pid;
    if coalesce(v_row.initial_load, 0) + v_value < v_sold and not coalesce(p_allow_negative, false) then
      raise exception 'STOCK_INSUFICIENTE: stock=%, solicitado=%',
        coalesce(v_row.initial_load, 0) + coalesce(v_row.replenished, 0) - v_sold,
        coalesce(v_row.initial_load, 0) + v_value
        using errcode = 'P0001';
    end if;

    if not found and v_value = 0 then
      continue;
    end if;
    insert into public.v2_daily_stock (product_id, date, stand, initial_load, replenished)
      values (v_pid, p_date, p_stand, coalesce(v_row.initial_load, 0), v_value)
      on conflict (product_id, date, stand) do update set replenished = excluded.replenished;
  end loop;
  return v_i;
end $$ ;

-- ---------------------------------------------------------------------------
-- Optional copy (S3)
-- ---------------------------------------------------------------------------

-- Copies the PREVIOUS CALENDAR DAY's initial load for the same stand. It
-- copies the prepared quantities only: never the replenishments, never the
-- sold or available balances, and never across stands. A day that already has
-- its own load is refused atomically (nothing is inserted and nothing is
-- overwritten). A previous day without load is a successful no-op.
create or replace function public.v2_copy_daily_stock(p_date date, p_stand text) returns setof public.v2_daily_stock
security definer set search_path = '' language plpgsql as $$
declare
  v_source date;
begin
  perform public.v2_assert_identity();
  if p_date is null then
    raise exception 'Elegí una fecha válida.' using errcode = '22023';
  end if;
  if p_stand is null or p_stand not in ('fixed', 'mobile') then
    raise exception 'Elegí Puesto fijo o Móvil.' using errcode = '22023';
  end if;
  v_source := p_date - 1; -- preceding calendar day (leap days and year edges included)

  if exists (select 1 from public.v2_daily_stock where date = p_date and stand = p_stand) then
    raise exception 'EL_DIA_YA_TIENE_CARGA: el día ya tiene su propia carga y no se pisa.' using errcode = '23505';
  end if;

  -- Lock the source product rows in ascending uuid order so a concurrent
  -- load/copy cannot interleave with the snapshot being copied.
  perform 1 from public.v2_products p
    where p.id in (select product_id from public.v2_daily_stock where date = v_source and stand = p_stand)
    order by p.id for update;

  begin
    return query
      with ins as (
        insert into public.v2_daily_stock (product_id, date, stand, initial_load, replenished)
        select d.product_id, p_date, p_stand, d.initial_load, 0
        from public.v2_daily_stock d
        join public.v2_products p on p.id = d.product_id
        where d.date = v_source and d.stand = p_stand
          and not p.archived and d.initial_load > 0
        order by d.product_id
        returning *
      )
      select * from ins;
  exception when unique_violation then
    -- A concurrent writer populated the destination between the check and
    -- the insert: the primary key aborts the whole copy atomically.
    raise exception 'EL_DIA_YA_TIENE_CARGA: el día ya tiene su propia carga y no se pisa.' using errcode = '23505';
  end;
end $$ ;

-- ---------------------------------------------------------------------------
-- Transactional daily sale RPCs (S2, S4, S5)
-- ---------------------------------------------------------------------------

-- Creates a daily sale. Identical identity, idempotency and replay semantics
-- to the legacy create, but the stock gate is the DAILY availability of the
-- product for that date and stand — never the global stock — and global
-- stock/movements are left untouched. p_stand is required.
create or replace function public.v2_create_daily_sale(p_sale_id uuid, p_date date, p_product text, p_payment text, p_amount_cents bigint, p_product_id uuid default null, p_quantity integer default 1, p_allow_negative boolean default false, p_stand text default null) returns public.v2_sales
security definer set search_path = '' language plpgsql as $$
declare
  existing public.v2_sales;
  v_row public.v2_sales;
  v_prod public.v2_products;
  v_available integer;
begin
  perform public.v2_assert_identity();
  if p_stand is null or p_stand not in ('fixed', 'mobile') then
    raise exception 'Elegí Puesto fijo o Móvil.' using errcode = '22023';
  end if;
  if p_date is null or p_product is null or p_payment is null or p_amount_cents is null then
    raise exception 'Faltan datos de la venta.' using errcode = '22023';
  end if;

  select * into existing from public.v2_sales where id = p_sale_id;
  if found then
    if not existing.daily_stock then
      raise exception 'VENTA_DIARIA: esa venta pertenece al canal global y solo se modifica con las operaciones globales.' using errcode = '55006';
    end if;
    if existing.date = p_date and existing.product = btrim(p_product)
       and existing.payment = p_payment and existing.amount_cents = p_amount_cents
       and existing.product_id is not distinct from p_product_id
       and existing.quantity = p_quantity
       and existing.stand is not distinct from p_stand then
      return existing;
    end if;
    raise exception 'Ese identificador ya corresponde a otra venta. No se guardaron cambios.' using errcode = '23505';
  end if;

  if p_product_id is not null then
    select * into v_prod from public.v2_products where id = p_product_id for update;
    if not found then
      raise exception 'El producto vinculado ya no existe.' using errcode = '23503';
    end if;
    if v_prod.archived then
      raise exception 'PRODUCTO_INACTIVO: ese producto esta archivado.' using errcode = 'P0001';
    end if;
    -- Balance is derived AFTER the product-row lock (READ COMMITTED re-reads
    -- fresh data), so concurrent daily sales for the same product serialize.
    v_available := public.v2_daily_available(p_product_id, p_date, p_stand);
    if v_available < p_quantity and not coalesce(p_allow_negative, false) then
      raise exception 'STOCK_INSUFICIENTE: stock=%, solicitado=%', v_available, p_quantity using errcode = 'P0001';
    end if;
    -- Deliberately NO v2_products.stock update and NO v2_stock_movements row.
  end if;

  insert into public.v2_sales (id, date, product, payment, amount_cents, product_id, quantity, stand, daily_stock)
    values (p_sale_id, p_date, btrim(p_product), p_payment, p_amount_cents, p_product_id, p_quantity, p_stand, true)
    returning * into v_row;
  return v_row;
end $$ ;

-- Edits a daily sale with compare-and-swap on the full observed snapshot
-- (date, product, payment, amount, product link, quantity, stand). p_sale is
-- the normalized new sale object, p_previous the observed one:
--   { "id": uuid, "date": "YYYY-MM-DD", "product": text, "payment": text,
--     "amountCents": bigint, "productId": uuid|null, "quantity": integer,
--     "stand": "fixed"|"mobile", "allowNegative": boolean (new only) }
-- Moving a sale between dates/stands/products only re-derives balances; the
-- global stock and the movement audit are never touched. Editing a legacy
-- (untagged) row is refused with 55006 — use the legacy RPCs for those.
create or replace function public.v2_edit_daily_sale(p_sale jsonb, p_previous jsonb) returns public.v2_sales
security definer set search_path = '' language plpgsql as $$
declare
  cur public.v2_sales;
  v_row public.v2_sales;
  v_prod public.v2_products;
  v_id uuid;
  v_date date;
  v_product text;
  v_payment text;
  v_amount bigint;
  v_pid uuid;
  v_quantity integer;
  v_stand text;
  v_allow boolean;
  v_available integer;
begin
  perform public.v2_assert_identity();
  if p_sale is null or jsonb_typeof(p_sale) <> 'object'
     or p_previous is null or jsonb_typeof(p_previous) <> 'object' then
    raise exception 'Faltan datos de la venta.' using errcode = '22023';
  end if;
  v_id := (p_sale ->> 'id')::uuid;
  if v_id is null then
    raise exception 'Faltan datos de la venta.' using errcode = '22023';
  end if;

  -- The channel guard runs before any other validation: an attempt to edit a
  -- legacy (untagged) row through the daily channel is refused as such even
  -- if the rest of the payload is malformed.
  select * into cur from public.v2_sales where id = v_id for update;
  if not found then
    raise exception 'La venta ya no existe o se eliminó desde otro dispositivo.' using errcode = 'P0002';
  end if;
  if not cur.daily_stock then
    raise exception 'VENTA_DIARIA: esa venta pertenece al canal global y solo se modifica con las operaciones globales.' using errcode = '55006';
  end if;

  v_date := (p_sale ->> 'date')::date;
  v_product := p_sale ->> 'product';
  v_payment := p_sale ->> 'payment';
  v_amount := (p_sale ->> 'amountCents')::bigint;
  v_pid := (p_sale ->> 'productId')::uuid;
  v_quantity := (p_sale ->> 'quantity')::integer;
  v_stand := p_sale ->> 'stand';
  v_allow := coalesce((p_sale ->> 'allowNegative')::boolean, false);
  if v_date is null or v_product is null or v_payment is null
     or v_amount is null or v_quantity is null
     or v_stand is null or v_stand not in ('fixed', 'mobile') then
    raise exception 'Faltan datos de la venta.' using errcode = '22023';
  end if;
  if cur.date is distinct from (p_previous ->> 'date')::date
     or cur.product is distinct from (p_previous ->> 'product')
     or cur.payment is distinct from (p_previous ->> 'payment')
     or cur.amount_cents is distinct from (p_previous ->> 'amountCents')::bigint
     or cur.product_id is distinct from (p_previous ->> 'productId')::uuid
     or cur.quantity is distinct from (p_previous ->> 'quantity')::integer
     or cur.stand is distinct from (p_previous ->> 'stand') then
    raise exception 'La venta cambió desde otro dispositivo. Cancelá la edición y volvé a abrirla con los datos actualizados.' using errcode = '40001';
  end if;

  -- Lock every involved product row (old and new link) in ascending uuid
  -- order before deriving any balance.
  perform 1 from public.v2_products p
    where p.id in (cur.product_id, v_pid) order by p.id for update;

  if v_pid is not null then
    select * into v_prod from public.v2_products where id = v_pid;
    if not found then
      raise exception 'El producto vinculado ya no existe.' using errcode = '23503';
    end if;
    if v_prod.archived then
      raise exception 'PRODUCTO_INACTIVO: ese producto esta archivado.' using errcode = 'P0001';
    end if;
    v_available := public.v2_daily_available(v_pid, v_date, v_stand, cur.id);
    if v_available < v_quantity and not v_allow then
      raise exception 'STOCK_INSUFICIENTE: stock=%, solicitado=%', v_available, v_quantity using errcode = 'P0001';
    end if;
  end if;

  update public.v2_sales set date = v_date, product = btrim(v_product), payment = v_payment,
    amount_cents = v_amount, product_id = v_pid, quantity = v_quantity, stand = v_stand
    where id = v_id
    returning * into v_row;
  return v_row;
end $$ ;

-- Deletes a daily sale with compare-and-swap on the full observed snapshot
-- (the p_previous object above; no allowNegative field). Availability is
-- derived, so nothing needs to be "restored"; the global ledger is untouched.
create or replace function public.v2_delete_daily_sale(p_previous jsonb) returns public.v2_sales
security definer set search_path = '' language plpgsql as $$
declare
  cur public.v2_sales;
  v_row public.v2_sales;
begin
  perform public.v2_assert_identity();
  if p_previous is null or jsonb_typeof(p_previous) <> 'object'
     or (p_previous ->> 'id') is null then
    raise exception 'Faltan datos de la venta.' using errcode = '22023';
  end if;
  select * into cur from public.v2_sales where id = (p_previous ->> 'id')::uuid for update;
  if not found then
    raise exception 'La venta ya no existe o se eliminó desde otro dispositivo.' using errcode = 'P0002';
  end if;
  if not cur.daily_stock then
    raise exception 'VENTA_DIARIA: esa venta pertenece al canal global y solo se modifica con las operaciones globales.' using errcode = '55006';
  end if;
  if cur.date is distinct from (p_previous ->> 'date')::date
     or cur.product is distinct from (p_previous ->> 'product')
     or cur.payment is distinct from (p_previous ->> 'payment')
     or cur.amount_cents is distinct from (p_previous ->> 'amountCents')::bigint
     or cur.product_id is distinct from (p_previous ->> 'productId')::uuid
     or cur.quantity is distinct from (p_previous ->> 'quantity')::integer
     or cur.stand is distinct from (p_previous ->> 'stand') then
    raise exception 'La venta cambió desde otro dispositivo. Cancelá la operación y volvé a abrirla con los datos actualizados.' using errcode = '40001';
  end if;
  delete from public.v2_sales where id = cur.id returning * into v_row;
  return v_row;
end $$ ;

-- ---------------------------------------------------------------------------
-- Legacy RPCs: same signatures, one added fail-closed guard
-- ---------------------------------------------------------------------------
--
-- 0001/0002 stay byte-for-byte unchanged; these create-or-replace definitions
-- carry their exact original bodies plus a single addition: every legacy sale
-- RPC refuses daily-tagged rows (55006) so a legacy client can never silently
-- mutate a daily sale's stock mirror. Untagged rows behave exactly as before.

create or replace function public.v2_create_sale(p_sale_id uuid, p_date date, p_product text, p_payment text, p_amount_cents bigint, p_product_id uuid default null, p_quantity integer default 1, p_allow_negative boolean default false) returns public.v2_sales
security definer set search_path = '' language plpgsql as $$
declare
  existing public.v2_sales;
  v_row public.v2_sales;
  v_prod public.v2_products;
  v_new_stock integer;
begin
  perform public.v2_assert_identity();

  select * into existing from public.v2_sales where id = p_sale_id;
  if found then
    if existing.daily_stock then
      raise exception 'VENTA_DIARIA: esa venta pertenece al stock diario y solo se modifica con las operaciones diarias.' using errcode = '55006';
    end if;
    if existing.date = p_date and existing.product = btrim(p_product)
       and existing.payment = p_payment and existing.amount_cents = p_amount_cents
       and existing.product_id is not distinct from p_product_id
       and existing.quantity = p_quantity then
      return existing;
    end if;
    raise exception 'Ese identificador ya corresponde a otra venta. No se guardaron cambios.' using errcode = '23505';
  end if;

  if p_product_id is not null then
    select * into v_prod from public.v2_products where id = p_product_id for update;
    if not found then
      raise exception 'El producto vinculado ya no existe.' using errcode = '23503';
    end if;
    if v_prod.archived then
      raise exception 'PRODUCTO_INACTIVO: ese producto esta archivado.' using errcode = 'P0001';
    end if;
    v_new_stock := v_prod.stock - p_quantity;
    if v_new_stock < 0 and not coalesce(p_allow_negative, false) then
      raise exception 'STOCK_INSUFICIENTE: stock=%, solicitado=%', v_prod.stock, p_quantity using errcode = 'P0001';
    end if;
    update public.v2_products set stock = v_new_stock where id = p_product_id;
    insert into public.v2_stock_movements (sale_id, product_id, delta, reason)
      values (p_sale_id, p_product_id, -p_quantity, 'sale_create');
  end if;

  insert into public.v2_sales (id, date, product, payment, amount_cents, product_id, quantity)
    values (p_sale_id, p_date, btrim(p_product), p_payment, p_amount_cents, p_product_id, p_quantity)
    returning * into v_row;
  return v_row;
end $$ ;

create or replace function public.v2_edit_sale(p_sale_id uuid, p_prev_date date, p_prev_product text, p_prev_payment text, p_prev_amount_cents bigint, p_prev_product_id uuid, p_prev_quantity integer, p_date date, p_product text, p_payment text, p_amount_cents bigint, p_product_id uuid default null, p_quantity integer default 1, p_allow_negative boolean default false) returns public.v2_sales
security definer set search_path = '' language plpgsql as $$
declare
  cur public.v2_sales;
  v_row public.v2_sales;
  v_prod public.v2_products;
  v_new_stock integer;
begin
  perform public.v2_assert_identity();

  select * into cur from public.v2_sales where id = p_sale_id for update;
  if not found then
    raise exception 'La venta ya no existe o se elimino desde otro dispositivo.' using errcode = 'P0002';
  end if;
  if cur.daily_stock then
    raise exception 'VENTA_DIARIA: esa venta pertenece al stock diario y solo se modifica con las operaciones diarias.' using errcode = '55006';
  end if;

  if cur.date is distinct from p_prev_date or cur.product is distinct from p_prev_product
     or cur.payment is distinct from p_prev_payment or cur.amount_cents is distinct from p_prev_amount_cents
     or cur.product_id is distinct from p_prev_product_id or cur.quantity is distinct from p_prev_quantity then
    raise exception 'La venta cambio desde otro dispositivo. Cancela la edicion y volve a abrirla con los datos actualizados.' using errcode = '40001';
  end if;

  if p_prev_product_id is not null and p_product_id is not null and p_prev_product_id <> p_product_id then
    perform 1 from public.v2_products where id in (p_prev_product_id, p_product_id) order by id for update;
  end if;

  if cur.product_id is not null then
    if p_product_id is null or p_product_id <> cur.product_id then
      update public.v2_products set stock = stock + cur.quantity where id = cur.product_id;
      insert into public.v2_stock_movements (sale_id, product_id, delta, reason)
        values (p_sale_id, cur.product_id, cur.quantity, 'sale_edit');
    end if;
  end if;

  if p_product_id is not null then
    if cur.product_id is null or cur.product_id <> p_product_id then
      select * into v_prod from public.v2_products where id = p_product_id for update;
      if not found then
        raise exception 'El producto vinculado ya no existe.' using errcode = '23503';
      end if;
      if v_prod.archived then
        raise exception 'PRODUCTO_INACTIVO: ese producto esta archivado.' using errcode = 'P0001';
      end if;
      v_new_stock := v_prod.stock - p_quantity;
      if v_new_stock < 0 and not coalesce(p_allow_negative, false) then
        raise exception 'STOCK_INSUFICIENTE: stock=%, solicitado=%', v_prod.stock, p_quantity using errcode = 'P0001';
      end if;
      update public.v2_products set stock = v_new_stock where id = p_product_id;
      insert into public.v2_stock_movements (sale_id, product_id, delta, reason)
        values (p_sale_id, p_product_id, -p_quantity, 'sale_edit');
    elsif cur.quantity <> p_quantity then
      select stock into v_new_stock from public.v2_products where id = p_product_id for update;
      v_new_stock := v_new_stock + cur.quantity - p_quantity;
      if v_new_stock < 0 and not coalesce(p_allow_negative, false) then
        raise exception 'STOCK_INSUFICIENTE: stock=%, solicitado=%', v_new_stock + p_quantity - cur.quantity, p_quantity using errcode = 'P0001';
      end if;
      update public.v2_products set stock = v_new_stock where id = p_product_id;
      insert into public.v2_stock_movements (sale_id, product_id, delta, reason)
        values (p_sale_id, p_product_id, cur.quantity - p_quantity, 'sale_edit');
    end if;
  end if;

  update public.v2_sales set date = p_date, product = btrim(p_product), payment = p_payment,
    amount_cents = p_amount_cents, product_id = p_product_id, quantity = p_quantity
    where id = p_sale_id
    returning * into v_row;
  return v_row;
end $$ ;

create or replace function public.v2_delete_sale(p_sale_id uuid, p_prev_date date, p_prev_product text, p_prev_payment text, p_prev_amount_cents bigint, p_prev_product_id uuid, p_prev_quantity integer) returns public.v2_sales
security definer set search_path = '' language plpgsql as $$
declare
  cur public.v2_sales;
  v_row public.v2_sales;
begin
  perform public.v2_assert_identity();

  select * into cur from public.v2_sales where id = p_sale_id for update;
  if not found then
    raise exception 'La venta ya no existe o se elimino desde otro dispositivo.' using errcode = 'P0002';
  end if;
  if cur.daily_stock then
    raise exception 'VENTA_DIARIA: esa venta pertenece al stock diario y solo se modifica con las operaciones diarias.' using errcode = '55006';
  end if;

  if cur.date is distinct from p_prev_date or cur.product is distinct from p_prev_product
     or cur.payment is distinct from p_prev_payment or cur.amount_cents is distinct from p_prev_amount_cents
     or cur.product_id is distinct from p_prev_product_id or cur.quantity is distinct from p_prev_quantity then
    raise exception 'La venta cambio desde otro dispositivo. Cancela la edicion y volve a abrirla con los datos actualizados.' using errcode = '40001';
  end if;

  if cur.product_id is not null then
    update public.v2_products set stock = stock + cur.quantity where id = cur.product_id;
    insert into public.v2_stock_movements (sale_id, product_id, delta, reason)
      values (p_sale_id, cur.product_id, cur.quantity, 'sale_delete');
  end if;

  delete from public.v2_sales where id = p_sale_id returning * into v_row;
  return v_row;
end $$ ;

create or replace function public.v2_create_sale_at_stand(p_sale_id uuid, p_date date, p_product text, p_payment text, p_amount_cents bigint, p_product_id uuid default null, p_quantity integer default 1, p_allow_negative boolean default false, p_stand text default null) returns public.v2_sales
security definer set search_path = '' language plpgsql as $$
declare
  existing public.v2_sales;
  v_row public.v2_sales;
  v_prod public.v2_products;
  v_new_stock integer;
begin
  perform public.v2_assert_identity();
  if p_stand is null or p_stand not in ('fixed', 'mobile') then
    raise exception 'Elegí Puesto fijo o Móvil.' using errcode = '22023';
  end if;

  select * into existing from public.v2_sales where id = p_sale_id;
  if found then
    if existing.daily_stock then
      raise exception 'VENTA_DIARIA: esa venta pertenece al stock diario y solo se modifica con las operaciones diarias.' using errcode = '55006';
    end if;
    if existing.date = p_date and existing.product = btrim(p_product)
       and existing.payment = p_payment and existing.amount_cents = p_amount_cents
       and existing.product_id is not distinct from p_product_id
       and existing.quantity = p_quantity
       and existing.stand is not distinct from p_stand then
      return existing;
    end if;
    raise exception 'Ese identificador ya corresponde a otra venta. No se guardaron cambios.' using errcode = '23505';
  end if;

  if p_product_id is not null then
    select * into v_prod from public.v2_products where id = p_product_id for update;
    if not found then
      raise exception 'El producto vinculado ya no existe.' using errcode = '23503';
    end if;
    if v_prod.archived then
      raise exception 'PRODUCTO_INACTIVO: ese producto esta archivado.' using errcode = 'P0001';
    end if;
    v_new_stock := v_prod.stock - p_quantity;
    if v_new_stock < 0 and not coalesce(p_allow_negative, false) then
      raise exception 'STOCK_INSUFICIENTE: stock=%, solicitado=%', v_prod.stock, p_quantity using errcode = 'P0001';
    end if;
    update public.v2_products set stock = v_new_stock where id = p_product_id;
    insert into public.v2_stock_movements (sale_id, product_id, delta, reason)
      values (p_sale_id, p_product_id, -p_quantity, 'sale_create');
  end if;

  insert into public.v2_sales (id, date, product, payment, amount_cents, product_id, quantity, stand)
    values (p_sale_id, p_date, btrim(p_product), p_payment, p_amount_cents, p_product_id, p_quantity, p_stand)
    returning * into v_row;
  return v_row;
end $$ ;

-- ---------------------------------------------------------------------------
-- Privileges: clients read through RLS and write only through RPCs
-- ---------------------------------------------------------------------------

revoke all on public.v2_daily_stock from anon, authenticated;
grant select on public.v2_daily_stock to authenticated;

revoke execute on function public.v2_daily_available(uuid, date, text, uuid) from public, anon, authenticated;
revoke execute on function public.v2_read_daily_stock(date) from public, anon;
revoke execute on function public.v2_load_daily_stock(date, text, jsonb, boolean) from public, anon;
revoke execute on function public.v2_replenish_daily_stock(date, text, jsonb, boolean) from public, anon;
revoke execute on function public.v2_copy_daily_stock(date, text) from public, anon;
revoke execute on function public.v2_create_daily_sale(uuid, date, text, text, bigint, uuid, integer, boolean, text) from public, anon;
revoke execute on function public.v2_edit_daily_sale(jsonb, jsonb) from public, anon;
revoke execute on function public.v2_delete_daily_sale(jsonb) from public, anon;

grant execute on function public.v2_read_daily_stock(date) to authenticated;
grant execute on function public.v2_load_daily_stock(date, text, jsonb, boolean) to authenticated;
grant execute on function public.v2_replenish_daily_stock(date, text, jsonb, boolean) to authenticated;
grant execute on function public.v2_copy_daily_stock(date, text) to authenticated;
grant execute on function public.v2_create_daily_sale(uuid, date, text, text, bigint, uuid, integer, boolean, text) to authenticated;
grant execute on function public.v2_edit_daily_sale(jsonb, jsonb) to authenticated;
grant execute on function public.v2_delete_daily_sale(jsonb) to authenticated;

-- ---------------------------------------------------------------------------
-- Row level security
-- ---------------------------------------------------------------------------

alter table public.v2_daily_stock enable row level security;

drop policy if exists v2_daily_stock_select on public.v2_daily_stock;
create policy v2_daily_stock_select on public.v2_daily_stock for select to authenticated using (public.v2_identity_ok());
