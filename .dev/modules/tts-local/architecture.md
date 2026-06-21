# Architecture: tts-local

Date: 2026-06-15
Status: Tier 4 execution map. Layer 1 (Phase 2), **authoring-only**. The WHAT/WHY lives in
`planning/modules/tts-local/`; this is the agent's execution-focused summary. Normative contract:
`planning/phase2-audio-architecture.md` §6 (the `createTtsAdapter` row) — restated verbatim in
`interfaces.md` §1.

## Purpose (one paragraph)

`tts-local` is the `source: 'tts'` arm of the D-023 `ClipSourceAdapter` seam. It turns a line of
text (plus optional voice / language / rate) into a content-addressed `ClipDraft` by running a
neural TTS model (Kokoro-82M ONNX, dtype `q8`) **entirely in-browser, offline**. It exposes exactly
one factory, `createTtsAdapter`, producing an object that satisfies `ClipSourceAdapter<TtsInput>`. It
**does not** store, play, schedule, duck, render, or decode-for-playback — it is consumed only by
`voice-script` (D-034) and the authoring `ui`, and is **never** imported by `transport`, `renderer`,
`mixer`, `layer-engine`, or `layer-scheduler` (the offline-path firewall, design §5).

## File structure

```text
src/engine/clip-sources/
  tts-local.ts        # the entire module: createTtsAdapter + TtsInput/TtsAdapterOptions/TtsError
                      #   types + the VOICES config table + the lazy engine loader + the
                      #   dependency-free WAV encoder + the SHA-256 hash. One file.
```

The module imports its `ClipSourceAdapter` / `ClipDraft` / `ClipMeta` / `ClipSource` types from
`../clip-library` (type-only contract dependency — no storage functions imported). The Kokoro ONNX
weights, voice packs, espeak-ng data, kuromoji IPADIC dictionary, and onnxruntime-web `.wasm`
binaries are **bundled static app assets** served from the app origin (not npm, not runtime-fetched
from the HF hub); their Workbox precache/runtime-cache policy is owned by `pwa-shell` (cross-module
note, design §6 / dependencies.md "D-017 PWA precache implication").

## Public interface (full signatures in interfaces.md)

```ts
export type TtsLanguage = 'en' | 'es' | 'fr' | 'ja';
export interface TtsInput { text: string; voice?: string; language?: TtsLanguage; rateScale?: number }
export interface TtsAdapterOptions {
  device?: 'auto' | 'webgpu' | 'wasm';   // default 'auto' = feature-detect webgpu, else wasm
  dtype?: 'q8' | 'q4' | 'fp32';          // default 'q8' (D-037; validate — design §8)
  modelPath?: string;                     // local bundled model dir; default the app-served path
  modelId?: string;                       // model identity used in the hash; default 'kokoro-82m-<dtype>'
}
export function createTtsAdapter(opts?: TtsAdapterOptions): ClipSourceAdapter<TtsInput>;
// returned: { readonly source: 'tts'; produce(input: TtsInput): Promise<ClipDraft> }

export type TtsErrorCode =
  | 'EMPTY_TEXT' | 'UNSUPPORTED_LANGUAGE' | 'UNKNOWN_VOICE'
  | 'MODEL_LOAD_FAILED' | 'PHONEMIZER_UNAVAILABLE' | 'SYNTHESIS_FAILED';
export class TtsError extends Error { readonly name: 'TtsError'; readonly code: TtsErrorCode; readonly cause?: unknown }
```

`createTtsAdapter` is pure and synchronous — it does no model I/O and never throws. All loading is
deferred to the first `produce`. `produce` runs the fixed pipeline (design §2): validate & normalize
→ `hash = SHA256(modelId + voice + lang + normalizedText + rate)` → ensure engine loaded (lazy, once)
→ G2P → synth Float32 PCM → WAV-encode → measure `durationSec` (`pcm.length / sampleRate`, finite > 0)
→ return `ClipDraft{ hash, blob, format:'audio/wav', durationSec, source:'tts', meta }`. It **always**
rejects with a typed `TtsError` (never a raw library error / DOMException; `.cause` preserved), never
throws synchronously.

## Dependencies

| Dependency | Type | Role |
|---|---|---|
| `@huggingface/transformers` (`^3`) | npm runtime | Transformers.js — in-browser Kokoro ONNX runtime via onnxruntime-web; device negotiation webgpu→wasm; bundled espeak-ng G2P for en/es/fr. Pulls onnxruntime-web transitively. |
| `kuromoji` (`^0.1`) | npm runtime | Japanese G2P — tokenize JA text → katakana readings → Kokoro JA voice. Loaded lazily, only on the first `language:'ja'` line. |
| Kokoro-82M ONNX (q8), voice packs, espeak-ng data, kuromoji IPADIC, ORT `.wasm` | bundled static assets | the model + dictionaries + wasm backends; same-origin, `env.allowRemoteModels = false`; precache/runtime-cache owned by `pwa-shell` (D-017). |
| `clip-library` | project (types only) | source of the `ClipSourceAdapter` / `ClipDraft` / `ClipMeta` / `ClipSource` contract this module produces. |
| `crypto.subtle` / `navigator.gpu` / `Blob` / `TextEncoder` / `self.crossOriginIsolated` | built-in platform | SHA-256 hash; WebGPU probe; WAV bytes out; utf-8 encode; COOP/COEP isolation detection. |

## Key decisions referenced

- **D-024 / D-028 / D-031** — authoring-only; TTS never runs on the playback or offline-render path.
- **D-032** — truly offline, in-browser synthesis (`env.allowRemoteModels = false`); Transformers.js
  + Kokoro chosen; sherpa-onnx is the documented fallback, not a v1 dependency.
- **D-033** — four languages (en/es/fr/ja), one Kokoro runtime; voice ids are a per-voice config table.
- **D-037** — Kokoro dtype `q8` (validate at impl); `kuromoji.js → Kokoro` is the v1 Japanese G2P path.
- **D-017** — the large bundled artifacts collide with Workbox's default size limit; resolved in
  `pwa-shell` (raise `maximumFileSizeToCacheInBytes` and/or runtime-cache on first authoring use).

## Cohesion guardrails (do not regress)

This module is additive and authoring-only — it touches none of the playback/render bus topology.
The existing op-sequence guardrail suites (`automation.test.ts`, `audio-engine.test.ts`,
`transport-master-gain.test.ts`) MUST stay byte-identical and run green before AND after this
module lands; this module imports none of those files and adds no second writer to any AudioParam
(D-019 single-writer, D-008 no-click are out-of-scope here but the full suite is the proof of
no-regression).
