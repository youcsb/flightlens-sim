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
 * — INDEPENDENT OF S. That is the whole point: one constant, 1/160 rad here
 * (~6 px at 1080p / 60 deg FOV), governs the silhouette error everywhere, from
 * the runway threshold to Mount Rainier at 84 km. A naive "coarser when far"
 * scheme would render Rainier as a lump; this one puts 512 m cells on it at
 * 84 km, about forty samples across the cone.
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
  loadDetailLayers,
  setViewer,
  getElevationLocal,
  fillHeightGrid,
  isLoaded as demLoaded,
  SEA_LEVEL_M,
  DEM_ZOOM,
  WATER_LEVEL_M,
} from '../geo/elevation.js';
import { REGION_BBOX, llToLocal } from '../geo/coords.js';
import { loadLandcover } from '../geo/landcover.js';
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
 * @property {boolean} [detail]      Also load every finer level the DEM manifest
 *           declares — z=13 region-wide at 12.95 m/px and z=14 over the Seattle
 *           inset at 6.47 m/px. These are paged, not resident. Default true.
 *           With it off the whole region is the 51.8 m/px pinned base.
 * @property {boolean} [loadDem]     Set false to skip loading (tests). Default true.
 * @property {number} [exaggeration] Vertical scale. KEEP AT 1 — anything else makes
 *           the terrain a lie. Exposed only for debugging.
 * @property {number} [seaLevelM]    Water plane height. Default SEA_LEVEL_M (0).
 * @property {boolean} [water]       Build the sea + lake surfaces. Default true.
 * @property {boolean} [landcover]   Load the baked NLCD land-cover rasters and
 *           let them drive surface albedo. Default true. With it off (or with
 *           nothing baked) the surface falls back to the elevation-and-slope
 *           palette, which paints every lowland the same green.
 * @property {number} [lodQuality]   Multiplies LOD_K. >1 = more triangles, sharper
 *           silhouettes, more draw calls. Default 1.
 * @property {number} [originX] @property {number} [originY] @property {number} [originZ]
 *           Where to build the first full set of chunks, in local scene metres.
 *           Default (0, 400, 0) — the scene origin is the KBFI spawn by
 *           construction (MODULES.md 1.3), so the default is already right; the
 *           override exists for callers that move the spawn.
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
  landcover: true,
  lodQuality: 1,
  originX: 0,
  originY: 400,
  originZ: 0,
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
 * at the same fidelity needs four times the draw calls — WebGL dies on the call
 * overhead long before the GPU notices the triangles.
 */
const GRID = 64;
const VERTS_PER_SIDE = GRID + 1;
const GRID_VERTS = VERTS_PER_SIDE * VERTS_PER_SIDE; // 4225
const SKIRT_VERTS = GRID * 4; // 256
const NODE_VERTS = GRID_VERTS + SKIRT_VERTS; // 4481, comfortably under 65536

/**
 * A node subdivides while the camera is within LOD_K * nodeSize of it.
 *
 * THIS NUMBER IS A BUDGET, NOT A TASTE SETTING. Nodes of a given level that end
 * up drawn are exactly those whose box-distance falls in [K*S, 2*K*S), an
 * annulus whose area goes as K^2*S^2 — so the count per level goes as K^2,
 * INDEPENDENT of S, and is paid once for every level between the finest node
 * and the draw radius. Here that is seven levels (512 m up to 32 km), and the
 * cost is quadratic in K:
 *
 *   K = 4.0   ~2,500 nodes drawn   ~400 MB of vertex buffers
 *   K = 2.5      608 nodes drawn    142 MB   <- measured, 881 alive
 *
 * K = 4 was the value this file shipped with, and it does not fit in any
 * plausible cache. The failure is not a slow frame, it is a LIMIT CYCLE:
 * evictStale() destroys chunks the next frame needs, visit() then refuses to
 * subdivide (a node only subdivides once all four children own geometry), so
 * the parent draws itself coarse, its children get rebuilt, and round it goes.
 * Measured with a STATIONARY camera at the KBFI spawn it drew 243 nodes on
 * frame 120 and 174 on frame 400, never the same set twice — continuous
 * popping, 5 ms/frame of rebuilds forever, and Mount Rainier stuck on 2,048 m
 * cells instead of 256. At K = 2.5 the same test draws an IDENTICAL 608 nodes
 * on frames 30, 120 and 400, and update() falls to 0 ms.
 *
 * The price is screen error: 1/(GRID*K) goes from 1/256 rad to 1/160 (~6 px at
 * 1080p / 60 deg FOV rather than ~4). That is the right trade for a terrain
 * that actually converges. If you raise K, raise MAX_CACHED_NODES by K^2 in the
 * same edit and re-run the stationary-camera test.
 */
const LOD_K = 2.5;

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
 * Built geometries kept alive. ~161 KB each, so 1,100 is ~177 MB of vertex
 * buffers in the worst case.
 *
 * THIS MUST EXCEED THE WORKING SET or the LOD never converges — see LOD_K. The
 * working set is not a guess: measured at the KBFI spawn with an unbounded
 * cache, the selection settles on 608 drawn / 881 alive and then does not
 * change at all between frame 30 and frame 400. 1,100 is that plus 25% of
 * slack, which is what lets a 180-degree turn reuse the ground behind you
 * instead of rebuilding it.
 */
const MAX_CACHED_NODES = 1100;

/**
 * Evict only once the cache is this far over. Without hysteresis, a working set
 * that sits just above the cap makes evictStale() sort the whole array every
 * single frame for the sake of one or two nodes.
 */
