# Tasks: layer-engine
# Planning: .dev/planning/modules/layer-engine/
# Architecture: .dev/modules/layer-engine/architecture.md
# Standards: security, safety
# Stack: typescript

## Agent Briefing

`layer-engine` builds the Web-Audio node graph for one stacked audio layer (synth tone, looping
ambiance bed, or one-shot voice cue) and returns it as a `LayerNode` handle — the per-layer analogue
of `audio-engine`'s `Voice`. It is a pure Layer-0 signal core: synchronous, no Promise, Web-Audio
only, takes any `BaseAudioContext` so the identical code builds the graph live (transport) and
offline (renderer). It imports only `Layer`/`LayerKind`/`ToneSpec`/`LayerSource` *types* from
`session-model`; it never imports `clip-library`, `automation`, `mixer`, or `transport`. Consumers:
`transport` + `renderer` construct one node per layer and connect `output` to the mixer by `kind`;
`layer-scheduler` is the single writer of `gainParam`/`panParam` (D-019).

## References

- .dev/planning/modules/layer-engine/design.md
- .dev/planning/modules/layer-engine/interfaces.md
- .dev/planning/modules/layer-engine/edge-cases.md
- .dev/planning/modules/layer-engine/dependencies.md
- .dev/planning/phase2-audio-architecture.md  (§6 contract spine — normative; §0 schema gate; §1 bus topology; §5 offline reuse)
- src/engine/audio-engine.ts  (the Voice this mirrors — no-click D-008, one-shot sources, JS-tracked state)

## Dependencies

- **session-model v3→v4 schema bump (arch §0) MUST be complete** — `Layer`, `LayerKind`, `ToneSpec`,
  `LayerSource`, `Preset.layers` do not exist in code until then. This is a hard dependency edge.
  `session-model.test.ts` is that task's guardrail and must be green.
- No other module is required to start. `layer-engine` is L0 and imports no runtime project code.
- Cohesion guardrail (run green BEFORE and AFTER all work here — this module touches none of their
  source, but the shared test-mock extension in Task 1 must not regress them):
  `automation.test.ts` (scheduleLane op-sequence), `audio-engine.test.ts` (master flag default
  `'internal'`), `transport-master-gain.test.ts` — all byte-identical guardrails, must stay green.

## Tasks

- [x] [prereq] Extend the shared Web-Audio test mock with StereoPanner and BufferSource nodes | file: src/test/webaudio-mock.ts | model: T2
  - Ref: .dev/planning/modules/layer-engine/dependencies.md @ Platform APIs (StereoPannerNode, AudioBufferSourceNode)
  - Ref: .dev/planning/modules/layer-engine/edge-cases.md @ 2 (zero-length / channel-count buffers), @ 7 (OfflineAudioContext support)
  - Ref: .dev/planning/phase2-audio-architecture.md @ §5 (offline reuse — mock must model BaseAudioContext shape)
  - Why: `MockAudioContext` today has `createOscillator`/`createGain` but NO `createStereoPanner`
    and NO `createBufferSource`; the layer-engine suite (Tasks 5-9) cannot run without them.
  - Creates: `MockStereoPannerNode` with a `.pan` `MockAudioParam` (default 0, range [-1,1]) and
    `ctx.createStereoPanner()`; `MockAudioBufferSourceNode` with `.buffer`, `.loop` (default false),
    one-shot `start(when)`/`stop(when)` (second `start` records reuse so the engine's guard is
    testable), and `ctx.createBufferSource()`. Register both in `ctx.created` for graph assertions.
  - Behavior: mirror the existing Mock node conventions (connect/disconnect tracking, param model);
    `.pan` and `.gain` use the existing `makeParam` with min/max so range is modeled.
  - Handles: zero-length buffer (`buffer.length === 0`) and mono/>2-channel buffer accepted without error.
  - Tests: extend webaudio-mock self-checks (or add a focused spec) asserting `createStereoPanner`
    returns a node whose `.pan` defaults to 0 and clamps to [-1,1]; `createBufferSource` exposes
    `.buffer`/`.loop` and records a one-shot start/stop. Happy: both factories return wired nodes.
    Error: none (pure infra). Edge: zero-length buffer accepted; second `start` flagged for guard test.
  - Ripple: shared test infra — confirm `audio-engine.test.ts`, `automation.test.ts`,
    `transport-master-gain.test.ts`, `transport.test.ts` still import and pass unchanged (additive only).

