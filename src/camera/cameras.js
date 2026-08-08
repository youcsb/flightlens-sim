/**
 * cameras.js — the view rig: modes, spring smoothing, framing, depth range.
 *
 * Contract: see MODULES.md § 2.13
 *
 *   createCameras(aircraftGroup, renderer) -> {
 *     active,               // MUTABLE PROPERTY, reassigned by cycle()
 *     cycle() -> string,
 *     update(dt, state) -> void,
 *     onResize() -> void,
 *     dispose() -> void,    // additive; see the integrator notes
 *     mode,                 // additive; current mode name
 *     setMode(name) -> string,
 *   }
 *
 * `active` is a PROPERTY, not a getter. The render loop must read
 * `cameras.active` fresh every frame and never cache it across frames.
 *
 * MODES  chase · cockpit · orbit · flyby
 *   (the contract named the third mode "external"; it is now "orbit" and a
 *   fourth, "flyby", was added. Nothing reads the name, and setMode('external')
 *   still resolves to orbit for compatibility.)
 *
 * VIEW KEYS OWNED HERE — none of them collide with controls/input.js:
 *   V ................ cockpit: toggle panel-down view
 *   right/middle-drag  free look (all modes); orbits the camera in orbit mode
 *   wheel ............ zoom: boom length in chase/orbit, FOV in cockpit
 *
 * ---------------------------------------------------------------------------
 * WHY A SPRING AND NOT AN exp() DAMP
 * ---------------------------------------------------------------------------
 * `damp()` is a first-order filter: it has no velocity state, so it can only
 * ever trail the target and mush out. A chase camera wants second-order
 * behaviour — it should carry momentum through a roll reversal and settle
 * without a visible snap. `Spring3` below integrates a damped harmonic
 * oscillator with the implicit (unconditionally stable) formulation, so a
 * 5 fps hitch cannot make it explode the way a naive explicit spring would.
 *
 * The two knobs are physical, not magic:
 *   omega — natural frequency, rad/s. How eagerly the camera chases.
 *   zeta  — damping ratio. 1.0 = critical (no overshoot), <1 overshoots.
 *           Chase runs at 0.92: just enough overshoot to read as "alive".
 *
 * VELOCITY FEED-FORWARD. A position spring chasing a target that moves at a
 * constant velocity settles with a steady-state lag of `2*zeta/omega * v` —
 * 26 m at 60 m/s with these gains, which silently doubles the boom length at
 * cruise. Feeding the target forward by `velocity * CHASE_LEAD` cancels it
 * exactly, leaving only the honest lag that appears during accelerations and
 * turns. That residual lag IS the effect we want; the constant offset is not,
 * and it is invisible until someone measures the boom at two speeds.
 *
 * ---------------------------------------------------------------------------
 * DEPTH RANGE — a geographic requirement, not a taste call
 * ---------------------------------------------------------------------------
 * Mount Rainier is 84 km from the spawn and the terrain patch reaches ~127 km
 * at the corners, so FAR must be ~300 km. The cockpit view sits inside the
 * airframe, so NEAR wants to be well under a metre. That is a range ratio near
 * 10^6, which a 24-bit depth buffer cannot resolve: distant ridgelines z-fight
 * into a shimmering mess.
 *
 * The fix is already in place — main.js constructs the renderer with
 * `logarithmicDepthBuffer: true`, which spends depth precision logarithmically
 * and holds up across the whole range. This module VERIFIES that at
 * construction (`renderer.capabilities.logarithmicDepthBuffer`) and, if it is
 * missing, warns loudly and pushes NEAR out to NEAR_FALLBACK so the failure is
 * degraded rather than catastrophic.
 *
 * If log depth ever has to go (it costs a little fill rate, and it requires
 * every custom shader in the project to include the `logdepthbuf_*` chunks —
 * terrain and sky both use custom material code, so check there first if
 * distant geometry looks wrong), the replacement is a SPLIT FRUSTUM, not a
 * bigger NEAR:
 *
 *   1. render pass A with near = 800, far = 300000, autoClear on
 *   2. renderer.clearDepth()
 *   3. render pass B with near = 0.35, far = 1000
 *
 * Two passes, each with a ~1000:1 range, which 24 bits handles comfortably.
 * The seam overlap (800..1000) hides the join. That change belongs in main.js's
 * render step, so it is documented here rather than implemented here.
 */

import * as THREE from 'three';
import { clamp, damp, DEG_TO_RAD, RAD_TO_DEG } from '../core/units.js';
import { getElevationLocal } from '../geo/elevation.js';
import { eventCode } from '../core/keycode.js';

// ---------------------------------------------------------------------------
// Depth range
// ---------------------------------------------------------------------------

