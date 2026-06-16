# Tasks: pwa-shell
# Planning: .dev/planning/modules/pwa-shell/
# Architecture: .dev/architecture.md
# Standards: safety
# Stack: typescript

## Agent Briefing
pwa-shell is the build/packaging and platform-shell layer: it turns the built SPA into an
installable, offline-capable PWA (Web App Manifest, Workbox service worker, iOS head tags,
safe-area CSS tokens, install-prompt buffer) and ships two runtime exports the audio modules
consume — `APP_ICONS` (MediaSession lock-screen artwork) and `SILENT_LOOP_URL` (the D-018
background silent-loop fallback). It owns no audio logic and no Svelte components, depends on no
other in-repo module, and is consumed by `ui` (composition root + CSS-token contract) and,
indirectly, by `transport` (values injected through `createTransport`).

## References
- .dev/planning/modules/pwa-shell/design.md
- .dev/planning/modules/pwa-shell/interfaces.md
- .dev/planning/modules/pwa-shell/edge-cases.md
- .dev/planning/modules/pwa-shell/dependencies.md
- .dev/knowledge/web-audio/pwa-setup.md

## Dependencies
None inbound — pwa-shell is a base Config layer and imports no other in-repo module; the
dependency arrows point outward (`ui`, and through it `transport`, consume its exports). Before
starting, the build/dev tooling must be installed and version-aligned with `ui/dependencies.md`
(one project-wide install): `vite-plugin-pwa` (^0.20.x or ^1.x, Workbox generateSW),
`@vite-pwa/assets-generator` (^0.2.x or ^1.x), `vite` (^5.x or ^6.x), `typescript` (^5.x). No
runtime npm dependency is added to the shipped bundle.

## Tasks

- [x] [config] Author the ambient env types and the single-source icon-filename constants | file: src/vite-env.d.ts, src/pwa/icon-files.ts | model: T3
  - Ref: .dev/planning/modules/pwa-shell/interfaces.md @ 1. Icon filenames — single source of truth (`src/pwa/icon-files.ts`)
  - Ref: .dev/planning/modules/pwa-shell/interfaces.md @ 5. Ambient / global type declarations (`src/vite-env.d.ts`)
  - Ref: .dev/planning/modules/pwa-shell/design.md @ 6.5 Base path — one switch point
  - Accepts: nothing (declarative `.d.ts` + a `const` object with no `import.meta`, so it imports cleanly from both the browser runtime and the Node-side `vite.config.ts`)
  - Creates: `ICON_FILES` (the 7 filenames: pwa64/192/512, maskable512, appleTouch180, faviconIco, faviconSvg) + `IconFileKey` type; ambient `BeforeInstallPromptEvent`, `WindowEventMap` augmentation, `Window.__deferredInstallPrompt`/`__appInstalled`, `Navigator.standalone`, and the `vite/client` + `vite-plugin-pwa/client` triple-slash references
  - Tests: `tsc` type-checks the ambient file; `ICON_FILES` imports without error from both a browser module and a Node-side import; the 7 keys match exactly the committed filenames; `virtual:pwa-register` and `BeforeInstallPromptEvent` resolve in a downstream `.ts`

- [x] [data] Author the icon-generator config and generate + commit the full icon set from one source SVG | file: pwa-assets.config.ts, public/favicon.svg | model: T3
  - Ref: .dev/planning/modules/pwa-shell/design.md @ 6.1 Icon generation — deterministic, no manual pixel work
  - Ref: .dev/planning/modules/pwa-shell/interfaces.md @ 7. Build-config objects (`vite.config.ts` `VitePWA()` block)  (the `pwa-assets.config.ts` block)
  - Ref: .dev/planning/modules/pwa-shell/edge-cases.md @ B. Manifest / installability (Android / Chromium)  (B2 missing/mis-sized icon, B3 maskable safe zone, D7 placeholder stub)
  - Accepts: a single 1024-unit-square source `public/favicon.svg` with the mark inside the central 80% (40% radius) safe circle; placeholder geometric mark ships now — the final logo stays a registered branding stub (edge-cases D7), a drop-in SVG swap + re-run, NOT resolved here
  - Creates: `pwa-assets.config.ts` using the `minimal-2023` preset with maskable + apple `resizeOptions.background` overridden to opaque `#0B0F14`; committed `public/pwa-64x64.png`, `pwa-192x192.png`, `pwa-512x512.png`, `maskable-icon-512x512.png`, `apple-touch-icon-180x180.png`, `favicon.ico` (run via the `generate-pwa-assets` npm script; outputs committed, no build coupling)
  - Tests: `generate-pwa-assets` runs clean; every filename in `ICON_FILES` exists in `public/` at its declared pixel size; maskable-512 fills to the full edge with opaque `#0B0F14` (no transparent corners) and keeps content within the 40% safe radius; apple-touch-180 background is opaque

