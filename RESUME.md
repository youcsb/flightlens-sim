# RESUME — Ken Flight Sim

Integrated and flying. Last updated **2026-08-06**.

## Goal

ThreeJS flight simulator over **real Puget Sound geography**, judged by blind A/B
against **GeoFS**. Real terrain shape, real airport positions, real landmark
coordinates — procedural surface colour, no satellite imagery.

## Reaching the bar (GeoFS)

- URL is `https://www.geo-fs.com/geofs.php?v=3.9` — **not** `geofs.com` (bad TLS cert).
- **Wait 60+ seconds** before screenshotting; viewport is black until tiles stream.
- Ignore the "Privacy Shield / Download extension" ad panel — not part of GeoFS.

## Environment

```bash
export PATH="$HOME/.local/node/bin:$PATH"   # node v24.19.0, NOT on default PATH
npm run dev        # http://localhost:5173
npm run check:all  # 231 assertions across four harnesses
```

No Homebrew. Vite + three already installed — do **not** run `npm install`.

## State

| Gate | Result |
|---|---|
| `npm run build` | green |
| `scripts/check-contract.mjs` | 36 assertions, green |
| `scripts/flight-envelope.mjs` | 74 assertions, green |
| `scripts/check-instruments.mjs` | 58 assertions, green |
| `scripts/check-aircraft.mjs` | 63 assertions, green |
| Renders, flies, stalls, lands | verified in a browser |
| Console at boot | clean — the warnings are honest provenance reports, no errors |

## Verified in the browser, not assumed

- **Space Needle** at 47.6204/−122.3491, placement offset 0.00 m, mesh 184.57 m
  tall on a 40.67 m DEM base, 42.4 m saucer. Correct silhouette.
- **Mount Rainier** 4,381.7 m at its published coordinate — and that is the local
  maximum over a 60 km box, so the summit is not merely near the right place.
  Radial profile symmetric to ~100 m at 2 km in all four compass directions.
  Reads as a snow-capped cone above the haze at 94 km.
- **KSEA** 8,829 m from KBFI on bearing 185.1°; three parallel north–south
  runways; lengths match published exactly.
- **Takeoff** under keyboard control: centreline holdable to ±2°, rotates at
  58 kt, climbs ~600 fpm.
- **Stall** breaks at α ≈ 23°, the nose drops, and full aft stick will not
  recover it; releasing the stick recovers cleanly.
- **Landing** 54 kt, wings level, 212 m rollout, resting 11 cm into the gear
  springs — i.e. the wheels sit exactly on the drawn surface.

## Known open issue — RESOLVED, and the original diagnosis was wrong

~~KSEA's three runways are ~4.5° off.~~ **This was a misdiagnosis. Do not "fix" it.**

Runway designators are **magnetic**, not true. KSEA's runways genuinely run ~180.34°
true, which is 164.74° magnetic — and 164.74 rounds to the "16/34" designator. The
180.000° figure was never an error.

Verified by measurement, with `OVERRIDES` populated and all three runways carrying
`geometry: 'override'`:

| Runway | True | Magnetic | Length computed | Published |
|---|---|---|---|---|
| 16L/34R | 180.344° | 164.74° | 11,900 ft | 11,901 |
| 16C/34C | 180.341° | 164.74° | 9,425 ft | 9,426 |
| 16R/34L | 180.336° | 164.74° | 8,500 ft | 8,500 |

Centreline separations: 799 / 1,697 / 2,496 ft against published 800 / 1,700 / 2,500.

Anyone who reads "the runways should be ~160/340 true" is reading a stale brief that
confused the magnetic designator for a true heading. Changing it would introduce a real
16° error where none exists.

## Known gaps (honest)

1. **Downtown buildings are procedural blocks.** The skyline cluster, the city
   footprint and the stadiums are in the right places; individual buildings are
   not real. Permitted by §1.5, but it is the weakest thing in a low pass over
   the city and the most likely place to lose a blind A/B.
2. **KSEA 16R/34L rides a 12.9 m hump.** Its 2004–08 embankment is not in the
   DEM. The deck now bends to stay flush rather than breaking in half, but the
   ground under it is still wrong. The real fix is elevation data, not geometry.
3. **The windscreen still reads slightly milky** from inside after the
   opacity/reflection reduction; the remainder is the clearcoat sheen.
4. **No shadows.** A 144 km world needs cascaded shadow maps; nothing casts.
5. **No GeoFS A/B has been run.** Out of scope for this pass.
6. `elevation.js` reports `minElevationM = −497.8` — one void sitting just inside
   the −500 m plausibility band survived repair.
7. `bake-landmarks.mjs` has Mount Si at 47.5076/−121.7400; the summit is ~2.4 km
   SSE. The runtime warns rather than snapping, because the nearest summit is
   Mount Teneriffe, not Si.
8. `bake-airports.mjs` still labels 14 axis-aligned rounding artifacts
   `override`/`surveyed`; the runtime demotes them to `synthesised`, but the
   baker should not emit the claim.

## Note on testing this in a hidden tab

The browser suspends `requestAnimationFrame` **entirely** when the tab is not
visible, and throttles `setInterval` to ~1 Hz. A frozen aeroplane in that state
is the harness, not a bug. `window.sim.tick(dt, n)` runs the real loop with a
chosen delta and is the way to drive the sim.

Screenshots of the browser pane can also serve a stale composite that does not
match what the GPU drew. Rendering into a `WebGLRenderTarget` and reading the
pixels back is what actually reflects the frame — set
`rt.texture.colorSpace = SRGBColorSpace` on the target or the readback is dark,
because the sRGB conversion the canvas path applies is skipped.
