/**
 * airports.js — real airports and real runway geometry.
 *
 * STUB IMPLEMENTATION: the loader, the lookups and the spawn helper are real.
 * buildRunwayMeshes() draws flat quads with threshold markings — good enough to
 * land on, deliberately plain so the Airports agent can replace the visuals
 * without touching the geometry maths.
 *
 * Contract: see MODULES.md § airports
 *
 *   loadAirports() -> Promise<Airport[]>
 *   buildRunwayMeshes(scene, airports) -> THREE.Group
 *
 * ---------------------------------------------------------------------------
 * DATA PROVENANCE AND ITS SHARP EDGES
 * ---------------------------------------------------------------------------
 * Source: OurAirports (public domain), baked to public/data/airports.json by
 * scripts/bake-airports.mjs. Read that script's header before you trust a
 * field. The two traps, both verified against the live CSV:
 *
 * 1. `le_heading_degT` is frequently NOT true heading. KBFI 14R/32L is
 *    published as 140, but its own published endpoints give 150.13 degrees,
 *    and the runway really is 150 true (140 magnetic + 15.6 east variation).
 *    The field is often just the runway number times ten, i.e. magnetic.
 *    => The baker computes heading FROM THE ENDPOINTS whenever both exist and
 *       the implied length agrees with length_ft. That check passed for KBFI
 *       at 10013 ft computed vs 10007 ft published.
 *
 * 2. Endpoint coordinates are sometimes rounded until the runway is axis
 *    aligned. All three KSEA runways are published with le_lon === he_lon,
 *    which yields exactly 180.0 degrees; the real bearing is a few degrees off
 *    that. The length check does not catch this. Such airports need a surveyed
 *    override — see OVERRIDES in scripts/bake-airports.mjs.
 *
 * Of 246 runways in our bbox, only ~46 carry real endpoint coordinates; the
 * rest are heliports and small strips whose geometry the baker synthesises from
 * the airport reference point, length_ft and the runway number. `geometry`
 * on each runway records which of those happened, so nothing pretends to be
 * surveyed when it was inferred.
 */

import * as THREE from 'three';
import {
  llToLocal,
  bearingBetween,
  distanceBetween,
  headingToVector,
} from './coords.js';
import { getElevation } from './elevation.js';
import { fetchJsonOrNull } from '../core/assets.js';
import { FT_TO_M } from '../core/units.js';

/**
 * @typedef {Object} Runway
 * @property {string} leIdent        Low-numbered end, e.g. "14R".
 * @property {string} heIdent        High-numbered end, e.g. "32L".
 * @property {number} leLat
 * @property {number} leLon
 * @property {number} heLat
 * @property {number} heLon
 * @property {number} headingDeg     TRUE bearing from the le end to the he end, 0..360.
 * @property {number} lengthFt
 * @property {number} widthFt
 * @property {string} surface        Raw OurAirports code: ASP, PEM, CON, GRS, TURF...
 * @property {boolean} lighted
 * @property {boolean} closed
 * @property {'surveyed'|'synthesised'|'override'} geometry How the endpoints were obtained.
 */

/**
 * @typedef {Object} Airport
 * @property {string} ident          ICAO-ish identifier, e.g. "KBFI".
 * @property {string} name
 * @property {number} lat            Airport reference point.
 * @property {number} lon
 * @property {number} elevationFt    Field elevation, MSL.
 * @property {string} type           large_airport | medium_airport | small_airport | seaplane_base | heliport
 * @property {string} municipality
 * @property {Runway[]} runways
 */

/**
 * Where the sim starts. KBFI runway 32L, at the south-east threshold, pointed
 * north-west up the 10,000 ft runway.
 *
 * This is not an arbitrary choice. From that threshold on heading ~330:
 *   - the Space Needle is 12.3 km away on bearing 339.2, i.e. essentially
 *     straight down the extended centreline — it is in the windscreen on
 *     climb-out, about 9 degrees right of the nose;
 *   - Mount Rainier is 84.1 km away on bearing 151.5, which is the reciprocal
 *     runway heading — one 180 turn and the mountain fills the view.
 * Both of the landmarks the user asked for, from one spawn, without a map.
 *
 * The fallback carries the two published runway ENDPOINTS rather than a
 * hardcoded heading, and derives the heading through the live projection. A
 * literal would silently disagree with the runway mesh — which is drawn from
 * bearingBetween() — any time the projection is retuned, and the aircraft would
 * spawn a degree off the centreline for no visible reason.
 */
export const SPAWN = Object.freeze({
  ident: 'KBFI',
  /** The runway END to sit on; the aircraft faces along the runway from here. */
  runwayEnd: '32L',
  /** Used if the baked data is missing, so the sim still starts. */
  fallback: Object.freeze({
    /** The 32L threshold — where the aircraft sits. */
    lat: 47.516745,
    lon: -122.291252,
    /** The 14R threshold — the far end, which the nose points at. */
    farLat: 47.540549,
    farLon: -122.311372,
    elevationFt: 21,
  }),
});

