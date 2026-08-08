/**
 * b738model.js — the visual Boeing 737-800: geometry, control surfaces, fans.
 *
 * The sibling of model.js, built from the same lofting.js primitives. No
 * external meshes and no downloaded textures: every surface is lofted from
 * published dimensions and every map is drawn into a canvas at load time.
 *
 *   createB738(scene, opts?) -> { group, setControlSurfaces({pitch,roll,yaw,flaps}),
 *                                 spinProp(n1Pct, dt), dispose() }
 *
 * The same interface as createAircraft, deliberately, so main.js can hold one
 * of these without caring which it has. `spinProp` takes N1 PERCENT rather than
 * rpm — see the note on it — which is the one place the two types differ, and
 * the flight model tells you which to pass through `state.engineGauge`.
 *
 * BODY AXES (local space of `group`), identical to the Cessna's:
 *   -Z = nose / forward       +Z = tail
 *   +X = right wing           -X = left wing
 *   +Y = up (canopy)          -Y = landing gear
 *
 * PURELY COSMETIC. It never moves `group` itself.
 *
 * ---------------------------------------------------------------------------
 * WHY THE NUMBERS ARE WHAT THEY ARE
 * ---------------------------------------------------------------------------
 * physics/airframes/b738.js is configured with wingAreaM2 = 124.6,
 * wingSpanM = 34.32, massKg = 70000 and gearHeightM = 2.9. Those are 737-800
 * numbers, so this is a -800 and not a -700: the stretch is the whole reason
 * the tail strikes at 11 degrees.
 *
 *   wingspan            34.32 m   (112 ft 7 in)  -> semi-span 17.16
 *   length              39.47 m   (129 ft 6 in)  radome to rudder TE
 *   height              12.55 m   (41 ft 2 in)   ground to fin tip
 *   fuselage diameter    3.76 m   (12 ft 4 in)
 *   wing area          124.60 m^2                aspect ratio 9.45
 *   quarter-chord sweep 25 deg
 *   dihedral             6 deg
 *   main gear track      5.72 m
 *   wheelbase           15.60 m
 *   fan diameter         1.55 m   (CFM56-7B)
 *
 * THE VERTICAL DATUM IS SET BY PHYSICS, NOT BY ART. `gearHeightM = 2.9` means
 * the wheel contact patch must be at local y = -2.90. Everything else follows,
 * and every one of these lands on the real aeroplane:
 *
 *   y = -2.90  wheels down              (physics datum)
 *   y = -1.88  belly                 -> 1.02 m belly clearance (real ~1.0)
 *   y = -2.45  nacelle bottom        -> 0.45 m engine clearance (real 0.46)
 *   y =  0.00  fuselage centreline
 *   y =  9.65  fin tip               -> 12.55 m total height (real 12.55)
 *
 * That engine clearance is not a detail. It is the single most consequential
 * dimension on the aeroplane — it is why the CFM56 nacelle is flat-bottomed
 * rather than round, and it is why the type has the landing-gear geometry it
 * has. If it comes out at a comfortable metre, the model is not a 737.
 *
 * WHAT THIS DOES NOT HAVE, and the flight model does not either: spoilers,
 * speedbrakes, thrust reversers, leading-edge slats as separate surfaces, and
 * flap detents. The flaps here are one continuous rotation, matching the
 * single 0..1 flap axis in flightModel.js. When detents arrive, they arrive in
 * both files at once or the aeroplane you see stops being the one you fly.
 */

import * as THREE from 'three';
import { bakeStatic } from '../core/bakeStatic.js';
import { clamp, DEG_TO_RAD } from '../core/units.js';
import { texSize } from '../core/textureBudget.js';
import {
  TAU,
  buildLiftingSurface,
  buildFuselage,
  HAS_CANVAS,
  makeCanvas,
  makeSkinCanvas,
  normalFromHeight,
  drawRivets,
  makeSkyEnvTexture,
  makeEnvironment,
} from './lofting.js';

// ---------------------------------------------------------------------------
// Control-surface travel. Real 737 figures, in radians.
// ---------------------------------------------------------------------------
const ELEVATOR_UP = 20 * DEG_TO_RAD;
const ELEVATOR_DOWN = 25 * DEG_TO_RAD;
/** Ailerons are differential here too: 20 up, 15 down. */
const AILERON_UP = 20 * DEG_TO_RAD;
const AILERON_DOWN = 15 * DEG_TO_RAD;
const RUDDER_MAX = 25 * DEG_TO_RAD;
/** Flaps 40, the landing setting. */
const FLAP_MAX = 40 * DEG_TO_RAD;

/**
 * Rates at which the surfaces chase the stick. These are b738.js's
 * controls.surfaceRate and flaps.travelRate — the numbers have to match or the
 * aeroplane you see is not the one you are flying.
 */
const SURFACE_RATE = 3.0;
const FLAP_RATE = 0.08;

/**
 * Fan-blur thresholds, in N1 PERCENT rather than rpm. A CFM56 fan turns at
 * about 5,200 rpm at 100% N1, so it is past the aliasing point at ground idle
 * and there is no "solid blades" regime to speak of — unlike a propeller,
 * which spends its first 400 rpm looking like blades. Hence a much lower blur
 * onset: by 35% N1 you are looking at a disc, because in life you are.
 */
const BLUR_START = 18;
const BLUR_FULL = 35;

// ===========================================================================
// 1. Airframe geometry definitions
// ===========================================================================

/** Fuselage stations: [z, halfWidth, halfHeight, centreY, exponent]. */
const FUSELAGE = [
  [-19.60, 0.06, 0.06, 0.16, 2.4], // radome tip
  [-19.30, 0.38, 0.36, 0.12, 2.3],
  [-18.80, 0.78, 0.72, 0.06, 2.2],
  [-18.10, 1.20, 1.10, 0.01, 2.2],
  [-17.20, 1.55, 1.44, -0.03, 2.2],
  [-16.20, 1.75, 1.68, -0.04, 2.1],
  [-15.00, 1.85, 1.82, -0.02, 2.1],
  [-13.50, 1.88, 1.88, 0.00, 2.1],
  [-8.00, 1.88, 1.88, 0.00, 2.1],
  [0.00, 1.88, 1.88, 0.00, 2.1],
  [8.00, 1.88, 1.88, 0.00, 2.1],
  [10.80, 1.87, 1.87, 0.02, 2.1],
  [12.60, 1.80, 1.82, 0.12, 2.1],
  [14.40, 1.62, 1.70, 0.34, 2.2],
  [16.20, 1.30, 1.44, 0.66, 2.3],
  [17.80, 0.90, 1.10, 1.00, 2.4],
  [19.10, 0.44, 0.62, 1.28, 2.5],
  [19.87, 0.09, 0.16, 1.45, 2.6],
];

