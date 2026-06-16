// audio-engine — Layer-0 signal core (Web Audio only; takes plain numbers).
//
// Builds and owns the node graph for ONE binaural voice plus the `pulse`
// AudioWorklet modulator. It depends on no other project module: every entry point
// takes plain numbers (Hz, 0..1 gains, seconds), never a Preset/Node/ModPoint.
//
// See .dev/planning/modules/audio-engine/{design,interfaces,edge-cases}.md.

// The pulse worklet, bundled standalone (transpiled, import-free) by Vite and exposed
// as a URL for audioWorklet.addModule — works in dev, prod, and tests (where the URL
// is unused because addModule is mocked). See registerPulseWorklet.
import pulseWorkletUrl from './pulse-worklet.ts?worker&url';

// --- Types -----------------------------------------------------------------

/** Oscillator waveform. Identical to the built-in Web Audio OscillatorType. */
export type Waveform = OscillatorType; // 'sine' | 'square' | 'sawtooth' | 'triangle'

/** Lifecycle state of a Voice. One-way: idle → running → stopped. */
export type VoiceState = 'idle' | 'running' | 'stopped';

/** Options for createVoice. All optional; finite values clamp to range, non-finite throws. */
export interface VoiceOptions {
  waveform?: Waveform; // default 'sine'
  carrierHz?: number; // default 200, clamped 20..1000
  beatHz?: number; // default 4, clamped 0..35
  volume?: number; // default 1, clamped 0..1 (base volume on volumeGain)
  masterTrim?: number; // default 0.8, clamped 0..1 (ceiling; masterGain.gain still starts at 0)
}

/** Glide-warble (sine/triangle LFO) wiring options. */
export interface WarbleOptions {
  shape?: 'sine' | 'triangle'; // default 'sine'
  frequencyHz?: number; // warble rate = 1/periodSec; default 0; must be ≥ 0
  depth?: number; // initial depth in TARGET units (Hz for carrier/beat); default 0
  startTime?: number; // when the LFO oscillator starts; default ctx.currentTime
}

/** Pulse (AudioWorklet) instantiation options. */
export interface PulseOptions {
  frequencyHz?: number; // default 4, must be > 0
  depth?: number; // default 1, clamped 0..1
  dutyCycle?: number; // default 0.5, clamped 0..1
  edgeSec?: number; // default 0.005, must be ≥ 0 (per-edge raised-cosine duration)
}

/** Error code union for AudioEngineError.code. */
export type AudioEngineErrorCode =
  | 'INVALID_PARAMETER' // non-finite number, bad waveform, or bad context
  | 'WORKLET_NOT_REGISTERED' // createPulseNode before registerPulseWorklet(ctx) resolved
  | 'WORKLET_LOAD_FAILED' // addModule rejected (no AudioWorklet support / fetch error)
  | 'VOICE_ALREADY_STARTED' // start() called twice
  | 'VOICE_STOPPED'; // any operation after stop()

// --- Errors ----------------------------------------------------------------

export class AudioEngineError extends Error {
  readonly code: AudioEngineErrorCode;
  readonly cause?: unknown;

  constructor(code: AudioEngineErrorCode, message?: string, cause?: unknown) {
    super(message ?? code);
    this.name = 'AudioEngineError';
    this.code = code;
    this.cause = cause;
    // Restore the prototype chain so `instanceof AudioEngineError` works after
    // transpilation to ES2015+ targets.
    Object.setPrototypeOf(this, AudioEngineError.prototype);
  }
}

// --- Handles ---------------------------------------------------------------

export interface WarbleHandle {
  readonly osc: OscillatorNode; // the LFO; already started
  readonly frequencyParam: AudioParam; // = osc.frequency (warble rate, Hz, a-rate)
  readonly depthParam: AudioParam; // = depthGain.gain (depth in target units, a-rate)
  disconnect(): void; // stops the LFO and disconnects osc + depthGain
}

export interface PulseHandle {
  readonly node: AudioWorkletNode; // the "pulse" processor node
  readonly output: AudioNode; // = node; the 0..1 envelope signal
  readonly frequencyParam: AudioParam; // pulse rate, Hz, a-rate
  readonly depthParam: AudioParam; // 0..1, a-rate
  readonly dutyCycleParam: AudioParam; // 0..1, a-rate
  readonly edgeWidthParam: AudioParam; // seconds, a-rate
  disconnect(): void; // disconnects the node from all targets
}

