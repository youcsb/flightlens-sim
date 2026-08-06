/**
 * flightModel.js — the flight dynamics model. The single owner of aircraft state.
 *
 * STUB IMPLEMENTATION. Arcade kinematics: stick inputs drive body rotation
 * rates directly, throttle drives speed along the nose vector, and the ground
 * is a hard floor. There are no aerodynamic forces yet. Replace the internals;
 * do not change the exported signature or the shape of `state`.
 *
 * Contract: see MODULES.md § flight model
 *
 *   createFlightModel(opts) -> { state, step(dt, inputs, groundHeight), reset(lat, lon, headingDeg) }
 *
 * UNITS — the sim is metric. `state` carries BOTH:
 *   - metric primary values (position m, velocity m/s, orientation quaternion)
 *   - precomputed display values (airspeedKts, altitudeFt, ...) for the HUD
 * Physics code must read the metric ones. UI code must read the display ones.
 * Nothing outside this module may write to `state`.
 *
 * WORLD AXES: +X east, +Y up, -Z north.
 * BODY AXES:  -Z nose, +X right wing, +Y up. (Matches aircraft/model.js.)
 *
 * ---------------------------------------------------------------------------
 * GEOGRAPHY
 * ---------------------------------------------------------------------------
 * reset() takes LAT/LON, not scene metres, so callers can say "put me on KBFI
 * 32L" without knowing where the scene origin is. It projects through
 * coords.llToLocal(), which is pure maths with no I/O, so this module stays
 * synchronous and testable.
 *
 * GROUND HEIGHT MUST COME FROM ONE PLACE. step() takes `groundHeight` from the
 * caller (main.js passes terrain.getHeightAt), and reset() uses the optional
 * `groundHeightFn` for the same value. If those two disagree by even a
 * centimetre the aircraft will spawn buried in, or hovering above, the runway.
 * Both must ultimately be elevation.getElevationLocal — see MODULES.md § the
 * ground-height invariant.
 */

import * as THREE from 'three';
import {
  clamp,
  damp,
  wrapDeg,
  M_TO_FT,
  MS_TO_KTS,
  MS_TO_FPM,
  RAD_TO_DEG,
  DEG_TO_RAD,
} from '../core/units.js';
import { llToLocal, localToLl } from '../geo/coords.js';

/** @typedef {Object} FlightModelOpts
 *  @property {number} [startLat]         Spawn latitude, degrees. Default KBFI 32L threshold.
 *  @property {number} [startLon]         Spawn longitude, degrees.
 *  @property {number} [startHeadingDeg]  Initial TRUE heading, 0..360. Default ~330.13.
 *  @property {number} [startAltitudeAglM] Height above ground at spawn, metres.
 *           Default 0 = sitting on the wheels. Set >0 to start airborne.
 *  @property {number} [startAirspeedMs]  Initial airspeed, m/s. Default 0 (parked).
 *  @property {(x:number, z:number) => number} [groundHeightFn] Terrain sampler used
 *           by reset(). MUST be the same function step() is fed. Default () => 0.
 *  @property {number} [gearHeightM]      Ground clearance of the datum, metres. Default 1.2.
 *  @property {number} [massKg]           All-up mass. Default 1100.
 *  @property {number} [wingAreaM2]       Reference wing area. Default 16.2.
 *  @property {number} [maxSpeedMs]       Stub-only: speed at full throttle. Default 85.
 *  @property {number} [stallSpeedMs]     Speed below which `stalled` latches. Default 25.
 *  @property {number} [idleRpm]          Default 700.
 *  @property {number} [maxRpm]           Default 2700.
 */

const DEFAULTS = {
  // KBFI runway 32L threshold, facing north-west up the runway. See
  // geo/airports.js SPAWN for why this spawn and not another.
  //
  // These are a STANDALONE DEFAULT so the model is usable on its own in a test.
  // main.js always overrides them from airports.getSpawn(), which derives the
  // heading through the live projection. Do not treat 330.13 as authoritative —
  // it is the projected bearing of the 32L->14R centreline as of this writing.
  startLat: 47.516745,
  startLon: -122.291252,
  startHeadingDeg: 330.13,
  startAltitudeAglM: 0,
  startAirspeedMs: 0,
  groundHeightFn: null,
  gearHeightM: 1.2,
  massKg: 1100,
  wingAreaM2: 16.2,
  maxSpeedMs: 85,
  stallSpeedMs: 25,
  idleRpm: 700,
  maxRpm: 2700,
};

/** Stub-only body rotation rates at full stick deflection, radians/second. */
const PITCH_RATE = 0.9;
const ROLL_RATE = 1.8;
const YAW_RATE = 0.5;

const NEUTRAL_INPUTS = {
  pitch: 0,
  roll: 0,
  yaw: 0,
  throttle: 0,
  flaps: 0,
  brakes: 0,
};

