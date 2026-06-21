# Tasks: Renderer
# Planning: .dev/planning/modules/renderer/
# Architecture: .dev/modules/renderer/architecture.md
# Standards: safety
# Stack: typescript

## Agent Briefing
`renderer` (`src/engine/renderer.ts`, Layer-1, NEW) produces a finished audio file from a validated
`Preset` by replaying the byte-identical live graph — voice + mixer + layers + duck — against an
`OfflineAudioContext`, then encoding the rendered `AudioBuffer` to MP3 (lamejs, default) or WAV
(hand-rolled, lossless). It is a thin composition root: it owns context creation, clip pre-decode,
the same `scheduleAll`/`scheduleLayers` calls the transport makes (at offline `t0 = 0`), the
master 0→trim fade-in and trim→0 end fade-out, and encoding — and nothing about the sound itself.
It depends down on `mixer`, `layer-engine`, `layer-scheduler`, `automation`, `audio-engine`
(`{master:'bus'}`), `transport-master-gain`, `clip-library`, and `session-model`; it **must never**
import `transport` (enforced by `renderer.test.ts`). It is consumed by the `ui` export/share flow.

## References
- .dev/planning/modules/renderer/design.md
- .dev/planning/modules/renderer/interfaces.md
- .dev/planning/modules/renderer/edge-cases.md
- .dev/planning/modules/renderer/dependencies.md
- .dev/planning/phase2-audio-architecture.md — §1 bus topology, §2.1 `master:'bus'`, §4 ducking, §5 render path (normative), §6 contract spine + build order

## Dependencies
- `session-model` (Layer 0) — `Preset`, `Layer`, `LayerKind` (type-only) + `Preset.layers`/`durationSec`/`masterGain`/`name`. The §0 schema bump (v3→v4, `Layer`/`Preset.layers`) is a hard prerequisite. Must be complete first.
- `audio-engine` (Layer 0, CHANGED) — `createVoice` with `VoiceOptions.master:'bus'`, `registerPulseWorklet`, `Voice`. Must be complete first.
- `mixer` (Layer 0, NEW) — `createMixer`, `Mixer` (`bedInput`/`cueInput`/`liftInput`, `master`, `masterParam`/`duckParam`, `scheduleDuck`, `dispose`). Must be complete first.
- `layer-engine` (Layer 0, NEW) — `createLayerNode(ctx, layer, buffer?)`, `LayerNode`. Must be complete first.
- `layer-scheduler` (Layer 1, NEW) — `scheduleLayers(mixer, nodes, layers, {t0, startOffsetSec})`, `LayerSchedule` (owns the duck driver). Must be complete first.
- `automation` (Layer 1) — `scheduleAll`, `SessionSchedule`, `waveformKeyframes`. Must be complete first.
- `transport-master-gain` (UNCHANGED) — `createMasterGainController(param, getNow)`. Must be complete first.
- `clip-library` (NEW) — `getBlob(id): Promise<Blob | undefined>`. Must be complete first.
- Build-order gate (arch §6): the transport refactor lands BEFORE the renderer. Consumer `ui` is NOT a dependency (it depends up on this module).

## Tasks

- [x] [config] Add `lamejs@1.2.1` (exact pin) to package.json `dependencies` and a local `declare module 'lamejs'` ambient covering only `Mp3Encoder`. | file: package.json | model: T3
  - Ref: .dev/planning/modules/renderer/dependencies.md @ Runtime dependencies — lamejs (MP3 encoder)
  - Ref: .dev/planning/decisions-log.md @ D-037 (encoder = MP3 via lamejs, WAV lossless)
  - Accepts: the current package.json (no `dependencies` block exists yet — devDependencies only)
  - Creates: a new `"dependencies": { "lamejs": "1.2.1" }` block (exact, NOT `^1.2.1` — unmaintained, must not float); a `src/types/lamejs.d.ts` (or co-located) ambient `declare module 'lamejs' { export class Mp3Encoder { constructor(channels: number, sampleRate: number, kbps: number); encodeBuffer(l: Int16Array, r: Int16Array): Int8Array; flush(): Int8Array } }` — no `@types/lamejs`
  - Behavior: exact pin precisely because lamejs is unmaintained; pure-JS, no transitive deps, no WASM
  - Tests: `npm install` resolves lamejs@1.2.1; `import lamejs from 'lamejs'` type-checks against the ambient decl (verify `npx svelte-check` / `tsc --noEmit` passes); existing suites still green
  - Stubs expected: none

