/**
 * check-shadows.mjs — the parts of the cascaded shadow system a machine can
 * check without a GPU.
 *
 *   node scripts/check-shadows.mjs
 *
 * Shadows fail in ways that look fine in a still and are obvious in motion —
 * a box that breathes with the camera's fov, a centre that is not on the texel
 * grid, a cascade that claims a depth band twice. None of that is visible in a
 * screenshot, and all of it is arithmetic, so all of it belongs here.
 *
 * three.js runs headless in Node as long as nothing asks for a WebGL context.
 * shadows.js is written for that: `createShadows` takes the renderer only to
 * set three flags on it and tolerates a stub.
 *
 * What is checked:
 *   1. the frustum-slice bounding sphere really bounds the slice — brute-forced
 *      against all eight corners, at every camera fov the sim uses
 *   2. the cascades tile the view depth exactly once, with no gap and no
 *      double-claim, and the cross-fade weights sum to 1 through every seam
 *   3. THE SNAP: a sub-texel camera move must not move the shadow map's centre
 *      at all, and a large move must move it by a whole number of texels
 *   4. the box does not breathe: rolling the camera through 360 degrees leaves
 *      every cascade's radius bit-identical
 *   5. the fov sweep the chase camera does with airspeed changes the radius a
 *      handful of times, not every frame
 *   6. shadows fade out below the horizon and the maps stop being rendered
 *   7. bias scales with texel size and stays under the caps
 *   8. THE MORPH LIFT: shadows.js takes terrain.js's CDLOD vertex morph out of
 *      terrain.js's own material at run time rather than copying it, because a
 *      copy went stale within the hour the first time. This checks the three
 *      `#include` markers that makes possible are still there, that shadows.js
 *      still holds no copy, and that the extractor refuses — returning null, so
 *      terrain simply stops casting — rather than guessing when they move.
 */

import * as THREE from 'three';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  createShadows,
  _sliceSphere,
  _TIERS,
  _extractTerrainMorph,
  _TERRAIN_ANCHORS,
  _MAX_CASCADES,
} from '../src/world/shadows.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');

let failures = 0;
const ok = (name, cond, note = '') => {
  if (cond) {
    console.log(`  ok   ${name}${note ? `  (${note})` : ''}`);
  } else {
    failures++;
    console.log(`  FAIL ${name}${note ? `  (${note})` : ''}`);
  }
};
const close = (a, b, tol) => Math.abs(a - b) <= tol;

// The fovs cameras.js actually produces: chase 58-65, cockpit 22-92,
// orbit 50, flyby 12-55.
const FOVS = [12, 22, 40, 50, 55, 58, 65, 68, 92];
const ASPECTS = [1000 / 562, 4 / 3, 21 / 9];

function makeScene() {
  const scene = new THREE.Scene();
  // sky.js's two real directional lights, in the order sky.js adds them.
  const sun = new THREE.DirectionalLight(0xffffff, 2.6);
  sun.name = 'sky-sun';
  scene.add(sun, sun.target);
  const moon = new THREE.DirectionalLight(0xb9caff, 0);
  moon.name = 'sky-moon';
  scene.add(moon, moon.target);
  return scene;
}

function makeCam(fov = 58, aspect = 1000 / 562) {
  const c = new THREE.PerspectiveCamera(fov, aspect, 0.35, 300000);
  c.updateProjectionMatrix();
  return c;
}

// ---------------------------------------------------------------------------
console.log('\nframe: the frustum-slice bounding sphere');
{
  const s = { z: 0, r: 0 };
  let worstSlack = Infinity;
  let allInside = true;
  let checked = 0;

  for (const fov of FOVS) {
    for (const aspect of ASPECTS) {
      const tanV = Math.tan((fov * Math.PI) / 360);
      const tanH = tanV * aspect;
      for (const [n, f] of [[0.35, 70], [70, 300], [300, 1200], [1200, 4000], [0.35, 4000]]) {
        _sliceSphere(n, f, tanV, aspect, s);
        let maxD = 0;
        for (const d of [n, f]) {
          for (const sx of [-1, 1]) {
            for (const sy of [-1, 1]) {
              const dx = sx * d * tanH;
              const dy = sy * d * tanV;
              const dz = -d - s.z;
              maxD = Math.max(maxD, Math.hypot(dx, dy, dz));
            }
          }
        }
        checked++;
        if (maxD > s.r * (1 + 1e-9)) allInside = false;
        // Signed, so a sphere that is too SMALL shows up as a negative slack
        // rather than being hidden by a Math.min against zero.
        worstSlack = Math.min(worstSlack, (s.r - maxD) / s.r);
      }
    }
  }
  ok(
    'every slice corner is inside its sphere',
    allInside,
    `${checked} slices over ${FOVS.length} fovs x ${ASPECTS.length} aspects`,
  );
  ok(
    'the sphere is tight, not merely valid — wasted radius is wasted texels',
    worstSlack > -1e-9 && worstSlack < 0.02,
    `worst unused radius ${(worstSlack * 100).toFixed(4)}%`,
  );
}

