/**
 * sky.js — atmosphere, sun, clouds, and every light in the scene.
 *
 * Contract: see MODULES.md § 2.8
 *
 *   createSky(scene, renderer, opts) -> {
 *     update(dt, sunAngle?), setTimeOfDay(t), getTimeOfDay(),
 *     sunLight, ambientLight, sunDirection
 *   }
 *
 * `sunLight` and `ambientLight` are exposed as PROPERTIES so other subsystems
 * can read the sun direction (for lens flare, water specular, shadow camera
 * framing) without this module having to know they exist. Read them; do not
 * reparent them or change their intensity — this module rewrites both every
 * time the sun moves.
 *
 * This module OWNS scene.background, scene.fog, scene.environment and every
 * light in the scene. No other module may add a light.
 *
 * ===========================================================================
 * WHAT THIS IS
 * ===========================================================================
 * A Preetham analytic daylight model (the same one three's Sky example uses)
 * evaluated TWICE from one set of constants:
 *
 *   - in GLSL, on a camera-locked dome, for the pixels you see; and
 *   - in JS, in `evalSky()`, for the fog colour, the hemisphere fill colour,
 *     the sun's colour, and the cloud shading.
 *
 * Evaluating the same model on both sides is the whole trick. It is why the
 * sun goes orange at exactly the moment the sky does, why the terrain's fog
 * colour is the colour of the sky it fades into, and why the clouds are lit by
 * the same light as everything else. Nothing here is a hand-picked gradient.
 *
 * Everything the JS side derives is TONE-MAPPED before it leaves this module,
 * because the sky shader tone-maps its own output (see below) and the fog
 * colour has to be comparable with the sky pixel sitting next to it.
 *
 * ---------------------------------------------------------------------------
 * TONE MAPPING IS LOCAL, DELIBERATELY
 * ---------------------------------------------------------------------------
 * A physical sky produces radiances in the thousands. That has to be tone-
 * mapped or the top two thirds of the dome clip to white. The obvious move is
 * `renderer.toneMapping = ACESFilmicToneMapping` — and it is the wrong move
 * here, because it would silently restate the colour of every material seven
 * other agents have already tuned against a linear pipeline.
 *
 * So the ACES curve is applied INSIDE the sky and cloud shaders only, and the
 * renderer is left exactly as main.js configured it. The cost is that this
 * module must hand out already-tone-mapped colours (fog, lights, clouds) so
 * the rest of the scene lands in the same range. `toneMap()` below is the
 * single place that happens.
 *
 * ---------------------------------------------------------------------------
 * TONE MAPPING, CALIBRATED — WHY THE OLD SKY WAS FLAT
 * ---------------------------------------------------------------------------
 * Round 1 shipped `exposure: 0.36` with `rayleigh: 3`, and the verdict was "a
 * flat pale blue-grey with almost no vertical gradient". The Rayleigh and Mie
 * terms were fine. The exposure was not.
 *
 * Preetham's radiance at these settings puts the whole visible dome ABOVE the
 * ACES curve's knee, where the curve's slope is a fifth of what it is at the
 * bottom. Worked example, sun at 35 deg, looking anti-solar, per channel BEFORE
 * the curve: zenith 0.19 / 0.62 / 1.20, horizon 1.35 / 1.38 / 1.39. The model
 * has a 6.3:1 blue-to-red ratio overhead. ACES at that exposure returns 0.35 /
 * 0.68 / 0.83 — a 2.4:1 ratio. Five sixths of the colour is destroyed by the
 * curve, not by the model, and the same compression flattens zenith against
 * horizon. A flight-sim camera only ever shows the bottom ~30 deg of the dome,
 * which is exactly where the old calibration was whitest.
 *
 * So the constants were re-fitted, not the model. `scripts/check-sky.mjs`
 * carries the rig: eleven elevations from zenith to 1 deg, weighted toward the
 * 0-40 deg band a cockpit camera actually frames, scored against measured
 * clear-day sky colours in sRGB. Mean weighted error:
 *
 *   round 1   rayleigh 3    mieCoefficient 0.0025  pow 1.5  exposure 0.36  47.5
 *   now       rayleigh 1.2  mieCoefficient 0.002   pow 1.2  exposure 0.95  12.7
 *
 *   elevation      90    45    25    12     5     1
 *   round 1      127   122   159   204   229   237   <- 110 units over 89 deg
 *   now           89    85   115   165   208   231   <- 142 units, and it is
 *   measured      55    85   125   170   210   232      blue where it should be
 *
 * (red channel shown; the full triples are in the harness.) PREETHAM_CONTRAST
 * is Preetham's undocumented output exponent — three's Sky example hardcodes
 * 1.5 with no derivation. 1.2 fits measured sky better. It is a single named
 * constant, shared by the GLSL and the JS, like every other one here.
 *
 * ---------------------------------------------------------------------------
 * AERIAL PERSPECTIVE REPLACES FogExp2 ENTIRELY
 * ---------------------------------------------------------------------------
 * `FogExp2` has one scalar density and one colour, so every channel fades at
 * the same rate toward the same value. Everything far away therefore converges
 * on one grey. Measured, at the round-1 budget, 94 km:
 *
 *   Mount Rainier rock   sRGB 213,214,214   <- the critic's "grey nub"
 *   Mount Rainier snow   sRGB 241,244,246   <- 28 units of separation, no hue
 *
 * That is not what distance does. Distance is *spectral*: Rayleigh extinction
 * goes as lambda^-4, so blue is stripped from the transmitted image ~5x faster
 * than red while the in-scattered airlight fills back in blue-first. Distant
 * dark things go BLUE. Distant bright things (snow) barely move, because they
 * are already the brightness of the airlight. The mountain separates by hue.
 *
 * So three's four fog chunks are replaced, at module scope, with a two-species
 * airlight model:
 *
 *   tau_c   = density * ( betaR_c * I(8000) + aerosol * betaM_c * I(1200) )
 *   I(H)    = L * exp(-y0/H) * (1 - exp(-dy/H)) / (dy/H)
 *   result  = mix( airlight, fragment, exp(-tau) )
 *
 * I(H) is the exact column density of an exponential atmosphere along the
 * segment from the camera's altitude to the fragment's — not an approximation,
 * and it costs two exp() calls. Because it is a function of BOTH endpoints,
 * valleys haze more than the ridges above them, which `FogExp2` cannot express
 * at all: it only knows range. Same 94 km shot, same budget:
 *
 *   transmittance R/G/B        rock            snow
 *   summit  0.72 / 0.51 / 0.25  180,199,223     244,245,245
 *   base    0.58 / 0.36 / 0.14  194,212,232     243,244,245
 *
 * Rock is now blue and 60 units below snow in red, the base is hazier than the
 * summit, and the cone reads as a cone. `fogDensity` is still a visibility
 * budget and still means "sea-level extinction of the green channel, per
 * metre"; 8e-6 reproduces the round-1 84 km contrast of ~0.43 as the AVERAGE
 * over the mountain's height, with real structure either side of it.
 *
 * Two notes for anyone touching this. The fragment's world Y arrives through a
 * varying written in `fog_vertex` — `cameraPosition + mvPosition.xyz *
 * mat3(viewMatrix)` recovers world space from view space for skinned,
 * instanced and morphed geometry alike, which reading `modelMatrix` would not.
 * And the composite happens in DISPLAY-ENCODED space, after
 * `<colorspace_fragment>`, exactly where three's own fog runs — deliberately,
 * because `fogColor` is uploaded pre-encoded by `refreshFogUniforms` and doing
 * the blend in linear would need to know which encoding the renderer picked
 * for the current target.
 *
 * ---------------------------------------------------------------------------
 * CLOUDS: TWO REPRESENTATIONS OF ONE DECK
 * ---------------------------------------------------------------------------
 * Puget Sound weather is low broken stratus, and a single textured plane reads
 * as a single textured plane the moment you climb. So the deck exists twice:
 *
 *   NEAR (< ~24 km)  `cloudLayers` horizontal slabs between cloudBaseM and
 *                    cloudTopM. Real thickness — climbing out of KBFI you
 *                    enter the base, spend a few hundred feet in the white,
 *                    and break out on top. Each slab dissolves as the camera
 *                    reaches its altitude so you never see a plane edge-on.
 *   FAR  (> ~20 km)  a ray-plane intersection inside the sky dome shader.
 *                    Analytically infinite, so the deck runs to the horizon
 *                    and lies down into the haze instead of ending at a disc.
 *
 * They cross-fade over 20–24 km. The reason it is seamless is that the deck's
 * large-scale shape — which cell you are under, where the holes are — comes
 * from `cloudMacro()`, six summed sines, evaluated identically by the near
 * shader, the far shader, and JS. Only the sub-kilometre fluff is per-shader
 * value noise.
 *
 * That mirrorable macro shape is also what lets `update()` know whether the
 * aircraft is inside cloud or in a hole in it, which drives the white-out.
 * Being able to answer that on the CPU is the reason the macro layer is sines
 * and not a hash — a `fract(sin(dot(...)))` hash does not survive the trip
 * from float32 to float64 and back, so the CPU and GPU would disagree about
 * where the clouds are.
 */

import * as THREE from 'three';
import { clamp, lerp, damp, DEG_TO_RAD, RAD_TO_DEG } from '../core/units.js';
import { createShadows } from './shadows.js';

/**
 * @typedef {Object} SkyOpts
 * -- documented in MODULES.md § 2.8 --
 * @property {number} [turbidity]      Atmospheric haze, Preetham T. Default 8.
 * @property {number} [fogDensity]     Aerial-perspective budget: sea-level extinction
 *           of the GREEN channel, per metre. Red and blue follow from lambda^-4.
 *           Default 8e-6.
 * @property {number} [timeOfDay]      Initial time, 0..1. Default 0.42.
 * @property {number} [sunDistance]    Sun light placement radius, metres. Default 120000.
 * @property {number} [sunAzimuthDeg]  Compass bearing the sun culminates over. Default 180.
 * @property {number} [dayLengthSec]   Real seconds per in-sim day. Default 0 = frozen.
 *
 * -- additions, all optional, all with working defaults --
 * @property {number} [rayleigh]       Rayleigh scattering multiplier. Default 1.2 (fitted).
 * @property {number} [mieCoefficient] Mie scattering multiplier. Default 0.002 (fitted).
 * @property {number} [mieDirectionalG] Mie forward-scatter anisotropy. Default 0.76.
 * @property {number} [exposure]       Sky-local tone-map exposure. Default 0.95 (fitted).
 * @property {number} [fogViewBlend]   How far the airlight colour follows the camera's
 *           heading rather than the horizon average, 0..1. Default 0.7.
 * @property {number} [latitudeDeg]    Latitude for the solar arc. Default 47.5 (Seattle).
 * @property {number} [declinationDeg] Solar declination. Default 0 (equinox) — which
 *           is what makes t=0.25 exactly sunrise and t=0.75 exactly sunset.
 *           +23.4 = June solstice, -23.4 = December.
 * @property {number} [sunIntensity]   Peak DirectionalLight intensity. Default 2.6.
 * @property {number} [ambientIntensity] Peak HemisphereLight intensity. Default 0.66.
 * @property {number} [nightAmbientIntensity] Night floor. Default 0.055.
 * @property {number} [moonIntensity]  Peak moonlight DirectionalLight. Default 0.1.
 * @property {number} [moonPhaseOffset] Moon's offset along the day, 0..1. Default 0.5
 *           (full moon, opposite the sun, up all night).
 * @property {boolean} [environment]   Generate a PMREM IBL from the sky. Default true.
 * @property {number} [environmentIntensity] scene.environmentIntensity. Default 0.3.
 * @property {number} [fogHeightScaleM] IGNORED. The aerial-perspective model integrates
 *           the real height profile between camera and fragment; this option used to
 *           approximate that and would now double-count. Kept so callers do not break.
 * @property {boolean} [clouds]        Build the cloud deck. Default true.
 * @property {number} [cloudCoverage]  0 = clear, 1 = overcast. Default 0.62 (broken).
 * @property {number} [cloudBaseM]     Deck base, metres MSL. Default 850 (~2800 ft).
 * @property {number} [cloudTopM]      Deck top, metres MSL. Default 1250.
 * @property {number} [cloudScale]     World metres -> macro-noise units. Default 1/1400.
 * @property {number} [cloudLayers]    Near-field slab count. Default 8.
 * @property {number} [cloudShearM]    Downwind lean of the deck's top relative to its
 *           base, metres. 0 makes the deck a vertical extrusion. Default 900.
 * @property {number} [cloudSunDepth]  Optical depth per unit macro density along the
 *           ray to the sun; drives self-shadowing. Default 2.4.
 * @property {number} [cloudRadiusM]   Near-field slab half-width. Default 34000.
 * @property {number} [cloudHandoverM] Distance the near field hands over to the dome.
 *           Default 12000; the fade runs to `* CLOUD_HANDOVER_WIDTH` = 31.2 km,
 *           staggered per slab.
 * @property {number} [cloudWindMs]    Deck drift speed. Default 7.
 * @property {number} [cloudWindDirDeg] Bearing the deck drifts TOWARD. Default 215.
 * @property {number} [inCloudVisibilityM] Visibility inside cloud. Default 190.
 * @property {boolean} [stars]         Star field + Milky Way band. Default true.
 * @property {boolean} [shadows]       Cascaded shadow maps. Default true.
 * @property {string}  [shadowQuality] 'off' | 'low' | 'medium' | 'high'. Default 'high'.
 * @property {boolean} [aircraftReceivesShadow] Default true.
 */

