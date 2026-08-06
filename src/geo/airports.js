/**
 * airports.js — real airports, real runway geometry, procedural paint.
 *
 * Contract: see MODULES.md § airports
 *
 *   loadAirports() -> Promise<Airport[]>
 *   buildRunwayMeshes(scene, airports) -> THREE.Group   // named 'airports'
 *
 * ---------------------------------------------------------------------------
 * WHAT IS REAL HERE AND WHAT IS NOT
 * ---------------------------------------------------------------------------
 * REAL, from data, never invented: every threshold coordinate, every true
 * heading, every published length and width, the surface type, whether the
 * runway is lit, and where each displaced threshold sits. A runway drawn by this
 * module is drawn between its own two surveyed endpoints, projected through
 * coords.llToLocal(). There is no offset table, no fudge factor and no
 * per-airport special case in the rendering path — get the data right and the
 * picture is right.
 *
 * PROCEDURAL: the colour of the asphalt, its grain, the exact stripe layout
 * (FAA-standard proportions, not surveyed paint), the taxiway and apron hints,
 * and the light fixtures. This is the trade MODULES.md §1.5 describes: we do not
 * drape satellite imagery, so the pavement stays crisp at 20 ft AGL instead of
 * turning to mush the way GeoFS does below ~500 ft.
 *
 * Markings are GEOMETRY, not a texture — every stripe is a pair of triangles at
 * its true size. That is the whole point: you can put a wheel on the centreline
 * from six inches away and the stripe still has a hard edge. The only textures
 * in this module are a 256 px asphalt-grain map and a glyph atlas for the runway
 * numbers, both generated at runtime from a canvas.
 *
 * ---------------------------------------------------------------------------
 * DATA PROVENANCE AND ITS SHARP EDGES
 * ---------------------------------------------------------------------------
 * public/data/airports.json, baked by scripts/bake-airports.mjs from OurAirports
 * plus the FAA ADIP runway-polygon service. Read that script's header before
 * trusting a field. The short version:
 *
 * 1. `le_heading_degT` upstream is frequently MAGNETIC. Never used here;
 *    `headingDeg` is always computed from the endpoints, and this module
 *    recomputes it from the endpoints again rather than reading the field, so
 *    the drawn ribbon and the spawn heading cannot disagree.
 * 2. OurAirports rounds some endpoints until the runway is exactly axis
 *    aligned — all three KSEA runways come out at 180.000. The baker replaces
 *    those with FAA survey (KSEA is 180.34 true, not 180.000 and not the 175.6
 *    the old scaffold guessed). `geometry` records how each runway was obtained;
 *    'synthesised' means inferred from the runway number and nothing more.
 * 3. A RUNWAY NUMBER IS MAGNETIC, THE STORED HEADING IS TRUE. Reading "16" as
 *    160 true is the single most attractive way to get this wrong: the regional
 *    variation is 15.6 deg EAST, so 16 means 160 magnetic = 175.6 true, and
 *    KSEA's surveyed 180.34 true (164.7 magnetic) rounds to 16 exactly as it
 *    should. auditRunwayGeometry() below tests every runway against its own
 *    designator through that conversion rather than against the raw number.
 * 4. The rounding trap is NOT limited to KSEA. auditRunwayGeometry() re-tests
 *    for it at load and DOWNGRADES the provenance tag of any runway whose two
 *    endpoints are still exactly axis-aligned, because such a pair cannot have
 *    come off a survey however the baker labelled it.
 *
 * ---------------------------------------------------------------------------
 * HEIGHT: WHY THE RUNWAY IS A PLANE AND NOT A DRAPE
 * ---------------------------------------------------------------------------
 * A real runway is graded: flat across, and at most about 1.5% along. Draping
 * one over a 13-52 m/pixel DEM would give it a wave you can feel on the landing
 * roll. So each runway gets a least-squares LINE fitted to the DEM along its own
 * centreline (see fitRunwayPlane), clamped to a believable gradient.
 *
 * It is lifted only far enough to clear the highest DEM sample under its own
 * pavement, because MODULES.md §1.4 is absolute: the collision surface is
 * elevation.getElevationLocal(), NOT this mesh. Lift the deck 3 m to make it
 * look flat and the aircraft lands 3 m underneath it. So the lift is computed,
 * capped at MAX_LIFT_M, and everything else is left to the DEM.
 */

import * as THREE from 'three';
import {
  llToLocal,
  bearingBetween,
  distanceBetween,
  headingToVector,
  MAG_VAR_DEG,
} from './coords.js';
import { getElevation, getElevationLocal } from './elevation.js';
import { fetchJsonOrNull } from '../core/assets.js';
import { FT_TO_M, M_TO_FT, clamp } from '../core/units.js';

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
 * @property {string} surface        Raw OurAirports/FAA code: ASP, PEM, CON, GRS, TURF...
 * @property {boolean} lighted
 * @property {boolean} closed
 * @property {'surveyed'|'synthesised'|'override'} geometry How the endpoints were obtained.
 * @property {number} [leElevationFt] Surveyed threshold elevation. Diagnostics only.
 * @property {number} [heElevationFt]
 * @property {number} [leDisplacedFt] Displaced threshold, feet from the physical end.
 * @property {number} [heDisplacedFt]
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

/** Types we draw runway ribbons for. Heliports and seaplane bases are skipped. */
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
      return airports;
    }
    auditRunwayGeometry(airports);
    return airports;
  })();
  return loadPromise;
}

/**
 * Endpoints exactly this equal in one axis did not come from a survey.
 *
 * A real threshold pair agrees to about 1e-6 deg by luck at best; agreeing to
 * the last stored digit means the source rounded until the runway was axis
 * aligned. That is the KSEA trap (all three runways published at exactly
 * 180.000), and it is not confined to KSEA — 14 more runways in the regional
 * set carry it, most of them private grass strips the FAA has no polygon for.
 */
const AXIS_ALIGNED_EPS_DEG = 0;

/** Length disagreement, endpoints vs the published `lengthFt`, worth a warning. */
const LENGTH_WARN = 0.02;

/**
 * How far a true heading may sit from its own designator before we say so.
 *
 * Compared in MAGNETIC, because that is what the number means. 5 deg is half a
 * designator step, so anything inside it rounds to the painted number; the
 * threshold is set at 12 to leave room for the FAA's own rounding and for
 * strips renumbered later than the chart we sourced.
 */
const DESIGNATOR_WARN_DEG = 12;

/**
 * Re-check the baked geometry and make the provenance tag tell the truth.
 *
 * The baker is the authority on where the numbers came from, but it runs
 * offline against services that can be down, and `geometry` is a CLAIM — code
 * elsewhere is entitled to read 'override' as "somebody surveyed this". So the
 * one failure the runtime can detect on its own, it detects: an exactly
 * axis-aligned endpoint pair is demoted to 'synthesised' no matter what the
 * file said, because whatever produced it, it was not a survey.
 *
 * Everything else is reported, not modified. Bad data is fixed in the baker;
 * silently patching coordinates here would put two files out of step and hide
 * the problem from the next bake.
 *
 * Mutates `geometry` in place and never throws (MODULES.md §1.6).
 *
 * @param {Airport[]} list
 * @returns {{demoted:string[], lengthOff:string[], designatorOff:string[]}}
 */
