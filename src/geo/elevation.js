/**
 * elevation.js — real-world terrain elevation, sampled from baked DEM tiles.
 *
 * STUB IMPLEMENTATION: the tile fetch, decode, cache and bilinear sampler are
 * all real and working. What is missing is the baked data itself — run
 * `npm run bake:dem` to populate public/dem/. Until then isLoaded() is false
 * and getElevation() returns SEA_LEVEL_M everywhere, which renders as a flat
 * ocean rather than a crash.
 *
 * Contract: see MODULES.md § elevation
 *
 *   loadRegion(bbox, zoom) -> Promise<void>
 *   getElevation(lat, lon) -> metres MSL
 *   getElevationLocal(x, z) -> metres MSL
 *
 * ---------------------------------------------------------------------------
 * WHY THE TILES ARE BAKED, NOT STREAMED
 * ---------------------------------------------------------------------------
 * The upstream source is AWS Terrarium:
 *   https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png
 * That S3 bucket sends NO access-control-allow-origin header (verified). Draw
 * one of those images into a canvas from browser JS and the canvas becomes
 * tainted, so getImageData() throws SecurityError and the elevation is
 * unreadable. There is no client-side workaround.
 *
 * So scripts/bake-dem.mjs downloads the region once, at build time, into
 * public/dem/{z}/{x}/{y}.png. Those are same-origin, the canvas stays clean,
 * and the sim works offline. DO NOT "optimise" this by fetching s3.amazonaws
 * directly at runtime — it cannot work.
 *
 * ---------------------------------------------------------------------------
 * TERRARIUM ENCODING
 * ---------------------------------------------------------------------------
 *   elevation_metres = (R * 256 + G + B / 256) - 32768
 * 8-bit RGB PNG, 256x256. Sub-metre precision lives in the blue channel.
 * Bathymetry is encoded as negative values, so open water reads <= 0.
 *
 * ---------------------------------------------------------------------------
 * LAYERS
 * ---------------------------------------------------------------------------
 * loadRegion() is additive and may be called more than once. Each call adds a
 * LAYER at some zoom covering some bbox. getElevation() consults layers from
 * HIGHEST zoom to lowest and uses the first that has a loaded tile covering the
 * point. That gives free variable detail: bake z=11 over the whole region for
 * Mount Rainier's shape, then z=13 over the Seattle inset so the ground stays
 * crisp on short final. No other code needs to know which layer answered.
 */

import {
  REGION_BBOX,
  lonToTileXFloat,
  latToTileYFloat,
  localToLl,
  tileRange,
  inBbox,
} from './coords.js';
import { assetUrl, fetchJsonOrNull } from '../core/assets.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** World y for mean sea level. The DEM's zero and the scene's zero are the same. */
export const SEA_LEVEL_M = 0;

/** Base zoom for the whole region: 238 tiles, ~52 m/pixel at this latitude. */
export const DEM_ZOOM = 11;

/** Optional high-detail inset zoom: ~13 m/pixel. See DETAIL_BBOX. */
export const DETAIL_ZOOM = 13;

/** Seattle inset worth baking at DETAIL_ZOOM — covers KBFI, KSEA, downtown. */
export const DETAIL_BBOX = Object.freeze({
  south: 47.35,
  north: 47.75,
  west: -122.5,
  east: -122.1,
});

/**
 * At or below this elevation, treat the surface as open salt water.
 * Terrarium gives Puget Sound and the Strait of Juan de Fuca values <= 0.
 * Note that FRESH water is not at zero — Lake Washington's surface is about
 * 5 m — so isWater() alone will not find the lakes. See MODULES.md § terrain
 * for the flat-region heuristic that does.
 */
export const WATER_LEVEL_M = 0.5;

const TILE_SIZE = 256;

