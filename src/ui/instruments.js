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
const ASI_MIN = 40;
const ASI_MAX = 200;
const ASI_START = 210; // degrees clockwise from straight up, at ASI_MIN
const ASI_SWEEP = 330; // degrees from ASI_MIN to ASI_MAX
const asiAngle = (kt) =>
  ASI_START +
  ((clamp(kt, ASI_MIN, ASI_MAX) - ASI_MIN) / (ASI_MAX - ASI_MIN)) * ASI_SWEEP;

// Cessna 172S V-speeds, KIAS. See the header note.
const V_S0 = 40;
const V_S1 = 48;
const V_FE = 85;
const V_NO = 129;
const V_NE = 163;

// --- attitude --------------------------------------------------------------
/** SVG units of vertical travel per degree of pitch. +-30 deg fits the face. */
const AI_PITCH_PPD = 2.6;

// --- vertical speed: 0 at 9 o'clock, +-2000 fpm meeting near 3 o'clock -----
const VSI_MAX = 2000;
const VSI_HALF_SWEEP = 165;
const vsiAngle = (fpm) =>
  -90 + (clamp(fpm, -VSI_MAX, VSI_MAX) / VSI_MAX) * VSI_HALF_SWEEP;

// --- tachometer ------------------------------------------------------------
const TACH_MAX = 3000;
const TACH_SWEEP = 270; // from -135 (7:30) to +135 (4:30)
const tachAngle = (rpm) =>
  -TACH_SWEEP / 2 + (clamp(rpm, 0, TACH_MAX) / TACH_MAX) * TACH_SWEEP;
const TACH_GREEN_LO = 2100;
const TACH_REDLINE = 2700;

// --- turn coordinator ------------------------------------------------------
/** Degrees per second that counts as a standard-rate turn. */
const STANDARD_RATE_DPS = 3;
/** How far the little aeroplane tips when the turn is standard rate. */
const TC_STANDARD_TILT = 20;
/** Inclinometer tube: arc radius, centre, and travel at full deflection. */
const TUBE_R = 218;
const TUBE_CY = -150;
const TUBE_HALF_SPAN = 9.5;

// --- flap detents, degrees (C172) -----------------------------------------
const FLAP_DETENTS = [0, 10, 20, 30];

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
  s += arc(85, asiAngle(V_S1), asiAngle(V_NO), GREEN, 8);
  s += arc(85, asiAngle(V_NO), asiAngle(V_NE), AMBER, 8);
  s += arc(74, asiAngle(V_S0), asiAngle(V_FE), '#f0f4f8', 5);
  // Vne red line, standing proud of the arcs.
  s += tick(78, 92, asiAngle(V_NE), 5, RED);

  // Minor ticks every 5 kt, mid ticks every 10, numerals every 20. At
  // 2.06 deg/kt the 5 kt ticks land 10 degrees apart — dense enough to
  // interpolate against, open enough to count.
  for (let kt = ASI_MIN; kt <= ASI_MAX; kt += 5) {
    const a = asiAngle(kt);
    if (kt % 20 === 0) s += tick(70, 56, a, 3.2);
    else if (kt % 10 === 0) s += tick(70, 61, a, 2.2);
    else s += tick(70, 65, a, 1.3, INK_DIM);
  }
  for (let kt = ASI_MIN; kt <= ASI_MAX; kt += 20) {
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

  s += arc(84, tachAngle(TACH_GREEN_LO), tachAngle(TACH_REDLINE), GREEN, 7);
  s += tick(78, 92, tachAngle(TACH_REDLINE), 5, RED);

  for (let r = 0; r <= TACH_MAX; r += 100) {
    const a = tachAngle(r);
    if (r % 500 === 0) s += tick(78, 62, a, 3.2);
    else s += tick(78, 68, a, 1.6, INK_DIM);
  }
  for (let r = 0; r <= TACH_MAX; r += 500) {
    s += radialText(50, tachAngle(r), String(r / 100), 15);
  }

  s += `<text x="0" y="-24" class="t" font-size="10" fill="${INK_DIM}" letter-spacing="1.4">RPM</text>`;
  s += `<text x="0" y="-12" class="t" font-size="7.5" fill="${INK_DIM}" letter-spacing="0.9">HUNDREDS</text>`;

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
export function createInstruments(container) {
  const u = 'ki' + ++instanceSeq;

  const root = document.createElement('div');
  root.className = `${u}-root instruments`;

  const style = document.createElement('style');
  style.textContent = styleSheet(u);
  root.appendChild(style);

  // -------------------------------------------------------------------------
  // Build the whole panel as one string and parse it once. Everything after
  // this point mutates a handful of attributes; nothing re-serialises.
  // -------------------------------------------------------------------------
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

  (container || document.body).appendChild(root);

  const $ = (id) => svgEl.querySelector(`#${u}-${id}`);

  const el = {
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

  // -------------------------------------------------------------------------
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
    const rpm = num(state.rpm);

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

    // --- nearest airport ---------------------------------------------------
    nrstTimer -= dt;
    if (nrstTimer <= 0) {
      nrstTimer = NRST_INTERVAL;
      updateNearest(state.lat, state.lon);
    }

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
      return;
    }
    const nm = n.distanceM * M_TO_NM;
    setText(el.nrst, n.airport.ident);
    setText(
      el.nrstSub,
      `${nm.toFixed(nm < 10 ? 1 : 0)} NM  ${pad3(Math.round(n.bearingDeg))}°`,
    );
  }

  function dispose() {
    root.remove();
  }

  return { update, dispose, root };
}