const EVICT_SLACK = 96;

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
 *
 * ---------------------------------------------------------------------------
 * THE RIM HAS TO BE MEASURED AT A DISTANCE. This is the part that was wrong.
 * ---------------------------------------------------------------------------
 * The obvious basin test — compare the surface against the ring of cells
 * immediately outside the flat component — CANNOT EVER PASS, and it silently
 * rejected every lake in the region. The flatness test itself disqualifies a
 * cell whose neighbour steps by 0.35 m, so the component is eroded one cell
 * short of the shoreline and the ring immediately outside it is *still water*.
 * Measured on Lake Washington: 74.2 km^2 of surface at 5.10 m, 1,456 rim cells
 * averaging 5.15 m — 0.05 m of "rise" against a 1.00 m threshold. Console said
 * "no freshwater lakes detected" and every lake in the sim was dry ground.
 *
 * So the rim is taken from a BFS dilation LAKE_RIM_DILATE cells out, which
 * clears the eroded band and lands on real shore. Lake Washington then reads a
 * rim mean of 16.2 m against a 5.10 m surface.
 *
 * The dilated rim needs one extra guard the tight ring did not: a tideflat or a
 * river delta is flat, near sea level, and has land rising on three sides, so it
 * passes a rise test. It is distinguished by having somewhere LOWER to drain to
 * within the same 384 m — the open water it sits on. LAKE_RIM_BELOW_FRAC is
 * that test, and it is what keeps the Nisqually and Duwamish deltas out.
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
/** Cells to dilate outward before sampling the rim. 4 * 96 m = 384 m. */
const LAKE_RIM_DILATE = 4;
/** The dilated rim must average this much above the surface, metres. */
const LAKE_RIM_RISE_M = 2.0;
/** ...and this fraction of it must individually be above the surface. */
const LAKE_RIM_ABOVE_FRAC = 0.6;
/** A basin has nowhere lower to go: at most this fraction of the rim may be below. */
const LAKE_RIM_BELOW_FRAC = 0.06;
/**
 * Grow the kept mask back over the one-cell band the flatness test ate, but
 * only onto cells that are themselves at the lake's surface height. Without it
 * every lake is drawn 96 m short of its own shoreline.
 */
