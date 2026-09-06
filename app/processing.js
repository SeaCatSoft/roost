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
  editing: null, linkedBooking: null, outputs: new Map(), pending: null, readOnly: false,
  birdsScope: 'all',

  // Booking processing days and inviting people to them. isOwner is a
  // stricter gate than readOnly above — a member can record a run on this
  // same screen, but booking a date and emailing people is the owner's
  // call, same as starting a cycle or changing assumptions.
  //
  // bookings is every booking for this cycle — more than one can exist since
  // 025_multiple_bookings.sql, since birds sent in batches means dates
  // booked in batches. editingBooking is whichever one the form below is
  // currently open on, null while adding a brand new one.
  farm: null, isOwner: false, bookings: [], editingBooking: null, recipients: []
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

  await loadBookings();
}

/* ---------- Processing day booking ----------------------------------------
   Read-only for everyone (knowing the date matters for the daily work too);
   booking and sending is the owner's call, enforced by RLS (018) as well as
   by this screen only showing the editor to an owner. */
async function loadBookings() {
  if (!state.farm) return;

  const { data: bookings, error } = await db
    .from('v_processing_bookings')
    .select('*')
    .eq('cycle_id', state.cycle.id)
    .order('booked_on');

  if (error && !error.message.includes('does not exist')) {
    showError(`Could not load processing bookings: ${error.message}`);
  }
  if (error && error.message.includes('does not exist')) {
    // Migration 020 not applied yet — bookings simply are not offered rather
    // than breaking the rest of the screen, which does not depend on them.
    return;
  }

  state.bookings = bookings || [];
  renderBookingBanner();

  if (state.isOwner) {
    $('bookingsSection').hidden = false;
    renderBookingsList();
  }
}

/* Members see only the nearest upcoming booking — the one thing that changes
   what today's feed and health decisions mean. Anything further out, or any
   other booking, is the owner's business on the list below until it is
   closer. */
function renderBookingBanner() {
  const banner = $('bookingBanner');
  if (state.isOwner) { banner.hidden = true; return; }

  const upcoming = state.bookings
    .filter((b) => !b.is_cancelled && !b.is_past)
    .sort((a, b) => a.booked_on.localeCompare(b.booked_on));

  if (!upcoming.length) { banner.hidden = true; return; }

  const next = upcoming[0];
  const when = next.booked_time ? `${shortDate(next.booked_on)} at ${next.booked_time.slice(0, 5)}` : shortDate(next.booked_on);
  banner.hidden = false;
  banner.className = 'banner banner--ok';
  $('bookingBannerText').innerHTML =
    `Processing booked for <strong>${when}</strong>${next.location ? ` at ${next.location}` : ''}.` +
    (upcoming.length > 1 ? ` <span class="caption">+${upcoming.length - 1} more booked</span>` : '');
}

const BOOKING_TONE  = { cancelled: 'muted', needs_run: 'warn', done: 'ok', upcoming: 'ok' };
const BOOKING_LABEL = { cancelled: 'Cancelled', needs_run: 'Awaiting run', done: 'Done', upcoming: 'Upcoming' };

function bookingStatusOf(b) {
  if (b.is_cancelled) return 'cancelled';
  if (b.needs_run) return 'needs_run';
  if (b.is_past) return 'done';
  return 'upcoming';
}

function renderBookingsList() {
  const wrap = $('bookingsList');
  wrap.textContent = '';

  if (!state.bookings.length) {
    wrap.innerHTML = '<p class="caption">No processing dates booked yet.</p>';
    return;
  }

  state.bookings.forEach((b) => {
    const card = document.createElement('article');
    card.className = 'batch';

    const when = b.booked_time ? `${shortDate(b.booked_on)} at ${b.booked_time.slice(0, 5)}` : shortDate(b.booked_on);
    const status = bookingStatusOf(b);

    card.innerHTML =
      `<div class="batch__head">
         <div>
           <div class="batch__name">${when}
             <span class="inv-state inv-state--${BOOKING_TONE[status]}">${BOOKING_LABEL[status]}</span>
           </div>
           <div class="batch__meta">${b.location || 'No location set'}${b.birds_intended ? ` · ${num(b.birds_intended)} birds` : ''}</div>
         </div>
       </div>` +
      (!b.is_cancelled
        ? `<p class="caption" style="margin-top:.5rem">${num(b.invites_sent)} of ${num(b.invite_count)} invited` +
          (b.invites_stale ? ` · ${num(b.invites_stale)} need resending` : '') + `.</p>`
        : '');

    // The reminder this whole feature exists for: a date that has come and
    // gone with nothing recorded against it. Never shown for a cancelled
    // booking — there is nothing left to have happened.
    if (b.needs_run) {
      const warn = document.createElement('p');
      warn.className = 'caption';
      warn.style.cssText = 'margin-top:.5rem;color:var(--warn)';
      warn.textContent = 'This date has passed with nothing recorded — record the run to reflect it in the flock count.';
      card.appendChild(warn);
    }

    if (!state.readOnly) {
      const actions = document.createElement('div');
      actions.className = 'person__actions';
      actions.style.marginTop = '.9rem';

      if (!b.is_cancelled) {
        const edit = document.createElement('button');
        edit.type = 'button'; edit.className = 'chip-btn'; edit.setAttribute('data-press', '');
        edit.textContent = 'Edit';
        edit.addEventListener('click', () => openBookingForm(b));
        actions.appendChild(edit);
      }

      if (b.needs_run) {
        const record = document.createElement('button');
        record.type = 'button'; record.className = 'chip-btn'; record.setAttribute('data-press', '');
        record.style.cssText = 'background:var(--accent);color:var(--accent-ink);font-weight:600';
        record.textContent = 'Record the run';
        record.addEventListener('click', () => openForm(null, b));
        actions.appendChild(record);
      }

      card.appendChild(actions);
    }

    wrap.appendChild(card);
  });
}

