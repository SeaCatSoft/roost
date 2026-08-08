/* =============================================================================
   Roost — invoice follow-ups

   Claude drafts a subject and body from one invoice's real figures, read
   through the caller's own session in the Edge Function — the same numbers
   this screen shows, nothing invented. The draft is saved as soon as it's
   made so the history survives a closed tab, but nothing is emailed by any
   of that. Only "Approve & open email" hands it to the person's own email
   app, and only their own Send in that app actually sends it.
   ========================================================================== */

import { db, isConfigured, $, banner, myRole, canEdit } from './db.js';

const screens = { setup: $('setupScreen'), auth: $('authScreen'), app: $('appScreen') };
const show = (n) => Object.entries(screens).forEach(([k, el]) => { el.hidden = k !== n; });
const showError = (m) => banner($('appError'), $('appErrorText'), m);
const showOk = (m) => banner($('appOk'), $('appOkText'), m);

if (!isConfigured) { show('setup'); throw new Error('Supabase is not configured'); }

const state = { farm: null, rows: [], readOnly: false, active: null };

const num = (n, d = 0) =>
  Number(n ?? 0).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
const money = (v) => '$' + num(Math.abs(Number(v ?? 0)), 2);
const shortDate = (iso) =>
  new Date(iso + 'T00:00:00').toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });

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

  state.readOnly = !canEdit(await myRole());

  const { data, error } = await db.from('v_followup_candidates').select('*')
    .order('days_overdue', { ascending: false });

  if (error) {
    showError(error.message.includes('does not exist')
      ? 'This screen needs migration 013. Run backend/migrations/013_followups.sql in Supabase.'
      : `Could not load invoices: ${error.message}`);
    return;
  }

  state.rows = data || [];
  renderList();
}

/* ---------- List ------------------------------------------------------------ */
function historyLine(r) {
  if (!r.followup_count) return 'No follow-up sent yet.';
  if (r.last_followup_status === 'sent') {
    return r.days_since_followup === 0
      ? 'Emailed today.'
      : `Last emailed ${num(r.days_since_followup)} day${r.days_since_followup === 1 ? '' : 's'} ago.`;
  }
  if (r.last_followup_status === 'drafted') return 'A draft is waiting, not yet sent.';
  return 'Last draft was discarded.';
}

function renderList() {
  const wrap = $('list');
  wrap.textContent = '';

  if (!state.rows.length) {
    wrap.innerHTML = '<p class="caption">Nothing outstanding needs a follow-up.</p>';
    return;
  }

  state.rows.forEach((r) => {
    const card = document.createElement('article');
    card.className = 'batch';
    const overdue = Number(r.days_overdue ?? 0) > 0;

    card.innerHTML =
      `<div class="batch__head">
         <div>
           <div class="batch__name">${r.number}</div>
           <div class="batch__meta">${r.customer} · due ${shortDate(r.due_on)}</div>
         </div>
       </div>
       <div class="batch__grid">
         <div><span class="metric__k">Outstanding</span><span class="batch__v tnum" style="color:var(--warn)">${money(r.outstanding)}</span></div>
         <div><span class="metric__k">Overdue</span><span class="batch__v tnum"
              style="color:${overdue ? 'var(--warn)' : 'inherit'}">${overdue ? num(r.days_overdue) + ' days' : 'Not yet'}</span></div>
       </div>
       <p class="caption" style="margin-top:.6rem">${historyLine(r)}</p>`;

    if (!state.readOnly) {
      const actions = document.createElement('div');
      actions.className = 'person__actions';
      actions.style.marginTop = '.9rem';
      const btn = chip('Draft with AI', () => draftFor(r, btn));
      actions.appendChild(btn);
      card.appendChild(actions);
    }

    wrap.appendChild(card);
  });
}

function chip(label, onClick, danger) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'chip-btn' + (danger ? ' chip-btn--danger' : '');
  b.setAttribute('data-press', '');
  b.textContent = label;
  b.addEventListener('click', onClick);
  return b;
}

/* ---------- Drafting -------------------------------------------------------- */
async function draftFor(row, btn) {
  showError(null); showOk(null);
  btn.disabled = true;
  const original = btn.textContent;
  btn.textContent = 'Drafting…';

  const { data, error } = await db.functions.invoke('draft-invoice-followup', {
    body: { invoice_id: row.id }
  });

  btn.disabled = false;
  btn.textContent = original;

  if (error) { showError(await readFunctionError(error)); return; }
  if (data?.error) { showError(data.error); return; }

  openDraft(row, data.followup);
}

async function readFunctionError(error) {
  if (error?.context?.json) {
    try {
      const body = await error.context.json();
      if (body?.error) return body.error;
    } catch { /* not JSON — fall through */ }
  }
  return error?.message ||
    'Could not reach the drafting function. Has draft-invoice-followup been deployed in Supabase?';
}

function openDraft(row, followup) {
  state.active = { row, followup };
  $('draftTitle').textContent = `Draft for ${row.number}`;
  $('draftWhat').textContent = `To ${row.customer} (${row.customer_email}) about ${money(row.outstanding)} outstanding.`;
  $('dSubject').value = followup.subject;
  $('dBody').value = followup.body;
  $('draftPanel').hidden = false;
  $('draftPanel').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function closeDraft() {
  state.active = null;
  $('draftPanel').hidden = true;
}

$('discardBtn').addEventListener('click', async () => {
  if (!state.active) return;
  showError(null);
  const { error } = await db.from('invoice_followups')
    .update({ status: 'dismissed' })
    .eq('id', state.active.followup.id);
  closeDraft();
  if (error) { showError(error.message); return; }
  await boot();
});

$('copyBtn').addEventListener('click', async () => {
  const text = `Subject: ${$('dSubject').value}\n\n${$('dBody').value}`;
  try {
    await navigator.clipboard.writeText(text);
    showOk('Copied.');
  } catch {
    showError('Could not copy — your browser may be blocking clipboard access.');
  }
});

$('approveBtn').addEventListener('click', async () => {
  if (!state.active) return;
  showError(null); showOk(null);

  const subject = $('dSubject').value.trim();
  const bodyText = $('dBody').value.trim();
  if (!subject || !bodyText) { showError('Subject and body cannot be empty.'); return; }

  const btn = $('approveBtn');
  btn.disabled = true; btn.textContent = 'Opening…';

  const { error } = await db.from('invoice_followups')
    .update({ status: 'sent', subject, body: bodyText })
    .eq('id', state.active.followup.id);

  btn.disabled = false; btn.textContent = 'Approve & open email';

  if (error) { showError(error.message); return; }

  const email = state.active.row.customer_email;
  const mailto = `mailto:${encodeURIComponent(email)}` +
    `?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(bodyText)}`;
  window.location.href = mailto;

  showOk(`Opened in your email app, addressed to ${email}. Send it from there to finish.`);
  closeDraft();
  await boot();
});

boot();
