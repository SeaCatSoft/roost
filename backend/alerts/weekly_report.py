"""
Roost — the Monday weekly report.

Run every Monday by .github/workflows/weekly-report.yml. Covers the week just
ended, Monday to Sunday, and emails each farm's owners four things:

  Costs     what was spent this week, and the cycle so far against the
            planner's figures (v_cycle_cost_compare, 029)
  Flock     birds alive, losses this week, latest weight against the breed
            standard, feed conversion
  Feed      bags in the store, used this week, days left (v_feed_alerts, 027)
  Money in  invoices raised and payments received this week, and what is
            still owed

Every figure is read from the same views the app uses, so the email can never
tell a different story from the screens.

  --dry-run           print the report, send nothing, log nothing
  --only-me           send only to GMAIL_USER and log nothing — for checking
                      how it looks without emailing the other owners
  --week-ending DATE  report a different week (a Sunday, YYYY-MM-DD)
  --force             send even if this week was already sent
"""

import html
import os
import sys
from datetime import date, timedelta
from email.message import EmailMessage

from mailer import DEFAULT_APP_URL, Db, gmail

LABELS = {
    "chicks": "Chicks", "feed": "Feed", "bedding": "Bedding", "medication": "Medication",
    "utilities": "Utilities", "labour": "Labour", "processing": "Processing", "misc": "Other",
}

# Ross 308 as-hatched, grams by day — the same table as BREED_STANDARD in
# app/db.js. If that one changes, change this one.
BREED_STANDARD = {0: 42, 7: 185, 14: 465, 21: 940, 28: 1560, 35: 2270, 42: 2980}


def standard_at(day):
    keys = sorted(BREED_STANDARD)
    if day <= keys[0]:
        return BREED_STANDARD[keys[0]]
    if day >= keys[-1]:
        return BREED_STANDARD[keys[-1]]
    for a, b in zip(keys, keys[1:]):
        if a <= day <= b:
            return BREED_STANDARD[a] + (BREED_STANDARD[b] - BREED_STANDARD[a]) * (day - a) / (b - a)


def money(n, d=0):
    n = float(n or 0)
    return f"{'−' if n < 0 else ''}${abs(n):,.{d}f}"


def num(n, d=0):
    return f"{float(n or 0):,.{d}f}"


def fmt_day(d):
    return d.strftime("%a %d %b")


def between(col, start, end):
    return [(col, f"gte.{start.isoformat()}"), (col, f"lte.{end.isoformat()}")]