const DEFAULTS = {
  turbidity: 8,
  // Sea-level extinction of the GREEN channel, per metre. Red and blue follow
  // from lambda^-4; see AERIAL below. 8e-6 reproduces the round-1 84 km Rainier
  // contrast of ~0.43 as the average over the mountain's height.
  fogDensity: 8.0e-6,
  timeOfDay: 0.42,
  sunDistance: 120000,
  sunAzimuthDeg: 180,
  dayLengthSec: 0,

  // Re-fitted against measured sky colours — see the header. Weighted sRGB
  // error 12.7 (was 47.5 at rayleigh 3 / exposure 0.36).
  rayleigh: 1.2,
  mieCoefficient: 0.002,
  mieDirectionalG: 0.76,
  exposure: 0.95,
  /** How far the fog colour follows the camera's heading, 0..1. See §fog colour. */
  fogViewBlend: 0.7,

  latitudeDeg: 47.5,
  declinationDeg: 0,

  sunIntensity: 2.6,
  // AMBIENT FILL, AND WHY IT CAME DOWN FROM 1.05.
  //
  // Two of round 2's findings were the same number. At 1.05 against a sun of
  // 2.6, a horizontal surface with the sun 40 degrees up took 41% of its light
  // from a near-white hemisphere. That does two things, both bad and both
  // measured. It made the four-cascade CSM invisible — toggling shadows moved
  // 16.7% of pixels by a mean of 9.3 sRGB levels, under 4% contrast, and no
  // building shadow could be identified in a CBD frame. And it bleached the
  // ground: a downtown block interior rendered sRGB 99,101,101, perfectly
  // neutral, over a class albedo of 80,84,65 — the chroma was being washed out
  // by the fill, not missing from the palette.
  //
  // 0.66 puts the diffuse fraction at about 30%, which is also closer to the
  // measured clear-sky diffuse-to-global ratio at this latitude and sun angle.
  // The sun's own intensity is untouched: check-sky.mjs ties the cloud-top
  // brightness to sunLight.intensity / 2.6.
  ambientIntensity: 0.66,
  nightAmbientIntensity: 0.055,
  moonIntensity: 0.1,
  moonPhaseOffset: 0.5,

  environment: true,
  environmentIntensity: 0.3,

  fogHeightScaleM: 2600,

  clouds: true,
  cloudCoverage: 0.62,
  cloudBaseM: 850,
  cloudTopM: 1250,
  cloudScale: 1 / 1400,
  cloudLayers: 8,
  /** Downwind offset of the deck's top relative to its base, metres. */
  cloudShearM: 900,
  /** Optical depth per unit of macro density along the ray to the sun. */
  cloudSunDepth: 2.4,
  // The slab quad has to outlast the hand-over band, which now ends at
  // cloudHandoverM * CLOUD_HANDOVER_WIDTH = 31.2 km. 34 km of half-width clears
  // that on the short axis with margin, and the slabs discard rather than
  // shade, so the extra area costs geometry and no fill.
  cloudRadiusM: 34000,
  cloudHandoverM: 12000,
  cloudWindMs: 7,
  cloudWindDirDeg: 215,
  inCloudVisibilityM: 190,

  stars: true,

  shadows: true,
  shadowQuality: 'high',
  aircraftReceivesShadow: true,
};

// ---------------------------------------------------------------------------
// Preetham constants. Shared verbatim between the GLSL and the JS evaluation —
// if you change one, change the other or the fog stops matching the sky.
// ---------------------------------------------------------------------------

/** Rayleigh scattering at sea level for 680/550/450 nm primaries, per metre. */
const TOTAL_RAYLEIGH = [5.804542996261093e-6, 1.3562911419845635e-5, 3.0265902468824876e-5];
/** pi * pow((2*pi)/lambda, v-2) * K, the wavelength part of the Mie term. */
const MIE_CONST = [1.8399918514433978e14, 2.7798023919660528e14, 4.0790479543861094e14];
/** Optical depth at the zenith, metres. */
const RAYLEIGH_ZENITH_LENGTH = 8.4e3;
const MIE_ZENITH_LENGTH = 1.25e3;
/** Preetham's "earth shadow" cutoff — the sun's contribution dies just below the horizon. */
const SUN_CUTOFF_ANGLE = 1.6110731556870734;
const SUN_STEEPNESS = 1.5;
const SUN_EE = 1000.0;
/** Scales Preetham's arbitrary radiance units into something exposure can work on. */
const SKY_RADIANCE_SCALE = 0.04;
/**
 * Preetham's output exponent. three's Sky example hardcodes 1.5 with no
 * derivation; 1.2 fits measured clear-sky colour better (header table). It is
 * per-channel, so it changes chromaticity as well as contrast — which is the
 * point. Shared verbatim with the GLSL below.
 */
const PREETHAM_CONTRAST = 1.2;

/**
 * The cloud deck's vertical envelope, as ONE set of numbers used by the GLSL
 * and by `cloudDensityJs`. They were two copies of the same four literals and
 * the CPU would have gone on believing in a deck shape the GPU had stopped
 * drawing.
 */
/**
 * The near/far hand-over band, as a MULTIPLE of `cloudHandoverM` rather than a
 * number of metres added to it.
 *
 * The near slabs fade out and the dome's analytic deck fades in across
 * `[H, H * this]`. Proportional because the band has to look the same width
 * wherever it is seen, and near the horizon a fixed number of metres of range
 * subtends almost no angle at all — which is how round 2 ended up with eight
 * hard rings stacked inside a degree of sky. 2.6 puts the band at 12–31 km.
 *
 * `cloudRadiusM` must stay comfortably larger than `cloudHandoverM * this`, or
 * the slab's own square edge comes into view before it has faded out.
 */
const CLOUD_HANDOVER_WIDTH = 2.6;

const CLOUD_ENVELOPE = {
  /** Rounded bottoms: cover ramps in over the first this-much of the deck. */
  base: 0.18,
  /** Cover holds full until here, then frays to the top. */
  top: 0.80,
  /** Cover outside the envelope, as a fraction of cloudCoverage. */
  floor: 0.55,
};

// ---------------------------------------------------------------------------
// AERIAL PERSPECTIVE — the constants three's fog chunks are rebuilt around.
// See the header for the derivation and the measured 94 km table.
// ---------------------------------------------------------------------------

const AERIAL = {
  /** Rayleigh extinction relative to green. lambda^-4 at 680/550/450 nm. */
  betaR: [
    TOTAL_RAYLEIGH[0] / TOTAL_RAYLEIGH[1],
    1,
    TOTAL_RAYLEIGH[2] / TOTAL_RAYLEIGH[1],
  ],
  /** Aerosol extinction relative to green. Angstrom exponent ~1.3, not ^-4. */
  betaM: [0.76, 1.0, 1.29],
  /**
   * Aerosol extinction at sea level as a multiple of the green Rayleigh term.
   * Fixed, not driven by `turbidity`: turbidity scales the whole budget in JS
   * instead, so this stays a compile-time constant and the chunk can be
   * installed once, at module load, before any material compiles.
   */
  aerosolRatio: 0.8,
  /** Scale heights, metres. Molecular air and the aerosol boundary layer. */
  hR: 8000,
  hM: 1200,
  /** Below this the density integral is clamped; Puget Sound is not a canyon. */
  floorM: -400,
  /** Haze seen looking DOWN is lit ground haze, dimmer than the sky. */
  groundHaze: 0.82,
};

/**
 * Replaces three's four fog chunks, globally and exactly once.
 *
 * This is at MODULE scope on purpose. `main.js` builds the terrain before it
 * builds the sky (bootstrap order, §3), and a chunk swapped inside
 * `createSky()` would be a race against whichever material compiled first.
 * Importing this file is enough; nothing has to be called in the right order.
 *
 * The chunks stay `#ifdef USE_FOG`-guarded, so every material that opted out of
 * fog — the sky dome, the cloud slabs, all of three's depth and shadow
 * materials — is untouched and compiles to exactly the same code as before.
 */
const _aerialFixed = (v) => v.toFixed(6);

/**
 * The airlight model, as one GLSL function, emitted from `AERIAL` so the fog
 * chunk, the sky dome and the cloud shaders cannot drift apart. Every caller
 * gets the same curve for the same range and the same pair of altitudes.
 */
const GLSL_AERIAL = /* glsl */ `
  /**
   * Per-channel transmittance over a segment of exponential atmosphere.
   *
   * Column density of exp(-y/H) between two altitudes, exactly:
   *   I(H) = L * exp(-y0/H) * ( 1 - exp(-dy/H) ) / ( dy/H )
   * The (1 - exp(-x))/x factor is 1 - x/2 near zero, which is the branch
   * below; without it a horizontal ray divides 0 by 0.
   */
  vec3 aerialTransmittance( float camY, float fragY, float dist, float density ) {
    // A density three orders of magnitude above the clear-air budget is sky.js
    // saying "the camera is inside cloud". Cloud droplets are large enough to
    // scatter greyly and they fill the volume uniformly, so both the spectral
    // tilt and the height profile are annulled here rather than rendering a
    // wavelength-sorted, exponentially stratified fog bank inside a cumulus.
    float grey = smoothstep( 2.0e-4, 2.0e-3, density );
    vec2 H = mix( vec2( ${AERIAL.hR.toFixed(1)}, ${AERIAL.hM.toFixed(1)} ), vec2( 1.0e7 ), grey );

    float y0 = max( camY, ${AERIAL.floorM.toFixed(1)} );
    float y1 = max( fragY, ${AERIAL.floorM.toFixed(1)} );
    vec2 x = ( y1 - y0 ) / H;
    vec2 small = step( abs( x ), vec2( 1.0e-3 ) );
    vec2 xSafe = mix( x, vec2( 1.0 ), small );
    vec2 shape = mix( ( 1.0 - exp( -xSafe ) ) / xSafe, 1.0 - 0.5 * x, small );
    vec2 column = exp( -y0 / H ) * shape * dist;

    vec3 bR = mix( vec3( ${AERIAL.betaR.map(_aerialFixed).join(', ')} ), vec3( 1.0 ), grey );
    vec3 bM = mix( vec3( ${AERIAL.betaM.map(_aerialFixed).join(', ')} ), vec3( 1.0 ), grey );
    vec3 tau = density * ( bR * column.x + ${AERIAL.aerosolRatio.toFixed(4)} * bM * column.y );
    return exp( -min( tau, vec3( 60.0 ) ) );
  }
`;

let aerialInstalled = false;

function installAerialPerspective() {
  if (aerialInstalled) return;
  aerialInstalled = true;

  THREE.ShaderChunk.fog_pars_vertex = /* glsl */ `
    #ifdef USE_FOG
      varying float vFogDepth;
      varying float vFogWorldY;
    #endif
  `;

  THREE.ShaderChunk.fog_vertex = /* glsl */ `
    #ifdef USE_FOG
      // RADIAL distance, not view-space depth: at a 70 deg horizontal field the
      // two differ by 20% at the screen edge, which on a 94 km mountain is a
      // visible vertical seam down the middle of the frame.
      vFogDepth = length( mvPosition.xyz );
      // World Y recovered from VIEW space. viewMatrix's rotation is orthonormal,
      // so its transpose is its inverse and ( v * mat3(viewMatrix) ).y is one
      // dot product. Going through modelMatrix instead would be wrong for
      // instanced, skinned and morphed geometry, all of which fold their extra
      // transform into modelViewMatrix and never touch modelMatrix.
      vFogWorldY = cameraPosition.y + dot( mvPosition.xyz, viewMatrix[ 1 ].xyz );
    #endif
  `;

  THREE.ShaderChunk.fog_pars_fragment = /* glsl */ `
    #ifdef USE_FOG
      uniform vec3 fogColor;
      varying float vFogDepth;
      varying float vFogWorldY;
      #ifdef FOG_EXP2
        uniform float fogDensity;
      #else
        uniform float fogNear;
        uniform float fogFar;
      #endif

      ${GLSL_AERIAL}
    #endif
  `;

  THREE.ShaderChunk.fog_fragment = /* glsl */ `
    #ifdef USE_FOG
      {
        #ifdef FOG_EXP2
          float fogRho = fogDensity;
        #else
          // Linear fog is not used here, but a caller may still set one.
          float fogRho = 1.0 / max( fogFar - fogNear, 1.0 );
        #endif
        vec3 fogT = aerialTransmittance( cameraPosition.y, vFogWorldY, vFogDepth, fogRho );
        // Looking down, the airlight is ground haze lit from above, not sky.
        // Same 0.82 the dome uses below its horizon, so they meet.
        float fogEl = ( vFogWorldY - cameraPosition.y ) / max( vFogDepth, 1.0 );
        vec3 fogAir = fogColor * mix(
          ${AERIAL.groundHaze.toFixed(3)}, 1.0, smoothstep( -0.25, 0.02, fogEl )
        );
        gl_FragColor.rgb = mix( fogAir, gl_FragColor.rgb, fogT );
      }
    #endif
  `;
}

installAerialPerspective();

// ---------------------------------------------------------------------------
// GLSL chunks
// ---------------------------------------------------------------------------

/**
 * Narkowicz's ACES fit. Operates on and returns LINEAR values — the display
 * transfer function is applied afterwards by <colorspace_fragment>, exactly as
 * three's own tone mapping does it.
 */
