import { defineConfig } from 'vitest/config';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { svelteTesting } from '@testing-library/svelte/vite';

// Test-only Vite config. Kept separate from the build's vite.config.ts (owned by
// pwa-shell) so the VitePWA/Workbox plugin never runs during unit tests. Engine
// modules are pure TS in jsdom; the svelte plugin only activates for .svelte tests.
export default defineConfig({
  plugins: [svelte(), svelteTesting()],
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.{test,spec}.ts'],
    css: true,
    restoreMocks: true,
  },
});
