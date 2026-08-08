/**
 * check-trim.mjs — elevator trim does what trim is for.
 *
 * The test that matters is not "does the number move". It is: CAN YOU LET GO?
 * Trim exists so that at a chosen power the aeroplane holds its altitude with
 * the stick released. Before this axis existed, CM0 fixed the hands-off speed
 * at about 91 kt and every other speed drifted — which is exactly what a player
 * reported as "it won't maintain altitude".
 *
 * Everything below flies with `pitch: 0` — the stick released — because a test
 * that holds the stick is testing the stick.
 */

import { createFlightModel } from '../src/physics/flightModel.js';

const DT = 1 / 60;
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

/**
 * Fly hands-off at a trim and power, high enough that a descent has room to
 * settle rather than hitting the ground and reporting zeros.
 */
function handsOff(trim, throttle, { settleS = 120, measureS = 60, altM = 4000 } = {}) {
  const flight = createFlightModel({ groundHeightFn: () => 0 });
  flight.reset(47.53, -122.30, 0, { altitudeMslM: altM, airspeedMs: 100 * 0.514444 });
  const s = flight.state;
  const inputs = { pitch: 0, roll: 0, yaw: 0, trim, throttle, flaps: 0, brakes: 0, gear: 1 };

  for (let i = 0; i < settleS * 60; i += 1) {
    flight.step(DT, inputs, 0);
    if (s.crashed) return { crashed: true, trim, throttle };
  }
  let lo = Infinity;
  let hi = -Infinity;
  let vsSum = 0;
  const n = measureS * 60;
  for (let i = 0; i < n; i += 1) {
    flight.step(DT, inputs, 0);
    lo = Math.min(lo, s.altitudeFt);
    hi = Math.max(hi, s.altitudeFt);
    vsSum += s.verticalSpeedFpm;
  }
  return {
    crashed: false,
    trim,
    throttle,
    kts: s.airspeedKts,
    meanVs: vsSum / n,
    bandFt: hi - lo,
    trimReached: s.trim,
  };
}

console.log('\ntrim — can you let go?');
{
  // THE HEADLINE. At cruise power there is a trim setting that holds altitude
  // with the stick released. This is the whole feature.
  const r = handsOff(0.3, 0.8);
  ok(
    'trimmed and hands off, it holds altitude',
    !r.crashed && Math.abs(r.meanVs) < 120 && r.bandFt < 250,
    `mean VS ${r.meanVs.toFixed(0)} fpm, band ${r.bandFt.toFixed(0)} ft at ${r.kts.toFixed(0)} kt`,
  );
}
{
  // And the same power UNTRIMMED does not — otherwise the test above proves
  // nothing about trim, only about that power setting.
  const trimmed = handsOff(0.3, 0.8);
  const untrimmed = handsOff(0, 0.8);
  ok(
    'and it does NOT hold untrimmed at the same power',
    !untrimmed.crashed && Math.abs(untrimmed.meanVs) > Math.abs(trimmed.meanVs) + 80,
    `untrimmed ${untrimmed.meanVs.toFixed(0)} fpm vs trimmed ${trimmed.meanVs.toFixed(0)}`,
  );
}

console.log('\ntrim — it selects a speed');
{
  const nose_up = handsOff(0.35, 0.7);
  const neutral = handsOff(0, 0.7);
  const nose_dn = handsOff(-0.25, 0.7);
  ok(
    'nose-up trim settles SLOWER than neutral',
    !nose_up.crashed && !neutral.crashed && nose_up.kts < neutral.kts - 5,
    `${nose_up.kts.toFixed(0)} kt vs ${neutral.kts.toFixed(0)} kt`,
  );
  ok(
    'nose-down trim settles FASTER than neutral',
    !nose_dn.crashed && nose_dn.kts > neutral.kts + 5,
    `${nose_dn.kts.toFixed(0)} kt vs ${neutral.kts.toFixed(0)} kt`,
  );
  ok(
    'and the trimmed speeds are inside the real envelope',
    nose_up.kts > 40 && nose_dn.kts < 165,
    `${nose_up.kts.toFixed(0)} .. ${nose_dn.kts.toFixed(0)} kt against Vs 40 / Vne 165`,
  );
}

