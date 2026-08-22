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
  bags: new Map()     // day number -> [{ id, phase }] already recorded, oldest first
};

const PHASES = ['Starter', 'Grower', 'Finisher'];

/* What phase a day's bags are on file as, or Roost's best guess if none are
   recorded yet. A day is assumed uniform — every bag on it opened for the
   same feed — which is how it is entered here and everywhere else in Roost. */
function currentPhase(day) {
  const rows = state.bags.get(day);
  return (rows && rows.length) ? rows[0].phase : phaseForDay(day);
}

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
    // Only the whole-day 'DAY' session, never AM/PM — backfill has no way to
    // ask which half of the day a paper record covers, so it stays out of
    // days already split into sessions rather than guessing.
    db.from('daily_checks')
      .select('day_number, mortality, culls, session')
      .eq('cycle_id', state.cycle.id)
      .eq('session', 'DAY'),
    db.from('feed_bag_openings')
      .select('id, opened_on, phase')
      .eq('cycle_id', state.cycle.id)
      .order('id')
  ]);

  if (checks.error) { showError(`Could not load existing checks: ${checks.error.message}`); return; }

  (checks.data || []).forEach((r) => state.saved.set(r.day_number, r));

  // Bag openings are stored one row per bag, by date; map them back onto day
  // numbers, since a day can have opened several.
  (bags.data || []).forEach((b) => {
    const day = daysBetween(state.cycle.placed_on, b.opened_on) + 1;
    if (!state.bags.has(day)) state.bags.set(day, []);
    state.bags.get(day).push({ id: b.id, phase: b.phase });
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

    // A count, not a yes/no: a paper record can easily show three bags on one
    // day. Days that already have bags start at that number, and this number
    // can now be corrected either way — raised to add more, or lowered to
    // remove a mistaken entry.
    const already = (state.bags.get(day) || []).length;
    const bagVal = draft ? draft.bag : (already || '');
    const bags = numberInput(day, 'bag', bagVal);
    if (already) {
      bags.title = `${already} already recorded. Change this number to correct it.`;
    }

    // Meaningless without a bag, so it dims rather than vanishes — the column
    // stays put and nothing shifts as the count changes.
    const phase = phaseSelect(day, draft ? draft.phase : currentPhase(day));
    phase.disabled = !(Number(bagVal) > 0);
    bags.addEventListener('input', () => {
      phase.disabled = !(Number(bags.value) > 0);
    });

    row.append(label, deaths, culls, bags, phase);
    frag.appendChild(row);
  }

  rows.appendChild(frag);
  $('rowsLoading').hidden = true;
  $('dayList').hidden = false;
  refreshTotals();
}

const FIELD_LABEL = { mortality: 'Deaths', culls: 'Culls', bag: 'Bags opened' };

function numberInput(day, field, value) {
  const input = document.createElement('input');
  input.type = 'number';
  input.inputMode = 'numeric';
  input.min = '0';
  input.step = '1';
  input.className = 'day-row__num';
  input.value = value === null || value === undefined ? '' : value;
  input.placeholder = '–';
  input.setAttribute('aria-label', `${FIELD_LABEL[field]} on day ${day}`);

  input.addEventListener('input', () => {
    const d = ensureDraft(day);
    d[field] = input.value === '' ? null : Math.max(0, parseInt(input.value, 10) || 0);
    input.closest('.day-row').classList.add('is-dirty');
    refreshTotals();
  });

  return input;
}

function phaseSelect(day, value) {
  const sel = document.createElement('select');
  sel.className = 'day-row__phase';
  sel.setAttribute('aria-label', `Feed type on day ${day}`);
  PHASES.forEach((p) => {
    const o = document.createElement('option');
    o.value = p;
    o.textContent = p;
    if (p === value) o.selected = true;
    sel.appendChild(o);
  });
  sel.addEventListener('change', () => {
    const d = ensureDraft(day);
    d.phase = sel.value;
    sel.closest('.day-row').classList.add('is-dirty');
  });
  return sel;
}

