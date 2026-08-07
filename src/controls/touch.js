/**
 * touch.js — the thumb cockpit: a virtual stick, a latching throttle, a rudder
 * bar and six buttons, driven entirely by Pointer Events.
 *
 * Contract: see MODULES.md § 2.12a (additive to § 2.12; `controls/input.js`
 * owns this module and is the only thing that should construct it).
 *
 *   createTouchCore(opts)     -> pure state machine, NO DOM. Node-runnable.
 *   createTouchControls(opts) -> the same core plus an absolutely-positioned
 *                                overlay of <div>s. Browser only.
 *   computeLayout(w, h)       -> pure geometry. No DOM, no side effects.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS SPLIT IN TWO
 * ---------------------------------------------------------------------------
 * Everything that decides what the aeroplane gets — the dead zone, the expo,
 * the ramp, the pointer bookkeeping, the throttle latch — lives in
 * `createTouchCore`, which imports nothing from the DOM and takes normalised
 * (u, v) coordinates in 0..1 of a control's own rectangle. The overlay's only
 * job is to turn a `PointerEvent` into (zone, id, u, v) and to draw a knob.
 * That is what lets `scripts/check-touch.mjs` fly the stick in Node.
 *
 * ---------------------------------------------------------------------------
 * WHY THE STICK SLEWS INSTEAD OF SNAPPING
 * ---------------------------------------------------------------------------
 * A thumb pad is an absolute device: put the thumb at the edge and the obvious
 * implementation writes ±1 into `pitch` on the very next frame. That is a
 * switch again, and it is exactly the twitchiness input.js's keyboard ramp
 * exists to kill (see its header, § "WHY THE RAMP IS SHAPED THE WAY IT IS").
 *
 * So the thumb sets a TARGET and the axis runs to it under the keyboard's own
 * rate law — `rate(t) = ATTACK_BASE + ATTACK_RAMP*t`, capped at ATTACK_MAX,
 * multiplied by REVERSAL_BOOST while the axis is still on the far side of
 * centre, and spring-returning at `RELEASE_MIN + RELEASE_GAIN*|x|` when the
 * thumb lifts or lands in the dead zone. The numbers are copied from input.js
 * deliberately: they are the tuning that makes this sim feel good, and touch
 * should feel like the same aeroplane.
 *
 * The happy consequence of slewing to a proportional target is that the ramp
 * costs you nothing where it would hurt. A small demand is a short distance, so
 * a 15% nudge arrives in ~0.09 s — instant, which is what you want when you are
 * trimming. A full-throw slam is a long distance, so it takes ~0.47 s — damped,
 * which is what you want when a thumb slips. A snap-to-position stick gets the
 * second case wrong; a pure rate stick (hold to deflect) gets the first case
 * wrong. This gets both.
 *
 * ---------------------------------------------------------------------------
 * THE AUTOPILOT CONSTRAINT
 * ---------------------------------------------------------------------------
 * `systems/autopilot.js` disconnects when |pitch| or |roll| exceeds 0.3. A
 * thumb parked on the pad must therefore read EXACTLY zero, not 0.04. Two
 * things guarantee it: `STICK_DEADZONE` maps the whole centre region to a
 * target of 0, and the spring return has a non-zero floor (`RELEASE_MIN`) plus
 * a snap below `CENTRE_EPS`, so a released axis reaches the integer 0 and stays
 * there rather than crawling asymptotically. `check-touch.mjs` asserts `=== 0`,
 * not `< 1e-3`, for exactly this reason.
 *
 * ---------------------------------------------------------------------------
 * MULTI-TOUCH
 * ---------------------------------------------------------------------------
 * Every control is a separate element that calls `setPointerCapture` on
 * pointerdown, so each finger's moves are delivered to the element it started
 * on regardless of where it wanders. The core keys everything off `pointerId`
 * in one Map. Stick + throttle + rudder + a button is four simultaneous
 * pointers and all four are independent; a phone reports five touch points, so
 * that is the whole budget and then some.
 *
 * `preventDefault()` and `touch-action: none` are applied to the CONTROL
 * ELEMENTS ONLY. Nothing is bound to `window`, `document` or the canvas, so
 * page scroll, pinch-zoom and pull-to-refresh still work everywhere else and
 * the HUD/menus are untouched.
 */

import { clamp } from '../core/units.js';

// ---------------------------------------------------------------------------
// Feel. The first six are input.js's keyboard constants, on purpose — see the
// header. If you retune one there, retune it here or the two input paths stop
// flying like the same aeroplane.
// ---------------------------------------------------------------------------

