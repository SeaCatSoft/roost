/* =============================================================================
   Roost — orders

   Orders are taken by whoever answers the phone, so this is open to members as
   well as owners. Billing for one is not: turning an order into an invoice
   writes to the invoices table, and only an owner may do that (016). The
   button is shown to owners only, and the database refuses it regardless.

   Quantities follow the pattern invoicing already uses — whole birds counted,
   cut parts weighed — so an order converts to an invoice without reinterpreting
   anything.

   Stock is checked as a warning, never a block. A wholesale order placed before
   the birds are processed is a normal thing to take, and refusing it would make
   the order book useless for exactly the case it exists for.
   ========================================================================== */

import { db, isConfigured, $, today, banner, myRole, canEdit } from './db.js';

const screens = { setup: $('setupScreen'), auth: $('authScreen'), app: $('appScreen') };
const show = (n) => Object.entries(screens).forEach(([k, el]) => { el.hidden = k !== n; });
const showError = (m) => banner($('appError'), $('appErrorText'), m);
const showOk = (m) => banner($('appOk'), $('appOkText'), m);

if (!isConfigured) { show('setup'); throw new Error('Supabase is not configured'); }

const state = {
  farm: null, customers: [], products: [], mix: [], stock: [],
  orders: [], filter: 'open', editing: null, draft: [],
  readOnly: false, isOwner: false
};

const num = (n, d = 0) =>
  Number(n ?? 0).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
const money = (v) => '$' + num(Math.abs(Number(v ?? 0)), 2);
const shortDate = (iso) => iso
  ? new Date(iso + 'T00:00:00').toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })
  : '—';