const GLSL_TONEMAP = /* glsl */ `
  vec3 acesToneMap( vec3 x ) {
    const float a = 2.51, b = 0.03, c = 2.43, d = 0.59, e = 0.14;
    return clamp( ( x * ( a * x + b ) ) / ( x * ( c * x + d ) + e ), 0.0, 1.0 );
  }
`;

/**
 * The cloud deck's LARGE-SCALE shape: six sines with incommensurate
 * frequencies, so it never visibly tiles, plus — the point — it is exactly
 * reproducible in double precision on the CPU. `cloudMacroJs()` below is the
 * line-for-line mirror. Do not replace this with a hash-based fBm: the CPU
 * would then be unable to tell whether the aircraft is inside a cloud, and the
 * white-out would fire in clear air.
 *
 * `p` is world XZ scaled by cloudScale, so one unit is ~1.4 km and the
 * wavelengths run from ~7 km down to ~1.5 km — stratocumulus cell sizes.
 */
const GLSL_CLOUD_MACRO = /* glsl */ `
  float cloudMacro( vec2 p ) {
    float s = 0.0;
    s += 1.00 * sin( p.x * 0.91 + p.y * 0.37 + 0.7 );
    s += 0.80 * sin( p.x * 0.41 - p.y * 1.13 + 2.3 );
    s += 0.65 * sin( p.x * 1.73 + p.y * 1.51 + 4.1 );
    s += 0.50 * sin( -p.x * 2.29 + p.y * 0.67 + 5.6 );
    s += 0.38 * sin( p.x * 3.11 + p.y * 2.83 + 1.2 );
    s += 0.28 * sin( p.x * 4.37 - p.y * 3.91 + 3.9 );
    return s / 3.61;
  }
`;

/** Value noise + 4-octave fBm. Sub-kilometre fluff only; never load-bearing. */
const GLSL_NOISE = /* glsl */ `
  float hash21( vec2 p ) {
    return fract( sin( dot( p, vec2( 127.1, 311.7 ) ) ) * 43758.5453123 );
  }
  float vnoise( vec2 p ) {
    vec2 i = floor( p );
    vec2 f = fract( p );
    f = f * f * ( 3.0 - 2.0 * f );
    float a = hash21( i );
    float b = hash21( i + vec2( 1.0, 0.0 ) );
    float c = hash21( i + vec2( 0.0, 1.0 ) );
    float d = hash21( i + vec2( 1.0, 1.0 ) );
    return mix( mix( a, b, f.x ), mix( c, d, f.x ), f.y );
  }
  float fbm2( vec2 p ) {
    float v = 0.0;
    float a = 0.5;
    mat2 rot = mat2( 0.80, 0.60, -0.60, 0.80 );
    for ( int i = 0; i < 4; i ++ ) {
      v += a * vnoise( p );
      p = rot * p * 2.03;
      a *= 0.5;
    }
    return v;
  }
`;

/**
 * Deck density at a world XZ and a normalised height through the deck.
 *
 * `hNorm` 0 = base, 1 = top. The coverage threshold is lifted at the base and
 * the top, which is what gives the slabs rounded bottoms and domed tops rather
 * than identical stencils stacked in a pile.
 *
 * TWO THINGS MAKE THE STACK READ AS VOLUME RATHER THAN AS A STACK.
 *
 * SHEAR. Round 1 sampled the same XZ field at every height, so the deck was a
 * vertical extrusion — a cookie cutter. Every slab had its holes in exactly the
 * same place, and flying through it you passed through one silhouette repeated
 * eight times. `uCloudShear` slides the sample point downwind with height, by
 * `cloudShearM` metres from base to top. Real stratocumulus leans, because the
 * wind above the deck is faster than the wind under it, and the lean is what
 * gives the slabs different silhouettes to interleave.
 *
 * SELF-SHADOWING. cloudSunLight() marches two steps from the sample toward
 * the sun, accumulating MACRO density only. Macro is six sines; the fBm detail
 * is deliberately not sampled, because shading at cell scale is what reads as
 * form and sampling the detail would triple the cost of the whole shader for
 * fluff you cannot see the shadow of. The result is that the sunward faces of
 * cells are bright and their lee sides are dark, in the right direction, which
 * is the difference between "billboards" and "clouds".
 */
const GLSL_CLOUD_DENSITY = /* glsl */ `
  uniform float uCloudCoverage;
  uniform float uCloudScale;
  uniform vec2 uCloudDrift;
  uniform vec2 uCloudShear;
  uniform float uCloudSunDepth;

  vec2 cloudSamplePoint( vec2 worldXZ, float hNorm ) {
    return worldXZ * uCloudScale + uCloudDrift + uCloudShear * hNorm;
  }

  float cloudCover( float hNorm ) {
    // THE DECK NEEDS A TOP, NOT A FADE.
    //
    // Round 1 rolled the envelope off from hNorm 0.58, which thinned the deck
    // across its whole upper half. Seen from below that is invisible; seen from
    // ABOVE it means the brightest, most-lit slabs are also the emptiest, so a
    // pilot on top of the deck looks down through a bright haze into the cloud's
    // own shadowed interior. Measured over a covered column from 2,450 m, the
    // deck rendered sRGB 228,213,200 — dust, not cloud tops.
    //
    // Cells narrow toward their tops, they do not dissolve. Holding full cover
    // to 0.80 and rolling off only over the last 20% of the deck
    // leaves one wispy slab fraying at the very top and a solid, sunlit surface
    // immediately under it.
    float envelope = smoothstep( 0.0, ${CLOUD_ENVELOPE.base.toFixed(3)}, hNorm )
      * ( 1.0 - smoothstep( ${CLOUD_ENVELOPE.top.toFixed(3)}, 1.0, hNorm ) );
    return uCloudCoverage * mix( ${CLOUD_ENVELOPE.floor.toFixed(3)}, 1.0, envelope );
  }

  float cloudDensity( vec2 worldXZ, float hNorm, float detail ) {
    vec2 p = cloudSamplePoint( worldXZ, hNorm );
    float macro = cloudMacro( p ) * 0.5 + 0.5;              // 0..1
    // The detail offset per height is what stops the fluff extruding too.
    float fluff = fbm2( p * 3.7 + hNorm * 5.3 ) - 0.5;      // -0.5..0.5
    float field = clamp( macro + fluff * 0.34 * detail, 0.0, 1.0 );
    float thr = 1.0 - cloudCover( hNorm );
    return smoothstep( thr, thr + 0.20, field );
  }

  /** Macro-only density. The light march's inner loop; must stay cheap. */
  float cloudDensityMacro( vec2 worldXZ, float hNorm ) {
    float macro = cloudMacro( cloudSamplePoint( worldXZ, hNorm ) ) * 0.5 + 0.5;
    float thr = 1.0 - cloudCover( hNorm );
    return smoothstep( thr, thr + 0.20, macro );
  }

  /**
   * Transmittance of the deck between this sample and the sun. 1 = full sun.
   * thicknessM is the deck's real thickness, so the vertical step converts
   * metres to hNorm and a high sun escapes in one step while a low sun grinds
   * along the layer — which is why the deck goes dramatic at dusk on its own.
   */
  float cloudSunLight( vec2 worldXZ, float hNorm, vec3 sunDir, float thicknessM ) {
    const float STEP_M = 240.0;
    vec2 dXZ = sunDir.xz * STEP_M;
    float dH = sunDir.y * STEP_M / max( thicknessM, 1.0 );
    float occ = 0.0;
    for ( int i = 1; i <= 2; i ++ ) {
      float fi = float( i );
      float h = hNorm + dH * fi;
      // Outside the deck contributes nothing; smoothed so the term does not
      // pop as the sun crosses an integer number of steps' worth of deck.
      float inside = smoothstep( -0.06, 0.02, h ) * ( 1.0 - smoothstep( 0.98, 1.06, h ) );
      occ += cloudDensityMacro( worldXZ + dXZ * fi, clamp( h, 0.0, 1.0 ) ) * inside;
    }
    return exp( -uCloudSunDepth * occ * 0.5 );
  }
`;

// ---------------------------------------------------------------------------
// Sky dome shaders
// ---------------------------------------------------------------------------

const SKY_VERT = /* glsl */ `
  varying vec3 vDir;
  void main() {
    // The dome carries no rotation, so object space IS world direction. Using
    // it instead of (worldPos - cameraPosition) makes the shader independent of
    // the dome's radius and position, which is what lets the same material be
    // reused at radius 5 inside the PMREM environment scene.
    vDir = normalize( position );
    gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
  }
`;

