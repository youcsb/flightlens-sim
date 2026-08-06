/**
 * bake-landcover.mjs — real land cover + real road centrelines -> public/landcover/
 *
 *   node scripts/bake-landcover.mjs [--force] [--no-roads] [--region-only]
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS
 * ---------------------------------------------------------------------------
 * The terrain's SHAPE has been real since bake-dem.mjs. Its COLOUR was not: the
 * surface shader knew elevation and slope and nothing else, so every square
 * metre below the treeline — downtown Seattle, the Kent Valley farms, Discovery
 * Park, the Duwamish industrial flats — came out the same lowland green. From
 * 600 m that is the single thing that reads as "not a real place".
 *
 * The user's rule is "no satellite imagery, but make the land as close to real
 * as possible". A land-cover CLASSIFICATION is not imagery: it is 15 integers
 * saying what is on the ground, at 30 m, from a published survey. The surface
 * material stays procedural — it just gets told what it is painting.
 *
 * ---------------------------------------------------------------------------
 * SOURCES (probed live before this script was written)
 * ---------------------------------------------------------------------------
 * 1. NLCD 2021 Land Cover (CONUS), via the USGS/MRLC public WMS:
 *      https://www.mrlc.gov/geoserver/mrlc_display/NLCD_2021_Land_Cover_L48/wms
 *    30 m, the authoritative US land-cover product. The WMS returns the STYLED
 *    raster (the standard NLCD colour ramp), not raw class values, so this
 *    script maps each pixel back to its class by nearest legend colour. The
 *    palette is 15-ish widely separated colours and the returned PNG is
 *    palette-indexed, so the match is exact in practice — the tolerance below
 *    is there to catch a legend change loudly rather than to do real work.
 *
 * 2. TIGER/Line roads, via the Census Bureau's TIGERweb ArcGIS REST service:
 *      https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/Transportation
 *    Primary roads (MTFCC S1100 — the Interstates and their ramps) and
 *    secondary roads (S1200 — US and state highways). Real centrelines, so I-5,
 *    I-90, I-405, SR-99 and the SR-520 floating bridge land where they are.
 *
 * OSM/Overpass was probed and returned 504, same as when scripts/README.md was
 * written. It is not used. Do not add a dependency on it.
 *
 * ---------------------------------------------------------------------------
 * OUTPUT CONTRACT — src/geo/landcover.js parses exactly this
 * ---------------------------------------------------------------------------
 *   public/landcover/manifest.json
 *     { generated, sources[], classes[{index,name,nlcd[]}], layers:[
 *         { name:"region"|"detail", file, width, height, bbox, metresPerTexel } ] }
 *   public/landcover/region.png    RGB8, colour type 2, NOT a picture:
 *   public/landcover/detail.png      R = NLCD class code (0, 11..95)
 *                                    G = compact class index 0..14
 *                                    B = road mask: 0 none, 255 primary,
 *                                        160 secondary
 *
 * R is redundant with G and is kept anyway: it is the provenance. If someone
 * later doubts a texel, R says "NLCD 42, evergreen forest" and can be checked
 * against the published raster. G is what the shader indexes.
 *
 * Colour type 2 is deliberate — it is what the Terrarium DEM tiles use, and
 * that path is already proven in this project to survive Image -> canvas ->
 * getImageData with every channel byte intact. These bytes are data.
 *
 * ---------------------------------------------------------------------------
 * RESOLUTION — why these numbers
 * ---------------------------------------------------------------------------
 * region 2048 x 2560 over 46.4..48.3 / -123.4..-121.2  ->  81 m x 82 m texels.
 *   Nearly square, which matters because the shader jitters the lookup by a
 *   texel and an anisotropic jitter would smear one axis.
 * detail 1536 x 2048 over the Seattle inset                ->  20 m x 22 m texels.
 *   Slightly finer than NLCD's own 30 m, so the WMS resample is the limit and
 *   not this grid. Below ~500 m AGL this is the layer the eye is reading.
 *
 * Together ~9 M texels. They compress to a few hundred kB because land cover is
 * large flat runs of one value; see encodePngRGB for why filter 0 is used.
 */

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  PUBLIC_DIR,
  REGION_BBOX,
  parseArgs,
  writeJson,
  writeBinary,
  USER_AGENT,
} from './lib/util.mjs';
import { decodePng, encodePngRGB } from './lib/png.mjs';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const WMS =
  'https://www.mrlc.gov/geoserver/mrlc_display/NLCD_2021_Land_Cover_L48/wms';
