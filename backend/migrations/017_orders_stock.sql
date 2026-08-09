-- =============================================================================
-- Roost — 017 orders and stock
--
-- The gap this closes: Roost knew what it produced and what it billed, but
-- nothing in between. No record that a wholesaler wants 60 birds next month,
-- and no idea what is actually sitting in the cold room.
--
-- STOCK IS NOT STORED. It is produced by processing, consumed by fulfilled
-- orders, and corrected by adjustments — so it is a view over those three,
-- exactly like every other derived figure here. A stored stock level is the
-- classic number that drifts from reality and is very hard to notice.
--
-- Taking an order is the day's work, so members can do it. Billing for one
-- stays owner-only, as 016 set out — fulfilling an order offers an invoice,
-- it does not create one behind anybody's back.
-- =============================================================================


-- ---------- Dependencies ------------------------------------------------------
do $$
begin
  if to_regprocedure('public.can_own_invoice(bigint)') is null then
    raise exception
      'Migration 016 has not been applied. Run 016_owner_only.sql before this file.';
  end if;
end $$;


-- ---------- Orders ------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_type where typname = 'order_status') then
    create type order_status as enum ('draft', 'confirmed', 'fulfilled', 'cancelled');
  end if;
end $$;

create table if not exists orders (
  id           bigint generated always as identity primary key,
  farm_id      bigint not null references farms(id) on delete cascade,
  customer_id  bigint not null references customers(id) on delete restrict,
  number       text not null,
  placed_on    date not null default current_date,
  needed_by    date,
  status       order_status not null default 'draft',
  notes        text,
  taken_by     uuid references auth.users(id) on delete set null,
  fulfilled_on date,
  created_at   timestamptz not null default now(),
  unique (farm_id, number)
);

create index if not exists orders_farm_needed_idx on orders (farm_id, needed_by);
create index if not exists orders_customer_idx on orders (customer_id);

create table if not exists order_lines (
  id              bigint generated always as identity primary key,
  order_id        bigint not null references orders(id) on delete cascade,
  product_line_id bigint not null references product_lines(id) on delete restrict,
  quantity_lb     numeric(10,2) check (quantity_lb >= 0),
  units           integer check (units >= 0),
  unit_price      numeric(10,2) not null default 0 check (unit_price >= 0),
  sort_order      smallint not null default 0
);

create index if not exists order_lines_order_idx on order_lines (order_id);


-- ---------- Stock corrections --------------------------------------------------
-- Signed: negative takes stock away. Everything that is neither production nor
-- a sale — a dropped crate, birds kept for the family, a miscount found at a
-- stock take. Without this, stock can only ever be right by luck.
create table if not exists stock_adjustments (
  id              bigint generated always as identity primary key,
  farm_id         bigint not null references farms(id) on delete cascade,
  product_line_id bigint not null references product_lines(id) on delete cascade,
  adjusted_on     date not null default current_date,
  quantity_lb     numeric(10,2) not null default 0,
  units           integer not null default 0,
  reason          text not null,
  adjusted_by     uuid references auth.users(id) on delete set null,
  created_at      timestamptz not null default now()
);

create index if not exists stock_adjustments_farm_idx on stock_adjustments (farm_id, adjusted_on desc);


-- ---------- An invoice can come from an order ---------------------------------
alter table invoices add column if not exists order_id bigint references orders(id) on delete set null;
create index if not exists invoices_order_idx on invoices (order_id);


-- ---------- Access helpers -----------------------------------------------------
create or replace function public.can_access_order(p_order_id bigint)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from orders o join farm_members m on m.farm_id = o.farm_id
    where o.id = p_order_id and m.user_id = auth.uid()
  );
$$;

-- Editor, not owner: taking an order is the day's work.
create or replace function public.can_edit_order(p_order_id bigint)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from orders o join farm_members m on m.farm_id = o.farm_id
    where o.id = p_order_id and m.user_id = auth.uid()
      and m.role in ('owner', 'member')
  );
$$;


