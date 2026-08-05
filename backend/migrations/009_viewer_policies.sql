-- =============================================================================
-- Roost — 009 viewer role, part two
--
-- Run 008 first, on its own.
--
-- Until now every table used one policy for everything: a member could read and
-- write. A viewer needs those split — read for anyone on the farm, write only
-- for owners and members.
--
-- The policies are generated in a loop rather than written out sixty times.
-- Hand-writing four policies across fifteen tables is exactly how one gets
-- missed, and a missed write policy is either a lockout or a hole.
-- =============================================================================


-- ---------- Who may change things -------------------------------------------
create or replace function public.is_farm_editor(p_farm_id bigint)
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (
    select 1 from farm_members
    where farm_id = p_farm_id
      and user_id = auth.uid()
      and role in ('owner', 'member')
  );
$$;

create or replace function public.can_edit_cycle(p_cycle_id bigint)
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (
    select 1 from cycles c
    join farm_members m on m.farm_id = c.farm_id
    where c.id = p_cycle_id
      and m.user_id = auth.uid()
      and m.role in ('owner', 'member')
  );
$$;

-- The caller's own role, for screens that want to present themselves read-only
-- rather than letting a viewer fill in a form that the database will reject.
create or replace function public.my_role()
returns member_role
language sql stable security definer set search_path = public
as $$
  select role from farm_members where user_id = auth.uid() limit 1;
$$;


-- ---------- Farm-scoped tables ------------------------------------------------
do $$
declare
  t text;
begin
  foreach t in array array[
    'houses', 'cycles', 'feed_purchases', 'product_lines', 'cost_lines', 'assets'
  ] loop
    execute format('drop policy if exists %I on %I', t || '_all', t);
    execute format('drop policy if exists %I on %I', t || '_read', t);
    execute format('drop policy if exists %I on %I', t || '_insert', t);
    execute format('drop policy if exists %I on %I', t || '_update', t);
    execute format('drop policy if exists %I on %I', t || '_delete', t);

    execute format(
      'create policy %I on %I for select using (is_farm_member(farm_id))', t || '_read', t);
    execute format(
      'create policy %I on %I for insert with check (is_farm_editor(farm_id))', t || '_insert', t);
    execute format(
      'create policy %I on %I for update using (is_farm_editor(farm_id)) with check (is_farm_editor(farm_id))',
      t || '_update', t);
    execute format(
      'create policy %I on %I for delete using (is_farm_editor(farm_id))', t || '_delete', t);
  end loop;
end $$;


-- ---------- Cycle-scoped tables -----------------------------------------------
do $$
declare
  t text;
begin
  foreach t in array array[
    'cycle_assumptions', 'feed_intake_curve', 'feed_bag_openings', 'daily_checks',
    'sample_weights', 'health_tasks', 'cycle_product_mix', 'processing_runs'
  ] loop
    execute format('drop policy if exists %I on %I', t || '_all', t);
    execute format('drop policy if exists %I on %I', t || '_read', t);
    execute format('drop policy if exists %I on %I', t || '_insert', t);
    execute format('drop policy if exists %I on %I', t || '_update', t);
    execute format('drop policy if exists %I on %I', t || '_delete', t);

    execute format(
      'create policy %I on %I for select using (can_access_cycle(cycle_id))', t || '_read', t);
    execute format(
      'create policy %I on %I for insert with check (can_edit_cycle(cycle_id))', t || '_insert', t);
    execute format(
      'create policy %I on %I for update using (can_edit_cycle(cycle_id)) with check (can_edit_cycle(cycle_id))',
      t || '_update', t);
    execute format(
      'create policy %I on %I for delete using (can_edit_cycle(cycle_id))', t || '_delete', t);
  end loop;
end $$;


-- ---------- processing_outputs, which hangs off a run -------------------------
drop policy if exists processing_outputs_all    on processing_outputs;
drop policy if exists processing_outputs_read   on processing_outputs;
drop policy if exists processing_outputs_insert on processing_outputs;
drop policy if exists processing_outputs_update on processing_outputs;
drop policy if exists processing_outputs_delete on processing_outputs;

create policy processing_outputs_read on processing_outputs
  for select using (
    exists (select 1 from processing_runs r where r.id = run_id and can_access_cycle(r.cycle_id))
  );
create policy processing_outputs_insert on processing_outputs
  for insert with check (
    exists (select 1 from processing_runs r where r.id = run_id and can_edit_cycle(r.cycle_id))
  );
create policy processing_outputs_update on processing_outputs
  for update using (
    exists (select 1 from processing_runs r where r.id = run_id and can_edit_cycle(r.cycle_id))
  ) with check (
    exists (select 1 from processing_runs r where r.id = run_id and can_edit_cycle(r.cycle_id))
  );
create policy processing_outputs_delete on processing_outputs
  for delete using (
    exists (select 1 from processing_runs r where r.id = run_id and can_edit_cycle(r.cycle_id))
  );


-- ---------- The farm record itself --------------------------------------------
-- Reading stays open to any member; only an owner edits. Unchanged, restated
-- here so the whole access model is visible in one file.
drop policy if exists farms_read  on farms;
drop policy if exists farms_write on farms;

create policy farms_read on farms for select using (is_farm_member(id));
create policy farms_write on farms for update
  using (is_farm_owner(id)) with check (is_farm_owner(id));


-- =============================================================================
-- CHECK IT WORKED
--
-- Every table should now show four policies, and no table should still have an
-- "_all" policy left behind.
--
--   select tablename, policyname, cmd
--   from pg_policies
--   where schemaname = 'public'
--   order by tablename, cmd;
--
--   select tablename, count(*) from pg_policies
--   where schemaname = 'public' and policyname like '%\_all'
--   group by tablename;      -- expect zero rows
-- =============================================================================
