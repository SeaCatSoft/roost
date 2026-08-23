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

## Farm scoping — an opt-in, not a secret

Roost is public; people other than you sign up and run real farms on it. This
job runs with the service-role key, which sees every farm on the platform,
not just yours. It only processes a farm whose own owner has flipped
**Cycle forecasts (beta)** on, on their My Farm screen (`farm.html`) —
`farms.forecast_opt_in`, added in `019_forecast_opt_in.sql`, default `false`.
No opted-in farms means no farms run.

This used to be a `FORECAST_FARM_IDS` repo secret, requiring *you* to add a
farm to a list by hand. That put the decision in the wrong hands: whether a
farm's real operational data runs through an experimental analytics feature
is the farm owner's call, not something scoped from outside their account.
The secret is no longer read by `forecast.py` and can be deleted from the
repo once you've confirmed the opt-in flow works.

## First-run checklist

- [x] Ran `018_forecast.sql` and `019_forecast_opt_in.sql` in the Supabase
      SQL editor.
- [x] Ran `forecast.py` by hand against real cycles (scoped via the old
      `FORECAST_FARM_IDS` secret at the time), found and fixed the three bugs
      above, confirmed the fixed output was correct.
- [x] Confirmed the dashboard card renders correctly against real data —
      numbers matched a direct SQL query exactly.
- [x] Pinned `requirements.txt` to the exact versions verified
      (`timesfm==2.0.2`, `supabase==2.31.0`).
- [ ] Run `forecast.py` once more now that farm selection reads
      `forecast_opt_in` instead of the env var — confirm a farm with the
      toggle on gets forecasted and one with it off does not.
- [ ] Enable the scheduled workflow once the above is done.

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
