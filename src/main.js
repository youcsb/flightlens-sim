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
import { loadAirports, buildRunwayMeshes, getSpawn } from './geo/airports.js';
import { placeLandmarks } from './geo/landmarks.js';
import { createTerrain } from './world/terrain.js';
import { createSky } from './world/sky.js';
import { createAircraft } from './aircraft/model.js';
import { createFlightModel } from './physics/flightModel.js';
import { createInstruments } from './ui/instruments.js';
import { createOverlay } from './ui/overlay.js';
import { createInput } from './controls/input.js';
import { createCameras } from './camera/cameras.js';
import { createSoundscape } from './audio/soundscape.js';
import { eventCode } from './core/keycode.js';

const appEl = document.getElementById('app');
const hudEl = document.getElementById('hud');

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
// Renderer + scene
// ---------------------------------------------------------------------------
const renderer = new THREE.WebGLRenderer({
  antialias: true,
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
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
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

  // 2. Terrain loads the DEM and is the gate for every ground query below.
  overlay.setLoadingText('loading elevation tiles…');
  await nextFrame(); // let the loading screen actually paint before we block
  const terrain = await createTerrain(scene, {});

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
    shadows: true,
    shadowQuality: 'high',
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
  const input = createInput(renderer.domElement);
  const cameras = createCameras(aircraft.group, renderer);
  const sound = createSoundscape();

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
    renderer.setSize(window.innerWidth, window.innerHeight);
    cameras.onResize();
  }
  window.addEventListener('resize', onWindowResize);

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
    if (e.repeat || e.metaKey || isEditable(e.target)) return;

    // Any keystroke is a user gesture, and a user gesture is the only thing
    // that can start an AudioContext. Cheap and idempotent.
    if (!muted) sound.resume();

    // `e.code` is empty on virtual keyboards and some accessibility paths —
    // see core/keycode.js. Same normalisation input.js and cameras.js use, so
    // all three agree on what key was pressed.
    const code = eventCode(e);

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

    // 1. input — the same object every frame, mutated in place
    const inputs = input.get();

    if (!paused) {
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
     * ONE LEVER FOR THE WHOLE PICTURE.
     *
     * Everything expensive in this scene is either shadow map rendering or
     * terrain draw calls, and both already had a tier control — they just had
     * no single owner, so there was no way to answer "make it faster" without
     * knowing which module to ask. This is the composition root, so it is the
     * place that knows both.
     *
     * 'high'   everything on. The default, and what the frame budget was
     *          measured against.
     * 'medium' shadows drop to 1024-px cascades. Terrain is untouched: it is
     *          the geometry the whole sim exists to show.
     * 'low'    shadows off entirely. This is the tier for a machine where the
     *          shadow pass alone is not affordable — it costs draw calls, not
     *          fill, so shrinking the maps further buys nothing.
     *
     * Returns the tier actually applied.
     */
    setQuality(tier) {
      const t = String(tier);
      if (t === 'low') sky.shadows?.setEnabled?.(false);
      else {
        sky.shadows?.setEnabled?.(true);
        sky.shadows?.setQuality?.(t === 'medium' ? 'medium' : 'high');
      }
      overlay.toast(`quality · ${t}`);
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
