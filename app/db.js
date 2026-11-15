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

/* ---------------------------------------------------------------------------
   Pens. A farm can run several flocks at once, one per pen (030). Which pen a
   screen is looking at is remembered on the device, so someone who works pen
   2 all morning is not asked every time; ?pen=ID in the address overrides it,
   which is how links from the Pens screen open a specific one.
   ------------------------------------------------------------------------ */
const PEN_KEY = 'roost.pen';

export function selectedPenId() {
  const fromUrl = new URLSearchParams(window.location.search).get('pen');
  if (fromUrl && /^\d+$/.test(fromUrl)) { selectPen(Number(fromUrl)); return Number(fromUrl); }
  try {
    const saved = localStorage.getItem(PEN_KEY);
    return saved && /^\d+$/.test(saved) ? Number(saved) : null;
  } catch { return null; }   // private windows can refuse storage
}

export function selectPen(id) {
  try { localStorage.setItem(PEN_KEY, String(id)); } catch { /* remembered for this page only */ }
}

/* Active pens of the farm, each with the flock in it and its contract.
   null when 030 has not been run — callers fall back to the single-flock
   behaviour rather than breaking. */
export async function loadPens() {
  const { data, error } = await db.from('v_pens').select('*').eq('active', true)
    .order('farm_id').order('house_id');
  if (error) return null;
  if (!data || !data.length) return [];
  // More than one farm on an account still shows the lowest-id one, the same
  // rule every other screen uses.
  return data.filter((p) => p.farm_id === data[0].farm_id);
}

/* What a contract price means, in words: "$1.85 per lb live". */
export function contractPriceText(k) {
  const unit = { per_lb: 'per lb live', per_kg: 'per kg live', per_bird: 'per bird' }[k.price_basis];
  return `$${Number(k.price).toFixed(2)} ${unit}`;
}

/* A pen picker in the app bar, shown only when there is a choice to make.
   Changing it reloads the screen on the other pen's flock. */
export function mountPenSwitcher(pens, currentId) {
  const bar = document.querySelector('.app-bar');
  if (!bar || pens.length < 2 || document.getElementById('penSwitcher')) return;

  const sel = document.createElement('select');
  sel.id = 'penSwitcher';
  sel.className = 'pen-switch';
  sel.setAttribute('aria-label', 'Pen');
  pens.forEach((p) => {
    const o = document.createElement('option');
    o.value = p.house_id;
    o.textContent = p.cycle_id ? p.name : `${p.name} (empty)`;
    o.disabled = !p.cycle_id;
    o.selected = p.house_id === currentId;
    sel.appendChild(o);
  });
  sel.addEventListener('change', () => {
    selectPen(Number(sel.value));
    const url = new URL(window.location.href);
    url.searchParams.delete('pen');
    window.location.replace(url);
  });

  const spacer = bar.querySelector('.app-bar__spacer');
  bar.insertBefore(sel, spacer ? spacer.nextSibling : null);
}

/* The pen a screen should show: the remembered one if it still has a flock,
   otherwise the first that does. null when no pen has a flock. For screens
   that load their own cycle rather than going through loadOpenCycle. */
export function currentPen(pens) {
  const stocked = (pens || []).filter((p) => p.cycle_id);
  if (!stocked.length) return null;
  const wanted = selectedPenId();
  const pen = stocked.find((p) => p.house_id === wanted) || stocked[0];
  selectPen(pen.house_id);
  return pen;
}

/* The open cycle of the pen being worked on. With one pen this is simply the
   farm's open cycle, as before. The cycle comes back with its pen attached
   (cycle.pen: name, contract terms), and the switcher is mounted on the way. */
export async function loadOpenCycle() {
  const pens = await loadPens();
  let query = db.from('cycles')
    .select('id, label, breed, house_id, placed_on, birds_placed, target_sale_age, closed_at')
    .is('closed_at', null);

  let pen = null;
  if (pens && pens.length) {
    pen = currentPen(pens);
    if (!pen) throw new Error('No open cycle found. Start one before recording checks.');
    query = query.eq('id', pen.cycle_id);
  } else {
    query = query.order('placed_on', { ascending: false }).limit(1);
  }

  const { data, error } = await query;
  if (error) throw new Error(`Could not load the cycle: ${error.message}`);
  if (!data || !data.length) throw new Error('No open cycle found. Start one before recording checks.');

  if (pen) mountPenSwitcher(pens, pen.house_id);
  return { ...data[0], pen };
}
