/* =============================================================================
   Roost — dashboard

   What you land on after signing in. Answers, in order: is today's check done,
   where in the grow-out are we, how are the birds converting feed, and where
   does the cycle land financially.

   Measured figures and modelled ones are labelled apart throughout. Mortality,
   feed and conversion are what was recorded; breakeven and result come from the
   assumptions until processing runs exist.
   ========================================================================== */

import {
  db, isConfigured, $, today, daysBetween, banner, loadOpenCycle
} from './db.js';

const screens = { setup: $('setupScreen'), auth: $('authScreen'), app: $('appScreen') };
const show = (n) => Object.entries(screens).forEach(([k, el]) => { el.hidden = k !== n; });
const showError = (m) => banner($('appError'), $('appErrorText'), m);
const showAuthError = (m) => banner($('authError'), $('authErrorText'), m);
const showAuthOk = (m) => banner($('authOk'), $('authOkText'), m);

if (!isConfigured) { show('setup'); throw new Error('Supabase is not configured'); }

const NS = 'http://www.w3.org/2000/svg';
const LB_PER_KG = 0.45359237;
const FCR_LOW = 1.55, FCR_HIGH = 1.65;

/* Ross 308 as-hatched objective, grams by day — the same table the weights
   screen uses, so an estimated conversion here matches one shown there. */
const STANDARD = { 0: 42, 7: 185, 14: 465, 21: 940, 28: 1560, 35: 2270, 42: 2980 };

const num = (n, d = 0) =>
  Number(n ?? 0).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });

const money = (v) => {
  const n = Number(v ?? 0);
  const s = Math.abs(n) >= 1000 ? num(Math.abs(n) / 1000, 1) + 'k' : num(Math.abs(n));
  return (n < 0 ? '−$' : '$') + s;
};

function standardAt(day) {
  const keys = Object.keys(STANDARD).map(Number).sort((a, b) => a - b);
  if (day <= keys[0]) return STANDARD[keys[0]];
  if (day >= keys[keys.length - 1]) return STANDARD[keys[keys.length - 1]];
  for (let i = 0; i < keys.length - 1; i++) {
    const a = keys[i], b = keys[i + 1];
    if (day >= a && day <= b) return STANDARD[a] + (STANDARD[b] - STANDARD[a]) * ((day - a) / (b - a));
  }
  return null;
}

const el = (tag, attrs, text) => {
  const n = document.createElementNS(NS, tag);
  Object.entries(attrs).forEach(([k, v]) => n.setAttribute(k, v));
  if (text != null) n.textContent = text;
  return n;
};

/* ---------- Auth ---------------------------------------------------------- */
/* Two modes on one form. Signing up creates a farm and makes you its owner;
   joining an existing farm happens through an invitation link instead, never
   here, or two people would each own a farm while believing they shared one. */
let authMode = 'signin';

document.querySelectorAll('[data-segment="mode"] button').forEach((btn) => {
  btn.addEventListener('click', () => {
    authMode = btn.getAttribute('data-value');
    document.querySelectorAll('[data-segment="mode"] button').forEach((b) =>
      b.setAttribute('aria-pressed', String(b === btn)));

    const signingUp = authMode === 'signup';
    $('farmNameField').hidden = !signingUp;
    $('farmName').required = signingUp;
    $('password').autocomplete = signingUp ? 'new-password' : 'current-password';
    $('authSubhead').textContent = signingUp
      ? 'Name your farm and you are in.'
      : 'Sign in to your farm.';
    $('signInBtn').textContent = signingUp ? 'Create my farm' : 'Sign in';
    $('inviteHint').hidden = !signingUp;
    showAuthError(null);
    showAuthOk(null);
  });
});

/* After signing up there is nothing to do but confirm the email, so the form
   gets out of the way and says so. The credentials are deliberately left in
   the form rather than cleared: the way back is a view change, not a page
   load, so once they have clicked the link in the email the password is still
   there and signing in is one press. */
let confirmTimer = null;

