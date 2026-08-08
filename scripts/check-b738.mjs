/**
 * check-b738.mjs — is the 737 the shape it claims, and do its parts move?
 *
 *   node scripts/check-b738.mjs
 *
 * The sibling of check-aircraft.mjs, and it exists for the same reason: the
 * visual airframe is a thousand lines of procedural geometry with no art asset
 * to diff against, and it is PURELY COSMETIC. Nothing downstream reads it, so
 * nothing downstream can notice when it is wrong. A fin rotated the wrong way
 * about Z builds a complete, correct, beautifully lofted vertical stabiliser
 * pointing straight down through the runway, and renders without a single
 * warning. That is not hypothetical — it is what this file caught first.
 *
 * three.js runs headless in Node as long as nothing asks for a WebGL context.
 * b738model.js is written to survive that (HAS_CANVAS gates the texture work,
 * the renderer argument is optional), so the whole airframe can be built and
 * measured here without a browser.
 *
 * What is checked:
 *   1. it builds with no DOM and no renderer, and has an environment map anyway
 *   2. the published 737-800 dimensions, measured off the actual vertices
 *   3. THE THREE CLEARANCES — wheels at -2.90, belly, and the engine, which is
 *      the dimension that makes a 737 a 737
 *   4. every control surface deflects, in the right direction, to the right
 *      angle, and the ailerons are DIFFERENTIAL
 *   5. the fans turn and cross-fade to a disc, driven by N1 and not by rpm
 *   6. no NaN vertices, and the static bake collapses the draw calls
 */

import * as THREE from 'three';

// Override the clock BEFORE importing the model: setControlSurfaces derives its
// own dt from performance.now(), and the surface-lag test needs to control it.
let clockMs = 0;
globalThis.performance = { now: () => clockMs };

const { createB738 } = await import('../src/aircraft/b738model.js');

let failures = 0;
let checks = 0;
const ok = (name, cond, note = '') => {
  checks++;
  if (!cond) failures++;
  console.log(
    `  ${cond ? '\x1b[32m ok \x1b[0m' : '\x1b[31mFAIL\x1b[0m'} ${name}${note ? `   (${note})` : ''}`,
  );
};
const near = (name, got, want, tol, unit = 'm') => {
  checks++;
  const good = Number.isFinite(got) && Math.abs(got - want) <= tol;
  if (!good) failures++;
  console.log(
    `  ${good ? '\x1b[32m ok \x1b[0m' : '\x1b[31mFAIL\x1b[0m'} ${name.padEnd(38)}` +
      ` ${got.toFixed(3).padStart(9)} ${unit}   want ${want} +/- ${tol}`,
  );
};
const head = (t) => {
  console.log(`\n\x1b[1m${t}\x1b[0m`);
  console.log('-'.repeat(t.length));
};
const say = (label, value, unit = '') =>
  console.log(`  ${label.padEnd(38)} ${String(value).padStart(12)} ${unit}`);

/** Deflection of a hinge pivot about its local X, in degrees. */
const hingeDeg = (o) =>
  (2 * Math.asin(Math.max(-1, Math.min(1, o.quaternion.x))) * 180) / Math.PI;

/**
 * Bounding box in WORLD space.
 *
 * The updateMatrixWorld() is not optional. Nothing has rendered, so every
 * matrixWorld in the graph is still identity, and Box3.setFromObject then
 * happily measures the mesh in LOCAL space — parent group offsets vanish
 * without a word. That put the engine nacelle 1.9 m above the wheels instead
 * of 0.45 m, which read as a modelling error and was a measurement error.
 */
const bbox = (o) => {
  o.updateMatrixWorld(true);
  return new THREE.Box3().setFromObject(o);
};

// ---------------------------------------------------------------------------
head('1. it builds headless, with no DOM and no renderer');
// ---------------------------------------------------------------------------
const scene = new THREE.Scene();
let ac = null;
let buildErr = null;
try {
  ac = createB738(scene);
} catch (err) {
  buildErr = err;
}
ok('createB738 returned', !!ac && !buildErr, buildErr ? buildErr.stack.split('\n')[0] : '');
if (!ac) {
  console.log('\n\x1b[31mcannot continue\x1b[0m\n');
  process.exit(1);
}
ok('it was added to the scene', scene.children.includes(ac.group));
ok('the group is named', ac.group.name === 'aircraft', ac.group.name);
{
  // Every painted material must carry an envMap even with no renderer — see
  // makeSkyEnvTexture. Bare metal with no reflection reads as flat grey card.
  let withEnv = 0;
  let physical = 0;
  ac.group.traverse((o) => {
    if (!o.isMesh) return;
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    for (const m of mats) {
      if (m.isMeshStandardMaterial || m.isMeshPhysicalMaterial) {
        physical++;
        if (m.envMap) withEnv++;
      }
    }
  });
  ok('every lit material has an environment map', physical > 0 && withEnv === physical,
    `${withEnv}/${physical}`);
}

