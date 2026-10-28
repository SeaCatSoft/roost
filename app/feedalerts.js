/* =============================================================================
   Roost — low-feed alerts

   The level is decided once, in v_feed_alerts (027_feed_alerts.sql). This
   only turns it into words, so the dashboard, My Farm and the feed store can
   never disagree about whether feed is low.
   ========================================================================== */

import { db } from './db.js';

const num = (n, d = 0) =>
  Number(n ?? 0).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
const shortDate = (iso) =>
  new Date(iso + 'T00:00:00').toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });

/* Rows for one farm, or [] when 027 has not been run — an alert that cannot
   load must never stop the screen it sits on. */
export async function loadFeedAlerts(farmId) {
  const { data, error } = await db.from('v_feed_alerts').select('*').eq('farm_id', farmId);
  return error ? [] : (data || []);
}

const ICON =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" ' +
  'aria-hidden="true"><path d="M12 8.5v5M12 17h.01"/><circle cx="12" cy="12" r="9.5"/></svg>';

/* One sentence for a row, or null when there is nothing to say. */
export function alertText(r) {
  const name = r.phase.toLowerCase();
  const rate = `${num(r.bags_per_day, 1)} bag${Number(r.bags_per_day) === 1 ? '' : 's'} a day`;

  if (r.level === 'out') {
    return `Out of ${name}. The store should be empty, and the flock is using about ${rate}.`;
  }
  if (r.level === 'low') {
    const days = Number(r.days_left);
    const when = days < 1 ? 'within a day' : `in about ${num(days, days < 3 ? 1 : 0)} days (${shortDate(r.runs_out_on)})`;
    return `${r.phase} runs out ${when}: ${num(r.on_hand)} bags left at ${rate}. Time to restock.`;
  }
  return null;
}

/* Banners into `container`. Out and low only. A ration in use but never
   counted gets one quiet line, because otherwise its silence would read
   as "all fine". */
export function renderFeedAlerts(container, rows, { linkToStore = true } = {}) {
  if (!container) return;
  container.textContent = '';

  const order = { out: 0, low: 1 };
  const urgent = rows.filter((r) => r.level in order)
    .sort((a, b) => order[a.level] - order[b.level] || Number(a.days_left) - Number(b.days_left));

  urgent.forEach((r) => {
    const el = document.createElement('div');
    el.className = `banner ${r.level === 'out' ? 'banner--error' : 'banner--warn'}`;
    el.style.marginTop = '1.25rem';
    el.innerHTML = `${ICON}<div></div>`;
    el.lastChild.textContent = alertText(r) + ' ';
    if (linkToStore) {
      const a = document.createElement('a');
      a.href = 'feedstore.html';
      a.textContent = 'Feed store';
      a.style.textDecoration = 'underline';
      el.lastChild.appendChild(a);
    }
    container.appendChild(el);
  });

  const uncounted = rows.filter((r) => r.level === 'uncounted' && r.in_use);
  if (uncounted.length && linkToStore) {
    const p = document.createElement('p');
    p.className = 'caption';
    p.style.marginTop = '1rem';
    p.innerHTML = `Low-feed alerts are off for ${uncounted.map((r) => r.phase.toLowerCase()).join(' and ')} ` +
      'until the store is counted. <a href="feedstore.html" style="text-decoration:underline">Count it</a>';
    container.appendChild(p);
  }
}
