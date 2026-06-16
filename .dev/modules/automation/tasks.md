# Tasks: Automation
# Planning: .dev/planning/modules/automation/
# Architecture: .dev/architecture.md
# Standards: safety
# Stack: typescript

## Agent Briefing
`automation` is the Layer-1 timeline evaluator (`src/engine/automation.ts`): it turns a
validated `Preset` into either a pure value-at-time `t` (for UI preview and the re-target
anchor) or live audio (scheduling each lane's base curve plus the warble/pulse modulator
onto a real `audio-engine` `Voice`, guaranteeing continuous modulator phase). It depends
down on the two Layer-0 modules — `session-model` (types/`DEFAULTS`/`RANGES`) and
`audio-engine` (the `Voice` surface + `AudioEngineError`) — and never re-validates a
preset. It is consumed by `transport` (its normal entry point is `scheduleAll`) and by
`ui` (pure `valueAt`/`baseValueAt` for curve drawing and live readouts).

## References
- .dev/planning/modules/automation/design.md
- .dev/planning/modules/automation/interfaces.md
- .dev/planning/modules/automation/edge-cases.md
- .dev/planning/modules/automation/dependencies.md
- .dev/knowledge/web-audio/audioparam-automation.md
- .dev/knowledge/web-audio/continuous-phase-modulator.md

## Dependencies
- `session-model` (Layer 0) — type-only imports: `Preset`, `TimeNode`, `ParamPoint`,
  `ModPoint`, `AutomatableParam`, `Waveform`, plus the `DEFAULTS`/`RANGES` constant objects
  (the single source of eval-time carries and ranges). Must be complete first.
- `audio-engine` (Layer 0) — the `Voice` surface (`carrierParam`/`beatParam`/`volumeParam`/
  `modVolumeParam`, `connectWarble`, `createPulseNode`, `attachVolumeModulator`/
  `detachVolumeModulator`, `ctx`, `setWaveform`) and the `AudioEngineError` type/codes.
  Must be complete first.
- No runtime npm dependencies (platform/Web Audio APIs only — see dependencies.md).
- Consumers `transport` and `ui` are NOT dependencies (they depend up on this module).

## Tasks

- [x] [impl] Module scaffolding (`AutomationError`/codes, the §11 constants) plus carry-forward base evaluation `baseValueAt` and the four base transitions, pure and deterministic (no Web Audio). | file: src/engine/automation.ts | model: T1
  - Ref: .dev/planning/modules/automation/design.md @ 2. The three lanes and the eval/keyframe model
  - Ref: .dev/planning/modules/automation/design.md @ 3. Base transitions (3.1 exp safety fallback; smooth formula is exact in `valueAt`)
  - Ref: .dev/planning/modules/automation/design.md @ 11. Constants (single source of truth)
  - Ref: .dev/planning/modules/automation/interfaces.md @ 1. Error type; @ 2. Pure evaluation (baseValueAt)
  - Ref: .dev/planning/modules/automation/edge-cases.md @ A. Pure-function inputs (A1–A9)
  - Accepts: a valid `Preset`, `param: AutomatableParam`, `t: number`
  - Creates: `AutomationError` + `AutomationErrorCode`; exported `SMOOTH_*`/`VOLUME_MICRORAMP_SEC`/`RETARGET_LOOKAHEAD_SEC`/`FREQ_FLOOR_HZ`/`FREQ_CEIL_HZ` constants; `baseValueAt(preset, param, t): number`
  - Tests: hold-before-first and hold-after-last keyframe; exact linear / exp / hold / smoothstep values; exp→linear fallback at a 0 or sign-change endpoint (A8); non-finite `t` → `INVALID_TIME` (A1); bad `param` → `INVALID_PARAM` (A3); finite `t` clamped to `[0, durationSec]` (A2); lane-never-authored returns default (beat 0 / volume 1, A4); single-keyframe constant (A6)

