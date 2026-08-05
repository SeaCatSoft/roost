/* =============================================================================
   Roost — sample weights

   Built around how weighing actually happens: you catch a handful of birds and
   weigh them one at a time. Entering the individual weights rather than a
   pre-computed average costs nothing extra and buys flock uniformity, which a
   single average can never show.
   ========================================================================== */

import {
  db, isConfigured, $, today, daysBetween, banner, loadOpenCycle,
  myRole, canEdit, lockForViewer
} from './db.js';

const screens = { setup: $('setupScreen'), auth: $('authScreen'), app: $('appScreen') };
const show = (n) => Object.entries(screens).forEach(([k, el]) => { el.hidden = k !== n; });
const showError = (m) => banner($('appError'), $('appErrorText'), m);

if (!isConfigured) { show('setup'); throw new Error('Supabase is not configured'); }

/* Ross 308 as-hatched performance objective, grams by day. Indicative figures
   for the common targets — use your own breed's published table if it differs. */
const STANDARD = {
  0: 42, 7: 185, 14: 465, 21: 940, 28: 1560, 35: 2270, 42: 2980
};

const TO_GRAMS = { g: 1, kg: 1000, lb: 453.59237 };

const state = { cycle: null, unit: 'g', weights: [], samples: [], currentDay: 1 };

const fmt = (n, d = 0) =>
  Number(n).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });

/* Linear interpolation between the published points. */
function standardAt(day) {
  const keys = Object.keys(STANDARD).map(Number).sort((a, b) => a - b);
  if (day <= keys[0]) return STANDARD[keys[0]];
  if (day >= keys[keys.length - 1]) return STANDARD[keys[keys.length - 1]];
  for (let i = 0; i < keys.length - 1; i++) {
    const a = keys[i], b = keys[i + 1];
    if (day >= a && day <= b) {
      const t = (day - a) / (b - a);
      return STANDARD[a] + (STANDARD[b] - STANDARD[a]) * t;
    }
  }
  return null;
}

/* ---------- Load --------------------------------------------------------- */
async function boot() {
  const { data: { session } } = await db.auth.getSession();
  if (!session) { show('auth'); return; }
  show('app');
  showError(null);

  try { state.cycle = await loadOpenCycle(); }
  catch (e) { showError(e.message); return; }

  $('cycleLabel').textContent = state.cycle.label;

  state.currentDay = Math.max(1, Math.min(
    daysBetween(state.cycle.placed_on, today()) + 1, state.cycle.target_sale_age
  ));
  $('dayInput').value = state.currentDay;
  $('dayInput').max = state.cycle.target_sale_age;

  await loadSamples();

  if (!canEdit(await myRole())) {
    lockForViewer(document.querySelector('.panel:nth-of-type(2)'),
      'You have view-only access. Weighings are shown, but cannot be recorded.');
  }
}

async function loadSamples() {
  const { data, error } = await db
    .from('sample_weights')
    .select('id, day_number, birds_sampled, avg_weight_g')
    .eq('cycle_id', state.cycle.id)
    .order('day_number');

  if (error) { showError(`Could not load weighings: ${error.message}`); return; }

  state.samples = data || [];
  renderHeadline();
  renderChart();
  renderHistory();
}

/* ---------- Headline ------------------------------------------------------ */
function renderHeadline() {
  const latest = state.samples[state.samples.length - 1];

  if (!latest) {
    $('latestWeight').textContent = '—';
    $('vsStandard').textContent = '—';
    $('uniformity').textContent = '—';
    return;
  }

  const g = Number(latest.avg_weight_g);
  $('latestWeight').textContent = g >= 1000 ? `${fmt(g / 1000, 2)} kg` : `${fmt(g)} g`;

  const std = standardAt(latest.day_number);
  if (std) {
    const pct = ((g / std) - 1) * 100;
    $('vsStandard').textContent = `${pct >= 0 ? '+' : '−'}${fmt(Math.abs(pct), 1)}%`;
    $('vsStandard').style.color = pct < -8 ? 'var(--warn)' : '';
  }

  // Uniformity only exists for weighings entered bird by bird.
  $('uniformity').textContent = '—';
}

