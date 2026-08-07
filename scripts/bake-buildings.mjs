/**
 * bake-buildings.mjs — REAL building footprints for the Seattle inset.
 *
 *   node scripts/bake-buildings.mjs            # global-buildings, ~4 min cold
 *   node scripts/bake-buildings.mjs --dry      # select + report, write nothing
 *   node scripts/bake-buildings.mjs --source=legacy   # the state GeoJSON zip
 *
 * Output: public/data/buildings.json   (schema at the bottom of this header)
 *
 * ---------------------------------------------------------------------------
 * WHAT IS REAL HERE AND WHAT IS NOT — read this before quoting a number
 * ---------------------------------------------------------------------------
 * REAL, from Microsoft Building Footprints:
 *   - every FOOTPRINT POLYGON: its position, its outline, its orientation, its
 *     area. Columbia Center's footprint lands 16 m from its published
 *     coordinate and measures 3,008 m2; the Space Needle's lands 7 m from its
 *     published coordinate. These are surveyed-grade outlines derived from
 *     imagery, not a street grid with boxes on it.
 *
 * NOT REAL — DERIVED, and never presented otherwise:
 *   - every HEIGHT that is not in the curated published table below.
 *
 * ---------------------------------------------------------------------------
 * THE HEIGHT FIELD IS A TRAP. I MEASURED IT.
 * ---------------------------------------------------------------------------
 * The global-buildings release carries `properties.height`, derived from
 * Microsoft's photogrammetric DSM. It is unusable for a skyline, and the way it
 * fails is silent — it returns a plausible-looking positive number for every
 * tower. Measured over all 450,125 footprints inside the inset:
 *
 *   Columbia Center    published 284 m   ->  DSM says  25.1 m
 *   Space Needle       published 184 m   ->  DSM says  28.6 m
 *   Smith Tower        published 149 m   ->  DSM says  18.3 m
 *   Two Union Square   published 226 m   ->  DSM says  21.2 m
 *
 *   tallest DSM value anywhere in the 44 x 44 km inset:  35.3 m
 *   buildings the DSM puts above 40 m:                   0
 *   median DSM height in the downtown core, area >800 m2: 15.5 m
 *
 * The surface model saturates somewhere around 35 m. So:
 *   - above DSM_TRUST_M the field is DISCARDED, not scaled. Scaling a saturated
 *     sensor invents the very numbers we are trying not to invent.
 *   - below it the field is kept, but only as a STOREY COUNT
 *     (round(h / 3.2), clamped 1..5). The raw metres are still compressed —
 *     median 5.1 m for a 150-300 m2 house, about one storey light — so the
 *     quantity that survives is "one storey or three", which it does get right,
 *     not the metres.
 *
 * Everything above five storeys comes from PUBLISHED_HEIGHTS or from the
 * documented zoning model in `derivedStoreys()`. Both are tagged per building
 * in the output (`src`), so a consumer can always tell which it is looking at.
 *
 * ---------------------------------------------------------------------------
 * SOURCES
 * ---------------------------------------------------------------------------
 * DEFAULT — `global-buildings`, release 2026-02-03, four z9 quadkey shards
 * covering the inset (23 + 35 + 56 + 38 MB gzipped). Newer than the legacy
 * state file, so it has the towers finished since 2024, and it is the release
 * that carries the height field measured above.
 *
 * `--source=legacy` — the state file named in the brief,
 * legacy/usbuildings-v2/Washington.geojson.zip (118 MB, 927 MB inflated, one
 * feature per line, properties `release` and `capture_dates_range` only, NO
 * height at all). Kept working as a fallback: both were probed live and both
 * return 200. The zip is inflated with node:zlib inflateRaw straight off the
 * local file header — no unzip binary, no dependency.
 *
 * NEITHER STATE FILE IS SHIPPED TO THE BROWSER. 927 MB in, ~2 MB out.
 *
 * ---------------------------------------------------------------------------
 * OUTPUT SCHEMA — public/data/buildings.json
 * ---------------------------------------------------------------------------
 * Parallel flat arrays, not an array of objects: 30k objects with a nested
 * ring array each is 4x the bytes and 10x the parse time for the same content.
 *
 *   {
 *     generated, source, sourceUrl, bbox, note,
 *     quantM,      // ring vertices are integers in this many metres (0.25)
 *     quantDeg,    // anchors are integers in this many degrees (1e-6)
 *     scaleLat,    // latitude the metres-per-degree factors were frozen at.
 *                  // MUST equal coords.js SCALE_LAT or rings are the wrong size.
 *     count,
 *     anchors,     // 2*count ints, DELTA-encoded: [dLatQ, dLonQ, ...]
 *     rings,       // per building: [n, de0,dn0, de1,dn1, ... ] where the first
 *                  //   pair is relative to the ANCHOR and each later pair is
 *                  //   relative to the previous vertex. Units of quantM,
 *                  //   +e = east, +n = north. Outer ring only, CCW, not closed.
 *     heights,     // count ints, DECIMETRES above the building's own base
 *     src,         // count chars: 'p' published, 'd' derived, 'm' DSM storeys
 *     provenance,  // {published, derived, dsm} counts, for the honest readout
 *     districts    // the zoning model's inputs, so the derivation is reviewable
 *   }
 *
 * Buildings are emitted in chunk-major order so the anchor deltas stay small.
 */

