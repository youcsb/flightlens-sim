/**
 * device.js — what kind of machine is this, and what may it spend?
 *
 * This module is the FOUNDATION for the mobile round. It answers two questions
 * and nothing else:
 *
 *   1. What tier is this device?   'phone' | 'tablet' | 'desktop'
 *   2. What is that tier's budget? BUDGETS[tier], every number justified below.
 *
 * It has NO imports, touches no DOM at module scope, and knows nothing about
 * three.js — so `scripts/check-device.mjs` runs the shipping classifier in Node
 * against synthetic signal sets. Keep it that way.
 *
 * ---------------------------------------------------------------------------
 * WHY THE USER-AGENT STRING IS NOT CONSULTED
 * ---------------------------------------------------------------------------
 * `readSignals()` records a UA hint because it is useful in a bug report, and
 * `classifyTier()` never reads it. Two reasons, and both of them have bitten
 * this project already:
 *
 *  - The browser-pane harness's `mobile` preset sets an Android user-agent on a
 *    desktop GPU. A UA check would call that a phone AND hand it a desktop GL
 *    probe, so every measurement taken through it would be a lie in one
 *    direction or the other. Capability signals describe the preset correctly:
 *    coarse pointer, no hover, 375 CSS px short edge — a phone, and we should
 *    render it as one.
 *  - iPadOS 13+ ships a *desktop* Safari UA by default. Every UA-based check in
 *    the wild classifies a 12.9" iPad as a Mac, which is exactly backwards for
 *    a touch-input round: the one thing the UA is definitely wrong about is
 *    whether there is a keyboard.
 *
 * `scripts/check-device.mjs` asserts that flipping the UA hint alone, with every
 * capability signal held fixed, changes no tier.
 *
 * ---------------------------------------------------------------------------
 * THE TIER RULES
 * ---------------------------------------------------------------------------
 * Input class first, size second. Size alone cannot tell a 13" touchscreen
 * laptop from a 13" tablet, and input class alone cannot tell a phone from a
 * tablet.
 *
 *   touchPrimary  =  maxTouchPoints >= 1
 *                 && matchMedia('(pointer: coarse)')            // PRIMARY pointer
 *                 && NOT ( matchMedia('(any-pointer: fine)')
 *                          && matchMedia('(hover: hover)') )    // a mouse exists
 *
 *   not touchPrimary                    -> 'desktop'
 *   touchPrimary && shortEdge <  600    -> 'phone'
 *   touchPrimary && shortEdge >= 600    -> 'tablet'
 *
 * plus one hard floor that runs BEFORE the mouse guard:
 *
 *   maxTouchPoints >= 1 && any-pointer: coarse && shortEdge < 600  ->  'phone'
 *
 * which is what keeps a phone with a Bluetooth mouse paired from being handed a
 * desktop budget and killed by iOS Safari. iOS really does switch the primary
 * pointer to fine and turn `hover: hover` on when a mouse is connected, so the
 * mouse guard alone would misclassify it. No desktop display is under 600 CSS
 * px on its short edge, so the floor cannot misfire the other way.
 *
 * `shortEdge` is `min(screen.width, screen.height)` — the DEVICE's short edge,
 * not the window's, so rotating the phone or opening a narrow browser window on
 * a desktop changes nothing. 600 is Android's own `sw600dp` tablet breakpoint
 * and it splits the real fleet cleanly: iPhone 15 Pro Max is 430, the largest
 * phones in circulation are ~480, iPad mini is 744, iPad Pro 11" is 834.
 *
 * ---------------------------------------------------------------------------
 * DERATING — TIER IS WHAT IT IS, BUDGET IS WHAT IT CAN AFFORD
 * ---------------------------------------------------------------------------
 * `classifyTier()` reports the honest device class. `budgetTierFor()` may hand
 * that device a SMALLER tier's budget when the capability probe says the class
 * average is optimistic: `deviceMemory <= 2`, `MAX_TEXTURE_SIZE < 8192`, no
 * usable float textures, or no WebGL context at all. A 2019 budget Android
 * tablet and an iPad Pro are both 'tablet' and only one of them should be
 * drawing 900k triangles. Derating is one step, never two, and never upward.
 */

// ---------------------------------------------------------------------------
// Tier names
// ---------------------------------------------------------------------------

export const TIER_PHONE = 'phone';
export const TIER_TABLET = 'tablet';
export const TIER_DESKTOP = 'desktop';

/** Ordered smallest budget first. Derating walks this array leftward. */
export const TIERS = [TIER_PHONE, TIER_TABLET, TIER_DESKTOP];

/**
 * Phone/tablet split, in CSS pixels on the DEVICE's short edge.
 *
 * Android's `sw600dp` qualifier, which is the breakpoint the whole Android
 * ecosystem already lays out against. Measured against the fleet: iPhone 15 Pro
 * 393, 15 Pro Max 430, Galaxy S24 Ultra 480, Pixel Fold unfolded 601 (a tablet,
 * correctly), iPad mini 744, iPad Pro 11" 834, iPad Pro 12.9" 1024.
 */
export const PHONE_MAX_SHORT_EDGE_CSS_PX = 600;

// ===========================================================================
// THE PHONE BUDGET
//
// Every constant below is a number some other module has to hit. The desktop
// figure it is cut from is quoted so a future round can see what was traded.
// Desktop baseline, measured on this machine at the default view:
//
//   JS heap               352.8 MB      draw calls              432
//   triangles drawn       1,836,118     shader programs         65
//   terrain built         6,858,752 tri / 788 nodes
//   DEM resident          73.6 MB of a 96 MB cap
//   buildings             23,979 footprints / 625k tri / 29.8 MiB
//   devicePixelRatio      1
// ===========================================================================

/**
 * TOTAL JS HEAP TARGET — 160 MB, against a desktop baseline of 352.8 MB.
 *
 * THIS IS THE NUMBER THE WHOLE ROUND EXISTS FOR. iOS Safari terminates a tab
 * somewhere in the 200–400 MB range and that ceiling counts EVERYTHING: the JS
 * heap, the GPU allocations WebGL made on its behalf, textures, the DOM. So the
 * survivable design point is the BOTTOM of that band, 200 MB total, minus a
 * reserve for what the JS heap counter cannot see.
 *
 *   200 MB tab ceiling
 *  -  40 MB GPU/texture/DOM reserve (shadow maps off, but the sky dome, the
 *          PMREM env map, the land-cover rasters and every VBO still live there)
 *  = 160 MB of JS heap
 *
 * The 352.8 → 160 cut is affordable because the baseline is dominated by three
 * caches this budget shrinks directly, not by anything structural:
 *
 *   terrain LOD node cache   ~199 MB  ->  ~32 MB   (terrainLodQuality 0.40)
 *   DEM resident              73.6 MB ->  47.75 MB (demCapBytes 48 MiB)
 *   building buffers          29.8 MB ->  ~12.8 MB (minor tier not built)
 *   everything else           ~50 MB  ->  ~50 MB   (code, three, textures)
 *   ------------------------------------------------------------------
 *                            352.8 MB      ~143 MB
 *
 * which lands 17 MB under target. That headroom is deliberate: it is what the
 * touch-input agent's DOM, the audio graph and a GC that has not run yet get to
 * spend without the number going red.
 */