/** Deflection rate the instant a demand appears, axis-units/second. */
export const ATTACK_BASE = 1.6;
/** How fast the attack rate itself grows, axis-units/second². */
export const ATTACK_RAMP = 2.4;
/** Ceiling on the attack rate, axis-units/second. */
export const ATTACK_MAX = 4.6;
/** Multiplier while the axis is still on the far side of centre from the demand. */
export const REVERSAL_BOOST = 2.8;
/** Spring-return floor rate — guarantees the axis reaches exactly zero. */
export const RELEASE_MIN = 1.2;
/** Spring-return term proportional to current deflection. */
export const RELEASE_GAIN = 4.0;
/** Below this the axis snaps to 0, so `pitch` is never 1e-17. */
export const CENTRE_EPS = 1e-4;

/**
 * Stick dead zone, as a fraction of the pad's half-width.
 *
 * Bigger than the gamepad's 0.12 because the failure it guards is worse: a
 * gamepad at rest is a known small offset, whereas a thumb ALSO rests wherever
 * it happens to be and a phone's touch centroid wanders a few pixels on its
 * own. 0.16 of a 135 px pad is 10.8 px of slop before the aeroplane moves,
 * which is under a fingertip's own jitter, and it is what keeps a resting thumb
 * from tripping the autopilot's 0.3 disconnect.
 */
export const STICK_DEADZONE = 0.16;
/** Expo on the stick. Higher than the pad's 0.4: a thumb has less fine travel. */
export const STICK_EXPO = 0.45;
/** Rudder bar dead zone, fraction of the bar's half-width. */
export const RUDDER_DEADZONE = 0.12;
/** Rudder expo. Lower than the stick's — the bar is long, so it is already fine. */
export const RUDDER_EXPO = 0.3;

/**
 * How close to the lever a touch must land to GRAB it rather than teleport it.
 * Fraction of full travel. 0.14 of a 155 px slider is 22 px — about a
 * fingertip. Land further away and the lever jumps to the finger, which is the
 * fast way to go from idle to full; land on it and it moves relative, which is
 * the precise way to set 65% for a cruise.
 */
export const THROTTLE_GRAB_TOL = 0.14;

/** Every button the overlay offers, in grid order. */
export const BUTTONS = Object.freeze([
  Object.freeze({ id: 'flaps', label: 'FLAP', hold: false }),
  Object.freeze({ id: 'gear', label: 'GEAR', hold: false }),
  Object.freeze({ id: 'brakes', label: 'BRK', hold: true }),
  Object.freeze({ id: 'camera', label: 'CAM', hold: false }),
  Object.freeze({ id: 'autopilot', label: 'A/P', hold: false }),
  Object.freeze({ id: 'pause', label: 'II', hold: false }),
]);

/** The three continuous control surfaces. */
export const ZONES = Object.freeze(['stick', 'rudder', 'throttle']);

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

const INSET = 14;
const GAP = 10;
/** Nothing the overlay draws is ever allowed to be smaller than this. */
export const MIN_TOUCH_PX = 36;

/**
 * Where every control goes, for a viewport of `w` × `h` CSS pixels.
 *
 * Pure, deterministic and exported so `check-touch.mjs` can assert the one
 * property that actually matters and that a screenshot is bad at proving: the
 * rectangles never overlap, never leave the viewport, and never get smaller
 * than a fingertip — on a 320-wide phone, on a 430-wide phone, in landscape,
 * and on a tablet.
 *
 * The bottom band is the rudder, full width, because rudder is the control
 * touch pilots are usually denied and the takeoff roll needs it against ~2.5
 * deg/s of slipstream yaw. Above it: stick bottom-left, throttle bottom-right,
 * buttons in the gap between them. The button grid reflows — one column on a
 * narrow phone, two normally, six across in landscape — because a fixed grid is
 * what produces 26 px buttons on a 375 px screen.
 *
 * @param {number} w viewport width, CSS px
 * @param {number} h viewport height, CSS px
 * @returns {{stick:Rect, rudder:Rect, throttle:Rect, buttons:Rect[],
 *            grid:{cols:number, rows:number}, w:number, h:number}}
 */
