/* =============================================================================
   Roost — feed dashboard
   Plan against actual, and the conversion ratio that follows from it.

   This is the screen that settles the open question: is the 1.90 FCR implied
   by the planner an artefact of the intake assumptions, or are the birds
   genuinely converting that poorly? Plan comes from the intake curve; actual
   comes from bags physically opened. Where they diverge is the answer.
   ========================================================================== */

import {
  db, isConfigured, $, today, daysBetween, banner, loadOpenCycle
} from './db.js';

const screens = { setup: $('setupScreen'), auth: $('authScreen'), app: $('appScreen') };
const show = (n) => Object.entries(screens).forEach(([k, el]) => { el.hidden = k !== n; });
const showError = (m) => banner($('appError'), $('appErrorText'), m);

if (!isConfigured) { show('setup'); throw new Error('Supabase is not configured'); }

const PHASES = ['Starter', 'Grower', 'Finisher'];
const FCR_TARGET_LOW = 1.55;
const FCR_TARGET_HIGH = 1.65;
const LB_PER_KG = 0.45359237;

const fmt = (n, d = 0) =>
  Number(n).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });

async function boot() {
  const { data: { session } } = await db.auth.getSession();
  if (!session) { show('auth'); return; }
  show('app');
  showError(null);

  let cycle;
  try { cycle = await loadOpenCycle(); }
  catch (e) { showError(e.message); return; }

  $('cycleLabel').textContent = cycle.label;

  const elapsed = Math.max(1, Math.min(
    daysBetween(cycle.placed_on, today()) + 1, cycle.target_sale_age
  ));

  const [planRes, phaseRes, bagRes, assumpRes, weightRes, progressRes] = await Promise.all([
    db.from('v_cycle_feed_plan')
      .select('week, phase, weekly_kg').eq('cycle_id', cycle.id).order('week'),
    db.from('v_cycle_feed_by_phase')
      .select('phase, phase_kg, bags').eq('cycle_id', cycle.id),
    db.from('feed_bag_openings')
      .select('opened_on, phase').eq('cycle_id', cycle.id).order('opened_on'),
    db.from('cycle_assumptions')
      .select('bag_size_kg, live_weight_lb').eq('cycle_id', cycle.id).maybeSingle(),
    db.from('sample_weights')
      .select('day_number, avg_weight_g').eq('cycle_id', cycle.id)
      .order('day_number', { ascending: false }).limit(1),
    db.from('v_cycle_progress')
      .select('birds_alive').eq('cycle_id', cycle.id).maybeSingle()
  ]);

  const firstError = [planRes, phaseRes, bagRes].find((r) => r.error);
  if (firstError) { showError(`Could not load feed data: ${firstError.error.message}`); return; }

  const plan = planRes.data || [];
  if (!plan.length) {
    showError('This cycle has no feed intake curve, so there is no plan to compare against.');
    return;
  }

  const bagSize = Number(assumpRes.data?.bag_size_kg ?? 30);
  const bags = bagRes.data || [];

  /* ---- Cumulative plan, by day ---------------------------------------- */
  // Each week's requirement spread evenly across its seven days, so a
  // part-finished week is credited proportionally rather than all-or-nothing.
  const lastDay = cycle.target_sale_age;
  const planCum = [0];
  for (let day = 1; day <= lastDay; day++) {
    let total = 0;
    plan.forEach((w) => {
      const start = (w.week - 1) * 7;
      const daysCounted = Math.min(7, Math.max(0, day - start));
      total += (Number(w.weekly_kg) / 7) * daysCounted;
    });
    planCum[day] = total;
  }

  /* ---- Cumulative actual, by day -------------------------------------- */
  const bagsByDay = new Map();
  bags.forEach((b) => {
    const d = daysBetween(cycle.placed_on, b.opened_on) + 1;
    if (d >= 1 && d <= lastDay) bagsByDay.set(d, (bagsByDay.get(d) || 0) + 1);
  });

  const actualCum = [0];
  let running = 0;
  for (let day = 1; day <= lastDay; day++) {
    running += (bagsByDay.get(day) || 0) * bagSize;
    actualCum[day] = running;
  }

  /* ---- Headline figures ------------------------------------------------ */
  const actualKg = actualCum[elapsed];
  const plannedKg = planCum[elapsed];
  const actualBagCount = bags.length;
  const plannedBagCount = plannedKg / bagSize;
  const diffBags = actualBagCount - plannedBagCount;

  $('actualBags').textContent = `${fmt(actualBagCount)}`;
  $('plannedBags').textContent = `${fmt(plannedBagCount, 1)}`;
  $('variance').textContent = `${diffBags >= 0 ? '+' : '−'}${fmt(Math.abs(diffBags), 1)}`;

  renderVerdict({ actualBagCount, plannedBagCount, diffBags, actualKg, plannedKg, elapsed });
  renderChart({ planCum, actualCum, lastDay, elapsed });
  renderPhases({ phases: phaseRes.data || [], bags, bagSize });
  renderFcr({
    actualKg,
    plannedKg,
    birdsAlive: Number(progressRes.data?.birds_alive ?? cycle.birds_placed),
    sample: weightRes.data && weightRes.data[0],
    elapsed,
    cycle,
    modelledLb: Number(assumpRes.data?.live_weight_lb ?? 5.5)
  });
}