const WMS_LAYER = 'NLCD_2021_Land_Cover_L48';

const TIGER =
  'https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/Transportation/MapServer';
/** Layer 2 is "Primary Roads" at full detail; 6 is "Secondary Roads 72_1k". */
const TIGER_PRIMARY = 2;
const TIGER_SECONDARY = 6;

/** Matches DETAIL_BBOX in src/geo/elevation.js. Keep the two in step. */
const DETAIL_BBOX = { south: 47.35, north: 47.75, west: -122.5, east: -122.1 };

const LAYERS = [
  { name: 'region', bbox: REGION_BBOX, width: 2048, height: 2560, roads: 'primary' },
  { name: 'detail', bbox: DETAIL_BBOX, width: 1536, height: 2048, roads: 'both' },
];

/** WMS requests are tiled at this size. Big enough to be few, small enough to retry cheaply. */
const WMS_CHUNK = 512;

// ---------------------------------------------------------------------------
// The NLCD legend, and the compact classes the shader actually uses
// ---------------------------------------------------------------------------

/**
 * Published NLCD colour ramp. The PNG the WMS returns is palette-quantised, so
 * the bytes come back within a couple of counts of these; nearest-match handles
 * it and MAX_COLOUR_DIST rejects anything genuinely unrecognised.
 */
const NLCD_LEGEND = [
  { code: 11, rgb: [0x46, 0x6b, 0x9f], name: 'Open Water', index: 1 },
  { code: 12, rgb: [0xd1, 0xde, 0xf8], name: 'Perennial Ice/Snow', index: 2 },
  { code: 21, rgb: [0xde, 0xc5, 0xc5], name: 'Developed, Open Space', index: 3 },
  { code: 22, rgb: [0xd9, 0x92, 0x82], name: 'Developed, Low Intensity', index: 4 },
  { code: 23, rgb: [0xeb, 0x00, 0x00], name: 'Developed, Medium Intensity', index: 5 },
  { code: 24, rgb: [0xab, 0x00, 0x00], name: 'Developed, High Intensity', index: 6 },
  { code: 31, rgb: [0xb3, 0xac, 0x9f], name: 'Barren Land', index: 7 },
  { code: 41, rgb: [0x68, 0xab, 0x63], name: 'Deciduous Forest', index: 8 },
  { code: 42, rgb: [0x1c, 0x5f, 0x2c], name: 'Evergreen Forest', index: 9 },
  { code: 43, rgb: [0xb5, 0xc5, 0x8f], name: 'Mixed Forest', index: 10 },
  { code: 52, rgb: [0xcc, 0xb8, 0x79], name: 'Shrub/Scrub', index: 11 },
  { code: 71, rgb: [0xdf, 0xdf, 0xc2], name: 'Grassland/Herbaceous', index: 12 },
  { code: 81, rgb: [0xdc, 0xd9, 0x39], name: 'Pasture/Hay', index: 13 },
  { code: 82, rgb: [0xab, 0x6c, 0x28], name: 'Cultivated Crops', index: 14 },
  { code: 90, rgb: [0xb8, 0xd9, 0xeb], name: 'Woody Wetlands', index: 15 },
  { code: 95, rgb: [0x6c, 0x9f, 0xb8], name: 'Emergent Herbaceous Wetlands', index: 15 },
];

/**
 * Squared-distance ceiling for accepting a nearest-legend match. The legend
 * colours are far apart (the closest pair is ~60 units) and palette error is
 * ~3, so 40^2 is comfortably inside the gap and still catches "the WMS started
 * returning a different style".
 */
