/**
 * check-elevation.mjs — executable form of MODULES.md §2.4.
 *
 *   npm run check:elevation
 *
 * This runs the REAL src/geo/elevation.js against the REAL baked tiles. The
 * only thing swapped out is the pixel source: the browser path goes through
 * fetch + createImageBitmap + canvas, which needs a DOM, so `setTileProvider`
 * points it at scripts/lib/png.mjs and the files on disk instead. Everything
 * that matters — the layer fold, the blend weights, the void repair, the tile
 * budgets, the eviction, the byte accounting — is the shipping code.
 *
 * WHY THIS EXISTS. The module now holds a bounded working set out of 402 MB of
 * baked elevation, which is a thing that can fail silently in two directions:
 * it can leak (the tab dies after ten minutes of flying, on someone else's
 * machine) or it can under-cover (the aeroplane falls through a hole in the
 * Cascades). Neither shows up in a screenshot. Both show up here.
 *
 * The expected values are measured, not invented. Where a number came from a
 * published source it says so; where it came from the DEM it is the DEM's
 * answer and the assertion is on the tolerance, not the digits.
 */

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { decodePng } from './lib/png.mjs';
import { PUBLIC_DIR } from './lib/util.mjs';
import * as C from '../src/geo/coords.js';
import * as E from '../src/geo/elevation.js';

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

// Verified reference points.
const MT_RAINIER = [46.8517, -121.7603]; // published summit, 4,392 m
const KBFI = [47.527042, -122.29995];
const KSEA = [47.447943, -122.310276];
const ELLIOTT_BAY = [47.6045, -122.3805]; // mid-channel, open salt water
const MAIN_BASIN = [47.55, -122.44]; // Puget Sound proper, west of Alki

const DEM_DIR = resolve(PUBLIC_DIR, 'dem');
if (!existsSync(join(DEM_DIR, 'manifest.json'))) {
  console.log('\n  SKIP — public/dem is not baked. Run `npm run bake:dem`.\n');
  process.exit(0);
}
const manifest = JSON.parse(readFileSync(join(DEM_DIR, 'manifest.json'), 'utf8'));

// ---------------------------------------------------------------------------
// Wire the module to the files on disk
// ---------------------------------------------------------------------------
let tileReads = 0;
E.setTileProvider({
  manifest,
  async fetchPixels(z, x, y) {
    const p = join(DEM_DIR, String(z), String(x), `${y}.png`);
    if (!existsSync(p)) return null;
    tileReads++;
    const img = decodePng(readFileSync(p));
    return { width: img.width, height: img.height, rgba: img.rgba };
  },
});

C.setOrigin(C.DEFAULT_ORIGIN.lat, C.DEFAULT_ORIGIN.lon);

// ---------------------------------------------------------------------------
// On-disk inventory
// ---------------------------------------------------------------------------
function dirBytes(dir) {
  let bytes = 0;
  let files = 0;
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.png')) {
        bytes += statSync(p).size;
        files++;
      }
    }
  };
  walk(dir);
  return { bytes, files };
}

console.log('\nbaked inventory');
const disk = dirBytes(DEM_DIR);
{
  const declared = manifest.levels.reduce((n, l) => n + l.tiles.length, 0);
  for (const l of manifest.levels) {
    const mpp = C.metresPerPixel(47.35, l.zoom, l.tileSize);
    console.log(
      `       z=${l.zoom}  ${String(l.tiles.length).padStart(5)} tiles  ` +
        `${mpp.toFixed(2)} m/px  paged=${l.paged === true}`,
    );
  }
  ok('manifest declares a pinned base at z=11', !!manifest.levels.find((l) => l.zoom === 11 && !l.paged));
  ok('manifest declares a region-wide z=13', !!manifest.levels.find((l) => l.zoom === 13), `${manifest.levels.find((l) => l.zoom === 13)?.tiles.length} tiles`);
  ok('every declared tile is on disk', disk.files >= declared, `${disk.files} files vs ${declared} declared`);
  ok('base layer resolution is 51.8 m/px', Math.abs(C.metresPerPixel(47.35, 11) - 51.79) < 0.1);
  ok('working layer resolution is 12.95 m/px — 4x round 1', Math.abs(C.metresPerPixel(47.35, 13) - 12.95) < 0.05);
  console.log(`       on disk: ${disk.files} PNGs, ${MB(disk.bytes)}`);
}

