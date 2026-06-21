import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { VitePWA } from 'vite-plugin-pwa';
import { ICON_FILES } from './src/pwa/icon-files';

// Production build config (pwa-shell owns this file; the test runner uses the separate
// vitest.config.ts so Workbox never runs in unit tests).
//
// `base` is the single switch point for all absolute asset references, the runtime
// BASE_URL exports, and the PWA manifest/scope/icons (design.md §6.5). It defaults to '/'
// (origin root — local dev, a custom domain, or a user/org GitHub Pages site) and is
// overridden to the repo subpath (e.g. '/entrain/') via the BASE_PATH env var for GitHub
// Pages PROJECT hosting. The deploy workflow sets BASE_PATH from the repo name, so
// `npm run dev` / `npm run build` stay at root locally.
const base = process.env.BASE_PATH || '/';

export default defineConfig({
  base,
  // Cross-origin isolation so onnxruntime-web's threaded WASM (the kokoro-js TTS backend) can
  // use SharedArrayBuffer + worker threads — without it the `-threaded` build stalls and any
  // single-threaded inference is very slow. `credentialless` keeps the first-run HuggingFace
  // model fetch working without requiring CORP headers on the cross-origin response.
  // (Static hosts like GitHub Pages must send these headers themselves for prod isolation.)
  server: {
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'credentialless',
    },
  },
  preview: {
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'credentialless',
    },
  },
  plugins: [
    svelte(),
    VitePWA({
      registerType: 'prompt', // D-017 — never auto-reload mid-session
      injectRegister: null, // ui registers manually via registerSW (no double registration)
      includeAssets: [ICON_FILES.faviconSvg, ICON_FILES.appleTouch180, 'audio/silence-5s.wav'],
      devOptions: { enabled: false }, // no SW in `vite dev` (HMR not shadowed by a cache)
      manifest: {
        id: base,
        name: 'BinauralAudio',
        short_name: 'Binaural',
        description:
          'Node-based binaural-beat generator for experimental relaxation and focus. Not a medical device.',
        start_url: base,
        scope: base,
        display: 'standalone',
        orientation: 'any',
        theme_color: '#0B0F14',
        background_color: '#0B0F14',
        lang: 'en',
        dir: 'ltr',
        categories: ['music', 'lifestyle'],
        prefer_related_applications: false,
        icons: [
          { src: `${base}${ICON_FILES.pwa192}`, sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: `${base}${ICON_FILES.pwa512}`, sizes: '512x512', type: 'image/png', purpose: 'any' },
          { src: `${base}${ICON_FILES.maskable512}`, sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        // wav = the silent loop (§6.3); js = the pulse AudioWorklet chunk (§6.4).
        // onnx/bin = a self-hosted Kokoro q8 model (the optional fully-offline-first-run
        // path, D-039); wasm = the onnxruntime-web execution backend kokoro-js loads. These
        // are large (the q8 model is tens of MB, the ort wasm a few MB), so they MUST be
        // admitted by maximumFileSizeToCacheInBytes below — Workbox's default (~2 MB)
        // silently drops them from the precache manifest, which would break offline TTS
        // (tts-local dependencies.md @ D-017, design §6).
        globPatterns: ['**/*.{js,css,html,svg,png,ico,woff2,wav,onnx,bin,wasm}'],
        // Admit the tens-of-MB Kokoro q8 model + multi-MB onnxruntime wasm into precache.
        // Under D-039 the model is fetched from the HF hub on first use and the browser
        // caches it (online once, offline thereafter); this limit + the globs above cover
        // the same-origin ort wasm and the optional self-hosted weights so neither is
        // silently excluded by the default size cap (tts-local design §6, dependencies.md
        // @ D-017). registerType:'prompt' is unaffected — the assets are content-hashed.
        maximumFileSizeToCacheInBytes: 100 * 1024 * 1024,
        // Relative — Workbox resolves it against the SW location, so it works at both
        // origin root and a subpath without hardcoding the base.
        navigateFallback: 'index.html',
        cleanupOutdatedCaches: true,
        clientsClaim: true,
        skipWaiting: false, // critical pairing with registerType 'prompt' (D-017)
      },
    }),
  ],
});