/** Near plane, metres. Small because the cockpit view sits inside the airframe. */
const NEAR = 0.35;
/** Near plane used when the renderer has no logarithmic depth buffer. */
const NEAR_FALLBACK = 2.5;
/** Far plane, metres. Rainier at 84 km, terrain corners at ~127 km. */
const FAR = 300000;

// ---------------------------------------------------------------------------
// Framing
// ---------------------------------------------------------------------------

/** Chase boom at rest, metres behind and above the aircraft. */
const CHASE_DIST = 14.5;
const CHASE_HEIGHT = 3.6;
/** How much the boom stretches at high speed (metres, at CHASE_SPEED_REF). */
const CHASE_DIST_SPEED = 7.0;
const CHASE_HEIGHT_SPEED = 1.2;
/** Speed at which the speed-dependent terms saturate, m/s (~155 kt). */
const CHASE_SPEED_REF = 80;
/**
 * Fraction of the aircraft's pitch applied to the boom. At 1.0 the camera is
 * rigidly on the fuselage line and the horizon swings sickeningly; at 0 the
 * aircraft climbs out of frame. 0.4 keeps it framed and the horizon readable.
 */
const CHASE_PITCH_BLEND = 0.4;
/**
 * Metres the boom slides to the OUTSIDE of a turn at full bank. Sliding
 * outward is what opens up the view into the turn; sliding inward hides it.
 */
const CHASE_LATERAL = 3.2;
/**
 * How far the camera's up vector leans from world-up toward the airframe's up.
 * 0 = rigid artificial horizon (dead), 1 = fully rolled (nauseating).
 */
const CHASE_LEAN = 0.26;
/** Metres ahead of the aircraft the camera aims, putting it just below centre. */
const CHASE_LOOKAHEAD = 6.0;
const CHASE_LOOKUP = 1.0;
/** Chase spring: eager but only barely underdamped. */
const CHASE_OMEGA = 4.2;
const CHASE_ZETA = 0.92;
/** Look-target spring — faster than the boom, so aim never lags framing. */
const LOOK_OMEGA = 8.0;
const LOOK_ZETA = 1.0;
/**
 * Velocity feed-forward, seconds.
 *
 * A second-order system tracking a RAMP settles with a steady-state error of
 * exactly `2*zeta/omega * v`, so that is the lead time — not a tuned guess.
 * Measured before the fix: at 60 m/s the boom sat 34.6 m behind a nominal
 * 19.8 m one, i.e. 15 m of pure integrator lag masquerading as framing. With
 * the correct lead the boom holds its nominal length at any speed, and the
 * only remaining lag is the transient during accelerations and turns — which
 * is the lag we actually wanted. Speed-dependent boom growth is owned by
 * CHASE_DIST_SPEED, where it is visible and adjustable.
 */
const CHASE_LEAD = (2 * CHASE_ZETA) / CHASE_OMEGA;
/** Base vertical FOV, degrees, and how much it opens at CHASE_SPEED_REF. */
const CHASE_FOV = 58;
const CHASE_FOV_SPEED = 7;

/**
 * Cockpit eye point in BODY axes (-Z nose, +X right, +Y up), metres.
 *
 * ---------------------------------------------------------------------------
 * THIS IS A SEATING POSITION, NOT A FRAMING CHOICE
 * ---------------------------------------------------------------------------
 * Measured against aircraft/model.js's actual geometry, the previous value
 * (0, 0.62, -1.35) put the pilot's eye 0.18 m behind the instrument panel and
 * 0.02 m above its top edge — i.e. with their chin on the glareshield. A panel
 * that close subtends an enormous angle, so it filled the bottom half of the
 * windscreen and the view forward was a slot.
 *
 * The geometry that fixes it, all read out of model.js's FUSELAGE table:
 *
 *   panel face      z = -1.53, top edge y = 0.60
 *   cowl top        y = 0.61 at the firewall (z = -1.78), falling forward
 *   cabin roof      y = 0.91 through the whole front cabin
 *   windscreen      cut into the crown from z = -1.76 to -1.30
 *
 * Seating the eye at (0, 0.76, -0.86) gives a real cockpit's numbers: the
 * panel is 0.68 m away (a normal arm's reach rather than a face-plant), the
 * eye clears the panel top by 0.16 m, the cowl top sits 9.2 deg below the
 * horizon so you see over the nose, and there is 0.15 m of headroom to the
 * cabin roof. The forward line of sight leaves through the windscreen glazing,
 * not through the shell.
 */
const EYE_FORWARD = new THREE.Vector3(0, 0.76, -0.86);
/** Eye point for the panel-down view: lower and slightly further forward. */
const EYE_PANEL = new THREE.Vector3(0, 0.70, -0.95);
/** How far the panel view tilts the gaze down, degrees. */
const PANEL_PITCH_DEG = 28;
const COCKPIT_FOV = 68;

