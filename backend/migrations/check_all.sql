-- =============================================================================
-- Roost — migration audit
--
-- Not a migration. Checks which of 001-020 have actually been applied, by
-- looking for one distinctive object each creates. Run this any time you are
-- unsure what state the database is in.
--
-- This file is shared across every branch of work regardless of who added
-- which migration, so every migration gets a row here even ones added
-- elsewhere — a gap would just be a blind spot the next person trips over.
--
-- Every row should say ok. Anything else names the migration to (re-)run.
-- =============================================================================

select * from (values
  ('001_schema',              to_regclass('public.cycles') is not null),
  ('002_views',                to_regclass('public.v_cycle_pnl') is not null),
  ('003_security',            (select count(*) from pg_policies where schemaname='public' and tablename='cycles') > 0),
  ('004_seed',                (select count(*) from farms) > 0),
  -- 015 replaces start_new_cycle's signature, so this checks for either form:
  -- with 015 applied only the 8-argument one exists.
  ('005_cycle_management',    to_regprocedure('public.start_new_cycle(bigint,text,integer,date,text,integer,bigint)') is not null
                           or to_regprocedure('public.start_new_cycle(bigint,text,integer,date,text,integer,bigint,boolean)') is not null),
  ('006_cycle_history',        to_regclass('public.v_cycle_summary') is not null),
  ('007_people',               to_regprocedure('public.farm_people(bigint)') is not null),
  ('008_viewer_role',          exists (select 1 from pg_enum e join pg_type t on t.oid=e.enumtypid where t.typname='member_role' and e.enumlabel='viewer')),
  ('009_viewer_policies',      to_regprocedure('public.is_farm_editor(bigint)') is not null),
  ('010_twice_daily_checks',   exists (select 1 from information_schema.columns where table_name='daily_checks' and column_name='session')),
  ('011_processing',           to_regprocedure('public.save_processing_run(bigint,date,integer,integer,numeric,numeric,text,text,jsonb,bigint)') is not null),
  ('012_sales',                to_regclass('public.invoices') is not null and to_regprocedure('public.save_invoice(bigint,bigint,date,date,jsonb,bigint,bigint,text,bigint,text)') is not null),
  ('013_followups',            to_regclass('public.invoice_followups') is not null and to_regclass('public.v_followup_candidates') is not null),
  ('014_check_log',            to_regprocedure('public.cycle_check_log(bigint)') is not null),
  ('015_multi_farm',           to_regprocedure('public.start_new_cycle(bigint,text,integer,date,text,integer,bigint,boolean)') is not null),
  ('016_owner_only',           to_regprocedure('public.can_own_cycle(bigint)') is not null
                           and to_regclass('public.v_unsent_invoices') is not null),
  ('017_orders_stock',         to_regclass('public.orders') is not null
                           and to_regclass('public.v_stock') is not null
                           and to_regprocedure('public.invoice_from_order(bigint)') is not null),
  ('018_forecast',             to_regclass('public.cycle_forecasts') is not null),
  ('019_forecast_opt_in',      exists (select 1 from information_schema.columns
                                        where table_name='farms' and column_name='forecast_opt_in')),
  ('020_processing_bookings',  to_regclass('public.processing_bookings') is not null
                           and to_regclass('public.v_processing_bookings') is not null
                           and to_regprocedure('public.can_own_booking(bigint)') is not null)
) as t(migration, applied)
order by migration;
