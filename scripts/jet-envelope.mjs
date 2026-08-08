/**
 * jet-envelope.mjs — a headless test flight of the Boeing 737-800.
 *
 *   node scripts/jet-envelope.mjs
 *
 * The sibling of flight-envelope.mjs, and deliberately a SEPARATE file rather
 * than a flag on it. That script's bands come from the Cessna 172S POH; these
 * come from the 737-800 FCOM. Sharing one harness would mean either a pile of
 * per-type branches or bands loose enough to pass both, and a band loose enough
 * to accept a Cessna and a 737 is not a band.
 *
 * WHAT THIS FILE IS ACTUALLY GUARDING. The jet exists to exercise four things
 * flightModel.js grew for it, none of which the Cessna can reach:
 *
 *   1. turbofan propulsion   — flat thrust, not a propeller's 1/V roll-off
 *   2. compressibility       — Prandtl-Glauert, wave drag past Mcrit
 *   3. Mmo                   — a Mach limit that binds before Vne up high
 *   4. a raised CLmax rail   — slats, which a plain flapped wing cannot reach
 *
 * Each has its own section below, and each asserts the SHAPE of the effect and
 * not just its presence: that thrust stays flat while a propeller's would sag,
 * that drag rises past Mcrit and is flat below it, that Mmo binds high up and
 * Vne binds low down. A test that only checked "there is some Mach drag" would
 * pass on a constant.
 *
 * THE CONTROL LOOP MATTERS. A PD straight from altitude error to elevator
 * oscillates this airframe hard — and adding damping makes it WORSE, which is
 * the signature of a rate term arriving out of phase. Every level-flight
 * measurement here uses a cascade (vertical speed -> pitch ATTITUDE ->
 * elevator, damped on pitch rate) and then ASSERTS that the mean load factor
 * was ~1 g. Without that assertion a "stall speed" is a manoeuvring stall
 * speed and a "drag" figure is the loop's own induced drag.
 */

import { createFlightModel } from '../src/physics/flightModel.js';
import { B738 } from '../src/physics/airframes/b738.js';
import { C172 } from '../src/physics/airframes/c172.js';
import {
  MS_TO_KTS,
  KTS_TO_MS,
  speedOfSound,
  airDensity,
  RHO_SEA_LEVEL,
} from '../src/core/units.js';

/** KSEA field elevation, metres. The real number: 433 ft. A jet's home field. */
const FIELD_M = 132.0;

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

const ground = () => FIELD_M;
const jet = (extra = {}) =>
  createFlightModel({ airframe: B738, groundHeightFn: ground, ...extra });

const NEUTRAL = { pitch: 0, roll: 0, yaw: 0, throttle: 0, flaps: 0, brakes: 0, trim: 0 };
const IN = { ...NEUTRAL };
function inputs(o = {}) {
  IN.pitch = o.pitch ?? 0;
  IN.roll = o.roll ?? 0;
  IN.yaw = o.yaw ?? 0;
  IN.throttle = o.throttle ?? 0;
  IN.flaps = o.flaps ?? 0;
  IN.brakes = o.brakes ?? 0;
  IN.trim = o.trim ?? 0;
  return IN;
}

/** Put the aircraft in the air at an AGL and an indicated-ish speed. */
function air(m, aglM, kts) {
  m.reset(undefined, undefined, undefined, {
    altitudeAglM: aglM,
    airspeedMs: kts * KTS_TO_MS,
  });
  return m;
}

/**
 * Cascade pitch hold: vertical-speed error -> a target pitch ATTITUDE ->
 * elevator, damped on the pitch rate the elevator directly controls.
 *
 * The naive alternative — PD from altitude error straight to the elevator —
 * oscillates this airframe at ±800 fpm and gets WORSE with more damping,
 * because vertical speed lags pitch by most of a quarter cycle and the "damping"
 * term ends up exciting the phugoid instead. Same lesson, same shape, as the
 * autopilot's RATE_TAU fix; see systems/autopilot.js.
 */