const MAX_COLOUR_DIST = 40 * 40;

/** Everything outside CONUS (ocean, British Columbia) comes back as nodata. */
const NODATA_INDEX = 0;

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

async function getBytes(url, tries = 4) {
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const ct = res.headers.get('content-type') || '';
      const buf = Buffer.from(await res.arrayBuffer());
      // A WMS reports failure as a 200 with an XML ServiceException body.
      if (ct.includes('xml') || buf.subarray(0, 5).toString('latin1') === '<?xml') {
        throw new Error(`service exception: ${buf.toString('utf8', 0, 300)}`);
      }
      return buf;
    } catch (err) {
      last = err;
      await new Promise((r) => setTimeout(r, 800 * (i + 1)));
    }
  }
  throw last;
}

async function getJson(url, tries = 4) {
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (err) {
      last = err;
      await new Promise((r) => setTimeout(r, 800 * (i + 1)));
    }
  }
  throw last;
}

// ---------------------------------------------------------------------------
// NLCD raster
// ---------------------------------------------------------------------------

/**
 * Nearest legend entry, or null when nothing is close enough.
 * Linear scan over 16 entries per pixel would be 150 M comparisons, so results
 * are memoised on the packed RGB — there are only ~20 distinct colours in the
 * whole region.
 */
const colourCache = new Map();
function classify(r, g, b) {
  const key = (r << 16) | (g << 8) | b;
  const hit = colourCache.get(key);
  if (hit !== undefined) return hit;

  let best = null;
  let bestD = Infinity;
  for (const e of NLCD_LEGEND) {
    const dr = r - e.rgb[0];
    const dg = g - e.rgb[1];
    const db = b - e.rgb[2];
    const d = dr * dr + dg * dg + db * db;
    if (d < bestD) { bestD = d; best = e; }
  }
  const out = bestD <= MAX_COLOUR_DIST ? best : null;
  colourCache.set(key, out);
  return out;
}

/**
 * Fill the R (NLCD code) and G (compact index) channels of `rgb` from the WMS.
 *
 * @param {{south:number,north:number,west:number,east:number}} bbox
 * @param {number} width @param {number} height
 * @param {Uint8Array} rgb  width*height*3, written in place
 * @returns {Promise<{unknown:number, nodata:number}>}
 */
async function fetchLandcover(bbox, width, height, rgb) {
  const cols = Math.ceil(width / WMS_CHUNK);
  const rows = Math.ceil(height / WMS_CHUNK);
  let unknown = 0;
  let nodata = 0;
  let done = 0;

  for (let cy = 0; cy < rows; cy++) {
    for (let cx = 0; cx < cols; cx++) {
      const x0 = cx * WMS_CHUNK;
      const y0 = cy * WMS_CHUNK;
      const w = Math.min(WMS_CHUNK, width - x0);
      const h = Math.min(WMS_CHUNK, height - y0);

      // Raster row 0 is the NORTH edge; WMS bbox is minx,miny,maxx,maxy.
      const west = bbox.west + ((bbox.east - bbox.west) * x0) / width;
      const east = bbox.west + ((bbox.east - bbox.west) * (x0 + w)) / width;
      const north = bbox.north - ((bbox.north - bbox.south) * y0) / height;
      const south = bbox.north - ((bbox.north - bbox.south) * (y0 + h)) / height;

      const url =
        `${WMS}?service=WMS&version=1.1.1&request=GetMap` +
        `&layers=${WMS_LAYER}&styles=` +
        `&bbox=${west},${south},${east},${north}` +
        `&width=${w}&height=${h}&srs=EPSG:4326&format=image/png&transparent=true`;

      const img = decodePng(await getBytes(url));
      if (img.width !== w || img.height !== h) {
        throw new Error(`WMS returned ${img.width}x${img.height}, asked ${w}x${h}`);
      }

      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const s = (y * w + x) * 4;
          const d = ((y0 + y) * width + (x0 + x)) * 3;
          if (img.rgba[s + 3] < 128) { nodata++; continue; } // transparent = outside CONUS
          const e = classify(img.rgba[s], img.rgba[s + 1], img.rgba[s + 2]);
          if (!e) { unknown++; continue; }
          rgb[d] = e.code;
          rgb[d + 1] = e.index;
        }
      }

      done++;
      process.stdout.write(`\r  landcover ${done}/${cols * rows} chunks`);
    }
  }
  process.stdout.write('\n');
  return { unknown, nodata };
}

