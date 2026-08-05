-- =============================================================================
-- Roost — 012 sales: customers, invoices, payments
--
-- Phase 2. Until now the app has tracked what the farm produced; this is what
-- it sold and what it has been paid for.
--
-- Two things are deliberately NOT stored as columns:
--   * how much an invoice is worth  — summed from its lines
--   * whether it has been paid      — derived from its payments
-- A stored total that disagrees with its lines is the classic way an invoicing
-- system starts lying, and it is very hard to notice.
-- =============================================================================


-- ---------- Dependencies ------------------------------------------------------
-- This migration builds on the viewer role from 009. Without is_farm_editor the
-- policy block below fails with a confusing "function does not exist", so the
-- problem is named here instead.
do $$
begin
  if to_regprocedure('public.is_farm_editor(bigint)') is null then
    raise exception
      'Migration 009 has not been applied. Run 008_viewer_role.sql (on its own), then 009_viewer_policies.sql, then this file.';
  end if;
end $$;


-- ---------- Customers ---------------------------------------------------------
create table if not exists customers (
  id                 bigint generated always as identity primary key,
  farm_id            bigint not null references farms(id) on delete cascade,
  name               text not null,
  email              text,
  phone              text,
  address            text,
  payment_terms_days smallint not null default 30 check (payment_terms_days >= 0),
  notes              text,
  active             boolean not null default true,
  created_at         timestamptz not null default now(),
  unique (farm_id, name)
);

create index if not exists customers_farm_active_idx on customers (farm_id) where active;


-- ---------- Invoices ----------------------------------------------------------
-- status covers only what cannot be derived. Whether it is paid comes from the
-- payments table; this records intent — is it still a draft, has it gone out,
-- has it been cancelled.
do $$
begin
  if not exists (select 1 from pg_type where typname = 'invoice_status') then
    create type invoice_status as enum ('draft', 'sent', 'void');
  end if;
end $$;

create table if not exists invoices (
  id          bigint generated always as identity primary key,
  farm_id     bigint not null references farms(id) on delete cascade,
  customer_id bigint not null references customers(id) on delete restrict,
  cycle_id    bigint references cycles(id) on delete set null,
  run_id      bigint references processing_runs(id) on delete set null,
  number      text not null,
  issued_on   date not null default current_date,
  due_on      date not null,
  status      invoice_status not null default 'draft',
  notes       text,
  created_at  timestamptz not null default now(),
  unique (farm_id, number)
);

create index if not exists invoices_farm_issued_idx on invoices (farm_id, issued_on desc);
create index if not exists invoices_customer_idx on invoices (customer_id);

create table if not exists invoice_lines (
  id              bigint generated always as identity primary key,
  invoice_id      bigint not null references invoices(id) on delete cascade,
  product_line_id bigint references product_lines(id) on delete set null,
  description     text not null,
  quantity_lb     numeric(10,2) check (quantity_lb >= 0),
  units           integer check (units >= 0),
  unit_price      numeric(10,2) not null check (unit_price >= 0),
  sort_order      smallint not null default 0
);

create index if not exists invoice_lines_invoice_idx on invoice_lines (invoice_id);

create table if not exists payments (
  id         bigint generated always as identity primary key,
  invoice_id bigint not null references invoices(id) on delete cascade,
  paid_on    date not null default current_date,
  amount     numeric(12,2) not null check (amount > 0),
  method     text,
  reference  text,
  created_at timestamptz not null default now()
);

create index if not exists payments_invoice_idx on payments (invoice_id);


-- ---------- Access helpers ----------------------------------------------------
create or replace function public.can_access_invoice(p_invoice_id bigint)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from invoices i join farm_members m on m.farm_id = i.farm_id
    where i.id = p_invoice_id and m.user_id = auth.uid()
  );
$$;

create or replace function public.can_edit_invoice(p_invoice_id bigint)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from invoices i join farm_members m on m.farm_id = i.farm_id
    where i.id = p_invoice_id and m.user_id = auth.uid()
      and m.role in ('owner', 'member')
  );
$$;


-- ---------- Security ----------------------------------------------------------
alter table customers     enable row level security;
alter table invoices      enable row level security;
alter table invoice_lines enable row level security;
alter table payments      enable row level security;

