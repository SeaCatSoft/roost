-- =============================================================================
-- Roost — 011 processing
--
-- Until now every money figure has been modelled from assumptions. This is
-- where actuals arrive: birds through the plant, real weights out, real revenue
-- at the price list.
--
-- The two are kept side by side rather than one overwriting the other. The plan
-- is what you costed against; the actual is what happened. The gap between them
-- is the only thing that improves the next cycle.
-- =============================================================================


-- ---------- Saving a run atomically -------------------------------------------
-- A run and its product lines are one record. Inserting the header from the
-- browser and then the lines separately risks a run with no outputs if the
-- second call fails — which would quietly understate yield.
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
  p_run_id          bigint default null
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
      live_weight_lb, dressed_weight_lb, processor, lot_code)
    values (
      p_cycle_id, p_processed_on, p_birds_processed, coalesce(p_birds_condemned, 0),
      p_live_weight_lb, p_dressed_weight_lb, p_processor, p_lot_code)
    returning id into v_run_id;
  else
    update processing_runs set
      processed_on = p_processed_on,
      birds_processed = p_birds_processed,
      birds_condemned = coalesce(p_birds_condemned, 0),
      live_weight_lb = p_live_weight_lb,
      dressed_weight_lb = p_dressed_weight_lb,
      processor = p_processor,
      lot_code = p_lot_code
    where id = p_run_id and cycle_id = p_cycle_id
    returning id into v_run_id;

    if v_run_id is null then
      raise exception 'That run does not exist, or you do not have access to it';
    end if;

    -- Replace the lines wholesale: an edit that dropped a product should not
    -- leave the old weight behind.
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


create or replace function public.delete_processing_run(p_run_id bigint)
returns void
language plpgsql
as $$
declare
  v_deleted bigint;
begin
  delete from processing_runs where id = p_run_id returning id into v_deleted;
  if v_deleted is null then
    raise exception 'That run does not exist, or you do not have access to it';
  end if;
end $$;


-- ---------- A run, with what it earned ----------------------------------------
create or replace view v_processing_run_lines with (security_invoker = true) as
select
  o.id,
  r.id                as run_id,
  r.cycle_id,
  c.farm_id,
  pl.id               as product_line_id,
  pl.name             as product_line,
  pl.is_whole_bird,
  pl.sort_order,
  o.weight_lb,
  o.units,
  m.price_per_lb,
  o.weight_lb * coalesce(m.price_per_lb, 0) as revenue
from processing_outputs o
join processing_runs r  on r.id = o.run_id
join cycles c           on c.id = r.cycle_id
join product_lines pl   on pl.id = o.product_line_id
left join cycle_product_mix m
       on m.cycle_id = r.cycle_id and m.product_line_id = o.product_line_id;


create or replace view v_processing_runs with (security_invoker = true) as
select
  r.*,
  c.farm_id,
  coalesce(l.saleable_lb, 0)  as saleable_lb,
  coalesce(l.revenue, 0)      as revenue,
  -- Yields, where the weights needed to compute them were recorded.
  case when r.live_weight_lb > 0
       then r.dressed_weight_lb / r.live_weight_lb end       as dressing_yield,
  case when r.dressed_weight_lb > 0
       then coalesce(l.saleable_lb, 0) / r.dressed_weight_lb end as saleable_of_dressed,
  case when r.birds_processed > 0
       then coalesce(l.saleable_lb, 0) / r.birds_processed end   as saleable_lb_per_bird
from processing_runs r
join cycles c on c.id = r.cycle_id
left join lateral (
  select sum(weight_lb) as saleable_lb, sum(revenue) as revenue
  from v_processing_run_lines pl where pl.run_id = r.id
) l on true;


-- ---------- The cycle's actuals, against the plan -----------------------------
create or replace view v_cycle_actual with (security_invoker = true) as
select
  c.id                          as cycle_id,
  c.farm_id,
  c.label,
  coalesce(r.runs, 0)           as runs,
  coalesce(r.birds_processed, 0) as birds_processed,
  coalesce(r.birds_condemned, 0) as birds_condemned,
  r.live_weight_lb,
  r.dressed_weight_lb,
  coalesce(r.saleable_lb, 0)    as saleable_lb,
  coalesce(r.revenue, 0)        as revenue_actual,

  case when r.live_weight_lb > 0
       then r.dressed_weight_lb / r.live_weight_lb end        as dressing_yield_actual,
  case when r.birds_processed > 0
       then r.live_weight_lb / r.birds_processed end          as live_lb_per_bird_actual,
  case when r.birds_processed > 0
       then r.saleable_lb / r.birds_processed end             as saleable_lb_per_bird_actual,
  case when coalesce(r.saleable_lb, 0) > 0
       then r.revenue / r.saleable_lb end                     as blended_price_actual,

  -- The plan, for comparison. Cost stays modelled: real costs would need every
  -- invoice entered, which is Phase 2.
  p.birds_sold                  as birds_planned,
  p.total_net_lb                as saleable_lb_planned,
  p.revenue                     as revenue_planned,
  p.total_cost                  as cost_modelled,
  p.breakeven_price_lb          as breakeven_modelled,

  -- What the cycle actually made, against the modelled cost stack.
  case when coalesce(r.runs, 0) > 0
       then coalesce(r.revenue, 0) - p.total_cost end         as profit_actual
from cycles c
left join v_cycle_pnl p on p.cycle_id = c.id
left join lateral (
  select
    count(*)                    as runs,
    sum(birds_processed)        as birds_processed,
    sum(birds_condemned)        as birds_condemned,
    sum(live_weight_lb)         as live_weight_lb,
    sum(dressed_weight_lb)      as dressed_weight_lb,
    sum(saleable_lb)            as saleable_lb,
    sum(revenue)                as revenue
  from v_processing_runs vr where vr.cycle_id = c.id
) r on true;


-- =============================================================================
-- CHECK IT WORKED
--   select * from v_cycle_actual;        -- one row per cycle, zeros until a run
--   select * from v_processing_runs;     -- empty until the first run is saved
-- =============================================================================