const SKY_FRAG = /* glsl */ `
  varying vec3 vDir;

  uniform vec3 uSunDir;
  uniform vec3 uMoonDir;
  uniform vec3 uBetaR;
  uniform vec3 uBetaM;
  uniform float uSunE;
  uniform float uMieG;
  uniform float uExposure;
  uniform float uShowSunDisc;

  uniform vec3 uFogColor;
  uniform float uFogDensity;

  uniform float uNight;          // 0 = day, 1 = fully dark
  uniform float uStarFade;       // 0..1, stars visible
  uniform float uStars;          // 0/1 master switch
  uniform vec3 uNightZenith;
  uniform vec3 uNightHorizon;
  uniform vec3 uTwilightColor;
  uniform float uMoonBright;

  uniform float uTime;

  uniform float uClouds;         // 0/1 master switch
  uniform float uCloudBase;
  uniform float uCloudTop;
  uniform float uCloudOpacity;
  uniform float uCloudHandover;
  uniform float uCloudHandWidth;
  uniform vec3 uCloudLit;
  uniform vec3 uCloudShadow;

  uniform float uWhiteout;
  uniform vec3 uWhiteoutColor;

  const float PI = 3.141592653589793;
  const float THREE_OVER_SIXTEEN_PI = 0.05968310365946075;
  const float ONE_OVER_FOUR_PI = 0.07957747154594767;
  // cos of the sun's apparent angular radius.
  const float SUN_DISC_COS = 0.9999566769464484;
  // Baked from the JS constants so the two evaluations cannot drift apart.
  const float RAYLEIGH_ZENITH = ${RAYLEIGH_ZENITH_LENGTH.toFixed(1)};
  const float MIE_ZENITH = ${MIE_ZENITH_LENGTH.toFixed(1)};
  const float SKY_SCALE = ${SKY_RADIANCE_SCALE.toFixed(6)};
  const float SKY_CONTRAST = ${PREETHAM_CONTRAST.toFixed(4)};
  const float GROUND_HAZE = ${AERIAL.groundHaze.toFixed(3)};

  ${GLSL_TONEMAP}
  ${GLSL_AERIAL}
  ${GLSL_CLOUD_MACRO}
  ${GLSL_NOISE}
  ${GLSL_CLOUD_DENSITY}

  float rayleighPhase( float cosTheta ) {
    return THREE_OVER_SIXTEEN_PI * ( 1.0 + cosTheta * cosTheta );
  }

  float hgPhase( float cosTheta, float g ) {
    float g2 = g * g;
    return ONE_OVER_FOUR_PI * ( ( 1.0 - g2 ) / pow( 1.0 - 2.0 * g * cosTheta + g2, 1.5 ) );
  }

  // Extinction along a view ray leaving the ground at elevation dirY.
  vec3 extinction( float dirY ) {
    float zenithAngle = acos( max( 0.0, dirY ) );
    float inv = 1.0 / ( cos( zenithAngle ) + 0.15 * pow( 93.885 - degrees( zenithAngle ), -1.253 ) );
    return exp( -( uBetaR * RAYLEIGH_ZENITH + uBetaM * MIE_ZENITH ) * inv );
  }

  vec3 preetham( vec3 dir, out vec3 Fex ) {
    Fex = extinction( dir.y );
    float cosTheta = dot( dir, uSunDir );
    vec3 betaRTheta = uBetaR * rayleighPhase( cosTheta * 0.5 + 0.5 );
    vec3 betaMTheta = uBetaM * hgPhase( cosTheta, uMieG );
    vec3 ratio = ( betaRTheta + betaMTheta ) / ( uBetaR + uBetaM );

    vec3 Lin = pow( uSunE * ratio * ( 1.0 - Fex ), vec3( SKY_CONTRAST ) );
    // Near the horizon the (1 - Fex) form saturates to white; Preetham's fix is
    // to cross-fade to the transmitted form, which is what puts the red back
    // into a low sun.
    //
    // GATED BY AZIMUTH, which Preetham does not do. His crossfade is a function
    // of the sun's ELEVATION only, so at dusk it reddens the sky behind you as
    // hard as the sky in front, and the anti-solar horizon came out sRGB
    // 98,78,52 — mud. What actually reddens is sunlight that has crossed the
    // long low path, and only air along that line of sight is lit by it; the
    // eastern horizon at sunset is lit from higher up and stays cool. Measured
    // effect at the sun elevation the constants were fitted at (35 deg):
    // horizonBlend is 0.014 there, so this term is inert all day and only has
    // an opinion in the half hour either side of sunset.
    vec2 sunAzD = uSunDir.xz;
    vec2 viewAzD = dir.xz;
    float towardSun = dot( sunAzD, viewAzD )
      / max( length( sunAzD ) * length( viewAzD ), 1.0e-6 ) * 0.5 + 0.5;
    float horizonBlend = clamp( pow( 1.0 - uSunDir.y, 5.0 ), 0.0, 1.0 )
      * mix( 0.15, 1.0, towardSun * towardSun );
    Lin *= mix( vec3( 1.0 ), pow( uSunE * ratio * Fex, vec3( 0.5 ) ), horizonBlend );
    return Lin;
  }

  // ---- night ---------------------------------------------------------------

  float hash31( vec3 p ) {
    p = fract( p * 0.1031 );
    p += dot( p, p.yzx + 33.33 );
    return fract( ( p.x + p.y ) * p.z );
  }

  vec3 starField( vec3 dir ) {
    vec3 cell = dir * 190.0;
    vec3 id = floor( cell );
    vec3 f = fract( cell ) - 0.5;
    float h = hash31( id );
    if ( h < 0.978 ) return vec3( 0.0 );
    vec3 jitter = vec3( hash31( id + 11.0 ), hash31( id + 23.0 ), hash31( id + 37.0 ) ) - 0.5;
    float d = length( f - jitter * 0.66 );
    float mag = fract( h * 137.0 );
    float twinkle = 0.75 + 0.25 * sin( uTime * ( 1.5 + mag * 5.0 ) + mag * 40.0 );
    // Warm and cool stars, roughly the real distribution.
    vec3 tint = mix( vec3( 0.72, 0.80, 1.00 ), vec3( 1.00, 0.86, 0.70 ), mag );
    // NOTE: every smoothstep in this file goes low-edge-first. GLSL leaves
    // smoothstep(a, b, x) UNDEFINED when a >= b, and it silently works on most
    // desktop drivers, which is exactly how that bug ships.
    return tint * ( 1.0 - smoothstep( 0.0, 0.055, d ) ) * ( 0.25 + mag * mag * 1.5 ) * twinkle;
  }

  vec3 milkyWay( vec3 dir ) {
    // A band about a tilted pole. Purely decorative — not a real galactic pole.
    const vec3 pole = vec3( 0.42, 0.66, -0.62 );
    float band = 1.0 - abs( dot( dir, normalize( pole ) ) );
    float m = smoothstep( 0.72, 1.0, band );
    float clumps = fbm2( vec2( atan( dir.z, dir.x ) * 3.0, dir.y * 6.0 ) );
    return vec3( 0.55, 0.60, 0.78 ) * m * m * ( 0.10 + 0.16 * clumps );
  }

  // Warm band that survives after the Preetham term has collapsed. Preetham is
  // undefined below the horizon; this is what stands in for civil twilight.
  vec3 twilight( vec3 dir ) {
    float sunEl = uSunDir.y;
    float when = exp( -pow( ( sunEl + 0.030 ) / 0.105, 2.0 ) );
    if ( when < 0.002 ) return vec3( 0.0 );
    float band = exp( -pow( max( dir.y, 0.0 ) / 0.16, 1.5 ) );
    vec3 sunAz = normalize( vec3( uSunDir.x, 0.0, uSunDir.z ) );
    vec3 viewAz = normalize( vec3( dir.x, 0.0001, dir.z ) );
    float toward = max( 0.0, dot( sunAz, viewAz ) );
    float lobe = 0.22 + 0.78 * pow( toward, 2.2 );
    return uTwilightColor * when * band * lobe;
  }

  vec3 moon( vec3 dir ) {
    float c = dot( dir, uMoonDir );
    float disc = smoothstep( 0.99988, 0.99993, c );
    // Mare: low-frequency mottling across the face.
    float mottle = 0.82 + 0.18 * fbm2( dir.xz * 420.0 + dir.y * 90.0 );
    float halo = pow( max( c, 0.0 ), 900.0 ) * 0.35 + pow( max( c, 0.0 ), 40.0 ) * 0.05;
    return vec3( 1.0, 0.98, 0.93 ) * ( disc * mottle + halo ) * uMoonBright;
  }

  // ---- distant cloud deck --------------------------------------------------
  //
  // Ray/plane intersection against the middle of the deck. Analytically
  // unbounded, so the deck converges onto the horizon instead of ending at the
  // edge of a disc. Faded IN beyond uCloudHandover, where the near-field slabs
  // fade OUT — the two sum to 1 across the overlap.
  vec4 distantDeck( vec3 dir, float camY ) {
    // YOU SEE THE SURFACE FACING YOU, NOT THE MIDDLE.
    //
    // Round 1 intersected the deck's mid-plane and shaded that sample. From
    // below that is roughly right. From ABOVE it is the cloud's own interior:
    // the sunward march at hNorm 0.5 has the whole upper half of the deck
    // between it and the sun, so it came back 87% occluded and the far deck
    // rendered as a flat dull sheet while the near slabs a few kilometres away
    // showed white tops. Two representations of one deck, disagreeing.
    //
    // Intersect and sample the surface the viewer is actually looking at.
    float above = smoothstep( uCloudBase, uCloudTop, camY );
    float sampleH = mix( 0.12, 0.88, above );
    float planeY = mix( uCloudBase, uCloudTop, sampleH );
    float thickness = max( uCloudTop - uCloudBase, 1.0 );
    float dy = dir.y;
    if ( abs( dy ) < 1e-4 ) return vec4( 0.0 );
    float t = ( planeY - camY ) / dy;
    if ( t <= 0.0 ) return vec4( 0.0 );

    // THE HARD RECTANGLES AT THE HORIZON WERE THIS CLAMP.
    //
    // Round 2 clamped t at 120 km "well inside the fog budget". A flat deck seen
    // from below sends t to infinity as the ray approaches the horizon, so every
    // ray in the last fraction of a degree hit the clamp — and once t is a
    // CONSTANT, the hit point sweeps a circle of fixed radius and the density
    // becomes a function of AZIMUTH ALONE. That draws the deck as vertical bars
    // with hard left and right edges, sitting in a band above the horizon,
    // bounded below by the horizon and above by the ray where the clamp stops
    // binding. It is visible in three of five round-2 frames and unmistakable in
    // a 14-degree readback. Raising cloud coverage put more bars in view, which
    // is why more coverage made it worse.
    //
    // A clamp cannot be made to work here: any finite value produces the same
    // degenerate ring. What is needed is for the deck's CONTRIBUTION to reach
    // zero before the ray does anything strange. Past ~55 km a stratocumulus
    // deck subtends a third of a degree and is 80% airlight; past 105 km it is
    // below the noise floor of the sky it sits in. So it is faded out over that
    // span and the clamp beyond it never has anything left to draw.
    t = min( t, 140000.0 );
    float farFade = 1.0 - smoothstep( 55000.0, 105000.0, t );
    if ( farFade <= 0.0 ) return vec4( 0.0 );

    // HAND-OVER IS PROPORTIONAL, NOT ADDITIVE, and that is the other half of
    // the horizon artifact. A fixed 4 km fade band is a wide, soft gradient
    // overhead and a razor edge at the horizon, because near the horizon 4 km of
    // RANGE is a few arcminutes of ANGLE. Multiplying instead makes the band
    // constant in log-range, so it subtends a similar angle wherever it is seen
    // — a genuine gradient at the horizon instead of eight stacked ring edges.
    float handIn = smoothstep( uCloudHandover, uCloudHandover * uCloudHandWidth, t );
    if ( handIn <= 0.0 ) return vec4( 0.0 );

    // WORLD XZ, not camera-relative. The near slabs sample the same world XZ,
    // and that is the only reason the two representations of the deck line up
    // across the hand-over band.
    vec2 hit = cameraPosition.xz + dir.xz * t;
    // DETAIL HAS TO MATCH THE NEAR SLABS AT THE SEAM. The near field draws the
    // deck with the fBm fluff at full strength and this used to draw it at a
    // flat 0.55 everywhere, so even once the hand-over was a smooth gradient the
    // TEXTURE still changed across it and the eye read the change as an edge.
    // Ramp instead: full detail where the slabs are handing over, dropping away
    // with range because at 70 km the fluff is well under a pixel and can only
    // alias.
    float det = mix( 0.95, 0.30, smoothstep( 18000.0, 70000.0, t ) );
    float d = cloudDensity( hit, sampleH, det );
    float a = d * uCloudOpacity * handIn * farFade;
    if ( a <= 0.001 ) return vec4( 0.0 );

    // The same sunward march the near slabs use, at the same hNorm the near
    // slab at this height would use — so the cell that is bright at 18 km is
    // still the bright one at 22 km when the hand-over swaps which shader draws
    // it, and the deck does not change colour across the seam.
    float sunT = cloudSunLight( hit, sampleH, uSunDir, thickness );
    float lit = sunT * mix( 0.28, 1.0, smoothstep( 0.0, 0.85, sampleH ) );
    vec3 c = mix( uCloudShadow, uCloudLit, lit );

    // Silver lining where the deck is between you and the sun.
    float toSun = max( dot( dir, uSunDir ), 0.0 );
    c += uCloudLit * pow( toSun, 14.0 ) * 0.45 * ( 1.0 - d * 0.6 );

    // Aerial perspective on the deck itself, same model and same budget as
    // scene.fog — the deck is at a known altitude, so this is exact.
    vec3 T = aerialTransmittance( camY, planeY, t, uFogDensity );
    c = mix( uFogColor, c, T );
    return vec4( c, a );
  }

  void main() {
    vec3 dir = normalize( vDir );
    float camY = cameraPosition.y;

    // THE DOME IS EVALUATED WITH ITS ELEVATION FLOORED AT THE HORIZON.
    //
    // Preetham is undefined for dir.y < 0 — its air-mass term divides by a
    // cosine that has gone negative — so round 1 flooded the whole lower
    // hemisphere with a single flat uFogColor * 0.82. That is also what wiped
    // out the limb glow: the last 1.5 deg above the horizon was mixed 92% into
    // uFogColor, an AZIMUTHAL AVERAGE, so the one band of sky where a low sun
    // actually shows warm was the one band guaranteed to be grey.
    //
    // Flooring the sample direction instead keeps the model's azimuth
    // dependence everywhere: below the horizon you get the colour of the sky at
    // the horizon in THAT compass direction, darkened to ground haze. Costs
    // nothing — same single preetham() call.
    vec3 sampleDir = normalize( vec3( dir.x, max( dir.y, 0.0 ), dir.z ) );

    vec3 Fex;
    vec3 Lin = preetham( sampleDir, Fex );

    // Solar disc, added pre-tone-map so it blows out to white when the sun is
    // high and reddens on its own at sunset.
    float cosTheta = dot( dir, uSunDir );
    float sunDisc = smoothstep( SUN_DISC_COS, SUN_DISC_COS + 0.00002, cosTheta );
    Lin += uSunE * 6000.0 * Fex * sunDisc * uShowSunDisc;

    vec3 col = acesToneMap( Lin * SKY_SCALE * uExposure );


    // Night sky underneath, faded in as the sun sets.
    float upness = clamp( dir.y, 0.0, 1.0 );
    vec3 night = mix( uNightHorizon, uNightZenith, pow( upness, 0.55 ) );
    if ( uStars > 0.5 ) {
      night += ( starField( dir ) + milkyWay( dir ) ) * uStarFade * smoothstep( -0.06, 0.10, dir.y );
    }
    night += moon( dir );
    col += night * uNight;

    col += twilight( dir );

    // Below the horizon: haze over ground we are not drawing (the terrain patch
    // is finite, and beyond ~127 km there is nothing). col already holds the
    // horizon's colour for this azimuth, so all that is left is to darken it to
    // ground haze — the same GROUND_HAZE factor the fog chunk applies to
    // downward-looking rays, which is what makes the two meet where the terrain
    // patch ends. There is no mix toward an averaged fog colour any more: the
    // aerial-perspective fog reaches uFogColor asymptotically, never abruptly,
    // so there is no hard value for the dome to match.
    // Low edge FIRST. smoothstep(a, b, x) is UNDEFINED in GLSL for a >= b and
    // most desktop drivers do the sensible thing anyway, which is exactly how
    // that bug ships. check-sky.mjs greps for it.
    float below = 1.0 - smoothstep( -0.055, 0.0, dir.y );
    col *= mix( 1.0, GROUND_HAZE, below );

    if ( uClouds > 0.5 ) {
      vec4 deck = distantDeck( dir, camY );
      col = mix( col, deck.rgb, deck.a );
    }

    col = mix( col, uWhiteoutColor, uWhiteout );

    gl_FragColor = vec4( col, 1.0 );

    #include <colorspace_fragment>
  }
`;

// ---------------------------------------------------------------------------
// Near-field cloud slab shaders
// ---------------------------------------------------------------------------

/**
 * THE LOG-DEPTH CHUNKS ARE NOT OPTIONAL. main.js is required to build the
 * renderer with `logarithmicDepthBuffer: true` (MODULES.md 2.13 — the near/far
 * ratio is 0.35 m to 300 km and nothing else survives it). When that is on,
 * every material three compiles writes `gl_FragDepth = log2(w) * FC * 0.5`
 * instead of the interpolated hyperbolic z. A hand-written ShaderMaterial that
 * omits these chunks keeps writing the hyperbolic value, and then depth-tests
 * against a buffer full of logarithmic ones.
 *
 * The two curves are both monotonic in distance, so the bug does not look like
 * garbage — it looks like *plausible but wrong occlusion*. Worked example at
 * far = 300 km: terrain 60 km away writes 0.872, a cloud slab 5 km away writes
 * 0.99993, so the near cloud loses the depth test to ground twelve times
 * farther off and vanishes. Every cloud over open water, gone; the ones over
 * nearby hills, kept. It reads as a rendering glitch, not a depth bug.
 *
 * The `#ifdef` inside three's chunks makes all of this inert if the renderer
 * does not have the feature on, so this is safe either way. `<common>` is here
 * for `isPerspectiveMatrix()`, which `logdepthbuf_vertex` calls.
 *
 * The sky dome does not need any of it: it has depthTest and depthWrite off.
 */