export function computeLayout(w, h) {
  const W = Math.max(200, Number.isFinite(w) ? w : 375);
  const H = Math.max(240, Number.isFinite(h) ? h : 812);

  const rudderH = Math.round(clamp(H * 0.075, 44, 64));
  const rudder = { x: INSET, y: H - INSET - rudderH, w: W - 2 * INSET, h: rudderH };

  /** Everything else sits on this line. */
  const baseY = rudder.y - GAP;

  const throttleW = Math.round(clamp(W * 0.14, 52, 76));

  let padSide = Math.round(clamp(Math.min(W * 0.36, H * 0.3), 96, 190));
  // The button gap is not a leftover: reserve it first and let the pad shrink.
  //
  // RESERVE THREE COLUMNS, NOT ONE. Reserving a single MIN_TOUCH_PX button is
  // enough for the buttons to EXIST, which is all the first version asked, and
  // on a 320 px-wide phone that left a 105 px gap — one column, six rows, a
  // stack of buttons climbing 394 px up a 568 px screen and straight through
  // the windscreen and the HUD. Three columns is the width at which six buttons
  // fit in two rows, which is what keeps them inside the thumb band.
  const maxPad = W - 2 * INSET - throttleW - 2 * GAP - (3 * MIN_TOUCH_PX + 2 * GAP);
  if (padSide > maxPad) padSide = Math.max(72, Math.round(maxPad));

  const stick = { x: INSET, y: baseY - padSide, w: padSide, h: padSide };

  const throttleH = Math.round(clamp(padSide * 1.15, 120, 260));
  const throttle = { x: W - INSET - throttleW, y: baseY - throttleH, w: throttleW, h: throttleH };

  const gx0 = stick.x + stick.w + GAP;
  const gx1 = throttle.x - GAP;
  const gw = Math.max(MIN_TOUCH_PX, gx1 - gx0);

  const n = BUTTONS.length;

  // THE GRID MAY NOT CLIMB OUT OF THE THUMB BAND.
  //
  // Everything above `min(stick.y, throttle.y)` is windscreen, and `ui/
  // instruments.js` is entitled to it — its whole compact layout is derived
  // from where this band starts (see its `touchReserve`). The old rule chose
  // between 6, 2 and 1 columns on a 64 px aesthetic minimum and let the grid
  // grow UPWARD to fit whatever it chose, so a 130 px gap became one column and
  // six rows: measured at 360x640, buttons from y=242 to y=568, four of them
  // sitting in the sky above the aeroplane, and at 667x375 a 2x3 block across
  // the middle of the windscreen.
  //
  // So: pick the fewest ROWS whose columns are still a fingertip wide and whose
  // grid fits the band. One row is the ideal and it is what every landscape
  // phone gets; two is what a portrait phone gets; the single column survives
  // only as the last resort for a viewport narrower than anything real.
  const bandH = baseY - Math.min(stick.y, throttle.y);
  const btnH = MIN_TOUCH_PX > 46 ? MIN_TOUCH_PX : 46;
  let cols = 1;
  for (const c of [6, 3, 2, 1]) {
    const r = Math.ceil(n / c);
    const w = (gw - GAP * (c - 1)) / c;
    if (w >= MIN_TOUCH_PX && r * btnH + GAP * (r - 1) <= bandH) {
      cols = c;
      break;
    }
  }
  const rows = Math.ceil(n / cols);
  const btnW = (gw - GAP * (cols - 1)) / cols;
  const gridH = rows * btnH + GAP * (rows - 1);
  // Bottom-aligned with the stick pad. Clamped to the viewport as a floor for
  // the single-column last resort, which is the only case that can overflow.
  const gy = Math.max(INSET, baseY - gridH);

  const buttons = [];
  for (let i = 0; i < n; i += 1) {
    const c = i % cols;
    const r = Math.floor(i / cols);
    buttons.push({
      x: Math.round(gx0 + c * (btnW + GAP)),
      y: Math.round(gy + r * (btnH + GAP)),
      w: Math.round(btnW),
      h: btnH,
      id: BUTTONS[i].id,
      label: BUTTONS[i].label,
      hold: BUTTONS[i].hold,
    });
  }

  return { w: W, h: H, stick, rudder, throttle, buttons, grid: { cols, rows } };
}

// ---------------------------------------------------------------------------
// Shaping
// ---------------------------------------------------------------------------

/**
 * Dead zone then an RC-style expo curve. Full throw is preserved:
 * `curve(±1) === ±1` for any expo, which is why the stick can still reach the
 * stops with a 0.16 dead zone eating the middle.
 *
 * Deliberately a copy of input.js's private `shape()` rather than an import:
 * input.js imports THIS module, and a cycle between the two files to share six
 * lines of arithmetic is a worse trade than the duplication.
 *
 * @param {number} v raw, -1..1
 * @param {number} deadzone 0..1
 * @param {number} expo 0..1
 * @returns {number} -1..1
 */
export function curve(v, deadzone, expo) {
  const a = Math.abs(v);
  if (!(a > deadzone)) return 0;
  const n = (a - deadzone) / (1 - deadzone);
  const shaped = expo * n * n * n + (1 - expo) * n;
  return v < 0 ? -shaped : shaped;
}

