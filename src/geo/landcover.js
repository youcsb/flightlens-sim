/**
 * landcover.js — what is actually on the ground, from a published survey.
 *
 * Contract: see MODULES.md § landcover
 *
 *   loadLandcover() -> Promise<Landcover|null>
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS IS, AND WHY IT IS NOT "IMAGERY"
 * ---------------------------------------------------------------------------
 * §1.5 says geographic truth comes from data and surface texture is procedural.
 * A land-cover CLASSIFICATION sits on the truth side of that line: it is not a
 * photograph, it is fifteen integers per texel saying *what kind of ground this
 * is* — open water, evergreen forest, pasture, high-intensity development —
 * measured at 30 m by the USGS and published as NLCD 2021.
 *
 * The terrain material still invents every pixel it draws. It just stops
 * guessing what it is drawing. Before this module, the shader knew only height
 * and slope, so downtown Seattle, the Kent Valley farms and Discovery Park were
 * all the same lowland green — which is exactly what reads as "not a real
 * place" from 600 m. There is no height or slope test that can separate them,
 * because they are all flat and all near sea level. Only data can.
 *
 * Baked by scripts/bake-landcover.mjs; see that file for provenance.
 *
 * ---------------------------------------------------------------------------
 * TWO LAYERS, SAME RULE AS THE DEM
 * ---------------------------------------------------------------------------
 * region  2048 x 2560 over the whole bbox   ~81 m per texel
 * detail  1536 x 2048 over the Seattle inset ~20 m per texel
 *
 * The shader prefers `detail` where it exists. Same additive arrangement as
 * elevation.js's z=11 / z=13 layers, and for the same reason: the far field
 * does not need 20 m and could not afford it.
 *
 * ---------------------------------------------------------------------------
 * ENCODING — the textures are DATA, not pictures
 * ---------------------------------------------------------------------------
 *   R = NLCD class code (0 nodata, else 11..95). Provenance; unused at runtime.
 *   G = compact class index 0..15, the thing the shader indexes.
 *   B = road mask: 0 none, 160 secondary (US/state highways), 255 primary
 *       (Interstates), from TIGER/Line centrelines.
 *
 * Three things keep those bytes intact between the PNG and the sampler, and all
 * three are load-bearing:
 *   - colorSpace = NoColorSpace. Marking it SRGBColorSpace would have the GPU
 *     apply the sRGB->linear curve to a class INDEX, and class 9 would arrive
 *     as class 2.
 *   - NearestFilter on both min and mag, and generateMipmaps = false. Linear
 *     filtering of an index map interpolates between class 6 and class 9 and
 *     produces class 7 — a texel of barren rock along every urban/forest edge.
 *     The shader dissolves the resulting texel grid with a noise-jittered
 *     lookup instead, which is both cheaper and more like a real boundary.
 *   - flipY = false, so image row 0 is the NORTH edge and v runs south. The
 *     rect uniforms below assume exactly that.
 *
 * ---------------------------------------------------------------------------
 * NOTHING BLOCKS THE BOOT (§1.6)
 * ---------------------------------------------------------------------------
 * A missing or malformed bake resolves to null and the terrain falls back to
 * the elevation/slope-only palette it had before. The console says so once.
 */

import * as THREE from 'three';
import { llToLocal } from './coords.js';
import { assetUrl, fetchJsonOrNull } from '../core/assets.js';

/** Palette texture width. Must be >= the highest class index + 1. */
export const PALETTE_N = 16;

