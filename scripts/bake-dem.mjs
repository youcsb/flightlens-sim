/**
 * bake-dem.mjs — download real elevation tiles into public/dem/.
 *
 *   node scripts/bake-dem.mjs [--levels=11,13,14] [--force]
 *
 * Bakes THREE levels by default:
 *   z=11  whole region, 238 tiles    — the pinned base (see BASE_ZOOM)
 *   z=13  whole region, 3,380 tiles  — the paged working layer (see MID_ZOOM)
 *   z=14  Seattle inset, 560 tiles   — the paged approach layer (see FINE_ZOOM)
 *
 * Re-runs skip anything already on disk, so it is cheap to repeat.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS SCRIPT EXISTS AT ALL
 * ---------------------------------------------------------------------------
 * Source: https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png
 *
 * That bucket sends NO access-control-allow-origin header — verified, the
 * response header is literally absent. A browser can DISPLAY those images but
 * cannot READ them: drawing one into a canvas taints it, and getImageData()
 * then throws SecurityError. Since the entire point is to read pixel values as
 * elevation, the tiles are unusable from browser JS. There is no client-side
 * workaround; a proxy would just be this script running at request time.
 *
 * So we download once, at build time, and serve same-origin. The sim then also
 * works offline and in a static production build.
 *
 * ---------------------------------------------------------------------------
 * OUTPUT CONTRACT — src/geo/elevation.js depends on exactly this
 * ---------------------------------------------------------------------------
 * Tiles:     public/dem/{z}/{x}/{y}.png   verbatim bytes, no re-encoding.
 *            Do NOT convert, resize or recompress: the elevation is carried in
 *            the exact 8-bit RGB triples and any lossy step destroys it.
 *
 * Manifest:  public/dem/manifest.json
 *   {
 *     "generated": "2026-08-06T...",
 *     "source": "https://s3.amazonaws.com/elevation-tiles-prod/terrarium",
 *     "encoding": "terrarium",
 *     "levels": [
 *       {
 *         "zoom": 11,
 *         "tileSize": 256,
 *         "bbox": { "south":46.4, "north":48.3, "west":-123.4, "east":-121.2 },
 *         "tiles": ["321/709", "321/710", ...]   // "x/y", only ones on disk
 *       }
 *     ]
 *   }
 *
 * The `tiles` list lets the runtime skip fetching tiles that were never
 * written. It is advisory — a missing manifest degrades to "try everything".
 *
 * ---------------------------------------------------------------------------
 * VERIFIED FACTS — do not re-derive these
 * ---------------------------------------------------------------------------
 *   - Tiles are 256x256, 8-bit, colour type 2 (truecolour RGB).
 *   - elevation_metres = (R * 256 + G + B / 256) - 32768
 *   - Size varies a lot with terrain: a flat ocean tile is ~5 kB, the Mount
 *     Rainier tile (11/331/721) is 145 kB. Budget from the measured totals
 *     below, not from an assumed average.
 *   - Tile counts and coverage for our bbox (recounted this round):
 *       z=9      20 tiles   207 m/px
 *       z=10     72 tiles   104 m/px
 *       z=11    238 tiles    51.8 m/px  <- BASE, pinned resident
 *       z=12    891 tiles    25.9 m/px
 *       z=13  3,380 tiles    12.95 m/px <- MID, region-wide, paged
 *       z=14 13,158 tiles     6.47 m/px <- region-wide is ~1.1 GB. Inset only.
 *       z=15 51,712 tiles     3.24 m/px <- see the z=15 note under FINE_ZOOM
 *     The Seattle inset (47.35..47.75, -122.5..-122.1) is 560 tiles at z=14.
 *   - Layers are additive at runtime and elevation.js pages the fine ones in
 *     and out around the aircraft; only z=11 stays resident for the whole
 *     flight. See src/geo/elevation.js § PAGING.
 */

import { existsSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  PUBLIC_DIR,
  REGION_BBOX,
  tileRange,
  parseArgs,
  writeJson,
  writeBinary,
  get,
  mapLimit,
} from './lib/util.mjs';

const SOURCE = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium';

