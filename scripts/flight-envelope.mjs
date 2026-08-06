/**
 * flight-envelope.mjs — a headless test flight, with numbers.
 *
 *   node scripts/flight-envelope.mjs
 *
 * The flight model is the one part of this project whose correctness cannot be
 * judged by looking at it. A screenshot cannot tell you whether the stall is a
 * real loss of lift past a critical angle of attack or a speed clamp wearing a
 * costume, whether air density actually falls with altitude, or whether the
 * integrator survives a frame hitch. So: fly it, and print what happened.
 *
 * It imports src/physics/flightModel.js unmodified. That module pulls in three
 * and geo/coords.js, both of which are pure ESM with no DOM, so Node runs them
 * as-is. Keep it that way — a flight model that can only be exercised inside a
 * browser is a flight model nobody measures.
 *
 * Every section prints raw measurements and then a PASS/FAIL against a band
 * taken from the Cessna 172S POH. The bands are deliberately loose (this is a
 * light-single-class model, not a certified simulation) but they are bands, not
 * vibes: if the ground roll comes out at 40 m or the stall at 90 kt, that is a
 * bug and this file says so.
 */

import { createFlightModel } from '../src/physics/flightModel.js';
import {
  MS_TO_KTS,
  KTS_TO_MS,
  M_TO_FT,
  RHO_SEA_LEVEL,
  airDensity,
  clamp,
} from '../src/core/units.js';

// ---------------------------------------------------------------------------
// Harness plumbing
// ---------------------------------------------------------------------------

/** KBFI field elevation, metres. The real number: 21 ft. */
const FIELD_M = 6.4;

let failures = 0;
let checks = 0;

function head(title) {
  console.log(`\n\x1b[1m${title}\x1b[0m`);
  console.log('-'.repeat(title.length));
}

function say(label, value, unit = '') {
  console.log(`  ${label.padEnd(38)} ${String(value).padStart(12)} ${unit}`);
}

function band(label, value, lo, hi, unit = '') {
  checks++;
  const good = value >= lo && value <= hi;
  if (!good) failures++;
  const tag = good ? '\x1b[32m ok \x1b[0m' : '\x1b[31mFAIL\x1b[0m';
  const v = typeof value === 'number' ? value.toFixed(1) : value;
  console.log(
    `  ${tag} ${label.padEnd(38)} ${String(v).padStart(9)} ${unit.padEnd(5)}` +
      ` want ${lo}..${hi}`,
  );
}

function assert(label, cond, note = '') {
  checks++;
  if (!cond) failures++;
  const tag = cond ? '\x1b[32m ok \x1b[0m' : '\x1b[31mFAIL\x1b[0m';
  console.log(`  ${tag} ${label}${note ? `   (${note})` : ''}`);
}

/** Fresh model on flat ground at KBFI elevation. */
function makeModel(extra = {}) {
  return createFlightModel({
    groundHeightFn: () => FIELD_M,
    ...extra,
  });
}

const NEUTRAL = { pitch: 0, roll: 0, yaw: 0, throttle: 0, flaps: 0, brakes: 0 };
/** One reused input object — the flight model reads it field by field. */
const IN = { ...NEUTRAL };
function inputs(o) {
  IN.pitch = o.pitch ?? 0;
  IN.roll = o.roll ?? 0;
  IN.yaw = o.yaw ?? 0;
  IN.throttle = o.throttle ?? 0;
  IN.flaps = o.flaps ?? 0;
  IN.brakes = o.brakes ?? 0;
  return IN;
}

/** Step at a fixed frame rate for `seconds`, calling `fn(t)` each frame. */
function fly(model, seconds, control, opts = {}) {
  const hz = opts.hz ?? 60;
  const dt = 1 / hz;
  const n = Math.round(seconds * hz);
  const ground = opts.ground ?? (() => FIELD_M);
  for (let i = 0; i < n; i++) {
    const t = i * dt;
    const c = control(t, model.state, i);
    if (c === false) return t;
    model.step(dt, inputs(c || NEUTRAL), ground(model.state));
    if (opts.watch) opts.watch(t + dt, model.state);
  }
  return seconds;
}

/**
 * Inner loop: hold a pitch ATTITUDE in degrees. Proportional on the attitude
 * error, derivative on the measured pitch rate. Everything else in this file
 * commands through this, because a single-loop elevator-from-speed controller
 * excites the phugoid and then you are measuring the controller, not the
 * aeroplane.
 */
function pitchLoop(gain = 0.11, damp = 0.045) {
  let last = null;
  return (state, targetDeg, dt = 1 / 60) => {
    const rate = last === null ? 0 : (state.pitchDeg - last) / dt;
    last = state.pitchDeg;
    return clamp((targetDeg - state.pitchDeg) * gain - rate * damp, -1, 1);
  };
}

/**
 * Outer loop: hold a target airspeed by commanding pitch attitude. PI, because
 * the pitch attitude that holds a given speed depends on power and altitude and
 * a pure proportional loop leaves a standing speed error that reads as a bogus
 * climb rate.
 */
