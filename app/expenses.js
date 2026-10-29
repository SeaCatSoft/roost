/* =============================================================================
   Roost — expenses

   The real cost of a cycle, set against what the planner assumed. Planned
   figures come from v_cycle_costs via v_cycle_cost_compare (029), so they
   always match the dashboard's profit estimate. Actual feed comes from feed
   deliveries (feed_purchases); everything else is logged here into
   cost_lines. Feed cannot be logged here — it would be counted twice.

   Bedding gets more than a cost: whether it was a fresh bed or a top-up, and
   how much went down, because "when did we last re-bed?" is a question
   about the birds, not just the money.
   ========================================================================== */

import { db, isConfigured, $, today, daysBetween, banner, myRole, canEdit } from './db.js';

const screens = { setup: $('setupScreen'), auth: $('authScreen'), app: $('appScreen') };
const show = (n) => Object.entries(screens).forEach(([k, el]) => { el.hidden = k !== n; });
const showError = (m) => banner($('appError'), $('appErrorText'), m);
const showOk = (m) => banner($('appOk'), $('appOkText'), m);

if (!isConfigured) { show('setup'); throw new Error('Supabase is not configured'); }

const LABELS = {
  chicks: 'Chicks', feed: 'Feed', bedding: 'Bedding', medication: 'Medication',
  utilities: 'Utilities', labour: 'Labour', processing: 'Processing', misc: 'Other'
};

const ORDER = ['chicks', 'feed', 'bedding', 'medication', 'utilities', 'labour', 'processing', 'misc'];
const colour = (cat) => `var(--cat-${cat})`;
const NS = 'http://www.w3.org/2000/svg';

const state = {
  farm: null, cycle: null, readOnly: false, isOwner: false,
  category: 'bedding', kind: 'new', lines: [], feed: [], amountTouched: false
};

const money = (n, d = 2) =>
  `$${Number(n ?? 0).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d })}`;
const num = (n, d = 0) =>
  Number(n ?? 0).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
const shortDate = (iso) => iso
  ? new Date(iso + 'T00:00:00').toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
  : '—';

/* ---------- Load ---------------------------------------------------------- */
async function boot() {
  const { data: { session } } = await db.auth.getSession();
  if (!session) { show('auth'); return; }
  show('app');
  showError(null);

  const role = await myRole();
  state.readOnly = !canEdit(role);
  state.isOwner = role === 'owner';

  const { data: farms } = await db.from('farms').select('*').order('id').limit(1);
  if (!farms || !farms.length) { showError('No farm is linked to this account yet.'); return; }
  state.farm = farms[0];

  // The most recent cycle, open or not — between flocks, the last one's
  // costs are still the ones worth looking at. New expenses attach only to
  // an open cycle.
  const { data: cycles } = await db.from('cycles')
    .select('id, label, placed_on, closed_at').order('placed_on', { ascending: false }).limit(1);
  state.cycle = cycles && cycles.length ? cycles[0] : null;
  $('cycleLabel').textContent = state.cycle
    ? `${state.cycle.label}${state.cycle.closed_at ? ' (closed)' : ''}`
    : 'No cycle yet';

  const cycleId = state.cycle?.id ?? -1;
  const [compare, lines, feed] = await Promise.all([
    db.from('v_cycle_cost_compare').select('*').eq('cycle_id', cycleId).order('sort_order'),
    db.from('cost_lines')
      .select('id, category, amount, incurred_on, quantity, unit, bedding_kind, notes, created_at')
      .eq('cycle_id', cycleId)
      .order('incurred_on', { ascending: false }).order('id', { ascending: false }),
    db.from('feed_purchases').select('purchased_on, bags, cost_per_bag').eq('cycle_id', cycleId)
  ]);

  if (compare.error && compare.error.message.includes('does not exist')) {
    showError('This screen needs migration 029. Run backend/migrations/029_expenses_weekly_report.sql in Supabase.');
    $('compare').textContent = '';
    return;
  }

  state.lines = lines.data || [];
  state.feed = feed.data || [];
  state.compare = compare.data || [];
  renderBedding();
  renderCompare(state.compare);
  renderWeeks();
  renderRecent();
  renderReportSetting();

  $('formPanel').hidden = state.readOnly || !state.cycle || !!state.cycle.closed_at;
  if (!$('formPanel').hidden && !$('eDate').value) $('eDate').value = today();
  fillBeddingCost();
}

