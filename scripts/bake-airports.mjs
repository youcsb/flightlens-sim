/**
 * bake-airports.mjs — regional airport + runway subset, with surveyed geometry.
 *
 *   node scripts/bake-airports.mjs            # OurAirports + FAA refinement
 *   node scripts/bake-airports.mjs --no-faa   # OurAirports only, fully offline-ish
 *   node scripts/bake-airports.mjs --report   # print every runway it produced
 *
 * ---------------------------------------------------------------------------
 * SOURCES
 * ---------------------------------------------------------------------------
 * PRIMARY — OurAirports (public domain)
 *   https://davidmegginson.github.io/ourairports-data/airports.csv  (~12.7 MB)
 *   https://davidmegginson.github.io/ourairports-data/runways.csv   (~4.0 MB)
 * Gives the airport list, names, types, elevations and (for a minority of rows)
 * runway endpoints. Measured for our bbox: 266 airports of every type, of which
 * 117 are of a type we keep, carrying 129 runway rows — and only 43 of those
 * rows have endpoint coordinates at all.
 *
 * REFINEMENT — FAA ADIP "Runways" feature service (authoritative, US only)
 *   https://services6.arcgis.com/ssFJjBXIUyZDrSYZ/arcgis/rest/services/
 *       Runways/FeatureServer/0/query
 * The FAA publishes each paved runway as a four-corner POLYGON of the actual
 * pavement, plus LENGTH / WIDTH / COMP_CODE / LIGHTACTV. 197 polygons intersect
 * our bbox. Reducing each rectangle to its centreline (see centrelineOf()) gives
 * true surveyed thresholds for runways OurAirports has no geometry for at all.
 *
 * The service is shared-quota and answers HTTP 200 with `{"error":{"code":429}}`
 * when the tenant is busy — it took two attempts on the run that produced the
 * committed JSON. fetchFaaRunways() retries with backoff and, if it still fails,
 * returns [] so the bake completes on OurAirports alone. Nothing here is allowed
 * to make the bake unreproducible.
 *
 * ---------------------------------------------------------------------------
 * TRAP 1 — `le_heading_degT` IS OFTEN MAGNETIC, NOT TRUE
 * ---------------------------------------------------------------------------
 * KBFI 14R/32L is published with le_heading_degT = 140. Its own published
 * endpoints give 150.13, and ~150 is correct: Boeing Field really is 150 true.
 * 140 is the MAGNETIC heading, i.e. the runway number times ten. Confirmed
 * region-wide: KRNT publishes 174 against 174.12 computed (fine), KAWO publishes
 * 179 against 177.34, KTIW publishes 187 against 185.70.
 *
 * => headingDeg is ALWAYS computed from the endpoints. The column is used only
 *    when a runway has no endpoints from any source, and MAG_VAR_DEG is added
 *    when that happens.
 *
 * ---------------------------------------------------------------------------
 * TRAP 2 — SOME ENDPOINTS ARE ROUNDED UNTIL THE RUNWAY IS AXIS-ALIGNED
 * ---------------------------------------------------------------------------
 * All three KSEA runways are published by OurAirports with
 * le_longitude_deg === he_longitude_deg to the digit, so the computed bearing is
 * exactly 180.000. The length check does not catch it — the lengths match to
 * 0.1%. detectAxisRounding() flags every such row; eight rows in our bbox.
 *
 * THE SCAFFOLD'S GUESS AT THE TRUE VALUE WAS WRONG, AND SO IS ACCEPTANCE
 * CHECK 7 IN MODULES.md. The guess was 16 * 10 + 15.6 = 175.6 true. The real
 * answer is 180.34, from two independent surveys:
 *
 *   FAA ADIP polygon 16L/34R, corners
 *     (-122.308068,47.463802) (-122.307462,47.463800)
 *     (-122.307750,47.431177) (-122.308356,47.431179)
 *   centreline  47.463801,-122.307765 -> 47.431178,-122.308053   = 180.34
 *   X-Plane Scenery Gateway pack 93695 (approved 2023-01-16)
 *              47.463828,-122.307752 -> 47.431175,-122.308041    = 180.34
 *   The two agree to 3.0 m at the north threshold and 1.4 m at the south.
 *
 * That is consistent with the runway NUMBER: 180.34 true minus 15.6 of easterly
 * variation is 164.7 magnetic, which rounds to 16 — not to 18. A runway numbered
 * 16 is anywhere from 155 to 165 magnetic, i.e. 170.6 to 180.6 true, and KSEA
 * sits at the very top of that band. So OurAirports' rounded 180.000 was nearly
 * right by accident and the "few degrees off due south" story was never true.
 * Over 11,901 ft the 0.34 we are correcting is 21 m of lateral error at the far
 * threshold: worth fixing, but nothing like the 5 degrees the scaffold expected.
 *
 * ---------------------------------------------------------------------------
 * TRAP 3 — MOST OURAIRPORTS ROWS HAVE NO GEOMETRY AT ALL
 * ---------------------------------------------------------------------------
 * 86 of the 129 regional rows we keep have no endpoint coordinates. The FAA pass
 * recovers most of the paved ones. Whatever is left is synthesised from the
 * airport reference point, length_ft and the runway NUMBER
 * ("16" -> 160 magnetic -> 175.6 true) and marked geometry:'synthesised' so that
 * nothing downstream mistakes an inference for a survey.
 *
 * ---------------------------------------------------------------------------
 * OUTPUT CONTRACT — src/geo/airports.js depends on exactly this
 * ---------------------------------------------------------------------------
 * public/data/airports.json
 *   {
 *     "generated": "...", "source": "ourairports+faa-adip", "bbox": {...},
 *     "counts": { ... },
 *     "airports": [
 *       {
 *         "ident": "KBFI",
 *         "name": "King County International Airport - Boeing Field",
 *         "lat": 47.527042, "lon": -122.29995, "elevationFt": 21,
 *         "type": "medium_airport", "municipality": "Seattle",
 *         "runways": [
 *           { "leIdent": "14R", "heIdent": "32L",
 *             "leLat": 47.540549, "leLon": -122.311372,
 *             "heLat": 47.516745, "heLon": -122.291252,
 *             "headingDeg": 150.13, "lengthFt": 10007, "widthFt": 200,
 *             "surface": "ASP", "lighted": true, "closed": false,
 *             "geometry": "surveyed",
 *             "leElevationFt": 18, "heElevationFt": 15,
 *             "leDisplacedFt": 0, "heDisplacedFt": 0 }
 *         ]
 *       }
 *     ]
 *   }
 *
 * The last four fields are ADDITIONS to the type in MODULES.md 2.5. They are
 * optional — every consumer must tolerate their absence. `le/heElevationFt` are
 * the surveyed threshold elevations and exist for diagnostics and for a future
 * glideslope; airports.js deliberately does NOT place runways at them, because
 * the ground-height invariant (MODULES.md 1.4) says the one true surface is the
 * DEM. `le/heDisplacedFt` drive the displaced-threshold markings.
 *
 * Coordinates round to 6 decimals (~0.1 m), headings to 2.
 *
 * INVARIANT, asserted at the end of the bake: KBFI 14R/32L must come out at
 * 47.540549/-122.311372 and 47.516745/-122.291252, because src/geo/airports.js
 * SPAWN carries the same two points as its no-data fallback. Note this means
 * KBFI is deliberately NOT refined by the FAA pass — see PROTECTED_GEOMETRY.
 *
 * `headingDeg` is derived, never hardcoded, in both places: it is whatever
 * bearingBetween() yields for those endpoints in the current projection (150.13
 * as of this writing). Do not pin it to a literal anywhere — the runway MESH is
 * drawn from bearingBetween(), so a literal that drifts from it puts the
 * spawning aircraft off the centreline with no visible cause.
 */