- [x] [impl] Modulator pure evaluation `modulatorAt`: active-span resolution (carry/clear/set), linear field interpolation (frequency = 1/periodSec), shape realization (sine/triangle/gate), the analytic continuous-phase integral, and jump/steps sample-and-hold. | file: src/engine/automation.ts | model: T1
  - Ref: .dev/planning/modules/automation/design.md @ 5. The modulator — resolution, interpolation, shapes, phase (5.1–5.4)
  - Ref: .dev/planning/modules/automation/design.md @ 6. `jump` / `steps` (sample-and-hold step sequencer)
  - Ref: .dev/planning/modules/automation/interfaces.md @ 2. Pure evaluation (modulatorAt)
  - Ref: .dev/planning/modules/automation/edge-cases.md @ B. Carry-forward & modulator resolution boundaries; @ C. Continuous-phase guarantees
  - Ref: .dev/knowledge/web-audio/continuous-phase-modulator.md (phase = time-integral of frequency)
  - Accepts: a valid `Preset`, `param`, `t`
  - Creates: `modulatorAt(preset, param, t): number` (additive Hz offset for carrier/beat, multiplier for volume; `0`/`1` when no span is active)
  - Tests: absent-`mod` carries through (B1); `mod: null` clears (B2); last object holds to end and beyond `durationSec` (B3); shape change splits span / phase resets (B4); missing numeric fields use DEFAULTS, missing `periodSec` ⇒ inactive (B5); `depth=0` ⇒ 0/1 (B6); frequency `1/periodSec` linear interpolation (B7); analytic `Δphase = fi·Δt + 0.5·slope·Δt²` across sub-intervals; jump-with-steps holds `steps[k mod len]`; jump-without-steps falls back to glide

- [x] [impl] Combined pure surface: `valueAt` (additive carrier/beat, multiplicative volume, with the identical frequency-depth and volume-depth safety clamps the scheduler applies) and the waveform readers `waveformAt` / `waveformKeyframes`. | file: src/engine/automation.ts | model: T1
  - Ref: .dev/planning/modules/automation/design.md @ 4. The combine rule — additive (freq) vs multiplicative (volume)
  - Ref: .dev/planning/modules/automation/design.md @ 7. `valueAt` and the pure siblings (algorithm)
  - Ref: .dev/planning/modules/automation/design.md @ 8. schedule (8.5 safety clamps — apply the same in `valueAt`)
  - Ref: .dev/planning/modules/automation/design.md @ 10. `scheduleAll` and `waveform` (waveformAt / waveformKeyframes)
  - Ref: .dev/planning/modules/automation/interfaces.md @ 2. Pure evaluation (valueAt, waveformAt, waveformKeyframes)
  - Ref: .dev/planning/modules/automation/edge-cases.md @ A. Pure-function inputs (A10); @ G. Frequency-safety & range boundaries; @ I. Waveform
  - Accepts: a valid `Preset`, `param`, `t`
  - Creates: `valueAt(preset, param, t): number`; `waveformAt(preset, t): Waveform`; `waveformKeyframes(preset): ReadonlyArray<{ t: number; waveform: Waveform }>`
  - Tests: carrier/beat = `base + mod`, volume = `base × mod`; freq-depth clamp keeps instantaneous frequency in `[1, 20000]` (G1); volume `depth ≤ 1`; no output clamp — tremolo authored above 1.0 reported as-authored (A10); waveform carry-forward default `'sine'` (I2); consecutive duplicates deduplicated (I3); `waveformKeyframes` always includes the `t=0` entry