export const PHONE_HEAP_TARGET_MB = 160;

/**
 * The line a measurement must not cross. 190 MB is 5% under the bottom of the
 * observed iOS kill band with the GPU reserve already counted; past it the tab
 * is not "slow", it is reloaded mid-flight, which is the one failure a flight
 * sim cannot render its way out of.
 */
export const PHONE_HEAP_HARD_MB = 190;

/**
 * DEM RESIDENT CAP — 48 MiB, against 96 MiB on desktop (73.6 MB measured).
 *
 * The cap is not a free parameter, because `elevation.js` pins the z=11 base
 * layer and §2.4 rule 2 forbids ever evicting it — a miss must fall to a
 * COARSER layer, never to zero, or a 0 m return over the Cascades becomes a 2 km
 * cliff the flight model correctly destroys the aeroplane on.
 *
 * TILE_BYTES = 256 * 256 * 2 = 128 KiB (Int16 quarter-metres, §2.4).
 *
 *   z=11  238 tiles  PINNED, whole region  29.75 MiB   <- immovable floor
 *   z=13   96 tiles  paged, 18 km radius   12.00 MiB
 *   z=14   48 tiles  paged,  6 km radius    6.00 MiB
 *   ------------------------------------------------
 *          382 tiles                       47.75 MiB   <= 48 MiB cap
 *
 * Anything below ~34 MiB is unreachable without unpinning the base, which is
 * not a tuning decision — it is the contract. So the saving comes out of the two
 * paged layers, and the radii are re-derived rather than guessed: a z=13 tile is
 * 256 * 12.95 = 3,315 m square, so an 18 km disc is 92.6 tiles against a 96-tile
 * budget; a z=14 tile is 1,656 m, so a 6 km disc is 41.3 against 48. Both
 * budgets still exceed their own disc, which is the property the pager's lead
 * stadium depends on.
 *
 * What 18 km costs: the fine layer stops following the aircraft two thirds as
 * far ahead. At 100 kt that is still 5.8 minutes of lead, and `warmAt()` covers
 * teleports.
 */
export const PHONE_DEM_CAP_BYTES = 48 * 1024 * 1024;

/**
 * The paging policy that fits inside `PHONE_DEM_CAP_BYTES`. Same shape as
 * `PAGING_POLICY` in `elevation.js`: keyed by zoom, radius in metres, budget in
 * whole tiles. z=11 is pinned and carries no policy entry on any tier.
 */
export const PHONE_DEM_PAGING_POLICY = Object.freeze({
  13: Object.freeze({ radiusM: 18000, budgetTiles: 96 }),
  14: Object.freeze({ radiusM: 6000, budgetTiles: 48 }),
});

/**
 * TRIANGLES DRAWN PER FRAME — 460,000, against 1,836,118 on desktop.
 *
 * Derived from the frame budget, not from a fraction of the desktop number. The
 * phone targets 30 fps, so 33.3 ms. A mobile tile GPU running this vertex
 * shader — CDLOD morph, logarithmic depth write, per-vertex Int16 normals — is
 * worth budgeting at ~45 M vertices/s of real throughput, which puts 460k
 * triangles at ~10.2 ms, about 31% of the frame. The rest goes to fill, the sky
 * dome and the driver.
 *
 * Terrain reaches its share through `terrainLodQuality` alone. `TRIS_PER_NODE`
 * is 8,704, node count scales as `lodQuality^2` (the subdivision distance is
 * linear in it and the area it covers is quadratic), and 0.40 was chosen to
 * land on ~300k. It does: MEASURED at the phone tier, parked at KBFI in a
 * 375 x 812 viewport, terrain drew 330,284 triangles in 37 calls.
 *
 * See PHONE_SHARES for where the other 130k goes and who has to cut it.
 */
export const PHONE_MAX_TRIANGLES = 460000;

/**
 * DRAW CALLS PER FRAME — 120, against 432 on desktop.
 *
 * On mobile Safari every WebGL call crosses a translation layer into Metal, and
 * the cost is CPU-side and per-call rather than per-triangle. Budgeting 60 µs
 * per call, 120 calls is 7.2 ms — 22% of a 33 ms frame. The desktop's 432 would
 * be 26 ms of driver time before a single pixel is shaded, which is the entire
 * frame.
 *
 * This budget is also the reason shadows are off (below): shadows cost draw
 * calls, not fill. That is measured, not assumed — `shadows.js` records that
 * shrinking every cascade map from 2048 to 256 changed the frame time by
 * nothing at all, while four cascades add ~820 calls.
 */
export const PHONE_MAX_DRAW_CALLS = 120;

/**
 * WHERE THE FRAME GOES — a per-subsystem allocation, not just a global ceiling.
 *
 * A single number nobody owns is a number nobody cuts. This is the measured
 * decomposition with the phone tier applied and a target beside it, so each
 * agent knows its own share rather than the sim's.
 *
 * MEASURED: phone tier, parked at KBFI 32L, 375 x 812, by hiding one scene
 * group at a time and differencing `renderer.info.render`:
 *
 *   group        measured tri / calls    budget tri / calls   how it is closed
 *   terrain        330,284 /  37           300,000 / 40       DONE — lodQuality 0.40
 *   landmarks       98,126 /  84            90,000 / 40       drop the minor building
 *                                                             tier, 8 km major cutoff
 *   airports        45,578 /  10            40,000 / 10       already inside
 *   aircraft        27,827 /  29            28,000 / 20       merge airframe materials
 *   sky                976 /   9             2,000 / 10       already inside
 *   ----------------------------------------------------------
 *   total          502,791 / 169           460,000 / 120
 *
 * The whole draw-call overage is in two places and neither of them is terrain:
 * `landmarks` at 84 calls is 70% of the entire budget, spent on a city LOD that
 * is not tier-aware yet, and the aeroplane costs 29 calls for one object.
 */
