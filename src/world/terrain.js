/**
 * terrain.js — the ground: real elevation, procedural colour.
 *
 * Contract: see MODULES.md § terrain
 *
 *   createTerrain(scene, opts) -> Promise<{group, getHeightAt(x,z), update(camera), dispose()}>
 *
 * createTerrain is ASYNC. It awaits the DEM *and* builds the first full set of
 * chunks before resolving, so the very first rendered frame already has real
 * ground under the aircraft and nothing pops in on frame 2.
 *
 * ---------------------------------------------------------------------------
 * THE ONE RULE THAT MATTERS
 * ---------------------------------------------------------------------------
 * getHeightAt(x, z) returns exactly elevation.getElevationLocal(x, z).
 *
 * Not a raycast against the mesh. Not a cached copy of the vertex buffer. The
 * visible mesh is a DISCRETISATION of the elevation field; the collision
 * surface is the FIELD ITSELF. Both come from one sampler, so the wheels touch
 * down where the ground is drawn, at every LOD, forever.
 *
 * The accepted consequence: at coarse tessellation the drawn triangles can dip
 * below the sampled field between vertices, so on very steep ground the
 * aircraft may appear to hover by a metre or two. The fix is more triangles
 * near the camera — which is what the LOD scheme below is for — never a
 * different sampler.
 *
 * ---------------------------------------------------------------------------
 * THE LOD SCHEME — CDLOD (continuous distance-dependent LOD)
 * ---------------------------------------------------------------------------
 * A quadtree over the region. Each selected node draws a fixed GRID x GRID
 * lattice, so every node costs the same and the whole terrain is one shared
 * index buffer. A node subdivides while the camera is closer than
 * LOD_K * nodeSize; the node that ends up drawn is therefore always between
 * LOD_K * S and 2 * LOD_K * S away. Its cell size is S / GRID, so the angular
 * size of a cell is bounded by
 *
 *      cell / distance  <=  (S / GRID) / (LOD_K * S)  =  1 / (GRID * LOD_K)
 *
 * — INDEPENDENT OF S. That is the whole point: one constant, 1/256 rad here
 * (~4 px at 1080p / 60 deg FOV), governs the silhouette error everywhere, from
 * the runway threshold to Mount Rainier at 84 km. A naive "coarser when far"
 * scheme would render Rainier as a lump; this one gives it 256 m cells at
 * 84 km, roughly forty samples across the cone.
 *
 * POPPING is removed by geomorphing, not hidden by fog. Every vertex carries
 * the height it would have on its PARENT's lattice (aMorph.x). The vertex
 * shader lerps toward that value over the outer quarter of the node's distance
 * range, so by the time a node is replaced by its parent its shape is already
 * identical to the parent's. Nothing ever jumps.
 *
 * The same mechanism removes CRACKS between neighbouring LODs, and this is
 * worth spelling out because it is not obvious: at a boundary between a node of
 * size S and a neighbour of size 2S, the fine node's vertices are fully morphed
 * to its parent's lattice — spacing 2S/GRID — which is exactly the neighbour's
 * lattice, and both are aligned to the same global grid because every node
 * origin is a multiple of its own size. Shared even vertices are the same DEM
 * sample; odd ones are the linear interpolation the coarse triangle already
 * draws. The surfaces agree exactly.
 *
 * Skirts are still generated. They are insurance, not the mechanism — with the
 * morph working they are never visible.
 *
 * ---------------------------------------------------------------------------
 * COLOUR: PROCEDURAL, NOT PHOTOGRAPHIC
 * ---------------------------------------------------------------------------
 * We deliberately do not stream satellite imagery. Draped imagery is what makes
 * GeoFS turn to mush below ~500 ft AGL: at that range there is no more texture
 * detail left in the source. A material driven by real height, real slope and
 * multi-octave noise has no such floor — the last two octaves only fade in
 * within 700 m of the camera, so the ground gets CRISPER as you descend rather
 * than softer. Geographic truth comes from the GEOMETRY; the colour only has to
 * be plausible.
 *
 * Bands sit at real Cascade elevations. The important detail is that the
 * snow/rock decision is slope-aware AND the slope it tolerates rises with
 * altitude: glaciers hold on 50-degree faces at 4,000 m but nothing holds on a
 * 45-degree face at 1,900 m. That is what makes Mount Rainier read as a
 * glaciated cone with rock ribs showing through, instead of a white pyramid or
 * a green one.
 */

import * as THREE from 'three';
import {
  loadRegion,
  getElevationLocal,
  fillHeightGrid,
  isLoaded as demLoaded,
  SEA_LEVEL_M,
  DEM_ZOOM,
  DETAIL_ZOOM,
  DETAIL_BBOX,
  WATER_LEVEL_M,
} from '../geo/elevation.js';
import { REGION_BBOX, llToLocal } from '../geo/coords.js';
import { clamp } from '../core/units.js';

/**
 * @typedef {Object} TerrainOpts
 * @property {number} [viewRadiusM]  Nodes farther than 1.6x this from the camera
 *           are not drawn. Default 90000 — must exceed 84 km or Mount Rainier
 *           falls off the map.
 * @property {number} [segments]     ACCEPTED AND IGNORED. Kept so callers written
 *           against the single-patch stub still work; the chunked LOD renderer
 *           has no global segment count. See `grid` if you need to tune density.
 * @property {{south:number,north:number,west:number,east:number}} [bbox] DEM region.
 * @property {number} [zoom]         Base DEM zoom to load. Default DEM_ZOOM (11).
 * @property {boolean} [detail]      Also load DETAIL_ZOOM over DETAIL_BBOX, so the
 *           ground around KBFI/KSEA/downtown is 13 m/px instead of 52. Default true.
 * @property {boolean} [loadDem]     Set false to skip loading (tests). Default true.
 * @property {number} [exaggeration] Vertical scale. KEEP AT 1 — anything else makes
 *           the terrain a lie. Exposed only for debugging.
 * @property {number} [seaLevelM]    Water plane height. Default SEA_LEVEL_M (0).
 * @property {boolean} [water]       Build the sea + lake surfaces. Default true.
 * @property {number} [lodQuality]   Multiplies LOD_K. >1 = more triangles, sharper
 *           silhouettes, more draw calls. Default 1.
 */

const DEFAULTS = {
  viewRadiusM: 90000,
  segments: 512,
  bbox: REGION_BBOX,
  zoom: DEM_ZOOM,
  detail: true,
  loadDem: true,
  exaggeration: 1,
  seaLevelM: SEA_LEVEL_M,
  water: true,
  lodQuality: 1,
};

// ---------------------------------------------------------------------------
// LOD constants
// ---------------------------------------------------------------------------

/**
 * Cells per node edge. 64 is the sweet spot for this scene.
 *
 * Screen error is 1/(GRID * LOD_K) whichever way you split it, but the node
 * COUNT is not neutral: for a fixed error, halving GRID forces LOD_K to double,
 * and the number of nodes in a level's annulus goes as LOD_K^2. A 32-cell grid
 * at the same fidelity needs ~1,200 nodes and 1,200 draw calls — WebGL dies on
 * the call overhead long before the GPU notices the triangles. 64 cells at
 * LOD_K = 4 gives ~280 nodes, ~130 after frustum culling.
 */
const GRID = 64;
const VERTS_PER_SIDE = GRID + 1;
const GRID_VERTS = VERTS_PER_SIDE * VERTS_PER_SIDE; // 4225
const SKIRT_VERTS = GRID * 4; // 256
const NODE_VERTS = GRID_VERTS + SKIRT_VERTS; // 4481, comfortably under 65536

/** A node subdivides while the camera is within LOD_K * nodeSize of it. */
const LOD_K = 4.0;

/**
 * Root extent, metres. The region is 166 km E-W by 211 km N-S, so 262144 (2^18)
 * covers it with room to spare and keeps every node size an exact power of two —
 * which is what guarantees the lattice alignment the crack-free proof relies on.
 */
const ROOT_SIZE = 262144;

