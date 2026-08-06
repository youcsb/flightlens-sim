/**
 * bake-landmarks.mjs — landmark coordinates from Wikidata.
 *
 * STATUS: SKELETON. The query, the curated Q-ID table and the output contract
 * are done; the transform is marked TODO.
 *
 *   node scripts/bake-landmarks.mjs
 *
 * ---------------------------------------------------------------------------
 * SOURCE
 * ---------------------------------------------------------------------------
 *   https://query.wikidata.org/sparql
 *   GET, ?query=<urlencoded>, Accept: application/sparql-results+json,
 *   and a real User-Agent (blank ones are rejected).
 *
 * Coordinates come back as `Point(lon lat)` — LONGITUDE FIRST. Getting this
 * backwards puts the Space Needle in the Indian Ocean, and it will look
 * plausible right up until you fly there.
 *
 * ---------------------------------------------------------------------------
 * THE PROBLEM: LABEL LOOKUP IS CATASTROPHICALLY AMBIGUOUS
 * ---------------------------------------------------------------------------
 * A probe of ten landmark names returned 58 rows. NINE were right. Forty-nine
 * were namesakes:
 *   - "Mount Adams" resolved in New Hampshire, Maryland, Ohio, Colorado,
 *     New Zealand, Australia and Western Australia;
 *   - "Mount Rainier" also matched a town in Maryland (38.94, -76.96);
 *   - "Columbia Center" matched buildings in Michigan, Ohio and New York;
 *   - "Glacier Peak" matched eight different mountains.
 *
 * Filtering to the region bbox is NECESSARY BUT NOT SUFFICIENT:
 *   - "Mount Baker" at 47.5766, -122.2977 IS inside our bbox — it is a Seattle
 *     NEIGHBOURHOOD, not the volcano. It would pass a bbox filter and put a
 *     mountain marker in a residential district.
 *   - The actual Mount Baker volcano is at 48.7773, -121.8132, north of our
 *     bbox, so it is correctly excluded — but only by accident of geography.
 *   - "Mount Rainier" returns TWO in-bbox items: Q194057 (the mountain) and
 *     Q64144108 at 46.8528, -121.7604 (a near-duplicate summit node).
 *
 * => RESOLVE BY Q-ID, from the curated table below. The bbox is an assertion,
 *    not the filter. A landmark resolving outside REGION_BBOX means the table
 *    has a bad Q-ID and the bake should fail loudly rather than ship it.
 *
 * ---------------------------------------------------------------------------
 * HEIGHTS
 * ---------------------------------------------------------------------------
 * P2048 is "height", in metres, ABOVE THE STRUCTURE'S OWN BASE. Verified:
 * Space Needle 184, Columbia Center 294.8, Smith Tower 159.
 *
 * PEAKS GET heightM = 0. Their elevation is already in the DEM — Mount Rainier
 * reads about 4390 m there. Stacking a 4392 m cone on top of 4392 m of terrain
 * produces an 8.8 km mountain. The mountain IS the terrain; the landmark entry
 * only labels it.
 *
 * ---------------------------------------------------------------------------
 * OUTPUT CONTRACT — src/geo/landmarks.js depends on exactly this
 * ---------------------------------------------------------------------------
 * public/data/landmarks.json
 *   {
 *     "generated": "...",
 *     "source": "wikidata",
 *     "landmarks": [
 *       { "name": "Space Needle", "lat": 47.6204, "lon": -122.3491,
 *         "heightM": 184, "kind": "tower", "wikidataId": "Q5317",
 *         "widthM": 42 },
 *       { "name": "Mount Rainier", "lat": 46.8517, "lon": -121.7603,
 *         "heightM": 0, "kind": "peak", "wikidataId": "Q194057" }
 *     ]
 *   }
 *
 * `kind` is one of: tower | peak | building | stadium | bridge | other.
 */

import {
  REGION_BBOX,
  parseArgs,
  writeJson,
  get,
  inBbox,
} from './lib/util.mjs';

const ENDPOINT = 'https://query.wikidata.org/sparql';