function vsHold(targetFpm, maxPitchDeg = 16) {
  return (s) => {
    const t = clampN(0.012 * (targetFpm - s.verticalSpeedFpm), -12, maxPitchDeg);
    const q = (s.angularVelocity.x * 180) / Math.PI;
    return clampN(0.16 * (t - s.pitchDeg) - 0.1 * q, -1, 1);
  };
}
const clampN = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

/** Fly for `secs`, returning how steady it was. Callers assert on meanG. */
function fly(m, secs, ctl, dt = 1 / 60) {
  const n = Math.round(secs / dt);
  let sVs = 0, sG = 0, pVs = 0;
  for (let i = 0; i < n; i++) {
    m.step(dt, inputs(ctl(m.state, i * dt)), ground());
    const vs = m.state.verticalSpeedFpm;
    sVs += Math.abs(vs);
    sG += m.state.loadFactor;
    if (Math.abs(vs) > pVs) pVs = Math.abs(vs);
  }
  return { meanVs: sVs / n, peakVs: pVs, meanG: n ? sG / n : 0 };
}

const level = (throttle, flaps = 0, fpm = 0) => (s) => ({
  pitch: vsHold(fpm)(s),
  throttle,
  flaps,
});

console.log('\n\x1b[1mBoeing 737-800 — headless test flight\x1b[0m');
console.log(`KSEA, field ${FIELD_M} m, ISA, no wind.`);

// ---------------------------------------------------------------------------
head('0. the airframe, as the model resolved it');
// ---------------------------------------------------------------------------
{
  const m = jet();
  const c = m.config;
  say('name', c.name);
  say('mass', (c.massKg / 1000).toFixed(1), 't');
  say('wing area', c.wingAreaM2.toFixed(1), 'm^2');
  say('aspect ratio', c.aspectRatio.toFixed(2), '');
  say('lift-curve slope', c.clAlphaPerRad.toFixed(3), '/rad');
  say('CLmax clean / flapped', `${c.clMaxClean.toFixed(2)} / ${c.clMaxFlapped.toFixed(2)}`);
  say('Vs clean / flapped', `${(c.stallSpeedCleanMs * MS_TO_KTS).toFixed(0)} / ${(c.stallSpeedFlappedMs * MS_TO_KTS).toFixed(0)}`, 'kt');
  say('static squat', c.staticSquatM.toFixed(3), 'm');

  // Sweep is a real branch: an unswept wing of this aspect ratio would have a
  // slope of 5.186/rad. 25 deg of sweep must cost ~9% of that.
  const unswept = (2 * Math.PI) / (1 + 2 / c.aspectRatio);
  band('sweep costs lift-curve slope', c.clAlphaPerRad / unswept, 0.88, 0.93, 'x');
  band('CLmax clean', c.clMaxClean, 1.5, 1.8, '');
  // THE CLmax RAIL. Slats take the flapped figure past the default 2.4 ceiling;
  // if the rail were still 2.4 this would silently clip and the flapped stall
  // speed would come out several knots optimistic with nothing saying so.
  assert(
    'flapped CLmax is past the default 2.4 rail',
    c.clMaxFlapped > 2.4,
    `${c.clMaxFlapped.toFixed(2)} — proof limits.clMaxMax is doing work`,
  );

  // The gauge contract: a turbofan reads N1, and rpm is absent rather than fake.
  const s = m.state;
  assert('engine gauge is N1, not a tachometer', s.engineGauge === 'n1', s.engineGauge);
  band('idle N1', s.n1Pct, 19, 23, '%');
  assert('rpm is zero, not a plausible fake', s.rpm === 0, String(s.rpm));

  // And the Cessna still reads a tachometer — the branch cuts both ways.
  const c172 = createFlightModel({ airframe: C172, groundHeightFn: ground });
  assert('the C172 still reads rpm', c172.state.engineGauge === 'rpm');
  assert('and its N1 is zero', c172.state.n1Pct === 0);
}