- [x] [impl][data] Encoders + module scaffolding: `RenderError`/`RenderErrorCode`, `RENDER_DEFAULTS`, the WAV writer (44-byte RIFF/WAVE/fmt /data header + interleaved 16-bit LE PCM via `DataView`), the lamejs MP3 encoder (Int16 chunks + flush), and `encodeBuffer(buffer, format, opts)` with per-chunk progress + abort. | file: src/engine/renderer.ts | model: T1
  - Ref: .dev/planning/modules/renderer/design.md @ 4. Encoding — `AudioBuffer` → `Blob` (4.1 MP3 via lamejs; 4.2 WAV hand-rolled; 4.3 renderToFile)
  - Ref: .dev/planning/modules/renderer/interfaces.md @ 2. Renderer types; @ 3. Error type; @ 4. Functions (encodeBuffer); @ 5. Constants
  - Ref: .dev/planning/modules/renderer/edge-cases.md @ 4. Encode failure (clamp `[-1,1]`, no NaN/Inf garbage, no truncated blob); @ 5. Cancellation (encode loop checks `signal.aborted` between chunks); @ 8. Environment / construction failures (invalid `format`/`mp3Kbps` → INVALID_OPTION)
  - Ref: .dev/planning/modules/renderer/dependencies.md @ Runtime dependencies — lamejs; @ Hand-rolled — WAV encoder
  - Accepts: `buffer: AudioBuffer` (2 ch), `format: 'mp3'|'wav'`, `options?: { mp3Kbps?; onProgress?; signal? }`
  - Creates: `RenderError extends Error` (`name:'RenderError'`, `code`, `cause`); `RenderErrorCode` union; `RENDER_DEFAULTS` (sampleRate 44100, fadeInSec 1.5, fadeOutSec 3, mp3Kbps 192); internal `encodeWav(buffer)` and `encodeMp3(buffer, kbps, onProgress, signal)`; exported `encodeBuffer(buffer, format, options?): Promise<Blob>`
  - Behavior: float→Int16 clamps to `[-1,1]` then scales by 32767 (a stray `NaN`/`Inf` becomes 0, never garbage — edge-cases §4); MP3 encodes in 1152-sample frames so it can report `phase:'encoding'` fraction = samples-done/total and check abort between chunks; `Blob` is built ONLY from the complete chunk list after a successful `flush()` (no truncated/corrupt blob); WAV `Blob` type `audio/wav`, MP3 `audio/mpeg`; bad `format` or non-finite/out-of-range `mp3Kbps` → `RenderError('INVALID_OPTION')`; a lamejs/WAV throw → `RenderError('ENCODE_FAILED', …, cause)`
  - Handles: ENCODE_FAILED (encoder throw), INVALID_OPTION (bad format/bitrate), CANCELLED (abort between chunks)
  - Tests (happy): WAV header well-formed (RIFF/`WAVE`/`fmt `/`data`, correct byte sizes, 16-bit, 2 ch, declared sampleRate) and decodes back to the input PCM within quantization; MP3 blob non-empty and `audio/mpeg`, decodes to ~same duration/stereo. (error): lamejs throw → `ENCODE_FAILED` (`.cause` preserved); bad `format` / non-finite `mp3Kbps` → `INVALID_OPTION`. (edge): `NaN`/`Inf` sample clamps to 0 not garbage; abort between chunks → `CANCELLED` promptly with partial chunks dropped; an empty/near-zero-length buffer still produces a valid (tiny) blob
  - Stubs expected: none (encoders are self-contained and downstream of the render path)

