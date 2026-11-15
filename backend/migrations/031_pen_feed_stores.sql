-- =============================================================================
-- Roost — 031 a feed store per pen, and moving feed between them
--
-- Run 030_pens_contracts.sql first.
--
-- Until now the farm had one feed store: every delivery and every count
-- belonged to the farm, and every bag opened in any pen came out of the same
-- pile. With several pens — one of them perhaps fed by a contract buyer — the
-- question is no longer "how many bags do we have" but "how many bags are
-- WHERE".
--
-- So each pen gets its own store. A delivery arrives at a pen. A count is a
-- count of one pen's store. A bag ticked as opened on the daily check comes
-- out of the store of the pen that flock is in. And feed can be MOVED from
-- one pen's store to another's: a transfer takes bags out of one and puts
-- the same bags into the other, on the same day, so nothing is created or
-- lost on the way.
--
-- Bags in a pen's store
--     = its last count
--     + deliveries to it since
--     + bags moved in since
--     - bags moved out since
--     - bags its flock has opened since
--
-- Still nothing stored as a level: v_feed_stock works it out from the
-- records, now one row per pen per ration, and v_feed_alerts (027) follows.
--
-- EVERYTHING ALREADY RECORDED goes to the farm's first pen. It was one store,
-- and its counts and deliveries only make sense kept together. If some of
-- that feed is really sitting in another pen, move it there with a transfer.
-- =============================================================================


-- ---------- Dependencies ------------------------------------------------------
do $$
begin
  if to_regclass('public.v_pens') is null then
    raise exception
      'Migration 030 has not been applied. Run 030_pens_contracts.sql before this file.';
  end if;
  if to_regclass('public.feed_alert_emails') is null then
    raise exception
      'Migration 028 has not been applied. Run 028_feed_alert_emails.sql before this file.';
  end if;
end $$;


-- ---------- Which pen a delivery and a count belong to --------------------------
-- Deliveries hold a pen back from being deleted: the money was spent, and the
-- record of it must not vanish with the pen. (The Pens screen retires such a
-- pen instead.) Counts simply go with their pen.
alter table feed_purchases
  add column if not exists house_id bigint references houses(id) on delete restrict;
alter table feed_stock_counts
  add column if not exists house_id bigint references houses(id) on delete cascade;

update feed_purchases p
set house_id = (select h.id from houses h where h.farm_id = p.farm_id order by h.id limit 1)
where p.house_id is null;

update feed_stock_counts c
set house_id = (select h.id from houses h where h.farm_id = c.farm_id order by h.id limit 1)
where c.house_id is null;

-- One count per pen per ration per day, where it used to be per farm.
alter table feed_stock_counts
  drop constraint if exists feed_stock_counts_farm_id_phase_counted_on_key;
create unique index if not exists feed_stock_counts_pen_day
  on feed_stock_counts (house_id, phase, counted_on);

create index if not exists feed_purchases_pen_idx
  on feed_purchases (house_id, phase, purchased_on);

