-- =============================================================================
-- Roost — 001 schema
-- Tables, types and constraints. Run this first.
--
-- Design note: every table carries farm_id and access goes through farm_members,
-- even though there is exactly one farm today. Tenancy is the one thing that is
-- painful to retrofit — doing it now costs nothing and means opening Roost to a
-- second farm later is a data change, not a migration.
--
-- Stored vs derived: only inputs are stored. Anything the planner works out with
-- a formula (birds alive, breakeven, feed required) is a view in 002, so the two
-- can never drift apart.
-- =============================================================================

-- ---------- Enumerated types -------------------------------------------------
-- Values are taken verbatim from the workbook's "Checklist guide" column so the
-- spreadsheet imports without translation.

create type water_status   as enum ('OK', 'Low', 'Empty');
create type litter_status  as enum ('Dry', 'Damp', 'Wet');
create type feed_phase     as enum ('Starter', 'Grower', 'Finisher');
create type health_status  as enum ('Normal', 'Off-feed', 'Coughing', 'Lame');
create type health_category as enum ('Brooding', 'Health', 'Vaccine', 'Management', 'Processing');
create type member_role    as enum ('owner', 'member');


-- ---------- Farm, membership, houses ----------------------------------------

create table farms (
  id          bigint generated always as identity primary key,
  name        text not null,
  currency    char(3) not null default 'USD',
  weight_unit text not null default 'lb' check (weight_unit in ('lb', 'kg')),
  created_at  timestamptz not null default now()
);

-- The join table every security policy leans on.
create table farm_members (
  farm_id    bigint not null references farms(id) on delete cascade,
  user_id    uuid   not null references auth.users(id) on delete cascade,
  role       member_role not null default 'member',
  created_at timestamptz not null default now(),
  primary key (farm_id, user_id)
);

create index on farm_members (user_id);

create table houses (
  id            bigint generated always as identity primary key,
  farm_id       bigint not null references farms(id) on delete cascade,
  name          text not null,
  floor_area_m2 numeric(8,2),
  unique (farm_id, name)
);


-- ---------- Cycles -----------------------------------------------------------

create table cycles (
  id              bigint generated always as identity primary key,
  farm_id         bigint not null references farms(id) on delete cascade,
  house_id        bigint references houses(id) on delete set null,
  label           text not null,
  breed           text,
  placed_on       date not null,
  birds_placed    integer not null check (birds_placed > 0),
  target_sale_age integer not null default 42 check (target_sale_age between 21 and 120),
  closed_at       timestamptz,
  created_at      timestamptz not null default now(),
  unique (farm_id, label)
);

create index on cycles (farm_id, placed_on desc);

-- Per cycle, never global. Prices and yields move between flocks, and a closed
-- cycle has to keep the numbers it was actually costed with.
create table cycle_assumptions (
  cycle_id            bigint primary key references cycles(id) on delete cascade,

  -- production
  mortality_rate      numeric(5,4) not null default 0.0500 check (mortality_rate between 0 and 1),
  live_weight_lb      numeric(6,2) not null default 5.50   check (live_weight_lb > 0),
  dressing_yield      numeric(5,4) not null default 0.7200 check (dressing_yield between 0 and 1),
  shrink_loss         numeric(5,4) not null default 0.0200 check (shrink_loss between 0 and 1),
  whole_bird_share    numeric(5,4) not null default 0.4000 check (whole_bird_share between 0 and 1),
  cutup_trim_loss     numeric(5,4) not null default 0.0300 check (cutup_trim_loss between 0 and 1),
  bag_size_kg         numeric(6,2) not null default 30.00  check (bag_size_kg > 0),

  -- per-bird and per-lb costs
  chick_cost          numeric(10,2) not null default 1.50,
  processing_fee      numeric(10,2) not null default 1.25,
  whole_packaging     numeric(10,2) not null default 0.35,
  cutup_labour        numeric(10,2) not null default 0.45,
  cutup_packaging_lb  numeric(10,2) not null default 0.30,
  chilling_fee        numeric(10,2) not null default 0.15,
  transport_fee       numeric(10,2) not null default 0.20,

  -- whole-cycle fixed costs
  bedding_cost        numeric(10,2) not null default 150.00,
  utilities_cost      numeric(10,2) not null default 120.00,
  labour_cost         numeric(10,2) not null default 350.00,
  medication_cost     numeric(10,2) not null default 125.00,
  misc_cost           numeric(10,2) not null default 100.00,

  -- feed price by phase
  starter_bag_cost    numeric(10,2) not null default 57.50,
  grower_bag_cost     numeric(10,2) not null default 55.50,
  finisher_bag_cost   numeric(10,2) not null default 54.50
);


