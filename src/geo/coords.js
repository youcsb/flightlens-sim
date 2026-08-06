/**
 * coords.js — the projection. Geodetic (lat/lon) <-> local scene metres.
 *
 * THIS MODULE IS THE SINGLE SOURCE OF TRUTH FOR WHERE THINGS ARE.
 * Terrain, airports, runways, landmarks and the flight model all place
 * themselves by calling llToLocal(). If two subsystems disagree about a
 * position, exactly one of them failed to use this module. Do not hand-roll
 * a degrees-to-metres constant anywhere else in the codebase.
 *
 * Contract: see MODULES.md § coords
 *
 * ---------------------------------------------------------------------------
 * AXES — memorise this, every module depends on it
 * ---------------------------------------------------------------------------
 *   +X = EAST        -X = west
 *   +Y = UP          y = 0 is MEAN SEA LEVEL (the DEM's zero)
 *   -Z = NORTH       +Z = south      <-- note the sign, this trips people up
 *
 * -Z is north because Three.js cameras look down -Z, so an aircraft with the
 * identity quaternion has its nose pointing north. Heading therefore maps to a
 * rotation of -yaw about +Y (see flightModel.js).
 *
 * A true bearing `b` in degrees becomes the unit direction:
 *     x =  sin(b)      z = -cos(b)
 * and inversely  b = atan2(x, -z).  headingToVector()/vectorToHeading() below
 * do this for you; use them rather than re-deriving the signs.
 *
 * ---------------------------------------------------------------------------
 * THE PROJECTION — anchored equirectangular ("local tangent plane")
 * ---------------------------------------------------------------------------
 *     x = (lon - lon0) * metresPerDegreeLon(SCALE_LAT)
 *     z = (lat0 - lat) * metresPerDegreeLat(SCALE_LAT)
 *
 * Both scale factors are evaluated ONCE and held fixed, which makes the mapping
 * a uniform affine transform: exactly invertible, zero grid convergence (grid
 * north == true north everywhere), and cheap enough for a per-vertex loop.
 *
 * THE POSITION ANCHOR AND THE SCALE ANCHOR ARE SEPARATE, deliberately:
 *   - (lat0, lon0) fixes WHERE the scene origin is. Default KBFI, so the spawn
 *     sits at (0, 0) and float precision is best where the player flies.
 *   - SCALE_LAT fixes HOW BIG a degree is. Default the REGION CENTRE latitude.
 *
 * Decoupling them matters for two reasons. It balances distortion north/south
 * instead of biasing it toward whichever end the origin happens to sit at, and
 * — more importantly — it means calling setOrigin() to move the spawn CANNOT
 * silently rescale the entire world. Tying the two together is a live footgun
 * when several people are editing the scene at once.
 *
 * Known distortion, measured not estimated: east-west distances are off by
 * (cos(lat) / cos(SCALE_LAT) - 1), which over our 46.4..48.3 band peaks at
 * about +1.8% on the south edge and -1.8% on the north edge. It is a UNIFORM
 * stretch of the whole map, so nothing is displaced relative to its
 * neighbours — coastlines, airports and landmarks stay mutually consistent,
 * which is the property we actually need. (Anchoring the scale at the origin
 * latitude instead would make it 2.1%, all of it southward, which is how
 * Mount Rainier ends up ~850 m out.)
 *
 * Do not "fix" the residue with a latitude-dependent longitude scale: that
 * shears meridians and introduces up to 0.8 degrees of heading error, which is
 * much worse for a flight sim than a uniform 2% scale.
 *
 * ---------------------------------------------------------------------------
 * SLIPPY TILES
 * ---------------------------------------------------------------------------
 * tileXY() and friends implement standard Web Mercator (EPSG:3857) tile
 * indexing, matching the AWS Terrarium DEM endpoint. Note the DEM uses
 * Mercator while the scene uses equirectangular — that is fine and intentional.
 * elevation.js converts through lat/lon, never directly between the two.
 */

import { DEG_TO_RAD, RAD_TO_DEG } from '../core/units.js';

