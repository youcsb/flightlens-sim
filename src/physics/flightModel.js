/**
 * flightModel.js — the flight dynamics model. The single owner of aircraft state.
 *
 * A six-degree-of-freedom rigid-body model of a Cessna/Cub-class light single.
 * Forces and moments come from real aerodynamics — dynamic pressure, a lift
 * curve with a genuine stall break, induced + parasite drag, ISA air density,
 * a propeller power/thrust curve — and from four sprung landing-gear contact
 * points that carry weight, roll, brake and steer. Nothing here is a rate
 * table: the aircraft flies because the sum of forces says so.
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
 *  @property {number} [maxSpeedMs]       Advisory Vne, m/s. Default 85 (~165 kt).
 *  @property {number} [stallSpeedMs]     CLEAN 1-g stall speed. Sets CLmax. Default 25 (~48.6 kt).
 *  @property {number} [idleRpm]          Default 700.
 *  @property {number} [maxRpm]           Default 2700.
 *  --- additive, all optional, sensible C172-class defaults ---
 *  @property {number} [wingSpanM]        Default 11.0 -> aspect ratio 7.47.
 *  @property {number} [fuselageLengthM]  Default 8.28, used only for inertia scaling.
 *  @property {number} [maxPowerW]        Shaft power at sea level. Default 132000 (177 hp).
 *  @property {number} [propEfficiency]   Default 0.85.
 *  @property {number} [staticThrustN]    Sea-level full-power static thrust. Default 2650.
 *  @property {number} [cd0]              Zero-lift drag coefficient. Default 0.034.
 *  @property {number} [oswald]           Span efficiency. Default 0.80.
 *  @property {number} [inertiaRollKgM2]  Default 1285 * mass/1100.
 *  @property {number} [inertiaPitchKgM2] Default 1825 * mass/1100.
 *  @property {number} [inertiaYawKgM2]   Default 2667 * mass/1100.
 *  @property {number} [windEastMs]       Steady wind, m/s toward east. Default 0.
 *  @property {number} [windNorthMs]      Steady wind, m/s toward north. Default 0.
 *  @property {boolean} [crashEnabled]    Terrain is SOLID and the airframe can be
 *           destroyed. Default true. Set false only for a harness that wants to
 *           measure something past the point where the aeroplane would break.
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

  wingSpanM: 11.0,
  fuselageLengthM: 8.28,
  maxPowerW: 132000,
  propEfficiency: 0.85,
  staticThrustN: 2650,
  cd0: 0.034,
  oswald: 0.8,
  inertiaRollKgM2: 0,
  inertiaPitchKgM2: 0,
  inertiaYawKgM2: 0,
  windEastMs: 0,
  windNorthMs: 0,
  crashEnabled: true,
};

// ---------------------------------------------------------------------------
// Fixed integration
// ---------------------------------------------------------------------------
/** Physics substep, seconds. Chosen for the gear springs, not the aerodynamics. */
const FIXED_DT = 1 / 240;
/** dt is clamped to 0.1 s (contract), so 24 substeps covers it; 32 is headroom. */
const MAX_SUBSTEPS = 32;

// ---------------------------------------------------------------------------
// Airframe aerodynamics — C172-class stability derivatives, per RADIAN.
// Sourced from the standard Roskam/JSBSim Cessna 172 dataset and then trimmed
// against the target envelope (see the ENVELOPE block at the bottom of this
// file for the arithmetic these were checked against).
// ---------------------------------------------------------------------------
const CL0 = 0.25; // lift coefficient at zero geometric alpha (cambered wing + incidence)
const ALPHA_SOFT = 3 * DEG_TO_RAD; // width of the rounded-over top of the lift curve
const STALL_BREAK = 0.06; // rad; e-folding width of the post-stall collapse
const CL_FLATPLATE = 1.05; // fully separated wing behaves like a flat plate
const CD_SEPARATED = 1.6; // drag multiplier for a fully separated wing
const CD_BETA = 0.55; // parasite drag per radian^2 of sideslip — slipping costs energy
const NEG_STALL_SCALE = 0.88; // a cambered wing stalls sooner inverted

const CL_Q = 3.9; // lift from pitch rate
const CL_DE = 0.43; // lift from elevator

