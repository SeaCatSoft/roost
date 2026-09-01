/* =============================================================================
   Roost — My Farm, the owner's view

   The business rather than the flock: what is owed, what is not yet billed,
   how the plan is holding up, and where this cycle is heading.

   Owner-only, and the database agrees (016) — every table behind these screens
   refuses writes from anyone else. This page checks the role too, because
   being shown a control that fails on save is a poor way to learn you cannot
   use it. The check here is courtesy; the policy is the control.

   Every figure is read from the same views the other screens use. Only the
   forecast is computed here, from the shared breed curve in db.js, so it
   cannot drift from the weights screen.
   ========================================================================== */

import {
  db, isConfigured, $, today, daysBetween, banner, myRole, standardWeightAt
} from './db.js';

const screens = {
  setup: $('setupScreen'), auth: $('authScreen'), deny: $('denyScreen'), app: $('appScreen')
};
const show = (n) => Object.entries(screens).forEach(([k, el]) => { el.hidden = k !== n; });
const showError = (m) => banner($('appError'), $('appErrorText'), m);

if (!isConfigured) { show('setup'); throw new Error('Supabase is not configured'); }

const state = { farm: null, cycle: null };

const num = (n, d = 0) =>
  Number(n ?? 0).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
const money = (v) => {
  const n = Number(v ?? 0);
  return (n < 0 ? '−$' : '$') + num(Math.abs(n), 2);
};
const shortDate = (iso) =>
  new Date(iso + 'T00:00:00').toLocaleDateString(undefined, { day: 'numeric', month: 'short' });

const KG_PER_LB = 0.45359237;

/* ---------- Load ---------------------------------------------------------- */
async function boot() {
  const { data: { session } } = await db.auth.getSession();
  if (!session) { show('auth'); return; }

  const role = await myRole();
  if (role !== 'owner') {
    $('denyText').textContent =
      `Your account has ${role} access to this farm. Only an owner can open My Farm.`;
    show('deny');
    return;
  }

  show('app');
  showError(null);

  let { data: farms, error: farmsError } = await db.from('farms')
    .select('id, name, forecast_opt_in').order('id').limit(1);

  // Older databases have no forecast_opt_in yet (migration 019). Fall back
  // to what does exist rather than blocking the whole owner view on one
  // optional toggle.
  if (farmsError && farmsError.message.includes('does not exist')) {
    state.forecastOptInUnsupported = true;
    ({ data: farms } = await db.from('farms').select('id, name').order('id').limit(1));
  }

  if (!farms || !farms.length) { showError('No farm is linked to this account yet.'); return; }
  state.farm = farms[0];
  $('barTitle').textContent = state.farm.name;
  $('farmTitle').textContent = state.farm.name;
  renderForecastOptIn();

  const [ageing, balances, unsent, cycles, book] = await Promise.all([
    db.from('v_invoice_ageing').select('*').maybeSingle(),
    db.from('v_customer_balances').select('*'),
    db.from('v_unsent_invoices').select('*').order('issued_on', { ascending: false }),
    db.from('cycles').select('id, label, placed_on, birds_placed, target_sale_age, closed_at')
      .order('placed_on', { ascending: false }).limit(1),
    db.from('v_order_book').select('*').maybeSingle()
  ]);

  if (unsent.error && unsent.error.message.includes('does not exist')) {
    showError('This screen needs migration 016. Run backend/migrations/016_owner_only.sql in Supabase.');
    return;
  }

  renderOwed(ageing.data, balances.data || []);
  renderBook(book.data);
  renderUnsent(unsent.data || []);

  state.cycle = cycles.data && cycles.data.length ? cycles.data[0] : null;
  if (!state.cycle) {
    $('actualBasis').textContent = 'No cycle yet.';
    $('forecastBasis').textContent = 'No cycle yet — start one and this fills in.';
    return;
  }

  await Promise.all([renderActual(), renderForecast()]);
}

