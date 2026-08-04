/* =============================================================================
   Roost — motion system
   -----------------------------------------------------------------------------
   A small spring engine plus the gesture and scroll behaviours built on it.
   No dependencies.

   The governing idea (WWDC "Designing Fluid Interfaces"): motion starts from the
   value currently on screen, inherits the user's velocity, projects momentum
   forward, and can be grabbed and reversed at any instant. Springs give all of
   that for free — retargeting a spring keeps its current position AND velocity,
   so an interrupted animation never jumps.
   ========================================================================== */

(function () {
  'use strict';

  var reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');

  /* ---------------------------------------------------------------------------
     1. Spring
     Parameterised the way Apple exposes it to designers — damping ratio and
     response — rather than mass/stiffness/damping.
       damping  1.0 = critically damped, settles with no overshoot
                0.8 = a little bounce, for momentum-carrying gestures only
       response      seconds to approach the target. Not a duration: a spring
                     has no fixed duration, the settle emerges from the physics.
     ------------------------------------------------------------------------ */
  function Spring(value, opts) {
    opts = opts || {};
    this.value = value;
    this.target = value;
    this.velocity = 0;
    this.damping = opts.damping == null ? 1 : opts.damping;
    this.response = opts.response == null ? 0.4 : opts.response;
    this.omega = (2 * Math.PI) / this.response;
  }

  Spring.prototype.configure = function (damping, response) {
    this.damping = damping;
    this.response = response;
    this.omega = (2 * Math.PI) / response;
    return this;
  };

  // Retarget mid-flight. Position and velocity are preserved, which is exactly
  // what makes an interruption look continuous instead of like a cut.
  Spring.prototype.to = function (target, velocity) {
    this.target = target;
    if (velocity != null) this.velocity = velocity;
    return this;
  };

  Spring.prototype.set = function (value) {
    this.value = this.target = value;
    this.velocity = 0;
    return this;
  };

  // Sub-stepped integration: a large frame delta with a stiff spring is
  // unstable, so we always integrate at <= 1/240s regardless of frame rate.
  Spring.prototype.step = function (dt) {
    dt = Math.min(dt, 1 / 30);
    var steps = Math.max(1, Math.ceil(dt * 240));
    var h = dt / steps;
    for (var i = 0; i < steps; i++) {
      var accel =
        -this.omega * this.omega * (this.value - this.target) -
        2 * this.damping * this.omega * this.velocity;
      this.velocity += accel * h;
      this.value += this.velocity * h;
    }
    return this.value;
  };

  Spring.prototype.settled = function (epsilon) {
    epsilon = epsilon || 0.01;
    return (
      Math.abs(this.velocity) < epsilon &&
      Math.abs(this.value - this.target) < epsilon
    );
  };

  /* ---------------------------------------------------------------------------
     2. One ticker for every spring on the page
     ------------------------------------------------------------------------ */
  var tasks = [];
  var running = false;
  var lastTime = 0;

  function tick(now) {
    var dt = lastTime ? (now - lastTime) / 1000 : 1 / 60;
    lastTime = now;

    for (var i = tasks.length - 1; i >= 0; i--) {
      if (tasks[i](dt) === false) tasks.splice(i, 1);
    }

    if (tasks.length) {
      requestAnimationFrame(tick);
    } else {
      running = false;
      lastTime = 0;
    }
  }

  function addTask(fn) {
    tasks.push(fn);
    if (!running) {
      running = true;
      requestAnimationFrame(tick);
    }
  }

  /* ---------------------------------------------------------------------------
     3. Momentum projection — Apple's exponential-decay form
     Where a flick would come to rest if it decelerated like a scroll view.
     Note this is NOT the textbook v^2/(2a); the shipped function is below.
     ------------------------------------------------------------------------ */
  function project(velocity, decelerationRate) {
    var d = decelerationRate == null ? 0.998 : decelerationRate;
    return ((velocity / 1000) * d) / (1 - d);
  }

  // Progressive resistance past a boundary — real things slow before they stop.
  function rubberband(overshoot, dimension, constant) {
    var c = constant == null ? 0.55 : constant;
    return (overshoot * dimension * c) / (dimension + c * Math.abs(overshoot));
  }

  function clamp(v, lo, hi) {
    return v < lo ? lo : v > hi ? hi : v;
  }

  /* Tracks recent pointer samples so release velocity reflects the last few
     milliseconds of the gesture, not the whole drag. */
  function VelocityTracker() {
    this.samples = [];
  }
  VelocityTracker.prototype.add = function (value) {
    var now = performance.now();
    this.samples.push({ v: value, t: now });
    while (this.samples.length > 6) this.samples.shift();
  };
  VelocityTracker.prototype.velocity = function () {
    var s = this.samples;
    if (s.length < 2) return 0;
    var last = s[s.length - 1];
    var first = s[0];
    for (var i = s.length - 1; i >= 0; i--) {
      if (last.t - s[i].t > 100) break;
      first = s[i];
    }
    var dt = (last.t - first.t) / 1000;
    if (dt <= 0) return 0;
    return (last.v - first.v) / dt;
  };
  VelocityTracker.prototype.reset = function () {
    this.samples.length = 0;
  };

  /* =========================================================================
     4. Reveal — surfaces materialise rather than plain-fade
     Blur and scale animate together so the element reads as a real material
     arriving, not an opacity ramp.
     ====================================================================== */
  function initReveal() {
    var items = document.querySelectorAll('[data-reveal]');
    if (!('IntersectionObserver' in window)) {
      items.forEach(function (el) { el.classList.add('is-revealed'); });
      return;
    }

    var io = new IntersectionObserver(
      function (entries) {
        entries.forEach(function (entry) {
          if (!entry.isIntersecting) return;
          var el = entry.target;
          var delay = parseInt(el.getAttribute('data-reveal-delay') || '0', 10);
          setTimeout(function () { el.classList.add('is-revealed'); }, delay);
          io.unobserve(el);
        });
      },
      { rootMargin: '0px 0px -12% 0px', threshold: 0.1 }
    );

    items.forEach(function (el) { io.observe(el); });
  }

  /* =========================================================================
     5. Counters — figures count into place as they arrive
     ====================================================================== */
  function initCounters() {
    var els = document.querySelectorAll('[data-count]');
    if (!els.length) return;

    if (reduceMotion.matches || !('IntersectionObserver' in window)) {
      els.forEach(function (el) { el.textContent = el.getAttribute('data-count-display') || el.getAttribute('data-count'); });
      return;
    }

    var io = new IntersectionObserver(
      function (entries) {
        entries.forEach(function (entry) {
          if (!entry.isIntersecting) return;
          runCount(entry.target);
          io.unobserve(entry.target);
        });
      },
      { threshold: 0.4 }
    );

    els.forEach(function (el) { io.observe(el); });
  }

  function formatNumber(value, decimals, prefix, suffix) {
    var n = value.toFixed(decimals);
    var parts = n.split('.');
    parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    return prefix + parts.join('.') + suffix;
  }

  function runCount(el) {
    var to = parseFloat(el.getAttribute('data-count'));
    var decimals = parseInt(el.getAttribute('data-decimals') || '0', 10);
    var prefix = el.getAttribute('data-prefix') || '';
    var suffix = el.getAttribute('data-suffix') || '';
    var spring = new Spring(0, { damping: 1, response: 1.1 });
    spring.to(to);

    addTask(function (dt) {
      spring.step(dt);
      if (spring.settled(Math.pow(10, -decimals) / 4)) {
        el.textContent = formatNumber(to, decimals, prefix, suffix);
        return false;
      }
      el.textContent = formatNumber(spring.value, decimals, prefix, suffix);
    });
  }

  /* =========================================================================
     6. Press feedback — on pointer-DOWN, never on release
     The instant lag appears, directness falls off a cliff.
     ====================================================================== */
  function initPress() {
    document.addEventListener(
      'pointerdown',
      function (e) {
        var el = e.target.closest ? e.target.closest('[data-press]') : null;
        if (!el) return;
        el.classList.add('is-pressed');

        var release = function () {
          el.classList.remove('is-pressed');
          window.removeEventListener('pointerup', release);
          window.removeEventListener('pointercancel', release);
        };
        window.addEventListener('pointerup', release);
        window.addEventListener('pointercancel', release);
      },
      { passive: true }
    );
  }

  /* =========================================================================
     7. Hero card — pointer parallax
     X and Y are separate springs. A single spring on 2D distance desyncs the
     moment the two axes carry different velocities.
     ====================================================================== */
  function initTilt() {
    var card = document.querySelector('[data-tilt]');
    if (!card || reduceMotion.matches) return;
    if (matchMedia('(hover: none)').matches) return;

    var rx = new Spring(0, { damping: 1, response: 0.55 });
    var ry = new Spring(0, { damping: 1, response: 0.55 });
    var lift = new Spring(0, { damping: 1, response: 0.45 });
    var active = false;

    function ensureTask() {
      if (active) return;
      active = true;
      addTask(function (dt) {
        rx.step(dt); ry.step(dt); lift.step(dt);
        card.style.transform =
          'perspective(1400px) rotateX(' + rx.value.toFixed(3) + 'deg) rotateY(' +
          ry.value.toFixed(3) + 'deg) translateZ(' + lift.value.toFixed(2) + 'px)';
        if (rx.settled(0.001) && ry.settled(0.001) && lift.settled(0.01)) {
          active = false;
          return false;
        }
      });
    }

    var scope = card.closest('[data-tilt-scope]') || card;

    scope.addEventListener('pointermove', function (e) {
      var r = card.getBoundingClientRect();
      var px = (e.clientX - r.left) / r.width - 0.5;
      var py = (e.clientY - r.top) / r.height - 0.5;
      ry.to(clamp(px, -0.5, 0.5) * 11);
      rx.to(clamp(-py, -0.5, 0.5) * 8);
      lift.to(18);
      ensureTask();
    });

    scope.addEventListener('pointerleave', function () {
      rx.to(0); ry.to(0); lift.to(0);
      ensureTask();
    });
  }

  /* =========================================================================
     8. The 42-day cycle — scroll-scrubbed
     Scroll IS the gesture here, so the visual tracks it 1:1 with no smoothing
     spring in between. Feedback is continuous through the whole interaction,
     never only at the end.
     ====================================================================== */
  var CYCLE = buildCycleModel();

  function buildCycleModel() {
    // Straight from the planner: 1,500 placed, 5% mortality over 42 days,
    // weekly intake 25/50/90/130/170/200 g/bird/day, 30 kg bags.
    var intake = [25, 50, 90, 130, 170, 200];
    var placed = 1500;
    var perDay = (placed * 0.05) / 42;
    var days = [];
    var cumFeed = 0;

    for (var d = 0; d <= 42; d++) {
      var week = Math.max(0, Math.min(5, Math.ceil(d / 7) - 1));
      var alive = Math.round(placed - perDay * d);
      if (d > 0) cumFeed += (intake[week] * alive) / 1000;
      // Weight follows the familiar sigmoid-ish broiler curve to 5.5 lb at 42 d
      var t = d / 42;
      var weightLb = 0.09 + 5.41 * Math.pow(t, 1.55);
      days.push({
        day: d,
        alive: alive,
        feedKg: cumFeed,
        bags: Math.ceil(cumFeed / 30),
        weight: d === 0 ? 0.09 : weightLb,
        phase: d <= 14 ? 'Starter' : d <= 28 ? 'Grower' : 'Finisher'
      });
    }
    return days;
  }

  function initCycle() {
    var section = document.getElementById('cycle');
    if (!section) return;

    var track = section.querySelector('[data-cycle-track]');
    var rail = section.querySelector('[data-scrub-rail]');
    var chick = section.querySelector('[data-bird="chick"]');
    var broiler = section.querySelector('[data-bird="broiler"]');
    var birdGroup = section.querySelector('[data-bird-group]');
    var progressArc = section.querySelector('[data-arc]');
    var handle = section.querySelector('[data-scrub-handle]');
    var fill = section.querySelector('[data-scrub-fill]');
    var phaseEls = section.querySelectorAll('[data-phase]');

    var out = {
      day: section.querySelector('[data-out="day"]'),
      weight: section.querySelector('[data-out="weight"]'),
      alive: section.querySelector('[data-out="alive"]'),
      feed: section.querySelector('[data-out="feed"]'),
      bags: section.querySelector('[data-out="bags"]'),
      phase: section.querySelector('[data-out="phase"]')
    };

    var arcLength = progressArc ? progressArc.getTotalLength() : 0;
    if (progressArc) {
      progressArc.style.strokeDasharray = arcLength;
      progressArc.style.strokeDashoffset = arcLength;
    }

    // Fractional day so the readout moves continuously, not in 42 steps.
    function render(dayFloat) {
      var d = clamp(dayFloat, 0, 42);
      var i = Math.floor(d);
      var frac = d - i;
      var a = CYCLE[i];
      var b = CYCLE[Math.min(41 + 1, i + 1)] || a;
      var lerp = function (k) { return a[k] + (b[k] - a[k]) * frac; };

      var weight = lerp('weight');
      var alive = lerp('alive');
      var feed = lerp('feedKg');

      if (out.day) out.day.textContent = Math.round(d);
      if (out.weight) out.weight.textContent = weight.toFixed(2);
      if (out.alive) out.alive.textContent = Math.round(alive).toLocaleString('en-US');
      if (out.feed) out.feed.textContent = Math.round(feed).toLocaleString('en-US');
      if (out.bags) out.bags.textContent = Math.ceil(feed / 30);
      if (out.phase) out.phase.textContent = a.phase;

      // The bird grows continuously; the chick becomes the broiler across a
      // narrow band. Two solid silhouettes cross-fading at equal opacity read as
      // a double exposure, so each one also scales and blurs — the outgoing
      // shape dissolves, the incoming one materialises.
      var grow = 0.3 + 0.7 * Math.pow(d / 42, 0.72);
      var blend = clamp((d - 16) / 10, 0, 1);
      var ease = blend * blend * (3 - 2 * blend);   // smoothstep

      if (birdGroup) {
        birdGroup.setAttribute(
          'transform',
          'translate(100 132) scale(' + grow.toFixed(4) + ') translate(-100 -132)'
        );
      }
      if (chick) {
        chick.style.opacity = String(1 - ease);
        chick.style.filter = ease > 0 ? 'blur(' + (ease * 3).toFixed(2) + 'px)' : '';
        chick.style.transform = 'scale(' + (1 - 0.07 * ease).toFixed(4) + ')';
      }
      if (broiler) {
        broiler.style.opacity = String(ease);
        broiler.style.filter = ease < 1 ? 'blur(' + ((1 - ease) * 3).toFixed(2) + 'px)' : '';
        broiler.style.transform = 'scale(' + (0.93 + 0.07 * ease).toFixed(4) + ')';
      }

      var pct = d / 42;
      if (progressArc) progressArc.style.strokeDashoffset = String(arcLength * (1 - pct));
      if (fill) fill.style.transform = 'scaleX(' + pct.toFixed(4) + ')';
      // Percentage translate resolves against the knob's own box, not the rail —
      // so the offset has to be computed in pixels.
      if (handle && rail) {
        handle.style.transform = 'translateX(' + (pct * rail.clientWidth).toFixed(2) + 'px)';
      }

      phaseEls.forEach(function (el) {
        el.classList.toggle('is-active', el.getAttribute('data-phase') === a.phase);
      });

      // Keep the slider's reported value truthful however it was moved —
      // scroll, drag or keyboard.
      if (rail) rail.setAttribute('aria-valuenow', String(Math.round(d)));

      section.style.setProperty('--cycle-progress', pct.toFixed(4));
    }

    /* --- Scroll scrubbing ------------------------------------------------ */
    var scrollDay = 0;
    var dragging = false;

    var pin = section.querySelector('.cycle-pin');

    // The pin is a CSS decision (see the 900px breakpoint), so ask the CSS
    // rather than duplicating the breakpoint here.
    function isPinned() {
      return pin && getComputedStyle(pin).position === 'sticky';
    }

    function onScroll() {
      if (dragging || !track || !isPinned()) return;
      // Scroll and the scrubber drive the same value. If the user scrolls while a
      // flick is still settling, scroll takes over rather than the two fighting.
      if (springActive) cancelSpring();
      var rect = track.getBoundingClientRect();
      var total = rect.height - window.innerHeight;
      if (total <= 0) return;
      var progress = clamp(-rect.top / total, 0, 1);
      scrollDay = progress * 42;
      committedDay = Math.round(scrollDay);
      render(scrollDay);
    }

    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll);
    render(0);
    onScroll();

    /* --- Direct manipulation of the scrubber ------------------------------
       Drag tracks the pointer 1:1, resists past the ends, and on release
       projects the flick forward and hands its velocity to the spring, so
       there is no seam between dragging and animating.                      */
    if (!rail) return;

    var dayspring = new Spring(0, { damping: 0.8, response: 0.4 });
    var springActive = false;
    var springToken = 0;
    var tracker = new VelocityTracker();
    var grabOffset = 0;
    // Where the control is *going*, as distinct from where it currently is.
    // Keyboard steps have to accumulate on this — stepping from the live spring
    // value makes repeated presses land somewhere arbitrary mid-flight.
    var committedDay = 0;

    function runSpring() {
      if (springActive) return;
      springActive = true;
      var token = ++springToken;
      addTask(function (dt) {
        // Only this section's spring is cancelled on a new grab — counters and
        // other springs elsewhere on the page keep running.
        if (token !== springToken) return false;
        dayspring.step(dt);
        render(dayspring.value);
        if (dayspring.settled(0.02)) {
          render(Math.round(dayspring.value));
          springActive = false;
          return false;
        }
      });
    }

    function cancelSpring() {
      springToken++;
      springActive = false;
    }

    function dayFromClientX(clientX) {
      var r = rail.getBoundingClientRect();
      return ((clientX - r.left) / r.width) * 42;
    }

    rail.addEventListener('pointerdown', function (e) {
      rail.setPointerCapture(e.pointerId);
      dragging = true;
      cancelSpring();
      tracker.reset();

      // Respect where they grabbed. Snapping the handle to the pointer on
      // grab breaks the illusion instantly.
      var handleDay = dayspring.value;
      var pointerDay = dayFromClientX(e.clientX);
      grabOffset = Math.abs(pointerDay - handleDay) < 3 ? pointerDay - handleDay : 0;

      var d = clamp(pointerDay - grabOffset, 0, 42);
      dayspring.set(d);
      committedDay = Math.round(d);
      tracker.add(d);
      render(d);
      rail.classList.add('is-dragging');
      e.preventDefault();
    });

    rail.addEventListener('pointermove', function (e) {
      if (!dragging) return;
      var raw = dayFromClientX(e.clientX) - grabOffset;
      var d = raw;

      // Soft boundaries instead of a hard stop.
      if (raw < 0) d = -rubberband(-raw, 42);
      else if (raw > 42) d = 42 + rubberband(raw - 42, 42);

      dayspring.set(d);
      committedDay = clamp(Math.round(d), 0, 42);
      tracker.add(d);
      render(d);
    });

    function endDrag(e) {
      if (!dragging) return;
      dragging = false;
      rail.classList.remove('is-dragging');
      try { rail.releasePointerCapture(e.pointerId); } catch (err) {}

      var velocity = tracker.velocity();               // days per second
      var projected = dayspring.value + project(velocity, 0.992);
      var target = clamp(Math.round(projected), 0, 42);

      // Reduced motion keeps the direct manipulation — only the decorative
      // settle is dropped, so the control still works, it just doesn't glide.
      committedDay = target;

      if (reduceMotion.matches) {
        dayspring.set(target);
        render(target);
        return;
      }

      dayspring.configure(0.8, 0.4).to(target, velocity);
      runSpring();
    }

    rail.addEventListener('pointerup', endDrag);
    rail.addEventListener('pointercancel', endDrag);

    // Keyboard parity — the scrubber is a real slider, not a mouse-only toy.
    rail.addEventListener('keydown', function (e) {
      var step = e.shiftKey ? 7 : 1;   // shift jumps a week
      var next = committedDay;
      if (e.key === 'ArrowRight' || e.key === 'ArrowUp') next = committedDay + step;
      else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') next = committedDay - step;
      else if (e.key === 'Home') next = 0;
      else if (e.key === 'End') next = 42;
      else return;
      e.preventDefault();

      committedDay = clamp(next, 0, 42);
      rail.setAttribute('aria-valuenow', String(committedDay));
      rail.setAttribute('aria-valuetext', 'Day ' + committedDay + ' of 42');

      if (reduceMotion.matches) {
        dayspring.set(committedDay);
        render(committedDay);
        return;
      }
      dayspring.configure(1, 0.35).to(committedDay);
      runSpring();
    });

    // Without the pin there is no scroll to scrub, so the cycle plays itself
    // through once on arrival — the section still introduces itself with motion,
    // and afterwards it belongs to the scrubber.
    if ('IntersectionObserver' in window && !reduceMotion.matches) {
      var played = false;
      var autoplay = new IntersectionObserver(
        function (entries) {
          entries.forEach(function (entry) {
            if (!entry.isIntersecting || played || isPinned()) return;
            played = true;
            dayspring.set(0);
            committedDay = 42;
            dayspring.configure(1, 2.6).to(42);
            runSpring();
            autoplay.disconnect();
          });
        },
        { threshold: 0.3 }
      );
      autoplay.observe(section);
    }
  }

  /* =========================================================================
     9. Parts carousel — flick, project, snap
     ====================================================================== */
  function initCarousel() {
    var rail = document.querySelector('[data-carousel]');
    if (!rail) return;
    var viewport = rail.parentElement;

    var x = new Spring(0, { damping: 1, response: 0.4 });
    var tracker = new VelocityTracker();
    var dragging = false;
    var startX = 0;
    var startValue = 0;
    var moved = false;
    var active = false;

    function maxScroll() {
      return Math.max(0, rail.scrollWidth - viewport.clientWidth);
    }

    function apply() {
      rail.style.transform = 'translate3d(' + x.value.toFixed(2) + 'px,0,0)';
    }

    function run() {
      if (active) return;
      active = true;
      addTask(function (dt) {
        x.step(dt);
        apply();
        if (x.settled(0.05)) { active = false; return false; }
      });
    }

    function snapTargets() {
      var cards = rail.children;
      var points = [];
      for (var i = 0; i < cards.length; i++) points.push(-cards[i].offsetLeft);
      return points;
    }

    function nearest(value) {
      var points = snapTargets();
      var lo = -maxScroll();
      var best = points[0];
      var bestD = Infinity;
      points.forEach(function (p) {
        var d = Math.abs(p - value);
        if (d < bestD) { bestD = d; best = p; }
      });
      return clamp(best, lo, 0);
    }

    rail.addEventListener('pointerdown', function (e) {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      rail.setPointerCapture(e.pointerId);
      dragging = true;
      moved = false;
      active = false;
      startX = e.clientX;
      startValue = x.value;
      tracker.reset();
      tracker.add(x.value);
      rail.classList.add('is-dragging');
    });

    rail.addEventListener('pointermove', function (e) {
      if (!dragging) return;
      var delta = e.clientX - startX;
      if (!moved && Math.abs(delta) < 8) return;   // hysteresis before committing
      moved = true;

      var raw = startValue + delta;
      var lo = -maxScroll();
      var v = raw;
      if (raw > 0) v = rubberband(raw, viewport.clientWidth);
      else if (raw < lo) v = lo - rubberband(lo - raw, viewport.clientWidth);

      x.set(v);
      tracker.add(v);
      apply();
    });

    function end(e) {
      if (!dragging) return;
      dragging = false;
      rail.classList.remove('is-dragging');
      try { rail.releasePointerCapture(e.pointerId); } catch (err) {}
      if (!moved) return;

      var velocity = tracker.velocity();
      var projected = x.value + project(velocity, 0.995);
      var target = nearest(projected);

      // Bounce only because a flick preceded it — momentum earns the overshoot.
      x.configure(Math.abs(velocity) > 60 ? 0.82 : 1, 0.42).to(target, velocity);
      run();
    }

    rail.addEventListener('pointerup', end);
    rail.addEventListener('pointercancel', end);
    rail.addEventListener('click', function (e) { if (moved) e.preventDefault(); }, true);

    window.addEventListener('resize', function () {
      x.to(clamp(x.value, -maxScroll(), 0));
      run();
    });

    var prev = document.querySelector('[data-carousel-prev]');
    var next = document.querySelector('[data-carousel-next]');
    function nudge(dir) {
      var step = viewport.clientWidth * 0.8;
      x.configure(1, 0.45).to(clamp(nearest(x.value - dir * step), -maxScroll(), 0));
      run();
    }
    if (prev) prev.addEventListener('click', function () { nudge(-1); });
    if (next) next.addEventListener('click', function () { nudge(1); });
  }

  /* =========================================================================
     10. Scroll edge — chrome only separates itself once content is under it
     ====================================================================== */
  function initNav() {
    var nav = document.querySelector('[data-nav]');
    if (!nav) return;
    var update = function () {
      nav.classList.toggle('is-floating', window.scrollY > 12);
    };
    update();
    window.addEventListener('scroll', update, { passive: true });
  }

  /* =========================================================================
     11. Spring accordion — height animates from its live value
     ====================================================================== */
  function initAccordion() {
    document.querySelectorAll('[data-accordion] > details').forEach(function (d) {
      var body = d.querySelector('[data-accordion-body]');
      if (!body) return;

      d.addEventListener('toggle', function () {
        if (reduceMotion.matches) return;
        var spring = new Spring(body.offsetHeight, { damping: 1, response: 0.38 });
        var target = d.open ? body.scrollHeight : 0;
        spring.to(target);
        body.style.overflow = 'hidden';

        addTask(function (dt) {
          spring.step(dt);
          body.style.height = Math.max(0, spring.value) + 'px';
          if (spring.settled(0.5)) {
            body.style.height = d.open ? 'auto' : '0px';
            return false;
          }
        });
      });
    });
  }

  /* =========================================================================
     Boot
     ====================================================================== */
  function boot() {
    initNav();
    initReveal();
    initCounters();
    initPress();
    initTilt();
    initCycle();
    initCarousel();
    initAccordion();

    var year = document.getElementById('year');
    if (year) year.textContent = String(new Date().getFullYear());

    document.documentElement.classList.add('motion-ready');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