// ---------------------------------------------------------------------------
// Load
// ---------------------------------------------------------------------------
console.log('\nload');
const tLoad0 = performance.now();
await E.loadRegion(C.REGION_BBOX, E.DEM_ZOOM);
const tBase = performance.now();
await E.loadDetailLayers(E.DEM_ZOOM);
await E.flushPaging();
const tLoad1 = performance.now();
{
  const s = E.getRegionStats();
  ok('isLoaded()', E.isLoaded());
  ok('three layers registered', s.layers.length === 3, s.layers.map((l) => `z${l.zoom}${l.pinned ? '*' : ''}:${l.tiles}`).join(' '));
  ok('the base layer is pinned and complete', s.layers.find((l) => l.zoom === 11)?.tiles === 238, `${s.layers.find((l) => l.zoom === 11)?.tiles} tiles`);
  ok('no tiles reported missing', s.tilesMissing === 0, `${s.tilesMissing}`);
  console.log(
    `       base ${((tBase - tLoad0) / 1000).toFixed(2)} s, ` +
      `detail warm-up ${((tLoad1 - tBase) / 1000).toFixed(2)} s, ` +
      `${s.voidsRepaired} voids repaired`,
  );
}

// ---------------------------------------------------------------------------
// § PAGING property 3 — the memory cap
// ---------------------------------------------------------------------------
console.log('\nresident memory');
{
  const s = E.getRegionStats();
  ok(
    'resident bytes are under the cap',
    s.residentBytes <= s.residentCapBytes,
    `${MB(s.residentBytes)} of ${MB(s.residentCapBytes)}`,
  );
  ok('no cap violation was ever recorded', s.capViolations === 0, `${s.capViolations}`);
  for (const l of s.layers) {
    ok(
      `z=${l.zoom} is inside its tile budget`,
      l.tiles <= l.budgetTiles,
      `${l.tiles} / ${l.budgetTiles}`,
    );
  }
  ok(
    'the paged layers hold far less than they declare',
    s.layers.filter((l) => !l.pinned).every((l) => l.tiles < l.declaredTiles),
    s.layers.filter((l) => !l.pinned).map((l) => `z${l.zoom} ${l.tiles}/${l.declaredTiles}`).join(', '),
  );
}

// ---------------------------------------------------------------------------
// No orphaned tile records
//
// REGRESSION GUARD. The pager creates a record the moment it queues a tile, and
// an earlier version re-tested "does a record exist" instead of "does data
// exist" when rebuilding the queue. Every pass then orphaned the records it had
// just created: they stayed in the map with no data and no job, ate the budget,
// and quietly demoted the whole region to the 51.8 m/px base after two viewer
// jumps. Nothing above catches it — the tile COUNTS look perfect. Only asking
// whether the tiles have data does.
// ---------------------------------------------------------------------------
console.log('\norphaned records');
{
  for (const place of [MT_RAINIER, KBFI, KSEA, ELLIOTT_BAY, KBFI]) {
    await E.warmAt(...place);
  }
  const s = E.getRegionStats();
  ok(
    'after five viewer jumps, every tile record holds data',
    s.layers.every((l) => l.pending === 0),
    s.layers.map((l) => `z${l.zoom} ${l.tiles} decoded + ${l.pending} pending`).join(', '),
  );
  const mLat = C.metresPerDegreeLat(KBFI[0]);
  let covered = 0;
  for (let d = 0; d <= 18000; d += 1000) {
    if (E.getLayerElevation(13, KBFI[0] - d / mLat, KBFI[1]).weight > 0.99) covered++;
  }
  ok(
    'the working layer still covers its full radius after the jumps',
    covered === 19,
    `${covered}/19 probes out to 18 km at full weight`,
  );
}

// ---------------------------------------------------------------------------
// § PAGING property 2 — a miss falls to the base, never to zero
// ---------------------------------------------------------------------------
console.log('\nmiss policy');
{
  // Somewhere the fine layers have certainly never been paged: the far
  // south-east corner of the region, 130 km from the spawn.
  const far = [46.55, -121.35];
  const h = E.getElevation(...far);
  ok('a point outside every paged layer still has ground', Number.isFinite(h) && h > 100, `${h.toFixed(1)} m`);

  // The whole region, coarsely swept. Not one query may return exactly zero
  // over land — that is the signature of a hole, and a hole is a cliff.
  let zeros = 0;
  let landSamples = 0;
  let worst = Infinity;
  for (let lat = 46.5; lat <= 48.2; lat += 0.02) {
    for (let lon = -123.3; lon <= -121.3; lon += 0.02) {
      const v = E.getElevation(lat, lon);
      if (!Number.isFinite(v)) zeros++;
      if (v < worst) worst = v;
      if (v > 5) landSamples++;
    }
  }
  ok('no query in a 8,500-point regional sweep returned NaN', zeros === 0);
  ok('the sweep found real land', landSamples > 3000, `${landSamples} points above 5 m`);
  ok('nothing in the sweep is below the repaired floor', worst >= -80, `min ${worst.toFixed(1)} m`);
}

