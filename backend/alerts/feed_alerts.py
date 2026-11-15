"""
Roost — low-feed alert emails.

Run once a day by .github/workflows/feed-alerts.yml. Reads v_feed_alerts
(027_feed_alerts.sql) — the view the screens use, so this email and the
dashboard banner can never disagree about whether feed is low — and emails
each farm's owners through Gmail.

Not sending the same thing every morning matters as much as sending at all;
an alert that arrives daily gets filtered and then ignored. A ration is
emailed when:
  * it has not been emailed before, or
  * it got worse (low -> out), or
  * REMIND_EVERY_DAYS have passed and it is still low or out.

Standard library only, so the job starts in seconds — nothing to install.

Environment:
  SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY   same secrets the forecast job uses
  GMAIL_USER                                the Gmail address to send from
  GMAIL_APP_PASSWORD                        a Google app password for it —
                                            never the account's real password
  APP_URL                                   optional, for the link in the email

  --dry-run   print what would be sent, send nothing, log nothing.
"""

import os
import sys
from datetime import date
from email.message import EmailMessage

from mailer import DEFAULT_APP_URL, Db, allowed_farms, gmail, mark_high_priority

REMIND_EVERY_DAYS = 2

# ---------- Deciding what to send ------------------------------------------------
def should_send(alert, last, today):
    if last is None:
        return True
    if alert["level"] == "out" and last["level"] == "low":
        return True
    return (today - date.fromisoformat(last["sent_on"])).days >= REMIND_EVERY_DAYS


def num(n, d=0):
    return f"{float(n):,.{d}f}"


def several_stores(alerts):
    """From 031 each pen has its own store and the rows say which. With one
    store on the farm, naming the pen would only be noise."""
    return len({a["house_id"] for a in alerts
                if a.get("house_id") is not None and a.get("pen_active") is not False}) > 1


def what(a):
    """'grower', or 'Pen 2 grower' on a farm with more than one store.
    main() blanks pen_name when the farm has a single store."""
    name = a["phase"].lower()
    return f"{a['pen_name']} {name}" if a.get("pen_name") else name


def line_for(a):
    """Same wording as alertText() in app/feedalerts.js."""
    name = a["phase"].lower()
    rate = f"{num(a['bags_per_day'], 1)} bags a day"
    if a.get("pen_name"):
        pen = a["pen_name"]
        if a["level"] == "out":
            return f"{pen}: out of {name}. Its store should be empty, and the flock is using about {rate}."
        return f"{pen}: {name} runs out {when_for(a)}: {num(a['on_hand'])} bags left at {rate}."
    if a["level"] == "out":
        return f"Out of {name}. The store should be empty, and the flock is using about {rate}."
    return f"{a['phase']} runs out {when_for(a)}: {num(a['on_hand'])} bags left at {rate}."


def when_for(a):
    days = float(a["days_left"])
    if days < 1:
        return "within a day"
    runs_out = date.fromisoformat(a["runs_out_on"]).strftime("%a %d %b")
    return f"in about {num(days, 1 if days < 3 else 0)} days ({runs_out})"


def subject_for(farm_name, alerts):
    outs = [what(a) for a in alerts if a["level"] == "out"]
    if outs:
        return f"{farm_name}: out of {' and '.join(outs)}"
    soonest = min(alerts, key=lambda a: float(a["days_left"]))
    return f"{farm_name}: {what(soonest)} feed is running low"


def body_for(farm, alerts, app_url):
    lines = [line_for(a) for a in alerts]
    return (
        f"Feed in the store at {farm['name']} needs restocking.\n\n"
        + "\n".join(f"  • {l}" for l in lines)
        + "\n\nDays left are worked out from the bags ticked as opened on the daily "
        "check over the last week. If a number looks wrong, a delivery may not have "
        "been logged, or the store may need recounting.\n\n"
        f"Feed store: {app_url.rstrip('/')}/feedstore.html\n\n"
        f"You get this because you are an owner of {farm['name']} in Roost. "
        f"You are warned when any ration has less than {farm['feed_alert_days']} "
        "days left; the owner can change that, or turn these emails off, on the "
        "feed store screen.\n"
    )


