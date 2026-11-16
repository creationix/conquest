import { defineConfig } from 'vite';

// iPad mini 4 tops out at iPadOS 15.8, so keep emitted syntax Safari 15 friendly.
export default defineConfig({
  base: './',
  build: {
    target: ['safari15', 'es2020'],
    outDir: 'dist',
    assetsInlineLimit: 0,
  },
  server: { host: true },
});
