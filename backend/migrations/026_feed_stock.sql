-- =============================================================================
-- Roost — 026 feed in the store
--
-- feed_purchases has existed since 001 with nothing writing to it. Bags opened
-- have been ticked on the daily check all along. Together those already say
-- how many bags should be in the store: bought, less opened.
--
-- Except that bags were being opened long before anyone logged a delivery, so
-- "every purchase ever, less every opening ever" would start this farm deep
-- in the negative and stay there. A stock count fixes that honestly: count
-- what is physically in the store, and from then on the figure is that count,
-- plus deliveries after it, less bags opened after it. A later count simply
-- becomes the new starting point, which is also how a drift (a split bag, a
-- bag borrowed by a neighbour) gets corrected without a separate adjustment.
--
-- A count is the state of the store at the END of its day: any delivery or
-- opening dated the same day is treated as already in it. Dates, not
-- timestamps, because backfilled openings carry the day they happened, not
-- the moment they were typed in.
--
-- Counted in bags, the same unit the daily check uses. Nothing here is a
-- stored level, so it cannot disagree with the records behind it.
-- =============================================================================


-- ---------- Stock counts -------------------------------------------------------
create table if not exists feed_stock_counts (
  id          bigint generated always as identity primary key,
  farm_id     bigint not null references farms(id) on delete cascade,
  phase       feed_phase not null,
  counted_on  date not null,
  bags        integer not null check (bags >= 0),
  counted_by  uuid default auth.uid(),
  created_at  timestamptz not null default now(),
  -- Counting the same ration twice in one day corrects the count.
  unique (farm_id, phase, counted_on)
);

alter table feed_stock_counts enable row level security;

drop policy if exists feed_stock_counts_read   on feed_stock_counts;
drop policy if exists feed_stock_counts_insert on feed_stock_counts;
drop policy if exists feed_stock_counts_update on feed_stock_counts;
drop policy if exists feed_stock_counts_delete on feed_stock_counts;

-- Same split as feed_purchases (009): the store is daily work, so members
-- keep it; viewers read only.
create policy feed_stock_counts_read   on feed_stock_counts for select using (is_farm_member(farm_id));
create policy feed_stock_counts_insert on feed_stock_counts for insert with check (is_farm_editor(farm_id));
create policy feed_stock_counts_update on feed_stock_counts for update
  using (is_farm_editor(farm_id)) with check (is_farm_editor(farm_id));
create policy feed_stock_counts_delete on feed_stock_counts for delete using (is_farm_editor(farm_id));

create index if not exists feed_purchases_farm_idx on feed_purchases (farm_id, phase, purchased_on);


-- ---------- What should be in the store -----------------------------------------
-- One row per farm per ration. security_invoker so every table underneath is
-- read with the caller's own RLS — a farm you are not on simply has no rows.
create or replace view v_feed_stock with (security_invoker = true) as
select
  f.id                                   as farm_id,
  p.phase,
  lc.counted_on,
  lc.bags                                as counted_bags,
  coalesce(pu.bags, 0)                   as bought_since,
  coalesce(op.bags, 0)                   as opened_since,
  coalesce(lc.bags, 0) + coalesce(pu.bags, 0) - coalesce(op.bags, 0)
                                         as on_hand,
  lp.purchased_on                        as last_bought_on,
  lp.cost_per_bag                        as last_cost_per_bag,
  lp.bag_size_kg                         as last_bag_size_kg
from farms f
cross join unnest(enum_range(null::feed_phase)) as p(phase)
left join lateral (
  select counted_on, bags from feed_stock_counts c
  where c.farm_id = f.id and c.phase = p.phase
  order by counted_on desc, id desc limit 1
) lc on true
left join lateral (
  select sum(bags) as bags from feed_purchases x
  where x.farm_id = f.id and x.phase = p.phase
    and (lc.counted_on is null or x.purchased_on > lc.counted_on)
) pu on true
left join lateral (
  select count(*) as bags from feed_bag_openings o
  join cycles c on c.id = o.cycle_id
  where c.farm_id = f.id and o.phase = p.phase
    and (lc.counted_on is null or o.opened_on > lc.counted_on)
) op on true
left join lateral (
  select purchased_on, cost_per_bag, bag_size_kg from feed_purchases x
  where x.farm_id = f.id and x.phase = p.phase
  order by purchased_on desc, id desc limit 1
) lp on true;


-- =============================================================================
-- CHECK IT WORKED
--   select phase, counted_on, counted_bags, bought_since, opened_since, on_hand
--   from v_feed_stock order by farm_id, phase;
--   -- before any count, on_hand is likely negative: that is every bag ever
--   -- opened with no delivery logged against it. Count the store to fix it.
-- =============================================================================