# ---------- Gathering ------------------------------------------------------------
def gather(db, farm, start, end):
    """Everything the report says, as plain data. Sections with nothing to
    say come back as None and are left out of the email."""
    fid = farm["id"]
    r = {"farm": farm, "start": start, "end": end}

    # The cycle that was running during the week: placed by its end, and not
    # closed before it began.
    cycles = db.get("cycles", select="id,label,placed_on,target_sale_age,birds_placed,closed_at",
                    farm_id=f"eq.{fid}", placed_on=f"lte.{end.isoformat()}",
                    order="placed_on.desc", limit="1")
    cycle = cycles[0] if cycles else None
    if cycle and cycle["closed_at"] and cycle["closed_at"][:10] < start.isoformat():
        cycle = None
    r["cycle"] = cycle

    # ---- Costs
    week_feed = db.get("feed_purchases", between("purchased_on", start, end),
                       select="bags,cost_per_bag", farm_id=f"eq.{fid}")
    week_lines = db.get("cost_lines", between("incurred_on", start, end),
                        select="category,amount,bedding_kind,quantity,unit,incurred_on", farm_id=f"eq.{fid}")
    week_by_cat = {}
    for p in week_feed:
        week_by_cat["feed"] = week_by_cat.get("feed", 0) + float(p["bags"]) * float(p["cost_per_bag"])
    for l in week_lines:
        week_by_cat[l["category"]] = week_by_cat.get(l["category"], 0) + float(l["amount"])

    compare, pnl = [], None
    if cycle:
        compare = db.get("v_cycle_cost_compare", select="category,planned,actual",
                         cycle_id=f"eq.{cycle['id']}", order="sort_order")
        pnl_rows = db.get("v_cycle_pnl", select="revenue,total_cost,operating_profit",
                          cycle_id=f"eq.{cycle['id']}")
        pnl = pnl_rows[0] if pnl_rows else None
    r["costs"] = {"week": week_by_cat, "compare": compare, "pnl": pnl,
                  "bedding": [l for l in week_lines if l["category"] == "bedding"]}

    # ---- Flock
    r["flock"] = None
    if cycle:
        placed = date.fromisoformat(cycle["placed_on"])
        day_of = lambda d: (d - placed).days + 1
        d0, d1 = max(day_of(start), 1), day_of(end)

        prog = db.get("v_cycle_progress", select="birds_alive,losses,mortality_to_date",
                      cycle_id=f"eq.{cycle['id']}")
        prog = prog[0] if prog else {}
        checks = db.get("daily_checks", [("day_number", f"gte.{d0}"), ("day_number", f"lte.{d1}")],
                        select="day_number,mortality,culls", cycle_id=f"eq.{cycle['id']}")
        week_losses = sum(int(c["mortality"] or 0) + int(c["culls"] or 0) for c in checks)
        by_day = {start + timedelta(days=i): 0 for i in range(7)}
        for c in checks:
            d = placed + timedelta(days=int(c["day_number"]) - 1)
            if d in by_day:
                by_day[d] += int(c["mortality"] or 0) + int(c["culls"] or 0)

        sample = db.get("sample_weights", select="day_number,avg_weight_g",
                        cycle_id=f"eq.{cycle['id']}", day_number=f"lte.{d1}",
                        order="day_number.desc", limit="1")
        sample = sample[0] if sample else None

        assume = db.get("cycle_assumptions", select="bag_size_kg", cycle_id=f"eq.{cycle['id']}")
        bag_kg = float(assume[0]["bag_size_kg"]) if assume else 30.0
        opened = db.get("feed_bag_openings", select="opened_on",
                        cycle_id=f"eq.{cycle['id']}", opened_on=f"lte.{end.isoformat()}")
        bags_total = len(opened)
        bags_week = sum(1 for o in opened if o["opened_on"] >= start.isoformat())

        alive = int(prog.get("birds_alive") or cycle["birds_placed"])
        fcr = None
        if sample and alive:
            live_kg = alive * float(sample["avg_weight_g"]) / 1000
            fcr = (bags_total * bag_kg) / live_kg if live_kg else None

        r["flock"] = {
            "day": min(d1, cycle["target_sale_age"]), "target": cycle["target_sale_age"],
            "alive": alive, "placed": cycle["birds_placed"],
            "week_losses": week_losses, "mortality": prog.get("mortality_to_date"),
            "by_day": by_day, "placed_on": placed,
            "sample": sample, "fcr": fcr, "bags_week": bags_week,
        }

    # ---- Feed store
    alerts = db.get("v_feed_alerts", select="phase,on_hand,bags_per_day,days_left,level",
                    farm_id=f"eq.{fid}")
    week_open = {}
    if cycle:
        for o in db.get("feed_bag_openings", between("opened_on", start, end),
                        select="phase", cycle_id=f"eq.{cycle['id']}"):
            week_open[o["phase"]] = week_open.get(o["phase"], 0) + 1
    order = {"Starter": 0, "Grower": 1, "Finisher": 2}
    r["feed"] = sorted([dict(a, used=week_open.get(a["phase"], 0)) for a in alerts],
                       key=lambda a: order.get(a["phase"], 9))

    # ---- Money in
    raised = db.get("v_invoices", between("issued_on", start, end),
                    select="total,status", farm_id=f"eq.{fid}", status="eq.sent")
    paid = db.get("payments", between("paid_on", start, end),
                  select="amount,invoices!inner(farm_id)", **{"invoices.farm_id": f"eq.{fid}"})
    ageing = db.get("v_invoice_ageing", select="*", farm_id=f"eq.{fid}")
    ageing = ageing[0] if ageing else {}
    overdue = sum(float(ageing.get(k) or 0) for k in ("d1_30", "d31_60", "d61_90", "d90_plus"))
    r["money"] = {
        "raised_n": len(raised), "raised": sum(float(i["total"]) for i in raised),
        "paid_n": len(paid), "paid": sum(float(p["amount"]) for p in paid),
        "owed": float(ageing.get("outstanding") or 0), "overdue": overdue,
        "open": int(ageing.get("open_invoices") or 0),
        "current": float(ageing.get("current") or 0),
    }
    return r


