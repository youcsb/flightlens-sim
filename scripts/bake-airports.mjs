/**
 * bake-airports.mjs — regional airport + runway subset from OurAirports.
 *
 * STATUS: SKELETON. Fetch, parse and output are specified; the transform is
 * marked TODO. Every gotcha below was found by probing the live data, not
 * guessed — read them before writing the transform.
 *
 *   node scripts/bake-airports.mjs
 *
 * ---------------------------------------------------------------------------
 * SOURCE
 * ---------------------------------------------------------------------------
 *   https://davidmegginson.github.io/ourairports-data/airports.csv  (~13 MB)
 *   https://davidmegginson.github.io/ourairports-data/runways.csv
 * Public domain. Sends access-control-allow-origin: *, so it COULD be fetched
 * from the browser — but 13 MB to every client to use 0.3% of it is absurd, so
 * we bake a regional subset.
 *
 * Measured for our bbox: 266 airports (1 large, 8 medium, 98 small,
 * 103 heliports, 10 seaplane bases, 46 closed) and 246 runways.
 *
 * ---------------------------------------------------------------------------
 * TRAP 1 — `le_heading_degT` IS OFTEN MAGNETIC, NOT TRUE
 * ---------------------------------------------------------------------------
 * KBFI runway 14R/32L is published with le_heading_degT = 140. Its own
 * published endpoints give a bearing of 150.13 degrees, and ~150 is correct:
 * Boeing Field's runway really is 150 true. 140 is the MAGNETIC heading
 * (150 true minus 15.6 degrees of easterly variation), rounded to the runway
 * number times ten. The column is simply wrong for a large share of rows.
 *
 * => Compute the heading FROM THE ENDPOINTS whenever both endpoints exist and
 *    the implied length agrees with length_ft (KBFI: 10013 computed vs 10007
 *    published — a 0.02% match). Only fall back to the column when there are no
 *    endpoints, and add MAG_VAR_DEG when doing so.
 *
 * ---------------------------------------------------------------------------
 * TRAP 2 — SOME ENDPOINTS ARE ROUNDED UNTIL THE RUNWAY IS AXIS-ALIGNED
 * ---------------------------------------------------------------------------
 * All three KSEA runways are published with le_longitude_deg exactly equal to
 * he_longitude_deg, which makes the computed bearing exactly 180.000. The real
 * runways are a few degrees off due south. The length check does NOT catch
 * this — the lengths match fine.
 *
 * => Airports we care about get a surveyed entry in OVERRIDES. Everything else
 *    is best-effort and honestly labelled via the `geometry` field.
 *
 * ---------------------------------------------------------------------------
 * TRAP 3 — MOST ROWS HAVE NO GEOMETRY AT ALL
 * ---------------------------------------------------------------------------
 * 200 of the 246 regional runways have no endpoint coordinates and 206 have no
 * heading. They are overwhelmingly heliports and closed strips.
 *
 * => Skip heliports and closed runways entirely. For a real runway with no
 *    endpoints, synthesise them from the airport reference point, length_ft and
 *    the runway NUMBER (le_ident "16" -> 160 magnetic -> 175.6 true), and mark
 *    geometry:'synthesised' so nothing downstream mistakes it for survey data.
 *
 * ---------------------------------------------------------------------------
 * OUTPUT CONTRACT — src/geo/airports.js depends on exactly this
 * ---------------------------------------------------------------------------
 * public/data/airports.json
 *   {
 *     "generated": "...",
 *     "source": "ourairports",
 *     "bbox": { ... },
 *     "airports": [
 *       {
 *         "ident": "KBFI",
 *         "name": "King County International Airport - Boeing Field",
 *         "lat": 47.527042, "lon": -122.29995,
 *         "elevationFt": 21,
 *         "type": "medium_airport",
 *         "municipality": "Seattle",
 *         "runways": [
 *           {
 *             "leIdent": "14R", "heIdent": "32L",
 *             "leLat": 47.540549, "leLon": -122.311372,
 *             "heLat": 47.516745, "heLon": -122.291252,
 *             "headingDeg": 150.13,
 *             "lengthFt": 10007, "widthFt": 200,
 *             "surface": "ASP", "lighted": true, "closed": false,
 *             "geometry": "surveyed"
 *           }
 *         ]
 *       }
 *     ]
 *   }
 *
 * Round coordinates to 6 decimals (~0.1 m) and headings to 2. Anything more is
 * noise that only inflates the file.
 *
 * INVARIANT: the KBFI 14R/32L endpoints must come out at 47.540549/-122.311372
 * and 47.516745/-122.291252, because src/geo/airports.js SPAWN carries the same
 * two points as its no-data fallback. Assert this at the end of the bake and
 * throw if it drifts.
 *
 * Note that `headingDeg` is derived, not hardcoded, in both places — it is
 * whatever bearingBetween() yields for those endpoints in the current
 * projection (150.13 as of this writing, with SCALE_LAT at the region centre).
 * Do not pin the heading to a literal anywhere: the runway MESH is drawn from
 * bearingBetween(), so a literal that drifts from it puts the spawning aircraft
 * off the centreline with no visible cause.
 */

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
} from './lib/util.mjs';

