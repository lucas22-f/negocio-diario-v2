-- Additive sale attribution. Legacy RPC signatures and historical rows stay unchanged.
alter table public.v2_sales add column if not exists stand text
  check (stand is null or stand in ('fixed', 'mobile'));

-- Separate names avoid PostgREST overload ambiguity during rolling deployment.
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


create or replace function public.v2_edit_sale_at_stand(p_sale jsonb, p_previous jsonb)
returns public.v2_sales security definer set search_path = '' language plpgsql as $$
declare
  cur public.v2_sales;
  next_stand text := p_sale ->> 'stand';
begin
  perform public.v2_assert_identity();
  if next_stand is not null and next_stand not in ('fixed', 'mobile') then
    raise exception 'Elegí Puesto fijo o Móvil.' using errcode = '22023';
  end if;
  select * into cur from public.v2_sales where id = (p_sale ->> 'id')::uuid for update;
  if not found then
    raise exception 'La venta ya no existe.' using errcode = 'P0002';
  end if;
  if cur.stand is distinct from (p_previous ->> 'stand') then
    raise exception 'La venta cambió desde otro dispositivo.' using errcode = '40001';
  end if;
  perform public.v2_edit_sale(
    cur.id, (p_previous ->> 'date')::date, p_previous ->> 'product',
    p_previous ->> 'payment', (p_previous ->> 'amountCents')::bigint,
    (p_previous ->> 'productId')::uuid, (p_previous ->> 'quantity')::integer,
    (p_sale ->> 'date')::date, p_sale ->> 'product', p_sale ->> 'payment',
    (p_sale ->> 'amountCents')::bigint, (p_sale ->> 'productId')::uuid,
    (p_sale ->> 'quantity')::integer, coalesce((p_sale ->> 'allowNegative')::boolean, false));
  update public.v2_sales set stand = next_stand where id = cur.id returning * into cur;
  return cur;
end $$;

create or replace function public.v2_delete_sale_at_stand(p_previous jsonb)
returns public.v2_sales security definer set search_path = '' language plpgsql as $$
declare cur public.v2_sales;
begin
  perform public.v2_assert_identity();
  select * into cur from public.v2_sales where id = (p_previous ->> 'id')::uuid for update;
  if not found then
    raise exception 'La venta ya no existe.' using errcode = 'P0002';
  end if;
  if cur.stand is distinct from (p_previous ->> 'stand') then
    raise exception 'La venta cambió desde otro dispositivo.' using errcode = '40001';
  end if;
  return public.v2_delete_sale(
    cur.id, (p_previous ->> 'date')::date, p_previous ->> 'product',
    p_previous ->> 'payment', (p_previous ->> 'amountCents')::bigint,
    (p_previous ->> 'productId')::uuid, (p_previous ->> 'quantity')::integer);
end $$;

revoke execute on function public.v2_create_sale_at_stand(uuid,date,text,text,bigint,uuid,integer,boolean,text) from public, anon;
revoke execute on function public.v2_edit_sale_at_stand(jsonb,jsonb) from public, anon;
revoke execute on function public.v2_delete_sale_at_stand(jsonb) from public, anon;
grant execute on function public.v2_create_sale_at_stand(uuid,date,text,text,bigint,uuid,integer,boolean,text) to authenticated;
grant execute on function public.v2_edit_sale_at_stand(jsonb,jsonb) to authenticated;
grant execute on function public.v2_delete_sale_at_stand(jsonb) to authenticated;
