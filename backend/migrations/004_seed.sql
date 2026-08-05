-- =============================================================================
-- Roost — 004 seed
-- The farm, its product lines, and cycle 12 loaded with the exact assumptions
-- from broiler_whole_and_parts_planner.xlsx.
--
-- The point of seeding real values is that the final query in this file should
-- reproduce the spreadsheet's own answer. If it does, the schema is faithful and
-- you can trust the app. If it doesn't, something is wrong and better found now.
-- =============================================================================

do $$
declare
  v_farm_id  bigint;
  v_house_id bigint;
  v_cycle_id bigint;
begin

  -- ---------- Farm and house ----------
  insert into farms (name, currency, weight_unit)
  values ('Our Farm', 'USD', 'lb')
  returning id into v_farm_id;

  insert into houses (farm_id, name)
  values (v_farm_id, 'House A')
  returning id into v_house_id;


  -- ---------- Product lines (Sales_Mix_Revenue) ----------
  insert into product_lines (farm_id, name, is_whole_bird, sort_order) values
    (v_farm_id, 'Whole processed bird', true,  1),
    (v_farm_id, 'Boneless breast',      false, 2),
    (v_farm_id, 'Leg quarters',         false, 3),
    (v_farm_id, 'Breast quarters',      false, 4),
    (v_farm_id, 'Wings',                false, 5),
    (v_farm_id, 'Backs',                false, 6),
    (v_farm_id, 'Giblets',              false, 7),
    (v_farm_id, 'Necks',                false, 8);


  -- ---------- Cycle ----------
  insert into cycles (farm_id, house_id, label, breed, placed_on, birds_placed, target_sale_age)
  values (v_farm_id, v_house_id, 'Cycle 12', 'Ross 308', current_date - 38, 1500, 42)
  returning id into v_cycle_id;

  -- Straight from the Assumptions sheet.
  insert into cycle_assumptions (
    cycle_id,
    mortality_rate, live_weight_lb, dressing_yield, shrink_loss,
    whole_bird_share, cutup_trim_loss, bag_size_kg,
    chick_cost, processing_fee, whole_packaging, cutup_labour,
    cutup_packaging_lb, chilling_fee, transport_fee,
    bedding_cost, utilities_cost, labour_cost, medication_cost, misc_cost,
    starter_bag_cost, grower_bag_cost, finisher_bag_cost
  ) values (
    v_cycle_id,
    0.0500, 5.50, 0.7200, 0.0200,
    0.4000, 0.0300, 30.00,
    1.50, 1.25, 0.35, 0.45,
    0.30, 0.15, 0.20,
    150.00, 120.00, 350.00, 125.00, 100.00,
    57.50, 55.50, 54.50
  );

  -- Weekly intake curve (Assumptions B27:B32).
  insert into feed_intake_curve (cycle_id, week, phase, g_per_bird_per_day) values
    (v_cycle_id, 1, 'Starter',   25),
    (v_cycle_id, 2, 'Starter',   50),
    (v_cycle_id, 3, 'Grower',    90),
    (v_cycle_id, 4, 'Grower',   130),
    (v_cycle_id, 5, 'Finisher', 170),
    (v_cycle_id, 6, 'Finisher', 200);

  -- Sales mix and price list. Cut-up shares total exactly 1.0000.
  insert into cycle_product_mix (cycle_id, product_line_id, mix_share, price_per_lb)
  select v_cycle_id, pl.id,
         case pl.name
           when 'Whole processed bird' then null
           when 'Boneless breast'      then 0.3000
           when 'Leg quarters'         then 0.2800
           when 'Breast quarters'      then 0.1500
           when 'Wings'                then 0.1000
           when 'Backs'                then 0.0800
           when 'Giblets'              then 0.0600
           when 'Necks'                then 0.0300
         end,
         case pl.name
           when 'Whole processed bird' then 3.25
           when 'Boneless breast'      then 6.00
           when 'Leg quarters'         then 2.25
           when 'Breast quarters'      then 3.15
           when 'Wings'                then 3.25
           when 'Backs'                then 1.20
           when 'Giblets'              then 1.80
           when 'Necks'                then 1.10
         end
  from product_lines pl
  where pl.farm_id = v_farm_id;

  -- Health and vaccination schedule (Vacc_Health). Vaccine rows keep the
  -- workbook's own caveat rather than presenting local practice as settled.
  insert into health_tasks (cycle_id, day_number, category, task, notes) values
    (v_cycle_id,  1, 'Brooding',   'Check chick quality on arrival', null),
    (v_cycle_id,  1, 'Health',     'Start vitamins / glucose', null),
    (v_cycle_id,  5, 'Vaccine',    'Newcastle / IB if used locally', 'Confirm with local vet'),
    (v_cycle_id,  7, 'Management', 'Weigh sample birds', null),
    (v_cycle_id, 14, 'Vaccine',    'Gumboro / IBD if used locally', 'Confirm with local vet'),
    (v_cycle_id, 14, 'Health',     'Review coccidiosis prevention', null),
    (v_cycle_id, 21, 'Management', 'Weigh sample birds', null),
    (v_cycle_id, 28, 'Health',     'Review footpad, litter, ventilation', null),
    (v_cycle_id, 35, 'Management', 'Check processing booking', null),
    (v_cycle_id, 42, 'Processing', 'Withdraw feed per processor guidance', null);

  raise notice 'Seeded farm % / cycle %', v_farm_id, v_cycle_id;
end $$;


-- =============================================================================
-- CLAIM OWNERSHIP
-- Sign up in the app FIRST, then run this once. It makes your account the owner
-- of the farm. Replace the address if you sign up with a different one.
-- =============================================================================

-- insert into farm_members (farm_id, user_id, role)
-- select f.id, u.id, 'owner'
-- from farms f
-- cross join auth.users u
-- where f.name = 'Our Farm'
--   and u.email = 'raymonddmorris@gmail.com'
-- on conflict (farm_id, user_id) do update set role = 'owner';

-- To add family members, invite them BEFORE they sign up:
-- insert into farm_invites (farm_id, email, role)
-- select id, 'someone@example.com', 'member' from farms where name = 'Our Farm';


-- =============================================================================
-- SELF-TEST
-- Run this last. It must match the spreadsheet, to the cent.
--
--   revenue             18339.82
--   total_cost          19450.31
--   operating_profit    -1110.49      <- the cycle loses money
--   blended_price_lb        3.32
--   breakeven_price_lb      3.52
--   fcr                     1.90      <- against a 1.55-1.65 breed objective
--   total_feed_kg        6752.2
--   total_bags            227          <- see note below
--
-- Note on bags: the sheet rounds each phase separately (26 + 76 + 125 = 227).
-- An earlier hand-calculation of mine said 226 by rounding the total instead.
-- 227 is correct — you cannot buy four fifths of a sack of starter.
-- =============================================================================

select
  label,
  birds_sold,
  round(total_net_lb, 1)        as net_lb,
  round(total_feed_kg, 1)       as feed_kg,
  total_bags,
  round(revenue, 2)             as revenue,
  round(total_cost, 2)          as total_cost,
  round(operating_profit, 2)    as operating_profit,
  round(margin * 100, 2)        as margin_pct,
  round(blended_price_lb, 3)    as blended_price_lb,
  round(breakeven_price_lb, 3)  as breakeven_price_lb,
  round(fcr, 3)                 as fcr
from v_cycle_pnl;
