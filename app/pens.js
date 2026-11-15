/* =============================================================================
   Roost — pens

   A pen is a house (030): each holds one flock at a time, and different pens
   run their own flocks side by side. This is where pens are added, renamed
   and retired, and where a pen is put under contract.

   A contract pen's buyer takes the birds live — per lb, per kg or per bird —
   and may supply the chicks and/or the feed, either deducted from the payout
   or simply covered. The terms are saved through save_pen_contract, which
   holds the one rule that matters: terms a finished flock was raised under
   are never rewritten; changing them starts a new contract.

   Everyone on the farm can see the pens. Only an owner changes them — the
   database enforces that; hiding the buttons is courtesy.
   ========================================================================== */

import {
  db, isConfigured, $, today, daysBetween, banner, myRole, loadPens, selectPen, contractPriceText
} from './db.js';

const screens = { setup: $('setupScreen'), auth: $('authScreen'), app: $('appScreen') };
const show = (n) => Object.entries(screens).forEach(([k, el]) => { el.hidden = k !== n; });
const showError = (m) => banner($('appError'), $('appErrorText'), m);
const showOk = (m) => banner($('appOk'), $('appOkText'), m);

if (!isConfigured) { show('setup'); throw new Error('Supabase is not configured'); }

const state = { farm: null, isOwner: false, pens: [], customers: [], editing: null, basis: 'per_lb', deduct: true };

const num = (n) => Number(n ?? 0).toLocaleString('en-US');
const UNIT = { per_lb: 'per lb', per_kg: 'per kg', per_bird: 'per bird' };

/* ---------- Load ---------------------------------------------------------- */
async function boot() {
  const { data: { session } } = await db.auth.getSession();
  if (!session) { show('auth'); return; }
  show('app');
  showError(null);

  state.isOwner = (await myRole()) === 'owner';

  const { data: farms } = await db.from('farms').select('id, name').order('id').limit(1);
  if (!farms || !farms.length) { showError('No farm is linked to this account yet.'); return; }
  state.farm = farms[0];
  $('farmName').textContent = state.farm.name;

  const [pens, customers] = await Promise.all([
    loadPens(),
    db.from('customers').select('id, name').eq('active', true).order('name')
  ]);

  if (pens === null) {
    showError('This screen needs migration 030. Run backend/migrations/030_pens_contracts.sql in Supabase.');
    $('penList').textContent = '';
    return;
  }

  state.pens = pens;
  state.customers = customers.data || [];
  $('buyerList').innerHTML = '';
  state.customers.forEach((c) => {
    const o = document.createElement('option');
    o.value = c.name;
    $('buyerList').appendChild(o);
  });

  renderPens();
  $('addPanel').hidden = !state.isOwner;
}

/* ---------- The list ------------------------------------------------------ */
function termsList(p) {
  const items = [`Pays ${contractPriceText(p)}`];
  const supplies = [];
  if (p.buyer_supplies_chicks) {
    supplies.push(p.chick_charge != null ? `chicks at $${Number(p.chick_charge).toFixed(2)} each` : 'chicks');
  }
  if (p.buyer_supplies_feed) supplies.push('feed, charged per delivery');
  if (supplies.length) {
    items.push(`Supplies the ${supplies.join(' and the ')}`);
    items.push(p.inputs_deducted
      ? 'What they supply is deducted from your payout'
      : 'What they supply is covered by the buyer');
  } else {
    items.push('You supply the chicks and the feed');
  }
  if (p.contract_notes) items.push(p.contract_notes);
  return items;
}

function button(label, onClick, danger = false) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = danger ? 'chip-btn chip-btn--danger' : 'chip-btn';
  b.setAttribute('data-press', '');
  b.textContent = label;
  b.addEventListener('click', () => onClick(b));
  return b;
}

/* Two taps for anything that ends something, the same as everywhere else. */
function confirmButton(label, askLabel, action) {
  let armed = null;
  return button(label, async (b) => {
    if (!armed) {
      b.textContent = askLabel;
      armed = setTimeout(() => { armed = null; b.textContent = label; }, 4000);
      return;
    }
    clearTimeout(armed);
    b.disabled = true;
    await action();
  }, true);
}

