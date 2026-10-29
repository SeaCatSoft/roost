/* =============================================================================
   Roost — feed store

   Nothing here is a stored stock level. v_feed_stock takes the last count of
   each ration, adds deliveries since, and subtracts bags ticked as opened on
   the daily check since (026_feed_stock.sql) — so the figure cannot drift
   from the records behind it. This screen writes only the two things no
   other screen knows about: a delivery arriving, and a count of the store.

   "Still needed" comes from the open cycle's own feed plan, the same
   v_cycle_feed_by_phase the feed screen measures against, so the two screens
   can never disagree about how many bags a ration needs.
   ========================================================================== */

import {
  db, isConfigured, $, today, banner, myRole, canEdit
} from './db.js';
import { loadFeedAlerts, renderFeedAlerts } from './feedalerts.js';

const screens = { setup: $('setupScreen'), auth: $('authScreen'), app: $('appScreen') };
const show = (n) => Object.entries(screens).forEach(([k, el]) => { el.hidden = k !== n; });
const showError = (m) => banner($('appError'), $('appErrorText'), m);
const showOk = (m) => banner($('appOk'), $('appOkText'), m);

if (!isConfigured) { show('setup'); throw new Error('Supabase is not configured'); }

const PHASES = ['Starter', 'Grower', 'Finisher'];

const state = {
  farm: null, cycle: null, assumptions: null, readOnly: false, isOwner: false,
  stock: [], plan: [], openedThisCycle: {}, alerts: []
};

const num = (n, d = 0) =>
  Number(n ?? 0).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
const money = (n) => `$${num(n, 2)}`;
const shortDate = (iso) => iso
  ? new Date(iso + 'T00:00:00').toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
  : '—';
const bagsWord = (n) => `${num(n)} bag${Math.abs(n) === 1 ? '' : 's'}`;

/* ---------- Load ---------------------------------------------------------- */
async function boot() {
  const { data: { session } } = await db.auth.getSession();
  if (!session) { show('auth'); return; }
  show('app');
  showError(null);

  const role = await myRole();
  state.readOnly = !canEdit(role);
  state.isOwner = role === 'owner';

  // '*' rather than a column list: feed_alert_days (027) and
  // feed_alert_email (028) may not exist yet, and each part of the screen
  // that needs one simply stays hidden until it does.
  const { data: farms } = await db.from('farms').select('*').order('id').limit(1);
  if (!farms || !farms.length) { showError('No farm is linked to this account yet.'); return; }
  state.farm = farms[0];
  $('farmName').textContent = state.farm.name;

  // No open cycle is a normal state between flocks: the store still has
  // feed in it, there is just nothing planned to use it against.
  const { data: cycles } = await db.from('cycles')
    .select('id, label').is('closed_at', null)
    .order('placed_on', { ascending: false }).limit(1);
  state.cycle = cycles && cycles.length ? cycles[0] : null;

  const cycleId = state.cycle?.id ?? -1;
  const [stock, plan, opened, assumptions, purchases, counts, alerts] = await Promise.all([
    db.from('v_feed_stock').select('*').eq('farm_id', state.farm.id),
    db.from('v_cycle_feed_by_phase').select('phase, bags').eq('cycle_id', cycleId),
    db.from('feed_bag_openings').select('phase').eq('cycle_id', cycleId),
    db.from('cycle_assumptions')
      .select('bag_size_kg, starter_bag_cost, grower_bag_cost, finisher_bag_cost')
      .eq('cycle_id', cycleId).maybeSingle(),
    db.from('feed_purchases')
      .select('id, phase, purchased_on, bags, bag_size_kg, cost_per_bag, supplier, created_at')
      .eq('farm_id', state.farm.id)
      .order('purchased_on', { ascending: false }).order('id', { ascending: false }).limit(15),
    db.from('feed_stock_counts')
      .select('id, phase, counted_on, bags, created_at')
      .eq('farm_id', state.farm.id)
      .order('counted_on', { ascending: false }).order('id', { ascending: false }).limit(15),
    loadFeedAlerts(state.farm.id)
  ]);

  if (stock.error) {
    showError(stock.error.message.includes('does not exist')
      ? 'This screen needs migration 026. Run backend/migrations/026_feed_stock.sql in Supabase.'
      : `Could not load the feed store: ${stock.error.message}`);
    $('list').textContent = '';
    return;
  }

  state.stock = stock.data || [];
  state.alerts = alerts;
  renderFeedAlerts($('feedAlerts'), alerts, { linkToStore: false });
  renderAlertSetting();
  state.plan = plan.data || [];
  state.assumptions = assumptions.data || null;
  state.openedThisCycle = {};
  (opened.data || []).forEach((b) => {
    state.openedThisCycle[b.phase] = (state.openedThisCycle[b.phase] || 0) + 1;
  });

  renderList();

  $('deliveryPanel').hidden = state.readOnly;
  $('countPanel').hidden = state.readOnly;
  if (!state.readOnly) fillForms(purchases.data || []);
  renderRecent(purchases.data || [], counts.data || []);
}