/* ---------- One booking's form, shared by "Add a booking" and "Edit" ------- */
$('addBookingBtn').addEventListener('click', () => openBookingForm(null));

/* Farm members are offered by default — a booking with nobody on it is
   rarely what was meant — and anyone already invited stays listed even if
   they have since left the farm, since the invite was already sent. */
async function openBookingForm(booking) {
  state.editingBooking = booking;
  $('bookingFormTitle').textContent = booking ? 'Edit booking' : 'New booking';

  $('bDate').value = booking ? booking.booked_on : '';
  $('bTime').value = booking?.booked_time ? booking.booked_time.slice(0, 5) : '';
  $('bLocation').value = booking?.location ?? '';
  $('bNotes').value = booking?.notes ?? '';

  const birdsAlive = Number(state.progress?.birds_alive ?? 0);
  const intended = booking?.birds_intended;
  // "Some" only when a real, still-relevant plan is on file — a stale
  // intended count left over from before some birds were already sent
  // would otherwise reopen as a confusing partial default.
  const isPartial = intended != null && birdsAlive > 0 && Number(intended) < birdsAlive;
  setBirdsScope(isPartial ? 'some' : 'all');
  $('bBirds').value = isPartial ? intended : '';

  $('bookingStatus').textContent = booking
    ? `${num(booking.invites_sent)} of ${num(booking.invite_count)} sent` +
      (booking.invites_stale ? ` · ${num(booking.invites_stale)} need resending` : '')
    : 'Not booked yet';

  $('cancelBookingBtn').hidden = !booking || booking.is_cancelled;

  if (booking) {
    const { data: invites } = await db
      .from('processing_booking_invites')
      .select('id, email, name, sent_at, sent_for_seq, error')
      .eq('booking_id', booking.id)
      .order('id');
    state.recipients = (invites || []).map((i) => ({ ...i }));
  } else {
    state.recipients = [];
  }

  const { data: people } = await db.rpc('farm_people', { p_farm_id: state.farm.id });
  const already = new Set(state.recipients.map((r) => r.email.toLowerCase()));
  (people || []).forEach((p) => {
    if (already.has(p.email.toLowerCase())) return;
    state.recipients.push({ id: null, email: p.email, name: null, sent_at: null, sent_for_seq: null, error: null });
    already.add(p.email.toLowerCase());
  });

  renderRecipients();
  showError(null);
  $('inviteResult').textContent = '';
  $('bookingFormPanel').hidden = false;
  $('bookingFormPanel').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function closeBookingForm() {
  $('bookingFormPanel').hidden = true;
  state.editingBooking = null;
}

$('closeBookingFormBtn').addEventListener('click', closeBookingForm);

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

    const stale = state.editingBooking && r.sent_at && r.sent_for_seq !== state.editingBooking.sequence_no;
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

  const payload = {
    booked_on: date,
    booked_time: $('bTime').value || null,
    location: $('bLocation').value.trim() || null,
    notes: $('bNotes').value.trim() || null,
    birds_intended: birdsIntended,
    cancelled_at: null
  };

  // A cycle can hold more than one booking since 025_multiple_bookings.sql,
  // so this is a plain update-by-id when editing and an insert otherwise —
  // never an upsert keyed on the cycle the way a single booking once allowed.
  let saved, saveErr;
  if (state.editingBooking) {
    // The trigger behind this (018, extended in 023) only advances the
    // calendar SEQUENCE when the date, time, location or cancelled state
    // actually changes — editing just the notes does not force everyone's
    // calendar to re-confirm.
    ({ data: saved, error: saveErr } = await db
      .from('processing_bookings')
      .update(payload)
      .eq('id', state.editingBooking.id)
      .select()
      .single());
  } else {
    ({ data: saved, error: saveErr } = await db
      .from('processing_bookings')
      .insert({
        ...payload,
        farm_id: state.farm.id,
        cycle_id: state.cycle.id,
        created_by: (await db.auth.getSession()).data.session?.user?.id ?? null
      })
      .select()
      .single());
  }

  if (saveErr) {
    btn.disabled = false; btn.textContent = 'Save & send invites';
    showError(saveErr.message.includes('birds_intended')
      ? 'This needs migration 021. Run backend/migrations/021_partial_processing.sql in Supabase.'
      : saveErr.message);
    return;
  }

  state.editingBooking = saved;

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

  if (error) { showError(await readFunctionError(error)); await loadBookings(); return; }
  if (data?.error) { showError(data.error); await loadBookings(); return; }

  $('inviteResult').innerHTML =
    `<p class="caption" style="margin-top:.9rem">` +
    `${num(data.sent)} invite${data.sent === 1 ? '' : 's'} sent` +
    (data.failed ? `, ${num(data.failed)} failed — check the addresses below` : '.') +
    `</p>`;

  await loadBookings();
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

/* fromBooking: opened via a booking card's "Record the run" — pre-fills the
   date and bird count from what was booked, and links the two so the
   booking's needs_run reminder clears once this saves. Never set when
   editing an existing run: that run already carries whatever link it has,
   preserved as-is by save_processing_run's own coalesce. */
async function openForm(run, fromBooking) {
  state.editing = run;
  state.linkedBooking = fromBooking || null;
  state.outputs = new Map();

  $('formTitle').textContent = run ? 'Edit run' : fromBooking ? 'Record the run' : 'Record a run';
  $('fDate').value = run ? run.processed_on : fromBooking ? fromBooking.booked_on : today();
  updateFutureDateHint();
  $('fBirds').value = run ? run.birds_processed : fromBooking?.birds_intended ?? '';
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

/* A run dated ahead of today does not count toward birds_alive until that
   date arrives (022_processing_effective_date.sql) — worth saying here
   rather than leaving someone to notice the flock count didn't move and
   wonder if the save even worked. */
function updateFutureDateHint() {
  const hint = $('futureDateHint');
  const val = $('fDate').value;
  if (val && val > today()) {
    hint.hidden = false;
    hint.textContent =
      `Dated ahead of today — this won't reduce the flock count until ${val} arrives.`;
  } else {
    hint.hidden = true;
  }
}

$('fDate').addEventListener('change', updateFutureDateHint);

function closeForm() {
  $('formPanel').hidden = true;
  state.editing = null;
  state.linkedBooking = null;
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
    p_run_id: state.editing ? state.editing.id : null,
    // null when editing an existing run with no booking opened alongside it
    // — save_processing_run's own coalesce leaves whatever link it already
    // has untouched rather than wiping it.
    p_booking_id: state.linkedBooking ? state.linkedBooking.id : null
  });

  btn.disabled = false;
  btn.textContent = 'Save run';

  if (error) { showError(error.message); return; }

  closeForm();
  await boot();
  checkCycleFinished();
});

