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
  cycle: null, lines: [], mix: [], runs: [], progress: null,
  editing: null, outputs: new Map(), pending: null, readOnly: false,
  birdsScope: 'all',

  // Booking a processing day and inviting people to it. isOwner is a
  // stricter gate than readOnly above — a member can record a run on this
  // same screen, but booking the date and emailing people is the owner's
  // call, same as starting a cycle or changing assumptions.
  farm: null, isOwner: false, booking: null, recipients: []
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

  const [lines, mix, runs, actual, progress] = await Promise.all([
    db.from('product_lines').select('*').order('sort_order'),
    db.from('cycle_product_mix').select('*').eq('cycle_id', state.cycle.id),
    db.from('v_processing_runs').select('*').eq('cycle_id', state.cycle.id).order('processed_on'),
    db.from('v_cycle_actual').select('*').eq('cycle_id', state.cycle.id).maybeSingle(),
    // birds_processed_total needs migration 021 — fails soft like the others
    // here, so an older database just never shows the "sent so far" line.
    db.from('v_cycle_progress').select('birds_alive, birds_processed_total')
      .eq('cycle_id', state.cycle.id).maybeSingle()
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
  state.progress = progress.data || null;

  renderRuns();
  renderCompare(actual.data);
  renderSentSoFar();

  const role = await myRole();
  state.readOnly = !canEdit(role);
  state.isOwner = role === 'owner';
  if (state.readOnly) {
    $('addRunBtn').disabled = true;
    lockForViewer($('formPanel'), 'You have view-only access. Runs are shown, but cannot be recorded.');
  }

  const { data: farms } = await db.from('farms').select('id, name').order('id').limit(1);
  state.farm = farms && farms.length ? farms[0] : null;

  await loadBooking();
}

/* ---------- Processing day booking ----------------------------------------
   Read-only for everyone (knowing the date matters for the daily work too);
   booking and sending is the owner's call, enforced by RLS (018) as well as
   by this screen only showing the editor to an owner. */
async function loadBooking() {
  if (!state.farm) return;

  const { data: booking, error } = await db
    .from('v_processing_bookings')
    .select('*')
    .eq('cycle_id', state.cycle.id)
    .maybeSingle();

  if (error && !error.message.includes('does not exist')) {
    showError(`Could not load the processing booking: ${error.message}`);
  }
  if (error && error.message.includes('does not exist')) {
    // Migration 018 not applied yet — booking simply is not offered rather
    // than breaking the rest of the screen, which does not depend on it.
    return;
  }

  state.booking = booking || null;

  if (state.booking) {
    const { data: invites } = await db
      .from('processing_booking_invites')
      .select('id, email, name, sent_at, sent_for_seq, error')
      .eq('booking_id', state.booking.id)
      .order('id');
    state.recipients = (invites || []).map((i) => ({ ...i }));
  } else {
    state.recipients = [];
  }

  renderBookingBanner();

  if (state.isOwner) {
    $('bookingPanel').hidden = false;
    await fillBookingForm();
  }
}

function renderBookingBanner() {
  const b = state.booking;
  const banner = $('bookingBanner');

  // Owners get the full editor below instead — showing both says the same
  // thing twice.
  if (state.isOwner || !b) { banner.hidden = true; return; }

  const when = b.booked_time ? `${shortDate(b.booked_on)} at ${b.booked_time.slice(0, 5)}` : shortDate(b.booked_on);
  banner.hidden = false;
  $('bookingBannerText').innerHTML =
    `Processing booked for <strong>${when}</strong>${b.location ? ` at ${b.location}` : ''}.` +
    (b.is_past ? ' <span class="caption">(this date has passed)</span>' : '');
}

/* Farm members are offered by default — a booking with nobody on it is
   rarely what was meant — and anyone already invited stays listed even if
   they have since left the farm, since the invite was already sent. */
async function fillBookingForm() {
  $('bDate').value = state.booking ? state.booking.booked_on : '';
  $('bTime').value = state.booking?.booked_time ? state.booking.booked_time.slice(0, 5) : '';
  $('bLocation').value = state.booking?.location ?? '';
  $('bNotes').value = state.booking?.notes ?? '';

  const birdsAlive = Number(state.progress?.birds_alive ?? 0);
  const intended = state.booking?.birds_intended;
  // "Some" only when a real, still-relevant plan is on file — a stale
  // intended count left over from before some birds were already sent
  // would otherwise reopen as a confusing partial default.
  const isPartial = intended != null && birdsAlive > 0 && Number(intended) < birdsAlive;
  setBirdsScope(isPartial ? 'some' : 'all');
  $('bBirds').value = isPartial ? intended : '';

  $('bookingStatus').textContent = state.booking
    ? `${num(state.booking.invites_sent)} of ${num(state.booking.invite_count)} sent` +
      (state.booking.invites_stale ? ` · ${num(state.booking.invites_stale)} need resending` : '')
    : 'Not booked yet';

  // Merged in every time, not only when the list starts empty — someone who
  // joins the farm after the first booking should still show up as a
  // candidate next time this opens, not just on the very first booking ever
  // made for this cycle.
  const { data: people } = await db.rpc('farm_people', { p_farm_id: state.farm.id });
  const already = new Set(state.recipients.map((r) => r.email.toLowerCase()));
  (people || []).forEach((p) => {
    if (already.has(p.email.toLowerCase())) return;
    state.recipients.push({ id: null, email: p.email, name: null, sent_at: null, sent_for_seq: null, error: null });
    already.add(p.email.toLowerCase());
  });

  renderRecipients();
}

function renderRecipients() {
  const wrap = $('recipientList');
  wrap.textContent = '';

  if (!state.recipients.length) {
    wrap.innerHTML = '<p class="caption">Nobody added yet.</p>';
    return;
  }

  state.recipients.forEach((r, idx) => {
    const row = document.createElement('div');
    row.className = 'recip-row';

    const stale = state.booking && r.sent_at && r.sent_for_seq !== state.booking.sequence_no;
    const chip = r.error
      ? '<span class="inv-state inv-state--warn">failed</span>'
      : stale
        ? '<span class="inv-state inv-state--warn">resend</span>'
        : r.sent_at
          ? '<span class="inv-state inv-state--ok">sent</span>'
          : '<span class="inv-state inv-state--muted">pending</span>';

    row.innerHTML =
      `<span class="recip-row__email" title="${r.email}">${r.email}</span>
       ${chip}
       <button type="button" class="inv-line__x" aria-label="Remove ${r.email}" data-press>
         <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6 6 18"/></svg>
       </button>`;

    row.querySelector('.inv-line__x').addEventListener('click', () => {
      state.recipients.splice(idx, 1);
      renderRecipients();
    });

    if (r.error) row.title = r.error;
    wrap.appendChild(row);
  });
}

/* ---------- How many birds this booking is for -----------------------------
   Informational only — stored on the booking (birds_intended) for the email
   and the conversation with the processor. It changes nothing else on its
   own; what actually reduces the flock is a run's own birds_processed once
   it is recorded, since plans can slip and only the real run is trusted for
   that (021_partial_processing.sql). */
function setBirdsScope(scope) {
  state.birdsScope = scope;
  document.querySelectorAll('[data-segment="birdsScope"] button').forEach((b) =>
    b.setAttribute('aria-pressed', String(b.getAttribute('data-value') === scope)));
  $('birdsSomeField').hidden = scope !== 'some';

  const birdsAlive = Number(state.progress?.birds_alive ?? 0);
  if (scope === 'all') {
    $('birdsHint').textContent = birdsAlive > 0
      ? `Sends all ${num(birdsAlive)} still in the house — ${state.cycle.label} will be ready ` +
        `to close out once it's recorded as processed.`
      : 'Sends everyone remaining.';
  } else {
    $('birdsHint').textContent =
      'Whatever is left keeps growing after this — recording the actual run afterward is ' +
      'what really moves the count, this is just what the invite says to expect.';
  }
}

document.querySelectorAll('[data-segment="birdsScope"] button').forEach((btn) => {
  btn.addEventListener('click', () => setBirdsScope(btn.getAttribute('data-value')));
});

$('addEmailBtn').addEventListener('click', () => {
  const input = $('addEmail');
  const email = input.value.trim().toLowerCase();
  if (!email) return;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { showError('That does not look like a full email address.'); return; }
  if (state.recipients.some((r) => r.email.toLowerCase() === email)) { showError('Already on the list.'); input.value = ''; return; }

  state.recipients.push({ id: null, email, name: null, sent_at: null, sent_for_seq: null, error: null });
  input.value = '';
  showError(null);
  renderRecipients();
});

$('saveBookingBtn').addEventListener('click', async () => {
  const btn = $('saveBookingBtn');
  showError(null);
  $('inviteResult').textContent = '';

  const date = $('bDate').value;
  if (!date) { showError('Pick a processing date.'); return; }
  if (!state.recipients.length) { showError('Add at least one person to invite.'); return; }

  let birdsIntended = null;
  if (state.birdsScope === 'some') {
    birdsIntended = parseInt($('bBirds').value, 10);
    if (!birdsIntended || birdsIntended <= 0) {
      showError('Say how many birds this booking is for, or switch back to "All of them."');
      return;
    }
  } else {
    const birdsAlive = Number(state.progress?.birds_alive ?? 0);
    if (birdsAlive > 0) birdsIntended = birdsAlive;
  }

  btn.disabled = true;
  btn.textContent = 'Saving…';

  // One booking per cycle: created the first time, updated every time after.
  // The trigger behind this (018) only advances the calendar SEQUENCE when
  // the date, time or location actually changes — editing just the notes
  // does not force everyone's calendar to re-confirm.
  const { data: saved, error: saveErr } = await db
    .from('processing_bookings')
    .upsert({
      farm_id: state.farm.id,
      cycle_id: state.cycle.id,
      booked_on: date,
      booked_time: $('bTime').value || null,
      location: $('bLocation').value.trim() || null,
      notes: $('bNotes').value.trim() || null,
      birds_intended: birdsIntended,
      created_by: (await db.auth.getSession()).data.session?.user?.id ?? null
    }, { onConflict: 'cycle_id' })
    .select()
    .single();

  if (saveErr) {
    btn.disabled = false; btn.textContent = 'Save & send invites';
    showError(saveErr.message.includes('birds_intended')
      ? 'This needs migration 021. Run backend/migrations/021_partial_processing.sql in Supabase.'
      : saveErr.message);
    return;
  }

  state.booking = saved;

  // Reconcile who is actually on the list: drop anyone removed, add anyone
  // new. Existing recipients that survived are left untouched here — their
  // sent status is what decides whether the function below re-sends to them.
  const { data: existing } = await db
    .from('processing_booking_invites')
    .select('id, email')
    .eq('booking_id', saved.id);

  const keepEmails = new Set(state.recipients.map((r) => r.email.toLowerCase()));
  const toDelete = (existing || []).filter((e) => !keepEmails.has(e.email.toLowerCase()));
  const existingEmails = new Set((existing || []).map((e) => e.email.toLowerCase()));
  const toInsert = state.recipients.filter((r) => !existingEmails.has(r.email.toLowerCase()));

  if (toDelete.length) {
    await db.from('processing_booking_invites').delete().in('id', toDelete.map((e) => e.id));
  }
  if (toInsert.length) {
    await db.from('processing_booking_invites').insert(
      toInsert.map((r) => ({ booking_id: saved.id, email: r.email, name: r.name || null }))
    );
  }

  btn.textContent = 'Sending…';

  const { data, error } = await db.functions.invoke('send-processing-invite', {
    body: { booking_id: saved.id }
  });

  btn.disabled = false;
  btn.textContent = 'Save & send invites';

  if (error) { showError(await readFunctionError(error)); await loadBooking(); return; }
  if (data?.error) { showError(data.error); await loadBooking(); return; }

  $('inviteResult').innerHTML =
    `<p class="caption" style="margin-top:.9rem">` +
    `${num(data.sent)} invite${data.sent === 1 ? '' : 's'} sent` +
    (data.failed ? `, ${num(data.failed)} failed — check the addresses below` : '.') +
    `</p>`;

  await loadBooking();
});

async function readFunctionError(error) {
  if (error?.context?.json) {
    try {
      const body = await error.context.json();
      if (body?.error) return body.error;
    } catch { /* not JSON — fall through */ }
  }
  return error?.message ||
    'Could not reach the invite function. Has send-processing-invite been deployed in Supabase?';
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

/* Only worth a line once there is something to report — a cycle finished in
   one run has nothing this doesn't already say via the runs list below. */
function renderSentSoFar() {
  const el = $('sentSoFar');
  const p = state.progress;
  if (!p || !Number(p.birds_processed_total)) { el.hidden = true; return; }

  el.hidden = false;
  el.textContent = Number(p.birds_alive) > 0
    ? `${num(p.birds_processed_total)} sent to processing so far, ` +
      `${num(p.birds_alive)} still in the house.`
    : `${num(p.birds_processed_total)} sent to processing — nothing left in the house.`;
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
  checkCycleFinished();
});

/* ---------- Offering to close a finished cycle -----------------------------
   birds_alive already accounts for both mortality and everything processed
   so far (021_partial_processing.sql) — once it hits zero, every bird placed
   is accounted for one way or another, which is exactly what "finished"
   means here. Offered, never forced: a wrong number entered on the run just
   saved is still fixable without a cycle closing itself out from under it. */
function checkCycleFinished() {
  if (!state.progress || state.cycle.closed_at) return;
  if (Number(state.progress.birds_alive) > 0) return;

  $('closeCycleWhat').textContent =
    `${state.cycle.label} has nothing left in the house — every bird placed has been ` +
    `accounted for, between losses and processing. Closing it out moves it to Batches; ` +
    `nothing recorded against it is touched.`;
  $('closeCycleSheet').hidden = false;
  document.body.style.overflow = 'hidden';
}

function dismissCloseCycleSheet() {
  $('closeCycleSheet').hidden = true;
  document.body.style.overflow = '';
}

document.querySelectorAll('[data-close-cycle-sheet]').forEach((el) =>
  el.addEventListener('click', dismissCloseCycleSheet));

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !$('closeCycleSheet').hidden) dismissCloseCycleSheet();
});

$('closeCycleConfirm').addEventListener('click', async () => {
  const btn = $('closeCycleConfirm');
  btn.disabled = true; btn.textContent = 'Closing…';

  // The same function starting a new cycle already calls to archive the one
  // it replaces (005_cycle_management.sql) — offered here at the moment it
  // is actually true, instead of only when starting the next flock forces
  // the question.
  const { error } = await db.rpc('archive_cycle', { p_cycle_id: state.cycle.id });

  btn.disabled = false; btn.textContent = 'Close the cycle';

  if (error) { showError(error.message); dismissCloseCycleSheet(); return; }

  dismissCloseCycleSheet();
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
