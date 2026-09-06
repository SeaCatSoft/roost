-- =============================================================================
-- Roost — 023 cancel a processing booking
--
-- A booking could be rescheduled but never called off outright. Weather, a
-- processor cancellation, a health hold on the flock — something changes and
-- there is no longer a date to keep. Nothing about archiving or deleting the
-- booking row fits: the people already invited have a calendar entry on
-- their phone that needs to actually be told it is off, not just quietly
-- forgotten by Roost while it sits there on their phone forever.
--
-- cancelled_at is nullable rather than a boolean so "when" is on the record,
-- not only "whether" — and rather than deleting the row, since the same
-- booking gets reused (and un-cancelled) the moment a fresh date is saved
-- for the same cycle, keeping the existing one-booking-per-cycle shape
-- exactly as it already was.
-- =============================================================================


-- ---------- Dependencies ------------------------------------------------------
do $$
begin
  if to_regprocedure('public.can_own_booking(bigint)') is null then
    raise exception
      'Migration 020 has not been applied. Run 020_processing_bookings.sql before this file.';
  end if;
end $$;


-- ---------- The cancellation itself --------------------------------------------
alter table processing_bookings
  add column if not exists cancelled_at timestamptz;


-- ---------- Sequence bumps on cancelling too, not only on reschedule ----------
-- Calendar apps only know to treat a resend as an update, rather than
-- ignoring it as a stale duplicate, when the SEQUENCE genuinely goes up.
-- Cancelling is exactly as real a change to the event as its date moving —
-- the trigger already existed for that reason, so this extends the same
-- single rule rather than judging "did this change enough to matter" a
-- second time, somewhere else.
create or replace function public.touch_processing_booking()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  if new.booked_on is distinct from old.booked_on
     or new.booked_time is distinct from old.booked_time
     or new.location is distinct from old.location
     or new.cancelled_at is distinct from old.cancelled_at then
    new.sequence_no := old.sequence_no + 1;
  end if;
  return new;
end $$;


-- ---------- Exposed on the view, appended at the end ---------------------------
-- Appended, not inserted among the existing columns — CREATE OR REPLACE VIEW
-- only allows adding columns after every existing one; this migration's own
-- history (021, twice) is the reason that rule is spelled out here rather
-- than assumed.
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
  coalesce(i.stale, 0)  as invites_stale,
  coalesce(i.failed, 0) as invites_failed,
  (current_date > b.booked_on)             as is_past,
  b.birds_intended,
  (b.cancelled_at is not null)             as is_cancelled,
  b.cancelled_at
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
--   select booked_on, is_past, is_cancelled from v_processing_bookings;
--   -- cancel one by hand to see the sequence bump:
--   update processing_bookings set cancelled_at = now() where id = <id>;
--   select sequence_no from processing_bookings where id = <id>;
-- =============================================================================
