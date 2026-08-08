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

/**
 * Degrees of pitch commanded per fpm of vertical-speed error.
 *
 * THIS WAS 0.010 AND IT WAS FAR TOO LOW. Worked through, at 0.010 an aeroplane
 * sitting 16 ft below its bug and sinking at 77 fpm asks for:
 *
 *   altErr 16 ft -> vsTarget +35 fpm -> vsErr +112 fpm -> pitchTarget 1.12 deg
 *
 * and the aeroplane was already holding 1.2 deg. The loop concluded it was on
 * target and stopped correcting. Observed in a browser as pitch frozen to the
 * decimal for nineteen consecutive samples while the altitude kept drifting.
 *
 * That is the "still oscillates" report: not a fast wobble but a very slow
 * hunt. Corrections took minutes, so the aeroplane wandered above and below the
 * bug indefinitely — which is why it "worked briefly and then came back", and
 * why cycling the autopilot off and on changed nothing.
 *
 * At 0.035 the same 112 fpm error asks for 3.9 deg, which the aeroplane can
 * actually fly, and a 300 fpm error saturates the 8 deg limit. The inner
 * attitude loop and its damping are what keep that from becoming an overshoot.
 */
const K_VS_TO_PITCH = 0.035;

/** Steepest attitude the autopilot will command, degrees. */
const MAX_PITCH_CMD_DEG = 8;

/** Inner attitude loop: elevator per degree of pitch error, per deg/s of pitch
 *  rate (the damping term), and the integrator that replaces the missing trim. */
const K_PITCH_P = 0.075;
const K_PITCH_D = 0.055;
const K_PITCH_I = 0.020;
const PITCH_I_CLAMP = 0.55;

/**
 * Time constant for the rate low-pass, seconds. See pitchRateF below.
 *
 * THIS WAS 0.08 AND IT WAS THE PORPOISE. The damping term is the only thing
 * standing between this loop and the airframe's short period, and a low-pass on
 * the rate estimate delays that term. At 0.08 s the delay is 33 degrees of
 * phase at the short period (~1.3 Hz measured), which is enough to turn the
 * damping term into an EXCITING one — the identical mechanism the TUNE_REF_DT
 * note below describes for a slow frame rate, arriving here through the filter
 * instead of through the sample rate.
 *
 * It is a limit cycle with two attractors, which is exactly why it survived
 * three rounds: land in the quiet one and the loop is perfect, land in the
 * noisy one and it never leaves. `airborne()` in the harness happened to land
 * in the quiet one at one power setting. Settle the same aeroplane for twenty
 * seconds first, or move the throttle, and it lands in the other:
 *
 *   3,000 ft, 100 kt, 0.65 throttle, engaged and left alone for 65 s
 *     RATE_TAU 0.08   pitch band  9.57 deg, 24 vertical-speed reversals in 10 s
 *     RATE_TAU 0.03   pitch band  0.01 deg,  0 reversals
 *
 *   then slam the throttle to full and hold 3 minutes
 *     RATE_TAU 0.08   pitch band 13.17 deg, 79 reversals, 17 ft below the bug
 *     RATE_TAU 0.03   pitch band  0.01 deg,  0 reversals,  3 ft below the bug
 *
 * The altitude band stayed inside 8 ft the whole time in BOTH columns, which is
 * why every altitude assertion in this project passed while the nose swung ten
 * degrees. Altitude band is not a stability measurement. The pitch band and the
 * reversal count are, and `check-autopilot.mjs § disturbed` now asserts them
 * across seven conditions rather than one.
 *
 * 0.03 s is still two frames at 60 Hz, and the two guards that actually bound a
 * differentiation spike are unchanged: RATE_MIN_DT floors the interval, and
 * CMD_SLEW_PER_S bounds how fast the resulting command may move. The 30 fps
 * ±60% jitter case is asserted below and is clean.
 */
const RATE_TAU = 0.03;

/**
 * Floor on the differentiation interval, seconds.
 *
 * A very short frame makes (delta / dt) explode even when the attitude barely
 * moved, because the numerator is dominated by float noise at that scale. The
 * floor bounds the amplification; the low-pass then cleans up what is left.
 */
const RATE_MIN_DT = 1 / 240;

/**
 * Fixed control-law step, seconds. THE AUTOPILOT SUBSTEPS, exactly like the
 * flight model, and for the same reason.
 *
 * WHY THIS EXISTS — it is the actual cause of the oscillation reported four times.
 *
 * The flight model integrates at a fixed 1/240 s. The autopilot was called ONCE
 * PER FRAME with the wall-clock delta, so it closed a loop around a 240 Hz plant
 * at whatever rate the browser happened to be rendering: 60 Hz on a good frame,
 * far less on a bad one, and never constant. A controller sampled too slowly for
 * its plant accumulates phase lag, and phase lag is what turns damping into
 * oscillation. Raising K_VS_TO_PITCH made it WORSE — more gain at the same phase
 * margin is less stable, not more.
 *
 * This hid for so long because every test ran at a regular DT = 1/60 and every
 * browser probe drove the sim through window.sim.tick(1/60, n) — the same fixed
 * step. Harness and probes agreed with each other and both disagreed with the
 * game, because a hidden tab never runs requestAnimationFrame, so the live loop
 * was never once observed.
 *
 * Substepping at a fixed 120 Hz makes the response identical at 15 fps and at
 * 144 fps, which is the only way this is testable at all.
 */
