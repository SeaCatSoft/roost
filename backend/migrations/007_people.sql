-- =============================================================================
-- Roost — 007 people
--
-- auth.users is not exposed through the API, so a member's email cannot be
-- read by joining to it from the browser. These functions are SECURITY DEFINER
-- to reach it — which means they bypass row-level security, so every one of
-- them re-checks membership by hand. A definer function without that check is
-- an open door to every email address in the project.
--
-- They also refuse to strand the farm: the last owner cannot be demoted or
-- removed, because there would then be nobody able to manage people again.
-- =============================================================================


-- ---------- Who is on the farm ------------------------------------------------
create or replace function public.farm_people(p_farm_id bigint)
returns table (
  user_id      uuid,
  email        text,
  role         member_role,
  joined_at    timestamptz,
  is_you       boolean
)
language sql stable security definer set search_path = public, auth
as $$
  select
    m.user_id,
    u.email::text,
    m.role,
    m.created_at,
    (m.user_id = auth.uid())
  from farm_members m
  join auth.users u on u.id = m.user_id
  where m.farm_id = p_farm_id
    -- Membership check, by hand, because definer skipped RLS.
    and exists (
      select 1 from farm_members me
      where me.farm_id = p_farm_id and me.user_id = auth.uid()
    )
  order by m.role, u.email;
$$;


-- ---------- Invite someone ----------------------------------------------------
create or replace function public.invite_person(
  p_farm_id bigint,
  p_email   text,
  p_role    member_role default 'member'
)
returns bigint
language plpgsql security definer set search_path = public, auth
as $$
declare
  v_id bigint;
  v_email text := lower(trim(p_email));
begin
  if not is_farm_owner(p_farm_id) then
    raise exception 'Only an owner can invite people';
  end if;

  if v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
    raise exception 'That does not look like an email address';
  end if;

  if exists (
    select 1 from farm_members m
    join auth.users u on u.id = m.user_id
    where m.farm_id = p_farm_id and lower(u.email) = v_email
  ) then
    raise exception '% is already on this farm', v_email;
  end if;

  insert into farm_invites (farm_id, email, role, invited_by)
  values (p_farm_id, v_email, p_role, auth.uid())
  on conflict (farm_id, email)
    do update set role = excluded.role, accepted_at = null, created_at = now()
  returning id into v_id;

  return v_id;
end $$;


-- ---------- Change a role -----------------------------------------------------
create or replace function public.set_member_role(
  p_farm_id bigint,
  p_user_id uuid,
  p_role    member_role
)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  v_owners integer;
begin
  if not is_farm_owner(p_farm_id) then
    raise exception 'Only an owner can change roles';
  end if;

  select count(*) into v_owners
  from farm_members where farm_id = p_farm_id and role = 'owner';

  -- Demoting the last owner would leave nobody able to manage people again.
  if p_role <> 'owner' and v_owners <= 1
     and exists (select 1 from farm_members
                 where farm_id = p_farm_id and user_id = p_user_id and role = 'owner') then
    raise exception 'This is the only owner. Make someone else an owner first';
  end if;

  update farm_members set role = p_role
  where farm_id = p_farm_id and user_id = p_user_id;

  if not found then
    raise exception 'That person is not on this farm';
  end if;
end $$;


-- ---------- Remove someone ----------------------------------------------------
create or replace function public.remove_member(p_farm_id bigint, p_user_id uuid)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  v_owners integer;
begin
  if not is_farm_owner(p_farm_id) then
    raise exception 'Only an owner can remove people';
  end if;

  select count(*) into v_owners
  from farm_members where farm_id = p_farm_id and role = 'owner';

  if v_owners <= 1
     and exists (select 1 from farm_members
                 where farm_id = p_farm_id and user_id = p_user_id and role = 'owner') then
    raise exception 'This is the only owner. Make someone else an owner first';
  end if;

  delete from farm_members where farm_id = p_farm_id and user_id = p_user_id;

  if not found then
    raise exception 'That person is not on this farm';
  end if;
end $$;


-- ---------- Pending invitations ----------------------------------------------
create or replace function public.pending_invites(p_farm_id bigint)
returns table (id bigint, email text, role member_role, created_at timestamptz)
language sql stable security definer set search_path = public
as $$
  select i.id, i.email, i.role, i.created_at
  from farm_invites i
  where i.farm_id = p_farm_id
    and i.accepted_at is null
    and exists (
      select 1 from farm_members me
      where me.farm_id = p_farm_id and me.user_id = auth.uid()
    )
  order by i.created_at desc;
$$;


create or replace function public.cancel_invite(p_invite_id bigint)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  v_farm bigint;
begin
  select farm_id into v_farm from farm_invites where id = p_invite_id;
  if v_farm is null then
    raise exception 'That invitation no longer exists';
  end if;

  if not is_farm_owner(v_farm) then
    raise exception 'Only an owner can cancel invitations';
  end if;

  delete from farm_invites where id = p_invite_id;
end $$;
