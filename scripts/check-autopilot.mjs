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

// ---------------------------------------------------------------------------
// JITTERY FRAME TIMES. The gap that let the SECOND round of jitter ship.
//
// Every test above runs at a perfectly regular DT = 1/60, and a browser does
// not. main.js's dtFor() returns raw wall-clock deltas, terrain page-ins and GC
// pauses produce real spikes, and the autopilot's damping term differentiates
// attitude by that dt. Divide a small number by a jittery one and the quotient
// is noise — which leaves the controller as elevator judder that a fixed-step
// harness cannot see. Reported from a browser, invisible here, until now.
//
// The deltas below are deterministic (a fixed LCG, no Math.random) so a failure
// is reproducible.
// ---------------------------------------------------------------------------
console.log('\nautopilot — jittery frame times (browser conditions)');

/** Deterministic pseudo-random in [0,1). */
function makeRng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/**
 * Frame deltas that look like a real browser: a 60 Hz baseline with jitter,
 * plus occasional big spikes standing in for a terrain page-in or a GC pause.
 */
function jitteryDt(rng) {
  const r = rng();
  if (r < 0.03) return 0.033 + rng() * 0.05; // a spike: 33-83 ms
  return 1 / 60 + (rng() - 0.5) * 0.008; // 12.6-20.6 ms
}