/* ---------- The three rations --------------------------------------------- */
function stillNeeded(phase) {
  if (!state.cycle) return null;
  const planned = state.plan.find((p) => p.phase === phase);
  if (!planned) return null;
  return Math.max(0, Number(planned.bags) - (state.openedThisCycle[phase] || 0));
}

function renderList() {
  const wrap = $('list');
  wrap.textContent = '';

  PHASES.forEach((phase) => {
    const r = state.stock.find((s) => s.phase === phase) || {};
    const onHand = Number(r.on_hand ?? 0);
    const need = stillNeeded(phase);
    const toBuy = need === null ? null : Math.max(0, need - Math.max(0, onHand));

    // Days left only means something for a ration in use and counted —
    // v_feed_alerts (027) decides that, so this never second-guesses it.
    const a = state.alerts.find((x) => x.phase === phase);
    const showDays = a && (a.level === 'ok' || a.level === 'low' || a.level === 'out');
    const daysLeft = showDays ? Number(a.days_left) : null;
    const urgent = a && (a.level === 'low' || a.level === 'out');

    const meta = [
      r.counted_on ? `counted ${shortDate(r.counted_on)}` : 'never counted',
      a && a.bags_per_day ? `using ${num(a.bags_per_day, 1)} a day` : null,
      r.last_bought_on ? `last delivery ${shortDate(r.last_bought_on)}` : null
    ].filter(Boolean).join(' · ');

    const card = document.createElement('article');
    card.className = 'batch';
    card.innerHTML =
      `<div class="batch__head">
         <div>
           <div class="batch__name">${phase}</div>
           <div class="batch__meta">${meta}</div>
         </div>
       </div>
       <div class="batch__grid">
         <div><span class="metric__k">On hand</span><span class="batch__v tnum" style="color:${
           onHand < 0 ? 'var(--warn)' : 'inherit'}">${num(onHand)}</span></div>
         <div><span class="metric__k">Still needed</span><span class="batch__v tnum">${
           need === null ? '—' : num(need)}</span></div>
         <div><span class="metric__k">To buy</span><span class="batch__v tnum" style="color:${
           toBuy ? 'var(--warn)' : toBuy === 0 ? 'var(--accent)' : 'inherit'}">${
           toBuy === null ? '—' : num(toBuy)}</span></div>
         <div><span class="metric__k">Days left</span><span class="batch__v tnum" style="color:${
           urgent ? 'var(--warn)' : 'inherit'}">${
           daysLeft === null ? '—' : num(daysLeft, daysLeft < 3 ? 1 : 0)}</span></div>
       </div>`;

    // Negative is never a real number of bags. It means bags were opened
    // that no count or delivery accounts for — almost always because the
    // store has not been counted since logging began.
    let note = '';
    if (onHand < 0) {
      note = r.counted_on
        ? `${bagsWord(Math.abs(onHand))} more opened than counted or delivered since ${
            shortDate(r.counted_on)}. A delivery may be missing — or count the store again.`
        : 'Bags have been opened with no count or delivery behind them. Count the store below to set the starting point.';
    } else if (toBuy) {
      note = `Order ${bagsWord(toBuy)} of ${phase.toLowerCase()} to finish ${state.cycle.label}.`;
    }
    if (note) {
      card.insertAdjacentHTML('beforeend',
        `<p class="caption" style="margin-top:.6rem;color:var(--warn)">${note}</p>`);
    }

    wrap.appendChild(card);
  });

  if (!state.cycle) {
    wrap.insertAdjacentHTML('beforeend',
      '<p class="caption" style="margin-top:.75rem">No open cycle, so there is no plan to say what is still needed.</p>');
  }
}

/* ---------- Warning window ------------------------------------------------- */
/* Owner-set (farms_write, 009). Everyone else is told what it is, so a member
   seeing "low" knows what low means here. Hidden entirely before 027. */
