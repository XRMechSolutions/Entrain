# Tasks: layer-scheduler
# Planning: .dev/planning/modules/layer-scheduler/
# Architecture: .dev/modules/layer-scheduler/architecture.md
# Standards: security, safety
# Stack: typescript

## Agent Briefing

`layer-scheduler` is the timeline driver for stacked layers — the `automation.scheduleAll` analogue
for `Preset.layers[]`. Given caller-built, caller-routed `LayerNode`s, it schedules each layer's
gain/pan lane onto the node's params via the shared `scheduleLane` primitive, starts each node's
source in range (with the seek intra-offset), and computes + MERGES the bed-duck envelope from
`voice`-kind cue layers and installs it via `mixer.scheduleDuck`. It is pure Web Audio against the
mixer's `BaseAudioContext` (no transport globals), so `renderer` reuses the identical call offline.
It depends down on `automation` (`scheduleLane`), `mixer`, `layer-engine`, and `session-model` types;
it is consumed by `transport` and `renderer`. It adds NO new AudioParam-writing path and NO npm deps —
its only original code is pure arithmetic (relative→absolute time shift + duck-span merge).

## References

- .dev/planning/modules/layer-scheduler/design.md
- .dev/planning/modules/layer-scheduler/interfaces.md
- .dev/planning/modules/layer-scheduler/edge-cases.md
- .dev/planning/modules/layer-scheduler/dependencies.md
- .dev/planning/phase2-audio-architecture.md  (§1 topology, §3 scheduleLane, §4 ducking, §5 offline, §6 contract spine — NORMATIVE)

## Dependencies

These upstream contracts MUST be complete and green before this module begins (arch §6 build order:
session-model schema → mixer + layer-engine + scheduleLane extraction → layer-scheduler + duck):

- `session-model` v4 schema: `Layer`, `LayerKind = 'tone'|'ambiance'|'voice'`, `LanePoint`, `ToneSpec`,
  `Preset.layers` (arch §0). `session-model.test.ts` green.
- `mixer.ts`: `createMixer`, `Mixer`, `DuckSpan`, `scheduleDuck`, `cancelDuck` (arch §6).
- `layer-engine.ts`: `createLayerNode`, `LayerNode` (`gainParam`/`panParam`/`output`/`start`/`stop`/`dispose`) (arch §6).
- `automation.ts`: `scheduleLane` extracted + exported, with module-level `VOLUME_MICRORAMP_SEC` and
  `RETARGET_LOOKAHEAD_SEC` (arch §3). `automation.test.ts` green (byte-identical extraction guardrail).

This module adds ZERO runtime npm dependencies (dependencies.md). There is no package.json install for
it — the first task verifies the upstream contracts/imports compile, which is the genuine prerequisite.

## Tasks

- [x] [prereq] Verify upstream contracts/imports compile and guardrail suites are green before any layer-scheduler code | file: src/engine/layer-scheduler.ts | model: T3
  - Ref: .dev/planning/phase2-audio-architecture.md @ §6 Cross-Module Contract Spine + Layer/dependency ordering (build order)
  - Ref: .dev/planning/modules/layer-scheduler/dependencies.md @ Internal (this codebase) dependencies + Runtime libraries (NONE)
  - Ref: .dev/planning/modules/layer-scheduler/interfaces.md @ import block (the four upstream symbols)
  - Accepts: existing repo state (session-model v4, mixer.ts, layer-engine.ts, automation.ts with exported scheduleLane)
  - Creates: a minimal `src/engine/layer-scheduler.ts` that imports `scheduleLane`, `VOLUME_MICRORAMP_SEC`, `RETARGET_LOOKAHEAD_SEC` from `./automation`; types `Mixer`/`DuckSpan` from `./mixer`; `LayerNode` from `./layer-engine`; `Layer`/`LayerKind`/`LanePoint`/`ToneSpec` from `./session-model`. No logic yet.
  - Behavior: confirm every imported symbol resolves and is exported by its module; NO new npm dependency is added (dependencies.md: platform/Web APIs only).
  - Handles: a missing/unexported upstream symbol → STOP and flag the blocking upstream module; do not stub the missing contract here.
  - Tests: `npx tsc --noEmit` passes on the import-only file; run `automation.test.ts`, `audio-engine.test.ts`, `transport-master-gain.test.ts` and record them GREEN (the byte-identical guardrail baseline — captured BEFORE any change so the post-change run can prove no drift).

