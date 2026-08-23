"""
Roost — daily forecast job

Runs once a day (see .github/workflows/forecast.yml). For every open cycle it
forecasts, with Google's TimesFM, where two things are headed by the end of
the grow-out:

  feed_bags  — cumulative bags opened, against the planned bag curve in
               v_cycle_feed_plan / v_cycle_feed_totals. This is the FCR/cost
               side — see backend/README.md's note on the $1,110 loss.
  mortality  — cumulative losses (daily_checks.mortality + culls), against
               the single mortality_rate assumption. This is the revenue side.

Both series are the REAL recorded actuals, not the (currently unused)
feed_offered_kg column — see the note in the repo root conversation this
script came out of: the daily check form never writes feed_offered_kg, so
bag-opening events are the only real feed signal that exists.

This script only ever reads from the normal tables/views with the anon-scoped
service role, and writes to cycle_forecasts (018_forecast.sql). It never
writes anywhere else — a forecasting job overreaching into operational data is
exactly the kind of thing that shouldn't be possible to do by accident, so it
isn't given the columns to do it.

Roost is public — other real farms use it, and this job runs with a
service-role key that sees every one of them. It only processes farms with
farms.forecast_opt_in = true (019_forecast_opt_in.sql), a switch only that
farm's own owner can flip (farm.html). An earlier version of this file used a
FORECAST_FARM_IDS env var/secret for the same purpose, requiring a repo
secret edit to add a farm — that put the decision in this repo's hands
instead of the farm owner's, which was the wrong owner for the decision.

Verified against a live TimesFM 2.5 install on 2026-08-23 (the package jumped
straight from 1.0.0 to 2.0.0+ on PyPI, and 2.x's Python API — from_pretrained()
/ compile() / forecast(horizon=..., inputs=...) — replaced 1.x's TimesFm(
hparams=..., checkpoint=...) constructor entirely; the two are not
interchangeable). Source: google/timesfm-2.5-200m-pytorch's model card and
google-research/timesfm's own SKILL.md, both consistent on the exact call
shape used below. The end-to-end Supabase read/write path is still unverified
as of this pass — see README.md.
"""

import os
import sys
from datetime import date

import numpy as np
from supabase import create_client

# Cycles younger than this have too little context for a forecast to mean
# anything; TimesFM would just be extrapolating noise. Skip them rather than
# writing a row that looks authoritative and isn't.
MIN_DAYS_OF_DATA = 5

TFM_CHECKPOINT = "google/timesfm-2.5-200m-pytorch"


def get_client():
    url = os.environ["SUPABASE_URL"]
    key = os.environ["SUPABASE_SERVICE_ROLE_KEY"]  # bypasses RLS — server-side only
    return create_client(url, key)


def load_model():
    """Loaded once per run, not once per cycle — the checkpoint load and
    compile are the slow part. Import is deferred so `python -m py_compile`
    or a syntax check doesn't require torch installed.

    max_horizon=256 covers every remaining-days value this job will ever ask
    for (cycles.target_sale_age tops out at 120), so — unlike 1.x, where the
    model's horizon was fixed at construction and had to be sized in advance —
    there's no equivalent truncation risk here: horizon is passed explicitly
    per forecast() call in forecast_forward() below.

    infer_is_positive=True fits both our series (bag counts, cumulative
    losses are never negative) but is a hint, not a guarantee — the manual
    clamp in forecast_forward() still does the real enforcing."""
    import torch
    import timesfm

    torch.set_float32_matmul_precision("high")
    model = timesfm.TimesFM_2p5_200M_torch.from_pretrained(TFM_CHECKPOINT)
    model.compile(timesfm.ForecastConfig(
        max_context=1024,
        max_horizon=256,
        normalize_inputs=True,
        use_continuous_quantile_head=True,
        force_flip_invariance=True,
        infer_is_positive=True,
        fix_quantile_crossing=True,
    ))
    return model


def forecast_forward(model, context, remaining_days):
    """context: 1-D array of daily cumulative values, oldest first, one per
    day so far (forward-filled — no gaps). Returns `remaining_days` forecast
    values continuing the series. Clamped to be non-decreasing and floored at
    the last actual value, because TimesFM has no idea this series is a
    cumulative count and won't enforce that on its own."""
    if remaining_days <= 0:
        return np.array([])

    point_forecast, _ = model.forecast(
        horizon=remaining_days, inputs=[np.asarray(context, dtype=float)])
    forecast = np.asarray(point_forecast[0][:remaining_days], dtype=float)

    floor = context[-1]
    out = np.maximum.accumulate(np.maximum(forecast, floor))
    return out


def day_of_cycle(placed_on: date, on: date) -> int:
    return (on - placed_on).days + 1


