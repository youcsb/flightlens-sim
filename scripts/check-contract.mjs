/**
 * check-contract.mjs — executable form of the geometric half of MODULES.md.
 *
 *   npm run check
 *
 * Eight agents edit this codebase in parallel. Prose in MODULES.md cannot stop
 * someone flipping a sign in the projection, and a flipped sign is invisible
 * until an airport turns up in the wrong hemisphere. These assertions are the
 * part of the contract a machine can enforce.
 *
 * It imports src/geo/coords.js directly — that module is pure maths with no
 * three.js and no DOM, so Node can run it unmodified. Keep it that way.
 *
 * The expected values are not invented. Every one was measured against a live
 * source before the scaffold was written:
 *   - runway endpoints from OurAirports runways.csv
 *   - landmark coordinates from a Wikidata SPARQL query
 *   - tile indices and counts from the AWS Terrarium endpoint
 * If a check fails, assume the CODE changed, not that the world did.
 */

import * as C from '../src/geo/coords.js';

let failures = 0;
const ok = (name, cond, note = '') => {
  if (cond) {
    console.log(`  ok   ${name}${note ? `  (${note})` : ''}`);
  } else {
    failures++;
    console.log(`  FAIL ${name}${note ? `  (${note})` : ''}`);
  }
};
const close = (a, b, tol) => Math.abs(a - b) <= tol;

// Verified reference points.
const KBFI_14R = [47.540549, -122.311372];
const KBFI_32L = [47.516745, -122.291252];
const SPACE_NEEDLE = [47.6204, -122.3491];
const MT_RAINIER = [46.8517, -121.7603];

console.log('\nprojection');
{
  const o = C.getOrigin();
  ok('default origin is KBFI ARP', close(o.lat, 47.527042, 1e-9) && close(o.lon, -122.29995, 1e-9));
  ok('origin maps to (0, 0)', (() => { const p = C.llToLocal(o.lat, o.lon); return close(p.x, 0, 1e-9) && close(p.z, 0, 1e-9); })());

  for (const [lat, lon] of [SPACE_NEEDLE, MT_RAINIER, [48.3, -123.4], [46.4, -121.2]]) {
    const p = C.llToLocal(lat, lon);
    const q = C.localToLl(p.x, p.z);
    ok(`round trip ${lat}, ${lon}`, close(q.lat, lat, 1e-9) && close(q.lon, lon, 1e-9));
  }

  // §1.2: +X east, -Z north. A sign flip here breaks everything downstream.
  const n = C.llToLocal(o.lat + 0.1, o.lon);
  const e = C.llToLocal(o.lat, o.lon + 0.1);
  ok('north is -Z', n.z < 0 && close(n.x, 0, 1e-9), `z = ${n.z.toFixed(0)} m`);
  ok('east is +X', e.x > 0 && close(e.z, 0, 1e-9), `x = ${e.x.toFixed(0)} m`);

  // §1.3: moving the origin translates the world, it must not rescale it.
  const scaleBefore = C.getScale();
  const distBefore = C.distanceBetween(...SPACE_NEEDLE, ...MT_RAINIER);
  C.setOrigin(47.447943, -122.310276); // KSEA
  const scaleAfter = C.getScale();
  const distAfter = C.distanceBetween(...SPACE_NEEDLE, ...MT_RAINIER);
  ok(
    'setOrigin translates but does not rescale',
    close(scaleBefore.lat, scaleAfter.lat, 1e-9) &&
      close(scaleBefore.lon, scaleAfter.lon, 1e-9) &&
      close(distBefore, distAfter, 1e-6),
    `${(distBefore / 1000).toFixed(3)} km unchanged`,
  );
  ok('new origin maps to (0, 0)', (() => { const p = C.llToLocal(47.447943, -122.310276); return close(p.x, 0, 1e-9) && close(p.z, 0, 1e-9); })());
  C.setOrigin(C.DEFAULT_ORIGIN.lat, C.DEFAULT_ORIGIN.lon);

  const err = Math.max(
    ...[C.REGION_BBOX.south, C.REGION_BBOX.north].map((la) =>
      Math.abs(C.metresPerDegreeLon(la) / C.metresPerDegreeLon(C.SCALE_LAT) - 1),
    ),
  );
  ok('edge scale error within the documented 1.9%', err <= 0.019, `${(err * 100).toFixed(2)}%`);
}

