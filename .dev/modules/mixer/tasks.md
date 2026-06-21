# Tasks: mixer
# Planning: .dev/planning/modules/mixer/
# Architecture: .dev/modules/mixer/architecture.md
# Standards: safety
# Stack: typescript

## Agent Briefing
`mixer` (`src/engine/mixer.ts`, NEW, Layer-0) owns all summation for a session: a fixed
three-input → one-master Web Audio graph plus the single bed-duck envelope. It depends only on
`automation`'s `scheduleLane` (the shared no-click param writer) and the session-model v4 schema
(via the layer feature it serves); it imports no other project module. It is consumed by
`transport`, `renderer`, and `layer-scheduler`. It must stay pure Web Audio against any
`BaseAudioContext` so `renderer` reuses the byte-identical graph offline against an
`OfflineAudioContext`. The routing/scheduling/duck/master contracts are NORMATIVE in
phase2-audio-architecture.md (§1, §3, §4, §6) — implement to those; never re-derive or contradict.

## References
- .dev/planning/modules/mixer/design.md
- .dev/planning/modules/mixer/interfaces.md
- .dev/planning/modules/mixer/edge-cases.md
- .dev/planning/modules/mixer/dependencies.md
- .dev/planning/phase2-audio-architecture.md (§1 topology, §3 scheduleLane, §4 ducking, §6 spine)

## Dependencies
Must be complete and green before this module starts (arch §6 build order):
1. **session-model v3→v4 schema bump** (`Layer`, `LayerKind`, `Preset.layers`) — gating blocker for
   the whole layer feature; `session-model.test.ts` is the guardrail.
2. **`scheduleLane` extraction** from `automation.ts` — `mixer.scheduleDuck` imports `scheduleLane`
   plus the `LanePoint` / `ScheduleLaneOpts` types. `automation.test.ts` is the byte-identical
   op-sequence guardrail; it must be green before and after the extraction.

