/**
 * elevation.js — the ground surface. Real terrain, sampled from baked DEM
 * tiles, streamed in and out around the aircraft.
 *
 * Contract: see MODULES.md §2.4. The invariant that matters most is §1.4:
 * there is exactly ONE ground surface and it is getElevationLocal(x, z).
 *
 *   loadRegion(bbox, zoom) -> Promise<void>
 *   loadDetailLayers()     -> Promise<void>
 *   setViewer(x, z, vx, vz)-> void          drives paging; call it per frame
 *   getElevation(lat, lon) -> metres MSL
 *   getElevationLocal(x, z)-> metres MSL    synchronous, allocation-free
 *
 * ===========================================================================
 * WHY THE TILES ARE BAKED, NOT STREAMED FROM SOURCE
 * ===========================================================================
 * The upstream source is AWS Terrarium:
 *   https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png
 * That S3 bucket sends NO access-control-allow-origin header (verified again
 * this round). A browser can DISPLAY those images but cannot READ them:
 * drawing one into a canvas taints it and getImageData() throws SecurityError.
 * Since the whole point is to read pixel values as elevation, they are unusable
 * from browser JS. There is no client-side workaround; a proxy would just be
 * scripts/bake-dem.mjs running at request time.
 *
 * So we bake once into public/dem/{z}/{x}/{y}.png and serve same-origin. DO NOT
 * "optimise" this by fetching s3.amazonaws directly at runtime — it cannot work.
 *
 * ===========================================================================
 * TERRARIUM ENCODING
 * ===========================================================================
 *   elevation_metres = (R * 256 + G + B / 256) - 32768
 * 8-bit RGB PNG, 256x256. Bathymetry is negative, so open water reads <= 0.
 *
 * ===========================================================================
 * LAYERS
 * ===========================================================================
 * Three levels are baked (see scripts/bake-dem.mjs for the measurements that
 * chose them):
 *
 *   z=11  238 tiles   51.8  m/px   whole region      PINNED, always resident
 *   z=13  3,380 tiles 12.95 m/px   whole region      PAGED
 *   z=14  560 tiles    6.47 m/px   Seattle inset     PAGED
 *
 * Sampling walks the layers finest-first and BLENDS rather than switching —
 * see § BLENDING. No other module needs to know which layer answered.
 *
 * ===========================================================================
 * § PAGING — the memory problem, and the shape of the answer
 * ===========================================================================
 * 3,380 z=13 tiles decoded is 221 million samples. As Float32 that is 885 MB;
 * as Int16 it is 443 MB. Neither can be resident. Round 1 got away with holding
 * everything only because it held 378 tiles.
 *
 * So the fine levels are PAGED: a bounded working set of decoded tiles near the
 * aircraft, evicted by distance, prefetched along the flight path.
 *
 * FOUR PROPERTIES THIS DESIGN IS BUILT AROUND, in priority order:
 *
 * 1. getElevation() IS SYNCHRONOUS AND NEVER BLOCKS. It reads only what is
 *    already decoded. It cannot await, cannot trigger a fetch on the hot path,
 *    and cannot throw. The flight model calls it several times per wheel per
 *    substep; if it could block, the sim would stutter every time a tile
 *    boundary was crossed.
 *
 * 2. A MISS FALLS TO THE NEXT COARSER LAYER, NEVER TO ZERO. This is the whole
 *    reason z=11 is pinned. A hole in the ground is not a cosmetic bug: the
 *    flight model reads the surface as the collision plane, so a 0 m return
 *    over the Cascades is a 2 km cliff that destroys the aeroplane. The pinned
 *    base is 238 tiles = 29.75 MiB and it covers the entire region, so inside
 *    the region THERE IS ALWAYS AN ANSWER. SEA_LEVEL_M is returned only outside
 *    the baked region, which is genuinely open ocean and British Columbia.
 *
 * 3. RESIDENT BYTES ARE CAPPED AND THE CAP IS ASSERTED. Every layer has a tile
 *    budget; the sum of all budgets is checked against RESIDENT_CAP_BYTES at
 *    module load (assertCapBudget) and the live total is re-checked after every
 *    paging pass. Exceeding it is a console.error, not a silent leak.
 *
 * 4. WHAT THE AIRCRAFT IS ABOUT TO FLY OVER IS ALREADY THERE. The desired set
 *    is scored by distance to the SEGMENT from the aircraft to where it will be
 *    LEAD_SECONDS from now, not to the aircraft itself, so the working set
 *    leans forward along the flight path.
 *
 * THE BUDGET ARITHMETIC (TILE_BYTES = 256 * 256 * 2 = 128 KiB):
 *
 *   layer  radius   disc tiles   + lead stadium   budget   bytes
 *   z=11   pinned   238          -                238      29.75 MiB
 *   z=13   30 km    257          277              288      36.00 MiB
 *   z=14    9 km    114          116              128      16.00 MiB
 *                                                 ------   ---------
 *                                                 654      81.75 MiB
 *
 * against a RESIDENT_CAP_BYTES of 96 MiB. The budgets deliberately exceed the
 * disc-plus-stadium area so that eviction never has to bite inside the radius;
 * see § BLENDING for why that matters.
 *
 * ===========================================================================
 * § BLENDING — why layers fade instead of switching
 * ===========================================================================
 * Round 1 sampled finest-first and returned the first hit. That makes every
 * layer boundary a STEP: the geography critic saw the z=13 Seattle inset as
 * "a hard rectangle whose edge is a visible ledge". Of course it was — z=11 and
 * z=13 disagree by metres, and the switch happened over zero distance.
 *
 * Now each layer carries a weight in [0, 1] and the sampler folds finest to
 * coarsest, spending weight until it runs out:
 *
 *     h = 0; wRem = 1
 *     for layer in fine..coarse:
 *         s = sample(layer);  if missing: continue
 *         w = layerWeight(layer) * wRem
 *         h += s * w;  wRem -= w
 *         if wRem ~ 0: break
 *
 * A layer at weight 1 short-circuits, so the common case costs exactly what the
 * old code cost. The weight is the product of three fades, each fixing one
 * thing:
 *
 *   EDGE   — distance inside the layer's own bbox, over EDGE_BAND_M. This is
 *            the fix for the visible ledge. The z=14 inset now dissolves into
 *            z=13 across 3 km instead of stepping at a rectangle.
 *   FRONT  — distance from the viewer, over [FADE_INNER, FADE_OUTER] x radius.
 *            The paging frontier is a boundary too, and it moves. Fading it out
 *            well inside the guaranteed-resident radius means the frontier is
 *            already at zero weight before it can become a miss.
 *   ARRIVE — a per-tile ramp from 0 to 1 over FADE_IN_MS after the tile decodes.
 *            Without it, a tile paging in behind a teleport would move the
 *            ground under the aircraft in a single frame, which the flight
 *            model would correctly read as terrain arriving at 40 m/s. With it,
 *            the surface morphs over ~1.5 s and the gear springs absorb it.
 *
 * The §1.4 invariant is untouched by all of this: the mesh (via fillHeightGrid)
 * and the collision surface (via getElevationLocal) call the SAME sampler, so
 * whatever the blend says at a given instant, both agree to the centimetre.
 *
 * ===========================================================================
 * § STORAGE — Int16 quarter-metres
 * ===========================================================================
 * Decoded tiles are stored as Int16Array in units of 1/4 metre, not Float32.
 * That halves resident bytes, which directly doubles the radius the budget can
 * cover, and it costs 0.25 m of quantisation on a source whose own vertical
 * accuracy is ±3 m (3DEP 1/3 arc-second). Bilinear interpolation smooths the
 * quantisation to about ±0.125 m on the sampled field.
 *
 * The range is what makes it fit: quarter-metres over [-500, 8191] is
 * [-2000, 32764], inside Int16. The region's true extremes are -50 m of
 * nearshore bathymetry and Rainier's 4,393 m summit, so there is no clipping.
 */