- [x] [impl] Scaffold layer-engine module: types, LayerNodeError, and the layerGain→panner→output tail | file: src/engine/layer-engine.ts | model: T1
  - Ref: .dev/planning/modules/layer-engine/interfaces.md @ 1 (contract spine VERBATIM), @ 2 (error type)
  - Ref: .dev/planning/modules/layer-engine/design.md @ 2 (the LayerNode handle), @ 3 (§3 chain tail, §3.4 why layerGain/panner separate)
  - Ref: .dev/planning/phase2-audio-architecture.md @ §6 (createLayerNode signature — normative, restate exactly)
  - Ref: src/engine/audio-engine.ts (AudioEngineError shape: name, code, optional cause, prototype restored for instanceof)
  - Accepts: nothing yet at this step beyond exporting the surface; defines `createLayerNode(ctx, layer, buffer?)` skeleton.
  - Creates: `export function createLayerNode(ctx: BaseAudioContext, layer: Layer, buffer?: AudioBuffer): LayerNode`;
    interfaces `LayerNode`, type `LayerNodeState = 'idle'|'running'|'stopped'`, type
    `LayerNodeErrorCode = 'INVALID_CONTEXT'|'ALREADY_STARTED'`, class `LayerNodeError`. Builds the
    shared tail `layerGain (GainNode) → panner (StereoPannerNode) → output`, sets
    `layerGain.gain.value = 1` (unity) and `panner.pan.value = 0` (center) at construction, and wires
    `output = panner`, `gainParam = layerGain.gain`, `panParam = panner.pan`, `id = layer.id`,
    `kind = layer.kind`. Imports `Layer`/`LayerKind`/`ToneSpec`/`LayerSource` as `import type` only.
  - Behavior: synchronous; never returns a Promise. `output` is ALWAYS the StereoPannerNode for every
    kind. Per-kind source wiring is added in Tasks 3-4; this task leaves the source slot empty/silent.
  - Handles: `INVALID_CONTEXT` — throw `LayerNodeError('INVALID_CONTEXT')` when `ctx` is missing or
    lacks `createGain`/`createStereoPanner` (the only construction-time throw). No clip-library /
    automation / mixer / transport / DOM import (enforced — L0 isolation).
  - Tests: covered by Task 5 (construction defaults + output stability) and Task 6 (INVALID_CONTEXT).
  - Stubs expected: source-construction switch on `kind` is a stub here (TODO(stub): per-kind source) —
    register in .dev/.task-state/stub-registry.md; resolved by Tasks 3 and 4.

