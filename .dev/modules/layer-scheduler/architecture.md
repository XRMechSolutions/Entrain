# Module: layer-scheduler

## Purpose

`layer-scheduler` is the **timeline driver for stacked layers** — the exact peer of
`automation.scheduleAll`, but for `Preset.layers[]` instead of the binaural `nodes[]`. Given a set of
already-built, already-routed `LayerNode`s (one per `Layer`, connected to the mixer's bed/cue sub-bus
by kind), it (1) schedules each layer's gain and pan lane onto the node's `gainParam`/`panParam` via
the shared `scheduleLane` primitive, (2) starts each node's source at its absolute placement when that
placement is at/after the current play offset, and (3) computes the bed-duck envelope from
`voice`-kind cue layers, **merges overlapping spans**, and installs it via `mixer.scheduleDuck`. It is
pure Web Audio against the mixer's `BaseAudioContext` — no `rAF`, no `MediaSession`, no transport
globals — which is why `renderer` reuses the identical call offline for byte-identical scheduling. It
adds no new AudioParam-writing path: its only original computation is the relative→absolute time shift
and the duck-span merge (both pure arithmetic).

## Public Interface

Implementation file: `src/engine/layer-scheduler.ts`. The `scheduleLayers`/`LayerSchedule` shape is
restated VERBATIM from phase2-audio-architecture.md §6 (NORMATIVE); §6 wins on any apparent conflict.

```ts
import type { Layer, LayerKind, LanePoint, ToneSpec, DuckIntent } from './session-model';
import type { Mixer, DuckSpan } from './mixer';
import type { LayerNode } from './layer-engine';
import { scheduleLane, VOLUME_MICRORAMP_SEC, RETARGET_LOOKAHEAD_SEC } from './automation';

// `DuckIntent` { toGain∈[0,1], attackSec≥0, releaseSec≥0 } is OWNED by `session-model` (D-038) and
// imported here — never redeclared. Each voice-kind `Layer` carries its dip on `Layer.duck`; this
// scheduler reads `layer.duck` off the layers it is handed (no companion map, no extra param).

export interface ScheduleLayersOpts {
  t0: number;             // ctx-clock time mapped to SESSION time = startOffsetSec
  startOffsetSec: number; // session-second the (re)build starts at (seek; 0 fresh/offline)
}

export function scheduleLayers(
  mixer: Mixer,
  nodes: readonly LayerNode[],
  layers: readonly Layer[],
  opts: ScheduleLayersOpts,
): LayerSchedule;

export interface LayerSchedule {
  retarget(layers: readonly Layer[], atCtx?: number): void; // live edit, position unchanged
  cancel(): void;   // cancel future lane events (params HOLD) + cancelDuck; does NOT stop sources
  dispose(): void;  // drop bookkeeping; idempotent; retarget/cancel become no-ops afterward
}
```

Time composition (the core rule, design §3): `ctxTime = t0 + (layer.t + lanePoint.t - startOffsetSec)`,
delegated to `scheduleLane`'s `startTime`/`startOffsetSec`/`floorTime`/`anchorValue`/`valueAt` — never
computed inline, never written to an AudioParam by this module. The module originates **no** error type
(interfaces.md §4): non-finite times bubble as `scheduleLane`'s `AutomationError('INVALID_TIME')`;
malformed caller inputs degrade to skip-and-continue (edge-cases §7).

## Dependencies

Interface-level only (no runtime npm deps — dependencies.md: zero):

- `automation` (L1) — `scheduleLane` (the §3 shared no-click param writer), `VOLUME_MICRORAMP_SEC`
  (gain-lane hold-fork), `RETARGET_LOOKAHEAD_SEC` (retarget default lead). Reused, never
  re-implemented — this is what makes a layer fade as click-free as a binaural fade (D-008).
- `mixer` (L0) — types `Mixer`/`DuckSpan`; methods `scheduleDuck`/`cancelDuck`. The mixer is the
  **sole writer** of `duckParam` (D-019); this module hands it only pre-merged, non-overlapping regions.
- `layer-engine` (L0) — type `LayerNode` (`gainParam`/`panParam`/`output`/`start`/`stop`/`dispose`).
  This module drives nodes it is handed; it never calls `createLayerNode` and never disposes nodes.
- `session-model` (L0) — types only: `Layer`, `LayerKind`, `LanePoint`, `ToneSpec`, `DuckIntent`
  (the owner of `DuckIntent`, D-038; the scheduler reads each cue's dip off `Layer.duck`). No
  validation, no runtime coupling.

Depended on by: `transport` (startFresh / seekWhilePlaying / reapply) and `renderer` (offline). Never
depends on `transport`/`renderer`/`persistence`/`ui` — transport-freedom is the arch §5 requirement
that lets the offline renderer make the identical `scheduleLayers` call.

## Internal Structure

```
src/engine/
  layer-scheduler.ts        # scheduleLayers factory + LayerSchedule handle (DuckIntent imported from
                            #   session-model, D-038; reads layer.duck); absPoints/laneValueAt
                            #   time-shift helpers; duck-span computation + merge
  layer-scheduler.test.ts   # time composition, seek mid-clip intra-offset, duck overlap/merge
```

## Planning References

- .dev/planning/modules/layer-scheduler/design.md — behavior and decisions (the WHY)
- .dev/planning/modules/layer-scheduler/interfaces.md — exact contracts (VERBATIM §6 surface)
- .dev/planning/modules/layer-scheduler/edge-cases.md — failure modes and tolerated runtime states
- .dev/planning/modules/layer-scheduler/dependencies.md — libraries (none) and internal deps
- .dev/planning/phase2-audio-architecture.md — §1 topology, §3 `scheduleLane`, §4 ducking, §5 offline
  reuse, §6 contract spine (NORMATIVE) + build order