function awaitConfirmation(email, farmName) {
  $('authForm').hidden = true;
  document.querySelector('[data-segment="mode"]').hidden = true;
  $('authSubhead').hidden = true;
  $('confirmEmail').textContent = email;
  $('confirmFarm').textContent = `${farmName} is created.`;
  $('confirmPanel').hidden = false;
  $('inviteHint').hidden = true;

  let left = 20;
  $('confirmCount').textContent = left;
  clearInterval(confirmTimer);
  confirmTimer = setInterval(() => {
    left -= 1;
    $('confirmCount').textContent = Math.max(0, left);
    if (left <= 0) backToSignIn();
  }, 1000);
}

function backToSignIn() {
  clearInterval(confirmTimer);
  confirmTimer = null;
  $('confirmPanel').hidden = true;
  $('authForm').hidden = false;
  document.querySelector('[data-segment="mode"]').hidden = false;
  $('authSubhead').hidden = false;
  document.querySelector('[data-segment="mode"] button[data-value="signin"]').click();
  showAuthOk('Confirm the email, then sign in — your details are still here.');
}

$('backToSignIn').addEventListener('click', backToSignIn);

$('authForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  showAuthError(null);
  showAuthOk(null);

  const btn = $('signInBtn');
  const email = $('email').value.trim();
  const password = $('password').value;

  if (authMode === 'signup') {
    const farmName = $('farmName').value.trim();
    if (!farmName) { showAuthError('Give your farm a name.'); return; }

    btn.disabled = true; btn.textContent = 'Creating…';

    // The farm itself is created by a database trigger reading this name, so
    // the farm and its owner appear together or not at all.
    //
    // emailRedirectTo is set explicitly because the confirmation link
    // otherwise goes to the project's Site URL, which defaults to localhost —
    // a link that cannot possibly work for anyone. This sends them to this
    // app, where supabase-js reads the tokens out of the URL and signs them
    // in on arrival.
    const { data, error } = await db.auth.signUp({
      email,
      password,
      options: {
        data: { farm_name: farmName },
        emailRedirectTo: new URL('./', window.location.href).href
      }
    });

    btn.disabled = false; btn.textContent = 'Create my farm';

    if (error) {
      showAuthError(error.message.match(/already registered/i)
        ? 'That email already has an account. Sign in instead.'
        : error.message);
      return;
    }

    // With email confirmation switched on there is no session yet, and saying
    // "you're in" when they are not is worse than saying nothing.
    if (!data.session) {
      awaitConfirmation(email, farmName);
      return;
    }
    boot();
    return;
  }

  btn.disabled = true; btn.textContent = 'Signing in…';

  const { error } = await db.auth.signInWithPassword({ email, password });

  btn.disabled = false; btn.textContent = 'Sign in';
  if (error) {
    showAuthError(error.message === 'Invalid login credentials'
      ? 'That email and password combination was not recognised.'
      : error.message);
    return;
  }
  boot();
});

$('signOutBtn').addEventListener('click', async () => {
  await db.auth.signOut();
  show('auth');
});

