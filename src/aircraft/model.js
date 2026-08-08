/**
 * model.js — the visual airframe: geometry, control-surface animation, prop.
 *
 * A procedurally-generated Cessna 172 Skyhawk. No external meshes, no
 * downloaded textures: every surface is lofted from real dimensions and every
 * map is drawn into a canvas at load time.
 *
 * Contract: see MODULES.md §2.9
 *
 *   createAircraft(scene, opts?) -> { group, setControlSurfaces({pitch,roll,yaw,flaps}),
 *                                     spinProp(rpm, dt), dispose() }
 *
 * BODY AXES (local space of `group`) — every subsystem must agree on this:
 *   -Z = nose / forward       +Z = tail
 *   +X = right wing           -X = left wing
 *   +Y = up (canopy)          -Y = landing gear
 *
 * This module is PURELY COSMETIC. It never moves `group` itself — main.js
 * writes position and orientation onto the group from the flight model.
 *
 * ---------------------------------------------------------------------------
 * WHY THE NUMBERS ARE WHAT THEY ARE
 * ---------------------------------------------------------------------------
 * `flightModel` is configured with wingAreaM2 = 16.2, massKg = 1100,
 * maxRpm = 2700 and gearHeightM = 1.2. Those are Cessna 172 numbers, so this
 * is a 172 and not a Cub. Every dimension below is the published airframe
 * figure in metres:
 *
 *   wingspan            11.00 m   (36 ft 1 in)   -> semi-span 5.50
 *   length               8.28 m   (27 ft 2 in)   spinner tip to rudder TE
 *   height               2.72 m   (8 ft 11 in)   ground to fin tip
 *   wing area           16.20 m^2                aspect ratio 7.47
 *   root / tip chord     1.625 / 1.12 m
 *   dihedral             1 deg 44 min
 *   washout              3 deg  (+1.5 root, -1.5 tip)
 *   main gear track      2.53 m
 *   propeller diameter   1.90 m   (75 in)
 *
 * THE VERTICAL DATUM IS SET BY PHYSICS, NOT BY ART. `gearHeightM = 1.2` means
 * the wheel contact patch must be at local y = -1.20. Everything follows from
 * that, and it all lands on the real aeroplane:
 *
 *   y = -1.20  wheels down             (physics datum)
 *   y =  0.00  thrust line / prop hub  -> 0.25 m prop tip clearance (real: 0.28)
 *   y =  0.91  cabin roof / wing root  -> 2.11 m under-wing clearance (real: ~2.1)
 *   y =  1.55  fin tip                 -> 2.75 m total height (real: 2.72)
 *
 * Those four independent agreements are the check that the airframe is to
 * scale rather than eyeballed.
 */

import * as THREE from 'three';
import { bakeStatic } from '../core/bakeStatic.js';
import { clamp, DEG_TO_RAD } from '../core/units.js';
import {
  TAU,
  monotoneSpline,
  spow,
  airfoilAt,
  sectionOutline,
  buildLiftingSurface,
  buildFuselage,
  sweep,
  HAS_CANVAS,
  makeCanvas,
  makeSkinCanvas,
  normalFromHeight,
  drawRivets,
  makeSkyEnvTexture,
  makeEnvironment,
} from './lofting.js';
import { texSize } from '../core/textureBudget.js';

// ---------------------------------------------------------------------------
// Control-surface travel. Real C172 figures, in radians.
// ---------------------------------------------------------------------------
const ELEVATOR_UP = 28 * DEG_TO_RAD;
const ELEVATOR_DOWN = 23 * DEG_TO_RAD;
/** Ailerons are differential on the real aeroplane: 20 up, 15 down. */
const AILERON_UP = 20 * DEG_TO_RAD;
const AILERON_DOWN = 15 * DEG_TO_RAD;
/** Published travel is 16 deg. Opened out slightly so it reads from the chase cam. */
const RUDDER_MAX = 21 * DEG_TO_RAD;
const FLAP_MAX = 30 * DEG_TO_RAD;

/**
 * Rates at which the surfaces chase the stick, per second of full travel.
 * These are flightModel.js's SURFACE_RATE and FLAP_TRAVEL_RATE — the numbers
 * have to match or the aeroplane you see is not the one you are flying.
 */
const SURFACE_RATE = 4.0;
const FLAP_RATE = 0.2;

/** Propeller blur thresholds, rpm. Below START the blades are solid. */
const BLUR_START = 380;
const BLUR_FULL = 950;




/**
 * The fuselage livery, drawn in (z, ring-u) space so it can be laid out in
 * metres. Texture X is the station in metres; texture Y is the angle around
 * the hull, with the right flank at 0.75 H and the left flank at 0.25 H.
 *
 * Returns { map, height } — the height canvas feeds normalFromHeight.
 */
function makeFuselageTexture(zMin, zMax, windows, reg) {
  // The DESIGN size. What is allocated is `texSize(W) x texSize(H)`; the
  // drawing below is unchanged because makeSkinCanvas scales the pen to match.
  const W = 2048;
  const H = 1024;
  const map = makeSkinCanvas(W, H);
  const hgt = makeSkinCanvas(W, H);
  const c = map.getContext('2d');
  const k = hgt.getContext('2d');
  const tx = (z) => ((z - zMin) / (zMax - zMin)) * W;
  const ty = (u) => (1 - u) * H;

  c.fillStyle = '#c9ccd2';
  c.fillRect(0, 0, W, H);
  k.fillStyle = '#808080';
  k.fillRect(0, 0, W, H);

  // Slight vertical shading: the underside of a parked aeroplane is grubbier
  // and the crown is sun-bleached. Cheap, and it stops the hull reading as a
  // single flat swatch under the hemisphere light.
  //
  // NOTE the wrap. canvas y = 0 and y = H are BOTH the keel (u = 1 and u = 0
  // are the same ring point); the crown is the middle row. Get this backwards
  // and the aeroplane comes out dirty on top and bleached underneath.
  const grad = c.createLinearGradient(0, 0, 0, H);
  grad.addColorStop(0.0, 'rgba(0,0,0,0.12)');
  grad.addColorStop(0.28, 'rgba(255,255,255,0.04)');
  grad.addColorStop(0.5, 'rgba(255,255,255,0.14)');
  grad.addColorStop(0.72, 'rgba(255,255,255,0.04)');
  grad.addColorStop(1.0, 'rgba(0,0,0,0.12)');
  c.fillStyle = grad;
  c.fillRect(0, 0, W, H);

  // --- the cheatline: a classic Cessna swoosh, low at the cowl, sweeping up
  //     over the wing root and running aft along the upper longeron.
  const stripe = (yBase, dir) => {
    const path = (off, amp) => {
      c.beginPath();
      c.moveTo(tx(-3.0), yBase + dir * (0.010 * H + off));
      c.bezierCurveTo(
        tx(-1.4), yBase + dir * (0.030 * H + off),
        tx(0.4), yBase - dir * (0.055 * H - off),
        tx(2.0), yBase - dir * (0.085 * H - off),
      );
      c.lineTo(tx(4.6), yBase - dir * (0.115 * H - off));
      c.lineTo(tx(4.6), yBase - dir * (0.115 * H - off - amp));
      c.bezierCurveTo(
        tx(2.0), yBase - dir * (0.085 * H - off - amp),
        tx(0.4), yBase - dir * (0.055 * H - off - amp),
        tx(-1.4), yBase + dir * (0.030 * H + off + amp),
      );
      c.lineTo(tx(-3.0), yBase + dir * (0.010 * H + off + amp));
      c.closePath();
      c.fill();
    };
    c.fillStyle = '#1d3f6e';
    path(0, 0.048 * H);
    c.fillStyle = '#c8a02c';
    path(-0.052 * H, 0.014 * H);
  };
  stripe(ty(0.25), 1);
  stripe(ty(0.75), -1);

  // --- structural panel lines, at the real frame stations.
  const frames = [-2.65, -2.2, -1.86, -1.35, -0.75, -0.15, 0.45, 0.95, 1.5, 2.1,
    2.7, 3.3, 3.9, 4.35];
  c.lineWidth = 2;
  k.lineWidth = 3;
  for (const z of frames) {
    const x = tx(z);
    c.strokeStyle = 'rgba(60,66,76,0.30)';
    c.beginPath();
    c.moveTo(x, 0);
    c.lineTo(x, H);
    c.stroke();
    k.strokeStyle = '#5a5a5a';
    k.beginPath();
    k.moveTo(x, 0);
    k.lineTo(x, H);
    k.stroke();
    drawRivets(k, x - 7, 0, x - 7, H, '#a8a8a8', 13, 1.8);
  }
  // Longerons: two lines running the length of each flank.
  for (const u of [0.155, 0.345, 0.655, 0.845]) {
    const y = ty(u);
    c.strokeStyle = 'rgba(60,66,76,0.22)';
    c.beginPath();
    c.moveTo(tx(-2.9), y);
    c.lineTo(tx(4.5), y);
    c.stroke();
    drawRivets(k, tx(-2.9), y, tx(4.5), y, '#a0a0a0', 15, 1.7);
  }

  // --- door outlines and window frames.
  const frame = (z0, z1, u0, u1, r) => {
    for (const uu of [[u0, u1], [1 - u1, 1 - u0]]) {
      const x = tx(z0);
      const y = ty(uu[1]);
      const w = tx(z1) - x;
      const h = ty(uu[0]) - y;
      c.strokeStyle = 'rgba(35,40,48,0.75)';
      c.lineWidth = 7;
      c.beginPath();
      c.roundRect(x, y, w, h, r);
      c.stroke();
      k.strokeStyle = '#3a3a3a';
      k.lineWidth = 8;
      k.beginPath();
      k.roundRect(x, y, w, h, r);
      k.stroke();
    }
  };
  // Cabin door, larger than its window.
  frame(-1.42, -0.10, 0.140, 0.392, 16);
  for (const w of windows) {
    if (w.u0 > 0.5) continue; // mirrored inside frame()
    frame(w.z0, w.z1, w.u0, w.u1, 14);
  }
  // Door handle.
  for (const u of [0.20, 0.80]) {
    c.fillStyle = '#2b3038';
    c.fillRect(tx(-0.32), ty(u) - 4, 26, 9);
  }

  // --- registration. Texture X runs nose->tail, and on the right flank the
  //     nose is to the viewer's right, so that side has to be drawn mirrored
  //     or the marks come out backwards on the aeroplane.
  c.font = 'bold 74px Helvetica, Arial, sans-serif';
  c.textBaseline = 'middle';
  c.fillStyle = '#1d3f6e';
  const rw = c.measureText(reg).width;
  c.save();
  c.translate(tx(3.6), ty(0.25));
  c.scale(-1, 1);
  c.fillText(reg, -rw / 2, 0);
  c.restore();
  c.fillText(reg, tx(2.6) - rw / 2, ty(0.75));

  // Small stencilling near the fuel/oil doors.
  c.font = 'bold 20px Helvetica, Arial, sans-serif';
  c.fillStyle = 'rgba(40,46,56,0.8)';
  c.fillText('NO STEP', tx(1.1), ty(0.10));
  c.fillText('NO STEP', tx(1.1), ty(0.90));

  return { map, height: hgt };
}