export const PHONE_SHARES = Object.freeze({
  terrain: Object.freeze({ triangles: 300000, drawCalls: 40 }),
  landmarks: Object.freeze({ triangles: 90000, drawCalls: 40 }),
  airports: Object.freeze({ triangles: 40000, drawCalls: 10 }),
  aircraft: Object.freeze({ triangles: 28000, drawCalls: 20 }),
  sky: Object.freeze({ triangles: 2000, drawCalls: 10 }),
});

/**
 * SHADER PROGRAMS — 45, against 65 on desktop.
 *
 * Program count is a FIRST-LOAD stall, not a steady-state cost: each one is a
 * compile and link on the main thread the first time its material is drawn, and
 * on a phone that is a visible hitch in the first seconds of flight — exactly
 * when the user is deciding whether this thing works.
 *
 * Turning shadows off is most of the cut on its own: three compiles a separate
 * depth/distance variant per casting material per cascade, and `shadows.js`
 * additionally injects the terrain morph into its depth material. 45 is what
 * remains for terrain, water, sky, clouds, city, runways, aircraft and the
 * landmark models.
 */
export const PHONE_MAX_SHADER_PROGRAMS = 45;

/**
 * RENDERER PIXEL-RATIO CLAMP — 1.5, where phones commonly report 3.
 *
 * THE SINGLE EASIEST FRAMERATE CLIFF IN THE PROJECT. At DPR 3 a 393 x 852 CSS
 * viewport is a 1179 x 2556 drawing buffer — 3.01 megapixels, which is more
 * pixels than the desktop baseline was ever measured at. At 1.5 it is 590 x
 * 1278 = 0.75 Mpx: exactly 4x fewer, and comparable to the 1000 x 562 = 0.56 Mpx
 * the frame numbers in MODULES.md were taken at.
 *
 * Why 1.5 and not 1.0: the runway paint, the horizon and the HUD are all thin
 * high-contrast edges, and at DPR 1 on a phone they crawl. 1.5 supersamples
 * them 2.25x, which is the cheapest antialiasing available and is why
 * `antialias` is false on this tier — MSAA on a tile GPU costs bandwidth in the
 * resolve, and bandwidth is the scarce resource.
 */
export const PHONE_PIXEL_RATIO_MAX = 1.5;

/**
 * Absolute drawing-buffer ceiling — 1.2 megapixels.
 *
 * The ratio clamp alone is not a budget: a large phone in landscape at DPR 1.5
 * is still 1.35 Mpx. `effectivePixelRatio()` takes the smaller of the two, so
 * this is what actually binds on big devices and the ratio is what binds on
 * small ones. 1.2 Mpx is ~2.1x the desktop measurement point, which the 4x
 * triangle cut pays for.
 */
export const PHONE_MAX_DRAWING_BUFFER_PX = 1200000;

/** MSAA off — see PHONE_PIXEL_RATIO_MAX. The 1.5x supersample replaces it. */
export const PHONE_ANTIALIAS = false;

/**
 * SHADOW POLICY — OFF. Desktop runs four cascades at 2048.
 *
 * This is a draw-call decision and the arithmetic is above. `shadows.js`'s
 * cheapest non-empty tier, 'low', is two cascades with `terrainCasts: false`;
 * the casters left are the aeroplane (~12 meshes), the runways (10), the city
 * (3–6) and the landmarks (~8), so one cascade costs ~35 extra calls and two
 * cost ~70. Against a 120-call budget that is 58% of the frame's entire call
 * allowance spent on contact shadows.
 *
 * It also removes a whole family of shader programs (above) and the shadow-map
 * render targets from the GPU reserve inside PHONE_HEAP_TARGET_MB.
 *
 * This is a budget constant, not a taste judgement: if a later round gets the
 * phone scene down to ~70 calls, raise this to 'low' and re-measure. The thing
 * shadows were buying — the aeroplane visibly sitting ON the runway rather than
 * hovering over it — is better bought on this tier by a single cheap contact
 * blob under the gear, which costs one draw call and no cascade.
 */
export const PHONE_SHADOW_QUALITY = 'off';

/**
 * TERRAIN LOD QUALITY — 0.40, against 1.0 on desktop.
 *
 * `createTerrain({ lodQuality })` divides LOD_TAU (0.003 rad) and scales the
 * clamp band, so 0.40 means a node's vertical error may subtend 0.0075 rad
 * instead of 0.003 before it subdivides. Node count falls as the square: 0.16 x
 * 211 drawn nodes = ~34, which is the 400k triangle budget and, more
 * importantly, ~32 MB of node-geometry cache against the desktop's ~199 MB
 * ceiling. That single number is the largest term in the heap cut.
 *
 * WHAT IT COSTS, stated honestly: the drawn mesh departs further from the
 * elevation field. Desktop measures 0.670 m RMS / 11.9 m worst; at 0.40 expect
 * roughly 2.5x that. It does NOT touch §1.4 — the collision surface is
 * `getElevationLocal`, not the mesh, so the wheels are unaffected and ground
 * contact does not change when LOD changes. It also cannot make the terrain
 * coarser than the DEM in the other direction: `demSpacingAt()` is a hard stop
 * that `lodQuality` deliberately does not scale.
 */
export const PHONE_TERRAIN_LOD_QUALITY = 0.4;

/**
 * TERRAIN VIEW RADIUS — 90,000 m. UNCHANGED FROM DESKTOP, ON PURPOSE.
 *
 * Mount Rainier is 84.1 km from the spawn. Cutting the view radius to save
 * memory would delete the mountain, and §1.5 is explicit: simplify the
 * TESSELLATION, never the source data or the extent. The saving comes from
 * `terrainLodQuality`, which makes distant nodes coarser, not absent.
 */
export const PHONE_TERRAIN_VIEW_RADIUS_M = 90000;

/**
 * BUILDINGS — 6,724 footprints of 23,979, and the 'minor' tier is not built.
 *
 * The real footprint set splits, by `landmarkModels.js`'s own thresholds:
 *
 *   tall   >= 50 m                    295 buildings    4,213 ring vertices
 *   major  >= 22 m or >= 1,400 m2   6,429 buildings   92,296 ring vertices
 *   minor  everything else         17,255 buildings  128,287 ring vertices
 *
 * The minor tier is 72% of the buildings and 57% of the vertex buffers for
 * detail that is visible only very close in. Desktop justifies its 6 km cutoff
 * as "a 9 m house at 6 km subtends 0.09 deg, about one and a half pixels at
 * 1000 px wide". Redo that on a phone: 393 CSS px at a 60 deg fov is 0.1538
 * deg/px, so the same house is 0.6 px — half of one. It is dropped for HEAP
 * first and for pixels second, and both reasons hold.
 *
 * The major cutoff is derived the same way rather than inherited. A 22 m
 * building subtends one phone pixel at 22 / 2.684e-3 rad = 8,196 m, so 8 km.
 * (Desktop keeps them to 25 km because its pixels are three times finer.)
 * `tall` keeps no cutoff at all — that is the downtown silhouette seen from
 * Rainier, 295 buildings in 6 chunks, and it is what makes the city read as a
 * city from 84 km.
 */