def build_daily_series(events_by_day: dict, as_of_day: int, start_value=0):
    """events_by_day: {day_number: value added that day}. Returns a forward-
    filled cumulative array for day 1..as_of_day (index 0 = day 1)."""
    out = np.zeros(as_of_day, dtype=float)
    running = start_value
    for d in range(1, as_of_day + 1):
        running += events_by_day.get(d, 0)
        out[d - 1] = running
    return out


def planned_feed_curve(plan_rows, bag_size_kg, target_sale_age):
    """Day-by-day planned cumulative bags, spread across each week exactly as
    dashboard.js's renderFeed() does it — same weekly_kg divided evenly across
    its 7 days — so the chart's plan line matches what the dashboard already
    shows for the current day."""
    out = np.zeros(target_sale_age, dtype=float)
    cumulative_kg = 0.0
    for week_row in sorted(plan_rows, key=lambda r: r["week"]):
        week_kg = float(week_row["weekly_kg"])
        for offset in range(7):
            day = (week_row["week"] - 1) * 7 + offset + 1
            if day > target_sale_age:
                break
            cumulative_kg += week_kg / 7
            out[day - 1] = cumulative_kg / bag_size_kg
    # Fill any tail past the last defined week with its last value rather
    # than zero, so target_sale_age beyond the curve's coverage doesn't read
    # as "plan is zero bags."
    last = 0.0
    for i in range(target_sale_age):
        last = out[i] if out[i] > 0 else last
        out[i] = last
    return out


def make_series_payload(as_of_day, target_sale_age, actual, planned_full, forecast):
    """actual/forecast are aligned to day 1..as_of_day and as_of_day+1..target
    respectively; planned_full covers day 1..target already."""
    points = []
    for day in range(1, target_sale_age + 1):
        points.append({
            "day": day,
            "actual": round(float(actual[day - 1]), 2) if day <= as_of_day else None,
            "planned": round(float(planned_full[day - 1]), 2),
            "forecast": round(float(forecast[day - as_of_day - 1]), 2) if day > as_of_day else None,
        })
    return points


def upsert(db, cycle_id, metric, as_of_day, projected_total, planned_total, series):
    deviation_pct = (
        (projected_total - planned_total) / planned_total * 100
        if planned_total else 0.0
    )
    db.table("cycle_forecasts").upsert({
        "cycle_id": cycle_id,
        "metric": metric,
        "as_of_day": as_of_day,
        "projected_total": round(float(projected_total), 4),
        "planned_total": round(float(planned_total), 4),
        "deviation_pct": round(float(deviation_pct), 2),
        "series": series,
    }, on_conflict="cycle_id,metric,as_of_day").execute()


def process_feed(db, model, cycle):
    cycle_id = cycle["id"]
    placed_on = date.fromisoformat(cycle["placed_on"])
    target = cycle["target_sale_age"]
    as_of_day = min(day_of_cycle(placed_on, date.today()), target)
    if as_of_day < MIN_DAYS_OF_DATA:
        return f"skipped: only {as_of_day} day(s) old, need {MIN_DAYS_OF_DATA}"

    assumptions = db.table("cycle_assumptions").select("bag_size_kg") \
        .eq("cycle_id", cycle_id).maybe_single().execute().data
    bag_size_kg = float(assumptions["bag_size_kg"]) if assumptions else 30.0

    openings = db.table("feed_bag_openings").select("opened_on") \
        .eq("cycle_id", cycle_id).execute().data
    if not openings:
        # A cycle this many days in cannot physically have opened zero bags —
        # the birds are being fed regardless of whether the checkbox is
        # ticked. Zero here means "nobody has logged a bag yet," not "feed
        # use is zero," and writing a confident-looking forecast off that
        # would be worse than writing none: -100% deviation reads as a
        # result, not as a missing-data flag.
        return "skipped: no bag-opening events recorded for this cycle"
    events_by_day = {}
    for row in openings:
        d = day_of_cycle(placed_on, date.fromisoformat(row["opened_on"]))
        if 1 <= d <= as_of_day:
            events_by_day[d] = events_by_day.get(d, 0) + 1
    actual = build_daily_series(events_by_day, as_of_day)

    plan_rows = db.table("v_cycle_feed_plan").select("week, weekly_kg") \
        .eq("cycle_id", cycle_id).execute().data
    if not plan_rows:
        return "skipped: no feed_intake_curve entered for this cycle"
    planned_full = planned_feed_curve(plan_rows, bag_size_kg, target)

    totals = db.table("v_cycle_feed_totals").select("total_bags") \
        .eq("cycle_id", cycle_id).maybe_single().execute().data
    planned_total = float(totals["total_bags"]) if totals and totals.get("total_bags") else planned_full[-1]

    remaining = target - as_of_day
    forecast = forecast_forward(model, actual, remaining) if remaining > 0 else np.array([])
    projected_total = forecast[-1] if len(forecast) else actual[-1]

    series = make_series_payload(as_of_day, target, actual, planned_full, forecast)
    upsert(db, cycle_id, "feed_bags", as_of_day, projected_total, planned_total, series)
    return f"written: day {as_of_day}, projected {projected_total:.1f} vs planned {planned_total:.1f}"


