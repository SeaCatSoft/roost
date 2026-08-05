/* =============================================================================
   Roost — batches

   The reason archiving is worth doing. One row per cycle, plus everything
   totalled, so a flock can be judged against the ones before it rather than
   in isolation.

   Two kinds of number live here and are labelled apart: what was recorded
   (mortality, feed, conversion) and what the assumptions predict (revenue,
   cost, result). Money stays modelled until processing runs are entered.
   ========================================================================== */

import { db, isConfigured, $, banner } from './db.js';

const screens = { setup: $('setupScreen'), auth: $('authScreen'), app: $('appScreen') };
const show = (n) => Object.entries(screens).forEach(([k, el]) => { el.hidden = k !== n; });
const showError = (m) => banner($('appError'), $('appErrorText'), m);

if (!isConfigured) { show('setup'); throw new Error('Supabase is not configured'); }

const state = { cycles: [], totals: null, metric: 'profit', pending: null };

const num = (n, d = 0) =>
  Number(n ?? 0).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });

const money = (n) => {
  const v = Number(n ?? 0);
  const s = Math.abs(v) >= 1000 ? num(Math.abs(v) / 1000, 1) + 'k' : num(Math.abs(v));
  return (v < 0 ? '−$' : '$') + s;
};

const shortDate = (iso) =>
  new Date(iso + 'T00:00:00').toLocaleDateString(undefined, { month: 'short', year: 'numeric' });

/* ---------- Load ---------------------------------------------------------- */
async function boot() {
  const { data: { session } } = await db.auth.getSession();
  if (!session) { show('auth'); return; }
  show('app');
  showError(null);

  const [cyclesRes, totalsRes] = await Promise.all([
    db.from('v_cycle_summary').select('*').order('placed_on', { ascending: false }),
    db.from('v_farm_totals').select('*').maybeSingle()
  ]);

  if (cyclesRes.error) {
    showError(
      cyclesRes.error.message.includes('does not exist')
        ? 'This screen needs migration 006. Run backend/migrations/006_cycle_history.sql in Supabase.'
        : `Could not load batches: ${cyclesRes.error.message}`
    );
    return;
  }

  state.cycles = cyclesRes.data || [];
  state.totals = totalsRes.data || null;

  renderTotals();
  renderCompare();
  renderList();
}

/* ---------- Totals -------------------------------------------------------- */
function renderTotals() {
  const t = state.totals;
  if (!t) return;

  $('totalsScope').textContent =
    `${num(t.cycles)} batch${t.cycles === 1 ? '' : 'es'} · ${num(t.cycles_closed)} closed`;

  $('tBirds').textContent = num(t.birds_placed);
  $('tMortality').textContent = t.mortality == null ? '—' : `${num(t.mortality * 100, 1)}%`;
  $('tFeed').textContent = t.feed_kg ? `${num(t.feed_kg / 1000, 1)}t` : '—';
  $('tRevenue').textContent = money(t.revenue);
  $('tCost').textContent = money(t.cost);

  const profit = Number(t.profit ?? 0);
  const el = $('tProfit');
  el.textContent = money(profit);
  el.style.color = profit < 0 ? 'var(--warn)' : 'var(--accent)';

  $('totalsNote').textContent =
    'Birds, mortality and feed are what you recorded. Revenue, cost and result are ' +
    'modelled from each cycle\'s assumptions until processing runs are entered.';
}

/* ---------- Comparison ---------------------------------------------------- */
document.querySelectorAll('[data-segment="metric"] button').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('[data-segment="metric"] button').forEach((b) =>
      b.setAttribute('aria-pressed', String(b === btn)));
    state.metric = btn.getAttribute('data-value');
    renderCompare();
  });
});

function metricFor(c) {
  if (state.metric === 'profit') return Number(c.modelled_profit ?? 0);
  if (state.metric === 'mortality') return c.mortality_actual == null ? null : Number(c.mortality_actual) * 100;
  return c.fcr_actual == null ? null : Number(c.fcr_actual);
}

function labelFor(v) {
  if (v === null) return '—';
  if (state.metric === 'profit') return money(v);
  if (state.metric === 'mortality') return `${num(v, 1)}%`;
  return num(v, 2);
}

function renderCompare() {
  const panel = $('comparePanel');
  const wrap = $('compareBars');

  // One bar is not a comparison.
  if (state.cycles.length < 2) { panel.hidden = true; return; }
  panel.hidden = false;
  wrap.textContent = '';

  const rows = [...state.cycles].reverse();   // oldest first, so time reads left to right
  const values = rows.map(metricFor).filter((v) => v !== null);
  if (!values.length) {
    wrap.innerHTML = '<p class="caption">Nothing recorded for this measure yet.</p>';
    return;
  }

  const max = Math.max(...values.map(Math.abs), 1);

  rows.forEach((c) => {
    const v = metricFor(c);
    const pct = v === null ? 0 : (Math.abs(v) / max) * 100;

    // Lower is better for mortality and conversion; higher is better for result.
    const bad = v !== null && (
      (state.metric === 'profit' && v < 0) ||
      (state.metric === 'mortality' && v > 5) ||
      (state.metric === 'fcr' && v > 1.65)
    );

    const row = document.createElement('div');
    row.className = 'cmp-row';
    row.innerHTML =
      `<div class="cmp-row__label">${c.label}</div>
       <div class="cmp-row__track">
         <div class="cmp-row__fill${bad ? ' cmp-row__fill--bad' : ''}" style="width:${pct.toFixed(1)}%"></div>
       </div>
       <div class="cmp-row__val tnum">${labelFor(v)}</div>`;
    wrap.appendChild(row);
  });
}