/* ---------- Chart --------------------------------------------------------- */
function renderChart() {
  const lastDay = state.cycle.target_sale_age;
  const W = 340, H = 190, L = 42, R = 8, T = 10, B = 26;

  const maxG = Math.max(
    standardAt(lastDay),
    ...state.samples.map((s) => Number(s.avg_weight_g)),
    1
  ) * 1.08;

  const x = (d) => L + ((d / lastDay) * (W - L - R));
  const y = (g) => H - B - ((g / maxG) * (H - T - B));

  const stdPts = [];
  for (let d = 0; d <= lastDay; d++) stdPts.push(`${x(d).toFixed(1)},${y(standardAt(d)).toFixed(1)}`);
  $('stdLine').setAttribute('d', 'M' + stdPts.join('L'));

  const actPts = state.samples.map((s) =>
    `${x(s.day_number).toFixed(1)},${y(Number(s.avg_weight_g)).toFixed(1)}`);
  $('actLine').setAttribute('d', actPts.length > 1 ? 'M' + actPts.join('L') : '');

  const dots = $('actDots');
  dots.textContent = '';
  const NS = 'http://www.w3.org/2000/svg';
  state.samples.forEach((s) => {
    const c = document.createElementNS(NS, 'circle');
    c.setAttribute('cx', x(s.day_number));
    c.setAttribute('cy', y(Number(s.avg_weight_g)));
    c.setAttribute('r', '4');
    c.setAttribute('fill', 'var(--accent)');
    c.setAttribute('stroke', 'var(--page-2)');
    c.setAttribute('stroke-width', '2');
    dots.appendChild(c);
  });

  const grid = $('gGrid'), labels = $('gLabels');
  grid.textContent = ''; labels.textContent = '';

  for (let i = 0; i <= 3; i++) {
    const g = (maxG / 3) * i;
    const gy = y(g);
    const ln = document.createElementNS(NS, 'line');
    ln.setAttribute('x1', L); ln.setAttribute('x2', W - R);
    ln.setAttribute('y1', gy); ln.setAttribute('y2', gy);
    ln.setAttribute('stroke', 'var(--hairline-2)');
    grid.appendChild(ln);

    const t = document.createElementNS(NS, 'text');
    t.setAttribute('x', L - 6); t.setAttribute('y', gy + 3);
    t.setAttribute('text-anchor', 'end'); t.setAttribute('font-size', '9');
    t.setAttribute('fill', 'var(--ink-3)');
    t.textContent = g >= 1000 ? `${(g / 1000).toFixed(1)}kg` : Math.round(g);
    labels.appendChild(t);
  }

  [1, Math.round(lastDay / 2), lastDay].forEach((d) => {
    const t = document.createElementNS(NS, 'text');
    t.setAttribute('x', x(d)); t.setAttribute('y', H - 8);
    t.setAttribute('text-anchor', d === 1 ? 'start' : d === lastDay ? 'end' : 'middle');
    t.setAttribute('font-size', '9'); t.setAttribute('fill', 'var(--ink-3)');
    t.textContent = `Day ${d}`;
    labels.appendChild(t);
  });

  $('growthNote').textContent = state.samples.length
    ? 'Dashed line is the Ross 308 as-hatched objective. Substitute your own breed table if it differs.'
    : 'No weighings yet. Record one below and it will appear against the standard.';
}

/* ---------- History ------------------------------------------------------- */
function renderHistory() {
  const wrap = $('history');
  wrap.textContent = '';

  if (!state.samples.length) {
    wrap.innerHTML = '<p class="caption">Nothing recorded yet.</p>';
    return;
  }

  [...state.samples].reverse().forEach((s) => {
    const g = Number(s.avg_weight_g);
    const std = standardAt(s.day_number);
    const pct = std ? ((g / std) - 1) * 100 : null;

    const row = document.createElement('div');
    row.className = 'weigh-row';
    row.innerHTML =
      `<div>
         <div class="weigh-row__day">Day ${s.day_number}</div>
         <div class="weigh-row__meta">${s.birds_sampled} bird${s.birds_sampled === 1 ? '' : 's'}</div>
       </div>
       <div class="weigh-row__val tnum">${g >= 1000 ? fmt(g / 1000, 2) + ' kg' : fmt(g) + ' g'}</div>
       <div class="weigh-row__delta tnum${pct !== null && pct < -8 ? ' is-behind' : ''}">${
         pct === null ? '' : (pct >= 0 ? '+' : '−') + fmt(Math.abs(pct), 1) + '%'
       }</div>`;
    wrap.appendChild(row);
  });
}

