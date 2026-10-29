"""
Roost — shared plumbing for the emailing jobs (feed_alerts.py, weekly_report.py).

Supabase over plain HTTP and Gmail over SMTP, both standard library only, so
neither job has anything to install.
"""

import json
import os
import smtplib
import urllib.error
import urllib.parse
import urllib.request

DEFAULT_APP_URL = "https://seacatsoft.github.io/roost/app/"


class Db:
    """PostgREST with the service role key — bypasses RLS, so only ever run
    server-side, never shipped to a browser."""

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
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                raw = r.read()
                return json.loads(raw) if raw else None
        except urllib.error.HTTPError as err:
            # Supabase says exactly what is wrong in the body ("column ... does
            # not exist" is nearly always a migration not yet run). A bare
            # "400 Bad Request" in the log says nothing.
            detail = err.read().decode(errors="replace")
            hint = ("\nThis usually means a migration has not been run — check "
                    "backend/migrations/check_all.sql." if "does not exist" in detail else "")
            raise SystemExit(f"Supabase refused {method} {path.split('?')[0]}: {err.code} {detail}{hint}")

    def get(self, table, params=None, **kw):
        """params as a list of pairs when a column is filtered twice
        (e.g. a date range); keyword arguments otherwise."""
        pairs = list(params or []) + list(kw.items())
        return self._req("GET", f"{table}?{urllib.parse.urlencode(pairs)}")

    def rpc(self, fn, **args):
        return self._req("POST", f"rpc/{fn}", args)

    def insert(self, table, rows):
        return self._req("POST", table, rows, {"Prefer": "return=minimal"})


def allowed_farms(farms, dry=False):
    """Only farms named in EMAIL_FARM_IDS are ever emailed — set in the
    workflow files. Roost is multi-farm, and every email goes out from the
    farm operator's own Gmail, so another farm signing up must never start
    receiving mail from that address by default. Unset means nobody: a
    missing setting fails closed, never open."""
    raw = os.environ.get("EMAIL_FARM_IDS", "")
    ids = {int(x) for x in raw.replace(" ", "").split(",") if x.isdigit()}
    keep = []
    for f in farms:
        if f["id"] in ids:
            keep.append(f)
        elif dry:
            print(f"(skipping {f['name']}, farm id {f['id']} — not in EMAIL_FARM_IDS)")
    if not ids:
        print("EMAIL_FARM_IDS is not set, so no farm will be emailed.")
    return keep


def mark_high_priority(msg):
    # Three headers because mail apps never agreed on one: X-Priority for
    # most, Importance for Outlook, X-MSMail-Priority for older Outlook.
    # Gmail ignores all three and decides "important" itself.
    msg["X-Priority"] = "1 (Highest)"
    msg["Importance"] = "High"
    msg["X-MSMail-Priority"] = "High"


def gmail(user, password):
    smtp = smtplib.SMTP_SSL("smtp.gmail.com", 465, timeout=30)
    smtp.login(user, password)
    return smtp