/**
 * Plausibility band for a decoded sample. Anything outside it is a VOID — a
 * hole in the source data, not a landform.
 *
 * THIS IS NOT PARANOIA, IT IS MEASURED. The baked tiles really do contain
 * these, and they are not harmless:
 *
 *   z=11  185 pixels below -500 m, worst -14,492 m at 47.6541, -122.9003.
 *         Its four neighbours read -4.8, -4.5, 0.4 and 2.1 m — shoreline.
 *   z=13  3,292 pixels below -500 m, worst -3,443 m. One sits at
 *         47.4480, -122.3720, which is 3 km off the end of KSEA's runways,
 *         where z=11 reads a sane 9.2 m.
 *
 * Left alone, each one punches a kilometres-deep needle through the terrain
 * mesh and makes altitudeAglFt nonsense for any aircraft that passes over it.
 * A 2.6 km pit on the approach to the region's main airport is exactly the
 * kind of thing that reads as "the terrain is fake".
 *
 * The band is deliberately wide, and it is only the coarse net: Terrarium's
 * water treatment in this region bottoms out around -25 m (it carries nearshore
 * bathymetry, not channel depths — the main basin off Alki reads a flat 0), and
 * the highest real ground is Rainier at 4,392 m. Nothing genuine comes close to
 * either limit.
 */
const MIN_PLAUSIBLE_M = -500;
const MAX_PLAUSIBLE_M = 9000;

/**
 * Deviation from the surrounding terrain that marks a pixel as a spike.
 *
 * An absolute band alone is NOT enough, and this is the trap. The worst
 * artifact near Seattle is a one-pixel-high scanline at 47.4880, -122.3660
 * reading -497 m, embedded in a smooth -9 m tideflat — it sails straight
 * through a -500 m floor while being a 490 m cliff-edged trench across the
 * approach to KSEA. Voids have to be caught by DISCONTINUITY, because that is
 * what actually makes them voids: real ground is continuous at DEM resolution,
 * a hole in the data is not.
 *
 * 150 m is measured, not guessed. Deviation from the neighbour median across
 * all 378 baked tiles distributes like this:
 *
 *   z=11 (52 m/px)   >50 m: 1529 px   >100 m: 250   >150 m: 222   >1000 m: 185
 *   z=13 (13 m/px)   >50 m: 3441 px   >100 m: 3422  >150 m: 3406  >1000 m: 2105
 *
 * The z=11 curve falls steeply to ~100 m and then goes flat: the steep part is
 * real Cascade headwall, the flat tail is voids. z=13 is flat almost
 * immediately — at 13 m/px nothing real steps 50 m between adjacent pixels.
 * 150 m sits above both knees. It corresponds to a 71-degree face at z=11 and
 * an 85-degree face at z=13, so it cannot clip terrain an aircraft could land
 * on, and a false positive costs one pixel nudged toward its neighbours.
 */
const SPIKE_M = 150;

/**
 * Cheap pre-filter before the median test. Deviation from the neighbour MEAN is
 * a few metres on real ground, so this rejects >99.9% of pixels for the cost of
 * eight adds and keeps the sort off the hot path. A quarter of SPIKE_M is a
 * deliberately loose gate: it only has to be a superset of what the median test
 * would flag (verified against a pure-median pass over the full bake).
 */
const SPIKE_PREFILTER_M = SPIKE_M / 4;

/**
 * Passes of neighbour-fill. Voids come in blobs — measured below -40 m:
 *
 *   z=11   175 blobs, 153 of them a single pixel, largest 8 px
 *   z=13   318 blobs, largest 78 px (~9x9) at 47.3828, -122.3897, under the
 *          KSEA approach, interior reading -2437 m
 *
 * so the fill has to reach a blob's centre from its rim: 16 passes covers a
 * radius comfortably past the worst one.
 *
 * NOTE ON WHAT IS DELIBERATELY ABSENT. An earlier version grew the void mask
 * inward from the rim by flood fill, on the theory that a median test cannot
 * see a blob's interior. It is not needed and it is not safe:
 *
 *   - Not needed, because the absolute-band test already runs on EVERY pixel,
 *     so every pixel of an out-of-band blob is a seed in its own right. Blob
 *     interiors are caught directly. The only voids the median has to find
 *     alone are shallow ones, and those are one or two pixels wide by
 *     definition — if they were broad and shallow they would be terrain.
 *   - Not safe, because on a steep face each step of the fill slides its own
 *     acceptance window, so it walks uphill indefinitely. Instrumented, it ate
 *     up to 2,087 px of Rainier's flanks on 28 of the 378 tiles before a size
 *     guard caught it.
 *
 * Two independent per-pixel tests, no propagation. Resist re-adding it.
 */
const VOID_REPAIR_PASSES = 16;

