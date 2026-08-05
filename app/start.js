/* =============================================================================
   Roost — start a cycle

   Reached from the landing page CTAs. Three outcomes:
     - not signed in        -> sign in first, then continue here
     - a cycle is running   -> carry on with it, or replace it
     - no open cycle        -> straight to the new cycle form

   Replacing asks what becomes of the old cycle. Archiving is preselected:
   comparing a flock against the last one is most of the point, and deleting
   is the one action here that cannot be walked back.
   ========================================================================== */

import { db, isConfigured, $, today, daysBetween, banner, loadOpenCycle } from './db.js';

const screens = { setup: $('setupScreen'), auth: $('authScreen'), app: $('appScreen') };
const show = (n) => Object.entries(screens).forEach(([k, el]) => { el.hidden = k !== n; });
const showError = (m) => banner($('appError'), $('appErrorText'), m);
const showAuthError = (m) => banner($('authError'), $('authErrorText'), m);

if (!isConfigured) { show('setup'); throw new Error('Supabase is not configured'); }

const steps = { existing: $('existingStep'), form: $('formStep'), done: $('doneStep') };
const step = (n) => Object.entries(steps).forEach(([k, el]) => { el.hidden = k !== n; });

const state = { farmId: null, current: null, disposal: 'archive' };

const fmt = (n) => Number(n).toLocaleString('en-US');

/* ---------- Auth --------------------------------------------------------- */
$('authForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  showAuthError(null);

  const btn = $('signInBtn');
  btn.disabled = true;
  btn.textContent = 'Signing in…';

  const { error } = await db.auth.signInWithPassword({
    email: $('email').value.trim(),
    password: $('password').value
  });

  btn.disabled = false;
  btn.textContent = 'Sign in';

  if (error) {
    showAuthError(error.message === 'Invalid login credentials'
      ? 'That email and password combination was not recognised.'
      : error.message);
    return;
  }
  boot();
});

/* ---------- Load ---------------------------------------------------------- */
async function boot() {
  const { data: { session } } = await db.auth.getSession();
  if (!session) { show('auth'); return; }

  show('app');
  showError(null);

  const { data: farms, error: farmErr } = await db.from('farms').select('id, name').limit(1);
  if (farmErr || !farms || !farms.length) {
    showError('No farm is linked to this account yet.');
    return;
  }
  state.farmId = farms[0].id;

  try {
    state.current = await loadOpenCycle();
  } catch {
    state.current = null;      // nothing open is a normal state, not a failure
  }

  if (state.current) {
    const day = Math.max(1, daysBetween(state.current.placed_on, today()) + 1);
    $('existingTitle').textContent = state.current.label;
    $('existingMeta').textContent =
      `Day ${day} of ${state.current.target_sale_age} · ` +
      `${fmt(state.current.birds_placed)} birds placed on ` +
      `${new Date(state.current.placed_on + 'T00:00:00').toLocaleDateString(undefined,
        { day: 'numeric', month: 'long', year: 'numeric' })}`;
    step('existing');
  } else {
    await prepareForm();
    step('form');
  }
}

/* ---------- Choices ------------------------------------------------------- */
$('continueBtn').addEventListener('click', () => { window.location.href = './'; });

$('startOverBtn').addEventListener('click', async () => {
  await prepareForm();
  step('form');
  window.scrollTo({ top: 0, behavior: 'auto' });
});

document.querySelectorAll('[data-disposal]').forEach((btn) => {
  btn.addEventListener('click', () => {
    state.disposal = btn.getAttribute('data-disposal');
    document.querySelectorAll('[data-disposal]').forEach((b) =>
      b.classList.toggle('choice__card--selected', b === btn));
    $('deleteConfirm').hidden = state.disposal !== 'delete';
    $('confirmInput').value = '';
    updateCreateButton();
  });
});

$('confirmInput').addEventListener('input', updateCreateButton);