/** Finest node: 512 m across, so 8 m cells. Finer than the 13 m/px z=13 DEM. */
const MIN_NODE_SIZE = 512;
const MAX_LEVEL = Math.round(Math.log2(ROOT_SIZE / MIN_NODE_SIZE)); // 9

/**
 * Built geometries kept alive. ~160 KB each, so 384 is ~60 MB of GPU memory.
 * The working set in steady flight is ~280; the slack absorbs turns without
 * rebuilding what we just flew past.
 */
const MAX_CACHED_NODES = 384;

/** Per-frame build budget for PREFETCHING children, milliseconds. */
const BUILD_BUDGET_MS = 4;

/**
 * Skirt depth, capped. It only has to cover a crack that geomorphing already
 * makes impossible, so it is deliberately small: a deep apron on a coarse node
 * would hang kilometres below the seabed and show through the transparent
 * water at shorelines.
 */
function skirtDepthFor(cellSize) {
  return Math.min(cellSize * 4, 120);
}

// ---------------------------------------------------------------------------
// Region height field (used by the water shader for depth and shorelines)
// ---------------------------------------------------------------------------

/**
 * Resolution of the CPU-side region height/shore texture. 1280 over ~211 km is
 * ~165 m per texel. It is not used for geometry — only to tell the water shader
 * how deep it is and how far it is from land.
 */
const FIELD_N = 1280;

/**
 * Distance-to-shore is computed, rather than depth, because Terrarium's
 * bathymetry is useless for this: the main basin of Puget Sound off Alki reads
 * a FLAT ZERO. A depth-based water colour would paint the entire Sound as
 * knee-deep shallows and put breaking surf across the middle of it. Distance to
 * the nearest land texel is robust against that and is what actually drives
 * both the deep-water gradient and the surf line.
 */
const SHORE_MAX_M = 4000;

// ---------------------------------------------------------------------------
// Lake detection
// ---------------------------------------------------------------------------

/**
 * Terrarium encodes a lake surface as a perfectly flat region at the lake's
 * TRUE elevation — Lake Washington and Lake Union both sit at about 5 m, not 0 —
 * so isWater() (which only finds sea level) cannot see them. They have to be
 * found by flatness.
 *
 * Flatness alone is not enough: the Kent/Auburn valley floor and the KSEA
 * plateau are flat too. The discriminator is that a lake is a LOCAL MINIMUM —
 * its perimeter rises away from it. Both tests together have no false positives
 * in this region; flatness alone has several.
 */
const LAKE_BOX = Object.freeze({
  south: 47.05,
  north: 47.95,
  west: -122.65,
  east: -121.85,
});
const LAKE_CELL_M = 96;
/** Max height step to neighbours for a cell to count as "flat", metres. */
const LAKE_FLAT_M = 0.35;
const LAKE_MIN_M = 1.2;
const LAKE_MAX_M = 700;
const LAKE_MIN_AREA_M2 = 0.25e6; // 0.25 km^2 — Green Lake is 1.0
const LAKE_MAX_AREA_M2 = 500e6; // Lake Washington is 88; anything bigger is a bug
/** The perimeter must average this much above the surface for it to be a basin. */
const LAKE_RIM_RISE_M = 1.0;

// ---------------------------------------------------------------------------
// Shared GLSL
// ---------------------------------------------------------------------------

/**
 * Value noise. Cheap, seamless, and — critically — evaluated on coordinates
 * that stay small.
 *
 * PRECISION TRAP: world coordinates reach 130,000 m. `fract(p * 443.897)` with
 * p = 130000 * 0.25 lands at 1.4e7, where a 32-bit float's spacing is 1.0, so
 * fract() returns garbage and the fine octaves band into stripes. The fix is
 * uNoiseOrigin: the high-frequency octaves are evaluated relative to a
 * camera-following origin QUANTISED TO 32 m. Every fine frequency divides 32
 * exactly (1/32, 1/8, 1/4), so shifting the origin translates the noise input
 * by a whole number of periods and the pattern does not move. Get that
 * quantisation wrong and the ground visibly crawls as you fly.
 */
const GLSL_NOISE = /* glsl */ `
float tHash21(vec2 p) {
  p = fract(p * vec2(443.8975, 397.2973));
  p += dot(p, p.yx + 19.19);
  return fract((p.x + p.y) * p.x);
}
float tNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = p - i;
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = tHash21(i);
  float b = tHash21(i + vec2(1.0, 0.0));
  float c = tHash21(i + vec2(0.0, 1.0));
  float d = tHash21(i + vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}
vec3 tSrgb(vec3 c) { return c * c * (c * 0.305306011 + 0.682171111) + c * 0.012522878; }
`;

// ---------------------------------------------------------------------------
// Scratch — module scope, because update() must not allocate
// ---------------------------------------------------------------------------

const _camPos = new THREE.Vector3();
const _probe = new Float32Array(81);

/**
 * Build the terrain and add it to `scene`.
 *
 * @param {THREE.Scene} scene
 * @param {TerrainOpts} [opts]
 * @returns {Promise<{group: THREE.Group, getHeightAt: (x:number, z:number) => number, update: (camera: THREE.Camera) => void, dispose: () => void}>}
 */
