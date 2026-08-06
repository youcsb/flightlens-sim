/**
 * landmarkModels.js — procedural geometry for the named landmarks.
 *
 * Consumed by src/geo/landmarks.js, which decides WHERE things go. This file
 * only decides what they look like. Nothing here touches the scene graph, adds
 * a light, or knows about the projection — except `buildDowntownMass`, which
 * needs the ground sampler to sit its blocks on real terrain.
 *
 * ---------------------------------------------------------------------------
 * THE LOCAL FRAME EVERY BUILDER MUST HONOUR
 * ---------------------------------------------------------------------------
 *   +Y up, and y = 0 is the BASE of the structure, not its centre.
 *   +X is the structure's LONG AXIS.
 *   +Z is its short axis.
 *
 * landmarks.js places the returned object at the landmark's local x/z with
 * `position.y = getElevation(lat, lon)` and rotates it about +Y by
 * `(90 - headingDeg)`, which maps local +X onto the true bearing `headingDeg`.
 * Get the base wrong and the landmark is buried or floating; get the axis wrong
 * and Lumen Field sits across the street grid.
 *
 * Dimensions are REAL METRES read off the landmark record — heightM, widthM,
 * lengthM. Nothing is normalised to a unit cube, so a builder that is right at
 * one scale is right at every scale.
 *
 * ---------------------------------------------------------------------------
 * WHY THE DETAIL IS WORTH PAYING FOR
 * ---------------------------------------------------------------------------
 * The reason we are not draping satellite imagery is that draped imagery has no
 * detail left below ~500 ft AGL. That argument only pays off if the geometry
 * keeps giving as you descend. So the Space Needle gets its 24 saucer struts
 * and its real tripod curve rather than three cones: at 12 km it is a correct
 * silhouette, and at 300 m it is still a building.
 *
 * Budget: ~30k triangles for all 24 landmarks plus the city mass, and ~110 draw
 * calls. Repeated small parts — ferris wheel gondolas, bridge hangers, saucer
 * struts, the skyline filler — are InstancedMesh, never loops of Mesh.
 */

import * as THREE from 'three';
import { llToLocal, localToLl } from '../geo/coords.js';
import { getElevation, isWater, isLoaded } from '../geo/elevation.js';

const DEG = Math.PI / 180;

/**
 * Circular arc through a chord, for shallow arched roofs and vaults.
 *
 * Roof arches are NOT semicircles, and treating them as one is a mistake with
 * spectacular consequences: a semicircular truss over Lumen Field's 235 m
 * length stands 117 m tall, nearly three times the stadium's real 43 m and
 * taller than Smith Tower. Given the chord and the rise, this returns the
 * circle that actually fits.
 *
 * @param {number} halfChord half the span, metres
 * @param {number} rise height of the apex above the springing points, metres
 * @returns {{radius:number, halfAngle:number}} halfAngle in radians; the arc
 *   subtends 2*halfAngle and its centre sits `radius` below the apex.
 */
function arcThroughChord(halfChord, rise) {
  const radius = (halfChord * halfChord + rise * rise) / (2 * rise);
  return { radius, halfAngle: Math.asin(Math.min(1, halfChord / radius)) };
}

// ---------------------------------------------------------------------------
// Materials
// ---------------------------------------------------------------------------

/**
 * A window grid drawn into a canvas at runtime. This is procedural, not an art
 * asset — there is no asset pipeline in this project and there is not going to
 * be one.
 *
 * It is applied with `repeat` derived from the building's real metres, so one
 * texel row is one real storey (~3.6 m) whatever the tower's size. That is what
 * keeps a skyscraper legible when you fly past it at 200 m instead of it
 * turning into a flat grey slab — which is precisely the failure mode we are
 * claiming to beat.
 *
 * @returns {THREE.Texture|null} null outside a DOM. Never on the render path.
 */
function makeWindowTexture() {
  if (typeof document === 'undefined') return null;
  const S = 64;
  const c = document.createElement('canvas');
  c.width = S;
  c.height = S;
  const g = c.getContext('2d');
  if (!g) return null;

  // Spandrel (the opaque band between floors) is the base colour; each window
  // is a darker, bluer rectangle inset into it.
  g.fillStyle = '#8e949c';
  g.fillRect(0, 0, S, S);

  const cols = 4;
  const rows = 4;
  const cw = S / cols;
  const rh = S / rows;
  for (let r = 0; r < rows; r++) {
    for (let col = 0; col < cols; col++) {
      // Deterministic per-cell jitter, so glass reads as glass not as a decal.
      const n = ((r * 7 + col * 13) % 5) / 5;
      const v = Math.round(74 + n * 26);
      g.fillStyle = `rgb(${v - 8},${v},${v + 14})`;
      g.fillRect(col * cw + cw * 0.14, r * rh + rh * 0.18, cw * 0.72, rh * 0.5);
    }
  }

  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = 4;
  return tex;
}

/** Built once, cloned per building (repeat lives on the texture, not the material). */
let _windowTex;
function windowTexture() {
  if (_windowTex === undefined) _windowTex = makeWindowTexture();
  return _windowTex;
}

const PALETTE = {
  needleStruct: 0xdcd7cd, // "Astronaut White"
  needleRoof: 0xbe5a34, // the 1962 "Re-entry Red" the roof was restored to
  needleGlass: 0x3f4e59,
  darkGlass: 0x2b3138,
  blueGlass: 0x5d7b8a,
  concrete: 0xb6b1a8,
  paleStone: 0xe4e0d5,
  steel: 0x99a0a6,
  bridgeGrey: 0x7f8a86,
  turf: 0x3f6d3a,
  infield: 0x8a6042,
  domeWood: 0x9c7b52,
  metalBlob: 0xa9736b,
  roofGrey: 0x6c7278,
};

/** Shared material cache. landmarks.js disposes by unique traversal, so
 *  sharing here costs nothing at teardown and saves shader compiles at boot. */
const MAT = {};
function mat(key, make) {
  if (!MAT[key]) MAT[key] = make();
  return MAT[key];
}

const lambert = (color, extra) => new THREE.MeshLambertMaterial({ color, ...extra });
const phong = (color, shininess, extra) =>
  new THREE.MeshPhongMaterial({ color, shininess, ...extra });

const matStruct = () => mat('struct', () => lambert(PALETTE.needleStruct));
const matNeedleRoof = () => mat('needleRoof', () => lambert(PALETTE.needleRoof));
const matNeedleGlass = () =>
  mat('needleGlass', () => phong(PALETTE.needleGlass, 90, { specular: 0x93a2ad }));
const matConcrete = () => mat('concrete', () => lambert(PALETTE.concrete));
const matPaleStone = () => mat('pale', () => lambert(PALETTE.paleStone));
const matSteel = () => mat('steel', () => phong(PALETTE.steel, 40));
const matBridge = () => mat('bridge', () => lambert(PALETTE.bridgeGrey));
const matTurf = () => mat('turf', () => lambert(PALETTE.turf));
const matInfield = () => mat('infield', () => lambert(PALETTE.infield));
const matRoof = () => mat('roofGrey', () => lambert(PALETTE.roofGrey));

/**
 * Glass skin carrying the window texture, with `repeat` set so one texel cell
 * is one real storey and one real structural bay. Each building needs its own
 * material because repeat is a property of the texture.
 */
function glassMaterial(longM, heightM, color = PALETTE.blueGlass) {
  const tex = windowTexture();
  if (!tex) return phong(color, 60, { specular: 0x87a0b0 });
  const t = tex.clone();
  t.needsUpdate = true;
  // 4 cells per tile; ~4.5 m per structural bay, ~3.6 m per storey.
  t.repeat.set(
    Math.max(0.5, longM / 4.5 / 4),
    Math.max(0.5, heightM / 3.6 / 4),
  );
  return phong(color, 60, { map: t, specular: 0x87a0b0 });
}

