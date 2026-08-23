-- =============================================================================
-- Roost — 018 forecast
--
-- Storage for TimesFM's end-of-cycle projections. A GitHub Actions job
-- (backend/forecast/forecast.py) runs daily, forecasts where each open
-- cycle's feed-bag usage and mortality are headed, and writes one row here
-- per cycle per metric per day. The app only ever reads this table — nothing
-- in the frontend computes a forecast.
--
-- Runs are kept rather than overwritten in place (unique on as_of_day, not a
-- single row per cycle), so a chart can show how the projection moved as the
-- cycle went on rather than only the latest guess.
-- =============================================================================

create type forecast_metric as enum ('feed_bags', 'mortality');

create table cycle_forecasts (
  id               bigint generated always as identity primary key,
  cycle_id         bigint not null references cycles(id) on delete cascade,
  metric           forecast_metric not null,
  generated_at     timestamptz not null default now(),

  -- Last day of real data the forecast was conditioned on.
  as_of_day        smallint not null check (as_of_day > 0),

  -- End-of-cycle numbers: what TimesFM projects vs. what the plan/assumptions
  -- say. feed_bags: total bags. mortality: total birds lost.
  projected_total  numeric(12,4) not null,
  planned_total    numeric(12,4) not null,
  deviation_pct    numeric(6,2) not null,   -- (projected - planned) / planned * 100

  -- [{day, actual, planned, forecast}, ...] — actual/forecast null past their
  -- own range so a chart can tell "recorded" from "projected" apart.
  series           jsonb not null,

  unique (cycle_id, metric, as_of_day)
);

create index on cycle_forecasts (cycle_id, metric, generated_at desc);

alter table cycle_forecasts enable row level security;

-- Read-only from the app. The job writes with the service-role key, which
-- bypasses RLS entirely — there is deliberately no insert/update policy here.
create policy cycle_forecasts_read on cycle_forecasts
  for select using (can_access_cycle(cycle_id));
