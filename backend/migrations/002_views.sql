-- =============================================================================
-- Roost — 002 derived views
-- Everything the workbook computes with a formula lives here, not in a column.
--
-- security_invoker = true is load-bearing. Without it a view runs with its
-- OWNER's permissions and quietly bypasses the row-level security added in 003
-- — every farm's figures would be readable through any view. Requires PG15+,
-- which Supabase is.
-- =============================================================================


-- ---------- Running flock count ----------------------------------------------
-- Birds alive is placements minus cumulative losses, exactly as the sheet does.

create or replace view v_daily_flock with (security_invoker = true) as
select
  d.*,
  c.farm_id,
  c.birds_placed,
  c.birds_placed - sum(d.mortality + d.culls)
    over (partition by d.cycle_id order by d.day_number
          rows between unbounded preceding and current row) as birds_alive,
  sum(d.mortality + d.culls)
    over (partition by d.cycle_id order by d.day_number
          rows between unbounded preceding and current row) as cumulative_losses
from daily_checks d
join cycles c on c.id = d.cycle_id;


-- ---------- Yield ------------------------------------------------------------
-- Live weight -> dressed -> net saleable -> whole / cut-up split.

create or replace view v_cycle_yield with (security_invoker = true) as
select
  c.id                        as cycle_id,
  c.farm_id,
  c.birds_placed,
  round(c.birds_placed * (1 - a.mortality_rate))              as birds_sold,
  a.live_weight_lb * a.dressing_yield                         as dressed_lb_per_bird,
  a.live_weight_lb * a.dressing_yield * (1 - a.shrink_loss)   as net_lb_per_bird,

  round(c.birds_placed * (1 - a.mortality_rate))
    * a.live_weight_lb * a.dressing_yield * (1 - a.shrink_loss) as total_net_lb,

  round(c.birds_placed * (1 - a.mortality_rate) * a.whole_bird_share) as whole_birds,
  round(c.birds_placed * (1 - a.mortality_rate))
    - round(c.birds_placed * (1 - a.mortality_rate) * a.whole_bird_share) as cutup_birds,

  round(c.birds_placed * (1 - a.mortality_rate) * a.whole_bird_share)
    * a.live_weight_lb * a.dressing_yield * (1 - a.shrink_loss) as whole_lb,

  (round(c.birds_placed * (1 - a.mortality_rate))
    - round(c.birds_placed * (1 - a.mortality_rate) * a.whole_bird_share))
    * a.live_weight_lb * a.dressing_yield * (1 - a.shrink_loss)
    * (1 - a.cutup_trim_loss)                                  as cutup_lb
from cycles c
join cycle_assumptions a on a.cycle_id = c.id;


-- ---------- Feed plan, week by week ------------------------------------------
-- Mortality is spread evenly across the weeks, so each week is costed against
-- the average number of birds actually eating during it.

create or replace view v_cycle_feed_plan with (security_invoker = true) as
with curve as (
  select
    f.cycle_id, f.week, f.phase, f.g_per_bird_per_day,
    count(*) over (partition by f.cycle_id) as num_weeks
  from feed_intake_curve f
)
select
  cu.cycle_id,
  c.farm_id,
  cu.week,
  cu.phase,
  cu.g_per_bird_per_day,
  c.birds_placed
    - (c.birds_placed * a.mortality_rate / cu.num_weeks) * (cu.week - 1) as birds_start,
  c.birds_placed
    - (c.birds_placed * a.mortality_rate / cu.num_weeks) * cu.week       as birds_end,
  c.birds_placed
    - (c.birds_placed * a.mortality_rate / cu.num_weeks) * (cu.week - 0.5) as avg_birds,
  cu.g_per_bird_per_day * 7
    * (c.birds_placed - (c.birds_placed * a.mortality_rate / cu.num_weeks) * (cu.week - 0.5))
    / 1000.0                                                              as weekly_kg
from curve cu
join cycles c            on c.id = cu.cycle_id
join cycle_assumptions a on a.cycle_id = cu.cycle_id;


-- ---------- Feed by phase, in whole bags -------------------------------------
-- Feed is bought in sacks, so the plan rounds up per phase. That rounding is
-- real money and belongs in the model.

create or replace view v_cycle_feed_by_phase with (security_invoker = true) as
select
  p.cycle_id,
  p.farm_id,
  p.phase,
  sum(p.weekly_kg)                                as phase_kg,
  ceil(sum(p.weekly_kg) / a.bag_size_kg)          as bags,
  case p.phase
    when 'Starter'  then a.starter_bag_cost
    when 'Grower'   then a.grower_bag_cost
    when 'Finisher' then a.finisher_bag_cost
  end                                             as cost_per_bag,
  ceil(sum(p.weekly_kg) / a.bag_size_kg) *
  case p.phase
    when 'Starter'  then a.starter_bag_cost
    when 'Grower'   then a.grower_bag_cost
    when 'Finisher' then a.finisher_bag_cost
  end                                             as phase_cost
from v_cycle_feed_plan p
join cycle_assumptions a on a.cycle_id = p.cycle_id
group by p.cycle_id, p.farm_id, p.phase, a.bag_size_kg,
         a.starter_bag_cost, a.grower_bag_cost, a.finisher_bag_cost;


create or replace view v_cycle_feed_totals with (security_invoker = true) as
select
  cycle_id,
  farm_id,
  sum(phase_kg)     as total_feed_kg,
  sum(bags)         as total_bags,
  sum(phase_cost)   as total_feed_cost
from v_cycle_feed_by_phase
group by cycle_id, farm_id;


