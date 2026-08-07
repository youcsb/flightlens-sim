/**
 * buildings.js — real building footprints, decoded.
 *
 * Contract: MODULES.md §2.16.
 *
 *   loadBuildings()   -> Promise<BuildingSet|null>
 *   getBuildings()    -> BuildingSet|null
 *   isBuildingsLoaded()
 *   buildingProvenance()
 *   nearestBuilding(lat, lon, maxDistanceM?)
 *
 * This module owns DECODING and PROVENANCE. `world/landmarkModels.js` owns what
 * the footprints look like once extruded. Same split as landmarks.js: the
 * geography has to be exactly right, the craft can be improved without touching
 * a coordinate.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS REAL IN HERE
 * ---------------------------------------------------------------------------
 * The POLYGONS are real — Microsoft Building Footprints, baked by
 * scripts/bake-buildings.mjs. Position, outline, orientation and area come from
 * the source. Round 1's downtown was an invented block grid, and the geographic
 * critic named it: "individual buildings are not real".
 *
 * The HEIGHTS mostly are not, and `srcOf(i)` says so for every single building:
 *
 *   'published'  a published architectural height, matched to this footprint by
 *                proximity. 32 buildings.
 *   'dsm'        a STOREY COUNT read off Microsoft's photogrammetric surface
 *                model, which is only trusted below 18 m. 13,761 buildings.
 *   'derived'    footprint area and distance to a district core, through the
 *                model documented in the baker. 10,186 buildings.
 *
 * The DSM's raw metres are never used and that is a measured decision, not a
 * precaution: the field saturates near 35 m, and Columbia Center — 284 m —
 * reads 25.1 m in it. See the baker's header for the full table. Anything that
 * wants to display or reason about a height must read `srcOf` first.
 *
 * ---------------------------------------------------------------------------
 * WHY THE FILE IS PARALLEL FLAT ARRAYS
 * ---------------------------------------------------------------------------
 * 24k objects each holding a nested ring array is about 7 MB of JSON and ~70 ms
 * of parse, and then 24k live objects for the GC to walk. The baked form is six
 * flat integer arrays: 1.68 MB, ~25 ms, and it decodes straight into typed
 * arrays that the geometry builder can read without allocating anything per
 * building.
 *
 * Ring vertices are stored as METRES relative to each building's anchor, not as
 * degrees, so the runtime never projects a vertex. That is exact rather than
 * convenient: the scene projection is an anchored equirectangular with both
 * metres-per-degree factors frozen at SCALE_LAT (§1.3), i.e. a uniform affine
 * map, so a metre offset computed at bake time is the same metre offset at
 * runtime anywhere in the region. `assertScale()` below is what stops that
 * quietly becoming false.
 */

import { fetchJsonOrNull } from '../core/assets.js';
import { SCALE_LAT, metresPerDegreeLat, metresPerDegreeLon, distanceBetween, inBbox } from './coords.js';

/** @typedef {'published'|'dsm'|'derived'} HeightSource */

export const SRC_PUBLISHED = 0;
export const SRC_DSM = 1;
export const SRC_DERIVED = 2;

/** @type {HeightSource[]} index -> name, matching the constants above. */
export const SOURCE_NAMES = ['published', 'dsm', 'derived'];

const SRC_CHAR = { p: SRC_PUBLISHED, m: SRC_DSM, d: SRC_DERIVED };

/**
 * @typedef {Object} BuildingSet
 * @property {number} count
 * @property {number} totalVertices
 * @property {Float64Array} anchorLat   Ring vertex 0, degrees.
 * @property {Float64Array} anchorLon
 * @property {Uint32Array}  ringStart   count+1 entries; ring i is [start, start+1).
 * @property {Float32Array} ringE       Metres EAST of the building's anchor.
 * @property {Float32Array} ringN       Metres NORTH of the building's anchor.
 * @property {Float32Array} heightM     Above the building's own base.
 * @property {Float32Array} areaM2      Footprint area, from the real polygon.
 * @property {Uint8Array}   src         SRC_* per building.
 * @property {object}       bbox
 * @property {object}       meta        generated / source / note / districts.
 */

/** @type {BuildingSet|null} */
let set = null;
/** @type {Promise<BuildingSet|null>|null} */
let loadPromise = null;

/**
 * Guard against the one failure that would silently deform every footprint in
 * the world: the baker freezing metres-per-degree at a different latitude from
 * `coords.js`. A 1 degree drift is a 1.3% scale error on every building — too
 * small to notice as an error and too large to be right.
 */
