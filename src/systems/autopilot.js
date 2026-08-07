/**
 * autopilot.js — heading hold and altitude hold.
 *
 *   createAutopilot() -> { engaged, toggle(), update(dt, state, inputs), ... }
 *
 * THIS MODULE IS A CONTROLLER, NOT A PHYSICS MODULE. It writes into the same
 * `inputs` object the pilot's keyboard produces, immediately before
 * `flight.step()` consumes it. The flight model cannot tell the difference,
 * which is the point: an autopilot that bypassed the aerodynamics could hold a
 * heading the aeroplane is not capable of holding.
 *
 * ---------------------------------------------------------------------------
 * SIGN CONVENTIONS — verified, not assumed
 * ---------------------------------------------------------------------------
 * Getting one of these backwards yields an autopilot that turns away from the
 * bug and winds up at full deflection, so every one is asserted in
 * scripts/check-autopilot.mjs against the real flight model rather than
 * reasoned about here:
 *
 *   inputs.pitch  > 0  =>  nose UP     (input.js: S / ArrowDown are PITCH_POS)
 *   inputs.roll   > 0  =>  roll RIGHT  (input.js: D / ArrowRight are ROLL_POS)
 *   inputs.yaw    > 0  =>  yaw RIGHT   (input.js: E is YAW_POS)
 *   state.rollDeg > 0  =>  banked RIGHT
 *   state.headingDeg   =>  0..360 true, increasing clockwise
 *
 * ---------------------------------------------------------------------------
 * WHY THERE ARE INTEGRATORS
 * ---------------------------------------------------------------------------
 * This aeroplane has no elevator trim — round 1's flight-model critic flagged
 * it, and it is still true. A purely proportional pitch loop therefore parks at
 * a standing error: it needs a non-zero elevator command to hold level flight,
 * but a proportional term only produces one when there IS altitude error. The
 * aircraft would settle a couple of hundred feet low and stay there.
 *
 * The integrator supplies that standing command. Both loops have one, both are
 * clamped (anti-windup), and both are zeroed on engage so the autopilot never
 * inherits a stale bias from a previous engagement.
 *
 * ---------------------------------------------------------------------------
 * WHY IT DISENGAGES WHEN YOU TOUCH THE CONTROLS
 * ---------------------------------------------------------------------------
 * A pilot pulling against an engaged autopilot is a fight the autopilot wins
 * until it suddenly doesn't. Real units disconnect on control-force input; this
 * one disconnects when the pilot's own pitch or roll axis passes DISCONNECT_AXIS.
 * Throttle, rudder, flaps, gear and brakes do NOT disconnect it — those are
 * things you legitimately do with the autopilot flying.
 */

/** Steepest bank the autopilot will command, degrees. A standard-rate turn at
 *  100 kt is about 15 deg; 25 gives it authority to recapture without alarming. */
const MAX_BANK_DEG = 25;

/** Target bank per degree of heading error. 1.3 means a 20 deg error asks for
 *  26 deg of bank, i.e. it saturates just past 19 deg and rolls out smoothly. */
const K_HDG_TO_BANK = 1.3;

/** Aileron per degree of bank error, and the rate damping that stops it
 *  oscillating around the target bank. */
const K_BANK_P = 0.055;
const K_BANK_D = 0.012;
const K_BANK_I = 0.004;
const BANK_I_CLAMP = 0.25;

/** Fastest climb or descent the autopilot will ask for, fpm. Deliberately
 *  inside the aeroplane's ~740 fpm best rate: an autopilot that commands more
 *  than the aircraft can deliver just winds its integrator up. */
const MAX_VS_FPM = 600;

/** Target vertical speed per foot of altitude error. 2.2 means a 300 ft error
 *  asks for 660 fpm, so it saturates only on large captures. */
const K_ALT_TO_VS = 2.2;

/**
 * VERTICAL CASCADE: altitude -> vertical speed -> PITCH ATTITUDE -> elevator.
 *
 * The attitude stage in the middle is not decoration, and leaving it out is
 * what made the first version porpoise. Driving the elevator straight from
 * vertical-speed error closes a slow loop (altitude and vertical speed both lag
 * the elevator by seconds) around an airframe that already has a lightly damped
 * phugoid — a long-period exchange of height for speed. The controller then
 * pumps that mode instead of damping it: nose up, speed decays, sink, nose
 * down, speed builds, climb, forever.
 *
 * Closing an inner loop on PITCH ATTITUDE fixes it, because attitude responds
 * to the elevator almost immediately. The outer loops then only have to ask for
 * an attitude, which is a request the aeroplane can satisfy without overshoot.
 */