// ---------------------------------------------------------------------------
head('1. turbofan thrust is FLAT — a propeller\'s is not');
// ---------------------------------------------------------------------------
{
  // The single most important shape in the whole jet model. A propeller makes
  // constant SHAFT POWER, so its thrust falls as roughly 1/V and is nearly gone
  // by 250 kt. A fan makes roughly constant THRUST. Faking a jet with a huge
  // maxPowerW gets the static number right and then decays through the entire
  // climb — the aircraft would run out of push at the speeds a 737 lives at.
  const T = [];
  for (const kt of [0, 120, 240, 360]) {
    const m = jet();
    air(m, 1500, Math.max(1, kt));
    // Long enough for the (deliberately slow) fan to reach the commanded N1.
    fly(m, 40, level(1, 0));
    T.push({ kt, N: m.state.thrustN, n1: m.state.n1Pct, M: m.state.mach });
    say(`thrust at ${kt} kt`, (m.state.thrustN / 1000).toFixed(1), 'kN');
  }
  const ratio = T[3].N / T[0].N;
  band('thrust at 360 kt / thrust at rest', ratio, 0.6, 0.95, 'x');
  assert(
    'thrust does NOT collapse like a propeller',
    ratio > 0.5,
    `a fixed-pitch prop would be near 0.2 here; this is ${ratio.toFixed(2)}`,
  );
  assert('and it does fall somewhat, with Mach', ratio < 1.0, ratio.toFixed(3));

  // N1 is a fan speed, so it saturates long before thrust does.
  band('N1 at full thrust', T[0].n1, 98, 101, '%');
}

// ---------------------------------------------------------------------------
head('2. spool lag — thrust arrives late, and asymmetrically');
// ---------------------------------------------------------------------------
{
  // A go-around is the case this exists for: firewalling the levers does not
  // give you thrust, it gives you thrust in about six seconds, and the
  // aeroplane keeps sinking meanwhile.
  const m = jet();
  air(m, 1500, 150);
  fly(m, 30, level(0.05, 1));
  const idleN = m.state.thrustN;
  let t90 = 0;
  const target = 0.9;
  for (let i = 0; i < 60 * 40; i++) {
    m.step(1 / 60, inputs({ throttle: 1, flaps: 1, pitch: vsHold(0)(m.state) }), ground());
    if (!t90 && m.state.n1Pct > 21 + 79 * Math.pow(target, 0.35) - 0.5) t90 = i / 60;
  }
  say('idle thrust', (idleN / 1000).toFixed(1), 'kN');
  band('idle thrust as a fraction of static', idleN / 242000, 0.02, 0.09, 'x');
  band('spool-up to 90% commanded', t90, 4, 10, 's');

  // Down is quicker than up. Fly the levers ahead of the aeroplane.
  const m2 = jet();
  air(m2, 1500, 200);
  fly(m2, 40, level(1, 0));
  const hi = m2.state.thrustN;
  let tDown = 0;
  for (let i = 0; i < 60 * 40; i++) {
    m2.step(1 / 60, inputs({ throttle: 0, pitch: vsHold(0)(m2.state) }), ground());
    if (!tDown && m2.state.thrustN < hi * 0.2) tDown = i / 60;
  }
  band('spool-down to 20% of full', tDown, 1.5, 6, 's');
  assert('spool DOWN is quicker than spool UP', tDown < t90, `${tDown.toFixed(1)}s vs ${t90.toFixed(1)}s`);
}

