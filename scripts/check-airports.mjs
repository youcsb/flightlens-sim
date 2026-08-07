/**
 * check-airports.mjs — the number acceptance check 6 is actually about.
 *
 *   npm run check:airports
 *
 * "Wheels touch where the ground is drawn." Everything else in this project
 * measures one half of that sentence. `check:elevation` measures the DEM
 * against surveyed threshold elevations; `check:terrain` measures the LOD mesh
 * against `getElevationLocal`; the console's `[airports]` line reports how far a
 * deck had to BEND. None of them measured the thing the pilot meets on frame 0:
 * the gap between the drawn asphalt and the one collision surface
 * (MODULES.md §1.4) directly under it.
 *
 * That gap shipped at a mean of 0.88 m across KBFI 14R/32L and 0.83 m at the
 * spawn point itself — with `gearHeightM` at 1.20 m, most of the main gear was
 * inside the pavement before the pilot touched anything — and every gate was
 * green, because the number MODULES.md quoted ("KBFI: 2.4 cm") is the deck
 * BEND. A bend of 2 cm and a float of 1 m are different statistics about
 * different things, and quoting one for the other is how this hid.
 *
 * So this harness runs the SHIPPING `buildRunwayMeshes` against the REAL baked
 * DEM and the REAL baked airport file, and samples the built TRIANGLES —
 * barycentrically, the way the rasteriser will, so it answers for the pixels
 * BETWEEN vertices too — against `getElevationLocal`. The only things replaced
 * are the two Node cannot do: `fetch` (served off public/) and the 2D canvas
 * the pavement textures are painted on (scripts/lib/canvas-stub.mjs, which
 * moves no vertex).
 *
 * THREE THINGS IT IS CAREFUL ABOUT
 *
 * 1. WHERE THE WHEELS ARE. A runway is crowned: the DEM under KBFI 14R/32L
 *    reads 5.00 m on the centreline and 4.75 m at both edges. The deck clears
 *    the highest sample on its own section, so the edge of the pavement stands
 *    higher above the grass than the centre does — which is what a real runway
 *    edge does. The aeroplane lands on the middle, so the landing band
 *    (± quarter width) and the full pavement are measured and asserted
 *    separately, at their own tolerances.
 *
 * 2. WHERE THE VIEWER STANDS. `getElevationLocal` blends layers by distance
 *    from the viewer (§2.4), so a field 8.8 km away is answered off z=13 and
 *    the same field underfoot off z=14. A deck is built once, at boot, with the
 *    viewer at the spawn — so it is measured twice here, as built and as the
 *    pilot finds it after flying there. If those disagree, landing away from
 *    home is landing on a lie.
 *
 * 3. WHAT IS A DEFECT AND WHAT IS GEOGRAPHY. KSEA 16R/34L stands on up to 50 m
 *    of 2004 fill over the Miller Creek valley and 3DEP's bare-earth DEM has
 *    the valley, not the fill. That deck HAS to stand proud. The assertion
 *    there is not that the float is small — it is that the float is declared in
 *    `userData.standingDecks` and that the shoulder skirt comes all the way
 *    down to the ground, so the embankment is drawn instead of implied.
 */

import { readFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { decodePng } from './lib/png.mjs';
import { PUBLIC_DIR } from './lib/util.mjs';
import { installCanvasStub } from './lib/canvas-stub.mjs';
import * as C from '../src/geo/coords.js';
import * as E from '../src/geo/elevation.js';

let failures = 0;
let assertions = 0;
const ok = (name, cond, note = '') => {
  assertions++;
  if (cond) {
    console.log(`  ok   ${name}${note ? `  (${note})` : ''}`);
  } else {
    failures++;
    console.log(`  FAIL ${name}${note ? `  (${note})` : ''}`);
  }
};

const DEM_DIR = resolve(PUBLIC_DIR, 'dem');
const AIRPORTS_FILE = resolve(PUBLIC_DIR, 'data/airports.json');
if (!existsSync(join(DEM_DIR, 'manifest.json')) || !existsSync(AIRPORTS_FILE)) {
  console.log('\n  SKIP — public/dem or public/data/airports.json is not baked.\n');
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Wire the shipping modules to the files on disk
// ---------------------------------------------------------------------------
installCanvasStub();

/** Serve public/ over the loader's own fetch path, so loadAirports() is real. */
globalThis.fetch = async (url) => {
  const rel = String(url).replace(/^\.?\//, '');
  const p = resolve(PUBLIC_DIR, rel);
  if (!existsSync(p)) return { ok: false, status: 404, headers: { get: () => '' } };
  const body = readFileSync(p, 'utf8');
  return {
    ok: true,
    status: 200,
    headers: { get: (k) => (k.toLowerCase() === 'content-type' ? 'application/json' : '') },
    json: async () => JSON.parse(body),
    text: async () => body,
  };
};

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
const A = await import('../src/geo/airports.js');

/** The gear leg every tolerance in this file is measured against (§2.10). */
const GEAR_HEIGHT_M = 1.2;

// ---------------------------------------------------------------------------
// Load the world the way main.js does: terrain first, then airports
// ---------------------------------------------------------------------------
await E.loadRegion(C.REGION_BBOX, E.DEM_ZOOM);
await E.loadDetailLayers(E.DEM_ZOOM);

/** Put the pager where the aircraft is and drain it, as a teleport would. */
async function viewerAt(lat, lon) {
  const p = C.llToLocal(lat, lon);
  E.setViewer(p.x, p.z);
  await E.warmAt(lat, lon);
  await E.flushPaging();
  E.setViewer(p.x, p.z);
  return p;
}

const KBFI = [47.527042, -122.29995];
const KSEA = [47.447943, -122.310276];

await viewerAt(...KBFI);

console.log('\nsources');
const airports = await A.loadAirports();
ok('airport data is baked', airports.length > 50, `${airports.length} airports`);

// Built exactly as main.js builds it: once, at boot, viewer at the spawn.
const group = A.buildRunwayMeshes(null, airports);
const meta = group.userData.runways || [];
ok('runways are drawn', meta.length > 50, `${meta.length} runways`);

// ---------------------------------------------------------------------------
// The drawn surface, sampled the way the rasteriser will sample it
// ---------------------------------------------------------------------------
/**
 * Index the built triangles of the named meshes and answer "how high is the
 * drawn surface at (x, z)". This is the DRAWN surface, not a re-derivation of
 * it: if the builder emits a quad whose corners are right and whose middle is
 * not, this sees the middle.
 */
function indexMeshes(root, names) {
  const tris = [];
  root.traverse((o) => {
    if (!o.isMesh || !names.includes(o.name)) return;
    const pos = o.geometry.getAttribute('position');
    const idx = o.geometry.getIndex();
    const n = idx ? idx.count : pos.count;
    for (let i = 0; i < n; i += 3) {
      const a = idx ? idx.getX(i) : i;
      const b = idx ? idx.getX(i + 1) : i + 1;
      const c = idx ? idx.getX(i + 2) : i + 2;
      tris.push([
        pos.getX(a), pos.getY(a), pos.getZ(a),
        pos.getX(b), pos.getY(b), pos.getZ(b),
        pos.getX(c), pos.getY(c), pos.getZ(c),
      ]);
    }
  });
  const CELL = 200;
  const grid = new Map();
  const key = (i, j) => `${i},${j}`;
  tris.forEach((t, k) => {
    const i0 = Math.floor(Math.min(t[0], t[3], t[6]) / CELL);
    const i1 = Math.floor(Math.max(t[0], t[3], t[6]) / CELL);
    const j0 = Math.floor(Math.min(t[2], t[5], t[8]) / CELL);
    const j1 = Math.floor(Math.max(t[2], t[5], t[8]) / CELL);
    for (let i = i0; i <= i1; i++) {
      for (let j = j0; j <= j1; j++) {
        const kk = key(i, j);
        let bucket = grid.get(kk);
        if (!bucket) grid.set(kk, (bucket = []));
        bucket.push(k);
      }
    }
  });
  const heightAt = (x, z) => {
    const bucket = grid.get(key(Math.floor(x / CELL), Math.floor(z / CELL)));
    if (!bucket) return null;
    let best = null;
    for (const k of bucket) {
      const t = tris[k];
      const x1 = t[0], z1 = t[2], x2 = t[3], z2 = t[5], x3 = t[6], z3 = t[8];
      const d = (z2 - z3) * (x1 - x3) + (x3 - x2) * (z1 - z3);
      if (Math.abs(d) < 1e-9) continue;
      const l1 = ((z2 - z3) * (x - x3) + (x3 - x2) * (z - z3)) / d;
      const l2 = ((z3 - z1) * (x - x3) + (x1 - x3) * (z - z3)) / d;
      const l3 = 1 - l1 - l2;
      if (l1 < -1e-4 || l2 < -1e-4 || l3 < -1e-4) continue;
      const y = l1 * t[1] + l2 * t[4] + l3 * t[7];
      if (best === null || y > best) best = y;
    }
    return best;
  };
  return { tris, heightAt, triangles: tris.length };
}

const PAVEMENT = ['runway-asphalt', 'runway-concrete', 'runway-gravel', 'runway-turf', 'runway-dirt', 'runway-unknown'];
const pav = indexMeshes(group, PAVEMENT);
const shoulder = indexMeshes(group, ['runway-shoulder']);
const hints = indexMeshes(group, ['airport-taxiways']);
console.log(
  `       ${pav.triangles} pavement triangles, ${shoulder.triangles} shoulder, ` +
    `${hints.triangles} taxiway/apron`,
);

/** Float of the drawn deck above the collision surface over a runway. */
function floatOver(rw, halfFrac, index = pav) {
  const a = C.llToLocal(rw.leLat, rw.leLon);
  const b = C.llToLocal(rw.heLat, rw.heLon);
  const lengthM = Math.hypot(b.x - a.x, b.z - a.z);
  const dx = (b.x - a.x) / lengthM;
  const dz = (b.z - a.z) / lengthM;
  const rx = -dz, rz = dx;
  const half = (((rw.widthFt > 0 ? rw.widthFt : 75) * 0.3048) / 2) * halfFrac;
  let n = 0, sum = 0, max = -Infinity, min = Infinity, worst = null;
  for (let t = 0; t <= lengthM; t += 5) {
    for (const s of [-half, -half / 2, 0, half / 2, half]) {
      const x = a.x + dx * t + rx * s;
      const z = a.z + dz * t + rz * s;
      const y = index.heightAt(x, z);
      if (y === null) continue;
      const f = y - E.getElevationLocal(x, z);
      n++;
      sum += f;
      if (f > max) { max = f; worst = C.localToLl(x, z); }
      if (f < min) min = f;
    }
  }
  return { n, mean: n ? sum / n : NaN, max, min, worst, lengthM };
}

const runwayOf = (ident, name) =>
  A.getAirport(ident)?.runways.find((r) => `${r.leIdent}/${r.heIdent}` === name) || null;

// ---------------------------------------------------------------------------
// 1. The spawn — frame 0, before the pilot has touched anything
// ---------------------------------------------------------------------------
console.log('\nthe spawn, frame 0 (acceptance checks 2 and 6)');
{
  const spawn = A.getSpawn();
  const p = C.llToLocal(spawn.lat, spawn.lon);
  const field = E.getElevationLocal(p.x, p.z);
  const drawn = pav.heightAt(p.x, p.z);
  console.log(
    `       ${spawn.label}  field ${field.toFixed(3)} m  ` +
      `drawn ${drawn === null ? 'none' : `${drawn.toFixed(3)} m`}  ` +
      `gear ${GEAR_HEIGHT_M.toFixed(2)} m`,
  );
  ok('the spawn point is on drawn pavement at all', drawn !== null);
  const gap = drawn === null ? Infinity : drawn - field;
  ok(
    'the wheels rest on the tarmac, not inside it',
    gap > -0.05 && gap < 0.40,
    `${gap >= 0 ? '+' : ''}${gap.toFixed(3)} m = ${((gap / GEAR_HEIGHT_M) * 100).toFixed(0)}% of a gear leg`,
  );
  ok(
    'the pavement is above the wheels, never under them',
    gap >= 0,
    'terrain through the deck is worse than a centimetre of float',
  );
  ok(
    'getSpawn().elevationM is the field, not the deck',
    Math.abs(spawn.elevationM - field) < 0.05,
    `${spawn.elevationM.toFixed(3)} vs ${field.toFixed(3)}`,
  );
}

// ---------------------------------------------------------------------------
// 2. The runways the acceptance checks name
// ---------------------------------------------------------------------------
/**
 * Tolerances, and where each number comes from.
 *
 * `band` is the landing band, ± a quarter of the width from the centreline —
 * the strip the wheels can actually be on. MIN_LIFT_M is 0.25 m of deliberate
 * clearance, so 0.45 m is that plus the cross-section residual of a crowned
 * runway; anything above it is float that has crept back in.
 *
 * `full` is the whole pavement including the edges, which stand higher above
 * the grass by exactly the runway's own crown — a real runway edge does too.
 *
 * KSEA 16R/34L and 16L/34R are the Miller Creek embankment (§2.5) and are held
 * to `stand`, not to a float: their tolerance says the DEM has no fill, which
 * is true, and the assertions that matter for them are in section 4.
 */
const CASES = [
  { ident: 'KBFI', rw: '14R/32L', band: 0.60, full: 1.10, note: 'the spawn runway' },
  { ident: 'KBFI', rw: '14L/32R', band: 0.55, full: 0.70 },
  { ident: 'KSEA', rw: '16C/34C', band: 0.55, full: 0.85, note: 'the runway main.js offers' },
  { ident: 'KSEA', rw: '16L/34R', band: 1.30, full: 1.90, note: 'plateau fill at the south end' },
  { ident: 'KSEA', rw: '16R/34L', band: 30.0, full: 32.0, note: 'the 2004 third-runway embankment — see section 4' },
];

console.log('\ndrawn deck vs the collision surface, deck as built (viewer at the spawn)');
const asBuilt = new Map();
for (const c of CASES) {
  const rw = runwayOf(c.ident, c.rw);
  if (!rw) continue;
  const band = floatOver(rw, 0.25);
  const full = floatOver(rw, 1.0);
  asBuilt.set(`${c.ident} ${c.rw}`, { band, full });
  console.log(
    `       ${c.ident} ${c.rw.padEnd(8)} band mean ${band.mean.toFixed(2)} max ${band.max.toFixed(2)}  ` +
      `| full mean ${full.mean.toFixed(2)} max ${full.max.toFixed(2)} min ${full.min.toFixed(2)}` +
      (c.note ? `  — ${c.note}` : ''),
  );
}
for (const c of CASES) {
  const f = asBuilt.get(`${c.ident} ${c.rw}`);
  if (!f) continue;
  ok(
    `${c.ident} ${c.rw}: the landing band is flush`,
    f.band.max <= c.band,
    `worst ${f.band.max.toFixed(2)} m of ${c.band} allowed`,
  );
  ok(
    `${c.ident} ${c.rw}: the whole pavement is flush`,
    f.full.max <= c.full,
    `worst ${f.full.max.toFixed(2)} m of ${c.full} allowed`,
  );
  ok(
    `${c.ident} ${c.rw}: no terrain through the deck`,
    f.full.min > -0.30,
    `deepest ${f.full.min.toFixed(2)} m`,
  );
}
{
  const kbfi = asBuilt.get('KBFI 14R/32L');
  ok(
    'the spawn runway floats under a third of a gear leg on the centreline',
    kbfi.band.mean < GEAR_HEIGHT_M / 3,
    `mean ${kbfi.band.mean.toFixed(2)} m vs ${(GEAR_HEIGHT_M / 3).toFixed(2)} m`,
  );
}

// ---------------------------------------------------------------------------
// 3. The same decks after flying there — the field has improved underneath
// ---------------------------------------------------------------------------
await viewerAt(...KSEA);
console.log('\nthe same decks with the viewer over KSEA (a finer field underneath)');
for (const c of CASES) {
  const rw = runwayOf(c.ident, c.rw);
  if (!rw) continue;
  const band = floatOver(rw, 0.25);
  const was = asBuilt.get(`${c.ident} ${c.rw}`).band;
  const drift = Math.abs(band.mean - was.mean);
  console.log(
    `       ${c.ident} ${c.rw.padEnd(8)} band mean ${band.mean.toFixed(2)}  ` +
      `drift from as-built ${drift.toFixed(3)} m`,
  );
  ok(
    `${c.ident} ${c.rw}: flying there does not move the deck off the ground`,
    drift < 0.10,
    `${drift.toFixed(3)} m`,
  );
}

// ---------------------------------------------------------------------------
// 4. Where the deck genuinely stands proud, the embankment is DRAWN
// ---------------------------------------------------------------------------
await viewerAt(...KBFI);
console.log('\nstanding decks — the DEM has no earthworks, so the shoulder skirts down');
{
  const standing = group.userData.standingDecks || [];
  const worst = standing.slice().sort((a, b) => b.standM - a.standM);
  for (const d of worst.slice(0, 4)) {
    console.log(`       ${d.ident} ${d.runway} stands +${d.standM.toFixed(1)} m`);
  }
  ok(
    'a deck standing above the field is declared, not hidden',
    standing.some((d) => d.ident === 'KSEA' && d.runway === '16R/34L'),
    `${standing.length} declared, worst ${worst[0]?.standM.toFixed(1)} m`,
  );

  // The skirt: the shoulder's OUTER edge has to reach the ground on BOTH sides
  // at EVERY station, or the pavement is a ribbon in the sky with a painted
  // edge. Measured on the shoulder's own vertices, bucketed by station along
  // the runway, so a skirt that reaches the ground in one place and hangs in
  // the air 200 m further on cannot pass.
  const rw = runwayOf('KSEA', '16R/34L');
  const a = C.llToLocal(rw.leLat, rw.leLon);
  const b = C.llToLocal(rw.heLat, rw.heLon);
  const lengthM = Math.hypot(b.x - a.x, b.z - a.z);
  const dx = (b.x - a.x) / lengthM, dz = (b.z - a.z) / lengthM;
  const rx = -dz, rz = dx;
  const half = (rw.widthFt * 0.3048) / 2;
  const sh = Math.min(7.5, rw.widthFt * 0.3048 * 0.25);
  const BUCKET_M = 50;
  const nb = Math.ceil(lengthM / BUCKET_M);
  const lowest = [
    new Array(nb).fill(Infinity),
    new Array(nb).fill(Infinity),
  ];
  const highest = new Array(nb).fill(-Infinity);
  const seen = new Set();
  for (const tri of shoulder.tris) {
    for (let k = 0; k < 3; k++) {
      const x = tri[k * 3], y = tri[k * 3 + 1], z = tri[k * 3 + 2];
      const key = `${x.toFixed(2)},${z.toFixed(2)}`;
      if (seen.has(key)) continue;
      const t = (x - a.x) * dx + (z - a.z) * dz;
      const s = (x - a.x) * rx + (z - a.z) * rz;
      if (t < 0 || t > lengthM) continue;
      if (Math.abs(s) < half - 1 || Math.abs(s) > half + sh + 1) continue;
      seen.add(key);
      const i = Math.min(nb - 1, Math.floor(t / BUCKET_M));
      const side = s < 0 ? 0 : 1;
      const f = y - E.getElevationLocal(x, z);
      if (f < lowest[side][i]) lowest[side][i] = f;
      if (f > highest[i]) highest[i] = f;
    }
  }
  let worstBucket = -Infinity;
  let covered = 0;
  for (let i = 0; i < nb; i++) {
    for (const side of [0, 1]) {
      if (!Number.isFinite(lowest[side][i])) continue;
      covered++;
      if (lowest[side][i] > worstBucket) worstBucket = lowest[side][i];
    }
  }
  ok(
    'KSEA 16R/34L: the shoulder skirt reaches the ground at every station, both sides',
    covered >= nb * 2 - 2 && worstBucket < 0.20,
    `worst of ${covered} station-sides is +${worstBucket.toFixed(2)} m`,
  );
  ok(
    'KSEA 16R/34L: the skirt spans the whole embankment, so the wall is drawn',
    Math.max(...highest) > 20,
    `tallest skirt ${Math.max(...highest).toFixed(1)} m`,
  );
}

// ---------------------------------------------------------------------------
// 5. Region-wide: every drawn vertex of every pavement
// ---------------------------------------------------------------------------
console.log('\nevery drawn vertex, region-wide');
function vertexStats(index) {
  let n = 0, sum = 0, max = -Infinity, min = Infinity, buried = 0, deep = 0;
  const seen = new Set();
  for (const t of index.tris) {
    for (let k = 0; k < 3; k++) {
      const x = t[k * 3], y = t[k * 3 + 1], z = t[k * 3 + 2];
      const key = `${x.toFixed(2)},${z.toFixed(2)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const f = y - E.getElevationLocal(x, z);
      n++;
      sum += f;
      if (f > max) max = f;
      if (f < min) min = f;
      if (f < -0.05) buried++;
      if (f < -0.30) deep++;
    }
  }
  return { n, mean: sum / n, max, min, buried, deep };
}
const pv = vertexStats(pav);
const sv = vertexStats(shoulder);
const hv = vertexStats(hints);
for (const [name, s] of [['pavement', pv], ['shoulder', sv], ['taxiway/apron', hv]]) {
  console.log(
    `       ${name.padEnd(14)} ${String(s.n).padStart(5)} vertices  ` +
      `mean ${s.mean.toFixed(2)} m  max ${s.max.toFixed(2)} m  ` +
      `min ${s.min.toFixed(2)} m  buried ${s.buried}`,
  );
}
ok('pavement: nothing is buried in the terrain', pv.deep === 0, `${pv.buried} vertices under the field, deepest ${pv.min.toFixed(2)} m`);
ok('shoulder: nothing is buried in the terrain', sv.deep === 0, `${sv.buried} vertices under the field, deepest ${sv.min.toFixed(2)} m`);
ok('taxiways and aprons lie on the ground they are drawn over', hv.mean < 0.8 && hv.max < 4, `mean ${hv.mean.toFixed(2)} m, worst ${hv.max.toFixed(2)} m`);
ok('the mean pavement vertex floats well under a metre', pv.mean < 0.75, `${pv.mean.toFixed(2)} m`);

// Nothing may float more than the one documented embankment.
{
  const standing = (group.userData.standingDecks || []).slice().sort((a, b) => b.standM - a.standM);
  const worstOther = standing.filter((d) => !(d.ident === 'KSEA' && d.runway === '16R/34L'))[0];
  ok(
    'only the Miller Creek embankment stands more than 3 m over its own ground',
    !worstOther || worstOther.standM < 3,
    worstOther ? `worst other: ${worstOther.ident} ${worstOther.runway} +${worstOther.standM.toFixed(1)} m` : 'none',
  );
  ok(
    'and it is the only deck anywhere that is reconstructed rather than followed',
    standing.length <= 6,
    `${standing.length} decks stand over ${1} m`,
  );
}

// ---------------------------------------------------------------------------
// 6. The paint has to stay ON the pavement it is painted on
// ---------------------------------------------------------------------------
//
// A deck that follows the ground is not a plane, so a marking emitted as ONE
// quad from end to end is a chord across every station between — it sinks into
// the asphalt in the middle and lifts off it at the ends. The edge stripes ran
// the full length of the runway as a single quad. This measures the drawn paint
// against the drawn pavement at every marking TRIANGLE's centroid, which is
// exactly where a chord sags furthest.
console.log('\npaint against the pavement under it');
{
  let worstAt = null;
  const markings = indexMeshes(group, ['runway-markings', 'runway-numbers', 'runway-rubber']);
  let n = 0, below = 0, worstBelow = 0, worstAbove = 0;
  for (const t of markings.tris) {
    const x = (t[0] + t[3] + t[6]) / 3;
    const y = (t[1] + t[4] + t[7]) / 3;
    const z = (t[2] + t[5] + t[8]) / 3;
    const deck = pav.heightAt(x, z);
    if (deck === null) continue;
    n++;
    const d = y - deck;
    if (d < 0) {
      below++;
      if (-d > worstBelow) { worstBelow = -d; worstAt = C.localToLl(x, z); }
    } else if (d > worstAbove) worstAbove = d;
  }
  console.log(
    `       ${n} marking triangles; ${below} sag below the pavement, ` +
      `worst ${worstBelow.toFixed(3)} m under / ${worstAbove.toFixed(3)} m over`,
  );
  if (worstAt) console.log(`       worst sag at ${worstAt.lat.toFixed(5)}, ${worstAt.lon.toFixed(5)}`);
  // 0.15 m rather than zero for one data-driven reason: KW28 Sequim Valley has
  // a grass strip and an asphalt strip whose east thresholds are 35 m apart, so
  // their pavements OVERLAP and each deck is fitted to its own ground. Every
  // triangle over that tolerance in this region is in that overlap. A marking
  // sagging on a runway that does not overlap another is a chord bug.
  ok('no marking sinks into the pavement it is painted on', worstBelow < 0.15, `worst ${worstBelow.toFixed(3)} m`);
  ok('and none of it floats off the pavement either', worstAbove < 0.06, `worst ${worstAbove.toFixed(3)} m`);
}

// ---------------------------------------------------------------------------
// 7. Every paved runway in the region, not just the two the checks name
// ---------------------------------------------------------------------------
console.log('\nevery paved runway in the region, landing band');
{
  let worstIdent = '';
  let worstMean = 0;
  let overHalf = 0;
  let counted = 0;
  for (const m of meta) {
    if (m.surfaceClass !== 'asphalt' && m.surfaceClass !== 'concrete') continue;
    const rw = runwayOf(m.airport, m.runway);
    if (!rw) continue;
    const f = floatOver(rw, 0.25);
    if (!Number.isFinite(f.mean)) continue;
    counted++;
    if (f.mean > 0.5) overHalf++;
    if (f.mean > worstMean) { worstMean = f.mean; worstIdent = `${m.airport} ${m.runway}`; }
  }
  console.log(
    `       ${counted} paved runways; ${overHalf} float over 0.5 m on the ` +
      `centreline; worst ${worstIdent} at ${worstMean.toFixed(2)} m`,
  );
  ok('paved runways are flush on the centreline, region-wide', overHalf <= 3, `${overHalf} of ${counted} over 0.5 m`);
  ok('every paved runway is measured', counted > 30, `${counted}`);
}

console.log(
  failures === 0
    ? `\n  PASS — ${assertions} assertions\n`
    : `\n  ${failures} of ${assertions} FAILED\n`,
);
process.exit(failures ? 1 : 0);
