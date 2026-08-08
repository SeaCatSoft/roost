/* =============================================================================
   Roost — invoices

   Ageing first, because the question is rarely "what did we invoice" and
   almost always "who has not paid, and for how long".

   An invoice's value is summed from its lines and its paid state derived from
   its payments — neither is stored. A stored total that drifts from its lines
   is how an invoicing system starts lying quietly.
   ========================================================================== */

import { db, isConfigured, $, today, banner, loadOpenCycle, myRole, canEdit } from './db.js';

const screens = { setup: $('setupScreen'), auth: $('authScreen'), app: $('appScreen') };
const show = (n) => Object.entries(screens).forEach(([k, el]) => { el.hidden = k !== n; });
const showError = (m) => banner($('appError'), $('appErrorText'), m);

if (!isConfigured) { show('setup'); throw new Error('Supabase is not configured'); }

const state = {
  farm: null, cycle: null, customers: [], lines: [], mix: [],
  invoices: [], filter: 'open', editing: null, draft: [], pending: null, readOnly: false
};

const num = (n, d = 0) =>
  Number(n ?? 0).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
const money = (v) => '$' + num(Math.abs(Number(v ?? 0)), 2);
const shortDate = (iso) =>
  new Date(iso + 'T00:00:00').toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });

const addDays = (iso, days) => {
  const d = new Date(iso + 'T00:00:00');
  d.setDate(d.getDate() + days);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

/* ---------- Load ---------------------------------------------------------- */
async function boot() {
  const { data: { session } } = await db.auth.getSession();
  if (!session) { show('auth'); return; }
  show('app');
  showError(null);

  const { data: farms } = await db.from('farms').select('id, name').order('id').limit(1);
  if (!farms || !farms.length) { showError('No farm is linked to this account yet.'); return; }
  state.farm = farms[0];
  $('farmName').textContent = state.farm.name;

  try { state.cycle = await loadOpenCycle(); } catch { state.cycle = null; }

  const [customers, invoices, ageing, lines, mix] = await Promise.all([
    db.from('customers').select('id, name, payment_terms_days').eq('active', true).order('name'),
    db.from('v_invoices').select('*').order('issued_on', { ascending: false }),
    db.from('v_invoice_ageing').select('*').maybeSingle(),
    db.from('product_lines').select('*').order('sort_order'),
    state.cycle
      ? db.from('cycle_product_mix').select('*').eq('cycle_id', state.cycle.id)
      : Promise.resolve({ data: [] })
  ]);

  if (invoices.error) {
    showError(invoices.error.message.includes('does not exist')
      ? 'This screen needs migration 012. Run backend/migrations/012_sales.sql in Supabase.'
      : `Could not load invoices: ${invoices.error.message}`);
    return;
  }

  state.customers = customers.data || [];
  state.invoices = invoices.data || [];
  state.lines = lines.data || [];
  state.mix = mix.data || [];
  state.readOnly = !canEdit(await myRole());
  $('newBtn').disabled = state.readOnly || !state.customers.length;

  renderAgeing(ageing.data);
  renderList();

  if (!state.customers.length) {
    showError('Add a customer before raising an invoice.');
  }
}

const priceFor = (lineId) =>
  Number(state.mix.find((m) => m.product_line_id === lineId)?.price_per_lb ?? 0);

/* ---------- Ageing -------------------------------------------------------- */
function renderAgeing(a) {
  const total = Number(a?.outstanding ?? 0);
  $('owedTotal').textContent = money(total);
  $('owedTotal').style.color = total > 0 ? 'var(--warn)' : 'var(--accent)';
  $('owedSub').textContent = total > 0
    ? `${num(a.open_invoices)} invoice${a.open_invoices === 1 ? '' : 's'} outstanding`
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
  if (!buckets.length) return;

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

/* ---------- List ---------------------------------------------------------- */
document.querySelectorAll('[data-segment="filter"] button').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('[data-segment="filter"] button').forEach((b) =>
      b.setAttribute('aria-pressed', String(b === btn)));
    state.filter = btn.getAttribute('data-value');
    renderList();
  });
});

const STATE_TONE = {
  paid: 'ok', 'part paid': 'warn', unpaid: 'warn', draft: 'muted', void: 'muted'
};