do $$
declare t text;
begin
  foreach t in array array['customers', 'invoices'] loop
    execute format('drop policy if exists %I on %I', t||'_read', t);
    execute format('drop policy if exists %I on %I', t||'_insert', t);
    execute format('drop policy if exists %I on %I', t||'_update', t);
    execute format('drop policy if exists %I on %I', t||'_delete', t);
    execute format('create policy %I on %I for select using (is_farm_member(farm_id))', t||'_read', t);
    execute format('create policy %I on %I for insert with check (is_farm_editor(farm_id))', t||'_insert', t);
    execute format('create policy %I on %I for update using (is_farm_editor(farm_id)) with check (is_farm_editor(farm_id))', t||'_update', t);
    execute format('create policy %I on %I for delete using (is_farm_editor(farm_id))', t||'_delete', t);
  end loop;

  foreach t in array array['invoice_lines', 'payments'] loop
    execute format('drop policy if exists %I on %I', t||'_read', t);
    execute format('drop policy if exists %I on %I', t||'_insert', t);
    execute format('drop policy if exists %I on %I', t||'_update', t);
    execute format('drop policy if exists %I on %I', t||'_delete', t);
    execute format('create policy %I on %I for select using (can_access_invoice(invoice_id))', t||'_read', t);
    execute format('create policy %I on %I for insert with check (can_edit_invoice(invoice_id))', t||'_insert', t);
    execute format('create policy %I on %I for update using (can_edit_invoice(invoice_id)) with check (can_edit_invoice(invoice_id))', t||'_update', t);
    execute format('create policy %I on %I for delete using (can_edit_invoice(invoice_id))', t||'_delete', t);
  end loop;
end $$;


-- ---------- What an invoice is worth, and what is left ------------------------
create or replace view v_invoices with (security_invoker = true) as
select
  i.id,
  i.farm_id,
  i.customer_id,
  c.name                              as customer,
  c.email                            as customer_email,
  i.cycle_id,
  i.run_id,
  i.number,
  i.issued_on,
  i.due_on,
  i.status,
  i.notes,
  coalesce(l.total, 0)                as total,
  coalesce(p.paid, 0)                 as paid,
  coalesce(l.total, 0) - coalesce(p.paid, 0) as outstanding,
  p.last_paid_on,

  -- Settled means the money arrived, not that someone ticked a box.
  case
    when i.status = 'void'                            then 'void'
    when i.status = 'draft'                           then 'draft'
    when coalesce(p.paid, 0) <= 0                     then 'unpaid'
    when coalesce(p.paid, 0) < coalesce(l.total, 0)   then 'part paid'
    else 'paid'
  end                                 as state,

  case
    when i.status in ('void', 'draft')                              then null
    when coalesce(p.paid, 0) >= coalesce(l.total, 0)                then 0
    else greatest(current_date - i.due_on, 0)
  end                                 as days_overdue
from invoices i
join customers c on c.id = i.customer_id
left join lateral (
  select sum(coalesce(quantity_lb, units, 0) * unit_price) as total
  from invoice_lines il where il.invoice_id = i.id
) l on true
left join lateral (
  select sum(amount) as paid, max(paid_on) as last_paid_on
  from payments pm where pm.invoice_id = i.id
) p on true;


-- ---------- Ageing ------------------------------------------------------------
-- Standard 30/60/90 buckets over what is genuinely outstanding: drafts and
-- voids are excluded, because neither is money anyone owes yet.
create or replace view v_invoice_ageing with (security_invoker = true) as
select
  farm_id,
  sum(outstanding)                                                     as outstanding,
  sum(outstanding) filter (where days_overdue = 0)                     as current,
  sum(outstanding) filter (where days_overdue between 1 and 30)        as d1_30,
  sum(outstanding) filter (where days_overdue between 31 and 60)       as d31_60,
  sum(outstanding) filter (where days_overdue between 61 and 90)       as d61_90,
  sum(outstanding) filter (where days_overdue > 90)                    as d90_plus,
  count(*) filter (where outstanding > 0.005)                          as open_invoices
from v_invoices
where status = 'sent' and outstanding > 0.005
group by farm_id;


create or replace view v_customer_balances with (security_invoker = true) as
select
  c.id            as customer_id,
  c.farm_id,
  c.name,
  c.email,
  c.phone,
  c.payment_terms_days,
  c.active,
  count(i.id) filter (where i.status = 'sent')                  as invoices,
  coalesce(sum(i.total) filter (where i.status = 'sent'), 0)    as invoiced,
  coalesce(sum(i.paid) filter (where i.status = 'sent'), 0)     as paid,
  coalesce(sum(i.outstanding) filter (where i.status = 'sent'), 0) as outstanding,
  max(i.days_overdue) filter (where i.status = 'sent' and i.outstanding > 0.005) as worst_overdue
