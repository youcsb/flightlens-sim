/**
 * check-autopilot.mjs — prove the autopilot flies the aeroplane, not a model of it.
 *
 * Runs src/systems/autopilot.js against the REAL src/physics/flightModel.js,
 * unmodified, in the same loop order main.js uses:
 *
 *     inputs = input.get()  ->  autopilot.update(dt, state, inputs)  ->  flight.step(...)
 *
 * WHY THIS EXISTS. Every gain in the autopilot is a guess until something flies
 * it, but the SIGNS are not a matter of taste — one inverted term produces a
 * controller that turns away from the bug and saturates. Reasoning about
 * Euler-angle conventions on paper is exactly how that mistake gets made and
 * missed, so the direction tests below are the point of this file and the gain
 * tests are a bonus.
 *
 * Ground height is a flat plane well below the aircraft: this harness is about
 * the control laws, not terrain, and a real elevation lookup would drag the
 * whole DEM pager in for nothing.
 */

import { createFlightModel } from '../src/physics/flightModel.js';
import { createAutopilot } from '../src/systems/autopilot.js';

const GROUND_M = 0;
const DT = 1 / 60;

/** The floor the autopilot's airspeed protection defends, less a small margin
 *  for the transient as it catches the decay. Mirrors VS_FLOOR_KTS. */
const VS_FLOOR_ASSERT = 52;

let passed = 0;
let failed = 0;

function ok(name, cond, detail) {
  if (cond) {
    passed += 1;
    console.log(`  \x1b[32m ok \x1b[0m ${name}${detail ? `   ${detail}` : ''}`);
  } else {
    failed += 1;
    console.log(`  \x1b[31mFAIL\x1b[0m ${name}${detail ? `   ${detail}` : ''}`);
  }
}

const near = (a, b, tol) => Math.abs(a - b) <= tol;
function wrap180(deg) {
  let d = ((deg + 180) % 360 + 360) % 360 - 180;
  if (d === -180) d = 180;
  return d;
}

/**
 * Fresh aircraft, airborne at `hdg` / `altFt` / `speedKts`.
 *
 * Two things here are load-bearing and were both learned the hard way:
 *
 * 1. Spawn via reset()'s `placement` argument rather than by writing
 *    state.position directly. The model derives a lot from the spawn (squat,
 *    gear compression, the local frame) and a hand-placed aircraft is not in a
 *    self-consistent state.
 * 2. Then step it for a moment BEFORE handing it to the autopilot. Fields like
 *    altitudeFt and altitudeAglFt are DERIVED display values that only exist
 *    after a step — read straight after reset they are zero, which makes the
 *    autopilot's "below 200 ft AGL" guard refuse to engage a perfectly good
 *    aeroplane at 3,000 ft. That is what the first run of this file caught.
 */
function airborne(hdg = 0, altFt = 3000, speedKts = 100) {
  const flight = createFlightModel();
  flight.reset(47.53, -122.30, hdg, {
    altitudeMslM: altFt * 0.3048,
    airspeedMs: speedKts * 0.514444,
  });
  // Settle: populate the derived display fields and let the gear unload.
  for (let i = 0; i < 30; i += 1) {
    flight.step(DT, { pitch: 0, roll: 0, yaw: 0, throttle: 0.65, flaps: 0, brakes: 0, gear: 1 }, GROUND_M);
  }
  return flight;
}

/** Fly `seconds` with the autopilot engaged, returning the final state. */
function fly(flight, ap, seconds, pilot = {}) {
  const n = Math.round(seconds / DT);
  for (let i = 0; i < n; i += 1) {
    const inputs = {
      pitch: 0, roll: 0, yaw: 0, throttle: 0.65, flaps: 0, brakes: 0, gear: 1,
      ...pilot,
    };
    ap.update(DT, flight.state, inputs);
    flight.step(DT, inputs, GROUND_M);
  }
  return flight.state;
}

console.log('\nautopilot — direction and sign');

// ---------------------------------------------------------------------------
// THE TESTS THAT MATTER: does it turn the way it was told?
// ---------------------------------------------------------------------------
{
  const flight = airborne(0, 3000);
  const ap = createAutopilot();
  ap.toggle(flight.state);
  ap.nudgeHeading(40); // bug to 040, i.e. 40 deg RIGHT of the nose

  // One second in, it should be banking RIGHT (positive rollDeg) — this single
  // assertion is what an inverted lateral sign would break.
  fly(flight, ap, 1.5);
  ok(
    'commanded right: banks right',
    flight.state.rollDeg > 2,
    `rollDeg ${flight.state.rollDeg.toFixed(1)}`,
  );

  fly(flight, ap, 40);
  const err = wrap180(40 - flight.state.headingDeg);
  ok(
    'commanded right: captures the heading',
    Math.abs(err) < 6,
    `heading ${flight.state.headingDeg.toFixed(1)} vs bug 40, err ${err.toFixed(1)}`,
  );
  ok(
    'rolls out after capture',
    Math.abs(flight.state.rollDeg) < 8,
    `rollDeg ${flight.state.rollDeg.toFixed(1)}`,
  );
}