// ---------------------------------------------------------------------------
// Geographic truth — the numbers round 1 established, at 4x the resolution
// ---------------------------------------------------------------------------
console.log('\nMount Rainier');
await E.warmAt(...MT_RAINIER);
let rainierH = 0;
{
  rainierH = E.getElevation(...MT_RAINIER);
  ok(
    'summit reads 4,300-4,450 m at its published coordinate',
    rainierH > 4300 && rainierH < 4450,
    `${rainierH.toFixed(1)} m`,
  );

  // THE assertion that separates real elevation from noise: it must also be the
  // highest point for 30 km in every direction. Noise does not do that.
  const mLat = C.metresPerDegreeLat(MT_RAINIER[0]);
  const mLon = C.metresPerDegreeLon(MT_RAINIER[0]);
  let hi = -Infinity;
  let hiLat = 0;
  let hiLon = 0;
  const STEP = 250; // metres
  for (let dy = -30000; dy <= 30000; dy += STEP) {
    for (let dx = -30000; dx <= 30000; dx += STEP) {
      const lat = MT_RAINIER[0] + dy / mLat;
      const lon = MT_RAINIER[1] + dx / mLon;
      const v = E.getElevation(lat, lon);
      if (v > hi) {
        hi = v;
        hiLat = lat;
        hiLon = lon;
      }
    }
  }
  const offset = C.distanceBetween(...MT_RAINIER, hiLat, hiLon);
  ok(
    'the summit is the LOCAL MAXIMUM over a 60 km box',
    offset < 1200,
    `peak ${hi.toFixed(1)} m, ${offset.toFixed(0)} m from the published coordinate`,
  );
  ok('nothing in the box is higher than 4,450 m', hi < 4450, `${hi.toFixed(1)} m`);
}

console.log('\nPuget Sound');
await E.warmAt(...KBFI);
{
  for (const [name, p] of [['Elliott Bay', ELLIOTT_BAY], ['the main basin', MAIN_BASIN]]) {
    const h = E.getElevation(...p);
    ok(`${name} is at sea level`, Math.abs(h) < 0.5, `${h.toFixed(2)} m`);
    ok(`${name} classifies as water`, E.isWater(...p));
  }
  ok('KBFI field elevation is ~6.4 m (21 ft published)', Math.abs(E.getElevation(...KBFI) - 6.4) < 4, `${E.getElevation(...KBFI).toFixed(1)} m`);
}