export async function createTerrain(scene, opts = {}) {
  const cfg = { ...DEFAULTS, ...opts };
  const t0 = performance.now();

  // -------------------------------------------------------------------------
  // 1. DEM
  // -------------------------------------------------------------------------
  if (cfg.loadDem) {
    await loadRegion(cfg.bbox, cfg.zoom);
    if (cfg.detail) {
      // Additive second layer. elevation.js samples finest-first, so this just
      // sharpens the ground around the airports with no seam handling here.
      await loadRegion(DETAIL_BBOX, DETAIL_ZOOM);
    }
  }
  const tDem = performance.now();

  const group = new THREE.Group();
  group.name = 'terrain';
  group.matrixAutoUpdate = false;
  scene.add(group);

  const exag = cfg.exaggeration;
  const lodK = LOD_K * Math.max(0.25, cfg.lodQuality);
  const drawRadius = cfg.viewRadiusM * 1.6;

  // -------------------------------------------------------------------------
  // 2. Region height + shore-distance field
  // -------------------------------------------------------------------------
  const regionRect = computeRegionRect(cfg.bbox);
  const field = buildRegionField(regionRect, cfg.seaLevelM);
  const tField = performance.now();

  // -------------------------------------------------------------------------
  // 3. Lakes (needs the field so lake texels count as water for shore distance)
  // -------------------------------------------------------------------------
  const lakes = cfg.water ? detectLakes() : null;
  if (lakes) markLakesAsWater(field, regionRect, lakes);
  computeShoreDistance(field);
  const fieldTexture = uploadField(field);
  const tLakes = performance.now();

  // -------------------------------------------------------------------------
  // 4. Materials
  // -------------------------------------------------------------------------
  const terrainMat = makeTerrainMaterial(lodK, exag);
  const seaMat = cfg.water
    ? makeWaterMaterial(fieldTexture, regionRect, cfg.seaLevelM, false)
    : null;
  const lakeMat = cfg.water
    ? makeWaterMaterial(fieldTexture, regionRect, cfg.seaLevelM, true)
    : null;

  // -------------------------------------------------------------------------
  // 5. Quadtree
  // -------------------------------------------------------------------------
  const sharedIndex = buildSharedIndex();
  /** Every node ever created, keyed "level/ix/iz". */
  const nodes = new Map();
  /** Nodes that currently own a geometry, for LRU eviction. */
  const built = [];
  /** Meshes visible last frame, so we can hide them without a full traversal. */
  let emitted = [];
  let nextEmitted = [];
  let frameId = 0;
  let buildDeadline = 0;
  /** @type {Array<Object>} Nodes whose geometry we want but do not urgently need. */
  const prefetch = [];

  const root = makeNode(0, 0, 0);

  // -------------------------------------------------------------------------
  // 6. Water surfaces
  // -------------------------------------------------------------------------
  let seaMesh = null;
  let seaGeo = null;
  if (cfg.water) {
    // One large plane. It sits 0.25 m above nominal sea level because Terrarium
    // gives the open Sound a flat exact zero — coplanar with the water plane —
    // and coplanar surfaces z-fight into a shimmering mess at 84 km.
    const span = Math.max(cfg.viewRadiusM * 6, 600000);
    seaGeo = new THREE.PlaneGeometry(span, span, 24, 24);
    seaGeo.rotateX(-Math.PI / 2);
    seaMesh = new THREE.Mesh(seaGeo, seaMat);
    seaMesh.name = 'terrain-sea';
    seaMesh.position.set(0, cfg.seaLevelM + 0.25, regionRect.zMid);
    seaMesh.renderOrder = 2;
    seaMesh.frustumCulled = false;
    seaMesh.updateMatrix();
    seaMesh.matrixAutoUpdate = false;
    group.add(seaMesh);
  }

  let lakeMesh = null;
  let lakeGeo = null;
  if (lakes && lakes.cells > 0) {
    lakeGeo = buildLakeGeometry(lakes);
    if (lakeGeo) {
      lakeMesh = new THREE.Mesh(lakeGeo, lakeMat);
      lakeMesh.name = 'terrain-lakes';
      lakeMesh.renderOrder = 3;
      lakeMesh.updateMatrix();
      lakeMesh.matrixAutoUpdate = false;
      group.add(lakeMesh);
    }
  }

  // -------------------------------------------------------------------------
  // 7. First selection, built synchronously
  // -------------------------------------------------------------------------
  // The contract says the first rendered frame already has real ground. That
  // means paying for the whole working set here rather than streaming it in
  // over the first second, which would show the aircraft sitting on a coarse
  // approximation of the runway.
  buildDeadline = Infinity;
  selectFrom(0, 400, 0);
  buildDeadline = 0;
  const tNodes = performance.now();

  if (!demLoaded()) {
    console.warn(
      '[terrain] built with no DEM loaded — the world is flat. ' +
        'Run `npm run bake:dem`.',
    );
  }
  console.info(
    `[terrain] ${nodes.size} nodes (${built.length} built, ${emitted.length} drawn), ` +
      `${lakes ? lakes.kept : 0} lakes | dem ${(tDem - t0) | 0}ms, ` +
      `field ${(tField - tDem) | 0}ms, lakes ${(tLakes - tField) | 0}ms, ` +
      `mesh ${(tNodes - tLakes) | 0}ms`,
  );

  // =========================================================================
  // Public surface
  // =========================================================================

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
    return getElevationLocal(x, z) * exag;
  }

  /**
   * Per-frame LOD selection, chunk streaming and shader housekeeping.
   * @param {THREE.Camera} camera
   */
  function update(camera) {
    if (!camera) return;
    camera.getWorldPosition(_camPos);

    buildDeadline = performance.now() + BUILD_BUDGET_MS;
    selectFrom(_camPos.x, _camPos.y, _camPos.z);
    drainPrefetch();

    // Quantised to 32 m: see GLSL_NOISE. Any other quantum makes the fine
    // detail slide across the ground as the origin moves.
    const nx = Math.floor(_camPos.x / 32) * 32;
    const nz = Math.floor(_camPos.z / 32) * 32;
    terrainMat.userData.uniforms.uNoiseOrigin.value.set(nx, nz);

    if (cfg.water) {
      const time = performance.now() * 0.001;
      const wx = Math.floor(_camPos.x / 256) * 256;
      const wz = Math.floor(_camPos.z / 256) * 256;
      const sky =
        scene.background && scene.background.isColor ? scene.background : null;
      for (const m of [seaMat, lakeMat]) {
        if (!m) continue;
        m.userData.uniforms.uTime.value = time;
        m.userData.uniforms.uWaveOrigin.value.set(wx, wz);
        if (sky) m.userData.uniforms.uSkyColor.value.copy(sky);
      }
      // The sea plane follows the camera in X/Z so it never runs out from
      // under a long flight. Y is fixed — it is sea level, not a screen effect.
      if (seaMesh) {
        seaMesh.position.x = Math.round(_camPos.x / 1000) * 1000;
        seaMesh.position.z = Math.round(_camPos.z / 1000) * 1000;
        seaMesh.updateMatrix();
      }
    }
  }

  /** Release GPU resources. */
  function dispose() {
    for (const node of built) releaseNode(node, true);
    built.length = 0;
    nodes.clear();
    sharedIndex.array = null;
    terrainMat.dispose();
    seaMat?.dispose();
    lakeMat?.dispose();
    seaGeo?.dispose();
    lakeGeo?.dispose();
    fieldTexture?.dispose();
    group.clear();
    group.removeFromParent();
  }

  // =========================================================================
  // Quadtree internals
  // =========================================================================

  /**
   * A node. `ix`/`iz` index the level's own lattice, so the world origin of a
   * node is always an exact multiple of its size — which is what makes every
   * level's vertices align and the crack-free morph work.
   */
  function makeNode(level, ix, iz) {
    const key = `${level}/${ix}/${iz}`;
    let node = nodes.get(key);
    if (node) return node;

    const size = ROOT_SIZE / Math.pow(2, level);
    const x0 = regionRect.xMid - ROOT_SIZE / 2 + ix * size;
    const z0 = regionRect.zMid - ROOT_SIZE / 2 + iz * size;

    // A cheap 9x9 probe gives a height range good enough for LOD distance and
    // frustum bounds before the node is ever built.
    fillHeightGrid(x0, z0, size / 8, size / 8, 9, 9, _probe);
    let lo = Infinity;
    let hi = -Infinity;
    for (let i = 0; i < 81; i++) {
      const v = _probe[i];
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }

    node = {
      key,
      level,
      ix,
      iz,
      size,
      x0,
      z0,
      cell: size / GRID,
      // Padded: a 9x9 probe of a 262 km node misses a lot of mountain.
      yMin: (lo - size * 0.05) * exag,
      yMax: (hi + size * 0.05) * exag,
      children: null,
      geometry: null,
      mesh: null,
      lastUsed: 0,
    };
    nodes.set(key, node);
    return node;
  }

  function ensureChildren(node) {
    if (node.children) return node.children;
    const l = node.level + 1;
    const ix = node.ix * 2;
    const iz = node.iz * 2;
    node.children = [
      makeNode(l, ix, iz),
      makeNode(l, ix + 1, iz),
      makeNode(l, ix, iz + 1),
      makeNode(l, ix + 1, iz + 1),
    ];
    return node.children;
  }

  function nodeDistance(node, px, py, pz) {
    const dx = Math.max(node.x0 - px, 0, px - (node.x0 + node.size));
    const dy = Math.max(node.yMin - py, 0, py - node.yMax);
    const dz = Math.max(node.z0 - pz, 0, pz - (node.z0 + node.size));
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
  }

  /**
   * Walk the tree, choose the node set, show it, hide the rest.
   *
   * The rule that keeps holes impossible: a node only subdivides once ALL FOUR
   * children already own geometry. Otherwise it draws itself and queues the
   * children for the next few frames. Nothing is ever asked to draw a chunk
   * that does not exist yet.
   */
  function selectFrom(px, py, pz) {
    frameId++;
    prefetch.length = 0;
    nextEmitted.length = 0;
    visit(root, px, py, pz);

    for (let i = 0; i < emitted.length; i++) emitted[i].visible = false;
    for (let i = 0; i < nextEmitted.length; i++) nextEmitted[i].visible = true;

    const swap = emitted;
    emitted = nextEmitted;
    nextEmitted = swap;

    evictStale();
  }

  function visit(node, px, py, pz) {
    const d = nodeDistance(node, px, py, pz);
    if (d > drawRadius) return;

    if (node.level < MAX_LEVEL && d < lodK * node.size) {
      const kids = ensureChildren(node);
      if (
        kids[0].geometry &&
        kids[1].geometry &&
        kids[2].geometry &&
        kids[3].geometry
      ) {
        visit(kids[0], px, py, pz);
        visit(kids[1], px, py, pz);
        visit(kids[2], px, py, pz);
        visit(kids[3], px, py, pz);
        return;
      }
      for (let i = 0; i < 4; i++) {
        if (!kids[i].geometry) prefetch.push(kids[i]);
      }
    }

    // Needed THIS frame, so build regardless of budget — a missing chunk is a
    // hole in the world, and one 0.6 ms build beats that every time.
    if (!node.geometry) buildNode(node);
    node.lastUsed = frameId;
    nextEmitted.push(node.mesh);
  }

  function drainPrefetch() {
    for (let i = 0; i < prefetch.length; i++) {
      if (performance.now() > buildDeadline) break;
      const n = prefetch[i];
      if (!n.geometry) buildNode(n);
      n.lastUsed = frameId;
    }
    prefetch.length = 0;
  }

  function buildNode(node) {
    node.geometry = buildNodeGeometry(node, sharedIndex, exag);
    const mesh = new THREE.Mesh(node.geometry, terrainMat);
    mesh.name = `terrain-${node.key}`;
    mesh.matrixAutoUpdate = false;
    mesh.visible = false;
    mesh.receiveShadow = true;
    mesh.renderOrder = 0;
    node.mesh = mesh;
    group.add(mesh);
    built.push(node);

    // The probe was a guess; the real vertices are the truth.
    const bs = node.geometry.boundingBox;
    if (bs) {
      node.yMin = bs.min.y;
      node.yMax = bs.max.y;
    }
  }

  function releaseNode(node, force) {
    if (!node.geometry) return;
    if (!force && node.lastUsed === frameId) return;
    node.mesh.visible = false;
    group.remove(node.mesh);
    node.geometry.dispose();
    node.geometry = null;
    node.mesh = null;
  }

  function evictStale() {
    if (built.length <= MAX_CACHED_NODES) return;
    // Oldest first. Anything drawn this frame is untouchable.
    built.sort((a, b) => a.lastUsed - b.lastUsed);
    let i = 0;
    while (built.length > MAX_CACHED_NODES && i < built.length) {
      const n = built[i];
      if (n.lastUsed === frameId) break; // sorted, so everything after is live
      releaseNode(n, false);
      if (!n.geometry) {
        built.splice(i, 1);
      } else {
        i++;
      }
    }
  }

  return { group, getHeightAt, update, dispose };
}