import {
  REGION_BBOX,
  lonToTileXFloat,
  latToTileYFloat,
  localToLl,
  llToLocal,
  tileRange,
  inBbox,
  metresPerPixel,
} from './coords.js';
import { assetUrl, fetchJsonOrNull } from '../core/assets.js';

// ---------------------------------------------------------------------------
// Constants — the world
// ---------------------------------------------------------------------------

/** World y for mean sea level. The DEM's zero and the scene's zero are the same. */
export const SEA_LEVEL_M = 0;

/**
 * Pinned base zoom: the whole region at 51.8 m/px, 238 tiles, permanently
 * resident. This is the layer that makes a paging miss survivable — see
 * property 2 in § PAGING. Do not make it pageable.
 */
export const DEM_ZOOM = 11;

/** Paged working layer: the whole region at 12.95 m/px. 3,380 tiles. */
export const DETAIL_ZOOM = 13;

/** Paged approach layer: 6.47 m/px. 560 tiles over DETAIL_BBOX. */
export const FINE_ZOOM = 14;

/**
 * The Seattle inset — KBFI, KSEA, downtown, Elliott Bay, the Duwamish valley.
 * FINE_ZOOM covers exactly this and nothing else; region-wide z=14 would be
 * 13,158 tiles and about 1.1 GB on disk.
 */
export const DETAIL_BBOX = Object.freeze({
  south: 47.35,
  north: 47.75,
  west: -122.5,
  east: -122.1,
});

/**
 * At or below this elevation, treat the surface as open salt water.
 * FRESH water is not at zero — Lake Washington's surface is about 5 m — so
 * isWater() alone will not find the lakes. See MODULES.md §2.7 for the
 * flat-region heuristic that does.
 */
export const WATER_LEVEL_M = 0.5;

const TILE_SIZE = 256;

// ---------------------------------------------------------------------------
// Constants — storage and the memory cap
// ---------------------------------------------------------------------------

/** Stored units per metre. 4 => quarter-metre quantisation. See § STORAGE. */
const ELEV_SCALE = 4;
const ELEV_SCALE_INV = 1 / ELEV_SCALE;

/** Bytes one decoded tile occupies: 256 * 256 * 2. */
const TILE_BYTES = TILE_SIZE * TILE_SIZE * 2;

/**
 * The hard ceiling on decoded elevation data, pinned plus paged. 96 MiB against
 * a planned 81.75 MiB of budget — see the table in § PAGING. It is asserted
 * twice: once at configuration time against the sum of the layer budgets, and
 * again after every paging pass against what is actually held.
 */
export const RESIDENT_CAP_BYTES = 96 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Constants — void repair
// ---------------------------------------------------------------------------

/**
 * Plausibility band for a decoded sample. Outside it is a VOID — a hole in the
 * source, not a landform.
 *
 * BOTH LIMITS WERE MEASURED THIS ROUND against all 4,178 baked tiles, and the
 * lower one moved a long way. Round 1 used -500 m, chosen as an obviously-safe
 * outer bound, and 144 voids survived inside it — the worst reading -497.8 m,
 * sitting just under the floor. The fix is not a wider net, it is a floor put
 * where the data says it belongs.
 *
 * Every negative pixel in ALL 4,178 baked tiles, bucketed by depth, with
 * "cliffy" meaning it jumps more than 20 m to at least one 8-neighbour:
 *
 *   bucket        z=11 n / cliffy   z=13 n / cliffy   z=14 n / cliffy
 *   [-20, -10)      9,233 /   202   156,950 /   991   102,357 /   276
 *   [-30, -20)        398 /   137    14,847 /   462       875 /    69
 *   [-40, -30)         69 /    38       572 /   105         3 /     3
 *   [-50, -40)         19 /    17        74 /    33         6 /     6
 *   [-60, -50)          7 /     7         5 /     5        11 /    11
 *   [-70, -60)          3 /     3         9 /     9        10 /    10
 *   ... every bucket below -60, at every zoom ...  100% cliffy, no exceptions
 *
 * The transition is categorical, not gradual, and it lands in the same place at
 * all three resolutions. Terrarium in this region carries nearshore bathymetry
 * only — the main Puget Sound basin is encoded as a flat zero, not as its true
 * -280 m — so the deepest genuine, smooth pixel anywhere in the bbox sits in
 * [-50, -40). MIN_PLAUSIBLE_M = -60 leaves 10 m of margin under it and still
 * catches every one of the discontinuities. That is why it removes thousands of
 * voids while removing no real bathymetry: below -60 there IS no real
 * bathymetry to remove.
 *
 * The upper limit moved for the same reason. Measured global maxima: z=11
 * 4,387.9 m, z=14 492.0 m, z=13 32,767 m — that last being 416 pixels of the
 * all-ones no-data sentinel. Rainier is the highest real ground at 4,393 m, so
 * 5,000 m is 600 m of headroom over anything in the bbox and catches a positive
 * sentinel that -500/9000 let straight through.
 */
const MIN_PLAUSIBLE_M = -60;
const MAX_PLAUSIBLE_M = 5000;

/**
 * Deviation from the 8-neighbour median that marks a pixel as a spike.
 *
 * An absolute band alone is not enough and this is the trap. The worst artifact
 * near Seattle is a one-pixel-high scanline reading -497 m embedded in a smooth
 * -9 m tideflat: it sails through any plausible floor while being a 490 m
 * cliff-edged trench across the approach to KSEA. Voids have to be caught by
 * DISCONTINUITY, because that is what makes them voids — real ground is
 * continuous at DEM resolution and a hole in the data is not.
 *
 * 150 m is measured. Deviation from the neighbour median distributes with a
 * steep real-terrain shoulder out to ~100 m and then a flat tail that is all
 * voids; 150 m sits above the knee at every zoom we bake. It corresponds to a
 * 71-degree face at z=11 and an 85-degree face at z=13, so it cannot clip
 * terrain an aircraft could land on, and a false positive costs one pixel
 * nudged toward its neighbours.
 */
const SPIKE_M = 150;

/**
 * Cheap pre-filter before the median test. Deviation from the neighbour MEAN is
 * a few metres on real ground, so this rejects >99.9% of pixels for eight adds
 * and keeps the sort off the hot path. A quarter of SPIKE_M is deliberately
 * loose: it only has to be a superset of what the median test would flag.
 */
const SPIKE_PREFILTER_M = SPIKE_M / 4;

/**
 * Passes of neighbour-fill. Voids come in blobs, the largest measured being a
 * 78-pixel (~9x9) patch under the KSEA approach, so the fill has to reach a
 * blob's centre from its rim. 16 passes covers a radius comfortably past it.
 *
 * NOTE ON WHAT IS DELIBERATELY ABSENT. An earlier version grew the void mask
 * inward from the rim by flood fill, on the theory that a median test cannot
 * see a blob's interior. It is not needed and it is not safe:
 *
 *   - Not needed, because the absolute-band test runs on EVERY pixel, so every
 *     pixel of an out-of-band blob is a seed in its own right. Blob interiors
 *     are caught directly. The only voids the median has to find alone are
 *     shallow ones, and those are one or two pixels wide by definition.
 *   - Not safe, because on a steep face each step of the fill slides its own
 *     acceptance window, so it walks uphill indefinitely. Instrumented, it ate
 *     up to 2,087 px of Rainier's flanks before a size guard caught it.
 *
 * Two independent per-pixel tests, no propagation. Resist re-adding it.
 */