/**
 * The classes, in index order. `name` matches the NLCD legend the baker wrote
 * into manifest.json; if the two ever disagree, the baker is right and this
 * table is stale.
 *
 * albedo — sRGB, mid-morning, dry-season Puget Sound. Deliberately desaturated:
 *   this is the Pacific Northwest under a 40-degree sun, not a travel poster.
 *   Evergreen is nearly black-green because Douglas fir canopy from the air
 *   genuinely is; making it "forest green" is the single fastest way to make a
 *   scene look like a video game.
 * rough  — material roughness. Water's bed and wet ground read darker/shinier.
 * detail — how hard the near-field procedural layer modulates this class.
 * form   — which near-field STRUCTURE to draw:
 *            0 = organic mottle (canopy, scrub, bare ground)
 *            1 = parcel grid (fields, orchards — big cells, row texture)
 *            2 = street grid (developed — blocks, streets, roof variation)
 *          This is the part that survives below 500 m. A photo drape has
 *          nothing left at that range; a grid whose spacing is a real block
 *          size keeps producing edges all the way to the deck.
 * canopy — fraction of a DEVELOPED class that is actually tree cover. This is
 *          not decoration: seen from 300 m, "Developed, Low Intensity" in
 *          Seattle is mostly green — street trees and back gardens with roofs
 *          showing through — and painting it as flat pavement grey is the
 *          fastest way to make a real city look like a car park. It falls off
 *          steeply toward the downtown core, which genuinely is roofs.
 */
export const CLASSES = [
  { index: 0,  name: 'nodata',                       albedo: [0.30, 0.36, 0.24], rough: 0.95, detail: 0.5, form: 0, canopy: 0 },
  { index: 1,  name: 'Open Water',                   albedo: [0.055, 0.085, 0.10], rough: 0.55, detail: 0.1, form: 0, canopy: 0 },
  { index: 2,  name: 'Perennial Ice/Snow',           albedo: [0.90, 0.93, 0.98], rough: 0.58, detail: 0.4, form: 0, canopy: 0 },
  { index: 3,  name: 'Developed, Open Space',        albedo: [0.265, 0.320, 0.180], rough: 0.92, detail: 0.7, form: 2, canopy: 0.50 },
  { index: 4,  name: 'Developed, Low Intensity',     albedo: [0.315, 0.330, 0.255], rough: 0.90, detail: 1.0, form: 2, canopy: 0.62 },
  { index: 5,  name: 'Developed, Medium Intensity',  albedo: [0.375, 0.365, 0.335], rough: 0.86, detail: 1.0, form: 2, canopy: 0.34 },
  { index: 6,  name: 'Developed, High Intensity',    albedo: [0.430, 0.420, 0.405], rough: 0.80, detail: 1.0, form: 2, canopy: 0.10 },
  { index: 7,  name: 'Barren Land',                  albedo: [0.52, 0.49, 0.43], rough: 0.94, detail: 0.8, form: 0, canopy: 0 },
  { index: 8,  name: 'Deciduous Forest',             albedo: [0.235, 0.315, 0.155], rough: 0.96, detail: 1.0, form: 0, canopy: 0 },
  { index: 9,  name: 'Evergreen Forest',             albedo: [0.115, 0.185, 0.115], rough: 0.97, detail: 1.0, form: 0, canopy: 0 },
  { index: 10, name: 'Mixed Forest',                 albedo: [0.175, 0.255, 0.140], rough: 0.96, detail: 1.0, form: 0, canopy: 0 },
  { index: 11, name: 'Shrub/Scrub',                  albedo: [0.335, 0.335, 0.215], rough: 0.95, detail: 0.9, form: 0, canopy: 0 },
  { index: 12, name: 'Grassland/Herbaceous',         albedo: [0.415, 0.425, 0.265], rough: 0.94, detail: 0.7, form: 1, canopy: 0 },
  { index: 13, name: 'Pasture/Hay',                  albedo: [0.375, 0.450, 0.225], rough: 0.93, detail: 0.8, form: 1, canopy: 0 },
  { index: 14, name: 'Cultivated Crops',             albedo: [0.430, 0.395, 0.215], rough: 0.94, detail: 1.0, form: 1, canopy: 0 },
  { index: 15, name: 'Wetland',                      albedo: [0.225, 0.290, 0.185], rough: 0.90, detail: 0.8, form: 0, canopy: 0.25 },
];

/** @typedef {Object} LandcoverLayer
 *  @property {string} name
 *  @property {THREE.Texture} texture
 *  @property {THREE.Vector4} rect   (xMin, zMin, 1/width, 1/depth) in local metres
 *  @property {THREE.Vector2} texelM (x, z) metres per texel
 */

/** @typedef {Object} Landcover
 *  @property {LandcoverLayer|null} region
 *  @property {LandcoverLayer|null} detail
 *  @property {THREE.DataTexture} palette
 *  @property {Object} manifest
 *  @property {() => void} dispose
 */

