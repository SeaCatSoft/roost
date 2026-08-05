/* =============================================================================
   Roost — assumptions

   The planner, made editable. Every field here belongs to one cycle, so
   changing it never rewrites a finished batch, and the next cycle starts from
   wherever you leave it.

   The outcome strip recalculates as you type using the same formulas as the
   database views. That preview is a convenience; after saving, the figures are
   re-read from the server and compared, because the database is the authority
   and a silent disagreement between the two would be worth knowing about.
   ========================================================================== */

import { db, isConfigured, $, banner, loadOpenCycle, myRole, canEdit, lockForViewer } from './db.js';

const screens = { setup: $('setupScreen'), auth: $('authScreen'), app: $('appScreen') };
const show = (n) => Object.entries(screens).forEach(([k, el]) => { el.hidden = k !== n; });
const showError = (m) => banner($('appError'), $('appErrorText'), m);

if (!isConfigured) { show('setup'); throw new Error('Supabase is not configured'); }

const LB_PER_KG = 0.45359237;

/* Percentages are stored 0–1 but nobody thinks in 0.05, so they are shown as
   percentages and scaled on the way in and out. */
const GROUPS = [
  {
    title: 'The flock',
    hint: 'Everything downstream keys off these four.',
    fields: [
      { key: 'birds_placed',     src: 'cycle', label: 'Birds placed',        unit: '',      step: 1,    min: 1 },
      { key: 'target_sale_age',  src: 'cycle', label: 'Sale age',            unit: 'days',  step: 1,    min: 21 },
      { key: 'mortality_rate',   scale: 100,   label: 'Mortality',           unit: '%',     step: 0.1,  min: 0, max: 100 },
      { key: 'live_weight_lb',                 label: 'Live weight at sale', unit: 'lb',    step: 0.05, min: 0.1 }
    ]
  },
  {
    title: 'Processing',
    hint: 'Live weight becomes saleable weight through these three.',
    fields: [
      { key: 'dressing_yield',   scale: 100, label: 'Dressing yield',   unit: '%', step: 0.5, min: 1, max: 100 },
      { key: 'shrink_loss',      scale: 100, label: 'Shrink and condemnation', unit: '%', step: 0.1, min: 0, max: 100 },
      { key: 'whole_bird_share', scale: 100, label: 'Sold whole',       unit: '%', step: 1,   min: 0, max: 100 },
      { key: 'cutup_trim_loss',  scale: 100, label: 'Cut-up trim loss', unit: '%', step: 0.1, min: 0, max: 100 }
    ]
  },
  {
    title: 'Feed',
    hint: 'Feed is around two thirds of a cycle. These move the result most.',
    fields: [
      { key: 'bag_size_kg',       label: 'Bag size',          unit: 'kg', step: 1,    min: 1 },
      { key: 'starter_bag_cost',  label: 'Starter, per bag',  unit: '$',  step: 0.25, min: 0 },
      { key: 'grower_bag_cost',   label: 'Grower, per bag',   unit: '$',  step: 0.25, min: 0 },
      { key: 'finisher_bag_cost', label: 'Finisher, per bag', unit: '$',  step: 0.25, min: 0 }
    ]
  },
  {
    title: 'Costs per bird',
    fields: [
      { key: 'chick_cost',         label: 'Day-old chick',        unit: '$', step: 0.05, min: 0 },
      { key: 'processing_fee',     label: 'Processing',           unit: '$', step: 0.05, min: 0 },
      { key: 'whole_packaging',    label: 'Whole-bird packaging', unit: '$', step: 0.05, min: 0 },
      { key: 'cutup_labour',       label: 'Cut-up labour',        unit: '$', step: 0.05, min: 0 },
      { key: 'chilling_fee',       label: 'Ice and chilling',     unit: '$', step: 0.05, min: 0 },
      { key: 'transport_fee',      label: 'Transport',            unit: '$', step: 0.05, min: 0 },
      { key: 'cutup_packaging_lb', label: 'Cut-up packaging',     unit: '$/lb', step: 0.05, min: 0 }
    ]
  },
  {
    title: 'Costs per cycle',
    hint: 'Flat costs, however many birds you place.',
    fields: [
      { key: 'bedding_cost',    label: 'Bedding and litter', unit: '$', step: 5, min: 0 },
      { key: 'utilities_cost',  label: 'Electricity',        unit: '$', step: 5, min: 0 },
      { key: 'labour_cost',     label: 'Labour',             unit: '$', step: 5, min: 0 },
      { key: 'medication_cost', label: 'Medication',         unit: '$', step: 5, min: 0 },
      { key: 'misc_cost',       label: 'Everything else',    unit: '$', step: 5, min: 0 }
    ]
  }
];

