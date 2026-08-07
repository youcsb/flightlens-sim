/**
 * check-buildings.mjs — executable form of MODULES.md §2.16.
 *
 *   npm run check:buildings
 *
 * This runs the REAL src/geo/buildings.js decoder and the REAL
 * src/world/landmarkModels.js extruder against the REAL baked footprints and
 * the REAL DEM tiles. Nothing is mocked except the two things Node cannot do:
 * `fetch` for the JSON (replaced by reading the file and calling the exported
 * decoder) and the canvas the DEM's browser path uses for pixels (replaced with
 * the same on-disk PNG provider check-elevation.mjs uses).
 *
 * WHY THIS EXISTS. Three failures here are invisible in a screenshot and fatal
 * to the claim that the footprints are real:
 *
 *   1. A WINDING error. Every side face inverted still renders — you just get a
 *      city of holes seen through its own back faces, and only from some
 *      angles. The normals are asserted against the index order they were
 *      emitted with, and the roofs against +Y.
 *   2. A PROJECTION drift. The baker freezes metres-per-degree at SCALE_LAT.
 *      If coords.js ever moves, every footprint silently becomes the wrong
 *      size — 1.3% per degree, far too small to see and far too large to be
 *      right. Asserted directly, and again by measuring a known building.
 *   3. A PROVENANCE lie. The heights are mostly derived. The file has to say so
 *      per building and the counts have to add up, or someone downstream will
 *      quote one as surveyed.
 *
 * Plus the budget: triangles, buffer bytes and build time, because 24,000
 * extruded polygons is the largest single thing added to the scene this round
 * and "it looked fine on my machine" is not a measurement.
 */

import { readFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import * as THREE from 'three';
import { decodePng } from './lib/png.mjs';
import { PUBLIC_DIR } from './lib/util.mjs';
import * as C from '../src/geo/coords.js';
import * as E from '../src/geo/elevation.js';
import * as B from '../src/geo/buildings.js';
import { buildDowntownMass, cityStats } from '../src/world/landmarkModels.js';

let failures = 0;
const ok = (name, cond, note = '') => {
  if (cond) {
    console.log(`  ok   ${name}${note ? `  (${note})` : ''}`);
  } else {
    failures++;
    console.log(`  FAIL ${name}${note ? `  (${note})` : ''}`);
  }
};
const MB = (b) => `${(b / 1048576).toFixed(1)} MiB`;

const FILE = resolve(PUBLIC_DIR, 'data/buildings.json');
if (!existsSync(FILE)) {
  console.log('\n  SKIP — public/data/buildings.json is not baked. Run `node scripts/bake-buildings.mjs`.\n');
  process.exit(0);
}

// Published coordinates. These are the same reference points the rest of the
// project is checked against; a footprint landing far from one of them means
// the projection or the encoding moved, not that the city did.
const COLUMBIA_CENTER = [47.60455, -122.33055];
const SPACE_NEEDLE = [47.6204, -122.3491];
const SMITH_TOWER = [47.60181, -122.33191];
const MID_ELLIOTT_BAY = [47.6045, -122.3805];

C.setOrigin(C.DEFAULT_ORIGIN.lat, C.DEFAULT_ORIGIN.lon);

// ---------------------------------------------------------------------------
// Decode
// ---------------------------------------------------------------------------
console.log('\ndecode');
const raw = JSON.parse(readFileSync(FILE, 'utf8'));
const bytes = readFileSync(FILE).byteLength;
const t0 = performance.now();
const set = B.decodeBuildings(raw);
const decodeMs = performance.now() - t0;

console.log(`       ${raw.source}`);
console.log(`       baked ${raw.generated}`);
ok('the file is a compact subset, not the state extract', bytes < 6 * 1048576, `${(bytes / 1048576).toFixed(2)} MB on disk`);
ok('decodes in under 120 ms', decodeMs < 120, `${decodeMs.toFixed(0)} ms for ${set.count.toLocaleString()} buildings`);
ok('scaleLat matches coords.js — footprints are the right size', Math.abs(raw.scaleLat - C.SCALE_LAT) < 1e-9, `${raw.scaleLat}`);
ok('every building has a ring', set.ringStart[set.count] === set.totalVertices && set.count > 0, `${set.totalVertices.toLocaleString()} vertices`);
ok('at least 15,000 real footprints', set.count >= 15000, `${set.count.toLocaleString()}`);
ok('mean ring is a real outline, not a box', set.totalVertices / set.count > 5, `${(set.totalVertices / set.count).toFixed(1)} vertices/building`);

{
  let bad = 0;
  let tiny = 0;
  for (let i = 0; i < set.count; i++) {
    if (!Number.isFinite(set.heightM[i]) || set.heightM[i] <= 0 || set.heightM[i] > 320) bad++;
    if (set.areaM2[i] < 50) tiny++;
    const n = set.ringStart[i + 1] - set.ringStart[i];
    if (n < 3) bad++;
  }
  ok('no impossible height and no degenerate ring', bad === 0, `${bad} bad`);
  ok('no footprint below the 70 m2 floor', tiny === 0, `${tiny} under 50 m2`);
}

// ---------------------------------------------------------------------------
// Provenance — the heights are mostly derived and the file must say so
// ---------------------------------------------------------------------------
console.log('\nprovenance (MODULES.md §2.16 — heights are NOT surveyed)');
{
  const p = B.buildingProvenance();
  console.log(`       published ${p.published}  |  DSM storeys ${p.dsm}  |  derived ${p.derived}`);
  const counted = { published: 0, dsm: 0, derived: 0 };
  for (let i = 0; i < set.count; i++) counted[B.srcOf(i)]++;
  ok('the declared provenance counts match the per-building tags',
    counted.published === p.published && counted.dsm === p.dsm && counted.derived === p.derived,
    `${counted.published}/${counted.dsm}/${counted.derived}`);
  ok('the vast majority of heights are declared NOT published', p.published / set.count < 0.01, `${((100 * p.published) / set.count).toFixed(2)}% published`);
  ok('the note names the DSM saturation', /saturat/i.test(raw.note || ''));
  ok('every published height is above 40 m — the table is towers, not houses',
    (() => {
      for (let i = 0; i < set.count; i++) if (set.src[i] === B.SRC_PUBLISHED && set.heightM[i] < 40) return false;
      return true;
    })());
  // The DSM branch caps at five storeys, which storeysToMetres puts at 21.65 m.
  // Anything above that would mean a saturated reading leaked through.
  ok('no DSM-sourced height exceeds five storeys — the saturated range is discarded',
    (() => {
      for (let i = 0; i < set.count; i++) if (set.src[i] === B.SRC_DSM && set.heightM[i] > 22) return false;
      return true;
    })(), `max ${(() => { let m = 0; for (let i = 0; i < set.count; i++) if (set.src[i] === B.SRC_DSM && set.heightM[i] > m) m = set.heightM[i]; return m.toFixed(1); })()} m`);
}

// ---------------------------------------------------------------------------
// Geography — the footprints have to be where the buildings are
// ---------------------------------------------------------------------------
console.log('\ngeography');
{
  const cc = B.nearestBuilding(...COLUMBIA_CENTER, 200);
  ok('Columbia Center has a real footprint at its published coordinate', !!cc && cc.distanceM < 40,
    cc ? `${cc.distanceM.toFixed(0)} m away, ${cc.areaM2.toFixed(0)} m2` : 'none');
  const sn = B.nearestBuilding(...SPACE_NEEDLE, 200);
  ok('the Space Needle has a real footprint too', !!sn && sn.distanceM < 40,
    sn ? `${sn.distanceM.toFixed(0)} m away, ${sn.areaM2.toFixed(0)} m2` : 'none');
  const st = B.nearestBuilding(...SMITH_TOWER, 200);
  ok('Smith Tower has a real footprint', !!st && st.distanceM < 60,
    st ? `${st.distanceM.toFixed(0)} m away, ${st.areaM2.toFixed(0)} m2` : 'none');

  // A projection sign flip would put the whole city in the water and nothing
  // else here would notice.
  const bay = B.nearestBuilding(...MID_ELLIOTT_BAY, 400);
  ok('mid Elliott Bay has no buildings within 400 m', !bay, bay ? `${bay.distanceM.toFixed(0)} m` : 'clear');

  ok('everything is inside the baked inset',
    (() => {
      for (let i = 0; i < set.count; i++) {
        if (!C.inBbox(set.anchorLat[i], set.anchorLon[i], set.bbox)) return false;
      }
      return true;
    })(), `${set.bbox.south}..${set.bbox.north}, ${set.bbox.west}..${set.bbox.east}`);

  // The ring's own area, recomputed from the decoded metres, has to agree with
  // the polygon a human would measure. A block in the CBD is ~5,300 m2.
  let big = 0;
  let sum = 0;
  for (let i = 0; i < set.count; i++) {
    sum += set.areaM2[i];
    if (set.areaM2[i] > 5300) big++;
  }
  console.log(`       total footprint area ${(sum / 1e6).toFixed(2)} km2, ${big} polygons bigger than a Seattle block`);
  ok('the mean footprint is building-sized', sum / set.count > 150 && sum / set.count < 1500, `${(sum / set.count).toFixed(0)} m2`);
}

// ---------------------------------------------------------------------------
// The DEM, so the extruder has real ground to sit on
// ---------------------------------------------------------------------------
const DEM_DIR = resolve(PUBLIC_DIR, 'dem');
let demReady = false;
if (existsSync(join(DEM_DIR, 'manifest.json'))) {
  const manifest = JSON.parse(readFileSync(join(DEM_DIR, 'manifest.json'), 'utf8'));
  E.setTileProvider({
    manifest,
    async fetchPixels(z, x, y) {
      const p = join(DEM_DIR, String(z), String(x), `${y}.png`);
      if (!existsSync(p)) return null;
      const img = decodePng(readFileSync(p));
      return { width: img.width, height: img.height, rgba: img.rgba };
    },
  });
  await E.loadRegion(C.REGION_BBOX, E.DEM_ZOOM);
  E.setViewer(0, 0);
  await E.warmAt(47.6062, -122.3321);
  demReady = true;
}

// ---------------------------------------------------------------------------
// Extrude — the shipping builder, in Node, with no WebGL
// ---------------------------------------------------------------------------
console.log('\nextrusion');
const keepOut = [
  // Same discs landmarks.js punches for the modelled towers.
  { ...C.llToLocal(...SPACE_NEEDLE), radiusM: 37 },
  { ...C.llToLocal(...COLUMBIA_CENTER), radiusM: 59 },
];
const group = buildDowntownMass({ exclude: keepOut });
// buildDowntownMass is self-populating (§2.17): it returns an empty group and
// fills it once the footprints resolve. It also refuses to build into an
// orphan, so the group needs a parent before the microtask runs.
const scene = new THREE.Group();
scene.add(group);
// `cityStats` is an ESM live binding, so polling it reads the module's current
// value rather than a snapshot taken at import time.
const M = await import('../src/world/landmarkModels.js');
for (let i = 0; i < 200 && !M.cityStats; i++) await new Promise((r) => setTimeout(r, 10));
const s = M.cityStats;
ok('the city built', !!s && s.buildings > 0, s ? `${s.buildings.toLocaleString()} buildings` : 'nothing');

if (s) {
  console.log(
    `       ${s.chunks} chunks, ${s.meshes} meshes, ${(s.triangles / 1000).toFixed(0)}k triangles, ` +
      `${MB(s.gpuBytes)} of buffers, ${s.buildMs.toFixed(0)} ms`,
  );
  ok('draw calls stay small — one merged mesh per chunk per LOD tier', s.meshes <= 320, `${s.meshes} meshes`);
  ok('triangle budget under 1.2 M', s.triangles < 1_200_000, `${(s.triangles / 1000).toFixed(0)}k`);
  ok('GPU buffers under 64 MiB', s.gpuBytes < 64 * 1048576, MB(s.gpuBytes));
  ok('build cost is a one-off under 900 ms', s.buildMs < 900, `${s.buildMs.toFixed(0)} ms`);
  // Self-touching source rings that ear clipping cannot close. They fall back
  // to a convex-hull roof, which over-covers into the polygon's own concavities
  // and never past its extent. A rate, not a zero — the source has what it has.
  ok('self-touching rings stay under 0.5% of the city',
    s.degenerateRoofs / s.buildings < 0.005,
    `${s.degenerateRoofs} of ${s.buildings.toLocaleString()} (${((100 * s.degenerateRoofs) / s.buildings).toFixed(2)}%)`);
  ok('the modelled landmarks punched their keep-outs', s.excludedByLandmarks > 0, `${s.excludedByLandmarks} footprints removed`);
}

// ---------------------------------------------------------------------------
// Winding and attributes — the failure that renders and is still wrong
// ---------------------------------------------------------------------------
console.log('\nwinding and attributes');
{
  let meshes = 0;
  let tris = 0;
  let backwards = 0;
  let roofDown = 0;
  let nan = 0;
  let attrBad = 0;
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  const e1 = new THREE.Vector3();
  const e2 = new THREE.Vector3();
  const fn = new THREE.Vector3();
  const sn = new THREE.Vector3();

  group.traverse((o) => {
    if (!o.isMesh || !o.geometry?.index) return;
    meshes++;
    const g = o.geometry;
    const pos = g.attributes.position.array;
    const nor = g.attributes.normal.array;
    const up = g.attributes.aUp.array;
    const down = g.attributes.aDown.array;
    const idx = g.index.array;
    for (let i = 0; i < pos.length; i++) if (!Number.isFinite(pos[i])) nan++;
    for (let i = 0; i < up.length; i++) {
      const h = (up[i] + down[i]) * 0.1;
      if (h < 1 || h > 320) attrBad++;
    }
    // Every triangle: the normal implied by its index winding must agree with
    // the normal stored on its vertices. That is what proves the two were
    // derived together rather than one of them being guessed.
    for (let t = 0; t < idx.length; t += 3) {
      const i0 = idx[t];
      const i1 = idx[t + 1];
      const i2 = idx[t + 2];
      a.fromArray(pos, i0 * 3);
      b.fromArray(pos, i1 * 3);
      c.fromArray(pos, i2 * 3);
      e1.subVectors(b, a);
      e2.subVectors(c, a);
      fn.crossVectors(e1, e2);
      if (fn.lengthSq() < 1e-10) continue; // collapsed degenerate-edge quad
      fn.normalize();
      sn.set(nor[i0 * 3] / 127, nor[i0 * 3 + 1] / 127, nor[i0 * 3 + 2] / 127).normalize();
      tris++;
      if (fn.dot(sn) < 0.5) backwards++;
      if (sn.y > 0.9 && fn.y < 0) roofDown++;
    }
  });

  console.log(`       ${meshes} meshes, ${tris.toLocaleString()} non-degenerate triangles inspected`);
  ok('no NaN anywhere in the position buffers', nan === 0, `${nan}`);
  ok('every triangle winds to agree with its stored normal', backwards === 0, `${backwards} inverted`);
  ok('every roof faces up', roofDown === 0, `${roofDown} facing down`);
  ok('aUp + aDown is a plausible building height at every vertex', attrBad === 0, `${attrBad} bad`);
}

// ---------------------------------------------------------------------------
// Ground contact — buildings must not float or drown
// ---------------------------------------------------------------------------
if (demReady) {
  console.log('\nground contact');
  let floating = 0;
  let buried = 0;
  let worstFloat = 0;
  const ll = { lat: 0, lon: 0 };
  const boxes = [];
  group.traverse((o) => {
    if (o.isMesh && o.geometry?.attributes?.position) boxes.push(o);
  });
  // WORLD position, not mesh.position. The minor mesh of every chunk hangs off
  // a THREE.LOD that carries the chunk offset, so reading mesh.position gives
  // (0,0,0) for half the city and samples the DEM 20 km from the building.
  scene.updateMatrixWorld(true);
  const wp = new THREE.Vector3();
  let sampled = 0;
  for (const mesh of boxes) {
    mesh.getWorldPosition(wp);
    const pos = mesh.geometry.attributes.position.array;
    const stride = Math.max(3, Math.floor(pos.length / 3 / 400) * 3);
    for (let i = 0; i < pos.length; i += stride * 3) {
      const x = pos[i] + wp.x;
      const y = pos[i + 1];
      const z = pos[i + 2] + wp.z;
      C.localToLl(x, z, ll);
      const g = E.getElevation(ll.lat, ll.lon);
      sampled++;
      // Base vertices are the only ones that can float: a roof is meant to be
      // above the ground. Identify them by aUp, which is negative exactly on
      // the buried skirt, rather than by guessing from the height.
      const vi = i / 3;
      if (mesh.geometry.attributes.aUp.array[vi] >= 0) continue;
      const gap = g - y;
      if (gap < -0.01) floating++;
      if (gap > 60) buried++;
      if (-gap > worstFloat) worstFloat = -gap;
    }
  }
  console.log(`       ${sampled.toLocaleString()} vertices sampled against the DEM`);
  ok('no building floats above its own ground', floating === 0, `worst ${worstFloat.toFixed(2)} m`);
  ok('nothing is buried more than 60 m', buried === 0, `${buried}`);
}

// ---------------------------------------------------------------------------
// THE SIZE BUDGET. core/device.js publishes `minorCutoffM: 0` for the phone —
// "the minor class is never drawn at any distance". Until that was applied at
// DECODE time, those 17,255 footprints were still fetched, decoded, DEM-sampled
// at every one of their ring vertices, triangulated and uploaded, so a THREE.LOD
// could switch them off on frame 0 and keep them resident for the flight.
//
// This runs LAST because decodeBuildings() replaces the module's live set.
// ---------------------------------------------------------------------------
console.log('\nthe phone size budget: what is never drawn is never decoded');
{
  // The classifier is the extruder's, and the two have to agree exactly or they
  // disagree about which buildings exist.
  const src = readFileSync(resolve(PUBLIC_DIR, '..', 'src/world/landmarkModels.js'), 'utf8');
  const num = (name) => Number(src.match(new RegExp(`const ${name} = ([\\d.]+)`))?.[1]);
  ok(
    'the class thresholds match landmarkModels.js to the digit',
    num('TALL_H_M') === B.BUILDING_TALL_H_M &&
      num('MAJOR_H_M') === B.BUILDING_MAJOR_H_M &&
      num('MAJOR_AREA_M2') === B.BUILDING_MAJOR_AREA_M2,
    `${B.BUILDING_TALL_H_M} / ${B.BUILDING_MAJOR_H_M} m / ${B.BUILDING_MAJOR_AREA_M2} m2`,
  );

  // Count what the full set says, then decode again under the phone budget.
  const cls = { tall: 0, major: 0, minor: 0 };
  let minorVerts = 0;
  for (let i = 0; i < set.count; i++) {
    const c = B.classifyBuilding(set.heightM[i], set.areaM2[i]);
    cls[c]++;
    if (c === 'minor') minorVerts += set.ringStart[i + 1] - set.ringStart[i];
  }

  const phone = B.decodeBuildings(raw, { majorCutoffM: 8000, minorCutoffM: 0 });
  ok(
    'the minor class is gone and nothing else is',
    phone.count === cls.tall + cls.major,
    `${phone.count.toLocaleString()} of ${set.count.toLocaleString()} kept ` +
      `(${cls.tall} tall + ${cls.major} major, ${cls.minor.toLocaleString()} minor dropped)`,
  );
  ok(
    'and their ring vertices are gone with them',
    phone.totalVertices === set.totalVertices - minorVerts,
    `${phone.totalVertices.toLocaleString()} of ${set.totalVertices.toLocaleString()} ` +
      `(${((1 - phone.totalVertices / set.totalVertices) * 100).toFixed(0)}% fewer)`,
  );
  ok(
    'the arrays are COPIED, not subarray views — a view keeps the whole buffer',
    phone.ringE.buffer.byteLength === phone.ringE.byteLength &&
      phone.anchorLat.buffer.byteLength === phone.anchorLat.byteLength,
    `${(phone.ringE.buffer.byteLength / 1024).toFixed(0)} KiB backing a ` +
      `${(phone.ringE.byteLength / 1024).toFixed(0)} KiB array`,
  );
  ok('meta.filtered says what is missing', phone.meta.filtered?.dropped === cls.minor);
  ok(
    'provenance is recounted over what survived, not carried over',
    phone.meta.provenance.published + phone.meta.provenance.dsm + phone.meta.provenance.derived ===
      phone.count,
    `${phone.meta.provenance.published}p + ${phone.meta.provenance.dsm}m + ` +
      `${phone.meta.provenance.derived}d`,
  );

  // GEOGRAPHY IS NOT A TIER SETTING. Every surviving footprint has to be the
  // same polygon in the same place, to the bit, as it was in the full set.
  let idx = 0;
  let moved = 0;
  let deformed = 0;
  for (let i = 0; i < set.count; i++) {
    if (B.classifyBuilding(set.heightM[i], set.areaM2[i]) === 'minor') continue;
    if (set.anchorLat[i] !== phone.anchorLat[idx] || set.anchorLon[i] !== phone.anchorLon[idx]) {
      moved++;
    }
    const n = set.ringStart[i + 1] - set.ringStart[i];
    const m = phone.ringStart[idx + 1] - phone.ringStart[idx];
    if (n !== m) deformed++;
    else {
      for (let k = 0; k < n; k++) {
        if (
          set.ringE[set.ringStart[i] + k] !== phone.ringE[phone.ringStart[idx] + k] ||
          set.ringN[set.ringStart[i] + k] !== phone.ringN[phone.ringStart[idx] + k]
        ) {
          deformed++;
          break;
        }
      }
    }
    idx++;
  }
  ok('every surviving building is at exactly the same coordinate', moved === 0, `${moved} moved`);
  ok('and has exactly the same outline', deformed === 0, `${deformed} deformed`);

  // And the seam stays a seam: no argument means no filter, whatever a browser
  // may have set on the module.
  const again = B.decodeBuildings(raw);
  ok(
    'decodeBuildings with no policy still decodes the whole file',
    again.count === set.count && again.meta.filtered === null,
    `${again.count.toLocaleString()}`,
  );
}

console.log(
  failures ? `\n${failures} building check(s) FAILED\n` : '\nall building checks passed\n',
);
process.exit(failures ? 1 : 0);