// ---------------------------------------------------------------------------
// Geometry helpers
// ---------------------------------------------------------------------------

/**
 * Loft a rectangular cross-section along a curve living in the (radial, up)
 * plane. Used for the Space Needle's legs — the one place in this project where
 * a stack of cones would be visibly wrong. The legs are box-section steel that
 * curves inward, and that curve IS the silhouette.
 *
 * Winding is derived rather than guessed. For a straight vertical section the
 * tangent is (0,1), the in-plane normal is (1,0) = outward, and the first quad
 * of the corner order below works out to a +radial face normal. Reorder the
 * corners and every leg turns inside out.
 *
 * @param {{r:number,y:number,halfIn:number,halfTan:number}[]} sections
 *   r/y is the centreline; halfIn is half-thickness within the radial-up plane,
 *   halfTan half-width perpendicular to it.
 * @returns {THREE.BufferGeometry} +X radial, +Y up.
 */
function loftRectTube(sections) {
  const n = sections.length;
  const pos = new Float32Array(n * 4 * 3);
  let p = 0;

  for (let i = 0; i < n; i++) {
    const s = sections[i];
    const a = sections[Math.max(0, i - 1)];
    const b = sections[Math.min(n - 1, i + 1)];
    let tr = b.r - a.r;
    let ty = b.y - a.y;
    const tl = Math.hypot(tr, ty) || 1;
    tr /= tl;
    ty /= tl;
    // Tangent rotated -90 deg in the (r, y) plane -> outward in-plane normal.
    const nr = ty;
    const ny = -tr;

    const corners = [
      [s.r + nr * s.halfIn, s.y + ny * s.halfIn, s.halfTan],
      [s.r + nr * s.halfIn, s.y + ny * s.halfIn, -s.halfTan],
      [s.r - nr * s.halfIn, s.y - ny * s.halfIn, -s.halfTan],
      [s.r - nr * s.halfIn, s.y - ny * s.halfIn, s.halfTan],
    ];
    for (const c of corners) {
      pos[p++] = c[0];
      pos[p++] = c[1];
      pos[p++] = c[2];
    }
  }

  const idx = [];
  for (let i = 0; i < n - 1; i++) {
    for (let k = 0; k < 4; k++) {
      const a = i * 4 + k;
      const b = i * 4 + ((k + 1) % 4);
      const c = (i + 1) * 4 + ((k + 1) % 4);
      const d = (i + 1) * 4 + k;
      idx.push(a, b, c, a, c, d);
    }
  }
  idx.push(0, 2, 1, 0, 3, 2); // bottom cap, facing -tangent
  const t0 = (n - 1) * 4;
  idx.push(t0, t0 + 1, t0 + 2, t0, t0 + 2, t0 + 3); // top cap

  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/**
 * Revolve a 2D profile around +Y, but around an ELLIPSE rather than a circle,
 * so the same function builds a round dome and an oval stadium bowl.
 *
 * @param {{s:number,y:number}[]} profile  `s` scales the ellipse radius.
 * @param {number} a semi-axis along +X (the long axis)
 * @param {number} b semi-axis along +Z
 * @param {number} [seg] angular segments
 */
function revolveEllipse(profile, a, b, seg = 48) {
  const rings = profile.length;
  const pos = new Float32Array(rings * (seg + 1) * 3);
  const uv = new Float32Array(rings * (seg + 1) * 2);
  let p = 0;
  let q = 0;
  for (let i = 0; i < rings; i++) {
    for (let j = 0; j <= seg; j++) {
      const t = (j / seg) * Math.PI * 2;
      pos[p++] = Math.cos(t) * a * profile[i].s;
      pos[p++] = profile[i].y;
      pos[p++] = Math.sin(t) * b * profile[i].s;
      uv[q++] = j / seg;
      uv[q++] = i / (rings - 1);
    }
  }
  const idx = [];
  for (let i = 0; i < rings - 1; i++) {
    for (let j = 0; j < seg; j++) {
      const A = i * (seg + 1) + j;
      const B = A + 1;
      const C = (i + 1) * (seg + 1) + j + 1;
      const D = (i + 1) * (seg + 1) + j;
      idx.push(A, B, C, A, C, D);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/** Mesh at a position, shadows on. */
function m(geo, material, x = 0, y = 0, z = 0) {
  const mesh = new THREE.Mesh(geo, material);
  mesh.position.set(x, y, z);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

/** Box whose BASE sits at `y` — the local frame is defined on bases, not centres. */
function boxOnBase(w, h, d, material, x = 0, y = 0, z = 0) {
  return m(new THREE.BoxGeometry(w, h, d), material, x, y + h / 2, z);
}

/** A cylinder laid along an arbitrary segment — legs, stays, braces. */
function strut(from, to, radius, material, segments = 6) {
  const dir = to.clone().sub(from);
  const s = m(new THREE.CylinderGeometry(radius, radius, dir.length(), segments), material);
  s.position.copy(from).addScaledVector(dir, 0.5);
  s.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.clone().normalize());
  return s;
}

/** Deterministic PRNG, so the skyline is identical on every reload. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------
// THE SPACE NEEDLE — the landmark the user named
// ---------------------------------------------------------------------------

/**
 * Real proportions. Everything below is a fraction of the true 184 m, so a
 * different heightM still gives the right shape, but these are the numbers:
 *
 *   total height       184.4 m  (605 ft)
 *   tripod foot spread  36.6 m  (120 ft across)  -> 18.3 m foot radius
 *   legs merge into the core at roughly 100 m
 *   restaurant level   152.4 m  (500 ft)
 *   observation deck   158.5 m  (520 ft)
 *   top house diameter  42.0 m  (138 ft)         -> 21 m radius
 *   roof              ~167.6 m  (550 ft), then the mast to the top
 *
 * Three features make it identifiable in silhouette, in this order:
 *   1. the inward CURVE of the tripod legs — not straight, not conical;
 *   2. the wide flat saucer sitting well above where the legs merge;
 *   3. the ring of struts flaring out beneath the saucer rim.
 * All three are modelled. Drop any one of them and it reads as a generic mast.
 */
function buildSpaceNeedle(l) {
  const H = l.heightM || 184;
  const k = H / 184; // uniform scale from the reference proportions
  const g = new THREE.Group();

  const FOOT_R = 18.3 * k;
  const MERGE_Y = 100 * k;
  const MERGE_R = 4.6 * k;
  const CORE_TOP = 146 * k;
  const DECK_R = 21 * k;
  const FLARE_R = 8.6 * k;

  // --- the three legs ---------------------------------------------------
  // r(t) eases inward with a squared falloff: wide splay at the ground, nearly
  // vertical by the merge. A linear taper reads as an electricity pylon.
  const STEPS = 18;
  const sections = [];
  for (let i = 0; i <= STEPS; i++) {
    const t = i / STEPS;
    sections.push({
      r: MERGE_R + (FOOT_R - MERGE_R) * (1 - t) ** 2,
      y: MERGE_Y * t ** 0.94,
      halfIn: (2.6 - 1.5 * t) * k, // box-section steel, thicker at the foot
      halfTan: (3.1 - 1.9 * t) * k,
    });
  }
  const legGeo = loftRectTube(sections);
  for (let i = 0; i < 3; i++) {
    const leg = m(legGeo, matStruct());
    leg.rotation.y = (i * 120 + 90) * DEG;
    g.add(leg);
  }

  // --- the core above the merge: still visibly three columns -------------
  const colH = CORE_TOP - MERGE_Y * 0.5;
  const colGeo = new THREE.CylinderGeometry(1.5 * k, 2.4 * k, colH, 8);
  for (let i = 0; i < 3; i++) {
    const a = (i * 120 + 90) * DEG;
    const r = MERGE_R * 0.72;
    g.add(m(colGeo, matStruct(), Math.cos(a) * r, MERGE_Y * 0.5 + colH / 2, Math.sin(a) * r));
  }
  // Elevator shaft up the middle, visible between the legs from close in.
  g.add(m(new THREE.CylinderGeometry(2.1 * k, 2.4 * k, CORE_TOP, 12), matStruct(), 0, CORE_TOP / 2, 0));

  // --- the flare, and the 24 struts under the saucer ---------------------
  g.add(
    m(new THREE.CylinderGeometry(FLARE_R, 3.2 * k, 12 * k, 24, 1, true), matStruct(), 0, 142 * k, 0),
  );

  const STRUTS = 24;
  const rise = 6.6 * k;
  const run = DECK_R - FLARE_R;
  const strutGeo = new THREE.CylinderGeometry(0.42 * k, 0.42 * k, Math.hypot(run, rise), 5);
  const strutMesh = new THREE.InstancedMesh(strutGeo, matStruct(), STRUTS);
  const t3 = new THREE.Object3D();
  const up = new THREE.Vector3(0, 1, 0);
  const dir = new THREE.Vector3();
  for (let i = 0; i < STRUTS; i++) {
    const a = (i / STRUTS) * Math.PI * 2;
    const rMid = (FLARE_R + DECK_R) / 2;
    t3.position.set(Math.cos(a) * rMid, 148.7 * k, Math.sin(a) * rMid);
    // Point each strut outward-and-up from the flare to the saucer rim.
    dir.set(Math.cos(a) * run, rise, Math.sin(a) * run).normalize();
    t3.quaternion.setFromUnitVectors(up, dir);
    t3.scale.set(1, 1, 1);
    t3.updateMatrix();
    strutMesh.setMatrixAt(i, t3.matrix);
  }
  strutMesh.castShadow = true;
  g.add(strutMesh);

  // --- the top house ----------------------------------------------------
  g.add(m(new THREE.CylinderGeometry(DECK_R, FLARE_R, 7.4 * k, 32), matStruct(), 0, 148.7 * k, 0));
  g.add(m(new THREE.CylinderGeometry(DECK_R, DECK_R, 1.1 * k, 32), matStruct(), 0, 152.9 * k, 0));
  // Restaurant + observation deck glazing.
  g.add(
    m(
      new THREE.CylinderGeometry(DECK_R * 0.94, DECK_R * 0.98, 5.6 * k, 32),
      matNeedleGlass(),
      0,
      156.3 * k,
      0,
    ),
  );
  // The deck rim — the wide flat brim that is what you actually see at 12 km.
  g.add(m(new THREE.CylinderGeometry(DECK_R, DECK_R, 1.4 * k, 32), matStruct(), 0, 159.8 * k, 0));
  g.add(
    m(new THREE.CylinderGeometry(DECK_R * 0.62, DECK_R, 7.4 * k, 32), matNeedleRoof(), 0, 164.2 * k, 0),
  );
  g.add(
    m(new THREE.CylinderGeometry(5.2 * k, DECK_R * 0.62, 4.4 * k, 24), matNeedleRoof(), 0, 170.1 * k, 0),
  );

  // --- the mast ---------------------------------------------------------
  // The stack above lands the roof cap at 172.3 m; the mast then runs to the
  // true 184 m tip and STOPS THERE. The beacon is the topmost point of the
  // whole model, so its radius has to be inside the budget, not on top of it.
  g.add(m(new THREE.CylinderGeometry(0.55 * k, 1.7 * k, 8.7 * k, 10), matStruct(), 0, 176.65 * k, 0));
  g.add(m(new THREE.CylinderGeometry(0.18 * k, 0.55 * k, 2.4 * k, 8), matStruct(), 0, 182.2 * k, 0));
  g.add(
    m(
      new THREE.SphereGeometry(0.5 * k, 8, 6),
      mat('beacon', () => lambert(0xd83a2a, { emissive: 0x8a1c10 })),
      0,
      183.5 * k,
      0,
    ),
  );

  // --- the base pavilion ------------------------------------------------
  g.add(m(new THREE.CylinderGeometry(FOOT_R * 1.15, FOOT_R * 1.15, 7 * k, 6), matConcrete(), 0, 3.5 * k, 0));

  return g;
}

// ---------------------------------------------------------------------------
// Downtown Seattle towers
// ---------------------------------------------------------------------------

/**
 * Columbia Center — three curved lobes stepping down, in near-black glass.
 * At 294.8 m it is Seattle's tallest, 60% taller than the Needle, and the
 * skyline is wrong unless it dominates.
 */
function buildColumbiaCenter(l) {
  const H = l.heightM || 294.8;
  const W = l.widthM || 50;
  const g = new THREE.Group();
  const glass = glassMaterial(W, H, PALETTE.darkGlass);
  const lobes = [
    { h: H * 0.965, r: W * 0.36, x: 0, z: 0 },
    { h: H * 0.79, r: W * 0.3, x: W * 0.42, z: W * 0.16 },
    { h: H * 0.6, r: W * 0.27, x: -W * 0.36, z: -W * 0.22 },
  ];
  for (const lo of lobes) {
    g.add(m(new THREE.CylinderGeometry(lo.r, lo.r, lo.h, 20), glass, lo.x, lo.h / 2, lo.z));
  }
  // The crown mast takes it from roof height (284.4) to architectural (294.8) —
  // and no further. heightM IS the architectural top, so the mast ends at H.
  g.add(m(new THREE.CylinderGeometry(0.4, 1.2, H * 0.035, 6), matSteel(), 0, H * 0.9825, 0));
  return g;
}

/** Smith Tower — wide base, slim shaft, and the white pyramid everyone knows. */
function buildSmithTower(l) {
  const H = l.heightM || 159;
  const W = l.widthM || 30;
  const g = new THREE.Group();
  const skin = glassMaterial(W, H, PALETTE.paleStone);
  g.add(boxOnBase(W, H * 0.22, W * 0.95, skin));
  g.add(boxOnBase(W * 0.58, H * 0.55, W * 0.58, skin, 0, H * 0.22));
  g.add(boxOnBase(W * 0.46, H * 0.1, W * 0.46, matPaleStone(), 0, H * 0.77));
  // Four-sided, which is why radialSegments is 4 — this pyramid is the building.
  // Wikidata's 159 m already includes the flagpole, so the pole tops out at H.
  const pyr = m(new THREE.ConeGeometry(W * 0.33, H * 0.12, 4), matPaleStone(), 0, H * 0.93, 0);
  pyr.rotation.y = Math.PI / 4;
  g.add(pyr);
  g.add(m(new THREE.CylinderGeometry(0.2, 0.35, H * 0.01, 6), matSteel(), 0, H * 0.995, 0));
  return g;
}

/** Rainier Tower — the tower stands on an 11-storey inverted concrete pedestal. */
function buildRainierTower(l) {
  const H = l.heightM || 156;
  const W = l.widthM || 38;
  const g = new THREE.Group();
  const pedH = H * 0.24;
  // Wide end UP. That pedestal is the entire reason anyone photographs it.
  g.add(m(new THREE.CylinderGeometry(W * 0.5, W * 0.16, pedH, 20), matConcrete(), 0, pedH / 2, 0));
  g.add(boxOnBase(W, H - pedH, W * 0.72, glassMaterial(W, H - pedH, PALETTE.paleStone), 0, pedH));
  return g;
}

/**
 * The default building: podium, shaft, small crown. Deliberately plain — these
 * exist so the named towers have neighbours of the right height, and anything
 * fancier costs draw calls for no silhouette gain.
 */
function buildGenericTower(l) {
  const H = l.heightM;
  const W = l.widthM ?? Math.max(18, H * 0.22);
  const L = l.lengthM ?? W;
  const g = new THREE.Group();
  const glass = glassMaterial(Math.max(L, W), H, H > 90 ? PALETTE.blueGlass : PALETTE.concrete);

  if (H > 60) {
    // Bands stack to exactly H: podium 0-9%, shaft 9-94%, crown 94-100%.
    const podium = H * 0.09;
    g.add(boxOnBase(L * 1.12, podium, W * 1.12, matConcrete()));
    g.add(boxOnBase(L, H * 0.94 - podium, W, glass, 0, podium));
    g.add(boxOnBase(L * 0.72, H * 0.06, W * 0.72, matRoof(), 0, H * 0.94));
  } else {
    g.add(boxOnBase(L, H * 0.9, W, glass));
    g.add(boxOnBase(L * 0.99, H * 0.1, W * 0.99, matRoof(), 0, H * 0.9));
  }
  return g;
}

/** Museum of Pop Culture — overlapping crumpled metal blobs in four colours. */
function buildMopop(l) {
  const H = l.heightM || 25;
  const L = l.lengthM || 105;
  const W = l.widthM || 85;
  const g = new THREE.Group();
  const lobes = [
    { s: 1.0, x: 0, z: 0, c: PALETTE.metalBlob },
    { s: 0.72, x: -L * 0.3, z: W * 0.2, c: 0x8f8fa2 },
    { s: 0.66, x: L * 0.3, z: -W * 0.18, c: 0xc0a04a },
    { s: 0.55, x: L * 0.12, z: W * 0.3, c: 0x6a7f8e },
  ];
  for (const lo of lobes) {
    // A sphere squashed to a third of its width is MoPOP's swoop. The centre
    // sits ON the ground, so each lobe's lower half is below grade and its
    // flanks meet the terrain tangentially — which is what the real building
    // does. The tallest lobe therefore peaks at exactly H.
    const geo = new THREE.SphereGeometry(1, 18, 12);
    geo.scale(L * 0.34 * lo.s, H * lo.s, W * 0.42 * lo.s);
    g.add(m(geo, phong(lo.c, 70, { specular: 0xb9c2c8 }), lo.x, 0, lo.z));
  }
  return g;
}

/**
 * Amazon Spheres — three faceted glass domes, the largest 40 m across and 27 m
 * tall. Those two numbers are inconsistent for a whole sphere, and deliberately
 * so: the real domes are spheres TRUNCATED below the equator. So each is built
 * at its true radius with its centre sunk to `radius - height`, which puts the
 * apex at exactly heightM and leaves the terrain to cut the bottom off.
 */
function buildSpheres(l) {
  const D = l.widthM || 40;
  const H = l.heightM || 27;
  const R0 = D * 0.5;
  const g = new THREE.Group();
  const glass = mat('sphereGlass', () =>
    new THREE.MeshPhongMaterial({
      color: 0x9fc4a8,
      shininess: 120,
      specular: 0xffffff,
      transparent: true,
      opacity: 0.55,
      side: THREE.DoubleSide,
    }),
  );
  const lineMat = mat('sphereLine', () => new THREE.LineBasicMaterial({ color: 0x39443d }));

  for (const s of [
    { r: R0, x: 0, z: 0 },
    { r: R0 * 0.8, x: -D * 0.72, z: D * 0.12 },
    { r: R0 * 0.66, x: D * 0.66, z: -D * 0.1 },
  ]) {
    // Apex height scales with the dome, so all three keep the same proportions.
    // centre = apex - radius, which is NEGATIVE for the truncated ones.
    const cy = H * (s.r / R0) - s.r;
    // Icosahedron detail 1 gives the pentagon-ish framing of the real structure.
    const geo = new THREE.IcosahedronGeometry(s.r, 1);
    g.add(m(geo, glass, s.x, cy, s.z));
    const edges = new THREE.LineSegments(new THREE.EdgesGeometry(geo, 1), lineMat);
    edges.position.set(s.x, cy, s.z);
    g.add(edges);
  }
  return g;
}

// ---------------------------------------------------------------------------
// Stadiums and arenas
// ---------------------------------------------------------------------------

/**
 * An elliptical stadium bowl: field, raked seating, outer wall, roof.
 *
 * The profile is a closed loop — up the inside of the seating, over the rim,
 * back down the outside — so one revolve produces the whole shell with no seam
 * and no separate wall mesh. DoubleSide because you see both faces: the outside
 * from the air, the inside when you fly over the open top.
 *
 * The roofs differ, and the difference is visible from the air:
 *   Lumen Field   two great arched trusses running the LENGTH of the stadium,
 *                 one over each sideline.
 *   T-Mobile Park a retractable roof of panels whose arches span the SHORT
 *                 axis, rolling on rails along the long axis.
 */
function buildStadiumBowl(l) {
  const H = l.heightM || 45;
  const A = (l.lengthM || 230) / 2;
  const B = (l.widthM || 190) / 2;
  const g = new THREE.Group();

  const bowlH = H * (l.roof ? 0.6 : 0.76);
  const profile = [
    { s: 0.52, y: 0 },
    { s: 0.54, y: bowlH * 0.06 },
    { s: 0.78, y: bowlH * 0.5 },
    { s: 0.97, y: bowlH * 0.95 },
    { s: 1.0, y: bowlH },
    { s: 1.0, y: bowlH * 0.1 },
    { s: 0.98, y: 0 },
  ];
  g.add(
    m(
      revolveEllipse(profile, A, B, 56),
      mat('bowl', () => lambert(0xa8a49b, { side: THREE.DoubleSide })),
    ),
  );

  // Playing surface, just under the lowest row.
  const fieldGeo = new THREE.CircleGeometry(1, 40);
  fieldGeo.scale(A * 0.5, B * 0.5, 1);
  const field = m(fieldGeo, matTurf(), 0, 0.4, 0);
  field.rotation.x = -Math.PI / 2;
  g.add(field);
  if (l.roof) {
    // Baseball: the infield dirt reads clearly from above and says "not soccer".
    const dirt = m(new THREE.CircleGeometry(A * 0.2, 24), matInfield(), -A * 0.16, 0.5, 0);
    dirt.rotation.x = -Math.PI / 2;
    g.add(dirt);
  }

  const ribR = Math.max(0.8, H * 0.03);
  // The arch is a SHALLOW segment, not a semicircle. See arcThroughChord: a
  // semicircular truss over this span would stand taller than Smith Tower.
  //
  // The rise is measured to the truss's OUTER surface, not its centreline, so
  // the tube radius comes off the top before the arc is fitted and the circle
  // centre drops by the same amount. heightM is the top of the structure — the
  // file's whole contract with landmarks.js — and a torus centred on H stands
  // ribR proud of it, which is 1.8 m at Lumen Field.
  if (l.roof) {
    // Retractable roof: arches span the SHORT axis, panels roll along the long
    // one. Chord is the stadium's width.
    const rise = Math.max(1, H - bowlH - ribR);
    const { radius: R, halfAngle: th } = arcThroughChord(B * 1.02, rise);
    const yc = H - ribR - R; // so the rib's outer surface lands on heightM

    // Torus lies in XY; rotate the geometry so the arc is centred on +Y, then
    // rotate the OBJECT about Y to swing the arch onto the short axis. Baking
    // the first rotation into the geometry keeps the two out of Euler order.
    const ribGeo = new THREE.TorusGeometry(R, ribR, 6, 24, th * 2);
    ribGeo.rotateZ(Math.PI / 2 - th);

    // Panel: an open half-cylinder. CylinderGeometry puts theta = PI/2 at +X,
    // and rotating +90 deg about Z maps +X to +Y and the axis onto X. So an arc
    // centred on PI/2 becomes an arch over the top, spanning Z and extruded
    // along X — already the orientation we want. Unlike the rib, the panel
    // therefore takes NO further rotation; adding one swaps its span and its
    // length and the roof grows to 350 m across.
    const panelGeo = new THREE.CylinderGeometry(
      R, R, A * 0.62, 24, 1, true, Math.PI / 2 - th, th * 2,
    );
    panelGeo.rotateZ(Math.PI / 2);
    const skinMat = mat('roofSkin', () => lambert(0x8d949a, { side: THREE.DoubleSide }));

    for (let i = 0; i < 3; i++) {
      const x = (i - 1) * A * 0.62;
      const rib = m(ribGeo, matSteel(), x, yc, 0);
      rib.rotation.y = Math.PI / 2;
      g.add(rib);
      g.add(m(panelGeo, skinMat, x, yc, 0));
    }
  } else {
    // Two great trusses running the LENGTH of the stadium, one over each
    // sideline. Chord is the stadium's length.
    const archR = ribR * 1.4;
    const rise = Math.max(1, H - bowlH - archR);
    const { radius: R, halfAngle: th } = arcThroughChord(A * 1.02, rise);
    const yc = H - archR - R;
    const archGeo = new THREE.TorusGeometry(R, archR, 6, 32, th * 2);
    archGeo.rotateZ(Math.PI / 2 - th);
    for (const sz of [-1, 1]) {
      g.add(m(archGeo, matSteel(), 0, yc, sz * B * 0.86));
    }
    // Canopies hung inboard from each truss, over the seating.
    const canopy = new THREE.PlaneGeometry(A * 1.85, B * 0.44);
    const canopyMat = mat('canopy', () => lambert(0x9aa0a4, { side: THREE.DoubleSide }));
    for (const sz of [-1, 1]) {
      const c = m(canopy, canopyMat, 0, bowlH * 1.02, sz * B * 0.66);
      c.rotation.x = -Math.PI / 2 + sz * 0.12;
      g.add(c);
    }
  }
  return g;
}

/**
 * Climate Pledge Arena. The 1962 hyperbolic-paraboloid roof IS the silhouette —
 * it is a landmarked structure precisely because of that roof, so a flat box
 * would be unrecognisable. y = base + k(u^2 - v^2) over a square grid.
 */
function buildArena(l) {
  const H = l.heightM || 34;
  const W = l.widthM || 130;
  const g = new THREE.Group();

  g.add(boxOnBase(W * 0.9, H * 0.34, W * 0.9, matConcrete()));

  // u and v run -1..+1 across the roof, so the saddle spans mid +/- k/2. With
  // mid = 0.55H and k = 0.9H the high corners land at exactly H and the low
  // ones at 0.1H — the roof's full sweep, and nothing pokes above heightM.
  const N = 20;
  const roof = new THREE.PlaneGeometry(W, W, N, N);
  roof.rotateX(-Math.PI / 2);
  const pos = roof.attributes.position;
  const k = H * 0.9;
  for (let i = 0; i < pos.count; i++) {
    const u = (pos.getX(i) / W) * 2;
    const v = (pos.getZ(i) / W) * 2;
    pos.setY(i, H * 0.55 + k * (u * u - v * v) * 0.5);
  }
  pos.needsUpdate = true;
  roof.computeVertexNormals();
  g.add(m(roof, mat('hpRoof', () => lambert(0xd6d3cb, { side: THREE.DoubleSide }))));

  // Buttresses under the two high corners the roof lifts to.
  for (const sx of [-1, 1]) {
    g.add(m(new THREE.BoxGeometry(W * 0.1, H * 0.62, W * 0.1), matConcrete(), sx * W * 0.46, H * 0.31, 0));
  }
  return g;
}

/** Tacoma Dome — a 161 m timber dome on a low ring wall. */
function buildDome(l) {
  const H = l.heightM || 46;
  const R = (l.widthM || 161) / 2;
  const g = new THREE.Group();
  const wallH = H * 0.28;
  const domeH = H - wallH;

  g.add(m(new THREE.CylinderGeometry(R, R, wallH, 40, 1, true), matConcrete(), 0, wallH / 2, 0));

  const N = 12;
  const profile = [];
  for (let i = 0; i <= N; i++) {
    const u = (i / N) * (Math.PI / 2);
    profile.push({ s: Math.cos(u), y: wallH + domeH * Math.sin(u) });
  }
  g.add(
    m(
      revolveEllipse(profile, R, R, 40),
      mat('dome', () => lambert(PALETTE.domeWood, { side: THREE.DoubleSide })),
    ),
  );
  return g;
}

// ---------------------------------------------------------------------------
// Bridges
// ---------------------------------------------------------------------------

/**
 * A suspension bridge, dimensioned for the Tacoma Narrows: 853 m main span,
 * towers 154 m above the water, deck at about 57 m.
 *
 * The landmark sits mid-channel, so its DEM elevation is 0 — y = 0 here is the
 * WATERLINE and every height is above it. The main cable is a real catenary
 * (cosh), not a parabola: at a 1:10 sag ratio the two differ by several metres
 * at the quarter points, and the cable is silhouetted against open sky where
 * that shows.
 */
function buildSuspensionBridge(l) {
  const TOWER_H = l.heightM || 154;
  const SPAN = l.lengthM || 853;
  const DECK_W = l.widthM || 18;
  const DECK_Y = TOWER_H * 0.37;
  const g = new THREE.Group();

  const legOffset = DECK_W * 0.62;
  const towerX = [-SPAN / 2, SPAN / 2];

  for (const tx of towerX) {
    for (const sz of [-1, 1]) {
      g.add(
        m(
          new THREE.BoxGeometry(TOWER_H * 0.05, TOWER_H, TOWER_H * 0.045),
          matBridge(),
          tx,
          TOWER_H / 2,
          sz * legOffset,
        ),
      );
    }
    for (const fy of [0.5, 0.78, 0.98]) {
      g.add(
        m(
          new THREE.BoxGeometry(TOWER_H * 0.04, TOWER_H * 0.035, legOffset * 2),
          matBridge(),
          tx,
          TOWER_H * fy,
          0,
        ),
      );
    }
  }

  // Catenary. At midspan the cable hangs `sag` below the tower tops; at the
  // towers it reaches them exactly. cosh grows from 1 at x=0, so normalising by
  // its value at the tower gives 0 at midspan and 1 at each tower.
  const sag = SPAN * 0.1;
  const c = SPAN * 0.42; // cosh scale; tuned so the curve is taut, not floppy
  const denom = Math.cosh(SPAN / 2 / c) - 1;
  // The cable's CENTRELINE stops one radius below the tower top, so the top of
  // the tube — the highest thing on the bridge — lands on heightM rather than
  // 1.7 m above it. heightM is the tower height above the water.
  const cableR = Math.max(0.5, TOWER_H * 0.011);
  const cableTop = TOWER_H - cableR;
  const cableAt = (x) => cableTop - sag * (1 - (Math.cosh(x / c) - 1) / denom);

  const STEPS = 40;
  const pts = [];
  for (let i = 0; i <= STEPS; i++) {
    const x = -SPAN / 2 + (SPAN * i) / STEPS;
    pts.push(new THREE.Vector3(x, cableAt(x), 0));
  }
  const cableGeo = new THREE.TubeGeometry(
    new THREE.CatmullRomCurve3(pts),
    48,
    cableR,
    6,
    false,
  );

  for (const sz of [-1, 1]) {
    g.add(m(cableGeo, matBridge(), 0, 0, sz * legOffset));
    // Backstays down to the anchorages beyond each tower.
    for (const sx of [-1, 1]) {
      g.add(
        strut(
          new THREE.Vector3(sx * (SPAN / 2), cableTop, sz * legOffset),
          new THREE.Vector3(sx * (SPAN / 2 + SPAN * 0.28), DECK_Y * 0.5, sz * legOffset),
          TOWER_H * 0.01,
          matBridge(),
        ),
      );
    }
  }

  // 2 x 30 hangers: instanced, or this landmark alone costs 60 draw calls.
  const NH = 30;
  const hangers = new THREE.InstancedMesh(
    new THREE.CylinderGeometry(0.22, 0.22, 1, 4),
    matBridge(),
    NH * 2,
  );
  const t3 = new THREE.Object3D();
  let n = 0;
  for (let i = 1; i <= NH; i++) {
    const x = -SPAN / 2 + (SPAN * i) / (NH + 1);
    const h = Math.max(1, cableAt(x) - DECK_Y);
    for (const sz of [-1, 1]) {
      t3.position.set(x, DECK_Y + h / 2, sz * legOffset);
      t3.rotation.set(0, 0, 0);
      t3.scale.set(1, h, 1);
      t3.updateMatrix();
      hangers.setMatrixAt(n++, t3.matrix);
    }
  }
  g.add(hangers);

  // Deck and stiffening girder, running well past the towers to the approaches.
  const deckLen = SPAN * 1.62;
  g.add(m(new THREE.BoxGeometry(deckLen, 1.2, DECK_W), matBridge(), 0, DECK_Y, 0));
  g.add(m(new THREE.BoxGeometry(deckLen, 3.4, DECK_W * 0.86), matBridge(), 0, DECK_Y - 2.2, 0));
  return g;
}

/**
 * West Seattle Bridge — a concrete box girder on tapered piers.
 *
 * heightM is the deck height above the water, so the ROAD SURFACE goes at H and
 * the slab hangs below it. Centring the slab on H instead puts the bridge
 * 1.8 m over its published clearance.
 */
function buildGirderBridge(l) {
  const H = l.heightM || 42;
  const L = l.lengthM || 460;
  const W = l.widthM || 24;
  const SLAB = 3.6;
  const g = new THREE.Group();
  g.add(m(new THREE.BoxGeometry(L, SLAB, W), matConcrete(), 0, H - SLAB / 2, 0));
  g.add(m(new THREE.BoxGeometry(L * 0.42, 5.5, W * 0.7), matConcrete(), 0, H - SLAB - 2.4, 0));
  for (const sx of [-1, 1]) {
    g.add(
      m(
        new THREE.CylinderGeometry(W * 0.16, W * 0.22, H - SLAB, 10),
        matConcrete(),
        sx * L * 0.21,
        (H - SLAB) / 2,
        0,
      ),
    );
  }
  return g;
}

// ---------------------------------------------------------------------------
// The rest
// ---------------------------------------------------------------------------

/** Seattle Great Wheel — 53.3 m (175 ft), 42 gondolas, out on Pier 57. */
function buildFerrisWheel(l) {
  const H = l.heightM || 53.3;
  const R = H * 0.44;
  const GONDOLA = R * 0.1;
  // The topmost thing on the wheel is the gondola riding over the crown, not
  // the rim, so the hub drops by half a gondola. heightM is the top of the
  // structure; hubY = H - R would put the wheel 1.2 m over its published 53.3.
  const hubY = H - R - GONDOLA / 2;
  const g = new THREE.Group();

  const rimGeo = new THREE.TorusGeometry(R, R * 0.022, 6, 48);
  for (const sz of [-1, 1]) g.add(m(rimGeo, matSteel(), 0, hubY, sz * R * 0.14));

  const hub = m(new THREE.CylinderGeometry(R * 0.07, R * 0.07, R * 0.34, 10), matSteel(), 0, hubY, 0);
  hub.rotation.x = Math.PI / 2;
  g.add(hub);

  const t3 = new THREE.Object3D();

  const SPOKES = 32;
  const spokes = new THREE.InstancedMesh(
    new THREE.CylinderGeometry(R * 0.012, R * 0.012, R, 4),
    matSteel(),
    SPOKES,
  );
  for (let i = 0; i < SPOKES; i++) {
    const a = (i / SPOKES) * Math.PI * 2;
    t3.position.set((Math.cos(a) * R) / 2, hubY + (Math.sin(a) * R) / 2, 0);
    t3.rotation.set(0, 0, a - Math.PI / 2);
    t3.scale.set(1, 1, 1);
    t3.updateMatrix();
    spokes.setMatrixAt(i, t3.matrix);
  }
  g.add(spokes);

  const NG = 42;
  const gondolas = new THREE.InstancedMesh(
    new THREE.BoxGeometry(GONDOLA, GONDOLA, R * 0.11),
    mat('gondola', () => phong(0x2f5a86, 60)),
    NG,
  );
  for (let i = 0; i < NG; i++) {
    const a = (i / NG) * Math.PI * 2;
    t3.position.set(Math.cos(a) * R, hubY + Math.sin(a) * R, 0);
    t3.rotation.set(0, 0, 0);
    t3.scale.set(1, 1, 1);
    t3.updateMatrix();
    gondolas.setMatrixAt(i, t3.matrix);
  }
  g.add(gondolas);

  // A-frame legs straddling the hub.
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      g.add(
        strut(
          new THREE.Vector3(0, hubY, 0),
          new THREE.Vector3(sx * R * 0.42, 0, sz * R * 0.5),
          R * 0.04,
          matSteel(),
        ),
      );
    }
  }
  return g;
}

/** Boeing Everett Factory — 500 x 330 m, 34 m tall; largest building on Earth. */
function buildFactory(l) {
  const H = l.heightM || 34;
  const L = l.lengthM || 500;
  const W = l.widthM || 330;
  const g = new THREE.Group();

  const wallH = H * 0.78;
  g.add(boxOnBase(L, wallH, W, mat('factoryWall', () => lambert(0xc3c6c4))));

  // Barrel-vaulted bays across the short axis — that is the real roof line.
  // Shallow segments again: a semicircular vault on a 55 m bay would add 27 m
  // to a 34 m building.
  const BAYS = 6;
  const bayW = W / BAYS;
  const { radius: R, halfAngle: th } = arcThroughChord(bayW / 2, H - wallH);
  const vault = new THREE.CylinderGeometry(
    R, R, L, 14, 1, true, Math.PI / 2 - th, th * 2,
  );
  // +90 deg about Z lays the axis along X and turns the arc upward.
  vault.rotateZ(Math.PI / 2);
  for (let i = 0; i < BAYS; i++) {
    g.add(m(vault, matRoof(), 0, H - R, (i - (BAYS - 1) / 2) * bayW));
  }

  // The famous doors along one long face.
  const doorMat = mat('factoryDoor', () => lambert(0x7f9bb5));
  for (let i = 0; i < 4; i++) {
    g.add(m(new THREE.BoxGeometry(L * 0.19, H * 0.6, 1.5), doorMat, (i - 1.5) * L * 0.23, H * 0.3, W / 2 + 0.8));
  }
  return g;
}

/** Alki Point Light — small, but it is the turn into Elliott Bay. */
function buildLighthouse(l) {
  const H = l.heightM || 11;
  const W = l.widthM || 6;
  const g = new THREE.Group();
  // Bands stack to exactly H: tower 0-72%, gallery 72-77%, lantern 77-89%,
  // roof cone 89-100%. P2048 measures to the top of that cone.
  g.add(boxOnBase(W * 2.4, H * 0.42, W * 1.6, matPaleStone(), 0, 0, W * 1.3));
  g.add(m(new THREE.CylinderGeometry(W * 0.28, W * 0.34, H * 0.72, 14), matPaleStone(), 0, H * 0.36, 0));
  g.add(m(new THREE.CylinderGeometry(W * 0.36, W * 0.36, H * 0.05, 14), matRoof(), 0, H * 0.745, 0));
  g.add(
    m(
      new THREE.CylinderGeometry(W * 0.24, W * 0.24, H * 0.12, 10),
      mat('lantern', () => lambert(0xf3e6b0, { emissive: 0x6a5c22 })),
      0,
      H * 0.83,
      0,
    ),
  );
  g.add(m(new THREE.ConeGeometry(W * 0.3, H * 0.11, 10), matRoof(), 0, H * 0.945, 0));
  return g;
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

/**
 * Anything shorter than this is invisible from an aircraft and not worth a draw
 * call. Those landmarks still exist as DATA — nearestLandmark() will happily
 * report that you are over the Fremont Troll — they just get no mesh.
 */
export const MIN_VISIBLE_HEIGHT_M = 8;

/** model key -> builder. Exported so a check script can enumerate coverage. */
export const MODEL_BUILDERS = {
  spaceNeedle: buildSpaceNeedle,
  columbiaCenter: buildColumbiaCenter,
  smithTower: buildSmithTower,
  rainierTower: buildRainierTower,
  mopop: buildMopop,
  spheres: buildSpheres,
  stadiumBowl: buildStadiumBowl,
  arena: buildArena,
  dome: buildDome,
  suspensionBridge: buildSuspensionBridge,
  girderBridge: buildGirderBridge,
  ferrisWheel: buildFerrisWheel,
  factory: buildFactory,
  lighthouse: buildLighthouse,
  tower: buildGenericTower,
};

/**
 * Build the mesh for one landmark: base at local y = 0, long axis along +X.
 *
 * @param {object} l A Landmark record from src/geo/landmarks.js.
 * @returns {THREE.Object3D|null} null when the landmark is label-only — peaks
 *   (the DEM already drew them) and anything under MIN_VISIBLE_HEIGHT_M.
 */
export function buildLandmarkModel(l) {
  if (!l || l.kind === 'peak') return null;
  const h = Number(l.heightM);
  if (!Number.isFinite(h) || h < MIN_VISIBLE_HEIGHT_M) return null;

  const builder = MODEL_BUILDERS[l.model];
  if (builder) return builder(l);

  // No explicit model: fall back on kind, then on a plain building.
  if (l.kind === 'stadium') return buildStadiumBowl(l);
  if (l.kind === 'bridge') return buildGirderBridge(l);
  return buildGenericTower(l);
}

// ---------------------------------------------------------------------------
// The downtown building mass
// ---------------------------------------------------------------------------

/**
 * Instanced filler blocks, so the skyline has a city underneath it.
 *
 * These are NOT geographic truth and do not pretend to be — which is exactly
 * why they live here and not in the baked landmark data. The named towers are
 * surveyed and sit at their true coordinates; this is the anonymous mass
 * between them, generated from a height falloff around each core.
 *
 * Three things make it read as Seattle rather than as noise:
 *
 *  - The GRID ANGLE is real. Downtown's core grid runs about 30 deg off north,
 *    parallel to the Elliott Bay shoreline, while everything north of Denny Way
 *    — Seattle Center, where the Needle is — sits on a true N-S grid. The seam
 *    between the two is obvious from the air, and getting it wrong is the
 *    single most visible way to make a real city look fake.
 *  - Blocks are Seattle blocks: ~73 m square on a ~91 m pitch.
 *  - Heights fall off exponentially from each core, so downtown has a peak and
 *    a skirt instead of being a uniform slab.
 *
 * Water and ground come from the DEM, so blocks neither march into Elliott Bay
 * nor float above the hill they are standing on.
 */
const CLUSTERS = [
  // Downtown core: tallest, on the 30 deg shoreline grid.
  { lat: 47.606, lon: -122.332, halfLenM: 1100, halfWidM: 760, gridDeg: 30, maxH: 175, falloffM: 700 },
  // Denny Triangle / South Lake Union — real, and mostly built since 2010.
  { lat: 47.6175, lon: -122.337, halfLenM: 850, halfWidM: 620, gridDeg: 30, maxH: 135, falloffM: 620 },
  // Lower Queen Anne / Seattle Center: low-rise, and on the N-S grid.
  { lat: 47.6235, lon: -122.352, halfLenM: 700, halfWidM: 560, gridDeg: 0, maxH: 40, falloffM: 620 },
  // Bellevue across Lake Washington — a genuinely separate skyline, and the
  // proof that the lake between them is the right shape.
  { lat: 47.6145, lon: -122.1985, halfLenM: 650, halfWidM: 520, gridDeg: 0, maxH: 150, falloffM: 460 },
];

/**
 * Height falloff from a cluster centre, normalised to 1 at the core.
 *
 * A Gaussian-ish `exp(-(d/f)^1.5)` was tried first and is wrong: it collapses
 * too fast, leaving 62% of blocks under 40 m and a downtown that reads as a
 * carpet with two spikes in it. A rational falloff has a much fatter shoulder —
 * half height at d = f rather than a fifth — which is what actually produces a
 * broad band of 60-140 m buildings around the core, the way a real downtown
 * looks from the air.
 */
const falloff = (d, f) => 1 / (1 + (d / f) ** 2.2);

const BLOCK_PITCH_M = 91;
const BLOCK_SIZE_M = 71;

/**
 * @param {object} [opts]
 * @param {{x:number,z:number,radiusM:number}[]} [opts.exclude] Keep-out discs,
 *   normally the footprints of the real modelled landmarks, so a filler block
 *   does not grow up through Columbia Center.
 * @param {number} [opts.seed]
 * @returns {THREE.InstancedMesh|null} One draw call for the whole skyline, or
 *   null if nothing could be placed (no DEM, or every cell was water).
 */
/**
 * The city-mass material: one Lambert, one draw call, and a procedural facade.
 *
 * WHY A SHADER AND NOT THE WINDOW TEXTURE. The named towers each get their own
 * material so `repeat` can be set from their real metres (see glassMaterial).
 * The filler blocks cannot: they are ONE InstancedMesh with one material and
 * ~600 different sizes, so a single UV repeat would stretch a 4 m storey into a
 * 30 m one on the tall blocks. Deriving the storey line from WORLD Y instead
 * makes every block agree about where the floors are — which is also true of a
 * real city, where the floor lines of adjacent buildings roughly line up.
 *
 * The three parts that matter, in order of how much they change the picture:
 *   1. Roofs are dark. Untextured white boxes lit from above are lightest
 *      exactly where a real city is darkest (tar, gravel, plant rooms), and
 *      that inversion is most of why a box city reads as sugar cubes.
 *   2. Storey banding at 3.6 m, with vertical bays at 2.4 m. This is what
 *      gives the mass a scale reference; without it a 40 m block and a 140 m
 *      block look the same from any distance.
 *   3. A parapet line and a darkened ground floor, so the top and bottom of
 *      each block are not the same as its middle.
 *
 * All of it fades out past ~2.5 km, where a 2.4 m bay is sub-pixel and would
 * only alias into moiré.
 */
function makeCityFacadeMaterial() {
  const m = lambert(0xffffff);
  m.name = 'downtown-facade';

  m.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        /* glsl */ `
        #include <common>
        varying vec3 vCityWorld;
        varying vec3 vCityNormal;
        varying vec3 vCityLocal;
        `,
      )
      .replace(
        '#include <begin_vertex>',
        /* glsl */ `
        #include <begin_vertex>
        #ifdef USE_INSTANCING
          vCityWorld = (modelMatrix * instanceMatrix * vec4(transformed, 1.0)).xyz;
          vCityNormal = normalize(mat3(modelMatrix) * mat3(instanceMatrix) * objectNormal);
          // The box is a unit cube, so position.y is exactly -0.5..0.5 of this
          // block's own height whatever it was scaled to. That is the only way
          // to find a parapet or a ground floor without a per-instance uniform.
          vCityLocal = position;
        #else
          vCityWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;
          vCityNormal = normalize(mat3(modelMatrix) * objectNormal);
          vCityLocal = position;
        #endif
        `,
      );

    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        /* glsl */ `
        #include <common>
        varying vec3 vCityWorld;
        varying vec3 vCityNormal;
        varying vec3 vCityLocal;
        `,
      )
      .replace('#include <map_fragment>', CITY_FACADE_GLSL);
  };

  // Otherwise three may hand this material a program compiled for some other
  // MeshLambertMaterial with the same defines.
  m.customProgramCacheKey = () => 'ken-downtown-facade';
  return m;
}