const VOID_REPAIR_PASSES = 16;

/** Scratch for the neighbour median. Module-scope: decode must not allocate. */
const nbr = new Float64Array(8);

// ---------------------------------------------------------------------------
// Constants — paging policy
// ---------------------------------------------------------------------------

/**
 * How far ahead the desired set leans. At 110 kt (57 m/s) this is 3.4 km of
 * lead, comfortably inside every layer's radius, so prefetch is never a race —
 * it just biases which tiles win the budget when the disc cannot hold them all.
 */
const LEAD_SECONDS = 60;

/** Cap on the lead, so a teleport's implied velocity cannot fling the set. */
const LEAD_MAX_M = 20000;

/** Fraction of a tile the viewer must move before the desired set is recomputed. */
const REPAGE_TILE_FRACTION = 0.3;

/** Floor on repaging frequency regardless of movement, milliseconds. */
const REPAGE_MIN_MS = 250;

/** Concurrent tile fetches. Same-origin and cheap, but not unbounded. */
const MAX_INFLIGHT = 6;

/**
 * Main-thread milliseconds per turn spent turning arrived bitmaps into
 * Int16Arrays. Decode plus void repair costs about 1.2 ms per tile, so this is
 * roughly two tiles a frame — fast enough to keep up with a light aircraft and
 * small enough to stay inside a 16 ms budget alongside everything else.
 */
const DECODE_BUDGET_MS = 2.5;

/** Milliseconds a freshly decoded tile takes to reach full weight. See § BLENDING. */
const FADE_IN_MS = 1500;

/** Where the frontier fade starts and ends, as fractions of a layer's radius. */
const FADE_INNER = 0.65;
const FADE_OUTER = 0.85;

/** Width of the fade inside a layer's bbox edge, metres. See § BLENDING. */
const EDGE_BAND_M = 3000;

/**
 * Fraction of the full radius that loadRegion() waits for before resolving.
 * The rest streams in behind the loading screen.
 *
 * Boot must not wait for 257 z=13 tiles. It does not need to: frame 0 only has
 * to have fine ground where the aircraft and the near mesh are, and everything
 * beyond that is covered by the pinned base until it arrives. 0.4 makes the
 * awaited set 46 z=13 tiles and 15 z=14 tiles — with the 238 pinned tiles that
 * is 299 tiles at boot, FEWER than round 1's 378, for 4x the resolution under
 * the wheels.
 */
const WARMUP_RADIUS_FRACTION = 0.4;

/**
 * Per-layer paging policy, keyed by zoom. `radiusM` is the coverage we try to
 * hold; `budgetTiles` is the hard resident count. See the budget table in
 * § PAGING for how the two relate — budget always exceeds the area the radius
 * implies, so eviction bites outside the fade region rather than inside it.
 */
const PAGING_POLICY = {
  13: { radiusM: 30000, budgetTiles: 288 },
  14: { radiusM: 9000, budgetTiles: 128 },
};

/** Fallback for a paged level the policy table does not name. */
const DEFAULT_POLICY = { radiusM: 12000, budgetTiles: 96 };

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} Tile
 * @property {Int16Array|null} q  Quarter-metre heights, or null while loading.
 * @property {number} w           Arrival ramp, 0..1. See § BLENDING.
 * @property {number} cost        Metres from the viewer segment, last pass.
 * @property {number} seq         Monotonic counter, LRU tie-break.
 */

/**
 * @typedef {Object} DemLayer
 * @property {number} zoom
 * @property {number} tileSize
 * @property {{south:number,north:number,west:number,east:number}} bbox
 * @property {boolean} pinned          Never evicted. Exactly one layer is.
 * @property {Map<number, Tile>} tiles Keyed by tileKey(x, y); resident only.
 * @property {Set<number>|null} present Tiles the manifest says exist.
 * @property {{minX:number,maxX:number,minY:number,maxY:number}} range
 * @property {number} radiusM
 * @property {number} budgetTiles
 * @property {number} tileM           Ground metres per tile at SCALE_LAT.
 * @property {number} viewTx          Viewer position, fractional tile units.
 * @property {number} viewTy
 * @property {number} leadTx          Lead point, fractional tile units.
 * @property {number} leadTy
 * @property {number} lastRepageTx    Where the last repage happened.
 * @property {number} lastRepageTy
 * @property {number} lastRepageMs
 * @property {number} fadeInnerPx     Frontier fade, in this layer's pixels.
 * @property {number} fadeOuterPx
 * @property {number} edgeBandLat     Edge fade width, degrees.
 * @property {number} edgeBandLon
 */

/** @type {DemLayer[]} Sorted by DESCENDING zoom, so index 0 is the finest. */
const layers = [];

let loaded = false;
let minElevationM = 0;
let maxElevationM = 0;
let tilesLoaded = 0;
let tilesMissing = 0;
let voidsRepaired = 0;

/** Live and peak decoded bytes, pinned plus paged. Property 3 in § PAGING. */
let residentBytes = 0;
let peakResidentBytes = 0;
let pageIns = 0;
let evictions = 0;
let capViolations = 0;

/**
 * Bumped whenever the field's answer can have moved. See getFieldEpoch().
 * Every write to it is next to the line that changed what a sample returns.
 */
let fieldEpoch = 0;

/** Viewer state in LOCAL scene metres, driven by setViewer(). */
let viewX = 0;
let viewZ = 0;
let leadX = 0;
let leadZ = 0;
let viewerSet = false;

/** Monotonic sequence for LRU tie-breaking. */
let seqCounter = 0;

/** True while loadRegion() is awaiting its warm-up; those tiles skip the ramp. */
let warmingUp = false;

/** @type {Promise<void>|null} Serialises loadRegion() calls. */
let inFlight = null;

/** Manifest, once fetched. */
let manifestData = null;
let manifestFetched = false;

// ---------------------------------------------------------------------------
// Injection points
// ---------------------------------------------------------------------------

/**
 * How a tile's pixels are obtained. The default goes through fetch + canvas,
 * which needs a DOM; `scripts/check-elevation.mjs` swaps in a Node reader so
 * the paging policy, the void repair and the sampler can be verified against
 * the REAL baked tiles without a browser. That is not a test backdoor — it is
 * the only way to assert the memory cap in CI.
 *
 * @type {(z:number, x:number, y:number) => Promise<{width:number, height:number, rgba:Uint8Array|Uint8ClampedArray}|null>}
 */
let tilePixelSource = fetchTilePixels;

/**
 * Override the tile pixel source and/or the manifest.
 * @param {{fetchPixels?: typeof tilePixelSource, manifest?: object|null}} opts
 */
export function setTileProvider(opts = {}) {
  if (opts.fetchPixels) tilePixelSource = opts.fetchPixels;
  if ('manifest' in opts) {
    manifestData = opts.manifest;
    manifestFetched = true;
  }
}

// ---------------------------------------------------------------------------
// Keys and small maths
// ---------------------------------------------------------------------------

