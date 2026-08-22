/* =============================================================================
   Roost — processing planner

   Answers one question: pick a date, what will the birds weigh. Not a generic
   breed table — it carries the flock's own measured feed conversion forward
   onto the farm's own planned feed curve, so a flock running heavier or
   lighter than the breed standard says so here too.

   The maths, in one line: take the feed the flock is planned to have eaten by
   that date (from the feed curve already on file), divide by this flock's own
   current FCR, and that is the live weight the birds should be carrying.
   Divide by the birds alive today and that is the average per bird.

   Two assumptions, both stated on screen rather than buried in the code:
     - FCR holds steady from here on. It usually drifts a little as birds
       approach market weight, so treat the far end of the lookahead as
       rougher than the near end.
     - No further losses. Further mortality is its own risk, not a feed-
       conversion question, so it is not folded in here.

   Read-only. Nothing here writes anything, so there is no database policy
   backing the owner-only gate below — it exists because deciding when to
   book the processor is a business call, not because the underlying reads
   are restricted. A member reading sample_weights or the feed curve directly
   would not be refused; this screen simply is not offered to them.
   ========================================================================== */

import {
  db, isConfigured, $, today, daysBetween, dateForDay, banner, myRole
} from './db.js';

const screens = {
  setup: $('setupScreen'), auth: $('authScreen'), deny: $('denyScreen'), app: $('appScreen')
};
const show = (n) => Object.entries(screens).forEach(([k, el]) => { el.hidden = k !== n; });
const showError = (m) => banner($('appError'), $('appErrorText'), m);

if (!isConfigured) { show('setup'); throw new Error('Supabase is not configured'); }

const state = { cycle: null, feedPlan: [], birdsAlive: 0, latest: null, currentFcr: null };

const num = (n, d = 0) =>
  Number(n ?? 0).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
const LB_PER_KG = 2.2046226;

/* ---------- Load ---------------------------------------------------------- */
async function boot() {
  const { data: { session } } = await db.auth.getSession();
  if (!session) { show('auth'); return; }

  const role = await myRole();
  if (role !== 'owner') {
    $('denyText').textContent =
      `Your account has ${role} access to this farm. Only an owner can open the processing planner.`;
    show('deny');
    return;
  }

  show('app');
  showError(null);

  const { data: cycles } = await db.from('cycles')
    .select('id, label, placed_on, birds_placed, target_sale_age')
    .is('closed_at', null)
    .order('placed_on', { ascending: false })
    .limit(1);

  if (!cycles || !cycles.length) {
    showError('No open cycle to plan for. Start one and this fills in.');
    $('cycleLabel').textContent = 'No open cycle';
    return;
  }

  state.cycle = cycles[0];
  $('cycleLabel').textContent = state.cycle.label;

  const day = Math.max(1, Math.min(
    daysBetween(state.cycle.placed_on, today()) + 1, state.cycle.target_sale_age + 30));
  state.today = day;
  $('todayDay').textContent = `Day ${day}`;

  const [progress, samples, bags, assumptions, feedPlan] = await Promise.all([
    db.from('v_cycle_progress').select('birds_alive').eq('cycle_id', state.cycle.id).maybeSingle(),
    db.from('sample_weights').select('day_number, avg_weight_g')
      .eq('cycle_id', state.cycle.id).order('day_number'),
    db.from('feed_bag_openings').select('opened_on').eq('cycle_id', state.cycle.id),
    db.from('cycle_assumptions').select('bag_size_kg').eq('cycle_id', state.cycle.id).maybeSingle(),
    db.from('v_cycle_feed_plan').select('week, weekly_kg')
      .eq('cycle_id', state.cycle.id).order('week')
  ]);

  if (feedPlan.error && feedPlan.error.message.includes('does not exist')) {
    showError('This screen needs the feed plan view from migration 002. Check earlier migrations are applied.');
    return;
  }

  state.birdsAlive = Number(progress.data?.birds_alive ?? state.cycle.birds_placed);
  state.feedPlan = feedPlan.data || [];

  const bagSize = Number(assumptions.data?.bag_size_kg ?? 30);
  const actualFeedKg = (bags.data || []).length * bagSize;

  state.latest = (samples.data || []).length ? samples.data[samples.data.length - 1] : null;

  if (!state.latest) {
    showError(null);
    $('latestWeight').textContent = '—';
    $('currentFcr').textContent = '—';
    $('cycleLabel').textContent = `${state.cycle.label} — weigh a sample first`;
    return;
  }

  const weightNowKg = Number(state.latest.avg_weight_g) / 1000;
  const liveNowKg = state.birdsAlive * weightNowKg;
  state.currentFcr = liveNowKg > 0 && actualFeedKg > 0 ? actualFeedKg / liveNowKg : null;

  $('latestWeight').textContent =
    `${num(Number(state.latest.avg_weight_g))} g on day ${state.latest.day_number}`;
  $('currentFcr').textContent = state.currentFcr ? num(state.currentFcr, 2) : '—';

  if (!state.currentFcr) {
    showError('Feed has not been logged for this flock yet, so a current FCR cannot be worked out.');
    return;
  }
  if (!state.feedPlan.length) {
    showError('This cycle has no feed curve on file, so a future date cannot be projected.');
    return;
  }

  setupCalculator();
}

