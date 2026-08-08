-- =============================================================================
-- Roost — 013 invoice follow-ups
--
-- Phase 3. An AI drafts the wording for a payment reminder; nothing is sent
-- anywhere by this migration or by the function that calls it. A person reads
-- the draft, can change a word of it, and only their own click opens it in
-- their own email app to actually send. This table exists to remember what
-- was drafted and what genuinely went out — it has no ability to send mail
-- itself, on purpose.
-- =============================================================================


-- ---------- Dependencies ------------------------------------------------------
do $$
begin
  if to_regprocedure('public.can_edit_invoice(bigint)') is null then
    raise exception
      'Migration 012 has not been applied. Run 012_sales.sql before this file.';
  end if;
end $$;


-- ---------- The table -----------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_type where typname = 'followup_status') then
    create type followup_status as enum ('drafted', 'sent', 'dismissed');
  end if;
end $$;

create table if not exists invoice_followups (
  id           bigint generated always as identity primary key,
  invoice_id   bigint not null references invoices(id) on delete cascade,
  drafted_at   timestamptz not null default now(),
  drafted_by   uuid references auth.users(id) on delete set null,
  days_overdue integer not null default 0,
  subject      text not null,
  body         text not null,
  status       followup_status not null default 'drafted',
  sent_at      timestamptz,
  sent_by      uuid references auth.users(id) on delete set null,
  model        text
);

create index if not exists invoice_followups_invoice_idx
  on invoice_followups (invoice_id, drafted_at desc);


-- ---------- Security -----------------------------------------------------
-- Same authority as the invoice it is about: anyone on the farm can see a
-- draft, only an owner or member can create, edit or send one.
alter table invoice_followups enable row level security;

drop policy if exists invoice_followups_read on invoice_followups;
drop policy if exists invoice_followups_insert on invoice_followups;
drop policy if exists invoice_followups_update on invoice_followups;
drop policy if exists invoice_followups_delete on invoice_followups;

create policy invoice_followups_read on invoice_followups
  for select using (can_access_invoice(invoice_id));
create policy invoice_followups_insert on invoice_followups
  for insert with check (can_edit_invoice(invoice_id));
create policy invoice_followups_update on invoice_followups
  for update using (can_edit_invoice(invoice_id)) with check (can_edit_invoice(invoice_id));
create policy invoice_followups_delete on invoice_followups
  for delete using (can_edit_invoice(invoice_id));

-- Whatever the client sends for status = 'sent', the who/when of it is not
-- theirs to set — stamped here so the record can be trusted regardless of
-- what the update statement contained.
create or replace function public.stamp_followup_sent() returns trigger
language plpgsql as $$
begin
  if new.status = 'sent' and old.status is distinct from 'sent' then
    new.sent_at := now();
    new.sent_by := auth.uid();
  end if;
  return new;
end $$;

drop trigger if exists trg_stamp_followup_sent on invoice_followups;
create trigger trg_stamp_followup_sent
  before update on invoice_followups
  for each row execute function stamp_followup_sent();


-- ---------- Who needs a nudge ----------------------------------------------
-- Outstanding, sent invoices, with how long it has been since the last
-- follow-up (if any) — so the screen can tell "never followed up" apart from
-- "already emailed them three days ago, leave it be".
create or replace view v_followup_candidates with (security_invoker = true) as
select
  i.*,
  f.last_followup_at,
  f.last_followup_status,
  f.followup_count,
  case when f.last_followup_at is null then null
       else (current_date - f.last_followup_at::date)
  end as days_since_followup
from v_invoices i
left join lateral (
  select
    max(drafted_at)                                as last_followup_at,
    count(*)                                        as followup_count,
    (array_agg(status order by drafted_at desc))[1] as last_followup_status
  from invoice_followups
  where invoice_id = i.id
) f on true
where i.status = 'sent' and i.outstanding > 0.005;


-- =============================================================================
-- CHECK IT WORKED
--   select * from v_followup_candidates;   -- one row per unpaid, sent invoice
-- Sending anything requires supabase/functions/draft-invoice-followup to be
-- deployed, with an ANTHROPIC_API_KEY secret set — see that folder's README.
-- =============================================================================
