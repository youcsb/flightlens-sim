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
 *
 * ---------------------------------------------------------------------------
 * ONE CLASS IS TWO MATERIALS, AND THAT IS WHERE THE INFORMATION IS
 * ---------------------------------------------------------------------------
 * Round 2's verdict was that the whole lowland reads as one grey-brown family
 * from 300–2,000 ft. Measured on the rendered frame at the matched 610 m
 * downtown camera, a block interior came back sRGB 99,101,101 — perfectly
 * neutral — against a class albedo of 80,84,65. The mean colour was not the
 * problem the eye had. The problem was that a class was ONE colour at all.
 *
 * No real land-cover class is one material. "Developed, Low Intensity" is
 * roofs AND gardens; "Developed, High Intensity" is roofs AND streets AND the
 * odd square of park; a fir stand is sunlit crown AND the near-black gap
 * between crowns. What the eye reads from a light aircraft is the CONTRAST
 * BETWEEN those two, at the scale of a lot or a stand — not the average.
 *
 * So every class now carries its two ends explicitly:
 *
 *   hard    the built / bare / lit end: roof, tarmac, gravel, sunlit crown.
 *   soft    the vegetated / shadowed end: garden, verge, canopy gap.
 *   hardMix where the class sits between them on average (0 = all soft).
 *   vary    how far the near-field structure is allowed to swing between them.
 *
 * The shader mixes hard↔soft per LOT, per PARCEL or per STAND (see
 * `terrainColourGlsl`), so a single class produces a spread of real colours
 * whose mean is still `albedo`. That is the difference between a painted map
 * and a place. It costs one extra 16x1 palette fetch and no new data.
 */