function speedHold(targetKts, opts = {}) {
  const inner = pitchLoop(opts.gain ?? 0.11, opts.damp ?? 0.045);
  const kp = opts.kp ?? 0.55;
  const ki = opts.ki ?? 0.20;
  let integ = 0;
  return (state, dt = 1 / 60) => {
    // Too fast -> pitch up. Too slow -> pitch down.
    const err = state.airspeedKts - targetKts;
    integ = clamp(integ + err * ki * dt, -25, 25);
    const target = clamp(err * kp + integ, -20, 25);
    return inner(state, target, dt);
  };
}

/** Hold an altitude in metres by commanding pitch attitude. */
function altHold(targetM, opts = {}) {
  const inner = pitchLoop(opts.gain ?? 0.11, opts.damp ?? 0.045);
  let integ = 0;
  return (state, dt = 1 / 60) => {
    const err = targetM - state.position.y;
    integ = clamp(integ + err * 0.02 * dt, -8, 8);
    // Climb-rate inner term: descending (vs < 0) must command nose UP.
    const target = clamp(err * 0.09 + integ - state.verticalSpeedMs * 1.6, -15, 18);
    return inner(state, target, dt);
  };
}

/** Keep the wings level and the ball roughly centred. */
function levelWings(state) {
  return clamp(-state.rollDeg * 0.05 - state.angularVelocity.z * -0.4, -1, 1);
}

// ===========================================================================
console.log('\n\x1b[1m=== FLIGHT MODEL ENVELOPE — headless test flight ===\x1b[0m');

// ---------------------------------------------------------------------------
head('0. airframe constants');
// ---------------------------------------------------------------------------
{
  const m = makeModel();
  const c = m.config;
  say('mass', c.massKg.toFixed(0), 'kg');
  say('wing area', c.wingAreaM2.toFixed(2), 'm^2');
  say('aspect ratio', c.aspectRatio.toFixed(2), '');
  say('CL_alpha', c.clAlphaPerRad.toFixed(3), '/rad');
  say('CL_max clean', c.clMaxClean.toFixed(3), '');
  say('CL_max full flap', c.clMaxFlapped.toFixed(3), '');
  say('Vs1 (clean, derived)', (c.stallSpeedCleanMs * MS_TO_KTS).toFixed(1), 'kt');
  say('Vs0 (full flap, derived)', (c.stallSpeedFlappedMs * MS_TO_KTS).toFixed(1), 'kt');
  say('Vne (advisory)', (c.vneMs * MS_TO_KTS).toFixed(1), 'kt');
  say('static gear squat', (c.staticSquatM * 1000).toFixed(1), 'mm');
  say('fixed substep', `1/${Math.round(1 / c.fixedDt)}`, 's');

  band('Vs1 clean', c.stallSpeedCleanMs * MS_TO_KTS, 44, 54, 'kt');
  band('Vs0 full flap', c.stallSpeedFlappedMs * MS_TO_KTS, 36, 46, 'kt');
  band('Vne', c.vneMs * MS_TO_KTS, 150, 175, 'kt');
}

// ---------------------------------------------------------------------------
head('1. air density falls with altitude (Rainier must matter)');
// ---------------------------------------------------------------------------
{
  for (const h of [0, 1000, 2500, 4392]) {
    const rho = airDensity(h);
    const sigma = rho / RHO_SEA_LEVEL;
    const lapse = clamp((sigma - 0.117) / 0.883, 0, 1);
    say(
      `${String(h).padStart(4)} m  rho / sigma / power`,
      `${rho.toFixed(4)} / ${sigma.toFixed(3)} / ${(lapse * 100).toFixed(0)}%`,
    );
  }
  band('sigma at Rainier summit 4392 m', airDensity(4392) / RHO_SEA_LEVEL, 0.60, 0.68, '');
  assert(
    'density is monotonically decreasing',
    airDensity(0) > airDensity(1000) &&
      airDensity(1000) > airDensity(2500) &&
      airDensity(2500) > airDensity(4392),
  );

  // The same model, same throttle, same TAS, at two altitudes — the only
  // difference is the air. If thrust and lift are density-scaled, level flight
  // high up needs more angle of attack.
  const lo = makeModel({ startAltitudeAglM: 300, startAirspeedMs: 40 });
  const hi = makeModel({ startAltitudeAglM: 3600, startAirspeedMs: 40 });
  for (const m of [lo, hi]) {
    const ctl = speedHold(78);
    fly(m, 120, (t, s) => ({ pitch: ctl(s), roll: levelWings(s), throttle: 1 }));
  }
  say('alpha at 300 m, full throttle', lo.state.alphaDeg.toFixed(2), 'deg');
  say('alpha at 3600 m, full throttle', hi.state.alphaDeg.toFixed(2), 'deg');
  say('climb rate at 300 m', lo.state.verticalSpeedFpm.toFixed(0), 'fpm');
  say('climb rate at 3600 m', hi.state.verticalSpeedFpm.toFixed(0), 'fpm');
  assert(
    'climb performance decays with altitude',
    hi.state.verticalSpeedFpm < lo.state.verticalSpeedFpm - 100,
    `${lo.state.verticalSpeedFpm.toFixed(0)} -> ${hi.state.verticalSpeedFpm.toFixed(0)} fpm`,
  );
}