// --- The Voice -------------------------------------------------------------

export interface Voice {
  readonly ctx: BaseAudioContext;
  readonly state: VoiceState;

  readonly carrierParam: AudioParam;
  readonly beatParam: AudioParam;
  readonly volumeParam: AudioParam;
  readonly modVolumeParam: AudioParam;
  readonly masterGainParam: AudioParam;
  readonly spatialParam: AudioParam; // spatialSource.offset, −1..1, drives the pan-gain pair (D-021)

  readonly output: AudioNode;

  setCarrier(hz: number, atTime?: number): void;
  setBeat(hz: number, atTime?: number): void;
  setVolume(v: number, atTime?: number): void;
  setMasterGain(v: number, atTime?: number): void;
  setBalance(pan: number, atTime?: number): void;
  setSpatial(pos: number, atTime?: number): void;
  setWaveform(w: Waveform): void;

  connectWarble(target: AudioParam, opts?: WarbleOptions): WarbleHandle;

  createPulseNode(opts?: PulseOptions): PulseHandle;

  attachVolumeModulator(source: AudioNode): void;
  detachVolumeModulator(): void;

  start(atTime?: number): void;
  stop(atTime?: number): void;
  dispose(): void;
}

// --- Constants (single source of truth, design §11) ------------------------

/** The processor name string, shared by addModule registration and the node ctor. */
export const PULSE_PROCESSOR_NAME = 'pulse';

const RAMP_SEC = 0.01; // 10 ms anti-click ramp (top of D-008's 5–10 ms window)
const OSC_INTRINSIC_FREQ = 0; // all frequency comes from the summed ConstantSources
const SPLIT_L = -0.5; // fL = carrier − beat/2 (D-004)
const SPLIT_R = 0.5; // fR = carrier + beat/2 (D-004)

const DEFAULT_CARRIER = 200;
const DEFAULT_BEAT = 4;
const DEFAULT_VOLUME = 1;
const DEFAULT_ENV = 1;
const DEFAULT_EAR_GAIN = 1;
const DEFAULT_MASTER = 0; // silent start so transport fades in click-free
const DEFAULT_TRIM = 0.8;

const CARRIER_MIN = 20;
const CARRIER_MAX = 1000;
const BEAT_MIN = 0;
const BEAT_MAX = 35;
const GAIN_MIN = 0;
const GAIN_MAX = 1;
const PAN_MIN = -1;
const PAN_MAX = 1;
const DEFAULT_SPATIAL = 0; // centered (no pan) at construction
const SPATIAL_FAR_EAR_FLOOR = 0.25; // far-ear floor (≈ −12 dB) at full pan (D-021 §2.7)
// Half-wave rectifier y = max(0, x): a 3-point curve linearly interpolated by a
// WaveShaper is exactly max(0, x) over the input domain [−1, 1] (design §2.7).
const HALF_WAVE_CURVE = new Float32Array([0, 0, 1]);

const PULSE_DEFAULT_FREQ = 4;
const PULSE_DEFAULT_DEPTH = 1;
const PULSE_DEFAULT_DUTY = 0.5;
const PULSE_DEFAULT_EDGE = 0.005;

const WAVEFORMS: ReadonlySet<string> = new Set([
  'sine',
  'square',
  'sawtooth',
  'triangle',
]);

// Tracks which contexts have had the pulse worklet module added (idempotency, F3).
const registeredContexts = new WeakSet<BaseAudioContext>();

// --- Helpers ---------------------------------------------------------------

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}

/** Reject non-finite numbers — writing NaN/±Inf to an AudioParam poisons the graph
 *  permanently (every later sample becomes NaN), so it is never clamped (A1). */
function ensureFinite(v: number, label: string): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    throw new AudioEngineError('INVALID_PARAMETER', `${label} must be a finite number`);
  }
  return v;
}