/** Scratch for the neighbour median. Module-scope: decode must not allocate. */
const nbr = new Float64Array(8);

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} DemLayer
 * @property {number} zoom
 * @property {number} tileSize
 * @property {{south:number,north:number,west:number,east:number}} bbox
 * @property {Map<string, Float32Array|null>} tiles  key `${x}/${y}`; null = absent
 */

/** @type {DemLayer[]} Sorted by descending zoom, so index 0 is the finest. */
const layers = [];

let loaded = false;
let minElevationM = 0;
let maxElevationM = 0;
let tilesLoaded = 0;
let tilesMissing = 0;
let voidsRepaired = 0;

/** @type {Promise<void>|null} Dedupes concurrent loadRegion() calls. */
let inFlight = null;

// ---------------------------------------------------------------------------
// Decoding
// ---------------------------------------------------------------------------

/**
 * Decode one Terrarium RGB triple to metres above mean sea level.
 * @param {number} r 0..255
 * @param {number} g 0..255
 * @param {number} b 0..255
 * @returns {number} metres
 */
export function decodeTerrarium(r, g, b) {
  return r * 256 + g + b / 256 - 32768;
}

/**
 * Replace void pixels with the mean of their valid neighbours, in place.
 *
 * Voids are rare (about 1 in 85,000 pixels) and at most a few pixels across, so
 * a bounded flood-fill inward from the valid pixels converges in one or two
 * passes and costs nothing measurable. Repairing here — inside the one function
 * every tile passes through on its way into the sim — means no sampling path
 * can bypass it, which a clamp applied at getElevation() would not guarantee
 * for callers that read the layer caches directly.
 *
 * Each pass reads only pixels that were valid when the pass STARTED, so the
 * result does not depend on iteration order and a repaired pixel cannot seed
 * its own neighbours within the same pass.
 *
 * @param {Float32Array} data Row-major heights, mutated in place.
 * @param {number} w
 * @param {number} h
 * @returns {number} How many pixels were repaired.
 */
function repairVoids(data, w, h) {
  /** @type {number[]} Void pixel indices. */
  let bad = [];
  const isBad = new Uint8Array(w * h);

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const v = data[i];

      // The !(>=&&<=) form also catches NaN, which a truncated PNG can produce.
      if (!(v >= MIN_PLAUSIBLE_M && v <= MAX_PLAUSIBLE_M)) {
        isBad[i] = 1;
        bad.push(i);
        continue;
      }

      // Gather the 8-neighbourhood (fewer at a tile edge).
      let n = 0;
      let sum = 0;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= w || (dx === 0 && dy === 0)) continue;
          const nv = data[yy * w + xx];
          nbr[n++] = nv;
          sum += nv;
        }
      }
      if (n < 3) continue; // corner with too little context to judge

      // Stage 1: cheap mean test. Almost every pixel exits here.
      if (Math.abs(v - sum / n) <= SPIKE_PREFILTER_M) continue;

      // Stage 2: median test. The median is what makes a one-pixel-wide
      // scanline void detectable — its own bad neighbours cannot outvote the
      // valid ones, whereas they would drag a mean or a min/max range with them.
      // Insertion sort: n <= 8, and this runs on a vanishing fraction of pixels.
      for (let a = 1; a < n; a++) {
        const key = nbr[a];
        let b = a - 1;
        while (b >= 0 && nbr[b] > key) {
          nbr[b + 1] = nbr[b];
          b--;
        }
        nbr[b + 1] = key;
      }
      const median =
        n % 2 ? nbr[(n - 1) >> 1] : (nbr[n / 2 - 1] + nbr[n / 2]) / 2;

      if (Math.abs(v - median) > SPIKE_M) {
        isBad[i] = 1;
        bad.push(i);
      }
    }
  }

  if (bad.length === 0) return 0;

  const repaired = bad.length;

  for (let pass = 0; pass < VOID_REPAIR_PASSES && bad.length; pass++) {
    /** @type {number[]} */
    const stillBad = [];
    const fixedThisPass = [];

    for (let k = 0; k < bad.length; k++) {
      const i = bad[k];
      const x = i % w;
      const y = (i / w) | 0;
      let sum = 0;
      let n = 0;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= w || (dx === 0 && dy === 0)) continue;
          const j = yy * w + xx;
          if (isBad[j]) continue;
          sum += data[j];
          n++;
        }
      }
      if (n > 0) {
        data[i] = sum / n;
        fixedThisPass.push(i);
      } else {
        stillBad.push(i);
      }
    }

    // Clear the flags only now, so ordering within the pass cannot matter.
    for (let k = 0; k < fixedThisPass.length; k++) isBad[fixedThisPass[k]] = 0;

    if (fixedThisPass.length === 0) break; // nothing valid to grow from
    bad = stillBad;
  }

  // A void with no valid neighbour at all (a wholly corrupt tile) falls back to
  // sea level rather than staying a kilometres-deep spike.
  for (let k = 0; k < bad.length; k++) data[bad[k]] = SEA_LEVEL_M;

  return repaired;
}