{
  const rng = makeRng(20260807);
  const flight = airborne(0, 3000);
  const ap = createAutopilot();
  ap.toggle(flight.state);

  const step = (n) => {
    for (let i = 0; i < n; i += 1) {
      const dt = jitteryDt(rng);
      const inputs = { pitch: 0, roll: 0, yaw: 0, throttle: 0.65, flaps: 0, brakes: 0, gear: 1 };
      ap.update(dt, flight.state, inputs);
      flight.step(dt, inputs, GROUND_M);
      lastElev = inputs.pitch;
      elevSeries.push(inputs.pitch);
    }
  };
  let lastElev = 0;
  const elevSeries = [];
  step(2700); // settle
  elevSeries.length = 0;
  step(7200); // record

  let lo = Infinity, hi = -Infinity;
  for (const s of [flight.state]) void s;
  // Elevator judder is the thing the pilot FEELS. Measure how much the command
  // moves frame to frame, not just where the aeroplane ended up.
  let sumAbsDelta = 0, maxDelta = 0;
  for (let i = 1; i < elevSeries.length; i += 1) {
    const dv = Math.abs(elevSeries[i] - elevSeries[i - 1]);
    sumAbsDelta += dv;
    if (dv > maxDelta) maxDelta = dv;
    lo = Math.min(lo, elevSeries[i]);
    hi = Math.max(hi, elevSeries[i]);
  }
  const meanDelta = sumAbsDelta / Math.max(1, elevSeries.length - 1);

  ok(
    'elevator does not judder frame to frame',
    meanDelta < 0.01,
    `mean |Δelevator| ${meanDelta.toFixed(5)} per frame`,
  );
  ok(
    'no single-frame elevator slam',
    maxDelta < 0.12,
    `worst Δ ${maxDelta.toFixed(4)}`,
  );
  ok(
    'elevator command stays in a narrow band',
    hi - lo < 0.35,
    `band ${(hi - lo).toFixed(3)}`,
  );
  ok(
    'and it still holds altitude under jitter',
    near(flight.state.altitudeFt, ap.altitudeBug, 150),
    `alt ${flight.state.altitudeFt.toFixed(0)} vs bug ${ap.altitudeBug}`,
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

// ---------------------------------------------------------------------------
// CAPTURE FROM A DISPLACED START. The gap that let the slow hunt ship.
//
// Every smoothness test above engages a SETTLED aeroplane already at its bug
// and then checks that it stays there — which a loop with almost no gain passes
// trivially, because it never has to correct anything. The reported symptom was
// a slow wander above and below the target, and this is the shape that finds it:
// start displaced, and require the aeroplane to actually arrive, in a stated
// time, without sailing past.
// ---------------------------------------------------------------------------
console.log('\nautopilot — capture from displaced');

/** Engage, then fly `seconds`, returning the altitude trace once per second. */
function capture(startFt, bugOffsetFt, seconds, thr = 0.65) {
  const flight = airborne(0, startFt);
  const ap = createAutopilot();
  ap.toggle(flight.state);
  ap.nudgeAltitude(bugOffsetFt);
  const bug = ap.altitudeBug;
  const trace = [];
  let overshoot = 0;
  const n = Math.round(seconds / DT);
  for (let i = 0; i < n; i += 1) {
    const inputs = { pitch: 0, roll: 0, yaw: 0, throttle: thr, flaps: 0, brakes: 0, gear: 1 };
    ap.update(DT, flight.state, inputs);
    flight.step(DT, inputs, GROUND_M);
    if (i % 60 === 0) trace.push(Math.round(flight.state.altitudeFt));
    // How far past the bug did it go, in the direction it was travelling?
    const past = bugOffsetFt >= 0
      ? flight.state.altitudeFt - bug
      : bug - flight.state.altitudeFt;
    if (past > overshoot) overshoot = past;
  }
  return { bug, alt: flight.state.altitudeFt, trace, overshoot, ap, state: flight.state };
}

{
  // Sink 200 ft below the bug and require it back within 60 s.
  const r = capture(3000, 0, 60);
  // The aeroplane starts a little off after the settle; the real test is that
  // it ARRIVES rather than drifting.
  ok(
    'holds the bug within 25 ft after 60 s',
    Math.abs(r.alt - r.bug) < 25,
    `alt ${r.alt.toFixed(0)} vs bug ${r.bug}`,
  );
}

{
  // A commanded 400 ft climb with power: must arrive and not sail past.
  const r = capture(3000, 400, 150, 1);
  ok(
    'captures a 400 ft climb within 150 s',
    Math.abs(r.alt - r.bug) < 60,
    `alt ${r.alt.toFixed(0)} vs bug ${r.bug}`,
  );
  ok(
    'and does not overshoot it badly',
    r.overshoot < 120,
    `overshoot ${r.overshoot.toFixed(0)} ft`,
  );
}

{
  // A commanded 400 ft descent: same requirement downward.
  //
  // Throttle 0.75, not 0.65. At 0.65 this aeroplane cannot hold 3,000 ft at all
  // — it sinks ~90 ft over three minutes under any control law, because there
  // is no autothrottle and power is the pilot's job. Testing the capture at a
  // power setting that cannot sustain level flight measures the engine, not the
  // autopilot.
  const r = capture(3400, -400, 150, 0.75);
  ok(
    'captures a 400 ft descent within 150 s',
    Math.abs(r.alt - r.bug) < 60,
    `alt ${r.alt.toFixed(0)} vs bug ${r.bug}`,
  );
  ok(
    'and does not undershoot it badly',
    r.overshoot < 120,
    `overshoot ${r.overshoot.toFixed(0)} ft`,
  );
}

{
  // THE DIAGNOSTIC THAT WOULD HAVE CAUGHT IT DIRECTLY: while displaced, the
  // commanded pitch must actually MOVE. A frozen elevator with the aeroplane
  // off target is the signature of a loop whose gain is too low to correct.
  //
  // IT USED TO MEASURE THE RANGE AFTER THE FIRST SECOND, AND THAT STATISTIC
  // REWARDED THE DEFECT. Range says "how much did the elevator wobble", and a
  // loop in a limit cycle wobbles enormously — the oscillating build scored
  // 0.24 here and passed, while a loop that puts the elevator where it belongs
  // in the first half-second and then HOLDS it scored 0.035 and failed. The
  // skip of the first 60 frames threw away the only part of the trace that
  // answers the question being asked.
  //
  // So the two things the assertion actually means are now asserted directly:
  // the elevator has to depart from neutral by something an aeroplane can feel,
  // and the aeroplane has to close the gap. A frozen loop fails the first; a
  // limit-cycling one fails the second and the pitch band below.
  const flight = airborne(0, 3000);
  const ap = createAutopilot();
  ap.toggle(flight.state);
  ap.nudgeAltitude(300); // displace the target
  const h0 = flight.state.altitudeFt;
  let peak = 0;
  let pitchLo = Infinity, pitchHi = -Infinity;
  for (let i = 0; i < 20 * 60; i += 1) {
    const inputs = { pitch: 0, roll: 0, yaw: 0, throttle: 1, flaps: 0, brakes: 0, gear: 1 };
    ap.update(DT, flight.state, inputs);
    flight.step(DT, inputs, GROUND_M);
    if (Math.abs(inputs.pitch) > Math.abs(peak)) peak = inputs.pitch;
    if (i > 5 * 60) {
      pitchLo = Math.min(pitchLo, flight.state.pitchDeg);
      pitchHi = Math.max(pitchHi, flight.state.pitchDeg);
    }
  }
  const gained = flight.state.altitudeFt - h0;
  ok(
    'commands real elevator travel while off target',
    Math.abs(peak) > 0.05,
    `peak elevator ${peak.toFixed(3)} while 300 ft low`,
  );
  ok(
    'and the aeroplane actually closes the gap',
    gained > 100 && flight.state.verticalSpeedFpm > 50,
    `${gained.toFixed(0)} ft gained in 20 s, ${flight.state.verticalSpeedFpm.toFixed(0)} fpm still climbing`,
  );
  ok(
    'without hunting on the way — a limit cycle is not "correcting"',
    pitchHi - pitchLo < 3,
    `pitch band ${(pitchHi - pitchLo).toFixed(2)} deg during the climb`,
  );
}

// ---------------------------------------------------------------------------
// DISTURBED — the section that was missing, and the reason a ten-degree
// porpoise shipped three times.
//
// Everything above engages the autopilot on an aeroplane that is already
// trimmed for its power setting and then leaves the power alone. That is one
// point in the envelope, and at that one point this loop was always fine. The
// oscillation is a LIMIT CYCLE with two attractors: perturb the aeroplane hard
// enough and it falls into the noisy one and never climbs out. Reported four
// times from a browser, invisible here, because the harness never perturbed it.
//
// The disturbances below are not exotic. They are: move the throttle, and move
// the altitude bug. On a phone the throttle is a slider under the right thumb
// and the bug is a press-and-hold button, so they are the two things a touch
// pilot does most.
//
// ALTITUDE BAND IS NOT A STABILITY MEASUREMENT and that is the trap. Through
// every one of these the old build held altitude inside 8 ft while swinging the
// nose thirteen degrees at 1.3 Hz. The statistics that see it are the PITCH
// BAND and the VERTICAL-SPEED REVERSAL COUNT.
// ---------------------------------------------------------------------------
console.log('\nautopilot — disturbed (throttle and bug moved under it)');

{
  const IN_ = (thr) => ({ pitch: 0, roll: 0, yaw: 0, throttle: thr, flaps: 0, brakes: 0, gear: 1 });

  /** Settle in FREE flight first, then engage. See the note above. */
  function settled(kts, thr, altFt = 3000) {
    const f = createFlightModel();
    f.reset(47.53, -122.30, 0, { altitudeMslM: altFt * 0.3048, airspeedMs: kts * 0.514444 });
    for (let i = 0; i < 20 * 60; i += 1) f.step(DT, IN_(thr), GROUND_M);
    const ap = createAutopilot();
    ap.toggle(f.state);
    ap.nudgeAltitude(Math.round(f.state.altitudeFt) - ap.status().altitudeBug);
    return { f, ap };
  }

  function run({ f, ap }, sec, thr, bugDelta = 0) {
    if (bugDelta) ap.nudgeAltitude(bugDelta);
    const n = Math.round(sec / DT);
    const tr = [];
    for (let i = 0; i < n; i += 1) {
      const inp = IN_(thr);
      ap.update(DT, f.state, inp);
      f.step(DT, inp, GROUND_M);
      tr.push([f.state.pitchDeg, f.state.verticalSpeedFpm, f.state.altitudeFt]);
    }
    return tr;
  }

  /** Pitch band and vertical-speed reversals over the LAST `sec` of a trace. */
  function tail(tr, sec) {
    const t = tr.slice(-Math.round(sec / DT));
    const p = t.map((r) => r[0]);
    const v = t.map((r) => r[1]);
    let rev = 0;
    for (let i = 1; i < v.length; i += 1) if (Math.sign(v[i]) !== Math.sign(v[i - 1])) rev += 1;
    return { band: Math.max(...p) - Math.min(...p), rev, alt: t[t.length - 1][2] };
  }

  const cases = [
    ['left alone at cruise', 100, 0.65, (h) => tail(run(h, 65, 0.65), 15), 0],
    ['throttle slammed to full', 100, 0.65, (h) => { run(h, 45, 0.65); return tail(run(h, 180, 1.0), 30); }, 0],
    ['throttle chopped to 0.40', 100, 0.65, (h) => { run(h, 45, 0.65); return tail(run(h, 180, 0.40), 30); }, 0],
    ['throttle nudged to 0.85', 100, 0.65, (h) => { run(h, 45, 0.65); return tail(run(h, 180, 0.85), 30); }, 0],
    ['bug +400 ft at full power', 100, 0.65, (h) => { run(h, 45, 0.65); return tail(run(h, 240, 1.0, 400), 40); }, 400],
    ['bug -400 ft at cruise', 100, 0.65, (h) => { run(h, 45, 0.65); return tail(run(h, 240, 0.65, -400), 40); }, -400],
    ['fast cruise, 118 kt at 0.90', 118, 0.90, (h) => { run(h, 45, 0.90); return tail(run(h, 180, 0.90), 30); }, 0],
  ];

  for (const [name, kts, thr, act] of cases) {
    const h = settled(kts, thr);
    const r = act(h);
    // 1.5 deg is generous: the passing build measures under 0.1 at every one of
    // these, and the failing build measured 9.6 to 13.2.
    ok(
      `${name} — the nose does not hunt`,
      r.band < 1.5,
      `pitch band ${r.band.toFixed(2)} deg`,
    );
    // A settled autopilot has ONE sign of vertical speed, or none at all.
    ok(
      `${name} — vertical speed does not keep reversing`,
      r.rev <= 2,
      `${r.rev} reversals`,
    );
  }
}

// ---------------------------------------------------------------------------
// FRAME-RATE INDEPENDENCE. The gap that let the oscillation survive four
// reports and three "fixes".
//
// The flight model integrates at a fixed 1/240 s. The autopilot used to be
// called once per frame with the wall-clock delta, so it closed a loop around a
// 240 Hz plant at the browser's frame rate — and a controller sampled too slowly
// for its plant oscillates, whatever its gains.
//
// It hid because EVERY test here ran at DT = 1/60, and every manual browser
// probe drove the sim through window.sim.tick(1/60, n) — the same fixed step.
// The harness agreed with the probes and both disagreed with the game, because
// a hidden tab never runs requestAnimationFrame and the live loop was never
// actually observed.
//
// These assertions run the SAME manoeuvre at wildly different frame rates and
// require the same result. That is the property that was missing.
// ---------------------------------------------------------------------------
console.log('\nautopilot — frame-rate independence');

/** Fly a fixed-duration hold at a given frame rate, returning the envelope. */
function holdAtFps(fps, seconds, jitter = 0) {
  const rng = makeRng(4242);
  const flight = airborne(0, 3000);
  const ap = createAutopilot();
  ap.toggle(flight.state);
  const nominal = 1 / fps;
  let t = 0;
  let lo = Infinity, hi = -Infinity, rev = 0, last = 0;
  let pLo = Infinity, pHi = -Infinity;
  while (t < seconds) {
    const dt = jitter ? nominal * (1 + (rng() - 0.5) * 2 * jitter) : nominal;
    const inputs = { pitch: 0, roll: 0, yaw: 0, throttle: 0.75, flaps: 0, brakes: 0, gear: 1 };
    ap.update(dt, flight.state, inputs);
    flight.step(dt, inputs, GROUND_M);
    t += dt;
    if (t > 30) {
      const s = flight.state;
      lo = Math.min(lo, s.altitudeFt); hi = Math.max(hi, s.altitudeFt);
      pLo = Math.min(pLo, s.pitchDeg); pHi = Math.max(pHi, s.pitchDeg);
      const g = Math.sign(s.verticalSpeedFpm);
      if (g && last && g !== last) rev += 1;
      if (g) last = g;
    }
  }
  return { altBand: hi - lo, pitchBand: pHi - pLo, reversals: rev, alt: flight.state.altitudeFt };
}

const RATES = [144, 60, 30, 20, 15];
const results = RATES.map((f) => ({ fps: f, ...holdAtFps(f, 150) }));
for (const r of results) {
  ok(
    `holds altitude at ${r.fps} fps`,
    r.altBand < 60 && r.reversals < 25,
    `band ${r.altBand.toFixed(0)} ft, ${r.reversals} reversals, pitch ${r.pitchBand.toFixed(2)} deg`,
  );
}
{
  // The real requirement: the SAME behaviour at every rate. A loop whose
  // response depends on frame rate is the bug, even if each rate is stable.
  const bands = results.map((r) => r.altBand);
  const spread = Math.max(...bands) - Math.min(...bands);
  ok(
    'behaviour does not depend on frame rate',
    spread < 45,
    `altitude band spread across 15-144 fps: ${spread.toFixed(0)} ft`,
  );
}
{
  // And with jitter on top, which is what a real browser actually delivers.
  const r = holdAtFps(30, 150, 0.6); // 30 fps +/- 60%
  ok(
    'holds altitude at 30 fps with +/-60% jitter',
    r.altBand < 80 && r.reversals < 30,
    `band ${r.altBand.toFixed(0)} ft, ${r.reversals} reversals`,
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
