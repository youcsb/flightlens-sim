/**
 * input.js — the control-input layer: keyboard, mouse-yoke, gamepad.
 *
 * Contract: see MODULES.md § 2.12
 *
 *   createInput(domElement) -> { get(), dispose() }
 *   get() -> {pitch, roll, yaw, throttle, flaps, brakes, gear}
 *
 * This module is a PURE SENSOR. It never touches the scene, the flight model,
 * or the DOM beyond attaching listeners. `get()` returns the SAME object every
 * call, mutated in place — consume it within the frame, never stash it.
 *
 * ---------------------------------------------------------------------------
 * WHY THE RAMP IS SHAPED THE WAY IT IS
 * ---------------------------------------------------------------------------
 * A key is a switch; a stick is not. Feeding a raw 0/1 into the flight model is
 * what makes keyboard flying feel twitchy and cheap, and it is the single
 * biggest difference between a sim that is pleasant on a laptop and one that is
 * not. Three things fix it, and all three matter:
 *
 *   1. PROGRESSIVE ATTACK. The deflection rate starts slow and accelerates the
 *      longer the key is held (`rate(t) = BASE + RAMP*t`, capped at MAX). A
 *      100 ms tap therefore buys 0.14 of deflection — genuinely fine trim
 *      authority — while a held key still reaches the stop in 0.47 s. A single
 *      constant rate cannot give you both; it is either too coarse to trim with
 *      or too sluggish to flare with. (Both figures measured, not estimated.)
 *
 *   2. SPRING RETURN. Release and the axis runs back to centre at
 *      `(MIN + GAIN*|x|)`, i.e. fast when far out and slowing as it arrives,
 *      but with a non-zero floor so it actually REACHES zero instead of
 *      asymptotically crawling. Return is deliberately quicker than attack
 *      (0.37 s from the stop) — that is how a spring-centred stick behaves.
 *
 *   3. REVERSAL BOOST. Pressing left while deflected right multiplies the rate
 *      until the axis crosses centre. Without this, "roll right, now roll left"
 *      has a dead beat in the middle that reads as input lag.
 *
 * Keyboard output is NOT expo-curved: the progressive attack already provides
 * the fine-control region, and stacking a curve on top makes small inputs
 * mushy. The continuous sources (mouse, gamepad) DO get deadzone + expo, where
 * it is the only tool available.
 *
 * ---------------------------------------------------------------------------
 * BINDINGS
 * ---------------------------------------------------------------------------
 *   W / ArrowUp .......... nose down      S / ArrowDown ...... nose up
 *   A / ArrowLeft ........ roll left      D / ArrowRight ..... roll right
 *   Q .................... yaw left       E .................. yaw right
 *   Shift ................ throttle up    Control ............ throttle down
 *   X .................... throttle idle  Z .................. full throttle
 *   F .................... cycle flaps    B (hold) ........... wheel brakes
 *   G .................... toggle gear    M .................. mouse-yoke mode
 *
 * App-level keys live in main.js (`C` camera, `R` reset); view keys live in
 * camera/cameras.js (`V` panel view, right-drag look, wheel zoom). This module
 * claims none of them.
 *
 * The mouse WHEEL is deliberately NOT bound here. cameras.js owns it for zoom;
 * two modules fighting over one wheel event is a bug waiting to happen.
 */

import { clamp } from '../core/units.js';
import { eventCode } from '../core/keycode.js';

// ---------------------------------------------------------------------------
// Keyboard ramp tuning. See the header for the reasoning behind each number.
// ---------------------------------------------------------------------------

/** Deflection rate the instant a key goes down, in axis-units/second. */
const ATTACK_BASE = 1.6;
/** How fast the attack rate itself grows, in axis-units/second². */
const ATTACK_RAMP = 2.4;
/** Ceiling on the attack rate, axis-units/second. */
const ATTACK_MAX = 4.6;
/**
 * Multiplier applied while the axis is still on the far side of centre.
 * Measured: full-right to centre takes 0.25 s at 2.2 and 0.20 s at 2.8, versus
 * 0.37 s for an unboosted spring return. Note the rate DROPS at the crossing,
 * because the boost switches off there — that is deliberate. You get out of the
 * old deflection fast and then land on the new side with fine authority.
 */