/** Orbit defaults. */
const ORBIT_RADIUS = 34;
const ORBIT_FOV = 50;
/** Orbit follows translation with a light spring, not rigidly. */
const ORBIT_OMEGA = 9.0;
const ORBIT_ZETA = 1.0;

/**
 * Flyby: replant the tripod once the aircraft is further away than this.
 *
 * 800 m rather than the 1400 m I first tried. Past roughly this range the FOV
 * solve is already pinned at FLYBY_FOV_MIN and the aircraft is a receding
 * speck, so the extra distance buys nothing but dead air before the next
 * plant. At 70 m/s this gives a ~16 s cycle: 6 s of approach, a pass, then
 * departure.
 */
const FLYBY_MAX_DIST = 800;
/** Lead distance ahead of the aircraft when planting, metres. */
const FLYBY_LEAD_MIN = 150;
const FLYBY_LEAD_MAX = 700;
/**
 * Lateral standoff, metres — this sets how close the pass is, so it scales
 * with speed. A fixed 130 m is a good airborne pass but strands the camera on
 * the far side of the field during a 5 m/s taxi. Sign alternates each replant.
 */
const FLYBY_LATERAL_MIN = 55;
const FLYBY_LATERAL_MAX = 200;
/** Tripod height above the ground beneath it, metres. */
const FLYBY_HEIGHT_MIN = 18;
/** The subject should fill roughly this many metres of frame height. */
const FLYBY_FRAME_M = 26;
const FLYBY_FOV_MIN = 12;
const FLYBY_FOV_MAX = 55;

/** No exterior camera is allowed closer than this to the ground, metres. */
const MIN_GROUND_CLEARANCE = 3.0;

/** Free-look limits and feel. */
const LOOK_SENS = 0.0026; // radians per pixel of drag
const LOOK_YAW_LIMIT = 170 * DEG_TO_RAD;
const LOOK_PITCH_LIMIT = 84 * DEG_TO_RAD;
/** Rate at which free-look recentres once the button is released. */
const LOOK_RECENTRE_RATE = 3.0;

/** Wheel zoom range, as a multiplier on the mode's nominal distance/FOV. */
const ZOOM_MIN = 0.3;
const ZOOM_MAX = 6.0;
const ZOOM_STEP = 1.12;

// ---------------------------------------------------------------------------
// Springs
// ---------------------------------------------------------------------------

/**
 * One axis of a damped harmonic oscillator, integrated implicitly.
 *
 * The implicit form is the reason this is safe to hand a variable dt: unlike
 * the explicit `v += (-2*z*w*v - w*w*(x-t))*dt` version, it cannot go unstable
 * when a frame runs long. (Ryan Juckett / Game Programming Gems 4.)
 */
class Spring1 {
  constructor(omega, zeta) {
    this.x = 0;
    this.v = 0;
    this.omega = omega;
    this.zeta = zeta;
  }

  step(target, dt) {
    const w = this.omega;
    const f = 1 + 2 * dt * this.zeta * w;
    const oo = w * w;
    const hoo = dt * oo;
    const hhoo = dt * hoo;
    const detInv = 1 / (f + hhoo);
    const x = this.x;
    const v = this.v;
    this.x = (f * x + dt * v + hhoo * target) * detInv;
    this.v = (v + hoo * (target - x)) * detInv;
    return this.x;
  }

  snap(value) {
    this.x = value;
    this.v = 0;
  }

  /** Place the spring AND give it a velocity — see Spring3.settle(). */
  set(value, velocity) {
    this.x = value;
    this.v = velocity;
  }
}

/** Three independent Spring1s, kept as a struct to avoid per-frame allocation. */
class Spring3 {
  constructor(omega, zeta) {
    this.sx = new Spring1(omega, zeta);
    this.sy = new Spring1(omega, zeta);
    this.sz = new Spring1(omega, zeta);
  }

  /** @param {THREE.Vector3} target @param {THREE.Vector3} out */
  step(target, dt, out) {
    out.set(
      this.sx.step(target.x, dt),
      this.sy.step(target.y, dt),
      this.sz.step(target.z, dt),
    );
    return out;
  }

  /** @param {THREE.Vector3} v */
  snap(v) {
    this.sx.snap(v.x);
    this.sy.snap(v.y);
    this.sz.snap(v.z);
  }