// ---------------------------------------------------------------------------
// TIGER roads
// ---------------------------------------------------------------------------

/**
 * All polylines from one TIGERweb layer intersecting `bbox`, in lon/lat.
 * Paged, because a bbox this size can exceed the service's transfer limit even
 * though maxRecordCount is 100000.
 *
 * @returns {Promise<Array<Array<[number,number]>>>}
 */
async function fetchRoads(layer, bbox) {
  /** @type {Array<Array<[number,number]>>} */
  const paths = [];
  const page = 2000;
  for (let offset = 0; ; offset += page) {
    const url =
      `${TIGER}/${layer}/query?where=1%3D1` +
      `&geometry=${bbox.west},${bbox.south},${bbox.east},${bbox.north}` +
      '&geometryType=esriGeometryEnvelope&inSR=4326' +
      '&spatialRel=esriSpatialRelIntersects&outFields=MTFCC' +
      '&returnGeometry=true&outSR=4326&f=json' +
      `&resultOffset=${offset}&resultRecordCount=${page}`;
    const j = await getJson(url);
    if (j.error) throw new Error(`TIGER layer ${layer}: ${j.error.message}`);
    const feats = j.features || [];
    for (const f of feats) for (const p of f.geometry?.paths || []) paths.push(p);
    if (feats.length < page || !j.exceededTransferLimit) break;
  }
  return paths;
}

/**
 * Stamp polylines into the B channel.
 *
 * Thickness is in TEXELS, applied as a disc swept along each segment at half-
 * texel steps. A freeway corridor with shoulders and ramps is 60-80 m wide, so
 * one 81 m region texel is the honest width there; on the 20 m detail grid a
 * radius of 1.5 texels gives ~60 m, which is right for I-5 and slightly generous
 * for a state highway. Erring wide is correct: a road one texel wide at 20 m
 * disappears under the shader's own jitter.
 */
function burnRoads(paths, bbox, width, height, rgb, radiusTexels, value) {
  const sx = width / (bbox.east - bbox.west);
  const sy = height / (bbox.north - bbox.south);
  const r = Math.max(0.5, radiusTexels);
  const ri = Math.ceil(r);
  let stamped = 0;

  const dot = (px, py) => {
    const x0 = Math.max(0, Math.floor(px) - ri);
    const x1 = Math.min(width - 1, Math.floor(px) + ri);
    const y0 = Math.max(0, Math.floor(py) - ri);
    const y1 = Math.min(height - 1, Math.floor(py) + ri);
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const dx = x + 0.5 - px;
        const dy = y + 0.5 - py;
        if (dx * dx + dy * dy > r * r) continue;
        const d = (y * width + x) * 3 + 2;
        if (rgb[d] < value) { rgb[d] = value; stamped++; }
      }
    }
  };

  for (const path of paths) {
    for (let i = 1; i < path.length; i++) {
      const ax = (path[i - 1][0] - bbox.west) * sx;
      const ay = (bbox.north - path[i - 1][1]) * sy;
      const bx = (path[i][0] - bbox.west) * sx;
      const by = (bbox.north - path[i][1]) * sy;
      const len = Math.hypot(bx - ax, by - ay);
      const n = Math.max(1, Math.ceil(len * 2));
      for (let k = 0; k <= n; k++) dot(ax + ((bx - ax) * k) / n, ay + ((by - ay) * k) / n);
    }
  }
  return stamped;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const args = parseArgs();
const wantRoads = !args['no-roads'];
const only = args['region-only'] ? ['region'] : null;

const manifestPath = resolve(PUBLIC_DIR, 'landcover/manifest.json');
if (existsSync(manifestPath) && !args.force) {
  console.log('public/landcover/manifest.json exists — pass --force to re-bake.');
  process.exit(0);
}

