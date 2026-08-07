/**
 * check-terrain.mjs — executable form of MODULES.md §1.4 and §2.7.
 *
 *   npm run check:terrain
 *
 * This runs the REAL src/world/terrain.js — the shipping `createTerrain`, the
 * shipping LOD selector, the shipping geometry builder — against the REAL baked
 * DEM. The only thing swapped out is the pixel source: `setTileProvider` points
 * elevation.js at scripts/lib/png.mjs and the files on disk instead of at
 * fetch + createImageBitmap + canvas, exactly as check-elevation.mjs does.
 *
 * WHY THIS EXISTS. Round 2 replaced fixed distance-ring LOD with an error
 * metric: each node probes the DEM for its own geometric error and subdivides
 * on that. That change is invisible in a screenshot and catastrophic in three
 * specific ways, none of which any other harness would notice:
 *
 *   1. THE GROUND-HEIGHT INVARIANT (§1.4). The drawn mesh and the collision
 *      surface must come from one sampler. An error metric is a strong
 *      temptation to cache heights in the node and answer ground queries from
 *      them. That would make ground contact change when LOD changes.
 *
 *   2. A LIMIT CYCLE. An error metric whose subdivision test depends on
 *      anything the previous frame decided can oscillate: node splits, its
 *      children measure a different error, they merge, it splits again. The
 *      aeroplane sits still and the mountain flickers at 60 Hz. The guard is
 *      that a STATIONARY camera must select a byte-identical node set on
 *      frames 30, 120 and 399.
 *
 *   3. UNBOUNDED SUBDIVISION. `MIN_NODE_SIZE` alone does not stop a node from
 *      subdividing past the resolution of the data underneath it — that is
 *      `demSpacingAt`'s job. If it ever stops working the tree does not crash,
 *      it just quietly allocates four times the geometry to draw interpolated
 *      nothing, and the cache ceiling goes with it.
 *
 * LAND COVER IS ABSENT HERE, deliberately. `landcover.js#decodeToRgba` needs
 * `createImageBitmap` and a canvas, which node has neither of, so it degrades to
 * null (§1.6) and the terrain falls back to the elevation-and-slope palette.
 * That is a COLOUR path; every number below is geometry, and geometry does not
 * read the land-cover raster. `npm run check:landcover` covers the other side.
 *
 * Expected values are measured against the shipping code, not invented. Where a
 * bound is a budget it is written as a budget with headroom; where a bound is an
 * invariant it is written as zero.
 */

import { readFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import * as THREE from 'three';
import { decodePng } from './lib/png.mjs';
import { PUBLIC_DIR } from './lib/util.mjs';
import * as C from '../src/geo/coords.js';
import * as E from '../src/geo/elevation.js';
import { createTerrain } from '../src/world/terrain.js';

let failures = 0;
const ok = (name, cond, note = '') => {
  if (cond) {
    console.log(`  ok   ${name}${note ? `  (${note})` : ''}`);
  } else {
    failures++;
    console.log(`  FAIL ${name}${note ? `  (${note})` : ''}`);
  }
};
const head = (s) => console.log(`\n${s}\n${'-'.repeat(s.length)}`);

// Verified reference points — the same ones round 1 established.
const KBFI = [47.527042, -122.29995];
const KSEA = [47.447943, -122.310276];
const RAINIER = [46.8517, -121.7603];
const ELLIOTT_BAY = [47.6045, -122.3805];
const CASCADE_CREST = [47.45, -121.45];

const DEM_DIR = resolve(PUBLIC_DIR, 'dem');
if (!existsSync(join(DEM_DIR, 'manifest.json'))) {
  console.log('\n  SKIP — public/dem is not baked. Run `npm run bake:dem`.\n');
  process.exit(0);
}
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

C.setOrigin(C.DEFAULT_ORIGIN.lat, C.DEFAULT_ORIGIN.lon);

// ---------------------------------------------------------------------------
// §1.4 — the sampler is the sampler, before anything is even built
// ---------------------------------------------------------------------------
head('1. §1.4 — terrain.js does not have its own ground surface');
{
  const src = readFileSync(resolve(PUBLIC_DIR, '..', 'src/world/terrain.js'), 'utf8');
  // The banned implementation. A raycast against the drawn mesh makes ground
  // contact a function of LOD, which is the one thing §1.4 exists to prevent.
  ok('no THREE.Raycaster anywhere in terrain.js', !/\bRaycaster\b/.test(src));
  ok('no .raycast( call anywhere in terrain.js', !/\.raycast\s*\(/.test(src));
  // getHeightAt must be a delegation, not a reimplementation.
  const body = src.match(/function getHeightAt\([^)]*\)\s*\{([^}]*)\}/)?.[1] ?? '';
  ok(
    'getHeightAt is one line and it is getElevationLocal',
    /return\s+getElevationLocal\(x,\s*z\)/.test(body),
    body.trim(),
  );
  ok(
    'getHeightAt reads no node, no cache and no vertex buffer',
    !/nodes|_hgrid|geometry|position/.test(body),
  );
}

