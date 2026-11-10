-- v2 stock schema, T2 of odd/tasks/stock-v2.md (S1,S3-S5).
--
-- Isolated v2-only schema for the pochoclos-1 business. It never touches,
-- reads or references v1 tables; its only link to Supabase internals is a
-- read-only SELECT from auth.users to seed the private business account
-- registry below (fail closed when no matching confirmed identity exists).
--
-- Identity model: the private singleton table v2_business_account binds the
-- single owner uuid to the exact approved email pochoclos@negocio.com. Every
-- SELECT is gated by RLS on uid + email + registry, never by email alone.
-- Every write goes through one transactional security-definer RPC that
-- re-checks the identity, locks rows explicitly and appends stock movements.
-- Direct INSERT/UPDATE/DELETE for clients is revoked, so it cannot bypass
-- atomicity. No secrets are stored here.

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

create table if not exists public.v2_products (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(btrim(name)) between 1 and 160),
  price_cents bigint check (price_cents is null or price_cents between 1 and 99999999999),
  stock integer not null default 0 check (stock between -1000000000 and 1000000000),
  archived boolean not null default false
);

create table if not exists public.v2_sales (
  id uuid primary key,
  date date not null,
  product text not null check (char_length(btrim(product)) between 1 and 160),
  payment text not null check (payment in ('efectivo', 'transferencia')),
  amount_cents bigint not null check (amount_cents between 1 and 99999999999),
  row_seq bigint generated always as identity,
  product_id uuid references public.v2_products(id),
  quantity integer not null default 1,
  -- Free-text sales have no product link and always quantity 1; linked sales
  -- consume a positive bounded quantity. The product and amount columns are
  -- snapshots kept verbatim at sale time.
  check ((product_id is null and quantity = 1) or (product_id is not null and quantity between 1 and 1000000))
);

create table if not exists public.v2_stock_movements (
  id bigint generated always as identity primary key,
  sale_id uuid,
  product_id uuid not null references public.v2_products(id),
  delta bigint not null check (delta <> 0 and delta between -2000000000 and 2000000000),
  reason text not null check (reason in ('sale_create', 'sale_edit', 'sale_delete', 'adjust')),
  created_at timestamptz not null default now()
);

create table if not exists public.v2_business_account (
  owner uuid primary key references auth.users(id) on delete cascade,
  email text not null check (email = 'pochoclos@negocio.com'),
  is_registry boolean not null default true check (is_registry),
  bound_at timestamptz not null default now(),
  constraint v2_business_account_singleton unique (is_registry)
);

create index if not exists v2_sales_date_idx on public.v2_sales (date, row_seq);
create index if not exists v2_stock_movements_sale_idx on public.v2_stock_movements (sale_id);
create index if not exists v2_stock_movements_product_idx on public.v2_stock_movements (product_id);
create unique index if not exists v2_products_active_name_key on public.v2_products (lower(btrim(name))) where not archived;
-- One initial stock movement per sale id: an idempotent replay can never
-- append a duplicate decrement even under a race between identity check and insert.
create unique index if not exists v2_stock_movements_sale_create_once on public.v2_stock_movements (sale_id) where reason = 'sale_create';

-- ---------------------------------------------------------------------------
-- Identity helpers
-- ---------------------------------------------------------------------------
--
-- Identity is read EXCLUSIVELY through the Supabase-managed helpers
-- auth.uid() and auth.jwt(). On the hosted project they decode the verified
-- JWT exactly as PostgREST delivers it today: auth.jwt() reads the single
-- `request.jwt.claims` JSON GUC (falling back to the legacy whole-claim JSON
-- GUC), and auth.uid() resolves the sub from that JSON (falling back to the
-- legacy individual sub GUC). v2 never parses transport-specific GUCs
-- itself, so it stays compatible with the modern claims transport.
-- Malformed claim content (unparseable JSON or a non-uuid sub) is caught
-- NARROWLY as invalid_text_representation and denies access; every other
-- database error propagates — failures are never silently turned into
-- anonymous sessions.

-- Read-only gate used by every RLS SELECT policy. It returns true only when
-- the verified JWT sub and email match the single bound registry row.
create or replace function public.v2_identity_ok() returns boolean
security definer set search_path = '' language plpgsql as $$
declare
  claim_sub uuid;
  claim_email text;
  claims jsonb;
