/**
 * bake-dem.mjs — download real elevation tiles into public/dem/.
 *
 * STATUS: SKELETON. The plumbing, argument handling and manifest writer are
 * done. The download loop is marked TODO below.
 *
 *   node scripts/bake-dem.mjs [--zoom=11] [--detail] [--force]
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

import { existsSync } from 'node:fs';
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

/** Base level: the whole region, coarse enough to be a sane download. */
const BASE_ZOOM = 11;

/** Optional detail level over Seattle — see the header for the tile count. */
const DETAIL_ZOOM = 13;
const DETAIL_BBOX = {
  south: 47.35,
  north: 47.75,
  west: -122.5,
  east: -122.1,
};

/** Parallel downloads. S3 tolerates this comfortably; be a good citizen. */
const CONCURRENCY = 16;

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

  // TODO(GeoCore): implement the download loop.
  //
  //   await mapLimit(wanted, CONCURRENCY, async ({ x, y }) => {
  //     const rel = `dem/${zoom}/${x}/${y}.png`;
  //     if (!force && existsSync(resolve(PUBLIC_DIR, rel))) return rel;
  //     const res = await get(`${SOURCE}/${zoom}/${x}/${y}.png`);
  //     await writeBinary(rel, Buffer.from(await res.arrayBuffer()));
  //     return rel;
  //   });
  //
  // Requirements:
  //   - Write the response bytes VERBATIM. No sharp, no canvas, no re-encode.
  //   - A 403/404 is not fatal: some tiles genuinely do not exist. Count them,
  //     omit them from the manifest, keep going.
  //   - Retry transient 5xx a couple of times with a short backoff.
  //   - Log progress every ~50 tiles; a cold z=11 bake takes a minute or two.
  //   - Return ONLY the tiles actually written, as "x/y" strings.
  void wanted;
  void force;
  void existsSync;
  void resolve;
  void PUBLIC_DIR;
  void get;
  void writeBinary;
  void mapLimit;

  throw new Error(
    'bake-dem.mjs is a skeleton: the download loop is not implemented yet. ' +
      'See the TODO in bakeLevel().',
  );
}

async function main() {
  const args = parseArgs();
  const zoom = args.zoom ? Number(args.zoom) : BASE_ZOOM;
  const force = Boolean(args.force);

  console.log(`Baking DEM from ${SOURCE}`);

  const levels = [];
  levels.push({
    tileSize: 256,
    ...(await bakeLevel(REGION_BBOX, zoom, force)),
  });

  if (args.detail) {
    levels.push({
      tileSize: 256,
      ...(await bakeLevel(DETAIL_BBOX, DETAIL_ZOOM, force)),
    });
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