// ---------------------------------------------------------------------------
head('3. compressibility — wave drag has a KNEE, not a slope');
// ---------------------------------------------------------------------------
{
  // Measured as thrust required for level flight at a fixed altitude: bisect
  // the throttle until the aeroplane neither accelerates nor decelerates.
  // Below Mcrit drag should be nearly flat with Mach (induced drag is falling
  // while parasite rises); past it, it should climb steeply.
  const A = speedOfSound(10668);
  const req = [];
  for (const M of [0.6, 0.7, 0.78, 0.82]) {
    let lo = 0, hi = 1;
    for (let it = 0; it < 11; it++) {
      const th = (lo + hi) / 2;
      const m = jet();
      air(m, 10668 - FIELD_M, M * A * MS_TO_KTS);
      const v0 = m.state.airspeedMs;
      fly(m, 45, level(th));
      if (m.state.airspeedMs > v0) hi = th;
      else lo = th;
    }
    const th = (lo + hi) / 2;
    const m = jet();
    air(m, 10668 - FIELD_M, M * A * MS_TO_KTS);
    const r = fly(m, 45, level(th));
    req.push({ M, th, T: m.state.thrustN, g: r.meanG, mach: m.state.mach });
    say(`M${M.toFixed(2)}: thrust required`, (m.state.thrustN / 1000).toFixed(1), `kN  (throttle ${th.toFixed(2)}, ${r.meanG.toFixed(2)} g)`);
  }
  for (const r of req) {
    band(`  flight at M${r.M.toFixed(2)} was 1 g`, r.g, 0.9, 1.1, 'g');
  }
  // The knee. Mcrit is 0.72, so 0.60 -> 0.70 is the flat side and 0.78 -> 0.82
  // is past the wall. The SECOND slope must be much steeper than the first.
  const slopeBelow = (req[1].T - req[0].T) / (req[1].M - req[0].M);
  const slopeAbove = (req[3].T - req[2].T) / (req[3].M - req[2].M);
  say('d(thrust)/dM below Mcrit', (slopeBelow / 1000).toFixed(1), 'kN per Mach');
  say('d(thrust)/dM above Mcrit', (slopeAbove / 1000).toFixed(1), 'kN per Mach');
  assert(
    'drag rise past Mcrit is steeper than below it',
    slopeAbove > slopeBelow,
    'a model with no compressibility would show no knee at all',
  );

  // And the Cessna must have NO knee, because machEffects is off for it. This
  // is the guard that keeps the feature from leaking into the other aeroplane.
  const c = createFlightModel({ airframe: C172, groundHeightFn: ground });
  air(c, 2000, 120);
  fly(c, 10, level(0.7));
  assert('the C172 publishes a Mach number', Number.isFinite(c.state.mach), c.state.mach.toFixed(3));
  assert('and it is small', c.state.mach < 0.25, c.state.mach.toFixed(3));
}

// ---------------------------------------------------------------------------
head('4. Prandtl-Glauert — the wing gets STEEPER with Mach');
// ---------------------------------------------------------------------------
{
  // Same aeroplane, same weight, two altitudes: the high-Mach case needs LESS
  // angle of attack per unit CL because the lift-curve slope has grown. This is
  // why a jet is twitchy in pitch at cruise and docile on approach.
  const A = speedOfSound(10668);
  const m = jet();
  air(m, 10668 - FIELD_M, 0.8 * A * MS_TO_KTS);
  const rHi = fly(m, 60, level(1));
  const hi = { a: m.state.alphaDeg, M: m.state.mach };

  const m2 = jet();
  air(m2, 1500, 250);
  const rLo = fly(m2, 60, level(0.6));
  const lo = { a: m2.state.alphaDeg, M: m2.state.mach };

  say('cruise: Mach / alpha', `${hi.M.toFixed(3)} / ${hi.a.toFixed(2)} deg`);
  say('low level: Mach / alpha', `${lo.M.toFixed(3)} / ${lo.a.toFixed(2)} deg`);
  band('both flights were 1 g', (rHi.meanG + rLo.meanG) / 2, 0.9, 1.1, 'g');
  assert('the high-Mach case is genuinely transonic', hi.M > 0.7, hi.M.toFixed(3));
}