const CLOUD_VERT = /* glsl */ `
  #include <common>
  #include <logdepthbuf_pars_vertex>
  varying vec3 vWorld;
  void main() {
    vec4 wp = modelMatrix * vec4( position, 1.0 );
    vWorld = wp.xyz;
    gl_Position = projectionMatrix * viewMatrix * wp;
    #include <logdepthbuf_vertex>
  }
`;

const CLOUD_FRAG = /* glsl */ `
  #include <logdepthbuf_pars_fragment>
  varying vec3 vWorld;

  uniform vec3 uSunDir;
  uniform vec3 uCloudLit;
  uniform vec3 uCloudShadow;
  uniform vec3 uFogColor;
  uniform float uFogDensity;

  uniform float uLayerY;
  uniform float uLayerH;       // 0..1 through the deck
  uniform float uLayerAlpha;
  uniform float uSelfFadeM;    // dissolve within this many metres of the camera's altitude
  uniform float uHandover;
  uniform float uHandWidth;    // hand-over ends at uHandover * uHandWidth
  uniform float uWhiteout;
  uniform float uDeckThickness;

  ${GLSL_AERIAL}
  ${GLSL_CLOUD_MACRO}
  ${GLSL_NOISE}
  ${GLSL_CLOUD_DENSITY}

  void main() {
    // Before the discards: the depth this fragment would occupy is a property of
    // the geometry, not of whether the cloud happens to be opaque here.
    #include <logdepthbuf_fragment>

    vec2 rel = vWorld.xz - cameraPosition.xz;
    float dist = length( rel );

    // Hand the deck over to the dome's analytic version before the slab's own
    // edge can come into view.
    //
    // PROPORTIONAL, and JITTERED PER SLAB. Both matter, and both are about the
    // horizon. A fixed 4 km band is a few arcminutes of angle out there, so each
    // slab ended at what was effectively a hard ring; eight slabs at eight
    // altitudes drew eight of those rings stacked inside about a degree of sky,
    // which is the horizontal half of the "hard rectangles" the round-2 critic
    // saw. Multiplying the band instead makes it constant in log-range and
    // therefore a real angular gradient, and staggering uHandover per slab
    // (see createSky) smears what is left of the eight edges across 10 km of
    // range so they can never line up into a visible step.
    float handOut = 1.0 - smoothstep( uHandover, uHandover * uHandWidth, dist );
    if ( handOut <= 0.0 ) discard;

    float d = cloudDensity( vWorld.xz, uLayerH, 1.0 );
    if ( d <= 0.002 ) discard;

    // Dissolve the slab you are level with. Without this you fly through a
    // plane seen edge-on, which is the single biggest tell that a cloud deck is
    // a stack of quads.
    float selfFade = smoothstep( 0.0, uSelfFadeM, abs( cameraPosition.y - uLayerY ) );

    float a = d * uLayerAlpha * handOut * selfFade * ( 1.0 - uWhiteout );
    if ( a <= 0.002 ) discard;

    // SHADING. Round 1 shaded purely by uLayerH, which is a constant across the
    // whole slab — so every slab was one flat tone and the deck read as eight
    // sheets of paper. The march toward the sun is what varies within a slab:
    // a cell's sunward flank is lit and its lee side is in its own shadow, and
    // because both are functions of world XZ they line up between slabs into a
    // single three-dimensional form.
    float sunT = cloudSunLight( vWorld.xz, uLayerH, uSunDir, uDeckThickness );
    // uLayerH still carries the base-to-top gradient; the deck's own bulk
    // shadows its underside whatever the sun is doing.
    float lit = sunT * mix( 0.28, 1.0, smoothstep( 0.0, 0.85, uLayerH ) );
    vec3 c = mix( uCloudShadow, uCloudLit, lit );

    vec3 view = normalize( vWorld - cameraPosition );
    float toSun = max( dot( view, uSunDir ), 0.0 );
    c += uCloudLit * pow( toSun, 10.0 ) * 0.28 * ( 1.0 - d * 0.7 );

    // Thin edges are optically thin: they transmit rather than reflect, so they
    // brighten toward the sun instead of darkening. Cheap, and it is what makes
    // the ragged rim of a cell read as vapour rather than as a cut-out.
    c += uCloudLit * ( 1.0 - smoothstep( 0.0, 0.45, d ) ) * 0.18 * sunT;

    vec3 T = aerialTransmittance( cameraPosition.y, vWorld.y, length( vWorld - cameraPosition ), uFogDensity );
    c = mix( uFogColor, c, T );

    gl_FragColor = vec4( c, a );

    #include <colorspace_fragment>
  }
`;

// ---------------------------------------------------------------------------
// JS mirror of the model
// ---------------------------------------------------------------------------

/** Module-scope scratch. §1.8: nothing here allocates per frame. */
const _fex = [0, 0, 0];
/**
 * The SUN ray's extinction, kept apart from `_fex`.
 *
 * `_fex` is evalSky's own scratch — every call to it, and there are a dozen per
 * relight between the horizon ring and the view-direction airlight, overwrites
 * `_fex` with the extinction along whatever VIEW ray it was just asked about.
 * applyLighting computed the sun's extinction into `_fex`, then derived the fog
 * colour (twelve evalSky calls), then read `_fex` again for the cloud colour.
 * It was reading the extinction along a 2.5 deg horizon ray, divided by the
 * sun ray's maximum. Measured with the sun 36 deg up, `cloudLit` came out sRGB
 * 0.668 / 0.506 / 0.453 — dull orange — which is why the cloud deck rendered as
 * a tan sheet at every time of day. It should be 1.000 / 0.933 / 0.815.
 *
 * Aliased module scratch is the cost of the no-allocation rule (§1.8); the
 * defence is that anything read across a call to another function in this file
 * gets its own array.
 */
const _sunFex = [0, 0, 0];
const _lin = [0, 0, 0];
const _acc = [0, 0, 0];
const _dir = [0, 0, 0];
const _tmp = [0, 0, 0];
const _sun = [0, 0, 0];

function acesToneMap(x) {
  const a = 2.51, b = 0.03, c = 2.43, d = 0.59, e = 0.14;
  return clamp((x * (a * x + b)) / (x * (c * x + d) + e), 0, 1);
}

function sunIntensity(cosZenith) {
  const z = clamp(cosZenith, -1, 1);
  return SUN_EE * Math.max(0, 1 - Math.exp(-((SUN_CUTOFF_ANGLE - Math.acos(z)) / SUN_STEEPNESS)));
}

/** Optical-depth multiplier for a ray leaving the ground at elevation `dirY`. */
function opticalInverse(dirY) {
  const za = Math.acos(Math.max(0, dirY));
  return 1 / (Math.cos(za) + 0.15 * Math.pow(93.885 - za * RAD_TO_DEG, -1.253));
}

/** Fills `out` with the extinction along that ray. Mirrors `extinction()` in GLSL. */
function extinctionJs(dirY, betaR, betaM, out) {
  const inv = opticalInverse(dirY);
  const sR = RAYLEIGH_ZENITH_LENGTH * inv;
  const sM = MIE_ZENITH_LENGTH * inv;
  for (let i = 0; i < 3; i++) out[i] = Math.exp(-(betaR[i] * sR + betaM[i] * sM));
  return out;
}

function rayleighPhaseJs(c) {
  return (3 / (16 * Math.PI)) * (1 + c * c);
}

function hgPhaseJs(c, g) {
  const g2 = g * g;
  return (1 / (4 * Math.PI)) * ((1 - g2) / Math.pow(1 - 2 * g * c + g2, 1.5));
}

/**
 * Line-for-line mirror of `preetham()` in SKY_FRAG, minus the sun disc.
 * Returns raw radiance in `out`; the caller tone-maps.
 */
function evalSky(dx, dy, dz, sunX, sunY, sunZ, betaR, betaM, sunE, mieG, out) {
  extinctionJs(dy, betaR, betaM, _fex);
  const cosTheta = dx * sunX + dy * sunY + dz * sunZ;
  const rPhase = rayleighPhaseJs(cosTheta * 0.5 + 0.5);
  const mPhase = hgPhaseJs(cosTheta, mieG);
  // Azimuth gate — mirrors preetham() in SKY_FRAG exactly. See the comment there.
  const towardSun =
    (dx * sunX + dz * sunZ) /
      Math.max(Math.hypot(sunX, sunZ) * Math.hypot(dx, dz), 1e-6) * 0.5 + 0.5;
  const horizonBlend =
    clamp(Math.pow(1 - sunY, 5), 0, 1) * lerp(0.15, 1, towardSun * towardSun);
  for (let i = 0; i < 3; i++) {
    const ratio = (betaR[i] * rPhase + betaM[i] * mPhase) / (betaR[i] + betaM[i]);
    const lin = Math.pow(sunE * ratio * (1 - _fex[i]), PREETHAM_CONTRAST);
    const alt = Math.pow(Math.max(0, sunE * ratio * _fex[i]), 0.5);
    out[i] = lin * (1 - horizonBlend + alt * horizonBlend);
  }
  return out;
}

const _sampleOut = [0, 0, 0];

/**
 * The dome's colour in one direction, tone-mapped — the same `evalSky` +
 * `acesToneMap` pair the fog colour and the GLSL both go through, so a harness
 * that scores this is scoring what gets drawn.
 *
 * Not a per-frame path: it rebuilds the scattering coefficients on every call.
 *
 * @param {number[]} dir unit view direction, scene axes
 * @param {number[]} sunDir unit direction toward the sun
 * @param {Partial<SkyOpts>} [opts] overrides on DEFAULTS
 * @param {number[]} [out] length-3 scratch
 * @returns {number[]} display-linear RGB, 0..1
 */
export function sampleSky(dir, sunDir, opts = {}, out = _sampleOut) {
  const cfg = { ...DEFAULTS, ...opts };
  const betaR = TOTAL_RAYLEIGH.map((v) => v * cfg.rayleigh);
  const mieC = 0.434 * (0.2 * cfg.turbidity * 1e-17) * cfg.mieCoefficient;
  const betaM = MIE_CONST.map((k) => mieC * k);
  const sunE = sunIntensity(sunDir[1]);
  // The dome floors the sample elevation at the horizon; mirror that here or
  // the harness would score a region the shader never evaluates.
  const y = Math.max(dir[1], 0);
  const n = Math.hypot(dir[0], y, dir[2]) || 1;
  evalSky(
    dir[0] / n, y / n, dir[2] / n,
    sunDir[0], sunDir[1], sunDir[2],
    betaR, betaM, sunE, cfg.mieDirectionalG, out,
  );
  for (let i = 0; i < 3; i++) {
    out[i] = acesToneMap(out[i] * SKY_RADIANCE_SCALE * cfg.exposure);
  }
  return out;
}

/**
 * The exact CPU mirror of `aerialTransmittance()` in GLSL, for the harness and
 * for anyone who needs to know how much contrast is left at a given range.
 * Same constants, same branch. Clear-air path only — the in-cloud grey-out is a
 * shader concern.
 *
 * @param {number} camY viewer altitude, metres MSL
 * @param {number} fragY target altitude, metres MSL
 * @param {number} dist slant range, metres
 * @param {number} density sea-level green extinction, per metre
 * @param {number[]} out length-3 scratch, filled with R/G/B transmittance
 */
export function aerialTransmittanceJs(camY, fragY, dist, density, out) {
  // Including the in-cloud grey-out, or this is not a mirror — and the one
  // number anybody checks against it (in-cloud visibility) lives on that branch.
  const grey = smoothstep01(2.0e-4, 2.0e-3, density);
  const y0 = Math.max(camY, AERIAL.floorM);
  const y1 = Math.max(fragY, AERIAL.floorM);
  const H = [lerp(AERIAL.hR, 1e7, grey), lerp(AERIAL.hM, 1e7, grey)];
  const column = [0, 0];
  for (let k = 0; k < 2; k++) {
    const x = (y1 - y0) / H[k];
    const shape = Math.abs(x) <= 1e-3 ? 1 - 0.5 * x : (1 - Math.exp(-x)) / x;
    column[k] = Math.exp(-y0 / H[k]) * shape * dist;
  }
  for (let i = 0; i < 3; i++) {
    const bR = lerp(AERIAL.betaR[i], 1, grey);
    const bM = lerp(AERIAL.betaM[i], 1, grey);
    const tau = density * (bR * column[0] + AERIAL.aerosolRatio * bM * column[1]);
    out[i] = Math.exp(-Math.min(tau, 60));
  }
  return out;
}

/** Module-scope smoothstep. The one inside createSky closes over nothing either. */
function smoothstep01(e0, e1, x) {
  if (e1 === e0) return x < e0 ? 0 : 1;
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
}

/**
 * The exact CPU mirror of `cloudMacro()` in GLSL. Sines survive the float32 /
 * float64 round trip to about 1e-5, which is why the deck's macro shape is
 * built from them — see the header note.
 *
 * @param {number} px scaled world X (world metres * cloudScale, plus drift)
 * @param {number} py scaled world Z
 * @returns {number} roughly -1..1
 */