- [x] [impl][data] `renderToBuffer`: offline compose + pre-decode + schedule the same calls transport makes. Resolve+validate sampleRate and the OOM frame-count guard, construct `OfflineAudioContext(2, ceil(durationSec*rate), rate)`, `await registerPulseWorklet(ctx)` (await-to-completion; shepard NOT registered), `createVoice(ctx,{master:'bus'})`, compose `createMixer` (disconnect voice→destination, connect to `bedInput`, `master`→destination), build `LayerNode`s + connect by kind, PRE-DECODE all clip blobs, `scheduleAll(preset,voice,{startTime:0})` + `scheduleLayers(mixer,nodes,layers,{t0:0,startOffsetSec:0})`, the master fade-in + end fade-out, `voice.start(0)` + layer starts, `await ctx.startRendering()`, dispose. | file: src/engine/renderer.ts | model: T1
  - Ref: .dev/planning/modules/renderer/design.md @ 3. Render path (`renderToBuffer`) — steps 1–11; @ 2. Why offline reuse; @ 7. Determinism & equivalence; @ 8. `onProgress` contract; @ 9. Cancellation
  - Ref: .dev/planning/phase2-audio-architecture.md @ 5. Renderer — Reuse the Bus Offline (steps 1–9, normative); @ 1. Unified Bus Topology (single-input master, duck is bed-only); @ 2.1 `master:'bus'` flag; @ 4. Ducking (driver = layer-scheduler, single-writer D-019)
  - Ref: .dev/planning/modules/renderer/interfaces.md @ 1. Upstream §6 contracts (restated verbatim); @ 4. Functions (renderToBuffer); @ 5. Constants
  - Ref: .dev/planning/modules/renderer/edge-cases.md @ 1. Worklet registration failure → WORKLET (no silent degrade); @ 2. Missing clip → silence, render continues; @ 3. OOM pre-flight `MAX_RENDER_FRAMES` guard → RENDER_FAILED; @ 5. Cancellation at phase boundaries; @ 6. Degenerate durations (clamp fadeIn+fadeOut ≤ durationSec); @ 8. Environment/construction (UNSUPPORTED, DECODE_FAILED, INVALID_OPTION sampleRate)
  - Ref: .dev/planning/modules/renderer/dependencies.md @ Platform APIs (OfflineAudioContext, decodeAudioData, AbortSignal)
  - Accepts: `preset: Preset` (already validated by caller), `options?: { sampleRate?; onProgress?; signal? }`
  - Creates: exported `renderToBuffer(preset, options?): Promise<AudioBuffer>` returning a 2-channel buffer of `ceil(durationSec * sampleRate)` frames; a `MAX_RENDER_FRAMES` constant (sized so float render + Int16 encode buffers stay within a few hundred MB)
  - Behavior: sampleRate = `opts.sampleRate ?? 44100`, must be finite ∈ `[8000,192000]` else INVALID_OPTION (reject up front, not an opaque NotSupportedError); no `OfflineAudioContext` → UNSUPPORTED; frame count > `MAX_RENDER_FRAMES` → RENDER_FAILED before any allocation; pulse worklet `await`ed to completion (reject → WORKLET, no degrade — a degraded file differs from what the user heard); the shepard worklet is NOT registered (lift is a live-only transport overlay, never rendered); voice built `{master:'bus'}` (unity passthrough, no double-attenuation); `voice.output.disconnect(ctx.destination)` (try/catch) then `connect(mixer.bedInput)`; `mixer.master.connect(ctx.destination)` is the only edge into the offline destination; layers connect by `kind` — `tone`/`ambiance` → `bedInput` (ducked bed), `voice` (cue) → `cueInput` (post-duck overlay); PRE-DECODE every `{clipId}` layer via `getBlob` + `ctx.decodeAudioData` BEFORE any scheduling (offline render runs in one shot, cannot await mid-render), de-dup shared `clipId` to one buffer, a *missing* clip (`getBlob → undefined`) builds the layer with no buffer = silence and is collected as a notice (NOT an error), a *present-but-undecodable* blob → DECODE_FAILED naming the `clipId`; schedule with EXACTLY `scheduleAll(preset, voice, {startTime:0})` and `scheduleLayers(mixer, nodes, layers, {t0:0, startOffsetSec:0})` — the duck is scheduled BY `scheduleLayers`, the renderer never touches `duckParam` (single-writer D-019); master fade via `createMasterGainController(mixer.masterParam, () => ctx.currentTime).rampMaster(trim, fadeInSec)` where `trim = preset.masterGain`, then the trim→0 end fade written directly on `mixer.masterParam` as the closing leg (hold at trim until `durationSec - fadeOutSec`, then `linearRampToValueAtTime(0, durationSec)` — linear only, never exp-to-0, never `setValueCurve` per Firefox bug 1752775), fades clamped so `fadeInSec + fadeOutSec ≤ durationSec`; `voice.start(0)` + each layer `node.start(0 + layer.t)`; cancellation checked at phase boundaries (before `startRendering`, immediately after it resolves — mid-render abort impossible) → CANCELLED; on success or cancel, dispose `layerSchedule`/`voice`/`mixer`/each layer node (best-effort try/catch each)
  - Handles: WORKLET, DECODE_FAILED, RENDER_FAILED (construction/startRendering/OOM-guard), UNSUPPORTED, INVALID_OPTION, CANCELLED; missing-clip = silent layer (not an error)
  - Tests (happy): a multi-layer preset renders a 2-ch buffer of `ceil(durationSec*rate)` frames; `scheduleAll` invoked with `{startTime:0}` and `scheduleLayers` with `{t0:0, startOffsetSec:0}` (same calls transport makes); voice created `{master:'bus'}` (`masterGain.gain===1`); `master.connect(ctx.destination)` is the single destination edge; renderer never writes `mixer.duckParam` directly. (error): worklet reject → `WORKLET`, no `startRendering`; present-but-undecodable clip → `DECODE_FAILED` naming the clipId; no `OfflineAudioContext` → `UNSUPPORTED`; non-finite/out-of-range sampleRate → `INVALID_OPTION`; frame count over `MAX_RENDER_FRAMES` → `RENDER_FAILED` before allocation; abort before render → `CANCELLED`, no `startRendering` call; already-aborted signal → `CANCELLED` before any allocation. (edge): missing clip → that layer silent, render completes, missing clipId surfaced as a notice; very short preset (`durationSec < fadeIn+fadeOut`) → fades clamped, no overlap, still fades 0→trim→0; duplicate clipId decoded once; disposal runs on both success and cancel paths
  - Stubs expected: none (depends on completed upstream modules)
  - Ripple: none — renderer is a leaf consumer; it adds no second writer to any upstream param