function renderPens() {
  const wrap = $('penList');
  wrap.textContent = '';

  state.pens.forEach((p) => {
    const card = document.createElement('article');
    card.className = 'batch';

    const head = document.createElement('div');
    head.className = 'batch__head';
    const title = document.createElement('div');
    const name = document.createElement('div');
    name.className = 'batch__name';
    name.textContent = p.name;
    const meta = document.createElement('div');
    meta.className = 'batch__meta';
    if (p.cycle_id) {
      const day = Math.max(1, daysBetween(p.placed_on, today()) + 1);
      meta.textContent = `${p.cycle_label} · day ${Math.min(day, p.target_sale_age)} of ${p.target_sale_age} · ` +
        `${num(p.birds_alive ?? p.birds_placed)} birds`;
    } else {
      meta.textContent = 'Empty — no flock in it';
    }
    title.append(name, meta);
    const badge = document.createElement('span');
    badge.className = p.contract_id ? 'pen-badge pen-badge--contract' : 'pen-badge';
    badge.textContent = p.contract_id ? 'Under contract' : 'Your own';
    head.append(title, badge);
    card.appendChild(head);

    if (p.contract_id) {
      const who = document.createElement('p');
      who.style.cssText = 'margin:.75rem 0 0;font-weight:600';
      who.textContent = p.buyer_name;
      const ul = document.createElement('ul');
      ul.className = 'pen-terms';
      termsList(p).forEach((t) => {
        const li = document.createElement('li');
        li.textContent = t;      // buyer name and notes are typed text — never markup
        ul.appendChild(li);
      });
      card.append(who, ul);
    }

    const actions = document.createElement('div');
    actions.className = 'pen-actions';

    if (p.cycle_id) {
      actions.appendChild(button('Open this pen', () => {
        selectPen(p.house_id);
        window.location.href = 'index.html?flock=1';
      }));
    } else if (state.isOwner) {
      actions.appendChild(button('Start a cycle', () => {
        window.location.href = `start.html?pen=${p.house_id}`;
      }));
    }

    if (state.isOwner) {
      actions.appendChild(button(p.contract_id ? 'Change contract' : 'Put under contract', () => openContract(p)));
      if (p.contract_id) {
        actions.appendChild(confirmButton('End contract', 'End it?', async () => {
          showError(null); showOk(null);
          const { error } = await db.rpc('end_pen_contract', { p_house_id: p.house_id });
          if (error) { showError(error.message); await boot(); return; }
          showOk(p.cycle_id
            ? `Contract ended. ${p.cycle_label} stays on it; the next flock in ${p.name} is your own.`
            : `Contract ended. ${p.name} is your own again.`);
          await boot();
        }));
      }
      actions.appendChild(button('Rename', () => renamePen(p)));
      // A pen with history is retired, never deleted — its past flocks still
      // need somewhere to point. One that never held a flock just goes.
      if (!p.cycle_id && state.pens.length > 1) {
        actions.appendChild(confirmButton('Remove', 'Remove it?', async () => {
          showError(null); showOk(null);
          const q = Number(p.cycles_total) > 0
            ? db.from('houses').update({ active: false }).eq('id', p.house_id)
            : db.from('houses').delete().eq('id', p.house_id);
          const { error } = await q;
          if (error) { showError(error.message); await boot(); return; }
          showOk(Number(p.cycles_total) > 0
            ? `${p.name} retired. Its past flocks are still in Batches.`
            : `${p.name} removed.`);
          await boot();
        }));
      }
    }

    if (actions.children.length) card.appendChild(actions);
    wrap.appendChild(card);
  });
}

/* ---------- Add and rename ------------------------------------------------- */
$('addPenBtn').addEventListener('click', async () => {
  showError(null); showOk(null);
  const name = $('penName').value.trim();
  if (!name) { showError('Give the pen a name.'); return; }

  const btn = $('addPenBtn');
  btn.disabled = true; btn.textContent = 'Adding…';
  const { error } = await db.from('houses').insert({ farm_id: state.farm.id, name });
  btn.disabled = false; btn.textContent = 'Add pen';

  if (error) {
    showError(error.message.includes('duplicate') ? `There is already a pen called ${name}.` : error.message);
    return;
  }
  $('penName').value = '';
  showOk(`${name} added. Start a cycle in it, or put it under contract first.`);
  await boot();
});

async function renamePen(p) {
  const name = (window.prompt('New name for this pen', p.name) || '').trim();
  if (!name || name === p.name) return;
  showError(null); showOk(null);
  const { error } = await db.from('houses').update({ name }).eq('id', p.house_id);
  if (error) {
    showError(error.message.includes('duplicate') ? `There is already a pen called ${name}.` : error.message);
    return;
  }
  await boot();
}

