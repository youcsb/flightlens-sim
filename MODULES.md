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
getRegionStats() -> {loaded, layers, tilesLoaded, tilesMissing, voidsRepaired,
                     minElevationM, maxElevationM, residentBytes,
                     peakResidentBytes, residentCapBytes, residentTiles,
                     pageIns, evictions, capViolations, pendingLoads}

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

**The deck bends where — and only where — the DEM demands it.** A runway is
drawn on a fitted plane, but that plane is capped at a small lift, so anywhere
the DEM lacks an airport's earthworks the ground poked through and the runway
rendered in pieces. `buildDeckProfile` raises the deck locally to
`max(plane, terrain + 0.25 m)`. A runway whose plane already clears the ground
is left bit-identical (median bend across the region: **9 cm**; KBFI: 2.4 cm).
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

**This is now airports.js's problem, not elevation.js's.** Faking the fill in
the DEM would be inventing geography (§1.5). The embankment is airport
*infrastructure* and belongs in the runway deck: `buildDeckProfile` currently
lifts the deck where terrain pokes *through* it and does nothing where the
terrain falls *away*, so 16R/34L will render on a plane with a 55 m canyon
under it. Skirting the deck down to the terrain would draw the retaining wall
that is actually there.

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
  dispose() -> void
}>
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
  lodQuality = 1,        // scales the CDLOD screen-error budget
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

Colour is procedural, but it is **told what it is painting**. Below the treeline
the albedo comes from `geo/landcover.js` (§2.14): class index in, palette colour
plus a near-field structure out. Above it, elevation and slope keep the last
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

### 2.14 `src/geo/landcover.js` — what is on the ground

```js
loadLandcover() -> Promise<{
  region, detail,             // {texture, rect, texelM, width, height, data} | null
  palette,                    // 16x2 RGBA DataTexture: albedo / (rough, detail, form, canopy)
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
         shadows = true, shadowQuality = 'high', aircraftReceivesShadow = true }
```

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
guesses. **It is not yet in `npm run check:all`** — one line in `package.json`.

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
createInstruments(container) -> { update(state) }
```

The **only** place in the codebase allowed to speak imperial. Reads the
pre-computed display fields; never does physics, never converts units itself,
never writes back to `state`. Owns its own child nodes and must not clear
siblings.

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
| `public/landcover/{region,detail}.png` + `manifest.json` | `bake-landcover.mjs` | `geo/landcover.js` |

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