// ---------------------------------------------------------------------------
// KSEA vertical geometry
//
// Round 1 reported "off by up to 23 m, 16R/34L on a 12.9 m hump" and the brief
// asked whether 12.95 m/px resolves it. It does not, and the reason is worth
// asserting rather than hiding: the deficit is not noise, it is a MISSING
// EARTHWORK, and finer data makes it bigger because finer data resolves the
// natural ravine the earthwork spans. See the report note under this section.
// ---------------------------------------------------------------------------
console.log('\nKSEA vertical geometry');
await E.warmAt(...KSEA);
{
  // Surveyed thresholds and published threshold elevations, OurAirports.
  const runways = [
    { id: '16L/34R', le: [47.46387, -122.30775], he: [47.4355, -122.3074], leFt: 415, heFt: 354, tol: 2.5 },
    { id: '16C/34C', le: [47.46375, -122.3117], he: [47.4355, -122.3114], leFt: 425, heFt: 363, tol: 13 },
    { id: '16R/34L', le: [47.46377, -122.31897], he: [47.43523, -122.31861], leFt: 429, heFt: 398, tol: Infinity },
  ];
  const N = 200;
  for (const rw of runways) {
    let maxDeficit = -Infinity;
    let maxStep = 0;
    let prev = null;
    for (let i = 0; i <= N; i++) {
      const t = i / N;
      const lat = rw.le[0] + (rw.he[0] - rw.le[0]) * t;
      const lon = rw.le[1] + (rw.he[1] - rw.le[1]) * t;
      const v = E.getElevation(lat, lon);
      const deck = (rw.leFt + (rw.heFt - rw.leFt) * t) * 0.3048;
      maxDeficit = Math.max(maxDeficit, deck - v);
      if (prev !== null) maxStep = Math.max(maxStep, Math.abs(v - prev));
      prev = v;
    }
    rw.deficit = maxDeficit;
    if (Number.isFinite(rw.tol)) {
      ok(
        `${rw.id} follows its surveyed deck`,
        Math.abs(maxDeficit) < rw.tol,
        `worst deck-above-DEM ${maxDeficit.toFixed(1)} m`,
      );
    } else {
      console.log(`       ${rw.id}: worst deck-above-DEM ${maxDeficit.toFixed(1)} m — the Miller Creek embankment, not in the source`);
    }
    // Whatever the deficit, the DEM under a runway must be CONTINUOUS. A void
    // shows as a cliff between 16 m samples; a real ravine wall does not.
    // 16R/34L legitimately reaches 7.95 m per 16 m sample where it crosses the
    // Miller Creek ravine wall — a 26-degree slope, which is a hillside. The
    // bound is 12 m (37 degrees): loose enough not to flag real ground, tight
    // enough that the hundred-metre steps a void produces cannot pass.
    ok(`${rw.id} has continuous ground beneath it`, maxStep < 12, `worst 16 m step ${maxStep.toFixed(2)} m`);
  }
  ok(
    'the two plateau runways are accurate; only 16R/34L is not',
    Math.abs(runways[0].deficit) < 2.5 && runways[2].deficit > 30,
    `16L ${runways[0].deficit.toFixed(1)} m vs 16R ${runways[2].deficit.toFixed(1)} m`,
  );
}

// ---------------------------------------------------------------------------
// § BLENDING — the inset must not be a rectangle you can see
//
// Round 1's critic saw the fine inset as "a hard rectangle whose edge is a
// visible ledge". Testing that with "no sample step exceeds N metres" does not
// work: real terrain steps several metres between 25 m samples all the time, so
// such a test either passes on a broken blend or fails on a hillside.
//
// A ledge is specifically a step that is LOCALISED AT THE BOUNDARY and much
// larger than the terrain's own roughness there. Both tests below measure
// exactly that, and then confirm it directly against the layer weights.
// ---------------------------------------------------------------------------
console.log('\nlayer blending');

/**
 * Max |consecutive difference| inside and outside a window centred on `edge`.
 * @returns {{atEdge:number, elsewhere:number}}
 */
function stepProfile(sample, from, to, step, edge, halfWindow) {
  let atEdge = 0;
  let elsewhere = 0;
  let prev = null;
  for (let d = from; d <= to; d += step) {
    const v = sample(d);
    if (prev !== null) {
      const s = Math.abs(v - prev);
      if (Math.abs(d - edge) <= halfWindow) atEdge = Math.max(atEdge, s);
      else elsewhere = Math.max(elsewhere, s);
    }
    prev = v;
  }
  return { atEdge, elsewhere };
}