-- ---------- Security -----------------------------------------------------------
alter table orders            enable row level security;
alter table order_lines       enable row level security;
alter table stock_adjustments enable row level security;

do $$
declare t text;
begin
  foreach t in array array['orders', 'stock_adjustments'] loop
    execute format('drop policy if exists %I on %I', t||'_read', t);
    execute format('drop policy if exists %I on %I', t||'_insert', t);
    execute format('drop policy if exists %I on %I', t||'_update', t);
    execute format('drop policy if exists %I on %I', t||'_delete', t);
    execute format('create policy %I on %I for select using (is_farm_member(farm_id))', t||'_read', t);
    execute format('create policy %I on %I for insert with check (is_farm_editor(farm_id))', t||'_insert', t);
    execute format('create policy %I on %I for update using (is_farm_editor(farm_id)) with check (is_farm_editor(farm_id))', t||'_update', t);
    execute format('create policy %I on %I for delete using (is_farm_editor(farm_id))', t||'_delete', t);
  end loop;
end $$;

drop policy if exists order_lines_read on order_lines;
drop policy if exists order_lines_insert on order_lines;
drop policy if exists order_lines_update on order_lines;
drop policy if exists order_lines_delete on order_lines;

create policy order_lines_read on order_lines
  for select using (can_access_order(order_id));
create policy order_lines_insert on order_lines
  for insert with check (can_edit_order(order_id));
create policy order_lines_update on order_lines
  for update using (can_edit_order(order_id)) with check (can_edit_order(order_id));
create policy order_lines_delete on order_lines
  for delete using (can_edit_order(order_id));


-- ---------- What an order is worth --------------------------------------------
create or replace view v_orders with (security_invoker = true) as
select
  o.id,
  o.farm_id,
  o.customer_id,
  c.name                                as customer,
  c.email                               as customer_email,
  o.number,
  o.placed_on,
  o.needed_by,
  o.status,
  o.notes,
  o.taken_by,
  o.fulfilled_on,
  o.created_at,
  coalesce(l.lines, 0)                  as line_count,
  coalesce(l.total, 0)                  as total,
  coalesce(l.total_lb, 0)               as total_lb,
  coalesce(l.total_units, 0)            as total_units,
  i.id                                  as invoice_id,
  i.number                              as invoice_number,

  -- Days until it is needed. Negative means it is already late.
  case when o.needed_by is null then null
       else (o.needed_by - current_date) end as days_until_needed,
  (o.needed_by is not null
     and o.needed_by < current_date
     and o.status in ('draft', 'confirmed'))  as overdue
from orders o
join customers c on c.id = o.customer_id
left join lateral (
  select
    count(*)                                        as lines,
    sum(coalesce(ol.quantity_lb, ol.units, 0) * ol.unit_price) as total,
    sum(coalesce(ol.quantity_lb, 0))                as total_lb,
    sum(coalesce(ol.units, 0))                      as total_units
  from order_lines ol where ol.order_id = o.id
) l on true
left join invoices i on i.order_id = o.id;