{
  const flight = airborne(0, 3000);
  const ap = createAutopilot();
  ap.toggle(flight.state);
  ap.nudgeHeading(-40); // bug to 320, i.e. LEFT

  fly(flight, ap, 1.5);
  ok(
    'commanded left: banks left',
    flight.state.rollDeg < -2,
    `rollDeg ${flight.state.rollDeg.toFixed(1)}`,
  );

  fly(flight, ap, 40);
  const err = wrap180(320 - flight.state.headingDeg);
  ok(
    'commanded left: captures the heading',
    Math.abs(err) < 6,
    `heading ${flight.state.headingDeg.toFixed(1)} vs bug 320, err ${err.toFixed(1)}`,
  );
}

{
  // The wrap case: bug at 350, nose at 010. Shortest way round is LEFT by 20,
  // not right by 340. A naive (bug - heading) turns the long way.
  const flight = airborne(10, 3000);
  const ap = createAutopilot();
  ap.toggle(flight.state);
  ap.nudgeHeading(-20); // 010 -> 350
  fly(flight, ap, 2);
  ok(
    'crosses north the short way',
    flight.state.rollDeg < 0,
    `bug 350 from 010 -> rollDeg ${flight.state.rollDeg.toFixed(1)} (must be left)`,
  );
}

console.log('\nautopilot — altitude hold');

{
  // A climb needs POWER. This autopilot has no autothrottle, so the harness
  // plays the pilot and pushes the throttle up — which is exactly what the
  // real procedure is.
  const flight = airborne(0, 3000);
  const ap = createAutopilot();
  ap.toggle(flight.state);
  ap.nudgeAltitude(700);

  fly(flight, ap, 3, { throttle: 1 });
  ok(
    'commanded up: pitches up and climbs',
    flight.state.verticalSpeedFpm > 50,
    `vs ${flight.state.verticalSpeedFpm.toFixed(0)} fpm`,
  );

  fly(flight, ap, 150, { throttle: 1 });
  const target = ap.altitudeBug;
  ok(
    'captures the altitude with power applied',
    near(flight.state.altitudeFt, target, 200),
    `alt ${flight.state.altitudeFt.toFixed(0)} vs bug ${target}`,
  );
}

{
  // The case that failed on the first run: commanded climb at CRUISE power,
  // which the aeroplane cannot sustain. It must refuse to mush into a stall.
  // Losing altitude here is an acceptable outcome; losing flying speed is not.
  const flight = airborne(0, 3000);
  const ap = createAutopilot();
  ap.toggle(flight.state);
  ap.nudgeAltitude(2000); // far more than cruise power can buy

  fly(flight, ap, 120, { throttle: 0.65 });
  ok(
    'airspeed protection: will not mush into a stall',
    flight.state.airspeedKts > VS_FLOOR_ASSERT && !flight.state.stalled,
    `held ${flight.state.airspeedKts.toFixed(1)} kt, stalled=${flight.state.stalled}`,
  );
}

{
  const flight = airborne(0, 4000);
  const ap = createAutopilot();
  ap.toggle(flight.state);
  ap.nudgeAltitude(-700); // descend
  fly(flight, ap, 3);
  ok(
    'commanded down: descends',
    flight.state.verticalSpeedFpm < -50,
    `vs ${flight.state.verticalSpeedFpm.toFixed(0)} fpm`,
  );
}

{
  // No standing error: with no trim in the airframe, a proportional-only loop
  // parks low. This is the assertion that justifies the integrator.
  const flight = airborne(0, 3000);
  const ap = createAutopilot();
  ap.toggle(flight.state);
  const bug = ap.altitudeBug;
  fly(flight, ap, 120);
  ok(
    'holds level without standing error',
    near(flight.state.altitudeFt, bug, 120),
    `alt ${flight.state.altitudeFt.toFixed(0)} vs bug ${bug} after 2 min`,
  );
}

// ---------------------------------------------------------------------------
// SMOOTHNESS. The gap that let the porpoising ship: every altitude test above
// checks where the aeroplane ENDED UP, and a phugoid has a perfectly good mean.
// It can oscillate +/-300 ft all day and still land inside "near(3000, 120)".
// These assertions watch the whole trajectory instead of its endpoint.
// ---------------------------------------------------------------------------
console.log('\nautopilot — smoothness (no phugoid)');

/** Fly and record, returning the altitude/pitch envelope over the run. */
function flyRecording(flight, ap, seconds, pilot = {}) {
  const n = Math.round(seconds / DT);
  let altMin = Infinity, altMax = -Infinity, pitchMin = Infinity, pitchMax = -Infinity;
  let vsSignChanges = 0, lastVsSign = 0;
  for (let i = 0; i < n; i += 1) {
    const inputs = {
      pitch: 0, roll: 0, yaw: 0, throttle: 0.65, flaps: 0, brakes: 0, gear: 1, ...pilot,
    };
    ap.update(DT, flight.state, inputs);
    flight.step(DT, inputs, GROUND_M);
    const s = flight.state;
    altMin = Math.min(altMin, s.altitudeFt); altMax = Math.max(altMax, s.altitudeFt);
    pitchMin = Math.min(pitchMin, s.pitchDeg); pitchMax = Math.max(pitchMax, s.pitchDeg);
    const sign = Math.sign(s.verticalSpeedFpm);
    if (sign !== 0 && lastVsSign !== 0 && sign !== lastVsSign) vsSignChanges += 1;
    if (sign !== 0) lastVsSign = sign;
  }
  return {
    altBand: altMax - altMin,
    pitchBand: pitchMax - pitchMin,
    vsSignChanges,
  };
}