const addDays = (iso, days) => {
  const d = new Date(iso + 'T00:00:00');
  d.setDate(d.getDate() + days);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

const isWhole = (id) => !!state.products.find((p) => p.id === Number(id))?.is_whole_bird;
const priceFor = (id) => Number(state.mix.find((m) => m.product_line_id === Number(id))?.price_per_lb ?? 0);
const stockFor = (id) => state.stock.find((s) => s.product_line_id === Number(id)) || null;

/* ---------- Load ---------------------------------------------------------- */
async function boot() {
  const { data: { session } } = await db.auth.getSession();
  if (!session) { show('auth'); return; }
  show('app');
  showError(null);

  const role = await myRole();
  state.readOnly = !canEdit(role);
  state.isOwner = role === 'owner';

  const { data: farms } = await db.from('farms').select('id, name').order('id').limit(1);
  if (!farms || !farms.length) { showError('No farm is linked to this account yet.'); return; }
  state.farm = farms[0];
  $('farmName').textContent = state.farm.name;

  const { data: cycles } = await db.from('cycles').select('id')
    .is('closed_at', null).order('placed_on', { ascending: false }).limit(1);
  const openCycle = cycles && cycles.length ? cycles[0].id : null;

  const [customers, products, orders, book, stock, mix] = await Promise.all([
    db.from('customers').select('id, name, payment_terms_days').eq('active', true).order('name'),
    db.from('product_lines').select('*').order('sort_order'),
    db.from('v_orders').select('*').order('needed_by', { ascending: true, nullsFirst: false }),
    db.from('v_order_book').select('*').maybeSingle(),
    db.from('v_stock').select('*').order('sort_order'),
    openCycle
      ? db.from('cycle_product_mix').select('*').eq('cycle_id', openCycle)
      : Promise.resolve({ data: [] })
  ]);

  if (orders.error) {
    showError(orders.error.message.includes('does not exist')
      ? 'This screen needs migration 017. Run backend/migrations/017_orders_stock.sql in Supabase.'
      : `Could not load orders: ${orders.error.message}`);
    return;
  }

  state.customers = customers.data || [];
  state.products = products.data || [];
  state.orders = orders.data || [];
  state.stock = stock.data || [];
  state.mix = mix.data || [];

  $('newBtn').disabled = state.readOnly || !state.customers.length || !state.products.length;

  renderBook(book.data);
  renderList();

  if (!state.customers.length) showError('Add a customer before taking an order.');
}

/* ---------- The book ------------------------------------------------------ */
function renderBook(b) {
  $('bookStats').innerHTML =
    `<div><div class="metric__k">Confirmed</div><div class="metric__v tnum">${money(b?.confirmed_value)}</div></div>
     <div><div class="metric__k">Orders open</div><div class="metric__v tnum">${num((b?.confirmed ?? 0) + (b?.drafts ?? 0))}</div></div>
     <div><div class="metric__k">Late</div><div class="metric__v tnum" style="color:${
       Number(b?.overdue ?? 0) > 0 ? 'var(--warn)' : 'inherit'}">${num(b?.overdue)}</div></div>`;

  const parts = [];
  if (Number(b?.confirmed_lb ?? 0) > 0) {
    parts.push(`${num(b.confirmed_lb, 1)} lb promised on confirmed orders.`);
  }
  if (b?.next_needed_by) parts.push(`Next one due ${shortDate(b.next_needed_by)}.`);
  if (Number(b?.drafts ?? 0) > 0) {
    parts.push(`${num(b.drafts)} still a draft — a draft holds no stock and nobody is expecting it.`);
  }
  $('bookNote').textContent = parts.join(' ') || 'Nothing on order.';
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

const TONE = { draft: 'muted', confirmed: 'warn', fulfilled: 'ok', cancelled: 'muted' };

function renderList() {
  const wrap = $('list');
  wrap.textContent = '';

  const rows = state.filter === 'open'
    ? state.orders.filter((o) => o.status === 'draft' || o.status === 'confirmed')
    : state.orders;

  if (!rows.length) {
    wrap.innerHTML = `<p class="caption">${
      state.filter === 'open' ? 'Nothing on order.' : 'No orders yet.'}</p>`;
    return;
  }

  rows.forEach((o) => {
    const card = document.createElement('article');
    card.className = 'batch';

    card.innerHTML =
      `<div class="batch__head">
         <div>
           <div class="batch__name">${o.number}
             <span class="inv-state inv-state--${TONE[o.status] || 'muted'}">${o.status}</span>
           </div>
           <div class="batch__meta">${o.customer} · taken ${shortDate(o.placed_on)}${
             o.needed_by ? ` · needed ${shortDate(o.needed_by)}` : ''}</div>
         </div>
       </div>
       <div class="batch__grid">
         <div><span class="metric__k">Value</span><span class="batch__v tnum">${money(o.total)}</span></div>
         <div><span class="metric__k">Weight</span><span class="batch__v tnum">${
           Number(o.total_lb) > 0 ? num(o.total_lb, 1) + ' lb' : '—'}</span></div>
         <div><span class="metric__k">Birds</span><span class="batch__v tnum">${
           Number(o.total_units) > 0 ? num(o.total_units) : '—'}</span></div>
         <div><span class="metric__k">Due in</span><span class="batch__v tnum" style="color:${
           o.overdue ? 'var(--warn)' : 'inherit'}">${
           o.days_until_needed == null ? '—'
             : o.overdue ? `${num(Math.abs(o.days_until_needed))}d late`
             : `${num(o.days_until_needed)}d`}</span></div>
       </div>` +
      (o.invoice_number
        ? `<p class="caption" style="margin-top:.6rem">Invoiced as ${o.invoice_number}.</p>`
        : '');

    if (!state.readOnly) {
      const actions = document.createElement('div');
      actions.className = 'person__actions';
      actions.style.marginTop = '.9rem';

      if (o.status === 'draft') {
        actions.appendChild(chip('Confirm', () => setStatus(o, 'confirmed'), true));
        actions.appendChild(chip('Edit', () => openForm(o)));
      }
      if (o.status === 'confirmed') {
        actions.appendChild(chip('Mark fulfilled', () => fulfil(o), true));
        actions.appendChild(chip('Edit', () => openForm(o)));
      }
      // Billing is the owner's, per 016. Hidden rather than shown and refused.
      if (o.status === 'fulfilled' && !o.invoice_id && state.isOwner) {
        actions.appendChild(chip('Create invoice', () => makeInvoice(o), true));
      }
      if (o.status !== 'cancelled' && o.status !== 'fulfilled') {
        actions.appendChild(chip('Cancel', () => setStatus(o, 'cancelled'), false, true));
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

async function setStatus(order, status) {
  showError(null); showOk(null);
  const { error } = await db.from('orders').update({ status }).eq('id', order.id);
  if (error) { showError(error.message); return; }
  await boot();
}

async function fulfil(order) {
  showError(null); showOk(null);
  const { error } = await db.rpc('fulfil_order', { p_order_id: order.id });
  if (error) { showError(error.message); return; }
  showOk(`${order.number} fulfilled. Stock has come down by what went out.`);
  await boot();
}

async function makeInvoice(order) {
  showError(null); showOk(null);
  const { error } = await db.rpc('invoice_from_order', { p_order_id: order.id });
  if (error) {
    showError(error.message.match(/policy|permission|denied/i)
      ? 'Only an owner can raise an invoice.'
      : error.message);
    return;
  }
  showOk(`Invoice drafted from ${order.number}. It stays a draft until you send it.`);
  await boot();
}

/* ---------- The form ------------------------------------------------------ */
$('newBtn').addEventListener('click', () => openForm(null));
$('cancelBtn').addEventListener('click', () => { $('formPanel').hidden = true; });
$('addLineBtn').addEventListener('click', () => { state.draft.push(blankLine()); renderLines(); });

function blankLine() {
  const first = state.products[0];
  return {
    product_line_id: first ? String(first.id) : '',
    quantity: '',
    unit_price: first ? priceFor(first.id) : 0
  };
}

async function openForm(order) {
  state.editing = order;
  $('formTitle').textContent = order ? `Edit ${order.number}` : 'New order';

  const sel = $('fCustomer');
  sel.textContent = '';
  state.customers.forEach((c) => {
    const o = document.createElement('option');
    o.value = c.id; o.textContent = c.name;
    sel.appendChild(o);
  });
  if (order) sel.value = order.customer_id;

  $('fPlaced').value = order ? order.placed_on : today();
  $('fNeeded').value = order?.needed_by || addDays(today(), 7);
  $('fNotes').value = order?.notes ?? '';

  if (order) {
    const { data } = await db.from('order_lines')
      .select('product_line_id, quantity_lb, units, unit_price')
      .eq('order_id', order.id).order('sort_order');
    state.draft = (data || []).map((l) => ({
      product_line_id: String(l.product_line_id),
      quantity: l.quantity_lb ?? l.units ?? '',
      unit_price: Number(l.unit_price)
    }));
  } else {
    state.draft = [blankLine()];
  }

  renderLines();
  $('formPanel').hidden = false;
  $('formPanel').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function renderLines() {
  const wrap = $('lineRows');
  wrap.textContent = '';

  state.draft.forEach((line, idx) => {
    const whole = isWhole(line.product_line_id);
    const row = document.createElement('div');
    row.className = 'inv-line';

    const opts = state.products.map((p) =>
      `<option value="${p.id}"${String(p.id) === line.product_line_id ? ' selected' : ''}>${p.name}</option>`
    ).join('');

    row.innerHTML =
      `<span class="setting__input inv-line__prod">
         <select aria-label="Product">${opts}</select>
       </span>
       <span class="setting__input inv-line__qty">
         <input type="number" inputmode="decimal" min="0" step="${whole ? '1' : '0.01'}"
                value="${line.quantity}" aria-label="${whole ? 'Number of birds' : 'Pounds'}">
         <span class="setting__unit">${whole ? 'ea' : 'lb'}</span>
       </span>
       <span class="setting__input inv-line__price">
         <span class="setting__unit">$</span>
         <input type="number" inputmode="decimal" min="0" step="0.01" value="${line.unit_price}"
                aria-label="Price per ${whole ? 'bird' : 'pound'}">
       </span>
       <span class="inv-line__total tnum">${money((Number(line.quantity) || 0) * (Number(line.unit_price) || 0))}</span>
       <button type="button" class="inv-line__x" aria-label="Remove line" data-press>
         <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6 6 18"/></svg>
       </button>`;

    const sel = row.querySelector('select');
    const [qty, price] = row.querySelectorAll('input');

    sel.addEventListener('change', () => {
      line.product_line_id = sel.value;
      line.unit_price = priceFor(sel.value);
      renderLines();
    });
    qty.addEventListener('input', () => { line.quantity = qty.value; updateTally(); });
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
  let total = 0, lb = 0, birds = 0;
  state.draft.forEach((l) => {
    const q = Number(l.quantity) || 0;
    if (isWhole(l.product_line_id)) birds += q; else lb += q;
    total += q * (Number(l.unit_price) || 0);
  });

  document.querySelectorAll('.inv-line').forEach((row, i) => {
    const l = state.draft[i];
    if (!l) return;
    row.querySelector('.inv-line__total').textContent =
      money((Number(l.quantity) || 0) * (Number(l.unit_price) || 0));
  });

  $('orderTally').innerHTML =
    `<div><span class="metric__k">Birds</span><span class="batch__v tnum">${num(birds)}</span></div>
     <div><span class="metric__k">Weight</span><span class="batch__v tnum">${num(lb, 1)} lb</span></div>
     <div><span class="metric__k">Value</span><span class="batch__v tnum">${money(total)}</span></div>`;

  renderStockWarning();
}

/* A warning, never a block — see the note at the top of this file. */
function renderStockWarning() {
  const short = [];
  state.draft.forEach((l) => {
    const q = Number(l.quantity) || 0;
    if (!q || !l.product_line_id) return;
    const s = stockFor(l.product_line_id);
    if (!s) return;
    const whole = isWhole(l.product_line_id);
    const have = Number(whole ? s.available_units : s.available_lb);
    if (q > have) {
      short.push(`${s.name}: ${num(q, whole ? 0 : 1)} wanted, ${num(Math.max(have, 0), whole ? 0 : 1)} free`);
    }
  });

  const wrap = $('stockWarn');
  wrap.textContent = '';
  if (!short.length) return;

  wrap.innerHTML =
    `<div class="banner banner--warn" style="margin-top:1rem;text-align:left">
       <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M12 8.5v5M12 17h.01"/><circle cx="12" cy="12" r="9.5"/></svg>
       <div>More than is free right now — ${short.join('; ')}. Fine if the
       current cycle will cover it; this is only here so it is never a surprise
       on delivery day.</div>
     </div>`;
}

$('saveBtn').addEventListener('click', async () => {
  showError(null); showOk(null);
  const btn = $('saveBtn');

  const lines = state.draft
    .filter((l) => (Number(l.quantity) || 0) > 0 && l.product_line_id)
    .map((l) => {
      const whole = isWhole(l.product_line_id);
      return {
        product_line_id: Number(l.product_line_id),
        quantity_lb: whole ? null : Number(l.quantity),
        units: whole ? Number(l.quantity) : null,
        unit_price: Number(l.unit_price) || 0
      };
    });

  if (!lines.length) { showError('Add at least one line with a quantity.'); return; }

  btn.disabled = true; btn.textContent = 'Saving…';

  const { error } = await db.rpc('save_order', {
    p_farm_id: state.farm.id,
    p_customer_id: Number($('fCustomer').value),
    p_lines: lines,
    p_needed_by: $('fNeeded').value || null,
    p_placed_on: $('fPlaced').value || today(),
    p_notes: $('fNotes').value.trim() || null,
    p_order_id: state.editing ? state.editing.id : null,
    p_status: state.editing ? state.editing.status : 'draft'
  });

  btn.disabled = false; btn.textContent = 'Save order';
  if (error) { showError(error.message); return; }

  $('formPanel').hidden = true;
  showOk(state.editing ? 'Order updated.' : 'Order saved as a draft. Confirm it when it is agreed.');
  await boot();
});

boot();