/** Wing / tail skin: spanwise rib lines, rivet rows, a tip flash. */
function makeWingTexture() {
  const W = 1024;
  const H = 512;
  const map = makeSkinCanvas(W, H);
  const hgt = makeSkinCanvas(W, H);
  const c = map.getContext('2d');
  const k = hgt.getContext('2d');
  c.fillStyle = '#ccced4';
  c.fillRect(0, 0, W, H);
  k.fillStyle = '#808080';
  k.fillRect(0, 0, W, H);

  // Ribs every ~0.34 m over a 5.5 m semi-span.
  const ribs = 16;
  for (let i = 1; i <= ribs; i++) {
    const x = (i / (ribs + 1)) * W;
    c.strokeStyle = 'rgba(70,76,86,0.20)';
    c.lineWidth = 2;
    c.beginPath();
    c.moveTo(x, 0);
    c.lineTo(x, H);
    c.stroke();
    k.strokeStyle = '#606060';
    k.lineWidth = 3;
    k.beginPath();
    k.moveTo(x, 0);
    k.lineTo(x, H);
    k.stroke();
    drawRivets(k, x + 6, 0, x + 6, H, '#a4a4a4', 12, 1.6);
  }
  // Spar lines run along the span at fixed profile positions.
  for (const v of [0.12, 0.30, 0.70, 0.88]) {
    c.strokeStyle = 'rgba(70,76,86,0.16)';
    c.beginPath();
    c.moveTo(0, v * H);
    c.lineTo(W, v * H);
    c.stroke();
    drawRivets(k, 0, v * H, W, v * H, '#9c9c9c', 14, 1.6);
  }
  // Wingtip flash, matching the fuselage cheatline.
  c.fillStyle = '#1d3f6e';
  c.fillRect(W * 0.90, 0, W * 0.10, H);
  c.fillStyle = '#c8a02c';
  c.fillRect(W * 0.875, 0, W * 0.025, H);
  return { map, height: hgt };
}

/**
 * The propeller blur disc: a translucent annulus, denser at the tip where the
 * blade spends more time per unit area and the chord is still wide. A uniform
 * grey disc is the tell-tale of a cheap sim.
 */
function makePropDiscTexture() {
  const S = 256;
  const cv = makeCanvas(S, S);
  const c = cv.getContext('2d');
  c.clearRect(0, 0, S, S);
  const g = c.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
  g.addColorStop(0.0, 'rgba(40,44,52,0.85)');
  g.addColorStop(0.14, 'rgba(40,44,52,0.55)');
  g.addColorStop(0.30, 'rgba(70,74,84,0.10)');
  g.addColorStop(0.72, 'rgba(90,94,104,0.14)');
  g.addColorStop(0.94, 'rgba(150,152,160,0.34)');
  g.addColorStop(0.985, 'rgba(210,80,60,0.55)'); // painted tip warning band
  g.addColorStop(1.0, 'rgba(210,80,60,0.0)');
  c.fillStyle = g;
  c.fillRect(0, 0, S, S);
  // A couple of faint sweep arcs so the disc is not perfectly uniform.
  c.strokeStyle = 'rgba(255,255,255,0.05)';
  c.lineWidth = 3;
  for (let i = 0; i < 3; i++) {
    c.beginPath();
    c.arc(S / 2, S / 2, S * (0.22 + i * 0.16), 0, TAU);
    c.stroke();
  }
  return cv;
}


// ===========================================================================
// 4. Airframe geometry definitions
// ===========================================================================

/**
 * Fuselage station table: [z, halfWidth, halfHeight, centreY, superellipse n].
 * n = 2 is a true ellipse; larger n squares the section off, which is what
 * gives the cabin its slab sides and the tailcone its rounded triangle.
 *
 * The step from z=-1.78 (cowl top y=0.61) to z=-1.58 (glareshield y=0.84) is
 * the windscreen: 0.23 m of rise in 0.20 m of length, a 49 deg rake, which is
 * the real aeroplane's.
 */
const FUSELAGE = [
  [-3.05, 0.20, 0.18, 0.01, 2.1], // cowl mouth, meets the spinner
  [-2.92, 0.31, 0.27, 0.02, 2.3],
  [-2.65, 0.40, 0.35, 0.04, 2.5],
  [-2.30, 0.47, 0.41, 0.05, 2.7],
  [-1.95, 0.52, 0.46, 0.07, 2.9],
  [-1.78, 0.55, 0.51, 0.10, 3.0], // firewall
  [-1.58, 0.57, 0.66, 0.18, 3.2], // glareshield
  [-1.35, 0.58, 0.74, 0.17, 3.4],
  [-1.00, 0.58, 0.75, 0.16, 3.5],
  [-0.40, 0.58, 0.75, 0.16, 3.6], // widest cabin section
  [0.30, 0.57, 0.73, 0.16, 3.5],
  [0.78, 0.53, 0.65, 0.17, 3.2],
  [1.35, 0.44, 0.52, 0.19, 2.9],
  [2.05, 0.34, 0.39, 0.22, 2.7],
  [2.80, 0.26, 0.30, 0.25, 2.6],
  [3.55, 0.19, 0.23, 0.27, 2.5],
  [4.15, 0.13, 0.17, 0.28, 2.4],
  [4.50, 0.06, 0.09, 0.29, 2.3],
  [4.62, 0.02, 0.03, 0.29, 2.2],
];

/**
 * Glazing, as rectangles in (station, ring-u). u = 0.25 is the right flank,
 * so the right-hand windows sit just above it and the left-hand ones are their
 * mirror about u = 0.5.
 */