const CITY_FACADE_GLSL = /* glsl */ `
{
  vec3 n = normalize(vCityNormal);
  float roof = smoothstep(0.62, 0.86, abs(n.y));
  float fade = 1.0 - smoothstep(700.0, 2600.0, distance(vCityWorld, cameraPosition));

  // Which horizontal axis runs across this face.
  float across = mix(vCityWorld.x, vCityWorld.z, step(abs(n.z), abs(n.x)));

  // 3.6 m storeys, 2.4 m structural bays. Windows occupy the upper part of
  // each storey and most of each bay; the rest is spandrel and mullion.
  float storey = fract(vCityWorld.y * (1.0 / 3.6));
  float bay = fract(across * (1.0 / 2.4));
  float glazed = smoothstep(0.20, 0.30, storey) * (1.0 - smoothstep(0.80, 0.90, storey))
               * smoothstep(0.14, 0.24, bay) * (1.0 - smoothstep(0.80, 0.90, bay));
  float win = glazed * (1.0 - roof) * fade;

  // Parapet: the top ~1.5% of the block, and the ground floor, read differently
  // from the shaft on any real building.
  float parapet = smoothstep(0.470, 0.492, vCityLocal.y) * (1.0 - roof) * fade;
  float plinth = (1.0 - smoothstep(-0.470, -0.435, vCityLocal.y)) * (1.0 - roof) * fade;

  vec3 c = diffuseColor.rgb;
  // Glass: darker and bluer than its spandrel.
  c = mix(c, c * vec3(0.56, 0.66, 0.83), win * 0.55);
  // Roofs: tar, gravel and plant. Never the brightest face on the building.
  c = mix(c, c * vec3(0.40, 0.41, 0.43), roof);
  c = mix(c, c * 1.14, parapet);
  c = mix(c, c * 0.70, plinth);
  diffuseColor.rgb = c;
}
`;

