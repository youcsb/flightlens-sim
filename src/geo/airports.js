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
 * HEIGHT: THE DECK IS A GUIDE PLANE, AND THE DEM WINS EVERY ARGUMENT
 * ---------------------------------------------------------------------------
 * A real runway is graded: flat across, and at most about 1.5% along. Draping
 * one over a 13-52 m/pixel DEM would give it a wave you can feel on the landing
 * roll. So each runway gets a least-squares LINE fitted to the DEM along its own
 * centreline (see fitRunwayPlane), clamped to a believable gradient.
 *
 * That line is a FLOOR, not a placement. MODULES.md §1.4 is absolute: the
 * collision surface is elevation.getElevationLocal(), NOT this mesh. Lift the
 * deck 1 m to make it look flat and the aircraft lands 1 m underneath it — and
 * with gearHeightM at 1.20 m, that is most of the main gear inside the tarmac
 * before the pilot has touched anything.
 *
 * ROUND 2 SHIPPED EXACTLY THAT AND EVERY GATE WAS GREEN. The deck used to be
 * raised by ONE GLOBAL LIFT, `clamp(maxAbove + 0.25, 0.25, 2.5)`, where
 * `maxAbove` was the worst DEM bump ANYWHERE under the pavement — so one hump
 * at one threshold floated the entire ribbon. Measured on the shipping meshes:
 * KBFI 14R/32L floated a mean of 0.88 m and the spawn itself 0.83 m. Nothing
 * measured it, because the number MODULES.md quoted ("KBFI: 2.4 cm") is the
 * deck BEND — how far the deck departs from its own plane — which is a
 * different statistic about a different thing.
 *
 * The deck is now, at every 25 m station along the runway and every offset
 * across it,
 *
 *     deck(t, s) = max( cross(t, s),  plane(t) if the DEM is not a runway )
 *                  + MIN_LIFT_M
 *
 * where `cross` is the lowest gently-tilted line through the pavement's own
 * cross-section that still clears every DEM sample on it, smoothed along the
 * runway (see buildDeckProfile). Three consequences:
 *
 *   - The float is MIN_LIFT_M plus the cross-section's own residual, instead of
 *     the worst bump on the runway plus the plane's distance from the ground.
 *     Measured at the spawn: 0.83 m -> 0.32 m.
 *   - A runway cut into a side slope tilts with it, up to MAX_CROSS_GRADE,
 *     rather than levelling at its uphill edge and floating over the downhill
 *     one.
 *   - The fitted plane survives for one case only: PAVED ground whose DEM is
 *     too rough to be a runway at all, which means the airport's earthworks are
 *     missing from the data. KSEA 16R/34L stands on 50 m of 2004 fill over the
 *     Miller Creek valley; the fill is real and the DEM's ravine is real, and
 *     no deck can be flush with both. That case is not hidden: the deck holds
 *     its plane, the shoulder SKIRTS down to the terrain and draws the
 *     retaining wall that is actually there, and `buildRunwayMeshes` publishes
 *     the standing height in `userData.standingDecks` and warns on the console.
 *
 * `npm run check:airports` is the assertion that keeps this honest. It runs
 * this module's real builder against the real DEM and samples the built
 * TRIANGLES against getElevationLocal.
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
 * Clearance between the drawn pavement and the highest DEM sample under it.
 *
 * This is the ONLY deliberate float in the deck, and it is deliberately small:
 * `gearHeightM` is 1.20 m, so every centimetre here is a centimetre of tyre
 * inside the tarmac. It cannot be zero — the drawn surface is linear between
 * stations and the field is not, so a deck sitting exactly on its samples would
 * let the terrain saw through the pavement between them. 25 cm covers that at
 * a 25 m station over a 12.95 m/px DEM and is 21% of a gear leg. Asserted by
 * `npm run check:airports`.
 */
const MIN_LIFT_M = 0.25;

/**
 * Steepest cross-fall the deck may take to follow a side slope.
 *
 * FAA AC 150/5300-13 caps transverse runway grade at 1.5% (2% for the smallest
 * strips), so this is the real design limit and not a tuning knob. It matters
 * because the alternative to tilting is levelling at the uphill edge: on a
 * 40 m wide runway a 2% cross-fall is 0.8 m of float at the far edge, which is
 * two thirds of a gear leg for nothing.
 */
const MAX_CROSS_GRADE = 0.02;

/** Clearance for the shoulder skirt where it lands on the terrain. */
const SHOULDER_CLEAR_M = 0.06;

/**
 * How far a shoulder may climb ABOVE its runway's edge to cover ground that
 * stands higher than the deck. Past this the runway is in a cutting, not on a
 * shoulder, and a paved ramp up the hillside would be a worse lie than letting
 * the hillside meet the pavement edge.
 */
