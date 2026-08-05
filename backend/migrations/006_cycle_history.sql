-- =============================================================================
-- Roost — 006 cycle history
--
-- Archiving only earns its keep if the archive is readable. This view puts one
-- row per cycle, open or closed, so batches can be totalled and compared.
--
-- It deliberately separates two kinds of number:
--   *_actual   — what was recorded (mortality from daily checks, feed from bags
--                physically opened)
--   modelled_* — what the assumptions predict (revenue, cost, breakeven)
-- Mixing them silently is how a dashboard ends up lying. Money stays modelled
-- until processing runs are entered; the flock figures are real from day one.
-- =============================================================================

create or replace view v_cycle_summary with (security_invoker = true) as
select
  c.id                as cycle_id,
  c.farm_id,
  c.label,
  c.breed,
  c.placed_on,
  c.closed_at,
  (c.closed_at is null)             as is_open,
  c.birds_placed,
  c.target_sale_age,

  -- Age, and how much of the grow-out is on record
  case when c.closed_at is null
       then (current_date - c.placed_on)
       else (c.closed_at::date - c.placed_on)
  end                               as age_days,
  coalesce(ck.days_recorded, 0)     as days_recorded,

  -- Actuals, from what was recorded
  coalesce(ck.losses, 0)            as losses_actual,
  c.birds_placed - coalesce(ck.losses, 0) as birds_remaining,
  case when c.birds_placed > 0
       then coalesce(ck.losses, 0)::numeric / c.birds_placed
  end                               as mortality_actual,

  coalesce(bg.bags_opened, 0)       as bags_opened,
  coalesce(bg.bags_opened, 0) * coalesce(a.bag_size_kg, 30) as feed_kg_actual,

  sw.last_weight_g,
  sw.last_weight_day,

  -- Actual conversion, where a real weighing exists to divide by. Null rather
  -- than a modelled stand-in: a made-up FCR is worse than none.
  case
    when sw.last_weight_g is not null
     and (c.birds_placed - coalesce(ck.losses, 0)) > 0
     and coalesce(bg.bags_opened, 0) > 0
    then (coalesce(bg.bags_opened, 0) * coalesce(a.bag_size_kg, 30))
         / ((c.birds_placed - coalesce(ck.losses, 0)) * (sw.last_weight_g / 1000.0))
  end                               as fcr_actual,

  -- Modelled economics, straight from the planner's assumptions
  p.total_feed_kg                   as modelled_feed_kg,
  p.total_bags                      as modelled_bags,
  p.revenue                         as modelled_revenue,
  p.total_cost                      as modelled_cost,
  p.operating_profit                as modelled_profit,
  p.margin                          as modelled_margin,
  p.breakeven_price_lb              as modelled_breakeven_lb,
  p.blended_price_lb                as modelled_blended_lb,
  p.fcr                             as modelled_fcr

from cycles c
left join cycle_assumptions a on a.cycle_id = c.id
left join lateral (
  select count(*) as days_recorded,
         sum(mortality + culls) as losses
  from daily_checks d where d.cycle_id = c.id
) ck on true
left join lateral (
  select count(*) as bags_opened
  from feed_bag_openings o where o.cycle_id = c.id
) bg on true
left join lateral (
  select avg_weight_g as last_weight_g, day_number as last_weight_day
  from sample_weights s where s.cycle_id = c.id
  order by day_number desc limit 1
) sw on true
left join v_cycle_pnl p on p.cycle_id = c.id;


-- ---------- Farm-level totals ------------------------------------------------
-- Every batch added together. Averages are weighted by birds placed rather than
-- a plain mean of per-cycle rates, so a 200-bird trial cannot swing the figure
-- as hard as a 1,500-bird flock.

create or replace view v_farm_totals with (security_invoker = true) as
select
  farm_id,
  count(*)                          as cycles,
  count(*) filter (where not is_open) as cycles_closed,
  sum(birds_placed)                 as birds_placed,
  sum(losses_actual)                as losses,
  case when sum(birds_placed) > 0
       then sum(losses_actual)::numeric / sum(birds_placed)
  end                               as mortality,
  sum(bags_opened)                  as bags_opened,
  sum(feed_kg_actual)               as feed_kg,
  sum(modelled_revenue)             as revenue,
  sum(modelled_cost)                as cost,
  sum(modelled_profit)              as profit,
  case when sum(modelled_revenue) > 0
       then sum(modelled_profit) / sum(modelled_revenue)
  end                               as margin
from v_cycle_summary
group by farm_id;