/** Types we draw runway ribbons for. Heliports and closed fields are skipped. */
const RUNWAY_TYPES = new Set([
  'large_airport',
  'medium_airport',
  'small_airport',
]);

/** @type {Airport[]} */
let airports = [];
/** @type {Map<string, Airport>} */
const byIdent = new Map();
/** @type {Promise<Airport[]>|null} */
let loadPromise = null;

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

/**
 * Load the baked regional airport set. Idempotent — concurrent callers share
 * one fetch, and later calls resolve immediately from cache.
 *
 * Returns [] rather than throwing when public/data/airports.json is absent, so
 * the sim boots before `npm run bake` has ever been run.
 *
 * @returns {Promise<Airport[]>}
 */
export async function loadAirports() {
  if (loadPromise) return loadPromise;
  loadPromise = (async () => {
    const data = await fetchJsonOrNull('data/airports.json', null);
    airports = Array.isArray(data?.airports) ? data.airports : [];
    byIdent.clear();
    for (const a of airports) byIdent.set(a.ident, a);
    if (airports.length === 0) {
      console.warn(
        '[airports] no airport data. Run `npm run bake:airports`. ' +
          'Spawning at the hardcoded KBFI fallback.',
      );
    }
    return airports;
  })();
  return loadPromise;
}

/** The airports loaded so far. Empty until loadAirports() resolves. */
export function getAirports() {
  return airports;
}

/**
 * @param {string} ident e.g. "KSEA"
 * @returns {Airport|null}
 */
export function getAirport(ident) {
  return byIdent.get(String(ident).toUpperCase()) ?? null;
}

/**
 * Find one runway end by its identifier.
 * @param {string} ident Airport identifier.
 * @param {string} end Runway end, e.g. "32L".
 * @returns {{airport: Airport, runway: Runway, atLowEnd: boolean}|null}
 */
export function findRunwayEnd(ident, end) {
  const airport = getAirport(ident);
  if (!airport) return null;
  const wanted = String(end).toUpperCase();
  for (const rw of airport.runways || []) {
    if (rw.leIdent?.toUpperCase() === wanted) {
      return { airport, runway: rw, atLowEnd: true };
    }
    if (rw.heIdent?.toUpperCase() === wanted) {
      return { airport, runway: rw, atLowEnd: false };
    }
  }
  return null;
}

/**
 * Where to put the aircraft, in geodetic terms. Standing on the threshold of a
 * runway end, facing down the runway.
 *
 * @param {string} [ident] Default SPAWN.ident.
 * @param {string} [end] Default SPAWN.runwayEnd.
 * @returns {{lat:number, lon:number, headingDeg:number, elevationM:number, label:string}}
 */
export function getSpawn(ident = SPAWN.ident, end = SPAWN.runwayEnd) {
  const hit = findRunwayEnd(ident, end);
  if (!hit) {
    const f = SPAWN.fallback;
    return {
      lat: f.lat,
      lon: f.lon,
      headingDeg: bearingBetween(f.lat, f.lon, f.farLat, f.farLon),
      elevationM: getElevation(f.lat, f.lon),
      label: `${SPAWN.ident} ${SPAWN.runwayEnd} (fallback)`,
    };
  }
  const { airport, runway, atLowEnd } = hit;
  // Standing at the low end you face the published heading; at the high end you
  // face its reciprocal.
  const lat = atLowEnd ? runway.leLat : runway.heLat;
  const lon = atLowEnd ? runway.leLon : runway.heLon;
  const headingDeg = atLowEnd
    ? runway.headingDeg
    : (runway.headingDeg + 180) % 360;
  return {
    lat,
    lon,
    headingDeg,
    elevationM: getElevation(lat, lon),
    label: `${airport.ident} ${atLowEnd ? runway.leIdent : runway.heIdent}`,
  };
}

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

/** Runway surface colours by OurAirports code. */
const SURFACE_COLOURS = {
  ASP: 0x2e3238, // asphalt
  PEM: 0x2e3238, // porous friction course over asphalt
  CON: 0x53565c, // concrete
  ASPH: 0x2e3238,
  GRS: 0x4d6238, // grass
  TURF: 0x4d6238,
  GRE: 0x4d6238,
  DIRT: 0x5c4a34,
  GVL: 0x6b6459, // gravel
  WATER: 0x1d3f5c,
};
const DEFAULT_SURFACE = 0x3a3e45;

/**
 * How far above the terrain to float the runway ribbon, in metres. The DEM is
 * ~52 m/pixel, so a real runway's own surface is smoothed away; lifting the
 * ribbon slightly stops it z-fighting with, or disappearing into, the ground.
 * The flight model still lands on terrain height, so keep this small.
 */
const RUNWAY_LIFT_M = 0.35;

const _a = { x: 0, z: 0 };
const _b = { x: 0, z: 0 };

