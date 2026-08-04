# Roost — PostgreSQL data model

Derived directly from `broiler_whole_and_parts_planner.xlsx`. Each section notes the
sheet it comes from, so the migration path from spreadsheet to database is traceable.

The landing page is static and has no backend. This document is the reference for the
app that sits behind it.

---

## Enumerated types

Taken verbatim from the `Daily_Checklist` sheet's "Checklist guide" column, so imported
rows validate without translation.

```sql
CREATE TYPE water_status  AS ENUM ('OK', 'Low', 'Empty');
CREATE TYPE litter_status AS ENUM ('Dry', 'Damp', 'Wet');
CREATE TYPE feed_phase    AS ENUM ('Starter', 'Grower', 'Finisher');
CREATE TYPE health_status AS ENUM ('Normal', 'Off-feed', 'Coughing', 'Lame');
CREATE TYPE health_category AS ENUM ('Brooding', 'Health', 'Vaccine', 'Management', 'Processing');
```

---

## Core: farm, houses, cycles

```sql
CREATE TABLE farms (
  id          bigserial PRIMARY KEY,
  name        text NOT NULL,
  currency    char(3) NOT NULL DEFAULT 'USD',
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE houses (
  id          bigserial PRIMARY KEY,
  farm_id     bigint NOT NULL REFERENCES farms(id) ON DELETE CASCADE,
  name        text NOT NULL,
  floor_area_m2 numeric(8,2),
  UNIQUE (farm_id, name)
);

-- One grow-out. Everything else hangs off this.
CREATE TABLE cycles (
  id              bigserial PRIMARY KEY,
  farm_id         bigint NOT NULL REFERENCES farms(id) ON DELETE CASCADE,
  house_id        bigint REFERENCES houses(id),
  label           text NOT NULL,               -- 'Cycle 12'
  breed           text,                        -- 'Ross 308'
  placed_on       date NOT NULL,
  birds_placed    integer NOT NULL CHECK (birds_placed > 0),
  target_sale_age integer NOT NULL DEFAULT 42, -- Assumptions!B9
  closed_at       timestamptz
);
```

### Assumptions snapshot — `Assumptions` sheet

Stored per cycle, never global: prices and yields change between flocks, and a closed
cycle must keep the numbers it was actually costed with.

```sql
CREATE TABLE cycle_assumptions (
  cycle_id            bigint PRIMARY KEY REFERENCES cycles(id) ON DELETE CASCADE,
  mortality_rate      numeric(5,4) NOT NULL DEFAULT 0.0500,  -- B7
  live_weight_lb      numeric(6,2) NOT NULL DEFAULT 5.50,    -- B10
  dressing_yield      numeric(5,4) NOT NULL DEFAULT 0.7200,  -- B11
  shrink_loss         numeric(5,4) NOT NULL DEFAULT 0.0200,  -- B12
  whole_bird_share    numeric(5,4) NOT NULL DEFAULT 0.4000,  -- B17
  cutup_trim_loss     numeric(5,4) NOT NULL DEFAULT 0.0300,  -- B23
  bag_size_kg         numeric(6,2) NOT NULL DEFAULT 30.00,   -- B33
  chick_cost          numeric(10,2) NOT NULL DEFAULT 1.50,   -- B39
  processing_fee      numeric(10,2) NOT NULL DEFAULT 1.25,   -- B44
  whole_packaging     numeric(10,2) NOT NULL DEFAULT 0.35,   -- B45
  cutup_labour        numeric(10,2) NOT NULL DEFAULT 0.45,   -- B46
  cutup_packaging_lb  numeric(10,2) NOT NULL DEFAULT 0.30,   -- B47
  chilling_fee        numeric(10,2) NOT NULL DEFAULT 0.15,   -- B48
  transport_fee       numeric(10,2) NOT NULL DEFAULT 0.20    -- B49
);
```

Derived values (birds sold, net saleable weight, breakeven price) are **not** stored.
They belong in views so they can never drift from their inputs:

