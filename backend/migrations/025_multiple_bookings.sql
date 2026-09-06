-- =============================================================================
-- Roost — 025 more than one processing booking per cycle
--
-- One booking per cycle stopped fitting the moment partial processing did:
-- sending 300 birds now and the rest in two weeks is two dates, not one, and
-- the unique(cycle_id) constraint from 020 made the second one impossible to
-- book without overwriting the first.
--
-- Also closes a real gap rather than papering over it: "once the processing
-- date has passed, subtract the birds" was asked for, and the honest answer
-- is that Roost already does this correctly (022_processing_effective_date.sql)
-- — but only once the actual run is recorded, never from the booking's
-- stated plan alone. A plan can slip a day, or the real count can differ
-- from what was intended; only a measured run should move a number feed and
-- health decisions depend on. What was missing was a way to notice a
-- booking's date has come and gone with nothing recorded against it yet —
-- that gap is what booking_id below closes.
-- =============================================================================


-- ---------- Dependencies ------------------------------------------------------
do $$
begin
  if not exists (select 1 from information_schema.columns
                  where table_name = 'v_processing_bookings' and column_name = 'is_cancelled') then
    raise exception
      'Migration 023 has not been applied. Run 023_cancel_booking.sql before this file.';
  end if;
end $$;


-- ---------- More than one booking per cycle -----------------------------------
-- Found by what it actually constrains, not by its likely auto-generated
-- name — a name guessed wrong here would "succeed" at dropping nothing and
-- leave the real constraint silently in place, which is worse than an error.
do $$
declare v_name text;
begin
  select con.conname into v_name
  from pg_constraint con
  join pg_class rel on rel.oid = con.conrelid
  where rel.relname = 'processing_bookings'
    and con.contype = 'u'
    and con.conkey = (
      select array_agg(attnum order by attnum)
      from pg_attribute
      where attrelid = rel.oid and attname = 'cycle_id'
    );

  if v_name is not null then
    execute format('alter table processing_bookings drop constraint %I', v_name);
  end if;
end $$;


-- ---------- A run can say which booking it fulfils -----------------------------
-- Nullable and set-null-on-delete: a run recorded with no booking behind it
-- (an ad-hoc cull, or data from before this migration) is still a completely
-- valid run: this is how a booking finds out it was fulfilled, not a
-- requirement placed on every run.
alter table processing_runs
  add column if not exists booking_id bigint references processing_bookings(id) on delete set null;

create index if not exists processing_runs_booking_idx on processing_runs (booking_id) where booking_id is not null;


-- ---------- Recording a run can say which booking it fulfils -------------------
-- A new trailing parameter with a default is safe to add via CREATE OR
-- REPLACE FUNCTION — existing callers that never mention it keep working
-- exactly as before, getting null the same as any run with no booking
-- behind it.
create or replace function public.save_processing_run(
  p_cycle_id        bigint,
  p_processed_on    date,
  p_birds_processed integer,
  p_birds_condemned integer,
  p_live_weight_lb  numeric,
  p_dressed_weight_lb numeric,
  p_processor       text,
  p_lot_code        text,
  p_outputs         jsonb,          -- [{product_line_id, weight_lb, units}]
  p_run_id          bigint default null,
  p_booking_id      bigint default null
)
returns bigint
language plpgsql
as $$
declare
  v_run_id bigint;
begin
  if p_birds_processed is null or p_birds_processed <= 0 then
    raise exception 'Birds processed must be a positive number';
  end if;

  if p_run_id is null then
    insert into processing_runs (
      cycle_id, processed_on, birds_processed, birds_condemned,
      live_weight_lb, dressed_weight_lb, processor, lot_code, booking_id)
    values (
      p_cycle_id, p_processed_on, p_birds_processed, coalesce(p_birds_condemned, 0),
      p_live_weight_lb, p_dressed_weight_lb, p_processor, p_lot_code, p_booking_id)
    returning id into v_run_id;
  else
    update processing_runs set
      processed_on = p_processed_on,
      birds_processed = p_birds_processed,
      birds_condemned = coalesce(p_birds_condemned, 0),
      live_weight_lb = p_live_weight_lb,
      dressed_weight_lb = p_dressed_weight_lb,
      processor = p_processor,
      lot_code = p_lot_code,
      booking_id = coalesce(p_booking_id, booking_id)
    where id = p_run_id and cycle_id = p_cycle_id
    returning id into v_run_id;

    if v_run_id is null then
      raise exception 'That run does not exist, or you do not have access to it';
    end if;

    delete from processing_outputs where run_id = v_run_id;
  end if;

  insert into processing_outputs (run_id, product_line_id, weight_lb, units)
  select
    v_run_id,
    (o->>'product_line_id')::bigint,
    coalesce((o->>'weight_lb')::numeric, 0),
    nullif(o->>'units', '')::integer
  from jsonb_array_elements(coalesce(p_outputs, '[]'::jsonb)) o
  where coalesce((o->>'weight_lb')::numeric, 0) > 0;

  return v_run_id;
end $$;


-- ---------- Exposed on the view, appended at the end ---------------------------
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
  b.cancelled_at,
  -- The reminder this migration exists for: a date that has come and gone
  -- with nothing recorded against it. Never true for a cancelled booking —
  -- there is nothing left to have happened.
  (b.cancelled_at is null and current_date > b.booked_on
     and not exists (select 1 from processing_runs r where r.booking_id = b.id))
                                            as needs_run
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
--   -- two bookings on the same cycle should now both save:
--   select cycle_id, count(*) from processing_bookings group by cycle_id;
--   select booked_on, is_past, needs_run from v_processing_bookings order by booked_on;
-- =============================================================================
