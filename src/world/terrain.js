/**
 * terrain.js — the ground: real elevation, procedural colour.
 *
 * STUB IMPLEMENTATION. A single static mesh covering `viewRadiusM` around the
 * origin, displaced by the real DEM and vertex-coloured by height and slope.
 * There is no LOD or streaming yet — update() is a no-op. Replace the
 * internals; do not change the exported signature.
 *
 * Contract: see MODULES.md § terrain
 *
 *   createTerrain(scene, opts) -> Promise<{group, getHeightAt(x,z), update(camera)}>
 *
 * NOTE createTerrain is ASYNC. It awaits the DEM so the first rendered frame
 * already has real ground under the aircraft. Bootstrap must await it.
 *
 * ---------------------------------------------------------------------------
 * THE ONE RULE THAT MATTERS
 * ---------------------------------------------------------------------------
 * getHeightAt(x, z) MUST return exactly elevation.getElevationLocal(x, z).
 *
 * Not a raycast against the mesh. Not a cached copy of the vertex buffer. Not a
 * separate noise function that "looks about the same". The visible mesh is a
 * DISCRETISATION of the elevation field; the collision surface is the FIELD
 * ITSELF. Both come from one sampler, so the wheels touch down exactly where
 * the ground is drawn, at every LOD, forever.
 *
 * The consequence to accept: at coarse tessellation the drawn surface can sit a
 * little below the sampled field between vertices, so on very steep ground the
 * aircraft may appear to hover by a metre or two. That is the correct trade —
 * raycasting the mesh instead would make ground contact change as LOD changes,
 * which is far worse. Fix it with more triangles near the camera, not by
 * changing the sampler.
 *
 * ---------------------------------------------------------------------------
 * COLOUR: PROCEDURAL, NOT PHOTOGRAPHIC
 * ---------------------------------------------------------------------------
 * We deliberately do not stream satellite imagery. Draped imagery is what makes
 * GeoFS turn to mush below ~500 ft AGL, because there is no more texture detail
 * to show. Procedural material driven by real height and real slope stays crisp
 * at any altitude. Geographic truth comes from the GEOMETRY; the colour only
 * has to be plausible.
 *
 * The stub's palette is height and slope banded: water, beach, lowland green,
 * forest, subalpine, rock, snow — with the treeline and snow line at real
 * Cascade elevations. Steep faces go to rock regardless of height, which is
 * what makes Mount Rainier read as a mountain rather than a green cone.
 */

import * as THREE from 'three';
import {
  loadRegion,
  getElevationLocal,
  fillHeightGrid,
  isLoaded as demLoaded,
  SEA_LEVEL_M,
  DEM_ZOOM,
  WATER_LEVEL_M,
} from '../geo/elevation.js';
import { REGION_BBOX } from '../geo/coords.js';
import { clamp } from '../core/units.js';

/**
 * @typedef {Object} TerrainOpts
 * @property {number} [viewRadiusM]  Half-extent of the ground patch, metres. Default 90000
 *           — enough to see Mount Rainier (84 km away) from the Seattle spawn.
 * @property {number} [segments]     Grid divisions per side. Default 512.
 * @property {{south:number,north:number,west:number,east:number}} [bbox] DEM region.
 * @property {number} [zoom]         DEM zoom to load. Default DEM_ZOOM (11).
 * @property {boolean} [loadDem]     Set false to skip loading (tests). Default true.
 * @property {number} [exaggeration] Vertical scale. KEEP AT 1 — anything else makes
 *           the terrain a lie. Exposed only for debugging.
 * @property {number} [seaLevelM]    Water plane height. Default SEA_LEVEL_M (0).
 */

const DEFAULTS = {
  viewRadiusM: 90000,
  segments: 512,
  bbox: REGION_BBOX,
  zoom: DEM_ZOOM,
  loadDem: true,
  exaggeration: 1,
  seaLevelM: SEA_LEVEL_M,
};

// ---------------------------------------------------------------------------
// Procedural palette — real Cascade Range elevations, metres MSL
// ---------------------------------------------------------------------------
const BANDS = [
  { h: -50, c: 0x1b3a52 }, // deep water
  { h: 0, c: 0x2d5872 }, // shallows
  { h: 3, c: 0x9d9377 }, // beach / tideflat
  { h: 40, c: 0x4f6b3a }, // lowland
  { h: 300, c: 0x3d5c30 }, // forest
  { h: 1100, c: 0x4a6338 }, // upper forest
  { h: 1700, c: 0x6b6a4e }, // treeline / subalpine
  { h: 2100, c: 0x6e6862 }, // rock
  { h: 2400, c: 0xdfe6ea }, // permanent snow
  { h: 4400, c: 0xf4f8fb }, // summit ice
];

/** Steep ground shows bare rock whatever its elevation. */
const ROCK_COLOUR = new THREE.Color(0x5d564f);
/** Slope (rise/run) at which the surface is fully rock. */
const ROCK_SLOPE = 0.85;

const _cA = new THREE.Color();
const _cB = new THREE.Color();

/**
 * Colour for a surface point, from real elevation and real slope.
 * @param {number} h metres MSL
 * @param {number} slope rise over run, 0 = flat
 * @param {THREE.Color} out
 */
