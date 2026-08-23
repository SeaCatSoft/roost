# Roost — forecast job

Runs `forecast.py` once a day via `.github/workflows/forecast.yml`. It uses
Google's [TimesFM](https://github.com/google-research/timesfm) to project,
for every open cycle, where feed-bag usage and mortality are headed by the
end of the grow-out, and writes the result to `cycle_forecasts`
(`018_forecast.sql`). Nothing in the frontend computes a forecast — the app
only reads what this job wrote.

**This has not been run against a live TimesFM install or a live Supabase
project.** It was written from the published TimesFM API and Roost's real
schema, not verified end to end. Before trusting it:

## First-run checklist

1. **Run `018_forecast.sql`** in the Supabase SQL editor, after `017`.
2. **`pip install -r requirements.txt` locally** and run `python forecast.py`
   once by hand with `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` set, against
   a cycle with at least 5 days of daily checks and a feed plan entered.
   Watch for:
   - The `timesfm.TimesFm` / `TimesFmHparams` / `TimesFmCheckpoint`
     constructor signature — this moves between library versions faster than
     most; check the version actually installed against
     [the repo's README](https://github.com/google-research/timesfm) if the
     import or the forecast call fails.
   - `horizon_len=64` in `load_model()` covers cycles up to ~84 days
     old-when-forecast-starts against a target in the low 100s; if a farm
     sets `target_sale_age` near its 120-day ceiling, this needs raising —
     `forecast_forward()` will throw rather than silently truncate, so it
     will be obvious if it happens.
   - The smallest checkpoint (`google/timesfm-1.0-200m-pytorch`) still needs
     a real download (~800MB) and noticeable CPU time per cycle. On GitHub's
     free runners this may take several minutes for a handful of cycles —
     fine for a once-a-day job, but worth watching the Actions run time for.
3. Once a manual run writes sane-looking rows to `cycle_forecasts`, pin
   `requirements.txt` to the exact versions that worked, and enable the
   scheduled workflow.

## Secrets

Set these as repository secrets (Settings → Secrets and variables → Actions):

| Secret | Where to find it |
| --- | --- |
| `SUPABASE_URL` | Same value as `app/config.js` |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase dashboard → Project Settings → API. **Never** put this in `app/config.js` or anywhere in `app/` — it bypasses every RLS policy in `003_security.sql`. |

## Why two metrics, and why they're shaped differently

- **`feed_bags`** — the real actual is bag-opening events
  (`feed_bag_openings`); `daily_checks.feed_offered_kg` exists in the schema
  but nothing in `app/` ever writes to it, so it's always null and isn't
  usable as a series. Bag openings are lumpy (a bag lasts several days), so
  the daily series is a step function, not a smooth curve — TimesFM has less
  to work with here than a continuous signal, which is why `MIN_DAYS_OF_DATA`
  exists and why this projection should be read as directional, not precise.
- **`mortality`** — `daily_checks.mortality` is reliably recorded (the
  mortality-plausibility trigger in `001_schema.sql` depends on it being
  filled in), so this is a genuinely smooth daily series. There's no stored
  day-by-day mortality curve to compare against, though — only the single
  `mortality_rate` assumption — so the "planned" line here is a straight-line
  spread of that rate across the cycle, a reference, not a real plan like the
  feed side has.