console.log('\nheadings');
{
  for (const h of [0, 45, 90, 180, 270, 330.13]) {
    const v = C.headingToVector(h);
    const back = C.vectorToHeading(v.x, v.z);
    ok(`bearing ${h} round trips`, close(((back - h) % 360 + 360) % 360, 0, 1e-9));
  }
  ok('heading 0 points -Z (north)', close(C.headingToVector(0).z, -1, 1e-12));
  ok('heading 90 points +X (east)', close(C.headingToVector(90).x, 1, 1e-12));

  // The runway ribbon in geo/airports.js is yawed by -headingDeg. Rotating the
  // unrotated ribbon direction (0, -1) about +Y by -h must land exactly on
  // headingToVector(h), or every runway is drawn at the wrong angle.
  for (const h of [0, 45, 150.13, 330.13]) {
    const phi = (-h * Math.PI) / 180;
    const x = -Math.sin(phi);
    const z = -Math.cos(phi);
    const want = C.headingToVector(h);
    ok(`runway ribbon yaw ${h}`, close(x, want.x, 1e-12) && close(z, want.z, 1e-12));
  }
}

console.log('\nspawn geometry (KBFI 32L)');
{
  const hdg = C.bearingBetween(...KBFI_14R, ...KBFI_32L);
  const lenFt = C.distanceBetween(...KBFI_14R, ...KBFI_32L) * 3.280839895;
  ok('14R -> 32L heading ~150.1 true, not the published 140', close(hdg, 150.13, 0.05), hdg.toFixed(2));
  ok('length within 0.5% of the published 10007 ft', Math.abs(lenFt - 10007) / 10007 < 0.005, `${lenFt.toFixed(0)} ft`);

  const takeoff = (hdg + 180) % 360;
  const bSN = C.bearingBetween(...KBFI_32L, ...SPACE_NEEDLE);
  const dSN = C.distanceBetween(...KBFI_32L, ...SPACE_NEEDLE);
  const bMR = C.bearingBetween(...KBFI_32L, ...MT_RAINIER);
  const dMR = C.distanceBetween(...KBFI_32L, ...MT_RAINIER);

  ok('Space Needle within 10 deg of the nose on climb-out', Math.abs(bSN - takeoff) < 10, `${(bSN - takeoff).toFixed(1)} deg off, ${(dSN / 1000).toFixed(1)} km`);
  ok('Mount Rainier within 2 deg of the reciprocal', Math.abs(bMR - hdg) < 2, `${(bMR - hdg).toFixed(1)} deg off, ${(dMR / 1000).toFixed(1)} km`);
  ok('terrain viewRadius 90 km reaches Rainier', dMR < 90000, `${(dMR / 1000).toFixed(1)} km`);
  ok('camera FAR 300 km reaches Rainier', dMR < 300000);
}

console.log('\nDEM tiles');
{
  const t = C.tileXY(...MT_RAINIER, 11);
  ok('Rainier is in tile 11/331/721', t.x === 331 && t.y === 721, `${t.x}/${t.y}`);
  const b = C.tileBounds(331, 721, 11);
  ok('that tile really contains Rainier', MT_RAINIER[0] >= b.south && MT_RAINIER[0] <= b.north && MT_RAINIER[1] >= b.west && MT_RAINIER[1] <= b.east);
  const r = C.tileRange(C.REGION_BBOX, 11);
  ok('region at z11 is 238 tiles', r.count === 238, `${r.count}`);
  ok('Seattle inset at z13 is under 200 tiles', C.tileRange({ south: 47.35, north: 47.75, west: -122.5, east: -122.1 }, 13).count < 200);
  ok('z11 ground resolution ~52 m/px', close(C.metresPerPixel(47.35, 11), 51.8, 0.5), `${C.metresPerPixel(47.35, 11).toFixed(1)} m`);
}

console.log('\nlandmark bbox guard');
{
  // §2.6: these four are exactly the cases that separate a working filter from
  // one that ships an Eiffel Tower in Texas.
  ok('Space Needle is in region', C.inBbox(...SPACE_NEEDLE, C.REGION_BBOX));
  ok('Mount Rainier is in region', C.inBbox(...MT_RAINIER, C.REGION_BBOX));
  ok('the Maryland "Mount Rainier" is rejected', !C.inBbox(38.9417, -76.9636, C.REGION_BBOX));
  ok('the Mount Baker VOLCANO is outside the region', !C.inBbox(48.7773, -121.8132, C.REGION_BBOX));
  ok('the Seattle "Mount Baker" neighbourhood is INSIDE it — bbox alone is not enough, resolve by Q-ID', C.inBbox(47.5766, -122.2977, C.REGION_BBOX));
}

console.log(
  failures ? `\n${failures} check(s) FAILED\n` : '\nall contract checks passed\n',
);
process.exit(failures ? 1 : 0);
