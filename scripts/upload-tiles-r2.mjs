/**
 * upload-tiles-r2.mjs — push the baked DEM tiles to Cloudflare R2.
 *
 *   npx wrangler login                     # once, browser OAuth
 *   npx wrangler r2 bucket create flightlens-tiles
 *   node scripts/upload-tiles-r2.mjs       # this
 *
 * WHY THIS EXISTS RATHER THAN JUST BEING DONE. Uploading 4,178 files needs
 * either an S3 API token or an interactive `wrangler login`. A token is a
 * writable credential for the whole bucket, so it is not something to generate
 * and leave lying in a config; and the OAuth flow needs a human at the browser.
 * Everything that does NOT need a credential is done — the build already reads
 * VITE_DEM_BASE_URL, the manifest is layer-aware, and this script is the rest.
 *
 * ---------------------------------------------------------------------------
 * WHAT TO RUN, IN ORDER
 * ---------------------------------------------------------------------------
 *   1. npx wrangler login
 *   2. npx wrangler r2 bucket create flightlens-tiles
 *   3. node scripts/upload-tiles-r2.mjs
 *   4. In the dashboard: R2 -> flightlens-tiles -> Settings
 *        - Public access: connect a custom domain -> tiles.flightlens.us
 *          (this creates the DNS record itself; do NOT hand-add it first)
 *        - CORS policy: paste the JSON this script prints at the end
 *   5. Rebuild and redeploy the game with the tiles pointed at R2:
 *        VITE_DEM_BASE_URL=https://tiles.flightlens.us npm run build
 *
 * ---------------------------------------------------------------------------
 * CORS IS NOT OPTIONAL
 * ---------------------------------------------------------------------------
 * This is the failure that shaped the whole tile pipeline. The upstream AWS
 * terrarium bucket sends no access-control-allow-origin, so browser reads of
 * those PNGs taint the canvas and getImageData() throws — which is exactly why
 * the tiles are baked and served same-origin today. Move them to R2 WITHOUT
 * CORS headers and that bug comes back in production only, where it looks like
 * "the ground is missing". The policy printed below is the fix; apply it before
 * pointing the build at the bucket.
 */

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { execFileSync } from 'node:child_process';
import { PUBLIC_DIR } from './lib/util.mjs';

const BUCKET = process.env.R2_BUCKET || 'flightlens-tiles';
const DEM_DIR = join(PUBLIC_DIR, 'dem');

if (!existsSync(DEM_DIR)) {
  console.error(`No tiles at ${DEM_DIR}. Run \`npm run bake:dem\` first.`);
  process.exit(1);
}

/** Every file under dem/, as paths relative to it — those become the R2 keys. */
function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

const files = walk(DEM_DIR);
const bytes = files.reduce((n, f) => n + statSync(f).size, 0);
console.log(
  `${files.length} files, ${(bytes / 1048576).toFixed(1)} MB -> r2://${BUCKET}/dem/`,
);

// R2's free tier is 10 GB of storage and 1M class-A operations a month. One PUT
// per file, so 4,178 uploads is well inside it — and egress is free, which is
// the whole reason tiles belong here rather than in a git repo.
let done = 0;
let failed = 0;
for (const f of files) {
  const key = `dem/${relative(DEM_DIR, f).split(/[\\/]/).join('/')}`;
  const type = f.endsWith('.png') ? 'image/png' : 'application/json';
  try {
    execFileSync(
      'npx',
      ['wrangler', 'r2', 'object', 'put', `${BUCKET}/${key}`,
       '--file', f, '--content-type', type, '--remote'],
      { stdio: 'pipe' },
    );
    done += 1;
    if (done % 200 === 0) console.log(`  ${done}/${files.length}`);
  } catch (err) {
    failed += 1;
    console.warn(`  FAILED ${key}: ${String(err.message).slice(0, 120)}`);
    // Ten failures in a row means the credential or the bucket is wrong, not
    // that one tile is unlucky. Stop rather than grind through 4,000 errors.
    if (failed > 10 && done === 0) {
      console.error('\nNothing is uploading. Check `npx wrangler whoami` and the bucket name.');
      process.exit(1);
    }
  }
}

console.log(`\nuploaded ${done}, failed ${failed}`);
console.log(`
Now, in the dashboard — R2 -> ${BUCKET} -> Settings:

1. Public access -> Connect Domain -> tiles.flightlens.us
   (R2 creates the DNS record itself. Do not pre-create it in the DNS tab.)

2. CORS policy — REQUIRED, see this file's header:

[
  {
    "AllowedOrigins": [
      "https://game.flightlens.us",
      "https://flightlens.us",
      "http://localhost:5173",
      "http://localhost:8931"
    ],
    "AllowedMethods": ["GET", "HEAD"],
    "AllowedHeaders": ["*"],
    "MaxAgeSeconds": 86400
  }
]

3. Then rebuild the game against it:

   VITE_DEM_BASE_URL=https://tiles.flightlens.us npm run build

   Verify BEFORE deploying: load the build and check
   window.sim.demStats().tilesMissing === 0 and that maxElevationM is ~4388.
   A CORS mistake shows up as missing ground, not as an error dialog.
`);
