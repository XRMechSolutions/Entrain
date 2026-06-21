# Module: layer-engine

## Purpose

`layer-engine` builds and owns the Web-Audio node graph for **one stacked audio layer** — a synth
tone, a looping ambiance bed, or a one-shot voice cue — and exposes it as a `LayerNode` handle. It
is the per-layer analogue of `audio-engine`'s `Voice`: a Layer-0 signal core that takes a `Layer`
(plus, for clip layers, a caller-pre-decoded `AudioBuffer`) and returns a node with a stable
`output`, two automatable params (`gainParam`, `panParam`), and a `start`/`stop`/`dispose`
lifecycle. It is pure Web Audio — synchronous, no Promise, no `clip-library` / `mixer` / `transport`
/ DOM import — so the identical code path builds the graph live (transport) and offline
(`OfflineAudioContext`, renderer §5). `transport`/`renderer` decode clips upstream, construct one
`LayerNode` per `preset.layers[i]`, connect `output` to the mixer by `kind`, and hand the node to
`layer-scheduler`, which is the **single writer** of `gainParam`/`panParam` (D-019).

## Public Interface

```ts
import type { Layer, LayerKind, ToneSpec } from './session-model';

// Arch §6 contract spine (VERBATIM). Synchronous; never returns a Promise.
export function createLayerNode(
  ctx: BaseAudioContext,
  layer: Layer,
  buffer?: AudioBuffer,
): LayerNode;

export interface LayerNode {
  readonly id: string;             // = layer.id
  readonly kind: LayerKind;        // = layer.kind ('tone' | 'ambiance' | 'voice'); caller routes by this
  readonly output: AudioNode;      // ALWAYS the StereoPannerNode; connect to mixer.bedInput | cueInput
  readonly gainParam: AudioParam;  // = layerGain.gain; single-writer (layer-scheduler); starts at unity 1
  readonly panParam: AudioParam;   // = panner.pan;     single-writer (layer-scheduler); [-1,1], default 0
  readonly missing: boolean;       // true only for a missing-clip silent node
  readonly state: LayerNodeState;  // 'idle' → 'running' → 'stopped' (one-way), mirroring Voice
  start(atCtx: number): void;      // throws ALREADY_STARTED on second call; no-op (advances state) when missing
  stop(atCtx?: number): void;      // default ctx.currentTime; idempotent; no-op before start / when missing
  dispose(): void;                 // idempotent; valid from any state
}

export type LayerNodeState = 'idle' | 'running' | 'stopped';
export type LayerNodeErrorCode = 'INVALID_CONTEXT' | 'ALREADY_STARTED';
export class LayerNodeError extends Error { /* name, code, optional cause; prototype restored */ }
```

Node chains (every chain ends `… → layerGain (GainNode) → panner (StereoPannerNode) → output`):
- **tone:** `OscillatorNode(shape, freqHz) → envGain(ADSR) → layerGain → panner`. ADSR scheduled at
  `start`: linear attack `0→1` over `attackSec`, linear release `1→0` over `releaseSec`; one-shot
  length = `attackSec + releaseSec`; oscillator stopped at that instant. No buffer; `loop` ignored.
- **ambiance:** `AudioBufferSourceNode(buffer, loop = true) → layerGain → panner`. Loops until stop/dispose.
- **voice:** `AudioBufferSourceNode(buffer, loop = false) → layerGain → panner`. One-shot cue; `loop` forced false.
- **missing clip:** `buffer` undefined for a `{ clipId }` layer → silent node (no source, full tail),
  `missing: true`, `output`/params present, never throws.

Throws only on programmer errors: `INVALID_CONTEXT` (bad `ctx` at construction) and `ALREADY_STARTED`
(restart attempt — seek is dispose+rebuild). Missing/zero-length buffers and benign `loop` mismatches
are surfaced or tolerated, never thrown.

## Dependencies

- **`session-model` — type-only** (`import type { Layer, LayerKind, ToneSpec, LayerSource }`). Erased
  at build; no runtime edge, no cycle. Trusts the validated shape; calls no `session-model` function.
  **Hard prerequisite: the session-model v3→v4 schema bump (arch §0) must land first** — `Layer`,
  `LayerKind`, `ToneSpec`, `Preset.layers` do not exist in code until then.
- **No other project module.** Does NOT import `clip-library` (decode is the caller's job),
  `automation`/`scheduleLane` (layer-scheduler writes the lanes), or `mixer`/`transport` (the caller
  routes `output` by kind). This strict L0 isolation (no rAF / MediaSession /
  `createMediaStreamDestination`) is required so the identical graph builds live and offline.
- **Built-in Web Audio only:** `OscillatorNode`, `AudioBufferSourceNode`, `GainNode`,
  `StereoPannerNode`, `AudioParam` (`setValueAtTime`/`linearRampToValueAtTime`/`cancelScheduledValues`),
  `BaseAudioContext`. No npm runtime package; no AudioWorklet.

## Internal Structure

```
src/engine/
  layer-engine.ts        # createLayerNode, LayerNode, LayerNodeState, LayerNodeError(Code) — the whole module
  layer-engine.test.ts   # Vitest co-located suite; uses MockAudioContext from src/test/webaudio-mock.ts
```

Supporting test infrastructure (shared, not owned by this module): `src/test/webaudio-mock.ts` must
be extended with `createStereoPanner` (MockStereoPannerNode, `.pan` AudioParam default 0, range
[-1,1]) and `createBufferSource` (MockAudioBufferSourceNode, `.buffer`, `.loop`, one-shot
`start`/`stop`) before the suite can run — these mock nodes do not yet exist.

## Planning References

- .dev/planning/modules/layer-engine/design.md — node chains per kind, lifecycle, missing-clip rule, ADSR
- .dev/planning/modules/layer-engine/interfaces.md — exact `createLayerNode` / `LayerNode` contract (arch §6 verbatim)
- .dev/planning/modules/layer-engine/edge-cases.md — missing/zero-length buffer, loop-per-kind, degenerate ADSR, start-twice
- .dev/planning/modules/layer-engine/dependencies.md — Web Audio APIs, session-model type-only, L0 isolation
- .dev/planning/phase2-audio-architecture.md — §6 contract spine (normative), §0 schema gate, §1 bus topology, §5 offline reuse
