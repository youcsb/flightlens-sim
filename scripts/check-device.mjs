/**
 * check-device.mjs — the tier rules and the mobile budgets, asserted.
 *
 *   npm run check:device
 *
 * `src/core/device.js` is the foundation of the mobile round: four other
 * modules size themselves from its budgets, and every one of them is wrong if
 * the classifier hands a phone a desktop budget or the other way round. The
 * classifier is a pure function of a signal object, so the shipping code runs
 * here unmodified against synthetic devices — no DOM, no GPU, no browser.
 *
 * THE ONE THAT MATTERS MOST is `desktop with a touchscreen`. A 24" all-in-one
 * reports ten touch points and would be classified as a phone by anything that
 * looks at `maxTouchPoints` alone. It must come out 'desktop' — and, separately,
 * a phone with a Bluetooth mouse paired reports a fine pointer and hover and
 * must still come out 'phone', because getting THAT one wrong is a tab that iOS
 * Safari kills mid-flight.
 *
 * The other structural assertion is that the USER-AGENT IS NEVER READ. Every
 * device below is classified twice with opposite UA strings and the tier must
 * not move. The browser-pane harness sets an Android UA on a desktop GPU, and
 * iPadOS ships a desktop Safari UA on a tablet; a UA check is wrong in both
 * directions at once.
 */

import {
  BUDGETS,
  TIERS,
  TIER_PHONE,
  TIER_TABLET,
  TIER_DESKTOP,
  PHONE_MAX_SHORT_EDGE_CSS_PX,
  PHONE_HEAP_TARGET_MB,
  PHONE_HEAP_HARD_MB,
  PHONE_DEM_CAP_BYTES,
  PHONE_DEM_PAGING_POLICY,
  PHONE_MAX_TRIANGLES,
  PHONE_MAX_DRAW_CALLS,
  PHONE_MAX_SHADER_PROGRAMS,
  PHONE_PIXEL_RATIO_MAX,
  PHONE_MAX_DRAWING_BUFFER_PX,
  PHONE_SHADOW_QUALITY,
  PHONE_TERRAIN_LOD_QUALITY,
  PHONE_TERRAIN_VIEW_RADIUS_M,
  PHONE_BUILDING_MAX_COUNT,
  budgetsFor,
  budgetTierFor,
  classifyTier,
  describeDevice,
  effectivePixelRatio,
  isTouchPrimary,
  probeWebGL,
  readSignals,
  readTierOverride,
  resolveDevice,
} from '../src/core/device.js';

let failures = 0;
const ok = (name, cond, note = '') => {
  if (cond) {
    console.log(`  ok   ${name}${note ? `  (${note})` : ''}`);
  } else {
    failures++;
    console.log(`  FAIL ${name}${note ? `  (${note})` : ''}`);
  }
};

// ---------------------------------------------------------------------------
// The measured desktop baseline these budgets are cut from. Quoted so a future
// round can see whether the cut is still a cut.
// ---------------------------------------------------------------------------
const BASELINE = {
  heapMB: 352.8,
  triangles: 1836118,
  drawCalls: 432,
  programs: 65,
  demResidentBytes: 73.6 * 1024 * 1024,
  demCapBytes: 96 * 1024 * 1024,
  buildings: 23979,
};

const TILE_BYTES = 256 * 256 * 2; // elevation.js §2.4: Int16 quarter-metres
const Z11_PINNED_TILES = 238; // whole region, never evicted

// ---------------------------------------------------------------------------
// Synthetic environments.
//
// Each is a plain object matching what readSignals() reads: a fake navigator, a
// fake screen, a fake window and a matchMedia that answers from a media-query
// truth table. `gl` is injected directly so no GPU is needed.
// ---------------------------------------------------------------------------

/** A GL probe result for a modern mobile GPU: A15, Adreno 7xx, Mali-G7xx. */
const GL_MODERN_MOBILE = {
  version: 2,
  maxTextureSize: 16384,
  maxRenderbufferSize: 16384,
  maxVaryingVectors: 15,
  maxVertexUniformVectors: 1024,
  maxSamples: 4,
  floatTexture: true,
  floatLinear: true,
  halfFloatLinear: true,
  colorBufferFloat: true,
  floatTexturesUsable: true,
  unmaskedRenderer: 'Apple GPU',
  unmaskedVendor: 'Apple',
};

/** A desktop discrete GPU. */
const GL_DESKTOP = {
  ...GL_MODERN_MOBILE,
  maxTextureSize: 16384,
  maxVaryingVectors: 30,
  maxSamples: 8,
  unmaskedRenderer: 'ANGLE (Apple, Apple M2, OpenGL 4.1)',
  unmaskedVendor: 'Google Inc. (Apple)',
};

