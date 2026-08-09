/* =============================================================================
   Roost — shared client and helpers
   Imported by every screen so there is one connection and one set of date rules.
   ========================================================================== */

import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config.js';

export const isConfigured =
  !!SUPABASE_URL && !SUPABASE_URL.startsWith('PASTE_') &&
  !!SUPABASE_ANON_KEY && !SUPABASE_ANON_KEY.startsWith('PASTE_');

export const db = isConfigured ? createClient(SUPABASE_URL, SUPABASE_ANON_KEY) : null;

export const $ = (id) => document.getElementById(id);

/* Local calendar date, never UTC. toISOString() would roll the date over for
   anyone west of Greenwich during the evening — which is when checks get
   filled in. */
export function today() {
  return toISO(new Date());
}

export function toISO(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function daysBetween(fromISO, toISODate) {
  const a = new Date(fromISO + 'T00:00:00');
  const b = new Date(toISODate + 'T00:00:00');
  return Math.round((b - a) / 86400000);
}

/* Day N of a cycle, as a real date. */
export function dateForDay(placedOn, dayNumber) {
  const d = new Date(placedOn + 'T00:00:00');
  d.setDate(d.getDate() + (dayNumber - 1));
  return toISO(d);
}

export function formatShortDate(iso) {
  return new Date(iso + 'T00:00:00')
    .toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

export function banner(el, textEl, message) {
  if (!message) { el.hidden = true; return; }
  textEl.textContent = message;
  el.hidden = false;
}

/* The feed phase a given day falls in, matching the seeded intake curve. */
export function phaseForDay(dayNumber) {
  return dayNumber <= 14 ? 'Starter' : dayNumber <= 28 ? 'Grower' : 'Finisher';
}

/* ---------------------------------------------------------------------------
   Ross 308 as-hatched body weight, grams by day. Published breed objective —
   what the birds should weigh, not what they do weigh.

   Kept here because three screens compare against it, and three copies of a
   growth curve is three chances for them to disagree about the same flock.
   ------------------------------------------------------------------------ */
export const BREED_STANDARD = {
  0: 42, 7: 185, 14: 465, 21: 940, 28: 1560, 35: 2270, 42: 2980
};

/* Linear between the published points; flat outside them rather than
   extrapolating a curve past where the breed data stops. */
export function standardWeightAt(day) {
  const keys = Object.keys(BREED_STANDARD).map(Number).sort((a, b) => a - b);
  if (day <= keys[0]) return BREED_STANDARD[keys[0]];
  if (day >= keys[keys.length - 1]) return BREED_STANDARD[keys[keys.length - 1]];
  for (let i = 0; i < keys.length - 1; i++) {
    const a = keys[i], b = keys[i + 1];
    if (day >= a && day <= b) {
      return BREED_STANDARD[a] + (BREED_STANDARD[b] - BREED_STANDARD[a]) * ((day - a) / (b - a));
    }
  }
  return null;
}

/* ---------------------------------------------------------------------------
   Roles. A viewer can read everything and change nothing — the database
   enforces that, but a form that silently fails on save is a bad way to find
   out, so screens ask first and present themselves read-only.
   ------------------------------------------------------------------------ */
let cachedRole;

export async function myRole() {
  if (cachedRole !== undefined) return cachedRole;
  const { data, error } = await db.rpc('my_role');
  // Older databases have no my_role yet; assume full access rather than
  // locking someone out of a working app.
  cachedRole = error ? 'member' : (data || 'member');
  return cachedRole;
}

export const canEdit = (role) => role === 'owner' || role === 'member';

/* Disable every control inside a container and explain why once. */
export function lockForViewer(container, message) {
  if (!container) return;

  container.querySelectorAll('input, textarea, select, button').forEach((el) => {
    el.disabled = true;
  });

  const note = document.createElement('div');
  note.className = 'banner banner--warn viewer-note';
  note.innerHTML =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
    'stroke-linecap="round" aria-hidden="true"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z"/>' +
    '<circle cx="12" cy="12" r="3"/></svg><div>' +
    (message || 'You have view-only access, so nothing here can be changed.') +
    '</div>';

  container.prepend(note);
}

/* The open cycle: most recent placement not yet closed. */
export async function loadOpenCycle() {
  const { data, error } = await db
    .from('cycles')
    .select('id, label, placed_on, birds_placed, target_sale_age, closed_at')
    .is('closed_at', null)
    .order('placed_on', { ascending: false })
    .limit(1);

  if (error) throw new Error(`Could not load the cycle: ${error.message}`);
  if (!data || !data.length) throw new Error('No open cycle found. Start one before recording checks.');
  return data[0];
}