-- ---------- Feed -------------------------------------------------------------

-- The weekly intake curve. Editable per cycle: this is the single biggest
-- driver of feed cost and the place a poor conversion ratio shows up first.
create table feed_intake_curve (
  cycle_id           bigint not null references cycles(id) on delete cascade,
  week               smallint not null check (week between 1 and 20),
  phase              feed_phase not null,
  g_per_bird_per_day numeric(6,1) not null check (g_per_bird_per_day >= 0),
  primary key (cycle_id, week)
);

create table feed_purchases (
  id           bigint generated always as identity primary key,
  farm_id      bigint not null references farms(id) on delete cascade,
  cycle_id     bigint references cycles(id) on delete set null,
  phase        feed_phase not null,
  purchased_on date not null,
  bags         integer not null check (bags > 0),
  bag_size_kg  numeric(6,2) not null,
  cost_per_bag numeric(10,2) not null,
  supplier     text,
  created_at   timestamptz not null default now()
);

create index on feed_purchases (cycle_id);

-- The daily check's "new bag opened" tick. This is actual consumption, as
-- opposed to the plan — the gap between the two is the early warning.
create table feed_bag_openings (
  id         bigint generated always as identity primary key,
  cycle_id   bigint not null references cycles(id) on delete cascade,
  opened_on  date not null,
  phase      feed_phase not null,
  bag_number integer,
  created_at timestamptz not null default now()
);

create index on feed_bag_openings (cycle_id, opened_on);


-- ---------- The daily check --------------------------------------------------

-- birds_alive is deliberately NOT a column. It is placements minus cumulative
-- mortality, computed in v_daily_flock, so it cannot be edited into a state
-- that disagrees with the mortality records.
create table daily_checks (
  id              bigint generated always as identity primary key,
  cycle_id        bigint not null references cycles(id) on delete cascade,
  day_number      smallint not null check (day_number > 0),
  checked_on      date not null,
  mortality       integer not null default 0 check (mortality >= 0),
  culls           integer not null default 0 check (culls >= 0),
  feed_offered_kg numeric(8,2) check (feed_offered_kg >= 0),
  water           water_status,
  litter          litter_status,
  house_temp_c    numeric(4,1),
  light_zone      feed_phase,
  health          health_status,
  action_taken    text,
  notes           text,
  recorded_by     uuid references auth.users(id) on delete set null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (cycle_id, day_number)
);

create index on daily_checks (cycle_id, day_number);

create table sample_weights (
  id            bigint generated always as identity primary key,
  cycle_id      bigint not null references cycles(id) on delete cascade,
  day_number    smallint not null check (day_number > 0),
  birds_sampled integer not null check (birds_sampled > 0),
  avg_weight_g  numeric(8,1) not null check (avg_weight_g > 0),
  recorded_by   uuid references auth.users(id) on delete set null,
  created_at    timestamptz not null default now(),
  unique (cycle_id, day_number)
);


-- ---------- Health -----------------------------------------------------------

create table health_tasks (
  id           bigint generated always as identity primary key,
  cycle_id     bigint not null references cycles(id) on delete cascade,
  day_number   smallint not null,
  category     health_category not null,
  task         text not null,
  completed_on date,
  cost         numeric(10,2),
  quantity     text,
  notes        text
);

create index on health_tasks (cycle_id, day_number);


-- ---------- Processing and product lines -------------------------------------

create table product_lines (
  id            bigint generated always as identity primary key,
  farm_id       bigint not null references farms(id) on delete cascade,
  name          text not null,
  is_whole_bird boolean not null default false,
  sort_order    smallint not null default 0,
  unique (farm_id, name)
);