/** A 2016-era budget mobile GPU: half the texture size, no float filtering. */
const GL_OLD_MOBILE = {
  version: 1,
  maxTextureSize: 4096,
  maxRenderbufferSize: 4096,
  maxVaryingVectors: 8,
  maxVertexUniformVectors: 128,
  maxSamples: 0,
  floatTexture: true,
  floatLinear: false,
  halfFloatLinear: false,
  colorBufferFloat: false,
  floatTexturesUsable: false,
  unmaskedRenderer: 'Mali-T760',
  unmaskedVendor: 'ARM',
};

/**
 * Build an env from a compact description.
 *
 * `pointer` is the PRIMARY pointer, `mouse` says whether a fine pointer exists
 * at all — those are the two independent facts the classifier turns on.
 */
function env({
  touchPoints = 0,
  pointer = 'fine',
  mouse = true,
  width = 1280,
  height = 800,
  dpr = 1,
  memory,
  cores = 8,
  ua = '',
  uaMobile = null,
  gl = GL_DESKTOP,
  innerWidth,
  innerHeight,
}) {
  const truth = {
    '(pointer: coarse)': pointer === 'coarse',
    '(pointer: fine)': pointer === 'fine',
    '(any-pointer: coarse)': touchPoints >= 1,
    '(any-pointer: fine)': mouse,
    '(hover: hover)': mouse && pointer === 'fine',
    '(any-hover: hover)': mouse,
    '(prefers-reduced-motion: reduce)': false,
    '(display-mode: standalone)': false,
  };
  const navigator = { maxTouchPoints: touchPoints, hardwareConcurrency: cores, userAgent: ua };
  if (memory !== undefined) navigator.deviceMemory = memory;
  if (uaMobile !== null) navigator.userAgentData = { mobile: uaMobile };
  return {
    navigator,
    screen: { width, height },
    window: {
      devicePixelRatio: dpr,
      innerWidth: innerWidth ?? width,
      innerHeight: innerHeight ?? height,
    },
    matchMedia: (q) => ({ matches: truth[q] === true }),
    gl,
  };
}

const UA_IPHONE =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148';
const UA_ANDROID =
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/124.0 Mobile Safari/537.36';
const UA_MAC =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/17.5 Safari/605.1.15';

// A real device fleet. `want` is the tier the rules must produce.
const FLEET = [
  {
    name: 'iPhone 15 Pro',
    want: TIER_PHONE,
    e: { touchPoints: 5, pointer: 'coarse', mouse: false, width: 393, height: 852, dpr: 3, ua: UA_IPHONE, gl: GL_MODERN_MOBILE },
  },
  {
    name: 'iPhone 15 Pro Max, held in landscape',
    want: TIER_PHONE,
    e: { touchPoints: 5, pointer: 'coarse', mouse: false, width: 430, height: 932, dpr: 3, innerWidth: 932, innerHeight: 430, ua: UA_IPHONE, gl: GL_MODERN_MOBILE },
  },
  {
    name: 'Pixel 8, Chrome',
    want: TIER_PHONE,
    e: { touchPoints: 5, pointer: 'coarse', mouse: false, width: 412, height: 915, dpr: 2.625, memory: 8, ua: UA_ANDROID, uaMobile: true, gl: GL_MODERN_MOBILE },
  },
  {
    name: 'browser-pane mobile preset (375x812, Android UA, desktop GPU)',
    want: TIER_PHONE,
    e: { touchPoints: 5, pointer: 'coarse', mouse: false, width: 375, height: 812, dpr: 2, ua: UA_ANDROID, uaMobile: true, gl: GL_DESKTOP },
  },
  {
    name: 'iPad mini',
    want: TIER_TABLET,
    e: { touchPoints: 5, pointer: 'coarse', mouse: false, width: 744, height: 1133, dpr: 2, ua: UA_MAC, gl: GL_MODERN_MOBILE },
  },
  {
    name: 'iPad Pro 12.9 (ships a DESKTOP Safari UA)',
    want: TIER_TABLET,
    e: { touchPoints: 5, pointer: 'coarse', mouse: false, width: 1024, height: 1366, dpr: 2, ua: UA_MAC, gl: GL_MODERN_MOBILE },
  },
  {
    name: 'Surface Pro, keyboard detached',
    want: TIER_TABLET,
    e: { touchPoints: 10, pointer: 'coarse', mouse: false, width: 912, height: 1368, dpr: 2, memory: 8, gl: GL_DESKTOP },
  },
  {
    name: 'desktop, no touch',
    want: TIER_DESKTOP,
    e: { touchPoints: 0, pointer: 'fine', mouse: true, width: 2560, height: 1440, dpr: 1, memory: 8, gl: GL_DESKTOP },
  },
  {
    name: 'DESKTOP WITH A TOUCHSCREEN — must NOT be a phone',
    want: TIER_DESKTOP,
    e: { touchPoints: 10, pointer: 'fine', mouse: true, width: 1920, height: 1080, dpr: 1, memory: 16, gl: GL_DESKTOP },
  },
  {
    name: 'laptop with a touchscreen, small window open',
    want: TIER_DESKTOP,
    e: { touchPoints: 10, pointer: 'fine', mouse: true, width: 1440, height: 900, dpr: 2, innerWidth: 420, innerHeight: 700, memory: 16, gl: GL_DESKTOP },
  },
  {
    name: 'phone with a Bluetooth mouse paired',
    want: TIER_PHONE,
    e: { touchPoints: 5, pointer: 'fine', mouse: true, width: 393, height: 852, dpr: 3, ua: UA_IPHONE, gl: GL_MODERN_MOBILE },
  },
  {
    name: 'desktop spoofing an iPhone UA',
    want: TIER_DESKTOP,
    e: { touchPoints: 0, pointer: 'fine', mouse: true, width: 2560, height: 1440, dpr: 1, ua: UA_IPHONE, uaMobile: true, gl: GL_DESKTOP },
  },
];