/* ---------- Bedding ------------------------------------------------------- */
function renderBedding() {
  const bedding = state.lines.filter((l) => l.category === 'bedding');
  const lastNew = bedding.find((l) => l.bedding_kind === 'new');
  const topups = bedding.filter((l) =>
    l.bedding_kind === 'top_up' && (!lastNew || l.incurred_on >= lastNew.incurred_on));

  $('bedLast').textContent = lastNew ? shortDate(lastNew.incurred_on) : '—';
  $('bedTopups').textContent = bedding.length ? num(topups.length) : '—';
  $('bedSpend').textContent = money(bedding.reduce((s, l) => s + Number(l.amount), 0), 0);

  const note = $('bedNote');
  if (!bedding.length) {
    note.textContent = 'No bedding logged for this cycle yet. Log the fresh bed below, and each top-up as it goes down.';
  } else if (lastNew) {
    const days = daysBetween(lastNew.incurred_on, today());
    note.textContent = `Fresh bed went down ${days === 0 ? 'today' : `${days} day${days === 1 ? '' : 's'} ago`}` +
      (lastNew.quantity ? ` (${num(lastNew.quantity, lastNew.quantity % 1 ? 1 : 0)} ${lastNew.unit || ''})` : '') + '.';
  } else {
    note.textContent = 'Only top-ups logged — the fresh bed for this cycle has not been recorded.';
  }
}

/* ---------- Planned against actual ---------------------------------------- */
/* ---------- Chart helpers -------------------------------------------------- */
function el(name, attrs, parent) {
  const n = document.createElementNS(NS, name);
  Object.entries(attrs).forEach(([k, v]) => n.setAttribute(k, v));
  if (parent) parent.appendChild(n);
  return n;
}

/* A bar with only its data end rounded — the baseline end stays square. */
function hbar(x, y, w, h, r = 4) {
  if (w <= 0) return '';
  r = Math.min(r, w, h / 2);
  return `M${x},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h - r}Q${x + w},${y + h} ${x + w - r},${y + h}H${x}Z`;
}
function vbar(x, y, w, h, r = 4) {   // rounded at the top only
  if (h <= 0) return '';
  r = Math.min(r, h, w / 2);
  return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
}

/* Tooltip placed beside the mark, kept inside the chart. */
function tip(wrapId, tipId, svg, vbW) {
  const wrap = $(wrapId), t = $(tipId);
  return {
    show(html, svgX, svgY) {
      t.innerHTML = html;
      const scale = wrap.clientWidth / vbW;
      let left = svgX * scale + 12;
      if (left + t.offsetWidth > wrap.clientWidth) left = svgX * scale - t.offsetWidth - 12;
      t.style.left = `${Math.max(0, left)}px`;
      t.style.top = `${Math.max(0, svgY * scale - 10)}px`;
      t.classList.add('is-on');
    },
    hide() { t.classList.remove('is-on'); }
  };
}
const tipRow = (cat, value) =>
  `<div class="chart-tip__row"><i class="chart-legend__chip" style="background:${colour(cat)}"></i>` +
  `<span>${LABELS[cat]}</span><span>${value}</span></div>`;

/* ---------- Planned against actual: one bar per category -------------------
   Each row is drawn against its OWN plan (the tick), not one shared scale:
   feed's plan is forty times bedding's, and a shared scale would leave
   bedding an invisible sliver. The dollar figures carry the size; the bar
   carries "how far through its plan". */