// ===========================================================================
// Geometry
// ===========================================================================

/**
 * The index buffer for every node in the world. All nodes share one topology,
 * so this is uploaded once and referenced ~300 times.
 *
 * Note on sharing: disposing one geometry makes three delete the shared GL
 * buffer, but WebGLAttributes recreates it on the next draw that needs it. The
 * cost of an LRU eviction is therefore one 52 KB re-upload, which is cheaper
 * than carrying 300 private copies.
 */
function buildSharedIndex() {
  const quadIdx = GRID * GRID * 6;
  const skirtIdx = SKIRT_VERTS * 6;
  const idx = new Uint16Array(quadIdx + skirtIdx);
  let p = 0;

  for (let j = 0; j < GRID; j++) {
    for (let i = 0; i < GRID; i++) {
      const a = j * VERTS_PER_SIDE + i;
      const b = a + 1;
      const c = a + VERTS_PER_SIDE + 1;
      const d = a + VERTS_PER_SIDE;
      // (a, d, c) and (a, c, b) both give +Y normals with +X east / +Z south.
      idx[p++] = a;
      idx[p++] = d;
      idx[p++] = c;
      idx[p++] = a;
      idx[p++] = c;
      idx[p++] = b;
    }
  }

  const ring = boundaryRing();
  for (let s = 0; s < SKIRT_VERTS; s++) {
    const s2 = (s + 1) % SKIRT_VERTS;
    const topA = ring[s];
    const topB = ring[s2];
    const botA = GRID_VERTS + s;
    const botB = GRID_VERTS + s2;
    // Wound so the wall faces OUTWARD along a counter-clockwise-from-above ring.
    idx[p++] = topA;
    idx[p++] = botB;
    idx[p++] = topB;
    idx[p++] = topA;
    idx[p++] = botA;
    idx[p++] = botB;
  }

  return new THREE.BufferAttribute(idx, 1);
}

/**
 * The node boundary, traversed counter-clockwise as seen from above (+X east,
 * +Z south, looking down -Y). Getting this direction wrong flips every skirt
 * inward, where it is invisible and useless.
 */
function boundaryRing() {
  const ring = new Int32Array(SKIRT_VERTS);
  let k = 0;
  for (let j = 0; j < GRID; j++) ring[k++] = j * VERTS_PER_SIDE;
  for (let i = 0; i < GRID; i++) ring[k++] = GRID * VERTS_PER_SIDE + i;
  for (let j = GRID; j > 0; j--) ring[k++] = j * VERTS_PER_SIDE + GRID;
  for (let i = GRID; i > 0; i--) ring[k++] = i;
  return ring;
}

const _ring = boundaryRing();
/** (GRID + 3)^2 samples: the node lattice plus a one-cell border for normals. */
const _hgrid = new Float32Array((GRID + 3) * (GRID + 3));

/**
 * Sample the DEM for one node and turn it into a drawable chunk.
 *
 * Attributes:
 *   position  x, y = real elevation, z   (absolute scene metres)
 *   normal    from central differences at the node's own cell scale
 *   aMorph    x = height on the PARENT lattice, y = cell size, z = skirt drop
 *
 * aMorph.x is what makes the LOD continuous. For a vertex at an even index it
 * IS the fine height (the parent samples the same point); at an odd index it is
 * the linear interpolation the parent's triangle already draws. Morphing toward
 * it therefore lands exactly on the coarser surface, which is why neighbouring
 * LODs meet without a crack.
 */
