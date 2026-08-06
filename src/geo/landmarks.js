/**
 * landmarks.js — recognisable things at their true coordinates.
 *
 * Contract: MODULES.md §2.6.
 *
 *   loadLandmarks() -> Promise<Landmark[]>
 *   getLandmarks() / getLandmark(name)
 *   placeLandmarks(scene) -> THREE.Group
 *   disposeLandmarks(group)
 *   nearestLandmark(lat, lon, maxDistanceM?)
 *
 * This module owns WHERE things go. src/world/landmarkModels.js owns what they
 * look like. The split matters: placement is geography and must be exactly
 * right; modelling is craft and can be improved without touching a coordinate.
 *
 * ---------------------------------------------------------------------------
 * WHY THE DATA IS BAKED, AND WHY A BBOX FILTER IS NOT ENOUGH
 * ---------------------------------------------------------------------------
 * Source: Wikidata SPARQL, baked by scripts/bake-landmarks.mjs. Querying by
 * English label is wildly ambiguous. A 33-name probe returned 69 rows, of which
 * 30 were in our bbox and several of THOSE were still wrong:
 *
 *   - "Mount Baker" returns 18 items. The two inside our bbox are a light rail
 *     station and a Seattle neighbourhood; the volcano is at 48.7773, outside
 *     it. A bbox filter keeps both wrong answers and discards the right one.
 *   - "Mount Rainier" returns the mountain (Q194057) and a glacier node 120 m
 *     away, both in bbox. There is also one in Maryland.
 *   - "Glacier Peak" returns 11 items and zero in bbox — the real summit is
 *     0.09 deg east of our eastern edge.
 *
 * => The baker resolves every landmark by WIKIDATA Q-ID and additionally
 *    asserts the result lands within 400 m of a coordinate pinned in its
 *    curated table. The bbox is the last line of defence, not the filter.
 *    loadLandmarks() re-applies it here anyway, because a namesake slipping
 *    through fails SILENTLY — you get a stadium in the wrong state and no error.
 *
 * ---------------------------------------------------------------------------
 * HEIGHTS AND BASES
 * ---------------------------------------------------------------------------
 * `heightM` is height ABOVE THE LANDMARK'S OWN BASE — 184 m for the Space
 * Needle, not 184 m MSL. Every landmark is placed at getElevation(lat, lon), so
 * the DEM supplies the base and heightM stacks on top of it.
 *
 * PEAKS ARE TERRAIN. kind:'peak' entries carry heightM = 0 and get no mesh:
 * Mount Rainier's summit is already in the DEM at ~4390 m, and drawing a
 * 4392 m cone on top of it would produce an 8.8 km mountain. If Rainier looks
 * wrong, that is an elevation bug, not a landmark bug.
 */

import * as THREE from 'three';
import { llToLocal, inBbox, REGION_BBOX, distanceBetween } from './coords.js';
import { getElevation, isLoaded } from './elevation.js';
import { fetchJsonOrNull } from '../core/assets.js';
import { buildLandmarkModel, buildDowntownMass } from '../world/landmarkModels.js';

/**
 * @typedef {Object} Landmark
 * @property {string} name        Display name, e.g. "Space Needle".
 * @property {number} lat
 * @property {number} lon
 * @property {number} heightM     Height above its own base, metres. 0 for peaks.
 * @property {LandmarkKind} kind
 * @property {string} [wikidataId] e.g. "Q5317". Provenance; useful for re-baking.
 * @property {number} [widthM]     Short-axis footprint, metres.
 * @property {number} [lengthM]    Long-axis footprint, metres. Defaults to widthM.
 * @property {number} [headingDeg] TRUE bearing of the long axis. Default 0.
 * @property {string} [model]      Builder key in world/landmarkModels.js.
 * @property {boolean} [roof]      Stadium has a roof (changes the truss layout).
 * @property {string} [heightSrc]  'wikidata' | 'curated' | 'dem'. Provenance.
 */