- [x] [impl] Implement the tone chain: oscillator + linear one-shot ADSR scheduled at start | file: src/engine/layer-engine.ts | model: T1
  - Ref: .dev/planning/modules/layer-engine/design.md @ 3.1 (tone chain, ADSR shape), @ 4 (start schedules ADSR + osc.start/stop)
  - Ref: .dev/planning/modules/layer-engine/interfaces.md @ 3 (tone row: attack 0→1 over attackSec, release 1→0 over releaseSec, one-shot length = attackSec+releaseSec)
  - Ref: .dev/planning/modules/layer-engine/edge-cases.md @ 6 (degenerate ADSR: 0/0, attack 0, release 0, very large), @ 3 (tone + loop:true ignored)
  - Ref: .dev/planning/phase2-audio-architecture.md @ §0 (tone = one-shot tone/bell only, NO filtered-noise drone)
  - Ref: src/engine/audio-engine.ts (rampTo — linear only, never exp, never setValueCurve; D-008 anti-click)
  - Accepts: a `tone` layer (`source: { synth: ToneSpec }`); `buffer` is unused/ignored for tones.
  - Creates: `OscillatorNode(type = synth.shape, frequency.value = synth.freqHz) → envGain(GainNode) → layerGain`.
    `envGain.gain.value = 0` at construction (silent start, D-008). At `start(t0)`:
    `setValueAtTime(0, t0)`, `linearRampToValueAtTime(1, t0 + attackSec)`,
    `linearRampToValueAtTime(0, t0 + attackSec + releaseSec)`; then `osc.start(t0)` and
    `osc.stop(t0 + attackSec + releaseSec)`. `missing` stays false (tone never missing).
  - Behavior: LINEAR ramps only (D-008 / Firefox setValueCurve bug). `loop` on a tone is ignored
    (no warn, no throw). The oscillator runs at its own freq directly — no ConstantSource summing.
  - Handles: `attackSec === 0 && releaseSec === 0` → zero-length no-op (start+stop osc at same instant,
    no NaN, no negative-duration ramp); `attackSec === 0` → instant jump to peak; `releaseSec === 0` →
    immediate drop at t0+attackSec; very large sum → scheduled as given (no cap).
  - Resolves stubs: the `kind === 'tone'` branch of the per-kind source stub from Task 2.
  - Tests: covered by Task 7 (tone graph + ADSR op sequence) and Task 8 (degenerate ADSR variants).