// ---------------------------------------------------------------------------
// Region + origin
// ---------------------------------------------------------------------------

/**
 * The area we bake data for. Everything outside this is open sea at y = 0.
 * lat 46.4..48.3, lon -123.4..-121.2 — Puget Sound, from Olympia up past
 * Everett, west to the Olympics and east past Mount Rainier.
 */
export const REGION_BBOX = Object.freeze({
  south: 46.4,
  north: 48.3,
  west: -123.4,
  east: -121.2,
});

/**
 * Default scene origin: the KBFI (Boeing Field) airport reference point, as
 * published by OurAirports. Chosen because it is the spawn field, so projection
 * error is exactly zero where the player spends most of their time and grows
 * with distance from Seattle.
 */
export const DEFAULT_ORIGIN = Object.freeze({
  lat: 47.527042,
  lon: -122.29995,
});

/**
 * Latitude at which the metres-per-degree scale factors are evaluated: the
 * centre of REGION_BBOX. Separate from the origin on purpose — see the header.
 * Peak east-west scale error is +-1.8% at the region's north and south edges.
 */
export const SCALE_LAT = (REGION_BBOX.south + REGION_BBOX.north) / 2;

/**
 * Magnetic variation for Puget Sound, degrees EAST (positive).
 * trueHeading = magneticHeading + MAG_VAR_DEG.
 * Used when a data source hands us a magnetic heading mislabelled as true —
 * see MODULES.md § airports for when that happens.
 */
export const MAG_VAR_DEG = 15.6;

let originLat = DEFAULT_ORIGIN.lat;
let originLon = DEFAULT_ORIGIN.lon;
let mPerDegLat = 0;
let mPerDegLon = 0;

// ---------------------------------------------------------------------------
// Ellipsoidal scale factors (WGS84 series expansions, metres per degree)
// ---------------------------------------------------------------------------

/**
 * Metres per degree of LATITUDE at latitude `lat`. ~111.1 km, varies ~1% pole
 * to equator.
 * @param {number} lat degrees
 * @returns {number} metres
 */
export function metresPerDegreeLat(lat) {
  const p = lat * DEG_TO_RAD;
  return (
    111132.92 -
    559.82 * Math.cos(2 * p) +
    1.175 * Math.cos(4 * p) -
    0.0023 * Math.cos(6 * p)
  );
}

/**
 * Metres per degree of LONGITUDE at latitude `lat`. Shrinks as cos(lat).
 * @param {number} lat degrees
 * @returns {number} metres
 */
export function metresPerDegreeLon(lat) {
  const p = lat * DEG_TO_RAD;
  return (
    111412.84 * Math.cos(p) - 93.5 * Math.cos(3 * p) + 0.118 * Math.cos(5 * p)
  );
}

/**
 * Move the scene origin. Local coordinates computed before and after a
 * setOrigin() call are NOT comparable, so call this exactly once during
 * bootstrap, before anything is placed.
 *
 * Moving the origin TRANSLATES the world; it does not rescale it. The scale
 * comes from `scaleLat`, which defaults to the region centre and should
 * normally be left alone — pass it only if you are moving the sim to a
 * different part of the planet.
 *
 * @param {number} lat Origin latitude, degrees.
 * @param {number} lon Origin longitude, degrees.
 * @param {number} [scaleLat] Latitude at which to evaluate metres-per-degree.
 *        Default SCALE_LAT (the centre of REGION_BBOX).
 */
export function setOrigin(lat, lon, scaleLat = SCALE_LAT) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    throw new TypeError(`setOrigin: bad coordinates ${lat}, ${lon}`);
  }
  originLat = lat;
  originLon = lon;
  mPerDegLat = metresPerDegreeLat(scaleLat);
  mPerDegLon = metresPerDegreeLon(scaleLat);
}

/** @returns {{lat: number, lon: number}} A copy of the current scene origin. */
export function getOrigin() {
  return { lat: originLat, lon: originLon };
}

