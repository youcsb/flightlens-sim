/**
 * instruments.js — the cockpit instrument panel.
 *
 * Contract: MODULES.md §2.11
 *
 *   createInstruments(container) -> { update(state) }
 *
 * THIS IS THE DISPLAY BOUNDARY. It is the only module allowed to speak
 * imperial. It reads the pre-computed display fields on the flight model's
 * state, never does physics, never writes back, and owns only the child nodes
 * it appends (§2.11: must not clear siblings).
 *
 * ---------------------------------------------------------------------------
 * WHAT IS DRAWN
 * ---------------------------------------------------------------------------
 * The classic six-pack, plus a tachometer, in one bottom-centre strip:
 *
 *   ASI      AI       ALT       TC       HI       VSI      TACH
 *   airspeed attitude altimeter turn     heading  vert spd engine
 *
 * All of it is live SVG — vector, not canvas, not raster — so it stays sharp
 * at any pixel ratio and scales for free off the viewBox. There is no art
 * pipeline in this project: every bezel, arc, tick, needle and reflection here
 * is geometry and gradients.
 *
 * ---------------------------------------------------------------------------
 * MARKINGS ARE REAL, AND THEY MATCH THE FLIGHT MODEL
 * ---------------------------------------------------------------------------
 * The airspeed arcs are Cessna 172S V-speeds in KIAS:
 *
 *   Vs0  40  stall, full flap      white arc  40 -> 85   (flap operating)
 *   Vs1  48  stall, clean          green arc  48 -> 129  (normal operating)
 *   Vfe  85  max flap extended     yellow arc 129 -> 163 (caution, smooth air)
 *   Vno 129  max structural cruise red line   163        (Vne, never exceed)
 *   Vne 163
 *
 * That is not decoration picked to look busy — it agrees with flightModel.js's
 * defaults to within a knot or two: stallSpeedMs 25 = 48.6 kt (Vs1 48) and
 * maxSpeedMs 85 = 165 kt (Vne 163). The green arc really is the band the model
 * flies in, and the needle really does reach the red line at the model's
 * limit. The tach is the same aircraft: green 2100-2700, red line at 2700,
 * which is flightModel's maxRpm.
 *
 * ---------------------------------------------------------------------------
 * SMOOTHING
 * ---------------------------------------------------------------------------
 * Every needle is damped toward its target with units.js#damp, which is
 * frame-rate independent — nothing ever snaps, and the panel behaves the same
 * at 30 fps as at 144. Rates are per-instrument and chosen to mimic the real
 * instrument's lag: the attitude indicator is nearly immediate (a gyro), the
 * VSI is deliberately sluggish (a calibrated leak), the altimeter sits
 * between. The one exception is the first frame, which snaps, so the panel
 * does not spin up through 330 degrees of heading on boot.
 *
 * Angles are damped the SHORT way round (dampAngle), so passing north does not
 * send the heading card the long way about.
 *
 * ---------------------------------------------------------------------------
 * GEOGRAPHIC READOUT
 * ---------------------------------------------------------------------------
 * The strip under the gauges carries lat/lon and the nearest airport with its
 * distance and bearing. That exists to make the project's central claim
 * checkable at a glance: sit on the ground and the panel should read KBFI at
 * 0.0 NM and 47.5167 / -122.2913. Fly to 47.6204 / -122.3491 and the Space
 * Needle is underneath you.
 *
 * ---------------------------------------------------------------------------
 * TWO LAYOUTS, ONE SET OF NUMBERS
 * ---------------------------------------------------------------------------
 * The row above is the DESKTOP layout. It needs about 1,100 CSS px of width
 * before the 15 px numerals on the airspeed dial stop being readable, and it
 * eats a 210 px band along the bottom of the window. A phone in landscape has
 * 375 px of height in total. Shrinking seven round dials to 40 px each does not
 * produce a small panel, it produces seven illegible smudges — every dial's
 * information is carried by a needle ANGLE against a printed scale, and both
 * the scale and the angle stop resolving at the same time.
 *
 * So the small-screen layout is a different instrument, not a smaller one:
 * MOVING TAPES. A tape carries its number in a fixed box and its rate in the
 * scale sliding past, which is the arrangement that survives being 66 px wide,
 * and it is what every glass cockpit built since 1990 uses for exactly this
 * reason. The five a pilot cannot fly without get one each —
 *
 *   airspeed (left tape) · attitude (bottom-centre ball) · altitude (right
 *   tape) · heading (top tape) · vertical speed (bar beside the altitude)
 *
 * — and the rest is demoted rather than deleted: turn rate and slip fold into
 * the attitude ball (a slip bar under the roll pointer), the tachometer becomes
 * a bar with a redline, radio altitude sits under the altimeter where a real
 * one does, and the stall warning is promoted OUT of the panel into a banner
 * across the top, because on a phone it has to be visible without looking down.
 * Dropped entirely: the Hobbs meter, the Kollsman window, three greens on a
 * fixed-gear aeroplane, and lat/lon — none of them is flown by.
 *
 * `layout: 'auto'` picks by viewport, not by user agent (see COMPACT_QUERY),
 * and re-picks when the window crosses the threshold. The smoothed values in
 * `d` survive the swap, so rotating the phone does not make a needle jump.
 *
 * ---------------------------------------------------------------------------
 * WHERE THE THUMBS GO
 * ---------------------------------------------------------------------------
 * The compact HUD is `pointer-events: none` in its entirety and it keeps out of
 * the two bottom corners, which belong to the touch controls. See
 * TOUCH_RESERVE below for the exact rectangles — they are exported so the
 * acceptance check can assert nothing has crept into them.
 */

import {
  clamp,
  damp,
  wrapDeg,
  DEG_TO_RAD,
  RAD_TO_DEG,
  M_TO_NM,
  GRAVITY,
  KTS_TO_MS,
} from '../core/units.js';
import { nearestAirport } from '../geo/airports.js';
import { MAG_VAR_DEG } from '../geo/coords.js';

// ---------------------------------------------------------------------------
// Panel geometry, in SVG user units. The whole thing is one viewBox, so these
// are a layout grid, not pixels — CSS decides the final size.
// ---------------------------------------------------------------------------

/** Outer bezel radius of one instrument. */
const R_BEZEL = 100;
/** Radius of the dial face inside the bezel — the glass aperture. */
const R_FACE = 88;
/** Centre-to-centre spacing of adjacent instruments. */
const PITCH = 212;
/** Padding around the instrument row. */
const PAD_X = 16;
const PAD_TOP = 14;
/** How many instruments in the row. */
const N_GAUGES = 7;

const ROW_CY = PAD_TOP + R_BEZEL;
const PANEL_W = PAD_X * 2 + (N_GAUGES - 1) * PITCH + R_BEZEL * 2;
/** Top of the data strip beneath the gauges. */
const STRIP_Y = ROW_CY + R_BEZEL + 10;
const STRIP_H = 66;
const PANEL_H = STRIP_Y + STRIP_H + 10;
const PANEL_RATIO = PANEL_W / PANEL_H;

/** X centre of instrument i. */
const cx = (i) => PAD_X + R_BEZEL + i * PITCH;

// ---------------------------------------------------------------------------
// Instrument scales
// ---------------------------------------------------------------------------

// --- airspeed --------------------------------------------------------------
// The real Cessna face, not a generic 0-at-the-top dial: the scale STARTS at
// 40 kt (below that a pitot-static ASI reads nothing useful) at the 7 o'clock
// position, and runs 330 degrees clockwise to 200 kt at 6 o'clock, leaving a
// small gap at the bottom left. That is what puts the green arc up through the
// top of the dial where a pilot expects it, and it parks the needle at 7
// o'clock at rest instead of straight up.
const ASI_START = 210; // degrees clockwise from straight up, at the low end
const ASI_SWEEP = 330; // degrees from the low end to the high end

/**
 * AIRSPEED SCALES, per aircraft. Like the engine gauge, this is not one
 * instrument with a different needle position — it is a different instrument.
 *
 * A Cessna's ASI runs 40-200 kt. A 737 cruises at 250-340 KIAS, which is off
 * the end of that face entirely: the needle sweeps past 200, past the 6
 * o'clock gap, and comes to rest back near the bottom-left where the scale
 * starts. It reads ZERO at 256 kt. That is not a needle pegged at the stop, it
 * is a needle that has gone all the way round, and it is exactly what a real
 * instrument would do if you flew it past its design range.
 *
 * The V-speed arcs are part of the scale, not decoration — the green arc IS
 * the normal operating range and it means nothing if it is another aeroplane's.
 */
const ASI_SCALES = {
  c172: { min: 40, max: 200, step: 5, mid: 10, num: 20, vS0: 40, vS1: 48, vFe: 85, vNo: 129, vNe: 163 },
  // 737-800 at 70 t: Vs0 112 (flap 40), Vs1 143 clean, Vfe 200 (the flaps-15
  // placard this model's single flap axis is set to), Vmo 340.
  b738: { min: 60, max: 400, step: 10, mid: 20, num: 40, vS0: 112, vS1: 143, vFe: 200, vNo: 285, vNe: 340 },
};
let asiCfg = ASI_SCALES.c172;
const asiAngle = (kt) =>
  ASI_START +
  ((clamp(kt, asiCfg.min, asiCfg.max) - asiCfg.min) / (asiCfg.max - asiCfg.min)) * ASI_SWEEP;

// --- attitude --------------------------------------------------------------
/** SVG units of vertical travel per degree of pitch. +-30 deg fits the face. */
const AI_PITCH_PPD = 2.6;

// --- vertical speed: 0 at 9 o'clock, +-2000 fpm meeting near 3 o'clock -----
const VSI_MAX = 2000;
const VSI_HALF_SWEEP = 165;
const vsiAngle = (fpm) =>
  -90 + (clamp(fpm, -VSI_MAX, VSI_MAX) / VSI_MAX) * VSI_HALF_SWEEP;

// --- engine gauge ----------------------------------------------------------
/**
 * The sixth dial is a TACHOMETER on a piston and an N1 GAUGE on a turbofan,
 * and it is not the same instrument with a different needle position.
 *
 * A real 737 has no tachometer at all — its engine instruments read N1 as a
 * PERCENTAGE of fan redline, and the standby instruments a jet carries for
 * exactly this model's six-pack are an ASI, an attitude indicator and an
 * altimeter, never an rpm gauge. Leaving a 0-3,000 RPM face on a jet and
 * feeding it N1 would put 88% N1 at the bottom of the scale and read like a
 * dead engine; leaving it fed from `state.rpm` — which a turbofan publishes as
 * zero, deliberately — reads like a dead engine too, and the needle simply
 * never moves.
 *
 * So the face is rebuilt. setEngineGauge() swaps these and redraws.
 */
const ENGINE_GAUGES = {
  rpm: {
    max: 3000, greenLo: 2100, redline: 2700,
    tickStep: 100, labelStep: 500, labelDiv: 100,
    label: 'RPM', sub: 'HUNDREDS', unit: '',
  },
  n1: {
    // A CFM56-7B redlines at 104% N1 and idles near 21%. The green band starts
    // at 85 because below that a big fan is producing very little thrust —
    // which is the whole reason jets are flown on N1 rather than lever angle.
    max: 110, greenLo: 85, redline: 104,
    tickStep: 5, labelStep: 20, labelDiv: 1,
    label: 'N1', sub: 'PERCENT', unit: '%',
  },
};
let tachCfg = ENGINE_GAUGES.rpm;
const TACH_SWEEP = 270; // from -135 (7:30) to +135 (4:30)
const tachAngle = (v) =>
  -TACH_SWEEP / 2 + (clamp(v, 0, tachCfg.max) / tachCfg.max) * TACH_SWEEP;

// --- turn coordinator ------------------------------------------------------
/** Degrees per second that counts as a standard-rate turn. */
const STANDARD_RATE_DPS = 3;
/** How far the little aeroplane tips when the turn is standard rate. */
const TC_STANDARD_TILT = 20;
/** Inclinometer tube: arc radius, centre, and travel at full deflection. */
const TUBE_R = 218;
const TUBE_CY = -150;
const TUBE_HALF_SPAN = 9.5;

// --- flap detents, degrees, per aircraft ----------------------------------
/**
 * The gauge shows the aeroplane's OWN gate positions. A 737 flap selector has
 * seven, not four, and reading 30 degrees when the lever is at 40 is a wrong
 * number that looks like a right one.
 *
 * The flight model still has a single continuous 0..1 flap axis for both types
 * — detents are not implemented in the physics — so this maps that axis onto
 * the real gate labels rather than pretending the gates exist.
 */
const FLAP_SETS = {
  c172: [0, 10, 20, 30],
  b738: [0, 1, 5, 15, 25, 30, 40],
};
let FLAP_DETENTS = FLAP_SETS.c172;

// ---------------------------------------------------------------------------
// COMPACT HUD geometry. SVG user units; each compact widget is its OWN svg
// with its own viewBox, because they sit at four different screen edges and a
// single viewBox would force one aspect ratio on all of them.
//
// The two tapes and the heading strip are drawn at FULL length and rendered
// with preserveAspectRatio="...slice", so a short landscape window CROPS the
// scale instead of scaling it down. That is the whole trick: the numerals stay
// the same physical size on a 375 px-tall phone as on a 812 px-tall one, and
// what shrinks is how many knots of scale you can see at once.
// ---------------------------------------------------------------------------

/** Airspeed / altitude tape: drawn length, and the y of the reading line. */
const C_TAPE_H = 220;
const C_TAPE_CY = 110;
/** Airspeed tape width, and SVG units per knot (220 units = 68.8 kt). */
const C_ASI_W = 66;
const C_ASI_UPK = 3.2;
/** Altitude widget width: 70 of tape, then the VSI column. */
const C_ALT_W = 92;
const C_ALT_TAPE_W = 70;
/** SVG units per foot (220 units = 1,833 ft). */
const C_ALT_UPF = 0.12;
/** VSI: full scale (+-2000 fpm) reaches this far from the reading line. */
const C_VSI_HALF = 56;
/** Heading strip: drawn width, height, and units per degree (300 = 72 deg). */
const C_HDG_W = 300;
const C_HDG_H = 46;
const C_HDG_UPD = 4.1667;
/** The bottom-centre cluster: attitude ball plus the demoted indicators. */
const C_CLU_W = 208;
const C_CLU_H = 124;

/** Portrait cluster size. Narrower than C_CLU_W so that, centred on a 375-390px
 *  screen, it clears the airspeed tape on the left and the altitude tape on the
 *  right rather than sitting on top of them. */