const WINDOWS = [
  // Windscreen, wrapping over the crown. Split either side of the centre post.
  { z0: -1.76, z1: -1.30, u0: 0.320, u1: 0.489 },
  { z0: -1.76, z1: -1.30, u0: 0.511, u1: 0.680 },
  // Right cabin door window and rear quarter light.
  { z0: -1.30, z1: -0.20, u0: 0.268, u1: 0.386 },
  { z0: -0.06, z1: 0.62, u0: 0.272, u1: 0.374 },
  // Left.
  { z0: -1.30, z1: -0.20, u0: 0.614, u1: 0.732 },
  { z0: -0.06, z1: 0.62, u0: 0.626, u1: 0.728 },
];

const AF_WING = { m: 0.02, p: 0.4, t: 0.12 }; // NACA 2412
const AF_TAIL = { m: 0, p: 0.4, t: 0.09 }; // NACA 0009

const WING = {
  semiSpan: 5.5,
  taperStart: 2.3,
  taperEnd: 5.3,
  rootChord: 1.625,
  tipChord: 1.12,
  leSweep: 0.06, // tip LE this far aft of root LE
  rootLEz: -0.72,
  rootY: 0.96,
  dihedral: 1.733 * DEG_TO_RAD,
  twistRoot: 1.5 * DEG_TO_RAD,
  twistTip: -1.5 * DEG_TO_RAD,
  pivot: 0.25,
  hingeFrac: 0.72, // flap and aileron hinge, as a fraction of local chord
};

/** Wing planform at |span| s, in the canonical +X frame. */
function wingPlanform(s) {
  const q = clamp((s - WING.taperStart) / (WING.taperEnd - WING.taperStart), 0, 1);
  let chord = WING.rootChord + (WING.tipChord - WING.rootChord) * q;
  let zLE = WING.rootLEz + WING.leSweep * (s / WING.taperEnd);
  let thick = 1;
  if (s > WING.taperEnd) {
    // Rounded Hoerner-style tip: thickness to zero on an ellipse, chord pulled
    // in about the mid-chord so the planform closes instead of ending in a slab.
    const u = clamp((s - WING.taperEnd) / (WING.semiSpan - WING.taperEnd), 0, 1);
    const r = Math.sqrt(Math.max(0, 1 - u * u));
    thick = r;
    const mid = zLE + chord * 0.5;
    chord *= 0.7 + 0.3 * r;
    zLE = mid - chord * 0.5;
  }
  return {
    chord,
    zLE,
    y: WING.rootY + Math.tan(WING.dihedral) * s,
    twist: WING.twistRoot + (WING.twistTip - WING.twistRoot) * (s / WING.semiSpan),
    thick,
  };
}

/** World-space point on the wing at span s and chord fraction f (right side). */
function wingPoint(s, f, out) {
  const pl = wingPlanform(s);
  const zc = (f - WING.pivot) * pl.chord;
  const cw = Math.cos(pl.twist);
  const sw = Math.sin(pl.twist);
  return (out || new THREE.Vector3()).set(
    s,
    pl.y - zc * sw,
    pl.zLE + WING.pivot * pl.chord + zc * cw,
  );
}

/** Chord fraction on the wing that lands on a fixed Z at span s. */
function wingFracAtZ(s, z) {
  const pl = wingPlanform(s);
  return clamp((z - pl.zLE) / pl.chord, 0.05, 0.95);
}

const HSTAB = {
  semiSpan: 1.72,
  rootChord: 1.10,
  tipChord: 0.72,
  rootLEz: 3.05,
  leSweep: 0.30,
  y: 0.32,
  hingeFrac: 0.55,
  rootGap: 0.16,
};

function hstabPlanform(s) {
  const q = clamp(s / (HSTAB.semiSpan - 0.14), 0, 1);
  let chord = HSTAB.rootChord + (HSTAB.tipChord - HSTAB.rootChord) * q;
  let zLE = HSTAB.rootLEz + HSTAB.leSweep * q;
  let thick = 1;
  if (s > HSTAB.semiSpan - 0.14) {
    const u = clamp((s - (HSTAB.semiSpan - 0.14)) / 0.14, 0, 1);
    const r = Math.sqrt(Math.max(0, 1 - u * u));
    thick = r;
    const mid = zLE + chord * 0.5;
    chord *= 0.7 + 0.3 * r;
    zLE = mid - chord * 0.5;
  }
  return { chord, zLE, y: HSTAB.y, twist: 0, thick };
}

/**
 * The fin, built in the canonical +X-span frame and then stood upright. Span
 * here is height above the fin root.
 */
const FIN = {
  root: 0.31, // y of the fin root
  height: 1.24, // to y = 1.55
  rootChord: 1.62,
  tipChord: 0.74,
  rootLEz: 2.72,
  leSweep: 1.10, // strongly swept, as on the 172
  hingeFrac: 0.60,
};

function finPlanform(s) {
  const q = clamp(s / (FIN.height - 0.10), 0, 1);
  let chord = FIN.rootChord + (FIN.tipChord - FIN.rootChord) * q;
  let zLE = FIN.rootLEz + FIN.leSweep * q;
  let thick = 1;
  if (s > FIN.height - 0.10) {
    const u = clamp((s - (FIN.height - 0.10)) / 0.10, 0, 1);
    const r = Math.sqrt(Math.max(0, 1 - u * u));
    thick = r;
    const mid = zLE + chord * 0.5;
    chord *= 0.72 + 0.28 * r;
    zLE = mid - chord * 0.5;
  }
  return { chord, zLE, y: 0, twist: 0, thick };
}

function finFracAtZ(s, z) {
  const pl = finPlanform(s);
  return clamp((z - pl.zLE) / pl.chord, 0.05, 0.95);
}

// ===========================================================================
// 5. createAircraft
// ===========================================================================

/**
 * @param {THREE.Scene} scene
 * @param {{renderer?: THREE.WebGLRenderer, registration?: string}} [opts]
 *        `renderer` is optional and only used once, at construction, to
 *        prefilter a small procedural environment map for the paint and glass.
 *        Omit it and the aircraft still builds; it just loses its reflections.
 * @returns {{group: THREE.Group,
 *            setControlSurfaces: (c: {pitch?: number, roll?: number, yaw?: number, flaps?: number}) => void,
 *            spinProp: (rpm: number, dt: number) => void,
 *            dispose: () => void}}
 */