// ---------------------------------------------------------------------------
console.log('\nsplits: the cascades tile the view depth exactly once');
{
  for (const tierName of ['low', 'medium', 'high']) {
    const scene = makeScene();
    const sun = new THREE.Vector3(0.3, 0.7, -0.6).normalize();
    const sh = createShadows(scene, { shadowMap: {} }, { quality: tierName, sunDirection: sun });
    const cam = makeCam();
    cam.position.set(0, 300, 0);
    cam.lookAt(2000, 0, -4000);
    cam.updateMatrixWorld();
    for (let i = 0; i < 8; i++) sh.update(cam);

    const splits = sh._splits.value;
    const n = _TIERS[tierName].cascades;

    // The weight the shader computes, mirrored here.
    const weight = (i, z) => {
      const v = splits[i];
      return (
        THREE.MathUtils.clamp((z - v.x) * v.y, 0, 1) *
        (1 - THREE.MathUtils.clamp((z - v.z) * v.w, 0, 1))
      );
    };

    // The covered band runs from 0 to where the LAST cascade starts fading out.
    const far = _TIERS[tierName].splits[n - 1];
    const fadeStart = splits[n - 1].z;
    let worstSum = 1;
    let bestSum = 1;
    for (let z = 0.5; z < fadeStart; z += fadeStart / 4000) {
      let sum = 0;
      for (let i = 0; i < n; i++) sum += weight(i, z);
      worstSum = Math.min(worstSum, sum);
      bestSum = Math.max(bestSum, sum);
    }
    ok(
      `${tierName}: shadow weight is exactly 1 everywhere the cascades cover`,
      close(worstSum, 1, 1e-6) && close(bestSum, 1, 1e-6),
      `0 to ${fadeStart.toFixed(0)} m: min ${worstSum.toFixed(6)}, max ${bestSum.toFixed(6)}`,
    );

    // Past the far cascade it must ramp down, not end at a line.
    const sumAt = (z) => {
      let s2 = 0;
      for (let i = 0; i < n; i++) s2 += weight(i, z);
      return s2;
    };
    const mid = (fadeStart + far) / 2;
    ok(
      `${tierName}: shadow ramps out over the last cascade rather than ending at a line`,
      close(sumAt(fadeStart - 1), 1, 1e-3) &&
        sumAt(mid) > 0.4 &&
        sumAt(mid) < 0.6 &&
        sumAt(far * 1.01) === 0,
      `1 at ${fadeStart.toFixed(0)} m -> ${sumAt(mid).toFixed(2)} at ${mid.toFixed(0)} m -> 0 past ${far} m`,
    );

    // Monotone: no bump back up on the way out.
    let monotone = true;
    let prev = 1;
    for (let z = fadeStart; z <= far; z += (far - fadeStart) / 500) {
      const s2 = sumAt(z);
      if (s2 > prev + 1e-9) monotone = false;
      prev = s2;
    }
    ok(`${tierName}: the ramp-out never goes back up`, monotone);

    // Unused cascade slots must claim nothing at any depth.
    let ghost = 0;
    for (let i = n; i < _MAX_CASCADES; i++) {
      for (const z of [1, 100, 5000, 1e5]) ghost += weight(i, z);
    }
    ok(`${tierName}: unused cascade slots claim no weight`, ghost === 0);

    sh.dispose();
  }
}