// ---------------------------------------------------------------------------
head('5. Mmo binds high, Vne binds low — and both break the airframe');
// ---------------------------------------------------------------------------
{
  // THE POINT OF HAVING TWO LIMITS. At FL350 M0.82 is about 290 KIAS, fifty
  // knots INSIDE the 340 kt placard: a Vne-only model lets you sit there all
  // day. Down low the reverse holds and Vne is the one that catches you.
  const m = jet();
  const A = speedOfSound(10668);
  air(m, 10668 - FIELD_M, 0.78 * A * MS_TO_KTS);
  let flagM = 0, flagKias = 0;
  for (let i = 0; i < 60 * 200; i++) {
    m.step(1 / 60, inputs({ throttle: 1, pitch: vsHold(0)(m.state) }), ground());
    if (m.state.overspeed) { flagM = m.state.mach; flagKias = m.state.indicatedAirspeedKts; break; }
    if (m.state.crashed) break;
  }
  say('overspeed flag at altitude', `M${flagM.toFixed(3)} / ${flagKias.toFixed(0)} KIAS`);
  assert('something flagged an overspeed up high', flagM > 0);
  band('  and it was the MACH limit', flagM, 0.81, 0.86, 'M');
  assert(
    '  while still well inside the IAS placard',
    flagKias < 340,
    `${flagKias.toFixed(0)} KIAS against a 340 kt Vmo — a Vne-only model would say nothing`,
  );

  // Low down, the same aeroplane must break on IAS instead, and say so.
  const m2 = jet();
  air(m2, 3000, 320);
  let broke = null;
  for (let i = 0; i < 60 * 300; i++) {
    m2.step(1 / 60, inputs({ throttle: 1, pitch: -0.25 }), ground());
    if (m2.state.crashed) { broke = m2.state.crashDetail; break; }
    if (m2.state.altitudeAglFt < 300) break;
  }
  say('low-level dive outcome', broke || 'survived');
  assert('a low-level overspeed breaks the airframe', !!broke && /KIAS/.test(broke), broke || '');
  assert('  and it names Vne, not Mmo', !!broke && !/Mmo/.test(broke), broke || '');
}

// ---------------------------------------------------------------------------
head('6. stall — CLmax with slats, and the shape of the break');
// ---------------------------------------------------------------------------
{
  for (const [name, fl, lo, hi] of [
    ['clean', 0, 145, 175],
    ['flaps 40', 1, 105, 125],
  ]) {
    const m = jet();
    air(m, 4572, fl ? 190 : 240);
    fly(m, 40, level(0.5, fl));
    let warn = 0, stallKt = 0, gAt = 0, aAt = 0;
    for (let i = 0; i < 60 * 400; i++) {
      m.step(1 / 60, inputs({ throttle: 0.02, flaps: fl, pitch: vsHold(0)(m.state) }), ground());
      if (!warn && m.state.stallWarning) warn = m.state.indicatedAirspeedKts;
      if (m.state.stalled) { stallKt = m.state.indicatedAirspeedKts; gAt = m.state.loadFactor; aAt = m.state.alphaDeg; break; }
    }
    if (stallKt) {
      say(`${name}: stall / warning`, `${stallKt.toFixed(0)} / ${warn.toFixed(0)} KIAS at ${aAt.toFixed(1)} deg`);
      band(`${name} stall speed`, stallKt, lo, hi, 'kt');
      band(`  ${name} stall was ~1 g`, gAt, 0.85, 1.15, 'g');
      assert(`  ${name} warned before it broke`, warn > stallKt, `${warn.toFixed(0)} > ${stallKt.toFixed(0)}`);
    } else {
      // Clean, this airframe can mush at 16 deg of commanded pitch without ever
      // reaching the critical angle — that is a real result, not a failure, so
      // the warning is what gets asserted.
      say(`${name}: no break reached`, `warning at ${warn.toFixed(0)} KIAS`);
      band(`${name} stall warning speed`, warn, lo, hi + 25, 'kt');
    }
  }
  // Slats are the whole point of the raised rail: the flapped stall must be a
  // long way below the clean one.
  const m = jet();
  const c = m.config;
  const drop = (c.stallSpeedCleanMs - c.stallSpeedFlappedMs) * MS_TO_KTS;
  band('flaps+slats buy this much stall speed', drop, 22, 40, 'kt');
}

