/**
 * bakeStatic.js — flatten a static subtree into one mesh per material.
 *
 *   bakeStatic(root) -> THREE.BufferGeometry[]   (the merged geometries)
 *
 * WHY THIS IS SHARED. Draw calls, not triangles, are what a phone runs out of.
 * Two places in this project build an object out of dozens of small parts that
 * never move relative to each other, and both pay for it per frame:
 *
 *   - the airframe, assembled from ~80 primitives
 *   - the landmarks, 20 hand-built models totalling ~120 meshes, of which the
 *     Space Needle alone is 19 and the Tacoma Narrows Bridge another 19
 *
 * Measured at phone tier over downtown, the landmarks group cost 96 of a
 * 120-call budget for only 99k triangles — a batching problem, not a geometry
 * one. Flattening each model to one mesh per material is the fix, and
 * aircraft/model.js already had the routine; this is that routine, lifted out
 * so landmarkModels.js can use it instead of growing a second copy.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS SAFE TO BAKE
 * ---------------------------------------------------------------------------
 * Anything that never moves relative to `root`. A node with
 * `userData.animated === true`, and everything beneath it, is left alone — that
 * is how the aeroplane keeps its four control surfaces and its propeller.
 *
 * The landmarks qualify wholesale: every rotation in landmarkModels.js is set
 * once at build time, and main.js never touches the group after placing it.
 */

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

/**
 * Bake every static mesh under `root` into one mesh per material.
 *
 * Geometry is baked into `root`'s OWN frame, not world space, so the caller
 * keeps whatever transform `root` carries. (The original lived in
 * aircraft/model.js and required an identity root; landmarks are placed at
 * their real coordinates, so requiring that would have been a trap.)
 *
 * @param {THREE.Object3D} root
 * @returns {THREE.BufferGeometry[]} the merged geometries, for disposal
 */
export function bakeStatic(root) {
  root.updateMatrixWorld(true);

  // Everything is expressed relative to root, so a placed root still works.
  const toLocal = root.matrixWorld.clone().invert();

  const buckets = new Map();
  const doomed = [];

  const walk = (node, frozen) => {
    const stop = frozen || node.userData.animated === true;
    for (const child of node.children.slice()) walk(child, stop);
    if (!node.isMesh || stop || node === root) return;
    if (!node.geometry || node.isInstancedMesh) return;

    const g = node.geometry.clone();
    g.applyMatrix4(new THREE.Matrix4().multiplyMatrices(toLocal, node.matrixWorld));

    // mergeGeometries requires identical attribute sets across the bucket, so
    // drop anything exotic rather than let one stray attribute fail the merge.
    for (const name of Object.keys(g.attributes)) {
      if (name !== 'position' && name !== 'normal' && name !== 'uv') g.deleteAttribute(name);
    }
    if (!g.getAttribute('normal')) g.computeVertexNormals();
    if (!g.getAttribute('uv')) {
      g.setAttribute(
        'uv',
        new THREE.Float32BufferAttribute(new Float32Array(g.getAttribute('position').count * 2), 2),
      );
    }
    if (!g.index) {
      const n = g.getAttribute('position').count;
      g.setIndex(Array.from({ length: n }, (_, i) => i));
    }

    let bucket = buckets.get(node.material);
    if (!bucket) buckets.set(node.material, (bucket = []));
    bucket.push(g);
    doomed.push(node);
  };
  walk(root, false);

  const made = [];
  for (const [material, geos] of buckets) {
    // One mesh in a bucket is already one draw call. Merging it would cost a
    // clone and buy nothing, so leave the original in place.
    if (geos.length < 2) {
      for (const g of geos) g.dispose();
      continue;
    }
    const merged = mergeGeometries(geos, false);
    for (const g of geos) g.dispose();
    if (!merged) continue;

    const m = new THREE.Mesh(merged, material);
    m.name = `baked:${material.name || material.uuid.slice(0, 8)}`;
    m.castShadow = true;
    m.receiveShadow = true;
    root.add(m);
    made.push(merged);

    for (const node of doomed) {
      if (node.material === material) {
        node.removeFromParent();
        node.geometry.dispose();
      }
    }
  }
  return made;
}