  /**
   * Put the spring straight into the steady state it would otherwise take a
   * second to reach: at `pos`, already travelling at `vel`.
   *
   * `snap()` alone is wrong for a moving subject. A critically-damped spring
   * chasing a target that moves at v settles a fixed distance BEHIND it —
   * exactly `v * 2*zeta/omega`, which is what CHASE_LEAD feeds forward to
   * cancel. Snapping the spring onto the fed-forward target therefore places
   * the camera where the boom and the lead cancel, i.e. on top of the
   * aeroplane, and then lets it drift back over the next second. On the ground
   * it looks fine because v is zero; teleport in at 100 kt and the first
   * second of the new location is filmed from inside the fuselage.
   *
   * @param {THREE.Vector3} pos
   * @param {THREE.Vector3} vel
   */
  settle(pos, vel) {
    this.sx.set(pos.x, vel.x);
    this.sy.set(pos.y, vel.y);
    this.sz.set(pos.z, vel.z);
  }
}

// ---------------------------------------------------------------------------
// Mode table
// ---------------------------------------------------------------------------

const MODE_NAMES = ['chase', 'cockpit', 'orbit', 'flyby'];
const MODE_FOV = [CHASE_FOV, COCKPIT_FOV, ORBIT_FOV, FLYBY_FOV_MAX];

/**
 * @param {THREE.Object3D} aircraftGroup The aircraft root from createAircraft().
 * @param {THREE.WebGLRenderer} renderer Used to read the drawing-buffer size
 *        and to attach view-only pointer/wheel listeners to its canvas.
 */
/**
 * PER-AIRCRAFT CAMERA FRAME.
 *
 * Every CHASE_* and ORBIT_* constant above was measured against a Cessna 172:
 * 8.3 m long, 11 m span. A 737-800 is 39.5 m long with a 34 m span, and the
 * same 14.5 m boom puts the camera INSIDE the fuselage — which is exactly what
 * it did the first time the jet was flown, and which reads as a broken camera
 * rather than as a scaling assumption.
 *
 * `scale` multiplies the boom, the lateral swing, the look-ahead and the orbit
 * radius; `eye` and `panelEye` are stated outright, because a flight deck is
 * not at a scaled-up version of a Cessna's eye position — it is 17 m forward of
 * the CG on one aeroplane and 0.9 m on the other.
 *
 * setAircraftFrame() exists so a type change does not have to rebuild the rig.
 * Rebuilding it would throw away the springs' settled state and make every
 * swap snap and re-converge. See main.js's `acMount`.
 */
let frameScale = 1;
let frameEye = EYE_FORWARD;
let framePanelEye = EYE_PANEL;