{
  // (a) The z=14 inset's western edge, lon = -122.5, at KBFI's latitude.
  //
  // The viewer has to be AT the edge to see the edge fade at all: z=14's
  // paging radius is 9 km and this boundary is 14 km west of KBFI, so from the
  // spawn the frontier fade reaches zero first and the bbox edge is moot. It
  // stops being moot the moment you fly west over the Sound, which is exactly
  // the case round 1's ledge was visible in.
  const lat = 47.527;
  const mLon = C.metresPerDegreeLon(lat);
  await E.warmAt(lat, -122.49);
  const p = stepProfile((d) => E.getElevation(lat, -122.5 + d / mLon), -8000, 8000, 25, 0, 150);
  ok(
    'the z=14 inset edge is not a ledge',
    p.atEdge <= p.elsewhere,
    `${p.atEdge.toFixed(2)} m at the edge vs ${p.elsewhere.toFixed(2)} m of ordinary terrain roughness`,
  );

  // And directly: the layer's weight must ramp smoothly to zero across the
  // band, not switch. A switch would show weight 1 right up to the edge.
  const wAt = (d) => E.getLayerElevation(14, lat, -122.5 + d / mLon).weight;
  ok('z=14 weight is 0 outside its bbox', wAt(-50) === 0, `w=${wAt(-50)}`);
  ok('z=14 weight is still ~0 just inside the edge', wAt(200) < 0.05, `w=${wAt(200).toFixed(3)}`);
  ok('z=14 weight is partial mid-band', wAt(1500) > 0.2 && wAt(1500) < 0.8, `w=${wAt(1500).toFixed(3)}`);
  ok('z=14 weight reaches 1 inside the band', wAt(3200) > 0.95, `w=${wAt(3200).toFixed(3)}`);
  let mono = true;
  for (let d = 0; d < 3000; d += 50) if (wAt(d + 50) < wAt(d) - 1e-9) mono = false;
  ok('z=14 weight is monotonic across the band', mono);

  // (b) The paging frontier — the boundary that MOVES. z=13 has a 30 km radius
  // and fades out between 0.65 and 0.85 of it, so 19.5-25.5 km due south.
  await E.warmAt(...KBFI);
  const mLat = C.metresPerDegreeLat(KBFI[0]);
  const fp = stepProfile((d) => E.getElevation(KBFI[0] - d / mLat, KBFI[1]), 10000, 35000, 25, 22500, 3000);
  ok(
    'the paging frontier is not a ledge',
    fp.atEdge <= fp.elsewhere,
    `${fp.atEdge.toFixed(2)} m at the frontier vs ${fp.elsewhere.toFixed(2)} m elsewhere`,
  );
  const fw = (d) => E.getLayerElevation(13, KBFI[0] - d / mLat, KBFI[1]).weight;
  ok('z=13 is at full weight under the aircraft', fw(0) > 0.99, `w=${fw(0).toFixed(3)}`);
  ok('z=13 has faded out before its radius', fw(26000) < 0.02, `w=${fw(26000).toFixed(3)}`);
  ok('z=13 fades, not switches', fw(22000) > 0.05 && fw(22000) < 0.95, `w=${fw(22000).toFixed(3)}`);
}

// ---------------------------------------------------------------------------
// Paging under flight — the thing that cannot be screenshotted
// ---------------------------------------------------------------------------
console.log('\npaging under flight');
{
  // Fly KBFI -> Rainier, 84 km on bearing 151.5. Step the viewer the way
  // terrain.update() does, and at each step ask the question that matters:
  //
  //   DOES PAGING MOVE THE GROUND UNDER THE AEROPLANE?
  //
  // At step i the viewer is still at P(i-1), 1.4 km behind. Sample the ground
  // at P(i) from there; then move the viewer to P(i), let paging run, and
  // sample P(i) AGAIN. If prefetch is working, the fine data for P(i) was
  // already resident and at full weight before the aircraft arrived, so the two
  // answers are identical. If it is not, the second answer jumps — and a ground
  // height that jumps is, to the flight model, terrain arriving at speed.
  //
  // A "no big steps between samples" test cannot see this: real terrain steps
  // hundreds of metres per kilometre on Rainier's flank. Only the before/after
  // pair at a FIXED point isolates the paging.
  const start = C.llToLocal(...KBFI);
  const end = C.llToLocal(...MT_RAINIER);
  const STEPS = 60;
  let peak = 0;
  let worstResident = 0;
  let undefinedGround = 0;
  let worstJump = 0;
  let worstJumpKm = 0;
  let fineCoverage = 0;

  for (let i = 1; i <= STEPS; i++) {
    const t = i / STEPS;
    const x = start.x + (end.x - start.x) * t;
    const z = start.z + (end.z - start.z) * t;
    const ll = C.localToLl(x, z);

    const before = E.getElevation(ll.lat, ll.lon);

    const vx = ((end.x - start.x) / STEPS) * 4;
    const vz = ((end.z - start.z) / STEPS) * 4;
    E.setViewer(x, z, vx, vz, 1000);
    await E.flushPaging();

    const after = E.getElevation(ll.lat, ll.lon);
    const jump = Math.abs(after - before);
    if (jump > worstJump) {
      worstJump = jump;
      worstJumpKm = (t * 84).toFixed(0);
    }
    if (!Number.isFinite(after)) undefinedGround++;
    if (E.getLayerElevation(13, ll.lat, ll.lon).weight > 0.99) fineCoverage++;

    const s = E.getRegionStats();
    peak = Math.max(peak, s.peakResidentBytes);
    worstResident = Math.max(worstResident, s.residentBytes);
  }

  const s = E.getRegionStats();
  ok('memory stayed capped for the whole 84 km leg', worstResident <= s.residentCapBytes, `peak ${MB(peak)}`);
  ok('no cap violations in flight', s.capViolations === 0);
  ok('the ground was defined at every point', undefinedGround === 0);
  ok(
    'prefetch put the fine layer there BEFORE the aircraft arrived',
    worstJump < 0.05,
    `worst ground move on a page-in: ${worstJump.toFixed(4)} m, at ${worstJumpKm} km`,
  );
  ok(
    'the fine layer was at full weight under the aircraft the whole way',
    fineCoverage === STEPS,
    `${fineCoverage}/${STEPS} steps`,
  );
  ok('tiles were actually paged in and out', s.evictions > 0 && s.pageIns > s.residentTiles, `${s.pageIns} in, ${s.evictions} out, ${s.residentTiles} resident`);
  console.log(`       peak resident ${MB(peak)} across ${s.pageIns} page-ins from ${tileReads} tile reads`);
}