/* ---------- Owed ---------------------------------------------------------- */
function renderOwed(a, balances) {
  const total = Number(a?.outstanding ?? 0);
  $('owedTotal').textContent = money(total);
  $('owedTotal').style.color = total > 0 ? 'var(--warn)' : 'var(--accent)';
  $('owedSub').textContent = total > 0
    ? `across ${num(a.open_invoices)} invoice${a.open_invoices === 1 ? '' : 's'}`
    : 'Nothing outstanding.';

  const buckets = [
    ['Not yet due', a?.current, false],
    ['1–30 days', a?.d1_30, true],
    ['31–60 days', a?.d31_60, true],
    ['61–90 days', a?.d61_90, true],
    ['Over 90', a?.d90_plus, true]
  ].filter(([, v]) => Number(v ?? 0) > 0.005);

  const wrap = $('ageing');
  wrap.textContent = '';
  if (buckets.length) {
    const max = Math.max(...buckets.map(([, v]) => Number(v)));
    buckets.forEach(([label, v, late]) => {
      const row = document.createElement('div');
      row.className = 'age-row';
      row.innerHTML =
        `<span class="age-row__label">${label}</span>
         <span class="age-row__track"><span class="age-row__fill${late ? ' is-late' : ''}"
               style="width:${(Number(v) / max * 100).toFixed(1)}%"></span></span>
         <span class="age-row__val tnum">${money(v)}</span>`;
      wrap.appendChild(row);
    });
  }

  // Name the worst payer rather than leaving the owner to work it out.
  const worst = balances
    .filter((c) => Number(c.outstanding) > 0.005)
    .sort((a2, b2) => Number(b2.worst_overdue ?? 0) - Number(a2.worst_overdue ?? 0))[0];

  $('worstNote').textContent = worst && Number(worst.worst_overdue ?? 0) > 0
    ? `Longest waiting: ${worst.name}, ${money(worst.outstanding)} at ${num(worst.worst_overdue)} days past due.`
    : (total > 0 ? 'Nothing is past its due date yet.' : '');
}

/* ---------- On order ------------------------------------------------------- */
/* Confirmed is what the farm is actually committed to delivering. Drafts are
   shown separately because a draft holds no stock and nobody is expecting it. */
function renderBook(b) {
  $('bookStats').innerHTML =
    `<div><div class="metric__k">Confirmed</div><div class="metric__v tnum">${money(b?.confirmed_value)}</div></div>
     <div><div class="metric__k">Drafts</div><div class="metric__v tnum">${num(b?.drafts)}</div></div>
     <div><div class="metric__k">Late</div><div class="metric__v tnum" style="color:${
       Number(b?.overdue ?? 0) > 0 ? 'var(--warn)' : 'inherit'}">${num(b?.overdue)}</div></div>`;

  const parts = [];
  if (Number(b?.confirmed_lb ?? 0) > 0) parts.push(`${num(b.confirmed_lb, 1)} lb promised.`);
  if (b?.next_needed_by) parts.push(`Next delivery due ${shortDate(b.next_needed_by)}.`);
  if (Number(b?.overdue ?? 0) > 0) {
    parts.push('Something is past its delivery date — that is a customer waiting, not a number.');
  }
  $('bookNote').textContent = parts.join(' ') || 'Nothing on order.';
}

/* ---------- Raised, not yet sent ------------------------------------------ */
function renderUnsent(rows) {
  $('unsentCount').textContent = rows.length
    ? `${money(rows.reduce((t, r) => t + Number(r.total || 0), 0))} in ${rows.length}`
    : '';

  const wrap = $('unsentList');
  wrap.textContent = '';

  if (!rows.length) {
    wrap.innerHTML = '<p class="caption">No drafts waiting. Everything raised has been sent.</p>';
    return;
  }

  rows.forEach((r) => {
    const row = document.createElement('div');
    row.className = 'age-row';
    row.innerHTML =
      `<span class="age-row__label">${r.number}</span>
       <span style="font-size:.8125rem;color:var(--ink-2);min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${r.customer} · ${shortDate(r.issued_on)}</span>
       <span class="age-row__val tnum">${money(r.total)}</span>`;
    wrap.appendChild(row);
  });

  const stale = rows.filter((r) => Number(r.days_since_issued) > 7).length;
  if (stale) {
    const p = document.createElement('p');
    p.className = 'caption';
    p.style.marginTop = '.75rem';
    p.style.color = 'var(--warn)';
    p.textContent = `${stale} ${stale === 1 ? 'has' : 'have'} been sitting over a week. Nothing gets paid until it is sent.`;
    wrap.appendChild(p);
  }
}

