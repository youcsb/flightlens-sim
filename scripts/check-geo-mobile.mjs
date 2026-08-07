/**
 * check-geo-mobile.mjs — the phone geo budget, asserted rather than claimed.
 *
 *   npm run check:geo-mobile
 *
 * Two modules hold real memory on the geo side, and both were sized for a
 * desktop. MEASURED in Chrome at the default view, desktop tier:
 *
 *   DEM resident            73.6 MiB   (589 tiles: 238 pinned + 258 + 93)
 *   land-cover rasters      32.0 MiB of JS heap, and 32.0 MiB again on the GPU
 *
 * 105.6 MB, against an iOS Safari tab that dies somewhere past 200 MB counting
 * everything. So both are now tier-settable, and this file runs the SHIPPING
 * modules at the phone budget against the REAL baked data.
 *
 * WHAT IT IS ACTUALLY DEFENDING. Cutting memory here has exactly two ways to go
 * wrong, and neither of them is visible in a screenshot:
 *
 *   1. A HOLE IN THE GROUND. A smaller paging radius means the fine layers miss
 *      more often. §2.4 rule 2 says a miss falls to the next COARSER layer and
 *      never to zero — a 0 m return over the Cascades is a 2 km cliff and the
 *      flight model correctly destroys the aeroplane on it. So the pinned z=11
 *      base must survive every budget, and the sampler must stay total.
 *
 *   2. AN INVENTED LAND-COVER CLASS. The land-cover raster is an INDEX map. The
 *      mean of class 6 (high-intensity development) and class 9 (evergreen
 *      forest) is class 7, barren rock, which borders neither of them anywhere
 *      in the real world. Any downsample that is not modal paints a seam of
 *      gravel along every city edge. The georeferencing checks are repeated
 *      here against the DOWNSAMPLED bytes for the same reason check-landcover
 *      does them at all: a wrong answer renders beautifully.
 *
 * Skips (exit 0) when the data is not baked — §1.6.
 */

import { readFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { decodePng } from './lib/png.mjs';
import { PUBLIC_DIR } from './lib/util.mjs';
import * as C from '../src/geo/coords.js';
import * as E from '../src/geo/elevation.js';
import { downsampleClassRaster, LANDCOVER_TIERS, configureLandcover, getLandcoverConfig } from '../src/geo/landcover.js';
import { applyGeoBudgets } from '../src/geo/geoBudgets.js';
import { budgetsFor } from '../src/core/device.js';

let failures = 0;
const ok = (name, cond, note = '') => {
  if (cond) console.log(`  ok   ${name}${note ? `  (${note})` : ''}`);
  else {
    failures++;
    console.log(`  FAIL ${name}${note ? `  (${note})` : ''}`);
  }
};
const MB = (b) => `${(b / 1048576).toFixed(2)} MiB`;

const TILE_BYTES = 256 * 256 * 2;

const KBFI = [47.527042, -122.29995];
const MT_RAINIER = [46.8517, -121.7603];

const DEM_DIR = resolve(PUBLIC_DIR, 'dem');
const LC_MANIFEST = resolve(PUBLIC_DIR, 'landcover/manifest.json');
if (!existsSync(join(DEM_DIR, 'manifest.json')) || !existsSync(LC_MANIFEST)) {
  console.log('\n  SKIP — public/dem or public/landcover is not baked.\n');
  process.exit(0);
}

C.setOrigin(C.DEFAULT_ORIGIN.lat, C.DEFAULT_ORIGIN.lon);

// ===========================================================================
// PART 1 — the DEM pager at the phone budget
// ===========================================================================

const demManifest = JSON.parse(readFileSync(join(DEM_DIR, 'manifest.json'), 'utf8'));
E.setTileProvider({
  manifest: demManifest,
  async fetchPixels(z, x, y) {
    const p = join(DEM_DIR, String(z), String(x), `${y}.png`);
    if (!existsSync(p)) return null;
    const img = decodePng(readFileSync(p));
    return { width: img.width, height: img.height, rgba: img.rgba };
  },
});

console.log('\nthe budget is what device.js says it is');
const phone = budgetsFor('phone');
{
  // The production wiring, exactly as main.js runs it — not a hand-built
  // policy. If device.js and elevation.js ever disagree about the shape of a
  // paging policy, it fails here rather than on someone's phone.
  const applied = applyGeoBudgets(phone);
  ok('applyGeoBudgets took the phone DEM cap', applied.dem.capBytes === phone.demCapBytes, MB(applied.dem.capBytes));
  ok('the cap is 48 MiB', applied.dem.capBytes === 48 * 1024 * 1024);
  ok('z=13 got the 18 km / 96-tile policy',
    applied.dem.policy[13].radiusM === 18000 && applied.dem.policy[13].budgetTiles === 96);
  ok('z=14 got the 6 km / 48-tile policy',
    applied.dem.policy[14].radiusM === 6000 && applied.dem.policy[14].budgetTiles === 48);
  ok('the phone land-cover tier is 1/2 on both layers',
    applied.landcover.region === 2 && applied.landcover.detail === 2);

  // The planned set has to fit, or the cap is decoration.
  const planned = 238 * TILE_BYTES + 96 * TILE_BYTES + 48 * TILE_BYTES;
  ok('238 pinned + 96 + 48 tiles fit inside the cap', planned <= applied.dem.capBytes,
    `${MB(planned)} planned`);
}

console.log('\nthe floor the cap may not cross');
{
  const before = E.getPagingConfig().capBytes;
  E.configurePaging({ capBytes: 4 * 1024 * 1024 });
  ok('a cap below the pinned base is refused, not obeyed', E.getPagingConfig().capBytes === before,
    `still ${MB(E.getPagingConfig().capBytes)}`);
  E.configurePaging({ capBytes: NaN });
  ok('a non-numeric cap is refused', E.getPagingConfig().capBytes === before);
  E.configurePaging({ policy: { 13: { radiusM: -5, budgetTiles: 0 } } });
  ok('a malformed policy entry does not replace a good one',
    E.getPagingConfig().policy[13].radiusM === 18000);
  ok('the pinned base alone is 29.75 MiB, under the 32 MiB minimum',
    238 * TILE_BYTES < E.getPagingConfig().minCapBytes,
    `${MB(238 * TILE_BYTES)} vs ${MB(E.getPagingConfig().minCapBytes)}`);
}

console.log('\nloading the region at the phone budget');
const spawn = C.llToLocal(...KBFI);
E.setViewer(spawn.x, spawn.z, 0, 0, 16);
await E.loadRegion();
await E.loadDetailLayers();
E.setViewer(spawn.x, spawn.z, 0, 0, 16);
await E.flushPaging();
{
  const s = E.getRegionStats();
  const byZoom = Object.fromEntries(s.layers.map((l) => [l.zoom, l]));
  console.log(
    `       resident ${MB(s.residentBytes)} in ${s.residentTiles} tiles: ` +
      s.layers.map((l) => `z${l.zoom} ${l.tiles}/${l.budgetTiles}`).join(', '),
  );
  ok('resident is inside the 48 MiB cap', s.residentBytes <= s.residentCapBytes,
    `${MB(s.residentBytes)} of ${MB(s.residentCapBytes)}`);
  ok('and it is well under the 73.6 MiB the desktop holds', s.residentBytes < 60 * 1048576, MB(s.residentBytes));
  ok('no cap violations', s.capViolations === 0);
  ok('the pinned base is COMPLETE — every one of its 238 tiles', byZoom[11].tiles === 238, `${byZoom[11].tiles}`);
  ok('z=13 is inside its 96-tile budget', byZoom[13].tiles <= 96, `${byZoom[13].tiles} tiles`);
  ok('z=14 is inside its 48-tile budget', byZoom[14].tiles <= 48, `${byZoom[14].tiles} tiles`);
  ok('byte accounting matches the tiles actually held',
    s.residentBytes === s.residentTiles * TILE_BYTES,
    `${s.residentBytes} vs ${s.residentTiles * TILE_BYTES}`);
  ok('nothing is left pending after a flush', s.layers.every((l) => l.pending === 0),
    s.layers.map((l) => l.pending).join('/'));
}

console.log('\nthe sampler is still total, still synchronous, still cheap');
{
  // A COLD MISS is the whole point: pick ground far outside the 18 km z=13
  // radius but inside the region, and check that what comes back is the pinned
  // base's answer rather than zero. The Cascade crest is the case that matters
  // — a 0 m there is a 2 km cliff.
  const CASCADE_CREST = [47.42, -121.42]; // ~52 km east of the viewer, real mountains
  const blended = E.getElevation(...CASCADE_CREST);
  const base = E.getLayerElevation(11, ...CASCADE_CREST);
  const fine = E.getLayerElevation(13, ...CASCADE_CREST);
  console.log(`       Cascade crest: blended ${blended.toFixed(1)} m, z=11 ${base.height.toFixed(1)} m, z=13 resident ${fine.resident}`);
  ok('the fine layer is genuinely a MISS out there', !fine.resident || fine.weight < 0.01);
  ok('and the ground is still real, not zero', blended > 500, `${blended.toFixed(1)} m`);
  ok('the miss fell to the pinned base exactly', Math.abs(blended - base.height) < 0.01,
    `${(blended - base.height).toFixed(4)} m apart`);

  // Total: 4,000 samples spread over the whole region, none NaN, none a hole.
  let nan = 0;
  let zeroOnLand = 0;
  const b = C.REGION_BBOX;
  for (let i = 0; i < 4000; i++) {
    const lat = b.south + ((b.north - b.south) * (i % 63)) / 62;
    const lon = b.west + ((b.east - b.west) * Math.floor(i / 63)) / 63;
    const h = E.getElevation(lat, lon);
    if (!Number.isFinite(h)) nan++;
    const bh = E.getLayerElevation(11, lat, lon).height;
    if (h === 0 && bh > 5) zeroOnLand++;
  }
  ok('4,000 samples across the region, none NaN', nan === 0, `${nan} NaN`);
  ok('and none returned 0 where the base layer says there is land', zeroOnLand === 0, `${zeroOnLand} holes`);

  // Cheap: the flight model calls this several times per wheel per substep.
  const t0 = performance.now();
  let acc = 0;
  for (let i = 0; i < 200000; i++) acc += E.getElevationLocal(spawn.x + (i % 500), spawn.z + (i % 331));
  const ns = ((performance.now() - t0) * 1e6) / 200000;
  ok('a sample costs under 1 microsecond at the phone budget', ns < 1000, `${ns.toFixed(0)} ns`);
  ok('and it returned real numbers', Number.isFinite(acc));
}

console.log('\nfour laps KBFI <-> Rainier — the leak test');
{
  // The bug this is here for: records were once created on QUEUE and the
  // rebuild tested "does a RECORD exist" rather than "does DATA exist", so
  // every pass orphaned the records it made. Tile counts looked perfect while
  // the working set filled with phantoms. Reading the code will not find the
  // next one of those; flying a long way and watching the bytes will.
  const start = C.llToLocal(...KBFI);
  const end = C.llToLocal(...MT_RAINIER);
  const STEPS = 40;
  const laps = [];
  let worstResident = 0;
  let undefinedGround = 0;
  let worstJump = 0;
  let evictionsAtStart = E.getRegionStats().evictions;

  for (let lap = 0; lap < 4; lap++) {
    const fwd = lap % 2 === 0;
    for (let i = 1; i <= STEPS; i++) {
      const t = fwd ? i / STEPS : 1 - i / STEPS;
      const x = start.x + (end.x - start.x) * t;
      const z = start.z + (end.z - start.z) * t;
      const ll = C.localToLl(x, z);
      const before = E.getElevation(ll.lat, ll.lon);

      const dir = fwd ? 1 : -1;
      E.setViewer(x, z, ((end.x - start.x) / STEPS) * 4 * dir, ((end.z - start.z) / STEPS) * 4 * dir, 1000);
      await E.flushPaging();

      const after = E.getElevation(ll.lat, ll.lon);
      if (!Number.isFinite(after) || after === 0) undefinedGround++;
      worstJump = Math.max(worstJump, Math.abs(after - before));
      const s = E.getRegionStats();
      worstResident = Math.max(worstResident, s.residentBytes);
    }
    const s = E.getRegionStats();
    laps.push({
      bytes: s.residentBytes,
      tiles: s.residentTiles,
      pending: s.layers.reduce((n, l) => n + l.pending, 0),
    });
    console.log(
      `       lap ${lap + 1} end: ${MB(s.residentBytes)}, ${s.residentTiles} tiles, ` +
        `${s.layers.reduce((n, l) => n + l.pending, 0)} pending, ${s.pageIns} page-ins, ${s.evictions} evictions`,
    );
  }

  const s = E.getRegionStats();
  ok('memory stayed capped for all four legs', worstResident <= s.residentCapBytes, `worst ${MB(worstResident)}`);
  ok('no cap violations', s.capViolations === 0);
  ok('the ground was defined and non-zero at every point', undefinedGround === 0);
  ok('prefetch still put the fine layer there before the aircraft', worstJump < 0.05,
    `worst ground move ${worstJump.toFixed(4)} m`);
  ok('paging actually happened — this is not a no-op test',
    s.evictions > evictionsAtStart + 100, `${s.evictions - evictionsAtStart} evictions`);

  // THE LEAK ASSERTIONS. Laps 2 and 4 both end at KBFI, laps 1 and 3 at
  // Rainier. If anything orphaned a record per pass, the same place would hold
  // more after the second visit than after the first.
  ok('the working set at Rainier is identical on lap 1 and lap 3',
    laps[0].bytes === laps[2].bytes && laps[0].tiles === laps[2].tiles,
    `${MB(laps[0].bytes)} then ${MB(laps[2].bytes)}`);
  ok('the working set at KBFI is identical on lap 2 and lap 4',
    laps[1].bytes === laps[3].bytes && laps[1].tiles === laps[3].tiles,
    `${MB(laps[1].bytes)} then ${MB(laps[3].bytes)}`);
  ok('no records were orphaned — pending is 0 at the end of every lap',
    laps.every((l) => l.pending === 0), laps.map((l) => l.pending).join('/'));
  ok('bytes still equal tiles x 128 KiB after 320 km of flying',
    s.residentBytes === s.residentTiles * TILE_BYTES);
}

console.log('\nthe knob is live and desktop is untouched by it');
{
  const desktop = budgetsFor('desktop');
  // Park first. The lead stadium is part of the desired set, and the last
  // setViewer of the flight above left a 20 km lead on the books — which is
  // correct behaviour and would legitimately hold 288 z=13 tiles. The 589/73.6
  // figure this compares against was measured in the browser PARKED at KBFI, so
  // the viewer has to be parked here too for it to mean the same thing.
  E.setViewer(spawn.x, spawn.z, 0, 0, 16);
  E.configurePaging({ capBytes: desktop.demCapBytes, policy: desktop.demPagingPolicy });
  await E.flushPaging();
  const s = E.getRegionStats();
  const byZoom = Object.fromEntries(s.layers.map((l) => [l.zoom, l]));
  ok('raising the cap widens the fine layers again', byZoom[13].tiles > 200, `z13 ${byZoom[13].tiles} tiles`);
  // The browser held 589 tiles / 73.6 MiB parked at the KBFI spawn. The spawn
  // is a runway threshold and this is the airport reference point, a few
  // hundred metres away, so a tile or two on the disc boundary goes either way.
  // The claim is that the desktop budget still lands on its measured working
  // set, not that a boundary tile is deterministic across two viewers.
  ok('and lands where the browser measured the desktop: 589 tiles, 73.6 MiB',
    Math.abs(s.residentTiles - 589) <= 8 && Math.abs(s.residentBytes - 77201408) <= 8 * TILE_BYTES,
    `${s.residentTiles} tiles, ${MB(s.residentBytes)}`);
  ok('still no cap violations', s.capViolations === 0);
}

// ===========================================================================
// PART 2 — the land-cover rasters
// ===========================================================================

console.log('\nland cover: what the phone tier costs');
const lcManifest = JSON.parse(readFileSync(LC_MANIFEST, 'utf8'));
const names = new Map(lcManifest.classes.map((c) => [c.index, c.name]));

/** name -> {spec, full, small} */
const lc = {};
for (const spec of lcManifest.layers) {
  const file = resolve(PUBLIC_DIR, spec.file);
  if (!existsSync(file)) continue;
  const img = decodePng(readFileSync(file));
  const factor = LANDCOVER_TIERS.phone[spec.name] ?? 1;
  lc[spec.name] = {
    spec,
    factor,
    full: { data: img.rgba, width: img.width, height: img.height },
    small: downsampleClassRaster(img.rgba, img.width, img.height, factor),
  };
}

{
  let fullBytes = 0;
  let smallBytes = 0;
  for (const L of Object.values(lc)) {
    fullBytes += L.full.width * L.full.height * 4;
    smallBytes += L.small.data.byteLength;
    const spanM = (L.spec.bbox.east - L.spec.bbox.west) * 111412.84 * Math.cos((47.5 * Math.PI) / 180);
    console.log(
      `       ${L.spec.name}: ${L.full.width}x${L.full.height} -> ${L.small.width}x${L.small.height}, ` +
        `${(spanM / L.full.width).toFixed(1)} -> ${(spanM / L.small.width).toFixed(1)} m/texel, ` +
        `${MB(L.full.width * L.full.height * 4)} -> ${MB(L.small.data.byteLength)}`,
    );
  }
  ok('the desktop rasters are the measured 32.0 MiB', Math.abs(fullBytes - 32 * 1048576) < 1048576, MB(fullBytes));
  ok('the phone rasters are 8.0 MiB', Math.abs(smallBytes - 8 * 1048576) < 1048576, MB(smallBytes));
  ok('that is a 4x cut on the heap AND the same again off the GPU', fullBytes / smallBytes >= 3.9);
  ok('the detail layer stays finer than the region layer',
    lc.detail.small.width / (lc.detail.spec.bbox.east - lc.detail.spec.bbox.west) >
      lc.region.small.width / (lc.region.spec.bbox.east - lc.region.spec.bbox.west));
}

/** Class index at lat/lon in a {data,width,height} raster with the layer's bbox. */
const classIn = (L, raster, lat, lon) => {
  const b = L.spec.bbox;
  if (lat < b.south || lat > b.north || lon < b.west || lon > b.east) return -1;
  const x = Math.min(raster.width - 1, Math.floor(((lon - b.west) / (b.east - b.west)) * raster.width));
  const y = Math.min(raster.height - 1, Math.floor(((b.north - lat) / (b.north - b.south)) * raster.height));
  return raster.data[(y * raster.width + x) * 4 + 1];
};
const roadIn = (L, raster, lat, lon) => {
  const b = L.spec.bbox;
  const x = Math.min(raster.width - 1, Math.floor(((lon - b.west) / (b.east - b.west)) * raster.width));
  const y = Math.min(raster.height - 1, Math.floor(((b.north - lat) / (b.north - b.south)) * raster.height));
  return raster.data[(y * raster.width + x) * 4 + 2];
};

const WATER = 1, ICE = 2, DEV_HIGH = 6, EVERGREEN = 9;
const DEVELOPED = [3, 4, 5, 6];

console.log('\nland cover: the places still classify right AFTER the cut');
{
  const R = lc.region;
  const at = (lat, lon) => classIn(R, R.small.data ? R.small : R.full, lat, lon);
  const small = { data: R.small.data, width: R.small.width, height: R.small.height };
  const cl = (lat, lon) => classIn(R, small, lat, lon);

  ok('Mount Rainier summit is still perennial ice/snow', cl(46.8517, -121.7603) === ICE, names.get(cl(46.8517, -121.7603)));
  ok('mid Elliott Bay is still open water', cl(47.6, -122.39) === WATER, names.get(cl(47.6, -122.39)));
  ok('mid Lake Washington is still open water', cl(47.625, -122.255) === WATER, names.get(cl(47.625, -122.255)));
  ok('the Space Needle still stands in developed ground', DEVELOPED.includes(cl(47.6204, -122.3491)), names.get(cl(47.6204, -122.3491)));
  ok('downtown Seattle is still developed', DEVELOPED.includes(cl(47.6062, -122.3321)), names.get(cl(47.6062, -122.3321)));
  ok('the Olympic interior is still evergreen forest', cl(47.75, -123.3) === EVERGREEN, names.get(cl(47.75, -123.3)));
  // The rest of the region is checked as an AGREEMENT rather than against a
  // literal class. On mixed ground — a coastline, a suburban fringe — the
  // "right" answer is a judgement call at 81 m and at 162 m alike, and what
  // this file is actually testing is whether the cut CHANGED the answer. So:
  // majority over the same absolute box in the full-resolution raster and in
  // the downsampled one, and they have to agree.
  const rfull = { data: R.full.data, width: R.full.width, height: R.full.height };
  const majority = (raster, lat, lon) => {
    const counts = new Map();
    for (let i = -3; i <= 3; i++)
      for (let j = -3; j <= 3; j++) {
        const c = classIn(R, raster, lat + i * 0.002, lon + j * 0.003);
        if (c >= 0) counts.set(c, (counts.get(c) || 0) + 1);
      }
    let best = -1;
    let bestN = 0;
    for (const [c, n] of counts) if (n > bestN) { bestN = n; best = c; }
    return best;
  };
  const PLACES = [
    ['the north edge of the region', 48.24, -122.7],
    ['the south edge of the region', 46.6, -122.7],
    ['the Strait of Juan de Fuca', 48.24, -123.1],
    ['Bellevue', 47.6145, -122.1985],
    ['the Cascade interior', 47.5, -121.5],
    ['the Kent valley farmland', 47.35, -122.25],
  ];
  let disagree = 0;
  for (const [what, lat, lon] of PLACES) {
    const a = majority(rfull, lat, lon);
    const b = majority(small, lat, lon);
    if (a !== b) disagree++;
    ok(`${what} classifies the same before and after the cut`, a === b,
      `${names.get(a)} / ${names.get(b)}`);
  }
  ok('north is water and south is land — the V axis did not flip',
    majority(small, 48.24, -123.1) === WATER && majority(small, 46.6, -122.7) !== WATER,
    `${names.get(majority(small, 48.24, -123.1))} / ${names.get(majority(small, 46.6, -122.7))}`);
  void at;
  void disagree;

  const D = lc.detail;
  const dsmall = { data: D.small.data, width: D.small.width, height: D.small.height };
  ok('the detail inset still puts the Space Needle in high-intensity development',
    classIn(D, dsmall, 47.6204, -122.3491) === DEV_HIGH,
    names.get(classIn(D, dsmall, 47.6204, -122.3491)));
  ok('the detail inset still has Elliott Bay as water',
    classIn(D, dsmall, 47.6, -122.39) === WATER);
}

console.log('\nland cover: the downsample invented nothing');
{
  for (const L of Object.values(lc)) {
    const before = new Set();
    const after = new Set();
    for (let i = 1; i < L.full.data.length; i += 4) before.add(L.full.data[i]);
    for (let i = 1; i < L.small.data.length; i += 4) after.add(L.small.data[i]);
    const invented = [...after].filter((c) => !before.has(c));
    ok(`${L.spec.name}: no class exists after the cut that did not exist before`,
      invented.length === 0, invented.map((c) => names.get(c) ?? c).join(', ') || 'none');

    // The counter-example, stated as a number: a plain box AVERAGE of the same
    // block produces indices that are not classes at all. This is the assertion
    // that says "modal" is load-bearing rather than fussy.
    let averagedWrong = 0;
    const w = L.full.width;
    for (let y = 0; y + 1 < L.full.height; y += 2 * 37) {
      for (let x = 0; x + 1 < w; x += 2 * 41) {
        const a = L.full.data[(y * w + x) * 4 + 1];
        const b = L.full.data[(y * w + x + 1) * 4 + 1];
        const c = L.full.data[((y + 1) * w + x) * 4 + 1];
        const d = L.full.data[((y + 1) * w + x + 1) * 4 + 1];
        const mean = Math.round((a + b + c + d) / 4);
        if (mean !== a && mean !== b && mean !== c && mean !== d) averagedWrong++;
      }
    }
    ok(`${L.spec.name}: an AVERAGE would have invented classes — this is why it is modal`,
      averagedWrong > 0, `${averagedWrong} sampled blocks where the mean is no member`);
  }
}

console.log('\nland cover: class areas and the road network survived');
{
  for (const L of Object.values(lc)) {
    const histo = (raster, n) => {
      const h = new Float64Array(256);
      for (let i = 1; i < raster.length; i += 4) h[raster[i]]++;
      for (let k = 0; k < 256; k++) h[k] /= n;
      return h;
    };
    const a = histo(L.full.data, L.full.width * L.full.height);
    const b = histo(L.small.data, L.small.width * L.small.height);
    let worst = 0;
    let worstClass = -1;
    for (let k = 0; k < 256; k++) {
      const d = Math.abs(a[k] - b[k]);
      if (d > worst) { worst = d; worstClass = k; }
    }
    // A modal filter is biased: it grows whatever is locally dominant and eats
    // the fragments around it. MEASURED here, that bias is +2.07% of total area
    // for Evergreen Forest in the region layer and +0.17% for Developed, Open
    // Space in the detail layer. 2.5% is the line, and the point of the check
    // is that it is a small bounded shift and not a reclassification.
    ok(`${L.spec.name}: no class moved more than 2.5% of the total area`,
      worst < 0.025,
      `worst ${names.get(worstClass) ?? worstClass} ${(worst * 100).toFixed(2)}%`);

    let roadsFull = 0;
    let roadsSmall = 0;
    let primaryFull = 0;
    let primarySmall = 0;
    for (let i = 2; i < L.full.data.length; i += 4) {
      if (L.full.data[i] > 0) roadsFull++;
      if (L.full.data[i] === 255) primaryFull++;
    }
    for (let i = 2; i < L.small.data.length; i += 4) {
      if (L.small.data[i] > 0) roadsSmall++;
      if (L.small.data[i] === 255) primarySmall++;
    }
    if (roadsFull === 0) {
      console.log(`       (${L.spec.name} has no road mask in this bake)`);
      continue;
    }
    console.log(
      `       ${L.spec.name}: road texels ${roadsFull} -> ${roadsSmall} ` +
        `(${((roadsSmall / roadsFull) * 100).toFixed(0)}% of the count at 25% of the texels), ` +
        `primary ${primaryFull} -> ${primarySmall}`,
    );
    // A one-texel line halves in LENGTH when the raster halves, so the ideal is
    // ~50% of the texels out of 25% of the raster — i.e. the road density
    // doubles, which is what keeping a network at half resolution means. Two
    // things pull it below 50%: a diagonal run puts two source texels in one
    // 2x2 block, and short spurs merge. MEASURED: region 39%, detail 34%.
    // A MEAN pool would give 160/4 = 40 and 255/4 = 64, i.e. every road either
    // gone or demoted; a nearest sample would keep about 25% and cut the
    // network into dashes.
    ok(`${L.spec.name}: the road network survived max-pooling`,
      roadsSmall > roadsFull * 0.3, `${((roadsSmall / roadsFull) * 100).toFixed(0)}% kept`);
    ok(`${L.spec.name}: primary roads are still marked 255, not averaged away`,
      primarySmall > primaryFull * 0.3, `${((primarySmall / primaryFull) * 100).toFixed(0)}% kept`);
  }

  // I-5 and I-90, the two the full-resolution check names.
  const D = lc.detail;
  const dsmall = { data: D.small.data, width: D.small.width, height: D.small.height };
  const near = (lat, lon, n = 2) => {
    let best = 0;
    for (let i = -n; i <= n; i++)
      for (let j = -n; j <= n; j++) best = Math.max(best, roadIn(D, dsmall, lat + i * 0.0012, lon + j * 0.0016));
    return best;
  };
  ok('I-5 is still marked near 47.66, -122.32', near(47.66, -122.3225) >= 160, `${near(47.66, -122.3225)}`);
  ok('I-90 is still marked mid Lake Washington', near(47.59, -122.26) >= 160, `${near(47.59, -122.26)}`);

  // CONTINUITY, which is the property a road mask actually has to keep. Walk
  // I-5 from Boeing Field to Northgate and ask, at each of 80 steps, whether
  // there is a road texel within ~250 m — of the FULL raster and of the
  // downsampled one. The claim is not "roads are perfect", it is "the phone's
  // network is no more broken than the one that was baked".
  const dfull = { data: D.full.data, width: D.full.width, height: D.full.height };
  // The same ABSOLUTE window in both rasters — ±0.0044 deg lat / ±0.006 deg lon,
  // about 490 x 450 m — sampled at the finer raster's step so neither is given
  // a wider search than the other.
  const hitsWithin = (raster) => {
    let hits = 0;
    for (let k = 0; k < 80; k++) {
      const lat = 47.53 + (k / 79) * 0.18;
      const lon = -122.3 - 0.032 * Math.sin((k / 79) * Math.PI);
      let best = 0;
      for (let i = -4; i <= 4; i++)
        for (let j = -4; j <= 4; j++)
          best = Math.max(best, roadIn(D, raster, lat + i * 0.0011, lon + j * 0.0015));
      if (best > 0) hits++;
    }
    return hits;
  };
  const full80 = hitsWithin(dfull);
  const small80 = hitsWithin(dsmall);
  console.log(`       I-5 continuity walk, 80 steps: full ${full80}/80, phone ${small80}/80`);
  ok('the downsampled road network is no more broken than the baked one',
    small80 >= full80 - 2, `${small80} vs ${full80}`);
}

console.log('\nland cover: the tier knob itself');
{
  const r = downsampleClassRaster(lc.region.full.data, lc.region.full.width, lc.region.full.height, 2);
  ok('the downsample is deterministic — same bytes twice',
    r.data.length === lc.region.small.data.length &&
      r.data.every((v, i) => v === lc.region.small.data[i]));

  const pass = downsampleClassRaster(lc.detail.full.data, lc.detail.full.width, lc.detail.full.height, 1);
  ok('factor 1 is a pass-through, so desktop ships exactly what was baked',
    pass.width === lc.detail.full.width && pass.height === lc.detail.full.height &&
      pass.data.every((v, i) => v === lc.detail.full.data[i]));

  ok('alpha is opaque everywhere in the downsampled raster',
    lc.region.small.data.every((v, i) => i % 4 !== 3 || v === 255));

  ok('desktop and tablet ask for no downsample at all',
    LANDCOVER_TIERS.desktop.region === 1 && LANDCOVER_TIERS.desktop.detail === 1 &&
      LANDCOVER_TIERS.tablet.region === 1 && LANDCOVER_TIERS.tablet.detail === 1);
  ok('only the phone tier decodes its layers sequentially, to bound the boot peak',
    LANDCOVER_TIERS.phone.sequentialDecode === true &&
      LANDCOVER_TIERS.desktop.sequentialDecode === false);

  configureLandcover('nonsense-tier');
  ok('an unknown tier degrades to desktop rather than throwing',
    getLandcoverConfig().region === 1 && getLandcoverConfig().detail === 1);
  configureLandcover('phone');
  ok('and the phone tier can be set by name', getLandcoverConfig().region === 2);
}

console.log(
  failures ? `\n${failures} mobile geo check(s) FAILED\n` : '\nall mobile geo checks passed\n',
);
process.exit(failures ? 1 : 0);