- [x] [data] Produce and commit the near-silent background loop asset | file: public/audio/silence-5s.wav | model: T3 [availability]
  - Ref: .dev/planning/modules/pwa-shell/design.md @ 6.3 `SILENT_LOOP_URL` (resolves the transport `silentFileUrl` stub)
  - Ref: .dev/planning/modules/pwa-shell/interfaces.md @ 8. The committed silent-loop asset spec (`public/audio/silence-5s.wav`)
  - Ref: .dev/planning/modules/pwa-shell/edge-cases.md @ D. Static assets / base path  (D2 404/not-precached, D3 decode, D4 loop click, D5 bit-exact-silence loses focus); .dev/knowledge/web-audio/pwa-setup.md (synthesized audio → tiny precache)
  - Accepts: a one-time reproduction recipe (e.g. ffmpeg) meeting the §8 spec table exactly
  - Creates: `public/audio/silence-5s.wav` — 5.0 s, mono, 8000 Hz, 16-bit PCM, 40000 samples (even → seamless loop), samples alternating +1/-1 LSB (~-90 dBFS, inaudible but non-zero so the OS keeps audio focus), ~80 KB
  - Tests: container = WAV/16-bit PCM, mono, 8000 Hz, duration exactly 5.0 s; sample count is even (40000) so the -1→+1 wrap has no amplitude step (no loop click); samples are non-zero (near-silent, not bit-exact silence); decodes via `decodeAudioData` with no codec dependency

- [x] [config] Author the runtime icon + silent-loop value exports | file: src/pwa/icons.ts, src/pwa/assets.ts | model: T3
  - Ref: .dev/planning/modules/pwa-shell/interfaces.md @ 2. Icon exports (`src/pwa/icons.ts`)
  - Ref: .dev/planning/modules/pwa-shell/interfaces.md @ 3. Silent-loop asset export (`src/pwa/assets.ts`)
  - Ref: .dev/planning/modules/pwa-shell/design.md @ 6.2 `APP_ICONS` (resolves the transport artwork stub)
  - Ref: .dev/planning/modules/pwa-shell/design.md @ 6.5 Base path — one switch point
  - Resolves registry stubs: "MediaSession artwork default uses pwa-shell app icons" (`APP_ICONS`) and "default silentFileUrl points at a bundled near-silent ≥5s loop asset" (`SILENT_LOOP_URL`)
  - Accepts: `import.meta.env.BASE_URL` (the single runtime base prefix) + `ICON_FILES`
  - Creates: `AppIcon` interface; `MANIFEST_ICONS` (192 + 512 + maskable-512); `APP_ICONS: ReadonlyArray<MediaImage>` (192 + 512 `any` only — NO maskable, lock-screen art is not masked); `SILENT_LOOP_URL = \`${BASE_URL}audio/silence-5s.wav\``; `SILENT_LOOP_MIN_SEC = 5`
  - Tests: `APP_ICONS` has exactly 2 entries, no maskable, each a valid `MediaImage` `{src,sizes,type}`; `SILENT_LOOP_URL === '/audio/silence-5s.wav'` at base `/`, and re-prefixes correctly when `BASE_URL` is a sub-path; `MANIFEST_ICONS` includes the maskable-512 with `purpose:'maskable'`

