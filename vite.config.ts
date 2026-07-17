import { defineConfig } from 'vite';

export default defineConfig({
  // Relative base so the built app works from any subpath of the Jekyll
  // site (e.g. /keyboard-generator/) without configuration.
  base: './',
  build: {
    outDir: 'dist',
    target: 'es2020',
  },
});
