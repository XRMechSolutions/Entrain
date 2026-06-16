// shepard — a STANDALONE layer that owns the `shepard` AudioWorklet node (the
// Shepard–Risset "lift": an endless ascending/descending glissando, mixed in alongside
// the binaural voice). It is deliberately independent of the binaural Voice and the
// preset schema: it is a live overlay, not part of session-model/automation (yet).
//
// Mirrors the audio-engine pulse-worklet wiring (registerShepardWorklet is WeakSet-
// idempotent per ctx; createShepardNode register-before-create), but stays self-contained
// so the lift can be added/removed without touching the binaural signal core.

// The shepard worklet, bundled standalone (transpiled, import-free) by Vite and exposed
// as a URL for audioWorklet.addModule — works in dev, prod, and tests (where the URL is
// unused because addModule is mocked). See registerShepardWorklet.
import shepardWorkletUrl from './shepard-worklet.ts?worker&url';

/** The processor name string, shared by addModule registration and the node ctor. */
export const SHEPARD_PROCESSOR_NAME = 'shepard';

const SPEED_DEFAULT = 0.25; // octaves/sec, SIGNED (+ ascending / − descending)
const GAIN_DEFAULT = 0.5; // 0..1 level
const GAIN_MIN = 0;
const GAIN_MAX = 1;

/** Error thrown when the worklet module fails to load or a node is built too early. */
export class ShepardError extends Error {
  readonly cause?: unknown;
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'ShepardError';
    this.cause = cause;
    Object.setPrototypeOf(this, ShepardError.prototype);
  }
}

/** Instantiation options for createShepardNode. Both optional. */
export interface ShepardOptions {
  /** Glissando rate in octaves/sec, SIGNED: + rises, − falls. Default 0.25. */
  speed?: number;
  /** Output level 0..1 (clamped). Default 0.5. */
  gain?: number;
}

/** Handle over a live shepard node + its a-rate params (parallels PulseHandle). */
export interface ShepardHandle {
  readonly node: AudioWorkletNode; // the "shepard" processor node
  readonly output: AudioNode; // = node; the normalized mono glissando signal
  readonly speedParam: AudioParam; // octaves/sec, SIGNED, a-rate
  readonly gainParam: AudioParam; // 0..1, a-rate
  disconnect(): void; // disconnects the node from all targets
}

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}

// Tracks which contexts have had the shepard worklet module added (idempotency).
const registeredContexts = new WeakSet<BaseAudioContext>();

/** Add the shepard worklet module to `ctx`. Idempotent per context (a second call for
 *  the same ctx resolves immediately). A failed addModule rejects with a ShepardError. */
export function registerShepardWorklet(ctx: BaseAudioContext, moduleUrl?: string): Promise<void> {
  if (registeredContexts.has(ctx)) return Promise.resolve();
  const url = moduleUrl ?? shepardWorkletUrl;
  return ctx.audioWorklet.addModule(url).then(
    () => {
      registeredContexts.add(ctx);
    },
    (err: unknown) => {
      throw new ShepardError('shepard worklet addModule failed', err);
    },
  );
}

/** Build a `shepard` AudioWorkletNode (1 mono output). registerShepardWorklet(ctx) MUST
 *  have resolved first (never create before registration). */
export function createShepardNode(ctx: BaseAudioContext, opts?: ShepardOptions): ShepardHandle {
  if (!registeredContexts.has(ctx)) {
    throw new ShepardError('registerShepardWorklet(ctx) must resolve before createShepardNode');
  }
  const node = new AudioWorkletNode(ctx, SHEPARD_PROCESSOR_NAME, {
    numberOfInputs: 0,
    numberOfOutputs: 1,
    outputChannelCount: [1],
  });
  const speedParam = node.parameters.get('speed') as AudioParam;
  const gainParam = node.parameters.get('gain') as AudioParam;

  // speed is signed (no clamp — the worklet's own −8..8 descriptor bounds it); gain 0..1.
  speedParam.value = opts?.speed ?? SPEED_DEFAULT;
  gainParam.value = clamp(opts?.gain ?? GAIN_DEFAULT, GAIN_MIN, GAIN_MAX);

  return {
    node,
    output: node,
    speedParam,
    gainParam,
    disconnect(): void {
      node.disconnect();
    },
  };
}
