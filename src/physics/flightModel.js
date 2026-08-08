/**
 * flightModel.js — the flight dynamics model. The single owner of aircraft state.
 *
 * A six-degree-of-freedom rigid-body model of a fixed-wing aeroplane. Forces
 * and moments come from real aerodynamics — dynamic pressure, a lift curve with
 * a genuine stall break, induced + parasite drag, ISA air density, a
 * power/thrust curve — and from sprung landing-gear contact points that carry
 * weight, roll, brake and steer. Nothing here is a rate table: the aircraft
 * flies because the sum of forces says so.
 *
 * WHICH AEROPLANE IS DATA, NOT CODE. Every number that describes an airframe —
 * mass, geometry, stability derivatives, control travel, flaps, propulsion,
 * the gear table, the structural limits — lives in src/physics/airframes/.
 * This file owns the physics and the integration; it holds no opinion about
 * what is flying. The default airframe is airframes/c172.js, which is also the
 * worked example: a second aircraft is a sibling of that file and nothing else.
 * See `airframe` in FlightModelOpts.
 *
 * What is left at module scope here is deliberately NOT per-airframe: the
 * timestep, the numerical guards, the shape of the flat-plate post-stall
 * regime, the terrain-sampling filters. If you find yourself wanting to vary
 * one of them per aircraft, it belongs in the airframe file instead.
 *
 * Contract: see MODULES.md § 2.10
 *
 *   createFlightModel(opts) -> { state, step(dt, inputs, groundHeight), reset(lat, lon, headingDeg) }
 *
 * UNITS — the sim is metric. `state` carries BOTH:
 *   - metric primary values (position m, velocity m/s, orientation quaternion)
 *   - precomputed display values (airspeedKts, altitudeFt, ...) for the HUD
 * Physics code must read the metric ones. UI code must read the display ones.
 * Nothing outside this module may write to `state`.
 *
 * ---------------------------------------------------------------------------
 * AXES — read this before touching a sign
 * ---------------------------------------------------------------------------
 * WORLD (MODULES.md §1.2): +X east, +Y up, -Z north.
 * BODY  (matches aircraft/model.js): -Z nose, +X right wing, +Y up.
 *
 * Aerodynamics is written in the textbook AERO frame (x forward, y right,
 * z down) because every stability derivative in the literature is quoted in
 * it. The mapping is fixed and used in exactly two places (`toAero`-style
 * reads at the top of integrate(), and the torque conversion at the bottom):
 *
 *     aero x (fwd)   = -body Z          u = -vBody.z
 *     aero y (right) = +body X          v = +vBody.x
 *     aero z (down)  = -body Y          w = -vBody.y
 *
 *     roll rate  p =  -w_body.z         roll torque  L -> tau_body.z = -L
 *     pitch rate q =  +w_body.x         pitch torque M -> tau_body.x = +M
 *     yaw rate   r =  -w_body.y         yaw torque   N -> tau_body.y = -N
 *
 * Consequently the body-frame inertias are (Ix = pitch inertia,
 * Iy = yaw inertia, Iz = roll inertia). That looks wrong at a glance and is
 * not; the body axes are simply not the aero axes.
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
 *
 * The caller supplies ONE ground sample, at the aircraft's own (x, z), and that
 * sample remains the REFERENCE: it is what the radio altimeter reads against
 * and what every other sample is sanity-checked against. But it is not the only
 * sample taken, because a single scalar height cannot describe a slope, and an
 * aeroplane that only ever meets locally flat ground is an aeroplane for which
 * terrain is not solid. Measured, before this changed: level at 119 kt into a
 * 500 m vertical wall relocated the aircraft from y = 502.6 m to y = 1001.2 m
 * in ONE frame, with all 119 kt intact and onGround still false.
 *
 * So the model ALSO calls `groundHeightFn` itself:
 *
 *   - once per contact point, per substep, whenever the aircraft is within
 *     CONTACT_SAMPLE_AGL_M of the reference surface. That is what lets it park
 *     nose-up on a hill and what makes a cliff face register as a cliff face
 *     under the leading wheel instead of as a floor that suddenly moved.
 *   - four times per frame in a cross around the datum, to get the surface
 *     NORMAL. Without a normal there is no way to tell a 3 m/s descent onto a
 *     runway from a 60 m/s arrival at a rock wall, because both are "the
 *     ground is now above the wheel".
 *
 * This does NOT break the one-place rule, and that is the point of insisting
 * `groundHeightFn` be the same function step() is fed: every one of those extra
 * samples goes through the caller's own sampler. The module still owns no
 * opinion about where the ground is. It just asks more often.
 *
 * ---------------------------------------------------------------------------
 * SOLIDITY
 * ---------------------------------------------------------------------------
 * The terrain is solid and the aeroplane can be destroyed. `state.crashed` is a
 * latch that only reset() clears; while it is set, step() does no aerodynamics,
 * the wreck does not move, and it certainly does not keep its airspeed. See the
 * SOLIDITY constants block for the three thresholds and why each is where it
 * is, and `flight-envelope.mjs` §16 for the flights that prove it.
 *
 * ---------------------------------------------------------------------------
 * TIMESTEP
 * ---------------------------------------------------------------------------
 * step() is an accumulator over a genuinely FIXED 1/240 s substep. Sprung gear
 * and tyre friction are stiff relative to a 60 Hz frame; integrating them at
 * frame rate turns a hard landing into a launch. A frame hitch spends more
 * substeps, not a bigger one, so the model is frame-rate independent and
 * cannot be exploded by a stalled tab. The <=4 ms accumulator residue is
 * carried to the next frame.
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
  GRAVITY,
  RHO_SEA_LEVEL,
  airDensity,
  speedOfSound,
} from '../core/units.js';
import { llToLocal, localToLl } from '../geo/coords.js';
import { C172 } from './airframes/c172.js';

/** @typedef {Object} FlightModelOpts
 *  @property {Object} [airframe]         THE AEROPLANE. An airframes/*.js export.
 *           Default C172. Merged group by group over the C172, so anything it
 *           omits falls back — convenient for an experiment, a trap for a
 *           finished aircraft. Any airframe key may ALSO be passed at the top
 *           level of opts, where it wins over the airframe file; that is how
 *           `createFlightModel({ massKg: 1200 })` has always worked and still
 *           does. Nested groups (aero, controls, flaps, prop, gear, limits)
 *           are merged key by key wherever they appear, so overriding one
 *           derivative does not silently delete the other twenty.
 *  @property {number} [startLat]         Spawn latitude, degrees. Default KBFI 32L threshold.
 *  @property {number} [startLon]         Spawn longitude, degrees.
 *  @property {number} [startHeadingDeg]  Initial TRUE heading, 0..360. Default ~330.13.
 *  @property {number} [startAltitudeAglM] Height above ground at spawn, metres.
 *           Default 0 = sitting on the wheels. Set >0 to start airborne.
 *  @property {number} [startAirspeedMs]  Initial airspeed, m/s. Default 0 (parked).
 *  @property {(x:number, z:number) => number} [groundHeightFn] Terrain sampler used
 *           by reset(). MUST be the same function step() is fed. Default () => 0.
 *  --- airframe scalars, all optional; see airframes/c172.js for what each one
 *      means and why it is the value it is. Listed here only because callers
 *      have always been allowed to pass them one at a time. ---
 *  @property {number} [gearHeightM]      Ground clearance of the datum, metres.
 *  @property {number} [massKg]           All-up mass.
 *  @property {number} [wingAreaM2]       Reference wing area.
 *  @property {number} [maxSpeedMs]       Advisory Vne, m/s.
 *  @property {number} [stallSpeedMs]     CLEAN 1-g stall speed. Sets CLmax.
 *  @property {number} [idleRpm]
 *  @property {number} [maxRpm]
 *  @property {number} [wingSpanM]
 *  @property {number} [wingHeightM]      Wing height above the datum, metres.
 *  @property {number} [fuselageLengthM]  Used only for inertia scaling.
 *  @property {number} [maxPowerW]        Shaft power at sea level.
 *  @property {number} [propEfficiency]
 *  @property {number} [staticThrustN]    Sea-level full-power static thrust.
 *  @property {number} [cd0]              Zero-lift drag coefficient.
 *  @property {number} [oswald]           Span efficiency.
 *  @property {number} [inertiaRollKgM2]  0 = scale the C172's by mass and span^2.
 *  @property {number} [inertiaPitchKgM2] 0 = scale the C172's by mass and length^2.
 *  @property {number} [inertiaYawKgM2]   0 = scale the C172's by mass and length^2.
 *  --- environment / harness ---
 *  @property {number} [windEastMs]       Steady wind, m/s toward east. Default 0.
 *  @property {number} [windNorthMs]      Steady wind, m/s toward north. Default 0.
 *  @property {boolean} [crashEnabled]    Terrain is SOLID and the airframe can be
 *           destroyed. Default true. Set false only for a harness that wants to
 *           measure something past the point where the aeroplane would break.
 */

/**
 * Everything that is NOT the aeroplane: where it starts, what the air is
 * doing, and whether the harness wants it breakable. The airframe's own
 * defaults come from airframes/c172.js and are merged in by resolveConfig().
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
  windEastMs: 0,
  windNorthMs: 0,
  crashEnabled: true,
};

/**
 * The nested groups of an airframe description. Everything else in an airframe
 * file is a plain scalar and merges by assignment.
 *
 * These are merged KEY BY KEY rather than replaced wholesale, so an airframe —
 * or a one-off opts override — that names three derivatives keeps the other
 * twenty instead of silently deleting them. Replacing a whole group is still
 * possible where it is the sensible thing: `gear.contacts` is one value (an
 * array), so stating it replaces the entire table, which is what you want.
 */
const AIRFRAME_GROUPS = ['aero', 'controls', 'flaps', 'prop', 'gear', 'limits'];

/** Merge `over` onto `base`, one level deep through AIRFRAME_GROUPS. */
function mergeAirframe(base, over) {
  const out = { ...base, ...over };
  for (const g of AIRFRAME_GROUPS) {
    out[g] = { ...base[g], ...(over ? over[g] : null) };
  }
  return out;
}

/**
 * DEFAULTS, then the chosen airframe, then whatever the caller said directly.
 *
 * Three layers because they answer three different questions: what does this
 * module do on its own, what aeroplane is this, and what does this particular
 * call want different. `createFlightModel()` with no arguments therefore
 * produces exactly the C172 — that is the property the whole arrangement is
 * for, and scripts/flight-envelope.mjs is what proves it.
 */
function resolveConfig(opts) {
  return mergeAirframe(mergeAirframe({ ...DEFAULTS, ...C172 }, opts.airframe), opts);
}

// ---------------------------------------------------------------------------
// Fixed integration
// ---------------------------------------------------------------------------
/** Physics substep, seconds. Chosen for the gear springs, not the aerodynamics. */
const FIXED_DT = 1 / 240;
/** dt is clamped to 0.1 s (contract), so 24 substeps covers it; 32 is headroom. */
const MAX_SUBSTEPS = 32;

// ---------------------------------------------------------------------------
// Post-stall aerodynamics — not per-airframe.
//
// Every stability derivative, every control travel, the flap numbers, the
// propeller asymmetries, the gear table and the structural limits have moved
// to airframes/*.js. What is left here is the behaviour of a wing that has
// stopped being a wing: past full separation any planform is a slab held at an
// angle to the wind, and these two numbers say what a slab does. They are the
// same for a Cub and a widebody.
// ---------------------------------------------------------------------------
const CL_FLATPLATE = 1.05; // fully separated wing behaves like a flat plate
const CD_SEPARATED = 1.6; // drag multiplier for a fully separated wing

/**
 * Rebound damping, as a fraction of compression damping. A one-sided damper
 * (compression only) pogos: nothing bleeds the energy the spring gives back.
 */
const REBOUND_DAMP = 0.7;

