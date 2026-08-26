-- =============================================================================
-- Roost — 020 processing bookings
--
-- A date on the calendar for when the flock actually goes to be processed,
-- and a way to put that date on the calendars of everyone who needs to plan
-- around it — family helping that day, a processor, anyone else. Distinct
-- from processing_runs, which records what already happened; this records
-- what is *going* to happen, before it does.
--
-- Booking is owner-only, in keeping with the planner (016, 017): deciding
-- when to send the flock is a business call. Reading the booked date is open
-- to every farm member, because knowing processing day is coming is exactly
-- the kind of thing the daily work has to plan around.
-- =============================================================================


-- ---------- Dependencies ------------------------------------------------------
do $$
begin
  if to_regprocedure('public.is_farm_owner(bigint)') is null then
    raise exception 'Migration 003 has not been applied. Run earlier migrations before this file.';
  end if;
end $$;


-- ---------- The booking itself -------------------------------------------------
create table if not exists processing_bookings (
  id          bigint generated always as identity primary key,
  farm_id     bigint not null references farms(id) on delete cascade,
  cycle_id    bigint not null references cycles(id) on delete cascade,
  booked_on   date not null,
  booked_time time,
  location    text,
  notes       text,
  created_by  uuid references auth.users(id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),

  -- The calendar standard (RFC 5545) needs a number that only goes up when a
  -- booked event actually changes, so a phone recognises a resend as an
  -- update to the same entry rather than a second, duplicate one.
  sequence_no integer not null default 0,

  -- One booking per cycle. Rescheduling changes the date on the existing row
  -- — and re-sends an updated calendar entry — rather than leaving an old
  -- booking behind for people to be confused by.
  unique (cycle_id)
);

create index if not exists processing_bookings_farm_idx on processing_bookings (farm_id);

-- Kept separate from `created_at` because it means something different: when
-- the date was last changed, which is exactly the moment a calendar update
-- needs to go out again. sequence_no only advances when the actual event
-- details move — a typo fixed in the notes should not force every phone to
-- re-confirm an event whose date never changed.
create or replace function public.touch_processing_booking()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  if new.booked_on is distinct from old.booked_on
     or new.booked_time is distinct from old.booked_time
     or new.location is distinct from old.location then
    new.sequence_no := old.sequence_no + 1;
  end if;
  return new;
end $$;

drop trigger if exists processing_bookings_touch on processing_bookings;
create trigger processing_bookings_touch
  before update on processing_bookings
  for each row execute function touch_processing_booking();


-- ---------- Who was invited, and whether it actually sent -----------------------
-- Its own row per person rather than an array on the booking: a farm member
-- who joins after the invites went out, or a processor's email typed in by
-- hand, gets added and sent to individually — nobody already invited gets a
-- second email just because one more person was added.
create table if not exists processing_booking_invites (
  id          bigint generated always as identity primary key,
  booking_id  bigint not null references processing_bookings(id) on delete cascade,
  email       text not null,
  name        text,
  sent_at         timestamptz,
  sent_for_seq    integer,   -- the booking's sequence_no this invite was sent for,
                              -- so a later reschedule is detected rather than assumed current
  error           text,
  created_at  timestamptz not null default now(),
  unique (booking_id, email)
);

create index if not exists processing_booking_invites_booking_idx
  on processing_booking_invites (booking_id);


-- ---------- Security -----------------------------------------------------------
alter table processing_bookings        enable row level security;
alter table processing_booking_invites enable row level security;

drop policy if exists processing_bookings_read   on processing_bookings;
drop policy if exists processing_bookings_insert on processing_bookings;
drop policy if exists processing_bookings_update on processing_bookings;
drop policy if exists processing_bookings_delete on processing_bookings;

create policy processing_bookings_read on processing_bookings
  for select using (is_farm_member(farm_id));
create policy processing_bookings_insert on processing_bookings
  for insert with check (is_farm_owner(farm_id));
create policy processing_bookings_update on processing_bookings
  for update using (is_farm_owner(farm_id)) with check (is_farm_owner(farm_id));
create policy processing_bookings_delete on processing_bookings
  for delete using (is_farm_owner(farm_id));

create or replace function public.can_own_booking(p_booking_id bigint)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from processing_bookings b
    where b.id = p_booking_id and is_farm_owner(b.farm_id)
  );
$$;

drop policy if exists processing_booking_invites_read   on processing_booking_invites;
drop policy if exists processing_booking_invites_insert on processing_booking_invites;
drop policy if exists processing_booking_invites_update on processing_booking_invites;
drop policy if exists processing_booking_invites_delete on processing_booking_invites;

create policy processing_booking_invites_read on processing_booking_invites
  for select using (exists (
    select 1 from processing_bookings b
    where b.id = booking_id and is_farm_member(b.farm_id)
  ));
create policy processing_booking_invites_insert on processing_booking_invites
  for insert with check (can_own_booking(booking_id));
create policy processing_booking_invites_update on processing_booking_invites
  for update using (can_own_booking(booking_id)) with check (can_own_booking(booking_id));
create policy processing_booking_invites_delete on processing_booking_invites
  for delete using (can_own_booking(booking_id));


-- ---------- One row per booking, with invite counts ------------------------------
create or replace view v_processing_bookings with (security_invoker = true) as
select
  b.id,
  b.farm_id,
  b.cycle_id,
  c.label as cycle_label,
  b.booked_on,
  b.booked_time,
  b.location,
  b.notes,
  b.updated_at,
  b.sequence_no,
  coalesce(i.total, 0)  as invite_count,
  coalesce(i.sent, 0)   as invites_sent,
  coalesce(i.stale, 0)  as invites_stale,   -- sent, but for a date since changed
  coalesce(i.failed, 0) as invites_failed,
  (current_date > b.booked_on)             as is_past
from processing_bookings b
join cycles c on c.id = b.cycle_id
left join lateral (
  select
    count(*)                                                          as total,
    count(*) filter (where sent_at is not null and error is null
                        and sent_for_seq is not distinct from b.sequence_no) as sent,
    count(*) filter (where sent_at is not null and error is null
                        and sent_for_seq is distinct from b.sequence_no)     as stale,
    count(*) filter (where error is not null)                          as failed
  from processing_booking_invites where booking_id = b.id
) i on true;


-- =============================================================================
-- CHECK IT WORKED
--   select * from v_processing_bookings;              -- empty until the first booking
--   select * from processing_booking_invites limit 5;
-- =============================================================================
