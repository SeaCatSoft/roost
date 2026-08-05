/* =============================================================================
   Roost — backfill
   Enter the days you already have on paper, so the forecasts have history to
   work from. Deliberately narrow: deaths, culls and feed bags only. Nobody
   remembers what the litter was like on day 12, and an invented value is worse
   than an honest gap.
   ========================================================================== */

import {
  db, isConfigured, $, today, daysBetween, dateForDay, formatShortDate,
  banner, phaseForDay, loadOpenCycle, myRole, canEdit, lockForViewer
} from './db.js';

const screens = { setup: $('setupScreen'), auth: $('authScreen'), app: $('appScreen') };
const show = (name) => Object.entries(screens).forEach(([k, el]) => { el.hidden = k !== name; });
const showError = (m) => banner($('appError'), $('appErrorText'), m);

if (!isConfigured) {
  show('setup');
  throw new Error('Supabase is not configured — see app/config.js');
}

const state = {
  cycle: null,
  lastDay: 1,
  saved: new Map(),   // day -> row already in the database
  draft: new Map(),   // day -> unsaved edits
  bags: new Set()     // days that already have a bag opening recorded
};

/* ---------- Load --------------------------------------------------------- */
async function boot() {
  const { data: { session } } = await db.auth.getSession();
  if (!session) { show('auth'); return; }

  show('app');
  showError(null);

  try {
    state.cycle = await loadOpenCycle();
  } catch (e) {
    showError(e.message);
    return;
  }

  $('cycleLabel').textContent = state.cycle.label;

  // Never offer days that have not happened yet, and never past processing.
  const elapsed = daysBetween(state.cycle.placed_on, today()) + 1;
  state.lastDay = Math.max(1, Math.min(elapsed, state.cycle.target_sale_age));

  const [checks, bags] = await Promise.all([
    db.from('daily_checks')
      .select('day_number, mortality, culls')
      .eq('cycle_id', state.cycle.id),
    db.from('feed_bag_openings')
      .select('opened_on')
      .eq('cycle_id', state.cycle.id)
  ]);

  if (checks.error) { showError(`Could not load existing checks: ${checks.error.message}`); return; }

  (checks.data || []).forEach((r) => state.saved.set(r.day_number, r));

  // Bag openings are stored by date; map them back onto day numbers.
  (bags.data || []).forEach((b) => {
    const day = daysBetween(state.cycle.placed_on, b.opened_on) + 1;
    state.bags.add(day);
  });

  render();

  if (!canEdit(await myRole())) {
    lockForViewer(document.querySelector('.app-shell'),
      'You have view-only access. Past days are shown, but cannot be filled in.');
  }
}

/* ---------- Render -------------------------------------------------------- */
function render() {
  const rows = $('dayRows');
  rows.textContent = '';

  const frag = document.createDocumentFragment();

  for (let day = 1; day <= state.lastDay; day++) {
    const saved = state.saved.get(day);
    const draft = state.draft.get(day);
    const current = draft || saved;

    const row = document.createElement('div');
    row.className = 'day-row';
    if (saved && !draft) row.classList.add('is-saved');
    if (draft) row.classList.add('is-dirty');

    const label = document.createElement('div');
    label.className = 'day-row__day';
    label.innerHTML =
      `<span class="day-row__n">Day ${day}</span>` +
      `<span class="day-row__date">${formatShortDate(dateForDay(state.cycle.placed_on, day))}</span>`;

    const deaths = numberInput(day, 'mortality', current ? current.mortality : '');
    const culls  = numberInput(day, 'culls', current ? current.culls : '');

    const bagWrap = document.createElement('div');
    const bag = document.createElement('button');
    bag.type = 'button';
    bag.className = 'bag-toggle';
    const bagOn = draft ? !!draft.bag : state.bags.has(day);
    bag.setAttribute('aria-pressed', String(bagOn));
    bag.setAttribute('aria-label', `Feed bag opened on day ${day}`);
    bag.disabled = state.bags.has(day);   // already recorded; not removable here
    bag.innerHTML =
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      '<path d="M5 8h14l-1.2 11a2 2 0 0 1-2 1.8H8.2a2 2 0 0 1-2-1.8L5 8Z"/><path d="M9 8V5.5A1.5 1.5 0 0 1 10.5 4h3A1.5 1.5 0 0 1 15 5.5V8"/></svg>';
    bag.addEventListener('click', () => {
      const d = ensureDraft(day);
      d.bag = !d.bag;
      bag.setAttribute('aria-pressed', String(d.bag));
      row.classList.add('is-dirty');
      refreshTotals();
    });
    bagWrap.appendChild(bag);

    row.append(label, deaths, culls, bagWrap);
    frag.appendChild(row);
  }

  rows.appendChild(frag);
  $('rowsLoading').hidden = true;
  $('dayList').hidden = false;
  refreshTotals();
}