/* ---------- Cumulative planned feed at any day -----------------------------
   The feed curve is stored one row per week (kg for the whole flock, already
   adjusted for the assumed mortality curve). A day is converted to a week and
   a fraction of the way through it; a day past the last week on file holds the
   last week's rate flat rather than assuming feed intake keeps climbing
   forever, which it does not. */
function cumulativePlannedFeedKg(day) {
  const weeks = state.feedPlan;
  if (!weeks.length) return null;

  const lastWeek = weeks[weeks.length - 1].week;
  let total = 0;

  for (const w of weeks) {
    if (w.week * 7 <= day) {
      total += Number(w.weekly_kg);
    } else {
      const daysIntoWeek = day - (w.week - 1) * 7;
      const fraction = Math.max(0, Math.min(1, daysIntoWeek / 7));
      total += Number(w.weekly_kg) * fraction;
      return total;
    }
  }

  // Day is beyond the last week on file — hold that week's daily rate flat.
  const last = weeks[weeks.length - 1];
  const extraDays = day - lastWeek * 7;
  return total + (Number(last.weekly_kg) / 7) * Math.max(0, extraDays);
}

/* ---------- The projection --------------------------------------------------
   plannedFeed(day) / currentFCR = the total live weight the flock should be
   carrying that day, if it keeps converting feed the way it has so far.
   Dividing by today's bird count — not a mortality projection, that is a
   separate risk and folding it in here would hide it rather than track it. */
function predictAt(day) {
  const feedKg = cumulativePlannedFeedKg(day);
  if (feedKg == null || !state.currentFcr) return null;
  const totalLiveKg = feedKg / state.currentFcr;
  const perBirdG = (totalLiveKg / state.birdsAlive) * 1000;
  return { day, perBirdG, totalLiveKg };
}

/* ---------- Calculator ------------------------------------------------------ */
function setupCalculator() {
  $('calcPanel').hidden = false;

  const minDate = dateForDay(state.cycle.placed_on, state.today);
  const maxDay = state.cycle.target_sale_age + 21;
  const maxDate = dateForDay(state.cycle.placed_on, maxDay);

  const dateInput = $('targetDate');
  dateInput.min = minDate;
  dateInput.max = maxDate;
  dateInput.value = dateForDay(state.cycle.placed_on, state.cycle.target_sale_age);

  renderQuickPicks(minDate, maxDate);
  dateInput.addEventListener('change', () => { syncQuickPicks(); calculate(); });

  calculate();
  renderLookahead(maxDay);
}

