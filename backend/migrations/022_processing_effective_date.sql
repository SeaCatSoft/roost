-- =============================================================================
-- Roost — 022 a processing run only counts once its date arrives
--
-- 021_partial_processing.sql made birds_alive subtract processed birds the
-- moment a run was saved — but "Record a run" can be, and often is, filled
-- in ahead of the actual pickup: the count agreed with the processor, dated
-- for the morning it will happen, saved the evening before. Until that date
-- actually arrives, those birds are still in the house — still fed, still
-- checked on — and the flock count should say so.
--
-- The fix is one condition, in the same two lateral joins 021 already
-- added: a run counts toward birds_alive / birds_remaining only once its
-- processed_on has arrived, not from the moment it is saved. A same-day
-- entry counts the same day; nothing about recording a run right after it
-- happens changes.
-- =============================================================================


-- ---------- Dependencies ------------------------------------------------------
do $$
begin
  if to_regprocedure('public.archive_cycle(bigint)') is null
     or not exists (
       select 1 from information_schema.columns
       where table_name = 'v_cycle_progress' and column_name = 'birds_processed_total'
     )
  then
    raise exception
      'Migration 021 has not been applied. Run 021_partial_processing.sql before this file.';
  end if;
end $$;


-- ---------- v_cycle_progress: only count runs whose date has arrived ----------
-- Column list is untouched — CREATE OR REPLACE VIEW is safe here, since only
-- the WHERE clause inside a lateral subquery changes, not the outer SELECT.
create or replace view v_cycle_progress with (security_invoker = true) as
select
  c.id                as cycle_id,
  c.farm_id,
  c.label,
  c.placed_on,
  c.birds_placed,
  c.target_sale_age,
  (current_date - c.placed_on)                                 as age_days,
  greatest(c.target_sale_age - (current_date - c.placed_on), 0) as days_remaining,

  greatest(
    coalesce(l.birds_alive, c.birds_placed) - coalesce(p.birds_processed_total, 0),
    0
  )                                                            as birds_alive,

  coalesce(l.cumulative_losses, 0)                             as losses,
  case when c.birds_placed > 0
       then coalesce(l.cumulative_losses, 0)::numeric / c.birds_placed
  end                                                          as mortality_to_date,

  coalesce(b.bags_opened, 0)                                   as bags_opened,
  coalesce(t.days_recorded, 0)                                 as days_recorded,
  coalesce(t.days_complete, 0)                                 as days_complete,
  c.closed_at,

  coalesce(p.birds_processed_total, 0)                         as birds_processed_total
from cycles c
left join lateral (
  select birds_alive, cumulative_losses
  from v_daily_flock f
  where f.cycle_id = c.id
  order by f.day_number desc, session_rank(f.session) desc
  limit 1
) l on true
left join lateral (
  select count(*) as bags_opened from feed_bag_openings o where o.cycle_id = c.id
) b on true
left join lateral (
  select count(*) as days_recorded,
         count(*) filter (where complete) as days_complete
  from v_daily_totals dt where dt.cycle_id = c.id
) t on true
left join lateral (
  -- Dated for the future: the run is saved, but has not happened yet as far
  -- as the flock is concerned, so it does not count against it yet.
  select sum(birds_processed) as birds_processed_total
  from processing_runs r
  where r.cycle_id = c.id and r.processed_on <= current_date
) p on true;


-- ---------- v_cycle_summary: the same rule, for the same reason ---------------
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

  case when c.closed_at is null
       then (current_date - c.placed_on)
       else (c.closed_at::date - c.placed_on)
  end                               as age_days,
  coalesce(ck.days_recorded, 0)     as days_recorded,

  coalesce(ck.losses, 0)            as losses_actual,
  greatest(
    c.birds_placed - coalesce(ck.losses, 0) - coalesce(pr.birds_processed_total, 0),
    0
  )                                 as birds_remaining,
  case when c.birds_placed > 0
       then coalesce(ck.losses, 0)::numeric / c.birds_placed
  end                               as mortality_actual,

  coalesce(bg.bags_opened, 0)       as bags_opened,
  coalesce(bg.bags_opened, 0) * coalesce(a.bag_size_kg, 30) as feed_kg_actual,

  sw.last_weight_g,
  sw.last_weight_day,

  case
    when sw.last_weight_g is not null
     and (c.birds_placed - coalesce(ck.losses, 0)) > 0
     and coalesce(bg.bags_opened, 0) > 0
    then (coalesce(bg.bags_opened, 0) * coalesce(a.bag_size_kg, 30))
         / ((c.birds_placed - coalesce(ck.losses, 0)) * (sw.last_weight_g / 1000.0))
  end                               as fcr_actual,

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
  select count(*) as days_recorded, coalesce(sum(losses), 0) as losses
  from v_daily_totals dt where dt.cycle_id = c.id
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
left join lateral (
  select sum(birds_processed) as birds_processed_total
  from processing_runs r where r.cycle_id = c.id and r.processed_on <= current_date
) pr on true
left join v_cycle_pnl p on p.cycle_id = c.id;


-- =============================================================================
-- CHECK IT WORKED
--   A run dated tomorrow or later should not move birds_alive today:
--   insert a processing_runs row with processed_on = current_date + 1,
--   then select birds_alive, birds_processed_total from v_cycle_progress
--   for that cycle — both should be unchanged until that date arrives.
-- =============================================================================