// ===========================================================================
console.log('\ntier rules');
// ===========================================================================
for (const d of FLEET) {
  const s = readSignals(env(d.e));
  const got = classifyTier(s);
  ok(d.name, got === d.want, `${got}, short edge ${s.shortEdgeCss} css px`);
}

{
  // The breakpoint itself, from both sides, on an otherwise identical device.
  const at = (w) =>
    classifyTier(readSignals(env({ touchPoints: 5, pointer: 'coarse', mouse: false, width: w, height: w * 2, gl: GL_MODERN_MOBILE })));
  ok(`${PHONE_MAX_SHORT_EDGE_CSS_PX - 1} css short edge is a phone`, at(PHONE_MAX_SHORT_EDGE_CSS_PX - 1) === TIER_PHONE);
  ok(`${PHONE_MAX_SHORT_EDGE_CSS_PX} css short edge is a tablet`, at(PHONE_MAX_SHORT_EDGE_CSS_PX) === TIER_TABLET);

  // Orientation must not change the answer: shortEdgeCss is min(w, h).
  const p = env({ touchPoints: 5, pointer: 'coarse', mouse: false, width: 412, height: 915, gl: GL_MODERN_MOBILE });
  const l = env({ touchPoints: 5, pointer: 'coarse', mouse: false, width: 915, height: 412, gl: GL_MODERN_MOBILE });
  ok('rotating the device does not change the tier', classifyTier(readSignals(p)) === classifyTier(readSignals(l)), 'both phone');

  // A window resize must not change it either — screen, not viewport.
  const wide = env({ touchPoints: 0, pointer: 'fine', width: 2560, height: 1440, innerWidth: 380, innerHeight: 700, gl: GL_DESKTOP });
  ok('a narrow browser window on a desktop is still a desktop', classifyTier(readSignals(wide)) === TIER_DESKTOP);

  ok('touch primary: iPhone yes', isTouchPrimary(readSignals(env(FLEET[0].e))) === true);
  ok('touch primary: touchscreen desktop no', isTouchPrimary(readSignals(env(FLEET[8].e))) === false);
  ok('touch primary: plain desktop no', isTouchPrimary(readSignals(env(FLEET[7].e))) === false);
  ok('zero touch points is never touch primary', isTouchPrimary(readSignals(env({ touchPoints: 0, pointer: 'coarse', mouse: false, width: 400, height: 800 }))) === false);
}

// ===========================================================================
console.log('\nthe user agent is never a classification signal');
// ===========================================================================
for (const d of FLEET) {
  const tiers = new Set();
  for (const ua of ['', UA_IPHONE, UA_ANDROID, UA_MAC]) {
    for (const uaMobile of [null, true, false]) {
      tiers.add(classifyTier(readSignals(env({ ...d.e, ua, uaMobile }))));
    }
  }
  ok(`${d.name}: 12 UA permutations, one tier`, tiers.size === 1, [...tiers].join('/'));
}

