import { defineConfig } from 'vite';

export default defineConfig({
  root: '.',
  base: './',
  server: {
    port: 5173,
    open: false,
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
    target: 'es2022',
    // three.js alone is ~500 kB minified; the default warning is pure noise here.
    chunkSizeWarningLimit: 1200,
  },
});