/**
 * Cabin windows, as spans along z with texture coordinates. Two exit-row gaps,
 * because an unbroken 26 m ribbon of windows is the tell that a fuselage was
 * generated rather than drawn.
 */
const WINDOWS = [
  { z0: -13.6, z1: -6.2, u0: 0, u1: 1 },
  { z0: -5.0, z1: 2.6, u0: 0, u1: 1 },
  { z0: 3.8, z1: 11.2, u0: 0, u1: 1 },
];

/** Supercritical-ish wing section, and a thin symmetric tail section. */
const AF_WING = { m: 0.012, p: 0.5, t: 0.115 };
const AF_TAIL = { m: 0, p: 0.4, t: 0.09 };

const WING = {
  semiSpan: 17.16,
  /** The "yehudi" break: inboard of this the trailing edge is nearly straight,
   *  which is what gives a 737 its distinctive kinked planform. */
  breakS: 5.0,
  rootChord: 6.6,
  breakChord: 4.4,
  tipChord: 1.3,
  /** Trailing edge, which is the straight one inboard. */
  rootTEz: 5.0,
  breakTEz: 5.4,
  rootY: -1.1,
  dihedral: 6 * DEG_TO_RAD,
  twistRoot: 2 * DEG_TO_RAD,
  twistTip: -2 * DEG_TO_RAD,
  pivot: 0.25,
  hingeFrac: 0.72,
  /** Quarter-chord sweep, which sets the OUTBOARD leading edge. */
  qcSweep: 25 * DEG_TO_RAD,
  qcRootZ: 0.0,
};

/**
 * Wing planform. Two panels: inboard to the yehudi break, where the chord is
 * set by a nearly straight trailing edge, and outboard, where it is set by the
 * quarter-chord sweep. They are continuous at the break by construction.
 */
