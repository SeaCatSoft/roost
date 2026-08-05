/* =============================================================================
   Roost — processing

   Where modelled figures give way to measured ones. A run records what went
   into the plant and what came out of it; revenue follows from the weights and
   the price list rather than from an assumed yield.

   Plan and actual are shown side by side. The plan is what you costed against;
   the actual is what happened. The gap is the only thing that improves the
   next cycle, so neither replaces the other.
   ========================================================================== */

import {
  db, isConfigured, $, today, banner, loadOpenCycle, myRole, canEdit, lockForViewer
} from './db.js';

const screens = { setup: $('setupScreen'), auth: $('authScreen'), app: $('appScreen') };
const show = (n) => Object.entries(screens).forEach(([k, el]) => { el.hidden = k !== n; });
const showError = (m) => banner($('appError'), $('appErrorText'), m);

if (!isConfigured) { show('setup'); throw new Error('Supabase is not configured'); }

const state = {
  cycle: null, lines: [], mix: [], runs: [],
  editing: null, outputs: new Map(), pending: null, readOnly: false
};

const num = (n, d = 0) =>
  Number(n ?? 0).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });

const money = (v) => (Number(v) < 0 ? '−$' : '$') + num(Math.abs(Number(v ?? 0)), 0);
const pct = (v) => v == null ? '—' : `${num(Number(v) * 100, 1)}%`;
const shortDate = (iso) =>
  new Date(iso + 'T00:00:00').toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });

/* ---------- Load ---------------------------------------------------------- */
async function boot() {
  const { data: { session } } = await db.auth.getSession();
  if (!session) { show('auth'); return; }
  show('app');
  showError(null);

  try { state.cycle = await loadOpenCycle(); }
  catch (e) { showError(e.message); return; }

  $('cycleLabel').textContent = state.cycle.label;

  const [lines, mix, runs, actual] = await Promise.all([
    db.from('product_lines').select('*').order('sort_order'),
    db.from('cycle_product_mix').select('*').eq('cycle_id', state.cycle.id),
    db.from('v_processing_runs').select('*').eq('cycle_id', state.cycle.id).order('processed_on'),
    db.from('v_cycle_actual').select('*').eq('cycle_id', state.cycle.id).maybeSingle()
  ]);

  if (runs.error) {
    showError(runs.error.message.includes('does not exist')
      ? 'This screen needs migration 011. Run backend/migrations/011_processing.sql in Supabase.'
      : `Could not load runs: ${runs.error.message}`);
    return;
  }

  state.lines = lines.data || [];
  state.mix = mix.data || [];
  state.runs = runs.data || [];

  renderRuns();
  renderCompare(actual.data);

  state.readOnly = !canEdit(await myRole());
  if (state.readOnly) {
    $('addRunBtn').disabled = true;
    lockForViewer($('formPanel'), 'You have view-only access. Runs are shown, but cannot be recorded.');
  }
}

const priceFor = (lineId) =>
  Number(state.mix.find((m) => m.product_line_id === lineId)?.price_per_lb ?? 0);

/* ---------- Actual against plan ------------------------------------------- */
function renderCompare(a) {
  if (!a || !a.runs) { $('actualPanel').hidden = true; return; }
  $('actualPanel').hidden = false;

  const rows = [
    ['Birds', num(a.birds_processed), num(a.birds_planned),
      a.birds_planned ? (a.birds_processed - a.birds_planned) / a.birds_planned : null],
    ['Saleable weight', `${num(a.saleable_lb)} lb`, `${num(a.saleable_lb_planned)} lb`,
      a.saleable_lb_planned ? (a.saleable_lb - a.saleable_lb_planned) / a.saleable_lb_planned : null],
    ['Revenue', money(a.revenue_actual), money(a.revenue_planned),
      a.revenue_planned ? (a.revenue_actual - a.revenue_planned) / a.revenue_planned : null],
    ['Dressing yield', pct(a.dressing_yield_actual), '—', null],
    ['Blended price', a.blended_price_actual ? `$${num(a.blended_price_actual, 2)}` : '—',
      `$${num(a.breakeven_modelled, 2)} breakeven`, null]
  ];

  const wrap = $('compareRows');
  wrap.textContent = '';

  rows.forEach(([label, actualVal, planVal, delta]) => {
    const row = document.createElement('div');
    row.className = 'cmp2';
    const sign = delta == null ? '' :
      `<span class="cmp2__delta${delta < 0 ? ' is-down' : ''}">${delta >= 0 ? '+' : '−'}${num(Math.abs(delta) * 100, 1)}%</span>`;
    row.innerHTML =
      `<span class="cmp2__label">${label}</span>
       <span class="cmp2__actual tnum">${actualVal}</span>
       <span class="cmp2__plan tnum">${planVal}</span>
       ${sign}`;
    wrap.appendChild(row);
  });

  const profit = a.profit_actual;
  $('actualNote').innerHTML =
    profit == null ? '' :
    `Against the modelled cost of ${money(a.cost_modelled)}, this cycle made ` +
    `<strong>${money(profit)}</strong>. Revenue is measured; cost is still modelled ` +
    `from assumptions until purchase records are entered.`;
}