# ---------- Writing ------------------------------------------------------------
def sections(r):
    """The report as (key, title, rows, note) — rendered to both HTML and plain
    text from this one structure, so the two can never differ."""
    out = []
    c = r["costs"]

    rows = [(LABELS.get(k, k), money(v, 2)) for k, v in sorted(c["week"].items(), key=lambda kv: -kv[1])]
    rows.append(("Total spent this week", money(sum(c["week"].values()), 2)))
    note = None
    for b in c["bedding"]:
        kind = {"new": "Fresh bed", "top_up": "Bedding top-up"}.get(b["bedding_kind"], "Bedding")
        qty = f", {num(b['quantity'], 1 if float(b['quantity']) % 1 else 0)} {b['unit'] or ''}".rstrip() if b["quantity"] else ""
        note = (note + " " if note else "") + f"{kind} laid {fmt_day(date.fromisoformat(b['incurred_on']))}{qty}."
    out.append(("week", "Spent this week", rows, note))

    if c["compare"]:
        rows = [(LABELS.get(x["category"], x["category"]),
                 f"{money(x['actual'])} of {money(x['planned'])}"
                 + ("  ▲ over" if float(x["actual"]) > float(x["planned"]) + 0.005 else ""))
                for x in c["compare"]]
        spent = sum(float(x["actual"]) for x in c["compare"])
        plan = sum(float(x["planned"]) for x in c["compare"])
        rows.append(("Total so far", f"{money(spent)} of {money(plan)}"))
        note = ("Actual so far against the planner's figure for the whole cycle. Processing and the "
                "last of the feed land near the end, so a cycle normally sits under plan until then.")
        if c["pnl"]:
            note += (f" The planner expects this cycle to finish at {money(c['pnl']['operating_profit'])} "
                     f"({money(c['pnl']['revenue'])} in, {money(c['pnl']['total_cost'])} out).")
        out.append(("cycle", f"Cycle costs — {r['cycle']['label']}", rows, note))

    f = r["flock"]
    if f:
        rows = [("Day", f"{f['day']} of {f['target']}"),
                ("Birds alive", f"{num(f['alive'])} of {num(f['placed'])}"),
                ("Lost this week", num(f["week_losses"]))]
        if f["mortality"] is not None:
            rows.append(("Mortality to date", f"{float(f['mortality']) * 100:.1f}%"))
        if f["sample"]:
            g = float(f["sample"]["avg_weight_g"])
            std = standard_at(int(f["sample"]["day_number"]))
            vs = f" ({'+' if g >= std else '−'}{abs(g / std - 1) * 100:.1f}% vs standard)" if std else ""
            rows.append(("Latest weight", f"{num(g / 1000, 2)} kg on day {f['sample']['day_number']}{vs}"))
        if f["fcr"]:
            rows.append(("Feed conversion", num(f["fcr"], 2)))
        rows.append(("Bags opened this week", num(f["bags_week"])))
        note = None if f["sample"] else "No birds weighed yet this cycle, so there is no weight or feed conversion."
        out.append(("flock", "The flock", rows, note))

    feed_rows = []
    for a in r["feed"]:
        if a["level"] == "idle" and a["used"] == 0 and float(a["on_hand"] or 0) <= 0:
            continue
        if a["level"] == "uncounted":
            feed_rows.append((a["phase"], "store not counted yet"))
            continue
        bits = [f"{num(a['on_hand'])} bags", f"{num(a['used'])} used this week"]
        if a["days_left"] is not None and a["level"] in ("ok", "low", "out"):
            bits.append(f"{num(a['days_left'], 0)} days left")
        flag = {"low": "  ▲ low", "out": "  ▲ out"}.get(a["level"], "")
        feed_rows.append((a["phase"], " · ".join(bits) + flag))
    if feed_rows:
        out.append(("feed", "Feed store", feed_rows, None))

    m = r["money"]
    rows = [("Invoices raised", f"{m['raised_n']} · {money(m['raised'], 2)}"),
            ("Payments received", f"{m['paid_n']} · {money(m['paid'], 2)}"),
            ("Still owed", f"{money(m['owed'], 2)} on {m['open']} invoice{'' if m['open'] == 1 else 's'}")]
    if m["overdue"] > 0.005:
        rows.append(("Of which overdue", f"{money(m['overdue'], 2)}  ▲"))
    out.append(("money", "Money in", rows, None))
    return out