/**
 * ---------------------------------------------------------------------------
 * THE RESOLUTION BUDGET — why these three levels and not others
 * ---------------------------------------------------------------------------
 * Round 1 shipped z=11 region-wide plus a z=13 Seattle inset, and the geography
 * critic's headline finding was that 51.8 m/px covered ~95% of the region while
 * the terrain mesh's finest node draws at 512 m / 64 cells = 8 m. The mesh was
 * interpolating a grid 6.5x coarser than it drew: Rainier, the Olympics, the
 * whole Cascade front, Tacoma and Everett were all soft.
 *
 * So the base layer moves to z=13 REGION-WIDE (12.95 m/px, a 4x linear
 * improvement), which is the resolution GeoFS gets from Cesium World Terrain,
 * and the inset moves to z=14.
 *
 * MEASURED, not assumed. For each pair I downloaded the child tile and its
 * parent, bilinearly upsampled the parent, and took the RMS of the difference —
 * i.e. how much information the finer level actually carries that the coarser
 * one does not:
 *
 *   place       z13 -> z14            z14 -> z15
 *   KSEA        RMS 0.287 m  max 3.2  RMS 0.046 m  max 1.2
 *   KBFI        RMS 0.280 m  max 3.4  RMS 0.058 m  max 1.2
 *   downtown    (z13 tile has a void) RMS 0.184 m  max 2.6
 *   Cascades    RMS 0.394 m  max 3.1  RMS 0.197 m  max 1.1
 *
 * z=14 is real: 3.4 m of vertical that z=13 does not have, on the ground the
 * wheels touch. z=15 is not — 5 cm RMS over the airports is upsampling, which
 * is exactly what you expect when the underlying source is 3DEP 1/3 arc-second
 * (~10 m). Baking 4,048 z=15 tiles to gain 5 cm would be paying for a number
 * that is smaller than the source's own vertical accuracy. NOT BAKED, on
 * purpose. If 3DEP ever publishes 1/9 arc-second here, re-run this probe first.
 */

/** Pinned base: the whole region, permanently resident. 238 tiles, ~29 MB. */
const BASE_ZOOM = 11;

/** Paged working layer: the whole region at 12.95 m/px. 3,380 tiles. */
const MID_ZOOM = 13;

/**
 * Paged approach layer: 6.47 m/px over the Seattle inset. 560 tiles.
 * Region-wide z=14 would be 13,158 tiles and roughly 1.1 GB — see the header.
 */
const FINE_ZOOM = 14;
const FINE_BBOX = {
  south: 47.35,
  north: 47.75,
  west: -122.5,
  east: -122.1,
};

/**
 * Parallel downloads. S3 would tolerate far more, but this is somebody else's
 * free public bucket. A cold bake is now ~4,200 tiles rather than ~380, so 10
 * sockets finishes in a couple of minutes and still cannot be mistaken for
 * abuse. Re-runs skip what is on disk and cost seconds.
 */
const CONCURRENCY = 10;

/** Transient-failure policy: 3 attempts, 400 ms / 800 ms / 1600 ms backoff. */
const MAX_ATTEMPTS = 3;
const BACKOFF_MS = 400;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Fetch one tile's bytes, retrying transient failures.
 *
 * Distinguishes three outcomes, because conflating them is how a bake quietly
 * produces a world with holes in it:
 *   - Buffer  the tile exists and we have it.
 *   - null    the server says it does not exist (403/404). Terrarium answers
 *             403 for tiles outside its coverage; that is data, not an error.
 *   - throw   we could not find out. Never written, never silently skipped.
 *
 * @param {string} url
 * @returns {Promise<Buffer|null>}
 */
async function fetchTile(url) {
  let lastErr;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const res = await get(url);
      return Buffer.from(await res.arrayBuffer());
    } catch (err) {
      // A definitive "not here" is an answer; do not burn retries on it.
      if (/HTTP (403|404)\b/.test(err.message)) return null;
      lastErr = err;
      if (attempt < MAX_ATTEMPTS) await sleep(BACKOFF_MS * 2 ** (attempt - 1));
    }
  }
  throw lastErr;
}

/**
 * Download every tile covering `bbox` at `zoom` and return the manifest level.
 *
 * @param {{south:number,north:number,west:number,east:number}} bbox
 * @param {number} zoom
 * @param {boolean} force Re-download tiles that already exist on disk.
 * @returns {Promise<{zoom:number, tileSize:number, bbox:object, tiles:string[]}>}
 */