export const PHONE_BUILDING_MAX_COUNT = 6724;
export const PHONE_BUILDING_TALL_CUTOFF_M = Infinity;
export const PHONE_BUILDING_MAJOR_CUTOFF_M = 8000;
/** 0 means DO NOT BUILD this tier — not "build it and hide it at 0 m". */
export const PHONE_BUILDING_MINOR_CUTOFF_M = 0;

/**
 * CITY CHUNK EDGE — 8 km on a phone against the 3 km the desktop builds with.
 *
 * Draw calls are the binding constraint on a phone, not triangles. Measured at
 * phone tier over downtown: the city cost 101 draw calls for 99,164 triangles
 * against a 40-call share — 84% of the entire 120-call budget for 17% of the
 * triangles. Chunk count scales as (1/edge)^2, so 3 km -> 8 km folds roughly
 * seven chunks into one.
 *
 * MEASURED, AND IT DID NOT PAY. 8,000 was tried and reverted: over downtown it
 * took the city from 101 draw calls to 96 — five calls — while triangles went
 * from 99,164 to 134,243. Thirty-five thousand triangles for five calls is the
 * wrong side of a trade when BOTH are over budget. The mechanism stays because
 * it is the right knob and the tablet uses it, but the phone keeps 3 km until
 * something measures better.
 *
 * The city was never the real cost anyway. Chunk merging already collapses
 * 23,951 footprints into 26 drawn meshes. The 96 remaining calls are the
 * INDIVIDUALLY MODELLED landmarks: Space Needle 19 meshes, Tacoma Narrows
 * Bridge 19, Boeing Everett Factory 11, Great Wheel 9, T-Mobile Park 9 — about
 * 120 meshes across 20 landmarks, none of them merged and none distance-culled.
 * That is the next piece of work, and it is a real one.
 */
export const PHONE_CITY_CHUNK_M = 3000;

/**
 * LANDMARK CULL RADIUS — 15 km on a phone.
 *
 * The twenty hand-built landmarks are ~120 meshes between them, and even
 * flattened to one mesh per material they are the largest remaining draw-call
 * cost on a phone. From downtown, the two most expensive are the ones you can
 * least see: the Tacoma Narrows Bridge at 50 km (19 meshes) and the Boeing
 * Everett factory at 40 km (11).
 *
 * 15 km keeps everything in and around Seattle — the Needle, Columbia Center,
 * Smith Tower, both stadiums, the Great Wheel, MoPOP, Climate Pledge — and
 * drops the ones that are a smudge on the horizon.
 *
 * Desktop keeps everything (Infinity): it has the calls to spare, and the
 * far-horizon skyline is part of why the world reads as real.
 */
export const PHONE_LANDMARK_CULL_M = 15000;

/**
 * PROCEDURAL TEXTURE SCALE — 0.5 linear, so a quarter of the texels.
 *
 * MEASURED IN CHROME AT THE PHONE TIER, production build, by walking the scene
 * graph and summing every texture's backing store. Nothing in this sim ships a
 * texture file: every one of these is drawn or computed at boot, so every one
 * of them is a number this project chose and can choose again.
 *
 *   texture                     size        kind          bytes
 *   runway numeral atlas    1792 x 1536   CanvasTexture   10.5 MB
 *   fuselage skin           2048 x 1024   CanvasTexture    8.0 MB
 *   fuselage normal         2048 x 1024   DataTexture      8.0 MB  <- JS heap
 *   terrain region field    1280 x 1280   DataTexture      6.6 MB  <- JS heap
 *   land-cover region       1024 x 1280   DataTexture      5.0 MB  (already cut)
 *   land-cover detail        768 x 1024   DataTexture      3.0 MB  (already cut)
 *   wing skin               1024 x  512   CanvasTexture    2.0 MB
 *   wing normal             1024 x  512   DataTexture      2.0 MB  <- JS heap
 *   ---------------------------------------------------------------
 *                                                         45.1 MB, and the GPU
 * holds a copy of every row.
 *
 * A DataTexture's `image.data` is a typed array and lives on the JS heap for
 * the life of the session — three keeps it so it can re-upload after a context
 * loss. A CanvasTexture's pixels live in the canvas backing store, which the
 * heap counter cannot see but iOS's tab ceiling most certainly can. Both are
 * bytes this tier has to pay for, which is why the cut is applied to both.
 *
 * WHY 0.5 AND NOT LESS. The binding constraint is the fuselage skin, which is
 * the only one of these a player ever sees close up. It is laid out in metres:
 * 2048 texels over a 8.28 m hull is 247 texels/m, so at 0.5 it is 124 — and the
 * chase camera sits 20–50 m back, where the whole aeroplane is at most 400 CSS
 * px wide on a 393 px phone. 124 texels/m over 8.28 m is 1,024 texels across
 * ~400 px: still 2.5x supersampled. At 0.25 it would be 1.3x and the panel
 * lines would alias.
 *
 * The cut is applied by SCALING THE CANVAS TRANSFORM, not by reinterpreting the
 * drawing coordinates — every font size, stroke width and rivet pitch in those
 * generators is written in texels, and halving the canvas without halving the
 * pen would double the size of "NO STEP" on the hull.
 */
export const PHONE_TEXTURE_SCALE = 0.5;

/**
 * FRAME TARGET — 30 fps.
 *
 * A phone that holds 30 fps flat is a better flight sim than one that swings
 * between 55 and 20, because the flight model substeps at a fixed 1/240 s and
 * the autopilot differentiates its own rates: the autopilot smoothness result
 * (altitude inside a 60 ft band, under 25 vertical-speed reversals) is a
 * property of stable dt, not of large dt. Every triangle and draw-call number
 * above is derived from 33.3 ms.
 */
export const PHONE_TARGET_FPS = 30;
export const PHONE_FRAME_BUDGET_MS = 1000 / PHONE_TARGET_FPS;

// ---------------------------------------------------------------------------
// The three budget sets
// ---------------------------------------------------------------------------

