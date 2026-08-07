/**
 * shadows.js — cascaded shadow maps for a 144 km world.
 *
 *   createShadows(scene, renderer, opts) -> handle
 *
 * Owned by world/sky.js, which constructs it (sky.js owns every light, §1.7,
 * and a shadow-casting cascade IS a light) and drives it from the scene's
 * onBeforeRender. Nothing else should import this file.
 *
 * ---------------------------------------------------------------------------
 * WHY CASCADES, AND WHY THIS SHAPE
 * ---------------------------------------------------------------------------
 *
 * One directional light in three has one shadow map. The camera here sees from
 * 0.35 m (the instrument panel) to 300 km (Mount Rainier, and the sky behind
 * it). A single 2048 map stretched over even 4 km of that gives 2 m texels —
 * the aeroplane's shadow on the runway would be four blocks wide, which is
 * worse than no shadow at all. So the view frustum is sliced by depth and each
 * slice gets its own map, sized to it:
 *
 *   cascade 0    0.35 –   70 m     8 cm texels: the aircraft and its drop shadow
 *   cascade 1      70 –  300 m    34 cm texels: hangars, the buildings you taxi past
 *   cascade 2     300 – 1200 m     1.4 m texels: the skyline from a downwind leg
 *   cascade 3    1200 - 12000 m   14 m texels: ridge lines, and Rainier's own shadow
 *
 * Past 4 km there is no shadow map and the sun term falls back to plain N·L.
 * That is a deliberate stop, not an omission: at 4 km one 2048 texel is already
 * 4.6 m, wider than the buildings it would be shadowing, and the fog budget
 * (§2.8) has eaten a good part of the contrast by then anyway.
 *
 * The four splits are 'high'. 'medium' drops to three and 'low' to two — see
 * TIERS. Measured cost of the whole system is +0.6 to +1.1 ms of serialised
 * frame time; the tier exists for hardware slower than the machine it was
 * measured on, not because the top tier was borderline.
 *
 * ---------------------------------------------------------------------------
 * THE FOUR THINGS THAT MAKE THIS NOT SHIMMER
 * ---------------------------------------------------------------------------
 *
 *  1. THE BOX IS A SPHERE. Each cascade's ortho box is sized from the BOUNDING
 *     SPHERE of its frustum slice, not from the slice's own corners. A sphere
 *     is rotation-invariant, so banking the aeroplane cannot change the box
 *     size. Fitting the corners directly (which is what three's own CSM addon
 *     does) makes the box breathe by up to 40% through a roll, and every texel
 *     in the map moves when it does.
 *
 *  2. THE RADIUS IS QUANTISED. The chase camera's fov is a continuous function
 *     of airspeed (cameras.js: 58° + 7°·speed), so the slice sphere would
 *     otherwise change size every single frame. The radius is rounded up to a
 *     step of 2^(1/8) — 9% granularity — so it holds still through an
 *     acceleration and jumps a handful of times over a flight.
 *
 *  3. THE CENTRE IS SNAPPED TO THE TEXEL GRID, in light space, using a basis
 *     built from the sun direction alone. Without this the map slides by a
 *     fraction of a texel each frame and every shadow edge boils. This is the
 *     single most important line in the file.
 *
 *  4. THE SPLITS ARE FIXED IN METRES, not derived from camera.near/far. The far
 *     plane is 300 km and the near plane changes with the view mode; a
 *     practical/logarithmic split off those numbers would move the cascade
 *     boundaries whenever the camera changed, and a moving boundary is visible.
 *
 * ---------------------------------------------------------------------------
 * STAGGERING — WHY THE FAR CASCADES DO NOT REDRAW EVERY FRAME
 * ---------------------------------------------------------------------------
 *
 * The cost of this system is not fill rate. Measured: shrinking every map from
 * 2048 to 256 changed the frame time by nothing at all, and stripping the
 * logarithmic-depth `gl_FragDepth` write out of the shadow pass — which on a
 * tile-based GPU should have restored early-Z — also changed nothing. What it
 * costs is DRAW CALLS: four cascades over ~1,900 meshes is ~820 extra calls per
 * frame on top of a 407-call scene.
 *
 * So cascades 2 and 3 render every third frame, on opposite phases, and a
 * cascade that does not render is also not refitted. That is safe, and the
 * reason is worth stating because it is not obvious:
 *
 *   A stale cascade is not WRONG, it is INCOMPLETE. three skips
 *   `shadow.updateMatrices()` for a light it skips rendering, so the map and
 *   the matrix that samples it stay a matched pair. The map still describes a
 *   real region of the world correctly — it just describes where the camera
 *   was up to two frames ago. A point that has moved outside it samples
 *   outside [0,1] and `getShadow` returns 1.0, i.e. lit. Missing shadow, never
 *   misplaced shadow. Even a teleport is safe for the same reason.
 *
 * The one thing a stale map really does get wrong is a caster that MOVED, and
 * the only caster that moves is the aeroplane — which is why cascades 0 and 1
 * are never staggered.
 *
 * ---------------------------------------------------------------------------
 * HOW THE SHADOW REACHES THE MATERIALS
 * ---------------------------------------------------------------------------
 *
 * The cascade lights carry `intensity = 0`. They exist to own a shadow map and
 * nothing else: `sky.js#sunLight` stays the one and only source of sunlight, so
 * `sunLight.intensity` and `sunLight.color` keep the meaning MODULES.md § 2.8
 * gives them and the lens-flare / water-specular readers are unaffected.
 *
 * `ShaderChunk.lights_fragment_begin` is patched (once, globally) with a
 * variant that, for materials carrying `CSM_CASCADES`:
 *
 *   - computes ONE blended shadow factor from the cascade maps, and
 *   - multiplies it onto the FIRST NON-SHADOW-CASTING directional light,
 *     which is the sun, and
 *   - never calls RE_Direct for the cascade carriers themselves.
 *
 * Materials WITHOUT that define take a branch that is byte-identical to stock
 * three, so patching the chunk globally is safe for anything that never opts in.
 *
 * That the carriers come first is not luck: WebGLLights sorts its light array
 * with `shadowCastingAndTexturingLightsFirst` before it builds the uniforms, so
 * shadow-casting directional lights occupy indices 0…NUM_DIR_LIGHT_SHADOWS-1 in
 * BOTH `directionalLights[]` and `directionalShadowMap[]`. The sort is stable
 * (ES2019), so among the non-casters the order is the order sky.js adds them:
 * sun, then moon.
 *
 * ---------------------------------------------------------------------------
 * TERRAIN IS A SPECIAL CASE AND YOU CANNOT SKIP IT
 * ---------------------------------------------------------------------------
 *
 * terrain.js morphs every vertex in the vertex shader — CDLOD collapses a
 * node's lattice onto its parent's as it recedes, and the skirt vertices are
 * dropped by `aMorph.z`. three's shadow pass draws casters with a
 * MeshDepthMaterial, which knows nothing about that, so the shadow map would be
 * cast by geometry that is not the geometry on screen: metres of error on a
 * ridge and a skirt-deep collar of shadow around every node.
 *
 * Worse, the morph factor is a function of `cameraPosition`, and in the shadow
 * pass `cameraPosition` is the LIGHT's position. Even a faithful copy of the
 * morph would collapse the wrong nodes.
 *
 * So terrain casters get a `customDepthMaterial` carrying the same morph — and
 * it is not a COPY of terrain.js's GLSL. It is terrain.js's GLSL, lifted from
 * terrain.js's own `onBeforeCompile` at run time by calling it on a probe
 * shader made of the three `#include` markers it patches, and slicing the
 * result back out (`extractTerrainMorph`). The only edit is the substitution
 * the shadow pass requires: `cameraPosition`, which three binds to the LIGHT in
 * a shadow pass, becomes `uEyePos`, which this module feeds the view camera.
 * Every uniform comes across by reference, so an LOD change moves the caster
 * and the drawn surface in the same frame.
 *
 * A hand copy was the first version of this and it was WRONG WITHIN THE HOUR —
 * the terrain agent rewrote the morph from a cell-size window to a per-node
 * error-driven one while this file was being written, and the copy silently
 * became a different surface. Extraction cannot drift. If the markers ever stop
 * matching, `extractTerrainMorph` returns null, terrain simply stops casting,
 * and the console says so: a missing shadow, never a wrong one.
 */