```sql
CREATE VIEW cycle_yield AS
SELECT c.id AS cycle_id,
       (c.birds_placed * (1 - a.mortality_rate))::int AS birds_sold,
       a.live_weight_lb * a.dressing_yield * (1 - a.shrink_loss) AS net_lb_per_bird,
       (c.birds_placed * (1 - a.mortality_rate))
         * a.live_weight_lb * a.dressing_yield * (1 - a.shrink_loss) AS total_net_lb
FROM cycles c JOIN cycle_assumptions a ON a.cycle_id = c.id;
```

---

## Feed — `Feeding_Program`, `Phase_Bag_Planner`

```sql
-- Weekly intake curve, editable per cycle. Assumptions!B27:B32
CREATE TABLE feed_intake_curve (
  cycle_id    bigint NOT NULL REFERENCES cycles(id) ON DELETE CASCADE,
  week        smallint NOT NULL CHECK (week BETWEEN 1 AND 12),
  phase       feed_phase NOT NULL,
  g_per_bird_per_day numeric(6,1) NOT NULL,
  PRIMARY KEY (cycle_id, week)
);

CREATE TABLE feed_purchases (
  id            bigserial PRIMARY KEY,
  cycle_id      bigint NOT NULL REFERENCES cycles(id) ON DELETE CASCADE,
  phase         feed_phase NOT NULL,
  purchased_on  date NOT NULL,
  bags          integer NOT NULL CHECK (bags > 0),
  bag_size_kg   numeric(6,2) NOT NULL,
  cost_per_bag  numeric(10,2) NOT NULL,
  supplier      text
);

-- The checklist's "new bag opened" tick. Actual consumption, as opposed to plan.
CREATE TABLE feed_bag_openings (
  id          bigserial PRIMARY KEY,
  cycle_id    bigint NOT NULL REFERENCES cycles(id) ON DELETE CASCADE,
  opened_on   date NOT NULL,
  phase       feed_phase NOT NULL,
  bag_number  integer,
  UNIQUE (cycle_id, opened_on, bag_number)
);
```

Planned vs actual bag use is the difference between `feed_intake_curve` and
`feed_bag_openings` — that comparison drives the live FCR shown on the dashboard.

---

## Daily checklist — `Daily_Checklist`

One row per day per cycle. `birds_alive` is intentionally **not** a column: it is
derived from placements minus cumulative mortality, exactly as the spreadsheet does it,
so the count can never be edited into an inconsistent state.

```sql
CREATE TABLE daily_checks (
  id             bigserial PRIMARY KEY,
  cycle_id       bigint NOT NULL REFERENCES cycles(id) ON DELETE CASCADE,
  day_number     smallint NOT NULL CHECK (day_number > 0),
  checked_on     date NOT NULL,
  mortality      integer NOT NULL DEFAULT 0 CHECK (mortality >= 0),
  culls          integer NOT NULL DEFAULT 0 CHECK (culls >= 0),
  feed_offered_kg numeric(8,2),
  water          water_status,
  litter         litter_status,
  house_temp_c   numeric(4,1),
  light_zone     feed_phase,
  health         health_status,
  action_taken   text,
  notes          text,
  recorded_by    text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (cycle_id, day_number)
);

CREATE VIEW daily_flock AS
SELECT d.*,
       c.birds_placed
         - SUM(d.mortality + d.culls) OVER (
             PARTITION BY d.cycle_id ORDER BY d.day_number
           ) AS birds_alive
FROM daily_checks d JOIN cycles c ON c.id = d.cycle_id;

-- Sample weighing days (7, 21, 35 in the workbook's schedule)
CREATE TABLE sample_weights (
  id           bigserial PRIMARY KEY,
  cycle_id     bigint NOT NULL REFERENCES cycles(id) ON DELETE CASCADE,
  day_number   smallint NOT NULL,
  birds_sampled integer NOT NULL CHECK (birds_sampled > 0),
  avg_weight_g numeric(8,1) NOT NULL,
  UNIQUE (cycle_id, day_number)
);
```