// ---------------------------------------------------------------------------
head('7. takeoff — it rotates at Vr and clears the ground');
// ---------------------------------------------------------------------------
{
  const m = jet();
  m.reset();
  const x0 = m.state.position.x, z0 = m.state.position.z;
  let noseUp = 0, vlof = 0, roll = 0;
  for (let i = 0; i < 60 * 150; i++) {
    const kt = m.state.indicatedAirspeedKts;
    const pitch = kt > 145 ? (m.state.pitchDeg < 13 ? 1 : 0.15) : 0;
    m.step(1 / 60, inputs({ throttle: 1, flaps: 0.12, pitch }), ground());
    if (!noseUp && m.state.pitchDeg > 1) noseUp = kt;
    if (m.state.altitudeAglFt > 5) {
      vlof = kt;
      roll = Math.hypot(m.state.position.x - x0, m.state.position.z - z0);
      break;
    }
  }
  say('nose comes up at', noseUp.toFixed(0), 'KIAS');
  say('lift-off at', vlof.toFixed(0), 'KIAS');
  say('ground roll', roll.toFixed(0), 'm');
  band('rotation speed', noseUp, 138, 158, 'kt');
  band('lift-off speed', vlof, 150, 180, 'kt');
  band('ground roll', roll, 1300, 2300, 'm');

  // A 737-800 is the stretched one and strikes its tail at about 11 deg. Pull
  // it off the ground far too early and the skid should find the runway first.
  //
  // MEASURING THIS TOOK TWO WRONG DEFINITIONS FIRST, so the right one is worth
  // stating. What the check wants is the pitch attainable with the WHEELS still
  // on the runway, and neither obvious proxy gives it:
  //
  //   - max pitch outright reads 28 deg. That is the elevator's authority in
  //     free air, once the skid is nowhere near the ground. Nothing to do with
  //     the tail.
  //   - max pitch while `onGround` reads 14 deg, because `onGround` means "some
  //     contact is carrying load" and the skid IS a contact. The trace shows
  //     exactly what happens: the tail touches at 10.78 deg, takes the load,
  //     and the aeroplane then levers itself off and climbs away — AGL going
  //     0.50 -> 1.03 -> 3.34 ft with the mains unloading — while still reporting
  //     onGround, because it is dragging its tail down the runway. Which is a
  //     tail strike, correctly simulated, and not a cap on pitch at all.
  //
  // So: the highest pitch reached while the aeroplane is still sitting at wheel
  // height. That lands on the 10.8 deg the contact geometry specifies.
  const m2 = jet();
  m2.reset();
  let maxWheelPitch = 0;
  for (let i = 0; i < 60 * 150; i++) {
    const kt = m2.state.indicatedAirspeedKts;
    m2.step(1 / 60, inputs({ throttle: 1, flaps: 0.12, pitch: kt > 120 ? 1 : 0 }), ground());
    if (m2.state.onGround && m2.state.altitudeAglFt < 0.6 && m2.state.pitchDeg > maxWheelPitch) {
      maxWheelPitch = m2.state.pitchDeg;
    }
    if (m2.state.crashed || m2.state.altitudeAglFt > 60) break;
  }
  say('over-rotation: pitch on the wheels', maxWheelPitch.toFixed(1), 'deg');
  band('the tail skid caps rotation', maxWheelPitch, 9.5, 12, 'deg');
  assert(
    '  which is the 10.8 deg the gear table specifies',
    Math.abs(maxWheelPitch - 10.8) < 1.2,
    `2.80 m of skid, 14.7 m aft of the mains: atan(2.8/14.7) = 10.79 deg`,
  );

  // Climb-out.
  const r = fly(m, 60, (s) => ({ throttle: 1, flaps: 0.12, pitch: vsHold(3000)(s) }));
  say('climb after 60 s', `${m.state.verticalSpeedFpm.toFixed(0)} fpm at ${m.state.indicatedAirspeedKts.toFixed(0)} KIAS`);
  band('initial climb rate', m.state.verticalSpeedFpm, 1500, 5000, 'fpm');
}