function buildNodeGeometry(node, sharedIndex, exag) {
  const c = node.cell;
  const W = GRID + 3;

  // One extra ring of samples on each side, so edge normals are correct rather
  // than clamped — clamped edge normals give every chunk a visible dark rim.
  fillHeightGrid(node.x0 - c, node.z0 - c, c, c, W, W, _hgrid);

  const pos = new Float32Array(NODE_VERTS * 3);
  const nrm = new Float32Array(NODE_VERTS * 3);
  const mrp = new Float32Array(NODE_VERTS * 3);
  const drop = skirtDepthFor(c);
  const inv2c = 1 / (2 * c);

  let minY = Infinity;
  let maxY = -Infinity;

  for (let j = 0; j <= GRID; j++) {
    const gj = j + 1;
    for (let i = 0; i <= GRID; i++) {
      const gi = i + 1;
      const v = j * VERTS_PER_SIDE + i;
      const h = _hgrid[gj * W + gi] * exag;

      pos[v * 3] = node.x0 + i * c;
      pos[v * 3 + 1] = h;
      pos[v * 3 + 2] = node.z0 + j * c;

      // Same convention as elevation.getNormalLocal: +Y up, x east, z south.
      const hL = _hgrid[gj * W + gi - 1] * exag;
      const hR = _hgrid[gj * W + gi + 1] * exag;
      const hD = _hgrid[(gj - 1) * W + gi] * exag;
      const hU = _hgrid[(gj + 1) * W + gi] * exag;
      const nx = (hL - hR) * inv2c;
      const nz = (hD - hU) * inv2c;
      const len = Math.sqrt(nx * nx + 1 + nz * nz);
      nrm[v * 3] = nx / len;
      nrm[v * 3 + 1] = 1 / len;
      nrm[v * 3 + 2] = nz / len;

      // Parent lattice value: the parent samples every OTHER vertex of ours.
      let parent;
      const oddI = i & 1;
      const oddJ = j & 1;
      if (!oddI && !oddJ) {
        parent = h;
      } else if (oddI && !oddJ) {
        parent =
          (_hgrid[gj * W + gi - 1] + _hgrid[gj * W + gi + 1]) * 0.5 * exag;
      } else if (!oddI && oddJ) {
        parent =
          (_hgrid[(gj - 1) * W + gi] + _hgrid[(gj + 1) * W + gi]) * 0.5 * exag;
      } else {
        parent =
          (_hgrid[(gj - 1) * W + gi - 1] +
            _hgrid[(gj - 1) * W + gi + 1] +
            _hgrid[(gj + 1) * W + gi - 1] +
            _hgrid[(gj + 1) * W + gi + 1]) *
          0.25 *
          exag;
      }
      mrp[v * 3] = parent;
      mrp[v * 3 + 1] = c;
      mrp[v * 3 + 2] = 0;

      if (h < minY) minY = h;
      if (h > maxY) maxY = h;
    }
  }

  // Skirt: a copy of the boundary ring pushed straight down. It carries the
  // same morph target so it stays welded to the edge as the edge morphs.
  for (let s = 0; s < SKIRT_VERTS; s++) {
    const src = _ring[s];
    const dst = GRID_VERTS + s;
    pos[dst * 3] = pos[src * 3];
    pos[dst * 3 + 1] = pos[src * 3 + 1] - drop;
    pos[dst * 3 + 2] = pos[src * 3 + 2];
    nrm[dst * 3] = nrm[src * 3];
    nrm[dst * 3 + 1] = nrm[src * 3 + 1];
    nrm[dst * 3 + 2] = nrm[src * 3 + 2];
    mrp[dst * 3] = mrp[src * 3];
    mrp[dst * 3 + 1] = c;
    mrp[dst * 3 + 2] = drop;
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  geo.setAttribute('aMorph', new THREE.BufferAttribute(mrp, 3));
  geo.setIndex(sharedIndex);

  // Set bounds by hand: computeBoundingSphere() would walk 4,481 vertices we
  // have already measured, and the morph can lift a vertex above its sampled
  // height, so the box needs slack anyway.
  const half = node.size * 0.5;
  const pad = node.cell * 4;
  geo.boundingBox = new THREE.Box3(
    new THREE.Vector3(node.x0, minY - drop - pad, node.z0),
    new THREE.Vector3(node.x0 + node.size, maxY + pad, node.z0 + node.size),
  );
  geo.boundingSphere = new THREE.Sphere(
    new THREE.Vector3(node.x0 + half, (minY + maxY) * 0.5, node.z0 + half),
    Math.sqrt(2 * half * half + Math.pow((maxY - minY) * 0.5 + drop + pad, 2)),
  );

  return geo;
}

// ===========================================================================
// Terrain material
// ===========================================================================

/**
 * MeshStandardMaterial with the procedural surface injected.
 *
 * Deliberately NOT a from-scratch ShaderMaterial. Going through
 * onBeforeCompile keeps three's fog, its logarithmic depth buffer (mandatory
 * here — the near/far ratio is 0.35 m to 300 km), its lighting from sky.js and
 * its tone mapping working without this module reimplementing any of it. The
 * cost is that the injection points must match three's chunk names exactly.
 */
function makeTerrainMaterial(lodK, exag) {
  const uniforms = {
    uMorphK: { value: lodK },
    uNoiseOrigin: { value: new THREE.Vector2() },
    uExag: { value: exag },
  };

  const mat = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    roughness: 0.95,
    metalness: 0.0,
    // Skirts and the occasional overhanging cliff face read correctly from
    // below, and the cost is negligible for a surface that is ~95% front-facing.
    side: THREE.DoubleSide,
    dithering: true,
  });
  mat.name = 'terrain-surface';
  mat.userData.uniforms = uniforms;

  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);

    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        /* glsl */ `
        #include <common>
        attribute vec3 aMorph;
        uniform float uMorphK;
        varying vec3 vTerrWorld;
        varying vec3 vTerrNormal;
        varying float vTerrSurfaceY;
        `,
      )
      .replace(
        '#include <beginnormal_vertex>',
        /* glsl */ `
        #include <beginnormal_vertex>
        // Morph window: the outer quarter of this node's distance range. A node
        // of size S draws between K*S and 2*K*S from the camera, so by 2*K*S it
        // is fully collapsed onto its parent's lattice and the swap is a no-op.
        float tNodeSize = aMorph.y * float(${GRID});
        float tMorphStart = uMorphK * tNodeSize * 1.5;
        float tMorphEnd   = uMorphK * tNodeSize * 2.0;
        float tCamDist = distance(cameraPosition, position);
        float tMorph = clamp((tCamDist - tMorphStart) / max(tMorphEnd - tMorphStart, 1.0), 0.0, 1.0);
        `,
      )
      .replace(
        '#include <begin_vertex>',
        /* glsl */ `
        vec3 transformed = vec3( position );
        float tSurfY = mix(position.y, aMorph.x, tMorph);
        transformed.y = tSurfY - aMorph.z;
        vTerrSurfaceY = tSurfY;
        vTerrWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;
        vTerrNormal = normalize(mat3(modelMatrix) * objectNormal);
        `,
      );

    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        /* glsl */ `
        #include <common>
        uniform vec2 uNoiseOrigin;
        varying vec3 vTerrWorld;
        varying vec3 vTerrNormal;
        varying float vTerrSurfaceY;
        float tRoughOut;
        ${GLSL_NOISE}
        `,
      )
      .replace('#include <map_fragment>', TERRAIN_COLOUR_GLSL)
      .replace(
        '#include <roughnessmap_fragment>',
        'float roughnessFactor = tRoughOut;',
      );
  };

  // Without this three can hand us the program it compiled for some other
  // MeshStandardMaterial with the same defines — the cache key is built from
  // parameters, not from shader source.
  mat.customProgramCacheKey = () => 'ken-terrain-surface';

  return mat;
}

/**
 * The surface itself. Bands are real Cascade elevations; everything else is
 * plausible-looking noise.
 *
 * Two things here are load-bearing rather than decorative:
 *
 *  - The high-frequency octaves fade IN as the camera approaches (700 m and
 *    12 km cutoffs). That is the whole answer to GeoFS going mushy on short
 *    final: there is always another octave, and it costs nothing at altitude
 *    because it is switched off there and would only alias anyway.
 *
 *  - The slope a snowfield tolerates RISES with elevation. A fixed slope cutoff
 *    either strips Rainier bare (its flanks average 30 degrees) or paints
 *    vertical rock white. The ramp from 0.85 at 1,700 m to 2.3 above 4,000 m is
 *    what produces a glaciated cone with rock ribs through it.
 */
