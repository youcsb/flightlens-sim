/**
 * check-touch.mjs — can the aeroplane actually be flown with thumbs?
 *
 *   node scripts/check-touch.mjs
 *
 * A virtual stick is the one input path where a screenshot proves nothing. The
 * knob can be drawn perfectly and centred perfectly while the axis it feeds is
 * inverted, or stuck at 0.04, or quietly single-touch — and every one of those
 * looks fine in a still image and is unflyable in the hand. So this file drives
 * the shipping module with synthetic pointers and asserts the numbers.
 *
 * Four things are worth the file on their own:
 *
 *   1. MULTI-TOUCH. A single-touch implementation cannot hold throttle while it
 *      rolls, which means it cannot take off. Every simultaneous-pointer case
 *      below is run through the REAL DOM path (a small shim, in the house style
 *      of check-instruments.mjs) rather than the pure core, because the bug
 *      lives in the pointer bookkeeping, not the arithmetic.
 *
 *   2. RETURN TO EXACTLY ZERO. systems/autopilot.js disconnects above |0.3| on
 *      pitch or roll. An axis that decays asymptotically to 0.001 is invisible
 *      on screen and disconnects the autopilot the moment a thumb brushes the
 *      pad. The assertions here are `=== 0`, not `< 1e-3`.
 *
 *   3. THE THROTTLE LATCHES. A spring-return throttle is a platformer control.
 *      This asserts the lever holds across a full minute of frames with no
 *      finger on it.
 *
 *   4. LAYOUT. computeLayout is pure, so nine viewports from a 320 px phone to
 *      a landscape tablet are checked for overlap, for staying on screen, and
 *      for never producing a control smaller than a fingertip.
 */

import {
  ATTACK_BASE,
  ATTACK_MAX,
  ATTACK_RAMP,
  BUTTONS,
  CENTRE_EPS,
  MIN_TOUCH_PX,
  RELEASE_GAIN,
  RELEASE_MIN,
  REVERSAL_BOOST,
  RUDDER_DEADZONE,
  STICK_DEADZONE,
  STICK_EXPO,
  THROTTLE_GRAB_TOL,
  ZONES,
  computeLayout,
  createTouchControls,
  createTouchCore,
  curve,
  shouldUseTouch,
} from '../src/controls/touch.js';

const DT = 1 / 60;

let passed = 0;
let failed = 0;
const measurements = [];

function ok(name, cond, detail) {
  if (cond) {
    passed += 1;
    console.log(`  \x1b[32m ok \x1b[0m ${name}${detail ? `   ${detail}` : ''}`);
  } else {
    failed += 1;
    console.log(`  \x1b[31mFAIL\x1b[0m ${name}${detail ? `   ${detail}` : ''}`);
  }
}
const near = (a, b, tol) => Math.abs(a - b) <= tol;
const note = (k, v) => measurements.push([k, v]);

// ===========================================================================
// A DOM small enough to read in one sitting.
//
// It is not a browser. It records styles, indexes listeners, and answers
// getBoundingClientRect() out of the inline `left/top/width/height` the module
// itself wrote — which is exactly the surface touch.js touches and nothing
// more. Absolute coordinates are viewport coordinates here because the overlay
// root is `inset: 0`.
// ===========================================================================

class El {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.style = {};
    this.children = [];
    this.parentNode = null;
    this.attrs = new Map();
    this.listeners = new Map();
    this.textContent = '';
    this.captured = new Set();
  }
  appendChild(c) {
    c.parentNode = this;
    this.children.push(c);
    return c;
  }
  removeChild(c) {
    const i = this.children.indexOf(c);
    if (i >= 0) this.children.splice(i, 1);
    c.parentNode = null;
    return c;
  }
  get parentElement() {
    return this.parentNode;
  }
  setAttribute(k, v) {
    this.attrs.set(k, String(v));
  }
  getAttribute(k) {
    return this.attrs.has(k) ? this.attrs.get(k) : null;
  }
  hasAttribute(k) {
    return this.attrs.has(k);
  }
  addEventListener(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(fn);
  }
  removeEventListener(type, fn) {
    this.listeners.get(type)?.delete(fn);
  }
  setPointerCapture(id) {
    this.captured.add(id);
  }
  releasePointerCapture(id) {
    this.captured.delete(id);
  }
  getBoundingClientRect() {
    const n = (s) => (typeof s === 'string' ? parseFloat(s) || 0 : 0);
    const left = n(this.style.left);
    const top = n(this.style.top);
    const width = n(this.style.width);
    const height = n(this.style.height);
    return { left, top, width, height, right: left + width, bottom: top + height, x: left, y: top };
  }
  /** Depth-first search by the data-attribute touch.js tags its controls with. */
  find(pred) {
    if (pred(this)) return this;
    for (const c of this.children) {
      const hit = c.find(pred);
      if (hit) return hit;
    }
    return null;
  }
  listenerCount() {
    let n = 0;
    for (const s of this.listeners.values()) n += s.size;
    for (const c of this.children) n += c.listenerCount();
    return n;
  }
}

class FakeWindow {
  constructor(w, h) {
    this.innerWidth = w;
    this.innerHeight = h;
    this.listeners = new Map();
  }
  addEventListener(t, fn) {
    if (!this.listeners.has(t)) this.listeners.set(t, new Set());
    this.listeners.get(t).add(fn);
  }
  removeEventListener(t, fn) {
    this.listeners.get(t)?.delete(fn);
  }
  fire(t, e = {}) {
    for (const fn of this.listeners.get(t) ?? []) fn(e);
  }
  listenerCount() {
    let n = 0;
    for (const s of this.listeners.values()) n += s.size;
    return n;
  }
}

const body = new El('body');
globalThis.document = {
  body,
  hidden: false,
  createElement: (t) => new El(t),
  addEventListener() {},
  removeEventListener() {},
};

/** Dispatch a synthetic PointerEvent at absolute viewport coordinates. */
function fire(node, type, { id = 1, x = 0, y = 0, button = 0 } = {}) {
  let prevented = false;
  const e = {
    pointerId: id,
    pointerType: 'touch',
    button,
    clientX: x,
    clientY: y,
    preventDefault() {
      prevented = true;
    },
    stopPropagation() {},
  };
  for (const fn of node.listeners.get(type) ?? []) fn(e);
  return prevented;
}