function renderAlertSetting() {
  const days = state.farm.feed_alert_days;
  $('alertPanel').hidden = days == null;
  if (days == null) return;

  $('alertEdit').hidden = !state.isOwner;
  $('alertBtn').hidden = !state.isOwner;
  $('alertDays').value = days;
  if (!state.isOwner) {
    $('alertExplain').textContent =
      `A ration is flagged low when the bags left, at the last week's average use, ` +
      `will not last ${days} day${days === 1 ? '' : 's'}. The farm owner sets this.`;
  }

  const email = state.farm.feed_alert_email;
  $('emailRow').hidden = !state.isOwner || email == null;
  if (email != null) $('alertEmail').checked = email;
  renderLastEmail();
}

async function renderLastEmail() {
  const el = $('lastEmail');
  el.textContent = '';
  if (!state.isOwner || state.farm.feed_alert_email == null) return;
  const { data } = await db.from('feed_alert_emails')
    .select('sent_on, phase, level').eq('farm_id', state.farm.id)
    .order('created_at', { ascending: false }).limit(1);
  el.textContent = data && data.length
    ? `Last emailed ${shortDate(data[0].sent_on)}: ${data[0].phase.toLowerCase()} ${data[0].level}.`
    : 'No alert emailed yet.';
}

$('alertEmail').addEventListener('change', async () => {
  showError(null); showOk(null);
  const on = $('alertEmail').checked;
  const { error } = await db.from('farms').update({ feed_alert_email: on }).eq('id', state.farm.id);
  if (error) { $('alertEmail').checked = !on; showError(error.message); return; }
  state.farm.feed_alert_email = on;
  showOk(on ? 'Owners will be emailed when feed runs low.' : 'Low-feed emails are off. The alerts still show in the app.');
});

$('alertBtn').addEventListener('click', async () => {
  showError(null); showOk(null);
  const n = Number($('alertDays').value);
  if (!Number.isInteger(n) || n < 1 || n > 60) { showError('Enter a whole number of days, 1 to 60.'); return; }

  const btn = $('alertBtn');
  btn.disabled = true; btn.textContent = 'Saving…';
  const { error } = await db.from('farms').update({ feed_alert_days: n }).eq('id', state.farm.id);
  btn.disabled = false; btn.textContent = 'Save';
  if (error) { showError(error.message); return; }

  showOk(`You'll be warned when any ration has less than ${n} day${n === 1 ? '' : 's'} left.`);
  await boot();
});

/* ---------- Forms --------------------------------------------------------- */
function plannedCost(phase) {
  const a = state.assumptions;
  if (!a) return null;
  return { Starter: a.starter_bag_cost, Grower: a.grower_bag_cost, Finisher: a.finisher_bag_cost }[phase];
}

/* Prefill from the last delivery of that ration — feed is usually bought the
   same way each time — falling back to the planner's own figures. */
function prefillDelivery() {
  const phase = $('dPhase').value;
  const last = state.stock.find((s) => s.phase === phase);
  const size = last?.last_bag_size_kg ?? state.assumptions?.bag_size_kg ?? 30;
  const cost = last?.last_cost_per_bag ?? plannedCost(phase);
  $('dSize').value = Number(size);
  $('dCost').value = cost != null ? Number(cost).toFixed(2) : '';
}

function fillForms(purchases) {
  $('dDate').value = today();
  $('cDate').value = today();
  prefillDelivery();

  const suppliers = [...new Set(purchases.map((p) => p.supplier).filter(Boolean))];
  $('supplierList').innerHTML = suppliers.map((s) => `<option value="${s.replace(/"/g, '&quot;')}">`).join('');
}
$('dPhase').addEventListener('change', prefillDelivery);

