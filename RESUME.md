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
and `npm run check:all` (~620 assertions across 15 harnesses) both pass at HEAD.

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
| `,` · `.` · `K` | **trim** nose down · nose up · neutral |

**Trim is how you hold altitude.** Set power, then tap `,` / `.` until the VSI
reads zero, then let go of the stick. Measured: 32 ft of drift over 60 s at
throttle 0.8 / trim +0.30. Before trim existed the hands-off speed was fixed at
~91 kt by CM0 and everything else drifted — that was the "won't maintain
altitude" report.

**Takeoff veers left on purpose** — propwash over the fin yaws ~2.5°/s left under
power. Hold `E` (right rudder) during the roll. Every single-engine prop does this.

`?tier=desktop` or `?tier=phone` on the URL forces a device tier — **and now
brings the matching control scheme with it**, so `?tier=phone` on a desktop puts
the thumb cockpit on screen. `?touch=1` / `?touch=0` overrides that either way.

**On touch:** left pad = pitch + roll · bottom bar = rudder · right slider =
throttle, and it LATCHES (land on the knob to move it relative, land away from
it to jump it) · FLAP / GEAR / BRK / CAM / A/P / II. BRK is momentary — hold it.
The heading and altitude bugs are in the ☰ menu and accelerate when held.

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

**Round 3 (mobile) — INTEGRATED. It has now been flown on thumbs.**
- `be26f43` device tiers + phone budgets (`src/core/device.js`)
- `774d18b` touch controls (`src/controls/touch.js`) — a thumb cockpit
- `2992c2c` phone layout — tape HUD + menu sheet
- `1d8b544` render budget — smaller node cache, no shadow tax, half a city
- `c11efd0` heap — 45.1 MB of generated textures nobody had counted
- integration: the four modules run together, and four things were wrong.

**A full circuit on touch alone**, no keyboard, synthesised pointer events at
375x812, phone tier: rotate 59 kt · climb 470–880 fpm at 91 kt · 360° turn at
22° bank · autopilot engaged from the A/P button and holding with a jittering
thumb parked on the stick · **touchdown 55.6 kt, 273 fpm, 2.6° nose-up, wheels
on the drawn surface** · stopped on the BRK button.

**What was broken and is fixed:**
1. `?tier=phone` gave phone budgets and NO CONTROLS — `resolveTouchTier` asked
   `classifyTier` for a second opinion instead of honouring the override.
2. `input.get()` ran its ramps off `performance.now()`, so `window.sim.tick()`
   advanced a held thumb by 0.008 in a simulated second. It takes an optional
   `dt` now and `main.js` passes it. **This is why nobody had flown it.**
3. The HUD's attitude cluster sat on the rudder bar and two buttons in
   landscape — 7,568 px² measured. `TOUCH_RESERVE` was two corners and a flat
   200 px; the touch layer is a full-width band whose height scales with the
   viewport. It is `touchReserve(w, h)` now, and `check:touch` runs the two
   modules together for the first time.
4. **The autopilot porpoised at any power setting it was not trimmed for** —
   ±5° of pitch at 1.3 Hz, found by flying it, reproduced in pure Node.
   `RATE_TAU` 0.08 → 0.03: the low-pass on the rate estimate was delaying the
   damping term 33° at the short period and turning it into an exciting one.
   Altitude band was inside 8 ft the whole time, which is how it survived three
   rounds. `check:autopilot § disturbed` is the new guard.

**Known and NOT fixed — the phone exceeds its own triangle budget.** Over
downtown at 610 m the phone tier draws **538,564 triangles against a 460,000
budget** (+17%); draw calls peak at exactly 120 of 120 and shader programs at
31 of 45. The overage is terrain, not the city: `lodQuality` 0.4 still selects
~200 nodes there. Nothing asserts this number, so add the assertion before
tuning it.

**Still to do in round 3:** 2 harsh critics (playability on a phone,
memory/perf regression) and their fixes.

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

## Deploying (only when asked — see the 737 plan, currently LOCAL ONLY)

- Game repo: `youcsb/flightlens-sim`. Source on `main`, built site on `gh-pages`.
  `git remote` in this project: `deploy`.
- Live at **https://game.flightlens.us** (CNAME file on gh-pages; Cloudflare has
  a grey-cloud CNAME `game` -> `youcsb.github.io`). Linked from the Flight Sim
  tab on flightlens.us (`youcsb/flightlens.us`, `assets/site.js`, `SIM_URL`).
- **Never proxy (orange-cloud) the apex, `www`, or `game`** — GitHub cannot renew
  its certificate behind the proxy. Cloudflare's dashboard nags about this;
  ignore it.
- Deploy = build, copy `dist/index.html` + `dist/assets` over the gh-pages
  worktree, `rm -rf dem/13`, strip z13 from `dem/manifest.json`, commit, push.