// ---------------------------------------------------------------------------
head('2. sitting on the wheels');
// ---------------------------------------------------------------------------
{
  const m = makeModel();
  const s = m.state;
  const spawnAgl = s.altitudeAglFt;
  fly(m, 8, () => ({ brakes: 1 }));
  say('AGL at spawn', spawnAgl.toFixed(3), 'ft');
  say('AGL after 8 s parked', s.altitudeAglFt.toFixed(3), 'ft');
  say('MSL after 8 s parked', s.altitudeFt.toFixed(1), 'ft');
  say('gear compression', (s.gearCompressionM * 1000).toFixed(1), 'mm');
  say('pitch attitude', s.pitchDeg.toFixed(2), 'deg');
  say('ground speed', s.groundSpeedKts.toFixed(3), 'kt');
  say('load factor', s.loadFactor.toFixed(3), 'g');

  assert('onGround is true', s.onGround === true);
  assert('not stalled while parked', s.stalled === false);
  band('field elevation read back', s.altitudeFt, FIELD_M * M_TO_FT - 6, FIELD_M * M_TO_FT + 2, 'ft');
  band('parked load factor ~1 g', s.loadFactor, 0.9, 1.1, 'g');
  band('parked drift', s.groundSpeedKts, 0, 0.2, 'kt');
  band('parked AGL', s.altitudeAglFt, -0.6, 0.6, 'ft');
}

// ---------------------------------------------------------------------------
head('3. takeoff roll — it must need speed before it will fly');
// ---------------------------------------------------------------------------
let liftoffKts = 0;
{
  const m = makeModel();
  const s = m.state;
  const x0 = s.position.x;
  const z0 = s.position.z;

  let rotateAt = 0;
  let rollDist = 0;
  let liftT = 0;
  const ROTATE_KTS = 55;

  fly(m, 60, (t, st) => {
    if (!st.onGround && liftT === 0) {
      liftT = t;
      liftoffKts = st.airspeedKts;
      rollDist = Math.hypot(st.position.x - x0, st.position.z - z0);
      return false;
    }
    if (st.airspeedKts >= ROTATE_KTS && rotateAt === 0) rotateAt = t;
    return {
      throttle: 1,
      // Full aft stick from a standstill: if the model lets that fly, the
      // ground model is not carrying weight properly.
      pitch: st.airspeedKts >= ROTATE_KTS ? 0.55 : 0.15,
      yaw: 0, // no rudder — see the slipstream check below
    };
  });

  say('time to rotation speed', rotateAt.toFixed(1), 's');
  say('rotate speed', ROTATE_KTS.toFixed(0), 'kt');
  say('liftoff speed', liftoffKts.toFixed(1), 'kt');
  say('time to liftoff', liftT.toFixed(1), 's');
  say('ground roll', rollDist.toFixed(0), 'm');
  say('ground roll', (rollDist * M_TO_FT).toFixed(0), 'ft');

  band('ground roll', rollDist, 150, 450, 'm');
  band('liftoff speed', liftoffKts, 48, 70, 'kt');
  band('time to liftoff', liftT, 8, 30, 's');
}

// ---------------------------------------------------------------------------
head('4. it must NOT fly below rotation speed');
// ---------------------------------------------------------------------------
{
  const m = makeModel();
  let maxAgl = -99;
  let maxKt = 0;
  // Full aft stick, half throttle, and enough brake to hold it near taxi speed.
  fly(m, 30, (t, s) => {
    maxAgl = Math.max(maxAgl, s.altitudeAglFt);
    maxKt = Math.max(maxKt, s.airspeedKts);
    return { throttle: 0.5, pitch: 1, brakes: s.airspeedKts > 25 ? 1 : 0 };
  });
  say('max speed reached', maxKt.toFixed(1), 'kt');
  say('max AGL with full aft stick', maxAgl.toFixed(2), 'ft');
  assert(
    'full aft stick at taxi speed does not levitate it',
    maxAgl < 3,
    `${maxAgl.toFixed(2)} ft`,
  );
}

// ---------------------------------------------------------------------------
head('5. brakes and rolling friction');
// ---------------------------------------------------------------------------
{
  // Accelerate to 40 kt, chop the throttle, stand on the brakes.
  const m = makeModel();
  const s = m.state;
  fly(m, 60, (t, st) => (st.airspeedKts >= 40 ? false : { throttle: 1 }));
  const vBrake = s.airspeedKts;
  const xB = s.position.x;
  const zB = s.position.z;
  let tStop = 0;
  tStop = fly(m, 40, (t, st) =>
    st.groundSpeedKts < 0.5 ? false : { throttle: 0, brakes: 1 },
  );
  const stopDist = Math.hypot(s.position.x - xB, s.position.z - zB);
  say('brake entry speed', vBrake.toFixed(1), 'kt');
  say('braking distance', stopDist.toFixed(0), 'm');
  say('time to stop', tStop.toFixed(1), 's');
  say('mean decel', ((vBrake * KTS_TO_MS) / Math.max(tStop, 0.01) / 9.80665).toFixed(2), 'g');
  band('braking distance from 40 kt', stopDist, 25, 140, 'm');

  // Rolling friction alone: no brakes, idle, from 30 kt.
  const r = makeModel();
  fly(r, 60, (t, st) => (st.airspeedKts >= 30 ? false : { throttle: 1 }));
  const vRoll = r.state.airspeedKts;
  const tRoll = fly(r, 120, (t, st) =>
    st.groundSpeedKts < 3 ? false : { throttle: 0 },
  );
  say('idle rollout from 30 kt', tRoll.toFixed(1), 's');
  assert('rolling friction is small but real', tRoll > 8 && tRoll < 200, `${tRoll.toFixed(1)} s`);
  assert('brakes beat rolling friction handily', tStop * 3 < tRoll, `${tStop.toFixed(1)} vs ${tRoll.toFixed(1)} s`);
}

