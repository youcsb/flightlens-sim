/**
 * check-sky.mjs — executable form of MODULES.md §2.8's atmosphere half.
 *
 *   npm run check:sky
 *
 * WHY THIS EXISTS. Round 1's sky was wrong in a way no unit test would have
 * caught and no screenshot review did catch for a whole round: the model was
 * right, the constants in front of it were not, and the failure mode was a
 * gentle overall paleness rather than anything that looks like a bug. "Flat
 * pale blue-grey with almost no vertical gradient" is a sentence a human had to
 * write. This file turns it into a number.
 *
 * Three things are measured, all against the SHIPPING code:
 *
 *   1. THE GRADIENT. `sampleSky()` is the same evalSky + acesToneMap pair the
 *      GLSL mirrors and the fog colour is derived from. Eleven elevations from
 *      zenith to 1 deg are scored in sRGB against measured clear-day sky, with
 *      the 0-40 deg band weighted up because that is what a cockpit camera
 *      frames. Round 1 scored 47.5. The bar is 20.
 *
 *   2. AERIAL PERSPECTIVE. `aerialTransmittanceJs()` is the CPU mirror of the
 *      GLSL in the fog chunk. The assertions are the ones the critic's verdict
 *      turns into: Mount Rainier's rock must separate from its snow by HUE and
 *      not just brightness, and the mountain's base must haze more than its
 *      summit — the thing a range-only FogExp2 cannot express.
 *
 *   3. THE VARYING. `vFogWorldY` recovers world Y from view space with one dot
 *      product against a column of viewMatrix. That line is load-bearing for
 *      every fogged material in the scene and is exactly the kind of transpose
 *      that is wrong 50% of the time and only visibly wrong when the camera
 *      rolls. It is checked here against three's own matrices, at attitudes a
 *      flight sim actually reaches.
 *
 * Plus the ordinary guards: the shader strings still parse as balanced GLSL,
 * the chunks really did get installed on THREE.ShaderChunk, and the CPU cloud
 * mirror still agrees with the GLSL it claims to mirror.
 */

import * as THREE from 'three';
import {
  createSky,
  sampleSky,
  aerialTransmittanceJs,
} from '../src/world/sky.js';

let failures = 0;
const ok = (name, cond, note = '') => {
  if (cond) {
    console.log(`  ok   ${name}${note ? `  (${note})` : ''}`);
  } else {
    failures++;
    console.log(`  FAIL ${name}${note ? `  (${note})` : ''}`);
  }
};
const near = (name, got, want, tol, unit = '') =>
  ok(name, Math.abs(got - want) <= tol, `${got.toFixed(3)}${unit} want ${want}±${tol}`);
const within = (name, got, lo, hi, unit = '') =>
  ok(name, got >= lo && got <= hi, `${got.toFixed(3)}${unit} want ${lo}..${hi}`);

const DEG = Math.PI / 180;
const clamp01 = (v) => Math.min(1, Math.max(0, v));
/** Display-linear -> 8-bit sRGB, the numbers a screenshot would show. */
const srgb = (v) => {
  const c = clamp01(v);
  return Math.round(255 * (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055));
};
const triple = (c) => c.map(srgb);

/** Scene direction for an elevation and an azimuth offset from the sun. §1.2. */
function dirAt(elDeg, azOffDeg) {
  const e = elDeg * DEG;
  const a = azOffDeg * DEG;
  const ce = Math.cos(e);
  // The sun sits due south at azimuth offset 0 below.
  return [Math.sin(a) * ce, Math.sin(e), Math.cos(a) * ce];
}
function sunAt(altDeg) {
  const a = altDeg * DEG;
  return [0, Math.sin(a), Math.cos(a)];
}

// The composition main.js actually ships. Scoring the DEFAULTS would let the
// sim look wrong while the harness stayed green.
const SHIPPED = { turbidity: 3.2 };

// ===========================================================================
console.log('\n--- 1. the zenith-to-horizon gradient -------------------------');
// ===========================================================================