/**
 * Fetch one baked PNG and decode it to a Float32Array of metres, row-major,
 * `tileSize * tileSize` entries.
 *
 * @param {number} z
 * @param {number} x
 * @param {number} y
 * @returns {Promise<Float32Array|null>} null when the tile is not on disk.
 */
async function loadTile(z, x, y) {
  const url = assetUrl(`dem/${z}/${x}/${y}.png`);
  let bitmap;
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    bitmap = await createImageBitmap(await res.blob());
  } catch {
    return null;
  }

  const w = bitmap.width;
  const h = bitmap.height;

  // OffscreenCanvas where available (all modern desktop browsers); the DOM
  // canvas fallback keeps older Safari working.
  let ctx;
  if (typeof OffscreenCanvas !== 'undefined') {
    ctx = new OffscreenCanvas(w, h).getContext('2d', {
      willReadFrequently: true,
    });
  } else {
    const cv = document.createElement('canvas');
    cv.width = w;
    cv.height = h;
    ctx = cv.getContext('2d', { willReadFrequently: true });
  }
  if (!ctx) {
    bitmap.close?.();
    return null;
  }

  ctx.drawImage(bitmap, 0, 0);
  bitmap.close?.();

  // Same-origin, so this does not throw. If it ever does, the tiles were not
  // baked and something is fetching S3 directly — see the header comment.
  const rgba = ctx.getImageData(0, 0, w, h).data;

  const out = new Float32Array(w * h);
  for (let i = 0, p = 0; i < out.length; i++, p += 4) {
    out[i] = decodeTerrarium(rgba[p], rgba[p + 1], rgba[p + 2]);
  }

  // The source has voids. See MIN_PLAUSIBLE_M for the measured damage.
  voidsRepaired += repairVoids(out, w, h);

  return out;
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

/**
 * Load a baked DEM layer covering `bbox` at `zoom`.
 *
 * Additive: call once per detail level. Calling twice with the same zoom merges
 * into the existing layer. Resolves when every tile has been fetched and
 * decoded; missing tiles are counted, not fatal.
 *
 * @param {{south:number,north:number,west:number,east:number}} [bbox]
 * @param {number} [zoom]
 * @returns {Promise<void>}
 */