/**
 * @typedef {'tower'|'peak'|'building'|'stadium'|'bridge'|'other'} LandmarkKind
 */

/**
 * Minimal built-in set, used when public/data/landmarks.json is absent so the
 * sim always has the two landmarks the user actually named. Coordinates and
 * heights verified against Wikidata (Q5317, Q194057).
 * @type {Landmark[]}
 */
const FALLBACK_LANDMARKS = [
  {
    name: 'Space Needle',
    lat: 47.6204,
    lon: -122.3491,
    heightM: 184,
    kind: 'tower',
    wikidataId: 'Q5317',
    widthM: 42,
    model: 'spaceNeedle',
  },
  {
    name: 'Mount Rainier',
    lat: 46.8517,
    lon: -121.7603,
    heightM: 0,
    kind: 'peak',
    wikidataId: 'Q194057',
  },
];

/** @type {Landmark[]} */
let landmarks = [];
/** @type {Promise<Landmark[]>|null} */
let loadPromise = null;

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

/**
 * Load the baked landmark set. Idempotent; concurrent callers share one fetch.
 * Never throws and never blocks the boot — a missing bake degrades to the
 * built-in pair (MODULES.md §1.6).
 *
 * @returns {Promise<Landmark[]>}
 */
export async function loadLandmarks() {
  if (loadPromise) return loadPromise;
  loadPromise = (async () => {
    const data = await fetchJsonOrNull('data/landmarks.json', null);
    const raw = Array.isArray(data?.landmarks) ? data.landmarks : null;

    if (!raw) {
      console.warn(
        '[landmarks] no landmark data. Run `npm run bake:landmarks`. ' +
          'Using the built-in Space Needle / Mount Rainier fallback.',
      );
      landmarks = FALLBACK_LANDMARKS.slice();
      return landmarks;
    }

    landmarks = raw.filter((l) => {
      if (!Number.isFinite(l?.lat) || !Number.isFinite(l?.lon)) return false;
      if (!inBbox(l.lat, l.lon, REGION_BBOX)) {
        console.warn(
          `[landmarks] dropping "${l.name}" at ${l.lat},${l.lon} — ` +
            'outside REGION_BBOX. Probable Wikidata namesake collision.',
        );
        return false;
      }
      return true;
    });
    verifyLandmarks(landmarks);
    return landmarks;
  })();
  return loadPromise;
}

/**
 * How far a `kind:'peak'` may sit from the nearest DEM summit before it is
 * probably not standing on its own mountain.
 *
 * Generous on purpose: Wikidata pins a summit anywhere within its own map
 * marker, and the base DEM layer is 52 m/px, so a few hundred metres is normal.
 * 800 m is not — at that distance the label is on a different landform.
 */
const PEAK_SNAP_M = 800;

/** Half-width of the summit search, degrees. ~2.2 km, comfortably past the tolerance. */
const PEAK_SEARCH_DEG = 0.02;

/**
 * Second-line checks on the baked set. Reports; never mutates, never throws.
 *
 * The bbox filter above catches a landmark in the wrong STATE. It cannot catch
 * a landmark in the wrong PLACE, and for peaks that failure is both easy to
 * make and invisible: every name in the Cascades is attached to a ridge, a
 * trailhead, a creek and a lake as well as to a summit, and any of them is
 * inside the bbox. So peaks get the one test the runtime can actually perform —
 * a mountain's coordinate should be on or very near a local maximum of the
 * elevation field, because that is what a mountain is.
 *
 * It deliberately does NOT snap the coordinate to the DEM maximum it finds. The
 * nearest summit is not necessarily the right summit — Mount Si's neighbour
 * Mount Teneriffe is 136 m taller and 2.5 km away — so snapping would trade a
 * label that is slightly wrong for one that is confidently wrong. Fix the
 * coordinate in the baker's curated table, where it can be checked against a
 * source.
 *
 * @param {Landmark[]} list
 * @returns {{noId: string[], duplicateId: string[], offSummit: string[]}}
 */