export function auditRunwayGeometry(list) {
  const demoted = [];
  const lengthOff = [];
  const designatorOff = [];

  for (const airport of list || []) {
    for (const rw of airport.runways || []) {
      if (!Number.isFinite(rw.leLat) || !Number.isFinite(rw.heLat)) continue;
      const key = `${airport.ident} ${rw.leIdent}/${rw.heIdent}`;

      if (
        Math.abs(rw.leLon - rw.heLon) <= AXIS_ALIGNED_EPS_DEG ||
        Math.abs(rw.leLat - rw.heLat) <= AXIS_ALIGNED_EPS_DEG
      ) {
        if (rw.geometry !== 'synthesised') {
          demoted.push(`${key} (${rw.geometry})`);
          rw.geometry = 'synthesised';
        }
      }

      const trueHeading = headingFromEndpoints(rw);
      const lengthFt = distanceBetween(rw.leLat, rw.leLon, rw.heLat, rw.heLon) * M_TO_FT;
      if (rw.lengthFt > 0 && Math.abs(lengthFt - rw.lengthFt) / rw.lengthFt > LENGTH_WARN) {
        lengthOff.push(
          `${key} ${lengthFt.toFixed(0)} ft between thresholds vs ${rw.lengthFt} published`,
        );
      }

      // The designator is MAGNETIC. Water lanes (16W) and lettered ends carry no
      // number to check against.
      const digits = /^(\d{1,2})[LCR]?$/.exec(String(rw.leIdent || '').trim());
      if (digits) {
        const magnetic = (trueHeading - MAG_VAR_DEG + 360) % 360;
        const painted = Number(digits[1]) * 10;
        const off = Math.abs(((magnetic - painted + 540) % 360) - 180);
        if (off > DESIGNATOR_WARN_DEG) {
          designatorOff.push(
            `${key} runs ${trueHeading.toFixed(1)} true = ${magnetic.toFixed(1)} magnetic, ` +
              `but is numbered ${painted}`,
          );
        }
      }
    }
  }

  if (demoted.length) {
    console.warn(
      `[airports] ${demoted.length} runway(s) have exactly axis-aligned ` +
        'endpoints and cannot be survey data; provenance demoted to ' +
        `'synthesised': ${demoted.join(', ')}`,
    );
  }
  if (lengthOff.length) {
    console.warn(`[airports] length disagreement >2%: ${lengthOff.join('; ')}`);
  }
  if (designatorOff.length) {
    console.warn(
      `[airports] heading disagrees with the painted designator: ${designatorOff.join('; ')}`,
    );
  }
  return { demoted, lengthOff, designatorOff };
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
 * The heading is recomputed from the two endpoints rather than read from
 * `headingDeg`, for the same reason the baker derives it: the ribbon is drawn
 * from the endpoints, so anything else can drift away from the painted
 * centreline without producing an error anywhere.
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
  // Standing at the low end you face the far end; at the high end, the reverse.
  const lat = atLowEnd ? runway.leLat : runway.heLat;
  const lon = atLowEnd ? runway.leLon : runway.heLon;
  const farLat = atLowEnd ? runway.heLat : runway.leLat;
  const farLon = atLowEnd ? runway.heLon : runway.leLon;
  return {
    lat,
    lon,
    headingDeg: bearingBetween(lat, lon, farLat, farLon),
    elevationM: getElevation(lat, lon),
    label: `${airport.ident} ${atLowEnd ? runway.leIdent : runway.heIdent}`,
  };
}

// ---------------------------------------------------------------------------
// Surfaces
// ---------------------------------------------------------------------------

/**
 * OurAirports and the FAA between them ship 22 distinct surface strings for our
 * 113 regional runways — ASP, ASPH, ASPH-G, ASPH-CONC-G, PEM, CON, TURF-E,
 * "GOOD GRASS", "Water"... Normalise to something a material can be chosen from.
 *
 * Order matters. A prefix test comes first so "ASPH-CONC-G" reads as asphalt
 * rather than concrete; the substring tests are the fallback for oddities like
 * "GOOD GRASS" whose first token is not the material at all.
 *
 * @param {string} raw
 * @returns {'asphalt'|'concrete'|'turf'|'gravel'|'dirt'|'water'|'unknown'}
 */
export function surfaceClass(raw) {
  const s = String(raw || '').trim().toUpperCase();
  if (!s) return 'unknown';
  const starts = (...p) => p.some((x) => s.startsWith(x));
  if (starts('WATER')) return 'water';
  // PEM is porous friction course laid over asphalt; BIT/TAR are tar-and-chip.
  if (starts('ASP', 'PEM', 'BIT', 'TAR', 'PSP')) return 'asphalt';
  if (starts('CON', 'CEM', 'PCC')) return 'concrete';
  if (starts('TURF', 'GRS', 'GRASS', 'SOD', 'GRE')) return 'turf';
  if (starts('GVL', 'GRVL', 'GRAVEL', 'COR')) return 'gravel';
  if (starts('DIRT', 'SAND', 'CLAY', 'SOIL', 'GROUND')) return 'dirt';
  if (s.includes('GRASS') || s.includes('TURF')) return 'turf';
  if (s.includes('ASPH') || s.includes('ASP')) return 'asphalt';
  if (s.includes('CONC')) return 'concrete';
  if (s.includes('GRVL') || s.includes('GRAVEL')) return 'gravel';
  return 'unknown';
}

/**
 * Base colour and finish per surface class.
 *
 * `grain` scales the procedural noise map: concrete is poured in slabs and reads
 * almost flat, asphalt is coarse, gravel is coarser still, turf gets none
 * because a mown field is not a texture problem this module should be solving.
 * `paint` is whether the surface takes runway markings at all — you do not paint
 * a touchdown-zone bar on grass.
 */
const SURFACES = {
  asphalt: { colour: 0x33373d, grain: 1.0, paint: true },
  concrete: { colour: 0x585c62, grain: 0.45, paint: true },
  turf: { colour: 0x4f6135, grain: 0.0, paint: false },
  gravel: { colour: 0x6d665a, grain: 1.3, paint: false },
  dirt: { colour: 0x5e4d38, grain: 1.1, paint: false },
  water: { colour: 0x1d3f5c, grain: 0.0, paint: false },
  unknown: { colour: 0x3f434a, grain: 0.8, paint: true },
};

/** Paint. Weathered white, not pure white — pure white blows out in sunlight. */
const PAINT_WHITE = 0xd9dcd6;
/** Taxiway paint. */
const PAINT_YELLOW = 0xbfa53c;
/** Taxiway/apron pavement: older, greyer, more patched than the runway. */
const TAXIWAY_COLOUR = 0x3d4147;

// ---------------------------------------------------------------------------
// Vertical placement
// ---------------------------------------------------------------------------

/**
 * Minimum float above the fitted plane. Small on purpose — see the header note
 * about MODULES.md §1.4.
 */
const MIN_LIFT_M = 0.25;

/**
 * Hard ceiling on the computed lift. If the DEM under a runway is 6 m rougher
 * than the fit, something is wrong with the data, and the right failure is a
 * runway that clips into a bump — not a runway floating three storeys up with
 * the aircraft landing underneath it.
 */
const MAX_LIFT_M = 2.5;

/** Markings sit this far above the pavement. Enough to beat z-fighting. */
const PAINT_LIFT_M = 0.02;

/**
 * Steepest longitudinal gradient we will fit. FAA design standards cap runway
 * grade at 1.5% for transport airports and 2% for small ones; anything steeper
 * out of the fit is the DEM's opinion of a hillside, not the runway's.
 */
const MAX_GRADE = 0.02;

/**
 * Fit a runway deck to the terrain under it.
 *
 * Samples the DEM along the centreline, fits `h = h0 + slope * t` by least
 * squares, then measures how far the pavement footprint pokes back up through
 * that line so the caller knows how much to lift.
 *
 * THE ORDER OF THE TWO TESTS MATTERS AND IT IS NOT THE OBVIOUS ONE.
 *
 * Straightness is judged against the RAW fit, before the gradient is clamped.
 * Clamping first and then asking "is the residual big?" conflates two different
 * failures: ground that is not straight, and ground that is straight but steep.
 * The second one used to be misdiagnosed as the first, and the consequence was
 * spectacular — a 185 m strip whose DEM drops 22 m end to end got its slope
 * thrown away and its deck levelled at the median, so half the ribbon was
 * buried and the other half hung 22 m in the air.
 *
 * So:
 *   - not straight (raw RMS over ROUGH_RMS_M) -> the DEM has no idea there is
 *     an airport here. Level at the median; nothing better exists.
 *   - straight but steeper than MAX_GRADE -> the DEM disagrees with a real
 *     runway's grade, which usually means a 52 m/px base tile has smoothed a
 *     graded strip back into the hillside it was cut from. FOLLOW THE DEM. A
 *     ribbon lying flush on the wrong slope beats a correctly-graded ribbon
 *     floating 20 m over the ground the aircraft will actually touch
 *     (MODULES.md §1.4), and the clamp is only ever relaxed by as much as the
 *     terrain demands.
 *
 * @param {number} ax @param {number} az le end, local metres
 * @param {number} dx @param {number} dz unit vector along the runway
 * @param {number} rx @param {number} rz unit vector across the runway (right)
 * @param {number} lengthM @param {number} widthM
 * @returns {{h0:number, slope:number, lift:number, rms:number, graded:boolean}}
 *          `graded` is false when the deck had to follow the terrain instead of
 *          holding a believable runway gradient.
 */
