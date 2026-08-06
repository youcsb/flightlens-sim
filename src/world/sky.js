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
 * FOG IS A VISIBILITY BUDGET, NOT A MOOD SETTING
 * ---------------------------------------------------------------------------
 * Mount Rainier is 84 km from the spawn and seeing it is the headline proof
 * that our elevation data is real. FogExp2 attenuates by exp(-(d*density)^2),
 * so density must be chosen against that distance, not by eye at 2 km.
 * Measured (see the table in MODULES.md § 2.8, reproduced from the tuning rig):
 *
 *   density   5 km    20 km   45 km   84 km (Rainier)   127 km (map corner)
 *   8.0e-5    0.852   0.077   0.000   0.000             0.0000   <- invisible
 *   2.0e-5    0.990   0.852   0.445   0.059             0.0016   <- a ghost
 *   1.1e-5    0.997   0.953   0.783   0.426             0.1420   <- correct
 *   8.0e-6    0.998   0.975   0.878   0.637             0.3562   <- too clear
 *
 * If you raise the density, re-derive it against 84 km first.
 *
 * The one refinement on top of a plain FogExp2: haze is not uniform with
 * height. Aerosol scale height is ~2.5 km, so the density is scaled by
 * exp(-cameraY / fogHeightScaleM). At sea level nothing changes (Rainier stays
 * at the 0.426 above); at 3,000 ft the air genuinely clears and the mountain
 * sharpens. Set `fogHeightScaleM: 0` to disable.
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

/**
 * @typedef {Object} SkyOpts
 * -- documented in MODULES.md § 2.8 --
 * @property {number} [turbidity]      Atmospheric haze, Preetham T. Default 8.
 * @property {number} [fogDensity]     FogExp2 density at sea level. Default 1.1e-5.
 * @property {number} [timeOfDay]      Initial time, 0..1. Default 0.42.
 * @property {number} [sunDistance]    Sun light placement radius, metres. Default 120000.
 * @property {number} [sunAzimuthDeg]  Compass bearing the sun culminates over. Default 180.
 * @property {number} [dayLengthSec]   Real seconds per in-sim day. Default 0 = frozen.
 *
 * -- additions, all optional, all with working defaults --
 * @property {number} [rayleigh]       Rayleigh scattering multiplier. Default 3.
 * @property {number} [mieCoefficient] Mie scattering multiplier. Default 0.0025.
 * @property {number} [mieDirectionalG] Mie forward-scatter anisotropy. Default 0.76.
 * @property {number} [exposure]       Sky-local tone-map exposure. Default 0.36.
 * @property {number} [latitudeDeg]    Latitude for the solar arc. Default 47.5 (Seattle).
 * @property {number} [declinationDeg] Solar declination. Default 0 (equinox) — which
 *           is what makes t=0.25 exactly sunrise and t=0.75 exactly sunset.
 *           +23.4 = June solstice, -23.4 = December.
 * @property {number} [sunIntensity]   Peak DirectionalLight intensity. Default 2.6.
 * @property {number} [ambientIntensity] Peak HemisphereLight intensity. Default 1.05.
 * @property {number} [nightAmbientIntensity] Night floor. Default 0.055.
 * @property {number} [moonIntensity]  Peak moonlight DirectionalLight. Default 0.1.
 * @property {number} [moonPhaseOffset] Moon's offset along the day, 0..1. Default 0.5
 *           (full moon, opposite the sun, up all night).
 * @property {boolean} [environment]   Generate a PMREM IBL from the sky. Default true.
 * @property {number} [environmentIntensity] scene.environmentIntensity. Default 0.3.
 * @property {number} [fogHeightScaleM] Aerosol scale height. 0 disables. Default 2600.
 * @property {boolean} [clouds]        Build the cloud deck. Default true.
 * @property {number} [cloudCoverage]  0 = clear, 1 = overcast. Default 0.62 (broken).
 * @property {number} [cloudBaseM]     Deck base, metres MSL. Default 850 (~2800 ft).
 * @property {number} [cloudTopM]      Deck top, metres MSL. Default 1250.
 * @property {number} [cloudScale]     World metres -> macro-noise units. Default 1/1400.
 * @property {number} [cloudLayers]    Near-field slab count. Default 6.
 * @property {number} [cloudRadiusM]   Near-field slab half-width. Default 30000.
 * @property {number} [cloudHandoverM] Distance the near field hands over to the dome.
 *           Default 20000; the fade runs to +4 km.
 * @property {number} [cloudWindMs]    Deck drift speed. Default 7.
 * @property {number} [cloudWindDirDeg] Bearing the deck drifts TOWARD. Default 215.
 * @property {number} [inCloudVisibilityM] Visibility inside cloud. Default 190.
 * @property {boolean} [stars]         Star field + Milky Way band. Default true.
 */