/**
 * Measured clear-day sky, sun ~35 deg, looking anti-solar, in sRGB. Weights
 * favour the band a cockpit camera frames: at a 55 deg vertical field with the
 * horizon centred, nothing above ~28 deg elevation is ever on screen.
 */
const TARGET = [
  [90, [55, 115, 195], 0.6], [60, [70, 130, 205], 0.8], [45, [85, 145, 215], 1.0],
  [35, [100, 160, 220], 1.4], [25, [125, 180, 228], 1.6], [18, [148, 193, 232], 1.6],
  [12, [170, 205, 235], 1.4], [8, [190, 215, 238], 1.2], [5, [210, 226, 240], 1.0],
  [2, [226, 234, 241], 0.8], [1, [232, 238, 242], 0.6],
];

const sun35 = sunAt(35);
let err = 0;
let wsum = 0;
const profile = [];
for (const [el, want, w] of TARGET) {
  const got = triple(sampleSky(dirAt(el, 180), sun35, SHIPPED, [0, 0, 0]));
  profile.push({ el, got });
  err += w * Math.hypot(got[0] - want[0], got[1] - want[1], got[2] - want[2]);
  wsum += w;
}
err /= wsum;
for (const p of profile) {
  console.log(`       ${String(p.el).padStart(3)} deg  sRGB ${p.got.join(',')}`);
}
ok('mean weighted sRGB error beats round 1 by 2x', err < 20, `${err.toFixed(1)}, round 1 was 47.5`);

const zenith = profile[0].got;
const horizon = profile[profile.length - 1].got;
// "Almost no vertical gradient" was the verdict. The red channel is the one
// that carries it: blue is near-saturated everywhere, red is not.
within('zenith-to-horizon red span', horizon[0] - zenith[0], 120, 200, ' sRGB');
ok('zenith is blue, not cyan-grey', zenith[2] - zenith[0] > 90,
  `blue-red = ${zenith[2] - zenith[0]}`);
ok('horizon is a white haze band', horizon[0] > 210 && horizon[2] - horizon[0] < 25,
  `sRGB ${horizon.join(',')}`);
// The whole visible band must not be jammed against the top of the tone curve.
const midBand = profile.find((p) => p.el === 25).got;
ok('the 25 deg band is sky, not near-white', midBand[0] < 150, `red ${midBand[0]}`);
// Monotonic paling from zenith to horizon (the 45-60 deg dip is Preetham's
// real anti-solar minimum, so allow the profile to be non-monotonic only there).
let monotone = true;
for (let i = 4; i < profile.length; i++) {
  if (profile[i].got[0] < profile[i - 1].got[0]) monotone = false;
}
ok('pales monotonically from 35 deg down to the horizon', monotone);

console.log('  -- azimuthal structure: the limb glow ------------------------');
// Round 1 mixed the last 1.5 deg of dome 92% into an AZIMUTHAL AVERAGE, which
// is the one operation guaranteed to destroy a warm limb. There must be a
// large toward-sun / away-from-sun difference low down at a low sun.
const sun6 = sunAt(6);
const towardLow = triple(sampleSky(dirAt(1, 0), sun6, SHIPPED, [0, 0, 0]));
const awayLow = triple(sampleSky(dirAt(1, 180), sun6, SHIPPED, [0, 0, 0]));
console.log(`       sun 6 deg, 1 deg elevation:  toward ${towardLow.join(',')}  away ${awayLow.join(',')}`);
ok('the horizon toward a low sun is far brighter than away from it',
  towardLow[0] - awayLow[0] > 60, `red ${towardLow[0]} vs ${awayLow[0]}`);
ok('and it is WARM: red leads blue toward the sun',
  towardLow[0] > towardLow[2], `${towardLow[0]} vs ${towardLow[2]}`);