function fitRunwayPlane(ax, az, dx, dz, rx, rz, lengthM, widthM) {
  const ROUGH_RMS_M = 4;
  /** End-to-end error the gradient clamp may introduce before we drop it. */
  const CLAMP_SLACK_M = 3;
  const n = clamp(Math.round(lengthM / 40) + 1, 5, 64);
  const ts = new Array(n);
  const hs = new Array(n);
  let sumT = 0;
  let sumH = 0;
  for (let i = 0; i < n; i++) {
    const t = (i / (n - 1)) * lengthM;
    ts[i] = t;
    hs[i] = getElevationLocal(ax + dx * t, az + dz * t);
    sumT += t;
    sumH += hs[i];
  }
  const meanT = sumT / n;
  const meanH = sumH / n;
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    const dt = ts[i] - meanT;
    num += dt * (hs[i] - meanH);
    den += dt * dt;
  }
  const rawSlope = den > 0 ? num / den : 0;

  // Residual of the RAW line — this is the straightness test, and only this.
  let rawSq = 0;
  const rawH0 = meanH - rawSlope * meanT;
  for (let i = 0; i < n; i++) {
    const r = hs[i] - (rawH0 + rawSlope * ts[i]);
    rawSq += r * r;
  }
  const rawRms = Math.sqrt(rawSq / n);

  let slope;
  let h0;
  let graded;
  if (rawRms > ROUGH_RMS_M) {
    const sorted = hs.slice().sort((p, q) => p - q);
    h0 = sorted[sorted.length >> 1];
    slope = 0;
    graded = false;
  } else {
    slope = clamp(rawSlope, -MAX_GRADE, MAX_GRADE);
    // Straight ground the clamp would lift the deck off: follow it instead.
    if (Math.abs(rawSlope - slope) * lengthM > CLAMP_SLACK_M) {
      slope = rawSlope;
      graded = false;
    } else {
      graded = true;
    }
    h0 = meanH - slope * meanT;
  }

  let sq = 0;
  for (let i = 0; i < n; i++) {
    const r = hs[i] - (h0 + slope * ts[i]);
    sq += r * r;
  }
  const rms = Math.sqrt(sq / n);

  // How far does the ground poke back up through the deck, anywhere under the
  // pavement? Check both edges as well as the centreline: runways on a side
  // slope show it at the edges.
  const half = widthM / 2;
  let maxAbove = 0;
  for (let i = 0; i < n; i++) {
    const t = ts[i];
    const deck = h0 + slope * t;
    for (const s of [-half, 0, half]) {
      const h = getElevationLocal(
        ax + dx * t + rx * s,
        az + dz * t + rz * s,
      );
      if (h - deck > maxAbove) maxAbove = h - deck;
    }
  }
  const lift = clamp(maxAbove + MIN_LIFT_M, MIN_LIFT_M, MAX_LIFT_M);
  return { h0, slope, lift, rms, graded };
}

/**
 * Build the height profile the runway deck is actually drawn at.
 *
 * ---------------------------------------------------------------------------
 * WHY A PROFILE AND NOT JUST THE PLANE
 * ---------------------------------------------------------------------------
 * `fitRunwayPlane` returns a plane plus a single global `lift`, and that lift
 * is capped at MAX_LIFT_M (2.5 m) for a good reason: an uncapped lift would
 * float the pavement metres above the ground the aircraft actually collides
 * with (MODULES.md §1.4). But the cap has a visible cost. Where the DEM is
 * badly wrong under a runway, terrain pokes straight through the deck and the
 * runway is drawn in pieces.
 *
 * Measured at KSEA 16R/34L, whose Miller Creek embankment (up to 50 m of fill,
 * placed 2004-08) is simply not in the DEM: 11.1 m of RMS under a flat deck, so
 * the middle third of an 8,500 ft runway was buried and the runway rendered as
 * two disconnected fragments with a hill in the gap.
 *
 * The fix is to let the deck rise — locally, and only where the ground demands
 * it — rather than to lift the whole ribbon. The profile is
 *
 *     deck(t) = max(plane(t) + lift, maxTerrainAcross(t) + MIN_LIFT_M)
 *
 * which has the property that matters: **a runway whose plane already clears
 * the terrain everywhere is left exactly as it was.** For 100 of the 108 drawn
 * runways this is bit-identical to the old plane, so the flat, correctly-graded
 * common case is untouched. Only the handful sitting on a DEM that disagrees
 * with reality bend, and they bend to stay flush with the collision surface,
 * which is the trade §1.4 asks for.
 *
 * Sampled across the full width, not just the centreline — a runway cut into a
 * side slope shows the ground at its edges first.
 *
 * @returns {{sample:(t:number)=>number, segs:number, conformed:boolean,
 *            maxBendM:number}}
 */
function buildDeckProfile(ax, az, dx, dz, rx, rz, lengthM, widthM, fit) {
  /** Station spacing. Fine enough that the linear span between two stations
   *  cannot hide a hill the samples missed. */
  const STEP_M = 25;
  const n = clamp(Math.round(lengthM / STEP_M) + 1, 5, 256);
  const step = lengthM / (n - 1);
  const half = widthM / 2;
  const hs = new Float64Array(n);

  let conformed = false;
  let maxBendM = 0;
  for (let i = 0; i < n; i++) {
    const t = i * step;
    const plane = fit.h0 + fit.slope * t + fit.lift;
    let maxTerr = -Infinity;
    for (let k = -2; k <= 2; k++) {
      const s = (k / 2) * half;
      const e = getElevationLocal(ax + dx * t + rx * s, az + dz * t + rz * s);
      if (e > maxTerr) maxTerr = e;
    }
    const needed = maxTerr + MIN_LIFT_M;
    if (needed > plane) {
      hs[i] = needed;
      conformed = true;
      if (needed - plane > maxBendM) maxBendM = needed - plane;
    } else {
      hs[i] = plane;
    }
  }

  const sample = (t) => {
    const u = clamp(t / step, 0, n - 1);
    const i = Math.min(n - 2, Math.floor(u));
    const f = u - i;
    return hs[i] + (hs[i + 1] - hs[i]) * f;
  };

  // A flat deck needs no more geometry than it ever did; a bent one needs a
  // vertex per station or the pavement cuts the corner off its own profile.
  const segs = conformed
    ? n - 1
    : clamp(Math.round(lengthM / 120), 1, 48);

  return { sample, segs, conformed, maxBendM };
}

// ---------------------------------------------------------------------------
// Geometry sinks — everything merges, so the whole region is a handful of draws
// ---------------------------------------------------------------------------

/**
 * An accumulator for flat, upward-facing triangles.
 *
 * Every runway, stripe, light bar and apron in the region lands in one of five
 * of these and becomes one BufferGeometry. 113 runways drawn as individual
 * meshes would be ~12,000 draw calls; merged it is single digits.
 */
function makeSink() {
  return { pos: [], uv: [], idx: [], n: 0 };
}

/**
 * Push one planar quad.
 *
 * WINDING. Three.js culls back faces, and "front" is counter-clockwise after
 * projection. For a triangle lying in the XZ plane and facing +Y that works out
 * to a NEGATIVE 2D cross product in (x, z) — check it against a PlaneGeometry
 * rotated by rotateX(-PI/2) if you doubt it. With corners in the order
 * A=(t0,s0) B=(t1,s0) C=(t1,s1) D=(t0,s1), where t and s increase along the
 * runway's forward and right vectors, the correct triangles are (A,D,C) and
 * (A,C,B) — the reverse of the intuitive order. Getting this backwards makes
 * every runway in the region invisible from above and perfectly fine from below,
 * which is a memorable afternoon.
 */
function pushQuad(sink, A, B, C, D, uvA, uvB, uvC, uvD) {
  const i = sink.n;
  sink.pos.push(A[0], A[1], A[2], B[0], B[1], B[2], C[0], C[1], C[2], D[0], D[1], D[2]);
  sink.uv.push(uvA[0], uvA[1], uvB[0], uvB[1], uvC[0], uvC[1], uvD[0], uvD[1]);
  sink.idx.push(i, i + 3, i + 2, i, i + 2, i + 1);
  sink.n += 4;
}

/** Push one planar triangle, same winding rule as pushQuad. */
function pushTri(sink, A, B, C) {
  const i = sink.n;
  sink.pos.push(A[0], A[1], A[2], B[0], B[1], B[2], C[0], C[1], C[2]);
  sink.uv.push(0, 0, 0, 0, 0, 0);
  sink.idx.push(i, i + 2, i + 1);
  sink.n += 3;
}

/**
 * Turn a sink into a BufferGeometry, or null if nothing was pushed.
 * All normals are +Y: these surfaces are flat by construction.
 */
function sinkToGeometry(sink) {
  if (sink.n === 0) return null;
  const g = new THREE.BufferGeometry();
  const pos = new Float32Array(sink.pos);
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(sink.uv), 2));
  const normals = new Float32Array(sink.n * 3);
  for (let i = 0; i < sink.n; i++) normals[i * 3 + 1] = 1;
  g.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  g.setIndex(sink.n > 65535 ? new THREE.Uint32BufferAttribute(sink.idx, 1)
                            : new THREE.Uint16BufferAttribute(sink.idx, 1));
  g.computeBoundingSphere();
  return g;
}

