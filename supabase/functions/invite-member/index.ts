// =============================================================================
// Roost — invite-member
//
// The one part of Roost that runs on a server rather than a static page,
// because it is the one operation that needs the service_role key — which
// must never reach the browser. Everything else in this project talks to
// Supabase directly from a page with the public anon key; this function
// exists solely to hold the one secret that can't live there.
//
// Authorization is not re-invented here. The caller's own JWT (forwarded
// automatically by supabase-js when a session is active) is used to run
// invite_person(), the exact database function the app called directly
// before this existed. That function is SECURITY DEFINER and re-checks
// ownership itself — this function trusts nothing beyond what the database
// already trusts. The service_role key is touched only afterwards, and only
// to send mail, never to read or write farm data.
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

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS });
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);

  let body: { farm_id?: number; email?: string; role?: string; redirect_to?: string };
  try {
    body = await req.json();
  } catch {
    return json({ error: 'Malformed request body' }, 400);
  }

  const { farm_id, email, role, redirect_to } = body;
  if (!farm_id || !email || !role) {
    return json({ error: 'farm_id, email and role are all required' }, 400);
  }
  if (!['owner', 'member', 'viewer'].includes(role)) {
    return json({ error: 'role must be owner, member or viewer' }, 400);
  }

  const authHeader = req.headers.get('Authorization');
  if (!authHeader) return json({ error: 'Not signed in' }, 401);

  const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
  const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!;
  const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

  // Acts as the caller for every check that matters. If they are not signed
  // in, or not an owner of this farm, this is exactly as far as they get
  // whether they came through the app or hit this function directly.
  const userClient = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
  });

  const { data: { user }, error: userErr } = await userClient.auth.getUser();
  if (userErr || !user) return json({ error: 'Not signed in' }, 401);

  // Records the allow-list entry and enforces ownership — the same
  // validation that ran when the app called this directly. If the caller is
  // not an owner, or the email is malformed, or the person is already on the
  // farm, this is where it says so, in the same words as before.
  const { error: inviteErr } = await userClient.rpc('invite_person', {
    p_farm_id: farm_id,
    p_email: email,
    p_role: role,
  });
  if (inviteErr) return json({ error: inviteErr.message }, 400);

  // Only from here does the service_role key do anything, and only to send
  // mail. It never touches a farm table.
  const adminClient = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

  const { error: mailErr } = await adminClient.auth.admin.inviteUserByEmail(email, {
    redirectTo: redirect_to || undefined,
  });

  if (mailErr) {
    // The allow-list entry is already saved even though the email failed —
    // access still works if they get an account some other way, so say that
    // rather than leaving the impression nothing happened at all.
    const already = /already.*(registered|exist)/i.test(mailErr.message || '');
    return json({
      error: already
        ? `${email} already has an account on this project, so no invite email was sent. ` +
          'The allow-list entry is saved — if they sign in directly, they will be added automatically.'
        : `The allow-list entry was saved, but the email failed to send: ${mailErr.message}`,
    }, 502);
  }

  return json({ ok: true });
});
