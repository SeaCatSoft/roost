-- =============================================================================
-- Roost — 030 pens and contracts
--
-- Run 029_expenses_weekly_report.sql first.
--
-- Until now a farm ran one flock at a time: every screen loaded "the open
-- cycle", and starting a new one closed the last. The houses table has been
-- there since 001 — every cycle already points at one — but nothing let a
-- farm have two, or run them side by side.
--
-- A PEN is a house. Each pen holds at most one open cycle; different pens run
-- their own cycles at the same time. The app calls them pens throughout; the
-- table keeps its name, because renaming it would touch every migration
-- since 001 for no gain.
--
-- A pen is either the farm's own (the farm pays for everything, processes the
-- birds and sells the meat — how Roost has always worked) or UNDER CONTRACT:
-- a buyer takes the birds live, at a price per lb, per kg or per bird, and
-- may supply the chicks and/or the feed. What the buyer supplies is either
-- deducted from the payout at the end or simply covered by them; each
-- contract says which.
--
-- This migration records the pens and the terms. Settling a contract flock
-- (the pickup, the deductions, the payout) and keeping a buyer's feed apart
-- from the farm's own store build on it in 031.
-- =============================================================================


-- ---------- Dependencies ------------------------------------------------------
do $$
begin
  if to_regclass('public.v_cycle_cost_compare') is null then
    raise exception
      'Migration 029 has not been applied. Run 029_expenses_weekly_report.sql before this file.';
  end if;
end $$;


-- ---------- Pens ---------------------------------------------------------------
-- active = false retires a pen without deleting it: its past cycles still
-- need somewhere to point.
alter table houses
  add column if not exists active     boolean not null default true,
  add column if not exists created_at timestamptz not null default now();

-- Every farm has at least one pen, and every cycle sits in one. Both were
-- already true for anything created through the app; this closes the gap for
-- anything that was not.
insert into houses (farm_id, name)
select f.id, 'Pen 1' from farms f
where not exists (select 1 from houses h where h.farm_id = f.id);

update cycles c
set house_id = (select h.id from houses h where h.farm_id = c.farm_id order by h.id limit 1)
where c.house_id is null;

-- Adding or retiring a pen is a business decision, like starting a cycle
-- (016): everyone on the farm reads, only an owner changes.
drop policy if exists houses_all    on houses;
drop policy if exists houses_read   on houses;
drop policy if exists houses_insert on houses;
drop policy if exists houses_update on houses;
drop policy if exists houses_delete on houses;

create policy houses_read   on houses for select using (is_farm_member(farm_id));
create policy houses_insert on houses for insert with check (is_farm_owner(farm_id));
create policy houses_update on houses for update
  using (is_farm_owner(farm_id)) with check (is_farm_owner(farm_id));
create policy houses_delete on houses for delete using (is_farm_owner(farm_id));


-- ---------- One open cycle per pen ----------------------------------------------
-- The rule every screen now leans on: "the flock in this pen" has to mean
-- exactly one cycle. Checked first, so a farm that somehow has two open in
-- one pen gets told which, instead of a bare unique-index failure.
do $$
declare v_bad text;
begin
  select string_agg(h.name, ', ') into v_bad
  from (select house_id from cycles where closed_at is null and house_id is not null
        group by house_id having count(*) > 1) d
  join houses h on h.id = d.house_id;

  if v_bad is not null then
    raise exception
      'These pens have more than one open cycle: %. Close the extra ones (Batches screen), then run this file again.', v_bad;
  end if;
end $$;

create unique index if not exists cycles_one_open_per_pen
  on cycles (house_id) where closed_at is null and house_id is not null;


-- ---------- Contracts ------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_type where typname = 'contract_price_basis') then
    create type contract_price_basis as enum ('per_lb', 'per_kg', 'per_bird');
  end if;
end $$;