// ---------------------------------------------------------------------------
head('6. climb — Vy and rate');
// ---------------------------------------------------------------------------
{
  // Steady climb takes a while to settle, and a snapshot of the vertical speed
  // catches whatever phase of the phugoid it happens to be in. Fly 150 s and
  // average the last 40.
  const rows = [];
  for (const kts of [55, 60, 65, 70, 75, 80, 90, 100, 110]) {
    const m = makeModel({ startAltitudeAglM: 400, startAirspeedMs: kts * KTS_TO_MS });
    const ctl = speedHold(kts);
    let sum = 0;
    let n = 0;
    let kSum = 0;
    let aSum = 0;
    fly(m, 150, (t, s) => {
      if (t > 110) {
        sum += s.verticalSpeedFpm;
        kSum += s.airspeedKts;
        aSum += s.alphaDeg;
        n++;
      }
      return { pitch: ctl(s), roll: levelWings(s), throttle: 1 };
    });
    rows.push({ kts, fpm: sum / n, got: kSum / n, alpha: aSum / n });
  }
  console.log('     target   actual    alpha     climb (mean of last 40 s)');
  for (const r of rows) {
    console.log(
      `     ${String(r.kts).padStart(3)} kt  ${r.got.toFixed(1).padStart(6)} kt` +
        `  ${r.alpha.toFixed(1).padStart(5)} deg  ${r.fpm.toFixed(0).padStart(6)} fpm`,
    );
  }
  const best = rows.reduce((a, b) => (b.fpm > a.fpm ? b : a));
  say('best rate of climb', best.fpm.toFixed(0), 'fpm');
  say('at airspeed', best.got.toFixed(1), 'kt');
  band('best rate of climb', best.fpm, 550, 950, 'fpm');
  band('Vy', best.got, 60, 90, 'kt');
}

// ---------------------------------------------------------------------------
head('7. cruise — level speed vs throttle');
// ---------------------------------------------------------------------------
{
  console.log('     throttle   speed     alpha    vert spd   (2000 ft, altitude held)');
  const results = [];
  for (const thr of [0.55, 0.65, 0.75, 0.85, 1.0]) {
    const m = makeModel({ startAltitudeAglM: 600, startAirspeedMs: 55 });
    // Hold altitude, let the speed settle wherever the power puts it.
    const ctl = altHold(m.state.position.y);
    let kSum = 0;
    let aSum = 0;
    let vSum = 0;
    let n = 0;
    fly(m, 260, (t, s) => {
      if (t > 200) {
        kSum += s.airspeedKts;
        aSum += s.alphaDeg;
        vSum += s.verticalSpeedFpm;
        n++;
      }
      return { pitch: ctl(s), roll: levelWings(s), throttle: thr };
    });
    const r = { thr, kt: kSum / n, a: aSum / n, vs: vSum / n };
    results.push(r);
    console.log(
      `       ${(thr * 100).toFixed(0).padStart(3)}%   ${r.kt.toFixed(1).padStart(6)} kt` +
        `  ${r.a.toFixed(1).padStart(5)} deg  ${r.vs.toFixed(0).padStart(6)} fpm`,
    );
  }
  const cruise = results.find((r) => r.thr === 0.75);
  const vmax = results.find((r) => r.thr === 1.0);
  band('cruise speed at 75% power', cruise.kt, 95, 125, 'kt');
  band('max level speed', vmax.kt, 110, 145, 'kt');
  assert(
    'speed rises monotonically with throttle',
    results.every((r, i) => i === 0 || r.kt > results[i - 1].kt - 1),
  );
}