function surfaceColour(h, slope, out) {
  let i = 0;
  while (i < BANDS.length - 1 && h > BANDS[i + 1].h) i++;
  const a = BANDS[i];
  const b = BANDS[Math.min(i + 1, BANDS.length - 1)];
  const t = b.h === a.h ? 0 : clamp((h - a.h) / (b.h - a.h), 0, 1);
  out.copy(_cA.setHex(a.c)).lerp(_cB.setHex(b.c), t);

  // Water never turns to rock however steep the bathymetry gets.
  if (h > WATER_LEVEL_M) {
    out.lerp(ROCK_COLOUR, clamp(slope / ROCK_SLOPE, 0, 1) * 0.85);
  }
}

/**
 * Build the terrain and add it to `scene`.
 *
 * @param {THREE.Scene} scene
 * @param {TerrainOpts} [opts]
 * @returns {Promise<{group: THREE.Group, getHeightAt: (x:number, z:number) => number, update: (camera: THREE.Camera) => void, dispose: () => void}>}
 */
export async function createTerrain(scene, opts = {}) {
  const cfg = { ...DEFAULTS, ...opts };

  if (cfg.loadDem) {
    await loadRegion(cfg.bbox, cfg.zoom);
  }

  const group = new THREE.Group();
  group.name = 'terrain';

  const size = cfg.viewRadiusM * 2;
  const n = cfg.segments;
  const geometry = new THREE.PlaneGeometry(size, size, n, n);
  // PlaneGeometry is born in XY facing +Z. Lay it flat so it spans XZ.
  geometry.rotateX(-Math.PI / 2);

  const pos = geometry.attributes.position;
  const colours = new Float32Array(pos.count * 3);

  // Sample the DEM on the same regular grid the geometry uses. After the
  // rotateX above, rows run along +X and advance along +Z, starting at
  // (-half, -half) — matching PlaneGeometry's vertex ordering exactly.
  const half = cfg.viewRadiusM;
  const step = size / n;
  const nx = n + 1;
  const heights = fillHeightGrid(-half, -half, step, step, nx, nx);

  const colour = new THREE.Color();
  for (let j = 0; j <= n; j++) {
    for (let i = 0; i <= n; i++) {
      const idx = j * nx + i;
      const h = heights[idx];
      pos.setY(idx, h * cfg.exaggeration);

      // Slope from neighbouring grid samples — free, we already have them.
      const hL = heights[j * nx + Math.max(0, i - 1)];
      const hR = heights[j * nx + Math.min(n, i + 1)];
      const hD = heights[Math.max(0, j - 1) * nx + i];
      const hU = heights[Math.min(n, j + 1) * nx + i];
      const slope = Math.hypot((hR - hL) / (2 * step), (hU - hD) / (2 * step));

      surfaceColour(h, slope, colour);
      colours[idx * 3] = colour.r;
      colours[idx * 3 + 1] = colour.g;
      colours[idx * 3 + 2] = colour.b;
    }
  }
  pos.needsUpdate = true;
  geometry.setAttribute('color', new THREE.BufferAttribute(colours, 3));
  geometry.computeVertexNormals();

  const material = new THREE.MeshLambertMaterial({ vertexColors: true });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = 'terrain-surface';
  mesh.receiveShadow = true;
  group.add(mesh);

  // A flat sea plane, so open water reads as a surface rather than as the
  // bathymetry underneath it. Sits just below the shoreline sample so beaches
  // are not submerged by interpolation wobble.
  const waterGeo = new THREE.PlaneGeometry(size * 1.5, size * 1.5);
  waterGeo.rotateX(-Math.PI / 2);
  const waterMat = new THREE.MeshLambertMaterial({
    color: 0x24506b,
    transparent: true,
    opacity: 0.88,
  });
  const water = new THREE.Mesh(waterGeo, waterMat);
  water.name = 'terrain-water';
  water.position.y = cfg.seaLevelM - 0.25;
  water.renderOrder = -1;
  group.add(water);

  scene.add(group);

  if (!demLoaded()) {
    console.warn(
      '[terrain] built with no DEM loaded — the world is flat. ' +
        'Run `npm run bake:dem`.',
    );
  }

  /**
   * Ground elevation in METRES at local (x, z).
   *
   * Delegates to the elevation field, NOT to this mesh. See the header.
   * Cheap, allocation-free, defined everywhere, never NaN.
   *
   * @param {number} x metres east of origin
   * @param {number} z metres south of origin
   * @returns {number} metres MSL
   */
  function getHeightAt(x, z) {
    return getElevationLocal(x, z) * cfg.exaggeration;
  }

  /**
   * Per-frame housekeeping: LOD selection, chunk streaming, recentring the tile
   * grid on the camera. No-op while the world is one static patch.
   * @param {THREE.Camera} camera
   */
  function update(camera) {
    void camera;
  }

  /** Release GPU resources. */
  function dispose() {
    geometry.dispose();
    material.dispose();
    waterGeo.dispose();
    waterMat.dispose();
    group.removeFromParent();
  }

  return { group, getHeightAt, update, dispose };
}
