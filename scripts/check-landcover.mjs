/**
 * check-landcover.mjs — is the baked land-cover raster actually over Seattle?
 *
 *   npm run check:landcover
 *
 * A land-cover raster is the one kind of baked data where a wrong answer looks
 * completely plausible. A flipped V axis, an off-by-one chunk, a bbox typo —
 * none of them produce an error, a hole or a warning. They produce a world that
 * renders beautifully and puts the forest where the city is. The only defence
 * is to assert the class at coordinates whose answer is known independently.
 *
 * Every expectation below is a place, not a pixel: Mount Rainier's summit is
 * perennial ice, the middle of Elliott Bay is open water, the Space Needle
 * stands in high-intensity development, the Olympic interior is evergreen
 * forest. If one of these fails, the raster moved — not Seattle.
 *
 * Runs against public/landcover/*.png with the same decoder the baker used, so
 * it also exercises scripts/lib/png.mjs. Skips (exit 0) when nothing is baked,
 * because §1.6 says a missing bake is a degraded world, not a broken build.
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PUBLIC_DIR } from './lib/util.mjs';
import { decodePng } from './lib/png.mjs';

const manifestPath = resolve(PUBLIC_DIR, 'landcover/manifest.json');
if (!existsSync(manifestPath)) {
  console.log('\nno public/landcover/manifest.json — run `npm run bake:landcover`. Skipping.\n');
  process.exit(0);
}

const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const names = new Map(manifest.classes.map((c) => [c.index, c.name]));

let failures = 0;
const ok = (name, cond, note = '') => {
  if (cond) console.log(`  ok   ${name}${note ? `  (${note})` : ''}`);
  else {
    failures++;
    console.log(`  FAIL ${name}${note ? `  (${note})` : ''}`);
  }
};

/** Decoded layers, keyed by manifest name. */
const layers = {};
for (const spec of manifest.layers) {
  const file = resolve(PUBLIC_DIR, spec.file);
  if (!existsSync(file)) continue;
  const img = decodePng(readFileSync(file));
  layers[spec.name] = { spec, img };
}

/** Compact class index at lat/lon in one layer, or -1 outside it. */
function classAt(layerName, lat, lon) {
  const L = layers[layerName];
  if (!L) return -1;
  const b = L.spec.bbox;
  if (lat < b.south || lat > b.north || lon < b.west || lon > b.east) return -1;
  const x = Math.min(L.spec.width - 1, Math.floor(((lon - b.west) / (b.east - b.west)) * L.spec.width));
  const y = Math.min(L.spec.height - 1, Math.floor(((b.north - lat) / (b.north - b.south)) * L.spec.height));
  return L.img.rgba[(y * L.spec.width + x) * 4 + 1];
}

/** Majority class over a small box, so one stray 30 m texel cannot fail a check. */
function majorityAt(layerName, lat, lon, halfDeg = 0.004) {
  const counts = new Map();
  for (let i = -2; i <= 2; i++) {
    for (let j = -2; j <= 2; j++) {
      const c = classAt(layerName, lat + (i * halfDeg) / 2, lon + (j * halfDeg) / 2);
      if (c < 0) continue;
      counts.set(c, (counts.get(c) || 0) + 1);
    }
  }
  let best = -1;
  let bestN = 0;
  for (const [c, n] of counts) if (n > bestN) { bestN = n; best = c; }
  return best;
}

console.log('\nlayers');
{
  ok('a region layer was baked', !!layers.region);
  for (const spec of manifest.layers) {
    const L = layers[spec.name];
    ok(`${spec.name} decodes at the declared size`, !!L && L.img.width === spec.width && L.img.height === spec.height,
      L ? `${L.img.width}x${L.img.height}` : 'missing');
  }
  const r = layers.region?.spec;
  if (r) {
    ok('region covers the whole REGION_BBOX', r.bbox.south <= 46.4 && r.bbox.north >= 48.3 && r.bbox.west <= -123.4 && r.bbox.east >= -121.2);
    ok('region texels are near-square', Math.abs(r.metresPerTexel.x / r.metresPerTexel.z - 1) < 0.1,
      `${r.metresPerTexel.x} x ${r.metresPerTexel.z} m`);
  }
}

// Class indices, from src/geo/landcover.js CLASSES. Kept literal on purpose:
// if someone renumbers them, this file should fail rather than follow along.
const WATER = 1, ICE = 2, DEV_HIGH = 6, EVERGREEN = 9;
const DEVELOPED = [3, 4, 5, 6];
const FOREST = [8, 9, 10];