-- A record that arrives without a pen (an old copy of the app still open in
-- someone's browser) lands in the farm's first pen rather than nowhere. One
-- that names a pen must name one of this farm's.
create or replace function public.feed_record_pen() returns trigger
language plpgsql as $$
begin
  if new.house_id is null then
    select h.id into new.house_id
    from houses h where h.farm_id = new.farm_id
    order by h.active desc, h.id limit 1;
  elsif not exists (select 1 from houses h where h.id = new.house_id and h.farm_id = new.farm_id) then
    raise exception 'That pen does not belong to this farm';
  end if;
  return new;
end $$;

drop trigger if exists trg_feed_purchases_pen on feed_purchases;
create trigger trg_feed_purchases_pen
  before insert or update on feed_purchases
  for each row execute function feed_record_pen();

drop trigger if exists trg_feed_stock_counts_pen on feed_stock_counts;
create trigger trg_feed_stock_counts_pen
  before insert or update on feed_stock_counts
  for each row execute function feed_record_pen();


-- ---------- Moving feed between pens ---------------------------------------------
create table if not exists feed_transfers (
  id             bigint generated always as identity primary key,
  farm_id        bigint not null references farms(id) on delete cascade,
  phase          feed_phase not null,
  from_house_id  bigint not null references houses(id) on delete restrict,
  to_house_id    bigint not null references houses(id) on delete restrict,
  bags           integer not null check (bags > 0),
  moved_on       date not null default current_date,
  notes          text,
  moved_by       uuid default auth.uid(),
  created_at     timestamptz not null default now(),
  check (from_house_id <> to_house_id)
);

create index if not exists feed_transfers_from_idx on feed_transfers (from_house_id, phase, moved_on);
create index if not exists feed_transfers_to_idx   on feed_transfers (to_house_id, phase, moved_on);

alter table feed_transfers enable row level security;

drop policy if exists feed_transfers_read   on feed_transfers;
drop policy if exists feed_transfers_insert on feed_transfers;
drop policy if exists feed_transfers_update on feed_transfers;
drop policy if exists feed_transfers_delete on feed_transfers;

-- Carrying bags from one pen to the next is daily work, like logging a
-- delivery (026): members do it, viewers only read.
create policy feed_transfers_read   on feed_transfers for select using (is_farm_member(farm_id));
create policy feed_transfers_insert on feed_transfers for insert with check (is_farm_editor(farm_id));
create policy feed_transfers_update on feed_transfers for update
  using (is_farm_editor(farm_id)) with check (is_farm_editor(farm_id));
create policy feed_transfers_delete on feed_transfers for delete using (is_farm_editor(farm_id));

create or replace function public.feed_transfer_pens() returns trigger
language plpgsql as $$
begin
  if (select count(*) from houses h
      where h.id in (new.from_house_id, new.to_house_id) and h.farm_id = new.farm_id) <> 2 then
    raise exception 'Feed can only be moved between two pens of the same farm';
  end if;
  return new;
end $$;

drop trigger if exists trg_feed_transfers_pens on feed_transfers;
create trigger trg_feed_transfers_pens
  before insert or update on feed_transfers
  for each row execute function feed_transfer_pens();


-- ---------- A new pen starts with an empty store ----------------------------------
-- "Never counted" exists (026) because this farm was opening bags long before
-- it logged a delivery, so its figure could not be trusted until someone
-- counted. A brand-new pen has no such past: its store is empty, and that is
-- a fact worth writing down, because it lets the figure — and the low-feed
-- alert — be trusted from the first delivery or transfer in.
--
-- Dated the day before, since a count is the store at the END of its day and
-- feed may well arrive on the day the pen is added. counted_by is null: no
-- person counted this, and the app leaves these out of the recent list.
--
-- SECURITY DEFINER so that adding a pen can never fail on the store's
-- policies; it writes three zeros for the pen just created and nothing else.
create or replace function public.houses_empty_store() returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  insert into feed_stock_counts (farm_id, house_id, phase, counted_on, bags, counted_by)
  select new.farm_id, new.id, p.phase, current_date - 1, 0, null
  from unnest(enum_range(null::feed_phase)) as p(phase)
  on conflict do nothing;
  return new;
end $$;

drop trigger if exists trg_houses_empty_store on houses;
create trigger trg_houses_empty_store
  after insert on houses
  for each row execute function houses_empty_store();

-- The same for pens that already exist and have nothing behind a ration at
-- all: no count, no delivery, no bag ever opened. Empty as of yesterday is
-- simply true of them. (Transfers cannot exist yet.) The first pen, with real
-- history, is left exactly as it was.
insert into feed_stock_counts (farm_id, house_id, phase, counted_on, bags, counted_by)
select h.farm_id, h.id, p.phase, current_date - 1, 0, null
from houses h
cross join unnest(enum_range(null::feed_phase)) as p(phase)
where not exists (select 1 from feed_stock_counts c where c.house_id = h.id and c.phase = p.phase)
  and not exists (select 1 from feed_purchases x   where x.house_id = h.id and x.phase = p.phase)
  and not exists (select 1 from feed_bag_openings o join cycles c on c.id = o.cycle_id
                  where c.house_id = h.id and o.phase = p.phase)
on conflict do nothing;


-- ---------- What should be in each pen's store -------------------------------------
-- The row grain changes (farm x ration -> pen x ration), so the views are
-- dropped and made again rather than replaced. Alerts first: it reads stock.
drop view if exists v_feed_alerts;
drop view if exists v_feed_stock;

create view v_feed_stock with (security_invoker = true) as
select
  h.farm_id,
  h.id                                   as house_id,
  h.name                                 as pen_name,
  h.active                               as pen_active,
  p.phase,
  lc.counted_on,
  lc.bags                                as counted_bags,
  coalesce(pu.bags, 0)                   as bought_since,
  coalesce(ti.bags, 0)                   as moved_in_since,
  coalesce(tx.bags, 0)                   as moved_out_since,
  coalesce(op.bags, 0)                   as opened_since,
  coalesce(lc.bags, 0) + coalesce(pu.bags, 0) + coalesce(ti.bags, 0)
    - coalesce(tx.bags, 0) - coalesce(op.bags, 0)
                                         as on_hand,
  lp.purchased_on                        as last_bought_on,
  lp.cost_per_bag                        as last_cost_per_bag,
  lp.bag_size_kg                         as last_bag_size_kg
from houses h
cross join unnest(enum_range(null::feed_phase)) as p(phase)
left join lateral (
  select counted_on, bags from feed_stock_counts c
  where c.house_id = h.id and c.phase = p.phase
  order by counted_on desc, id desc limit 1
) lc on true
left join lateral (
  select sum(bags) as bags from feed_purchases x
  where x.house_id = h.id and x.phase = p.phase
    and (lc.counted_on is null or x.purchased_on > lc.counted_on)
) pu on true
left join lateral (
  select sum(bags) as bags from feed_transfers t
  where t.to_house_id = h.id and t.phase = p.phase
    and (lc.counted_on is null or t.moved_on > lc.counted_on)
) ti on true
left join lateral (
  select sum(bags) as bags from feed_transfers t
  where t.from_house_id = h.id and t.phase = p.phase
    and (lc.counted_on is null or t.moved_on > lc.counted_on)
) tx on true
left join lateral (
  select count(*) as bags from feed_bag_openings o
  join cycles c on c.id = o.cycle_id
  where c.house_id = h.id and o.phase = p.phase
    and (lc.counted_on is null or o.opened_on > lc.counted_on)
) op on true
left join lateral (
  select purchased_on, cost_per_bag, bag_size_kg from feed_purchases x
  where x.house_id = h.id and x.phase = p.phase
  order by purchased_on desc, id desc limit 1
) lp on true;


-- ---------- Low-feed alerts, per pen -----------------------------------------------
-- Same rules as 027, asked of each pen's store about that pen's own flock: a
-- shed full of finisher in pen 1 does nothing for pen 2 until it is moved.
create view v_feed_alerts with (security_invoker = true) as
with usage as (
  select
    c.house_id,
    o.phase,
    count(*) filter (where o.opened_on > current_date - 7 and o.opened_on <= current_date)
                                                         as opened_7d,
    min(o.opened_on) filter (where o.opened_on > current_date - 7 and o.opened_on <= current_date)
                                                         as first_in_window,
    max(o.opened_on) filter (where o.opened_on <= current_date)
                                                         as last_opened_on
  from feed_bag_openings o
  join cycles c on c.id = o.cycle_id
  group by c.house_id, o.phase
),
rated as (
  select
    s.farm_id,
    s.house_id,
    s.pen_name,
    s.pen_active,
    s.phase,
    s.on_hand,
    s.counted_on,
    f.feed_alert_days,
    coalesce(u.opened_7d, 0)                             as opened_7d,
    u.last_opened_on,
    coalesce(u.last_opened_on >= current_date - 3, false) as in_use,
    case when u.opened_7d > 0
         then round(u.opened_7d::numeric / (current_date - u.first_in_window + 1), 2)
    end                                                  as bags_per_day
  from v_feed_stock s
  join farms f on f.id = s.farm_id
  left join usage u on u.house_id = s.house_id and u.phase = s.phase
)
select
  r.*,
  case when r.bags_per_day > 0
       then round(greatest(r.on_hand, 0) / r.bags_per_day, 1)
  end                                                    as days_left,
  case when r.bags_per_day > 0
       then current_date + floor(greatest(r.on_hand, 0) / r.bags_per_day)::int
  end                                                    as runs_out_on,
  case
    when r.counted_on is null                                         then 'uncounted'
    when not r.in_use or r.bags_per_day is null                       then 'idle'
    when r.on_hand <= 0                                               then 'out'
    when greatest(r.on_hand, 0) / r.bags_per_day < r.feed_alert_days  then 'low'
    else 'ok'
  end                                                    as level
from rated r;


-- ---------- The email log remembers which pen ---------------------------------------
-- So "already told you about grower" in pen 1 does not silence grower
-- running low in pen 2. Null on rows sent before this migration.
alter table feed_alert_emails
  add column if not exists house_id bigint references houses(id) on delete set null;


-- =============================================================================
-- CHECK IT WORKED
--   select pen_name, phase, counted_bags, bought_since, moved_in_since,
--          moved_out_since, opened_since, on_hand
--   from v_feed_stock order by farm_id, house_id, phase;
--   -- one row per pen per ration. The first pen carries the figures the
--   -- farm's single store had; a new pen shows 0 on hand.
--
--   select pen_name, phase, on_hand, bags_per_day, days_left, level
--   from v_feed_alerts order by farm_id, house_id, phase;
-- =============================================================================