export function createAircraft(scene, opts = {}) {
  const group = new THREE.Group();
  group.name = 'aircraft';

  const disposables = [];
  const track = (x) => {
    disposables.push(x);
    return x;
  };

  // ---- environment -------------------------------------------------------
  // There is ALWAYS an envMap. If the caller handed us a renderer we prefilter
  // a proper one; otherwise we hand three a raw equirect texture and let it
  // prefilter that itself on the first render. The aircraft must never end up
  // with envMap = null — see makeSkyEnvTexture for why that costs more than it
  // sounds like.
  let envMap = null;
  if (opts.renderer) {
    try {
      envMap = makeEnvironment(opts.renderer);
      disposables.push(envMap);
    } catch (err) {
      console.warn('[aircraft] prefiltered environment unavailable:', err && err.message);
      envMap = null;
    }
  }
  if (!envMap) {
    try {
      envMap = makeSkyEnvTexture();
      disposables.push(envMap);
    } catch (err) {
      console.warn('[aircraft] environment map unavailable:', err && err.message);
      envMap = null;
    }
  }

  // ---- textures ----------------------------------------------------------
  let fuseMap = null;
  let fuseNormal = null;
  let wingMap = null;
  let wingNormal = null;
  let discMap = null;
  if (HAS_CANVAS) {
    try {
      const f = makeFuselageTexture(FUSELAGE[0][0], FUSELAGE[FUSELAGE.length - 1][0],
        WINDOWS, opts.registration || 'N172KA');
      fuseMap = track(new THREE.CanvasTexture(f.map));
      fuseMap.colorSpace = THREE.SRGBColorSpace;
      fuseMap.anisotropy = 8;
      fuseNormal = track(normalFromHeight(f.height, 3.2, 2048));
      fuseNormal.anisotropy = 8;

      const w = makeWingTexture();
      wingMap = track(new THREE.CanvasTexture(w.map));
      wingMap.colorSpace = THREE.SRGBColorSpace;
      wingMap.anisotropy = 8;
      wingNormal = track(normalFromHeight(w.height, 2.6, 1024));
      wingNormal.anisotropy = 8;

      discMap = track(new THREE.CanvasTexture(makePropDiscTexture()));
      discMap.colorSpace = THREE.SRGBColorSpace;
    } catch (err) {
      console.warn('[aircraft] procedural textures unavailable:', err && err.message);
    }
  }

  // ---- materials ---------------------------------------------------------
  // Painted aluminium: not a metal in the PBR sense (the paint is a dielectric
  // layer), so metalness stays low and the shine comes from clearcoat. Full
  // metalness here is the single most common reason a hand-built aircraft
  // looks like a toy.
  const paint = track(new THREE.MeshPhysicalMaterial({
    color: 0xffffff,
    map: fuseMap,
    normalMap: fuseNormal,
    metalness: 0.18,
    roughness: 0.34,
    clearcoat: 0.55,
    clearcoatRoughness: 0.22,
    envMap,
    envMapIntensity: 0.85,
  }));
  if (fuseNormal) paint.normalScale.set(0.7, 0.7);
  const paintWing = track(paint.clone());
  paintWing.map = wingMap;
  paintWing.normalMap = wingNormal;
  if (wingNormal) paintWing.normalScale.set(0.55, 0.55);
  paintWing.side = THREE.DoubleSide; // trailing edges are knife-thin

  const trim = track(new THREE.MeshPhysicalMaterial({
    color: 0x1d3f6e,
    metalness: 0.2,
    roughness: 0.3,
    clearcoat: 0.6,
    envMap,
    envMapIntensity: 0.85,
  }));

  const bareMetal = track(new THREE.MeshStandardMaterial({
    color: 0x9aa0a8,
    metalness: 0.85,
    roughness: 0.32,
    envMap,
    envMapIntensity: 1.0,
  }));

  const darkMetal = track(new THREE.MeshStandardMaterial({
    color: 0x33383f,
    metalness: 0.7,
    roughness: 0.45,
    envMap,
    envMapIntensity: 0.7,
  }));

  const rubber = track(new THREE.MeshStandardMaterial({
    color: 0x14161a,
    metalness: 0.0,
    roughness: 0.92,
  }));

  // Tinted cabin glass. transmission is deliberately not used: it forces a
  // scene render-target per frame, and at 60 fps over a 90 km terrain that is
  // not a trade worth making for four windows. Plain alpha plus a strong
  // clearcoat gets the same read at chase distance for nothing.
  //
  // BALANCED FROM INSIDE, NOT OUTSIDE. opacity 0.30 with envMapIntensity 1.6
  // reads well in the chase view — the glass catches the sky and the aeroplane
  // looks glazed rather than open. Seen from the COCKPIT, where the camera is
  // 1 m from the same surface and looking through it at the thing the sim
  // exists to show, that combination is a milky veil over the whole windscreen:
  // the sky reflection is added on top of everything beyond it, and at 1.6x it
  // beat the terrain it was supposed to be revealing.
  //
  // The windscreen is the primary view in a flight simulator, so it wins the
  // argument. Reflection is kept — a raked screen genuinely does catch skylight
  // — just brought back to where Seattle is visible through it.
  const glassMat = track(new THREE.MeshPhysicalMaterial({
    color: 0x8fa6b8,
    metalness: 0.0,
    roughness: 0.06,
    transparent: true,
    opacity: 0.16,
    clearcoat: 1.0,
    clearcoatRoughness: 0.03,
    side: THREE.DoubleSide,
    depthWrite: false,
    envMap,
    envMapIntensity: 0.5,
  }));

  const cabinLining = track(new THREE.MeshStandardMaterial({
    color: 0x3a3d42,
    roughness: 0.9,
    metalness: 0.0,
    side: THREE.BackSide,
  }));
  const trimCloth = track(new THREE.MeshStandardMaterial({
    color: 0x4a4038,
    roughness: 0.95,
    metalness: 0.0,
  }));
  const panelMat = track(new THREE.MeshStandardMaterial({
    color: 0x1a1c20,
    roughness: 0.65,
    metalness: 0.1,
  }));

  const mkLamp = (c) => track(new THREE.MeshStandardMaterial({
    color: c,
    emissive: c,
    emissiveIntensity: 1.4,
    roughness: 0.25,
    metalness: 0,
  }));
  const lampRed = mkLamp(0xd8202a);
  const lampGreen = mkLamp(0x18c04a);
  const lampWhite = mkLamp(0xf2f2ea);

  const add = (geo, mat, parent) => {
    const m = new THREE.Mesh(track(geo), mat);
    m.castShadow = true;
    m.receiveShadow = true;
    (parent || group).add(m);
    return m;
  };

  // ---- fuselage ----------------------------------------------------------
  // Ring spacing is dense forward, where the cowl, windscreen and cabin
  // shoulders carry all the curvature, and coarse down the tailcone which is
  // very nearly a straight taper.
  const ringZ = [];
  const pushRange = (a, b, step) => {
    for (let z = a; z < b - 1e-6; z += step) ringZ.push(z);
  };
  pushRange(-3.05, -1.20, 0.055);
  pushRange(-1.20, 1.00, 0.10);
  pushRange(1.00, 4.62, 0.16);
  ringZ.push(4.62);

  const fuse = buildFuselage(FUSELAGE, ringZ, 48, WINDOWS);
  const fuselage = add(fuse.shell, paint);
  fuselage.name = 'fuselage';

  // Cabin lining, so the windows look into an interior rather than out the
  // far side of the aeroplane.
  //
  // THE LINING MUST CARRY THE SAME OPENINGS AS THE SHELL. It is BackSide and
  // the cockpit eye sits inside it, so an unbroken lining is an opaque box
  // around the pilot: the side windows show grey trim instead of Seattle, and
  // — because the lining's roof slopes down through the windscreen station
  // about 0.4 m in front of the eye — the forward view is blocked outright.
  //
  // The openings are cut OVERSIZE. The lining is lofted at a coarser ring and
  // station spacing than the shell (32/0.12 vs 48/0.055), so quad centres fall
  // in different places and an exactly-matching rectangle would leave slivers
  // of lining poking into the window edges. Growing the hole hides the lining
  // behind the shell's own aperture instead, which is where a real door post
  // and window frame are anyway.
  const LINING_WINDOW_MARGIN_Z = 0.09; // metres of station
  const LINING_WINDOW_MARGIN_U = 0.022; // ring fraction
  const liningWindows = WINDOWS.map((w) => ({
    z0: w.z0 - LINING_WINDOW_MARGIN_Z,
    z1: w.z1 + LINING_WINDOW_MARGIN_Z,
    u0: w.u0 - LINING_WINDOW_MARGIN_U,
    u1: w.u1 + LINING_WINDOW_MARGIN_U,
  }));
  const liningTable = FUSELAGE
    .filter((r) => r[0] > -1.95 && r[0] < 1.10)
    .map((r) => [r[0], r[1] * 0.94, r[2] * 0.94, r[3], r[4]]);
  const liningZ = [];
  for (let z = liningTable[0][0]; z <= liningTable[liningTable.length - 1][0]; z += 0.12) {
    liningZ.push(z);
  }
  const lining = buildFuselage(liningTable, liningZ, 32, liningWindows);
  add(lining.shell, cabinLining);
  if (lining.glass) lining.glass.dispose();

  if (fuse.glass) {
    const glass = new THREE.Mesh(track(fuse.glass), glassMat);
    glass.renderOrder = 2;
    glass.name = 'glazing';
    group.add(glass);
  }

  // ---- wing --------------------------------------------------------------
  // Built in five spanwise panels per side. The panels that carry a flap or an
  // aileron are truncated at the hinge chord; the rest run to the trailing
  // edge. Every panel samples the same planform function, so they mate exactly
  // and there is no seam to hide.
  const wingRoot = new THREE.Group();
  wingRoot.name = 'wing';
  group.add(wingRoot);

  const FLAP_SPAN = [0.42, 2.75];
  const AIL_SPAN = [2.95, 5.25];
  // A straight hinge line is a hard requirement: one Quaternion rotation can
  // only reproduce a deflection about a straight axis. Both hinges are
  // therefore fixed in Z, and the chord fraction is solved per station.
  const FLAP_HINGE_Z = wingPoint(1.5, WING.hingeFrac, new THREE.Vector3()).z;
  const AIL_HINGE_Z = wingPoint(4.1, WING.hingeFrac, new THREE.Vector3()).z;

  const wingPanels = [
    { a: 0.0, b: FLAP_SPAN[0], end: 1.0, steps: 3 },
    { a: FLAP_SPAN[0], b: FLAP_SPAN[1], end: (s) => wingFracAtZ(s, FLAP_HINGE_Z), steps: 7 },
    { a: FLAP_SPAN[1], b: AIL_SPAN[0], end: 1.0, steps: 2 },
    { a: AIL_SPAN[0], b: AIL_SPAN[1], end: (s) => wingFracAtZ(s, AIL_HINGE_Z), steps: 8 },
    { a: AIL_SPAN[1], b: WING.semiSpan, end: 1.0, steps: 6 },
  ];
  for (const side of [false, true]) {
    for (const p of wingPanels) {
      add(buildLiftingSurface({
        planform: wingPlanform,
        airfoil: AF_WING,
        spanStart: p.a,
        spanEnd: p.b,
        spanSteps: p.steps,
        chordStart: 0,
        chordEnd: p.end,
        pivotFrac: WING.pivot,
        profileSteps: 22,
        // Every panel junction is closed off. The caps of two abutting panels
        // are inset 2 mm in opposite directions by the builder, so they are
        // never coplanar and never z-fight. Without them you can see into the
        // wing through the flap well the moment the flaps come down.
        capStart: p.a > 0.001,
        capEnd: true,
        mirror: side,
      }), paintWing, wingRoot);
    }
  }

  // Wing root fairing: the wing chord line sits at y = 0.96 and the cabin
  // crown at 0.91, so without a fillet the wing floats over the roof shoulders.
  //
  // An ellipsoid, not a half-cylinder: a sphere has no preferred axis, so the
  // scale cannot come out along the wrong one. (Three composes T*R*S, so on a
  // rotated cylinder `scale.y` stretches the length, not the height — that
  // mistake puts a 2.7 m hump down the middle of the roof.)
  //
  // Sized so it is buried inside the hull everywhere except within ~0.25 m of
  // the centreline, where it rises 50 mm above the crown and meets the wing.
  const fairing = new THREE.Mesh(track(new THREE.SphereGeometry(1, 24, 14)), paint);
  fairing.position.set(0, 0.62, -0.16);
  fairing.scale.set(0.44, 0.34, 1.0);
  group.add(fairing);

  /**
   * Hinged control surface: a pivot Group sitting on the hinge line, with the
   * surface geometry translated so the hinge passes through its origin. The
   * deflection is then one setFromAxisAngle about a precomputed unit axis,
   * which works for a swept or dihedral hinge just as well as an orthogonal
   * one — and allocates nothing per frame.
   */
  function hinged(geoOpts, axisFrom, axisTo, material) {
    const pivot = new THREE.Group();
    pivot.userData.animated = true; // keep bakeStatic away from it
    const axis = new THREE.Vector3().subVectors(axisTo, axisFrom).normalize();
    if (axis.x < 0) axis.negate(); // keep every X-ish hinge pointing +X so the
    // sign of the deflection means the same thing on both sides
    pivot.position.copy(axisFrom);
    add(buildLiftingSurface({ ...geoOpts, offset: axisFrom }), material, pivot);
    return { pivot, axis };
  }

  const _pA = new THREE.Vector3();
  const _pB = new THREE.Vector3();

  const mkWingSurface = (span, hingeZ, mirror) => {
    wingPoint(span[0], wingFracAtZ(span[0], hingeZ), _pA);
    wingPoint(span[1], wingFracAtZ(span[1], hingeZ), _pB);
    const a = _pA.clone();
    const b = _pB.clone();
    if (mirror) {
      a.x = -a.x;
      b.x = -b.x;
    }
    const h = hinged({
      planform: wingPlanform,
      airfoil: AF_WING,
      spanStart: span[0] + 0.03,
      spanEnd: span[1] - 0.03,
      spanSteps: 6,
      chordStart: (s) => wingFracAtZ(s, hingeZ),
      chordEnd: 1.0,
      pivotFrac: WING.pivot,
      profileSteps: 14,
      roundLE: true,
      capStart: true,
      capEnd: true,
      mirror,
    }, a, b, paintWing);
    wingRoot.add(h.pivot);
    return h;
  };

  const aileronR = mkWingSurface(AIL_SPAN, AIL_HINGE_Z, false);
  const aileronL = mkWingSurface(AIL_SPAN, AIL_HINGE_Z, true);
  const flapR = mkWingSurface(FLAP_SPAN, FLAP_HINGE_Z, false);
  const flapL = mkWingSurface(FLAP_SPAN, FLAP_HINGE_Z, true);

  // ---- horizontal tail ---------------------------------------------------
  const hstabHingeZ = hstabPlanform(1.0).zLE + hstabPlanform(1.0).chord * HSTAB.hingeFrac;
  const hstabFrac = (s) => {
    const pl = hstabPlanform(s);
    return clamp((hstabHingeZ - pl.zLE) / pl.chord, 0.1, 0.9);
  };
  // Two panels per side, not one with a stepped chordEnd: a step evaluated
  // between span samples turns into a ramp, and the stabiliser comes out with
  // a phantom taper over its inboard 160 mm instead of a clean rib.
  for (const side of [false, true]) {
    add(buildLiftingSurface({
      planform: hstabPlanform,
      airfoil: AF_TAIL,
      spanStart: 0,
      spanEnd: HSTAB.rootGap,
      spanSteps: 2,
      chordStart: 0,
      chordEnd: 1.0,
      pivotFrac: 0.25,
      profileSteps: 16,
      capEnd: true,
      mirror: side,
    }), paintWing, group);
    add(buildLiftingSurface({
      planform: hstabPlanform,
      airfoil: AF_TAIL,
      spanStart: HSTAB.rootGap,
      spanEnd: HSTAB.semiSpan,
      spanSteps: 7,
      chordStart: 0,
      chordEnd: hstabFrac,
      pivotFrac: 0.25,
      profileSteps: 16,
      capStart: true,
      capEnd: true,
      mirror: side,
    }), paintWing, group);
  }
  const mkElevator = (mirror) => {
    const a = new THREE.Vector3((mirror ? -1 : 1) * HSTAB.rootGap, HSTAB.y, hstabHingeZ);
    const b = new THREE.Vector3((mirror ? -1 : 1) * HSTAB.semiSpan, HSTAB.y, hstabHingeZ);
    const h = hinged({
      planform: hstabPlanform,
      airfoil: AF_TAIL,
      spanStart: HSTAB.rootGap + 0.02,
      spanEnd: HSTAB.semiSpan - 0.04,
      spanSteps: 5,
      chordStart: hstabFrac,
      chordEnd: 1.0,
      pivotFrac: 0.25,
      profileSteps: 12,
      roundLE: true,
      capStart: true,
      capEnd: true,
      mirror,
    }, a, b, paintWing);
    group.add(h.pivot);
    return h;
  };
  const elevatorR = mkElevator(false);
  const elevatorL = mkElevator(true);

  // ---- vertical tail -----------------------------------------------------
  // Built span-along-+X then stood up, because that is the frame the lifting
  // surface builder works in. The hinge is held at a fixed Z so the rudder
  // swings about a true vertical, matching the real hinge line closely enough
  // that the fin-to-rudder gap stays constant through full travel.
  const RUD_HINGE_Z = finPlanform(0.6).zLE + finPlanform(0.6).chord * FIN.hingeFrac;
  const uprightFin = (geo) => {
    geo.applyMatrix4(new THREE.Matrix4().makeRotationZ(Math.PI / 2));
    geo.translate(0, FIN.root, 0);
    return geo;
  };
  add(uprightFin(buildLiftingSurface({
    planform: finPlanform,
    airfoil: { m: 0, p: 0.4, t: 0.10 },
    spanStart: 0,
    spanEnd: FIN.height,
    spanSteps: 8,
    chordStart: 0,
    chordEnd: (s) => finFracAtZ(s, RUD_HINGE_Z),
    pivotFrac: 0.25,
    profileSteps: 16,
    capStart: false,
    capEnd: true,
  })), paintWing);

  const rudderPivot = new THREE.Group();
  rudderPivot.userData.animated = true;
  rudderPivot.position.set(0, FIN.root, RUD_HINGE_Z);
  {
    const g = buildLiftingSurface({
      planform: finPlanform,
      airfoil: { m: 0, p: 0.4, t: 0.10 },
      spanStart: 0.02,
      spanEnd: FIN.height - 0.03,
      spanSteps: 6,
      chordStart: (s) => finFracAtZ(s, RUD_HINGE_Z),
      chordEnd: 1.0,
      pivotFrac: 0.25,
      profileSteps: 12,
      roundLE: true,
      capStart: true,
      capEnd: true,
    });
    g.applyMatrix4(new THREE.Matrix4().makeRotationZ(Math.PI / 2));
    g.translate(0, FIN.root, 0);
    g.translate(0, -FIN.root, -RUD_HINGE_Z);
    add(g, paintWing, rudderPivot);
  }
  group.add(rudderPivot);
  const RUDDER_AXIS = new THREE.Vector3(0, 1, 0);

  // Dorsal fin: the fillet running forward from the fin leading edge along the
  // top of the tailcone. Small, but it is a large part of what makes the tail
  // read as a Cessna rather than a generic fin.
  {
    const pts = [];
    const wid = [];
    for (let i = 0; i <= 10; i++) {
      const t = i / 10;
      const z = 1.55 + (FIN.rootLEz - 1.55) * t;
      const y = fuse.sampler.fc(z) + fuse.sampler.fh(z) * 0.96;
      pts.push(new THREE.Vector3(0, y + 0.02 + 0.24 * t * t, z));
      wid.push(0.012 + 0.03 * t);
    }
    const g = sweep(pts, (t) => 0.012 + 0.03 * t, (t) => 0.012 + 0.03 * t, 6,
      new THREE.Vector3(1, 0, 0));
    add(g, paint);
    // Fill between the dorsal spine and the tailcone with a thin web.
    const web = [];
    const idx = [];
    for (let i = 0; i <= 10; i++) {
      const t = i / 10;
      const z = 1.55 + (FIN.rootLEz - 1.55) * t;
      const yTop = pts[i].y;
      const yBot = fuse.sampler.fc(z) + fuse.sampler.fh(z) * 0.9;
      web.push(0.018, yTop, z, 0.018, yBot, z, -0.018, yTop, z, -0.018, yBot, z);
    }
    for (let i = 0; i < 10; i++) {
      const a = i * 4;
      idx.push(a, a + 1, a + 4, a + 1, a + 5, a + 4);
      idx.push(a + 2, a + 6, a + 3, a + 3, a + 6, a + 7);
    }
    const wg = new THREE.BufferGeometry();
    wg.setAttribute('position', new THREE.Float32BufferAttribute(web, 3));
    wg.setIndex(idx);
    wg.computeVertexNormals();
    add(wg, paint);
  }

  // ---- lift struts -------------------------------------------------------
  // Streamlined section: 0.10 m chord, 0.032 m thick, aligned fore-and-aft.
  for (const s of [1, -1]) {
    const top = wingPoint(2.62, 0.42, new THREE.Vector3());
    top.x *= s;
    top.y -= 0.06;
    const bottom = new THREE.Vector3(s * 0.30, -0.44, -0.14);
    const pts = [];
    for (let i = 0; i <= 6; i++) {
      const t = i / 6;
      pts.push(new THREE.Vector3().lerpVectors(bottom, top, t));
    }
    add(sweep(pts, () => 0.017, (t) => 0.055 * (1 - 0.15 * t), 10,
      new THREE.Vector3(0, 0, 1)), paint);
    // Strut root cuff.
    const cuff = new THREE.Mesh(track(new THREE.SphereGeometry(0.085, 12, 8)), paint);
    cuff.position.copy(bottom);
    cuff.scale.set(0.8, 1, 1.7);
    group.add(cuff);
  }

  // ---- landing gear ------------------------------------------------------
  // Contact patch at y = -1.20 exactly: that is flightModel's gearHeightM and
  // the reason the wheels meet the terrain instead of floating over it.
  const GROUND = -1.20;
  const MAIN_R = 0.24;
  const NOSE_R = 0.20;
  const MAIN_Z = 0.05;
  const NOSE_Z = -1.80;
  const TRACK = 1.265;

  const wheel = (x, y, z, r, width, parent) => {
    const w = new THREE.Group();
    w.position.set(x, y, z);
    const tyre = new THREE.Mesh(
      track(new THREE.TorusGeometry(r - width * 0.42, width * 0.42, 12, 26)),
      rubber,
    );
    tyre.rotation.y = Math.PI / 2;
    tyre.castShadow = true;
    w.add(tyre);
    const hub = new THREE.Mesh(
      track(new THREE.CylinderGeometry(r * 0.52, r * 0.52, width * 0.92, 18)),
      bareMetal,
    );
    hub.rotation.z = Math.PI / 2;
    w.add(hub);
    const disc = new THREE.Mesh(
      track(new THREE.CylinderGeometry(r * 0.66, r * 0.66, width * 0.12, 18)),
      darkMetal,
    );
    disc.rotation.z = Math.PI / 2;
    disc.position.x = width * 0.5;
    w.add(disc);
    (parent || group).add(w);
    return w;
  };

  for (const s of [1, -1]) {
    // Spring-steel main leg: a flat tapered strap, broad face forward. Swept
    // as a shallow arc rather than a straight line, which is what it looks
    // like unloaded.
    const legPts = [];
    for (let i = 0; i <= 8; i++) {
      const t = i / 8;
      legPts.push(new THREE.Vector3(
        s * (0.24 + (TRACK - 0.24) * t),
        -0.50 - 0.46 * t - 0.08 * Math.sin(t * Math.PI),
        MAIN_Z,
      ));
    }
    add(sweep(legPts, (t) => 0.020 - 0.006 * t, (t) => 0.062 - 0.020 * t, 8,
      new THREE.Vector3(0, 0, 1)), darkMetal);
    wheel(s * TRACK, GROUND + MAIN_R, MAIN_Z, MAIN_R, 0.15);
    // Step, on the right leg only, as fitted.
    if (s > 0) {
      const step = new THREE.Mesh(track(new THREE.BoxGeometry(0.16, 0.03, 0.09)), darkMetal);
      step.position.set(s * 0.86, -0.86, MAIN_Z + 0.02);
      group.add(step);
    }
  }

  // Nose gear: oleo strut raked forward, forked, with the shimmy damper.
  {
    const top = new THREE.Vector3(0, -0.36, NOSE_Z + 0.10);
    const bot = new THREE.Vector3(0, GROUND + NOSE_R, NOSE_Z);
    add(sweep([top, new THREE.Vector3().lerpVectors(top, bot, 0.5), bot],
      () => 0.052, () => 0.052, 12, new THREE.Vector3(0, 0, 1)), bareMetal);
    const sleeve = new THREE.Mesh(
      track(new THREE.CylinderGeometry(0.068, 0.072, 0.34, 14)), darkMetal);
    sleeve.position.set(0, -0.50, NOSE_Z + 0.075);
    sleeve.rotation.x = -0.16;
    group.add(sleeve);
    for (const s of [1, -1]) {
      const fork = new THREE.Mesh(track(new THREE.BoxGeometry(0.026, 0.26, 0.075)), darkMetal);
      fork.position.set(s * 0.10, GROUND + NOSE_R + 0.12, NOSE_Z);
      group.add(fork);
    }
    wheel(0, GROUND + NOSE_R, NOSE_Z, NOSE_R, 0.12);
  }

  // ---- cowl detail -------------------------------------------------------
  for (const s of [1, -1]) {
    const inlet = new THREE.Mesh(track(new THREE.SphereGeometry(0.105, 14, 10)), panelMat);
    inlet.position.set(s * 0.20, 0.03, -2.98);
    inlet.scale.set(1.05, 0.66, 0.55);
    group.add(inlet);
  }
  {
    const exhaust = new THREE.Mesh(
      track(new THREE.CylinderGeometry(0.045, 0.05, 0.30, 12)), darkMetal);
    exhaust.rotation.x = Math.PI / 2 - 0.25;
    exhaust.position.set(-0.19, -0.35, -2.42);
    group.add(exhaust);
  }

  // ---- propeller ---------------------------------------------------------
  const propPivot = new THREE.Group();
  propPivot.name = 'propeller';
  propPivot.userData.animated = true;
  propPivot.position.set(0, 0, -3.05);
  group.add(propPivot);

  // Spinner: an ogive of revolution, not a cone. The profile is a quarter
  // ellipse, which is the shape that actually sits on a 172.
  {
    const pts = [];
    for (let i = 0; i <= 12; i++) {
      const t = i / 12;
      pts.push(new THREE.Vector2(0.19 * Math.sqrt(Math.max(0, 1 - t * t)) + 0.002, -0.40 * t));
    }
    // Lathe builds about +Y; +PI/2 about X lays the axis down -Z so the nose
    // of the spinner points forward. The other sign buries it in the cowl.
    const g = track(new THREE.LatheGeometry(pts, 24));
    g.rotateX(Math.PI / 2);
    const spinner = new THREE.Mesh(g, trim);
    spinner.castShadow = true;
    propPivot.add(spinner);
  }

  // Two blades, tapered and twisted from root to tip: high pitch inboard where
  // the local helix angle is steep, washing out to fine pitch at the tip.
  const bladeMat = track(new THREE.MeshStandardMaterial({
    color: 0x24262b,
    metalness: 0.55,
    roughness: 0.42,
    transparent: true,
    opacity: 1,
    envMap,
    envMapIntensity: 0.7,
  }));
  const bladeTipMat = track(new THREE.MeshStandardMaterial({
    color: 0xd8c23a,
    metalness: 0.3,
    roughness: 0.45,
    transparent: true,
    opacity: 1,
  }));

  const bladeGroup = new THREE.Group();
  // The blades leave the spinner about a quarter of the way along it, not at
  // its base — at the base they sit level with the cowl mouth and the cowl
  // swallows them whole.
  bladeGroup.position.z = -0.11;
  propPivot.add(bladeGroup);
  {
    // Blade angle beta is measured from the PLANE OF ROTATION — 26 deg at the
    // root washing out to 4 deg at the tip, which is a fixed-pitch cruise prop.
    //
    // buildLiftingSurface's `twist` is measured the other way. Its chord lies
    // along +Z at twist = 0, and +Z here is the prop AXIS, so twist = 0 is a
    // fully feathered blade and the blade angle is (90 - twist). Feeding beta
    // straight in gives a 64 deg blade: edge-on, a paddle, visibly wrong the
    // whole time the engine is at idle and the blades are still solid.
    const beta = (s) => (26 - 22 * clamp((s - 0.18) / 0.77, 0, 1)) * DEG_TO_RAD;
    const bladePlanform = (s) => ({
      chord: 0.20 - 0.07 * Math.pow(clamp((s - 0.18) / 0.77, 0, 1), 1.8),
      zLE: 0,
      y: 0,
      twist: Math.PI / 2 - beta(s),
      thick: 1 - 0.45 * clamp((s - 0.18) / 0.77, 0, 1),
    });
    const bg = buildLiftingSurface({
      planform: bladePlanform,
      airfoil: { m: 0.04, p: 0.4, t: 0.16 },
      spanStart: 0.10,
      spanEnd: 0.95,
      spanSteps: 9,
      chordStart: 0,
      chordEnd: 1,
      pivotFrac: 0.42,
      profileSteps: 12,
      capEnd: true,
    });
    track(bg);
    for (let i = 0; i < 2; i++) {
      const b = new THREE.Mesh(bg, bladeMat);
      b.castShadow = true;
      b.rotation.z = i * Math.PI;
      bladeGroup.add(b);
      // Yellow tip band, PARENTED TO ITS BLADE. As a sibling of the blade it
      // would need the 180 deg blade rotation folded into its own transform by
      // hand, and it would not follow the blade's twist at all — which shows as
      // a band lying across the chord instead of along it.
      const tip = new THREE.Mesh(track(new THREE.BoxGeometry(0.10, 0.125, 0.022)), bladeTipMat);
      tip.position.set(0.88, 0, 0);
      tip.rotation.x = -beta(0.88); // align the band's long axis with the chord
      b.add(tip);
    }
  }

  const propDisc = new THREE.Mesh(
    track(new THREE.CircleGeometry(0.95, 40)),
    track(new THREE.MeshBasicMaterial({
      map: discMap,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      side: THREE.DoubleSide,
      toneMapped: false,
    })),
  );
  propDisc.position.z = -0.13;
  propDisc.renderOrder = 3;
  propDisc.visible = false;
  propPivot.add(propDisc);

  // ---- lights, antennae, pitot ------------------------------------------
  const lamp = (x, y, z, mat, r = 0.045) => {
    const m = new THREE.Mesh(track(new THREE.SphereGeometry(r, 10, 8)), mat);
    m.position.set(x, y, z);
    group.add(m);
    return m;
  };
  {
    const tipR = wingPoint(WING.semiSpan - 0.06, 0.16, new THREE.Vector3());
    lamp(tipR.x, tipR.y, tipR.z, lampGreen);
    lamp(-tipR.x, tipR.y, tipR.z, lampRed);
    lamp(0, 1.56, 3.55, lampRed, 0.05); // fin-tip beacon
    lamp(0, 0.30, 4.55, lampWhite, 0.035); // tail nav
    // Landing light, in the left wing leading edge.
    const ll = wingPoint(1.9, 0.02, new THREE.Vector3());
    const lens = new THREE.Mesh(track(new THREE.SphereGeometry(0.07, 12, 8)),
      track(new THREE.MeshStandardMaterial({
        color: 0xe8e4d0, emissive: 0x4a4638, roughness: 0.15, metalness: 0.2,
      })));
    lens.position.set(-ll.x, ll.y - 0.03, ll.z + 0.02);
    lens.scale.set(1.3, 0.7, 0.5);
    group.add(lens);
  }
  {
    // VHF blade antenna on the cabin roof, and the HF wire aerial from the
    // roof to the fin tip. Two of the most recognisable things on a 172.
    const blade = new THREE.Mesh(track(new THREE.BoxGeometry(0.012, 0.17, 0.10)), darkMetal);
    blade.position.set(0, 0.98, 0.62);
    blade.rotation.x = -0.12;
    group.add(blade);
    add(sweep([
      new THREE.Vector3(0, 1.02, 0.60),
      new THREE.Vector3(0, 1.30, 1.90),
      new THREE.Vector3(0, 1.52, 3.20),
    ], () => 0.006, () => 0.006, 5, new THREE.Vector3(1, 0, 0)), darkMetal);
    // Pitot tube under the left wing.
    const pitot = new THREE.Mesh(track(new THREE.CylinderGeometry(0.012, 0.012, 0.20, 8)),
      bareMetal);
    pitot.rotation.x = Math.PI / 2;
    pitot.position.set(-1.55, 0.86, -0.62);
    group.add(pitot);
  }

  // ---- interior ----------------------------------------------------------
  // Not a full cockpit — enough that the glazing has something behind it and
  // the aeroplane reads as occupied at chase distance.
  {
    const floor = new THREE.Mesh(track(new THREE.BoxGeometry(1.02, 0.03, 1.9)), panelMat);
    floor.position.set(0, -0.36, -0.55);
    group.add(floor);

    const panel = new THREE.Mesh(track(new THREE.BoxGeometry(1.04, 0.44, 0.09)), panelMat);
    panel.position.set(0, 0.31, -1.52);
    panel.rotation.x = 0.18;
    group.add(panel);
    const glare = new THREE.Mesh(track(new THREE.BoxGeometry(1.06, 0.05, 0.26)), panelMat);
    glare.position.set(0, 0.52, -1.44);
    glare.rotation.x = 0.42;
    group.add(glare);

    const seat = (x, z) => {
      const cushion = new THREE.Mesh(track(new THREE.BoxGeometry(0.42, 0.10, 0.44)), trimCloth);
      cushion.position.set(x, -0.16, z);
      group.add(cushion);
      const back = new THREE.Mesh(track(new THREE.BoxGeometry(0.42, 0.54, 0.09)), trimCloth);
      back.position.set(x, 0.12, z + 0.22);
      back.rotation.x = -0.13;
      group.add(back);
    };
    seat(-0.28, -0.78);
    seat(0.28, -0.78);
    seat(-0.28, 0.02);
    seat(0.28, 0.02);

    for (const x of [-0.28, 0.28]) {
      const shaft = new THREE.Mesh(track(new THREE.CylinderGeometry(0.018, 0.018, 0.30, 8)),
        panelMat);
      shaft.rotation.x = Math.PI / 2 - 0.2;
      shaft.position.set(x, 0.24, -1.34);
      group.add(shaft);
      const yoke = new THREE.Mesh(track(new THREE.TorusGeometry(0.11, 0.014, 6, 16,
        Math.PI * 1.25)), panelMat);
      yoke.position.set(x, 0.21, -1.20);
      yoke.rotation.z = Math.PI * 0.375;
      group.add(yoke);
    }

    // Pilot, left seat. +X is the right wing, so the left seat is at -X.
    const skin = track(new THREE.MeshStandardMaterial({ color: 0xc99a78, roughness: 0.8 }));
    const shirt = track(new THREE.MeshStandardMaterial({ color: 0x2c4c74, roughness: 0.9 }));
    const torso = new THREE.Mesh(track(new THREE.CapsuleGeometry(0.16, 0.26, 4, 12)), shirt);
    torso.position.set(-0.28, 0.10, -0.80);
    torso.rotation.x = -0.12;
    group.add(torso);
    const head = new THREE.Mesh(track(new THREE.SphereGeometry(0.105, 14, 12)), skin);
    head.position.set(-0.28, 0.42, -0.83);
    head.scale.set(0.92, 1.08, 1);
    group.add(head);
  }

  // Flatten everything that never moves into one mesh per material. Must run
  // while `group` is still at identity — bakeStatic bakes world matrices.
  try {
    for (const g of bakeStatic(group)) disposables.push(g);
  } catch (err) {
    console.warn('[aircraft] static bake skipped:', err && err.message);
  }

  scene.add(group);

  // =========================================================================
  // Animation
  // =========================================================================

  // Actual surface positions, which LAG the stick. See setControlSurfaces.
  let sPitch = 0;
  let sRoll = 0;
  let sYaw = 0;
  let sFlap = 0;
  let lastCallMs = -1;

  /** Move `cur` toward `target` by at most `maxDelta`. */
  function toward(cur, target, maxDelta) {
    const d = target - cur;
    return d > maxDelta ? cur + maxDelta : d < -maxDelta ? cur - maxDelta : target;
  }

  /**
   * Deflect the control surfaces. Cosmetic only; this has no effect on physics.
   * Inputs are normalised stick deflections, NOT angles.
   *
   * THE SURFACES LAG THE STICK, at the same rates flightModel.js uses for the
   * aerodynamic surfaces (4.0 /s) and the flap system (0.2 /s, five seconds
   * lever to detent). Two reasons, and neither is polish:
   *
   *  - The flaps. `main.js` passes the raw input object, whose `flaps` field is
   *    the LEVER, not the flap. The flight model rate-limits it and blows it
   *    back above Vfe. Driving the mesh from the lever means the flaps snap to
   *    30 degrees in one frame and stay there at 120 kt while the physics has
   *    them up — the aeroplane visibly disagreeing with itself.
   *  - A keyboard axis is a step function. Snapping the elevator through 24
   *    degrees in 16 ms reads as a glitch rather than a control input, and it
   *    is the single most obvious tell in a chase-camera comparison.
   *
   * dt is derived internally rather than taken as an argument, because the
   * documented signature is `setControlSurfaces({pitch, roll, yaw})` and this
   * module does not get to change it. It is clamped to 100 ms so a backgrounded
   * tab returns to a sane pose instead of teleporting the surfaces.
   *
   * @param {{pitch?: number, roll?: number, yaw?: number, flaps?: number}} c
   *        pitch -1..+1 (+1 = stick back / nose up / elevator trailing edge up)
   *        roll  -1..+1 (+1 = stick right / roll right)
   *        yaw   -1..+1 (+1 = right rudder)
   *        flaps  0..+1 (optional; main.js already passes the whole input
   *                      object, so flaps animate with no integration work)
   */
  function setControlSurfaces(c) {
    const now =
      typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now();
    const dt = lastCallMs < 0 ? 0 : Math.min((now - lastCallMs) / 1000, 0.1);
    lastCallMs = now;

    sPitch = toward(sPitch, clamp((c && c.pitch) || 0, -1, 1), SURFACE_RATE * dt);
    sRoll = toward(sRoll, clamp((c && c.roll) || 0, -1, 1), SURFACE_RATE * dt);
    sYaw = toward(sYaw, clamp((c && c.yaw) || 0, -1, 1), SURFACE_RATE * dt);
    sFlap = toward(sFlap, clamp((c && c.flaps) || 0, 0, 1), FLAP_RATE * dt);

    const pitch = sPitch;
    const roll = sRoll;
    const yaw = sYaw;
    const flaps = sFlap;

    // Every hinge axis points +X-ish (or +Y for the rudder), so a positive
    // angle always means "trailing edge down" and the two sides only differ in
    // the sign they are handed.
    //
    // Elevator: stick back -> trailing edge UP -> negative.
    const e = -pitch * (pitch > 0 ? ELEVATOR_UP : ELEVATOR_DOWN);
    elevatorR.pivot.quaternion.setFromAxisAngle(elevatorR.axis, e);
    elevatorL.pivot.quaternion.setFromAxisAngle(elevatorL.axis, e);

    // Ailerons, differential: the up-going surface travels 20 deg, the
    // down-going one only 15, which is how the real linkage is rigged to
    // suppress adverse yaw. Roll right -> right TE up, left TE down.
    const rUp = roll > 0;
    aileronR.pivot.quaternion.setFromAxisAngle(
      aileronR.axis, -roll * (rUp ? AILERON_UP : AILERON_DOWN));
    aileronL.pivot.quaternion.setFromAxisAngle(
      aileronL.axis, roll * (rUp ? AILERON_DOWN : AILERON_UP));

    // Right rudder swings the trailing edge to +X.
    rudderPivot.quaternion.setFromAxisAngle(RUDDER_AXIS, yaw * RUDDER_MAX);

    const f = flaps * FLAP_MAX;
    flapR.pivot.quaternion.setFromAxisAngle(flapR.axis, f);
    flapL.pivot.quaternion.setFromAxisAngle(flapL.axis, f);
  }

  let discSpin = 0;

  /**
   * Advance the propeller and cross-fade it to a blur disc.
   *
   * Above about 400 rpm a 60 Hz frame cannot sample two blades without
   * aliasing — they strobe, and a strobing prop is the most obvious tell that
   * something is a game. So the blades fade out over 380-950 rpm and a
   * translucent disc, denser at the tip, fades in behind them. Below that
   * range the blades are solid and turn at their true rate.
   *
   * The prop turns clockwise seen from the cockpit, as a Lycoming O-320 does.
   *
   * @param {number} rpm Revolutions per minute (propeller shaft).
   * @param {number} dt  Frame delta in SECONDS.
   */
  function spinProp(rpm, dt) {
    if (!Number.isFinite(rpm) || !Number.isFinite(dt)) return;
    const r = rpm > 0 ? rpm : 0;
    const d = dt > 0.25 ? 0.25 : dt;

    // Modulo, not a single conditional add: at 2700 rpm a 0.25 s frame is 11
    // revolutions, and one += TAU leaves the angle 64 radians from where it
    // should be. Wrapping properly also keeps the float small enough that the
    // blade positions stay smooth after an hour of flying.
    propPivot.rotation.z = ((propPivot.rotation.z - (r / 60) * TAU * d) % TAU + TAU) % TAU;

    const t = clamp((r - BLUR_START) / (BLUR_FULL - BLUR_START), 0, 1);
    // Blades never vanish entirely: a faint ghost is what a real prop looks
    // like through a camera, and it keeps the disc from reading as a decal.
    bladeMat.opacity = 1 - 0.9 * t;
    bladeTipMat.opacity = 1 - 0.55 * t;
    bladeGroup.visible = t < 0.995;
    propDisc.visible = t > 0.002;
    propDisc.material.opacity = t * 0.92;
    if (propDisc.visible) {
      // Counter-rotate the disc slowly against the blades for a beat pattern.
      discSpin += (r / 60) * TAU * d * 0.037;
      if (discSpin > TAU) discSpin -= TAU;
      propDisc.rotation.z = discSpin;
    }
  }

  function dispose() {
    group.removeFromParent();
    for (const d of disposables) {
      if (d && typeof d.dispose === 'function') d.dispose();
    }
    disposables.length = 0;
  }

  setControlSurfaces({ pitch: 0, roll: 0, yaw: 0, flaps: 0 });
  spinProp(0, 0);

  return { group, setControlSurfaces, spinProp, dispose };
}