const AIRPORTS_CSV =
  'https://davidmegginson.github.io/ourairports-data/airports.csv';
const RUNWAYS_CSV =
  'https://davidmegginson.github.io/ourairports-data/runways.csv';

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
 * are not trustworthy and we fall back to synthesis.
 */
const LENGTH_TOLERANCE = 0.1;

/**
 * Surveyed corrections for airports whose published geometry is known bad.
 * Keyed by `${ident} ${leIdent}/${heIdent}`.
 *
 * DELIBERATELY EMPTY. KSEA belongs here — its three parallel runways all come
 * out at exactly 180.000 degrees from published endpoints (see TRAP 2) and the
 * true value is a few degrees less. Do not guess it: pull the real threshold
 * coordinates from an authoritative source (FAA airport diagram / NASR) and
 * cite it in a comment next to the entry. A confidently wrong number here is
 * worse than the current honest approximation, because the `geometry:'override'`
 * label claims it was surveyed.
 *
 * @type {Record<string, {leLat:number, leLon:number, heLat:number, heLon:number, source:string}>}
 */
const OVERRIDES = {};

async function main() {
  parseArgs();
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

  // TODO(GeoCore): build the output.
  //
  //  1. Index runways by airport_ref.
  //  2. For each regional airport, for each of its runways:
  //       - skip closed === "1"
  //       - if an OVERRIDES entry exists -> use it, geometry:'override'
  //       - else if both endpoints present:
  //           computedLen = distanceBetween(le, he)
  //           if |computedLen*3.28084 - length_ft| / length_ft <= LENGTH_TOLERANCE
  //             -> keep the endpoints, headingDeg = bearingBetween(le, he),
  //                geometry:'surveyed'
  //       - else synthesise:
  //           trueHdg = parseInt(le_ident) * 10 + MAG_VAR_DEG   (mod 360)
  //           place le/he symmetrically about the airport reference point,
  //           half of length_ft each way along trueHdg,
  //           geometry:'synthesised'
  //  3. Drop airports that end up with zero usable runways UNLESS they are
  //     seaplane bases (kept as markers).
  //  4. Round: coordinates 6 dp, heading 2 dp.
  //  5. Sort airports by ident so diffs stay readable.
  //  6. Assert the KBFI invariant from the header and throw if it fails.
  //
  void allRunways;
  void bearingBetween;
  void distanceBetween;
  void bool;
  void LENGTH_TOLERANCE;
  void MAG_VAR_DEG;
  void OVERRIDES;
  void writeJson;

  throw new Error(
    'bake-airports.mjs is a skeleton: the transform is not implemented yet. ' +
      'See the TODO in main().',
  );
}

main().catch((err) => {
  console.error(err.message);
  process.exitCode = 1;
});