/* ---------- Load ---------------------------------------------------------- */
async function boot() {
  const { data: { session } } = await db.auth.getSession();
  if (!session) { show('auth'); return; }

  show('app');
  showError(null);

  // Which farm this is, before anything else. A farm with no cycle yet still
  // has a name, and the load below returns early in that case — so asking for
  // it afterwards would leave a brand new farm with nothing on screen naming
  // it at all.
  const { data: farms } = await db.from('farms').select('id, name').order('id').limit(1);
  if (farms && farms.length) $('barTitle').textContent = farms[0].name;

  let cycle;
  try { cycle = await loadOpenCycle(); }
  catch (e) {
    showError(e.message + ' Start one from New cycle below.');
    $('todayCard').hidden = true;
    return;
  }

  const day = Math.max(1, Math.min(
    daysBetween(cycle.placed_on, today()) + 1, cycle.target_sale_age));

  // The bar keeps the farm name — with more than one farm in the project, that
  // is the thing worth being certain of at a glance. The cycle names itself in
  // its own panel just below.
  $('cycleTitle').textContent = cycle.label;
  $('dayBig').textContent = `Day ${day}`;
  $('dayOf').textContent = `of ${cycle.target_sale_age}`;

  renderLifeBar(day, cycle.target_sale_age);

  const [progress, todayRows, samples, bags, assumptions, plan, pnl] = await Promise.all([
    db.from('v_cycle_progress').select('*').eq('cycle_id', cycle.id).maybeSingle(),
    db.from('daily_checks').select('session').eq('cycle_id', cycle.id).eq('day_number', day),
    db.from('sample_weights').select('day_number, avg_weight_g')
      .eq('cycle_id', cycle.id).order('day_number'),
    db.from('feed_bag_openings').select('opened_on').eq('cycle_id', cycle.id),
    db.from('cycle_assumptions').select('bag_size_kg, live_weight_lb')
      .eq('cycle_id', cycle.id).maybeSingle(),
    db.from('v_cycle_feed_plan').select('week, weekly_kg').eq('cycle_id', cycle.id).order('week'),
    db.from('v_cycle_pnl').select('*').eq('cycle_id', cycle.id).maybeSingle()
  ]);

  renderToday(day, todayRows.data || [], todayRows.error);
  renderFlock(progress.data, cycle);
  renderFcr({
    cycle, day,
    samples: samples.data || [],
    bags: bags.data || [],
    bagSize: Number(assumptions.data?.bag_size_kg ?? 30),
    birdsAlive: Number(progress.data?.birds_alive ?? cycle.birds_placed),
    modelledLb: Number(assumptions.data?.live_weight_lb ?? 5.5)
  });
  renderFeed({ day, cycle, plan: plan.data || [], bags: bags.data || [],
               bagSize: Number(assumptions.data?.bag_size_kg ?? 30) });
  renderMoney(pnl.data);
}

/* ---------- Today's check ------------------------------------------------- */
function renderToday(day, rows, error) {
  const expected = day <= 14 ? 2 : 1;
  const done = new Set(rows.map((r) => r.session));
  const card = $('todayCard');
  const wrap = $('todaySessions');
  wrap.textContent = '';

  // Before migration 010 there is no session column; fail soft rather than
  // blocking the whole dashboard on it.
  if (error) {
    $('todayState').textContent = 'Open the daily check';
    $('todayLabel').textContent = `Day ${day}`;
    return;
  }

  $('todayLabel').textContent = `Day ${day}`;

  if (expected === 2) {
    const parts = [['AM', 'Morning'], ['PM', 'Afternoon']];
    const missing = parts.filter(([k]) => !done.has(k));

    parts.forEach(([key, label]) => {
      const chip = document.createElement('span');
      chip.className = 'sess' + (done.has(key) ? ' sess--done' : '');
      chip.textContent = label;
      wrap.appendChild(chip);
    });

    $('todayState').textContent =
      missing.length === 0 ? 'Both checks recorded'
      : missing.length === 2 ? 'Neither check done yet'
      : `${missing[0][1]} check still to do`;
    card.classList.toggle('today--done', missing.length === 0);
  } else {
    const isDone = done.size > 0;
    $('todayState').textContent = isDone ? 'Recorded' : 'Not recorded yet';
    card.classList.toggle('today--done', isDone);
  }
}

/* ---------- Life cycle bar ------------------------------------------------ */
function renderLifeBar(day, target) {
  const W = 340, H = 58, L = 2, R = 2, BAR_Y = 16, BAR_H = 14;
  const segs = $('lifeSegs'), labels = $('lifeLabels'), marker = $('lifeMarker');
  [segs, labels, marker].forEach((g) => { g.textContent = ''; });

  const phases = [
    { name: 'Starter',  from: 0,  to: Math.min(14, target), tone: .30 },
    { name: 'Grower',   from: 14, to: Math.min(28, target), tone: .55 },
    { name: 'Finisher', from: 28, to: target,               tone: .95 }
  ].filter((p) => p.to > p.from);

  const x = (d) => L + (d / target) * (W - L - R);

  phases.forEach((p) => {
    segs.appendChild(el('rect', {
      x: x(p.from) + 1, y: BAR_Y, width: Math.max(0, x(p.to) - x(p.from) - 2), height: BAR_H,
      rx: 7, fill: 'var(--accent)', opacity: p.tone
    }));
    labels.appendChild(el('text', {
      x: (x(p.from) + x(p.to)) / 2, y: BAR_Y + BAR_H + 14,
      'text-anchor': 'middle', 'font-size': '9.5', fill: 'var(--ink-3)'
    }, p.name));
  });

  // Where the flock is now
  const px = x(day);
  marker.appendChild(el('line', {
    x1: px, x2: px, y1: BAR_Y - 6, y2: BAR_Y + BAR_H + 3,
    stroke: 'var(--ink)', 'stroke-width': 2.5, 'stroke-linecap': 'round'
  }));
  marker.appendChild(el('circle', { cx: px, cy: BAR_Y - 8, r: 3.5, fill: 'var(--ink)' }));
}