function updateCreateButton() {
  const btn = $('createBtn');
  if (state.disposal === 'delete' && state.current) {
    const typed = $('confirmInput').value.trim().toLowerCase();
    const needed = state.current.label.trim().toLowerCase();
    btn.disabled = typed !== needed;
    btn.textContent = btn.disabled ? 'Type the name to confirm' : 'Delete and start fresh';
  } else {
    btn.disabled = false;
    btn.textContent = 'Start the cycle';
  }
}

/* ---------- Form ---------------------------------------------------------- */
async function prepareForm() {
  $('placedInput').value = today();

  const { data: suggested } = await db.rpc('suggest_cycle_label', { p_farm_id: state.farmId });
  $('labelInput').value = suggested || 'Cycle 1';

  if (state.current) {
    $('disposalPanel').hidden = false;
    $('disposalName').textContent = state.current.label;
    $('confirmWord').textContent = state.current.label;
    $('birdsInput').value = state.current.birds_placed;
    $('breedInput').value = state.current.breed || '';
    $('ageInput').value = state.current.target_sale_age;

    const counts = await countRecords(state.current.id);
    $('deleteWhat').innerHTML =
      `This permanently removes <strong>${state.current.label}</strong> and everything in it: ` +
      `${counts.checks} daily check${counts.checks === 1 ? '' : 's'}, ` +
      `${counts.bags} bag opening${counts.bags === 1 ? '' : 's'} and ` +
      `${counts.weights} weighing${counts.weights === 1 ? '' : 's'}. There is no undo.`;
  } else {
    $('disposalPanel').hidden = true;
  }

  updateCreateButton();
}

// Counted so the confirmation names what is actually at stake, rather than
// warning in the abstract.
async function countRecords(cycleId) {
  const head = { count: 'exact', head: true };
  const [c, b, w] = await Promise.all([
    db.from('daily_checks').select('id', head).eq('cycle_id', cycleId),
    db.from('feed_bag_openings').select('id', head).eq('cycle_id', cycleId),
    db.from('sample_weights').select('id', head).eq('cycle_id', cycleId)
  ]);
  return { checks: c.count ?? 0, bags: b.count ?? 0, weights: w.count ?? 0 };
}

/* ---------- Create -------------------------------------------------------- */
$('createBtn').addEventListener('click', async () => {
  const btn = $('createBtn');
  showError(null);

  const label = $('labelInput').value.trim();
  const birds = parseInt($('birdsInput').value, 10);
  const placed = $('placedInput').value;
  const breed = $('breedInput').value.trim() || null;
  const age = parseInt($('ageInput').value, 10) || 42;

  if (!label) { showError('Give the cycle a name.'); return; }
  if (!birds || birds <= 0) { showError('Birds placed must be a positive number.'); return; }
  if (!placed) { showError('Pick the date the birds were placed.'); return; }

  btn.disabled = true;
  btn.textContent = 'Starting…';

  // Deal with the outgoing cycle first, so a failure there stops the whole
  // thing rather than leaving two open cycles.
  if (state.current) {
    const fn = state.disposal === 'delete' ? 'delete_cycle' : 'archive_cycle';
    const { error } = await db.rpc(fn, { p_cycle_id: state.current.id });
    if (error) {
      btn.disabled = false;
      updateCreateButton();
      showError(`Could not ${state.disposal === 'delete' ? 'delete' : 'close'} ${state.current.label}: ${error.message}`);
      return;
    }
  }

  const { data: newId, error } = await db.rpc('start_new_cycle', {
    p_farm_id: state.farmId,
    p_label: label,
    p_birds_placed: birds,
    p_placed_on: placed,
    p_breed: breed,
    p_target_age: age
  });

  if (error) {
    btn.disabled = false;
    updateCreateButton();
    showError(`Could not start the cycle: ${error.message}`);
    return;
  }

  $('doneTitle').textContent = `${label} started`;
  $('doneMeta').textContent =
    `${fmt(birds)} birds · ${age} day grow-out` +
    (state.current
      ? ` · ${state.current.label} ${state.disposal === 'delete' ? 'deleted' : 'closed and kept'}`
      : '');
  step('done');
  window.scrollTo({ top: 0, behavior: 'auto' });
  void newId;
});

boot();