// ---------------------------------------------------------------------------
head('2. the published 737-800 dimensions, measured off the vertices');
// ---------------------------------------------------------------------------
{
  const b = bbox(ac.group);
  const size = b.getSize(new THREE.Vector3());
  say('bounding box y', `${b.min.y.toFixed(3)} .. ${b.max.y.toFixed(3)}`, 'm');
  say('bounding box z', `${b.min.z.toFixed(3)} .. ${b.max.z.toFixed(3)}`, 'm');

  // Span is measured over the WINGLETS, which is why it is not 34.32. The bare
  // wing is 34.32 and the blended winglets add about 0.7 m a side.
  near('span over the winglets', size.x, 35.4, 0.7);
  near('length, radome to rudder', size.z, 39.47, 0.6);
  near('height, wheels to fin tip', size.y, 12.55, 0.3);
  near('fin tip', b.max.y, 9.65, 0.15);
  near('nose', b.min.z, -19.60, 0.15);
}

// ---------------------------------------------------------------------------
head('3. THE THREE CLEARANCES — this is where a 737 is or is not a 737');
// ---------------------------------------------------------------------------
{
  // Built again without the static bake so individual parts can be identified.
  // Merged geometry makes "the engine" un-measurable, and the engine is the
  // whole point of this section.
  const s2 = new THREE.Scene();
  const raw = createB738(s2, { noBake: true });
  raw.group.updateMatrixWorld(true);

  // Wheels. flightModel's gearHeightM for this airframe is 2.90, so the lowest
  // point of the aeroplane must be y = -2.90. A polygonal tyre is a few
  // millimetres shy of its own radius — an 18-sided wheel's lowest VERTEX sits
  // at r*cos(pi/18) — which is where the tolerance comes from.
  let lowest = Infinity;
  raw.group.traverse((o) => {
    if (!o.isMesh) return;
    const y = bbox(o).min.y;
    if (y < lowest) lowest = y;
  });
  near('lowest point = gearHeightM', lowest, -2.90, 0.02);

  // Belly. 1.0 m of fuselage clearance.
  let belly = Infinity;
  raw.group.traverse((o) => {
    if (o.isMesh && o.name === 'fuselage') belly = bbox(o).min.y;
  });
  near('belly clearance above the wheels', belly - lowest, 1.02, 0.12);

  // THE ENGINE. 0.46 m on the real aeroplane, and the reason the CFM56 inlet
  // is flat-bottomed rather than round. If this comes out at a comfortable
  // metre then the model is a generic twinjet and not this one.
  let nacelleBottom = Infinity;
  let nacelleBox = null;
  raw.group.traverse((o) => {
    if (!o.isMesh || o.name !== 'nacelle') return;
    const b = bbox(o);
    if (b.min.y < nacelleBottom) { nacelleBottom = b.min.y; nacelleBox = b; }
  });
  near('ENGINE clearance above the wheels', nacelleBottom - lowest, 0.46, 0.12);
  ok('  and it is tighter than the belly clearance',
    nacelleBottom - lowest < belly - lowest,
    'on a 737 the engine is the lowest thing on the aeroplane bar the wheels');

  // The flattened inlet: the nacelle must be measurably wider than it is tall.
  const nac = nacelleBox
    ? { w: nacelleBox.max.x - nacelleBox.min.x, h: nacelleBox.max.y - nacelleBox.min.y }
    : null;
  if (nac) {
    say('nacelle width / height', `${nac.w.toFixed(2)} / ${nac.h.toFixed(2)}`, 'm');
    ok('the nacelle is FLAT-BOTTOMED, not round', nac.h < nac.w * 0.96,
      `${(nac.h / nac.w).toFixed(3)} height:width — a round one would be 1.00`);
  } else {
    ok('the nacelle was found to measure', false, 'no mesh matched the nacelle signature');
  }

  raw.dispose();
}