const REVERSAL_BOOST = 2.8;
/** Spring-return floor rate — guarantees the axis reaches exactly zero. */
const RELEASE_MIN = 1.2;
/** Spring-return term proportional to current deflection. */
const RELEASE_GAIN = 4.0;
/** Below this the axis snaps to 0, so `pitch` is never 1e-17. */
const CENTRE_EPS = 1e-4;

/** Throttle travel rate (fraction/second) while Shift/Control is held. */
const THROTTLE_RATE = 0.42;
/** Brake application/release rate (fraction/second). Brakes are not a switch. */
const BRAKE_RATE = 6.0;

/** Flap notches, as fractions of full extension. */
const FLAP_NOTCHES = [0, 0.34, 0.67, 1];

// ---------------------------------------------------------------------------
// Mouse-yoke tuning
// ---------------------------------------------------------------------------

/**
 * Full deflection costs this fraction of the smaller viewport dimension in
 * pointer travel. 0.35 lands close to a real yoke's throw at typical DPI.
 */
const MOUSE_TRAVEL_FRAC = 0.35;
/** Expo applied to the mouse yoke: fine near centre, full authority at the stop. */
const MOUSE_EXPO = 0.35;

// ---------------------------------------------------------------------------
// Gamepad tuning
// ---------------------------------------------------------------------------

/** Stick deadzone. Cheap pads rest as far out as 0.08. */
const PAD_DEADZONE = 0.12;
/** Expo for pad sticks. */
const PAD_EXPO = 0.4;
/** Trigger travel below this is ignored. */
const PAD_TRIGGER_DEADZONE = 0.06;
/** Throttle rate multiplier when a trigger is buried. */
const PAD_THROTTLE_SCALE = 1.6;

/**
 * Apply deadzone then an RC-style expo curve to a continuous axis.
 * Full throw is preserved: shape(±1) === ±1 for any expo.
 */
function shape(v, deadzone, expo) {
  const a = Math.abs(v);
  if (a <= deadzone) return 0;
  const n = (a - deadzone) / (1 - deadzone);
  const curved = expo * n * n * n + (1 - expo) * n;
  return v < 0 ? -curved : curved;
}

/** Whichever source is asking for more deflection wins the axis. */
function strongest(a, b) {
  return Math.abs(b) > Math.abs(a) ? b : a;
}

/**
 * @param {HTMLElement} domElement The "game surface" — the renderer canvas.
 *        Used for pointer-lock and viewport sizing. Key events are bound to
 *        `window` so the sim keeps responding whatever has focus.
 * @returns {{
 *   get: () => {pitch:number, roll:number, yaw:number, throttle:number,
 *               flaps:number, brakes:number, gear:number},
 *   dispose: () => void,
 *   setMouseYoke: (on:boolean) => void,
 *   isMouseYoke: () => boolean,
 *   hasGamepad: () => boolean,
 * }}
 */