console.log('  -- dawn / dusk through setTimeOfDay --------------------------');
for (const [label, alt, wantWarm] of [['noon', 55, false], ['golden', 6, true], ['sunset', 1, true]]) {
  const c = triple(sampleSky(dirAt(0.5, 0), sunAt(alt), SHIPPED, [0, 0, 0]));
  const warm = c[0] > c[2];
  console.log(`       ${label.padEnd(7)} sun ${String(alt).padStart(2)} deg  limb sRGB ${c.join(',')}`);
  ok(`${label}: limb is ${wantWarm ? 'warm' : 'not warm'}`, warm === wantWarm);
}
const sunsetLimb = triple(sampleSky(dirAt(0.5, 0), sunAt(0.5), SHIPPED, [0, 0, 0]));
ok('sunset limb is orange, not merely pale', sunsetLimb[0] - sunsetLimb[2] > 100,
  `sRGB ${sunsetLimb.join(',')}`);

// ===========================================================================
console.log('\n--- 2. aerial perspective ------------------------------------');
// ===========================================================================

const D = 8.0e-6; // the shipped fogDensity
const T = [0, 0, 0];

// Blue must always be stripped fastest and red slowest. If this ever inverts,
// distance stops reading as distance.
aerialTransmittanceJs(0, 0, 20000, D, T);
ok('spectral order holds: red > green > blue transmittance', T[0] > T[1] && T[1] > T[2],
  T.map((v) => v.toFixed(3)).join(' / '));

// The headline shot. Camera at 500 m over Elliott Bay, Rainier's summit 94 km
// out at 4,390 m and its visible base at ~900 m.
const summit = aerialTransmittanceJs(500, 4390, 94000, D, [0, 0, 0]);
const base = aerialTransmittanceJs(500, 900, 94000, D, [0, 0, 0]);
console.log(`       Rainier summit  T = ${summit.map((v) => v.toFixed(3)).join(' / ')}`);
console.log(`       Rainier base    T = ${base.map((v) => v.toFixed(3)).join(' / ')}`);

// Round 1's budget put the whole mountain at a flat 0.426 in every channel.
within('summit green transmittance is in the round-1 budget', summit[1], 0.40, 0.62);
ok('the base hazes MORE than the summit — the thing FogExp2 cannot do',
  base[1] < summit[1] - 0.08, `${base[1].toFixed(3)} vs ${summit[1].toFixed(3)}`);

// Now the actual verdict: a snow-capped cone, not a grey nub and not a smear.
//
// The composite happens in DISPLAY-ENCODED space, because that is where three
// runs <fog_fragment> — after <colorspace_fragment>. So these operands are
// already sRGB-encoded and must NOT be encoded again; `px()` only scales to
// 8 bits. Getting that wrong lifts everything toward white and hides exactly
// the failure this section exists to catch.
const AIR = [0.906, 0.933, 0.937];  // the model's own horizon, sRGB-encoded
const SNOW = [0.95, 0.96, 0.98];
const ROCK = [0.60, 0.54, 0.49];
const px = (c) => c.map((v) => Math.round(255 * clamp01(v)));
const composite = (c, t) => c.map((v, i) => v * t[i] + AIR[i] * (1 - t[i]));
const snowPx = px(composite(SNOW, summit));
const rockPx = px(composite(ROCK, summit));
// Round 1: one scalar transmittance of 0.343 in every channel.
const oldT = [0.343, 0.343, 0.343];
const oldSnow = px(composite(SNOW, oldT));
const oldRock = px(composite(ROCK, oldT));
console.log(`       round 1  snow ${oldSnow.join(',')}   rock ${oldRock.join(',')}`);
console.log(`       now      snow ${snowPx.join(',')}   rock ${rockPx.join(',')}`);
ok('snow stays bright at 94 km', snowPx[0] > 225, `red ${snowPx[0]}`);
ok('rock is clearly darker than snow — a cone, not a smear',
  snowPx[0] - rockPx[0] > 50, `${snowPx[0] - rockPx[0]} sRGB, round 1 gave ${oldSnow[0] - oldRock[0]}`);