- **After every deploy: `Cmd + Shift + R`.** Pages sends
  `cache-control: max-age=600`, so `index.html` goes stale for 10 minutes. This
  has caused two false "it didn't work" reports.

## Terrain data — z13 is NOT deployed

The bake is 4,178 tiles / 411 MB. The deployed build ships **z11 (region) +
z14 (Seattle inset) only, 89 MB** — z13 alone is 344 MB. So terrain outside
Seattle is coarse: Rainier is the right HEIGHT but smoother than it should be.

`npm run upload:tiles` (scripts/upload-tiles-r2.mjs) is written and ready. It
needs two things a human must do: `npx wrangler login` (browser OAuth) and
`npx wrangler r2 bucket create flightlens-tiles`. An S3 API token would automate
it and is deliberately NOT used — a writable bucket credential is not worth
leaving in a config. Then connect `tiles.flightlens.us` in the R2 dashboard
(it creates its own DNS record), apply the CORS policy the script prints, and
rebuild with `VITE_DEM_BASE_URL=https://tiles.flightlens.us`.
**CORS is not optional** — without it canvas reads taint and the ground vanishes
in production only.

## Mobile draw calls — measured, still over

Phone tier over downtown: **167 draw calls against a 120 budget**, 557k
triangles against 460k. Flattening the landmark models took it from 189; range
culling past 15 km bought one more call.

The remaining calls are things genuinely on screen: terrain 42, aircraft 24,
visible Seattle landmarks, city chunks. Two levers are SPENT — materials are
already shared via a memoizer (the 34 that remain are per-building glass, whose
texture repeat encodes real storey heights), and the city is already 26 meshes
for 23,979 footprints. Going further means simplifying the landmark models
themselves for phones, which is a visual-fidelity decision, not a tuning one.

Two measurement traps that cost real time:
- `terrain.stats().triangles` counts what the SELECTOR emitted;
  `renderer.info.render.triangles` counts what survives FRUSTUM CULLING. Over
  downtown they differ by ~4x. A headless number and a browser number can
  disagree while both are right.
- The aspect ratio IS the crop for `preserveAspectRatio: slice`. Visible width
  in viewBox units is `w / max(w/vbW, h/vbH)`.

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

## Boeing 737-800 — plan of record (started 2026-08-07)

**BOTH AIRCRAFT, SELECTABLE. The Cessna is not being replaced.** Ken was
explicit: "make sure we can pick between the current cesna or a 737, don't just
change the only option." Every step below preserves the C172 as the default.

**Local only for now** — no deploying to flightlens.us until the kinks are out.
game.flightlens.us keeps serving the Cessna-only build.

### Step 1 (in progress) — parameterize the flight model

flightModel.js had 67 module-scope constants describing exactly one aeroplane.
`DEFAULTS` already carried mass, wing area, span, power, cd0 and the inertias;
what stayed hardcoded were the aero derivatives, control travel, flaps, the prop
model, the gear contact table, and the limits.

The refactor makes an airframe a DATA FILE (`src/physics/airframes/c172.js`), so
a 737 is a sibling file rather than a code change.

**Gate: behaviour-preserving.** A baseline of envelope / trim / autopilot output
was captured before the change; the diff must be empty. Every number — rotate
55 kt, best climb 743 fpm, climb 764 → 297 fpm with altitude, the stall break,
the landing — has to come out identical, because only the LOCATION of the
numbers changed.

### Then, in order

2. **737 flight model** — `airframes/b738.js`: Mach drag rise above ~M0.7,
   turbofan spool lag (N1 takes 5–8 s, not a prop's instant response), slats as
   well as flaps, spoilers, ~250–450 kt envelope, Vne ~340 KIAS / M0.82.
3. **737 3D model** — swept wings, two underwing nacelles, winglets, larger
   gear. A sibling of the procedural C172 in `aircraft/model.js`.
4. **Aircraft picker** — in the place picker / menu, and it must survive a
   `reset`. Per-aircraft spawns: a jet wants KSEA's long runway or an airborne
   start, not KBFI 32L at idle.
5. **Per-aircraft autopilot gains** — the current ones are tuned for 40–160 kt
   and its airspeed protection floor is 58 kt. A jet needs its own set.
6. **Tile prefetch at 450 kt** — the DEM pager was tuned for ~100 kt and is
   untested at 4.5x that. Genuinely unknown; expect this to need work.

### Deliberately deferred

**The glass cockpit.** A 737 wants a PFD/ND, which is effectively a new
2,000-line module. Skipping it is roughly half the work, and a real 737 carries
standby analog instruments for exactly these readings — so the existing six-pack
is not a cop-out. Its own round later, better for having a flying jet to build
against.