/**
 * Build the runway ribbons for a set of airports and add them to `scene`.
 *
 * Every runway is placed from its own endpoint coordinates through
 * coords.llToLocal(), and sits at the elevation the DEM reports for those
 * points. It is therefore in the geographically correct place by construction —
 * there is no offset table to keep in sync.
 *
 * Safe to call with [] (returns an empty group), so main.js can call it before
 * loadAirports() resolves and repopulate later.
 *
 * @param {THREE.Scene|THREE.Object3D} scene Parent to attach to. May be null.
 * @param {Airport[]} list
 * @returns {THREE.Group} Named 'airports'. Dispose via disposeRunwayMeshes().
 */
export function buildRunwayMeshes(scene, list = airports) {
  const group = new THREE.Group();
  group.name = 'airports';

  /** @type {Map<number, THREE.MeshLambertMaterial>} */
  const materials = new Map();
  const materialFor = (surface) => {
    const colour = SURFACE_COLOURS[surface] ?? DEFAULT_SURFACE;
    let m = materials.get(colour);
    if (!m) {
      m = new THREE.MeshLambertMaterial({ color: colour });
      materials.set(colour, m);
    }
    return m;
  };

  for (const airport of list || []) {
    if (!RUNWAY_TYPES.has(airport.type)) continue;
    for (const rw of airport.runways || []) {
      if (rw.closed) continue;
      if (!Number.isFinite(rw.leLat) || !Number.isFinite(rw.heLat)) continue;

      llToLocal(rw.leLat, rw.leLon, _a);
      llToLocal(rw.heLat, rw.heLon, _b);

      const lengthM = Math.hypot(_b.x - _a.x, _b.z - _a.z);
      if (lengthM < 50) continue;
      const widthM = (rw.widthFt > 0 ? rw.widthFt : 75) * FT_TO_M;

      // A plane in XZ, centred on the runway midpoint, rotated to the heading.
      const geo = new THREE.PlaneGeometry(widthM, lengthM);
      geo.rotateX(-Math.PI / 2);

      const mesh = new THREE.Mesh(geo, materialFor(rw.surface));
      mesh.name = `runway-${airport.ident}-${rw.leIdent}/${rw.heIdent}`;
      mesh.receiveShadow = true;

      const midLat = (rw.leLat + rw.heLat) / 2;
      const midLon = (rw.leLon + rw.heLon) / 2;
      mesh.position.set(
        (_a.x + _b.x) / 2,
        getElevation(midLat, midLon) + RUNWAY_LIFT_M,
        (_a.z + _b.z) / 2,
      );

      // After rotateX(-PI/2) the geometry's length axis (originally +Y) points
      // along -Z, which is NORTH — so an unrotated ribbon is already heading 0.
      // A yaw of -heading then swings it to the true bearing: rotating (0,-1)
      // about +Y by -h gives (sin h, -cos h), which is exactly
      // coords.headingToVector(h).
      mesh.rotation.y = -rw.headingDeg * (Math.PI / 180);

      mesh.userData = {
        airport: airport.ident,
        runway: `${rw.leIdent}/${rw.heIdent}`,
        headingDeg: rw.headingDeg,
        lengthM,
        widthM,
        geometry: rw.geometry,
      };
      group.add(mesh);
    }
  }

  if (scene) scene.add(group);
  return group;
}

/**
 * Release the GPU resources held by a group from buildRunwayMeshes().
 * @param {THREE.Group} group
 */
export function disposeRunwayMeshes(group) {
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
 * The nearest airport to a geodetic point — for a "nearest field" HUD readout.
 *
 * @param {number} lat
 * @param {number} lon
 * @param {{types?: Set<string>, maxDistanceM?: number}} [opts]
 * @returns {{airport: Airport, distanceM: number, bearingDeg: number}|null}
 */
export function nearestAirport(lat, lon, opts = {}) {
  const types = opts.types ?? RUNWAY_TYPES;
  const maxDistanceM = opts.maxDistanceM ?? Infinity;
  let best = null;
  for (const a of airports) {
    if (types && !types.has(a.type)) continue;
    const d = distanceBetween(lat, lon, a.lat, a.lon);
    if (d > maxDistanceM) continue;
    if (!best || d < best.distanceM) {
      best = {
        airport: a,
        distanceM: d,
        bearingDeg: bearingBetween(lat, lon, a.lat, a.lon),
      };
    }
  }
  return best;
}

/**
 * Unit direction of a runway in scene space — for aligning approach lighting,
 * taxiway stubs or an ILS localiser.
 * @param {Runway} runway
 * @param {{x:number, z:number}} [out] Optional target, to avoid allocating.
 * @returns {{x: number, z: number}}
 */
export function runwayDirection(runway, out) {
  return headingToVector(runway.headingDeg, out || { x: 0, z: 0 });
}

/**
 * Recompute a runway's true heading from its endpoints. Exposed so the bake
 * script and the runtime cannot disagree about the maths.
 * @param {Runway} runway
 * @returns {number} degrees, 0..360
 */
export function headingFromEndpoints(runway) {
  return bearingBetween(runway.leLat, runway.leLon, runway.heLat, runway.heLon);
}
