/**
 * b738.js — the Boeing 737-800. Numbers only; no code.
 *
 * A sibling of c172.js. Read that file first: it is the reference airframe and
 * it explains what each key MEANS. This file explains what each key is FOR ON A
 * JET, and only re-states a comment where the reasoning genuinely differs.
 *
 * Nothing is inherited on purpose. c172.js warns that falling back group by
 * group is a convenience for experiments and a trap for a finished aircraft —
 * "a jet that silently inherits a Cessna's aileron power is worse than one that
 * fails loudly" — so every key the model reads is stated here, including the
 * ones that happen to agree with the Cessna.
 *
 * MASS. 70,000 kg: a representative mid-mission weight, not MTOW (79,010 kg)
 * and not empty (41,410 kg). Every speed below is quoted AT THIS MASS, which is
 * why the stall speed here is a few knots above the book figure — the book
 * quotes 65,000 kg. Change massKg and the stall speed the model produces moves
 * with it; that is the point of stating a stall speed rather than a CLmax.
 *
 * WHAT THIS AIRFRAME NEEDS FROM THE MODEL THAT A PISTON DOES NOT:
 *   prop.propulsion 'turbofan'  — flat thrust, not constant shaft power
 *   aero.machEffects true       — Prandtl-Glauert, wave drag, and an Mmo
 *   aero.sweepDeg               — 25 deg of sweep costs 9% of lift-curve slope
 *   limits.clMaxMax             — slats put CLmax past a plain wing's ceiling
 * All four are branches in flightModel.js, not coefficients. See the block
 * comments there for why each one could not be faked with a bigger number.
 *
 * SOURCES: Boeing 737-800 FCOM / AFM figures for geometry, weights, placard
 * speeds and thrust; the public JSBSim 737 stability-derivative set, converted
 * to SI and to this model's axes; then trimmed against `npm run envelope
 * -- --airframe=b738`, which takes off, climbs, cruises, stalls and lands it.
 * Where a number was moved off its published value to make the MEASURED
 * behaviour right, the comment says so and says what it was measured against.
 */

import { DEG_TO_RAD } from '../../core/units.js';