/* ---------- Cancelling a booking -------------------------------------------
   Two steps, always both: mark the booking cancelled (the trigger bumps its
   SEQUENCE for the same reason a reschedule does), then ask the function to
   send that cancellation to everyone who was actually sent something —
   otherwise Roost would consider it cancelled while their phones still show
   the old date. */
$('cancelBookingBtn').addEventListener('click', () => {
  if (!state.editingBooking) return;
  const when = state.editingBooking.booked_time
    ? `${shortDate(state.editingBooking.booked_on)} at ${state.editingBooking.booked_time.slice(0, 5)}`
    : shortDate(state.editingBooking.booked_on);
  $('cancelBookingWhat').textContent =
    `Booked for ${when}. Anyone already sent an invite gets a cancellation for it — ` +
    `their calendar should drop the event automatically.`;
  $('cancelBookingSheet').hidden = false;
  document.body.style.overflow = 'hidden';
});

function dismissCancelSheet() {
  $('cancelBookingSheet').hidden = true;
  document.body.style.overflow = '';
}

document.querySelectorAll('[data-close-cancel-sheet]').forEach((el) =>
  el.addEventListener('click', dismissCancelSheet));

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !$('cancelBookingSheet').hidden) dismissCancelSheet();
});

$('cancelBookingConfirm').addEventListener('click', async () => {
  if (!state.editingBooking) return;
  const bookingId = state.editingBooking.id;
  const btn = $('cancelBookingConfirm');
  btn.disabled = true; btn.textContent = 'Cancelling…';
  showError(null);

  const { error: cancelErr } = await db
    .from('processing_bookings')
    .update({ cancelled_at: new Date().toISOString() })
    .eq('id', bookingId);

  if (cancelErr) {
    btn.disabled = false; btn.textContent = 'Cancel booking';
    dismissCancelSheet();
    showError(cancelErr.message);
    return;
  }

  const { data, error: sendErr } = await db.functions.invoke('send-processing-invite', {
    body: { booking_id: bookingId, cancel: true }
  });

  btn.disabled = false; btn.textContent = 'Cancel booking';
  dismissCancelSheet();

  // The cancelled booking now just sits in the list, muted — closing the
  // form rather than trying to keep it open on something there is nothing
  // left to edit.
  closeBookingForm();

  if (sendErr) {
    showError(`Booking cancelled, but the cancellation notice failed to send: ${await readFunctionError(sendErr)}`);
  }

  await loadBookings();
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