function assertScale(fileScaleLat) {
  if (!Number.isFinite(fileScaleLat)) return true;
  if (Math.abs(fileScaleLat - SCALE_LAT) < 1e-9) return true;
  console.warn(
    `[buildings] baked at SCALE_LAT ${fileScaleLat} but coords.js says ${SCALE_LAT}. ` +
      'Footprints would be the wrong size. Re-run `node scripts/bake-buildings.mjs`.',
  );
  return false;
}

/**
 * Load and decode the baked footprints. Idempotent; concurrent callers share
 * one fetch. Never throws — a missing bake returns null and the caller falls
 * back to the procedural city mass (§1.6).
 *
 * @returns {Promise<BuildingSet|null>}
 */
export async function loadBuildings() {
  if (loadPromise) return loadPromise;
  loadPromise = (async () => {
    const data = await fetchJsonOrNull('data/buildings.json', null);
    if (!data || !Array.isArray(data.rings) || !Array.isArray(data.anchors)) {
      console.warn(
        '[buildings] no footprint data. Run `node scripts/bake-buildings.mjs`. ' +
          'Downtown falls back to the procedural block mass.',
      );
      return null;
    }
    if (!assertScale(data.scaleLat)) return null;

    const t0 = typeof performance !== 'undefined' ? performance.now() : Date.now();
    set = decode(data);
    const t1 = typeof performance !== 'undefined' ? performance.now() : Date.now();
    console.info(
      `[buildings] ${set.count.toLocaleString()} real footprints, ` +
        `${set.totalVertices.toLocaleString()} vertices, decoded in ${(t1 - t0).toFixed(0)} ms — ` +
        `heights: ${set.meta.provenance.published} published, ` +
        `${set.meta.provenance.dsm} DSM storeys, ${set.meta.provenance.derived} derived`,
    );
    return set;
  })();
  return loadPromise;
}

/**
 * Decode a parsed buildings.json into typed arrays.
 *
 * Exported as a TEST SEAM, not as a second front door. The browser path reads
 * the file through `fetch`, which needs a URL base and a server; Node has
 * neither, so without this the decoder — the one piece of code that can turn
 * every footprint in the world into the wrong shape — would be unassertable
 * anywhere. `scripts/check-buildings.mjs` runs THIS function, the shipping one,
 * against the real baked file.
 *
 * @param {object} data Parsed public/data/buildings.json
 * @returns {BuildingSet}
 */
export function decodeBuildings(data) {
  set = decode(data);
  // Satisfy loadBuildings() too, so the shipping consumer path — which goes
  // through fetch, and cannot in Node — resolves to this same set rather than
  // falling back to the procedural city and quietly testing the wrong code.
  loadPromise = Promise.resolve(set);
  return set;
}

/**
 * One pass over the flat arrays. Everything is sized up front from `count` and
 * `rings.length`, so there is exactly one allocation per output array and no
 * per-building garbage.
 */
function decode(data) {
  const count = data.count | 0;
  const quantM = data.quantM || 0.25;
  const quantDeg = data.quantDeg || 1e-6;
  const mLat = metresPerDegreeLat(SCALE_LAT);
  const mLon = metresPerDegreeLon(SCALE_LAT);

  const anchors = data.anchors;
  const rings = data.rings;
  const heights = data.heights;
  const srcStr = String(data.src || '');

  // rings is [n, e,n, e,n, ...] repeated: total vertices is (rings.length - count) / 2.
  const totalVertices = (rings.length - count) >> 1;

  const anchorLat = new Float64Array(count);
  const anchorLon = new Float64Array(count);
  const ringStart = new Uint32Array(count + 1);
  const ringE = new Float32Array(totalVertices);
  const ringN = new Float32Array(totalVertices);
  const heightM = new Float32Array(count);
  const areaM2 = new Float32Array(count);
  const src = new Uint8Array(count);

  let aLat = 0;
  let aLon = 0;
  let rp = 0; // read cursor into rings
  let vp = 0; // write cursor into ringE / ringN

  for (let i = 0; i < count; i++) {
    aLat += anchors[i * 2];
    aLon += anchors[i * 2 + 1];
    const lat = aLat * quantDeg;
    const lon = aLon * quantDeg;
    anchorLat[i] = lat;
    anchorLon[i] = lon;

    // The baker delta-chained from the anchor's own quantised metres, so this
    // has to reconstruct that number exactly, not the pre-rounding one.
    let ke = Math.round((lon * mLon) / quantM);
    let kn = Math.round((lat * mLat) / quantM);

    const n = rings[rp++];
    ringStart[i] = vp;
    const v0 = vp;
    for (let k = 0; k < n; k++) {
      ke += rings[rp++];
      kn += rings[rp++];
      ringE[vp] = ke * quantM;
      ringN[vp] = kn * quantM;
      vp++;
    }
    // Re-express relative to the anchor. Absolute metres from the prime
    // meridian are ~ -1.36e7 and would eat every bit of Float32 precision.
    const be = ringE[v0];
    const bn = ringN[v0];
    let a = 0;
    for (let k = v0; k < vp; k++) {
      ringE[k] -= be;
      ringN[k] -= bn;
    }
    for (let k = v0; k < vp; k++) {
      const j = k + 1 < vp ? k + 1 : v0;
      a += ringE[k] * ringN[j] - ringE[j] * ringN[k];
    }
    areaM2[i] = Math.abs(a) * 0.5;
    heightM[i] = heights[i] * 0.1;
    src[i] = SRC_CHAR[srcStr[i]] ?? SRC_DERIVED;
  }
  ringStart[count] = vp;

  const prov = data.provenance || { published: 0, dsm: 0, derived: count };
  return {
    count,
    totalVertices,
    anchorLat,
    anchorLon,
    ringStart,
    ringE,
    ringN,
    heightM,
    areaM2,
    src,
    bbox: data.bbox,
    meta: {
      generated: data.generated,
      source: data.source,
      sourceUrl: data.sourceUrl,
      note: data.note,
      districts: data.districts || [],
      publishedNames: data.publishedNames || [],
      provenance: prov,
      chunkM: data.chunkM || 3000,
    },
  };
}

