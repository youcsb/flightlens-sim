/**
 * main.js — the composition root and the render loop.
 *
 * This file owns the wiring and NOTHING else. Every subsystem lives behind the
 * interfaces documented in MODULES.md. If you find yourself writing terrain
 * maths, aerodynamics, or gauge drawing here, it belongs in a module instead.
 *
 * ---------------------------------------------------------------------------
 * BOOTSTRAP ORDER — the dependencies are real, do not shuffle these
 * ---------------------------------------------------------------------------
 *   1. setOrigin()            every projection below is relative to it
 *   2. await createTerrain()  loads the DEM; nothing can be placed on the
 *                             ground until elevation is queryable
 *   3. createSky()            owns every light and the fog
 *   4. await loadAirports()   needs elevation to sit runways on the terrain
 *   5. buildRunwayMeshes()    "
 *   6. placeLandmarks()       "  (self-populating, no await needed)
 *   7. createAircraft()
 *   8. createFlightModel()    needs a ground sampler and the spawn coordinates
 *
 * ---------------------------------------------------------------------------
 * PER-FRAME ORDER — later stages read what earlier ones wrote
 * ---------------------------------------------------------------------------
 *   1. sample input
 *   2. query ground height under the aircraft
 *   3. step the flight model
 *   4. copy state onto the aircraft group + animate its surfaces
 *   5. update terrain streaming, sky, cameras
 *   6. update instruments, sound
 *   7. render
 *
 * ---------------------------------------------------------------------------
 * ON THE FIXED TIMESTEP
 * ---------------------------------------------------------------------------
 * The loop hands `flightModel.step()` a wall-clock delta and the flight model
 * substeps it internally at a fixed 1/240 s with an accumulator. That is the
 * right place for it: the integrator's stability limit is a property of the
 * gear springs and the inertia tensor, which only that module knows. What THIS
 * file owes it is a sane delta — clamped, monotonic, and never accumulated
 * while paused. See `dtFor()`.
 */

import * as THREE from 'three';

import { setOrigin, DEFAULT_ORIGIN, distanceBetween, bearingBetween } from './geo/coords.js';
import { getRegionStats, warmAt } from './geo/elevation.js';
import { applyGeoBudgets, describeGeoBudgets } from './geo/geoBudgets.js';
import { configureTextures, describeTextureBudget } from './core/textureBudget.js';
import { loadAirports, buildRunwayMeshes, getSpawn } from './geo/airports.js';
import { placeLandmarks } from './geo/landmarks.js';
import { setBuildingBudget } from './geo/buildings.js';
import { createTerrain } from './world/terrain.js';
import { createSky } from './world/sky.js';
import { createAircraft } from './aircraft/model.js';
import { createFlightModel } from './physics/flightModel.js';
import { createInstruments } from './ui/instruments.js';
import { createOverlay } from './ui/overlay.js';
import { createInput } from './controls/input.js';
import { createCameras } from './camera/cameras.js';
import { createSoundscape } from './audio/soundscape.js';
import { createAutopilot } from './systems/autopilot.js';
import { eventCode } from './core/keycode.js';
import {
  resolveDevice,
  budgetsFor,
  effectivePixelRatio,
  describeDevice,
  TIERS,
} from './core/device.js';

const appEl = document.getElementById('app');
const hudEl = document.getElementById('hud');

/** Consecutive auto-repeats of the heading-bug key, for the acceleration ramp. */
let hdgRepeat = 0;
/** Consecutive auto-repeats of the altitude-bug key. Same ramp, coarser steps. */
let altRepeat = 0;

/**
 * The only keys a HELD press should keep firing. Everything else in
 * `onKeyDown` is a toggle or a teleport, and a repeat on one of those is a
 * bug — see the guard in `onKeyDown` for what this replaced and why.
 *
 * All four are bug setters: they nudge a target the autopilot will fly to.
 * Nudging is inherently a "do it again until it looks right" gesture, so it is
 * the one thing here that has to survive a finger left on the button.
 */
const REPEATABLE_KEYS = new Set(['BracketLeft', 'BracketRight', 'KeyU', 'KeyJ']);

// ---------------------------------------------------------------------------
// Places you can start from.
//
// Every coordinate here is REAL. The two ground starts resolve through
// airports.js so they land on the surveyed threshold rather than on a number
// typed in this file; the two airborne ones are positioned relative to the
// landmark they are meant to show, with the heading solved so the subject is
// in the windscreen on the first frame.
// ---------------------------------------------------------------------------
const SPACE_NEEDLE = { lat: 47.6204, lon: -122.3491 };
const RAINIER = { lat: 46.8517, lon: -121.7603 };

