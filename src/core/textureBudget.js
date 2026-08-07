/**
 * textureBudget.js — one number, shared by every module that DRAWS a texture.
 *
 * Contract: see MODULES.md §2.20
 *
 *   configureTextures(tier) -> {tier, scale}   // boot-time, once
 *   texSize(px)             -> integer         // per texture dimension
 *   textureScale()          -> number
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS A MODULE AND NOT A createX() OPTION
 * ---------------------------------------------------------------------------
 * Nothing in this sim ships an image file. The fuselage livery, the wing skin,
 * the runway numeral atlas and the terrain's region field are all generated at
 * boot, in four different modules, by functions that take no options because
 * they had no reason to. Threading a scale through four call chains — one of
 * which is `buildRunwayMeshes(scene, airports)`, a signature MODULES.md §2.5
 * publishes — would change four public shapes to move one scalar.
 *
 * So it is the same seam `geo/landcover.js` already uses for its raster tier:
 * a module-scope setting, chosen ONCE at boot before anything is built, with a
 * default that is the desktop behaviour exactly. `main.js` sets it next to
 * `applyGeoBudgets()`; every check script that imports a generator gets the
 * default and therefore measures the desktop numbers MODULES.md quotes.
 *
 * ---------------------------------------------------------------------------
 * IT IS BOOT-TIME ONLY, AND THAT IS NOT A LIMITATION TO APOLOGISE FOR
 * ---------------------------------------------------------------------------
 * A texture is rasterised once. Re-running `configureTextures()` later cannot
 * change a canvas that already exists, and pretending it can is hidden state.
 * `window.sim.setQuality()` says so out loud, alongside the DEM cap and the
 * terrain LOD quality, which are boot-time for the same reason. `?tier=phone`
 * is how you get it from frame 0.
 *
 * ---------------------------------------------------------------------------
 * THE ONE RULE FOR CALLERS
 * ---------------------------------------------------------------------------
 * SCALE THE CANVAS, NOT THE COORDINATES. Every generator in this project draws
 * in texel space — `20px` fonts, one-texel rivet dots, a 256-texel glyph cell.
 * If you allocate a half-size canvas and leave the drawing code alone, the pen
 * stays the same size and every mark on the texture doubles. The pattern is:
 *
 *     const W = 2048, H = 1024;                 // the DESIGN size, unchanged
 *     const cv = makeCanvas(texSize(W), texSize(H));
 *     const ctx = cv.getContext('2d');
 *     ctx.scale(cv.width / W, cv.height / H);   // now draw in design space
 *
 * so the only thing that changes is how finely the same picture is sampled.
 *
 * §1.6: an unknown tier keeps the desktop scale and warns. Nothing throws.
 */

import { budgetsFor } from './device.js';

/**
 * Smallest dimension we will ever hand back. A 64-texel axis is one glyph cell
 * at a quarter scale, and below that a mipmapped texture is mostly its own
 * lowest level.
 */
export const MIN_TEXTURE_PX = 64;

let scale = 1;
let tierName = 'desktop';

/**
 * Choose the tier. Call once at boot, BEFORE anything builds a texture.
 *
 * @param {string|number} tier a tier name from core/device.js, or an explicit
 *        numeric scale in (0, 1] for a harness that wants to sweep it
 * @returns {{tier: string, scale: number}} what is in force
 */
export function configureTextures(tier) {
  if (typeof tier === 'number') {
    if (Number.isFinite(tier) && tier > 0 && tier <= 1) {
      scale = tier;
      tierName = `explicit ${tier}`;
    } else {
      console.warn(`[texture] scale ${tier} is not in (0, 1]; keeping ${scale}.`);
    }
    return getTextureConfig();
  }
  const name = String(tier ?? '');
  const b = budgetsFor(name);
  // budgetsFor() falls back to desktop for an unknown name (§1.6). Say so,
  // because silently rendering a phone at desktop texture sizes is the kind of
  // thing that only shows up as a tab termination on a real device.
  if (b.tier !== name) {
    console.warn(`[texture] unknown tier "${name}"; keeping the desktop textures.`);
  }
  const s = Number(b.textureScale);
  scale = Number.isFinite(s) && s > 0 && s <= 1 ? s : 1;
  tierName = b.tier;
  return getTextureConfig();
}

/** The configuration in force. A copy — mutating it changes nothing. */
export function getTextureConfig() {
  return { tier: tierName, scale };
}

/** The linear scale in force. 1 means "ship the design size". */
export function textureScale() {
  return scale;
}

/**
 * A design-space dimension, in texels, at the tier in force.
 *
 * Rounded to an EVEN number so a half-scale power of two stays a power of two
 * and a mip chain does not pick up an odd level, and floored at
 * MIN_TEXTURE_PX so a small design size cannot be scaled into nothing.
 *
 * @param {number} px the design size — the number the desktop ships
 * @returns {number} integer texels
 */
export function texSize(px) {
  const n = Number(px);
  if (!Number.isFinite(n) || n <= 0) return MIN_TEXTURE_PX;
  const scaled = Math.round((n * scale) / 2) * 2;
  return Math.max(MIN_TEXTURE_PX, Math.min(Math.round(n), scaled));
}

/** One line for the console, so a bug report says what the textures cost. */
export function describeTextureBudget(cfg = getTextureConfig()) {
  return `[texture] ${cfg.tier} scale ${cfg.scale} (${(cfg.scale * cfg.scale * 100).toFixed(0)}% of the texels)`;
}