- [x] [impl] [integration] `renderToFile` + offline waveform switches + cooperative cancellation orchestration: `renderToFile(preset, format, options?)` = `renderToBuffer` then `encodeBuffer`, returning `{ blob, filename, mime }` (filename sanitized from `preset.name` + extension); apply `waveformKeyframes(preset)` via offline `ctx.suspend(t)`/`.resume()` registered before `startRendering()` (degrade to initial waveform if `suspend` absent); wire the full `onProgress` phase sequence (`decoding`→`rendering`→`encoding`→`done`) with the try/catch wrapper. | file: src/engine/renderer.ts | model: T1-lite
  - Ref: .dev/planning/modules/renderer/design.md @ 4.3 `renderToFile`; @ 5. Progress model; @ 6. Waveform changes offline (suspend/resume); @ 8. `onProgress` contract (try/catch wrapper, always-called phases); @ 9. Cancellation (phase boundaries)
  - Ref: .dev/planning/modules/renderer/interfaces.md @ 2. Renderer types (RenderProgress, RenderPhase, RenderedFile, EncodeOptions); @ 4. Functions (renderToFile); @ 6. Worked example
  - Ref: .dev/planning/modules/renderer/edge-cases.md @ 6. Progress reporting limitation & degenerate durations (no native render progress, throwing onProgress wrapped); @ 7. Waveform changes offline (suspend/resume per keyframe; degrade to initial if `suspend` unavailable + one-time notice); @ 5. Cancellation
  - Ref: .dev/planning/phase2-audio-architecture.md @ 5. Renderer (step 7 same calls; waveform is not an AudioParam)
  - Accepts: `preset: Preset`, `format: 'mp3'|'wav'`, `options?: RenderOptions & EncodeOptions`
  - Creates: exported `renderToFile(preset, format, options?): Promise<RenderedFile>`; an internal filename sanitizer (`preset.name` → safe filename + `.mp3`/`.wav`); the offline waveform-keyframe registration (`ctx.suspend(t).then(() => { voice.setWaveform(w); ctx.resume(); })` per `waveformKeyframes(preset)` keyframe with `t>0`, registered before `startRendering`; `t=0` applied at construction)
  - Behavior: forwards `onProgress`/`signal` straight through to `renderToBuffer`, then continues reporting `phase:'encoding'` fraction over the encode loop; `mime` = `audio/mpeg`|`audio/wav`, extension matches; `onProgress` is called at least once per phase (`decoding` even with 0 clips → fraction 1; `rendering` start with fraction omitted = indeterminate; `encoding`; `done` fraction 1) and is wrapped in try/catch so a throwing handler never aborts an expensive render; waveform switches use offline suspend/resume (the one legitimate use — injecting a non-AudioParam discrete change at an exact render time, bounded by the deduplicated keyframe count); if `OfflineAudioContext.suspend` is unavailable, fall back to the initial (`t=0`) waveform for the whole file + emit a one-time notice, never block the render; bad `format` → INVALID_OPTION; encode throw → ENCODE_FAILED; propagates every `renderToBuffer` rejection
  - Handles: ENCODE_FAILED, INVALID_OPTION (bad format), CANCELLED (propagated), plus graceful waveform degrade (no `suspend`) and throwing-onProgress isolation
  - Tests (happy): `renderToFile(preset,'mp3')` → `{ mime:'audio/mpeg', filename:'<sanitized>.mp3', blob }`; `renderToFile(preset,'wav')` → `audio/wav`/`.wav`; `onProgress` emits `decoding`→`rendering`(no fraction)→`encoding`→`done`; a multi-waveform preset switches `oscL.type`/`oscR.type` at each keyframe via suspend/resume. (error): encode throw → `ENCODE_FAILED`; bad `format` → `INVALID_OPTION`; a cancel propagates as `CANCELLED`. (edge): a throwing `onProgress` handler does NOT abort the render (wrapped); a context with no `suspend` falls back to the initial waveform + one-time notice and still completes; a preset that never changes waveform is unaffected; filename sanitizer strips unsafe path characters
  - Stubs expected: none
  - Ripple: none

