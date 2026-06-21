// layer-engine — Layer-0 signal core for ONE stacked audio layer (Web Audio only).
//
// Builds and owns the node graph for a single `Layer` — a synth `tone`, a looping
// `ambiance` bed, or a one-shot `voice` cue — and returns it as a `LayerNode` handle:
// the per-layer analogue of audio-engine's `Voice`. It is synchronous, takes any
// `BaseAudioContext` (so the identical code builds the graph live for transport and
// offline for the renderer, arch §5), and imports only the `Layer` / `LayerKind` /
// `ToneSpec` / `LayerSource` *types* from session-model. It never imports
// clip-library, automation, mixer, or transport, and references no rAF / MediaSession /
// createMediaStreamDestination (L0 / offline-reuse invariant).
//
// See .dev/planning/modules/layer-engine/{design,interfaces,edge-cases}.md and
// .dev/planning/phase2-audio-architecture.md §6 (the normative contract spine).

import type { Layer, LayerKind, ToneSpec, LayerSource } from './session-model';

// --- Types -----------------------------------------------------------------

/** Lifecycle state of a LayerNode. One-way: idle → running → stopped (mirrors Voice). */
export type LayerNodeState = 'idle' | 'running' | 'stopped';

/** Error code union for LayerNodeError.code. Programmer errors only — never a data
 *  condition (a missing clip or zero-length buffer is surfaced/tolerated, never thrown). */
export type LayerNodeErrorCode =
  | 'INVALID_CONTEXT' // ctx is missing or not a BaseAudioContext (lacks createGain/createStereoPanner)
  | 'ALREADY_STARTED'; // start() called twice; one-shot sources cannot restart (seek = rebuild)

// --- Errors ----------------------------------------------------------------

export class LayerNodeError extends Error {
  override readonly name = 'LayerNodeError';
  readonly code: LayerNodeErrorCode;
  readonly cause?: unknown;

  constructor(code: LayerNodeErrorCode, message?: string, cause?: unknown) {
    super(message ?? code);
    this.code = code;
    this.cause = cause;
    // Restore the prototype chain so `instanceof LayerNodeError` works after
    // transpilation to ES2015+ targets (mirrors AudioEngineError).
    Object.setPrototypeOf(this, LayerNodeError.prototype);
  }
}

// --- The LayerNode handle --------------------------------------------------

export interface LayerNode {
  readonly id: string; // = layer.id (correlate node ↔ Layer)
  readonly kind: LayerKind; // = layer.kind; caller routes by this
  readonly output: AudioNode; // ALWAYS the StereoPannerNode; caller connects to mixer.bedInput | cueInput
  readonly gainParam: AudioParam; // = layerGain.gain; single-writer (layer-scheduler); [0,1] expected
  readonly panParam: AudioParam; // = panner.pan;     single-writer (layer-scheduler); [-1,1], default 0

  /** Natural audible length of this layer's source, in seconds. For a clip layer
   *  (ambiance/voice) = `buffer.duration` (0 when the buffer is missing); for a tone =
   *  the one-shot envelope length `ToneSpec.attackSec + ToneSpec.releaseSec`. Read by
   *  layer-scheduler to span the bed-duck across a voice cue's whole audible body. */
  readonly durationSec: number;

  /** True only when this is a missing-clip silent node (buffer undefined for a clip layer). */
  readonly missing: boolean;

  /** Lifecycle state: idle → running → stopped (one-way), mirroring Voice. */
  readonly state: LayerNodeState;

  /** Start the source (and, for tone, schedule the one-shot ADSR) at context time atCtx.
   *  Throws ALREADY_STARTED if called twice. No-op (but advances state) on a missing-clip node. */
  start(atCtx: number): void;

  /** Stop the source at atCtx (default ctx.currentTime; a past time = "now"). Idempotent;
   *  no-op before start and on a missing-clip node. For tone, cancels remaining envelope past atCtx. */
  stop(atCtx?: number): void;

  /** Disconnect and release every owned node. Idempotent; valid from any state. */
  dispose(): void;
}

// --- Constants -------------------------------------------------------------