ok('rock goes BLUE, not grey — a mountain, not a nub',
  rockPx[2] - rockPx[0] > 25,
  `blue-red = ${rockPx[2] - rockPx[0]}, round 1 gave ${oldRock[2] - oldRock[0]}`);

// Height dependence at the viewer's end too: climbing clears the air.
const low = aerialTransmittanceJs(200, 4390, 94000, D, [0, 0, 0]);
const high = aerialTransmittanceJs(3350, 4390, 94000, D, [0, 0, 0]);
ok('climbing to 11,000 ft sharpens the mountain', high[1] > low[1] + 0.05,
  `${low[1].toFixed(3)} -> ${high[1].toFixed(3)}`);

// The near field must stay legible; this is a flight sim, not a fog bank.
const near5 = aerialTransmittanceJs(0, 0, 5000, D, [0, 0, 0]);
within('5 km is barely hazed', near5[1], 0.90, 0.98);
const near20 = aerialTransmittanceJs(0, 0, 20000, D, [0, 0, 0]);
within('20 km reads as 20 km', near20[1], 0.65, 0.85);

// A horizontal ray is the (1-exp(-x))/x singularity. It must not be special.
const flat = aerialTransmittanceJs(1000, 1000, 30000, D, [0, 0, 0]);
const nearlyFlat = aerialTransmittanceJs(1000, 1000.001, 30000, D, [0, 0, 0]);
ok('a level ray does not divide by zero', Number.isFinite(flat[1]) && flat[1] > 0);
near('and the level branch is continuous', nearlyFlat[1], flat[1], 1e-6);

// In-cloud: the whiteout density must actually white things out.
const inCloudRho = 3 / (190 * 1.8);
const cloudT = aerialTransmittanceJs(1600, 1600, 190, inCloudRho, [0, 0, 0]);
within('190 m visibility inside cloud', cloudT[1], 0.02, 0.09);
ok('and inside cloud the haze is GREY, not spectrally sorted',
  Math.abs(cloudT[0] - cloudT[2]) < 0.01,
  `R-B = ${(cloudT[0] - cloudT[2]).toExponential(1)}`);

// ===========================================================================
console.log('\n--- 3. the vFogWorldY varying --------------------------------');
// ===========================================================================
// world = cameraPosition + mvPosition.xyz * mat3(viewMatrix), whose Y component
// is one dot product with viewMatrix's second COLUMN. Verified against three's
// own matrices at attitudes this sim reaches, including inverted.
{
  const cam = new THREE.PerspectiveCamera(60, 1.7, 0.35, 300000);
  const obj = new THREE.Object3D();
  let worst = 0;
  const attitudes = [
    [0, 0, 0], [0.4, 1.1, 0], [-0.9, 2.7, 0.6], [0.2, -1.4, Math.PI], // inverted
    [1.3, 0.3, -2.2],
  ];
  for (const [rx, ry, rz] of attitudes) {
    cam.position.set(1234.5, 987.25, -4321.75);
    cam.rotation.set(rx, ry, rz, 'YXZ');
    cam.updateMatrixWorld(true);
    cam.matrixWorldInverse.copy(cam.matrixWorld).invert();
    for (const p of [[0, 0, 0], [5000, 4390, -90000], [-800, -120, 300]]) {
      obj.position.set(...p);
      obj.updateMatrixWorld(true);
      const mv = new THREE.Matrix4().multiplyMatrices(cam.matrixWorldInverse, obj.matrixWorld);
      const mvPos = new THREE.Vector3(0, 0, 0).applyMatrix4(mv);
      const e = cam.matrixWorldInverse.elements; // column-major: viewMatrix[1] = e[4..6]
      const glslY = cam.position.y + (mvPos.x * e[4] + mvPos.y * e[5] + mvPos.z * e[6]);
      worst = Math.max(worst, Math.abs(glslY - p[1]));
      // vFogDepth is the RADIAL distance, not -mvPosition.z.
      const glslDist = mvPos.length();
      const trueDist = new THREE.Vector3(...p).distanceTo(cam.position);
      worst = Math.max(worst, Math.abs(glslDist - trueDist) * 1e-3);
    }
  }
  ok('world Y and slant range are recovered exactly from view space', worst < 1e-3,
    `worst ${worst.toExponential(2)} m`);
}