/* ---------- Contract form -------------------------------------------------- */
function setSegment(name, value) {
  document.querySelectorAll(`[data-segment="${name}"] button`).forEach((b) =>
    b.setAttribute('aria-pressed', String(b.getAttribute('data-value') === String(value))));
}
function wireSegment(name, onPick) {
  document.querySelectorAll(`[data-segment="${name}"] button`).forEach((btn) => {
    btn.addEventListener('click', () => { setSegment(name, btn.getAttribute('data-value')); onPick(btn.getAttribute('data-value')); });
  });
}
wireSegment('basis', (v) => { state.basis = v; syncContractForm(); });
wireSegment('deduct', (v) => { state.deduct = v === 'true'; syncContractForm(); });
['kChicks', 'kFeed'].forEach((id) => $(id).addEventListener('change', syncContractForm));
['kBuyer', 'kPrice', 'kChickCharge'].forEach((id) => $(id).addEventListener('input', syncContractForm));

/* Shows only the questions that apply, and says the deal back in one
   sentence so a wrong tick is caught before it is saved. */
function syncContractForm() {
  const chicks = $('kChicks').checked, feed = $('kFeed').checked;
  $('kPriceUnit').textContent = UNIT[state.basis];
  $('kChickRow').hidden = !chicks;
  $('kFeedHint').hidden = !feed;
  $('kDeductRow').hidden = !(chicks || feed);

  const buyer = $('kBuyer').value.trim() || 'The buyer';
  const price = Number($('kPrice').value);
  let s = `${buyer} pays $${(price || 0).toFixed(2)} ${UNIT[state.basis]}${state.basis === 'per_bird' ? '' : ' live weight'}`;
  if (chicks || feed) {
    const what = [chicks && 'chicks', feed && 'feed'].filter(Boolean).join(' and ');
    s += `, supplies the ${what}, and ${state.deduct ? 'takes their cost off your payout' : 'covers their cost'}.`;
  } else {
    s += '. You supply the chicks and the feed.';
  }
  $('kSummary').textContent = s;
}

function openContract(p) {
  state.editing = p;
  showError(null); showOk(null);

  $('contractTitle').textContent = `Contract for ${p.name}`;
  $('contractIntro').textContent = p.contract_id
    ? (p.cycle_id
        ? `Changes apply to ${p.cycle_label}, in the pen now, and every flock after it.`
        : 'Changes apply from the next flock in this pen.')
    : (p.cycle_id
        ? `${p.cycle_label} is in this pen now and will come under this contract.`
        : 'The next flock started in this pen comes under this contract.');

  $('kBuyer').value = p.buyer_name || '';
  $('kPrice').value = p.price != null ? Number(p.price) : '';
  $('kChicks').checked = !!p.buyer_supplies_chicks;
  $('kChickCharge').value = p.chick_charge != null ? Number(p.chick_charge) : '';
  $('kFeed').checked = !!p.buyer_supplies_feed;
  $('kNotes').value = p.contract_notes || '';
  state.basis = p.price_basis || 'per_lb';
  state.deduct = p.contract_id ? !!p.inputs_deducted : true;
  setSegment('basis', state.basis);
  setSegment('deduct', state.deduct);
  syncContractForm();

  $('contractPanel').hidden = false;
  $('contractPanel').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

$('kCancelBtn').addEventListener('click', () => { $('contractPanel').hidden = true; state.editing = null; });

$('kSaveBtn').addEventListener('click', async () => {
  showError(null); showOk(null);
  const p = state.editing;
  if (!p) return;

  const buyer = $('kBuyer').value.trim();
  const price = Number($('kPrice').value);
  const chicks = $('kChicks').checked, feed = $('kFeed').checked;
  const chickCharge = $('kChickCharge').value === '' ? null : Number($('kChickCharge').value);

  if (!buyer) { showError('Say who the buyer is.'); return; }
  if ($('kPrice').value === '' || !(price >= 0)) { showError('Enter the price they pay.'); return; }
  if (chicks && state.deduct && chickCharge === null) {
    showError('Enter what the buyer charges per chick — it is what comes off your payout.');
    return;
  }

  const customer = state.customers.find((c) => c.name.toLowerCase() === buyer.toLowerCase());

  const btn = $('kSaveBtn');
  btn.disabled = true; btn.textContent = 'Saving…';
  const { error } = await db.rpc('save_pen_contract', {
    p_house_id: p.house_id,
    p_buyer_name: customer ? customer.name : buyer,
    p_price_basis: state.basis,
    p_price: price,
    p_buyer_supplies_chicks: chicks,
    p_chick_charge: chickCharge,
    p_buyer_supplies_feed: feed,
    p_inputs_deducted: state.deduct,
    p_customer_id: customer ? customer.id : null,
    p_notes: $('kNotes').value.trim() || null
  });
  btn.disabled = false; btn.textContent = 'Save contract';

  if (error) { showError(error.message); return; }

  $('contractPanel').hidden = true;
  state.editing = null;
  showOk(`${p.name} is under contract to ${buyer}.`);
  await boot();
  window.scrollTo({ top: 0, behavior: 'smooth' });
});

boot();