const state = {
  cycle: null, assumptions: null, curve: [], mix: [], lines: [],
  dirty: false, saved: null
};

const n2 = (v, d = 2) =>
  Number(v ?? 0).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });

const money = (v) => (v < 0 ? '−$' : '$') + n2(Math.abs(v), 0);

/* ---------- Load ---------------------------------------------------------- */
async function boot() {
  const { data: { session } } = await db.auth.getSession();
  if (!session) { show('auth'); return; }
  show('app');
  showError(null);

  try { state.cycle = await loadOpenCycle(); }
  catch (e) { showError(e.message); return; }

  $('cycleLabel').textContent = state.cycle.label;

  const [aRes, cRes, mRes, lRes] = await Promise.all([
    db.from('cycle_assumptions').select('*').eq('cycle_id', state.cycle.id).maybeSingle(),
    db.from('feed_intake_curve').select('*').eq('cycle_id', state.cycle.id).order('week'),
    db.from('cycle_product_mix').select('*').eq('cycle_id', state.cycle.id),
    db.from('product_lines').select('*').order('sort_order')
  ]);

  if (aRes.error || !aRes.data) {
    showError('This cycle has no assumptions row, so there is nothing to edit.');
    return;
  }

  state.assumptions = { ...aRes.data };
  state.curve = (cRes.data || []).map((r) => ({ ...r }));
  state.lines = lRes.data || [];
  state.mix = (mRes.data || []).map((r) => ({ ...r }));

  renderForm();
  recalc();

  if (!canEdit(await myRole())) {
    lockForViewer(document.querySelector('.app-shell'),
      'You have view-only access. These figures drive the model, but only an owner or member can change them.');
  }
}

/* ---------- Form ---------------------------------------------------------- */
function renderForm() {
  const host = $('formHost');
  host.textContent = '';

  GROUPS.forEach((group) => host.appendChild(renderGroup(group)));
  host.appendChild(renderCurve());
  host.appendChild(renderPrices());
}

function renderGroup(group) {
  const panel = document.createElement('section');
  panel.className = 'panel';

  const head = document.createElement('div');
  head.innerHTML =
    `<h2 class="panel__title">${group.title}</h2>` +
    (group.hint ? `<p class="caption" style="margin-top:.25rem">${group.hint}</p>` : '');
  panel.appendChild(head);

  const grid = document.createElement('div');
  grid.className = 'setting-grid';

  group.fields.forEach((f) => {
    const source = f.src === 'cycle' ? state.cycle : state.assumptions;
    const raw = Number(source[f.key]);
    const shown = f.scale ? raw * f.scale : raw;

    const row = document.createElement('label');
    row.className = 'setting';
    row.innerHTML =
      `<span class="setting__label">${f.label}</span>
       <span class="setting__input">
         <input type="number" inputmode="decimal" step="${f.step}"
                ${f.min != null ? `min="${f.min}"` : ''} ${f.max != null ? `max="${f.max}"` : ''}
                value="${round(shown)}">
         <span class="setting__unit">${f.unit}</span>
       </span>`;

    const input = row.querySelector('input');
    input.addEventListener('input', () => {
      const v = input.value === '' ? null : Number(input.value);
      if (v === null || !Number.isFinite(v)) return;
      const stored = f.scale ? v / f.scale : v;
      if (f.src === 'cycle') state.cycle[f.key] = stored;
      else state.assumptions[f.key] = stored;
      markDirty();
      recalc();
    });

    grid.appendChild(row);
  });

  panel.appendChild(grid);
  return panel;
}