function wingPlanform(s) {
  let chord;
  let zLE;
  if (s <= WING.breakS) {
    const q = s / WING.breakS;
    chord = WING.rootChord + (WING.breakChord - WING.rootChord) * q;
    const te = WING.rootTEz + (WING.breakTEz - WING.rootTEz) * q;
    zLE = te - chord;
  } else {
    const q = (s - WING.breakS) / (WING.semiSpan - WING.breakS);
    chord = WING.breakChord + (WING.tipChord - WING.breakChord) * q;
    zLE = WING.qcRootZ + s * Math.tan(WING.qcSweep) - 0.25 * chord;
  }
  let thick = 1;
  const tipStart = WING.semiSpan - 0.9;
  if (s > tipStart) {
    // Rounded tip, so the planform closes instead of ending in a slab. The
    // winglet is a separate surface bolted to the end of it.
    const u = clamp((s - tipStart) / (WING.semiSpan - tipStart), 0, 1);
    const r = Math.sqrt(Math.max(0, 1 - u * u));
    thick = r;
    const mid = zLE + chord * 0.5;
    chord *= 0.72 + 0.28 * r;
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

function wingPoint(s, f, out) {
  const pl = wingPlanform(s);
  out.set(s, pl.y, pl.zLE + pl.chord * f);
  return out;
}

function wingFracAtZ(s, z) {
  const pl = wingPlanform(s);
  return clamp((z - pl.zLE) / pl.chord, 0.05, 0.95);
}

const HSTAB = {
  semiSpan: 7.18,
  rootChord: 3.4,
  tipChord: 1.25,
  rootLEz: 14.0,
  rootY: 0.35,
  sweep: 28 * DEG_TO_RAD,
  dihedral: 7 * DEG_TO_RAD,
  pivot: 0.25,
  hingeFrac: 0.7,
};

function hstabPlanform(s) {
  const q = s / HSTAB.semiSpan;
  let chord = HSTAB.rootChord + (HSTAB.tipChord - HSTAB.rootChord) * q;
  let zLE = HSTAB.rootLEz + s * Math.tan(HSTAB.sweep);
  let thick = 1;
  const tipStart = HSTAB.semiSpan - 0.45;
  if (s > tipStart) {
    const u = clamp((s - tipStart) / (HSTAB.semiSpan - tipStart), 0, 1);
    const r = Math.sqrt(Math.max(0, 1 - u * u));
    thick = r;
    const mid = zLE + chord * 0.5;
    chord *= 0.72 + 0.28 * r;
    zLE = mid - chord * 0.5;
  }
  return {
    chord,
    zLE,
    y: HSTAB.rootY + Math.tan(HSTAB.dihedral) * s,
    twist: 0,
    thick,
  };
}

function hstabFracAtZ(s, z) {
  const pl = hstabPlanform(s);
  return clamp((z - pl.zLE) / pl.chord, 0.05, 0.95);
}

const FIN = {
  /** Height above the fin root, m. Root sits on the tail crown. */
  height: 7.9,
  rootChord: 5.9,
  tipChord: 2.4,
  rootLEz: 11.6,
  rootY: 1.75,
  sweep: 35 * DEG_TO_RAD,
  pivot: 0.25,
  hingeFrac: 0.68,
};

function finPlanform(s) {
  const q = s / FIN.height;
  let chord = FIN.rootChord + (FIN.tipChord - FIN.rootChord) * q;
  let zLE = FIN.rootLEz + s * Math.tan(FIN.sweep);
  let thick = 1;
  const tipStart = FIN.height - 0.5;
  if (s > tipStart) {
    const u = clamp((s - tipStart) / (FIN.height - tipStart), 0, 1);
    const r = Math.sqrt(Math.max(0, 1 - u * u));
    thick = r;
    const mid = zLE + chord * 0.5;
    chord *= 0.75 + 0.25 * r;
    zLE = mid - chord * 0.5;
  }
  // Lofted flat with the span running along +X, then stood upright by the
  // caller. `y` is therefore 0 here and the fin's height above the fuselage is
  // the GROUP's position, not part of the planform — putting rootY in here
  // instead shifts the fin sideways once the group is rotated, which is a
  // surprisingly hard thing to see and an easy one to measure.
  return { chord, zLE, y: 0, twist: 0, thick };
}

function finFracAtZ(s, z) {
  const pl = finPlanform(s);
  return clamp((z - pl.zLE) / pl.chord, 0.05, 0.95);
}

/** Winglet: canted, tapered, 2.4 m of it. */
const WINGLET = { height: 2.4, rootChord: 1.25, tipChord: 0.55, cant: 20 * DEG_TO_RAD, sweep: 38 * DEG_TO_RAD };

function wingletPlanform(s) {
  const q = s / WINGLET.height;
  let chord = WINGLET.rootChord + (WINGLET.tipChord - WINGLET.rootChord) * q;
  const zLE = s * Math.tan(WINGLET.sweep);
  let thick = 1;
  if (q > 0.85) thick = Math.sqrt(Math.max(0, 1 - ((q - 0.85) / 0.15) ** 2));
  return { chord, zLE, y: 0, twist: 0, thick };
}

/** Engine nacelle stations: [z, radius]. Front lip to exhaust. */
const NACELLE = [
  [-2.20, 0.86],
  [-2.05, 1.03],
  [-1.70, 1.13],
  [-1.10, 1.18],
  [-0.20, 1.19],
  [0.70, 1.14],
  [1.40, 1.03],
  [1.90, 0.88],
  [2.40, 0.74],
];
/**
 * Engine centreline: 5.0 m out, and 1.47 m below the fuselage datum.
 *
 * ENGINE_Y is not a styling choice — it is solved backwards from the ground.
 * The nacelle's flattened bottom sits 0.976 m below its axis, and the wheels
 * are at -2.90, so this places the nacelle 0.45 m off the runway: the real
 * 737 figure, and the reason the inlet is the shape it is.
 */
const ENGINE_X = 5.0;
const ENGINE_Y = -1.47;

// ===========================================================================
// 2. Textures — an airline livery, drawn not downloaded
// ===========================================================================

/**
 * Fuselage skin. White crown, a swept cheatline, a grey belly, and a window
 * ribbon at the real window line.
 *
 * The belly is grey rather than white for the same reason real ones are: it is
 * where the exhaust streaks land, and a uniformly white underside reads as
 * untextured plastic from the chase camera.
 */
function makeFuselageTexture(zMin, zMax, windows, reg) {
  const W = texSize(2048);
  const H = texSize(1024);
  const { canvas, ctx } = makeSkinCanvas(W, H);
  const { canvas: hCanvas, ctx: hx } = makeCanvas(W, H);
  hx.fillStyle = '#808080';
  hx.fillRect(0, 0, W, H);

  const zToU = (z) => ((z - zMin) / (zMax - zMin)) * W;

  // v = 0 is the crown, v = 1 the keel (buildFuselage lays the rings out that
  // way), so the paint scheme is a set of horizontal bands.
  const g = ctx.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0.0, '#f4f6f8');
  g.addColorStop(0.46, '#eef1f4');
  g.addColorStop(0.62, '#e3e7ea');
  g.addColorStop(0.74, '#9aa3ab');
  g.addColorStop(1.0, '#6f777e');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);

  // Cheatline: a dark blue band along the window line, sweeping up over the
  // tail the way most narrowbody schemes do.
  const winV = 0.545;
  ctx.beginPath();
  for (let i = 0; i <= 64; i++) {
    const t = i / 64;
    const z = zMin + (zMax - zMin) * t;
    const rise = z > 11 ? ((z - 11) / (zMax - 11)) ** 1.6 * 0.34 : 0;
    ctx.lineTo(zToU(z), (winV + 0.055 - rise) * H);
  }
  for (let i = 64; i >= 0; i--) {
    const t = i / 64;
    const z = zMin + (zMax - zMin) * t;
    const rise = z > 11 ? ((z - 11) / (zMax - 11)) ** 1.6 * 0.34 : 0;
    ctx.lineTo(zToU(z), (winV + 0.115 - rise) * H);
  }
  ctx.closePath();
  ctx.fillStyle = '#1d3f75';
  ctx.fill();

  // Windows.
  const wH = 0.030 * H;
  for (const w of windows) {
    const u0 = zToU(w.z0);
    const u1 = zToU(w.z1);
    const pitch = (0.53 / (zMax - zMin)) * W; // 53 cm window pitch, the real one
    for (let u = u0; u < u1; u += pitch) {
      ctx.fillStyle = '#10161d';
      ctx.beginPath();
      ctx.roundRect(u, winV * H - wH * 0.5, pitch * 0.42, wH, wH * 0.35);
      ctx.fill();
      hx.fillStyle = '#5a5a5a';
      hx.beginPath();
      hx.roundRect(u, winV * H - wH * 0.5, pitch * 0.42, wH, wH * 0.35);
      hx.fill();
    }
  }

  // Flight-deck glazing: a dark wrap over the nose, above the cheatline.
  const fdU0 = zToU(-18.6);
  const fdU1 = zToU(-16.2);
  ctx.fillStyle = '#141a21';
  ctx.beginPath();
  ctx.roundRect(fdU0, 0.40 * H, fdU1 - fdU0, 0.105 * H, 0.02 * H);
  ctx.fill();

  // Doors — four of them, at the real stations.
  for (const [z0, z1] of [[-15.0, -13.2], [-4.6, -3.0], [3.2, 4.8], [12.0, 13.6]]) {
    const u0 = zToU(z0);
    const u1 = zToU(z1);
    ctx.strokeStyle = 'rgba(60,70,80,0.55)';
    ctx.lineWidth = Math.max(1, W / 1400);
    ctx.beginPath();
    ctx.roundRect(u0, 0.40 * H, u1 - u0, 0.20 * H, 0.012 * H);
    ctx.stroke();
    hx.strokeStyle = '#6e6e6e';
    hx.lineWidth = ctx.lineWidth * 2;
    hx.beginPath();
    hx.roundRect(u0, 0.40 * H, u1 - u0, 0.20 * H, 0.012 * H);
    hx.stroke();
  }

  // Frame stations and rivet rows.
  hx.globalAlpha = 0.55;
  for (let z = zMin + 2; z < zMax - 1.5; z += 1.02) {
    const u = zToU(z);
    hx.strokeStyle = '#6a6a6a';
    hx.lineWidth = Math.max(1, W / 2048);
    hx.beginPath();
    hx.moveTo(u, 0);
    hx.lineTo(u, H);
    hx.stroke();
  }
  hx.globalAlpha = 1;
  for (const v of [0.30, 0.44, 0.68, 0.82]) {
    drawRivets(hx, zToU(zMin + 1.5), v * H, zToU(zMax - 1.5), v * H, '#9a9a9a',
      Math.max(3, W / 300), Math.max(1, W / 1600));
  }

  // Registration, on the aft fuselage.
  ctx.fillStyle = '#22303f';
  ctx.font = `600 ${Math.round(0.055 * H)}px ui-sans-serif, system-ui, sans-serif`;
  ctx.textBaseline = 'middle';
  ctx.fillText(reg, zToU(14.0), 0.72 * H);

  return { map: canvas, height: hCanvas };
}