/* ---------- Flock --------------------------------------------------------- */
function renderFlock(progress, cycle) {
  if (!progress) return;

  $('birdsAlive').textContent = num(progress.birds_alive);
  $('daysLeft').textContent = num(progress.days_remaining);

  const m = progress.mortality_to_date;
  const pct = m == null ? 0 : Number(m) * 100;
  const mEl = $('mortality');
  mEl.textContent = `${num(pct, 1)}%`;
  // 3–5% is the usual band for a healthy 42-day cycle.
  mEl.style.color = pct > 5 ? 'var(--warn)' : '';

  const day = Math.max(1, daysBetween(cycle.placed_on, today()) + 1);
  const phase = day <= 14 ? 'Starter' : day <= 28 ? 'Grower' : 'Finisher';
  $('phasePill').textContent = phase;
}

/* ---------- Feed conversion ----------------------------------------------- */
function renderFcr({ cycle, day, samples, bags, bagSize, birdsAlive, modelledLb }) {
  const bandG = $('fcrBand'), barsG = $('fcrBars'), labelsG = $('fcrLabels');
  [bandG, barsG, labelsG].forEach((g) => { g.textContent = ''; });

  // Feed consumed up to a given day, from bags actually opened.
  const openedByDay = bags
    .map((b) => daysBetween(cycle.placed_on, b.opened_on) + 1)
    .sort((a, b) => a - b);

  const feedTo = (d) => openedByDay.filter((x) => x <= d).length * bagSize;

  // One point per weighing: feed drawn by then, over live mass at that weight.
  const points = samples
    .map((s) => {
      const kg = feedTo(s.day_number);
      const mass = birdsAlive * (Number(s.avg_weight_g) / 1000);
      return kg > 0 && mass > 0
        ? { day: s.day_number, fcr: kg / mass, measured: true }
        : null;
    })
    .filter(Boolean);

  const totalFeed = feedTo(day);

  if (!points.length) {
    // No weighing yet: fall back to the breed curve, and say so plainly.
    const est = standardAt(day) / 1000;
    const mass = birdsAlive * est;
    const fcr = totalFeed > 0 && mass > 0 ? totalFeed / mass : null;

    $('fcrNow').textContent = fcr ? num(fcr, 2) : '—';
    $('fcrBasis').textContent = fcr
      ? 'Estimated from the breed growth curve — no weighing recorded yet.'
      : 'Needs bag openings and a weighing before it can be worked out.';
    $('fcrNote').textContent = fcr
      ? 'Weigh ten birds and this becomes a measurement rather than an estimate.'
      : '';
    if (fcr) drawFcrChart([{ day, fcr, measured: false }]);
    return;
  }

  const latest = points[points.length - 1];
  $('fcrNow').textContent = num(latest.fcr, 2);
  $('fcrBasis').textContent =
    `Measured at day ${latest.day} · ${num(totalFeed, 0)} kg drawn across ${num(birdsAlive)} birds.`;

  const bandNote = 'The shaded band is the 1.55–1.65 breed objective. ';
  $('fcrNote').textContent = bandNote + (
    latest.fcr <= FCR_HIGH
      ? 'At or inside the breed objective. The 1.90 the planner predicts looks like an artefact of the intake assumptions rather than the birds.'
      : latest.fcr <= 1.8
        ? 'Above the objective but not alarming — the ratio usually worsens through the finisher phase, not before it.'
        : 'Well above the objective. At roughly two thirds of cycle cost, every 0.1 here is about $660.');

  drawFcrChart(points);
}