/* Portrait shows the ball only (see applyCluCrop), so the wrapper is sized to
   the ball's own 112-unit column rather than the full 208-unit cluster.
   THE ASPECT RATIO IS THE CROP. With 'slice' the scale is max(w/208, h/124),
   and the visible width in viewBox units is w/scale. At 112x112 height wins,
   scale is 112/124 = 0.903, and 124 units show — which leaks the first 12 units
   of the demoted column down the right edge. At 112x124 the scale is exactly 1
   and precisely 112 units show: the ball, and nothing else. */
const C_CLU_W_PORTRAIT = 112;
const C_CLU_H_PORTRAIT = 124;
/** Attitude ball centre and radius inside the cluster. */
const C_AI_CX = 56;
const C_AI_CY = 60;
const C_AI_R = 52;
/** Units of ball travel per degree of pitch. +-20 deg fits inside the glass. */
const C_AI_PPD = 1.6;
/** Slip bar: how far it slides at full deflection. */
const C_SLIP_TRAVEL = 13;

/**
 * The media query that chooses the layout. VIEWPORT, never user agent — a
 * desktop window dragged narrow has exactly the problem a phone has, and
 * `?tier=phone` on a desktop must be measurable (MODULES.md §2.18 makes the
 * same argument for the budgets).
 *
 * 820 px of width is where the seven-dial strip's 15 px numerals fall below
 * ~9 px; 460 px of height is where the 210 px panel band starts eating a third
 * of the windscreen. An iPhone in landscape (812x375, or 844x390 on a 14 Pro)
 * fails the height test; in portrait it fails the width test.
 */
const COMPACT_QUERY = '(max-width: 820px), (max-height: 460px)';

/**
 * THE THUMB ZONES, in CSS px, measured INSIDE the safe-area insets from the
 * bottom of the viewport. Nothing this module or overlay.js draws may enter
 * them: they belong to the touch controls.
 *
 * IT IS A BAND ACROSS THE FULL WIDTH, NOT TWO CORNERS, AND IT IS A FUNCTION OF
 * THE VIEWPORT, NOT A CONSTANT. Both of those were wrong here for a whole
 * round, and the two mistakes hid each other:
 *
 *   - `controls/touch.js` draws its rudder bar FULL WIDTH along the bottom,
 *     because rudder is the control touch pilots are usually denied and the
 *     takeoff roll needs it. A reserve described as two 200x200 corners says
 *     nothing about the 400 px of screen between them, so this module put its
 *     attitude cluster bottom-centre — measured live at 812x375, the cluster
 *     covered 7,568 px² of the rudder bar, 78% of the BRK button and 55% of
 *     CAM. The buttons still worked (the HUD is pointer-events: none); you
 *     simply could not see the rudder your thumb was on.
 *
 *   - The height is set by the throttle slider, whose length scales with the
 *     viewport: `14 + rudderHeight + 10 + throttleHeight`. That is 198 px on a
 *     375 px-tall phone — which is where the flat 200 came from — and 215 px at
 *     428 and 300 px at 768. A fixed 200 therefore puts the altitude tape
 *     through the throttle on any landscape screen taller than about 400 px,
 *     and 42 px into it on a tablet.
 *
 * So it is computed, from the same three clamps `touch.js#computeLayout` uses,
 * and `check-touch.mjs § reserve` asserts the answer against the REAL rectangles
 * that function returns at fourteen viewports. If the two ever drift, that is
 * the test that fails.
 *
 * `TOUCH_RESERVE` is kept as the reference-phone value — 812x375 landscape and
 * 375x812 portrait — because it is what the prose in MODULES.md quotes and what
 * `overlay.js` uses for a static offset. Live layout uses `touchReserve()`.
 */
function touchReserve(w, h) {
  const W = Math.max(200, Number.isFinite(w) ? w : 375);
  const H = Math.max(240, Number.isFinite(h) ? h : 812);
  // These four lines mirror touch.js#computeLayout exactly. Duplicated rather
  // than imported so the HUD does not depend on the control layer for its own
  // geometry; the harness is what keeps the copy honest.
  const rudderH = Math.round(Math.min(Math.max(H * 0.075, 44), 64));
  const padSide = Math.min(Math.max(Math.min(W * 0.36, H * 0.3), 96), 190);
  const throttleH = Math.min(Math.max(padSide * 1.15, 120), 260);
  // 14 = the layout inset, 10 = the gap above the rudder bar. The throttle is
  // the tallest thing standing on that line, so it sets the band.
  const band = 14 + rudderH + 10 + Math.round(throttleH);
  // Plus a little air, so a tape does not end exactly on a knob.
  return { w: 200, h: Math.round(band + 8) };
}

const TOUCH_RESERVE = Object.freeze({
  landscape: Object.freeze({ w: 200, h: touchReserve(812, 375).h }),
  portrait: Object.freeze({ w: 200, h: touchReserve(375, 812).h }),
});

// ---------------------------------------------------------------------------
// Palette. Deliberately not pure white on pure black — a real instrument face
// is a warm off-white on dark grey, and #fff on #000 reads as a wireframe.
// ---------------------------------------------------------------------------
const INK = '#e8ecf2'; // primary markings
const INK_DIM = '#9aa6b4'; // secondary markings
const NEEDLE = '#f4f7fb';
const AMBER = '#ffb02e';
const RED = '#e2453c';
const GREEN = '#3fb96b';
const CYAN = '#7fd8ff';
const OFF = '#2a323c'; // unlit lamp / empty segment

// ---------------------------------------------------------------------------
// SVG helpers. All angles here are DEGREES CLOCKWISE FROM STRAIGHT UP, which
// is how instrument faces are actually laid out. SVG's y axis points down, so
// clockwise is the positive rotation direction and `rotate(a)` on a needle
// drawn pointing up does the right thing with no sign juggling.
// ---------------------------------------------------------------------------

const rad = (deg) => (deg - 90) * DEG_TO_RAD;
const px = (r, deg) => (r * Math.cos(rad(deg))).toFixed(2);
const py = (r, deg) => (r * Math.sin(rad(deg))).toFixed(2);

/** A radial tick from r0 out to r1 at `deg`. */
function tick(r0, r1, deg, w, color = INK) {
  return (
    `<line x1="${px(r0, deg)}" y1="${py(r0, deg)}"` +
    ` x2="${px(r1, deg)}" y2="${py(r1, deg)}"` +
    ` stroke="${color}" stroke-width="${w}"/>`
  );
}

/** An arc of radius r from a0 to a1 (a1 > a0), as a stroked path. */
function arc(r, a0, a1, color, w) {
  const large = Math.abs(a1 - a0) > 180 ? 1 : 0;
  return (
    `<path d="M ${px(r, a0)} ${py(r, a0)} A ${r} ${r} 0 ${large} 1` +
    ` ${px(r, a1)} ${py(r, a1)}" fill="none" stroke="${color}"` +
    ` stroke-width="${w}"/>`
  );
}

/** Upright text at a polar position. */
function radialText(r, deg, str, size, color = INK, weight = 500) {
  return (
    `<text x="${px(r, deg)}" y="${py(r, deg)}" class="t" font-size="${size}"` +
    ` fill="${color}" font-weight="${weight}">${str}</text>`
  );
}

/** Text at a polar position, printed ON a rotating card (rotates with it). */
function cardText(r, deg, str, size, color = INK, weight = 600) {
  return (
    `<text x="0" y="0" class="t" font-size="${size}" fill="${color}"` +
    ` font-weight="${weight}"` +
    ` transform="translate(${px(r, deg)} ${py(r, deg)}) rotate(${deg})">` +
    `${str}</text>`
  );
}

/**
 * A tapered pointer drawn along -Y, so `rotate(a)` aims it a degrees clockwise
 * from straight up. `tail` is how far it overhangs behind the hub.
 */
function needlePath(len, halfW, tail) {
  return (
    `M 0 ${-len}` +
    ` L ${halfW} ${-len * 0.6}` +
    ` L ${halfW * 0.62} ${tail}` +
    ` L ${-halfW * 0.62} ${tail}` +
    ` L ${-halfW} ${-len * 0.6} Z`
  );
}

/**
 * A needle plus a free drop shadow. The shadow is a translated copy inside the
 * same rotating group rather than an SVG filter: filters on animated elements
 * re-rasterise every frame, and there are seven of these on screen.
 */
function needle(id, len, halfW, tail, color = NEEDLE) {
  const d = needlePath(len, halfW, tail);
  return (
    `<g id="${id}">` +
    `<path d="${d}" fill="#000" opacity="0.45" transform="translate(2 3)"/>` +
    `<path d="${d}" fill="${color}"/>` +
    `</g>`
  );
}

// ---------------------------------------------------------------------------
// Bezel / face / glass — shared by all seven so they read as one set of
// hardware rather than seven unrelated drawings.
// ---------------------------------------------------------------------------

function bezel(u) {
  let s = '';
  // Case shadow on the panel.
  s += `<circle r="${R_BEZEL + 2}" fill="#000" opacity="0.55"/>`;
  // Machined ring, lit from the upper left.
  s += `<circle r="${R_BEZEL}" fill="url(#${u}-bezel)"/>`;
  s += `<circle r="${R_BEZEL - 1}" fill="none" stroke="#000" stroke-opacity="0.5" stroke-width="1"/>`;
  s += `<circle r="${R_FACE + 4}" fill="none" stroke="#0a0d12" stroke-width="7"/>`;
  // Four bezel screws.
  for (const a of [45, 135, 225, 315]) {
    s +=
      `<g transform="translate(${px(R_BEZEL - 7, a)} ${py(R_BEZEL - 7, a)})">` +
      `<circle r="4.2" fill="#0d1116"/>` +
      `<circle r="3.4" fill="url(#${u}-screw)"/>` +
      `<line x1="-2.2" y1="0" x2="2.2" y2="0" stroke="#05070a" stroke-width="1" transform="rotate(${(a * 1.7).toFixed(0)})"/>` +
      `</g>`;
  }
  return s;
}

function faceDisc(u) {
  return (
    `<circle r="${R_FACE}" fill="url(#${u}-face)"/>` +
    `<circle r="${R_FACE}" fill="none" stroke="#000" stroke-opacity="0.85" stroke-width="2"/>`
  );
}

/**
 * The glass: a broad diagonal sheen, a soft highlight in the upper left, and a
 * vignette darkening the rim. Clipped to the aperture so nothing spills onto
 * the bezel. Cheapest thing in this file, and the one that stops the panel
 * looking like circles with lines in them.
 */
function glass(u) {
  return (
    `<g clip-path="url(#${u}-aperture)" pointer-events="none">` +
    `<ellipse cx="-26" cy="-40" rx="74" ry="40" fill="url(#${u}-sheen)" transform="rotate(-28)"/>` +
    `<path d="M ${-R_FACE} -34 L 4 ${-R_FACE} L 46 ${-R_FACE} L ${-R_FACE} 8 Z" fill="#ffffff" opacity="0.035"/>` +
    `</g>` +
    `<circle r="${R_FACE}" fill="url(#${u}-vignette)" pointer-events="none"/>`
  );
}

/** Everything that makes one instrument, wrapped and positioned. */
function instrument(u, i, inner) {
  return (
    `<g transform="translate(${cx(i)} ${ROW_CY})">` +
    bezel(u) +
    faceDisc(u) +
    inner +
    glass(u) +
    `</g>`
  );
}

// ---------------------------------------------------------------------------
// The seven faces
// ---------------------------------------------------------------------------

function airspeedFace(u) {
  let s = '';

  // Coloured arcs. The white flap-operating arc sits inboard of the green and
  // yellow, exactly as it does on the real instrument.
  const A = asiCfg;
  s += arc(85, asiAngle(A.vS1), asiAngle(A.vNo), GREEN, 8);
  s += arc(85, asiAngle(A.vNo), asiAngle(A.vNe), AMBER, 8);
  s += arc(74, asiAngle(A.vS0), asiAngle(A.vFe), '#f0f4f8', 5);
  // Vne (Vmo on a jet) red line, standing proud of the arcs.
  s += tick(78, 92, asiAngle(A.vNe), 5, RED);

  // Minor ticks every 5 kt, mid ticks every 10, numerals every 20. At
  // 2.06 deg/kt the 5 kt ticks land 10 degrees apart — dense enough to
  // interpolate against, open enough to count.
  for (let kt = A.min; kt <= A.max; kt += A.step) {
    const a = asiAngle(kt);
    if (kt % A.num === 0) s += tick(70, 56, a, 3.2);
    else if (kt % A.mid === 0) s += tick(70, 61, a, 2.2);
    else s += tick(70, 65, a, 1.3, INK_DIM);
  }
  for (let kt = A.min; kt <= A.max; kt += A.num) {
    s += radialText(52, asiAngle(kt), String(kt), 15);
  }

  s += `<text x="0" y="-22" class="t" font-size="9" fill="${INK_DIM}" letter-spacing="1.5">AIRSPEED</text>`;
  s += `<text x="0" y="26" class="t" font-size="10" fill="${INK}" letter-spacing="1.7">KNOTS</text>`;

  s += needle(`${u}-asi-n`, 70, 6, 16);
  s += `<circle r="7" fill="#20262e" stroke="#0a0d12" stroke-width="1.5"/>`;
  return s;
}