const CM0 = 0.05; // sets the hands-off trim speed (~91 kt at gross)
const CM_ALPHA = -1.1; // longitudinal static stability
const CM_Q = -12.4; // pitch damping
const CM_DE = -1.28; // elevator power
const CM_FLAP = -0.12; // flaps pitch the nose down
const CM_STALL = -0.28; // centre of pressure marches aft when the wing lets go

const CY_BETA = -0.31;
const CY_DR = 0.187;

const CROLL_BETA = -0.089; // dihedral effect: sideslip rolls you out of it
const CROLL_P = -0.47; // roll damping
const CROLL_R = 0.096; // yaw rate rolls the aircraft (roll-yaw coupling)
const CROLL_DA = 0.229; // aileron power
const CROLL_DR = -0.0147; // right rudder rolls right (direct term)
const CROLL_STALL = 0.02; // asymmetric separation -> wing drop

const CN_BETA = 0.065; // weathercock stability
const CN_P = -0.03; // roll rate yaws adversely
const CN_R = -0.099; // yaw damping
const CN_DA = -0.014; // ADVERSE YAW — right aileron yaws left
const CN_DR = -0.072; // rudder power

/** Maximum control-surface travel, radians. */
const DE_MAX = 0.42; // elevator, 24 deg
const DA_MAX = 0.35; // aileron, 20 deg
const DR_MAX = 0.4; // rudder, 23 deg

/** Control surfaces have mass; the stick is not the surface. rad/s at full travel. */
const SURFACE_RATE = 4.0;

/** Flap system. */
const FLAP_TRAVEL_RATE = 0.2; // full travel in 5 s
const FLAP_DCL0 = 0.72; // lift-curve shift at full flap
const FLAP_DCLMAX = 0.62; // CLmax increase at full flap
const FLAP_DCD = 0.065; // parasite drag at full flap
const VFE_MS = 43.7; // 85 kt: flaps blow back above this

/**
 * Propeller / engine.
 *
 * Thrust is  T(V) = P * eta / (V^3 + knee^3)^(1/3),  with `knee` solved so that
 * T(0) is the configured static thrust. The cube, not a square root, and not
 * the naive P/V: P/V is singular at rest, and a sqrt blend sags so hard through
 * 40 m/s that the climb rate came out at 407 fpm against a book 730 — measured.
 * The cube holds thrust near-flat through the takeoff roll (which is what a
 * real fixed-pitch prop does) and still rolls it off by cruise. cd0 is then
 * what sets the top end: 0.034 rather than the 0.029 a clean C172 shows, which
 * lands Vmax at a measured 126.6 kt. This airframe is drag-limited on top end
 * and thrust-rich down low, exactly like the real one.
 */
const THRUST_KNEE_MS = 37.5; // legacy reference; the real knee is derived below
const WINDMILL_RPM_PER_MS = 22; // a stopped throttle still turns the prop
const WINDMILL_CD0 = 0.006; // a windmilling prop is a disc of drag
const SLIPSTREAM_ARM_M = 0.26; // propwash over the fin -> left yaw under power
const TORQUE_ARM_M = 0.12; // engine torque -> left roll under power

/** Ground effect: induced drag falls within a wingspan of the surface. */
const GROUND_EFFECT_K = 16; // McCormick's (16 h/b)^2 / (1 + (16 h/b)^2)

/**
 * Landing gear. Body-frame offsets in metres with `y` measured UP from the
 * wheel plane (so the actual body offset is y - gearHeightM), +X right,
 * -Z forward.
 *
 * Four points, not one: a single contact point cannot know the difference
 * between sitting on the mains and sitting on the nosewheel, which is exactly
 * the difference between a takeoff roll that needs speed and one that does not.
 * The mains sit 0.30 m AFT of the CG and the nosewheel 1.10 m forward, so the
 * static nose load is W * 0.3/1.4 and the elevator has to beat it before the
 * nose will come up. It cannot do that below about 33 kt.
 */
