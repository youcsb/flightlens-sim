/**
 * c172.js — the Cessna 172. Numbers only; no code.
 *
 * This is the DEFAULT airframe of src/physics/flightModel.js and the reference
 * example for every airframe that follows. flightModel.js owns the physics —
 * dynamic pressure, the lift curve's SHAPE, Euler's equations, the gear solver,
 * the crash logic. This file owns the aeroplane: what it weighs, how big its
 * wing is, how hard its elevator pulls, where its wheels are.
 *
 * A second aircraft is a sibling of this file and nothing else. Copy it, change
 * the numbers, and pass it in:
 *
 *     import { B737 } from './airframes/b737.js';
 *     createFlightModel({ airframe: B737, groundHeightFn: terrain.getHeightAt });
 *
 * Every key is optional in a sibling: what you leave out falls back to the
 * value here, group by group, so a new airframe only has to state what is
 * genuinely different. That is a convenience for experiments and a TRAP for a
 * finished aircraft — a jet that silently inherits a Cessna's aileron power is
 * worse than one that fails loudly — so a real airframe should state all of it.
 *
 * UNITS are SI throughout, angles in RADIANS, coefficients PER RADIAN. Where a
 * comment quotes degrees it is quoting the radian value beside it, not a second
 * source of truth: the radians are what the model reads.
 *
 * SOURCES: the standard Roskam / JSBSim Cessna 172 stability-derivative dataset,
 * then trimmed against the measured envelope at the bottom of this file. If you
 * change a number here, re-run `npm run envelope` — that script takes off,
 * climbs, cruises, stalls and lands the model and prints what happened.
 */

import { DEG_TO_RAD } from '../../core/units.js';

