/**
 * lofting.js — the procedural-geometry toolkit that both aeroplanes are built
 * from. Pure functions and generic helpers; no aircraft in here.
 *
 * This module answers, for the geometry, the question step 1 asked of the
 * physics. flightModel.js owns the physics and an airframe file owns the
 * aeroplane; likewise lofting.js owns HOW to loft a wing and model.js /
 * b738model.js own WHICH wing. Everything below was extracted verbatim from
 * aircraft/model.js when a second aircraft needed it — a NACA section
 * generator, a monotone spline, a lofted lifting surface, a swept fuselage, a
 * canvas-to-normal-map converter, a tiny procedural sky for reflections — none
 * of which has anything to do with being a Cessna.
 *
 * The extraction was mechanical and behaviour-preserving: the function bodies
 * are unchanged. check-aircraft.mjs measures the Cessna off its actual vertices
 * rather than trusting the source, and still reports every published dimension
 * to the millimetre, which is what makes that claim checkable.
 *
 * BODY AXES, shared by every consumer:
 *   -Z = nose / forward       +Z = tail
 *   +X = right wing           -X = left wing
 *   +Y = up (canopy)          -Y = landing gear
 */

import * as THREE from 'three';
import { clamp } from '../core/units.js';

export const TAU = Math.PI * 2;

// ===========================================================================
// 1. Curve and profile maths
// ===========================================================================

/**
 * Monotone cubic (Fritsch-Carlson) interpolant through (xs, ys).
 *
 * Used for the fuselage station table. A plain Catmull-Rom overshoots between
 * unevenly-spaced control stations, which on a fuselage means a half-width
 * that bulges — or goes negative — between the firewall and the cowl. The
 * monotone form cannot overshoot, so the loft is guaranteed well-formed no
 * matter how the station table is edited later.
 *
 * @param {number[]} xs strictly increasing
 * @param {number[]} ys
 * @returns {(x: number) => number}
 */
export function monotoneSpline(xs, ys) {
  const n = xs.length;
  const h = new Array(n - 1);
  const d = new Array(n - 1);
  for (let i = 0; i < n - 1; i++) {
    h[i] = xs[i + 1] - xs[i];
    d[i] = (ys[i + 1] - ys[i]) / h[i];
  }
  const m = new Array(n);
  m[0] = d[0];
  m[n - 1] = d[n - 2];
  for (let i = 1; i < n - 1; i++) {
    if (d[i - 1] * d[i] <= 0) {
      m[i] = 0;
    } else {
      const w1 = 2 * h[i] + h[i - 1];
      const w2 = h[i] + 2 * h[i - 1];
      m[i] = (w1 + w2) / (w1 / d[i - 1] + w2 / d[i]);
    }
  }
  return function evaluate(x) {
    if (x <= xs[0]) return ys[0];
    if (x >= xs[n - 1]) return ys[n - 1];
    let lo = 0;
    let hi = n - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (xs[mid] > x) hi = mid;
      else lo = mid;
    }
    const t = (x - xs[lo]) / h[lo];
    const t2 = t * t;
    const t3 = t2 * t;
    return (
      ys[lo] * (2 * t3 - 3 * t2 + 1) +
      m[lo] * h[lo] * (t3 - 2 * t2 + t) +
      ys[lo + 1] * (-2 * t3 + 3 * t2) +
      m[lo + 1] * h[lo] * (t3 - t2)
    );
  };
}

/** Signed power, for superellipse cross-sections. */
export function spow(v, e) {
  return v < 0 ? -Math.pow(-v, e) : Math.pow(v, e);
}

/**
 * NACA 4-digit half-thickness distribution.
 * Last coefficient is -0.1036 rather than -0.1015 so the trailing edge closes.
 */
export function nacaThickness(t, x) {
  return (
    5 *
    t *
    (0.2969 * Math.sqrt(x) -
      0.126 * x -
      0.3516 * x * x +
      0.2843 * x * x * x -
      0.1036 * x * x * x * x)
  );
}