const PLACES = [
  {
    label: 'KBFI · Boeing Field',
    sub: 'runway 32L, engine running',
    airport: { ident: 'KBFI', end: '32L' },
    throttle: 0,
  },
  {
    label: 'KSEA · Sea-Tac',
    sub: 'runway 16C, 8.8 km south',
    airport: { ident: 'KSEA', end: '16C' },
    throttle: 0,
  },
  {
    label: 'Over downtown',
    sub: '2,000 ft, Space Needle ahead',
    // 5.6 km south-southeast of the Needle, pointed at it.
    lat: 47.5700,
    lon: -122.3390,
    aimAt: SPACE_NEEDLE,
    altitudeAglM: 610, // 2,000 ft
    airspeedMs: 51, // ~100 kt
    throttle: 0.7,
  },
  {
    label: 'Mount Rainier',
    sub: '11,000 ft, 12 km north of the summit',
    lat: 46.9600,
    lon: -121.7603,
    aimAt: RAINIER,
    altitudeMslM: 3350, // 11,000 ft — below the 4,392 m summit, on purpose
    airspeedMs: 54,
    throttle: 0.8,
  },
];

/**
 * Time-of-day presets for the T key. `t` is sky.js's 0..1 clock.
 *
 * THESE ARE SOLVED, NOT GUESSED, and two of them were wrong. sky.js turns `t`
 * into a sun elevation through a real solar-position formula at latitude 47.5
 * with declination 0 (its shipped default — equinox), so what a preset is
 * called has to match what the sun actually does:
 *
 *     alt(t) = asin( cos(47.5 deg) * cos((t - 0.5) * 2pi) )
 *
 * Round 1's 'golden hour' at 0.76 puts the sun 2.43 degrees BELOW the horizon
 * and its 'sunset' at 0.795 puts it 10.86 degrees below — that is nautical
 * twilight, which is to say night with a glow. Both rendered as a dark sky with
 * no sun in it, and neither name described what you saw.
 *
 * Golden hour is conventionally the sun between the horizon and about 6
 * degrees, so 0.725 (6.07 deg) sits at the top of that band with the light
 * still warm and long. Sunset is the disc on the horizon: 0.748 is 0.49 deg,
 * a half-degree up, which is the sun's own angular radius — it is touching.
 */
const TIMES = [
  { t: 0.42, label: 'mid-morning' }, // 36.3 deg
  { t: 0.5, label: 'noon' }, // 42.5 deg
  { t: 0.68, label: 'afternoon' }, // 16.7 deg
  { t: 0.725, label: 'golden hour' }, // 6.07 deg
  { t: 0.748, label: 'sunset' }, // 0.49 deg — the disc on the horizon
  { t: 0.95, label: 'night' }, // -39.98 deg
  { t: 0.255, label: 'sunrise' }, // 1.22 deg
];

// ---------------------------------------------------------------------------
// Device tier — resolved BEFORE the renderer, because two of its constructor
// options are budget decisions (`antialias`) and one of its first calls is
// (`setPixelRatio`). See core/device.js for the rules and every number.
//
// A phone at devicePixelRatio 3 renders nine times the pixels per CSS pixel,
// which is the single easiest framerate cliff in the project; and iOS Safari
// terminates a tab in the 200-400 MB range, counting GPU allocations, so the
// budgets are a survival requirement rather than a preference.
//
// `?tier=phone` on the URL, or localStorage['sim.tier'], forces a tier — that
// is how a phone budget is measured on a desktop without a phone.
// ---------------------------------------------------------------------------
const device = resolveDevice({
  search: typeof location !== 'undefined' ? location.search : '',
  storage: (() => {
    try {
      return typeof localStorage !== 'undefined' ? localStorage : null;
    } catch {
      return null; // private mode throws on access, not on use
    }
  })(),
});
/** Mutable: window.sim.setQuality() reassigns it. Read it, do not cache it. */
let budgets = device.budgets;
console.info(describeDevice(device));

// The footprint loader is started by landmarkModels.js, not from here, so the
// size budget has to be handed to the module rather than passed at a call site.
// It must land before that load begins — hence here, next to the tier that
// produced it. Boot-time only, like the other three (§2.18).
setBuildingBudget(budgets.buildings);

// ---------------------------------------------------------------------------
// Renderer + scene
// ---------------------------------------------------------------------------
const renderer = new THREE.WebGLRenderer({
  // MSAA is a tier decision. On a tile GPU the resolve costs bandwidth, and the
  // phone tier buys its edges with a 1.5x supersample instead (device.js).
  antialias: budgets.antialias,
  powerPreference: 'high-performance',
  // REQUIRED. The camera far plane is 300 km (Mount Rainier is 84 km out) and
  // the near plane is 0.35 m for the cockpit view. A linear depth buffer cannot
  // span that range without severe z-fighting. See camera/cameras.js.
  //
  // It is ALSO load-bearing for sky.js's cloud slabs, which are a hand-written
  // ShaderMaterial carrying the logdepthbuf chunks: without the feature flag
  // those chunks compile to nothing and the clouds keep their hyperbolic depth,
  // which loses the depth test against terrain twelve times farther away.
  logarithmicDepthBuffer: true,
});
/**
 * Apply the tier's pixel-ratio budget to the current viewport.
 *
 * Called at boot AND on every resize, because the binding ceiling is an
 * absolute pixel count as well as a ratio: rotating a phone into landscape
 * changes the area, and therefore the ratio that fits inside it.
 */