/* ---------- Runs ---------------------------------------------------------- */
function renderRuns() {
  const wrap = $('runList');
  wrap.textContent = '';

  if (!state.runs.length) {
    wrap.innerHTML = '<p class="caption">No runs yet. Record one when the birds go to the processor.</p>';
    return;
  }

  state.runs.forEach((r) => {
    const card = document.createElement('article');
    card.className = 'batch';
    card.innerHTML =
      `<div class="batch__head">
         <div>
           <div class="batch__name">${shortDate(r.processed_on)}</div>
           <div class="batch__meta">${num(r.birds_processed)} birds${r.processor ? ' · ' + r.processor : ''}${r.lot_code ? ' · lot ' + r.lot_code : ''}</div>
         </div>
       </div>
       <div class="batch__grid">
         <div><span class="metric__k">Saleable</span><span class="batch__v tnum">${num(r.saleable_lb)} lb</span></div>
         <div><span class="metric__k">Yield</span><span class="batch__v tnum">${pct(r.dressing_yield)}</span></div>
         <div><span class="metric__k">Per bird</span><span class="batch__v tnum">${num(r.saleable_lb_per_bird, 2)} lb</span></div>
         <div><span class="metric__k">Revenue</span><span class="batch__v tnum">${money(r.revenue)}</span></div>
       </div>`;

    if (!state.readOnly) {
      const actions = document.createElement('div');
      actions.className = 'person__actions';
      actions.style.marginTop = '.9rem';

      const edit = document.createElement('button');
      edit.type = 'button'; edit.className = 'chip-btn'; edit.setAttribute('data-press', '');
      edit.textContent = 'Edit';
      edit.addEventListener('click', () => openForm(r));
      actions.appendChild(edit);

      const del = document.createElement('button');
      del.type = 'button'; del.className = 'chip-btn chip-btn--danger'; del.setAttribute('data-press', '');
      del.textContent = 'Delete';
      del.addEventListener('click', () => openDelete(r));
      actions.appendChild(del);

      card.appendChild(actions);
    }

    wrap.appendChild(card);
  });
}

/* ---------- The form ------------------------------------------------------ */
$('addRunBtn').addEventListener('click', () => openForm(null));
$('cancelBtn').addEventListener('click', closeForm);