const CONTACTS = [
  {
    name: 'nose',
    x: 0, y: 0, z: -1.1,
    k: 26000, c: 3000,
    steer: true, brake: false,
    muRoll: 0.025, muSide: 0.75,
    vRefLong: 0.35, vRefSide: 0.25,
  },
  {
    name: 'left',
    x: -1.3, y: 0.02, z: 0.3,
    k: 42000, c: 4700,
    steer: false, brake: true,
    muRoll: 0.022, muSide: 0.95,
    vRefLong: 0.3, vRefSide: 0.25,
  },
  {
    name: 'right',
    x: 1.3, y: 0.02, z: 0.3,
    k: 42000, c: 4700,
    steer: false, brake: true,
    muRoll: 0.022, muSide: 0.95,
    vRefLong: 0.3, vRefSide: 0.25,
  },
  {
    // Tail tie-down. Not a wheel — it is the over-rotation limit. Contacts at
    // roughly 12 deg nose-up, which is what stops "full aft stick at walking
    // pace" from levitating the aeroplane.
    name: 'tail',
    x: 0, y: 0.6, z: 3.0,
    k: 45000, c: 5000,
    steer: false, brake: false,
    muRoll: 0.55, muSide: 0.55,
    vRefLong: 0.4, vRefSide: 0.4,
  },
];

const MU_BRAKE = 0.55;
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
 * The three numbers that decide whether a contact is a landing or a crash:
 *
 *   GEAR_STROKE_M      how far a leg can travel before it bottoms out. Measured
 *                      against the model's own hard-landing test: a 700 fpm
 *                      arrival — already 4.8 g and the worst case the envelope
 *                      script calls survivable — peaks at 25 cm on a main. 40 cm
 *                      leaves margin over that and is still far less than the
 *                      1.2 m of datum clearance, so "bottomed" always means the
 *                      leg is fully compressed and never means "firm".
 *
 *   CRASH_CLOSING_MS   closing speed ALONG THE LOCAL SURFACE NORMAL at the
 *                      moment the leg bottoms. 5 m/s is 984 fpm straight down —
 *                      well past the 600 fpm (10 fps) ultimate design sink of a
 *                      light single's gear, and the reason it is measured along
 *                      the NORMAL rather than along world-down is that this is
 *                      what makes a cliff face solid: fly level at 60 m/s into
 *                      ground whose normal is horizontal and the closing speed
 *                      is 60 m/s, not 0.
 *
 *   CRASH_LOAD_G       airframe ultimate load factor. A C172 is +3.8 g limit,
 *                      x1.5 = 5.7 g ultimate. 6 g, magnitude, either sign.
 *
 * The normal is real, not assumed: sampleGroundNormal() probes the SAME height
 * field the wheels roll on, four samples in a cross, once per frame.
 */
const GEAR_STROKE_M = 0.4;
const CRASH_CLOSING_MS = 5.0;
const CRASH_LOAD_G = 6.0;
/**
 * Structural failure speed, as a multiple of Vne (indicated). 1.3 x 165 kt =
 * 214 kt IAS. Below it the airframe merely complains (`state.overspeed`);
 * at it the wing comes off. Chosen so the model's own display-field check,
 * which deliberately parks the aeroplane at 180 KIAS, still runs.
 */
