# RESUME — Ken Flight Sim

Paused **2026-08-08**. **Everything is committed; the working tree is clean and
both gates are green.** Nothing is lost.

**The Boeing 737-800 is done and flyable — press `I` to switch aircraft.** It
is on the branch `jet-flight-model`, five commits, NOT merged and NOT deployed.
See the plan-of-record section at the bottom, which is now a record of what was
built and measured rather than a plan.

## Restart here

```bash
cd "/Users/KenAltmann/Desktop/Ken Flight Sim"
export PATH="$HOME/.local/node/bin:$PATH"   # node v24.19.0 is NOT on the default PATH
npm run dev                                  # http://localhost:5173
```

No servers are running — they were stopped to free the machine. `npm run build`
and `npm run check:all` (1,313 assertions across 19 harnesses) both pass on
`jet-flight-model`. `main` is untouched at `39c5b75`.

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
| `I` | **change aircraft** — Cessna 172 / Boeing 737-800 |

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

## Boeing 737-800 — DONE AND FLYABLE (2026-08-07/08)

**Both aircraft are selectable. Press `I`.** The Cessna is the default and is
byte-for-byte the aeroplane it was: every flight-model number in envelope,
trim, autopilot and instruments diffs identical against baselines captured at
`39c5b75`.

**Still LOCAL ONLY. Nothing deployed.** game.flightlens.us is still serving the
Cessna-only build. Deploy when you have flown this and are happy with it.

Branch: **`jet-flight-model`**, five commits, not merged to `main`. `main` is
untouched at `39c5b75`. The git log is the real documentation — every number
that moved says what it was measured against.

```
cd9b8f8  Autopilot: the same law, the jet's own gains
33ac1ac  Aircraft picker: two aeroplanes, one key, and the Cessna still boots
9aaa108  b738model: a 737 you can look at, and a toolkit both aeroplanes share
a62b918  b738: a Boeing 737-800, as data, flown until the numbers were true
2e12c39  flightModel: an engine can be a turbofan, and a wing can feel Mach
```

Gates: `npm run build` green, `npm run check:all` green — **1,313 assertions
across 19 harnesses**, up from 1,208 across 16.

### Fly it

```bash
cd "/Users/KenAltmann/Desktop/Ken Flight Sim"
export PATH="$HOME/.local/node/bin:$PATH"
npm run dev
```

`I` cycles the aircraft. The choice persists in localStorage and
`?aircraft=b738` forces it. Everything else works the same on both.

**Flying the 737 is not flying the Cessna.** Rotate at 145 kt, not 55. It lifts
off at about 172 and needs 1,772 m of runway. Do not haul it into a 30-degree
climb and let go of the stick at 1,200 ft — it will pitch down hard and hit the
ground, which is what happened the first time it was flown here. Trim it.

The tail strikes at 10.8 degrees nose-up on the wheels. That is correct and it
is the real number for a -800.

### What each step did

| Step | State |
|---|---|
| 1 · airframe as data | done previously (`791acbc`) |
| 1.5 · turbofan, Mach, CLmax rail, N1 | done (`2e12c39`) |
| 2 · `airframes/b738.js` | done (`a62b918`) |
| 3 · 3D model + `lofting.js` | done (`9aaa108`) |
| 4 · picker, camera, gauges | done (`33ac1ac`) |
| 5 · per-aircraft autopilot gains | done (`cd9b8f8`) |
| 6 · tile prefetch at 450 kt | **measured — no work needed, see below** |

### Step 6: the DEM pager already keeps up

RESUME used to say "genuinely unknown; expect this to need work". It was
measured instead, and it does not need work.

Method: fly the jet fast, record the terrain height the simulation actually
used at each point along the path, wait six seconds for the pager to settle,
then re-sample those same world coordinates. Any difference is terrain that
sharpened AFTER you flew over it — which is the symptom.

```
  433 KTAS near Rainier   worst delta 0.00 m over 20 samples
  337 KTAS over Seattle   worst delta 0.00 m over 22 samples  (z14 still
                          loading at the time: 58 tiles resident, 70 pending)
```

Zero, not "small". `tilesMissing 0`, `capViolations 0`, 58 MB resident against
a 100 MB cap. The reason it works is that `LEAD_SECONDS = 60` in elevation.js
gives 13.4 km of lead at 433 kt, still inside the z13 radius of 30 km and still
under the `LEAD_MAX_M` 20 km clamp. The design had the headroom by accident.