{
  const flight = airborne(0, 3000);
  const ap = createAutopilot();
  ap.toggle(flight.state);
  // Let the initial capture settle, THEN measure the steady state.
  fly(flight, ap, 45);
  const r = flyRecording(flight, ap, 180);
  ok(
    'altitude stays inside a 60 ft band for 3 min',
    r.altBand < 60,
    `band ${r.altBand.toFixed(0)} ft`,
  );
  ok(
    'pitch does not hunt',
    r.pitchBand < 6,
    `pitch band ${r.pitchBand.toFixed(1)} deg`,
  );
  ok(
    'vertical speed does not keep reversing (phugoid)',
    r.vsSignChanges < 25,
    `${r.vsSignChanges} reversals in 3 min`,
  );
}

{
  // Smooth THROUGH a turn, which is where the load-factor feed-forward earns
  // its place: the aeroplane must not sag and then over-correct.
  const flight = airborne(0, 3000);
  const ap = createAutopilot();
  ap.toggle(flight.state);
  fly(flight, ap, 30);
  ap.nudgeHeading(90);
  const r = flyRecording(flight, ap, 120);
  ok(
    'holds altitude through a 90 deg turn',
    r.altBand < 150,
    `band ${r.altBand.toFixed(0)} ft across the turn`,
  );
}

console.log('\nautopilot — engage rules and disconnect');

{
  const flight = createFlightModel();
  flight.reset(47.53, -122.30, 330);
  flight.state.onGround = true;
  const ap = createAutopilot();
  const r = ap.toggle(flight.state);
  ok('will not engage on the ground', r.ok === false, `reason: ${r.reason}`);
  ok('stays disengaged', ap.engaged === false);
}

{
  const flight = airborne(0, 3000);
  const ap = createAutopilot();
  ap.toggle(flight.state);
  ok('engages airborne', ap.engaged === true);
  ok(
    'bug snaps to current heading on engage',
    near(ap.headingBug, flight.state.headingDeg, 1.5),
    `bug ${ap.headingBug} vs heading ${flight.state.headingDeg.toFixed(1)}`,
  );

  fly(flight, ap, 2, { roll: 0.8 }); // pilot grabs the stick
  ok('pilot roll input disconnects it', ap.engaged === false);
  ok('reports why', ap.status().lastReason === 'pilot input', ap.status().lastReason);
}

{
  const flight = airborne(0, 3000);
  const ap = createAutopilot();
  ap.toggle(flight.state);
  fly(flight, ap, 2, { throttle: 1, yaw: 0.5, flaps: 0.5 });
  ok('throttle / rudder / flaps do NOT disconnect it', ap.engaged === true);
}

{
  const flight = airborne(0, 3000);
  const ap = createAutopilot();
  ap.toggle(flight.state);
  const before = ap.engaged;
  ap.toggle(flight.state);
  ok('toggles off', before === true && ap.engaged === false);
}

{
  // Nothing may be written to inputs while disengaged: the pilot must have the
  // aeroplane back completely the instant it drops out.
  const flight = airborne(0, 3000);
  const ap = createAutopilot();
  const inputs = { pitch: 0, roll: 0, yaw: 0, throttle: 0.6 };
  ap.update(DT, flight.state, inputs);
  ok(
    'writes nothing when disengaged',
    inputs.pitch === 0 && inputs.roll === 0 && inputs.yaw === 0,
  );
}

{
  const flight = airborne(0, 3000);
  const ap = createAutopilot();
  ap.toggle(flight.state);
  ap.nudgeHeading(370); // deliberately out of range
  ok('heading bug wraps into 0..360', ap.headingBug >= 0 && ap.headingBug < 360, `${ap.headingBug}`);
  ap.nudgeHeading(-500);
  ok('and wraps the other way', ap.headingBug >= 0 && ap.headingBug < 360, `${ap.headingBug}`);
}

{
  const flight = airborne(0, 3000);
  const ap = createAutopilot();
  ap.toggle(flight.state);
  fly(flight, ap, 30);
  ok(
    'nothing went non-finite',
    Number.isFinite(flight.state.altitudeFt) &&
      Number.isFinite(flight.state.headingDeg) &&
      Number.isFinite(flight.state.rollDeg),
  );
}

console.log(
  failed === 0
    ? `\n\x1b[32mall ${passed} autopilot checks passed\x1b[0m\n`
    : `\n\x1b[31m${failed} of ${passed + failed} autopilot checks FAILED\x1b[0m\n`,
);
process.exit(failed === 0 ? 0 : 1);