- [x] [impl] Implement ambiance (loop=true) and voice (loop=false) buffer-source chains + missing-clip silent node | file: src/engine/layer-engine.ts | model: T1
  - Ref: .dev/planning/modules/layer-engine/design.md @ 3.2 (ambiance loop=true), @ 3.3 (voice loop=false), @ 5 (missing clip → silent node + missing flag, never throw)
  - Ref: .dev/planning/modules/layer-engine/edge-cases.md @ 1 (missing buffer → silent node), @ 2 (zero-length buffer tolerated, not missing), @ 3 (loop per kind: ambiance forced true, voice forced false)
  - Ref: .dev/planning/modules/layer-engine/interfaces.md @ 3 (ambiance/voice/missing-clip rows)
  - Ref: .dev/planning/phase2-audio-architecture.md @ §0 (ambiance = looping clips only; voice = one-shot cue), @ §1 (voice routes to cueInput — caller's job, engine only stamps kind)
  - Accepts: an `ambiance` or `voice` layer (`source: { clipId }`); `buffer` = pre-decoded `AudioBuffer | undefined`.
  - Creates: when `buffer` is present — `AudioBufferSourceNode(buffer)` with `loop = true` for
    `ambiance`, `loop = false` for `voice`, connected `→ layerGain`. When `buffer` is `undefined`
    for a `{ clipId }` layer — build NO source (silent node), set `missing = true`; the
    `layerGain → panner → output` tail still exists so routing/scheduling are identical.
  - Behavior: `loop` resolved per kind deterministically (ambiance forced `true` regardless of
    `Layer.loop`; voice forced `false`). The engine never connects `output` to the mixer and holds no
    mixer reference — it only stamps `kind` so the caller routes voice→cueInput, tone/ambiance→bedInput.
  - Handles: missing clip = data condition, NEVER thrown (parallels clip-library `getBlob → undefined`);
    `buffer.length === 0` = present-but-degenerate → real source, `missing` stays false, plays silence
    harmlessly (no error/NaN/busy-loop); mono/>2-channel buffer passed straight to `src.buffer`
    (Web Audio up/down-mixes to the stereo panner).
  - Resolves stubs: the `kind === 'ambiance'` and `kind === 'voice'` branches of the per-kind source stub from Task 2.
  - Tests: covered by Task 7 (ambiance/voice graph + loop flag) and Task 9 (missing-clip silence, zero-length).

- [x] [impl] Implement the start/stop/dispose lifecycle and one-shot ALREADY_STARTED guard | file: src/engine/layer-engine.ts | model: T1
  - Ref: .dev/planning/modules/layer-engine/design.md @ 4 (lifecycle, state machine idle→running→stopped, seek = dispose+rebuild)
  - Ref: .dev/planning/modules/layer-engine/edge-cases.md @ 5 (start twice throws; stop before start no-op; start/stop after dispose no-op), @ 8 (dispose without stop; dispose twice; stop in the past)
  - Ref: .dev/planning/modules/layer-engine/interfaces.md @ 1 (start/stop/dispose JSDoc contracts), @ 3 (start-twice / stop / dispose rows)
  - Ref: .dev/planning/phase2-audio-architecture.md @ §2.2 (on seek, dispose + rebuild layer nodes — one-shot sources cannot restart)
  - Ref: src/engine/audio-engine.ts (Voice start/stop/dispose: VOICE_ALREADY_STARTED guard, disposed guard, JS-tracked state)
  - Accepts: `start(atCtx: number)`, `stop(atCtx?: number)`, `dispose()` on every kind incl. silent nodes.
  - Creates: a JS-tracked `state: 'idle'|'running'|'stopped'` (one-way). `start` advances idle→running
    and starts the source (tone: schedule ADSR + osc.start/stop from Task 3; ambiance/voice: src.start).
    `stop(atCtx?)` defaults `atCtx` to `ctx.currentTime`, stops the source, and for tone cancels the
    remaining envelope schedule past `atCtx` (`cancelScheduledValues`); advances running→stopped.
    `dispose()` disconnects every owned node (source, envGain if any, layerGain, panner).
  - Behavior: a missing-clip silent node's `start` advances state to running but is a structural no-op
    (no source); `stop`/`dispose` behave identically to a real node. State machine mirrors the Voice.
  - Handles: second `start` → throw `LayerNodeError('ALREADY_STARTED')` (one-shot, seek=rebuild);
    `stop` before `start` → no-op (state stays idle); second `stop` → no-op (terminal);
    `dispose` is idempotent (second call returns immediately — `disposed` guard); `start`/`stop` after
    `dispose` → no-op; `stop` at a past ctx time → passed through unchanged ("stop now"); the shared
    `AudioBuffer` is NOT disposed (caller owns the decode cache, survives rebuilds).
  - Tests: covered by Task 10 (lifecycle + start-twice + idempotent dispose + missing-node no-ops).

- [x] [test] Test construction defaults, stable output, and L0 purity | file: src/engine/layer-engine.test.ts | model: T1Lite
  - Ref: .dev/planning/modules/layer-engine/interfaces.md @ 3 (output always StereoPanner; gainParam unity 1; panParam center 0)
  - Ref: .dev/planning/modules/layer-engine/design.md @ 2 (handle), @ 3 (tail defaults), @ 1 (no transport/clip-library/DOM import)
  - Ref: .dev/planning/phase2-audio-architecture.md @ §5 (offline reuse — works against OfflineAudioContext-style ctx)
  - Accepts: uses `MockAudioContext` (+ Task 1 StereoPanner/BufferSource) from src/test/webaudio-mock.ts.
  - Tests (happy): for each kind, `output` is the StereoPannerNode, `gainParam.value === 1`,
    `panParam.value === 0`, `id === layer.id`, `kind === layer.kind`, `missing === false` for healthy
    nodes; `state === 'idle'` before start. Edge: works with a sampleRate ≠ 48000 / offline-style ctx.
    Purity: the module file imports no clip-library / automation / mixer / transport / DOM symbol
    (grep/AST assertion mirroring renderer.test.ts's zero-transport-import check).

- [x] [test] Test INVALID_CONTEXT and LayerNodeError shape | file: src/engine/layer-engine.test.ts | model: T1Lite
  - Ref: .dev/planning/modules/layer-engine/edge-cases.md @ 7 (ctx missing / not a BaseAudioContext → INVALID_CONTEXT)
  - Ref: .dev/planning/modules/layer-engine/interfaces.md @ 1 (no error code for missing/zero-length/bad-lane), @ 2 (error type shape)
  - Ref: src/engine/audio-engine.ts (AudioEngineError parallel — instanceof after transpile)
  - Tests (error): `createLayerNode(null, …)` and `createLayerNode({}, …)` throw
    `LayerNodeError` with `code === 'INVALID_CONTEXT'`; the error is `instanceof LayerNodeError` and
    `instanceof Error` (prototype restored); `name === 'LayerNodeError'`. Assert there is NO error
    code for missing/zero-length buffer (those paths in Task 9 never throw).

- [x] [test] Test tone, ambiance, and voice node graphs and source flags | file: src/engine/layer-engine.test.ts | model: T1Lite
  - Ref: .dev/planning/modules/layer-engine/design.md @ 3.1 (tone chain + ADSR), @ 3.2 (ambiance loop=true), @ 3.3 (voice loop=false)
  - Ref: .dev/planning/modules/layer-engine/interfaces.md @ 3 (tone/ambiance/voice rows), @ 4 (worked example: bell tone)
  - Ref: .dev/planning/modules/layer-engine/edge-cases.md @ 3 (loop per kind: ambiance forced true, voice forced false, tone ignores loop)
  - Tests (happy): tone builds `osc → envGain → layerGain → panner` with `osc.type === shape`,
    `osc.frequency.value === freqHz`, `envGain.gain.value === 0` before start; after `start(t0)`
    the envelope op sequence is `setValueAtTime(0,t0)`, `linearRampToValueAtTime(1,t0+attack)`,
    `linearRampToValueAtTime(0,t0+attack+release)` and `osc.stop` is scheduled at `t0+attack+release`.
    ambiance builds `bufferSource(loop=true) → layerGain → panner`; voice builds
    `bufferSource(loop=false) → layerGain → panner`. Edge: ambiance with `Layer.loop=false` still
    `loop=true`; voice with `Layer.loop=true` still `loop=false`; tone with `loop=true` builds the
    normal one-shot (loop ignored, no throw).

- [x] [test] Test degenerate ADSR and zero-length / missing-clip silence | file: src/engine/layer-engine.test.ts | model: T1Lite
  - Ref: .dev/planning/modules/layer-engine/edge-cases.md @ 6 (degenerate ADSR: 0/0, attack 0, release 0, large), @ 1 (missing buffer → silent + missing flag), @ 2 (zero-length buffer tolerated, not missing)
  - Ref: .dev/planning/modules/layer-engine/design.md @ 5 (silent node has full tail, no source, missing:true, never throws)
  - Ref: .dev/planning/modules/layer-engine/interfaces.md @ 3 (missing-clip row)
  - Tests (edge): ADSR `attackSec=0,releaseSec=0` → osc start and stop scheduled at the SAME instant,
    no NaN, no negative-duration ramp; `attackSec=0` → instant peak; `releaseSec=0` → immediate drop
    at t0+attackSec. (error/portability): `createLayerNode(ctx, ambianceLayer, undefined)` →
    `missing === true`, NO source node created, `output`/`gainParam`/`panParam` still present, does
    NOT throw; same for a voice layer. (edge): a zero-length `AudioBuffer` → `missing === false`, a
    real source IS created, plays silence without error; a `tone` layer with `buffer` passed → buffer
    ignored, `missing === false`.

- [x] [test] Test the start/stop/dispose lifecycle, ALREADY_STARTED, and missing-node no-ops | file: src/engine/layer-engine.test.ts | model: T1Lite
  - Ref: .dev/planning/modules/layer-engine/design.md @ 4 (state machine, seek = dispose+rebuild)
  - Ref: .dev/planning/modules/layer-engine/edge-cases.md @ 5 (start twice; stop before start; after dispose), @ 8 (dispose without/twice; stop in the past)
  - Ref: .dev/planning/modules/layer-engine/interfaces.md @ 1 (start/stop/dispose JSDoc), @ 3 (lifecycle rows)
  - Tests (happy): `start(t)` moves `idle → running` and starts the source; `stop()` moves
    `running → stopped` (defaults atCtx to `ctx.currentTime`); for tone, `stop` cancels envelope past
    atCtx. (error): second `start` throws `LayerNodeError('ALREADY_STARTED')`. (edge): `stop` before
    `start` is a no-op (state stays idle); second `stop` no-op; `dispose()` disconnects all owned
    nodes and is idempotent (second `dispose` returns immediately, no double-disconnect); `start`/`stop`
    after `dispose` are no-ops; on a missing-clip node `start` advances to running but is a structural
    no-op and `stop`/`dispose` behave normally; `stop` at a past ctx time passes through ("now").

- [x] [audit] Verify cohesion guardrails: existing suites byte-identical green and L0 purity intact | file: .dev/.task-state/layer-engine/cohesion-audit.md | model: T2
  - Ref: .dev/planning/phase2-audio-architecture.md @ §6 Test retargets / Open risks (automation.test.ts unchanged; audio-engine.test.ts no edits; transport-master-gain.test.ts unchanged; accidental transport coupling in an L0 module = risk)
  - Ref: .dev/planning/modules/layer-engine/dependencies.md @ Project dependencies (no clip-library/automation/mixer/transport import; renderer.test.ts asserts zero transport import)
  - Run `npm run test` (full suite, not just layer-engine) and confirm: `automation.test.ts`,
    `audio-engine.test.ts` (master flag default `'internal'`), `transport-master-gain.test.ts` are
    UNCHANGED in source and PASS; the Task 1 mock extension is additive only and broke none of them.
  - Confirm `src/engine/layer-engine.ts` imports `session-model` type-only and imports NO
    clip-library / automation / mixer / transport / DOM symbol, and references no rAF / MediaSession /
    createMediaStreamDestination (L0 / offline-reuse invariant).
  - Write findings (pass/fail per guardrail + the import-purity check) to .dev/.task-state/layer-engine/cohesion-audit.md.

## Behavioral Audit (runs after all tasks above are [x])

- [x] [audit] Module behavioral audit | file: .dev/.task-state/layer-engine/behavioral-audit.md | model: T1
  - Ref: C:/Projects/.dev-shared/behavioral-audit.md — Module Behavioral Audit checklist
  - Ref: .dev/planning/modules/layer-engine/interfaces.md — every public interface (createLayerNode, LayerNode, LayerNodeError) must be verified
  - Ref: .dev/planning/modules/layer-engine/design.md — verify intended behavior (per-kind chains, ADSR, lifecycle, missing-clip) matches implementation
  - Ref: .dev/planning/modules/layer-engine/edge-cases.md — verify all documented edge cases are handled (missing/zero-length buffer, loop-per-kind, degenerate ADSR, start-twice, dispose idempotency, OfflineAudioContext)
  - Ref: .dev/planning/phase2-audio-architecture.md @ §6 — verify the createLayerNode signature matches the contract spine VERBATIM and that consumers (transport/renderer connect by kind; layer-scheduler writes gainParam/panParam) can route and schedule uniformly across all kinds including silent nodes
  - For each public interface: trace input (ctx, layer, buffer?) → implementation → observable output
    (output node, params, state, missing flag). Confirm no silent valid-looking default masks a real
    failure: a missing clip surfaces `missing: true` (not a fake source), and INVALID_CONTEXT throws loud.
  - For each consumer: confirm `output` is always the StereoPannerNode, `gainParam`/`panParam` are
    always present/writable (so layer-scheduler is kind-agnostic), and `kind` is correct for routing.
  - Write findings to .dev/.task-state/layer-engine/behavioral-audit.md
  - PASS required before marking this module complete

## Completion Criteria
- [x] All tasks marked [x] — zero tasks left [ ] (Pending) or [!] (Needs-Attention)
- [x] Zero active stubs for this module (per-kind source stub from scaffold resolved by Tasks 3-4)
- [x] All module tests passing (`src/engine/layer-engine.test.ts`) — 45/45 pass (re-run 2026-06-16)
- [x] Full suite green: `npm run test` passes; `automation.test.ts`, `audio-engine.test.ts`,
      `transport-master-gain.test.ts` byte-identical and passing (cohesion guardrails) — per cohesion-audit.md (1186 tests)
- [x] Audit PASS for every task
- [x] last-step-summary.md written for every task with a concrete Observable Verification entry
- [x] Behavioral audit PASS (see above)