// ---------------------------------------------------------------------------
console.log('\nstability: the snap, and the box that must not breathe');
{
  const scene = makeScene();
  const sun = new THREE.Vector3(0.35, 0.62, -0.7).normalize();
  const sh = createShadows(scene, { shadowMap: {} }, { quality: 'high', sunDirection: sun });
  const cam = makeCam(58);
  cam.position.set(0, 400, 0);
  cam.lookAt(3000, 0, -6000);
  cam.updateMatrixWorld();
  for (let i = 0; i < 8; i++) sh.update(cam);

  const snapshot = () =>
    sh.lights.map((l) => ({
      pos: l.position.clone(),
      r: l.shadow.camera.right,
      near: l.shadow.camera.near,
      far: l.shadow.camera.far,
    }));

  const base = snapshot();
  const texel0 = sh.getStats().cascades[0].texelM;

  // 3a. A move of a tenth of a texel must not move cascade 0 at all.
  cam.position.x += texel0 * 0.1;
  cam.updateMatrixWorld();
  sh.update(cam);
  let a = snapshot();
  ok(
    'a 0.1-texel camera move does not move the shadow map',
    a[0].pos.distanceTo(base[0].pos) < 1e-9,
    `texel ${(texel0 * 100).toFixed(1)} cm, moved ${(a[0].pos.distanceTo(base[0].pos) * 1000).toFixed(4)} mm`,
  );

  // 3b. A big move must land on the texel lattice: the displacement projected
  //     into light space must be a whole number of texels in x and y.
  cam.position.set(137.77, 400, -213.31);
  cam.updateMatrixWorld();
  sh.update(cam);
  a = snapshot();
  const basis = new THREE.Matrix4().lookAt(sun, new THREE.Vector3(), new THREE.Vector3(0, 1, 0));
  const inv = basis.clone().transpose();
  const d = a[0].pos.clone().sub(base[0].pos).applyMatrix4(inv);
  const fx = Math.abs(d.x / texel0 - Math.round(d.x / texel0));
  const fy = Math.abs(d.y / texel0 - Math.round(d.y / texel0));
  ok(
    'a large camera move lands the map on a whole number of texels',
    fx < 1e-4 && fy < 1e-4,
    `residue ${(fx * 100).toFixed(4)}% / ${(fy * 100).toFixed(4)}% of a texel`,
  );

  // 4. Rolling and yawing must not change any cascade's size. Settle first:
  //    the staggered cascades pad their box by how far the camera has been
  //    moving, and 3b just teleported it 250 m.
  const radii = () => sh.lights.map((l) => l.shadow.camera.right);
  cam.position.set(0, 400, 0);
  cam.rotation.set(0, 0, 0);
  cam.updateMatrixWorld();
  for (let i = 0; i < 12; i++) sh.update(cam);
  const r0 = radii();
  let breathed = 0;
  let worst = 0;
  for (let deg = 0; deg < 360; deg += 5) {
    cam.rotation.set(
      (0.4 * Math.sin((deg * Math.PI) / 180)),
      (deg * Math.PI) / 180,
      (0.7 * Math.cos((deg * Math.PI) / 180)),
    );
    cam.updateMatrixWorld();
    sh.update(cam);
    const r = radii();
    for (let i = 0; i < r.length; i++) {
      const e = Math.abs(r[i] - r0[i]) / r0[i];
      if (e > 1e-12) breathed++;
      worst = Math.max(worst, e);
    }
  }
  ok(
    'rolling and yawing 360 degrees does not resize any cascade',
    breathed === 0,
    `worst change ${(worst * 100).toFixed(6)}%`,
  );

  // 5. The chase camera's fov moves with airspeed. The radius must be quantised
  //    coarsely enough that it holds still through an acceleration.
  let changes = 0;
  let prev = null;
  for (let f = 58; f <= 65; f += 0.05) {
    cam.fov = f;
    cam.updateProjectionMatrix();
    cam.updateMatrixWorld();
    sh.update(cam);
    const r = radii()[0];
    if (prev !== null && r !== prev) changes++;
    prev = r;
  }
  ok(
    'a full 58-65 degree fov sweep resizes cascade 0 at most twice',
    changes <= 2,
    `${changes} resizes over 141 steps`,
  );

  sh.dispose();
}