/* ---------------------------------------------------------------------------
 * SOLIDITY — the terrain is not a suggestion
 * ---------------------------------------------------------------------------
 * A gear leg is a SPRING WITH A STOP. Past the stop it is not a spring any
 * more, it is structure, and structure fails. Everything in this block exists
 * so that the surface the terrain module draws is the surface the aeroplane
 * cannot pass through.
 *
 * The three numbers that decide whether a contact is a landing or a crash. Two
 * of them describe the aeroplane and live in its airframe file; only the third
 * is a property of the world and lives here:
 *
 *   gear.strokeM       (airframe) how far a leg travels before it bottoms out.
 *
 *   gear.crashLoadG    (airframe, in `limits`) ultimate load factor, with the
 *                      timed/instant split explained where the numbers are.
 *
 *   CRASH_CLOSING_MS   closing speed ALONG THE LOCAL SURFACE NORMAL at the
 *                      moment the leg bottoms. 5 m/s is 984 fpm straight down —
 *                      well past the 600 fpm (10 fps) ultimate design sink that
 *                      both FAR 23 and FAR 25 gear are certified to, which is
 *                      why this one number is NOT per-airframe: a Cub and a
 *                      737 are held to the same 10 fps. The reason it is
 *                      measured along the NORMAL rather than along world-down
 *                      is that this is what makes a cliff face solid: fly level
 *                      at 60 m/s into ground whose normal is horizontal and the
 *                      closing speed is 60 m/s, not 0.
 *
 * The normal is real, not assumed: sampleGroundNormal() probes the SAME height
 * field the wheels roll on, four samples in a cross, once per frame.
 */
const CRASH_CLOSING_MS = 5.0;

/**
 * Half-width of the cross used to estimate the surface normal, metres. Wider
 * than a gear track (2.6 m) would smooth a runway edge into a ramp; narrower
 * than the DEM's finest post spacing would just resample the same triangle.
 */
const NORMAL_PROBE_M = 2.0;
/**
 * Above this height above the datum's ground sample, nothing can touch: skip
 * the per-contact terrain sampling entirely. One wingspan plus the gear is the
 * most any contact point can sit below the datum, so 30 m is generous.
 */
const CONTACT_SAMPLE_AGL_M = 30;
/**
 * Outlier rejection for a per-contact sample. The contacts span 4.1 m; no real
 * surface puts one of them 150 m from the datum's own sample. A DEM void does.
 */
const CONTACT_OUTLIER_M = 150;
/**
 * Ground-sample jump filter. A one-frame spike in getHeightAt() — a DEM void,
 * an LOD swap mid-refinement — used to be indistinguishable from a cliff, and
 * the old code resolved both by teleporting. It is distinguishable in TIME: a
 * cliff is still there on the next frame, a void is not. So a jump larger than
 * the threshold is DEFERRED one frame and accepted only if the next sample
 * confirms it. Cost of a genuine cliff: 16 ms of delay, one metre of travel.
 * Cost of a void: nothing at all.
 */
const GROUND_JUMP_BASE_M = 12;
/** Steepest slope accepted with zero delay, as a gradient. tan(63°) ~ 2. */
const GROUND_JUMP_PER_MS = 2.0;
/** Two samples this close together count as agreeing. */
const GROUND_CONFIRM_M = 25;
/**
 * How far a crash is allowed to move the wreck to stop it sitting buried.
 * Bounded on purpose: settling a belly-landing 30 cm out of the dirt is
 * housekeeping, and lifting a wreck 500 m up the face of the cliff it just hit
 * is the exact bug this whole block replaces.
 */
const WRECK_SETTLE_MAX_M = 2.0;
/** Ground speed below which a containment trip is resolved, not fatal. */
const CONTAINMENT_SAFE_MS = 3.0;
/**
 * Ceiling on the DAMPER term alone, in weights, per leg. The spring peak at a
 * 500 fpm arrival is about 2.5 g and that is the number that should show on the
 * accelerometer. Undamped-cap, the c*v term spikes to 5.7 g in the first
 * millisecond of contact — measured — which is an artifact of modelling a
 * steel leaf spring as a viscous dashpot, not a real load.
 */
const MAX_DAMP_PER_W = 2;
/** Per-contact normal-force ceiling, in units of aircraft weight. Stops a bad
 *  terrain sample from firing the aeroplane into orbit. */
const MAX_N_PER_W = 8;

/**
 * @param {FlightModelOpts} [opts]
 * @returns {{ state: Object, config: Object, step: (dt: number, inputs: Object, groundHeight: number) => Object, reset: (lat?: number, lon?: number, headingDeg?: number) => void }}
 */