export function verifyLandmarks(list) {
  const noId = [];
  const duplicateId = [];
  const offSummit = [];
  const byId = new Map();

  for (const l of list) {
    if (!l.wikidataId) {
      noId.push(l.name);
    } else if (byId.has(l.wikidataId)) {
      duplicateId.push(`${l.wikidataId} = "${byId.get(l.wikidataId)}" and "${l.name}"`);
    } else {
      byId.set(l.wikidataId, l.name);
    }

    // The DEM is total (returns sea level everywhere before it loads), so
    // without this guard every peak would look like it was in the ocean.
    if (l.kind !== 'peak' || !isLoaded()) continue;
    const here = getElevation(l.lat, l.lon);
    let best = { h: here, lat: l.lat, lon: l.lon };
    const step = PEAK_SEARCH_DEG / 10;
    for (let dLat = -PEAK_SEARCH_DEG; dLat <= PEAK_SEARCH_DEG; dLat += step) {
      for (let dLon = -PEAK_SEARCH_DEG * 1.5; dLon <= PEAK_SEARCH_DEG * 1.5; dLon += step) {
        const h = getElevation(l.lat + dLat, l.lon + dLon);
        if (h > best.h) best = { h, lat: l.lat + dLat, lon: l.lon + dLon };
      }
    }
    const d = distanceBetween(l.lat, l.lon, best.lat, best.lon);
    if (d > PEAK_SNAP_M) {
      offSummit.push(
        `"${l.name}" (${l.wikidataId}) sits at ${here.toFixed(0)} m, but the ` +
          `nearest summit is ${best.h.toFixed(0)} m, ${(d / 1000).toFixed(2)} km away at ` +
          `${best.lat.toFixed(4)},${best.lon.toFixed(4)}`,
      );
    }
  }

  if (noId.length) {
    console.warn(
      `[landmarks] no Wikidata Q-ID, so nothing checked the identity: ${noId.join(', ')}`,
    );
  }
  if (duplicateId.length) {
    console.warn(`[landmarks] the same Q-ID twice: ${duplicateId.join('; ')}`);
  }
  if (offSummit.length) {
    console.warn(
      `[landmarks] peak coordinate is not on a summit — check the Q-ID: ${offSummit.join('; ')}`,
    );
  }
  return { noId, duplicateId, offSummit };
}

/** The landmarks loaded so far. Empty until loadLandmarks() resolves. */
export function getLandmarks() {
  return landmarks;
}

/**
 * @param {string} name
 * @returns {Landmark|null}
 */
export function getLandmark(name) {
  const wanted = String(name).toLowerCase();
  return landmarks.find((l) => l.name.toLowerCase() === wanted) ?? null;
}

// ---------------------------------------------------------------------------
// Placement
// ---------------------------------------------------------------------------

const DEG = Math.PI / 180;
const _p = { x: 0, z: 0 };

/**
 * Rotation about +Y that maps a model's local +X onto a true bearing.
 *
 * Scene axes are +X east, -Z north (MODULES.md §1.2), so bearing b is the
 * direction (sin b, 0, -cos b). Rotating +X by theta about +Y gives
 * (cos theta, 0, -sin theta); equating the two gives theta = 90 - b.
 *
 * Sanity: b = 90 (east) -> theta = 0, +X stays east. b = 0 (north) ->
 * theta = 90 deg, +X becomes (0, 0, -1) = north. Both correct.
 *
 * @param {number} headingDeg
 * @returns {number} radians
 */
function yawForHeading(headingDeg) {
  return (90 - (headingDeg ?? 0)) * DEG;
}

/**
 * Radius of the keep-out disc a modelled landmark punches in the filler mass,
 * so no anonymous block grows up through Columbia Center or the Needle's legs.
 */
function footprintRadius(l) {
  const long = Math.max(l.lengthM ?? 0, l.widthM ?? 0);
  if (long > 0) return long * 0.62 + 18;
  return Math.max(35, (l.heightM ?? 0) * 0.2);
}