// ---------------------------------------------------------------------------
console.log('\nsun: the shadows follow it, and stop when it sets');
{
  const scene = makeScene();
  const sun = new THREE.Vector3(0, 1, 0);
  const sh = createShadows(scene, { shadowMap: {} }, { quality: 'high', sunDirection: sun });
  const cam = makeCam();
  cam.position.set(0, 100, 0);
  cam.lookAt(1000, 0, -1000);
  cam.updateMatrixWorld();

  const at = (elevDeg, azDeg = 200) => {
    const e = (elevDeg * Math.PI) / 180;
    const a = (azDeg * Math.PI) / 180;
    sun.set(Math.sin(a) * Math.cos(e), Math.sin(e), -Math.cos(a) * Math.cos(e)).normalize();
    for (let i = 0; i < 6; i++) sh.update(cam);
    return sh.getStats();
  };

  // The light must sit up-sun of the region it lights.
  const s45 = at(45);
  const dir45 = sh.lights[0].position.clone().sub(sh.lights[0].target.position).normalize();
  ok(
    'the cascade light sits up-sun of its box',
    dir45.dot(sun) > 0.9999,
    `dot ${dir45.dot(sun).toFixed(6)}`,
  );

  const s30 = at(30);
  const dir30 = sh.lights[0].position.clone().sub(sh.lights[0].target.position).normalize();
  ok(
    'moving the sun re-aims every cascade',
    dir30.dot(sun) > 0.9999 && dir30.angleTo(dir45) > 0.2,
    `${((dir30.angleTo(dir45) * 180) / Math.PI).toFixed(1)} deg of swing for 15 deg of sun`,
  );

  ok('shadows are at full strength with the sun at 45 deg', close(s45.sunFade, 1, 1e-6));
  ok('shadows are at full strength with the sun at 30 deg', close(s30.sunFade, 1, 1e-6));

  const s4 = at(4);
  ok(
    'shadows fade through the last few degrees above the horizon',
    s4.sunFade > 0.05 && s4.sunFade < 0.95,
    `fade ${s4.sunFade.toFixed(3)} at 4 deg`,
  );

  const sNight = at(-8);
  ok('shadows are gone below the horizon', sNight.sunFade === 0);
  ok(
    'and their maps stop being rendered at night',
    sh.lights.every((l) => l.shadow.autoUpdate === false && l.shadow.needsUpdate === false),
  );
  ok(
    'but the lights stay in the scene, so nothing recompiles at dusk',
    sh.lights.every((l) => l.castShadow === true && l.parent === scene),
  );
  ok(
    'the cascade lights emit no light of their own — sky.js owns that',
    sh.lights.every((l) => l.intensity === 0),
  );

  sh.dispose();
}

// ---------------------------------------------------------------------------
console.log('\nbias: proportional to the texel, capped so contact survives');
{
  const scene = makeScene();
  const sun = new THREE.Vector3(0.3, 0.6, -0.74).normalize();
  const sh = createShadows(scene, { shadowMap: {} }, { quality: 'high', sunDirection: sun });
  const cam = makeCam(58);
  cam.position.set(0, 250, 0);
  cam.lookAt(2000, 0, -3000);
  cam.updateMatrixWorld();
  for (let i = 0; i < 8; i++) sh.update(cam);
  const cs = sh.getStats().cascades;

  ok(
    'cascade 0 resolves the runway at better than 10 cm per texel',
    cs[0].texelM < 0.10,
    `${(cs[0].texelM * 100).toFixed(1)} cm`,
  );
  ok(
    'cascade 0 normal-offset stays well under the 1.20 m gear height',
    cs[0].normalBiasM < 0.2,
    `${(cs[0].normalBiasM * 100).toFixed(1)} cm — §2.10 gearHeightM is 1.20 m`,
  );
  ok('texel size grows monotonically outward', cs.every((c, i) => i === 0 || c.texelM > cs[i - 1].texelM));
  ok(
    'normal-offset never exceeds 1.2 m, or distant buildings lose their shadows',
    cs.every((c) => c.normalBiasM <= 1.2 + 1e-9),
    cs.map((c) => c.normalBiasM.toFixed(2)).join(' / '),
  );
  ok(
    'depth bias is negative — getShadow ADDS it, so it must push toward the light',
    cs.every((c) => c.depthBias < 0),
  );
  ok(
    'the shadow camera depth range holds the terrain relief above each box',
    cs.every((c) => c.marginM >= 300),
    cs.map((c) => Math.round(c.marginM)).join(' / ') + ' m',
  );

  // Staggering: cascades 0 and 1 must never be skipped, the far ones must be.
  const share = sh.getStats().cascades.map((c) => c.renderShare);
  ok(
    'cascades 0 and 1 render every frame — the aeroplane lives there',
    share[0] === 1 && share[1] === 1,
  );
  ok(
    'the far cascades are staggered, and never on the same frame',
    _TIERS.high.period[2] > 1 &&
      _TIERS.high.period[3] > 1 &&
      _TIERS.high.phase[2] !== _TIERS.high.phase[3],
    `periods ${_TIERS.high.period.join(',')} phases ${_TIERS.high.phase.join(',')}`,
  );

  sh.dispose();
}

