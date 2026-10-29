-- =============================================================================
-- Roost — 028 low-feed alert emails
--
-- Run 027_feed_alerts.sql first.
--
-- A daily job (backend/alerts/feed_alerts.py, run by
-- .github/workflows/feed-alerts.yml) reads v_feed_alerts — the same view the
-- screens use, so the email and the dashboard cannot disagree — and emails
-- the farm's owners when a ration is low or out.
--
-- This migration gives that job three things the browser never needs:
--   * a log of what was emailed, so the job can tell a new problem from one
--     it already reported, and nobody gets the same email every morning;
--   * a way to look up owners' email addresses, which live in auth.users and
--     are deliberately not exposed (same reason as farm_people, 007);
--   * an owner switch to turn the emails off.
-- =============================================================================


-- ---------- Dependencies ------------------------------------------------------
do $$
begin
  if to_regclass('public.v_feed_alerts') is null then
    raise exception
      'Migration 027 has not been applied. Run 027_feed_alerts.sql before this file.';
  end if;
end $$;


-- ---------- On/off -------------------------------------------------------------
-- On by default: someone who set up a warning window wants to hear about it.
-- Owner-set through the existing farms_write policy (009).
alter table farms
  add column if not exists feed_alert_email boolean not null default true;


-- ---------- What was sent ------------------------------------------------------
-- Written only by the job, with the service role, which bypasses RLS. There
-- is deliberately no insert/update/delete policy: from the browser this is
-- read-only, so the log of what was sent cannot be edited after the fact.
create table if not exists feed_alert_emails (
  id          bigint generated always as identity primary key,
  farm_id     bigint not null references farms(id) on delete cascade,
  phase       feed_phase not null,
  level       text not null check (level in ('low', 'out')),
  days_left   numeric(6,1),
  on_hand     integer,
  sent_on     date not null default current_date,
  recipients  integer not null,
  created_at  timestamptz not null default now()
);

create index if not exists feed_alert_emails_farm_idx
  on feed_alert_emails (farm_id, phase, created_at desc);

alter table feed_alert_emails enable row level security;

drop policy if exists feed_alert_emails_read on feed_alert_emails;
create policy feed_alert_emails_read on feed_alert_emails
  for select using (is_farm_member(farm_id));


-- ---------- Who to send to -----------------------------------------------------
-- Owners only, looked up live, so adding or removing an owner in People
-- changes who is emailed with nothing else to keep in step.
--
-- Returns email addresses, so it must never be callable from the browser:
-- execute is revoked from everyone and granted back to service_role alone.
create or replace function public.farm_owner_emails(p_farm_id bigint)
returns setof text
language sql stable security definer set search_path = public, auth
as $$
  select u.email::text
  from farm_members m
  join auth.users u on u.id = m.user_id
  where m.farm_id = p_farm_id
    and m.role = 'owner'
    and u.email is not null;
$$;

revoke all on function public.farm_owner_emails(bigint) from public, anon, authenticated;
grant execute on function public.farm_owner_emails(bigint) to service_role;


-- =============================================================================
-- CHECK IT WORKED
--   select feed_alert_email from farms;                 -- true
--   select * from feed_alert_emails;                    -- empty until a send
--   select * from farm_owner_emails(1);                 -- works here in the
--     -- SQL editor (it runs as postgres); from the app it must be refused.
-- =============================================================================
