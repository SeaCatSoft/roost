-- =============================================================================
-- Roost — 005 cycle management
--
-- Starting a cycle touches five tables: the cycle, its assumptions, the feed
-- intake curve, the product mix and the health schedule. Doing that as five
-- round trips from a browser risks a half-created cycle if any one fails, so it
-- happens here in one transaction instead.
--
-- These are SECURITY INVOKER (the default) on purpose: they run as the caller,
-- so the row-level security from 003 still applies. A function that bypassed it
-- would be a hole straight through everything.
-- =============================================================================


-- ---------- Close a cycle without losing it ---------------------------------
create or replace function public.archive_cycle(p_cycle_id bigint)
returns void
language plpgsql
as $$
begin
  update cycles set closed_at = now()
  where id = p_cycle_id and closed_at is null;

  if not found then
    raise exception 'Cycle % is not open, or you do not have access to it', p_cycle_id;
  end if;
end $$;


-- ---------- Delete a cycle and everything under it --------------------------
-- Irreversible. Every foreign key into a cycle is ON DELETE CASCADE, so this
-- takes the daily checks, bag openings, sample weights, health tasks,
-- processing runs and product mix with it.
create or replace function public.delete_cycle(p_cycle_id bigint)
returns void
language plpgsql
as $$
declare
  v_deleted bigint;
begin
  delete from cycles where id = p_cycle_id returning id into v_deleted;

  if v_deleted is null then
    raise exception 'Cycle % not found, or you do not have access to it', p_cycle_id;
  end if;
end $$;


-- ---------- Start a cycle ----------------------------------------------------
-- Clones assumptions, intake curve, product mix and health schedule from the
-- most recent cycle on the same farm, so last flock's tuning carries forward
-- rather than resetting to defaults every time. Falls back to the table
-- defaults on the very first cycle.
create or replace function public.start_new_cycle(
  p_farm_id      bigint,
  p_label        text,
  p_birds_placed integer,
  p_placed_on    date default current_date,
  p_breed        text default null,
  p_target_age   integer default 42,
  p_house_id     bigint default null
)
returns bigint
language plpgsql
as $$
declare
  v_new_id  bigint;
  v_prev_id bigint;
  v_house   bigint;
begin
  if p_birds_placed is null or p_birds_placed <= 0 then
    raise exception 'Birds placed must be a positive number';
  end if;

  -- Most recent cycle on this farm, whatever its state, as the template.
  select id into v_prev_id
  from cycles
  where farm_id = p_farm_id
  order by placed_on desc, id desc
  limit 1;

  v_house := coalesce(
    p_house_id,
    (select house_id from cycles where id = v_prev_id),
    (select id from houses where farm_id = p_farm_id order by id limit 1)
  );

  insert into cycles (farm_id, house_id, label, breed, placed_on, birds_placed, target_sale_age)
  values (
    p_farm_id,
    v_house,
    p_label,
    coalesce(p_breed, (select breed from cycles where id = v_prev_id)),
    p_placed_on,
    p_birds_placed,
    coalesce(p_target_age, 42)
  )
  returning id into v_new_id;

  -- Assumptions: carry forward, or fall back to the column defaults.
  if v_prev_id is not null then
    insert into cycle_assumptions
    select v_new_id, mortality_rate, live_weight_lb, dressing_yield, shrink_loss,
           whole_bird_share, cutup_trim_loss, bag_size_kg,
           chick_cost, processing_fee, whole_packaging, cutup_labour,
           cutup_packaging_lb, chilling_fee, transport_fee,
           bedding_cost, utilities_cost, labour_cost, medication_cost, misc_cost,
           starter_bag_cost, grower_bag_cost, finisher_bag_cost
    from cycle_assumptions where cycle_id = v_prev_id;
  else
    insert into cycle_assumptions (cycle_id) values (v_new_id);
  end if;

  -- Feed intake curve.
  if exists (select 1 from feed_intake_curve where cycle_id = v_prev_id) then
    insert into feed_intake_curve (cycle_id, week, phase, g_per_bird_per_day)
    select v_new_id, week, phase, g_per_bird_per_day
    from feed_intake_curve where cycle_id = v_prev_id;
  else
    insert into feed_intake_curve (cycle_id, week, phase, g_per_bird_per_day) values
      (v_new_id, 1, 'Starter',   25), (v_new_id, 2, 'Starter',   50),
      (v_new_id, 3, 'Grower',    90), (v_new_id, 4, 'Grower',   130),
      (v_new_id, 5, 'Finisher', 170), (v_new_id, 6, 'Finisher', 200);
  end if;

  -- Product mix and price list.
  if exists (select 1 from cycle_product_mix where cycle_id = v_prev_id) then
    insert into cycle_product_mix (cycle_id, product_line_id, mix_share, price_per_lb)
    select v_new_id, product_line_id, mix_share, price_per_lb
    from cycle_product_mix where cycle_id = v_prev_id;
  end if;

  -- Health schedule, with completion reset — the tasks carry over, not the ticks.
  if exists (select 1 from health_tasks where cycle_id = v_prev_id) then
    insert into health_tasks (cycle_id, day_number, category, task, notes)
    select v_new_id, day_number, category, task, notes
    from health_tasks where cycle_id = v_prev_id;
  else
    insert into health_tasks (cycle_id, day_number, category, task, notes) values
      (v_new_id,  1, 'Brooding',   'Check chick quality on arrival', null),
      (v_new_id,  1, 'Health',     'Start vitamins / glucose', null),
      (v_new_id,  5, 'Vaccine',    'Newcastle / IB if used locally', 'Confirm with local vet'),
      (v_new_id,  7, 'Management', 'Weigh sample birds', null),
      (v_new_id, 14, 'Vaccine',    'Gumboro / IBD if used locally', 'Confirm with local vet'),
      (v_new_id, 14, 'Health',     'Review coccidiosis prevention', null),
      (v_new_id, 21, 'Management', 'Weigh sample birds', null),
      (v_new_id, 28, 'Health',     'Review footpad, litter, ventilation', null),
      (v_new_id, 35, 'Management', 'Check processing booking', null),
      (v_new_id, 42, 'Processing', 'Withdraw feed per processor guidance', null);
  end if;

  return v_new_id;
end $$;


-- ---------- Next sensible label ----------------------------------------------
-- "Cycle 12" -> "Cycle 13". Falls back to a count when the existing labels do
-- not end in a number.
create or replace function public.suggest_cycle_label(p_farm_id bigint)
returns text
language plpgsql stable
as $$
declare
  v_last text;
  v_num  integer;
begin
  select label into v_last
  from cycles where farm_id = p_farm_id
  order by placed_on desc, id desc limit 1;

  if v_last is null then
    return 'Cycle 1';
  end if;

  v_num := nullif(regexp_replace(v_last, '^.*?(\d+)\s*$', '\1'), v_last)::integer;

  if v_num is null then
    return 'Cycle ' || ((select count(*) from cycles where farm_id = p_farm_id) + 1);
  end if;

  return regexp_replace(v_last, '\d+\s*$', '') || (v_num + 1);
end $$;