/**
 * Advance one axis toward `target` under the keyboard's rate law.
 *
 * @param {{value:Object, held:Object, lastDir:Object}} st core axis state
 * @param {'pitch'|'roll'|'yaw'} axis
 * @param {number} target -1..1
 * @param {number} dt seconds
 * @returns {number} the new axis value
 */
export function slewAxis(st, axis, target, dt) {
  let x = st.value[axis];
  const step = Number.isFinite(dt) && dt > 0 ? dt : 0;

  if (target === 0) {
    st.held[axis] = 0;
    st.lastDir[axis] = 0;
    const d = (RELEASE_MIN + RELEASE_GAIN * Math.abs(x)) * step;
    if (Math.abs(x) <= d) x = 0;
    else x -= Math.sign(x) * d;
  } else {
    const dir = target < 0 ? -1 : 1;
    // A change of direction restarts the progressive attack, so a reversal
    // begins with fine authority instead of slamming to the opposite stop.
    if (st.lastDir[axis] !== dir) st.held[axis] = 0;
    st.lastDir[axis] = dir;
    st.held[axis] += step;

    let rate = Math.min(ATTACK_BASE + ATTACK_RAMP * st.held[axis], ATTACK_MAX);
    // Still on the wrong side of centre? Get through it without a dead beat.
    if (x !== 0 && Math.sign(x) !== dir) rate *= REVERSAL_BOOST;

    const d = rate * step;
    if (Math.abs(target - x) <= d) x = target;
    else x += Math.sign(target - x) * d;
  }

  if (Math.abs(x) < CENTRE_EPS) x = 0;
  st.value[axis] = clamp(x, -1, 1);
  return st.value[axis];
}

// ---------------------------------------------------------------------------
// The core
// ---------------------------------------------------------------------------

/**
 * The pure half of the thumb cockpit: pointers in, axes out. No DOM.
 *
 * Coordinates are normalised to the control's OWN rectangle — (0,0) top-left,
 * (1,1) bottom-right — so the core never needs to know where anything is on
 * screen and the harness never needs a layout.
 *
 * Sign conventions match `controls/input.js` exactly:
 *   pitch +1 = nose up   → thumb pulled DOWN the pad (v → 1), like a real stick
 *   roll  +1 = right     → thumb RIGHT (u → 1)
 *   yaw   +1 = right rudder → finger RIGHT on the bar (u → 1)
 *   throttle 1 = full    → lever at the TOP of the slider (v → 0)
 *
 * @param {{onAction?: (id:string, down:boolean) => void}} [opts]
 */
