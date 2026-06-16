// automation — Layer-1 timeline evaluator (Web Audio scheduling, no validation).
//
// Turns a validated `Preset` into either a pure value-at-time `t` (UI preview and the
// re-target anchor) or live audio (scheduling each lane's base curve plus the
// warble/pulse modulator onto a real `audio-engine` `Voice`, guaranteeing continuous
// modulator phase). Depends down only on `session-model` (types + DEFAULTS/RANGES) and
// `audio-engine` (the `Voice` surface + `AudioEngineError`). Never re-validates a
// preset; trusts it is structurally valid.
//
// See .dev/planning/modules/automation/{design,interfaces,edge-cases}.md.

import type {
  Preset,
  ParamPoint,
  ModPoint,
  AutomatableParam,
  Waveform,
  ModShape,
  ModTransition,
  ParamTransition,
} from './session-model';
import { DEFAULTS } from './session-model';
import type { Voice, WarbleHandle, PulseHandle } from './audio-engine';
import { AudioEngineError } from './audio-engine';

// ---------------------------------------------------------------------------
// 1. Constants (single source of truth, design §11)
// ---------------------------------------------------------------------------

/** ~4 linear segments/sec — smooth to eye and ear for slow envelopes (design §3.2). */
export const SMOOTH_SEGMENT_SEC = 0.25;
/** A short `smooth` ramp still bends, not a single line. */
export const SMOOTH_MIN_SEGMENTS = 4;
/** Bounds scheduling cost on a multi-hour ramp. */
export const SMOOTH_MAX_SEGMENTS = 256;
/** Top of D-008's 5–10 ms anti-click window; volume steps/jumps only (design §3.3). */
export const VOLUME_MICRORAMP_SEC = 0.01;
/** Re-target slightly in the future so no event is scheduled in the past (design §9). */
export const RETARGET_LOOKAHEAD_SEC = 0.02;
/** Min instantaneous warble frequency; keeps the offset param > 0 (design §8.5). */
export const FREQ_FLOOR_HZ = 1;
/** Safe sub-Nyquist ceiling, far above the 1000 Hz carrier max (design §8.5). */
export const FREQ_CEIL_HZ = 20000;

/** Hard ceiling on `jump`/`steps` cycle boundaries scheduled per span (bounds cost on a
 *  pathological short-period × long-span; beyond it the last held value persists). */
const MAX_STEP_BOUNDARIES = 8192;

// ---------------------------------------------------------------------------
// 2. Error type
// ---------------------------------------------------------------------------

export type AutomationErrorCode =
  | 'INVALID_TIME' // a non-finite t/time passed to a pure function or schedule option
  | 'INVALID_PARAM' // param not in {'carrier','beat','volume','spatial'}
  | 'INVALID_PRESET'; // preset is null / not an object (defensive)

export class AutomationError extends Error {
  readonly name = 'AutomationError';
  readonly code: AutomationErrorCode;

  constructor(code: AutomationErrorCode, message?: string) {
    super(message ?? code);
    this.code = code;
    // Restore the prototype chain so `instanceof AutomationError` survives transpilation.
    Object.setPrototypeOf(this, AutomationError.prototype);
  }
}

// ---------------------------------------------------------------------------
// 3. Small numeric helpers
// ---------------------------------------------------------------------------

const PARAMS: readonly AutomatableParam[] = ['carrier', 'beat', 'volume', 'spatial'];

function clampRange(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}

function lerp(a: number, b: number, f: number): number {
  return a + (b - a) * f;
}

function smoothstep(f: number): number {
  return f * f * (3 - 2 * f);
}

/** An `exp` ramp is only valid for finite, non-zero, same-sign endpoints (design §3.1). */
function expValid(a: number, b: number): boolean {
  return (
    Number.isFinite(a) &&
    Number.isFinite(b) &&
    a !== 0 &&
    b !== 0 &&
    Math.sign(a) === Math.sign(b)
  );
}

/** Clamp a frequency-warble depth so `base ± depth` stays in [FREQ_FLOOR, FREQ_CEIL]
 *  (design §8.5). Frequency params have no protective clamp, so automation bounds it. */