function attitudeFace(u) {
  let s = '';

  // --- the moving card: sky, ground, pitch ladder --------------------------
  // Rects run far past the aperture so no amount of roll or pitch can expose
  // an edge.
  let card = '';
  card += `<rect x="-600" y="-600" width="1200" height="600" fill="url(#${u}-sky)"/>`;
  card += `<rect x="-600" y="0" width="1200" height="600" fill="url(#${u}-gnd)"/>`;
  card += `<rect x="-600" y="-1.4" width="1200" height="2.8" fill="#ffffff"/>`;

  // A mark for pitch p sits at y = -p * PPD on the card, so when the aircraft
  // pitches to p the card translates that mark onto the centre.
  for (let p = -30; p <= 30; p += 5) {
    if (p === 0) continue;
    const y = (-p * AI_PITCH_PPD).toFixed(2);
    const major = p % 10 === 0;
    const hw = major ? 34 : 16;
    card +=
      `<line x1="${-hw}" y1="${y}" x2="${hw}" y2="${y}" stroke="#ffffff"` +
      ` stroke-width="${major ? 2 : 1.4}" stroke-opacity="${major ? 0.95 : 0.7}"/>`;
    // Only 10 and 20 get numerals: at level flight the 30 labels would sit
    // exactly on the aperture edge and be sliced in half by the clip.
    if (major && Math.abs(p) <= 20) {
      const n = Math.abs(p);
      card += `<text x="${-hw - 7}" y="${y}" class="t ta-end" font-size="11" fill="#ffffff">${n}</text>`;
      card += `<text x="${hw + 7}" y="${y}" class="t ta-start" font-size="11" fill="#ffffff">${n}</text>`;
    }
  }

  // The bank pointer rides the card, so banking right slides it left across
  // the fixed scale — the classic moving-pointer / fixed-scale arrangement.
  card +=
    `<path d="M 0 ${-R_FACE + 4} L -8 ${-R_FACE + 18} L 8 ${-R_FACE + 18} Z"` +
    ` fill="${AMBER}" stroke="#5a3400" stroke-width="0.8"/>`;

  s += `<g clip-path="url(#${u}-aperture)"><g id="${u}-ai-card">${card}</g></g>`;

  // --- fixed bank scale on the case ---------------------------------------
  let scale = '';
  for (const a of [-60, -30, -20, -10, 10, 20, 30, 60]) {
    const long = Math.abs(a) === 30 || Math.abs(a) === 60;
    scale += tick(R_FACE, R_FACE - (long ? 15 : 9), a, long ? 3 : 2.2, '#ffffff');
  }
  // 45 degrees is a dot on the real instrument, not a line.
  for (const a of [-45, 45]) {
    scale += `<circle cx="${px(R_FACE - 8, a)}" cy="${py(R_FACE - 8, a)}" r="2.6" fill="#ffffff"/>`;
  }
  // Zero index: a longer, heavier tick, NOT a second triangle — a triangle
  // here sits directly under the moving amber pointer and the two read as one
  // smudged shape at panel size.
  scale += tick(R_FACE, R_FACE - 19, 0, 4, '#ffffff');
  s += `<g clip-path="url(#${u}-aperture)">${scale}</g>`;

  // --- fixed aircraft symbol ----------------------------------------------
  s +=
    `<g stroke="#4a2c00" stroke-width="0.7" fill="${AMBER}">` +
    `<rect x="-62" y="-2.6" width="40" height="5.2"/>` +
    `<rect x="22" y="-2.6" width="40" height="5.2"/>` +
    `<rect x="-22" y="-2.6" width="6" height="15"/>` +
    `<rect x="16" y="-2.6" width="6" height="15"/>` +
    `<circle r="4"/>` +
    `</g>`;

  // No caption. There is nowhere on this face to put one that the pitch ladder
  // does not sweep through, and a real attitude indicator does not carry one.
  return s;
}

function altimeterFace(u) {
  let s = '';

  // One revolution of the long hand is 1000 ft, so the numerals are hundreds:
  // 50 minor ticks of 20 ft, majors every 100.
  for (let i = 0; i < 50; i++) {
    const a = i * 7.2;
    if (i % 5 === 0) s += tick(84, 68, a, 3.2);
    else s += tick(84, 76, a, 1.6, INK_DIM);
  }
  for (let n = 0; n < 10; n++) {
    s += radialText(54, n * 36, String(n), 18, INK, 600);
  }

  // Kollsman window, outboard at 3 o'clock where it interrupts the tick ring
  // but clears the numerals — the real instrument's arrangement. Reads a
  // standard 29.92 unless the model grows a baro setting; see update().
  s +=
    `<g transform="translate(60 0)">` +
    `<rect x="0" y="-9.5" width="28" height="19" rx="2.5" fill="#05070a" stroke="#39414c" stroke-width="1"/>` +
    `<text id="${u}-alt-baro" x="14" y="0.5" class="t tn" font-size="11" fill="${CYAN}">29.92</text>` +
    `</g>`;

  s += `<text x="0" y="-30" class="t" font-size="9" fill="${INK_DIM}" letter-spacing="1.4">ALT</text>`;
  s += `<text x="0" y="32" class="t" font-size="8.5" fill="${INK_DIM}" letter-spacing="1">100 FEET</text>`;

  // Ten-thousands: a slim pointer with a triangular tip, reaching the rim.
  s +=
    `<g id="${u}-alt-tk">` +
    `<line x1="0" y1="0" x2="0" y2="-80" stroke="${NEEDLE}" stroke-width="2"/>` +
    `<path d="M 0 -86 L -5 -74 L 5 -74 Z" fill="${NEEDLE}"/>` +
    `<circle cy="-8" r="3.4" fill="${NEEDLE}"/>` +
    `</g>`;
  // Thousands: the short fat hand, stopping just inside the numeral ring.
  s += needle(`${u}-alt-k`, 46, 9, 14);
  // Hundreds: the long thin hand.
  s += needle(`${u}-alt-h`, 80, 5, 18);
  s += `<circle r="7" fill="#20262e" stroke="#0a0d12" stroke-width="1.5"/>`;
  return s;
}

function turnFace(u) {
  let s = '';

  // Fixed index marks: wings level, and the standard-rate marks either side.
  for (const a of [-90 - TC_STANDARD_TILT, -90, 90, 90 + TC_STANDARD_TILT]) {
    s += tick(80, 62, a, 3.4, '#ffffff');
  }
  s += radialText(54, -90 - TC_STANDARD_TILT, 'L', 13, INK_DIM);
  s += radialText(54, 90 + TC_STANDARD_TILT, 'R', 13, INK_DIM);

  // The little aeroplane, banking with the rate of turn.
  s +=
    `<g id="${u}-tc-plane" transform="translate(0 -14)">` +
    `<rect x="-58" y="-2.4" width="116" height="4.8" rx="1.4" fill="${NEEDLE}"/>` +
    `<rect x="-2.6" y="-16" width="5.2" height="16" fill="${NEEDLE}"/>` +
    `<rect x="-13" y="-19" width="26" height="4" rx="1.4" fill="${NEEDLE}"/>` +
    `<circle r="6.5" fill="${NEEDLE}"/>` +
    `</g>`;

  // Both legends have to fit BETWEEN the L and R index letters at x = +-51.
  s += `<text x="0" y="21" class="t" font-size="7" fill="${INK_DIM}" letter-spacing="0.6">TURN COORDINATOR</text>`;
  s += `<text x="0" y="32" class="t" font-size="6" fill="${INK_DIM}" letter-spacing="0.5">2 MIN · NO PITCH INFORMATION</text>`;

  // --- inclinometer --------------------------------------------------------
  // A curved tube: an arc of radius TUBE_R centred well above the face, so the
  // ball rolls in a shallow bowl at the bottom of the dial.
  const halfSpan = 13; // degrees of tube either side of bottom dead centre
  const tx = (t) => (TUBE_R * Math.sin(t * DEG_TO_RAD)).toFixed(2);
  const ty = (t) => (TUBE_CY + TUBE_R * Math.cos(t * DEG_TO_RAD)).toFixed(2);
  const tubeD =
    `M ${tx(-halfSpan)} ${ty(-halfSpan)} A ${TUBE_R} ${TUBE_R} 0 0 1` +
    ` ${tx(halfSpan)} ${ty(halfSpan)}`;

  s += `<path d="${tubeD}" fill="none" stroke="#05070a" stroke-width="26" stroke-linecap="round"/>`;
  s += `<path d="${tubeD}" fill="none" stroke="#161c24" stroke-width="22" stroke-linecap="round"/>`;
  // Cage marks either side of the centred ball.
  for (const t of [-3.3, 3.3]) {
    const r0 = TUBE_R - 12;
    const r1 = TUBE_R + 12;
    const c = Math.cos(t * DEG_TO_RAD);
    const sn = Math.sin(t * DEG_TO_RAD);
    s +=
      `<line x1="${(r0 * sn).toFixed(2)}" y1="${(TUBE_CY + r0 * c).toFixed(2)}"` +
      ` x2="${(r1 * sn).toFixed(2)}" y2="${(TUBE_CY + r1 * c).toFixed(2)}"` +
      ` stroke="#f0f4f8" stroke-width="2"/>`;
  }
  s +=
    `<g id="${u}-tc-ball" transform="translate(0 ${(TUBE_CY + TUBE_R).toFixed(2)})">` +
    `<circle r="9.5" fill="url(#${u}-ball)"/>` +
    `<circle r="9.5" fill="none" stroke="#000" stroke-opacity="0.5" stroke-width="0.8"/>` +
    `</g>`;
  return s;
}

function headingFace(u) {
  const LETTER = { 0: 'N', 90: 'E', 180: 'S', 270: 'W' };
  let card = '';

  for (let a = 0; a < 360; a += 5) {
    if (a % 10 === 0) card += tick(86, 72, a, 2.6);
    else card += tick(86, 79, a, 1.5, INK_DIM);
  }
  for (let a = 0; a < 360; a += 30) {
    if (LETTER[a]) card += cardText(58, a, LETTER[a], 20, INK, 700);
    else card += cardText(58, a, String(a / 10), 17, INK, 600);
  }

  let s = `<g clip-path="url(#${u}-aperture)"><g id="${u}-hi-card">${card}</g></g>`;

  // Fixed aircraft symbol.
  s +=
    `<g fill="${AMBER}" stroke="#4a2c00" stroke-width="0.7">` +
    `<rect x="-30" y="-2.2" width="60" height="4.4" rx="1.2"/>` +
    `<rect x="-2.2" y="-24" width="4.4" height="42" rx="1.2"/>` +
    `<rect x="-11" y="14" width="22" height="4" rx="1.2"/>` +
    `</g>`;

  // Lubber line.
  s += `<path d="M 0 ${-R_FACE + 14} L -8 ${-R_FACE - 1} L 8 ${-R_FACE - 1} Z" fill="#ffffff"/>`;

  // Digital repeats, both INSIDE the numeral ring (r < 48) — anything further
  // out collides with the 15 / 21 numerals as the card turns. The card is
  // TRUE; see the note in update().
  s += `<text id="${u}-hi-mag" x="0" y="-32" class="t tn" font-size="9" fill="${INK_DIM}">000° MAG</text>`;
  s +=
    `<g transform="translate(0 30)">` +
    `<rect x="-30" y="-10" width="60" height="20" rx="3" fill="#05070a" stroke="#39414c" stroke-width="1"/>` +
    `<text id="${u}-hi-true" x="0" y="0.5" class="t tn" font-size="13" fill="${CYAN}">000°T</text>` +
    `</g>`;
  return s;
}

function vsiFace(u) {
  let s = '';

  // Ticks every 100 fpm, majors every 500, numerals in hundreds of fpm.
  for (let f = -VSI_MAX; f <= VSI_MAX; f += 100) {
    const a = vsiAngle(f);
    if (f % 500 === 0) s += tick(84, 68, a, 3.2);
    else s += tick(84, 77, a, 1.6, INK_DIM);
  }
  for (let f = 0; f <= VSI_MAX; f += 500) {
    const n = String(f / 100);
    s += radialText(56, vsiAngle(f), n, 14);
    if (f > 0) s += radialText(56, vsiAngle(-f), n, 14);
  }

  // UP and DOWN go in the 30-degree gap at 3 o'clock, between the two ends of
  // the scale — the only part of this face the numerals leave free, and where
  // the real instrument puts them.
  s += `<text x="36" y="-11" class="t" font-size="8" fill="${INK_DIM}" letter-spacing="0.8">UP</text>`;
  s += `<text x="36" y="11" class="t" font-size="8" fill="${INK_DIM}" letter-spacing="0.8">DN</text>`;
  s += `<text x="0" y="-30" class="t" font-size="8" fill="${INK_DIM}" letter-spacing="1.1">VERTICAL SPEED</text>`;
  s += `<text x="0" y="30" class="t" font-size="7" fill="${INK_DIM}" letter-spacing="0.8">100 FEET PER MINUTE</text>`;

  s += needle(`${u}-vsi-n`, 78, 5, 16);
  s += `<circle r="6.5" fill="#20262e" stroke="#0a0d12" stroke-width="1.5"/>`;
  return s;
}

function tachFace(u) {
  let s = '';

  const c = tachCfg;
  s += arc(84, tachAngle(c.greenLo), tachAngle(c.redline), GREEN, 7);
  s += tick(78, 92, tachAngle(c.redline), 5, RED);

  for (let r = 0; r <= c.max; r += c.tickStep) {
    const a = tachAngle(r);
    if (r % c.labelStep === 0) s += tick(78, 62, a, 3.2);
    else s += tick(78, 68, a, 1.6, INK_DIM);
  }
  for (let r = 0; r <= c.max; r += c.labelStep) {
    s += radialText(50, tachAngle(r), String(r / c.labelDiv), 15);
  }

  s += `<text x="0" y="-24" class="t" font-size="10" fill="${INK_DIM}" letter-spacing="1.4">${c.label}</text>`;
  s += `<text x="0" y="-12" class="t" font-size="7.5" fill="${INK_DIM}" letter-spacing="0.9">${c.sub}</text>`;

  // Hobbs meter, counting real elapsed run time. Cosmetic, but every tach has
  // one and its absence is conspicuous. It goes in the empty 90-degree sector
  // at the bottom that the 270-degree scale leaves free.
  s +=
    `<g transform="translate(0 54)">` +
    `<rect x="-31" y="-10" width="62" height="20" rx="3" fill="#05070a" stroke="#39414c" stroke-width="1"/>` +
    `<text id="${u}-tach-hobbs" x="0" y="0.5" class="t tn" font-size="13" fill="${AMBER}">0000.0</text>` +
    `</g>`;
  s += `<text x="0" y="73" class="t" font-size="7" fill="${INK_DIM}" letter-spacing="1">HOBBS HOURS</text>`;

  s += needle(`${u}-tach-n`, 72, 6, 16);
  s += `<circle r="6.5" fill="#20262e" stroke="#0a0d12" stroke-width="1.5"/>`;
  return s;
}

// ---------------------------------------------------------------------------
// The data strip: annunciators, configuration, and the geographic readout.
// ---------------------------------------------------------------------------

function lamp(id, x, w, label, color) {
  return (
    `<g id="${id}" transform="translate(${x} 0)" class="lamp">` +
    `<rect x="0" y="0" width="${w}" height="26" rx="4" fill="${color}"/>` +
    `<rect x="0" y="0" width="${w}" height="26" rx="4" fill="none" stroke="#000" stroke-opacity="0.55" stroke-width="1"/>` +
    `<text x="${w / 2}" y="14" class="t" font-size="12.5" font-weight="700" letter-spacing="1.4" fill="#0b0d10">${label}</text>` +
    `</g>`
  );
}