def build_message(sender, recipients, farm, alerts, app_url):
    msg = EmailMessage()
    msg["From"] = f"Roost <{sender}>"
    msg["To"] = sender
    # Owners in Bcc, so no owner's address is shown to another.
    msg["Bcc"] = ", ".join(recipients)
    msg["Subject"] = subject_for(farm["name"], alerts)
    mark_high_priority(msg)
    msg.set_content(body_for(farm, alerts, app_url))
    return msg


# ---------- Run ------------------------------------------------------------------
def main():
    dry = "--dry-run" in sys.argv
    db = Db(os.environ["SUPABASE_URL"], os.environ["SUPABASE_SERVICE_ROLE_KEY"])
    app_url = os.environ.get("APP_URL") or DEFAULT_APP_URL
    today = date.today()

    farms = allowed_farms(db.get("farms", select="id,name,feed_alert_days", feed_alert_email="is.true"),
                          dry=dry)
    outbox = []

    for farm in farms:
        # Every store on the farm, so the wording can tell one store from
        # several; only the low and out ones are written about.
        stores = db.get("v_feed_alerts", select="*", farm_id=f"eq.{farm['id']}")
        named = several_stores(stores)
        alerts = [a for a in stores if a["level"] in ("low", "out")]
        if not alerts:
            continue
        if not named:
            for a in alerts:
                a["pen_name"] = None

        due = []
        for a in alerts:
            # Per pen once the stores are per pen (031): grower already
            # reported in one pen must not silence grower in another. Emails
            # sent before 031 carry no pen and count for the farm's first
            # pen, which is where 031 put the store they were about.
            mine = {"farm_id": f"eq.{farm['id']}", "phase": f"eq.{a['phase']}"}
            if named:
                first = min(s["house_id"] for s in stores)
                mine["or"] = (f"(house_id.eq.{a['house_id']},house_id.is.null)"
                              if a["house_id"] == first else f"(house_id.eq.{a['house_id']})")
            last = db.get("feed_alert_emails", select="level,sent_on",
                          order="created_at.desc", limit="1", **mine)
            if should_send(a, last[0] if last else None, today):
                due.append(a)
        if not due:
            print(f"{farm['name']}: low/out already reported recently — nothing new.")
            continue

        # Every urgent ration goes in the email, not just the one that
        # triggered it, so the reader sees the whole store at once.
        alerts.sort(key=lambda a: (a["level"] != "out", float(a["days_left"] or 0)))
        recipients = db.rpc("farm_owner_emails", p_farm_id=farm["id"]) or []
        if not recipients:
            print(f"{farm['name']}: feed is low but the farm has no owner email to send to.")
            continue

        outbox.append((farm, alerts, recipients))

    if not outbox:
        print("No emails to send.")
        return

    if dry:
        for farm, alerts, recipients in outbox:
            print(f"--- would send to {len(recipients)} owner(s) of {farm['name']}")
            print("Subject:", subject_for(farm["name"], alerts))
            print(body_for(farm, alerts, app_url))
        return

    user, password = os.environ["GMAIL_USER"], os.environ["GMAIL_APP_PASSWORD"]
    with gmail(user, password) as smtp:
        for farm, alerts, recipients in outbox:
            smtp.send_message(build_message(user, recipients, farm, alerts, app_url))

            # Logged only after a successful send, so a failed run is retried
            # tomorrow rather than silently marked as done.
            db.insert("feed_alert_emails", [{
                "farm_id": farm["id"], "phase": a["phase"], "level": a["level"],
                "days_left": a["days_left"], "on_hand": a["on_hand"],
                "recipients": len(recipients),
                # Only once 031 has given the log its pen column.
                **({"house_id": a["house_id"]} if a.get("house_id") is not None else {}),
            } for a in alerts])
            print(f"{farm['name']}: emailed {len(recipients)} owner(s) about "
                  f"{', '.join(what(a) for a in alerts)}.")


if __name__ == "__main__":
    main()