---

## Health — `Vacc_Health`

```sql
CREATE TABLE health_tasks (
  id           bigserial PRIMARY KEY,
  cycle_id     bigint NOT NULL REFERENCES cycles(id) ON DELETE CASCADE,
  day_number   smallint NOT NULL,
  category     health_category NOT NULL,
  task         text NOT NULL,
  completed_on date,
  cost         numeric(10,2),
  quantity     text,
  notes        text
);
```

Seeded from the workbook's schedule (chick quality day 1, vitamins day 1,
Newcastle/IB day 5, weigh sample day 7, Gumboro/IBD day 14, coccidiosis review day 14,
weigh day 21, footpad/litter/ventilation review day 28, processing booking day 35,
feed withdrawal day 42). Vaccine rows carry the workbook's own caveat — confirm with
the local vet.

---

## Processing and sales mix — `Sales_Mix_Revenue`

```sql
CREATE TABLE product_lines (
  id          bigserial PRIMARY KEY,
  farm_id     bigint NOT NULL REFERENCES farms(id) ON DELETE CASCADE,
  name        text NOT NULL,          -- 'Boneless breast', 'Whole processed bird', ...
  is_whole_bird boolean NOT NULL DEFAULT false,
  sort_order  smallint NOT NULL DEFAULT 0,
  UNIQUE (farm_id, name)
);

-- Mix % and price are per cycle: both get retuned between flocks.
CREATE TABLE cycle_product_mix (
  cycle_id        bigint NOT NULL REFERENCES cycles(id) ON DELETE CASCADE,
  product_line_id bigint NOT NULL REFERENCES product_lines(id),
  mix_share       numeric(5,4),        -- share of cut-up weight; NULL for whole birds
  price_per_lb    numeric(10,2) NOT NULL,
  PRIMARY KEY (cycle_id, product_line_id)
);

CREATE TABLE processing_runs (
  id              bigserial PRIMARY KEY,
  cycle_id        bigint NOT NULL REFERENCES cycles(id) ON DELETE CASCADE,
  processed_on    date NOT NULL,
  birds_processed integer NOT NULL CHECK (birds_processed > 0),
  birds_condemned integer NOT NULL DEFAULT 0,
  live_weight_lb  numeric(10,2),
  dressed_weight_lb numeric(10,2),
  processor       text,
  lot_code        text                 -- traceability
);

-- Actual weight out, per line, per run — the counterweight to the planned mix.
CREATE TABLE processing_outputs (
  id              bigserial PRIMARY KEY,
  run_id          bigint NOT NULL REFERENCES processing_runs(id) ON DELETE CASCADE,
  product_line_id bigint NOT NULL REFERENCES product_lines(id),
  weight_lb       numeric(10,2) NOT NULL,
  units           integer,             -- whole birds packed
  UNIQUE (run_id, product_line_id)
);
```

A cut-up mix must sum to 100%; enforce it on write rather than trusting the UI:

```sql
CREATE OR REPLACE FUNCTION assert_mix_sums_to_one() RETURNS trigger AS $$
BEGIN
  IF (SELECT COALESCE(SUM(mix_share), 0) FROM cycle_product_mix
      WHERE cycle_id = NEW.cycle_id AND mix_share IS NOT NULL) > 1.0001 THEN
    RAISE EXCEPTION 'cut-up mix for cycle % exceeds 100%%', NEW.cycle_id;
  END IF;
  RETURN NEW;
END; $$ LANGUAGE plpgsql;
```

---

## Costs and assets