begin
  begin
    claim_sub := auth.uid();
    claims := auth.jwt();
  exception when invalid_text_representation then
    return false; -- malformed sub or claims JSON: deny this read, nothing more
  end;
  claim_email := lower(nullif(claims ->> 'email', ''));
  if claim_sub is null or claim_email is null then
    return false;
  end if;
  return exists (
    select 1 from public.v2_business_account a
    where a.owner = claim_sub and a.email = claim_email
  );
end $$ ;

-- Stronger guard for write RPCs: raises when the caller is not the bound
-- identity. Returns the bound owner uuid for audit use.
create or replace function public.v2_assert_identity() returns uuid
security definer set search_path = '' language plpgsql as $$
declare
  claim_sub uuid;
  claim_email text;
  claims jsonb;
  bound uuid;
begin
  begin
    claim_sub := auth.uid();
    claims := auth.jwt();
  exception when invalid_text_representation then
    claim_sub := null; -- malformed sub or claims JSON: fail closed below
  end;
  claim_email := lower(nullif(claims ->> 'email', ''));
  if claim_sub is null or claim_email is null then
    raise exception 'IDENTIDAD_NO_AUTORIZADA: falta la sesion del negocio.' using errcode = '28000';
  end if;
  select a.owner into bound from public.v2_business_account a
    where a.owner = claim_sub and a.email = claim_email;
  if bound is null then
    raise exception 'IDENTIDAD_NO_AUTORIZADA: esta cuenta no esta habilitada para este negocio.' using errcode = '28000';
  end if;
  return bound;
end $$ ;

-- ---------------------------------------------------------------------------
-- Transactional sale RPCs
-- ---------------------------------------------------------------------------

-- Creates a sale. Idempotent: replaying the exact same content returns the
-- stored row without any new stock movement; a different content under the
-- same sale id raises 23505. Linked products are locked and never go below
-- zero stock unless p_allow_negative is explicitly acknowledged.
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

-- Edits a sale with compare-and-swap on the full previous snapshot. Stock is
-- reversed on the previous state and consumed on the new state; when the
-- product switches, both rows are locked in ascending uuid order first.
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

-- Deletes a sale with compare-and-swap, returning the removed row. Stock
-- consumed by the sale is returned and audited.
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

-- ---------------------------------------------------------------------------
-- Transactional product RPCs
-- ---------------------------------------------------------------------------

create or replace function public.v2_create_product(p_name text, p_price_cents bigint default null, p_stock integer default 0) returns public.v2_products
security definer set search_path = '' language plpgsql as $$
declare
  v_row public.v2_products;
begin
  perform public.v2_assert_identity();
  if p_stock < 0 then
    raise exception 'El stock inicial no puede ser negativo.' using errcode = '22023';
  end if;
  insert into public.v2_products (name, price_cents, stock)
    values (btrim(p_name), p_price_cents, p_stock)
    returning * into v_row;
  if p_stock > 0 then
    insert into public.v2_stock_movements (sale_id, product_id, delta, reason)
      values (null, v_row.id, p_stock, 'adjust');
  end if;
  return v_row;
end $$ ;

-- Edits a product with compare-and-swap on the optimistic previous snapshot.
-- A stock change is audited; going below zero requires p_allow_negative.
create or replace function public.v2_edit_product(p_product_id uuid, p_prev_name text, p_prev_price_cents bigint, p_prev_stock integer, p_name text, p_price_cents bigint, p_stock integer, p_allow_negative boolean default false) returns public.v2_products
security definer set search_path = '' language plpgsql as $$
declare
  cur public.v2_products;
  v_row public.v2_products;
begin
  perform public.v2_assert_identity();

  select * into cur from public.v2_products where id = p_product_id for update;
  if not found then
    raise exception 'El producto ya no existe.' using errcode = 'P0002';
  end if;

  if cur.name is distinct from p_prev_name or cur.price_cents is distinct from p_prev_price_cents
     or cur.stock is distinct from p_prev_stock then
    raise exception 'El producto cambio desde otro dispositivo. Volve a abrirlo con los datos actualizados.' using errcode = '40001';
  end if;

  if p_stock < 0 and not coalesce(p_allow_negative, false) then
    raise exception 'STOCK_INSUFICIENTE: stock=%, solicitado=%', cur.stock, p_stock using errcode = 'P0001';
  end if;

  update public.v2_products set name = btrim(p_name), price_cents = p_price_cents, stock = p_stock
    where id = p_product_id
    returning * into v_row;

  if p_stock <> cur.stock then
    insert into public.v2_stock_movements (sale_id, product_id, delta, reason)
      values (null, p_product_id, p_stock - cur.stock, 'adjust');
  end if;
  return v_row;
end $$ ;