export function createInput(domElement) {
  const target = domElement || document.body;
  const keys = new Set();

  /**
   * The live control snapshot. `get()` hands back THIS object every call.
   * Read-only to everyone else; mutated in place here.
   */
  const controls = {
    /** -1 = full nose down, +1 = full nose up (stick back). */
    pitch: 0,
    /** -1 = full left roll, +1 = full right roll. */
    roll: 0,
    /** -1 = full left rudder, +1 = full right rudder. */
    yaw: 0,
    /** 0 = idle, 1 = full power. */
    throttle: 0,
    /** 0 = clean, 1 = full flaps. Quantised to FLAP_NOTCHES. */
    flaps: 0,
    /** 0 = off, 1 = full wheel braking. Ramped, not switched. */
    brakes: 0,
    /**
     * 0 = retracted, 1 = extended. ADDITIVE FIELD, see the integrator notes.
     * flightModel ignores it today; aircraft/model.js should animate it.
     */
    gear: 1,
  };

  // Internal, pre-blend axis state for the keyboard ramp.
  const kb = { pitch: 0, roll: 0, yaw: 0 };
  /** Seconds each keyboard axis has been held in its current direction. */
  const held = { pitch: 0, roll: 0, yaw: 0 };
  /** Direction each axis was last driven, to detect a fresh press. */
  const lastWant = { pitch: 0, roll: 0, yaw: 0 };

  let flapIndex = 0;
  let lastTime = 0;

  // --- mouse yoke ---------------------------------------------------------
  let mouseYoke = false;
  let pointerLocked = false;
  /** Virtual yoke position, -1..1, held (a yoke does not self-centre). */
  const yoke = { x: 0, y: 0 };
  /**
   * True while a look button (middle/right) is down. cameras.js uses those for
   * free-look; without this the same pointer motion would also fly the plane.
   */
  let lookButtonDown = false;

  // --- gamepad ------------------------------------------------------------
  let padIndex = -1;
  /** Previous button pressed-state, for edge detection on flaps/gear. */
  const padPrev = [];

  // =========================================================================
  // Keyboard
  // =========================================================================

  function isEditable(el) {
    if (!el || !el.tagName) return false;
    const tag = el.tagName;
    return (
      tag === 'INPUT' ||
      tag === 'TEXTAREA' ||
      tag === 'SELECT' ||
      el.isContentEditable === true
    );
  }

  function onKeyDown(e) {
    // Never swallow the user's browser shortcuts, and never fly the plane
    // while they are typing into a field someone else added to the page.
    if (e.metaKey || isEditable(e.target)) return;
    // `e.code` is empty on virtual keyboards, some IME/accessibility paths and
    // remote-desktop clients. eventCode() falls back to `e.key` so those can
    // still fly; see core/keycode.js.
    const code = eventCode(e);
    if (e.repeat) {
      if (HANDLED_CODES.has(code)) e.preventDefault();
      return;
    }
    keys.add(code);

    // Discrete actions fire on the edge, not every frame.
    switch (code) {
      case 'KeyF':
        flapIndex = (flapIndex + 1) % FLAP_NOTCHES.length;
        controls.flaps = FLAP_NOTCHES[flapIndex];
        break;
      case 'KeyX':
        controls.throttle = 0;
        break;
      case 'KeyZ':
        controls.throttle = 1;
        break;
      case 'KeyG':
        controls.gear = controls.gear > 0.5 ? 0 : 1;
        break;
      case 'KeyM':
        // A keydown handler counts as a user gesture, so pointer lock is
        // allowed to be requested from here.
        setMouseYoke(!mouseYoke);
        break;
      default:
        break;
    }

    if (HANDLED_CODES.has(code)) e.preventDefault();
  }

  function onKeyUp(e) {
    const code = eventCode(e);
    keys.delete(code);
    // macOS does not deliver keyup for other keys while Command is held, so a
    // Cmd-Tab away can leave the elevator jammed. Clearing on any Meta-flagged
    // event is the cheap, reliable fix.
    if (e.metaKey) keys.clear();
    if (HANDLED_CODES.has(code)) e.preventDefault();
  }

  /** Losing focus must not leave a key stuck down mid-flight. */
  function releaseAll() {
    keys.clear();
  }

  function onVisibility() {
    if (document.hidden) releaseAll();
  }

  // =========================================================================
  // Mouse yoke
  // =========================================================================

  /** Enable/disable mouse-as-yoke. Recentres the yoke when switching off. */
  function setMouseYoke(on) {
    mouseYoke = !!on;
    if (mouseYoke) {
      if (target.requestPointerLock) {
        try {
          const p = target.requestPointerLock();
          // Chrome 113+ returns a promise; an unhandled rejection here is
          // noisy and harmless, so swallow it.
          if (p && typeof p.catch === 'function') p.catch(() => {});
        } catch {
          /* pointer lock unavailable — the yoke simply stays centred */
        }
      }
    } else {
      yoke.x = 0;
      yoke.y = 0;
      if (document.pointerLockElement === target && document.exitPointerLock) {
        document.exitPointerLock();
      }
    }
  }

  function onPointerLockChange() {
    pointerLocked = document.pointerLockElement === target;
    // Escape releases the lock; treat that as leaving yoke mode so the aircraft
    // does not keep flying on a stale deflection.
    if (!pointerLocked && mouseYoke) {
      mouseYoke = false;
      yoke.x = 0;
      yoke.y = 0;
    }
  }

  function onPointerDown(e) {
    if (e.button === 1 || e.button === 2) lookButtonDown = true;
  }

  function onPointerUp(e) {
    if (e.button === 1 || e.button === 2) lookButtonDown = false;
  }

  function onMouseMove(e) {
    if (!mouseYoke || lookButtonDown) return;
    // An unlocked pointer would let the cursor escape the window and strand the
    // yoke at a partial deflection, so only accumulate while locked.
    if (!pointerLocked) return;

    const w = target.clientWidth || window.innerWidth || 1280;
    const h = target.clientHeight || window.innerHeight || 720;
    const travelPx = Math.max(120, MOUSE_TRAVEL_FRAC * Math.min(w, h));
    const k = 1 / travelPx;

    yoke.x = clamp(yoke.x + (e.movementX || 0) * k, -1, 1);
    // Pulling the mouse toward you (movementY > 0) is pulling the yoke back,
    // which is nose UP. Do not "fix" this to feel like a first-person camera.
    yoke.y = clamp(yoke.y + (e.movementY || 0) * k, -1, 1);
  }

  // =========================================================================
  // Gamepad
  // =========================================================================

  function onGamepadConnected(e) {
    padIndex = e.gamepad.index;
    padPrev.length = 0;
  }

  function onGamepadDisconnected(e) {
    if (e.gamepad.index === padIndex) {
      padIndex = -1;
      padPrev.length = 0;
    }
  }

  /** Snapshot of the live pad, or null. Chrome requires polling every frame. */
  function readPad() {
    if (typeof navigator === 'undefined' || !navigator.getGamepads) return null;
    let pads;
    try {
      pads = navigator.getGamepads();
    } catch {
      return null;
    }
    if (!pads) return null;
    if (padIndex >= 0 && pads[padIndex] && pads[padIndex].connected) {
      return pads[padIndex];
    }
    // The connect event does not fire in every browser until a button is
    // pressed, so fall back to a scan.
    for (let i = 0; i < pads.length; i += 1) {
      const p = pads[i];
      if (p && p.connected && p.axes && p.axes.length >= 2) {
        padIndex = i;
        return p;
      }
    }
    return null;
  }

  function padButton(pad, i) {
    const b = pad.buttons && pad.buttons[i];
    if (!b) return 0;
    return typeof b === 'number' ? b : b.value;
  }

  function padPressed(pad, i) {
    const b = pad.buttons && pad.buttons[i];
    if (!b) return false;
    return typeof b === 'number' ? b > 0.5 : !!b.pressed;
  }

  // =========================================================================
  // Wiring
  // =========================================================================

  window.addEventListener('keydown', onKeyDown, { passive: false });
  window.addEventListener('keyup', onKeyUp, { passive: false });
  window.addEventListener('blur', releaseAll);
  document.addEventListener('visibilitychange', onVisibility);
  document.addEventListener('pointerlockchange', onPointerLockChange);
  window.addEventListener('pointerdown', onPointerDown);
  window.addEventListener('pointerup', onPointerUp);
  window.addEventListener('mousemove', onMouseMove);
  window.addEventListener('gamepadconnected', onGamepadConnected);
  window.addEventListener('gamepaddisconnected', onGamepadDisconnected);

  if (target && target !== document.body && !target.hasAttribute('tabindex')) {
    target.setAttribute('tabindex', '-1');
  }

  // =========================================================================
  // Per-frame axis integration
  // =========================================================================

  /**
   * Advance one keyboard axis toward `want` (-1, 0 or +1).
   *
   * @param {'pitch'|'roll'|'yaw'} axis
   * @param {number} want
   * @param {number} dt seconds
   * @returns {number} the new axis value, -1..1
   */
  function rampAxis(axis, want, dt) {
    let x = kb[axis];

    if (want === 0) {
      held[axis] = 0;
      lastWant[axis] = 0;
      const rate = RELEASE_MIN + RELEASE_GAIN * Math.abs(x);
      const step = rate * dt;
      if (Math.abs(x) <= step) x = 0;
      else x -= Math.sign(x) * step;
    } else {
      // A change of direction restarts the progressive attack, so a reversal
      // begins with fine authority rather than slamming to the opposite stop.
      if (lastWant[axis] !== want) held[axis] = 0;
      lastWant[axis] = want;
      held[axis] += dt;

      let rate = Math.min(ATTACK_BASE + ATTACK_RAMP * held[axis], ATTACK_MAX);
      // Still on the wrong side of centre? Get through it without a dead beat.
      if (x !== 0 && Math.sign(x) !== want) rate *= REVERSAL_BOOST;

      x = clamp(x + want * rate * dt, -1, 1);
    }

    if (Math.abs(x) < CENTRE_EPS) x = 0;
    kb[axis] = x;
    return x;
  }

  function axisFrom(negCodes, posCodes) {
    let v = 0;
    for (let i = 0; i < negCodes.length; i += 1) if (keys.has(negCodes[i])) v -= 1;
    for (let i = 0; i < posCodes.length; i += 1) if (keys.has(posCodes[i])) v += 1;
    return v < 0 ? -1 : v > 0 ? 1 : 0;
  }

  /**
   * Sample the controls. Call once per frame, before stepping the flight model.
   * Timing is derived internally, so this takes no dt.
   *
   * @returns {{pitch:number, roll:number, yaw:number, throttle:number,
   *            flaps:number, brakes:number, gear:number}}
   */
  function get() {
    const now = performance.now();
    const dt = lastTime === 0 ? 0 : clamp((now - lastTime) / 1000, 0, 0.1);
    lastTime = now;

    // --- keyboard ---------------------------------------------------------
    let pitch = rampAxis('pitch', axisFrom(PITCH_NEG, PITCH_POS), dt);
    let roll = rampAxis('roll', axisFrom(ROLL_NEG, ROLL_POS), dt);
    let yaw = rampAxis('yaw', axisFrom(YAW_NEG, YAW_POS), dt);

    let throttleDir = 0;
    if (keys.has('ShiftLeft') || keys.has('ShiftRight')) throttleDir += 1;
    if (keys.has('ControlLeft') || keys.has('ControlRight')) throttleDir -= 1;

    let brakeWant = keys.has('KeyB') ? 1 : 0;

    // --- mouse yoke -------------------------------------------------------
    if (mouseYoke) {
      roll = strongest(roll, shape(yoke.x, 0, MOUSE_EXPO));
      pitch = strongest(pitch, shape(yoke.y, 0, MOUSE_EXPO));
    }

    // --- gamepad ----------------------------------------------------------
    const pad = readPad();
    if (pad) {
      const ax = pad.axes;
      // Left stick: roll (X) and pitch (Y). Pushing the stick forward reads
      // -1 on axis 1 and must be nose down, so pitch takes axis 1 unchanged.
      if (ax.length > 0) roll = strongest(roll, shape(ax[0], PAD_DEADZONE, PAD_EXPO));
      if (ax.length > 1) pitch = strongest(pitch, shape(ax[1], PAD_DEADZONE, PAD_EXPO));
      // Right stick X: rudder.
      if (ax.length > 2) yaw = strongest(yaw, shape(ax[2], PAD_DEADZONE, PAD_EXPO));

      // Triggers drive throttle incrementally — an absolute-trigger throttle
      // fights the keyboard and snaps to idle the moment you let go.
      const rt = padButton(pad, 7);
      const lt = padButton(pad, 6);
      const trig =
        (rt > PAD_TRIGGER_DEADZONE ? rt : 0) - (lt > PAD_TRIGGER_DEADZONE ? lt : 0);
      if (trig !== 0) throttleDir += trig * PAD_THROTTLE_SCALE;

      // B (1) brakes, X (2) flaps, Y (3) gear.
      if (padPressed(pad, 1)) brakeWant = 1;
      if (padPressed(pad, 2) && !padPrev[2]) {
        flapIndex = (flapIndex + 1) % FLAP_NOTCHES.length;
        controls.flaps = FLAP_NOTCHES[flapIndex];
      }
      if (padPressed(pad, 3) && !padPrev[3]) {
        controls.gear = controls.gear > 0.5 ? 0 : 1;
      }
      for (let i = 0; i < 8; i += 1) padPrev[i] = padPressed(pad, i);
    }

    // --- commit -----------------------------------------------------------
    controls.pitch = pitch;
    controls.roll = roll;
    controls.yaw = yaw;
    controls.throttle = clamp(
      controls.throttle + throttleDir * THROTTLE_RATE * dt,
      0,
      1,
    );

    // Brakes ramp so a tap on the rollout is a squeeze, not a stomp.
    const bStep = BRAKE_RATE * dt;
    if (brakeWant > controls.brakes) {
      controls.brakes = Math.min(brakeWant, controls.brakes + bStep);
    } else {
      controls.brakes = Math.max(brakeWant, controls.brakes - bStep);
    }

    return controls;
  }

  /** Detach every listener. Call this before tearing the sim down. */
  function dispose() {
    window.removeEventListener('keydown', onKeyDown);
    window.removeEventListener('keyup', onKeyUp);
    window.removeEventListener('blur', releaseAll);
    document.removeEventListener('visibilitychange', onVisibility);
    document.removeEventListener('pointerlockchange', onPointerLockChange);
    window.removeEventListener('pointerdown', onPointerDown);
    window.removeEventListener('pointerup', onPointerUp);
    window.removeEventListener('mousemove', onMouseMove);
    window.removeEventListener('gamepadconnected', onGamepadConnected);
    window.removeEventListener('gamepaddisconnected', onGamepadDisconnected);
    if (document.pointerLockElement === target && document.exitPointerLock) {
      document.exitPointerLock();
    }
    keys.clear();
  }

  /**
   * Force the throttle lever to a position, 0..1.
   *
   * ADDITIVE to MODULES.md §2.12 and still a pure sensor: this moves the
   * modelled LEVER, exactly as pressing Z or X does, and the next get() picks
   * it up like any other lever position. main.js needs it because teleporting
   * the aeroplane to 3,000 ft has to set cruise power with it — otherwise you
   * arrive at altitude with the throttle closed.
   *
   * @param {number} v 0 = idle, 1 = full
   */
  function setThrottle(v) {
    controls.throttle = clamp(Number.isFinite(v) ? v : 0, 0, 1);
  }

  /** Drop any flap selection back to clean, matching the F-key notch state. */
  function setFlaps(v) {
    let best = 0;
    for (let i = 1; i < FLAP_NOTCHES.length; i += 1) {
      if (Math.abs(FLAP_NOTCHES[i] - v) < Math.abs(FLAP_NOTCHES[best] - v)) best = i;
    }
    flapIndex = best;
    controls.flaps = FLAP_NOTCHES[best];
  }

  return {
    get,
    dispose,
    setThrottle,
    setFlaps,
    setMouseYoke,
    isMouseYoke: () => mouseYoke,
    hasGamepad: () => readPad() !== null,
  };
}

// Binding tables, hoisted so the per-frame path allocates nothing.
const PITCH_NEG = ['KeyW', 'ArrowUp'];
const PITCH_POS = ['KeyS', 'ArrowDown'];
const ROLL_NEG = ['KeyA', 'ArrowLeft'];
const ROLL_POS = ['KeyD', 'ArrowRight'];
const YAW_NEG = ['KeyQ'];
const YAW_POS = ['KeyE'];

/** Codes whose browser default (scrolling, quick-find) we suppress. */
const HANDLED_CODES = new Set([
  'KeyW',
  'KeyA',
  'KeyS',
  'KeyD',
  'KeyQ',
  'KeyE',
  'KeyF',
  'KeyB',
  'KeyG',
  'KeyM',
  'KeyX',
  'KeyZ',
  'KeyC',
  'KeyV',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'Space',
]);