// ---------------------------------------------------------------------------
head('8. THE STALL — a real break past critical alpha, not a speed clamp');
// ---------------------------------------------------------------------------
{
  // Power-off, 1-g deceleration to the break, from 1500 m. Pull steadily.
  const m = makeModel({ startAltitudeAglM: 1500, startAirspeedMs: 45 });
  const s = m.state;
  const trace = [];
  let broke = null;
  let peakAlpha = 0;
  let clAtPeak = 0;

  // Textbook power-off stall entry: idle, wings level, and raise the nose at
  // about 1.5 deg/s until the wing lets go. No speed target anywhere — the
  // aeroplane decides when it stalls.
  const inner = pitchLoop(0.13, 0.05);
  const stallCtl = (st, t) => inner(st, Math.min(-1 + t * 1.5, 26));
  fly(m, 60, (t, st) => {
    // Record the lift coefficient the model is actually producing.
    const rho = airDensity(st.position.y);
    const qS = 0.5 * rho * st.airspeedMs * st.airspeedMs * 16.2;
    const cl = qS > 1 ? (st.loadFactor * 1100 * 9.80665) / qS : 0;
    trace.push({ t, kt: st.indicatedAirspeedKts, a: st.alphaDeg, cl, sep: st.separation });
    if (st.alphaDeg > peakAlpha) {
      peakAlpha = st.alphaDeg;
      clAtPeak = cl;
    }
    if (st.stalled && !broke) {
      broke = {
        t,
        kt: st.indicatedAirspeedKts,
        tas: st.airspeedKts,
        a: st.alphaDeg,
        alt: st.altitudeFt,
        cl,
      };
    }
    if (broke && t > broke.t + 6) return false;
    // Keep pulling INTO the stall. If this recovers the aeroplane, the model
    // is lying about what a stall is.
    return { pitch: broke ? 1 : stallCtl(st, t), roll: levelWings(st), throttle: 0 };
  });

  if (!broke) {
    assert('the wing stalls at all', false, 'never set state.stalled');
  } else {
    say('stall break at IAS', broke.kt.toFixed(1), 'kt');
    say('stall break at TAS', broke.tas.toFixed(1), 'kt');
    say('alpha at the break', broke.a.toFixed(1), 'deg');
    say('CL at the break', broke.cl.toFixed(3), '');
    say('peak alpha reached', peakAlpha.toFixed(1), 'deg');
    say('separation fraction now', s.separation.toFixed(3), '');
    say('altitude at break', broke.alt.toFixed(0), 'ft');
    say('altitude 6 s later', s.altitudeFt.toFixed(0), 'ft');
    say('lost in 6 s of holding it', (broke.alt - s.altitudeFt).toFixed(0), 'ft');
    say('vertical speed now', s.verticalSpeedFpm.toFixed(0), 'fpm');

    band('stall break IAS (clean, power off)', broke.kt, 42, 58, 'kt');
    band('alpha at the break', broke.a, 13, 22, 'deg');

    // The decisive test. A speed clamp cannot do this: past the break, MORE
    // back stick must produce LESS lift and MORE descent.
    const beforeIdx = trace.findIndex((r) => r.t >= broke.t - 1.5);
    const before = trace[Math.max(0, beforeIdx)];
    const after = trace[trace.length - 1];
    say('CL 1.5 s before the break', before.cl.toFixed(3), '');
    say('CL after 6 s of full aft stick', after.cl.toFixed(3), '');
    assert(
      'CL COLLAPSES past the break (not a speed clamp)',
      after.cl < before.cl * 0.85,
      `${before.cl.toFixed(2)} -> ${after.cl.toFixed(2)}`,
    );
    assert(
      'holding full aft stick does not recover it',
      s.stalled === true && s.verticalSpeedFpm < -300,
      `${s.verticalSpeedFpm.toFixed(0)} fpm, stalled=${s.stalled}`,
    );
    assert(
      'separation fraction is a real number in 0..1',
      s.separation > 0.05 && s.separation <= 1,
      s.separation.toFixed(3),
    );

    // --- recovery: unload, and it must fly again --------------------------
    const altAtRecoveryStart = s.altitudeFt;
    let recoveredAt = null;
    const recover = pitchLoop(0.09, 0.045);
    fly(m, 40, (t, st) => {
      if (!st.stalled && recoveredAt === null) recoveredAt = t;
      if (recoveredAt !== null && t > recoveredAt + 12) return false;
      // Push to unload the wing, then feed in power and level off.
      const p = recoveredAt === null ? -0.55 : recover(st, 2);
      return { pitch: p, roll: levelWings(st), throttle: 1 };
    });
    say('time to recover after unloading', recoveredAt === null ? 'never' : recoveredAt.toFixed(1), 's');
    say('altitude lost in the recovery', (altAtRecoveryStart - s.altitudeFt).toFixed(0), 'ft');
    say('airspeed after recovery', s.airspeedKts.toFixed(1), 'kt');
    say('vertical speed after recovery', s.verticalSpeedFpm.toFixed(0), 'fpm');
    assert('unloading the wing recovers it', recoveredAt !== null && recoveredAt < 8);
    assert('flying again afterwards', !s.stalled && s.airspeedKts > 50, `${s.airspeedKts.toFixed(0)} kt`);
    band('total height lost in the stall', altAtRecoveryStart - s.altitudeFt, -50, 900, 'ft');
  }
}

// ---------------------------------------------------------------------------
head('9. accelerated stall — the break follows ALPHA, not speed');
// ---------------------------------------------------------------------------
{
  // Roll into a steep bank at cruise speed and haul. If the stall is a speed
  // threshold this cannot possibly happen: the aeroplane is doing 90 kt.
  const m = makeModel({ startAltitudeAglM: 2000, startAirspeedMs: 48 });
  const s = m.state;
  let brokeKt = null;
  let brokeG = 0;
  let brokeAlpha = 0;
  fly(m, 30, (t, st) => {
    if (st.stalled && brokeKt === null) {
      brokeKt = st.indicatedAirspeedKts;
      brokeG = st.loadFactor;
      brokeAlpha = st.alphaDeg;
      return false;
    }
    return {
      pitch: t < 2 ? 0 : 0.85,
      roll: st.rollDeg < 55 ? 0.8 : 0.05,
      throttle: 1,
    };
  });
  if (brokeKt === null) {
    assert('an accelerated stall is reachable', false, 'never stalled in a 55 deg bank');
  } else {
    say('accelerated stall at IAS', brokeKt.toFixed(1), 'kt');
    say('load factor at the break', brokeG.toFixed(2), 'g');
    say('alpha at the break', brokeAlpha.toFixed(1), 'deg');
    assert(
      'stalls well ABOVE the 1-g stall speed',
      brokeKt > 52,
      `${brokeKt.toFixed(1)} kt vs Vs1 ~48.6 kt`,
    );
    band('load factor at the accelerated break', brokeG, 1.2, 4.5, 'g');
    band('alpha at the accelerated break', brokeAlpha, 13, 22, 'deg');
  }
}

