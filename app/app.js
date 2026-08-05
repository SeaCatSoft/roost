/* =============================================================================
   Roost — daily check
   Talks straight to Supabase. Row-level security decides what comes back, so
   there is no server in between and nothing here to trust.
   ========================================================================== */

import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config.js';

const $ = (id) => document.getElementById(id);

const screens = {
  setup: $('setupScreen'),
  auth:  $('authScreen'),
  app:   $('appScreen')
};

function show(name) {
  Object.entries(screens).forEach(([k, el]) => { el.hidden = k !== name; });
}

/* ---------- Guard against an unconfigured deploy ------------------------- */
if (!SUPABASE_URL || SUPABASE_URL.startsWith('PASTE_') ||
    !SUPABASE_ANON_KEY || SUPABASE_ANON_KEY.startsWith('PASTE_')) {
  show('setup');
  throw new Error('Supabase is not configured — see app/config.js');
}

const db = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

/* ---------- Small helpers ------------------------------------------------ */
function banner(el, textEl, message) {
  if (!message) { el.hidden = true; return; }
  textEl.textContent = message;
  el.hidden = false;
}

const showAuthError = (m) => banner($('authError'), $('authErrorText'), m);
const showAppError  = (m) => banner($('appError'),  $('appErrorText'),  m);

// Local calendar date, not UTC. `toISOString` would roll the date over for
// anyone west of Greenwich during the evening — and the evening is exactly
// when this gets filled in.
function today() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function daysBetween(fromISO, toISO) {
  const a = new Date(fromISO + 'T00:00:00');
  const b = new Date(toISO + 'T00:00:00');
  return Math.round((b - a) / 86400000);
}

/* ---------- Form state --------------------------------------------------- */
const state = {
  cycle: null,
  dayNumber: null,
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
    input.value = Math.max(0, (parseInt(input.value, 10) || 0) + delta);
  });
});

/* ---------- Bag switch --------------------------------------------------- */
$('bagSwitch').addEventListener('click', () => {
  state.bagOpened = !state.bagOpened;
  $('bagSwitch').setAttribute('aria-checked', String(state.bagOpened));
});

/* ---------- Load ---------------------------------------------------------- */
async function boot() {
  const { data: { session } } = await db.auth.getSession();
  if (!session) { show('auth'); return; }

  show('app');
  showAppError(null);

  // The open cycle: most recent placement that has not been closed.
  const { data: cycles, error: cycleErr } = await db
    .from('cycles')
    .select('id, label, placed_on, birds_placed, target_sale_age, closed_at')
    .is('closed_at', null)
    .order('placed_on', { ascending: false })
    .limit(1);

  if (cycleErr) {
    showAppError(`Could not load the cycle: ${cycleErr.message}`);
    return;
  }
  if (!cycles || !cycles.length) {
    showAppError('No open cycle found. Start one before recording checks.');
    return;
  }

  state.cycle = cycles[0];
  state.dayNumber = Math.max(1, daysBetween(state.cycle.placed_on, today()) + 1);

  $('cycleLabel').textContent = state.cycle.label;
  $('dayNumber').textContent = `Day ${state.dayNumber}`;
  $('dayOf').textContent = `of ${state.cycle.target_sale_age}`;

  await Promise.all([loadProgress(), loadExistingCheck()]);
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
    .upsert(row, { onConflict: 'cycle_id,day_number' });

  if (error) {
    btn.disabled = false;
    btn.textContent = 'Save today\'s check';
    // The mortality guard in the database raises a readable message; surface it.
    showAppError(error.message);
    return;
  }

  if (state.bagOpened) {
    const phase =
      state.dayNumber <= 14 ? 'Starter' : state.dayNumber <= 28 ? 'Grower' : 'Finisher';

    const { error: bagErr } = await db.from('feed_bag_openings').insert({
      cycle_id: state.cycle.id,
      opened_on: today(),
      phase
    });

    if (bagErr) showAppError(`Check saved, but the bag was not recorded: ${bagErr.message}`);

    state.bagOpened = false;
    $('bagSwitch').setAttribute('aria-checked', 'false');
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
