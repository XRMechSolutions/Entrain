---
topic: pwa setup with vite for the binaural app
status: current
last-updated: 2026-06-14
tags: [pwa, vite, vite-plugin-pwa, service-worker, manifest, offline, ios]
source-url:
  - https://web.dev/articles/install-criteria
  - https://vite-pwa-org.netlify.app/guide/prompt-for-update.html
  - https://www.magicbell.com/blog/pwa-ios-limitations-safari-support-complete-guide
---

# PWA Setup (Vite)

## Toolchain: Vite + vite-plugin-pwa

Use `vite-plugin-pwa` (generateSW / Workbox). A single HTML file **cannot** deliver
real offline — a service worker must be a separate same-origin file — so the
"no-build" route saves nothing once offline is required and loses TS/bundling.

**Use `registerType: 'prompt'`, NOT `'autoUpdate'`** — autoUpdate reloads the page
when a new SW activates, which would cut off an in-progress session. Surface a
non-blocking "new version" toast wired to `updateServiceWorker()`.

## Install criteria (Android Chrome — verified)

| Requirement | Value |
|-------------|-------|
| HTTPS | required (localhost exempt for dev) |
| Manifest | `name`/`short_name`, `start_url`, `display: standalone` (or `fullscreen` to hide the status bar) |
| Icons | 192 + 512 px, plus a 512 `purpose: "maskable"` (content within the 40% safe zone) |
| Service worker | required for actual offline (precache the app shell) |
| Install prompt | capture `beforeinstallprompt` for a custom install button |

Workbox defaults are fine: precache `**/*.{js,css,html,svg,png,woff2}`,
`navigateFallback: 'index.html'`, `cleanupOutdatedCaches: true`.

## iOS quirks

No `beforeinstallprompt` (manual Share → Add to Home Screen; detect via
`navigator.standalone`). Add head tags: `apple-touch-icon` (180),
`apple-mobile-web-app-capable`, `-status-bar-style`, `-title`. Use
`viewport-fit=cover` + `env(safe-area-inset-*)` for notches; no true fullscreen.
Synthesized audio means a tiny precache, so iOS's ~50 MB / ~7-day limits barely apply.

## Sources
- web.dev: install-criteria; web app manifest
- Vite PWA: prompt-for-update; Workbox options
- MagicBell: iOS PWA limitations (secondary)
