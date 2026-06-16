// pulse-worklet — the `pulse` AudioWorkletProcessor (variable-duty, raised-cosine
// isochronic modulator). Runs in the AudioWorkletGlobalScope at runtime; bundled as
// a separate module and registered by registerPulseWorklet (audio-engine.ts).
//
// Native `square` is locked to 50% duty and clicks at its edges. This processor
// gives a variable duty cycle and C1-continuous raised-cosine edges under one
// persistent phase accumulator (design.md §7.3).

// --- Ambient AudioWorkletGlobalScope declarations --------------------------
// These globals are NOT in the DOM lib. They are declared locally here (this file
// is a module thanks to the `export` below) so the worklet typechecks without
// polluting the DOM lib. This file is SELF-CONTAINED (no imports): it is bundled
// standalone via `?worker&url` and runs in the isolated AudioWorkletGlobalScope,
// which has no module resolution.

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

// Extend the real base class in the worklet; fall back to a plain class when the
// global is absent (e.g. when this file is imported under jsdom for unit tests).
// The `typeof` guard never throws on an undeclared identifier, and the truthy
// branch is not evaluated when the global is undefined.
const ProcessorBase: AudioWorkletProcessorCtor =
  typeof AudioWorkletProcessor !== 'undefined'
    ? AudioWorkletProcessor
    : (class {} as unknown as AudioWorkletProcessorCtor);

const EDGE_CLAMP = 0.999; // keeps each raised-cosine edge strictly inside its plateau

/** Raised-cosine weight: rcos(0)=0, rcos(1)=1, C1-continuous (click-free). */
function rcos(x: number): number {
  return 0.5 * (1 - Math.cos(Math.PI * x));
}

export class PulseProcessor extends ProcessorBase {
  // Persistent phase accumulator in CYCLES [0, 1), held across process() calls so
  // continuity is independent of any frequency/depth/duty/edge change (D-014).
  private phase = 0;

  static get parameterDescriptors(): AudioParamDescriptor[] {
    return [
      { name: 'frequency', defaultValue: 4, minValue: 0, maxValue: 20000, automationRate: 'a-rate' },
      { name: 'depth', defaultValue: 1, minValue: 0, maxValue: 1, automationRate: 'a-rate' },
      { name: 'dutyCycle', defaultValue: 0.5, minValue: 0, maxValue: 1, automationRate: 'a-rate' },
      { name: 'edgeWidth', defaultValue: 0.005, minValue: 0, maxValue: 1, automationRate: 'a-rate' },
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

    const freqArr = parameters.frequency;
    const depthArr = parameters.depth;
    const dutyArr = parameters.dutyCycle;
    const edgeArr = parameters.edgeWidth;

    let phase = this.phase;

    for (let i = 0; i < n; i++) {
      // a-rate pattern: length-1 array is constant for the block, else index i (F7).
      const frequency = freqArr.length === 1 ? freqArr[0] : freqArr[i];
      const depth = depthArr.length === 1 ? depthArr[0] : depthArr[i];
      const dutyCycle = dutyArr.length === 1 ? dutyArr[0] : dutyArr[i];
      const edgeWidth = edgeArr.length === 1 ? edgeArr[0] : edgeArr[i];

      const low = 1 - depth;
      const high = 1;

      let out: number;
      if (frequency <= 0) {
        // Zero rate → phase never advances; held DC at the low (off) level (A7).
        out = low;
      } else {
        // Edge fraction in cycles, clamped so each edge fits inside its plateau and
        // the rising/falling edges never overlap (A6). e == 0 → hard step.
        let e = edgeWidth * frequency;
        const maxRise = dutyCycle * EDGE_CLAMP;
        const maxFall = (1 - dutyCycle) * EDGE_CLAMP;
        if (e > maxRise) e = maxRise;
        if (e > maxFall) e = maxFall;
        if (e < 0) e = 0;

        const p = phase;
        if (e > 0 && p < e) {
          out = low + (high - low) * rcos(p / e); // rising edge
        } else if (p < dutyCycle) {
          out = high; // high plateau
        } else if (e > 0 && p < dutyCycle + e) {
          out = high - (high - low) * rcos((p - dutyCycle) / e); // falling edge
        } else {
          out = low; // low plateau
        }
      }

      channel[i] = out;

      // Advance phase in cycles and wrap to [0, 1).
      phase += frequency / sr;
      phase -= Math.floor(phase);
    }

    this.phase = phase;
    return true; // keep the processor alive indefinitely (continuous source)
  }
}

// Register at module load in the worklet scope. Guarded so importing this file under
// jsdom (for unit tests, where registerProcessor is absent) does not throw.
// The name literal 'pulse' MUST match PULSE_PROCESSOR_NAME in audio-engine.ts (the
// node ctor uses the same string); the worklet stays import-free to bundle standalone.
if (typeof registerProcessor === 'function') {
  registerProcessor('pulse', PulseProcessor);
}