```sql
CREATE TABLE cost_lines (
  id         bigserial PRIMARY KEY,
  cycle_id   bigint NOT NULL REFERENCES cycles(id) ON DELETE CASCADE,
  category   text NOT NULL,   -- 'Feed', 'Chicks', 'Labour', 'Bedding', ...
  amount     numeric(12,2) NOT NULL,
  driver     text,            -- 'sold birds x processing fee'
  incurred_on date
);

CREATE TABLE assets (
  id             bigserial PRIMARY KEY,
  farm_id        bigint NOT NULL REFERENCES farms(id) ON DELETE CASCADE,
  name           text NOT NULL,
  category       text,         -- brooder, feeder, drinker, chiller, vehicle, house
  purchased_on   date,
  purchase_cost  numeric(12,2),
  expected_life_years numeric(4,1),
  last_serviced_on date,
  next_service_due date,
  status         text NOT NULL DEFAULT 'active'
);

CREATE INDEX ON assets (farm_id, next_service_due)
  WHERE status = 'active';
```

---

## Phase 2 — invoicing and sales

```sql
CREATE TABLE customers (
  id       bigserial PRIMARY KEY,
  farm_id  bigint NOT NULL REFERENCES farms(id) ON DELETE CASCADE,
  name     text NOT NULL,
  email    text,
  phone    text,
  payment_terms_days smallint NOT NULL DEFAULT 30
);

CREATE TABLE invoices (
  id           bigserial PRIMARY KEY,
  farm_id      bigint NOT NULL REFERENCES farms(id) ON DELETE CASCADE,
  customer_id  bigint NOT NULL REFERENCES customers(id),
  run_id       bigint REFERENCES processing_runs(id),
  number       text NOT NULL,
  issued_on    date NOT NULL,
  due_on       date NOT NULL,
  status       text NOT NULL DEFAULT 'draft',   -- draft|sent|part_paid|paid|void
  UNIQUE (farm_id, number)
);

CREATE TABLE invoice_lines (
  id              bigserial PRIMARY KEY,
  invoice_id      bigint NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  product_line_id bigint REFERENCES product_lines(id),
  description     text NOT NULL,
  quantity_lb     numeric(10,2),
  units           integer,
  unit_price      numeric(10,2) NOT NULL,
  line_total      numeric(12,2) NOT NULL
);

CREATE TABLE payments (
  id          bigserial PRIMARY KEY,
  invoice_id  bigint NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  paid_on     date NOT NULL,
  amount      numeric(12,2) NOT NULL CHECK (amount > 0),
  method      text
);
```

Ageing (30/60/90) is a view over `invoices` and `payments`, not a stored column.

---

## Phase 3 — AI follow-up on unpaid invoices

The important design constraint: **nothing sends without human approval.** The AI writes
a draft; a person releases it. That is enforced by the schema, not only the UI.

```sql
CREATE TABLE invoice_followups (
  id            bigserial PRIMARY KEY,
  invoice_id    bigint NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  drafted_at    timestamptz NOT NULL DEFAULT now(),
  channel       text NOT NULL,          -- email | sms
  subject       text,
  body          text NOT NULL,
  model         text,                   -- which model drafted it
  status        text NOT NULL DEFAULT 'pending_approval',
                                        -- pending_approval|approved|sent|declined
  approved_by   text,
  approved_at   timestamptz,
  sent_at       timestamptz,

  CONSTRAINT approval_required_before_send
    CHECK (sent_at IS NULL OR (approved_by IS NOT NULL AND approved_at IS NOT NULL))
);
```

---

## Import path from the workbook

| Sheet | Target |
|---|---|
| `Assumptions` | `cycles`, `cycle_assumptions`, `feed_intake_curve`, `cycle_product_mix` |
| `Feeding_Program` | derived — a view over `feed_intake_curve` and `daily_flock` |
| `Phase_Bag_Planner` | derived — plan side; actuals land in `feed_purchases` |
| `Sales_Mix_Revenue` | `product_lines`, `cycle_product_mix`, `cost_lines` |
| `Daily_Checklist` | `daily_checks` |
| `Vacc_Health` | `health_tasks` |
| `Overview` | derived — views only, nothing stored |

Anything the workbook computes with a formula becomes a view. Only inputs are stored.