export const C172 = {
  /** Human-readable, for a HUD or a type-select menu. Not used by the physics. */
  name: 'Cessna 172',

  // -------------------------------------------------------------------------
  // MASS, GEOMETRY, INERTIA
  // -------------------------------------------------------------------------
  /** All-up mass, kg. */
  massKg: 1100,
  /** Reference wing area, m^2. Everything aerodynamic is normalised by this. */
  wingAreaM2: 16.2,
  /** Wing span, m. Sets aspect ratio (span^2 / area) and therefore the
   *  lift-curve slope, the induced drag, and the ground-effect height. */
  wingSpanM: 11.0,
  /** Fuselage length, m. Used ONLY to scale the default pitch/yaw inertias. */
  fuselageLengthM: 8.28,
  /**
   * Ground clearance of the datum, m — how far the CG sits above the wheels.
   * Also the altimeter's datum offset: both displayed altitudes are taken at
   * the WHEELS, so a parked aeroplane reads field elevation and 0 ft AGL.
   * aircraft/model.js must put its contact patch at the same -1.2 m or the
   * visual wheels will not touch the runway the physics is standing on.
   */
  gearHeightM: 1.2,
  /**
   * Height of the WING above the datum, m. Ground effect is a function of how
   * far the wing is from the surface, not how far the CG is: measuring at the
   * datum puts the wing a metre lower than it is and overstates the
   * induced-drag reduction on the roll-out by roughly a factor of three.
   * High wing, so this is positive and large; a low-wing aircraft's is small
   * or negative.
   */
  wingHeightM: 0.96,
  /**
   * Moments of inertia, kg.m^2, in the AERO axes (roll = about the nose,
   * pitch = about the wing, yaw = about the vertical).
   *
   * Leave any of them 0 and the model scales the C172's own values by mass and
   * by the square of the relevant dimension — 1285 / 1825 / 2667 at 1100 kg,
   * 11.0 m span and 8.28 m fuselage. That extrapolation is fine for a variant
   * of this aeroplane and NOT fine for a different class of aeroplane: a jet
   * should state real numbers, because a 737 is not a Cessna scaled up.
   */
  inertiaRollKgM2: 0,
  inertiaPitchKgM2: 0,
  inertiaYawKgM2: 0,

  // -------------------------------------------------------------------------
  // SPEEDS
  // -------------------------------------------------------------------------
  /** Advisory Vne, m/s TAS-equivalent IAS. 85 m/s = 165 kt. Past it the HUD
   *  shouts; past limits.overspeedBreak x this the wing comes off. */
  maxSpeedMs: 85,
  /**
   * CLEAN 1-g stall speed, m/s. THIS IS THE KNOB THAT SETS CLmax — the model
   * derives CLmax from weight, wing area and this speed rather than taking a
   * coefficient, because a stall speed is a number you can look up in a POH
   * and a CLmax is not. 25 m/s at 1100 kg over 16.2 m^2 gives CLmax 1.74, i.e.
   * Vs1 = 48.6 kt, the book number.
   */
  stallSpeedMs: 25,

  // -------------------------------------------------------------------------
  // DRAG
  // -------------------------------------------------------------------------
  /**
   * Zero-lift drag coefficient. THIS IS WHAT SETS THE TOP END. 0.034 rather
   * than the 0.029 a clean C172 shows, which lands Vmax at a measured
   * 126.6 kt. This airframe is drag-limited on top end and thrust-rich down
   * low, exactly like the real one.
   */
  cd0: 0.034,
  /** Oswald span efficiency. Induced drag is CL^2 / (pi * AR * e). */
  oswald: 0.8,

  // -------------------------------------------------------------------------
  // PROPULSION — sizing. The response curve is in `prop` below.
  // -------------------------------------------------------------------------
  /** Shaft power at sea level, W. 132 kW = 177 hp. */
  maxPowerW: 132000,
  /** Propeller efficiency, 0..1. */
  propEfficiency: 0.85,
  /**
   * Sea-level full-power STATIC thrust, N.
   *
   * Thrust is  T(V) = P * eta / (V^3 + knee^3)^(1/3),  with `knee` solved so
   * that T(0) lands exactly here. The cube, not a square root, and not the
   * naive P/V: P/V is singular at rest, and a sqrt blend sags so hard through
   * 40 m/s that the climb rate came out at 407 fpm against a book 730 —
   * measured. The cube holds thrust near-flat through the takeoff roll (which
   * is what a real fixed-pitch prop does) and still rolls it off by cruise.
   */
  staticThrustN: 2650,
  /** Idle and redline for the rpm needle. */
  idleRpm: 700,
  maxRpm: 2700,

  // -------------------------------------------------------------------------
  // AERODYNAMIC DERIVATIVES — per RADIAN, aero axes (x fwd, y right, z down)
  // -------------------------------------------------------------------------
  aero: {
    /** Lift coefficient at zero geometric alpha (cambered wing + incidence). */
    cl0: 0.25,
    /** Lift from pitch rate. */
    clQ: 3.9,
    /** Lift from elevator. */
    clDe: 0.43,

    /**
     * Pitching moment at zero alpha. THIS SETS THE HANDS-OFF TRIM SPEED —
     * 0.05 puts it at about 91 kt at gross. It is the single most
     * consequential number in this block for how the aeroplane feels, because
     * everything else in pitch is a response and this is the bias.
     */
    cm0: 0.05,
    /** Longitudinal static stability. Negative = stable; more negative = stiffer
     *  in pitch and slower to respond. */
    cmAlpha: -1.1,
    /** Pitch damping. */
    cmQ: -12.4,
    /** Elevator power. */
    cmDe: -1.28,
    /** Flaps pitch the nose down. */
    cmFlap: -0.12,
    /** Centre of pressure marches aft when the wing lets go. */
    cmStall: -0.28,

    /** Side force from sideslip and from rudder. */
    cyBeta: -0.31,
    cyDr: 0.187,

    /** Dihedral effect: sideslip rolls you out of it. */
    crollBeta: -0.089,
    /** Roll damping. */
    crollP: -0.47,
    /** Yaw rate rolls the aircraft (roll-yaw coupling). */
    crollR: 0.096,
    /** Aileron power. */
    crollDa: 0.229,
    /** Right rudder rolls right (direct term). */
    crollDr: -0.0147,
    /** Asymmetric separation -> wing drop at the stall. */
    crollStall: 0.02,

    /** Weathercock stability. */
    cnBeta: 0.065,
    /** Roll rate yaws adversely. */
    cnP: -0.03,
    /** Yaw damping. */
    cnR: -0.099,
    /** ADVERSE YAW — right aileron yaws left. */
    cnDa: -0.014,
    /** Rudder power. */
    cnDr: -0.072,

    /** Parasite drag per radian^2 of sideslip — slipping costs energy. A
     *  slab-sided light single is draggier in the slip than a clean jet. */
    cdBeta: 0.55,

    /**
     * STALL SHAPE. The model owns the three-region lift curve (linear, a
     * rounded-over top, then an exponential collapse toward flat plate); these
     * two numbers are the wing's contribution to it, and they are what makes a
     * gentle Hershey-bar wing feel different from a sharp swept one.
     */
    /** Width of the rounded-over top of the lift curve, radians. Wider = more
     *  warning, a mushier approach to the break. */
    alphaSoftRad: 3 * DEG_TO_RAD,
    /** e-folding width of the post-stall collapse, radians. Smaller = sharper
     *  break. */
    stallBreakRad: 0.06,
    /** A cambered wing stalls sooner inverted: negative-side critical alpha as
     *  a fraction of the positive side. */
    negStallScale: 0.88,

    /**
     * Ground effect: induced drag falls within a wingspan of the surface.
     * McCormick's (k h/b)^2 / (1 + (k h/b)^2), with h measured at the wing.
     */
    groundEffectK: 16,
  },

  // -------------------------------------------------------------------------
  // CONTROL SURFACES
  // -------------------------------------------------------------------------
  controls: {
    /** Maximum control-surface travel, RADIANS. Stated in radians rather than
     *  derived from degrees because these are the values the derivatives above
     *  were trimmed against. 0.42 / 0.35 / 0.40 rad = 24 / 20 / 23 deg. */
    deMaxRad: 0.42,
    daMaxRad: 0.35,
    drMaxRad: 0.4,

    /** Control surfaces have mass; the stick is not the surface. Fractions of
     *  full travel per second — 4.0 means a quarter-second stop to stop. */
    surfaceRate: 4.0,

    /**
     * ELEVATOR TRIM.
     *
     * Without a trim axis this aeroplane is permanently rigged for one speed.
     * cm0 = 0.05 puts that at about 91 kt hands-off, so anywhere else the
     * stick has to be held — which is why level flight drifts, and why the
     * autopilot needed an integrator "standing in for the trim the airframe
     * does not have". This is that trim.
     *
     * MODELLED AS A BIAS ON THE ELEVATOR, which is what a trim tab physically
     * does: it moves the deflection the surface sits at with no stick force,
     * so the aeroplane holds a different speed hands-off.
     *
     * AUTHORITY is 35% of full elevator travel, not 100%. A real trim tab
     * cannot fly the aeroplane on its own, and full-travel trim would let a
     * player hold the stick against a trim that can out-pull them — which is a
     * way to make a simulator feel broken. 35% covers roughly 55 kt to 130 kt
     * hands-off, the whole speed range this aircraft actually flies. An
     * airframe with a wider speed range needs more; one with a stronger
     * elevator needs less.
     *
     * RATE is deliberately slow. A trim wheel is a wheel: 8 seconds end to end
     * means a tap is a fine adjustment rather than a lurch, which is the
     * entire point of trimming instead of just holding the stick.
     */
    trimAuthority: 0.35,
    trimRate: 1 / 8,
  },

  // -------------------------------------------------------------------------
  // FLAPS
  // -------------------------------------------------------------------------
  flaps: {
    /** Fraction of full travel per second. 0.2 = full travel in 5 s. */
    travelRate: 0.2,
    /** Lift-curve shift at full flap (moves the zero-lift line). */
    dCl0: 0.72,
    /** CLmax increase at full flap. With CLmax 1.74 clean this brings Vs0 to
     *  about 41.7 kt: "stall ~40 kt", honestly arrived at. */
    dClMax: 0.62,
    /** Parasite drag at full flap. */
    dCd: 0.065,
    /** Vfe, m/s: flaps blow back above this. 43.7 m/s = 85 kt. The blow-back
     *  is a ramp, fully retracted 12 m/s above Vfe. */
    vfeMs: 43.7,
  },

  // -------------------------------------------------------------------------
  // PROPULSION — response and the asymmetries a propeller brings with it
  // -------------------------------------------------------------------------
  prop: {
    /**
     * Engine spool lag, per second, as an exponential rate constant. 2.5 is a
     * naturally aspirated piston: throttle to power in a fraction of a second.
     * A turbofan is FAR slower and a jet airframe must say so.
     */
    spoolRate: 2.5,
    /** A stopped throttle still turns the prop: rpm per m/s of airspeed. A
     *  glide is not a silent glide. Zero for a jet. */
    windmillRpmPerMs: 22,
    /** A windmilling prop is a disc of drag: cd0 added at closed throttle. */
    windmillCd0: 0.006,
    /**
     * SINGLE-ENGINE PROPELLER ASYMMETRY. Both are ZERO for a jet, for a twin,
     * and for anything with contra-rotating props.
     *
     * slipstreamArmM: propwash spirals onto the fin -> left yaw under power.
     *                 This is why a real single needs right rudder on the
     *                 takeoff roll and in the climb.
     * torqueArmM:     engine torque -> left roll under power.
     *
     * Both are moment arms in metres, multiplied by thrust.
     */
    slipstreamArmM: 0.26,
    torqueArmM: 0.12,
    /**
     * Speed, m/s, at which both of the above have faded to nothing.
     *
     * Not a simplification for its own sake: a real aeroplane's wing rigging
     * and aileron/rudder trim tabs are set to cancel these at cruise, and this
     * model has no lateral trim axis to cancel them with. Applied flat, a
     * constant 170 N.m of torque roll walks the aircraft into a 45-degree left
     * bank over two minutes of hands-off cruise — measured, not hypothetical.
     * Faded, you get what you should: right rudder on the takeoff roll and in
     * the climb, hands off at cruise.
     */
    effectFadeMs: 45,
  },

  // -------------------------------------------------------------------------
  // LANDING GEAR AND GROUND HANDLING
  // -------------------------------------------------------------------------
  gear: {
    /**
     * Contact points. Body-frame offsets in metres with `y` measured UP from
     * the wheel plane (so the actual body offset is y - gearHeightM), +X right,
     * -Z forward.
     *
     * Four points, not one: a single contact point cannot know the difference
     * between sitting on the mains and sitting on the nosewheel, which is
     * exactly the difference between a takeoff roll that needs speed and one
     * that does not. The mains sit 0.30 m AFT of the CG and the nosewheel
     * 1.10 m forward, so the static nose load is W * 0.3/1.4 and the elevator
     * has to beat it before the nose will come up. It cannot do that below
     * about 33 kt.
     *
     * Per-point fields:
     *   k, c        spring rate N/m and damping N/(m/s)
     *   bearing     carries static weight when parked. Used to pre-squat the
     *               springs at reset() so the aeroplane does not visibly
     *               settle on the first frame. TRUE for the wheels it stands
     *               on, FALSE for tail skids and wingtip bumpers.
     *   steer       follows the nosewheel steering angle
     *   brake       muRoll rises toward muBrake with the brake input
     *   muRoll      rolling resistance along the wheel plane
     *   muSide      cornering friction across it
     *   vRefLong/Side  slip speed, m/s, at which the tanh friction curve is
     *               at ~76% of its limit. Small = grippy and stiff.
     *
     * The model has no opinion about how many points there are — add or remove
     * entries freely. A 737 wants a nose leg, four main contact patches and a
     * tail-strike point.
     */
    contacts: [
      {
        name: 'nose',
        x: 0, y: 0, z: -1.1,
        k: 26000, c: 3000,
        bearing: true,
        steer: true, brake: false,
        muRoll: 0.025, muSide: 0.75,
        vRefLong: 0.35, vRefSide: 0.25,
      },
      {
        name: 'left',
        x: -1.3, y: 0.02, z: 0.3,
        k: 42000, c: 4700,
        bearing: true,
        steer: false, brake: true,
        muRoll: 0.022, muSide: 0.95,
        vRefLong: 0.3, vRefSide: 0.25,
      },
      {
        name: 'right',
        x: 1.3, y: 0.02, z: 0.3,
        k: 42000, c: 4700,
        bearing: true,
        steer: false, brake: true,
        muRoll: 0.022, muSide: 0.95,
        vRefLong: 0.3, vRefSide: 0.25,
      },
      {
        // Tail tie-down. Not a wheel — it is the over-rotation limit. Contacts
        // at roughly 12 deg nose-up, which is what stops "full aft stick at
        // walking pace" from levitating the aeroplane. `bearing: false`: it
        // does not carry weight on the ground, so it takes no part in the
        // static squat.
        name: 'tail',
        x: 0, y: 0.6, z: 3.0,
        k: 45000, c: 5000,
        bearing: false,
        steer: false, brake: false,
        muRoll: 0.55, muSide: 0.55,
        vRefLong: 0.4, vRefSide: 0.4,
      },
    ],

    /**
     * How far a leg can travel before it bottoms out, m. A gear leg is a
     * SPRING WITH A STOP; past the stop it is not a spring any more, it is
     * structure, and structure fails — see the SOLIDITY block in
     * flightModel.js for what the model does about that.
     *
     * Measured against the model's own hard-landing test: a 700 fpm arrival —
     * already 4.8 g and the worst case the envelope script calls survivable —
     * peaks at 25 cm on a main. 40 cm leaves margin over that and is still far
     * less than the 1.2 m of datum clearance, so "bottomed" always means the
     * leg is fully compressed and never means "firm".
     */
    strokeM: 0.4,

    /** Braked rolling friction at full brake. muRoll rises to this on any
     *  contact flagged `brake`. */
    muBrake: 0.55,

    /**
     * NOSEWHEEL STEERING.
     *
     * steerMaxRad — 0.18 rad is the real pedal-linked travel on a C172
     * (tighter turns come from differential braking, which this model does not
     * have), and it is not a comfort choice: the tyre model is geometrically
     * honest, so a 1.7 m wheelbase at 30 deg of nosewheel gives a 2.9 m turn
     * radius and the aeroplane pirouettes. Measured with 30 deg: a mere 0.15
     * of pedal held through the takeoff roll swung the heading 250 deg. Real
     * pilots use about a degree; a keyboard gives you all of it or none.
     *
     * -----------------------------------------------------------------------
     * WHY THE FADE IS 1/V^1.5 AND NOT LINEAR
     * -----------------------------------------------------------------------
     * Reducing steerMaxRad was necessary but not sufficient, because the
     * problem is the SHAPE of the fade, not its endpoint. A steering angle
     * delta held at ground speed V yields a yaw rate of roughly
     * V*tan(delta)/wheelbase — so a fade that decays SLOWER than 1/V hands the
     * pilot MORE yaw authority the faster they go, which is precisely
     * backwards and is what made the takeoff roll uncontrollable.
     *
     * Measured on the old linear fade (gain = 1 - (V-3)/25, floor 0.15):
     *
     *   no rudder at all        KBFI 32L, heading 330 -> 305 by 39 kt, off the
     *                           runway every time (slipstream, ~2.5 deg/s left)
     *   full right rudder held  heading 330 -> 149 in six seconds, still only
     *                           26 kt: a pirouette on the nosewheel
     *
     * There was no keyboard input in between that held the centreline, because
     * at 20 m/s the old curve still gave 0.32 of 10 deg = 3.3 deg of
     * nosewheel, i.e. a 29 m turn radius at 40 kt.
     *
     * A 1/V law gives constant yaw-rate authority at every speed; steerRefMs/V
     * raised to steerFadeExp = 1.5 lets it fall off a little faster still,
     * which leaves full deflection for taxiing and almost none for the roll.
     * Resulting full-pedal authority:
     *
     *   3 m/s  (taxi)   10 deg    ~30 deg/s   tight enough to turn onto a runway
     *   10 m/s (20 kt)  1.6 deg   ~10 deg/s
     *   20 m/s (39 kt)  0.6 deg   ~7 deg/s    against 2.5 deg/s of slipstream
     *
     * That ratio — roughly 3x the disturbance — is what makes the centreline
     * holdable with partial pedal instead of being a choice between two
     * failures. The AERODYNAMIC rudder is untouched by any of this; it is a
     * separate moment (cnDr) and keeps full authority for slips and crosswind
     * landings.
     */
    steerMaxRad: 0.18,
    /** Ground speed below which full pedal means full nosewheel, m/s. */
    steerRefMs: 3,
    /** Exponent on the (steerRefMs / V) fade. 1.0 = constant yaw-rate
     *  authority; higher fades faster. */
    steerFadeExp: 1.5,
    /** Never quite zero, so there is still a nudge available at speed. */
    steerFloor: 0.02,
  },

  // -------------------------------------------------------------------------
  // STRUCTURAL LIMITS
  // -------------------------------------------------------------------------
  limits: {
    /**
     * Airframe ultimate load factor, g, magnitude, either sign. A C172 is
     * +3.8 g limit, x1.5 = 5.7 g ultimate; 6.0 rounds that.
     *
     * WHY THERE ARE TWO LOAD LIMITS, AND WHY ONE OF THEM IS TIMED.
     *
     * `state.loadFactor` is an INSTANTANEOUS specific-force reading taken once
     * per 1/240 s substep. Testing it directly against a single threshold
     * writes the aeroplane off for a 4-millisecond numerical transient — and
     * this simulation manufactures those routinely: a gear leg releasing its
     * spring, a DEM tile paging in, an LOD refinement moving the ground under
     * the wheels. Players hit "airframe overload — -6.0 g" repeatedly in
     * ordinary flight, which is the threshold value itself showing through,
     * not an aerodynamic event.
     *
     * A real airframe fails from load SUSTAINED over a meaningful interval, so:
     *
     *   SUSTAINED — beyond crashLoadG continuously for crashLoadSustainS.
     *               Overstress: a hard pull held long enough to matter.
     *   INSTANT   — beyond crashLoadInstantG in a single sample. The impact
     *               path: hitting a cliff produces loads far past the
     *               manoeuvring limit and waiting to admit it would be absurd.
     *
     * THE 60 ms WINDOW IS MEASURED, NOT PICKED. Arrival sink rates, run
     * through the envelope harness's own landing setup:
     *
     *     700 fpm   peak 4.77 g   held   0 ms   must survive — a hard landing
     *   1,200 fpm   peak 7.33 g   held  54 ms
     *   1,400 fpm   peak 8.38 g   held  71 ms   must crash
     *   1,800 fpm   peak 10.1 g   held 104 ms   must crash
     *
     * 60 ms sits in the gap: a 700 fpm arrival never reaches the limit at all,
     * and a 1,400 fpm arrival holds it comfortably past the window. 60 ms is
     * also 14 substeps at 1/240 s, an order of magnitude longer than the one-
     * and two-sample spikes that were causing the spurious crashes.
     *
     * An airframe with a different gear stroke or a different mass will land
     * somewhere else on that table. Re-measure it; do not copy this window.
     */
    crashLoadG: 6.0,
    crashLoadSustainS: 0.06,
    crashLoadInstantG: 12.0,
    /**
     * Structural failure speed, as a multiple of maxSpeedMs (indicated).
     * 1.3 x 165 kt = 214 kt IAS. Below it the airframe merely complains
     * (`state.overspeed`); at it the wing comes off. Chosen so the model's own
     * display-field check, which deliberately parks the aeroplane at 180 KIAS,
     * still runs.
     */
    overspeedBreak: 1.3,
  },
};

export default C172;

/* ---------------------------------------------------------------------------
 * ENVELOPE — the Cessna's
 *
 * DERIVED — the arithmetic the constants above were chosen against, at gross
 * weight (1100 kg / 10,787 N), sea level, ISA. Re-derive before changing one.
 *
 *   CL_ALPHA      4.96 /rad     Helmbold, AR 7.47
 *   CL_MAX        1.74          from stallSpeedMs = 25 m/s
 *   alpha_crit    ~18.7 deg clean (geometric), ~1.1 deg lower at full flap
 *   Vs1 (clean)   25.0 m/s = 48.6 kt
 *   Vs0 (flap)    21.5 m/s = 41.7 kt
 *   Vfe           43.7 m/s = 85 kt (flaps blow back above this)
 *   Vne           85 m/s   = 165 kt (advisory; nothing enforces it)
 *   trim speed    ~47 m/s  = ~91 kt hands off, from cm0 = 0.05
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