/** Absolute viewport point at fractional (u, v) of a control's rect. */
function at(node, u, v) {
  const r = node.getBoundingClientRect();
  return { x: r.left + u * r.width, y: r.top + v * r.height };
}

function mountOverlay(w = 375, h = 812, onAction) {
  const parent = new El('div');
  const win = new FakeWindow(w, h);
  const actions = [];
  const tc = createTouchControls({
    parent,
    window: win,
    onAction: (id, down) => {
      actions.push([id, down]);
      if (onAction) onAction(id, down);
    },
  });
  // Every control is addressable by name: `data-touch-zone` on the three
  // continuous surfaces, `data-touch-button` on the six buttons. The previous
  // version of this helper matched the stick on "border-radius is 50% and
  // pointer-events is auto", which would have silently found the wrong element
  // the day anything else in the overlay went round.
  const L = tc.layout();
  const byZone = {};
  for (const z of ZONES) byZone[z] = tc.root.find((n) => n.getAttribute('data-touch-zone') === z);
  const buttons = new Map();
  for (const b of BUTTONS) {
    buttons.set(b.id, tc.root.find((n) => n.getAttribute('data-touch-button') === b.id));
  }
  return { tc, win, parent, zones: byZone, buttons, actions, layout: L };
}

// ===========================================================================
console.log('\n\x1b[1mshaping — dead zone, expo, full throw\x1b[0m');
// ===========================================================================

ok('curve preserves full throw at both stops', curve(1, STICK_DEADZONE, STICK_EXPO) === 1 && curve(-1, STICK_DEADZONE, STICK_EXPO) === -1);
ok('curve is exactly zero inside the dead zone', curve(STICK_DEADZONE * 0.999, STICK_DEADZONE, STICK_EXPO) === 0 && curve(-STICK_DEADZONE, STICK_DEADZONE, STICK_EXPO) === 0);
ok('curve is odd', near(curve(0.6, STICK_DEADZONE, STICK_EXPO), -curve(-0.6, STICK_DEADZONE, STICK_EXPO), 1e-12));
ok('curve is monotonic across the throw', (() => {
  let prev = -Infinity;
  for (let v = -1; v <= 1.0001; v += 0.01) {
    const c = curve(v, STICK_DEADZONE, STICK_EXPO);
    if (c < prev - 1e-12) return false;
    prev = c;
  }
  return true;
})());
ok('expo softens the middle without losing the stops', curve(0.5, STICK_DEADZONE, STICK_EXPO) < 0.5 && curve(0.95, STICK_DEADZONE, STICK_EXPO) < 1);
ok('the rudder dead zone is smaller than the stick’s', RUDDER_DEADZONE < STICK_DEADZONE);
ok('curve never returns NaN for garbage', curve(NaN, STICK_DEADZONE, STICK_EXPO) === 0);

// ===========================================================================
console.log('\n\x1b[1maxis mapping — signs, against input.js’s conventions\x1b[0m');
// ===========================================================================

/** Push the core to a settled state under a fixed thumb position. */
function settle(core, seconds = 3) {
  const n = Math.round(seconds / DT);
  for (let i = 0; i < n; i += 1) core.update(DT);
  return core.axes;
}

{
  const core = createTouchCore();
  core.begin('stick', 1, 1, 0.5); // thumb hard right
  settle(core);
  ok('thumb right → roll +1 (roll right)', core.axes.roll === 1, `roll=${core.axes.roll}`);
  ok('thumb right leaves pitch at exactly 0', core.axes.pitch === 0);
}
{
  const core = createTouchCore();
  core.begin('stick', 1, 0, 0.5);
  settle(core);
  ok('thumb left → roll −1', core.axes.roll === -1);
}
{
  const core = createTouchCore();
  core.begin('stick', 1, 0.5, 1); // thumb pulled DOWN the pad = stick back
  settle(core);
  ok('thumb down (stick back) → pitch +1 (nose up)', core.axes.pitch === 1, 'matches the mouse yoke and PITCH_POS = KeyS');
}
{
  const core = createTouchCore();
  core.begin('stick', 1, 0.5, 0);
  settle(core);
  ok('thumb up (stick forward) → pitch −1 (nose down)', core.axes.pitch === -1);
}
{
  const core = createTouchCore();
  core.begin('rudder', 1, 1, 0.5);
  settle(core);
  ok('finger right on the bar → yaw +1 (right rudder)', core.axes.yaw === 1);
  ok('the rudder does not touch pitch or roll', core.axes.pitch === 0 && core.axes.roll === 0);
}
{
  const core = createTouchCore();
  core.begin('rudder', 1, 0, 0.5);
  settle(core);
  ok('finger left on the bar → yaw −1 (left rudder)', core.axes.yaw === -1);
}
{
  // The takeoff roll needs right rudder against ~2.5 deg/s of slipstream yaw.
  // A quarter-deflection on the bar has to be reachable and has to be small.
  const core = createTouchCore();
  core.begin('rudder', 1, 0.62, 0.5);
  settle(core);
  const y = core.axes.yaw;
  ok('a small right-rudder input is available and stays small', y > 0.05 && y < 0.35, `u=0.62 → yaw=${y.toFixed(3)}`);
  note('rudder at u=0.62', y.toFixed(3));
}
{
  const core = createTouchCore();
  core.begin('throttle', 1, 0.5, 0);
  ok('finger at the top of the slider → throttle 1', core.throttle === 1);
  core.move(1, 0.5, 1);
  ok('finger at the bottom → throttle 0', core.throttle === 0);
  core.move(1, 0.5, 0.35);
  ok('finger 35% down → throttle 0.65', near(core.throttle, 0.65, 1e-9), `${core.throttle}`);
}
{
  const core = createTouchCore();
  core.begin('stick', 1, 2.5, -4); // off the element entirely
  settle(core);
  ok('coordinates outside the control clamp to the stops', core.axes.roll === 1 && core.axes.pitch === -1);
}
ok('ZONES lists exactly the three continuous surfaces', ZONES.length === 3 && ZONES.includes('stick') && ZONES.includes('rudder') && ZONES.includes('throttle'));
ok('an unknown zone is refused', createTouchCore().begin('elevator-trim', 1, 0.5, 0.5) === false);

