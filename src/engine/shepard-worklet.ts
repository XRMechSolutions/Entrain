// shepard-worklet — the `shepard` AudioWorkletProcessor (a Shepard–Risset glissando:
// the endless rising/falling auditory illusion). Runs in the AudioWorkletGlobalScope at
// runtime; bundled as a separate import-free module and registered by
// registerShepardWorklet (shepard.ts).
//
// N octave-spaced sine partials sweep continuously through the spectrum under one global
// position `p` (in octaves). Each partial's amplitude follows a fixed raised-cosine BELL
// over its octave position, peaking in the middle octave and ≈0 at the top and bottom
// seams — so as a partial wraps from the highest octave back to the lowest its level is
// ~0 at the crossover (no click; this is what makes the rise seamless and endless).

// --- Ambient AudioWorkletGlobalScope declarations --------------------------
// NOT in the DOM lib — declared locally so the worklet typechecks without polluting it.
// This file is SELF-CONTAINED (no imports): it is bundled standalone via `?worker&url`
// and runs in the isolated AudioWorkletGlobalScope, which has no module resolution.

interface AudioWorkletProcessorImpl {
  readonly port: MessagePort;
}
type AudioWorkletProcessorCtor = new (options?: unknown) => AudioWorkletProcessorImpl;

declare const AudioWorkletProcessor: AudioWorkletProcessorCtor;
declare function registerProcessor(name: string, processorCtor: unknown): void;
declare const sampleRate: number;

// AudioWorklet-scope param descriptor (not in lib.dom.d.ts; AutomationRate is).
interface AudioParamDescriptor {
  name: string;
  automationRate?: AutomationRate;
  defaultValue?: number;
  minValue?: number;
  maxValue?: number;
}

// Extend the real base class in the worklet; fall back to a plain class when the global
// is absent (e.g. when this file is imported under jsdom for unit tests). The `typeof`
// guard never throws on an undeclared identifier.
const ProcessorBase: AudioWorkletProcessorCtor =
  typeof AudioWorkletProcessor !== 'undefined'
    ? AudioWorkletProcessor
    : (class {} as unknown as AudioWorkletProcessorCtor);

const TWO_PI = Math.PI * 2;

/** Number of octave-spaced partials. The spectrum spans F_BASE..F_BASE·2^N. */
export const SHEPARD_PARTIALS = 8;

/** Lowest partial frequency (Hz). With N=8 the partials span ~27.5 Hz .. ~7040 Hz, so a
 *  wrapping partial fades out near the top of hearing and fades back in near the bottom. */
export const SHEPARD_F_BASE = 27.5;

/** Euclidean modulo: always in [0, m) for any sign of a. */
function emod(a: number, m: number): number {
  return ((a % m) + m) % m;
}

/** Octave position of partial i at global position p, wrapped into [0, N). */
export function shepardOctave(i: number, p: number): number {
  return emod(i + p, SHEPARD_PARTIALS);
}

/** Frequency (Hz) of partial i at position p: F_BASE·2^octave (octave-spaced). */
export function shepardPartialFrequency(i: number, p: number): number {
  return SHEPARD_F_BASE * Math.pow(2, shepardOctave(i, p));
}

/** Raised-cosine (Hann) spectral bell over the octave span x=octave/N ∈ [0,1):
 *  0 at the seams (x=0 and x=1), peaking at the middle octave (x=0.5). The ~0 at the
 *  wrap seam is what makes the endless glissando click-free. */
export function shepardPartialBell(i: number, p: number): number {
  const x = shepardOctave(i, p) / SHEPARD_PARTIALS;
  return 0.5 * (1 - Math.cos(TWO_PI * x));
}

export class ShepardProcessor extends ProcessorBase {
  // Global glissando position in OCTAVES, held across process() calls so continuity is
  // independent of any speed change. Wrapped into [0, N).
  private pos = 0;
  // Per-partial sine phase accumulators in CYCLES [0, 1), advanced by f_i/sampleRate each
  // sample so each partial stays phase-continuous as its frequency glides.
  private readonly phases = new Float32Array(SHEPARD_PARTIALS);

  /** Current glissando position in octaves (read-only; for assertions/diagnostics). */
  get position(): number {
    return this.pos;
  }

  static get parameterDescriptors(): AudioParamDescriptor[] {
    return [
      // SIGNED octaves/sec: + ascends (rising/lift), − descends (return).
      { name: 'speed', defaultValue: 0.25, minValue: -8, maxValue: 8, automationRate: 'a-rate' },
      { name: 'gain', defaultValue: 0.5, minValue: 0, maxValue: 1, automationRate: 'a-rate' },
    ];
  }

  process(
    _inputs: Float32Array[][],
    outputs: Float32Array[][],
    parameters: Record<string, Float32Array>,
  ): boolean {
    const output = outputs[0];
    if (!output || output.length === 0) return true;
    const channel = output[0];
    const n = channel.length; // read the length every call; never hardcode 128 (F4)
    const sr = sampleRate; // read global each block; never assume 44100/48000 (F5)

    const speedArr = parameters.speed;
    const gainArr = parameters.gain;
    const phases = this.phases;
    let p = this.pos;

    for (let s = 0; s < n; s++) {
      // a-rate pattern: length-1 array is constant for the block, else index s.
      const speed = speedArr.length === 1 ? speedArr[0] : speedArr[s];
      const gain = gainArr.length === 1 ? gainArr[0] : gainArr[s];

      let acc = 0; // Σ bell_i · sin(2π·phase_i)
      let norm = 0; // Σ bell_i  (== N/2 analytically; computed for a robust ≤1 bound)
      for (let i = 0; i < SHEPARD_PARTIALS; i++) {
        const bell = shepardPartialBell(i, p);
        const freq = shepardPartialFrequency(i, p);
        let ph = phases[i] + freq / sr;
        ph -= Math.floor(ph); // wrap to [0, 1)
        phases[i] = ph;
        acc += bell * Math.sin(TWO_PI * ph);
        norm += bell;
      }

      // Normalize so peak |signal| ≤ 1, then scale by the user gain (0..1).
      channel[s] = norm > 0 ? (acc / norm) * gain : 0;

      // Advance the glissando: SIGNED octaves/sec. + rises, − falls. Wrap so a partial
      // re-enters at the opposite seam (where its bell is ~0 — seamless and endless).
      p += speed / sr;
      p = emod(p, SHEPARD_PARTIALS);
    }

    this.pos = p;
    return true; // keep the processor alive indefinitely (continuous source)
  }
}

// Register at module load in the worklet scope. Guarded so importing this file under
// jsdom (for unit tests, where registerProcessor is absent) does not throw. The name
// literal 'shepard' MUST match SHEPARD_PROCESSOR_NAME in shepard.ts (the node ctor uses
// the same string); the worklet stays import-free to bundle standalone.
if (typeof registerProcessor === 'function') {
  registerProcessor('shepard', ShepardProcessor);
}
