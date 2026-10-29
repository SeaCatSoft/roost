-- =============================================================================
-- Roost — 029 expenses, bedding, and the weekly report
--
-- Run 028_feed_alert_emails.sql first.
--
-- Until now every cost in Roost was a planner assumption. v_cycle_costs (002)
-- adds up what the cycle SHOULD cost; nothing recorded what it DID cost.
-- cost_lines has existed since 001 for exactly that, with no screen writing
-- to it. This gives it one (app/expenses.html), and a few columns bedding
-- needs, since the question for bedding is not only what it cost but when it
-- went down and whether it was a fresh bed or a top-up.
--
-- Feed is deliberately NOT a cost_lines category. Feed spend is already
-- recorded, delivery by delivery, in feed_purchases (026). Letting it be
-- typed in here as well would count the same bags twice.
-- =============================================================================


-- ---------- Dependencies ------------------------------------------------------
do $$
begin
  if to_regclass('public.feed_alert_emails') is null then
    raise exception
      'Migration 028 has not been applied. Run 028_feed_alert_emails.sql before this file.';
  end if;
end $$;


-- ---------- Expenses ----------------------------------------------------------
alter table cost_lines
  add column if not exists quantity     numeric(10,2) check (quantity > 0),
  add column if not exists unit         text,
  add column if not exists bedding_kind text check (bedding_kind in ('new', 'top_up')),
  add column if not exists notes        text,
  add column if not exists recorded_by  uuid default auth.uid();

-- The categories line up one-for-one with the planner's cost stack, so every
-- actual has a planned figure to stand against. NOT VALID: enforced on every
-- new row, without failing on anything typed in before this migration.
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'cost_lines_category_check') then
    alter table cost_lines add constraint cost_lines_category_check
      check (category in ('chicks', 'bedding', 'medication', 'utilities',
                          'labour', 'processing', 'misc')) not valid;
  end if;
end $$;

create index if not exists cost_lines_farm_date_idx on cost_lines (farm_id, incurred_on);

-- What a bag of bedding costs, so logging "6 bags" fills in the cost. Only a
-- starting point: the expenses screen prefers the price per bag of the last
-- bedding actually logged, so a price change follows itself in without
-- anyone editing this.
alter table farms
  add column if not exists bedding_bag_price numeric(8,2) not null default 43.32
    check (bedding_bag_price >= 0);

-- Access is unchanged from 009: anyone on the farm reads, owners and members
-- write. Laying bedding is daily work, the same as opening a feed bag.


-- ---------- Planned against actual, per cycle ---------------------------------
-- One row per cycle per category. planned comes straight from v_cycle_costs,
-- so it always matches the dashboard's profit figure. processing gathers the
-- planner's per-bird processing lines (fee, packaging, cut-up labour,
-- chilling, transport) into the one bill the processor actually sends.
create or replace view v_cycle_cost_compare with (security_invoker = true) as
select
  co.cycle_id,
  co.farm_id,
  k.category,
  k.sort_order,
  coalesce(k.planned, 0)  as planned,
  coalesce(
    case when k.category = 'feed'
         then (select sum(fp.bags * fp.cost_per_bag) from feed_purchases fp
               where fp.cycle_id = co.cycle_id)
         else (select sum(cl.amount) from cost_lines cl
               where cl.cycle_id = co.cycle_id and cl.category = k.category)
    end, 0)              as actual
from v_cycle_costs co
cross join lateral (values
  ('chicks',     1, co.chicks),
  ('feed',       2, co.feed),
  ('bedding',    3, co.bedding),
  ('medication', 4, co.medication),
  ('utilities',  5, co.utilities),
  ('labour',     6, co.labour),
  ('processing', 7, co.processing + co.whole_packaging + co.cutup_labour
                    + co.cutup_packaging + co.chilling + co.transport),
  ('misc',       8, co.misc)
) as k(category, sort_order, planned);


-- ---------- The weekly report -------------------------------------------------
-- Owner switch, on by default, like the feed alerts (028).
alter table farms
  add column if not exists weekly_report_email boolean not null default true;

-- One row per farm per week, written by the job with the service role. The
-- unique key is what stops a re-run of the job emailing the same week twice.
create table if not exists weekly_reports (
  id          bigint generated always as identity primary key,
  farm_id     bigint not null references farms(id) on delete cascade,
  week_start  date not null,
  week_end    date not null,
  recipients  integer not null,
  sent_at     timestamptz not null default now(),
  unique (farm_id, week_start)
);

alter table weekly_reports enable row level security;
drop policy if exists weekly_reports_read on weekly_reports;
create policy weekly_reports_read on weekly_reports
  for select using (is_farm_member(farm_id));


-- =============================================================================
-- CHECK IT WORKED
--   select category, planned, actual from v_cycle_cost_compare
--   where cycle_id = (select max(id) from cycles) order by sort_order;
--   -- actual is 0 everywhere except feed until expenses are logged.
-- =============================================================================
