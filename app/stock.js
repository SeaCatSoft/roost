/* =============================================================================
   Roost — stock

   Nothing here is a stored stock level. v_stock counts what processing weighed
   out, subtracts what went out on fulfilled orders, and applies corrections —
   so the figure cannot drift from the weigh-outs it came from. The only thing
   this screen writes is a correction, which is the one movement no other part
   of the app can explain.

   Whole birds are counted and cut parts are weighed, the same split invoicing
   and orders use, so a number never changes meaning between screens.
   ========================================================================== */

import { db, isConfigured, $, today, banner, myRole, canEdit } from './db.js';

const screens = { setup: $('setupScreen'), auth: $('authScreen'), app: $('appScreen') };
const show = (n) => Object.entries(screens).forEach(([k, el]) => { el.hidden = k !== n; });
const showError = (m) => banner($('appError'), $('appErrorText'), m);
const showOk = (m) => banner($('appOk'), $('appOkText'), m);

if (!isConfigured) { show('setup'); throw new Error('Supabase is not configured'); }

const state = { farm: null, rows: [], readOnly: false };

const num = (n, d = 0) =>
  Number(n ?? 0).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
const shortDate = (iso) => iso
  ? new Date(iso + 'T00:00:00').toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
  : '—';

/* Each row reads in its own unit rather than forcing one on both. */
const unitOf = (r) => (r.is_whole_bird ? 'ea' : 'lb');
const dp = (r) => (r.is_whole_bird ? 0 : 1);
const onHand = (r) => Number(r.is_whole_bird ? r.on_hand_units : r.on_hand_lb);
const promised = (r) => Number(r.is_whole_bird ? r.committed_units : r.committed_lb);
const free = (r) => Number(r.is_whole_bird ? r.available_units : r.available_lb);

/* ---------- Load ---------------------------------------------------------- */
async function boot() {
  const { data: { session } } = await db.auth.getSession();
  if (!session) { show('auth'); return; }
  show('app');
  showError(null);

  state.readOnly = !canEdit(await myRole());

  const { data: farms } = await db.from('farms').select('id, name').order('id').limit(1);
  if (!farms || !farms.length) { showError('No farm is linked to this account yet.'); return; }
  state.farm = farms[0];
  $('farmName').textContent = state.farm.name;

  const [stock, recent] = await Promise.all([
    db.from('v_stock').select('*').order('sort_order'),
    db.from('stock_adjustments')
      .select('id, adjusted_on, quantity_lb, units, reason, product_line_id')
      .order('adjusted_on', { ascending: false }).limit(10)
  ]);

  if (stock.error) {
    showError(stock.error.message.includes('does not exist')
      ? 'This screen needs migration 017. Run backend/migrations/017_orders_stock.sql in Supabase.'
      : `Could not load stock: ${stock.error.message}`);
    return;
  }

  state.rows = stock.data || [];
  renderList();

  $('adjustPanel').hidden = state.readOnly;
  if (!state.readOnly) fillAdjustForm();
  renderRecent(recent.data || []);
}