function drawFcrChart(points) {
  const W = 340, H = 150, L = 34, R = 8, T = 10, B = 24;
  const bandG = $('fcrBand'), barsG = $('fcrBars'), labelsG = $('fcrLabels');

  const maxFcr = Math.max(2.2, ...points.map((p) => p.fcr)) * 1.05;
  const y = (v) => H - B - (v / maxFcr) * (H - T - B);

  // The breed objective, drawn as a band rather than a line — it is a range.
  bandG.appendChild(el('rect', {
    x: L, y: y(FCR_HIGH), width: W - L - R, height: Math.max(1, y(FCR_LOW) - y(FCR_HIGH)),
    fill: 'var(--accent)', opacity: .16
  }));
  // The band is labelled in the caption rather than on the chart — at this
  // width the text collided with the right-hand bar's value.

  const slot = (W - L - R) / points.length;
  const barW = Math.min(38, slot * 0.6);

  points.forEach((p, i) => {
    const cx = L + slot * (i + 0.5);
    const over = p.fcr > FCR_HIGH;

    barsG.appendChild(el('rect', {
      x: cx - barW / 2, y: y(p.fcr), width: barW, height: Math.max(1, (H - B) - y(p.fcr)),
      rx: 5,
      fill: over ? 'var(--warn)' : 'var(--accent)',
      opacity: p.measured ? 1 : .45
    }));

    labelsG.appendChild(el('text', {
      x: cx, y: y(p.fcr) - 5, 'text-anchor': 'middle',
      'font-size': '10', 'font-weight': '600', fill: 'var(--ink)'
    }, num(p.fcr, 2)));

    labelsG.appendChild(el('text', {
      x: cx, y: H - 8, 'text-anchor': 'middle', 'font-size': '9', fill: 'var(--ink-3)'
    }, p.measured ? `Day ${p.day}` : 'est.'));
  });

  [0, 1, 2].forEach((v) => {
    if (v > maxFcr) return;
    labelsG.appendChild(el('text', {
      x: L - 6, y: y(v) + 3, 'text-anchor': 'end', 'font-size': '9', fill: 'var(--ink-3)'
    }, v.toFixed(1)));
  });
}

/* ---------- Feed against plan --------------------------------------------- */
function renderFeed({ day, cycle, plan, bags, bagSize }) {
  if (!plan.length) return;

  // Each week's requirement spread across its seven days.
  let plannedKg = 0;
  plan.forEach((w) => {
    const start = (w.week - 1) * 7;
    plannedKg += (Number(w.weekly_kg) / 7) * Math.min(7, Math.max(0, day - start));
  });

  const plannedBags = plannedKg / bagSize;
  const actualBags = bags.length;
  const max = Math.max(plannedBags, actualBags, 1);

  $('bagsActual').textContent = `${num(actualBags)} bags`;
  $('bagsPlanned').textContent = `${num(plannedBags, 1)} bags`;
  $('bagsActualBar').style.width = `${(actualBags / max * 100).toFixed(1)}%`;
  $('bagsPlannedBar').style.width = `${(plannedBags / max * 100).toFixed(1)}%`;

  const diff = actualBags - plannedBags;
  const pct = plannedBags > 0 ? (diff / plannedBags) * 100 : 0;
  $('feedVariance').textContent = actualBags === 0
    ? 'no bags recorded'
    : Math.abs(pct) < 5
      ? 'on plan'
      : `${num(Math.abs(diff), 1)} bags ${diff > 0 ? 'ahead' : 'behind'}`;
}

/* ---------- Money --------------------------------------------------------- */
function renderMoney(pnl) {
  if (!pnl) return;

  $('mBreakeven').textContent = `$${num(pnl.breakeven_price_lb, 2)}`;
  $('mBlended').textContent = `$${num(pnl.blended_price_lb, 2)}`;

  const profit = Number(pnl.operating_profit ?? 0);
  const p = $('mProfit');
  p.textContent = money(profit);
  p.style.color = profit < 0 ? 'var(--warn)' : 'var(--accent)';

  const gap = Number(pnl.blended_price_lb) - Number(pnl.breakeven_price_lb);
  $('moneyNote').textContent =
    (gap >= 0
      ? `Clearing breakeven by ${num(gap, 2)} a pound. `
      : `Short of breakeven by ${num(Math.abs(gap), 2)} a pound. `) +
    'Modelled from this cycle\'s assumptions, not from processing records.';
}

boot();