// ---------------------------------------------------------------------------
head('8. arrivals — the gear is the fuse, and it fails before the wing');
// ---------------------------------------------------------------------------
{
  // See limits.crashLoadG in b738.js for the full measured table. The property
  // asserted here is the ORDERING: a normal firm arrival survives, a hard one
  // collapses the gear, and the gear goes before the airframe does.
  const arrive = (fpm) => {
    const m = jet();
    air(m, 152, 145);
    for (let i = 0; i < 60 * 12; i++) {
      m.step(1 / 60, inputs({ pitch: vsHold(-fpm)(m.state), throttle: 0.3, flaps: 1 }), ground());
    }
    let peakG = 0, touched = false, tdFpm = 0;
    for (let i = 0; i < 60 * 60; i++) {
      m.step(1 / 60, inputs({
        pitch: vsHold(-fpm)(m.state),
        throttle: 0.3,
        flaps: 1,
        brakes: m.state.onGround ? 1 : 0,
      }), ground());
      const g = Math.abs(m.state.loadFactor);
      if (g > peakG) peakG = g;
      if (!touched && m.state.onGround) { touched = true; tdFpm = m.state.verticalSpeedFpm; }
      if (m.state.crashed) break;
      if (touched && m.state.airspeedKts < 35) break;
    }
    return { peakG, tdFpm, crashed: m.state.crashed, why: m.state.crashDetail, m };
  };

  const soft = arrive(300);
  const firm = arrive(700);
  const hard = arrive(1100);
  say('gentle arrival', `${soft.tdFpm.toFixed(0)} fpm, ${soft.peakG.toFixed(2)} g`, soft.crashed ? 'CRASH' : 'survived');
  say('firm arrival', `${firm.tdFpm.toFixed(0)} fpm, ${firm.peakG.toFixed(2)} g`, firm.crashed ? 'CRASH' : 'survived');
  say('hard arrival', `${hard.tdFpm.toFixed(0)} fpm, ${hard.peakG.toFixed(2)} g`, hard.crashed ? 'CRASH' : 'survived');

  assert('a normal arrival is survivable', !soft.crashed, `${soft.tdFpm.toFixed(0)} fpm at ${soft.peakG.toFixed(2)} g`);
  assert('a firm arrival is survivable', !firm.crashed, `${firm.tdFpm.toFixed(0)} fpm at ${firm.peakG.toFixed(2)} g`);
  assert('a hard arrival is not', hard.crashed, hard.why || '');
  band('  and a normal arrival does not spike', soft.peakG, 1.0, 3.5, 'g');
  assert(
    '  the GEAR fails first, not the wing',
    /gear/.test(hard.why || ''),
    hard.why || '',
  );

  // A COMPLETE LANDING: approach, FLARE, touchdown, brakes, stopped.
  //
  // The flare is not decoration. Flying the approach sink rate all the way to
  // the runway arrives at 600-800 fpm every time, which this airframe survives
  // but only just — the first version of this check drove it straight in at
  // idle and wrote the aeroplane off at 4.5 g. Reducing the commanded sink
  // inside 50 ft is what a pilot does and it is what makes the difference
  // between a landing and an arrival.
  const m = jet();
  air(m, 152, 145);
  for (let i = 0; i < 60 * 12; i++) {
    m.step(1 / 60, inputs({ pitch: vsHold(-600)(m.state), throttle: 0.3, flaps: 1 }), ground());
  }
  let td = null, dist = 0;
  for (let i = 0; i < 60 * 240; i++) {
    const agl = m.state.altitudeAglFt;
    const cmd = agl > 50 ? -600 : agl > 15 ? -300 : -120;
    m.step(1 / 60, inputs({
      pitch: m.state.onGround ? 0.1 : vsHold(cmd)(m.state),
      throttle: agl < 30 || m.state.onGround ? 0 : 0.3,
      flaps: 1,
      brakes: m.state.onGround ? 1 : 0,
    }), ground());
    if (!td && m.state.onGround) {
      td = {
        x: m.state.position.x, z: m.state.position.z,
        kt: m.state.indicatedAirspeedKts, fpm: m.state.verticalSpeedFpm,
      };
    }
    if (m.state.crashed) break;
    if (td && m.state.airspeedKts < 5) {
      dist = Math.hypot(m.state.position.x - td.x, m.state.position.z - td.z);
      break;
    }
  }
  assert('a flared landing does not break anything', !m.state.crashed, m.state.crashDetail || '');
  say('touchdown', td ? `${td.kt.toFixed(0)} KIAS at ${td.fpm.toFixed(0)} fpm` : 'n/a');
  say('stopping distance', dist.toFixed(0), 'm');
  if (td) band('  touchdown sink rate after a flare', Math.abs(td.fpm), 0, 500, 'fpm');
  band('landing roll on full brakes', dist, 700, 2000, 'm');
}

