/* =============================================================================
   Roost — the check log

   What was recorded on each day of a batch, and who saved it. The names come
   from cycle_check_log (migration 014) rather than a plain table read, because
   recorded_by is a uuid into auth.users and auth.users cannot be read from the
   browser — that function is SECURITY DEFINER and re-checks farm access itself.

   "Saved by" is deliberately worded that way. A check is stored by upsert, so
   re-saving a day overwrites who recorded it; this is not an edit history and
   the screen does not pretend to be one.
   ========================================================================== */

import { db, isConfigured, $, banner, formatShortDate } from './db.js';

const screens = { setup: $('setupScreen'), auth: $('authScreen'), app: $('appScreen') };
const show = (n) => Object.entries(screens).forEach(([k, el]) => { el.hidden = k !== n; });
const showError = (m) => banner($('appError'), $('appErrorText'), m);

if (!isConfigured) { show('setup'); throw new Error('Supabase is not configured'); }

const state = { farm: null, cycles: [], cycleId: null, rows: [] };

const num = (n, d = 0) =>
  Number(n ?? 0).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });

/* Only the parts of an address that identify a person at a glance. The full
   address is on the row's title attribute for when it genuinely matters. */
const shortName = (email) => (email ? email.split('@')[0] : null);

const stamp = (iso) => {
  const d = new Date(iso);
  return d.toLocaleString(undefined, {
    day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit'
  });
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

  const { data: cycles, error } = await db
    .from('cycles')
    .select('id, label, placed_on, closed_at')
    .order('placed_on', { ascending: false });

  if (error) { showError(`Could not load batches: ${error.message}`); return; }
  if (!cycles || !cycles.length) {
    showError('No batches yet. Start a cycle before there is anything to log.');
    $('list').textContent = '';
    return;
  }

  state.cycles = cycles;

  const sel = $('cyclePick');
  sel.textContent = '';
  cycles.forEach((c) => {
    const o = document.createElement('option');
    o.value = c.id;
    o.textContent = `${c.label} · placed ${formatShortDate(c.placed_on)}${c.closed_at ? '' : ' · open'}`;
    sel.appendChild(o);
  });

  // Default to the open batch if there is one, otherwise the most recent.
  state.cycleId = (cycles.find((c) => !c.closed_at) || cycles[0]).id;
  sel.value = state.cycleId;

  await loadLog();
}

$('cyclePick').addEventListener('change', async () => {
  state.cycleId = Number($('cyclePick').value);
  await loadLog();
});

async function loadLog() {
  $('list').innerHTML = '<p class="caption">Loading…</p>';
  $('summary').textContent = '';
  showError(null);

  const { data, error } = await db.rpc('cycle_check_log', { p_cycle_id: state.cycleId });

  if (error) {
    showError(error.message.includes('does not exist')
      ? 'This screen needs migration 014. Run backend/migrations/014_check_log.sql in Supabase.'
      : `Could not load the log: ${error.message}`);
    $('list').textContent = '';
    return;
  }

  state.rows = data || [];
  renderSummary();
  renderList();
}

/* ---------- Summary --------------------------------------------------------- */
function renderSummary() {
  const rows = state.rows;
  const days = new Set(rows.map((r) => r.day_number)).size;
  const losses = rows.reduce((t, r) => t + (r.mortality || 0) + (r.culls || 0), 0);

  // Who has been doing the checking, most active first.
  const byPerson = new Map();
  rows.forEach((r) => {
    const key = r.recorded_by_email || '—';
    byPerson.set(key, (byPerson.get(key) || 0) + 1);
  });
  const people = [...byPerson.entries()].sort((a, b) => b[1] - a[1]);

  $('summary').innerHTML =
    `<div><div class="metric__k">Checks</div><div class="metric__v tnum">${num(rows.length)}</div></div>
     <div><div class="metric__k">Days covered</div><div class="metric__v tnum">${num(days)}</div></div>
     <div><div class="metric__k">Losses</div><div class="metric__v tnum">${num(losses)}</div></div>`;

  if (people.length) {
    const line = document.createElement('p');
    line.className = 'caption';
    line.style.marginTop = '.9rem';
    line.style.gridColumn = '1 / -1';
    line.textContent = 'Saved by ' + people
      .map(([email, n]) => `${shortName(email) || 'someone no longer on the farm'} (${n})`)
      .join(', ') + '.';
    $('summary').appendChild(line);
  }
}

/* ---------- The log --------------------------------------------------------- */
const TONE = { OK: '', Low: 'var(--warn)', Empty: 'var(--warn)', Dry: '', Damp: 'var(--warn)', Wet: 'var(--warn)' };

function renderList() {
  const wrap = $('list');
  wrap.textContent = '';

  if (!state.rows.length) {
    wrap.innerHTML = '<p class="caption">Nothing recorded for this batch yet.</p>';
    return;
  }

  state.rows.forEach((r) => {
    const card = document.createElement('article');
    card.className = 'batch';

    const who = shortName(r.recorded_by_email);
    const whoLabel = who
      ? (r.is_you ? `${who} (you)` : who)
      : 'Not recorded';

    const bits = [];
    if (r.water) bits.push(['Water', r.water]);
    if (r.litter) bits.push(['Litter', r.litter]);
    if (r.health) bits.push(['Health', r.health]);
    if (r.house_temp_c != null) bits.push(['Temp', `${num(r.house_temp_c, 1)}°C`]);

    card.innerHTML =
      `<div class="batch__head">
         <div>
           <div class="batch__name">Day ${r.day_number}${
             r.session && r.session !== 'DAY' ? ` · ${r.session}` : ''}</div>
           <div class="batch__meta">${formatShortDate(r.checked_on)}</div>
         </div>
       </div>
       <div class="batch__grid">
         <div><span class="metric__k">Deaths</span><span class="batch__v tnum">${num(r.mortality)}</span></div>
         <div><span class="metric__k">Culls</span><span class="batch__v tnum">${num(r.culls)}</span></div>
         ${bits.map(([k, v]) =>
           `<div><span class="metric__k">${k}</span><span class="batch__v" style="color:${TONE[v] || 'inherit'}">${v}</span></div>`
         ).join('')}
       </div>`;

    if (r.notes) {
      const n = document.createElement('p');
      n.className = 'caption';
      n.style.marginTop = '.6rem';
      n.textContent = r.notes;
      card.appendChild(n);
    }

    const foot = document.createElement('p');
    foot.className = 'caption';
    foot.style.marginTop = '.6rem';
    foot.style.color = 'var(--ink-3)';
    if (r.recorded_by_email) foot.title = r.recorded_by_email;
    foot.textContent = `Saved by ${whoLabel} · ${stamp(r.updated_at || r.created_at)}`;
    card.appendChild(foot);

    wrap.appendChild(card);
  });
}

boot();