function cloudMacroJs(px, py) {
  let s = 0;
  s += 1.0 * Math.sin(px * 0.91 + py * 0.37 + 0.7);
  s += 0.8 * Math.sin(px * 0.41 - py * 1.13 + 2.3);
  s += 0.65 * Math.sin(px * 1.73 + py * 1.51 + 4.1);
  s += 0.5 * Math.sin(-px * 2.29 + py * 0.67 + 5.6);
  s += 0.38 * Math.sin(px * 3.11 + py * 2.83 + 1.2);
  s += 0.28 * Math.sin(px * 4.37 - py * 3.91 + 3.9);
  return s / 3.61;
}

// ---------------------------------------------------------------------------

/**
 * @param {THREE.Scene} scene
 * @param {THREE.WebGLRenderer} renderer
 * @param {SkyOpts} [opts]
 * @returns {{
 *   update: (dt: number, sunAngle?: number) => void,
 *   setTimeOfDay: (t: number) => void,
 *   getTimeOfDay: () => number,
 *   sunLight: THREE.DirectionalLight,
 *   ambientLight: THREE.HemisphereLight,
 *   sunDirection: THREE.Vector3,
 *   moonLight: THREE.DirectionalLight,
 *   moonDirection: THREE.Vector3,
 *   getSunElevationDeg: () => number,
 *   isInCloud: () => boolean,
 *   setCloudCoverage: (c: number) => void,
 *   group: THREE.Group,
 *   shadows: ReturnType<typeof createShadows> | null,
 *   dispose: () => void,
 * }}
 */