function renderCurve() {
  const panel = document.createElement('section');
  panel.className = 'panel';
  panel.innerHTML =
    `<h2 class="panel__title">Weekly feed intake</h2>
     <p class="caption" style="margin-top:.25rem">
       Grams per bird per day. This is the single biggest driver of the conversion
       ratio — if the planner predicts worse than your birds achieve, it is usually
       these numbers rather than the flock.
     </p>`;

  const grid = document.createElement('div');
  grid.className = 'setting-grid';

  state.curve.forEach((wk) => {
    const row = document.createElement('label');
    row.className = 'setting';
    row.innerHTML =
      `<span class="setting__label">Week ${wk.week} <em class="setting__sub">${wk.phase}</em></span>
       <span class="setting__input">
         <input type="number" inputmode="decimal" step="5" min="0" value="${round(wk.g_per_bird_per_day)}">
         <span class="setting__unit">g/day</span>
       </span>`;
    const input = row.querySelector('input');
    input.addEventListener('input', () => {
      const v = Number(input.value);
      if (!Number.isFinite(v)) return;
      wk.g_per_bird_per_day = v;
      markDirty();
      recalc();
    });
    grid.appendChild(row);
  });

  panel.appendChild(grid);
  return panel;
}

function renderPrices() {
  const panel = document.createElement('section');
  panel.className = 'panel';
  panel.innerHTML =
    `<h2 class="panel__title">Sales mix and prices</h2>
     <p class="caption" style="margin-top:.25rem">
       Share of cut-up weight, and what each line sells for. Whole birds have no
       share — they are priced on their own weight.
     </p>
     <div class="mixtotal" id="mixTotal"></div>`;

  const wrap = document.createElement('div');
  wrap.className = 'price-list';

  state.lines.forEach((line) => {
    let row = state.mix.find((m) => m.product_line_id === line.id);
    if (!row) {
      row = { cycle_id: state.cycle.id, product_line_id: line.id,
              mix_share: line.is_whole_bird ? null : 0, price_per_lb: 0 };
      state.mix.push(row);
    }

    const el = document.createElement('div');
    el.className = 'price-row';
    el.innerHTML =
      `<span class="price-row__name">${line.name}</span>
       <span class="setting__input price-row__mix">
         ${line.is_whole_bird
           ? '<span class="price-row__na">whole</span>'
           : `<input type="number" inputmode="decimal" step="0.5" min="0" max="100"
                     value="${round((row.mix_share ?? 0) * 100)}" aria-label="${line.name} share of cut-up weight">
              <span class="setting__unit">%</span>`}
       </span>
       <span class="setting__input price-row__price">
         <span class="setting__unit">$</span>
         <input type="number" inputmode="decimal" step="0.05" min="0"
                value="${round(row.price_per_lb)}" aria-label="${line.name} price per pound">
         <span class="setting__unit">/lb</span>
       </span>`;

    const inputs = el.querySelectorAll('input');
    if (!line.is_whole_bird) {
      inputs[0].addEventListener('input', () => {
        const v = Number(inputs[0].value);
        if (!Number.isFinite(v)) return;
        row.mix_share = v / 100;
        markDirty(); recalc();
      });
    }
    const priceInput = inputs[inputs.length - 1];
    priceInput.addEventListener('input', () => {
      const v = Number(priceInput.value);
      if (!Number.isFinite(v)) return;
      row.price_per_lb = v;
      markDirty(); recalc();
    });

    wrap.appendChild(el);
  });

  panel.appendChild(wrap);
  return panel;
}

function round(v) {
  return Math.round(Number(v ?? 0) * 1000) / 1000;
}

/* ---------- The model ----------------------------------------------------
   Deliberately mirrors 002_views.sql. If these ever drift, the check after
   saving will surface it rather than letting the screen quietly lie.
   ------------------------------------------------------------------------ */
