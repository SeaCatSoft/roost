-- =============================================================================
-- Roost — 019 forecast opt-in
--
-- Whether a farm has agreed to have its data run through the daily TimesFM
-- forecast job (backend/forecast/). Off by default: Roost is public, and
-- running an experimental analytics feature against a farm's real data
-- without the owner choosing it is not something a shared secret list should
-- decide on their behalf. Only the farm's own owner can turn this on — see
-- farm.html — which is exactly what the existing farms_write RLS policy
-- (is_farm_owner) already enforces; this column needs no new policy.
-- =============================================================================

alter table farms
  add column forecast_opt_in boolean not null default false;