async function bakeLevel(bbox, zoom, force) {
  const range = tileRange(bbox, zoom);
  console.log(
    `  z=${zoom}: x ${range.minX}..${range.maxX}, y ${range.minY}..${range.maxY}` +
      ` = ${range.count} tiles`,
  );

  /** @type {Array<{x:number,y:number}>} */
  const wanted = [];
  for (let x = range.minX; x <= range.maxX; x++) {
    for (let y = range.minY; y <= range.maxY; y++) wanted.push({ x, y });
  }

  let downloaded = 0;
  let cached = 0;
  let absent = 0;
  let bytes = 0;
  let done = 0;
  const tStart = Date.now();

  const results = await mapLimit(wanted, CONCURRENCY, async ({ x, y }) => {
    const rel = `dem/${zoom}/${x}/${y}.png`;
    const abs = resolve(PUBLIC_DIR, rel);
    const key = `${x}/${y}`;

    let outcome = key;

    if (!force && existsSync(abs)) {
      // Re-runs are cheap: an existing file is trusted and never re-fetched.
      // `--force` is the escape hatch if a bake was ever interrupted mid-write.
      cached++;
      bytes += statSync(abs).size;
    } else {
      // Bytes go to disk VERBATIM. Terrarium carries elevation in the exact
      // 8-bit RGB triples, so any re-encode — even a "lossless" one that
      // changes the colour type or adds an alpha channel — corrupts the data.
      const buf = await fetchTile(`${SOURCE}/${zoom}/${x}/${y}.png`);
      if (buf === null) {
        absent++;
        outcome = null; // genuinely not published; omit from the manifest
      } else {
        await writeBinary(rel, buf);
        downloaded++;
        bytes += buf.length;
      }
    }

    done++;
    if (done % 250 === 0 || done === wanted.length) {
      const secs = (Date.now() - tStart) / 1000;
      console.log(
        `    ${done}/${wanted.length}  ` +
          `(${downloaded} new, ${cached} cached, ${absent} absent, ` +
          `${(bytes / 1048576).toFixed(1)} MB, ` +
          `${(done / Math.max(secs, 0.001)).toFixed(0)} tiles/s)`,
      );
    }
    return outcome;
  });

  const tiles = results.filter((t) => t !== null);
  console.log(
    `  z=${zoom}: ${tiles.length} tiles on disk, ${(bytes / 1048576).toFixed(1)} MB`,
  );

  return { zoom, tileSize: 256, bbox, tiles };
}

/**
 * The three levels, coarsest first. `paged` is advisory metadata for the
 * runtime: it says this level is too big to hold decoded and must be streamed.
 * elevation.js decides its own policy, but writing the intent into the manifest
 * means a future bake that quietly doubles a level cannot silently blow the
 * runtime's memory cap without the manifest disagreeing with it.
 */
const LEVELS = [
  { zoom: BASE_ZOOM, bbox: REGION_BBOX, paged: false },
  { zoom: MID_ZOOM, bbox: REGION_BBOX, paged: true },
  { zoom: FINE_ZOOM, bbox: FINE_BBOX, paged: true },
];

async function main() {
  const args = parseArgs();
  const force = Boolean(args.force);

  // --levels=11,13 bakes a subset. --zoom=N is kept as an alias for the old
  // single-level invocation so anything scripted against it still works.
  let wanted = LEVELS;
  if (args.levels) {
    const keep = new Set(String(args.levels).split(',').map(Number));
    wanted = LEVELS.filter((l) => keep.has(l.zoom));
  } else if (args.zoom) {
    wanted = LEVELS.filter((l) => l.zoom === Number(args.zoom));
  }

  console.log(`Baking DEM from ${SOURCE}`);
  const t0 = Date.now();

  // Existing levels are preserved when only a subset is baked, so a partial
  // re-run cannot amputate the manifest and leave the runtime with no base.
  /** @type {Array<object>} */
  let levels = [];
  const prior = resolve(PUBLIC_DIR, 'dem/manifest.json');
  if (existsSync(prior)) {
    try {
      levels = JSON.parse(await readFile(prior, 'utf8')).levels ?? [];
    } catch {
      levels = [];
    }
  }

  for (const spec of wanted) {
    const level = await bakeLevel(spec.bbox, spec.zoom, force);
    level.paged = spec.paged;
    const at = levels.findIndex((l) => l.zoom === spec.zoom);
    if (at >= 0) levels[at] = level;
    else levels.push(level);
  }
  levels.sort((a, b) => a.zoom - b.zoom);

  await writeJson('dem/manifest.json', {
    generated: new Date().toISOString(),
    source: SOURCE,
    encoding: 'terrarium',
    levels,
  });

  const total = levels.reduce((n, l) => n + l.tiles.length, 0);
  console.log(
    `\n${total} tiles across ${levels.length} levels in ` +
      `${((Date.now() - t0) / 1000).toFixed(1)} s`,
  );
}

main().catch((err) => {
  console.error(err.message);
  process.exitCode = 1;
});