function applyPixelRatio() {
  const r = effectivePixelRatio(
    budgets,
    window.devicePixelRatio,
    window.innerWidth,
    window.innerHeight,
  );
  if (renderer.getPixelRatio() !== r) renderer.setPixelRatio(r);
  return r;
}
applyPixelRatio();
renderer.setSize(window.innerWidth, window.innerHeight);
// NO TONE MAPPING, deliberately. sky.js evaluates Preetham and hands the
// terrain and water shaders absolute-ish radiance already scaled for direct
// display, and its JS fog colour is the mirror of what the dome draws. Putting
// an ACES curve in front of that desaturates the dome without touching the fog
// value the water reflects, so the sea stops matching the sky it is reflecting.
// If tone mapping is ever wanted, it has to be added inside sky.js's own
// calibration, not bolted on here.
appEl.appendChild(renderer.domElement);

const scene = new THREE.Scene();

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
let running = true;
let dispose = () => {
  running = false;
};

/** Replaced with the real implementation once the world exists. */
let gotoPlace = () => {};

// The overlay goes up FIRST, before the three-second DEM load, so the user is
// looking at a loading screen rather than at a black rectangle.
const overlay = createOverlay(hudEl, {
  locations: PLACES,
  onGoto: (i) => gotoPlace(i),
});