/* ---------- Entry --------------------------------------------------------- */
document.querySelectorAll('[data-segment="unit"] button').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('[data-segment="unit"] button').forEach((b) =>
      b.setAttribute('aria-pressed', String(b === btn)));
    state.unit = btn.getAttribute('data-value');
    recalc();
  });
});

$('weightsInput').addEventListener('input', recalc);
$('dayInput').addEventListener('input', recalc);

function parseWeights(text) {
  return text
    .split(/[\s,;]+/)
    .map((t) => t.trim())
    .filter(Boolean)
    .map(Number)
    .filter((n) => Number.isFinite(n) && n > 0);
}

function recalc() {
  if (!state.cycle) return;   // form is hidden before sign-in, but never assume it

  const raw = parseWeights($('weightsInput').value);
  const factor = TO_GRAMS[state.unit];
  state.weights = raw.map((n) => n * factor);

  const tally = $('tally');
  const warn = $('tallyWarn');
  const btn = $('saveBtn');

  if (!state.weights.length) {
    tally.hidden = true;
    warn.hidden = true;
    btn.disabled = true;
    return;
  }

  tally.hidden = false;
  const n = state.weights.length;
  const mean = state.weights.reduce((a, b) => a + b, 0) / n;

  // Sample standard deviation, then CV — the standard flock uniformity measure.
  const variance = n > 1
    ? state.weights.reduce((acc, w) => acc + Math.pow(w - mean, 2), 0) / (n - 1)
    : 0;
  const cv = mean > 0 ? (Math.sqrt(variance) / mean) * 100 : 0;

  $('tallyCount').textContent = n;
  $('tallyAvg').textContent = mean >= 1000 ? `${fmt(mean / 1000, 2)} kg` : `${fmt(mean)} g`;
  $('tallyCv').textContent = n > 1 ? `${fmt(cv, 1)}%` : '—';

  const messages = [];

  // A weight far off the standard is usually a units mistake, not a miracle bird.
  const day = parseInt($('dayInput').value, 10);
  const std = standardAt(day);
  if (std && (mean > std * 2.5 || mean < std * 0.4)) {
    messages.push(
      `An average of ${fmt(mean)} g on day ${day} is a long way from the ~${fmt(std)} g ` +
      `standard. Check the scale units above are right.`
    );
  }
  if (n > 1 && cv > 12) {
    messages.push(
      `A spread of ${fmt(cv, 1)}% is wide — over about 12% usually means uneven feed or ` +
      `water access rather than a bad sample.`
    );
  }
  if (n < 10) {
    messages.push(`${n} bird${n === 1 ? '' : 's'} is a small sample; ten or more is far steadier.`);
  }

  warn.hidden = messages.length === 0;
  warn.textContent = messages.join(' ');

  btn.disabled = !(day >= 1 && day <= state.cycle.target_sale_age);
}

/* ---------- Save ---------------------------------------------------------- */
$('saveBtn').addEventListener('click', async () => {
  const btn = $('saveBtn');
  const day = parseInt($('dayInput').value, 10);
  if (!state.weights.length || !day) return;

  btn.disabled = true;
  btn.textContent = 'Saving…';
  showError(null);

  const mean = state.weights.reduce((a, b) => a + b, 0) / state.weights.length;
  const { data: { session } } = await db.auth.getSession();

  // One weighing per cycle-day, so re-weighing the same day corrects it.
  const { error } = await db.from('sample_weights').upsert({
    cycle_id: state.cycle.id,
    day_number: day,
    birds_sampled: state.weights.length,
    avg_weight_g: Math.round(mean * 10) / 10,
    recorded_by: session?.user?.id ?? null
  }, { onConflict: 'cycle_id,day_number' });

  if (error) {
    btn.disabled = false;
    btn.textContent = 'Save weighing';
    showError(error.message);
    return;
  }

  $('weightsInput').value = '';
  state.weights = [];
  $('tally').hidden = true;
  $('tallyWarn').hidden = true;

  await loadSamples();

  btn.textContent = 'Saved';
  setTimeout(() => { btn.textContent = 'Save weighing'; btn.disabled = true; }, 1500);
});

boot();
