/* =============================================================================
   Roost — landing page calls to action

   "Start a cycle" is an action for someone who already has a farm. Offering it
   to a stranger sends them to a sign-in wall they did not ask for; now that
   signing up creates a farm, the honest invitation for a visitor is to start
   one.

   The page ships in the signed-out state and is only upgraded once a real
   session is confirmed — never the other way round, so nobody sees a flash of
   a button meant for someone else. This is presentation only: start.html
   still checks the session itself, as it always has.
   ========================================================================== */

import { db, isConfigured } from '../app/db.js';

if (isConfigured && db) {
  db.auth.getSession().then(({ data: { session } }) => {
    if (!session) return;

    document.querySelectorAll('[data-start-cta]').forEach((el) => {
      const href = el.getAttribute('data-in-href');
      const text = el.getAttribute('data-in-text');
      if (href) el.setAttribute('href', href);
      if (text) el.textContent = text;
    });
  }).catch(() => {
    /* No session, or Supabase unreachable — the signed-out state already on
       the page is the right answer either way. */
  });
}
