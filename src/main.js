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
 *   3. await loadAirports()   needs elevation to sit runways on the terrain
 *   4. buildRunwayMeshes()    "
 *   5. placeLandmarks()       "  (self-populating, no await needed)
 *   6. createFlightModel()    needs a ground sampler and the spawn coordinates
 *
 * ---------------------------------------------------------------------------
 * PER-FRAME ORDER — later stages read what earlier ones wrote
 * ---------------------------------------------------------------------------
 *   1. sample input
 *   2. query ground height under the aircraft
 *   3. step the flight model
 *   4. copy state onto the aircraft group + animate its surfaces
 *   5. update terrain streaming, sky, cameras
 *   6. update instruments
 *   7. render
 */

import * as THREE from 'three';

import { setOrigin, DEFAULT_ORIGIN } from './geo/coords.js';
import { getRegionStats } from './geo/elevation.js';
import { loadAirports, buildRunwayMeshes, getSpawn } from './geo/airports.js';
import { placeLandmarks } from './geo/landmarks.js';
import { createTerrain } from './world/terrain.js';
import { createSky } from './world/sky.js';
import { createAircraft } from './aircraft/model.js';
import { createFlightModel } from './physics/flightModel.js';
import { createInstruments } from './ui/instruments.js';
import { createInput } from './controls/input.js';
import { createCameras } from './camera/cameras.js';

const appEl = document.getElementById('app');
const hudEl = document.getElementById('hud');

// ---------------------------------------------------------------------------
// Renderer + scene
// ---------------------------------------------------------------------------
const renderer = new THREE.WebGLRenderer({
  antialias: true,
  powerPreference: 'high-performance',
  // REQUIRED. The camera far plane is 300 km (Mount Rainier is 84 km out) and
  // the near plane is 0.35 m for the cockpit view. A linear depth buffer cannot
  // span that range without severe z-fighting. See camera/cameras.js.
  logarithmicDepthBuffer: true,
});
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
appEl.appendChild(renderer.domElement);

const scene = new THREE.Scene();

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
let running = true;
let dispose = () => {
  running = false;
};

async function boot() {
  // 1. Anchor the projection. Everything placed after this is relative to it.
  setOrigin(DEFAULT_ORIGIN.lat, DEFAULT_ORIGIN.lon);

  // 2. Terrain loads the DEM and is the gate for every ground query below.
  const terrain = await createTerrain(scene, {});

  const sky = createSky(scene, renderer, { timeOfDay: 0.42 });

  // 3-4. Real airports at real coordinates, sitting on the real terrain.
  const airports = await loadAirports();
  const runways = buildRunwayMeshes(scene, airports);

  // 5. Landmarks fill themselves in once their data resolves.
  const landmarks = placeLandmarks(scene);

  const aircraft = createAircraft(scene);

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
  // Window + key wiring
  // -------------------------------------------------------------------------
  function onWindowResize() {
    renderer.setSize(window.innerWidth, window.innerHeight);
    cameras.onResize();
  }
  window.addEventListener('resize', onWindowResize);

  // Camera cycling and reset are app-level concerns, not flight controls, so
  // they live here rather than in the input module.
  function onKeyDown(e) {
    if (e.repeat) return;
    if (e.code === 'KeyC') cameras.cycle();
    if (e.code === 'KeyR') flight.reset();
  }
  window.addEventListener('keydown', onKeyDown);

  // -------------------------------------------------------------------------
  // Render loop
  // -------------------------------------------------------------------------
  let lastFrameMs = performance.now();

  function frame() {
    if (!running) return;
    requestAnimationFrame(frame);

    // Clamp dt so a backgrounded tab or a GC pause can't teleport the aircraft.
    const now = performance.now();
    const dt = Math.min((now - lastFrameMs) / 1000, 0.1);
    lastFrameMs = now;

    const state = flight.state;

    // 1. input
    const inputs = input.get();

    // 2. ground under the aircraft, in metres
    const groundHeight = terrain.getHeightAt(state.position.x, state.position.z);

    // 3. physics
    flight.step(dt, inputs, groundHeight);

    // 4. visual aircraft follows the model
    aircraft.group.position.copy(state.position);
    aircraft.group.quaternion.copy(state.orientation);
    aircraft.setControlSurfaces(inputs);
    aircraft.spinProp(state.rpm, dt);

    // 5. world + view
    cameras.update(dt, state);
    terrain.update(cameras.active);
    sky.update(dt);

    // 6. hud
    instruments.update(state);

    // 7. draw — read cameras.active fresh, cycle() reassigns it
    renderer.render(scene, cameras.active);
  }

  frame();

  // -------------------------------------------------------------------------
  // Teardown (used by Vite HMR; also the pattern for embedding the sim)
  // -------------------------------------------------------------------------
  dispose = () => {
    running = false;
    window.removeEventListener('resize', onWindowResize);
    window.removeEventListener('keydown', onKeyDown);
    input.dispose();
    terrain.dispose?.();
    runways.removeFromParent();
    landmarks.removeFromParent();
    renderer.dispose();
  };
}

boot().catch((err) => {
  console.error('[sim] boot failed:', err);
  const msg = document.createElement('pre');
  msg.style.cssText =
    'position:absolute;inset:24px;color:#ff8080;font:13px ui-monospace,monospace;white-space:pre-wrap';
  msg.textContent = `Flight sim failed to start:\n\n${err?.stack || err}`;
  hudEl?.appendChild(msg);
});

if (import.meta.hot) {
  import.meta.hot.dispose(() => dispose());
}