create table if not exists pen_contracts (
  id                    bigint generated always as identity primary key,
  farm_id               bigint not null references farms(id) on delete cascade,
  house_id              bigint not null references houses(id) on delete cascade,
  -- The buyer, as a customer where one exists, so the payout can be invoiced
  -- like any other sale. The name is kept as typed either way.
  customer_id           bigint references customers(id) on delete set null,
  buyer_name            text not null,

  price_basis           contract_price_basis not null default 'per_lb',
  price                 numeric(10,4) not null check (price >= 0),

  buyer_supplies_chicks boolean not null default false,
  chick_charge          numeric(10,2) check (chick_charge >= 0),   -- per chick
  buyer_supplies_feed   boolean not null default false,
  -- Feed has no price here on purpose: bags arrive at whatever the buyer
  -- charges that month, so the charge is recorded delivery by delivery.

  -- true: what the buyer supplied comes off the payout at the end.
  -- false: the buyer simply covers it.
  inputs_deducted       boolean not null default true,

  notes                 text,
  starts_on             date not null default current_date,
  ended_on              date,
  created_at            timestamptz not null default now()
);

-- A pen has one contract in force at a time. Ended ones stay, because the
-- cycles raised under them still point here.
create unique index if not exists pen_contracts_one_active
  on pen_contracts (house_id) where ended_on is null;

alter table pen_contracts enable row level security;

drop policy if exists pen_contracts_read   on pen_contracts;
drop policy if exists pen_contracts_insert on pen_contracts;
drop policy if exists pen_contracts_update on pen_contracts;
drop policy if exists pen_contracts_delete on pen_contracts;

-- Contract terms are billing: owner-only to change, like invoices (016).
create policy pen_contracts_read   on pen_contracts for select using (is_farm_member(farm_id));
create policy pen_contracts_insert on pen_contracts for insert with check (is_farm_owner(farm_id));
create policy pen_contracts_update on pen_contracts for update
  using (is_farm_owner(farm_id)) with check (is_farm_owner(farm_id));
create policy pen_contracts_delete on pen_contracts for delete using (is_farm_owner(farm_id));


-- ---------- Which contract a cycle was raised under -------------------------------
-- Null means the farm's own flock. Set when the cycle starts and never
-- changed by a later contract, so a closed cycle always settles on the terms
-- it was actually raised under.
alter table cycles
  add column if not exists contract_id bigint references pen_contracts(id) on delete set null;

-- A trigger rather than a change to start_new_cycle: any way a cycle comes to
-- exist in a contract pen picks up the contract, not just the one function.
create or replace function public.cycles_attach_contract() returns trigger
language plpgsql as $$
begin
  if new.contract_id is null and new.house_id is not null then
    select k.id into new.contract_id
    from pen_contracts k
    where k.house_id = new.house_id and k.ended_on is null;
  end if;
  return new;
end $$;

drop trigger if exists trg_cycles_attach_contract on cycles;
create trigger trg_cycles_attach_contract
  before insert on cycles
  for each row execute function cycles_attach_contract();


-- ---------- Saving the terms -------------------------------------------------------
-- One call, because "change the terms" has a rule in it: terms a finished
-- flock was raised under must not be rewritten after the fact. If the current
-- contract has a closed cycle behind it, it is ended and a new one started;
-- otherwise it is simply corrected in place. Either way the flock in the pen
-- right now follows the new terms — that is what renegotiating means.
-- SECURITY INVOKER: the owner-only policies above still decide who may.
create or replace function public.save_pen_contract(
  p_house_id              bigint,
  p_buyer_name            text,
  p_price_basis           contract_price_basis,
  p_price                 numeric,
  p_buyer_supplies_chicks boolean default false,
  p_chick_charge          numeric default null,
  p_buyer_supplies_feed   boolean default false,
  p_inputs_deducted       boolean default true,
  p_customer_id           bigint default null,
  p_notes                 text default null
)
returns bigint
language plpgsql
as $$
declare
  v_farm   bigint;
  v_cur    bigint;
  v_id     bigint;
