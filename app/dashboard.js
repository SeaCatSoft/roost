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
  db, isConfigured, $, today, daysBetween, banner, loadOpenCycle,
  myRole, standardWeightAt as standardAt
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

const num = (n, d = 0) =>
  Number(n ?? 0).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });

const money = (v) => {
  const n = Number(v ?? 0);
  const s = Math.abs(n) >= 1000 ? num(Math.abs(n) / 1000, 1) + 'k' : num(Math.abs(n));
  return (n < 0 ? '−$' : '$') + s;
};


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

  // Owners land on My Farm — the money and the plan are what they open the app
  // for. ?flock=1 is how they get here deliberately, and is what every link
  // back from My Farm carries, so this cannot become a redirect loop.
  const role = await myRole();
  const wantsFlock = new URLSearchParams(window.location.search).has('flock');
  if (role === 'owner' && !wantsFlock) {
    window.location.replace('farm.html');
    return;
  }

  show('app');
  showError(null);

  // Owner-only screens are hidden from everyone else. The database refuses
  // them regardless (016); this is so nobody is offered a door that is locked.
  if (role !== 'owner') {
    document.querySelectorAll('[data-owner-only]').forEach((el) => { el.hidden = true; });
  }
  $('farmTile').hidden = role !== 'owner';

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

  const [progress, todayRows, samples, bags, assumptions, plan, pnl,
         feedForecast, mortForecast, dailyChecks] = await Promise.all([
    db.from('v_cycle_progress').select('*').eq('cycle_id', cycle.id).maybeSingle(),
    db.from('daily_checks').select('session').eq('cycle_id', cycle.id).eq('day_number', day),
    db.from('sample_weights').select('day_number, avg_weight_g')
      .eq('cycle_id', cycle.id).order('day_number'),
    db.from('feed_bag_openings').select('opened_on').eq('cycle_id', cycle.id),
    db.from('cycle_assumptions').select('bag_size_kg, live_weight_lb, mortality_rate')
      .eq('cycle_id', cycle.id).maybeSingle(),
    db.from('v_cycle_feed_plan').select('week, weekly_kg').eq('cycle_id', cycle.id).order('week'),
    db.from('v_cycle_pnl').select('*').eq('cycle_id', cycle.id).maybeSingle(),
    // Written once a day by the forecast job (backend/forecast/), never by
    // the app. Older databases have no cycle_forecasts table yet — fail
    // soft, same as the session column check above, rather than blocking
    // the rest of the dashboard on a table that might not exist.
    db.from('cycle_forecasts').select('*').eq('cycle_id', cycle.id)
      .eq('metric', 'feed_bags').order('generated_at', { ascending: false })
      .limit(1).maybeSingle(),
    db.from('cycle_forecasts').select('*').eq('cycle_id', cycle.id)
      .eq('metric', 'mortality').order('generated_at', { ascending: false })
      .limit(1).maybeSingle(),
    // For the simple forecast's mortality series — cumulative losses need
    // every day up to today, not just today's, which is all the today-card
    // query above asks for.
    db.from('daily_checks').select('day_number, mortality, culls')
      .eq('cycle_id', cycle.id).lte('day_number', day)
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

  const simpleFeed = computeSimpleFeedForecast({
    day, target: cycle.target_sale_age, plan: plan.data || [],
    bags: bags.data || [], bagSize: Number(assumptions.data?.bag_size_kg ?? 30),
    placedOn: cycle.placed_on
  });
  const simpleMortality = computeSimpleMortalityForecast({
    day, target: cycle.target_sale_age, birdsPlaced: cycle.birds_placed,
    mortalityRate: Number(assumptions.data?.mortality_rate ?? 0.05),
    dailyChecks: dailyChecks.data || []
  });
  renderForecast({ simpleFeed, mlFeed: feedForecast.data, simpleMortality, mlMortality: mortForecast.data });
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
/* Each week's requirement spread evenly across its seven days. Shared by the
   bags-vs-plan bars below and the simple forecast further down, so "planned
   bags by day X" means the same number in both places rather than two
   almost-identical formulas drifting apart over time. */
function plannedCumulativeBagsAt(plan, bagSize, day) {
  let kg = 0;
  plan.forEach((w) => {
    const start = (w.week - 1) * 7;
    kg += (Number(w.weekly_kg) / 7) * Math.min(7, Math.max(0, day - start));
  });
  return kg / bagSize;
}

function renderFeed({ day, cycle, plan, bags, bagSize }) {
  if (!plan.length) return;

  const plannedBags = plannedCumulativeBagsAt(plan, bagSize, day);
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

/* ---------- Forecast (written by backend/forecast/, never by this file) --- */
function forecastDelta(pct, overWord, underWord) {
  const abs = Math.abs(pct);
  if (abs < 5) return 'on plan';
  return `${num(abs, 0)}% ${pct > 0 ? overWord : underWord}`;
}

/* Pure arithmetic against the plan total, not a new prediction: what pace
   would still hit the original plan by the end of the cycle. This stops
   short of recommending a feeding change for the birds themselves — that's
   a husbandry call, not a software one — it only answers the bag-buying
   question directly in front of it. */
function feedPaceNote(feed) {
  const target = feed.series.length;
  const remainingDays = target - feed.as_of_day;
  if (remainingDays <= 0) return '';

  const actualNow = Number(feed.series[feed.as_of_day - 1]?.actual ?? 0);
  const currentPace = feed.as_of_day > 0 ? actualNow / feed.as_of_day : 0;
  const remainingNeeded = Number(feed.planned_total) - actualNow;

  if (remainingNeeded <= 0) {
    return `Already at or ahead of the ${num(feed.planned_total, 0)}-bag plan total — ` +
      `no need to increase pace to stay on it.`;
  }

  const neededPace = remainingNeeded / remainingDays;
  return `To still land on the original ${num(feed.planned_total, 0)}-bag plan by day ${target}, ` +
    `that's ${num(neededPace, 1)} bags/day for the remaining ${num(remainingDays)} days ` +
    `— currently averaging ${num(currentPace, 1)}/day. Worth confirming this is a real gap ` +
    `and not a bag that went unrecorded before changing anything.`;
}

/* ---------- Simple forecast: pure arithmetic, no model, always available --
   The same question the TimesFM job answers (backend/forecast/), by a
   different, fully transparent method: how far off the plan's own shape is
   this cycle running so far, and what does that ratio imply if it holds for
   the rest of the cycle. Needs nothing turned on, costs nothing to compute,
   and — because both are shown together, labelled by method — this is also
   the honest way to find out whether the ML version is actually adding
   anything: watch the two side by side as cycles close.

   Deliberately not a flat extrapolation of "the rate so far": feed intake
   ramps up hard from Starter to Finisher, so a flat rate from an early day
   would understate the finish badly. Scaling the plan's own curve by the
   observed over/under-run ratio respects that shape while still reacting to
   this cycle's real pace — the same technique the processing planner
   (planning.js) and My Farm's own forecast (farm.js) already use for weight.

   Same minimum-days floor as the ML job, and for the same reason: a ratio
   taken from one or two noisy early days is more likely to mislead than
   inform, on either method. */
const SIMPLE_FORECAST_MIN_DAYS = 5;

function plannedCumulativeMortalityAt(birdsPlaced, mortalityRate, target, day) {
  // No stored day-by-day mortality curve exists — only the single assumed
  // rate — so a straight-line spread across the cycle is the plan here, a
  // reference line rather than a real curve. This matches exactly what the
  // forecast job assumes for the same reason, so the two "planned" lines
  // agree and the comparison is fair.
  const total = birdsPlaced * mortalityRate;
  return total * (Math.min(day, target) / target);
}

function computeSimpleFeedForecast({ day, target, plan, bags, bagSize, placedOn }) {
  if (!plan.length || day < SIMPLE_FORECAST_MIN_DAYS) return null;

  const plannedSoFar = plannedCumulativeBagsAt(plan, bagSize, day);
  const plannedTotal = plannedCumulativeBagsAt(plan, bagSize, target);
  if (plannedSoFar <= 0 || plannedTotal <= 0) return null;

  // Cumulative bags opened, one entry per day of the cycle so far — the
  // chart's solid "actual" line needs the whole trail, not just today's
  // total, the same as the ML forecast's own series does.
  const opensByDay = new Array(day + 1).fill(0);
  bags.forEach((b) => {
    const d = daysBetween(placedOn, b.opened_on) + 1;
    if (d >= 1 && d <= day) opensByDay[d] += 1;
  });
  const actualCum = new Array(day + 1).fill(0);
  for (let d = 1; d <= day; d++) actualCum[d] = actualCum[d - 1] + opensByDay[d];
  const actualSoFar = actualCum[day];

  const pace = actualSoFar / plannedSoFar;
  const projectedTotal = plannedTotal * pace;

  const series = [];
  let prevProjected = actualSoFar;
  for (let d = 1; d <= target; d++) {
    const planned = plannedCumulativeBagsAt(plan, bagSize, d);
    let forecast = null;
    if (d > day) {
      // The plan's own shape (Starter low, Finisher high) scaled by how far
      // off it this cycle has run so far — not a flat rate, which would
      // badly understate a cycle still early in Starter.
      const raw = actualSoFar + pace * (planned - plannedSoFar);
      prevProjected = Math.max(prevProjected, raw); // a cumulative count never falls
      forecast = prevProjected;
    }
    series.push({
      day: d,
      actual: d <= day ? actualCum[d] : null,
      planned: Math.round(planned * 100) / 100,
      forecast: forecast == null ? null : Math.round(forecast * 100) / 100
    });
  }

  const deviationPct = ((projectedTotal - plannedTotal) / plannedTotal) * 100;
  return { as_of_day: day, projected_total: projectedTotal, planned_total: plannedTotal,
           deviation_pct: deviationPct, series };
}

function computeSimpleMortalityForecast({ day, target, birdsPlaced, mortalityRate, dailyChecks }) {
  if (day < SIMPLE_FORECAST_MIN_DAYS || !dailyChecks.length) return null;

  const plannedSoFar = plannedCumulativeMortalityAt(birdsPlaced, mortalityRate, target, day);
  const plannedTotal = birdsPlaced * mortalityRate;
  if (plannedSoFar <= 0 || plannedTotal <= 0) return null;

  const lossByDay = new Array(day + 1).fill(0);
  dailyChecks.forEach((c) => {
    const d = c.day_number;
    if (d >= 1 && d <= day) lossByDay[d] += (c.mortality || 0) + (c.culls || 0);
  });
  const actualCum = new Array(day + 1).fill(0);
  for (let d = 1; d <= day; d++) actualCum[d] = actualCum[d - 1] + lossByDay[d];
  const actualSoFar = actualCum[day];

  const pace = actualSoFar / plannedSoFar;
  const rawProjectedTotal = plannedTotal * pace;
  // Can't lose more birds than remain alive — the same physical clamp the
  // forecast job applies, for the same reason: a model or a ratio can both
  // extrapolate past what's physically possible if nothing stops it.
  const cap = birdsPlaced - actualSoFar;
  const projectedTotal = Math.min(rawProjectedTotal, actualSoFar + Math.max(cap, 0));

  const series = [];
  let prevProjected = actualSoFar;
  for (let d = 1; d <= target; d++) {
    const planned = plannedCumulativeMortalityAt(birdsPlaced, mortalityRate, target, d);
    let forecast = null;
    if (d > day) {
      const raw = actualSoFar + pace * (planned - plannedSoFar);
      const clamped = Math.min(raw, actualSoFar + Math.max(cap, 0));
      prevProjected = Math.max(prevProjected, clamped);
      forecast = prevProjected;
    }
    series.push({
      day: d,
      actual: d <= day ? actualCum[d] : null,
      planned: Math.round(planned * 100) / 100,
      forecast: forecast == null ? null : Math.round(forecast * 100) / 100
    });
  }

  const deviationPct = ((projectedTotal - plannedTotal) / plannedTotal) * 100;
  return { as_of_day: day, projected_total: projectedTotal, planned_total: plannedTotal,
           deviation_pct: deviationPct, series };
}

function renderForecast({ simpleFeed, mlFeed, simpleMortality, mlMortality }) {
  const panel = $('forecastPanel');
  const anything = simpleFeed || mlFeed || simpleMortality || mlMortality;
  if (!anything) { panel.hidden = true; return; }
  panel.hidden = false;

  $('feedForecastBlock').hidden = !(simpleFeed || mlFeed);
  $('mortForecastBlock').hidden = !(simpleMortality || mlMortality);

  renderForecastBlock({
    simple: simpleFeed, ml: mlFeed, overWord: 'over plan', underWord: 'under plan',
    simpleIds: FEED_SIMPLE_IDS, mlIds: FEED_ML_IDS,
    mlBasis: (f) => `Day ${f.as_of_day} of ${f.series.length} — projecting ${num(f.projected_total, 0)} ` +
      `bags against a plan of ${num(f.planned_total, 0)}.`,
    simpleBasis: (f) => `Day ${f.as_of_day} of ${f.series.length} — projecting ${num(f.projected_total, 0)} ` +
      `bags against a plan of ${num(f.planned_total, 0)}, at this cycle's own pace so far.`
  });
  if (mlFeed) $('feedForecastPace').textContent = feedPaceNote(mlFeed);

  renderForecastBlock({
    simple: simpleMortality, ml: mlMortality, overWord: 'above plan', underWord: 'below plan',
    simpleIds: MORT_SIMPLE_IDS, mlIds: MORT_ML_IDS,
    mlBasis: (f) => `Day ${f.as_of_day} of ${f.series.length} — projecting ${num(f.projected_total, 0)} ` +
      `birds lost against ${num(f.planned_total, 0)} assumed.`,
    simpleBasis: (f) => `Day ${f.as_of_day} of ${f.series.length} — projecting ${num(f.projected_total, 0)} ` +
      `birds lost against ${num(f.planned_total, 0)} assumed, at this cycle's own pace so far.`
  });

  $('forecastNote').textContent = simpleFeed || simpleMortality
    ? (mlFeed || mlMortality
        ? 'Dashed grey is the plan, solid is what actually happened, dashed colour is the projection. ' +
          'Two methods, shown separately — where they agree is a stronger signal than either alone; ' +
          'where they disagree is worth a second look before trusting either.'
        : 'Dashed grey is the plan, solid is what actually happened, dashed colour is a projection from ' +
          'this cycle\'s own pace so far — plain arithmetic, not a model.')
    : 'Dashed grey is the plan, solid is what actually happened, ' +
      'dashed colour is where the forecast projects the rest of the cycle.';
}

const FEED_SIMPLE_IDS = ['feedSimpleBlock', 'feedSimpleDelta', 'feedSimpleBasis', 'feedSimplePlan', 'feedSimpleActual', 'feedSimpleProjected', 'feedSimpleLabels'];
const FEED_ML_IDS = ['feedMlBlock', 'feedForecastDelta', 'feedForecastBasis', 'feedForecastPlan', 'feedForecastActual', 'feedForecastProjected', 'feedForecastLabels'];
const MORT_SIMPLE_IDS = ['mortSimpleBlock', 'mortSimpleDelta', 'mortSimpleBasis', 'mortSimplePlan', 'mortSimpleActual', 'mortSimpleProjected', 'mortSimpleLabels'];
const MORT_ML_IDS = ['mortMlBlock', 'mortForecastDelta', 'mortForecastBasis', 'mortForecastPlan', 'mortForecastActual', 'mortForecastProjected', 'mortForecastLabels'];

/* One metric, up to two methods. Kept as one function rather than copy-pasted
   per metric per method, since feed and mortality only ever differ in their
   wording and which computed object feeds them — the rendering itself, and
   the chart underneath it, is identical. */
function renderForecastBlock({ simple, ml, overWord, underWord, simpleIds, mlIds, mlBasis, simpleBasis }) {
  const [sBlock, sDelta, sBasisEl, sPlan, sActual, sProjected, sLabels] = simpleIds.map($);
  const [mBlock, mDelta, mBasisEl, mPlan, mActual, mProjected, mLabels] = mlIds.map($);

  sBlock.hidden = !simple;
  mBlock.hidden = !ml;

  if (simple) {
    const pct = Number(simple.deviation_pct);
    sDelta.textContent = forecastDelta(pct, overWord, underWord);
    sDelta.style.color = Math.abs(pct) > 10 ? 'var(--warn)' : '';
    sBasisEl.textContent = simpleBasis(simple);
    drawTrajectoryChart([sPlan, sActual, sProjected, sLabels], simple.series);
  }

  if (ml) {
    const pct = Number(ml.deviation_pct);
    mDelta.textContent = forecastDelta(pct, overWord, underWord);
    mDelta.style.color = Math.abs(pct) > 10 ? 'var(--warn)' : '';
    mBasisEl.textContent = mlBasis(ml);
    drawTrajectoryChart([mPlan, mActual, mProjected, mLabels], ml.series);
  }
}

/* One shared line-chart shape for both forecasts: a muted dashed plan line,
   a solid actual line up to today, and a dashed projected line continuing
   from wherever the actual line stops — so there is no visual gap between
   what happened and what's projected. */
function drawTrajectoryChart(groups, series) {
  const W = 340, H = 90, L = 4, R = 4, T = 6, B = 14;
  const [planG, actualG, forecastG, labelsG] = groups;
  [planG, actualG, forecastG, labelsG].forEach((g) => { g.textContent = ''; });

  const days = series.length;
  const max = Math.max(1, ...series.map((p) =>
    Math.max(p.actual ?? 0, p.planned ?? 0, p.forecast ?? 0))) * 1.1;

  const x = (day) => L + ((day - 1) / (days - 1)) * (W - L - R);
  const y = (v) => H - B - (v / max) * (H - T - B);

  const pathFrom = (pts) => pts.length
    ? 'M ' + pts.map((p) => `${x(p.day).toFixed(1)} ${y(p.v).toFixed(1)}`).join(' L ')
    : '';

  const plannedPts = series.map((p) => ({ day: p.day, v: p.planned }));
  const actualPts = series.filter((p) => p.actual != null).map((p) => ({ day: p.day, v: p.actual }));
  const forecastPts = series.filter((p) => p.forecast != null).map((p) => ({ day: p.day, v: p.forecast }));
  if (actualPts.length && forecastPts.length) forecastPts.unshift(actualPts[actualPts.length - 1]);

  planG.appendChild(el('path', {
    d: pathFrom(plannedPts), fill: 'none', stroke: 'var(--ink-3)',
    'stroke-width': 1.5, 'stroke-dasharray': '3 3'
  }));
  actualG.appendChild(el('path', {
    d: pathFrom(actualPts), fill: 'none', stroke: 'var(--ink)', 'stroke-width': 2.5
  }));
  forecastG.appendChild(el('path', {
    d: pathFrom(forecastPts), fill: 'none', stroke: 'var(--accent)',
    'stroke-width': 2.5, 'stroke-dasharray': '2 3'
  }));

  labelsG.appendChild(el('text', {
    x: L, y: H - 2, 'font-size': '9', fill: 'var(--ink-3)'
  }, 'Day 1'));
  labelsG.appendChild(el('text', {
    x: W - R, y: H - 2, 'text-anchor': 'end', 'font-size': '9', fill: 'var(--ink-3)'
  }, `Day ${days}`));
}

boot();
