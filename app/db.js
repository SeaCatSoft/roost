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