// ---------------------------------------------------------------------------
head('10. flaps');
// ---------------------------------------------------------------------------
{
  // Same approach, clean and dirty: full flap must stall slower and sink faster.
  const out = [];
  for (const fl of [0, 1]) {
    const m = makeModel({ startAltitudeAglM: 1500, startAirspeedMs: 38 });
    const s = m.state;
    let broke = null;
    const inner = pitchLoop(0.13, 0.05);
    fly(m, 90, (t, st) => {
      if (st.stalled && !broke) {
        broke = { kt: st.indicatedAirspeedKts, a: st.alphaDeg };
        return false;
      }
      // 10 s to let the flaps run out to the detent, then raise the nose.
      const target = t < 10 ? -2 : Math.min(-2 + (t - 10) * 1.5, 26);
      return { pitch: inner(st, target), roll: levelWings(st), throttle: 0, flaps: fl };
    });
    out.push({ fl, broke, pos: s.flapsPos });
  }
  const clean = out[0].broke;
  const dirty = out[1].broke;
  say('flap position commanded 1.0 reached', out[1].pos.toFixed(2), '');
  if (clean && dirty) {
    say('stall IAS clean', clean.kt.toFixed(1), 'kt');
    say('stall IAS full flap', dirty.kt.toFixed(1), 'kt');
    say('difference', (clean.kt - dirty.kt).toFixed(1), 'kt');
    assert('flaps lower the stall speed', dirty.kt < clean.kt - 3, `${clean.kt.toFixed(1)} -> ${dirty.kt.toFixed(1)} kt`);
    band('full-flap stall IAS', dirty.kt, 35, 48, 'kt');
  } else {
    assert('both configurations stall', false);
  }

  // Blow-back: commanding flaps above Vfe (85 kt) must not extend them. Hold
  // the speed properly — free-stick it decelerates through Vfe and the test
  // measures nothing.
  const fast = makeModel({ startAltitudeAglM: 1500, startAirspeedMs: 62 });
  const fctl = speedHold(120);
  let minKtFast = 999;
  fly(fast, 30, (t, s) => {
    minKtFast = Math.min(minKtFast, s.airspeedKts);
    return { pitch: fctl(s), roll: levelWings(s), throttle: 1, flaps: 1 };
  });
  say('speed held for the blow-back test', fast.state.airspeedKts.toFixed(1), 'kt');
  say('minimum speed seen during it', minKtFast.toFixed(1), 'kt');
  say('flap position commanded 1.0 at 120 kt', fast.state.flapsPos.toFixed(3), '');
  assert('flaps blow back above Vfe', fast.state.flapsPos < 0.1, fast.state.flapsPos.toFixed(3));
}

// ---------------------------------------------------------------------------
head('11. integration — fixed substep, frame hitches, and 20 vs 200 Hz');
// ---------------------------------------------------------------------------
{
  const control = (t) => ({ throttle: 1, pitch: 0.1 * Math.sin(t * 0.7), roll: 0.2 * Math.sin(t * 0.31) });

  const ref = makeModel({ startAltitudeAglM: 800, startAirspeedMs: 45 });
  fly(ref, 30, (t) => control(t), { hz: 200 });

  const slow = makeModel({ startAltitudeAglM: 800, startAirspeedMs: 45 });
  fly(slow, 30, (t) => control(t), { hz: 20 });

  const d = ref.state.position.distanceTo(slow.state.position);
  say('position after 30 s at 200 Hz', fmtV(ref.state.position), 'm');
  say('position after 30 s at 20 Hz', fmtV(slow.state.position), 'm');
  say('divergence over 30 s', d.toFixed(1), 'm');
  say('speed 200 Hz / 20 Hz', `${ref.state.airspeedKts.toFixed(1)} / ${slow.state.airspeedKts.toFixed(1)}`, 'kt');
  band('frame-rate divergence over 30 s', d, 0, 60, 'm');

  // A frame hitch: one enormous dt. The contract clamps it to 0.1 s, so the
  // model must survive and stay finite rather than teleport or NaN.
  const hitch = makeModel({ startAltitudeAglM: 800, startAirspeedMs: 45 });
  fly(hitch, 10, () => ({ throttle: 1 }));
  const before = hitch.state.position.clone();
  for (const bigDt of [0.5, 2.0, 1e6, NaN, -3]) {
    hitch.step(bigDt, inputs({ throttle: 1, pitch: 1, roll: 1 }), FIELD_M);
  }
  const jump = hitch.state.position.distanceTo(before);
  say('displacement from 5 pathological frames', jump.toFixed(1), 'm');
  assert('no NaN after pathological dt', finiteState(hitch.state));
  assert('no teleport from a frame hitch', jump < 60, `${jump.toFixed(1)} m`);

  // A garbage ground height must not launch it either.
  const bad = makeModel();
  fly(bad, 3, () => ({ throttle: 0.2 }), { ground: () => FIELD_M });
  bad.step(1 / 60, inputs({ throttle: 0.2 }), NaN);
  bad.step(1 / 60, inputs({ throttle: 0.2 }), FIELD_M);
  assert('NaN ground height is survivable', finiteState(bad.state));
}

