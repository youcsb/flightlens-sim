/**
 * geoBudgets.js — hand the resolved device budget to the two geo modules that
 * hold real memory, in one call, before anything loads.
 *
 * Contract: see MODULES.md §2.19
 *
 *   applyGeoBudgets(budgets) -> {dem, landcover}
 *
 * ---------------------------------------------------------------------------
 * WHY THIS FILE EXISTS AT ALL
 * ---------------------------------------------------------------------------
 * `core/device.js` must stay pure — no imports, no three, no DOM at module
 * scope — because that is the only reason `check-device.mjs` can run the
 * shipping classifier in Node (§2.18). So device.js cannot reach into
 * elevation.js or landcover.js and configure them.
 *
 * And the two geo modules must not reach the other way either: `elevation.js`
 * is imported by `check-elevation.mjs` and has no business probing a WebGL
 * context, and `landcover.js` imports three.
 *
 * That leaves the application to join them up. `main.js` already resolves the
 * device and holds `budgets`; this is the one line it needs, and putting the
 * mapping here rather than inline keeps the seam in a file that the geo
 * checks can import and assert against.
 *
 * ---------------------------------------------------------------------------
 * IT MUST RUN BEFORE createTerrain()
 * ---------------------------------------------------------------------------
 * `createTerrain()` calls `loadRegion()` and `loadLandcover()`. Both of those
 * are boot-time-only decisions: a DEM layer's tile budget is baked into the
 * layer when it is registered, and the land-cover rasters are decoded exactly
 * once. `configurePaging()` does cope with being called later — it re-derives
 * every paged layer and evicts on the spot — but `configureLandcover()` does
 * not, because there is nothing to re-apply to a texture that already exists.
 *
 * §1.6: nothing here throws. A missing or malformed budget leaves both modules
 * on their desktop defaults, which is a heavy world, not a broken one.
 */

import { configurePaging, getPagingConfig } from './elevation.js';
import { configureLandcover, getLandcoverConfig } from './landcover.js';

/**
 * Apply a resolved `Budgets` object (from `core/device.js#budgetsFor`) to the
 * elevation pager and the land-cover rasters.
 *
 * @param {{tier?: string, demCapBytes?: number, demPagingPolicy?: object}} [budgets]
 * @returns {{dem: object, landcover: object}} what is actually in force
 */
export function applyGeoBudgets(budgets) {
  if (budgets && typeof budgets === 'object') {
    configurePaging({
      capBytes: budgets.demCapBytes,
      policy: budgets.demPagingPolicy,
    });
    // The tier NAME is the land-cover knob, not a byte count: the rasters are
    // two fixed files, so the only lever is how far they are decimated, and
    // that is a per-tier table in landcover.js (§ TIERS there).
    configureLandcover(budgets.tier);
  }
  return { dem: getPagingConfig(), landcover: getLandcoverConfig() };
}

/** One line for the console, so a bug report says what the geo budget was. */
export function describeGeoBudgets(applied = { dem: getPagingConfig(), landcover: getLandcoverConfig() }) {
  const p = Object.entries(applied.dem.policy)
    .map(([z, v]) => `z${z} ${(v.radiusM / 1000).toFixed(0)}km/${v.budgetTiles}`)
    .join(' ');
  const lc = applied.landcover;
  return (
    `[geo] DEM cap ${(applied.dem.capBytes / 1048576).toFixed(0)} MiB (${p}) | ` +
    `landcover 1/${lc.region} region, 1/${lc.detail} detail`
  );
}
