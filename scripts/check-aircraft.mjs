/**
 * check-aircraft.mjs — is the airframe the shape it claims, and do the moving
 * parts actually move?
 *
 *   node scripts/check-aircraft.mjs
 *
 * aircraft/model.js is 2,100 lines of procedural geometry with no art asset to
 * diff against, and it is purely cosmetic — nothing downstream reads it, so
 * nothing downstream can notice when it is wrong. A control surface hinged
 * about the wrong axis, an aileron pair that moves together instead of
 * differentially, a wheel 30 cm below where flightModel puts the contact patch:
 * all of it builds, all of it renders, none of it throws.
 *
 * three.js runs headless in Node as long as nothing asks for a WebGL context.
 * model.js is written to survive exactly that (`HAS_CANVAS` gates the texture
 * work, the renderer argument is optional), so the whole airframe can be built
 * and measured here without a browser.
 *
 * What is checked:
 *   1. it builds with no DOM and no renderer, and has an environment map anyway
 *   2. the published Cessna 172 dimensions, measured off the actual vertices
 *   3. the wheels touch y = -1.20, which is flightModel's gearHeightM
 *   4. every control surface deflects, in the right direction, to the right
 *      angle — and the ailerons are DIFFERENTIAL
 *   5. the propeller turns and cross-fades to a blur disc
 *   6. no NaN vertices anywhere, and the static bake actually collapses the
 *      draw calls
 */

import * as THREE from 'three';

// Override the clock BEFORE importing the model: setControlSurfaces derives its
// own dt from performance.now(), and the surface-lag test needs to control it.
let clockMs = 0;
globalThis.performance = { now: () => clockMs };

const { createAircraft } = await import('../src/aircraft/model.js');

// ---------------------------------------------------------------------------
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
  const good = Math.abs(got - want) <= tol;
  if (!good) failures++;
  console.log(
    `  ${good ? '\x1b[32m ok \x1b[0m' : '\x1b[31mFAIL\x1b[0m'} ${name.padEnd(40)}` +
      ` ${got.toFixed(3).padStart(8)} ${unit}   want ${want} +-${tol}`,
  );
};
const head = (t) => console.log(`\n\x1b[1m${t}\x1b[0m\n${'-'.repeat(t.length)}`);
const say = (l, v, u = '') => console.log(`  ${l.padEnd(40)} ${String(v).padStart(10)} ${u}`);

// ---------------------------------------------------------------------------
head('1. it builds headless, with no DOM and no renderer');
// ---------------------------------------------------------------------------
const scene = new THREE.Scene();
let ac = null;
let buildErr = null;
const warnings = [];
const realWarn = console.warn;
console.warn = (...a) => warnings.push(a.join(' '));
try {
  ac = createAircraft(scene);
} catch (e) {
  buildErr = e;
} finally {
  console.warn = realWarn;
}
ok('createAircraft returned', !!ac && !buildErr, buildErr ? buildErr.stack.split('\n')[0] : '');
if (!ac) {
  console.log('\n\x1b[31mcannot continue\x1b[0m\n');
  process.exit(1);
}
ok('the group is named "aircraft"', ac.group.name === 'aircraft');
ok('it added itself to the scene', scene.children.includes(ac.group));
ok('the group is left at identity (main.js owns the transform)',
  ac.group.position.lengthSq() === 0 && ac.group.quaternion.w === 1);
ok('exposes the documented API', typeof ac.setControlSurfaces === 'function' && typeof ac.spinProp === 'function');
console.log(warnings.length ? `     warnings: ${warnings.join(' | ')}` : '     (no warnings)');
ok('only the expected headless warning about textures',
  warnings.every((w) => /procedural textures|environment/.test(w)), warnings.join(' | '));

// An envMap must exist even though no renderer was passed — without one the
// PBR materials have no reflection term and the paint reads as matte vinyl.
{
  const mats = new Set();
  ac.group.traverse((o) => {
    if (o.isMesh) (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => mats.add(m));
  });
  const physical = [...mats].filter((m) => m.isMeshStandardMaterial || m.isMeshPhysicalMaterial);
  const withEnv = physical.filter((m) => m.envMap);
  say('PBR materials on the airframe', physical.length);
  say('of those, carrying an envMap', withEnv.length);
  ok('the paint has something to reflect without a renderer', withEnv.length >= 6,
    `${withEnv.length}/${physical.length}`);
  const env = withEnv[0] && withEnv[0].envMap;
  ok('the fallback env map is equirect, so three will PMREM it itself',
    !!env && env.mapping === THREE.EquirectangularReflectionMapping,
    env ? `mapping=${env.mapping}` : 'none');
  ok('env map pixels are finite', !!env && env.image.data.every ? [...env.image.data].every(Number.isFinite) : true);
}