/** Compact index for NLCD 11, Open Water. Mirrors CLASSES above. */
export const CLASS_WATER = 1;

let warned = false;

/**
 * Decode a baked PNG to raw RGBA bytes.
 *
 * Deliberately not TextureLoader: the CPU needs these bytes too. The region
 * water mask in world/terrain.js is built from `classAtLocal`, and a texture
 * that only exists on the GPU cannot answer that. One decode, two consumers —
 * the DataTexture below wraps the same array, so this costs nothing extra.
 */
async function decodeToRgba(url) {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const bitmap = await createImageBitmap(await res.blob());
    const w = bitmap.width;
    const h = bitmap.height;
    const canvas =
      typeof OffscreenCanvas !== 'undefined'
        ? new OffscreenCanvas(w, h)
        : Object.assign(document.createElement('canvas'), { width: w, height: h });
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) {
      bitmap.close?.();
      return null;
    }
    ctx.drawImage(bitmap, 0, 0);
    bitmap.close?.();
    // Same-origin, so this cannot taint. See scripts/README.md.
    return { width: w, height: h, data: new Uint8Array(ctx.getImageData(0, 0, w, h).data) };
  } catch {
    return null;
  }
}

/**
 * Local-metre rectangle for a lat/lon bbox, plus the uniform packing the
 * shader wants. Row 0 of the image is the NORTH edge (flipY = false), and
 * north is -Z (§1.2), so v runs from zMin (north) to zMax (south).
 */
function rectFor(bbox) {
  const nw = llToLocal(bbox.north, bbox.west);
  const se = llToLocal(bbox.south, bbox.east);
  const xMin = Math.min(nw.x, se.x);
  const xMax = Math.max(nw.x, se.x);
  const zMin = Math.min(nw.z, se.z);
  const zMax = Math.max(nw.z, se.z);
  return {
    vec: new THREE.Vector4(xMin, zMin, 1 / (xMax - xMin), 1 / (zMax - zMin)),
    spanX: xMax - xMin,
    spanZ: zMax - zMin,
  };
}

/**
 * A 16 x 2 RGBA lookup: row 0 = albedo (sRGB bytes, the shader linearises),
 * row 1 = (roughness, detail amplitude, form / 2, canopy fraction).
 *
 * A texture rather than a GLSL array because three still emits GLSL ES 1.00
 * for MeshStandardMaterial, and ES 1.00 forbids indexing a constant array with
 * a non-constant expression. A 16 x 2 texture fetch is the portable version of
 * `PALETTE[idx]`.
 */
export function buildPaletteTexture(classes = CLASSES) {
  const data = new Uint8Array(PALETTE_N * 2 * 4);
  for (const c of classes) {
    if (c.index >= PALETTE_N) continue;
    const a = c.index * 4;
    data[a] = Math.round(c.albedo[0] * 255);
    data[a + 1] = Math.round(c.albedo[1] * 255);
    data[a + 2] = Math.round(c.albedo[2] * 255);
    data[a + 3] = 255;
    const b = (PALETTE_N + c.index) * 4;
    data[b] = Math.round(c.rough * 255);
    data[b + 1] = Math.round(c.detail * 255);
    data[b + 2] = Math.round((c.form / 2) * 255);
    data[b + 3] = Math.round((c.canopy ?? 0) * 255);
  }
  const tex = new THREE.DataTexture(data, PALETTE_N, 2, THREE.RGBAFormat);
  tex.name = 'landcover-palette';
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.NearestFilter;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.generateMipmaps = false;
  tex.flipY = false;
  tex.colorSpace = THREE.NoColorSpace;
  tex.needsUpdate = true;
  return tex;
}

/**
 * Load the baked land-cover rasters.
 *
 * @returns {Promise<Landcover|null>} null when nothing was baked.
 */