const UNITY_GAIN = 1; // layerGain.gain default — absent gain lane = constant unity
const CENTER_PAN = 0; // panner.pan default — center (RANGES.spatial / DEFAULTS.spatial)
const SILENT_GAIN = 0; // envGain.gain at construction — tone starts silent (D-008 no-click)
const PEAK_GAIN = 1; // ADSR peak amplitude

// --- Helpers ---------------------------------------------------------------

/** A LayerSource carrying a `{ synth }` ToneSpec. */
function isToneSource(source: LayerSource): source is { synth: ToneSpec } {
  return 'synth' in source;
}

// --- Module-level function -------------------------------------------------

export function createLayerNode(
  ctx: BaseAudioContext,
  layer: Layer,
  buffer?: AudioBuffer,
): LayerNode {
  // INVALID_CONTEXT is the only construction-time throw — a programmer error, surfaced
  // immediately (mirrors the Voice's context guard). A valid BaseAudioContext must
  // expose the node factories this module uses.
  if (
    !ctx ||
    typeof ctx.createGain !== 'function' ||
    typeof ctx.createStereoPanner !== 'function'
  ) {
    throw new LayerNodeError('INVALID_CONTEXT', 'a valid BaseAudioContext is required');
  }

  const kind = layer.kind;

  // Shared chain tail: layerGain (gain lane) → panner (pan lane) → output.
  // Built identically for every kind, including a silent missing-clip node, so the
  // caller routes and schedules uniformly (output type and the two params never vary).
  const layerGain = ctx.createGain();
  const panner = ctx.createStereoPanner();
  layerGain.gain.value = UNITY_GAIN; // unity; the gain lane, if present, overrides from t=0
  panner.pan.value = CENTER_PAN; // center
  layerGain.connect(panner);

  // Per-kind source. `source`/`envGain` stay undefined for a missing-clip silent node.
  let source: OscillatorNode | AudioBufferSourceNode | undefined;
  let envGain: GainNode | undefined;
  let missing = false;
  // The one-shot envelope length (attack + release), captured at construction so start()
  // schedules the ADSR and osc.stop without re-reading the spec. Tone only.
  let toneLengthSec = 0;
  // Natural audible length of the source: tone = attack+release, clip = buffer.duration
  // (0 when the buffer is missing). Read by layer-scheduler to span the bed duck across a
  // voice cue's whole body. Captured once at construction (the buffer never changes).
  let durationSec = 0;

  if (kind === 'tone' && isToneSource(layer.source)) {
    // tone: OscillatorNode(shape, freqHz) → envGain (ADSR) → layerGain.
    // The oscillator runs at its own fixed frequency directly (no ConstantSource
    // summing — a tone has a fixed pitch, not a swept binaural split). `buffer` and
    // `loop` are ignored for tones. The ADSR is scheduled at start(), not here,
    // because the start time is unknown until then.
    const synth = layer.source.synth;
    const osc = ctx.createOscillator();
    osc.type = synth.shape;
    osc.frequency.value = synth.freqHz;
    const env = ctx.createGain();
    env.gain.value = SILENT_GAIN; // silent start (D-008 no-click)
    osc.connect(env);
    env.connect(layerGain);
    source = osc;
    envGain = env;
    toneLengthSec = synth.attackSec + synth.releaseSec;
    durationSec = toneLengthSec; // tone one-shot length (attack + release)
  } else if (buffer !== undefined) {
    // ambiance / voice with a present (pre-decoded) buffer → AudioBufferSourceNode.
    // loop is resolved PER KIND deterministically (edge-cases §3): ambiance forced
    // true (a bed must never end and go silent), voice forced false (a cue plays once).
    // Layer.loop authoring intent is intentionally disregarded for both.
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.loop = kind === 'ambiance';
    src.connect(layerGain);
    source = src;
    durationSec = buffer.duration; // clip body length (ambiance/voice)
  } else {
    // buffer is undefined for a clip layer ({ clipId }) → missing-clip silent node.
    // The full tail exists (so output/params/routing/scheduling are identical), but no
    // source feeds layerGain, so the chain emits silence. Surfaced as missing:true,
    // NEVER thrown (the layer half of arch §0 / D-023 "missing clip = silence + notice").
    // (A `tone` whose source somehow isn't a ToneSpec post-validation also lands here as
    // a defensive silent tail; missing only flips true when a clipId was expected.)
    missing = !isToneSource(layer.source);
  }

  // --- Internal mutable state (JS-tracked; one-way state machine, mirrors Voice) ---
  let state: LayerNodeState = 'idle';
  let started = false;
  let startTime = 0;
  let disposed = false;

  return {
    id: layer.id,
    kind,
    output: panner,
    gainParam: layerGain.gain,
    panParam: panner.pan,
    durationSec,
    missing,

    get state() {
      return state;
    },

    start(atCtx: number): void {
      if (disposed) return; // dead node — no-op (the source is gone)
      if (state === 'stopped') return; // terminal — no restart
      if (state === 'running') {
        // OscillatorNode / AudioBufferSourceNode are one-shot and cannot be restarted;
        // the correct pattern for seek/restart is dispose + rebuild (design §4, arch §2.2).
        throw new LayerNodeError('ALREADY_STARTED', 'layer node already started');
      }

      startTime = atCtx;
      if (source) {
        if (envGain) {
          // tone: schedule the one-shot ADSR on envGain.gain relative to atCtx, then
          // bound the oscillator to the envelope length. LINEAR ramps only (D-008 /
          // Firefox setValueCurve bug) — never exponential, never setValueCurve.
          // setValueAtTime(0, t0) + linearRamp(1, t0+attack) + linearRamp(0, t0+attack+release).
          // Degenerate ADSR is faithful: attack 0 → instant peak; release 0 → immediate
          // drop; both 0 → zero-length no-op (start+stop osc at the same instant, no NaN,
          // no negative-duration ramp). No cap on very large lengths.
          const synth = (layer.source as { synth: ToneSpec }).synth;
          const attackEnd = atCtx + synth.attackSec;
          const releaseEnd = atCtx + toneLengthSec;
          envGain.gain.setValueAtTime(SILENT_GAIN, atCtx);
          envGain.gain.linearRampToValueAtTime(PEAK_GAIN, attackEnd);
          envGain.gain.linearRampToValueAtTime(SILENT_GAIN, releaseEnd);
          source.start(atCtx);
          (source as OscillatorNode).stop(releaseEnd);
        } else {
          // ambiance / voice: start the buffer source. ambiance loops until stop/dispose;
          // a voice source ends itself when its buffer runs out — start does NOT
          // pre-schedule a stop, so a long cue is not truncated.
          source.start(atCtx);
        }
      }
      // For a missing-clip silent node, there is no source to start — start is a
      // structural no-op but still advances state so the guard / stop / dispose behave
      // identically to a real node.
      started = true;
      state = 'running';
    },

    stop(atCtx?: number): void {
      if (disposed) return; // dead node — no-op
      if (state !== 'running') return; // no-op before start (idle) and after stop (terminal)
      // Pass the time through unchanged — a past time means "now" per Web Audio.
      const t = atCtx ?? ctx.currentTime;
      if (source) {
        if (envGain) {
          // For tone, cancel any remaining envelope schedule past `t` so a stop
          // mid-ring is clean, then stop the oscillator. Anchor the held value from
          // the JS-tracked schedule (we never read param.value, which can be stale on
          // Firefox); setValueAtTime is omitted here because the source is stopped at
          // the same instant — the param has no further audible effect.
          envGain.gain.cancelScheduledValues(t);
          (source as OscillatorNode).stop(t);
        } else {
          (source as AudioBufferSourceNode).stop(t);
        }
      }
      void started;
      void startTime;
      state = 'stopped';
    },

    dispose(): void {
      if (disposed) return; // idempotent — second dispose returns immediately
      // Disconnect every owned node (source, envGain if any, layerGain, panner). A
      // running source is disconnected and, being unreferenced, is GC'd; dispose does
      // not need stop first. The shared AudioBuffer is NOT released — the caller owns
      // the decode cache and it survives rebuilds across seeks.
      if (source) source.disconnect();
      if (envGain) envGain.disconnect();
      layerGain.disconnect();
      panner.disconnect();
      disposed = true;
    },
  };
}
