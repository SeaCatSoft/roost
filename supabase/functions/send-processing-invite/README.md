# send-processing-invite

Sends a calendar file for a booked processing day to whoever needs it on
their phone. See [`invite-member`](../invite-member/README.md) and
[`draft-invoice-followup`](../draft-invoice-followup/README.md) for the
project's other Edge Functions and the same "the browser never holds a
secret" reasoning; this one exists for the same reason, with its own secret.

**This one really does send mail on its own — that's a deliberate difference
from `draft-invoice-followup`, not an oversight.** A calendar file cannot be
attached to a `mailto:` link, so "hand it to your own email app" was never an
option here the way it was for follow-ups. `draft-invoice-followup`'s own
README named exactly this trade-off in advance: real sending needs its own
transactional-email provider, its own API key, and (for anyone but yourself)
a verified sending domain. That's the piece this function actually needs.

---

## Deploy it (no CLI needed)

1. Supabase dashboard → **Edge Functions** → **Create a new function**.
2. Name it exactly **`send-processing-invite`** — the app calls it by that name.
3. Paste in the contents of [`index.ts`](./index.ts).
4. Deploy.

`SUPABASE_URL` and `SUPABASE_ANON_KEY` are injected automatically. Two more
settings are not: see below.

---

## Required: a Resend API key

This function sends through [Resend](https://resend.com) — a plain `fetch`
call, no SDK, same style as the Anthropic call in `draft-invoice-followup`.

1. Create a free Resend account.
2. **API Keys** → create one → copy it.
3. In Supabase: **Edge Functions** → **Secrets** → add:
   ```
   RESEND_API_KEY = re_...
   ```

If the key is missing, the function says so plainly — you'll see that message
right on the Processing screen rather than a silent failure.

---

## Required, before long: a verified sending domain

Resend's free tier sends from `onboarding@resend.dev`, but **only to the
email address on your own Resend account** — every other recipient will
bounce or be rejected. That's fine for testing it against yourself; it stops
working the moment you invite anyone else, which is the entire point of this
feature.

To actually reach farm members and a processor's inbox:

1. Resend dashboard → **Domains** → add your own domain (e.g. the one your
   farm's email already uses, or one bought just for this).
2. Add the DNS records Resend gives you (SPF, DKIM — a few TXT/CNAME records
   at your domain registrar).
3. Once verified, set:
   ```
   PROCESSING_INVITE_FROM = Roost <processing@yourdomain.com>
   ```
   as a third secret. Without it, the function falls back to
   `Roost <onboarding@resend.dev>` — fine for a solo test, not for real use.

This is the same "one dashboard setting away from working" trap as the
Supabase Site URL — the code is correct either way, but nobody but you will
actually receive mail until the domain is verified.

---

## What it actually sends

One email per recipient, each with:

- A plain-language line: who booked what, for when, where, and — if the farm
  said so when booking (021_partial_processing.sql) — how many birds. That
  count is exactly what was typed into the booking form, nothing this
  function checks or derives itself; a plan can say 300 and the flock can
  still send 280 on the day.
- A `.ics` calendar file attached — the universal format both iOS Mail and
  Android's calendar apps already know how to open. Tapping it offers
  **Add to Calendar** without needing anything else installed.

**`METHOD:PUBLISH`, not `REQUEST`.** A `REQUEST`-method invite is a meeting
negotiation — it shows "Yes / No / Maybe" buttons on some phones, and tapping
one tries to email a reply back to the organizer. Roost has no inbound mail
handling to receive that reply, so it would go nowhere: a button that looks
like it works and does nothing. `PUBLISH` is the honest choice for
announcing a date, not negotiating one.

**Rescheduling sends an update, not a duplicate.** Every invite for one
booking shares the same calendar UID. Changing the date, time, or location
bumps a sequence number; recipients' phones recognise the new email as an
update to the same event rather than a second one sitting next to it. Editing
only the notes does not bump it — nobody needs their calendar to re-confirm
over a typo fix.

---

## Test it

1. **Processing** screen, as an owner → **Processing day** panel.
2. Pick a date, leave your own email in the recipient list (it's added by
   default from the farm's own member list), **Save & send invites**.
3. Check your inbox — the email should arrive with a `.ics` attachment that
   opens straight into your phone's calendar.
4. Change the date and send again. The same calendar entry should update in
   place rather than a second one appearing.
5. In Supabase, **Table Editor → processing_booking_invites** should show
   `sent_at` stamped and `error` empty for anyone who received it.

---

## What's stored, and what isn't

`processing_bookings` holds one row per cycle — one booking, rescheduled in
place rather than piling up old ones. `processing_booking_invites` holds one
row per person invited, so a bad email address shows up as a named failure
rather than silently vanishing, and adding someone later sends only to them,
not everyone again.
