# Flight Sim — Round 2 Report (visual)

**2026-08-07.** 10/10 agents, 0 errors, 4.7 hours, 3.06M subagent tokens.
All committed, tree clean. Gates green: **544 assertions across 10 harnesses** (was 279/5).

## Scores vs round 1

| Lens | Round 1 | Round 2 | GeoFS |
|---|---|---|---|
| Visual | 4 | **5.5** | 8 |
| Performance / soundness | — | **7** | 7.5 |

GeoFS still wins both. The gap narrowed; it did not close.

## Did 4× resolution close the visual gap?

The critic's own answer: **"Yes, measurably — and no, it did not close the gap I identified."**

**What now genuinely wins:**
- **Near-ground inverted from round 1.** On the KBFI runway ours draws FAA asphalt with
  centreline dashes, edge lines and threshold bars; GeoFS at the identical coordinate with
  tiles confirmed loaded draws a featureless green-grey smear. Measured mean `|dLuma/dx|`
  over the bottom half of frame at 1120×720: **ours 0.936, GeoFS 0.132 — 7×.**
- **Mount Rainier at 1,800 m** now reads as a sculpted snow cone with real aerial
  perspective. GeoFS's Rainier is a flat white lump with almost no haze gradation.

**What still loses — the new biggest gap:** ground albedo at 300–2,000 ft. Ours paints the
entire lowland — city, industrial, park, suburb — in one grey-brown family with hard-edged
polygonal landcover boundaries. From the air the world has *shape* but no *content*.
GeoFS's draped imagery carries content for free. Resolution fixed the geometry; it could
not fix the paint.

## Performance — the cost was paid honestly

| Viewpoint | Median | fps |
|---|---|---|
| KBFI 32L parked | 2.6 ms | 385 |
| 300 m over Seattle | 2.7 ms | 370 |
| 400 m over downtown | 2.9 ms | 345 |
| 1,800 m, Rainier ahead | 6.8 ms | 147 |

**Never below 60 fps**, so the quality tier is a lever rather than a rescue. Shadows cost
0.7–1.2 ms. DEM peak resident **81.8 MiB against a 96 MiB cap, `capViolations: 0`**, RSS
flat across 64,081 frames on a KBFI→Rainier leg, zero NaN ground samples. The perf critic
verified this independently rather than trusting the report.

Measurement caveat the agents flagged: Chrome throttles a hidden tab's GPU after ~75
serialised renders and pins everything at ~16 ms. Six stale WebGL tabs (including GeoFS)
were contending until closed — before that the same scene measured 13 ms median.

## Elevation layer — what actually shipped

| Level | Tiles | m/px | Coverage | Residency |
|---|---|---|---|---|
| z11 | 238 | 51.8 | region | **pinned**, never evicted |
| z13 | 3,380 | 12.95 | region | paged, 30 km radius |
| z14 | 560 | 6.47 | Seattle inset | paged, 9 km radius |

4,178 tiles, 402.6 MB, baked in 63 s. `getElevation` 115 ns warm / 176 ns cold — a cold
miss falls back to the pinned base and **never blocks the flight model**.

**z15 was deliberately not baked, and that was measured, not assumed:** z13→z14 adds
0.28 m RMS of real vertical; z14→z15 adds 0.05 m, which is upsampling. The source is 3DEP
1/3 arc-second (~10 m) — there is nothing below z14 to find. 4,048 tiles to gain 5 cm would
buy a number smaller than the source's own vertical accuracy.

**The inset ledge is gone:** 0.48 m of step against 12.76 m of ordinary terrain roughness on
the same transect. Worst ground movement from a page-in on a KBFI→Rainier flight: **0.0000 m**
— prefetch beats the aircraft there.

## Two defects worth remembering

**The pager silently demoted the whole region.** It created a tile record when it *queued* a
tile, and the queue rebuild tested "does a record exist" rather than "does data exist" — so
every pass orphaned records it had just made, which ate the budget and dropped the region
back to 51.8 m/px after two viewer jumps. **Tile counts looked perfect throughout, and four
of the first five checks passed while it was live.** Now a named regression guard.

**Rainier was being drawn from the coarse base layer.** A node measures its geometric error
once at creation; bootstrap ran at the origin with only the pinned base resident, so nodes
covering Rainier were measured 84 km away against coarse data and never revisited —
26.6 m worst error. Fixed in `baf9f31`.

## No geographic regression

Re-measured on the shipped build: Rainier **4,387.4 m** (up from 4,381.7, closer to the
published 4,392 as z13 pages in) and still the local max over a 60 km box at **0.00 km
offset**. Space Needle offset **0.00 m**. KSEA 8,829 m / 185.1°, three parallel runways,
lengths exact, headings 180.34 true = 164.74 magnetic (**correctly not "fixed"**). Envelope:
rotate 57.7 kt, climb 740 fpm @ 80 kt, stall break 18.7°, landing 56.3 kt.

## Known open — KSEA 16R/34L

Finer data made this **worse, correctly.** Deck-above-DEM: 16L/34R **0.1 m**, 16C/34C 11.7 m,
16R/34L **55.7 m**. The two plateau runways being near-perfect is the strongest available
evidence the georeferencing and vertical datum are right. 16R/34L is the 2008 third runway,
crossing Miller Creek on a man-made MSE retaining wall that 3DEP's *bare-earth* terrain does
not contain — so better data resolves the real ravine the coarse data was smoothing over.
The agent refused to fake fill in the DEM. The fix is to skirt the runway deck down to
terrain, drawing the retaining wall that physically exists.

## Round 3 recommendation

**Ground albedo at altitude** — the critic's named gap. The landcover classes are right but
render as flat polygons with hard edges. Wanted: per-class texture variation, dithered or
noise-blended class boundaries, and parcel-scale variety so the lowland reads as content
rather than as a choropleth map. That is the whole remaining visual delta.

Secondary: the perf critic found the **drawn runway sits 0.83 m above the collision surface**
at the KBFI 32L spawn — a metre-scale error on frame 0 with every gate green. Partly
addressed in `be809cb`; worth a dedicated assertion so it can't come back.