def subject(r):
    return f"{r['farm']['name']}: week of {r['start'].strftime('%d %b')}"


def render_text(r, secs, app_url):
    lines = [f"{r['farm']['name']} — week {fmt_day(r['start'])} to {fmt_day(r['end'])}", ""]
    for _key, title, rows, note in secs:
        lines.append(title.upper())
        w = max(len(k) for k, _ in rows)
        lines += [f"  {k.ljust(w)}  {v}" for k, v in rows]
        if note:
            lines.append(f"  {note}")
        lines.append("")
    lines.append(f"Open Roost: {app_url}")
    lines.append("You get this because you are an owner. Turn it off on the Expenses screen.")
    return "\n".join(lines)


# ---------- The HTML email ------------------------------------------------------
# Gmail strips SVG and scripts, so every chart here is plain table cells with
# background colours and percentage widths — the one chart technique every
# mail app draws the same. Colours are the same fixed per-category slots as
# the app (validated categorical palette, light steps); text never wears a
# series colour. Each chart sits above the rows that state its numbers, so
# the figures are always readable without the colour.
CAT_HEX = {"chicks": "#2a78d6", "feed": "#eb6834", "bedding": "#1baf7a", "medication": "#eda100",
           "utilities": "#e87ba4", "labour": "#008300", "processing": "#6250d6", "misc": "#e34948"}
CAT_OF = {v: k for k, v in LABELS.items()}
INK, INK2, INK3, TRACK, LINE = "#1d1d1f", "#424245", "#6e6e73", "#ecebe6", "#d2d2d7"
GOOD, WARNING, CRITICAL = "#0ca30c", "#fab219", "#d03b3b"
FONT = "-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif"
e = html.escape


def _table(inner, style=""):
    return (f'<table role="presentation" cellpadding="0" cellspacing="0" border="0" '
            f'style="width:100%;border-collapse:collapse;{style}">{inner}</table>')


def _chip(hex_):
    return (f'<span style="display:inline-block;width:10px;height:10px;border-radius:3px;'
            f'background:{hex_};margin-right:6px;vertical-align:-1px"></span>')


def _bar(segments, height=10, track=TRACK):
    """One horizontal bar from (percent, colour) segments, on a track.
    A white 2px cell between segments is the gap."""
    cells, used = [], 0
    for i, (pct, col) in enumerate(seg for seg in segments if seg[0] > 0.2):
        if i:
            cells.append('<td width="2" style="width:2px;background:#ffffff"><div style="width:2px;font-size:0;line-height:0">&nbsp;</div></td>')
        cells.append(f'<td style="width:{pct:.2f}%;background:{col};height:{height}px"></td>')
        used += pct
    if used < 99.8:
        cells.append(f'<td style="background:{track}"></td>')
    return _table(f'<tr style="height:{height}px">{"".join(cells)}</tr>',
                  f"border-radius:{height // 2}px;overflow:hidden")


def chart_week(r):
    week = r["costs"]["week"]
    total = sum(week.values())
    if total <= 0:
        return ""
    segs = [(week[c] / total * 100, CAT_HEX[c]) for c in CAT_HEX if week.get(c)]
    return f'<div style="margin:4px 0 10px">{_bar(segs, 14)}</div>'