function renderQuickPicks(minDate, maxDate) {
  const marks = [
    ['+1 week', 7], ['+2 weeks', 14], ['+3 weeks', 21],
    ['Target day', state.cycle.target_sale_age - state.today]
  ].filter(([, offset]) => offset > 0);

  const wrap = $('quickPicks');
  wrap.textContent = '';
  marks.forEach(([label, offset]) => {
    const d = dateForDay(state.cycle.placed_on, state.today + offset);
    if (d < minDate || d > maxDate) return;
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'chip-btn';
    b.setAttribute('data-press', '');
    b.setAttribute('data-date', d);
    b.textContent = label;
    b.addEventListener('click', () => { $('targetDate').value = d; syncQuickPicks(); calculate(); });
    wrap.appendChild(b);
  });
}

function syncQuickPicks() {
  const v = $('targetDate').value;
  document.querySelectorAll('#quickPicks .chip-btn').forEach((b) =>
    b.classList.toggle('is-selected', b.getAttribute('data-date') === v));
}

function calculate() {
  const dateVal = $('targetDate').value;
  if (!dateVal) return;

  const day = daysBetween(state.cycle.placed_on, dateVal) + 1;
  const warnBox = $('predictWarn');
  warnBox.textContent = '';

  if (day < state.today) {
    $('predictWeight').textContent = '—';
    $('predictSub').textContent = '';
    $('predictStats').innerHTML = '';
    $('predictNote').textContent = 'Pick a date from today onward.';
    return;
  }

  const result = predictAt(day);
  if (!result) {
    $('predictWeight').textContent = '—';
    $('predictNote').textContent = 'Could not project that date.';
    return;
  }

  const lb = (result.perBirdG / 453.59237);
  $('predictWeight').textContent = `${num(lb, 2)} lb`;
  $('predictSub').textContent =
    `${num(result.perBirdG)} g per bird, day ${day} of the cycle`;

  $('predictStats').innerHTML =
    `<div><div class="metric__k">Total live weight</div><div class="metric__v tnum">${
      num(result.totalLiveKg * LB_PER_KG)} lb</div></div>
     <div><div class="metric__k">Birds</div><div class="metric__v tnum">${num(state.birdsAlive)}</div></div>
     <div><div class="metric__k">Days from today</div><div class="metric__v tnum">${num(day - state.today)}</div></div>`;

  const daysOut = day - state.today;
  $('predictNote').textContent =
    `Assumes this flock keeps converting feed at its current FCR of ${num(state.currentFcr, 2)}, ` +
    `and that ${num(state.birdsAlive)} birds alive today stay alive. ` +
    (daysOut > 21
      ? 'That is a long reach from today — treat it as a rough steer, not a booking number.'
      : 'FCR usually drifts a little as birds near market weight, so the near dates are the more reliable ones.');

  if (day > state.cycle.target_sale_age + 7) {
    warnBox.innerHTML =
      `<div class="banner banner--warn" style="margin-top:1rem;text-align:left">
         <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M12 8.5v5M12 17h.01"/><circle cx="12" cy="12" r="9.5"/></svg>
         <div>That is well past this cycle's planned ${num(state.cycle.target_sale_age)}-day finish.
         The feed curve has been held flat past its last planned week, which understates
         intake for a flock genuinely kept running that long.</div>
       </div>`;
  }
}

/* ---------- Week by week --------------------------------------------------- */
function renderLookahead(maxDay) {
  const wrap = $('lookaheadList');
  wrap.textContent = '';
  $('lookaheadSection').hidden = false;

  const days = [];
  for (let d = Math.ceil(state.today / 7) * 7; d <= maxDay; d += 7) {
    if (d > state.today) days.push(d);
  }
  if (!days.length || days[0] !== state.today + 7) days.unshift(state.today + 7);

  days.forEach((d) => {
    const r = predictAt(d);
    if (!r) return;
    const row = document.createElement('div');
    row.className = 'age-row';
    const isTarget = d === state.cycle.target_sale_age;
    row.innerHTML =
      `<span class="age-row__label">Day ${d}${isTarget ? ' · target' : ''}</span>
       <span style="font-size:.8125rem;color:var(--ink-2)">${
         new Date(dateForDay(state.cycle.placed_on, d) + 'T00:00:00')
           .toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}</span>
       <span class="age-row__val tnum">${num(r.perBirdG / 453.59237, 2)} lb</span>`;
    wrap.appendChild(row);
  });
}

boot();