export const B738 = {
  /** Human-readable, for a HUD or a type-select menu. Not used by the physics. */
  name: 'Boeing 737-800',

  // -------------------------------------------------------------------------
  // MASS, GEOMETRY, INERTIA
  // -------------------------------------------------------------------------
  /** All-up mass, kg. See the header — this is a mid-mission weight. */
  massKg: 70000,
  /** Reference wing area, m^2. */
  wingAreaM2: 124.6,
  /**
   * Wing span, m. 34.32 is the span WITHOUT winglets, and it is the right
   * number to put here even though the aeroplane modelled has them: this key
   * feeds aspect ratio, and the blended winglets do not extend the span so
   * much as they raise the effective span efficiency. That belongs in `oswald`
   * — putting the 35.79 m winglet-tip span here instead would claim AR 10.3
   * for a wing whose real aspect ratio is 9.45, and would cut induced drag
   * twice for the same devices.
   */
  wingSpanM: 34.32,
  /** Fuselage length, m. Only scales the DEFAULT inertias, which this airframe
   *  overrides — kept accurate anyway so the fallback is not a lie. */
  fuselageLengthM: 39.47,
  /**
   * Ground clearance of the datum, m. A 737 sits low — famously so; it is why
   * the CFM56 nacelle is flat-bottomed. 2.9 m from the wheels to the fuselage
   * centreline.
   *
   * aircraft/model.js MUST put this type's contact patch at -2.9 m, exactly as
   * the Cessna's is at -1.2 m, or the visual wheels will float above or sink
   * through the runway the physics is standing on.
   */
  gearHeightM: 2.9,
  /**
   * Height of the WING above the datum, m. NEGATIVE, and that is not a typo:
   * this is a low-wing aeroplane and the wing root sits BELOW the fuselage
   * centreline. Ground effect is measured from the wing, so the sign matters —
   * a 737 flares into ground effect noticeably closer to the surface than a
   * high-wing Cessna does, and the float on landing is correspondingly shorter.
   */
  wingHeightM: -1.1,
  /**
   * Moments of inertia, kg.m^2. STATED, not scaled. c172.js is explicit that
   * extrapolating its own inertias by mass and length is fine for a variant of
   * a Cessna and not fine for a different class of aeroplane; a 737 is the
   * case it was warning about. Left at 0, the fallback would give this airframe
   * roughly a third of its real roll inertia and it would snap into bank like
   * an aerobat.
   *
   * From the public JSBSim 737 set, slug.ft^2 x 1.35582:
   *   roll  (Ixx)   562,000 -> 762,000
   *   pitch (Iyy) 1,473,000 -> 1,997,000
   *   yaw   (Izz) 1,894,000 -> 2,568,000
   */
  inertiaRollKgM2: 762000,
  inertiaPitchKgM2: 1997000,
  inertiaYawKgM2: 2568000,

  // -------------------------------------------------------------------------
  // SPEEDS
  // -------------------------------------------------------------------------
  /**
   * Vmo, m/s indicated. 174.9 m/s = 340 KIAS, the placard.
   *
   * On a jet this is only HALF the speed limit. The other half is limits.mmo,
   * and which one binds depends on altitude: 340 KIAS is M0.52 at sea level and
   * M0.90 at FL400, so low down Vmo protects you and high up Mmo does. They
   * cross around FL260. A model with only this number lets you cruise straight
   * through the Mach limit and never says a word — see aero.machEffects.
   */
  maxSpeedMs: 174.9,
  /**
   * CLEAN 1-g stall speed, m/s, AT massKg. 73.6 m/s = 143 kt.
   *
   * The book figure is ~138 kt, quoted at 65,000 kg. Stall speed goes as the
   * square root of weight, so 138 * sqrt(70/65) = 143 kt. Stating the speed at
   * THIS mass rather than copying the book number is what keeps the derived
   * CLmax honest: 73.6 m/s at 70 t over 124.6 m^2 gives CLmax 1.66, which is
   * right for a clean swept wing with the slats stowed.
   */
  stallSpeedMs: 73.6,

  // -------------------------------------------------------------------------
  // DRAG
  // -------------------------------------------------------------------------
  /**
   * Zero-lift drag coefficient. 0.019 is a clean modern transport, and unlike
   * the Cessna's it has NOT been inflated to bring the top speed down — a jet's
   * top end is set by the Mach drag rise and by Mmo, not by parasite drag.
   *
   * Checked against cruise rather than against Vmax: at 70 t, FL350, M0.785,
   * this gives CL 0.54 and L/D 16.4, against a real 737-800's 17-18. The
   * shortfall is honest — this model has no wing-body interference bookkeeping
   * and no laminar run — and it errs in the safe direction, costing the
   * aeroplane a little range rather than giving it free performance.
   */
  cd0: 0.019,
  /**
   * Oswald span efficiency. 0.78 is a swept wing; the blended winglets are in
   * here rather than in the span — see wingSpanM.
   */
  oswald: 0.78,

  // -------------------------------------------------------------------------
  // PROPULSION — sizing. The response curve is in `prop` below.
  // -------------------------------------------------------------------------
  /**
   * NOT USED by a turbofan, and present only because the model's config shape
   * has one slot for engine sizing per kind. A fan is rated in THRUST — see
   * staticThrustN, which is the number that actually flies this aeroplane.
   * Left at a plausible-looking equivalent shaft power would be an invitation
   * to tune the wrong knob, so it is zero.
   */
  maxPowerW: 0,
  /** Also unused: there is no propeller to have an efficiency. */
  propEfficiency: 0,
  /**
   * Sea-level static thrust, N, ALL ENGINES. Two CFM56-7B26 at 121 kN each.
   *
   * For a turbofan this is the primary sizing number and the whole thrust curve
   * hangs off it: T = staticThrustN * spool * sigma^0.85 * (1 - 0.49*sqrt(M)).
   * There is no 1/V term, which is the entire difference between this and a
   * propeller. At FL350 and M0.785 that leaves 50.6 kN available against 41.8 kN
   * of drag, so cruise sits near 82% of full thrust — which is why a jet cruises
   * at a high N1 and still has margin, and why it has so much of it on the
   * runway.
   */
  staticThrustN: 242000,
  /**
   * There is no tachometer on this aeroplane. A turbofan's engine gauge is N1,
   * a PERCENTAGE of fan redline, and the model publishes it as `state.n1Pct`
   * with `state.engineGauge` set to 'n1' so a panel knows which to believe.
   * These two are stated as zero rather than as a plausible 20/100 on purpose:
   * a fake rpm that reads like a real one is worse than an absent one, because
   * a wrong number that looks right is a number nobody ever checks.
   */
  idleRpm: 0,
  maxRpm: 0,

  // -------------------------------------------------------------------------
  // AERODYNAMIC DERIVATIVES — per RADIAN, aero axes (x fwd, y right, z down)
  // -------------------------------------------------------------------------
  aero: {
    /**
     * COMPRESSIBILITY ON. This is the switch that makes the jet a jet rather
     * than a very large Cessna, and it turns on three things at once:
     * Prandtl-Glauert on the lift-curve slope, transonic wave drag past mCrit,
     * and the Mmo structural limit in `limits`. See flightModel's MACH_EFFECTS
     * block. At M0.785 the wing is 61% steeper than its low-speed self, which
     * is why this aeroplane is twitchy in pitch at cruise and docile on
     * approach, and why its stall margin shrinks as it climbs.
     */
    machEffects: true,
    /**
     * Quarter-chord sweep, degrees. 25 deg. Costs 9% of the lift-curve slope
     * (simple sweep theory, cos 25 = 0.906) and buys the high critical Mach
     * number below. It is stated here as geometry; mCrit is stated separately
     * because a supercritical section contributes as much to it as the sweep.
     */
    sweepDeg: 25,
    /**
     * Drag-divergence Mach number. 0.72 for a mid-1980s supercritical wing at
     * cruise CL. Past it, drag rises as the cube of how far past you are: about
     * 7% of total drag at the M0.785 cruise, and comparable to the whole
     * parasite drag by M0.86. That rise IS the reason a jet does not simply
     * accelerate to its placard in the cruise — the wall arrives before the
     * limit does, and you can feel it coming.
     */
    mCrit: 0.72,
    /** Wave-drag scale; see flightModel's MACH_DRAG_K. */
    machDragK: 0.1,

    /** Lift at zero geometric alpha. Lower than the Cessna's: less camber, and
     *  a supercritical section carries its lift further aft. */
    cl0: 0.18,
    /** Lift from pitch rate. Higher than the Cessna's — the tail arm is long
     *  relative to the 3.63 m mean chord. */
    clQ: 5.5,
    /** Lift from elevator. */
    clDe: 0.32,

    /**
     * Pitching moment at zero alpha — THE HANDS-OFF TRIM SPEED, and the single
     * most consequential number in this file for how the aeroplane feels.
     *
     * 0.10, raised from a first guess of 0.045 after it was flown. The theory
     * behind 0.045 was "a jet is flown trimmed at every speed, so keep the bias
     * small and let the stabiliser do the work". The theory was wrong about
     * what happens when the stabiliser is NOT doing the work: with cm0 0.045
     * and cmAlpha -1.3 the untrimmed aeroplane balances at alpha 1.98 deg, and
     * the speed at which that alpha carries 70 tonnes is
     *
     *     V = sqrt(W / (0.5 rho S CL))  with CL 0.357  ->  158 m/s = 308 kt
     *
     * So a hands-off 737 wanted 308 kt. Released at the 250 kt it spawns at, it
     * pitched down to go and find that speed — losing 1,688 ft before the extra
     * dynamic pressure pulled it out, then zooming back through the entry
     * altitude. That is a correctly-modelled aeroplane trimmed for the wrong
     * speed, and it read as "the plane dips a lot and crashes down quickly".
     *
     * Solving the same equation backwards for a hands-off 250 kt gives
     * cm0 = cmAlpha * alpha = 1.3 * 0.0723 = 0.094. Measured across the range,
     * 0.10 lands it: hands-off from the downtown spawn it now loses 29 ft
     * rather than 1,688, holds 242 kt, and peaks at 7 deg of pitch instead of
     * 23.
     */
    cm0: 0.1,
    /** Longitudinal static stability. Stiffer than the Cessna in pitch. */
    cmAlpha: -1.3,
    /** Pitch damping. Large: long tail arm, short chord. */
    cmQ: -22.0,
    /**
     * Elevator power. -1.5, raised from a first guess of -1.25, and the reason
     * is a moment balance that was MEASURED rather than assumed: with -1.25 and
     * 0.30 rad of travel the aeroplane could not rotate at Vr and simply
     * accelerated down the runway on its nosewheel to 177 kt.
     *
     * Summing moments about the MAIN gear at 145 kt, flaps 5, 70 t:
     *   weight 686 kN at the CG, 1.3 m forward of the mains  -892 kN.m
     *   wing lift at that attitude, ~135 kN                  +176 kN.m
     *   elevator at -1.25 / 0.30 rad                         +578 kN.m
     *                                                        ---------
     *                                                        -139 kN.m  (stuck)
     * The pair below produces +879 kN.m and a net +163 kN.m, which rotates the
     * aeroplane at the speed it is supposed to rotate at. See controls.deMaxRad
     * — the two numbers are one decision and must be changed together.
     */
    cmDe: -1.5,
    /** Flaps pitch the nose down, and harder than a Cessna's — big Fowler
     *  flaps move a lot of lift a long way aft. */
    cmFlap: -0.18,
    /**
     * NOSE-DOWN MOMENT AT THE STALL, and much weaker than the Cessna's -0.28.
     *
     * This is deliberate and it is the honest half of a real trade. A swept
     * wing stalls at the TIPS first; the tips are behind the CG, so losing
     * their lift pitches the nose UP, deeper into the stall. That is why a 737
     * has a stick shaker instead of relying on aerodynamic warning, and it is
     * the family of behaviour that made MCAS necessary on a later variant.
     *
     * The physically faithful value here is POSITIVE. It is not used, because a
     * positive value builds a genuine deep stall — a trap with no recovery, in
     * a simulator with no stick shaker to warn you before you enter it. -0.10
     * keeps recovery possible while removing most of the Cessna's helpful
     * self-righting: the nose drops, but weakly, and you must fly it out.
     * If a stick shaker is ever added, revisit this number first.
     */
    cmStall: -0.1,

    /** Side force from sideslip. Large: a tall fin and a deep fuselage. */
    cyBeta: -0.85,
    /** Side force from rudder. */
    cyDr: 0.19,

    /** Dihedral effect. Sweep produces effective dihedral on its own, which is
     *  why a swept-wing jet needs so little geometric dihedral to be stable. */
    crollBeta: -0.12,
    /** Roll damping. */
    crollP: -0.45,
    /** Roll from yaw rate — the term that makes Dutch roll a roll oscillation
     *  and not just a yaw one. Bigger on a swept wing. */
    crollR: 0.15,
    /**
     * Aileron power. MEASURED, not copied. 0.11 flew at 18.8 deg/s steady at
     * 160 kt; 0.09 puts it at the ~15 deg/s a 737 actually rolls at. The
     * Cessna's 0.229 in this slot would make it a 30 deg/s aeroplane, which no
     * 79-tonne airliner is — and it would still have "looked right" in the
     * config file, because the number that decides roll rate is this one
     * TIMES daMaxRad DIVIDED BY the roll inertia, and none of the three means
     * anything alone.
     */
    crollDa: 0.09,
    /** Roll from rudder. */
    crollDr: 0.01,
    /** Wing-drop at the stall. Sharper than the Cessna: swept wings drop a
     *  wing rather than mushing, and the tips go first. */
    crollStall: 0.03,

    /** Directional stability. */
    cnBeta: 0.14,
    /** Yaw from roll rate. */
    cnP: -0.03,
    /**
     * Yaw damping. Light for the size of the aeroplane, which is exactly the
     * point: a swept-wing jet's Dutch roll is only barely damped, and every
     * one of them carries a yaw damper to fix it. This model has no yaw damper,
     * so the oscillation is visible — which is honest, and is a thing to fly.
     */
    cnR: -0.2,
    /** Adverse yaw from aileron. Small; a real 737 also has roll spoilers,
     *  which this model does not yet have. */
    cnDa: -0.003,
    /** Rudder power. */
    cnDr: -0.1,

    /** Drag from sideslip. */
    cdBeta: 0.35,

    /**
     * STALL SHAPE. Sharper than the Cessna's on both counts. A swept wing has
     * far less of a gentle mushy approach to the break: the tips separate
     * early and quietly, and then it goes.
     */
    alphaSoftRad: 2 * DEG_TO_RAD,
    stallBreakRad: 0.05,
    negStallScale: 0.85,

    /** Ground effect. Same physics, but see wingHeightM — the wing is BELOW
     *  the datum on a low-wing aeroplane, so it enters ground effect later. */
    groundEffectK: 16,
  },

  // -------------------------------------------------------------------------
  // CONTROL SURFACES
  // -------------------------------------------------------------------------
  controls: {
    /**
     * Elevator travel, rad. 0.38 = 22 deg, within the real +20/-25. Raised from
     * 0.30 for the rotation moment balance written out beside aero.cmDe — the
     * two are one decision.
     */
    deMaxRad: 0.38,
    /** Aileron travel, rad. ~15 deg. See aero.crollDa — the pair of them is
     *  what sets the roll rate, and the roll rate is what was measured. */
    daMaxRad: 0.26,
    /** Rudder travel, rad. ~25 deg. Large, because it has to hold an engine
     *  failure at V1 — an asymmetry this model does not yet produce. */
    drMaxRad: 0.44,
    /**
     * Surface rate, full travel per second. 3.0 — hydraulically powered, so
     * not slow, but moving far more surface than a Cessna's cables do.
     */
    surfaceRate: 3.0,
    /**
     * Trim authority as a fraction of elevator travel. 0.5, against the
     * Cessna's 0.35, because a 737 trims with a FLYING STABILISER — the whole
     * tailplane moves — rather than with a tab on the elevator. This is why a
     * mistrimmed jet is so much harder to hold than a mistrimmed light
     * aircraft: the trim can out-pull the elevator.
     */
    trimAuthority: 0.5,
    /** Trim rate, full travel per second. Slower than the Cessna's: the jack
     *  screw takes its time, and you trim in small bites. */
    trimRate: 1 / 12,
  },

  // -------------------------------------------------------------------------
  // FLAPS  (and, implicitly, slats)
  // -------------------------------------------------------------------------
  flaps: {
    /**
     * Full travel in 12.5 s. The real schedule is slower still — flaps 40 takes
     * about 30 s — but the model has ONE continuous 0..1 axis and no detents,
     * so a 30 s sweep would mean holding the key for half a minute with no
     * stop to aim at. 0.08 is a playability decision and it is the only one in
     * this file. It becomes wrong the moment flap detents exist.
     */
    travelRate: 0.08,
    /** Zero-lift line shift at flaps 40. Large: Fowler flaps add area as well
     *  as camber. */
    dCl0: 1.15,
    /**
     * CLmax increase at full flap AND SLATS. 1.05, taking CLmax from 1.66 clean
     * to 2.71, which puts Vs0 at 112 kt at 70 t — the book figure scaled from
     * 108 kt at 65 t. That increment is far beyond what a plain flap can do and
     * it is why limits.clMaxMax has to be raised: it is leading-edge slats plus
     * triple-slotted trailing-edge flaps, which is most of what makes a 737
     * able to use a short runway at all.
     */
    dClMax: 1.05,
    /** Parasite drag at flaps 40. */
    dCd: 0.11,
    /**
     * Vfe, m/s: flaps blow back above this. 102.9 m/s = 200 kt.
     *
     * THIS IS A COMPROMISE AND IT IS THE MODEL'S FAULT, NOT THE AEROPLANE'S. A
     * real 737 has a placard PER DETENT — 250 kt at flaps 1, down to 162 kt at
     * flaps 40 — and one continuous axis cannot express that. 200 kt is the
     * flaps-15 placard: pick the 162 kt full-flap figure and you cannot take
     * any flap at a normal 180 kt approach speed; pick the 250 kt figure and
     * full flap is available 90 kt too fast. Detents are the fix; until then
     * this errs toward being usable on approach.
     */
    vfeMs: 102.9,
  },

  // -------------------------------------------------------------------------
  // PROPULSION — response
  // -------------------------------------------------------------------------
  prop: {
    /** A high-bypass fan. This is a BRANCH in flightModel, not a coefficient:
     *  flat thrust with a Mach sag, rather than a propeller's 1/V roll-off. */
    propulsion: 'turbofan',
    /**
     * Spool-UP rate, per second. 0.35 reaches 90% of a commanded change in
     * about 6.5 s, which is the number that matters on a go-around: firewalling
     * the levers does not give you thrust, it gives you thrust in six seconds,
     * and the aeroplane sinks in the meantime.
     */
    spoolRate: 0.35,
    /**
     * Spool-DOWN rate, per second. More than twice the spool-up rate, and the
     * asymmetry is the whole reason jets are flown with the thrust levers ahead
     * of the aeroplane. The Cessna omits this key because a piston is
     * symmetric.
     */
    spoolRateDown: 0.8,
    /** Residual thrust at flight idle, fraction of static. ~5.5%, which is
     *  quite enough to keep a clean jet accelerating in a descent. */
    idleThrustFrac: 0.055,
    /** Thrust density lapse exponent; see flightModel's THRUST_LAPSE_EXP. */
    thrustLapseExp: 0.85,
    /** Thrust Mach sag; see flightModel's THRUST_MACH_K. */
    thrustMachK: 0.49,
    /** N1 gauge range, percent. 21% is a stable ground idle. */
    n1Idle: 21,
    n1Max: 100,

    /** No propeller: nothing windmills, and nothing adds disc drag. */
    windmillRpmPerMs: 0,
    windmillCd0: 0,
    /**
     * NO SINGLE-ENGINE ASYMMETRY. Both zero — two engines, symmetric about the
     * centreline, no slipstream over the fin and no net torque reaction. A 737
     * tracks straight on the takeoff roll and needs no standing right rudder,
     * which is one of the first things that feels different from the Cessna.
     *
     * This is NOT the same as saying it has no asymmetry: an ENGINE FAILURE
     * produces a large yawing moment, and this model has one thrust vector on
     * the centreline and cannot produce it. That is a known gap, not a claim
     * that the aeroplane is symmetric in all cases.
     */
    slipstreamArmM: 0,
    torqueArmM: 0,
    /** Unused while both arms are zero; stated so the key is not a mystery. */
    effectFadeMs: 45,
  },

  // -------------------------------------------------------------------------
  // LANDING GEAR AND GROUND HANDLING
  // -------------------------------------------------------------------------
  gear: {
    /**
     * Contact points, metres: y measured UP from the wheel plane, +X right,
     * -Z forward. Wheelbase 15.6 m, main-gear track 5.72 m — both real.
     *
     * The mains sit 1.3 m AFT of the CG and the nose leg 14.3 m forward, so the
     * static nose load is 1.3/15.6 = 8.3% of weight. That fraction is what the
     * elevator has to beat before the nose will come up, and it is why rotation
     * happens at a speed rather than at a stick position.
     *
     * Spring rates are sized to a 0.15 m static squat at 70 t (k_total =
     * W/squat = 4.6 MN/m), split 91.7% onto the mains.
     *
     * DAMPING WAS MEASURED, AND THE FIRST GUESS WAS TWICE TOO HIGH. At
     * c = 300,000 the damper alone produced 1.2 MN per leg the instant the
     * wheels touched — 3.5 g before the oleo had stroked at all — and a
     * 630 fpm arrival, which is a NORMAL firm landing, wrote the airframe off
     * at 4.8 g. The spike is a linear damper's failure mode: force is
     * proportional to closing speed, so it peaks at first contact, exactly
     * where a real orifice-damped oleo is still soft.
     *
     * 150,000 is ~0.3 of critical on a main and puts the same arrival at
     * 3.0 g, which the aeroplane survives. See limits.crashLoadG for the
     * measured arrival table this produces.
     */
    contacts: [
      {
        name: 'nose',
        x: 0, y: 0, z: -14.3,
        k: 400000, c: 30000,
        bearing: true,
        steer: true, brake: false,
        muRoll: 0.02, muSide: 0.7,
        vRefLong: 0.35, vRefSide: 0.25,
      },
      {
        name: 'left',
        x: -2.86, y: 0, z: 1.3,
        k: 2100000, c: 150000,
        bearing: true,
        steer: false, brake: true,
        muRoll: 0.018, muSide: 0.9,
        vRefLong: 0.3, vRefSide: 0.25,
      },
      {
        name: 'right',
        x: 2.86, y: 0, z: 1.3,
        k: 2100000, c: 150000,
        bearing: true,
        steer: false, brake: true,
        muRoll: 0.018, muSide: 0.9,
        vRefLong: 0.3, vRefSide: 0.25,
      },
      {
        /**
         * Tail skid. Not a wheel — the over-rotation limit, and on this type it
         * is a real and famous one: 2.80 m of height 14.7 m behind the mains
         * contacts at 10.8 deg nose-up. The 737-800 is the stretched variant
         * and it strikes its tail at about 11 deg, which is only ~2 deg beyond
         * a normal rotation attitude. `bearing: false` — it carries no weight
         * parked and takes no part in the static squat.
         *
         * STIFF, and deliberately far stiffer than the oleos: a skid is
         * STRUCTURE, not a spring. At 900,000 N/m it compressed far enough
         * under full elevator to let the aeroplane reach 14.2 deg on the
         * wheels — three degrees of pitch bought by a "hard stop" that was
         * quietly soft. 4 MN/m holds the geometric angle it is supposed to.
         */
        name: 'tail',
        x: 0, y: 2.8, z: 16.0,
        k: 4000000, c: 250000,
        bearing: false,
        steer: false, brake: false,
        muRoll: 0.55, muSide: 0.55,
        vRefLong: 0.4, vRefSide: 0.4,
      },
    ],

    /**
     * Leg travel before bottoming, m. 0.45 — a big oleo with a long stroke,
     * which is most of why a heavy jet can absorb an arrival that would fold a
     * light aircraft. See limits.crashLoadG: the survivable sink rate for this
     * airframe was MEASURED against this stroke, not copied from the Cessna.
     */
    strokeM: 0.45,

    /**
     * Braked rolling friction at full brake. 0.45 rather than the Cessna's
     * 0.55: carbon brakes with antiskid on dry concrete give a lower effective
     * mu than a light aircraft's locked-up tyre, because antiskid deliberately
     * holds the wheel just short of a skid rather than at peak friction.
     */
    muBrake: 0.45,

    /**
     * NOSEWHEEL STEERING, RUDDER PEDALS ONLY. 0.12 rad = 7 deg, which is what
     * the pedals command on a 737. The tiller gives 78 deg and is a separate
     * control this model does not have — so the aeroplane taxis in wide arcs,
     * correctly, and cannot make a 90 deg turn onto a taxiway.
     */
    steerMaxRad: 0.12,
    steerRefMs: 3,
    steerFadeExp: 1.5,
    steerFloor: 0.02,
  },

  // -------------------------------------------------------------------------
  // STRUCTURAL LIMITS
  // -------------------------------------------------------------------------
  limits: {
    /**
     * Ultimate load factor, g. Transport category is +2.5 g limit, x1.5 = 3.75
     * ultimate; 4.0 rounds it. Far lower than the Cessna's 6.0 — an airliner is
     * not stressed for aerobatics and this is the correct, uncomfortable
     * consequence.
     *
     * THE SUSTAIN WINDOW IS RE-MEASURED, NOT COPIED. c172.js is explicit that
     * "an airframe with a different gear stroke or a different mass will land
     * somewhere else on that table". Run against this airframe's own gear
     * (0.45 m stroke, 150 kN.s/m mains), touching down at Vref with flaps 40:
     *
     *   touchdown   peak     held     outcome
     *      631 fpm  3.04 g    0 ms    survives — a firm but normal arrival
     *      666 fpm  3.38 g    0 ms    survives
     *      781 fpm  3.61 g    0 ms    survives — hard, inspection-worthy
     *      863 fpm  3.75 g    0 ms    gear collapses
     *      958 fpm  4.01 g   17 ms    gear collapses
     *    1,070 fpm  4.29 g   67 ms    airframe overload
     *
     * Note WHICH limit catches each one. Up to about 980 fpm the gear fails
     * first, on closing speed, before the load ever holds for 60 ms — which is
     * correct and is what happens to real aeroplanes: the legs are the fuse.
     * The 60 ms window only starts catching arrivals past 1,000 fpm, by which
     * point the aircraft is being written off twice over.
     *
     * A real 737's gear is designed to 600 fpm at max landing weight and
     * certified to 720; anything past 900 is a hull loss. The table above puts
     * the boundary in the right place for the right reason.
     */
    crashLoadG: 4.0,
    crashLoadSustainS: 0.06,
    crashLoadInstantG: 9.0,
    /** Structural failure at 1.3 x whichever limit binds. 1.3 x 340 kt = 442
     *  KIAS, or 1.3 x M0.82 = M1.07. */
    overspeedBreak: 1.3,
    /**
     * CLmax rails. clMaxMax RAISED to 3.2 from the default 2.4, and this is
     * exactly the trap c172.js warns about: a wing with leading-edge slats
     * reaches CLmax values a plain flapped wing cannot, and being silently
     * pinned at 2.4 would give the aeroplane an optimistic stall speed with
     * nothing anywhere saying so. The clean value here is 1.66 and well inside
     * either rail; the headroom is for the flapped case and for anyone who
     * lowers stallSpeedMs.
     */
    clMaxMin: 0.9,
    clMaxMax: 3.2,
    /**
     * Mmo. M0.82, the 737-800 placard.
     *
     * This is the limit that a Vne-only model cannot express. At FL350, M0.82
     * is about 290 KIAS — fifty knots BELOW Vmo — so the aeroplane can be
     * comfortably inside its airspeed placard and past its Mach limit at the
     * same time. Only consulted when aero.machEffects is on.
     */
    mmo: 0.82,
  },
};

export default B738;