import { pathToFileURL } from 'node:url';
import {
  REGION_BBOX,
  parseArgs,
  parseCSV,
  rowsToObjects,
  writeJson,
  get,
  num,
  bool,
  inBbox,
  bearingBetween,
  distanceBetween,
  metresPerDegreeLat,
  metresPerDegreeLon,
  SCALE_LAT,
} from './lib/util.mjs';

const AIRPORTS_CSV =
  'https://davidmegginson.github.io/ourairports-data/airports.csv';
const RUNWAYS_CSV =
  'https://davidmegginson.github.io/ourairports-data/runways.csv';

const FAA_RUNWAYS =
  'https://services6.arcgis.com/ssFJjBXIUyZDrSYZ/arcgis/rest/services' +
  '/Runways/FeatureServer/0/query';

/** Easterly magnetic variation for Puget Sound. true = magnetic + this. */
const MAG_VAR_DEG = 15.6;

/** Airport types worth keeping. Heliports are noise for a fixed-wing sim. */
const KEEP_TYPES = new Set([
  'large_airport',
  'medium_airport',
  'small_airport',
  'seaplane_base',
]);

/**
 * Endpoint-vs-length agreement tolerance. Outside this the published endpoints
 * are not trustworthy and we fall back to the FAA pass or to synthesis.
 */
const LENGTH_TOLERANCE = 0.1;

/** The FAA pass is only allowed to move a threshold this far, in metres. */
const FAA_MAX_SHIFT_M = 300;

/** ...and its centre must be this close to the airport reference point. */
const FAA_MAX_ARP_M = 6000;

/** ...and its length must agree with OurAirports to this fraction. */
const FAA_LENGTH_TOLERANCE = 0.05;

/**
 * ...and its heading must be consistent with the runway NUMBER.
 *
 * A runway numbered 07 is by definition 065-074 magnetic, which with 15.6 of
 * easterly variation is 80.6-90.6 true — a +-5 window around 85.6, plus a few
 * degrees of slack because numbers are repainted rarely and the variation drifts
 * under them. 12 degrees is comfortably outside real slack and comfortably
 * inside a mis-match. It catches exactly one runway in our region: WT77 Rocky
 * Bay, whose FAA polygon runs 70.0 true (054 magnetic, i.e. runway 05) while the
 * strip is numbered 07/25 — a 15.6 degree error, which is suspiciously exactly
 * the magnetic variation, so somebody digitised that outline from the magnetic
 * bearing. OurAirports has no endpoints for it either, so it falls through to
 * synthesis and is labelled as such.
 */