-- ---------- Stock --------------------------------------------------------------
-- One row per product line the farm sells.
--
--   produced   what processing weighed out            (processing_outputs)
--   fulfilled  what has gone out against orders       (fulfilled order_lines)
--   adjusted   waste, own use, corrections            (stock_adjustments)
--   committed  promised to confirmed, unfulfilled orders
--
--   on_hand    produced - fulfilled + adjusted        — physically here
--   available  on_hand - committed                    — free to sell
--
-- available goes negative when orders are taken ahead of processing, which is
-- the point: it says what the open cycle still has to deliver.
create or replace view v_stock with (security_invoker = true) as
select
  pl.id                          as product_line_id,
  pl.farm_id,
  pl.name,
  pl.is_whole_bird,
  pl.sort_order,

  coalesce(p.weight_lb, 0)       as produced_lb,
  coalesce(p.units, 0)           as produced_units,
  coalesce(f.weight_lb, 0)       as fulfilled_lb,
  coalesce(f.units, 0)           as fulfilled_units,
  coalesce(a.weight_lb, 0)       as adjusted_lb,
  coalesce(a.units, 0)           as adjusted_units,
  coalesce(cm.weight_lb, 0)      as committed_lb,
  coalesce(cm.units, 0)          as committed_units,

  coalesce(p.weight_lb, 0) - coalesce(f.weight_lb, 0) + coalesce(a.weight_lb, 0)
                                 as on_hand_lb,
  coalesce(p.units, 0) - coalesce(f.units, 0) + coalesce(a.units, 0)
                                 as on_hand_units,

  coalesce(p.weight_lb, 0) - coalesce(f.weight_lb, 0) + coalesce(a.weight_lb, 0)
    - coalesce(cm.weight_lb, 0)  as available_lb,
  coalesce(p.units, 0) - coalesce(f.units, 0) + coalesce(a.units, 0)
    - coalesce(cm.units, 0)      as available_units,

  p.last_produced_on
from product_lines pl
left join lateral (
  select
    sum(po.weight_lb)      as weight_lb,
    sum(po.units)          as units,
    max(r.processed_on)    as last_produced_on
  from processing_outputs po
  join processing_runs r on r.id = po.run_id
  join cycles cy on cy.id = r.cycle_id
  where po.product_line_id = pl.id and cy.farm_id = pl.farm_id
) p on true
left join lateral (
  select sum(coalesce(ol.quantity_lb, 0)) as weight_lb, sum(coalesce(ol.units, 0)) as units
  from order_lines ol join orders o on o.id = ol.order_id
  where ol.product_line_id = pl.id and o.status = 'fulfilled'
) f on true
left join lateral (
  select sum(sa.quantity_lb) as weight_lb, sum(sa.units) as units
  from stock_adjustments sa
  where sa.product_line_id = pl.id
) a on true
left join lateral (
  select sum(coalesce(ol.quantity_lb, 0)) as weight_lb, sum(coalesce(ol.units, 0)) as units
  from order_lines ol join orders o on o.id = ol.order_id
  where ol.product_line_id = pl.id and o.status = 'confirmed'
) cm on true;


-- ---------- The order book ------------------------------------------------------
-- What is promised and not yet delivered, which is the number a wholesaler
-- conversation actually turns on.
create or replace view v_order_book with (security_invoker = true) as
select
  farm_id,
  count(*) filter (where status = 'draft')                       as drafts,
  count(*) filter (where status = 'confirmed')                   as confirmed,
  count(*) filter (where overdue)                                as overdue,
  coalesce(sum(total) filter (where status = 'confirmed'), 0)    as confirmed_value,
  coalesce(sum(total) filter (where status = 'draft'), 0)        as draft_value,
  coalesce(sum(total_lb) filter (where status = 'confirmed'), 0) as confirmed_lb,
  min(needed_by) filter (where status = 'confirmed')             as next_needed_by
from v_orders
where status in ('draft', 'confirmed')
group by farm_id;


-- ---------- Numbering ----------------------------------------------------------
create or replace function public.next_order_number(p_farm_id bigint)
returns text language plpgsql stable as $$
declare v_max integer;
begin
  select max((regexp_replace(number, '\D', '', 'g'))::integer)
  into v_max from orders
  where farm_id = p_farm_id and number ~ '\d';
  return 'ORD-' || lpad((coalesce(v_max, 0) + 1)::text, 4, '0');
end $$;