/* A booked date matters here even before anything has been processed — it is
   the one thing this panel can say about a cycle with nothing to compare
   yet. A past booking says nothing; once it has happened, silence is the
   right answer until the run itself is recorded. */
function renderBookingNote(booking) {
  const el = $('bookingNote');
  if (!booking || booking.is_past) { el.hidden = true; return; }
  el.textContent = `Processing booked for ${shortDate(booking.booked_on)}.`;
  el.hidden = false;
}

/* ---------- Plan against actual ------------------------------------------- */
async function renderActual() {
  const [{ data }, { data: booking }] = await Promise.all([
    db.from('v_cycle_actual').select('*').eq('cycle_id', state.cycle.id).maybeSingle(),
    // One row per cycle (020_processing_bookings.sql) — older databases
    // have no such view, so this fails soft rather than blocking the panel.
    db.from('v_processing_bookings').select('booked_on, is_past')
      .eq('cycle_id', state.cycle.id).maybeSingle()
  ]);

  renderBookingNote(booking);

  const wrap = $('actualRows');
  wrap.textContent = '';

  if (!data || !Number(data.runs)) {
    $('actualBasis').textContent =
      `${state.cycle.label} has not been processed yet — this compares the plan against real weigh-outs once it has.`;
    return;
  }

  $('actualBasis').textContent =
    `${state.cycle.label}: ${num(data.runs)} run${data.runs === 1 ? '' : 's'}, ` +
    `${num(data.birds_processed)} birds processed.`;

  // Only measured-against-planned pairs. A row with nothing to compare against
  // is noise, so it is left out rather than shown as a dash.
  const rows = [
    ['Saleable weight', Number(data.saleable_lb), Number(data.saleable_lb_planned), 'lb', 1],
    ['Birds', Number(data.birds_processed), Number(data.birds_planned), '', 0],
    ['Revenue', Number(data.revenue_actual), Number(data.revenue_planned), '$', 2],
    ['Dressing yield', Number(data.dressing_yield_actual) * 100, null, '%', 1],
    ['Blended price', Number(data.blended_price_actual), null, '$', 2]
  ];

  rows.forEach(([label, actual, planned, unit, dp]) => {
    if (!isFinite(actual) || actual === 0) return;
    const fmt = (v) => unit === '$' ? money(v) : num(v, dp) + (unit ? ` ${unit}` : '');
    const pct = planned ? (actual / planned - 1) * 100 : null;

    const row = document.createElement('div');
    row.className = 'cmp-row';
    row.innerHTML =
      `<span class="cmp-row__label">${label}</span>
       <span class="cmp-row__val tnum">${fmt(actual)}</span>
       <span class="cmp-row__val tnum" style="color:${
         pct == null ? 'var(--ink-3)' : (pct < -2 ? 'var(--warn)' : 'var(--ink-3)')}">${
         pct == null ? 'no plan' : (pct >= 0 ? '+' : '') + num(pct, 1) + '%'}</span>`;
    wrap.appendChild(row);
  });

  const profit = Number(data.profit_actual);
  if (isFinite(profit) && profit !== 0) {
    const p = document.createElement('p');
    p.className = 'caption';
    p.style.marginTop = '.9rem';
    p.innerHTML = `Against the modelled cost stack, this cycle made <strong style="color:${
      profit < 0 ? 'var(--warn)' : 'var(--accent)'}">${money(profit)}</strong>. ` +
      'Costs stay modelled — real costs would need every supplier invoice entered.';
    wrap.appendChild(p);
  }
}

/* ---------- Forecast ------------------------------------------------------ */
/* Projects the finish from what the flock is actually doing, not from the
   plan. Two questions an owner has mid-cycle: will they make weight, and what
   is the feed going to cost by the end. */