export function createTouchCore(opts = {}) {
  const onAction = typeof opts.onAction === 'function' ? opts.onAction : null;

  /** pointerId -> {zone, u, v, grabOffset}. One entry per finger down. */
  const pointers = new Map();

  const st = {
    value: { pitch: 0, roll: 0, yaw: 0 },
    held: { pitch: 0, roll: 0, yaw: 0 },
    lastDir: { pitch: 0, roll: 0, yaw: 0 },
  };

  /** The demand the thumbs are currently asking for, before the ramp. */
  const target = { pitch: 0, roll: 0, yaw: 0 };

  const api = {
    /** Live axis values, -1..1. Same object every frame; do not stash it. */
    axes: st.value,
    /** The pre-ramp demand, exposed for the harness and the knob drawing. */
    target,
    /** The lever, 0..1. Latches: it does not spring back when the finger lifts. */
    throttle: 0,
    /** True while a finger owns the throttle — input.js defers to us then. */
    throttleGrabbed: false,
    /** True while the BRK button is held. Momentary, like holding B. */
    brakeHeld: false,
    /** The pointer ids currently down, for diagnostics. */
    pointerCount: () => pointers.size,
    zoneOf: (id) => pointers.get(id)?.zone ?? null,
    begin,
    move,
    end,
    cancelAll,
    update,
    setThrottle,
    pressButton,
    releaseButton,
  };

  /**
   * A finger went down on `zone`.
   * @param {string} zone one of ZONES
   * @param {number} id PointerEvent.pointerId
   * @param {number} u 0..1 across the control
   * @param {number} v 0..1 down the control
   */
  function begin(zone, id, u, v) {
    if (!ZONES.includes(zone)) return false;
    // One finger per zone. A second thumb on the same pad would fight the first
    // for the same axis; ignoring it is unambiguous and matches every stick.
    for (const p of pointers.values()) if (p.zone === zone) return false;

    const entry = { zone, u: clamp(u, 0, 1), v: clamp(v, 0, 1), grabOffset: 0 };
    if (zone === 'throttle') {
      const at = 1 - entry.v;
      // Land on the lever and you GRAB it (no jump); land away and it comes
      // to you. See THROTTLE_GRAB_TOL.
      entry.grabOffset = Math.abs(at - api.throttle) <= THROTTLE_GRAB_TOL
        ? api.throttle - at
        : 0;
      api.throttleGrabbed = true;
    }
    pointers.set(id, entry);
    applyPointer(entry);
    return true;
  }

  /** That finger moved. Unknown ids are ignored — they belong to someone else. */
  function move(id, u, v) {
    const p = pointers.get(id);
    if (!p) return false;
    p.u = clamp(u, 0, 1);
    p.v = clamp(v, 0, 1);
    applyPointer(p);
    return true;
  }

  /** That finger lifted (pointerup / pointercancel / lost capture). */
  function end(id) {
    const p = pointers.get(id);
    if (!p) return false;
    pointers.delete(id);
    if (p.zone === 'stick') {
      target.pitch = 0;
      target.roll = 0;
    } else if (p.zone === 'rudder') {
      target.yaw = 0;
    } else if (p.zone === 'throttle') {
      // The lever STAYS where it was put. That is the whole point of a
      // throttle quadrant, and it is why this branch does not touch
      // api.throttle.
      api.throttleGrabbed = false;
    }
    return true;
  }

  /**
   * Drop every finger — a blur, a hidden tab, a phone call. The stick and
   * rudder spring back; the throttle holds, because a real lever does not move
   * when you look away.
   */
  function cancelAll() {
    pointers.clear();
    target.pitch = 0;
    target.roll = 0;
    target.yaw = 0;
    api.throttleGrabbed = false;
    api.brakeHeld = false;
  }

  function applyPointer(p) {
    if (p.zone === 'stick') {
      target.roll = curve(p.u * 2 - 1, STICK_DEADZONE, STICK_EXPO);
      // v grows downward and pulling the stick back is nose up, so this sign is
      // correct and matches the mouse yoke. Do not "fix" it to feel like a
      // first-person camera.
      target.pitch = curve(p.v * 2 - 1, STICK_DEADZONE, STICK_EXPO);
    } else if (p.zone === 'rudder') {
      target.yaw = curve(p.u * 2 - 1, RUDDER_DEADZONE, RUDDER_EXPO);
    } else if (p.zone === 'throttle') {
      api.throttle = clamp(1 - p.v + p.grabOffset, 0, 1);
    }
  }

  /**
   * Run the ramps one frame. `input.js` calls this with the dt it already
   * derived, so touch and keyboard share one clock and nothing about frame
   * timing changes.
   *
   * @param {number} dt seconds
   */
  function update(dt) {
    const step = Number.isFinite(dt) ? clamp(dt, 0, 0.1) : 0;
    slewAxis(st, 'pitch', target.pitch, step);
    slewAxis(st, 'roll', target.roll, step);
    slewAxis(st, 'yaw', target.yaw, step);
  }

  /**
   * Move the modelled lever from outside — `X`, `Z`, or main.js teleporting the
   * aeroplane to cruise. Ignored while a finger owns the lever, because the
   * finger is the more recent intent.
   */
  function setThrottle(v) {
    if (api.throttleGrabbed) return;
    api.throttle = clamp(Number.isFinite(v) ? v : 0, 0, 1);
  }

  function pressButton(id) {
    if (id === 'brakes') api.brakeHeld = true;
    if (onAction) onAction(id, true);
  }

  function releaseButton(id) {
    if (id === 'brakes') api.brakeHeld = false;
    if (onAction) onAction(id, false);
  }

  return api;
}

// ---------------------------------------------------------------------------
// The overlay
// ---------------------------------------------------------------------------

const INK = 'rgba(196, 226, 255, 0.86)';
const LINE = 'rgba(150, 200, 240, 0.34)';
const FILL = 'rgba(8, 14, 20, 0.30)';
const LIVE = 'rgba(120, 220, 190, 0.90)';

function el(tag, css) {
  const n = document.createElement(tag);
  Object.assign(n.style, css);
  return n;
}

/** Styles every element that a finger is allowed to land on. */
function surface(node) {
  const s = node.style;
  s.position = 'absolute';
  s.touchAction = 'none';
  s.pointerEvents = 'auto';
  s.userSelect = 'none';
  s.webkitUserSelect = 'none';
  s.webkitTapHighlightColor = 'transparent';
  s.background = FILL;
  s.border = `1px solid ${LINE}`;
  s.borderRadius = '10px';
  s.color = INK;
  s.font = '600 12px/1 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
  // Deliberately NO backdrop-filter. It reads well, and it costs a separate
  // backdrop pass per element — ten of them, on the tier where core/device.js
  // switched shadows off entirely to buy back 35 draw calls. A slightly more
  // opaque fill gets the same legibility for nothing.
  return node;
}