const OVERSPEED_BREAK = 1.3;
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
 * Nosewheel steering. 10 deg is the real pedal-linked travel on a C172 (tighter
 * turns come from differential braking, which this model does not have), and it
 * is not a comfort choice: the tyre model is geometrically honest, so a 1.7 m
 * wheelbase at 30 deg of nosewheel gives a 2.9 m turn radius and the aeroplane
 * pirouettes. Measured with 30 deg: a mere 0.15 of pedal held through the
 * takeoff roll swung the heading 250 deg. Real pilots use about a degree; a
 * keyboard gives you all of it or none.
 *
 * ---------------------------------------------------------------------------
 * WHY THE FADE IS 1/V^1.5 AND NOT LINEAR
 * ---------------------------------------------------------------------------
 * Reducing STEER_MAX to 10 deg was necessary but not sufficient, because the
 * problem is the SHAPE of the fade, not its endpoint. A steering angle delta
 * held at ground speed V yields a yaw rate of roughly V*tan(delta)/wheelbase —
 * so a fade that decays SLOWER than 1/V hands the pilot MORE yaw authority the
 * faster they go, which is precisely backwards and is what made the takeoff
 * roll uncontrollable.
 *
 * Measured on the old linear fade (gain = 1 - (V-3)/25, floor 0.15):
 *
 *   no rudder at all        KBFI 32L, heading 330 -> 305 by 39 kt, off the
 *                           runway every time (slipstream, ~2.5 deg/s left)
 *   full right rudder held  heading 330 -> 149 in six seconds, still only
 *                           26 kt: a pirouette on the nosewheel
 *
 * There was no keyboard input in between that held the centreline, because at
 * 20 m/s the old curve still gave 0.32 of 10 deg = 3.3 deg of nosewheel, i.e.
 * a 29 m turn radius at 40 kt.
 *
 * A 1/V law gives constant yaw-rate authority at every speed; V_REF/V raised to
 * 1.5 lets it fall off a little faster still, which leaves full deflection for
 * taxiing and almost none for the roll. Resulting full-pedal authority:
 *
 *   3 m/s  (taxi)   10 deg    ~30 deg/s   tight enough to turn onto a runway
 *   10 m/s (20 kt)  1.6 deg   ~10 deg/s
 *   20 m/s (39 kt)  0.6 deg   ~7 deg/s    against 2.5 deg/s of slipstream
 *
 * That ratio — roughly 3x the disturbance — is what makes the centreline
 * holdable with partial pedal instead of being a choice between two failures.
 * The AERODYNAMIC rudder is untouched by any of this; it is a separate moment
 * (cN) and keeps full authority for slips and crosswind landings.
 */
const STEER_MAX = 0.18; // 10 deg
/** Ground speed below which full pedal means full nosewheel, m/s. */
const STEER_REF_MS = 3;
/** Exponent on the V_REF/V fade. 1.0 = constant yaw-rate authority. */
const STEER_FADE_EXP = 1.5;
/** Never quite zero, so there is still a nudge available at speed. */
const STEER_FLOOR = 0.02;

/**
 * @param {FlightModelOpts} [opts]
 * @returns {{ state: Object, config: Object, step: (dt: number, inputs: Object, groundHeight: number) => Object, reset: (lat?: number, lon?: number, headingDeg?: number) => void }}
 */