export function createCameras(aircraftGroup, renderer) {
  const size = new THREE.Vector2();
  renderer.getSize(size);
  const aspect = size.height > 0 ? size.width / size.height : 16 / 9;

  // --- depth range --------------------------------------------------------
  const hasLogDepth = !!(
    renderer.capabilities && renderer.capabilities.logarithmicDepthBuffer
  );
  const nearPlane = hasLogDepth ? NEAR : NEAR_FALLBACK;
  if (!hasLogDepth) {
    console.warn(
      '[cameras] renderer has no logarithmicDepthBuffer. NEAR pushed from ' +
        `${NEAR} to ${NEAR_FALLBACK} m to limit z-fighting, but distant ` +
        'terrain will still shimmer. Construct WebGLRenderer with ' +
        '{ logarithmicDepthBuffer: true } — see the header of cameras.js for ' +
        'the split-frustum alternative.',
    );
  }

  const cameras = MODE_NAMES.map((name, i) => {
    const cam = new THREE.PerspectiveCamera(MODE_FOV[i], aspect, nearPlane, FAR);
    cam.name = `camera-${name}`;
    return cam;
  });

  let index = 0;
  let primed = false;

  /** Per-mode wheel zoom, so switching views does not lose your framing. */
  const zoom = [1, 1, 1, 1];

  // --- free look ----------------------------------------------------------
  let looking = false;
  let lookYaw = 0;
  let lookPitch = 0;
  let panelView = false;

  // --- orbit state --------------------------------------------------------
  let orbitAz = Math.PI * 0.85; // behind and slightly off the tail
  let orbitEl = 0.28;

  // --- flyby state --------------------------------------------------------
  const flybyAnchor = new THREE.Vector3();
  let flybyPlanted = false;
  let flybySide = 1;

  // --- springs and scratch ------------------------------------------------
  const posSpring = new Spring3(CHASE_OMEGA, CHASE_ZETA);
  const lookSpring = new Spring3(LOOK_OMEGA, LOOK_ZETA);

  const _pos = new THREE.Vector3();
  const _target = new THREE.Vector3();
  const _lookTarget = new THREE.Vector3();
  const _fwd = new THREE.Vector3();
  const _right = new THREE.Vector3();
  const _up = new THREE.Vector3();
  const _bodyUp = new THREE.Vector3();
  const _worldUp = new THREE.Vector3(0, 1, 0);
  const _tmp = new THREE.Vector3();
  const _q = new THREE.Quaternion();
  const _acPos = new THREE.Vector3();
  const _vel = new THREE.Vector3();
  /** The velocity feed-forward buildChase applied this frame, if any. */
  const _lead = new THREE.Vector3();

  const api = {
    /** @type {THREE.PerspectiveCamera} Reassigned by cycle(). Read fresh each frame. */
    active: cameras[0],
    /** @type {string} Current mode name. Informational. */
    mode: MODE_NAMES[0],
    cycle,
    setMode,
    /**
     * Re-frame the rig for a different aeroplane. See the frameScale block.
     * @param {{scale?:number, eye?:THREE.Vector3, panelEye?:THREE.Vector3}} f
     */
    setAircraftFrame(f = {}) {
      frameScale = f.scale > 0 ? f.scale : 1;
      frameEye = f.eye || EYE_FORWARD;
      framePanelEye = f.panelEye || EYE_PANEL;
    },
    snap,
    update,
    onResize,
    dispose,
  };

  /**
   * Drop the smoothing for one frame so the next update() places the camera
   * exactly where it belongs instead of springing toward it.
   *
   * main.js calls this after a teleport. Without it, jumping 84 km to Mount
   * Rainier makes the chase camera sweep the whole way across the map at
   * spring speed, which reads as the world sliding past rather than as a cut.
   */
  function snap() {
    primed = false;
    flybyPlanted = false;
  }

  // =========================================================================
  // View input (owned here — input.js deliberately leaves the wheel alone)
  // =========================================================================

  const canvas = renderer.domElement;

  function onContextMenu(e) {
    e.preventDefault();
  }

  function onPointerDown(e) {
    if (e.button !== 1 && e.button !== 2) return;
    looking = true;
    if (canvas.setPointerCapture) {
      try {
        canvas.setPointerCapture(e.pointerId);
      } catch {
        /* capture is a nicety; dragging still works without it */
      }
    }
    e.preventDefault();
  }

  function onPointerUp(e) {
    if (e.button !== 1 && e.button !== 2) return;
    looking = false;
  }

  function onPointerMove(e) {
    if (!looking) return;
    const dx = e.movementX || 0;
    const dy = e.movementY || 0;
    if (MODE_NAMES[index] === 'orbit') {
      orbitAz -= dx * LOOK_SENS * 1.6;
      orbitEl = clamp(orbitEl + dy * LOOK_SENS * 1.6, -1.45, 1.45);
    } else {
      lookYaw = clamp(lookYaw - dx * LOOK_SENS, -LOOK_YAW_LIMIT, LOOK_YAW_LIMIT);
      lookPitch = clamp(
        lookPitch - dy * LOOK_SENS,
        -LOOK_PITCH_LIMIT,
        LOOK_PITCH_LIMIT,
      );
    }
  }

  function onWheel(e) {
    e.preventDefault();
    const f = e.deltaY > 0 ? ZOOM_STEP : 1 / ZOOM_STEP;
    zoom[index] = clamp(zoom[index] * f, ZOOM_MIN, ZOOM_MAX);
  }

  function onViewKey(e) {
    if (e.repeat || e.metaKey) return;
    // Same guard input.js uses: never steal a keystroke aimed at a text field.
    const t = e.target;
    if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName || ''))) {
      return;
    }
    if (eventCode(e) === 'KeyV') panelView = !panelView;
  }

  canvas.addEventListener('contextmenu', onContextMenu);
  canvas.addEventListener('pointerdown', onPointerDown);
  window.addEventListener('pointerup', onPointerUp);
  window.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('wheel', onWheel, { passive: false });
  window.addEventListener('keydown', onViewKey);

  // =========================================================================
  // Mode switching
  // =========================================================================

  /** Advance to the next view mode. @returns {string} the new mode name. */
  function cycle() {
    return setMode(MODE_NAMES[(index + 1) % MODE_NAMES.length]);
  }

  /**
   * Jump straight to a named mode. Unknown names are ignored; 'external' is
   * accepted as the old name for 'orbit'.
   * @returns {string} the mode name now active
   */
  function setMode(name) {
    const wanted = name === 'external' ? 'orbit' : name;
    const i = MODE_NAMES.indexOf(wanted);
    if (i >= 0 && i !== index) {
      index = i;
      api.active = cameras[index];
      api.mode = MODE_NAMES[index];
      // Snap rather than sweeping the camera across the world.
      primed = false;
      flybyPlanted = false;
      lookYaw = 0;
      lookPitch = 0;
      onResize();
    }
    return MODE_NAMES[index];
  }

  // =========================================================================
  // Helpers
  // =========================================================================

  /** Ground height under a world-space point, metres MSL. Sea level if unloaded. */
  function groundAt(x, z) {
    const h = getElevationLocal(x, z);
    return Number.isFinite(h) ? h : 0;
  }

  /** Keep a camera position from burrowing into the terrain. */
  function liftAboveGround(v, clearance) {
    const floor = groundAt(v.x, v.z) + clearance;
    if (v.y < floor) v.y = floor;
    return v;
  }

  /** Set fov on the active camera, rebuilding the projection only if it moved. */
  function setFov(cam, fovDeg) {
    if (Math.abs(cam.fov - fovDeg) > 0.01) {
      cam.fov = fovDeg;
      cam.updateProjectionMatrix();
    }
  }

  /**
   * Apply the free-look offsets by rotating the aim point around the camera.
   * Done on the LOOK TARGET rather than on the camera quaternion so the
   * subsequent lookAt() still produces a properly levelled roll.
   */
  function applyFreeLook(camPos, lookPoint, upVec) {
    if (lookYaw === 0 && lookPitch === 0) return;
    _tmp.copy(lookPoint).sub(camPos);
    const len = _tmp.length();
    if (len < 1e-4) return;
    _tmp.divideScalar(len);
    // Pitch about the camera's right axis first, then yaw about the up axis.
    _right.copy(_tmp).cross(upVec).normalize();
    if (_right.lengthSq() > 1e-8) _tmp.applyAxisAngle(_right, lookPitch);
    _tmp.applyAxisAngle(upVec, lookYaw);
    lookPoint.copy(camPos).addScaledVector(_tmp, len);
  }

  // =========================================================================
  // Per-mode target construction
  // =========================================================================

  /**
   * Chase. The boom hangs off a YAW-ONLY frame with a fraction of the pitch
   * mixed in — following the full body orientation would roll the horizon with
   * every aileron input, which is the classic "camera bolted to the tail"
   * mistake.
   */
  function buildChase(state, speedFrac, rollRad, pitchRad) {
    const dist = (CHASE_DIST + CHASE_DIST_SPEED * speedFrac) * frameScale * zoom[index];
    const height = (CHASE_HEIGHT + CHASE_HEIGHT_SPEED * speedFrac) * frameScale;

    // Yaw frame from the flight model's own heading — no quaternion unpicking.
    const h = state.headingDeg * DEG_TO_RAD;
    _fwd.set(Math.sin(h), 0, -Math.cos(h));
    _right.set(Math.cos(h), 0, Math.sin(h));

    // Boom: behind and above, then tipped by part of the pitch so the aircraft
    // stays framed through a climb or a dive.
    _target.copy(_fwd).multiplyScalar(-dist).addScaledVector(_worldUp, height);
    _target.applyAxisAngle(_right, pitchRad * CHASE_PITCH_BLEND);

    // Slide to the OUTSIDE of the turn to open up the view into it.
    _target.addScaledVector(_right, -Math.sin(rollRad) * CHASE_LATERAL * frameScale);

    _target.add(_acPos);

    // Velocity feed-forward kills the constant lag; see the header. Recorded
    // so a prime/snap can subtract it again — see Spring3.settle().
    _lead.copy(_vel).multiplyScalar(CHASE_LEAD);
    _target.add(_lead);

    liftAboveGround(_target, MIN_GROUND_CLEARANCE);

    // Aim a little ahead of the nose, which drops the aircraft just below the
    // centre of frame — the GeoFS exterior composition.
    _lookTarget
      .copy(_fwd)
      .multiplyScalar(CHASE_LOOKAHEAD * frameScale)
      .applyAxisAngle(_right, pitchRad * CHASE_PITCH_BLEND)
      .addScaledVector(_worldUp, CHASE_LOOKUP * frameScale)
      .add(_acPos)
      .addScaledVector(_vel, CHASE_LEAD);

    // Lean: interpolate up between world-up and the airframe's up. Doing it
    // this way needs no sign guessing and degrades gracefully when inverted.
    _bodyUp.set(0, 1, 0).applyQuaternion(aircraftGroup.quaternion);
    _up.copy(_worldUp).lerp(_bodyUp, CHASE_LEAN);
    if (_up.lengthSq() < 1e-6) _up.copy(_worldUp);
    else _up.normalize();
  }

  /** Reusable +X (body right) axis for the cockpit panel tilt. */
  const _rightUnitX = new THREE.Vector3(1, 0, 0);

  /** Cockpit. Rigid to the airframe — any lag here reads as a loose head. */
  function buildCockpit() {
    const eye = panelView ? framePanelEye : frameEye;
    _target.copy(eye).applyMatrix4(aircraftGroup.matrixWorld);

    // Gaze 200 m down the nose (well past the propeller), tipped down for the
    // panel view.
    _tmp.set(0, 0, -200);
    if (panelView) {
      _tmp.applyAxisAngle(_rightUnitX, -PANEL_PITCH_DEG * DEG_TO_RAD);
    }
    _lookTarget.copy(_tmp).applyMatrix4(aircraftGroup.matrixWorld);

    _up.set(0, 1, 0).applyQuaternion(aircraftGroup.quaternion);
  }

  /** Orbit. World-aligned spherical rig that translates with the aircraft. */
  function buildOrbit() {
    const r = ORBIT_RADIUS * frameScale * zoom[index];
    const ce = Math.cos(orbitEl);
    _target.set(
      Math.sin(orbitAz) * ce * r,
      Math.sin(orbitEl) * r + 2.0,
      Math.cos(orbitAz) * ce * r,
    );
    _target.add(_acPos);
    liftAboveGround(_target, MIN_GROUND_CLEARANCE);
    _lookTarget.copy(_acPos);
    _up.copy(_worldUp);
  }

  /**
   * Flyby / spot. A tripod planted in the world that the aircraft flies past;
   * it re-plants ahead of the flight path once you have gone by. Ground-clamped
   * so the tripod never ends up inside a hill.
   */
  function buildFlyby(state, speed) {
    const dist = _acPos.distanceTo(flybyAnchor);
    if (!flybyPlanted || dist > FLYBY_MAX_DIST) {
      const h = state.headingDeg * DEG_TO_RAD;
      _fwd.set(Math.sin(h), 0, -Math.cos(h));
      _right.set(Math.cos(h), 0, Math.sin(h));

      const lead = clamp(speed * 6, FLYBY_LEAD_MIN, FLYBY_LEAD_MAX);
      const lateral = clamp(50 + speed * 1.3, FLYBY_LATERAL_MIN, FLYBY_LATERAL_MAX);
      flybySide = -flybySide;

      flybyAnchor
        .copy(_acPos)
        .addScaledVector(_fwd, lead)
        .addScaledVector(_right, lateral * flybySide);

      // Plant it above whatever ground is actually there, but never below the
      // aircraft's own altitude by so much that it stares up at the belly.
      const g = groundAt(flybyAnchor.x, flybyAnchor.z);
      flybyAnchor.y = Math.max(
        g + FLYBY_HEIGHT_MIN,
        Math.min(_acPos.y, g + 400),
      );
      flybyPlanted = true;
    }

    _target.copy(flybyAnchor);
    _lookTarget.copy(_acPos);
    _up.copy(_worldUp);
  }

  // =========================================================================
  // Frame update
  // =========================================================================

  /**
   * Position the active camera for this frame.
   *
   * @param {number} dt    Frame delta in SECONDS.
   * @param {Object} state Flight model state (position, orientation,
   *                       headingDeg, pitchDeg, rollDeg, airspeedMs, velocity).
   */
  function update(dt, state) {
    const cam = api.active;
    if (!aircraftGroup || !cam) return;

    const h = Number.isFinite(dt) ? clamp(dt, 0, 0.1) : 0;
    aircraftGroup.updateMatrixWorld();

    /**
     * FRAME WHAT IS DRAWN, NOT WHAT IS SIMULATED.
     *
     * This used to prefer `state.position` and fall back to the group. That is
     * backwards now that main.js draws the aeroplane at flightModel's
     * INTERPOLATED pose: `state.position` is the latest completed 1/240 s
     * substep, the group is where the aeroplane actually is on screen, and the
     * two differ by up to one substep — about a metre at jet speeds.
     *
     * On chase, cockpit and orbit the mismatch is invisible, because the camera
     * rides with the aircraft and both ends jitter together. On FLYBY it is
     * fully exposed: that camera is a tripod planted in the world, so a jittery
     * aim point shakes the whole frame while the aeroplane slides about inside
     * it. That is why the ghosting survived in exactly one view after the
     * render interpolation went in.
     *
     * The group is authoritative because it is what the renderer will use.
     * `state.position` remains the fallback for a caller that passes no group
     * transform of its own.
     */
    _acPos.setFromMatrixPosition(aircraftGroup.matrixWorld);
    if (!Number.isFinite(_acPos.x) && state && state.position) _acPos.copy(state.position);

    if (state && state.velocity) _vel.copy(state.velocity);
    else _vel.set(0, 0, 0);

    const speed = state && Number.isFinite(state.airspeedMs) ? state.airspeedMs : 0;
    const speedFrac = clamp(speed / CHASE_SPEED_REF, 0, 1);
    const rollRad = state && Number.isFinite(state.rollDeg) ? state.rollDeg * DEG_TO_RAD : 0;
    const pitchRad =
      state && Number.isFinite(state.pitchDeg) ? state.pitchDeg * DEG_TO_RAD : 0;
    const headed = state && Number.isFinite(state.headingDeg) ? state : { headingDeg: 0 };

    const mode = MODE_NAMES[index];
    // Only chase feeds velocity forward; clear it so a prime in any other mode
    // does not subtract last frame's lead.
    _lead.set(0, 0, 0);

    switch (mode) {
      case 'chase':
        buildChase(headed, speedFrac, rollRad, pitchRad);
        setFov(cam, CHASE_FOV + CHASE_FOV_SPEED * speedFrac);
        break;
      case 'cockpit':
        buildCockpit();
        setFov(cam, clamp(COCKPIT_FOV / zoom[index], 22, 92));
        break;
      case 'orbit':
        buildOrbit();
        setFov(cam, ORBIT_FOV);
        break;
      default: {
        buildFlyby(headed, speed);
        // Solve the FOV that keeps the subject filling a constant slice of
        // frame height. Wheel zoom widens the framing rather than moving the
        // tripod — a spot camera that walks toward you is not a spot camera.
        const d = Math.max(1, _target.distanceTo(_acPos));
        const frame = FLYBY_FRAME_M * zoom[index];
        const fov = 2 * Math.atan(frame / (2 * d)) * RAD_TO_DEG;
        setFov(cam, clamp(fov * 1.6, FLYBY_FOV_MIN, FLYBY_FOV_MAX));
        break;
      }
    }

    // --- smoothing --------------------------------------------------------
    if (mode === 'cockpit' || mode === 'flyby') {
      // Cockpit is rigid by design; the flyby tripod does not move at all, so
      // springing either one only adds mush. Their look targets still smooth.
      _pos.copy(_target);
      posSpring.snap(_pos);
    } else {
      if (!primed) {
        // Land on the pose the spring converges to, not on the fed-forward
        // target — see Spring3.settle().
        _pos.copy(_target).sub(_lead);
        posSpring.settle(_pos, _vel);
      } else {
        posSpring.sx.omega = mode === 'orbit' ? ORBIT_OMEGA : CHASE_OMEGA;
        posSpring.sy.omega = posSpring.sx.omega;
        posSpring.sz.omega = posSpring.sx.omega;
        posSpring.sx.zeta = mode === 'orbit' ? ORBIT_ZETA : CHASE_ZETA;
        posSpring.sy.zeta = posSpring.sx.zeta;
        posSpring.sz.zeta = posSpring.sx.zeta;
        posSpring.step(_target, h, _pos);
      }
      // Safety net: the spring can undershoot into a hillside on a low pass.
      const floor = groundAt(_pos.x, _pos.z) + MIN_GROUND_CLEARANCE * 0.5;
      if (_pos.y < floor) {
        _pos.y = floor;
        posSpring.sy.snap(floor);
      }
    }

    if (!primed) {
      lookSpring.snap(_lookTarget);
      primed = true;
    } else {
      lookSpring.step(_lookTarget, h, _tmp);
      _lookTarget.copy(_tmp);
    }

    // --- free look --------------------------------------------------------
    if (!looking) {
      // Ease back to the default view rather than leaving the head turned.
      lookYaw = damp(lookYaw, 0, LOOK_RECENTRE_RATE, h);
      lookPitch = damp(lookPitch, 0, LOOK_RECENTRE_RATE, h);
      if (Math.abs(lookYaw) < 1e-4) lookYaw = 0;
      if (Math.abs(lookPitch) < 1e-4) lookPitch = 0;
    }
    if (mode !== 'orbit') applyFreeLook(_pos, _lookTarget, _up);

    // --- commit -----------------------------------------------------------
    cam.position.copy(_pos);
    cam.up.copy(_up);
    // Degenerate when the aim point coincides with the eye — nudge forward.
    if (_lookTarget.distanceToSquared(_pos) < 1e-6) {
      _q.copy(aircraftGroup.quaternion);
      _lookTarget.copy(_pos).add(_tmp.set(0, 0, -1).applyQuaternion(_q));
    }
    cam.lookAt(_lookTarget);
  }

  /** Re-derive aspect from the renderer's current size. Call on window resize. */
  function onResize() {
    renderer.getSize(size);
    if (size.height <= 0) return;
    const a = size.width / size.height;
    for (let i = 0; i < cameras.length; i += 1) {
      cameras[i].aspect = a;
      cameras[i].updateProjectionMatrix();
    }
  }

  /** Detach the view listeners. main.js should call this from its teardown. */
  function dispose() {
    canvas.removeEventListener('contextmenu', onContextMenu);
    canvas.removeEventListener('pointerdown', onPointerDown);
    window.removeEventListener('pointerup', onPointerUp);
    window.removeEventListener('pointermove', onPointerMove);
    canvas.removeEventListener('wheel', onWheel);
    window.removeEventListener('keydown', onViewKey);
  }

  onResize();

  return api;
}