/** Degrees of pitch commanded per fpm of vertical-speed error. */
const K_VS_TO_PITCH = 0.010;

/** Steepest attitude the autopilot will command, degrees. */
const MAX_PITCH_CMD_DEG = 8;

/** Inner attitude loop: elevator per degree of pitch error, per deg/s of pitch
 *  rate (the damping term), and the integrator that replaces the missing trim. */
const K_PITCH_P = 0.075;
const K_PITCH_D = 0.055;
const K_PITCH_I = 0.020;
const PITCH_I_CLAMP = 0.55;

/** Time constant for the rate low-pass, seconds. See pitchRateF below. */
const RATE_TAU = 0.08;

/**
 * Floor on the differentiation interval, seconds.
 *
 * A very short frame makes (delta / dt) explode even when the attitude barely
 * moved, because the numerator is dominated by float noise at that scale. The
 * floor bounds the amplification; the low-pass then cleans up what is left.
 */
const RATE_MIN_DT = 1 / 240;

/**
 * Airspeed protection, knots.
 *
 * THIS AUTOPILOT HAS NO AUTOTHROTTLE, exactly like the real units fitted to
 * light singles: the pilot owns the power lever. That means a commanded climb
 * at a power setting which cannot sustain it will trade airspeed for altitude
 * until the aeroplane stops flying. The first run of check-autopilot.mjs did
 * precisely this — commanded +700 ft at cruise power and finished 500 ft LOWER,
 * having mushed the whole way.
 *
 * So the vertical loop is airspeed-limited. Above PROTECT it climbs as asked;
 * between PROTECT and FLOOR the commanded climb is scaled down in proportion;
 * at FLOOR it will not climb at all. Descents are never limited — descending is
 * how you recover speed. FLOOR sits well above the ~40 kt stall so the
 * protection engages long before the break.
 */
const VS_PROTECT_KTS = 75;
const VS_FLOOR_KTS = 58;

/** Pilot axis deflection that disconnects the autopilot. Above the input
 *  module's CENTRE_EPS by a wide margin, so a released key cannot trip it. */
const DISCONNECT_AXIS = 0.3;

/** Minimum height above ground to engage, feet. Prevents engaging on the roll. */
const MIN_ENGAGE_AGL_FT = 200;

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

/** Shortest signed angle from `from` to `to`, in (-180, 180]. */
function wrap180(deg) {
  let d = ((deg + 180) % 360 + 360) % 360 - 180;
  if (d === -180) d = 180;
  return d;
}

/**
 * @returns {{
 *   engaged: boolean,
 *   headingBug: number,
 *   altitudeBug: number,
 *   toggle: (state: Object) => {ok: boolean, reason?: string},
 *   disengage: (why?: string) => void,
 *   nudgeHeading: (deltaDeg: number) => number,
 *   syncHeading: (state: Object) => number,
 *   nudgeAltitude: (deltaFt: number) => number,
 *   update: (dt: number, state: Object, inputs: Object) => void,
 *   status: () => Object,
 * }}
 */