/**
 * @typedef {object} Budgets
 * @property {string} tier
 * @property {number} targetFps
 * @property {number} frameBudgetMs
 * @property {number} heapTargetMB      JS heap, the iOS-survival number
 * @property {number} heapHardMB        measurement fails above this
 * @property {number} demCapBytes       elevation.js resident ceiling
 * @property {object} demPagingPolicy   {zoom: {radiusM, budgetTiles}}
 * @property {number} maxTriangles      renderer.info.render.triangles
 * @property {number} maxDrawCalls      renderer.info.render.calls
 * @property {number} maxShaderPrograms renderer.info.programs.length
 * @property {number} pixelRatioMax
 * @property {number} maxDrawingBufferPx
 * @property {boolean} antialias
 * @property {string} shadowQuality     'off'|'low'|'medium'|'high'
 * @property {number} terrainLodQuality
 * @property {number} terrainViewRadiusM
 * @property {number} textureScale      linear scale on every procedural texture
 * @property {{maxCount:number, tallCutoffM:number, majorCutoffM:number,
 *            minorCutoffM:number}} buildings
 * @property {boolean} logarithmicDepthBuffer
 */

/** Deep-freeze so a caller cannot mutate a shared budget out from under others. */
function freeze(o) {
  for (const v of Object.values(o)) if (v && typeof v === 'object') freeze(v);
  return Object.freeze(o);
}

const PHONE_BUDGETS = freeze({
  tier: TIER_PHONE,
  targetFps: PHONE_TARGET_FPS,
  frameBudgetMs: PHONE_FRAME_BUDGET_MS,
  heapTargetMB: PHONE_HEAP_TARGET_MB,
  heapHardMB: PHONE_HEAP_HARD_MB,
  demCapBytes: PHONE_DEM_CAP_BYTES,
  demPagingPolicy: PHONE_DEM_PAGING_POLICY,
  maxTriangles: PHONE_MAX_TRIANGLES,
  maxDrawCalls: PHONE_MAX_DRAW_CALLS,
  shares: PHONE_SHARES,
  maxShaderPrograms: PHONE_MAX_SHADER_PROGRAMS,
  pixelRatioMax: PHONE_PIXEL_RATIO_MAX,
  maxDrawingBufferPx: PHONE_MAX_DRAWING_BUFFER_PX,
  antialias: PHONE_ANTIALIAS,
  shadowQuality: PHONE_SHADOW_QUALITY,
  terrainLodQuality: PHONE_TERRAIN_LOD_QUALITY,
  terrainViewRadiusM: PHONE_TERRAIN_VIEW_RADIUS_M,
  textureScale: PHONE_TEXTURE_SCALE,
  buildings: {
    maxCount: PHONE_BUILDING_MAX_COUNT,
    tallCutoffM: PHONE_BUILDING_TALL_CUTOFF_M,
    majorCutoffM: PHONE_BUILDING_MAJOR_CUTOFF_M,
    minorCutoffM: PHONE_BUILDING_MINOR_CUTOFF_M,
    cityChunkM: PHONE_CITY_CHUNK_M,
  },
  landmarkCullM: PHONE_LANDMARK_CULL_M,
  // NEVER false, on any tier. The far plane is 300 km and the near plane 0.35 m
  // (MODULES §2.13); without it the distant terrain z-fights and sky.js's cloud
  // slabs lose the depth test against terrain twelve times farther away.
  logarithmicDepthBuffer: true,
});

/**
 * TABLET — halfway, and every number is a real interpolation rather than a
 * split difference.
 *
 * Heap 240 MB: an iPad's tab ceiling is higher than an iPhone's but the
 * architecture and the failure mode are identical, so the same GPU reserve
 * applies to a larger allowance.
 *
 * DEM 72 MiB = 238 pinned (29.75) + 192 @ z=13 (24.0) + 96 @ z=14 (12.0) =
 * 65.75 MiB planned. A 24 km z=13 disc is 164.6 tiles against 192; a 7.5 km
 * z=14 disc is 64.4 against 96.
 *
 * Triangles 900k: `terrainLodQuality` 0.70 gives 0.49 x 211 = ~103 nodes x
 * 8,704 = ~897k. Draw calls 240 at ~60 µs is 14 ms of a 16.7 ms frame — which
 * is why shadows drop to 'low' (2 cascades, terrain does not cast) rather than
 * staying at 'medium'.
 *
 * Pixel ratio 2.0 with a 2.2 Mpx ceiling: an iPad Pro 12.9" is 1024 x 1366 =
 * 1.40 Mpx of CSS, so the ceiling binds first and gives an effective 1.25.
 */
const TABLET_BUDGETS = freeze({
  tier: TIER_TABLET,
  targetFps: 60,
  frameBudgetMs: 1000 / 60,
  heapTargetMB: 240,
  heapHardMB: 300,
  demCapBytes: 72 * 1024 * 1024,
  demPagingPolicy: {
    13: { radiusM: 24000, budgetTiles: 192 },
    14: { radiusM: 7500, budgetTiles: 96 },
  },
  maxTriangles: 900000,
  maxDrawCalls: 240,
  maxShaderPrograms: 55,
  pixelRatioMax: 2,
  maxDrawingBufferPx: 2200000,
  antialias: true,
  shadowQuality: 'low',
  terrainLodQuality: 0.7,
  terrainViewRadiusM: 90000,
  // A tablet is not short of texture memory in the way a phone is, and the one
  // texture a tablet DOES see close up — the fuselage — is seen on a screen
  // three times the area. Full size.
  textureScale: 1,
  buildings: {
    maxCount: 23979,
    tallCutoffM: Infinity,
    // A 22 m building is one tablet pixel (834 CSS px / 60 deg = 1.256e-3 rad)
    // at 17.5 km; a 9 m house at 7.2 km. Rounded down to 14 km / 3 km so the
    // minor tier's buffers are only paid for where they are actually seen.
    majorCutoffM: 14000,
    minorCutoffM: 3000,
    // Halfway, for the same reason as the phone: a tablet has more call budget
    // than a phone and less than a desktop.
    cityChunkM: 5000,
  },
  landmarkCullM: 35000,
  logarithmicDepthBuffer: true,
});