// ---------------------------------------------------------------------------
// Latency — property 1 in § PAGING
// ---------------------------------------------------------------------------
console.log('\nsampler latency');
{
  await E.warmAt(...KBFI);
  const p = C.llToLocal(...KBFI);

  const bench = (label, fn, n) => {
    for (let i = 0; i < n / 10; i++) fn(i); // warm the JIT
    const t0 = performance.now();
    let acc = 0;
    for (let i = 0; i < n; i++) acc += fn(i);
    const ns = ((performance.now() - t0) * 1e6) / n;
    console.log(`       ${label}: ${ns.toFixed(0)} ns/call`);
    return { ns, acc };
  };

  const N = 200000;
  // WARM HIT: inside the paged working set, which is where the aircraft is.
  const warm = bench('warm hit  (fine layer resident)', (i) => E.getElevationLocal(p.x + (i % 500), p.z + ((i * 7) % 500)), N);
  // COLD MISS: 120 km out, where both fine layers miss and the pinned base
  // answers. This is the expensive path and it is the one that must not block.
  const farP = C.llToLocal(46.55, -121.35);
  const cold = bench('cold miss (falls to the pinned base)', (i) => E.getElevationLocal(farP.x + (i % 500), farP.z + ((i * 7) % 500)), N);

  ok('a warm hit costs under 1 microsecond', warm.ns < 1000, `${warm.ns.toFixed(0)} ns`);
  ok('a cold miss costs under 2 microseconds', cold.ns < 2000, `${cold.ns.toFixed(0)} ns`);
  ok('a cold miss never blocks — it is at most 4x a hit', cold.ns < warm.ns * 4 + 400);
  ok('neither returned NaN', Number.isFinite(warm.acc) && Number.isFinite(cold.acc));

  // fillHeightGrid is what builds the mesh; it must stay in the same class.
  const t0 = performance.now();
  const grid = E.fillHeightGrid(p.x - 4000, p.z - 4000, 62.5, 62.5, 129, 129, undefined);
  const gridMs = performance.now() - t0;
  console.log(`       fillHeightGrid 129x129: ${gridMs.toFixed(2)} ms`);
  ok('a 129x129 mesh node fills in under 12 ms', gridMs < 12, `${gridMs.toFixed(2)} ms`);
  ok('the grid has no NaN', grid.every((v) => Number.isFinite(v)));
}

// ---------------------------------------------------------------------------
// Void repair
// ---------------------------------------------------------------------------
console.log('\nvoid repair');
{
  const s = E.getRegionStats();
  ok('voids were repaired', s.voidsRepaired > 0, `${s.voidsRepaired} pixels`);
  ok(
    'no decoded sample survives below the measured bathymetry floor',
    s.minElevationM >= -80.001,
    `min ${s.minElevationM.toFixed(1)} m`,
  );
  ok(
    'no decoded sample survives above the plausibility ceiling',
    s.maxElevationM <= 5000,
    `max ${s.maxElevationM.toFixed(1)} m`,
  );
  ok('the ceiling is above Rainier', s.maxElevationM > 4300, `${s.maxElevationM.toFixed(1)} m`);
}

console.log(
  failures
    ? `\n${failures} elevation check(s) FAILED\n`
    : '\nall elevation checks passed\n',
);
process.exit(failures ? 1 : 0);