export function createSky(scene, renderer, opts = {}) {
  const cfg = { ...DEFAULTS, ...opts };

  // -------------------------------------------------------------------------
  // Scattering coefficients. Constant for the life of the sky, so they are
  // computed once and shared by the shader uniforms and the JS evaluation.
  // -------------------------------------------------------------------------
  const betaR = TOTAL_RAYLEIGH.map((v) => v * cfg.rayleigh);
  const mieC = 0.434 * (0.2 * cfg.turbidity * 1e-17) * cfg.mieCoefficient;
  const betaM = MIE_CONST.map((k) => mieC * k);
  /**
   * sqrt of the luminance the sun ray keeps with the sun overhead — the
   * brightest this atmosphere ever gets. Used to normalise the cloud-top
   * brightness so it is 1.0 at the zenith and falls off exactly as the
   * DirectionalLight does. Constant for the life of the sky.
   */
  const zenithLum = (() => {
    const f = extinctionJs(1, betaR, betaM, [0, 0, 0]);
    return Math.max(Math.sqrt(0.2126 * f[0] + 0.7152 * f[1] + 0.0722 * f[2]), 1e-3);
  })();

  const group = new THREE.Group();
  group.name = 'sky';
  scene.add(group);

  // -------------------------------------------------------------------------
  // Lights. This module owns all of them.
  // -------------------------------------------------------------------------
  const ambientLight = new THREE.HemisphereLight(0xbfd8ff, 0x4a5a38, cfg.ambientIntensity);
  ambientLight.name = 'sky-ambient';
  scene.add(ambientLight);

  const sunLight = new THREE.DirectionalLight(0xfff3e0, cfg.sunIntensity);
  sunLight.name = 'sky-sun';
  scene.add(sunLight);
  // A directional light points from its position at its target; the target must
  // be in the graph even though the direction is position-independent.
  scene.add(sunLight.target);

  /**
   * Moonlight. Not in the MODULES.md § 2.8 return shape — it is additive, so
   * nothing breaks — but without it "night" is a scene with no directional
   * light at all and the terrain relief disappears entirely. `sunLight` stays
   * strictly the sun so `sunDirection` keeps the meaning the contract gives it.
   */
  const moonLight = new THREE.DirectionalLight(0xb9caff, 0);
  moonLight.name = 'sky-moon';
  scene.add(moonLight);
  scene.add(moonLight.target);

  /** Unit vector FROM the scene TOWARD the sun. Read-only for consumers. */
  const sunDirection = new THREE.Vector3(0, 1, 0);
  /** Unit vector FROM the scene TOWARD the moon. */
  const moonDirection = new THREE.Vector3(0, -1, 0);

  // -------------------------------------------------------------------------
  // Shadows. Owned here because a shadow-casting cascade IS a light (§1.7) and
  // because the cascades have to point along the sun, which is this module's
  // one job.
  //
  // The cascade lights are added to the scene AFTER sunLight and moonLight but
  // that does not decide their uniform index: WebGLLights sorts shadow casters
  // to the front, so the carriers are always 0..N-1 and the sun is always N.
  // shadows.js's shader patch depends on exactly that. See its header.
  //
  // `sunDirection` is handed over BY REFERENCE — applyLighting() rewrites it in
  // place every time the sun moves, so the cascades follow the sun with no
  // per-frame plumbing and shadows lengthen through dusk on their own.
  // -------------------------------------------------------------------------
  const shadows = cfg.shadows
    ? createShadows(scene, renderer, {
        quality: cfg.shadowQuality,
        sunDirection,
        aircraftReceives: cfg.aircraftReceivesShadow,
      })
    : null;

  // -------------------------------------------------------------------------
  // Fog. Colour is rewritten from the model every time the sun moves.
  // -------------------------------------------------------------------------
  const fogColor = new THREE.Color(0xbfd0dc);
  scene.fog = new THREE.FogExp2(fogColor.clone(), cfg.fogDensity);
  // The dome covers every pixel, so the clear colour is never seen; setting a
  // background as well would just be a second, disagreeing source of truth.
  scene.background = null;

  // -------------------------------------------------------------------------
  // Sky dome
  // -------------------------------------------------------------------------
  const uniforms = {
    uSunDir: { value: sunDirection },
    uMoonDir: { value: moonDirection },
    uBetaR: { value: new THREE.Vector3(betaR[0], betaR[1], betaR[2]) },
    uBetaM: { value: new THREE.Vector3(betaM[0], betaM[1], betaM[2]) },
    uSunE: { value: 0 },
    uMieG: { value: cfg.mieDirectionalG },
    uExposure: { value: cfg.exposure },
    uShowSunDisc: { value: 1 },

    uFogColor: { value: fogColor },
    uFogDensity: { value: cfg.fogDensity },

    uNight: { value: 0 },
    uStarFade: { value: 0 },
    uStars: { value: cfg.stars ? 1 : 0 },
    uNightZenith: { value: new THREE.Color(0.006, 0.011, 0.030) },
    uNightHorizon: { value: new THREE.Color(0.016, 0.024, 0.046) },
    uTwilightColor: { value: new THREE.Color(0.34, 0.16, 0.10) },
    uMoonBright: { value: 0 },

    uTime: { value: 0 },

    uClouds: { value: cfg.clouds ? 1 : 0 },
    uCloudBase: { value: cfg.cloudBaseM },
    uCloudTop: { value: cfg.cloudTopM },
    uCloudOpacity: { value: 0.92 },
    uCloudHandover: { value: cfg.cloudHandoverM },
    uCloudHandWidth: { value: CLOUD_HANDOVER_WIDTH },
    uCloudLit: { value: new THREE.Color(1, 1, 1) },
    uCloudShadow: { value: new THREE.Color(0.45, 0.47, 0.52) },
    uCloudCoverage: { value: cfg.cloudCoverage },
    uCloudScale: { value: cfg.cloudScale },
    uCloudDrift: { value: new THREE.Vector2(0, 0) },
    // Downwind lean, expressed in the same scaled units cloudMacro takes so it
    // adds straight onto the drift.
    uCloudShear: { value: new THREE.Vector2(0, 0) },
    uCloudSunDepth: { value: cfg.cloudSunDepth },

    uWhiteout: { value: 0 },
    uWhiteoutColor: { value: new THREE.Color(0.86, 0.88, 0.9) },
  };

  const skyMaterial = new THREE.ShaderMaterial({
    name: 'SkyAtmosphere',
    uniforms,
    vertexShader: SKY_VERT,
    fragmentShader: SKY_FRAG,
    side: THREE.BackSide,
    // Depth is off entirely rather than the usual `gl_Position.z = gl_Position.w`
    // trick: main.js runs a logarithmic depth buffer, and a shader that writes
    // gl_FragDepth in the same pass as one that does not is a class of bug not
    // worth inviting. renderOrder puts this first, it writes no depth, and
    // everything else lands on top of it against a cleanly cleared buffer.
    depthWrite: false,
    depthTest: false,
    fog: false,
  });

  const skyDome = new THREE.Mesh(new THREE.SphereGeometry(1, 32, 16), skyMaterial);
  skyDome.name = 'sky-dome';
  skyDome.scale.setScalar(20000); // anywhere between NEAR and FAR; never seen
  skyDome.renderOrder = -1000;
  skyDome.frustumCulled = false;
  group.add(skyDome);

  // -------------------------------------------------------------------------
  // Near-field cloud slabs
  // -------------------------------------------------------------------------
  /** @type {THREE.Mesh[]} */
  const cloudLayers = [];
  const cloudGeometry = cfg.clouds
    ? new THREE.PlaneGeometry(cfg.cloudRadiusM * 2, cfg.cloudRadiusM * 2, 1, 1)
    : null;

  const cloudLit = uniforms.uCloudLit.value;
  const cloudShadow = uniforms.uCloudShadow.value;

  if (cfg.clouds && cfg.cloudLayers > 0) {
    const n = Math.max(1, Math.round(cfg.cloudLayers));
    const thickness = Math.max(1, cfg.cloudTopM - cfg.cloudBaseM);
    // OPACITY OF ONE SLAB, FROM THE OPTICAL DEPTH IT STANDS IN FOR.
    //
    // Round 1 solved 1 - (1 - a)^n = 0.99 for a — "enough that a full column
    // stacks to opaque" — which gave 0.44 at eight layers. That is the right
    // answer to the wrong question. It makes the STACK opaque and leaves each
    // slab thin, so a viewer above the deck sees the lit top surface at 44%
    // over the deck's own shadowed interior. Measured, looking down at a
    // covered column from 2,450 m: terrain at sRGB 164,202,229 came out
    // 185,201,220 — the clouds read as a warm dusty veil laid over the ground
    // instead of as cloud tops, because more than half of every pixel was the
    // inside of the cloud.
    //
    // A slab is not a thin sample, it is a real slice of the deck. Its opacity
    // is what its own thickness attenuates: Beer-Lambert on stratocumulus,
    // extinction 3*LWC / (2*rho_water*r_eff) = 0.045 /m for 0.3 g/m^3 at a
    // 10 um effective radius. At 550 m over eight slabs that is 69 m per slab,
    // tau = 3.1, and a cell core is opaque — which is exactly what a cell core
    // is. `d` still scales it, so edges and thin cloud stay translucent.
    const CLOUD_EXTINCTION_PER_M = 0.045;
    const perLayerAlpha = 1 - Math.exp(-CLOUD_EXTINCTION_PER_M * (thickness / n));
    for (let i = 0; i < n; i++) {
      const h = n === 1 ? 0.5 : i / (n - 1);
      const y = cfg.cloudBaseM + h * thickness;
      const mat = new THREE.ShaderMaterial({
        name: `CloudSlab${i}`,
        uniforms: {
          uSunDir: uniforms.uSunDir,
          uCloudLit: uniforms.uCloudLit,
          uCloudShadow: uniforms.uCloudShadow,
          uFogColor: uniforms.uFogColor,
          uFogDensity: uniforms.uFogDensity,
          uCloudCoverage: uniforms.uCloudCoverage,
          uCloudScale: uniforms.uCloudScale,
          uCloudDrift: uniforms.uCloudDrift,
          uCloudShear: uniforms.uCloudShear,
          uCloudSunDepth: uniforms.uCloudSunDepth,
          uWhiteout: uniforms.uWhiteout,
          uLayerY: { value: y },
          uLayerH: { value: h },
          uLayerAlpha: { value: perLayerAlpha },
          uSelfFadeM: { value: Math.max(20, thickness / n) },
          // Staggered by the golden-ratio sequence so no two adjacent slabs
          // hand over at the same range — see CLOUD_FRAG's handOut.
          uHandover: {
            value: cfg.cloudHandoverM * (0.82 + 0.36 * ((i * 0.6180339887) % 1)),
          },
          uHandWidth: { value: CLOUD_HANDOVER_WIDTH },
          uDeckThickness: { value: thickness },
        },
        vertexShader: CLOUD_VERT,
        fragmentShader: CLOUD_FRAG,
        transparent: true,
        depthWrite: false,
        side: THREE.DoubleSide,
        fog: false,
      });
      const mesh = new THREE.Mesh(cloudGeometry, mat);
      mesh.name = `sky-cloud-${i}`;
      mesh.rotation.x = -Math.PI / 2; // +Y normal
      mesh.position.y = y;
      mesh.frustumCulled = false;
      mesh.userData.layerY = y;
      mesh.renderOrder = 900 + i;
      group.add(mesh);
      cloudLayers.push(mesh);
    }
  }

  // -------------------------------------------------------------------------
  // Environment map (image-based lighting)
  // -------------------------------------------------------------------------
  let pmrem = null;
  let envScene = null;
  let envDome = null;
  let envTexture = null;
  let envDirty = true;
  let lastEnvSunY = -99;

  if (cfg.environment && renderer) {
    try {
      pmrem = new THREE.PMREMGenerator(renderer);
      envScene = new THREE.Scene();
      // Same material, so the IBL is lit by the same sky — but with the solar
      // disc suppressed. Baking a 6000x radiance point into a prefiltered cube
      // produces a ring artefact on every rough surface in the scene.
      const envMat = skyMaterial.clone();
      envMat.uniforms = { ...uniforms, uShowSunDisc: { value: 0 }, uClouds: { value: 0 } };
      envDome = new THREE.Mesh(new THREE.SphereGeometry(5, 24, 12), envMat);
      envDome.frustumCulled = false;
      envScene.add(envDome);
      scene.environmentIntensity = cfg.environmentIntensity;
    } catch (err) {
      console.warn('[sky] environment map unavailable, falling back to lights only:', err);
      pmrem = null;
    }
  }

  function refreshEnvironment() {
    if (!pmrem || !envScene) return;
    try {
      const prev = envTexture;
      envTexture = pmrem.fromScene(envScene, 0, 1, 100).texture;
      scene.environment = envTexture;
      prev?.dispose();
    } catch (err) {
      console.warn('[sky] PMREM generation failed, disabling IBL:', err);
      pmrem.dispose?.();
      pmrem = null;
      scene.environment = null;
    }
  }

  // -------------------------------------------------------------------------
  // State
  // -------------------------------------------------------------------------
  let timeOfDay = clamp(cfg.timeOfDay, 0, 1);
  let sunElevationRad = 0;
  let elapsed = 0;
  let sunAngleOverride = null;
  let lastAppliedSunElev = 99;

  // Camera state, captured in the dome's onBeforeRender. update() runs before
  // render, so it is one frame stale — which is invisible, and much safer than
  // reaching for a camera this module is not given.
  const camPos = new THREE.Vector3(0, 0, 0);
  let haveCamera = false;

  let whiteout = 0;
  let cloudDim = 1; // sunlight multiplier from the deck overhead
  const driftDir = new THREE.Vector2(
    Math.sin(cfg.cloudWindDirDeg * DEG_TO_RAD),
    -Math.cos(cfg.cloudWindDirDeg * DEG_TO_RAD),
  );
  // The deck leans downwind by cloudShearM metres from base to top, converted
  // once into the scaled units cloudMacro takes. Fixed for the life of the sky:
  // it is the shape of the deck, not a per-frame animation.
  uniforms.uCloudShear.value.set(
    driftDir.x * cfg.cloudShearM * cfg.cloudScale,
    driftDir.y * cfg.cloudShearM * cfg.cloudScale,
  );

  const _c = new THREE.Color();

  /**
   * Coverage of the deck at a world XZ, from the CPU mirror of the macro shape.
   * The sub-kilometre fBm detail the shader adds is NOT mirrored, so this is
   * accurate about which cell you are in and approximate about the exact edge —
   * which is all the white-out needs.
   *
   * @param {number} x world metres east
   * @param {number} z world metres south
   * @param {number} hNorm 0 = deck base, 1 = deck top
   * @returns {number} 0..1
   */
  function cloudDensityJs(x, z, hNorm) {
    // The shear term is part of `cloudSamplePoint` in GLSL and must be here too,
    // or the CPU would think it was in clear air while the shader drew cloud —
    // and the white-out would fire in the wrong place by up to cloudShearM.
    const shear = uniforms.uCloudShear.value;
    const px = x * cfg.cloudScale + uniforms.uCloudDrift.value.x + shear.x * hNorm;
    const py = z * cfg.cloudScale + uniforms.uCloudDrift.value.y + shear.y * hNorm;
    const macro = cloudMacroJs(px, py) * 0.5 + 0.5;
    // CLOUD_ENVELOPE, not a second copy of the literals. See cloudCover() in GLSL.
    const envelope =
      smoothstepJs(0, CLOUD_ENVELOPE.base, hNorm) *
      (1 - smoothstepJs(CLOUD_ENVELOPE.top, 1, hNorm));
    const cover = uniforms.uCloudCoverage.value * lerp(CLOUD_ENVELOPE.floor, 1, envelope);
    const thr = 1 - cover;
    return smoothstepJs(thr, thr + 0.2, macro);
  }

  function smoothstepJs(e0, e1, x) {
    if (e1 === e0) return x < e0 ? 0 : 1;
    const t = clamp((x - e0) / (e1 - e0), 0, 1);
    return t * t * (3 - 2 * t);
  }

  /**
   * Solar geometry. Real spherical astronomy rather than a tilted circle,
   * because it is no more code and it puts sunrise in the northeast in June
   * instead of due east all year.
   *
   * With the default declination of 0 (equinox) this reduces exactly to the
   * mapping MODULES.md documents: t=0.25 sunrise due east, t=0.5 noon due
   * south at 42.5 deg for Seattle, t=0.75 sunset due west.
   */
  function sunAnglesFor(t, out) {
    const lat = cfg.latitudeDeg * DEG_TO_RAD;
    const dec = cfg.declinationDeg * DEG_TO_RAD;
    const H = (t - 0.5) * Math.PI * 2; // hour angle, 0 at local solar noon
    const sinAlt = clamp(
      Math.sin(lat) * Math.sin(dec) + Math.cos(lat) * Math.cos(dec) * Math.cos(H),
      -1,
      1,
    );
    const alt = Math.asin(sinAlt);
    const cosAlt = Math.cos(alt);
    const denom = cosAlt * Math.cos(lat);
    let az;
    if (Math.abs(denom) < 1e-7) {
      az = Math.PI;
    } else {
      az = Math.acos(clamp((Math.sin(dec) - sinAlt * Math.sin(lat)) / denom, -1, 1));
      if (Math.sin(H) > 0) az = Math.PI * 2 - az; // afternoon: swing west
    }
    az += (cfg.sunAzimuthDeg - 180) * DEG_TO_RAD;
    out.alt = alt;
    out.az = az;
    return out;
  }

  const _angles = { alt: 0, az: 0 };
  const _moonAngles = { alt: 0, az: 0 };

  /** True bearing + elevation -> scene direction. §1.2: bearing b = (sin b, 0, -cos b). */
  function setFromAltAz(vec, alt, az) {
    const ca = Math.cos(alt);
    vec.set(Math.sin(az) * ca, Math.sin(alt), -Math.cos(az) * ca).normalize();
    return vec;
  }

  /**
   * The horizon ring average, already tone-mapped. Written by `applyLighting`
   * (sun-driven, rare), read by `refreshFogColor` (camera-driven, per frame).
   */
  const ringFog = [0.8, 0.85, 0.88];
  let cachedSunE = 0;
  let cachedNight = 0;
  /** Unit horizontal heading the camera is looking along. */
  const viewAz = new THREE.Vector3(0, 0, -1);

  /**
   * THE FOG COLOUR FOLLOWS THE CAMERA'S HEADING, NOT JUST THE SUN.
   *
   * `scene.fog` has one colour for the whole frame, so the airlight distant
   * terrain fades into has to be a single value. Round 1 used the azimuthal
   * average of the horizon, and that is precisely what made a low sun's warm
   * limb impossible: look west at sunset and the mountains 60 km away were
   * tinted with the average of a copper western sky and a slate eastern one,
   * which is grey. The dome above them was orange. The seam was the whole
   * point of the fog colour existing.
   *
   * So the airlight is sampled from the model in the direction the camera is
   * actually pointing, at 2.5 deg elevation, and blended `fogViewBlend` of the
   * way from the ring average toward it. Full commitment (1.0) makes a
   * mountain on the left edge of a 70 deg frame take the colour of the sky in
   * the middle; the ring average damps that. 0.7 keeps the warm limb and keeps
   * the swing under a couple of sRGB units per degree of yaw.
   *
   * One evalSky per frame — about 40 flops, no allocation (§1.8).
   */
  function refreshFogColor() {
    const ex = cfg.exposure;
    // 2.5 deg above the horizon, along the camera's heading.
    const cEl = 0.99904, sEl = 0.04362;
    evalSky(
      viewAz.x * cEl, sEl, viewAz.z * cEl,
      _sun[0], _sun[1], _sun[2],
      betaR, betaM, cachedSunE, cfg.mieDirectionalG, _tmp,
    );
    const k = clamp(cfg.fogViewBlend, 0, 1);
    let fr = lerp(ringFog[0], acesToneMap(_tmp[0] * SKY_RADIANCE_SCALE * ex), k);
    let fg = lerp(ringFog[1], acesToneMap(_tmp[1] * SKY_RADIANCE_SCALE * ex), k);
    let fb = lerp(ringFog[2], acesToneMap(_tmp[2] * SKY_RADIANCE_SCALE * ex), k);

    // Night floor, so distance does not fade to pure black.
    fr = lerp(fr, 0.020, cachedNight);
    fg = lerp(fg, 0.026, cachedNight);
    fb = lerp(fb, 0.045, cachedNight);

    fogColor.setRGB(fr, fg, fb);
    // scene.fog gets it HERE, not only from the render hook. Publishing the fog
    // colour from onBeforeRender alone left it at its constructor value until
    // the first frame was drawn — and terrain.js reads scene.fog.color for the
    // sea's grazing-angle reflection, so the water spent the whole load screen
    // and the first frame reflecting a sky that did not exist yet.
    if (scene.fog) {
      if (whiteout > 0.001) {
        scene.fog.color.copy(fogColor).lerp(uniforms.uWhiteoutColor.value, whiteout);
      } else {
        scene.fog.color.copy(fogColor);
      }
    }
  }

  /**
   * Averages the sky over the horizon ring. The stable half of the fog colour:
   * it is what the airlight is at the edges of the frame, where the camera is
   * not looking.
   */
  function horizonAverage(sunE, out) {
    _acc[0] = _acc[1] = _acc[2] = 0;
    const N = 12;
    const el = 2.5 * DEG_TO_RAD;
    const cEl = Math.cos(el);
    const sEl = Math.sin(el);
    for (let i = 0; i < N; i++) {
      const az = (i / N) * Math.PI * 2;
      _dir[0] = Math.sin(az) * cEl;
      _dir[1] = sEl;
      _dir[2] = -Math.cos(az) * cEl;
      evalSky(
        _dir[0], _dir[1], _dir[2],
        _sun[0], _sun[1], _sun[2],
        betaR, betaM, sunE, cfg.mieDirectionalG, _tmp,
      );
      _acc[0] += _tmp[0];
      _acc[1] += _tmp[1];
      _acc[2] += _tmp[2];
    }
    for (let i = 0; i < 3; i++) out[i] = _acc[i] / N;
    return out;
  }

  /**
   * Recompute everything the sun's position drives: light colours and
   * intensities, fog colour, cloud shading, night blend. Called only when the
   * sun has actually moved (see `update`), so with a frozen clock this runs
   * once at boot.
   */
  function applyLighting() {
    const alt = sunElevationRad;
    setFromAltAz(sunDirection, alt, _angles.az);
    _sun[0] = sunDirection.x;
    _sun[1] = sunDirection.y;
    _sun[2] = sunDirection.z;

    const sunY = sunDirection.y;
    const sunE = sunIntensity(sunY);
    uniforms.uSunE.value = sunE;

    // -- night / twilight blends ------------------------------------------
    // Preetham is undefined below the horizon and collapses to black within a
    // degree or two of it, so everything from here down is explicit.
    const night = 1 - smoothstepJs(-0.14, 0.02, sunY);
    const starFade = smoothstepJs(-0.02, -0.16, sunY);
    uniforms.uNight.value = night;
    uniforms.uStarFade.value = starFade;

    // -- sun light ---------------------------------------------------------
    // Colour is the atmosphere's transmittance along the sun ray, from the same
    // betas the sky uses. That is why the light goes orange at precisely the
    // moment the sky does, with nothing tuned by hand.
    extinctionJs(Math.max(sunY, 0), betaR, betaM, _sunFex);
    const fexMax = Math.max(_sunFex[0], _sunFex[1], _sunFex[2], 1e-6);
    const lum = 0.2126 * _sunFex[0] + 0.7152 * _sunFex[1] + 0.0722 * _sunFex[2];
    const belowFade = clamp((sunY + 0.015) / 0.05, 0, 1);
    sunLight.color.setRGB(_sunFex[0] / fexMax, _sunFex[1] / fexMax, _sunFex[2] / fexMax);
    sunLight.intensity = cfg.sunIntensity * Math.sqrt(clamp(lum, 0, 1)) * belowFade * cloudDim;
    sunLight.position.copy(sunDirection).multiplyScalar(cfg.sunDistance);

    // -- moon --------------------------------------------------------------
    sunAnglesFor(timeOfDay + cfg.moonPhaseOffset, _moonAngles);
    setFromAltAz(moonDirection, _moonAngles.alt, _moonAngles.az);
    const moonUp = clamp(moonDirection.y * 6, 0, 1);
    moonLight.position.copy(moonDirection).multiplyScalar(cfg.sunDistance);
    moonLight.intensity = cfg.moonIntensity * moonUp * night * cloudDim;
    uniforms.uMoonBright.value = moonUp * night;

    // -- fog colour: the sky the terrain fades into ------------------------
    // Only the AZIMUTHAL AVERAGE is computed here, because this function runs
    // when the SUN moves and the fog colour also has to follow the CAMERA.
    // `refreshFogColor` finishes the job every frame; see it for why.
    horizonAverage(sunE, _lin);
    const ex = cfg.exposure;
    ringFog[0] = acesToneMap(_lin[0] * SKY_RADIANCE_SCALE * ex);
    ringFog[1] = acesToneMap(_lin[1] * SKY_RADIANCE_SCALE * ex);
    ringFog[2] = acesToneMap(_lin[2] * SKY_RADIANCE_SCALE * ex);

    // Pull 18% toward the zenith. Preetham's horizon is milk-white; real
    // distance haze is fractionally bluer because you are also seeing sky just
    // above the ridge line you are looking at.
    evalSky(0, 1, 0, _sun[0], _sun[1], _sun[2], betaR, betaM, sunE, cfg.mieDirectionalG, _tmp);
    for (let i = 0; i < 3; i++) {
      ringFog[i] = lerp(ringFog[i], acesToneMap(_tmp[i] * SKY_RADIANCE_SCALE * ex), 0.18);
    }

    cachedSunE = sunE;
    cachedNight = night;
    refreshFogColor();
    const fr = fogColor.r, fg = fogColor.g, fb = fogColor.b;

    // -- hemisphere fill ---------------------------------------------------
    // Sky half takes the actual zenith colour; ground half is a dim bounce off
    // the terrain, warmed by the sun's own colour so dusk fills warm.
    const zr = acesToneMap(_tmp[0] * SKY_RADIANCE_SCALE * ex);
    const zg = acesToneMap(_tmp[1] * SKY_RADIANCE_SCALE * ex);
    const zb = acesToneMap(_tmp[2] * SKY_RADIANCE_SCALE * ex);
    const zMax = Math.max(zr, zg, zb, 1e-4);
    ambientLight.color.setRGB(zr / zMax, zg / zMax, zb / zMax);
    ambientLight.color.lerp(_c.setRGB(0.42, 0.52, 0.78), night * 0.75);
    ambientLight.groundColor
      .setRGB(0.20, 0.19, 0.14)
      .lerp(sunLight.color, 0.25 * (1 - night))
      .lerp(_c.setRGB(0.05, 0.06, 0.10), night);

    const dayAmount = clamp(sunY * 3.2 + 0.12, 0, 1);
    ambientLight.intensity = lerp(
      cfg.nightAmbientIntensity,
      cfg.ambientIntensity,
      dayAmount,
    ) * lerp(1, 1.25, 1 - cloudDim); // overcast scatters more into the shadows

    // -- cloud shading -----------------------------------------------------
    // Derived from the tone-mapped sun and sky so the deck cannot disagree with
    // the light hitting the ground under it.
    // BRIGHTNESS OF A SUNLIT CLOUD TOP = HOW MUCH SUN THERE IS.
    //
    // Round 1 used its own ramp, 0.10 + 0.90 * clamp(sunY * 3), which is a
    // second opinion about the strength of the sunlight and disagreed with the
    // first one three lines above. Use the sun light's own falloff, normalised
    // against the sun at the zenith, so a cloud top and the ground under it are
    // lit by the same number and dusk dims them together.
    const litAmount = clamp((Math.sqrt(clamp(lum, 0, 1)) * belowFade) / zenithLum, 0, 1);
    cloudLit
      .setRGB(_sunFex[0] / fexMax, _sunFex[1] / fexMax, _sunFex[2] / fexMax)
      .lerp(_c.setRGB(1, 1, 1), 0.45)
      .multiplyScalar(litAmount);
    cloudLit.lerp(_c.setRGB(0.055, 0.065, 0.10), night);

    cloudShadow.copy(cloudLit).multiplyScalar(0.42).lerp(_c.setRGB(fr, fg, fb), 0.45);

    uniforms.uWhiteoutColor.value.copy(cloudLit).lerp(_c.setRGB(1, 1, 1), 0.35);

    if (Math.abs(sunY - lastEnvSunY) > 0.008) {
      envDirty = true;
      lastEnvSunY = sunY;
    }
  }

  /**
   * Per-frame camera-dependent work. Runs from the dome's onBeforeRender, which
   * three calls with the live camera immediately before the dome is drawn — and
   * the dome is drawn first, because renderOrder is -1000. So this lands before
   * anything else in the frame reads scene.fog.
   *
   * @param {THREE.Camera} camera
   */
  function syncToCamera(camera) {
    camPos.copy(camera.position);
    haveCamera = true;

    // Keep the dome around the camera. Safe here: three computes modelViewMatrix
    // immediately AFTER onBeforeRender returns (see WebGLRenderer#renderObject).
    skyDome.position.copy(camPos);
    skyDome.updateMatrixWorld(true);

    // Slabs follow the camera in XZ only; their altitude is the deck's, in
    // world space, because that is what makes climbing through it mean anything.
    const n = cloudLayers.length;
    const aboveDeck = camPos.y > (cfg.cloudBaseM + cfg.cloudTopM) * 0.5;
    for (let i = 0; i < n; i++) {
      const m = cloudLayers[i];
      m.position.set(camPos.x, m.userData.layerY, camPos.z);
      m.updateMatrixWorld(true);
      // Alpha compositing needs far-to-near. All the slabs share the camera's
      // XZ, so three's distance sort has nothing to separate them and picks an
      // arbitrary, flickering order — renderOrder has to say it explicitly.
      // The render list was already built when this runs, so the flip lands one
      // frame late; crossing the deck takes seconds and the white-out has the
      // slabs faded out anyway.
      m.renderOrder = 900 + (aboveDeck ? i : n - 1 - i);
    }

    // The airlight colour follows where the camera is pointing. getWorldDirection
    // writes into the target; no allocation (§1.8).
    camera.getWorldDirection(viewAz);
    viewAz.y = 0;
    if (viewAz.lengthSq() < 1e-8) viewAz.set(0, 0, -1);
    else viewAz.normalize();
    refreshFogColor();

    // NOTE ON `fogHeightScaleM`: it is now INERT, and deliberately so. It used
    // to scale a single FogExp2 density by exp(-camY/H) as a stand-in for the
    // fact that haze thins with altitude. The aerial-perspective model
    // integrates the real profile between the camera's altitude and the
    // fragment's, so applying the old factor as well would count the same
    // physics twice — and get it wrong, because the old form knew nothing about
    // where the fragment was. The option is kept so existing callers do not
    // break; it does nothing.
    if (scene.fog) {
      let density = cfg.fogDensity;
      const w = whiteout;
      if (w > 0.001) {
        // Target transmittance 0.05 at the stated in-cloud visibility. The
        // chunk goes grey and un-stratified at this magnitude, so both species
        // contribute their full length: tau = rho * L * (1 + aerosolRatio).
        const inCloud =
          3 / (Math.max(20, cfg.inCloudVisibilityM) * (1 + AERIAL.aerosolRatio));
        density = lerp(density, inCloud, w);
      }
      scene.fog.density = density;
      uniforms.uFogDensity.value = density;
      // The colour was already published by refreshFogColor() above, whiteout
      // blend included.
    }
  }

  skyDome.onBeforeRender = (_renderer, _scene, camera) => syncToCamera(camera);

  /**
   * The cascades have to be fitted with the LIVE camera, and they have to be
   * fitted BEFORE WebGLShadowMap runs — a frame-late shadow camera is a shadow
   * that lags the aeroplane across the runway.
   *
   * `scene.onBeforeRender` is the only hook that lands in that window:
   * WebGLRenderer#render calls it after `scene.updateMatrixWorld()` and
   * `camera.updateMatrixWorld()` and before `projectObject()` /
   * `shadowMap.render()`. Using it means main.js needs no shadow-specific line
   * at all — `renderer.render(scene, cameras.active)` is the whole integration.
   *
   * The previous handler is chained rather than replaced; nothing sets one
   * today, but this module is not the scene's owner.
   */
  const prevSceneBeforeRender = scene.onBeforeRender;
  scene.onBeforeRender = function (rendererRef, sceneRef, camera, target) {
    if (prevSceneBeforeRender) {
      prevSceneBeforeRender.call(this, rendererRef, sceneRef, camera, target);
    }
    if (shadows) shadows.update(camera);
  };

  /**
   * @param {number} dt Frame delta in SECONDS. Advances the clock when
   *        `dayLengthSec` is non-zero; otherwise time is frozen.
   * @param {number} [sunAngle] Optional override: sun elevation above the
   *        horizon in RADIANS. Supplying it does NOT change `timeOfDay`;
   *        passing it once latches the override until `setTimeOfDay` is called.
   */
  function update(dt, sunAngle) {
    const h = Number.isFinite(dt) ? clamp(dt, 0, 0.25) : 0;
    elapsed += h;
    uniforms.uTime.value = elapsed;

    // Wind drift, in the same scaled units cloudMacro takes, so the JS mirror
    // and both shaders stay in step.
    const drift = uniforms.uCloudDrift.value;
    drift.x -= driftDir.x * cfg.cloudWindMs * cfg.cloudScale * h;
    drift.y -= driftDir.y * cfg.cloudWindMs * cfg.cloudScale * h;

    if (typeof sunAngle === 'number' && Number.isFinite(sunAngle)) {
      sunAngleOverride = sunAngle;
    }

    if (sunAngleOverride === null && cfg.dayLengthSec > 0 && h > 0) {
      timeOfDay = (timeOfDay + h / cfg.dayLengthSec) % 1;
      sunAnglesFor(timeOfDay, _angles);
      sunElevationRad = _angles.alt;
    } else if (sunAngleOverride !== null) {
      sunElevationRad = sunAngleOverride;
    }

    // Cloud dimming + white-out, from the camera position captured last frame.
    if (cfg.clouds && haveCamera) {
      const base = cfg.cloudBaseM;
      const top = cfg.cloudTopM;
      const y = camPos.y;

      // Density directly overhead: an overcast column dims the ground beneath.
      const overheadH = y < base ? 0.5 : 1.0;
      const overhead = y < top ? cloudDensityJs(camPos.x, camPos.z, overheadH) : 0;
      const targetDim = lerp(1, 0.4, overhead * clamp((base - y) / 200 + 1, 0, 1));
      const newDim = damp(cloudDim, targetDim, 1.5, h);

      // Inside the deck AND inside a cell -> white-out.
      let target = 0;
      if (y > base - 25 && y < top + 25) {
        const hNorm = clamp((y - base) / Math.max(1, top - base), 0, 1);
        const d = cloudDensityJs(camPos.x, camPos.z, hNorm);
        const edge = smoothstepJs(base - 25, base + 30, y) * (1 - smoothstepJs(top - 30, top + 25, y));
        target = clamp(d * 1.25, 0, 1) * edge;
      }
      whiteout = damp(whiteout, target, 2.2, h);
      uniforms.uWhiteout.value = whiteout;

      if (Math.abs(newDim - cloudDim) > 1e-4) {
        cloudDim = newDim;
        lastAppliedSunElev = 99; // force a relight; the deck changed the light
      } else {
        cloudDim = newDim;
      }
    }

    // Only relight when the sun has actually moved. With a frozen clock this
    // makes update() a handful of arithmetic ops per frame.
    if (Math.abs(sunElevationRad - lastAppliedSunElev) > 1e-5) {
      lastAppliedSunElev = sunElevationRad;
      applyLighting();
    }

    if (envDirty && pmrem) {
      envDirty = false;
      refreshEnvironment();
    }
  }

  /**
   * @param {number} t Normalised time, 0..1. 0 = midnight, 0.25 = sunrise,
   *        0.5 = noon, 0.75 = sunset. Values outside 0..1 wrap. Clears any
   *        `sunAngle` override previously passed to `update`.
   */
  function setTimeOfDay(t) {
    timeOfDay = ((t % 1) + 1) % 1;
    sunAngleOverride = null;
    sunAnglesFor(timeOfDay, _angles);
    sunElevationRad = _angles.alt;
    lastAppliedSunElev = 99;
    applyLighting();
    envDirty = true;
  }

  /** @returns {number} Current normalised time of day, 0..1. */
  function getTimeOfDay() {
    return timeOfDay;
  }

  /** @returns {number} Sun elevation above the horizon, degrees. Negative at night. */
  function getSunElevationDeg() {
    return sunElevationRad * RAD_TO_DEG;
  }

  /** @returns {boolean} Is the camera inside the cloud deck right now? */
  function isInCloud() {
    return whiteout > 0.5;
  }

  /** @param {number} c 0 = clear, 1 = overcast. Takes effect on the next frame. */
  function setCloudCoverage(c) {
    uniforms.uCloudCoverage.value = clamp(c, 0, 1);
    envDirty = true;
  }

  function dispose() {
    shadows?.dispose();
    scene.onBeforeRender = prevSceneBeforeRender || function () {};
    skyDome.onBeforeRender = () => {};
    skyMaterial.dispose();
    skyDome.geometry.dispose();
    for (const m of cloudLayers) m.material.dispose();
    cloudGeometry?.dispose();
    envDome?.material.dispose();
    envDome?.geometry.dispose();
    envTexture?.dispose();
    pmrem?.dispose();
    scene.environment = null;
    group.removeFromParent();
    ambientLight.removeFromParent();
    sunLight.removeFromParent();
    sunLight.target.removeFromParent();
    moonLight.removeFromParent();
    moonLight.target.removeFromParent();
  }

  setTimeOfDay(timeOfDay);
  // First IBL bake happens on the first update(), when a render target is safe
  // to allocate; refreshing here would race a renderer that main.js has not
  // sized yet in some embeddings.

  return {
    update,
    setTimeOfDay,
    getTimeOfDay,
    sunLight,
    ambientLight,
    sunDirection,
    // --- additive, not part of the MODULES.md § 2.8 shape ---
    moonLight,
    moonDirection,
    getSunElevationDeg,
    isInCloud,
    setCloudCoverage,
    group,
    /**
     * The cascaded-shadow handle, or null when `opts.shadows === false`.
     * Additive; not part of the MODULES.md § 2.8 shape. Carries
     * `setQuality('off'|'low'|'medium'|'high')`, `setEnabled(bool)` and
     * `getStats()`.
     */
    shadows,
    dispose,
  };
}