- [x] [impl] `schedule` base curve onto a `Voice`: lane handle selection, anchored native primitives (`setValueAtTime` + linear/exp ramps), the `smooth` piecewise-linear polyline, the volume micro-ramp, the exp→linear fallback; plus the `ScheduledLane` skeleton with idempotent `stop`/`dispose`. | file: src/engine/automation.ts | model: T1
  - Ref: .dev/planning/modules/automation/design.md @ 8. schedule (8.1 pick base handle / modulator wiring; 8.2 schedule the base curve)
  - Ref: .dev/planning/modules/automation/design.md @ 3. Base transitions (3.2 smooth polyline; 3.3 volume micro-ramp / frequency steps)
  - Ref: .dev/planning/modules/automation/interfaces.md @ 3. Scheduling onto a live Voice; @ 4. Handles
  - Ref: .dev/planning/modules/automation/edge-cases.md @ D. AudioParam scheduling quirks; @ H. Lifecycle (H1, H3, H4, H5)
  - Ref: .dev/knowledge/web-audio/audioparam-automation.md (anchor before ramping; never `setValueCurveAtTime`; no exp ramp to 0)
  - Accepts: `Preset`, `param`, `voice: Voice`, `options?: { startTime?: number; startOffsetSec?: number }`
  - Creates: the base-curve portion of `schedule(preset, param, voice, options?): ScheduledLane`; the `ScheduledLane` handle (`param`, `pulseUnavailable`, `stop`, `dispose`)
  - Tests (OfflineAudioContext render): anchored start value at `startOffsetSec`; correct primitive per transition (linear/exp ramp, true `hold` step); smooth polyline endpoints land exactly on the smoothstep (D5); volume `hold` → 10 ms micro-ramp (D4), carrier/beat `hold` → true step (D3); exp-to-0 segment → linear (D2/A8); `startOffsetSec` skips earlier intervals and anchors at the offset (H3); suspended ctx schedules silently (H1); `stop`/`dispose` idempotent in any order (H5); `VOICE_STOPPED` propagates (H4)

- [x] [impl] [availability] `schedule` modulator wiring: glide warble (`connectWarble` + frequency/depth ramps) and pulse/square gate (`createPulseNode` — depth=1 gate→GainNode for carrier/beat, `attachVolumeModulator` for volume), jump/steps `ConstantSourceNode` stepping, the frequency-depth safety clamp, graceful worklet degradation, and recorded span boundaries for scheduled teardown. | file: src/engine/automation.ts | model: T1
  - Ref: .dev/planning/modules/automation/design.md @ 8. schedule (8.3 glide; 8.4 pulse/square; 8.5 safety clamps; 8.6 scheduled teardown)
  - Ref: .dev/planning/modules/automation/design.md @ 5. The modulator (5.3 shape realization map; 5.4 continuous phase in audio); @ 6. `jump` / `steps`
  - Ref: .dev/planning/modules/automation/edge-cases.md @ F. Worklet / pulse availability; @ G. Frequency-safety; @ H. Lifecycle (H6 teardown timing)
  - Ref: .dev/knowledge/web-audio/continuous-phase-modulator.md @ phase-continuous warble + pulse worklet
  - Ref: .dev/knowledge/web-audio/audioparam-automation.md @ base+LFO summing, ramp/cancel rules
  - Ref: .dev/planning/modules/automation/interfaces.md @ 4. Handles (pulseUnavailable)
  - Accepts: a lane's resolved modulator spans and the `Voice` helpers (`connectWarble` / `createPulseNode` / `attachVolumeModulator`)
  - Creates: the modulator-wiring portion of `schedule`; `lane.pulseUnavailable`; per-span boundary/end-time records that `transport` drives teardown from
  - Tests (OfflineAudioContext render): one warble osc started once per span with frequency/depth ramped — node never re-created mid-span, phase continuous (C1); pulse carrier via depth=1 gate → `GainNode(depth)`; pulse volume via `attachVolumeModulator`; square pins edge=0; jump/steps boundary-stepped offsets (freq true step, volume micro-ramp); `WORKLET_NOT_REGISTERED` / `WORKLET_LOAD_FAILED` caught → base still plays, `pulseUnavailable = true` (F1/F2); other `AudioEngineError` propagates; depth clamped so instantaneous frequency stays in `[1, 20000]` (G1)