import * as THREE from 'three';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Hard ceiling on cascades. The GLSL declares `uniform vec4 uCsmSplits[4]`
 * unconditionally so that changing the cascade count never forces a shader
 * recompile — only the uniform values move.
 */
const MAX_CASCADES = 4;

/**
 * The three chunk names terrain.js's vertex injection replaces. These are the
 * contract between the two modules — not the GLSL between them, which belongs
 * entirely to terrain.js and is allowed to change without telling anyone.
 */
const TERRAIN_ANCHORS = ['common', 'beginnormal_vertex', 'begin_vertex'];

/** Sentinels the probe uses to find the injected text again. */
const MARK = TERRAIN_ANCHORS.map((_, i) => `/*@@KSHADOW${i}@@*/`);
const PROBE_VERTEX =
  `${MARK[0]}\n#include <common>\n` +
  `${MARK[1]}\n#include <beginnormal_vertex>\n` +
  `${MARK[2]}\n#include <begin_vertex>\n` +
  `/*@@KSHADOW3@@*/\n`;
/**
 * The fragment side is never used, but terrain's onBeforeCompile chains
 * `.replace()` over it and a missing marker is simply a no-op, so it costs
 * nothing to hand it something it recognises.
 */
const PROBE_FRAGMENT =
  '#include <common>\n#include <map_fragment>\n#include <roughnessmap_fragment>\n' +
  '#include <normal_fragment_maps>\n';

/**
 * Lift terrain.js's vertex-morph injection out of its own material.
 *
 * Calls the surface material's `onBeforeCompile` on a probe made of the three
 * include markers it patches, then slices the injected text back out. Pure —
 * the probe is a throwaway object and the real material is untouched.
 *
 * @param {THREE.Material} surfaceMat  terrain.js's 'terrain-surface' material
 * @param {THREE.WebGLRenderer} [renderer]
 * @returns {{common: string, normal: string, begin: string, uniforms: Object}|null}
 *          null when the shape has changed and the morph could not be found —
 *          the caller must then stop terrain casting rather than guess.
 */