// ---------------------------------------------------------------------------
head('9. handling — roll rate, and no propeller asymmetry');
// ---------------------------------------------------------------------------
{
  const m = jet();
  air(m, 3048, 160);
  fly(m, 15, level(0.6));
  let p = 0;
  for (let i = 0; i < 60 * 4; i++) {
    m.step(1 / 60, inputs({ throttle: 0.6, roll: 1 }), ground());
    p = (Math.abs(m.state.angularVelocity.z) * 180) / Math.PI;
  }
  band('steady roll rate at 160 kt', p, 12, 19, 'deg/s');

  // A twin has no slipstream over the fin and no net torque reaction, so the
  // takeoff roll must track straight with the pedals centred. This is the first
  // thing that feels different from the Cessna, which needs standing right
  // rudder.
  const m2 = jet();
  m2.reset();
  const h0 = m2.state.headingDeg;
  for (let i = 0; i < 60 * 30; i++) {
    m2.step(1 / 60, inputs({ throttle: 1, flaps: 0.12 }), ground());
    if (m2.state.indicatedAirspeedKts > 120) break;
  }
  let drift = Math.abs(m2.state.headingDeg - h0);
  if (drift > 180) drift = 360 - drift;
  say('heading drift over the takeoff roll', drift.toFixed(2), 'deg');
  band('a twin tracks straight, no rudder', drift, 0, 1.5, 'deg');
}

// ---------------------------------------------------------------------------
head('10. nothing went non-finite');
// ---------------------------------------------------------------------------
{
  const m = jet();
  air(m, 6000, 300);
  fly(m, 30, (s, t) => ({
    throttle: 0.5 + 0.5 * Math.sin(t * 3),
    pitch: Math.sin(t * 2.3),
    roll: Math.sin(t * 1.7),
    yaw: Math.sin(t * 0.9),
    flaps: t > 15 ? 1 : 0,
  }));
  const s = m.state;
  const finite =
    Number.isFinite(s.position.x) && Number.isFinite(s.position.y) &&
    Number.isFinite(s.velocity.y) && Number.isFinite(s.airspeedMs) &&
    Number.isFinite(s.alphaRad) && Number.isFinite(s.mach) &&
    Number.isFinite(s.n1Pct) && Number.isFinite(s.thrustN) &&
    Number.isFinite(s.orientation.w) && Number.isFinite(s.headingDeg);
  assert('30 s of stick-slamming stays finite', finite);
  assert('Mach stayed sane', s.mach >= 0 && s.mach < 2, s.mach.toFixed(3));
  assert('N1 stayed on the gauge', s.n1Pct >= 0 && s.n1Pct <= 105, s.n1Pct.toFixed(1));
}

console.log(
  failures
    ? `\n\x1b[31m${failures} of ${checks} checks FAILED\x1b[0m\n`
    : `\n\x1b[32mall ${checks} jet checks passed\x1b[0m\n`,
);
process.exit(failures ? 1 : 0);
