import { resolve } from 'node:path';
import { defineConfig } from 'vite';

export default defineConfig({
  // Relative URLs, so the build works from any subpath (e.g. a GitHub Pages project site).
  base: './',
  build: {
    rollupOptions: {
      input: {
        home: resolve(import.meta.dirname, 'index.html'),
        playground: resolve(import.meta.dirname, 'playground.html'),
      },
    },
  },
});