async function boot() {
  // 1. Anchor the projection. Everything placed after this is relative to it.
  setOrigin(DEFAULT_ORIGIN.lat, DEFAULT_ORIGIN.lon);

  // 1b. Hand the tier to the two geo modules that hold real memory. MUST be
  // before createTerrain(): it registers the DEM layers and decodes the
  // land-cover rasters, and both are boot-time-only decisions. See
  // geo/geoBudgets.js.
  console.info(describeGeoBudgets(applyGeoBudgets(budgets)));

  // 1c. And the texture budget, for the four generators that draw one. Same
  // rule as above and for the same reason: a texture is rasterised once, so
  // this must precede createTerrain() (the region field), createAircraft()
  // (the livery) and buildRunwayMeshes() (the numeral atlas). MEASURED at the
  // phone tier: 45.1 MB of texture across the scene, 16.6 MB of it typed
  // arrays that never leave the JS heap. See core/device.js § PHONE_TEXTURE_SCALE.
  console.info(describeTextureBudget(configureTextures(budgets.tier)));

  // 2. Terrain loads the DEM and is the gate for every ground query below.
  overlay.setLoadingText('loading elevation tiles…');
  await nextFrame(); // let the loading screen actually paint before we block
  // `lodQuality` is the tier's largest single lever: node count scales as its
  // square, and the node geometry cache is the largest term in the JS heap
  // (~199 MB at quality 1). `viewRadiusM` is NOT a tier decision — Mount
  // Rainier is 84 km out and §1.5 says simplify the tessellation, never the
  // extent — so every tier passes the same 90 km.
  const terrain = await createTerrain(scene, {
    lodQuality: budgets.terrainLodQuality,
    viewRadiusM: budgets.terrainViewRadiusM,
  });

  overlay.setLoadingText('lighting the sky…');
  await nextFrame();
  // WEATHER IS A COMPOSITION DECISION, and it is made here rather than in
  // sky.js because sky.js's defaults are right for "a Tuesday in Seattle" and
  // this sim exists to show the user real geography.
  //
  // Those defaults are turbidity 8 with a broken stratus deck at 850–1,250 m.
  // Both are honest — and together they put a white ceiling across the whole
  // sky at exactly the altitude a light aircraft flies, so Mount Rainier at
  // 84 km disappears into it and the Space Needle is seen through haze. The
  // fog budget in §2.8 was derived to keep Rainier at ~40% contrast; there is
  // no point paying for that and then hiding the mountain behind a cloud.
  //
  // So: a clear-air day (turbidity 3.2 is still hazier than a mountain
  // horizon), scattered cumulus, and the deck lifted to 1,500 m — 4,900 ft,
  // above circuit height and above every hill in the region except Rainier
  // itself, which now comes through the gaps rather than sitting behind them.
  //
  // CLOUD COVERAGE AND DECK ALTITUDE, and the two have to be chosen together.
  //
  // Round 1 asked for 0.33 at 1,500-2,050 m. 0.33 does not render as the
  // "scattered cumulus" the comment claims — sky.js's coverage is a threshold
  // on a noise field and 0.33 is below the knee, so it draws a few wisps at the
  // horizon and clear sky everywhere else. 0.55 is where a real broken deck
  // appears.
  //
  // But raising the coverage at 1,500 m made the sim worse, and the readback is
  // what caught it: 1,500-2,050 m is 4,900-6,700 ft, which is exactly where a
  // light aircraft cruises. At 0.33 you flew through the gaps; at 0.55
  // `sky.isInCloud()` returned true at the Mount Rainier viewpoint and the
  // frame was a white rectangle.
  //
  // So the deck goes up rather than the coverage back down. 2,600-3,200 m is
  // 8,500-10,500 ft: above everything a Skyhawk does on a normal day, below
  // Rainier's 4,392 m summit — so the mountain now stands THROUGH the deck
  // instead of behind it, which is the shot this sim exists to show.
  const sky = createSky(scene, renderer, {
    timeOfDay: TIMES[0].t,
    turbidity: 3.2,
    cloudCoverage: 0.55,
    cloudBaseM: 2600,
    cloudTopM: 3200,
    // Cascaded shadow maps, owned by sky.js because a shadow-casting cascade
    // IS a light and §1.7 gives every light to that module. It fits the
    // cascades from `scene.onBeforeRender`, so there is no per-frame call here.
    // Tier decision. Shadows cost DRAW CALLS, not fill (shadows.js measured
    // that shrinking every map from 2048 to 256 changed the frame time by
    // nothing), and the phone tier's whole call budget is 120 against the
    // desktop's 432 — so the phone gets the 'off' tier. Desktop still gets
    // 'high' and nothing about it changes.
    //
    // The shadow SYSTEM is always constructed, even at 'off'. Passing
    // `shadows: false` would leave `sky.shadows` null and make the runtime
    // override one-way; at 'off' the handle exists, builds no cascade lights,
    // and turns the renderer's shadow pass off itself. What it still costs is
    // one `scene.traverse` per frame for tagging, which on a phone-tier scene
    // is a few hundred objects.
    shadows: true,
    shadowQuality: budgets.shadowQuality,
  });

  // 3-4. Real airports at real coordinates, sitting on the real terrain.
  overlay.setLoadingText('surveying runways…');
  await nextFrame();
  const airports = await loadAirports();
  const runways = buildRunwayMeshes(scene, airports);

  // 5. Landmarks fill themselves in once their data resolves.
  const landmarks = placeLandmarks(scene);

  overlay.setLoadingText('building the aeroplane…');
  await nextFrame();
  // Passing the renderer buys a properly PMREM-prefiltered environment map
  // instead of a raw equirect that three has to convert on the first render.
  const aircraft = createAircraft(scene, { renderer });

  // 6. Spawn on a real runway threshold. getSpawn() falls back to hardcoded
  //    KBFI coordinates if the airport bake has not been run, so this never
  //    throws and never drops the aircraft into the void.
  const spawn = getSpawn();
  const flight = createFlightModel({
    startLat: spawn.lat,
    startLon: spawn.lon,
    startHeadingDeg: spawn.headingDeg,
    startAltitudeAglM: 0,
    startAirspeedMs: 0,
    // THE GROUND-HEIGHT INVARIANT: reset() and step() must sample the same
    // surface. Passing terrain.getHeightAt to both is what guarantees it.
    groundHeightFn: terrain.getHeightAt,
  });
  flight.reset();

  const instruments = createInstruments(hudEl);
  // THE THUMB COCKPIT MOUNTS INTO #hud, NOT INTO #app.
  //
  // input.js's default parent is the canvas's parent — #app — and that is the
  // right default for a module that cannot assume this page's markup. Here it
  // is wrong, and silently: #hud carries `z-index: 10`, which makes it a
  // stacking context, so overlay.js's `z-index: 30` chrome is trapped inside
  // it and loses to ANY positive z-index on a sibling of #hud. The touch root
  // is `z-index: 25`. Left in #app it would draw over the boot screen, over
  // the menu sheet and over the crash banner — a stick painted across a modal.
  // Inside #hud the three layers finally sort the way each module thought they
  // did: tapes 20, thumbs 25, chrome 30.
  //
  // #hud is `pointer-events: none`; every control surface sets `auto` on
  // itself (touch.js#surface), so the fingers still land and the canvas still
  // gets everything they miss.
  const input = createInput(renderer.domElement, { touchParent: hudEl });
  const cameras = createCameras(aircraft.group, renderer);
  const sound = createSoundscape();
  const autopilot = createAutopilot();

  // Seed the aircraft transform so the first frame is already correct.
  aircraft.group.position.copy(flight.state.position);
  aircraft.group.quaternion.copy(flight.state.orientation);

  const dem = getRegionStats();
  console.info(
    `[sim] spawn ${spawn.label} @ ${spawn.lat.toFixed(5)}, ` +
      `${spawn.lon.toFixed(5)} hdg ${spawn.headingDeg.toFixed(1)} | ` +
      `${airports.length} airports | DEM ${dem.tilesLoaded} tiles, ` +
      `${dem.minElevationM.toFixed(0)}..${dem.maxElevationM.toFixed(0)} m`,
  );

  // -------------------------------------------------------------------------
  // Places
  // -------------------------------------------------------------------------
  let placeIndex = 0;
  let timeIndex = 0;
  let paused = false;
  let muted = false;
  /** Edge-detector so the crash is logged once, not sixty times a second. */
  let crashLogged = false;

  /**
   * Resolve a place entry to a concrete spawn.
   *
   * Ground places go through airports.js so the aeroplane lands on the
   * surveyed threshold; airborne places aim themselves at their subject using
   * the SCENE projection's bearing (not a great-circle initial bearing), which
   * is what makes the landmark actually appear where the nose is pointing.
   */
  function resolvePlace(p) {
    if (p.airport) {
      const s = getSpawn(p.airport.ident, p.airport.end);
      return { lat: s.lat, lon: s.lon, headingDeg: s.headingDeg, placement: null };
    }
    const headingDeg = p.aimAt
      ? bearingBetween(p.lat, p.lon, p.aimAt.lat, p.aimAt.lon)
      : (p.headingDeg ?? 0);
    return {
      lat: p.lat,
      lon: p.lon,
      headingDeg,
      placement: {
        altitudeAglM: p.altitudeAglM,
        altitudeMslM: p.altitudeMslM,
        airspeedMs: p.airspeedMs,
      },
    };
  }

  gotoPlace = async function gotoPlaceImpl(i) {
    const p = PLACES[i];
    if (!p) return;
    placeIndex = i;

    const r = resolvePlace(p);

    // Page the fine DEM in at the destination BEFORE anything reads the ground
    // there. The z=13 and z=14 layers follow the aircraft (elevation.js
    // § PAGING) and hold nothing where it has not been, so without this the
    // reset below would place the aeroplane on the 51.8 m/px pinned base and
    // the terrain would then morph under it as the real data arrived. A few
    // hundred milliseconds inside a teleport is not something anyone can see.
    // §1.6: a paging failure degrades the view, it does not cancel a teleport.
    await warmAt(r.lat, r.lon).catch(() => {});

    flight.reset(r.lat, r.lon, r.headingDeg, r.placement);

    // The lever is part of the situation. Arriving at 3,000 ft with the
    // throttle closed is a glider start, not a cruise.
    input.setThrottle(p.throttle ?? 0);
    input.setFlaps(0);

    // Move the picture with the aeroplane, in this order: chunks first (so the
    // camera's ground-clearance floor reads real terrain), then the camera.
    aircraft.group.position.copy(flight.state.position);
    aircraft.group.quaternion.copy(flight.state.orientation);
    terrain.converge?.(
      flight.state.position.x,
      flight.state.position.y,
      flight.state.position.z,
    );
    cameras.snap?.();
    cameras.update(0, flight.state);

    overlay.setActive(i);
    overlay.toast(p.label);
    sound.resume();
  };
  overlay.setActive(0);
  overlay.setCamera(cameras.mode);
  overlay.setTime(TIMES[0].label);
  overlay.setAudio('press N', true);

  // -------------------------------------------------------------------------
  // Window + key wiring
  // -------------------------------------------------------------------------
  function onWindowResize() {
    // Pixel ratio first: the tier's ceiling is an absolute pixel COUNT as well
    // as a ratio, so rotating a phone into landscape changes which ratio fits.
    applyPixelRatio();
    renderer.setSize(window.innerWidth, window.innerHeight);
    cameras.onResize();
  }
  window.addEventListener('resize', onWindowResize);
  // A phone reports the rotation through `orientationchange` before `resize`
  // settles, and some iOS versions fire only one of the two.
  window.addEventListener('orientationchange', onWindowResize);

  /** True while the user is typing into something that is not the sim. */
  function isEditable(el) {
    if (!el) return false;
    const tag = el.tagName;
    return (
      tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable === true
    );
  }

  // App-level keys. Flight controls live in input.js; view keys inside
  // cameras.js. What is left over — where am I, what time is it, is it
  // running — belongs to the composition root.
  function onKeyDown(e) {
    if (e.metaKey || isEditable(e.target)) return;

    // `e.code` is empty on virtual keyboards and some accessibility paths —
    // see core/keycode.js. Same normalisation input.js and cameras.js use, so
    // all three agree on what key was pressed.
    const code = eventCode(e);

    // AUTO-REPEAT IS DROPPED FOR EVERYTHING EXCEPT THE FOUR BUG KEYS.
    //
    // The blanket `if (e.repeat) return` this replaces was right for the
    // toggles — leaning on C would cycle the camera thirty times a second —
    // and it silently killed the one place that WANTED repeats. The `[`/`]`
    // case below reads `e.repeat` to accelerate its step from 1 degree to 5,
    // and it could never once have run: the guard returned before the switch
    // was reached, so `hdgRepeat` was permanently 0 and holding `]` on a
    // desktop keyboard moved the bug exactly one degree and then stopped.
    //
    // Now the four bug keys are let through and the acceleration works — on
    // the keyboard, and on the phone, where overlay.js's press-and-hold sends
    // the same repeats and a 180-degree swing is one thumb-press instead of
    // 180 taps.
    if (e.repeat && !REPEATABLE_KEYS.has(code)) return;

    // Any keystroke is a user gesture, and a user gesture is the only thing
    // that can start an AudioContext. Cheap and idempotent.
    if (!muted) sound.resume();

    switch (code) {
      case 'KeyC':
        overlay.setCamera(cameras.cycle());
        break;
      case 'KeyR': {
        const p = PLACES[placeIndex];
        const r = resolvePlace(p);
        flight.reset(r.lat, r.lon, r.headingDeg, r.placement);
        input.setThrottle(p.throttle ?? 0);
        input.setFlaps(0);
        cameras.snap?.();
        overlay.toast(`reset · ${p.label}`);
        break;
      }
      case 'KeyP':
      case 'Escape':
        paused = !paused;
        overlay.setPaused(paused);
        break;
      case 'KeyT': {
        timeIndex = (timeIndex + 1) % TIMES.length;
        sky.setTimeOfDay(TIMES[timeIndex].t);
        overlay.setTime(TIMES[timeIndex].label);
        overlay.toast(TIMES[timeIndex].label);
        break;
      }
      case 'KeyN': {
        muted = sound.toggleMute();
        overlay.setAudio(muted ? 'muted' : 'on', muted);
        break;
      }
      case 'KeyH':
        overlay.toggleKeys();
        break;

      // --- autopilot -------------------------------------------------------
      // The bug keys work whether or not it is engaged: you dial the heading
      // you want, then press L. That is the order a real pilot works in, and it
      // means engaging never produces a surprise turn.
      case 'KeyL': {
        // NB: `state` is a frame-loop local (see the render loop below); the
        // key handler must go through flight.state or it throws.
        const r = autopilot.toggle(flight.state);
        if (!r.ok) overlay.toast(`autopilot unavailable — ${r.reason}`);
        else if (autopilot.engaged) {
          overlay.toast(
            `autopilot on · HDG ${String(autopilot.headingBug).padStart(3, '0')} · ALT ${autopilot.altitudeBug}`,
          );
        } else overlay.toast('autopilot off');
        break;
      }
      case 'BracketLeft':
      case 'BracketRight': {
        // Held keys repeat, and the repeat accelerates: a tap is 1 degree for
        // fine work, a hold swings round the compass without 180 keypresses.
        const dir = code === 'BracketRight' ? 1 : -1;
        hdgRepeat = e.repeat ? Math.min(hdgRepeat + 1, 60) : 0;
        const step = hdgRepeat > 30 ? 5 : hdgRepeat > 12 ? 2 : 1;
        const bug = autopilot.nudgeHeading(dir * step);
        overlay.toast(`HDG bug ${String(bug).padStart(3, '0')}`);
        break;
      }
      case 'KeyY': {
        const bug = autopilot.syncHeading(flight.state);
        overlay.toast(`HDG bug ${String(bug).padStart(3, '0')} — present heading`);
        break;
      }
      case 'KeyU':
      case 'KeyJ': {
        // Same ramp as the heading bug. 100 ft a press is right for trimming a
        // cruise; it is 40 presses to climb from pattern altitude to 8,000 ft,
        // which is why holding has to be worth something.
        //
        // The top step is 300, not 500. overlay.js's hold fires every 55 ms
        // once it is up to speed, so 500 is 9,000 ft per second of thumb —
        // measured, and it flew the bug from 1,000 to 11,700 in a press that
        // felt like a tap. 300 crosses the whole useful band, ground to
        // 15,000 ft, in about four seconds, which is a thumb you can aim.
        altRepeat = e.repeat ? Math.min(altRepeat + 1, 60) : 0;
        const step = altRepeat > 30 ? 300 : altRepeat > 12 ? 200 : 100;
        const bug = autopilot.nudgeAltitude(code === 'KeyU' ? step : -step);
        overlay.toast(`ALT bug ${bug} ft`);
        break;
      }
      case 'Digit1':
      case 'Digit2':
      case 'Digit3':
      case 'Digit4':
        gotoPlace(Number(code.slice(5)) - 1);
        break;
      default:
        break;
    }
  }
  window.addEventListener('keydown', onKeyDown);

  function onFirstGesture() {
    if (!muted && sound.resume()) {
      overlay.setAudio('on', false);
      window.removeEventListener('pointerdown', onFirstGesture);
      window.removeEventListener('keydown', onFirstGesture);
    }
  }
  window.addEventListener('pointerdown', onFirstGesture);
  window.addEventListener('keydown', onFirstGesture);

  // -------------------------------------------------------------------------
  // Render loop
  // -------------------------------------------------------------------------
  let lastFrameMs = performance.now();

  /**
   * Wall-clock delta, clamped.
   *
   * 0.1 s is the flight model's own internal clamp, and matching it here means
   * a backgrounded tab, a GC pause or a terrain convergence stall drops time
   * rather than teleporting the aircraft through the scenery.
   */
  function dtFor(now) {
    const dt = (now - lastFrameMs) / 1000;
    lastFrameMs = now;
    return Number.isFinite(dt) && dt > 0 ? Math.min(dt, 0.1) : 0;
  }

  /**
   * One frame. Split out of the rAF callback so a frame can also be driven
   * explicitly — `window.sim.tick(dt, n)` from the console runs the real loop
   * with a chosen delta, which is how the flight is checked on a page that
   * never becomes visible (a hidden tab gets no rAF at all, so the acceptance
   * run would otherwise be checking a frozen aeroplane).
   *
   * @param {number} dt seconds, already clamped by the caller
   */
  function tick(dt) {
    const state = flight.state;

    // 1. input — the same object every frame, mutated in place.
    //    It is handed THIS frame's dt, the one the flight model is about to
    //    get, so every control ramp in input.js and touch.js runs on the
    //    simulation's clock. On the rAF path that is the same number it used
    //    to read off performance.now() itself; on the `window.sim.tick()` path
    //    it is the difference between a thumb that flies the aeroplane and a
    //    thumb that moves the stick by 0.008 in a simulated second.
    const inputs = input.get(dt);

    if (!paused) {
      // 1b. autopilot. It writes into the SAME inputs object the keyboard just
      //     produced, before the model sees it — so the aeroplane cannot tell
      //     the difference and the autopilot is bound by the same aerodynamics
      //     the pilot is. No-op when disengaged. See systems/autopilot.js.
      autopilot.update(dt, state, inputs);

      // 2. ground under the aircraft, in metres. ONE surface: §1.4.
      const groundHeight = terrain.getHeightAt(state.position.x, state.position.z);

      // 3. physics (substeps internally at a fixed 1/240 s)
      flight.step(dt, inputs, groundHeight);

      // 4. visual aircraft follows the model. flightModel owns the transform;
      //    aircraft/model.js is purely cosmetic and never moves itself.
      aircraft.group.position.copy(state.position);
      aircraft.group.quaternion.copy(state.orientation);
      aircraft.setControlSurfaces(inputs);
      aircraft.spinProp(state.rpm, dt);
    }

    // 5. world + view. Cameras first: terrain streams around wherever the
    //    camera ended up, not around where it was last frame.
    cameras.update(paused ? 0 : dt, state);
    terrain.update(cameras.active);
    sky.update(paused ? 0 : dt);

    // 6. hud + sound. The crash card is driven off the model's latched flag,
    //    not off an event, so it survives a paused frame and a camera change.
    instruments.update(state, inputs);
    overlay.setAutopilot(autopilot);
    overlay.setCrashed(state.crashed, state.crashDetail);
    if (state.crashed !== crashLogged) {
      crashLogged = state.crashed;
      if (state.crashed) {
        console.warn(
          `[sim] CRASHED (${state.crashReason}): ${state.crashDetail} — ` +
            `${state.impactSpeedMs.toFixed(1)} m/s, ${state.impactLoadFactor.toFixed(1)} g, ` +
            `at ${state.lat.toFixed(5)}, ${state.lon.toFixed(5)}, ` +
            `${state.altitudeFt.toFixed(0)} ft MSL`,
        );
      }
    }
    sound.update(dt, state, inputs, paused);

    // 7. draw — read cameras.active fresh, cycle() reassigns it
    renderer.render(scene, cameras.active);
  }

  function frame() {
    if (!running) return;
    requestAnimationFrame(frame);
    tick(dtFor(performance.now()));
  }

  // One frame before the loading screen comes down, so the fade reveals the
  // finished world instead of a single black frame.
  cameras.update(0, flight.state);
  terrain.update(cameras.active);
  sky.update(0);
  renderer.render(scene, cameras.active);
  overlay.hideLoading();

  frame();

  // A one-line sanity report on the geography, printed at boot so a wrong
  // origin or a broken projection is visible without flying anywhere.
  const needle = distanceBetween(spawn.lat, spawn.lon, SPACE_NEEDLE.lat, SPACE_NEEDLE.lon);
  const rainier = distanceBetween(spawn.lat, spawn.lon, RAINIER.lat, RAINIER.lon);
  console.info(
    `[sim] Space Needle ${(needle / 1000).toFixed(1)} km on ` +
      `${bearingBetween(spawn.lat, spawn.lon, SPACE_NEEDLE.lat, SPACE_NEEDLE.lon).toFixed(1)}°, ` +
      `Mount Rainier ${(rainier / 1000).toFixed(1)} km on ` +
      `${bearingBetween(spawn.lat, spawn.lon, RAINIER.lat, RAINIER.lon).toFixed(1)}° | ` +
      `wheels at ${flight.state.altitudeFt.toFixed(0)} ft MSL`,
  );

  // Exposed for console poking and for the acceptance checks. Not an API —
  // nothing in this repo imports it, and nothing should.
  window.sim = {
    THREE,
    scene,
    renderer,
    terrain,
    sky,
    flight,
    cameras,
    aircraft,
    input,
    sound,
    autopilot,
    gotoPlace,
    /**
     * DEM paging diagnostics — acceptance check 9. The tiles on disk total
     * 402 MB and only a bounded working set is ever decoded, so the two numbers
     * that matter are `peakResidentBytes` (must stay flat over a long flight)
     * and `capViolations` (must be 0).
     */
    demStats: () => getRegionStats(),
    /**
     * LOD diagnostics: what the error-metric selector actually chose. `drawn`
     * is the selected set — the renderer frustum-culls it further, so
     * `renderer.info.render.triangles` is a fraction of `triangles` here.
     */
    terrainStats: () => terrain.stats?.() ?? null,
    /** Cascade fitting, texel sizes and per-cascade render cadence. */
    shadowStats: () => sky.shadows?.getStats?.() ?? null,
    /**
     * WHAT THIS MACHINE IS, and what it is allowed to spend. The critics read
     * this. `budgets` is the resolved set — every number in it is justified in
     * core/device.js, and every other module's mobile work is measured against
     * it.
     */
    device,
    get tier() {
      return budgets.tier;
    },
    get budgets() {
      return budgets;
    },
    /** The raw capability signals, so a caller can decide for itself. */
    deviceSignals: () => device.signals,
    /** What the renderer actually ended up at, for the pixel-budget check. */
    pixelBudget: () => {
      const r = renderer.getPixelRatio();
      const w = window.innerWidth;
      const h = window.innerHeight;
      return {
        devicePixelRatio: window.devicePixelRatio,
        pixelRatio: r,
        cssWidth: w,
        cssHeight: h,
        drawingBufferPx: Math.round(w * r) * Math.round(h * r),
        maxDrawingBufferPx: budgets.maxDrawingBufferPx,
        pixelRatioMax: budgets.pixelRatioMax,
      };
    },
    /**
     * ONE LEVER FOR THE WHOLE PICTURE — now a DEVICE TIER rather than a
     * nameless quality knob.
     *
     * 'phone' | 'tablet' | 'desktop' select the budget sets in core/device.js.
     * The old names still work — 'low' -> phone, 'medium' -> tablet,
     * 'high' -> desktop — because they were the same lever under a name that
     * did not say what it was for.
     *
     * WHAT IS APPLIED LIVE and what is not, stated plainly:
     *
     *   applied now    renderer pixel ratio, shadow tier
     *   boot only      antialias (a renderer constructor flag), terrain
     *                  lodQuality (a createTerrain option), the DEM resident
     *                  cap and paging policy, the building LOD tiers
     *
     * The boot-only ones are still published on `window.sim.budgets` the moment
     * this returns, so a module that re-reads them picks the new numbers up. To
     * get them from frame 0, force the tier before load instead: `?tier=phone`.
     *
     * IT DOES NOT PERSIST unless you ask. A quality lever that silently changes
     * the NEXT boot is hidden state, and hidden state is how a measurement round
     * gets thrown away — pass `{persist: true}` (or use `?tier=`) when you
     * actually want it to stick.
     *
     * Returns the tier actually applied.
     */
    setQuality(tier, opts = {}) {
      const alias = { low: 'phone', medium: 'tablet', high: 'desktop' };
      const raw = String(tier ?? '').toLowerCase();
      const t = TIERS.includes(raw) ? raw : (alias[raw] ?? budgets.tier);
      budgets = budgetsFor(t);

      applyPixelRatio();
      renderer.setSize(window.innerWidth, window.innerHeight);
      cameras.onResize();

      // setQuality('off') on the shadow handle builds no cascade lights and
      // disables the shadow map; anything else rebuilds them. Both recompile
      // lit materials, so this is a settings change, not a per-frame call.
      sky.shadows?.setEnabled?.(budgets.shadowQuality !== 'off');
      sky.shadows?.setQuality?.(budgets.shadowQuality);

      if (opts.persist) {
        try {
          localStorage.setItem('sim.tier', t);
        } catch {
          /* private mode — the override just does not stick */
        }
      }
      overlay.toast(`quality · ${t}`);
      console.info(
        `[device] tier -> ${t} | dpr ${renderer.getPixelRatio()} | ` +
          `shadows ${budgets.shadowQuality} | tri <= ${budgets.maxTriangles} | ` +
          `calls <= ${budgets.maxDrawCalls} | heap <= ${budgets.heapTargetMB} MB ` +
          '(terrain LOD, DEM cap and building tiers are boot-time — reload to apply)',
      );
      return t;
    },
    /** Run n frames of exactly dt seconds each, through the real loop. */
    tick(dt = 1 / 60, n = 1) {
      const h = Math.min(Math.max(dt, 0), 0.1);
      for (let i = 0; i < n; i += 1) tick(h);
      lastFrameMs = performance.now();
      return flight.state;
    },
  };

  // -------------------------------------------------------------------------
  // Teardown (used by Vite HMR; also the pattern for embedding the sim)
  // -------------------------------------------------------------------------
  dispose = () => {
    running = false;
    window.removeEventListener('resize', onWindowResize);
    window.removeEventListener('orientationchange', onWindowResize);
    window.removeEventListener('keydown', onKeyDown);
    window.removeEventListener('pointerdown', onFirstGesture);
    window.removeEventListener('keydown', onFirstGesture);
    input.dispose();
    cameras.dispose?.();
    sound.dispose();
    overlay.dispose();
    terrain.dispose?.();
    runways.removeFromParent();
    landmarks.removeFromParent();
    renderer.dispose();
  };
}

/**
 * Yield to the browser so a DOM change actually paints before we block on I/O.
 *
 * rAF alone is a trap here: a hidden or backgrounded tab does not fire it at
 * all, so awaiting one would hang the entire boot on a page nobody is looking
 * at — and then show a loading screen forever when they come back. The timer
 * is the floor; whichever wins, we continue.
 */
function nextFrame() {
  return new Promise((r) => {
    let done = false;
    const go = () => {
      if (done) return;
      done = true;
      r();
    };
    requestAnimationFrame(go);
    setTimeout(go, 50);
  });
}

boot().catch((err) => {
  console.error('[sim] boot failed:', err);
  overlay.setLoadingError(`${err?.stack || err}`);
});

if (import.meta.hot) {
  import.meta.hot.dispose(() => dispose());
}