function extractTerrainMorph(surfaceMat, renderer) {
  if (!surfaceMat || typeof surfaceMat.onBeforeCompile !== 'function') return null;
  const probe = {
    vertexShader: PROBE_VERTEX,
    fragmentShader: PROBE_FRAGMENT,
    uniforms: {},
    defines: {},
  };
  try {
    surfaceMat.onBeforeCompile(probe, renderer);
  } catch (e) {
    return null;
  }
  const v = probe.vertexShader;
  const at = [
    v.indexOf(MARK[0]),
    v.indexOf(MARK[1]),
    v.indexOf(MARK[2]),
    v.indexOf('/*@@KSHADOW3@@*/'),
  ];
  for (let i = 0; i < 4; i++) if (at[i] < 0 || (i > 0 && at[i] < at[i - 1])) return null;
  const cut = (i) => v.slice(at[i] + MARK[0].length, at[i + 1]);
  const out = { common: cut(0), normal: cut(1), begin: cut(2), uniforms: probe.uniforms };

  // Sanity: the morph must actually be in there, and it must write `transformed`
  // (three's begin_vertex declares it, and we have replaced that include).
  if (!/aMorph/.test(out.common)) return null;
  if (!/\btransformed\b/.test(out.begin)) return null;
  return out;
}

/**
 * Quality tiers. `splits` are the FAR distance of each cascade in metres along
 * the view axis; the near of cascade i is the far of cascade i-1.
 *
 * Measured cost is in the return value of `getStats()` and in the report — the
 * tiers exist because "ship a quality tier rather than something that stutters"
 * is cheaper than discovering on someone else's GPU that 3x2048 was too much.
 */
const TIERS = {
  off: { cascades: 0, sizes: [], splits: [], period: [], phase: [], radius: 0, terrainCasts: false },
  low: {
    cascades: 2,
    sizes: [1024, 1024],
    splits: [70, 900],
    period: [1, 1],
    phase: [0, 0],
    radius: 1.2,
    terrainCasts: false,
  },
  medium: {
    cascades: 3,
    sizes: [2048, 2048, 1024],
    splits: [70, 400, 2500],
    period: [1, 1, 2],
    phase: [0, 0, 0],
    radius: 1.8,
    terrainCasts: true,
  },
  high: {
    cascades: 4,
    sizes: [2048, 2048, 2048, 2048],
    // The last one reaches 12 km on purpose. Mount Rainier is 4,392 m tall and
    // at a 10 degree sun it lays a 25 km shadow across the Cascade front; a
    // 4 km stop threw that away, and it is the single biggest thing shadows do
    // for a world this size. 14 m texels are coarse for a building and exactly
    // right for a ridge line.
    splits: [70, 300, 1200, 12000],
    // See "STAGGERING" in the header. Phases 0 and 1 so cascades 2 and 3 never
    // land on the same frame — that is what flattens the worst frame, not just
    // the average one.
    period: [1, 1, 3, 3],
    phase: [0, 0, 0, 1],
    radius: 2.2,
    terrainCasts: true,
  },
};

/** Fraction of a cascade's depth spent cross-fading into the next one. */
const BLEND_FRACTION = 0.12;

/**
 * BIAS. Both terms are proportional to the cascade's own texel size, because
 * that is what the error they exist to hide is proportional to: a texel of the
 * shadow map covers a patch of receiver, and the depth across that patch varies
 * by roughly `texel * tan(slope)`.
 *
 * The CAPS are what stop the far cascade from destroying contact shadows.
 * Cascade 3's texel is ~4.6 m; 1.5 texels of normal offset there would be 7 m,
 * and a 7 m offset erases the shadow of anything shorter than 7/sin(sun) — at
 * a 14 degree sun that is a 29 m building, i.e. most of the skyline. Capping
 * the offset trades a little acne on steep distant ground, which is lit at a
 * grazing angle and reads as texture, for building shadows that exist.
 */
const NORMAL_BIAS_TEXELS = 1.25;
const NORMAL_BIAS_MAX_M = 1.2;
/**
 * Constant depth bias, in METRES of light-space depth, converted per cascade.
 *
 * Only the NORMAL offset is capped hard. The depth bias is allowed to grow with
 * the texel all the way out, because what it costs is peter-panning ALONG THE
 * LIGHT, and in the outermost cascade — 12 km of view depth, 14 m texels — a
 * 16 m slip is a fraction of a pixel. Capping it there instead would buy a
 * clean contact nobody can see at the price of acne all over Mount Rainier.
 */
const DEPTH_BIAS_TEXELS = 1.2;
const DEPTH_BIAS_MIN_M = 0.2;
const DEPTH_BIAS_MAX_M = 20;

/** Sun elevation, degrees, over which the shadow fades in from nothing. */
const SUN_FADE_LO = 1.5;
const SUN_FADE_HI = 7.0;

/** Radius quantisation: 8 steps per octave => at most 9.05% of waste. */
const RADIUS_QUANT = Math.pow(2, 1 / 8);

// ---------------------------------------------------------------------------
// The global shader patch
// ---------------------------------------------------------------------------

let shaderPatched = false;

/**
 * Replace three's `lights_fragment_begin` with a CSM-aware variant and add the
 * split uniform to `lights_pars_begin`.
 *
 * Idempotent, and a no-op for every material that does not define
 * `CSM_CASCADES` — the `#else` arm below is a verbatim copy of the stock
 * directional-light block, so a material that never opts in compiles the same
 * program it always did.
 */
