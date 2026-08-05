/* =============================================================================
   Roost — people

   Membership, roles and invitations. Every mutation goes through a database
   function rather than a direct table write, because the rules that matter
   (only owners may manage, never strand the farm without one) belong in one
   place the browser cannot skip.
   ========================================================================== */

import { db, isConfigured, $, banner } from './db.js';

const screens = { setup: $('setupScreen'), auth: $('authScreen'), app: $('appScreen') };
const show = (n) => Object.entries(screens).forEach(([k, el]) => { el.hidden = k !== n; });
const showError = (m) => banner($('appError'), $('appErrorText'), m);
const showOk = (m) => banner($('appOk'), $('appOkText'), m);

if (!isConfigured) { show('setup'); throw new Error('Supabase is not configured'); }

const ROLE_LABEL = { owner: 'Owner', member: 'Member', viewer: 'Viewer' };

const state = { farm: null, people: [], invites: [], isOwner: false, inviteRole: 'member', pending: null };

const when = (iso) =>
  new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });

/* ---------- Load ---------------------------------------------------------- */
async function boot() {
  const { data: { session } } = await db.auth.getSession();
  if (!session) { show('auth'); return; }
  show('app');
  showError(null);

  const { data: farms, error: farmErr } = await db.from('farms').select('id, name').limit(1);
  if (farmErr || !farms || !farms.length) {
    showError('No farm is linked to this account yet.');
    return;
  }
  state.farm = farms[0];
  $('farmName').textContent = state.farm.name;

  const { data: people, error } = await db.rpc('farm_people', { p_farm_id: state.farm.id });

  if (error) {
    showError(
      error.message.includes('does not exist')
        ? 'This screen needs migration 007. Run backend/migrations/007_people.sql in Supabase.'
        : `Could not load people: ${error.message}`
    );
    return;
  }

  state.people = people || [];
  const me = state.people.find((p) => p.is_you);
  state.isOwner = me?.role === 'owner';

  $('roleNote').textContent = state.isOwner
    ? 'You are an owner, so you can invite people and change what they can do.'
    : me?.role === 'viewer'
      ? 'You have view-only access. You can see who is here, but not change it.'
      : 'You are a member. Only an owner can change who has access.';

  $('invitePanel').hidden = !state.isOwner;

  renderPeople();
  await loadInvites();
}

async function loadInvites() {
  const { data, error } = await db.rpc('pending_invites', { p_farm_id: state.farm.id });
  if (error) return;

  state.invites = data || [];
  $('invitesSection').hidden = state.invites.length === 0;
  renderInvites();
}

/* ---------- People -------------------------------------------------------- */
function renderPeople() {
  const wrap = $('peopleList');
  wrap.textContent = '';

  const owners = state.people.filter((p) => p.role === 'owner').length;

  state.people.forEach((p) => {
    const row = document.createElement('div');
    row.className = 'person';

    const initial = (p.email || '?').charAt(0).toUpperCase();
    // The last owner cannot be demoted or removed — the database refuses it, so
    // the controls are disabled here rather than offering an action that fails.
    const lastOwner = p.role === 'owner' && owners <= 1;

    row.innerHTML =
      `<div class="person__avatar" aria-hidden="true">${initial}</div>
       <div class="person__main">
         <div class="person__email">${p.email}${p.is_you ? ' <span class="person__you">you</span>' : ''}</div>
         <div class="person__meta">${ROLE_LABEL[p.role] || p.role} · joined ${when(p.joined_at)}</div>
       </div>`;

    if (state.isOwner) {
      const actions = document.createElement('div');
      actions.className = 'person__actions';

      // Three roles need a picker rather than a toggle. Each is one tap, and
      // the current one is simply already selected.
      const picker = document.createElement('div');
      picker.className = 'role-picker';
      picker.setAttribute('role', 'group');
      picker.setAttribute('aria-label', `Role for ${p.email}`);

      ['viewer', 'member', 'owner'].forEach((role) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'role-picker__opt';
        b.setAttribute('aria-pressed', String(p.role === role));
        b.textContent = ROLE_LABEL[role];
        // Demoting the only owner is refused by the database, so it is not offered.
        b.disabled = p.role === role || (lastOwner && role !== 'owner');
        if (lastOwner && role !== 'owner') b.title = 'The only owner cannot be demoted';
        b.addEventListener('click', () => changeRole(p, role));
        picker.appendChild(b);
      });
      actions.appendChild(picker);

      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'chip-btn chip-btn--danger';
      remove.setAttribute('data-press', '');
      remove.textContent = 'Remove';
      remove.disabled = lastOwner;
      if (lastOwner) remove.title = 'The only owner cannot be removed';
      remove.addEventListener('click', () => openRemove(p));
      actions.appendChild(remove);

      row.appendChild(actions);
    }

    wrap.appendChild(row);
  });
}