- [x] [impl] Implement the install-event buffer read helpers | file: src/pwa/install-buffer.ts | model: T2
  - Ref: .dev/planning/modules/pwa-shell/interfaces.md @ 4. Install-event buffer helpers (`src/pwa/install-buffer.ts`)
  - Ref: .dev/planning/modules/pwa-shell/design.md @ 7. Integration points with `ui` (coordinate, do not redesign)  (Android install button)
  - Ref: .dev/planning/modules/pwa-shell/edge-cases.md @ B. Manifest / installability (Android / Chromium)  (B5 event before bundle, B6 single-use prompt, B7 already standalone)
  - Accepts: the `window.__deferredInstallPrompt` / `window.__appInstalled` globals filled by the index.html capture snippet; `matchMedia('(display-mode: standalone)')` + iOS `navigator.standalone`
  - Creates: `consumeBufferedInstallPrompt()` (returns the buffered event then clears it — consumed exactly once, `null` if none); `wasInstalledBeforeBoot()`; `isStandaloneDisplay()` (display-mode standalone OR iOS `navigator.standalone`)
  - Tests: consume returns the buffered event on first call and `null` on the second (cannot be replayed); `null` when nothing buffered; `wasInstalledBeforeBoot()` tracks `__appInstalled`; `isStandaloneDisplay()` true for display-mode standalone and for iOS `navigator.standalone`, false otherwise (mock `window`)

- [x] [config] Author index.html: iOS head tags, critical safe-area CSS, and the early install-capture snippet | file: index.html | model: T2
  - Ref: .dev/planning/modules/pwa-shell/design.md @ 4. iOS head tags (index.html) — every tag decided
  - Ref: .dev/planning/modules/pwa-shell/design.md @ 5. Safe-area tokens and critical CSS (who owns what)
  - Ref: .dev/planning/modules/pwa-shell/design.md @ 7. Integration points with `ui` (coordinate, do not redesign)  (the beforeinstallprompt capture snippet)
  - Ref: .dev/planning/modules/pwa-shell/interfaces.md @ 6. The published CSS custom-property contract (index.html critical CSS)
  - Ref: .dev/planning/modules/pwa-shell/edge-cases.md @ C. iOS-specific  (C1–C6) and @ E. CSS-token contract  (E1–E3) and @ B. Manifest / installability  (B5 early capture); .dev/knowledge/web-audio/pwa-setup.md (iOS head tags + safe-area)
  - Accepts: nothing at runtime — static `<head>` tags, one inline `<style>`, and one early `<script>`
  - Creates: viewport `width=device-width, initial-scale=1, viewport-fit=cover`; `apple-touch-icon` (180) + favicon links; `apple-mobile-web-app-capable` + `mobile-web-app-capable` = yes, `-status-bar-style` = black-translucent, `-title` = Binaural, `application-name` = Binaural, `theme-color` = `#0B0F14`, `color-scheme` = dark; critical inline CSS defining `--safe-top/right/bottom/left = env(safe-area-inset-*, 0px)`, `--app-bg: #0B0F14`, `html,body{margin:0;background:var(--app-bg)}`, `body{min-height:100dvh;overscroll-behavior:none}`; an early `<head>` snippet that `preventDefault()`s + buffers `beforeinstallprompt` to `window.__deferredInstallPrompt` and sets `window.__appInstalled` on `appinstalled`
  - Tests: `theme-color` meta == manifest `theme_color` == `--app-bg` (`#0B0F14`, no color seam); `--safe-*` resolve to 0px when `env()`/`viewport-fit` unsupported; the dark `--app-bg` paints before the bundle (no white flash under `black-translucent`); a synthetic `beforeinstallprompt` dispatched before bundle eval is buffered and then adoptable via `consumeBufferedInstallPrompt()`; no hand-written `<link rel="manifest">` (the plugin injects it)