function patchShaderChunks() {
  if (shaderPatched) return;
  shaderPatched = true;

  const stock = THREE.ShaderChunk.lights_fragment_begin;

  // The stock directional block, lifted so the non-CSM path stays exactly it.
  const DIR_START = '#if ( NUM_DIR_LIGHTS > 0 ) && defined( RE_Direct )';
  const DIR_END = '#if ( NUM_RECT_AREA_LIGHTS > 0 ) && defined( RE_Direct_RectArea )';
  const a = stock.indexOf(DIR_START);
  const b = stock.indexOf(DIR_END);
  if (a < 0 || b < 0 || b < a) {
    console.warn(
      '[shadows] three.js lights_fragment_begin has changed shape; ' +
        'cascaded shadows are DISABLED rather than guessed at.',
    );
    shaderPatched = 'failed';
    return;
  }
  const stockDirBlock = stock.slice(a, b);

  const csmDirBlock = /* glsl */ `
#if defined( CSM_CASCADES )

#if ( NUM_DIR_LIGHTS > 0 ) && defined( RE_Direct )

	DirectionalLight directionalLight;

	float csmShadow = 1.0;

	#if defined( USE_SHADOWMAP ) && NUM_DIR_LIGHT_SHADOWS > 0

		DirectionalLightShadow directionalLightShadow;

		if ( receiveShadow ) {

			float csmZ = vViewPosition.z;
			float csmAcc = 0.0;
			float csmSum = 0.0;

			#pragma unroll_loop_start
			for ( int i = 0; i < NUM_DIR_LIGHT_SHADOWS; i ++ ) {

				#if ( UNROLLED_LOOP_INDEX < ${MAX_CASCADES} )
				{
					// x = fade-in origin, y = 1/fade-in width,
					// z = fade-out origin, w = 1/fade-out width. All in metres
					// of view depth, so the weights of two neighbouring
					// cascades sum to exactly 1 across the overlap.
					vec4 csmSpan = uCsmSplits[ i ];
					float csmW = clamp( ( csmZ - csmSpan.x ) * csmSpan.y, 0.0, 1.0 )
					           * ( 1.0 - clamp( ( csmZ - csmSpan.z ) * csmSpan.w, 0.0, 1.0 ) );
					if ( csmW > 0.0 ) {
						directionalLightShadow = directionalLightShadows[ i ];
						csmAcc += csmW * getShadow( directionalShadowMap[ i ], directionalLightShadow.shadowMapSize, directionalLightShadow.shadowIntensity, directionalLightShadow.shadowBias, directionalLightShadow.shadowRadius, vDirectionalShadowCoord[ i ] );
						csmSum += csmW;
					}
				}
				#endif

			}
			#pragma unroll_loop_end

			// Whatever weight no cascade claimed is lit. Past the last cascade
			// that is all of it, so the shadow term fades out with distance
			// instead of ending at a line.
			csmShadow = csmAcc + ( 1.0 - min( csmSum, 1.0 ) );

		}

	#endif

	// The cascade carriers (indices 0 .. NUM_DIR_LIGHT_SHADOWS-1) hold a shadow
	// map and nothing else — they are never shaded. Real directional lights
	// start at NUM_DIR_LIGHT_SHADOWS, and the first of them is sky.js's sun.
	#if ( NUM_DIR_LIGHTS > NUM_DIR_LIGHT_SHADOWS )

		#pragma unroll_loop_start
		for ( int i = NUM_DIR_LIGHT_SHADOWS; i < NUM_DIR_LIGHTS; i ++ ) {

			directionalLight = directionalLights[ i ];

			getDirectionalLightInfo( directionalLight, directLight );

			#if ( UNROLLED_LOOP_INDEX == NUM_DIR_LIGHT_SHADOWS )
			directLight.color *= csmShadow;
			#endif

			RE_Direct( directLight, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, reflectedLight );

		}
		#pragma unroll_loop_end

	#endif

#endif

#else

${stockDirBlock}
#endif

`;

  THREE.ShaderChunk.lights_fragment_begin =
    stock.slice(0, a) + csmDirBlock + stock.slice(b);

  THREE.ShaderChunk.lights_pars_begin =
    /* glsl */ `
#if defined( CSM_CASCADES )
uniform vec4 uCsmSplits[ ${MAX_CASCADES} ];
#endif
` + THREE.ShaderChunk.lights_pars_begin;
}

// ---------------------------------------------------------------------------
// Frustum-slice bounding sphere
// ---------------------------------------------------------------------------

/**
 * Exact bounding sphere of a perspective frustum slice, centred on the view
 * axis. Standard construction; the harness re-derives it by brute force over
 * the eight corners and asserts every one of them is inside.
 *
 * @param {number} n slice near, metres along the view axis
 * @param {number} f slice far
 * @param {number} tanV tan(fovY/2)
 * @param {number} aspect width / height
 * @param {{z: number, r: number}} out
 */
function sliceSphere(n, f, tanV, aspect, out) {
  const k2 = tanV * tanV * (1 + aspect * aspect);
  if (k2 * (f + n) >= f - n) {
    // The sphere is pinned to the far plane's rim.
    out.z = -f;
    out.r = f * Math.sqrt(k2);
  } else {
    out.z = -0.5 * (f + n) * (1 + k2);
    out.r = 0.5 * Math.sqrt(
      (f - n) * (f - n) + 2 * (f * f + n * n) * k2 + (f + n) * (f + n) * k2 * k2,
    );
  }
  return out;
}

// ---------------------------------------------------------------------------

const _up = new THREE.Vector3(0, 1, 0);
const _upAlt = new THREE.Vector3(0, 0, 1);
const _zero = new THREE.Vector3();
const _basis = new THREE.Matrix4();
const _basisInv = new THREE.Matrix4();
const _centreView = new THREE.Vector3();
const _centreWorld = new THREE.Vector3();
const _centreLight = new THREE.Vector3();
const _sphere = { z: 0, r: 0 };

