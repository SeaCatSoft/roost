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

import json
import os
import smtplib
import sys
import urllib.parse
import urllib.request
from datetime import date
from email.message import EmailMessage

REMIND_EVERY_DAYS = 2
DEFAULT_APP_URL = "https://seacatsoft.github.io/roost/app/"


# ---------- Supabase, over plain HTTP ------------------------------------------
class Db:
    def __init__(self, url, key):
        self.base = url.rstrip("/") + "/rest/v1/"
        self.headers = {
            "apikey": key,
            "Authorization": f"Bearer {key}",
            "Content-Type": "application/json",
        }

    def _req(self, method, path, body=None, extra=None):
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(self.base + path, data=data, method=method,
                                     headers={**self.headers, **(extra or {})})
        with urllib.request.urlopen(req, timeout=30) as r:
            raw = r.read()
            return json.loads(raw) if raw else None

    def get(self, table, **params):
        return self._req("GET", f"{table}?{urllib.parse.urlencode(params)}")

    def rpc(self, fn, **args):
        return self._req("POST", f"rpc/{fn}", args)

    def insert(self, table, rows):
        return self._req("POST", table, rows, {"Prefer": "return=minimal"})


# ---------- Deciding what to send ------------------------------------------------
def should_send(alert, last, today):
    if last is None:
        return True
    if alert["level"] == "out" and last["level"] == "low":
        return True
    return (today - date.fromisoformat(last["sent_on"])).days >= REMIND_EVERY_DAYS


def num(n, d=0):
    return f"{float(n):,.{d}f}"


def line_for(a):
    """Same wording as alertText() in app/feedalerts.js."""
    name = a["phase"].lower()
    rate = f"{num(a['bags_per_day'], 1)} bags a day"
    if a["level"] == "out":
        return f"Out of {name}. The store should be empty, and the flock is using about {rate}."
    days = float(a["days_left"])
    if days < 1:
        when = "within a day"
    else:
        runs_out = date.fromisoformat(a["runs_out_on"]).strftime("%a %d %b")
        when = f"in about {num(days, 1 if days < 3 else 0)} days ({runs_out})"
    return f"{a['phase']} runs out {when}: {num(a['on_hand'])} bags left at {rate}."


def subject_for(farm_name, alerts):
    outs = [a["phase"].lower() for a in alerts if a["level"] == "out"]
    if outs:
        return f"{farm_name}: out of {' and '.join(outs)}"
    soonest = min(alerts, key=lambda a: float(a["days_left"]))
    return f"{farm_name}: {soonest['phase'].lower()} feed is running low"


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
    # High priority. Three headers because mail apps never agreed on one:
    # X-Priority for most, Importance for Outlook, X-MSMail-Priority for
    # older Outlook. Gmail ignores all three and decides "important" itself.
    msg["X-Priority"] = "1 (Highest)"
    msg["Importance"] = "High"
    msg["X-MSMail-Priority"] = "High"
    msg.set_content(body_for(farm, alerts, app_url))
    return msg


# ---------- Run ------------------------------------------------------------------
def main():
    dry = "--dry-run" in sys.argv
    db = Db(os.environ["SUPABASE_URL"], os.environ["SUPABASE_SERVICE_ROLE_KEY"])
    app_url = os.environ.get("APP_URL") or DEFAULT_APP_URL
    today = date.today()

    farms = db.get("farms", select="id,name,feed_alert_days", feed_alert_email="is.true")
    outbox = []

    for farm in farms:
        alerts = db.get("v_feed_alerts", select="*", farm_id=f"eq.{farm['id']}",
                        level="in.(low,out)")
        if not alerts:
            continue

        due = []
        for a in alerts:
            last = db.get("feed_alert_emails", select="level,sent_on",
                          farm_id=f"eq.{farm['id']}", phase=f"eq.{a['phase']}",
                          order="created_at.desc", limit="1")
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
    with smtplib.SMTP_SSL("smtp.gmail.com", 465, timeout=30) as smtp:
        smtp.login(user, password)
        for farm, alerts, recipients in outbox:
            smtp.send_message(build_message(user, recipients, farm, alerts, app_url))

            # Logged only after a successful send, so a failed run is retried
            # tomorrow rather than silently marked as done.
            db.insert("feed_alert_emails", [{
                "farm_id": farm["id"], "phase": a["phase"], "level": a["level"],
                "days_left": a["days_left"], "on_hand": a["on_hand"],
                "recipients": len(recipients),
            } for a in alerts])
            print(f"{farm['name']}: emailed {len(recipients)} owner(s) about "
                  f"{', '.join(a['phase'].lower() for a in alerts)}.")


if __name__ == "__main__":
    main()