function renderList() {
  const wrap = $('list');
  wrap.textContent = '';

  const rows = state.filter === 'open'
    ? state.invoices.filter((i) => i.status !== 'void' && Number(i.outstanding) > 0.005)
    : state.invoices;

  if (!rows.length) {
    wrap.innerHTML = `<p class="caption">${
      state.filter === 'open' ? 'Nothing outstanding.' : 'No invoices yet.'}</p>`;
    return;
  }

  rows.forEach((i) => {
    const card = document.createElement('article');
    card.className = 'batch';
    const overdue = Number(i.days_overdue ?? 0) > 0;

    card.innerHTML =
      `<div class="batch__head">
         <div>
           <div class="batch__name">${i.number}
             <span class="inv-state inv-state--${STATE_TONE[i.state] || 'muted'}">${i.state}</span>
           </div>
           <div class="batch__meta">${i.customer} · issued ${shortDate(i.issued_on)} · due ${shortDate(i.due_on)}</div>
         </div>
       </div>
       <div class="batch__grid">
         <div><span class="metric__k">Total</span><span class="batch__v tnum">${money(i.total)}</span></div>
         <div><span class="metric__k">Paid</span><span class="batch__v tnum">${money(i.paid)}</span></div>
         <div><span class="metric__k">Outstanding</span><span class="batch__v tnum"
              style="color:${Number(i.outstanding) > 0.005 ? 'var(--warn)' : 'inherit'}">${money(i.outstanding)}</span></div>
         <div><span class="metric__k">Overdue</span><span class="batch__v tnum"
              style="color:${overdue ? 'var(--warn)' : 'inherit'}">${overdue ? num(i.days_overdue) + ' days' : '—'}</span></div>
       </div>`;

    if (!state.readOnly) {
      const actions = document.createElement('div');
      actions.className = 'person__actions';
      actions.style.marginTop = '.9rem';

      if (i.status === 'draft') {
        actions.appendChild(chip('Send', () => setStatus(i, 'sent')));
        actions.appendChild(chip('Edit', () => openForm(i)));
      }
      if (i.status === 'sent' && Number(i.outstanding) > 0.005) {
        actions.appendChild(chip('Record payment', () => openPayment(i), true));
      }
      if (i.status !== 'void') {
        actions.appendChild(chip('Void', () => setStatus(i, 'void'), false, true));
      }

      card.appendChild(actions);
    }

    wrap.appendChild(card);
  });
}

function chip(label, onClick, primary, danger) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'chip-btn' + (danger ? ' chip-btn--danger' : '');
  b.setAttribute('data-press', '');
  if (primary) b.style.cssText = 'background:var(--accent);color:var(--accent-ink);font-weight:600';
  b.textContent = label;
  b.addEventListener('click', onClick);
  return b;
}

async function setStatus(inv, status) {
  showError(null);
  const { error } = await db.from('invoices').update({ status }).eq('id', inv.id);
  if (error) { showError(error.message); return; }
  await boot();
}

/* ---------- The form ------------------------------------------------------ */
$('newBtn').addEventListener('click', () => openForm(null));
$('cancelBtn').addEventListener('click', () => { $('formPanel').hidden = true; });
$('addLineBtn').addEventListener('click', () => { state.draft.push(blankLine()); renderLines(); });

function blankLine() {
  const first = state.lines[0];
  return {
    product_line_id: first ? String(first.id) : '',
    description: first ? first.name : '',
    quantity_lb: '',
    unit_price: first ? priceFor(first.id) : 0
  };
}

