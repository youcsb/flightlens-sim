/**
 * landmarks.js — recognisable things at their true coordinates.
 *
 * STUB IMPLEMENTATION: the loader and placement are real; the meshes are
 * proportioned placeholder solids (a tapered tower for the Space Needle, a
 * cone for a peak, a box for a building). The Landmarks agent replaces
 * buildLandmarkMesh() and nothing else needs to change.
 *
 * Contract: see MODULES.md § landmarks
 *
 *   loadLandmarks() -> Promise<Landmark[]>
 *   placeLandmarks(scene) -> THREE.Group
 *
 * ---------------------------------------------------------------------------
 * WHY THE DATA IS BAKED, AND WHY A BBOX FILTER IS NOT ENOUGH
 * ---------------------------------------------------------------------------
 * Source: Wikidata SPARQL, baked by scripts/bake-landmarks.mjs. Querying by
 * English label is wildly ambiguous. A probe of ten names returned 58 rows, of
 * which 49 were wrong: Mount Adams appears in New Hampshire, Maryland, Ohio,
 * Colorado, New Zealand and Australia; there is a Mount Rainier in Maryland.
 *
 * Filtering to our bbox removes most of them but NOT all, and it also removes
 * things we might want:
 *   - "Mount Baker" inside the bbox at 47.5766,-122.2977 is a Seattle
 *     NEIGHBOURHOOD, not the volcano;
 *   - the actual Mount Baker volcano is at 48.7773,-121.8132, which is north of
 *     our northern edge and so correctly excluded;
 *   - "Mount Rainier" returns two in-bbox items, the mountain (Q194057) and a
 *     second node at 46.8528,-121.7604.
 *
 * => The baker resolves each landmark by WIKIDATA Q-ID from a curated table,
 *    and uses the bbox only as a safety assertion. A landmark that resolves
 *    outside REGION_BBOX is a bug and is dropped with a warning. Never ship a
 *    label-only lookup.
 *
 * ---------------------------------------------------------------------------
 * HEIGHTS
 * ---------------------------------------------------------------------------
 * `heightM` is height ABOVE ITS OWN BASE, not above sea level — 184 m for the
 * Space Needle. Landmarks are placed at getElevation(lat, lon), so the DEM
 * supplies the base and heightM stacks on top.
 *
 * Peaks are the exception and are marked kind:'peak'. Their summit elevation is
 * already in the DEM (Mount Rainier reads ~4390 m there), so drawing a cone of
 * heightM on top would produce an 8 km mountain. Peaks get heightM = 0 and are
 * rendered as a label/marker only. THE MOUNTAIN ITSELF IS TERRAIN — if Rainier
 * does not look right, that is an elevation bug, not a landmark bug.
 */

import * as THREE from 'three';
import { llToLocal, inBbox, REGION_BBOX, distanceBetween } from './coords.js';
import { getElevation } from './elevation.js';
import { fetchJsonOrNull } from '../core/assets.js';

/**
 * @typedef {Object} Landmark
 * @property {string} name        Display name, e.g. "Space Needle".
 * @property {number} lat
 * @property {number} lon
 * @property {number} heightM     Height above its own base, metres. 0 for peaks.
 * @property {LandmarkKind} kind
 * @property {string} [wikidataId] e.g. "Q5317". Provenance; useful for re-baking.
 * @property {number} [widthM]    Footprint hint for the placeholder mesh.
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
 *
 * Every entry is re-checked against REGION_BBOX here as well as in the baker.
 * That is deliberate belt-and-braces: a namesake decoy slipping through is the
 * single most likely way this feature goes wrong, and it fails silently — you
 * just get an Eiffel Tower in the wrong state and no error.
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
    return landmarks;
  })();
  return loadPromise;
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

const TOWER_COLOUR = 0xd8d2c4;
const ACCENT_COLOUR = 0xc8532e;
const BUILDING_COLOUR = 0x8d949e;

/**
 * Placeholder geometry for one landmark, with its base at local y = 0.
 * REPLACE THIS — it is the whole point of the Landmarks agent's job. The
 * contract to preserve is only: origin at the base, +Y up, real-world metres.
 *
 * @param {Landmark} l
 * @returns {THREE.Object3D|null} null for kinds that are label-only.
 */