// ---------------------------------------------------------------------------
head('2. the published Cessna 172 dimensions, measured off the vertices');
// ---------------------------------------------------------------------------
const box = new THREE.Box3().setFromObject(ac.group);
const size = box.getSize(new THREE.Vector3());
say('bounding box min', `${box.min.x.toFixed(2)}, ${box.min.y.toFixed(2)}, ${box.min.z.toFixed(2)}`);
say('bounding box max', `${box.max.x.toFixed(2)}, ${box.max.y.toFixed(2)}, ${box.max.z.toFixed(2)}`);

// Wingspan is the widest thing on the aeroplane.
near('wingspan (published 11.00)', size.x, 11.0, 0.15);
// Nose (spinner tip) to rudder trailing edge. The published 8.28 m is spinner
// to rudder TE, which is what -Z min to +Z max measures.
near('length (published 8.28)', size.z, 8.28, 0.45);
// Ground to fin tip. The wheels are at y = -1.20, the fin tip at about +1.55.
near('height, wheels to fin tip (published 2.72)', size.y, 2.72, 0.20);

// ---------------------------------------------------------------------------
head('3. THE VERTICAL DATUM — the wheels must be at flightModel gearHeightM');
// ---------------------------------------------------------------------------
// flightModel's default gearHeightM is 1.2, meaning the contact patch is 1.20 m
// below the physics datum. If the mesh disagrees, the aeroplane visibly floats
// above or sinks into a runway that the physics says it is sitting on — and
// nothing in either module can detect it.
near('lowest point of the airframe', box.min.y, -1.2, 0.02);
{
  // The tyres specifically, not (say) an antenna that happens to hang lower.
  let lowestName = '';
  let lowest = Infinity;
  ac.group.traverse((o) => {
    if (!o.isMesh || !o.geometry) return;
    const b = new THREE.Box3().setFromObject(o);
    if (b.min.y < lowest) {
      lowest = b.min.y;
      lowestName = o.name || o.geometry.type;
    }
  });
  say('lowest mesh', lowestName, `y = ${lowest.toFixed(3)}`);
  ok('nothing hangs below the wheels', lowest >= -1.205, `${lowest.toFixed(3)} m`);
}

// ---------------------------------------------------------------------------
head('4. control surfaces — they must deflect, and correctly');
// ---------------------------------------------------------------------------
// Find the hinged pivots. They are the Groups flagged userData.animated, and
// they are identifiable by where their hinge sits rather than by creation
// order: ailerons outboard of 2 m, flaps inboard of it, elevators aft with an
// X offset, the rudder aft on the centreline.
const pivots = { ailR: null, ailL: null, flapR: null, flapL: null, elevR: null, elevL: null, rudder: null, prop: null };
ac.group.traverse((o) => {
  if (!o.isGroup || o.userData.animated !== true) return;
  if (o.name === 'propeller') {
    pivots.prop = o;
    return;
  }
  const p = o.position;
  if (p.z > 2) {
    if (Math.abs(p.x) < 0.05) pivots.rudder = o;
    else if (p.x > 0) pivots.elevR = o;
    else pivots.elevL = o;
  } else if (Math.abs(p.x) > 2) {
    if (p.x > 0) pivots.ailR = o;
    else pivots.ailL = o;
  } else {
    if (p.x > 0) pivots.flapR = o;
    else pivots.flapL = o;
  }
});
for (const [k, v] of Object.entries(pivots)) {
  ok(`hinge found: ${k}`, !!v, v ? `at ${v.position.x.toFixed(2)}, ${v.position.y.toFixed(2)}, ${v.position.z.toFixed(2)}` : 'MISSING');
}

const X = new THREE.Vector3(1, 0, 0);
const Y = new THREE.Vector3(0, 1, 0);
/** Signed deflection about `axis`, in degrees. + is trailing edge DOWN. */
function defl(pivot, axis) {
  const q = pivot.quaternion;
  const s = Math.hypot(q.x, q.y, q.z);
  let a = 2 * Math.atan2(s, q.w);
  if (a > Math.PI) a -= 2 * Math.PI;
  if (s > 1e-9 && (q.x * axis.x + q.y * axis.y + q.z * axis.z) / s < 0) a = -a;
  return (a * 180) / Math.PI;
}
/** Drive the surfaces to a steady state (they are rate-limited on purpose). */
function settle(c, seconds = 3) {
  for (let i = 0; i < seconds * 60; i++) {
    clockMs += 1000 / 60;
    ac.setControlSurfaces(c);
  }
}