console.log('\ngeoreferencing — places whose land cover is known independently');
{
  // Ice: 0.3% of the region. Landing it on Rainier's summit is the single
  // strongest evidence that the raster is where it says it is.
  ok('Mount Rainier summit is perennial ice/snow', classAt('region', 46.8517, -121.7603) === ICE,
    names.get(classAt('region', 46.8517, -121.7603)));

  ok('mid Elliott Bay is open water', majorityAt('region', 47.6000, -122.3900) === WATER);
  ok('mid Lake Washington is open water', majorityAt('region', 47.6250, -122.2550) === WATER);
  ok('the Strait of Juan de Fuca is open water', majorityAt('region', 48.2400, -123.1000) === WATER);

  const sn = classAt('region', 47.6204, -122.3491);
  ok('the Space Needle stands in high-intensity development', sn === DEV_HIGH, names.get(sn));
  ok('downtown Seattle is developed', DEVELOPED.includes(majorityAt('region', 47.6062, -122.3321)));
  ok('Bellevue is developed', DEVELOPED.includes(majorityAt('region', 47.6145, -122.1985)));

  ok('the Olympic interior is evergreen forest', majorityAt('region', 47.7500, -123.3000) === EVERGREEN,
    names.get(majorityAt('region', 47.7500, -123.3000)));
  ok('the Cascade interior is forest', FOREST.includes(majorityAt('region', 47.5000, -121.5000)),
    names.get(majorityAt('region', 47.5000, -121.5000)));

  // North is UP in the raster. A flipped V axis would put Rainier's ice in the
  // Strait, which the checks above would catch — this states the rule directly.
  const northIsWater = majorityAt('region', 48.2400, -122.7000);
  const southIsLand = majorityAt('region', 46.6000, -122.7000);
  ok('north edge is water and south edge is land — V axis not flipped',
    northIsWater === WATER && southIsLand !== WATER,
    `${names.get(northIsWater)} / ${names.get(southIsLand)}`);
}

console.log('\ndetail inset');
if (layers.detail) {
  const d = layers.detail.spec;
  ok('detail covers KBFI, KSEA and downtown',
    d.bbox.south <= 47.44 && d.bbox.north >= 47.63 && d.bbox.west <= -122.35 && d.bbox.east >= -122.29);
  ok('detail is finer than the region', d.metresPerTexel.x < layers.region.spec.metresPerTexel.x / 2,
    `${d.metresPerTexel.x} m vs ${layers.region.spec.metresPerTexel.x} m`);
  ok('detail agrees with region on the Space Needle',
    classAt('detail', 47.6204, -122.3491) === classAt('region', 47.6204, -122.3491));
  ok('detail agrees with region on Elliott Bay',
    majorityAt('detail', 47.6000, -122.3900) === WATER);
} else {
  console.log('  (no detail layer baked)');
}

console.log('\nroads — TIGER/Line centrelines burned into the blue channel');
{
  const roadAt = (layerName, lat, lon) => {
    const L = layers[layerName];
    if (!L) return 0;
    const b = L.spec.bbox;
    const x = Math.min(L.spec.width - 1, Math.floor(((lon - b.west) / (b.east - b.west)) * L.spec.width));
    const y = Math.min(L.spec.height - 1, Math.floor(((b.north - lat) / (b.north - b.south)) * L.spec.height));
    return L.img.rgba[(y * L.spec.width + x) * 4 + 2];
  };
  /** Any road texel within ~120 m — the burn is a centreline, not an area. */
  const roadNear = (layerName, lat, lon, n = 3) => {
    let best = 0;
    for (let i = -n; i <= n; i++)
      for (let j = -n; j <= n; j++)
        best = Math.max(best, roadAt(layerName, lat + i * 0.0006, lon + j * 0.0008));
    return best;
  };

  const anyRoads = Object.values(layers).some((L) => {
    for (let i = 2; i < L.img.rgba.length; i += 4 * 997) if (L.img.rgba[i] > 0) return true;
    return false;
  });
  if (!anyRoads) {
    console.log('  (no road mask in this bake — TIGER was unavailable)');
  } else {
    // I-5 through the Ship Canal, and the I-90 crossing of Lake Washington.
    ok('I-5 is marked near 47.66, -122.32', roadNear('detail', 47.6600, -122.3225) >= 160,
      `${roadNear('detail', 47.6600, -122.3225)}`);
    ok('I-90 is marked mid Lake Washington', roadNear('detail', 47.5900, -122.2600) >= 160,
      `${roadNear('detail', 47.5900, -122.2600)}`);
    ok('open water well off any bridge carries no road', roadNear('detail', 47.6400, -122.4300) === 0);
  }
}

console.log(failures ? `\n${failures} check(s) FAILED\n` : '\nall land-cover checks passed\n');
process.exit(failures ? 1 : 0);
