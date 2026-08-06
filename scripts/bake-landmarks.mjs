/**
 * bake-landmarks.mjs — landmark coordinates from Wikidata.
 *
 *   node scripts/bake-landmarks.mjs
 *   node scripts/bake-landmarks.mjs --dry     (query + validate, write nothing)
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
 * TRAP 1: LABEL LOOKUP IS CATASTROPHICALLY AMBIGUOUS
 * ---------------------------------------------------------------------------
 * A probe of ten landmark names returned 58 rows. NINE were right. Re-probed on
 * 2026-08-06 with 33 names: 69 rows, 30 in bbox, and the in-bbox set still
 * contained decoys:
 *   - "Mount Baker" returns 18 rows. The two INSIDE our bbox are Q6919565 (a
 *     light rail station) and Q12062108 (a Seattle neighbourhood). The volcano
 *     is at 48.7773 — north of our bbox — so a bbox filter keeps the two wrong
 *     answers and throws away the right one.
 *   - "Glacier Peak" returns 11 rows and ZERO in bbox: the real one is at
 *     -121.114, just east of our -121.2 edge.
 *   - "Mount Rainier" returns two in-bbox items, Q194057 (the mountain) and
 *     Q64144108 (a glacier node 120 m away).
 *   - "Bank of America Tower" matched New York, Jacksonville, Phoenix and
 *     Hong Kong; "Columbia Center" matched Michigan, Ohio and New York.
 *
 * => RESOLVE BY Q-ID from the curated table below, and assert each result lands
 *    within ASSERT_TOLERANCE_M of a coordinate pinned in that same table. The
 *    bbox check alone does NOT separate the volcano from the light rail
 *    station; the pinned coordinate does. A mismatch is a bad Q-ID and fails
 *    the bake loudly rather than shipping a mountain into a residential street.
 *
 * ---------------------------------------------------------------------------
 * TRAP 2: P2048 IS NOT ALWAYS IN METRES, AND IS NOT SINGLE-VALUED
 * ---------------------------------------------------------------------------
 * `wdt:P2048` gives a bare number with no unit. Measured on our own set:
 *   Q2301069 "1201 Third Avenue"  -> 772   unit = FOOT  (235.3 m)
 *   Q7442108 "Seattle Great Wheel"-> 175   unit = FOOT  ( 53.3 m)
 *   Q5317    "Space Needle"       -> 184   unit = metre
 * Taking the bare number builds a 772 m tower — half again the height of the
 * Burj Khalifa — on Third Avenue, and a 175 m ferris wheel, three times the
 * real one. So we read the full statement node (psv:P2048) for the unit and
 * convert.
 *
 * And Q908703 "Columbia Center" returns TWO heights, 284.4 (roof) and 294.8
 * (architectural top). A bare query picks one nondeterministically. We take the
 * MAX, because what we are drawing is a silhouette against the sky and the
 * spire is part of it.
 *
 * ---------------------------------------------------------------------------
 * HEIGHTS
 * ---------------------------------------------------------------------------
 * heightM is ABOVE THE STRUCTURE'S OWN BASE, never above sea level. The DEM
 * supplies the base at runtime.
 *
 * Wikidata simply has no height for most of our set (every stadium, both
 * bridges, the Boeing factory, the Spheres). Those carry a `heightM` in the
 * curated table with a source note. A landmark with neither is a bake error.
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
 *     "bbox": {...},
 *     "landmarks": [
 *       { "name": "Space Needle", "lat": 47.6204, "lon": -122.3491,
 *         "heightM": 184, "kind": "tower", "wikidataId": "Q5317",
 *         "widthM": 42, "model": "spaceNeedle" }
 *     ]
 *   }
 *
 * `kind` is one of: tower | peak | building | stadium | bridge | other.
 *
 * Fields beyond the MODULES.md §2.6 minimum are all OPTIONAL and additive:
 *   headingDeg  bearing of the structure's long axis (square towers: grid angle)
 *   lengthM     long-axis extent for things that are not square
 *   model       explicit builder key for src/world/landmarkModels.js
 *   heightSrc   'wikidata' | 'curated' — provenance, for review
 */

import {
  REGION_BBOX,
  parseArgs,
  writeJson,
  get,
  inBbox,
  distanceBetween,
} from './lib/util.mjs';

const ENDPOINT = 'https://query.wikidata.org/sparql';