function renderCompare(rows) {
  const svg = $('compareChart');
  svg.querySelectorAll(':scope > :not(desc)').forEach((n) => n.remove());

  if (!rows.length) {
    $('spentTotal').textContent = '—';
    $('spentOf').textContent = 'No cycle to compare against yet.';
    return;
  }

  const planned = rows.reduce((s, r) => s + Number(r.planned), 0);
  const actual = rows.reduce((s, r) => s + Number(r.actual), 0);
  $('spentTotal').textContent = money(actual, 0);
  $('spentOf').textContent = `spent of ${money(planned, 0)} planned (${num(planned ? actual / planned * 100 : 0)}%)`;

  // Drawn at the panel's real pixel width, so text is true size, not scaled.
  const W = Math.max(260, $('compareWrap').clientWidth || 340), ROW = 40, TICK = W * 0.8;
  const H = rows.length * ROW;
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  const t = tip('compareWrap', 'compareTip', svg, W);

  rows.forEach((r, i) => {
    const p = Number(r.planned), a = Number(r.actual);
    const y = i * ROW;
    const over = a > p + 0.005;
    const frac = p > 0 ? Math.min(a / p, 1.25) : (a > 0 ? 1.25 : 0);

    const label = el('text', { x: 0, y: y + 13, 'font-size': 12.5, fill: 'var(--ink-2)' }, svg);
    label.textContent = LABELS[r.category];
    const val = el('text', { x: W, y: y + 13, 'font-size': 12, 'text-anchor': 'end',
      fill: over ? 'var(--warn)' : 'var(--ink-3)', 'font-weight': over ? 600 : 400,
      style: 'font-variant-numeric:tabular-nums' }, svg);
    val.textContent = `${over ? '▲ ' : ''}${money(a, 0)} of ${money(p, 0)}`;

    el('rect', { x: 0, y: y + 20, width: W, height: 10, rx: 5, fill: 'var(--chart-grid)', opacity: .6 }, svg);
    el('path', { d: hbar(0, y + 20, frac * TICK, 10), fill: colour(r.category) }, svg);
    // The plan tick, with a 2px surface ring so it reads over the bar.
    el('rect', { x: TICK - 2, y: y + 16, width: 4, height: 18, rx: 1, fill: 'var(--page-2)' }, svg);
    el('rect', { x: TICK - 1, y: y + 17, width: 2, height: 16, rx: 1, fill: 'var(--chart-plan)' }, svg);

    const hit = el('rect', { x: 0, y, width: W, height: ROW, class: 'chart-hit' }, svg);
    el('rect', { x: -4, y: y + 1, width: W + 8, height: ROW - 2, rx: 6, class: 'chart-hl' }, svg);
    const diff = p - a;
    const show = () => t.show(
      `<div class="chart-tip__title">${LABELS[r.category]}</div>` +
      tipRow(r.category, money(a, 2)) +
      `<div class="chart-tip__row"><span>Planned</span><span>${money(p, 2)}</span></div>` +
      `<div class="chart-tip__row"><span>${over ? 'Over by' : 'Left in plan'}</span><span>${money(Math.abs(diff), 2)}</span></div>`,
      frac * TICK, y);
    hit.addEventListener('mouseenter', show);
    hit.addEventListener('click', show);
    hit.addEventListener('mouseleave', t.hide);
  });

  // A cycle under plan halfway through is not under plan — most of the cost
  // stack (processing, the last feed) lands at the end. Say so, rather than
  // let a short bar read as good news.
  $('compareNote').textContent =
    'Each bar fills toward its tick, the planner\'s figure for the whole cycle. Processing and the last ' +
    'of the feed land near the end, so a cycle normally looks under plan until then. ▲ marks a cost ' +
    'already past its plan.';
}

/* ---------- Spending by week: stacked columns --------------------------------
   Week 1 starts the day the chicks were placed. Anything bought before that
   — chicks, the first bedding — goes in a "Before" column rather than being
   squeezed into week 1. */
