/**
 * bake-dem.mjs — download real elevation tiles into public/dem/.
 *
 *   node scripts/bake-dem.mjs [--zoom=11] [--skip-detail] [--force]
 *
 * Bakes two levels by default: z=11 over the whole region and a z=13 inset over
 * Seattle. Re-runs skip anything already on disk, so it is cheap to repeat.
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
 *   - Tile counts and coverage for our bbox:
 *       z=9   20 tiles    207 m/px
 *       z=10  72 tiles    104 m/px
 *       z=11  238 tiles    52 m/px   <- BASE. Mount Rainier reads correctly.
 *       z=12  891 tiles    26 m/px
 *       z=13  3380 tiles   13 m/px   <- far too many for the full region
 *     The Seattle DETAIL inset (47.35..47.75, -122.5..-122.1) at z=13 is only
 *     ~140 tiles, which is the cheap way to get crisp ground near the airports.
 *   - Layers are additive at runtime: bake z=11 over everything AND z=13 over
 *     the inset, and elevation.js prefers the finer one where it exists.
 */

import { existsSync, statSync } from 'node:fs';
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
 * Base level: the whole region.
 *
 * WHY 11 AND NOT 12. The choice is a resolution budget, and the budget is
 * better spent unevenly than uniformly.
 *
 *   z=10   72 tiles   104 m/px   Rainier's summit gets ~40 samples across its
 *                                cone. It reads as a lump, not a mountain.
 *   z=11  238 tiles    52 m/px   <- BASE. Enough to resolve Rainier's ridges and
 *                                glacial valleys, the Duwamish valley walls, and
 *                                a Puget Sound coastline that matches a map.
 *   z=12  891 tiles    26 m/px   4x the bytes of z=11 for detail that is below
 *                                one screen pixel at any altitude you would
 *                                cruise the region at.
 *
 * The thing z=11 is genuinely too coarse for is the last 500 ft of an approach,
 * where 52 m/px is a third of a runway length. But that only matters within a
 * few km of the airports — so instead of paying z=12 over 40,000 km^2 of
 * saltwater and Cascade foothills nobody lands on, we pay z=13 (13 m/px) over
 * the 1,200 km^2 Seattle inset that actually contains KBFI, KSEA and downtown.
 * ~140 tiles buys 4x the base resolution exactly where the wheels touch.
 *
 * elevation.js samples layers finest-first, so the two levels compose with no
 * seam handling and no caller awareness. Total ~380 tiles.
 */
const BASE_ZOOM = 11;

/** Optional detail level over Seattle — see the header for the tile count. */
const DETAIL_ZOOM = 13;
const DETAIL_BBOX = {
  south: 47.35,
  north: 47.75,
  west: -122.5,
  east: -122.1,
};

/**
 * Parallel downloads. S3 would tolerate far more, but this is somebody else's
 * free public bucket and a cold bake is only ~380 tiles; 8 sockets finishes in
 * well under a minute and cannot be mistaken for abuse.
 */
const CONCURRENCY = 8;

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
    if (done % 50 === 0 || done === wanted.length) {
      console.log(
        `    ${done}/${wanted.length}  ` +
          `(${downloaded} new, ${cached} cached, ${absent} absent, ` +
          `${(bytes / 1048576).toFixed(1)} MB)`,
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

async function main() {
  const args = parseArgs();
  const zoom = args.zoom ? Number(args.zoom) : BASE_ZOOM;
  const force = Boolean(args.force);

  console.log(`Baking DEM from ${SOURCE}`);

  const levels = [];
  levels.push(await bakeLevel(REGION_BBOX, zoom, force));

  // The inset is on by default — z=11 alone is too coarse under the wheels on
  // short final, which is precisely where the user will be looking. Pass
  // --skip-detail for a quick base-only bake.
  if (!args['skip-detail']) {
    levels.push(await bakeLevel(DETAIL_BBOX, DETAIL_ZOOM, force));
  }

  await writeJson('dem/manifest.json', {
    generated: new Date().toISOString(),
    source: SOURCE,
    encoding: 'terrarium',
    levels,
  });
}

main().catch((err) => {
  console.error(err.message);
  process.exitCode = 1;
});