async function renderForecast() {
  const cycle = state.cycle;

  if (cycle.closed_at) {
    $('forecastBasis').textContent = `${cycle.label} is closed. Start a cycle to forecast the next one.`;
    return;
  }

  const day = Math.max(1, Math.min(
    daysBetween(cycle.placed_on, today()) + 1, cycle.target_sale_age));

  const [progress, samples, bags, assumptions, feedPlan, pnl] = await Promise.all([
    db.from('v_cycle_progress').select('*').eq('cycle_id', cycle.id).maybeSingle(),
    db.from('sample_weights').select('day_number, avg_weight_g')
      .eq('cycle_id', cycle.id).order('day_number'),
    db.from('feed_bag_openings').select('opened_on').eq('cycle_id', cycle.id),
    db.from('cycle_assumptions').select('bag_size_kg, live_weight_lb, mortality_rate')
      .eq('cycle_id', cycle.id).maybeSingle(),
    db.from('v_cycle_feed_totals').select('*').eq('cycle_id', cycle.id).maybeSingle(),
    db.from('v_cycle_pnl').select('*').eq('cycle_id', cycle.id).maybeSingle()
  ]);

  const bagSize = Number(assumptions.data?.bag_size_kg ?? 30);
  const birdsAlive = Number(progress.data?.birds_alive ?? cycle.birds_placed);
  const daysLeft = Math.max(cycle.target_sale_age - day, 0);

  const feedKg = (bags.data || []).length * bagSize;
  const latest = (samples.data || []).length
    ? samples.data[samples.data.length - 1] : null;

  if (!latest) {
    $('forecastBasis').textContent =
      `Day ${day} of ${cycle.target_sale_age}. No weighing recorded yet — weigh a sample and this forecasts the finish.`;
    $('forecastStats').innerHTML = '';
    return;
  }

  const weightNowG = Number(latest.avg_weight_g);
  const stdNowG = standardWeightAt(latest.day_number);
  const stdFinalG = standardWeightAt(cycle.target_sale_age);

  // How the flock sits against the breed objective, carried forward. Simply
  // extrapolating the observed daily gain understates a broiler badly, because
  // the growth curve steepens; holding the ratio to the published curve is the
  // more honest projection from a single weighing.
  const ratio = stdNowG > 0 ? weightNowG / stdNowG : 1;
  const projectedFinalG = stdFinalG * ratio;

  const liveNowKg = birdsAlive * (weightNowG / 1000);
  const fcrNow = liveNowKg > 0 && feedKg > 0 ? feedKg / liveNowKg : null;

  const plannedFeedKg = Number(feedPlan.data?.total_feed_kg ?? 0);
  const plannedFinalG = Number(assumptions.data?.live_weight_lb ?? 0) * KG_PER_LB * 1000;

  // Feed to the finish: scale the planned total by how far off-plan
  // consumption has run so far, rather than re-deriving an intake curve here.
  const feedPace = plannedFeedKg > 0 && day > 0
    ? feedKg / (plannedFeedKg * (day / cycle.target_sale_age))
    : 1;
  const projectedTotalFeedKg = plannedFeedKg > 0
    ? plannedFeedKg * (isFinite(feedPace) && feedPace > 0 ? feedPace : 1)
    : feedKg;

  const projectedLiveKg = birdsAlive * (projectedFinalG / 1000);
  const projectedFcr = projectedLiveKg > 0 ? projectedTotalFeedKg / projectedLiveKg : null;

  $('forecastBasis').textContent =
    `Day ${day} of ${cycle.target_sale_age}, ${num(daysLeft)} to go. ` +
    `Projected from the weighing on day ${latest.day_number} (${num(weightNowG)} g) ` +
    `and ${num(feedKg)} kg of feed drawn.`;

  $('forecastStats').innerHTML =
    `<div><div class="metric__k">Finish weight</div><div class="metric__v tnum">${num(projectedFinalG / 1000, 2)} kg</div></div>
     <div><div class="metric__k">FCR now</div><div class="metric__v tnum">${fcrNow ? num(fcrNow, 2) : '—'}</div></div>
     <div><div class="metric__k">FCR at finish</div><div class="metric__v tnum" style="color:${
       projectedFcr && projectedFcr > 1.75 ? 'var(--warn)' : 'inherit'}">${projectedFcr ? num(projectedFcr, 2) : '—'}</div></div>`;

  // Against plan, as bars: weight and feed are the two levers.
  const bars = [
    ['Finish weight', projectedFinalG, plannedFinalG, (v) => num(v / 1000, 2) + ' kg', true],
    ['Feed used', projectedTotalFeedKg, plannedFeedKg, (v) => num(v) + ' kg', false]
  ];

  const wrap = $('forecastBars');
  wrap.textContent = '';
  bars.forEach(([label, proj, plan, fmt, higherIsBetter]) => {
    if (!plan) return;
    const max = Math.max(proj, plan) * 1.05;
    const good = higherIsBetter ? proj >= plan * 0.98 : proj <= plan * 1.02;
    wrap.insertAdjacentHTML('beforeend',
      `<div style="margin-bottom:.9rem">
         <div class="bar__top"><span>${label} — projected</span><span class="tnum">${fmt(proj)}</span></div>
         <div class="bar__track"><div class="bar__fill" style="width:${(proj / max * 100).toFixed(1)}%;background:${
           good ? 'var(--accent)' : 'var(--warn)'}"></div></div>
         <div class="bar__top" style="margin-top:.35rem"><span class="caption">planned</span><span class="tnum caption">${fmt(plan)}</span></div>
         <div class="bar__track"><div class="bar__fill bar__fill--muted" style="width:${(plan / max * 100).toFixed(1)}%"></div></div>
       </div>`);
  });

  // What it means in money, and what to actually do about it.
  const breakeven = Number(pnl.data?.breakeven_price_lb ?? 0);
  const weightGap = plannedFinalG > 0 ? projectedFinalG / plannedFinalG - 1 : 0;
  const feedGap = plannedFeedKg > 0 ? projectedTotalFeedKg / plannedFeedKg - 1 : 0;

  const parts = [];
  if (Math.abs(weightGap) > 0.02) {
    parts.push(weightGap < 0
      ? `Birds are tracking ${num(Math.abs(weightGap) * 100, 0)}% under the target weight. Every gram short is saleable weight you do not get to sell.`
      : `Birds are tracking ${num(weightGap * 100, 0)}% over target weight — more saleable weight than planned.`);
  }
  if (Math.abs(feedGap) > 0.03) {
    parts.push(feedGap > 0
      ? `Feed is running ${num(feedGap * 100, 0)}% ahead of plan. Check for spillage, wet litter and feeder height before assuming the birds simply ate more.`
      : `Feed is running ${num(Math.abs(feedGap) * 100, 0)}% under plan — worth confirming the birds are actually eating enough, not that a bag went unrecorded.`);
  }
  if (projectedFcr && projectedFcr > 1.75) {
    parts.push(`A finishing FCR of ${num(projectedFcr, 2)} against a 1.55–1.65 objective is the single biggest lever here: at this size of flock, closing that gap is worth more than any price change.`);
  }
  if (breakeven > 0) {
    parts.push(`Breakeven on the current plan is ${money(breakeven)} a pound.`);
  }

  $('forecastNote').textContent = parts.length
    ? parts.join(' ')
    : 'Tracking close to plan on both weight and feed.';
}

