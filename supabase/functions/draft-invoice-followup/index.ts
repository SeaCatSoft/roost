// =============================================================================
// Roost — draft-invoice-followup
//
// The second (and only other) part of Roost that runs on a server rather than
// a static page, because it's the only other operation that needs a secret
// which must never reach the browser — here, an Anthropic API key instead of
// the service_role key.
//
// What it does NOT do: send anything to the customer. It reads real figures
// for one invoice using the caller's own session (so RLS applies exactly as
// it would to any other read), asks Claude to draft a subject and body from
// those figures alone, and saves the draft to invoice_followups with
// status 'drafted'. Nothing leaves the farm's own database. The person who
// asked for the draft reads it, can change a word of it, and their own
// separate click — in the app, afterwards — is what opens it in their email
// app to actually send. This function is never the thing that sends mail.
// =============================================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  });
}

const MODEL = 'claude-sonnet-5';

const SYSTEM_PROMPT = `You write short payment follow-up emails for a small, family-run poultry farm
writing to one of its own customers. You are given exact figures for one
invoice — never invent, round, or guess any number, name, or date beyond what
is given to you.

Match the tone to how overdue the invoice is:
- Not yet overdue, or only just: a light, friendly reminder — assume they
  simply haven't gotten to it yet.
- A little overdue: a polite nudge, still assuming good faith.
- Significantly overdue: direct and clear about the amount and due date,
  while staying warm and respectful — this is a small farm keeping a
  relationship with a customer, not a collections agency.

Never threaten late fees, legal action, or withholding future orders, and
never invent a policy the farm hasn't stated. Keep the body under 120 words.
Sign off from the farm by name, not a person's name, since you don't know who
will be sending it.

Respond with strict JSON only — no markdown fences, no commentary before or
after it — in exactly this shape:
{"subject": "...", "body": "..."}
The body should read as a complete, ready-to-send email including a greeting
and sign-off, with "\\n" for line breaks.`;

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS });
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);

  let body: { invoice_id?: number };
  try {
    body = await req.json();
  } catch {
    return json({ error: 'Malformed request body' }, 400);
  }

  const invoiceId = body.invoice_id;
  if (!invoiceId) return json({ error: 'invoice_id is required' }, 400);

  const authHeader = req.headers.get('Authorization');
  if (!authHeader) return json({ error: 'Not signed in' }, 401);

  const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
  const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!;
  const ANTHROPIC_API_KEY = Deno.env.get('ANTHROPIC_API_KEY');

  if (!ANTHROPIC_API_KEY) {
    return json({
      error: 'ANTHROPIC_API_KEY is not set for this project. Add it under ' +
        'Edge Functions → Secrets in the Supabase dashboard, then try again.',
    }, 500);
  }

  // Acts as the caller for every read and write below — this function has no
  // authority of its own over farm data, only over the one external API call
  // that needs a secret the browser can't hold.
  const userClient = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
  });

  const { data: { user }, error: userErr } = await userClient.auth.getUser();
  if (userErr || !user) return json({ error: 'Not signed in' }, 401);

  const { data: canEdit } = await userClient.rpc('can_edit_invoice', { p_invoice_id: invoiceId });
  if (!canEdit) {
    return json({ error: 'You do not have permission to draft a follow-up for this invoice' }, 403);
  }

  const { data: inv, error: invErr } = await userClient
    .from('v_invoices')
    .select('*')
    .eq('id', invoiceId)
    .maybeSingle();
  if (invErr) return json({ error: invErr.message }, 400);
  if (!inv) return json({ error: 'That invoice does not exist, or you do not have access to it' }, 404);
  if (!inv.customer_email) {
    return json({ error: `${inv.customer} has no email address on file — add one on the Customers screen first.` }, 400);
  }
  if (Number(inv.outstanding) <= 0.005) {
    return json({ error: 'This invoice is already fully paid.' }, 400);
  }

  const { data: farm } = await userClient.from('farms').select('name').eq('id', inv.farm_id).maybeSingle();
  const { data: balance } = await userClient
    .from('v_customer_balances')
    .select('invoices, invoiced, paid')
    .eq('customer_id', inv.customer_id)
    .maybeSingle();

  const daysOverdue = Number(inv.days_overdue ?? 0);
  const money = (n: number) => `$${Number(n ?? 0).toFixed(2)}`;

  const facts = [
    `Farm name: ${farm?.name ?? 'the farm'}`,
    `Customer name: ${inv.customer}`,
    `Invoice number: ${inv.number}`,
    `Invoice total: ${money(inv.total)}`,
    `Amount already paid: ${money(inv.paid)}`,
    `Amount outstanding: ${money(inv.outstanding)}`,
    `Issued on: ${inv.issued_on}`,
    `Due on: ${inv.due_on}`,
    `Days overdue as of today: ${daysOverdue} (0 means not yet, or due today)`,
    balance
      ? `Relationship so far: ${balance.invoices} invoice(s) sent to this customer, ${money(balance.invoiced)} invoiced in total, ${money(balance.paid)} paid in total.`
      : null,
  ].filter(Boolean).join('\n');

  let draft: { subject: string; body: string };
  try {
    const aiRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 600,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: `Draft the follow-up email from these facts:\n\n${facts}` }],
      }),
    });

    if (!aiRes.ok) {
      const errText = await aiRes.text();
      return json({ error: `The drafting service could not be reached (${aiRes.status}): ${errText.slice(0, 300)}` }, 502);
    }

    const aiBody = await aiRes.json();
    const text: string = aiBody?.content?.[0]?.text ?? '';
    const parsed = JSON.parse(text.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim());
    if (!parsed?.subject || !parsed?.body) throw new Error('missing subject or body');
    draft = { subject: String(parsed.subject), body: String(parsed.body) };
  } catch (e) {
    return json({ error: `Could not parse a draft from the response: ${(e as Error).message}` }, 502);
  }

  const { data: saved, error: saveErr } = await userClient
    .from('invoice_followups')
    .insert({
      invoice_id: invoiceId,
      days_overdue: daysOverdue,
      subject: draft.subject,
      body: draft.body,
      model: MODEL,
    })
    .select()
    .single();

  if (saveErr) return json({ error: saveErr.message }, 400);

  return json({ ok: true, followup: saved });
});
