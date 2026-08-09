-- =============================================================================
-- Roost — 016 owner-only: the business, separate from the flock
--
-- Until now a member could do everything except manage people. That was the
-- right default when everyone using it was family working the same flock. It
-- stops being right once the money is in here: invoicing, prices, costs and
-- starting cycles are decisions about the business, not the day's work.
--
-- What moves to owners only:
--   * cycles                — starting, closing, deleting a batch
--   * cycle_assumptions,
--     feed_intake_curve,
--     cycle_product_mix,
--     product_lines         — the planner: costs, prices, the feed curve
--   * customers, invoices,
--     invoice_lines,
--     payments,
--     invoice_followups     — everything to do with billing
--
-- What deliberately does NOT move, because it is the daily work and locking it
-- would stop the farm running:
--   * daily_checks, sample_weights, feed_bag_openings, health_tasks
--   * processing_runs, processing_outputs, feed_purchases, assets, houses
--
-- A viewer still reads everything and writes nothing, unchanged.
--
-- This is enforced here rather than by hiding buttons. A hidden button is not
-- an access control — the app also hides them, but only because being shown a
-- control that fails on save is a poor way to learn you cannot use it.
-- =============================================================================


-- ---------- Dependencies ------------------------------------------------------
do $$
begin
  if to_regclass('public.invoice_followups') is null then
    raise exception
      'Migration 013 has not been applied. Run migrations up to 013_followups.sql before this file.';
  end if;
end $$;


-- ---------- Owner-level access helpers ----------------------------------------
-- The editor-level equivalents (can_edit_cycle, can_edit_invoice) stay exactly
-- as they are — the tables that remain open to members still use them.

create or replace function public.can_own_cycle(p_cycle_id bigint)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from cycles c
    join farm_members m on m.farm_id = c.farm_id
    where c.id = p_cycle_id and m.user_id = auth.uid() and m.role = 'owner'
  );
$$;

create or replace function public.can_own_invoice(p_invoice_id bigint)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from invoices i
    join farm_members m on m.farm_id = i.farm_id
    where i.id = p_invoice_id and m.user_id = auth.uid() and m.role = 'owner'
  );
$$;


-- ---------- Farm-scoped tables ------------------------------------------------
-- Reading stays open to every member: a viewer or member can still see the
-- prices and the invoices, they simply cannot change them.
do $$
declare t text;
begin
  foreach t in array array['cycles', 'product_lines', 'customers', 'invoices'] loop
    execute format('drop policy if exists %I on %I', t||'_all', t);
    execute format('drop policy if exists %I on %I', t||'_read', t);
    execute format('drop policy if exists %I on %I', t||'_insert', t);
    execute format('drop policy if exists %I on %I', t||'_update', t);
    execute format('drop policy if exists %I on %I', t||'_delete', t);

    execute format('create policy %I on %I for select using (is_farm_member(farm_id))', t||'_read', t);
    execute format('create policy %I on %I for insert with check (is_farm_owner(farm_id))', t||'_insert', t);
    execute format('create policy %I on %I for update using (is_farm_owner(farm_id)) with check (is_farm_owner(farm_id))', t||'_update', t);
    execute format('create policy %I on %I for delete using (is_farm_owner(farm_id))', t||'_delete', t);
  end loop;
end $$;


-- ---------- Cycle-scoped planner tables ---------------------------------------
do $$
declare t text;
begin
  foreach t in array array['cycle_assumptions', 'feed_intake_curve', 'cycle_product_mix'] loop
    execute format('drop policy if exists %I on %I', t||'_all', t);
    execute format('drop policy if exists %I on %I', t||'_read', t);
    execute format('drop policy if exists %I on %I', t||'_insert', t);
    execute format('drop policy if exists %I on %I', t||'_update', t);
    execute format('drop policy if exists %I on %I', t||'_delete', t);

    execute format('create policy %I on %I for select using (can_access_cycle(cycle_id))', t||'_read', t);
    execute format('create policy %I on %I for insert with check (can_own_cycle(cycle_id))', t||'_insert', t);
    execute format('create policy %I on %I for update using (can_own_cycle(cycle_id)) with check (can_own_cycle(cycle_id))', t||'_update', t);
    execute format('create policy %I on %I for delete using (can_own_cycle(cycle_id))', t||'_delete', t);
  end loop;
end $$;


-- ---------- Invoice-scoped tables ---------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['invoice_lines', 'payments', 'invoice_followups'] loop
    execute format('drop policy if exists %I on %I', t||'_read', t);
    execute format('drop policy if exists %I on %I', t||'_insert', t);
    execute format('drop policy if exists %I on %I', t||'_update', t);
    execute format('drop policy if exists %I on %I', t||'_delete', t);

    execute format('create policy %I on %I for select using (can_access_invoice(invoice_id))', t||'_read', t);
    execute format('create policy %I on %I for insert with check (can_own_invoice(invoice_id))', t||'_insert', t);
    execute format('create policy %I on %I for update using (can_own_invoice(invoice_id)) with check (can_own_invoice(invoice_id))', t||'_update', t);
    execute format('create policy %I on %I for delete using (can_own_invoice(invoice_id))', t||'_delete', t);
  end loop;
end $$;


-- ---------- Orders, so far as Roost knows them --------------------------------
-- There is no order pipeline in Roost: nothing records "three customers want
-- forty birds next month". The nearest real thing is an invoice raised but not
-- yet sent — goods promised, not yet billed. This view is named for what it
-- actually contains rather than borrowing a word it cannot honour, and the
-- screen says the same. If genuine orders are wanted later, that is a table,
-- not a rename.
create or replace view v_unsent_invoices with (security_invoker = true) as
select
  i.*,
  (current_date - i.issued_on) as days_since_issued
from v_invoices i
where i.status = 'draft';


-- =============================================================================
-- CHECK IT WORKED
--   -- as an owner, both should be true:
--   select is_farm_owner(id) from farms;
--   -- every table below should list four policies, not one:
--   select tablename, count(*) from pg_policies
--   where schemaname = 'public'
--     and tablename in ('cycles','product_lines','customers','invoices',
--                       'cycle_assumptions','feed_intake_curve','cycle_product_mix',
--                       'invoice_lines','payments','invoice_followups')
--   group by tablename order by tablename;
-- =============================================================================
