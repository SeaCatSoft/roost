-- =============================================================================
-- Roost — 014 the check log
--
-- daily_checks has always recorded who saved it (recorded_by), but nothing has
-- ever been able to show that: recorded_by is a uuid pointing at auth.users,
-- and auth.users is not readable from the browser. So the information was
-- being collected and never surfaced.
--
-- Same shape as farm_people in 007: SECURITY DEFINER to reach auth.users, with
-- the membership check written out by hand because definer skips RLS. A
-- definer function without that check would hand every email in the project to
-- anyone who called it.
--
-- HONEST LIMIT, worth knowing before trusting this as an audit trail: the app
-- saves a check by upsert, so re-saving the same day overwrites recorded_by
-- with whoever saved it last. This answers "who saved this check", not "who
-- was the first person to enter it" or "what did it say before". If a real
-- history of edits is ever needed, that is a separate change — an append-only
-- table this one cannot substitute for.
-- =============================================================================


-- ---------- Dependencies ------------------------------------------------------
do $$
begin
  if to_regprocedure('public.session_rank(check_session)') is null then
    raise exception
      'Migration 010 has not been applied. Run 010_twice_daily_checks.sql before this file.';
  end if;
end $$;


-- ---------- Every check for one cycle, with who saved it ----------------------
create or replace function public.cycle_check_log(p_cycle_id bigint)
returns table (
  id                bigint,
  day_number        smallint,
  session           check_session,
  checked_on        date,
  mortality         integer,
  culls             integer,
  feed_offered_kg   numeric,
  water             water_status,
  litter            litter_status,
  house_temp_c      numeric,
  health            health_status,
  action_taken      text,
  notes             text,
  recorded_by       uuid,
  recorded_by_email text,
  is_you            boolean,
  created_at        timestamptz,
  updated_at        timestamptz
)
language sql stable security definer set search_path = public, auth
as $$
  select
    d.id,
    d.day_number,
    d.session,
    d.checked_on,
    d.mortality,
    d.culls,
    d.feed_offered_kg,
    d.water,
    d.litter,
    d.house_temp_c,
    d.health,
    d.action_taken,
    d.notes,
    d.recorded_by,
    u.email::text,
    (d.recorded_by = auth.uid()),
    d.created_at,
    d.updated_at
  from daily_checks d
  -- left join: a check whose author was since removed from the project still
  -- shows, with no name, rather than vanishing from the log entirely.
  left join auth.users u on u.id = d.recorded_by
  where d.cycle_id = p_cycle_id
    -- Access check, by hand, because definer skipped RLS.
    and can_access_cycle(p_cycle_id)
  order by d.day_number desc, session_rank(d.session);
$$;


-- =============================================================================
-- CHECK IT WORKED
--   select day_number, session, mortality, recorded_by_email
--   from cycle_check_log((select id from cycles order by placed_on desc limit 1));
-- =============================================================================