**The one thing to watch if anything ever gets faster:** z14's radius is 9 km
and the lead at jet speed is 13.4 km, so the fine layer's desired disc no
longer contains the aircraft. It did not bite (the measurement above was taken
over Seattle precisely to catch it) because z13 covers the gap, but at a higher
`LEAD_SECONDS` or a faster aeroplane it would.

### The 737, as flown

`npm run check:jet` — 54 checks. `npm run check:b738` — 35 checks on the mesh.

```
  rotate            148 KIAS        ground roll   1,772 m
  lift-off          172 KIAS        climb         2,300 fpm
  stall, flap 40    110 KIAS        clean         warns at 164, mushes
  cruise            M0.78 at FL350, 93% thrust, alpha 2.6 deg
  ceiling           holds M0.77 at FL390 on full thrust
  Mmo               flags at M0.82 / 265 KIAS — 75 kt INSIDE the placard
  roll rate         16.9 deg/s at 160 kt
  landing           145 kt at 478 fpm, stopped in 1,133 m
  tail strike       10.8 deg on the wheels
```

Arrival table, measured, in `b738.js` beside `limits.crashLoadG`: 631 fpm
survives at 3.04 g, 863 fpm collapses the gear, 1,070 fpm overloads the
airframe. The GEAR fails first, on closing speed, before any load holds for
60 ms — which is correct. The legs are the fuse.

### Deliberately NOT done

- **The glass cockpit.** Still its own round, as planned. The jet flies on the
  six-pack with a real N1 gauge in place of the tachometer — face rebuilt,
  0-110%, green from 85, redline 104. That is a defensible standby panel, not
  a placeholder.
- **Engine-out asymmetry.** One thrust vector on the centreline. `b738.js`
  says so where it sets both prop asymmetry arms to zero.
- **Flap detents, slats as a separate surface, spoilers, speedbrakes,
  reversers.** Flaps are still one continuous 0..1 axis, so `flaps.vfeMs` is a
  compromise at the flaps-15 placard (200 kt) rather than a real per-detent
  schedule. The file says so. Detents must land in `b738.js` and
  `b738model.js` together or the aeroplane you see stops being the one you fly.
- **The 90-degree autopilot turn takes 82 s** and overshoots 25 deg of bank by
  about 3. It settles to zero error and does not oscillate, so the roll axis
  keeps the Cessna's gains until someone flies it and disagrees.

### Traps found the hard way — all of these cost real time

1. **`bakeStatic` takes no options.** A `skip` callback is accepted by
   JavaScript, ignored by the function, and silently merges the things you
   meant to keep. The real mechanism is `userData.animated = true`.
2. **`Box3.setFromObject` measures LOCAL space until something has rendered**,
   because every `matrixWorld` is still identity. It put the engine nacelle
   1.9 m above the wheels instead of 0.45 — a measurement error that reads
   exactly like a modelling error.
3. **A PD from altitude error straight to the elevator oscillates a heavy
   aeroplane, and MORE DAMPING MAKES IT WORSE.** Vertical speed lags pitch by
   most of a quarter cycle, so the "damping" term excites the phugoid. Use a
   cascade: vertical speed → pitch ATTITUDE → elevator, damped on pitch rate.
   Same shape as the `RATE_TAU` bug already in the autopilot's notes.
4. **`state.rpm` is 0 on a turbofan, deliberately.** Three separate places were
   reading it and getting a frozen fan, a dead needle and a stale HUD row.
   `state.engineGauge` says which number to read.
5. **"Max pitch while `onGround`" is not the tail-strike angle.** `onGround`
   means some contact is loaded and the skid IS a contact — the aeroplane
   levers off its tail and climbs away still reporting `onGround` at 14 deg.
   Measure pitch at wheel height.
6. **A linear gear damper peaks at FIRST CONTACT**, where a real oleo is still
   soft. `c = 300,000` wrote the aeroplane off on a normal 630 fpm landing.
7. **The `baked:xxxxxxxx` mesh hash in `check:aircraft` is nondeterministic
   run to run.** It is decoration, not an assertion. Do not chase it when
   diffing that harness — everything else in the file is stable.

### If you want to change a 737 number

Go to `src/physics/airframes/b738.js`. Every number has the reasoning beside
it and says what it was measured against. Then:

```bash
npm run check:jet && npm run check:b738
```

The Cessna must not move. Regenerate a baseline from `main` and diff if you
touch anything in `flightModel.js` or `units.js`:

```bash
git stash && npm run envelope > /tmp/base.txt && git stash pop
npm run envelope | diff /tmp/base.txt -
```


