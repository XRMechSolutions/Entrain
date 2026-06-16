# Architecture: BinauralAudio

Date: 2026-06-14
Status: Tier 2 skeleton. The WHAT/WHY lives in `planning/`; this is the execution map.
Per-module architecture.md + tasks.md are added in Tier 3/4.

## Stack
- TypeScript; Svelte 5 (UI, D-016); Vite + vite-plugin-pwa (build/PWA, D-017).
- Web Audio API (no DSP library) + one AudioWorklet for the pulse modulator (D-014).
- Persistence: localStorage + JSON file import/export. Local-only, offline-capable.

## Source layout (planned)
```text
src/
  engine/                 # framework-agnostic TS — NO Svelte imports
    session-model.ts      # Preset/Node types + validation + (de)serialization
    audio-engine.ts       # binaural voice node graph (D-015)
    pulse-worklet.ts      # AudioWorkletProcessor: phase-continuous pulse (D-014)
    automation.ts         # evaluate node timeline + schedule onto AudioParams (D-013/14)
    transport.ts          # play/pause/seek, fades, ctx lifecycle, MediaSession (D-018)
    persistence.ts        # localStorage + file import/export; preset library
  ui/                     # Svelte 5
    App.svelte
    components/...         # transport, controls, node editor (Phase 2)
  pwa/                    # manifest + icons + SW registration (vite-plugin-pwa)
```

## Module map → planning docs
| Module | Layer | Planning dir |
|--------|-------|--------------|
| session-model | 0 | `planning/modules/session-model/` |
| audio-engine | 0 | `planning/modules/audio-engine/` |
| automation | 1 | `planning/modules/automation/` |
| transport | 1 | `planning/modules/transport/` |
| persistence | 1 | `planning/modules/persistence/` |
| ui | 2 | `planning/modules/ui/` |
| pwa-shell | cfg | `planning/modules/pwa-shell/` |

## Key contracts (summary — see each module's interfaces.md)
- `session-model`: `Preset` types; `parse` / `serialize` / `validate`.
- `audio-engine`: `createVoice(ctx)`; carrier/beat/volume/balance setters; AudioParam
  handles; `start`/`stop`; pulse-worklet registration.
- `automation`: `valueAt(preset, param, t)`; `schedule(preset, param, audioParam, …)`.
- `transport`: `play`/`pause`/`seek`/`position`; fades; ctx + MediaSession lifecycle.
- `persistence`: `save`/`load`/`list`/`delete`/`export`/`import`.