def chart_cycle(r):
    """Each cost against its own plan. The left 80% of the track is the plan;
    the right 20% is room to show going over, past a dark tick."""
    out = []
    for x in r["costs"]["compare"]:
        p, a = float(x["planned"]), float(x["actual"])
        frac = min(a / p, 1.25) if p > 0 else (1.25 if a > 0 else 0)
        under = min(frac, 1) * 100
        over = max(frac - 1, 0) / 0.25 * 100
        col = CAT_HEX[x["category"]]
        is_over = a > p + 0.005
        val = f"{'▲ ' if is_over else ''}{money(a)} of {money(p)}"
        plan_zone = _bar([(under, col)], 8)
        over_zone = _bar([(over, CRITICAL)], 8, track="#f6f5f1")
        out.append(
            f'<tr><td style="padding:8px 0 3px;font-size:13px;color:{INK2}">{e(LABELS[x["category"]])}</td>'
            f'<td style="padding:8px 0 3px;font-size:13px;text-align:right;'
            f'color:{"#8a3a00" if is_over else INK3};{"font-weight:600" if is_over else ""}">{e(val)}</td></tr>'
            f'<tr><td colspan="2">' + _table(
                f'<tr><td style="width:80%">{plan_zone}</td>'
                f'<td width="2" style="width:2px"><div style="width:2px;height:14px;background:{INK};font-size:0;line-height:0">&nbsp;</div></td>'
                f'<td style="width:20%;padding-left:2px">{over_zone}</td></tr>') + '</td></tr>')
    spent = sum(float(x["actual"]) for x in r["costs"]["compare"])
    plan = sum(float(x["planned"]) for x in r["costs"]["compare"])
    head = (f'<p style="margin:2px 0 6px;font-size:13px;color:{INK3}">'
            f'<span style="font-size:24px;font-weight:700;color:{INK}">{money(spent)}</span>'
            f' spent of {money(plan)} planned ({spent / plan * 100 if plan else 0:.0f}%)</p>')
    key = (f'<p style="margin:8px 0 0;font-size:12px;color:{INK3}">The dark tick is the plan for the whole cycle; '
           f'red past it is spending over plan.</p>')
    return head + _table("".join(out)) + key


def chart_flock(r):
    f = r["flock"]
    days = sorted(f["by_day"].items())
    peak = max([v for _, v in days] + [1])
    cols, labels = [], []
    for d, v in days:
        h = round(v / peak * 48) if v else 0
        bar = (f'<div style="height:{h}px;background:{CAT_HEX["chicks"]};border-radius:4px 4px 0 0;'
               f'margin:0 4px"></div>' if h else
               f'<div style="height:2px;background:{LINE};margin:0 4px"></div>')
        cols.append(f'<td style="vertical-align:bottom;text-align:center;height:66px;font-size:11px;color:{INK2}">'
                    f'<div style="margin-bottom:3px">{v}</div>{bar}</td>')
        labels.append(f'<td style="text-align:center;font-size:11px;color:{INK3};padding-top:4px">{d.strftime("%a")}</td>')
    return (f'<p style="margin:0 0 4px;font-size:12px;color:{INK3}">Birds lost each day</p>'
            + _table(f'<tr>{"".join(cols)}</tr><tr>{"".join(labels)}</tr>',
                     f"border-bottom:1px solid {LINE};margin-bottom:10px"))


def chart_feed(r):
    window = float(r["farm"].get("feed_alert_days") or 7)
    out = []
    for a in r["feed"]:
        if a["level"] not in ("ok", "low", "out") or a["days_left"] is None:
            continue
        days = float(a["days_left"])
        pct = min(days / (window * 2), 1) * 100   # the track is two warning windows long
        col = {"ok": GOOD, "low": WARNING, "out": CRITICAL}[a["level"]]
        out.append(
            f'<tr><td style="width:70px;font-size:12px;color:{INK2};padding:4px 0">{e(a["phase"])}</td>'
            f'<td style="padding:4px 8px">' + _table(
                f'<tr><td style="width:50%">{_bar([(min(pct * 2, 100), col)], 8)}</td>'
                f'<td width="2" style="width:2px"><div style="width:2px;height:14px;background:{INK3};font-size:0;line-height:0">&nbsp;</div></td>'
                f'<td style="width:50%;padding-left:2px">{_bar([(max(pct - 50, 0) * 2, col)], 8)}</td></tr>')
            + f'</td><td style="width:70px;text-align:right;font-size:12px;color:{INK2}">{days:.0f} days</td></tr>')
    if not out:
        return ""
    return (_table("".join(out)) +
            f'<p style="margin:4px 0 10px;font-size:12px;color:{INK3}">The tick is your {window:.0f}-day warning; '
            f'a bar short of it is low.</p>')


