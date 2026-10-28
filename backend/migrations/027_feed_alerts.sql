-- =============================================================================
-- Roost — 027 low-feed alerts
--
-- Run 026_feed_stock.sql first.
--
-- The question: how many days until a ration runs out, at the rate the farm
-- is actually using it? Bags on hand come from v_feed_stock (026). The rate
-- comes from the same daily-check bag ticks, averaged over the last week.
--
-- The rate is per ration, because a store full of finisher does nothing for
-- birds still on grower. And it is measured only over the days the ration
-- has actually been in use: a ration started two days ago with four bags
-- opened is going at two a day, not four-sevenths of one.
--
-- One view decides the alert level, so every screen — and anything added
-- later to send the alert by email or text — reads the same answer rather
-- than each working it out its own way.
--
-- Levels:
--   uncounted  the store has never been counted for this ration, so the
--              on-hand figure is not real yet. No alert can be trusted.
--   idle       no bag of it opened in the last 3 days — not in use, so
--              there is no rate to run out at.
--   out        in use and nothing left.
--   low        in use, and fewer days left than the farm's warning window.
--   ok         everything else.
-- =============================================================================


-- ---------- Dependencies ------------------------------------------------------
do $$
begin
  if to_regclass('public.v_feed_stock') is null then
    raise exception
      'Migration 026 has not been applied. Run 026_feed_stock.sql before this file.';
  end if;
end $$;


-- ---------- How much warning the farm wants ------------------------------------
-- Should be at least the supplier's lead time plus a day or two. Owner-set,
-- through the existing farms_write policy (009) — it is a business call.
alter table farms
  add column if not exists feed_alert_days smallint not null default 7
    check (feed_alert_days between 1 and 60);


-- ---------- The alert ----------------------------------------------------------
create or replace view v_feed_alerts with (security_invoker = true) as
with usage as (
  select
    c.farm_id,
    o.phase,
    count(*) filter (where o.opened_on > current_date - 7 and o.opened_on <= current_date)
                                                         as opened_7d,
    min(o.opened_on) filter (where o.opened_on > current_date - 7 and o.opened_on <= current_date)
                                                         as first_in_window,
    max(o.opened_on) filter (where o.opened_on <= current_date)
                                                         as last_opened_on
  from feed_bag_openings o
  join cycles c on c.id = o.cycle_id
  group by c.farm_id, o.phase
),
rated as (
  select
    s.farm_id,
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
  left join usage u on u.farm_id = s.farm_id and u.phase = s.phase
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


-- =============================================================================
-- CHECK IT WORKED
--   select phase, on_hand, bags_per_day, days_left, runs_out_on, level
--   from v_feed_alerts order by farm_id, phase;
--   -- until the store is counted every row says 'uncounted'. That is right.
-- =============================================================================