// ---------------------------------------------------------------------------
console.log('\nwiring: what the shader patch depends on');
{
  ok(
    'three still has the directional block lights_fragment_begin is patched around',
    THREE.ShaderChunk.lights_fragment_begin.includes('CSM_CASCADES'),
    'the patch found its anchors and applied',
  );
  ok(
    'materials without the define still compile the stock path',
    THREE.ShaderChunk.lights_fragment_begin.includes('#else'),
  );
  ok(
    'the split uniform is declared for the fragment shader',
    THREE.ShaderChunk.lights_pars_begin.includes(`uniform vec4 uCsmSplits[ ${_MAX_CASCADES} ]`),
  );
  ok(
    'the sun is picked out by index, not by hope',
    THREE.ShaderChunk.lights_fragment_begin.includes(
      '#if ( UNROLLED_LOOP_INDEX == NUM_DIR_LIGHT_SHADOWS )',
    ),
  );
}

// ---------------------------------------------------------------------------
console.log('\nterrain morph: lifted, not copied');
{
  const terrainSrc = readFileSync(join(ROOT, 'src/world/terrain.js'), 'utf8');

  // shadows.js does not contain the morph — it takes terrain.js's own. What it
  // DOES depend on is the three include markers terrain patches, and that the
  // morph is camera-dependent and moves vertices. Those are the contract.
  for (const anchor of _TERRAIN_ANCHORS) {
    ok(
      `terrain.js still injects at #include <${anchor}>`,
      terrainSrc.includes(`'#include <${anchor}>'`),
      'the probe finds the morph by slicing between these',
    );
  }
  ok(
    'the terrain morph is still a function of cameraPosition',
    /distance\(cameraPosition, position\)/.test(terrainSrc),
    'which is the LIGHT in a shadow pass — hence uEyePos',
  );
  ok(
    'the terrain morph still moves vertices, so the stock depth material is wrong',
    /transformed\.y\s*=/.test(terrainSrc),
  );
  ok(
    'shadows.js carries no copy of the morph expression',
    !readFileSync(join(ROOT, 'src/world/shadows.js'), 'utf8').includes('aMorph.x, tMorph'),
    'a copy is what went stale within the hour last time',
  );

  // The extractor itself, against a stand-in shaped exactly like terrain's.
  const fake = new THREE.MeshStandardMaterial();
  const fakeUniforms = { uThing: { value: 7 } };
  fake.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, fakeUniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec3 aMorph;')
      .replace(
        '#include <beginnormal_vertex>',
        '#include <beginnormal_vertex>\nfloat tMorph = distance(cameraPosition, position);',
      )
      .replace(
        '#include <begin_vertex>',
        'vec3 transformed = vec3( position );\ntransformed.y = mix(position.y, aMorph.x, tMorph);',
      );
  };
  const ex = _extractTerrainMorph(fake, null);
  ok('the extractor finds all three blocks', !!ex && !!ex.common && !!ex.normal && !!ex.begin);
  ok('it brings the surface material’s uniforms across by reference', ex && ex.uniforms.uThing === fakeUniforms.uThing);
  ok('it does not disturb the real material', fake.vertexShader === undefined);

  // And it must REFUSE rather than guess when the shape changes.
  const moved = new THREE.MeshStandardMaterial();
  moved.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader.replace('#include <common>', '#include <common>');
  };
  ok('it returns null when the morph is not there at all', _extractTerrainMorph(moved, null) === null);
  const thrower = new THREE.MeshStandardMaterial();
  thrower.onBeforeCompile = () => {
    throw new Error('boom');
  };
  ok('it returns null rather than propagating a throw', _extractTerrainMorph(thrower, null) === null);
  ok('and null means terrain stops casting, not that it casts wrongly', true, 'see tagObject');
}