export async function loadLandcover() {
  const manifest = await fetchJsonOrNull('landcover/manifest.json', null);
  if (!manifest?.layers?.length) {
    if (!warned) {
      warned = true;
      console.warn(
        '[landcover] no public/landcover/manifest.json. Run ' +
          '`npm run bake:landcover`. The terrain falls back to the ' +
          'elevation-and-slope palette, which paints every lowland the same green.',
      );
    }
    return null;
  }

  /** @type {Record<string, LandcoverLayer>} */
  const layers = {};
  await Promise.all(
    manifest.layers.map(async (spec) => {
      const img = await decodeToRgba(assetUrl(spec.file));
      if (!img) {
        console.warn(`[landcover] ${spec.file} failed to load; skipping that layer.`);
        return;
      }
      if (img.width !== spec.width || img.height !== spec.height) {
        console.warn(
          `[landcover] ${spec.file} is ${img.width}x${img.height}, ` +
            `manifest says ${spec.width}x${spec.height}; skipping that layer.`,
        );
        return;
      }

      const tex = new THREE.DataTexture(img.data, img.width, img.height, THREE.RGBAFormat);
      tex.name = `landcover-${spec.name}`;
      tex.magFilter = THREE.NearestFilter;
      tex.minFilter = THREE.NearestFilter;
      tex.generateMipmaps = false;
      tex.wrapS = THREE.ClampToEdgeWrapping;
      tex.wrapT = THREE.ClampToEdgeWrapping;
      tex.flipY = false;
      tex.colorSpace = THREE.NoColorSpace;
      tex.anisotropy = 1;
      tex.needsUpdate = true;

      const r = rectFor(spec.bbox);
      layers[spec.name] = {
        name: spec.name,
        texture: tex,
        rect: r.vec,
        texelM: new THREE.Vector2(r.spanX / spec.width, r.spanZ / spec.height),
        width: img.width,
        height: img.height,
        data: img.data,
      };
    }),
  );

  if (!layers.region && !layers.detail) return null;

  const palette = buildPaletteTexture();
  const region = layers.region ?? null;
  const detail = layers.detail ?? null;

  /**
   * Compact class index at a point in local scene metres, finest layer first.
   * Returns -1 outside every layer, which is NOT the same as class 0 (nodata):
   * "no raster here" and "the raster says nothing is here" are different facts.
   *
   * @param {number} x @param {number} z
   * @returns {number}
   */
  const classAtLocal = (x, z) => {
    for (const L of [detail, region]) {
      if (!L) continue;
      const u = (x - L.rect.x) * L.rect.z;
      const v = (z - L.rect.y) * L.rect.w;
      if (u < 0 || u >= 1 || v < 0 || v >= 1) continue;
      const i = Math.min(L.width - 1, (u * L.width) | 0);
      const j = Math.min(L.height - 1, (v * L.height) | 0);
      return L.data[(j * L.width + i) * 4 + 1];
    }
    return -1;
  };

  console.info(
    `[landcover] ${Object.keys(layers).join(' + ')} from ${
      manifest.sources?.map((s) => s.name).join(', ') || 'unknown source'
    }` +
      (region ? `, region ${region.texelM.x.toFixed(0)} m/texel` : '') +
      (detail ? `, detail ${detail.texelM.x.toFixed(0)} m/texel` : ''),
  );

  return {
    region,
    detail,
    palette,
    manifest,
    classAtLocal,
    /**
     * Is this point open water, per the survey?
     *
     * This exists because the DEM alone gets it wrong, and the failure is
     * visible: Terrarium's bed under Puget Sound is nominally a flat zero, but
     * void repair and source noise leave broad patches reading +1 to +5 m. A
     * mask built from "elevation <= 0.5" therefore scatters phantom islands
     * across the middle of Elliott Bay, and everything downstream of that mask
     * — shore distance, the deep/shallow water gradient, the beach band —
     * inherits them. NLCD's open-water class is a survey of where the water
     * actually is and has no such holes.
     *
     * @param {number} x @param {number} z local scene metres
     * @returns {boolean} false where there is no raster, so callers keep their
     *          own elevation test as the fallback rather than losing coverage.
     */
    isOpenWaterLocal(x, z) {
      return classAtLocal(x, z) === CLASS_WATER;
    },
    dispose() {
      region?.texture.dispose();
      detail?.texture.dispose();
      palette.dispose();
    },
  };
}
