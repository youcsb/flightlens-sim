/**
 * assets.js — resolve URLs for baked data files under public/.
 *
 * vite.config.js sets `base: './'` so the built app can be opened from any
 * subdirectory. That means a bare fetch('/data/airports.json') breaks in the
 * production build. ALWAYS route runtime asset fetches through assetUrl().
 *
 *   assetUrl('data/airports.json')  ->  './data/airports.json'   (dev + build)
 *   assetUrl('dem/11/331/721.png')  ->  './dem/11/331/721.png'
 *
 * Pass paths WITHOUT a leading slash.
 */

/** Vite injects this; it is '/' in dev and './' in the build. */
const BASE = import.meta.env?.BASE_URL ?? '/';

/**
 * @param {string} rel Path relative to the public/ directory, no leading slash.
 * @returns {string} A URL safe to fetch() in both dev and the production build.
 */
export function assetUrl(rel) {
  const clean = String(rel).replace(/^\/+/, '');
  return BASE.endsWith('/') ? BASE + clean : `${BASE}/${clean}`;
}

/**
 * fetch() JSON from public/, returning `fallback` instead of throwing when the
 * file is missing.
 *
 * The eight subsystems are built in parallel, so at any moment the baked data
 * may not exist yet. Every loader in src/geo/ uses this so a missing bake
 * degrades to an empty world instead of a white screen. Real network/parse
 * failures are logged once, not swallowed silently.
 *
 * @template T
 * @param {string} rel Path relative to public/.
 * @param {T} fallback Returned on 404 or parse failure.
 * @returns {Promise<T>}
 */
export async function fetchJsonOrNull(rel, fallback = null) {
  const url = assetUrl(rel);
  const missing = () => {
    console.warn(
      `[assets] ${url} not found. Run \`npm run bake\` to generate it. ` +
        'Continuing without it.',
    );
    return fallback;
  };

  try {
    const res = await fetch(url);
    if (!res.ok) return missing();

    // Vite's dev server answers an unknown path with index.html and a 200
    // rather than a 404, so res.ok is not enough to conclude the file exists.
    // Without this check a missing bake surfaces as a baffling
    // "Unexpected token '<'" JSON parse error instead of "not found".
    const type = res.headers.get('content-type') || '';
    if (!type.includes('json')) return missing();

    return await res.json();
  } catch (err) {
    console.warn(`[assets] ${url} failed to load:`, err);
    return fallback;
  }
}
