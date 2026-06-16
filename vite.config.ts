import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { VitePWA } from 'vite-plugin-pwa';
import { ICON_FILES } from './src/pwa/icon-files';

// Production build config (pwa-shell owns this file; the test runner uses the separate
// vitest.config.ts so Workbox never runs in unit tests). The project ships at origin
// root: base '/' is the single switch point for all absolute asset references and the
// runtime BASE_URL exports (design.md §6.5).
export default defineConfig({
  base: '/',
  plugins: [
    svelte(),
    VitePWA({
      registerType: 'prompt', // D-017 — never auto-reload mid-session
      injectRegister: null, // ui registers manually via registerSW (no double registration)
      includeAssets: [ICON_FILES.faviconSvg, ICON_FILES.appleTouch180, 'audio/silence-5s.wav'],
      devOptions: { enabled: false }, // no SW in `vite dev` (HMR not shadowed by a cache)
      manifest: {
        id: '/',
        name: 'BinauralAudio',
        short_name: 'Binaural',
        description:
          'Node-based binaural-beat generator for experimental relaxation and focus. Not a medical device.',
        start_url: '/',
        scope: '/',
        display: 'standalone',
        orientation: 'any',
        theme_color: '#0B0F14',
        background_color: '#0B0F14',
        lang: 'en',
        dir: 'ltr',
        categories: ['music', 'lifestyle'],
        prefer_related_applications: false,
        icons: [
          { src: `/${ICON_FILES.pwa192}`, sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: `/${ICON_FILES.pwa512}`, sizes: '512x512', type: 'image/png', purpose: 'any' },
          { src: `/${ICON_FILES.maskable512}`, sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        // wav = the silent loop (§6.3); js = the pulse AudioWorklet chunk (§6.4).
        globPatterns: ['**/*.{js,css,html,svg,png,ico,woff2,wav}'],
        navigateFallback: 'index.html',
        cleanupOutdatedCaches: true,
        clientsClaim: true,
        skipWaiting: false, // critical pairing with registerType 'prompt' (D-017)
      },
    }),
  ],
});