Existing test suites that are byte-identical guardrails (must run green BEFORE and AFTER this
module's work — no edits to them by this module): `automation.test.ts`,
`audio-engine.test.ts` (the `master` flag default stays `'internal'`/internal),
`transport-master-gain.test.ts`.

## Tasks

- [x] [prereq] Confirm `automation` exports `scheduleLane` + `LanePoint`/`ScheduleLaneOpts` and add the mixer test wiring to the vitest config | file: src/engine/mixer.test.ts | model: T3
  - Ref: .dev/planning/modules/mixer/dependencies.md @ Project dependencies (the one import)
  - Ref: .dev/planning/phase2-audio-architecture.md @ §3 The Shared scheduleLane Primitive
  - Ref: .dev/planning/phase2-audio-architecture.md @ §6 Layer / dependency ordering (build order)
  - Verify: `import { scheduleLane } from './automation'` and `import type { LanePoint, ScheduleLaneOpts } from './automation'` resolve (the extraction prerequisite has landed). No new npm dependency is added (dependencies.md: net new third-party footprint = 0).
  - Creates: an empty `src/engine/mixer.test.ts` file that is picked up by the existing `vitest run` glob (no vitest config edit needed if the glob already covers `src/**/*.test.ts`); confirm the test runner sees it.
  - Behavior: this is a wiring/prerequisite gate only — no mixer logic. If `scheduleLane` is not yet exported, STOP and mark `reason: blocked:automation-scheduleLane-extraction`.
  - Tests: `npm run test` discovers `mixer.test.ts` (even if it only contains a trivial passing placeholder at this point); the three guardrail suites (`automation.test.ts`, `audio-engine.test.ts`, `transport-master-gain.test.ts`) run GREEN as the pre-work baseline.

- [x] [impl] Build the fixed three-input → one-master node graph and expose the `Mixer` surface in `createMixer` | file: src/engine/mixer.ts | model: T1
  - Ref: .dev/planning/modules/mixer/design.md @ §2 The node graph (exact construction)
  - Ref: .dev/planning/modules/mixer/interfaces.md @ §1 The factory and the Mixer surface (verbatim from arch §6)
  - Ref: .dev/planning/phase2-audio-architecture.md @ §1 The Unified Bus Topology (invariants — NORMATIVE)
  - Ref: .dev/planning/modules/mixer/edge-cases.md @ §4 Master single-input invariant
  - Ref: .dev/planning/modules/mixer/edge-cases.md @ §7 Context-type edge cases (master written once at construction)
  - Accepts: `ctx: BaseAudioContext`, `opts?: { masterStart?: number }`.
  - Creates: `createMixer` returning `Mixer` with four `GainNode`s (`bedInput=1.0`, `duckGain=1.0`, `cueInput=1.0`, `liftInput=1.0`, `busSum=1.0`, `master=opts.masterStart ?? 0`) and exposing `bedInput`/`cueInput`/`liftInput` (`AudioNode`), `master` (`GainNode`), `masterParam` (= `master.gain`), `duckParam` (= `duckGain.gain`). Define and export the `Mixer` and `DuckSpan` interfaces verbatim from interfaces.md §1.
  - Behavior: fixed wiring once at construction — `bedInput→duckGain→busSum`, `cueInput→busSum`, `liftInput→busSum`, `busSum→master`. `master` is NOT connected to any output target at construction (consumer calls `connect`). `master.gain.value` is written exactly once here (= `masterStart ?? 0`); the mixer never writes `masterParam` again (the controller is its sole writer — arch §2.3). Use `ctx.createGain()` only (identical on `AudioContext`/`OfflineAudioContext`). No transport globals (no rAF, MediaSession, Wake Lock, setTimeout, createMediaStreamDestination).
  - Handles: non-finite `opts.masterStart` is written as-is (caller's bug; the controller overwrites on first ramp — interfaces.md §3). `createMixer` is total — it originates no error type.
  - Tests: topology assertions — `master` has exactly ONE upstream edge (`busSum`); bed reaches `busSum` only via `duckGain`; cue and lift join `busSum` downstream of `duckGain` (never duck themselves); `master.gain.value === 0` by default and `=== opts.masterStart` when given; `duckParam` initial value is `1.0` (no duck).
  - Stubs expected: `scheduleDuck`/`cancelDuck`/`connect`/`disconnect`/`dispose` may be registered as `TODO(stub)` here, resolved by the next three tasks. Register them in .dev/.task-state/stub-registry.md.

- [x] [impl][data] Implement `scheduleDuck`/`cancelDuck` reusing `scheduleLane` with the MIN-toGain interval merge and JS-tracked anchor | file: src/engine/mixer.ts | model: T1
  - Ref: .dev/planning/modules/mixer/design.md @ §3 Reusing the shared scheduleLane primitive
  - Ref: .dev/planning/modules/mixer/design.md @ §4 Ducking (4.1–4.6: trackedDuck anchor, scheduleDuck steps, seek-into-duck, cancelDuck, overlap merge)
  - Ref: .dev/planning/modules/mixer/interfaces.md @ §2 Reused automation contract (the scheduleLane binding block)
  - Ref: .dev/planning/phase2-audio-architecture.md @ §4 Ducking (NORMATIVE — bed-only, MIN toGain, single-writer D-019)
  - Ref: .dev/planning/phase2-audio-architecture.md @ §3 (anchorValue + valueAt both load-bearing)
  - Ref: .dev/planning/modules/mixer/edge-cases.md @ §1 Duck with no bed / empty spans
  - Ref: .dev/planning/modules/mixer/edge-cases.md @ §2 Malformed / degenerate DuckSpan input
  - Ref: .dev/planning/modules/mixer/edge-cases.md @ §3 Overlapping cues and seek-into-duck
  - Accepts: `scheduleDuck(spans: readonly DuckSpan[], t0: number, startOffsetSec: number)`; `cancelDuck(atCtxTime: number)`.
  - Creates: the sole writer of `duckParam`. `scheduleDuck`: (1) defensively re-apply the §4.6 within-call MIN-`toGain` interval merge (sort by `startCtx`; coalesce when `prev.releaseEnd >= next.attackStart`, deepest duck wins, union interval, recover to 1.0 only after the last overlapping cue); (2) translate each merged region into `LanePoint`s on `[0,1]` (attack from current `trackedDuck`/1.0 down to `toGain`, hold, release back to 1.0), every point `transition:'linear'`; (3) call `scheduleLane(duckParam, points, opts)` once with `anchorValue: trackedDuck` (NEVER `duckParam.value`), `valueAt` over the duck's own points, `policy:{ stepRampSec: 0, expFallback: true }`, and `startTime`/`startOffsetSec`/`floorTime` mapped exactly as the binaural/layer callers map `(t0, startOffsetSec)`; (4) update `trackedDuck` to the settled value (1.0 past final release, or the mid-envelope value on a seek). `cancelDuck`: `duckParam.cancelScheduledValues(atCtxTime)` (or `cancelAndHoldAtTime` when feature-detected), then a short no-click `linearRampToValueAtTime(1.0, atCtxTime + RELEASE)` anchored from `trackedDuck`, then `trackedDuck = 1.0`.
  - Handles: empty `spans` → no-op, `trackedDuck` stays 1.0 (edge-cases §1); `toGain` clamped to `[0,1]` (edge-cases §2); non-finite `toGain`/`attackSec`/`releaseSec` → span skipped (edge-cases §2); `startCtx >= endCtx` → zero-body region (attack+release still emit), inverted `endCtx < startCtx` → skipped; `attackSec`/`releaseSec` of 0 → step at the edge via `stepRampSec:0`. Linear ONLY — never `exp`, never `setValueCurveAtTime` (Firefox bug 1752775). Calls after `dispose()` are guarded no-ops.
  - Behavior: the mixer adds NO mixer-private ramp writer and defines NO new automation types — it reuses `scheduleLane`'s `LanePoint`/`ScheduleLaneOpts` verbatim. Single-writer `duckParam` (D-019): the within-call merge guarantees the param never receives two competing ramps. No-click ramps (D-008): one shared `scheduleLane` op sequence, not a duplicate.
  - Tests: overlapping spans coalesce to ONE envelope at MIN `toGain` recovering to 1.0 only after the last cue (assert identically in `mixer.test.ts` and the layer-scheduler suite per arch §4); adjacent non-overlapping spans → two separate dips with full recovery between; seek-into-duck (re-`scheduleDuck` with new `startOffsetSec`) resumes from the mid-envelope value via `valueAt`, not from 1.0 and not from a stale `duckParam.value`; empty spans → no-op; `toGain` out of `[0,1]` clamped; non-finite span fields skipped; `cancelDuck` mid-duck rises smoothly to 1.0 and resets `trackedDuck`.
  - Resolves stubs: the `scheduleDuck`/`cancelDuck` stubs from the graph task.

- [x] [impl][data] Implement `connect`/`disconnect` (move only the master output edge) and idempotent `dispose` | file: src/engine/mixer.ts | model: T1
  - Ref: .dev/planning/modules/mixer/design.md @ §5 connect / disconnect — move only master
  - Ref: .dev/planning/modules/mixer/design.md @ §6 dispose — idempotent teardown
  - Ref: .dev/planning/modules/mixer/design.md @ §7 Offline reuse and the L0 discipline
  - Ref: .dev/planning/phase2-audio-architecture.md @ §1 (single-input master — connect/disconnect move ONLY master)
  - Ref: .dev/planning/phase2-audio-architecture.md @ §2.2 (routeOutput moves mixer.master between ctx.destination and msDest)
  - Ref: .dev/planning/modules/mixer/edge-cases.md @ §5 Connect / disconnect degeneracies
  - Ref: .dev/planning/modules/mixer/edge-cases.md @ §6 Dispose idempotency
  - Accepts: `connect(target: AudioNode)`, `disconnect()`, `dispose()`.
  - Creates: `connect` moves exactly one edge — `master`'s output; tracks the current target; re-calling with a new target disconnects the old edge then connects the new (retarget moves the ONE edge, never the internal graph). `disconnect` drops `master`'s output edge only when one exists (tracked target), leaving the internal graph intact for a later re-`connect`. `dispose` is idempotent (a `disposed` flag; second+ calls return immediately): cancel scheduled values on `duckParam` (no recover ramp on teardown), disconnect `master`'s output edge, then disconnect each internal node (`bedInput`, `duckGain`, `cueInput`, `liftInput`, `busSum`, `master`) each wrapped so an already-disconnected node never throws, drop references, set `disposed = true`.
  - Handles: `disconnect()` with no current edge → no-op (track own target; never call platform `disconnect` on a no-edge — avoids `InvalidAccessError`); `connect` twice same target → disconnect-then-reconnect (no double edge); `connect`/`disconnect`/`scheduleDuck`/`cancelDuck` after `dispose()` → guarded no-ops, never throw. `dispose` does NOT stop sources (owned by voice/layers/lift owners) and does NOT close the context (owned by transport/renderer).
  - Behavior: pure Web Audio, same code path on `OfflineAudioContext` (no platform branch) — the renderer disposes the mixer exactly as transport does after `startRendering` resolves.
  - Tests: `connect(target)` sets exactly one master output edge; re-`connect` to a different target moves the single edge (old dropped, new added) and leaves the internal graph and single-input-master invariant untouched; `disconnect()` with no edge is a no-op (no throw); `dispose()` called twice is fully idempotent; `dispose()` while a duck ramp is mid-flight cancels duck values and disconnects every node without throwing; post-`dispose` method calls are guarded no-ops.
  - Resolves stubs: the `connect`/`disconnect`/`dispose` stubs from the graph task.

- [x] [test] Author the full `mixer.test.ts` suite — topology, duck merge, single-input master, OfflineAudioContext parity | file: src/engine/mixer.test.ts | model: T1
  - Ref: .dev/planning/modules/mixer/interfaces.md @ §1 + §4 Worked example (the transport/renderer composition)
  - Ref: .dev/planning/modules/mixer/edge-cases.md @ §1–§7 (every documented edge case gets a case)
  - Ref: .dev/planning/modules/mixer/design.md @ §2, §4, §5, §6, §7
  - Ref: .dev/planning/phase2-audio-architecture.md @ §4 (overlap merge asserted in mixer + layer-scheduler), §5 (offline reuse)
  - Creates: a vitest suite covering — (a) TOPOLOGY: four gains, fixed wiring, `master` single upstream, default `master.gain===0` and `opts.masterStart` override, `duckParam` initial 1.0; (b) DUCK MERGE: overlapping spans → one MIN-`toGain` envelope recovering to 1.0 after the last cue; adjacent spans → two dips; empty spans no-op; `toGain` clamp; non-finite/inverted spans skipped; seek-into-duck resumes mid-envelope via `valueAt`; `cancelDuck` smooth recover + `trackedDuck` reset; (c) SINGLE-INPUT MASTER: `master` upstream count stays 1 across `connect`/`disconnect`/retarget; cue/lift never add a second master edge; (d) CONNECT/DISCONNECT/DISPOSE: move-one-edge, no-edge `disconnect` no-op, idempotent `dispose`, post-dispose guarded no-ops; (e) OFFLINE: construct the mixer against an `OfflineAudioContext`, run the SAME `scheduleDuck` call, `mixer.connect(offlineCtx.destination)`, and a full `startRendering()` with ZERO transport import — asserting byte-identical behavior to the online path.
  - Behavior: use the project's existing Web Audio test harness/mock convention (match `automation.test.ts` / `transport-master-gain.test.ts` style — do not introduce a new mocking approach). Duck-envelope assertions check the `scheduleLane` op sequence (`setValueAtTime` anchor + `linearRampToValueAtTime` edges, linear only), mirroring `automation.test.ts`'s op-sequence checks.
  - Tests (happy + error + edge): happy — topology + a single duck region + connect-to-destination render; error — non-finite/inverted span skipped, no-edge `disconnect`, post-dispose call; edge — overlap merge, seek-into-duck, `toGain` clamp, zero-length attack/release, double `dispose`.
  - Acceptance: the three guardrail suites (`automation.test.ts`, `audio-engine.test.ts`, `transport-master-gain.test.ts`) still run BYTE-IDENTICAL and GREEN after this module's work — they are not edited by this module; `npm run test` (full suite) is GREEN.

## Behavioral Audit (runs after all tasks above are [x])

- [x] [audit] Module behavioral audit | file: .dev/.task-state/mixer/behavioral-audit.md | model: T1
  - Ref: C:/Projects/.dev-shared/behavioral-audit.md — Module Behavioral Audit checklist
  - Ref: .dev/planning/modules/mixer/interfaces.md — every public interface (`createMixer`, `bedInput`/`cueInput`/`liftInput`, `master`, `masterParam`/`duckParam`, `scheduleDuck`, `cancelDuck`, `connect`, `disconnect`, `dispose`) must be verified
  - Ref: .dev/planning/modules/mixer/design.md — verify intended behavior matches implementation (graph §2, duck §4, connect/dispose §5/§6, offline §7)
  - Ref: .dev/planning/modules/mixer/edge-cases.md — verify all documented edge cases (§1–§7) are handled
  - Ref: .dev/planning/phase2-audio-architecture.md @ §1/§4 — verify the topology + duck invariants (single-input master, bed-only duck, MIN-toGain merge, single-writer duckParam D-019)
  - For each public interface: trace input → implementation → observable output (e.g. `scheduleDuck(spans,…)` → merge → `scheduleLane` op sequence → `duckParam` envelope; `connect(target)` → one `master` output edge).
  - For each consumer (transport §2.2, renderer §5, layer-scheduler §4): verify they read the correct field names/shapes from `Mixer` (`bedInput`/`cueInput`/`liftInput`/`master`/`masterParam`/`duckParam`) and call `scheduleDuck`/`connect`/`dispose` as specified — no silent valid-looking defaults.
  - Confirm L0 discipline: no transport globals (rAF/MediaSession/WakeLock/setTimeout/createMediaStreamDestination) appear in `mixer.ts`; offline parity holds.
  - Write findings to .dev/.task-state/mixer/behavioral-audit.md
  - PASS required before marking this module complete

## Completion Criteria
- [x] All tasks marked [x] — zero tasks left [ ] (Pending) or [!] (Needs-Attention)
- [x] Zero active stubs for this module (the graph-task stubs resolved by the duck and connect/dispose tasks)
- [x] All module tests passing (`mixer.test.ts` green via `npm run test` — 48/48)
- [x] The three guardrail suites unchanged and green BEFORE and AFTER: `automation.test.ts` (65), `audio-engine.test.ts` (63), `transport-master-gain.test.ts` (8)
- [x] Audit PASS for every task
- [x] last-step-summary.md written for every task with a concrete Observable Verification entry
- [x] Behavioral audit PASS (see above) — .dev/.task-state/mixer/behavioral-audit.md