async function openForm(run) {
  state.editing = run;
  state.outputs = new Map();

  $('formTitle').textContent = run ? 'Edit run' : 'Record a run';
  $('fDate').value = run ? run.processed_on : today();
  $('fBirds').value = run ? run.birds_processed : '';
  $('fCondemned').value = run ? run.birds_condemned : 0;
  $('fLive').value = run?.live_weight_lb ?? '';
  $('fDressed').value = run?.dressed_weight_lb ?? '';
  $('fProcessor').value = run?.processor ?? '';
  $('fLot').value = run?.lot_code ?? '';

  // Editing loads the lines already recorded so they can be corrected rather
  // than re-entered from scratch.
  if (run) {
    const { data } = await db.from('processing_outputs')
      .select('product_line_id, weight_lb, units').eq('run_id', run.id);
    (data || []).forEach((o) =>
      state.outputs.set(o.product_line_id, { weight: Number(o.weight_lb), units: o.units }));
  }

  renderOutputs();
  $('formPanel').hidden = false;
  $('formPanel').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function closeForm() {
  $('formPanel').hidden = true;
  state.editing = null;
}

function renderOutputs() {
  const wrap = $('outputRows');
  wrap.textContent = '';

  state.lines.forEach((line) => {
    const cur = state.outputs.get(line.id) || { weight: '', units: '' };
    const price = priceFor(line.id);

    const row = document.createElement('div');
    row.className = 'out-row';
    row.innerHTML =
      `<div class="out-row__name">
         <span>${line.name}</span>
         <span class="out-row__price">$${num(price, 2)}/lb</span>
       </div>
       <span class="setting__input out-row__wt">
         <input type="number" inputmode="decimal" min="0" step="1"
                value="${cur.weight}" aria-label="${line.name} weight in pounds">
         <span class="setting__unit">lb</span>
       </span>
       <span class="setting__input out-row__units">
         ${line.is_whole_bird
           ? `<input type="number" inputmode="numeric" min="0" step="1" value="${cur.units ?? ''}"
                     aria-label="${line.name} count"><span class="setting__unit">birds</span>`
           : '<span class="out-row__na">—</span>'}
       </span>`;

    const inputs = row.querySelectorAll('input');
    inputs[0].addEventListener('input', () => {
      const v = inputs[0].value === '' ? '' : Math.max(0, Number(inputs[0].value) || 0);
      const rec = state.outputs.get(line.id) || {};
      rec.weight = v;
      state.outputs.set(line.id, rec);
      updateTally();
    });
    if (line.is_whole_bird && inputs[1]) {
      inputs[1].addEventListener('input', () => {
        const rec = state.outputs.get(line.id) || {};
        rec.units = inputs[1].value === '' ? null : Math.max(0, parseInt(inputs[1].value, 10) || 0);
        state.outputs.set(line.id, rec);
      });
    }

    wrap.appendChild(row);
  });

  updateTally();
}

/* Live totals as the weights go in, so a mistyped figure shows up immediately
   rather than after saving. */
function updateTally() {
  let lb = 0, revenue = 0;
  state.outputs.forEach((rec, lineId) => {
    const w = Number(rec.weight) || 0;
    lb += w;
    revenue += w * priceFor(lineId);
  });

  const birds = Number($('fBirds').value) || 0;
  const live = Number($('fLive').value) || 0;
  const dressed = Number($('fDressed').value) || 0;

  const parts = [
    `<div><span class="metric__k">Saleable</span><span class="batch__v tnum">${num(lb)} lb</span></div>`,
    `<div><span class="metric__k">Revenue</span><span class="batch__v tnum">${money(revenue)}</span></div>`
  ];

  if (live > 0 && dressed > 0) {
    parts.push(`<div><span class="metric__k">Dressing yield</span><span class="batch__v tnum">${pct(dressed / live)}</span></div>`);
  }
  if (birds > 0 && lb > 0) {
    parts.push(`<div><span class="metric__k">Per bird</span><span class="batch__v tnum">${num(lb / birds, 2)} lb</span></div>`);
  }

  $('liveTally').innerHTML = parts.join('');

  // Saleable weight above dressed weight is physically impossible — usually a
  // units slip or a double-counted line.
  const warn = lb > 0 && dressed > 0 && lb > dressed * 1.001;
  showError(warn
    ? `The lines add to ${num(lb)} lb, more than the ${num(dressed)} lb dressed weight. Check for a double-counted line.`
    : null);
}

['fBirds', 'fLive', 'fDressed'].forEach((id) =>
  $(id).addEventListener('input', updateTally));

/* ---------- Save ---------------------------------------------------------- */
$('saveRunBtn').addEventListener('click', async () => {
  const btn = $('saveRunBtn');
  showError(null);

  const birds = parseInt($('fBirds').value, 10);
  if (!birds || birds <= 0) { showError('Birds processed must be a positive number.'); return; }
  if (!$('fDate').value) { showError('Pick the date the birds were processed.'); return; }

  const outputs = [];
  state.outputs.forEach((rec, lineId) => {
    const w = Number(rec.weight) || 0;
    if (w > 0) outputs.push({ product_line_id: lineId, weight_lb: w, units: rec.units ?? null });
  });

  if (!outputs.length) { showError('Record at least one line of weight out.'); return; }

  btn.disabled = true;
  btn.textContent = 'Saving…';

  const { error } = await db.rpc('save_processing_run', {
    p_cycle_id: state.cycle.id,
    p_processed_on: $('fDate').value,
    p_birds_processed: birds,
    p_birds_condemned: parseInt($('fCondemned').value, 10) || 0,
    p_live_weight_lb: $('fLive').value === '' ? null : Number($('fLive').value),
    p_dressed_weight_lb: $('fDressed').value === '' ? null : Number($('fDressed').value),
    p_processor: $('fProcessor').value.trim() || null,
    p_lot_code: $('fLot').value.trim() || null,
    p_outputs: outputs,
    p_run_id: state.editing ? state.editing.id : null
  });

  btn.disabled = false;
  btn.textContent = 'Save run';

  if (error) { showError(error.message); return; }

  closeForm();
  await boot();
});

/* ---------- Delete -------------------------------------------------------- */
function openDelete(run) {
  state.pending = run;
  $('delWhat').textContent =
    `The run on ${shortDate(run.processed_on)} — ${num(run.birds_processed)} birds, ` +
    `${num(run.saleable_lb)} lb out — and every line recorded against it.`;
  $('delSheet').hidden = false;
  document.body.style.overflow = 'hidden';
}

function closeSheet() {
  $('delSheet').hidden = true;
  document.body.style.overflow = '';
  state.pending = null;
}

document.querySelectorAll('[data-close-sheet]').forEach((el) =>
  el.addEventListener('click', closeSheet));

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !$('delSheet').hidden) closeSheet();
});

$('delConfirm').addEventListener('click', async () => {
  if (!state.pending) return;
  const { error } = await db.rpc('delete_processing_run', { p_run_id: state.pending.id });
  closeSheet();
  if (error) { showError(error.message); return; }
  await boot();
});

boot();