/**
 * DESKTOP — the MEASURED BASELINE, expressed as a budget with headroom.
 *
 * These deliberately reproduce today's behaviour exactly (`lodQuality` 1,
 * `viewRadiusM` 90000, shadows 'high', DPR clamped at 2, no pixel ceiling), so
 * that introducing the tier system cannot regress a single desktop number that
 * earlier rounds measured.
 *
 * THE CEILINGS ARE SET FROM THE LARGER OF TWO MEASUREMENTS, not from the quoted
 * baseline alone, because the baseline is viewport-dependent and the quoted one
 * is not the worst case. Re-measured on this machine after wiring the tier in:
 *
 *   viewport      triangles   draw calls
 *   1000 x  562   1,836,118   432          <- the MODULES.md baseline
 *   1524 x  874   2,457,127   526          <- a normal maximised window
 *
 * so the ceilings are 3.0 M and 640, about 22% over the larger figure. A budget
 * that a desktop exceeds at its own default window size is not a budget.
 */
const DESKTOP_BUDGETS = freeze({
  tier: TIER_DESKTOP,
  targetFps: 60,
  frameBudgetMs: 1000 / 60,
  heapTargetMB: 400,
  heapHardMB: 520,
  demCapBytes: 96 * 1024 * 1024,
  demPagingPolicy: {
    13: { radiusM: 30000, budgetTiles: 288 },
    14: { radiusM: 9000, budgetTiles: 128 },
  },
  maxTriangles: 3000000,
  maxDrawCalls: 640,
  maxShaderPrograms: 80,
  pixelRatioMax: 2,
  maxDrawingBufferPx: Infinity,
  antialias: true,
  shadowQuality: 'high',
  terrainLodQuality: 1,
  terrainViewRadiusM: 90000,
  textureScale: 1,
  buildings: {
    maxCount: 23979,
    tallCutoffM: Infinity,
    majorCutoffM: 25000,
    minorCutoffM: 6000,
  },
  logarithmicDepthBuffer: true,
});

/** @type {Record<string, Budgets>} */
export const BUDGETS = Object.freeze({
  [TIER_PHONE]: PHONE_BUDGETS,
  [TIER_TABLET]: TABLET_BUDGETS,
  [TIER_DESKTOP]: DESKTOP_BUDGETS,
});

/** Budgets for a tier name; unknown names fall back to desktop (§1.6). */
export function budgetsFor(tier) {
  return BUDGETS[tier] || DESKTOP_BUDGETS;
}

// ---------------------------------------------------------------------------
// The WebGL capability probe
// ---------------------------------------------------------------------------

/**
 * Create a throwaway context and ask it what it can do.
 *
 * Returns null when there is no WebGL at all — which is a signal, not an error:
 * §1.6 says nothing blocks the boot, so callers derate and carry on.
 *
 * The context is explicitly lost afterwards. A page that leaves probe contexts
 * alive can hit the browser's per-page context limit and kill the real one.
 *
 * @param {() => any} [makeCanvas] injectable for tests; defaults to the DOM
 */
export function probeWebGL(makeCanvas) {
  let canvas;
  try {
    canvas =
      typeof makeCanvas === 'function'
        ? makeCanvas()
        : typeof document !== 'undefined'
          ? document.createElement('canvas')
          : null;
  } catch {
    canvas = null;
  }
  if (!canvas || typeof canvas.getContext !== 'function') return null;

  let gl = null;
  let version = 0;
  try {
    gl = canvas.getContext('webgl2');
    if (gl) version = 2;
  } catch {
    gl = null;
  }
  if (!gl) {
    try {
      gl = canvas.getContext('webgl') || canvas.getContext('experimental-webgl');
      if (gl) version = 1;
    } catch {
      gl = null;
    }
  }
  if (!gl) return null;

  const P = (name, fallback = 0) => {
    try {
      const v = gl.getParameter(gl[name]);
      return typeof v === 'number' ? v : fallback;
    } catch {
      return fallback;
    }
  };
  const ext = (name) => {
    try {
      return !!gl.getExtension(name);
    } catch {
      return false;
    }
  };

  // Float textures: two independent questions. Can we SAMPLE one linearly, and
  // can we RENDER to one? Terrain morphing and any future float target need the
  // first; nothing in the sim needs the second today, but a phone that cannot
  // do either is a phone whose driver is old enough to derate on.
  const floatTexture = version === 2 ? true : ext('OES_texture_float');
  const floatLinear = version === 2 ? ext('OES_texture_float_linear') : ext('OES_texture_float_linear');
  const halfFloatLinear = version === 2 ? true : ext('OES_texture_half_float_linear');
  const colorBufferFloat =
    version === 2 ? ext('EXT_color_buffer_float') : ext('WEBGL_color_buffer_float');

  // Diagnostic only. NOT a classification signal — see the header.
  let unmaskedVendor = '';
  let unmaskedRenderer = '';
  try {
    const dbg = gl.getExtension('WEBGL_debug_renderer_info');
    if (dbg) {
      unmaskedVendor = String(gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL) || '');
      unmaskedRenderer = String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) || '');
    }
  } catch {
    /* ignore */
  }

  const out = {
    version,
    maxTextureSize: P('MAX_TEXTURE_SIZE'),
    maxCubeMapTextureSize: P('MAX_CUBE_MAP_TEXTURE_SIZE'),
    maxRenderbufferSize: P('MAX_RENDERBUFFER_SIZE'),
    maxTextureImageUnits: P('MAX_TEXTURE_IMAGE_UNITS'),
    maxVertexTextureImageUnits: P('MAX_VERTEX_TEXTURE_IMAGE_UNITS'),
    maxVertexAttribs: P('MAX_VERTEX_ATTRIBS'),
    maxVertexUniformVectors: P('MAX_VERTEX_UNIFORM_VECTORS'),
    maxFragmentUniformVectors: P('MAX_FRAGMENT_UNIFORM_VECTORS'),
    // WebGL2 reports MAX_VARYING_COMPONENTS; normalise both to VECTORS so one
    // number means the same thing on both. sky.js's fog adds a varying to every
    // fogged material (§2.8), so this is a real constraint, not trivia.
    maxVaryingVectors:
      P('MAX_VARYING_VECTORS') || Math.floor(P('MAX_VARYING_COMPONENTS') / 4),
    maxSamples: version === 2 ? P('MAX_SAMPLES') : 0,
    floatTexture,
    floatLinear,
    halfFloatLinear,
    colorBufferFloat,
    floatTexturesUsable: !!(floatTexture && floatLinear),
    unmaskedVendor,
    unmaskedRenderer,
  };

  try {
    const lose = gl.getExtension('WEBGL_lose_context');
    if (lose) lose.loseContext();
  } catch {
    /* ignore */
  }
  return out;
}

// ---------------------------------------------------------------------------
// Signals
// ---------------------------------------------------------------------------