// ---------------------------------------------------------------------------
head('4. control surfaces — they must deflect, and correctly');
// ---------------------------------------------------------------------------
{
  /** Run the surface animation to completion at a given stick position. */
  const settle = (c, seconds = 20) => {
    for (let i = 0; i < seconds * 20; i++) {
      clockMs += 50;
      ac.setControlSurfaces(c);
    }
    const out = [];
    ac.group.traverse((o) => {
      if (o.isGroup && Math.abs(hingeDeg(o)) > 0.02) out.push(hingeDeg(o));
    });
    return out;
  };

  // Elevator: stick BACK (+pitch) must send the trailing edge UP, which about
  // a +X hinge is a NEGATIVE rotation. Getting this backwards gives an
  // aeroplane that dives when you pull, and it renders perfectly.
  let d = settle({ pitch: 1, roll: 0, yaw: 0, flaps: 0 });
  const elevUp = d.filter((v) => Math.abs(v + 20) < 1.5);
  ok('stick back deflects two elevator halves', elevUp.length === 2, `${elevUp.length} found`);
  near('  elevator up travel', elevUp[0] ?? 0, -20, 1.5, 'deg');

  d = settle({ pitch: -1, roll: 0, yaw: 0, flaps: 0 });
  const elevDn = d.filter((v) => Math.abs(v - 25) < 1.5);
  ok('stick forward is the other way', elevDn.length === 2, `${elevDn.length} found`);
  near('  elevator down travel', elevDn[0] ?? 0, 25, 1.5, 'deg');

  // Ailerons: DIFFERENTIAL. The up-going one travels further than the
  // down-going one, which is how a real aeroplane fights adverse yaw. A pair
  // that moves symmetrically is the easy bug and looks fine in a screenshot.
  d = settle({ pitch: 0, roll: 1, yaw: 0, flaps: 0 });
  const up = d.find((v) => Math.abs(v - 20) < 1.5);
  const dn = d.find((v) => Math.abs(v + 15) < 1.5);
  ok('roll right moves both ailerons', up !== undefined && dn !== undefined,
    d.map((v) => v.toFixed(1)).join(', '));
  ok('  they move in OPPOSITE directions', (up ?? 0) * (dn ?? 0) < 0);
  ok('  and DIFFERENTIALLY, up further than down',
    Math.abs(up ?? 0) > Math.abs(dn ?? 0) + 3,
    `up ${Math.abs(up ?? 0).toFixed(1)} vs down ${Math.abs(dn ?? 0).toFixed(1)} deg`);

  // Rudder.
  d = settle({ pitch: 0, roll: 0, yaw: 1, flaps: 0 });
  const rud = d.find((v) => Math.abs(v - 25) < 1.5);
  ok('right rudder deflects the rudder', rud !== undefined, d.map((v) => v.toFixed(1)).join(', '));

  // Flaps only ever go down, and they travel at the airframe's own rate: 0.08
  // of full travel per second, so full flap takes 12.5 seconds. If this file
  // and b738.js ever disagree, the aeroplane you see is not the one you fly.
  settle({ pitch: 0, roll: 0, yaw: 0, flaps: 0 }, 30);
  clockMs += 0;
  let flapAt6 = 0;
  for (let i = 0; i < 6 * 20; i++) {
    clockMs += 50;
    ac.setControlSurfaces({ pitch: 0, roll: 0, yaw: 0, flaps: 1 });
  }
  ac.group.traverse((o) => {
    if (o.isGroup && Math.abs(hingeDeg(o)) > 0.02) flapAt6 = Math.max(flapAt6, hingeDeg(o));
  });
  near('flaps after 6 s at 0.08/s', flapAt6, 0.48 * 40, 2.0, 'deg');
  d = settle({ pitch: 0, roll: 0, yaw: 0, flaps: 1 }, 30);
  const flaps = d.filter((v) => Math.abs(v - 40) < 1.5);
  ok('flaps reach 40 deg, both sides', flaps.length === 2, `${flaps.length} found`);
  ok('  and they only ever go DOWN', flaps.every((v) => v > 0));

  settle({ pitch: 0, roll: 0, yaw: 0, flaps: 0 }, 30);
}