// ===========================================================================
console.log('\nderating — tier is the device, budget is what it can afford');
// ===========================================================================
{
  const tabletOld = readSignals(env({ touchPoints: 5, pointer: 'coarse', mouse: false, width: 800, height: 1280, gl: GL_OLD_MOBILE }));
  ok('old-GPU tablet classifies as a tablet', classifyTier(tabletOld) === TIER_TABLET);
  const r1 = budgetTierFor(tabletOld);
  ok('old-GPU tablet gets PHONE budgets', r1.tier === TIER_PHONE, r1.reasons.join('; '));

  const tabletLowMem = readSignals(env({ touchPoints: 5, pointer: 'coarse', mouse: false, width: 800, height: 1280, memory: 2, gl: GL_MODERN_MOBILE }));
  const r2 = budgetTierFor(tabletLowMem);
  ok('2 GB tablet gets PHONE budgets', r2.tier === TIER_PHONE, r2.reasons.join('; '));

  const noGl = readSignals(env({ touchPoints: 0, pointer: 'fine', width: 1920, height: 1080, gl: null }));
  const r3 = budgetTierFor(noGl);
  ok('no WebGL derates a desktop to tablet budgets', r3.tier === TIER_TABLET, r3.reasons.join('; '));

  const phoneOld = readSignals(env({ touchPoints: 5, pointer: 'coarse', mouse: false, width: 360, height: 740, gl: GL_OLD_MOBILE }));
  const r4 = budgetTierFor(phoneOld);
  ok('derating never goes below phone', r4.tier === TIER_PHONE);

  const healthy = readSignals(env({ touchPoints: 5, pointer: 'coarse', mouse: false, width: 393, height: 852, gl: GL_MODERN_MOBILE }));
  const r5 = budgetTierFor(healthy);
  ok('a healthy device is not derated', r5.tier === TIER_PHONE && r5.reasons.length === 0);

  // Safari does not expose deviceMemory. Absent must not read as small.
  const noMem = readSignals(env({ touchPoints: 5, pointer: 'coarse', mouse: false, width: 744, height: 1133, gl: GL_MODERN_MOBILE }));
  ok('absent deviceMemory does not derate', noMem.deviceMemoryGB === 0 && budgetTierFor(noMem).tier === TIER_TABLET);
  ok('derating never goes UP', budgetTierFor(readSignals(env({ touchPoints: 5, pointer: 'coarse', mouse: false, width: 393, height: 852, memory: 16, gl: GL_DESKTOP }))).tier === TIER_PHONE);
}

// ===========================================================================
console.log('\nresolveDevice + overrides');
// ===========================================================================
{
  const e = env(FLEET[7].e); // plain desktop
  const forced = resolveDevice({ env: e, search: '?tier=phone' });
  ok('?tier=phone forces the phone budget on a desktop', forced.tier === TIER_PHONE && forced.budgets.tier === TIER_PHONE);
  ok('a forced tier still reports what was DETECTED', forced.detectedTier === TIER_DESKTOP && forced.overridden === true);

  ok('?device= is accepted too', resolveDevice({ env: e, search: '?device=tablet' }).tier === TIER_TABLET);
  ok('an unknown ?tier= is ignored', resolveDevice({ env: e, search: '?tier=console' }).tier === TIER_DESKTOP);
  ok('localStorage override', resolveDevice({ env: e, storage: { getItem: (k) => (k === 'sim.tier' ? 'phone' : null) } }).tier === TIER_PHONE);
  ok('the URL beats localStorage', resolveDevice({ env: e, search: '?tier=tablet', storage: { getItem: () => 'phone' } }).tier === TIER_TABLET);
  ok('a throwing storage does not throw', (() => { try { return resolveDevice({ env: e, storage: { getItem() { throw new Error('private mode'); } } }).tier === TIER_DESKTOP; } catch { return false; } })());
  ok('opts.override wins outright', resolveDevice({ env: e, override: 'phone', search: '?tier=desktop' }).tier === TIER_PHONE);
  ok('readTierOverride returns null for nothing', readTierOverride('', null) === null);
  ok('readTierOverride is case-insensitive', readTierOverride('?tier=PHONE') === TIER_PHONE);

  const auto = resolveDevice({ env: env(FLEET[0].e) });
  ok('no override -> detection, not derated', auto.tier === TIER_PHONE && auto.overridden === false && auto.derated === false);
  ok('resolveDevice reports touch', auto.touch === true);
  ok('describeDevice produces one line', typeof describeDevice(auto) === 'string' && !describeDevice(auto).includes('\n'), describeDevice(auto));

  const derated = resolveDevice({ env: env({ touchPoints: 5, pointer: 'coarse', mouse: false, width: 800, height: 1280, gl: GL_OLD_MOBILE }) });
  ok('a derated device reports both tiers', derated.tier === TIER_TABLET && derated.budgetTier === TIER_PHONE && derated.derated === true);
  ok('a derated device gets the smaller budgets', derated.budgets.tier === TIER_PHONE);
}