/** The decoded set, or null before loadBuildings() resolves / if unbaked. */
export function getBuildings() {
  return set;
}

export function isBuildingsLoaded() {
  return set !== null;
}

/**
 * Honest-provenance readout, in the shape the geo agent's convention uses.
 * @returns {{published:number, dsm:number, derived:number, total:number}|null}
 */
export function buildingProvenance() {
  if (!set) return null;
  const p = set.meta.provenance;
  return { ...p, total: set.count };
}

/** @param {number} i @returns {HeightSource} */
export function srcOf(i) {
  return SOURCE_NAMES[set ? set.src[i] : SRC_DERIVED];
}

/** True if a point is inside the box the footprints were baked for. */
export function coversLatLon(lat, lon) {
  return !!set && inBbox(lat, lon, set.bbox);
}

const _c = { lat: 0, lon: 0 };

/**
 * Area centroid of a footprint, in degrees.
 *
 * The anchor is ring VERTEX 0, which for an L-shaped block can be 40 m from the
 * middle of the building. Anything comparing a footprint against a published
 * coordinate has to use the centroid or it inherits that error and reports it
 * as a placement offset.
 *
 * @param {number} i
 * @param {{lat:number,lon:number}} [out]
 */
export function centroidLatLon(i, out = _c) {
  const s = set.ringStart[i];
  const e = set.ringStart[i + 1];
  let a = 0;
  let ce = 0;
  let cn = 0;
  for (let k = s; k < e; k++) {
    const j = k + 1 < e ? k + 1 : s;
    const cr = set.ringE[k] * set.ringN[j] - set.ringE[j] * set.ringN[k];
    a += cr;
    ce += (set.ringE[k] + set.ringE[j]) * cr;
    cn += (set.ringN[k] + set.ringN[j]) * cr;
  }
  if (Math.abs(a) < 1e-6) {
    out.lat = set.anchorLat[i];
    out.lon = set.anchorLon[i];
    return out;
  }
  out.lat = set.anchorLat[i] + cn / (3 * a) / metresPerDegreeLat(SCALE_LAT);
  out.lon = set.anchorLon[i] + ce / (3 * a) / metresPerDegreeLon(SCALE_LAT);
  return out;
}

/**
 * Nearest footprint to a geodetic point — for a "what am I over" readout, and
 * for a check script to assert that a named tower's real polygon is where it
 * should be.
 *
 * Linear over 24k buildings, measured on the CENTROID. ~4 ms. Fine for a click
 * or an assertion; do not call it per frame.
 *
 * @returns {{index:number, distanceM:number, heightM:number, areaM2:number, source:HeightSource}|null}
 */
export function nearestBuilding(lat, lon, maxDistanceM = Infinity) {
  if (!set) return null;
  let bi = -1;
  let bd = Infinity;
  const c = { lat: 0, lon: 0 };
  for (let i = 0; i < set.count; i++) {
    centroidLatLon(i, c);
    const d = distanceBetween(lat, lon, c.lat, c.lon);
    if (d < bd) {
      bd = d;
      bi = i;
    }
  }
  if (bi < 0 || bd > maxDistanceM) return null;
  return {
    index: bi,
    distanceM: bd,
    heightM: set.heightM[bi],
    areaM2: set.areaM2[bi],
    source: SOURCE_NAMES[set.src[bi]],
  };
}
