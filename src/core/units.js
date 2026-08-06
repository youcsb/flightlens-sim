/**
 * units.js — the single source of truth for unit conversion.
 *
 * SIMULATION IS METRIC. Everything inside the sim is metres, m/s, radians,
 * seconds. Knots / feet / fpm / degrees exist ONLY at the display boundary
 * (instruments, HUD text, debug overlays). Never store an imperial value on a
 * physics object; convert at the moment you render it.
 *
 * Import these rather than hand-rolling magic numbers, so all six subsystems
 * agree to the last decimal place.
 */

// ---------------------------------------------------------------------------
// Linear distance
// ---------------------------------------------------------------------------
export const M_TO_FT = 3.280839895013123; // 1 metre  -> feet
export const FT_TO_M = 0.3048; // 1 foot   -> metres  (exact)
export const M_TO_NM = 1 / 1852; // 1 metre  -> nautical miles (exact)
export const NM_TO_M = 1852; // 1 NM     -> metres  (exact)

// ---------------------------------------------------------------------------
// Speed
// ---------------------------------------------------------------------------
export const MS_TO_KTS = 1.9438444924406046; // m/s -> knots
export const KTS_TO_MS = 0.5144444444444445; // knots -> m/s
export const MS_TO_FPM = 196.85039370078738; // m/s -> feet per minute
export const FPM_TO_MS = 1 / 196.85039370078738;

// ---------------------------------------------------------------------------
// Angle
// ---------------------------------------------------------------------------
export const RAD_TO_DEG = 180 / Math.PI;
export const DEG_TO_RAD = Math.PI / 180;

// ---------------------------------------------------------------------------
// Misc physical constants
// ---------------------------------------------------------------------------
export const GRAVITY = 9.80665; // m/s^2, standard gravity
export const RHO_SEA_LEVEL = 1.225; // kg/m^3, ISA sea-level air density

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Clamp v into [lo, hi]. */
export function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Linear interpolation; t is not clamped. */
export function lerp(a, b, t) {
  return a + (b - a) * t;
}

/** Wrap an angle in degrees into [0, 360). */
export function wrapDeg(deg) {
  const d = deg % 360;
  return d < 0 ? d + 360 : d;
}

/**
 * Frame-rate independent exponential smoothing.
 * `rate` is roughly "how many e-foldings per second" — bigger is snappier.
 */
export function damp(current, target, rate, dt) {
  return lerp(current, target, 1 - Math.exp(-rate * dt));
}

/**
 * ISA air density at a given geometric altitude in METRES.
 * Troposphere-only approximation, good to ~11 km. Returns kg/m^3.
 */
export function airDensity(altitudeM) {
  const t = 288.15 - 0.0065 * altitudeM; // K
  if (t <= 0) return 0;
  return RHO_SEA_LEVEL * Math.pow(t / 288.15, 4.256);
}
