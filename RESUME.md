# RESUME — Ken Flight Sim

Paused **2026-08-06 09:28 PDT** mid-Build to conserve session usage.
Everything below is committed at `a4720d8`. Nothing is lost.

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
```
No Homebrew. Vite + three already installed. `npm run build` and
`node scripts/check-contract.mjs` (36 assertions) both pass.

## Done

| Phase | State |
|---|---|
| Scaffold | ✅ `MODULES.md` contract, 36 contract assertions |
| GeoCore | ✅ 378 DEM tiles (z11 region + z13 Seattle inset), 38.9 MB |
| Build | ⚠️ all 8 files written and syntax-valid; only `controls` formally returned |

**Verified ground truth:** Mount Rainier 4,381.7 m (published 4,392, −0.21%),
Puget Sound 0.0 m, Space Needle 47.6204/−122.3491, 107 airports, 24 landmarks.

**Fixed along the way:** 3,652 DEM void pixels repaired (a −14,492 m spike, a
−2,437 m blob on the KSEA approach); fog density that would have hidden Rainier at
84 km; camera far plane 60 km → 300 km with logarithmic depth; runway headings
recomputed from thresholds because OurAirports' "true" heading field is often magnetic.

## Remaining

1. **Verify the 7 builders that never formally returned** — files are syntax-valid but
   may hold TODOs or unimplemented paths: terrain, airports, landmarks, sky, aircraft,
   physics, instruments.
2. **Integrate** — wire `src/main.js`, reconcile interface drift, run the dev server,
   fix until it renders, takes off, stalls, and lands with a clean console.
3. **Critique** — three harsh critics: blind visual A/B vs GeoFS, flight model,
   geographic accuracy.
4. **Fix** — close the two worst gaps.

## Known open issue

**KSEA's three runways are ~4.5° off.** OurAirports publishes identical threshold
longitudes for all three, yielding exactly 180.000°. The overrides table was left
empty rather than faking it — needs real threshold coordinates. This bears directly
on the "airports in the right spot" requirement.

## Note for whoever resumes

The original workflow run IDs (`wf_d3b1619b-13a`) can only be resumed **in the session
that created them**. From a new session, start a fresh workflow covering the Remaining
list above — all prior work is on disk and in git, so nothing needs redoing.