export function buildDowntownMass(opts = {}) {
  const exclude = opts.exclude ?? [];
  const rand = mulberry32(opts.seed ?? 0x5ea77e);

  const placements = [];
  const ll = { x: 0, z: 0 };
  const geo3 = { lat: 0, lon: 0 };
  const demLoaded = isLoaded();

  for (const c of CLUSTERS) {
    llToLocal(c.lat, c.lon, ll);
    const cx = ll.x;
    const cz = ll.z;
    // Rotate the block grid onto the cluster's street bearing, with the same
    // mapping landmarks.js uses: local +X onto heading `gridDeg`.
    const th = (90 - c.gridDeg) * DEG;
    const cos = Math.cos(th);
    const sin = Math.sin(th);

    const nx = Math.floor(c.halfLenM / BLOCK_PITCH_M);
    const nz = Math.floor(c.halfWidM / BLOCK_PITCH_M);

    for (let i = -nx; i <= nx; i++) {
      for (let j = -nz; j <= nz; j++) {
        const gu = i * BLOCK_PITCH_M;
        const gv = j * BLOCK_PITCH_M;
        const x = cx + (gu * cos - gv * sin);
        const z = cz + (-gu * sin - gv * cos);

        // Streets, parks, parking lots, the freeway trench. Draw first so the
        // sequence of rand() calls does not depend on the rejections below —
        // otherwise adding a landmark reshuffles the entire skyline.
        const skip = rand() < 0.17;
        const jitterH = rand();
        const jitterW = rand();
        if (skip) continue;

        let blocked = false;
        for (const e of exclude) {
          if ((x - e.x) ** 2 + (z - e.z) ** 2 < e.radiusM * e.radiusM) {
            blocked = true;
            break;
          }
        }
        if (blocked) continue;

        localToLl(x, z, geo3);
        // isWater() is getElevation() <= 0.5 m, and getElevation() is TOTAL:
        // with no DEM loaded it returns sea level for every query, so every
        // cell would test as water and the entire city would silently vanish.
        // Skipping the test when the DEM is absent degrades to "a city on a
        // flat world" rather than "no city", per MODULES.md §1.6.
        if (demLoaded && isWater(geo3.lat, geo3.lon)) continue;
        const ground = getElevation(geo3.lat, geo3.lon);
        if (!Number.isFinite(ground)) continue;

        const d = Math.hypot(gu, gv);
        let h = c.maxH * Math.exp(-((d / c.falloffM) ** 1.5));
        h *= 0.34 + 0.66 * jitterH;
        if (h < 11) h = 11 + jitterW * 9;

        placements.push({ x, z, y: ground, h, th, r: jitterW });
      }
    }
  }

  if (!placements.length) return null;

  const mesh = new THREE.InstancedMesh(
    new THREE.BoxGeometry(1, 1, 1),
    mat('cityMass', makeCityFacadeMaterial),
    placements.length,
  );
  mesh.name = 'downtown-mass';
  mesh.castShadow = true;
  mesh.receiveShadow = true;

  const t3 = new THREE.Object3D();
  const col = new THREE.Color();
  // Sink each block so a sloping street does not show daylight under the
  // uphill corner. Downtown Seattle climbs ~70 m off the waterfront, so this
  // is not hypothetical.
  const EMBED_M = 7;

  for (let i = 0; i < placements.length; i++) {
    const p = placements[i];
    t3.position.set(p.x, p.y + (p.h - EMBED_M) / 2, p.z);
    t3.rotation.set(0, p.th, 0);
    t3.scale.set(
      BLOCK_SIZE_M * (0.55 + 0.4 * p.r),
      p.h + EMBED_M,
      BLOCK_SIZE_M * (0.55 + 0.4 * (1 - p.r)),
    );
    t3.updateMatrix();
    mesh.setMatrixAt(i, t3.matrix);

    // Three material families, not one grey ramp. A real downtown block is
    // green-tinted curtain wall next to warm precast next to dark 1970s glass,
    // and the fastest way to make a city read as a set of identical sugar
    // cubes — which is exactly what an A/B picks out — is to give every block
    // the same hue and vary only its brightness. Tall blocks lean toward glass
    // and short ones toward masonry, which is how the real stock sorts itself.
    const v = 0.50 + 0.30 * p.r - Math.min(0.20, p.h / 900);
    const glassBias = Math.min(1, p.h / 120);
    const fam = (p.r * 3.7 + glassBias) % 1;
    if (fam < 0.42) {
      col.setRGB(v * 0.80, v * 0.93, v * 1.00); // green-blue curtain wall
    } else if (fam < 0.74) {
      col.setRGB(v * 1.06, v * 1.01, v * 0.92); // warm precast concrete
    } else {
      col.setRGB(v * 0.72, v * 0.74, v * 0.82); // dark glass / dark stone
    }
    mesh.setColorAt(i, col);
  }
  mesh.instanceMatrix.needsUpdate = true;
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  return mesh;
}
