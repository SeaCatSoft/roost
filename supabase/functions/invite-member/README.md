# invite-member

Sends the actual invite email. The database side of invites (`invite_person`,
`farm_invites`, the trigger that grants access on sign-up) already existed —
this is the one piece that was missing, and the one piece that has to run on
a server rather than a page, because it's the only operation in Roost that
needs the `service_role` key.

Nothing else in this project touches that key. Keep it that way — it bypasses
every row-level security policy this app relies on, and this function is
written so it's used for exactly one thing: sending mail.

---

## Deploy it (no CLI needed)

1. Supabase dashboard → **Edge Functions** → **Create a new function**.
2. Name it exactly **`invite-member`** — the app calls it by that name.
3. Paste in the contents of [`index.ts`](./index.ts).
4. Deploy.

`SUPABASE_URL`, `SUPABASE_ANON_KEY` and `SUPABASE_SERVICE_ROLE_KEY` are
injected automatically into every Edge Function — nothing to configure there.

If you'd rather use the CLI later, this folder is already laid out the way
`supabase functions deploy invite-member` expects, so `supabase link` plus
that one command is all it takes.

---

## One required setting: allow the redirect

This is the step that's easy to miss and produces a confusing failure if
skipped — Supabase will silently ignore the redirect and send the person
somewhere unhelpful instead of `accept-invite.html`.

**Authentication → URL Configuration → Redirect URLs**, add:

```
https://seacatsoft.github.io/roost/app/accept-invite.html
```

(Or `https://seacatsoft.github.io/roost/**` to cover the whole app with one
entry, if your Supabase version supports the wildcard.)

---

## Test it

1. **People** → invite an address you can actually check.
2. Should show *"Invite email sent to ‥"* — if it instead says the function
   couldn't be reached, it isn't deployed yet; go back to the steps above.
3. Check the inbox (and spam). The link lands on `accept-invite.html`, asks
   for a password, then drops them straight into the dashboard.
4. In Supabase, **Authentication → Users** should show the new person
   immediately, marked unconfirmed until they click through.

---

## What each half does, and who is trusted for what

**`invite_person` (already existed, called through the user's own session)**
Validates the email, checks the caller is an owner, records the row in
`farm_invites`. This is `SECURITY DEFINER` in the database and re-checks
ownership itself — the Edge Function adds no authority beyond what the
caller already has when calling it directly. If someone hits this function
without being signed in as an owner, this is exactly as far as they get.

**`inviteUserByEmail` (new, needs `service_role`)**
Creates the person's `auth.users` row and sends Supabase's built-in invite
email. This is the one call in the whole project that needs elevated
rights, which is the entire reason this function exists rather than the
browser calling it directly.

Creating the `auth.users` row fires the existing sign-up trigger
immediately — so by the time the invited person clicks the link, they
already have farm access. `accept-invite.html` only asks them to set a
password; nothing about membership happens there.

---

## A limit worth knowing about

Supabase's default outgoing mail is rate-limited and not meant for volume —
fine for occasional family invites, not for anything resembling a mailing
list. If invites ever need to go out faster or more reliably than that,
configure custom SMTP under **Authentication → SMTP Settings**; nothing
here needs to change to support it.

Re-inviting an email that already has an *unconfirmed* pending invite may
fail with "already registered" — `inviteUserByEmail` doesn't cleanly resend.
The function reports this plainly rather than pretending it worked; the
`farm_invites` row is still saved either way, so the person gets access the
moment they have any account with that email, invite email or not.

**If you hit the rate limit and are tempted to add the user directly from
Authentication → Users in the Supabase dashboard instead — that will not
grant them access to anything.** Farm access is not "having a login," it's
a row in `farm_members`, and that row is only ever created one way: a
sign-up trigger matches the new account's email against `farm_invites` and
inserts it automatically. Adding a user by hand in the dashboard skips
`invite_person()` entirely, so there's no `farm_invites` row for the
trigger to match — the account exists, the login works, and they see
nothing, on every screen, with no error to explain why.

If you've already done this, don't redo it through People — that writes to
`farm_invites`, not `farm_members`, and the trigger that bridges the two
only fires on new sign-up, not on an account that already exists. Grant
the existing account access directly instead:

```sql
insert into farm_members (farm_id, user_id, role)
select f.id, u.id, 'member'  -- or 'owner' / 'viewer'
from farms f, auth.users u
where u.email in ('person@example.com')
on conflict (farm_id, user_id) do nothing;
```

If the rate limit itself is the real problem, that's what custom SMTP
above is for — it removes the reason to reach for the dashboard shortcut
in the first place.