def chart_money(r):
    m = r["money"]
    if m["owed"] <= 0.005:
        return ""
    cur = max(m["owed"] - m["overdue"], 0)
    return (f'<div style="margin:4px 0 4px">{_bar([(cur / m["owed"] * 100, CAT_HEX["chicks"]), (m["overdue"] / m["owed"] * 100, CRITICAL)], 14)}</div>'
            f'<p style="margin:0 0 10px;font-size:12px;color:{INK3}">{_chip(CAT_HEX["chicks"])}Not yet due {money(cur, 2)}'
            f'&nbsp;&nbsp;&nbsp;{_chip(CRITICAL)}Overdue {money(m["overdue"], 2)}</p>')


CHARTS = {"week": chart_week, "cycle": chart_cycle, "flock": chart_flock, "feed": chart_feed, "money": chart_money}


def _tile(label, value, sub=""):
    return (f'<td style="width:50%;padding:6px"><div style="background:#ffffff;border:1px solid {LINE};'
            f'border-radius:12px;padding:12px 14px"><div style="font-size:12px;color:{INK3}">{e(label)}</div>'
            f'<div style="font-size:22px;font-weight:700;color:{INK};margin-top:2px">{e(value)}</div>'
            f'<div style="font-size:12px;color:{INK3};margin-top:1px">{e(sub)}</div></div></td>')


def render_html(r, secs, app_url):
    c, f, m = r["costs"], r["flock"], r["money"]
    spent = sum(float(x["actual"]) for x in c["compare"])
    plan = sum(float(x["planned"]) for x in c["compare"])
    tiles = _table(
        "<tr>" + _tile("Spent this week", money(sum(c["week"].values())), "feed, bedding and expenses")
        + _tile("Cycle so far", money(spent), f"of {money(plan)} planned" if plan else "") + "</tr><tr>"
        + _tile("Birds alive", num(f["alive"]) if f else "—",
                f"{f['week_losses']} lost this week" if f else "no flock this week")
        + _tile("Owed to you", money(m["owed"]), f"{money(m['overdue'])} overdue" if m["overdue"] > 0.005 else "none overdue")
        + "</tr>", "margin:0 -6px")

    parts = [
        f'<div style="background:#f5f5f7;padding:20px 12px;font-family:{FONT}">'
        f'<div style="max-width:560px;margin:0 auto;color:{INK}">',
        f'<p style="margin:0;font-size:12px;letter-spacing:.04em;text-transform:uppercase;color:#1a7f37;font-weight:600">Weekly report</p>',
        f'<h1 style="font-size:24px;margin:2px 0 2px">{e(r["farm"]["name"])}</h1>',
        f'<p style="margin:0 0 14px;color:{INK3};font-size:14px">{e(fmt_day(r["start"]))} – {e(fmt_day(r["end"]))}</p>',
        tiles,
    ]
    for key, title, rows, note in secs:
        parts.append(f'<div style="background:#ffffff;border:1px solid {LINE};border-radius:14px;padding:16px 18px;margin-top:14px">'
                     f'<h2 style="font-size:16px;margin:0 0 10px">{e(title)}</h2>')
        parts.append(CHARTS[key](r))
        if key != "cycle":   # the cycle chart already states every figure
            body = []
            for i, (k, v) in enumerate(rows):
                last_total = i == len(rows) - 1 and k.lower().startswith("total")
                warn = "▲" in v
                cat = CAT_OF.get(k) if key == "week" else None
                body.append(
                    f'<tr><td style="padding:5px 0;font-size:14px;color:{INK2};border-top:1px solid #f0f0f2;'
                    f'{"font-weight:600;color:" + INK if last_total else ""}">{_chip(CAT_HEX[cat]) if cat else ""}{e(k)}</td>'
                    f'<td style="padding:5px 0;font-size:14px;text-align:right;border-top:1px solid #f0f0f2;'
                    f'{"color:#8a3a00;font-weight:600;" if warn else ""}{"font-weight:600" if last_total else ""}">{e(v)}</td></tr>')
            parts.append(_table("".join(body)))
        if note:
            parts.append(f'<p style="font-size:12px;color:{INK3};margin:10px 0 0;line-height:1.45">{e(note)}</p>')
        parts.append("</div>")
    parts.append(f'<p style="margin:20px 0 0;text-align:center"><a href="{e(app_url)}" style="display:inline-block;'
                 f'background:#1a7f37;color:#ffffff;text-decoration:none;font-weight:600;padding:10px 22px;'
                 f'border-radius:999px;font-size:14px">Open Roost</a></p>'
                 f'<p style="font-size:12px;color:{INK3};text-align:center;margin-top:14px">You get this because you are '
                 f'an owner. Turn it off on the Expenses screen.</p></div></div>')
    return "".join(parts)