/**
 * Numeric tile key. Map<number> instead of Map<string> because the sampler
 * builds a key up to four times per ground query and `${x}/${y}` ALLOCATES — a
 * §1.8 violation in a function the flight model calls dozens of times a step.
 * Valid for zoom <= 16, where tile indices stay under 65,536.
 */
const tileKey = (x, y) => y * 65536 + x;

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

/** Hermite smoothstep on [a, b]. Zero derivative at both ends: no crease. */
function smoothstep(a, b, v) {
  if (b <= a) return v >= b ? 1 : 0;
  const t = clamp01((v - a) / (b - a));
  return t * t * (3 - 2 * t);
}

/** Distance from (px, py) to the segment (ax, ay)-(bx, by). */
function segDistance(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return Math.hypot(px - (ax + dx * t), py - (ay + dy * t));
}

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
 * Repairing HERE — inside the one function every tile passes through on its way
 * into the sim — means no sampling path can bypass it, which a clamp applied at
 * getElevation() would not guarantee for callers that read the caches directly.
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

/** Reused across every decode: repairVoids wants Float32, storage wants Int16. */
let decodeScratch = new Float32Array(TILE_SIZE * TILE_SIZE);

/**
 * Turn a tile's RGBA bytes into quarter-metre Int16 heights, repairing voids on
 * the way through. This is the only place raw Terrarium becomes elevation.
 *
 * @param {Uint8Array|Uint8ClampedArray} rgba
 * @param {number} w
 * @param {number} h
 * @returns {Int16Array}
 */
function decodeTileToInt16(rgba, w, h) {
  const n = w * h;
  if (decodeScratch.length < n) decodeScratch = new Float32Array(n);
  const f = decodeScratch;

  for (let i = 0, p = 0; i < n; i++, p += 4) {
    f[i] = decodeTerrarium(rgba[p], rgba[p + 1], rgba[p + 2]);
  }

  // The source has voids. See MIN_PLAUSIBLE_M for the measured damage.
  voidsRepaired += repairVoids(f, w, h);

  const q = new Int16Array(n);
  for (let i = 0; i < n; i++) {
    const v = f[i];
    if (v < minElevationM) minElevationM = v;
    if (v > maxElevationM) maxElevationM = v;
    // Post-repair every value is inside the plausibility band, which is inside
    // Int16 quarter-metres by construction; the clamp is belt and braces.
    const s = Math.round(v * ELEV_SCALE);
    q[i] = s < -32768 ? -32768 : s > 32767 ? 32767 : s;
  }
  return q;
}

/**
 * Default pixel source: fetch the baked PNG and read it back through a canvas.
 * Same-origin, so getImageData() does not throw. If it ever does, something is
 * fetching S3 directly — see the header.
 *
 * @param {number} z
 * @param {number} x
 * @param {number} y
 */
async function fetchTilePixels(z, x, y) {
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
  return { width: w, height: h, rgba: ctx.getImageData(0, 0, w, h).data };
}

// ---------------------------------------------------------------------------
// Layer construction
// ---------------------------------------------------------------------------

/** Fetch (once) the baker's manifest. Advisory: absence degrades, never throws. */
async function getManifest() {
  if (!manifestFetched) {
    manifestFetched = true;
    manifestData = await fetchJsonOrNull('dem/manifest.json', null);
  }
  return manifestData;
}

/**
 * The sum of every layer's budget, checked against the cap. Called whenever a
 * layer is registered, so a future bake that adds a level cannot quietly blow
 * the ceiling — property 3 in § PAGING.
 * @returns {number} planned bytes
 */
function assertCapBudget() {
  let planned = 0;
  // A pinned layer's budget IS its declared tile count — it holds everything.
  for (const l of layers) planned += l.budgetTiles * TILE_BYTES;
  if (planned > RESIDENT_CAP_BYTES) {
    capViolations++;
    console.error(
      `[elevation] planned resident budget ${(planned / 1048576).toFixed(1)} MiB ` +
        `exceeds the ${(RESIDENT_CAP_BYTES / 1048576).toFixed(0)} MiB cap. ` +
        'Lower a layer budget in PAGING_POLICY or drop a level.',
    );
  }
  return planned;
}

/**
 * Register (or fetch and merge) a layer.
 * @param {number} zoom
 * @param {{south:number,north:number,west:number,east:number}} bbox
 * @param {object|null} level Manifest entry for this zoom, if any.
 */
function ensureLayer(zoom, bbox, level) {
  let layer = layers.find((l) => l.zoom === zoom);
  if (layer) return layer;

  // The manifest's bbox is authoritative when present: the baker rounds out to
  // tile boundaries, so its coverage is a superset of what the caller asked for
  // and using the caller's box would fade the layer out over ground it has.
  const box = level?.bbox ?? bbox;
  const tileSize = level?.tileSize ?? TILE_SIZE;
  const pinned = zoom <= DEM_ZOOM;
  const policy = PAGING_POLICY[zoom] ?? DEFAULT_POLICY;
  const range = tileRange(box, zoom);

  const present = level?.tiles
    ? new Set(
        level.tiles.map((t) =>
          Array.isArray(t) ? tileKey(t[0], t[1]) : tileKey(...t.split('/').map(Number)),
        ),
      )
    : null;

  const mpp = metresPerPixel((box.south + box.north) / 2, zoom, tileSize);
  const tileM = mpp * tileSize;

  layer = {
    zoom,
    tileSize,
    bbox: box,
    pinned,
    tiles: new Map(),
    present,
    range,
    plannedTiles: present ? present.size : range.count,
    radiusM: pinned ? Infinity : policy.radiusM,
    budgetTiles: pinned ? (present ? present.size : range.count) : policy.budgetTiles,
    tileM,
    viewTx: 0,
    viewTy: 0,
    leadTx: 0,
    leadTy: 0,
    lastRepageTx: NaN,
    lastRepageTy: NaN,
    lastRepageMs: -1e9,
    // The frontier fade in this layer's own pixels, so the sampler can compare
    // against the gx/gy it already computed instead of re-projecting.
    fadeInnerPx: pinned ? Infinity : (policy.radiusM * FADE_INNER) / mpp,
    fadeOuterPx: pinned ? Infinity : (policy.radiusM * FADE_OUTER) / mpp,
    edgeBandLat: 0,
    edgeBandLon: 0,
  };

  // Edge fade width in degrees. Only a layer whose bbox is smaller than the
  // whole region has an interesting edge, but computing it uniformly costs
  // nothing and keeps the region's outer rim from stepping either.
  const midLat = (box.south + box.north) / 2;
  const mPerDegLat = 111132.92 - 559.82 * Math.cos((2 * midLat * Math.PI) / 180);
  const mPerDegLon = 111412.84 * Math.cos((midLat * Math.PI) / 180);
  layer.edgeBandLat = EDGE_BAND_M / mPerDegLat;
  layer.edgeBandLon = EDGE_BAND_M / mPerDegLon;

  layers.push(layer);
  layers.sort((a, b) => b.zoom - a.zoom);
  assertCapBudget();
  return layer;
}

// ---------------------------------------------------------------------------
// The pager
// ---------------------------------------------------------------------------

/** Tiles fetched but not yet decoded. Drained under DECODE_BUDGET_MS. */
const decodeQueue = [];
/** Tiles currently being fetched, so we never queue one twice. */
const inflight = new Set();
/** Load requests waiting for a socket, cheapest cost first. */
let loadQueue = [];
let decodeScheduled = false;