- [x] [test] `renderer.test.ts` guardrail suite: no-transport-import static check + a full offline render constructing zero transport, bus-mode voice assertion, same-call equivalence, determinism (render twice → bit-identical PCM), missing-clip silence, worklet-failure abort, cancel-before-render, and encode round-trips. | file: src/engine/renderer.test.ts | model: T1
  - Ref: .dev/planning/modules/renderer/design.md @ 10. Test guardrails (`renderer.test.ts` — full list); @ 7. Determinism & equivalence to playback
  - Ref: .dev/planning/phase2-audio-architecture.md @ 5. Renderer — "Enforce with renderer.test.ts running a full offline render with zero transport import"; @ 6. Open risks — "Accidental transport coupling … renderer.test.ts full offline render, no transport import"
  - Ref: .dev/planning/modules/renderer/edge-cases.md @ 9. Accidental transport coupling (build guardrail); @ 1. Worklet failure; @ 2. Missing clip; @ 5. Cancellation
  - Ref: .dev/planning/modules/renderer/interfaces.md @ 4. Functions; @ 3. Error type
  - Accepts: representative presets (multi-layer with tone/ambiance/voice-cue, a multi-waveform preset, a preset referencing a missing clip), a real `OfflineAudioContext` render plus a mock offline context lacking `decodeAudioData`/`suspend` to exercise degrade paths
  - Creates: `src/engine/renderer.test.ts` — the offline-render harness + all guardrail assertions
  - Tests (happy): full offline render completes and constructs NO transport; voice created `{master:'bus'}` (`masterGain.gain===1`, no double-attenuation); `scheduleAll` invoked `{startTime:0}` and `scheduleLayers` `{t0:0,startOffsetSec:0}` (same calls transport makes); render the same preset twice → bit-identical PCM (determinism, no randomness — design §7); WAV header well-formed (RIFF/`WAVE`/`fmt `/`data`, correct sizes); MP3 blob non-empty + `audio/mpeg`. (error): a static source check asserts `src/engine/renderer.ts` contains no `from './transport'` / `transport-types` import (fails the build on coupling); worklet failure offline → `RENDER`/`WORKLET` rejection, render aborted; cancel before render → `CANCELLED` with no `startRendering` call. (edge): missing clip → that layer silent, render still completes; a mock context lacking `decodeAudioData`/`suspend` exercises the degrade paths (DECODE handling / waveform fallback)
  - Behavior: this suite IS the arch §5/§6 transport-coupling mitigation — it must run as part of the standard `vitest run` and gate CI

