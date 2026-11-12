import { resolve } from 'node:path';

export default {
  root: process.cwd(),
  base: './',
  build: {
    outDir: 'tests/browser/dist-overlays',
    emptyOutDir: true,
    rollupOptions: { input: resolve('tests/browser/overlays.html') },
  },
};
