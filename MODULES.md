# MODULES.md — the interface contract

Eight agents build against this document in parallel. It is the arbiter: if
your code and this file disagree, this file wins until it is amended in the same
commit as the code.

**Rule of thumb.** You own the *inside* of your module. You do not own its
signature, its units, or the shape of the objects it hands to anyone else.

---

## 1. Conventions that bind every module

### 1.1 Units — metric inside, imperial only at the glass

The simulation is **metres, metres/second, radians, seconds, kilograms**.

Knots, feet, feet-per-minute and degrees exist in exactly two places:

- the pre-computed display fields on `flightModel.state` (`airspeedKts`,
  `altitudeFt`, …), and
- `ui/instruments.js`, which renders them.

Never store an imperial value on a physics object. Never convert units by
hand — import the constants from `src/core/units.js` so all eight modules agree
to the last decimal. Angles are **radians** in code and **degrees** in data
files and display fields; the field name always says which (`alphaRad`,
`headingDeg`).

### 1.2 Axes

```
+X = EAST          -X = west
+Y = UP            y = 0 is MEAN SEA LEVEL
-Z = NORTH         +Z = south        <-- note the sign
```

`-Z` is north because Three.js cameras look down `-Z`, so an aircraft with the
identity quaternion has its nose pointing north. Heading is therefore a
rotation of **minus** yaw about `+Y`.

A true bearing `b` becomes the unit direction `(sin b, 0, -cos b)`. Use
`coords.headingToVector()` / `coords.vectorToHeading()` rather than
re-deriving the signs — sign errors here are invisible until something is
180° out over the water.

**Body axes** (local space of the aircraft group), matching `aircraft/model.js`:
`-Z` nose, `+X` right wing, `+Y` up (canopy).

### 1.3 The scene origin

`src/geo/coords.js` holds one global origin, set once during bootstrap.
Default: **KBFI's airport reference point, 47.527042 / -122.29995**, so the
spawn sits at `(0, 0)` and float precision is best where the player flies.

Local coordinates computed before and after a `setOrigin()` call are not
comparable. **Call it exactly once, in `main.js`, before anything is placed.**

The projection is an anchored equirectangular: both metres-per-degree factors
are evaluated once and frozen, making it a uniform affine map — exactly
invertible, zero grid convergence, cheap in a per-vertex loop.

**The position anchor and the scale anchor are separate.** `(lat0, lon0)` fixes
*where* the origin is; `SCALE_LAT` — the region-centre latitude, 47.35 — fixes
*how big* a degree is. Two reasons. It balances distortion north/south instead
of biasing it toward whichever end the origin sits at, and, more importantly,
it means **calling `setOrigin()` to move the spawn cannot silently rescale the
entire world.** Tying the two together is a live footgun with several people
editing the scene at once.

Measured cost: east-west scale error peaks at **±1.8%** on the region's north
and south edges, applied uniformly, so nothing is displaced relative to its
neighbours. (Anchoring the scale at the origin latitude instead would make it
2.1%, all southward — about 850 m of error at Mount Rainier.)

Do not "improve" the residue with a latitude-dependent longitude scale: it
shears meridians and introduces up to 0.8° of heading error, which is much
worse for a flight sim than a uniform 2% scale.

### 1.4 THE GROUND-HEIGHT INVARIANT

> There is exactly one ground surface, and it is
> `elevation.getElevationLocal(x, z)`.

- `terrain.getHeightAt(x, z)` **delegates to it.** Not a raycast against the
  mesh. Not a copy of the vertex buffer. Not a similar-looking noise function.
- `flightModel.step()` receives `groundHeight` from the caller, who got it from
  `terrain.getHeightAt`.
- `flightModel.reset()` uses the `groundHeightFn` it was constructed with —
  which `main.js` sets to that same `terrain.getHeightAt`.

The visible mesh is a *discretisation* of the elevation field; the collision
surface is the *field itself*. **They must agree to the centimetre.** Because
both derive from one sampler, they do — at every LOD, forever.

The consequence to accept: at coarse tessellation the drawn triangles can dip
below the sampled field between vertices, so on very steep ground the aircraft
may appear to hover by a metre or two. That is the correct trade. Raycasting
the mesh instead would make ground contact *change when LOD changes*, which is
far worse. Fix it with more triangles near the camera, never by changing the
sampler.

**Paging does not weaken this.** The elevation field is now streamed (§2.4), so
what it returns at a point can improve as tiles arrive — but it improves for
*both* callers at once, because there is still only one sampler. The pager's job
is to make sure the change never happens under the wheels: it prefetches along
the flight path and fades each tile in over 1.5 s. Measured worst-case ground
movement from a page-in, flying KBFI to Rainier: **0.0000 m**.

### 1.5 Geographic truth vs. procedural texture