begin
  select farm_id into v_farm from houses where id = p_house_id;
  if v_farm is null then
    raise exception 'That pen does not exist, or you do not have access to it';
  end if;
  if coalesce(trim(p_buyer_name), '') = '' then
    raise exception 'A contract needs a buyer';
  end if;
  if p_price is null or p_price < 0 then
    raise exception 'A contract needs a price';
  end if;

  select id into v_cur from pen_contracts where house_id = p_house_id and ended_on is null;

  if v_cur is not null
     and not exists (select 1 from cycles where contract_id = v_cur and closed_at is not null) then
    update pen_contracts set
      buyer_name = trim(p_buyer_name), customer_id = p_customer_id,
      price_basis = p_price_basis, price = p_price,
      buyer_supplies_chicks = coalesce(p_buyer_supplies_chicks, false),
      chick_charge = case when coalesce(p_buyer_supplies_chicks, false) then p_chick_charge end,
      buyer_supplies_feed = coalesce(p_buyer_supplies_feed, false),
      inputs_deducted = coalesce(p_inputs_deducted, true),
      notes = nullif(trim(coalesce(p_notes, '')), '')
    where id = v_cur
    returning id into v_id;
  else
    if v_cur is not null then
      update pen_contracts set ended_on = current_date where id = v_cur;
    end if;

    insert into pen_contracts (
      farm_id, house_id, customer_id, buyer_name, price_basis, price,
      buyer_supplies_chicks, chick_charge, buyer_supplies_feed, inputs_deducted, notes)
    values (
      v_farm, p_house_id, p_customer_id, trim(p_buyer_name), p_price_basis, p_price,
      coalesce(p_buyer_supplies_chicks, false),
      case when coalesce(p_buyer_supplies_chicks, false) then p_chick_charge end,
      coalesce(p_buyer_supplies_feed, false), coalesce(p_inputs_deducted, true),
      nullif(trim(coalesce(p_notes, '')), ''))
    returning id into v_id;
  end if;

  if v_id is null then
    raise exception 'Only an owner can change a contract';
  end if;

  update cycles set contract_id = v_id
  where house_id = p_house_id and closed_at is null;

  return v_id;
end $$;

-- Ending a contract makes the pen the farm's own from the NEXT flock. The
-- flock in it now was raised under the contract and stays on it.
create or replace function public.end_pen_contract(p_house_id bigint)
returns void
language plpgsql
as $$
begin
  update pen_contracts set ended_on = current_date
  where house_id = p_house_id and ended_on is null;

  if not found then
    raise exception 'That pen has no contract in force, or you do not have access to it';
  end if;
end $$;


-- ---------- Each pen at a glance ---------------------------------------------------
-- One row per pen: what is in it now, and the contract in force. The pen
-- switcher on every screen and the Pens screen both read this.
create or replace view v_pens with (security_invoker = true) as
select
  h.id                 as house_id,
  h.farm_id,
  h.name,
  h.active,
  c.id                 as cycle_id,
  c.label              as cycle_label,
  c.placed_on,
  c.birds_placed,
  c.target_sale_age,
  p.birds_alive,
  k.id                 as contract_id,
  k.customer_id,
  k.buyer_name,
  k.price_basis,
  k.price,
  k.buyer_supplies_chicks,
  k.chick_charge,
  k.buyer_supplies_feed,
  k.inputs_deducted,
  k.notes              as contract_notes,
  k.starts_on          as contract_starts_on,
  (select count(*) from cycles x where x.house_id = h.id) as cycles_total
from houses h
left join cycles c           on c.house_id = h.id and c.closed_at is null
left join v_cycle_progress p on p.cycle_id = c.id
left join pen_contracts k    on k.house_id = h.id and k.ended_on is null;


-- =============================================================================
-- CHECK IT WORKED
--   select name, cycle_label, birds_alive, buyer_name, price_basis, price
--   from v_pens order by farm_id, house_id;
--   -- one row per pen; buyer_name is null for the farm's own pens.
-- =============================================================================