import { createReadStream, existsSync, mkdirSync, statSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { createGunzip, createInflateRaw } from 'node:zlib';
import { createInterface } from 'node:readline';
import { resolve, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createWriteStream } from 'node:fs';
import { Readable } from 'node:stream';
import {
  ROOT,
  SCALE_LAT,
  metresPerDegreeLat,
  metresPerDegreeLon,
  writeJson,
  parseArgs,
  USER_AGENT,
} from './lib/util.mjs';

const args = parseArgs();
const DRY = !!args.dry;
const SOURCE = args.source === 'legacy' ? 'legacy' : 'global';

// ---------------------------------------------------------------------------
// The inset
// ---------------------------------------------------------------------------

/**
 * Same box as the DEM's FINE_ZOOM layer and the land-cover detail layer
 * (MODULES.md §2.4). Deliberately: the fine terrain, the 20 m/texel land cover
 * and the real buildings should all stop at the same place, so there is one
 * detail frontier to hide rather than three.
 */
const INSET = Object.freeze({ south: 47.35, north: 47.75, west: -122.5, east: -122.1 });

const M_LAT = metresPerDegreeLat(SCALE_LAT);
const M_LON = metresPerDegreeLon(SCALE_LAT);

/** Quantisation. 0.25 m on ring vertices is a quarter of the source's own
 *  positional noise and makes almost every delta a two- or three-digit int. */
const QUANT_M = 0.25;
const QUANT_DEG = 1e-6;

// ---------------------------------------------------------------------------
// Districts — the zoning model's only inputs, and they are reviewable
// ---------------------------------------------------------------------------

/**
 * A district is a disc with a published skyline ceiling. `maxStoreys` is the
 * storey count of the district's tallest building; `falloffM` is the distance
 * at which the ceiling has fallen to half. Both are stated, not tuned to taste,
 * and both are written into the output file so the derivation can be argued
 * with.
 *
 * Seattle's downtown ceiling is Columbia Center at 76 storeys; the Denny
 * Triangle / South Lake Union ceiling is the Amazon towers at ~38; Bellevue's
 * is the 600 Bellevue / Lincoln Square generation at ~43. Uptown (Seattle
 * Center) is a designated low-rise district and the Needle stands alone.
 */
const DISTRICTS = [
  { name: 'Seattle CBD', lat: 47.6062, lon: -122.3321, maxStoreys: 76, falloffM: 900, radiusM: 2600, minAreaM2: 90 },
  { name: 'Denny Triangle / SLU', lat: 47.6175, lon: -122.3370, maxStoreys: 40, falloffM: 950, radiusM: 2200, minAreaM2: 110 },
  { name: 'Uptown / Seattle Center', lat: 47.6235, lon: -122.3520, maxStoreys: 12, falloffM: 900, radiusM: 1600, minAreaM2: 130 },
  { name: 'Bellevue CBD', lat: 47.6150, lon: -122.2010, maxStoreys: 43, falloffM: 700, radiusM: 1900, minAreaM2: 110 },
  { name: 'University District', lat: 47.6600, lon: -122.3130, maxStoreys: 25, falloffM: 700, radiusM: 1600, minAreaM2: 150 },
  { name: 'Capitol Hill', lat: 47.6190, lon: -122.3210, maxStoreys: 8, falloffM: 900, radiusM: 1700, minAreaM2: 150 },
  { name: 'SoDo / stadiums', lat: 47.5930, lon: -122.3320, maxStoreys: 6, falloffM: 1400, radiusM: 2200, minAreaM2: 300 },
  { name: 'Ballard', lat: 47.6680, lon: -122.3840, maxStoreys: 6, falloffM: 900, radiusM: 1400, minAreaM2: 200 },
  { name: 'West Seattle Junction', lat: 47.5610, lon: -122.3870, maxStoreys: 6, falloffM: 800, radiusM: 1200, minAreaM2: 220 },
  { name: 'Northgate', lat: 47.7070, lon: -122.3260, maxStoreys: 8, falloffM: 800, radiusM: 1300, minAreaM2: 250 },
  { name: 'Renton', lat: 47.4830, lon: -122.2170, maxStoreys: 6, falloffM: 900, radiusM: 1500, minAreaM2: 300 },
  { name: 'Tukwila / Southcenter', lat: 47.4590, lon: -122.2590, maxStoreys: 6, falloffM: 900, radiusM: 1600, minAreaM2: 350 },
  { name: 'Burien', lat: 47.4700, lon: -122.3390, maxStoreys: 6, falloffM: 700, radiusM: 1100, minAreaM2: 300 },
  { name: 'Kirkland', lat: 47.6770, lon: -122.2050, maxStoreys: 6, falloffM: 700, radiusM: 1200, minAreaM2: 250 },
];

/**
 * Outside every district, a footprint has to be genuinely large to earn a draw
 * call — a warehouse, a mall, a school, a hangar. Suburban houses at 6 m are
 * invisible from 600 m AGL and there are 400,000 of them.
 */
const BACKGROUND_MIN_AREA_M2 = 900;

/** Below this the polygon is a shed, a garage or a noise artefact. */
const ABSOLUTE_MIN_AREA_M2 = 70;

// ---------------------------------------------------------------------------
// Published heights — the only heights in this file that are not derived
// ---------------------------------------------------------------------------

/**
 * Architectural height in metres, from each building's published figure, with
 * an approximate street coordinate used ONLY to find the right footprint.
 *
 * The coordinate does not have to be accurate, and that is the point of doing
 * it this way: each entry is matched to the NEAREST FOOTPRINT CENTROID within
 * MATCH_RADIUS_M whose area is at least MATCH_MIN_AREA_M2, one-to-one, and the
 * baker PRINTS the match distance and area for every row. An entry that lands
 * on the wrong building shows up as an implausible area or a large distance in
 * the report rather than as a silently misplaced tower.
 *
 * Buildings that are already modelled landmarks (Columbia Center, the Space
 * Needle, Smith Tower, Rainier Tower, the stadiums) are NOT here. They keep
 * their real modelled geometry and landmarks.js punches a keep-out disc for
 * each one, so a generic extrusion can never replace them.
 */
const PUBLISHED_HEIGHTS = [
  // --- Seattle CBD ---
  { name: 'Rainier Square Tower', h: 259.4, lat: 47.6099, lon: -122.3343 },
  { name: 'F5 Tower', h: 201.2, lat: 47.6053, lon: -122.3300 },
  { name: 'Safeco Plaza', h: 191.1, lat: 47.6049, lon: -122.3320 },
  { name: 'Russell Investments Center', h: 182.3, lat: 47.6112, lon: -122.3378 },
  { name: 'Wells Fargo Center', h: 175.0, lat: 47.6046, lon: -122.3339 },
  { name: 'Madison Centre', h: 168.6, lat: 47.6091, lon: -122.3316 },
  { name: 'Fourth and Madison Building', h: 152.4, lat: 47.6058, lon: -122.3323 },
  { name: 'Second and Seneca Building', h: 145.4, lat: 47.6071, lon: -122.3363 },
  { name: '1000 Second Avenue', h: 141.4, lat: 47.6036, lon: -122.3348 },
  { name: 'Union Bank of California Center', h: 143.0, lat: 47.6064, lon: -122.3310 },
  { name: '1111 Third Avenue', h: 126.0, lat: 47.6062, lon: -122.3347 },
  { name: 'Century Square', h: 120.4, lat: 47.6099, lon: -122.3376 },
  { name: 'IBM Building', h: 92.0, lat: 47.6068, lon: -122.3327 },
  { name: 'Seattle Tower', h: 82.3, lat: 47.6069, lon: -122.3355 },
  { name: 'Norton Building', h: 100.0, lat: 47.6041, lon: -122.3340 },
  { name: 'Hyatt Regency Seattle', h: 137.0, lat: 47.6135, lon: -122.3335 },
  { name: 'Premiere on Pine', h: 134.0, lat: 47.6127, lon: -122.3345 },
  { name: 'Insignia South Tower', h: 122.0, lat: 47.6178, lon: -122.3420 },
  { name: 'Insignia North Tower', h: 122.0, lat: 47.6182, lon: -122.3417 },
  { name: 'Escala', h: 96.0, lat: 47.6122, lon: -122.3390 },
  { name: 'Westin Seattle North Tower', h: 141.0, lat: 47.6132, lon: -122.3390 },
  { name: 'Westin Seattle South Tower', h: 111.0, lat: 47.6128, lon: -122.3387 },
  { name: 'The Emerald', h: 132.0, lat: 47.6118, lon: -122.3398 },
  { name: 'Nexus', h: 134.0, lat: 47.6167, lon: -122.3330 },
  { name: 'Kiara', h: 134.0, lat: 47.6205, lon: -122.3355 },
  { name: '1918 Eighth Avenue', h: 137.0, lat: 47.6157, lon: -122.3373 },
  { name: 'Amazon Doppler', h: 159.0, lat: 47.6155, lon: -122.3390 },
  { name: 'Amazon Day 1 Tower', h: 159.0, lat: 47.6152, lon: -122.3365 },
  { name: 'Fifteen Twenty-One Second Avenue', h: 134.0, lat: 47.6087, lon: -122.3396 },
  { name: 'Metropolitan Park East', h: 91.0, lat: 47.6150, lon: -122.3290 },
  // `maxArea` overrides the slab guard for the handful of buildings whose
  // source polygon legitimately merges a tower with its full-block podium, or
  // which really are one enormous low slab. Stated per entry, not globally.
  { name: 'Washington State Convention Center', h: 45.0, lat: 47.6115, lon: -122.3315, maxArea: 40000 },
  // --- Bellevue CBD ---
  { name: 'Bellevue 600', h: 183.0, lat: 47.6155, lon: -122.2010, maxArea: 18000 },
  { name: 'Lincoln Square South', h: 137.0, lat: 47.6160, lon: -122.2020, maxArea: 18000 },
  { name: 'Bellevue Towers North', h: 137.0, lat: 47.6135, lon: -122.2013, maxArea: 12000 },
  { name: 'Bellevue Towers South', h: 122.0, lat: 47.6131, lon: -122.2016 },
  { name: 'City Center Bellevue', h: 122.0, lat: 47.6146, lon: -122.1970 },
  { name: 'Symetra Center', h: 111.0, lat: 47.6127, lon: -122.1966 },
];

const MATCH_RADIUS_M = 90;
const MATCH_MIN_AREA_M2 = 380;
/**
 * A tower's own footprint is a tower's own footprint. Without an upper bound
 * the nearest-centroid match happily lands a 134 m residential tower on the
 * 10,674 m2 full-block garage next door and draws a slab the size of a
 * shopping centre standing 40 storeys tall — which is a far more visible error
 * than simply falling back to the derived height. Measured over the matched
 * set, every genuine tower footprint here is between 550 and 4,700 m2, and the
 * things above 9,000 are malls, convention halls and full-block garages.
 */
const MATCH_MAX_AREA_M2 = 9000;

// ---------------------------------------------------------------------------
// Source download
// ---------------------------------------------------------------------------

/** Downloads land in node_modules/.cache, which is already gitignored and is
 *  not anyone's source tree. 150 MB of shards should be fetched once. */
const CACHE = resolve(ROOT, 'node_modules/.cache/ken-buildings');

const GLOBAL_RELEASE = '2026-02-03';
const GLOBAL_BASE =
  `https://minedbuildings.z5.web.core.windows.net/global-buildings/${GLOBAL_RELEASE}` +
  '/global-buildings.geojsonl/RegionName=UnitedStates';

/**
 * The four z9 quadkeys covering the inset, with the part filenames from
 * dataset-links.csv. Pinned rather than re-derived at bake time so a bake is
 * reproducible and does not depend on a 7 MB index staying at the same URL;
 * `--relink` re-reads the index and prints any change.
 */
const GLOBAL_SHARDS = [
  { qk: '021230021', part: 'part-00115-4feead82-d499-422b-94cb-c036c212127a.c000.csv.gz' },
  { qk: '021230023', part: 'part-00141-4feead82-d499-422b-94cb-c036c212127a.c000.csv.gz' },
  { qk: '021230030', part: 'part-00131-4feead82-d499-422b-94cb-c036c212127a.c000.csv.gz' },
  { qk: '021230032', part: 'part-00087-4feead82-d499-422b-94cb-c036c212127a.c000.csv.gz' },
];

const LEGACY_URL =
  'https://minedbuildings.z5.web.core.windows.net/legacy/usbuildings-v2/Washington.geojson.zip';

async function download(url, dest) {
  if (existsSync(dest) && statSync(dest).size > 0) {
    console.log(`  cached ${dest.split('/').pop()}  (${(statSync(dest).size / 1e6).toFixed(1)} MB)`);
    return dest;
  }
  mkdirSync(CACHE, { recursive: true });
  const t0 = Date.now();
  const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
  if (!res.ok) throw new Error(`GET ${url} -> HTTP ${res.status} ${res.statusText}`);
  await pipeline(Readable.fromWeb(res.body), createWriteStream(dest));
  const mb = statSync(dest).size / 1e6;
  console.log(`  fetched ${dest.split('/').pop()}  ${mb.toFixed(1)} MB in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  return dest;
}

/**
 * Byte offset of the payload inside a stored zip entry, read from the local
 * file header. The whole entry is one deflate stream, so inflateRaw over a
 * read stream starting here yields the file without ever holding 927 MB.
 */
async function zipEntryOffset(path) {
  const fh = await open(path, 'r');
  try {
    const hdr = Buffer.alloc(30);
    await fh.read(hdr, 0, 30, 0);
    if (hdr.readUInt32LE(0) !== 0x04034b50) throw new Error('not a zip local file header');
    if (hdr.readUInt16LE(8) !== 8) throw new Error('zip entry is not deflate');
    const nameLen = hdr.readUInt16LE(26);
    const extraLen = hdr.readUInt16LE(28);
    const nb = Buffer.alloc(nameLen);
    await fh.read(nb, 0, nameLen, 30);
    return { offset: 30 + nameLen + extraLen, name: nb.toString('latin1') };
  } finally {
    await fh.close();
  }
}

/** Yields every line of the source, whichever source it is. */
async function* sourceLines() {
  if (SOURCE === 'legacy') {
    const dest = join(CACHE, 'Washington.geojson.zip');
    await download(LEGACY_URL, dest);
    const { offset, name } = await zipEntryOffset(dest);
    console.log(`  inflating ${name} from byte ${offset}`);
    const rl = createInterface({
      input: createReadStream(dest, { start: offset }).pipe(createInflateRaw()),
      crlfDelay: Infinity,
    });
    for await (const line of rl) yield line;
    return;
  }
  for (const s of GLOBAL_SHARDS) {
    const dest = join(CACHE, `${s.qk}.csv.gz`);
    await download(`${GLOBAL_BASE}/quadkey=${s.qk}/${s.part}`, dest);
    const rl = createInterface({
      input: createReadStream(dest).pipe(createGunzip()),
      crlfDelay: Infinity,
    });
    for await (const line of rl) yield line;
  }
}

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

/** Signed area (m2) and centroid of a ring given in metres. +ve is CCW. */
function ringAreaCentroid(e, n) {
  let a = 0;
  let cx = 0;
  let cz = 0;
  const k = e.length;
  for (let i = 0; i < k; i++) {
    const j = (i + 1) % k;
    const cr = e[i] * n[j] - e[j] * n[i];
    a += cr;
    cx += (e[i] + e[j]) * cr;
    cz += (n[i] + n[j]) * cr;
  }
  a *= 0.5;
  if (Math.abs(a) < 1e-9) return { area: 0, ce: e[0], cn: n[0] };
  return { area: a, ce: cx / (6 * a), cn: cz / (6 * a) };
}

/**
 * Douglas-Peucker on a closed ring, anchored on the two extreme points so the
 * result never collapses. Microsoft's outlines already carry a simplification,
 * but they still spend three vertices on a 30 cm jog in a wall; at 0.5 m this
 * removes about a fifth of them for no visible change at any altitude we fly.
 */
function simplifyRing(e, n, tol) {
  const k = e.length;
  if (k <= 4) return { e, n };
  // Anchor: the vertex pair furthest apart, so the split is stable.
  let i0 = 0;
  let i1 = 0;
  let best = -1;
  for (let i = 1; i < k; i++) {
    const d = (e[i] - e[0]) ** 2 + (n[i] - n[0]) ** 2;
    if (d > best) {
      best = d;
      i1 = i;
    }
  }
  const keep = new Uint8Array(k);
  keep[i0] = 1;
  keep[i1] = 1;

  const dp = (lo, hi) => {
    if (hi - lo < 2) return;
    const ax = e[lo % k];
    const ay = n[lo % k];
    const bx = e[hi % k];
    const by = n[hi % k];
    const dx = bx - ax;
    const dy = by - ay;
    const len = Math.hypot(dx, dy) || 1;
    let far = -1;
    let fi = -1;
    for (let i = lo + 1; i < hi; i++) {
      const d = Math.abs((e[i % k] - ax) * dy - (n[i % k] - ay) * dx) / len;
      if (d > far) {
        far = d;
        fi = i;
      }
    }
    if (far > tol && fi >= 0) {
      keep[fi % k] = 1;
      dp(lo, fi);
      dp(fi, hi);
    }
  };
  dp(i0, i1);
  dp(i1, i0 + k);

  const oe = [];
  const on = [];
  for (let i = 0; i < k; i++) {
    if (keep[i]) {
      oe.push(e[i]);
      on.push(n[i]);
    }
  }
  return oe.length >= 3 ? { e: oe, n: on } : { e, n };
}

/** Quantise to the output grid and drop vertices the grid merged or flattened. */
function quantiseRing(e, n) {
  const qe = [];
  const qn = [];
  for (let i = 0; i < e.length; i++) {
    const a = Math.round(e[i] / QUANT_M);
    const b = Math.round(n[i] / QUANT_M);
    if (qe.length && qe[qe.length - 1] === a && qn[qn.length - 1] === b) continue;
    qe.push(a);
    qn.push(b);
  }
  while (qe.length > 3 && qe[0] === qe[qe.length - 1] && qn[0] === qn[qn.length - 1]) {
    qe.pop();
    qn.pop();
  }
  // Collinear removal: three points on a line cost a vertex and change nothing.
  for (let pass = 0; pass < 2 && qe.length > 4; pass++) {
    for (let i = 0; i < qe.length && qe.length > 4; ) {
      const p = (i - 1 + qe.length) % qe.length;
      const q = (i + 1) % qe.length;
      const cr = (qe[i] - qe[p]) * (qn[q] - qn[i]) - (qn[i] - qn[p]) * (qe[q] - qe[i]);
      if (cr === 0) {
        qe.splice(i, 1);
        qn.splice(i, 1);
      } else i++;
    }
  }
  return { e: qe, n: qn };
}

// ---------------------------------------------------------------------------
// The height model
// ---------------------------------------------------------------------------

/** Deterministic hash -> [0,1). Same building, same height, every bake. */
function hash01(a, b) {
  let h = (Math.imul(a | 0, 0x27d4eb2d) ^ Math.imul(b | 0, 0x165667b1)) >>> 0;
  h ^= h >>> 15;
  h = Math.imul(h, 0x2545f491) >>> 0;
  h ^= h >>> 13;
  return h / 4294967296;
}

/** Above this the DSM has saturated and its number is discarded outright. */
const DSM_TRUST_M = 18;

/**
 * Storeys from the two signals that actually carry information: how big the
 * plan is, and how close to a district core it sits.
 *
 * `p` is the district's height ceiling at this distance, on a rational falloff
 * (half the ceiling at `falloffM`). A Gaussian was tried and is wrong for the
 * same reason it was wrong for the round-1 procedural mass: it collapses too
 * fast and leaves a carpet with two spikes in it.
 *
 * `s` is the characteristic plan dimension, sqrt(area). A 10 m square house
 * never becomes a tower whatever district it is in; a 55 m plan in the CBD is
 * a full-block tower. The exponent below 1 keeps the relationship sub-linear,
 * because plan size and height are correlated but weakly.
 *
 * The jitter multiplies the FRACTION, not the result, so it can never push a
 * suburban house above its district ceiling.
 */
function derivedStoreys(areaM2, district, distM, jitter) {
  if (!district) {
    // Background: big-box retail, warehouses, schools, hangars. One or two
    // storeys of great extent, which is what they are.
    return areaM2 >= 3000 ? 3 : 2;
  }
  const p = 1 / (1 + (distM / district.falloffM) ** 2.0);
  const s = Math.sqrt(areaM2);
  const plan = Math.min(1, Math.max(0, (s - 9) / (58 - 9))) ** 0.75;
  const f = p ** 1.35 * plan * (0.42 + 0.58 * jitter);
  return Math.max(1, Math.round(1 + (district.maxStoreys - 1) * f));
}

/**
 * Storeys -> metres. Two regimes, because a two-storey house and a forty-storey
 * tower do not have the same floor-to-floor and they do not have the same
 * amount of parapet and rooftop plant.
 */
function storeysToMetres(storeys) {
  return storeys <= 4 ? storeys * 3.15 + 1.6 : storeys * 3.65 + 3.4;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log(`\nbake-buildings  source=${SOURCE}${DRY ? '  (dry run)' : ''}`);
  console.log(
    `  inset ${INSET.south}..${INSET.north} lat, ${INSET.west}..${INSET.east} lon` +
      `  (${((INSET.north - INSET.south) * M_LAT / 1000).toFixed(0)} x ` +
      `${((INSET.east - INSET.west) * M_LON / 1000).toFixed(0)} km)`,
  );

  // Precompute district anchors in metres so the inner loop is arithmetic only.
  for (const d of DISTRICTS) {
    d.e = d.lon * M_LON;
    d.n = d.lat * M_LAT;
  }

  const t0 = Date.now();
  let scanned = 0;
  let inBox = 0;
  let dsmSaturated = 0;
  let dsmUsable = 0;
  let rejectedArea = 0;
  let rejectedDegenerate = 0;
  let srcVerts = 0;

  /** @type {{lat:number,lon:number,e:number[],n:number[],area:number,dsm:number,district:object|null,dist:number}[]} */
  const kept = [];

  for await (const line of sourceLines()) {
    if (line.length < 60) continue;
    scanned++;

    // Cheap prefilter on the ring's FIRST coordinate before paying for
    // JSON.parse. 1.43 M features in, 450 k survive; parsing all of them costs
    // about 40 s, parsing the survivors costs 6.
    const i = line.indexOf('[[[');
    if (i < 0) continue;
    const c = line.indexOf(',', i + 3);
    const lon0 = +line.slice(i + 3, c);
    const lat0 = +line.slice(c + 1, line.indexOf(']', c));
    if (lat0 < INSET.south || lat0 > INSET.north || lon0 < INSET.west || lon0 > INSET.east) continue;

    let o;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    const coords = o?.geometry?.coordinates?.[0];
    if (!Array.isArray(coords) || coords.length < 4) continue;
    inBox++;

    // Project to metres in the SAME anchored-equirectangular frame the runtime
    // uses (util.mjs SCALE_LAT mirrors coords.js). Absolute metres here; the
    // anchor is subtracted below.
    const e = new Array(coords.length);
    const n = new Array(coords.length);
    for (let k = 0; k < coords.length; k++) {
      e[k] = coords[k][0] * M_LON;
      n[k] = coords[k][1] * M_LAT;
    }
    // GeoJSON rings repeat the first point; the maths below wants them open.
    if (Math.abs(e[0] - e[e.length - 1]) < 1e-6 && Math.abs(n[0] - n[n.length - 1]) < 1e-6) {
      e.pop();
      n.pop();
    }
    if (e.length < 3) {
      rejectedDegenerate++;
      continue;
    }

    const { area: signed, ce, cn } = ringAreaCentroid(e, n);
    const area = Math.abs(signed);
    if (area < ABSOLUTE_MIN_AREA_M2) {
      rejectedArea++;
      continue;
    }
    // Normalise to CCW in (east, north).
    if (signed < 0) {
      e.reverse();
      n.reverse();
    }

    // District membership, by centroid.
    let district = null;
    let dist = Infinity;
    for (const d of DISTRICTS) {
      const dd = Math.hypot(ce - d.e, cn - d.n);
      if (dd <= d.radiusM && dd < dist) {
        district = d;
        dist = dd;
      }
    }
    const minArea = district ? district.minAreaM2 : BACKGROUND_MIN_AREA_M2;
    if (area < minArea) {
      rejectedArea++;
      continue;
    }

    const dsm = Number(o?.properties?.height);
    if (Number.isFinite(dsm) && dsm > 0) {
      if (dsm > DSM_TRUST_M) dsmSaturated++;
      else dsmUsable++;
    }

    srcVerts += e.length;
    kept.push({
      lat: cn / M_LAT,
      lon: ce / M_LON,
      ce,
      cn,
      e,
      n,
      area,
      dsm: Number.isFinite(dsm) ? dsm : 0,
      district,
      dist,
    });
  }

  const scanSec = (Date.now() - t0) / 1000;
  console.log(
    `\n  scanned ${scanned.toLocaleString()} features, ${inBox.toLocaleString()} inside the inset, ` +
      `kept ${kept.length.toLocaleString()}  (${scanSec.toFixed(1)} s)`,
  );
  console.log(
    `  rejected: ${rejectedArea.toLocaleString()} below the district area floor, ` +
      `${rejectedDegenerate} degenerate`,
  );
  if (SOURCE === 'global') {
    console.log(
      `  DSM height: ${dsmUsable.toLocaleString()} at or below ${DSM_TRUST_M} m (kept as storeys), ` +
        `${dsmSaturated.toLocaleString()} above it (DISCARDED — the sensor saturates near 35 m)`,
    );
  }

  // -------------------------------------------------------------------------
  // Match the published heights
  // -------------------------------------------------------------------------
  console.log('\npublished heights — every match is printed, so a bad row is visible');
  const takenBy = new Map(); // index -> name
  let matched = 0;
  for (const p of PUBLISHED_HEIGHTS) {
    const pe = p.lon * M_LON;
    const pn = p.lat * M_LAT;
    let bi = -1;
    let bd = Infinity;
    for (let i = 0; i < kept.length; i++) {
      const b = kept[i];
      if (b.area < MATCH_MIN_AREA_M2 || b.area > (p.maxArea ?? MATCH_MAX_AREA_M2)) continue;
      if (takenBy.has(i)) continue;
      const d = Math.hypot(b.ce - pe, b.cn - pn);
      if (d < bd) {
        bd = d;
        bi = i;
      }
    }
    if (bi < 0 || bd > MATCH_RADIUS_M) {
      console.log(`  MISS ${p.name.padEnd(34)} nothing within ${MATCH_RADIUS_M} m — falls back to derived`);
      continue;
    }
    takenBy.set(bi, p.name);
    kept[bi].publishedH = p.h;
    kept[bi].publishedName = p.name;
    matched++;
    console.log(
      `  ok   ${p.name.padEnd(34)} ${String(p.h.toFixed(1)).padStart(6)} m  ` +
        `${bd.toFixed(0).padStart(3)} m away, footprint ${kept[bi].area.toFixed(0).padStart(5)} m2`,
    );
  }
  console.log(`  ${matched} of ${PUBLISHED_HEIGHTS.length} published heights matched a footprint`);

  // -------------------------------------------------------------------------
  // Heights
  // -------------------------------------------------------------------------
  const prov = { published: 0, derived: 0, dsm: 0 };
  for (const b of kept) {
    if (b.publishedH) {
      b.h = b.publishedH;
      b.src = 'p';
      prov.published++;
      continue;
    }
    const jitter = hash01(Math.round(b.ce * 4), Math.round(b.cn * 4));
    const st = derivedStoreys(b.area, b.district, b.dist, jitter);
    // The DSM is only allowed to speak where it cannot be saturated: the
    // low-rise fabric. Inside a high-ceiling district it was measured reading
    // 15.5 m median for full-block downtown buildings, so letting it win there
    // flattens the whole CBD to four storeys — which is exactly the failure
    // this round is supposed to fix.
    const lowRiseDistrict = !b.district || b.district.maxStoreys <= 8;
    if (lowRiseDistrict && st <= 4 && b.dsm > 2 && b.dsm <= DSM_TRUST_M) {
      // The DSM saw this roof and it is inside the range where it has not
      // saturated. Take the storey count from it, not the metres.
      const dsmSt = Math.min(5, Math.max(1, Math.round(b.dsm / 3.2)));
      b.h = storeysToMetres(dsmSt);
      b.src = 'm';
      prov.dsm++;
    } else {
      b.h = storeysToMetres(st);
      b.src = 'd';
      prov.derived++;
    }
  }

  // -------------------------------------------------------------------------
  // Simplify, quantise, order
  // -------------------------------------------------------------------------
  let outVerts = 0;
  for (const b of kept) {
    // Tolerance scales with the building: a 0.5 m jog matters on a 20 m tower
    // face and does not on a 200 m warehouse wall.
    const tol = b.h > 40 ? 0.4 : Math.min(1.4, 0.5 + Math.sqrt(b.area) / 90);
    const s = simplifyRing(b.e, b.n, tol);
    const q = quantiseRing(s.e, s.n);
    if (q.e.length < 3) {
      b.drop = true;
      continue;
    }
    b.qe = q.e;
    b.qn = q.n;
    outVerts += q.e.length;
  }
  const out = kept.filter((b) => !b.drop);

  // Chunk-major order (1.5 km cells, row-major) so anchor deltas stay tiny and
  // the runtime's spatial chunks are contiguous slices of the file.
  const CHUNK_M = 3000;
  for (const b of out) {
    b.cx = Math.floor(b.ce / CHUNK_M);
    b.cz = Math.floor(b.cn / CHUNK_M);
  }
  out.sort((a, b) => a.cz - b.cz || a.cx - b.cx || a.ce - b.ce);

  // -------------------------------------------------------------------------
  // Encode
  // -------------------------------------------------------------------------
  const anchors = [];
  const rings = [];
  const heights = [];
  let src = '';
  let pLat = 0;
  let pLon = 0;

  for (const b of out) {
    // The anchor is the ring's FIRST vertex, not the centroid: then the first
    // ring delta is zero and the rest are wall-length sized.
    const aLat = Math.round((b.qn[0] * QUANT_M) / M_LAT / QUANT_DEG);
    const aLon = Math.round((b.qe[0] * QUANT_M) / M_LON / QUANT_DEG);
    anchors.push(aLat - pLat, aLon - pLon);
    pLat = aLat;
    pLon = aLon;

    // Re-derive the anchor's quantised metres so the ring deltas close exactly
    // on the anchor the runtime will reconstruct, not on the pre-rounding one.
    const a0e = Math.round(((aLon * QUANT_DEG) * M_LON) / QUANT_M);
    const a0n = Math.round(((aLat * QUANT_DEG) * M_LAT) / QUANT_M);

    rings.push(b.qe.length);
    let ke = a0e;
    let kn = a0n;
    for (let i = 0; i < b.qe.length; i++) {
      rings.push(b.qe[i] - ke, b.qn[i] - kn);
      ke = b.qe[i];
      kn = b.qn[i];
    }
    heights.push(Math.round(b.h * 10));
    src += b.src;
  }

  const payload = {
    generated: new Date().toISOString(),
    source:
      SOURCE === 'global'
        ? `Microsoft Building Footprints — global-buildings, release ${GLOBAL_RELEASE} (US)`
        : 'Microsoft Building Footprints — legacy usbuildings-v2, Washington',
    sourceUrl: SOURCE === 'global' ? GLOBAL_BASE : LEGACY_URL,
    note:
      'FOOTPRINT polygons are real: position, outline, orientation and area come ' +
      'from the source and are not modified beyond a documented simplification. ' +
      'HEIGHTS are NOT surveyed except where src="p". src="p" is a published ' +
      'architectural height matched to this footprint by proximity; src="m" is a ' +
      'storey count read from Microsoft\'s DSM height below ' + DSM_TRUST_M + ' m; ' +
      'src="d" is derived from footprint area and distance to a district core by ' +
      'the model in scripts/bake-buildings.mjs#derivedStoreys. The DSM height ' +
      'field saturates near 35 m (Columbia Center, 284 m, reads 25.1 m) and is ' +
      'discarded above ' + DSM_TRUST_M + ' m rather than rescaled.',
    bbox: INSET,
    quantM: QUANT_M,
    quantDeg: QUANT_DEG,
    scaleLat: SCALE_LAT,
    chunkM: CHUNK_M,
    count: out.length,
    provenance: prov,
    districts: DISTRICTS.map((d) => ({
      name: d.name,
      lat: d.lat,
      lon: d.lon,
      maxStoreys: d.maxStoreys,
      falloffM: d.falloffM,
      radiusM: d.radiusM,
      minAreaM2: d.minAreaM2,
    })),
    publishedNames: out.filter((b) => b.publishedName).map((b) => b.publishedName),
    anchors,
    rings,
    heights,
    src,
  };

  // -------------------------------------------------------------------------
  // Report
  // -------------------------------------------------------------------------
  const hs = out.map((b) => b.h).sort((a, b) => a - b);
  const pct = (p) => hs[Math.min(hs.length - 1, Math.floor(hs.length * p))];
  const tris = out.reduce((a, b) => a + 2 * b.qe.length + (b.qe.length - 2), 0);
  console.log('\nselection');
  console.log(`  buildings           ${out.length.toLocaleString()}`);
  console.log(`  ring vertices       ${outVerts.toLocaleString()} (source ${srcVerts.toLocaleString()}, ${(100 - (100 * outVerts) / srcVerts).toFixed(0)}% removed)`);
  console.log(`  mean vertices/bldg  ${(outVerts / out.length).toFixed(1)}`);
  console.log(`  extruded triangles  ${tris.toLocaleString()}`);
  console.log(`  height p50 / p90 / p99 / max   ${pct(0.5).toFixed(1)} / ${pct(0.9).toFixed(1)} / ${pct(0.99).toFixed(1)} / ${hs[hs.length - 1].toFixed(1)} m`);
  console.log(`  >= 100 m            ${out.filter((b) => b.h >= 100).length}   (Seattle+Bellevue published count is ~55)`);
  console.log(`  >= 150 m            ${out.filter((b) => b.h >= 150).length}`);
  console.log(`  provenance          published ${prov.published}, DSM storeys ${prov.dsm}, derived ${prov.derived}`);
  const chunks = new Set(out.map((b) => `${b.cx}/${b.cz}`));
  console.log(`  ${CHUNK_M} m chunks       ${chunks.size} occupied`);

  console.log('\ntallest 16 — eyeball this, a derived tower on a mall roof shows up here');
  for (const b of out.slice().sort((x, y) => y.h - x.h).slice(0, 16)) {
    console.log(
      `  ${b.h.toFixed(1).padStart(6)} m  src=${b.src}  ${b.area.toFixed(0).padStart(6)} m2  ` +
        `${(b.district ? b.district.name : 'background').padEnd(22)} ` +
        `${b.lat.toFixed(4)},${b.lon.toFixed(4)}  ${b.publishedName ?? ''}`,
    );
  }
  for (const d of DISTRICTS) {
    const set = out.filter((b) => b.district === d);
    if (!set.length) continue;
    const mx = set.reduce((a, b) => (a > b.h ? a : b.h), 0);
    console.log(
      `  ${d.name.padEnd(24)} n=${String(set.length).padStart(5)}  tallest ${mx.toFixed(0).padStart(4)} m  ` +
        `ceiling ${storeysToMetres(d.maxStoreys).toFixed(0)} m  >=50 m: ${set.filter((b) => b.h >= 50).length}`,
    );
  }

  if (DRY) {
    const text = JSON.stringify(payload);
    console.log(`\n  dry run — would write ${(text.length / 1048576).toFixed(2)} MB\n`);
    return;
  }
  await writeJson('data/buildings.json', payload);
  console.log(`\n  done in ${((Date.now() - t0) / 1000).toFixed(1)} s\n`);
}

main().catch((err) => {
  console.error('\nbake-buildings FAILED:', err.message);
  process.exit(1);
});