const AP_STEP_MAX_S = 1 / 30;

/**
 * Slew limit on the commanded surfaces, full-deflection units per second.
 *
 * This is what actually bounds the oscillation at a low frame rate. Phase lag
 * from slow sampling is unavoidable — a 15 Hz controller on a 240 Hz plant WILL
 * lag — but lag only becomes a violent oscillation if the controller is allowed
 * to slam the surface between samples. Limiting how fast the command may move
 * turns an unstable loop into a sluggish one, which is the right trade: a
 * sluggish autopilot is usable, an oscillating one is not.
 *
 * 2.5 means the elevator can travel its full range in 400 ms, comfortably
 * faster than any manoeuvre this aeroplane makes and far slower than the
 * frame-to-frame slamming measured at 15 fps (pitch swinging 30 degrees).
 */
const CMD_SLEW_PER_S = 2.5;

/**
 * Sample period the gains are tuned for, and the floor the loop is de-tuned to
 * when it cannot be sampled that fast.
 *
 * A PD loop is only stable up to a sample period set by its gains. The rate
 * estimate lags by roughly half a sample, so as the period grows that lag eats
 * the phase margin and the damping term stops damping and starts EXCITING —
 * measured here as 240 vertical-speed reversals and 22 degrees of pitch swing
 * at 20 fps, against 0 reversals and 0.13 degrees at 60.
 *
 * Slew limiting alone did not fix it (21.7 deg, still oscillating) because it
 * bounds the command's SPEED, not the loop's phase. The gains themselves have
 * to come down. Scaling P and D by (reference period / actual period) is the
 * standard answer: full authority at 60 fps and above, quartered by 15 fps.
 * The result is a sluggish autopilot on a slow machine rather than an
 * oscillating one, which is the correct trade.
 *
 * The integral term is NOT scaled — it already multiplies by dt, so it is
 * sample-rate correct by construction.
 */
const TUNE_REF_DT = 1 / 60;
const TUNE_MIN = 0.25;

/** Smoothing for the frame-time estimate the de-tune is based on. Using the
 *  instantaneous delta would let jitter modulate the gains frame to frame,
 *  which is its own source of roughness. */
const DT_FILTER_TAU = 0.5;

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
/**
 * PER-AIRCRAFT GAINS.
 *
 * Every constant above was tuned against the Cessna and every one of them is
 * an aeroplane-specific number: MAX_VS_FPM 600 is a 172's climb rate, the
 * airspeed floor of 58 kt is a 172's stall plus margin, and K_HDG_TO_BANK is
 * calibrated to a light single's roll response. Flown on the 737 unchanged the
 * loop HOLDS — it does not diverge — but it hunts: 47 vertical-speed reversals
 * a minute and +/-1,200 fpm about a level flight path, measured.
 *
 * The airspeed protection is the dangerous one rather than the untidy one. A
 * 58 kt floor on an aeroplane that stalls at 143 kt is not protection at all;
 * it is a number that can never fire, on the one loop whose whole job is to
 * stop the autopilot mushing an aeroplane into a stall while commanding a
 * climb it has no energy for.
 *
 * `setProfile()` rather than a constructor argument because main.js keeps ONE
 * autopilot across an aircraft change — see setAircraft() there.
 */
const DEFAULT_PROFILE = {
  maxVsFpm: MAX_VS_FPM,
  kAltToVs: K_ALT_TO_VS,
  kVsToPitch: K_VS_TO_PITCH,
  maxPitchCmdDeg: MAX_PITCH_CMD_DEG,
  kPitchP: K_PITCH_P,
  kPitchD: K_PITCH_D,
  kPitchI: K_PITCH_I,
  maxBankDeg: MAX_BANK_DEG,
  kHdgToBank: K_HDG_TO_BANK,
  kBankP: K_BANK_P,
  kBankD: K_BANK_D,
  kBankI: K_BANK_I,
  vsProtectKts: VS_PROTECT_KTS,
  vsFloorKts: VS_FLOOR_KTS,
};