export function createFlightModel(opts = {}) {
  const cfg = resolveConfig(opts);
  const hasGroundFn = typeof cfg.groundHeightFn === 'function';
  const groundHeightFn = hasGroundFn ? cfg.groundHeightFn : () => 0;

  // -------------------------------------------------------------------------
  // THE AIRFRAME, unpacked.
  //
  // Every name below used to be a module-scope `const` with a literal beside
  // it; each one is now whatever the chosen airframe says. They are bound ONCE,
  // here, for two reasons: the physics below reads plain identifiers instead of
  // chasing `cfg.aero.cmAlpha` through a property lookup 240 times a second,
  // and the code that uses them is untouched by the move, which is what makes
  // "same numbers in, same aeroplane out" checkable rather than hopeful.
  //
  // The comments explaining WHY each number is what it is now live beside the
  // numbers, in airframes/c172.js. Go there before changing one.
  // -------------------------------------------------------------------------
  const AERO = cfg.aero;
  const CTRL = cfg.controls;
  const FLAP = cfg.flaps;
  const PROP = cfg.prop;
  const GEAR = cfg.gear;
  const LIMITS = cfg.limits;

  // Lift curve and its post-stall shape.
  const CL0 = AERO.cl0;
  const ALPHA_SOFT = AERO.alphaSoftRad;
  const STALL_BREAK = AERO.stallBreakRad;
  const NEG_STALL_SCALE = AERO.negStallScale;
  const CD_BETA = AERO.cdBeta;

  const CL_Q = AERO.clQ;
  const CL_DE = AERO.clDe;

  const CM0 = AERO.cm0;
  const CM_ALPHA = AERO.cmAlpha;
  const CM_Q = AERO.cmQ;
  const CM_DE = AERO.cmDe;
  const CM_FLAP = AERO.cmFlap;
  const CM_STALL = AERO.cmStall;

  const CY_BETA = AERO.cyBeta;
  const CY_DR = AERO.cyDr;

  const CROLL_BETA = AERO.crollBeta;
  const CROLL_P = AERO.crollP;
  const CROLL_R = AERO.crollR;
  const CROLL_DA = AERO.crollDa;
  const CROLL_DR = AERO.crollDr;
  const CROLL_STALL = AERO.crollStall;

  const CN_BETA = AERO.cnBeta;
  const CN_P = AERO.cnP;
  const CN_R = AERO.cnR;
  const CN_DA = AERO.cnDa;
  const CN_DR = AERO.cnDr;

  const GROUND_EFFECT_K = AERO.groundEffectK;

  // ---------------------------------------------------------------------------
  // COMPRESSIBILITY — off by default, and off means BYPASSED, not zeroed.
  //
  // Below about M0.3 none of this is measurable, and a C172 cannot reach M0.3
  // in level flight, so switching it on for the Cessna would buy nothing and
  // cost a rounding difference in every number the harnesses assert. An
  // airframe that lives near the speed of sound sets `machEffects: true` and
  // gets three things a subsonic model does not have:
  //
  //   1. Prandtl-Glauert. The lift-curve slope grows as 1/sqrt(1 - M^2). At
  //      M0.78 that is a 60% steeper wing: the same gust produces 60% more g,
  //      and the aeroplane is correspondingly twitchier in pitch at cruise
  //      than it is on approach. This also LOWERS the alpha at which it stalls.
  //   2. Wave drag. Above the critical Mach number a shock forms on the upper
  //      surface and drag climbs steeply. This is what stops a jet from simply
  //      accelerating to Vne in the cruise — it is a drag wall, not a placard.
  //   3. Mmo. A speed limit expressed in Mach rather than IAS, which at
  //      altitude bites long before Vne does.
  // ---------------------------------------------------------------------------
  const MACH_EFFECTS = AERO.machEffects === true;
  /** Drag-divergence onset. 0.72 is a mid-1980s supercritical section. */
  const M_CRIT = AERO.mCrit > 0 ? AERO.mCrit : 0.72;
  /**
   * Wave-drag scale. Cd_wave = k * ((M - Mcrit) / (1 - Mcrit))^3, so the rise
   * is cubic in how far past the divergence you are: negligible at Mcrit,
   * comparable to the whole parasite drag by M0.86. A cubic is the standard
   * cheap fit to the knee and it has the property that matters — you can feel
   * where the wall is before you hit it.
   */
  const MACH_DRAG_K = AERO.machDragK >= 0 ? AERO.machDragK : 0.1;
  /**
   * Prandtl-Glauert is singular at M1 and this is not a transonic model. The
   * correction is frozen at M0.92, past which the airframe is already deep
   * into wave drag and well past its Mmo break.
   */
  const PG_MACH_MAX = 0.92;

  // Control surfaces and trim.
  const DE_MAX = CTRL.deMaxRad;
  const DA_MAX = CTRL.daMaxRad;
  const DR_MAX = CTRL.drMaxRad;
  const SURFACE_RATE = CTRL.surfaceRate;
  const TRIM_AUTHORITY = CTRL.trimAuthority;
  const TRIM_RATE = CTRL.trimRate;

  // Flaps.
  const FLAP_TRAVEL_RATE = FLAP.travelRate;
  const FLAP_DCL0 = FLAP.dCl0;
  const FLAP_DCLMAX = FLAP.dClMax;
  const FLAP_DCD = FLAP.dCd;
  const VFE_MS = FLAP.vfeMs;
  /**
   * FLAP PLACARD SCHEDULE — a max position per speed, optional.
   *
   * `vfeMs` alone says "above this speed no flap at all", which is true of a
   * Cessna and false of every airliner. A 737 may select flaps 1 and 5 at
   * 250 kt, 15 at 200, 25 at 190 and 40 at 162: the limit is a STAIRCASE, and
   * collapsing it to its lowest step means the aeroplane refuses all flap at a
   * perfectly normal 250 kt descent speed. Which is exactly what it did.
   *
   * Each entry is { pos, ms }: at or below `ms`, flap may extend to `pos`.
   * Absent, the single-vfeMs behaviour below is used unchanged — so a Cessna
   * takes the identical code path it always has.
   */
  const VFE_SCHEDULE =
    Array.isArray(FLAP.vfeSchedule) && FLAP.vfeSchedule.length
      ? FLAP.vfeSchedule
      : null;

  // Propulsion response and single-engine asymmetry.
  /**
   * WHICH KIND OF ENGINE. 'piston' is a naturally aspirated piston turning a
   * fixed-pitch propeller; 'turbofan' is a high-bypass fan.
   *
   * This is a branch and not a set of coefficients because the two have
   * opposite SHAPES, not different magnitudes. A propeller converts a roughly
   * constant shaft power into thrust, so its thrust falls as 1/V and is nearly
   * gone by 200 kt. A turbofan produces roughly constant THRUST, sagging only
   * gently with Mach. Faking a jet with a huge `maxPowerW` gets the sea-level
   * static number right and then decays through the whole climb — the aircraft
   * would run out of thrust at exactly the speeds a 737 lives at.
   */
  const PROPULSION = PROP.propulsion === 'turbofan' ? 'turbofan' : 'piston';
  const SPOOL_RATE = PROP.spoolRate;
  /**
   * Spool-DOWN rate, per second. Defaults to spoolRate, which is what a piston
   * does and is what keeps the C172 bit-identical. A big fan is asymmetric:
   * accelerating the core is slow (it has to burn its way up against inertia),
   * decelerating is quicker. That asymmetry is most of why jets are flown with
   * the thrust levers ahead of the aeroplane on approach.
   */
  const SPOOL_RATE_DOWN =
    PROP.spoolRateDown > 0 ? PROP.spoolRateDown : PROP.spoolRate;
  /** Residual thrust at flight idle, as a fraction of static. */
  const IDLE_THRUST_FRAC =
    PROP.idleThrustFrac >= 0 ? PROP.idleThrustFrac : 0.055;
  /**
   * Density exponent for turbofan thrust: T ~ sigma^n. n = 1 would be pure
   * mass-flow scaling; the real number is a little under that because the
   * colder air aloft raises the pressure ratio and claws some back. 0.85 puts
   * a CFM56 at ~37% of its static thrust at FL350, which is the book figure.
   */
  const THRUST_LAPSE_EXP = PROP.thrustLapseExp > 0 ? PROP.thrustLapseExp : 0.85;
  /**
   * Mach thrust sag for a high-bypass fan: T/T0 = 1 - k*sqrt(M) (Mattingly).
   * The fan is doing less work on air that is already moving fast relative to
   * it. 0.49 costs ~43% of static thrust at M0.78 — which is why a 737 needs
   * most of its thrust at cruise and has plenty on the runway.
   */
  const THRUST_MACH_K = PROP.thrustMachK >= 0 ? PROP.thrustMachK : 0.49;
  const N1_IDLE = PROP.n1Idle > 0 ? PROP.n1Idle : 21;
  const N1_MAX = PROP.n1Max > 0 ? PROP.n1Max : 100;
  const WINDMILL_RPM_PER_MS = PROP.windmillRpmPerMs;
  const WINDMILL_CD0 = PROP.windmillCd0;
  const SLIPSTREAM_ARM_M = PROP.slipstreamArmM;
  const TORQUE_ARM_M = PROP.torqueArmM;
  const PROP_EFFECT_FADE_MS = PROP.effectFadeMs;

  // Gear and ground handling.
  const CONTACTS = GEAR.contacts;
  const GEAR_STROKE_M = GEAR.strokeM;
  const MU_BRAKE = GEAR.muBrake;
  const STEER_MAX = GEAR.steerMaxRad;
  const STEER_REF_MS = GEAR.steerRefMs;
  const STEER_FADE_EXP = GEAR.steerFadeExp;
  const STEER_FLOOR = GEAR.steerFloor;

  // Structural limits.
  const CRASH_LOAD_G = LIMITS.crashLoadG;
  const CRASH_LOAD_SUSTAIN_S = LIMITS.crashLoadSustainS;
  const CRASH_LOAD_INSTANT_G = LIMITS.crashLoadInstantG;
  const OVERSPEED_BREAK = LIMITS.overspeedBreak;
  /**
   * Bounds on the DERIVED CLmax (see below). These are a sanity rail on a
   * number computed from stall speed and mass, not a physical law, so they
   * belong to the airframe: 2.4 is generous for a plain flapped wing and much
   * too low for anything with leading-edge devices. Getting this wrong is
   * SILENT — the aeroplane simply stalls at the wrong speed and nothing says
   * so, which is why the two ends are named and not literals.
   */
  const CL_MAX_MIN = LIMITS.clMaxMin > 0 ? LIMITS.clMaxMin : 0.9;
  const CL_MAX_MAX = LIMITS.clMaxMax > 0 ? LIMITS.clMaxMax : 2.4;
  /** Mmo. Only consulted when machEffects is on; Infinity means "IAS only". */
  const MMO = MACH_EFFECTS && LIMITS.mmo > 0 ? LIMITS.mmo : Infinity;

  // -------------------------------------------------------------------------
  // Derived airframe constants — computed once, never per frame.
  // -------------------------------------------------------------------------
  const MASS = Math.max(1, cfg.massKg);
  const WEIGHT = MASS * GRAVITY;
  const S_WING = Math.max(0.1, cfg.wingAreaM2);
  const SPAN = Math.max(0.1, cfg.wingSpanM);
  const AR = (SPAN * SPAN) / S_WING;
  const CHORD = S_WING / SPAN;
  const K_INDUCED = 1 / (Math.PI * AR * cfg.oswald);
  /**
   * Finite-wing lift-curve slope, Helmbold. ~4.96 /rad for AR 7.47.
   *
   * Sweep, when the airframe declares any, multiplies it by cos(sweep) — simple
   * sweep theory: only the component of the flow normal to the quarter-chord
   * does aerodynamic work. Aspect ratio alone cannot tell you this, and the
   * difference is not small: a 737's 25 deg of sweep costs 9% of its slope, and
   * a model that ignored it would give the jet a Cessna's pitch response.
   *
   * Sweep is also WHY the jet has a high critical Mach number, but the two are
   * separate knobs here — `aero.mCrit` is stated directly rather than derived,
   * because real Mcrit depends on the section as much as on the sweep, and a
   * supercritical aerofoil is most of a 737's.
   *
   * Zero sweep skips the multiply outright, so a straight wing keeps the exact
   * float it always had.
   */
  const SWEEP_RAD = (AERO.sweepDeg > 0 ? AERO.sweepDeg : 0) * DEG_TO_RAD;
  const CL_ALPHA =
    SWEEP_RAD > 0
      ? ((2 * Math.PI) / (1 + 2 / AR)) * Math.cos(SWEEP_RAD)
      : (2 * Math.PI) / (1 + 2 / AR);

  /**
   * CLmax is DERIVED from the configured clean stall speed, so `stallSpeedMs`
   * is a real knob rather than decoration — and, more to the point, so an
   * airframe file states a number you can look up in a POH instead of a
   * coefficient you cannot. On the C172, 25 m/s at gross gives CLmax 1.74,
   * i.e. Vs1 = 48.6 kt, the book number. Full flap adds FLAP_DCLMAX, which
   * brings Vs0 to about 41.7 kt: "stall ~40 kt", honestly arrived at.
   */
  const CL_MAX = clamp(
    WEIGHT /
      (0.5 * RHO_SEA_LEVEL * cfg.stallSpeedMs * cfg.stallSpeedMs * S_WING),
    CL_MAX_MIN,
    CL_MAX_MAX,
  );

  const massScale = MASS / 1100;
  const lenScale = (cfg.fuselageLengthM / 8.28) ** 2;
  const spanScale = (SPAN / 11) ** 2;
  const I_ROLL = cfg.inertiaRollKgM2 || 1285 * massScale * spanScale;
  const I_PITCH = cfg.inertiaPitchKgM2 || 1825 * massScale * lenScale;
  const I_YAW = cfg.inertiaYawKgM2 || 2667 * massScale * lenScale;

  const P_MAX = cfg.maxPowerW;
  const ETA = cfg.propEfficiency;
  /** Knee speed that makes T(0) land on the configured static thrust. */
  const THRUST_KNEE = (P_MAX * ETA) / Math.max(1, cfg.staticThrustN);
  const THRUST_KNEE3 = THRUST_KNEE * THRUST_KNEE * THRUST_KNEE;

  const CRASH_ON = cfg.crashEnabled !== false;
  const VNE_MS = Math.max(1, cfg.maxSpeedMs);
  const GEAR_H = cfg.gearHeightM;
  /**
   * Vertical offset from `position` to the number the altimeter shows.
   *
   * `position` is the CG / thrust-line datum, and the wheels hang `gearHeightM`
   * below it. Reporting the datum's height means a parked aeroplane reads
   * 3.9 ft AGL and 25 ft MSL on a 21 ft field, which fails MODULES.md §5 check
   * 2 ("AGL ~ 0, ALT ~ 21 ft") and, worse, makes the radio-altimeter readout —
   * the one number that tells the pilot about the terrain — permanently
   * offset. Both display altitudes are therefore taken at the WHEELS.
   *
   * This is display-only. Every force in this file still acts on the datum.
   */
  const ALT_DATUM_M = GEAR_H;
  /** Height of the wing above the datum — see `wingHeightM` in the airframe. */
  const WING_HEIGHT_M = cfg.wingHeightM;
  const MAX_N = MAX_N_PER_W * WEIGHT;
  const maxDamp = MAX_DAMP_PER_W * WEIGHT;
  /**
   * Static spring deflection, so reset() can park the aircraft already settled
   * instead of dropping it 10 cm onto the runway.
   *
   * Only the legs the aeroplane STANDS on share the weight, which is why the
   * contact table flags them: a tail tie-down or a wingtip bumper is in the
   * table as a limit stop, is not touching the ground when parked, and must
   * not be counted here or the squat comes out too small.
   */
  let kTotal = 0;
  for (let i = 0; i < CONTACTS.length; i++) {
    if (CONTACTS[i].bearing) kTotal += CONTACTS[i].k;
  }
  // An airframe that flagged nothing gets every leg rather than a divide by
  // zero: too small a squat is a cosmetic first frame, an infinite one puts
  // the aeroplane at minus infinity.
  if (kTotal <= 0) {
    for (let i = 0; i < CONTACTS.length; i++) kTotal += CONTACTS[i].k;
  }
  const STATIC_SQUAT = WEIGHT / Math.max(1, kTotal);

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
    /** TRUE airspeed, METRES/SECOND. The authoritative speed value. */
    airspeedMs: 0,
    /** Angle of attack, RADIANS, + = nose above the relative wind. */
    alphaRad: 0,

    // --- display values (UI reads these; recomputed each step) ------------
    /** True airspeed in KNOTS — the display mirror of airspeedMs. For an
     *  honest ASI needle use `indicatedAirspeedKts` instead. */
    airspeedKts: 0,
    /** Altitude above mean sea level (world y = 0), FEET, measured at the
     *  WHEELS — see the note on ALT_DATUM_M. Parked at KBFI this reads the
     *  published field elevation, 21 ft. */
    altitudeFt: 0,
    /** Altitude above the terrain directly below, FEET, measured at the
     *  wheels. Zero (bar the static squat) when sitting on the ground. */
    altitudeAglFt: 0,
    /** Magnetic-north-agnostic true heading, DEGREES, 0..360, 0 = north. */
    headingDeg: 0,
    /** Pitch attitude, DEGREES, + = nose up. */
    pitchDeg: 0,
    /** Bank angle, DEGREES, + = right wing down. */
    rollDeg: 0,
    /** Climb rate, FEET PER MINUTE, + = climbing. */
    verticalSpeedFpm: 0,
    /** Propeller/engine speed, REVOLUTIONS PER MINUTE. Zero on a turbofan,
     *  which has no propeller and reads `n1Pct` instead — see `engineGauge`. */
    rpm: 0,
    /** Fan speed, PERCENT of redline. Zero on a piston. */
    n1Pct: 0,
    /**
     * Which of the two above the panel should believe: 'rpm' | 'n1'. A gauge
     * cannot work this out from the numbers — an idling fan and a stopped
     * propeller both read low — so the airframe declares it.
     */
    engineGauge: PROPULSION === 'turbofan' ? 'n1' : 'rpm',
    /**
     * Mach number. Always published, even for airframes that ignore
     * compressibility, because it is a real quantity and a HUD may want it;
     * whether it FEEDS BACK into the aerodynamics is `aero.machEffects`.
     */
    mach: 0,
    /** True while the wing is stalled. AoA-based, with hysteresis — NOT a
     *  speed threshold. You can stall this aircraft at any speed. */
    stalled: false,
    /** True while any gear leg is carrying load. */
    onGround: false,

    // --- solidity / airframe integrity ------------------------------------
    /**
     * THE FLIGHT IS OVER. Latched — nothing clears it but reset().
     *
     * Set when the aeroplane hits something it cannot survive: a gear leg
     * bottomed out with real closing speed into the surface, an airframe load
     * past ultimate, an indicated speed past the break, or a containment trip
     * at speed. While it is true the aircraft does not move, the engine is
     * dead, and step() does no aerodynamics.
     */
    crashed: false,
    /**
     * Why. One of '' | 'terrain' | 'gear' | 'overstress' | 'overspeed'.
     * Present so the HUD can say something more useful than "you died".
     */
    crashReason: '',
    /** Human-readable one-liner for the same, e.g. "gear collapsed — 21.4 m/s
     *  into the surface". Empty until `crashed`. */
    crashDetail: '',
    /** Speed INTO the surface at the moment of the crash, m/s. */
    impactSpeedMs: 0,
    /** Load factor recorded at the moment of the crash, g. */
    impactLoadFactor: 0,
    /** IAS past Vne right now. Advisory: the airframe is still attached. */
    overspeed: false,
    /** Slope of the terrain under the aircraft, DEGREES from horizontal.
     *  Derived from the same height field the wheels use. */
    terrainSlopeDeg: 0,
    /** Deepest single-leg compression this step, METRES. Reaches
     *  GEAR_STROKE_M and stops — past that the leg is bottomed, not sprung. */
    gearStrokeMaxM: 0,
    /** True while at least one leg is bottomed out on its stop. */
    gearBottomed: false,

    // --- geodetic position (derived from `position` every step) -----------
    /** Latitude, DEGREES. Convenience mirror of position, for the HUD and
     *  for nearest-airport / nearest-landmark lookups. */
    lat: 0,
    /** Longitude, DEGREES. */
    lon: 0,

    // --- ADDITIVE extras (not in MODULES.md §2.10; safe to ignore) --------
    /** Angle of attack, DEGREES. */
    alphaDeg: 0,
    /** Sideslip, RADIANS / DEGREES. + = relative wind from the right. */
    betaRad: 0,
    betaDeg: 0,
    /** Indicated (density-corrected) airspeed, KNOTS. This is what a real ASI
     *  reads and what the stall actually tracks. Diverges hard over Rainier. */
    indicatedAirspeedKts: 0,
    /** Speed over the ground, KNOTS. */
    groundSpeedKts: 0,
    /** Load factor along the body vertical, in g. 1.0 in level flight. */
    loadFactor: 1,
    /** Elevator trim, -1 (nose down) .. +1 (nose up). What the wheel is set to,
     *  not where the surface has reached — see TRIM_RATE. */
    trim: 0,
    /** Seconds the airframe has been continuously beyond its manoeuvring
     *  limit. Diagnostic: non-zero here without a crash means a transient was
     *  correctly absorbed rather than written off. */
    overGSeconds: 0,
    /** Approaching the critical angle of attack — the buffet, not the break. */
    stallWarning: false,
    /** Fraction of separated flow over the wing, 0..1. 0 until the break. */
    separation: 0,
    /** Commanded flap position, 0..1, after travel-rate and blow-back limits. */
    flapsPos: 0,
    /** Alias of `flapsPos`. ui/instruments.js reads `state.flaps`, and main.js
     *  calls `instruments.update(state)` with no second argument, so without
     *  this mirror the flap indicator has no source and blanks to `--`. */
    flaps: 0,
    /** Commanded wheel braking, 0..1. Mirrored for the same reason as `flaps`:
     *  the HUD cannot see the input object. */
    brakes: 0,
    /** Propeller thrust, NEWTONS. */
    thrustN: 0,
    /** Total gear spring compression, METRES (sum over legs). */
    gearCompressionM: 0,
    /** Vertical speed, METRES/SECOND (metric primary for verticalSpeedFpm). */
    verticalSpeedMs: 0,
  };

  /** Read-only derived numbers — useful for a HUD or a test, never written to. */
  const config = Object.freeze({
    /** Which aeroplane this is, from the airframe file. */
    name: cfg.name,
    massKg: MASS,
    weightN: WEIGHT,
    wingAreaM2: S_WING,
    wingSpanM: SPAN,
    aspectRatio: AR,
    chordM: CHORD,
    clAlphaPerRad: CL_ALPHA,
    clMaxClean: CL_MAX,
    clMaxFlapped: CL_MAX + FLAP_DCLMAX,
    inducedK: K_INDUCED,
    stallSpeedCleanMs: cfg.stallSpeedMs,
    stallSpeedFlappedMs: Math.sqrt(
      WEIGHT / (0.5 * RHO_SEA_LEVEL * S_WING * (CL_MAX + FLAP_DCLMAX)),
    ),
    vneMs: cfg.maxSpeedMs,
    inertiaRoll: I_ROLL,
    inertiaPitch: I_PITCH,
    inertiaYaw: I_YAW,
    gearHeightM: GEAR_H,
    staticSquatM: STATIC_SQUAT,
    fixedDt: FIXED_DT,
    gearStrokeM: GEAR_STROKE_M,
    crashClosingMs: CRASH_CLOSING_MS,
    crashLoadFactor: CRASH_LOAD_G,
    crashEnabled: CRASH_ON,
  });

  // -------------------------------------------------------------------------
  // Scratch — allocated once. step() must not allocate. (MODULES.md §1.8)
  // -------------------------------------------------------------------------
  const _euler = new THREE.Euler();
  const _tmpEuler = new THREE.Euler();
  const _dq = new THREE.Quaternion();
  const _qInv = new THREE.Quaternion();
  const _air = new THREE.Vector3();
  const _vBody = new THREE.Vector3();
  const _fBody = new THREE.Vector3();
  const _fWorld = new THREE.Vector3();
  const _accel = new THREE.Vector3();
  const _bodyUp = new THREE.Vector3();
  const _fwd = new THREE.Vector3();
  const _wind = new THREE.Vector3();
  const _omegaWorld = new THREE.Vector3();
  const _rWorld = new THREE.Vector3();
  const _vPoint = new THREE.Vector3();
  const _fContact = new THREE.Vector3();
  const _fGround = new THREE.Vector3();
  const _tGround = new THREE.Vector3();
  const _tBody = new THREE.Vector3();
  const _cross = new THREE.Vector3();
  const _local = { x: 0, z: 0 };
  const _ll = { lat: 0, lon: 0 };
  const _cl = { cl: 0, sep: 0 };

  _wind.set(cfg.windEastMs, 0, -cfg.windNorthMs);

  // Control-surface positions (rate-limited images of the stick), -1..+1.
  let surfPitch = 0;
  /** Trim position, -1 (nose down) .. +1 (nose up). Moves slowly; see TRIM_RATE. */
  let trimPos = 0;
  let surfRoll = 0;
  let surfYaw = 0;
  let flapPos = 0;

  /** Seconds spent continuously beyond CRASH_LOAD_G. Zeroed the moment the
   *  load comes back inside the limit, so only a HELD overload accumulates. */
  let overGSeconds = 0;
  /** Lagged engine state, 0..1. Drives thrust AND the rpm needle. */
  let engineSpool = 0;
  // Parsed inputs for the current step(), read by every substep.
  let inPitch = 0;
  let inTrim = 0;
  let inRoll = 0;
  let inYaw = 0;
  let inThrottle = 0;
  let inFlaps = 0;
  let inBrakes = 0;
  // Integration accumulator and a clock used only for stall-buffet phase.
  let accumulator = 0;
  /**
   * RENDER INTERPOLATION.
   *
   * step() advances the world in whole 1/240 s substeps and carries whatever
   * time is left over. That is what makes the physics frame-rate independent,
   * and it is also, on its own, VISIBLY JITTERY: a real display never delivers
   * exactly 16.667 ms, so a frame consumes three substeps or four depending on
   * the residue, and `state.position` therefore advances in uneven jumps.
   *
   * Measured, with ordinary vsync jitter of +/-0.4 ms, as the worst per-frame
   * departure from smooth motion:
   *
   *     C172 at 100 kt    24 cm      3% of the aeroplane's length — invisible
   *     B738 at 250 kt    70 cm
   *     B738 at 450 kt    96 cm
   *
   * It scales with speed, which is why nobody saw it until there was a jet:
   * a metre of positional noise at frame rate, against a camera whose springs
   * move smoothly, reads as a doubled or ghosted aeroplane.
   *
   * The fix is the standard one and it is PURELY VISUAL — no harness output
   * moves, because `state` is untouched. Keep the pose from one substep back
   * and let the renderer draw between it and the current one, `renderAlpha` of
   * the way along. That renders up to one substep (4 ms) in the past, which is
   * the price of smoothness and is well under a frame.
   */
  const _prevPos = new THREE.Vector3();
  const _prevQuat = new THREE.Quaternion();
  let havePrev = false;
  let renderAlpha = 0;
  let clock = 0;
  // Running ground-height for refreshDisplay between substeps.
  let lastGround = 0;

  // ---------------------------------------------------------------------------
  // Ground sampling — FOUR points and a normal, not one scalar
  // ---------------------------------------------------------------------------
  /**
   * Terrain height under each gear contact, metres MSL. Refilled every substep
   * while the aircraft is within CONTACT_SAMPLE_AGL_M of the surface and left
   * alone otherwise, because nothing up there can touch.
   *
   * This is the fix for the interface bug, not just the implementation one: a
   * single scalar ground height cannot describe a slope, so the aeroplane could
   * only ever sit level. With four samples it sits on the ground it is actually
   * on — nose low downhill, one main first in a crosswind landing on a crowned
   * runway — and, crucially, a vertical face registers as a vertical face under
   * the leading contacts instead of as a floor that suddenly moved.
   */
  const contactGround = new Float64Array(CONTACTS.length);
  /** Unit normal of the height field at the datum. Starts flat. */
  let normX = 0;
  let normY = 1;
  let normZ = 0;
  /** Deferred ground sample awaiting confirmation — see GROUND_JUMP_BASE_M. */
  let pendingGround = 0;
  let pendingValid = false;
  /** Cumulative time past the overspeed break, seconds. */
  let overspeedTime = 0;

  /**
   * Reject a one-frame ground-sample spike without rejecting a cliff.
   *
   * @param {number} raw   this frame's getHeightAt() at the datum
   * @param {number} frame frame time, seconds
   * @returns {number}     the height the physics should believe
   */
  function acceptGround(raw, frame) {
    if (!Number.isFinite(raw)) return lastGround;
    const gs = Math.sqrt(
      state.velocity.x * state.velocity.x + state.velocity.z * state.velocity.z,
    );
    // How far real terrain can move under the aircraft in one frame: a 12 m
    // floor (so a stationary aeroplane tolerates DEM refinement without a
    // hiccup) plus ground speed x frame time x tan(63°). At 60 m/s and 60 Hz
    // that is 14 m of vertical change accepted with no delay at all — a 2:1
    // slope taken at 117 kt. Anything steeper is either a cliff, in which case
    // it will still be there in 16 ms, or a void, in which case it will not.
    const tol = GROUND_JUMP_BASE_M + GROUND_JUMP_PER_MS * gs * frame;
    if (Math.abs(raw - lastGround) <= tol) {
      pendingValid = false;
      return raw;
    }
    if (pendingValid && Math.abs(raw - pendingGround) <= GROUND_CONFIRM_M) {
      // Two frames agree. It is real ground; take it, whatever it costs.
      pendingValid = false;
      return raw;
    }
    pendingGround = raw;
    pendingValid = true;
    return lastGround;
  }

  /**
   * Estimate the unit normal of the height field at (x, z) by central
   * differences. Four samples, once per frame — this is what turns a scalar
   * heightmap into a surface with an orientation, and therefore what lets the
   * model tell "descending onto a runway at 3 m/s" apart from "flying into the
   * side of a hill at 60".
   *
   * @param {number} x metres
   * @param {number} z metres
   * @param {number} gh accepted datum height, used if a probe returns garbage
   */
  function sampleGroundNormal(x, z, gh) {
    if (!hasGroundFn) {
      normX = 0;
      normY = 1;
      normZ = 0;
      state.terrainSlopeDeg = 0;
      return;
    }
    const d = NORMAL_PROBE_M;
    const hE = safeHeight(x + d, z, gh);
    const hW = safeHeight(x - d, z, gh);
    const hS = safeHeight(x, z + d, gh);
    const hN = safeHeight(x, z - d, gh);
    // Gradient of h. The surface is y = h(x, z), so its normal is
    // (-dh/dx, 1, -dh/dz) before normalising.
    const gx = (hE - hW) / (2 * d);
    const gz = (hS - hN) / (2 * d);
    const inv = 1 / Math.sqrt(gx * gx + gz * gz + 1);
    normX = -gx * inv;
    normY = inv;
    normZ = -gz * inv;
    state.terrainSlopeDeg = Math.acos(clamp(normY, -1, 1)) * RAD_TO_DEG;
  }

  /** getHeightAt with outlier and NaN rejection against a trusted reference. */
  function safeHeight(x, z, ref) {
    const h = groundHeightFn(x, z);
    if (!Number.isFinite(h)) return ref;
    if (h > ref + CONTACT_OUTLIER_M) return ref + CONTACT_OUTLIER_M;
    if (h < ref - CONTACT_OUTLIER_M) return ref - CONTACT_OUTLIER_M;
    return h;
  }

  /**
   * Fill contactGround[] for the current attitude.
   *
   * THE CALLER STILL OWNS THE ABSOLUTE HEIGHT. `gh` — the value main.js passed
   * to step() — sets the level; `groundHeightFn` only supplies the SHAPE, as a
   * difference from its own reading at the datum. Where the two agree, as
   * §1.4 requires, this is identical to sampling each wheel directly. Where
   * they ever disagree, the wheels stay consistent with the number the rest of
   * the sim is using instead of quietly acquiring a second opinion about where
   * the ground is, and the disagreement shows up as an altimeter offset rather
   * than as an aeroplane buried in the runway.
   *
   * @param {number} gh accepted datum height, metres MSL
   */
  function sampleContactGround(gh) {
    if (!hasGroundFn) {
      flattenContactGround(gh);
      return;
    }
    const ref = groundHeightFn(state.position.x, state.position.z);
    if (!Number.isFinite(ref)) {
      flattenContactGround(gh);
      return;
    }
    for (let i = 0; i < CONTACTS.length; i++) {
      const cp = CONTACTS[i];
      _rWorld.set(cp.x, cp.y - GEAR_H, cp.z).applyQuaternion(state.orientation);
      contactGround[i] =
        gh +
        (safeHeight(
          state.position.x + _rWorld.x,
          state.position.z + _rWorld.z,
          ref,
        ) -
          ref);
    }
  }

  /** Every contact sits on the datum's height. Used when far from the ground
   *  and when no sampler was supplied. */
  function flattenContactGround(gh) {
    for (let i = 0; i < CONTACTS.length; i++) contactGround[i] = gh;
  }

  // ---------------------------------------------------------------------------
  // Crash
  // ---------------------------------------------------------------------------
  /**
   * End the flight. Idempotent — the first cause wins, so the HUD reports the
   * thing that actually broke rather than whatever broke next.
   *
   * The aeroplane STOPS WHERE IT HIT. It is not moved to the surface, it is not
   * given altitude, it does not keep its speed. The only positional liberty
   * taken is WRECK_SETTLE_MAX_M of lift when the datum ended up buried in flat
   * ground, which is cosmetic and bounded precisely so it can never become the
   * teleport it replaced.
   *
   * @param {string} reason 'terrain' | 'gear' | 'overstress' | 'overspeed'
   * @param {string} detail one-line human explanation
   * @param {number} closingMs speed into the surface, m/s
   * @param {number} gh accepted ground height at the datum
   */
  function triggerCrash(reason, detail, closingMs, gh) {
    if (state.crashed) return;
    state.crashed = true;
    state.crashReason = reason;
    state.crashDetail = detail;
    state.impactSpeedMs = Math.abs(closingMs);
    state.impactLoadFactor = state.loadFactor;
    state.velocity.set(0, 0, 0);
    state.angularVelocity.set(0, 0, 0);
    state.airspeedMs = 0;
    state.thrustN = 0;
    state.stalled = false;
    state.stallWarning = false;
    state.separation = 0;

    // Bounded cosmetic settle: only ever upward, only ever a small amount, and
    // only when the wreck is genuinely underground.
    const rest = gh + GEAR_H - STATIC_SQUAT;
    const lift = rest - state.position.y;
    if (lift > 0 && lift <= WRECK_SETTLE_MAX_M) state.position.y = rest;
  }

  // ---------------------------------------------------------------------------
  // Lift curve
  // ---------------------------------------------------------------------------
  /**
   * CL and separation fraction as a function of angle of attack measured from
   * the ZERO-LIFT line (so camber and flap deflection just move the origin).
   *
   * Three regions:
   *   1. linear,  CL = a * alphaEff
   *   2. the last ALPHA_SOFT before the peak, rounded over to zero slope —
   *      real wings do not have a corner there, and a corner makes the buffet
   *      feel like a switch
   *   3. past the peak, an exponential collapse (e-folding STALL_BREAK) from
   *      CLmax toward flat-plate CL = 1.05 sin(2a).
   *
   * The result: CL falls ~30% within 7 deg of the break and keeps falling,
   * while CD rises by an order of magnitude. That is a stall you have to fly
   * out of, and the only way out is down — nothing in here lets you recover by
   * pulling harder, because pulling harder raises alpha and alpha is the whole
   * problem.
   *
   * @param {number} aEff  alpha relative to the zero-lift line, radians
   * @param {number} aMaxPos positive-side critical alphaEff, radians
   * @param {number} clAlpha lift-curve slope, /rad. This is a PARAMETER rather
   *        than the module's CL_ALPHA because compressibility steepens it —
   *        see MACH_EFFECTS. Subsonic airframes pass CL_ALPHA itself, so the
   *        curve is the identical function it always was.
   * @param {{cl:number, sep:number}} out
   */
  function liftCurve(aEff, aMaxPos, clAlpha, out) {
    const sign = aEff >= 0 ? 1 : -1;
    const a = aEff >= 0 ? aEff : -aEff;
    const aMax = sign > 0 ? aMaxPos : aMaxPos * NEG_STALL_SCALE;
    const knee = aMax - ALPHA_SOFT;

    if (a <= knee) {
      out.cl = sign * clAlpha * a;
      out.sep = 0;
      return out;
    }
    if (a <= aMax) {
      // Quadratic that matches value and slope at `knee` and flattens at aMax.
      const t = (a - knee) / ALPHA_SOFT;
      out.cl =
        sign * clAlpha * (knee + ALPHA_SOFT * (t - 0.5 * t * t));
      out.sep = 0;
      return out;
    }
    const clPeak = clAlpha * (aMax - 0.5 * ALPHA_SOFT);
    const w = 1 - Math.exp(-(a - aMax) / STALL_BREAK);
    const flat =
      CL_FLATPLATE * Math.sin(2 * (a < Math.PI * 0.5 ? a : Math.PI * 0.5));
    out.cl = sign * (clPeak * (1 - w) + flat * w);
    out.sep = w;
    return out;
  }

  // ---------------------------------------------------------------------------
  // One fixed physics substep
  // ---------------------------------------------------------------------------
  /**
   * @param {number} h  substep, seconds — always FIXED_DT
   * @param {number} gh terrain elevation, metres MSL, at the aircraft's (x, z)
   */
  function integrate(h, gh) {
    clock += h;

    // --- the flight is over ------------------------------------------------
    // A wreck has no aerodynamics and no gear. It does not drift, it does not
    // slide, and it does not quietly keep flying with the HUD showing 61 kt.
    // The engine winds down and that is the whole of the physics.
    if (state.crashed) {
      engineSpool = moveToward(engineSpool, 0, 1.2 * h);
      state.rpm = Math.max(0, state.rpm - 900 * h);
      state.n1Pct = Math.max(0, state.n1Pct - 30 * h);
      state.mach = 0;
      state.thrustN = 0;
      state.velocity.set(0, 0, 0);
      state.angularVelocity.set(0, 0, 0);
      state.airspeedMs = 0;
      state.loadFactor = 0;
      state.onGround = true;
      return;
    }

    // --- where the ground is, under each wheel -----------------------------
    // Sampling is skipped outright when nothing can reach: the datum's own
    // sample bounds how far below it any contact can be.
    if (state.position.y - gh < CONTACT_SAMPLE_AGL_M) sampleContactGround(gh);
    else flattenContactGround(gh);

    // --- control surfaces lag the stick -----------------------------------
    surfPitch = moveToward(surfPitch, inPitch, SURFACE_RATE * h);
    trimPos = moveToward(trimPos, inTrim, TRIM_RATE * h);
    state.trim = trimPos;
    surfRoll = moveToward(surfRoll, inRoll, SURFACE_RATE * h);
    surfYaw = moveToward(surfYaw, inYaw, SURFACE_RATE * h);

    // --- atmosphere --------------------------------------------------------
    const rho = airDensity(state.position.y);
    const sigma = rho / RHO_SEA_LEVEL;

    // --- relative wind, body frame, aero frame -----------------------------
    _qInv.copy(state.orientation).conjugate(); // unit quaternion: conjugate == inverse
    _air.copy(state.velocity).sub(_wind);
    _vBody.copy(_air).applyQuaternion(_qInv);
    const u = -_vBody.z; // forward
    const vR = _vBody.x; // right
    const wD = -_vBody.y; // down
    const V = Math.sqrt(u * u + vR * vR + wD * wD);

    let alpha = 0;
    let beta = 0;
    if (V > 0.5) {
      alpha = Math.atan2(wD, u > 0.5 ? u : 0.5);
      beta = Math.asin(clamp(vR / V, -1, 1));
    }

    const qbar = 0.5 * rho * V * V;
    const qS = qbar * S_WING;

    // --- Mach ---------------------------------------------------------------
    // Computed only when the airframe asks for it: a sqrt per substep is cheap
    // but not free, and a subsonic aeroplane would be paying it to multiply by
    // one. `state.mach` is still published either way — a Cessna's Mach number
    // is a real quantity, it is just never large enough to change anything.
    const mach = V / speedOfSound(state.position.y);
    let clAlphaEff = CL_ALPHA;
    let cdWave = 0;
    if (MACH_EFFECTS) {
      const mPG = mach < PG_MACH_MAX ? mach : PG_MACH_MAX;
      clAlphaEff = CL_ALPHA / Math.sqrt(1 - mPG * mPG);
      if (mach > M_CRIT) {
        const over = (mach - M_CRIT) / (1 - M_CRIT);
        cdWave = MACH_DRAG_K * over * over * over;
      }
    }

    // --- body rates -> aero rates ------------------------------------------
    const p = -state.angularVelocity.z;
    const q = state.angularVelocity.x;
    const r = -state.angularVelocity.y;
    // Non-dimensional rates go singular at V -> 0; the 12 m/s floor keeps the
    // damping terms finite. Below that qbar is tiny anyway, so it never shows.
    const vRef = V > 12 ? V : 12;
    const pHat = (p * SPAN) / (2 * vRef);
    const qHat = (q * CHORD) / (2 * vRef);
    const rHat = (r * SPAN) / (2 * vRef);

    // --- flaps: travel rate, then blow-back above Vfe ----------------------
    // Blow-back. Each placard contributes the position it permits, faded over
    // the same 12 m/s band as the single-Vfe case, and the flaps may go to
    // whichever permits the most. Below every placard that is simply 1.0.
    let blowBack;
    if (VFE_SCHEDULE) {
      blowBack = 0;
      for (let i = 0; i < VFE_SCHEDULE.length; i++) {
        const e = VFE_SCHEDULE[i];
        const allowed = e.pos * clamp(1 - (V - e.ms) / 12, 0, 1);
        if (allowed > blowBack) blowBack = allowed;
      }
    } else {
      blowBack = clamp(1 - (V - VFE_MS) / 12, 0, 1);
    }
    const flapCmd = Math.min(clamp(inFlaps, 0, 1), blowBack);
    flapPos = moveToward(flapPos, flapCmd, FLAP_TRAVEL_RATE * h);

    // --- lift curve, shifted and stretched by flap ------------------------
    // CLmax itself is set by SEPARATION and barely moves with Mach, so a
    // steeper slope means the wing reaches that same CLmax at a SMALLER alpha.
    // That is the right behaviour and it is the reason high-altitude jet upsets
    // are so unforgiving: the margin between cruise alpha and stall alpha
    // shrinks as you climb, from both ends at once.
    const cl0Eff = CL0 + FLAP_DCL0 * flapPos;
    const alphaZeroLift = -cl0Eff / clAlphaEff;
    const alphaEffMax =
      (CL_MAX + FLAP_DCLMAX * flapPos) / clAlphaEff + 0.5 * ALPHA_SOFT;
    const alphaEff = alpha - alphaZeroLift;
    liftCurve(alphaEff, alphaEffMax, clAlphaEff, _cl);
    const clWing = _cl.cl;
    const sep = _cl.sep;

    // --- engine ------------------------------------------------------------
    // One lagged engine state drives BOTH the gauge and the thrust, so what you
    // hear and what you feel are the same number.
    //
    // The spool rate is directional. For a piston the two rates are equal and
    // this is exactly the single damp() it always was; a fan accelerates more
    // slowly than it decelerates, which is a thing you have to fly around.
    engineSpool = damp(
      engineSpool,
      inThrottle,
      inThrottle >= engineSpool ? SPOOL_RATE : SPOOL_RATE_DOWN,
      h,
    );

    let thrust;
    if (PROPULSION === 'turbofan') {
      // Flat-rated thrust, not shaft power. It sags with density and with
      // Mach, and it does NOT have a 1/V term — that term is the propeller,
      // and there isn't one.
      const machT = mach > 0 ? mach : 0;
      const machFactor = clamp(1 - THRUST_MACH_K * Math.sqrt(machT), 0.25, 1);
      thrust =
        cfg.staticThrustN *
        (IDLE_THRUST_FRAC + (1 - IDLE_THRUST_FRAC) * engineSpool) *
        Math.pow(sigma, THRUST_LAPSE_EXP) *
        machFactor;
    } else {
      // Naturally aspirated power lapse with density: P/P0 = (sigma-0.117)/0.883.
      // Then a fixed-pitch propeller converts shaft power to thrust, which is
      // where the 1/V roll-off comes from.
      const powerLapse = clamp((sigma - 0.117) / 0.883, 0, 1);
      const shaftW = P_MAX * powerLapse * (0.03 + 0.97 * engineSpool);
      thrust = (shaftW * ETA) / Math.cbrt(V * V * V + THRUST_KNEE3);
    }
    state.thrustN = thrust;

    if (PROPULSION === 'turbofan') {
      // N1 is a FAN SPEED, and thrust goes up far faster than it does — so the
      // gauge rises quickly off idle and then crawls, and the last 10% of the
      // needle is a third of the thrust. This is why jets are flown on N1 and
      // not on "throttle %": 65% N1 is nearly nothing and 90% is nearly
      // everything, and the difference between them is the whole approach.
      //
      // The exponent maps SPOOL (the commanded thrust fraction), not the thrust
      // fraction including its idle floor — mapping the latter put a parked
      // aeroplane at 51% N1, because idle thrust is 5.5% and the curve is very
      // steep down there. Idle is idle: spool 0 reads exactly n1Idle.
      state.n1Pct =
        N1_IDLE + (N1_MAX - N1_IDLE) * Math.pow(clamp(engineSpool, 0, 1), 0.35);
      // There is no propeller and nothing for the airstream to windmill into a
      // gauge reading. Leaving `rpm` at zero is deliberate: a plausible-looking
      // rpm on a turbofan is worse than an obviously absent one, because a
      // wrong number that reads right is a number nobody checks.
      state.rpm = 0;
    } else {
      // rpm: commanded by the same spool state, but the airstream will drive
      // the prop faster than idle on the way down — a glide is not silent.
      const cmdRpm =
        cfg.idleRpm +
        engineSpool * (cfg.maxRpm - cfg.idleRpm) * (0.55 + 0.45 * sigma);
      const windmillRpm = V * WINDMILL_RPM_PER_MS;
      state.rpm = Math.min(
        cfg.maxRpm,
        cmdRpm > windmillRpm ? cmdRpm : windmillRpm,
      );
      state.n1Pct = 0;
    }

    // --- drag --------------------------------------------------------------
    // Ground effect: induced drag collapses inside a wingspan of the surface.
    const hAgl = Math.max(0, state.position.y + WING_HEIGHT_M - gh);
    const hb = (GROUND_EFFECT_K * hAgl) / SPAN;
    const groundEffect = (hb * hb) / (1 + hb * hb);

    const cdWindmill = WINDMILL_CD0 * (1 - clamp(inThrottle, 0, 1));
    const cdInduced = K_INDUCED * groundEffect * clWing * clWing;
    const sinA = Math.sin(alphaEff);
    const cdSep = sep * CD_SEPARATED * sinA * sinA;
    const cd =
      cfg.cd0 +
      cdWindmill +
      FLAP_DCD * flapPos +
      cdInduced +
      CD_BETA * beta * beta +
      cdSep +
      cdWave;

    // --- control deflections, radians -------------------------------------
    // Stick +1 pitch = nose up. Elevator TE-down is positive, so pull is
    // negative deflection. Stick +1 yaw = RIGHT rudder, and CN_DR is negative,
    // so right rudder is negative deflection too.
    // Trim biases the elevator: with the stick released the surface sits here,
    // so the aeroplane holds this speed hands-off. Clamped WITH the stick so a
    // fully trimmed aeroplane cannot exceed the surface's real travel.
    const pitchSurface = clamp(surfPitch + trimPos * TRIM_AUTHORITY, -1, 1);
    let de = -pitchSurface * DE_MAX;
    const da = surfRoll * DA_MAX;
    const dr = -surfYaw * DR_MAX;

    // A stalled wing dumps its wake over the tailplane, so you cannot pull
    // FURTHER into the stall — but the elevator keeps full authority the other
    // way, because pushing is the recovery and taking that away would be a lie
    // in the opposite direction. Ailerons lose most of their bite (the tips
    // separate first); the rudder keeps all of its.
    if (sep > 0 && de < 0) de *= 1 - 0.5 * sep;
    const daEff = da * (1 - 0.6 * sep);

    // --- aerodynamic coefficients -----------------------------------------
    const cl = clWing + CL_Q * qHat + CL_DE * de;
    const cy = CY_BETA * beta + CY_DR * dr;

    // Deterministic, slowly wandering asymmetry so the stall drops a wing
    // instead of mushing straight ahead. Two incommensurate sines, no RNG, so
    // a replay is a replay.
    const asym =
      0.55 * Math.sin(clock * 1.7) + 0.45 * Math.sin(clock * 0.63 + 1.1);

    const cRoll =
      CROLL_BETA * beta +
      CROLL_P * pHat +
      CROLL_R * rHat +
      CROLL_DA * daEff +
      CROLL_DR * dr +
      CROLL_STALL * sep * asym;

    const cM =
      CM0 +
      CM_ALPHA * alpha +
      CM_Q * qHat +
      CM_DE * de +
      CM_FLAP * flapPos +
      CM_STALL * sep;

    const cN =
      CN_BETA * beta +
      CN_P * pHat +
      CN_R * rHat +
      CN_DA * daEff +
      CN_DR * dr;

    // --- aerodynamic + propulsive forces, aero frame -----------------------
    const lift = qS * cl;
    const drag = qS * cd;
    const side = qS * cy;

    const ca = Math.cos(alpha);
    const sa = Math.sin(alpha);
    const xA = lift * sa - drag * ca + thrust;
    const yA = side;
    const zA = -lift * ca - drag * sa;

    // aero -> body: x_body = y_aero, y_body = -z_aero, z_body = -x_aero
    _fBody.set(yA, -zA, -xA);
    _fWorld.copy(_fBody).applyQuaternion(state.orientation);

    // --- moments, aero frame ----------------------------------------------
    const qSb = qS * SPAN;
    const qSc = qS * CHORD;
    // Torque and slipstream are LOW-SPEED, HIGH-POWER effects here, faded out
    // by prop.effectFadeMs — see the airframe file for why they are faded at
    // all, and set both arms to zero for anything that is not a single with a
    // propeller on the front.
    const propEffect = clamp(1 - V / PROP_EFFECT_FADE_MS, 0, 1);
    let momL = qSb * cRoll - TORQUE_ARM_M * thrust * propEffect;
    let momM = qSc * cM;
    // Propwash spirals onto the fin: left yaw. This is why a real single
    // needs right rudder on the takeoff roll.
    let momN = qSb * cN - SLIPSTREAM_ARM_M * thrust * propEffect;

    // --- landing gear ------------------------------------------------------
    _fGround.set(0, 0, 0);
    _tGround.set(0, 0, 0);
    let normalTotal = 0;
    let compressionTotal = 0;
    let strokeMax = 0;

    // Steering: the nosewheel follows the pedals, fading out as the rudder
    // takes over. Rotating a heading vector about +Y by +phi turns it LEFT
    // (heading = -yaw, MODULES.md §1.2), so a right pedal is -phi.
    const gspd = Math.sqrt(
      state.velocity.x * state.velocity.x + state.velocity.z * state.velocity.z,
    );
    // Nosewheel authority falls as (V_REF/V)^1.5 — see STEER_MAX. Decaying at
    // least as fast as 1/V is what stops yaw authority GROWING with speed.
    const steerGain = clamp(
      (STEER_REF_MS / Math.max(gspd, STEER_REF_MS)) ** STEER_FADE_EXP,
      STEER_FLOOR,
      1,
    );
    const steerAngle = surfYaw * STEER_MAX * steerGain;
    const cosS = Math.cos(steerAngle);
    const sinS = Math.sin(steerAngle);

    _omegaWorld.copy(state.angularVelocity).applyQuaternion(state.orientation);
    _fwd.set(0, 0, -1).applyQuaternion(state.orientation);
    // Nose direction projected onto the ground plane.
    let fx = _fwd.x;
    let fz = _fwd.z;
    let flen = Math.sqrt(fx * fx + fz * fz);
    if (flen < 1e-4) {
      fx = 0;
      fz = -1;
      flen = 1;
    }
    fx /= flen;
    fz /= flen;

    const brake = clamp(inBrakes, 0, 1);

    // Worst offender this substep, for the crash test after the loop.
    let deepest = 0;
    let worstClosing = 0;
    let bottomedAny = false;

    for (let i = 0; i < CONTACTS.length; i++) {
      const cp = CONTACTS[i];
      _rWorld.set(cp.x, cp.y - GEAR_H, cp.z).applyQuaternion(state.orientation);
      const py = state.position.y + _rWorld.y;
      // THE GROUND UNDER THIS WHEEL, not under the aeroplane. On a 6 deg slope
      // the nose and the mains differ by 15 cm, which is the entire difference
      // between an aircraft that sits level everywhere and one that parks
      // nose-down on a hill.
      const pen = contactGround[i] - py;
      if (pen <= 0) continue;

      _cross.crossVectors(_omegaWorld, _rWorld);
      _vPoint.copy(state.velocity).add(_cross);

      // THE CONTACT WORKS IN THE SURFACE FRAME, NOT THE WORLD FRAME.
      //
      // `pen` is a VERTICAL depth; the leg is compressed by the PERPENDICULAR
      // depth, which is pen * cos(slope) = pen * normY. The normal force acts
      // along the surface normal and the tyre forces act in the tangent plane.
      // On level ground normY is 1 and the normal is +Y, so every line below
      // reduces exactly to the world-frame version this replaces — which is why
      // none of the measured flat-ground numbers move. On a hill it is the
      // difference between an aeroplane parked on the hill and an aeroplane
      // being shoved sideways by a spring that thinks the world is flat.
      const penPerp = pen * normY;
      const vN = _vPoint.x * normX + _vPoint.y * normY + _vPoint.z * normZ;

      // A LEG IS A SPRING WITH A STOP. Past GEAR_STROKE_M there is no more
      // spring: clamping the compression here is what stops the model turning
      // a 500 m wall into a 500 m spring and firing the aeroplane up the face
      // of it. The excess penetration is recorded, not resolved — resolving it
      // is the crash test's job.
      let penEff = penPerp;
      if (penPerp > GEAR_STROKE_M) {
        penEff = GEAR_STROKE_M;
        bottomedAny = true;
        if (penPerp > deepest) deepest = penPerp;
        // Closing speed along the LOCAL SURFACE NORMAL. On a runway that is
        // sink rate. On a cliff face it is most of the airspeed — which is the
        // whole reason the normal is computed at all.
        if (-vN > worstClosing) worstClosing = -vN;
      }

      // Spring + damper along the normal. Damping only resists compression, so
      // the gear never sucks the aircraft back down on rebound.
      let damp2 = -cp.c * vN;
      if (vN > 0) damp2 *= REBOUND_DAMP;
      if (damp2 > maxDamp) damp2 = maxDamp;
      else if (damp2 < -maxDamp) damp2 = -maxDamp;
      let fn = cp.k * penEff + damp2;
      if (fn < 0) fn = 0;
      if (fn > MAX_N) fn = MAX_N;
      normalTotal += fn * normY; // vertical share — what holds the weight up
      compressionTotal += penEff;
      if (penEff > strokeMax) strokeMax = penEff;

      // Wheel-plane axes. Only the nosewheel steers.
      let wfx = fx;
      let wfz = fz;
      if (cp.steer) {
        wfx = fx * cosS - fz * sinS;
        wfz = fx * sinS + fz * cosS;
      }
      // Project the rolling direction into the tangent plane, then take
      // right = forward x normal. Level ground gives (-wfz, 0, wfx), the same
      // vector the world-frame code used.
      let wfy = 0;
      const dotFN = wfx * normX + wfz * normZ;
      wfx -= normX * dotFN;
      wfy = -normY * dotFN;
      wfz -= normZ * dotFN;
      const wfLen = Math.sqrt(wfx * wfx + wfy * wfy + wfz * wfz);
      if (wfLen > 1e-6) {
        wfx /= wfLen;
        wfy /= wfLen;
        wfz /= wfLen;
      }
      const wrx = wfy * normZ - wfz * normY;
      const wry = wfz * normX - wfx * normZ;
      const wrz = wfx * normY - wfy * normX;

      const vLong = _vPoint.x * wfx + _vPoint.y * wfy + _vPoint.z * wfz;
      const vLat = _vPoint.x * wrx + _vPoint.y * wry + _vPoint.z * wrz;

      const muLong = cp.brake ? cp.muRoll + (MU_BRAKE - cp.muRoll) * brake : cp.muRoll;
      // tanh, not sign(): a discontinuity at zero slip velocity chatters at
      // any timestep. tanh is smooth, bounded by mu*N, and its slope near zero
      // is small enough (mu*N/vRef * h / m << 2) to stay explicit-stable.
      const fLong = -muLong * fn * Math.tanh(vLong / cp.vRefLong);
      const fLat = -cp.muSide * fn * Math.tanh(vLat / cp.vRefSide);

      _fContact.set(
        normX * fn + wfx * fLong + wrx * fLat,
        normY * fn + wfy * fLong + wry * fLat,
        normZ * fn + wfz * fLong + wrz * fLat,
      );
      _fGround.add(_fContact);
      _cross.crossVectors(_rWorld, _fContact);
      _tGround.add(_cross);
    }

    state.gearCompressionM = compressionTotal;
    state.gearStrokeMaxM = strokeMax;
    state.gearBottomed = bottomedAny;
    const onGround = normalTotal > 0.02 * WEIGHT;
    state.onGround = onGround;

    if (normalTotal > 0) {
      _fWorld.add(_fGround);
      // World torque -> body torque -> aero moments.
      _tBody.copy(_tGround).applyQuaternion(_qInv);
      momM += _tBody.x;
      momN += -_tBody.y;
      momL += -_tBody.z;
    }

    // --- accelerometer (specific force, i.e. everything but gravity) -------
    _accel.copy(_fWorld).multiplyScalar(1 / MASS);
    _bodyUp.set(0, 1, 0).applyQuaternion(state.orientation);
    state.loadFactor = _accel.dot(_bodyUp) / GRAVITY;

    // --- did any of that break the aeroplane? ------------------------------
    if (CRASH_ON) {
      // 1. The gear. A bottomed leg on its own is NOT a crash: an LOD
      //    refinement can raise the ground under a PARKED aeroplane, and the
      //    honest answer to that is to let the stop take the load, not to write
      //    the aircraft off. What decides it is the speed INTO THE SURFACE at
      //    the moment the stop is reached — which is sink rate on a runway and
      //    almost all of the airspeed on a cliff face.
      if (bottomedAny && worstClosing > CRASH_CLOSING_MS) {
        triggerCrash(
          'gear',
          `gear collapsed — ${worstClosing.toFixed(1)} m/s into ` +
            `${state.terrainSlopeDeg.toFixed(0)}° terrain`,
          worstClosing,
          gh,
        );
        return;
      }
      // 2. The airframe. Ultimate load, either sign. Backstop for every impact
      //    the gear test does not catch: a wingtip-first arrival, a wall taken
      //    at an angle where no single leg bottoms but the aeroplane stops.
      //
      //    Two paths — see the CRASH_LOAD_* block for why. A single substep
      //    beyond the manoeuvring limit is a transient, not a failure; the
      //    aeroplane has to HOLD the load to break. An impact-scale reading
      //    fails immediately because waiting 100 ms to admit it would be absurd.
      const absG = Math.abs(state.loadFactor);
      overGSeconds = absG > CRASH_LOAD_G ? overGSeconds + h : 0;
      state.overGSeconds = overGSeconds;

      if (absG > CRASH_LOAD_INSTANT_G) {
        triggerCrash(
          'overstress',
          `airframe overload — ${state.loadFactor.toFixed(1)} g` +
            (deepest > 0 ? ' on impact' : ''),
          worstClosing,
          gh,
        );
        return;
      }
      if (overGSeconds >= CRASH_LOAD_SUSTAIN_S) {
        triggerCrash(
          'overstress',
          `airframe overload — ${state.loadFactor.toFixed(1)} g held for ` +
            `${(overGSeconds * 1000).toFixed(0)} ms` +
            (deepest > 0 ? ' on impact' : ''),
          worstClosing,
          gh,
        );
        return;
      }
    }

    // --- gravity, then linear integration ---------------------------------
    _fWorld.y -= WEIGHT;
    state.velocity.addScaledVector(_fWorld, h / MASS);
    state.position.addScaledVector(state.velocity, h);

    // --- angular integration (Euler's equations, aero axes) ---------------
    // The (I - I) q r terms are what make a rolling pull want to yaw and a
    // yawing roll want to pitch. They cost three multiplies; keep them.
    const pDot = (momL + (I_PITCH - I_YAW) * q * r) / I_ROLL;
    const qDot = (momM + (I_YAW - I_ROLL) * p * r) / I_PITCH;
    const rDot = (momN + (I_ROLL - I_PITCH) * p * q) / I_YAW;

    const pN = p + pDot * h;
    const qN = q + qDot * h;
    const rN = r + rDot * h;
    // aero -> body: wx = q, wy = -r, wz = -p
    state.angularVelocity.set(qN, -rN, -pN);

    // First-order quaternion update. At h = 1/240 s and the rates a light
    // single can generate (< 3 rad/s), the truncation error is ~1e-5 rad per
    // step and the renormalise absorbs it.
    _dq.set(
      state.angularVelocity.x * h * 0.5,
      state.angularVelocity.y * h * 0.5,
      state.angularVelocity.z * h * 0.5,
      1,
    );
    state.orientation.multiply(_dq).normalize();

    // --- last-resort containment ------------------------------------------
    // The datum has ended up well below the surface. There are exactly two
    // ways that happens and they deserve opposite answers.
    //
    // This block used to give one answer to both: set y to the surface and
    // clear the sink rate. Measured consequence — level at 119 kt into a 500 m
    // wall lifted the aeroplane 498 m in a single frame, kept all 119 kt, and
    // left onGround false. That is not containment, it is a lift to the top of
    // the mountain, and it is why terrain was not solid.
    //
    //   at speed   the aeroplane got there by flying into something. It is a
    //              crash. It stops where it is. No altitude is granted.
    //   at rest    the GROUND moved (an LOD refinement, a bake reload). The
    //              aeroplane did nothing wrong; put it on its wheels. Bounded
    //              by WRECK_SETTLE_MAX_M's sibling logic: at < 3 m/s there is
    //              no energy to gift.
    const floor = gh - GEAR_H - 4;
    if (state.position.y < floor) {
      const speed = state.velocity.length();
      if (CRASH_ON && speed > CONTAINMENT_SAFE_MS) {
        triggerCrash(
          'terrain',
          `terrain impact — ${(floor - state.position.y).toFixed(0)} m below the surface at ` +
            `${(speed * MS_TO_KTS).toFixed(0)} kt`,
          speed,
          gh,
        );
        return;
      }
      state.position.y = gh + GEAR_H - STATIC_SQUAT;
      if (state.velocity.y < 0) state.velocity.y = 0;
    }

    // --- Vne and Mmo are not decorative ------------------------------------
    // Advisory below the break so the HUD can shout; structural above it.
    //
    // TWO limits, whichever bites first. Vne is a dynamic-pressure limit and is
    // a fixed IAS; Mmo is a compressibility limit and is a fixed Mach. Low down
    // Vne is the binding one; high up Mmo is, because the same Mach number
    // corresponds to less and less IAS as the air thins. The altitude where
    // they cross is the corner of the envelope, and on a 737 it is around
    // FL260. A model with only Vne lets you fly a jet clean through Mmo at
    // cruise and never says a word.
    // The IAS comparisons below are written exactly as they always were, rather
    // than refactored into a shared ratio: an airframe with no Mmo must take
    // the identical branch on the identical floating-point comparison, or the
    // Cessna's structural-failure altitude moves by a rounding error.
    const iasMs = V * Math.sqrt(sigma);
    const hasMmo = MMO !== Infinity;
    state.overspeed = iasMs > VNE_MS || (hasMmo && mach > MMO);
    if (
      iasMs > VNE_MS * OVERSPEED_BREAK ||
      (hasMmo && mach > MMO * OVERSPEED_BREAK)
    ) {
      overspeedTime += h;
      if (CRASH_ON && overspeedTime > 0.5) {
        // Name whichever limit is proportionally further past — that is the
        // one that actually broke it.
        const byMach = hasMmo && mach / MMO > iasMs / VNE_MS;
        triggerCrash(
          'overspeed',
          byMach
            ? `structural failure — M${mach.toFixed(2)} past an ` +
                `M${MMO.toFixed(2)} Mmo`
            : `structural failure — ${(iasMs * MS_TO_KTS).toFixed(0)} KIAS ` +
                `past a ${(VNE_MS * MS_TO_KTS).toFixed(0)} kt Vne`,
          iasMs,
          gh,
        );
        return;
      }
    } else {
      overspeedTime = 0;
    }

    // --- stall, from angle of attack, with hysteresis ----------------------
    const critNow = alphaEff >= 0 ? alphaEffMax : -alphaEffMax * NEG_STALL_SCALE;
    const past = alphaEff >= 0 ? alphaEff - critNow : critNow - alphaEff;
    if (V > 6) {
      if (state.stalled) {
        // 2 deg of hysteresis: you have to actually unload the wing, not just
        // twitch the stick, before the model calls it recovered.
        if (past < -2 * DEG_TO_RAD) state.stalled = false;
      } else if (past > 0) {
        state.stalled = true;
      }
      state.stallWarning = past > -5 * DEG_TO_RAD;
    } else {
      state.stalled = false;
      state.stallWarning = false;
    }

    state.alphaRad = alpha;
    state.betaRad = beta;
    state.airspeedMs = V;
    state.mach = mach;
    state.separation = sep;
    state.flapsPos = flapPos;
    state.flaps = flapPos;
    state.brakes = brake;
  }

  /** Move `cur` toward `target` by at most `maxDelta`. */
  function moveToward(cur, target, maxDelta) {
    const d = target - cur;
    if (d > maxDelta) return cur + maxDelta;
    if (d < -maxDelta) return cur - maxDelta;
    return target;
  }

  /** Recompute every display-unit field from the metric primaries. */
  function refreshDisplay(groundHeight) {
    state.airspeedKts = state.airspeedMs * MS_TO_KTS;
    const rho = airDensity(state.position.y);
    state.indicatedAirspeedKts =
      state.airspeedMs * Math.sqrt(rho / RHO_SEA_LEVEL) * MS_TO_KTS;
    state.groundSpeedKts =
      Math.sqrt(
        state.velocity.x * state.velocity.x + state.velocity.z * state.velocity.z,
      ) * MS_TO_KTS;
    // Both altitudes are referenced to the wheels — see ALT_DATUM_M.
    const wheelY = state.position.y - ALT_DATUM_M;
    state.altitudeFt = wheelY * M_TO_FT;
    state.altitudeAglFt = (wheelY - groundHeight) * M_TO_FT;
    state.verticalSpeedMs = state.velocity.y;
    state.verticalSpeedFpm = state.velocity.y * MS_TO_FPM;
    state.alphaDeg = state.alphaRad * RAD_TO_DEG;
    state.betaDeg = state.betaRad * RAD_TO_DEG;

    localToLl(state.position.x, state.position.z, _ll);
    state.lat = _ll.lat;
    state.lon = _ll.lon;

    _tmpEuler.setFromQuaternion(state.orientation, 'YXZ');
    state.headingDeg = wrapDeg(-_tmpEuler.y * RAD_TO_DEG);
    state.pitchDeg = _tmpEuler.x * RAD_TO_DEG;
    state.rollDeg = -_tmpEuler.z * RAD_TO_DEG;
  }

  /**
   * Place the aircraft at a real-world position.
   *
   * All three arguments are optional; each falls back to the corresponding
   * `start*` option, so a bare reset() returns to the configured spawn. That
   * keeps main.js's "press R to reset" working while letting a UI teleport the
   * aircraft to any field.
   *
   * Vertical placement uses `groundHeightFn`, so the aircraft lands on the
   * wheels at the real field elevation rather than at an assumed altitude, and
   * it is pre-squatted by the static spring deflection so it does not visibly
   * settle on the first frame.
   *
   * A fourth, OPTIONAL argument places the aircraft in the air. It is additive
   * to MODULES.md §2.10 and every field is optional; omit it and behaviour is
   * exactly what it was. It exists because a location picker has to be able to
   * say "3,400 m beside Mount Rainier at 110 kt" without knowing where the
   * scene origin is, and re-creating the flight model to do that would throw
   * away the state object every other module is holding a reference to.
   *
   * `altitudeMslM` wins over `altitudeAglM` when both are given, and is
   * clamped so it can never place the aircraft underground.
   *
   * @param {number} [lat] degrees
   * @param {number} [lon] degrees
   * @param {number} [headingDeg] TRUE heading, 0..360
   * @param {{altitudeAglM?:number, altitudeMslM?:number, airspeedMs?:number}} [placement]
   */
  function reset(lat, lon, headingDeg, placement) {
    trimPos = 0;
    inTrim = 0;
    state.trim = 0;
    overGSeconds = 0;
    state.overGSeconds = 0;
    const useLat = Number.isFinite(lat) ? lat : cfg.startLat;
    const useLon = Number.isFinite(lon) ? lon : cfg.startLon;
    const useHdg = Number.isFinite(headingDeg) ? headingDeg : cfg.startHeadingDeg;

    llToLocal(useLat, useLon, _local);
    const ground = groundHeightFn(_local.x, _local.z);
    let agl = Math.max(0, cfg.startAltitudeAglM);
    let speed = Math.max(0, cfg.startAirspeedMs);
    if (placement) {
      if (Number.isFinite(placement.altitudeAglM)) {
        agl = Math.max(0, placement.altitudeAglM);
      }
      if (Number.isFinite(placement.altitudeMslM)) {
        // The ground below may be higher than the requested MSL — over the
        // Cascades that is easy to ask for by accident. Never spawn inside a
        // mountain; 30 m is one wingspan of daylight.
        agl = Math.max(30, placement.altitudeMslM - ground);
      }
      if (Number.isFinite(placement.airspeedMs)) speed = Math.max(0, placement.airspeedMs);
    }
    state.position.set(
      _local.x,
      ground + GEAR_H + agl - (agl > 0 ? 0 : STATIC_SQUAT),
      _local.z,
    );

    // Heading is a rotation about world +Y. Heading 0 must point the nose at
    // -Z, which is the identity orientation, so heading maps to -yaw.
    state.orientation.setFromEuler(_euler.set(0, -useHdg * DEG_TO_RAD, 0, 'YXZ'));
    state.angularVelocity.set(0, 0, 0);
    state.airspeedMs = speed;
    state.alphaRad = 0;
    state.betaRad = 0;

    _fwd.set(0, 0, -1).applyQuaternion(state.orientation);
    state.velocity.copy(_fwd).multiplyScalar(state.airspeedMs).add(_wind);

    state.stalled = false;
    state.stallWarning = false;
    state.separation = 0;
    state.loadFactor = 1;
    state.onGround = agl <= 0;
    // reset() is the ONLY thing that clears a crash. Nothing in step() ever
    // un-crashes the aeroplane, which is what makes `crashed` a latch rather
    // than a flicker the HUD has to debounce.
    state.crashed = false;
    state.crashReason = '';
    state.crashDetail = '';
    state.impactSpeedMs = 0;
    state.impactLoadFactor = 0;
    state.overspeed = false;
    state.gearBottomed = false;
    state.gearStrokeMaxM = 0;
    overspeedTime = 0;
    pendingValid = false;
    state.rpm = cfg.idleRpm;
    state.thrustN = 0;
    state.gearCompressionM = 0;

    surfPitch = 0;
    surfRoll = 0;
    surfYaw = 0;
    flapPos = 0;
    // An airborne spawn starts with the engine already making cruise power.
    // Spooling up from zero at 3,000 ft means the aeroplane appears in a
    // descent, which reads as a bug rather than as a glider start.
    engineSpool = agl > 0 ? 0.7 : 0;
    state.rpm = cfg.idleRpm + engineSpool * (cfg.maxRpm - cfg.idleRpm);
    if (PROPULSION === 'turbofan') {
      state.n1Pct =
        N1_IDLE + (N1_MAX - N1_IDLE) * Math.pow(clamp(engineSpool, 0, 1), 0.35);
      state.rpm = 0;
    } else {
      state.n1Pct = 0;
    }
    state.mach = 0;
    state.flapsPos = 0;
    state.flaps = 0;
    state.brakes = 0;
    accumulator = 0;
    // A teleport must not be interpolated FROM wherever the aeroplane used to
    // be — that would draw it streaking across the map for one frame.
    havePrev = false;
    renderAlpha = 0;
    lastGround = ground;
    flattenContactGround(ground);
    sampleGroundNormal(_local.x, _local.z, ground);
    refreshDisplay(ground);
  }

  /**
   * Advance the simulation by one frame.
   *
   * @param {number} dt Frame delta in SECONDS. Clamped internally to 0.1 s so a
   *                    stalled tab cannot blow the integrator up.
   * @param {{pitch:number, roll:number, yaw:number, throttle:number, flaps:number, brakes:number}} inputs
   *                    pitch/roll/yaw are -1..+1, throttle/flaps/brakes are 0..1.
   * @param {number} groundHeight Terrain elevation in METRES at the aircraft's
   *                    current (x, z). Pass terrain.getHeightAt(x, z). This is
   *                    the REFERENCE sample; the model takes further samples of
   *                    its own through `groundHeightFn` (which must be the same
   *                    sampler) for the four wheels and the surface normal.
   *                    A one-frame spike here is filtered out — see
   *                    acceptGround() — so a DEM void cannot teleport anything.
   * @returns {Object} The same `state` object, for convenience.
   */
  function step(dt, inputs, groundHeight = 0) {
    const frame = clamp(Number.isFinite(dt) ? dt : 0, 0, 0.1);
    // The caller's sample, filtered. A cliff survives this; a one-frame DEM
    // void does not. See acceptGround().
    const gh = acceptGround(groundHeight, frame);
    lastGround = gh;
    // The surface has an ORIENTATION, and everything downstream that has to
    // tell a landing from a collision needs it. Four extra samples per frame.
    sampleGroundNormal(state.position.x, state.position.z, gh);

    // Read inputs field by field — spreading into a fresh object would
    // allocate every frame (MODULES.md §1.8).
    if (inputs) {
      inPitch = clamp(numOr(inputs.pitch, 0), -1, 1);
      inTrim = clamp(numOr(inputs.trim, 0), -1, 1);
      inRoll = clamp(numOr(inputs.roll, 0), -1, 1);
      inYaw = clamp(numOr(inputs.yaw, 0), -1, 1);
      inThrottle = clamp(numOr(inputs.throttle, 0), 0, 1);
      inFlaps = clamp(numOr(inputs.flaps, 0), 0, 1);
      inBrakes = clamp(numOr(inputs.brakes, 0), 0, 1);
    } else {
      inPitch = inRoll = inYaw = inThrottle = inFlaps = inBrakes = 0;
    }

    if (frame === 0) {
      refreshDisplay(gh);
      return state;
    }

    accumulator += frame;
    let n = 0;
    while (accumulator >= FIXED_DT && n < MAX_SUBSTEPS) {
      // Keep the state from BEFORE this substep so the renderer can draw
      // between the two most recent simulated instants. See renderTransform().
      _prevPos.copy(state.position);
      _prevQuat.copy(state.orientation);
      havePrev = true;
      integrate(FIXED_DT, gh);
      accumulator -= FIXED_DT;
      n++;
    }
    // Spiral-of-death guard: if we hit the cap the machine is behind, and
    // hoarding the backlog only makes the next frame worse. Drop it.
    if (n >= MAX_SUBSTEPS) accumulator = 0;

    // Leftover time that has NOT been simulated, as a fraction of a substep.
    renderAlpha = accumulator / FIXED_DT;

    refreshDisplay(gh);
    return state;
  }

  function numOr(v, d) {
    return typeof v === 'number' && Number.isFinite(v) ? v : d;
  }

  reset();

  /**
   * The pose to DRAW this frame, interpolated between the last two substeps.
   *
   * Cosmetic only: nothing in the physics reads it, and `state.position` is
   * still the authoritative simulated pose. Callers that need truth — the
   * ground sampler, the autopilot, any harness — must keep using `state`.
   *
   * @param {THREE.Vector3} outPos
   * @param {THREE.Quaternion} outQuat
   */
  function renderTransform(outPos, outQuat) {
    if (!havePrev) {
      outPos.copy(state.position);
      outQuat.copy(state.orientation);
      return;
    }
    const a = renderAlpha < 0 ? 0 : renderAlpha > 1 ? 1 : renderAlpha;
    outPos.copy(_prevPos).lerp(state.position, a);
    outQuat.copy(_prevQuat).slerp(state.orientation, a);
  }

  return { state, config, step, reset, renderTransform };
}

/* ---------------------------------------------------------------------------
 * ENVELOPE
 *
 * An envelope belongs to an AEROPLANE, not to an integrator, so the derived
 * arithmetic and the measured flight-test numbers now sit at the bottom of the
 * airframe file they describe — see the ENVELOPE block in
 * src/physics/airframes/c172.js for the C172's, which is what this module
 * produces when called with no arguments.
 *
 * The way to prove any airframe is `node scripts/flight-envelope.mjs`, which
 * takes off, climbs, cruises, stalls and lands the model and prints what
 * happened. Re-run it after any change to this file — a change here changes
 * every aeroplane at once, which is precisely why the numbers do not live here.
 * ------------------------------------------------------------------------- */