const FAA_DESIGNATOR_TOLERANCE_DEG = 12;

const M_LAT = metresPerDegreeLat(SCALE_LAT);
const M_LON = metresPerDegreeLon(SCALE_LAT);

/**
 * Runways whose published OurAirports endpoints are load-bearing elsewhere in
 * the codebase and must survive the bake byte-identical.
 *
 * KBFI 14R/32L is the spawn. src/geo/airports.js SPAWN.fallback repeats these
 * two points so the sim still starts with no baked data, and the acceptance
 * checks in scripts/check-contract.mjs assert against them. The FAA polygon for
 * this runway reduces to 47.540549/-122.311370 -> 47.516742/-122.291242, i.e.
 * 0.15 m and 0.85 m from the OurAirports values — so nothing is being sacrificed
 * to keep them, and pinning them keeps three files from silently disagreeing.
 */
const PROTECTED_GEOMETRY = new Set(['KBFI 14R/32L']);

/**
 * Surveyed corrections, applied before anything else and marked
 * geometry:'override'. Keyed by `${ident} ${leIdent}/${heIdent}`.
 *
 * These exist so that the airports that matter are right even when the FAA
 * service is unreachable and `--no-faa` runs. Every entry must cite where its
 * numbers came from and what they were cross-checked against. A confidently
 * wrong number here is worse than an honest approximation, because the
 * 'override' label claims the geometry was surveyed.
 *
 * @type {Record<string, {leLat:number, leLon:number, heLat:number, heLon:number, source:string}>}
 */
const OVERRIDES = {
  // KSEA. OurAirports publishes le_lon === he_lon for all three runways, giving
  // exactly 180.000 (TRAP 2). Values below are the centrelines of the FAA ADIP
  // runway pavement polygons, retrieved 2026-08-06 from
  //   services6.arcgis.com/.../Runways/FeatureServer/0
  // and independently confirmed by X-Plane Scenery Gateway pack 93695: the two
  // surveys agree to 3.0 m or better at every one of these six thresholds, and
  // the implied lengths (11897 / 9424 / 8497 ft) match the FAA's published
  // 11901 / 9426 / 8500 ft to 0.04%.
  'KSEA 16L/34R': {
    leLat: 47.463801,
    leLon: -122.307765,
    heLat: 47.431178,
    heLon: -122.308053,
    source: 'FAA ADIP runway polygon centreline (2026-08-06); X-Plane GW 93695',
  },
  'KSEA 16C/34C': {
    leLat: 47.463815,
    leLon: -122.310999,
    heLat: 47.437977,
    heLon: -122.311225,
    source: 'FAA ADIP runway polygon centreline (2026-08-06); X-Plane GW 93695',
  },
  'KSEA 16R/34L': {
    leLat: 47.463842,
    leLon: -122.317872,
    heLat: 47.440539,
    heLon: -122.318073,
    source: 'FAA ADIP runway polygon centreline (2026-08-06); X-Plane GW 93695',
  },
};

// ---------------------------------------------------------------------------
// Geometry helpers
// ---------------------------------------------------------------------------

/** Local metres east/north of a reference point. Matches the scene projection. */
function toLocal(lat, lon, refLat, refLon) {
  return { e: (lon - refLon) * M_LON, n: (lat - refLat) * M_LAT };
}

function fromLocal(e, n, refLat, refLon) {
  return { lat: refLat + n / M_LAT, lon: refLon + e / M_LON };
}

/**
 * Reduce a runway pavement polygon to its centreline.
 *
 * The FAA ships each runway as a closed four-corner rectangle. Rather than
 * assume exactly four vertices and guess which edges are the ends, this does a
 * 2x2 principal-component fit in local metres: the dominant eigenvector is the
 * runway axis, and the extreme projections onto it are the two ends. For a true
 * rectangle that reproduces the short-edge midpoints exactly, and it degrades
 * gracefully if a polygon ever arrives with chamfered corners or a stopway
 * bulge.
 *
 * @param {number[][]} ring [[lon, lat], ...], first point repeated at the end.
 * @returns {{aLat:number, aLon:number, bLat:number, bLon:number, lengthM:number,
 *            widthM:number}|null}
 */