function ensureDraft(day) {
  if (!state.draft.has(day)) {
    const saved = state.saved.get(day);
    state.draft.set(day, {
      mortality: saved ? saved.mortality : null,
      culls: saved ? saved.culls : null,
      bag: (state.bags.get(day) || []).length,
      phase: currentPhase(day)
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
  state.draft.forEach((d, day) => {
    const already = state.bags.get(day) || [];
    const bagChanged = (d.bag || 0) !== already.length;
    const phaseChanged = already.length > 0 && d.phase && d.phase !== currentPhase(day);
    if (d.mortality !== null || d.culls !== null || bagChanged || phaseChanged) n++;
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
  const bagInserts = [];
  const bagDeletes = [];   // ids to remove entirely
  const bagUpdates = [];   // { ids, phase } — feed type corrected on rows kept

  state.draft.forEach((d, day) => {
    if (d.mortality !== null || d.culls !== null) {
      checkRows.push({
        cycle_id: state.cycle.id,
        day_number: day,
        session: 'DAY',
        checked_on: dateForDay(state.cycle.placed_on, day),
        mortality: d.mortality || 0,
        culls: d.culls || 0,
        recorded_by: session?.user?.id ?? null
      });
    }

    // A correction, not only an addition: raising the count adds bags,
    // lowering it removes them, and the feed type can be fixed either way —
    // this screen no longer treats what is already on file as untouchable.
    const have = state.bags.get(day) || [];
    const want = Math.max(0, d.bag || 0);
    const phase = d.phase || currentPhase(day);

    if (want > have.length) {
      // Every existing bag is kept; correct its feed type if that changed,
      // and add the shortfall in the chosen type.
      if (have.length && have.some((r) => r.phase !== phase)) {
        bagUpdates.push({ ids: have.map((r) => r.id), phase });
      }
      for (let i = 0; i < want - have.length; i++) {
        bagInserts.push({
          cycle_id: state.cycle.id,
          opened_on: dateForDay(state.cycle.placed_on, day),
          phase
        });
      }
    } else if (want < have.length) {
      // Which specific rows survive does not matter — a bag carries no
      // information beyond its date and feed type, and both are already
      // being set here — so the oldest `want` rows are kept and the rest
      // removed, correcting the feed type on the survivors if needed.
      const keep = have.slice(0, want);
      const drop = have.slice(want);
      if (keep.length && keep.some((r) => r.phase !== phase)) {
        bagUpdates.push({ ids: keep.map((r) => r.id), phase });
      }
      drop.forEach((r) => bagDeletes.push(r.id));
    } else if (have.length && have.some((r) => r.phase !== phase)) {
      // Count unchanged; only the feed type was corrected.
      bagUpdates.push({ ids: have.map((r) => r.id), phase });
    }
  });

  if (checkRows.length) {
    // Ordered by day so the running-total guard in the database sees a
    // coherent sequence rather than an arbitrary one.
    checkRows.sort((a, b) => a.day_number - b.day_number);

    const { error } = await db
      .from('daily_checks')
      .upsert(checkRows, { onConflict: 'cycle_id,day_number,session' });

    if (error) {
      btn.disabled = false;
      refreshTotals();
      showError(error.message);
      return;
    }
  }

  const bagErrors = [];

  if (bagInserts.length) {
    const { error } = await db.from('feed_bag_openings').insert(bagInserts);
    if (error) bagErrors.push(`some bags were not added (${error.message})`);
  }
  if (bagDeletes.length) {
    const { error } = await db.from('feed_bag_openings').delete().in('id', bagDeletes);
    if (error) bagErrors.push(`some bags were not removed (${error.message})`);
  }
  for (const u of bagUpdates) {
    const { error } = await db.from('feed_bag_openings').update({ phase: u.phase }).in('id', u.ids);
    if (error) { bagErrors.push(`some feed types were not corrected (${error.message})`); break; }
  }
  if (bagErrors.length) showError(`Days saved, but ${bagErrors.join('; ')}.`);

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