export function createFlightModel(opts = {}) {
  const cfg = { ...DEFAULTS, ...opts };
  const hasGroundFn = typeof cfg.groundHeightFn === 'function';
  const groundHeightFn = hasGroundFn ? cfg.groundHeightFn : () => 0;

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
  /** Finite-wing lift-curve slope, Helmbold. ~4.96 /rad for AR 7.47. */
  const CL_ALPHA = (2 * Math.PI) / (1 + 2 / AR);

  /**
   * CLmax is DERIVED from the configured clean stall speed, so `stallSpeedMs`
   * is a real knob rather than decoration. 25 m/s at gross gives CLmax 1.74,
   * i.e. Vs1 = 48.6 kt — the C172's book number. Full flap adds FLAP_DCLMAX,
   * which brings Vs0 to about 41.7 kt: "stall ~40 kt", honestly arrived at.
   */
  const CL_MAX = clamp(
    WEIGHT /
      (0.5 * RHO_SEA_LEVEL * cfg.stallSpeedMs * cfg.stallSpeedMs * S_WING),
    0.9,
    2.4,
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
  /**
   * Height of the wing above the datum, metres. Ground effect is a function of
   * how far the WING is from the surface, not how far the CG is: measuring at
   * the datum puts the wing a metre lower than it is and overstates the
   * induced-drag reduction on the roll-out by roughly a factor of three.
   */
  const WING_HEIGHT_M = 0.96;
  const MAX_N = MAX_N_PER_W * WEIGHT;
  const maxDamp = MAX_DAMP_PER_W * WEIGHT;
  /** Static spring deflection, so reset() can park the aircraft already
   *  settled instead of dropping it 10 cm onto the runway. */
  let kTotal = 0;
  for (let i = 0; i < 3; i++) kTotal += CONTACTS[i].k;
  const STATIC_SQUAT = WEIGHT / kTotal;

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
    /** Propeller/engine speed, REVOLUTIONS PER MINUTE. */
    rpm: 0,
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
  let surfRoll = 0;
  let surfYaw = 0;
  let flapPos = 0;
  /** Lagged engine state, 0..1. Drives thrust AND the rpm needle. */
  let engineSpool = 0;
  // Parsed inputs for the current step(), read by every substep.
  let inPitch = 0;
  let inRoll = 0;
  let inYaw = 0;
  let inThrottle = 0;
  let inFlaps = 0;
  let inBrakes = 0;
  // Integration accumulator and a clock used only for stall-buffet phase.
  let accumulator = 0;
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
   * @param {{cl:number, sep:number}} out
   */
  function liftCurve(aEff, aMaxPos, out) {
    const sign = aEff >= 0 ? 1 : -1;
    const a = aEff >= 0 ? aEff : -aEff;
    const aMax = sign > 0 ? aMaxPos : aMaxPos * NEG_STALL_SCALE;
    const knee = aMax - ALPHA_SOFT;

    if (a <= knee) {
      out.cl = sign * CL_ALPHA * a;
      out.sep = 0;
      return out;
    }
    if (a <= aMax) {
      // Quadratic that matches value and slope at `knee` and flattens at aMax.
      const t = (a - knee) / ALPHA_SOFT;
      out.cl =
        sign * CL_ALPHA * (knee + ALPHA_SOFT * (t - 0.5 * t * t));
      out.sep = 0;
      return out;
    }
    const clPeak = CL_ALPHA * (aMax - 0.5 * ALPHA_SOFT);
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
    const blowBack = clamp(1 - (V - VFE_MS) / 12, 0, 1);
    const flapCmd = Math.min(clamp(inFlaps, 0, 1), blowBack);
    flapPos = moveToward(flapPos, flapCmd, FLAP_TRAVEL_RATE * h);

    // --- lift curve, shifted and stretched by flap ------------------------
    const cl0Eff = CL0 + FLAP_DCL0 * flapPos;
    const alphaZeroLift = -cl0Eff / CL_ALPHA;
    const alphaEffMax =
      (CL_MAX + FLAP_DCLMAX * flapPos) / CL_ALPHA + 0.5 * ALPHA_SOFT;
    const alphaEff = alpha - alphaZeroLift;
    liftCurve(alphaEff, alphaEffMax, _cl);
    const clWing = _cl.cl;
    const sep = _cl.sep;

    // --- engine ------------------------------------------------------------
    // One lagged engine state drives BOTH the rpm gauge and the thrust, so
    // what you hear and what you feel are the same number. Naturally aspirated
    // power lapse with density: P/P0 = (sigma - 0.117) / 0.883.
    engineSpool = damp(engineSpool, inThrottle, 2.5, h);
    const powerLapse = clamp((sigma - 0.117) / 0.883, 0, 1);
    const shaftW = P_MAX * powerLapse * (0.03 + 0.97 * engineSpool);
    const thrust = (shaftW * ETA) / Math.cbrt(V * V * V + THRUST_KNEE3);
    state.thrustN = thrust;

    // rpm: commanded by the same spool state, but the airstream will drive the
    // prop faster than idle on the way down — a glide is not a silent glide.
    const cmdRpm =
      cfg.idleRpm +
      engineSpool * (cfg.maxRpm - cfg.idleRpm) * (0.55 + 0.45 * sigma);
    const windmillRpm = V * WINDMILL_RPM_PER_MS;
    state.rpm = Math.min(
      cfg.maxRpm,
      cmdRpm > windmillRpm ? cmdRpm : windmillRpm,
    );

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
      cfg.cd0 + cdWindmill + FLAP_DCD * flapPos + cdInduced + CD_BETA * beta * beta + cdSep;

    // --- control deflections, radians -------------------------------------
    // Stick +1 pitch = nose up. Elevator TE-down is positive, so pull is
    // negative deflection. Stick +1 yaw = RIGHT rudder, and CN_DR is negative,
    // so right rudder is negative deflection too.
    let de = -surfPitch * DE_MAX;
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
    // by 45 m/s. Not a simplification for its own sake: a real aeroplane's
    // wing rigging and aileron/rudder trim tabs are set to cancel these at
    // cruise, and this model has no trim axis to cancel them with. Applied
    // flat, a constant 170 N.m of torque roll walks the aircraft into a
    // 45-degree left bank over two minutes of hands-off cruise — measured,
    // not hypothetical. Faded, you get what you should: right rudder on the
    // takeoff roll and in the climb, hands off at cruise.
    const propEffect = clamp(1 - V / 45, 0, 1);
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
      if (Math.abs(state.loadFactor) > CRASH_LOAD_G) {
        triggerCrash(
          'overstress',
          `airframe overload — ${state.loadFactor.toFixed(1)} g` +
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

    // --- Vne is not decorative --------------------------------------------
    // Advisory below the break so the HUD can shout; structural above it.
    const iasMs = V * Math.sqrt(sigma);
    state.overspeed = iasMs > VNE_MS;
    if (iasMs > VNE_MS * OVERSPEED_BREAK) {
      overspeedTime += h;
      if (CRASH_ON && overspeedTime > 0.5) {
        triggerCrash(
          'overspeed',
          `structural failure — ${(iasMs * MS_TO_KTS).toFixed(0)} KIAS past a ` +
            `${(VNE_MS * MS_TO_KTS).toFixed(0)} kt Vne`,
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
    state.flapsPos = 0;
    state.flaps = 0;
    state.brakes = 0;
    accumulator = 0;
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
      integrate(FIXED_DT, gh);
      accumulator -= FIXED_DT;
      n++;
    }
    // Spiral-of-death guard: if we hit the cap the machine is behind, and
    // hoarding the backlog only makes the next frame worse. Drop it.
    if (n >= MAX_SUBSTEPS) accumulator = 0;

    refreshDisplay(gh);
    return state;
  }

  function numOr(v, d) {
    return typeof v === 'number' && Number.isFinite(v) ? v : d;
  }

  reset();

  return { state, config, step, reset };
}

/* ---------------------------------------------------------------------------
 * ENVELOPE
 *
 * DERIVED — the arithmetic the constants were chosen against, at gross weight
 * (1100 kg / 10,787 N), sea level, ISA. Re-derive before changing a constant.
 *
 *   CL_ALPHA      4.96 /rad     Helmbold, AR 7.47
 *   CL_MAX        1.74          from stallSpeedMs = 25 m/s
 *   alpha_crit    ~18.7 deg clean (geometric), ~1.1 deg lower at full flap
 *   Vs1 (clean)   25.0 m/s = 48.6 kt
 *   Vs0 (flap)    21.5 m/s = 41.7 kt
 *   Vfe           43.7 m/s = 85 kt (flaps blow back above this)
 *   Vne           85 m/s   = 165 kt (advisory; nothing enforces it)
 *   trim speed    ~47 m/s  = ~91 kt hands off, from CM0 = 0.05
 *
 * MEASURED — none of the above proves the aeroplane flies. These come from
 * `node scripts/flight-envelope.mjs`, which takes off, climbs, cruises, stalls
 * and lands the model and prints what happened. Re-run it after any change
 * here; do not update these numbers by hand.
 *
 *   ground roll        228 m (748 ft), rotates at 55 kt, flies at 57.5 kt
 *   Vy                 80 kt -> 743 fpm  (curve is flat: 75 kt gives 738)
 *   climb at 100 kt    605 fpm           (at 60 kt, 623 fpm)
 *   cruise 75% power   109.6 kt level at 2,000 ft
 *   Vmax level         126.6 kt, full throttle
 *   stall, clean       47.4 KIAS at 18.7 deg alpha, power off, wings level
 *   stall, full flap   41.5 KIAS
 *   accelerated stall  89.0 KIAS at 3.06 g in a 55 deg bank — the break
 *                      follows ANGLE OF ATTACK, not speed
 *   height lost        ~157 ft, break to recovered, unloading promptly
 *   glide ratio        9.0 : 1 power off
 *   hands-off trim     101.9 kt at 65% power, phugoid stays inside 88-112 kt
 *   touchdown loads    1.97 g at 200 fpm, 2.95 g at 400, 4.77 g at 700
 *   frame independence 1.0 m of divergence over 30 s between 20 Hz and 200 Hz
 *
 *   power lapse        59% of rated at Mount Rainier's summit (4,392 m,
 *                      sigma 0.641), and measured climb falls 764 fpm at 300 m
 *                      to 297 fpm at 3,600 m. The service ceiling lands just
 *                      under the summit, which is where a real 172's does. You
 *                      can go and look at the mountain; you cannot fly over the
 *                      top of it. That is the point.
 * ------------------------------------------------------------------------- */