export async function loadRegion(bbox = REGION_BBOX, zoom = DEM_ZOOM) {
  const run = async () => {
    // The manifest is advisory: it tells us which tiles the baker actually
    // wrote, so we skip fetching known-absent ocean tiles. Its absence is not
    // fatal — we just try every tile in the range.
    const manifest = await fetchJsonOrNull('dem/manifest.json', null);
    const level = manifest?.levels?.find((l) => l.zoom === zoom) ?? null;

    const range = tileRange(bbox, zoom);
    let layer = layers.find((l) => l.zoom === zoom);
    if (!layer) {
      layer = { zoom, tileSize: TILE_SIZE, bbox, tiles: new Map() };
      layers.push(layer);
      layers.sort((a, b) => b.zoom - a.zoom);
    }
    if (level?.tileSize) layer.tileSize = level.tileSize;

    /**
     * Tiles the manifest says exist, if it told us. The baker writes them as
     * "x/y" strings; [x, y] pairs are accepted too so the format can evolve.
     */
    const present = level?.tiles
      ? new Set(
          level.tiles.map((t) => (Array.isArray(t) ? `${t[0]}/${t[1]}` : t)),
        )
      : null;

    /** @type {Array<Promise<void>>} */
    const jobs = [];
    for (let x = range.minX; x <= range.maxX; x++) {
      for (let y = range.minY; y <= range.maxY; y++) {
        const key = `${x}/${y}`;
        if (layer.tiles.has(key)) continue;
        if (present && !present.has(key)) continue;
        layer.tiles.set(key, null); // reserve, so we do not queue it twice
        jobs.push(
          loadTile(zoom, x, y).then((data) => {
            layer.tiles.set(key, data);
            if (data) {
              tilesLoaded++;
              for (let i = 0; i < data.length; i++) {
                const v = data[i];
                if (v < minElevationM) minElevationM = v;
                if (v > maxElevationM) maxElevationM = v;
              }
            } else {
              tilesMissing++;
            }
          }),
        );
      }
    }

    // Cap concurrency so we do not open 900 sockets at once.
    const LIMIT = 24;
    for (let i = 0; i < jobs.length; i += LIMIT) {
      await Promise.all(jobs.slice(i, i + LIMIT));
    }

    loaded = tilesLoaded > 0;
    if (!loaded) {
      console.warn(
        `[elevation] no DEM tiles found for z=${zoom}. ` +
          'Run `npm run bake:dem`. The world will be flat sea level.',
      );
    }
  };

  inFlight = inFlight ? inFlight.then(run) : run();
  return inFlight;
}

/** True once at least one DEM tile has been decoded. */
export function isLoaded() {
  return loaded;
}

/**
 * Diagnostics for the HUD / console.
 * `voidsRepaired` counts source pixels that were outside the plausibility band
 * and got neighbour-filled. Expect a few thousand across the region; a sudden
 * jump means the upstream tiles changed.
 *
 * @returns {{loaded:boolean, layers:Array<{zoom:number,tiles:number}>, tilesLoaded:number, tilesMissing:number, voidsRepaired:number, minElevationM:number, maxElevationM:number}}
 */
export function getRegionStats() {
  return {
    loaded,
    layers: layers.map((l) => ({ zoom: l.zoom, tiles: l.tiles.size })),
    tilesLoaded,
    tilesMissing,
    voidsRepaired,
    minElevationM,
    maxElevationM,
  };
}

// ---------------------------------------------------------------------------
// Sampling
// ---------------------------------------------------------------------------

/**
 * Raw pixel lookup within a layer, in that layer's global pixel space.
 * Returns NaN when the covering tile is absent, which lets the bilinear filter
 * fall through to a coarser layer instead of punching a hole in the terrain.
 *
 * @param {DemLayer} layer
 * @param {number} px global pixel X (integer)
 * @param {number} py global pixel Y (integer)
 * @returns {number} metres, or NaN
 */
function texelAt(layer, px, py) {
  const ts = layer.tileSize;
  const tx = Math.floor(px / ts);
  const ty = Math.floor(py / ts);
  const data = layer.tiles.get(`${tx}/${ty}`);
  if (!data) return NaN;
  const lx = px - tx * ts;
  const ly = py - ty * ts;
  return data[ly * ts + lx];
}

/**
 * Bilinearly sample one layer at a geodetic point.
 * Sampling happens in GLOBAL pixel space, so interpolation crosses tile seams
 * correctly instead of clamping at tile edges — that is what stops the terrain
 * showing a grid of creases.
 *
 * @param {DemLayer} layer
 * @param {number} lat
 * @param {number} lon
 * @returns {number} metres, or NaN if any of the four texels is missing
 */
function sampleLayer(layer, lat, lon) {
  const ts = layer.tileSize;
  // -0.5 shifts from pixel-corner to pixel-centre convention.
  const gx = lonToTileXFloat(lon, layer.zoom) * ts - 0.5;
  const gy = latToTileYFloat(lat, layer.zoom) * ts - 0.5;

  const x0 = Math.floor(gx);
  const y0 = Math.floor(gy);
  const fx = gx - x0;
  const fy = gy - y0;

  const h00 = texelAt(layer, x0, y0);
  const h10 = texelAt(layer, x0 + 1, y0);
  const h01 = texelAt(layer, x0, y0 + 1);
  const h11 = texelAt(layer, x0 + 1, y0 + 1);

  if (
    Number.isNaN(h00) ||
    Number.isNaN(h10) ||
    Number.isNaN(h01) ||
    Number.isNaN(h11)
  ) {
    return NaN;
  }

  const top = h00 + (h10 - h00) * fx;
  const bot = h01 + (h11 - h01) * fx;
  return top + (bot - top) * fy;
}

