# Module: renderer

## Purpose
`renderer` produces a finished audio file (an `AudioBuffer`, then an encoded `Blob`) from a
validated `Preset` by replaying the *exact same* graph the transport plays — voice + mixer + layers
+ duck — against an `OfflineAudioContext` instead of a live `AudioContext`. Because the §1 unified
bus topology and the §2.1 `master:'bus'` flag make this offline composition byte-identical to live
playback, the rendered file equals what the user hears. The renderer adds nothing to the signal
path; it swaps the context, pre-decodes clips, schedules the same calls the transport makes at
offline `t0 = 0`, awaits `startRendering()`, then encodes the result to MP3 (lamejs, default) or WAV
(hand-rolled, lossless). It is a thin composition root — it owns context creation, decode, the
schedule calls, the master fade-out, and encoding, and nothing about the sound itself.

It deliberately does **not** import `transport` (no `routeOutput`, `msDest`, MediaSession, Wake Lock,
or rAF tick), does **not** define the signal graph (every routing/scheduling/duck/master contract is
owned upstream and is normative per phase2-audio-architecture.md §6), does **not** validate the
preset (caller's job), and does **not** write to disk (returns a `{ blob, filename, mime }` descriptor
the UI saves/shares).

## Public Interface
Implementation file: `src/engine/renderer.ts`. Full contracts in
`.dev/planning/modules/renderer/interfaces.md`.

```ts
export function renderToBuffer(preset: Preset, options?: RenderOptions): Promise<AudioBuffer>;
export function renderToFile(
  preset: Preset, format: RenderFormat, options?: RenderOptions & EncodeOptions,
): Promise<RenderedFile>;
export function encodeBuffer(
  buffer: AudioBuffer, format: RenderFormat,
  options?: EncodeOptions & { onProgress?: (p: RenderProgress) => void; signal?: AbortSignal },
): Promise<Blob>;

export type RenderFormat = 'mp3' | 'wav';
export type RenderPhase  = 'decoding' | 'rendering' | 'encoding' | 'done';
export interface RenderProgress { phase: RenderPhase; fraction?: number }   // fraction omitted during 'rendering'
export interface RenderOptions  { sampleRate?: number; onProgress?: (p: RenderProgress) => void; signal?: AbortSignal }
export interface EncodeOptions  { mp3Kbps?: number }
export interface RenderedFile   { blob: Blob; filename: string; mime: string }

export type RenderErrorCode =
  | 'INVALID_OPTION' | 'WORKLET' | 'DECODE_FAILED' | 'RENDER_FAILED'
  | 'ENCODE_FAILED' | 'CANCELLED' | 'UNSUPPORTED';
export class RenderError extends Error { readonly name: 'RenderError'; readonly code: RenderErrorCode; readonly cause?: unknown }

export const RENDER_DEFAULTS: { sampleRate: 44100; fadeInSec: 1.5; fadeOutSec: 3; mp3Kbps: 192 };
```

`RenderError` is the only error type this module originates: every public function rejects with a
`RenderError` (raw `DOMException`/`NotSupportedError` are wrapped, preserving `.cause`). A **missing**
clip is NOT an error (that layer renders silent); only a *present* blob that fails to decode is
`DECODE_FAILED`. Output is always 2-channel stereo. Consumed by the `ui` export/share flow.

## Dependencies
Interface-level only. The renderer is a composition root that replays the live-graph factories
offline; it imports, but **must never** import `transport` (enforced by `renderer.test.ts`).

| Module | Imports | Why |
|---|---|---|
| `session-model` | `Preset`, `Layer`, `LayerKind` (type-only) | the input contract |
| `audio-engine` | `createVoice`, `registerPulseWorklet`, `Voice` | binaural voice in `{master:'bus'}` mode (arch §2.1) |
| `mixer` | `createMixer`, `Mixer` | the unified bus (arch §1) |
| `layer-engine` | `createLayerNode`, `LayerNode` | build layer sources by kind (arch §6) |
| `layer-scheduler` | `scheduleLayers`, `LayerSchedule` | layer lanes + the duck driver (arch §4) |
| `automation` | `scheduleAll`, `SessionSchedule`, `waveformKeyframes` | the four binaural lanes + waveform keyframes |
| `transport-master-gain` | `createMasterGainController` | the param-agnostic master fade (arch §2.3) |
| `clip-library` | `getBlob` | fetch clip bytes to decode (pre-decode) |
| **`transport`** | **NEVER** | arch §5/§6 — would break offline reuse; `renderer.test.ts` enforces no import |

Runtime npm: **`lamejs@1.2.1`** (exact pin) — pure-JS MP3 encoder, no WASM/native, ships no types
(local ambient `declare module 'lamejs'`). WAV encoder is hand-rolled (no dependency). Platform APIs:
`OfflineAudioContext(2, frames, rate)` + `startRendering()`, `OfflineAudioContext.suspend(t)`/`.resume()`
(offline waveform switches), `decodeAudioData`, `AudioBuffer.getChannelData`, `AbortSignal`, `Blob`/`DataView`.

## Internal Structure
```
src/engine/
  renderer.ts        # renderToBuffer / renderToFile / encodeBuffer, RenderError, RENDER_DEFAULTS,
                     #   offline compose + pre-decode + schedule + master fade, MP3 (lamejs) + WAV encoders
  renderer.test.ts   # offline-render guardrails: no-transport-import, bus-mode voice, same-call
                     #   equivalence (startTime:0 / {t0:0}), determinism, missing-clip silence,
                     #   worklet-failure, cancel-before-render, encode round-trips
```

## Build order & cohesion
Layer-1, NEW. Per phase2-audio-architecture.md §6 build order, the renderer lands AFTER its
dependencies: session-model schema (§0) → mixer + layer-engine + `scheduleLane` extraction →
layer-scheduler + duck → transport refactor → **renderer**. The three existing test suites are
byte-identical cohesion guardrails and must run green before AND after this module lands:
`automation.test.ts` (`scheduleLane` extraction), `audio-engine.test.ts` (one added bus-mode
assertion only; default `master:'internal'` internal), and `transport-master-gain.test.ts`
(unchanged). The renderer honors no-click linear ramps only (D-008) and single-writer params (D-019):
it adds no second writer to `duckParam` (only `scheduleLayers`/`mixer.scheduleDuck`) or to
`masterParam` (only the master controller / its own pre-scheduled end-fade leg).

## Planning References
- .dev/planning/modules/renderer/design.md — render path (§3), encoding (§4), progress (§5), waveform offline (§6), determinism (§7), cancellation (§9), test guardrails (§10)
- .dev/planning/modules/renderer/interfaces.md — exact public contracts + upstream §6 contracts restated
- .dev/planning/modules/renderer/edge-cases.md — worklet failure, missing clip, OOM guard, encode failure, cancellation, waveform offline, environment failures, transport-coupling guardrail
- .dev/planning/modules/renderer/dependencies.md — lamejs pin + rationale, hand-rolled WAV, platform APIs, intra-repo imports
- .dev/planning/phase2-audio-architecture.md — §1 bus topology, §2.1 `master:'bus'`, §4 ducking, §5 render path (normative), §6 contract spine + build order
```