function stripContent(u) {
  const y = STRIP_Y;
  let s = '';

  s +=
    `<rect x="${PAD_X}" y="${y}" width="${PANEL_W - PAD_X * 2}" height="${STRIP_H}"` +
    ` rx="7" fill="#0a0e13" stroke="#232b35" stroke-width="1"/>`;

  // --- annunciator lamps ---------------------------------------------------
  s += `<g transform="translate(${PAD_X + 14} ${y + 8})">`;
  s += lamp(`${u}-lamp-stall`, 0, 74, 'STALL', RED);
  s += lamp(`${u}-lamp-gnd`, 82, 62, 'GND', GREEN);
  s += lamp(`${u}-lamp-brk`, 152, 62, 'BRK', AMBER);
  s += `</g>`;

  // --- gear: three greens --------------------------------------------------
  const gx = PAD_X + 252;
  s += `<text x="${gx}" y="${y + 18}" class="t ta-start" font-size="9.5" fill="${INK_DIM}" letter-spacing="1.3">GEAR</text>`;
  const gearLabels = ['N', 'L', 'R'];
  for (let i = 0; i < 3; i++) {
    s +=
      `<g transform="translate(${gx + 48 + i * 27} ${y + 16})">` +
      `<circle id="${u}-gear-${i}" r="9.5" fill="${GREEN}"/>` +
      `<circle r="9.5" fill="url(#${u}-lampgloss)"/>` +
      `<circle r="9.5" fill="none" stroke="#000" stroke-opacity="0.6" stroke-width="1.2"/>` +
      `<text x="0" y="1" class="t" font-size="9" font-weight="700" fill="#06240f">${gearLabels[i]}</text>` +
      `</g>`;
  }
  s += `<text id="${u}-gear-txt" x="${gx + 38}" y="${y + 48}" class="t ta-start" font-size="10" fill="${GREEN}" letter-spacing="1">DOWN &amp; LOCKED</text>`;

  // --- flaps ---------------------------------------------------------------
  const fx = PAD_X + 430;
  s += `<text x="${fx}" y="${y + 18}" class="t ta-start" font-size="9.5" fill="${INK_DIM}" letter-spacing="1.3">FLAPS</text>`;
  for (let i = 0; i < FLAP_DETENTS.length; i++) {
    s +=
      `<rect id="${u}-flap-${i}" x="${fx + 52 + i * 17}" y="${y + 7}" width="12" height="18" rx="2"` +
      ` fill="${OFF}" stroke="#000" stroke-opacity="0.5" stroke-width="0.8"/>`;
  }
  s += `<text id="${u}-flap-txt" x="${fx + 52}" y="${y + 48}" class="t tn ta-start" font-size="12" fill="${INK}">UP</text>`;

  // --- AGL: the number that matters over real terrain ----------------------
  const ax = PAD_X + 620;
  s += `<text x="${ax}" y="${y + 16}" class="t ta-start" font-size="9.5" fill="${INK_DIM}" letter-spacing="1.4">RADIO ALT</text>`;
  s += `<text id="${u}-agl" x="${ax}" y="${y + 44}" class="t tn ta-start" font-size="24" font-weight="600" fill="${GREEN}">0</text>`;
  s += `<text x="${ax + 100}" y="${y + 46}" class="t ta-start" font-size="11" fill="${INK_DIM}">FT AGL</text>`;

  // --- nearest airport -----------------------------------------------------
  const nx = PAD_X + 830;
  s += `<text x="${nx}" y="${y + 16}" class="t ta-start" font-size="9.5" fill="${INK_DIM}" letter-spacing="1.4">NEAREST FIELD</text>`;
  s += `<text id="${u}-nrst" x="${nx}" y="${y + 38}" class="t tn ta-start" font-size="17" font-weight="600" fill="${CYAN}">----</text>`;
  s += `<text id="${u}-nrst-sub" x="${nx}" y="${y + 55}" class="t tn ta-start" font-size="10.5" fill="${INK_DIM}">no airport data</text>`;

  // --- geodetic position ---------------------------------------------------
  const rx = PANEL_W - PAD_X - 18;
  s += `<text x="${rx}" y="${y + 16}" class="t ta-end" font-size="9.5" fill="${INK_DIM}" letter-spacing="1.4">POSITION</text>`;
  s += `<text id="${u}-pos" x="${rx}" y="${y + 38}" class="t tn ta-end" font-size="16" font-weight="600" fill="${INK}">--.----°  ---.----°</text>`;
  s += `<text id="${u}-msl" x="${rx}" y="${y + 55}" class="t tn ta-end" font-size="10.5" fill="${INK_DIM}">MSL 0 FT</text>`;

  return s;
}

// ---------------------------------------------------------------------------
// THE COMPACT HUD — five widgets, each its own <svg>.
//
// Every one of them is `pointer-events: none` and none of them may enter the
// TOUCH_RESERVE rectangles. The CSS at the bottom of this section is where that
// is actually enforced; these functions only draw.
// ---------------------------------------------------------------------------

/** A translucent readout box the width of a tape, centred on the reading line. */
function cReadout(w) {
  return (
    `<rect x="0" y="-16" width="${w}" height="32" fill="#05070a" fill-opacity="0.94"` +
    ` stroke="${CYAN}" stroke-width="1.2"/>`
  );
}

/**
 * Airspeed tape. The V-speed arcs from the round dial survive as a coloured
 * band down the outer edge — the same numbers, in the same order, so a pilot
 * who has learned the dial reads the tape without being told.
 */
function cAirspeed(u) {
  const y = (kt) => (-kt * C_ASI_UPK).toFixed(2);
  const band = (lo, hi, x, w, color) =>
    `<rect x="${x}" y="${y(hi)}" width="${w}" height="${((hi - lo) * C_ASI_UPK).toFixed(2)}"` +
    ` fill="${color}"/>`;

  const A = asiCfg;
  let m = '';
  m += band(A.vS0, A.vFe, 0, 2.6, '#f0f4f8'); // white flap arc, inboard
  m += band(A.vS1, A.vNo, 2.6, 3.4, GREEN);
  m += band(A.vNo, A.vNe, 2.6, 3.4, AMBER);
  m += band(A.vNe, A.max, 2.6, 3.4, RED);
  for (let kt = 0; kt <= A.max; kt += A.step) {
    const major = kt % A.mid === 0;
    m +=
      `<line x1="9" y1="${y(kt)}" x2="${major ? 22 : 16}" y2="${y(kt)}"` +
      ` stroke="${major ? INK : INK_DIM}" stroke-width="${major ? 1.6 : 1.1}"/>`;
    if (major) m += `<text x="26" y="${y(kt)}" class="t ta-start" font-size="12" fill="${INK}">${kt}</text>`;
  }

  return (
    `<defs><clipPath id="${u}-casi"><rect x="0" y="0" width="${C_ASI_W}" height="${C_TAPE_H}"/></clipPath></defs>` +
    `<g clip-path="url(#${u}-casi)">` +
    `<g id="${u}-c-asi-tape" transform="translate(0 ${C_TAPE_CY})">${m}</g>` +
    `</g>` +
    `<g transform="translate(0 ${C_TAPE_CY})">` +
    cReadout(C_ASI_W) +
    `<text x="4" y="-8" class="t ta-start" font-size="7.5" fill="${INK_DIM}" letter-spacing="0.6">KT</text>` +
    `<text id="${u}-c-asi-v" x="${C_ASI_W - 5}" y="1" class="t tn ta-end" font-size="21"` +
    ` font-weight="600" fill="#ffffff">0</text>` +
    `</g>`
  );
}

/**
 * Altitude tape, with the VSI as a bar beside it and the radio altimeter
 * beneath it — the two things that belong next to an altimeter and nowhere
 * else. `slice` crops this widget symmetrically about the reading line, so the
 * VSI's full scale is kept inside +-C_VSI_HALF, which survives the crop.
 */
function cAltitude(u) {
  const y = (ft) => (-ft * C_ALT_UPF).toFixed(2);
  let m = '';
  for (let ft = -1000; ft <= 20000; ft += 100) {
    const major = ft % 500 === 0;
    m +=
      `<line x1="0" y1="${y(ft)}" x2="${major ? 14 : 7}" y2="${y(ft)}"` +
      ` stroke="${major ? INK : INK_DIM}" stroke-width="${major ? 1.6 : 1.1}"/>`;
    if (major) m += `<text x="18" y="${y(ft)}" class="t tn ta-start" font-size="11" fill="${INK}">${group(ft)}</text>`;
  }

  let s =
    `<defs><clipPath id="${u}-calt"><rect x="0" y="0" width="${C_ALT_TAPE_W}" height="${C_TAPE_H}"/></clipPath></defs>` +
    `<g clip-path="url(#${u}-calt)">` +
    `<g id="${u}-c-alt-tape" transform="translate(0 ${C_TAPE_CY})">${m}</g>` +
    `</g>` +
    `<g transform="translate(0 ${C_TAPE_CY})">` +
    cReadout(C_ALT_TAPE_W) +
    `<text x="4" y="-8" class="t ta-start" font-size="7.5" fill="${INK_DIM}" letter-spacing="0.6">FT</text>` +
    `<text id="${u}-c-alt-v" x="${C_ALT_TAPE_W - 5}" y="1" class="t tn ta-end" font-size="18"` +
    ` font-weight="600" fill="#ffffff">0</text>` +
    `</g>`;

  // --- vertical speed ------------------------------------------------------
  const vx = C_ALT_TAPE_W + 4; // 74
  s +=
    `<rect x="${vx + 2}" y="${C_TAPE_CY - C_VSI_HALF}" width="12" height="${C_VSI_HALF * 2}" rx="6"` +
    ` fill="#05070a" fill-opacity="0.85" stroke="#2a323c" stroke-width="1"/>`;
  for (const f of [-2000, -1000, 1000, 2000]) {
    const ty = (C_TAPE_CY - (f / VSI_MAX) * C_VSI_HALF).toFixed(2);
    s += `<line x1="${vx}" y1="${ty}" x2="${vx + 4}" y2="${ty}" stroke="${INK_DIM}" stroke-width="1.2"/>`;
  }
  s += `<line x1="${vx}" y1="${C_TAPE_CY}" x2="${vx + 18}" y2="${C_TAPE_CY}" stroke="${INK}" stroke-width="1.4"/>`;
  s += `<rect id="${u}-c-vsi-bar" x="${vx + 4}" y="${C_TAPE_CY}" width="8" height="0" fill="${CYAN}"/>`;
  s += `<text x="${vx + 8}" y="${C_TAPE_CY - C_VSI_HALF - 7}" class="t" font-size="7.5" fill="${INK_DIM}">VS</text>`;

  // --- radio altitude ------------------------------------------------------
  // Opaque backing, not just text: this block sits ON the tape, and measured
  // at 2,000 ft AGL the label collided with the tape's own "1,000" numeral —
  // two numbers in the same 12 px, neither readable, on the one readout that
  // tells you about the terrain.
  s +=
    `<rect x="0" y="${C_TAPE_CY + 18}" width="${C_ALT_TAPE_W}" height="32" rx="4"` +
    ` fill="#05070a" fill-opacity="0.94" stroke="#2a323c" stroke-width="1"/>`;
  s += `<text x="4" y="${C_TAPE_CY + 26}" class="t ta-start" font-size="8" fill="${INK_DIM}" letter-spacing="0.8">RADIO ALT</text>`;
  s +=
    `<text id="${u}-c-agl" x="${C_ALT_TAPE_W - 20}" y="${C_TAPE_CY + 41}" class="t tn ta-end"` +
    ` font-size="16" font-weight="600" fill="${GREEN}">0</text>`;
  s += `<text x="${C_ALT_TAPE_W - 17}" y="${C_TAPE_CY + 42}" class="t ta-start" font-size="8.5" fill="${INK_DIM}">AGL</text>`;
  return s;
}

/**
 * Heading strip. Drawn from -50 to 410 degrees so the +-36 degrees either side
 * of the lubber line are always populated however the card is wrapped — the
 * alternative, re-serialising the ticks when the heading crosses north, would
 * be the one per-frame allocation in this file.
 */
function cHeading(u) {
  const LETTER = { 0: 'N', 90: 'E', 180: 'S', 270: 'W' };
  let m = '';
  for (let h = -50; h <= 410; h += 5) {
    const x = (h * C_HDG_UPD).toFixed(2);
    const major = h % 10 === 0;
    m +=
      `<line x1="${x}" y1="${major ? 32 : 38}" x2="${x}" y2="${C_HDG_H}"` +
      ` stroke="${major ? INK : INK_DIM}" stroke-width="${major ? 1.6 : 1.1}"/>`;
    if (h % 30 === 0) {
      const w = ((h % 360) + 360) % 360;
      m += LETTER[w] !== undefined
        ? `<text x="${x}" y="24" class="t" font-size="15" font-weight="700" fill="${INK}">${LETTER[w]}</text>`
        : `<text x="${x}" y="24" class="t tn" font-size="13" font-weight="600" fill="${INK}">${w / 10}</text>`;
    }
  }

  return (
    `<defs><clipPath id="${u}-chdg"><rect x="0" y="0" width="${C_HDG_W}" height="${C_HDG_H}"/></clipPath></defs>` +
    `<g clip-path="url(#${u}-chdg)">` +
    `<g id="${u}-c-hdg-tape" transform="translate(${C_HDG_W / 2} 0)">${m}</g>` +
    `</g>` +
    // Lubber line and the digital repeat, both fixed on the centre.
    `<line x1="${C_HDG_W / 2}" y1="26" x2="${C_HDG_W / 2}" y2="${C_HDG_H}" stroke="${AMBER}" stroke-width="2"/>` +
    `<g transform="translate(${C_HDG_W / 2} 0)">` +
    `<rect x="-34" y="0" width="68" height="21" rx="4" fill="#05070a" fill-opacity="0.94" stroke="${CYAN}" stroke-width="1.2"/>` +
    `<text id="${u}-c-hdg-v" x="0" y="11" class="t tn" font-size="14" font-weight="600" fill="#ffffff">000°T</text>` +
    `</g>`
  );
}

/**
 * The bottom-centre cluster: the attitude ball, and everything demoted out of
 * the six-pack that is still worth a glance. It is 208 units wide because that
 * is what fits between the two touch corners on a 375 px-tall landscape phone
 * (see TOUCH_RESERVE) and the width is the binding constraint, not the height.
 */
