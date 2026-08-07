import { defineConfig } from 'vite';

export default defineConfig({
  root: '.',
  base: './',
  server: {
    // Honour an assigned PORT when one is supplied, and fall back to Vite's
    // usual 5173 otherwise. Nothing here needs a fixed port — there are no
    // OAuth callbacks, webhooks, or origin-pinned CORS rules — so hardcoding
    // one only guarantees a collision with a stale server holding 5173.
    port: process.env.PORT ? Number(process.env.PORT) : 5173,
    open: false,
  },
  preview: {
    port: process.env.PORT ? Number(process.env.PORT) : 8931,
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
    target: 'es2022',
    // three.js alone is ~500 kB minified; the default warning is pure noise here.
    chunkSizeWarningLimit: 1200,
  },
});
