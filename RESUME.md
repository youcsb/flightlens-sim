# RESUME — Ken Flight Sim

Paused **2026-08-07** for a machine restart. **Everything is committed; the working
tree is clean and both gates are green.** Nothing is lost.

## Restart here

```bash
cd "/Users/KenAltmann/Desktop/Ken Flight Sim"
export PATH="$HOME/.local/node/bin:$PATH"   # node v24.19.0 is NOT on the default PATH
npm run dev                                  # http://localhost:5173
```

No servers are running — they were stopped to free the machine. `npm run build`
and `npm run check:all` (573 assertions across 12 harnesses) both pass at HEAD.

**Do not run `npm install`.** No Homebrew on this machine.

## Controls

| Key | |
|---|---|
| `W`/`↑` · `S`/`↓` | nose down · nose **up** (real-yoke convention) |
| `A`/`D` · `Q`/`E` | roll · rudder |
| `Shift`/`Ctrl` | throttle — **hold, don't tap** (0.42/sec) |
| `Z` · `X` | full power · idle |
| `L` · `[` `]` · `Y` · `U`/`J` | autopilot · heading bug · sync bug · altitude bug |
| `F` · `B` · `G` · `C` · `R` · `V` | flaps · brakes · gear · camera · reset · panel view |

**Takeoff veers left on purpose** — propwash over the fin yaws ~2.5°/s left under
power. Hold `E` (right rudder) during the roll. Every single-engine prop does this.

`?tier=desktop` or `?tier=phone` on the URL forces a device tier.

## Where things stand

**Done and verified:**
- Real Puget Sound geography: 4,178 DEM tiles (z11 region + z13/z14 Seattle),
  Rainier 4,387.4 m and the local max over a 60 km box, Space Needle offset 0.00 m,
  KSEA runways exact. 23,979 real building footprints.
- Round 1 and round 2 reports: `REPORT.md`, `REPORT2.md`. Blind A/B vs GeoFS:
  visual 4 → 5.5 (GeoFS 8), physics 6, geography 6.5.
- **Autopilot** — heading + altitude hold. Took three passes; the cause was a
  vertical gain so low the loop could not correct (`K_VS_TO_PITCH` 0.010 → 0.035).
  Steady-state band is now 8 ft over 3 minutes.
- **Airframe overload** — was writing the aeroplane off on a single 1/240 s sample,
  so ordinary transients read as "−6.0 g". Now needs 6 g held for 60 ms, or 12 g
  instantaneous. Measured: a 700 fpm arrival survives, 1,400 fpm does not.

**Round 3 (mobile) — STOPPED MID-FLIGHT, 4 of 10 agents committed:**
- `be26f43` device tiers + phone budgets (`src/core/device.js`)
- `774d18b` touch controls (`src/controls/touch.js`) — a thumb cockpit
- `2992c2c` phone layout — tape HUD + menu sheet
- `1d8b544` render budget — smaller node cache, no shadow tax, half a city

**Still to do in round 3:** the memory builder (heap was 352.8 MB on desktop; iOS
Safari kills tabs in the 200–400 MB range), then integrate, 2 harsh critics
(playability on a phone, memory/perf regression), and 2 fixes.

To resume it, start a fresh workflow covering that list. The old run ID
(`wf_600ce6c3-df9`) can only be resumed in the session that created it, and that
session is gone after a restart — but all the code is in git, so nothing needs redoing.

## Then

1. **Deploy to flightlens.us.** Plan agreed: game in its OWN repo, served at
   `game.flightlens.us`; 494 MB of DEM tiles on Cloudflare R2 at `tiles.flightlens.us`
   (free egress is the whole point); one nav link added to `youcsb/flightlens.us`
   — Ken approved this, and that repo has an Action that auto-commits on image
   pushes, so `git pull --rebase` before pushing.
   The build is **9.3 MB without the DEM tiles**, which fits Pages trivially.
   `VITE_DEM_BASE_URL` already exists to point tiles at another origin — **that
   bucket MUST send CORS headers**, or canvas reads taint and the ground vanishes
   in production only.
2. **Boeing 737-800** as its own round. Requested, and it is a real project: jet
   flight model (~450 kt, Mach effects, spool lag, slats, spoilers), a glass
   cockpit replacing the six analog dials, and tile prefetch that keeps up at
   450 kt.

## Two harness facts

- A hidden browser tab suspends `requestAnimationFrame` entirely. A frozen
  aeroplane in that state is the harness — drive it with `window.sim.tick(dt, n)`.
- Browser-pane screenshots can serve a stale composite. Judge visuals from a
  `WebGLRenderTarget` readback with `rt.texture.colorSpace = SRGBColorSpace`.
- The pane also crashes on long tick loops. Sample in bursts of ~30–60 frames.

## GeoFS, the quality bar

`https://www.geo-fs.com/geofs.php?v=3.9` — **not** `geofs.com` (its cert is issued
to `www.geoheat.com`). Needs 60+ seconds before the viewport stops being black.
The "Privacy Shield / Download extension" panel is a deceptive ad — never click it.