function renderWeeks() {
  const svg = $('weekChart');
  svg.querySelectorAll(':scope > :not(desc)').forEach((n) => n.remove());
  $('weekLegend').textContent = '';
  if (!state.cycle) return;

  const weekOf = (iso) => {
    const d = daysBetween(state.cycle.placed_on, iso);
    return d < 0 ? 0 : Math.floor(d / 7) + 1;
  };
  const spend = new Map();   // week -> {category: amount}
  const add = (wk, cat, amt) => {
    const w = spend.get(wk) || {};
    w[cat] = (w[cat] || 0) + amt;
    spend.set(wk, w);
  };
  state.lines.forEach((l) => add(weekOf(l.incurred_on), l.category, Number(l.amount)));
  state.feed.forEach((f) => add(weekOf(f.purchased_on), 'feed', Number(f.bags) * Number(f.cost_per_bag)));

  if (!spend.size) {
    $('weekNote').textContent = 'Nothing spent on this cycle has been logged yet.';
    return;
  }

  const lastWeek = Math.max(weekOf(state.cycle.closed_at ? state.cycle.closed_at.slice(0, 10) : today()), ...spend.keys());
  const weeks = [];
  if (spend.has(0)) weeks.push(0);
  for (let w = 1; w <= lastWeek; w++) weeks.push(w);

  const totals = {};
  spend.forEach((w) => Object.entries(w).forEach(([c, v]) => { totals[c] = (totals[c] || 0) + v; }));
  const cats = ORDER.filter((c) => totals[c]);

  // Legend doubles as the value table: every category with its cycle total.
  cats.forEach((c) => {
    $('weekLegend').insertAdjacentHTML('beforeend',
      `<span class="chart-legend__item"><i class="chart-legend__chip" style="background:${colour(c)}"></i>` +
      `${LABELS[c]} <span class="chart-legend__val">${money(totals[c], 0)}</span></span>`);
  });

  const W = Math.max(260, $('weekWrap').clientWidth || 340), H = 200, L = 40, R = 4, T = 8, B = 22;
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  const t = tip('weekWrap', 'weekTip', svg, W);
  const colTotal = (wk) => Object.values(spend.get(wk) || {}).reduce((a, b) => a + b, 0);
  const max = Math.max(...weeks.map(colTotal), 1) * 1.1;
  const y = (v) => H - B - (v / max) * (H - T - B);
  const slot = (W - L - R) / weeks.length;
  const bw = Math.min(28, slot * 0.62);

  for (let i = 0; i <= 3; i++) {
    const v = (max / 3) * i;
    el('line', { x1: L, x2: W - R, y1: y(v), y2: y(v),
      stroke: i === 0 ? 'var(--chart-axis)' : 'var(--chart-grid)', 'stroke-width': 1 }, svg);
    el('text', { x: L - 6, y: y(v) + 3, 'text-anchor': 'end', 'font-size': 10.5, fill: 'var(--ink-3)',
      style: 'font-variant-numeric:tabular-nums' }, svg)
      .textContent = v >= 1000 ? `$${(v / 1000).toFixed(1)}k` : `$${Math.round(v)}`;
  }

  const every = weeks.length > 9 ? 2 : 1;
  weeks.forEach((wk, i) => {
    const cx = L + slot * i + slot / 2;
    const x = cx - bw / 2;
    const w = spend.get(wk) || {};
    const present = ORDER.filter((c) => w[c]);
    let base = 0;
    present.forEach((c, j) => {
      const top = j === present.length - 1;
      const y0 = y(base), y1 = y(base + w[c]);
      // 2px surface gap between stacked segments.
      const h = Math.max(0, y0 - y1 - (j > 0 ? 2 : 0));
      el('path', { d: top ? vbar(x, y1, bw, h) : `M${x},${y1}h${bw}v${h}h${-bw}Z`, fill: colour(c) }, svg);
      base += w[c];
    });

    if (i % every === 0 || i === weeks.length - 1) {
      el('text', { x: cx, y: H - 8, 'text-anchor': 'middle', 'font-size': 10.5, fill: 'var(--ink-3)' }, svg)
        .textContent = wk === 0 ? 'Before' : `Wk ${wk}`;
    }

    const hit = el('rect', { x: L + slot * i, y: T, width: slot, height: H - T - B, class: 'chart-hit' }, svg);
    el('rect', { x: L + slot * i + 1, y: T, width: slot - 2, height: H - T - B, rx: 4, class: 'chart-hl' }, svg);
    const show = () => t.show(
      `<div class="chart-tip__title">${wk === 0 ? 'Before placement' : `Week ${wk}`}</div>` +
      (present.length
        ? present.slice().reverse().map((c) => tipRow(c, money(w[c], 0))).join('') +
          `<div class="chart-tip__row" style="font-weight:600;margin-top:.15rem"><span>Total</span><span>${money(colTotal(wk), 0)}</span></div>`
        : '<div class="caption">Nothing logged</div>'),
      cx + bw / 2, y(colTotal(wk)));
    hit.addEventListener('mouseenter', show);
    hit.addEventListener('click', show);
    hit.addEventListener('mouseleave', t.hide);
  });

  $('weekNote').textContent = 'Tap or hover a week for its breakdown. Feed is counted in the week it was delivered, not when it was eaten.';
}

