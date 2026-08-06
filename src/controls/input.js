/**
 * input.js — the control-input layer. Keyboard now; gamepad/touch later.
 *
 * STUB IMPLEMENTATION. Keyboard only, with linear ramping so held keys feel
 * like a spring-centred stick. Replace the internals; do not change the
 * exported signature or the shape of the object `get()` returns.
 *
 * Contract: see MODULES.md § input
 *
 *   createInput(domElement) -> { get(), dispose() }
 *
 * This module is a pure sensor. It never touches the scene, the flight model,
 * or the DOM beyond attaching listeners.
 *
 * DEFAULT BINDINGS
 *   W / ArrowUp .......... nose down      S / ArrowDown ...... nose up
 *   A / ArrowLeft ........ roll left      D / ArrowRight ..... roll right
 *   Q .................... yaw left       E .................. yaw right
 *   Shift ................ throttle up    Control ............ throttle down
 *   F .................... cycle flaps    B (hold) ........... wheel brakes
 *   X .................... throttle idle  Z .................. full throttle
 */

import { clamp } from '../core/units.js';

/** How fast a held axis key drives the axis to full deflection (units/second). */
const AXIS_ATTACK = 3.2;
/** How fast a released axis springs back to centre (units/second). */
const AXIS_RELEASE = 4.5;
/** Throttle travel rate (fraction/second) while Shift/Control is held. */
const THROTTLE_RATE = 0.55;
/** Flap notches, as fractions of full extension. */
const FLAP_NOTCHES = [0, 0.34, 0.67, 1];

/**
 * @param {HTMLElement} domElement Element that represents the "game surface".
 *        Used for focus management and to swallow browser default scrolling.
 *        Key events themselves are captured on `window` so the sim keeps
 *        responding regardless of which child element has focus.
 * @returns {{ get: () => {pitch:number, roll:number, yaw:number, throttle:number, flaps:number, brakes:number}, dispose: () => void }}
 */
export function createInput(domElement) {
  const target = domElement || document.body;
  const keys = new Set();

  /**
   * The live control snapshot. `get()` hands back THIS object every call —
   * treat it as read-only and consume it before the next frame. Do not stash it
   * expecting a historical value; it is mutated in place.
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
    /** 0 = off, 1 = full wheel braking. */
    brakes: 0,
  };

  let flapIndex = 0;
  let lastTime = 0;

  function onKeyDown(e) {
    if (e.repeat) {
      e.preventDefault();
      return;
    }
    keys.add(e.code);

    // Discrete actions fire on the edge, not every frame.
    if (e.code === 'KeyF') {
      flapIndex = (flapIndex + 1) % FLAP_NOTCHES.length;
      controls.flaps = FLAP_NOTCHES[flapIndex];
    } else if (e.code === 'KeyX') {
      controls.throttle = 0;
    } else if (e.code === 'KeyZ') {
      controls.throttle = 1;
    }

    if (HANDLED_CODES.has(e.code)) e.preventDefault();
  }

  function onKeyUp(e) {
    keys.delete(e.code);
    if (HANDLED_CODES.has(e.code)) e.preventDefault();
  }

  /** Losing focus must not leave a key stuck down mid-flight. */
  function onBlur() {
    keys.clear();
  }

  window.addEventListener('keydown', onKeyDown, { passive: false });
  window.addEventListener('keyup', onKeyUp, { passive: false });
  window.addEventListener('blur', onBlur);

  if (target && target !== document.body) {
    if (!target.hasAttribute('tabindex')) target.setAttribute('tabindex', '-1');
  }

  /** Ramp one axis toward `want` (-1, 0, or +1). */
  function rampAxis(current, want, dt) {
    if (want === 0) {
      const step = AXIS_RELEASE * dt;
      if (Math.abs(current) <= step) return 0;
      return current - Math.sign(current) * step;
    }
    return clamp(current + want * AXIS_ATTACK * dt, -1, 1);
  }

  function axisFrom(negCodes, posCodes) {
    let v = 0;
    for (const c of negCodes) if (keys.has(c)) v -= 1;
    for (const c of posCodes) if (keys.has(c)) v += 1;
    return clamp(v, -1, 1);
  }

  /**
   * Sample the controls. Call once per frame, before stepping the flight model.
   * Timing is derived internally, so this takes no dt.
   *
   * @returns {{pitch:number, roll:number, yaw:number, throttle:number, flaps:number, brakes:number}}
   */
  function get() {
    const now = performance.now();
    const dt = lastTime === 0 ? 0 : clamp((now - lastTime) / 1000, 0, 0.1);
    lastTime = now;

    controls.pitch = rampAxis(
      controls.pitch,
      axisFrom(['KeyW', 'ArrowUp'], ['KeyS', 'ArrowDown']),
      dt,
    );
    controls.roll = rampAxis(
      controls.roll,
      axisFrom(['KeyA', 'ArrowLeft'], ['KeyD', 'ArrowRight']),
      dt,
    );
    controls.yaw = rampAxis(controls.yaw, axisFrom(['KeyQ'], ['KeyE']), dt);

    let throttleDir = 0;
    if (keys.has('ShiftLeft') || keys.has('ShiftRight')) throttleDir += 1;
    if (keys.has('ControlLeft') || keys.has('ControlRight')) throttleDir -= 1;
    controls.throttle = clamp(
      controls.throttle + throttleDir * THROTTLE_RATE * dt,
      0,
      1,
    );

    controls.brakes = keys.has('KeyB') ? 1 : 0;

    return controls;
  }

  /** Detach every listener. Call this before tearing the sim down. */
  function dispose() {
    window.removeEventListener('keydown', onKeyDown);
    window.removeEventListener('keyup', onKeyUp);
    window.removeEventListener('blur', onBlur);
    keys.clear();
  }

  return { get, dispose };
}

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
  'KeyX',
  'KeyZ',
  'KeyC',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'Space',
]);