/** Wing and tail skin: spanwise panel lines, rivet rows, a leading-edge flash. */
function makeWingTexture() {
  const W = texSize(1024);
  const H = texSize(512);
  const { canvas, ctx } = makeSkinCanvas(W, H);
  const { canvas: hCanvas, ctx: hx } = makeCanvas(W, H);
  hx.fillStyle = '#808080';
  hx.fillRect(0, 0, W, H);

  ctx.fillStyle = '#e9edf1';
  ctx.fillRect(0, 0, W, H);
  // Leading-edge de-ice panels read as bare metal on most schemes.
  const lg = ctx.createLinearGradient(0, 0, W * 0.14, 0);
  lg.addColorStop(0, '#b9c0c6');
  lg.addColorStop(1, '#e9edf1');
  ctx.fillStyle = lg;
  ctx.fillRect(0, 0, W * 0.14, H);

  hx.globalAlpha = 0.5;
  for (let i = 1; i < 22; i++) {
    const y = (i / 22) * H;
    hx.strokeStyle = '#6d6d6d';
    hx.lineWidth = Math.max(1, W / 1024);
    hx.beginPath();
    hx.moveTo(0, y);
    hx.lineTo(W, y);
    hx.stroke();
  }
  hx.globalAlpha = 1;
  for (let i = 1; i < 22; i++) {
    const y = (i / 22) * H;
    drawRivets(hx, W * 0.02, y, W * 0.98, y, '#9c9c9c', Math.max(3, W / 220), Math.max(1, W / 900));
  }
  return { map: canvas, height: hCanvas };
}