// ===========================================================================
console.log('\n\x1b[1mthe ramp — the keyboard’s feel, on a proportional device\x1b[0m');
// ===========================================================================

/** Seconds until `pred(core)` holds, or Infinity. */
function timeUntil(core, pred, limit = 10) {
  let t = 0;
  while (t < limit) {
    core.update(DT);
    t += DT;
    if (pred(core)) return t;
  }
  return Infinity;
}

{
  const core = createTouchCore();
  core.begin('stick', 1, 0.5, 1);
  const t = timeUntil(core, (c) => c.axes.pitch >= 1);
  note('full-throw slam → pitch 1.0', `${t.toFixed(3)} s`);
  ok('a full-throw slam is damped, not instant', t > 0.30 && t < 0.70, `${t.toFixed(3)} s`);
  ok('and it does get all the way to the stop', core.axes.pitch === 1);
}
{
  // The ramp must not tax small inputs — that is the whole argument for
  // slewing to a proportional target instead of holding a rate.
  const core = createTouchCore();
  core.begin('stick', 1, 0.5, 0.5 + 0.5 * 0.30);
  const want = curve(0.30, STICK_DEADZONE, STICK_EXPO);
  const t = timeUntil(core, (c) => c.axes.pitch >= want - 1e-9);
  note('small demand (target ' + want.toFixed(3) + ') settle', `${t.toFixed(3)} s`);
  ok('a small demand arrives fast', t < 0.15, `target ${want.toFixed(3)} in ${t.toFixed(3)} s`);
}
{
  const core = createTouchCore();
  core.begin('stick', 1, 0.5, 1);
  for (let i = 0; i < 6; i += 1) core.update(DT); // a 100 ms tap
  const tapped = core.axes.pitch;
  note('100 ms tap at the stop', tapped.toFixed(3));
  ok('a 100 ms tap buys fine trim authority, not the stop', tapped > 0.08 && tapped < 0.25, `${tapped.toFixed(3)}`);
}
{
  const core = createTouchCore();
  core.begin('stick', 1, 0.5, 1);
  settle(core);
  core.move(1, 0.5, 0); // slam to the opposite stop
  const t = timeUntil(core, (c) => c.axes.pitch <= 0);

  // Reference: the same law with the reversal boost switched off.
  let x = 1;
  let held = 0;
  let ref = 0;
  while (x > 0 && ref < 10) {
    held += DT;
    const rate = Math.min(ATTACK_BASE + ATTACK_RAMP * held, ATTACK_MAX);
    x -= rate * DT;
    ref += DT;
  }
  note('reversal +1 → centre', `${t.toFixed(3)} s (unboosted would be ${ref.toFixed(3)} s)`);
  ok('the reversal boost really shortens the crossing', t < ref * 0.75, `${t.toFixed(3)} s vs ${ref.toFixed(3)} s unboosted`);
  ok('REVERSAL_BOOST matches input.js’s keyboard value', REVERSAL_BOOST === 2.8);
  ok('the attack law matches input.js’s keyboard value', ATTACK_BASE === 1.6 && ATTACK_RAMP === 2.4 && ATTACK_MAX === 4.6);
  ok('the release law matches input.js’s keyboard value', RELEASE_MIN === 1.2 && RELEASE_GAIN === 4.0);
}
{
  const core = createTouchCore();
  core.begin('stick', 1, 0.5, 1);
  settle(core);
  // Ease the thumb back to a partial deflection and hold it there.
  core.move(1, 0.5, 0.5 + 0.5 * 0.55);
  const want = curve(0.55, STICK_DEADZONE, STICK_EXPO);
  settle(core, 1);
  ok('the axis parks on a partial demand instead of overshooting', near(core.axes.pitch, want, 1e-12), `${core.axes.pitch.toFixed(4)} vs ${want.toFixed(4)}`);
}
{
  const core = createTouchCore();
  core.update(0);
  core.update(NaN);
  core.update(-1);
  core.begin('stick', 1, 0.5, 1);
  core.update(1e6);
  ok('a garbage dt cannot produce NaN or blow past the stop', Number.isFinite(core.axes.pitch) && Math.abs(core.axes.pitch) <= 1);
}

// ===========================================================================
console.log('\n\x1b[1mreturn to centre — the autopilot’s 0.3 disconnect\x1b[0m');
// ===========================================================================

