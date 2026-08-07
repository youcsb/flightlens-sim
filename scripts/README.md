# scripts/ — build-time data baking

Everything real-world in this sim is downloaded **once, here, at build time**
and committed to `public/`. Nothing hits a third-party API at runtime.

```bash
export PATH="$HOME/.local/node/bin:$PATH"   # node v24 is not on the default PATH

npm run bake              # all four, in order
npm run bake:dem          # elevation tiles  -> public/dem/
npm run bake:airports     # airports+runways -> public/data/airports.json
npm run bake:landmarks    # landmarks        -> public/data/landmarks.json
npm run bake:landcover    # NLCD + roads     -> public/landcover/
```

`npm run bake` is **not** wired into `npm run build`. Baking touches the network
and takes minutes; the build must stay fast and offline. Run it when the data
needs refreshing, commit the output, move on.

## Why bake instead of fetching at runtime

| Source | Reason |
|---|---|
| AWS Terrarium DEM | **No CORS header.** The browser can display those PNGs but cannot `getImageData()` them — the canvas is tainted and throws `SecurityError`. Since we need the pixel values *as elevation*, they are unusable client-side. No workaround exists. |
| OurAirports | CORS is fine, but the CSV is 13 MB and we use 0.3% of it. |
| Wikidata | CORS is fine, but the query needs curated Q-IDs and careful filtering (see below); doing that per page load is slow and fragile. |
| Overpass / OSM | **Returned 504 on probe, twice, months apart. Treat as unreliable. Do not build a dependency on it.** Roads come from the Census Bureau's TIGERweb instead, which answered every request. |
| NLCD via MRLC WMS | Returns the STYLED raster, not raw class values, so the baker maps each pixel back to its class by nearest legend colour. Fine — the palette is ~16 widely separated colours and the response is palette-indexed, so the match is exact. |

The bake also means the sim runs offline and works as a static build.

## The sim must boot without any of this

Every loader in `src/geo/` degrades instead of throwing when its file is
missing: no DEM gives a flat sea-level world, no airports gives a hardcoded
KBFI spawn, no landmarks gives a built-in Space Needle and Mount Rainier. That
is deliberate — eight agents work in parallel and the build has to stay green
while the data is still being produced. Check the console for `[elevation]`,
`[airports]` and `[landmarks]` warnings if the world looks empty.

## Output contract

Each script's header documents its exact output schema, and the corresponding
`src/geo/*.js` module parses exactly that. **If you change a schema, change
both files in the same commit.**

```
public/
  dem/
    manifest.json          { generated, source, encoding,
                             levels:[{zoom,tileSize,bbox,paged,tiles:["x/y",...]}] }
    11/321/709.png         verbatim Terrarium bytes — never re-encode
                           `paged:true` means the level is too big to hold
                           decoded and elevation.js streams it. Advisory: the
                           runtime sets its own policy, but a bake that doubles
                           a level should say so here.
  data/
    airports.json          { generated, source, bbox, airports:[...] }
    landmarks.json         { generated, source, landmarks:[...] }
  landcover/
    manifest.json          { generated, sources, encoding, classes, layers:[...] }
    region.png             RGB8 DATA, not a picture: R = NLCD class code,
    detail.png               G = compact class index, B = road mask
```

## What was verified, so you don't re-derive it

Probed live before this scaffold was written:

- **DEM.** 256×256, 8-bit RGB. `elevation_m = (R*256 + G + B/256) - 32768`.
  Tile size varies hugely with terrain — an ocean tile is ~5 kB, the Mount
  Rainier tile is 145 kB. Region tile counts: z9 = 20, z10 = 72, **z11 = 238
  (51.8 m/px, the pinned base)**, z12 = 891, **z13 = 3,380 (12.95 m/px, the
  paged working layer)**, z14 = 13,158 region-wide but **560 over the Seattle
  inset (6.47 m/px)**, z15 = 51,712.

  **z=15 is deliberately not baked.** Measured by downloading each child tile,
  bilinearly upsampling its parent and taking the RMS of the difference — i.e.
  the information the finer level actually adds: z13→z14 is 0.28 m RMS / 3.4 m
  peak over the airports, which is real; z14→z15 is 0.05 m RMS / 1.2 m peak,
  which is upsampling. The underlying source is 3DEP 1/3 arc-second (~10 m), so
  there is nothing below z14 to find. Re-run that probe before adding z15.

  Current bake: **4,178 tiles, 402.6 MB, ~63 s cold at concurrency 10.**
- **Airports.** 266 in the bbox, 246 runways — but only ~46 runways carry real
  endpoint coordinates. `le_heading_degT` is frequently *magnetic*: KBFI
  publishes 140 where the true heading is 150.2. KSEA's endpoints are rounded
  until all three runways are exactly 180.000°. Details in
  `bake-airports.mjs`.
- **Landmarks.** A ten-name label query returned 58 rows, **49 of them wrong** —
  Mount Adams in six other places, a Mount Rainier in Maryland. Worse, a bbox
  filter alone is not enough: "Mount Baker" *inside* our bbox is a Seattle
  neighbourhood, while the actual volcano is outside it. Resolve by Q-ID only.
  Details in `bake-landmarks.mjs`.

## Two constants are duplicated on purpose

`scripts/lib/util.mjs` repeats `REGION_BBOX` and `ORIGIN` from
`src/geo/coords.js`. There is no import path from a Node script into the
browser bundle, so they are copied and kept honest by review. **Change one,
change the other**, or baked data will land in the wrong place with no error.