/* ---------- The list ------------------------------------------------------ */
function renderList() {
  const wrap = $('list');
  wrap.textContent = '';

  if (!state.rows.length) {
    wrap.innerHTML = '<p class="caption">No products on the price list yet.</p>';
    return;
  }

  const anyMovement = state.rows.some(
    (r) => Number(r.produced_lb) || Number(r.produced_units) || promised(r));

  if (!anyMovement) {
    wrap.innerHTML =
      `<p class="caption">Nothing processed yet, so there is nothing in stock.
       This fills in from the first processing run — no separate stock-taking.</p>`;
    return;
  }

  state.rows.forEach((r) => {
    const card = document.createElement('article');
    card.className = 'batch';
    const f = free(r);
    const u = unitOf(r);
    const d = dp(r);

    card.innerHTML =
      `<div class="batch__head">
         <div>
           <div class="batch__name">${r.name}</div>
           <div class="batch__meta">${
             r.last_produced_on ? `last processed ${shortDate(r.last_produced_on)}` : 'never processed'}</div>
         </div>
       </div>
       <div class="batch__grid">
         <div><span class="metric__k">On hand</span><span class="batch__v tnum">${num(onHand(r), d)} ${u}</span></div>
         <div><span class="metric__k">Promised</span><span class="batch__v tnum">${num(promised(r), d)} ${u}</span></div>
         <div><span class="metric__k">Free</span><span class="batch__v tnum" style="color:${
           f < 0 ? 'var(--warn)' : f > 0 ? 'var(--accent)' : 'inherit'}">${num(f, d)} ${u}</span></div>
       </div>` +
      (f < 0
        ? `<p class="caption" style="margin-top:.6rem;color:var(--warn)">Short by ${
             num(Math.abs(f), d)} ${u} — the open cycle has to cover this.</p>`
        : '');

    wrap.appendChild(card);
  });
}

/* ---------- Corrections --------------------------------------------------- */
function fillAdjustForm() {
  const sel = $('aProduct');
  sel.textContent = '';
  state.rows.forEach((r) => {
    const o = document.createElement('option');
    o.value = r.product_line_id;
    o.textContent = r.name;
    sel.appendChild(o);
  });
  $('aDate').value = today();
  syncUnit();
}

function syncUnit() {
  const r = state.rows.find((x) => String(x.product_line_id) === $('aProduct').value);
  $('aUnit').textContent = r ? unitOf(r) : 'lb';
  $('aQty').step = r && r.is_whole_bird ? '1' : '0.01';
}
$('aProduct').addEventListener('change', syncUnit);

$('adjustBtn').addEventListener('click', async () => {
  showError(null); showOk(null);

  const productId = Number($('aProduct').value);
  const qty = Number($('aQty').value);
  const reason = $('aReason').value.trim();

  if (!productId) { showError('Pick a product.'); return; }
  if (!qty) { showError('Enter an amount — negative to take stock away.'); return; }
  if (!reason) { showError('Say what happened. A correction with no reason is impossible to check later.'); return; }

  const row = state.rows.find((r) => r.product_line_id === productId);
  const whole = !!row?.is_whole_bird;

  const btn = $('adjustBtn');
  btn.disabled = true; btn.textContent = 'Recording…';

  const { data: { session } } = await db.auth.getSession();

  const { error } = await db.from('stock_adjustments').insert({
    farm_id: state.farm.id,
    product_line_id: productId,
    adjusted_on: $('aDate').value || today(),
    quantity_lb: whole ? 0 : qty,
    units: whole ? Math.round(qty) : 0,
    reason,
    adjusted_by: session?.user?.id ?? null
  });

  btn.disabled = false; btn.textContent = 'Record it';
  if (error) { showError(error.message); return; }

  $('aQty').value = '';
  $('aReason').value = '';
  showOk('Correction recorded.');
  await boot();
});

function renderRecent(rows) {
  if (!rows.length) { $('recentSection').hidden = true; return; }
  $('recentSection').hidden = false;

  const wrap = $('recentList');
  wrap.textContent = '';

  rows.forEach((a) => {
    const r = state.rows.find((x) => x.product_line_id === a.product_line_id);
    const whole = !!r?.is_whole_bird;
    const qty = whole ? Number(a.units) : Number(a.quantity_lb);

    const row = document.createElement('div');
    row.className = 'age-row';
    row.innerHTML =
      `<span class="age-row__label">${shortDate(a.adjusted_on)}</span>
       <span style="font-size:.8125rem;color:var(--ink-2);min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${
         r ? r.name : 'Unknown product'} — ${a.reason}</span>
       <span class="age-row__val tnum" style="color:${qty < 0 ? 'var(--warn)' : 'var(--accent)'}">${
         qty > 0 ? '+' : ''}${num(qty, whole ? 0 : 1)}</span>`;
    wrap.appendChild(row);
  });
}

boot();