/**
 * @typedef {object} DeviceSignals
 * @property {number}  maxTouchPoints
 * @property {boolean} pointerCoarse    primary pointer is coarse
 * @property {boolean} anyPointerCoarse
 * @property {boolean} anyPointerFine   SOME pointer is fine -> a mouse exists
 * @property {boolean} hoverHover       primary pointer can hover
 * @property {boolean} anyHover
 * @property {number}  screenWidthCss
 * @property {number}  screenHeightCss
 * @property {number}  shortEdgeCss     min of the two, orientation-independent
 * @property {number}  longEdgeCss
 * @property {number}  viewportWidthCss
 * @property {number}  viewportHeightCss
 * @property {number}  devicePixelRatio
 * @property {number}  deviceMemoryGB   0 when the browser does not expose it
 * @property {number}  hardwareConcurrency
 * @property {boolean} reducedMotion
 * @property {boolean} standalone       launched from the home screen
 * @property {object|null} gl           probeWebGL() result
 * @property {string}  uaHint           RECORDED, NEVER CLASSIFIED ON
 * @property {boolean|null} uaMobileHint same
 */

const NO_MATCH = { matches: false };

/**
 * Read every signal, from an injectable environment.
 *
 * @param {object} [env]
 * @param {any} [env.navigator]
 * @param {any} [env.screen]
 * @param {any} [env.window]
 * @param {(q: string) => {matches: boolean}} [env.matchMedia]
 * @param {object|null|false} [env.gl] a probe result, or false to skip probing
 * @returns {DeviceSignals}
 */