/**
 * Current projection scale factors, metres per degree.
 * @returns {{lat: number, lon: number}}
 */
export function getScale() {
  return { lat: mPerDegLat, lon: mPerDegLon };
}

// ---------------------------------------------------------------------------
// Projection
// ---------------------------------------------------------------------------

/**
 * Geodetic -> local scene metres.
 *
 * @param {number} lat degrees
 * @param {number} lon degrees
 * @param {{x: number, z: number}} [out] Optional target, to avoid allocating in
 *        hot loops. Terrain vertex generation MUST pass this.
 * @returns {{x: number, z: number}} x = metres east of origin,
 *          z = metres SOUTH of origin (so north is -z).
 */
export function llToLocal(lat, lon, out) {
  const target = out || { x: 0, z: 0 };
  target.x = (lon - originLon) * mPerDegLon;
  target.z = (originLat - lat) * mPerDegLat;
  return target;
}

/**
 * Local scene metres -> geodetic. Exact inverse of llToLocal().
 *
 * @param {number} x metres east of origin
 * @param {number} z metres south of origin
 * @param {{lat: number, lon: number}} [out] Optional target.
 * @returns {{lat: number, lon: number}} degrees
 */
export function localToLl(x, z, out) {
  const target = out || { lat: 0, lon: 0 };
  target.lat = originLat - z / mPerDegLat;
  target.lon = originLon + x / mPerDegLon;
  return target;
}

// ---------------------------------------------------------------------------
// Headings and distances
// ---------------------------------------------------------------------------

/**
 * True bearing -> unit direction vector in scene space.
 * @param {number} headingDeg 0 = north, 90 = east.
 * @param {{x: number, z: number}} [out]
 * @returns {{x: number, z: number}} Unit length.
 */
export function headingToVector(headingDeg, out) {
  const target = out || { x: 0, z: 0 };
  const r = headingDeg * DEG_TO_RAD;
  target.x = Math.sin(r);
  target.z = -Math.cos(r);
  return target;
}

/**
 * Scene-space direction -> true bearing.
 * @param {number} x
 * @param {number} z
 * @returns {number} degrees, 0..360
 */
export function vectorToHeading(x, z) {
  const d = Math.atan2(x, -z) * RAD_TO_DEG;
  return d < 0 ? d + 360 : d;
}

/**
 * True bearing from one geodetic point to another, measured in the SCENE
 * projection (not a great-circle initial bearing). Use this — not a haversine
 * formula — so that a runway drawn between two endpoints and a heading computed
 * from those endpoints agree exactly.
 *
 * @returns {number} degrees, 0..360
 */
export function bearingBetween(lat1, lon1, lat2, lon2) {
  const east = (lon2 - lon1) * mPerDegLon;
  const north = (lat2 - lat1) * mPerDegLat;
  const d = Math.atan2(east, north) * RAD_TO_DEG;
  return d < 0 ? d + 360 : d;
}

/**
 * Distance between two geodetic points, in scene metres.
 * @returns {number} metres
 */
export function distanceBetween(lat1, lon1, lat2, lon2) {
  const east = (lon2 - lon1) * mPerDegLon;
  const north = (lat2 - lat1) * mPerDegLat;
  return Math.hypot(east, north);
}

/**
 * Offset a geodetic point by a distance along a true bearing.
 * @param {number} lat degrees
 * @param {number} lon degrees
 * @param {number} headingDeg true bearing
 * @param {number} distanceM metres
 * @returns {{lat: number, lon: number}}
 */
export function offsetLatLon(lat, lon, headingDeg, distanceM) {
  const r = headingDeg * DEG_TO_RAD;
  return {
    lat: lat + (Math.cos(r) * distanceM) / mPerDegLat,
    lon: lon + (Math.sin(r) * distanceM) / mPerDegLon,
  };
}

// ---------------------------------------------------------------------------
// Web Mercator slippy tiles
// ---------------------------------------------------------------------------

/** Web Mercator is undefined at the poles; clamp to the standard cutoff. */
const MERCATOR_MAX_LAT = 85.05112877980659;

