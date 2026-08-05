-- =============================================================================
-- Roost — 010 twice-daily checks
--
-- Brooding needs watching more closely than grow-out, so the first two weeks
-- are checked morning and afternoon. Until now the table allowed exactly one
-- row per cycle-day, which made the second check impossible to record.
--
-- Every check now carries a session. Days 1–14 expect AM and PM; from day 15
-- a single 'DAY' check. Existing rows become 'DAY', which is what they were.
-- =============================================================================

create type check_session as enum ('AM', 'PM', 'DAY');

alter table daily_checks
  add column session check_session not null default 'DAY';

-- One row per cycle, day and session — rather than per cycle and day.
alter table daily_checks drop constraint daily_checks_cycle_id_day_number_key;
alter table daily_checks add constraint daily_checks_cycle_day_session_key
  unique (cycle_id, day_number, session);

-- Sort order for a session within its day, so running totals accumulate in the
-- order the checks actually happened.
create or replace function public.session_rank(s check_session)
returns smallint language sql immutable as $$
  select case s when 'AM' then 1 when 'PM' then 2 else 1 end::smallint;
$$;


-- ---------- How many checks a given day expects -------------------------------
-- Two for the first fortnight, one after. Kept as a function so the rule lives
-- in one place rather than being re-derived in every screen.
create or replace function public.checks_expected(p_day integer)
returns smallint language sql immutable as $$
  select case when p_day <= 14 then 2 else 1 end::smallint;
$$;


-- ---------- Running flock count, across sessions ------------------------------
create or replace view v_daily_flock with (security_invoker = true) as
select
  d.*,
  c.farm_id,
  c.birds_placed,
  c.birds_placed - sum(d.mortality + d.culls)
    over (partition by d.cycle_id
          order by d.day_number, session_rank(d.session)
          rows between unbounded preceding and current row) as birds_alive,
  sum(d.mortality + d.culls)
    over (partition by d.cycle_id
          order by d.day_number, session_rank(d.session)
          rows between unbounded preceding and current row) as cumulative_losses
from daily_checks d
join cycles c on c.id = d.cycle_id;


-- ---------- One row per day, sessions folded together -------------------------
-- What most screens actually want: the day as a whole.
create or replace view v_daily_totals with (security_invoker = true) as
select
  d.cycle_id,
  c.farm_id,
  d.day_number,
  min(d.checked_on)                                  as checked_on,
  sum(d.mortality)                                   as mortality,
  sum(d.culls)                                       as culls,
  sum(d.mortality + d.culls)                         as losses,
  count(*)                                           as checks_done,
  checks_expected(d.day_number)                      as checks_expected,
  (count(*) >= checks_expected(d.day_number))        as complete,
  bool_or(d.session = 'AM')                          as has_am,
  bool_or(d.session = 'PM')                          as has_pm,
  max(d.house_temp_c)                                as house_temp_c,
  -- Worst condition seen across the day is the one worth surfacing.
  max(d.litter::text)                                as litter,
  max(d.water::text)                                 as water
from daily_checks d
join cycles c on c.id = d.cycle_id
group by d.cycle_id, c.farm_id, d.day_number;


-- ---------- The mortality guard, session-aware --------------------------------
create or replace function assert_mortality_plausible() returns trigger
language plpgsql as $$
declare
  placed  integer;
  already integer;
begin
  select birds_placed into placed from cycles where id = new.cycle_id;

  -- Every other check on the cycle: other days, and the other session of
  -- this day. Comparing on day alone would ignore the morning's losses when
  -- the afternoon check is saved.
  select coalesce(sum(mortality + culls), 0) into already
  from daily_checks
  where cycle_id = new.cycle_id
    and not (day_number = new.day_number and session = new.session);

  if already + new.mortality + new.culls > placed then
    raise exception 'day % (%) records % losses but only % birds remain of % placed',
      new.day_number, new.session, new.mortality + new.culls, placed - already, placed;
  end if;

  return new;
end $$;


-- ---------- Progress, counting part-finished days -----------------------------
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
  coalesce(l.birds_alive, c.birds_placed)                      as birds_alive,
  coalesce(l.cumulative_losses, 0)                             as losses,
  case when c.birds_placed > 0
       then coalesce(l.cumulative_losses, 0)::numeric / c.birds_placed
  end                                                          as mortality_to_date,
  coalesce(b.bags_opened, 0)                                   as bags_opened,
  coalesce(t.days_recorded, 0)                                 as days_recorded,
  coalesce(t.days_complete, 0)                                 as days_complete,
  c.closed_at
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
) t on true;


-- ---------- Batch summary, updated for sessions -------------------------------
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
  c.birds_placed - coalesce(ck.losses, 0) as birds_remaining,
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
  -- Distinct days, not distinct checks: two sessions on day 3 are still one day.
  select count(*) as days_recorded, coalesce(sum(losses), 0) as losses
  from v_daily_totals dt where dt.cycle_id = c.id
) ck on true
left join lateral (
  select count(*) as bags_opened from feed_bag_openings o where o.cycle_id = c.id
) bg on true
left join lateral (
  select avg_weight_g as last_weight_g, day_number as last_weight_day
  from sample_weights s where s.cycle_id = c.id
  order by day_number desc limit 1
) sw on true
left join v_cycle_pnl p on p.cycle_id = c.id;