/**
 * How far a resolved coordinate may sit from the pinned one before we call the
 * Q-ID wrong. 400 m is comfortably more than the disagreement between a
 * building's centroid and its street address (tens of metres) and comfortably
 * less than the distance to any namesake we have seen (kilometres at best —
 * the Mount Baker light rail station is 134 km from the volcano).
 */
const ASSERT_TOLERANCE_M = 400;

/** Wikidata unit item -> metres. Anything not listed fails the bake. */
const UNIT_TO_M = {
  Q11573: 1, // metre
  Q3710: 0.3048, // foot
  Q218593: 0.0254, // inch
  Q828224: 1000, // kilometre
  Q174728: 0.01, // centimetre
};

/**
 * The curated set. Q-IDs and `expect` coordinates come from a live probe on
 * 2026-08-06; re-baking diffs against them automatically.
 *
 * To add a landmark: find its Q-ID on wikidata.org, confirm the item is the
 * thing you mean (not a namesake, not a disambiguation page, not a district or
 * a transit station named after it), pin its coordinate in `expect`, and add it
 * here. NEVER add by label alone.
 *
 * `heightM` here is a FALLBACK used only when Wikidata has no P2048. Every one
 * carries a note saying where the number came from.
 */
const CURATED = [
  // --- the hero -----------------------------------------------------------
  {
    id: 'Q5317',
    name: 'Space Needle',
    kind: 'tower',
    model: 'spaceNeedle',
    widthM: 42, // top house outer diameter, 138 ft
    expect: [47.6204, -122.3491],
  },

  // --- downtown Seattle towers -------------------------------------------
  {
    id: 'Q908703',
    name: 'Columbia Center',
    kind: 'building',
    model: 'columbiaCenter',
    widthM: 50,
    headingDeg: 30, // downtown core grid, parallel to the Elliott Bay shore
    expect: [47.6045, -122.3305],
  },
  {
    id: 'Q3177235',
    name: 'Seattle Municipal Tower',
    kind: 'building',
    heightM: 220, // 722 ft, 62 floors. Wikidata has floors but no P2048.
    widthM: 42,
    headingDeg: 30,
    expect: [47.6051, -122.33],
  },
  {
    id: 'Q24036684',
    name: 'Two Union Square',
    kind: 'building',
    heightM: 226, // 740 ft
    widthM: 44,
    headingDeg: 30,
    expect: [47.6103, -122.333],
  },
  {
    id: 'Q2301069',
    name: '1201 Third Avenue',
    kind: 'building',
    // P2048 = 772 FOOT. The unit conversion in this script is what stops this
    // becoming a 772 m tower; leaving it un-noted invites someone to "simplify"
    // back to wdt:P2048.
    widthM: 45,
    headingDeg: 30,
    expect: [47.6072, -122.336],
  },
  {
    id: 'Q7284914',
    name: 'Rainier Tower',
    kind: 'building',
    model: 'rainierTower', // the pedestal — it stands on a tapered concrete stem
    heightM: 156, // 514 ft, 31 floors
    widthM: 38,
    headingDeg: 30,
    expect: [47.609, -122.334],
  },
  {
    id: 'Q1196348',
    name: 'Smith Tower',
    kind: 'building',
    model: 'smithTower', // stepped shaft + the pyramid cap it is known for
    widthM: 30,
    headingDeg: 30,
    expect: [47.6019, -122.3317],
  },
  {
    id: 'Q2531939',
    name: 'Seattle Central Library',
    kind: 'building',
    heightM: 56, // 185 ft, 11 floors
    widthM: 55,
    headingDeg: 30,
    expect: [47.6061, -122.333],
  },

  // --- Seattle Center / waterfront ---------------------------------------
  {
    id: 'Q1384356',
    name: 'Museum of Pop Culture',
    kind: 'building',
    model: 'mopop',
    heightM: 25, // low sheet-metal blob; no P2048 anywhere
    widthM: 85,
    lengthM: 105,
    headingDeg: 20,
    expect: [47.6215, -122.3486],
  },
  {
    id: 'Q977529',
    name: 'Climate Pledge Arena',
    kind: 'stadium',
    model: 'arena', // the 1962 hyperbolic-paraboloid roof is the whole silhouette
    heightM: 34,
    widthM: 130,
    headingDeg: 0, // Seattle Center sits on the north-of-Denny N-S grid
    expect: [47.6222, -122.3542],
  },
  {
    id: 'Q7442108',
    name: 'Seattle Great Wheel',
    kind: 'other',
    model: 'ferrisWheel',
    // P2048 = 175 FOOT -> 53.3 m. See TRAP 2.
    headingDeg: 30, // wheel plane faces the bay, across the pier
    expect: [47.6061, -122.3425],
  },
  {
    id: 'Q1373418',
    name: 'Pike Place Market',
    kind: 'building',
    heightM: 18,
    widthM: 30,
    lengthM: 180,
    headingDeg: 340, // runs along the bluff above the waterfront
    expect: [47.6094, -122.3417],
  },
  {
    id: 'Q48596158',
    name: 'Amazon Spheres',
    kind: 'other',
    model: 'spheres',
    heightM: 27,
    widthM: 40, // largest of the three domes
    expect: [47.6156, -122.3394],
  },

  // --- stadiums (SoDo) ----------------------------------------------------
  {
    id: 'Q612736',
    name: 'Lumen Field',
    kind: 'stadium',
    model: 'stadiumBowl',
    heightM: 43, // roof arches ~140 ft over the field
    widthM: 190,
    lengthM: 230,
    headingDeg: 20,
    expect: [47.5953, -122.3317],
  },
  {
    id: 'Q1193117',
    name: 'T-Mobile Park',
    kind: 'stadium',
    model: 'stadiumBowl',
    heightM: 56, // retractable roof peak
    widthM: 200,
    lengthM: 240,
    headingDeg: 20,
    roof: true,
    expect: [47.5914, -122.3325],
  },

  // --- bridges ------------------------------------------------------------
  {
    id: 'Q7674000',
    name: 'Tacoma Narrows Bridge',
    kind: 'bridge',
    model: 'suspensionBridge',
    heightM: 154, // tower height above the water
    lengthM: 853, // main span
    widthM: 18, // deck
    headingDeg: 100, // crosses the Narrows roughly W-E
    expect: [47.269, -122.5517],
  },
  {
    id: 'Q7986448',
    name: 'West Seattle Bridge',
    kind: 'bridge',
    model: 'girderBridge',
    heightM: 42, // deck above the Duwamish
    lengthM: 460,
    widthM: 24,
    headingDeg: 95,
    expect: [47.5711, -122.35],
  },

  // --- outside Seattle ----------------------------------------------------
  {
    id: 'Q890159',
    name: 'Boeing Everett Factory',
    kind: 'building',
    model: 'factory',
    heightM: 34, // 110 ft; largest building in the world by volume
    widthM: 330,
    lengthM: 500,
    headingDeg: 105, // parallel to Paine Field's runway
    expect: [47.9256, -122.2719],
  },
  {
    id: 'Q1570942',
    name: 'Tacoma Dome',
    kind: 'stadium',
    model: 'dome',
    heightM: 46, // 152 ft
    widthM: 161, // dome diameter
    expect: [47.2367, -122.4267],
  },
  {
    id: 'Q2641400',
    name: 'Alki Point Light',
    kind: 'other',
    model: 'lighthouse',
    // P2048 = 11 metre. Small, but it is the turning point into Elliott Bay.
    widthM: 6,
    expect: [47.5763, -122.4206],
  },
  {
    id: 'Q1354391',
    name: 'Fremont Troll',
    kind: 'other',
    heightM: 5.5, // 18 ft. Label-only from the air; see landmarkModels.js.
    widthM: 9,
    expect: [47.651, -122.3473],
  },

  // --- viewpoints and peaks (label-only; the DEM draws these) -------------
  {
    id: 'Q6394618',
    name: 'Kerry Park',
    kind: 'other',
    heightM: 0, // a viewpoint, not a structure
    expect: [47.6296, -122.3594],
  },
  {
    id: 'Q194057',
    name: 'Mount Rainier',
    kind: 'peak',
    expect: [46.8517, -121.7603],
  },
  {
    id: 'Q6923639',
    name: 'Mount Si',
    kind: 'peak',
    expect: [47.5076, -121.74],
  },
];