function cCluster(u) {
  // --- attitude ball -------------------------------------------------------
  let card = '';
  card += `<rect x="-300" y="-300" width="600" height="300" fill="url(#${u}-csky)"/>`;
  card += `<rect x="-300" y="0" width="600" height="300" fill="url(#${u}-cgnd)"/>`;
  card += `<rect x="-300" y="-1.1" width="600" height="2.2" fill="#ffffff"/>`;
  for (let p = -20; p <= 20; p += 5) {
    if (p === 0) continue;
    const yy = (-p * C_AI_PPD).toFixed(2);
    const major = p % 10 === 0;
    const hw = major ? 15 : 7.5;
    card +=
      `<line x1="${-hw}" y1="${yy}" x2="${hw}" y2="${yy}" stroke="#ffffff"` +
      ` stroke-width="${major ? 1.5 : 1.1}" stroke-opacity="${major ? 0.95 : 0.7}"/>`;
  }

  let ball = '';
  ball += `<circle r="${C_AI_R + 2}" fill="#0a0d12"/>`;
  ball += `<g clip-path="url(#${u}-cai)">`;
  ball += `<g id="${u}-c-ai-card">${card}</g>`;
  // Roll pointer and slip bar rotate with the aircraft but must NOT take the
  // pitch translation, so they are siblings of the card, not children of it.
  ball +=
    `<g id="${u}-c-ai-roll">` +
    `<path d="M 0 ${-C_AI_R + 2} L -5 ${-C_AI_R + 11} L 5 ${-C_AI_R + 11} Z" fill="${AMBER}"/>` +
    `</g>`;
  ball +=
    `<g id="${u}-c-slip">` +
    `<rect x="-8" y="${-C_AI_R + 13}" width="16" height="4" rx="1.4" fill="#ffffff" fill-opacity="0.92"/>` +
    `</g>`;
  for (const a of [-60, -30, 30, 60]) ball += tick(C_AI_R, C_AI_R - 7, a, 1.8, '#ffffff');
  ball += tick(C_AI_R, C_AI_R - 11, 0, 2.4, '#ffffff');
  ball += `</g>`;
  ball += `<circle r="${C_AI_R}" fill="none" stroke="#000" stroke-opacity="0.8" stroke-width="2"/>`;
  ball +=
    `<g fill="${AMBER}" stroke="#4a2c00" stroke-width="0.6">` +
    `<rect x="-32" y="-1.6" width="19" height="3.2"/>` +
    `<rect x="13" y="-1.6" width="19" height="3.2"/>` +
    `<circle r="2.6"/>` +
    `</g>`;

  let s =
    `<defs>` +
    `<clipPath id="${u}-cai"><circle r="${C_AI_R}"/></clipPath>` +
    `<linearGradient id="${u}-csky" x1="0" y1="0" x2="0" y2="1">` +
    `<stop offset="0" stop-color="#0d3f80"/><stop offset="1" stop-color="#4f9ee0"/></linearGradient>` +
    `<linearGradient id="${u}-cgnd" x1="0" y1="0" x2="0" y2="1">` +
    `<stop offset="0" stop-color="#9c6631"/><stop offset="1" stop-color="#4a2d15"/></linearGradient>` +
    `</defs>` +
    `<g transform="translate(${C_AI_CX} ${C_AI_CY})">${ball}</g>`;

  // --- the demoted column --------------------------------------------------
  const X = 118;
  const W = C_CLU_W - X - 4; // 86

  // Power. A bar with the same redline the tachometer carries.
  s += `<text x="${X}" y="8" class="t ta-start" font-size="8.5" fill="${INK_DIM}" letter-spacing="0.9">${tachCfg.label}</text>`;
  s += `<text id="${u}-c-rpm-v" x="${X + W}" y="8" class="t tn ta-end" font-size="11.5" fill="${INK}">0</text>`;
  s += `<rect x="${X}" y="14" width="${W}" height="7" rx="3.5" fill="${OFF}"/>`;
  s += `<rect id="${u}-c-rpm-bar" x="${X}" y="14" width="0" height="7" rx="3.5" fill="${GREEN}"/>`;
  s +=
    `<rect x="${(X + (tachCfg.redline / tachCfg.max) * W).toFixed(2)}" y="12"` +
    ` width="1.8" height="11" fill="${RED}"/>`;

  // Flaps.
  s += `<text x="${X}" y="33" class="t ta-start" font-size="8.5" fill="${INK_DIM}" letter-spacing="0.9">FLAP</text>`;
  s += `<text id="${u}-c-flap-v" x="${X}" y="46" class="t tn ta-start" font-size="12" fill="${INK}">UP</text>`;
  for (let i = 0; i < FLAP_DETENTS.length; i++) {
    s +=
      `<rect id="${u}-c-flap-${i}" x="${150 + i * 14}" y="30" width="11" height="17" rx="2"` +
      ` fill="${OFF}" stroke="#000" stroke-opacity="0.5" stroke-width="0.7"/>`;
  }

  // Weight-on-wheels and brakes.
  s +=
    `<g id="${u}-c-lamp-gnd" class="lamp"><rect x="${X}" y="56" width="40" height="19" rx="4" fill="${GREEN}"/>` +
    `<text x="${X + 20}" y="66" class="t" font-size="10" font-weight="700" fill="#0b0d10">GND</text></g>`;
  s +=
    `<g id="${u}-c-lamp-brk" class="lamp"><rect x="${X + 46}" y="56" width="40" height="19" rx="4" fill="${AMBER}"/>` +
    `<text x="${X + 66}" y="66" class="t" font-size="10" font-weight="700" fill="#0b0d10">BRK</text></g>`;

  // Nearest field — the readout that makes the geography checkable, and the
  // one thing from the desktop data strip that is worth a phone's pixels.
  s += `<text x="${X}" y="88" class="t ta-start" font-size="8" fill="${INK_DIM}" letter-spacing="1">NEAREST</text>`;
  s += `<text id="${u}-c-nrst" x="${X}" y="103" class="t tn ta-start" font-size="14" font-weight="600" fill="${CYAN}">----</text>`;
  s += `<text id="${u}-c-nrst-sub" x="${X}" y="116" class="t tn ta-start" font-size="9" fill="${INK_DIM}">no airport data</text>`;
  return s;
}

/**
 * The five widgets, as detached DOM. Each is a wrapper div (which carries the
 * smoked-glass background, the border radius and the crop) around one svg.
 */
function buildCompact(u) {
  const wrap = document.createElement('div');
  wrap.className = `${u}-hud`;

  const svgs = [];
  const add = (cls, vb, w, h, inner, par = 'xMidYMid slice') => {
    const box = document.createElement('div');
    box.className = `${u}-w ${cls}`;
    box.innerHTML =
      `<svg viewBox="0 0 ${vb}" width="${w}" height="${h}" preserveAspectRatio="${par}"` +
      ` xmlns="http://www.w3.org/2000/svg" aria-hidden="true">${inner}</svg>`;
    wrap.appendChild(box);
    const svg = box.firstElementChild;
    if (svg) svgs.push(svg);
    return box;
  };

  add(`${u}-w-hdg`, `${C_HDG_W} ${C_HDG_H}`, C_HDG_W, C_HDG_H, cHeading(u));
  add(`${u}-w-asi`, `${C_ASI_W} ${C_TAPE_H}`, C_ASI_W, C_TAPE_H, cAirspeed(u));
  add(`${u}-w-alt`, `${C_ALT_W} ${C_TAPE_H}`, C_ALT_W, C_TAPE_H, cAltitude(u));
  const cluBox = add(
    `${u}-w-clu`,
    `${C_CLU_W} ${C_CLU_H}`,
    C_CLU_W,
    C_CLU_H,
    cCluster(u),
    'xMidYMid meet',
  );

  /**
   * THE COMPACT HUD SHOWS THE BALL ONLY, IN BOTH ORIENTATIONS.
   *
   * The cluster is an attitude ball plus what this file calls the demoted
   * column — RPM, flaps, gear/brake lamps, nearest field — and on a phone the
   * whole thing sits under the heading strip, IN THE WINDSCREEN. Reported twice:
   * first in portrait, then in landscape as "the ball gear with blue and brown
   * + other info is over the graphics of where I am flying".
   *
   * Moving it does not help, and that is worth recording because it is the
   * obvious idea. Both side edges are already full top to bottom — MENU and the
   * airspeed tape on the left, the A/P chip and the altitude tape on the right —
   * and the heading strip cannot go in a corner because it is a 300-unit ribbon
   * showing a SCALE either side of the current heading; narrow it and it
   * degrades into a number the tapes already show. The only free space is the
   * centre, which is exactly the space that must stay clear.
   *
   * So the fix is footprint, not position: crop to the ball and shrink it.
   *
   * The column is the half worth losing on a phone. FLAP and BRK are already
   * touch buttons that show their own state, and the throttle slider carries
   * its percentage — so the only things actually lost are RPM and the nearest
   * field, both of which are in the menu sheet.
   *
   * Rather than build a second SVG (which would duplicate every element id the
   * updater writes to) the same viewBox is CROPPED: 'xMinYMid slice' scales to
   * cover and keeps the left edge, so a square wrapper shows the ball and cuts
   * the column off. One attribute, switched with the orientation.
   */
  const cluSvg = cluBox.firstElementChild;
  if (cluSvg) cluSvg.setAttribute('preserveAspectRatio', 'xMinYMid slice');

  // The stall banner is plain DOM: it is a word on a red field that blinks, and
  // an SVG for that would cost a viewBox and buy nothing.
  const stall = document.createElement('div');
  stall.className = `${u}-w ${u}-w-stall`;
  stall.textContent = 'STALL';
  wrap.appendChild(stall);

  return { wrap, svgs, stall };
}

/**
 * Compact-layout stylesheet. THIS is where the thumb zones are honoured, and
 * every offset below is derived from TOUCH_RESERVE rather than eyeballed:
 *
 *   both orientations   NOTHING enters the bottom `--${u}-res` pixels, across
 *                       the FULL width, and the attitude cluster lives under
 *                       the heading strip rather than at the bottom
 *
 * `--${u}-res` is written by `pushReserve()` on every resize from
 * `touchReserve(innerWidth, innerHeight)`. It is a variable rather than a
 * baked-in constant because the touch layer's height is a function of the
 * viewport: 196 px on a 320-tall landscape phone, 205 at 375, 224 at 428, 308
 * on a tablet. The flat 200 this replaces put the altitude tape 42 px through
 * the throttle slider on a tablet in landscape.
 *
 * THE CLUSTER IS NOT AT THE BOTTOM IN EITHER ORIENTATION ANY MORE. Portrait
 * moved it up a round ago for its own reason (the chase camera frames the
 * aeroplane dead centre and a bottom-anchored cluster landed on the tail);
 * landscape kept `bottom: 6px` and the two modules had never been run together,
 * so nobody saw what that did. Measured live at 812x375: the cluster covered
 * 7,568 px² of the full-width rudder bar, 78% of the BRK button and 55% of CAM.
 * Under the heading strip is clear in both orientations, and it is where a real
 * PFD puts the attitude indicator anyway.
 *
 * The STALL banner deliberately still draws over the cluster. It is the one
 * thing on this screen that must be unmissable, it only exists for the seconds
 * it is true, and portrait has shipped that way since the compact HUD landed.
 *
 * `env(safe-area-inset-*)` needs `viewport-fit=cover` on the viewport meta to
 * be anything but zero; overlay.js sets that (it owns the page chrome), and a
 * zero inset is a correct answer on a device without a notch.
 */