/* ---------- Verdict ------------------------------------------------------- */
function renderVerdict({ actualBagCount, plannedBagCount, diffBags, elapsed }) {
  const el = $('verdict');
  const text = $('verdictText');
  el.hidden = false;
  el.classList.remove('banner--ok', 'banner--warn', 'banner--error');

  if (actualBagCount === 0) {
    el.classList.add('banner--warn');
    text.innerHTML =
      'No bag openings recorded yet, so there is nothing to compare the plan against. ' +
      'Tick <strong>new feed bag opened</strong> on the daily check, or add past ones in ' +
      '<a href="backfill.html" style="text-decoration:underline">backfill</a>.';
    return;
  }

  const pct = plannedBagCount > 0 ? (diffBags / plannedBagCount) * 100 : 0;

  if (Math.abs(pct) < 5) {
    el.classList.add('banner--ok');
    text.textContent =
      `Running to plan through day ${elapsed} — within ${fmt(Math.abs(pct), 1)}% of expected.`;
  } else if (pct > 0) {
    el.classList.add('banner--warn');
    text.innerHTML =
      `<strong>${fmt(Math.abs(diffBags), 1)} bags ahead of plan</strong> (${fmt(pct, 1)}%). ` +
      'Either the birds are eating more than the curve assumes, or feed is going somewhere ' +
      'other than into birds — spillage, wet feed, or vermin are the usual causes.';
  } else {
    el.classList.add('banner--ok');
    text.innerHTML =
      `<strong>${fmt(Math.abs(diffBags), 1)} bags behind plan</strong> (${fmt(Math.abs(pct), 1)}%). ` +
      'If the birds are hitting weight anyway, the intake assumptions in the planner are ' +
      'set too high — which would explain the 1.90 conversion ratio it predicts.';
  }
}

/* ---------- Chart --------------------------------------------------------- */
function renderChart({ planCum, actualCum, lastDay, elapsed }) {
  const W = 340, H = 190, L = 40, R = 8, T = 10, B = 26;
  const maxKg = Math.max(planCum[lastDay], actualCum[lastDay], 1);

  const x = (day) => L + ((day / lastDay) * (W - L - R));
  const y = (kg) => H - B - ((kg / maxKg) * (H - T - B));

  const planPts = [];
  for (let d = 0; d <= lastDay; d++) planPts.push(`${x(d).toFixed(1)},${y(planCum[d]).toFixed(1)}`);
  $('planLine').setAttribute('d', 'M' + planPts.join('L'));

  // Actual is only drawn as far as today — projecting it would be inventing data.
  const actPts = [];
  for (let d = 0; d <= elapsed; d++) actPts.push(`${x(d).toFixed(1)},${y(actualCum[d]).toFixed(1)}`);
  $('actualLine').setAttribute('d', 'M' + actPts.join('L'));
  $('actualArea').setAttribute(
    'd',
    `M${x(0).toFixed(1)},${y(0).toFixed(1)}L` + actPts.join('L') +
    `L${x(elapsed).toFixed(1)},${y(0).toFixed(1)}Z`
  );

  $('todayLine').setAttribute('x1', x(elapsed));
  $('todayLine').setAttribute('x2', x(elapsed));
  $('todayLine').setAttribute('y1', T);
  $('todayLine').setAttribute('y2', H - B);

  // Gridlines and axis labels
  const grid = $('chartGrid');
  const labels = $('chartLabels');
  grid.textContent = '';
  labels.textContent = '';

  for (let i = 0; i <= 3; i++) {
    const kg = (maxKg / 3) * i;
    const gy = y(kg);
    const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    line.setAttribute('x1', L); line.setAttribute('x2', W - R);
    line.setAttribute('y1', gy); line.setAttribute('y2', gy);
    line.setAttribute('stroke', 'var(--hairline-2)');
    line.setAttribute('stroke-width', '1');
    grid.appendChild(line);

    const t = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    t.setAttribute('x', L - 6); t.setAttribute('y', gy + 3);
    t.setAttribute('text-anchor', 'end');
    t.setAttribute('font-size', '9');
    t.setAttribute('fill', 'var(--ink-3)');
    t.textContent = kg >= 1000 ? `${(kg / 1000).toFixed(1)}t` : Math.round(kg);
    labels.appendChild(t);
  }

  [1, Math.round(lastDay / 2), lastDay].forEach((d) => {
    const t = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    t.setAttribute('x', x(d)); t.setAttribute('y', H - 8);
    t.setAttribute('text-anchor', d === 1 ? 'start' : d === lastDay ? 'end' : 'middle');
    t.setAttribute('font-size', '9');
    t.setAttribute('fill', 'var(--ink-3)');
    t.textContent = `Day ${d}`;
    labels.appendChild(t);
  });

  $('chartNote').textContent =
    `Actual is drawn to day ${elapsed} only. Bags count as consumed on the day they were opened, ` +
    'so the line steps rather than slopes.';
}