/**
 * Deliberately NOT in the set, recorded so nobody re-adds them and then
 * "fixes" the bbox assertion when the bake fails.
 *
 *   Mount Baker (volcano)  Q4779  48.7773, -121.8132   3.5 deg north of bbox
 *   Glacier Peak           Q1529000 48.1125, -121.1136 0.09 deg east of bbox
 *   Deception Pass Bridge  Q1181772 48.4060, -122.6450 0.11 deg north of bbox
 *   Mount St. Helens       Q4675   46.1912, -122.1944  0.21 deg south of bbox
 *
 * All four are outside REGION_BBOX, which means outside the baked DEM: there is
 * no ground under them. Widening the bbox to include them costs a lot more DEM
 * tiles for landmarks 100+ km from the spawn. If you want them, widen the bbox
 * in BOTH src/geo/coords.js and scripts/lib/util.mjs, re-bake the DEM, then add
 * them here.
 */
const EXCLUDED_OUT_OF_REGION = [
  ['Mount Baker (volcano)', 'Q4779', 48.7773, -121.8132],
  ['Glacier Peak', 'Q1529000', 48.1125, -121.1136],
  ['Deception Pass Bridge', 'Q1181772', 48.406, -122.645],
  ['Mount St. Helens', 'Q4675', 46.1912, -122.1944],
];

