/**
 * cameras.js — the camera rig: view modes, smoothing, and aspect handling.
 *
 * STUB IMPLEMENTATION. Three modes (chase / cockpit / external) with simple
 * exponential smoothing. Replace the internals; do not change the exported
 * signature.
 *
 * Contract: see MODULES.md § cameras
 *
 *   createCameras(aircraftGroup, renderer) -> { active, cycle(), update(dt, state), onResize() }
 *
 * IMPORTANT: `active` is a mutable PROPERTY, not a getter method. cycle()
 * reassigns it. The render loop must therefore read `cameras.active` fresh on
 * every frame — never cache it in a local across frames.
 */

import * as THREE from 'three';
import { damp } from '../core/units.js';

/**
 * Near plane, metres. Small because the cockpit view sits inside the airframe.
 */
const NEAR = 0.35;

/**
 * Far plane, metres. This is a GEOGRAPHIC requirement, not a taste call:
 * Mount Rainier is 84 km from the spawn and the terrain patch has a 90 km
 * radius, so a corner of the world is ~127 km away. Anything under ~150000
 * clips the mountain out of existence and the sim silently loses its best
 * proof that the elevation data is real.
 *
 * NEAR:FAR of nearly a million to one is far past what a 24-bit depth buffer
 * can resolve, so main.js MUST construct the renderer with
 * `logarithmicDepthBuffer: true`. Without it, distant terrain z-fights itself
 * into a shimmering mess.
 */
const FAR = 300000;

/**
 * Mode table. Offsets are in the aircraft's BODY frame, metres
 * (-Z nose, +X right, +Y up).
 */
const MODES = [
  {
    name: 'chase',
    fov: 62,
    offset: new THREE.Vector3(0, 3.2, 14),
    lookAhead: new THREE.Vector3(0, 0.6, -12),
    positionRate: 6,
    lookRate: 8,
  },
  {
    name: 'cockpit',
    fov: 72,
    offset: new THREE.Vector3(0, 0.85, -1.4),
    lookAhead: new THREE.Vector3(0, 0.6, -40),
    positionRate: 1000, // rigid — no lag inside the cockpit
    lookRate: 1000,
  },
  {
    name: 'external',
    fov: 48,
    offset: new THREE.Vector3(16, 5, 10),
    lookAhead: new THREE.Vector3(0, 0, 0),
    positionRate: 2.2,
    lookRate: 4,
  },
];

/**
 * @param {THREE.Object3D} aircraftGroup The aircraft root from createAircraft().
 * @param {THREE.WebGLRenderer} renderer Used to read the drawing-buffer size.
 * @returns {{ active: THREE.PerspectiveCamera, cycle: () => string, update: (dt: number, state: Object) => void, onResize: () => void }}
 */
export function createCameras(aircraftGroup, renderer) {
  const size = new THREE.Vector2();
  renderer.getSize(size);
  const aspect = size.height > 0 ? size.width / size.height : 16 / 9;

  const cameras = MODES.map((m) => {
    const cam = new THREE.PerspectiveCamera(m.fov, aspect, NEAR, FAR);
    cam.name = `camera-${m.name}`;
    return cam;
  });

  let index = 0;

  // Smoothed targets, kept in world space between frames.
  const desiredPos = new THREE.Vector3();
  const desiredLook = new THREE.Vector3();
  const smoothPos = new THREE.Vector3();
  const smoothLook = new THREE.Vector3();
  const _up = new THREE.Vector3(0, 1, 0);
  const _bodyUp = new THREE.Vector3();
  let primed = false;

  const api = {
    /** @type {THREE.PerspectiveCamera} Reassigned by cycle(). Read it fresh each frame. */
    active: cameras[0],
    cycle,
    update,
    onResize,
  };

  /**
   * Advance to the next view mode.
   * @returns {string} The name of the newly active mode.
   */
  function cycle() {
    index = (index + 1) % MODES.length;
    api.active = cameras[index];
    primed = false; // snap instead of sweeping across the world
    onResize();
    return MODES[index].name;
  }

  /**
   * Position the active camera for this frame.
   *
   * @param {number} dt    Frame delta in SECONDS.
   * @param {Object} state Flight model state. The stub only reads it to keep
   *                       the horizon level in external view, but a real rig
   *                       will want airspeedMs (speed-based FOV), rollDeg, etc.
   */
  function update(dt, state) {
    const mode = MODES[index];
    const cam = api.active;
    if (!aircraftGroup || !cam) return;

    aircraftGroup.updateMatrixWorld();

    desiredPos.copy(mode.offset).applyMatrix4(aircraftGroup.matrixWorld);
    desiredLook.copy(mode.lookAhead).applyMatrix4(aircraftGroup.matrixWorld);

    if (!primed) {
      smoothPos.copy(desiredPos);
      smoothLook.copy(desiredLook);
      primed = true;
    } else {
      const h = Number.isFinite(dt) ? Math.min(Math.max(dt, 0), 0.1) : 0;
      smoothPos.set(
        damp(smoothPos.x, desiredPos.x, mode.positionRate, h),
        damp(smoothPos.y, desiredPos.y, mode.positionRate, h),
        damp(smoothPos.z, desiredPos.z, mode.positionRate, h),
      );
      smoothLook.set(
        damp(smoothLook.x, desiredLook.x, mode.lookRate, h),
        damp(smoothLook.y, desiredLook.y, mode.lookRate, h),
        damp(smoothLook.z, desiredLook.z, mode.lookRate, h),
      );
    }

    cam.position.copy(smoothPos);

    // Cockpit rolls with the airframe; outside views keep the horizon level.
    if (mode.name === 'cockpit') {
      _bodyUp.set(0, 1, 0).applyQuaternion(aircraftGroup.quaternion);
      cam.up.copy(_bodyUp);
    } else {
      cam.up.copy(_up);
    }
    cam.lookAt(smoothLook);

    void state;
  }

  /** Re-derive aspect from the renderer's current size. Call on window resize. */
  function onResize() {
    renderer.getSize(size);
    if (size.height <= 0) return;
    const a = size.width / size.height;
    for (const cam of cameras) {
      cam.aspect = a;
      cam.updateProjectionMatrix();
    }
  }

  onResize();

  return api;
}