function compactStyleSheet(u) {
  const L = TOUCH_RESERVE.landscape;
  const P = TOUCH_RESERVE.portrait;
  /** The live reserve, with the reference-phone value as the fallback. */
  const res = (fallback) => `var(--${u}-res, ${fallback}px)`;
  const sl = 'env(safe-area-inset-left, 0px)';
  const sr = 'env(safe-area-inset-right, 0px)';
  const st = 'env(safe-area-inset-top, 0px)';
  const sb = 'env(safe-area-inset-bottom, 0px)';
  return `
.${u}-root.${u}-compact {
  position: absolute; inset: 0; width: auto; bottom: 0; left: 0;
  transform: none; pointer-events: none; user-select: none;
  -webkit-user-select: none; z-index: 20;
}
.${u}-hud { position: absolute; inset: 0; pointer-events: none; }
.${u}-w {
  position: absolute; pointer-events: none;
  background: rgba(8,11,15,0.52);
  border: 1px solid rgba(150,175,205,0.20);
  border-radius: 8px; overflow: hidden;
  box-shadow: 0 4px 16px rgba(0,0,0,0.45);
}
/* The svg FILLS its wrapper and crops (preserveAspectRatio slice). This rule
   has to come after .${u}-root svg { height: auto }, which would otherwise
   stretch the tape instead of cropping it. */
.${u}-w svg { display: block; width: 100%; height: 100%; }
.${u}-w-hdg  { top: calc(${st} + 6px); left: 50%; transform: translateX(-50%);
               width: min(${C_HDG_W}px, calc(100vw - ${sl} - ${sr} - 24px)); height: ${C_HDG_H}px; }
.${u}-w-asi  { left: calc(${sl} + 8px);  width: ${C_ASI_W}px; }
.${u}-w-alt  { right: calc(${sr} + 8px); width: ${C_ALT_W}px; }
.${u}-w-clu  { left: 50%; transform: translateX(-50%);
               width: ${C_CLU_W}px; height: ${C_CLU_H}px;
               top: calc(${st} + 58px); bottom: auto; }
.${u}-w-stall {
  left: 50%; transform: translateX(-50%); top: calc(${st} + 58px);
  display: none; padding: 4px 18px 5px;
  background: ${RED}; border-color: #ff9a95; border-radius: 6px;
  color: #ffffff; font: 700 17px/1.15 "Helvetica Neue", Helvetica, Arial, sans-serif;
  letter-spacing: 0.22em; text-indent: 0.22em;
}
.${u}-w-stall.on { display: block; }
.${u}-w-stall.blink { animation: ${u}-blink 0.62s steps(1, end) infinite; }

/* LANDSCAPE — the primary orientation. Both tapes are pinned under the heading
   strip and stop the live reserve above the bottom safe edge, which is the
   touch band. The cluster sits between them, under the heading strip; the base
   rule above already put it there. */
@media (orientation: landscape) {
  .${u}-w-asi, .${u}-w-alt {
    top: calc(${st} + 58px);
    height: calc(100vh - ${st} - ${sb} - 58px - ${res(L.h)});
    max-height: ${C_TAPE_H}px; min-height: 104px;
  }
}
/* PORTRAIT — 375 px of width is not enough for the heading strip AND the
   overlay's menu button AND the autopilot annunciator on one row, so the strip
   drops to a second row and everything below it moves down with it. Height is
   the one thing portrait has to spare, so the whole bottom ${P.h}px goes to
   the touch controls and the tapes still run their full ${C_TAPE_H} units. */
@media (orientation: portrait) {
  .${u}-w-hdg { top: calc(${st} + 46px); }
  .${u}-w-stall { top: calc(${st} + 104px); }
  .${u}-w-asi, .${u}-w-alt {
    top: calc(${st} + 100px);
    height: calc(100vh - ${st} - ${sb} - 100px - ${res(P.h)} - ${C_CLU_H}px - 20px);
    max-height: ${C_TAPE_H}px; min-height: 104px;
  }
  /* IN PORTRAIT THE CLUSTER GOES TO THE TOP, not the bottom.
     The thumb reserve takes ~${P.h}px off the bottom, which pushes a
     bottom-anchored cluster UP into the middle of the screen — exactly where
     the chase camera frames the aeroplane. Measured at 390x844: the aeroplane
     spans y 428-596 and the cluster landed at 452-576, sitting squarely on it.
     Shrinking cannot fix that; the squeeze is structural, so it moves.

     Under the heading strip is clear, and it is where a real PFD puts the
     attitude indicator anyway. Narrowed to ${C_CLU_W_PORTRAIT}px so it clears
     both tapes horizontally. */
  /* Square, and only as wide as the ball — see applyCluCrop(). The crop is what
     removes the demoted column; this is what stops the wrapper reserving space
     for it. */
  .${u}-w-clu {
    top: calc(${st} + 100px);
    bottom: auto;
    width: ${C_CLU_W_PORTRAIT}px;
    height: ${C_CLU_H_PORTRAIT}px;
  }
  /* The tapes start below the cluster rather than beside it. */
  .${u}-w-asi, .${u}-w-alt {
    top: calc(${st} + 100px + ${C_CLU_H_PORTRAIT}px + 10px);
    height: calc(100vh - ${st} - ${sb} - 100px - ${C_CLU_H_PORTRAIT}px - 10px - ${res(P.h)} - 16px);
  }
}
/* THE CLUSTER MUST NOT SIT ON THE AEROPLANE.
   The chase camera frames the aircraft dead centre, and the cluster is pinned
   bottom-centre — the same column. On a tall window there is room below the
   aeroplane for both; on a short one there is not. Measured at iPhone landscape
   (812x375): the aeroplane spans roughly y 189-265 and the full-size cluster
   occupies y 245-369, overlapping it by 20px and covering the tail.

   So the cluster scales with the height it actually has. It scales as a whole
   rather than dropping a row, because a row that is sometimes there is worse
   than one that never is. */
/* Landscape is SHORT: the touch controls take the bottom, so the windscreen is
   a thin band and anything sitting in it is in the way. The ball only, small.
   The 112:124 aspect is what makes the crop land exactly at the ball's edge —
   see applyCluCrop; any other ratio leaks the demoted column back in. */
@media (orientation: landscape) {
  .${u}-w-clu { width: 84px; height: 93px; }
}
@media (orientation: landscape) and (max-height: 340px) {
  .${u}-w-clu { width: 72px; height: 80px; }
}

/* THE BALL GOES IN THE GAP BESIDE THE MENU BUTTON, not over the aeroplane.
 *
 * Centred under the heading strip it sits directly above the aircraft in chase
 * view — the one part of the frame you are actually looking at. There is dead
 * space between the MENU button and the strip, and it is big enough: measured
 * at 844x390, MENU ends at x 89 and the strip starts at x 272, so 183px of gap
 * for an 84px ball.
 *
 * GATED ON WIDTH, because the strip is CENTRED and slides left as the viewport
 * narrows. The ball's right edge lands at 104 + 84 = 188, the strip's left edge
 * at (100vw - 300) / 2, and wanting 8px between them gives
 *     100vw > 300 + 2 * 196 = 692
 * so 700px is the floor. An iPhone SE in landscape (667) stays centred, every
 * modern phone (780, 844, 926) gets the gap.
 *
 * It also has to clear the airspeed tape, which occupies x 8-74 from y 58 down.
 * At x 104 it does, with 30px to spare.
 */
@media (orientation: landscape) and (min-width: 700px) {
  .${u}-w-clu {
    left: calc(${sl} + 104px);
    transform: none;
    top: calc(${st} + 6px);
    bottom: auto;
  }
}
`;
}

// ---------------------------------------------------------------------------
// defs — gradients and clips, defined once and shared by all seven faces.
// ---------------------------------------------------------------------------

function defs(u) {
  return (
    `<defs>` +
    `<clipPath id="${u}-aperture"><circle r="${R_FACE}"/></clipPath>` +
    // Bezel: a machined ring lit from the upper left.
    `<linearGradient id="${u}-bezel" x1="0.15" y1="0" x2="0.85" y2="1">` +
    `<stop offset="0" stop-color="#5d6773"/><stop offset="0.38" stop-color="#39414b"/>` +
    `<stop offset="0.62" stop-color="#242a32"/><stop offset="1" stop-color="#454e59"/>` +
    `</linearGradient>` +
    `<linearGradient id="${u}-screw" x1="0" y1="0" x2="1" y2="1">` +
    `<stop offset="0" stop-color="#8b949f"/><stop offset="1" stop-color="#3a424c"/>` +
    `</linearGradient>` +
    // Face: near-black with a barely-there lift toward the top left.
    `<radialGradient id="${u}-face" cx="0.36" cy="0.28" r="0.85">` +
    `<stop offset="0" stop-color="#1c222a"/><stop offset="0.6" stop-color="#12171d"/>` +
    `<stop offset="1" stop-color="#080b0f"/>` +
    `</radialGradient>` +
    // Glass.
    `<radialGradient id="${u}-sheen" cx="0.5" cy="0.5" r="0.5">` +
    `<stop offset="0" stop-color="#ffffff" stop-opacity="0.13"/>` +
    `<stop offset="1" stop-color="#ffffff" stop-opacity="0"/>` +
    `</radialGradient>` +
    `<radialGradient id="${u}-vignette" cx="0.5" cy="0.5" r="0.5">` +
    `<stop offset="0.62" stop-color="#000000" stop-opacity="0"/>` +
    `<stop offset="1" stop-color="#000000" stop-opacity="0.5"/>` +
    `</radialGradient>` +
    // Attitude indicator sky and ground.
    `<linearGradient id="${u}-sky" x1="0" y1="0" x2="0" y2="1">` +
    `<stop offset="0" stop-color="#0d3f80"/><stop offset="0.72" stop-color="#2b7fd0"/>` +
    `<stop offset="1" stop-color="#78bff0"/>` +
    `</linearGradient>` +
    `<linearGradient id="${u}-gnd" x1="0" y1="0" x2="0" y2="1">` +
    `<stop offset="0" stop-color="#b0763c"/><stop offset="0.3" stop-color="#8a5628"/>` +
    `<stop offset="1" stop-color="#3d2512"/>` +
    `</linearGradient>` +
    // Slip ball: a small dark sphere with a specular highlight.
    `<radialGradient id="${u}-ball" cx="0.34" cy="0.3" r="0.75">` +
    `<stop offset="0" stop-color="#f2f6fa"/><stop offset="0.35" stop-color="#9aa6b3"/>` +
    `<stop offset="1" stop-color="#2b323a"/>` +
    `</radialGradient>` +
    // Lamp gloss, for the gear lights.
    `<linearGradient id="${u}-lampgloss" x1="0" y1="0" x2="0" y2="1">` +
    `<stop offset="0" stop-color="#ffffff" stop-opacity="0.35"/>` +
    `<stop offset="0.5" stop-color="#ffffff" stop-opacity="0.05"/>` +
    `<stop offset="1" stop-color="#000000" stop-opacity="0.25"/>` +
    `</linearGradient>` +
    // Panel backing.
    `<linearGradient id="${u}-panel" x1="0" y1="0" x2="0" y2="1">` +
    `<stop offset="0" stop-color="#2a313a"/><stop offset="0.06" stop-color="#1a2028"/>` +
    `<stop offset="1" stop-color="#0d1116"/>` +
    `</linearGradient>` +
    `</defs>`
  );
}

// ---------------------------------------------------------------------------
// Stylesheet. Scoped to this instance's root class, so two panels cannot fight
// and nothing here can leak onto a sibling's nodes.
// ---------------------------------------------------------------------------

