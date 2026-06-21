# Architecture: BinauralAudio

Date: 2026-06-14
Status: Tier 2 skeleton. The WHAT/WHY lives in `planning/`; this is the execution map.
Per-module architecture.md + tasks.md are added in Tier 3/4.

## Stack
- TypeScript; Svelte 5 (UI, D-016); Vite + vite-plugin-pwa (build/PWA, D-017).
- Web Audio API (no DSP library) + one AudioWorklet for the pulse modulator (D-014).
- Persistence: localStorage + JSON file import/export (presets); **IndexedDB** (Phase-2 clip
  blob + metadata store `binaural-clips`, via `idb`). Local-only, offline-capable.
- Phase-2 deps: `idb` ^8 (clip-library IndexedDB wrapper); `@huggingface/transformers` ^3 +
  `kuromoji` ^0.1 (tts-local — in-browser Kokoro-82M ONNX TTS, JA G2P; bundled model/dictionary/
  ORT-wasm assets, D-032/D-033/D-037); `lamejs` 1.2.1 (renderer MP3 export, WAV hand-rolled lossless
  fallback, D-037). All offline / in-browser; no network at run or authoring time.

## Phase-2 routing & scheduling architecture (normative)
- **`planning/phase2-audio-architecture.md`** is the normative routing/scheduling spec for all
  Phase-2 audio modules (D-036/D-037). It defines the unified three-input bus topology
  (bed/cue/lift → busSum → master), the `master: 'internal' | 'bus'` audio-engine flag, the shared
  `scheduleLane` primitive extracted from `automation`, bed-only ducking (single-writer `duckGain`,
  D-019), offline render reuse, and the cross-module contract spine. Every Phase-2 module's Tier-3
  doc derives from it; consult it before touching the audio graph.