const SHOULDER_RISE_MAX_M = 2.5;

/** Clearance for the taxiway and apron hints, which conform to the DEM. */
const HINT_LIFT_M = 0.2;

/**
 * The deepest hollow the deck may bridge before it follows the ground down.
 *
 * This is the ceiling on the float of every runway that is not a reconstructed
 * earthwork: the deck can never be more than MAX_FILL_M + MIN_LIFT_M above what
 * its own cross-sections asked for. 2.5 m keeps every real threshold in the
 * region (KSEA 16L/34R's south end is the deepest at 2.4 m) and stops a DEM
 * gully under a farm strip from becoming a viaduct. Asserted region-wide by
 * `npm run check:airports`.
 */
const MAX_FILL_M = 2.5;

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
 *     an airport here. What to do then depends on whether there is an airport:
 *     see DRAPE below.
 *   - straight but steeper than MAX_GRADE -> the DEM disagrees with a real
 *     runway's grade, which usually means a 52 m/px base tile has smoothed a
 *     graded strip back into the hillside it was cut from. FOLLOW THE DEM. A
 *     ribbon lying flush on the wrong slope beats a correctly-graded ribbon
 *     floating 20 m over the ground the aircraft will actually touch
 *     (MODULES.md §1.4), and the clamp is only ever relaxed by as much as the
 *     terrain demands.
 *
 * DRAPE: WHEN A PLANE IS THE WRONG SHAPE ENTIRELY.
 * Levelling rough ground at its median is only right if something was actually
 * levelled there. On a PAVED runway it was — a graded structure exists whether
 * or not the bare-earth DEM contains it, and KSEA 16R/34L is the example the
 * whole project argues about: 50 m of 2004 fill across the Miller Creek valley,
 * which is real and which 3DEP does not have. On a mown turf strip nothing was
 * levelled: the strip IS the field, and half of these are 'synthesised'
 * endpoints anyway. Levelling those gave WA45 16/34 a deck standing 27.8 m over
 * its own hillside — a grass bridge to nowhere. Unpaved plus a fit that failed
 * means the deck drapes on the ground instead, and comes out flush.
 *
 * WHAT THIS FUNCTION DOES NOT DO ANY MORE: lift the deck. It used to return
 * `clamp(maxAbove + MIN_LIFT_M, MIN_LIFT_M, MAX_LIFT_M)` — the worst bump
 * anywhere under the pavement, applied to the whole ribbon. That is a global
 * answer to a local question and it cost 0.83 m of float at the spawn itself.
 * The plane is now a floor and the clearance is applied per station, across the
 * width, in buildDeckProfile. `maxAboveM` survives as a DIAGNOSTIC only: it is
 * how far the raw plane is buried at its worst point, which is the honest
 * measure of how badly the DEM disagrees with the airport's earthworks.
 *
 * @param {number} ax @param {number} az le end, local metres
 * @param {number} dx @param {number} dz unit vector along the runway
 * @param {number} rx @param {number} rz unit vector across the runway (right)
 * @param {number} lengthM @param {number} widthM
 * @param {boolean} paved Whether a graded structure exists to be levelled.
 * @returns {{h0:number, slope:number, maxAboveM:number, rms:number,
 *            graded:boolean, drape:boolean}}
 *          `graded` is false when the deck had to follow the terrain instead of
 *          holding a believable runway gradient; `drape` is true when no plane
 *          should be held at all.
 */
