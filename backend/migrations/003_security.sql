-- =============================================================================
-- Roost — 003 row-level security
--
-- READ THIS BEFORE SKIPPING ANY OF IT.
--
-- The Supabase anon key is embedded in the page and is public by design. It is
-- safe ONLY because these policies decide what it can reach. A table with RLS
-- left off is a table anyone on the internet can read and write. There is no
-- second line of defence.
--
-- Enabling RLS with no policy denies everything by default, which is the right
-- failure mode: a table you forget is locked, not exposed.
-- =============================================================================


-- ---------- Access helpers ---------------------------------------------------
-- security definer so that checking membership does not itself trigger RLS on
-- farm_members, which would recurse forever.

create or replace function public.is_farm_member(p_farm_id bigint)
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (
    select 1 from farm_members
    where farm_id = p_farm_id and user_id = auth.uid()
  );
$$;

create or replace function public.is_farm_owner(p_farm_id bigint)
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (
    select 1 from farm_members
    where farm_id = p_farm_id and user_id = auth.uid() and role = 'owner'
  );
$$;

-- Most tables hang off a cycle rather than carrying farm_id directly.
create or replace function public.can_access_cycle(p_cycle_id bigint)
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (
    select 1 from cycles c
    join farm_members m on m.farm_id = c.farm_id
    where c.id = p_cycle_id and m.user_id = auth.uid()
  );
$$;


-- ---------- Invitations ------------------------------------------------------
-- Family members join by being invited by email beforehand. Without this, the
-- only alternatives are running SQL by hand for every new person, or letting
-- anyone who signs up walk into the farm.

create table farm_invites (
  id          bigint generated always as identity primary key,
  farm_id     bigint not null references farms(id) on delete cascade,
  email       text not null,
  role        member_role not null default 'member',
  invited_by  uuid references auth.users(id) on delete set null,
  created_at  timestamptz not null default now(),
  accepted_at timestamptz,
  unique (farm_id, email)
);

-- When someone signs up, they are admitted only if their address was invited.
create or replace function public.accept_invite_on_signup()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  insert into farm_members (farm_id, user_id, role)
  select i.farm_id, new.id, i.role
  from farm_invites i
  where lower(i.email) = lower(new.email)
    and i.accepted_at is null
  on conflict (farm_id, user_id) do nothing;

  update farm_invites
  set accepted_at = now()
  where lower(email) = lower(new.email) and accepted_at is null;

  return new;
end $$;

create trigger trg_accept_invite
  after insert on auth.users
  for each row execute function public.accept_invite_on_signup();


-- ---------- Turn RLS on everywhere -------------------------------------------

alter table farms              enable row level security;
alter table farm_members       enable row level security;
alter table farm_invites       enable row level security;
alter table houses             enable row level security;
alter table cycles             enable row level security;
alter table cycle_assumptions  enable row level security;
alter table feed_intake_curve  enable row level security;
alter table feed_purchases     enable row level security;
alter table feed_bag_openings  enable row level security;
alter table daily_checks       enable row level security;
alter table sample_weights     enable row level security;
alter table health_tasks       enable row level security;
alter table product_lines      enable row level security;
alter table cycle_product_mix  enable row level security;
alter table processing_runs    enable row level security;
alter table processing_outputs enable row level security;
alter table cost_lines         enable row level security;
alter table assets             enable row level security;


-- ---------- Farm, membership, invites ----------------------------------------

create policy farms_read on farms
  for select using (is_farm_member(id));
create policy farms_write on farms
  for update using (is_farm_owner(id)) with check (is_farm_owner(id));

-- Members see the roster; only an owner changes it.
create policy members_read on farm_members
  for select using (is_farm_member(farm_id));
create policy members_manage on farm_members
  for all using (is_farm_owner(farm_id)) with check (is_farm_owner(farm_id));

create policy invites_read on farm_invites
  for select using (is_farm_member(farm_id));
create policy invites_manage on farm_invites
  for all using (is_farm_owner(farm_id)) with check (is_farm_owner(farm_id));


-- ---------- Farm-scoped tables -----------------------------------------------
-- One readable policy per table. `using` governs which rows are visible to
-- read/update/delete; `with check` governs what may be written — both are
-- required, or a member could insert rows onto someone else's farm.

create policy houses_all on houses
  for all using (is_farm_member(farm_id)) with check (is_farm_member(farm_id));

create policy cycles_all on cycles
  for all using (is_farm_member(farm_id)) with check (is_farm_member(farm_id));

create policy feed_purchases_all on feed_purchases
  for all using (is_farm_member(farm_id)) with check (is_farm_member(farm_id));

create policy product_lines_all on product_lines
  for all using (is_farm_member(farm_id)) with check (is_farm_member(farm_id));

create policy cost_lines_all on cost_lines
  for all using (is_farm_member(farm_id)) with check (is_farm_member(farm_id));

create policy assets_all on assets
  for all using (is_farm_member(farm_id)) with check (is_farm_member(farm_id));


-- ---------- Cycle-scoped tables ----------------------------------------------

create policy cycle_assumptions_all on cycle_assumptions
  for all using (can_access_cycle(cycle_id)) with check (can_access_cycle(cycle_id));

create policy feed_intake_curve_all on feed_intake_curve
  for all using (can_access_cycle(cycle_id)) with check (can_access_cycle(cycle_id));

create policy feed_bag_openings_all on feed_bag_openings
  for all using (can_access_cycle(cycle_id)) with check (can_access_cycle(cycle_id));

create policy daily_checks_all on daily_checks
  for all using (can_access_cycle(cycle_id)) with check (can_access_cycle(cycle_id));

create policy sample_weights_all on sample_weights
  for all using (can_access_cycle(cycle_id)) with check (can_access_cycle(cycle_id));

create policy health_tasks_all on health_tasks
  for all using (can_access_cycle(cycle_id)) with check (can_access_cycle(cycle_id));

create policy cycle_product_mix_all on cycle_product_mix
  for all using (can_access_cycle(cycle_id)) with check (can_access_cycle(cycle_id));

create policy processing_runs_all on processing_runs
  for all using (can_access_cycle(cycle_id)) with check (can_access_cycle(cycle_id));

-- Two hops: output -> run -> cycle -> farm.
create policy processing_outputs_all on processing_outputs
  for all using (
    exists (select 1 from processing_runs r
            where r.id = run_id and can_access_cycle(r.cycle_id))
  ) with check (
    exists (select 1 from processing_runs r
            where r.id = run_id and can_access_cycle(r.cycle_id))
  );


-- ---------- Verification -----------------------------------------------------
-- Run this after applying. Every row must say true. A false is a hole.

-- select tablename, rowsecurity as rls_on
-- from pg_tables
-- where schemaname = 'public'
-- order by rowsecurity, tablename;

-- And confirm no view leaks past RLS — all must be security_invoker:
-- select c.relname, c.reloptions
-- from pg_class c join pg_namespace n on n.oid = c.relnamespace
-- where n.nspname = 'public' and c.relkind = 'v';
