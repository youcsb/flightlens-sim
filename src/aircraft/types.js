/**
 * types.js — the aircraft register: which aeroplanes exist and how to build one.
 *
 * This is the single place that knows an aeroplane is a THREE things joined:
 * a physics airframe (physics/airframes/*.js), a visual model
 * (aircraft/*model.js), and the handful of choices that only make sense once
 * you have both — how fast to spawn it in the air, what its engine gauge reads.
 *
 * Adding a third aircraft is an entry in AIRCRAFT_TYPES and nothing else. Every
 * consumer looks the type up by id; nothing in main.js, the overlay or the
 * instruments names a specific aeroplane.
 *
 * THE CESSNA IS THE DEFAULT AND STAYS THE DEFAULT. `DEFAULT_TYPE_ID` is the
 * one the simulator boots into, and every fallback path in here resolves to it:
 * an unknown id, a corrupt saved preference, a URL with nonsense in it. Being
 * unable to start is a much worse failure than starting in the wrong aeroplane.
 */

import * as THREE from 'three';
import { C172 } from '../physics/airframes/c172.js';
import { B738 } from '../physics/airframes/b738.js';
import { createAircraft } from './model.js';
import { createB738 } from './b738model.js';

/**
 * @typedef {Object} AircraftType
 * @property {string} id            stable key; goes in the URL and localStorage
 * @property {string} name          for the picker
 * @property {string} sub           one line under the name
 * @property {Object} airframe      the physics airframe, for createFlightModel
 * @property {Function} createModel (scene, opts) -> the visual model
 * @property {number|null} airborneSpeedMs
 *           Overrides a place's spawn speed when spawning in the air. See below.
 * @property {number} minRunwayM    shortest runway this type should be put on
 * @property {string} registration  what is painted on the side
 */

/** @type {AircraftType[]} */
export const AIRCRAFT_TYPES = [
  {
    id: 'c172',
    name: 'Cessna 172',
    sub: 'high wing · 180 hp · 126 kt',
    airframe: C172,
    createModel: (scene, opts) => createAircraft(scene, opts),
    /**
     * Null: use whatever speed the place itself asks for. The PLACES table was
     * written around this aeroplane, so its numbers are already this
     * aeroplane's numbers.
     */
    airborneSpeedMs: null,
    minRunwayM: 400,
    registration: 'N172KA',
    /**
     * Camera framing. The rig's constants were measured against this
     * aeroplane, so its scale is 1 and its eye positions are the defaults —
     * passing them explicitly anyway keeps the two types comparable and makes
     * it obvious that the 737's are not scaled-up versions of these.
     */
    camera: {
      scale: 1,
      eye: new THREE.Vector3(0, 0.76, -0.86),
      panelEye: new THREE.Vector3(0, 0.70, -0.95),
    },
  },
  {
    id: 'b738',
    name: 'Boeing 737-800',
    sub: 'swept wing · 2 x CFM56 · M0.78',
    airframe: B738,
    createModel: (scene, opts) => createB738(scene, opts),
    /**
     * 128 m/s = 250 kt, and this override is not a nicety.
     *
     * The airborne places spawn at 100-105 kt because that is a sensible
     * Cessna cruise. A 737 stalls at 143 kt clean. Spawning one at 100 kt does
     * not produce a slow jet — it produces an aeroplane that is already below
     * its stalling speed at the instant it appears, drops a wing, and is in a
     * spiral before the loading toast has faded. 250 kt is a normal
     * below-10,000-ft speed and leaves a wide margin above the stall.
     *
     * A type whose comfortable speed matches the table leaves this null.
     */
    airborneSpeedMs: 128,
    /**
     * Both scenery airports clear this easily — KBFI 32L is 3,048 m and KSEA
     * 16C is 3,627 m, against a measured 1,772 m ground roll. It is stated so
     * that adding a bush strip later fails loudly rather than parking an
     * airliner on 600 m of gravel.
     */
    minRunwayM: 2200,
    registration: 'N738KA',
    /**
     * 2.7x the Cessna's boom — the ratio of the two lengths, 39.5 m to 8.3 m,
     * rounded down a little so the aeroplane still fills the frame.
     *
     * This is not a polish item. At scale 1 the 14.5 m chase boom puts the
     * camera INSIDE a 39.5 m fuselage; the first time the jet was flown the
     * view was from somewhere around the wing box, which reads as a broken
     * camera rather than as an assumption about aeroplane size.
     *
     * The eye positions are STATED, not scaled. A 737's flight deck is 17.5 m
     * forward of the CG and 1.5 m above it; scaling a Cessna's (0, 0.76,
     * -0.86) by 2.7 would put the pilot at -2.3 m, which on this aeroplane is
     * inside the forward cargo hold.
     */
    camera: {
      scale: 2.7,
      eye: new THREE.Vector3(0, 1.45, -17.3),
      panelEye: new THREE.Vector3(0, 1.38, -17.4),
    },
  },
];

export const DEFAULT_TYPE_ID = 'c172';

/** Look a type up by id, falling back to the default rather than throwing. */
export function getAircraftType(id) {
  for (const t of AIRCRAFT_TYPES) if (t.id === id) return t;
  return AIRCRAFT_TYPES.find((t) => t.id === DEFAULT_TYPE_ID) || AIRCRAFT_TYPES[0];
}

/** The id after this one, wrapping. Drives the cycle key. */
export function nextAircraftId(id) {
  const i = AIRCRAFT_TYPES.findIndex((t) => t.id === id);
  return AIRCRAFT_TYPES[(i < 0 ? 0 : i + 1) % AIRCRAFT_TYPES.length].id;
}

/**
 * Apply a type's spawn preferences to a resolved place.
 *
 * Takes the `{lat, lon, headingDeg, placement}` a place resolves to and returns
 * the same shape with the placement adjusted. Only the AIRBORNE speed is
 * touched: a ground spawn is a ground spawn for anything with wheels, and the
 * heading and coordinates belong to the place, not to the aeroplane.
 *
 * @param {AircraftType} type
 * @param {{lat:number, lon:number, headingDeg:number, placement?:Object}} r
 */
export function applySpawnFor(type, r) {
  const p = r.placement;
  // A ground spawn has no placement, or a placement with no altitude in it.
  const airborne =
    !!p && (Number.isFinite(p.altitudeAglM) || Number.isFinite(p.altitudeMslM));
  if (!airborne || type.airborneSpeedMs == null) return r;
  return { ...r, placement: { ...p, airspeedMs: type.airborneSpeedMs } };
}

/**
 * Throttle to hand the input module at spawn, 0..1.
 *
 * A place says what a Cessna wants. A jet at the same place needs more, because
 * a turbofan at 70% of its spool is producing a fraction of its thrust and
 * because the aeroplane is 64 times heavier. Airborne: enough to hold the
 * speed. On the ground: whatever the place said, which is idle.
 */
export function spawnThrottleFor(type, place, r) {
  const p = r.placement;
  const airborne =
    !!p && (Number.isFinite(p.altitudeAglM) || Number.isFinite(p.altitudeMslM));
  const base = place.throttle ?? 0;
  if (!airborne || type.id !== 'b738') return base;
  return Math.max(base, 0.8);
}