export function centrelineOf(ring) {
  if (!Array.isArray(ring) || ring.length < 4) return null;
  // Drop the repeated closing vertex.
  const pts = ring.slice(0, ring.length > 1 &&
    ring[0][0] === ring[ring.length - 1][0] &&
    ring[0][1] === ring[ring.length - 1][1] ? -1 : undefined);
  if (pts.length < 3) return null;

  let refLat = 0;
  let refLon = 0;
  for (const p of pts) {
    refLon += p[0];
    refLat += p[1];
  }
  refLat /= pts.length;
  refLon /= pts.length;

  const local = pts.map((p) => toLocal(p[1], p[0], refLat, refLon));

  // Covariance of the vertex cloud. For a rectangle the eigenvectors are the
  // pavement axes regardless of vertex ordering.
  let sxx = 0;
  let sxy = 0;
  let syy = 0;
  for (const q of local) {
    sxx += q.e * q.e;
    sxy += q.e * q.n;
    syy += q.n * q.n;
  }
  const tr = sxx + syy;
  const det = sxx * syy - sxy * sxy;
  const disc = Math.sqrt(Math.max(0, (tr * tr) / 4 - det));
  const lam = tr / 2 + disc; // larger eigenvalue -> long axis
  let ax;
  let az;
  if (Math.abs(sxy) > 1e-9) {
    ax = lam - syy;
    az = sxy;
  } else {
    ax = sxx >= syy ? 1 : 0;
    az = sxx >= syy ? 0 : 1;
  }
  const mag = Math.hypot(ax, az) || 1;
  ax /= mag;
  az /= mag;

  let minT = Infinity;
  let maxT = -Infinity;
  let minW = Infinity;
  let maxW = -Infinity;
  for (const q of local) {
    const t = q.e * ax + q.n * az;
    const w = -q.e * az + q.n * ax;
    if (t < minT) minT = t;
    if (t > maxT) maxT = t;
    if (w < minW) minW = w;
    if (w > maxW) maxW = w;
  }
  const a = fromLocal(minT * ax, minT * az, refLat, refLon);
  const b = fromLocal(maxT * ax, maxT * az, refLat, refLon);
  return {
    aLat: a.lat,
    aLon: a.lon,
    bLat: b.lat,
    bLon: b.lon,
    lengthM: maxT - minT,
    widthM: maxW - minW,
  };
}

/**
 * True heading a runway NUMBER implies. "16L" -> 160 magnetic -> 175.6 true.
 * Returns NaN for identifiers that are not a runway number ("H1", "ALL", "N",
 * "E/W", and KTCM's mis-keyed "160/340" row).
 *
 * The whole identifier must be one or two digits plus at most one letter. A
 * prefix match is not enough: "160" would otherwise read as runway 16 and put a
 * synthesised 3,000 ft strip across McChord AFB at the wrong angle.
 */
function headingFromIdent(ident) {
  const m = /^(\d{1,2})[A-Z]?$/i.exec(String(ident || '').trim());
  if (!m) return NaN;
  const n = Number(m[1]);
  if (!(n >= 1 && n <= 36)) return NaN;
  return (n * 10 + MAG_VAR_DEG + 360) % 360;
}

/** Smallest absolute difference between two bearings, degrees 0..180. */
function angleDelta(a, b) {
  let d = Math.abs(((a - b) % 360) + 360) % 360;
  if (d > 180) d = 360 - d;
  return d;
}

/**
 * True when a pair of endpoints has been rounded until the runway is exactly
 * axis-aligned — the TRAP 2 signature. An exact digit-for-digit match on one
 * coordinate over a runway more than a few hundred metres long is not something
 * a survey produces.
 */
function detectAxisRounding(leLat, leLon, heLat, heLon) {
  return leLon === heLon || leLat === heLat;
}

const round6 = (v) => Math.round(v * 1e6) / 1e6;
const round2 = (v) => Math.round(v * 100) / 100;

// ---------------------------------------------------------------------------
// FAA refinement pass
// ---------------------------------------------------------------------------

/**
 * Pull every FAA runway pavement polygon intersecting the region and reduce it
 * to a centreline.
 *
 * The service answers HTTP 200 with a JSON error body when the shared tenant
 * quota is exceeded, so the status code alone is not enough to know it worked.
 *
 * @returns {Promise<Array<{designator:string, lengthFt:number, widthFt:number,
 *          surface:string, lighted:boolean, line:object}>>} [] on failure.
 */