export function createAutopilot() {
  let engaged = false;
  let headingBug = 0;
  let altitudeBug = 1000;

  // Integrator state. Zeroed on every engage — see the header note.
  let bankI = 0;
  let pitchI = 0;

  /**
   * Previous attitude, for locally differentiated rates.
   *
   * The flight model does not publish angular rates on `state` — there is no
   * p/q/r and no pitchRateDps. The first version of this file reached for
   * `state.rollRateDps ?? state.p ?? 0`, which meant the damping term was
   * silently ZERO in every frame it ever ran. An undamped controller on a
   * lightly damped airframe is exactly the porpoise that got reported.
   *
   * So the rates are differentiated here instead. NaN on the first frame after
   * engage is avoided by seeding these at engage time.
   */
  let prevPitchDeg = 0;
  let prevRollDeg = 0;
  let haveRates = false;

  /**
   * Smoothed rates. THE RAW DIFFERENCE IS NOT USABLE AS A D TERM.
   *
   * (attitude - prevAttitude) / dt divides a small number by a jittery one. In
   * the headless harness dt is a perfectly regular 1/60 and the quotient is
   * clean, which is precisely why the first fix measured as smooth and was
   * still visibly jittery in a browser: real frame deltas vary, and a terrain
   * page-in or a GC pause produces a spike that the division AMPLIFIES. That
   * noise goes straight out of the damping term as elevator judder.
   *
   * An exponential moving average over RATE_TAU rejects the per-frame noise
   * while passing the real rate — the phugoid it has to damp has a period of
   * many seconds, so an 80 ms filter costs nothing that matters.
   */
  let pitchRateF = 0;
  let rollRateF = 0;

  /** Why we last disengaged, for the HUD to show. */
  let lastReason = '';

  function resetIntegrators() {
    bankI = 0;
    pitchI = 0;
    haveRates = false;
    pitchRateF = 0;
    rollRateF = 0;
  }

  function disengage(why) {
    if (!engaged) return;
    engaged = false;
    lastReason = why || '';
    resetIntegrators();
  }

  return {
    get engaged() {
      return engaged;
    },
    get headingBug() {
      return headingBug;
    },
    get altitudeBug() {
      return altitudeBug;
    },

    /**
     * Toggle. On engage the bugs snap to the CURRENT heading and altitude, so
     * pressing the key never produces a surprise manoeuvre — the aeroplane
     * holds what it already had, and you then dial it somewhere else.
     */
    toggle(state) {
      if (engaged) {
        disengage('off');
        return { ok: true };
      }
      if (state && state.crashed) return { ok: false, reason: 'crashed' };
      if (state && state.onGround) return { ok: false, reason: 'on the ground' };
      const agl = state ? (state.altitudeAglFt ?? state.altitudeFt ?? 0) : 0;
      if (agl < MIN_ENGAGE_AGL_FT) {
        return { ok: false, reason: `below ${MIN_ENGAGE_AGL_FT} ft AGL` };
      }
      headingBug = Math.round(state.headingDeg ?? 0);
      altitudeBug = Math.round((state.altitudeFt ?? 0) / 100) * 100;
      resetIntegrators();
      engaged = true;
      lastReason = '';
      return { ok: true };
    },

    disengage,

    /** Turn the heading bug. Returns the new bug so the caller can annunciate it. */
    nudgeHeading(deltaDeg) {
      headingBug = ((headingBug + deltaDeg) % 360 + 360) % 360;
      return headingBug;
    },

    /** Snap the bug to where the nose is pointing now. */
    syncHeading(state) {
      headingBug = Math.round(state?.headingDeg ?? 0);
      return headingBug;
    },

    nudgeAltitude(deltaFt) {
      altitudeBug = clamp(altitudeBug + deltaFt, 0, 30000);
      return altitudeBug;
    },

    /**
     * Called every frame BEFORE flight.step(). Mutates `inputs` in place when
     * engaged; touches nothing when not, so the pilot has the aeroplane back
     * the instant it disconnects.
     */
    update(dt, state, inputs) {
      if (!engaged) return;

      // A crash or a touchdown ends the engagement, not the other way round.
      if (state.crashed) return disengage('crashed');
      if (state.onGround) return disengage('on the ground');

      // The pilot outranks the autopilot. Throttle/rudder/flaps deliberately
      // do not trip this — you fly those with the autopilot engaged.
      if (
        Math.abs(inputs.pitch ?? 0) > DISCONNECT_AXIS ||
        Math.abs(inputs.roll ?? 0) > DISCONNECT_AXIS
      ) {
        return disengage('pilot input');
      }

      const d = dt > 0 && dt < 0.5 ? dt : 1 / 60;

      // Differentiate attitude for the damping terms. The model publishes no
      // angular rates, so we keep our own. First frame after engage has no
      // history, so the rates are zero for exactly one step.
      const pitchDeg = state.pitchDeg ?? 0;
      const rollDeg = state.rollDeg ?? 0;

      // Differentiate over a floored interval, then LOW-PASS. Both halves
      // matter: the floor bounds the amplification a very short frame causes,
      // and the filter removes the frame-to-frame noise that survives it.
      const dRate = Math.max(d, RATE_MIN_DT);
      const rawPitchRate = haveRates ? (pitchDeg - prevPitchDeg) / dRate : 0;
      const rawRollRate = haveRates ? (rollDeg - prevRollDeg) / dRate : 0;

      // Frame-rate-independent EMA: the same time constant whatever dt is.
      const a = haveRates ? 1 - Math.exp(-d / RATE_TAU) : 1;
      pitchRateF += (rawPitchRate - pitchRateF) * a;
      rollRateF += (rawRollRate - rollRateF) * a;
      const pitchRate = pitchRateF;
      const rollRate = rollRateF;

      prevPitchDeg = pitchDeg;
      prevRollDeg = rollDeg;
      haveRates = true;

      // --- lateral: heading -> bank -> aileron ------------------------------
      const hdgErr = wrap180(headingBug - (state.headingDeg ?? 0));
      const bankTarget = clamp(hdgErr * K_HDG_TO_BANK, -MAX_BANK_DEG, MAX_BANK_DEG);
      const bankErr = bankTarget - rollDeg;

      bankI = clamp(bankI + bankErr * d * K_BANK_I, -BANK_I_CLAMP, BANK_I_CLAMP);
      const rollCmd = bankErr * K_BANK_P + bankI - rollRate * K_BANK_D;
      inputs.roll = clamp(rollCmd, -1, 1);

      // --- vertical: altitude -> vertical speed -> elevator ------------------
      const altErr = altitudeBug - (state.altitudeFt ?? 0);
      let vsTarget = clamp(altErr * K_ALT_TO_VS, -MAX_VS_FPM, MAX_VS_FPM);

      // Airspeed protection, in two stages.
      //
      // Between PROTECT and FLOOR: scale the commanded climb down in
      // proportion. Below FLOOR: stop asking for level flight and actively
      // command a DESCENT, because at that point altitude is not the problem —
      // energy is. Merely clamping the target to zero is not enough and the
      // test caught that: the vertical-speed error stays positive while the
      // aeroplane sinks, so the loop keeps pulling and it stalls at 57 kt on
      // attitude even though it is nowhere near the ~40 kt speed.
      //
      // The integrator is also dumped downward, or its accumulated nose-up
      // command survives the recovery and flies straight back into the stall.
      const kts = state.airspeedKts ?? 0;
      const room = (kts - VS_FLOOR_KTS) / (VS_PROTECT_KTS - VS_FLOOR_KTS);
      if (room < 0) {
        vsTarget = Math.min(vsTarget, clamp(room, -1, 0) * MAX_VS_FPM);
        if (pitchI > 0) pitchI = 0;
      } else if (vsTarget > 0) {
        vsTarget *= clamp(room, 0, 1);
      }

      // Stage 2: vertical-speed error asks for a PITCH ATTITUDE, not for an
      // elevator deflection. See the cascade note above — this is the stage
      // whose absence caused the porpoising.
      const vsErr = vsTarget - (state.verticalSpeedFpm ?? 0);
      let pitchTarget = clamp(
        vsErr * K_VS_TO_PITCH,
        -MAX_PITCH_CMD_DEG,
        MAX_PITCH_CMD_DEG,
      );

      // In a bank some lift goes sideways, so level flight needs a little more
      // nose. Feeding it forward here keeps the integrator from having to
      // discover it again on every turn.
      const bankRad = (rollDeg * Math.PI) / 180;
      pitchTarget += clamp(1 / Math.max(0.4, Math.cos(bankRad)) - 1, 0, 0.5) * 3;

      // Stage 3: the fast inner loop. Proportional on attitude error, DAMPED on
      // pitch rate, with an integrator standing in for the trim the airframe
      // does not have.
      const pitchErr = pitchTarget - pitchDeg;
      pitchI = clamp(pitchI + pitchErr * d * K_PITCH_I, -PITCH_I_CLAMP, PITCH_I_CLAMP);

      inputs.pitch = clamp(
        pitchErr * K_PITCH_P + pitchI - pitchRate * K_PITCH_D,
        -1,
        1,
      );

      // Rudder: hold it neutral. The airframe already models adverse yaw and a
      // slipstream term; adding an uncalibrated coordination term on top of
      // those made it worse in testing, so the autopilot flies with its feet
      // on the floor and accepts a little slip in the turn.
      inputs.yaw = 0;
    },

    status() {
      return {
        engaged,
        headingBug,
        altitudeBug,
        lastReason,
      };
    },
  };
}