## Source layout (planned)
```text
src/
  engine/                 # framework-agnostic TS — NO Svelte imports
    session-model.ts      # Preset/Node types + validation + (de)serialization
                          #   v4: + Layer/LayerKind/LayerSource/ToneSpec/LanePoint + Preset.layers (§0)
    audio-engine.ts       # binaural voice node graph (D-015)
                          #   Phase-2: + VoiceOptions.master 'internal'|'bus' flag (default internal)
    pulse-worklet.ts      # AudioWorkletProcessor: phase-continuous pulse (D-014)
    automation.ts         # evaluate node timeline + schedule onto AudioParams (D-013/14)
                          #   Phase-2: scheduleLane primitive extracted (sole no-click param writer)
    transport.ts          # play/pause/seek, fades, ctx lifecycle, MediaSession (D-018)
                          #   Phase-2: composes the bus mixer; schedules layers; retargets master
    persistence.ts        # localStorage + file import/export; preset library
    mixer.ts              # NEW — unified bed/cue/lift→busSum→master bus; bed-only duck (D-036)
    layer-engine.ts       # NEW — createLayerNode: per-layer source (synth tone / clip) + gain/pan
    layer-scheduler.ts    # NEW — scheduleLayers: layer lanes + duck-span merge onto the mixer
    renderer.ts           # NEW — offline render of the bus to an audio file (MP3/WAV); no transport
    voice-script.ts       # NEW — compile a voice script → Layer[]+Clip[] (authoring-only)
    clip-library.ts       # NEW — IndexedDB clip blob/metadata store; content-hash dedup
    clip-sources/         # NEW — ClipSourceAdapter implementations (produce a ClipDraft)
      file-import.ts      #   file → ClipDraft (decode/measure/hash); owned by clip-library
      tts-local.ts        #   text → ClipDraft via in-browser Kokoro TTS (authoring-only)
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
| clip-library | 0 | `planning/modules/clip-library/` |
| clip-sources/file-import | 0 | `planning/modules/clip-library/` (adapter owned by clip-library) |
| mixer | 0 | `planning/modules/mixer/` |
| layer-engine | 0 | `planning/modules/layer-engine/` |
| layer-scheduler | 1 | `planning/modules/layer-scheduler/` |
| renderer | 1 | `planning/modules/renderer/` |
| tts-local | 1 | `planning/modules/tts-local/` (authoring-only) |
| voice-script | 1 | `planning/modules/voice-script/` (authoring-only) |

Phase-2 layer/build order (phase2-audio-architecture.md §6): session-model schema bump (§0, hard
prereq) → mixer + layer-engine + `scheduleLane` extraction → layer-scheduler + duck → transport
refactor → renderer → authoring (tts-local, voice-script). L0 modules (mixer, layer-engine,
audio-engine) are pure Web Audio against any `BaseAudioContext` — no rAF / MediaSession /
`createMediaStreamDestination` — so the renderer can reuse them against an `OfflineAudioContext`.

## Phase-2 refactors to existing modules (additive, guardrail-protected)
- **session-model** — schema v3→v4: add `Layer` / `LayerKind` / `LayerSource` / `ToneSpec` /
  `LanePoint` and `Preset.layers` (optional); `migrate` walks v2→v3→v4 (pure version-bumps).
  `session-model.test.ts` is the guardrail.
- **audio-engine** — add `VoiceOptions.master?: 'internal' | 'bus'` (default `'internal'`,
  unchanged Phase-1 behavior). `'bus'` makes `masterGain` unity passthrough and `setMasterGain` a
  guarded no-op so the voice reuses cleanly under the mixer/offline. `audio-engine.test.ts` runs at
  the `'internal'` default with zero edits (one bus-mode assertion added).
- **automation** — extract the base-curve writer (`scheduleBaseCurve`/`scheduleSmoothSegment`) into
  the exported `scheduleLane` primitive (verbatim; the binaural lanes call it via a thin in-closure
  adapter). `automation.test.ts` is the byte-identical op-sequence guardrail — green before AND after.
- **transport** — compose the mixer in `startFresh`, route `voice.output → mixer.bedInput`, bind the
  master controller to `mixer.masterParam`, retarget routing/lift/teardown onto `mixer.master`, and
  schedule layers (`scheduleLayers`) alongside the binaural scheduler. No-click ramps (D-008) and
  single-writer params (D-019) preserved. `transport-master-gain.ts` needs no code change (the
  controller is already param-agnostic); `transport-master-gain.test.ts` stays unchanged.

## Key contracts (summary — see each module's interfaces.md)
- `session-model`: `Preset` types (+ v4 `Layer`/`LayerKind`/`LayerSource`/`ToneSpec`/`LanePoint`);
  `parse` / `serialize` / `validate` / `migrate`.
- `audio-engine`: `createVoice(ctx, { master?: 'internal' | 'bus' })`; carrier/beat/volume/balance
  setters; AudioParam handles; `start`/`stop`; pulse-worklet registration.
- `automation`: `valueAt(preset, param, t)`; `schedule(preset, param, audioParam, …)`;
  `scheduleLane(param, points, opts)` (shared no-click writer — binaural lanes, layer lanes, duck).
- `transport`: `play`/`pause`/`seek`/`position`; fades; ctx + MediaSession lifecycle.
- `persistence`: `save`/`load`/`list`/`delete`/`export`/`import`.
- `mixer`: `createMixer(ctx, opts?)` → `{ bedInput/cueInput/liftInput; master; masterParam/duckParam;
  scheduleDuck(spans, t0, startOffsetSec); cancelDuck; connect/disconnect/dispose }`.
- `layer-engine`: `createLayerNode(ctx, layer, buffer?)` → `{ id; kind; output; gainParam/panParam;
  start/stop/dispose }`.
- `layer-scheduler`: `scheduleLayers(mixer, nodes, layers, { t0, startOffsetSec })` →
  `{ retarget; cancel; dispose }`; computes + merges duck spans (MIN toGain) for `mixer.scheduleDuck`.
- `renderer`: `renderToBuffer(preset, …)` — composes the byte-identical bus offline; MP3/WAV out.
- `clip-library`: `add` / `importVia` / `get` / `getByHash` / `getBlob` / `list` / `remove` /
  `totalBytes`; `createFileImportAdapter()`; `Clip` / `ClipDraft` / `ClipSourceAdapter` seam.
- `tts-local`: `createTtsAdapter(opts?)` → `ClipSourceAdapter<{ text; voice?; language?; rateScale? }>`
  (authoring-only).
- `voice-script`: `compileVoiceScript(script, { tts, clipLib })` → `{ layers: Layer[]; clips: Clip[] }`
  (authoring-only; feeds `Preset.layers`).