function styleSheet(u) {
  return `
.${u}-root {
  position: absolute;
  left: 50%;
  bottom: 10px;
  transform: translateX(-50%);
  /* Fit the width, but never let the strip eat the windscreen: the third term
     caps it by HEIGHT, converted through the panel's own aspect ratio. */
  width: min(1180px, 94vw, ${(PANEL_RATIO * 27).toFixed(2)}vh);
  pointer-events: none;
  user-select: none;
  -webkit-user-select: none;
  z-index: 20;
}
.${u}-root svg {
  display: block;
  width: 100%;
  height: auto;
  shape-rendering: geometricPrecision;
  text-rendering: optimizeLegibility;
}
.${u}-root .t {
  font-family: "Helvetica Neue", Helvetica, Arial, sans-serif;
  text-anchor: middle;
  dominant-baseline: central;
}
.${u}-root .ta-start { text-anchor: start; }
.${u}-root .ta-end { text-anchor: end; }
.${u}-root .tn { font-variant-numeric: tabular-nums; }
.${u}-root .lamp { opacity: 0.13; }
.${u}-root .lamp.on { opacity: 1; }
.${u}-root .lamp.on.blink { animation: ${u}-blink 0.62s steps(1, end) infinite; }
@keyframes ${u}-blink { 0%, 55% { opacity: 1; } 56%, 100% { opacity: 0.2; } }
@media (max-width: 760px) { .${u}-root { width: 99vw; bottom: 4px; } }
`;
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/** Integer with thousands separators. */
function group(n) {
  const v = Math.round(n);
  const neg = v < 0;
  const digits = String(neg ? -v : v);
  let out = '';
  for (let i = 0; i < digits.length; i++) {
    if (i > 0 && (digits.length - i) % 3 === 0) out += ',';
    out += digits[i];
  }
  return neg ? '-' + out : out;
}

/**
 * Damp an angle the short way round, so 359 -> 1 does not spin backwards.
 *
 * The result is re-wrapped into [0, 360). Without that the damped value is a
 * free-running accumulator: every turn in the same direction adds another lap,
 * so after ten minutes of circling the heading card is being handed
 * `rotate(-3960)`. It renders identically — which is exactly why it survives a
 * screenshot — but the number grows without bound, and a float that large has
 * lost the precision the 0.01-degree formatting is asking for.
 */
function dampAngle(current, target, rate, dt) {
  let delta = wrapDeg(target - current);
  if (delta > 180) delta -= 360;
  return wrapDeg(current + delta * (1 - Math.exp(-rate * dt)));
}

/** As dampAngle, but kept in [-180, 180) — bank angle is signed. */
function dampBank(current, target, rate, dt) {
  const w = dampAngle(current, target, rate, dt);
  return w >= 180 ? w - 360 : w;
}

/** Write only when the string actually changed — avoids per-frame layout. */
function setText(node, str) {
  if (!node || node.__v === str) return;
  node.__v = str;
  node.textContent = str;
}

function setAttr(node, name, value) {
  if (!node) return;
  const key = '__a_' + name;
  if (node[key] === value) return;
  node[key] = value;
  node.setAttribute(name, value);
}

function setClassOn(node, cls, on) {
  if (!node) return;
  const key = '__c_' + cls;
  if (node[key] === on) return;
  node[key] = on;
  node.classList.toggle(cls, on);
}

function num(v) {
  return Number.isFinite(v) ? v : 0;
}

/** First finite candidate, or null if neither is present. */
function pick(a, b) {
  if (Number.isFinite(a)) return a;
  if (Number.isFinite(b)) return b;
  return null;
}

function pad3(n) {
  const s = String(((n % 360) + 360) % 360);
  return s.length >= 3 ? s : '0'.repeat(3 - s.length) + s;
}

let instanceSeq = 0;

/**
 * Which layout does this viewport want? VIEWPORT, not user agent — see the
 * note on COMPACT_QUERY. Returns 'panel' when there is no window at all, which
 * is what `scripts/check-instruments.mjs` runs against.
 *
 * @param {'auto'|'panel'|'compact'} [pref]
 */
function pickLayout(pref) {
  if (pref === 'panel' || pref === 'compact') return pref;
  if (typeof window === 'undefined') return 'panel';
  // `?hud=compact` forces the small layout on a desktop, which is the only way
  // to measure it without a phone — the same escape hatch `?tier=phone` is.
  try {
    const q = /[?&]hud=(compact|panel)\b/.exec(window.location ? window.location.search : '');
    if (q) return q[1];
  } catch {
    /* location can throw in a sandboxed frame; the media query still works */
  }
  if (typeof window.matchMedia === 'function') {
    return window.matchMedia(COMPACT_QUERY).matches ? 'compact' : 'panel';
  }
  const w = window.innerWidth || 0;
  const h = window.innerHeight || 0;
  if (!w || !h) return 'panel';
  return w <= 820 || h <= 460 ? 'compact' : 'panel';
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Build the instrument panel and mount it.
 *
 * @param {HTMLElement} container Element to mount into. We append; we never
 *                                clear. Defaults to document.body.
 * @returns {{update: (state: Object, inputs?: Object) => void,
 *            dispose: () => void, root: HTMLElement}}
 *
 * `update` takes an OPTIONAL second argument — see the note on flap and brake
 * state inside it. The documented contract `update(state)` is unchanged and
 * calling it that way is fully supported.
 */
export function createInstruments(container, opts = {}) {
  const u = 'ki' + ++instanceSeq;

  const root = document.createElement('div');
  root.className = `${u}-root instruments`;

  const style = document.createElement('style');
  style.textContent = styleSheet(u) + compactStyleSheet(u);
  root.appendChild(style);

  (container || document.body).appendChild(root);

  /** 'panel' | 'compact'. Set by applyLayout(), which also builds the DOM. */
  let layout = null;
  /** The svg roots of the current layout — one for the panel, four compact. */
  let svgs = [];
  /** The wrapper the current layout hangs off, so a swap can remove it. */
  let body = null;
  /** Element handles for the current layout. Rebuilt on every swap. */
  let el = {};

  const $ = (id) => {
    for (let i = 0; i < svgs.length; i++) {
      const n = svgs[i].querySelector(`#${u}-${id}`);
      if (n) return n;
    }
    return null;
  };

  // -------------------------------------------------------------------------
  // Build the whole panel as one string and parse it once. Everything after
  // this point mutates a handful of attributes; nothing re-serialises.
  // -------------------------------------------------------------------------
  function buildPanel() {
    const markup =
      `<svg viewBox="0 0 ${PANEL_W} ${PANEL_H}" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">` +
      defs(u) +
      // Panel backing: a soft outer edge, the metal, then a top highlight.
      `<rect x="6" y="6" width="${PANEL_W - 12}" height="${PANEL_H - 12}" rx="16" fill="#000" opacity="0.35"/>` +
      `<rect x="8" y="8" width="${PANEL_W - 16}" height="${PANEL_H - 16}" rx="14" fill="url(#${u}-panel)" stroke="#39424e" stroke-width="1"/>` +
      `<rect x="9" y="9" width="${PANEL_W - 18}" height="1.2" rx="0.6" fill="#ffffff" opacity="0.09"/>` +
      instrument(u, 0, airspeedFace(u)) +
      instrument(u, 1, attitudeFace(u)) +
      instrument(u, 2, altimeterFace(u)) +
      instrument(u, 3, turnFace(u)) +
      instrument(u, 4, headingFace(u)) +
      instrument(u, 5, vsiFace(u)) +
      instrument(u, 6, tachFace(u)) +
      stripContent(u) +
      `</svg>`;

    const holder = document.createElement('div');
    holder.innerHTML = markup;
    const svgEl = holder.firstElementChild;
    root.appendChild(svgEl);
    svgs = [svgEl];
    body = svgEl;

    el = {
      asi: $('asi-n'),
      aiCard: $('ai-card'),
      altH: $('alt-h'),
      altK: $('alt-k'),
      altTk: $('alt-tk'),
      altBaro: $('alt-baro'),
      tcPlane: $('tc-plane'),
      tcBall: $('tc-ball'),
      hiCard: $('hi-card'),
      hiTrue: $('hi-true'),
      hiMag: $('hi-mag'),
      vsi: $('vsi-n'),
      tach: $('tach-n'),
      hobbs: $('tach-hobbs'),
      lampStall: $('lamp-stall'),
      lampGnd: $('lamp-gnd'),
      lampBrk: $('lamp-brk'),
      gear: [$('gear-0'), $('gear-1'), $('gear-2')],
      gearTxt: $('gear-txt'),
      flap: [$('flap-0'), $('flap-1'), $('flap-2'), $('flap-3')],
      flapTxt: $('flap-txt'),
      agl: $('agl'),
      nrst: $('nrst'),
      nrstSub: $('nrst-sub'),
      pos: $('pos'),
      msl: $('msl'),
    };
  }

  function buildCompactLayout() {
    const built = buildCompact(u);
    root.appendChild(built.wrap);
    svgs = built.svgs;
    body = built.wrap;

    el = {
      asiTape: $('c-asi-tape'),
      asiV: $('c-asi-v'),
      altTape: $('c-alt-tape'),
      altV: $('c-alt-v'),
      vsiBar: $('c-vsi-bar'),
      agl: $('c-agl'),
      hdgTape: $('c-hdg-tape'),
      hdgV: $('c-hdg-v'),
      aiCard: $('c-ai-card'),
      aiRoll: $('c-ai-roll'),
      slip: $('c-slip'),
      rpmBar: $('c-rpm-bar'),
      rpmV: $('c-rpm-v'),
      flap: [$('c-flap-0'), $('c-flap-1'), $('c-flap-2'), $('c-flap-3')],
      flapTxt: $('c-flap-v'),
      lampGnd: $('c-lamp-gnd'),
      lampBrk: $('c-lamp-brk'),
      stall: built.stall,
      nrst: $('c-nrst'),
      nrstSub: $('c-nrst-sub'),
    };
  }

  /**
   * Swap layouts. The smoothed values in `d` are deliberately NOT reset, so
   * rotating a phone (or dragging a desktop window across the breakpoint)
   * re-draws the same readings rather than snapping a needle from zero.
   */
  function applyLayout(next) {
    if (next === layout) return layout;
    if (body && typeof body.remove === 'function') body.remove();
    layout = next;
    if (next === 'compact') buildCompactLayout();
    else buildPanel();
    root.classList.toggle(`${u}-compact`, next === 'compact');
    return layout;
  }

  /**
   * Publish the live thumb reserve as a CSS variable.
   *
   * The compact stylesheet is built once, but the height the touch layer takes
   * is a function of the viewport (see `touchReserve`), so the number has to
   * reach the CSS some other way. A custom property is the cheapest: one string
   * write, no reflow of anything the variable does not touch, and the
   * stylesheet keeps the reference-phone value as its fallback so a browser
   * that never ran this still lays out sensibly.
   *
   * Rounded to 2 px so a URL-bar collapse or an on-screen keyboard — both of
   * which change innerHeight by a few pixels — cannot re-lay-out the HUD on
   * every resize event.
   */
  function pushReserve() {
    if (typeof window === 'undefined' || !root || !root.style) return;
    const r = touchReserve(window.innerWidth, window.innerHeight);
    root.style.setProperty(`--${u}-res`, `${Math.round(r.h / 2) * 2}px`);
  }

  applyLayout(pickLayout(opts.layout));
  pushReserve();

  // Re-pick when the viewport crosses the threshold. matchMedia rather than a
  // resize listener: it fires once on the crossing instead of sixty times
  // during a drag, and it also catches an orientation change that keeps the
  // area the same.
  //
  // The RESERVE, unlike the layout, changes continuously with the viewport, so
  // it does need the resize event — but it only writes a variable.
  let mq = null;
  const onResize = () => pushReserve();
  if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
    window.addEventListener('resize', onResize);
    window.addEventListener('orientationchange', onResize);
  }
  const onMq = () => {
    applyLayout(pickLayout(opts.layout));
    pushReserve();
  };
  if (
    opts.layout !== 'panel' &&
    opts.layout !== 'compact' &&
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function'
  ) {
    mq = window.matchMedia(COMPACT_QUERY);
    if (typeof mq.addEventListener === 'function') mq.addEventListener('change', onMq);
    else if (typeof mq.addListener === 'function') mq.addListener(onMq);
  }

  // -------------------------------------------------------------------------
  /* Last values written to the demoted column. The compact HUD crops that
     column out of the windscreen, so these are what `info()` hands to
     overlay.js to show in the status panel — which reparents into the menu
     sheet on a phone. Cropped from the view, not lost. */
  let lastRpm = 0;
  let lastNearest = '----';
  let lastNearestSub = '';

  // Displayed (smoothed) values. These are what the needles actually show; the
  // state supplies the targets, and every one is chased, never copied.
  // -------------------------------------------------------------------------
  const d = {
    kt: 0,
    pitch: 0,
    roll: 0,
    altFt: 0,
    aglFt: 0,
    hdg: 0,
    turnDps: 0,
    ball: 0,
    vsFpm: 0,
    rpm: 0,
    flap: 0,
  };

  let first = true;
  let lastMs = 0;
  let hobbsSec = 0;
  /** Heading last frame, for the turn-rate derivative. */
  let prevHdg = null;
  /** Nearest-airport lookup is O(n) over the region; 4 Hz is plenty. */
  let nrstTimer = 0;
  const NRST_INTERVAL = 0.25;

  /**
   * Refresh the panel. Called once per rendered frame, after the flight model
   * has stepped (MODULES.md §3, step 6).
   *
   * @param {Object} state    Flight model state. READ ONLY.
   * @param {Object} [inputs] Optional control-input object — the same one
   *   `controls/input.js#get()` returns. FLAP AND BRAKE POSITION ARE NOT ON
   *   `state` today: the flight model consumes them from `inputs` and does not
   *   mirror them back. If the integrator passes `inputs` here, or if the
   *   flight model grows `state.flaps` / `state.brakes`, those indicators go
   *   live. Otherwise the flap block reads `--` rather than inventing a
   *   number, because a confidently wrong flap setting is worse than a blank.
   */
  function update(state, inputs) {
    if (!state) return;

    const now = performance.now();
    let dt = first ? 0 : Math.min((now - lastMs) / 1000, 0.1);
    lastMs = now;

    // --- read the display fields, defensively ------------------------------
    // THE ASI SHOWS INDICATED AIRSPEED, not true. The face is marked in KIAS
    // (Vs0 40, Vs1 48, Vfe 85, Vno 129, Vne 163) and a pitot-static instrument
    // measures dynamic pressure, so it under-reads by sqrt(rho/rho0) with
    // altitude. Feeding it TAS would put the needle 7 kt high over the Cascades
    // and about 20 kt high at Rainier's summit — the arcs would be lying
    // exactly where the terrain makes them matter. Falls back to TAS if the
    // flight model has not published an indicated value.
    const kt = num(pick(state.indicatedAirspeedKts, state.airspeedKts));
    const altFt = num(state.altitudeFt);
    const aglFt = num(state.altitudeAglFt);
    const vsFpm = num(state.verticalSpeedFpm);
    const hdg = wrapDeg(num(state.headingDeg));
    const pitch = clamp(num(state.pitchDeg), -89, 89);
    const roll = clamp(num(state.rollDeg), -180, 180);
    // WHICH NUMBER IS THE ENGINE. A piston publishes rpm and leaves n1Pct at
    // zero; a turbofan does the reverse. Reading the wrong one gives a needle
    // that never leaves the stop, with nothing to say why.
    const rpm = tachCfg === ENGINE_GAUGES.n1 ? num(state.n1Pct) : num(state.rpm);

    // Flaps / brakes: state first, caller-supplied inputs second, absent third.
    // `flapsPos` is the flight model's own rate-limited, blow-back-limited flap
    // position, so it is preferred over the raw command — at 120 kt the lever
    // says 30 degrees and the flaps are still up, and the gauge should agree
    // with the aeroplane rather than with the switch.
    const flapRaw = pick(pick(state.flapsPos, state.flaps), inputs && inputs.flaps);
    const brakeRaw = pick(state.brakes, inputs && inputs.brakes);
    const hasFlap = flapRaw !== null;

    // --- turn rate ---------------------------------------------------------
    // A turn coordinator measures rate of turn. The honest source is the rate
    // of change of the heading the model already publishes — derived here, not
    // computed from bank angle, so it stays correct however the flight model
    // chooses to produce its yaw.
    let turnDps = d.turnDps;
    if (prevHdg !== null && dt > 0) {
      let dh = wrapDeg(hdg - prevHdg);
      if (dh > 180) dh -= 360;
      turnDps = dh / dt;
    }
    prevHdg = hdg;

    // --- slip ball ---------------------------------------------------------
    // Preferred source is a real lateral-acceleration field if the flight
    // model ever publishes one (`state.slipBall`, -1..+1, + = ball to the
    // right). Failing that, infer it: a coordinated turn at rate w and speed V
    // wants bank atan(V*w/g), and the ball shows how far the actual bank is
    // from that. This is an INFERENCE FOR DISPLAY. Nothing is fed back.
    let ball;
    if (Number.isFinite(state.slipBall)) {
      ball = clamp(state.slipBall, -1, 1);
    } else {
      const vMs = Math.max(kt * KTS_TO_MS, 1);
      const wantRad = Math.atan((vMs * turnDps * DEG_TO_RAD) / GRAVITY);
      ball = clamp((roll - wantRad * RAD_TO_DEG) / 12, -1, 1);
    }

    // --- smooth everything -------------------------------------------------
    if (first) {
      d.kt = kt;
      d.pitch = pitch;
      d.roll = roll;
      d.altFt = altFt;
      d.aglFt = aglFt;
      d.hdg = hdg;
      d.turnDps = turnDps;
      d.ball = ball;
      d.vsFpm = vsFpm;
      d.rpm = rpm;
      d.flap = hasFlap ? flapRaw : 0;
      first = false;
      dt = 0;
    } else {
      d.kt = damp(d.kt, kt, 4.5, dt);
      d.pitch = damp(d.pitch, pitch, 14, dt); // gyro: near immediate
      d.roll = dampBank(d.roll, roll, 14, dt);
      d.altFt = damp(d.altFt, altFt, 5, dt);
      d.aglFt = damp(d.aglFt, aglFt, 5, dt);
      d.hdg = dampAngle(d.hdg, hdg, 7, dt);
      d.turnDps = damp(d.turnDps, turnDps, 3.5, dt);
      d.ball = damp(d.ball, ball, 4, dt);
      d.vsFpm = damp(d.vsFpm, vsFpm, 1.8, dt); // calibrated-leak lag
      d.rpm = damp(d.rpm, rpm, 6, dt);
      if (hasFlap) d.flap = damp(d.flap, flapRaw, 3, dt);
    }

    hobbsSec += dt;

    // The value overlay.js puts in its status row. It lives HERE, in the
    // shared update, and not in drawCompact() where it used to: the panel
    // layout never calls drawCompact, so in panel view the row was frozen at
    // whatever the last compact frame had left there — which after an aircraft
    // change meant a Cessna showing the 737's last N1 reading, labelled RPM.
    lastRpm = Math.round(d.rpm);

    if (layout === 'compact') drawCompact(state, brakeRaw, hasFlap);
    else drawPanel(state, brakeRaw, hasFlap);

    // --- nearest airport ---------------------------------------------------
    // Shared: both layouts carry the readout, and it is the one thing on the
    // panel that costs more than an attribute write.
    nrstTimer -= dt;
    if (nrstTimer <= 0) {
      nrstTimer = NRST_INTERVAL;
      updateNearest(state.lat, state.lon);
    }
  }

  /** The seven-dial strip. */
  function drawPanel(state, brakeRaw, hasFlap) {
    // --- airspeed ----------------------------------------------------------
    setAttr(el.asi, 'transform', `rotate(${asiAngle(d.kt).toFixed(2)})`);

    // --- attitude ----------------------------------------------------------
    // rotate(-roll): banking right rolls the horizon anticlockwise on the
    // glass, which is what the pilot sees. The translate comes AFTER, so the
    // pitch displacement happens along the aircraft's vertical, not the
    // world's — get that order wrong and the ladder skews in a banked climb.
    setAttr(
      el.aiCard,
      'transform',
      `rotate(${(-d.roll).toFixed(2)}) translate(0 ${(d.pitch * AI_PITCH_PPD).toFixed(2)})`,
    );

    // --- altimeter ---------------------------------------------------------
    // All three hands come off ONE smoothed altitude, so they cannot disagree
    // with each other the way independently damped hands would.
    const a = d.altFt;
    setAttr(el.altH, 'transform', `rotate(${(((a % 1000) / 1000) * 360).toFixed(2)})`);
    setAttr(el.altK, 'transform', `rotate(${(((a % 10000) / 10000) * 360).toFixed(2)})`);
    setAttr(el.altTk, 'transform', `rotate(${(((a % 100000) / 100000) * 360).toFixed(2)})`);
    if (Number.isFinite(state.baroInHg)) setText(el.altBaro, state.baroInHg.toFixed(2));

    // --- turn coordinator --------------------------------------------------
    const tilt = clamp((d.turnDps / STANDARD_RATE_DPS) * TC_STANDARD_TILT, -45, 45);
    setAttr(el.tcPlane, 'transform', `translate(0 -14) rotate(${tilt.toFixed(2)})`);
    const t = d.ball * TUBE_HALF_SPAN * DEG_TO_RAD;
    setAttr(
      el.tcBall,
      'transform',
      `translate(${(TUBE_R * Math.sin(t)).toFixed(2)} ${(TUBE_CY + TUBE_R * Math.cos(t)).toFixed(2)})`,
    );

    // --- heading -----------------------------------------------------------
    // The card is TRUE. Real directional gyros read magnetic, but every other
    // number in this project — runway headings, bearings, the spawn — is true
    // (MODULES.md §2.5), and a card silently 15.6 degrees off would make the
    // acceptance checks look broken. So: true on the card, magnetic below it,
    // both labelled, nothing ambiguous.
    setAttr(el.hiCard, 'transform', `rotate(${(-d.hdg).toFixed(2)})`);
    setText(el.hiTrue, `${pad3(Math.round(d.hdg))}°T`);
    setText(el.hiMag, `${pad3(Math.round(d.hdg - MAG_VAR_DEG))}° MAG`);

    // --- vertical speed ----------------------------------------------------
    setAttr(el.vsi, 'transform', `rotate(${vsiAngle(d.vsFpm).toFixed(2)})`);

    // --- tachometer --------------------------------------------------------
    setAttr(el.tach, 'transform', `rotate(${tachAngle(d.rpm).toFixed(2)})`);
    setText(el.hobbs, (hobbsSec / 3600).toFixed(1).padStart(6, '0'));

    // --- annunciators ------------------------------------------------------
    // Two states, one lamp, exactly as a real stall-warning system behaves:
    // the horn starts a few knots BEFORE the break (state.stallWarning — the
    // buffet) and goes continuous once the wing actually lets go. Lit steady =
    // you are approaching the critical angle of attack; flashing = you are past
    // it. Without the warning stage the first indication is the break itself,
    // which gives the pilot nothing to act on.
    const stalled = !!state.stalled;
    const warning = stalled || !!state.stallWarning;
    setClassOn(el.lampStall, 'on', warning);
    setClassOn(el.lampStall, 'blink', stalled);
    setClassOn(el.lampGnd, 'on', !!state.onGround);
    setClassOn(el.lampBrk, 'on', brakeRaw !== null && brakeRaw > 0.02);

    // --- gear --------------------------------------------------------------
    // The airframe is fixed-gear, so absent any gear state the three greens
    // are honestly lit and labelled FIXED. If a retractable ever appears,
    // `state.gearPos` (0 = up, 1 = down) drives them: amber in transit, dark
    // when up.
    const hasGearPos = Number.isFinite(state.gearPos);
    const gearPos = hasGearPos ? clamp(state.gearPos, 0, 1) : state.gearDown === false ? 0 : 1;
    const gearColor = gearPos >= 0.99 ? GREEN : gearPos <= 0.01 ? OFF : AMBER;
    for (const g of el.gear) setAttr(g, 'fill', gearColor);
    setAttr(el.gearTxt, 'fill', gearColor === OFF ? INK_DIM : gearColor);
    setText(
      el.gearTxt,
      gearPos >= 0.99
        ? hasGearPos
          ? 'DOWN & LOCKED'
          : 'DOWN (FIXED)'
        : gearPos <= 0.01
          ? 'UP'
          : 'IN TRANSIT',
    );

    // --- flaps -------------------------------------------------------------
    if (hasFlap) {
      const detent = Math.round(clamp(d.flap, 0, 1) * (FLAP_DETENTS.length - 1));
      for (let i = 0; i < el.flap.length; i++) {
        // Segment 0 is the UP detent: it lights dim rather than cyan, so the
        // bar always shows *something* and "up" never looks like "no data".
        setAttr(el.flap[i], 'fill', i > detent ? OFF : i === 0 ? INK_DIM : CYAN);
      }
      setAttr(el.flapTxt, 'fill', detent > 0 ? CYAN : INK);
      setText(el.flapTxt, detent === 0 ? 'UP' : `${FLAP_DETENTS[detent]}°`);
    } else {
      for (const f of el.flap) setAttr(f, 'fill', '#1c222a');
      setAttr(el.flapTxt, 'fill', INK_DIM);
      setText(el.flapTxt, '--');
    }

    // --- AGL ---------------------------------------------------------------
    // Colour-coded the way a radio altimeter is: green in the cruise, amber in
    // the pattern, red when the terrain is close. With real elevation the
    // ground moves, so this is the number that tells you about Rainier.
    setText(el.agl, group(Math.max(d.aglFt, 0)));
    setAttr(el.agl, 'fill', d.aglFt < 200 ? RED : d.aglFt < 1000 ? AMBER : GREEN);

    // --- position ----------------------------------------------------------
    if (Number.isFinite(state.lat) && Number.isFinite(state.lon)) {
      const la = state.lat;
      const lo = state.lon;
      setText(
        el.pos,
        `${Math.abs(la).toFixed(4)}° ${la >= 0 ? 'N' : 'S'}   ` +
          `${Math.abs(lo).toFixed(4)}° ${lo >= 0 ? 'E' : 'W'}`,
      );
    } else {
      setText(el.pos, '--.----°  ---.----°');
    }
    // Damped, so the digits and the three hands are reading the same altitude.
    setText(el.msl, `MSL ${group(d.altFt)} FT`);
  }

  /**
   * The compact HUD. Same smoothed values, different glass: what was a needle
   * angle on the panel is a tape offset here, and the digital repeat in the
   * middle of each tape is the primary reading rather than a cross-check.
   */
  function drawCompact(state, brakeRaw, hasFlap) {
    // --- airspeed ----------------------------------------------------------
    setAttr(el.asiTape, 'transform', `translate(0 ${(C_TAPE_CY + d.kt * C_ASI_UPK).toFixed(2)})`);
    setText(el.asiV, String(Math.max(0, Math.round(d.kt))));
    const stalled = !!state.stalled;
    const warning = stalled || !!state.stallWarning;
    setAttr(el.asiV, 'fill', stalled ? '#ff8f8f' : warning ? AMBER : '#ffffff');

    // --- altitude ----------------------------------------------------------
    setAttr(el.altTape, 'transform', `translate(0 ${(C_TAPE_CY + d.altFt * C_ALT_UPF).toFixed(2)})`);
    setText(el.altV, group(d.altFt));

    // --- vertical speed ----------------------------------------------------
    // One rect, grown from the reading line. Two attribute writes beats a
    // rotating needle here: at 12 units wide a needle is a smudge.
    const vh = (clamp(d.vsFpm, -VSI_MAX, VSI_MAX) / VSI_MAX) * C_VSI_HALF;
    setAttr(el.vsiBar, 'y', (C_TAPE_CY - Math.max(vh, 0)).toFixed(2));
    setAttr(el.vsiBar, 'height', Math.abs(vh).toFixed(2));

    // --- radio altitude ----------------------------------------------------
    setText(el.agl, group(Math.max(d.aglFt, 0)));
    setAttr(el.agl, 'fill', d.aglFt < 200 ? RED : d.aglFt < 1000 ? AMBER : GREEN);

    // --- heading -----------------------------------------------------------
    // The strip is drawn from -50 to 410 degrees, so the translate has to be
    // computed from a WRAPPED heading or it walks off the drawn range. Same
    // convention as the round card: true on the tape, and it says so.
    const h = wrapDeg(d.hdg);
    setAttr(el.hdgTape, 'transform', `translate(${(C_HDG_W / 2 - h * C_HDG_UPD).toFixed(2)} 0)`);
    setText(el.hdgV, `${pad3(Math.round(h))}°T`);

    // --- attitude ----------------------------------------------------------
    setAttr(
      el.aiCard,
      'transform',
      `rotate(${(-d.roll).toFixed(2)}) translate(0 ${(d.pitch * C_AI_PPD).toFixed(2)})`,
    );
    setAttr(el.aiRoll, 'transform', `rotate(${(-d.roll).toFixed(2)})`);
    // The slip bar slides along the AIRCRAFT's lateral axis, so it is rotated
    // first and translated second — the opposite order puts it on the horizon.
    setAttr(
      el.slip,
      'transform',
      `rotate(${(-d.roll).toFixed(2)}) translate(${(d.ball * C_SLIP_TRAVEL).toFixed(2)} 0)`,
    );

    // --- power -------------------------------------------------------------
    const rpmFrac = clamp(d.rpm / tachCfg.max, 0, 1);
    setAttr(el.rpmBar, 'width', (rpmFrac * (C_CLU_W - 122)).toFixed(2));
    setAttr(el.rpmBar, 'fill', d.rpm > tachCfg.redline ? RED : d.rpm >= tachCfg.greenLo ? GREEN : CYAN);
    setText(el.rpmV, group(d.rpm));

    // --- flaps -------------------------------------------------------------
    if (hasFlap) {
      const detent = Math.round(clamp(d.flap, 0, 1) * (FLAP_DETENTS.length - 1));
      for (let i = 0; i < el.flap.length; i++) {
        setAttr(el.flap[i], 'fill', i > detent ? OFF : i === 0 ? INK_DIM : CYAN);
      }
      setAttr(el.flapTxt, 'fill', detent > 0 ? CYAN : INK);
      setText(el.flapTxt, detent === 0 ? 'UP' : `${FLAP_DETENTS[detent]}°`);
    } else {
      for (const f of el.flap) setAttr(f, 'fill', '#1c222a');
      setAttr(el.flapTxt, 'fill', INK_DIM);
      setText(el.flapTxt, '--');
    }

    // --- annunciators ------------------------------------------------------
    setClassOn(el.lampGnd, 'on', !!state.onGround);
    setClassOn(el.lampBrk, 'on', brakeRaw !== null && brakeRaw > 0.02);
    // The stall warning is promoted out of the cluster and across the top:
    // on a phone the pilot is looking at the windscreen, not at the panel, and
    // a 19 px lamp in the corner is not an alert.
    setClassOn(el.stall, 'on', warning);
    setClassOn(el.stall, 'blink', stalled);
  }

  /** Nearest field: ident, distance, bearing. Degrades to `----`. */
  function updateNearest(lat, lon) {
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;
    let n = null;
    try {
      n = nearestAirport(lat, lon);
    } catch {
      n = null; // airports.js is allowed to be unbaked — MODULES.md §1.6
    }
    if (!n) {
      setText(el.nrst, '----');
      setText(el.nrstSub, 'no airport data');
      lastNearest = '----';
      lastNearestSub = 'no airport data';
      return;
    }
    const nm = n.distanceM * M_TO_NM;
    const sub = `${nm.toFixed(nm < 10 ? 1 : 0)} NM  ${pad3(Math.round(n.bearingDeg))}°`;
    setText(el.nrst, n.airport.ident);
    setText(el.nrstSub, sub);
    lastNearest = n.airport.ident;
    lastNearestSub = sub;
  }

  function dispose() {
    if (mq) {
      if (typeof mq.removeEventListener === 'function') mq.removeEventListener('change', onMq);
      else if (typeof mq.removeListener === 'function') mq.removeListener(onMq);
      mq = null;
    }
    if (typeof window !== 'undefined' && typeof window.removeEventListener === 'function') {
      window.removeEventListener('resize', onResize);
      window.removeEventListener('orientationchange', onResize);
    }
    root.remove();
  }

  return {
    update,
    dispose,
    /**
     * The readouts the compact HUD crops away, for whoever wants to show them
     * elsewhere. `overlay.js` puts them in the status panel, which reparents
     * into the menu sheet on a phone — so cropping the cluster hides them from
     * the windscreen without losing them.
     */
    info: () => ({
      rpm: lastRpm,
      engineLabel: tachCfg.label,
      engineUnit: tachCfg.unit,
      nearest: lastNearest,
      nearestSub: lastNearestSub,
    }),
    /**
     * Swap the sixth dial between a tachometer and an N1 gauge.
     *
     * The FACE is rebuilt, not just the needle — see ENGINE_GAUGES. Passing a
     * kind that is already active is a no-op, so main.js can call it freely.
     *
     * ...and the airspeed scale with it, because both faces live in the same
     * SVG and there is only one rebuild to spend.
     *
     * @param {'rpm'|'n1'} kind — flightModel publishes this as state.engineGauge.
     * @param {'c172'|'b738'} [asiKey] — which ASI_SCALES entry to draw.
     */
    setEngineGauge(kind, asiKey) {
      const next = ENGINE_GAUGES[kind] || ENGINE_GAUGES.rpm;
      const nextAsi = ASI_SCALES[asiKey] || asiCfg;
      const nextFlap = FLAP_SETS[asiKey] || FLAP_DETENTS;
      if (next === tachCfg && nextAsi === asiCfg && nextFlap === FLAP_DETENTS) return;
      tachCfg = next;
      asiCfg = nextAsi;
      FLAP_DETENTS = nextFlap;
      // Force a full rebuild: the current layout's SVG has the old face baked
      // into its markup, and there is no partial update that can change a
      // dial's tick spacing and its legend.
      const want = layout;
      layout = null;
      applyLayout(want);
    },
    root,
    /** 'panel' | 'compact'. For the acceptance check and the console. */
    getLayout: () => layout,
    /** Force a layout at run time; pass 'auto' to hand it back to the query. */
    setLayout: (name) => applyLayout(pickLayout(name)),
  };
}

export { COMPACT_QUERY, TOUCH_RESERVE, touchReserve, pickLayout };
