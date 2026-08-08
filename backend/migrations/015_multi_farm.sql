-- =============================================================================
-- Roost — 015 more than one farm, and a choice about assumptions
--
-- Two changes that happen to touch the same places.
--
-- 1. The schema has always been multi-tenant — every table carries a farm_id
--    and every policy checks membership — but there was no way to create a
--    second farm. Signing up did nothing at all unless someone had already
--    invited that address. Now a person who signs up with a farm name gets
--    their own farm and owns it; an invited person still joins the farm that
--    invited them, and the farm name they typed is ignored rather than
--    silently creating a duplicate farm alongside the one they were invited to.
--
-- 2. start_new_cycle always cloned the previous cycle's assumptions. That is
--    usually right, but not when prices or costs have moved enough that last
--    cycle's figures are misleading. It now takes a choice.
-- =============================================================================


-- ---------- Name the existing farm --------------------------------------------
-- 004 seeded it as 'Our Farm', which was a placeholder from before anyone had
-- said what it was called. Every existing member belongs to it already, so
-- renaming is all that is needed — no memberships move.
update farms set name = 'Goddard''s Farm' where name = 'Our Farm';


-- ---------- Signing up ---------------------------------------------------------
-- Replaces the version from 003. That one admitted invited people and did
-- nothing for anyone else, which was the correct behaviour when a single farm
-- was the only farm.
create or replace function public.accept_invite_on_signup()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare
  v_farm_name text;
  v_farm_id   bigint;
  v_house_id  bigint;
  v_invited   boolean;
begin
  -- An invitation always wins. Someone invited to a farm joins that farm even
  -- if they typed a farm name on the way in, because two owners each thinking
  -- they are on the same farm while looking at different data is the worst
  -- possible outcome here.
  insert into farm_members (farm_id, user_id, role)
  select i.farm_id, new.id, i.role
  from farm_invites i
  where lower(i.email) = lower(new.email)
    and i.accepted_at is null
  on conflict (farm_id, user_id) do nothing;

  update farm_invites
  set accepted_at = now()
  where lower(email) = lower(new.email) and accepted_at is null;

  select exists (select 1 from farm_members where user_id = new.id)
  into v_invited;

  if v_invited then
    return new;
  end if;

  -- Not invited. A farm name means they are starting their own; no farm name
  -- still means an account with access to nothing, exactly as before, so a
  -- stray sign-up cannot wander into anyone's data.
  v_farm_name := nullif(trim(new.raw_user_meta_data ->> 'farm_name'), '');
  if v_farm_name is null then
    return new;
  end if;

  insert into farms (name) values (v_farm_name) returning id into v_farm_id;

  insert into farm_members (farm_id, user_id, role)
  values (v_farm_id, new.id, 'owner');

  -- A house and a price list, so the first cycle has somewhere to go and the
  -- invoice and processing screens are not empty on day one. These are
  -- ordinary rows the owner can rename or delete.
  insert into houses (farm_id, name) values (v_farm_id, 'House A')
  returning id into v_house_id;

  insert into product_lines (farm_id, name, is_whole_bird, sort_order) values
    (v_farm_id, 'Whole processed bird', true,  1),
    (v_farm_id, 'Boneless breast',      false, 2),
    (v_farm_id, 'Leg quarters',         false, 3),
    (v_farm_id, 'Breast quarters',      false, 4),
    (v_farm_id, 'Wings',                false, 5),
    (v_farm_id, 'Backs',                false, 6),
    (v_farm_id, 'Giblets',              false, 7),
    (v_farm_id, 'Necks',                false, 8);

  return new;
end $$;


-- ---------- Starting a cycle ---------------------------------------------------
-- The old signature is dropped rather than left alongside the new one: two
-- functions of the same name differing only by a defaulted argument makes the
-- call ambiguous through PostgREST, which fails at the worst moment with a
-- message about no matching function.
drop function if exists public.start_new_cycle(bigint, text, integer, date, text, integer, bigint);

create or replace function public.start_new_cycle(
  p_farm_id      bigint,
  p_label        text,
  p_birds_placed integer,
  p_placed_on    date default current_date,
  p_breed        text default null,
  p_target_age   integer default 42,
  p_house_id     bigint default null,
  p_carry_over   boolean default true
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
  -- Starting from scratch simply declines to look at it.
  if coalesce(p_carry_over, true) then
    select id into v_prev_id
    from cycles
    where farm_id = p_farm_id
    order by placed_on desc, id desc
    limit 1;
  end if;

  -- The house is not an assumption — it is where the birds physically are, so
  -- it is found regardless of the choice above.
  v_house := coalesce(
    p_house_id,
    (select house_id from cycles
      where farm_id = p_farm_id order by placed_on desc, id desc limit 1),
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

  -- Product mix and price list. Starting from scratch leaves this empty on
  -- purpose: an invented price list is worse than an obviously missing one.
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


-- =============================================================================
-- CHECK IT WORKED
--   select id, name from farms;                 -- Goddard's Farm
--   select to_regprocedure(
--     'public.start_new_cycle(bigint,text,integer,date,text,integer,bigint,boolean)'
--   ) is not null as start_new_cycle_takes_a_choice;
-- =============================================================================