/* ---------- The list ------------------------------------------------------ */
function renderList() {
  const wrap = $('cycleList');
  wrap.textContent = '';

  if (!state.cycles.length) {
    wrap.innerHTML = '<p class="caption">No batches yet.</p>';
    return;
  }

  state.cycles.forEach((c) => {
    const card = document.createElement('article');
    card.className = 'batch' + (c.is_open ? ' batch--open' : '');

    const fcr = c.fcr_actual == null ? '—' : num(c.fcr_actual, 2);
    const mort = c.mortality_actual == null ? '—' : `${num(c.mortality_actual * 100, 1)}%`;
    const profit = Number(c.modelled_profit ?? 0);

    card.innerHTML =
      `<div class="batch__head">
         <div>
           <div class="batch__name">${c.label}${c.is_open ? ' <span class="batch__tag">Running</span>' : ''}</div>
           <div class="batch__meta">${shortDate(c.placed_on)} · ${num(c.birds_placed)} birds${c.breed ? ' · ' + c.breed : ''}</div>
         </div>
         ${c.is_open ? '' :
           `<button class="batch__del" type="button" data-delete="${c.cycle_id}" data-press
                    aria-label="Delete ${c.label}">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 7h16M9 7V5.5A1.5 1.5 0 0 1 10.5 4h3A1.5 1.5 0 0 1 15 5.5V7"/><path d="M6 7l1 12a2 2 0 0 0 2 1.9h6A2 2 0 0 0 17 19L18 7"/></svg>
            </button>`}
       </div>
       <div class="batch__grid">
         <div><span class="metric__k">Mortality</span><span class="batch__v tnum">${mort}</span></div>
         <div><span class="metric__k">FCR</span><span class="batch__v tnum">${fcr}</span></div>
         <div><span class="metric__k">Feed</span><span class="batch__v tnum">${c.bags_opened ? num(c.bags_opened) + ' bags' : '—'}</span></div>
         <div><span class="metric__k">Result</span><span class="batch__v tnum" style="color:${profit < 0 ? 'var(--warn)' : 'var(--accent)'}">${money(profit)}</span></div>
       </div>
       <div class="batch__foot caption">${num(c.days_recorded)} of ${num(c.target_sale_age)} days recorded</div>`;

    wrap.appendChild(card);
  });

  wrap.querySelectorAll('[data-delete]').forEach((btn) => {
    btn.addEventListener('click', () => openSheet(Number(btn.getAttribute('data-delete'))));
  });
}

/* ---------- Delete -------------------------------------------------------- */
function openSheet(cycleId) {
  const c = state.cycles.find((x) => x.cycle_id === cycleId);
  if (!c) return;

  state.pending = c;
  $('sheetWhat').textContent =
    `${c.label} — ${num(c.birds_placed)} birds placed ${shortDate(c.placed_on)}, ` +
    `${num(c.days_recorded)} days of checks and ${num(c.bags_opened)} bag openings.`;
  $('sheetWord').textContent = c.label;
  $('sheetConfirm').value = '';
  $('sheetDelete').disabled = true;
  $('deleteSheet').hidden = false;
  document.body.style.overflow = 'hidden';
  $('sheetConfirm').focus();
}

function closeSheet() {
  $('deleteSheet').hidden = true;
  document.body.style.overflow = '';
  state.pending = null;
}

document.querySelectorAll('[data-close-sheet]').forEach((el) =>
  el.addEventListener('click', closeSheet));

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !$('deleteSheet').hidden) closeSheet();
});

$('sheetConfirm').addEventListener('input', () => {
  const typed = $('sheetConfirm').value.trim().toLowerCase();
  const needed = (state.pending?.label || '').trim().toLowerCase();
  $('sheetDelete').disabled = !needed || typed !== needed;
});

$('sheetDelete').addEventListener('click', async () => {
  if (!state.pending) return;
  const btn = $('sheetDelete');
  btn.disabled = true;
  btn.textContent = 'Deleting…';

  const { error } = await db.rpc('delete_cycle', { p_cycle_id: state.pending.cycle_id });

  btn.textContent = 'Delete';
  if (error) {
    closeSheet();
    showError(`Could not delete: ${error.message}`);
    return;
  }

  closeSheet();
  await boot();
});

boot();