function ensureWaveform(w: Waveform): Waveform {
  if (!WAVEFORMS.has(w)) {
    throw new AudioEngineError('INVALID_PARAMETER', `unknown waveform: ${String(w)}`);
  }
  return w;
}

/** Resolve a finite option through clamping, or fall back to a default; a provided
 *  non-finite value throws INVALID_PARAMETER (A3). */
function resolveOption(
  value: number | undefined,
  fallback: number,
  min: number,
  max: number,
  label: string,
): number {
  if (value === undefined) return fallback;
  return clamp(ensureFinite(value, label), min, max);
}

type RetargetableParam = AudioParam & {
  cancelAndHoldAtTime?: (cancelTime: number) => void;
};

// --- Module-level functions ------------------------------------------------

export function createVoice(ctx: BaseAudioContext, options?: VoiceOptions): Voice {
  if (!ctx || typeof ctx.createOscillator !== 'function') {
    throw new AudioEngineError('INVALID_PARAMETER', 'a valid BaseAudioContext is required');
  }

  const waveform = ensureWaveform(options?.waveform ?? 'sine');
  const carrierHz = resolveOption(options?.carrierHz, DEFAULT_CARRIER, CARRIER_MIN, CARRIER_MAX, 'carrierHz');
  const beatHz = resolveOption(options?.beatHz, DEFAULT_BEAT, BEAT_MIN, BEAT_MAX, 'beatHz');
  const volume = resolveOption(options?.volume, DEFAULT_VOLUME, GAIN_MIN, GAIN_MAX, 'volume');
  let masterTrim = resolveOption(options?.masterTrim, DEFAULT_TRIM, GAIN_MIN, GAIN_MAX, 'masterTrim');

  // Sources: two oscillators driven entirely by summed ConstantSources (§2.3).
  const oscL = ctx.createOscillator();
  const oscR = ctx.createOscillator();
  const carrierSource = ctx.createConstantSource();
  const beatSource = ctx.createConstantSource();
  const splitL = ctx.createGain();
  const splitR = ctx.createGain();

  // Post-oscillator stereo + envelope chain.
  const gainL = ctx.createGain();
  const gainR = ctx.createGain();
  // Spatial pan (ILD, D-021 §2.7): a dedicated pan-gain pair driven by spatialSource
  // through half-wave shapers, so gainL/gainR keep their single-writer static-trim role.
  const panGainL = ctx.createGain();
  const panGainR = ctx.createGain();
  const spatialSource = ctx.createConstantSource();
  const shaperL = ctx.createWaveShaper();
  const shaperR = ctx.createWaveShaper();
  const negR = ctx.createGain(); // negates s so shaperR receives max(0, −s)
  const spatialAttenL = ctx.createGain();
  const spatialAttenR = ctx.createGain();
  const merger = ctx.createChannelMerger(2);
  const envGain = ctx.createGain(); // multiplicative modulator (modVolumeParam)
  const volumeGain = ctx.createGain(); // automated base volume (volumeParam)
  const masterGain = ctx.createGain(); // trim × transport fade (masterGainParam)

  // Intrinsic oscillator frequency is 0; the ConstantSources supply the whole value.
  oscL.frequency.value = OSC_INTRINSIC_FREQ;
  oscR.frequency.value = OSC_INTRINSIC_FREQ;
  oscL.type = waveform;
  oscR.type = waveform;

  carrierSource.offset.value = carrierHz;
  beatSource.offset.value = beatHz;
  splitL.gain.value = SPLIT_L;
  splitR.gain.value = SPLIT_R;
  gainL.gain.value = DEFAULT_EAR_GAIN;
  gainR.gain.value = DEFAULT_EAR_GAIN;
  panGainL.gain.value = DEFAULT_EAR_GAIN; // 1.0 = centered (no ILD)
  panGainR.gain.value = DEFAULT_EAR_GAIN;
  spatialSource.offset.value = DEFAULT_SPATIAL; // 0 = center
  shaperL.curve = HALF_WAVE_CURVE;
  shaperR.curve = HALF_WAVE_CURVE;
  negR.gain.value = -1;
  spatialAttenL.gain.value = -(1 - SPATIAL_FAR_EAR_FLOOR); // −0.75: far-ear attenuation
  spatialAttenR.gain.value = -(1 - SPATIAL_FAR_EAR_FLOOR);
  envGain.gain.value = DEFAULT_ENV;
  volumeGain.gain.value = volume;
  masterGain.gain.value = DEFAULT_MASTER;

  // Wire the frequency summing: carrier (+1) into both ears; beat through the
  // ∓0.5 split gains into each ear (§2.3). These are construction-time writes while
  // masterGain is 0 and no source has started — inaudible (no-click rule, §5).
  carrierSource.connect(oscL.frequency);
  carrierSource.connect(oscR.frequency);
  beatSource.connect(splitL);
  beatSource.connect(splitR);
  splitL.connect(oscL.frequency);
  splitR.connect(oscR.frequency);

  // Stereo placement via ChannelMerger(2): input 0 → left, input 1 → right (§2.1).
  // The spatial pan-gain pair sits between the static ear gains and the merger (§2.7).
  oscL.connect(gainL);
  oscR.connect(gainR);
  gainL.connect(panGainL);
  gainR.connect(panGainR);
  panGainL.connect(merger, 0, 0);
  panGainR.connect(merger, 0, 1);

  // Spatial ILD law (§2.7): panGainL = 1 − (1−F)·max(0, s), panGainR = 1 − (1−F)·max(0, −s),
  // with s = spatialSource.offset ∈ [−1, 1]. Half-wave shapers + a −(1−F) atten gain
  // summed into each pan gain's intrinsic 1.0 hold the near ear at unity and floor the
  // far ear, so loudness stays ~constant across the sweep and both ears stay audible
  // (the binaural beat survives the full pan). This is the authorized D-010 exception.
  spatialSource.connect(shaperL);
  shaperL.connect(spatialAttenL);
  spatialAttenL.connect(panGainL.gain);
  spatialSource.connect(negR);
  negR.connect(shaperR);
  shaperR.connect(spatialAttenR);
  spatialAttenR.connect(panGainR.gain);

  // Post-merge: envGain → volumeGain → masterGain → destination (§2.4).
  merger.connect(envGain);
  envGain.connect(volumeGain);
  volumeGain.connect(masterGain);
  masterGain.connect(ctx.destination);

  // --- Internal mutable state ---
  let state: VoiceState = 'idle';
  let started = false;
  let disposed = false;
  let attachedModulator: AudioNode | undefined;

  // JS-tracked last commanded value per param (E2: never anchor from param.value,
  // which can be stale on Firefox; we know our own ramp endpoints).
  let trackedCarrier = carrierHz;
  let trackedBeat = beatHz;
  let trackedVolume = volume;
  let trackedMaster = DEFAULT_MASTER;
  let trackedGainL = DEFAULT_EAR_GAIN;
  let trackedGainR = DEFAULT_EAR_GAIN;
  let trackedSpatial = DEFAULT_SPATIAL;
  let trackedEnv = DEFAULT_ENV;

  function assertLive(): void {
    if (state === 'stopped') {
      throw new AudioEngineError('VOICE_STOPPED', 'voice has been stopped');
    }
  }

  // No-click write: clear any prior schedule, anchor from the JS-tracked value, then
  // a 10 ms linear ramp to target (D1–D5). Feature-detect cancelAndHoldAtTime;
  // fall back to cancelScheduledValues for Firefox (E1). Linear only, never
  // exponential (D2) and never setValueCurveAtTime (E3).
  function rampTo(param: AudioParam, tracked: number, target: number, atTime?: number): void {
    const now = atTime ?? ctx.currentTime;
    const p = param as RetargetableParam;
    if (typeof p.cancelAndHoldAtTime === 'function') {
      p.cancelAndHoldAtTime(now);
    } else {
      param.cancelScheduledValues(now);
    }
    param.setValueAtTime(tracked, now);
    param.linearRampToValueAtTime(target, now + RAMP_SEC);
  }

  const voice: Voice = {
    ctx,
    get state() {
      return state;
    },

    carrierParam: carrierSource.offset,
    beatParam: beatSource.offset,
    volumeParam: volumeGain.gain,
    modVolumeParam: envGain.gain,
    masterGainParam: masterGain.gain,
    spatialParam: spatialSource.offset,

    output: masterGain,

    setCarrier(hz: number, atTime?: number): void {
      assertLive();
      const target = clamp(ensureFinite(hz, 'carrier'), CARRIER_MIN, CARRIER_MAX);
      rampTo(carrierSource.offset, trackedCarrier, target, atTime);
      trackedCarrier = target;
    },

    setBeat(hz: number, atTime?: number): void {
      assertLive();
      const target = clamp(ensureFinite(hz, 'beat'), BEAT_MIN, BEAT_MAX);
      rampTo(beatSource.offset, trackedBeat, target, atTime);
      trackedBeat = target;
    },

    setVolume(v: number, atTime?: number): void {
      assertLive();
      const target = clamp(ensureFinite(v, 'volume'), GAIN_MIN, GAIN_MAX);
      rampTo(volumeGain.gain, trackedVolume, target, atTime);
      trackedVolume = target;
    },

    setMasterGain(v: number, atTime?: number): void {
      assertLive();
      const target = clamp(ensureFinite(v, 'masterGain'), GAIN_MIN, GAIN_MAX);
      rampTo(masterGain.gain, trackedMaster, target, atTime);
      trackedMaster = target;
      masterTrim = target; // record the trim ceiling (§2.4)
    },

    setBalance(pan: number, atTime?: number): void {
      assertLive();
      const p = clamp(ensureFinite(pan, 'balance'), PAN_MIN, PAN_MAX);
      // Linear map: pan 0 → 1/1, −1 → 1/0, +1 → 0/1 (static trim only, §4).
      const gl = p <= 0 ? 1 : 1 - p;
      const gr = p >= 0 ? 1 : 1 + p;
      rampTo(gainL.gain, trackedGainL, gl, atTime);
      rampTo(gainR.gain, trackedGainR, gr, atTime);
      trackedGainL = gl;
      trackedGainR = gr;
    },

    setSpatial(pos: number, atTime?: number): void {
      assertLive();
      // Position −1 (full left) .. +1 (full right); the engine maps it to the
      // floored per-ear pan-gain pair (§2.7). Drives the schedulable spatialParam.
      const target = clamp(ensureFinite(pos, 'spatial'), PAN_MIN, PAN_MAX);
      rampTo(spatialSource.offset, trackedSpatial, target, atTime);
      trackedSpatial = target;
    },

    setWaveform(w: Waveform): void {
      assertLive();
      const wf = ensureWaveform(w);
      // No click-free way to morph oscillator type; set immediately, not ramped (D5).
      oscL.type = wf;
      oscR.type = wf;
    },

    connectWarble(target: AudioParam, opts?: WarbleOptions): WarbleHandle {
      assertLive();
      const osc = ctx.createOscillator();
      const depthGain = ctx.createGain();
      osc.type = opts?.shape ?? 'sine';
      // The engine does NOT bound the connected warble (A4/A5) — bounding so base ±
      // depth stays in (0, Nyquist) is automation's contract. Set values as given.
      osc.frequency.value = opts?.frequencyHz ?? 0;
      depthGain.gain.value = opts?.depth ?? 0;
      osc.connect(depthGain);
      depthGain.connect(target);
      osc.start(opts?.startTime ?? ctx.currentTime);
      return {
        osc,
        frequencyParam: osc.frequency,
        depthParam: depthGain.gain,
        disconnect(): void {
          osc.stop();
          osc.disconnect();
          depthGain.disconnect();
        },
      };
    },

    createPulseNode(opts?: PulseOptions): PulseHandle {
      assertLive();
      if (!registeredContexts.has(ctx)) {
        throw new AudioEngineError(
          'WORKLET_NOT_REGISTERED',
          'registerPulseWorklet(ctx) must resolve before createPulseNode',
        );
      }
      const node = new AudioWorkletNode(ctx, PULSE_PROCESSOR_NAME, {
        numberOfInputs: 0,
        numberOfOutputs: 1,
        outputChannelCount: [1],
      });
      const frequencyParam = node.parameters.get('frequency') as AudioParam;
      const depthParam = node.parameters.get('depth') as AudioParam;
      const dutyCycleParam = node.parameters.get('dutyCycle') as AudioParam;
      const edgeWidthParam = node.parameters.get('edgeWidth') as AudioParam;

      // frequency 0 is allowed (held DC, A7); depth/duty clamp 0..1; edge ≥ 0.
      frequencyParam.value = opts?.frequencyHz ?? PULSE_DEFAULT_FREQ;
      depthParam.value = clamp(opts?.depth ?? PULSE_DEFAULT_DEPTH, GAIN_MIN, GAIN_MAX);
      dutyCycleParam.value = clamp(opts?.dutyCycle ?? PULSE_DEFAULT_DUTY, GAIN_MIN, GAIN_MAX);
      edgeWidthParam.value = Math.max(0, opts?.edgeSec ?? PULSE_DEFAULT_EDGE);

      return {
        node,
        output: node,
        frequencyParam,
        depthParam,
        dutyCycleParam,
        edgeWidthParam,
        disconnect(): void {
          node.disconnect();
        },
      };
    },

    attachVolumeModulator(source: AudioNode): void {
      assertLive();
      // Replace-mode gate: ramp the param's intrinsic to 0 so only the connected
      // 0..1 envelope contributes the computed value (§8).
      rampTo(envGain.gain, trackedEnv, 0);
      trackedEnv = 0;
      source.connect(envGain.gain);
      attachedModulator = source;
    },

    detachVolumeModulator(): void {
      assertLive();
      if (attachedModulator) {
        attachedModulator.disconnect(envGain.gain);
        attachedModulator = undefined;
      }
      rampTo(envGain.gain, trackedEnv, DEFAULT_ENV);
      trackedEnv = DEFAULT_ENV;
    },

    start(atTime?: number): void {
      if (state === 'stopped') {
        throw new AudioEngineError('VOICE_STOPPED', 'voice has been stopped');
      }
      if (state === 'running') {
        // Oscillator/ConstantSource are one-shot; they cannot be restarted (B1).
        throw new AudioEngineError('VOICE_ALREADY_STARTED', 'voice already started');
      }
      // One shared t0 for all five sources. Never inspects/changes ctx.state — a
      // suspended context schedules silently and is correct (B3/C1).
      const t0 = atTime ?? ctx.currentTime;
      oscL.start(t0);
      oscR.start(t0);
      carrierSource.start(t0);
      beatSource.start(t0);
      spatialSource.start(t0);
      started = true;
      state = 'running';
    },

    stop(atTime?: number): void {
      if (state === 'stopped') return; // terminal; second stop is a no-op
      // Pass the time through unchanged — a past time means "now" per Web Audio (B5).
      const t = atTime ?? ctx.currentTime;
      if (started) {
        oscL.stop(t);
        oscR.stop(t);
        carrierSource.stop(t);
        beatSource.stop(t);
        spatialSource.stop(t);
      }
      state = 'stopped';
    },

    dispose(): void {
      if (disposed) return; // idempotent (B4)
      for (const node of [
        oscL,
        oscR,
        carrierSource,
        beatSource,
        splitL,
        splitR,
        gainL,
        gainR,
        panGainL,
        panGainR,
        spatialSource,
        shaperL,
        shaperR,
        negR,
        spatialAttenL,
        spatialAttenR,
        merger,
        envGain,
        volumeGain,
        masterGain,
      ]) {
        node.disconnect();
      }
      disposed = true;
    },
  };

  // masterTrim is recorded internal state (the trim ceiling transport fades up to);
  // masterGain.gain itself stays 0 at construction (§2.4). Referenced here to keep
  // the binding live for setMasterGain without exposing extra public surface.
  void masterTrim;

  return voice;
}

export function registerPulseWorklet(
  ctx: BaseAudioContext,
  moduleUrl?: string,
): Promise<void> {
  // Second registration for the same context is a no-op resolving immediately (F3).
  if (registeredContexts.has(ctx)) return Promise.resolve();

  const url = moduleUrl ?? pulseWorkletUrl;
  return ctx.audioWorklet.addModule(url).then(
    () => {
      registeredContexts.add(ctx);
    },
    (err: unknown) => {
      throw new AudioEngineError('WORKLET_LOAD_FAILED', 'audioWorklet.addModule failed', err);
    },
  );
}