/**
 * The curated set. Q-IDs verified against a live query on 2026-08-06; the
 * coordinates in the comments are what that query returned and are here so a
 * future re-bake can be diffed against them.
 *
 * `kind` drives the placeholder mesh in src/geo/landmarks.js. `widthM` is a
 * footprint hint, optional.
 *
 * To add a landmark: find its Q-ID on wikidata.org, confirm the item is the
 * thing you mean (not a namesake, not a disambiguation page, not a district
 * named after it), and add it here. Never add by label alone.
 */
const CURATED = [
  // Q5317  -> 47.6204, -122.3491, P2048 = 184. The landmark the user named.
  { id: 'Q5317', name: 'Space Needle', kind: 'tower', widthM: 42 },
  // Q194057 -> 46.8517, -121.7603. Peak: heightM forced to 0, see header.
  { id: 'Q194057', name: 'Mount Rainier', kind: 'peak' },
  // Q908703 -> 47.6045, -122.3305, P2048 = 294.8. Tallest building in Seattle.
  { id: 'Q908703', name: 'Columbia Center', kind: 'building', widthM: 50 },
  // Q1196348 -> 47.6019, -122.3317, P2048 = 159.
  { id: 'Q1196348', name: 'Smith Tower', kind: 'building', widthM: 30 },
  // Q612736 -> 47.5953, -122.3317.
  { id: 'Q612736', name: 'Lumen Field', kind: 'stadium', widthM: 190 },
  // Q1193117 -> 47.5914, -122.3325.
  { id: 'Q1193117', name: 'T-Mobile Park', kind: 'stadium', widthM: 200 },
];

/**
 * Peaks whose summit elevation is supplied by the DEM. Cross-check only: any
 * entry with kind:'peak' gets heightM = 0 regardless.
 */
const PEAK_KINDS = new Set(['peak']);

/**
 * Resolve the curated Q-IDs in one round trip. VALUES on ?item is the
 * unambiguous form — no label matching anywhere.
 *
 * @param {string[]} ids
 * @returns {string} SPARQL
 */
function buildQuery(ids) {
  const values = ids.map((id) => `wd:${id}`).join(' ');
  return `SELECT ?item ?itemLabel ?coord ?height WHERE {
  VALUES ?item { ${values} }
  ?item wdt:P625 ?coord .
  OPTIONAL { ?item wdt:P2048 ?height }
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
}`;
}

/**
 * Parse a WKT point literal. Wikidata writes `Point(lon lat)`.
 * @param {string} wkt
 * @returns {{lat: number, lon: number}|null}
 */
function parsePoint(wkt) {
  const m = /Point\(\s*(-?[\d.]+)\s+(-?[\d.]+)\s*\)/.exec(wkt);
  if (!m) return null;
  return { lon: Number(m[1]), lat: Number(m[2]) };
}

async function main() {
  parseArgs();
  const query = buildQuery(CURATED.map((c) => c.id));
  console.log(`Querying Wikidata for ${CURATED.length} curated items...`);

  const res = await get(`${ENDPOINT}?query=${encodeURIComponent(query)}`, {
    Accept: 'application/sparql-results+json',
  });
  const json = await res.json();
  const bindings = json?.results?.bindings ?? [];
  console.log(`  ${bindings.length} rows returned`);

  // TODO(GeoCore): build the output.
  //
  //  1. Index bindings by Q-ID (b.item.value ends with the id).
  //  2. For each CURATED entry, in table order:
  //       - fail loudly if the Q-ID returned no row (a deleted/merged item)
  //       - parse the coordinate with parsePoint() — LON FIRST
  //       - ASSERT inBbox(lat, lon, REGION_BBOX); throw naming the item if not,
  //         because that means the Q-ID is wrong, not that the bbox is wrong
  //       - heightM = PEAK_KINDS.has(kind) ? 0 : Number(b.height?.value ?? 0)
  //       - carry through name (from the table, NOT itemLabel — we control the
  //         display string), kind, widthM, wikidataId
  //  3. Round coordinates to 4 dp (~11 m), heights to 1 dp.
  //  4. Write public/data/landmarks.json.
  //
  void bindings;
  void parsePoint;
  void inBbox;
  void REGION_BBOX;
  void PEAK_KINDS;
  void writeJson;

  throw new Error(
    'bake-landmarks.mjs is a skeleton: the transform is not implemented yet. ' +
      'See the TODO in main().',
  );
}

main().catch((err) => {
  console.error(err.message);
  process.exitCode = 1;
});