/** kind values whose elevation the DEM already supplies. */
const PEAK_KINDS = new Set(['peak']);

/**
 * Resolve the curated Q-IDs in one round trip. VALUES on ?item is the
 * unambiguous form — no label matching anywhere.
 *
 * The height comes from the full statement node, not `wdt:P2048`, so we get the
 * unit with it. See TRAP 2 in the header.
 *
 * @param {string[]} ids
 * @returns {string} SPARQL
 */
function buildQuery(ids) {
  const values = ids.map((id) => `wd:${id}`).join(' ');
  return `SELECT ?item ?itemLabel ?coord ?amount ?unit WHERE {
  VALUES ?item { ${values} }
  ?item wdt:P625 ?coord .
  OPTIONAL {
    ?item p:P2048/psv:P2048 ?hv .
    ?hv wikibase:quantityAmount ?amount ; wikibase:quantityUnit ?unit .
  }
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

/** Trailing path segment of a Wikidata entity URI. */
const qid = (uri) => String(uri).split('/').pop();

const round = (v, dp) => {
  const f = 10 ** dp;
  return Math.round(v * f) / f;
};

async function main() {
  const args = parseArgs();
  const ids = CURATED.map((c) => c.id);

  const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
  if (dupes.length) throw new Error(`duplicate Q-IDs in CURATED: ${dupes}`);

  console.log(`Querying Wikidata for ${CURATED.length} curated items...`);
  const res = await get(
    `${ENDPOINT}?query=${encodeURIComponent(buildQuery(ids))}`,
    { Accept: 'application/sparql-results+json' },
  );
  const json = await res.json();
  const bindings = json?.results?.bindings ?? [];
  console.log(`  ${bindings.length} rows returned`);

  // One item can produce several rows (multiple P2048 statements), so index
  // into { coord, heightsM[] } rather than assuming one row per Q-ID.
  /** @type {Map<string, {coord: {lat:number,lon:number}, heightsM: number[]}>} */
  const byId = new Map();
  for (const b of bindings) {
    const id = qid(b.item.value);
    let e = byId.get(id);
    if (!e) {
      const coord = parsePoint(b.coord.value);
      if (!coord) throw new Error(`${id}: unparseable coordinate ${b.coord.value}`);
      e = { coord, heightsM: [] };
      byId.set(id, e);
    }
    if (b.amount && b.unit) {
      const unitId = qid(b.unit.value);
      const factor = UNIT_TO_M[unitId];
      if (factor === undefined) {
        // Refusing is the point. A silent fallback of 1 is exactly how a
        // 772-foot building becomes a 772-metre one.
        throw new Error(
          `${id}: P2048 uses unknown unit ${unitId}. Add it to UNIT_TO_M ` +
            'with its metre factor, or the height will be wrong by that factor.',
        );
      }
      const metres = Number(b.amount.value) * factor;
      if (factor !== 1) {
        console.log(
          `  ${id}: P2048 ${b.amount.value} (${unitId}) -> ${metres.toFixed(1)} m`,
        );
      }
      e.heightsM.push(metres);
    }
  }

  const out = [];
  const problems = [];

  for (const c of CURATED) {
    const row = byId.get(c.id);
    if (!row) {
      problems.push(`${c.name} (${c.id}): no row returned — deleted or merged?`);
      continue;
    }
    const { lat, lon } = row.coord;

    // Assertion 1 — the region. Necessary, and not sufficient.
    if (!inBbox(lat, lon, REGION_BBOX)) {
      problems.push(
        `${c.name} (${c.id}): ${lat},${lon} is OUTSIDE REGION_BBOX. ` +
          'The Q-ID is wrong, or the item moved. Do not widen the bbox to fix this.',
      );
      continue;
    }

    // Assertion 2 — the pinned coordinate. THIS is the one that separates the
    // Mount Baker volcano from the Mount Baker light rail station.
    const drift = distanceBetween(lat, lon, c.expect[0], c.expect[1]);
    if (drift > ASSERT_TOLERANCE_M) {
      problems.push(
        `${c.name} (${c.id}): resolved to ${lat},${lon}, which is ` +
          `${(drift / 1000).toFixed(2)} km from the pinned ${c.expect[0]},${c.expect[1]}. ` +
          'Namesake collision, or the item was edited upstream. Verify on ' +
          'wikidata.org before touching the pin.',
      );
      continue;
    }
    if (drift > 50) {
      console.log(`  note: ${c.name} drifted ${drift.toFixed(0)} m from its pin`);
    }

    const isPeak = PEAK_KINDS.has(c.kind);
    let heightM;
    let heightSrc;
    if (isPeak) {
      heightM = 0; // the DEM already has the summit; see the header.
      heightSrc = 'dem';
    } else if (row.heightsM.length) {
      // Several statements (roof vs. architectural top) -> take the tallest.
      heightM = Math.max(...row.heightsM);
      heightSrc = 'wikidata';
      if (row.heightsM.length > 1) {
        console.log(
          `  note: ${c.name} has ${row.heightsM.length} P2048 values ` +
            `[${row.heightsM.map((h) => h.toFixed(1))}] — taking the max`,
        );
      }
    } else if (Number.isFinite(c.heightM)) {
      heightM = c.heightM;
      heightSrc = 'curated';
    } else {
      problems.push(
        `${c.name} (${c.id}): no P2048 on Wikidata and no curated heightM. ` +
          'Add one to the table with a note saying where the figure came from.',
      );
      continue;
    }

    // A height in the hundreds of metres for something we believe is a shed,
    // or a negative one, means the wrong statement was picked up.
    if (!(heightM >= 0 && heightM < 700)) {
      problems.push(`${c.name} (${c.id}): implausible heightM ${heightM}`);
      continue;
    }

    const entry = {
      name: c.name,
      lat: round(lat, 4), // ~11 m; the DEM is 13 m/px at best
      lon: round(lon, 4),
      heightM: round(heightM, 1),
      kind: c.kind,
      wikidataId: c.id,
      heightSrc,
    };
    if (Number.isFinite(c.widthM)) entry.widthM = c.widthM;
    if (Number.isFinite(c.lengthM)) entry.lengthM = c.lengthM;
    if (Number.isFinite(c.headingDeg)) entry.headingDeg = c.headingDeg;
    if (c.model) entry.model = c.model;
    if (c.roof) entry.roof = true;
    out.push(entry);
  }

  // Sanity-check the exclusion list still is excluded — it documents WHY those
  // four are missing, and it would be quietly wrong if the bbox ever changed.
  for (const [name, id, lat, lon] of EXCLUDED_OUT_OF_REGION) {
    if (inBbox(lat, lon, REGION_BBOX)) {
      console.log(
        `  note: ${name} (${id}) is now INSIDE the bbox — the region grew. ` +
          'It can be promoted into CURATED.',
      );
    }
  }

  if (problems.length) {
    console.error('\nBAKE FAILED:');
    for (const p of problems) console.error(`  - ${p}`);
    throw new Error(`${problems.length} landmark(s) failed validation`);
  }

  const needle = out.find((l) => l.name === 'Space Needle');
  if (!needle || needle.lat !== 47.6204 || needle.lon !== -122.3491) {
    throw new Error(
      `Space Needle must bake to 47.6204,-122.3491; got ${needle?.lat},${needle?.lon}`,
    );
  }
  console.log(
    `\n  Space Needle verified at ${needle.lat}, ${needle.lon}, ` +
      `${needle.heightM} m (${needle.heightSrc})`,
  );

  const doc = {
    generated: new Date().toISOString(),
    source: 'wikidata',
    endpoint: ENDPOINT,
    bbox: REGION_BBOX,
    count: out.length,
    landmarks: out,
  };

  console.log(`\n  ${out.length} landmarks validated:`);
  for (const l of out) {
    console.log(
      `    ${l.name.padEnd(30)} ${l.lat.toFixed(4)},${l.lon.toFixed(4)}  ` +
        `${String(l.heightM).padStart(6)} m  ${l.kind}`,
    );
  }

  if (args.dry) {
    console.log('\n--dry: nothing written');
    return;
  }
  await writeJson('data/landmarks.json', doc);
}

main().catch((err) => {
  console.error(err.message);
  process.exitCode = 1;
});