- [x] [config] Author the VitePWA() block: manifest, Workbox precache, and the prompt-mode update model | file: vite.config.ts | model: T2 [availability]
  - Ref: .dev/planning/modules/pwa-shell/design.md @ 2. The Web App Manifest — every field decided
  - Ref: .dev/planning/modules/pwa-shell/design.md @ 3. Service worker, precache, and the update model (D-017)
  - Ref: .dev/planning/modules/pwa-shell/design.md @ 6.4 The pulse AudioWorklet must be in the precache (offline)
  - Ref: .dev/planning/modules/pwa-shell/interfaces.md @ 7. Build-config objects (`vite.config.ts` `VitePWA()` block)
  - Ref: .dev/planning/modules/pwa-shell/edge-cases.md @ A. Service worker / offline  (A3 waiting SW mid-session, A4 ignored toast, A6 stale precache, A8 atomic install); .dev/knowledge/web-audio/pwa-setup.md (registerType prompt, install criteria, Workbox defaults)
  - Accepts: `ICON_FILES` (from `src/pwa/icon-files.ts`); project `base: '/'`
  - Creates: `VitePWA({ ... })` — `registerType:'prompt'` (D-017, never auto-reload mid-session), `injectRegister:null` (ui registers via `registerSW`, avoid double registration), `includeAssets:[faviconSvg, appleTouch180, 'audio/silence-5s.wav']`, `devOptions.enabled:false`; full `manifest` (all §2 fields: id/start_url/scope `/`, display standalone, theme/background `#0B0F14`, categories music+lifestyle, the 3 icons); `workbox` — `globPatterns ['**/*.{js,css,html,svg,png,ico,woff2,wav}']` (wav = silent loop, js = pulse worklet chunk), `navigateFallback:'index.html'`, `cleanupOutdatedCaches:true`, `clientsClaim:true`, `skipWaiting:false` (critical pairing with `prompt` — a waiting SW never auto-activates and so never destroys a running AudioContext)
  - Tests: build emits `manifest.webmanifest` with id/start_url/scope `/`, display standalone, theme+background `#0B0F14`, and 192 + 512 + maskable-512 icons (Chromium install criteria met); generated SW precaches the silent `.wav` and the worklet `.js` chunk; `skipWaiting:false` so a new SW waits (no mid-session reload); `injectRegister:null` so no plugin-injected registration races ui's `registerSW`; `vite dev` emits no SW

- [x] [audit] Behavioral audit: pwa-shell | file: .dev/.task-state/audit-pwa-shell.md | model: T1
  - Ref: C:/Projects/.dev-shared/behavioral-audit.md
  - Ref: .dev/planning/modules/pwa-shell/interfaces.md — every public interface (ICON_FILES, MANIFEST_ICONS/APP_ICONS, SILENT_LOOP_URL/MIN_SEC, the install-buffer helpers, the ambient types, the CSS-token contract, the VitePWA build-config object) must trace input → implementation → observable output
  - Ref: .dev/planning/modules/pwa-shell/design.md — verify intended behavior matches implementation (no auto-reload, base-correct URLs, dark-first paint, install-event never missed)
  - Ref: .dev/planning/modules/pwa-shell/edge-cases.md — verify every documented edge case (A1–A9, B1–B8, C1–C7, D1–D7, E1–E3, F) has evidence of handling and degrades gracefully
  - Verify the module's observable behavior matches its interfaces.md + edge-cases.md; confirm consumers (`ui` composition root + CSS, `transport` via injected `APP_ICONS`/`SILENT_LOOP_URL`) read the correct field names and shapes; write findings to .dev/.task-state/audit-pwa-shell.md; PASS required before the module is complete

## Completion Criteria
- [x] All tasks above marked [x] — zero tasks left [ ] (Pending) or [!] (Needs-Attention)
- [x] Zero active stubs for this module (the branding/final-logo stub stays registered as an explicit deferral per edge-cases D7, not an active blocker)
- [x] All module tests passing (full suite, not just this task's tests) — 69/69 green via `npx vitest run`
- [x] Audit PASS for every task
- [ ] last-step-summary.md written for every task with a concrete Observable Verification entry — deferred: orchestration directs findings to the structured report, not on-disk .md artifacts
- [x] Behavioral audit PASS (see the [audit] task above) — findings returned in the structured report