-- ---------- Saving an order atomically ------------------------------------------
create or replace function public.save_order(
  p_farm_id     bigint,
  p_customer_id bigint,
  p_lines       jsonb,     -- [{product_line_id, quantity_lb, units, unit_price}]
  p_needed_by   date default null,
  p_placed_on   date default current_date,
  p_notes       text default null,
  p_order_id    bigint default null,
  p_status      order_status default 'draft'
)
returns bigint language plpgsql as $$
declare v_id bigint;
begin
  if p_lines is null or jsonb_array_length(p_lines) = 0 then
    raise exception 'An order needs at least one line';
  end if;

  if p_order_id is null then
    insert into orders (farm_id, customer_id, number, placed_on, needed_by, notes, status, taken_by)
    values (p_farm_id, p_customer_id, next_order_number(p_farm_id),
            coalesce(p_placed_on, current_date), p_needed_by, p_notes,
            coalesce(p_status, 'draft'), auth.uid())
    returning id into v_id;
  else
    update orders set
      customer_id = p_customer_id,
      placed_on   = coalesce(p_placed_on, placed_on),
      needed_by   = p_needed_by,
      notes       = p_notes,
      status      = coalesce(p_status, status)
    where id = p_order_id
    returning id into v_id;

    if v_id is null then
      raise exception 'That order does not exist, or you do not have access to it';
    end if;

    delete from order_lines where order_id = v_id;
  end if;

  insert into order_lines (order_id, product_line_id, quantity_lb, units, unit_price, sort_order)
  select
    v_id,
    (l->>'product_line_id')::bigint,
    nullif(l->>'quantity_lb', '')::numeric,
    nullif(l->>'units', '')::integer,
    coalesce((l->>'unit_price')::numeric, 0),
    (row_number() over ())::smallint
  from jsonb_array_elements(p_lines) l;

  return v_id;
end $$;


-- ---------- Fulfilling ----------------------------------------------------------
-- Marks the goods as gone. Stock follows automatically, because stock is a view
-- over exactly this. No invoice is created here — that is the owner's decision
-- and their own click.
create or replace function public.fulfil_order(p_order_id bigint, p_on date default current_date)
returns void language plpgsql as $$
begin
  update orders
  set status = 'fulfilled', fulfilled_on = coalesce(p_on, current_date)
  where id = p_order_id;

  if not found then
    raise exception 'That order does not exist, or you do not have access to it';
  end if;
end $$;


-- ---------- Turning an order into an invoice ------------------------------------
-- Owner-only in effect: it writes to invoices, and 016 lets only an owner do
-- that. The failure is a policy refusal rather than a special case here.
create or replace function public.invoice_from_order(p_order_id bigint)
returns bigint language plpgsql as $$
declare
  v_order   record;
  v_terms   integer;
  v_lines   jsonb;
  v_invoice bigint;
begin
  select o.*, c.payment_terms_days
  into v_order
  from orders o join customers c on c.id = o.customer_id
  where o.id = p_order_id;

  if v_order.id is null then
    raise exception 'That order does not exist, or you do not have access to it';
  end if;

  if exists (select 1 from invoices where order_id = p_order_id) then
    raise exception 'Order % has already been invoiced', v_order.number;
  end if;

  v_terms := coalesce(v_order.payment_terms_days, 30);

  select jsonb_agg(jsonb_build_object(
           'product_line_id', ol.product_line_id,
           'description',     pl.name,
           'quantity_lb',     ol.quantity_lb,
           'units',           ol.units,
           'unit_price',      ol.unit_price
         ) order by ol.sort_order)
  into v_lines
  from order_lines ol
  join product_lines pl on pl.id = ol.product_line_id
  where ol.order_id = p_order_id;

  if v_lines is null then
    raise exception 'Order % has no lines to invoice', v_order.number;
  end if;

  v_invoice := save_invoice(
    p_farm_id     => v_order.farm_id,
    p_customer_id => v_order.customer_id,
    p_issued_on   => current_date,
    p_due_on      => current_date + v_terms,
    p_lines       => v_lines,
    p_notes       => 'From order ' || v_order.number
  );

  update invoices set order_id = p_order_id where id = v_invoice;

  return v_invoice;
end $$;


-- =============================================================================
-- CHECK IT WORKED
--   select * from v_stock;        -- one row per product line, zeros to start
--   select * from v_order_book;   -- no rows until an order exists
--   select next_order_number(id) from farms;    -- ORD-0001
-- =============================================================================