export function createAutopilot() {
  /** Active gains. Replaced wholesale by setProfile(). */
  let G = { ...DEFAULT_PROFILE };

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

  /** Fixed-step accumulator, and the commands the last control step produced.
   *  update() re-applies these every frame; controlStep() recomputes them at a
   *  constant AP_STEP_S regardless of frame rate. */
  let cmdRoll = 0;
  let cmdPitch = 0;
  /** What was actually written to the controls, after slew limiting. */
  let appliedRoll = 0;
  let appliedPitch = 0;
  /** Smoothed frame time, and the gain scale derived from it. */
  let dtF = 0;
  let tuneScale = 1;

  /** Why we last disengaged, for the HUD to show. */
  let lastReason = '';

  function resetIntegrators() {
    bankI = 0;
    pitchI = 0;
    haveRates = false;
    pitchRateF = 0;
    rollRateF = 0;
    cmdRoll = 0;
    cmdPitch = 0;
    appliedRoll = 0;
    appliedPitch = 0;
    dtF = 0;
    tuneScale = 1;
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
    /**
     * Install a gain set. Unspecified keys keep the Cessna's value, so a
     * profile states only what genuinely differs — and an aeroplane with no
     * profile at all still gets a working autopilot rather than zeroes.
     * @param {Partial<typeof DEFAULT_PROFILE>} [profile]
     */
    setProfile(profile) {
      G = { ...DEFAULT_PROFILE, ...(profile || {}) };
      resetIntegrators();
    },

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

      // --- one control step per frame, with a bounded step and a slew limit --
      //
      // ONE step, not several. `state` is only refreshed once per frame by
      // flight.step(), so running the law repeatedly against it would read a
      // zero attitude rate — no damping at all — while winding the integrator
      // up once per substep. That was measurably worse than doing nothing.
      //
      // Instead the step is CLAMPED, so a very long frame advances the
      // integrator by at most AP_STEP_MAX_S, and the resulting command is
      // SLEW-LIMITED, which is what actually stops a slow sample rate turning
      // into a violent oscillation. See CMD_SLEW_PER_S.
      const frame = dt > 0 && dt < 0.5 ? dt : 1 / 60;
      const d = Math.min(frame, AP_STEP_MAX_S);

      // Smoothed frame time drives the de-tune, so jitter does not modulate the
      // gains. Seeded on the first frame rather than ramping up from zero.
      dtF = dtF > 0 ? dtF + (frame - dtF) * (1 - Math.exp(-frame / DT_FILTER_TAU)) : frame;
      tuneScale = clamp(TUNE_REF_DT / Math.max(dtF, TUNE_REF_DT), TUNE_MIN, 1);

      controlStep(d, state);

      const maxMove = CMD_SLEW_PER_S * frame;
      appliedRoll += clamp(cmdRoll - appliedRoll, -maxMove, maxMove);
      appliedPitch += clamp(cmdPitch - appliedPitch, -maxMove, maxMove);

      inputs.roll = appliedRoll;
      inputs.pitch = appliedPitch;
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

  /**
   * One fixed-rate pass of the control law. Writes cmdRoll / cmdPitch, which
   * update() then applies to `inputs` every frame.
   *
   * @param {number} d fixed step, seconds — always AP_STEP_S
   * @param {Object} state flight-model state
   */
  function controlStep(d, state) {

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
      const bankTarget = clamp(hdgErr * G.kHdgToBank, -G.maxBankDeg, G.maxBankDeg);
      const bankErr = bankTarget - rollDeg;

      bankI = clamp(bankI + bankErr * d * G.kBankI, -BANK_I_CLAMP, BANK_I_CLAMP);
      cmdRoll = clamp((bankErr * G.kBankP - rollRate * G.kBankD) * tuneScale + bankI, -1, 1);

      // --- vertical: altitude -> vertical speed -> elevator ------------------
      const altErr = altitudeBug - (state.altitudeFt ?? 0);
      let vsTarget = clamp(altErr * G.kAltToVs, -G.maxVsFpm, G.maxVsFpm);

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
      const room = (kts - G.vsFloorKts) / (G.vsProtectKts - G.vsFloorKts);
      if (room < 0) {
        vsTarget = Math.min(vsTarget, clamp(room, -1, 0) * G.maxVsFpm);
        if (pitchI > 0) pitchI = 0;
      } else if (vsTarget > 0) {
        vsTarget *= clamp(room, 0, 1);
      }

      // Stage 2: vertical-speed error asks for a PITCH ATTITUDE, not for an
      // elevator deflection. See the cascade note above — this is the stage
      // whose absence caused the porpoising.
      const vsErr = vsTarget - (state.verticalSpeedFpm ?? 0);
      let pitchTarget = clamp(
        vsErr * G.kVsToPitch,
        -G.maxPitchCmdDeg,
        G.maxPitchCmdDeg,
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
      pitchI = clamp(pitchI + pitchErr * d * G.kPitchI, -PITCH_I_CLAMP, PITCH_I_CLAMP);

      cmdPitch = clamp(
        (pitchErr * G.kPitchP - pitchRate * G.kPitchD) * tuneScale + pitchI,
        -1,
        1,
      );

      // Rudder: hold it neutral. The airframe already models adverse yaw and a
      // slipstream term; adding an uncalibrated coordination term on top of
      // those made it worse in testing, so the autopilot flies with its feet
      // on the floor and accepts a little slip in the turn. update() writes
      // inputs.yaw = 0 every frame.
  }
}