function clampFreqDepth(depth: number, base: number): number {
  return Math.max(0, Math.min(depth, base - FREQ_FLOOR_HZ, FREQ_CEIL_HZ - base));
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

function display(v: unknown): string {
  if (typeof v === 'number') return String(v);
  if (typeof v === 'string') return JSON.stringify(v);
  if (v === null) return 'null';
  if (v === undefined) return 'undefined';
  return Object.prototype.toString.call(v);
}

// ---------------------------------------------------------------------------
// 4. Input guards (the throwing entry-point contract, design §7 / edge-cases A)
// ---------------------------------------------------------------------------

function assertPreset(preset: unknown): asserts preset is Preset {
  if (preset === null || typeof preset !== 'object') {
    throw new AutomationError('INVALID_PRESET', `preset must be a non-null object, got ${display(preset)}`);
  }
}

function assertParam(param: unknown): asserts param is AutomatableParam {
  if (param !== 'carrier' && param !== 'beat' && param !== 'volume' && param !== 'spatial') {
    throw new AutomationError('INVALID_PARAM', `param must be one of carrier, beat, volume, spatial, got ${display(param)}`);
  }
}

function assertFiniteTime(t: unknown, label: string): asserts t is number {
  if (!isFiniteNumber(t)) {
    throw new AutomationError('INVALID_TIME', `${label} must be finite, got ${display(t)}`);
  }
}

function clampTime(t: number, durationSec: number): number {
  return Math.min(Math.max(t, 0), durationSec);
}

// ---------------------------------------------------------------------------
// 5. Lane keyframes & base curve (carry-forward + transitions, design §2–3)
// ---------------------------------------------------------------------------

interface Keyframe {
  t: number;
  point: ParamPoint;
}

/** The keyframes for one lane: nodes that set `node[param]`. Already sorted ascending
 *  with unique `t` by `session-model`; this module never sorts. */
function laneKeyframes(preset: Preset, param: AutomatableParam): Keyframe[] {
  const out: Keyframe[] = [];
  for (const node of preset.nodes) {
    const pp = node[param];
    if (pp) out.push({ t: node.t, point: pp });
  }
  return out;
}

function laneDefault(param: AutomatableParam): number {
  // beat → 0, volume → 1, spatial → 0 (DEFAULTS). Carrier always has a keyframe at t=0
  // (session-model CARRIER_NOT_AT_START), so its branch is unreachable.
  if (param === 'beat') return DEFAULTS.beat;
  if (param === 'volume') return DEFAULTS.volume;
  if (param === 'spatial') return DEFAULTS.spatial;
  return 0;
}

function baseTransition(a: number, b: number, frac: number, transition: ParamTransition): number {
  switch (transition) {
    case 'hold':
      return a;
    case 'smooth':
      return a + (b - a) * smoothstep(frac);
    case 'exp':
      return expValid(a, b) ? a * Math.pow(b / a, frac) : lerp(a, b, frac);
    case 'linear':
    default:
      return lerp(a, b, frac);
  }
}

/** The base curve value for one lane at an already-clamped preset time. */
function baseCore(preset: Preset, param: AutomatableParam, t: number): number {
  const kf = laneKeyframes(preset, param);
  if (kf.length === 0) return laneDefault(param);
  if (t <= kf[0].t) return kf[0].point.value;
  const last = kf[kf.length - 1];
  if (t >= last.t) return last.point.value;

  for (let i = 0; i + 1 < kf.length; i++) {
    const ti = kf[i].t;
    const tj = kf[i + 1].t;
    if (t >= ti && t < tj) {
      const a = kf[i].point.value;
      const b = kf[i + 1].point.value;
      const frac = (t - ti) / (tj - ti);
      const transition = kf[i].point.transition ?? DEFAULTS.paramTransition;
      return baseTransition(a, b, frac, transition);
    }
  }
  return last.point.value; // unreachable (t is within [t0, tm))
}

// ---------------------------------------------------------------------------
// 6. Modulator resolution, fields, phase, shapes (design §5–6)
// ---------------------------------------------------------------------------

interface ResolvedModKey {
  t: number;
  shape: ModShape;
  frequency: number; // = 1/periodSec (Hz)
  depth: number;
  pulseWidth: number;
  edgeSec: number;
  transition: ModTransition;
  steps: number[] | undefined;
}

interface ModSpan {
  startT: number;
  endT: number; // exclusive clear/shape-change boundary, or durationSec for an open span
  open: boolean; // active to the end of the timeline (and beyond)
  shape: ModShape;
  keys: ResolvedModKey[]; // ≥ 1, same shape, phase-continuous
}

/** Realise one object `ModPoint` at eval time. `periodSec` is required for a rate; a
 *  point without it is inactive (design §5.2 / edge-case B5) → `null`. */
function resolveModPoint(t: number, mod: ModPoint): ResolvedModKey | null {
  if (mod.periodSec === undefined) return null;
  return {
    t,
    shape: mod.shape ?? DEFAULTS.modShape,
    frequency: 1 / mod.periodSec,
    depth: mod.depth ?? 0,
    pulseWidth: mod.pulseWidth ?? 0.5,
    edgeSec: (mod.edgeMs ?? 0) / 1000,
    transition: mod.transition ?? DEFAULTS.modTransition,
    steps: mod.steps,
  };
}

/** Resolve the active-modulator timeline into phase-continuous spans (design §5.1–5.2).
 *  An object key with a different shape, a `null` clear, or a period-less (inactive)
 *  key ends the current span; absent-`mod` keyframes are transparent (carry through). */
function resolveSpans(preset: Preset, param: AutomatableParam): ModSpan[] {
  const kf = laneKeyframes(preset, param);
  const spans: ModSpan[] = [];
  let current: ModSpan | null = null;

  const close = (endT: number): void => {
    if (current) {
      current.endT = endT;
      current.open = false;
      spans.push(current);
      current = null;
    }
  };

  for (const k of kf) {
    const mod = k.point.mod;
    if (mod === undefined) continue; // absent → carry (transparent to the mod timeline)
    if (mod === null) {
      close(k.t); // explicit clear
      continue;
    }
    const r = resolveModPoint(k.t, mod);
    if (r === null) {
      close(k.t); // inactive (no period) — behaves like a clear
      continue;
    }
    if (current && current.shape === r.shape) {
      current.keys.push(r);
    } else {
      close(k.t); // shape change (or first object key) starts a fresh span
      current = { startT: k.t, endT: preset.durationSec, open: true, shape: r.shape, keys: [r] };
    }
  }
  if (current) spans.push(current);
  return spans;
}

function activeSpanAt(spans: ModSpan[], t: number): ModSpan | null {
  for (const s of spans) {
    if (t >= s.startT && (s.open || t < s.endT)) return s;
  }
  return null;
}

interface InterpolatedFields {
  frequency: number;
  depth: number;
  pulseWidth: number;
  edgeSec: number;
  transition: ModTransition;
  steps: number[] | undefined;
}

/** Linearly interpolate the numeric fields across the active span's keys; discrete
 *  fields (transition, steps) take the earlier key's value for the sub-interval. */
function interpolateFields(span: ModSpan, t: number): InterpolatedFields {
  const keys = span.keys;
  let i = 0;
  while (i + 1 < keys.length && t >= keys[i + 1].t) i++;
  const left = keys[i];
  if (i + 1 >= keys.length) {
    return {
      frequency: left.frequency,
      depth: left.depth,
      pulseWidth: left.pulseWidth,
      edgeSec: left.edgeSec,
      transition: left.transition,
      steps: left.steps,
    };
  }
  const right = keys[i + 1];
  const f = (t - left.t) / (right.t - left.t);
  return {
    frequency: lerp(left.frequency, right.frequency, f),
    depth: lerp(left.depth, right.depth, f),
    pulseWidth: lerp(left.pulseWidth, right.pulseWidth, f),
    edgeSec: lerp(left.edgeSec, right.edgeSec, f),
    transition: left.transition,
    steps: left.steps,
  };
}

/** Analytic continuous phase (cycles) at time `t` within a span: the time-integral of
 *  the piecewise-linearly-ramped frequency, starting at 0 at the span start, i.e.
 *  Δphase = fi·Δt + 0.5·slope·Δt² per sub-interval (design §5.4). */
function phaseAt(span: ModSpan, t: number): number {
  const keys = span.keys;
  let phase = 0;
  for (let i = 0; i < keys.length; i++) {
    const ti = keys[i].t;
    const fi = keys[i].frequency;
    const hasNext = i + 1 < keys.length;
    const tNext = hasNext ? keys[i + 1].t : Infinity;
    const fNext = hasNext ? keys[i + 1].frequency : fi;
    if (t >= tNext) {
      const dT = tNext - ti;
      const slope = (fNext - fi) / dT;
      phase += fi * dT + 0.5 * slope * dT * dT;
    } else {
      const dt = t - ti;
      const slope = hasNext ? (fNext - fi) / (tNext - ti) : 0;
      phase += fi * dt + 0.5 * slope * dt * dt;
      break;
    }
  }
  return phase;
}

function rcos(x: number): number {
  return 0.5 * (1 - Math.cos(Math.PI * x));
}

/** Raised-cosine gate (square/pulse), identical to audio-engine §7.3 (design §5.3). */
function gate(p: number, duty: number, edgeFrac: number): number {
  let e = edgeFrac;
  if (e <= 0) return p < duty ? 1 : 0;
  e = Math.min(e, duty * 0.999, (1 - duty) * 0.999);
  if (e <= 0) return p < duty ? 1 : 0;
  if (p < e) return rcos(p / e);
  if (p < duty) return 1;
  if (p < duty + e) return 1 - rcos((p - duty) / e);
  return 0;
}

/** Symmetric breath trapezoid in [-1,+1] for the `box` shape (design: BOX / TRAPEZOID).
 *  `holdRatio` h ∈ [0,1] splits each cycle into ramp fraction r = (1−h)/2 and hold
 *  fraction d = h/2 per side: −1 →(inhale ramp r)→ +1 →(hold d)→ +1 →(exhale ramp r)→
 *  −1 →(hold d)→ −1. h=0 is a pure triangle sweep; h=0.5 the even 4-4-4-4 box; h=1 a
 *  square (no ramps). Phase fraction `p` ∈ [0,1). */
function boxUnit(p: number, holdRatio: number): number {
  const h = clampRange(holdRatio, 0, 1);
  const rampFrac = (1 - h) / 2;
  const holdFrac = h / 2;
  if (rampFrac <= 0) return p < 0.5 ? 1 : -1; // h=1 → square: +1 first half, −1 second
  if (p < rampFrac) return -1 + 2 * (p / rampFrac); // inhale −1 → +1
  if (p < rampFrac + holdFrac) return 1; // hold at +1 (inhale-hold)
  if (p < 2 * rampFrac + holdFrac) return 1 - 2 * ((p - rampFrac - holdFrac) / rampFrac); // exhale +1 → −1
  return -1; // hold at −1 (exhale-hold)
}

/** The unit shape value in [-1,1] (sine/triangle/box) or [0,1] (square/pulse) at phase φ. */
function shapeUnit(
  shape: ModShape,
  phase: number,
  pulseWidth: number,
  edgeSec: number,
  frequency: number,
): number {
  const p = phase - Math.floor(phase);
  switch (shape) {
    case 'sine':
      return Math.sin(2 * Math.PI * p);
    case 'triangle':
      return p < 0.25 ? 4 * p : p < 0.75 ? 2 - 4 * p : 4 * p - 4;
    case 'square':
      return gate(p, pulseWidth, 0); // hard edges
    case 'pulse':
      return gate(p, pulseWidth, edgeSec * frequency);
    case 'box':
      return boxUnit(p, pulseWidth); // pulseWidth carries the hold ratio for box
  }
}

/** The instantaneous modulator value: additive Hz (carrier/beat) or multiplier
 *  (volume). When `clamp` is true the same safety clamps the scheduler applies are
 *  applied (design §7/§8.5), against `base` (the lane's base value at `t`). */
function evalModulator(
  param: AutomatableParam,
  span: ModSpan,
  t: number,
  clamp: boolean,
  base: number,
): number {
  const fields = interpolateFields(span, t);
  const phase = phaseAt(span, t);
  // `box` drives its own trapezoid trajectory; it never sample-and-holds a steps[] list.
  const jumpSteps =
    span.shape !== 'box' && fields.transition === 'jump' && fields.steps && fields.steps.length > 0;

  if (param === 'volume') {
    if (jumpSteps) {
      const steps = fields.steps as number[];
      const k = Math.floor(phase);
      const m = steps[((k % steps.length) + steps.length) % steps.length];
      return clamp ? clampRange(m, 0, 1) : m;
    }
    const depth = clamp ? clampRange(fields.depth, 0, 1) : fields.depth;
    const u = shapeUnit(span.shape, phase, fields.pulseWidth, fields.edgeSec, fields.frequency);
    if (span.shape === 'sine' || span.shape === 'triangle') return 1 + depth * u;
    // box rides bipolar u∈[−1,1] mapped to [1−depth, 1]; pulse/square gate u∈[0,1] → [1−depth, 1].
    if (span.shape === 'box') return 1 - depth + depth * ((u + 1) / 2);
    return 1 - depth + depth * u;
  }

  // carrier / beat / spatial — additive offset (Hz for freq lanes; position for spatial).
  if (jumpSteps) {
    const steps = fields.steps as number[];
    const k = Math.floor(phase);
    const off = steps[((k % steps.length) + steps.length) % steps.length];
    if (!clamp) return off;
    return param === 'spatial'
      ? clampRange(off, -1 - base, 1 - base) // keep base + off within the [-1,1] pan range
      : clampRange(off, FREQ_FLOOR_HZ - base, FREQ_CEIL_HZ - base);
  }
  const depth = clamp ? resolveModDepth(param, fields.depth, base) : fields.depth;
  const u = shapeUnit(span.shape, phase, fields.pulseWidth, fields.edgeSec, fields.frequency);
  return depth * u; // bipolar (sine/triangle) or unipolar [0, depth] (square/pulse gate)
}

// ---------------------------------------------------------------------------
// 7. Pure evaluation surface (interfaces §2)
// ---------------------------------------------------------------------------

export function baseValueAt(preset: Preset, param: AutomatableParam, t: number): number {
  assertPreset(preset);
  assertParam(param);
  assertFiniteTime(t, 't');
  return baseCore(preset, param, clampTime(t, preset.durationSec));
}

export function modulatorAt(preset: Preset, param: AutomatableParam, t: number): number {
  assertPreset(preset);
  assertParam(param);
  assertFiniteTime(t, 't');
  const ct = clampTime(t, preset.durationSec);
  const span = activeSpanAt(resolveSpans(preset, param), ct);
  if (!span) return param === 'volume' ? 1 : 0;
  return evalModulator(param, span, ct, false, 0);
}

export function valueAt(preset: Preset, param: AutomatableParam, t: number): number {
  assertPreset(preset);
  assertParam(param);
  assertFiniteTime(t, 't');
  const ct = clampTime(t, preset.durationSec);
  const base = baseCore(preset, param, ct);
  const span = activeSpanAt(resolveSpans(preset, param), ct);
  const mod = span ? evalModulator(param, span, ct, true, base) : param === 'volume' ? 1 : 0;
  if (param === 'volume') return base * mod;
  const sum = base + mod;
  // Spatial saturates at the engine's pan limits; clamp the preview to match playback.
  return param === 'spatial' ? clampRange(sum, -1, 1) : sum;
}

export function waveformAt(preset: Preset, t: number): Waveform {
  assertPreset(preset);
  assertFiniteTime(t, 't');
  const ct = clampTime(t, preset.durationSec);
  let wf: Waveform = DEFAULTS.waveform;
  for (const node of preset.nodes) {
    if (node.t > ct) break;
    if (node.waveform !== undefined) wf = node.waveform;
  }
  return wf;
}

export function waveformKeyframes(
  preset: Preset,
): ReadonlyArray<{ t: number; waveform: Waveform }> {
  assertPreset(preset);
  const out: { t: number; waveform: Waveform }[] = [{ t: 0, waveform: DEFAULTS.waveform }];
  let cur: Waveform = DEFAULTS.waveform;
  for (const node of preset.nodes) {
    if (node.waveform === undefined) continue;
    if (node.t === 0) {
      out[0] = { t: 0, waveform: node.waveform };
      cur = node.waveform;
    } else if (node.waveform !== cur) {
      out.push({ t: node.t, waveform: node.waveform });
      cur = node.waveform;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// 8. Handles (interfaces §4)
// ---------------------------------------------------------------------------

export interface ScheduleOptions {
  /** ctx-clock time mapped to preset t=0. Default: voice.ctx.currentTime. */
  startTime?: number;
  /** preset-time offset to begin scheduling at (seek / re-target). Default: 0. */
  startOffsetSec?: number;
}

export interface ScheduledLane {
  readonly param: AutomatableParam;
  readonly pulseUnavailable: boolean;
  retarget(preset: Preset, atContextTime?: number): void;
  stop(atTime?: number): void;
  dispose(): void;
}

export interface SessionSchedule {
  readonly lanes: Readonly<Record<AutomatableParam, ScheduledLane>>;
  retarget(preset: Preset, atContextTime?: number): void;
  stop(atTime?: number): void;
  dispose(): void;
}

// AudioParam with the feature-detected re-target primitive (design §9).
type RetargetableParam = AudioParam & {
  cancelAndHoldAtTime?: (cancelTime: number) => void;
};

// One live automation-owned modulator wiring for a single span (for teardown/reconcile).
type LaneMode = 'warble' | 'pulse' | 'step' | 'box';
interface ModRuntime {
  mode: LaneMode;
  shape: ModShape;
  spanStartT: number;
  spanEndT: number;
  open: boolean;
  warble?: WarbleHandle;
  pulse?: PulseHandle;
  gateGain?: GainNode; // carrier/beat pulse depth gate (automation-owned)
  stepSource?: ConstantSourceNode; // jump/steps offset (automation-owned)
  boxSource?: ConstantSourceNode; // box trapezoid offset (automation-owned)
  isVolumeAttach: boolean; // used voice.attachVolumeModulator → must detach on teardown
  disposed: boolean;
}

// ---------------------------------------------------------------------------
// 9. schedule — one lane onto a live Voice (design §8)
// ---------------------------------------------------------------------------

export function schedule(
  preset: Preset,
  param: AutomatableParam,
  voice: Voice,
  options?: ScheduleOptions,
): ScheduledLane {
  assertPreset(preset);
  assertParam(param);
  const startTime0 = options?.startTime ?? voice.ctx.currentTime;
  const startOffset0 = options?.startOffsetSec ?? 0;
  assertFiniteTime(startTime0, 'startTime');
  assertFiniteTime(startOffset0, 'startOffsetSec');

  const ctx = voice.ctx;
  const baseParam = baseParamFor(voice, param);

  // Mutable lane state (advances on retarget).
  let curPreset = preset;
  let curStartTime = startTime0;
  let curStartOffset = startOffset0;
  const wirings: ModRuntime[] = [];
  let pulseUnavailable = false;
  let laneStopped = false;
  let disposed = false;

  // --- base-curve scheduling (design §8.2) ---
  function scheduleBaseCurve(
    p: Preset,
    startTime: number,
    startOffsetSec: number,
    floorTime: number,
    anchorOverride?: number,
  ): void {
    const dur = p.durationSec;
    const ctxTimeOf = (pt: number): number => startTime + (pt - startOffsetSec);
    const floorT = (time: number): number => Math.max(time, floorTime);

    const anchorVal = anchorOverride ?? baseCore(p, param, clampTime(startOffsetSec, dur));
    baseParam.setValueAtTime(anchorVal, floorT(startTime));

    const kf = laneKeyframes(p, param);
    for (let i = 0; i + 1 < kf.length; i++) {
      const ti = kf[i].t;
      const tj = kf[i + 1].t;
      if (tj <= startOffsetSec) continue; // wholly before the offset
      const a = kf[i].point.value;
      const b = kf[i + 1].point.value;
      const transition = kf[i].point.transition ?? DEFAULTS.paramTransition;
      const segStartPt = Math.max(ti, startOffsetSec);
      const segEndCtx = floorT(ctxTimeOf(tj));
      const startVal = segStartPt === ti ? a : baseCore(p, param, segStartPt);
      if (ti > startOffsetSec) {
        // A full segment start (not the straddling one already covered by the lane anchor).
        baseParam.setValueAtTime(startVal, floorT(ctxTimeOf(ti)));
      }
      switch (transition) {
        case 'linear':
          baseParam.linearRampToValueAtTime(b, segEndCtx);
          break;
        case 'exp':
          if (expValid(a, b)) baseParam.exponentialRampToValueAtTime(b, segEndCtx);
          else baseParam.linearRampToValueAtTime(b, segEndCtx);
          break;
        case 'smooth':
          scheduleSmoothSegment(a, b, ti, tj, segStartPt, ctxTimeOf, floorT);
          break;
        case 'hold':
          if (param === 'volume') {
            // Gain step clicks → 10 ms anti-click micro-ramp (design §3.3 / D4).
            baseParam.setValueAtTime(startVal, segEndCtx);
            baseParam.linearRampToValueAtTime(b, floorT(ctxTimeOf(tj) + VOLUME_MICRORAMP_SEC));
          } else {
            // Frequency step is click-free (only the phase-advance rate changes, D3).
            baseParam.setValueAtTime(b, segEndCtx);
          }
          break;
      }
    }
  }

  function scheduleSmoothSegment(
    a: number,
    b: number,
    ti: number,
    tj: number,
    segStartPt: number,
    ctxTimeOf: (pt: number) => number,
    floorT: (time: number) => number,
  ): void {
    const n = clampRange(
      Math.round((tj - ti) / SMOOTH_SEGMENT_SEC),
      SMOOTH_MIN_SEGMENTS,
      SMOOTH_MAX_SEGMENTS,
    );
    for (let j = 1; j <= n; j++) {
      const frac = j / n;
      const subPt = ti + (tj - ti) * frac;
      if (subPt <= segStartPt) continue; // skip sub-steps before the seek/offset
      const val = a + (b - a) * smoothstep(frac);
      baseParam.linearRampToValueAtTime(val, floorT(ctxTimeOf(subPt)));
    }
  }

  // --- modulator scheduling (design §8.3–8.6) ---
  function scheduleModulators(
    p: Preset,
    startTime: number,
    startOffsetSec: number,
    floorTime: number,
    skipActiveAt?: number,
  ): void {
    const spans = resolveSpans(p, param);
    const skipSpan = skipActiveAt === undefined ? null : activeSpanAt(spans, skipActiveAt);
    for (const span of spans) {
      if (span === skipSpan) continue;
      if (!span.open && span.endT <= startOffsetSec) continue; // wholly before the offset
      scheduleModSpan(p, span, startTime, startOffsetSec, floorTime);
    }
  }

  function scheduleModSpan(
    p: Preset,
    span: ModSpan,
    startTime: number,
    startOffsetSec: number,
    floorTime: number,
  ): void {
    const ctxTimeOf = (pt: number): number => startTime + (pt - startOffsetSec);
    const floorT = (time: number): number => Math.max(time, floorTime);
    const spanStartPt = Math.max(span.startT, startOffsetSec);
    const spanStartCtx = floorT(ctxTimeOf(spanStartPt));
    const spanEndCtx = span.open ? Infinity : floorT(ctxTimeOf(span.endT));
    const firstKey = span.keys[0];
    const isJumpSteps =
      firstKey.transition === 'jump' && firstKey.steps !== undefined && firstKey.steps.length > 0;

    // box first: it owns its trajectory and ignores steps (handled before the jump path).
    if (span.shape === 'box') {
      scheduleBoxSpan(p, span, ctxTimeOf, floorT, spanStartCtx, spanEndCtx, spanStartPt);
      return;
    }
    if (isJumpSteps) {
      scheduleStepSpan(p, span, ctxTimeOf, floorT, spanStartCtx, startOffsetSec);
      return;
    }
    if (span.shape === 'sine' || span.shape === 'triangle') {
      scheduleWarbleSpan(p, span, span.shape, ctxTimeOf, floorT, spanStartCtx, spanEndCtx, spanStartPt);
      return;
    }
    schedulePulseSpan(p, span, ctxTimeOf, floorT, spanStartCtx, spanEndCtx, spanStartPt);
  }

  function scheduleWarbleSpan(
    p: Preset,
    span: ModSpan,
    shape: 'sine' | 'triangle',
    ctxTimeOf: (pt: number) => number,
    floorT: (time: number) => number,
    spanStartCtx: number,
    spanEndCtx: number,
    spanStartPt: number,
  ): void {
    const target = warbleTargetFor(voice, param);
    const base0 = baseCore(p, param, spanStartPt);
    const depth0 = resolveModDepth(param, span.keys[0].depth, base0);
    const f0 = Math.max(0, span.keys[0].frequency);
    const handle = voice.connectWarble(target, {
      shape,
      frequencyHz: f0,
      depth: depth0,
      startTime: spanStartCtx,
    });
    handle.frequencyParam.setValueAtTime(f0, spanStartCtx);
    handle.depthParam.setValueAtTime(depth0, spanStartCtx);
    rampWarbleKeys(p, span, handle, ctxTimeOf, floorT, spanStartCtx);
    if (!span.open) handle.depthParam.linearRampToValueAtTime(0, spanEndCtx);
    wirings.push({
      mode: 'warble',
      shape: span.shape,
      spanStartT: span.startT,
      spanEndT: span.endT,
      open: span.open,
      warble: handle,
      isVolumeAttach: false,
      disposed: false,
    });
  }

  function rampWarbleKeys(
    p: Preset,
    span: ModSpan,
    handle: WarbleHandle,
    ctxTimeOf: (pt: number) => number,
    floorT: (time: number) => number,
    spanStartCtx: number,
  ): void {
    for (let j = 1; j < span.keys.length; j++) {
      const kt = floorT(ctxTimeOf(span.keys[j].t));
      if (kt <= spanStartCtx) continue;
      handle.frequencyParam.linearRampToValueAtTime(Math.max(0, span.keys[j].frequency), kt);
      const basej = baseCore(p, param, span.keys[j].t);
      handle.depthParam.linearRampToValueAtTime(resolveModDepth(param, span.keys[j].depth, basej), kt);
    }
  }

  function schedulePulseSpan(
    p: Preset,
    span: ModSpan,
    ctxTimeOf: (pt: number) => number,
    floorT: (time: number) => number,
    spanStartCtx: number,
    spanEndCtx: number,
    spanStartPt: number,
  ): void {
    const k0 = span.keys[0];
    const base0 = baseCore(p, param, spanStartPt);
    const edge0 = span.shape === 'square' ? 0 : k0.edgeSec;
    let handle: PulseHandle;
    let gateGain: GainNode | undefined;
    let isVolumeAttach = false;
    try {
      if (param === 'volume') {
        handle = voice.createPulseNode({
          frequencyHz: k0.frequency,
          depth: clampRange(k0.depth, 0, 1),
          dutyCycle: k0.pulseWidth,
          edgeSec: edge0,
        });
        voice.attachVolumeModulator(handle.output);
        isVolumeAttach = true;
      } else {
        // depth=1 → clean 0..1 gate; an automation-owned GainNode scales to per-key depth.
        handle = voice.createPulseNode({
          frequencyHz: k0.frequency,
          depth: 1,
          dutyCycle: k0.pulseWidth,
          edgeSec: edge0,
        });
        gateGain = ctx.createGain();
        gateGain.gain.value = resolveModDepth(param, k0.depth, base0);
        handle.output.connect(gateGain);
        gateGain.connect(baseParamFor(voice, param));
      }
    } catch (e) {
      if (
        e instanceof AudioEngineError &&
        (e.code === 'WORKLET_NOT_REGISTERED' || e.code === 'WORKLET_LOAD_FAILED')
      ) {
        pulseUnavailable = true; // base curve still plays (edge-cases F1/F2)
        return;
      }
      throw e; // other AudioEngineError (e.g. VOICE_STOPPED) propagates
    }

    // Anchor + ramp the worklet params across the span keys.
    handle.frequencyParam.setValueAtTime(k0.frequency, spanStartCtx);
    handle.dutyCycleParam.setValueAtTime(k0.pulseWidth, spanStartCtx);
    handle.edgeWidthParam.setValueAtTime(edge0, spanStartCtx);
    if (param === 'volume') handle.depthParam.setValueAtTime(clampRange(k0.depth, 0, 1), spanStartCtx);
    else gateGain!.gain.setValueAtTime(resolveModDepth(param, k0.depth, base0), spanStartCtx);

    for (let j = 1; j < span.keys.length; j++) {
      const key = span.keys[j];
      const kt = floorT(ctxTimeOf(key.t));
      if (kt <= spanStartCtx) continue;
      handle.frequencyParam.linearRampToValueAtTime(key.frequency, kt);
      handle.dutyCycleParam.linearRampToValueAtTime(key.pulseWidth, kt);
      handle.edgeWidthParam.linearRampToValueAtTime(span.shape === 'square' ? 0 : key.edgeSec, kt);
      const basej = baseCore(p, param, key.t);
      if (param === 'volume') handle.depthParam.linearRampToValueAtTime(clampRange(key.depth, 0, 1), kt);
      else gateGain!.gain.linearRampToValueAtTime(resolveModDepth(param, key.depth, basej), kt);
    }

    // Ramp depth/gate to 0 at the boundary so late wall-clock teardown is inaudible (§8.6).
    if (!span.open) {
      if (param === 'volume') handle.depthParam.linearRampToValueAtTime(0, spanEndCtx);
      else gateGain!.gain.linearRampToValueAtTime(0, spanEndCtx);
    }

    wirings.push({
      mode: 'pulse',
      shape: span.shape,
      spanStartT: span.startT,
      spanEndT: span.endT,
      open: span.open,
      pulse: handle,
      gateGain,
      isVolumeAttach,
      disposed: false,
    });
  }

  function scheduleStepSpan(
    p: Preset,
    span: ModSpan,
    ctxTimeOf: (pt: number) => number,
    floorT: (time: number) => number,
    spanStartCtx: number,
    startOffsetSec: number,
  ): void {
    const steps = span.keys[0].steps as number[];
    const len = steps.length;
    const spanStartPreset = Math.max(span.startT, startOffsetSec);
    const source = ctx.createConstantSource();

    const stepValueAt = (idx: number, presetT: number): number => {
      const raw = steps[((idx % len) + len) % len];
      if (param === 'volume') return clampRange(raw, 0, 1);
      const base = baseCore(p, param, presetT);
      return param === 'spatial'
        ? clampRange(raw, -1 - base, 1 - base)
        : clampRange(raw, FREQ_FLOOR_HZ - base, FREQ_CEIL_HZ - base);
    };

    const v0 = stepValueAt(0, span.startT);
    source.offset.value = v0;
    source.offset.setValueAtTime(v0, spanStartCtx);
    if (param === 'volume') voice.attachVolumeModulator(source);
    else source.connect(baseParamFor(voice, param));
    source.start(spanStartCtx);

    const endPt = span.open ? p.durationSec : span.endT;
    const boundaries = spanCycleBoundaries(span, endPt);
    for (let i = 0; i < boundaries.length; i++) {
      const bt = boundaries[i];
      if (bt <= spanStartPreset) continue;
      const bc = floorT(ctxTimeOf(bt));
      const val = stepValueAt(i + 1, bt); // boundary i is phase = i+1 → step (i+1)
      if (param === 'volume') {
        source.offset.setValueAtTime(source.offset.value, bc);
        source.offset.linearRampToValueAtTime(val, bc + VOLUME_MICRORAMP_SEC);
      } else {
        source.offset.setValueAtTime(val, bc);
      }
    }

    wirings.push({
      mode: 'step',
      shape: span.shape,
      spanStartT: span.startT,
      spanEndT: span.endT,
      open: span.open,
      stepSource: source,
      isVolumeAttach: param === 'volume',
      disposed: false,
    });
  }

  // --- box trapezoid scheduling (BOX / TRAPEZOID shape) ---
  // Realised as a ConstantSourceNode whose .offset is driven through the repeating
  // trapezoid with setValueAtTime holds + linearRampToValueAtTime ramps — the SAME
  // mechanism as the jump/steps sequencer — summed onto the additive param or fed via
  // attachVolumeModulator (volume). Breakpoints land on the box vertices so a piecewise-
  // linear offset reproduces the pure boxUnit trajectory (preview == playback parity).
  function scheduleBoxSpan(
    p: Preset,
    span: ModSpan,
    ctxTimeOf: (pt: number) => number,
    floorT: (time: number) => number,
    spanStartCtx: number,
    spanEndCtx: number,
    spanStartPt: number,
  ): void {
    const isVolume = param === 'volume';
    const neutral = isVolume ? 1 : 0;

    // The scheduled offset for a bipolar unit value u∈[−1,1] at preset time `presetT`,
    // matching evalModulator exactly: additive depth·u, or the [1−depth, 1] volume map.
    const offsetForUnit = (u: number, presetT: number): number => {
      const fields = interpolateFields(span, presetT);
      if (isVolume) {
        const depth = clampRange(fields.depth, 0, 1);
        return 1 - depth + depth * ((u + 1) / 2);
      }
      const base = baseCore(p, param, presetT);
      return resolveModDepth(param, fields.depth, base) * u;
    };
    const unitAt = (presetT: number): number => {
      const ph = phaseAt(span, presetT);
      const frac = ph - Math.floor(ph);
      return boxUnit(frac, interpolateFields(span, presetT).pulseWidth);
    };

    const source = ctx.createConstantSource();
    const startOffset = offsetForUnit(unitAt(spanStartPt), spanStartPt);
    source.offset.value = startOffset;
    source.offset.setValueAtTime(startOffset, spanStartCtx);
    if (isVolume) voice.attachVolumeModulator(source);
    else source.connect(baseParamFor(voice, param));
    source.start(spanStartCtx);

    // Walk whole cycles from the span start (phaseAt = 0 at span.startT), emitting the
    // vertices of each trapezoid. A ramp is emitted only when the value changes between
    // vertices; equal-valued vertices are holds (setValueAtTime), as is each step edge.
    const endPt = span.open ? p.durationSec : span.endT;
    let lastU = unitAt(spanStartPt);
    let count = 0;
    outer: for (let k = 0; k <= MAX_STEP_BOUNDARIES; k++) {
      const tCycle = k === 0 ? span.startT : timeAtPhase(span, k);
      if (tCycle === null || tCycle >= endPt) break;
      const h = clampRange(interpolateFields(span, Math.max(tCycle, spanStartPt)).pulseWidth, 0, 1);
      const rampFrac = (1 - h) / 2;
      const holdFrac = h / 2;
      const verts: { frac: number; u: number; ramp: boolean }[] =
        rampFrac <= 0
          ? [
              { frac: 0, u: 1, ramp: false },
              { frac: 0.5, u: -1, ramp: false }, // h=1 square: step down at mid-cycle
            ]
          : [
              { frac: 0, u: -1, ramp: false }, // low-hold anchor / inhale start
              { frac: rampFrac, u: 1, ramp: true }, // inhale ramp to peak
              ...(holdFrac > 0
                ? [{ frac: rampFrac + holdFrac, u: 1, ramp: false }] // high-hold anchor
                : []),
              { frac: 2 * rampFrac + holdFrac, u: -1, ramp: true }, // exhale ramp to trough
            ];
      for (const v of verts) {
        const tv = timeAtPhase(span, k + v.frac);
        if (tv === null) continue;
        if (tv > endPt) break outer;
        if (tv <= spanStartPt + 1e-9) {
          lastU = v.u; // before/at the start anchor: only advance the running value
          continue;
        }
        if (count++ > MAX_STEP_BOUNDARIES) break outer;
        const off = offsetForUnit(v.u, tv);
        const tc = floorT(ctxTimeOf(tv));
        if (v.ramp && v.u !== lastU) source.offset.linearRampToValueAtTime(off, tc);
        else source.offset.setValueAtTime(off, tc);
        lastU = v.u;
      }
    }

    // Ramp toward the neutral offset at a closed boundary so late teardown is inaudible.
    if (!span.open) source.offset.linearRampToValueAtTime(neutral, spanEndCtx);

    wirings.push({
      mode: 'box',
      shape: span.shape,
      spanStartT: span.startT,
      spanEndT: span.endT,
      open: span.open,
      boxSource: source,
      isVolumeAttach: isVolume,
      disposed: false,
    });
  }

  // Initial schedule.
  scheduleBaseCurve(curPreset, curStartTime, curStartOffset, curStartTime);
  scheduleModulators(curPreset, curStartTime, curStartOffset, curStartTime);

  // --- teardown helpers ---
  function teardownWiring(w: ModRuntime): void {
    if (w.disposed) return;
    w.disposed = true;
    swallow(() => {
      if (w.isVolumeAttach) voice.detachVolumeModulator();
    });
    swallow(() => w.warble?.disconnect());
    swallow(() => w.pulse?.disconnect());
    swallow(() => w.gateGain?.disconnect());
    swallow(() => {
      if (w.stepSource) {
        w.stepSource.stop();
        w.stepSource.disconnect();
      }
    });
    swallow(() => {
      if (w.boxSource) {
        w.boxSource.stop();
        w.boxSource.disconnect();
      }
    });
  }

  // --- public handle ---
  const lane: ScheduledLane = {
    param,
    get pulseUnavailable() {
      return pulseUnavailable;
    },

    retarget(newPreset: Preset, atContextTime?: number): void {
      assertPreset(newPreset);
      if (disposed || laneStopped) return;
      if (atContextTime !== undefined) assertFiniteTime(atContextTime, 'atContextTime');
      const now = ctx.currentTime;
      // Floor tr at now so no event (cancel/anchor/ramp) is ever scheduled in the past (E3).
      const tr = Math.max(atContextTime ?? now + RETARGET_LOOKAHEAD_SEC, now);
      const floorTime = tr;
      const off = curStartOffset + (tr - curStartTime); // offsetAt(tr) under the OLD mapping
      // JS-tracked hold anchor from the previously-scheduled preset — never read param.value (E2).
      const oldAnchor = baseCore(curPreset, param, clampTime(off, curPreset.durationSec));

      const rp = baseParam as RetargetableParam;
      if (typeof rp.cancelAndHoldAtTime === 'function') {
        rp.cancelAndHoldAtTime(tr); // holds the OLD intrinsic value at tr (continuity)
      } else {
        // Firefox fallback: cancel + a JS-tracked hold anchor (never reads the stale value).
        baseParam.cancelScheduledValues(tr);
        baseParam.setValueAtTime(oldAnchor, tr);
      }

      // Modulator identity reconcile (design §9 step 3 / edge-cases C3, E4).
      const oldSpan = activeSpanAt(resolveSpans(curPreset, param), clampTime(off, curPreset.durationSec));
      const newSpan = activeSpanAt(resolveSpans(newPreset, param), clampTime(off, newPreset.durationSec));
      const keepActive = canKeepModulator(oldSpan, newSpan);
      const activeWiring = keepActive ? findActiveWiring(off) : undefined;

      for (const w of wirings) {
        if (w !== activeWiring) teardownWiring(w);
      }
      const surviving = activeWiring && !activeWiring.disposed ? [activeWiring] : [];
      wirings.length = 0;
      wirings.push(...surviving);

      // Advance the mapping to the new preset/anchor before rescheduling.
      curPreset = newPreset;
      curStartTime = tr;
      curStartOffset = off;

      // The new curve anchors at newPreset's value at off so it reaches the edited base
      // even when the edit is a single constant keyframe; the old value was only the hold.
      scheduleBaseCurve(newPreset, tr, off, floorTime);

      if (activeWiring && newSpan) {
        reRampKeptWiring(activeWiring, newPreset, newSpan, tr, off, floorTime);
        scheduleModulators(newPreset, tr, off, floorTime, off); // future spans only
      } else {
        scheduleModulators(newPreset, tr, off, floorTime);
      }
    },

    stop(atTime?: number): void {
      if (laneStopped || disposed) return;
      laneStopped = true;
      const t = atTime ?? ctx.currentTime;
      const rp = baseParam as RetargetableParam;
      if (typeof rp.cancelAndHoldAtTime === 'function') {
        rp.cancelAndHoldAtTime(t);
      } else {
        baseParam.cancelScheduledValues(t);
        baseParam.setValueAtTime(baseCore(curPreset, param, clampTime(curStartOffset + (t - curStartTime), curPreset.durationSec)), t);
      }
      for (const w of wirings) teardownWiring(w);
    },

    dispose(): void {
      if (disposed) return;
      disposed = true;
      for (const w of wirings) teardownWiring(w);
    },
  };

  // --- retarget reconcile helpers (need the closure's param/voice/wirings) ---
  function findActiveWiring(off: number): ModRuntime | undefined {
    for (const w of wirings) {
      if (off >= w.spanStartT && (w.open || off < w.spanEndT)) return w;
    }
    return undefined;
  }

  function reRampKeptWiring(
    w: ModRuntime,
    p: Preset,
    span: ModSpan,
    tr: number,
    off: number,
    floorTime: number,
  ): void {
    const ctxTimeOf = (pt: number): number => tr + (pt - off);
    const floorT = (time: number): number => Math.max(time, floorTime);
    w.spanStartT = span.startT;
    w.spanEndT = span.endT;
    w.open = span.open;
    const spanEndCtx = span.open ? Infinity : floorT(ctxTimeOf(span.endT));
    const fieldsNow = interpolateFields(span, clampTime(off, p.durationSec));
    const baseNow = baseCore(p, param, clampTime(off, p.durationSec));

    if (w.mode === 'warble' && w.warble) {
      const h = w.warble;
      reanchor(h.frequencyParam, Math.max(0, fieldsNow.frequency), tr);
      reanchor(h.depthParam, resolveModDepth(param, fieldsNow.depth, baseNow), tr);
      for (let j = 0; j < span.keys.length; j++) {
        const key = span.keys[j];
        if (key.t <= off) continue;
        const kt = floorT(ctxTimeOf(key.t));
        h.frequencyParam.linearRampToValueAtTime(Math.max(0, key.frequency), kt);
        h.depthParam.linearRampToValueAtTime(resolveModDepth(param, key.depth, baseCore(p, param, key.t)), kt);
      }
      if (!span.open) h.depthParam.linearRampToValueAtTime(0, spanEndCtx);
    } else if (w.mode === 'pulse' && w.pulse) {
      const h = w.pulse;
      reanchor(h.frequencyParam, fieldsNow.frequency, tr);
      reanchor(h.dutyCycleParam, fieldsNow.pulseWidth, tr);
      reanchor(h.edgeWidthParam, span.shape === 'square' ? 0 : fieldsNow.edgeSec, tr);
      const depthParam = param === 'volume' ? h.depthParam : w.gateGain!.gain;
      const depthNow = resolveModDepth(param, fieldsNow.depth, baseNow);
      reanchor(depthParam, depthNow, tr);
      for (let j = 0; j < span.keys.length; j++) {
        const key = span.keys[j];
        if (key.t <= off) continue;
        const kt = floorT(ctxTimeOf(key.t));
        h.frequencyParam.linearRampToValueAtTime(key.frequency, kt);
        h.dutyCycleParam.linearRampToValueAtTime(key.pulseWidth, kt);
        h.edgeWidthParam.linearRampToValueAtTime(span.shape === 'square' ? 0 : key.edgeSec, kt);
        const dv = resolveModDepth(param, key.depth, baseCore(p, param, key.t));
        depthParam.linearRampToValueAtTime(dv, kt);
      }
      if (!span.open) depthParam.linearRampToValueAtTime(0, spanEndCtx);
    }
  }

  function reanchor(p: AudioParam, value: number, t: number): void {
    const rp = p as RetargetableParam;
    if (typeof rp.cancelAndHoldAtTime === 'function') rp.cancelAndHoldAtTime(t);
    else p.cancelScheduledValues(t);
    p.setValueAtTime(value, t);
  }

  return lane;
}

// ---------------------------------------------------------------------------
// 10. scheduleAll — the three lanes (design §10)
// ---------------------------------------------------------------------------

export function scheduleAll(
  preset: Preset,
  voice: Voice,
  options?: ScheduleOptions,
): SessionSchedule {
  assertPreset(preset);
  const lanes = {
    carrier: schedule(preset, 'carrier', voice, options),
    beat: schedule(preset, 'beat', voice, options),
    volume: schedule(preset, 'volume', voice, options),
    spatial: schedule(preset, 'spatial', voice, options),
  } satisfies Record<AutomatableParam, ScheduledLane>;

  return {
    lanes,
    retarget(p: Preset, atContextTime?: number): void {
      for (const name of PARAMS) lanes[name].retarget(p, atContextTime);
    },
    stop(atTime?: number): void {
      for (const name of PARAMS) lanes[name].stop(atTime);
    },
    dispose(): void {
      for (const name of PARAMS) lanes[name].dispose();
    },
  };
}

// ---------------------------------------------------------------------------
// 11. Module-private scheduling helpers
// ---------------------------------------------------------------------------

function baseParamFor(voice: Voice, param: AutomatableParam): AudioParam {
  switch (param) {
    case 'carrier':
      return voice.carrierParam;
    case 'beat':
      return voice.beatParam;
    case 'volume':
      return voice.volumeParam;
    case 'spatial':
      return voice.spatialParam;
  }
}

function warbleTargetFor(voice: Voice, param: AutomatableParam): AudioParam {
  // Volume tremolo rides on the multiplicative envGain (modVolumeParam), summed around
  // its intrinsic 1.0; carrier/beat warble sums directly into the base offset param.
  return param === 'volume' ? voice.modVolumeParam : baseParamFor(voice, param);
}

function resolveModDepth(param: AutomatableParam, depth: number, base: number): number {
  // volume + spatial are bounded [0,1] depths; carrier/beat are Hz depths bounded by
  // the frequency floor/ceil against the lane's base value.
  if (param === 'volume' || param === 'spatial') return clampRange(depth, 0, 1);
  return clampFreqDepth(depth, base);
}

/** Whether a modulator node can be kept (re-ramped) across a retarget: both inactive,
 *  or both active with the same shape AND the same output mode (design §9 / E4). */
function canKeepModulator(oldSpan: ModSpan | null, newSpan: ModSpan | null): boolean {
  if (!oldSpan && !newSpan) return false; // nothing to keep
  if (!oldSpan || !newSpan) return false; // turned on/off
  if (oldSpan.shape !== newSpan.shape) return false;
  // box has no in-place re-ramp path — always rebuild it (re-anchored at the seek value).
  if (oldSpan.shape === 'box') return false;
  return spanOutputMode(oldSpan) === spanOutputMode(newSpan);
}

function spanOutputMode(span: ModSpan): LaneMode {
  const k = span.keys[0];
  if (span.shape === 'box') return 'box';
  if (k.transition === 'jump' && k.steps && k.steps.length > 0) return 'step';
  return span.shape === 'sine' || span.shape === 'triangle' ? 'warble' : 'pulse';
}

/** Invert the span's analytic phase: the preset time at which the cumulative phase
 *  (cycles, 0 at span.startT) first reaches `target`, ramped frequency handled per
 *  sub-interval like §5.4 / spanCycleBoundaries. Returns null when the phase can never
 *  reach the target (e.g. a held 0 Hz frequency). */
function timeAtPhase(span: ModSpan, target: number): number | null {
  const keys = span.keys;
  let phaseBase = 0;
  for (let i = 0; i < keys.length; i++) {
    const ti = keys[i].t;
    const fi = keys[i].frequency;
    const hasNext = i + 1 < keys.length;
    const tNext = hasNext ? keys[i + 1].t : Infinity;
    const fNext = hasNext ? keys[i + 1].frequency : fi;
    const dT = tNext - ti;
    const slope = hasNext ? (fNext - fi) / dT : 0;
    const phaseAtEnd = hasNext ? phaseBase + fi * dT + 0.5 * slope * dT * dT : Infinity;
    if (target <= phaseAtEnd) {
      const want = target - phaseBase;
      let s: number;
      if (Math.abs(slope) < 1e-12) {
        if (fi <= 0) return null; // phase never advances
        s = want / fi;
      } else {
        const disc = fi * fi + 2 * slope * want;
        if (disc < 0) return null;
        s = (-fi + Math.sqrt(disc)) / slope;
      }
      if (!Number.isFinite(s) || s < 0) return null;
      return ti + s;
    }
    phaseBase = phaseAtEnd;
  }
  return null;
}

/** Preset times where the span's analytic phase crosses 1, 2, 3, … (cycle boundaries),
 *  by inverting the §5.4 integral per sub-interval (design §6). */
function spanCycleBoundaries(span: ModSpan, endT: number): number[] {
  const out: number[] = [];
  const keys = span.keys;
  let phaseBase = 0;
  let k = 1;

  const emitWithin = (t0: number, t1: number, f0: number, slope: number): void => {
    const phaseAtEnd = phaseBase + f0 * (t1 - t0) + 0.5 * slope * (t1 - t0) * (t1 - t0);
    while (k <= phaseAtEnd && out.length < MAX_STEP_BOUNDARIES) {
      const target = k - phaseBase;
      let s: number;
      if (Math.abs(slope) < 1e-12) {
        s = f0 <= 0 ? Infinity : target / f0;
      } else {
        const disc = f0 * f0 + 2 * slope * target;
        s = (-f0 + Math.sqrt(Math.max(0, disc))) / slope;
      }
      if (!Number.isFinite(s)) break;
      out.push(t0 + s);
      k++;
    }
    phaseBase = phaseAtEnd;
  };

  for (let i = 0; i + 1 < keys.length; i++) {
    if (keys[i + 1].t > endT) break;
    const t0 = keys[i].t;
    const t1 = keys[i + 1].t;
    emitWithin(t0, t1, keys[i].frequency, (keys[i + 1].frequency - keys[i].frequency) / (t1 - t0));
    if (out.length >= MAX_STEP_BOUNDARIES) return out;
  }
  // Constant tail from the last key to the span end.
  const lastT = keys[keys.length - 1].t;
  if (endT > lastT) emitWithin(lastT, endT, keys[keys.length - 1].frequency, 0);
  return out;
}

/** Swallow teardown errors (e.g. a VOICE_STOPPED detach) so stop()/dispose() stay
 *  idempotent and safe in any order (edge-cases H5). */
function swallow(fn: () => void): void {
  try {
    fn();
  } catch {
    // teardown is best-effort; the Voice may already be stopped/disposed.
  }
}
