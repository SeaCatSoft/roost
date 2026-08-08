/* =============================================================================
   Roost — daily check
   Talks straight to Supabase. Row-level security decides what comes back, so
   there is no server in between and nothing here to trust.
   ========================================================================== */

import {
  db, isConfigured, $, today, daysBetween, banner, phaseForDay, loadOpenCycle,
  myRole, canEdit, lockForViewer
} from './db.js';

const screens = {
  setup: $('setupScreen'),
  auth:  $('authScreen'),
  app:   $('appScreen')
};

function show(name) {
  Object.entries(screens).forEach(([k, el]) => { el.hidden = k !== name; });
}

/* ---------- Guard against an unconfigured deploy ------------------------- */
if (!isConfigured) {
  show('setup');
  throw new Error('Supabase is not configured — see app/config.js');
}

const showAuthError = (m) => banner($('authError'), $('authErrorText'), m);
const showAppError  = (m) => banner($('appError'),  $('appErrorText'),  m);

/* ---------- Form state --------------------------------------------------- */
const state = {
  cycle: null,
  dayNumber: null,
  session: 'DAY',
  existing: null,
  water: 'OK',
  litter: 'Dry',
  health: 'Normal',
  bagOpened: false
};

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
    showAuthError(
      error.message === 'Invalid login credentials'
        ? 'That email and password combination was not recognised.'
        : error.message
    );
    return;
  }
  boot();
});

$('signOutBtn').addEventListener('click', async () => {
  await db.auth.signOut();
  show('auth');
});

/* ---------- Segmented controls ------------------------------------------ */
document.querySelectorAll('[data-segment]').forEach((seg) => {
  const key = seg.getAttribute('data-segment');
  seg.addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    seg.querySelectorAll('button').forEach((b) => {
      b.setAttribute('aria-pressed', String(b === btn));
    });
    state[key] = btn.getAttribute('data-value');
  });
});

/* Days 1-14 are checked twice. Choosing a session reloads whatever was already
   recorded for it, so switching between morning and afternoon shows each one's
   own figures rather than carrying the other's across. */
document.querySelectorAll('[data-segment="session"] button').forEach((btn) => {
  btn.addEventListener('click', async () => {
    document.querySelectorAll('[data-segment="session"] button').forEach((b) =>
      b.setAttribute('aria-pressed', String(b === btn)));
    state.session = btn.getAttribute('data-value');
    resetForm();
    await loadExistingCheck();
  });
});

function resetForm() {
  $('mortality').value = 0;
  $('culls').value = 0;
  $('temp').value = '';
  $('notes').value = '';
  setSegment('water', 'OK');
  setSegment('litter', 'Dry');
  setSegment('health', 'Normal');
  $('alreadySaved').hidden = true;
  $('saveBtn').textContent = "Save today's check";
}

function setSegment(key, value) {
  if (!value) return;
  state[key] = value;
  const seg = document.querySelector(`[data-segment="${key}"]`);
  if (!seg) return;
  seg.querySelectorAll('button').forEach((b) => {
    b.setAttribute('aria-pressed', String(b.getAttribute('data-value') === value));
  });
}

/* ---------- Steppers ----------------------------------------------------- */
document.querySelectorAll('[data-step]').forEach((btn) => {
  btn.addEventListener('click', () => {
    const input = $(btn.getAttribute('data-step'));
    const delta = parseInt(btn.getAttribute('data-delta'), 10);
    // Most counts can fall to zero; a bag count cannot, because the switch
    // being on already means at least one was opened.
    const min = parseInt(btn.getAttribute('data-min'), 10) || 0;
    input.value = Math.max(min, (parseInt(input.value, 10) || 0) + delta);
  });
});

/* ---------- Bag switch --------------------------------------------------- */
$('bagSwitch').addEventListener('click', () => {
  state.bagOpened = !state.bagOpened;
  $('bagSwitch').setAttribute('aria-checked', String(state.bagOpened));

  // The count only means anything while the switch is on. Reset it each time
  // so yesterday's four bags never ride along into a day that opened one.
  $('bagCountField').hidden = !state.bagOpened;
  if (state.bagOpened) $('bags').value = '1';
});