async function fetchFaaRunways(attempts = 4) {
  const params = new URLSearchParams({
    where: '1=1',
    geometry: `${REGION_BBOX.west},${REGION_BBOX.south},${REGION_BBOX.east},${REGION_BBOX.north}`,
    geometryType: 'esriGeometryEnvelope',
    inSR: '4326',
    spatialRel: 'esriSpatialRelIntersects',
    outFields: 'AIRPORT_ID,DESIGNATOR,LENGTH,WIDTH,DIM_UOM,COMP_CODE,LIGHTACTV',
    returnGeometry: 'true',
    outSR: '4326',
    f: 'json',
  });

  for (let i = 0; i < attempts; i++) {
    try {
      const res = await get(`${FAA_RUNWAYS}?${params}`);
      const json = await res.json();
      if (json.error) throw new Error(`FAA ${json.error.code}: ${json.error.message}`);
      if (json.exceededTransferLimit) {
        console.warn('  ! FAA response was truncated; some runways missing');
      }
      const out = [];
      for (const f of json.features || []) {
        const a = f.attributes || {};
        const ring = f.geometry?.rings?.[0];
        const line = centrelineOf(ring);
        if (!line) continue;
        const toFt = a.DIM_UOM === 'M' ? 3.280839895013123 : 1;
        out.push({
          designator: String(a.DESIGNATOR || '').trim().toUpperCase(),
          lengthFt: num(a.LENGTH, NaN) * toFt,
          widthFt: num(a.WIDTH, NaN) * toFt,
          surface: String(a.COMP_CODE || '').trim().toUpperCase(),
          // LIGHTACTV is an intensity/activation code, not a boolean: KBFI's
          // lit runways come back as 3, KSEA's as 0 even though they are lit.
          // Too ambiguous to trust, so OurAirports' `lighted` column wins and
          // this is carried only for reference.
          lightActv: a.LIGHTACTV,
          line,
        });
      }
      return out;
    } catch (err) {
      const wait = 15000 * (i + 1);
      if (i === attempts - 1) {
        console.warn(`  ! FAA refinement unavailable (${err.message}).`);
        console.warn('    Falling back to OurAirports geometry alone.');
        return [];
      }
      console.warn(`  . FAA attempt ${i + 1} failed (${err.message}); retrying in ${wait / 1000}s`);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
  return [];
}

/**
 * Find the FAA polygon that corresponds to one OurAirports runway row, and
 * return its centreline oriented low-end-first — or null if nothing passes
 * validation.
 *
 * Four independent gates, because an unvalidated automatic match is exactly how
 * a runway ends up 400 m into Puget Sound:
 *   1. the designator must match, in either order;
 *   2. the centre must be within FAA_MAX_ARP_M of the airport reference point;
 *   3. the length must agree with OurAirports to FAA_LENGTH_TOLERANCE, and if
 *      OurAirports has endpoints, neither threshold may move more than
 *      FAA_MAX_SHIFT_M;
 *   4. the resulting heading must be consistent with the runway NUMBER to
 *      FAA_DESIGNATOR_TOLERANCE_DEG.
 *
 * Dimensions are NOT taken from the polygon. Reducing an outline to a length and
 * a width is only exact for a true rectangle, and the small grass strips are not
 * rectangles — Green Valley Airfield's outline measures 253 ft across a runway
 * published at 100 ft. The polygon supplies the two thresholds; `length_ft` and
 * `width_ft` stay the published dimensions, with the FAA's own LENGTH / WIDTH
 * attributes as a fallback when OurAirports has none.
 */
function matchFaa(faa, airport, row, ourEnds, reject) {
  const want = `${row.le_ident}/${row.he_ident}`.toUpperCase();
  const wantRev = `${row.he_ident}/${row.le_ident}`.toUpperCase();
  const pubLen = num(row.length_ft, NaN);

  let best = null;
  for (const cand of faa) {
    if (cand.designator !== want && cand.designator !== wantRev) continue;
    const midLat = (cand.line.aLat + cand.line.bLat) / 2;
    const midLon = (cand.line.aLon + cand.line.bLon) / 2;
    const dArp = distanceBetween(airport.lat, airport.lon, midLat, midLon);
    if (dArp > FAA_MAX_ARP_M) continue;

    const lenFt = cand.line.lengthM * 3.280839895013123;
    if (Number.isFinite(pubLen) && pubLen > 0) {
      if (Math.abs(lenFt - pubLen) / pubLen > FAA_LENGTH_TOLERANCE) continue;
    }

    // Orient: low end first. Prefer agreement with OurAirports' own endpoints;
    // otherwise fall back to the heading the runway NUMBER implies.
    const fromNumber = headingFromIdent(row.le_ident);
    const fwd = bearingBetween(
      cand.line.aLat, cand.line.aLon, cand.line.bLat, cand.line.bLon,
    );
    let aIsLow;
    if (ourEnds) {
      const straight =
        distanceBetween(ourEnds.leLat, ourEnds.leLon, cand.line.aLat, cand.line.aLon) +
        distanceBetween(ourEnds.heLat, ourEnds.heLon, cand.line.bLat, cand.line.bLon);
      const swapped =
        distanceBetween(ourEnds.leLat, ourEnds.leLon, cand.line.bLat, cand.line.bLon) +
        distanceBetween(ourEnds.heLat, ourEnds.heLon, cand.line.aLat, cand.line.aLon);
      aIsLow = straight <= swapped;
      const shift = Math.min(straight, swapped) / 2;
      if (shift > FAA_MAX_SHIFT_M) {
        reject?.(`${airport.ident} ${want}: FAA threshold ${shift.toFixed(0)} m from OurAirports'`);
        continue;
      }
    } else if (Number.isFinite(fromNumber)) {
      aIsLow = angleDelta(fwd, fromNumber) <= 90;
    } else {
      continue; // no way to tell which end is which
    }

    const heading = aIsLow ? fwd : (fwd + 180) % 360;
    if (
      Number.isFinite(fromNumber) &&
      angleDelta(heading, fromNumber) > FAA_DESIGNATOR_TOLERANCE_DEG
    ) {
      reject?.(
        `${airport.ident} ${want}: FAA polygon runs ${heading.toFixed(1)} true, but ` +
          `runway ${row.le_ident} implies ~${fromNumber.toFixed(1)}`,
      );
      continue;
    }

    const out = aIsLow
      ? { leLat: cand.line.aLat, leLon: cand.line.aLon, heLat: cand.line.bLat, heLon: cand.line.bLon }
      : { leLat: cand.line.bLat, leLon: cand.line.bLon, heLat: cand.line.aLat, heLon: cand.line.aLon };
    // Published dimensions only — never the outline's own extents. See above.
    out.attrLengthFt = cand.lengthFt;
    out.attrWidthFt = cand.widthFt;
    out.surface = cand.surface;
    if (!best || dArp < best._d) {
      out._d = dArp;
      best = out;
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const args = parseArgs();

  console.log('Fetching OurAirports CSVs...');
  const [airportsText, runwaysText] = await Promise.all([
    get(AIRPORTS_CSV).then((r) => r.text()),
    get(RUNWAYS_CSV).then((r) => r.text()),
  ]);
  console.log(
    `  airports.csv ${(airportsText.length / 1e6).toFixed(1)} MB, ` +
      `runways.csv ${(runwaysText.length / 1e6).toFixed(1)} MB`,
  );

  const allAirports = rowsToObjects(parseCSV(airportsText));
  const allRunways = rowsToObjects(parseCSV(runwaysText));

  const regional = allAirports.filter(
    (a) =>
      KEEP_TYPES.has(a.type) &&
      inBbox(num(a.latitude_deg), num(a.longitude_deg), REGION_BBOX),
  );
  console.log(`  ${regional.length} airports in region`);

  let faa = [];
  if (args['no-faa']) {
    console.log('Skipping FAA refinement (--no-faa).');
  } else {
    console.log('Fetching FAA ADIP runway polygons...');
    faa = await fetchFaaRunways();
    if (faa.length) console.log(`  ${faa.length} FAA runway polygons in region`);
  }

  // Index runways by airport_ref once; the CSV is 40k rows.
  /** @type {Map<string, object[]>} */
  const runwaysByRef = new Map();
  for (const r of allRunways) {
    const list = runwaysByRef.get(r.airport_ref);
    if (list) list.push(r);
    else runwaysByRef.set(r.airport_ref, [r]);
  }

  const stats = {
    handOverride: 0,
    surveyed: 0,
    faa: 0,
    synthesised: 0,
    skippedClosed: 0,
    skippedUnusable: 0,
    axisRounded: [],
    lengthRejected: [],
    faaRejected: [],
  };

  const out = [];

  for (const a of regional) {
    const airport = {
      ident: a.ident,
      name: a.name,
      lat: round6(num(a.latitude_deg)),
      lon: round6(num(a.longitude_deg)),
      elevationFt: num(a.elevation_ft, 0),
      type: a.type,
      municipality: a.municipality || '',
      runways: [],
    };

    for (const row of runwaysByRef.get(a.id) || []) {
      if (row.closed === '1') {
        stats.skippedClosed++;
        continue;
      }
      const key = `${a.ident} ${row.le_ident}/${row.he_ident}`;
      const lengthFt = num(row.length_ft, NaN);
      const widthFt = num(row.width_ft, NaN);

      const leLat = num(row.le_latitude_deg, NaN);
      const leLon = num(row.le_longitude_deg, NaN);
      const heLat = num(row.he_latitude_deg, NaN);
      const heLon = num(row.he_longitude_deg, NaN);
      const hasEnds = [leLat, leLon, heLat, heLon].every(Number.isFinite);
      const ourEnds = hasEnds ? { leLat, leLon, heLat, heLon } : null;

      let ends = null;
      let geometry = null;
      let width = widthFt;
      let length = lengthFt;
      let surface = row.surface || '';

      // 1. A hand-checked override always wins.
      const ov = OVERRIDES[key];
      if (ov) {
        ends = { leLat: ov.leLat, leLon: ov.leLon, heLat: ov.heLat, heLon: ov.heLon };
        geometry = 'override';
        stats.handOverride++;
      }

      // 2. Endpoints we are contractually pinned to.
      if (!ends && PROTECTED_GEOMETRY.has(key) && hasEnds) {
        ends = ourEnds;
        geometry = 'surveyed';
        stats.surveyed++;
      }

      // 3. The FAA survey.
      if (!ends && faa.length) {
        const hit = matchFaa(faa, airport, row, ourEnds, (m) => stats.faaRejected.push(m));
        if (hit) {
          ends = { leLat: hit.leLat, leLon: hit.leLon, heLat: hit.heLat, heLon: hit.heLon };
          geometry = 'override';
          // Published dimensions win; the FAA's attributes only fill gaps.
          if (!(width > 0) && hit.attrWidthFt > 5) width = hit.attrWidthFt;
          if (!(length > 0) && hit.attrLengthFt > 50) length = hit.attrLengthFt;
          if (!surface && hit.surface) surface = hit.surface;
          stats.faa++;
        }
      }

      // 4. OurAirports' own endpoints, if they survive the length check.
      if (!ends && hasEnds) {
        const computedFt = distanceBetween(leLat, leLon, heLat, heLon) * 3.280839895013123;
        const ok =
          !Number.isFinite(lengthFt) ||
          lengthFt <= 0 ||
          Math.abs(computedFt - lengthFt) / lengthFt <= LENGTH_TOLERANCE;
        if (ok) {
          ends = ourEnds;
          geometry = 'surveyed';
          stats.surveyed++;
          if (detectAxisRounding(leLat, leLon, heLat, heLon)) {
            stats.axisRounded.push(key);
          }
        } else {
          stats.lengthRejected.push(
            `${key}: endpoints imply ${computedFt.toFixed(0)} ft vs published ${lengthFt}`,
          );
        }
      }

      // 5. Last resort: infer the whole thing from the runway number.
      //
      // Not for seaplane bases. A "runway" there is a water lane, often
      // published at absurd dimensions — Port of Poulsbo's is 12,000 x 4,000 ft
      // — and synthesising a rectangle for it would put a 3.6 km ribbon across
      // the middle of Liberty Bay. Seaplane bases stay in the file as markers
      // with no runways at all.
      if (!ends && airport.type === 'seaplane_base') {
        stats.skippedUnusable++;
        continue;
      }
      if (!ends) {
        const trueHdg = headingFromIdent(row.le_ident);
        if (!Number.isFinite(trueHdg) || !Number.isFinite(lengthFt) || lengthFt < 100) {
          stats.skippedUnusable++;
          continue;
        }
        const halfM = (lengthFt * 0.3048) / 2;
        const r = (trueHdg * Math.PI) / 180;
        const dLat = (Math.cos(r) * halfM) / M_LAT;
        const dLon = (Math.sin(r) * halfM) / M_LON;
        ends = {
          leLat: airport.lat - dLat,
          leLon: airport.lon - dLon,
          heLat: airport.lat + dLat,
          heLon: airport.lon + dLon,
        };
        geometry = 'synthesised';
        stats.synthesised++;
      }

      const headingDeg = bearingBetween(ends.leLat, ends.leLon, ends.heLat, ends.heLon);

      airport.runways.push({
        leIdent: row.le_ident || '',
        heIdent: row.he_ident || '',
        leLat: round6(ends.leLat),
        leLon: round6(ends.leLon),
        heLat: round6(ends.heLat),
        heLon: round6(ends.heLon),
        headingDeg: round2(headingDeg),
        lengthFt: Number.isFinite(length) ? Math.round(length) : 0,
        widthFt: Number.isFinite(width) && width > 0 ? Math.round(width) : 0,
        surface,
        lighted: bool(row.lighted),
        closed: false,
        geometry,
        leElevationFt: num(row.le_elevation_ft, null),
        heElevationFt: num(row.he_elevation_ft, null),
        leDisplacedFt: num(row.le_displaced_threshold_ft, 0) || 0,
        heDisplacedFt: num(row.he_displaced_threshold_ft, 0) || 0,
      });
    }

    // Airports with no usable runway are dropped, except seaplane bases, which
    // stay as markers on the water.
    if (airport.runways.length || airport.type === 'seaplane_base') out.push(airport);
  }

  out.sort((x, y) => (x.ident < y.ident ? -1 : x.ident > y.ident ? 1 : 0));

  // -------------------------------------------------------------------------
  // Sanity checks. Each one falsifies a whole class of bug.
  // -------------------------------------------------------------------------
  const problems = [];
  const find = (ident) => out.find((x) => x.ident === ident);
  const rw = (ident, le) => find(ident)?.runways.find((r) => r.leIdent === le);

  // The spawn invariant.
  const bfi = rw('KBFI', '14R');
  if (
    !bfi ||
    bfi.leLat !== 47.540549 ||
    bfi.leLon !== -122.311372 ||
    bfi.heLat !== 47.516745 ||
    bfi.heLon !== -122.291252
  ) {
    problems.push(
      'KBFI 14R/32L endpoints drifted from the values SPAWN.fallback in ' +
        `src/geo/airports.js repeats. Got ${JSON.stringify(bfi && [bfi.leLat, bfi.leLon, bfi.heLat, bfi.heLon])}`,
    );
  }

  // KSEA: three parallel runways, all within half a degree of due south, in the
  // right place, with the right lengths. This is the check a real chart falsifies.
  const sea = find('KSEA');
  if (!sea) problems.push('KSEA missing from the output');
  else {
    if (distanceBetween(sea.lat, sea.lon, 47.447943, -122.310276) > 50) {
      problems.push(`KSEA reference point moved: ${sea.lat},${sea.lon}`);
    }
    for (const [le, wantLen] of [['16L', 11901], ['16C', 9426], ['16R', 8500]]) {
      const r = rw('KSEA', le);
      if (!r) {
        problems.push(`KSEA ${le} missing`);
        continue;
      }
      if (angleDelta(r.headingDeg, 180.34) > 0.5) {
        problems.push(`KSEA ${le} heading ${r.headingDeg} is not ~180.34 true`);
      }
      if (Math.abs(r.lengthFt - wantLen) / wantLen > 0.02) {
        problems.push(`KSEA ${le} length ${r.lengthFt} ft, expected ~${wantLen}`);
      }
      if (r.geometry === 'synthesised') problems.push(`KSEA ${le} was synthesised`);
    }
    // The three thresholds must lie on an east-west line ~30 m apart in latitude.
    const lats = ['16L', '16C', '16R'].map((k) => rw('KSEA', k)?.leLat);
    if (lats.every(Number.isFinite) && Math.max(...lats) - Math.min(...lats) > 0.0005) {
      problems.push(`KSEA 16x thresholds are not aligned: ${lats.join(', ')}`);
    }
  }

  // KPAE: two runways, both a degree or so west of due south.
  const pae = rw('KPAE', '16R');
  if (!pae) problems.push('KPAE 16R missing');
  else if (angleDelta(pae.headingDeg, 179.14) > 1) {
    problems.push(`KPAE 16R heading ${pae.headingDeg} is not ~179.1 true`);
  }

  // Nothing may end up far outside the region or a long way off its own ARP.
  // The bbox gets a 0.05 degree (~5 km) margin: airports legitimately sit on the
  // boundary, and WN21 Lawson Airpark's north threshold really is 300 m past it.
  const MARGIN = 0.05;
  const soft = {
    south: REGION_BBOX.south - MARGIN,
    north: REGION_BBOX.north + MARGIN,
    west: REGION_BBOX.west - MARGIN,
    east: REGION_BBOX.east + MARGIN,
  };
  for (const ap of out) {
    for (const r of ap.runways) {
      if (!inBbox(r.leLat, r.leLon, soft) || !inBbox(r.heLat, r.heLon, soft)) {
        problems.push(`${ap.ident} ${r.leIdent}/${r.heIdent} has an endpoint outside the region`);
      }
      const mid = distanceBetween(
        ap.lat, ap.lon,
        (r.leLat + r.heLat) / 2, (r.leLon + r.heLon) / 2,
      );
      if (mid > 8000) {
        problems.push(`${ap.ident} ${r.leIdent}/${r.heIdent} centre is ${(mid / 1000).toFixed(1)} km from the ARP`);
      }
      const implied = distanceBetween(r.leLat, r.leLon, r.heLat, r.heLon) * 3.280839895013123;
      if (r.lengthFt > 0 && Math.abs(implied - r.lengthFt) / r.lengthFt > 0.05) {
        problems.push(
          `${ap.ident} ${r.leIdent}/${r.heIdent} endpoints imply ${implied.toFixed(0)} ft, lengthFt says ${r.lengthFt}`,
        );
      }
    }
  }

  console.log('\nGeometry provenance:');
  console.log(`  override, hand-checked table     ${stats.handOverride}`);
  console.log(`  override, FAA ADIP polygon       ${stats.faa}`);
  console.log(`  surveyed, OurAirports endpoints  ${stats.surveyed}`);
  console.log(`  synthesised, from runway number  ${stats.synthesised}`);
  console.log(`  skipped: ${stats.skippedClosed} closed, ${stats.skippedUnusable} unusable`);
  if (stats.axisRounded.length) {
    console.log(
      `  ! ${stats.axisRounded.length} runway(s) kept OurAirports endpoints that are ` +
        'exactly axis-aligned (TRAP 2) and got no better survey:',
    );
    for (const k of stats.axisRounded) console.log(`      ${k}`);
  }
  for (const m of stats.lengthRejected) console.log(`  ! ${m}`);
  for (const m of stats.faaRejected) console.log(`  ! ${m}`);

  if (args.report) {
    console.log('\nEvery runway:');
    for (const ap of out) {
      console.log(`  ${ap.ident.padEnd(5)} ${ap.type.padEnd(15)} ${ap.name}`);
      for (const r of ap.runways) {
        console.log(
          `      ${(r.leIdent + '/' + r.heIdent).padEnd(9)} ` +
            `${String(r.headingDeg).padStart(6)} deg  ` +
            `${String(r.lengthFt).padStart(5)} x ${String(r.widthFt).padStart(3)} ft  ` +
            `${r.surface.padEnd(12)} ${r.lighted ? 'lit ' : '    '} ${r.geometry}`,
        );
      }
    }
  }

  if (problems.length) {
    console.error('\nSANITY CHECKS FAILED:');
    for (const p of problems) console.error(`  - ${p}`);
    throw new Error(`${problems.length} sanity check(s) failed; nothing written.`);
  }
  console.log('\nAll sanity checks passed.');

  await writeJson('data/airports.json', {
    generated: new Date().toISOString(),
    source: faa.length ? 'ourairports+faa-adip' : 'ourairports',
    bbox: REGION_BBOX,
    counts: {
      airports: out.length,
      runways: out.reduce((n, a) => n + a.runways.length, 0),
      override: stats.handOverride + stats.faa,
      surveyed: stats.surveyed,
      synthesised: stats.synthesised,
    },
    airports: out,
  });

  console.log(
    `  ${out.length} airports, ` +
      `${out.reduce((n, a) => n + a.runways.length, 0)} runways`,
  );
}

// centrelineOf() is exported for testing, so guard the entry point: importing
// this module must not fire off two CSV downloads and a bake.
const invokedDirectly =
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  main().catch((err) => {
    console.error(err.message);
    process.exitCode = 1;
  });
}