- [x] [impl] [availability] Mid-session `retarget` (feature-detected `cancelAndHoldAtTime`, else Firefox `cancelScheduledValues` + a JS-computed `baseValueAt` anchor; modulator kept-or-rebuilt by identity) and the aggregate `scheduleAll` returning a `SessionSchedule` whose `retarget`/`stop`/`dispose` fan out to all three lanes. | file: src/engine/automation.ts | model: T1
  - Ref: .dev/planning/modules/automation/design.md @ 9. Mid-session re-targeting (`retarget`)
  - Ref: .dev/planning/modules/automation/design.md @ 10. `scheduleAll` and `waveform`
  - Ref: .dev/planning/modules/automation/interfaces.md @ 3. Scheduling onto a live Voice (scheduleAll); @ 4. Handles (retarget, SessionSchedule)
  - Ref: .dev/planning/modules/automation/edge-cases.md @ E. Mid-session re-targeting quirks (Firefox fallback); @ H. Lifecycle
  - Ref: .dev/knowledge/web-audio/audioparam-automation.md (never read `param.value`; JS-tracked anchor)
  - Accepts: an edited `Preset`, optional `atContextTime`; the live `ScheduledLane` state (`currentPreset`, `startTime`, `startOffsetSec`, modulator handles)
  - Creates: `ScheduledLane.retarget(preset, atContextTime?)`; `scheduleAll(preset, voice, options?): SessionSchedule`; `SessionSchedule` (`lanes`, `retarget`, `stop`, `dispose`)
  - Tests (OfflineAudioContext render): `cancelAndHoldAtTime` path holds value at `tr` then reschedules; Firefox fallback uses `cancelScheduledValues` + JS anchor and never reads `param.value` (E1/E2); modulator kept + re-ramped when identity unchanged (phase continuous, C3), rebuilt when shape/on-off changes (E4); `atContextTime` defaults to `now + 0.020` and floors past event times (E3); `scheduleAll` fans `retarget`/`stop`/`dispose` to all three lanes

