/**
 * util.mjs — shared plumbing for the bake scripts. Node only, never bundled.
 *
 * This file is complete and contains no design decisions. The bakers that
 * import it are the ones with the interesting logic.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Repository root, derived from this file's location. */
export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

/** public/ — anything written here is served same-origin at runtime. */
export const PUBLIC_DIR = resolve(ROOT, 'public');

/**
 * The region we bake. MUST match REGION_BBOX in src/geo/coords.js. If you
 * change one, change both — there is no import path from a Node script into the
 * browser bundle, so this is duplicated on purpose and kept honest by review.
 */
export const REGION_BBOX = Object.freeze({
  south: 46.4,
  north: 48.3,
  west: -123.4,
  east: -121.2,
});

/** Identify ourselves to public APIs. Wikidata rejects blank user agents. */
export const USER_AGENT =
  'KenFlightSim/0.1 (build-time data bake; three.js flight simulator)';

// ---------------------------------------------------------------------------
// Slippy tile maths — mirrors src/geo/coords.js
// ---------------------------------------------------------------------------

export const lonToTileXFloat = (lon, z) => ((lon + 180) / 360) * 2 ** z;

export const latToTileYFloat = (lat, z) => {
  const r = (lat * Math.PI) / 180;
  return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z;
};

/**
 * Inclusive tile-index rectangle covering a bbox.
 * @returns {{minX:number,maxX:number,minY:number,maxY:number,count:number}}
 */
export function tileRange(bbox, z) {
  const minX = Math.floor(lonToTileXFloat(bbox.west, z));
  const maxX = Math.floor(lonToTileXFloat(bbox.east, z));
  // Mercator Y grows southward, so `north` yields the LOW index.
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

export const inBbox = (lat, lon, bbox) =>
  lat >= bbox.south &&
  lat <= bbox.north &&
  lon >= bbox.west &&
  lon <= bbox.east;

// ---------------------------------------------------------------------------
// Local projection — mirrors src/geo/coords.js, for length/heading validation
// ---------------------------------------------------------------------------

const D = Math.PI / 180;

export const metresPerDegreeLat = (lat) =>
  111132.92 -
  559.82 * Math.cos(2 * lat * D) +
  1.175 * Math.cos(4 * lat * D) -
  0.0023 * Math.cos(6 * lat * D);

export const metresPerDegreeLon = (lat) =>
  111412.84 * Math.cos(lat * D) -
  93.5 * Math.cos(3 * lat * D) +
  0.118 * Math.cos(5 * lat * D);

/** Scene origin — must match DEFAULT_ORIGIN in src/geo/coords.js (KBFI ARP). */
export const ORIGIN = Object.freeze({ lat: 47.527042, lon: -122.29995 });

/**
 * Latitude the scale factors are evaluated at — must match SCALE_LAT in
 * src/geo/coords.js. NOT the origin latitude: position anchor and scale anchor
 * are decoupled so that moving the origin cannot rescale the world. Baked
 * headings and lengths are validated in this projection, so if this drifts from
 * the runtime value, runways will be baked at subtly wrong angles.
 */
export const SCALE_LAT = (REGION_BBOX.south + REGION_BBOX.north) / 2;

const M_LAT = metresPerDegreeLat(SCALE_LAT);
const M_LON = metresPerDegreeLon(SCALE_LAT);

/** True bearing between two points, in the scene projection. Degrees, 0..360. */
export function bearingBetween(lat1, lon1, lat2, lon2) {
  const east = (lon2 - lon1) * M_LON;
  const north = (lat2 - lat1) * M_LAT;
  const d = (Math.atan2(east, north) * 180) / Math.PI;
  return d < 0 ? d + 360 : d;
}

/** Distance between two points, scene metres. */
export function distanceBetween(lat1, lon1, lat2, lon2) {
  const east = (lon2 - lon1) * M_LON;
  const north = (lat2 - lat1) * M_LAT;
  return Math.hypot(east, north);
}

// ---------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------

/**
 * RFC4180-ish CSV parser. Handles quoted fields and doubled quotes, which
 * OurAirports needs — airport names contain commas and apostrophes.
 *
 * @param {string} text
 * @returns {string[][]} Rows, including the header row.
 */
export function parseCSV(text) {
  const rows = [];
  let row = [];
  let cur = '';
  let quoted = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        cur += c;
      }
    } else if (c === '"') {
      quoted = true;
    } else if (c === ',') {
      row.push(cur);
      cur = '';
    } else if (c === '\n') {
      row.push(cur);
      cur = '';
      rows.push(row);
      row = [];
    } else if (c !== '\r') {
      cur += c;
    }
  }
  if (cur.length || row.length) {
    row.push(cur);
    rows.push(row);
  }
  return rows;
}

/**
 * Turn parsed CSV rows into objects keyed by the header row.
 * @param {string[][]} rows
 * @returns {Record<string,string>[]}
 */
export function rowsToObjects(rows) {
  const [header, ...body] = rows;
  return body
    .filter((r) => r.length === header.length)
    .map((r) => Object.fromEntries(header.map((h, i) => [h, r[i]])));
}

/** Parse to a number, or return `fallback` for blanks and junk. */
export function num(v, fallback = NaN) {
  if (v === undefined || v === null || v === '') return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

/** OurAirports writes booleans as "1"/"0". */
export const bool = (v) => v === '1' || v === 'yes' || v === 'true';

// ---------------------------------------------------------------------------
// I/O
// ---------------------------------------------------------------------------

/** GET with our user agent, throwing a useful message on failure. */
export async function get(url, headers = {}) {
  const res = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT, ...headers },
  });
  if (!res.ok) {
    throw new Error(`GET ${url} -> HTTP ${res.status} ${res.statusText}`);
  }
  return res;
}

/** Write JSON under public/, creating directories as needed. */
export async function writeJson(relPath, data) {
  const out = resolve(PUBLIC_DIR, relPath);
  await mkdir(dirname(out), { recursive: true });
  const text = JSON.stringify(data);
  await writeFile(out, text);
  console.log(
    `  wrote ${relPath}  (${(text.length / 1024).toFixed(1)} kB)`,
  );
  return out;
}

/** Write a binary file under public/, creating directories as needed. */
export async function writeBinary(relPath, buffer) {
  const out = resolve(PUBLIC_DIR, relPath);
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, buffer);
  return out;
}

/**
 * Run `worker` over `items` with bounded concurrency. Public APIs get unhappy
 * if you open 900 sockets at once.
 *
 * @template T, R
 * @param {T[]} items
 * @param {number} limit
 * @param {(item: T, index: number) => Promise<R>} worker
 * @returns {Promise<R[]>}
 */
export async function mapLimit(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, () =>
    (async () => {
      while (next < items.length) {
        const i = next++;
        results[i] = await worker(items[i], i);
      }
    })(),
  );
  await Promise.all(runners);
  return results;
}

/** Minimal `--key=value` / `--flag` argument parser. */
export function parseArgs(argv = process.argv.slice(2)) {
  const out = {};
  for (const a of argv) {
    const m = /^--([^=]+)(?:=(.*))?$/.exec(a);
    if (m) out[m[1]] = m[2] === undefined ? true : m[2];
  }
  return out;
}
