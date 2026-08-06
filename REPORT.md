# Flight Sim — Round 1 Report

**2026-08-06.** Workflow complete: 9/9 agents, 0 errors, ~2 hours, 1.13M subagent tokens.
All work committed, tree clean, every gate green.

## Run it

```bash
export PATH="$HOME/.local/node/bin:$PATH"
npm run dev        # http://localhost:5173
```

**Controls.** Note pitch follows real-yoke convention — `S` pulls back for nose UP.

| | |
|---|---|
| `W` / `↑` · `S` / `↓` | nose down · nose **up** |
| `A` / `←` · `D` / `→` | roll left · right |
| `Q` · `E` | yaw left · right |
| `Shift` · `Control` | throttle up · down — **hold, don't tap** (0.42/sec, ~2.4s idle→full) |
| `Z` · `X` | full throttle · idle |
| `F` · `B` · `G` | flaps · brakes (hold) · gear |
| `C` · `R` · `V` | cycle camera · reset · panel view |

Spawns on KBFI runway 32L. Rotate around 58 kt.

## The verdicts — GeoFS won all three

| Lens | Ours | GeoFS | Winner |
|---|---|---|---|
| Visual | 4 | 8 | reference |
| Flight model | 6 | 7.5 | reference |
| Geographic accuracy | 6.5 | 8 | reference |

This is the expected round-1 outcome, not a failure. The critics were instructed to
default to "reference wins" and treat a tie as a loss. What they produced is a specific
gap list, which is the actual product of the round.

**Ours won on:** runway markings and instrument craft.
**Ours lost on:** sky/atmosphere, aircraft model, cockpit interior, shadows, airport
surroundings.

The visual critic did real work to earn that 4: it drove GeoFS's render loop manually
after finding it dead, confirmed `tilesLoaded` went true before judging, and flagged that
its downtown frame had buildings force-enabled so it wasn't GeoFS out-of-the-box. It also
explicitly refused to score the cockpit-vs-cockpit comparison because GeoFS's cockpit
camera threw — marked UNMADE rather than guessed.

## What the two fixes changed

**Land cover (the visual gap).** The terrain shader knew only height and slope, so
everything below the treeline was one flat olive-green — no height test can separate
downtown from farmland from parkland when all three are flat and near sea level. Now bakes
**NLCD 2021 land cover** (USGS, 30 m) plus **TIGER/Line road centrelines** into
`public/landcover/` — 81 m/texel over the region, 20 m over the Seattle inset — with
per-class near-field structure at real Seattle block pitch (96×128 m). Mount Rainier now
reads as a white cone rather than a grey nub, because NLCD's perennial-ice class is OR-ed
into the snow term. Overpass was re-probed, returned 504 again, so roads came from TIGERweb.

**Solid terrain and a crash state (the physics gap).** The critic flew level at 119 kt into
a 500 m vertical wall and the aircraft *teleported* 498 m upward keeping all its speed.
Now: four ground samples instead of one (so the aircraft can sit on a slope), gear that
rejects penetration past its 0.40 m stroke instead of acting as a 500 m spring, contact
forces resolved in the surface frame, and a real `state.crashed` latch.

## Verified real, not assumed

- **Space Needle** at 47.6204/−122.3491, placement offset **0.00 m**, mesh 184.57 m
- **Mount Rainier** 4,381.7 m at its published coordinate — and it's the local maximum
  over a 60 km box, so the summit is genuinely in the right place
- **KSEA** 8,829 m from KBFI on bearing 185.1°, three parallel runways, lengths matching
  published exactly
- **Flight**: rotates 58 kt, climbs ~600 fpm, stall breaks at α≈23° with full aft stick
  unable to recover, lands at 54 kt with 212 m rollout resting 11 cm into the gear springs

Gates: `npm run build` green, `npm run check:all` = 279 assertions across five harnesses.

## Biggest remaining gaps (round 2 candidates)

1. **Downtown building footprints are invented.** Skyline cluster and stadiums are
   correctly placed; individual buildings are not real. Likeliest place to lose the A/B.
2. **No shadows.** A 144 km world needs cascaded shadow maps; nothing casts.
3. **Terrain resolution is 51.8 m/px over ~95% of the region.** The z13 inset covers only
   ~44×30 km around Seattle — everything you actually fly toward (Rainier, the Olympics,
   the Cascade front) is served at z11, and the mesh interpolates a grid 6.5× coarser than
   it draws. GeoFS serves ~10 m Cesium World Terrain.
4. **KSEA's vertical geometry is off by up to 23 m**; 16R/34L rides a 12.9 m hump whose
   embankment isn't in the DEM.
5. **Cockpit interior** — was broken, partly fixed during integration, still weak.
6. **18% of runways (20 of 113) carry fabricated endpoints** derived from the runway
   number rather than surveyed coordinates.

## Two harness facts worth knowing

- The browser **suspends rAF entirely** when the tab is hidden and throttles `setInterval`
  to ~1 Hz. A frozen aeroplane in that state is the harness, not a bug — drive it with
  `window.sim.tick(dt, n)`.
- **Browser-pane screenshots can serve a stale composite** that doesn't match what the GPU
  drew. The integrator confirmed via `gl.readPixels` that the Space Needle was rendering
  correctly at a pixel the pane showed as empty sky. Judge from `WebGLRenderTarget`
  readbacks, and set `rt.texture.colorSpace = SRGBColorSpace` or the readback comes out dark.

## One correction carried forward

The "KSEA runways are ~4.5° off" issue I flagged twice **was my error**. Runway designators
are magnetic, not true: KSEA runs ~180.34° true = 164.74° magnetic, which rounds to "16/34".
It was never broken. Both the critic prompt and RESUME.md now warn against "fixing" it.
