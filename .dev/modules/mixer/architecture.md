# Module: mixer

## Purpose
`mixer` owns **all summation** for a session. It is the single fan-in point where the binaural
voice, every layer (tone / ambiance / voice-cue), and the Shepard lift overlay sum down to one
master `GainNode` that the transport (or the offline renderer) routes to an output target. It also
owns the **bed-duck** automation: the single envelope that dips the bed sub-bus under a voice cue.
One module, one summation graph, one duck writer. It is pure Web Audio against any
`BaseAudioContext` so the **byte-identical** graph is reused offline by `renderer` against an
`OfflineAudioContext` (no transport globals — the L0 discipline).

## Public Interface
`src/engine/mixer.ts` exports one factory and two types (verbatim from
phase2-audio-architecture.md §6, the contract spine):

```ts
export function createMixer(ctx: BaseAudioContext, opts?: { masterStart?: number }): Mixer;

export interface Mixer {
  readonly bedInput: AudioNode;   // bed fan-in (voice + tone + ambiance) → duckGain → busSum
  readonly cueInput: AudioNode;   // voice-cue fan-in; joins busSum DOWNSTREAM of the duck
  readonly liftInput: AudioNode;  // shepard-lift fan-in; post-duck overlay
  readonly master: GainNode;      // single-input master (only upstream is busSum); starts at 0
  readonly masterParam: AudioParam; // master.gain — bound by createMasterGainController; mixer never writes it
  readonly duckParam: AudioParam;   // duckGain.gain — bed-only duck; mixer.scheduleDuck is the SOLE writer (D-019)
  scheduleDuck(spans: readonly DuckSpan[], t0: number, startOffsetSec: number): void;
  cancelDuck(atCtxTime: number): void;
  connect(target: AudioNode): void;   // move master's ONE output edge
  disconnect(): void;                 // drop master's output edge (idempotent)
  dispose(): void;                    // idempotent teardown; goes inert
}

export interface DuckSpan {
  startCtx: number;   // ctx time the cue's audible onset begins (attack ends here)
  endCtx: number;     // ctx time the cue ends (release begins here)
  toGain: number;     // [0,1] finite — bed gain during the cue (deepest wins on overlap)
  attackSec: number;  // ≥ 0 finite — ramp-down duration into toGain
  releaseSec: number; // ≥ 0 finite — ramp-up duration back to 1.0
}
```

The node graph (design §2): four `GainNode`s, fixed wiring, only `duckGain.gain` is automated
after construction; `master.gain` is written exactly once at construction (= `opts.masterStart ?? 0`).

```
  bedInput(1.0) ──► duckGain(1.0) ──┐
  cueInput(1.0) ─────────────────────► busSum(1.0) ──► master(0.0) ──► (target, via connect())
  liftInput(1.0) ────────────────────┘
```

## Dependencies
- `automation` — imports `scheduleLane` (function) plus `LanePoint` / `ScheduleLaneOpts` (types).
  The duck envelope is written through the **same** no-click param writer every other automated
  lane uses; the mixer adds NO mixer-private ramp writer. This is a Layer-0 → Layer-1 edge, allowed
  because `scheduleLane` is a pure Web-Audio free function with no transport coupling.
- Web Audio platform APIs only: `ctx.createGain()`, `node.connect`/`node.disconnect`,
  `AudioParam` scheduling (via `scheduleLane`), `ctx.currentTime`, `cancelScheduledValues` /
  `cancelAndHoldAtTime` (feature-detected). **Zero npm runtime dependencies.**
- Imports **no** other project module — not `session-model` (layer routing by `LayerKind` is
  `layer-scheduler`'s job), not `audio-engine` (the voice is connected *into* `bedInput` by the
  consumer), not `transport`/`renderer` (they consume the mixer, never the reverse).

Hard prerequisite (build order, arch §6): the **session-model v3→v4 schema bump** (`Layer`,
`LayerKind`, `Preset.layers`) and the **`scheduleLane` extraction** from `automation.ts` must land
first. The mixer's duck path imports `scheduleLane`; the schema bump gates the whole layer feature.

## Internal Structure
```
src/engine/
  mixer.ts          # createMixer factory: graph construction, scheduleDuck/cancelDuck,
                    # connect/disconnect, dispose. The only file this module owns.
  mixer.test.ts     # topology, duck overlap-merge (MIN toGain), single-input master invariant,
                    # connect/disconnect/dispose idempotency, OfflineAudioContext parity.
```

## Planning References
- .dev/planning/modules/mixer/design.md — behavior and decisions (graph §2, scheduleLane reuse §3,
  ducking §4, connect/disconnect §5, dispose §6, offline reuse §7)
- .dev/planning/modules/mixer/interfaces.md — exact `Mixer` / `DuckSpan` contracts (restated
  verbatim from arch §6)
- .dev/planning/modules/mixer/edge-cases.md — degenerate spans, overlap/seek, master invariant,
  connect/disconnect/dispose degeneracies, offline edge cases
- .dev/planning/modules/mixer/dependencies.md — `scheduleLane` (the one project dep) + Web Audio
  APIs; zero npm runtime footprint
- .dev/planning/phase2-audio-architecture.md — NORMATIVE for routing/scheduling/duck/master:
  §1 topology, §3 `scheduleLane`, §4 ducking, §6 contract spine + build order