function buildLandmarkMesh(l) {
  const h = l.heightM;

  if (l.kind === 'peak' || h <= 0) {
    // Peaks are terrain. Nothing to draw — the DEM already did it.
    return null;
  }

  if (l.kind === 'tower') {
    // Space Needle proportions: a slim tripod shaft carrying a saucer at ~0.85h.
    const obj = new THREE.Group();
    const shaft = new THREE.Mesh(
      new THREE.CylinderGeometry(h * 0.028, h * 0.09, h * 0.86, 12),
      new THREE.MeshLambertMaterial({ color: TOWER_COLOUR }),
    );
    shaft.position.y = h * 0.43;
    obj.add(shaft);

    const saucer = new THREE.Mesh(
      new THREE.CylinderGeometry(h * 0.115, h * 0.155, h * 0.055, 24),
      new THREE.MeshLambertMaterial({ color: ACCENT_COLOUR }),
    );
    saucer.position.y = h * 0.86;
    obj.add(saucer);

    const spire = new THREE.Mesh(
      new THREE.CylinderGeometry(h * 0.004, h * 0.016, h * 0.11, 8),
      new THREE.MeshLambertMaterial({ color: TOWER_COLOUR }),
    );
    spire.position.y = h * 0.945;
    obj.add(spire);
    return obj;
  }

  // Generic block for buildings, stadiums, everything else.
  const w = l.widthM ?? Math.max(20, h * 0.28);
  const mesh = new THREE.Mesh(
    new THREE.BoxGeometry(w, h, w),
    new THREE.MeshLambertMaterial({ color: BUILDING_COLOUR }),
  );
  mesh.position.y = h / 2;
  return mesh;
}

const _p = { x: 0, z: 0 };

/**
 * Build and attach the landmark group.
 *
 * ASYNC-SAFE BY DESIGN: this returns an EMPTY group immediately and fills it in
 * once loadLandmarks() resolves, kicking off that load itself if nobody has.
 * Callers therefore never need to await it or re-attach anything — hold the
 * group, it populates itself. The trade-off is that group.children is empty on
 * the frame you call this, so do not measure it synchronously.
 *
 * @param {THREE.Scene|THREE.Object3D} scene Parent to attach to. May be null.
 * @returns {THREE.Group} Named 'landmarks'.
 */
export function placeLandmarks(scene) {
  const group = new THREE.Group();
  group.name = 'landmarks';
  if (scene) scene.add(group);

  loadLandmarks().then((list) => {
    for (const l of list) {
      const obj = buildLandmarkMesh(l);
      if (!obj) continue;
      llToLocal(l.lat, l.lon, _p);
      // The DEM supplies the base elevation, so a landmark sits on the real
      // ground rather than floating at an assumed sea level.
      obj.position.set(_p.x, getElevation(l.lat, l.lon), _p.z);
      obj.name = `landmark-${l.name}`;
      obj.userData = { ...l };
      obj.castShadow = true;
      group.add(obj);
    }
  });

  return group;
}

/**
 * Release the GPU resources held by a group from placeLandmarks().
 * @param {THREE.Group} group
 */
export function disposeLandmarks(group) {
  if (!group) return;
  group.traverse((o) => {
    if (o.isMesh) {
      o.geometry?.dispose();
      if (Array.isArray(o.material)) o.material.forEach((m) => m.dispose());
      else o.material?.dispose();
    }
  });
  group.removeFromParent();
}

/**
 * Nearest landmark to a geodetic point — for a "what am I looking at" readout.
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