function model() {
  const a = state.assumptions;
  const placed = Number(state.cycle.birds_placed) || 0;
  const mort = Number(a.mortality_rate) || 0;

  const birdsSold = Math.round(placed * (1 - mort));
  const netLb = Number(a.live_weight_lb) * Number(a.dressing_yield) * (1 - Number(a.shrink_loss));
  const totalNetLb = birdsSold * netLb;

  const wholeBirds = Math.round(placed * (1 - mort) * Number(a.whole_bird_share));
  const cutupBirds = birdsSold - wholeBirds;
  const wholeLb = wholeBirds * netLb;
  const cutupLb = cutupBirds * netLb * (1 - Number(a.cutup_trim_loss));

  // Feed, week by week, mortality spread evenly across the weeks.
  const weeks = state.curve.length || 1;
  const bagSize = Number(a.bag_size_kg) || 30;
  const phaseKg = { Starter: 0, Grower: 0, Finisher: 0 };
  let totalFeedKg = 0;

  state.curve.forEach((wk) => {
    const avgBirds = placed - (placed * mort / weeks) * (wk.week - 0.5);
    const kg = (Number(wk.g_per_bird_per_day) * 7 * avgBirds) / 1000;
    phaseKg[wk.phase] = (phaseKg[wk.phase] || 0) + kg;
    totalFeedKg += kg;
  });

  const bagCost = {
    Starter: Number(a.starter_bag_cost),
    Grower: Number(a.grower_bag_cost),
    Finisher: Number(a.finisher_bag_cost)
  };

  let bags = 0, feedCost = 0;
  Object.keys(phaseKg).forEach((p) => {
    const b = Math.ceil(phaseKg[p] / bagSize);
    bags += b;
    feedCost += b * (bagCost[p] || 0);
  });

  // Revenue
  let revenue = 0;
  state.lines.forEach((line) => {
    const row = state.mix.find((m) => m.product_line_id === line.id);
    if (!row) return;
    revenue += line.is_whole_bird
      ? wholeLb * Number(row.price_per_lb)
      : cutupLb * Number(row.mix_share || 0) * Number(row.price_per_lb);
  });

  const cost =
    placed * Number(a.chick_cost) +
    feedCost +
    birdsSold * Number(a.processing_fee) +
    wholeBirds * Number(a.whole_packaging) +
    cutupBirds * Number(a.cutup_labour) +
    cutupLb * Number(a.cutup_packaging_lb) +
    birdsSold * Number(a.chilling_fee) +
    birdsSold * Number(a.transport_fee) +
    Number(a.bedding_cost) + Number(a.utilities_cost) + Number(a.labour_cost) +
    Number(a.medication_cost) + Number(a.misc_cost);

  const liveKg = birdsSold * Number(a.live_weight_lb) * LB_PER_KG;

  return {
    birdsSold, totalNetLb, totalFeedKg, bags, revenue, cost,
    profit: revenue - cost,
    breakeven: totalNetLb > 0 ? cost / totalNetLb : 0,
    blended: totalNetLb > 0 ? revenue / totalNetLb : 0,
    fcr: liveKg > 0 ? totalFeedKg / liveKg : 0
  };
}

function recalc() {
  const m = model();

  $('oBreakeven').textContent = `$${n2(m.breakeven, 2)}`;
  $('oBlended').textContent = `$${n2(m.blended, 2)}`;

  const profitEl = $('oProfit');
  profitEl.textContent = money(m.profit);
  profitEl.style.color = m.profit < 0 ? 'var(--warn)' : 'var(--accent)';

  const gap = m.blended - m.breakeven;
  $('oNote').textContent =
    `${m.birdsSold.toLocaleString('en-US')} birds sold · ${n2(m.totalFeedKg, 0)} kg feed · ` +
    `${m.bags} bags · FCR ${n2(m.fcr, 2)} · ` +
    (gap >= 0
      ? `${n2(gap, 2)} a pound clear`
      : `${n2(Math.abs(gap), 2)} a pound short`);

  // The mix has to add to 100% or every part is mispriced. The database
  // rejects over 100; under 100 is legal but almost always a mistake.
  const total = state.mix
    .filter((m2) => m2.mix_share != null)
    .reduce((acc, m2) => acc + Number(m2.mix_share || 0), 0) * 100;

  const el = $('mixTotal');
  if (el) {
    const off = Math.abs(total - 100) > 0.05;
    el.className = 'mixtotal' + (off ? ' mixtotal--off' : '');
    el.textContent = off
      ? `Cut-up shares total ${n2(total, 1)}% — they should come to 100%.`
      : `Cut-up shares total 100%.`;
  }
}