Real: terrain **shape**, airport **positions**, runway **headings and lengths**,
landmark **coordinates**, the coastline (from the DEM's sea-level data), and
**land cover** — which square metres are water, forest, farmland or city, from
NLCD 2021 at 30 m, plus TIGER/Line road centrelines.

Procedural: **surface colour**, materials, vegetation, buildings that are not
named landmarks.

A land-cover **classification** is on the real side of that line and imagery is
not, and the distinction is worth stating precisely: NLCD is fifteen integers
per texel saying what kind of ground this is, from a published survey. It is not
a picture and it carries no photographic detail — the shader still invents every
pixel it draws. It just stops guessing. That matters because height and slope
**cannot** separate downtown Seattle from the Kent Valley farms from Discovery
Park: all three are flat and near sea level, so before this data every lowland
in the region came out the same green, which is the single loudest way the world
read as a toy from 600 m.

We deliberately do not stream satellite imagery. Draped imagery is exactly what
makes GeoFS turn to mush below ~500 ft AGL — there is no more texture detail to
show. Real geometry plus procedural material stays crisp all the way to the
runway. **Never trade geometric accuracy for visual polish.** If terrain must
be simplified for performance, simplify the *tessellation*, never the *source
data*.

### 1.6 Nothing blocks the boot

Baked data may be absent — eight agents are working in parallel and the build
must stay green. Every loader degrades: no DEM gives a flat sea-level world,
no airport data gives a hardcoded KBFI spawn, no landmark data gives a built-in
Space Needle and Mount Rainier. Loaders warn to console with a `[module]` prefix
and return empty; **they never throw**.

### 1.7 Ownership

| Concern | Sole owner |
|---|---|
| `scene.background`, `scene.fog`, **all lights** | `world/sky.js` |
| Aircraft position & orientation | `physics/flightModel.js` |
| The scene origin & all projection | `geo/coords.js` |
| The ground surface | `geo/elevation.js` |
| Camera transforms | `camera/cameras.js` |

No other module may add a light. No module outside `flightModel` may write to
`state`. `aircraft/model.js` is **purely cosmetic** and never moves its own
group — `main.js` writes the transform onto it.

### 1.8 Performance rules

- `step()`, `update()` and `get()` run every frame: **no allocation**. Use
  module-scope scratch objects, or the optional `out` parameter that every
  vector-returning function in `coords.js` accepts.
- Loaders are `async`. Per-frame functions are never `async`.
- Asset URLs go through `core/assets.js#assetUrl()`. `vite.config.js` sets
  `base: './'`, so a bare `fetch('/data/...')` breaks in the production build.

---

## 2. Module interfaces

### 2.0 `src/core/keycode.js` — one key identity for every listener

```js
eventCode(e) -> string   // e.code, or a code synthesised from e.key. Never null.
```

Used by `controls/input.js`, `camera/cameras.js` and `main.js`. See §2.12 for
why binding to `e.code` alone loses control of the aircraft entirely on some
input methods.

### 2.1 `src/core/units.js` — conversions and helpers

```js
M_TO_FT, FT_TO_M, M_TO_NM, NM_TO_M
MS_TO_KTS, KTS_TO_MS, MS_TO_FPM, FPM_TO_MS
RAD_TO_DEG, DEG_TO_RAD, GRAVITY, RHO_SEA_LEVEL

clamp(v, lo, hi) -> number
lerp(a, b, t) -> number
wrapDeg(deg) -> number            // into [0, 360)
damp(current, target, rate, dt) -> number    // frame-rate independent
airDensity(altitudeM) -> number   // kg/m^3, ISA troposphere
```

### 2.2 `src/core/assets.js` — public/ URL resolution

```js
assetUrl(rel) -> string                       // rel has NO leading slash
fetchJsonOrNull(rel, fallback) -> Promise<T>  // 404 returns fallback, warns once
```

### 2.3 `src/geo/coords.js` — the projection

```js
REGION_BBOX      // {south:46.4, north:48.3, west:-123.4, east:-121.2}
DEFAULT_ORIGIN   // {lat:47.527042, lon:-122.29995}  KBFI ARP
SCALE_LAT        // 47.35, region centre — where metres-per-degree is evaluated
MAG_VAR_DEG      // 15.6, east. true = magnetic + this

setOrigin(lat, lon, scaleLat?) -> void   // ONCE, at bootstrap, before anything
                                         // else. Moving the origin TRANSLATES
                                         // the world; it does not rescale it.
getOrigin() -> {lat, lon}
getScale()  -> {lat, lon}          // metres per degree, current

llToLocal(lat, lon, out?) -> {x, z}   // x = metres EAST, z = metres SOUTH
localToLl(x, z, out?)     -> {lat, lon}

headingToVector(headingDeg, out?) -> {x, z}   // unit
vectorToHeading(x, z)             -> deg 0..360
bearingBetween(lat1, lon1, lat2, lon2) -> deg 0..360
distanceBetween(lat1, lon1, lat2, lon2) -> metres
offsetLatLon(lat, lon, headingDeg, distanceM) -> {lat, lon}

metresPerDegreeLat(lat) -> metres
metresPerDegreeLon(lat) -> metres

tileXY(lat, lon, z) -> {x, y}      // integer slippy tile
lonToTileXFloat(lon, z) -> number  // fractional; needed for bilinear sampling
latToTileYFloat(lat, z) -> number
tileXToLon(x, z) -> deg
tileYToLat(y, z) -> deg
tileBounds(x, y, z) -> {north, south, west, east}
tileRange(bbox, z) -> {minX, maxX, minY, maxY, count}
metresPerPixel(lat, z, tileSize?) -> metres
inBbox(lat, lon, bbox) -> boolean
```

`bearingBetween` measures in the **scene projection**, not as a great-circle
initial bearing, so a runway drawn between two endpoints and a heading computed
from those endpoints agree exactly. Do not substitute haversine.

### 2.4 `src/geo/elevation.js` — the ground surface

```js
SEA_LEVEL_M         // 0
WATER_LEVEL_M       // 0.5 — salt water only, see below
DEM_ZOOM            // 11, PINNED base: 238 tiles, 51.8 m/px, whole region
DETAIL_ZOOM         // 13, PAGED working layer: 3,380 tiles, 12.95 m/px, whole region
FINE_ZOOM           // 14, PAGED approach layer: 560 tiles, 6.47 m/px
DETAIL_BBOX         // {south:47.35, north:47.75, west:-122.5, east:-122.1} — FINE_ZOOM's box
RESIDENT_CAP_BYTES  // 96 MiB. Hard ceiling on decoded elevation. Asserted.

loadRegion(bbox?, zoom?)   -> Promise<void>   // ADDITIVE, one call per level
loadDetailLayers(baseZoom?) -> Promise<void>  // every finer level in the manifest
setViewer(x, z, vx?, vz?, dtMs?) -> void      // PER FRAME. Drives paging.
warmAt(lat, lon)  -> Promise<void>            // page in around a point, then wait
flushPaging()     -> Promise<void>            // drain everything. NOT per-frame.
isLoaded() -> boolean
getFieldEpoch() -> number                     // bumps when the ANSWER can have moved
getRegionStats() -> {loaded, layers, tilesLoaded, tilesMissing, voidsRepaired,
                     minElevationM, maxElevationM, residentBytes,
                     peakResidentBytes, residentCapBytes, residentTiles,
                     pageIns, evictions, capViolations, fieldEpoch, pendingLoads}

getElevation(lat, lon) -> metres MSL        // bilinear, never NaN, never throws
getElevationLocal(x, z) -> metres MSL       // allocation-free
getNormalLocal(x, z, epsM?) -> {x, y, z}    // unit, +Y up. epsM default 15.
fillHeightGrid(x0, z0, dx, dz, nx, nz, out?) -> Float32Array
isWater(lat, lon) -> boolean
isInRegion(lat, lon) -> boolean
decodeTerrarium(r, g, b) -> metres          // (R*256 + G + B/256) - 32768
getLayerElevation(zoom, lat, lon) -> {height, weight, resident}   // diagnostics
setTileProvider({fetchPixels?, manifest?})  -> void               // see below
```

**Three layers, and only one of them is resident.** 4,178 tiles are baked.
Decoded, z=13 alone is 443 MB, which cannot be held. So:

| zoom | tiles | m/px | coverage | residency |
|---|---|---|---|---|
| 11 | 238 | 51.8 | whole region | **pinned**, 29.75 MiB, never evicted |
| 13 | 3,380 | 12.95 | whole region | paged, 30 km radius, 288-tile budget |
| 14 | 560 | 6.47 | Seattle inset | paged, 9 km radius, 128-tile budget |

Peak resident is **81.8 MiB** against a 96 MiB cap, measured by
`npm run check:elevation`. The full derivation is in `elevation.js § PAGING`;
the four rules that bind other modules are:

1. **`getElevation` never blocks and never awaits.** It reads only decoded
   tiles. A tile that has not arrived is a miss, not a wait.
2. **A miss falls to the next COARSER layer, never to zero.** That is the whole
   reason z=11 is pinned: inside the region there is always an answer. A 0 m
   return over the Cascades is a 2 km cliff, and the flight model would
   correctly destroy the aeroplane on it.
3. **Someone must call `setViewer()` every frame** or the fine layers never
   follow the aircraft. `world/terrain.js#update()` does, from the camera. It is
   on the rAF path *and* the `window.sim.tick()` path.
4. **Teleports must `await warmAt(lat, lon)` before reading the ground there.**
   `main.js#gotoPlace` does. Without it you land on the 51.8 m/px base and the
   terrain morphs underneath you afterwards.

**Layers BLEND, they do not switch.** Round 1 returned the first layer that had
a tile, which made every layer boundary a step — the critic saw the inset as "a
hard rectangle whose edge is a visible ledge". Sampling now folds finest to
coarsest spending a weight budget, and the weight is the product of three fades:
distance inside the layer's own bbox (3 km band), distance from the viewer
(fades out at 0.65–0.85 of the paging radius, well inside the guaranteed
coverage), and a 1.5 s per-tile ramp after decode so a tile arriving behind a
teleport cannot move the ground in one frame. A layer at weight 1 short-circuits
the fold, so the common case costs what it always did. Measured: **0.48 m of
step at the inset edge against 12.76 m of ordinary terrain roughness** on the
same transect.

None of this touches §1.4. The mesh (`fillHeightGrid`) and the collision surface
(`getElevationLocal`) call the same sampler, so whatever the blend says at a
given instant, both agree to the centimetre.

**Storage is Int16 quarter-metres, not Float32.** That halves resident bytes,
which doubles the radius a budget can cover, and costs 0.25 m of quantisation on
a source whose own vertical accuracy is ±3 m. Do not "fix" it to Float32.

**Sampling crosses tile seams.** Bilinear interpolation happens in global pixel
space, not per-tile, which is what stops the terrain showing a grid of creases.

**`getElevation` is total.** Outside the region, before loading, on bad input:
returns `SEA_LEVEL_M`. It is called several times per wheel per substep and must
never be able to trip over a gap in the data.

**The source has voids, and they are repaired at decode.** Untreated, each is a
kilometres-deep needle through the terrain mesh and a garbage `altitudeAglFt`
for anything flying over it. Every pixel is screened on two independent tests —
an absolute plausibility band and deviation from the 8-neighbour median (150 m,
above the steepest real Cascade terrain at every zoom) — then neighbour-filled.

The band is `[-60, 5000]` m and **both limits are measured, not guessed**. Round
1 used `[-500, 9000]` and 144 voids survived inside it, the worst reading
-497.8 m. Bucketing every negative pixel in all 4,178 tiles by depth, and
marking those that jump more than 20 m to a neighbour, gives a categorical
boundary that lands in the same place at all three zooms: real smooth
bathymetry stops in `[-50, -40)`, and **every pixel below -60 m is
discontinuous, without exception**. Terrarium carries nearshore bathymetry only
here — the main Puget Sound basin is a flat zero, not its true -280 m — so there
is no real data below -60 to lose. The ceiling likewise: the highest real ground
is Rainier at 4,393 m, and 32,767 m is the all-ones no-data sentinel, which
`9000` let straight through. Minimum decoded sample is now exactly -60.0 m.

Do not add flood-fill propagation between pixels: it is redundant against the
band test and it walks up steep faces. See the note in `elevation.js`.

**`setTileProvider` is not a test backdoor.** The browser path reads tiles
through fetch + canvas, which needs a DOM, so the paging policy, the byte
accounting and the eviction could not otherwise be asserted anywhere. It swaps
the pixel source only; `scripts/check-elevation.mjs` runs the shipping module
against the real baked tiles in Node.

**Water.** `isWater()` finds *salt* water only. Terrarium gives freshwater lakes
their real surface elevation — Lake Washington reads ~5 m, not 0 — so lakes need
the flat-region heuristic described in §2.6, not this function.

**Use `fillHeightGrid` for terrain geometry.** It is the same sampler as
`getElevationLocal`, so the mesh and the collision surface cannot drift apart,
and it avoids a few hundred thousand redundant allocations.

**THE FIELD EPOCH — anything that CACHES a sample must watch it.**
`getFieldEpoch()` is a monotonic counter, bumped whenever a tile decodes, a
resident tile is evicted, or an arrival ramp reaches 1. It exists because paging
turned a constant into a moving target, and the failure that causes is silent.

Before paging, a consumer could sample the field once and keep the answer
forever. `world/terrain.js` did exactly that in two places — each LOD node
measures its geometric error once when it is created, and samples its vertices
once when it is built. The bootstrap `converge()` runs at the scene origin while
only the 51.8 m/px pinned base is resident, and the quadtree root is 262 km
across, so the coarse nodes it creates cover the whole region — Mount Rainier
included. Every one of them was measured, and drawn, against a surface four
times coarser than the data that would later be resident under it:

| at 3,000 m over the summit | before | after |
|---|---|---|
| drawn surface vs the field | 26.6 m worst, 23.3 m RMS | 0.005 m worst, 0.283 m RMS |
| finest cell selected | 64 m | 8 m |

`getHeightAt` was right the whole time, which is what made it invisible — the
wheels were correct and the picture was wrong. Guarded by
`scripts/check-terrain.mjs` §5 and §8.

**The rule:** if you cache anything derived from the field, stamp it with the
epoch and re-derive when the epoch has moved. Compare the re-derived value
against the SAME measurement you cached, not against a different one taken at a
different sample spacing — see `probeLo`/`probeHi` in terrain.js for the bug
that costs you when you do not.

### 2.5 `src/geo/airports.js` — real fields, real runways

```js
SPAWN  // {ident:'KBFI', runwayEnd:'32L', fallback:{lat, lon, headingDeg, elevationFt}}

loadAirports() -> Promise<Airport[]>        // idempotent, [] if unbaked
getAirports() -> Airport[]
getAirport(ident) -> Airport | null
findRunwayEnd(ident, end) -> {airport, runway, atLowEnd} | null
getSpawn(ident?, end?) -> {lat, lon, headingDeg, elevationM, label}

buildRunwayMeshes(scene, airports?) -> THREE.Group   // named 'airports'
disposeRunwayMeshes(group) -> void
nearestAirport(lat, lon, opts?) -> {airport, distanceM, bearingDeg} | null
runwayDirection(runway, out?) -> {x, z}
headingFromEndpoints(runway) -> deg
```

```ts
Airport = {
  ident, name, lat, lon, elevationFt, type, municipality,
  runways: Runway[]
}
Runway = {
  leIdent, heIdent,
  leLat, leLon, heLat, heLon,
  headingDeg,            // TRUE bearing, low end -> high end
  lengthFt, widthFt, surface, lighted, closed,
  geometry: 'surveyed' | 'synthesised' | 'override'
}
```

**THE NUMBER THAT MATTERS IS THE FLOAT: how far the drawn asphalt stands above
`getElevationLocal` underneath it.** Not the deck *bend*, which is how far the
deck departs from its own fitted plane. Round 2 advertised the bend here
("KBFI: 2.4 cm") and shipped a **0.83 m float at the spawn point** — with
`gearHeightM` at 1.20 m, most of the main gear was inside the pavement on frame
0, with every gate green. Two statistics, two different things, and quoting the
flattering one is how a metre of float hid through two rounds.

The deck is now, per 25 m station and across the width,

```
deck(t, s) = max( plane(t), cross(t, s) ) + 0.25 m
```

where `cross` is the lowest line through that cross-section that still clears
every DEM sample on the pavement, lightly smoothed along the runway to take out
the quarter-metre storage stairs (§2.4). Its tilt is **one cross-fall for the
whole runway**, the median of the per-station fits, capped at the FAA's 2%
transverse limit. One number rather than one per station is a geometric
requirement, not a simplification: a cross-fall that changes between stations
makes every pavement quad a twisted bilinear patch, which is not the surface
`deck()` reports, and the paint drawn on it sank up to 0.53 m into its own
asphalt. With a constant cross-fall every quad is planar. `plane` is the fitted line, and it is a floor for exactly
one case: **paved** ground whose DEM is too rough to be a runway at all, which
is the missing-earthworks case below. Everywhere else the ground under a runway
*is* the runway, and the deck lies on it. Unpaved strips whose DEM fit fails
drape: nothing was ever levelled on a mown field, and levelling one gave WA45
16/34 a deck standing 27.8 m over its own hillside.

Measured on the shipping meshes against the shipping collision surface by
`npm run check:airports` — per drawn *triangle*, barycentrically, so it answers
between the vertices too:

| | round 2 | now |
|---|---|---|
| the spawn, KBFI 32L threshold | 0.83 m (69% of a gear leg) | **0.32 m** (26%) |
| KBFI 14R/32L, landing band | 0.88 m mean | **0.30 m** mean, 0.51 worst |
| KSEA 16C/34C, landing band | 1.14 m mean, 2.93 worst | **0.27 m** mean, 0.43 worst |
| KSEA 16L/34R, landing band | 2.60 m mean, 9.92 worst | **0.34 m** mean, 1.19 worst |
| paved runways over 0.5 m on the centreline | 17 of 47 | **2 of 47** |
| pavement vertices below the surface | 74 at KSEA | **0** |

Two things follow the deck that did not before. The **shoulder** is drawn at
station resolution and its outer edge sits on the terrain, so it covers the step
instead of floating over it (0 buried vertices region-wide, against 74 at KSEA).
And every **marking** is broken at the deck's own stations rather than at its
own equal spans: a stripe is a chord between its vertices, the deck bends
between stations, and an edge stripe used to run the full length of the runway
as ONE quad. Measured over 19,306 marking triangles, the worst paint-below-
pavement was 0.53 m and is now 0.13 m — and every triangle left is inside KW28
Sequim Valley, where two runways 35 m apart genuinely overlap and each deck is
fitted to its own ground.

Cost, measured: the airports group goes from 15,952 to 45,578 triangles and 1.1
to 3.2 MiB of buffers, in the same 10 draw calls, and `buildRunwayMeshes` from
21 to 52 ms — once, at boot, off the frame path.

Flush beats flat — the DEM is the collision surface (§1.4).

**KSEA 16R/34L IS NOT AN ELEVATION BUG, and raising the DEM resolution proved
it rather than fixing it.** Round 1 measured a 12.9 m hump there at 51.8 m/px
and hoped 12.95 m/px would resolve it. Re-measured against the surveyed
threshold elevations at the new resolution (`npm run check:elevation`):

| runway | worst deck-above-DEM |
|---|---|
| 16L/34R | **0.1 m** |
| 16C/34C | 11.7 m, and only in the last 10% at the south threshold |
| 16R/34L | **55.7 m**, at 28% along from the north threshold |

The two plateau runways are essentially perfect, which is the strongest
available evidence that the DEM's georeferencing and vertical datum are right.
16R/34L is the 2008 third runway, and it crosses the Miller Creek valley on a
man-made MSE retaining wall. 3DEP's bare-earth terrain does not contain that
earthwork, so the finer the DEM gets, the better it resolves the *natural
ravine* the wall spans and the larger the gap to the deck becomes. 12.9 m was a
51.8 m/px smoothing of a real 55.7 m ravine.

**This is airports.js's problem, not elevation.js's, and it is now DRAWN rather
than implied.** Faking the fill in the DEM would be inventing geography (§1.5).
The embankment is airport *infrastructure*, so it belongs in the runway deck:
16R/34L holds its reconstructed plane, and the **paved shoulder skirts down to
the terrain**, which draws the retaining wall that is actually there instead of
leaving a ribbon in the sky. `check:airports` asserts the skirt reaches the
ground at every 50 m station on both sides (worst +0.06 m over 104
station-sides) and that its tallest section spans the whole embankment (30.3 m).

16R/34L is the only deck in the region that stands more than 3 m above its own
ground, and `buildRunwayMeshes` publishes the list as
`group.userData.standingDecks` and warns about it on the console. That is the
honest shape of the trade: on that one runway the wheels will meet the DEM's
ravine and not the paint, because both are real and only one of them is in the
data we have.

**`headingDeg` is TRUE, not magnetic.** The upstream `le_heading_degT` column
frequently is not: KBFI publishes 140 where its own endpoints give 150.13 and
150 is correct. The baker computes from endpoints and validates against
`length_ft`. `geometry` records how each runway was obtained — never treat
`'synthesised'` as survey data.

**The spawn is not arbitrary.** KBFI 32L, heading 330.2°, puts the Space Needle
12.3 km away on bearing 339.2° — essentially down the extended centreline, in
the windscreen on climb-out — and Mount Rainier 84.1 km away on bearing 151.5°,
which is the reciprocal runway heading. One 180° turn and the mountain fills the
view. Both landmarks the user named, from one spawn, without a map.

### 2.6 `src/geo/landmarks.js` — named things at true coordinates

```js
loadLandmarks() -> Promise<Landmark[]>    // idempotent, built-in fallback
getLandmarks() -> Landmark[]
getLandmark(name) -> Landmark | null
placeLandmarks(scene) -> THREE.Group      // named 'landmarks'
disposeLandmarks(group) -> void
nearestLandmark(lat, lon, maxDistanceM?) -> {landmark, distanceM} | null
```

```ts
Landmark = { name, lat, lon, heightM, kind, wikidataId?, widthM? }
kind = 'tower' | 'peak' | 'building' | 'stadium' | 'bridge' | 'other'
```

**`placeLandmarks` returns an empty group immediately** and fills it once the
data resolves, starting the load itself if nobody has. Hold the group; it
populates itself. Do not measure `group.children` on the calling frame.

**`heightM` is above the landmark's own base**, not above sea level — 184 m for
the Space Needle. Landmarks are placed at `getElevation(lat, lon)`, so the DEM
supplies the base.

**Peaks get `heightM = 0`.** Their summit elevation is already in the DEM.
Mount Rainier is *terrain*; the landmark entry only labels it. If Rainier looks
wrong, that is an elevation bug, not a landmark bug.

**Namesake collisions are the failure mode here** and they fail silently — you
just get a landmark in the wrong state and no error. A ten-name probe returned
49 wrong rows out of 58. A bbox filter is necessary but not sufficient: "Mount
Baker" *inside* our bbox is a Seattle neighbourhood. Resolve by Wikidata Q-ID;
use the bbox as an assertion. `loadLandmarks()` re-checks and drops offenders
with a warning.

### 2.7 `src/world/terrain.js` — the ground

```js
createTerrain(scene, opts?) -> Promise<{
  group,                       // THREE.Group, named 'terrain'
  getHeightAt(x, z) -> metres, // MUST delegate to getElevationLocal — see §1.4
  update(camera) -> void,      // per-frame LOD / streaming
  converge(x, y, z) -> passes, // run LOD selection to a fixed point
  stats() -> LodStats,         // diagnostics; not per-frame, nothing imports it
  dispose() -> void
}>

LodStats = { nodes, built, drawn, triangles, finestCellM, byLevel[], tau }
```

```ts
opts = {
  viewRadiusM = 90000,   // must exceed 84 km or Mount Rainier is off the map
  segments = 512,
  bbox = REGION_BBOX,
  zoom = DEM_ZOOM,
  loadDem = true,
  exaggeration = 1,      // KEEP AT 1. Anything else makes the terrain a lie.
  seaLevelM = SEA_LEVEL_M,
  detail = true,         // load every finer DEM level the manifest declares
  water = true,          // draw the sea plane and the freshwater lake quads
  landcover = true,      // load the baked NLCD rasters and let them drive albedo
  lodQuality = 1,        // scales the whole LOD error budget — see below
  originX = 0,           // where to build the first full chunk set, local
  originY = 400,         //   metres. The default is already correct because
  originZ = 0,           //   the scene origin IS the spawn (§1.3); it only
                         //   matters if someone moves the spawn.
}
```

The returned handle also carries `converge(x, y, z) -> passes`, which runs the
LOD selector to a fixed point around a point in local metres. `createTerrain`
calls it once at bootstrap so frame 0 already has fine ground; `main.js` calls
it again after a teleport, **before** moving the camera, so the camera's
ground-clearance floor reads real terrain rather than the root node.

**`createTerrain` is `async`** — it awaits the DEM so the first rendered frame
already has real ground under the aircraft. It returns `group`, not `mesh`.

**The LOD is driven by a measured error, not by fixed distance rings.** Round 1
subdivided a node while the camera was within `2.5 * nodeSize`, which is the
right rule when the mesh is finer than the data everywhere — as it was at
51.8 m/px. It is the wrong rule now. Each node carries a **geometric error**
probed off the real DEM at creation (the largest vertical gap between its own
lattice and the finer surface under it), and subdivides while
`cameraDistance < err / LOD_TAU`, clamped into `[0.8, 3.2] * nodeSize`. Flat
water collapses; ridgelines hold their children out three times as far.

Two consequences other modules should know about:

1. **`MIN_NODE_SIZE` is 256 (4 m cells), but it is a limit, not a target.**
   `demSpacingAt()` refuses to subdivide a node whose own cells are already at
   or below the finest baked DEM layer covering it, so 4 m cells appear **only
   inside `DETAIL_BBOX`** where the DEM is 6.47 m/px. Everywhere else the tree
   stops at 8 m cells against 12.95 m/px data. `stats().finestCellM` reports
   which you are getting. `lodQuality` deliberately does **not** scale this
   test — no quality setting can make the mesh finer than its source.
2. **Skirt depth is now driven by the node's error, not its cell size.** Under
   fixed rings two neighbours at the same level always switched at the same
   distance, so the level difference across a shared edge was at most one and
   the geomorph closed it exactly. An error metric breaks that symmetry on
   purpose, and the residual at such a seam is bounded by the rougher node's
   error. Verified by readback: rendering straight down over the Cascade crest,
   the Rainier flank, a Puget Sound bluff and KBFI onto a magenta clear colour
   gives **0 background pixels of 540,000** in every case.

The morph target is also per node now (`aMorph.y` is the distance at which the
node's *parent* stops subdividing), because with an error metric there is no
single distance at which a level is swapped out.

Measured against the fixed rings, over four cameras, sampling the drawn surface
against `getElevationLocal`:

| | drawn nodes | mesh-vs-field RMS | worst | normal error |
|---|---|---|---|---|
| ring 2.5 | 586 | 0.858 m | 16.2 m | 6.3° |
| error metric | 694 | 0.670 m | 11.9 m | 5.5° |

and near-field error at KBFI halves, 0.084 m → 0.045 m, from the 4 m cells.
Vertex normals are stored as normalised `Int16`, which pays for the extra nodes:
the cache ceiling is ~199 MB against round 1's ~188 MB.

**The fine shading term is a normal, not more albedo noise, and it is
derivative-based.** Below the finest cell the ground is carried by a procedural
micro-relief field whose world-space gradient is recovered from `dFdx`/`dFdy` of
a *single* noise evaluation by inverting the screen-space Jacobian. One tap
rather than three, no branch, and because derivatives are per 2x2 quad it
antialiases itself — relief finer than a pixel stops contributing instead of
boiling. The three-tap version this replaced cost up to 6.2 ms/frame of GPU on
its own at 1000x562; this costs 0.4–1.4 ms. It must stay out of conditional
flow: derivatives in non-uniform control flow are undefined.

Colour is procedural, but it is **told what it is painting**. Below the treeline
the albedo comes from `geo/landcover.js` (§2.14): class index in, palette colour
plus a near-field structure out.

**A class is painted as a SPAN between two materials, not as one colour**, and
the near-field structure decides where each lot, parcel or stand sits in that
span (§2.14). Three consequences bind:

1. **The delta is zero-mean.** It is measured against the mix the class averages
   to, so nothing about the far field moves when the near field gains variance.
2. **Only the COLOUR taps may wander.** The class fetch takes a `spread`
   argument. Tap A stays at one texel because it decides where the water is, and
   the coastline is geographic truth (§1.5). Taps B and C — spread 2.6 and 5.4,
   blended by noise at 260 m and 95 m — feed the albedo only, and are what
   dissolve the survey's polygon edges without moving a shoreline.
3. **"Industrial" is a reading of two real datasets, not a label.** NLCD grades
   development by imperviousness and has no industrial class, so a container
   terminal arrives tagged identically to an apartment block. Heavy intensity
   *below 30 m of DEM elevation* is the honest reading in this region: it puts
   yards on Harbor Island, Georgetown, Interbay and the Kent valley floor and
   leaves Queen Anne, Capitol Hill and West Seattle residential. Yard and
   warehouse structure keys off that scalar; roof and garden structure off its
   complement. It is a heuristic and it is labelled as one in the shader.

Every structural fade distance is set from the PIXEL FOOTPRINT, `dist * 0.00145`
at 1120x720 and 60 degrees. Round 2 faded the lot grid out from 600 m and the
canopy from 350 m, which switched almost every structural term off at exactly
the altitude the sim is judged from; a 24 m lot is eight pixels wide at 2 km. Above it, elevation and slope keep the last
word, because a 30 m classification has nothing useful to say about a 45° rock
rib — with one exception, NLCD's perennial ice/snow class, which is a survey of
where the glaciers are and beats any snowline estimate. Steep faces still go to
rock regardless of elevation; that is what makes Rainier read as a mountain
rather than a green cone.

Where no raster covers the ground (open ocean, British Columbia) the material
falls back to the elevation-and-slope palette it had before, so the world is
never blank — §1.6.

**Freshwater lakes** need a flat-region heuristic: Terrarium encodes lake
surfaces as perfectly flat areas at their true elevation (Lake Washington ≈ 5 m,
Lake Union ≈ 5 m). Detect near-zero slope over a run of samples at a plausible
lake elevation. Do not use `isWater()` for this; it only finds sea level.

**The water mask is not a pure elevation test, and this is not optional.**
Terrarium's bed under Puget Sound is nominally a flat exact zero, but void
repair and source noise leave broad patches reading +1 to +5 m — measured by
raycast at up to +6.8 m of *drawn* surface in mid Elliott Bay. `height <= 0.5`
therefore scatters phantom islands across open water, and everything downstream
inherits them: shore distance collapses around each one, the deep/shallow
gradient paints rings of pale shallows in mid-channel, and the seabed shows
through the sea plane as hard-edged patches. `buildRegionField` ORs in NLCD's
open-water class wherever the raster covers, and keeps the elevation test as the
fallback outside it.

Consequently the surface shader **discards** fragments more than 180 m offshore
and below 12 m. This does not touch §1.4: `getHeightAt` still returns exactly
`getElevationLocal`, and §1.4 already accepts that the drawn mesh deviates from
the field between vertices. The sea is opaque out there by construction, so
there is nothing to see behind it.

**Inland water is drawn by the TERRAIN, not by a water mesh, and it has to
reflect the sky.** Three things can be open water here and only two of them get
a surface: the sea plane, which is flat at sea level, and the lake meshes, which
come from a detector that only accepts a flat closed local minimum above
0.25 km². Every tidal channel, river and creek mouth falls between them — the
Duwamish Waterway is class "Open Water" with its surface at 4.84 m, well above
the 0.25 m sea plane, and it is a river, so the lake detector correctly refuses
it. Nothing covered it and the terrain painted it with the palette's flat, unlit
open-water albedo: a hard black gash from Elliott Bay down through Georgetown in
every view of the city, and the same along every inlet in the region.

The fix is not a brighter albedo — water really is almost black in albedo. What
makes it read as water rather than as a hole is that it reflects the sky, which
is what the two real water shaders do. The terrain now does the cheap version of
the same thing for water-classed ground standing **above** the sea plane: a
Fresnel blend from a deep-water base toward `uSkyColor`, which is
`scene.fog.color`, the same value the sea reads, republished every frame. Measured
over the Duwamish at 300 m: 5th-percentile luminance 50.0 → 88.1, with the
median unmoved (103.9 → 102.5) — the dark tail filled in, nothing else brightened.

**If you add a uniform to the terrain material that sky.js owns, publish it from
`update()`.** `uSkyColor` is rewritten every frame for the same reason the sea's
copy is: sky.js moves it whenever the sun moves, and a stale copy leaves every
river reflecting noon at dusk.

### 2.14 `src/geo/landcover.js` — what is on the ground

```js
loadLandcover() -> Promise<{
  region, detail,             // {texture, rect, texelM, width, height, data} | null
  palette,                    // 16x4 RGBA DataTexture, one row per line below
  classAtLocal(x, z) -> idx,  // -1 where no raster covers
  isOpenWaterLocal(x, z) -> boolean,
  manifest, dispose()
} | null>                     // null when nothing is baked
```

Two layers, same arrangement as the DEM: `region` at ~81 m/texel over the whole
bbox, `detail` at ~20 m/texel over the Seattle inset. Encoding is documented in
the file header and in `public/landcover/manifest.json`; the short version is
`R` = NLCD code (provenance), `G` = compact class index (what the shader
indexes), `B` = road mask.

**The palette is four rows, and a class is a SPAN rather than a colour.**

| row | v | contents |
|---|---|---|
| 0 | 0.125 | `albedo` — the class mean. What the far field paints. |
| 1 | 0.375 | `(rough, detail, form / 2, canopy)` |
| 2 | 0.625 | `hard` — the built / bare / lit end, alpha = `hardMix` |
| 3 | 0.875 | `soft` — the vegetated / shadowed end, alpha = `vary` |

Rows 2 and 3 exist because no real land-cover class is one material.
"Developed, Low Intensity" is roofs AND gardens; a fir stand is sunlit crown AND
the near-black gap between crowns. What a pilot at 1,000 ft reads is the
CONTRAST between the two at the scale of a lot or a stand, not the average — and
round 2 measured a downtown block interior at sRGB 99,101,101, perfectly
neutral, against a class albedo of 80,84,65. The mean was never the problem.

`terrain.js` mixes `hard` ↔ `soft` per lot, per parcel or per stand and adds the
result as a **zero-mean delta** measured against `mix(soft, hard, hardMix)`. That
is the invariant to preserve if you retune the table: the far field must not
move, because at 8 km a lot is a fifth of a pixel and `albedo` is the only
honest answer there.

Three properties of the textures are load-bearing: `colorSpace = NoColorSpace`
(an sRGB curve applied to a class *index* turns class 9 into class 2),
`NearestFilter` with no mipmaps (linear filtering an index map invents a texel
of barren rock along every boundary — the shader dissolves the grid with a
noise-jittered lookup instead), and `flipY = false` so image row 0 is north.

Verified by `npm run check:landcover`, which asserts the class at places whose
answer is known independently — Rainier's summit is ice, mid Elliott Bay is
water, the Space Needle stands in high-intensity development. That is the only
defence against a georeferencing error, which otherwise renders beautifully and
puts the forest where the city is.

### 2.8 `src/world/sky.js` — atmosphere and all lighting

```js
createSky(scene, renderer, opts?) -> {
  update(dt, sunAngle?) -> void,
  setTimeOfDay(t) -> void,     // 0=midnight, 0.25=sunrise, 0.5=noon, 0.75=sunset
  getTimeOfDay() -> number,
  sunLight,                    // THREE.DirectionalLight  (read-only to others)
  ambientLight,                // THREE.HemisphereLight   (read-only to others)
  sunDirection,                // THREE.Vector3, unit, scene -> sun
  shadows,                     // the §2.15 handle, or null when opts.shadows=false
}
```

```ts
opts = { turbidity = 8, fogDensity = 8e-6, timeOfDay = 0.42,
         sunDistance = 120000, sunAzimuthDeg = 180, dayLengthSec = 0,
         rayleigh = 1.2, mieCoefficient = 0.002, exposure = 0.95,
         fogViewBlend = 0.7, cloudLayers = 8, cloudShearM = 900,
         cloudRadiusM = 34000, cloudHandoverM = 12000, ambientIntensity = 0.66,
         shadows = true, shadowQuality = 'high', aircraftReceivesShadow = true }
```

**THE NEAR/FAR CLOUD HAND-OVER IS PROPORTIONAL, AND THE FAR DECK IS NEVER
CLAMPED.** Both rules exist because of the same artifact, and both are easy to
undo by accident.

The deck has two representations (see the file header): `cloudLayers` horizontal
slabs near the camera, and an analytic ray/plane intersection on the sky dome
beyond. Round 2 crossed them over across a fixed 4 km band and clamped the
dome's ray length at 120 km. Near the horizon a flat deck sends the ray length
to infinity, so **every** ray in the last fraction of a degree hit that clamp;
once the range is constant the hit point sweeps a circle of fixed radius and
cloud density becomes a function of AZIMUTH ALONE, which draws the deck as
vertical bars with hard edges in a band above the horizon. The same geometry
turned the fixed 4 km cross-over band into eight hard rings — one per slab —
stacked inside about a degree of sky.

So: the band runs `[H, H * CLOUD_HANDOVER_WIDTH]` (2.6, i.e. 12–31 km), which is
constant in log-range and therefore a real angular gradient wherever it is seen;
each slab's `H` is staggered by the golden-ratio sequence so no two edges can
line up; and the dome fades the deck's alpha out between 55 and 105 km, where it
subtends a third of a degree and is 80% airlight, so the clamp beyond it never
has anything left to draw. `cloudRadiusM` must stay comfortably above
`cloudHandoverM * CLOUD_HANDOVER_WIDTH` or the slab's own square edge appears.

Measured on the matched 610 m downtown camera, mean |dLuma/dx| in the sky-only
band immediately above the horizon: **0.673 → 0.427**, p99 6.14 → 4.86, and the
bars are absent from a 14-degree-fov readback that showed them plainly before.

**Ambient is 0.66, not 1.05.** At 1.05 against a sun of 2.6 a horizontal surface
took 41% of its light from a near-white hemisphere, which bleached the ground's
chroma — see the 99,101,101 measurement in §2.14. 0.66 puts the diffuse fraction
near 30%, closer to the measured clear-sky diffuse-to-global ratio at this
latitude. Do not raise `sunIntensity` to compensate: `check-sky.mjs` ties the
cloud-top brightness to `sunLight.intensity / 2.6`.

This module owns `scene.background`, `scene.fog` and **every light**. No other
module may add one. `sunLight` / `ambientLight` are exposed so others can read
the sun direction (lens flare, water specular, shadow framing) — read them, do
not reparent them or change their intensity; both are rewritten every frame.

Two additional named exports, for harnesses and tools, not for the render loop:
`sampleSky(dir, sunDir, opts?, out?)` returns the dome's tone-mapped colour in
one direction, and `aerialTransmittanceJs(camY, fragY, dist, density, out)` is
the CPU mirror of the fog shader. `npm run check:sky` is built on both.

**sky.js REPLACES three's four `fog_*` ShaderChunks, globally, at module load.**
This is the one thing in the codebase that reaches outside its own file, and it
is here because `scene.fog` is this module's to define (§1.7) and because every
fogged material in the scene has to agree about what distance does. The chunks
stay `#ifdef USE_FOG`-guarded, so anything with `fog: false` — the sky dome, the
cloud slabs, all of three's depth and shadow materials — compiles unchanged.

Consequences you must know about:

- **`fog_vertex` writes a second varying, `vFogWorldY`,** and redefines
  `vFogDepth` as RADIAL distance rather than `-mvPosition.z`. Any hand-written
  `ShaderMaterial` that includes `<fog_vertex>` must also include
  `<fog_pars_vertex>`, as three's own materials do.
- **The composite runs in display-encoded space,** after
  `<colorspace_fragment>`, exactly where three's own fog runs.
- Adding a material with `fog: true` is enough to opt in. There is nothing to
  call and no uniform to set.

**Fog density is a visibility budget, not a mood setting.** It is now the
sea-level extinction of the **green** channel, per metre; red and blue follow
from λ⁻⁴, and a second aerosol species with a 1.2 km scale height rides on top
of the 8 km molecular one. Because the model integrates the column between the
CAMERA's altitude and the FRAGMENT's, range alone no longer determines haze —
valleys haze more than the ridges above them. Mount Rainier at 94 km, camera at
600 m, `fogDensity = 8e-6`:

| | transmittance R / G / B | rock | snow |
|---|---|---|---|
| summit, 4,390 m | 0.72 / 0.51 / 0.25 | sRGB 175,196,221 | 239,242,245 |
| base, 900 m | 0.58 / 0.36 / 0.14 | sRGB 190,209,231 | 238,241,244 |
| round 1, `FogExp2 1.1e-5` | 0.34 flat | sRGB 204,205,205 | 235,239,242 |

The row that matters is the last one: one scalar density gives distant rock a
**neutral grey** 31 sRGB below snow. Two species with λ⁻⁴ give it a **blue** 64
below. Distance now reads as distance and not as a wash. If you change the
density, re-derive against that table — `npm run check:sky` asserts it.

**`fogHeightScaleM` is now inert.** It scaled a single density by
`exp(-camY/H)`; the model integrates the real profile at both ends and applying
it as well would count the same physics twice. The option is kept so existing
callers do not break.

**The airlight colour follows the camera's heading.** `scene.fog.color` is one
value per frame, so it is sampled from the model 2.5° above the horizon along
the camera's bearing, blended `fogViewBlend` of the way from the azimuthal
average. Round 1 used the average alone, which is why a low sun had no warm
limb: the average of a copper western sky and a slate eastern one is grey.
Consumers that read `scene.fog.color` — `terrain.js` does, for the sea's
grazing-angle reflection — now get a value that changes when the pilot turns.
That is intended.

**sky.js also claims `scene.onBeforeRender`.** It chains any handler already
there and calls `shadows.update(camera)` from it. That hook is the only place in
a three render that runs AFTER `scene.updateMatrixWorld()` and
`camera.updateMatrixWorld()` and BEFORE `projectObject()` and
`shadowMap.render()` — which is exactly the window a shadow camera has to be
fitted in. Using it is why §2.15 needs no line in `main.js` at all. If you add
your own `scene.onBeforeRender`, chain it; do not replace it.

### 2.15 `src/world/shadows.js` — cascaded shadow maps

```js
createShadows(scene, renderer, opts?) -> {
  lights,                      // THREE.DirectionalLight[], the cascade carriers
  update(camera) -> void,      // fit + tag. sky.js calls this, nobody else should
  setQuality(name) -> void,    // 'off' | 'low' | 'medium' | 'high'
  getQuality() -> string,
  setEnabled(on) -> void,
  getStats() -> object,        // per-cascade extent, texel size, bias, render share
  dispose() -> void,
}
```

**Constructed only by `sky.js`.** A shadow-casting cascade is a light, and §1.7
says sky.js owns every light. Reach it as `sky.shadows`.

`castShadow` / `receiveShadow` are **not yours to set**. shadows.js traverses the
scene each frame and tags what it finds, because terrain creates and destroys
~1,500 meshes as the LOD moves and nothing set once at boot would survive that.
Its rules: everything under the `sky` group and the two water surfaces neither
cast nor receive; `terrain-*` receives always and casts only through a
morph-aware depth material; everything else — the aeroplane, the runways, the
landmarks, whatever a buildings module adds — casts and receives. **Name your
meshes** and they will be tagged correctly with no change here.

The cascade lights carry `intensity = 0`. They exist to own a shadow map;
`sunLight` remains the only source of sunlight, so the contract above is intact.

Four cascades at 'high': 0.35–70 m at 8 cm/texel, 70–300 m at 34 cm, 300–1200 m
at 1.4 m, 1200–12000 m at 13 m. Past 12 km the sun term is plain N·L. Cascades 2
and 3 re-render every third frame on opposite phases; a stale cascade is
incomplete, never wrong (its map and its shadow matrix are frozen together, so a
point that has left its box reads as lit).

**shadows.js takes terrain.js's vertex morph out of terrain.js's own material at
run time** rather than copying it — `extractTerrainMorph` calls the surface
material's `onBeforeCompile` on a probe made of the three `#include` markers it
patches (`common`, `beginnormal_vertex`, `begin_vertex`) and slices the injected
text back out. It has to: three's shadow pass draws casters with a
MeshDepthMaterial that knows nothing about CDLOD morphing, and the morph is a
function of `cameraPosition`, which in a shadow pass is the LIGHT. If terrain.js
ever stops patching those three chunks the extraction returns null, terrain
stops casting, and the console says so. **A hand copy of the morph was the first
version and it was stale within the hour** — the terrain agent rewrote the morph
from a cell-size window to a per-node error-driven one in the same session.

Verified by `node scripts/check-shadows.mjs` — 54 assertions, no GPU needed:
the slice bounding spheres really bound their slices at every fov the sim uses,
the cascade weights sum to exactly 1 through every seam, a 0.1-texel camera move
does not move the map at all and a large one lands on a whole number of texels,
a 360° roll does not resize any cascade, and the extractor refuses rather than
guesses. It runs in `npm run check:all`.

### 2.9 `src/aircraft/model.js` — the visual airframe

```js
createAircraft(scene) -> {
  group,                                     // THREE.Group, named 'aircraft'
  setControlSurfaces({pitch, roll, yaw}),    // each -1..+1, normalised STICK
  spinProp(rpm, dt),
}
```

Purely cosmetic. It **never moves its own group** — `main.js` copies the flight
model's position and orientation onto it each frame. `setControlSurfaces` takes
normalised stick deflection, not angles, and has no effect on physics.

Body axes: `-Z` nose, `+X` right wing, `+Y` up.

### 2.10 `src/physics/flightModel.js` — the only owner of aircraft state

```js
createFlightModel(opts?) -> {
  state,                                      // mutated in place; hold the ref
  step(dt, inputs, groundHeight) -> state,
  reset(lat?, lon?, headingDeg?) -> void,
}
```

```ts
opts = {
  startLat, startLon, startHeadingDeg,   // default KBFI 32L, ~330.13
  startAltitudeAglM = 0,                 // 0 = on the wheels
  startAirspeedMs = 0,
  groundHeightFn = () => 0,              // MUST be terrain.getHeightAt — §1.4
  gearHeightM = 1.2, massKg = 1100, wingAreaM2 = 16.2,
  maxSpeedMs = 85, stallSpeedMs = 25, idleRpm = 700, maxRpm = 2700,
}
```

`state` — metric primaries for physics, display fields for the HUD:

```ts
// metric
position: Vector3      // metres, scene space
velocity: Vector3      // m/s, world frame
orientation: Quaternion
angularVelocity: Vector3  // rad/s, body frame
airspeedMs, alphaRad

// display
airspeedKts, altitudeFt, altitudeAglFt, verticalSpeedFpm,
headingDeg, pitchDeg, rollDeg, rpm, stalled, onGround,
flaps, brakes, loadFactor

// airframe integrity — `crashed` is a LATCH, only reset() clears it
crashed, crashReason, crashDetail,       // '' | terrain | gear | overstress | overspeed
impactSpeedMs, impactLoadFactor, overspeed,
terrainSlopeDeg, gearStrokeMaxM, gearBottomed

// geodetic mirror, recomputed every step
lat, lon
```

**The terrain is solid.** A gear leg is a spring with a stop; past
`config.gearStrokeM` it is structure, and structure that meets the surface at
more than `config.crashClosingMs` **measured along the local surface normal**
fails. Anything past `config.crashLoadFactor` fails too, as does anything past
1.3 × Vne indicated. When it does, `state.crashed` latches, the wreck stops
where it hit, and `step()` stops doing aerodynamics. Nothing un-crashes an
aeroplane except `reset()`.

`step()`'s `groundHeight` argument is the **reference** sample and still must be
`terrain.getHeightAt` (§1.4). It is no longer the only sample: the model calls
the same `groundHeightFn` once per wheel per substep near the ground, plus four
times per frame around the datum for the surface normal. Same sampler, same
surface, more questions — which is what a slope and a cliff face require. A
one-frame spike in the reference sample is deferred until a second frame
confirms it, so a DEM void cannot move the aeroplane and a cliff still can.

`altitudeFt` is MSL (`y = 0` is sea level). `altitudeAglFt` is above the terrain
directly below — with real elevation the ground moves, so an altimeter alone
tells you nothing about whether you are about to hit Rainier.

**Both altitudes are measured at the WHEELS, not the CG datum.** Parked at KBFI
that is the difference between reading 21 ft (correct, and what acceptance
check 2 asks for) and 24.6 ft. A resting aircraft therefore shows
`altitudeAglFt ≈ -0.3` — the gear springs' static compression, about 11 cm —
and that is right, not a sinking bug.

`reset()` takes an optional fourth argument,
`placement = {altitudeAglM?, altitudeMslM?, airspeedMs?}`, so `main.js` can put
the aircraft airborne at a named place. `altitudeMslM` is floored at 30 m AGL:
asking for 11,000 ft near Rainier must never spawn you inside the mountain.

`reset()` takes **lat/lon, not scene metres**, so callers can say "put me on
KBFI 32L" without knowing where the origin is. All three arguments are optional
and fall back to the `start*` options, keeping "press R" working. It projects
through `coords.llToLocal` — pure maths, no I/O — so this module stays
synchronous and testable.

`inputs`: `{pitch, roll, yaw}` each `-1..+1`, `{throttle, flaps, brakes}` each
`0..1`. `dt` is clamped internally to 0.1 s. Nothing outside this module writes
to `state`.

### 2.11 `src/ui/instruments.js` — the display boundary

```js
createInstruments(container, opts?) -> {
  update(state, inputs?), dispose(), root,
  getLayout() -> 'panel' | 'compact',
  setLayout('auto'|'panel'|'compact') -> layout,
}
COMPACT_QUERY   // '(max-width: 820px), (max-height: 460px)'
TOUCH_RESERVE   // {landscape:{w:200,h:200}, portrait:{w:200,h:260}}  CSS px
pickLayout(pref?) -> 'panel' | 'compact'
opts = { layout: 'auto' }   // 'auto' also honours ?hud=compact|panel
```

The **only** place in the codebase allowed to speak imperial. Reads the
pre-computed display fields; never does physics, never converts units itself,
never writes back to `state`. Owns its own child nodes and must not clear
siblings.

**TWO LAYOUTS, PICKED BY VIEWPORT — NEVER BY TIER AND NEVER BY USER AGENT.**
`panel` is the seven-dial strip. `compact` is a moving-tape HUD: airspeed tape
left, altitude tape plus VSI bar right, heading strip top, attitude ball
bottom-centre, and the rest demoted (turn rate and slip fold into the ball,
the tachometer into a bar with the same redline, radio altitude under the
altimeter). The stall warning is promoted OUT of the panel into a banner
across the top. Dropped on a phone: Hobbs, Kollsman, three greens on a
fixed-gear aeroplane, lat/lon.

Measured at 812x375, which is an iPhone in landscape: the seven-dial strip
renders **508 x 101 px — 67.5 px dials, 6.0 px airspeed numerals and 4.0 px
data-strip labels**. That is the whole argument. The compact HUD's primary
readouts render **24 / 21 / 17 px** (airspeed / altitude / heading) and the
whole HUD covers **20.9%** of the screen against the strip's 16.9%.

The breakpoint is deliberately **not** `device.js`'s tier: a desktop window
dragged narrow has the same problem, `?tier=phone` on a desktop must still be
measurable, and a tablet at 1180x820 legitimately fits the dials. Verified
live: `?tier=desktop` at 812x375 still gets the compact HUD.

**`TOUCH_RESERVE` is a contract with `controls/input.js`'s touch layer.**
Nothing `instruments.js` or `overlay.js` draws enters a `w x h` rectangle in
either bottom corner, measured inside the safe-area insets. The numbers are
measured against the shipped touch layer, not guessed — at 667x375 its stick is
`(14,194) 113x113` and its throttle `(577,177) 76x130`, both inside 200x200;
at 375x812 its topmost control is 243 px off the bottom, inside the portrait
260. In portrait the whole bottom 260 px is left clear and the measured
clearance between the two layers is 25 px.

**Safe areas are live in both layouts**, and `overlay.js` adds
`viewport-fit=cover` to the viewport meta at construction — without it every
`env(safe-area-inset-*)` in this project is a hard zero on iOS and a
safe-area-aware layout is indistinguishable from one that never tried.

Swapping layouts keeps the smoothed values, so rotating a phone re-draws the
same readings instead of sweeping every needle up from the stop. Asserted by
`npm run check:instruments` — 117 assertions, of which 59 are the compact HUD,
the layout swap and the thumb zones.

### 2.12 `src/controls/input.js` — a pure sensor

```js
createInput(domElement) -> { get(), dispose() }
get() -> {pitch, roll, yaw, throttle, flaps, brakes}
```

`get()` returns the **same object every call**, mutated in place — consume it
within the frame, do not stash it. Timing is derived internally, so it takes no
`dt`. Never touches the scene, the flight model, or the DOM beyond listeners.

Bindings: `W/S` or `↑/↓` pitch · `A/D` or `←/→` roll · `Q/E` yaw ·
`Shift`/`Ctrl` throttle · `X` idle · `Z` full · `F` flaps · `B` brakes ·
`G` gear · `M` mouse yoke.
App-level keys live in `main.js`: `C` camera, `R` reset, `P`/`Esc` pause,
`T` time of day, `N` mute, `H` help, `1`–`4` jump to a place. `V` (panel view)
lives in `cameras.js`.

`setThrottle(v)` / `setFlaps(v)` are additive: they let `main.js` set the levers
when it teleports the aircraft, because arriving at 3,000 ft with the throttle
closed is a glider start, not a cruise.

**Every keyboard listener resolves its key through `core/keycode.js#eventCode`,
never `e.code` directly.** `e.code` is the right thing to bind to — it names the
physical key, so WASD keeps its shape on any layout — but it is the empty string
on virtual keyboards, some IME and accessibility paths, remote-desktop clients,
and synthetic events. Binding to it alone means those users get an aircraft that
silently does not respond: the events arrive and match nothing, and there is no
error to find. `eventCode` prefers `code` and falls back to a code synthesised
from `e.key`.

### 2.13 `src/camera/cameras.js` — the view rig

```js
createCameras(aircraftGroup, renderer) -> {
  active,              // MUTABLE PROPERTY, reassigned by cycle()
  cycle() -> string,
  update(dt, state) -> void,
  onResize() -> void,
}
```

**`active` is a property, not a getter.** `cycle()` reassigns it, so the render
loop must read `cameras.active` fresh every frame and never cache it across
frames.

Modes: chase · cockpit · external. Cockpit rolls with the airframe; outside
views keep the horizon level.

**Near/far are a geographic requirement.** `NEAR = 0.35` (the cockpit sits
inside the airframe), `FAR = 300000` (Rainier at 84 km, terrain corners at
~127 km). That ratio is far past a 24-bit depth buffer, so `main.js` **must**
construct the renderer with `logarithmicDepthBuffer: true`. Without it, distant
terrain z-fights into a shimmering mess.

### 2.16 `src/geo/buildings.js` — real footprints

```js
SRC_PUBLISHED, SRC_DSM, SRC_DERIVED   // 0, 1, 2
SOURCE_NAMES                          // ['published', 'dsm', 'derived']

loadBuildings()      -> Promise<BuildingSet|null>   // idempotent, null if unbaked
getBuildings()       -> BuildingSet|null
isBuildingsLoaded()  -> boolean
buildingProvenance() -> {published, dsm, derived, total} | null
srcOf(i)             -> 'published' | 'dsm' | 'derived'
centroidLatLon(i, out?) -> {lat, lon}       // AREA centroid, not vertex 0
nearestBuilding(lat, lon, maxDistanceM?) -> {index, distanceM, heightM, areaM2, source} | null
coversLatLon(lat, lon)  -> boolean
decodeBuildings(data)   -> BuildingSet       // TEST SEAM, see below
```

```ts
BuildingSet = {
  count, totalVertices,
  anchorLat: Float64Array,   // ring vertex 0, degrees
  anchorLon: Float64Array,
  ringStart: Uint32Array,    // count+1; ring i is [ringStart[i], ringStart[i+1])
  ringE: Float32Array,       // metres EAST of that building's anchor
  ringN: Float32Array,       // metres NORTH of it
  heightM: Float32Array,     // above the building's own base
  areaM2: Float32Array,      // from the real polygon
  src: Uint8Array,           // SRC_*
  bbox, meta,
}
```

**23,979 real Microsoft Building Footprints**, baked by
`scripts/bake-buildings.mjs` over the same Seattle inset as the DEM's z=14 layer
and the land-cover detail layer (47.35–47.75, −122.5 to −122.1). Round 1 drew
downtown as a rotated grid of boxes, and the geographic critic went straight to
it: *"individual buildings are not real"*. Now every polygon is — position,
outline, orientation and area come from the source and are changed only by a
documented simplification (0.4–1.4 m Douglas–Peucker, 7% of vertices removed).

**THE HEIGHTS ARE MOSTLY NOT REAL, AND EVERY BUILDING SAYS SO.** `srcOf(i)`
returns one of three, and the counts are asserted against the per-building tags
by `npm run check:buildings`:

| `src` | n | what it is |
|---|---|---|
| `published` | 32 | a published architectural height, matched to this footprint by proximity |
| `dsm` | 13,761 | a STOREY COUNT read off Microsoft's photogrammetric surface model, trusted only below 18 m |
| `derived` | 10,186 | footprint area and distance to a district core, through the model in the baker |

**The source's `height` field is a trap and it was measured, not assumed.** The
global-buildings release carries a DSM-derived height for every polygon. It
saturates: the tallest value anywhere in the 44 × 30 km inset is **35.3 m**, and
Columbia Center — 284 m — reads **25.1 m**. Above `DSM_TRUST_M` the field is
**discarded, not rescaled**, because rescaling a saturated sensor invents exactly
the numbers we are trying not to invent. Below it, only the storey count is
taken, never the metres. Full table in the baker's header.

**Ring vertices are metres from the building's anchor, not degrees.** The scene
projection is an anchored equirectangular with both metres-per-degree factors
frozen at `SCALE_LAT` (§1.3) — a uniform affine map — so a metre offset computed
at bake time is the same offset at runtime anywhere in the region, and the
runtime never projects a vertex. `buildings.json` records the `scaleLat` it was
baked at and the loader **refuses the file** if `coords.js` has moved: a 1°
drift is a 1.3% scale error on every building in the world, too small to see and
too large to be right.

**`decodeBuildings` is not a second front door.** The browser path reads the
file through `fetch`, which Node cannot do, so without it the decoder — the one
piece of code that can turn every footprint into the wrong shape — would be
assertable nowhere. `scripts/check-buildings.mjs` runs the shipping decoder and
the shipping extruder against the real baked file and the real DEM tiles.

### 2.17 `world/landmarkModels.js#buildDowntownMass` — the city

```js
buildDowntownMass(opts?) -> THREE.Group        // named 'downtown-mass'
buildProceduralCityMass(opts?) -> THREE.InstancedMesh|null   // the §1.6 fallback
cityStats                                       // live binding, null until built
```

```ts
opts = {
  exclude: [{x, z, radiusM}],   // keep-out discs, normally the modelled landmarks
  real: true,                   // false forces the procedural fallback
  seed,                         // fallback only
}
```

**SELF-POPULATING, like `placeLandmarks`.** It returns an EMPTY group
immediately and fills it once the footprints resolve, starting that load itself.
`group.children` is empty on the calling frame — do not measure it there. This
is a change from round 1, which returned an `InstancedMesh` synchronously;
`landmarks.js` does `const mass = buildDowntownMass(...); if (mass) group.add(mass)`
and a Group satisfies both lines unchanged, so **nothing outside these files
moves**.

**Merged, not instanced.** Instancing needs one shape and the whole point is
that every shape is different. One indexed `BufferGeometry` per 3 km chunk, 131
chunks, built once in ~150 ms: 626k triangles, 29.8 MiB of buffers. Vertices are
relative to the chunk centre so a 25 km-out chunk keeps millimetre float
precision and a tight bounding sphere for culling.

**Three distance tiers, and the boundaries are measured.** `THREE.LOD` does the
switching, and the renderer calls `LOD.update(camera)` itself during
`projectObject` — so there is **no new per-frame contract in main.js**.

| tier | contents | cutoff | why |
|---|---|---|---|
| `city-tall` | ≥ 50 m | none | from Mount Rainier, 84 km out, hiding the whole city changes 292 of 562,000 pixels. That is the downtown silhouette above the haze, and it is all buildings over ~50 m. They live in 6 chunks. |
| `city-major` | ≥ 22 m or ≥ 1,400 m² | 25 km | everything the pixel measurement says is invisible at that range. Cutting it took the city at Rainier from 125 draw calls / 275k triangles / 2.86 ms to **6 calls / 11.7k triangles / 0.00 ms**. |
| `city-minor` | the rest | 6 km | a 9 m house at 6 km subtends 0.09°, about one and a half pixels at 1000×562. |

**Winding is derived, not guessed.** For a triangle p0p1p2 the cross product's
Y component is exactly minus the shoelace sum in (x, z), so a ring arranged to
have NEGATIVE signed area gives an up-facing roof; with that fixed, emitting
each side quad as (bottom-i, bottom-i+1, top-i+1, top-i) puts every wall normal
outward. Reverse either and the city renders inside out, which back-face culling
turns into a city of holes — visible only from some angles, and never in a
still. `check-buildings` asserts every triangle's index winding against its
stored normal.

**46 of the 23,979 source rings pinch** — they touch themselves where a light
well or a covered walkway was traced as a zero-width spur — and ear clipping
correctly refuses them. Those get a **convex-hull roof**, which can only
over-cover into the polygon's own concavities and never past its extent. A fan
over the raw ring was tried and throws triangles well outside the building.

**Facade shading is shared with the fallback.** Storey banding at 3.6 m,
structural bays at 2.4 m, dark roofs, a parapet line and a darkened ground
floor, three material families, all fading out past 2.6 km. Two things changed
from round 1: the bay coordinate is now a per-vertex `aAlong` (true distance
along each wall) rather than a world axis, because with real footprints most
walls run at 30° to the axes and axis-aligned bays shear at every corner; and
`aUp`/`aDown` are METRES above ground and below the roof rather than fractions
of height, because a fraction makes a 200 m tower's parapet 3 m tall and a 9 m
shop's 14 cm. Their sum is the building's height, which is how the shader tells
a house from an office block without a fourth attribute.

**Buildings are buried, not balanced.** The base is the DEM's minimum over
*every* ring vertex, minus 3.5 m. Sampling every eighth vertex was tried and
leaves 1.07 m of float on the worst building in the city: on a Queen Anne
hillside the DEM between two sampled vertices drops further than the slack
covers. The 3.5 m is for the pager (§2.4) — a building built while only the
51.8 m/px base covers its cell will see its ground improve by a metre or two.

**Measured cost at 1000×562, `renderer.info` and interleaved A/B with
`gl.finish()`** (four agents share this Mac; the absolute frame time swings 3×
with contention, so both a quiet-window and a contended figure are given):

| viewpoint | frame, city on | city's share | city draw calls | city triangles |
|---|---|---|---|---|
| KBFI 32L, parked | 8.17 ms (122 fps) | +2.01 ms | 99 | 236k |
| 400 m over Seattle Center, nose down the CBD | 6.54 ms (153 fps) | +0.95 ms | 129 | 674k |
| 700 m over Elliott Bay, whole skyline | 8.02 ms (125 fps) | +2.75 ms | 107 | 414k |
| 11,000 ft at Mount Rainier | — | **0.00 ms** | 6 | 11.7k |
| 400 m over the CBD, machine at load 4 | 15.33 ms floor (**65 fps**) | +2.71 ms paired median | 115 | 634k |

### 2.18 `src/core/device.js` — the tier, and every budget derived from it

```js
TIER_PHONE, TIER_TABLET, TIER_DESKTOP, TIERS      // ordered: smallest budget first
PHONE_MAX_SHORT_EDGE_CSS_PX                        // 600
PHONE_*                                            // every phone budget, named
PHONE_SHARES                                       // per-subsystem allocation
BUDGETS                                            // {phone, tablet, desktop} -> Budgets

probeWebGL(makeCanvas?) -> caps | null   // creates a context, then LOSES it
readSignals(env?)       -> DeviceSignals // env is injectable; Node-safe
classifyTier(signals)   -> tier          // PURE. no UA, no side effects
isTouchPrimary(signals) -> boolean
budgetTierFor(signals, tier?) -> {tier, reasons}   // capability derate, one step
budgetsFor(tier)        -> Budgets       // unknown name -> desktop (§1.6)
readTierOverride(search?, storage?) -> tier | null
resolveDevice(opts?)    -> {tier, detectedTier, budgetTier, budgets, signals,
                            derated, derateReasons, overridden, touch}
effectivePixelRatio(budgets, dpr, cssW, cssH) -> number
describeDevice(resolved) -> string       // one line, for the console
```

**No imports, no three.js, no DOM at module scope**, so `check-device.mjs`
runs the shipping classifier in Node against synthetic devices. Keep it that
way — it is the only reason the tier rules are assertable at all.

**THE USER-AGENT IS NEVER A CLASSIFICATION SIGNAL.** It is recorded as
`signals.uaHint` for bug reports and `classifyTier` does not read it.
`check-device.mjs` classifies all twelve fleet devices under twelve UA
permutations each and asserts the tier never moves. Two live reasons: the
browser-pane `mobile` preset sets an **Android UA on a desktop GPU**, and
iPadOS ships a **desktop Safari UA on a tablet** — a UA check is wrong in both
directions at once. Capability beats UA.

The rules, and the two guards that matter:

```
touchPrimary = maxTouchPoints >= 1 && (pointer: coarse)
               && NOT ((any-pointer: fine) && (hover: hover))

maxTouchPoints >= 1 && (any-pointer: coarse) && shortEdge < 600 -> phone  [floor]
!touchPrimary                                                   -> desktop
touchPrimary && shortEdge < 600                                 -> phone
touchPrimary && shortEdge >= 600                                -> tablet
```

The mouse term is what stops a **desktop with a touchscreen** — ten touch
points — being handed a phone budget. The floor runs *before* it, because iOS
genuinely switches the primary pointer to fine when a Bluetooth mouse is paired,
and a **phone handed a desktop budget is a tab iOS Safari kills mid-flight**.
`shortEdge` is `min(screen.width, screen.height)`, so neither rotating the device
nor resizing the window can change the answer.

`classifyTier` reports the honest device class; `budgetTierFor` may hand it a
smaller tier's budget when the probe says the class average is optimistic
(`deviceMemory <= 2`, `MAX_TEXTURE_SIZE < 8192`, no linearly-filterable float
textures, no WebGL at all). One step down, never two, never up. `deviceMemory`
absent is **not** small — Safari does not expose it.

**The phone budgets, and what each one is cut from.** Full derivations live in
the file; these are the numbers other modules must hit.

| budget | phone | desktop | why |
|---|---|---|---|
| JS heap | **160 MB** | 352.8 measured | 200 MB iOS floor − 40 MB GPU/DOM reserve |
| DEM resident | **48 MiB** | 96 MiB | 238 pinned + 96 @z13 + 48 @z14 = 47.75 MiB |
| triangles/frame | **460,000** | 1,836,118 | 45 Mvert/s × 33.3 ms ≈ 31% of the frame |
| draw calls | **120** | 432 | ~60 µs/call through Metal = 7.2 ms |
| shader programs | **45** | 65 | each is a first-use main-thread compile stall |
| pixel ratio | **1.5** (≤1.2 Mpx) | 2 | DPR 3 is 9× the pixels; 1.5 is 4× fewer |
| shadows | **off** | 4 cascades | one cascade is ~35 calls of a 120 budget |
| terrain `lodQuality` | **0.40** | 1 | nodes ∝ q²; the node cache is the heap |
| terrain `viewRadiusM` | **90,000** | 90,000 | **UNCHANGED** — Rainier is 84 km out |
| buildings | **tall+major**, 8 km | all, 25/6 km | minor is 57% of buffers, 0.6 px on a phone |

`PHONE_SHARES` splits the frame per subsystem, because a ceiling nobody owns is
a ceiling nobody cuts. Measured at the phone tier, parked at KBFI, 375×812:

| group | measured tri / calls | share | who closes it |
|---|---|---|---|
| terrain | 330,284 / 37 | 300,000 / 40 | **done** — `lodQuality` 0.40 |
| landmarks | 98,126 / **84** | 90,000 / 40 | drop the minor tier, 8 km major cutoff |
| airports | 45,578 / 10 | 40,000 / 10 | already inside |
| aircraft | 27,827 / 29 | 28,000 / 20 | merge airframe materials |
| sky | 976 / 9 | 2,000 / 10 | already inside |
| **total** | **502,791 / 169** | **460,000 / 120** | |

**`main.js` owns the application, and only three of these are live.**
`window.sim.setQuality('phone'|'tablet'|'desktop')` re-applies the pixel ratio
and the shadow tier immediately and republishes `window.sim.budgets`; the old
names still work (`low`→phone, `medium`→tablet, `high`→desktop). Everything
else — `antialias` (a renderer constructor flag), `terrainLodQuality` (a
`createTerrain` option), the DEM cap and the building tiers — is **boot-time**.
To measure a phone budget from frame 0 on a desktop, load `?tier=phone`.
`setQuality` deliberately does **not** persist unless passed `{persist: true}`:
a lever that silently changes the next boot is hidden state.

`window.sim.device`, `.tier`, `.budgets`, `.deviceSignals()` and
`.pixelBudget()` expose all of it for the acceptance checks.

Verified by `npm run check:device` — 191 assertions, no DOM and no GPU.

---

## 3. Bootstrap order

The dependencies are real. `main.js` does this and nothing else:

```
setOrigin()             every projection below is relative to it
await createTerrain()   loads the DEM; nothing can sit on the ground until
                        elevation is queryable
createSky()
await loadAirports()  ─┐ both need elevation to sit on the terrain
buildRunwayMeshes()   ─┘
placeLandmarks()        self-populating, no await
createAircraft()
createFlightModel()     needs the ground sampler + spawn coordinates
```

Per frame, in order — later stages read what earlier ones wrote:

```
1  input.get()
2  terrain.getHeightAt(x, z)
3  flight.step(dt, inputs, groundHeight)
4  copy state onto aircraft.group; setControlSurfaces; spinProp
5  cameras.update; terrain.update; sky.update
6  instruments.update(state)
7  renderer.render(scene, cameras.active)
```

---

## 4. Baked data

See `scripts/README.md` for the full contract and the verified quirks of each
source. Summary:

| File | Producer | Consumer |
|---|---|---|
| `public/dem/{z}/{x}/{y}.png` + `manifest.json` | `bake-dem.mjs` | `geo/elevation.js` |
| `public/data/airports.json` | `bake-airports.mjs` | `geo/airports.js` |
| `public/data/landmarks.json` | `bake-landmarks.mjs` | `geo/landmarks.js` |
| `public/data/buildings.json` | `bake-buildings.mjs` | `geo/buildings.js` |
| `public/landcover/{region,detail}.png` + `manifest.json` | `bake-landcover.mjs` | `geo/landcover.js` |

The building bake is **1.68 MB out of 927 MB in**: four Microsoft
global-buildings shards (151 MB gzipped) filtered to the Seattle inset,
simplified and quantised. `node scripts/bake-buildings.mjs --dry` reports the
selection without writing. Cold run about 40 s, almost all of it download;
the shards are cached under `node_modules/.cache/ken-buildings`. Neither state
file is ever shipped to the browser.

`npm run bake` is **not** part of `npm run build` — baking hits the network and
takes minutes; the build stays fast and offline.

The DEM bake is **4,178 tiles / 402.6 MB** across three levels and takes about
63 s cold at concurrency 10. It is gitignored; the manifest is not, so the tile
list and the zoom levels stay under review. Re-runs skip what is on disk, so
adding a level is cheap. `node scripts/bake-dem.mjs --levels=13` bakes a subset
without amputating the other levels from the manifest.

`scripts/lib/util.mjs` duplicates `REGION_BBOX` and `ORIGIN` from
`geo/coords.js` because there is no import path from a Node script into the
browser bundle. **Change one, change the other.**

---

## 5. Acceptance checks

Cheap, specific, and each one falsifies a whole class of bug.

1. **`npm run build` succeeds.** No dev server left running.
2. **Spawn.** Sim opens on the ground at KBFI 32L, HUD reads ≈ 47.5167 /
   -122.2913, heading ≈ 330, AGL ≈ 0, ALT ≈ 21 ft.
3. **The Space Needle is ahead.** Climb straight out; it is ~12 km away, a few
   degrees right of the nose.
4. **Rainier is behind.** Turn to 152°; a 4,392 m snow-capped cone at ~84 km.
   This is the single best proof the elevation data is real rather than noise —
   noise does not produce one 4.4 km peak in the right place.
5. **The coastline is right.** Puget Sound, Lake Washington and the Duwamish
   valley should be recognisable against any map. They come from the DEM's
   sea-level data, not from an artist.
6. **Wheels touch where the ground is drawn.** Land anywhere, on a slope. No
   sinking, no hovering beyond a metre or two on steep ground.
   **This one has a number now, and it did not before.**
   `npm run check:airports` builds the real runway meshes over the real DEM and
   measures the drawn triangles against `getElevationLocal`: the spawn stands
   **0.32 m** above the collision surface (26% of a 1.20 m gear leg), KBFI
   14R/32L a mean 0.30 m on the landing band, and exactly one paved runway in
   the region — KSEA 16R/34L, on 50 m of Miller Creek fill the bare-earth DEM
   does not contain — floats more than half a metre. Before, the spawn floated
   0.83 m and no assertion anywhere looked. Watch the console for
   `[airports] … deck(s) stand more than 1 m above the collision surface`;
   anything new in that list is a new lie under the wheels.
7. **KSEA is 8.8 km south of KBFI** — measured 8,829 m on bearing 185.1°. Its
   three runways are surveyed overrides at **180.34° true = 164.74° magnetic**,
   which is what rounds to the "16" on the numbers. Runway designators are
   MAGNETIC; do not "fix" these to 160.
8. **No landmark outside the region.** Console shows no `[landmarks] dropping…`
   warnings; if it does, a Q-ID is wrong.
9. **Memory is flat over a long flight.** `window.sim.demStats()` reports
   `peakResidentBytes` ≈ 82 MiB and `capViolations: 0`. Fly for ten minutes and
   fetch it again: the peak must not climb. The DEM on disk is 402 MB and the
   pager is the only thing standing between that and the tab. `capViolations`
   above zero is a paging bug, never a tuning problem.