/** NACA 4-digit mean camber line and its slope. */
export function nacaCamber(m, p, x) {
  if (m === 0 || p === 0) return { y: 0, dy: 0 };
  if (x < p) {
    return { y: (m / (p * p)) * (2 * p * x - x * x), dy: ((2 * m) / (p * p)) * (p - x) };
  }
  const q = 1 - p;
  return {
    y: (m / (q * q)) * (1 - 2 * p + 2 * p * x - x * x),
    dy: ((2 * m) / (q * q)) * (p - x),
  };
}

/**
 * Upper and lower surface points of a NACA 4-digit section at chord fraction x.
 * Returns chord-normalised coordinates; multiply by the local chord.
 */
export function airfoilAt(af, x) {
  const xc = x < 0 ? 0 : x > 1 ? 1 : x;
  const yt = nacaThickness(af.t, xc);
  const c = nacaCamber(af.m, af.p, xc);
  const th = Math.atan(c.dy);
  const s = Math.sin(th);
  const co = Math.cos(th);
  return {
    ux: xc - yt * s,
    uy: c.y + yt * co,
    lx: xc + yt * s,
    ly: c.y - yt * co,
  };
}

/**
 * Closed section outline for the chord range [c0, c1], as [chordFrac, thickFrac]
 * pairs ordered upper-front -> upper-back -> lower-back -> lower-front.
 *
 * Sampling is cosine-clustered toward the leading edge when c0 === 0, which is
 * where all the curvature lives; a linear sample there facets the nose.
 * `roundLE` closes a control surface with a semicircular nose instead of the
 * flat cut you get from truncating the section.
 */
export function sectionOutline(af, c0, c1, steps, roundLE) {
  const up = [];
  const lo = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const f = c0 === 0 ? 1 - Math.cos((t * Math.PI) / 2) : t;
    const s = airfoilAt(af, c0 + (c1 - c0) * f);
    up.push([s.ux, s.uy]);
    lo.push([s.lx, s.ly]);
  }
  const loop = [];
  for (let i = 0; i <= steps; i++) loop.push(up[i]);
  // c1 < 1 leaves an open cut; the implicit closing edge of the loop is that
  // cut face, which is exactly the flap/aileron well on the real wing.
  for (let i = steps; i >= (c0 === 0 ? 1 : 0); i--) loop.push(lo[i]);
  if (roundLE && c0 > 0) {
    const cx = (up[0][0] + lo[0][0]) * 0.5;
    const cy = (up[0][1] + lo[0][1]) * 0.5;
    const r = (up[0][1] - lo[0][1]) * 0.5;
    for (let k = 1; k <= 4; k++) {
      const phi = Math.PI * (1 - k / 5);
      loop.push([cx - 0.9 * r * Math.sin(phi), cy + r * Math.cos(phi)]);
    }
  }
  return loop;
}

// ===========================================================================
// 2. Geometry builders
// ===========================================================================

/**
 * Loft a lifting surface (wing panel, stabiliser, fin, control surface).
 *
 * Canonical frame: span along +X, chord along +Z (aft positive), thickness
 * along +Y. Mirror or rotate the result to place it.
 *
 * `chordStart`/`chordEnd` may be functions of the span station, which is how a
 * control surface gets a *straight* hinge line on a tapered wing: hold the
 * hinge at a fixed Z and let the chord fraction vary with the local chord.
 * A hinge that is not straight cannot be animated by one rotation.
 *
 * @param {object} o
 * @param {(s:number)=>{chord:number, zLE:number, y:number, twist:number, thick:number}} o.planform
 * @param {{m:number,p:number,t:number}} o.airfoil
 * @param {number} o.spanStart
 * @param {number} o.spanEnd
 * @param {number} [o.spanSteps]
 * @param {number|((s:number)=>number)} [o.chordStart]
 * @param {number|((s:number)=>number)} [o.chordEnd]
 * @param {number} [o.pivotFrac] chord fraction held fixed under twist
 * @param {number} [o.profileSteps]
 * @param {boolean} [o.roundLE]
 * @param {boolean} [o.capStart]
 * @param {boolean} [o.capEnd]
 * @param {boolean} [o.mirror] build on -X, with winding reversed
 * @param {THREE.Vector3} [o.offset] subtracted from every vertex (hinge origin)
 * @returns {THREE.BufferGeometry}
 */