settle({ pitch: 0, roll: 0, yaw: 0, flaps: 0 });
ok('everything centres at neutral stick',
  [pivots.ailR, pivots.ailL, pivots.elevR, pivots.elevL, pivots.rudder, pivots.flapR]
    .every((p) => Math.abs(defl(p, X)) < 0.01) && Math.abs(defl(pivots.rudder, Y)) < 0.01);

// --- elevator --------------------------------------------------------------
settle({ pitch: 1 });
const eUp = defl(pivots.elevR, X);
say('stick full BACK, elevator', eUp.toFixed(1), 'deg (- is TE up)');
near('elevator up travel (published 28)', -eUp, 28, 0.5, 'deg');
ok('both elevators move together', Math.abs(defl(pivots.elevL, X) - eUp) < 0.01);
settle({ pitch: -1 });
const eDn = defl(pivots.elevR, X);
say('stick full FORWARD, elevator', eDn.toFixed(1), 'deg (+ is TE down)');
near('elevator down travel (published 23)', eDn, 23, 0.5, 'deg');
ok('pulling and pushing move it OPPOSITE ways', eUp * eDn < 0);

// --- ailerons, differential ------------------------------------------------
settle({ roll: 1 });
const aR = defl(pivots.ailR, X);
const aL = defl(pivots.ailL, X);
say('stick full RIGHT, right aileron', aR.toFixed(1), 'deg');
say('stick full RIGHT, left aileron', aL.toFixed(1), 'deg');
ok('ailerons move in OPPOSITE directions', aR * aL < 0, `${aR.toFixed(1)} / ${aL.toFixed(1)} deg`);
ok('roll right puts the RIGHT aileron UP', aR < 0, `${aR.toFixed(1)} deg`);
ok('roll right puts the LEFT aileron DOWN', aL > 0, `${aL.toFixed(1)} deg`);
near('up-going aileron travel (published 20)', -aR, 20, 0.5, 'deg');
near('down-going aileron travel (published 15)', aL, 15, 0.5, 'deg');
ok('THE AILERONS ARE DIFFERENTIAL, not symmetric',
  Math.abs(Math.abs(aR) - Math.abs(aL)) > 3,
  `up ${Math.abs(aR).toFixed(1)} vs down ${Math.abs(aL).toFixed(1)} deg`);

settle({ roll: -1 });
const bR = defl(pivots.ailR, X);
const bL = defl(pivots.ailL, X);
say('stick full LEFT, right aileron', bR.toFixed(1), 'deg');
say('stick full LEFT, left aileron', bL.toFixed(1), 'deg');
// Mirroring SWAPS the two surfaces, it does not negate them: right stick is
// (R -20 up, L +15 down), so left stick must be (R +15 down, L -20 up).
ok('left stick mirrors right stick', Math.abs(bR - aL) < 0.01 && Math.abs(bL - aR) < 0.01,
  `right stick (${aR.toFixed(1)}, ${aL.toFixed(1)}) vs left stick (${bR.toFixed(1)}, ${bL.toFixed(1)})`);
ok('the differential follows the stick, not the wing',
  Math.abs(bL) > Math.abs(bR), `left up ${Math.abs(bL).toFixed(1)} vs right down ${Math.abs(bR).toFixed(1)} deg`);

// --- rudder ----------------------------------------------------------------
settle({ yaw: 1 });
const r1 = defl(pivots.rudder, Y);
say('full RIGHT rudder', r1.toFixed(1), 'deg');
near('rudder travel', Math.abs(r1), 21, 0.5, 'deg');
ok('right rudder swings the trailing edge to +X (nose right)', r1 > 0, `${r1.toFixed(1)} deg`);
settle({ yaw: -1 });
ok('left rudder is the mirror', Math.abs(defl(pivots.rudder, Y) + r1) < 0.01);

// --- flaps -----------------------------------------------------------------
settle({ flaps: 1 }, 10);
const fR = defl(pivots.flapR, X);
say('flaps at the 30 deg detent', fR.toFixed(1), 'deg');
near('flap travel (published 30)', fR, 30, 0.5, 'deg');
ok('both flaps go down together', Math.abs(defl(pivots.flapL, X) - fR) < 0.01);
ok('flaps go DOWN, never up', fR > 0);