const TERRAIN_COLOUR_GLSL = /* glsl */ `
{
  float h = vTerrSurfaceY;
  vec3 nw = normalize(vTerrNormal);
  if (!gl_FrontFacing) nw = -nw;
  float slope = length(nw.xz) / max(abs(nw.y), 0.02);

  vec2 wp = vTerrWorld.xz;
  vec2 lp = wp - uNoiseOrigin;
  float camDist = distance(vTerrWorld, cameraPosition);

  float nMacro = tNoise(wp * (1.0 / 8192.0));
  float nMeso  = tNoise(wp * (1.0 / 2048.0));
  float nPatch = tNoise(wp * (1.0 / 256.0));

  float fadeMid = 1.0 - smoothstep(2500.0, 12000.0, camDist);
  float nMicro = mix(0.5, tNoise(lp * (1.0 / 32.0)), fadeMid);
  float fadeNear = 1.0 - smoothstep(120.0, 700.0, camDist);
  float nUltra = mix(0.5, tNoise(lp * (1.0 / 8.0)) * 0.55 + tNoise(lp * 0.25) * 0.45, fadeNear);

  float grain = (nPatch - 0.5) * 0.20 + (nMicro - 0.5) * 0.30 + (nUltra - 0.5) * 0.26;

  vec3 cSeabed  = tSrgb(vec3(0.10, 0.16, 0.20));
  vec3 cSilt    = tSrgb(vec3(0.28, 0.30, 0.27));
  vec3 cSand    = tSrgb(vec3(0.66, 0.61, 0.48));
  vec3 cLowland = tSrgb(vec3(0.34, 0.43, 0.24));
  vec3 cForestD = tSrgb(vec3(0.15, 0.24, 0.14));
  vec3 cForestL = tSrgb(vec3(0.24, 0.35, 0.19));
  vec3 cSubalp  = tSrgb(vec3(0.39, 0.42, 0.27));
  vec3 cRockL   = tSrgb(vec3(0.50, 0.47, 0.42));
  vec3 cRockD   = tSrgb(vec3(0.28, 0.26, 0.25));
  vec3 cSnow    = tSrgb(vec3(0.94, 0.96, 0.99));
  vec3 cIce     = tSrgb(vec3(0.76, 0.85, 0.94));

  // --- elevation bands, low to high -------------------------------------
  vec3 col = cSeabed;
  col = mix(col, cSilt, smoothstep(-24.0, -3.0, h));
  col = mix(col, cSand, smoothstep(-2.5, 0.9, h));

  // Puget Sound is temperate rainforest: the lowland green is dark and
  // desaturated, not meadow green, and it goes darker with altitude.
  vec3 forest = mix(cForestD, cForestL, clamp(nPatch * 0.8 + nMeso * 0.4 + grain, 0.0, 1.0));
  col = mix(col, cLowland, smoothstep(0.8, 7.0, h));
  col = mix(col, forest, smoothstep(15.0, 130.0, h) * (0.62 + 0.38 * nMacro));
  col = mix(col, cForestD, smoothstep(200.0, 700.0, h) * 0.55);

  float treeline = 1620.0 + (nMeso - 0.5) * 300.0 + (nPatch - 0.5) * 90.0;
  col = mix(col, cSubalp, smoothstep(treeline - 320.0, treeline + 140.0, h));

  // --- slope: bare rock wherever the ground is too steep to hold anything -
  vec3 rock = mix(cRockD, cRockL, clamp(nMeso * 0.7 + nPatch * 0.4 + grain * 1.2, 0.0, 1.0));
  float rocky = smoothstep(0.62, 1.10, slope + grain * 0.30);
  rocky *= smoothstep(0.4, 5.0, h);
  col = mix(col, rock, rocky);

  // --- snow and ice ------------------------------------------------------
  // North faces (-Z is north) hold snow several hundred metres lower.
  float northFace = clamp(-nw.z * 1.4, 0.0, 1.0);
  float snowLine = 1790.0 - 230.0 * northFace + (nMeso - 0.5) * 280.0 + (nPatch - 0.5) * 110.0;
  float snowSlopeMax = mix(0.85, 2.30, clamp((h - 1700.0) / 2300.0, 0.0, 1.0));
  float snowy = smoothstep(snowLine, snowLine + 300.0, h);
  snowy *= 1.0 - smoothstep(snowSlopeMax * 0.72, snowSlopeMax, slope + grain * 0.25);
  // Permanent ice cap: above 2,800 m only a near-vertical face stays bare.
  snowy = max(snowy, smoothstep(2750.0, 3150.0, h) * (1.0 - smoothstep(1.85, 2.60, slope)));

  vec3 snowCol = mix(cSnow, cIce, smoothstep(2500.0, 3700.0, h) * 0.6);
  snowCol *= 0.93 + grain * 0.14;
  snowy = clamp(snowy, 0.0, 1.0);
  col = mix(col, snowCol, snowy);

  col *= 0.90 + 0.20 * nMacro + grain * 0.10;

  tRoughOut = mix(0.95, 0.58, snowy);
  tRoughOut = mix(tRoughOut, 0.86, rocky * 0.7);

  diffuseColor.rgb *= col;
}
`;

// ===========================================================================
// Water
// ===========================================================================

/**
 * The sea and the lakes, sharing one shader.
 *
 * Same onBeforeCompile approach as the terrain, for the same reasons, plus one
 * more: MeshStandardMaterial's GGX lobe at low roughness gives a real sun
 * glitter path for free once the wave normals are perturbed, which a hand-rolled
 * water shader would have to reproduce.
 *
 * What this is NOT: a planar reflection. The grazing-angle term reflects the
 * sky COLOUR, read from scene.background each frame, not the actual scene. At
 * 84 km and from a cockpit that is indistinguishable; from a boat it would not
 * be.
 *
 * @param {boolean} lake Freshwater palette, and depth taken from shore distance
 *        only — Terrarium gives lakes a flat surface elevation and no bed, so
 *        there is no depth to read.
 */
function makeWaterMaterial(fieldTexture, rect, seaLevelM, lake) {
  const uniforms = {
    uTime: { value: 0 },
    uWaveOrigin: { value: new THREE.Vector2() },
    uField: { value: fieldTexture },
    uFieldRect: {
      value: new THREE.Vector4(
        rect.xMin,
        rect.zMin,
        1 / (rect.xMax - rect.xMin),
        1 / (rect.zMax - rect.zMin),
      ),
    },
    uSkyColor: { value: new THREE.Color(0x87b6e8) },
    uWaterY: { value: seaLevelM },
    uLake: { value: lake ? 1 : 0 },
    uShoreMax: { value: SHORE_MAX_M },
  };

  const mat = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    roughness: 0.075,
    metalness: 0.0,
    transparent: true,
    opacity: 1.0,
    // Water writes no depth: it is the last thing drawn and anything behind it
    // has already resolved. Writing depth would make overlapping surfaces (the
    // sea plane under a lake) punch holes in each other.
    depthWrite: false,
    side: THREE.FrontSide,
    dithering: true,
  });
  mat.name = lake ? 'terrain-lake-surface' : 'terrain-sea-surface';
  mat.userData.uniforms = uniforms;

  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);

    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        /* glsl */ `
        #include <common>
        varying vec3 vWaterWorld;
        `,
      )
      .replace(
        '#include <begin_vertex>',
        /* glsl */ `
        #include <begin_vertex>
        vWaterWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;
        `,
      );

    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        /* glsl */ `
        #include <common>
        uniform float uTime;
        uniform vec2 uWaveOrigin;
        uniform sampler2D uField;
        uniform vec4 uFieldRect;
        uniform vec3 uSkyColor;
        uniform float uWaterY;
        uniform float uLake;
        uniform float uShoreMax;
        varying vec3 vWaterWorld;
        vec3 wWaveNormal;
        float wFresnelOut;
        float wFoamOut;
        ${GLSL_NOISE}

        // Three scrolling octaves. Amplitudes are unitless; the gradient is
        // scaled at the end to a slope that actually catches the sun, because a
        // physically-correct 0.02 slope on 3 m chop is invisible at flight
        // altitude.
        float wWave(vec2 p, float t) {
          return tNoise(p * (1.0 / 256.0) + vec2(t * 0.0045, t * 0.0028)) * 1.00
               + tNoise(p * (1.0 / 64.0)  + vec2(-t * 0.014, t * 0.009))  * 0.42
               + tNoise(p * (1.0 / 16.0)  + vec2(t * 0.035, -t * 0.022))  * 0.15;
        }
        `,
      )
      .replace('#include <map_fragment>', WATER_COLOUR_GLSL)
      .replace(
        '#include <roughnessmap_fragment>',
        /* glsl */ `
        // Chop that the pixel can no longer resolve becomes roughness instead,
        // which is what stops distant water turning into a field of aliased
        // white sparks.
        float wDist = distance(vWaterWorld, cameraPosition);
        float roughnessFactor = mix(0.045, 0.22, smoothstep(400.0, 14000.0, wDist));
        `,
      )
      .replace(
        '#include <normal_fragment_maps>',
        /* glsl */ `
        #include <normal_fragment_maps>
        // viewMatrix is in three's fragment prefix and has no scale, so it maps
        // a world-space normal straight into view space.
        normal = normalize((viewMatrix * vec4(wWaveNormal, 0.0)).xyz);
        `,
      )
      .replace(
        '#include <emissivemap_fragment>',
        /* glsl */ `
        #include <emissivemap_fragment>
        totalEmissiveRadiance += uSkyColor * wFresnelOut * 0.85;
        totalEmissiveRadiance += vec3(0.55) * wFoamOut * 0.35;
        `,
      );
  };

  mat.customProgramCacheKey = () =>
    lake ? 'ken-terrain-lake' : 'ken-terrain-sea';

  return mat;
}