{
  const core = createTouchCore();
  core.begin('stick', 1, 1, 1);
  settle(core);
  ok('both axes are at the stop before release', core.axes.pitch === 1 && core.axes.roll === 1);
  core.end(1);
  const t03 = timeUntil(core, (c) => Math.abs(c.axes.pitch) <= 0.3);
  const tz = timeUntil(core, (c) => c.axes.pitch === 0);
  note('release 1.0 → below the 0.3 AP threshold', `${t03.toFixed(3)} s`);
  note('release 1.0 → exactly 0', `${(t03 + tz).toFixed(3)} s`);
  ok('a released stick drops under the autopilot threshold quickly', t03 < 0.40, `${t03.toFixed(3)} s`);
  ok('a released stick reaches EXACTLY zero on both axes', core.axes.pitch === 0 && core.axes.roll === 0);
}
{
  const core = createTouchCore();
  core.begin('stick', 1, 1, 1);
  settle(core);
  core.end(1);
  settle(core, 10);
  ok('and it stays at exactly zero for ten seconds after', core.axes.pitch === 0 && core.axes.roll === 0);
}
{
  // The case that actually breaks an autopilot: a thumb resting on the pad,
  // wandering by a few pixels, never lifted.
  const core = createTouchCore();
  let worst = 0;
  let rng = 12345;
  const rand = () => ((rng = (rng * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  core.begin('stick', 1, 0.5, 0.5);
  for (let i = 0; i < 3600; i += 1) {
    // ±7% of the half-width of jitter — well inside a fingertip's own wander.
    core.move(1, 0.5 + (rand() - 0.5) * 0.14, 0.5 + (rand() - 0.5) * 0.14);
    core.update(DT);
    worst = Math.max(worst, Math.abs(core.axes.pitch), Math.abs(core.axes.roll));
  }
  note('worst |axis| over 60 s of a resting jittering thumb', worst.toFixed(6));
  ok('a resting thumb produces EXACTLY zero for a full minute', worst === 0, `worst=${worst}`);
}
{
  const core = createTouchCore();
  core.begin('rudder', 1, 1, 0.5);
  settle(core);
  core.end(1);
  settle(core, 2);
  ok('the rudder springs back to exactly zero too', core.axes.yaw === 0);
}
{
  const core = createTouchCore();
  core.begin('stick', 1, 1, 1);
  core.begin('rudder', 2, 1, 0.5);
  settle(core);
  core.cancelAll();
  settle(core, 2);
  ok('cancelAll() (blur, hidden tab, phone call) centres every axis', core.axes.pitch === 0 && core.axes.roll === 0 && core.axes.yaw === 0);
  ok('cancelAll() drops every pointer', core.pointerCount() === 0);
}
ok('CENTRE_EPS is small enough to be invisible and large enough to snap', CENTRE_EPS > 0 && CENTRE_EPS < 1e-3);

// ===========================================================================
console.log('\n\x1b[1mthrottle — a lever, not a spring\x1b[0m');
// ===========================================================================

{
  const core = createTouchCore();
  core.begin('throttle', 1, 0.5, 0.3);
  const set = core.throttle;
  core.end(1);
  for (let i = 0; i < 3600; i += 1) core.update(DT); // one minute of frames
  ok('the throttle holds its position for a full minute after release', core.throttle === set, `${core.throttle}`);
  ok('and releasing it hands the lever back', core.throttleGrabbed === false);
}
{
  const core = createTouchCore();
  core.begin('throttle', 1, 0.5, 0.35);
  ok('a finger on the slider claims the lever', core.throttleGrabbed === true);
  core.end(1);
  core.setThrottle(0.2);
  ok('setThrottle() moves the lever when no finger owns it', near(core.throttle, 0.2, 1e-12));
  core.begin('throttle', 2, 0.5, 0.5);
  core.setThrottle(0.9);
  ok('setThrottle() is ignored while a finger owns the lever', near(core.throttle, 0.5, 1e-12), `${core.throttle}`);
}
{
  // Grab vs jump. Landing on the lever must not teleport it.
  const core = createTouchCore();
  core.setThrottle(0.60);
  core.begin('throttle', 1, 0.5, 1 - 0.60 + THROTTLE_GRAB_TOL * 0.5);
  ok('touching ON the lever does not jump it', near(core.throttle, 0.60, 1e-12), `${core.throttle.toFixed(4)}`);
  core.move(1, 0.5, 1 - 0.60 + THROTTLE_GRAB_TOL * 0.5 - 0.20);
  ok('and it then tracks the finger relatively', near(core.throttle, 0.80, 1e-9), `${core.throttle.toFixed(4)}`);
  core.end(1);

  core.setThrottle(0.60);
  core.begin('throttle', 2, 0.5, 0.05);
  ok('touching FAR from the lever brings it to the finger', near(core.throttle, 0.95, 1e-12), `${core.throttle.toFixed(4)}`);
}
{
  const core = createTouchCore();
  core.begin('throttle', 1, 0.5, -3);
  ok('the lever clamps at full', core.throttle === 1);
  core.move(1, 0.5, 9);
  ok('the lever clamps at idle', core.throttle === 0);
  core.setThrottle(NaN);
  core.end(1);
  core.setThrottle(NaN);
  ok('a NaN lever command is refused, not propagated', core.throttle === 0);
}

// ===========================================================================
console.log('\n\x1b[1mmulti-touch — pointer identity, through the real DOM path\x1b[0m');
// ===========================================================================

{
  const m = mountOverlay(375, 812);
  ok('the overlay mounts three control surfaces', !!m.zones.stick && !!m.zones.rudder && !!m.zones.throttle);
  ok('the overlay root is inert — the HUD and canvas stay reachable', m.tc.root.style.pointerEvents === 'none');
  ok('each surface opts back in to pointer events', ['stick', 'rudder', 'throttle'].every((z) => m.zones[z].style.pointerEvents === 'auto'));
  ok('each surface sets touch-action: none (kills scroll/zoom/pull-to-refresh)', ['stick', 'rudder', 'throttle'].every((z) => m.zones[z].style.touchAction === 'none'));
  ok('nothing is bound to window except resize/orientation/blur', m.win.listenerCount() === 3, `${m.win.listenerCount()} window listeners`);
}
{
  const m = mountOverlay(375, 812);
  const { stick, throttle, rudder } = m.zones;
  const core = m.tc.core;

  // Finger 1: stick, hard back-right. Finger 2: throttle, near the top.
  let p = at(stick, 1, 1);
  fire(stick, 'pointerdown', { id: 11, x: p.x, y: p.y });
  p = at(throttle, 0.5, 0.1);
  fire(throttle, 'pointerdown', { id: 22, x: p.x, y: p.y });

  ok('two fingers are tracked at once', core.pointerCount() === 2);
  ok('the two pointers are on the two different zones', core.zoneOf(11) === 'stick' && core.zoneOf(22) === 'throttle');

  // Finger 3: rudder, right of centre.
  p = at(rudder, 0.9, 0.5);
  fire(rudder, 'pointerdown', { id: 33, x: p.x, y: p.y });
  ok('three fingers are tracked at once', core.pointerCount() === 3);

  for (let i = 0; i < 180; i += 1) m.tc.update(DT);
  ok('stick and throttle and rudder are ALL live simultaneously',
    core.axes.pitch === 1 && core.axes.roll === 1 && core.throttle > 0.85 && core.axes.yaw > 0.5,
    `pitch=${core.axes.pitch} roll=${core.axes.roll} thr=${core.throttle.toFixed(2)} yaw=${core.axes.yaw.toFixed(2)}`);

  const heldThrottle = core.throttle;
  // Lift the stick finger only.
  fire(stick, 'pointerup', { id: 11 });
  for (let i = 0; i < 120; i += 1) m.tc.update(DT);
  ok('lifting the stick finger does not disturb the throttle', core.throttle === heldThrottle);
  ok('lifting the stick finger does not disturb the rudder', core.axes.yaw > 0.5);
  ok('and the stick itself centres exactly', core.axes.pitch === 0 && core.axes.roll === 0);
  ok('the remaining two pointers survive', core.pointerCount() === 2);
}
{
  const m = mountOverlay(375, 812);
  const { stick, throttle } = m.zones;
  const core = m.tc.core;
  let p = at(stick, 0.9, 0.9);
  fire(stick, 'pointerdown', { id: 5, x: p.x, y: p.y });

  // A move carrying somebody else's pointerId must be ignored.
  p = at(stick, 0.1, 0.1);
  const before = { ...core.target };
  fire(stick, 'pointermove', { id: 6, x: p.x, y: p.y });
  ok('a move from a foreign pointerId is ignored', core.target.pitch === before.pitch && core.target.roll === before.roll);

  // So must an up.
  fire(stick, 'pointerup', { id: 99 });
  ok('an up from an unknown pointerId is ignored', core.pointerCount() === 1);

  // A second finger landing on the SAME pad must not fight the first.
  p = at(stick, 0.02, 0.02);
  fire(stick, 'pointerdown', { id: 7, x: p.x, y: p.y });
  ok('a second finger on the same pad is refused, not blended', core.pointerCount() === 1 && core.target.pitch > 0);

  // Capture is what makes a finger that wanders off the pad keep flying.
  ok('the surface captures its pointer', stick.captured.has(5));
  fire(throttle, 'pointerup', { id: 5 }); // capture routes strays back
  ok('capture is released on lift', !stick.captured.has(5) || core.pointerCount() === 0);
}
{
  const m = mountOverlay(375, 812);
  const { stick } = m.zones;
  const p = at(stick, 0.9, 0.9);
  ok('pointerdown on a control calls preventDefault', fire(stick, 'pointerdown', { id: 1, x: p.x, y: p.y }) === true);
  ok('pointermove on a control calls preventDefault', fire(stick, 'pointermove', { id: 1, x: p.x, y: p.y }) === true);
  ok('pointerup on a control calls preventDefault', fire(stick, 'pointerup', { id: 1 }) === true);
}
{
  const m = mountOverlay(375, 812);
  const { stick } = m.zones;
  const p = at(stick, 0.9, 0.9);
  fire(stick, 'pointerdown', { id: 1, x: p.x, y: p.y, button: 2 });
  ok('a non-primary mouse button does not fly the aeroplane', m.tc.core.pointerCount() === 1, 'touch pointers ignore `button`');
}
{
  const m = mountOverlay(375, 812);
  const { stick } = m.zones;
  const p = at(stick, 0.9, 0.9);
  fire(stick, 'pointerdown', { id: 1, x: p.x, y: p.y });
  for (let i = 0; i < 60; i += 1) m.tc.update(DT);
  fire(stick, 'pointercancel', { id: 1 });
  for (let i = 0; i < 60; i += 1) m.tc.update(DT);
  ok('pointercancel releases the stick (the iOS call-interruption case)', m.tc.core.axes.pitch === 0 && m.tc.core.axes.roll === 0);
}

// ===========================================================================
console.log('\n\x1b[1mbuttons\x1b[0m');
// ===========================================================================

ok('every button the round asked for exists', ['flaps', 'gear', 'brakes', 'camera', 'autopilot'].every((id) => BUTTONS.some((b) => b.id === id)));
ok('button ids are unique', new Set(BUTTONS.map((b) => b.id)).size === BUTTONS.length);
ok('only the brake is a hold button', BUTTONS.filter((b) => b.hold).map((b) => b.id).join(',') === 'brakes');
{
  const m = mountOverlay(375, 812);
  fire(m.buttons.get('flaps'), 'pointerdown', { id: 1 });
  fire(m.buttons.get('flaps'), 'pointerup', { id: 1 });
  ok('a tap fires the action exactly once on press', m.actions.filter((a) => a[0] === 'flaps' && a[1]).length === 1);

  fire(m.buttons.get('brakes'), 'pointerdown', { id: 2 });
  ok('holding BRK latches the brake flag', m.tc.core.brakeHeld === true);
  fire(m.buttons.get('brakes'), 'pointerup', { id: 2 });
  ok('releasing BRK clears it', m.tc.core.brakeHeld === false);

  fire(m.buttons.get('brakes'), 'pointerdown', { id: 3 });
  fire(m.buttons.get('brakes'), 'pointercancel', { id: 3 });
  ok('a cancelled BRK press does not leave the brakes on', m.tc.core.brakeHeld === false);
}
{
  const m = mountOverlay(375, 812);
  const { stick } = m.zones;
  const p = at(stick, 0.5, 1);
  fire(stick, 'pointerdown', { id: 1, x: p.x, y: p.y });
  fire(m.buttons.get('gear'), 'pointerdown', { id: 2 });
  fire(m.buttons.get('brakes'), 'pointerdown', { id: 3 });
  for (let i = 0; i < 120; i += 1) m.tc.update(DT);
  ok('a button press does not interrupt a stick that is already flying', m.tc.core.axes.pitch === 1 && m.tc.core.brakeHeld === true);
}

// ===========================================================================
console.log('\n\x1b[1mlayout — nothing overlaps, nothing leaves the screen\x1b[0m');
// ===========================================================================

const VIEWPORTS = [
  [320, 568, 'iPhone SE portrait'],
  [375, 812, 'iPhone X portrait'],
  [390, 844, 'iPhone 14 portrait'],
  [430, 932, 'iPhone Pro Max portrait'],
  [812, 375, 'iPhone X landscape'],
  [844, 390, 'iPhone 14 landscape'],
  [768, 1024, 'iPad portrait'],
  [1024, 768, 'iPad landscape'],
  [1180, 820, 'iPad Pro landscape'],
];

const overlaps = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

for (const [w, h, label] of VIEWPORTS) {
  const L = computeLayout(w, h);
  const rects = [L.stick, L.rudder, L.throttle, ...L.buttons];
  let bad = '';
  for (let i = 0; i < rects.length && !bad; i += 1) {
    const r = rects[i];
    if (r.x < 0 || r.y < 0 || r.x + r.w > w || r.y + r.h > h) bad = `rect ${i} off-screen`;
    if (Math.min(r.w, r.h) < MIN_TOUCH_PX) bad = `rect ${i} is ${r.w}x${r.h}`;
    for (let j = i + 1; j < rects.length && !bad; j += 1) {
      if (overlaps(r, rects[j])) bad = `rect ${i} overlaps ${j}`;
    }
  }
  ok(`${label} ${w}x${h}`, bad === '', bad || `stick ${L.stick.w}px · throttle ${L.throttle.w}x${L.throttle.h} · rudder ${L.rudder.w}x${L.rudder.h} · buttons ${L.grid.cols}x${L.grid.rows} @ ${L.buttons[0].w}x${L.buttons[0].h}`);
}
{
  const L = computeLayout(375, 812);
  note('375x812 stick pad', `${L.stick.w}x${L.stick.h} px`);
  note('375x812 rudder bar', `${L.rudder.w}x${L.rudder.h} px`);
  note('375x812 throttle', `${L.throttle.w}x${L.throttle.h} px`);
  note('375x812 buttons', `${L.grid.cols}x${L.grid.rows} @ ${L.buttons[0].w}x${L.buttons[0].h} px`);
  note('375x812 dead-zone slop', `${(L.stick.w * 0.5 * STICK_DEADZONE).toFixed(1)} px`);
  ok('the rudder bar is the widest control on a phone', L.rudder.w > L.stick.w && L.rudder.w > L.throttle.w, `${L.rudder.w} px of rudder`);
}
ok('computeLayout is pure — same input, identical output', JSON.stringify(computeLayout(390, 844)) === JSON.stringify(computeLayout(390, 844)));
ok('computeLayout survives garbage', (() => {
  const L = computeLayout(NaN, undefined);
  return Number.isFinite(L.stick.w) && L.stick.w >= MIN_TOUCH_PX;
})());
ok('the button grid reflows with the space it is given', computeLayout(320, 568).grid.cols === 1 && computeLayout(375, 812).grid.cols === 2 && computeLayout(1024, 768).grid.cols === 6);

// ===========================================================================
console.log('\n\x1b[1mdrawing and teardown\x1b[0m');
// ===========================================================================

{
  const m = mountOverlay(375, 812);
  const { stick } = m.zones;
  const knob = stick.children.find((c) => c.style.borderRadius === '50%' && c.style.willChange === 'transform');
  ok('the stick has a visible knob', !!knob);
  const p = at(stick, 0.98, 0.98);
  fire(stick, 'pointerdown', { id: 1, x: p.x, y: p.y });
  for (let i = 0; i < 120; i += 1) m.tc.update(DT);
  const moved = knob.style.transform;
  ok('the knob follows the axis, not the finger', /translate3d\(4[0-9]/.test(moved) || /translate3d\(\d\d\./.test(moved), moved);
  fire(stick, 'pointerup', { id: 1 });
  for (let i = 0; i < 120; i += 1) m.tc.update(DT);
  ok('the knob returns to the centre when the axis does', knob.style.transform === 'translate3d(0.0px,0.0px,0)', knob.style.transform);
}
{
  // THE STACKING CONTRACT. Three modules draw into the same corner of the same
  // page and each picked its own z-index in a different week: instruments.js
  // 20, touch.js 25, overlay.js 30. Those numbers only sort correctly if all
  // three share one stacking context, which is why main.js mounts this overlay
  // into #hud rather than taking input.js's default of the canvas's parent
  // (#hud carries z-index 10 and traps its children). Assert the middle
  // number here so a well-meaning bump to 40 has to come past a red check.
  const m = mountOverlay(375, 812);
  const root = m.parent.children.find((n) => n.getAttribute('data-touch-controls') === '1');
  ok('the touch root sits above the instrument panel', Number(root.style.zIndex) > 20, root.style.zIndex);
  ok('and below the chrome, so a menu sheet covers the thumbs', Number(root.style.zIndex) < 30, root.style.zIndex);
  ok('the root itself is inert — the canvas keeps everything the thumbs miss',
    root.style.pointerEvents === 'none');
  for (const z of ZONES) {
    ok(`the ${z} is addressable by name`, m.zones[z]?.getAttribute('data-touch-zone') === z);
  }
}
{
  const m = mountOverlay(375, 812);
  const before = m.win.listenerCount() + m.tc.root.listenerCount();
  ok('the overlay attached listeners', before > 20, `${before}`);
  m.tc.dispose();
  const after = m.win.listenerCount() + m.tc.root.listenerCount();
  ok('dispose() removes every listener', after === 0, `${after} left`);
  ok('dispose() unmounts the overlay', m.parent.children.length === 0);
}
{
  const m = mountOverlay(375, 812);
  const { stick } = m.zones;
  const p = at(stick, 0.9, 0.9);
  fire(stick, 'pointerdown', { id: 1, x: p.x, y: p.y });
  for (let i = 0; i < 60; i += 1) m.tc.update(DT);
  m.tc.setVisible(false);
  for (let i = 0; i < 120; i += 1) m.tc.update(DT);
  ok('hiding the overlay releases the stick', m.tc.core.axes.pitch === 0 && m.tc.core.axes.roll === 0);
  ok('hiding the overlay does not close the throttle', m.tc.core.throttle === 0);
}
{
  const m = mountOverlay(375, 812);
  m.tc.core.setThrottle(0.7);
  m.win.innerWidth = 812;
  m.win.innerHeight = 375;
  m.win.fire('resize');
  const L = m.tc.layout();
  ok('rotating the device relays out the overlay', L.w === 812 && L.h === 375 && L.grid.cols === 6);
  ok('rotating the device does not move the throttle lever', near(m.tc.core.throttle, 0.7, 1e-12));
}
{
  const m = mountOverlay(375, 812);
  const { stick } = m.zones;
  const p = at(stick, 0.9, 0.9);
  fire(stick, 'pointerdown', { id: 1, x: p.x, y: p.y });
  for (let i = 0; i < 60; i += 1) m.tc.update(DT);
  m.win.fire('blur');
  for (let i = 0; i < 120; i += 1) m.tc.update(DT);
  ok('losing focus centres the stick (the stuck-key failure, for thumbs)', m.tc.core.axes.pitch === 0 && m.tc.core.axes.roll === 0);
}

// ===========================================================================
console.log('\n\x1b[1mtier gating\x1b[0m');
// ===========================================================================

ok('a phone gets the thumb cockpit', shouldUseTouch('phone') === true);
ok('a tablet gets the thumb cockpit', shouldUseTouch('tablet') === true);
ok('a desktop does not', shouldUseTouch('desktop') === false);
ok('an unknown tier does not', shouldUseTouch(undefined) === false && shouldUseTouch('low') === false);

// ===========================================================================
console.log('\n\x1b[1mfuzz — 20,000 random pointer events\x1b[0m');
// ===========================================================================

{
  const core = createTouchCore();
  let rng = 987654321;
  const rand = () => ((rng = (rng * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  let bad = '';
  for (let i = 0; i < 20000 && !bad; i += 1) {
    const r = rand();
    const zone = ZONES[Math.floor(rand() * 3) % 3];
    const id = Math.floor(rand() * 4);
    if (r < 0.3) core.begin(zone, id, rand() * 1.4 - 0.2, rand() * 1.4 - 0.2);
    else if (r < 0.7) core.move(id, rand() * 1.4 - 0.2, rand() * 1.4 - 0.2);
    else if (r < 0.85) core.end(id);
    else if (r < 0.87) core.cancelAll();
    core.update(rand() * 0.05);
    const a = core.axes;
    if (!Number.isFinite(a.pitch) || Math.abs(a.pitch) > 1) bad = `pitch ${a.pitch}`;
    if (!Number.isFinite(a.roll) || Math.abs(a.roll) > 1) bad = `roll ${a.roll}`;
    if (!Number.isFinite(a.yaw) || Math.abs(a.yaw) > 1) bad = `yaw ${a.yaw}`;
    if (!Number.isFinite(core.throttle) || core.throttle < 0 || core.throttle > 1) bad = `throttle ${core.throttle}`;
    if (core.pointerCount() > 3) bad = `${core.pointerCount()} pointers on 3 zones`;
  }
  ok('20,000 random events never leave the legal range', bad === '', bad);
}
{
  // Release from every reachable deflection and prove EXACT zero every time.
  const core = createTouchCore();
  let worst = 0;
  let bad = 0;
  for (let k = 0; k <= 40; k += 1) {
    const v = k / 40;
    core.cancelAll();
    core.axes.pitch = 0;
    core.begin('stick', 1, v, v);
    settle(core, 2);
    core.end(1);
    settle(core, 3);
    if (core.axes.pitch !== 0 || core.axes.roll !== 0) bad += 1;
    worst = Math.max(worst, Math.abs(core.axes.pitch), Math.abs(core.axes.roll));
  }
  ok('41 releases from 41 different deflections all land on exactly 0', bad === 0 && worst === 0, `worst residual ${worst}`);
}

// ===========================================================================
console.log('\n\x1b[1mthe input.js branch — end to end, through the real contract\x1b[0m');
// ===========================================================================

// Everything above proves touch.js. This proves that what touch.js produces
// actually arrives in the object flightModel.step() is handed, with the right
// name and the right sign — the seam where a working stick still fails to fly.

const keydowns = [];
class FakeKeyboardEvent {
  constructor(type, init = {}) {
    this.type = type;
    Object.assign(this, init);
  }
  preventDefault() {}
  stopPropagation() {}
}
globalThis.KeyboardEvent = FakeKeyboardEvent;

const simWindow = new FakeWindow(375, 812);
simWindow.dispatchEvent = (e) => {
  if (e.type === 'keydown') keydowns.push(e.code);
  simWindow.fire(e.type, e);
  return true;
};
globalThis.window = simWindow;

// input.js derives its own dt from performance.now(). A tight test loop runs
// 120 frames in under a millisecond, so without a controlled clock the ramp
// barely advances and every assertion below reads ~0 for the wrong reason.
let clockMs = 1000;
globalThis.performance = { now: () => clockMs };

const { createInput } = await import('../src/controls/input.js');

/** The overlay root touch.js tags with data-touch-controls, or null. */
const overlayOf = (rootEl) => rootEl.find((n) => n.getAttribute('data-touch-controls') === '1');

/** Run `n` frames of the real per-frame path at a real 60 Hz. */
function frames(input, n) {
  let c = input.get();
  for (let i = 0; i < n; i += 1) {
    clockMs += 1000 / 60;
    c = input.get();
  }
  return c;
}

{
  const canvasParent = new El('div');
  const canvas = canvasParent.appendChild(new El('canvas'));
  const input = createInput(canvas, { touch: true });
  const core = input.touchCore();
  const L = input.touchLayout();

  ok('createInput mounts the thumb cockpit when asked', input.hasTouch() === true && !!core && !!L);

  const first = input.get();
  const second = input.get();
  ok('get() still returns the SAME object every frame', first === second);
  ok('the contract object still has exactly the seven fields',
    ['pitch', 'roll', 'yaw', 'throttle', 'flaps', 'brakes', 'gear'].every((k) => k in first)
    && Object.keys(first).length === 7);

  // Fly it: stick back-left, rudder right, throttle up.
  const surf = (z) => canvasParent.find((n) => n.getAttribute('data-touch-zone') === z);
  const stickEl = surf('stick');
  const rudderEl = surf('rudder');
  const throttleEl = surf('throttle');
  ok('the overlay mounted into the canvas’s parent', !!stickEl && !!rudderEl && !!throttleEl);
  ok('and every control it placed is where the layout says it is',
    [[stickEl, L.stick], [rudderEl, L.rudder], [throttleEl, L.throttle]].every(([n, r]) => {
      const g = n.getBoundingClientRect();
      return g.left === r.x && g.top === r.y && g.width === r.w && g.height === r.h;
    }));

  let p = at(stickEl, 0, 1);
  fire(stickEl, 'pointerdown', { id: 1, x: p.x, y: p.y });
  p = at(rudderEl, 0.97, 0.5);
  fire(rudderEl, 'pointerdown', { id: 2, x: p.x, y: p.y });
  p = at(throttleEl, 0.5, 0.1);
  fire(throttleEl, 'pointerdown', { id: 3, x: p.x, y: p.y });

  const c = frames(input, 120);
  ok('touch pitch reaches the contract object', c.pitch === 1, `pitch=${c.pitch}`);
  ok('touch roll reaches the contract object', c.roll === -1, `roll=${c.roll}`);
  ok('touch yaw reaches the contract object', c.yaw > 0.5, `yaw=${c.yaw.toFixed(3)}`);
  ok('touch throttle reaches the contract object', c.throttle > 0.85, `throttle=${c.throttle.toFixed(3)}`);
  ok('every value is still normalised', Math.abs(c.pitch) <= 1 && Math.abs(c.roll) <= 1 && Math.abs(c.yaw) <= 1 && c.throttle >= 0 && c.throttle <= 1);

  const held = c.throttle;
  fire(throttleEl, 'pointerup', { id: 3 });
  fire(stickEl, 'pointerup', { id: 1 });
  fire(rudderEl, 'pointerup', { id: 2 });
  const d = frames(input, 240);
  ok('released, pitch/roll/yaw are EXACTLY zero in the contract object', d.pitch === 0 && d.roll === 0 && d.yaw === 0);
  ok('and every one is under the autopilot’s 0.3 disconnect', Math.abs(d.pitch) < 0.3 && Math.abs(d.roll) < 0.3);
  ok('the throttle latched through input.js as well', d.throttle === held, `${d.throttle} vs ${held}`);

  // Buttons this module owns.
  const btn = (id) => canvasParent.find((n) => n.getAttribute('data-touch-button') === id);
  const flapsBefore = d.flaps;
  fire(btn('flaps'), 'pointerdown', { id: 9 });
  fire(btn('flaps'), 'pointerup', { id: 9 });
  ok('FLAP cycles the notch through the same path as the F key', frames(input, 1).flaps !== flapsBefore, `${flapsBefore} → ${input.get().flaps}`);
  const gearBefore = input.get().gear;
  fire(btn('gear'), 'pointerdown', { id: 9 });
  fire(btn('gear'), 'pointerup', { id: 9 });
  ok('GEAR toggles', frames(input, 1).gear !== gearBefore);

  fire(btn('brakes'), 'pointerdown', { id: 9 });
  const braked = frames(input, 30).brakes;
  ok('BRK ramps the brakes rather than switching them', braked > 0.2 && braked <= 1, `brakes=${braked.toFixed(3)}`);
  fire(btn('brakes'), 'pointerup', { id: 9 });
  ok('releasing BRK ramps them back off', frames(input, 30).brakes === 0);

  // App-level buttons, with no onAction handler: the synthetic-keydown path.
  keydowns.length = 0;
  for (const id of ['camera', 'autopilot', 'pause']) {
    fire(btn(id), 'pointerdown', { id: 9 });
    fire(btn(id), 'pointerup', { id: 9 });
  }
  ok('CAM / A/P / II dispatch C / L / P with no main.js wiring at all',
    keydowns.join(',') === 'KeyC,KeyL,KeyP', keydowns.join(','));

  // setThrottle() must move the drawn lever, not just the number.
  input.setThrottle(0.33);
  ok('setThrottle() moves the touch lever too', near(core.throttle, 0.33, 1e-12), `${core.throttle}`);
  ok('and the next frame does not fight it back', near(frames(input, 2).throttle, 0.33, 1e-9));

  input.dispose();
  ok('input.dispose() tears the overlay down with it', overlayOf(canvasParent) === null && input.hasTouch() === false);
}
{
  const canvasParent = new El('div');
  const canvas = canvasParent.appendChild(new El('canvas'));
  const seen = [];
  const input = createInput(canvas, { touch: true, onAction: (id) => seen.push(id) });
  const btn = (id) => canvasParent.find((n) => n.getAttribute('data-touch-button') === id);
  keydowns.length = 0;
  fire(btn('autopilot'), 'pointerdown', { id: 1 });
  fire(btn('autopilot'), 'pointerup', { id: 1 });
  ok('an onAction handler takes precedence over the synthetic keydown', seen.join(',') === 'autopilot' && keydowns.length === 0);
  ok('onAction does not receive the buttons input.js owns', !seen.includes('flaps'));
  input.dispose();
}
{
  const canvasParent = new El('div');
  const canvas = canvasParent.appendChild(new El('canvas'));
  const input = createInput(canvas, { touch: false });
  ok('touch: false builds no overlay at all — desktop is untouched', input.hasTouch() === false && overlayOf(canvasParent) === null);
  const c = input.get();
  ok('and the contract object is unchanged', c.pitch === 0 && c.roll === 0 && c.yaw === 0 && c.gear === 1);
  input.dispose();
}
{
  const { resolveTouchTier } = await import('../src/controls/input.js');
  ok('?touch=1 forces the thumb cockpit on', resolveTouchTier('auto', '?tier=phone&touch=1') === true);
  ok('?touch=0 forces it off', resolveTouchTier('auto', '?touch=0') === false);
  ok('an explicit boolean beats the query string', resolveTouchTier(false, '?touch=1') === false && resolveTouchTier(true, '?touch=0') === true);
  ok('with no signals and no override, a headless environment gets no overlay', resolveTouchTier('auto', '') === false);
}

// ===========================================================================

console.log('\n\x1b[1mmeasured\x1b[0m');
for (const [k, v] of measurements) console.log(`  ${k.padEnd(46)} ${v}`);

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