export const CLASSES = [
  // index, name                            albedo (mean)          rough detail form canopy  hard (built/bare/lit)   hardMix  soft (vegetated/shadow)  vary
  { index: 0,  name: 'nodata',                       albedo: [0.30, 0.36, 0.24],   rough: 0.95, detail: 0.5, form: 0, canopy: 0,    hard: [0.42, 0.42, 0.34], hardMix: 0.35, soft: [0.22, 0.30, 0.16], vary: 0.5 },
  { index: 1,  name: 'Open Water',                   albedo: [0.055, 0.085, 0.10], rough: 0.55, detail: 0.1, form: 0, canopy: 0,    hard: [0.07, 0.11, 0.13], hardMix: 0.5,  soft: [0.04, 0.07, 0.09], vary: 0.1 },
  { index: 2,  name: 'Perennial Ice/Snow',           albedo: [0.90, 0.93, 0.98],   rough: 0.58, detail: 0.4, form: 0, canopy: 0,    hard: [0.97, 0.98, 1.00], hardMix: 0.5,  soft: [0.74, 0.82, 0.93], vary: 0.45 },
  // Parks, golf courses, cemeteries, big verges. NLCD calls it developed; from
  // the air it is overwhelmingly mown grass with paths through it, and it is the
  // one urban class that should read GREEN against its neighbours.
  { index: 3,  name: 'Developed, Open Space',        albedo: [0.250, 0.320, 0.165], rough: 0.92, detail: 0.8, form: 2, canopy: 0.50, hard: [0.50, 0.48, 0.43], hardMix: 0.16, soft: [0.24, 0.35, 0.13], vary: 0.85 },
  // Detached housing. Roofs are a minority of the plan area and the rest is
  // garden, so the mean stays olive while the lot-scale swing is enormous.
  { index: 4,  name: 'Developed, Low Intensity',     albedo: [0.300, 0.325, 0.235], rough: 0.90, detail: 1.0, form: 2, canopy: 0.62, hard: [0.46, 0.44, 0.42], hardMix: 0.34, soft: [0.21, 0.31, 0.14], vary: 1.00 },
  // Commercial strip, apartments, light industry. Roofs win, but not by much.
  { index: 5,  name: 'Developed, Medium Intensity',  albedo: [0.370, 0.362, 0.325], rough: 0.86, detail: 1.0, form: 2, canopy: 0.34, hard: [0.53, 0.51, 0.49], hardMix: 0.62, soft: [0.23, 0.32, 0.17], vary: 1.00 },
  // CBD, port, rail. Almost all roof and tarmac — and roofs are the most
  // varied surface in the region, which is why `vary` stays at 1.
  { index: 6,  name: 'Developed, High Intensity',    albedo: [0.425, 0.416, 0.400], rough: 0.80, detail: 1.0, form: 2, canopy: 0.10, hard: [0.56, 0.55, 0.54], hardMix: 0.84, soft: [0.24, 0.30, 0.20], vary: 1.00 },
  { index: 7,  name: 'Barren Land',                  albedo: [0.52, 0.49, 0.43],   rough: 0.94, detail: 0.8, form: 0, canopy: 0,    hard: [0.63, 0.59, 0.51], hardMix: 0.5,  soft: [0.40, 0.38, 0.33], vary: 0.75 },
  // Big-leaf maple and alder: a real yellow-green, and it turns over in stands.
  { index: 8,  name: 'Deciduous Forest',             albedo: [0.235, 0.318, 0.150], rough: 0.96, detail: 1.0, form: 0, canopy: 0,    hard: [0.34, 0.42, 0.19], hardMix: 0.45, soft: [0.13, 0.20, 0.10], vary: 1.00 },
  // Douglas fir. The crowns catch light; the gaps between them are near black.
  { index: 9,  name: 'Evergreen Forest',             albedo: [0.113, 0.184, 0.113], rough: 0.97, detail: 1.0, form: 0, canopy: 0,    hard: [0.17, 0.26, 0.15], hardMix: 0.45, soft: [0.055, 0.098, 0.072], vary: 1.00 },
  { index: 10, name: 'Mixed Forest',                 albedo: [0.172, 0.253, 0.135], rough: 0.96, detail: 1.0, form: 0, canopy: 0,    hard: [0.27, 0.35, 0.17], hardMix: 0.45, soft: [0.085, 0.145, 0.090], vary: 1.00 },
  { index: 11, name: 'Shrub/Scrub',                  albedo: [0.335, 0.333, 0.205], rough: 0.95, detail: 0.9, form: 0, canopy: 0,    hard: [0.46, 0.44, 0.27], hardMix: 0.45, soft: [0.21, 0.24, 0.14], vary: 0.9 },
  // Dry summer grass. This is the warmest thing in the lowland and it should
  // read that way against pasture two fields over.
  { index: 12, name: 'Grassland/Herbaceous',         albedo: [0.430, 0.428, 0.245], rough: 0.94, detail: 0.8, form: 1, canopy: 0,    hard: [0.58, 0.54, 0.30], hardMix: 0.45, soft: [0.28, 0.33, 0.17], vary: 0.95 },
  // Irrigated hay is the greenest thing in the lowland. Against grassland's
  // straw that is a genuine hue difference, and the valleys are made of it.
  { index: 13, name: 'Pasture/Hay',                  albedo: [0.352, 0.462, 0.200], rough: 0.93, detail: 0.9, form: 1, canopy: 0,    hard: [0.47, 0.56, 0.24], hardMix: 0.45, soft: [0.23, 0.34, 0.15], vary: 1.00 },
  // Ploughed ground, stubble and standing crop in the same square mile.
  { index: 14, name: 'Cultivated Crops',             albedo: [0.442, 0.398, 0.198], rough: 0.94, detail: 1.0, form: 1, canopy: 0,    hard: [0.56, 0.48, 0.28], hardMix: 0.45, soft: [0.29, 0.31, 0.13], vary: 1.00 },
  { index: 15, name: 'Wetland',                      albedo: [0.222, 0.292, 0.178], rough: 0.90, detail: 0.9, form: 0, canopy: 0.25, hard: [0.35, 0.38, 0.24], hardMix: 0.40, soft: [0.13, 0.20, 0.13], vary: 0.9 },
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

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

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

/** Rows in the palette texture. The shader's v coordinates mirror these. */
export const PALETTE_ROWS = 4;

/**
 * A 16 x 4 RGBA lookup:
 *   row 0  albedo, the class mean (sRGB bytes; the shader linearises)
 *   row 1  (roughness, detail amplitude, form / 2, canopy fraction)
 *   row 2  HARD end colour (sRGB), alpha = hardMix
 *   row 3  SOFT end colour (sRGB), alpha = vary
 *
 * Rows 2 and 3 are what stop a class being one flat material — see the header
 * on CLASSES. They are two more texture fetches in a shader that already does
 * six, and they replace nothing: `albedo` is still the mean the far field uses,
 * because at 8 km a lot is a twentieth of a pixel and the mean IS the answer.
 *
 * A texture rather than a GLSL array because three still emits GLSL ES 1.00
 * for MeshStandardMaterial, and ES 1.00 forbids indexing a constant array with
 * a non-constant expression. A 16 x 4 texture fetch is the portable version of
 * `PALETTE[idx]`.
 */
export function buildPaletteTexture(classes = CLASSES) {
  const data = new Uint8Array(PALETTE_N * PALETTE_ROWS * 4);
  const put = (row, idx, r, g, b, a) => {
    const o = (row * PALETTE_N + idx) * 4;
    data[o] = Math.round(clamp01(r) * 255);
    data[o + 1] = Math.round(clamp01(g) * 255);
    data[o + 2] = Math.round(clamp01(b) * 255);
    data[o + 3] = Math.round(clamp01(a) * 255);
  };
  for (const c of classes) {
    if (c.index >= PALETTE_N) continue;
    put(0, c.index, c.albedo[0], c.albedo[1], c.albedo[2], 1);
    put(1, c.index, c.rough, c.detail, c.form / 2, c.canopy ?? 0);
    const hard = c.hard ?? c.albedo;
    const soft = c.soft ?? c.albedo;
    put(2, c.index, hard[0], hard[1], hard[2], c.hardMix ?? 0.5);
    put(3, c.index, soft[0], soft[1], soft[2], c.vary ?? 0);
  }
  const tex = new THREE.DataTexture(data, PALETTE_N, PALETTE_ROWS, THREE.RGBAFormat);
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
