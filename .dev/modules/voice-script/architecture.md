# Architecture: voice-script

Execution summary for the agent. The WHY lives in the Tier-3 planning docs
(`.dev/planning/modules/voice-script/`); the normative cross-module contract lives in
`.dev/planning/phase2-audio-architecture.md` §4 (duck intent) and §6 (the `compileVoiceScript`
row + build order). Read those before implementing — this file is only the map.

Status: NEW. Layer 1 (Phase 2, authoring-time only). Module-default model tier: T1-lite.
Primary file: `src/engine/voice-script.ts`.

---

## What this module is

`voice-script` is the **deterministic compiler** from an AI-authorable **VoiceScript** JSON to
concrete playable artifacts: an array of `{ kind: 'voice' }` `Layer`s and the deduped `Clip`s they
reference, with each emitted cue carrying its **duck intent** directly on `Layer.duck` (D-038). The same script compiles to byte-identical timing on
every device because layout uses **measured** clip durations (never estimates) and no phase reads
wall-clock time, randomness, or device state (design §11).

It is the executable half of the D-034 contract: the VoiceScript format (system-design §8.8) is the
*intent* an AI targets; this module is the *deterministic* realization. It runs at **authoring time
only** — never at playback, never in the renderer (D-024/D-035).

## File structure

Single file, `src/engine/voice-script.ts`, pure TypeScript, zero npm runtime dependency
(dependencies.md). Internal phase functions are not exported; only the public surface (§ below) is.
Five ordered, pure phases (design §3):

1. **validate** — structure, discriminator keys, ranges. On any error: return `{ ok:false, issues }`,
   **synthesize nothing** (design §7, edge-cases §1).
2. **resolveVoice** — per-language voice id from `Line.voice` → `script.voices[lang]` →
   `DEFAULT_VOICES[lang]`; effective rate = `(Line.rateScale ?? 1) * (script.rateScale ?? 1)`
   (design §4).
3. **flatten** — expand inline `repeat`, block `repeat`, script `loop` (innermost-first) into one
   linear placement list; enforce `MAX_REPEAT_DEPTH` / `MAX_PLACEMENTS` caps (design §6, §7).
4. **synthesize** — sequential `clipLib.importVia(tts, input)` per distinct say placement → `Clip`
   with measured `durationSec`; content-hash cache reuses one clip across all repeats (design §6).
5. **layout + emit** — single left-to-right walk over a `cursor`; gap precedence, `at:` anchors,
   `startAtSec`; emit one `voice` `Layer` per say placement, each carrying its `Layer.duck` (design §5, §8).

## Public interface (exact contract in interfaces.md §1–§5)

- `compileVoiceScript(script: VoiceScript, deps: CompileDeps): Promise<CompileResult>` — the entry
  point. Success arm `compiled.{ layers, clips }` is **byte-for-byte** the arch §6
  `Promise<{ layers: Layer[]; clips: Clip[] }>` shape (restated verbatim in interfaces.md §2.1),
  plus `totalSec`. Each emitted cue is `Layer{ kind:'voice', source:{clipId}, t, duck }` where `duck`
  is the session-model `DuckIntent` (D-038) — there is no `duckIntents` companion map.
- `compileVoiceScriptOrThrow(script, deps): Promise<{ layers, clips }>` — convenience overload;
  throws `VoiceScriptError(issues)` on any error-severity issue, drops warnings.
- Types: `VoiceScript`, `Block`, `Line` (`SayLine | PauseLine | InlineRepeatLine`), `ScriptLoop`,
  `DuckIntent`, `Lang`, `VoicePurpose`, `CompileDeps`, `TtsInput`, `ClipLibraryFacade`,
  `CompileResult`, `CompiledVoice`, `CompileIssue`, `CompileCode`, `Severity`.
- Constants: `DEFAULT_VOICES` (D-033 Kokoro ids), `MAX_REPEAT_DEPTH = 8`, `MAX_PLACEMENTS = 100_000`.
- Error class: `VoiceScriptError extends Error` (`name='VoiceScriptError'`, readonly `issues`).

## Dependencies (dependencies.md)

- **Runtime npm:** none. Hand-rolled validator + layout, mirroring the session-model precedent.
- **`session-model`** — types only (`Layer`, `LayerKind`, `LanePoint`); emits `{ kind:'voice' }`
  `Layer`s (session-model §10 shape).
- **`clip-library`** — `Clip`, `ClipSourceAdapter`, and `importVia` (synthesize-and-store +
  content-hash cache, D-023). The only call this module makes to produce clips.
- **`tts-local`** — **interface-only, injected**. The `ClipSourceAdapter<TtsInput>` is passed in via
  `CompileDeps.tts`; this module **never imports `tts-local`** and never touches a model,
  Transformers.js, ONNX, or `kuromoji.js`. This is the D-023 adapter seam (keeps the graph acyclic
  and lets tests pass a stub adapter).

## Boundaries — what it does NOT do (design §1)

- Does not synthesize speech (the injected `tts` adapter does).
- Does not store/hash/decode clips (clip-library owns that).
- Does not schedule onto `AudioParam`s, build audio nodes, write the duck envelope, or merge duck
  spans. It emits a **declarative** duck *intent* per cue on `Layer.duck`; `layer-scheduler` reads
  `layer.duck`, computes/merges spans, and `mixer.scheduleDuck` is the single `duckGain` writer
  (D-019, arch §4).
- Does not mutate/own a `Preset`. The caller (ui / preset-builder) merges `layers` into
  `Preset.layers` and adds `clips` to the library. The VoiceScript is a separate importable
  authoring artifact, NOT embedded in the preset (D-037 — no new schema field).

## Consumers

`ui` / `preset-builder` call `compileVoiceScript`, merge `compiled.layers` into `Preset.layers`,
add `compiled.clips` to the clip library, and hand the `layers` to `layer-scheduler` (which reads
`layer.duck` off the layers it already receives, arch §4 — no companion map, no extra
`scheduleLayers` param). The duck intent travels with the cue **on `Layer.duck`** (D-038), the
session-model-owned field.

## Reference docs

- `.dev/planning/modules/voice-script/design.md` — the five-phase pipeline, gap precedence, the
  three repeat mechanisms, `at:` anchor padding, emit + duck-intent carriage, determinism.
- `.dev/planning/modules/voice-script/interfaces.md` — exact TS for every type, signature, constant.
- `.dev/planning/modules/voice-script/edge-cases.md` — verbatim message templates + every failure
  mode and boundary.
- `.dev/planning/modules/voice-script/dependencies.md` — zero-dep posture; the injected-adapter seam.
- `.dev/planning/phase2-audio-architecture.md` §6 (contract spine + build order) and §4 (duck intent).