// ===========================================================================
console.log('\nsignals survive a hostile environment (§1.6: nothing throws)');
// ===========================================================================
{
  const s = readSignals({ navigator: {}, screen: {}, window: {}, matchMedia: undefined, gl: false });
  ok('empty environment still returns signals', s && typeof s.shortEdgeCss === 'number');
  ok('empty environment classifies as desktop', classifyTier(s) === TIER_DESKTOP);
  const t = readSignals({ navigator: {}, screen: {}, window: {}, matchMedia: () => { throw new Error('nope'); }, gl: false });
  ok('a throwing matchMedia does not throw', t.pointerCoarse === false);
  ok('probeWebGL with no canvas returns null', probeWebGL(() => null) === null);
  ok('probeWebGL with a contextless canvas returns null', probeWebGL(() => ({ getContext: () => null })) === null);
  ok('probeWebGL with a throwing canvas returns null', probeWebGL(() => { throw new Error('no'); }) === null);
  ok('gl: false skips the probe entirely', readSignals({ navigator: {}, screen: {}, window: {}, gl: false }).gl === null);
}

// ===========================================================================
console.log('\nphone budgets — the numbers everything else must fit');
// ===========================================================================
{
  const p = BUDGETS[TIER_PHONE];

  ok('heap target survives iOS Safari', PHONE_HEAP_TARGET_MB <= 200, `${PHONE_HEAP_TARGET_MB} MB target, ${PHONE_HEAP_HARD_MB} MB hard`);
  ok('heap target is a real cut from the desktop baseline', PHONE_HEAP_TARGET_MB < BASELINE.heapMB * 0.5, `${PHONE_HEAP_TARGET_MB} < ${(BASELINE.heapMB * 0.5).toFixed(1)}`);
  ok('the hard ceiling is under the bottom of the kill band', PHONE_HEAP_HARD_MB < 200);
  ok('target is under the hard ceiling', PHONE_HEAP_TARGET_MB < PHONE_HEAP_HARD_MB);

  ok('DEM cap is half of desktop', PHONE_DEM_CAP_BYTES === 48 * 1024 * 1024 && PHONE_DEM_CAP_BYTES * 2 === BASELINE.demCapBytes, '48 MiB of 96');
  ok('DEM cap is below the desktop RESIDENT measurement', PHONE_DEM_CAP_BYTES < BASELINE.demResidentBytes, `48.0 < ${(BASELINE.demResidentBytes / 1048576).toFixed(1)} MiB`);

  // The pinned base cannot be evicted (§2.4 rule 2), so it is a floor the cap
  // must clear with room for both paged layers.
  const pinned = Z11_PINNED_TILES * TILE_BYTES;
  let planned = pinned;
  for (const z of Object.keys(PHONE_DEM_PAGING_POLICY)) planned += PHONE_DEM_PAGING_POLICY[z].budgetTiles * TILE_BYTES;
  ok('phone DEM policy fits inside the phone cap', planned <= PHONE_DEM_CAP_BYTES, `${(planned / 1048576).toFixed(2)} <= ${(PHONE_DEM_CAP_BYTES / 1048576).toFixed(0)} MiB`);
  ok('the pinned z=11 base still fits', pinned < PHONE_DEM_CAP_BYTES, `${(pinned / 1048576).toFixed(2)} MiB pinned`);
  ok('both paged layers survive the cut', PHONE_DEM_PAGING_POLICY[13].budgetTiles > 0 && PHONE_DEM_PAGING_POLICY[14].budgetTiles > 0);

  // §2.4: a layer's tile budget must exceed the area of its own paging disc, or
  // the pager thrashes at the radius instead of at the lead edge.
  const discTiles = (radiusM, mPerPx) => (Math.PI * radiusM * radiusM) / Math.pow(256 * mPerPx, 2);
  const d13 = discTiles(PHONE_DEM_PAGING_POLICY[13].radiusM, 12.95);
  const d14 = discTiles(PHONE_DEM_PAGING_POLICY[14].radiusM, 6.47);
  ok('z=13 budget covers its own disc', PHONE_DEM_PAGING_POLICY[13].budgetTiles >= d13, `${PHONE_DEM_PAGING_POLICY[13].budgetTiles} >= ${d13.toFixed(1)}`);
  ok('z=14 budget covers its own disc', PHONE_DEM_PAGING_POLICY[14].budgetTiles >= d14, `${PHONE_DEM_PAGING_POLICY[14].budgetTiles} >= ${d14.toFixed(1)}`);

  ok('triangle budget is at least a 3.5x cut from the desktop draw', PHONE_MAX_TRIANGLES < BASELINE.triangles / 3.5, `${PHONE_MAX_TRIANGLES} < ${Math.round(BASELINE.triangles / 3.5)}`);

  // The per-subsystem shares must actually add up to the global ceiling, or the
  // global ceiling is decoration: every agent hits its own share and the sim is
  // still over. Measured decomposition is in device.js next to PHONE_SHARES.
  const MEASURED = {
    terrain: { triangles: 330284, drawCalls: 37 },
    landmarks: { triangles: 98126, drawCalls: 84 },
    airports: { triangles: 45578, drawCalls: 10 },
    aircraft: { triangles: 27827, drawCalls: 29 },
    sky: { triangles: 976, drawCalls: 9 },
  };
  const sum = (k) => Object.values(p.shares).reduce((a, s) => a + s[k], 0);
  ok('subsystem triangle shares sum to the triangle budget', sum('triangles') <= PHONE_MAX_TRIANGLES, `${sum('triangles')} <= ${PHONE_MAX_TRIANGLES}`);
  ok('subsystem draw-call shares sum to the draw-call budget', sum('drawCalls') <= PHONE_MAX_DRAW_CALLS, `${sum('drawCalls')} <= ${PHONE_MAX_DRAW_CALLS}`);
  ok('every measured group has a share', Object.keys(MEASURED).every((k) => p.shares[k]), Object.keys(p.shares).join(', '));
  // Terrain is the one share this agent owns outright, and lodQuality 0.40 has
  // to have already brought it inside — otherwise the budget is not reachable
  // by anybody, because nothing else can make terrain cheaper.
  ok('terrain is within 12% of its share at lodQuality 0.40', MEASURED.terrain.triangles <= p.shares.terrain.triangles * 1.12, `${MEASURED.terrain.triangles} vs ${p.shares.terrain.triangles}`);
  ok('terrain draw calls are already inside their share', MEASURED.terrain.drawCalls <= p.shares.terrain.drawCalls, `${MEASURED.terrain.drawCalls} <= ${p.shares.terrain.drawCalls}`);
  // And the shares must be a genuine ask of the groups that are over.
  for (const k of ['landmarks', 'aircraft']) {
    ok(`${k} share is below what it measures today`, p.shares[k].drawCalls < MEASURED[k].drawCalls, `${p.shares[k].drawCalls} < ${MEASURED[k].drawCalls}`);
  }
  ok('draw-call budget is well under desktop', PHONE_MAX_DRAW_CALLS < BASELINE.drawCalls / 3, `${PHONE_MAX_DRAW_CALLS} < ${Math.round(BASELINE.drawCalls / 3)}`);
  ok('shader-program budget is under the desktop count', PHONE_MAX_SHADER_PROGRAMS < BASELINE.programs, `${PHONE_MAX_SHADER_PROGRAMS} < ${BASELINE.programs}`);

  // The triangle budget has to be reachable with the LOD quality it ships with:
  // node count scales as lodQuality^2 and every node is TRIS_PER_NODE = 8704.
  const TRIS_PER_NODE = 64 * 64 * 2 + 64 * 4 * 2;
  const desktopNodesDrawn = BASELINE.triangles / TRIS_PER_NODE;
  const phoneNodes = desktopNodesDrawn * PHONE_TERRAIN_LOD_QUALITY * PHONE_TERRAIN_LOD_QUALITY;
  const phoneTerrainTris = phoneNodes * TRIS_PER_NODE;
  ok('terrain alone fits inside the triangle budget at this lodQuality', phoneTerrainTris < PHONE_MAX_TRIANGLES, `${Math.round(phoneTerrainTris)} of ${PHONE_MAX_TRIANGLES}`);
  ok('and leaves room for the city, runways and aeroplane', PHONE_MAX_TRIANGLES - phoneTerrainTris > 50000, `${Math.round(PHONE_MAX_TRIANGLES - phoneTerrainTris)} spare`);
  ok('lodQuality is above terrain.js’s own floor of 0.25', PHONE_TERRAIN_LOD_QUALITY > 0.25, String(PHONE_TERRAIN_LOD_QUALITY));

  // THE ONE THAT IS NOT ALLOWED TO SHRINK. Mount Rainier is 84.1 km away.
  ok('view radius still reaches Mount Rainier', PHONE_TERRAIN_VIEW_RADIUS_M >= 85000, `${PHONE_TERRAIN_VIEW_RADIUS_M} m`);
  for (const t of TIERS) ok(`${t}: view radius unchanged at 90 km`, BUDGETS[t].terrainViewRadiusM === 90000);

  ok('pixel ratio is clamped well below a phone’s native 3', PHONE_PIXEL_RATIO_MAX <= 1.5, String(PHONE_PIXEL_RATIO_MAX));
  ok('pixel ratio is not so low the HUD crawls', PHONE_PIXEL_RATIO_MAX >= 1.25);
  ok('drawing-buffer ceiling is set', PHONE_MAX_DRAWING_BUFFER_PX <= 1.5e6, `${PHONE_MAX_DRAWING_BUFFER_PX} px`);
  ok('MSAA is off on the phone tier', p.antialias === false);

  ok('shadows are off on the phone tier', PHONE_SHADOW_QUALITY === 'off');
  ok('shadow tier is a name shadows.js knows', ['off', 'low', 'medium', 'high'].includes(PHONE_SHADOW_QUALITY));

  ok('the minor building tier is not built on a phone', p.buildings.minorCutoffM === 0);
  ok('the tall tier keeps no cutoff (the skyline from Rainier)', p.buildings.tallCutoffM === Infinity);
  ok('the major cutoff is the one-phone-pixel distance for a 22 m building', Math.abs(p.buildings.majorCutoffM - 8000) < 1, `${p.buildings.majorCutoffM} m vs 8196 m derived`);
  ok('phone builds tall + major only', PHONE_BUILDING_MAX_COUNT === 295 + 6429, `${PHONE_BUILDING_MAX_COUNT} of ${BASELINE.buildings}`);
  ok('that is a real cut in footprints', PHONE_BUILDING_MAX_COUNT < BASELINE.buildings * 0.35);

  ok('logarithmic depth buffer is mandatory on every tier', TIERS.every((t) => BUDGETS[t].logarithmicDepthBuffer === true));
  ok('the phone targets 30 fps, and the budget matches', p.targetFps === 30 && Math.abs(p.frameBudgetMs - 1000 / 30) < 1e-9);
}