console.log('\ntrim — authority is bounded');
{
  // A trim tab cannot fly the aeroplane on its own. Full nose-up trim must not
  // be able to hold it in a stall hands-off, or trim becomes a suicide switch.
  const r = handsOff(1, 0.5, { settleS: 90, measureS: 30 });
  ok(
    'full nose-up trim does not park it in a stall',
    r.crashed || r.kts > 38,
    r.crashed ? 'crashed (acceptable: it descended into terrain)' : `${r.kts.toFixed(0)} kt`,
  );
}
{
  // The stick must still out-authority the trim, in both directions. If trim
  // can beat the pilot, a badly trimmed aeroplane is unrecoverable.
  const flight = createFlightModel({ groundHeightFn: () => 0 });
  flight.reset(47.53, -122.30, 0, { altitudeMslM: 4000, airspeedMs: 100 * 0.514444 });
  const s = flight.state;
  for (let i = 0; i < 60 * 60; i += 1) {
    flight.step(DT, { pitch: 0, roll: 0, yaw: 0, trim: 1, throttle: 0.6, flaps: 0, brakes: 0, gear: 1 }, 0);
  }
  const vsHandsOff = s.verticalSpeedFpm;
  for (let i = 0; i < 60 * 20; i += 1) {
    flight.step(DT, { pitch: -1, roll: 0, yaw: 0, trim: 1, throttle: 0.6, flaps: 0, brakes: 0, gear: 1 }, 0);
  }
  ok(
    'full forward stick beats full nose-up trim',
    s.verticalSpeedFpm < vsHandsOff - 200,
    `${vsHandsOff.toFixed(0)} fpm hands off -> ${s.verticalSpeedFpm.toFixed(0)} fpm pushing`,
  );
}

console.log('\ntrim — the wheel behaves like a wheel');
{
  const flight = createFlightModel({ groundHeightFn: () => 0 });
  flight.reset(47.53, -122.30, 0, { altitudeMslM: 3000, airspeedMs: 100 * 0.514444 });
  const s = flight.state;
  const inputs = { pitch: 0, roll: 0, yaw: 0, trim: 1, throttle: 0.6, flaps: 0, brakes: 0, gear: 1 };
  flight.step(DT, inputs, 0);
  const after1 = s.trim;
  for (let i = 0; i < 60 * 4; i += 1) flight.step(DT, inputs, 0);
  const after4s = s.trim;
  ok(
    'trim moves SLOWLY, not instantly',
    after1 < 0.05,
    `${after1.toFixed(4)} after one frame of full demand`,
  );
  ok(
    'and reaches about half travel in 4 s',
    after4s > 0.3 && after4s < 0.75,
    `${after4s.toFixed(2)} after 4 s (8 s end to end)`,
  );
}
{
  const flight = createFlightModel({ groundHeightFn: () => 0 });
  flight.reset(47.53, -122.30, 0, { altitudeMslM: 3000, airspeedMs: 100 * 0.514444 });
  const s = flight.state;
  for (let i = 0; i < 60 * 10; i += 1) {
    flight.step(DT, { pitch: 0, roll: 0, yaw: 0, trim: 0.8, throttle: 0.6, flaps: 0, brakes: 0, gear: 1 }, 0);
  }
  const held = s.trim;
  flight.reset(47.53, -122.30, 0, { altitudeMslM: 3000, airspeedMs: 100 * 0.514444 });
  ok('trim latches while demanded', held > 0.5, `${held.toFixed(2)}`);
  ok('and reset() returns it to neutral', s.trim === 0, `${s.trim}`);
}

console.log(
  failed === 0
    ? `\n\x1b[32mall ${passed} trim checks passed\x1b[0m\n`
    : `\n\x1b[31m${failed} of ${passed + failed} trim checks FAILED\x1b[0m\n`,
);
process.exit(failed === 0 ? 0 : 1);