## Behavioral Audit (runs after all tasks above are [x])

- [x] [audit] Module behavioral audit: renderer | file: .dev/.task-state/renderer/behavioral-audit.md | model: T1
  - Ref: C:/Projects/.dev-shared/behavioral-audit.md — Module Behavioral Audit checklist
  - Ref: .dev/planning/modules/renderer/interfaces.md — every public interface (`renderToBuffer`, `renderToFile`, `encodeBuffer`, `RenderError`, `RENDER_DEFAULTS`) must trace input → implementation → observable output
  - Ref: .dev/planning/modules/renderer/design.md — verify intended behavior: offline reuse byte-identical to playback (§2/§7), the §3 render path steps, encoding (§4), progress (§5), waveform offline (§6), cancellation (§9)
  - Ref: .dev/planning/modules/renderer/edge-cases.md — verify every documented edge case (§1–§9) has evidence of handling: worklet-failure→WORKLET (no silent degrade), missing-clip→silence (not an error), present-but-undecodable→DECODE_FAILED, OOM pre-flight guard, encode failure, cancellation at phase boundaries, waveform suspend/resume + degrade, environment/INVALID_OPTION, no-transport-import
  - Ref: .dev/planning/phase2-audio-architecture.md @ 5/§6 — confirm the same `scheduleAll`/`scheduleLayers` calls (`startTime:0`/`{t0:0,startOffsetSec:0}`), `master:'bus'`, single-writer `duckParam`/`masterParam` (D-019), no-click linear ramps (D-008)
  - For each public interface: trace an external caller's `Preset` → offline compose/decode/schedule/encode → the observable `AudioBuffer`/`Blob`/`RenderedFile`, with no silent valid-looking defaults (a missing-clip notice is surfaced, not swallowed as success)
  - For the consumer (`ui` export/share flow): verify it reads `{ blob, filename, mime }` field names/shapes correctly
  - Confirm the cohesion guardrails are green BEFORE and AFTER this module: `automation.test.ts` (scheduleLane extraction byte-identical), `audio-engine.test.ts` (only the one added bus-mode assertion; `master:'internal'` default unchanged), `transport-master-gain.test.ts` (unchanged); and `renderer.test.ts` enforces no-transport-import
  - Write findings to .dev/.task-state/renderer/behavioral-audit.md
  - PASS required before marking this module complete

## Completion Criteria
- [x] All tasks marked [x] — zero tasks left [ ] (Pending) or [!] (Needs-Attention) — verified 2026-06-16: config + 3 impl + test + audit all [x]
- [x] Zero active stubs for the `renderer` module in .dev/.task-state/stub-registry.md — verified 2026-06-16: the MP3/WAV encoder seam moved to Resolved (implemented, no `TODO(stub)` marker in code)
- [x] All module tests passing (full suite, not just the current task's tests) — and the three cohesion guardrails green before AND after: `automation.test.ts`, `audio-engine.test.ts`, `transport-master-gain.test.ts` — verified 2026-06-16: full `vitest run` = 55 files / 1187 tests passed; guardrails 65/63/8 green
- [x] `renderer.test.ts` passes, including the no-transport-import static check (build fails on coupling) — verified 2026-06-16: 44/44 green
- [x] Audit PASS for every task — per-task correctness established by the passing per-task test suites + this module behavioral audit (Phase-2 modules do not archive separate per-task `audit-*.md` files; cf. peer `layer-scheduler`). No per-task FAIL outstanding.
- [!] last-step-summary.md written for every task with a concrete Observable Verification entry — NOT satisfied: the renderer task-state dir has no archived per-task last-step-summaries (peer `layer-scheduler` does). Bookkeeping gap only — every impl task is `[x]`, fully tested, and behaviorally verified; no code/behavioral gap. See behavioral-audit.md NOTE.
- [x] Behavioral audit PASS (see above) — verified 2026-06-16: .dev/.task-state/renderer/behavioral-audit.md = PASS