$('deliveryBtn').addEventListener('click', async () => {
  showError(null); showOk(null);

  const phase = $('dPhase').value;
  const bags = Number($('dBags').value);
  const size = Number($('dSize').value);
  const cost = Number($('dCost').value);
  const date = $('dDate').value || today();

  if (!Number.isInteger(bags) || bags <= 0) { showError('Enter how many bags arrived — a whole number.'); return; }
  if (!(size > 0)) { showError('Enter the bag size in kg.'); return; }
  if ($('dCost').value === '' || cost < 0) { showError('Enter the price per bag. Use 0 if it was free.'); return; }

  const btn = $('deliveryBtn');
  btn.disabled = true; btn.textContent = 'Logging…';

  const { error } = await db.from('feed_purchases').insert({
    farm_id: state.farm.id,
    cycle_id: state.cycle?.id ?? null,
    phase,
    purchased_on: date,
    bags,
    bag_size_kg: size,
    cost_per_bag: cost,
    supplier: $('dSupplier').value.trim() || null
  });

  btn.disabled = false; btn.textContent = 'Log delivery';
  if (error) { showError(error.message); return; }

  $('dBags').value = '';
  showOk(`${bagsWord(bags)} of ${phase.toLowerCase()} logged — ${money(bags * cost)}.`);
  await boot();
});

$('countBtn').addEventListener('click', async () => {
  showError(null); showOk(null);

  const date = $('cDate').value || today();
  const rows = [];
  for (const phase of PHASES) {
    const raw = $(`c${phase}`).value.trim();
    if (raw === '') continue;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 0) { showError(`${phase}: enter a whole number of bags, 0 or more.`); return; }
    rows.push({ farm_id: state.farm.id, phase, counted_on: date, bags: n });
  }
  if (!rows.length) { showError('Enter a count for at least one ration.'); return; }

  const btn = $('countBtn');
  btn.disabled = true; btn.textContent = 'Saving…';

  const { error } = await db.from('feed_stock_counts')
    .upsert(rows, { onConflict: 'farm_id,phase,counted_on' });

  btn.disabled = false; btn.textContent = 'Save count';
  if (error) { showError(error.message); return; }

  PHASES.forEach((p) => { $(`c${p}`).value = ''; });
  showOk(`Count saved for ${rows.map((r) => r.phase.toLowerCase()).join(', ')}.`);
  await boot();
});

/* ---------- Recent -------------------------------------------------------- */
function renderRecent(purchases, counts) {
  const items = [
    ...purchases.map((p) => ({ kind: 'delivery', date: p.purchased_on, row: p })),
    ...counts.map((c) => ({ kind: 'count', date: c.counted_on, row: c }))
  ].sort((a, b) => (b.date.localeCompare(a.date)) || (b.row.created_at || '').localeCompare(a.row.created_at || ''))
   .slice(0, 15);

  $('recentSection').hidden = !items.length;
  const wrap = $('recentList');
  wrap.textContent = '';

  items.forEach(({ kind, date, row }) => {
    const el = document.createElement('div');
    el.className = state.readOnly ? 'age-row' : 'age-row age-row--removable';

    const what = kind === 'delivery'
      ? `${row.phase} delivered · ${money(row.cost_per_bag)}/bag${row.supplier ? ` · ${row.supplier}` : ''}`
      : `${row.phase} counted`;
    const val = kind === 'delivery' ? `+${num(row.bags)}` : `= ${num(row.bags)}`;

    el.innerHTML =
      `<span class="age-row__label">${shortDate(date)}</span>
       <span style="font-size:.8125rem;color:var(--ink-2);min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap"></span>
       <span class="age-row__val tnum" style="color:${kind === 'delivery' ? 'var(--accent)' : 'inherit'}">${val}</span>`;
    // Supplier is free text someone typed — set as text, never as markup.
    el.children[1].textContent = what;

    if (!state.readOnly) {
      el.appendChild(removeButton(kind === 'delivery' ? 'feed_purchases' : 'feed_stock_counts', row.id,
        kind === 'delivery' ? 'delivery' : 'count'));
    }
    wrap.appendChild(el);
  });
}

/* Two taps, the same as removing a weighing: the first arms it, the second
   deletes. Disarms itself if left alone. */
function removeButton(table, id, noun) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'chip-btn chip-btn--danger';
  btn.setAttribute('data-press', '');
  btn.textContent = 'Remove';

  let armed = null;
  btn.addEventListener('click', async () => {
    if (!armed) {
      btn.textContent = `Remove ${noun}?`;
      armed = setTimeout(() => { armed = null; btn.textContent = 'Remove'; }, 4000);
      return;
    }
    clearTimeout(armed);
    btn.disabled = true;
    btn.textContent = 'Removing…';
    showError(null); showOk(null);

    const { error } = await db.from(table).delete().eq('id', id);
    if (error) {
      showError(`Could not remove that ${noun}: ${error.message}`);
      armed = null;
      btn.disabled = false;
      btn.textContent = 'Remove';
      return;
    }
    await boot();
  });
  return btn;
}

boot();
