# Roost — forecast job

Runs `forecast.py` once a day via `.github/workflows/forecast.yml`. It uses
Google's [TimesFM](https://github.com/google-research/timesfm) to project,
for each *opted-in* open cycle, where feed-bag usage and mortality are headed
by the end of the grow-out, and writes the result to `cycle_forecasts`
(`018_forecast.sql`). Nothing in the frontend computes a forecast — the app
only reads what this job wrote.

**Status as of 2026-08-23: manually verified end to end against the live
project**, after fixing three real bugs found in that process:

1. The model-loading code was written against TimesFM 1.x's API
   (`TimesFm(hparams=..., checkpoint=...)`). PyPI jumps straight from `1.0.0`
   to `2.0.0`+, and 2.x replaced that API entirely. The installed version is
   `timesfm.TimesFM_2p5_200M_torch.from_pretrained(...)` →
   `.compile(timesfm.ForecastConfig(...))` → `.forecast(horizon=..., inputs=[...])`,
   confirmed against [the model card](https://huggingface.co/google/timesfm-2.5-200m-pytorch)
   and [the repo's own skill doc](https://github.com/google-research/timesfm/blob/master/timesfm-forecasting/SKILL.md).
2. A cycle with zero real activity (no bag-opening events, no daily checks —
   i.e. nobody has logged anything yet) was silently writing a confident
   "-100% under plan" row instead of being recognized as having no data to
   forecast from. Both `process_feed` and `process_mortality` now skip and
   say why, rather than writing zero-as-if-it-were-a-result.
3. `main()`'s log line said "forecast written" unconditionally, even when
   both metrics had silently skipped — which is what let bug #2 go unnoticed
   for a full run. Every cycle now logs one line per metric, `written: ...`
   or `skipped: ...` with the actual reason.

## Farm scoping — read this before touching `FORECAST_FARM_IDS`

Roost is public; people other than you sign up and run real farms on it. This
job runs with the service-role key, which sees every farm on the platform,
not just yours. **It refuses to run at all unless `FORECAST_FARM_IDS` is set**
— no farms opted in is the safe default, not "run for everyone." Set it to a
comma-separated list of `farms.id` values (see the `farms` table) for the
farms you want forecasted. Growing that list to include a farm you don't own
means running an experimental, still-maturing feature against a stranger's
real operational data without asking them — do that deliberately, not by
default.

## First-run checklist

- [x] Ran `018_forecast.sql` in the Supabase SQL editor.
- [x] Ran `forecast.py` by hand against real cycles, found and fixed the three
      bugs above, confirmed the fixed output was correct.
- [ ] **Pin `requirements.txt` to the exact versions that worked** — run
      `pip show timesfm supabase` and replace the ranges below with exact
      pins, now that we know they resolve correctly.
- [ ] Confirm the dashboard card renders correctly against this real data
      (checked so far only against fabricated data — see the PR).
- [ ] Enable the scheduled workflow once the above are done.

## Secrets

Set these as repository secrets (Settings → Secrets and variables → Actions):

| Secret | Where to find it |
| --- | --- |
| `SUPABASE_URL` | Same value as `app/config.js` |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase dashboard → Project Settings → API. **Never** put this in `app/config.js` or anywhere in `app/` — it bypasses every RLS policy in `003_security.sql`. |
| `FORECAST_FARM_IDS` | Comma-separated `farms.id` list, e.g. `1,2`. See "Farm scoping" above — required, job exits immediately without it. |

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