const LAKE_EDGE_TOLERANCE_M = 0.75;

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
/** Previous camera position + timestamp, for the DEM pager's velocity lead. */
const _camPrev = new THREE.Vector3();
let _camPrevMs = -1;
const _probe = new Float32Array(81);
/** Hoisted so evictStale()'s sort does not allocate a comparator per frame. */
const byLastUsed = (a, b) => a.lastUsed - b.lastUsed;

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
  // The land-cover rasters are two independent HTTP fetches with no dependency
  // on the DEM, so they stream alongside it rather than after it. §1.6: a
  // failure here resolves to null and the surface falls back to elevation
  // bands — it must never stop the ground from existing.
  const landcoverPromise = cfg.landcover
    ? loadLandcover().catch((err) => {
        console.warn('[terrain] land cover failed to load:', err);
        return null;
      })
    : Promise.resolve(null);

  if (cfg.loadDem) {
    // The base layer is PINNED: every tile, decoded, before the first frame.
    // It is the floor that makes a paging miss survivable (elevation.js
    // § PAGING, property 2), so it is the one thing worth blocking boot on.
    await loadRegion(cfg.bbox, cfg.zoom);
    if (cfg.detail) {
      // Every finer level the manifest declares — currently z=13 region-wide
      // and z=14 over the Seattle inset. These are PAGED: this awaits only a
      // small warm-up disc around the spawn and the rest streams in behind
      // setViewer() below. Asking the manifest rather than naming the zooms
      // means adding a level to bake-dem.mjs needs no change here.
      await loadDetailLayers(cfg.zoom);
    }
  }
  const landcover = await landcoverPromise;
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
  const field = buildRegionField(regionRect, cfg.seaLevelM, landcover);
  const tField = performance.now();

  // Where the DEM actually has something to say. Outside it every layer misses
  // and getElevation() returns SEA_LEVEL_M exactly — not approximately — so a
  // node out there is a flat quad at y = 0 that the sea plane already covers.
  // Drawing it anyway costs a chunk AND looks wrong: the water shader reads a
  // zero-depth bed under it and paints the open ocean as sandy shallows.
  //
  // The margin is one z=11 tile (~13.3 km at this latitude), because the baker
  // rounds the bbox out to tile boundaries and the real coverage runs that far
  // past the nominal edge.
  const demRect = computeDemRect(cfg.bbox, 16000);

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
  const terrainMat = makeTerrainMaterial(lodK, exag, landcover, fieldTexture, regionRect);
  const seaMat = cfg.water
    ? makeWaterMaterial(fieldTexture, regionRect, cfg.seaLevelM, false)
    : null;
  const lakeMat = cfg.water
    ? makeWaterMaterial(fieldTexture, regionRect, cfg.seaLevelM, true)
    : null;
  /** Hoisted: update() runs every frame and 1.8 forbids allocating in it. */
  const waterMats = [seaMat, lakeMat].filter(Boolean);

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
  //
  // ONE PASS IS NOT ENOUGH, and this is the trap the file shipped with. visit()
  // deliberately refuses to subdivide a node until all four children own
  // geometry — it queues them and draws itself this frame instead. So a single
  // selectFrom() descends exactly zero levels: it emits the ROOT, a 262 km quad
  // with 4 km cells, and queues four children that nobody builds because
  // drainPrefetch() runs in update(), not here. Measured: `1 node drawn` on
  // frame 0, ~120 frames to converge, and for those two seconds the aircraft
  // sits on a plane that is hundreds of metres from the surveyed runway
  // elevation. getHeightAt() is right the whole time, which is worse — the
  // wheels are correct and the *picture* is wrong.
  //
  // Each pass descends one level, so MAX_LEVEL + 2 is a hard bound on the loop
  // and the break is what normally ends it.
  /**
   * Run selection to a fixed point at (x, y, z), building every chunk it asks
   * for, with no time budget. Blocking, and deliberately so.
   *
   * Called at bootstrap, and again by main.js after a teleport — jumping 84 km
   * to Mount Rainier lands in a part of the tree that has never been visited,
   * and letting the streamer converge over the next ~120 frames means two
   * seconds of flying above a 4 km-cell approximation of the Cascades. Costs
   * about a second of stall at the moment of the jump, which is the right
   * trade for a discontinuity the user asked for.
   *
   * @returns {number} passes taken (each pass descends one LOD level)
   */
  function converge(x, y, z) {
    const prevDeadline = buildDeadline;
    buildDeadline = Infinity;
    let n = 0;
    for (; n <= MAX_LEVEL + 1; n++) {
      selectFrom(x, y, z);
      if (prefetch.length === 0) break;
      drainPrefetch();
    }
    buildDeadline = prevDeadline;
    return n;
  }

  const passes = converge(cfg.originX, cfg.originY, cfg.originZ);
  buildDeadline = 0;
  const tNodes = performance.now();

  if (!demLoaded()) {
    console.warn(
      '[terrain] built with no DEM loaded — the world is flat. ' +
        'Run `npm run bake:dem`.',
    );
  }
  console.info(
    `[terrain] ${nodes.size} nodes (${built.length} built, ${emitted.length} drawn ` +
      `after ${passes} LOD passes), ${lakes ? lakes.kept : 0} lakes | ` +
      `dem ${(tDem - t0) | 0}ms, field ${(tField - tDem) | 0}ms, ` +
      `lakes ${(tLakes - tField) | 0}ms, mesh ${(tNodes - tLakes) | 0}ms`,
  );
  if (built.length > MAX_CACHED_NODES) {
    console.warn(
      `[terrain] working set ${built.length} exceeds MAX_CACHED_NODES ` +
        `${MAX_CACHED_NODES}; the LOD will thrash. Raise the cache or LOD_K.`,
    );
  }

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

    // Drive the DEM pager. The fine elevation layers are far too big to hold
    // resident (elevation.js § PAGING), so they follow the camera: this is the
    // one call that tells them where it is and how fast it is going, and the
    // page-in and decode work is metered inside it. It sits on BOTH the rAF
    // path and the window.sim.tick() path because both go through update().
    //
    // Velocity is differenced here rather than taken from flightModel.state
    // because terrain.js has no business reading aircraft state — and the
    // camera is what the LOD is built around anyway.
    const tNow = performance.now();
    if (_camPrevMs >= 0) {
      const dtMs = Math.min(Math.max(tNow - _camPrevMs, 0.1), 200);
      const inv = 1000 / dtMs;
      setViewer(
        _camPos.x,
        _camPos.z,
        (_camPos.x - _camPrev.x) * inv,
        (_camPos.z - _camPrev.z) * inv,
        dtMs,
      );
    } else {
      setViewer(_camPos.x, _camPos.z, 0, 0, 16.7);
    }
    _camPrev.copy(_camPos);
    _camPrevMs = tNow;

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
      // What the water reflects at a grazing angle is the sky at the horizon,
      // and sky.js publishes exactly that as the fog colour — it is the average
      // of the Preetham dome over the horizon ring, rewritten every time the sun
      // moves. scene.background is NOT it: sky.js deliberately leaves it null
      // (its dome covers every pixel), so reading it left the sea reflecting a
      // hardcoded noon blue at dusk and at night.
      const sky = scene.fog?.color ?? null;
      for (let i = 0; i < waterMats.length; i++) {
        const m = waterMats[i];
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
    landcover?.dispose();
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

    const hasData =
      x0 + size > demRect.xMin &&
      x0 < demRect.xMax &&
      z0 + size > demRect.zMin &&
      z0 < demRect.zMax;

    // A cheap 9x9 probe gives a height range good enough for LOD distance and
    // frustum bounds before the node is ever built. Skipped where there is no
    // DEM: the answer is provably a flat zero and the node is never drawn.
    let lo = 0;
    let hi = 0;
    if (hasData) {
      fillHeightGrid(x0, z0, size / 8, size / 8, 9, 9, _probe);
      lo = Infinity;
      hi = -Infinity;
      for (let i = 0; i < 81; i++) {
        const v = _probe[i];
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
    }

    node = {
      key,
      level,
      ix,
      iz,
      size,
      x0,
      z0,
      hasData,
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
    // Two culls, both cheap and both before anything is built.
    if (!node.hasData) return; // flat sea; the sea plane covers it
    const d = nodeDistance(node, px, py, pz);
    if (d > drawRadius) return;

    if (node.level < MAX_LEVEL && d < lodK * node.size) {
      const kids = ensureChildren(node);
      // A no-data child counts as ready — it is never drawn, so waiting for a
      // geometry it will never own would freeze this whole branch at its
      // coarsest level. That is a hole in the LOD along every coastline.
      if (
        (kids[0].geometry || !kids[0].hasData) &&
        (kids[1].geometry || !kids[1].hasData) &&
        (kids[2].geometry || !kids[2].hasData) &&
        (kids[3].geometry || !kids[3].hasData)
      ) {
        visit(kids[0], px, py, pz);
        visit(kids[1], px, py, pz);
        visit(kids[2], px, py, pz);
        visit(kids[3], px, py, pz);
        return;
      }
      for (let i = 0; i < 4; i++) {
        if (!kids[i].geometry && kids[i].hasData) prefetch.push(kids[i]);
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
    if (built.length <= MAX_CACHED_NODES + EVICT_SLACK) return;
    // Oldest first. Anything drawn this frame is untouchable.
    built.sort(byLastUsed);
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

  return { group, getHeightAt, update, converge, dispose };
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

  // Bounds over the WHOLE sampled block, border ring included. Every value the
  // geomorph can ever produce is either a sample from _hgrid or a mean of two
  // or four of them, so this brackets the morphed surface EXACTLY — no guessed
  // padding. The old `cell * 4` slack inflated a level-1 node's box by 8 km
  // vertically, which is 8 km of terrain the frustum can no longer cull.
  let minY = Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < W * W; i++) {
    const v = _hgrid[i];
    if (v < minY) minY = v;
    if (v > maxY) maxY = v;
  }
  minY *= exag;
  maxY *= exag;

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

  // Set bounds by hand: computeBoundingSphere() would walk 4,481 vertices whose
  // range we already know exactly from the sampled block above.
  const half = node.size * 0.5;
  geo.boundingBox = new THREE.Box3(
    new THREE.Vector3(node.x0, minY - drop, node.z0),
    new THREE.Vector3(node.x0 + node.size, maxY, node.z0 + node.size),
  );
  geo.boundingSphere = new THREE.Sphere(
    new THREE.Vector3(node.x0 + half, (minY + maxY) * 0.5, node.z0 + half),
    Math.sqrt(2 * half * half + Math.pow((maxY - minY) * 0.5 + drop, 2)),
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
function makeTerrainMaterial(lodK, exag, landcover, fieldTexture, rect) {
  const lcRegion = landcover?.region ?? null;
  const lcDetail = landcover?.detail ?? null;
  // A land-cover layer with no texture bound is not a "disabled" uniform, it is
  // a sampler reading unit 0. So presence is a COMPILE-TIME fact: the branches
  // below are generated, not switched, and customProgramCacheKey carries the
  // shape so three cannot hand us a program built for a different one.
  const lcShape = `${lcRegion ? 'r' : ''}${lcDetail ? 'd' : ''}` || 'none';

  const uniforms = {
    uMorphK: { value: lodK },
    uNoiseOrigin: { value: new THREE.Vector2() },
    uExag: { value: exag },
    uField: { value: fieldTexture },
    uFieldRect: {
      value: new THREE.Vector4(
        rect.xMin,
        rect.zMin,
        1 / (rect.xMax - rect.xMin),
        1 / (rect.zMax - rect.zMin),
      ),
    },
  };
  if (lcRegion) {
    uniforms.uLcRegion = { value: lcRegion.texture };
    uniforms.uLcRegionRect = { value: lcRegion.rect };
    uniforms.uLcRegionTexel = { value: lcRegion.texelM };
  }
  if (lcDetail) {
    uniforms.uLcDetail = { value: lcDetail.texture };
    uniforms.uLcDetailRect = { value: lcDetail.rect };
    uniforms.uLcDetailTexel = { value: lcDetail.texelM };
  }
  if (landcover) uniforms.uLcPalette = { value: landcover.palette };

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
        uniform sampler2D uField;
        uniform vec4 uFieldRect;
        ${lcRegion ? 'uniform sampler2D uLcRegion; uniform vec4 uLcRegionRect; uniform vec2 uLcRegionTexel;' : ''}
        ${lcDetail ? 'uniform sampler2D uLcDetail; uniform vec4 uLcDetailRect; uniform vec2 uLcDetailTexel;' : ''}
        ${landcover ? 'uniform sampler2D uLcPalette;' : ''}
        varying vec3 vTerrWorld;
        varying vec3 vTerrNormal;
        varying float vTerrSurfaceY;
        float tRoughOut;
        ${GLSL_NOISE}
        ${landcoverFetchGlsl(lcRegion, lcDetail)}
        `,
      )
      .replace('#include <map_fragment>', terrainColourGlsl(lcRegion, lcDetail))
      .replace(
        '#include <roughnessmap_fragment>',
        'float roughnessFactor = tRoughOut;',
      );
  };

  // Without this three can hand us the program it compiled for some other
  // MeshStandardMaterial with the same defines — the cache key is built from
  // parameters, not from shader source.
  mat.customProgramCacheKey = () => `ken-terrain-surface-${lcShape}`;

  return mat;
}

/**
 * The surface itself: real land cover where we have it, real elevation and
 * slope everywhere, procedural detail on top of both.
 *
 * ---------------------------------------------------------------------------
 * THREE THINGS HERE ARE LOAD-BEARING RATHER THAN DECORATIVE
 * ---------------------------------------------------------------------------
 *
 *  1. LAND COVER DECIDES THE ALBEDO BELOW THE TREELINE. Height and slope cannot
 *     tell downtown Seattle from the Kent Valley farms from Discovery Park —
 *     all three are flat and near sea level — so before geo/landcover.js every
 *     lowland in the region came out the same green. That single fact is what
 *     made the world read as a toy from 600 m. NLCD 2021 at 30 m says which is
 *     which, and this shader paints what it is told.
 *
 *     Above the treeline it is the other way round: land cover at 30 m has
 *     nothing useful to say about a 45-degree rock rib, so slope and elevation
 *     keep the last word up there. The one exception is NLCD's perennial
 *     ice/snow class, which is a survey of where the glaciers actually are and
 *     therefore beats any snowline guess — it is OR-ed into `snowy`.
 *
 *  2. THE HIGH-FREQUENCY LAYERS FADE IN AS THE CAMERA APPROACHES. That is the
 *     whole answer to a photo drape going mushy on short final: a 1 m/px
 *     satellite image has no information left at 50 m AGL, whereas there is
 *     always another octave here and it costs nothing at altitude because it is
 *     switched off there and would only alias anyway. The near-field STRUCTURE
 *     (street grid, field parcels, canopy mottle) is the same idea one level up
 *     — its spacing is taken from the real thing, ~96 x 128 m for a city block
 *     and ~300 m for a valley field, so the frequency the eye reads is right
 *     even though no individual house is.
 *
 *  3. THE CLASS LOOKUP IS JITTERED, NOT FILTERED. An index map cannot be
 *     linearly filtered — halfway between class 6 and class 9 is class 7, which
 *     would draw a texel of barren rock along every urban/forest edge. So the
 *     fetch is nearest, and the SAMPLE POINT is displaced by about one texel of
 *     two-octave noise first. The boundary then follows the noise instead of
 *     the texel grid, which is both cheaper than a four-tap blend and closer to
 *     what a real forest edge looks like from the air.
 *
 * And the snow rule that was already here and still matters: the slope a
 * snowfield tolerates RISES with elevation. A fixed cutoff either strips
 * Rainier bare (its flanks average 30 degrees) or paints vertical rock white.
 *
 * @param {Object|null} lcRegion  present when the region raster loaded
 * @param {Object|null} lcDetail  present when the Seattle inset loaded
 */
/**
 * `tLcFetch(p, seed)` — one jittered nearest sample of the land-cover rasters,
 * returned as the raw texel (r = NLCD code/255, g = index/255, b = road/255).
 *
 * A function rather than inline code because the colour block calls it TWICE
 * with different seeds and blends the two albedos. One tap alone gives a
 * correct but hard-edged mosaic — real class boundaries are gradual, a forest
 * thins into scrub over a hundred metres — and two decorrelated taps produce
 * that gradient for the cost of one extra fetch.
 *
 * The jitter is computed in TEXEL space (`base / texel`), which is what makes
 * it scale-invariant: the same expression gives ~1 texel of wobble on the 81 m
 * region raster and on the 20 m Seattle inset, instead of scrambling one and
 * barely touching the other.
 *
 * With both rasters present the choice between them is DITHERED, not blended:
 * two class indices cannot be averaged into a third meaningful one, so a
 * per-fragment hash decides which side of the ~400 m transition band this pixel
 * takes and the seam dissolves into noise instead of drawing a rectangle around
 * Seattle.
 */
function landcoverFetchGlsl(lcRegion, lcDetail) {
  if (!lcRegion && !lcDetail) return '';

  const jitter = /* glsl */ `
    vec2 tp = base / texel + seed;
    vec2 jit = vec2(tNoise(tp * 0.34) - 0.5, tNoise(tp * 0.34 + vec2(31.7, 12.9)) - 0.5) * 2.2
             + vec2(tNoise(tp * 1.30) - 0.5, tNoise(tp * 1.30 + vec2(5.3, 47.1)) - 0.5) * 0.9;
    vec2 p = base + jit * texel;
  `;

  if (lcRegion && lcDetail) {
    return /* glsl */ `
      vec3 tLcFetch(vec2 base, float seed) {
        vec2 dUv = (base - uLcDetailRect.xy) * uLcDetailRect.zw;
        float edge = min(min(dUv.x, dUv.y), min(1.0 - dUv.x, 1.0 - dUv.y));
        float useD = step(tHash21(floor(base * 0.5)) * 0.012, edge);
        vec2 texel = mix(uLcRegionTexel, uLcDetailTexel, useD);
        ${jitter}
        return mix(
          texture2D(uLcRegion, clamp((p - uLcRegionRect.xy) * uLcRegionRect.zw, 0.0, 1.0)).rgb,
          texture2D(uLcDetail, clamp((p - uLcDetailRect.xy) * uLcDetailRect.zw, 0.0, 1.0)).rgb,
          useD);
      }
    `;
  }

  const T = lcRegion ? 'uLcRegion' : 'uLcDetail';
  return /* glsl */ `
    vec3 tLcFetch(vec2 base, float seed) {
      vec2 texel = ${T}Texel;
      ${jitter}
      return texture2D(${T}, clamp((p - ${T}Rect.xy) * ${T}Rect.zw, 0.0, 1.0)).rgb;
    }
  `;
}

function terrainColourGlsl(lcRegion, lcDetail) {
  const hasLc = !!(lcRegion || lcDetail);
  // Outside the covering raster there is no data, whatever the clamp returns.
  const coverRect = lcRegion ? 'uLcRegionRect' : 'uLcDetailRect';

  const landcoverBlock = !hasLc
    ? ''
    : /* glsl */ `
  // =======================================================================
  // Land cover — NLCD 2021, 30 m, baked by scripts/bake-landcover.mjs
  // =======================================================================
  vec3 lcRaw = tLcFetch(wp, 0.0);
  vec3 lcRawB = tLcFetch(wp, 61.7);
  vec2 lcCoverUv = (wp - ${coverRect}.xy) * ${coverRect}.zw;
  float lcInside = step(0.0, min(min(lcCoverUv.x, lcCoverUv.y),
                                 min(1.0 - lcCoverUv.x, 1.0 - lcCoverUv.y)));

  float lcIdx  = floor(lcRaw.g * 255.0 + 0.5);
  float lcRoad = lcRaw.b;
  // Index 0 is nodata: open ocean and anything outside the CONUS raster.
  float lcOn = lcInside * step(0.5, lcIdx);

  float lcU = (lcIdx + 0.5) * (1.0 / 16.0);
  vec3 lcAlbedo = tSrgb(texture2D(uLcPalette, vec2(lcU, 0.25)).rgb);
  vec4 lcParam  = texture2D(uLcPalette, vec2(lcU, 0.75));
  float lcRough  = lcParam.r;
  float lcAmt    = lcParam.g;
  float lcForm   = lcParam.b * 2.0;   // 0 organic, 1 parcel, 2 street
  float lcCanopy = lcParam.a;         // how much of a developed class is trees

  float lcIsWater = step(0.5, lcIdx) * (1.0 - step(1.5, lcIdx));
  float lcIsIce   = step(1.5, lcIdx) * (1.0 - step(2.5, lcIdx));
  float lcIsDev   = step(2.5, lcIdx) * (1.0 - step(6.5, lcIdx));
  float lcIsTree  = step(7.5, lcIdx) * (1.0 - step(10.5, lcIdx));

  // --- near-field structure ----------------------------------------------
  // All three patterns are built from wp, not lp: lp is quantised to 32 m and
  // a grid evaluated against it would jump a third of a block every time the
  // camera crossed a quantum. Only the noise octaves may use lp (see
  // GLSL_NOISE), and the canopy octaves below use frequencies that divide 32
  // exactly for that reason.
  float lcAng = (tNoise(wp * (1.0 / 6000.0)) - 0.5) * 0.5;
  float lcCa = cos(lcAng), lcSa = sin(lcAng);
  vec2 rp = vec2(lcCa * wp.x - lcSa * wp.y, lcSa * wp.x + lcCa * wp.y);

  // Street grid. A Seattle block is roughly 73 x 98 m of lots inside a 96 x
  // 128 m street-centre pitch, which is what these numbers are.
  float fadeBlock = 1.0 - smoothstep(2200.0, 7000.0, camDist);
  vec2 bc = rp * vec2(1.0 / 96.0, 1.0 / 128.0);
  vec2 bf = abs(fract(bc) - 0.5);
  float street = smoothstep(0.452, 0.492, max(bf.x, bf.y)) * fadeBlock;
  float blockId = tHash21(floor(bc) + 0.13);
  vec2 lc2 = rp * vec2(1.0 / 24.0, 1.0 / 26.0);
  float lotId = tHash21(floor(lc2) + 3.1);
  float fadeLot = 1.0 - smoothstep(600.0, 2000.0, camDist);
  // Lot boundaries: fences, driveways, the gap between two roofs. Only inside
  // 250 m, where they are several pixels across and are the thing that keeps
  // the ground from going smooth as you descend.
  // Masked per cell, so only some boundaries draw. An unmasked lattice reads
  // as a tiled floor — the regularity is the tell, not the spacing.
  vec2 lf = abs(fract(lc2) - 0.5);
  float lotEdge = smoothstep(0.42, 0.495, max(lf.x, lf.y))
                * step(0.42, tHash21(floor(lc2) * 2.7 + 11.3))
                * (1.0 - smoothstep(150.0, 500.0, camDist));
  // Block-scale variation is deliberately weak and lot-scale strong: the other
  // way round turns a city into a chessboard of 96 m squares, which is exactly
  // what the eye picks out as procedural.
  float urbanV = ((blockId - 0.5) * 0.14 + (lotId - 0.5) * 0.52 * fadeLot
                  - lotEdge * 0.14) * fadeBlock;

  // Field parcels. Kent/Snoqualmie valley fields run 250-400 m on a side.
  vec2 fc = rp * vec2(1.0 / 300.0, 1.0 / 380.0);
  float fieldId = tHash21(floor(fc) + 1.7);
  float fieldEdge = smoothstep(0.455, 0.497, max(abs(fract(fc.x) - 0.5), abs(fract(fc.y) - 0.5)));
  float fadeRow = 1.0 - smoothstep(250.0, 900.0, camDist);
  float rowPhase = mix(rp.x, rp.y, step(0.5, fieldId)) * (1.0 / 7.5);
  float rows = abs(fract(rowPhase) - 0.5) * 2.0;
  float parcelV = (fieldId - 0.5) * 0.62 + (rows - 0.5) * 0.34 * fadeRow - fieldEdge * 0.16;

  // Canopy. 1/16 and 1/4 divide the 32 m noise quantum exactly.
  float standId = tNoise(wp * (1.0 / 220.0));
  float fadeCanopy = 1.0 - smoothstep(350.0, 1800.0, camDist);
  float canopy = tNoise(lp * (1.0 / 16.0)) * 0.6 + tNoise(lp * 0.25) * 0.4;
  float organicV = (standId - 0.5) * 0.55 + (canopy - 0.5) * 0.9 * fadeCanopy;

  float wStreet  = smoothstep(1.25, 1.75, lcForm);
  float wParcel  = smoothstep(0.25, 0.75, lcForm) * (1.0 - wStreet);
  float wOrganic = 1.0 - smoothstep(0.25, 0.75, lcForm);

  float lcVar = (wOrganic * organicV + wParcel * parcelV + wStreet * urbanV) * lcAmt;

  // The second tap only softens the ALBEDO. Structure, roughness and the
  // canopy fraction all follow tap A, so a boundary blends in colour without
  // half-drawing two different street grids on top of each other.
  float lcU2 = (floor(lcRawB.g * 255.0 + 0.5) + 0.5) * (1.0 / 16.0);
  vec3 lcAlbedoB = tSrgb(texture2D(uLcPalette, vec2(lcU2, 0.25)).rgb);
  vec3 lcBase = mix(lcAlbedo, lcAlbedoB, 0.34);

  // grain carries the octaves that only exist near the camera (32 m, 8 m and
  // 4 m). Weighting it this hard is the point of the whole file: below ~500 m
  // this is the term that keeps producing new detail, where a 1 m/px photo
  // drape has already run out of source.
  vec3 lcCol = lcBase * (1.0 + lcVar * 0.58 + grain * 0.60 * lcAmt);
  // Stand-age hue drift: some conifer stands read yellow-brown, and a forest
  // that is one flat hue is the other half of why procedural ground looks fake.
  lcCol *= mix(vec3(1.0), vec3(1.09, 1.0, 0.84),
               wOrganic * lcIsTree * clamp((standId - 0.52) * 2.0, 0.0, 1.0) * 0.55);

  // Street trees and back gardens. Without this, everything NLCD calls
  // developed comes out pavement-coloured, and Wallingford from 300 m looks
  // like a car park instead of the tree canopy with roofs in it that it is.
  vec3 cUrbanTree = tSrgb(vec3(0.145, 0.215, 0.125));
  float treeFrac = lcCanopy * smoothstep(0.30, 0.82, canopy * 0.5 + lotId * 0.5) * (1.0 - street * 0.8);
  lcCol = mix(lcCol, cUrbanTree * (0.85 + 0.35 * standId), treeFrac);

  vec3 asphalt = tSrgb(vec3(0.118, 0.118, 0.124));
  lcCol = mix(lcCol, asphalt * (0.95 + 0.6 * blockId), wStreet * street * 0.38);

  // Real centrelines: TIGER/Line primary (Interstates, 255) and secondary
  // (US and state highways, 160). The mask is one texel wide by construction —
  // 20 m on the Seattle inset, which is about a carriageway — so it is
  // darkened rather than drawn as a hairline that would alias into dashes.
  float road = smoothstep(0.25, 0.80, lcRoad);
  lcCol = mix(lcCol, asphalt * 1.5, road * 0.55);

  col = mix(col, lcCol, lcOn);
  `;

  const lcOverrides = !hasLc
    ? ''
    : /* glsl */ `
  // A wooded bluff and a city hillside are steep but not bare, and the survey
  // knows they are wooded; only trust the slope test where nothing is growing.
  rocky *= 1.0 - lcOn * (lcIsDev + lcIsTree) * 0.75;
  rocky *= 1.0 - lcOn * lcIsWater;
  `;

  const lcSnow = !hasLc
    ? ''
    : /* glsl */ `
  // NLCD's perennial ice/snow class is a survey of where the glaciers are, so
  // it beats the snowline estimate; and nothing is ever snow on open water.
  snowy = max(snowy, lcOn * lcIsIce);
  snowy *= 1.0 - lcOn * lcIsWater;
  `;

  const lcRough = !hasLc
    ? 'tRoughOut = 0.95;'
    : 'tRoughOut = mix(0.95, lcRough, lcOn);';

  const lcFinalTint = !hasLc
    ? 'col *= 0.90 + 0.20 * nMacro + grain * 0.10;'
    : // With real classes doing the work, the old macro wash only muddies them.
      'col *= mix(0.90 + 0.20 * nMacro + grain * 0.10, 0.955 + 0.09 * nMacro + grain * 0.06, lcOn);';

  return /* glsl */ `
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

  // Metres to the nearest land: 0 on land, > 0 over water. Same RG field the
  // sea shader reads, and the only thing on the terrain side that knows the
  // difference between a beach and the bed of Elliott Bay.
  float tShore = texture2D(uField, clamp((wp - uFieldRect.xy) * uFieldRect.zw, 0.0, 1.0)).g;

  // THE SEABED IN OPEN WATER IS NOT DRAWN AT ALL, and this is the fix for the
  // hard-edged patches that used to sit in the middle of Elliott Bay.
  //
  // They were never a colour bug. §1.4 accepts that the drawn mesh is a
  // DISCRETISATION of the elevation field and can deviate from it between
  // vertices; measured here by raycast, coarse nodes over the Sound draw the
  // bed at +2.4 to +6.8 m where the field says -1.2 to +0.9. The sea plane sits
  // at +0.25, so those bulges came through it — as tan when the bed was painted
  // sand, as dark once it was painted seabed. Raising the sea plane to clear
  // them would flood every beach in the region by six metres, and clamping the
  // vertices does nothing because the error is BETWEEN them.
  //
  // So the bulges are discarded instead. Only well offshore (the field's
  // metres-to-land, so a beach, a pier and a shoal are all untouched) and only
  // below 12 m, so an island the 165 m field missed still draws. What is behind
  // is the sea plane, which is opaque out there by construction — see
  // WATER_COLOUR_GLSL. getHeightAt is not involved and does not change.
  if (tShore > 180.0 && h < 12.0) discard;

  vec3 cSeabed  = tSrgb(vec3(0.075, 0.115, 0.140));
  vec3 cSilt    = tSrgb(vec3(0.20, 0.23, 0.22));
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

  // A BEACH IS A NARROW STRIP, and this is where the tan patches in the middle
  // of Elliott Bay came from. Terrarium reads a flat exact zero right across
  // the main basin, so an elevation test alone paints the whole bed the colour
  // of sand — and the water above it is not fully opaque, so it showed through
  // as hard-edged khaki blobs sitting in open water. Gate it on distance to
  // land instead: sand within a couple of hundred metres of a coast, seabed
  // beyond it. Land texels have tShore == 0 and are unaffected.
  // The band that is still DRAWN under water is only 0..180 m wide (past that
  // it is discarded below), so the beach ramp stays sandy across the whole of
  // it. Ramping to seabed inside the visible strip drew a dark outline around
  // every coastline.
  float beach = 1.0 - smoothstep(130.0, 330.0, tShore);
  col = mix(col, cSand, smoothstep(-2.5, 0.9, h) * beach);
  col = mix(col, cSeabed, (1.0 - beach) * (1.0 - smoothstep(0.9, 6.0, h)));

  // Puget Sound is temperate rainforest: the lowland green is dark and
  // desaturated, not meadow green, and it goes darker with altitude.
  vec3 forest = mix(cForestD, cForestL, clamp(nPatch * 0.8 + nMeso * 0.4 + grain, 0.0, 1.0));
  col = mix(col, cLowland, smoothstep(0.8, 7.0, h) * beach);
  col = mix(col, forest, smoothstep(15.0, 130.0, h) * (0.62 + 0.38 * nMacro));
  col = mix(col, cForestD, smoothstep(200.0, 700.0, h) * 0.55);

  float treeline = 1620.0 + (nMeso - 0.5) * 300.0 + (nPatch - 0.5) * 90.0;
  col = mix(col, cSubalp, smoothstep(treeline - 320.0, treeline + 140.0, h));
${landcoverBlock}
  // --- slope: bare rock wherever the ground is too steep to hold anything -
  vec3 rock = mix(cRockD, cRockL, clamp(nMeso * 0.7 + nPatch * 0.4 + grain * 1.2, 0.0, 1.0));
  float rocky = smoothstep(0.62, 1.10, slope + grain * 0.30);
  rocky *= smoothstep(0.4, 5.0, h);
${lcOverrides}
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
${lcSnow}
  vec3 snowCol = mix(cSnow, cIce, smoothstep(2500.0, 3700.0, h) * 0.6);
  snowCol *= 0.93 + grain * 0.14;
  snowy = clamp(snowy, 0.0, 1.0);
  col = mix(col, snowCol, snowy);

  ${lcFinalTint}

  ${lcRough}
  tRoughOut = mix(tRoughOut, 0.58, snowy);
  tRoughOut = mix(tRoughOut, 0.86, rocky * 0.7);

  diffuseColor.rgb *= col;
}
`;
}

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

  // Grazing-angle sky reflection. Taken from a normal that is MOSTLY flat but
  // carries part of the wave slope: from the flat normal alone the reflection
  // is a single uniform value across the whole basin, which is what made the
  // Sound read as a sheet of milk rather than as water. Damping the wave
  // contribution to 45% keeps the swell visible in the reflection without the
  // per-pixel flicker that the full normal produces at range.
  vec3 toEye = normalize(cameraPosition - vWaterWorld);
  vec3 fresNormal = normalize(mix(vec3(0.0, 1.0, 0.0), wWaveNormal, 0.45));
  float f = pow(1.0 - clamp(dot(toEye, fresNormal), 0.0, 1.0), 5.0);
  wFresnelOut = clamp(0.02 + 0.98 * f, 0.0, 1.0) * 0.75;

  // Surf. The shore field is ~165 m per texel, so the band is broad by
  // construction; heavy noise modulation keeps it from reading as a contour.
  float surf = 1.0 - smoothstep(15.0, 150.0, shore);
  float churn = tNoise(lp * (1.0 / 24.0) + vec2(uTime * 0.05, uTime * 0.03));
  churn = churn * 0.6 + tNoise(lp * (1.0 / 6.0) - vec2(uTime * 0.11, 0.0)) * 0.4;
  wFoamOut = surf * smoothstep(0.44, 0.80, churn) * (1.0 - uLake * 0.65);
  base = mix(base, vec3(0.85), wFoamOut * 0.75);

  diffuseColor.rgb = base;
  // Shallow water is see-through; open water is not. Grazing angles close it up.
  float clarity = 1.0 - smoothstep(0.0, 3.5, depth);
  float a = clamp(mix(0.94, 0.55, clarity * (1.0 - deepness)) + f * 0.35 + wFoamOut * 0.4, 0.0, 1.0);
  // Beyond a few hundred metres from land the Sound is flatly opaque — it is
  // glacial-silt saltwater, you cannot see the bed through it from the air, and
  // this is also what makes it safe for the terrain shader to discard the
  // seabed out there rather than fight the sea plane for the depth buffer.
  diffuseColor.a = mix(a, 1.0, smoothstep(180.0, 520.0, shore));
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

/**
 * The DEM's coverage in local metres, grown by `marginM`. Nodes wholly outside
 * it are provably flat sea — every layer misses and getElevation() returns
 * SEA_LEVEL_M — so they are not built and not drawn.
 */
function computeDemRect(bbox, marginM) {
  const nw = llToLocal(bbox.north, bbox.west);
  const se = llToLocal(bbox.south, bbox.east);
  return {
    xMin: Math.min(nw.x, se.x) - marginM,
    xMax: Math.max(nw.x, se.x) + marginM,
    zMin: Math.min(nw.z, se.z) - marginM,
    zMax: Math.max(nw.z, se.z) + marginM,
  };
}

/**
 * Heights, a water mask and (later) distance to shore, over the whole region.
 *
 * THE WATER MASK IS NOT PURELY AN ELEVATION TEST, and that is the important
 * part. Terrarium's bed under Puget Sound is nominally a flat exact zero, but
 * void repair and source noise leave broad patches reading +1 to +5 m —
 * measured by raycast at up to +6.8 m of drawn surface in the middle of Elliott
 * Bay. `height <= 0.5` therefore scattered phantom islands across open water,
 * and everything downstream inherited them: shore distance collapsed to nearly
 * zero around each one, so the deep-water gradient painted rings of pale
 * shallows in mid-channel, the beach band painted them sand, and the seabed
 * discard in the surface shader could not fire. That is the whole family of
 * "hard-edged patches sitting in Elliott Bay".
 *
 * NLCD's open-water class is a survey of where the water is and has no such
 * holes, so it is OR-ed in wherever the raster covers. The elevation test stays
 * as the fallback: outside the raster (open ocean west of the region, British
 * Columbia) it is all we have.
 */
function buildRegionField(rect, seaLevelM, landcover) {
  const n = FIELD_N;
  const dx = (rect.xMax - rect.xMin) / (n - 1);
  const dz = (rect.zMax - rect.zMin) / (n - 1);
  const height = fillHeightGrid(rect.xMin, rect.zMin, dx, dz, n, n);
  const water = new Uint8Array(n * n);
  const surveyed = landcover?.isOpenWaterLocal ?? null;
  let fromSurvey = 0;
  for (let j = 0; j < n; j++) {
    const z = rect.zMin + j * dz;
    for (let i = 0; i < n; i++) {
      const k = j * n + i;
      const byHeight = height[k] <= seaLevelM + WATER_LEVEL_M;
      let w = byHeight;
      if (!w && surveyed && surveyed(rect.xMin + i * dx, z)) {
        w = true;
        fromSurvey++;
      }
      water[k] = w ? 1 : 0;
    }
  }
  if (fromSurvey > 0) {
    console.info(
      `[terrain] water mask: ${fromSurvey} of ${n * n} cells are water in the ` +
        'land-cover survey but above sea level in the DEM (Terrarium void repair)',
    );
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
  // Dilation scratch. `stampArr` is stamped with the component id rather than
  // cleared, so the rim BFS costs nothing per component beyond the cells it
  // actually touches.
  const stampArr = new Int32Array(nx * nz);
  const ring = new Int32Array(nx * nz);
  let stamp = 0;
  const cellArea = cell * cell;
  let kept = 0;
  let cells = 0;
  const found = [];

  for (let start = 0; start < nx * nz; start++) {
    if (!flat[start] || seen[start]) continue;
    stamp++;
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
    //
    // The rim is taken LAKE_RIM_DILATE cells out, not from the touching ring —
    // see the note above LAKE_BOX. Measuring it at the touching ring is a test
    // no lake on earth can pass.
    let head = 0;
    let tail = 0;
    for (let m = 0; m < cp; m++) {
      const k = comp[m];
      stampArr[k] = stamp;
      ring[tail++] = k;
    }
    let levelEnd = tail;
    let rim = 0;
    let rimSum = 0;
    let rimAbove = 0;
    let rimBelow = 0;
    for (let step = 0; step < LAKE_RIM_DILATE && head < tail; step++) {
      const end = levelEnd;
      while (head < end) {
        const k = ring[head++];
        const i = k % nx;
        const j = (k / nx) | 0;
        for (let o = 0; o < 4; o++) {
          const ii = i + (o === 0 ? -1 : o === 1 ? 1 : 0);
          const jj = j + (o === 2 ? -1 : o === 3 ? 1 : 0);
          if (ii < 0 || ii >= nx || jj < 0 || jj >= nz) continue;
          const kk = jj * nx + ii;
          if (stampArr[kk] === stamp) continue;
          stampArr[kk] = stamp;
          ring[tail++] = kk;
          rim++;
          rimSum += h[kk];
          if (h[kk] > surface + 0.5) rimAbove++;
          if (h[kk] < surface - 1.0) rimBelow++;
        }
      }
      levelEnd = tail;
    }
    if (rim < 8) continue;
    if (rimSum / rim < surface + LAKE_RIM_RISE_M) continue;
    if (rimAbove / rim < LAKE_RIM_ABOVE_FRAC) continue;
    // Somewhere lower to drain to within 384 m means it is a tideflat or a
    // delta, not a basin.
    if (rimBelow / rim > LAKE_RIM_BELOW_FRAC) continue;

    for (let m = 0; m < cp; m++) {
      mask[comp[m]] = 1;
      level[comp[m]] = surface;
    }

    // Grow back over the one-cell band the flatness test ate, onto cells that
    // are themselves at the lake's surface height.
    let grown = 0;
    for (let m = 0; m < cp; m++) {
      const k = comp[m];
      const i = k % nx;
      const j = (k / nx) | 0;
      for (let o = 0; o < 4; o++) {
        const ii = i + (o === 0 ? -1 : o === 1 ? 1 : 0);
        const jj = j + (o === 2 ? -1 : o === 3 ? 1 : 0);
        if (ii < 0 || ii >= nx || jj < 0 || jj >= nz) continue;
        const kk = jj * nx + ii;
        if (mask[kk]) continue;
        if (Math.abs(h[kk] - surface) > LAKE_EDGE_TOLERANCE_M) continue;
        mask[kk] = 1;
        level[kk] = surface;
        grown++;
      }
    }
    kept++;
    found.push({ areaKm2: (area + grown * cellArea) / 1e6, surfaceM: surface });
  }

  // Counted from the mask, not accumulated: components can overlap the band an
  // earlier lake grew into, and buildLakeGeometry sizes its buffers from this.
  // An over-count leaves degenerate triangles at the world origin.
  for (let i = 0; i < nx * nz; i++) if (mask[i]) cells++;

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