- [x] [impl] Implement the relative→absolute time-shift helpers (absPoints + laneValueAt) | file: src/engine/layer-scheduler.ts | model: T1
  - Ref: .dev/planning/modules/layer-scheduler/design.md @ §3 Time composition (THE core rule) + §3.1 two seek positions
  - Ref: .dev/planning/modules/layer-scheduler/interfaces.md @ §3 (the ctxTime formula in the scheduleLayers doc-comment)
  - Ref: .dev/planning/phase2-audio-architecture.md @ §3 (scheduleLane / ScheduleLaneOpts: startTime, startOffsetSec, floorTime, anchorValue, valueAt)
  - Ref: .dev/planning/modules/layer-scheduler/edge-cases.md @ §4 (empty/absent/single-point lanes) + §5 (time-origin boundaries)
  - Accepts: a `LanePoint[]` (a layer's `gain` or `spatial` lane, possibly absent/empty/single) and the layer's placement `L.t`; a query session-second `t`.
  - Creates: `absPoints(points, layerT)` → points with every `t` shifted by `+layerT` into ABSOLUTE session seconds (value/transition unchanged); `laneValueAt(absPts, t)` → pure carry-forward + transition evaluator over the shifted points (constant before the first point, held after the last, interpolated between by each point's `ParamTransition` — the layer analogue of `automation.baseValueAt`, single value, no modulator).
  - Behavior: absolute-session timebase ONLY — never compute `startOffsetSec - L.t` inline (design §3 "why shift the points"); one timebase shared with the binaural voice so a single `startOffsetSec` drives every lane.
  - Handles: empty/absent lane → constant (gain unity, pan center; edge-cases §4a); single-point lane → constant at that value (§4b); query before first point → first point's value (carry-forward); after last point → last point's value (hold).
  - Tests: HAPPY — absPoints shifts a 2-point lane by L.t; laneValueAt interpolates mid-segment, holds after last, carries before first. EDGE — empty lane returns unity/center constant; single-point lane is constant everywhere; query exactly on a point returns that point's value (§1b no double-event). PURE — no `AudioContext` needed (design §8 — directly unit-testable arithmetic).

- [x] [impl] Implement scheduleLayers core: per-layer gain/pan lane scheduling via scheduleLane | file: src/engine/layer-scheduler.ts | model: T1
  - Ref: .dev/planning/modules/layer-scheduler/design.md @ §3 (the bound ScheduleLaneOpts) + §2 (index-parallel nodes/layers, id cross-check)
  - Ref: .dev/planning/modules/layer-scheduler/interfaces.md @ §1 (VERBATIM §6 signature) + §3 (scheduleLayers doc-comment: gain→stepRampSec VOLUME_MICRORAMP_SEC, pan→stepRampSec 0)
  - Ref: .dev/planning/phase2-audio-architecture.md @ §3 (scheduleLane callers: layer lanes) + §6 (layer-scheduler row — restate, do not alter)
  - Ref: .dev/planning/modules/layer-scheduler/edge-cases.md @ §4 (lanes) + §7a/§7b (length mismatch, unmatched node — pair by id, skip-and-continue) + §5d (non-finite time bubbles, not caught)
  - Accepts: `mixer`, `readonly LayerNode[]`, `readonly Layer[]`, `{ t0, startOffsetSec }`.
  - Creates: the scheduleLayers body that pairs `nodes[i]`↔`layers[i]` (cross-checking `node.id === layer.id`), and for each matched pair calls `scheduleLane(node.gainParam, absPoints(L.gain, L.t), {...})` and `scheduleLane(node.panParam, absPoints(L.spatial, L.t), {...})` with `startTime: t0`, `startOffsetSec`, `floorTime: t0`, `anchorValue: laneValueAt(abs, startOffsetSec)`, `valueAt: t => laneValueAt(abs, t)`, gain `policy.stepRampSec: VOLUME_MICRORAMP_SEC` / pan `policy.stepRampSec: 0`, `expFallback: true`.
  - Behavior: NEVER write an AudioParam directly — every gain/pan edge goes through `scheduleLane` (D-008 no-click); `floorTime: t0` guarantees nothing schedules before the play instant; `anchorValue`/`valueAt` are JS-tracked, NEVER `param.value` (D-019 / Firefox-stale-value).
  - Handles: `nodes.length !== layers.length` → pair by `node.id === layer.id`, schedule matched only, skip unmatched, never throw mid-schedule (§7a); unmatched node left inert (§7b); empty `layers` → no-op schedule (§7c); non-finite `t0`/`startOffsetSec` → let `scheduleLane`'s `AutomationError('INVALID_TIME')` bubble, do NOT catch/re-wrap (interfaces §4, §5d); propagated `AudioEngineError` not caught (§7d).
  - Behavior (cohesion guardrail): the gain lane MUST pass `VOLUME_MICRORAMP_SEC` so a stepped layer gain micro-ramps byte-for-byte like the binaural volume lane; the pan lane MUST pass `stepRampSec: 0` (bare setValueAtTime, matching the freq/spatial fork). No new param-writer.
  - Tests: HAPPY — a layer at L.t=60 with a 2-point gain fade schedules onto gainParam at ctxTime = t0 + (60 + p.t - startOffsetSec); pan onto panParam. ERROR — non-finite t0 propagates AutomationError (not re-wrapped); nodes/layers length mismatch pairs by id and skips unmatched without throwing. EDGE — empty layers[] returns a no-op handle; layer with absent gain/spatial writes the constant once (anchored).

- [x] [impl] Implement source start placement + range/intra-offset (in-range, seek mid-layer, out-of-range) | file: src/engine/layer-scheduler.ts | model: T1
  - Ref: .dev/planning/modules/layer-scheduler/design.md @ §4 (node.start placement, nodeStartCtx, layerEnd, in/out-of-range) + §3.1 (seek mid-layer intra-offset, intoLayer)
  - Ref: .dev/planning/modules/layer-scheduler/interfaces.md @ §3 (node.start(t0 + layer.t - startOffsetSec) when in range)
  - Ref: .dev/planning/phase2-audio-architecture.md @ §2.2 (dispose+rebuild one-shots on seek) + §6 (layer-engine LayerNode.start contract)
  - Ref: .dev/planning/modules/layer-scheduler/edge-cases.md @ §1 (seek mid-clip 1a–1d) + §2 (looping ambiance 2a–2d) + §5c (L.t == durationSec tail)
  - Accepts: each matched `LayerNode` + its `Layer`, plus `{ t0, startOffsetSec }`.
  - Creates: the per-node start logic: compute `nodeStartCtx = t0 + (L.t - startOffsetSec)`; in-range at/after offset (`L.t >= startOffsetSec`) → `node.start(nodeStartCtx)` at head; seek mid-layer (`L.t < startOffsetSec < L.t + layerEnd`) → `node.start(t0)` with the engine advancing the buffer by `intoLayer = startOffsetSec - L.t`; out-of-range (`startOffsetSec >= L.t + layerEnd`) → do NOT start, do NOT schedule lanes (node inert).
  - Behavior: `layerEnd` = tone one-shot `attackSec + releaseSec`; non-looping clip `durationSec`; LOOPING clip (`loop: true`) → UNBOUNDED (always in range for any `startOffsetSec >= L.t`; loop phase via `intoLayer mod clipDuration`, performed by the engine). This module supplies the ctx time / offset only; `layer-engine.start(atCtx)` performs the buffer-offset and the loop modulo (design §4 ownership line). `node.stop` is NOT called on normal end (one-shots self-stop; loops stop on dispose).
  - Handles: intra-offset >= one-shot length (`intoLayer >= layerEnd`) → out-of-range, inert (§1c, a finished bell is not re-rung); sub-quantum intra-offset (§1d); looping seek many loop-lengths in → still in range, phase-correct (§2a); silent no-op node from a missing clip → start still called, harmless (§2d); L.t == durationSec → schedulable, tail covered by master fade (§5c).
  - Tests: HAPPY — layer at L.t=60, startOffsetSec=0 → node.start(t0+60). EDGE (seek mid-clip) — layer at L.t=500, startOffsetSec=600 → node.start(t0) with intoLayer=100 (in-range mid-layer; lanes anchored at session 600). EDGE (looping) — loop:true ambiance, startOffsetSec - L.t > clipDuration → still started at t0, phase via modulo. ERROR/OUT-OF-RANGE — one-shot fully ended before offset (startOffsetSec >= L.t + layerEnd) → node NOT started, no lanes scheduled.

- [x] [impl] Implement duck-span computation + overlap MERGE + single scheduleDuck per region | file: src/engine/layer-scheduler.ts | model: T1 [data]
  - Ref: .dev/planning/modules/layer-scheduler/design.md @ §5 (raw spans §5.1, MERGE §5.2, why-here §5.3) + §8 (merge is the original computation)
  - Ref: .dev/planning/modules/layer-scheduler/interfaces.md @ §2 (DuckIntent) + §3 (scheduleDuck once per merged region; MIN toGain)
  - Ref: .dev/planning/phase2-audio-architecture.md @ §4 (Ducking: bed-only, voice=cue, D-019 single-writer, merge MIN toGain, monotonic, recover only after last cue)
  - Ref: .dev/planning/modules/layer-scheduler/edge-cases.md @ §3 (duck overlap/coalesce 3a–3h: abut, nested, chain, disjoint, no-intent, non-voice intent, seek-into-dip)
  - Accepts: the `readonly Layer[]` + `{ t0, startOffsetSec }`; reads `DuckIntent {toGain, attackSec, releaseSec}` off `voice`-kind layers only.
  - Creates: raw-span computation (`attackStart = L.t`, `releaseEnd = L.t + cueDurationSession + releaseSec`, carrying `toGain`/attack/release), then the MERGE: sort ascending by `attackStart`; forward-walk coalescing while `current.releaseEnd >= next.attackStart` with `releaseEnd = max(...)` and `toGain = min(...)` (DEEPEST DUCK WINS); each region emits ONE monotonic envelope (ramp 1→regionToGain over first cue's attackSec, HOLD across region, ramp regionToGain→1 over last cue's releaseSec); then `mixer.scheduleDuck(regionSpans, t0, startOffsetSec)` called ONCE with all merged regions.
  - Behavior (D-019 single-writer): the MERGE happens HERE so `mixer.scheduleDuck` only ever receives non-overlapping, monotonic regions — the sole-writer guarantee is structural. This module NEVER writes `duckParam`/`duckGain.gain` itself; the no-click anchoring/linear ramps live in the mixer (arch §4). Span math is in SESSION seconds; the ctx-time conversion + `startOffsetSec` anchoring (seek into a dip) is `scheduleDuck`'s job (§3g) — do NOT pre-trim spans here.
  - Handles: overlap (§3a), exact abut `>=` treats as overlap (§3b), fully nested (§3c, min toGain), 3+ transitive chain via running-region re-test (§3d), disjoint → separate regions, recover between (§3e), voice with no DuckIntent → no span (§3f), `tone`/`ambiance` carrying a DuckIntent → IGNORED (only voice-kind drive the bed duck; §3h), seek-into-dip → mixer anchors mid-dip (§3g).
  - Tests: HAPPY — two voice cues, disjoint → two DuckSpans in one scheduleDuck call. EDGE (MERGE) — two overlapping cues (prev.releaseEnd >= next.attackStart) → ONE region, releaseEnd=max, toGain=MIN (deepest wins), recovers to 1.0 only after the last; exact-abut treated as overlap; 3-cue A∪B∪C transitive chain → one region. ERROR/IGNORE — voice cue with no DuckIntent → no span; tone/ambiance carrying a DuckIntent → no span (ignored). Assert the coalescing logic directly (no AudioContext — design §8).

- [x] [impl] Implement the LayerSchedule handle: retarget / cancel / dispose | file: src/engine/layer-scheduler.ts | model: T1
  - Ref: .dev/planning/modules/layer-scheduler/design.md @ §6 (one-shot rebuild on seek; retarget is the non-seek path) + §7 (SessionScheduler mirror; cancel == automation stop semantics)
  - Ref: .dev/planning/modules/layer-scheduler/interfaces.md @ §3 (retarget/cancel/dispose doc-comments; atCtx default = mixer-ctx currentTime + RETARGET_LOOKAHEAD_SEC)
  - Ref: .dev/planning/phase2-audio-architecture.md @ §2.2 (transport startFresh/seek/reapply lifecycle) + §6 (LayerSchedule = { retarget; cancel; dispose })
  - Ref: .dev/planning/modules/layer-scheduler/edge-cases.md @ §6 (retarget/cancel/dispose boundaries 6a–6e) + §7c (empty layers → all no-op)
  - Ref: .dev/planning/modules/layer-scheduler/dependencies.md @ Web APIs (BaseAudioContext.currentTime read via the mixer's context, for the retarget default atCtx only — never to anchor a value)
  - Accepts: the closure state from scheduleLayers (per-lane bookkeeping, merged-span cache, the mixer + node references).
  - Creates: `retarget(layers, atCtx?)` — re-ramp every gain/pan lane to the edited values from `atCtx` (cancel-and-hold at atCtx then reschedule, the automation retarget pattern) and re-merge + re-install the duck from `atCtx`; pair by `id`; sources keep running (NO start/stop); `atCtx` defaults to mixer-ctx `currentTime + RETARGET_LOOKAHEAD_SEC`. `cancel()` — cancel each lane's future gain/pan events at now (params HOLD) and `mixer.cancelDuck(now)` (bed recovers to 1.0); does NOT stop/dispose nodes. `dispose()` — release lane/merge bookkeeping; idempotent; after dispose, retarget/cancel are no-ops.
  - Behavior: mirrors `automation`'s SessionSchedule so transport injects/tears down with the SAME lifecycle code; `cancel` here == automation `stop` semantics (cancel future events, hold values, do NOT stop sources — one-shots can't restart, so the caller disposes nodes + re-invokes scheduleLayers on seek; design §6). Read `param.value` is FORBIDDEN for anchoring — currentTime is read only for the atCtx default.
  - Handles: retarget on live-edit, sources running (§6a); retarget where source identity changed → caller rebuilds + passes fresh nodes, handle re-pairs by id (§6b); cancel then source naturally ends → no double-stop (§6c); dispose then later retarget/cancel → no-ops, idempotent (§6d); cancel/dispose with NO duck installed → cancelDuck still called, tolerated no-op (§6e); empty layers → all three methods no-op (§7c).
  - Tests: HAPPY — retarget on an edited preset re-ramps lanes from atCtx and re-installs the merged duck; sources are not started/stopped. EDGE — cancel holds lane params and calls cancelDuck(now); cancel with no installed duck is a tolerated no-op. ERROR/IDEMPOTENT — dispose() then retarget()/cancel() are no-ops; double dispose is safe.

- [x] [test] Author layer-scheduler.test.ts (time composition, seek mid-clip, duck overlap merge) and confirm guardrail suites still green | file: src/engine/layer-scheduler.test.ts | model: T1
  - Ref: .dev/planning/modules/layer-scheduler/design.md @ §3 (time composition) + §4 (range/intra-offset) + §5 (duck merge) + §8 (determinism — testable without an AudioContext)
  - Ref: .dev/planning/modules/layer-scheduler/edge-cases.md @ §1 (seek mid-clip) + §3 (duck coalesce) + §4 (empty lanes) + §7 (malformed inputs)
  - Ref: .dev/planning/phase2-audio-architecture.md @ §4 (assert merge in BOTH layer-scheduler.test.ts and mixer.test.ts) + §3 (scheduleLane op-sequence reuse)
  - Ref: .dev/testing-standards.md
  - Accepts: the implemented `scheduleLayers` + helpers; a fake/mock `Mixer` recording `scheduleDuck`/`cancelDuck` calls and fake `LayerNode`s recording `start`/lane scheduleLane calls (no real AudioContext — design §8).
  - Creates: `src/engine/layer-scheduler.test.ts` covering: (1) TIME COMPOSITION — a layer at L.t=60 lands lane points at ctxTime = t0 + (60 + p.t - startOffsetSec); relative fade stays relative wherever placed. (2) SEEK MID-CLIP — startOffsetSec inside a layer anchors the lane at laneValueAt(abs, startOffsetSec) and starts the node at t0 with intoLayer = startOffsetSec - L.t; seek before the layer starts it later at t0 + L.t - startOffsetSec; out-of-range one-shot not started. (3) DUCK OVERLAP MERGE — overlapping/abutting/nested/chained cues coalesce to one region (releaseEnd=max, toGain=MIN, recover only after the last); disjoint → separate regions; no-intent and non-voice intent → no span; exactly ONE scheduleDuck call per scheduleLayers.
  - Behavior (cohesion guardrail): this NEW test file must run alongside the EXISTING guardrail suites without altering them. Run `automation.test.ts` (scheduleLane extraction op-sequence), `audio-engine.test.ts` (master flag default 'internal'), and `transport-master-gain.test.ts` (unchanged) — all must be byte-identical GREEN both BEFORE this module's work began (captured in the prereq task) AND now. ANY diff in those three is a regression to fix, not to absorb.
  - Handles: assert skip-and-continue on nodes/layers length mismatch (§7a); empty layers → no-op handle, zero scheduleDuck calls (§7c); non-finite time propagates AutomationError (§5d).
  - Tests: this task IS the test authoring — happy (time composition), error (non-finite time, length mismatch), edge (seek mid-clip, looping phase, duck merge variants). Coverage of design §3/§4/§5 + edge-cases §1/§3/§4/§7. Full suite (`npm test` / vitest) must pass.

## Behavioral Audit (runs after all tasks above are [x])

- [x] [audit] Module behavioral audit | file: .dev/.task-state/layer-scheduler/behavioral-audit.md | model: T1
  - Ref: C:/Projects/.dev-shared/behavioral-audit.md — Module Behavioral Audit checklist
  - Ref: .dev/planning/modules/layer-scheduler/interfaces.md — every public interface (scheduleLayers + LayerSchedule.retarget/cancel/dispose + DuckIntent/ScheduleLayersOpts) must be verified
  - Ref: .dev/planning/modules/layer-scheduler/design.md — verify intended behavior: time composition (§3), source start/range (§4), duck merge (§5), lifecycle mirror (§6/§7), no-click reuse (§8)
  - Ref: .dev/planning/modules/layer-scheduler/edge-cases.md — verify all documented edge cases (§1 seek, §2 looping, §3 duck coalesce, §4 empty lanes, §5 time boundaries, §6 lifecycle, §7 malformed inputs)
  - Ref: .dev/planning/phase2-audio-architecture.md @ §3/§4/§6 — verify the VERBATIM §6 contract and D-008/D-019/D-026 are honored structurally
  - For each public interface: trace input → implementation → observable output (lane scheduleLane calls, node.start placement, scheduleDuck regions)
  - Verify consumers: transport (startFresh/seek/reapply) and renderer read the LayerSchedule shape and pass {t0, startOffsetSec} correctly; this module imports nothing from transport/renderer (transport-free)
  - Verify D-019 single-writer is STRUCTURAL: scheduleDuck only ever receives merged, non-overlapping regions; this module never writes duckParam/an AudioParam directly
  - Verify D-008 no-click: every gain/pan edge goes through scheduleLane (gain VOLUME_MICRORAMP_SEC, pan 0); no new param-writer added
  - Verify the three guardrail suites (automation.test.ts, audio-engine.test.ts, transport-master-gain.test.ts) are byte-identical GREEN
  - Write findings to .dev/.task-state/layer-scheduler/behavioral-audit.md
  - PASS required before marking this module complete

## Completion Criteria
- [x] All tasks marked [x] — zero tasks left [ ] (Pending) or [!] (Needs-Attention)
- [x] Zero active stubs for this module — stub-registry.md lists the duck-driver stub under Resolved Stubs (2026-06-16)
- [x] All module tests passing (layer-scheduler.test.ts green) — 36 tests, re-run 2026-06-16
- [x] Guardrail suites byte-identical GREEN before AND after: automation.test.ts (65), audio-engine.test.ts (63), transport-master-gain.test.ts (8) — re-run 2026-06-16
- [x] Audit PASS for every task — all impl/test tasks are [x] (per-task pipeline audit-pass state); behavioral audit re-verified the code is correct
- [ ] last-step-summary.md written for every task with a concrete Observable Verification entry — NOT fully satisfied: the eight summaries are duplicated copies of the prereq summary (see behavioral-audit.md NOTE N2). Bookkeeping gap only; code + tests independently demonstrate each task's outcome
- [x] Behavioral audit PASS (see above) — .dev/.task-state/layer-scheduler/behavioral-audit.md, verdict PASS