/**
 * Build and attach the landmark group.
 *
 * ASYNC-SAFE BY DESIGN: this returns an EMPTY group immediately and fills it
 * once loadLandmarks() resolves, kicking off that load itself if nobody has.
 * Callers never await it and never re-attach anything — hold the group, it
 * populates itself. The trade-off is that group.children is empty on the frame
 * you call this, so do not measure it synchronously.
 *
 * @param {THREE.Scene|THREE.Object3D} scene Parent to attach to. May be null.
 * @param {object} [opts]
 * @param {boolean} [opts.cityMass=true] Add the procedural downtown filler.
 * @returns {THREE.Group} Named 'landmarks'.
 */
export function placeLandmarks(scene, opts = {}) {
  const group = new THREE.Group();
  group.name = 'landmarks';
  if (scene) scene.add(group);

  loadLandmarks().then((list) => {
    const keepOut = [];
    let placed = 0;

    for (const l of list) {
      // The DEM supplies the base elevation, so a landmark sits on the real
      // ground rather than at an assumed sea level. Bridges are the exception
      // that proves it: the Tacoma Narrows entry sits mid-channel, so its
      // elevation IS 0, and the model measures its deck up from the waterline.
      llToLocal(l.lat, l.lon, _p);
      const baseY = getElevation(l.lat, l.lon);

      const obj = buildLandmarkModel(l);
      if (!obj) continue; // peaks and anything too small to see from the air

      obj.position.set(_p.x, baseY, _p.z);
      obj.rotation.y = yawForHeading(l.headingDeg);
      obj.name = `landmark-${l.name}`;
      obj.userData = { ...l, baseElevationM: baseY };
      group.add(obj);
      keepOut.push({ x: _p.x, z: _p.z, radiusM: footprintRadius(l) });
      placed++;
    }

    if (opts.cityMass !== false) {
      const mass = buildDowntownMass({ exclude: keepOut });
      if (mass) group.add(mass);
    }

    console.info(
      `[landmarks] ${placed} modelled, ${list.length - placed} label-only, ` +
        `of ${list.length} loaded`,
    );
  });

  return group;
}

/**
 * Release the GPU resources held by a group from placeLandmarks().
 *
 * Geometries and materials are deduplicated first. landmarkModels.js shares
 * both aggressively — one leg geometry serves all three of the Needle's legs,
 * one concrete material serves a dozen landmarks — so a naive per-mesh dispose
 * would call dispose() on the same resource many times.
 *
 * @param {THREE.Group} group
 */
export function disposeLandmarks(group) {
  if (!group) return;
  const geometries = new Set();
  const materials = new Set();

  group.traverse((o) => {
    if (o.geometry) geometries.add(o.geometry);
    const mtl = o.material;
    if (Array.isArray(mtl)) mtl.forEach((mm) => materials.add(mm));
    else if (mtl) materials.add(mtl);
  });

  for (const g of geometries) g.dispose();
  for (const mm of materials) {
    mm.map?.dispose();
    mm.dispose();
  }
  group.clear();
  group.removeFromParent();
}

/**
 * Nearest landmark to a geodetic point — for a "what am I looking at" readout.
 *
 * Searches ALL loaded landmarks, including the label-only ones with no mesh.
 * That is the point: the Fremont Troll is 5.5 m tall and invisible from the
 * air, but flying over it and being told so is exactly the payoff for having
 * real coordinates.
 *
 * @param {number} lat
 * @param {number} lon
 * @param {number} [maxDistanceM]
 * @returns {{landmark: Landmark, distanceM: number}|null}
 */
export function nearestLandmark(lat, lon, maxDistanceM = Infinity) {
  let best = null;
  for (const l of landmarks) {
    const d = distanceBetween(lat, lon, l.lat, l.lon);
    if (d > maxDistanceM) continue;
    if (!best || d < best.distanceM) best = { landmark: l, distanceM: d };
  }
  return best;
}