const scene = new THREE.Scene();
const tBuild0 = Date.now();
const terrain = await createTerrain(scene, {});
const buildMs = Date.now() - tBuild0;

const camera = new THREE.PerspectiveCamera(60, 1000 / 562, 0.35, 300000);

/** Park the camera at a lat/lon and altitude and run the LOD a few passes. */
function park(lat, lon, altM, frames = 8) {
  const p = C.llToLocal(lat, lon);
  camera.position.set(p.x, altM, p.z);
  camera.updateMatrixWorld(true);
  for (let i = 0; i < frames; i++) terrain.update(camera);
  return p;
}

/**
 * Park, then drive the pager to completion and let the LOD converge onto the
 * data it brought in.
 *
 * `flushPaging` alone is not enough: `setViewer` — which is what tells the pager
 * where to page — is called from `terrain.update`, so the two have to be
 * alternated. Each round queues the tiles the current viewpoint wants, drains
 * them, and lets the next selection descend one more level into what arrived.
 *
 * This is the state every measurement below is taken in, and saying so matters:
 * mid-stream numbers are a measurement of the pager's pacing, not of the LOD.
 */
async function settle(lat, lon, altM) {
  const p = C.llToLocal(lat, lon);
  camera.position.set(p.x, altM, p.z);
  camera.updateMatrixWorld(true);

  // NOTHING HERE MAY DEPEND ON WALL-CLOCK TIME. `update()` meters its chunk
  // building against `performance.now()`, so how far the LOD descends in a
  // fixed number of update() calls depends on how busy the machine is — and a
  // harness built on it reports a different RMS on every run. Measured while
  // this loop was `update()`-driven: Rainier's 8 km RMS came out 0.57 m, 4.33 m
  // and 4.44 m on three consecutive runs of identical code.
  //
  // `converge()` is the budget-free path — it is what main.js calls after a
  // teleport, and it builds and revalidates to a fixed point with no deadline.
  // One `update()` per round is still needed because that is what calls
  // `setViewer`, which is how the pager learns where to page.
  let prev = '';
  for (let round = 0; round < 30; round++) {
    terrain.update(camera);
    await E.flushPaging();
    terrain.converge(p.x, altM, p.z);
    const s = terrain.stats();
    const sig = `${s.drawn}/${s.finestCellM}/${s.nodes}`;
    if (sig === prev) return p;
    prev = sig;
  }
  return p;
}

