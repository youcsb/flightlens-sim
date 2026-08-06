/**
 * model.js — the visual aircraft: geometry, control-surface animation, prop.
 *
 * STUB IMPLEMENTATION. A blocky low-wing single-engine shape built from boxes.
 * Replace the internals; do not change the exported signature.
 *
 * Contract: see MODULES.md § aircraft model
 *
 *   createAircraft(scene) -> { group, setControlSurfaces({pitch,roll,yaw}), spinProp(rpm, dt) }
 *
 * BODY AXES (local space of `group`) — every subsystem must agree on this:
 *   -Z = nose / forward       +Z = tail
 *   +X = right wing           -X = left wing
 *   +Y = up (canopy)          -Y = down (landing gear)
 *
 * This module is PURELY COSMETIC. It never moves `group` itself — main.js
 * writes position and orientation onto the group from the flight model.
 */

import * as THREE from 'three';
import { clamp } from '../core/units.js';

/** Max visual deflection of each surface, in radians. */
const MAX_ELEVATOR = 0.42;
const MAX_AILERON = 0.42;
const MAX_RUDDER = 0.5;

/**
 * @param {THREE.Scene} scene
 * @returns {{ group: THREE.Group, setControlSurfaces: (c: {pitch?: number, roll?: number, yaw?: number}) => void, spinProp: (rpm: number, dt: number) => void }}
 */
export function createAircraft(scene) {
  const group = new THREE.Group();
  group.name = 'aircraft';

  const bodyMat = new THREE.MeshLambertMaterial({ color: 0xdfe4ea });
  const trimMat = new THREE.MeshLambertMaterial({ color: 0xc0392b });
  const darkMat = new THREE.MeshLambertMaterial({ color: 0x2c3038 });

  // --- fuselage -----------------------------------------------------------
  const fuselage = new THREE.Mesh(new THREE.BoxGeometry(1.1, 1.2, 7.2), bodyMat);
  fuselage.position.set(0, 0, 0.4);
  fuselage.castShadow = true;
  group.add(fuselage);

  const nose = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.9, 1.4), darkMat);
  nose.position.set(0, 0, -3.5);
  group.add(nose);

  // --- main wing ----------------------------------------------------------
  const wing = new THREE.Mesh(new THREE.BoxGeometry(11, 0.22, 1.7), bodyMat);
  wing.position.set(0, -0.35, -0.2);
  wing.castShadow = true;
  group.add(wing);

  // --- ailerons (roll) ----------------------------------------------------
  // Hinged at the trailing edge of each wing; pivot sits at the hinge line.
  const aileronGeo = new THREE.BoxGeometry(2.6, 0.16, 0.5);
  aileronGeo.translate(0, 0, 0.25); // move mass aft of the pivot

  const aileronL = new THREE.Mesh(aileronGeo, trimMat);
  aileronL.position.set(-3.6, -0.35, 0.65);
  group.add(aileronL);

  const aileronR = new THREE.Mesh(aileronGeo.clone(), trimMat);
  aileronR.position.set(3.6, -0.35, 0.65);
  group.add(aileronR);

  // --- horizontal stabiliser + elevator (pitch) ---------------------------
  const hstab = new THREE.Mesh(new THREE.BoxGeometry(4.2, 0.18, 1.0), bodyMat);
  hstab.position.set(0, 0.15, 3.4);
  group.add(hstab);

  const elevatorGeo = new THREE.BoxGeometry(4.2, 0.14, 0.6);
  elevatorGeo.translate(0, 0, 0.3);
  const elevator = new THREE.Mesh(elevatorGeo, trimMat);
  elevator.position.set(0, 0.15, 3.9);
  group.add(elevator);

  // --- vertical stabiliser + rudder (yaw) ---------------------------------
  const vstab = new THREE.Mesh(new THREE.BoxGeometry(0.16, 1.6, 1.2), bodyMat);
  vstab.position.set(0, 0.9, 3.4);
  group.add(vstab);

  const rudderGeo = new THREE.BoxGeometry(0.14, 1.4, 0.6);
  rudderGeo.translate(0, 0, 0.3);
  const rudder = new THREE.Mesh(rudderGeo, trimMat);
  rudder.position.set(0, 0.9, 4.0);
  group.add(rudder);

  // --- propeller ----------------------------------------------------------
  const prop = new THREE.Group();
  prop.name = 'propeller';
  prop.position.set(0, 0, -4.25);
  const bladeGeo = new THREE.BoxGeometry(0.16, 3.0, 0.06);
  const bladeA = new THREE.Mesh(bladeGeo, darkMat);
  const bladeB = new THREE.Mesh(bladeGeo.clone(), darkMat);
  bladeB.rotation.z = Math.PI / 2;
  prop.add(bladeA, bladeB);
  const spinner = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.3, 0.5), trimMat);
  prop.add(spinner);
  group.add(prop);

  scene.add(group);

  /**
   * Animate the control surfaces. Cosmetic only — this has no effect on physics.
   * Inputs are normalised stick deflections, NOT angles.
   *
   * @param {{pitch?: number, roll?: number, yaw?: number}} c
   *        pitch -1..+1 (+1 = stick back / nose up / elevator trailing edge up)
   *        roll  -1..+1 (+1 = stick right / right roll)
   *        yaw   -1..+1 (+1 = right rudder)
   */
  function setControlSurfaces(c = {}) {
    const pitch = clamp(c.pitch ?? 0, -1, 1);
    const roll = clamp(c.roll ?? 0, -1, 1);
    const yaw = clamp(c.yaw ?? 0, -1, 1);

    // Stick back -> elevator trailing edge rises -> rotate nose-down about +X.
    elevator.rotation.x = -pitch * MAX_ELEVATOR;

    // Ailerons move in opposition.
    aileronL.rotation.x = -roll * MAX_AILERON;
    aileronR.rotation.x = roll * MAX_AILERON;

    // Right rudder swings the trailing edge right.
    rudder.rotation.y = -yaw * MAX_RUDDER;
  }

  /**
   * Advance the propeller.
   *
   * @param {number} rpm Revolutions per minute (engine/prop shaft).
   * @param {number} dt  Frame delta in SECONDS.
   */
  function spinProp(rpm, dt) {
    if (!Number.isFinite(rpm) || !Number.isFinite(dt)) return;
    prop.rotation.z += (rpm / 60) * Math.PI * 2 * dt;
  }

  setControlSurfaces({ pitch: 0, roll: 0, yaw: 0 });

  return { group, setControlSurfaces, spinProp };
}