// --- and they LAG, at the flight model's own rates -------------------------
settle({ pitch: 0, roll: 0, yaw: 0, flaps: 0 }, 12);
{
  // One frame of a full stick step must move the elevator part way, not all
  // the way. flightModel uses SURFACE_RATE = 4.0 /s, so 1/60 s is 6.7% of full
  // travel and the elevator should reach about 1.9 of its 28 degrees.
  clockMs += 1000 / 60;
  ac.setControlSurfaces({ pitch: 1 });
  const oneFrame = -defl(pivots.elevR, X);
  say('elevator after ONE frame of full aft stick', oneFrame.toFixed(2), 'deg of 28');
  ok('the elevator lags the stick rather than snapping', oneFrame > 0.3 && oneFrame < 6,
    `${oneFrame.toFixed(2)} deg in 16.7 ms`);

  // The flaps are much slower: 5 s lever to detent, so one second is 20%.
  settle({ flaps: 0 }, 12);
  for (let i = 0; i < 60; i++) {
    clockMs += 1000 / 60;
    ac.setControlSurfaces({ flaps: 1 });
  }
  const after1s = defl(pivots.flapR, X);
  say('flaps one second after selecting 30', after1s.toFixed(2), 'deg of 30');
  ok('flaps take about five seconds to run out', after1s > 3 && after1s < 9, `${after1s.toFixed(2)} deg after 1 s`);
}

ok('setControlSurfaces tolerates junk', (() => {
  try {
    ac.setControlSurfaces();
    ac.setControlSurfaces({});
    ac.setControlSurfaces({ pitch: NaN, roll: Infinity, yaw: 'x', flaps: -5 });
    ac.setControlSurfaces({ pitch: 99, roll: -99 });
    return [pivots.ailR, pivots.elevR, pivots.rudder].every((p) => Number.isFinite(p.quaternion.w));
  } catch {
    return false;
  }
})());

// ---------------------------------------------------------------------------
head('5. the propeller — it turns, and it blurs to a disc');
// ---------------------------------------------------------------------------
{
  const prop = pivots.prop;
  ok('the propeller pivot exists and is animated', !!prop && prop.userData.animated === true);

  const blades = [];
  let disc = null;
  prop.traverse((o) => {
    if (!o.isMesh) return;
    if (o.geometry.type === 'CircleGeometry') disc = o;
    else if (o.material && o.material.transparent && o.geometry.type === 'BufferGeometry') blades.push(o);
  });
  ok('two blades', blades.length >= 2, `${blades.length} transparent blade meshes`);
  ok('a blur disc exists', !!disc);

  prop.rotation.z = 0;
  ac.spinProp(2400, 1 / 60);
  const a1 = prop.rotation.z;
  ac.spinProp(2400, 1 / 60);
  const a2 = prop.rotation.z;
  say('prop angle after one frame at 2400 rpm', a1.toFixed(3), 'rad');
  ok('the propeller actually turns', a1 !== 0 && a2 !== a1);
  // 2400 rpm = 40 rev/s; one 60 Hz frame is 0.667 rev = 4.19 rad, and it turns
  // CLOCKWISE seen from the cockpit, which is NEGATIVE about +Z.
  const step = ((a1 - 0) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2);
  near('one frame of rotation at 2400 rpm', Math.PI * 2 - step, 4.189, 0.01, 'rad');

  // Wrapping: a long frame must not leave the angle miles from where it should
  // be, and must never go non-finite.
  for (let i = 0; i < 500; i++) ac.spinProp(2700, 0.25);
  ok('the prop angle stays wrapped and finite',
    Number.isFinite(prop.rotation.z) && Math.abs(prop.rotation.z) <= Math.PI * 2 + 1e-9,
    prop.rotation.z.toFixed(4));

  // Blur crossfade.
  ac.spinProp(0, 1 / 60);
  say('at rest — disc visible', String(disc.visible), `blade opacity ${blades[0].material.opacity.toFixed(2)}`);
  ok('at rest the blades are solid and the disc is off',
    blades[0].material.opacity > 0.99 && disc.visible === false);

  ac.spinProp(700, 1 / 60);
  const midOp = disc.material.opacity;
  say('at 700 rpm — disc opacity', midOp.toFixed(2), `blade opacity ${blades[0].material.opacity.toFixed(2)}`);
  ok('mid-range is a genuine CROSS-FADE, both partly visible',
    midOp > 0.05 && midOp < 0.9 && blades[0].material.opacity > 0.1 && blades[0].material.opacity < 0.99);

  ac.spinProp(2400, 1 / 60);
  say('at 2400 rpm — disc opacity', disc.material.opacity.toFixed(2), `blade opacity ${blades[0].material.opacity.toFixed(2)}`);
  ok('at cruise rpm the disc has taken over', disc.visible && disc.material.opacity > 0.85);
  ok('but a faint blade ghost remains, as a real prop does',
    blades[0].material.opacity > 0.02 && blades[0].material.opacity < 0.2,
    blades[0].material.opacity.toFixed(3));

  ok('spinProp tolerates junk', (() => {
    ac.spinProp(NaN, 1 / 60);
    ac.spinProp(2400, NaN);
    ac.spinProp(-500, 1e6);
    return Number.isFinite(prop.rotation.z);
  })());

  // The blades must be near the PLANE OF ROTATION, not feathered along the
  // axis. A blade whose chord lies along the prop axis is a paddle edge-on and
  // is visible any time the engine is idling and the blades are still solid.
  //
  // Measured at the TIP station, where the blade angle is 4 degrees and the
  // chord should be almost entirely in the plane of the disc. Taking the whole
  // blade's bounding box blurs the answer, because the root really is set at
  // 26 degrees and does carry an axial component.
  const bladeGeo = blades[0].geometry.getAttribute('position');
  let tipYmin = Infinity, tipYmax = -Infinity, tipZmin = Infinity, tipZmax = -Infinity;
  let spanMax = 0;
  for (let i = 0; i < bladeGeo.count; i++) {
    const x = Math.abs(bladeGeo.getX(i));
    spanMax = Math.max(spanMax, x);
    if (x < 0.85) continue;
    tipYmin = Math.min(tipYmin, bladeGeo.getY(i));
    tipYmax = Math.max(tipYmax, bladeGeo.getY(i));
    tipZmin = Math.min(tipZmin, bladeGeo.getZ(i));
    tipZmax = Math.max(tipZmax, bladeGeo.getZ(i));
  }
  const inPlane = tipYmax - tipYmin;
  const axial = tipZmax - tipZmin;
  say('tip section: in-plane vs axial extent',
    `${inPlane.toFixed(3)} vs ${axial.toFixed(3)}`, 'm');
  say('implied tip blade angle from the disc plane',
    ((Math.atan2(axial, inPlane) * 180) / Math.PI).toFixed(1), 'deg (want ~4-15)');
  ok('the blade chord lies IN the disc, not along the axis (not feathered)',
    inPlane > axial * 2.5,
    `chord ${inPlane.toFixed(3)} m in-plane vs ${axial.toFixed(3)} m axial`);
  near('propeller diameter (published 1.90)', spanMax * 2, 1.9, 0.1);
}