// ---------------------------------------------------------------------------
head('12. hard landing — the gear must absorb, not launch');
// ---------------------------------------------------------------------------
{
  // Fly it onto the runway and see what the gear does.
  // startAltitudeAglM is measured at the WHEELS, so 50 mm means the tyres are
  // 50 mm off the surface and gravity cannot add sink rate before the contact
  // we are trying to measure. (Dropping it from 8 m instead turns a 700 fpm
  // arrival into a 2,500 fpm one and the model is blamed for the harness.)
  //
  // The bands come from FAR 23.473, which is where landing gear numbers come
  // from: a light single's gear is designed to a 7 fps (420 fpm) LIMIT sink
  // speed and a 10 fps (600 fpm) ultimate. So ~2 g for a firm arrival and
  // something distinctly unpleasant at 700 fpm is not a bug — that IS a hard
  // landing. What would be a bug is 700 fpm feeling the same as 200.
  const runs = [];
  for (const fpm of [200, 400, 700]) {
    const m = makeModel({ startAltitudeAglM: 0.05, startAirspeedMs: 30 });
    const s = m.state;
    s.velocity.y = -fpm / 196.85039370078738;
    let peakG = 0;
    let maxBounce = 0;
    let touched = false;
    let maxStroke = 0;
    fly(m, 20, (t, st) => {
      peakG = Math.max(peakG, st.loadFactor);
      maxStroke = Math.max(maxStroke, st.gearCompressionM);
      if (st.onGround) touched = true;
      if (touched) maxBounce = Math.max(maxBounce, st.altitudeAglFt);
      return { throttle: 0, pitch: 0.1, brakes: 0.3 };
    });
    runs.push({ fpm, peakG, maxBounce, stroke: maxStroke, s });
    console.log(
      `     ${String(fpm).padStart(3)} fpm arrival:  peak ${peakG.toFixed(2)} g` +
        `   gear stroke ${(maxStroke * 100).toFixed(1)} cm` +
        `   bounce ${maxBounce.toFixed(2)} ft` +
        `   settled AGL ${s.altitudeAglFt.toFixed(2)} ft`,
    );
  }
  const soft = runs[0];
  const firm = runs[1];
  const hard = runs[2];
  band('peak g on a 200 fpm (normal) touchdown', soft.peakG, 1.0, 2.2, 'g');
  band('peak g on a 400 fpm (firm) touchdown', firm.peakG, 1.4, 3.5, 'g');
  band('peak g on a 700 fpm (hard) arrival', hard.peakG, 2.5, 6.0, 'g');
  assert(
    'a hard landing hurts more than a soft one',
    hard.peakG > firm.peakG && firm.peakG > soft.peakG,
    `${soft.peakG.toFixed(1)} / ${firm.peakG.toFixed(1)} / ${hard.peakG.toFixed(1)} g`,
  );
  for (const r of runs) {
    band(`${r.fpm} fpm: bounce`, r.maxBounce, 0, 4, 'ft');
    assert(`${r.fpm} fpm: it stays down afterwards`, r.s.onGround === true);
    assert(`${r.fpm} fpm: nothing went non-finite`, finiteState(r.s));
  }
}

// ---------------------------------------------------------------------------
head('13. glide, trim and hands-off behaviour');
// ---------------------------------------------------------------------------
{
  // Power off, hands off. A statically stable aeroplane phugoids and settles;
  // it does not diverge.
  const m = makeModel({ startAltitudeAglM: 2000, startAirspeedMs: 46 });
  const s = m.state;
  let minKt = 999;
  let maxKt = 0;
  const alt0 = s.position.y;
  const x0 = s.position.x;
  const z0 = s.position.z;
  fly(m, 90, (t, st) => {
    minKt = Math.min(minKt, st.airspeedKts);
    maxKt = Math.max(maxKt, st.airspeedKts);
    return { throttle: 0, roll: levelWings(st) };
  });
  const drop = alt0 - s.position.y;
  const dist = Math.hypot(s.position.x - x0, s.position.z - z0);
  say('hands-off speed range over 90 s', `${minKt.toFixed(0)}..${maxKt.toFixed(0)}`, 'kt');
  say('glide distance', (dist / 1000).toFixed(2), 'km');
  say('height lost', drop.toFixed(0), 'm');
  say('glide ratio', (dist / Math.max(drop, 1)).toFixed(1), ': 1');
  say('rpm windmilling at idle', s.rpm.toFixed(0), '');
  band('power-off glide ratio', dist / Math.max(drop, 1), 6, 14, ': 1');
  assert('the phugoid does not diverge', maxKt < 130 && minKt > 30, `${minKt.toFixed(0)}..${maxKt.toFixed(0)} kt`);
  assert('a windmilling prop still turns', s.rpm > 400, s.rpm.toFixed(0));

  // Hands-off trim speed with cruise power.
  const tr = makeModel({ startAltitudeAglM: 2000, startAirspeedMs: 46 });
  fly(tr, 200, (t, st) => ({ throttle: 0.65, roll: levelWings(st) }));
  say('hands-off speed at 65% power', tr.state.airspeedKts.toFixed(1), 'kt');
  band('hands-off trim speed', tr.state.airspeedKts, 70, 115, 'kt');
}