/**
 * Build the overlay and wire it to a core.
 *
 * @param {{
 *   parent?: HTMLElement,
 *   onAction?: (id:string, down:boolean) => void,
 *   window?: Window,
 * }} [opts]
 * @returns {{
 *   core: ReturnType<typeof createTouchCore>,
 *   root: HTMLElement,
 *   layout: () => object,
 *   update: (dt:number) => void,
 *   setVisible: (on:boolean) => void,
 *   dispose: () => void,
 * }}
 */
export function createTouchControls(opts = {}) {
  const win = opts.window || (typeof window !== 'undefined' ? window : null);
  const parent = opts.parent || (typeof document !== 'undefined' ? document.body : null);
  if (!parent) throw new Error('createTouchControls needs a parent element');

  const core = createTouchCore({ onAction: opts.onAction });

  const root = el('div', {
    position: 'absolute',
    inset: '0',
    // The root itself is inert. Only the controls below opt back in, which is
    // what keeps the HUD, the menus and the canvas reachable.
    pointerEvents: 'none',
    // Between the instrument panel (20) and the chrome (30), so a menu sheet,
    // the boot screen and the crash banner all cover the thumbs, and the
    // thumbs cover the tapes. main.js mounts this inside #hud so the three
    // numbers are actually in one stacking context — see the note there.
    zIndex: '25',
    overflow: 'hidden',
  });
  root.setAttribute('data-touch-controls', '1');

  // --- stick --------------------------------------------------------------
  const stickEl = surface(el('div', {}));
  // surface() sets a 10 px radius for the buttons; the pad is a circle, so it
  // has to be re-set AFTER, not before.
  stickEl.style.borderRadius = '50%';
  // The dashed ring is not decoration: it sits exactly where the knob's centre
  // lands at full single-axis deflection (see `draw()`'s travel radius), so the
  // pilot can see where the stops are without having to find them by feel.
  const stickRing = el('div', {
    position: 'absolute',
    inset: '17%',
    borderRadius: '50%',
    border: `1px dashed ${LINE}`,
    pointerEvents: 'none',
  });
  const knob = el('div', {
    position: 'absolute',
    left: '50%',
    top: '50%',
    borderRadius: '50%',
    background: 'rgba(120, 220, 190, 0.20)',
    border: `2px solid ${LIVE}`,
    pointerEvents: 'none',
    willChange: 'transform',
  });
  stickEl.appendChild(stickRing);
  stickEl.appendChild(knob);

  // --- rudder -------------------------------------------------------------
  const rudderEl = surface(el('div', {}));
  const rudderTick = el('div', {
    position: 'absolute',
    left: '50%',
    top: '6px',
    bottom: '6px',
    width: '1px',
    background: LINE,
    pointerEvents: 'none',
  });
  const rudderKnob = el('div', {
    position: 'absolute',
    left: '50%',
    top: '5px',
    bottom: '5px',
    borderRadius: '7px',
    background: 'rgba(120, 220, 190, 0.20)',
    border: `2px solid ${LIVE}`,
    pointerEvents: 'none',
    willChange: 'transform',
  });
  const rudderLabel = el('div', {
    position: 'absolute',
    left: '8px',
    top: '50%',
    transform: 'translateY(-50%)',
    opacity: '0.55',
    pointerEvents: 'none',
    font: '600 10px/1 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
  });
  rudderLabel.textContent = 'RUDDER';
  rudderEl.appendChild(rudderTick);
  rudderEl.appendChild(rudderKnob);
  rudderEl.appendChild(rudderLabel);

  // --- throttle -----------------------------------------------------------
  const throttleEl = surface(el('div', {}));
  const throttleFill = el('div', {
    position: 'absolute',
    left: '3px',
    right: '3px',
    bottom: '3px',
    background: 'rgba(120, 220, 190, 0.16)',
    borderRadius: '7px',
    pointerEvents: 'none',
    willChange: 'height',
  });
  const throttleKnob = el('div', {
    position: 'absolute',
    left: '3px',
    right: '3px',
    height: '20px',
    borderRadius: '6px',
    background: 'rgba(120, 220, 190, 0.28)',
    border: `2px solid ${LIVE}`,
    pointerEvents: 'none',
    willChange: 'transform',
  });
  const throttleText = el('div', {
    position: 'absolute',
    left: '0',
    right: '0',
    top: '4px',
    textAlign: 'center',
    pointerEvents: 'none',
    font: '600 10px/1 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
  });
  throttleEl.appendChild(throttleFill);
  throttleEl.appendChild(throttleKnob);
  throttleEl.appendChild(throttleText);

  // --- buttons ------------------------------------------------------------
  /** @type {Map<string, HTMLElement>} */
  const buttonEls = new Map();
  for (let i = 0; i < BUTTONS.length; i += 1) {
    const spec = BUTTONS[i];
    const b = surface(el('div', {
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      textAlign: 'center',
    }));
    b.textContent = spec.label;
    b.setAttribute('data-touch-button', spec.id);
    buttonEls.set(spec.id, b);
    root.appendChild(b);
  }

  root.appendChild(stickEl);
  root.appendChild(rudderEl);
  root.appendChild(throttleEl);
  parent.appendChild(root);

  let layout = computeLayout(
    win?.innerWidth ?? 375,
    win?.innerHeight ?? 812,
  );

  function place(node, r) {
    node.style.left = `${r.x}px`;
    node.style.top = `${r.y}px`;
    node.style.width = `${r.w}px`;
    node.style.height = `${r.h}px`;
  }

  function applyLayout() {
    place(stickEl, layout.stick);
    place(rudderEl, layout.rudder);
    place(throttleEl, layout.throttle);
    const kd = Math.round(layout.stick.w * 0.34);
    knob.style.width = `${kd}px`;
    knob.style.height = `${kd}px`;
    knob.style.marginLeft = `${-kd / 2}px`;
    knob.style.marginTop = `${-kd / 2}px`;
    const rk = Math.round(layout.rudder.h * 0.62);
    rudderKnob.style.width = `${rk}px`;
    rudderKnob.style.marginLeft = `${-rk / 2}px`;
    for (let i = 0; i < layout.buttons.length; i += 1) {
      const r = layout.buttons[i];
      const node = buttonEls.get(r.id);
      if (node) place(node, r);
    }
    drawn.pitch = NaN; // force a redraw at the new size
    draw();
  }

  // --- drawing ------------------------------------------------------------
  // Per-frame writes are gated on a real change, so a parked aeroplane costs
  // zero style recalculations. §1.8: no allocation on this path either.
  const drawn = { pitch: 0, roll: 0, yaw: 0, throttle: -1 };

  function draw() {
    const a = core.axes;
    if (a.pitch !== drawn.pitch || a.roll !== drawn.roll) {
      drawn.pitch = a.pitch;
      drawn.roll = a.roll;
      const rad = layout.stick.w * 0.5 - layout.stick.w * 0.17;
      knob.style.transform = `translate3d(${(a.roll * rad).toFixed(1)}px,${(a.pitch * rad).toFixed(1)}px,0)`;
    }
    if (a.yaw !== drawn.yaw) {
      drawn.yaw = a.yaw;
      const rad = layout.rudder.w * 0.5 - layout.rudder.h * 0.4;
      rudderKnob.style.transform = `translate3d(${(a.yaw * rad).toFixed(1)}px,0,0)`;
    }
    if (core.throttle !== drawn.throttle) {
      drawn.throttle = core.throttle;
      const travel = layout.throttle.h - 26;
      throttleKnob.style.top = `${(3 + (1 - core.throttle) * travel).toFixed(1)}px`;
      throttleFill.style.height = `${(6 + core.throttle * travel).toFixed(1)}px`;
      throttleText.textContent = `${Math.round(core.throttle * 100)}%`;
    }
  }

  // --- pointer plumbing ---------------------------------------------------

  /** Normalised (u, v) of a pointer within `node`, via its own live rect. */
  function uv(node, e, out) {
    const r = node.getBoundingClientRect();
    out.u = r.width > 0 ? (e.clientX - r.left) / r.width : 0.5;
    out.v = r.height > 0 ? (e.clientY - r.top) / r.height : 0.5;
    return out;
  }
  const scratch = { u: 0, v: 0 };

  function bindZone(node, zone) {
    // Named, so anything outside this module can find a control without
    // pattern-matching on inline styles. The buttons already carry
    // `data-touch-button`; the three continuous zones had nothing, which is
    // why check-touch.mjs was identifying the stick by "border-radius is 50%".
    node.setAttribute('data-touch-zone', zone);
    function down(e) {
      // Multi-button mice: only the primary button flies.
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      uv(node, e, scratch);
      if (!core.begin(zone, e.pointerId, scratch.u, scratch.v)) return;
      // Capture makes the rest of this finger's stroke ours no matter where it
      // travels — off the pad, over the throttle, off the screen edge.
      try { node.setPointerCapture(e.pointerId); } catch { /* not captureable */ }
      e.preventDefault();
      e.stopPropagation();
      draw();
    }
    function moved(e) {
      if (core.zoneOf(e.pointerId) !== zone) return;
      uv(node, e, scratch);
      core.move(e.pointerId, scratch.u, scratch.v);
      e.preventDefault();
      e.stopPropagation();
      draw();
    }
    function up(e) {
      if (!core.end(e.pointerId)) return;
      try { node.releasePointerCapture(e.pointerId); } catch { /* already gone */ }
      e.preventDefault();
      e.stopPropagation();
      draw();
    }
    node.addEventListener('pointerdown', down, { passive: false });
    node.addEventListener('pointermove', moved, { passive: false });
    node.addEventListener('pointerup', up, { passive: false });
    node.addEventListener('pointercancel', up, { passive: false });
    node.addEventListener('lostpointercapture', up, { passive: false });
    listeners.push([node, 'pointerdown', down], [node, 'pointermove', moved],
      [node, 'pointerup', up], [node, 'pointercancel', up],
      [node, 'lostpointercapture', up]);
  }

  /** @type {Array<[EventTarget, string, Function]>} */
  const listeners = [];

  bindZone(stickEl, 'stick');
  bindZone(rudderEl, 'rudder');
  bindZone(throttleEl, 'throttle');

  for (const [id, node] of buttonEls) {
    const spec = BUTTONS.find((b) => b.id === id);
    function down(e) {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      try { node.setPointerCapture(e.pointerId); } catch { /* not captureable */ }
      node.style.background = 'rgba(120, 220, 190, 0.22)';
      // A hold button fires on press and releases on lift; a momentary one
      // fires once on press. Firing on press either way is what makes a tap
      // feel immediate.
      core.pressButton(id);
      e.preventDefault();
      e.stopPropagation();
    }
    function up(e) {
      node.style.background = FILL;
      if (spec && spec.hold) core.releaseButton(id);
      try { node.releasePointerCapture(e.pointerId); } catch { /* already gone */ }
      e.preventDefault();
      e.stopPropagation();
    }
    node.addEventListener('pointerdown', down, { passive: false });
    node.addEventListener('pointerup', up, { passive: false });
    node.addEventListener('pointercancel', up, { passive: false });
    node.addEventListener('lostpointercapture', up, { passive: false });
    listeners.push([node, 'pointerdown', down], [node, 'pointerup', up],
      [node, 'pointercancel', up], [node, 'lostpointercapture', up]);
  }

  function onResize() {
    layout = computeLayout(win?.innerWidth ?? 375, win?.innerHeight ?? 812);
    applyLayout();
  }
  /**
   * A backgrounded tab that comes back with the elevator still deflected is
   * the touch version of a stuck key, and it is WORSE than a stuck key: no
   * `pointerup` is ever going to arrive for a finger that left while the page
   * was not listening. Blur drops every finger unconditionally — it is not
   * conditional on `document.hidden`, because a window can lose focus without
   * ever being hidden and that is the exact case (an incoming call, a
   * notification sheet) where the finger goes away.
   */
  function onBlur() {
    core.cancelAll();
    draw();
  }
  function onVisibility() {
    if (typeof document !== 'undefined' && document.hidden) onBlur();
  }
  if (win) {
    win.addEventListener('resize', onResize);
    win.addEventListener('orientationchange', onResize);
    win.addEventListener('blur', onBlur);
    listeners.push([win, 'resize', onResize], [win, 'orientationchange', onResize],
      [win, 'blur', onBlur]);
  }
  if (typeof document !== 'undefined' && document.addEventListener) {
    document.addEventListener('visibilitychange', onVisibility);
    listeners.push([document, 'visibilitychange', onVisibility]);
  }

  applyLayout();

  return {
    core,
    root,
    layout: () => layout,
    update(dt) {
      core.update(dt);
      draw();
    },
    setVisible(on) {
      root.style.display = on ? '' : 'none';
      if (!on) core.cancelAll();
    },
    dispose() {
      for (let i = 0; i < listeners.length; i += 1) {
        const [node, type, fn] = listeners[i];
        node.removeEventListener(type, fn);
      }
      listeners.length = 0;
      core.cancelAll();
      if (root.parentNode) root.parentNode.removeChild(root);
    },
  };
}

/**
 * Should a device of this tier get a thumb cockpit?
 *
 * The decision is deliberately NOT a fresh round of feature sniffing. It reads
 * `core/device.js`'s tier, so the overlay appears on exactly the devices the
 * budget layer already calls phone or tablet, and the codebase has one
 * definition of "touch device" rather than two that can disagree. The caller
 * (`controls/input.js`) does the classify — see its `resolveTouchTier`.
 *
 * @param {string} tier 'phone' | 'tablet' | 'desktop'
 * @returns {boolean}
 */
export function shouldUseTouch(tier) {
  return tier === 'phone' || tier === 'tablet';
}

/** @typedef {{x:number, y:number, w:number, h:number}} Rect */