// ---------------------------------------------------------------------------
// Procedural textures
// ---------------------------------------------------------------------------

/**
 * Pavement grain. Two octaves of value noise — 1 px for aggregate, 8 px blocks
 * for the patchiness of a resurfaced runway — plus faint longitudinal banding
 * where the paving machine's passes meet. Greyscale, multiplied by the material
 * colour, and centred on white so a strength of 0 is a no-op.
 *
 * `strength` scales the contrast rather than the colour: concrete is poured in
 * slabs and reads nearly flat, gravel is coarse. One texture per distinct
 * strength, cached — but the cache belongs to a single buildRunwayMeshes() call,
 * never to the module. disposeRunwayMeshes() disposes the textures it finds on
 * the materials, so a module-level cache would hand a disposed texture to the
 * next build.
 *
 * @param {number} strength
 * @param {Map<string, THREE.CanvasTexture>} cache
 * @returns {THREE.CanvasTexture}
 */
function grainTexture(strength, cache) {
  const key = strength.toFixed(2);
  const cached = cache.get(key);
  if (cached) return cached;

  const S = 256;
  const canvas = document.createElement('canvas');
  canvas.width = S;
  canvas.height = S;
  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(S, S);

  const blocks = new Float32Array(32 * 32);
  for (let i = 0; i < blocks.length; i++) blocks[i] = Math.random();

  for (let y = 0; y < S; y++) {
    const lane = Math.sin((y / S) * Math.PI * 8) * 3;
    for (let x = 0; x < S; x++) {
      const b = blocks[((y >> 3) * 32 + (x >> 3)) | 0];
      const dev = (Math.random() - 0.5) * 30 + (b - 0.5) * 26 + lane;
      const c = clamp(235 + dev * strength, 0, 255) | 0;
      const o = (y * S + x) * 4;
      img.data[o] = c;
      img.data[o + 1] = c;
      img.data[o + 2] = c;
      img.data[o + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = 8;
  tex.needsUpdate = true;
  cache.set(key, tex);
  return tex;
}

/** One grain texture repeat covers this many metres of pavement. */
const GRAIN_METRES = 9;

/**
 * A soft round dot, for runway edge lights.
 * @returns {THREE.CanvasTexture}
 */
function makeLightSprite() {
  const S = 64;
  const canvas = document.createElement('canvas');
  canvas.width = S;
  canvas.height = S;
  const ctx = canvas.getContext('2d');
  const g = ctx.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.25, 'rgba(255,255,255,0.75)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, S, S);
  const tex = new THREE.CanvasTexture(canvas);
  tex.needsUpdate = true;
  return tex;
}

/**
 * Build a glyph atlas for the runway designations actually in use.
 *
 * The numbers are the one marking that cannot be a rectangle, so they are the
 * one marking that is a texture. Every distinct glyph — "16", "34", "L" — gets
 * a 256 px cell, and each number quad indexes into it, so all the numbers in
 * the region are still a single draw call. ~40 cells for our 113 runways.
 *
 * THE CELL IS NOT THE GLYPH. A "16" set in Helvetica Bold inks about 88% of its
 * cell's width but only ~57% of its height (cap height, plus the slack left by
 * centring on the `middle` baseline). Mapping the whole cell onto a quad sized
 * from AC 150/5340-1 would therefore paint a 60 ft designation as a 34 ft one,
 * with 60 ft of empty pavement around it — which is exactly what the numbers
 * measured before this was fixed. So each cell records the glyph's INK BOX, not
 * its extent, and the quad in paintEnd() is the marking's true size.
 *
 * That also lets the quad be the real FAA aspect (tall and narrow) rather than
 * the font's: the ink is stretched to fill it, so "16" comes out with the
 * characteristic squeezed strokes of a real runway number instead of looking
 * like a road sign.
 *
 * @param {Set<string>} glyphs
 * @returns {{texture: THREE.CanvasTexture, cells: Map<string, number[]>}}
 *          cells maps glyph -> [u0, v0, u1, v1] of the drawn ink.
 */
function buildGlyphAtlas(glyphs) {
  const list = [...glyphs];
  const CELL = 256;
  const cols = Math.max(1, Math.ceil(Math.sqrt(list.length)));
  const rows = Math.max(1, Math.ceil(list.length / cols));
  const canvas = document.createElement('canvas');
  canvas.width = cols * CELL;
  canvas.height = rows * CELL;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#ffffff';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const font = (px) => `700 ${px}px "Helvetica Neue", Helvetica, Arial, sans-serif`;

  const cells = new Map();
  list.forEach((glyph, i) => {
    const col = i % cols;
    const row = (i / cols) | 0;
    const x0 = col * CELL;
    const y0 = row * CELL;
    const cx = x0 + CELL / 2;
    const cy = y0 + CELL / 2;

    // Fit the glyph to the cell with a small margin, measuring rather than
    // guessing so "1" and "34" both fill their box.
    let size = CELL * 0.92;
    ctx.font = font(size);
    const w = ctx.measureText(glyph).width;
    const maxW = CELL * 0.88;
    if (w > maxW) {
      size *= maxW / w;
      ctx.font = font(size);
    }
    ctx.fillText(glyph, cx, cy);

    // Ink box, measured from the same anchor the glyph was drawn at.
    // actualBoundingBox* is positive OUTWARD in all four directions and has
    // been in every browser we target for years; the fallback is the cap-height
    // approximation for anything that reports it as undefined, and a canvas
    // that reports nothing at all (jsdom, a headless check script) still gets a
    // sane box rather than NaN UVs.
    const met = ctx.measureText(glyph);
    const ink = (v, fb) => (Number.isFinite(v) ? v : fb);
    const left = cx - ink(met.actualBoundingBoxLeft, met.width / 2);
    const right = cx + ink(met.actualBoundingBoxRight, met.width / 2);
    const top = cy - ink(met.actualBoundingBoxAscent, size * 0.36);
    const bottom = cy + ink(met.actualBoundingBoxDescent, size * 0.36);

    // One pixel of bleed so alphaTest does not nibble the outer stroke, clamped
    // inside the cell so no glyph can sample its neighbour.
    const L = clamp(left - 1, x0, x0 + CELL);
    const Rt = clamp(right + 1, x0, x0 + CELL);
    const T = clamp(top - 1, y0, y0 + CELL);
    const B = clamp(bottom + 1, y0, y0 + CELL);

    // CanvasTexture flips Y, so v = 0 is the BOTTOM row of the image as drawn.
    cells.set(glyph, [
      L / canvas.width,
      1 - B / canvas.height,
      Rt / canvas.width,
      1 - T / canvas.height,
    ]);
  });

  const tex = new THREE.CanvasTexture(canvas);
  tex.anisotropy = 8;
  tex.needsUpdate = true;
  return { texture: tex, cells };
}

/**
 * Split a runway identifier into what actually gets painted.
 * "9" -> ["09", null], "16L" -> ["16", "L"], "E" -> [null, null].
 */
function designationGlyphs(ident) {
  const m = /^(\d{1,2})\s*([LCRWlcrw])?$/.exec(String(ident || '').trim());
  if (!m) return [null, null];
  const n = Number(m[1]);
  if (!(n >= 1 && n <= 36)) return [null, null];
  return [String(n).padStart(2, '0'), m[2] ? m[2].toUpperCase() : null];
}

// ---------------------------------------------------------------------------
// Markings
// ---------------------------------------------------------------------------

/**
 * FAA threshold ("piano key") stripe counts by runway width, from AC 150/5340-1.
 * Wider runway, more stripes; the stripe itself is always 5.75 ft wide.
 */
function thresholdStripeCount(widthM) {
  const ft = widthM / FT_TO_M;
  if (ft >= 200) return 16;
  if (ft >= 150) return 12;
  if (ft >= 100) return 8;
  if (ft >= 75) return 6;
  return 4;
}

/**
 * Runway designation marking, AC 150/5340-1M figure 3: a 60 ft numeral 20 ft
 * wide, numerals 8 ft apart. Kept as feet because that is how the standard is
 * written and every one of these numbers is checkable against it.
 */
const NUMERAL_H_FT = 60;
const NUMERAL_W_FT = 20;
const NUMERAL_GAP_FT = 8;

/**
 * Inner edge of the aiming-point and touchdown-zone bars, feet from the
 * centreline. The two share it, which is what makes the touchdown zone read as
 * a ladder running up to the aiming point rather than as scattered rectangles.
 */
const TDZ_INNER_FT = 36;

/** Below this length a runway gets a centreline and numbers and nothing else. */
const FULL_MARKINGS_MIN_M = 900;
/** Below this, no painted numbers either — it is a farm strip. */
const NUMBERS_MIN_M = 350;
/** Rubber deposits only appear where jets actually land. */
const RUBBER_MIN_M = 1500;

/**
 * Paint one end of a runway: threshold bars, designation, aiming point,
 * touchdown zone, and displaced-threshold arrows if the threshold is displaced.
 *
 * All distances are measured in `u`, metres from the LANDING threshold along the
 * landing direction, which is how the FAA specifies them. `at(u, s)` converts
 * that into a scene point.
 *
 * @param {(u:number, s:number) => number[]} at
 * @param {number} usable metres of runway ahead of this threshold
 * @param {number} widthM
 * @param {number} displacedM metres from the physical end to this threshold
 * @param {string} ident e.g. "16L"
 * @param {{paint: object, numbers: object}} sinks
 * @param {(g:string)=>number[]|undefined} cellFor
 */
function paintEnd(at, usable, widthM, displacedM, ident, sinks, cellFor) {
  const { paint, numbers } = sinks;
  const half = widthM / 2;
  const full = usable >= FULL_MARKINGS_MIN_M;
  const bar = (u0, u1, s0, s1) =>
    pushQuad(
      paint,
      at(u0, s0), at(u1, s0), at(u1, s1), at(u0, s1),
      [0, 0], [1, 0], [1, 1], [0, 1],
    );

  // --- Threshold bars. 150 ft long, starting 20 ft in from the threshold.
  if (full) {
    const n = thresholdStripeCount(widthM);
    const stripeW = 5.75 * FT_TO_M;
    // n stripes each side of a 6 ft gap on the centreline, evenly spread inside
    // the paved width less a 3 ft margin.
    const perSide = n / 2;
    const spanStart = 0.9;
    for (let i = 0; i < perSide; i++) {
      const inner = spanStart + i * stripeW * 2;
      if (inner + stripeW > half - 0.9) break;
      bar(6, 6 + 150 * FT_TO_M, inner, inner + stripeW);
      bar(6, 6 + 150 * FT_TO_M, -inner - stripeW, -inner);
    }
  } else if (usable >= NUMBERS_MIN_M) {
    // Short strips get a single transverse threshold bar.
    bar(1.5, 3.3, -half + 0.6, half - 0.6);
  }

  // --- Designation numbers. AC 150/5340-1 sets the numeral at 60 ft high and
  // 20 ft wide, with 8 ft between the two numerals — a 48 x 60 ft block, so it
  // is TALLER than it is wide, which is why a runway number does not look like
  // a road sign. The parallel-runway letter is the same height and sits BELOW
  // the numerals; "below", for a marking whose top points down the runway,
  // means between them and the threshold, because things further from the
  // threshold sit higher in the pilot's view.
  //
  // The quad is the marking's real size and the glyph's ink box is stretched
  // into it (see buildGlyphAtlas), so what is painted measures 60 ft on the
  // ground rather than however much of a font cell happened to be inked.
  if (usable >= NUMBERS_MIN_M) {
    const [digits, letter] = designationGlyphs(ident);
    const numH = clamp(usable * 0.05, 9, NUMERAL_H_FT * FT_TO_M);
    const scale = numH / (NUMERAL_H_FT * FT_TO_M);
    let u = full ? 6 + 170 * FT_TO_M : 8;
    if (digits) {
      const blockW =
        (digits.length * NUMERAL_W_FT + (digits.length - 1) * NUMERAL_GAP_FT) *
        FT_TO_M *
        scale;
      const numW = Math.min(blockW, half * 1.7) / 2;
      const letterCell = letter ? cellFor(letter) : null;
      if (letterCell) {
        const lw = Math.min(NUMERAL_W_FT * FT_TO_M * scale, half * 1.2) / 2;
        pushGlyph(numbers, at, u, u + numH, -lw, lw, letterCell);
        u += numH + NUMERAL_GAP_FT * FT_TO_M * scale;
      }
      const cell = cellFor(digits);
      if (cell) pushGlyph(numbers, at, u, u + numH, -numW, numW, cell);
    }
  }

  if (!full) return;

  // --- Aiming point: two 150 x 30 ft bars starting 1,000 ft from the threshold,
  // their inner edges 36 ft each side of the centreline. On anything narrower
  // than a standard 150 ft runway the pair is squeezed inboard rather than
  // hanging off the pavement.
  const inner = Math.min(TDZ_INNER_FT * FT_TO_M, half * 0.55);
  const aimU = 1000 * FT_TO_M;
  if (usable > aimU + 300) {
    const outer = Math.min(inner + 30 * FT_TO_M, half - 0.9);
    if (outer > inner + 0.6) {
      bar(aimU, aimU + 150 * FT_TO_M, inner, outer);
      bar(aimU, aimU + 150 * FT_TO_M, -outer, -inner);
    }
  }

  // --- Touchdown zone. Groups of 75 x 6 ft bars at 500 ft intervals, 3/2/2/1/1
  // per side, skipping 1,000 ft where the aiming point already is. Bars run
  // outboard from the same 36 ft inner edge as the aiming point.
  const TDZ = [
    [500, 3], [1500, 2], [2000, 2], [2500, 1], [3000, 1],
  ];
  const barW = 6 * FT_TO_M;
  const barGap = 5 * FT_TO_M;
  const barLen = 75 * FT_TO_M;
  for (const [ft, count] of TDZ) {
    const u = ft * FT_TO_M;
    // Never paint past the middle: the other threshold's markings live there.
    if (u + barLen > usable * 0.5) break;
    for (let i = 0; i < count; i++) {
      const s0 = inner + i * (barW + barGap);
      // A narrow runway gets fewer bars per group, not bars in the grass.
      if (s0 + barW > half - 0.6) break;
      bar(u, u + barLen, s0, s0 + barW);
      bar(u, u + barLen, -s0 - barW, -s0);
    }
  }

  // --- Displaced threshold: arrows down the unusable pavement, and a
  // demarcation arrowhead across the threshold itself.
  if (displacedM > 12) {
    const shaftW = 0.9;
    const lanes = [0, half * 0.45, -half * 0.45];
    for (const s of lanes) {
      // From the physical end (u = -displacedM) to 30 m short of the threshold.
      pushQuad(
        paint,
        at(-displacedM + 6, s - shaftW / 2),
        at(-22, s - shaftW / 2),
        at(-22, s + shaftW / 2),
        at(-displacedM + 6, s + shaftW / 2),
        [0, 0], [1, 0], [1, 1], [0, 1],
      );
      // Arrowhead pointing at the threshold.
      pushTri(paint, at(-22, s - 2.4), at(-8, s), at(-22, s + 2.4));
    }
  }
}

/**
 * Push a glyph quad, oriented so the character reads correctly to a pilot on
 * approach — the top of the number points down the runway.
 *
 * There is deliberately no flip for the far end. `at` is already expressed in
 * that end's own landing frame: u is metres down the runway from ITS threshold
 * and s is ITS pilot's right, so the mapping "glyph up = +u, glyph right = +s"
 * is the same at both ends. paintEnd's second call negates both axes when it
 * builds the closure, which rotates the marking 180 degrees in the world and
 * leaves the UVs alone. Flipping here as well would put the numbers back
 * upside-down at one end of every runway.
 *
 * CanvasTexture has flipY on, so v = 0 is the BOTTOM of the cell as drawn and
 * cell[3] (the high v) is the top of the character.
 */
function pushGlyph(sink, at, u0, u1, s0, s1, cell) {
  const [cu0, cv0, cu1, cv1] = cell;
  pushQuad(
    sink,
    at(u0, s0), at(u1, s0), at(u1, s1), at(u0, s1),
    [cu0, cv0], [cu0, cv1], [cu1, cv1], [cu1, cv0],
  );
}

// ---------------------------------------------------------------------------
// Oriented-box overlap, for placing the taxiway and apron hints
// ---------------------------------------------------------------------------

/**
 * Separating-axis test between two oriented rectangles in the XZ plane.
 *
 * Used so the procedural taxiway and apron can never be drawn on top of real
 * runway pavement. They are hints; real geometry always wins.
 *
 * @param {{cx:number, cz:number, dx:number, dz:number, hl:number, hw:number}} a
 * @param {{cx:number, cz:number, dx:number, dz:number, hl:number, hw:number}} b
 */
function obbOverlap(a, b) {
  const axes = [
    [a.dx, a.dz], [-a.dz, a.dx],
    [b.dx, b.dz], [-b.dz, b.dx],
  ];
  const ex = b.cx - a.cx;
  const ez = b.cz - a.cz;
  for (const [nx, nz] of axes) {
    const dist = Math.abs(ex * nx + ez * nz);
    const ra =
      a.hl * Math.abs(a.dx * nx + a.dz * nz) +
      a.hw * Math.abs(-a.dz * nx + a.dx * nz);
    const rb =
      b.hl * Math.abs(b.dx * nx + b.dz * nz) +
      b.hw * Math.abs(-b.dz * nx + b.dx * nz);
    if (dist > ra + rb) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// The builder
// ---------------------------------------------------------------------------

const _a = { x: 0, z: 0 };
const _b = { x: 0, z: 0 };

/**
 * Build every runway in `list` and add them to `scene`.
 *
 * Each runway is placed from its own endpoint coordinates through
 * coords.llToLocal() and levelled onto the DEM by fitRunwayPlane(), so it is in
 * the geographically correct place by construction. Everything merges into a
 * handful of geometries — see makeSink().
 *
 * Safe to call with [] (returns an empty group), so main.js can call it before
 * loadAirports() resolves and rebuild later.
 *
 * @param {THREE.Scene|THREE.Object3D} scene Parent to attach to. May be null.
 * @param {Airport[]} list
 * @returns {THREE.Group} Named 'airports'. Dispose via disposeRunwayMeshes().
 */
export function buildRunwayMeshes(scene, list = airports) {
  const group = new THREE.Group();
  group.name = 'airports';

  /** Decks that had to bend to stay above the DEM. Reported, not hidden. */
  const conformedDecks = [];

  const drawable = [];
  for (const airport of list || []) {
    if (!RUNWAY_TYPES.has(airport.type)) continue;
    for (const rw of airport.runways || []) {
      if (rw.closed) continue;
      if (!Number.isFinite(rw.leLat) || !Number.isFinite(rw.heLat)) continue;
      const cls = surfaceClass(rw.surface);
      // Water lanes belong to seaplane bases; a few land airports list one too,
      // and paving it would put a 1.5 km asphalt slab across a lake.
      if (cls === 'water') continue;
      drawable.push({ airport, rw, cls });
    }
  }

  if (drawable.length === 0) {
    if (scene) scene.add(group);
    return group;
  }

  // Pre-pass: which glyphs does the region actually need?
  const glyphs = new Set();
  for (const { rw } of drawable) {
    for (const ident of [rw.leIdent, rw.heIdent]) {
      const [d, l] = designationGlyphs(ident);
      if (d) glyphs.add(d);
      if (l) glyphs.add(l);
    }
  }
  const atlas = glyphs.size ? buildGlyphAtlas(glyphs) : null;
  const cellFor = (g) => atlas?.cells.get(g);

  /** @type {Map<string, object>} pavement sinks, one per surface class */
  const pavement = new Map();
  const sinkFor = (cls) => {
    let s = pavement.get(cls);
    if (!s) {
      s = makeSink();
      pavement.set(cls, s);
    }
    return s;
  };
  const paint = makeSink();
  const numbers = makeSink();
  const rubber = makeSink();
  const hints = makeSink();
  const hintPaint = makeSink();

  const lightPos = [];
  const lightCol = [];

  const meta = [];

  for (const { airport, rw, cls } of drawable) {
    llToLocal(rw.leLat, rw.leLon, _a);
    llToLocal(rw.heLat, rw.heLon, _b);
    const ax = _a.x;
    const az = _a.z;
    const lengthM = Math.hypot(_b.x - ax, _b.z - az);
    if (lengthM < 50) continue;

    const dx = (_b.x - ax) / lengthM;
    const dz = (_b.z - az) / lengthM;
    // Right of the direction of travel. For heading h, d = (sin h, -cos h) and
    // (-dz, dx) = (cos h, sin h), which is h + 90 degrees. See coords.js axes.
    const rx = -dz;
    const rz = dx;

    const widthM = clamp((rw.widthFt > 0 ? rw.widthFt : 75) * FT_TO_M, 6, 120);
    const fit = fitRunwayPlane(ax, az, dx, dz, rx, rz, lengthM, widthM);
    // The deck follows the plane wherever the plane clears the ground, and
    // rises to stay flush wherever the DEM disagrees with the real earthworks.
    // Identical to the bare plane for every runway that did not need it.
    const prof = buildDeckProfile(ax, az, dx, dz, rx, rz, lengthM, widthM, fit);
    const deck = prof.sample;
    if (prof.conformed) {
      conformedDecks.push({
        ident: airport.ident,
        runway: `${rw.leIdent}/${rw.heIdent}`,
        bendM: prof.maxBendM,
      });
    }

    /** Runway-local (t, s) -> scene point, on the pavement. */
    const at = (t, s, dy = 0) => [
      ax + dx * t + rx * s,
      deck(t) + dy,
      az + dz * t + rz * s,
    ];

    const half = widthM / 2;
    const surf = SURFACES[cls] || SURFACES.unknown;

    // --- Pavement. Segmented along its length so the fitted gradient is real
    // geometry rather than a single tilted quad (identical for a straight line,
    // but it keeps the vertex density sane for lighting). A deck that had to
    // conform to the terrain gets a vertex per profile station instead.
    const segs = prof.segs;
    const pav = sinkFor(cls);
    for (let i = 0; i < segs; i++) {
      const t0 = (i / segs) * lengthM;
      const t1 = ((i + 1) / segs) * lengthM;
      pushQuad(
        pav,
        at(t0, -half), at(t1, -half), at(t1, half), at(t0, half),
        [-half / GRAIN_METRES, t0 / GRAIN_METRES],
        [-half / GRAIN_METRES, t1 / GRAIN_METRES],
        [half / GRAIN_METRES, t1 / GRAIN_METRES],
        [half / GRAIN_METRES, t0 / GRAIN_METRES],
      );
    }

    // --- Paved shoulder. Real runways have one, and it doubles as the cover for
    // the step where the levelled deck meets sloping ground. Deliberately narrow
    // (see the header): a wide graded skirt in a colour of my choosing would
    // fight with terrain.js's procedural palette and read as a halo.
    if (surf.paint && lengthM >= FULL_MARKINGS_MIN_M) {
      const sh = Math.min(7.5, widthM * 0.25);
      const shoulder = sinkFor('shoulder');
      for (const sgn of [-1, 1]) {
        for (let i = 0; i < segs; i++) {
          const t0 = (i / segs) * lengthM;
          const t1 = ((i + 1) / segs) * lengthM;
          const s0 = sgn * half;
          const s1 = sgn * (half + sh);
          const lo = Math.min(s0, s1);
          const hi = Math.max(s0, s1);
          pushQuad(
            shoulder,
            at(t0, lo), at(t1, lo), at(t1, hi), at(t0, hi),
            [lo / GRAIN_METRES, t0 / GRAIN_METRES],
            [lo / GRAIN_METRES, t1 / GRAIN_METRES],
            [hi / GRAIN_METRES, t1 / GRAIN_METRES],
            [hi / GRAIN_METRES, t0 / GRAIN_METRES],
          );
        }
      }
    }

    // --- Markings.
    const leDisp = Math.max(0, (rw.leDisplacedFt || 0) * FT_TO_M);
    const heDisp = Math.max(0, (rw.heDisplacedFt || 0) * FT_TO_M);

    if (surf.paint && lengthM >= NUMBERS_MIN_M) {
      // Centreline, full length, dashed 120 ft on / 80 ft off.
      const on = 120 * FT_TO_M;
      const off = 80 * FT_TO_M;
      const clW = 0.45;
      for (let t = 6; t + on < lengthM - 6; t += on + off) {
        pushQuad(
          paint,
          at(t, -clW), at(t + on, -clW), at(t + on, clW), at(t, clW),
          [0, 0], [1, 0], [1, 1], [0, 1],
        );
      }

      // Edge stripes, paved runways wide enough to have them.
      if (lengthM >= FULL_MARKINGS_MIN_M && widthM >= 22) {
        const ew = 0.9;
        const inner = half - 0.6 - ew;
        for (const sgn of [-1, 1]) {
          const s0 = sgn > 0 ? inner : -inner - ew;
          pushQuad(
            paint,
            at(0, s0), at(lengthM, s0), at(lengthM, s0 + ew), at(0, s0 + ew),
            [0, 0], [1, 0], [1, 1], [0, 1],
          );
        }
      }

      // The two ends, each in its own landing frame: u forward from that
      // threshold, s to that pilot's right. Negating both axes for the high end
      // is a 180 degree rotation, so the triangle winding (which depends on the
      // PRODUCT of the two) is preserved — see pushQuad.
      const usable = lengthM - leDisp - heDisp;
      paintEnd(
        (u, s) => at(leDisp + u, s, PAINT_LIFT_M),
        usable, widthM, leDisp, rw.leIdent, { paint, numbers }, cellFor,
      );
      paintEnd(
        (u, s) => at(lengthM - heDisp - u, -s, PAINT_LIFT_M),
        usable, widthM, heDisp, rw.heIdent, { paint, numbers }, cellFor,
      );

      // --- Rubber. Jets put it down between about 300 and 900 m past the
      // threshold; it is the single most recognisable thing about a real runway
      // from the air and it costs two quads.
      if (lengthM >= RUBBER_MIN_M) {
        for (const [t0, t1] of [
          [leDisp + 240, leDisp + 900],
          [lengthM - heDisp - 900, lengthM - heDisp - 240],
        ]) {
          if (t1 - t0 < 100) continue;
          pushQuad(
            rubber,
            at(t0, -half * 0.85, PAINT_LIFT_M * 0.5),
            at(t1, -half * 0.85, PAINT_LIFT_M * 0.5),
            at(t1, half * 0.85, PAINT_LIFT_M * 0.5),
            at(t0, half * 0.85, PAINT_LIFT_M * 0.5),
            [0, 0], [1, 0], [1, 1], [0, 1],
          );
        }
      }
    }

    // --- Edge lights. Only where the data says the runway is lit and it is long
    // enough to matter; 22,000 additive dots across the region is a shimmer, not
    // an airport.
    if (rw.lighted && lengthM >= FULL_MARKINGS_MIN_M) {
      const spacing = 60;
      const count = Math.max(2, Math.round(lengthM / spacing));
      const s = half + 1.8;
      for (let i = 0; i <= count; i++) {
        const t = (i / count) * lengthM;
        // The last 600 m of each direction is amber on an instrument runway.
        const amber = t < 600 || t > lengthM - 600;
        for (const sgn of [-1, 1]) {
          const p = at(t, sgn * s, 0.35);
          lightPos.push(p[0], p[1], p[2]);
          if (amber) lightCol.push(1.0, 0.71, 0.29);
          else lightCol.push(0.95, 0.96, 1.0);
        }
      }
      // Green threshold bars at both landing thresholds.
      for (const t of [leDisp, lengthM - heDisp]) {
        for (let k = -2; k <= 2; k++) {
          const p = at(t, (k / 2) * (half - 1), 0.35);
          lightPos.push(p[0], p[1], p[2]);
          lightCol.push(0.24, 1.0, 0.48);
        }
      }
    }

    // Where the surveyed threshold elevations exist, they are the ground truth
    // the DEM is supposed to reproduce, so compare and keep the residual. This
    // is a DIAGNOSTIC, not a correction: the deck has to follow the DEM because
    // the DEM is the collision surface (MODULES.md §1.4), so forcing the
    // pavement onto the surveyed elevation would only mean landing under it.
    let surveyErrM = null;
    if (Number.isFinite(rw.leElevationFt) && Number.isFinite(rw.heElevationFt)) {
      const eLe = fit.h0 + fit.lift - rw.leElevationFt * FT_TO_M;
      const eHe = fit.h0 + fit.slope * lengthM + fit.lift - rw.heElevationFt * FT_TO_M;
      surveyErrM = Math.abs(eLe) > Math.abs(eHe) ? eLe : eHe;
    }

    meta.push({
      airport: airport.ident,
      runway: `${rw.leIdent}/${rw.heIdent}`,
      headingDeg: bearingBetween(rw.leLat, rw.leLon, rw.heLat, rw.heLon),
      lengthM,
      widthM,
      deckH0: fit.h0,
      deckSlope: fit.slope,
      liftM: fit.lift,
      fitRmsM: fit.rms,
      graded: fit.graded,
      surveyErrM,
      geometry: rw.geometry,
      surfaceClass: cls,
    });

    // Remember the frame for the taxiway/apron pass.
    rw.__frame = { ax, az, dx, dz, rx, rz, lengthM, widthM, deck, cls };
  }

  buildFieldHints(drawable, hints, hintPaint, lightPos, lightCol);
  for (const { rw } of drawable) delete rw.__frame;

  // -------------------------------------------------------------------------
  // Materials and meshes
  // -------------------------------------------------------------------------
  const grainCache = new Map();
  const addMesh = (sink, material, name) => {
    const g = sinkToGeometry(sink);
    if (!g) return null;
    const m = new THREE.Mesh(g, material);
    m.name = name;
    m.receiveShadow = true;
    m.matrixAutoUpdate = false;
    group.add(m);
    return m;
  };

  for (const [cls, sink] of pavement) {
    const spec =
      cls === 'shoulder'
        ? { colour: 0x2b2f34, grain: 1.1 }
        : SURFACES[cls] || SURFACES.unknown;
    addMesh(
      sink,
      new THREE.MeshLambertMaterial({
        color: spec.colour,
        map: spec.grain > 0 ? grainTexture(spec.grain, grainCache) : null,
      }),
      `runway-${cls}`,
    );
  }

  addMesh(
    rubber,
    new THREE.MeshLambertMaterial({
      color: 0x14161a,
      transparent: true,
      opacity: 0.4,
      depthWrite: false,
    }),
    'runway-rubber',
  );

  addMesh(
    paint,
    new THREE.MeshLambertMaterial({
      color: PAINT_WHITE,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    }),
    'runway-markings',
  );

  if (atlas) {
    const numMesh = addMesh(
      numbers,
      new THREE.MeshLambertMaterial({
        color: PAINT_WHITE,
        map: atlas.texture,
        transparent: true,
        alphaTest: 0.35,
        polygonOffset: true,
        polygonOffsetFactor: -3,
        polygonOffsetUnits: -3,
      }),
      'runway-numbers',
    );
    if (!numMesh) atlas.texture.dispose();
  }

  addMesh(
    hints,
    new THREE.MeshLambertMaterial({
      color: TAXIWAY_COLOUR,
      map: grainTexture(1.0, grainCache),
    }),
    'airport-taxiways',
  );
  addMesh(
    hintPaint,
    new THREE.MeshLambertMaterial({
      color: PAINT_YELLOW,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    }),
    'airport-taxiway-markings',
  );

  if (lightPos.length) {
    const lg = new THREE.BufferGeometry();
    lg.setAttribute('position', new THREE.Float32BufferAttribute(lightPos, 3));
    lg.setAttribute('color', new THREE.Float32BufferAttribute(lightCol, 3));
    lg.computeBoundingSphere();
    const lights = new THREE.Points(
      lg,
      new THREE.PointsMaterial({
        size: 2.6,
        sizeAttenuation: true,
        map: makeLightSprite(),
        vertexColors: true,
        transparent: true,
        opacity: 0.75,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      }),
    );
    // These are emissive sprites, not THREE.Lights — world/sky.js remains the
    // only module that owns actual lighting (MODULES.md §1.7).
    lights.name = 'runway-lights';
    lights.matrixAutoUpdate = false;
    group.add(lights);
  }

  group.userData = { runways: meta, count: meta.length, conformedDecks };
  reportDeckFit(meta);
  if (conformedDecks.length) {
    const worst = conformedDecks.slice().sort((a, b) => b.bendM - a.bendM).slice(0, 5);
    console.info(
      `[airports] ${conformedDecks.length} deck(s) bent to stay above a DEM that ` +
        'does not have the airport\'s earthworks (flush beats flat — MODULES.md §1.4): ' +
        worst.map((d) => `${d.ident} ${d.runway} +${d.bendM.toFixed(1)} m`).join(', ') +
        (conformedDecks.length > worst.length ? `, +${conformedDecks.length - worst.length} more` : ''),
    );
  }
  if (scene) scene.add(group);
  return group;
}

/**
 * How far the drawn deck may sit from the surveyed threshold elevation before
 * it is worth saying so. 6 m is about the point where the pavement stops
 * looking like it belongs to the hill it is on.
 */
const DECK_SURVEY_WARN_M = 6;

/**
 * Say out loud where the DEM could not support a flat runway.
 *
 * There is exactly one thing that can go wrong here and it is not a code bug:
 * the elevation data does not know the airport is there. The clearest case in
 * this region is KSEA 16R/34L, which stands on the third-runway embankment —
 * up to 50 m of fill placed in 2004-2008 over the Miller Creek valley. The
 * DEM's west side is still the valley, so a runway whose surveyed thresholds
 * are 430 and 363 ft is fitted to ground running 263-385 ft, and no flat deck
 * can both cover that and stay near it.
 *
 * The deck follows the DEM anyway, because the DEM is the collision surface
 * (MODULES.md §1.4) and a pavement drawn at the surveyed height would be a
 * pavement the aircraft falls through. So the failure is reported rather than
 * papered over — and it is fixed in the elevation data, not here.
 *
 * @param {object[]} meta
 */
function reportDeckFit(meta) {
  const offSurvey = meta
    .filter((r) => Number.isFinite(r.surveyErrM) && Math.abs(r.surveyErrM) > DECK_SURVEY_WARN_M)
    .sort((a, b) => Math.abs(b.surveyErrM) - Math.abs(a.surveyErrM));
  const throughDeck = meta.filter((r) => !r.graded);

  if (offSurvey.length) {
    console.warn(
      `[airports] ${offSurvey.length} runway deck(s) more than ${DECK_SURVEY_WARN_M} m ` +
        'from their surveyed threshold elevation — the DEM does not have the ' +
        'airport\'s earthworks: ' +
        offSurvey
          .slice(0, 8)
          .map((r) => `${r.airport} ${r.runway} ${r.surveyErrM > 0 ? '+' : ''}${r.surveyErrM.toFixed(1)} m`)
          .join(', '),
    );
  }
  if (throughDeck.length) {
    console.info(
      `[airports] ${throughDeck.length} runway(s) could not hold a believable ` +
        'gradient over the DEM under them and follow the terrain instead: ' +
        throughDeck
          .map(
            (r) =>
              `${r.airport} ${r.runway} (${(r.deckSlope * 100).toFixed(1)}%, ` +
              `DEM RMS ${r.fitRmsM.toFixed(1)} m)`,
          )
          .join(', '),
    );
  }
}

/**
 * Taxiway and apron hints for the bigger fields.
 *
 * Explicitly NOT survey data — we have no taxiway source, and MODULES.md §1.5 is
 * clear that the runway is what has to be right. What these do have is a rule
 * that keeps them honest: a hint is drawn only if its footprint misses every
 * real runway at that airport (obbOverlap). At KSEA that suppresses the apron
 * entirely, because the reference point sits within 60 m of 16C/34C's centreline
 * and a terminal apron there would be sitting on live pavement.
 *
 * The taxiway goes on whichever side of the primary runway the airport reference
 * point lies, which is the side the terminal is on, at a realistic 130 m offset.
 */
function buildFieldHints(drawable, hints, hintPaint, lightPos, lightCol) {
  /** @type {Map<string, {airport:object, runways:object[]}>} */
  const byAirport = new Map();
  for (const { airport, rw } of drawable) {
    if (!rw.__frame) continue;
    let e = byAirport.get(airport.ident);
    if (!e) {
      e = { airport, runways: [] };
      byAirport.set(airport.ident, e);
    }
    e.runways.push(rw);
  }

  for (const { airport, runways } of byAirport.values()) {
    if (airport.type !== 'large_airport' && airport.type !== 'medium_airport') continue;

    // Primary runway: the longest one.
    let primary = null;
    for (const rw of runways) {
      if (!primary || rw.__frame.lengthM > primary.__frame.lengthM) primary = rw;
    }
    if (!primary || primary.__frame.lengthM < 1000) continue;
    const F = primary.__frame;

    const boxes = runways.map((rw) => {
      const f = rw.__frame;
      return {
        cx: f.ax + f.dx * f.lengthM * 0.5,
        cz: f.az + f.dz * f.lengthM * 0.5,
        dx: f.dx,
        dz: f.dz,
        hl: f.lengthM / 2,
        hw: f.widthM / 2 + 12,
      };
    });

    llToLocal(airport.lat, airport.lon, _a);
    // Signed distance of the ARP across the primary runway.
    const relX = _a.x - F.ax;
    const relZ = _a.z - F.az;
    const across = relX * F.rx + relZ * F.rz;
    const side = across >= 0 ? 1 : -1;

    const at = (t, s, dy = 0) => [
      F.ax + F.dx * t + F.rx * s,
      F.deck(t) + dy,
      F.az + F.dz * t + F.rz * s,
    ];

    // --- Parallel taxiway.
    const twOffset = side * (F.widthM / 2 + 130);
    const twHalf = 11.5;
    const t0 = F.lengthM * 0.06;
    const t1 = F.lengthM * 0.94;
    const twBox = {
      cx: F.ax + F.dx * (t0 + t1) / 2 + F.rx * twOffset,
      cz: F.az + F.dz * (t0 + t1) / 2 + F.rz * twOffset,
      dx: F.dx,
      dz: F.dz,
      hl: (t1 - t0) / 2,
      hw: twHalf,
    };
    if (!boxes.some((b) => obbOverlap(twBox, b))) {
      const lo = twOffset - twHalf;
      const hi = twOffset + twHalf;
      const segs = clamp(Math.round((t1 - t0) / 120), 1, 40);
      for (let i = 0; i < segs; i++) {
        const u0 = t0 + ((t1 - t0) * i) / segs;
        const u1 = t0 + ((t1 - t0) * (i + 1)) / segs;
        pushQuad(
          hints,
          at(u0, lo), at(u1, lo), at(u1, hi), at(u0, hi),
          [lo / GRAIN_METRES, u0 / GRAIN_METRES],
          [lo / GRAIN_METRES, u1 / GRAIN_METRES],
          [hi / GRAIN_METRES, u1 / GRAIN_METRES],
          [hi / GRAIN_METRES, u0 / GRAIN_METRES],
        );
      }
      // Continuous yellow taxiway centreline.
      pushQuad(
        hintPaint,
        at(t0, twOffset - 0.075, PAINT_LIFT_M),
        at(t1, twOffset - 0.075, PAINT_LIFT_M),
        at(t1, twOffset + 0.075, PAINT_LIFT_M),
        at(t0, twOffset + 0.075, PAINT_LIFT_M),
        [0, 0], [1, 0], [1, 1], [0, 1],
      );
      // Blue taxiway edge lights, if the field is lit at all.
      if (primary.lighted) {
        for (let t = t0; t <= t1; t += 120) {
          for (const sgn of [-1, 1]) {
            const p = at(t, twOffset + sgn * (twHalf + 1.5), 0.3);
            lightPos.push(p[0], p[1], p[2]);
            lightCol.push(0.25, 0.42, 1.0);
          }
        }
      }
    }

    // --- Apron at the airport reference point, suppressed on collision.
    const big = airport.type === 'large_airport';
    const apHalfL = big ? 230 : 110;
    const apHalfW = big ? 140 : 80;
    const apBox = {
      cx: _a.x, cz: _a.z, dx: F.dx, dz: F.dz, hl: apHalfL, hw: apHalfW,
    };
    if (boxes.some((b) => obbOverlap(apBox, b))) continue;
    if (obbOverlap(apBox, twBox)) continue;

    // The apron deck follows the primary runway's plane at the ARP's own station
    // along the runway, which keeps the two hints from stepping apart.
    const along = relX * F.dx + relZ * F.dz;
    const y = F.deck(clamp(along, 0, F.lengthM));
    const corner = (l, w) => [
      _a.x + F.dx * l + F.rx * w,
      y,
      _a.z + F.dz * l + F.rz * w,
    ];
    pushQuad(
      hints,
      corner(-apHalfL, -apHalfW),
      corner(apHalfL, -apHalfW),
      corner(apHalfL, apHalfW),
      corner(-apHalfL, apHalfW),
      [-apHalfW / GRAIN_METRES, -apHalfL / GRAIN_METRES],
      [-apHalfW / GRAIN_METRES, apHalfL / GRAIN_METRES],
      [apHalfW / GRAIN_METRES, apHalfL / GRAIN_METRES],
      [apHalfW / GRAIN_METRES, -apHalfL / GRAIN_METRES],
    );
  }
}

/**
 * Release the GPU resources held by a group from buildRunwayMeshes().
 * @param {THREE.Group} group
 */
export function disposeRunwayMeshes(group) {
  if (!group) return;
  const seenMat = new Set();
  const seenTex = new Set();
  group.traverse((o) => {
    if (!o.geometry && !o.material) return;
    o.geometry?.dispose();
    const mats = Array.isArray(o.material) ? o.material : o.material ? [o.material] : [];
    for (const m of mats) {
      if (seenMat.has(m)) continue;
      seenMat.add(m);
      for (const key of ['map', 'alphaMap', 'emissiveMap']) {
        const t = m[key];
        if (t && !seenTex.has(t)) {
          seenTex.add(t);
          t.dispose();
        }
      }
      m.dispose();
    }
  });
  group.clear();
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
  return headingToVector(headingFromEndpoints(runway), out || { x: 0, z: 0 });
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