function fitRunwayPlane(ax, az, dx, dz, rx, rz, lengthM, widthM, paved) {
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
  const rough = rawRms > ROUGH_RMS_M;
  const drape = rough && !paved;
  if (rough) {
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
  return { h0, slope, maxAboveM: maxAbove, rms, graded, drape, rough };
}

/**
 * Build the surface the runway deck is actually drawn on.
 *
 * ---------------------------------------------------------------------------
 * THE DECK IS A SURFACE, NOT A PLANE AND NOT A CURVE
 * ---------------------------------------------------------------------------
 * Round 2 drew it as `max(plane(t) + lift, maxTerrainAcross(t) + MIN_LIFT_M)`,
 * with `lift` a single number for the whole runway. Both halves of that leaked
 * float into the picture:
 *
 *   - the GLOBAL lift meant the worst DEM bump anywhere under the pavement
 *     raised every square metre of it. KBFI 14R/32L came out a mean 0.88 m
 *     above the collision surface and the spawn 0.83 m, against a 1.20 m gear;
 *   - `maxTerrainAcross` levelled every cross-section at its highest sample, so
 *     a runway on a side slope floated over its own downhill edge by the full
 *     fall across the width.
 *
 * Now, per station and across the width,
 *
 *     deck(t, s) = max( cross(t, s),  plane(t) where a plane is warranted )
 *                  + MIN_LIFT_M
 *
 * `cross(t, s) = c + m*s` is the lowest line through the cross-section that
 * still clears every DEM sample on the pavement, with `m` the least-squares
 * cross-fall clamped to MAX_CROSS_GRADE (a real FAA design limit, so the deck
 * cannot tilt into something no runway would be built as). Anchoring `c` at
 * `max_k(e_k - m*s_k)` rather than at the mean is what makes the clearance a
 * guarantee: every sample on the section is under the line by construction, so
 * the pavement never has terrain sawing through it.
 *
 * A PLANE IS WARRANTED IN ONE CASE. The ground under a real runway IS the
 * runway — it was graded, and the DEM measured the result — so following it is
 * both the flush answer and the accurate one. The exception is PAVED ground
 * whose DEM is too rough to be a runway at all (`fit.rough`): there the
 * earthworks are missing from the data, and the fitted plane is the best
 * available reconstruction of a structure that exists. Holding a plane anywhere
 * else costs float and buys nothing — it was worth up to 0.71 m mid-runway at
 * KBFI, where the DEM is flat for two kilometres and then ramps, and no
 * straight line is both.
 *
 * ---------------------------------------------------------------------------
 * WHEN THE DECK STILL STANDS PROUD, AND WHY THAT IS THE DEM SPEAKING
 * ---------------------------------------------------------------------------
 * KSEA 16R/34L is the region's honest failure. It stands on up to 50 m of fill
 * placed over the Miller Creek valley in 2004-08; 3DEP's bare-earth DEM has the
 * valley and not the fill. No deck can be both flush with that ravine and
 * straight enough to land on. The deck holds its plane, `standM` records how
 * far it stands above the field, `buildRunwayMeshes` skirts the shoulder down
 * to the terrain so the embankment is DRAWN rather than implied, and
 * `npm run check:airports` asserts the number instead of letting it hide.
 *
 * @returns {{sample:(t:number, s:number)=>number, segs:number, stepM:number,
 *            standM:number, crossFallMax:number}}
 *          `standM` is the worst gap between the drawn deck and what its own
 *          cross-sections asked for — the float, before MIN_LIFT_M.
 */
function buildDeckProfile(ax, az, dx, dz, rx, rz, lengthM, widthM, fit) {
  /** Station spacing. Fine enough that the linear span between two stations
   *  cannot hide a hill the samples missed. */
  const STEP_M = 25;
  /** Samples across the pavement. Odd, so one of them is the centreline. */
  const ACROSS = 5;
  const n = clamp(Math.round(lengthM / STEP_M) + 1, 5, 256);
  const step = lengthM / (n - 1);
  const half = widthM / 2;
  /** Deck height on the centreline, per station. */
  const hs = new Float64Array(n);

  let standM = 0;

  const ss = new Float64Array(ACROSS);
  const es = new Float64Array(ACROSS);
  for (let k = 0; k < ACROSS; k++) ss[k] = ((k / (ACROSS - 1)) * 2 - 1) * half;
  let sumS2 = 0;
  for (let k = 0; k < ACROSS; k++) sumS2 += ss[k] * ss[k];

  // --- Pass 1: the cross-fall, ONE number for the whole runway.
  //
  // It is one number on purpose, and the reason is geometric rather than
  // aesthetic. A cross-fall that changes from station to station makes every
  // pavement quad a TWISTED bilinear patch, and a twisted patch is not the
  // surface `sample()` reports: the two disagree by the twist in the middle of
  // the quad, which is where the centreline stripe and the rubber are. Measured
  // with a per-station cross-fall, 119 marking triangles at KSEA sank into
  // their own asphalt, the worst by 0.53 m. With `h` linear along each span and
  // `m` constant, every quad is planar and the paint lands exactly where the
  // pavement is.
  //
  // A real runway is built with one transverse grade per section anyway
  // (AC 150/5300-13), so this is also the more accurate shape.
  const perStation = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const t = i * step;
    let sumE = 0;
    for (let k = 0; k < ACROSS; k++) {
      es[k] = getElevationLocal(ax + dx * t + rx * ss[k], az + dz * t + rz * ss[k]);
      sumE += es[k];
    }
    const meanE = sumE / ACROSS;
    let num = 0;
    for (let k = 0; k < ACROSS; k++) num += ss[k] * (es[k] - meanE);
    perStation[i] = sumS2 > 0 ? num / sumS2 : 0;
  }
  // The MEDIAN, not the mean: a few stations crossing a taxiway or a ditch
  // should not tilt the whole ribbon.
  const sortedFall = Array.from(perStation).sort((p, q) => p - q);
  const crossFall = clamp(
    sortedFall[sortedFall.length >> 1] || 0,
    -MAX_CROSS_GRADE,
    MAX_CROSS_GRADE,
  );

  // --- Pass 2: what each cross-section requires under that cross-fall.
  /** Centreline height the section needs, per station. */
  const cs = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const t = i * step;
    // Anchor the tilted line so that every sample on the section is under it.
    let c = -Infinity;
    for (let k = 0; k < ACROSS; k++) {
      const e = getElevationLocal(ax + dx * t + rx * ss[k], az + dz * t + rz * ss[k]);
      const v = e - crossFall * ss[k];
      if (v > c) c = v;
    }
    cs[i] = c;
  }

  // --- Pass 3: take the quantisation stairs out of the longitudinal profile.
  //
  // The DEM under a runway IS the runway, so the deck follows it. But elevation
  // is stored in quarter-metre Int16 (§2.4) and `cs` is a max over five
  // samples, so the profile arrives as a staircase: 6.25, 6.39, 6.42, 6.50,
  // 6.25 over the last hundred metres of KBFI 14R/32L. One binomial [1 2 1]
  // pass rounds the treads.
  //
  // IT RUNS ON THE DETRENDED PROFILE. Smoothing has to clamp at the two ends,
  // and clamping on a SLOPED profile drags the threshold toward the interior's
  // height — the spawn sits exactly on a threshold, so that bias lands on the
  // one point in the sim that is looked at most. Subtracting the mean gradient
  // first makes a constant-grade runway come out bit-identical, and the
  // gradient goes straight back on afterwards.
  //
  // ONE PASS, AND NOT MORE, IS MEASURED. Every extra pass is more float: two
  // passes cost 0.03 m at the spawn and 0.16 m at KSEA 16C's worst point, and
  // a wider window costs far more than that (a ±150 m morphological closing,
  // tried and dropped, cost 0.27 m at the spawn and put fourteen paved runways
  // over half a metre instead of one). The stairs are 0.25 m over 25 m, which
  // is 0.6 degrees of surface tilt; the float is what the wheels feel.
  let sumT = 0, sumC = 0;
  for (let i = 0; i < n; i++) { sumT += i * step; sumC += cs[i]; }
  const meanT = sumT / n, meanC = sumC / n;
  let numT = 0, denT = 0;
  for (let i = 0; i < n; i++) {
    const dt = i * step - meanT;
    numT += dt * (cs[i] - meanC);
    denT += dt * dt;
  }
  const trendB = denT > 0 ? numT / denT : 0;
  const trendA = meanC - trendB * meanT;
  const trend = (i) => trendA + trendB * i * step;

  const smooth = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const a = cs[Math.max(0, i - 1)] - trend(Math.max(0, i - 1));
    const b = cs[i] - trend(i);
    const c2 = cs[Math.min(n - 1, i + 1)] - trend(Math.min(n - 1, i + 1));
    smooth[i] = (a + 2 * b + c2) / 4 + trend(i);
  }

  // --- Pass 4: the floor, and what the deck ends up being.
  //
  // The fitted plane is a floor for exactly one case: PAVED ground whose DEM is
  // too rough to be a runway at all. That is the missing-earthworks case — KSEA
  // 16R/34L on the Miller Creek fill — where a graded structure exists that the
  // bare-earth DEM does not contain, and reconstructing it as a plane is the
  // best available answer. Everywhere else the ground under a runway IS the
  // runway, and the deck lies on it.
  const useplane = !fit.drape && fit.rough;
  for (let i = 0; i < n; i++) {
    const t = i * step;
    // Smoothing fills a hollow; it does not build a viaduct. A single deep,
    // narrow DEM ditch — a farm strip crossing a gully — would otherwise pull
    // its neighbours' deck up with it, so the fill is capped and the deck
    // follows the ground down instead.
    const graded = clamp(smooth[i], cs[i], cs[i] + MAX_FILL_M);
    const plane = useplane ? fit.h0 + fit.slope * t : -Infinity;
    // The reconstructed plane stands above the ground it covers where the DEM
    // has no earthworks; elsewhere the deck lies on the graded ground.
    hs[i] = Math.max(graded, plane) + MIN_LIFT_M;
    // How far the drawn deck stands above what its own cross-sections asked
    // for. This is the number that decides whether the wheels meet the paint.
    const stand = hs[i] - MIN_LIFT_M - cs[i];
    if (stand > standM) standM = stand;
  }

  const sample = (t, s = 0) => {
    const u = clamp(t / step, 0, n - 1);
    const i = Math.min(n - 2, Math.floor(u));
    const f = u - i;
    return hs[i] + (hs[i + 1] - hs[i]) * f + crossFall * s;
  };

  // A deck that follows the ground needs a vertex per station or the pavement
  // cuts the corner off its own profile. One that came out affine — a plane,
  // which is what the missing-earthworks case reconstructs — needs no more
  // geometry than it ever did.
  let affine = true;
  for (let i = 1; i < n - 1 && affine; i++) {
    const lin = hs[0] + ((hs[n - 1] - hs[0]) * i) / (n - 1);
    if (Math.abs(hs[i] - lin) > 1e-6) affine = false;
  }
  const segs = affine
    ? clamp(Math.round(lengthM / 120), 1, 48)
    : n - 1;

  return { sample, segs, stepM: step, standM, crossFall };
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
 *
 * Normals are +Y by default, because pavement is flat by construction and a
 * constant is cheaper than a cross product. The SHOULDER is the exception: it
 * skirts from the deck down to the terrain, so on KSEA 16R/34L it is a 30 m
 * near-vertical wall, and a wall with an up-facing normal is lit like a floor.
 * `shaded` computes real ones. No vertex is shared between quads in a sink, so
 * this comes out per-face — which is what a retaining wall's top edge should
 * look like.
 */