/** The node meshes the selector actually emitted this pass. */
function drawnNodes() {
  return terrain.group.children.filter((c) => c.visible && /^terrain-\d+\//.test(c.name));
}

// ---------------------------------------------------------------------------
head('2. §1.4 — the drawn surface and the collision surface are one field');
{
  // 5,000 samples spread over the whole region, at every scale the sim uses.
  const rng = mulberry(0xc0ffee);
  let worst = 0;
  let n = 0;
  for (let i = 0; i < 5000; i++) {
    const lat = 46.6 + rng() * 1.5;
    const lon = -122.9 + rng() * 1.4;
    const p = C.llToLocal(lat, lon);
    const d = Math.abs(terrain.getHeightAt(p.x, p.z) - E.getElevationLocal(p.x, p.z));
    if (d > worst) worst = d;
    n++;
  }
  ok('getHeightAt === getElevationLocal, exactly', worst === 0, `worst ${worst} m of ${n} samples`);

  for (const [label, ll] of [
    ['KBFI', KBFI],
    ['KSEA', KSEA],
    ['Mount Rainier', RAINIER],
    ['Elliott Bay', ELLIOTT_BAY],
  ]) {
    const p = C.llToLocal(ll[0], ll[1]);
    const a = terrain.getHeightAt(p.x, p.z);
    const b = E.getElevationLocal(p.x, p.z);
    ok(`${label} agrees`, a === b, `${a.toFixed(2)} m`);
  }
}

// ---------------------------------------------------------------------------
head('3. §2.15 — every mesh is named, so the shadow tagger can classify it');
{
  const kids = terrain.group.children;
  const unnamed = kids.filter((c) => !c.name || !c.name.startsWith('terrain-'));
  ok('every child of the terrain group is named terrain-*', unnamed.length === 0, `${kids.length} children`);
  ok('the sea plane is named terrain-sea', kids.some((c) => c.name === 'terrain-sea'));
  ok('the lakes mesh is named terrain-lakes', kids.some((c) => c.name === 'terrain-lakes'));

  park(...KBFI, 200);
  const nodes = drawnNodes();
  ok('every drawn node receives shadow', nodes.every((m) => m.receiveShadow === true), `${nodes.length} nodes`);
  ok(
    'node names are terrain-<level>/<x>/<z>, never bare',
    nodes.every((m) => /^terrain-\d+\/-?\d+\/-?\d+$/.test(m.name)),
    nodes[0]?.name,
  );
}

// ---------------------------------------------------------------------------
head('4. LOD selection is stable — a parked aeroplane does not flicker');
{
  // THE limit-cycle guard. An error metric that reads anything the previous
  // pass decided oscillates here and nowhere else.
  await settle(...KBFI, 200);

  // Two signatures, and the second one is the one that took work to get right.
  // NAMES catch the LOD oscillating between levels. MESH IDENTITIES also catch
  // a node being torn down and rebuilt in place at the same level — which is
  // what a revalidation predicate that can never be satisfied does, and it is
  // invisible to a name comparison because the name does not change. That bug
  // was live in this file's first draft: every mountainous node compared a
  // fresh 17x17 probe against the geometry's bounding box, found a difference
  // forever, and rebuilt itself every frame while the LOD sat pinned at 32 m
  // cells because the rebuilds ate the budget that would have built the
  // children.
  const names = () => drawnNodes().map((m) => m.name).sort().join('|');
  const ids = () => drawnNodes().map((m) => m.id).sort((a, b) => a - b).join(',');
  let n30 = '';
  let n120 = '';
  let n399 = '';
  let i30 = '';
  let i399 = '';
  for (let f = 1; f <= 399; f++) {
    terrain.update(camera);
    if (f === 30) {
      n30 = names();
      i30 = ids();
    }
    if (f === 120) n120 = names();
    if (f === 399) {
      n399 = names();
      i399 = ids();
    }
  }
  const count = n399.split('|').length;
  ok('frame 30 === frame 120', n30 === n120, `${n30.split('|').length} nodes`);
  ok('frame 120 === frame 399', n120 === n399, `${count} nodes`);
  ok('the selection is not empty', count > 100, `${count} nodes`);
  ok(
    'and nothing was rebuilt over 369 settled frames',
    i30 === i399,
    'same mesh objects, not just the same names',
  );
}

// ---------------------------------------------------------------------------
head('5. The finest node is tied to the DATA, not to a constant');
{
  // Inside the z=14 Seattle inset (6.47 m/px) 4 m cells are justified.
  await settle(...KBFI, 65);
  const inset = terrain.stats();
  ok('4 m cells inside the z=14 inset', inset.finestCellM === 4, `${inset.finestCellM} m at KBFI 65 m`);

  // Out over the Cascades the finest baked layer is z=13 (12.95 m/px), so
  // subdividing to 4 m would be inventing terrain. §1.5.
  await settle(...CASCADE_CREST, 2000);
  const crest = terrain.stats();
  ok(
    'no 4 m cells where only z=13 is baked',
    crest.finestCellM >= 8,
    `${crest.finestCellM} m over the Cascade crest`,
  );
  ok(
    'but it does reach the 8-16 m the z=13 data supports',
    crest.finestCellM <= 16,
    `${crest.finestCellM} m`,
  );

  await settle(...RAINIER, 3000);
  const rainier = terrain.stats();
  ok('same over Rainier', rainier.finestCellM >= 8, `${rainier.finestCellM} m`);
  // THE REGRESSION GUARD FOR THE STALE-NODE BUG. Before the field epoch existed
  // this read 64 m: the nodes covering the mountain were measured at boot,
  // 84 km away, against the 51.8 m/px pinned base, and nothing ever re-measured
  // them. Rainier was drawn from the base layer with 12.95 m/px data resident
  // underneath it.
  ok(
    'Mount Rainier reaches 16 m cells, not the 64 m of a base-layer measurement',
    rainier.finestCellM <= 16,
    `${rainier.finestCellM} m`,
  );
}

// ---------------------------------------------------------------------------
head('6. Budgets — the error metric did not run away with the cache');
const CAMERAS = [
  ['KBFI 65 m', ...KBFI, 65],
  ['KBFI 600 m', ...KBFI, 600],
  ['Elliott Bay 1500 m', ...ELLIOTT_BAY, 1500],
  ['Rainier 3000 m', ...RAINIER, 3000],
  ['Cascades 2000 m', ...CASCADE_CREST, 2000],
];
{
  let maxDrawn = 0;
  let maxTri = 0;
  for (const [label, lat, lon, alt] of CAMERAS) {
    await settle(lat, lon, alt);
    const s = terrain.stats();
    maxDrawn = Math.max(maxDrawn, s.drawn);
    maxTri = Math.max(maxTri, s.triangles);
    const levels = s.byLevel.map((n, i) => (n ? `L${i}:${n}` : null)).filter(Boolean).join(' ');
    console.log(
      `       ${label.padEnd(20)} ${String(s.drawn).padStart(4)} drawn  ` +
        `${(s.triangles / 1e6).toFixed(2)}M tri  finest ${s.finestCellM} m`,
    );
    console.log(`       ${''.padEnd(20)} ${levels}`);
  }
  // Round 1's ring LOD drew ~590; the error metric draws ~28% more by design.
  // 1,100 is the point at which the draw-call count stops being defensible.
  ok('drawn nodes stay under the 1,100 budget', maxDrawn < 1100, `worst ${maxDrawn}`);
  ok('selected triangles stay under 12M', maxTri < 12e6, `worst ${(maxTri / 1e6).toFixed(2)}M`);
  ok('the cache is bounded', terrain.stats().built < 2600, `${terrain.stats().built} built`);
}

// ---------------------------------------------------------------------------
head('7. The LOD spans levels — it is a tree, not one ring');
{
  await settle(...KBFI, 600);
  const s = terrain.stats();
  const used = s.byLevel.filter((n) => n > 0).length;
  ok('at least six levels are drawn at once', used >= 6, `${used} levels populated`);
  ok('the coarse levels are not starved', s.byLevel.slice(0, 5).reduce((a, b) => a + b, 0) > 0);
  ok('tau is the documented 0.003 rad', Math.abs(s.tau - 0.003) < 1e-9, `tau ${s.tau}`);
}

// ---------------------------------------------------------------------------
head('8. The drawn surface tracks the field the wheels use');
{
  // ---------------------------------------------------------------------
  // THE HEADLINE REGRESSION GUARD.
  //
  // §1.4 accepts that the drawn triangles chord across a cell — that is a
  // discretisation, it is bounded by the cell size, and it shrinks as the LOD
  // descends. What it does NOT accept is the mesh being built from a DIFFERENT,
  // COARSER DEM than the one the flight model samples, which is what paging
  // introduced and what nothing detected until this harness existed.
  //
  // Measured with the fix out (nodes never re-measured after creation):
  //
  //     camera                 RMS within 3 km   worst
  //     Mount Rainier 3,000 m       23.334 m     140.9 m
  //     Cascades 2,000 m            11.910 m     138.2 m
  //
  // Measured with it in: 0.283 m and 0.164 m. Seattle was always fine — the
  // spawn is there, so those nodes were created against good data — which is
  // exactly why this had to be measured at the mountains and not at the field.
  // ---------------------------------------------------------------------
  for (const [label, lat, lon, alt] of CAMERAS) {
    const p = await settle(lat, lon, alt);
    const near = meshVsField(drawnNodes(), p, 3000, 20000);
    const wide = meshVsField(drawnNodes(), p, 8000, 20000);
    console.log(
      `       ${label.padEnd(20)} 3 km: RMS ${near.rms.toFixed(3)} m worst ${near.worst.toFixed(1)} m` +
        `   8 km: RMS ${wide.rms.toFixed(3)} m worst ${wide.worst.toFixed(1)} m`,
    );
    // 3 km is where the LOD has descended as far as the data allows, so 1 m is
    // a tight bound and every camera measures 0.16-0.29 m against it.
    ok(`${label} — drawn vs field within 3 km, RMS under 1 m`, near.rms < 1, `${near.rms.toFixed(3)} m`);
    // At 8 km the LOD has deliberately coarsened, so the bound is looser.
    // Measured across all five cameras: 0.229-0.573 m, the worst of them being
    // Mount Rainier, which is the steepest thing in the region. 2 m.
    ok(`${label} — and within 8 km, RMS under 2 m`, wide.rms < 2, `${wide.rms.toFixed(3)} m`);
  }
}

// ---------------------------------------------------------------------------
head('9. The field epoch — the signal the repair is driven by');
{
  const before = E.getRegionStats().fieldEpoch;
  ok('elevation.js publishes a field epoch', Number.isFinite(before), `${before}`);
  await settle(...RAINIER, 3000);
  await E.warmAt(...KSEA);
  await E.flushPaging();
  const after = E.getRegionStats().fieldEpoch;
  ok('it moves when tiles page in and out', after > before, `${before} -> ${after}`);
  ok('and it only ever goes up', after >= before);
}

// ---------------------------------------------------------------------------
head('10. Geometry sanity — nothing NaN, nothing inside out, skirts down');
{
  await settle(...RAINIER, 3000);
  let nan = 0;
  let badNormal = 0;
  let skirtUp = 0;
  let morphBad = 0;
  let checked = 0;
  for (const mesh of drawnNodes().slice(0, 120)) {
    const g = mesh.geometry;
    const pos = g.attributes.position.array;
    const nrm = g.attributes.normal.array;
    const mrp = g.attributes.aMorph.array;
    for (let v = 0; v < pos.length; v += 3) {
      if (!Number.isFinite(pos[v]) || !Number.isFinite(pos[v + 1]) || !Number.isFinite(pos[v + 2])) nan++;
      if (!Number.isFinite(mrp[v]) || !Number.isFinite(mrp[v + 1])) nan++;
    }
    // Int16 normalised: +Y must dominate, a terrain normal never points down.
    for (let v = 1; v < nrm.length; v += 3) if (nrm[v] <= 0) badNormal++;
    // aMorph.y is the node's own switch distance; it gates the geomorph and a
    // zero would snap every LOD transition instead of blending it.
    for (let v = 1; v < mrp.length; v += 3) if (!(mrp[v] > 0)) morphBad++;
    // The skirt block is the tail: 4,225..4,480, each pushed straight down.
    for (let s = 4225; s < 4481; s++) {
      if (mrp[s * 3 + 2] <= 0) skirtUp++;
    }
    checked++;
  }
  ok('no non-finite vertex or morph value', nan === 0, `${checked} nodes scanned`);
  ok('every normal points up', badNormal === 0, `${badNormal} bad`);
  ok('every morph window is positive', morphBad === 0, `${morphBad} bad`);
  ok('every skirt vertex hangs downward', skirtUp === 0, `${skirtUp} bad`);
}

// ---------------------------------------------------------------------------
head('11. Flying does not leak — a long transit stays inside the cache');
{
  // KBFI -> Rainier and back, in 24 hops, the way gotoPlace + a cruise do it.
  const before = terrain.stats().built;
  let peak = 0;
  for (let i = 0; i <= 24; i++) {
    const f = i <= 12 ? i / 12 : (24 - i) / 12;
    const lat = KBFI[0] + (RAINIER[0] - KBFI[0]) * f;
    const lon = KBFI[1] + (RAINIER[1] - KBFI[1]) * f;
    park(lat, lon, 1500, 3);
    peak = Math.max(peak, terrain.stats().built);
  }
  const after = terrain.stats().built;
  ok('the built-node cache has a ceiling', peak < 2600, `peak ${peak} nodes`);
  ok('it comes back down', after <= peak, `${before} -> peak ${peak} -> ${after}`);
  const dem = E.getRegionStats();
  ok('the DEM pager reported no cap violation', dem.capViolations === 0, `${dem.capViolations}`);
}

// ---------------------------------------------------------------------------
head('12. converge() — a teleport lands on the real ground');
{
  const p = C.llToLocal(...RAINIER);
  terrain.converge?.(p.x, 3000, p.z);
  ok(
    'the ground under a teleport is the field, not the base layer',
    terrain.getHeightAt(p.x, p.z) === E.getElevationLocal(p.x, p.z),
    `${terrain.getHeightAt(p.x, p.z).toFixed(1)} m`,
  );
  ok('converge() is idempotent', (() => {
    const a = terrain.getHeightAt(p.x, p.z);
    terrain.converge?.(p.x, 3000, p.z);
    return terrain.getHeightAt(p.x, p.z) === a;
  })());
}

// ---------------------------------------------------------------------------
// 13. The node cache is the largest heap term in the sim, and it now knows
//     which tier it is on. The failure this guards is not a slow frame: a cap
//     under the working set makes visit() refuse to subdivide, and the LOD
//     settles on a COARSER surface than lodQuality asked for, silently.
// ---------------------------------------------------------------------------
head('13. The node cache scales with the tier — and does not cost a node');
{
  const s1 = terrain.stats();
  ok(
    'desktop keeps the 1,400-node cache it was tuned with',
    s1.cacheCap === 1400 && s1.evictSlack === 120,
    `cap ${s1.cacheCap} + ${s1.evictSlack}`,
  );
  ok(
    'and its ceiling is still ~195 MiB of vertex buffers',
    Math.abs(s1.cacheCapBytes / 1048576 - 194.9) < 1,
    `${(s1.cacheCapBytes / 1048576).toFixed(1)} MiB`,
  );

  // A second terrain at the phone tier's lodQuality. Same DEM, same origin.
  const phoneScene = new THREE.Scene();
  const phone = await createTerrain(phoneScene, { lodQuality: 0.4 });
  const ps = phone.stats();
  ok(
    'the phone tier gets a smaller cache',
    ps.cacheCap === 560 && ps.cacheCap < s1.cacheCap,
    `cap ${ps.cacheCap} at lodQuality ${ps.lodQuality}`,
  );
  ok(
    'which is a 117 MiB smaller ceiling — the biggest single heap cut available',
    ps.cacheCapBytes < s1.cacheCapBytes - 110 * 1048576,
    `${(ps.cacheCapBytes / 1048576).toFixed(1)} MiB vs ${(s1.cacheCapBytes / 1048576).toFixed(1)}`,
  );

  const phoneCam = new THREE.PerspectiveCamera(60, 375 / 812, 0.35, 300000);
  const parkPhone = (lat, lon, altM, frames = 6) => {
    const q = C.llToLocal(lat, lon);
    phoneCam.position.set(q.x, altM, q.z);
    phoneCam.updateMatrixWorld(true);
    for (let i = 0; i < frames; i++) phone.update(phoneCam);
  };

  // THE SELECTION MUST NOT MOVE. Peak drawn over this tour is 220 with the cap
  // live and 220 with eviction disabled entirely — measured both ways. A cap
  // of 407 (what the q^1.35 curve alone would give) drops it to 178.
  let peakDrawn = 0;
  let peakBuilt = 0;
  for (let i = 0; i <= 12; i++) {
    const f = i / 12;
    parkPhone(KBFI[0] + (RAINIER[0] - KBFI[0]) * f, KBFI[1] + (RAINIER[1] - KBFI[1]) * f, 1500, 3);
    peakDrawn = Math.max(peakDrawn, phone.stats().drawn);
    peakBuilt = Math.max(peakBuilt, phone.stats().built);
  }
  for (const [lat, lon] of [KBFI, KSEA, ELLIOTT_BAY, CASCADE_CREST, RAINIER]) {
    for (const alt of [200, 1200, 3400, 6000]) {
      parkPhone(lat, lon, alt, 8);
      peakDrawn = Math.max(peakDrawn, phone.stats().drawn);
      peakBuilt = Math.max(peakBuilt, phone.stats().built);
    }
  }
  ok(
    'the cap bounds what is KEPT, not what is SELECTED',
    peakDrawn >= 220,
    `peak drawn ${peakDrawn} (uncapped: 220)`,
  );
  ok(
    'and it is actually enforced over a full tour',
    peakBuilt <= ps.cacheCap + ps.evictSlack + 8,
    `peak built ${peakBuilt} against ${ps.cacheCap} + ${ps.evictSlack}`,
  );

  // Stationary means stationary. A cache under the working set does not
  // oscillate visibly frame to frame, but it does hunt; a single value over
  // 20 frames at the worst camera is the guard.
  parkPhone(RAINIER[0] + 0.15, RAINIER[1] + 0.15, 3400, 60);
  const seq = [];
  for (let i = 0; i < 40; i++) {
    phone.update(phoneCam);
    seq.push(phone.stats().drawn);
  }
  const seen = new Set(seq);
  ok(
    'a parked phone-tier camera selects one node set and holds it',
    seen.size === 1,
    `${seq[0]} for 40 frames` + (seen.size === 1 ? '' : ` — saw ${[...seen].join(', ')}`),
  );

  // §1.4 does not bend for a tier.
  const rp = C.llToLocal(...RAINIER);
  ok(
    'and the ground is still the field at every tier',
    phone.getHeightAt(rp.x, rp.z) === E.getElevationLocal(rp.x, rp.z) &&
      phone.getHeightAt(rp.x, rp.z) === terrain.getHeightAt(rp.x, rp.z),
    `${phone.getHeightAt(rp.x, rp.z).toFixed(2)} m at both tiers`,
  );
  phone.dispose();
}

console.log(`\n       terrain built in ${buildMs} ms\n`);
if (failures) {
  console.log(`\x1b[31m${failures} terrain check(s) FAILED\x1b[0m\n`);
  process.exit(1);
}
console.log('\x1b[32mall terrain checks passed\x1b[0m\n');

// ===========================================================================
// helpers
// ===========================================================================

/** Deterministic PRNG — a harness that samples randomly must sample the same. */
function mulberry(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Sample the drawn surface inside a disc around the camera and compare it
 * against the field.
 *
 * SAMPLED BY AREA AROUND THE CAMERA, NOT BY NODE. Picking a random node and a
 * random point inside it weights every node equally, and 90% of the drawn set
 * is distant backdrop with 512 m cells — so that version reports the error of
 * the horizon, which is both enormous and completely uninteresting, and it
 * reports the same enormous number whether the near field is perfect or broken.
 * Sampling uniformly over ground area within a radius measures what is actually
 * under and in front of the aeroplane.
 *
 * For each point: take the FINEST drawn node containing it — that is the one
 * the rasteriser will have drawn there, since a node and its children are never
 * both emitted — locate the cell, and bilinearly interpolate the four lattice
 * heights, which is what the two triangles do to within their diagonal.
 */
function meshVsField(meshes, centre, radius, samples) {
  const rng = mulberry(0x5eed);
  if (!meshes.length) return { rms: 0, worst: 0, n: 0 };
  // Hoisted out of the sample loop: the geometry lookups are the expensive part.
  const nodes = meshes.map((m) => ({
    bb: m.geometry.boundingBox,
    pos: m.geometry.attributes.position.array,
    size: m.geometry.boundingBox.max.x - m.geometry.boundingBox.min.x,
  }));
  let sum2 = 0;
  let worst = 0;
  let n = 0;
  for (let i = 0; i < samples; i++) {
    // sqrt for a uniform disc — without it every sample crowds the centre.
    const a = rng() * Math.PI * 2;
    const r = Math.sqrt(rng()) * radius;
    const x = centre.x + Math.cos(a) * r;
    const z = centre.z + Math.sin(a) * r;

    let best = null;
    for (let k = 0; k < nodes.length; k++) {
      const nd = nodes[k];
      if (x < nd.bb.min.x || x >= nd.bb.max.x || z < nd.bb.min.z || z >= nd.bb.max.z) continue;
      if (!best || nd.size < best.size) best = nd;
    }
    if (!best) continue; // outside the drawn set: open water, or past the region

    const cell = best.size / 64;
    const fx = (x - best.bb.min.x) / cell;
    const fz = (z - best.bb.min.z) / cell;
    const i0 = Math.min(Math.floor(fx), 63);
    const j0 = Math.min(Math.floor(fz), 63);
    const tx = fx - i0;
    const tz = fz - j0;
    const at = (ii, jj) => best.pos[(jj * 65 + ii) * 3 + 1];
    const h =
      at(i0, j0) * (1 - tx) * (1 - tz) +
      at(i0 + 1, j0) * tx * (1 - tz) +
      at(i0, j0 + 1) * (1 - tx) * tz +
      at(i0 + 1, j0 + 1) * tx * tz;

    const d = h - E.getElevationLocal(x, z);
    sum2 += d * d;
    if (Math.abs(d) > worst) worst = Math.abs(d);
    n++;
  }
  return { rms: n ? Math.sqrt(sum2 / n) : 0, worst, n };
}