create table cycle_product_mix (
  cycle_id        bigint not null references cycles(id) on delete cascade,
  product_line_id bigint not null references product_lines(id) on delete cascade,
  mix_share       numeric(5,4) check (mix_share between 0 and 1),  -- null for whole birds
  price_per_lb    numeric(10,2) not null check (price_per_lb >= 0),
  primary key (cycle_id, product_line_id)
);

create table processing_runs (
  id                bigint generated always as identity primary key,
  cycle_id          bigint not null references cycles(id) on delete cascade,
  processed_on      date not null,
  birds_processed   integer not null check (birds_processed > 0),
  birds_condemned   integer not null default 0 check (birds_condemned >= 0),
  live_weight_lb    numeric(10,2),
  dressed_weight_lb numeric(10,2),
  processor         text,
  lot_code          text,
  created_at        timestamptz not null default now()
);

create index on processing_runs (cycle_id);

-- Actual weight out, per line, per run — the counterweight to the planned mix.
create table processing_outputs (
  id              bigint generated always as identity primary key,
  run_id          bigint not null references processing_runs(id) on delete cascade,
  product_line_id bigint not null references product_lines(id) on delete cascade,
  weight_lb       numeric(10,2) not null check (weight_lb >= 0),
  units           integer check (units >= 0),
  unique (run_id, product_line_id)
);


-- ---------- Costs and assets -------------------------------------------------

-- Actual money spent, as opposed to the modelled cost stack in v_cycle_pnl.
create table cost_lines (
  id          bigint generated always as identity primary key,
  farm_id     bigint not null references farms(id) on delete cascade,
  cycle_id    bigint references cycles(id) on delete set null,
  category    text not null,
  amount      numeric(12,2) not null,
  driver      text,
  incurred_on date,
  created_at  timestamptz not null default now()
);

create index on cost_lines (cycle_id);

create table assets (
  id                  bigint generated always as identity primary key,
  farm_id             bigint not null references farms(id) on delete cascade,
  name                text not null,
  category            text,
  purchased_on        date,
  purchase_cost       numeric(12,2),
  expected_life_years numeric(4,1) check (expected_life_years > 0),
  last_serviced_on    date,
  next_service_due    date,
  status              text not null default 'active' check (status in ('active', 'retired', 'repair')),
  notes               text
);

create index on assets (farm_id, next_service_due) where status = 'active';


-- ---------- Integrity --------------------------------------------------------

-- A cut-up mix that does not add to 100% silently misprices every part, so it
-- is rejected on write rather than trusted to the UI.
create or replace function assert_mix_within_bounds() returns trigger
language plpgsql as $$
declare
  total numeric;
begin
  select coalesce(sum(mix_share), 0) into total
  from cycle_product_mix
  where cycle_id = new.cycle_id and mix_share is not null;

  if total > 1.0001 then
    raise exception 'cut-up mix for cycle % totals %%%, which exceeds 100%%',
      new.cycle_id, round(total * 100, 2);
  end if;

  return new;
end $$;

create trigger trg_mix_bounds
  after insert or update on cycle_product_mix
  for each row execute function assert_mix_within_bounds();

-- A daily check cannot record more deaths than there are live birds.
create or replace function assert_mortality_plausible() returns trigger
language plpgsql as $$
declare
  placed  integer;
  already integer;
begin
  select birds_placed into placed from cycles where id = new.cycle_id;

  -- Every OTHER day, not just earlier ones. Counting only earlier days would
  -- let an edit to day 1 push the cycle total past the birds placed.
  select coalesce(sum(mortality + culls), 0) into already
  from daily_checks
  where cycle_id = new.cycle_id
    and day_number <> new.day_number;

  if already + new.mortality + new.culls > placed then
    raise exception 'day % records % losses but only % birds remain of % placed',
      new.day_number, new.mortality + new.culls, placed - already, placed;
  end if;

  return new;
end $$;

create trigger trg_mortality_plausible
  before insert or update on daily_checks
  for each row execute function assert_mortality_plausible();

create or replace function touch_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

create trigger trg_daily_checks_touch
  before update on daily_checks
  for each row execute function touch_updated_at();