// ===========================================================================
console.log('\nbudget sets are complete, monotone and immutable');
// ===========================================================================
{
  const NUMERIC = [
    'heapTargetMB', 'heapHardMB', 'demCapBytes', 'maxTriangles', 'maxDrawCalls',
    'maxShaderPrograms', 'pixelRatioMax', 'maxDrawingBufferPx', 'terrainLodQuality',
  ];
  const SHADOW_RANK = { off: 0, low: 1, medium: 2, high: 3 };

  for (const t of TIERS) {
    const b = BUDGETS[t];
    ok(`${t}: budget exists and names itself`, b && b.tier === t);
    for (const k of NUMERIC) ok(`${t}.${k} is a positive number`, typeof b[k] === 'number' && b[k] > 0, String(b[k]));
    ok(`${t}: buildings block is complete`, b.buildings && typeof b.buildings.maxCount === 'number' && typeof b.buildings.majorCutoffM === 'number' && typeof b.buildings.minorCutoffM === 'number');
    ok(`${t}: DEM policy covers z=13 and z=14`, b.demPagingPolicy[13] && b.demPagingPolicy[14]);
    let planned = Z11_PINNED_TILES * TILE_BYTES;
    for (const z of Object.keys(b.demPagingPolicy)) planned += b.demPagingPolicy[z].budgetTiles * TILE_BYTES;
    ok(`${t}: DEM policy fits its own cap`, planned <= b.demCapBytes, `${(planned / 1048576).toFixed(2)} <= ${(b.demCapBytes / 1048576).toFixed(0)} MiB`);
  }

  for (let i = 1; i < TIERS.length; i++) {
    const lo = BUDGETS[TIERS[i - 1]];
    const hi = BUDGETS[TIERS[i]];
    for (const k of NUMERIC) ok(`${TIERS[i - 1]}.${k} <= ${TIERS[i]}.${k}`, lo[k] <= hi[k], `${lo[k]} <= ${hi[k]}`);
    ok(`${TIERS[i - 1]} shadows <= ${TIERS[i]} shadows`, SHADOW_RANK[lo.shadowQuality] <= SHADOW_RANK[hi.shadowQuality], `${lo.shadowQuality} <= ${hi.shadowQuality}`);
    ok(`${TIERS[i - 1]} builds no more buildings than ${TIERS[i]}`, lo.buildings.maxCount <= hi.buildings.maxCount);
    ok(`${TIERS[i - 1]} draws buildings no further than ${TIERS[i]}`, lo.buildings.majorCutoffM <= hi.buildings.majorCutoffM && lo.buildings.minorCutoffM <= hi.buildings.minorCutoffM);
  }

  // THE DESKTOP TIER MUST REPRODUCE TODAY'S BEHAVIOUR EXACTLY. Every measured
  // number in MODULES.md was taken with these settings, and introducing a tier
  // system is not allowed to move any of them.
  const d = BUDGETS[TIER_DESKTOP];
  ok('desktop lodQuality is still 1 (the swept value)', d.terrainLodQuality === 1);
  ok('desktop shadows are still high', d.shadowQuality === 'high');
  ok('desktop DPR clamp is still 2', d.pixelRatioMax === 2);
  ok('desktop has no drawing-buffer ceiling', d.maxDrawingBufferPx === Infinity);
  ok('desktop MSAA is still on', d.antialias === true);
  ok('desktop DEM cap is still 96 MiB', d.demCapBytes === BASELINE.demCapBytes);
  ok('desktop building cutoffs are unchanged', d.buildings.majorCutoffM === 25000 && d.buildings.minorCutoffM === 6000 && d.buildings.maxCount === BASELINE.buildings);
  ok('desktop ceilings sit above the measured baseline', d.maxTriangles > BASELINE.triangles && d.maxDrawCalls > BASELINE.drawCalls && d.maxShaderPrograms > BASELINE.programs && d.heapTargetMB > BASELINE.heapMB);

  ok('budgetsFor(unknown) falls back to desktop, it does not throw', budgetsFor('toaster') === BUDGETS[TIER_DESKTOP]);
  ok('budgetsFor(undefined) falls back to desktop', budgetsFor(undefined) === BUDGETS[TIER_DESKTOP]);

  // A shared frozen object cannot be mutated by one consumer for everyone else.
  const before = BUDGETS[TIER_PHONE].maxTriangles;
  try { BUDGETS[TIER_PHONE].maxTriangles = 9e9; } catch { /* strict mode throws */ }
  try { BUDGETS[TIER_PHONE].buildings.minorCutoffM = 9e9; } catch { /* strict */ }
  ok('budgets are frozen', BUDGETS[TIER_PHONE].maxTriangles === before && BUDGETS[TIER_PHONE].buildings.minorCutoffM === 0);
}

