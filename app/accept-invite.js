/* =============================================================================
   Roost — accept an invite

   Reached only from the link in an invite email. supabase-js reads the
   access token out of the URL fragment on load (detectSessionInUrl, the
   default), so by the time this runs the invited person is already signed
   in — they just have no password yet, which is the one thing this screen
   collects.
   ========================================================================== */

import { db, isConfigured, $ } from './db.js';

const screens = {
  setup: $('setupScreen'), checking: $('checkingScreen'),
  expired: $('expiredScreen'), form: $('formScreen'), done: $('doneScreen')
};
const show = (n) => Object.entries(screens).forEach(([k, el]) => { el.hidden = k !== n; });

if (!isConfigured) { show('setup'); throw new Error('Supabase is not configured'); }

async function boot() {
  show('checking');

  const { data: { session } } = await db.auth.getSession();
  if (!session) { show('expired'); return; }

  const { data: farms } = await db.from('farms').select('name').order('id').limit(1);
  $('farmSuffix').textContent = farms?.[0]?.name ? ` to ${farms[0].name}` : '';

  show('form');
}

const errEl = $('formError'), errText = $('formErrorText');
const showErr = (m) => {
  if (!m) { errEl.hidden = true; return; }
  errText.textContent = m;
  errEl.hidden = false;
};

$('setForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const password = $('password').value;
  const confirm = $('confirm').value;

  if (password.length < 8) { showErr('Use at least 8 characters.'); return; }
  if (password !== confirm) { showErr('Those two passwords do not match.'); return; }

  const btn = $('setBtn');
  btn.disabled = true;
  btn.textContent = 'Joining…';
  showErr(null);

  const { error } = await db.auth.updateUser({ password });

  if (error) {
    btn.disabled = false;
    btn.textContent = 'Join the farm';
    showErr(error.message);
    return;
  }

  show('done');
  setTimeout(() => { window.location.href = './'; }, 1200);
});

boot();
