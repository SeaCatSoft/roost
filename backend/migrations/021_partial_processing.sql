-- =============================================================================
-- Roost — 021 partial processing
--
-- Roost has always assumed the whole flock goes to the processor at once:
-- birds_alive was placements minus mortality only, with no way for a run to
-- reduce it. Real flocks are often sent in batches — some birds now, the
-- rest later at a bigger weight — and until now a partial run recorded
-- correctly in processing_runs, but the birds it accounted for kept showing
-- as "alive" everywhere else: feed planning, weighing, the daily check.
--
-- Two changes, kept deliberately separate:
--
--   1. birds_alive now also subtracts birds already sent to processing, not
--      only birds confirmed dead. A processed bird did not die — mixing the
--      two would corrupt mortality_to_date, a health metric, with a sales
--      fact. mortality_to_date is untouched by this migration; it still
--      means exactly what it always meant.
--
--   2. Booking gets a stated intended count — purely a plan for the email
--      and the conversation with the processor, not something anything else
--      reads. What actually reduces the flock is a recorded run's own
--      birds_processed, same as it always was: plans can slip, and only the
--      real run is trusted to move a number that feed and health decisions
--      depend on.
--
-- archive_cycle (005_cycle_management.sql) already exists and already does
-- exactly the right thing — closes a cycle without deleting it. Nothing
-- about it needed to change; the gap was that nothing on the processing
-- screen ever pointed at it once the flock was actually finished. That is
-- an app-side fix (processing.js), not a database one.
-- =============================================================================


-- ---------- Dependencies ------------------------------------------------------
do $$
begin
  if to_regclass('public.processing_bookings') is null then
    raise exception
      'Migration 020 has not been applied. Run 020_processing_bookings.sql before this file.';
  end if;
end $$;


-- ---------- An intended count on the booking ----------------------------------
alter table processing_bookings
  add column if not exists birds_intended integer check (birds_intended >= 0);


-- ---------- birds_alive now accounts for processing, not only mortality -------
-- Based on the version actually live since 010_twice_daily_checks.sql, not
-- the original in 002_views.sql — 010 rebuilt this view (drop+recreate, not
-- replace, since it needed to reorder daily_checks' own columns) and added
-- days_recorded/days_complete along the way. An earlier draft of this
-- migration was written against the pre-010 shape and silently dropped both
-- columns, which is exactly the "cannot drop columns from view" this fixes.
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

  -- Still in the house: not dead, and not already on a truck to the plant
  -- either. This is what "alive" should mean to feed planning, weighing and
  -- the daily check from here on — a bird already sent is no longer part of
  -- the flock being fed and checked on, whatever its health record says.
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

  -- Appended at the end, not inserted among the columns above: Postgres
  -- only allows CREATE OR REPLACE VIEW to add columns after every existing
  -- one — inserting a new column in the middle reads as dropping and
  -- reordering the columns after it, which it refuses outright.
  --
  -- Named separately from birds_alive so a screen can say "420 sent so far"
  -- rather than leaving that fact implied by subtraction.
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
  select sum(birds_processed) as birds_processed_total
  from processing_runs r
  where r.cycle_id = c.id
) p on true;


-- ---------- The history view gets the same fix, for the same reason -----------
-- A closed, fully-processed cycle should show nothing "remaining" in the
-- batch history — the birds were sold, not lost, and showing them as still
-- alive there is exactly as misleading as it would be on the live dashboard.
--
-- The ck join below is copied from the version actually live since
-- 010_twice_daily_checks.sql, not 006_cycle_history.sql's original — 010
-- moved "days recorded" and "losses" onto v_daily_totals so a day with both
-- an AM and a PM check counts as one day, not two. Building this against
-- 006 instead would have silently undone that the moment this ran, without
-- Postgres having any reason to complain — column names and order stayed
-- the same, only the count underneath them would have quietly reverted.
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
  from processing_runs r where r.cycle_id = c.id
) pr on true
left join v_cycle_pnl p on p.cycle_id = c.id;


-- ---------- The booking's stated intention -------------------------------------
create or replace view v_processing_bookings with (security_invoker = true) as
select
  b.id,
  b.farm_id,
  b.cycle_id,
  c.label as cycle_label,
  b.booked_on,
  b.booked_time,
  b.location,
  b.notes,
  b.updated_at,
  b.sequence_no,
  coalesce(i.total, 0)  as invite_count,
  coalesce(i.sent, 0)   as invites_sent,
  coalesce(i.stale, 0)  as invites_stale,
  coalesce(i.failed, 0) as invites_failed,
  (current_date > b.booked_on)             as is_past,
  -- Appended at the end for the same reason as v_cycle_progress above —
  -- CREATE OR REPLACE VIEW cannot insert a column ahead of existing ones.
  b.birds_intended
from processing_bookings b
join cycles c on c.id = b.cycle_id
left join lateral (
  select
    count(*)                                                          as total,
    count(*) filter (where sent_at is not null and error is null
                        and sent_for_seq is not distinct from b.sequence_no) as sent,
    count(*) filter (where sent_at is not null and error is null
                        and sent_for_seq is distinct from b.sequence_no)     as stale,
    count(*) filter (where error is not null)                          as failed
  from processing_booking_invites where booking_id = b.id
) i on true;


-- =============================================================================
-- CHECK IT WORKED
--   select cycle_id, birds_alive, birds_processed_total, mortality_to_date
--   from v_cycle_progress;
--   -- birds_alive should now read birds_placed minus BOTH losses and any
--   -- processing_runs already recorded, and mortality_to_date should be
--   -- exactly what it was before this migration — unaffected by processing.
-- =============================================================================