const WATER_COLOUR_GLSL = /* glsl */ `
{
  vec2 wp = vWaterWorld.xz;
  vec2 lp = wp - uWaveOrigin;
  float camDist = distance(vWaterWorld, cameraPosition);

  // Numeric gradient of the wave field. Three evaluations, and the chop is
  // damped with distance so far water settles instead of shimmering.
  float e = 2.0;
  float h0 = wWave(lp, uTime);
  float hx = wWave(lp + vec2(e, 0.0), uTime);
  float hz = wWave(lp + vec2(0.0, e), uTime);
  float chop = mix(1.0, 0.18, smoothstep(300.0, 9000.0, camDist));
  vec2 g = (vec2(hx, hz) - h0) * (12.0 * chop / e);
  wWaveNormal = normalize(vec3(-g.x, 1.0, -g.y));

  // Region field: R = bed elevation, G = metres to the nearest land.
  vec2 fuv = (wp - uFieldRect.xy) * uFieldRect.zw;
  vec2 fuvC = clamp(fuv, 0.0, 1.0);
  // Outside the baked region it is open ocean, not the edge texel repeated.
  float outside = (fuv.x != fuvC.x || fuv.y != fuvC.y) ? 1.0 : 0.0;
  vec2 fs = texture2D(uField, fuvC).rg;
  float bed = fs.r;
  float shore = mix(fs.g, uShoreMax, outside);

  float depth = max(uWaterY - bed, 0.0);
  // Distance to shore, not bathymetry: Terrarium reads a flat zero across the
  // main basin, so depth alone would paint the whole Sound as shallows.
  float openness = smoothstep(60.0, 1400.0, shore);
  float deepness = (uLake > 0.5) ? openness : max(openness, smoothstep(1.0, 20.0, depth));

  vec3 shallowSalt = tSrgb(vec3(0.29, 0.50, 0.50));
  vec3 deepSalt    = tSrgb(vec3(0.040, 0.105, 0.160));
  vec3 shallowFresh= tSrgb(vec3(0.24, 0.40, 0.36));
  vec3 deepFresh   = tSrgb(vec3(0.055, 0.135, 0.150));
  vec3 shallowC = mix(shallowSalt, shallowFresh, uLake);
  vec3 deepC    = mix(deepSalt, deepFresh, uLake);

  vec3 base = mix(shallowC, deepC, deepness);
  // Subtle large-scale variation so the open water is not a flat colour field.
  base *= 0.94 + 0.12 * tNoise(wp * (1.0 / 3000.0));

  // Grazing-angle sky reflection, from the FLAT normal so it does not flicker
  // with the wave noise. The perturbed normal drives the sun glint instead.
  vec3 toEye = normalize(cameraPosition - vWaterWorld);
  float f = pow(1.0 - clamp(toEye.y, 0.0, 1.0), 5.0);
  wFresnelOut = clamp(0.02 + 0.98 * f, 0.0, 1.0) * 0.75;

  // Surf. The shore field is ~165 m per texel, so the band is broad by
  // construction; heavy noise modulation keeps it from reading as a contour.
  float surf = 1.0 - smoothstep(20.0, 340.0, shore);
  float churn = tNoise(lp * (1.0 / 24.0) + vec2(uTime * 0.05, uTime * 0.03));
  churn = churn * 0.6 + tNoise(lp * (1.0 / 6.0) - vec2(uTime * 0.11, 0.0)) * 0.4;
  wFoamOut = surf * smoothstep(0.44, 0.80, churn) * (1.0 - uLake * 0.65);
  base = mix(base, vec3(0.85), wFoamOut * 0.75);

  diffuseColor.rgb = base;
  // Shallow water is see-through; open water is not. Grazing angles close it up.
  float clarity = 1.0 - smoothstep(0.0, 3.5, depth);
  diffuseColor.a = clamp(mix(0.94, 0.55, clarity * (1.0 - deepness)) + f * 0.35 + wFoamOut * 0.4, 0.0, 1.0);
}
`;

// ===========================================================================
// Region field: heights + distance to shore
// ===========================================================================

function computeRegionRect(bbox) {
  const nw = llToLocal(bbox.north, bbox.west);
  const se = llToLocal(bbox.south, bbox.east);
  const xMin = Math.min(nw.x, se.x);
  const xMax = Math.max(nw.x, se.x);
  const zMin = Math.min(nw.z, se.z);
  const zMax = Math.max(nw.z, se.z);
  // A little margin, so the shoreline at the region edge does not read as a
  // wall of land in the clamped texel.
  const mx = (xMax - xMin) * 0.03;
  const mz = (zMax - zMin) * 0.03;
  return {
    xMin: xMin - mx,
    xMax: xMax + mx,
    zMin: zMin - mz,
    zMax: zMax + mz,
    xMid: (xMin + xMax) * 0.5,
    zMid: (zMin + zMax) * 0.5,
  };
}

function buildRegionField(rect, seaLevelM) {
  const n = FIELD_N;
  const dx = (rect.xMax - rect.xMin) / (n - 1);
  const dz = (rect.zMax - rect.zMin) / (n - 1);
  const height = fillHeightGrid(rect.xMin, rect.zMin, dx, dz, n, n);
  const water = new Uint8Array(n * n);
  for (let i = 0; i < n * n; i++) {
    water[i] = height[i] <= seaLevelM + WATER_LEVEL_M ? 1 : 0;
  }
  return { n, dx, dz, rect, height, water, shore: new Float32Array(n * n) };
}

/** Lake texels count as water, or the shore field would read zero inside them. */
function markLakesAsWater(field, rect, lakes) {
  const { n, dx, dz, water } = field;
  for (let j = 0; j < n; j++) {
    const z = rect.zMin + j * dz;
    for (let i = 0; i < n; i++) {
      if (water[j * n + i]) continue;
      const x = rect.xMin + i * dx;
      if (lakeAt(lakes, x, z) > 0) water[j * n + i] = 1;
    }
  }
}

/**
 * Chamfer distance transform: two sweeps, 3-4 weights. Exact enough at 165 m
 * per texel and about 8 ms for 1.6 M cells — a full Euclidean transform would
 * cost more and change nothing anyone can see.
 */
function computeShoreDistance(field) {
  const { n, dx, dz, water, shore } = field;
  const cell = (dx + dz) * 0.5;
  const D1 = cell;
  const D2 = cell * Math.SQRT2;
  const BIG = 1e9;

  for (let i = 0; i < n * n; i++) shore[i] = water[i] ? BIG : 0;

  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const k = j * n + i;
      let v = shore[k];
      if (v === 0) continue;
      if (i > 0) v = Math.min(v, shore[k - 1] + D1);
      if (j > 0) v = Math.min(v, shore[k - n] + D1);
      if (i > 0 && j > 0) v = Math.min(v, shore[k - n - 1] + D2);
      if (i < n - 1 && j > 0) v = Math.min(v, shore[k - n + 1] + D2);
      shore[k] = v;
    }
  }
  for (let j = n - 1; j >= 0; j--) {
    for (let i = n - 1; i >= 0; i--) {
      const k = j * n + i;
      let v = shore[k];
      if (v === 0) continue;
      if (i < n - 1) v = Math.min(v, shore[k + 1] + D1);
      if (j < n - 1) v = Math.min(v, shore[k + n] + D1);
      if (i < n - 1 && j < n - 1) v = Math.min(v, shore[k + n + 1] + D2);
      if (i > 0 && j < n - 1) v = Math.min(v, shore[k + n - 1] + D2);
      shore[k] = Math.min(v, SHORE_MAX_M);
    }
  }
}

/**
 * RG16F: R = bed elevation in metres, G = metres to the nearest land.
 * Half float, not float — LINEAR filtering of a 32-bit float texture needs
 * OES_texture_float_linear, which is not guaranteed; half float is filterable
 * in core WebGL2. At 4,000 m a half float's step is 2 m, which for a water
 * shader is nothing.
 */