/* ---------- Phase breakdown ----------------------------------------------- */
function renderPhases({ phases, bags, bagSize }) {
  const wrap = $('phaseRows');
  wrap.textContent = '';

  const openedByPhase = {};
  bags.forEach((b) => { openedByPhase[b.phase] = (openedByPhase[b.phase] || 0) + 1; });

  PHASES.forEach((phase) => {
    const planned = phases.find((p) => p.phase === phase);
    const plannedBags = planned ? Number(planned.bags) : 0;
    const opened = openedByPhase[phase] || 0;
    const pct = plannedBags > 0 ? Math.min(opened / plannedBags, 1.4) : 0;

    const row = document.createElement('div');
    row.className = 'phase-row';
    row.innerHTML =
      `<div class="phase-row__top">
         <span class="phase-row__name">${phase}</span>
         <span class="phase-row__nums tnum">${opened} / ${plannedBags} bags</span>
       </div>
       <div class="phase-row__track">
         <div class="phase-row__fill${opened > plannedBags ? ' phase-row__fill--over' : ''}"
              style="width:${(Math.min(pct, 1) * 100).toFixed(1)}%"></div>
       </div>`;
    wrap.appendChild(row);
  });
}

/* ---------- Feed conversion ----------------------------------------------- */
function renderFcr({ actualKg, birdsAlive, sample, elapsed, cycle, modelledLb }) {
  const valueEl = $('fcrValue');
  const basisEl = $('fcrBasis');
  const noteEl = $('fcrNote');
  const marker = $('fcrMarker');

  if (!actualKg) {
    valueEl.textContent = '—';
    basisEl.textContent = 'Needs bag openings before it can be calculated.';
    noteEl.textContent = '';
    marker.style.display = 'none';
    return;
  }

  // Live weight: a real sample beats a modelled curve. Say which is in use —
  // an FCR quoted off an assumed weight is close to meaningless.
  let weightKg, basis, measured;
  if (sample) {
    weightKg = Number(sample.avg_weight_g) / 1000;
    basis = `Based on ${birdsAlive.toLocaleString('en-US')} birds at ` +
            `${fmt(weightKg, 2)} kg, weighed on day ${sample.day_number}.`;
    measured = true;
  } else {
    const t = elapsed / cycle.target_sale_age;
    weightKg = (0.09 + (modelledLb - 0.09) * Math.pow(t, 1.55)) * LB_PER_KG;
    basis = `No sample weights recorded, so this uses the modelled growth curve — ` +
            `an estimate, not a measurement.`;
    measured = false;
  }

  const liveMassKg = birdsAlive * weightKg;
  const fcr = liveMassKg > 0 ? actualKg / liveMassKg : 0;

  valueEl.textContent = fmt(fcr, 2);
  basisEl.textContent = basis;

  // Position on a 1.4 – 2.2 scale
  const pos = Math.min(Math.max((fcr - 1.4) / (2.2 - 1.4), 0), 1);
  marker.style.display = '';
  marker.style.left = `${(pos * 100).toFixed(1)}%`;

  let verdict;
  if (fcr <= FCR_TARGET_HIGH) {
    verdict = 'That is at or inside the breed objective. The 1.90 the planner predicts ' +
              'looks like an artefact of intake assumptions set too high, not a real problem with the birds.';
  } else if (fcr <= 1.8) {
    verdict = 'Above the breed objective but not alarming this early. Worth watching — the ratio ' +
              'usually worsens through the finisher phase, not before it.';
  } else {
    verdict = 'Meaningfully above the breed objective. At 64% of cycle cost, roughly every 0.1 here ' +
              'is $660. Check for feed wastage, spillage and water before assuming it is the birds.';
  }

  if (!measured) {
    verdict += ' Weigh a sample of birds and this becomes a real measurement rather than an estimate.';
  }
  noteEl.textContent = verdict;
}

boot();