function numberInput(day, field, value) {
  const input = document.createElement('input');
  input.type = 'number';
  input.inputMode = 'numeric';
  input.min = '0';
  input.step = '1';
  input.className = 'day-row__num';
  input.value = value === null || value === undefined ? '' : value;
  input.placeholder = '–';
  input.setAttribute('aria-label', `${field === 'mortality' ? 'Deaths' : 'Culls'} on day ${day}`);

  input.addEventListener('input', () => {
    const d = ensureDraft(day);
    d[field] = input.value === '' ? null : Math.max(0, parseInt(input.value, 10) || 0);
    input.closest('.day-row').classList.add('is-dirty');
    refreshTotals();
  });

  return input;
}

function ensureDraft(day) {
  if (!state.draft.has(day)) {
    const saved = state.saved.get(day);
    state.draft.set(day, {
      mortality: saved ? saved.mortality : null,
      culls: saved ? saved.culls : null,
      bag: state.bags.has(day)
    });
  }
  return state.draft.get(day);
}

/* ---------- Totals -------------------------------------------------------- */
function refreshTotals() {
  let recorded = 0;
  let losses = 0;

  for (let day = 1; day <= state.lastDay; day++) {
    const d = state.draft.get(day);
    const s = state.saved.get(day);
    const row = d || s;
    const hasValue = row && (row.mortality !== null || row.culls !== null);
    if (hasValue) {
      recorded++;
      losses += (row.mortality || 0) + (row.culls || 0);
    }
  }

  $('daysRecorded').textContent = `${recorded}/${state.lastDay}`;
  $('lossesSoFar').textContent = losses.toLocaleString('en-US');
  $('birdsAlive').textContent = (state.cycle.birds_placed - losses).toLocaleString('en-US');

  const pending = countPending();
  const btn = $('saveBtn');
  btn.disabled = pending === 0;
  btn.textContent = pending === 0
    ? 'Nothing to save yet'
    : `Save ${pending} day${pending === 1 ? '' : 's'}`;

  // Warn before the database refuses the batch.
  if (losses > state.cycle.birds_placed) {
    showError(
      `Those losses total ${losses.toLocaleString('en-US')}, more than the ` +
      `${state.cycle.birds_placed.toLocaleString('en-US')} birds placed. Check for a typo.`
    );
  } else {
    showError(null);
  }
}

function countPending() {
  let n = 0;
  state.draft.forEach((d) => {
    if (d.mortality !== null || d.culls !== null || d.bag) n++;
  });
  return n;
}

/* ---------- Bulk actions -------------------------------------------------- */
$('fillZeros').addEventListener('click', () => {
  for (let day = 1; day <= state.lastDay; day++) {
    if (state.saved.has(day)) continue;
    const d = state.draft.get(day);
    if (d && (d.mortality !== null || d.culls !== null)) continue;
    const draft = ensureDraft(day);
    draft.mortality = 0;
    draft.culls = 0;
  }
  render();
});

$('clearAll').addEventListener('click', () => {
  state.draft.clear();
  render();
});

/* ---------- Save ---------------------------------------------------------- */
$('saveBtn').addEventListener('click', async () => {
  const btn = $('saveBtn');
  btn.disabled = true;
  btn.textContent = 'Saving…';
  showError(null);

  const { data: { session } } = await db.auth.getSession();

  const checkRows = [];
  const bagRows = [];

  state.draft.forEach((d, day) => {
    if (d.mortality !== null || d.culls !== null) {
      checkRows.push({
        cycle_id: state.cycle.id,
        day_number: day,
        checked_on: dateForDay(state.cycle.placed_on, day),
        mortality: d.mortality || 0,
        culls: d.culls || 0,
        recorded_by: session?.user?.id ?? null
      });
    }
    if (d.bag && !state.bags.has(day)) {
      bagRows.push({
        cycle_id: state.cycle.id,
        opened_on: dateForDay(state.cycle.placed_on, day),
        phase: phaseForDay(day)
      });
    }
  });

  if (checkRows.length) {
    // Ordered by day so the running-total guard in the database sees a
    // coherent sequence rather than an arbitrary one.
    checkRows.sort((a, b) => a.day_number - b.day_number);

    const { error } = await db
      .from('daily_checks')
      .upsert(checkRows, { onConflict: 'cycle_id,day_number' });

    if (error) {
      btn.disabled = false;
      refreshTotals();
      showError(error.message);
      return;
    }
  }

  if (bagRows.length) {
    const { error } = await db.from('feed_bag_openings').insert(bagRows);
    if (error) showError(`Days saved, but some bags were not: ${error.message}`);
  }

  // Re-read rather than assume the write landed as sent.
  state.draft.clear();
  state.saved.clear();
  state.bags.clear();
  await boot();

  btn.textContent = 'Saved';
  setTimeout(refreshTotals, 1500);
});

/* ---------- Go ------------------------------------------------------------ */
boot();