function uploadField(field) {
  const { n, height, shore } = field;
  const data = new Uint16Array(n * n * 2);
  const toHalf = THREE.DataUtils.toHalfFloat;
  for (let i = 0; i < n * n; i++) {
    data[i * 2] = toHalf(clamp(height[i], -1000, 9000));
    data[i * 2 + 1] = toHalf(shore[i]);
  }
  const tex = new THREE.DataTexture(
    data,
    n,
    n,
    THREE.RGFormat,
    THREE.HalfFloatType,
  );
  tex.name = 'terrain-region-field';
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  return tex;
}

// ===========================================================================
// Freshwater lakes
// ===========================================================================

/**
 * Find lake surfaces by flatness plus the basin test.
 *
 * @returns {{nx:number, nz:number, x0:number, z0:number, cell:number,
 *            mask:Uint8Array, level:Float32Array, cells:number, kept:number}}
 */
function detectLakes() {
  const nw = llToLocal(LAKE_BOX.north, LAKE_BOX.west);
  const se = llToLocal(LAKE_BOX.south, LAKE_BOX.east);
  const x0 = Math.min(nw.x, se.x);
  const z0 = Math.min(nw.z, se.z);
  const w = Math.abs(se.x - nw.x);
  const d = Math.abs(se.z - nw.z);
  const cell = LAKE_CELL_M;
  const nx = Math.max(4, Math.round(w / cell));
  const nz = Math.max(4, Math.round(d / cell));

  const h = fillHeightGrid(x0, z0, cell, cell, nx, nz);
  const flat = new Uint8Array(nx * nz);

  for (let j = 1; j < nz - 1; j++) {
    for (let i = 1; i < nx - 1; i++) {
      const k = j * nx + i;
      const v = h[k];
      if (v < LAKE_MIN_M || v > LAKE_MAX_M) continue;
      const a = Math.abs(v - h[k - 1]);
      const b = Math.abs(v - h[k + 1]);
      const c = Math.abs(v - h[k - nx]);
      const e = Math.abs(v - h[k + nx]);
      if (a < LAKE_FLAT_M && b < LAKE_FLAT_M && c < LAKE_FLAT_M && e < LAKE_FLAT_M) {
        flat[k] = 1;
      }
    }
  }

  const mask = new Uint8Array(nx * nz);
  const level = new Float32Array(nx * nz);
  const seen = new Uint8Array(nx * nz);
  const stack = new Int32Array(nx * nz);
  const comp = new Int32Array(nx * nz);
  const cellArea = cell * cell;
  let kept = 0;
  let cells = 0;
  const found = [];

  for (let start = 0; start < nx * nz; start++) {
    if (!flat[start] || seen[start]) continue;
    let sp = 0;
    let cp = 0;
    stack[sp++] = start;
    seen[start] = 1;
    let lo = Infinity;
    let hi = -Infinity;
    let sum = 0;

    while (sp > 0) {
      const k = stack[--sp];
      comp[cp++] = k;
      const v = h[k];
      if (v < lo) lo = v;
      if (v > hi) hi = v;
      sum += v;
      const i = k % nx;
      const j = (k / nx) | 0;
      if (i > 0 && flat[k - 1] && !seen[k - 1]) { seen[k - 1] = 1; stack[sp++] = k - 1; }
      if (i < nx - 1 && flat[k + 1] && !seen[k + 1]) { seen[k + 1] = 1; stack[sp++] = k + 1; }
      if (j > 0 && flat[k - nx] && !seen[k - nx]) { seen[k - nx] = 1; stack[sp++] = k - nx; }
      if (j < nz - 1 && flat[k + nx] && !seen[k + nx]) { seen[k + nx] = 1; stack[sp++] = k + nx; }
    }

    const area = cp * cellArea;
    if (area < LAKE_MIN_AREA_M2 || area > LAKE_MAX_AREA_M2) continue;
    if (hi - lo > 1.5) continue;
    const surface = sum / cp;

    // THE BASIN TEST. Flatness alone also selects the Kent valley floor and
    // airport aprons; a lake is distinguished by its rim rising away from it.
    let rim = 0;
    let rimSum = 0;
    let rimAbove = 0;
    for (let m = 0; m < cp; m++) {
      const k = comp[m];
      const i = k % nx;
      const j = (k / nx) | 0;
      for (let o = 0; o < 4; o++) {
        const ii = i + (o === 0 ? -1 : o === 1 ? 1 : 0);
        const jj = j + (o === 2 ? -1 : o === 3 ? 1 : 0);
        if (ii < 0 || ii >= nx || jj < 0 || jj >= nz) continue;
        const kk = jj * nx + ii;
        if (flat[kk] && seen[kk]) continue;
        rim++;
        rimSum += h[kk];
        if (h[kk] > surface + 0.25) rimAbove++;
      }
    }
    if (rim < 8) continue;
    if (rimSum / rim < surface + LAKE_RIM_RISE_M) continue;
    if (rimAbove / rim < 0.6) continue;

    for (let m = 0; m < cp; m++) {
      mask[comp[m]] = 1;
      level[comp[m]] = surface;
    }
    cells += cp;
    kept++;
    found.push({ areaKm2: area / 1e6, surfaceM: surface });
  }

  if (found.length) {
    found.sort((a, b) => b.areaKm2 - a.areaKm2);
    console.info(
      '[terrain] lakes: ' +
        found
          .slice(0, 6)
          .map((f) => `${f.areaKm2.toFixed(1)}km2@${f.surfaceM.toFixed(1)}m`)
          .join(', ') +
        (found.length > 6 ? ` (+${found.length - 6} more)` : ''),
    );
  } else {
    console.warn('[terrain] no freshwater lakes detected — check the DEM bake');
  }

  return { nx, nz, x0, z0, cell, mask, level, cells, kept };
}

/** Lake surface height at a local point, or 0 if there is none. */
function lakeAt(lakes, x, z) {
  const i = Math.round((x - lakes.x0) / lakes.cell);
  const j = Math.round((z - lakes.z0) / lakes.cell);
  if (i < 0 || i >= lakes.nx || j < 0 || j >= lakes.nz) return 0;
  const k = j * lakes.nx + i;
  return lakes.mask[k] ? lakes.level[k] : 0;
}

/**
 * One quad per lake cell, at that lake's own surface level. Vertices are welded
 * per cell rather than shared — the cell count is small and it keeps adjacent
 * lakes at different levels from tearing into each other.
 */
function buildLakeGeometry(lakes) {
  const { nx, nz, x0, z0, cell, mask, level, cells } = lakes;
  if (cells === 0) return null;

  const pos = new Float32Array(cells * 4 * 3);
  const nrm = new Float32Array(cells * 4 * 3);
  const idx = new Uint32Array(cells * 6);
  let v = 0;
  let p = 0;

  for (let j = 0; j < nz; j++) {
    for (let i = 0; i < nx; i++) {
      const k = j * nx + i;
      if (!mask[k]) continue;
      // Sits a hand's breadth above the flat DEM plateau it was detected on,
      // which is enough to stop z-fighting without floating visibly.
      const y = level[k] + 0.15;
      const xa = x0 + (i - 0.5) * cell;
      const xb = xa + cell;
      const za = z0 + (j - 0.5) * cell;
      const zb = za + cell;

      const base = v;
      setV(pos, nrm, v++, xa, y, za);
      setV(pos, nrm, v++, xb, y, za);
      setV(pos, nrm, v++, xb, y, zb);
      setV(pos, nrm, v++, xa, y, zb);

      // (a, d, c) / (a, c, b) — the same +Y winding as the terrain lattice.
      idx[p++] = base;
      idx[p++] = base + 3;
      idx[p++] = base + 2;
      idx[p++] = base;
      idx[p++] = base + 2;
      idx[p++] = base + 1;
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  geo.setIndex(new THREE.BufferAttribute(idx, 1));
  geo.computeBoundingSphere();
  return geo;
}

function setV(pos, nrm, i, x, y, z) {
  pos[i * 3] = x;
  pos[i * 3 + 1] = y;
  pos[i * 3 + 2] = z;
  nrm[i * 3] = 0;
  nrm[i * 3 + 1] = 1;
  nrm[i * 3 + 2] = 0;
}