// ===========================================================================
console.log('\n--- 4. the chunks are really installed -----------------------');
// ===========================================================================
for (const name of ['fog_pars_vertex', 'fog_vertex', 'fog_pars_fragment', 'fog_fragment']) {
  ok(`ShaderChunk.${name} is ours`, THREE.ShaderChunk[name].includes('vFogWorldY'));
  ok(`ShaderChunk.${name} still guards on USE_FOG`, THREE.ShaderChunk[name].includes('#ifdef USE_FOG'));
}
ok('the fog chunk calls the shared airlight function',
  THREE.ShaderChunk.fog_fragment.includes('aerialTransmittance('));
ok('and the pars chunk defines it', THREE.ShaderChunk.fog_pars_fragment.includes('vec3 aerialTransmittance('));
// The composite must land AFTER three's colorspace conversion, i.e. it must
// operate on gl_FragColor and not on a linear working value.
ok('the composite writes gl_FragColor.rgb', THREE.ShaderChunk.fog_fragment.includes('gl_FragColor.rgb = mix('));

// ===========================================================================
console.log('\n--- 5. the shaders as text -----------------------------------');
// ===========================================================================
{
  const scene = new THREE.Scene();
  // renderer null -> no PMREM; shadows off -> no WebGL needed.
  const sky = createSky(scene, null, { ...SHIPPED, shadows: false });

  ok('sky.js owns scene.fog', !!scene.fog && scene.fog.isFogExp2 === true);
  near('and its density is the documented budget', scene.fog.density, 8.0e-6, 1e-9);
  ok('scene.background is left null (the dome covers every pixel)', scene.background === null);

  const materials = [];
  scene.traverse((o) => { if (o.material) materials.push(o.material); });
  ok('the dome and the cloud slabs exist', materials.length >= 9, `${materials.length} materials`);

  for (const m of materials) {
    if (!m.vertexShader) continue;
    for (const [kind, src] of [['vert', m.vertexShader], ['frag', m.fragmentShader]]) {
      const braces = [...src].reduce((a, c) => a + (c === '{') - (c === '}'), 0);
      const parens = [...src].reduce((a, c) => a + (c === '(') - (c === ')'), 0);
      if (braces !== 0 || parens !== 0) {
        ok(`${m.name} ${kind} is balanced`, false, `braces ${braces}, parens ${parens}`);
      }
    }
    // The file's stated convention: GLSL leaves smoothstep(a, b, x) UNDEFINED
    // for a >= b and most desktop drivers silently do the right thing anyway,
    // which is how that bug ships.
    const bad = [...(m.fragmentShader ?? '').matchAll(
      /smoothstep\(\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*,/g,
    )].filter((mm) => parseFloat(mm[1]) >= parseFloat(mm[2]));
    if (bad.length) {
      ok(`${m.name}: every literal smoothstep is low-edge-first`, false, bad[0][0]);
    }
  }
  ok('every shader string is balanced and every literal smoothstep is low-edge-first', true);

  // Every GLSL constant in this file is emitted from a JS constant through a
  // template literal. A typo in one leaves the placeholder in the shader source,
  // where it is a GLSL syntax error at COMPILE time — on the user's machine, on
  // whichever material happened to include the broken chunk, and nowhere near
  // the line that caused it.
  const leftovers = materials
    .filter((m) => m.vertexShader)
    .flatMap((m) => [`${m.name}.vert`, `${m.name}.frag`]
      .filter((_, i) => /\$\{/.test(i === 0 ? m.vertexShader : m.fragmentShader)));
  ok('no un-interpolated ${...} left in any shader', leftovers.length === 0, leftovers.join(', '));
  for (const name of ['fog_vertex', 'fog_pars_fragment', 'fog_fragment']) {
    ok(`ShaderChunk.${name} interpolated cleanly`, !THREE.ShaderChunk[name].includes('${'));
  }
  // And the numbers really did land.
  const domeFrag = materials.find((m) => m.name === 'SkyAtmosphere').fragmentShader;
  ok('the cloud envelope constants reached the GLSL',
    domeFrag.includes('smoothstep( 0.800, 1.0, hNorm )'),
    domeFrag.match(/float envelope = [^;]*/)?.[0]?.replace(/\s+/g, ' '));

  // Time of day still drives the model end to end.
  const noonSun = (() => { sky.setTimeOfDay(0.5); return sky.sunDirection.y; })();
  const duskSun = (() => { sky.setTimeOfDay(0.79); return sky.sunDirection.y; })();
  const nightSun = (() => { sky.setTimeOfDay(0.98); return sky.sunDirection.y; })();
  ok('noon is the sun at its highest', noonSun > duskSun && duskSun > nightSun,
    `${noonSun.toFixed(3)} > ${duskSun.toFixed(3)} > ${nightSun.toFixed(3)}`);
  // t = 0.738 puts the sun 3 deg above the horizon. NOTE for main.js: its own
  // 'golden hour' (0.76) and 'sunset' (0.795) presets are 2.4 deg and 9.7 deg
  // BELOW it — civil and nautical twilight, not golden hour.
  sky.setTimeOfDay(0.5);
  const noonFog = scene.fog.color.clone();
  const noonSunColor = sky.sunLight.color.clone();
  sky.setTimeOfDay(0.738);
  const duskFog = scene.fog.color.clone();
  const duskSunColor = sky.sunLight.color.clone();
  ok('the fog colour warms as the sun drops',
    duskFog.r / Math.max(duskFog.b, 1e-4) > noonFog.r / Math.max(noonFog.b, 1e-4) + 0.02,
    `r/b ${(noonFog.r / noonFog.b).toFixed(3)} -> ${(duskFog.r / duskFog.b).toFixed(3)}`);
  ok('and so does the sunlight, from the same extinction',
    duskSunColor.b < noonSunColor.b, `blue ${noonSunColor.b.toFixed(3)} -> ${duskSunColor.b.toFixed(3)}`);

  console.log('  -- cloud lighting comes from the SUN ray ----------------------');
  // REGRESSION GUARD. applyLighting used to derive the cloud colour from `_fex`
  // AFTER a dozen evalSky calls had overwritten it with view-ray extinctions.
  // The deck rendered tan at every time of day and nothing failed. The tell is
  // that the lit-cloud colour must track the SUNLIGHT colour, because they are
  // the same transmittance — so compare them, at several sun elevations.
  const slabMat = (sky) => sky.group.children.find((c) => c.name.startsWith('sky-cloud')).material;
  for (const [label, t] of [['high sun', 0.5], ['mid morning', 0.42], ['low sun', 0.738]]) {
    sky.setTimeOfDay(t);
    const lit = slabMat(sky).uniforms.uCloudLit.value;
    const sun = sky.sunLight.color;
    const norm = (c) => { const m = Math.max(c.r, c.g, c.b, 1e-6); return [c.r / m, c.g / m, c.b / m]; };
    const [lr, lg, lb] = norm(lit);
    const [sr, sg, sb] = norm(sun);
    console.log(`       ${label.padEnd(12)} sun ${[sr,sg,sb].map(v=>v.toFixed(3)).join(' ')}  cloudLit ${[lr,lg,lb].map(v=>v.toFixed(3)).join(' ')}`);
    // Lit cloud is the sun's colour pulled toward white, so it must be no more
    // saturated than the sunlight and must have the same hue ORDER (r >= g >= b).
    ok(`${label}: lit cloud is warmer-than-neutral but never more so than the sun`,
      lr >= lg - 1e-6 && lg >= lb - 1e-6 && lb >= sb - 1e-3,
      `cloud blue ${lb.toFixed(3)} vs sun blue ${sb.toFixed(3)}`);
    // Cloud tops are lit by the sun, so their brightness must track the sun
    // light's own intensity — not a second, disagreeing ramp.
    const relLight = sky.sunLight.intensity / 2.6;
    const relCloud = Math.max(lit.r, lit.g, lit.b);
    ok(`${label}: cloud-top brightness tracks the sunlight`,
      Math.abs(relCloud - relLight) < 0.09 && relCloud > 0.3,
      `cloud ${relCloud.toFixed(3)} vs light ${relLight.toFixed(3)}`);
  }
  sky.setTimeOfDay(0.42);

  console.log('  -- the airlight follows the camera, not just the sun ---------');
  // Drive the real per-frame path: three calls this with the live camera
  // immediately before the dome is drawn.
  const dome = sky.group.getObjectByName('sky-dome');
  const cam = new THREE.PerspectiveCamera(60, 1.7, 0.35, 300000);
  const lookFog = (bearingDeg) => {
    cam.position.set(0, 400, 0);
    // §1.2: bearing b -> direction (sin b, 0, -cos b).
    cam.lookAt(Math.sin(bearingDeg * DEG) * 1000, 400, -Math.cos(bearingDeg * DEG) * 1000);
    cam.updateMatrixWorld(true);
    dome.onBeforeRender(null, null, cam);
    return scene.fog.color.clone();
  };
  sky.setTimeOfDay(0.738);           // sun 3 deg up, bearing ~276 deg (west)
  const west = lookFog(276);
  const east = lookFog(96);
  // Absolute red excess, not the r/b RATIO: the anti-solar sky at a low sun is
  // both very dark and red-dominant, so a ratio makes the dark side look like
  // the warm one. What a limb glow is, is red that is actually there.
  const excess = (c) => c.r - c.b;
  console.log(`       west  rgb ${[west.r, west.g, west.b].map((v) => v.toFixed(3)).join(' ')}  red excess ${excess(west).toFixed(3)}`);
  console.log(`       east  rgb ${[east.r, east.g, east.b].map((v) => v.toFixed(3)).join(' ')}  red excess ${excess(east).toFixed(3)}`);
  ok('looking into a low sun gives a warmer airlight than looking away',
    excess(west) > excess(east) + 0.1, `${excess(west).toFixed(3)} vs ${excess(east).toFixed(3)}`);
  ok('and it is brighter, which is what a limb glow is',
    west.r > east.r * 2, `${west.r.toFixed(3)} vs ${east.r.toFixed(3)}`);
  // The airlight must go back to being azimuth-neutral when the sun is high,
  // or a midday turn would visibly repaint the distance.
  sky.setTimeOfDay(0.5);
  const nWest = lookFog(276);
  const nEast = lookFog(96);
  ok('at noon the airlight barely changes with heading',
    Math.abs(nWest.r - nEast.r) < 0.03 && Math.abs(nWest.b - nEast.b) < 0.03,
    `dR ${Math.abs(nWest.r - nEast.r).toFixed(4)}, dB ${Math.abs(nWest.b - nEast.b).toFixed(4)}`);
  sky.setTimeOfDay(0.98);
  ok('the sun is off at night', sky.sunLight.intensity < 0.01, sky.sunLight.intensity.toFixed(4));
  ok('but the fog colour never reaches black', scene.fog.color.b > 0.01);

  sky.setTimeOfDay(0.42);
  ok('update() is allocation-free and does not throw', (() => {
    for (let i = 0; i < 200; i++) sky.update(1 / 60);
    return true;
  })());

  sky.dispose();
  ok('dispose() removes every light this module owns',
    !scene.children.some((c) => c.isLight));
}

console.log(
  failures === 0
    ? '\n\x1b[32mall sky checks passed\x1b[0m\n'
    : `\n\x1b[31m${failures} sky check(s) FAILED\x1b[0m\n`,
);
process.exit(failures === 0 ? 0 : 1);
