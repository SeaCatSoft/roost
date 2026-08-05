/* =============================================================================
   Roost — customers
   Who buys the birds, and what each of them still owes.
   ========================================================================== */

import { db, isConfigured, $, banner, myRole, canEdit } from './db.js';

const screens = { setup: $('setupScreen'), auth: $('authScreen'), app: $('appScreen') };
const show = (n) => Object.entries(screens).forEach(([k, el]) => { el.hidden = k !== n; });
const showError = (m) => banner($('appError'), $('appErrorText'), m);

if (!isConfigured) { show('setup'); throw new Error('Supabase is not configured'); }

const state = { farm: null, rows: [], editing: null, readOnly: false };

const num = (n, d = 0) =>
  Number(n ?? 0).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
const money = (v) => '$' + num(Math.abs(Number(v ?? 0)), 2);

async function boot() {
  const { data: { session } } = await db.auth.getSession();
  if (!session) { show('auth'); return; }
  show('app');
  showError(null);

  const { data: farms } = await db.from('farms').select('id, name').limit(1);
  if (!farms || !farms.length) { showError('No farm is linked to this account yet.'); return; }
  state.farm = farms[0];
  $('farmName').textContent = state.farm.name;

  const { data, error } = await db
    .from('v_customer_balances')
    .select('*')
    .order('name');

  if (error) {
    showError(error.message.includes('does not exist')
      ? 'This screen needs migration 012. Run backend/migrations/012_sales.sql in Supabase.'
      : `Could not load customers: ${error.message}`);
    return;
  }

  state.rows = data || [];
  state.readOnly = !canEdit(await myRole());
  $('addBtn').disabled = state.readOnly;

  renderTotals();
  renderList();
}

function renderTotals() {
  $('cCount').textContent = num(state.rows.filter((r) => r.active).length);
  $('cInvoiced').textContent = money(state.rows.reduce((a, r) => a + Number(r.invoiced || 0), 0));

  const out = state.rows.reduce((a, r) => a + Number(r.outstanding || 0), 0);
  const el = $('cOutstanding');
  el.textContent = money(out);
  el.style.color = out > 0 ? 'var(--warn)' : '';
}

function renderList() {
  const wrap = $('list');
  wrap.textContent = '';

  if (!state.rows.length) {
    wrap.innerHTML = '<p class="caption">No customers yet. Add the first one above.</p>';
    return;
  }

  state.rows.forEach((c) => {
    const card = document.createElement('article');
    card.className = 'batch';

    const overdue = c.worst_overdue > 0;
    card.innerHTML =
      `<div class="batch__head">
         <div>
           <div class="batch__name">${c.name}${c.active ? '' : ' <span class="batch__tag">inactive</span>'}</div>
           <div class="batch__meta">${[c.email, c.phone].filter(Boolean).join(' · ') || 'No contact details'} · ${c.payment_terms_days} day terms</div>
         </div>
       </div>
       <div class="batch__grid">
         <div><span class="metric__k">Invoices</span><span class="batch__v tnum">${num(c.invoices)}</span></div>
         <div><span class="metric__k">Invoiced</span><span class="batch__v tnum">${money(c.invoiced)}</span></div>
         <div><span class="metric__k">Paid</span><span class="batch__v tnum">${money(c.paid)}</span></div>
         <div><span class="metric__k">Outstanding</span><span class="batch__v tnum" style="color:${Number(c.outstanding) > 0 ? 'var(--warn)' : 'inherit'}">${money(c.outstanding)}</span></div>
       </div>
       ${overdue ? `<div class="batch__foot caption" style="color:var(--warn)">Oldest unpaid invoice is ${num(c.worst_overdue)} days past due.</div>` : ''}`;

    if (!state.readOnly) {
      const actions = document.createElement('div');
      actions.className = 'person__actions';
      actions.style.marginTop = '.9rem';

      const edit = document.createElement('button');
      edit.type = 'button'; edit.className = 'chip-btn'; edit.setAttribute('data-press', '');
      edit.textContent = 'Edit';
      edit.addEventListener('click', () => openForm(c));
      actions.appendChild(edit);

      const inv = document.createElement('a');
      inv.className = 'chip-btn';
      inv.setAttribute('data-press', '');
      inv.href = `invoices.html?customer=${c.customer_id}`;
      inv.textContent = 'Invoice';
      actions.appendChild(inv);

      card.appendChild(actions);
    }

    wrap.appendChild(card);
  });
}

/* ---------- Form ---------------------------------------------------------- */
$('addBtn').addEventListener('click', () => openForm(null));
$('cancelBtn').addEventListener('click', () => { $('formPanel').hidden = true; });

function openForm(c) {
  state.editing = c;
  $('formTitle').textContent = c ? `Edit ${c.name}` : 'Add a customer';
  $('fName').value = c?.name ?? '';
  $('fEmail').value = c?.email ?? '';
  $('fPhone').value = c?.phone ?? '';
  $('fTerms').value = c?.payment_terms_days ?? 30;
  $('formPanel').hidden = false;
  $('fName').focus();
}

$('saveBtn').addEventListener('click', async () => {
  const name = $('fName').value.trim();
  if (!name) { showError('Give the customer a name.'); return; }

  const btn = $('saveBtn');
  btn.disabled = true; btn.textContent = 'Saving…';
  showError(null);

  const row = {
    farm_id: state.farm.id,
    name,
    email: $('fEmail').value.trim() || null,
    phone: $('fPhone').value.trim() || null,
    payment_terms_days: parseInt($('fTerms').value, 10) || 30
  };

  const { error } = state.editing
    ? await db.from('customers').update(row).eq('id', state.editing.customer_id)
    : await db.from('customers').insert(row);

  btn.disabled = false; btn.textContent = 'Save';

  if (error) {
    showError(error.message.includes('duplicate')
      ? `You already have a customer called ${name}.`
      : error.message);
    return;
  }

  $('formPanel').hidden = true;
  await boot();
});

boot();