/**
 * Ground elevation in METRES above mean sea level.
 *
 * Defined everywhere: outside the baked region, or before loadRegion()
 * resolves, it returns SEA_LEVEL_M. Never returns NaN, never throws — the
 * flight model calls this every physics step and must not be able to trip over
 * a gap in the data.
 *
 * @param {number} lat degrees
 * @param {number} lon degrees
 * @returns {number} metres MSL
 */
export function getElevation(lat, lon) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return SEA_LEVEL_M;
  for (let i = 0; i < layers.length; i++) {
    const h = sampleLayer(layers[i], lat, lon);
    if (!Number.isNaN(h)) return h;
  }
  return SEA_LEVEL_M;
}

const _ll = { lat: 0, lon: 0 };

/**
 * Ground elevation at a LOCAL scene coordinate. Allocation-free.
 *
 * This is the function terrain.getHeightAt() must delegate to, and the one the
 * flight model's ground height must come from. Two different samplers is how
 * you get an aircraft that sinks through a hillside.
 *
 * @param {number} x metres east of origin
 * @param {number} z metres south of origin
 * @returns {number} metres MSL
 */
export function getElevationLocal(x, z) {
  localToLl(x, z, _ll);
  return getElevation(_ll.lat, _ll.lon);
}

/**
 * True where the surface is open salt water.
 * See WATER_LEVEL_M — this does NOT detect freshwater lakes.
 *
 * @param {number} lat
 * @param {number} lon
 * @returns {boolean}
 */
export function isWater(lat, lon) {
  return getElevation(lat, lon) <= WATER_LEVEL_M;
}

/**
 * Bulk-sample a regular grid in local scene space. Use this when building
 * terrain geometry — it is the same sampler as getElevationLocal(), so the mesh
 * and the collision surface cannot drift apart, and it avoids a few hundred
 * thousand redundant object allocations.
 *
 * Grid point (i, j) sits at local (x0 + i * dx, z0 + j * dz), and is written to
 * out[j * nx + i].
 *
 * @param {number} x0 local X of grid point (0, 0), metres
 * @param {number} z0 local Z of grid point (0, 0), metres
 * @param {number} dx column spacing, metres
 * @param {number} dz row spacing, metres
 * @param {number} nx columns
 * @param {number} nz rows
 * @param {Float32Array} [out] Reused if long enough; allocated otherwise.
 * @returns {Float32Array} length nx * nz, metres MSL
 */
export function fillHeightGrid(x0, z0, dx, dz, nx, nz, out) {
  const target =
    out && out.length >= nx * nz ? out : new Float32Array(nx * nz);
  for (let j = 0; j < nz; j++) {
    const z = z0 + j * dz;
    const row = j * nx;
    for (let i = 0; i < nx; i++) {
      target[row + i] = getElevationLocal(x0 + i * dx, z);
    }
  }
  return target;
}

/**
 * Surface normal at a local scene point, from central differences on the DEM.
 * Handy for procedural colouring (slope-based rock vs grass) without having to
 * read back the mesh.
 *
 * @param {number} x metres
 * @param {number} z metres
 * @param {number} [epsM] sample spacing, metres. Default 30 — roughly the base
 *        DEM resolution, so smaller values just amplify interpolation noise.
 * @returns {{x:number, y:number, z:number}} Unit length, +Y up.
 */
export function getNormalLocal(x, z, epsM = 30) {
  const hL = getElevationLocal(x - epsM, z);
  const hR = getElevationLocal(x + epsM, z);
  const hD = getElevationLocal(x, z - epsM);
  const hU = getElevationLocal(x, z + epsM);
  const nx = (hL - hR) / (2 * epsM);
  const nz = (hD - hU) / (2 * epsM);
  const len = Math.hypot(nx, 1, nz);
  return { x: nx / len, y: 1 / len, z: nz / len };
}

/** True if a point lies inside the region we baked data for. */
export function isInRegion(lat, lon) {
  return inBbox(lat, lon, REGION_BBOX);
}
