# draft-invoice-followup

Drafts a payment reminder email for one overdue invoice using Claude. It does
not send anything — see [`invite-member`](../invite-member/README.md) for the
project's other Edge Function and the same "the browser never holds a secret"
reasoning; this one exists for the same reason, with a different secret.

**Nothing is emailed by this function, or by anything it calls.** It reads one
invoice's real figures (through your own session, so the same access rules
apply as anywhere else in the app), asks Claude to write a subject and body
from those figures, and saves the result to `invoice_followups` with status
`drafted`. That's the entire job. The app then shows you the draft, lets you
change a word of it, and only a separate click there — "Approve & open
email" — opens it in *your own* email app. Nothing sends until you press Send
in that app, same as if you'd typed the whole thing yourself.

---

## Deploy it (no CLI needed)

1. Supabase dashboard → **Edge Functions** → **Create a new function**.
2. Name it exactly **`draft-invoice-followup`** — the app calls it by that name.
3. Paste in the contents of [`index.ts`](./index.ts).
4. Deploy.

`SUPABASE_URL` and `SUPABASE_ANON_KEY` are injected automatically. One more
secret is not: see below.

---

## One required setting: the Anthropic API key

This function calls Claude directly over HTTPS — no SDK, no extra dependency,
just `fetch`. It needs its own API key, separate from anything Supabase gives
you automatically.

1. Get a key from [console.anthropic.com](https://console.anthropic.com/) →
   **API Keys** (needs a card on file there; drafting a handful of emails a
   month costs a small fraction of a cent each on `claude-sonnet-5`).
2. In Supabase: **Edge Functions** → **Secrets** (sometimes shown under
   **Manage secrets**, or reachable via **Project Settings → Edge Functions**
   depending on dashboard version) → add:
   ```
   ANTHROPIC_API_KEY = sk-ant-...
   ```
3. No redeploy needed — secrets are picked up on the next invocation.

If the key is missing, the function says so plainly rather than failing
silently — you'll see that message right in the Follow-ups screen.

---

## Test it

1. **Follow-ups** screen → any overdue invoice → **Draft with AI**.
2. Should show an editable subject and body a few seconds later.
3. Edit it if you want, then either **Copy** it, or **Approve & open email**
   to hand it to your email app with the address, subject and body already
   filled in.
4. In Supabase, **Table Editor → invoice_followups** should show the new row,
   `status = drafted` until you approve it, `sent` afterward, with `sent_by`
   and `sent_at` stamped automatically by the database — not by whatever the
   browser sent, so that record can be trusted.

---

## Why an email client, not real sending

Roost could send the email itself the same way `invite-member` sends invite
mail — but that needs its own deliverable-mail setup (custom SMTP or a
transactional provider like Resend/Postmark, its own API key, and a verified
sending domain), which is a real piece of infrastructure for what is, today,
a handful of family-farm invoices a month. Handing the finished draft to your
own email app gets the same outcome — a real email, from a real address the
customer already recognizes — with none of that setup, and with the approval
gate built in for free: the human is always the one who presses Send.

If invoice volume ever grows enough to want one-click sending, that's a
follow-on change to this function alone — nothing about the schema, the RLS
policies, or the rest of the app needs to change to support it.

---

## What's stored, and what isn't

`invoice_followups` keeps every draft, whether it was ever sent, dismissed,
or just left alone — so **Follow-ups** can tell "never followed up on" apart
from "already emailed three days ago, leave it." Nothing here can cause an
email to leave the farm's control on its own; the table only ever describes
what a human already decided to do.