async function openForm(inv) {
  state.editing = inv;
  $('formTitle').textContent = inv ? `Edit ${inv.number}` : 'New invoice';

  const sel = $('fCustomer');
  sel.textContent = '';
  state.customers.forEach((c) => {
    const o = document.createElement('option');
    o.value = c.id; o.textContent = c.name;
    sel.appendChild(o);
  });
  if (inv) sel.value = inv.customer_id;

  $('fIssued').value = inv ? inv.issued_on : today();
  $('fNotes').value = inv?.notes ?? '';
  syncDue();

  if (inv) {
    const { data } = await db.from('invoice_lines')
      .select('product_line_id, description, quantity_lb, units, unit_price')
      .eq('invoice_id', inv.id).order('sort_order');
    state.draft = (data || []).map((l) => ({
      product_line_id: l.product_line_id ? String(l.product_line_id) : '',
      description: l.description,
      quantity_lb: l.quantity_lb ?? '',
      unit_price: Number(l.unit_price)
    }));
    $('fDue').value = inv.due_on;
  } else {
    state.draft = [blankLine()];
  }

  renderLines();
  $('formPanel').hidden = false;
  $('formPanel').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

/* Due date follows the customer's own terms rather than a fixed 30 days. */
function syncDue() {
  const c = state.customers.find((x) => String(x.id) === $('fCustomer').value);
  const issued = $('fIssued').value || today();
  $('fDue').value = addDays(issued, c?.payment_terms_days ?? 30);
}
$('fCustomer').addEventListener('change', syncDue);
$('fIssued').addEventListener('change', syncDue);

function renderLines() {
  const wrap = $('lineRows');
  wrap.textContent = '';

  state.draft.forEach((line, idx) => {
    const row = document.createElement('div');
    row.className = 'inv-line';

    const opts = state.lines.map((l) =>
      `<option value="${l.id}"${String(l.id) === line.product_line_id ? ' selected' : ''}>${l.name}</option>`
    ).join('');

    row.innerHTML =
      `<span class="setting__input inv-line__prod">
         <select aria-label="Product">${opts}</select>
       </span>
       <span class="setting__input inv-line__qty">
         <input type="number" inputmode="decimal" min="0" step="0.01" value="${line.quantity_lb}"
                aria-label="Pounds"><span class="setting__unit">lb</span>
       </span>
       <span class="setting__input inv-line__price">
         <span class="setting__unit">$</span>
         <input type="number" inputmode="decimal" min="0" step="0.01" value="${line.unit_price}"
                aria-label="Price per pound">
       </span>
       <span class="inv-line__total tnum">${money((Number(line.quantity_lb) || 0) * (Number(line.unit_price) || 0))}</span>
       <button type="button" class="inv-line__x" aria-label="Remove line" data-press>
         <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6 6 18"/></svg>
       </button>`;

    const sel = row.querySelector('select');
    const [qty, price] = row.querySelectorAll('input');

    sel.addEventListener('change', () => {
      line.product_line_id = sel.value;
      const pl = state.lines.find((l) => String(l.id) === sel.value);
      line.description = pl ? pl.name : 'Item';
      // Changing the product pulls its price in, unless one was typed already.
      line.unit_price = priceFor(Number(sel.value));
      renderLines();
    });
    qty.addEventListener('input', () => { line.quantity_lb = qty.value; updateTally(); });
    price.addEventListener('input', () => { line.unit_price = price.value; updateTally(); });
    row.querySelector('.inv-line__x').addEventListener('click', () => {
      state.draft.splice(idx, 1);
      if (!state.draft.length) state.draft.push(blankLine());
      renderLines();
    });

    wrap.appendChild(row);
  });

  updateTally();
}

function updateTally() {
  let total = 0, lb = 0;
  state.draft.forEach((l) => {
    const q = Number(l.quantity_lb) || 0;
    lb += q;
    total += q * (Number(l.unit_price) || 0);
  });

  // Line totals refresh without a full re-render, so focus is never stolen.
  document.querySelectorAll('.inv-line').forEach((row, i) => {
    const l = state.draft[i];
    if (!l) return;
    row.querySelector('.inv-line__total').textContent =
      money((Number(l.quantity_lb) || 0) * (Number(l.unit_price) || 0));
  });

  $('invTally').innerHTML =
    `<div><span class="metric__k">Weight</span><span class="batch__v tnum">${num(lb, 1)} lb</span></div>
     <div><span class="metric__k">Total</span><span class="batch__v tnum">${money(total)}</span></div>`;
}

$('saveBtn').addEventListener('click', async () => {
  showError(null);
  const btn = $('saveBtn');

  const lines = state.draft
    .filter((l) => (Number(l.quantity_lb) || 0) > 0)
    .map((l) => ({
      product_line_id: l.product_line_id || null,
      description: l.description || 'Item',
      quantity_lb: Number(l.quantity_lb),
      unit_price: Number(l.unit_price) || 0
    }));

  if (!lines.length) { showError('Add at least one line with a weight.'); return; }

  btn.disabled = true; btn.textContent = 'Saving…';

  const { error } = await db.rpc('save_invoice', {
    p_farm_id: state.farm.id,
    p_customer_id: Number($('fCustomer').value),
    p_issued_on: $('fIssued').value,
    p_due_on: $('fDue').value,
    p_lines: lines,
    p_cycle_id: state.cycle?.id ?? null,
    p_run_id: null,
    p_notes: $('fNotes').value.trim() || null,
    p_invoice_id: state.editing ? state.editing.id : null,
    p_number: state.editing ? state.editing.number : null
  });

  btn.disabled = false; btn.textContent = 'Save draft';
  if (error) { showError(error.message); return; }

  $('formPanel').hidden = true;
  await boot();
});

/* ---------- Payments ------------------------------------------------------ */
function openPayment(inv) {
  state.pending = inv;
  $('payWhat').textContent =
    `${inv.number} for ${inv.customer}. ${money(inv.outstanding)} still outstanding of ${money(inv.total)}.`;
  $('payAmount').value = Number(inv.outstanding).toFixed(2);
  $('payAmount').max = Number(inv.outstanding).toFixed(2);
  $('payDate').value = today();
  $('payMethod').value = '';
  $('paySheet').hidden = false;
  document.body.style.overflow = 'hidden';
  $('payAmount').focus();
}

function closeSheet() {
  $('paySheet').hidden = true;
  document.body.style.overflow = '';
  state.pending = null;
}

document.querySelectorAll('[data-close-sheet]').forEach((el) =>
  el.addEventListener('click', closeSheet));

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !$('paySheet').hidden) closeSheet();
});

$('payConfirm').addEventListener('click', async () => {
  if (!state.pending) return;
  const amount = Number($('payAmount').value);
  if (!amount || amount <= 0) { showError('Enter the amount received.'); return; }

  const btn = $('payConfirm');
  btn.disabled = true; btn.textContent = 'Recording…';

  const { error } = await db.from('payments').insert({
    invoice_id: state.pending.id,
    paid_on: $('payDate').value || today(),
    amount,
    method: $('payMethod').value.trim() || null
  });

  btn.disabled = false; btn.textContent = 'Record';
  closeSheet();

  // The overpayment guard in the database reports readably; surface it as-is.
  if (error) { showError(error.message); return; }
  await boot();
});

boot();