export function buildLiftingSurface(o) {
  const spanSteps = o.spanSteps ?? 10;
  const profileSteps = o.profileSteps ?? 20;
  const pivotFrac = o.pivotFrac ?? 0.25;
  const mirror = !!o.mirror;
  const sx = mirror ? -1 : 1;
  const ox = o.offset ? o.offset.x : 0;
  const oy = o.offset ? o.offset.y : 0;
  const oz = o.offset ? o.offset.z : 0;

  const cs = typeof o.chordStart === 'function' ? o.chordStart : () => o.chordStart ?? 0;
  const ce = typeof o.chordEnd === 'function' ? o.chordEnd : () => o.chordEnd ?? 1;

  const pos = [];
  const uv = [];
  const rings = [];

  for (let i = 0; i <= spanSteps; i++) {
    const st = i / spanSteps;
    const s = o.spanStart + (o.spanEnd - o.spanStart) * st;
    const pl = o.planform(s);
    const loop = sectionOutline(o.airfoil, cs(s), ce(s), profileSteps, o.roundLE);
    const cw = Math.cos(pl.twist);
    const sw = Math.sin(pl.twist);
    const base = pos.length / 3;
    for (let j = 0; j < loop.length; j++) {
      const zc = (loop[j][0] - pivotFrac) * pl.chord;
      const yc = loop[j][1] * pl.chord * pl.thick;
      pos.push(
        sx * s - ox,
        pl.y + (yc * cw - zc * sw) - oy,
        pl.zLE + pivotFrac * pl.chord + (yc * sw + zc * cw) - oz,
      );
      uv.push(st, j / loop.length);
    }
    rings.push({ base, count: loop.length });
  }

  const idx = [];
  const quad = (a, b, c, d) => {
    // (a,b,c)+(b,d,c) is outward-facing for a +X-increasing ring order; the
    // mirrored panel runs -X so its winding has to flip.
    if (mirror) idx.push(a, c, b, b, c, d);
    else idx.push(a, b, c, b, d, c);
  };
  for (let i = 0; i < spanSteps; i++) {
    const A = rings[i];
    const B = rings[i + 1];
    const n = A.count;
    for (let j = 0; j < n; j++) {
      const j2 = (j + 1) % n;
      quad(A.base + j, A.base + j2, B.base + j, B.base + j2);
    }
  }

  // End caps sit 4 mm inboard of the skin so they can never be coplanar with
  // the cap of the panel butted against them.
  const cap = (ring, outward) => {
    const c = pos.length / 3;
    let cx = 0;
    let cy = 0;
    let cz = 0;
    for (let j = 0; j < ring.count; j++) {
      cx += pos[(ring.base + j) * 3];
      cy += pos[(ring.base + j) * 3 + 1];
      cz += pos[(ring.base + j) * 3 + 2];
    }
    cx /= ring.count;
    cy /= ring.count;
    cz /= ring.count;
    const inset = outward ? -0.004 : 0.004;
    pos.push(cx + sx * inset, cy, cz);
    uv.push(0.5, 0.5);
    const start = pos.length / 3;
    for (let j = 0; j < ring.count; j++) {
      const k = ring.base + j;
      pos.push(
        pos[k * 3] + sx * inset * 0.5,
        pos[k * 3 + 1],
        pos[k * 3 + 2],
      );
      uv.push(uv[k * 2], uv[k * 2 + 1]);
    }
    for (let j = 0; j < ring.count; j++) {
      const a = start + j;
      const b = start + ((j + 1) % ring.count);
      // Loop order is CCW seen from +X, so (c, a, b) faces +X.
      if (outward !== mirror) idx.push(c, a, b);
      else idx.push(c, b, a);
    }
  };
  if (o.capStart) cap(rings[0], false);
  if (o.capEnd) cap(rings[spanSteps], true);

  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/**
 * Loft the fuselage from a station table of superellipse cross-sections, and
 * cut the glazing out of it in the same pass.
 *
 * The window openings and the glass are generated from the *same* quad grid:
 * a quad whose centre falls inside a window rectangle is moved from the shell
 * index into the glass index, and the glass copy is pushed 12 mm out along the
 * vertex normal. They therefore fit each other exactly, at any tessellation —
 * which is the whole reason for doing it this way instead of floating a
 * separate windscreen mesh over an unbroken shell and hoping it lines up.
 *
 * Ring parameter u: 0 = keel, 0.25 = right side, 0.5 = crown, 0.75 = left side.
 * Texture v is linear in Z regardless of ring spacing, so the livery canvas can
 * be drawn directly in metres.
 *
 * @param {Array<[number,number,number,number,number]>} table [z, halfW, halfH, centreY, exponent]
 * @param {number[]} ringZ station positions to loft at
 * @param {number} segs points around each ring
 * @param {Array<{z0:number,z1:number,u0:number,u1:number}>} windows
 * @returns {{shell: THREE.BufferGeometry, glass: THREE.BufferGeometry|null}}
 */
export function buildFuselage(table, ringZ, segs, windows) {
  const zs = table.map((r) => r[0]);
  const fw = monotoneSpline(zs, table.map((r) => r[1]));
  const fh = monotoneSpline(zs, table.map((r) => r[2]));
  const fc = monotoneSpline(zs, table.map((r) => r[3]));
  const fn = monotoneSpline(zs, table.map((r) => r[4]));

  const zMin = ringZ[0];
  const zMax = ringZ[ringZ.length - 1];
  const nz = ringZ.length;
  const cols = segs + 1; // duplicated seam column so u can run 0..1

  const pos = new Float32Array(nz * cols * 3);
  const uvs = new Float32Array(nz * cols * 2);
  for (let i = 0; i < nz; i++) {
    const z = ringZ[i];
    const w = Math.max(1e-4, fw(z));
    const h = Math.max(1e-4, fh(z));
    const cy = fc(z);
    const e = 2 / Math.max(2, fn(z));
    const v = (z - zMin) / (zMax - zMin);
    for (let j = 0; j < cols; j++) {
      const u = j / segs;
      const th = u * TAU;
      const k = (i * cols + j) * 3;
      pos[k] = w * spow(Math.sin(th), e);
      pos[k + 1] = cy - h * spow(Math.cos(th), e);
      pos[k + 2] = z;
      uvs[(i * cols + j) * 2] = v;
      uvs[(i * cols + j) * 2 + 1] = u;
    }
  }

  // Full index first, so computeVertexNormals sees an unbroken surface and the
  // glass offset direction is correct even at the edge of an opening.
  const full = [];
  for (let i = 0; i < nz - 1; i++) {
    for (let j = 0; j < segs; j++) {
      const a = i * cols + j;
      const b = a + 1;
      const c = a + cols;
      const d = c + 1;
      full.push(a, b, c, b, d, c);
    }
  }
  const tmp = new THREE.BufferGeometry();
  tmp.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  tmp.setIndex(full);
  tmp.computeVertexNormals();
  const nrm = tmp.getAttribute('normal').array;
  tmp.dispose();

  // Weld the seam: column 0 and column `segs` are the same point on the hull
  // but were shaded as two half-open edges, which leaves a visible crease.
  for (let i = 0; i < nz; i++) {
    const a = (i * cols) * 3;
    const b = (i * cols + segs) * 3;
    const x = nrm[a] + nrm[b];
    const y = nrm[a + 1] + nrm[b + 1];
    const z = nrm[a + 2] + nrm[b + 2];
    const l = Math.hypot(x, y, z) || 1;
    nrm[a] = nrm[b] = x / l;
    nrm[a + 1] = nrm[b + 1] = y / l;
    nrm[a + 2] = nrm[b + 2] = z / l;
  }

  const inWindow = (z, u) => {
    for (let k = 0; k < windows.length; k++) {
      const r = windows[k];
      if (z >= r.z0 && z <= r.z1 && u >= r.u0 && u <= r.u1) return true;
    }
    return false;
  };

  const shellIdx = [];
  const glassIdx = [];
  for (let i = 0; i < nz - 1; i++) {
    const zc = (ringZ[i] + ringZ[i + 1]) * 0.5;
    for (let j = 0; j < segs; j++) {
      const uc = (j + 0.5) / segs;
      const a = i * cols + j;
      const b = a + 1;
      const c = a + cols;
      const d = c + 1;
      const dst = inWindow(zc, uc) ? glassIdx : shellIdx;
      dst.push(a, b, c, b, d, c);
    }
  }

  // Nose and tail caps. The forward ring is small (it is the cowl mouth around
  // the spinner) and the aft ring closes the tailcone.
  const extra = [];
  const addCap = (row, forward) => {
    const ci = nz * cols + extra.length / 5;
    let cx = 0;
    let cy = 0;
    for (let j = 0; j < segs; j++) {
      cx += pos[(row * cols + j) * 3];
      cy += pos[(row * cols + j) * 3 + 1];
    }
    cx /= segs;
    cy /= segs;
    const cz = ringZ[row] + (forward ? -0.03 : 0.03);
    extra.push(cx, cy, cz, (cz - zMin) / (zMax - zMin), 0.5);
    for (let j = 0; j < segs; j++) {
      const a = row * cols + j;
      const b = row * cols + j + 1;
      if (forward) shellIdx.push(ci, b, a);
      else shellIdx.push(ci, a, b);
    }
  };
  addCap(0, true);
  addCap(nz - 1, false);

  const nExtra = extra.length / 5;
  const posAll = new Float32Array((nz * cols + nExtra) * 3);
  const uvAll = new Float32Array((nz * cols + nExtra) * 2);
  posAll.set(pos);
  uvAll.set(uvs);
  for (let i = 0; i < nExtra; i++) {
    const b = (nz * cols + i) * 3;
    posAll[b] = extra[i * 5];
    posAll[b + 1] = extra[i * 5 + 1];
    posAll[b + 2] = extra[i * 5 + 2];
    uvAll[(nz * cols + i) * 2] = extra[i * 5 + 3];
    uvAll[(nz * cols + i) * 2 + 1] = extra[i * 5 + 4];
  }

  const shell = new THREE.BufferGeometry();
  shell.setAttribute('position', new THREE.BufferAttribute(posAll, 3));
  shell.setAttribute('uv', new THREE.BufferAttribute(uvAll, 2));
  shell.setIndex(shellIdx);
  shell.computeVertexNormals();
  // Restore the welded seam normals that computeVertexNormals just clobbered.
  const sn = shell.getAttribute('normal').array;
  for (let i = 0; i < nz; i++) {
    const a = (i * cols) * 3;
    const b = (i * cols + segs) * 3;
    for (let k = 0; k < 3; k++) sn[a + k] = sn[b + k] = nrm[a + k];
  }
  shell.getAttribute('normal').needsUpdate = true;

  let glass = null;
  if (glassIdx.length) {
    const gp = new Float32Array(nz * cols * 3);
    for (let i = 0; i < nz * cols; i++) {
      gp[i * 3] = pos[i * 3] + nrm[i * 3] * 0.012;
      gp[i * 3 + 1] = pos[i * 3 + 1] + nrm[i * 3 + 1] * 0.012;
      gp[i * 3 + 2] = pos[i * 3 + 2] + nrm[i * 3 + 2] * 0.012;
    }
    glass = new THREE.BufferGeometry();
    glass.setAttribute('position', new THREE.BufferAttribute(gp, 3));
    glass.setAttribute('normal', new THREE.BufferAttribute(nrm.slice(0, nz * cols * 3), 3));
    glass.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
    glass.setIndex(glassIdx);
  }

  return { shell, glass, sampler: { fw, fh, fc, fn, zMin, zMax } };
}

/**
 * Sweep an elliptical section along a polyline. Used for gear legs, lift
 * struts, pushrods and antennae — anything that is a bent bar rather than a
 * surface. `ra` is the half-width in the plane containing the reference up
 * vector, `rb` the half-width perpendicular to it, both as functions of the
 * path parameter, so a leg can taper.
 *
 * @param {THREE.Vector3[]} pts
 * @param {(t:number)=>number} ra
 * @param {(t:number)=>number} rb
 * @param {number} [sides]
 * @param {THREE.Vector3} [ref] reference up
 */
export function sweep(pts, ra, rb, sides = 10, ref = new THREE.Vector3(0, 0, 1)) {
  const pos = [];
  const uv = [];
  const idx = [];
  const tan = new THREE.Vector3();
  const n1 = new THREE.Vector3();
  const n2 = new THREE.Vector3();
  for (let i = 0; i < pts.length; i++) {
    const t = i / (pts.length - 1);
    if (i === 0) tan.copy(pts[1]).sub(pts[0]);
    else if (i === pts.length - 1) tan.copy(pts[i]).sub(pts[i - 1]);
    else tan.copy(pts[i + 1]).sub(pts[i - 1]);
    tan.normalize();
    n1.copy(ref).cross(tan);
    if (n1.lengthSq() < 1e-8) n1.set(1, 0, 0).cross(tan);
    n1.normalize();
    n2.copy(tan).cross(n1).normalize();
    const A = ra(t);
    const B = rb(t);
    for (let j = 0; j < sides; j++) {
      const a = (j / sides) * TAU;
      pos.push(
        pts[i].x + n1.x * A * Math.cos(a) + n2.x * B * Math.sin(a),
        pts[i].y + n1.y * A * Math.cos(a) + n2.y * B * Math.sin(a),
        pts[i].z + n1.z * A * Math.cos(a) + n2.z * B * Math.sin(a),
      );
      uv.push(j / sides, t);
    }
  }
  for (let i = 0; i < pts.length - 1; i++) {
    for (let j = 0; j < sides; j++) {
      const a = i * sides + j;
      const b = i * sides + ((j + 1) % sides);
      const c = a + sides;
      const d = b + sides;
      idx.push(a, b, c, b, d, c);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

// ===========================================================================
// 3. Procedural materials
// ===========================================================================

export const HAS_CANVAS = typeof document !== 'undefined' && !!document.createElement;

export function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

/**
 * A skin canvas at the tier's texel budget, with its 2D context PRE-SCALED so
 * everything drawn afterwards is still written in design space.
 *
 * The livery generators below lay out in texels — `20px` placards, one-texel
 * rivets, `tx(z)` mapping a fuselage station onto texture X. Allocating a
 * smaller canvas without scaling the pen would keep every mark its original
 * size in texels and therefore double it on the aeroplane. See
 * core/textureBudget.js § THE ONE RULE FOR CALLERS.
 *
 * `getContext('2d')` returns the SAME context object on every call, so the
 * transform set here is the one the caller receives.
 */
export function makeSkinCanvas(w, h) {
  const cw = texSize(w);
  const ch = texSize(h);
  const c = makeCanvas(cw, ch);
  c.getContext('2d').scale(cw / w, ch / h);
  return c;
}

/**
 * Derive a tangent-space normal map from a greyscale height canvas by Sobel.
 *
 * This is the detail that decides the 20-50 m chase shot. Panel lines and
 * rivets painted only into the albedo go flat and disappear as soon as the sun
 * moves; as height they catch a specular edge and the airframe reads as sheet
 * metal instead of a decal. Costs a few ms once at load.
 */
export function normalFromHeight(canvas, strength, designW = 0) {
  const w = canvas.width;
  const h = canvas.height;
  // THE SOBEL IS PER TEXEL, SO ITS STRENGTH IS RESOLUTION-DEPENDENT. At half
  // the texels a panel line spans half as many of them for the same height
  // amplitude, so the finite difference doubles and the airframe comes out
  // embossed like a coin. Scaling `strength` by the resolution ratio makes the
  // gradient an estimate of the same DESIGN-SPACE slope at every texture
  // budget. `designW = 0` (or the desktop's scale 1) leaves it exactly alone.
  if (designW > 0) strength *= w / designW;
  const src = canvas.getContext('2d').getImageData(0, 0, w, h).data;
  const out = new Uint8Array(w * h * 4);
  const at = (x, y) => src[((((y % h) + h) % h) * w + (((x % w) + w) % w)) * 4] / 255;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const dx =
        at(x - 1, y - 1) + 2 * at(x - 1, y) + at(x - 1, y + 1) -
        (at(x + 1, y - 1) + 2 * at(x + 1, y) + at(x + 1, y + 1));
      const dy =
        at(x - 1, y - 1) + 2 * at(x, y - 1) + at(x + 1, y - 1) -
        (at(x - 1, y + 1) + 2 * at(x, y + 1) + at(x + 1, y + 1));
      let nx = dx * strength;
      let ny = dy * strength;
      const nz = 1;
      const l = Math.hypot(nx, ny, nz);
      nx /= l;
      ny /= l;
      const i = (y * w + x) * 4;
      out[i] = (nx * 0.5 + 0.5) * 255;
      out[i + 1] = (ny * 0.5 + 0.5) * 255;
      out[i + 2] = (nz / l) * 0.5 * 255 + 127.5;
      out[i + 3] = 255;
    }
  }
  const tex = new THREE.DataTexture(out, w, h, THREE.RGBAFormat);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.needsUpdate = true;
  return tex;
}

/** Panel line + rivet row + a light orange-peel wobble, drawn into ctx. */
export function drawRivets(ctx, x0, y0, x1, y1, colour, pitch, dot) {
  const len = Math.hypot(x1 - x0, y1 - y0);
  const n = Math.max(1, Math.round(len / pitch));
  ctx.fillStyle = colour;
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    ctx.beginPath();
    ctx.arc(x0 + (x1 - x0) * t, y0 + (y1 - y0) * t, dot, 0, TAU);
    ctx.fill();
  }
}

/**
 * A procedural sky/ground environment as a small equirectangular DataTexture.
 *
 * WHY THIS EXISTS AND NOT JUST makeEnvironment(). Reflections are not a garnish
 * on this aircraft, they are most of what sells it in the 20-50 m chase shot:
 * a MeshPhysicalMaterial lit by nothing but a directional light and a
 * hemisphere has no reflection term at all, so the paint reads as matte vinyl
 * and the windows read as grey card. The clearcoat, the 0.85 metalness on the
 * bare-metal parts and the 1.6 envMapIntensity on the glass are all doing
 * nothing without an envMap.
 *
 * PMREMGenerator needs a WebGLRenderer, and `main.js` calls
 * `createAircraft(scene)` with one argument — so on the real boot path the
 * renderer-based version never runs. Rather than make the aeroplane's
 * appearance depend on a call signature nobody is going to change, build the
 * environment as raw pixels instead. Assigning a texture whose `mapping` is
 * EquirectangularReflectionMapping makes three's own WebGLCubeUVMaps prefilter
 * it through PMREM on first render, using the renderer it already has. Same
 * result, no argument required.
 *
 * 128x64 is deliberately tiny: PMREM blurs it to a handful of mips and
 * roughness 0.34 paint cannot resolve more than a gradient and a sun lobe.
 *
 * HALF float, not full. The sun lobe peaks around 2.6, so this has to be an HDR
 * format or the highlight clips flat — but linear filtering of a 32-bit float
 * texture is an extension in WebGL2 (OES_texture_float_linear) and is not
 * guaranteed, while half-float linear filtering is core. A texture three cannot
 * filter is a texture three cannot PMREM.
 *
 * Layout: v = 0 is the zenith, v = 1 the nadir, so y = cos(v * pi).
 */
export function makeSkyEnvTexture() {
  const W = 128;
  const H = 64;
  const data = new Uint16Array(W * H * 4);
  const half = THREE.DataUtils.toHalfFloat;
  // Same palette as the shader path below, so the two look like one aeroplane.
  const GROUND = [0.16, 0.19, 0.15];
  const HORIZON = [0.62, 0.68, 0.76];
  const ZENITH = [0.2, 0.36, 0.7];
  // Sun direction, matching the shader's (0.35, 0.55, -0.75) normalised.
  const sl = Math.hypot(0.35, 0.55, -0.75);
  const sun = [0.35 / sl, 0.55 / sl, -0.75 / sl];

  const smoothstep = (a, b, x) => {
    const t = clamp((x - a) / (b - a), 0, 1);
    return t * t * (3 - 2 * t);
  };

  for (let j = 0; j < H; j++) {
    const phi = ((j + 0.5) / H) * Math.PI;
    const y = Math.cos(phi);
    const sp = Math.sin(phi);
    const h = clamp(y * 0.5 + 0.5, 0, 1);
    for (let i = 0; i < W; i++) {
      const theta = ((i + 0.5) / W) * TAU;
      const dx = sp * Math.cos(theta);
      const dz = sp * Math.sin(theta);
      const k = (j * W + i) * 4;
      const t = h < 0.5 ? smoothstep(0.3, 0.5, h) : smoothstep(0.5, 0.95, h);
      const a = h < 0.5 ? GROUND : HORIZON;
      const b = h < 0.5 ? HORIZON : ZENITH;
      // A broad specular lobe so highlights have somewhere to come from.
      const d = Math.max(0, dx * sun[0] + y * sun[1] + dz * sun[2]);
      const s = Math.pow(d, 26) * 2.2;
      data[k] = half(a[0] + (b[0] - a[0]) * t + 1.2 * s);
      data[k + 1] = half(a[1] + (b[1] - a[1]) * t + 1.0 * s);
      data[k + 2] = half(a[2] + (b[2] - a[2]) * t + 0.8 * s);
      data[k + 3] = half(1);
    }
  }

  const tex = new THREE.DataTexture(data, W, H, THREE.RGBAFormat, THREE.HalfFloatType);
  tex.mapping = THREE.EquirectangularReflectionMapping;
  tex.colorSpace = THREE.LinearSRGBColorSpace;
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  return tex;
}

/**
 * A tiny prefiltered environment so the paint and glass have something to
 * reflect. Higher quality than makeSkyEnvTexture (it is already prefiltered and
 * skips a frame-one conversion), but it needs the renderer, which is why
 * createAircraft takes an optional second argument.
 */
export function makeEnvironment(renderer) {
  const scene = new THREE.Scene();
  const geo = new THREE.SphereGeometry(10, 24, 16);
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    uniforms: {},
    vertexShader: `
      varying vec3 vDir;
      void main() {
        vDir = normalize(position);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: `
      varying vec3 vDir;
      void main() {
        float h = clamp(vDir.y * 0.5 + 0.5, 0.0, 1.0);
        vec3 ground = vec3(0.16, 0.19, 0.15);
        vec3 horizon = vec3(0.62, 0.68, 0.76);
        vec3 zenith = vec3(0.20, 0.36, 0.70);
        vec3 col = h < 0.5
          ? mix(ground, horizon, smoothstep(0.30, 0.50, h))
          : mix(horizon, zenith, smoothstep(0.50, 0.95, h));
        // A broad sun lobe so highlights have somewhere to come from.
        float s = max(0.0, dot(normalize(vDir), normalize(vec3(0.35, 0.55, -0.75))));
        col += vec3(1.2, 1.0, 0.8) * pow(s, 26.0) * 2.2;
        gl_FragColor = vec4(col, 1.0);
      }`,
  });
  scene.add(new THREE.Mesh(geo, mat));
  const pmrem = new THREE.PMREMGenerator(renderer);
  const rt = pmrem.fromScene(scene, 0.02);
  pmrem.dispose();
  geo.dispose();
  mat.dispose();
  return rt.texture;
}