/* ---------- Cycle forecasts opt-in ----------------------------------------
   Off by default (018/019): a stranger's real farm data should not run
   through an experimental analytics feature until its owner chooses it.
   Writing straight to farms on toggle, same as any other owner-only setting
   — RLS's farms_write policy is what actually enforces "only the owner". */
function renderForecastOptIn() {
  const btn = $('forecastOptInSwitch');
  const hint = $('forecastOptInHint');

  if (state.forecastOptInUnsupported) {
    btn.disabled = true;
    hint.textContent = 'Needs migration 019 — run 019_forecast_opt_in.sql in Supabase to enable this.';
    return;
  }

  btn.setAttribute('aria-checked', String(!!state.farm.forecast_opt_in));
  hint.textContent = state.farm.forecast_opt_in
    ? 'On — this farm\'s data is included in the daily forecast run.'
    : 'Off — this farm is not included in the daily forecast run.';
}

$('forecastOptInSwitch').addEventListener('click', async () => {
  const btn = $('forecastOptInSwitch');
  const next = btn.getAttribute('aria-checked') !== 'true';

  btn.disabled = true;
  const { error } = await db.from('farms')
    .update({ forecast_opt_in: next }).eq('id', state.farm.id);
  btn.disabled = false;

  if (error) {
    $('forecastOptInHint').textContent = `Could not save: ${error.message}`;
    return;
  }
  state.farm.forecast_opt_in = next;
  renderForecastOptIn();
});

$('signOutBtn').addEventListener('click', async () => {
  await db.auth.signOut();
  window.location.href = './';
});

boot();