function sinkToGeometry(sink, shaded = false) {
  if (sink.n === 0) return null;
  const g = new THREE.BufferGeometry();
  const pos = new Float32Array(sink.pos);
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(sink.uv), 2));
  g.setIndex(sink.n > 65535 ? new THREE.Uint32BufferAttribute(sink.idx, 1)
                            : new THREE.Uint16BufferAttribute(sink.idx, 1));
  if (shaded) {
    g.computeVertexNormals();
  } else {
    const normals = new Float32Array(sink.n * 3);
    for (let i = 0; i < sink.n; i++) normals[i * 3 + 1] = 1;
    g.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  }
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
function paintEnd(at, usable, widthM, displacedM, ident, sinks, cellFor, breaks = null) {
  const { paint, numbers } = sinks;
  const half = widthM / 2;
  const full = usable >= FULL_MARKINGS_MIN_M;
  // Break every bar at the deck's own stations — see stationsBetween() in
  // buildRunwayMeshes. A threshold bar is 150 ft, six times a station, and the
  // deck bends at those stations; a single quad is a chord across all of them
  // and PAINT_LIFT_M is 2 cm.
  const bar = (u0, u1, s0, s1) => {
    const us = breaks ? breaks(u0, u1) : [u0, u1];
    for (let i = 0; i < us.length - 1; i++) {
      pushQuad(
        paint,
        at(us[i], s0), at(us[i + 1], s0), at(us[i + 1], s1), at(us[i], s1),
        [0, 0], [1, 0], [1, 1], [0, 1],
      );
    }
  };

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
        pushGlyph(numbers, at, u, u + numH, -lw, lw, letterCell, breaks);
        u += numH + NUMERAL_GAP_FT * FT_TO_M * scale;
      }
      const cell = cellFor(digits);
      if (cell) pushGlyph(numbers, at, u, u + numH, -numW, numW, cell, breaks);
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
      bar(-displacedM + 6, -22, s - shaftW / 2, s + shaftW / 2);
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
function pushGlyph(sink, at, u0, u1, s0, s1, cell, breaks = null) {
  const [cu0, cv0, cu1, cv1] = cell;
  // A 60 ft numeral is two and a half deck stations long, so it is broken at
  // them like every other marking, with the atlas cell's u interpolated across
  // the pieces. Without this the middle of a "16" disappears into the asphalt
  // wherever the deck bends.
  const us = breaks ? breaks(u0, u1) : [u0, u1];
  for (let i = 0; i < us.length - 1; i++) {
    const f0 = (us[i] - u0) / (u1 - u0);
    const f1 = (us[i + 1] - u0) / (u1 - u0);
    const a0 = cu0 + (cu1 - cu0) * f0;
    const a1 = cu0 + (cu1 - cu0) * f1;
    pushQuad(
      sink,
      at(us[i], s0), at(us[i + 1], s0), at(us[i + 1], s1), at(us[i], s1),
      [a0, cv0], [a0, cv1], [a1, cv1], [a1, cv0],
    );
  }
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

  /** Decks left standing above the field. This is the one that matters. */
  const standingDecks = [];

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
    const surf = SURFACES[cls] || SURFACES.unknown;
    // `paint` is this module's paved/unpaved split: asphalt and concrete carry
    // markings, turf and gravel do not. It is also the right test for whether
    // anything was ever graded here — see fitRunwayPlane's DRAPE note.
    const fit = fitRunwayPlane(ax, az, dx, dz, rx, rz, lengthM, widthM, surf.paint);
    // The deck follows the plane wherever the plane clears the ground, and
    // rises to stay flush wherever the DEM disagrees with the real earthworks.
    // Identical to the bare plane for every runway that did not need it.
    const prof = buildDeckProfile(ax, az, dx, dz, rx, rz, lengthM, widthM, fit);
    const deck = prof.sample;
    if (prof.standM > DECK_STAND_WARN_M) {
      standingDecks.push({
        ident: airport.ident,
        runway: `${rw.leIdent}/${rw.heIdent}`,
        standM: prof.standM,
      });
    }

    /** Runway-local (t, s) -> scene point, on the pavement. */
    const at = (t, s, dy = 0) => [
      ax + dx * t + rx * s,
      deck(t, s) + dy,
      az + dz * t + rz * s,
    ];

    /**
     * The deck's own station boundaries between t0 and t1, inclusive of both.
     *
     * ALIGNMENT, NOT JUST SUBDIVISION. The deck is piecewise linear with kinks
     * at its stations, and the pavement is drawn with vertices there. A marking
     * subdivided into its own equal spans has kinks somewhere else, so the two
     * chords disagree wherever the deck bends — at KSEA 16R/34L, where the deck
     * steps 5 m in one station to stay on the embankment, an 18 m stripe
     * segment sank 0.53 m into 25 m pavement quads. Breaking the paint at the
     * SAME stations makes both surfaces the same piecewise-linear function.
     */
    const stationsBetween = (t0, t1) => {
      const out = [t0];
      const lo = Math.min(t0, t1);
      const hi = Math.max(t0, t1);
      const first = Math.ceil(lo / prof.stepM);
      const last = Math.floor(hi / prof.stepM);
      const mid = [];
      for (let k = first; k <= last; k++) {
        const t = k * prof.stepM;
        if (t > lo + 1e-6 && t < hi - 1e-6) mid.push(t);
      }
      if (t1 < t0) mid.reverse();
      out.push(...mid, t1);
      return out;
    };

    /** Push a long marking as a chain of quads broken at the deck's stations. */
    const stripe = (sink, t0, t1, sA, sB, dy) => {
      const ts = stationsBetween(t0, t1);
      for (let i = 0; i < ts.length - 1; i++) {
        const u0 = ts[i];
        const u1 = ts[i + 1];
        const v0 = i / (ts.length - 1);
        const v1 = (i + 1) / (ts.length - 1);
        pushQuad(
          sink,
          at(u0, sA, dy), at(u1, sA, dy), at(u1, sB, dy), at(u0, sB, dy),
          [0, v0], [1, v0], [1, v1], [0, v1],
        );
      }
    };

    const half = widthM / 2;

    // --- Pavement. Segmented along its length so the fitted gradient is real
    // geometry rather than a single tilted quad (identical for a straight line,
    // but it keeps the vertex density sane for lighting). A deck that had to
    // conform to the terrain gets a vertex per profile station instead.
    // Split at the centreline. The deck has a cross-fall, so a quad spanning
    // the full width is a bilinear patch whose triangulated middle is NOT the
    // surface `deck()` reports — and the middle is exactly where the aeroplane
    // and the centreline stripe are. With a row of vertices at s = 0 the
    // centreline is exact by construction.
    const segs = prof.segs;
    const pav = sinkFor(cls);
    for (let i = 0; i < segs; i++) {
      const t0 = (i / segs) * lengthM;
      const t1 = ((i + 1) / segs) * lengthM;
      for (const [sa, sb] of [[-half, 0], [0, half]]) {
        pushQuad(
          pav,
          at(t0, sa), at(t1, sa), at(t1, sb), at(t0, sb),
          [sa / GRAIN_METRES, t0 / GRAIN_METRES],
          [sa / GRAIN_METRES, t1 / GRAIN_METRES],
          [sb / GRAIN_METRES, t1 / GRAIN_METRES],
          [sb / GRAIN_METRES, t0 / GRAIN_METRES],
        );
      }
    }

    // --- Paved shoulder, and the SKIRT that lands it on the ground.
    //
    // The shoulder used to be drawn flat at the deck height, which made it a
    // second float rather than a cover: 74 of its vertices at KSEA were BELOW
    // the collision surface (terrain poking through the paving) and the ones
    // over the 16R embankment stood 33 m in the air with nothing under them.
    //
    // Its outer edge now sits on the terrain. Where the deck is flush that is a
    // few centimetres of fall and the shoulder looks exactly as it did; where
    // the deck genuinely stands proud — KSEA 16R/34L on 50 m of Miller Creek
    // fill — the same quads become the retaining wall that is actually there,
    // which is what MODULES.md §2.5 asks for and what "the DEM is the collision
    // surface" looks like when you draw it honestly. It is capped on the way UP
    // (SHOULDER_RISE_MAX_M): a runway in a cutting gets a shoulder that meets
    // the hillside, not a paved ramp climbing it.
    if (surf.paint && lengthM >= FULL_MARKINGS_MIN_M) {
      const sh = Math.min(7.5, widthM * 0.25);
      const shoulder = sinkFor('shoulder');
      // Always at station resolution: the skirt follows the ground, and the
      // ground does not care how flat the runway is.
      const ssegs = Math.max(segs, Math.ceil(lengthM / prof.stepM));
      /** Outer-edge point: on the terrain, clamped so it stays a shoulder. */
      const rim = (t, s) => {
        const x = ax + dx * t + rx * s;
        const z = az + dz * t + rz * s;
        const edge = deck(t, s);
        const y = Math.min(
          getElevationLocal(x, z) + SHOULDER_CLEAR_M,
          edge + SHOULDER_RISE_MAX_M,
        );
        return [x, y, z];
      };
      for (const sgn of [-1, 1]) {
        for (let i = 0; i < ssegs; i++) {
          const t0 = (i / ssegs) * lengthM;
          const t1 = ((i + 1) / ssegs) * lengthM;
          const sIn = sgn * half;
          const sOut = sgn * (half + sh);
          // Winding follows the sign: for sgn = -1 the outer edge is the LOW s,
          // which is the same swap the old min/max did.
          const A = sgn > 0 ? at(t0, sIn) : rim(t0, sOut);
          const B = sgn > 0 ? at(t1, sIn) : rim(t1, sOut);
          const Cc = sgn > 0 ? rim(t1, sOut) : at(t1, sIn);
          const D = sgn > 0 ? rim(t0, sOut) : at(t0, sIn);
          const lo = Math.min(sIn, sOut);
          const hi = Math.max(sIn, sOut);
          pushQuad(
            shoulder,
            A, B, Cc, D,
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
        stripe(paint, t, t + on, -clW, clW, PAINT_LIFT_M);
      }

      // Edge stripes, paved runways wide enough to have them.
      if (lengthM >= FULL_MARKINGS_MIN_M && widthM >= 22) {
        const ew = 0.9;
        const inner = half - 0.6 - ew;
        for (const sgn of [-1, 1]) {
          const s0 = sgn > 0 ? inner : -inner - ew;
          stripe(paint, 0, lengthM, s0, s0 + ew, PAINT_LIFT_M);
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
        // u runs forward from the low threshold: t = leDisp + u.
        (u0, u1) => stationsBetween(leDisp + u0, leDisp + u1).map((t) => t - leDisp),
      );
      paintEnd(
        (u, s) => at(lengthM - heDisp - u, -s, PAINT_LIFT_M),
        usable, widthM, heDisp, rw.heIdent, { paint, numbers }, cellFor,
        // and backward from the high one: t = lengthM - heDisp - u.
        (u0, u1) =>
          stationsBetween(lengthM - heDisp - u0, lengthM - heDisp - u1).map(
            (t) => lengthM - heDisp - t,
          ),
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
          stripe(rubber, t0, t1, -half * 0.85, half * 0.85, PAINT_LIFT_M * 0.5);
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
    // Measured on the DECK AS DRAWN, not on the plane it was fitted to — the
    // two are different surfaces now and quoting one for the other is exactly
    // the mistake that let a metre of float ship (see the header).
    let surveyErrM = null;
    if (Number.isFinite(rw.leElevationFt) && Number.isFinite(rw.heElevationFt)) {
      const eLe = deck(0, 0) - rw.leElevationFt * FT_TO_M;
      const eHe = deck(lengthM, 0) - rw.heElevationFt * FT_TO_M;
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
      /** Worst DEM bump under the raw plane. Diagnostic — no longer a lift. */
      maxAboveM: fit.maxAboveM,
      /** How far the drawn deck stands above the field where it is flat. */
      standM: prof.standM,
      crossFall: prof.crossFall,
      fitRmsM: fit.rms,
      graded: fit.graded,
      surveyErrM,
      geometry: rw.geometry,
      surfaceClass: cls,
    });

    // Remember the frame for the taxiway/apron pass.
    rw.__frame = { ax, az, dx, dz, rx, rz, lengthM, widthM, cls };
  }

  buildFieldHints(drawable, hints, hintPaint, lightPos, lightCol);
  for (const { rw } of drawable) delete rw.__frame;

  // -------------------------------------------------------------------------
  // Materials and meshes
  // -------------------------------------------------------------------------
  const grainCache = new Map();
  const addMesh = (sink, material, name, shaded = false) => {
    const g = sinkToGeometry(sink, shaded);
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
      cls === 'shoulder',
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

  group.userData = {
    runways: meta,
    count: meta.length,
    standingDecks,
  };
  reportDeckFit(meta);
  // The float is the number acceptance check 6 is about, so it is the one the
  // console leads with. A bend is the deck following the ground and is fine; a
  // STAND is pavement with air under it, which is where the wheels go through.
  if (standingDecks.length) {
    const worst = standingDecks.slice().sort((a, b) => b.standM - a.standM).slice(0, 5);
    console.warn(
      `[airports] ${standingDecks.length} deck(s) stand more than ` +
        `${DECK_STAND_WARN_M} m above the collision surface — the DEM does not ` +
        'contain those earthworks, and the shoulder is skirted down to draw them: ' +
        worst.map((d) => `${d.ident} ${d.runway} +${d.standM.toFixed(1)} m`).join(', ') +
        (standingDecks.length > worst.length ? `, +${standingDecks.length - worst.length} more` : ''),
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
 * How far the drawn deck may stand above the collision surface before it is
 * worth saying so.
 *
 * 1 m because `gearHeightM` is 1.20 m: past this, a landing aircraft's wheels
 * are inside the pavement it is being shown. Everything above this threshold in
 * this region is one real thing — an airport earthwork the bare-earth DEM does
 * not contain — and it is reported per runway rather than averaged away.
 */
const DECK_STAND_WARN_M = 1;

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

    // A hint is drawn 130 m off the runway, where the runway's own deck has no
    // authority at all — following it put the taxiway metres into the air on
    // any field with a slope. Hints conform to the DEM directly: their whole
    // job is to look like pavement lying on the ground.
    const groundAt = (x, z) => {
      let h = -Infinity;
      for (let k = -1; k <= 1; k++) {
        for (let j = -1; j <= 1; j++) {
          const e = getElevationLocal(x + k * 8, z + j * 8);
          if (e > h) h = e;
        }
      }
      return h + HINT_LIFT_M;
    };
    const at = (t, s, dy = 0) => {
      const x = F.ax + F.dx * t + F.rx * s;
      const z = F.az + F.dz * t + F.rz * s;
      return [x, groundAt(x, z) + dy, z];
    };

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
      // 25 m stations, matching the runway deck: a strip that conforms to the
      // ground needs vertices where the ground changes, not every 120 m.
      const segs = clamp(Math.round((t1 - t0) / 25), 1, 200);
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
      // Continuous yellow taxiway centreline, in the same stations as the
      // pavement under it — one long quad would be a chord over every one.
      for (let i = 0; i < segs; i++) {
        const u0 = t0 + ((t1 - t0) * i) / segs;
        const u1 = t0 + ((t1 - t0) * (i + 1)) / segs;
        pushQuad(
          hintPaint,
          at(u0, twOffset - 0.075, PAINT_LIFT_M),
          at(u1, twOffset - 0.075, PAINT_LIFT_M),
          at(u1, twOffset + 0.075, PAINT_LIFT_M),
          at(u0, twOffset + 0.075, PAINT_LIFT_M),
          [0, 0], [1, 0], [1, 1], [0, 1],
        );
      }
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

    // The apron is a 460 x 280 m slab. Drawn at one height — it used to take
    // the primary runway's deck at the ARP's station — it is flat by
    // construction and the ground is not, so at KPAE it stood 9 m up at one
    // corner and was buried at the other. It conforms on a 25 m lattice
    // instead, on the same sampler as everything else.
    const apRows = Math.max(2, Math.round((apHalfL * 2) / 25));
    const apCols = Math.max(2, Math.round((apHalfW * 2) / 25));
    const corner = (l, w) => {
      const x = _a.x + F.dx * l + F.rx * w;
      const z = _a.z + F.dz * l + F.rz * w;
      return [x, groundAt(x, z), z];
    };
    for (let i = 0; i < apRows; i++) {
      const l0 = -apHalfL + (2 * apHalfL * i) / apRows;
      const l1 = -apHalfL + (2 * apHalfL * (i + 1)) / apRows;
      for (let j = 0; j < apCols; j++) {
        const w0 = -apHalfW + (2 * apHalfW * j) / apCols;
        const w1 = -apHalfW + (2 * apHalfW * (j + 1)) / apCols;
        pushQuad(
          hints,
          corner(l0, w0), corner(l1, w0), corner(l1, w1), corner(l0, w1),
          [w0 / GRAIN_METRES, l0 / GRAIN_METRES],
          [w0 / GRAIN_METRES, l1 / GRAIN_METRES],
          [w1 / GRAIN_METRES, l1 / GRAIN_METRES],
          [w1 / GRAIN_METRES, l0 / GRAIN_METRES],
        );
      }
    }
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