/** Reusable scoring buffers. The pager runs a few times a second, not per frame. */
let candKey = new Float64Array(2048);
let candCost = new Float64Array(2048);
let candOrder = new Int32Array(2048);

const now = () =>
  typeof performance !== 'undefined' ? performance.now() : Date.now();

/**
 * Where the viewer is, in local scene metres, and where it is going.
 * Drives everything in § PAGING. Call it once per frame — `world/terrain.js`
 * does, from update(camera), which is on both the rAF path and the
 * `window.sim.tick()` path.
 *
 * Allocation-free.
 *
 * @param {number} x local metres east
 * @param {number} z local metres south
 * @param {number} [vx] velocity, m/s east
 * @param {number} [vz] velocity, m/s south
 * @param {number} [dtMs] frame time, for the arrival ramp. Defaults to 16.7.
 */
export function setViewer(x, z, vx = 0, vz = 0, dtMs = 16.7) {
  if (!Number.isFinite(x) || !Number.isFinite(z)) return;
  viewX = x;
  viewZ = z;
  viewerSet = true;

  let lx = vx * LEAD_SECONDS;
  let lz = vz * LEAD_SECONDS;
  const lead = Math.hypot(lx, lz);
  if (lead > LEAD_MAX_M) {
    const k = LEAD_MAX_M / lead;
    lx *= k;
    lz *= k;
  }
  leadX = x + lx;
  leadZ = z + lz;

  advanceRamps(dtMs);
  repageAll(false);
  pumpDecode(DECODE_BUDGET_MS);
  pumpLoads();
}

/** Advance every paged tile's arrival ramp. See ARRIVE in § BLENDING. */
function advanceRamps(dtMs) {
  if (!(dtMs > 0)) return;
  const step = dtMs / FADE_IN_MS;
  for (let i = 0; i < layers.length; i++) {
    const layer = layers[i];
    if (layer.pinned) continue;
    for (const tile of layer.tiles.values()) {
      if (tile.q && tile.w < 1) {
        tile.w += step;
        // The ramp COMPLETING is a field change like any other: it is the
        // moment this tile's opinion stops being diluted by the coarser layer
        // underneath it. A consumer that re-measured mid-ramp measured a blend.
        if (tile.w >= 1) {
          tile.w = 1;
          fieldEpoch++;
        }
      }
    }
  }
}

const _ll2 = { lat: 0, lon: 0 };

/**
 * Recompute the desired set for one layer: score every candidate tile by
 * distance to the viewer-to-lead segment, keep the cheapest `budgetTiles`,
 * evict the rest, and queue the misses nearest-first.
 *
 * @param {DemLayer} layer
 * @param {boolean} force Ignore the movement/time gates.
 * @param {number} [radiusScale] Shrink the radius (boot warm-up uses this).
 */
function repageLayer(layer, force, radiusScale = 1) {
  if (layer.pinned) return;

  const ts = layer.tileSize;
  localToLl(viewX, viewZ, _ll2);
  const vtx = lonToTileXFloat(_ll2.lon, layer.zoom);
  const vty = latToTileYFloat(_ll2.lat, layer.zoom);
  localToLl(leadX, leadZ, _ll2);
  const ltx = lonToTileXFloat(_ll2.lon, layer.zoom);
  const lty = latToTileYFloat(_ll2.lat, layer.zoom);

  layer.viewTx = vtx * ts;
  layer.viewTy = vty * ts;
  layer.leadTx = ltx * ts;
  layer.leadTy = lty * ts;

  const t = now();
  if (!force) {
    const moved = Math.hypot(vtx - layer.lastRepageTx, vty - layer.lastRepageTy);
    if (
      !(moved > REPAGE_TILE_FRACTION) &&
      t - layer.lastRepageMs < REPAGE_MIN_MS
    ) {
      return;
    }
  }
  layer.lastRepageTx = vtx;
  layer.lastRepageTy = vty;
  layer.lastRepageMs = t;

  const R = (layer.radiusM * radiusScale) / layer.tileM; // radius in tile units
  const r = layer.range;
  const minX = Math.max(r.minX, Math.floor(Math.min(vtx, ltx) - R));
  const maxX = Math.min(r.maxX, Math.ceil(Math.max(vtx, ltx) + R));
  const minY = Math.max(r.minY, Math.floor(Math.min(vty, lty) - R));
  const maxY = Math.min(r.maxY, Math.ceil(Math.max(vty, lty) + R));

  const capacity = (maxX - minX + 1) * (maxY - minY + 1);
  if (capacity > candKey.length) {
    const n = 1 << (32 - Math.clz32(capacity));
    candKey = new Float64Array(n);
    candCost = new Float64Array(n);
    candOrder = new Int32Array(n);
  }

  let n = 0;
  for (let x = minX; x <= maxX; x++) {
    for (let y = minY; y <= maxY; y++) {
      const key = tileKey(x, y);
      if (layer.present && !layer.present.has(key)) continue;
      // Tile centre, in tile units.
      const cost = segDistance(x + 0.5, y + 0.5, vtx, vty, ltx, lty);
      if (cost > R) continue;
      candKey[n] = key;
      candCost[n] = cost * layer.tileM;
      candOrder[n] = n;
      n++;
    }
  }

  const order = candOrder.subarray(0, n);
  order.sort((a, b) => candCost[a] - candCost[b]);

  const keep = Math.min(n, layer.budgetTiles);

  // Mark the winners. `cost` doubles as the eviction key and as the "is it
  // still wanted" flag: anything not touched this pass keeps a stale cost and
  // is evicted below.
  const wanted = new Set();
  for (let i = 0; i < keep; i++) {
    const idx = order[i];
    const key = candKey[idx];
    wanted.add(key);
    const tile = layer.tiles.get(key);
    if (tile) {
      tile.cost = candCost[idx];
      tile.seq = ++seqCounter;
    }
  }

  // Evict everything resident that did not make the cut, cheapest work first.
  for (const [key, tile] of layer.tiles) {
    if (wanted.has(key)) continue;
    if (!tile.q) {
      // Still loading and no longer wanted: drop the record, let the load land
      // and be discarded by the arrival path's membership check.
      layer.tiles.delete(key);
      continue;
    }
    layer.tiles.delete(key);
    residentBytes -= tile.q.byteLength;
    evictions++;
    // Losing a tile moves the field just as surely as gaining one — the fold
    // falls back to the coarser layer under it.
    fieldEpoch++;
  }

  // Queue the misses, nearest first.
  //
  // THE QUEUE IS REBUILT FROM THE DESIRED SET EVERY PASS, not appended to, and
  // the re-enqueue test is "this tile has no DATA", not "this tile has no
  // RECORD". Those are different, and the difference was a bug that survived
  // the first four checks: a record is created the moment a tile is queued, so
  // testing `tiles.has(key)` meant that any pass which discarded the queue —
  // which every pass does — orphaned every record it had created. They stayed
  // in the map forever, counting against the budget, with q === null and no job
  // to fill them. Two viewer jumps were enough to fill the working set with
  // phantoms and silently drop the whole region back to the 51.8 m/px base.
  //
  // Rebuilding from the authoritative desired set makes a lost job impossible:
  // if a tile is wanted and has no data and nothing is in flight for it, it is
  // queued again this pass, every pass.
  for (let i = 0; i < keep; i++) {
    const idx = order[i];
    const key = candKey[idx];
    let tile = layer.tiles.get(key);
    if (tile && tile.q) continue; // already decoded
    if (!tile) {
      tile = { q: null, w: 0, cost: candCost[idx], seq: ++seqCounter, arrived: false };
      layer.tiles.set(key, tile);
    }
    // In flight, or fetched and waiting its turn in the decode budget.
    if (inflight.has(layer.zoom * 4294967296 + key) || tile.arrived) continue;
    loadQueue.push({ layer, key, cost: candCost[idx] });
  }
}