/* ---------- Form ---------------------------------------------------------- */
function wireSegment(name, onPick) {
  document.querySelectorAll(`[data-segment="${name}"] button`).forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll(`[data-segment="${name}"] button`).forEach((b) =>
        b.setAttribute('aria-pressed', String(b === btn)));
      onPick(btn.getAttribute('data-value'));
    });
  });
}

wireSegment('category', (v) => {
  state.category = v;
  $('beddingFields').hidden = v !== 'bedding';
  fillBeddingCost();
});
wireSegment('kind', (v) => { state.kind = v; });

/* Price per bag: the last bedding actually logged in bags, so a price change
   follows itself in; before any, the farm's set price (43.32, 029). */
function bagPrice() {
  const last = state.lines.find((l) =>
    l.category === 'bedding' && l.unit === 'bags' && Number(l.quantity) > 0 && Number(l.amount) > 0);
  if (last) return Number(last.amount) / Number(last.quantity);
  return Number(state.farm?.bedding_bag_price ?? 43.32);
}

/* Fills the cost from bags × price — until the cost is typed over, after
   which it is left alone. Bales and loads have no set price, so those stay
   typed by hand. */
function fillBeddingCost() {
  if (state.amountTouched) return;
  const qty = Number($('eQty').value);
  const auto = state.category === 'bedding' && $('eUnit').value === 'bags' && qty > 0;
  $('eAmount').value = auto ? (qty * bagPrice()).toFixed(2) : '';
  $('bagHint').textContent = state.category === 'bedding' && $('eUnit').value === 'bags'
    ? `At ${money(bagPrice())} a bag.` : '';
}
$('eQty').addEventListener('input', fillBeddingCost);
$('eUnit').addEventListener('change', fillBeddingCost);
$('eAmount').addEventListener('input', () => { state.amountTouched = $('eAmount').value !== ''; });

$('saveBtn').addEventListener('click', async () => {
  showError(null); showOk(null);

  const amount = Number($('eAmount').value);
  if ($('eAmount').value === '' || !(amount >= 0)) { showError('Enter what it cost. Use 0 if it was free.'); return; }

  const isBedding = state.category === 'bedding';
  const qtyRaw = $('eQty').value.trim();
  const qty = qtyRaw === '' ? null : Number(qtyRaw);
  if (isBedding && qty !== null && !(qty > 0)) { showError('Enter how much bedding went down, or leave it empty.'); return; }

  const btn = $('saveBtn');
  btn.disabled = true; btn.textContent = 'Logging…';

  const { error } = await db.from('cost_lines').insert({
    farm_id: state.farm.id,
    cycle_id: state.cycle.id,
    category: state.category,
    amount,
    incurred_on: $('eDate').value || today(),
    quantity: isBedding ? qty : null,
    unit: isBedding && qty !== null ? $('eUnit').value : null,
    bedding_kind: isBedding ? state.kind : null,
    notes: $('eNotes').value.trim() || null
  });

  btn.disabled = false; btn.textContent = 'Log it';
  if (error) { showError(error.message); return; }

  $('eAmount').value = ''; $('eQty').value = ''; $('eNotes').value = '';
  state.amountTouched = false;
  showOk(isBedding
    ? `${state.kind === 'new' ? 'Fresh bed' : 'Top-up'} logged — ${money(amount)}.`
    : `${LABELS[state.category]} logged — ${money(amount)}.`);
  await boot();
});