async function changeRole(person, role) {
  showError(null); showOk(null);

  const { error } = await db.rpc('set_member_role', {
    p_farm_id: state.farm.id,
    p_user_id: person.user_id,
    p_role: role
  });

  if (error) { showError(error.message); return; }
  showOk(`${person.email} is now ${role === 'owner' ? 'an owner' : role === 'viewer' ? 'view-only' : 'a member'}.`);
  await boot();
}

/* ---------- Remove -------------------------------------------------------- */
function openRemove(person) {
  state.pending = person;
  $('removeWhat').textContent =
    `${person.email} will lose access immediately. Everything they recorded stays — ` +
    `this removes the person, not their work.`;
  $('removeSheet').hidden = false;
  document.body.style.overflow = 'hidden';
}

function closeSheet() {
  $('removeSheet').hidden = true;
  document.body.style.overflow = '';
  state.pending = null;
}

document.querySelectorAll('[data-close-sheet]').forEach((el) =>
  el.addEventListener('click', closeSheet));

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !$('removeSheet').hidden) closeSheet();
});

$('removeConfirm').addEventListener('click', async () => {
  if (!state.pending) return;
  const person = state.pending;
  const btn = $('removeConfirm');
  btn.disabled = true;
  btn.textContent = 'Removing…';

  const { error } = await db.rpc('remove_member', {
    p_farm_id: state.farm.id,
    p_user_id: person.user_id
  });

  btn.disabled = false;
  btn.textContent = 'Remove';
  closeSheet();

  if (error) { showError(error.message); return; }
  showOk(`${person.email} no longer has access.`);
  await boot();
});

/* ---------- Invites ------------------------------------------------------- */
function renderInvites() {
  const wrap = $('invitesList');
  wrap.textContent = '';

  state.invites.forEach((inv) => {
    const row = document.createElement('div');
    row.className = 'person person--invite';
    row.innerHTML =
      `<div class="person__avatar person__avatar--pending" aria-hidden="true">
         <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 6h16v12H4z"/><path d="m4 7 8 6 8-6"/></svg>
       </div>
       <div class="person__main">
         <div class="person__email">${inv.email}</div>
         <div class="person__meta">Invited as ${inv.role} · ${when(inv.created_at)}</div>
       </div>`;

    if (state.isOwner) {
      const actions = document.createElement('div');
      actions.className = 'person__actions';
      const cancel = document.createElement('button');
      cancel.type = 'button';
      cancel.className = 'chip-btn chip-btn--danger';
      cancel.setAttribute('data-press', '');
      cancel.textContent = 'Cancel';
      cancel.addEventListener('click', async () => {
        showError(null); showOk(null);
        const { error } = await db.rpc('cancel_invite', { p_invite_id: inv.id });
        if (error) { showError(error.message); return; }
        showOk(`Invitation to ${inv.email} cancelled.`);
        await loadInvites();
      });
      actions.appendChild(cancel);
      row.appendChild(actions);
    }

    wrap.appendChild(row);
  });
}

document.querySelectorAll('[data-segment="role"] button').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('[data-segment="role"] button').forEach((b) =>
      b.setAttribute('aria-pressed', String(b === btn)));
    state.inviteRole = btn.getAttribute('data-value');
  });
});

$('inviteBtn').addEventListener('click', async () => {
  const email = $('inviteEmail').value.trim();
  if (!email) { showError('Enter an email address.'); return; }

  const btn = $('inviteBtn');
  btn.disabled = true;
  btn.textContent = 'Inviting…';
  showError(null); showOk(null);

  const { error } = await db.rpc('invite_person', {
    p_farm_id: state.farm.id,
    p_email: email,
    p_role: state.inviteRole
  });

  btn.disabled = false;
  btn.textContent = 'Send invitation';

  if (error) { showError(error.message); return; }

  $('inviteEmail').value = '';
  showOk(
    `${email} is invited as ${state.inviteRole === 'owner' ? 'an owner' : state.inviteRole === 'viewer' ? 'view-only' : 'a member'}. ` +
    `They get access the moment they sign up with that address.`
  );
  await loadInvites();
});

boot();