-- ---------- Revenue by product line ------------------------------------------

create or replace view v_cycle_revenue_lines with (security_invoker = true) as
select
  m.cycle_id,
  y.farm_id,
  pl.id            as product_line_id,
  pl.name          as product_line,
  pl.is_whole_bird,
  pl.sort_order,
  m.mix_share,
  m.price_per_lb,
  case when pl.is_whole_bird
       then y.whole_lb
       else y.cutup_lb * coalesce(m.mix_share, 0)
  end              as weight_lb,
  case when pl.is_whole_bird
       then y.whole_lb * m.price_per_lb
       else y.cutup_lb * coalesce(m.mix_share, 0) * m.price_per_lb
  end              as revenue
from cycle_product_mix m
join product_lines pl on pl.id = m.product_line_id
join v_cycle_yield y  on y.cycle_id = m.cycle_id;


-- ---------- The cost stack ----------------------------------------------------

create or replace view v_cycle_costs with (security_invoker = true) as
select
  y.cycle_id,
  y.farm_id,
  c.birds_placed * a.chick_cost              as chicks,
  ft.total_feed_cost                         as feed,
  y.birds_sold * a.processing_fee            as processing,
  y.whole_birds * a.whole_packaging          as whole_packaging,
  y.cutup_birds * a.cutup_labour             as cutup_labour,
  y.cutup_lb * a.cutup_packaging_lb          as cutup_packaging,
  y.birds_sold * a.chilling_fee              as chilling,
  y.birds_sold * a.transport_fee             as transport,
  a.bedding_cost                             as bedding,
  a.utilities_cost                           as utilities,
  a.labour_cost                              as labour,
  a.medication_cost                          as medication,
  a.misc_cost                                as misc,

  c.birds_placed * a.chick_cost
    + coalesce(ft.total_feed_cost, 0)
    + y.birds_sold * a.processing_fee
    + y.whole_birds * a.whole_packaging
    + y.cutup_birds * a.cutup_labour
    + y.cutup_lb * a.cutup_packaging_lb
    + y.birds_sold * a.chilling_fee
    + y.birds_sold * a.transport_fee
    + a.bedding_cost + a.utilities_cost + a.labour_cost
    + a.medication_cost + a.misc_cost        as total_cost
from v_cycle_yield y
join cycles c                on c.id = y.cycle_id
join cycle_assumptions a     on a.cycle_id = y.cycle_id
left join v_cycle_feed_totals ft on ft.cycle_id = y.cycle_id;


-- ---------- The number that matters ------------------------------------------

create or replace view v_cycle_pnl with (security_invoker = true) as
select
  y.cycle_id,
  y.farm_id,
  c.label,
  c.placed_on,
  y.birds_placed,
  y.birds_sold,
  y.total_net_lb,
  ft.total_feed_kg,
  ft.total_bags,

  coalesce(r.revenue, 0)                                    as revenue,
  co.total_cost,
  coalesce(r.revenue, 0) - co.total_cost                    as operating_profit,

  case when coalesce(r.revenue, 0) > 0
       then (coalesce(r.revenue, 0) - co.total_cost) / r.revenue
  end                                                       as margin,

  case when y.birds_sold > 0
       then coalesce(r.revenue, 0) / y.birds_sold end       as revenue_per_bird,
  case when y.birds_sold > 0
       then co.total_cost / y.birds_sold end                as cost_per_bird,

  -- Both prices sit on net saleable weight, so they compare like for like.
  case when y.total_net_lb > 0
       then coalesce(r.revenue, 0) / y.total_net_lb end     as blended_price_lb,
  case when y.total_net_lb > 0
       then co.total_cost / y.total_net_lb end              as breakeven_price_lb,

  -- Feed conversion, as-hatched: total feed against total live weight sold.
  case when y.birds_sold * a.live_weight_lb > 0
       then ft.total_feed_kg / (y.birds_sold * a.live_weight_lb * 0.45359237)
  end                                                       as fcr
from v_cycle_yield y
join cycles c                    on c.id = y.cycle_id
join cycle_assumptions a         on a.cycle_id = y.cycle_id
join v_cycle_costs co            on co.cycle_id = y.cycle_id
left join v_cycle_feed_totals ft on ft.cycle_id = y.cycle_id
left join (
  select cycle_id, sum(revenue) as revenue
  from v_cycle_revenue_lines group by cycle_id
) r on r.cycle_id = y.cycle_id;


-- ---------- Live progress, for the dashboard ---------------------------------

create or replace view v_cycle_progress with (security_invoker = true) as
select
  c.id                as cycle_id,
  c.farm_id,
  c.label,
  c.placed_on,
  c.birds_placed,
  c.target_sale_age,
  (current_date - c.placed_on)                        as age_days,
  greatest(c.target_sale_age - (current_date - c.placed_on), 0) as days_remaining,
  coalesce(l.birds_alive, c.birds_placed)             as birds_alive,
  coalesce(l.cumulative_losses, 0)                    as losses,
  case when c.birds_placed > 0
       then coalesce(l.cumulative_losses, 0)::numeric / c.birds_placed
  end                                                 as mortality_to_date,
  coalesce(b.bags_opened, 0)                          as bags_opened,
  c.closed_at
from cycles c
left join lateral (
  select birds_alive, cumulative_losses
  from v_daily_flock f
  where f.cycle_id = c.id
  order by f.day_number desc
  limit 1
) l on true
left join lateral (
  select count(*) as bags_opened
  from feed_bag_openings o
  where o.cycle_id = c.id
) b on true;