/** Repage every paged layer and re-check the live cap. */
function repageAll(force, radiusScale = 1) {
  // Rebuild the paged half of the queue but never drop pinned work: the base
  // layer's 238 tiles are queued once at boot and a setViewer() landing between
  // two awaits inside drainPaging() must not be able to amputate them.
  loadQueue = loadQueue.filter((j) => j.layer.pinned);
  for (let i = 0; i < layers.length; i++) {
    repageLayer(layers[i], force, radiusScale);
  }
  loadQueue.sort((a, b) => a.cost - b.cost);
  enforceCap();
}

/**
 * The live half of property 3 in § PAGING. Budgets are checked at registration;
 * this checks what is actually held, because a bug in the eviction path would
 * otherwise show up as a browser tab dying rather than as an error message.
 */
function enforceCap() {
  if (residentBytes > peakResidentBytes) peakResidentBytes = residentBytes;
  if (residentBytes <= RESIDENT_CAP_BYTES) return;

  capViolations++;
  // Shed from the finest paged layer outward — the coarser a layer is, the more
  // ground each of its tiles covers, so it is the more valuable byte.
  for (let i = 0; i < layers.length && residentBytes > RESIDENT_CAP_BYTES; i++) {
    const layer = layers[i];
    if (layer.pinned) continue;
    const byCost = [...layer.tiles.entries()]
      .filter(([, t]) => t.q)
      .sort((a, b) => b[1].cost - a[1].cost);
    for (const [key, tile] of byCost) {
      if (residentBytes <= RESIDENT_CAP_BYTES) break;
      layer.tiles.delete(key);
      residentBytes -= tile.q.byteLength;
      evictions++;
    }
  }
  console.error(
    `[elevation] resident bytes exceeded the ${(RESIDENT_CAP_BYTES / 1048576).toFixed(0)} MiB ` +
      'cap and tiles were shed. This is a paging bug, not a tuning problem.',
  );
}

/** Start fetches up to MAX_INFLIGHT, cheapest cost first. */
function pumpLoads() {
  while (inflight.size < MAX_INFLIGHT && loadQueue.length) {
    const job = loadQueue.shift();
    const { layer, key } = job;
    // Dropped by a repage between queueing and now.
    const rec = layer.tiles.get(key);
    if (!rec || rec.q) continue;
    const id = layer.zoom * 4294967296 + key;
    if (inflight.has(id)) continue;
    inflight.add(id);

    const x = key % 65536;
    const y = (key - x) / 65536;
    tilePixelSource(layer.zoom, x, y)
      .then((px) => {
        inflight.delete(id);
        if (!px) {
          tilesMissing++;
          layer.tiles.delete(key);
          pumpLoads();
          return;
        }
        const rec = layer.tiles.get(key);
        if (!rec) return; // evicted while the fetch was open
        rec.arrived = true;
        decodeQueue.push({ layer, key, px });
        scheduleDecode();
        pumpLoads();
      })
      .catch(() => {
        inflight.delete(id);
        tilesMissing++;
        layer.tiles.delete(key);
        pumpLoads();
      });
  }
}

/**
 * Turn arrived bitmaps into Int16Arrays under a time budget.
 *
 * Decode plus void repair is about 1.2 ms of straight-line main-thread work per
 * tile. Six of those landing in the same frame would be a visible hitch, so
 * they are drained a couple at a time. Nothing waits on this: a tile that has
 * not been decoded yet is simply a miss, and a miss falls to the coarser layer.
 *
 * @param {number} budgetMs
 */
function pumpDecode(budgetMs) {
  const t0 = now();
  while (decodeQueue.length && now() - t0 < budgetMs) {
    const { layer, key, px } = decodeQueue.shift();
    const rec = layer.tiles.get(key);
    if (!rec) continue; // evicted while in flight
    rec.arrived = false;
    rec.q = decodeTileToInt16(px.rgba, px.width, px.height);
    rec.w = warmingUp || layer.pinned ? 1 : 0;
    residentBytes += rec.q.byteLength;
    tilesLoaded++;
    pageIns++;
    loaded = true;
    // New data is readable from this instant. During the warm-up and on the
    // pinned base rec.w is already 1, so this is the only bump those get.
    fieldEpoch++;
  }
  if (residentBytes > peakResidentBytes) peakResidentBytes = residentBytes;
  if (decodeQueue.length) scheduleDecode();
}

/**
 * Fallback pacing for when nobody is calling setViewer() — during the boot
 * warm-up, for instance. setTimeout is throttled to ~1 Hz in a hidden tab,
 * which is fine: a hidden tab is not flying.
 */
function scheduleDecode() {
  if (decodeScheduled) return;
  decodeScheduled = true;
  setTimeout(() => {
    decodeScheduled = false;
    pumpDecode(DECODE_BUDGET_MS);
  }, 0);
}

/** Resolve once every queued load has landed and been decoded. */
async function drainPaging() {
  // Guard against a pathological loop if a source never settles.
  for (let spins = 0; spins < 100000; spins++) {
    if (!loadQueue.length && !inflight.size && !decodeQueue.length) return;
    pumpLoads();
    pumpDecode(Infinity);
    if (!loadQueue.length && !inflight.size && !decodeQueue.length) return;
    // Yield. A few ms while sockets are open, rather than a 0 ms busy spin.
    await new Promise((r) => setTimeout(r, inflight.size ? 3 : 0));
  }
}

/**
 * Force every outstanding page-in to complete and every arrival ramp to finish.
 *
 * For teleports and for measurement. NOT for the per-frame path — it awaits.
 * @returns {Promise<void>}
 */