-- Archives or restores a product. Archiving never rewrites any sale: sale
-- rows keep their product text and amount snapshots, so history is preserved.
create or replace function public.v2_archive_product(p_product_id uuid, p_prev_stock integer, p_archived boolean) returns public.v2_products
security definer set search_path = '' language plpgsql as $$
declare
  cur public.v2_products;
  v_row public.v2_products;
begin
  perform public.v2_assert_identity();

  select * into cur from public.v2_products where id = p_product_id for update;
  if not found then
    raise exception 'El producto ya no existe.' using errcode = 'P0002';
  end if;

  if cur.stock is distinct from p_prev_stock then
    raise exception 'El producto cambio desde otro dispositivo. Volve a abrirlo con los datos actualizados.' using errcode = '40001';
  end if;

  update public.v2_products set archived = p_archived
    where id = p_product_id
    returning * into v_row;
  return v_row;
end $$ ;

-- ---------------------------------------------------------------------------
-- Privileges: clients read through RLS and write only through RPCs
-- ---------------------------------------------------------------------------

revoke all on public.v2_products from anon, authenticated;
revoke all on public.v2_sales from anon, authenticated;
revoke all on public.v2_stock_movements from anon, authenticated;
revoke all on public.v2_business_account from anon, authenticated;
grant select on public.v2_products, public.v2_sales, public.v2_stock_movements to authenticated;

revoke execute on function public.v2_identity_ok() from public, anon, authenticated;
revoke execute on function public.v2_assert_identity() from public, anon, authenticated;
revoke execute on function public.v2_create_sale(uuid, date, text, text, bigint, uuid, integer, boolean) from public, anon;
revoke execute on function public.v2_edit_sale(uuid, date, text, text, bigint, uuid, integer, date, text, text, bigint, uuid, integer, boolean) from public, anon;
revoke execute on function public.v2_delete_sale(uuid, date, text, text, bigint, uuid, integer) from public, anon;
revoke execute on function public.v2_create_product(text, bigint, integer) from public, anon;
revoke execute on function public.v2_edit_product(uuid, text, bigint, integer, text, bigint, integer, boolean) from public, anon;
revoke execute on function public.v2_archive_product(uuid, integer, boolean) from public, anon;

-- v2_identity_ok must stay executable by authenticated because RLS policies
-- evaluate it as the invoking user; it only returns a boolean and stores nothing.
grant execute on function public.v2_identity_ok() to authenticated;
grant execute on function public.v2_create_sale(uuid, date, text, text, bigint, uuid, integer, boolean) to authenticated;
grant execute on function public.v2_edit_sale(uuid, date, text, text, bigint, uuid, integer, date, text, text, bigint, uuid, integer, boolean) to authenticated;
grant execute on function public.v2_delete_sale(uuid, date, text, text, bigint, uuid, integer) to authenticated;
grant execute on function public.v2_create_product(text, bigint, integer) to authenticated;
grant execute on function public.v2_edit_product(uuid, text, bigint, integer, text, bigint, integer, boolean) to authenticated;
grant execute on function public.v2_archive_product(uuid, integer, boolean) to authenticated;

-- ---------------------------------------------------------------------------
-- Row level security
-- ---------------------------------------------------------------------------

alter table public.v2_products enable row level security;
alter table public.v2_sales enable row level security;
alter table public.v2_stock_movements enable row level security;
alter table public.v2_business_account enable row level security;

drop policy if exists v2_products_select on public.v2_products;
create policy v2_products_select on public.v2_products for select to authenticated using (public.v2_identity_ok());
drop policy if exists v2_sales_select on public.v2_sales;
create policy v2_sales_select on public.v2_sales for select to authenticated using (public.v2_identity_ok());
drop policy if exists v2_stock_movements_select on public.v2_stock_movements;
create policy v2_stock_movements_select on public.v2_stock_movements for select to authenticated using (public.v2_identity_ok());
-- The registry itself has no client policy at all: invisible and untouchable
-- except by the migration seed and the documented owner-binding SQL.

-- ---------------------------------------------------------------------------
-- Business account registry seed
-- ---------------------------------------------------------------------------

-- Fail closed: when no confirmed auth identity matches the approved email,
-- zero rows are inserted and every RPC and SELECT stays denied until the
-- owner binds a real account with the documented SQL in supabase/README.md.
insert into public.v2_business_account (owner, email)
select u.id, lower(u.email)
from auth.users u
where lower(u.email) = 'pochoclos@negocio.com'
  and u.email_confirmed_at is not null
  and not exists (select 1 from public.v2_business_account);