/* ---------- Dirty state --------------------------------------------------- */
function markDirty() {
  state.dirty = true;
  const btn = $('saveBtn');
  btn.disabled = false;
  btn.textContent = 'Save assumptions';
  $('savedNote').textContent = '';
}

/* ---------- Save ---------------------------------------------------------- */
$('saveBtn').addEventListener('click', async () => {
  const btn = $('saveBtn');
  showError(null);

  const total = state.mix
    .filter((m) => m.mix_share != null)
    .reduce((acc, m) => acc + Number(m.mix_share || 0), 0);

  if (total > 1.0001) {
    showError(`Cut-up shares total ${n2(total * 100, 1)}%. Bring them to 100% before saving.`);
    return;
  }

  btn.disabled = true;
  btn.textContent = 'Saving…';

  const a = state.assumptions;
  const { cycle_id, ...assumptionFields } = a;

  const results = await Promise.all([
    db.from('cycle_assumptions').update(assumptionFields).eq('cycle_id', state.cycle.id),
    db.from('cycles').update({
      birds_placed: Math.round(Number(state.cycle.birds_placed)),
      target_sale_age: Math.round(Number(state.cycle.target_sale_age))
    }).eq('id', state.cycle.id),
    db.from('feed_intake_curve').upsert(
      state.curve.map((w) => ({
        cycle_id: state.cycle.id, week: w.week, phase: w.phase,
        g_per_bird_per_day: w.g_per_bird_per_day
      })), { onConflict: 'cycle_id,week' }
    ),
    db.from('cycle_product_mix').upsert(
      state.mix.map((m) => ({
        cycle_id: state.cycle.id, product_line_id: m.product_line_id,
        mix_share: m.mix_share, price_per_lb: m.price_per_lb
      })), { onConflict: 'cycle_id,product_line_id' }
    )
  ]);

  const failed = results.find((r) => r.error);
  if (failed) {
    btn.disabled = false;
    btn.textContent = 'Save assumptions';
    showError(failed.error.message);
    return;
  }

  state.dirty = false;
  btn.textContent = 'Saved';

  // The database is the authority. Read back what it now says and compare with
  // the preview, so a formula that has drifted shows up here rather than in a
  // decision made off a wrong number.
  const { data: pnl } = await db
    .from('v_cycle_pnl')
    .select('breakeven_price_lb, blended_price_lb, operating_profit')
    .eq('cycle_id', state.cycle.id)
    .maybeSingle();

  if (pnl) {
    const m = model();
    const drift = Math.abs(Number(pnl.breakeven_price_lb) - m.breakeven);
    $('savedNote').textContent = drift > 0.005
      ? `Saved. Note: the server calculates breakeven at $${n2(pnl.breakeven_price_lb, 2)}, ` +
        `which differs from the preview — trust the server figure.`
      : `Saved. Server agrees: breakeven $${n2(pnl.breakeven_price_lb, 2)}, ` +
        `result ${money(Number(pnl.operating_profit))}.`;
  }

  setTimeout(() => {
    if (!state.dirty) { btn.textContent = 'No changes yet'; btn.disabled = true; }
  }, 1600);
});

/* Leaving with unsaved edits loses them, so say so. */
window.addEventListener('beforeunload', (e) => {
  if (!state.dirty) return;
  e.preventDefault();
  e.returnValue = '';
});

boot();