- [x] [test] Preview-equals-playback parity and continuous-phase verification: assert `baseValueAt`/`modulatorAt`/`valueAt` match the OfflineAudioContext-rendered audio across every transition, shape, ramped period, and a re-target. | file: src/engine/automation.test.ts | model: T1
  - Ref: .dev/planning/modules/automation/design.md @ 5. The modulator (5.4 Continuous phase — the load-bearing guarantee)
  - Ref: .dev/planning/modules/automation/design.md @ 7. `valueAt` and the pure siblings; @ 8. schedule
  - Ref: .dev/planning/modules/automation/edge-cases.md @ C. Continuous-phase guarantees
  - Ref: .dev/knowledge/web-audio/continuous-phase-modulator.md
  - Accepts: representative presets exercising each transition, each shape, glide vs jump/steps, and a mid-session edit
  - Creates: an `OfflineAudioContext` render harness plus parity assertions (reused by the impl tasks' tests)
  - Tests: rendered sample == `valueAt` at smooth sub-step endpoints and at arbitrary `t` for linear/exp/hold; a ramped `periodSec` produces no amplitude discontinuity (C1); phase stays continuous across mod-keyframe ramps; preview == playback after a `retarget` (C3)

- [x] [impl] [availability] Spatial lane (D-021): schedule + pure-eval the 4th 'spatial' lane — additive base + sweep on voice.spatialParam (connectWarble / pulse-gate, same as carrier/beat), result clamped to [−1,1]; scheduleAll/valueAt/retarget cover four lanes | file: src/engine/automation.ts | model: T1
  - Ref: .dev/planning/modules/automation/design.md @ §2 lanes (spatial is the 4th continuous lane); §4 combine (spatial additive in position, clamp −1..1; lanes independent/concurrent); §8.1 lane table (spatial → spatialParam)
  - Ref: .dev/planning/modules/automation/design.md @ §7 valueAt (INVALID_PARAM set includes spatial); §10 scheduleAll (four lanes)
  - Ref: .dev/planning/decisions-log.md @ D-021 (spatial stacks across lanes; one modulator per lane)
  - Ref: .dev/planning/modules/audio-engine/design.md @ §2.7 (spatialParam → pan-gain pair)
  - Accepts: a valid v3 Preset, param 'spatial', t; voice.spatialParam for scheduling
  - Creates: baseValueAt/modulatorAt/valueAt accept 'spatial' (additive combine: value = clamp(base + mod, −1, 1)); INVALID_PARAM set = {carrier,beat,volume,spatial}; schedule() drives voice.spatialParam (connectWarble for sine/triangle, pulse-gate→GainNode→spatialParam for square/pulse — identical to carrier/beat) with the [−1,1] clamp; scheduleAll schedules four lanes and fans retarget/stop/dispose to all four
  - Tests: spatial base + sine sweep = clamp(base+depth·s, −1,1); square/pulse spatial = unipolar gate [base, base+depth] clamped; preview valueAt == OfflineAudioContext-rendered pan position; a spatial sweep runs concurrently with a beat warble and a volume pulse with no interaction (independent lanes); INVALID_PARAM for an unknown lane; scheduleAll/retarget/stop/dispose cover all four lanes; spatial absent → centered (0), no pan nodes wired

- [x] [audit] Behavioral audit: automation | file: .dev/.task-state/audit-automation.md | model: T1
  - Ref: C:/Projects/.dev-shared/behavioral-audit.md
  - Ref: .dev/planning/modules/automation/interfaces.md — every public interface must trace input → output
  - Ref: .dev/planning/modules/automation/edge-cases.md — every documented edge case (A–I) must have evidence of handling
  - Verify the module's observable behavior matches its interfaces.md + edge-cases.md; check every edge case is handled and `transport`/`ui` consume the correct field names/shapes. PASS required before the module is complete.

## Cleanup

- [x] [cleanup] Doc drift: document the `box` (breath trapezoid) shape and the four-lane (`spatial`) `INVALID_PARAM` set in the automation planning docs | file: .dev/planning/modules/automation/{interfaces.md,edge-cases.md,design.md} | model: T2
  - Ref: behavioral audit 2026-06-15 — `box` shape (trapezoid trajectory, h=0 triangle / h=1 square degenerate cases, steps-ignored, volume [1−depth,1] map, always-rebuild-on-retarget) and the spatial pan-range clamp are implemented + tested in `automation.ts` but absent from the planning docs. `interfaces.md §1` still reads `param not in {'carrier','beat','volume'}` though source (`automation.ts:55`) and session-model already use the four-lane set `{carrier,beat,volume,spatial}`. Deterministic doc-only fix; code is correct, docs are stale.

## Completion Criteria
- [ ] All tasks above marked [x] — none left [ ] (Pending) or [!] (Needs-Attention)
      ← NOT yet: one open `## Cleanup` doc-drift task (behavioral audit 2026-06-15). All impl/test/audit tasks are [x].
- [x] Zero active stubs for `automation` in .dev/.task-state/stub-registry.md
      ← Verified: no active stub is assigned inside the automation module (active stubs are session-model / persistence / pwa-shell).
- [x] All module tests passing (full suite, not just the current task's tests)
      ← Verified 2026-06-15: `npx vitest run` → 651 passed / 0 failed (40 files); scoped automation → 65/65.
- [ ] Per-task audit PASS for every task
      ← Not verified by this behavioral audit (per-task audit reports were not inspected). Behavioral-level behavior is PASS.
- [x] last-step-summary.md written for every task with a concrete Observable Verification entry
      ← last-step-summary.md present; this audit appends its Observable Verification entry.
- [x] Behavioral audit PASS (see above)
      ← Verified: .dev/.task-state/audit-automation.md → Status PASS (re-audit 2026-06-15).
