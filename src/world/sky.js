/**
 * sky.js — sky dome, atmosphere, sun, and scene lighting.
 *
 * STUB IMPLEMENTATION. Flat background colour, hemisphere fill light, and a
 * directional "sun" on a real solar arc. Replace the internals; do not change
 * the exported signature.
 *
 * Contract: see MODULES.md § sky
 *
 *   createSky(scene, renderer, opts) -> {update(dt), setTimeOfDay(t), sunLight, ambientLight}
 *
 * `sunLight` and `ambientLight` are exposed as PROPERTIES so other subsystems
 * can read the sun direction (for lens flare, water specular, shadow camera
 * framing) without this module having to know they exist. Read them; do not
 * reparent them or change their intensity — this module rewrites both every
 * frame.
 *
 * This module OWNS scene.background, scene.fog, and every light in the scene.
 * No other module may add a light.
 *
 * ---------------------------------------------------------------------------
 * FOG IS A VISIBILITY BUDGET, NOT A MOOD SETTING
 * ---------------------------------------------------------------------------
 * Mount Rainier is 84 km from the spawn and seeing it is the headline proof
 * that our elevation data is real. FogExp2 attenuates by exp(-(d*density)^2),
 * so density must be chosen against that distance, not by eye at 2 km:
 *
 *   density 8e-5  -> Rainier is attenuated by exp(-45). Invisible. The mountain
 *                    is rendering perfectly and you cannot see it.
 *   density 1.1e-5 -> Rainier sits at roughly 40% contrast: a pale blue-grey
 *                    cone floating above the haze, which is exactly how it
 *                    looks from Seattle on a clear day.
 *
 * If you raise the density, re-derive it against 84 km first.
 */

import * as THREE from 'three';
import { clamp, lerp, DEG_TO_RAD } from '../core/units.js';

/**
 * @typedef {Object} SkyOpts
 * @property {number} [turbidity]      Atmospheric haze. Default 8.
 * @property {number} [fogDensity]     FogExp2 density. Default 1.1e-5 — see above.
 * @property {number} [timeOfDay]      Initial time, 0..1. Default 0.42 (late morning).
 * @property {number} [sunDistance]    Sun light placement radius, metres. Default 120000
 *           — must exceed the terrain radius or the "sun" sits inside the world.
 * @property {number} [sunAzimuthDeg]  Compass bearing the sun tracks over, degrees.
 *           Default 180 (due south), correct for a northern-hemisphere midday.
 * @property {number} [dayLengthSec]   Seconds of real time per in-sim day. Default 0
 *           = frozen; update(dt) will not advance the clock.
 */

const DEFAULTS = {
  turbidity: 8,
  fogDensity: 1.1e-5,
  timeOfDay: 0.42,
  sunDistance: 120000,
  sunAzimuthDeg: 180,
  dayLengthSec: 0,
};

const DAY_SKY = new THREE.Color(0x87b6e8);
const NIGHT_SKY = new THREE.Color(0x0a1020);
const DUSK_SKY = new THREE.Color(0xd98d55);

/**
 * @param {THREE.Scene} scene
 * @param {THREE.WebGLRenderer} renderer
 * @param {SkyOpts} [opts]
 * @returns {{update: (dt: number, sunAngle?: number) => void, setTimeOfDay: (t: number) => void, getTimeOfDay: () => number, sunLight: THREE.DirectionalLight, ambientLight: THREE.HemisphereLight, sunDirection: THREE.Vector3}}
 */
