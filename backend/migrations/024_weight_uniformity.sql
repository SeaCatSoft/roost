-- =============================================================================
-- Roost — 024 store uniformity, not just the average
--
-- The weights screen already computes a coefficient of variation — the
-- standard flock uniformity measure — the moment weights are being entered,
-- and shows it live while typing. It was never saved: sample_weights only
-- ever stored avg_weight_g and a bird count, so the "Uniformity" figure on
-- the headline was a hardcoded dash with a comment admitting as much. Not a
-- broken calculation — a calculation that only ever ran in a form that then
-- threw its answer away.
-- =============================================================================


-- ---------- The number that already exists at save time, finally kept -------
-- Null rather than 0 for a single-bird sample, where a spread is not a
-- meaningful concept — 0% would read as "perfectly uniform," which is not
-- what one bird can tell you.
alter table sample_weights
  add column if not exists weight_cv_pct numeric(5,2) check (weight_cv_pct >= 0);


-- =============================================================================
-- CHECK IT WORKED
--   select day_number, birds_sampled, avg_weight_g, weight_cv_pct
--   from sample_weights order by day_number;
--   -- existing rows show null here until re-saved; that is expected — the
--   -- individual weights behind an old average were never kept to derive it
--   -- from afterward, only the day's entry going forward.
-- =============================================================================
