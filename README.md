# Roost — landing page

Marketing landing page for a flock-management app aimed at small, family-run poultry
farms selling fresh chicken.

Static HTML, CSS and vanilla JS. No framework, no build step, no dependencies — it
deploys to GitHub Pages as-is.

```
index.html              the page
assets/styles.css       design system + all styling
assets/theme-init.js    appearance, applied before first paint
assets/motion.js        spring engine + gesture and scroll behaviours
docs/data-model.md      PostgreSQL schema for the app behind the page
.github/workflows/      GitHub Pages deployment
```

## Run it locally

Any static server works. With Python:

```bash
python -m http.server 5173
```

Then open <http://localhost:5173>.

## Deploy to GitHub Pages

Push to `main`, then in the repository go to **Settings → Pages** and set
**Source** to **GitHub Actions**. The included workflow uploads the repository root
and deploys it — there is nothing to build.

## Where the numbers come from

Every figure on the page is computed from `broiler_whole_and_parts_planner.xlsx`
(1,500 birds placed, 5% mortality, 42-day grow-out, 72% dressing yield, 2% shrink,
40/60 whole-to-cut-up split, 3% trim loss), not invented for the mockup:

| Figure | Value |
|---|---|
| Birds sold | 1,425 |
| Net saleable weight | 3.88 lb/bird · 5,530 lb total |
| Total feed | 6,752 kg · 227 bags (26 starter / 76 grower / 125 finisher) |
| Revenue | $18,340 |
| Total cost | $19,450 (feed is 64%) |
| Operating result | **−$1,110 · −6.1% margin** |
| Blended price vs breakeven | $3.32/lb vs $3.52/lb |
| Implied FCR | 1.90 |

Two of these deserve attention beyond the page:

- **The modelled cycle loses money.** At the workbook's own assumptions, revenue lands
  about $1,110 short of cost. The page presents this honestly rather than showing an
  invented profit.
- **FCR of 1.90 is the cause.** Published broiler performance objectives put a 42-day
  bird nearer 1.55–1.65. Feed is 64% of the cost stack, so roughly every 0.1 of FCR is
  worth about $660 on a cycle this size — more than litter, utilities, medication and
  overhead combined. Either the intake assumptions in the sheet are set too high, or
  the flock genuinely is converting poorly; both are worth checking before pricing.

## Design

Built to Apple's interface conventions. The system font stack first (it already ships
optical sizing and tracking tables), size-specific tracking — display type at `-0.035em`,
body just under zero, small text slightly positive — translucent materials rather than
borders, a single green accent, and true black in dark mode.

- Light and dark; follows the OS, overridable, choice persisted, applied before first paint
- All text meets WCAG AA in both themes, verified with alpha-composited measurement
  rather than by eye (two failures found and fixed that way)
- No horizontal scroll at 375px; layouts at 375 / 768 / 1024 / 1440
- Full keyboard support, including the day scrubber (arrows step a day, shift a week)
- Charts carry text alternatives; the scrubber is a real `slider` with live `aria-valuenow`
- Honours `prefers-reduced-motion`, `prefers-reduced-transparency` and `prefers-contrast`
- Works with JavaScript disabled — a `<noscript>` block un-hides the reveal content

## Motion

`assets/motion.js` is a small spring engine plus the behaviours built on it. No library.

Springs are parameterised the way Apple exposes them — **damping ratio** and **response**
— not mass/stiffness/damping. Critically damped (`1.0`) by default; bounce (`~0.8`) only
where a gesture carried momentum into the animation.

What it drives:

| Element | Behaviour |
| --- | --- |
| The 42-day cycle | Pinned and scrubbed 1:1 by scroll — a chick grows into a broiler, feed draws down, the ring closes |
| Day scrubber | Direct manipulation: tracks the pointer 1:1, respects the grab offset, rubber-bands past the ends, projects the flick and hands its release velocity to the spring |
| Parts carousel | Flick, momentum projection, snap to the nearest card, rubber-band at the bounds |
| Hero card | Pointer parallax on independent X and Y springs |
| Cards and sections | Materialise — blur, scale and opacity together, not a plain fade |
| Figures | Count into place on arrival; bars and the breakeven needle animate on reveal |
| Buttons | Feedback on pointer **down**, never on release |

Two details worth naming, both from *Designing Fluid Interfaces*:

- **Momentum projection** uses the exponential-decay form Apple ships,
  `current + (v/1000)·d/(1−d)` with `d ≈ 0.998` — not the textbook `v²/2a`. It is why a
  flick feels thrown rather than dragged.
- **Interruptibility.** Retargeting a spring preserves its current position *and*
  velocity, so grabbing the scrubber mid-flight redirects it without a jump. Nothing
  waits for an animation to finish.

Reduced motion keeps the direct manipulation and drops only the decorative settle: the
scrubber still works, it just snaps instead of gliding, and the pinned section becomes a
normal block. Below 900px the pin is released entirely — the section would exceed the
viewport — and the cycle plays through once on arrival instead, with the drag scrubber
taking over from there.

## Status

The page describes Phase 1 as shipping, with invoicing (Phase 2) and AI follow-up on
unpaid invoices (Phase 3) marked as upcoming. Calls to action are placeholder anchors —
wire them to the real signup once the backend exists. "Roost" is a working name.