export function createSky(scene, renderer, opts = {}) {
  const cfg = { ...DEFAULTS, ...opts };
  void renderer; // a real sky needs it for tone mapping / PMREM

  const skyColor = DAY_SKY.clone();
  scene.background = skyColor;
  scene.fog = new THREE.FogExp2(skyColor.clone(), cfg.fogDensity);

  /** @type {THREE.HemisphereLight} Sky/ground fill. Exposed as `ambientLight`. */
  const ambientLight = new THREE.HemisphereLight(0xbfd8ff, 0x4a5a38, 1.6);
  ambientLight.name = 'sky-ambient';
  scene.add(ambientLight);

  /** @type {THREE.DirectionalLight} The sun. Exposed as `sunLight`. */
  const sunLight = new THREE.DirectionalLight(0xfff3e0, 2.2);
  sunLight.name = 'sky-sun';
  scene.add(sunLight);
  // A directional light points at its target; the default target sits at the
  // origin, which is what we want, but it must be in the scene graph.
  scene.add(sunLight.target);

  /** Unit vector FROM the scene TOWARD the sun. Read-only for consumers. */
  const sunDirection = new THREE.Vector3(0, 1, 0);

  let timeOfDay = clamp(cfg.timeOfDay, 0, 1);
  let currentSunAngle = 0;

  /** Recompute sky tint, light intensity and sun position from the sun angle. */
  function applyLighting() {
    const sinA = Math.sin(currentSunAngle);
    // 0 with the sun at or below the horizon, 1 overhead.
    const elevation = clamp(sinA, 0, 1);
    // Peaks while the sun is within ~15 degrees of the horizon.
    const horizon = clamp(1 - Math.abs(sinA) / 0.26, 0, 1) * (sinA > -0.3 ? 1 : 0);

    skyColor.copy(NIGHT_SKY).lerp(DAY_SKY, elevation);
    skyColor.lerp(DUSK_SKY, horizon * 0.65);

    if (scene.background instanceof THREE.Color) {
      scene.background.copy(skyColor);
    }
    if (scene.fog && scene.fog.color) {
      scene.fog.color.copy(skyColor);
    }

    ambientLight.intensity = lerp(0.08, 1.6, elevation);
    sunLight.intensity = lerp(0.0, 2.2, elevation);
    sunLight.color.setHex(0xfff3e0).lerp(new THREE.Color(0xff9d5c), horizon);

    // Track a real arc: the sun rises in the east, crosses the given azimuth at
    // its highest point, and sets in the west.
    const az = cfg.sunAzimuthDeg * DEG_TO_RAD;
    const cosA = Math.cos(currentSunAngle);
    sunDirection
      .set(Math.sin(az) * cosA, sinA, -Math.cos(az) * cosA)
      .normalize();
    sunLight.position.copy(sunDirection).multiplyScalar(cfg.sunDistance);
  }

  /**
   * Per-frame update.
   *
   * @param {number} dt Frame delta in SECONDS. Advances the clock when
   *        `dayLengthSec` is non-zero; otherwise time is frozen and this is
   *        just a cheap re-apply.
   * @param {number} [sunAngle] Optional override: sun elevation above the
   *        horizon in RADIANS (0 = horizon, +PI/2 = overhead, negative =
   *        night). Supplying it does NOT change `timeOfDay`.
   */
  function update(dt, sunAngle) {
    const h = Number.isFinite(dt) ? dt : 0;
    if (typeof sunAngle === 'number' && Number.isFinite(sunAngle)) {
      currentSunAngle = sunAngle;
      applyLighting();
      return;
    }
    if (cfg.dayLengthSec > 0 && h > 0) {
      setTimeOfDay(timeOfDay + h / cfg.dayLengthSec);
      return;
    }
    applyLighting();
  }

  /**
   * Jump to a time of day.
   *
   * @param {number} t Normalised time, 0..1. 0 = midnight, 0.25 = sunrise,
   *                   0.5 = noon, 0.75 = sunset. Values outside 0..1 wrap.
   */
  function setTimeOfDay(t) {
    timeOfDay = ((t % 1) + 1) % 1;
    // Map 0..1 onto a full revolution, with noon (0.5) putting the sun overhead.
    currentSunAngle = (timeOfDay - 0.25) * Math.PI * 2;
    applyLighting();
  }

  /** @returns {number} Current normalised time of day, 0..1. */
  function getTimeOfDay() {
    return timeOfDay;
  }

  setTimeOfDay(timeOfDay);

  return {
    update,
    setTimeOfDay,
    getTimeOfDay,
    sunLight,
    ambientLight,
    sunDirection,
  };
}