// ---------------------------------------------------------------------------
head('6. geometry hygiene');
// ---------------------------------------------------------------------------
{
  let meshes = 0;
  let tris = 0;
  let verts = 0;
  let bad = 0;
  let noNormals = 0;
  ac.group.traverse((o) => {
    if (!o.isMesh) return;
    meshes++;
    const pos = o.geometry.getAttribute('position');
    verts += pos.count;
    tris += (o.geometry.index ? o.geometry.index.count : pos.count) / 3;
    const arr = pos.array;
    for (let i = 0; i < arr.length; i++) if (!Number.isFinite(arr[i])) bad++;
    if (!o.geometry.getAttribute('normal')) noNormals++;
  });
  say('meshes (draw calls)', meshes);
  say('triangles', Math.round(tris));
  say('vertices', verts);
  ok('no NaN or Infinity in any vertex', bad === 0, `${bad} bad floats`);
  ok('every mesh has normals', noNormals === 0, `${noNormals} without`);
  // The airframe is assembled from ~80 parts. bakeStatic merges everything
  // static into one mesh per material; if it silently failed, the draw-call
  // count would still be in the dozens.
  ok('the static bake collapsed the draw calls', meshes < 30, `${meshes} meshes`);
  ok('the triangle budget is sane for a chase view', tris > 5000 && tris < 400000, `${Math.round(tris)} tris`);
}

// ---------------------------------------------------------------------------
head('7. dispose');
// ---------------------------------------------------------------------------
{
  const before = scene.children.length;
  ac.dispose();
  ok('dispose() detaches the group', scene.children.length === before - 1);
  ok('dispose() is idempotent', (() => {
    try {
      ac.dispose();
      return true;
    } catch {
      return false;
    }
  })());
}

console.log(
  failures
    ? `\n\x1b[31m${failures} of ${checks} aircraft checks FAILED\x1b[0m\n`
    : `\n\x1b[32mall ${checks} aircraft checks passed\x1b[0m\n`,
);
process.exit(failures ? 1 : 0);