// ===========================================================================
console.log('\neffectivePixelRatio — the framerate cliff');
// ===========================================================================
{
  const P = BUDGETS[TIER_PHONE];
  const T = BUDGETS[TIER_TABLET];
  const D = BUDGETS[TIER_DESKTOP];

  const iPhone = effectivePixelRatio(P, 3, 393, 852);
  ok('iPhone 15 Pro at DPR 3 -> 1.5', iPhone === 1.5, `${iPhone}`);
  ok('...which is 4x fewer pixels than native', Math.abs((3 / iPhone) ** 2 - 4) < 1e-9, `${Math.round(393 * iPhone) * Math.round(852 * iPhone)} px vs ${393 * 3 * 852 * 3}`);
  ok('the phone buffer stays under the ceiling', 393 * iPhone * 852 * iPhone <= P.maxDrawingBufferPx, `${Math.round(393 * iPhone * 852 * iPhone)} <= ${P.maxDrawingBufferPx}`);

  const big = effectivePixelRatio(P, 3, 1000, 1300);
  ok('a large phone is bound by the PIXEL ceiling, not the ratio', big < P.pixelRatioMax && 1000 * big * 1300 * big <= P.maxDrawingBufferPx, `${big}`);

  const ipad = effectivePixelRatio(T, 2, 1024, 1366);
  ok('iPad Pro 12.9 at DPR 2 is capped by the pixel ceiling', ipad < 2 && 1024 * ipad * 1366 * ipad <= T.maxDrawingBufferPx, `${ipad}`);

  ok('a desktop at DPR 1 is untouched', effectivePixelRatio(D, 1, 1920, 1080) === 1);
  ok('a retina desktop still clamps at 2', effectivePixelRatio(D, 3, 1440, 900) === 2);
  ok('a desktop is never derated by area', effectivePixelRatio(D, 2, 3840, 2160) === 2);

  ok('never returns more than the device has', effectivePixelRatio(P, 1, 393, 852) <= 1);
  ok('never returns less than 0.5', effectivePixelRatio(P, 3, 6000, 6000) >= 0.5);
  ok('quantised to a 0.05 step so a resize cannot thrash the buffer', [P, T, D].every((b) => [ [3, 393, 852], [2.625, 412, 915], [3, 430, 932], [2, 1024, 1366], [1, 1920, 1080] ].every(([d, w, h]) => Math.abs(effectivePixelRatio(b, d, w, h) * 20 - Math.round(effectivePixelRatio(b, d, w, h) * 20)) < 1e-9)));
  ok('degenerate viewport does not divide by zero', Number.isFinite(effectivePixelRatio(P, 3, 0, 0)));
  ok('missing budgets fall back to desktop behaviour', effectivePixelRatio(null, 3, 1440, 900) === 2);
  ok('a non-finite dpr is treated as 1', effectivePixelRatio(D, NaN, 1440, 900) === 1);
}

// ===========================================================================
const total = failures === 0;
console.log(`\n${total ? 'device: all checks passed' : `device: ${failures} FAILURE(S)`}\n`);
process.exit(total ? 0 : 1);