def process_mortality(db, model, cycle):
    cycle_id = cycle["id"]
    placed_on = date.fromisoformat(cycle["placed_on"])
    target = cycle["target_sale_age"]
    birds_placed = cycle["birds_placed"]
    as_of_day = min(day_of_cycle(placed_on, date.today()), target)
    if as_of_day < MIN_DAYS_OF_DATA:
        return f"skipped: only {as_of_day} day(s) old, need {MIN_DAYS_OF_DATA}"

    assumptions = db.table("cycle_assumptions").select("mortality_rate") \
        .eq("cycle_id", cycle_id).maybe_single().execute().data
    mortality_rate = float(assumptions["mortality_rate"]) if assumptions else 0.05
    planned_total = birds_placed * mortality_rate

    checks = db.table("daily_checks").select("day_number, mortality, culls") \
        .eq("cycle_id", cycle_id).lte("day_number", as_of_day).execute().data
    if not checks:
        # Unlike the feed side, actual mortality legitimately can be zero —
        # a clean cycle with no losses is a real, good outcome. What can't be
        # trusted is zero because no daily check was ever logged: that's the
        # same "nobody recorded anything" gap as the feed guard above, just
        # silent here because 0 losses looks identical to 0 rows. Checking
        # for at least one row (not what it contains) is what tells the two
        # apart.
        return "skipped: no daily checks recorded for this cycle"
    events_by_day = {r["day_number"]: r["mortality"] + r["culls"] for r in checks}
    actual = build_daily_series(events_by_day, as_of_day)

    # No stored day-by-day mortality curve exists — unlike feed, there is
    # only a single target rate. Spreading it in a straight line across the
    # cycle is a reference for the chart, not a real plan, and is labelled
    # that way wherever it's shown.
    planned_full = np.linspace(planned_total / target, planned_total, target)

    remaining = target - as_of_day
    cap = birds_placed - actual[-1]  # can't lose more birds than remain
    forecast = forecast_forward(model, actual, remaining) if remaining > 0 else np.array([])
    if len(forecast):
        forecast = np.minimum(forecast, actual[-1] + max(cap, 0))
    projected_total = forecast[-1] if len(forecast) else actual[-1]

    series = make_series_payload(as_of_day, target, actual, planned_full, forecast)
    upsert(db, cycle_id, "mortality", as_of_day, projected_total, planned_total, series)
    return f"written: day {as_of_day}, projected {projected_total:.1f} vs planned {planned_total:.1f}"


def main():
    db = get_client()

    # This runs with the service-role key, which sees every farm on the
    # platform, not just any one owner's — Roost is public and other real
    # people sign up and use it. Only a farm whose own owner has opted in
    # (farms.forecast_opt_in, flipped from farm.html) gets processed; no
    # opted-in farms means no farms run, not "run for everyone."
    farm_ids = [f["id"] for f in db.table("farms").select("id")
                .eq("forecast_opt_in", True).execute().data]
    if not farm_ids:
        print("No farms have forecast_opt_in set — nothing to do.")
        return

    cycles = db.table("cycles").select("id, farm_id, placed_on, target_sale_age, birds_placed") \
        .is_("closed_at", "null").in_("farm_id", farm_ids).execute().data

    if not cycles:
        print(f"No open cycles for opted-in farm_id in {farm_ids} — nothing to forecast.")
        return

    model = load_model()

    for cycle in cycles:
        try:
            feed_result = process_feed(db, model, cycle)
            mort_result = process_mortality(db, model, cycle)
            # Both return a description of what actually happened — "written:
            # ..." or "skipped: ..." — never a bare success/failure, so this
            # line can't say "forecast written" when nothing was.
            print(f"cycle {cycle['id']}: feed_bags — {feed_result}")
            print(f"cycle {cycle['id']}: mortality — {mort_result}")
        except Exception as e:
            # One cycle's bad data (e.g. no plan entered yet) shouldn't stop
            # the rest of the farm's forecasts from being written.
            print(f"cycle {cycle['id']}: error — {e}", file=sys.stderr)


if __name__ == "__main__":
    main()