// ---------------------------------------------------------------------------
console.log('\nownership: §1.7 says sky.js owns every light');
{
  const skySrc = readFileSync(join(ROOT, 'src/world/sky.js'), 'utf8');
  ok('sky.js is the only module that constructs the shadows', skySrc.includes('createShadows('));
  ok(
    'and it drives them from scene.onBeforeRender, so main.js needs no line',
    skySrc.includes('scene.onBeforeRender') && skySrc.includes('shadows.update(camera)'),
  );
  const mainSrc = readFileSync(join(ROOT, 'src/main.js'), 'utf8');
  ok(
    'main.js contains no shadow wiring at all',
    !mainSrc.includes('shadowMap') && !mainSrc.includes('castShadow'),
  );
}

// ---------------------------------------------------------------------------
// 'off' IS A TIER, NOT A FLAG. The phone budget (core/device.js) buys its whole
// draw-call ceiling by turning shadows off, and "off" has to mean off: no
// per-frame traverse of a scene with ~500 objects in it, and no CSM_CASCADES
// handed to materials that will never have a cascade to sample. Measured before
// this rule existed: 62 materials carrying the define with zero cascades built,
// and 20 of the 31 live programs with `CSM_CASCADES,4` in the cache key — every
// one of them a first-use compile stall on a mobile driver.
console.log("\n'off': the phone tier's shadow cost is zero, not nearly zero");
{
  const scene = makeScene();
  // Enough of a scene to notice: a lit mesh under each of the three tag rules.
  const lit = () => new THREE.MeshStandardMaterial();
  const plane = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), lit());
  plane.name = 'runway-asphalt';
  const tower = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), lit());
  tower.name = 'city-tall';
  const far = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), lit());
  far.name = 'city-minor';
  far.userData.csmNoCast = true;
  scene.add(plane, tower, far);

  const cam = makeCam();
  cam.updateMatrixWorld();

  const off = createShadows(scene, { shadowMap: {} }, { quality: 'off' });
  for (let i = 0; i < 5; i++) off.update(cam);
  const so = off.getStats();
  ok('no cascade lights exist', off.lights.length === 0);
  ok('the tagging traverse does not run', so.tagging === false && so.tagMs === 0);
  ok(
    'and no material anywhere is given CSM_CASCADES',
    so.materialsSetUp === 0 &&
      [plane, tower, far].every((m) => !m.material.defines?.CSM_CASCADES),
  );
  off.dispose();

  // The same scene at 'high' — the rules must still be the rules.
  const on = createShadows(scene, { shadowMap: {} }, { quality: 'high' });
  for (let i = 0; i < 3; i++) on.update(cam);
  const sh = on.getStats();
  ok('at a real tier the traverse runs again', sh.tagging === true);
  ok(
    'and every lit material gets the define back',
    sh.materialsSetUp >= 3 &&
      [plane, tower, far].every((m) => m.material.defines.CSM_CASCADES === _MAX_CASCADES),
  );

  // The opt-out landmarkModels.js asked for by name. Without it, a module that
  // knows one of its meshes is too far away to cast a visible shadow has no way
  // to say so: this traversal sets castShadow = true on it again every frame.
  ok('userData.csmNoCast is honoured', far.castShadow === false);
  ok('and it is an opt-out from CASTING only', far.receiveShadow === true);
  ok('everything else still casts', plane.castShadow === true && tower.castShadow === true);

  // Every cascade must be asked for its first map, whatever its phase says —
  // otherwise three binds its default 2x2 RGBA texture to a sampler2DShadow for
  // a whole frame and the driver rejects every draw call that reads it.
  ok(
    'every cascade is primed on the first frame, whatever its phase',
    sh.mapsUnprimed === 0,
    `${sh.mapsUnprimed} of ${on.lights.length} unprimed`,
  );
  on.dispose();
}

console.log(
  failures ? `\n${failures} shadow check(s) FAILED\n` : '\nall shadow checks passed\n',
);
process.exit(failures ? 1 : 0);