export function readSignals(env = {}) {
  const nav =
    env.navigator ?? (typeof navigator !== 'undefined' ? navigator : undefined) ?? {};
  const win = env.window ?? (typeof window !== 'undefined' ? window : undefined) ?? {};
  const scr = env.screen ?? win.screen ?? (typeof screen !== 'undefined' ? screen : undefined) ?? {};

  const mm =
    env.matchMedia ||
    (typeof win.matchMedia === 'function' ? (q) => win.matchMedia(q) : () => NO_MATCH);
  const q = (query) => {
    try {
      return !!mm(query)?.matches;
    } catch {
      return false;
    }
  };

  const num = (v, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);

  const w = num(scr.width, num(win.innerWidth, 1280));
  const h = num(scr.height, num(win.innerHeight, 800));

  let gl = null;
  if (env.gl === false) gl = null;
  else if (env.gl !== undefined) gl = env.gl;
  else gl = probeWebGL();

  return {
    maxTouchPoints: num(nav.maxTouchPoints, 0),
    pointerCoarse: q('(pointer: coarse)'),
    anyPointerCoarse: q('(any-pointer: coarse)'),
    anyPointerFine: q('(any-pointer: fine)'),
    hoverHover: q('(hover: hover)'),
    anyHover: q('(any-hover: hover)'),

    screenWidthCss: w,
    screenHeightCss: h,
    shortEdgeCss: Math.min(w, h),
    longEdgeCss: Math.max(w, h),
    viewportWidthCss: num(win.innerWidth, w),
    viewportHeightCss: num(win.innerHeight, h),
    devicePixelRatio: num(win.devicePixelRatio, 1) || 1,

    deviceMemoryGB: num(nav.deviceMemory, 0),
    hardwareConcurrency: num(nav.hardwareConcurrency, 0),
    reducedMotion: q('(prefers-reduced-motion: reduce)'),
    standalone: q('(display-mode: standalone)') || nav.standalone === true,

    gl,

    // Recorded for bug reports. classifyTier() must not read either of these,
    // and check-device.mjs asserts that it does not.
    uaHint: typeof nav.userAgent === 'string' ? nav.userAgent : '',
    uaMobileHint:
      nav.userAgentData && typeof nav.userAgentData.mobile === 'boolean'
        ? nav.userAgentData.mobile
        : null,
  };
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

/**
 * True when the device's PRIMARY way of pointing is a finger.
 *
 * The `anyPointerFine && hoverHover` term is the desktop-with-touchscreen
 * guard: such a machine has a mouse, so it reports a fine primary pointer AND a
 * fine any-pointer AND hover. Both terms are checked because they fail
 * independently — some Windows builds report `pointer: coarse` on a 2-in-1 with
 * the keyboard attached, and the mouse test catches those.
 *
 * @param {DeviceSignals} s
 */
export function isTouchPrimary(s) {
  if (!(s.maxTouchPoints >= 1)) return false;
  if (!s.pointerCoarse) return false;
  if (s.anyPointerFine && s.hoverHover) return false;
  return true;
}

/**
 * The tier rules, in one place. Pure: same signals in, same tier out.
 *
 * @param {DeviceSignals} s
 * @returns {'phone'|'tablet'|'desktop'}
 */
export function classifyTier(s) {
  const small = s.shortEdgeCss > 0 && s.shortEdgeCss < PHONE_MAX_SHORT_EDGE_CSS_PX;

  // HARD PHONE FLOOR, before the mouse guard, and it does NOT ask which pointer
  // is primary. A phone with a Bluetooth mouse paired reports `pointer: fine`
  // and `hover: hover` — iOS genuinely switches the primary pointer over — so
  // the mouse guard would send it to 'desktop', and handing an iPhone a
  // 352 MB desktop budget is exactly how a tab gets killed mid-flight.
  //
  // Touch capability plus a short edge under 600 CSS px is sufficient on its
  // own: no desktop or laptop display is that small, so this cannot pull a real
  // desktop down. `anyPointerCoarse` is the corroborating signal — the device
  // has a coarse pointer available whether or not it is the primary one.
  if (small && s.maxTouchPoints >= 1 && s.anyPointerCoarse) return TIER_PHONE;

  if (!isTouchPrimary(s)) return TIER_DESKTOP;
  return small ? TIER_PHONE : TIER_TABLET;
}

/**
 * Which budget a device of that tier can actually afford.
 *
 * Derating is ONE step down, never two, never up. The triggers are all capability
 * measurements — a class average is optimistic for the bottom of the class, and
 * these are the four things that reliably mark the bottom.
 *
 * @param {DeviceSignals} s
 * @param {string} [tier] defaults to classifyTier(s)
 * @returns {{tier: string, reasons: string[]}}
 */
export function budgetTierFor(s, tier = classifyTier(s)) {
  const reasons = [];
  const gl = s.gl;

  if (!gl) reasons.push('no WebGL context could be created');
  else {
    // 8192 is the floor three needs for our shadow atlas headroom and the
    // land-cover region raster; below it the device is pre-2016 mobile silicon.
    if (gl.maxTextureSize > 0 && gl.maxTextureSize < 8192)
      reasons.push(`MAX_TEXTURE_SIZE ${gl.maxTextureSize} < 8192`);
    if (!gl.floatTexturesUsable) reasons.push('float textures not linearly filterable');
    // sky.js's fog adds a varying to every fogged material (§2.8) on top of
    // terrain's morph varyings. 8 vectors is the WebGL1 minimum and it is tight.
    if (gl.maxVaryingVectors > 0 && gl.maxVaryingVectors < 10)
      reasons.push(`MAX_VARYING_VECTORS ${gl.maxVaryingVectors} < 10`);
  }
  // Only trust deviceMemory when the browser actually reported it. Safari does
  // not, and treating "absent" as "small" would derate every iPhone twice.
  if (s.deviceMemoryGB > 0 && s.deviceMemoryGB <= 2)
    reasons.push(`deviceMemory ${s.deviceMemoryGB} GB <= 2`);

  if (reasons.length === 0) return { tier, reasons };
  const i = TIERS.indexOf(tier);
  const down = i > 0 ? TIERS[i - 1] : TIERS[0];
  return { tier: down, reasons };
}

// ---------------------------------------------------------------------------
// Overrides
// ---------------------------------------------------------------------------

/**
 * A tier the user asked for explicitly, or null.
 *
 * Two sources, query string first: `?tier=phone` (also `?device=`) so a phone
 * budget can be tested on a desktop with a link, and `localStorage['sim.tier']`
 * so it sticks across a reload. Anything unrecognised is ignored, not thrown.
 *
 * @param {string} [search] e.g. location.search
 * @param {{getItem?: (k: string) => any}} [storage]
 */
export function readTierOverride(search = '', storage = null) {
  const norm = (v) => {
    const t = String(v || '').trim().toLowerCase();
    return TIERS.includes(t) ? t : null;
  };
  try {
    const p = new URLSearchParams(String(search || ''));
    const fromUrl = norm(p.get('tier')) || norm(p.get('device'));
    if (fromUrl) return fromUrl;
  } catch {
    /* ignore */
  }
  try {
    if (storage && typeof storage.getItem === 'function') {
      const fromStore = norm(storage.getItem('sim.tier'));
      if (fromStore) return fromStore;
    }
  } catch {
    /* ignore — private mode throws on localStorage */
  }
  return null;
}

/**
 * The one call a caller makes at boot.
 *
 * @param {object} [opts]
 * @param {object} [opts.env]      forwarded to readSignals()
 * @param {string} [opts.override] force a tier, skipping detection
 * @param {string} [opts.search]   location.search, for ?tier=
 * @param {object} [opts.storage]  localStorage, for a sticky override
 * @returns {{tier: string, detectedTier: string, budgetTier: string,
 *            budgets: Budgets, signals: DeviceSignals, derated: boolean,
 *            derateReasons: string[], overridden: boolean, touch: boolean}}
 */
export function resolveDevice(opts = {}) {
  const signals = readSignals(opts.env);
  const detectedTier = classifyTier(signals);

  const explicit =
    (TIERS.includes(String(opts.override)) ? String(opts.override) : null) ??
    readTierOverride(opts.search ?? '', opts.storage ?? null);

  if (explicit) {
    return {
      tier: explicit,
      detectedTier,
      budgetTier: explicit,
      budgets: budgetsFor(explicit),
      signals,
      derated: false,
      derateReasons: [],
      overridden: true,
      touch: isTouchPrimary(signals),
    };
  }

  const { tier: budgetTier, reasons } = budgetTierFor(signals, detectedTier);
  return {
    tier: detectedTier,
    detectedTier,
    budgetTier,
    budgets: budgetsFor(budgetTier),
    signals,
    derated: budgetTier !== detectedTier,
    derateReasons: reasons,
    overridden: false,
    touch: isTouchPrimary(signals),
  };
}

// ---------------------------------------------------------------------------
// Applying a budget
// ---------------------------------------------------------------------------

/**
 * The pixel ratio to hand `renderer.setPixelRatio()`.
 *
 * TWO ceilings, and the tighter one wins: a RATIO clamp, which is what binds on
 * a small phone at DPR 3, and an absolute PIXEL count, which is what binds on a
 * large phone in landscape or on a tablet. Quantised down to a 0.05 step so an
 * on-screen-keyboard or a URL-bar collapse — both of which change innerHeight by
 * a few pixels — cannot reallocate the drawing buffer on every resize event.
 *
 * @param {Budgets} budgets
 * @param {number} dpr        window.devicePixelRatio
 * @param {number} cssWidth   window.innerWidth
 * @param {number} cssHeight  window.innerHeight
 */
export function effectivePixelRatio(budgets, dpr, cssWidth, cssHeight) {
  const b = budgets || DESKTOP_BUDGETS;
  const d = Number.isFinite(dpr) && dpr > 0 ? dpr : 1;
  let r = Math.min(d, b.pixelRatioMax);

  const area = (cssWidth || 0) * (cssHeight || 0);
  if (Number.isFinite(b.maxDrawingBufferPx) && area > 0) {
    r = Math.min(r, Math.sqrt(b.maxDrawingBufferPx / area));
  }
  // Quantise down, then floor at 0.5: below that the HUD text and the runway
  // centreline stop being legible, and an unreadable 60 fps is not a win.
  r = Math.floor(r * 20) / 20;
  return Math.max(0.5, Math.min(r, d));
}

/**
 * One line for the console at boot. Everything a bug report needs.
 * @param {ReturnType<typeof resolveDevice>} d
 */
export function describeDevice(d) {
  const s = d.signals;
  const gl = s.gl;
  return (
    `[device] ${d.tier}${d.overridden ? ' (forced)' : ''}` +
    `${d.derated ? ` -> ${d.budgetTier} budgets (${d.derateReasons.join('; ')})` : ''} | ` +
    `touch ${d.touch ? 'yes' : 'no'} (${s.maxTouchPoints} pts, ` +
    `${s.pointerCoarse ? 'coarse' : 'fine'} primary` +
    `${s.anyPointerFine ? ', fine available' : ''}) | ` +
    `screen ${s.screenWidthCss}x${s.screenHeightCss} css, dpr ${s.devicePixelRatio} | ` +
    `mem ${s.deviceMemoryGB || '?'} GB, ${s.hardwareConcurrency || '?'} cores | ` +
    `gl${gl ? `${gl.version} tex ${gl.maxTextureSize}, var ${gl.maxVaryingVectors}, ` +
      `float ${gl.floatTexturesUsable ? 'yes' : 'no'}` : ' none'}` +
    `${gl && gl.unmaskedRenderer ? ` | ${gl.unmaskedRenderer}` : ''}`
  );
}