/**
 * Fractional tile X. The integer part is the tile index, the fraction is the
 * position across that tile. elevation.js needs the fraction for bilinear
 * sampling; pass it through Math.floor for a plain tile index.
 *
 * @param {number} lon degrees
 * @param {number} z zoom level
 * @returns {number}
 */
export function lonToTileXFloat(lon, z) {
  return ((lon + 180) / 360) * Math.pow(2, z);
}

/**
 * Fractional tile Y (Web Mercator).
 * @param {number} lat degrees
 * @param {number} z zoom level
 * @returns {number}
 */
export function latToTileYFloat(lat, z) {
  const clamped = Math.min(MERCATOR_MAX_LAT, Math.max(-MERCATOR_MAX_LAT, lat));
  const r = clamped * DEG_TO_RAD;
  return (
    ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) *
    Math.pow(2, z)
  );
}

/** Inverse of lonToTileXFloat. @returns {number} degrees */
export function tileXToLon(x, z) {
  return (x / Math.pow(2, z)) * 360 - 180;
}

/** Inverse of latToTileYFloat. @returns {number} degrees */
export function tileYToLat(y, z) {
  const n = Math.PI - (2 * Math.PI * y) / Math.pow(2, z);
  return RAD_TO_DEG * Math.atan(Math.sinh(n));
}

/**
 * Integer slippy-map tile containing a geodetic point.
 *
 * @param {number} lat degrees
 * @param {number} lon degrees
 * @param {number} z zoom level
 * @returns {{x: number, y: number}} Integer tile indices.
 */
export function tileXY(lat, lon, z) {
  return {
    x: Math.floor(lonToTileXFloat(lon, z)),
    y: Math.floor(latToTileYFloat(lat, z)),
  };
}

/**
 * Geodetic bounds of one tile.
 * @param {number} x tile index
 * @param {number} y tile index
 * @param {number} z zoom level
 * @returns {{north: number, south: number, west: number, east: number}} degrees
 */
export function tileBounds(x, y, z) {
  return {
    north: tileYToLat(y, z),
    south: tileYToLat(y + 1, z),
    west: tileXToLon(x, z),
    east: tileXToLon(x + 1, z),
  };
}

/**
 * The inclusive rectangle of tile indices covering a bbox.
 *
 * @param {{south:number,north:number,west:number,east:number}} bbox
 * @param {number} z zoom level
 * @returns {{minX:number,maxX:number,minY:number,maxY:number,count:number}}
 */
export function tileRange(bbox, z) {
  const minX = Math.floor(lonToTileXFloat(bbox.west, z));
  const maxX = Math.floor(lonToTileXFloat(bbox.east, z));
  // Web Mercator Y grows southward, so north gives the LOW index.
  const minY = Math.floor(latToTileYFloat(bbox.north, z));
  const maxY = Math.floor(latToTileYFloat(bbox.south, z));
  return {
    minX,
    maxX,
    minY,
    maxY,
    count: (maxX - minX + 1) * (maxY - minY + 1),
  };
}

/**
 * Ground resolution of one DEM pixel, for choosing a zoom level.
 * @param {number} lat degrees
 * @param {number} z zoom level
 * @param {number} [tileSize] pixels per tile edge, default 256
 * @returns {number} metres per pixel
 */
export function metresPerPixel(lat, z, tileSize = 256) {
  return (
    (156543.03392804097 * Math.cos(lat * DEG_TO_RAD)) /
    (Math.pow(2, z) * (tileSize / 256))
  );
}

/** True if a geodetic point lies inside a bbox. */
export function inBbox(lat, lon, bbox) {
  return (
    lat >= bbox.south &&
    lat <= bbox.north &&
    lon >= bbox.west &&
    lon <= bbox.east
  );
}

// Establish the default projection at import time so that any module which
// forgets to call setOrigin() still gets sane, consistent numbers.
setOrigin(DEFAULT_ORIGIN.lat, DEFAULT_ORIGIN.lon);