/**
 * @typedef {Object} ShadowOpts
 * @property {string}  [quality]        'off' | 'low' | 'medium' | 'high'. Default 'high'.
 * @property {THREE.Vector3} [sunDirection] Live reference to sky.js's sun vector.
 * @property {boolean} [aircraftReceives] Default true.
 * @property {number}  [softness]       Multiplier on the PCF radius. Default 1.
 */

/**
 * @param {THREE.Scene} scene
 * @param {THREE.WebGLRenderer} renderer
 * @param {ShadowOpts} [opts]
 */
export function createShadows(scene, renderer, opts = {}) {
  patchShaderChunks();

  const sunDirection = opts.sunDirection || new THREE.Vector3(0, 1, 0);
  const aircraftReceives = opts.aircraftReceives !== false;
  const softness = Number.isFinite(opts.softness) ? opts.softness : 1;

  let tierName = TIERS[opts.quality] ? opts.quality : 'high';
  if (shaderPatched === 'failed') tierName = 'off';
  let tier = TIERS[tierName];

  // -------------------------------------------------------------------------
  // Renderer state. Owned here because the cascade lights are the only shadow
  // casters in the scene.
  //
  // PCFShadowMap, not PCFSoftShadowMap: three r185 deprecated the latter and
  // logs a warning while silently substituting the former. In r185 the PCF path
  // is a hardware sampler2DShadow plus a five-tap Vogel disc jittered by an
  // interleaved-gradient noise on gl_FragCoord — soft edges whose width is
  // `shadow.radius` texels, which is what we want and what we set per cascade.
  // -------------------------------------------------------------------------
  if (renderer && renderer.shadowMap) {
    renderer.shadowMap.enabled = tier.cascades > 0;
    renderer.shadowMap.type = THREE.PCFShadowMap;
    renderer.shadowMap.autoUpdate = true;
  }

  /** @type {THREE.DirectionalLight[]} */
  const lights = [];
  /** Per-cascade fitting state, parallel to `lights`. */
  const cascades = [];

  /**
   * (fadeInOrigin, 1/fadeInWidth, fadeOutOrigin, 1/fadeOutWidth) per cascade,
   * in metres of view depth. Shared by reference with every set-up material.
   */
  const splitsUniform = {
    value: Array.from({ length: MAX_CASCADES }, () => new THREE.Vector4(1e9, 0, 1e9, 0)),
  };

  function buildLights() {
    for (let i = 0; i < tier.cascades; i++) {
      const light = new THREE.DirectionalLight(0xffffff, 0);
      light.name = `sky-shadow-cascade-${i}`;
      light.castShadow = true;
      light.shadow.mapSize.set(tier.sizes[i], tier.sizes[i]);
      light.shadow.camera.up.copy(_up);
      light.shadow.radius = tier.radius * softness;
      light.shadow.intensity = 0;
      // The cascade lights are placed by update(); until then keep them out of
      // the way of a frame that renders before the first update.
      light.position.set(0, 1000, 0);
      light.target.position.set(0, 0, 0);
      scene.add(light);
      scene.add(light.target);
      lights.push(light);
      cascades.push({
        near: i === 0 ? 0 : tier.splits[i - 1],
        far: tier.splits[i],
        size: tier.sizes[i],
        period: tier.period[i] || 1,
        phase: tier.phase[i] || 0,
        radius: 0,
        margin: 0,
        texel: 0,
        renders: 0,
      });
    }
  }

  function destroyLights() {
    for (const l of lights) {
      l.shadow.dispose();
      l.removeFromParent();
      l.target.removeFromParent();
    }
    lights.length = 0;
    cascades.length = 0;
    for (const v of splitsUniform.value) v.set(1e9, 0, 1e9, 0);
  }

  buildLights();

  // -------------------------------------------------------------------------
  // Material set-up
  // -------------------------------------------------------------------------

  /** @type {Set<THREE.Material>} every material we have added the define to. */
  const setUp = new Set();

  function setupMaterial(mat) {
    if (!mat || setUp.has(mat)) return;
    const lit =
      mat.isMeshStandardMaterial ||
      mat.isMeshPhysicalMaterial ||
      mat.isMeshPhongMaterial ||
      mat.isMeshLambertMaterial ||
      mat.isMeshToonMaterial;
    if (!lit) return;

    setUp.add(mat);
    mat.defines = mat.defines || {};
    mat.defines.CSM_CASCADES = MAX_CASCADES;

    // Compose rather than replace: terrain.js and the water surfaces already
    // own an onBeforeCompile, and overwriting it (which three's own CSM addon
    // does) would delete the entire procedural surface.
    const prev = mat.onBeforeCompile;
    mat.onBeforeCompile = function (shader, rendererRef) {
      if (prev) prev.call(this, shader, rendererRef);
      // MUST be unconditional: three throws when the program declares an active
      // uniform that the uniforms object has no entry for.
      shader.uniforms.uCsmSplits = splitsUniform;
    };
    mat.userData.__csmPrevOnBeforeCompile = prev || null;
    mat.needsUpdate = true;
  }

  function teardownMaterial(mat) {
    if (!setUp.has(mat)) return;
    setUp.delete(mat);
    if (mat.defines) delete mat.defines.CSM_CASCADES;
    mat.onBeforeCompile = mat.userData.__csmPrevOnBeforeCompile || function () {};
    delete mat.userData.__csmPrevOnBeforeCompile;
    mat.needsUpdate = true;
  }

  // -------------------------------------------------------------------------
  // Terrain depth material — see the header.
  // -------------------------------------------------------------------------

  const eyeUniform = { value: new THREE.Vector3() };
  /** @type {Map<THREE.Material, THREE.MeshDepthMaterial>} surface -> depth */
  const terrainDepth = new Map();

  let morphKey = 0;
  let warnedNoMorph = false;

  /**
   * The depth material for one terrain surface material, or `null` if the morph
   * could not be lifted — in which case the caller stops terrain casting.
   */
  function terrainDepthMaterial(surfaceMat) {
    if (terrainDepth.has(surfaceMat)) return terrainDepth.get(surfaceMat);

    const ex = extractTerrainMorph(surfaceMat, renderer);
    if (!ex) {
      terrainDepth.set(surfaceMat, null);
      if (!warnedNoMorph) {
        warnedNoMorph = true;
        console.warn(
          '[shadows] could not lift terrain.js’s vertex morph out of its material ' +
            '(the #include markers it patches have changed shape). Terrain will not cast ' +
            'shadows — a missing shadow is the only safe answer, because the default ' +
            'depth material would cast the UNMORPHED lattice.',
        );
      }
      return null;
    }

    // `cameraPosition` in a shadow pass is the LIGHT. The morph is a function
    // of where the VIEWER is, so it has to read a uniform this module owns.
    const common = ex.common.replace(/\bcameraPosition\b/g, 'uEyePos');
    const normal = ex.normal.replace(/\bcameraPosition\b/g, 'uEyePos');
    const begin = ex.begin.replace(/\bcameraPosition\b/g, 'uEyePos');

    const key = `ken-terrain-shadow-depth-${++morphKey}`;
    const d = new THREE.MeshDepthMaterial();
    d.name = 'terrain-shadow-depth';
    d.onBeforeCompile = (shader) => {
      // Every uniform terrain declared, by reference — so nothing here needs to
      // know what they are or when they change.
      Object.assign(shader.uniforms, ex.uniforms);
      shader.uniforms.uEyePos = eyeUniform;
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', `${common}\nuniform vec3 uEyePos;`)
        // depth_vert only pulls in <beginnormal_vertex> under USE_DISPLACEMENTMAP,
        // and terrain's begin block reads `objectNormal`, so the normal block is
        // spliced in immediately ahead of it.
        .replace('#include <begin_vertex>', `${normal}\n${begin}`);
    };
    d.customProgramCacheKey = () => key;
    terrainDepth.set(surfaceMat, d);
    return d;
  }

  // -------------------------------------------------------------------------
  // Tagging
  // -------------------------------------------------------------------------
  //
  // castShadow / receiveShadow live on objects other modules own, and terrain
  // creates and destroys ~600 of them as the LOD moves, so the flags cannot be
  // set once at boot. The traversal is cheap (measured: see getStats().tagMs)
  // and each object is only touched the first time it is seen.

  const NEVER = /^(sky-|terrain-sea$|terrain-lakes$)/;

  let tagged = 0;
  let tagVersion = 1;

  function tagObject(obj) {
    if (obj.userData.__csmTag === tagVersion) return;
    obj.userData.__csmTag = tagVersion;
    tagged++;

    if (!obj.isMesh) return;

    const name = obj.name || '';
    const mats = Array.isArray(obj.material) ? obj.material : [obj.material];

    // 1. Sky dome, cloud slabs, stars, sea, lakes: neither. The dome is inside
    //    out and 400 km across; the water surfaces carry sky.js's own
    //    reflection calibration and multiplying that by a shadow term is how
    //    you make the sea stop matching the sky it is reflecting.
    if (NEVER.test(name) || isUnderSky(obj)) {
      obj.castShadow = false;
      obj.receiveShadow = false;
      return;
    }

    // 2. Terrain surface nodes. They cast ONLY through the morph-aware depth
    //    material; if that could not be built they do not cast at all.
    if (name.startsWith('terrain-')) {
      obj.receiveShadow = true;
      const depth = tier.terrainCasts && mats[0] ? terrainDepthMaterial(mats[0]) : null;
      obj.customDepthMaterial = depth || undefined;
      obj.castShadow = !!depth;
      for (const m of mats) setupMaterial(m);
      return;
    }

    // 3. Everything else — the aeroplane, the runways, the landmarks, whatever
    //    the buildings agent adds. Cast and receive.
    obj.castShadow = true;
    obj.receiveShadow = isAircraft(obj) ? aircraftReceives : true;
    for (const m of mats) setupMaterial(m);
  }

  function isUnderSky(obj) {
    for (let p = obj.parent; p; p = p.parent) {
      if (p.name === 'sky') return true;
    }
    return false;
  }

  function isAircraft(obj) {
    for (let p = obj; p; p = p.parent) {
      if (p.name === 'aircraft') return true;
    }
    return false;
  }

  function untagAll() {
    scene.traverse((o) => {
      o.userData.__csmTag = 0;
      if (o.isMesh) {
        o.castShadow = false;
        o.customDepthMaterial = undefined;
      }
    });
    for (const m of Array.from(setUp)) teardownMaterial(m);
    for (const d of terrainDepth.values()) if (d) d.dispose();
    terrainDepth.clear();
  }

  // -------------------------------------------------------------------------
  // Per-frame fit
  // -------------------------------------------------------------------------

  let lastTagMs = 0;
  let lastFitMs = 0;
  let sunFade = 0;
  let enabled = true;
  let frames = 0;
  /** Rolling upper bound on how far the camera moves between updates, metres. */
  let camStep = 0;
  const _camPrev = new THREE.Vector3();
  const _eyeNow = new THREE.Vector3();

  /**
   * Fit every cascade to `camera` and point them along the sun.
   *
   * Called from sky.js on `scene.onBeforeRender`, which three invokes with the
   * live camera BEFORE it projects the scene and before WebGLShadowMap runs —
   * so the lights this places are the lights that frame's shadow maps use.
   * There is no one-frame lag and no dependency on main.js.
   *
   * @param {THREE.PerspectiveCamera} camera
   */
  function update(camera) {
    if (!camera || !camera.isCamera) return;

    const t0 = now();
    tagged = 0;
    scene.traverse(tagObject);
    lastTagMs = now() - t0;

    if (lights.length === 0) return;

    const t1 = now();

    // -- sun fade ---------------------------------------------------------
    // Below the horizon the shadow direction is meaningless and the cascades
    // would be infinitely long. Fading `shadow.intensity` rather than toggling
    // `castShadow` is deliberate: castShadow changes NUM_DIR_LIGHT_SHADOWS,
    // which changes every shader's program key, which is a compile stall in the
    // middle of a flight.
    const sunElevDeg = Math.asin(THREE.MathUtils.clamp(sunDirection.y, -1, 1)) * 180 / Math.PI;
    sunFade = THREE.MathUtils.smoothstep(sunElevDeg, SUN_FADE_LO, SUN_FADE_HI);
    if (!enabled) sunFade = 0;

    // Nothing to draw into the maps: stop rendering them entirely. The stale
    // contents stay bound, which is harmless because intensity 0 makes
    // getShadow() return exactly 1.0.
    const live = sunFade > 0.001;

    // -- light-space basis, from the sun direction alone -------------------
    const up = Math.abs(sunDirection.y) > 0.999 ? _upAlt : _up;
    _basis.identity().lookAt(sunDirection, _zero, up);
    _basisInv.copy(_basis).transpose();

    const tanV = Math.tan((camera.fov * Math.PI) / 360);
    const aspect = camera.aspect || 1;

    camera.updateMatrixWorld();
    _eyeNow.setFromMatrixPosition(camera.matrixWorld);

    for (let i = 0; i < cascades.length; i++) {
      const c = cascades[i];
      const light = lights[i];

      // STAGGERING. A cascade that is not re-rendered this frame is also not
      // re-FITTED — three skips `shadow.updateMatrices` for it too, so its map
      // and its shadow matrix stay a matched pair and the stale cascade is
      // still *correct* for the world region it covers. Everything in these
      // bands is static geometry; the only thing a stale map gets wrong is a
      // moving object, and the only moving object is the aeroplane, which
      // lives in cascade 0.
      const due = c.period <= 1 || frames % c.period === c.phase;
      light.shadow.autoUpdate = live && due;
      light.shadow.intensity = live ? sunFade : 0;
      if (!live || !due) {
        light.shadow.needsUpdate = false;
        if (!live) continue;
        // Splits still have to be written — they describe the cascade, not the
        // fit, and the fragment shader reads them every frame.
        writeSplit(i, c);
        continue;
      }
      c.renders++;

      const n = i === 0 ? camera.near : c.near;
      sliceSphere(n, c.far, tanV, aspect, _sphere);

      // Quantise so a continuously-changing fov does not resize the box (and
      // therefore the texel grid) every frame. The drift term covers the
      // distance the camera can travel before this cascade is fitted again;
      // it goes through the same quantisation, so in practice it changes
      // nothing and only matters when someone raises `period`.
      // Padding for the frames this cascade will NOT be refitted on. Capped at
      // 5% of the box so a teleport (which spikes camStep) cannot quietly throw
      // away most of the cascade's resolution: 5% of cascade 2 is 72 m, which
      // covers 36 m of camera travel per frame — 2.2 km/s, well past anything
      // a Cessna does.
      const pad = Math.min((c.period - 1) * camStep, 0.05 * _sphere.r);
      const r = quantise(_sphere.r + pad);
      c.radius = r;
      c.texel = (2 * r) / c.size;
      // Depth headroom for casters standing above the slice. Scaled by the box
      // so cascade 0 stays shallow (precision) and cascade 2 can hold a ridge.
      c.margin = THREE.MathUtils.clamp(4 * r, 300, 8000);

      // Slice centre: on the view axis, then into world, then into light space.
      _centreView.set(0, 0, _sphere.z);
      _centreWorld.copy(_centreView).applyMatrix4(camera.matrixWorld);
      _centreLight.copy(_centreWorld).applyMatrix4(_basisInv);

      // THE SNAP. Without these three lines every shadow edge boils.
      _centreLight.x = Math.round(_centreLight.x / c.texel) * c.texel;
      _centreLight.y = Math.round(_centreLight.y / c.texel) * c.texel;
      _centreLight.z = Math.round(_centreLight.z);

      _centreWorld.copy(_centreLight).applyMatrix4(_basis);

      light.target.position.copy(_centreWorld);
      light.position.copy(_centreWorld).addScaledVector(sunDirection, r + c.margin);
      light.target.updateMatrixWorld();
      light.updateMatrixWorld();

      const cam = light.shadow.camera;
      // The shadow camera's own basis must match the basis the snap was done
      // in, or the grid we snapped to is not the grid the texels sit on.
      cam.up.copy(up);
      cam.left = -r;
      cam.right = r;
      cam.top = r;
      cam.bottom = -r;
      cam.near = 1;
      cam.far = c.margin + 2 * r;
      cam.updateProjectionMatrix();

      light.shadow.normalBias = Math.min(NORMAL_BIAS_TEXELS * c.texel, NORMAL_BIAS_MAX_M);
      // shadowCoord.z is normalised over [near, far]; getShadow ADDS the bias,
      // so it has to be negative to push the receiver toward the light.
      const depthBiasM = THREE.MathUtils.clamp(
        DEPTH_BIAS_TEXELS * c.texel,
        DEPTH_BIAS_MIN_M,
        DEPTH_BIAS_MAX_M,
      );
      light.shadow.bias = -depthBiasM / (cam.far - cam.near);

      writeSplit(i, c);
    }

    // Cascades that do not exist must never claim any weight.
    for (let i = cascades.length; i < MAX_CASCADES; i++) {
      splitsUniform.value[i].set(1e9, 0, 1e9, 0);
    }

    // The padding a staggered cascade needs is a function of this, so it must
    // be a LADDER, not a smooth decay: anything that changes every frame changes
    // the box every frame, and a box that changes moves every texel in it. Grows
    // at once, shrinks only once the real step has fallen to a quarter, and both
    // ends land on the same quantisation the radius uses.
    const step = Math.min(_camPrev.distanceTo(_eyeNow), 500);
    if (step > camStep || step * 4 < camStep) camStep = quantise(Math.max(step, 1e-3));
    _camPrev.copy(_eyeNow);

    eyeUniform.value.copy(_eyeNow);

    lastFitMs = now() - t1;
    frames++;
  }

  /**
   * Split spans, with a cross-fade band at the far edge of each cascade that
   * the next one's fade-in mirrors, so the two weights sum to exactly 1 across
   * the overlap and the transition is invisible.
   */
  function writeSplit(i, c) {
    const band = Math.max(1, (c.far - c.near) * BLEND_FRACTION);
    const prevBand =
      i === 0 ? 1 : Math.max(1, (cascades[i - 1].far - cascades[i - 1].near) * BLEND_FRACTION);
    const v = splitsUniform.value[i];
    if (i === 0) {
      v.x = -1;
      v.y = 1e6; // fade-in already complete at z = 0
    } else {
      v.x = c.near - prevBand;
      v.y = 1 / prevBand;
    }
    v.z = c.far - band;
    v.w = 1 / band;
  }

  function quantise(r) {
    if (!(r > 0)) return 1;
    const e = Math.ceil(Math.log(r) / Math.log(RADIUS_QUANT));
    return Math.pow(RADIUS_QUANT, e);
  }

  // -------------------------------------------------------------------------
  // Handle
  // -------------------------------------------------------------------------

  /**
   * Switch quality tier. Rebuilds the cascade lights, which changes
   * NUM_DIR_LIGHT_SHADOWS and therefore recompiles every lit material — a
   * one-off stall of a few tens of ms. Fine for a settings change, not
   * something to call per frame.
   *
   * @param {'off'|'low'|'medium'|'high'} name
   */
  function setQuality(name) {
    if (!TIERS[name] || name === tierName) return;
    tierName = name;
    tier = TIERS[name];
    destroyLights();
    untagAll();
    tagVersion++;
    buildLights();
    if (renderer && renderer.shadowMap) renderer.shadowMap.enabled = tier.cascades > 0;
  }

  function setEnabled(on) {
    enabled = !!on;
  }

  /** Diagnostics. Allocation-free is not required — nothing calls this per frame. */
  function getStats() {
    return {
      quality: tierName,
      cascades: cascades.map((c, i) => ({
        near: i === 0 ? 0 : c.near,
        far: c.far,
        mapSize: c.size,
        radiusM: c.radius,
        texelM: c.texel,
        marginM: c.margin,
        period: c.period,
        renderShare: frames ? +(c.renders / frames).toFixed(3) : 0,
        normalBiasM: lights[i] ? lights[i].shadow.normalBias : 0,
        depthBias: lights[i] ? lights[i].shadow.bias : 0,
        intensity: lights[i] ? lights[i].shadow.intensity : 0,
      })),
      sunFade,
      camStepM: +camStep.toFixed(3),
      tagMs: lastTagMs,
      fitMs: lastFitMs,
      taggedObjects: tagged,
      materialsSetUp: setUp.size,
      terrainCasts: tier.terrainCasts,
      frames,
    };
  }

  function dispose() {
    destroyLights();
    untagAll();
    if (renderer && renderer.shadowMap) renderer.shadowMap.enabled = false;
  }

  return {
    lights,
    update,
    setQuality,
    getQuality: () => tierName,
    setEnabled,
    getStats,
    /** Exposed for the harness; not part of any contract. */
    _sliceSphere: sliceSphere,
    _splits: splitsUniform,
    dispose,
  };
}

const _perf =
  typeof performance !== 'undefined' && performance.now
    ? performance
    : { now: () => Number(process.hrtime.bigint() / 1000n) / 1000 };
function now() {
  return _perf.now();
}

export {
  sliceSphere as _sliceSphere,
  extractTerrainMorph as _extractTerrainMorph,
  TIERS as _TIERS,
  TERRAIN_ANCHORS as _TERRAIN_ANCHORS,
  MAX_CASCADES as _MAX_CASCADES,
};