def build_message(sender, recipients, r, app_url):
    secs = sections(r)
    msg = EmailMessage()
    msg["From"] = f"Roost <{sender}>"
    msg["To"] = sender
    msg["Bcc"] = ", ".join(recipients)   # owners never see each other's address
    msg["Subject"] = subject(r)
    msg.set_content(render_text(r, secs, app_url))
    msg.add_alternative(render_html(r, secs, app_url), subtype="html")
    return msg


# ---------- Run ------------------------------------------------------------------
def last_full_week(today):
    end = today - timedelta(days=today.weekday() + 1)   # the most recent Sunday before today
    return end - timedelta(days=6), end


def main():
    args = sys.argv[1:]
    dry, only_me, force = "--dry-run" in args, "--only-me" in args, "--force" in args
    if "--week-ending" in args:
        end = date.fromisoformat(args[args.index("--week-ending") + 1])
        start = end - timedelta(days=6)
    else:
        start, end = last_full_week(date.today())

    db = Db(os.environ["SUPABASE_URL"], os.environ["SUPABASE_SERVICE_ROLE_KEY"])
    app_url = os.environ.get("APP_URL") or DEFAULT_APP_URL
    farms = db.get("farms", select="id,name,feed_alert_days", weekly_report_email="is.true")

    outbox = []
    for farm in farms:
        if not (force or dry or only_me) and db.get(
                "weekly_reports", select="id", farm_id=f"eq.{farm['id']}", week_start=f"eq.{start.isoformat()}"):
            print(f"{farm['name']}: week of {start} already sent.")
            continue
        r = gather(db, farm, start, end)
        recipients = db.rpc("farm_owner_emails", p_farm_id=farm["id"]) or []
        if not recipients:
            print(f"{farm['name']}: no owner email to send to.")
            continue
        outbox.append((farm, r, recipients))

    if dry:
        for farm, r, recipients in outbox:
            print(f"--- would send to {len(recipients)} owner(s)\nSubject: {subject(r)}\n")
            print(render_text(r, sections(r), app_url))
        return

    user, password = os.environ["GMAIL_USER"], os.environ["GMAIL_APP_PASSWORD"]
    with gmail(user, password) as smtp:
        for farm, r, recipients in outbox:
            to = [user] if only_me else recipients
            smtp.send_message(build_message(user, to, r, app_url))
            if only_me:
                print(f"{farm['name']}: test report sent to {user} only (not logged).")
                continue
            db.insert("weekly_reports", [{"farm_id": farm["id"], "week_start": start.isoformat(),
                                          "week_end": end.isoformat(), "recipients": len(recipients)}])
            print(f"{farm['name']}: report for week of {start} sent to {len(recipients)} owner(s).")


if __name__ == "__main__":
    main()