export async function flushPaging() {
  await drainPaging();
  for (const layer of layers) {
    for (const tile of layer.tiles.values()) {
      if (tile.q && tile.w < 1) {
        tile.w = 1;
        fieldEpoch++;
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

/**
 * Load a baked DEM layer covering `bbox` at `zoom`.
 *
 * Additive: call once per level, or call loadDetailLayers() to pick up every
 * finer level the manifest declares.
 *
 * A PINNED level (zoom <= DEM_ZOOM) fetches every tile it has and resolves when
 * they are all decoded — that is the guaranteed floor and it must be complete
 * before the first frame. A PAGED level registers itself, warms a
 * WARMUP_RADIUS_FRACTION disc around the viewer, and resolves; the rest streams
 * in behind setViewer().
 *
 * @param {{south:number,north:number,west:number,east:number}} [bbox]
 * @param {number} [zoom]
 * @returns {Promise<void>}
 */
export async function loadRegion(bbox = REGION_BBOX, zoom = DEM_ZOOM) {
  const run = async () => {
    const manifest = await getManifest();
    const level = manifest?.levels?.find((l) => l.zoom === zoom) ?? null;
    const layer = ensureLayer(zoom, bbox, level);

    warmingUp = true;
    try {
      if (layer.pinned) {
        for (const key of layer.present ??
          allKeysInRange(layer.range, layer.tiles)) {
          if (layer.tiles.has(key)) continue;
          layer.tiles.set(key, {
            q: null,
            w: 1,
            cost: 0,
            seq: ++seqCounter,
            arrived: false,
          });
          loadQueue.push({ layer, key, cost: 0 });
        }
        await drainPaging();
        if (!loaded) {
          console.warn(
            `[elevation] no DEM tiles found for z=${zoom}. ` +
              'Run `npm run bake:dem`. The world will be flat sea level.',
          );
        }
      } else {
        repageLayer(layer, true, WARMUP_RADIUS_FRACTION);
        loadQueue.sort((a, b) => a.cost - b.cost);
        await drainPaging();
        // Now widen to the full radius, but do not await it — the aircraft has
        // ground under it and the rest arrives while the user reads the HUD.
        repageLayer(layer, true, 1);
        loadQueue.sort((a, b) => a.cost - b.cost);
        pumpLoads();
      }
    } finally {
      warmingUp = false;
    }
    enforceCap();
  };

  inFlight = inFlight ? inFlight.then(run) : run();
  return inFlight;
}

/** Every tile key in a range, for a level with no manifest to consult. */
function* allKeysInRange(range) {
  for (let x = range.minX; x <= range.maxX; x++) {
    for (let y = range.minY; y <= range.maxY; y++) yield tileKey(x, y);
  }
}

/**
 * Register and warm every level FINER than `baseZoom` that the manifest
 * declares. Callers get whatever was baked without having to name the zooms, so
 * adding a level to bake-dem.mjs needs no change in world/terrain.js.
 *
 * @param {number} [baseZoom]
 * @returns {Promise<void>}
 */
export async function loadDetailLayers(baseZoom = DEM_ZOOM) {
  const manifest = await getManifest();
  const levels = (manifest?.levels ?? [])
    .filter((l) => l.zoom > baseZoom)
    .sort((a, b) => a.zoom - b.zoom);
  if (!levels.length) {
    // Nothing baked beyond the base. §1.6: warn, do not throw.
    console.warn(
      '[elevation] manifest declares no level finer than ' +
        `z=${baseZoom}; the ground will be ${metresPerPixel(47.35, baseZoom).toFixed(0)} m/px.`,
    );
    return;
  }
  for (const l of levels) await loadRegion(l.bbox ?? REGION_BBOX, l.zoom);
}

/** True once at least one DEM tile has been decoded. */
export function isLoaded() {
  return loaded;
}

// ---------------------------------------------------------------------------
// THE FIELD EPOCH — "the answer at some point in the region just changed"
// ---------------------------------------------------------------------------
/**
 * Monotonic counter, bumped whenever this module's answer to
 * `getElevationLocal` can have moved anywhere in the region: a tile decoded, a
 * resident tile evicted, or an arrival ramp reaching 1.
 *
 * WHY ANYTHING NEEDS THIS. Before paging, the field was constant after boot, so
 * a consumer could sample it once and cache the result forever. That is no
 * longer true and the failure it causes is silent: `world/terrain.js` measures
 * each LOD node's geometric error ONCE, when the node is created, and builds its
 * vertices from the field at build time. Boot creates the coarse nodes covering
 * the whole 262 km root while only the pinned 51.8 m/px base is resident, so
 * every node out over the Cascades was measured — and drawn — against a surface
 * four times coarser than the one the aircraft would later fly over. Measured
 * before the fix: flying to Mount Rainier drew a summit built from the base
 * layer, 26.6 m away from the field the wheels use, one whole LOD level short of
 * what the baked data supports.
 *
 * This is deliberately ONE GLOBAL COUNTER rather than a per-tile or per-region
 * signal. A consumer that wants to know whether a specific place changed can
 * re-measure that place; what it cannot do without help is know that re-measuring
 * is worth the cost. A counter it can compare in one integer compare per frame is
 * exactly enough, and it costs nothing when nothing is paging.
 *
 * @returns {number} increments; never resets, never wraps in any real session
 */
export function getFieldEpoch() {
  return fieldEpoch;
}

/**
 * Diagnostics for the HUD, the console and check-elevation.mjs.
 *
 * `voidsRepaired` counts source pixels that failed the plausibility band or the
 * median test and were neighbour-filled. `residentBytes` / `peakResidentBytes`
 * are the numbers property 3 in § PAGING is about; `capViolations` should be 0
 * forever, and any other value means the pager has a bug.
 */
function countDecoded(layer) {
  let n = 0;
  for (const t of layer.tiles.values()) if (t.q) n++;
  return n;
}

export function getRegionStats() {
  return {
    loaded,
    layers: layers.map((l) => ({
      zoom: l.zoom,
      pinned: l.pinned,
      // `tiles` is DECODED tiles — what you can actually sample. `pending` is
      // records that are queued or in flight. Keeping them apart matters:
      // conflating them is what hid the orphaned-record bug in repageLayer(),
      // where the count looked healthy while nothing was readable.
      tiles: countDecoded(l),
      pending: l.tiles.size - countDecoded(l),
      budgetTiles: l.budgetTiles,
      declaredTiles: l.plannedTiles,
      radiusM: l.radiusM,
      metresPerPixel: l.tileM / l.tileSize,
    })),
    tilesLoaded,
    tilesMissing,
    voidsRepaired,
    minElevationM,
    maxElevationM,
    residentBytes,
    peakResidentBytes,
    residentCapBytes: RESIDENT_CAP_BYTES,
    residentTiles: layers.reduce((n, l) => n + countDecoded(l), 0),
    pageIns,
    evictions,
    capViolations,
    fieldEpoch,
    pendingLoads: loadQueue.length + inflight.size + decodeQueue.length,
  };
}

// ---------------------------------------------------------------------------
// Sampling
// ---------------------------------------------------------------------------

/**
 * Raw pixel lookup within a layer, in that layer's global pixel space.
 * Returns NaN when the covering tile is not resident, which is what lets the
 * fold fall through to a coarser layer instead of punching a hole in the ground.
 */
function texelAt(layer, px, py) {
  const ts = layer.tileSize;
  const tx = Math.floor(px / ts);
  const ty = Math.floor(py / ts);
  const tile = layer.tiles.get(tileKey(tx, ty));
  if (!tile || !tile.q) return NaN;
  return tile.q[(py - ty * ts) * ts + (px - tx * ts)] * ELEV_SCALE_INV;
}

/** Written by sampleLayer so layerWeight can reuse the pixel coordinates. */
let _gx = 0;
let _gy = 0;
/** Minimum arrival ramp across the four texels the last sample touched. */
let _arriveW = 1;

/**
 * Bilinearly sample one layer at a geodetic point.
 *
 * Sampling happens in GLOBAL pixel space, so interpolation crosses tile seams
 * correctly instead of clamping at tile edges — that is what stops the terrain
 * showing a grid of creases.
 *
 * @returns {number} metres, or NaN if any of the four texels is not resident.
 */
function sampleLayer(layer, lat, lon) {
  const ts = layer.tileSize;
  // -0.5 shifts from pixel-corner to pixel-centre convention.
  const gx = lonToTileXFloat(lon, layer.zoom) * ts - 0.5;
  const gy = latToTileYFloat(lat, layer.zoom) * ts - 0.5;
  _gx = gx;
  _gy = gy;

  const x0 = Math.floor(gx);
  const y0 = Math.floor(gy);
  const fx = gx - x0;
  const fy = gy - y0;

  // Fast path: all four texels in one tile, which is true for 99% of samples.
  const tx = Math.floor(x0 / ts);
  const ty = Math.floor(y0 / ts);
  const lx = x0 - tx * ts;
  const ly = y0 - ty * ts;
  if (lx < ts - 1 && ly < ts - 1) {
    const tile = layer.tiles.get(tileKey(tx, ty));
    if (!tile || !tile.q) return NaN;
    _arriveW = tile.w;
    const q = tile.q;
    const i = ly * ts + lx;
    const h00 = q[i] * ELEV_SCALE_INV;
    const h10 = q[i + 1] * ELEV_SCALE_INV;
    const h01 = q[i + ts] * ELEV_SCALE_INV;
    const h11 = q[i + ts + 1] * ELEV_SCALE_INV;
    const top = h00 + (h10 - h00) * fx;
    const bot = h01 + (h11 - h01) * fx;
    return top + (bot - top) * fy;
  }

  // Seam: read the four texels independently, and take the SLOWEST arrival ramp
  // of the tiles involved so a newly paged neighbour cannot pop a seam open.
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
  _arriveW = Math.min(
    tileRamp(layer, x0, y0),
    tileRamp(layer, x0 + 1, y0),
    tileRamp(layer, x0, y0 + 1),
    tileRamp(layer, x0 + 1, y0 + 1),
  );

  const top = h00 + (h10 - h00) * fx;
  const bot = h01 + (h11 - h01) * fx;
  return top + (bot - top) * fy;
}

function tileRamp(layer, px, py) {
  const ts = layer.tileSize;
  const tile = layer.tiles.get(
    tileKey(Math.floor(px / ts), Math.floor(py / ts)),
  );
  return tile ? tile.w : 0;
}

/**
 * How much of this layer's opinion to use, in [0, 1]. The product of the three
 * fades documented in § BLENDING. The pinned base is always 1 — it is the
 * bottom of the fold and there is nothing coarser to hand off to.
 */
function layerWeight(layer, lat, lon) {
  if (layer.pinned) return 1;

  // EDGE: distance inside the layer's own bbox.
  const b = layer.bbox;
  let w =
    smoothstep(0, layer.edgeBandLat, lat - b.south) *
    smoothstep(0, layer.edgeBandLat, b.north - lat) *
    smoothstep(0, layer.edgeBandLon, lon - b.west) *
    smoothstep(0, layer.edgeBandLon, b.east - lon);
  if (w <= 0) return 0;

  // FRONT: distance from the viewer, in this layer's pixels. _gx/_gy were just
  // written by sampleLayer, so this costs a subtract and a hypot.
  const d = Math.hypot(_gx - layer.viewTx, _gy - layer.viewTy);
  w *= 1 - smoothstep(layer.fadeInnerPx, layer.fadeOuterPx, d);
  if (w <= 0) return 0;

  // ARRIVE: the per-tile ramp, from the sample we just took.
  return w * _arriveW;
}

/**
 * Ground elevation in METRES above mean sea level.
 *
 * Defined everywhere. Outside the baked region, or before loadRegion()
 * resolves, it returns SEA_LEVEL_M. Never returns NaN, never throws, never
 * awaits — the flight model calls this several times per wheel per substep and
 * must not be able to trip over a gap in the data or a tile that has not
 * arrived. See § PAGING property 1, and § BLENDING for the fold.
 *
 * @param {number} lat degrees
 * @param {number} lon degrees
 * @returns {number} metres MSL
 */
export function getElevation(lat, lon) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return SEA_LEVEL_M;

  let h = 0;
  let wRem = 1;
  for (let i = 0; i < layers.length; i++) {
    const layer = layers[i];
    const s = sampleLayer(layer, lat, lon);
    if (Number.isNaN(s)) continue; // not resident: the next layer answers
    const w = layerWeight(layer, lat, lon) * wRem;
    if (w <= 0) continue;
    h += s * w;
    wRem -= w;
    if (wRem <= 1e-6) return h;
  }
  // Whatever weight nothing claimed is sea level. Inside the region the pinned
  // base always claims it all, so this only fires over open ocean and BC.
  return h + SEA_LEVEL_M * wRem;
}

const _ll = { lat: 0, lon: 0 };

/**
 * Ground elevation at a LOCAL scene coordinate. Allocation-free.
 *
 * This is the function terrain.getHeightAt() must delegate to, and the one the
 * flight model's ground height must come from (§1.4). Two different samplers is
 * how you get an aircraft that sinks through a hillside.
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
 */
export function isWater(lat, lon) {
  return getElevation(lat, lon) <= WATER_LEVEL_M;
}

/**
 * Bulk-sample a regular grid in local scene space. Use this when building
 * terrain geometry — it is the same sampler as getElevationLocal(), so the mesh
 * and the collision surface cannot drift apart (§1.4), and it avoids a few
 * hundred thousand redundant object allocations.
 *
 * Grid point (i, j) sits at local (x0 + i * dx, z0 + j * dz), written to
 * out[j * nx + i].
 *
 * @returns {Float32Array} length nx * nz, metres MSL
 */
export function fillHeightGrid(x0, z0, dx, dz, nx, nz, out) {
  const target = out && out.length >= nx * nz ? out : new Float32Array(nx * nz);
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
 *
 * @param {number} [epsM] sample spacing, metres. The default is 15 rather than
 *        the old 30: with a 12.95 m/px base layer, 30 m averaged across two and
 *        a half source pixels and flattened exactly the slopes the flight
 *        model's crash test cares about. Smaller than the source resolution
 *        just amplifies interpolation noise, so this tracks it.
 * @returns {{x:number, y:number, z:number}} Unit length, +Y up.
 */
export function getNormalLocal(x, z, epsM = 15) {
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

/**
 * Warm the paged layers around a geodetic point and wait for them.
 *
 * For teleports: main.js moves the aircraft to a named place, and without this
 * the first frames there would be drawn from the pinned base and then morph as
 * z=13 arrives. Awaiting it costs a few hundred milliseconds of loading screen
 * and buys ground that is correct on the first frame.
 *
 * @param {number} lat
 * @param {number} lon
 * @returns {Promise<void>}
 */
export async function warmAt(lat, lon) {
  const p = llToLocal(lat, lon);
  setViewer(p.x, p.z, 0, 0, FADE_IN_MS);
  repageAll(true);
  await flushPaging();
}

/** Whether setViewer() has ever been called. Diagnostics only. */
export function isViewerSet() {
  return viewerSet;
}

/**
 * What ONE layer says, and how much of the blend it is currently winning.
 *
 * Diagnostics, not a sampling path — nothing in the sim should call this per
 * frame. It exists because the two questions "is this layer georeferenced
 * correctly" and "is the blend actually blending" are otherwise unanswerable
 * from outside: getElevation() deliberately hides which layer answered, so a
 * z=14 inset that was half a tile out, or an edge fade that was really a
 * switch, would both look like slightly odd terrain. scripts/check-elevation.mjs
 * uses it to assert the transition bands directly rather than by proxy.
 *
 * @param {number} zoom
 * @param {number} lat
 * @param {number} lon
 * @returns {{height:number, weight:number, resident:boolean}} height is NaN
 *          when no tile covering the point is resident.
 */
export function getLayerElevation(zoom, lat, lon) {
  const layer = layers.find((l) => l.zoom === zoom);
  if (!layer) return { height: NaN, weight: 0, resident: false };
  const h = sampleLayer(layer, lat, lon);
  if (Number.isNaN(h)) return { height: NaN, weight: 0, resident: false };
  return { height: h, weight: layerWeight(layer, lat, lon), resident: true };
}