/* ---------- Weekly report switch ------------------------------------------- */
async function renderReportSetting() {
  const on = state.farm.weekly_report_email;
  $('reportPanel').hidden = !state.isOwner || on == null;
  if ($('reportPanel').hidden) return;
  $('reportEmail').checked = on;

  const { data } = await db.from('weekly_reports')
    .select('week_start, week_end, sent_at').eq('farm_id', state.farm.id)
    .order('week_start', { ascending: false }).limit(1);
  $('lastReport').textContent = data && data.length
    ? `Last sent for ${shortDate(data[0].week_start)} – ${shortDate(data[0].week_end)}.`
    : 'No report sent yet. The first arrives next Monday.';
}

$('reportEmail').addEventListener('change', async () => {
  showError(null); showOk(null);
  const on = $('reportEmail').checked;
  const { error } = await db.from('farms').update({ weekly_report_email: on }).eq('id', state.farm.id);
  if (error) { $('reportEmail').checked = !on; showError(error.message); return; }
  state.farm.weekly_report_email = on;
  showOk(on ? 'The weekly report will arrive every Monday at 6am.' : 'Weekly report emails are off.');
});

/* ---------- Logged this cycle --------------------------------------------- */
function renderRecent() {
  const wrap = $('recentList');
  wrap.textContent = '';
  $('recentSection').hidden = !state.lines.length;

  state.lines.forEach((l) => {
    const el = document.createElement('div');
    el.className = state.readOnly ? 'age-row' : 'age-row age-row--removable';

    let what = LABELS[l.category] || l.category;
    if (l.category === 'bedding') {
      what = l.bedding_kind === 'new' ? 'Fresh bed' : l.bedding_kind === 'top_up' ? 'Bedding top-up' : 'Bedding';
      if (l.quantity) what += ` · ${num(l.quantity, l.quantity % 1 ? 1 : 0)} ${l.unit || ''}`;
    }
    if (l.notes) what += ` · ${l.notes}`;

    el.innerHTML =
      `<span class="age-row__label">${shortDate(l.incurred_on)}</span>
       <span style="font-size:.8125rem;color:var(--ink-2);min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap"></span>
       <span class="age-row__val tnum">${money(l.amount)}</span>`;
    el.children[1].textContent = what;   // notes are typed text — never markup

    if (!state.readOnly) el.appendChild(removeButton(l.id));
    wrap.appendChild(el);
  });
}

/* Two taps, the same as everywhere else in Roost. */
function removeButton(id) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'chip-btn chip-btn--danger';
  btn.setAttribute('data-press', '');
  btn.textContent = 'Remove';

  let armed = null;
  btn.addEventListener('click', async () => {
    if (!armed) {
      btn.textContent = 'Remove it?';
      armed = setTimeout(() => { armed = null; btn.textContent = 'Remove'; }, 4000);
      return;
    }
    clearTimeout(armed);
    btn.disabled = true; btn.textContent = 'Removing…';
    showError(null); showOk(null);
    const { error } = await db.from('cost_lines').delete().eq('id', id);
    if (error) {
      showError(`Could not remove it: ${error.message}`);
      armed = null; btn.disabled = false; btn.textContent = 'Remove';
      return;
    }
    await boot();
  });
  return btn;
}

/* Redraw at the new width when the screen turns or the window resizes. */
let resizeTimer;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => { if (state.compare) { renderCompare(state.compare); renderWeeks(); } }, 150);
});

boot();