from customers c
left join v_invoices i on i.customer_id = c.id
group by c.id, c.farm_id, c.name, c.email, c.phone, c.payment_terms_days, c.active;


-- ---------- Numbering ---------------------------------------------------------
-- Sequential per farm. Reads the highest existing number rather than using a
-- sequence, so a deleted draft does not leave a permanent gap.
create or replace function public.next_invoice_number(p_farm_id bigint)
returns text language plpgsql stable as $$
declare
  v_max integer;
begin
  select max((regexp_replace(number, '\D', '', 'g'))::integer)
  into v_max
  from invoices
  where farm_id = p_farm_id and number ~ '\d';

  return 'INV-' || lpad((coalesce(v_max, 0) + 1)::text, 4, '0');
end $$;


-- ---------- Saving an invoice atomically --------------------------------------
create or replace function public.save_invoice(
  p_farm_id     bigint,
  p_customer_id bigint,
  p_issued_on   date,
  p_due_on      date,
  p_lines       jsonb,     -- [{product_line_id, description, quantity_lb, units, unit_price}]
  p_cycle_id    bigint default null,
  p_run_id      bigint default null,
  p_notes       text default null,
  p_invoice_id  bigint default null,
  p_number      text default null
)
returns bigint
language plpgsql
as $$
declare
  v_id bigint;
begin
  if p_lines is null or jsonb_array_length(p_lines) = 0 then
    raise exception 'An invoice needs at least one line';
  end if;

  if p_invoice_id is null then
    insert into invoices (farm_id, customer_id, cycle_id, run_id, number, issued_on, due_on, notes)
    values (p_farm_id, p_customer_id, p_cycle_id, p_run_id,
            coalesce(p_number, next_invoice_number(p_farm_id)),
            p_issued_on, p_due_on, p_notes)
    returning id into v_id;
  else
    update invoices set
      customer_id = p_customer_id,
      cycle_id    = p_cycle_id,
      run_id      = p_run_id,
      issued_on   = p_issued_on,
      due_on      = p_due_on,
      notes       = p_notes
    where id = p_invoice_id
    returning id into v_id;

    if v_id is null then
      raise exception 'That invoice does not exist, or you do not have access to it';
    end if;

    delete from invoice_lines where invoice_id = v_id;
  end if;

  insert into invoice_lines (invoice_id, product_line_id, description, quantity_lb, units, unit_price, sort_order)
  select
    v_id,
    nullif(l->>'product_line_id', '')::bigint,
    coalesce(nullif(l->>'description', ''), 'Item'),
    nullif(l->>'quantity_lb', '')::numeric,
    nullif(l->>'units', '')::integer,
    coalesce((l->>'unit_price')::numeric, 0),
    (row_number() over ())::smallint
  from jsonb_array_elements(p_lines) l;

  return v_id;
end $$;


-- ---------- Overpayment guard -------------------------------------------------
-- Recording more than is owed is nearly always a typo or a duplicate entry.
create or replace function assert_payment_within_total() returns trigger
language plpgsql as $$
declare
  v_total numeric;
  v_paid  numeric;
begin
  select coalesce(sum(coalesce(quantity_lb, units, 0) * unit_price), 0)
  into v_total from invoice_lines where invoice_id = new.invoice_id;

  select coalesce(sum(amount), 0) into v_paid
  from payments where invoice_id = new.invoice_id and id is distinct from new.id;

  if v_paid + new.amount > v_total + 0.005 then
    raise exception 'That would take payments to % on an invoice of %',
      to_char(v_paid + new.amount, 'FM999999990.00'), to_char(v_total, 'FM999999990.00');
  end if;

  return new;
end $$;

drop trigger if exists trg_payment_within_total on payments;
create trigger trg_payment_within_total
  before insert or update on payments
  for each row execute function assert_payment_within_total();


-- =============================================================================
-- CHECK IT WORKED
--   select * from v_invoice_ageing;      -- no rows until an invoice is sent
--   select next_invoice_number(id) from farms;   -- INV-0001
-- =============================================================================
