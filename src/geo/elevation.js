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
 * @returns {{loaded:boolean, layers:Array<{zoom:number,tiles:number}>, tilesLoaded:number, tilesMissing:number, minElevationM:number, maxElevationM:number}}
 */
export function getRegionStats() {
  return {
    loaded,
    layers: layers.map((l) => ({ zoom: l.zoom, tiles: l.tiles.size })),
    tilesLoaded,
    tilesMissing,
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
