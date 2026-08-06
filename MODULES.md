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

### 1.5 Geographic truth vs. procedural texture

Real: terrain **shape**, airport **positions**, runway **headings and lengths**,
landmark **coordinates**, the coastline (from the DEM's sea-level data).

Procedural: **surface colour**, materials, vegetation, buildings that are not
named landmarks.

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
SEA_LEVEL_M    // 0
WATER_LEVEL_M  // 0.5 — salt water only, see below
DEM_ZOOM       // 11, base level: 238 tiles, ~52 m/px
DETAIL_ZOOM    // 13, optional Seattle inset, ~13 m/px
DETAIL_BBOX    // {south:47.35, north:47.75, west:-122.5, east:-122.1}

loadRegion(bbox?, zoom?) -> Promise<void>   // ADDITIVE, call once per level
isLoaded() -> boolean
getRegionStats() -> {loaded, layers, tilesLoaded, tilesMissing, voidsRepaired,
                     minElevationM, maxElevationM}

getElevation(lat, lon) -> metres MSL        // bilinear, never NaN, never throws
getElevationLocal(x, z) -> metres MSL       // allocation-free
getNormalLocal(x, z, epsM?) -> {x, y, z}    // unit, +Y up
fillHeightGrid(x0, z0, dx, dz, nx, nz, out?) -> Float32Array
isWater(lat, lon) -> boolean
isInRegion(lat, lon) -> boolean
decodeTerrarium(r, g, b) -> metres          // (R*256 + G + B/256) - 32768
```

**Layers.** `loadRegion()` is additive. Each call adds a layer at some zoom over
some bbox; sampling consults layers from highest zoom down and uses the first
with a loaded tile. Bake z=11 over the region for Mount Rainier's shape *and*
z=13 over Seattle for crisp ground near the airports — no other module needs to
know which layer answered.

**Sampling crosses tile seams.** Bilinear interpolation happens in global pixel
space, not per-tile, which is what stops the terrain showing a grid of creases.

**`getElevation` is total.** Outside the region, before loading, on bad input:
returns `SEA_LEVEL_M`. It is called every physics step and must never be able
to trip over a gap in the data.

**The source has voids, and they are repaired at decode.** Terrarium ships
scattered holes: 3,652 pixels across our 378 baked tiles, including a -14,492 m
spike near Hood Canal, a -497 m scanline in the tideflats at 47.4880/-122.3660,
and a 78-pixel blob reading -2,437 m at 47.3828/-122.3897 — on the KSEA
approach. Untreated, each is a kilometres-deep needle through the terrain mesh
and a garbage `altitudeAglFt` for anything flying over it.

`loadTile()` therefore screens every pixel on two independent tests — an
absolute plausibility band, and deviation from the 8-neighbour median (150 m,
measured to sit above the steepest real Cascade terrain at both zooms) — then
neighbour-fills whatever fails. `voidsRepaired` reports the count. Do not add
flood-fill propagation between pixels: it is redundant against the band test
and it walks up steep faces. See the note in `elevation.js`.

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
is left bit-identical (median bend across the region: **9 cm**; KBFI: 2.4 cm);
only two runways bend more than 5 m, worst being KSEA 16R/34L at **12.9 m**,
whose Miller Creek embankment is simply not in the source DEM. Flush beats flat
— the DEM is the collision surface (§1.4).

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
  detail = true,         // load the z13 Seattle inset as a second layer
  water = true,          // draw the sea plane and the freshwater lake quads
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

Colour is procedural, banded by real elevation and real slope, with the treeline
and snow line at real Cascade heights. Steep faces go to rock regardless of
elevation — that is what makes Rainier read as a mountain rather than a green
cone.

**Freshwater lakes** need a flat-region heuristic: Terrarium encodes lake
surfaces as perfectly flat areas at their true elevation (Lake Washington ≈ 5 m,
Lake Union ≈ 5 m). Detect near-zero slope over a run of samples at a plausible
lake elevation. Do not use `isWater()` for this; it only finds sea level.

### 2.8 `src/world/sky.js` — atmosphere and all lighting

```js
createSky(scene, renderer, opts?) -> {
  update(dt, sunAngle?) -> void,
  setTimeOfDay(t) -> void,     // 0=midnight, 0.25=sunrise, 0.5=noon, 0.75=sunset
  getTimeOfDay() -> number,
  sunLight,                    // THREE.DirectionalLight  (read-only to others)
  ambientLight,                // THREE.HemisphereLight   (read-only to others)
  sunDirection,                // THREE.Vector3, unit, scene -> sun
}
```

```ts
opts = { turbidity = 8, fogDensity = 1.1e-5, timeOfDay = 0.42,
         sunDistance = 120000, sunAzimuthDeg = 180, dayLengthSec = 0 }
```

This module owns `scene.background`, `scene.fog` and **every light**. No other
module may add one. `sunLight` / `ambientLight` are exposed so others can read
the sun direction (lens flare, water specular, shadow framing) — read them, do
not reparent them or change their intensity; both are rewritten every frame.

**Fog density is a visibility budget, not a mood setting.** `FogExp2` attenuates
by `exp(-(d·density)²)`, and Mount Rainier is 84 km out:

| density | Rainier |
|---|---|
| `8e-5` | attenuated by `exp(-45)` — **invisible**. Renders perfectly, you cannot see it. |
| `1.1e-5` | ~40% contrast: a pale blue-grey cone above the haze. Correct. |

If you raise it, re-derive against 84 km first.

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

// geodetic mirror, recomputed every step
lat, lon
```

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

`npm run bake` is **not** part of `npm run build` — baking hits the network and
takes minutes; the build stays fast and offline.

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