const layersOut = [];

for (const layer of LAYERS) {
  if (only && !only.includes(layer.name)) continue;
  const { name, bbox, width, height } = layer;
  console.log(
    `\n${name}: ${width}x${height} over ${bbox.south}..${bbox.north}, ${bbox.west}..${bbox.east}`,
  );

  const rgb = new Uint8Array(width * height * 3);
  const stats = await fetchLandcover(bbox, width, height, rgb);
  if (stats.unknown > 0) {
    console.warn(
      `  WARNING: ${stats.unknown} pixels matched no NLCD legend colour. ` +
        'The MRLC style may have changed — check NLCD_LEGEND.',
    );
  }

  let roadTexels = 0;
  if (wantRoads) {
    try {
      const primary = await fetchRoads(TIGER_PRIMARY, bbox);
      roadTexels += burnRoads(primary, bbox, width, height, rgb, name === 'detail' ? 1.5 : 0.9, 255);
      console.log(`  roads: ${primary.length} primary paths`);
      if (layer.roads === 'both') {
        const secondary = await fetchRoads(TIGER_SECONDARY, bbox);
        roadTexels += burnRoads(secondary, bbox, width, height, rgb, 0.8, 160);
        console.log(`  roads: ${secondary.length} secondary paths`);
      }
    } catch (err) {
      console.warn(`  WARNING: roads unavailable (${err.message}); land cover only.`);
    }
  }

  // Histogram, printed so a bad bake is obvious without opening the PNG.
  const hist = new Map();
  for (let i = 0; i < width * height; i++) hist.set(rgb[i * 3 + 1], (hist.get(rgb[i * 3 + 1]) || 0) + 1);
  const total = width * height;
  const named = new Map(NLCD_LEGEND.map((e) => [e.index, e.name]));
  named.set(NODATA_INDEX, 'nodata (ocean / outside CONUS)');
  console.log(
    [...hist.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([i, n]) => `    ${String(i).padStart(2)} ${named.get(i) || '?'}: ${((n / total) * 100).toFixed(1)}%`)
      .join('\n'),
  );
  console.log(`  road texels: ${roadTexels}`);

  const png = encodePngRGB(width, height, rgb);
  await writeBinary(`landcover/${name}.png`, png);
  console.log(`  wrote public/landcover/${name}.png (${(png.length / 1024).toFixed(0)} kB)`);

  const mLat = 111132.9;
  const mLon = 111320 * Math.cos((((bbox.south + bbox.north) / 2) * Math.PI) / 180);
  layersOut.push({
    name,
    file: `landcover/${name}.png`,
    width,
    height,
    bbox,
    metresPerTexel: {
      x: +(((bbox.east - bbox.west) * mLon) / width).toFixed(2),
      z: +(((bbox.north - bbox.south) * mLat) / height).toFixed(2),
    },
  });
}

const classes = [{ index: NODATA_INDEX, name: 'nodata', nlcd: [] }];
for (const e of NLCD_LEGEND) {
  const c = classes.find((x) => x.index === e.index);
  if (c) c.nlcd.push(e.code);
  else classes.push({ index: e.index, name: e.name, nlcd: [e.code] });
}

await writeJson('landcover/manifest.json', {
  generated: new Date().toISOString(),
  sources: [
    { name: 'NLCD 2021 Land Cover (CONUS)', url: WMS, note: 'USGS/MRLC, 30 m' },
    ...(wantRoads
      ? [{ name: 'TIGER/Line roads', url: TIGER, note: 'US Census Bureau, MTFCC S1100/S1200' }]
      : []),
  ],
  encoding: {
    r: 'NLCD class code (0 = nodata, else 11..95)',
    g: 'compact class index 0..15, see classes[]',
    b: 'road mask: 0 none, 160 secondary, 255 primary',
  },
  classes: classes.sort((a, b) => a.index - b.index),
  layers: layersOut,
});
console.log('\nwrote public/landcover/manifest.json');