/** Fan-blur disc: dense at the tip, transparent at the spinner. */
function makeFanDiscTexture() {
  const S = texSize(256);
  const { canvas, ctx } = makeCanvas(S, S);
  ctx.clearRect(0, 0, S, S);
  const c = S / 2;
  const g = ctx.createRadialGradient(c, c, S * 0.06, c, c, c);
  g.addColorStop(0.0, 'rgba(30,34,38,0.86)');
  g.addColorStop(0.18, 'rgba(46,52,58,0.34)');
  g.addColorStop(0.72, 'rgba(70,78,86,0.24)');
  g.addColorStop(0.95, 'rgba(120,130,140,0.44)');
  g.addColorStop(1.0, 'rgba(120,130,140,0)');
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(c, c, c, 0, TAU);
  ctx.fill();
  // A faint spiral so the disc reads as turning rather than as a decal.
  ctx.strokeStyle = 'rgba(200,210,220,0.16)';
  ctx.lineWidth = Math.max(1, S / 190);
  for (let k = 0; k < 6; k++) {
    ctx.beginPath();
    for (let i = 0; i <= 40; i++) {
      const t = i / 40;
      const a = k * (TAU / 6) + t * 1.5;
      const r = S * 0.09 + t * S * 0.40;
      const x = c + Math.cos(a) * r;
      const y = c + Math.sin(a) * r;
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }
  return canvas;
}

// ===========================================================================
// 3. createB738
// ===========================================================================

/**
 * @param {THREE.Scene} scene
 * @param {{renderer?: THREE.WebGLRenderer, registration?: string}} [opts]
 * @returns {{group: THREE.Group,
 *            setControlSurfaces: (c: {pitch?: number, roll?: number, yaw?: number, flaps?: number}) => void,
 *            spinProp: (n1Pct: number, dt: number) => void,
 *            dispose: () => void}}
 */
export function createB738(scene, opts = {}) {
  const group = new THREE.Group();
  group.name = 'aircraft';

  const disposables = [];
  const track = (x) => {
    disposables.push(x);
    return x;
  };

  // ---- environment -------------------------------------------------------
  let envMap = null;
  if (opts.renderer) {
    try {
      envMap = makeEnvironment(opts.renderer);
      disposables.push(envMap);
    } catch (err) {
      console.warn('[b738] prefiltered environment unavailable:', err && err.message);
      envMap = null;
    }
  }
  if (!envMap) {
    try {
      envMap = makeSkyEnvTexture();
      disposables.push(envMap);
    } catch (err) {
      console.warn('[b738] environment map unavailable:', err && err.message);
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
      const f = makeFuselageTexture(
        FUSELAGE[0][0], FUSELAGE[FUSELAGE.length - 1][0],
        WINDOWS, opts.registration || 'N738KA',
      );
      fuseMap = track(new THREE.CanvasTexture(f.map));
      fuseMap.colorSpace = THREE.SRGBColorSpace;
      fuseMap.anisotropy = 8;
      fuseNormal = track(normalFromHeight(f.height, 2.6, 2048));

      const w = makeWingTexture();
      wingMap = track(new THREE.CanvasTexture(w.map));
      wingMap.colorSpace = THREE.SRGBColorSpace;
      wingMap.anisotropy = 8;
      wingNormal = track(normalFromHeight(w.height, 2.0, 1024));

      discMap = track(new THREE.CanvasTexture(makeFanDiscTexture()));
      discMap.colorSpace = THREE.SRGBColorSpace;
    } catch (err) {
      console.warn('[b738] procedural textures unavailable:', err && err.message);
    }
  }

  // ---- materials ---------------------------------------------------------
  const paint = track(new THREE.MeshPhysicalMaterial({
    color: 0xffffff,
    map: fuseMap,
    normalMap: fuseNormal,
    normalScale: fuseNormal ? new THREE.Vector2(0.7, 0.7) : undefined,
    roughness: 0.31,
    metalness: 0.16,
    clearcoat: 0.55,
    clearcoatRoughness: 0.24,
    envMap,
    envMapIntensity: 0.85,
  }));
  const paintWing = track(new THREE.MeshPhysicalMaterial({
    color: 0xffffff,
    map: wingMap,
    normalMap: wingNormal,
    normalScale: wingNormal ? new THREE.Vector2(0.55, 0.55) : undefined,
    roughness: 0.35,
    metalness: 0.20,
    clearcoat: 0.40,
    clearcoatRoughness: 0.28,
    envMap,
    envMapIntensity: 0.8,
  }));
  const paintBlue = track(new THREE.MeshPhysicalMaterial({
    color: 0x1d3f75,
    roughness: 0.30,
    metalness: 0.18,
    clearcoat: 0.5,
    envMap,
    envMapIntensity: 0.85,
  }));
  const metal = track(new THREE.MeshStandardMaterial({
    color: 0xb9c0c6, roughness: 0.34, metalness: 0.92, envMap, envMapIntensity: 1.0,
  }));
  const darkMetal = track(new THREE.MeshStandardMaterial({
    color: 0x3a4048, roughness: 0.45, metalness: 0.8, envMap, envMapIntensity: 0.7,
  }));
  const rubber = track(new THREE.MeshStandardMaterial({
    color: 0x14161a, roughness: 0.92, metalness: 0.0, envMap, envMapIntensity: 0.25,
  }));
  const discMat = track(new THREE.MeshBasicMaterial({
    map: discMap, transparent: true, opacity: 0, depthWrite: false,
    side: THREE.DoubleSide, toneMapped: false,
  }));

  const meshes = [];
  const add = (geo, mat, parent = group) => {
    const m = new THREE.Mesh(track(geo), mat);
    m.castShadow = true;
    m.receiveShadow = true;
    parent.add(m);
    meshes.push(m);
    return m;
  };

  // ---- fuselage ----------------------------------------------------------
  const ringZ = [];
  for (let i = 0; i < FUSELAGE.length - 1; i++) {
    const a = FUSELAGE[i][0];
    const b = FUSELAGE[i + 1][0];
    const n = Math.max(1, Math.round((b - a) / 1.1));
    for (let k = 0; k < n; k++) ringZ.push(a + ((b - a) * k) / n);
  }
  ringZ.push(FUSELAGE[FUSELAGE.length - 1][0]);
  // buildFuselage returns { shell, glass, sampler } — the window apertures are
  // cut from the shell and handed back as a separate glazing surface.
  const fuse = buildFuselage(FUSELAGE, ringZ, 32, WINDOWS);
  add(fuse.shell, paint).name = 'fuselage';

  // Cabin lining, so the windows look into an interior rather than straight
  // out through the far side of the aeroplane. Lofted slightly inside the hull
  // at a coarser ring spacing, with the apertures grown so no sliver of lining
  // pokes through a window edge — same trick, and same reason, as the Cessna's.
  const LINING_MARGIN_Z = 0.14;
  const LINING_MARGIN_U = 0.03;
  const liningWindows = WINDOWS.map((w) => ({
    z0: w.z0 - LINING_MARGIN_Z,
    z1: w.z1 + LINING_MARGIN_Z,
    u0: w.u0 - LINING_MARGIN_U,
    u1: w.u1 + LINING_MARGIN_U,
  }));
  const liningTable = FUSELAGE.map(([z, hw, hh, cy, e]) => [z, hw * 0.965, hh * 0.965, cy, e]);
  const liningZ = ringZ.filter((_, i) => i % 2 === 0);
  const lining = buildFuselage(liningTable, liningZ, 24, liningWindows);
  add(lining.shell, track(new THREE.MeshStandardMaterial({
    color: 0x3c4046, roughness: 0.9, metalness: 0.0, side: THREE.BackSide,
    envMap, envMapIntensity: 0.15,
  })));
  if (lining.glass) lining.glass.dispose();

  if (fuse.glass) {
    const glass = new THREE.Mesh(track(fuse.glass), track(new THREE.MeshPhysicalMaterial({
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
    })));
    glass.renderOrder = 2;
    glass.name = 'glazing';
    group.add(glass);
  }

  // ---- wing --------------------------------------------------------------
  const wingRoot = new THREE.Group();
  wingRoot.name = 'wing';
  group.add(wingRoot);

  // Inboard and outboard flaps, then the aileron outboard of those. The gap
  // between the flap groups is where the engine pylon passes through.
  const FLAP_SPAN = [2.1, 12.4];
  const AIL_SPAN = [13.0, 16.3];
  const FLAP_HINGE_Z = wingPoint(7.0, WING.hingeFrac, new THREE.Vector3()).z;
  const AIL_HINGE_Z = wingPoint(14.6, WING.hingeFrac, new THREE.Vector3()).z;

  const wingPanels = [
    { a: 0.0, b: FLAP_SPAN[0], end: 1.0, steps: 3 },
    { a: FLAP_SPAN[0], b: FLAP_SPAN[1], end: (s) => wingFracAtZ(s, FLAP_HINGE_Z), steps: 10 },
    { a: FLAP_SPAN[1], b: AIL_SPAN[0], end: 1.0, steps: 2 },
    { a: AIL_SPAN[0], b: AIL_SPAN[1], end: (s) => wingFracAtZ(s, AIL_HINGE_Z), steps: 6 },
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
        capStart: p.a > 0.001,
        capEnd: true,
        mirror: side,
      }), paintWing, wingRoot);
    }
  }

  // Winglets. Built as a small lifting surface in the X-Z plane then rotated
  // up and canted out, which is why the planform reports y = 0 — the cant is a
  // transform, not a shape.
  for (const side of [false, true]) {
    const tip = wingPlanform(WING.semiSpan - 0.02);
    const wl = new THREE.Group();
    wl.position.set((side ? -1 : 1) * (WING.semiSpan - 0.05), tip.y, tip.zLE + tip.chord * 0.25);
    wl.rotation.z = (side ? -1 : 1) * (Math.PI / 2 - WINGLET.cant);
    wingRoot.add(wl);
    add(buildLiftingSurface({
      planform: wingletPlanform,
      airfoil: AF_TAIL,
      spanStart: 0,
      spanEnd: WINGLET.height,
      spanSteps: 6,
      chordStart: 0,
      chordEnd: 1,
      pivotFrac: 0.25,
      profileSteps: 16,
      capStart: true,
      capEnd: true,
      mirror: false,
    }), paintBlue, wl);
  }

  // Wing-root fairing: the belly-to-wing fillet. A 737's is large and obvious,
  // and without it the wing appears to slice into the fuselage.
  const fairing = new THREE.Mesh(track(new THREE.SphereGeometry(1, 26, 16)), paint);
  fairing.position.set(0, -1.45, 1.9);
  fairing.scale.set(2.35, 0.95, 5.6);
  fairing.castShadow = true;
  fairing.receiveShadow = true;
  group.add(fairing);
  meshes.push(fairing);

  // ---- flaps and ailerons ------------------------------------------------
  /** Build a hinged surface: geometry is generated about the hinge line. */
  function hingedPanel(o) {
    const pivot = new THREE.Group();
    pivot.userData.animated = true; // keep bakeStatic away from it
    pivot.position.copy(o.origin);
    o.parent.add(pivot);
    add(buildLiftingSurface({
      planform: o.planform,
      airfoil: o.airfoil,
      spanStart: o.a,
      spanEnd: o.b,
      spanSteps: o.steps,
      chordStart: o.start,
      chordEnd: 1.0,
      pivotFrac: o.pivotFrac,
      profileSteps: 14,
      capStart: true,
      capEnd: true,
      mirror: o.mirror,
      offset: o.origin,
    }), o.material, pivot);
    return { pivot, axis: o.axis.clone() };
  }

  const flapOrigin = (mirror) =>
    new THREE.Vector3(0, wingPlanform((FLAP_SPAN[0] + FLAP_SPAN[1]) / 2).y, FLAP_HINGE_Z);
  const flapL = hingedPanel({
    parent: wingRoot, planform: wingPlanform, airfoil: AF_WING,
    a: FLAP_SPAN[0], b: FLAP_SPAN[1], steps: 10,
    start: (s) => wingFracAtZ(s, FLAP_HINGE_Z), pivotFrac: WING.pivot,
    origin: flapOrigin(true), axis: new THREE.Vector3(1, 0, 0), mirror: true,
    material: paintWing,
  });
  const flapR = hingedPanel({
    parent: wingRoot, planform: wingPlanform, airfoil: AF_WING,
    a: FLAP_SPAN[0], b: FLAP_SPAN[1], steps: 10,
    start: (s) => wingFracAtZ(s, FLAP_HINGE_Z), pivotFrac: WING.pivot,
    origin: flapOrigin(false), axis: new THREE.Vector3(1, 0, 0), mirror: false,
    material: paintWing,
  });

  const ailOrigin = new THREE.Vector3(0, wingPlanform((AIL_SPAN[0] + AIL_SPAN[1]) / 2).y, AIL_HINGE_Z);
  const ailL = hingedPanel({
    parent: wingRoot, planform: wingPlanform, airfoil: AF_WING,
    a: AIL_SPAN[0], b: AIL_SPAN[1], steps: 6,
    start: (s) => wingFracAtZ(s, AIL_HINGE_Z), pivotFrac: WING.pivot,
    origin: ailOrigin, axis: new THREE.Vector3(1, 0, 0), mirror: true,
    material: paintWing,
  });
  const ailR = hingedPanel({
    parent: wingRoot, planform: wingPlanform, airfoil: AF_WING,
    a: AIL_SPAN[0], b: AIL_SPAN[1], steps: 6,
    start: (s) => wingFracAtZ(s, AIL_HINGE_Z), pivotFrac: WING.pivot,
    origin: ailOrigin, axis: new THREE.Vector3(1, 0, 0), mirror: false,
    material: paintWing,
  });

  // ---- horizontal tail ---------------------------------------------------
  const tailRoot = new THREE.Group();
  tailRoot.name = 'hstab';
  group.add(tailRoot);
  const ELEV_HINGE_Z = (() => {
    const pl = hstabPlanform(3.5);
    return pl.zLE + pl.chord * HSTAB.hingeFrac;
  })();
  for (const side of [false, true]) {
    add(buildLiftingSurface({
      planform: hstabPlanform,
      airfoil: AF_TAIL,
      spanStart: 0,
      spanEnd: HSTAB.semiSpan,
      spanSteps: 8,
      chordStart: 0,
      chordEnd: (s) => hstabFracAtZ(s, ELEV_HINGE_Z),
      pivotFrac: HSTAB.pivot,
      profileSteps: 16,
      capStart: false,
      capEnd: true,
      mirror: side,
    }), paintWing, tailRoot);
  }
  const elevOrigin = new THREE.Vector3(0, hstabPlanform(3.5).y, ELEV_HINGE_Z);
  const elevL = hingedPanel({
    parent: tailRoot, planform: hstabPlanform, airfoil: AF_TAIL,
    a: 0.1, b: HSTAB.semiSpan, steps: 8,
    start: (s) => hstabFracAtZ(s, ELEV_HINGE_Z), pivotFrac: HSTAB.pivot,
    origin: elevOrigin, axis: new THREE.Vector3(1, 0, 0), mirror: true,
    material: paintWing,
  });
  const elevR = hingedPanel({
    parent: tailRoot, planform: hstabPlanform, airfoil: AF_TAIL,
    a: 0.1, b: HSTAB.semiSpan, steps: 8,
    start: (s) => hstabFracAtZ(s, ELEV_HINGE_Z), pivotFrac: HSTAB.pivot,
    origin: elevOrigin, axis: new THREE.Vector3(1, 0, 0), mirror: false,
    material: paintWing,
  });

  // ---- vertical tail -----------------------------------------------------
  // Lofted flat in X and rotated upright: buildLiftingSurface only knows how to
  // run a span along +X, so the fin is a wing standing on its root.
  const finRoot = new THREE.Group();
  finRoot.name = 'fin';
  // +90 deg about Z maps the surface's +X span onto +Y, i.e. upright. The
  // other sign builds the whole fin downwards through the runway.
  finRoot.rotation.z = Math.PI / 2;
  finRoot.position.y = FIN.rootY;
  group.add(finRoot);
  const RUD_HINGE_Z = (() => {
    const pl = finPlanform(FIN.height * 0.5);
    return pl.zLE + pl.chord * FIN.hingeFrac;
  })();
  add(buildLiftingSurface({
    planform: finPlanform,
    airfoil: AF_TAIL,
    spanStart: 0,
    spanEnd: FIN.height,
    spanSteps: 9,
    chordStart: 0,
    chordEnd: (s) => finFracAtZ(s, RUD_HINGE_Z),
    pivotFrac: FIN.pivot,
    profileSteps: 16,
    capStart: false,
    capEnd: true,
    mirror: false,
  }), paintBlue, finRoot);
  const rudderPivot = new THREE.Group();
  rudderPivot.userData.animated = true;
  rudderPivot.position.set(0, 0, RUD_HINGE_Z);
  finRoot.add(rudderPivot);
  add(buildLiftingSurface({
    planform: finPlanform,
    airfoil: AF_TAIL,
    spanStart: 0.05,
    spanEnd: FIN.height,
    spanSteps: 9,
    chordStart: (s) => finFracAtZ(s, RUD_HINGE_Z),
    chordEnd: 1.0,
    pivotFrac: FIN.pivot,
    profileSteps: 14,
    capStart: true,
    capEnd: true,
    mirror: false,
    offset: new THREE.Vector3(0, 0, RUD_HINGE_Z),
  }), paintBlue, rudderPivot);

  // Dorsal fin fillet — the fin root blending forward into the fuselage crown.
  const dorsal = new THREE.Mesh(track(new THREE.SphereGeometry(1, 18, 12)), paint);
  dorsal.position.set(0, 1.35, 11.9);
  dorsal.scale.set(0.22, 0.85, 2.6);
  dorsal.castShadow = true;
  group.add(dorsal);
  meshes.push(dorsal);

  // ---- engines -----------------------------------------------------------
  // THE FLAT-BOTTOMED NACELLE. A CFM56-7B on a 737 clears the ground by 0.46 m
  // and the accessory gearbox had to be moved onto the side of the fan case to
  // manage it — which is why the inlet is the famous non-circular "hamster
  // pouch" shape rather than a round one. Scaling the lower half of the
  // nacelle is a cheap way to say the same thing, and it is the silhouette
  // people recognise the type by.
  const nacelleGeo = () => {
    const pts = NACELLE.map(([z, r]) => new THREE.Vector2(r, z));
    const g = new THREE.LatheGeometry(pts, 24);
    g.rotateX(Math.PI / 2);
    // Flatten the bottom: pull vertices below the axis toward it.
    const pos = g.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      const y = pos.getY(i);
      if (y < 0) pos.setY(i, y * 0.82);
    }
    pos.needsUpdate = true;
    g.computeVertexNormals();
    return g;
  };

  const fans = [];
  for (const side of [-1, 1]) {
    const eng = new THREE.Group();
    const wingAt = wingPlanform(ENGINE_X);
    eng.position.set(side * ENGINE_X, ENGINE_Y, wingAt.zLE - 1.15);
    group.add(eng);

    add(nacelleGeo(), paint, eng).name = 'nacelle';

    // Inlet lip, in bare metal, and a dark inlet interior behind it.
    const lip = new THREE.Mesh(
      track(new THREE.TorusGeometry(0.9, 0.09, 8, 26)),
      metal,
    );
    lip.position.z = -2.18;
    eng.add(lip);
    meshes.push(lip);

    const inlet = new THREE.Mesh(
      track(new THREE.CircleGeometry(0.86, 24)),
      track(new THREE.MeshStandardMaterial({
      color: 0x14181d, roughness: 0.85, metalness: 0.3, envMap, envMapIntensity: 0.3,
    })),
    );
    inlet.position.z = -1.95;
    inlet.rotation.y = Math.PI;
    eng.add(inlet);
    meshes.push(inlet);

    // Fan: a spinner and a ring of blades, which cross-fade to a disc.
    const fanPivot = new THREE.Group();
    fanPivot.name = 'fan';
    fanPivot.userData.animated = true;
    fanPivot.position.z = -1.9;
    eng.add(fanPivot);
    const spinner = new THREE.Mesh(track(new THREE.ConeGeometry(0.17, 0.42, 14)), darkMetal);
    spinner.rotation.x = -Math.PI / 2;
    spinner.position.z = -0.2;
    fanPivot.add(spinner);
    meshes.push(spinner);

    const bladeGroup = new THREE.Group();
    fanPivot.add(bladeGroup);
    const bladeMat = track(new THREE.MeshStandardMaterial({
      color: 0x9aa2aa, roughness: 0.4, metalness: 0.9, envMap,
      transparent: true, opacity: 1, side: THREE.DoubleSide,
    }));
    const bladeGeo = track(new THREE.BoxGeometry(0.055, 0.60, 0.20));
    for (let b = 0; b < 24; b++) {
      const blade = new THREE.Mesh(bladeGeo, bladeMat);
      const a = (b / 24) * TAU;
      blade.position.set(Math.cos(a) * 0.50, Math.sin(a) * 0.50, 0);
      blade.rotation.z = a + Math.PI / 2;
      blade.rotation.y = 0.55;
      bladeGroup.add(blade);
      meshes.push(blade);
    }

    // The 24 blades turn together, so they are one rigid body and merge into a
    // single mesh. Baking the ring HERE, before the pivot is marked animated,
    // is the only place it can happen: the global bakeStatic stops at an
    // animated node and will not descend into it, which left 48 blade meshes
    // standing and the whole aeroplane at 69 draw calls instead of 21.
    bakeStatic(bladeGroup);

    const disc = new THREE.Mesh(track(new THREE.CircleGeometry(0.80, 28)), discMat);
    disc.name = 'fanDisc';
    disc.position.z = -0.02;
    disc.visible = false;
    fanPivot.add(disc);

    // Exhaust cone.
    const cone = new THREE.Mesh(track(new THREE.ConeGeometry(0.34, 1.0, 16)), darkMetal);
    cone.rotation.x = Math.PI / 2;
    cone.position.z = 2.55;
    eng.name = `engine${side > 0 ? 'R' : 'L'}`;
    eng.add(cone);
    meshes.push(cone);

    // Pylon, joining nacelle to wing.
    const pyTop = wingAt.y - 0.15;
    const pylon = new THREE.Mesh(track(new THREE.BoxGeometry(0.28, pyTop - ENGINE_Y + 0.5, 3.0)), paint);
    pylon.position.set(0, (pyTop - ENGINE_Y) / 2, 0.9);
    eng.add(pylon);
    meshes.push(pylon);

    fans.push({ pivot: fanPivot, bladeGroup, bladeMat, disc });
  }

  // ---- landing gear ------------------------------------------------------
  // The wheels must end at y = -2.90, which is b738.js's gearHeightM. Every
  // number in here is derived from that and from the gear table's contact
  // points: nose at z = -14.3, mains at x = +/-2.86, z = +1.3.
  const gearRoot = new THREE.Group();
  gearRoot.name = 'gear';
  group.add(gearRoot);

  const TYRE_R = 0.55;
  const wheel = (x, y, z, r, w) => {
    const t = new THREE.Mesh(track(new THREE.CylinderGeometry(r, r, w, 18)), rubber);
    t.rotation.z = Math.PI / 2;
    t.position.set(x, y, z);
    t.castShadow = true;
    gearRoot.add(t);
    meshes.push(t);
    const hub = new THREE.Mesh(track(new THREE.CylinderGeometry(r * 0.5, r * 0.5, w * 1.06, 12)), metal);
    hub.rotation.z = Math.PI / 2;
    hub.position.set(x, y, z);
    gearRoot.add(hub);
    meshes.push(hub);
  };
  const strut = (x, y0, y1, z, r) => {
    const s = new THREE.Mesh(track(new THREE.CylinderGeometry(r, r * 1.12, y1 - y0, 10)), metal);
    s.position.set(x, (y0 + y1) / 2, z);
    s.castShadow = true;
    gearRoot.add(s);
    meshes.push(s);
  };

  // Nose gear: two small wheels side by side.
  const NOSE_R = 0.39;
  strut(0, -2.9 + NOSE_R, -1.55, -14.3, 0.10);
  wheel(-0.19, -2.9 + NOSE_R, -14.3, NOSE_R, 0.22);
  wheel(0.19, -2.9 + NOSE_R, -14.3, NOSE_R, 0.22);

  // Mains: two wheels per leg, on a bogie-less strut, as a 737 has.
  for (const side of [-1, 1]) {
    strut(side * 2.86, -2.9 + TYRE_R, -1.05, 1.3, 0.15);
    wheel(side * 2.86 - 0.32, -2.9 + TYRE_R, 1.3, TYRE_R, 0.34);
    wheel(side * 2.86 + 0.32, -2.9 + TYRE_R, 1.3, TYRE_R, 0.34);
    // Wing-root gear fairing over the wheel well.
    const f = new THREE.Mesh(track(new THREE.SphereGeometry(1, 14, 10)), paint);
    f.position.set(side * 2.5, -1.75, 1.2);
    f.scale.set(0.62, 0.42, 1.5);
    gearRoot.add(f);
    meshes.push(f);
  }

  // ---- antennae and probes ----------------------------------------------
  for (const [z, h] of [[-9.5, 0.30], [-2.0, 0.26], [6.5, 0.28]]) {
    const a = new THREE.Mesh(track(new THREE.ConeGeometry(0.07, h, 6)), darkMetal);
    a.position.set(0, 1.88 + h / 2, z);
    group.add(a);
    meshes.push(a);
  }
  const pitot = new THREE.Mesh(track(new THREE.CylinderGeometry(0.025, 0.025, 0.42, 6)), metal);
  pitot.rotation.x = Math.PI / 2;
  pitot.position.set(1.25, -0.55, -17.4);
  group.add(pitot);
  meshes.push(pitot);

  // ---- static bake -------------------------------------------------------
  // Everything that never moves relative to the hull is merged, exactly as the
  // Cessna does it, so a 737 is not 110 draw calls.
  //
  // bakeStatic TAKES NO OPTIONS. Anything that must survive it marks itself
  // with `userData.animated = true` and is skipped along with its whole
  // subtree. An earlier version of this passed a `skip` callback listing every
  // pivot — which JavaScript accepted, the function ignored, and which then
  // quietly merged the fan discs and the spinners into the airframe. Nothing
  // threw; the fans simply stopped blurring, and the harness noticed before a
  // person would have.
  //
  // `noBake` exists for the measurement harness, which has to see individual
  // parts to check the engine clearance and the wheel datum. Nothing in the
  // application passes it.
  if (!opts.noBake) bakeStatic(group);

  scene.add(group);

  // ---- control-surface animation ----------------------------------------
  let sPitch = 0, sRoll = 0, sYaw = 0, sFlap = 0;
  let lastMs = typeof performance !== 'undefined' ? performance.now() : 0;

  const toward = (cur, target, maxDelta) => {
    const d = target - cur;
    if (d > maxDelta) return cur + maxDelta;
    if (d < -maxDelta) return cur - maxDelta;
    return target;
  };

  /**
   * @param {{pitch?:number, roll?:number, yaw?:number, flaps?:number}} c
   *        pitch/roll/yaw are -1..+1, flaps 0..1.
   */
  function setControlSurfaces(c = {}) {
    const nowMs = typeof performance !== 'undefined' ? performance.now() : lastMs + 16.7;
    const dt = clamp((nowMs - lastMs) / 1000, 0, 0.25);
    lastMs = nowMs;

    sPitch = toward(sPitch, clamp(c.pitch ?? 0, -1, 1), SURFACE_RATE * dt);
    sRoll = toward(sRoll, clamp(c.roll ?? 0, -1, 1), SURFACE_RATE * dt);
    sYaw = toward(sYaw, clamp(c.yaw ?? 0, -1, 1), SURFACE_RATE * dt);
    sFlap = toward(sFlap, clamp(c.flaps ?? 0, 0, 1), FLAP_RATE * dt);

    // Stick back (+pitch) = elevator TRAILING EDGE UP = nose up. The hinge axis
    // is +X, and rotating +X by a positive angle sends the trailing edge DOWN,
    // so pulling is a negative rotation.
    const e = -(sPitch >= 0 ? sPitch * ELEVATOR_UP : sPitch * ELEVATOR_DOWN);
    elevL.pivot.quaternion.setFromAxisAngle(elevL.axis, e);
    elevR.pivot.quaternion.setFromAxisAngle(elevR.axis, e);

    // Ailerons are DIFFERENTIAL: the up-going one travels further than the
    // down-going one, which is how a real aeroplane fights adverse yaw.
    const upA = (v) => v * AILERON_UP;
    const dnA = (v) => v * AILERON_DOWN;
    // Stick right (+roll) = right aileron up, left aileron down.
    const aR = sRoll >= 0 ? upA(sRoll) : dnA(sRoll);
    const aL = sRoll >= 0 ? -dnA(sRoll) : -upA(sRoll);
    ailR.pivot.quaternion.setFromAxisAngle(ailR.axis, aR);
    ailL.pivot.quaternion.setFromAxisAngle(ailL.axis, aL);

    // Right rudder (+yaw) swings the trailing edge to the right. The fin group
    // is rotated -90 deg about Z, so the hinge in fin-local space is +X still.
    rudderPivot.quaternion.setFromAxisAngle(new THREE.Vector3(1, 0, 0), sYaw * RUDDER_MAX);

    // Flaps only ever go down.
    const f = sFlap * FLAP_MAX;
    flapL.pivot.quaternion.setFromAxisAngle(flapL.axis, f);
    flapR.pivot.quaternion.setFromAxisAngle(flapR.axis, f);
  }

  let discSpin = 0;

  /**
   * Turn the fans and cross-fade them to a blur disc.
   *
   * TAKES N1 PERCENT, NOT RPM — the one place this module's interface differs
   * from the Cessna's, and it differs because the aeroplane does. A CFM56 fan
   * turns at about 5,200 rpm at 100% N1, so even at ground idle it is far past
   * the speed at which a 60 Hz frame can sample 24 blades without strobing.
   * There is no "solid blades" regime the way a propeller has one; by 35% N1
   * you are looking at a disc, because in life you are.
   *
   * `state.engineGauge` tells the caller which number to pass. Passing rpm here
   * would leave the fans stationary, since a turbofan publishes rpm = 0.
   *
   * @param {number} n1Pct Fan speed, PERCENT of redline.
   * @param {number} dt    Frame delta in SECONDS.
   */
  function spinProp(n1Pct, dt) {
    if (!Number.isFinite(n1Pct) || !Number.isFinite(dt)) return;
    const n1 = n1Pct > 0 ? n1Pct : 0;
    const d = dt > 0.25 ? 0.25 : dt;
    const rps = (n1 / 100) * 86; // 5,160 rpm at 100% N1

    const t = clamp((n1 - BLUR_START) / (BLUR_FULL - BLUR_START), 0, 1);
    discSpin = ((discSpin + rps * TAU * d * 0.04) % TAU + TAU) % TAU;

    for (const f of fans) {
      // Modulo rather than a bare += : at 5,000 rpm a 0.25 s frame is 21
      // revolutions, and one wrap leaves the angle far from where it belongs.
      f.pivot.rotation.z = ((f.pivot.rotation.z - rps * TAU * d) % TAU + TAU) % TAU;
      f.bladeGroup.visible = t < 0.995;
      f.disc.visible = t > 0.002;
      f.disc.rotation.z = discSpin;
    }
    // Both fans share one blade material and one disc material, so the fade is
    // written once rather than per engine.
    if (fans.length) {
      fans[0].bladeMat.opacity = 1 - 0.92 * t;
      discMat.opacity = t * 0.9;
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

export default createB738;