/* ---------- Load ---------------------------------------------------------- */
async function boot() {
  const { data: { session } } = await db.auth.getSession();
  if (!session) { show('auth'); return; }

  show('app');
  showAppError(null);

  try {
    state.cycle = await loadOpenCycle();
  } catch (e) {
    showAppError(e.message);
    return;
  }

  state.dayNumber = Math.max(1, daysBetween(state.cycle.placed_on, today()) + 1);

  $('cycleLabel').textContent = state.cycle.label;
  $('dayNumber').textContent = `Day ${state.dayNumber}`;
  $('dayOf').textContent = `of ${state.cycle.target_sale_age}`;

  // Brooding gets two checks a day; grow-out gets one.
  const twice = state.dayNumber <= 14;
  $('sessionField').hidden = !twice;

  if (twice) {
    // Default to whichever half of the day it is, rather than making someone
    // choose the obvious thing every time.
    state.session = new Date().getHours() < 12 ? 'AM' : 'PM';
    document.querySelectorAll('[data-segment="session"] button').forEach((b) =>
      b.setAttribute('aria-pressed', String(b.getAttribute('data-value') === state.session)));
    $('sessionHint').textContent =
      'The first fortnight is checked twice a day. Both are recorded separately.';
  } else {
    state.session = 'DAY';
  }

  await Promise.all([loadProgress(), loadExistingCheck()]);

  if (!canEdit(await myRole())) {
    lockForViewer($('checkForm'), 'You have view-only access. Today\'s figures are shown, but cannot be changed.');
  }
}

async function loadProgress() {
  const { data, error } = await db
    .from('v_cycle_progress')
    .select('birds_alive, mortality_to_date, bags_opened')
    .eq('cycle_id', state.cycle.id)
    .maybeSingle();

  if (error || !data) return;

  $('birdsAlive').textContent = Number(data.birds_alive).toLocaleString('en-US');
  $('mortalityPct').textContent =
    data.mortality_to_date == null ? '0%' : `${(data.mortality_to_date * 100).toFixed(1)}%`;
  $('bagsOpened').textContent = data.bags_opened ?? 0;
}

// Re-opening the app on the same day shows what was already entered, so a
// second visit edits the record rather than silently creating a conflict.
async function loadExistingCheck() {
  const { data, error } = await db
    .from('daily_checks')
    .select('*')
    .eq('cycle_id', state.cycle.id)
    .eq('day_number', state.dayNumber)
    .eq('session', state.session)
    .maybeSingle();

  if (error) return;

  $('checkHeading').textContent =
    new Date().toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' });

  if (!data) { state.existing = null; return; }

  state.existing = data;
  $('alreadySaved').hidden = false;
  $('mortality').value = data.mortality ?? 0;
  $('culls').value = data.culls ?? 0;
  $('temp').value = data.house_temp_c ?? '';
  $('notes').value = data.notes ?? '';
  setSegment('water', data.water);
  setSegment('litter', data.litter);
  setSegment('health', data.health);
  $('saveBtn').textContent = 'Update today\'s check';
}

/* ---------- Save --------------------------------------------------------- */
$('checkForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  showAppError(null);

  const btn = $('saveBtn');
  btn.disabled = true;
  btn.textContent = 'Saving…';

  const { data: { session } } = await db.auth.getSession();

  const row = {
    cycle_id: state.cycle.id,
    day_number: state.dayNumber,
    session: state.session,
    checked_on: today(),
    mortality: parseInt($('mortality').value, 10) || 0,
    culls: parseInt($('culls').value, 10) || 0,
    water: state.water,
    litter: state.litter,
    health: state.health,
    house_temp_c: $('temp').value === '' ? null : Number($('temp').value),
    notes: $('notes').value.trim() || null,
    recorded_by: session?.user?.id ?? null
  };

  // One row per cycle-day: a second save the same day updates rather than
  // duplicating, which is what the unique constraint expects.
  const { error } = await db
    .from('daily_checks')
    .upsert(row, { onConflict: 'cycle_id,day_number,session' });

  if (error) {
    btn.disabled = false;
    btn.textContent = 'Save today\'s check';
    // The mortality guard in the database raises a readable message; surface it.
    showAppError(error.message);
    return;
  }

  if (state.bagOpened) {
    const bags = Math.max(1, parseInt($('bags').value, 10) || 1);

    // One row per bag, never one row carrying a quantity: every figure in the
    // app counts these rows (v_cycle_summary, the feed dashboard), so a
    // quantity column would be invisible to all of them.
    const { error: bagErr } = await db.from('feed_bag_openings').insert(
      Array.from({ length: bags }, () => ({
        cycle_id: state.cycle.id,
        opened_on: today(),
        phase: phaseForDay(state.dayNumber)
      }))
    );

    if (bagErr) {
      showAppError(`Check saved, but the ${bags === 1 ? 'bag was' : 'bags were'} not recorded: ${bagErr.message}`);
    }

    state.bagOpened = false;
    $('bagSwitch').setAttribute('aria-checked', 'false');
    $('bagCountField').hidden = true;
    $('bags').value = '1';
  }

  btn.disabled = false;
  btn.textContent = 'Saved';
  $('alreadySaved').hidden = false;

  await Promise.all([loadProgress(), loadExistingCheck()]);

  setTimeout(() => { btn.textContent = 'Update today\'s check'; }, 1600);
});

/* ---------- Go ----------------------------------------------------------- */
db.auth.onAuthStateChange((event) => {
  if (event === 'SIGNED_OUT') show('auth');
});

boot();