// ---------------------------------------------------------------------------
head('5. the fans — driven by N1, not by rpm');
// ---------------------------------------------------------------------------
{
  // THE TRAP THIS GUARDS. A turbofan publishes state.rpm = 0 and reports N1
  // instead. Wiring spinProp to rpm out of habit leaves the fans frozen solid
  // while the aeroplane flies — which looks like a rendering bug and is
  // actually a units bug, and nothing throws.
  const fanAngle = () => {
    const a = [];
    ac.group.traverse((o) => { if (o.isGroup && o.name === 'fan') a.push(o.rotation.z); });
    return a;
  };
  const before = fanAngle();
  ac.spinProp(0, 1 / 60);
  const atIdleStop = fanAngle();
  ok('N1 = 0 leaves the fans still',
    before.every((v, i) => Math.abs(v - atIdleStop[i]) < 1e-9));

  ac.spinProp(90, 1 / 60);
  const after = fanAngle();
  ok('N1 = 90% turns them', after.some((v, i) => Math.abs(v - atIdleStop[i]) > 1e-4),
    `${after.length} fans`);

  // A long frame must not fling the angle somewhere absurd — modulo, not a
  // single wrap. At 5,160 rpm a 0.25 s frame is 21 revolutions.
  ac.spinProp(100, 0.25);
  ok('a long frame wraps properly', fanAngle().every((v) => v >= -1e-6 && v <= Math.PI * 2 + 1e-6),
    fanAngle().map((v) => v.toFixed(2)).join(', '));

  // Blur cross-fade. A CFM56 is past the aliasing point at idle, so unlike a
  // propeller there is barely a solid-blade regime at all.
  const discOpacity = () => {
    let o = -1;
    ac.group.traverse((m) => { if (m.isMesh && m.name === 'fanDisc') o = m.material.opacity; });
    return o;
  };
  ac.spinProp(5, 1 / 60);
  const lo = discOpacity();
  ac.spinProp(90, 1 / 60);
  const hi = discOpacity();
  say('disc opacity at 5% / 90% N1', `${lo.toFixed(3)} / ${hi.toFixed(3)}`);
  ok('the fan blurs to a disc as N1 rises', hi > lo + 0.5);

  ok('garbage input is ignored', (() => {
    const a = fanAngle();
    ac.spinProp(NaN, 1 / 60);
    ac.spinProp(50, NaN);
    return fanAngle().every((v, i) => Math.abs(v - a[i]) < 1e-9);
  })());
}

// ---------------------------------------------------------------------------
head('6. geometry hygiene');
// ---------------------------------------------------------------------------
{
  let nan = 0;
  let tris = 0;
  let draws = 0;
  ac.group.traverse((o) => {
    if (!o.isMesh) return;
    draws++;
    const p = o.geometry.attributes.position;
    tris += p.count / 3;
    for (let i = 0; i < p.count; i++) {
      if (!Number.isFinite(p.getX(i)) || !Number.isFinite(p.getY(i)) || !Number.isFinite(p.getZ(i))) nan++;
    }
  });
  say('meshes (draw calls)', draws);
  say('triangles', Math.round(tris));
  ok('no NaN vertices anywhere', nan === 0, `${nan} found`);
  // Everything rigid merges; what survives is the moving parts, which is the
  // point. Six hinged control panels, two fan discs, two blade rings, two
  // spinners, and the hull.
  ok('the static bake collapsed the draw calls', draws < 26, `${draws} meshes`);

  const s3 = new THREE.Scene();
  const raw = createB738(s3, { noBake: true });
  let rawDraws = 0;
  raw.group.traverse((o) => { if (o.isMesh) rawDraws++; });
  say('meshes before the bake', rawDraws);
  // The unbaked count is 64 rather than the full part count because the fan
  // blade rings are merged at construction time regardless — see b738model.
  ok('  the bake is actually doing work', rawDraws - draws > 30, `${rawDraws} -> ${draws}`);
  raw.dispose();
}

// ---------------------------------------------------------------------------
head('7. dispose');
// ---------------------------------------------------------------------------
{
  ac.dispose();
  ok('dispose() detaches the group', !scene.children.includes(ac.group));
  let threw = false;
  try { ac.dispose(); } catch { threw = true; }
  ok('dispose() is idempotent', !threw);
}

console.log(
  failures
    ? `\n\x1b[31m${failures} of ${checks} checks FAILED\x1b[0m\n`
    : `\n\x1b[32mall ${checks} 737 model checks passed\x1b[0m\n`,
);
process.exit(failures ? 1 : 0);