// ---------------------------------------------------------------------------
head('14. display fields agree with the metric primaries');
// ---------------------------------------------------------------------------
{
  const m = makeModel({ startAltitudeAglM: 1200, startAirspeedMs: 52 });
  fly(m, 20, (t, s) => ({ throttle: 0.8, pitch: 0.05, roll: 0.1 }));
  const s = m.state;
  const eps = (a, b, tol) => Math.abs(a - b) <= tol;
  // Both altitudes are taken at the WHEELS, which sit gearHeightM below the
  // physics datum. That is what makes a parked aeroplane read field elevation
  // instead of field elevation + 4 ft.
  const GEAR_H = m.config.gearHeightM;
  assert('airspeedKts == airspeedMs * MS_TO_KTS', eps(s.airspeedKts, s.airspeedMs * MS_TO_KTS, 1e-6));
  assert('altitudeFt == (y - gearHeight) * M_TO_FT', eps(s.altitudeFt, (s.position.y - GEAR_H) * M_TO_FT, 1e-6));
  assert('altitudeAglFt == (y - gearHeight - ground) * M_TO_FT', eps(s.altitudeAglFt, (s.position.y - GEAR_H - FIELD_M) * M_TO_FT, 1e-6));
  assert('verticalSpeedFpm == velocity.y * MS_TO_FPM', eps(s.verticalSpeedFpm, s.velocity.y * 196.85039370078738, 1e-6));
  assert('IAS < TAS above sea level', s.indicatedAirspeedKts < s.airspeedKts, `${s.indicatedAirspeedKts.toFixed(1)} < ${s.airspeedKts.toFixed(1)}`);
  assert('heading is in 0..360', s.headingDeg >= 0 && s.headingDeg < 360, s.headingDeg.toFixed(1));
  assert('lat/lon are in the Puget Sound region', s.lat > 46 && s.lat < 49 && s.lon > -124 && s.lon < -121, `${s.lat.toFixed(4)}, ${s.lon.toFixed(4)}`);
  assert('flaps mirrored onto state for the HUD', Number.isFinite(s.flaps), String(s.flaps));
  assert('brakes mirrored onto state for the HUD', Number.isFinite(s.brakes), String(s.brakes));
  say('lat / lon', `${s.lat.toFixed(5)}, ${s.lon.toFixed(5)}`, '');
  say('heading', s.headingDeg.toFixed(1), 'deg');
  say('IAS / TAS', `${s.indicatedAirspeedKts.toFixed(1)} / ${s.airspeedKts.toFixed(1)}`, 'kt');
}

// ---------------------------------------------------------------------------
head('15. reset() puts it back on the wheels at a real place');
// ---------------------------------------------------------------------------
{
  const m = makeModel();
  fly(m, 25, () => ({ throttle: 1, pitch: 0.4 }));
  const flying = { alt: m.state.altitudeFt, kt: m.state.airspeedKts };
  m.reset();
  const s = m.state;
  say('before reset', `${flying.alt.toFixed(0)} ft, ${flying.kt.toFixed(0)} kt`, '');
  say('after reset', `${s.altitudeFt.toFixed(1)} ft, ${s.airspeedKts.toFixed(1)} kt`, '');
  say('after reset lat/lon', `${s.lat.toFixed(5)}, ${s.lon.toFixed(5)}`, '');
  say('after reset heading', s.headingDeg.toFixed(2), 'deg');
  band('reset AGL', s.altitudeAglFt, -0.6, 0.6, 'ft');
  band('reset speed', s.airspeedKts, -0.01, 0.01, 'kt');
  band('reset heading (KBFI 32L)', s.headingDeg, 329, 331, 'deg');
  assert('reset clears the stall flag', s.stalled === false);

  // reset() to somewhere else entirely.
  m.reset(46.8517, -121.7603, 90);
  say('reset to Rainier lat/lon', `${s.lat.toFixed(4)}, ${s.lon.toFixed(4)}`, '');
  band('reset(lat) honoured', s.lat, 46.8516, 46.8518, 'deg');
  band('reset(heading) honoured', s.headingDeg, 89.9, 90.1, 'deg');
}

// ---------------------------------------------------------------------------
function fmtV(v) {
  return `${v.x.toFixed(0)}, ${v.y.toFixed(0)}, ${v.z.toFixed(0)}`;
}

function finiteState(s) {
  return (
    Number.isFinite(s.position.x) && Number.isFinite(s.position.y) && Number.isFinite(s.position.z) &&
    Number.isFinite(s.velocity.x) && Number.isFinite(s.velocity.y) && Number.isFinite(s.velocity.z) &&
    Number.isFinite(s.airspeedMs) && Number.isFinite(s.alphaRad) &&
    Number.isFinite(s.orientation.x) && Number.isFinite(s.orientation.w) &&
    Number.isFinite(s.angularVelocity.x) && Number.isFinite(s.headingDeg)
  );
}

console.log(
  failures
    ? `\n\x1b[31m${failures} of ${checks} checks FAILED\x1b[0m\n`
    : `\n\x1b[32mall ${checks} envelope checks passed\x1b[0m\n`,
);
process.exit(failures ? 1 : 0);