const DEFAULTS = {
  turbidity: 8,
  fogDensity: 1.1e-5,
  timeOfDay: 0.42,
  sunDistance: 120000,
  sunAzimuthDeg: 180,
  dayLengthSec: 0,

  rayleigh: 3,
  mieCoefficient: 0.0025,
  mieDirectionalG: 0.76,
  exposure: 0.36,

  latitudeDeg: 47.5,
  declinationDeg: 0,

  sunIntensity: 2.6,
  ambientIntensity: 1.05,
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
  cloudLayers: 6,
  cloudRadiusM: 30000,
  cloudHandoverM: 20000,
  cloudWindMs: 7,
  cloudWindDirDeg: 215,
  inCloudVisibilityM: 190,

  stars: true,
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
 * than six identical stencils stacked in a pile.
 */
const GLSL_CLOUD_DENSITY = /* glsl */ `
  uniform float uCloudCoverage;
  uniform float uCloudScale;
  uniform vec2 uCloudDrift;

  float cloudDensity( vec2 worldXZ, float hNorm, float detail ) {
    vec2 p = worldXZ * uCloudScale + uCloudDrift;
    float macro = cloudMacro( p ) * 0.5 + 0.5;          // 0..1
    float fluff = fbm2( p * 3.7 ) - 0.5;                 // -0.5..0.5
    float field = clamp( macro + fluff * 0.34 * detail, 0.0, 1.0 );

    // Vertical envelope: full coverage through the middle of the deck, thinner
    // at the base and the top.
    float envelope = smoothstep( 0.0, 0.30, hNorm ) * ( 1.0 - smoothstep( 0.58, 1.0, hNorm ) );
    float cover = uCloudCoverage * mix( 0.55, 1.0, envelope );

    float thr = 1.0 - cover;
    return smoothstep( thr, thr + 0.20, field );
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

  ${GLSL_TONEMAP}
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

    vec3 Lin = pow( uSunE * ratio * ( 1.0 - Fex ), vec3( 1.5 ) );
    // Near the horizon the (1 - Fex) form saturates to white; Preetham's fix is
    // to cross-fade to the transmitted form, which is what puts the red back
    // into a low sun.
    float horizonBlend = clamp( pow( 1.0 - uSunDir.y, 5.0 ), 0.0, 1.0 );
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
    float mid = ( uCloudBase + uCloudTop ) * 0.5;
    float dy = dir.y;
    if ( abs( dy ) < 1e-4 ) return vec4( 0.0 );
    float t = ( mid - camY ) / dy;
    if ( t <= 0.0 ) return vec4( 0.0 );
    // Clamped well inside the fog budget: at 120 km the deck is already 82%
    // haze, and a shorter ray keeps the macro sines' arguments small enough
    // that float32 trig stays accurate.
    t = min( t, 120000.0 );

    float handIn = smoothstep( uCloudHandover, uCloudHandover + 4000.0, t );
    if ( handIn <= 0.0 ) return vec4( 0.0 );

    // WORLD XZ, not camera-relative. The near slabs sample the same world XZ,
    // and that is the only reason the two representations of the deck line up
    // across the hand-over band.
    vec2 hit = cameraPosition.xz + dir.xz * t;
    float d = cloudDensity( hit, 0.5, 0.55 );
    float a = d * uCloudOpacity * handIn;
    if ( a <= 0.001 ) return vec4( 0.0 );

    // Above the deck you see sunlit tops; below it, grey bases.
    float above = smoothstep( uCloudBase, uCloudTop, camY );
    vec3 c = mix( uCloudShadow, uCloudLit, mix( 0.12, 1.0, above ) );

    // Silver lining where the deck is between you and the sun.
    float toSun = max( dot( dir, uSunDir ), 0.0 );
    c += uCloudLit * pow( toSun, 14.0 ) * 0.45 * ( 1.0 - d * 0.6 );

    // Aerial perspective on the deck itself, same budget as scene.fog.
    float f = 1.0 - exp( -pow( t * uFogDensity, 2.0 ) );
    c = mix( c, uFogColor, f );
    return vec4( c, a );
  }

  void main() {
    vec3 dir = normalize( vDir );
    float camY = cameraPosition.y;

    vec3 Fex;
    vec3 Lin = preetham( dir, Fex );

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

    // Meet the terrain exactly. scene.fog fades distant geometry to uFogColor,
    // so the last degree of sky above the horizon has to arrive at the same
    // value or there is a visible seam all the way round.
    float toHorizon = 1.0 - smoothstep( -0.004, 0.026, dir.y );
    col = mix( col, uFogColor, toHorizon * 0.92 );
    // Below the horizon: haze over ground we are not drawing (the terrain patch
    // is finite, and beyond ~90 km there is nothing). Slightly darker than the
    // horizon, as ground haze is.
    float below = 1.0 - smoothstep( -0.09, -0.004, dir.y );
    col = mix( col, uFogColor * 0.82, below );

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

const CLOUD_VERT = /* glsl */ `
  varying vec3 vWorld;
  void main() {
    vec4 wp = modelMatrix * vec4( position, 1.0 );
    vWorld = wp.xyz;
    gl_Position = projectionMatrix * viewMatrix * wp;
  }
`;

const CLOUD_FRAG = /* glsl */ `
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
  uniform float uWhiteout;

  ${GLSL_CLOUD_MACRO}
  ${GLSL_NOISE}
  ${GLSL_CLOUD_DENSITY}

  void main() {
    vec2 rel = vWorld.xz - cameraPosition.xz;
    float dist = length( rel );

    // Hand the deck over to the dome's analytic version before the slab's own
    // edge can come into view.
    float handOut = 1.0 - smoothstep( uHandover, uHandover + 4000.0, dist );
    if ( handOut <= 0.0 ) discard;

    float d = cloudDensity( vWorld.xz, uLayerH, 1.0 );
    if ( d <= 0.002 ) discard;

    // Dissolve the slab you are level with. Without this you fly through a
    // plane seen edge-on, which is the single biggest tell that a cloud deck is
    // a stack of quads.
    float selfFade = smoothstep( 0.0, uSelfFadeM, abs( cameraPosition.y - uLayerY ) );

    float a = d * uLayerAlpha * handOut * selfFade * ( 1.0 - uWhiteout );
    if ( a <= 0.002 ) discard;

    // Tops catch the sun, bases are grey. uLayerH does the vertical shading and
    // it is the same number the density envelope used, so lighting and shape
    // agree.
    vec3 c = mix( uCloudShadow, uCloudLit, smoothstep( 0.1, 0.95, uLayerH ) );

    vec3 view = normalize( vWorld - cameraPosition );
    float toSun = max( dot( view, uSunDir ), 0.0 );
    c += uCloudLit * pow( toSun, 10.0 ) * 0.28 * ( 1.0 - d * 0.7 );

    float f = 1.0 - exp( -pow( dist * uFogDensity, 2.0 ) );
    c = mix( c, uFogColor, f );

    gl_FragColor = vec4( c, a );

    #include <colorspace_fragment>
  }
`;

// ---------------------------------------------------------------------------
// JS mirror of the model
// ---------------------------------------------------------------------------

/** Module-scope scratch. §1.8: nothing here allocates per frame. */
const _fex = [0, 0, 0];
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
  const horizonBlend = clamp(Math.pow(1 - sunY, 5), 0, 1);
  for (let i = 0; i < 3; i++) {
    const ratio = (betaR[i] * rPhase + betaM[i] * mPhase) / (betaR[i] + betaM[i]);
    const lin = Math.pow(sunE * ratio * (1 - _fex[i]), 1.5);
    const alt = Math.pow(Math.max(0, sunE * ratio * _fex[i]), 0.5);
    out[i] = lin * (1 - horizonBlend + alt * horizonBlend);
  }
  return out;
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
    uCloudLit: { value: new THREE.Color(1, 1, 1) },
    uCloudShadow: { value: new THREE.Color(0.45, 0.47, 0.52) },
    uCloudCoverage: { value: cfg.cloudCoverage },
    uCloudScale: { value: cfg.cloudScale },
    uCloudDrift: { value: new THREE.Vector2(0, 0) },

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
    // Enough per-slab alpha that a fully covered column stacks to opaque:
    // 1 - (1 - a)^n ~= 0.99.
    const perLayerAlpha = 1 - Math.pow(0.01, 1 / n);
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
          uWhiteout: uniforms.uWhiteout,
          uLayerY: { value: y },
          uLayerH: { value: h },
          uLayerAlpha: { value: perLayerAlpha },
          uSelfFadeM: { value: Math.max(20, thickness / n) },
          uHandover: { value: cfg.cloudHandoverM },
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
    const px = x * cfg.cloudScale + uniforms.uCloudDrift.value.x;
    const py = z * cfg.cloudScale + uniforms.uCloudDrift.value.y;
    const macro = cloudMacroJs(px, py) * 0.5 + 0.5;
    const envelope =
      smoothstepJs(0, 0.3, hNorm) * (1 - smoothstepJs(0.58, 1, hNorm));
    const cover = uniforms.uCloudCoverage.value * lerp(0.55, 1, envelope);
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
   * Averages the sky over the horizon ring. This is the colour distant terrain
   * has to fade into, so it is measured, not chosen.
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
    extinctionJs(Math.max(sunY, 0), betaR, betaM, _fex);
    const fexMax = Math.max(_fex[0], _fex[1], _fex[2], 1e-6);
    const lum = 0.2126 * _fex[0] + 0.7152 * _fex[1] + 0.0722 * _fex[2];
    const belowFade = clamp((sunY + 0.015) / 0.05, 0, 1);
    sunLight.color.setRGB(_fex[0] / fexMax, _fex[1] / fexMax, _fex[2] / fexMax);
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
    horizonAverage(sunE, _lin);
    const ex = cfg.exposure;
    let fr = acesToneMap(_lin[0] * SKY_RADIANCE_SCALE * ex);
    let fg = acesToneMap(_lin[1] * SKY_RADIANCE_SCALE * ex);
    let fb = acesToneMap(_lin[2] * SKY_RADIANCE_SCALE * ex);

    // Pull 18% toward the zenith. Preetham's horizon is milk-white; real
    // distance haze is fractionally bluer because you are also seeing sky just
    // above the ridge line you are looking at.
    evalSky(0, 1, 0, _sun[0], _sun[1], _sun[2], betaR, betaM, sunE, cfg.mieDirectionalG, _tmp);
    fr = lerp(fr, acesToneMap(_tmp[0] * SKY_RADIANCE_SCALE * ex), 0.18);
    fg = lerp(fg, acesToneMap(_tmp[1] * SKY_RADIANCE_SCALE * ex), 0.18);
    fb = lerp(fb, acesToneMap(_tmp[2] * SKY_RADIANCE_SCALE * ex), 0.18);

    // Night floor, so distance does not fade to pure black.
    fr = lerp(fr, 0.020, night);
    fg = lerp(fg, 0.026, night);
    fb = lerp(fb, 0.045, night);

    fogColor.setRGB(fr, fg, fb);
    if (scene.fog) scene.fog.color.setRGB(fr, fg, fb);

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
    const litAmount = 0.10 + 0.90 * clamp(sunY * 3.0, 0, 1);
    cloudLit
      .setRGB(_fex[0] / fexMax, _fex[1] / fexMax, _fex[2] / fexMax)
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

    // Aerosols are concentrated in the lowest couple of kilometres, so the fog
    // budget thins with altitude. At sea level this is a no-op.
    if (scene.fog) {
      let density = cfg.fogDensity;
      if (cfg.fogHeightScaleM > 0) {
        density *= Math.exp(-Math.max(0, camPos.y) / cfg.fogHeightScaleM);
      }
      const w = whiteout;
      if (w > 0.001) {
        // exp(-(d*rho)^2) = 0.05 at the stated visibility.
        const inCloud = Math.sqrt(3) / Math.max(20, cfg.inCloudVisibilityM);
        density = lerp(density, inCloud, w);
      }
      scene.fog.density = density;
      uniforms.uFogDensity.value = density;
      if (w > 0.001) {
        scene.fog.color.copy(fogColor).lerp(uniforms.uWhiteoutColor.value, w);
      } else if (!scene.fog.color.equals(fogColor)) {
        scene.fog.color.copy(fogColor);
      }
    }
  }

  skyDome.onBeforeRender = (_renderer, _scene, camera) => syncToCamera(camera);

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
    dispose,
  };
}