/**
 * @param {FlightModelOpts} [opts]
 * @returns {{ state: Object, step: (dt: number, inputs: Object, groundHeight: number) => Object, reset: (lat?: number, lon?: number, headingDeg?: number) => void }}
 */
export function createFlightModel(opts = {}) {
  const cfg = { ...DEFAULTS, ...opts };
  const groundHeightFn =
    typeof cfg.groundHeightFn === 'function' ? cfg.groundHeightFn : () => 0;

  /**
   * Aircraft state. Mutated in place every step — hold the reference, don't
   * copy it. `position` and `velocity` are THREE.Vector3, which satisfies the
   * documented `{x, y, z}` shape.
   */
  const state = {
    // --- metric primaries (physics reads these) ---------------------------
    /** @type {THREE.Vector3} World position, METRES. */
    position: new THREE.Vector3(),
    /** @type {THREE.Vector3} World-frame velocity, METRES/SECOND. */
    velocity: new THREE.Vector3(),
    /** @type {THREE.Quaternion} Body -> world rotation. */
    orientation: new THREE.Quaternion(),
    /** @type {THREE.Vector3} Body-frame angular velocity, RADIANS/SECOND. */
    angularVelocity: new THREE.Vector3(),
    /** Airspeed, METRES/SECOND. The authoritative speed value. */
    airspeedMs: 0,
    /** Angle of attack, RADIANS. Stub always reports 0. */
    alphaRad: 0,

    // --- display values (UI reads these; recomputed each step) ------------
    airspeedKts: 0,
    /** Altitude above mean sea level (world y = 0), FEET. */
    altitudeFt: 0,
    /** Altitude above the terrain directly below, FEET. */
    altitudeAglFt: 0,
    /** Magnetic-north-agnostic true heading, DEGREES, 0..360, 0 = north. */
    headingDeg: 0,
    /** Pitch attitude, DEGREES, + = nose up. */
    pitchDeg: 0,
    /** Bank angle, DEGREES, + = right wing down. */
    rollDeg: 0,
    /** Climb rate, FEET PER MINUTE, + = climbing. */
    verticalSpeedFpm: 0,
    /** Propeller/engine speed, REVOLUTIONS PER MINUTE. */
    rpm: 0,
    /** True while the wing is stalled. */
    stalled: false,
    /** True while the gear is in contact with the terrain. */
    onGround: false,

    // --- geodetic position (derived from `position` every step) -----------
    /** Latitude, DEGREES. Convenience mirror of position, for the HUD and
     *  for nearest-airport / nearest-landmark lookups. */
    lat: 0,
    /** Longitude, DEGREES. */
    lon: 0,
  };

  // Scratch objects, allocated once — step() must not allocate per frame.
  const _forward = new THREE.Vector3();
  const _euler = new THREE.Euler();
  const _deltaRot = new THREE.Quaternion();
  const _tmpEuler = new THREE.Euler();
  const _local = { x: 0, z: 0 };
  const _ll = { lat: 0, lon: 0 };

  /**
   * Place the aircraft at a real-world position.
   *
   * All three arguments are optional; each falls back to the corresponding
   * `start*` option, so a bare reset() returns to the configured spawn. That
   * keeps main.js's "press R to reset" working while letting a UI teleport the
   * aircraft to any field.
   *
   * Vertical placement uses `groundHeightFn`, so the aircraft lands on the
   * wheels at the real field elevation rather than at an assumed altitude.
   *
   * @param {number} [lat] degrees
   * @param {number} [lon] degrees
   * @param {number} [headingDeg] TRUE heading, 0..360
   */
  function reset(lat, lon, headingDeg) {
    const useLat = Number.isFinite(lat) ? lat : cfg.startLat;
    const useLon = Number.isFinite(lon) ? lon : cfg.startLon;
    const useHdg = Number.isFinite(headingDeg)
      ? headingDeg
      : cfg.startHeadingDeg;

    llToLocal(useLat, useLon, _local);
    const ground = groundHeightFn(_local.x, _local.z);
    state.position.set(
      _local.x,
      ground + cfg.gearHeightM + Math.max(0, cfg.startAltitudeAglM),
      _local.z,
    );

    // Heading is a rotation about world +Y. Heading 0 must point the nose at
    // -Z, which is the identity orientation, so heading maps to -yaw.
    state.orientation.setFromEuler(_euler.set(0, -useHdg * DEG_TO_RAD, 0, 'YXZ'));
    state.angularVelocity.set(0, 0, 0);
    state.airspeedMs = Math.max(0, cfg.startAirspeedMs);
    state.alphaRad = 0;

    _forward.set(0, 0, -1).applyQuaternion(state.orientation);
    state.velocity.copy(_forward).multiplyScalar(state.airspeedMs);

    state.stalled = false;
    state.onGround = cfg.startAltitudeAglM <= 0;
    state.rpm = cfg.idleRpm;
    refreshDisplay(ground);
  }

  /** Recompute every display-unit field from the metric primaries. */
  function refreshDisplay(groundHeight) {
    state.airspeedKts = state.airspeedMs * MS_TO_KTS;
    state.altitudeFt = state.position.y * M_TO_FT;
    state.altitudeAglFt = (state.position.y - groundHeight) * M_TO_FT;
    state.verticalSpeedFpm = state.velocity.y * MS_TO_FPM;

    localToLl(state.position.x, state.position.z, _ll);
    state.lat = _ll.lat;
    state.lon = _ll.lon;

    _tmpEuler.setFromQuaternion(state.orientation, 'YXZ');
    state.headingDeg = wrapDeg(-_tmpEuler.y * RAD_TO_DEG);
    state.pitchDeg = _tmpEuler.x * RAD_TO_DEG;
    state.rollDeg = -_tmpEuler.z * RAD_TO_DEG;
  }

  /**
   * Advance the simulation by one frame.
   *
   * @param {number} dt Frame delta in SECONDS. Clamped internally to 0.1 s so a
   *                    stalled tab cannot blow the integrator up.
   * @param {{pitch:number, roll:number, yaw:number, throttle:number, flaps:number, brakes:number}} inputs
   *                    pitch/roll/yaw are -1..+1, throttle/flaps/brakes are 0..1.
   * @param {number} groundHeight Terrain elevation in METRES at the aircraft's
   *                    current (x, z). Pass terrain.getHeightAt(x, z).
   * @returns {Object} The same `state` object, for convenience.
   */
  function step(dt, inputs, groundHeight = 0) {
    const h = clamp(Number.isFinite(dt) ? dt : 0, 0, 0.1);
    const inp = { ...NEUTRAL_INPUTS, ...(inputs || {}) };
    const gh = Number.isFinite(groundHeight) ? groundHeight : 0;

    if (h === 0) {
      refreshDisplay(gh);
      return state;
    }

    const pitchIn = clamp(inp.pitch, -1, 1);
    const rollIn = clamp(inp.roll, -1, 1);
    const yawIn = clamp(inp.yaw, -1, 1);
    const throttle = clamp(inp.throttle, 0, 1);
    const brakes = clamp(inp.brakes, 0, 1);
    const flaps = clamp(inp.flaps, 0, 1);

    // --- engine ------------------------------------------------------------
    const targetRpm = cfg.idleRpm + throttle * (cfg.maxRpm - cfg.idleRpm);
    state.rpm = damp(state.rpm, targetRpm, 2.5, h);

    // --- attitude ----------------------------------------------------------
    // Stub: stick position IS the body rotation rate. Control authority fades
    // toward zero as the aircraft slows, so it feels vaguely aeroplane-like.
    const authority = clamp(state.airspeedMs / 30, 0, 1);
    state.angularVelocity.set(
      pitchIn * PITCH_RATE * authority,
      -yawIn * YAW_RATE * authority,
      -rollIn * ROLL_RATE * authority,
    );

    _deltaRot.setFromEuler(
      _euler.set(
        state.angularVelocity.x * h,
        state.angularVelocity.y * h,
        state.angularVelocity.z * h,
        'XYZ',
      ),
    );
    // Body-frame rotation: post-multiply.
    state.orientation.multiply(_deltaRot).normalize();

    // --- speed -------------------------------------------------------------
    const dragFromFlaps = 1 - 0.25 * flaps;
    const targetSpeed = throttle * cfg.maxSpeedMs * dragFromFlaps;
    state.airspeedMs = damp(state.airspeedMs, targetSpeed, 0.35, h);
    if (state.onGround && brakes > 0) {
      state.airspeedMs = damp(state.airspeedMs, 0, 3 * brakes, h);
    }
    state.airspeedMs = Math.max(0, state.airspeedMs);

    // --- velocity and position --------------------------------------------
    _forward.set(0, 0, -1).applyQuaternion(state.orientation);
    state.velocity.copy(_forward).multiplyScalar(state.airspeedMs);
    state.position.addScaledVector(state.velocity, h);

    // --- ground contact ----------------------------------------------------
    const floor = gh + cfg.gearHeightM;
    if (state.position.y <= floor) {
      state.position.y = floor;
      if (state.velocity.y < 0) state.velocity.y = 0;
      state.onGround = true;
    } else {
      state.onGround = false;
    }

    // --- stall -------------------------------------------------------------
    state.stalled = !state.onGround && state.airspeedMs < cfg.stallSpeedMs;

    refreshDisplay(gh);
    return state;
  }

  reset();

  return { state, step, reset };
}
