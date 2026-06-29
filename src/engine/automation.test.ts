import {
  AutomationError,
  baseValueAt,
  modulatorAt,
  valueAt,
  waveformAt,
  waveformKeyframes,
  schedule,
  scheduleAll,
  SMOOTH_SEGMENT_SEC,
  SMOOTH_MIN_SEGMENTS,
  SMOOTH_MAX_SEGMENTS,
  VOLUME_MICRORAMP_SEC,
  RETARGET_LOOKAHEAD_SEC,
  FREQ_FLOOR_HZ,
  FREQ_CEIL_HZ,
  type AutomationErrorCode,
} from './automation';
import { createVoice, registerPulseWorklet, AudioEngineError, type Voice } from './audio-engine';
import type {
  Preset,
  TimeNode,
  AutomatableParam,
  ParamPoint,
  ModPoint,
} from './session-model';
import {
  MockAudioContext,
  type MockAudioParam,
  type MockOscillatorNode,
  type MockConstantSourceNode,
  type MockGainNode,
  type MockAudioWorkletNode,
  computeParamValueAtTime,
  installAudioWorkletNode,
} from '../test/webaudio-mock';

// --- casts / builders ------------------------------------------------------

const asCtx = (ctx: MockAudioContext): BaseAudioContext => ctx as unknown as BaseAudioContext;
const mp = (p: AudioParam): MockAudioParam => p as unknown as MockAudioParam;

function preset(durationSec: number, nodes: TimeNode[]): Preset {
  return { schemaVersion: 6, name: 'test', durationSec, masterGain: 0.8, nodes };
}
function pp(value: number, transition?: ParamPoint['transition'], mod?: ModPoint | null): ParamPoint {
  const out: ParamPoint = { value };
  if (transition) out.transition = transition;
  if (mod !== undefined) out.mod = mod;
  return out;
}

function makeVoice(ctxOpts?: ConstructorParameters<typeof MockAudioContext>[0]): {
  ctx: MockAudioContext;
  voice: Voice;
} {
  const ctx = new MockAudioContext(ctxOpts);
  const voice = createVoice(asCtx(ctx), { carrierHz: 200, beatHz: 4 });
  return { ctx, voice };
}

function expectAutomationError(fn: () => unknown, code: AutomationErrorCode): void {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(AutomationError);
    expect((e as AutomationError).code).toBe(code);
    return;
  }
  throw new Error(`expected AutomationError(${code}) but nothing was thrown`);
}

// =====================================================================================
// Task 1 — constants, AutomationError, baseValueAt + the four base transitions
// =====================================================================================

describe('constants + AutomationError (Task 1)', () => {
  it('should export the §11 constants with their authoritative values', () => {
    expect(SMOOTH_SEGMENT_SEC).toBe(0.25);
    expect(SMOOTH_MIN_SEGMENTS).toBe(4);
    expect(SMOOTH_MAX_SEGMENTS).toBe(256);
    expect(VOLUME_MICRORAMP_SEC).toBe(0.01);
    expect(RETARGET_LOOKAHEAD_SEC).toBe(0.02);
    expect(FREQ_FLOOR_HZ).toBe(1);
    expect(FREQ_CEIL_HZ).toBe(20000);
  });

  it('should be an Error subclass carrying name + code', () => {
    const err = new AutomationError('INVALID_TIME', 't must be finite, got NaN');
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(AutomationError);
    expect(err.name).toBe('AutomationError');
    expect(err.code).toBe('INVALID_TIME');
    expect(err.message).toBe('t must be finite, got NaN');
  });
});

describe('baseValueAt (Task 1)', () => {
  it('should hold the first keyframe flat before t0 (carry-forward, A5)', () => {
    const p = preset(100, [
      { t: 0, carrier: pp(200) },
      { t: 10, beat: pp(8) }, // beat first authored at t=10
    ]);
    expect(baseValueAt(p, 'beat', 0)).toBe(8); // held flat before its first keyframe
    expect(baseValueAt(p, 'beat', 5)).toBe(8);
    expect(baseValueAt(p, 'beat', 10)).toBe(8);
  });

  it('should hold the last keyframe flat after tm and beyond durationSec (A2)', () => {
    const p = preset(100, [
      { t: 0, carrier: pp(200) },
      { t: 50, carrier: pp(400) },
    ]);
    expect(baseValueAt(p, 'carrier', 50)).toBe(400);
    expect(baseValueAt(p, 'carrier', 80)).toBe(400);
    expect(baseValueAt(p, 'carrier', 999)).toBe(400); // clamped to durationSec → held
  });

  it('should interpolate linear / exp / hold / smooth exactly', () => {
    const lin = preset(10, [{ t: 0, carrier: pp(100, 'linear') }, { t: 10, carrier: pp(200) }]);
    expect(baseValueAt(lin, 'carrier', 5)).toBeCloseTo(150, 9);

    const exp = preset(10, [{ t: 0, carrier: pp(100, 'exp') }, { t: 10, carrier: pp(400) }]);
    expect(baseValueAt(exp, 'carrier', 5)).toBeCloseTo(100 * Math.pow(4, 0.5), 9); // 200

    const hold = preset(10, [{ t: 0, carrier: pp(100, 'hold') }, { t: 10, carrier: pp(200) }]);
    expect(baseValueAt(hold, 'carrier', 5)).toBe(100);
    expect(baseValueAt(hold, 'carrier', 9.999)).toBe(100);
    expect(baseValueAt(hold, 'carrier', 10)).toBe(200);

    const sm = preset(10, [{ t: 0, carrier: pp(100, 'smooth') }, { t: 10, carrier: pp(200) }]);
    const frac = 0.3;
    const s = frac * frac * (3 - 2 * frac);
    expect(baseValueAt(sm, 'carrier', 3)).toBeCloseTo(100 + 100 * s, 9);
  });

  it('should fall back exp→linear when an endpoint is 0 (A8)', () => {
    const p = preset(10, [{ t: 0, volume: pp(1, 'exp') }, { t: 10, volume: pp(0) }]);
    // exp cannot reach 0 → linear fallback → straight line.
    expect(baseValueAt(p, 'volume', 5)).toBeCloseTo(0.5, 9);
    expect(baseValueAt(p, 'volume', 2.5)).toBeCloseTo(0.75, 9);
  });

  it('should default a never-authored lane (beat→0, volume→1, A4)', () => {
    const p = preset(10, [{ t: 0, carrier: pp(200) }]);
    expect(baseValueAt(p, 'beat', 3)).toBe(0);
    expect(baseValueAt(p, 'volume', 3)).toBe(1);
  });

  it('should hold a single keyframe constant for all t (A6)', () => {
    const p = preset(10, [{ t: 0, carrier: pp(300) }]);
    expect(baseValueAt(p, 'carrier', 0)).toBe(300);
    expect(baseValueAt(p, 'carrier', 10)).toBe(300);
  });

  it('should clamp a finite out-of-range t into [0, durationSec] (A2)', () => {
    const p = preset(10, [{ t: 0, carrier: pp(100) }, { t: 10, carrier: pp(200) }]);
    expect(baseValueAt(p, 'carrier', -5)).toBe(100); // → t=0
    expect(baseValueAt(p, 'carrier', 50)).toBe(200); // → t=10
  });

  it('should throw INVALID_TIME / INVALID_PARAM / INVALID_PRESET (A1/A3/A9)', () => {
    const p = preset(10, [{ t: 0, carrier: pp(100) }]);
    expectAutomationError(() => baseValueAt(p, 'carrier', NaN), 'INVALID_TIME');
    expectAutomationError(() => baseValueAt(p, 'carrier', Infinity), 'INVALID_TIME');
    expectAutomationError(() => baseValueAt(p, 'bogus' as AutomatableParam, 0), 'INVALID_PARAM');
    expectAutomationError(() => baseValueAt(null as unknown as Preset, 'carrier', 0), 'INVALID_PRESET');
  });
});

// =====================================================================================
// Task 2 — modulatorAt: resolution, interpolation, phase, shapes, jump/steps
// =====================================================================================

describe('modulatorAt (Task 2)', () => {
  // sine warble, period 1s → f = 1 Hz; depth 0.025 fraction of base 200 = 5 Hz; lasts the whole timeline.
  const sineMod: ModPoint = { shape: 'sine', periodSec: 1, depth: 0.025 };

  it('should carry an absent mod through a later keyframe (B1)', () => {
    const p = preset(10, [
      { t: 0, carrier: pp(200, 'linear', sineMod) },
      { t: 5, carrier: pp(300) }, // no mod key → transparent, span carries through
    ]);
    // At t=6.25, phase = 6.25 → frac .25 → sin = 1 → mod = depth.
    expect(modulatorAt(p, 'carrier', 6.25)).toBeCloseTo(5, 9);
  });

  it('should clear the modulator at a mod:null keyframe (B2)', () => {
    const p = preset(10, [
      { t: 0, carrier: pp(200, 'linear', sineMod) },
      { t: 5, carrier: pp(200, 'linear', null) },
    ]);
    expect(modulatorAt(p, 'carrier', 4.25)).toBeCloseTo(5, 9); // active before
    expect(modulatorAt(p, 'carrier', 5)).toBe(0); // cleared at t=5
    expect(modulatorAt(p, 'carrier', 8)).toBe(0);
  });

  it('should hold the last mod object to the end and beyond durationSec (B3)', () => {
    const p = preset(10, [{ t: 0, carrier: pp(200, 'linear', sineMod) }]);
    expect(modulatorAt(p, 'carrier', 9.25)).toBeCloseTo(5, 9);
    expect(modulatorAt(p, 'carrier', 999)).toBeCloseTo(modulatorAt(p, 'carrier', 10), 9); // clamped
  });

  it('should split the span and reset phase on a shape change (B4)', () => {
    const p = preset(10, [
      { t: 0, carrier: pp(200, 'linear', { shape: 'sine', periodSec: 1, depth: 0.025 }) },
      { t: 4, carrier: pp(200, 'linear', { shape: 'pulse', periodSec: 1, depth: 0.025, pulseWidth: 0.5 }) },
    ]);
    // At t=4 the pulse span starts fresh: phase 0 → gate(0) = 1 → mod = depth.
    expect(modulatorAt(p, 'carrier', 4)).toBeCloseTo(5, 9);
  });

  it('should apply DEFAULTS for missing numeric fields and treat a period-less mod as inactive (B5)', () => {
    const noDepth = preset(10, [{ t: 0, carrier: pp(200, 'linear', { shape: 'sine', periodSec: 1 }) }]);
    expect(modulatorAt(noDepth, 'carrier', 0.25)).toBe(0); // depth defaults to 0

    const noPeriod = preset(10, [{ t: 0, carrier: pp(200, 'linear', { shape: 'sine', depth: 0.025 }) }]);
    expect(modulatorAt(noPeriod, 'carrier', 3)).toBe(0); // inactive (no rate)
  });

  it('should be 0/1 when depth is 0 (B6)', () => {
    const p = preset(10, [{ t: 0, carrier: pp(200, 'linear', { shape: 'sine', periodSec: 1, depth: 0 }) }]);
    expect(modulatorAt(p, 'carrier', 0.25)).toBe(0);
    const pv = preset(10, [{ t: 0, volume: pp(1, 'linear', { shape: 'sine', periodSec: 1, depth: 0 }) }]);
    expect(modulatorAt(pv, 'volume', 0.25)).toBe(1);
  });

  it('should interpolate frequency = 1/periodSec linearly and integrate phase analytically (B7, C)', () => {
    // key0 @ t0: period 1 → f0 = 1; key1 @ t2: period 0.5 → f1 = 2. depth 1.
    const p = preset(10, [
      { t: 0, carrier: pp(200, 'linear', { shape: 'sine', periodSec: 1, depth: 0.005 }) },
      { t: 2, carrier: pp(200, 'linear', { shape: 'sine', periodSec: 0.5, depth: 0.005 }) },
    ]);
    // Analytic phase at t=1: f0·Δt + 0.5·slope·Δt² = 1·1 + 0.5·0.5·1 = 1.25 cycles.
    const expected = Math.sin(2 * Math.PI * (1.25 - Math.floor(1.25)));
    expect(modulatorAt(p, 'carrier', 1)).toBeCloseTo(expected, 9);
  });

  it('should sample-and-hold steps[k mod len] for jump+steps (§6)', () => {
    const p = preset(10, [
      { t: 0, carrier: pp(200, 'linear', { periodSec: 1, transition: 'jump', steps: [3, 7, -2] }) },
    ]);
    // f=1 Hz → cycle boundaries at 1,2,3,…; value held per cycle.
    expect(modulatorAt(p, 'carrier', 0.5)).toBe(3); // cycle 0 → steps[0]
    expect(modulatorAt(p, 'carrier', 1.5)).toBe(7); // cycle 1 → steps[1]
    expect(modulatorAt(p, 'carrier', 2.5)).toBe(-2); // cycle 2 → steps[2]
    expect(modulatorAt(p, 'carrier', 3.5)).toBe(3); // cycle 3 → steps[0]
  });

  it('should fall back to glide for jump WITHOUT steps (§6)', () => {
    const p = preset(10, [
      { t: 0, carrier: pp(200, 'linear', { shape: 'sine', periodSec: 1, depth: 0.02, transition: 'jump' }) },
    ]);
    expect(modulatorAt(p, 'carrier', 0.25)).toBeCloseTo(4, 9); // continuous sine, not stepped
  });
});

// =====================================================================================
// Task 3 — valueAt combine rule, safety clamps, waveform readers
// =====================================================================================

describe('valueAt (Task 3)', () => {
  it('should add the modulator for carrier/beat and multiply it for volume (§4)', () => {
    const car = preset(10, [{ t: 0, carrier: pp(200, 'linear', { shape: 'sine', periodSec: 1, depth: 0.025 }) }]);
    expect(valueAt(car, 'carrier', 0.25)).toBeCloseTo(205, 9); // 200 + 5·sin(π/2)

    const vol = preset(10, [{ t: 0, volume: pp(0.5, 'linear', { shape: 'sine', periodSec: 1, depth: 0.4 }) }]);
    expect(valueAt(vol, 'volume', 0.25)).toBeCloseTo(0.5 * (1 + 0.4), 9); // base × (1+depth·1)
  });

  it('should clamp freq-depth so the instantaneous frequency stays ≥ FREQ_FLOOR (G1)', () => {
    // base 25, depth fraction min(1, 100/25)=1 → 25 Hz swing → effective depth = base − 1 = 24.
    const p = preset(10, [{ t: 0, carrier: pp(25, 'linear', { shape: 'sine', periodSec: 1, depth: 1 }) }]);
    // phase .75 → sin = −1 → value = 25 − 24 = 1 (floored, never below 1).
    expect(valueAt(p, 'carrier', 0.75)).toBeCloseTo(1, 6);
    // phase .25 → sin = +1 → value = 25 + 24 = 49.
    expect(valueAt(p, 'carrier', 0.25)).toBeCloseTo(49, 6);
  });

  it('should report tremolo above 1.0 as authored — no output clamp (A10)', () => {
    const p = preset(10, [{ t: 0, volume: pp(1, 'linear', { shape: 'sine', periodSec: 1, depth: 1 }) }]);
    expect(valueAt(p, 'volume', 0.25)).toBeCloseTo(2, 9); // 1 × (1 + 1·1) — not clamped to 1
  });
});

describe('waveform readers (Task 3)', () => {
  it('should carry forward the waveform with default sine (I2)', () => {
    const p = preset(10, [{ t: 0, carrier: pp(200) }]);
    expect(waveformAt(p, 5)).toBe('sine');
    const p2 = preset(10, [
      { t: 0, carrier: pp(200), waveform: 'square' },
      { t: 5, carrier: pp(200) },
    ]);
    expect(waveformAt(p2, 2)).toBe('square');
    expect(waveformAt(p2, 7)).toBe('square'); // carried forward
  });

  it('should deduplicate consecutive waveforms and always include the t=0 entry (I2/I3)', () => {
    const never = preset(10, [{ t: 0, carrier: pp(200) }]);
    expect(waveformKeyframes(never)).toEqual([{ t: 0, waveform: 'sine' }]);

    const p = preset(10, [
      { t: 0, carrier: pp(200), waveform: 'sine' },
      { t: 2, carrier: pp(200), waveform: 'square' },
      { t: 4, carrier: pp(200), waveform: 'square' }, // duplicate → dropped
      { t: 6, carrier: pp(200), waveform: 'triangle' },
    ]);
    expect(waveformKeyframes(p)).toEqual([
      { t: 0, waveform: 'sine' },
      { t: 2, waveform: 'square' },
      { t: 6, waveform: 'triangle' },
    ]);
  });

  it('should throw INVALID_TIME for a non-finite t in waveformAt', () => {
    const p = preset(10, [{ t: 0, carrier: pp(200) }]);
    expectAutomationError(() => waveformAt(p, NaN), 'INVALID_TIME');
  });
});

// =====================================================================================
// Task 4 — schedule the base curve onto a Voice (mock render)
// =====================================================================================

describe('schedule base curve (Task 4)', () => {
  it('should anchor at startOffsetSec and render == baseValueAt for a linear ramp', () => {
    const p = preset(10, [{ t: 0, carrier: pp(100) }, { t: 10, carrier: pp(200) }]);
    const { ctx, voice } = makeVoice();
    ctx.currentTime = 0;
    schedule(p, 'carrier', voice, { startTime: 0 });
    const car = mp(voice.carrierParam);
    expect(car.events[0]).toMatchObject({ method: 'setValueAtTime', value: 100, time: 0 });
    expect(car.methodLog).toContain('linearRampToValueAtTime');
    // Render parity: intrinsic timeline at t equals baseValueAt.
    for (const t of [0, 2.5, 5, 7.5, 10]) {
      expect(car.valueAtTime(t)).toBeCloseTo(baseValueAt(p, 'carrier', t), 6);
    }
  });

  it('should emit an exponential ramp for exp and a true step for carrier hold (D3)', () => {
    const exp = preset(10, [{ t: 0, carrier: pp(100, 'exp') }, { t: 10, carrier: pp(400) }]);
    const { voice } = makeVoice();
    schedule(exp, 'carrier', voice, { startTime: 0 });
    expect(mp(voice.carrierParam).methodLog).toContain('exponentialRampToValueAtTime');

    const hold = preset(10, [{ t: 0, carrier: pp(100, 'hold') }, { t: 10, carrier: pp(200) }]);
    const v2 = makeVoice();
    schedule(hold, 'carrier', v2.voice, { startTime: 0 });
    const car = mp(v2.voice.carrierParam);
    expect(car.methodLog).not.toContain('linearRampToValueAtTime'); // true step, no micro-ramp
    expect(car.valueAtTime(5)).toBe(100); // holds a
    expect(car.valueAtTime(10)).toBe(200); // steps to b at tj
  });

  it('should replace a volume hold with a 10 ms micro-ramp (D4)', () => {
    const p = preset(10, [{ t: 0, volume: pp(0.2, 'hold') }, { t: 5, volume: pp(0.9) }]);
    const { voice } = makeVoice();
    schedule(p, 'volume', voice, { startTime: 0 });
    const vol = mp(voice.volumeParam);
    expect(vol.methodLog).toContain('linearRampToValueAtTime');
    expect(vol.valueAtTime(4.999)).toBeCloseTo(0.2, 6); // holds until the step time
    expect(vol.valueAtTime(5 + VOLUME_MICRORAMP_SEC)).toBeCloseTo(0.9, 6); // reaches b after 10 ms
  });

  it('should schedule smooth as a polyline whose endpoints land on the smoothstep (D5)', () => {
    const p = preset(8, [{ t: 0, carrier: pp(100, 'smooth') }, { t: 8, carrier: pp(200) }]);
    const { voice } = makeVoice();
    schedule(p, 'carrier', voice, { startTime: 0 });
    const car = mp(voice.carrierParam);
    expect(car.methodLog).not.toContain('setValueCurveAtTime'); // never a curve (Firefox bug)
    const n = Math.min(Math.max(Math.round(8 / SMOOTH_SEGMENT_SEC), SMOOTH_MIN_SEGMENTS), SMOOTH_MAX_SEGMENTS);
    for (let j = 1; j <= n; j++) {
      const t = (8 * j) / n;
      expect(car.valueAtTime(t)).toBeCloseTo(baseValueAt(p, 'carrier', t), 5); // exact at sub-step endpoints
    }
  });

  it('should fall back to a linear ramp for an exp segment that hits 0 (D2/A8)', () => {
    const p = preset(10, [{ t: 0, volume: pp(1, 'exp') }, { t: 10, volume: pp(0) }]);
    const { voice } = makeVoice();
    schedule(p, 'volume', voice, { startTime: 0 });
    const vol = mp(voice.volumeParam);
    expect(vol.methodLog).not.toContain('exponentialRampToValueAtTime');
    expect(vol.valueAtTime(5)).toBeCloseTo(0.5, 6);
  });

  it('should skip intervals before startOffsetSec and anchor at the offset (H3)', () => {
    const p = preset(20, [
      { t: 0, carrier: pp(100) },
      { t: 10, carrier: pp(200) },
      { t: 20, carrier: pp(300) },
    ]);
    const { ctx, voice } = makeVoice();
    ctx.currentTime = 0;
    schedule(p, 'carrier', voice, { startTime: 0, startOffsetSec: 10 });
    const car = mp(voice.carrierParam);
    expect(car.events[0]).toMatchObject({ method: 'setValueAtTime', value: 200, time: 0 });
    // ctx time 5 ↔ preset time 15 → baseValueAt(p,'carrier',15) = 250.
    expect(car.valueAtTime(5)).toBeCloseTo(baseValueAt(p, 'carrier', 15), 6);
  });

  it('should anchor at the held last value when seeking past the end (H3)', () => {
    const p = preset(10, [{ t: 0, carrier: pp(100) }, { t: 10, carrier: pp(200) }]);
    const { voice } = makeVoice();
    schedule(p, 'carrier', voice, { startTime: 0, startOffsetSec: 50 });
    expect(mp(voice.carrierParam).events[0]).toMatchObject({ value: 200 });
  });

  it('should schedule silently on a suspended context without touching its state (H1)', () => {
    const p = preset(10, [{ t: 0, carrier: pp(100) }, { t: 10, carrier: pp(200) }]);
    const { ctx, voice } = makeVoice();
    expect(ctx.state).toBe('suspended');
    expect(() => schedule(p, 'carrier', voice, { startTime: 0 })).not.toThrow();
    expect(ctx.state).toBe('suspended');
    expect(mp(voice.carrierParam).events.length).toBeGreaterThan(0);
  });

  it('should treat stop()/dispose() as idempotent in any order (H5)', () => {
    const p = preset(10, [{ t: 0, carrier: pp(100) }, { t: 10, carrier: pp(200) }]);
    const { voice } = makeVoice();
    const lane = schedule(p, 'carrier', voice, { startTime: 0 });
    expect(() => {
      lane.dispose();
      lane.dispose();
      lane.stop();
    }).not.toThrow();
  });

  it('should propagate VOICE_STOPPED from a modulator helper on a stopped voice (H4)', () => {
    const p = preset(10, [{ t: 0, carrier: pp(200, 'linear', { shape: 'sine', periodSec: 1, depth: 0.025 }) }]);
    const { voice } = makeVoice();
    voice.start();
    voice.stop();
    try {
      schedule(p, 'carrier', voice, { startTime: 0 });
      throw new Error('expected VOICE_STOPPED');
    } catch (e) {
      expect(e).toBeInstanceOf(AudioEngineError);
      expect((e as AudioEngineError).code).toBe('VOICE_STOPPED');
    }
  });
});

// =====================================================================================
// Task 5 — modulator wiring (warble / pulse / steps)
// =====================================================================================

describe('schedule modulator wiring (Task 5)', () => {
  function warbleOscOf(ctx: MockAudioContext): MockOscillatorNode {
    return ctx.created.oscillators[2]; // after oscL, oscR
  }

  it('should start ONE warble osc per span and ramp frequency + depth (C1)', () => {
    const p = preset(10, [
      { t: 0, carrier: pp(200, 'linear', { shape: 'sine', periodSec: 1, depth: 0.025 }) },
      { t: 5, carrier: pp(200, 'linear', { shape: 'sine', periodSec: 0.5, depth: 0.04 }) },
    ]);
    const { ctx, voice } = makeVoice();
    schedule(p, 'carrier', voice, { startTime: 0 });
    expect(ctx.created.oscillators.length).toBe(3); // exactly one warble osc (node never re-created)
    const osc = warbleOscOf(ctx);
    expect(osc.started).toBe(true);
    expect(osc.startTime).toBe(0);
    expect(osc.frequency.methodLog).toContain('setValueAtTime');
    expect(osc.frequency.methodLog).toContain('linearRampToValueAtTime');
    // frequency ramps 1 Hz → 2 Hz across the span keyframes.
    expect(osc.frequency.valueAtTime(0)).toBeCloseTo(1, 9);
    expect(osc.frequency.valueAtTime(5)).toBeCloseTo(2, 9);
  });

  it('should clamp the warble depth so the instantaneous frequency stays ≥ FREQ_FLOOR (G1)', () => {
    const p = preset(10, [{ t: 0, carrier: pp(25, 'linear', { shape: 'sine', periodSec: 1, depth: 1 }) }]);
    const { ctx, voice } = makeVoice();
    schedule(p, 'carrier', voice, { startTime: 0 });
    const depthGain = ctx.created.gains[ctx.created.gains.length - 1];
    expect(depthGain.gain.valueAtTime(0)).toBeCloseTo(24, 6); // base − FREQ_FLOOR
  });

  describe('pulse / square (worklet)', () => {
    let uninstall: () => void;
    beforeEach(() => {
      uninstall = installAudioWorkletNode();
    });
    afterEach(() => uninstall());

    async function voiceWithWorklet(): Promise<{ ctx: MockAudioContext; voice: Voice }> {
      const { ctx, voice } = makeVoice();
      await registerPulseWorklet(asCtx(ctx));
      return { ctx, voice };
    }

    it('should wire a carrier pulse as depth=1 gate → GainNode(depth) → carrierParam', async () => {
      const p = preset(10, [
        { t: 0, carrier: pp(200, 'linear', { shape: 'pulse', periodSec: 1, depth: 0.03, pulseWidth: 0.5 }) },
      ]);
      const { ctx, voice } = await voiceWithWorklet();
      schedule(p, 'carrier', voice, { startTime: 0 });
      const node = ctx.created.worklets[0] as MockAudioWorkletNode;
      expect(node.parameters.get('depth').value).toBe(1); // clean 0..1 gate (set at creation)
      const gate = ctx.created.gains[ctx.created.gains.length - 1] as MockGainNode;
      expect(gate.gain.valueAtTime(0)).toBeCloseTo(6, 6); // gate scaled to depth
      expect(gate.isConnectedTo(mp(voice.carrierParam))).toBe(true);
    });

    it('should wire a volume pulse via attachVolumeModulator and pin square edge=0', async () => {
      const p = preset(10, [
        { t: 0, volume: pp(1, 'linear', { shape: 'square', periodSec: 1, depth: 0.7, pulseWidth: 0.5 }) },
      ]);
      const { ctx, voice } = await voiceWithWorklet();
      schedule(p, 'volume', voice, { startTime: 0 });
      const node = ctx.created.worklets[0] as MockAudioWorkletNode;
      expect(node.parameters.get('edgeWidth').valueAtTime(0)).toBe(0); // square → hard edges
      expect(node.parameters.get('depth').valueAtTime(0)).toBeCloseTo(0.7, 6);
      // envGain gated to 0 + worklet connected (replace-mode multiplicative modulator).
      expect(mp(voice.modVolumeParam).inputs.length).toBeGreaterThan(0);
    });

    it('should hold a LATE volume pulse silent (depth 0) until its span starts (regression: a gentle-wake isochronic must not pulse the whole binaural track)', async () => {
      const p = preset(20, [
        { t: 0, volume: pp(1, 'linear') },
        { t: 5, volume: pp(1, 'linear', { shape: 'pulse', periodSec: 0.25, depth: 0.5, pulseWidth: 0.5, edgeMs: 5 }) },
      ]);
      const { ctx, voice } = await voiceWithWorklet();
      schedule(p, 'volume', voice, { startTime: 0 });
      const depth = (ctx.created.worklets[0] as MockAudioWorkletNode).parameters.get('depth');
      // depth 0 ⇒ worklet output is a constant 1.0 ⇒ no volume modulation before the span.
      expect(depth.valueAtTime(0)).toBe(0);
      expect(depth.valueAtTime(2)).toBe(0);
      expect(depth.valueAtTime(5)).toBeCloseTo(0.5, 6); // real depth once the span begins
    });

    it('should hold a LATE carrier pulse gate at 0 until its span starts (regression)', async () => {
      const p = preset(20, [
        { t: 0, carrier: pp(200, 'linear') },
        { t: 5, carrier: pp(200, 'linear', { shape: 'pulse', periodSec: 1, depth: 0.03, pulseWidth: 0.5 }) },
      ]);
      const { ctx, voice } = await voiceWithWorklet();
      schedule(p, 'carrier', voice, { startTime: 0 });
      const gate = ctx.created.gains[ctx.created.gains.length - 1] as MockGainNode;
      expect(gate.gain.valueAtTime(0)).toBe(0); // gate gain 0 ⇒ no carrier swing before the span
      expect(gate.gain.valueAtTime(5)).toBeCloseTo(6, 6); // 0.03 × 200 Hz once the span begins
      expect(gate.isConnectedTo(mp(voice.carrierParam))).toBe(true);
    });

    it('should keep a pulse that starts at t=0 active immediately (no pre-gate)', async () => {
      const p = preset(10, [
        { t: 0, volume: pp(1, 'linear', { shape: 'pulse', periodSec: 0.25, depth: 0.5, pulseWidth: 0.5, edgeMs: 5 }) },
      ]);
      const { ctx, voice } = await voiceWithWorklet();
      schedule(p, 'volume', voice, { startTime: 0 });
      const depth = (ctx.created.worklets[0] as MockAudioWorkletNode).parameters.get('depth');
      expect(depth.valueAtTime(0)).toBeCloseTo(0.5, 6); // active from the first sample
    });

    it('should catch WORKLET_NOT_REGISTERED, keep the base curve, and set pulseUnavailable (F1)', () => {
      const p = preset(10, [
        { t: 0, carrier: pp(200, 'linear', { shape: 'pulse', periodSec: 1, depth: 0.03 }) },
      ]);
      const { voice } = makeVoice(); // worklet NOT registered
      const lane = schedule(p, 'carrier', voice, { startTime: 0 });
      expect(lane.pulseUnavailable).toBe(true);
      expect(mp(voice.carrierParam).events.length).toBeGreaterThan(0); // base still scheduled
    });

    it('should catch WORKLET_LOAD_FAILED the same way (F2)', async () => {
      const { ctx, voice } = makeVoice();
      ctx.audioWorklet.onAddModule = () => Promise.reject(new Error('no worklet'));
      await registerPulseWorklet(asCtx(ctx)).catch(() => {
        /* registration failed → createPulseNode will throw WORKLET_NOT_REGISTERED */
      });
      const p = preset(10, [
        { t: 0, carrier: pp(200, 'linear', { shape: 'pulse', periodSec: 1, depth: 0.03 }) },
      ]);
      const lane = schedule(p, 'carrier', voice, { startTime: 0 });
      expect(lane.pulseUnavailable).toBe(true);
    });
  });

  it('should step a ConstantSource offset at cycle boundaries for jump+steps', () => {
    const p = preset(10, [
      { t: 0, carrier: pp(200, 'linear', { periodSec: 1, transition: 'jump', steps: [3, 7, -2] }) },
    ]);
    const { ctx, voice } = makeVoice();
    schedule(p, 'carrier', voice, { startTime: 0 });
    const step = ctx.created.constantSources[3] as MockConstantSourceNode; // after carrierSource, beatSource, spatialSource
    expect(step.started).toBe(true);
    expect(step.isConnectedTo(mp(voice.carrierParam))).toBe(true);
    expect(step.offset.valueAtTime(0.5)).toBe(3); // cycle 0
    expect(step.offset.valueAtTime(1.5)).toBe(7); // cycle 1
    expect(step.offset.valueAtTime(2.5)).toBe(-2); // cycle 2
    // Combined carrier = base + held step (additive sum of the two ConstantSources).
    expect(computeParamValueAtTime(mp(voice.carrierParam), 1.5)).toBeCloseTo(207, 6);
  });
});

// =====================================================================================
// Task 6 — retarget + scheduleAll
// =====================================================================================

describe('retarget (Task 6)', () => {
  it('should use cancelAndHoldAtTime then reschedule from tr (E1)', () => {
    const p0 = preset(20, [{ t: 0, carrier: pp(100) }, { t: 20, carrier: pp(200) }]);
    const p1 = preset(20, [{ t: 0, carrier: pp(100) }, { t: 20, carrier: pp(400) }]);
    const { ctx, voice } = makeVoice({ supportsCancelAndHold: true });
    ctx.currentTime = 0;
    const lane = schedule(p0, 'carrier', voice, { startTime: 0 });
    ctx.currentTime = 5;
    lane.retarget(p1);
    const log = mp(voice.carrierParam).methodLog;
    expect(log).toContain('cancelAndHoldAtTime');
  });

  it('should fall back to cancelScheduledValues + a JS anchor (never param.value) on Firefox (E1/E2)', () => {
    const p0 = preset(20, [{ t: 0, carrier: pp(100) }, { t: 20, carrier: pp(200) }]);
    const p1 = preset(20, [{ t: 0, carrier: pp(100) }, { t: 20, carrier: pp(400) }]);
    const { ctx, voice } = makeVoice({ supportsCancelAndHold: false });
    ctx.currentTime = 0;
    const lane = schedule(p0, 'carrier', voice, { startTime: 0 });
    const car = mp(voice.carrierParam);
    car.value = 999; // simulate a stale Firefox param.value
    ctx.currentTime = 5;
    lane.retarget(p1);
    const idx = car.methodLog.indexOf('cancelScheduledValues');
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(car.methodLog).not.toContain('cancelAndHoldAtTime');
    const anchor = car.events.slice(idx + 1).find((e) => e.method === 'setValueAtTime');
    // tr = 5.02 → preset time 5.02 → baseValueAt(p0) ~ 100 + (200−100)·(5.02/20), NOT 999.
    expect(anchor?.value).toBeCloseTo(baseValueAt(p0, 'carrier', 5.02), 6);
    expect(anchor?.value).not.toBe(999);
  });

  it('should default atContextTime to now + RETARGET_LOOKAHEAD_SEC (E3)', () => {
    const p0 = preset(20, [{ t: 0, carrier: pp(100) }, { t: 20, carrier: pp(200) }]);
    const { ctx, voice } = makeVoice({ supportsCancelAndHold: false });
    ctx.currentTime = 5;
    const lane = schedule(p0, 'carrier', voice, { startTime: 0 });
    const before = mp(voice.carrierParam).events.length;
    lane.retarget(p0);
    const anchor = mp(voice.carrierParam).events.slice(before).find((e) => e.method === 'setValueAtTime');
    expect(anchor?.time).toBeCloseTo(5 + RETARGET_LOOKAHEAD_SEC, 9);
  });

  it('should floor a past atContextTime to ctx.currentTime (E3)', () => {
    const p0 = preset(20, [{ t: 0, carrier: pp(100) }, { t: 20, carrier: pp(200) }]);
    const { ctx, voice } = makeVoice({ supportsCancelAndHold: false });
    ctx.currentTime = 10;
    const lane = schedule(p0, 'carrier', voice, { startTime: 0 });
    const before = mp(voice.carrierParam).events.length;
    lane.retarget(p0, 2); // a past time
    for (const e of mp(voice.carrierParam).events.slice(before)) {
      if (e.time !== undefined) expect(e.time).toBeGreaterThanOrEqual(10);
    }
  });

  it('should KEEP the warble node when modulator identity is unchanged (C3)', () => {
    const p0 = preset(20, [{ t: 0, carrier: pp(200, 'linear', { shape: 'sine', periodSec: 1, depth: 0.025 }) }]);
    const p1 = preset(20, [{ t: 0, carrier: pp(200, 'linear', { shape: 'sine', periodSec: 0.5, depth: 0.045 }) }]);
    const { ctx, voice } = makeVoice();
    ctx.currentTime = 0;
    const lane = schedule(p0, 'carrier', voice, { startTime: 0 });
    expect(ctx.created.oscillators.length).toBe(3);
    ctx.currentTime = 5;
    lane.retarget(p1);
    expect(ctx.created.oscillators.length).toBe(3); // same warble osc kept (phase continuous)
    const osc = ctx.created.oscillators[2];
    // re-ramped toward the new period (0.5 s → 2 Hz) after tr.
    expect(osc.frequency.valueAtTime(10)).toBeCloseTo(2, 6);
  });

  it('should REBUILD the modulator when the shape changes (E4)', async () => {
    const uninstall = installAudioWorkletNode();
    try {
      const p0 = preset(20, [{ t: 0, carrier: pp(200, 'linear', { shape: 'sine', periodSec: 1, depth: 0.025 }) }]);
      const p1 = preset(20, [
        { t: 0, carrier: pp(200, 'linear', { shape: 'pulse', periodSec: 1, depth: 0.025, pulseWidth: 0.5 }) },
      ]);
      const { ctx, voice } = makeVoice();
      await registerPulseWorklet(asCtx(ctx));
      ctx.currentTime = 0;
      const lane = schedule(p0, 'carrier', voice, { startTime: 0 });
      expect(ctx.created.worklets.length).toBe(0);
      const oscBefore = ctx.created.oscillators[2];
      ctx.currentTime = 5;
      lane.retarget(p1);
      expect(ctx.created.worklets.length).toBe(1); // a pulse node was built (rebuild)
      expect(oscBefore.stopped).toBe(true); // old warble torn down
    } finally {
      uninstall();
    }
  });
});

describe('scheduleAll (Task 6)', () => {
  it('should expose the three lanes and fan retarget/stop/dispose to all of them', () => {
    const p = preset(10, [{ t: 0, carrier: pp(200), beat: pp(8), volume: pp(1) }, { t: 10, carrier: pp(300) }]);
    const { ctx, voice } = makeVoice();
    ctx.currentTime = 0;
    const sched = scheduleAll(p, voice, { startTime: 0 });
    expect(sched.lanes.carrier.param).toBe('carrier');
    expect(sched.lanes.beat.param).toBe('beat');
    expect(sched.lanes.volume.param).toBe('volume');
    // all three base params got events.
    expect(mp(voice.carrierParam).events.length).toBeGreaterThan(0);
    expect(mp(voice.beatParam).events.length).toBeGreaterThan(0);
    expect(mp(voice.volumeParam).events.length).toBeGreaterThan(0);
    ctx.currentTime = 5;
    const p2 = preset(10, [{ t: 0, carrier: pp(200), beat: pp(8), volume: pp(1) }, { t: 10, carrier: pp(500) }]);
    expect(() => {
      sched.retarget(p2);
      sched.stop();
      sched.dispose();
    }).not.toThrow();
  });
});

// =====================================================================================
// Task 7 — preview == playback parity + continuous phase
// =====================================================================================

describe('preview == playback parity (Task 7)', () => {
  it('should match baseValueAt against the rendered intrinsic timeline for every transition', () => {
    const p = preset(24, [
      { t: 0, carrier: pp(100, 'linear') },
      { t: 6, carrier: pp(300, 'exp') },
      { t: 12, carrier: pp(150, 'smooth') },
      { t: 18, carrier: pp(150, 'hold') },
      { t: 24, carrier: pp(220) },
    ]);
    const { voice } = makeVoice();
    schedule(p, 'carrier', voice, { startTime: 0 });
    const car = mp(voice.carrierParam);
    // Sample away from the hold step boundary (where preview reports the ideal step).
    for (const t of [0, 3, 6, 9, 12, 13.5, 15, 17.9, 18, 21, 24]) {
      expect(car.valueAtTime(t)).toBeCloseTo(baseValueAt(p, 'carrier', t), 4);
    }
  });

  it('should produce no amplitude discontinuity when the period ramps (C1)', () => {
    // period 2 s (0.5 Hz) → 0.25 s (4 Hz) across the span; sine depth 6.
    const p = preset(10, [
      { t: 0, carrier: pp(200, 'linear', { shape: 'sine', periodSec: 2, depth: 0.03 }) },
      { t: 8, carrier: pp(200, 'linear', { shape: 'sine', periodSec: 0.25, depth: 0.03 }) },
    ]);
    let prev = modulatorAt(p, 'carrier', 0);
    let maxJump = 0;
    for (let t = 0.002; t <= 8; t += 0.002) {
      const cur = modulatorAt(p, 'carrier', t);
      maxJump = Math.max(maxJump, Math.abs(cur - prev));
      prev = cur;
    }
    // Even at the fastest end (4 Hz, depth 6): 2π·4·6·dt ≈ 0.30 per 2 ms step — bounded, no jump.
    expect(maxJump).toBeLessThan(0.35);
  });

  it('should keep phase continuous and preview == playback across a retarget (C3)', () => {
    const p0 = preset(40, [{ t: 0, carrier: pp(200, 'linear', { shape: 'sine', periodSec: 1, depth: 0.025 }) }]);
    const p1 = preset(40, [{ t: 0, carrier: pp(260, 'linear', { shape: 'sine', periodSec: 1, depth: 0.01923 }) }]);
    const { ctx, voice } = makeVoice({ supportsCancelAndHold: true });
    ctx.currentTime = 0;
    const lane = schedule(p0, 'carrier', voice, { startTime: 0 });
    ctx.currentTime = 10;
    lane.retarget(p1);
    const car = mp(voice.carrierParam);
    // After tr the rendered base intrinsic tracks the NEW base (260) — preview == playback.
    expect(car.valueAtTime(20)).toBeCloseTo(baseValueAt(p1, 'carrier', 20), 4);
    // Warble osc kept (single node) → phase continuous through the edit.
    expect(ctx.created.oscillators.length).toBe(3);
  });
});

// =====================================================================================
// BOX / TRAPEZOID shape — breath modulator on any warbled param
// =====================================================================================

describe('box shape — pure trajectory (modulatorAt / valueAt)', () => {
  // period 4 s (0.25 Hz) → one breath every 4 s; depth fraction 0.05 of base 200 = 10 Hz on the carrier offset.
  const boxMod = (pulseWidth: number, depth = 0.05) => ({ shape: 'box' as const, periodSec: 4, depth, pulseWidth });

  it('h=0.5 traces the even 4-4-4-4 box: trough, peak, both holds (additive depth·u)', () => {
    const p = preset(20, [{ t: 0, carrier: pp(200, 'linear', boxMod(0.5)) }]);
    // φ = t/4. inhale [0,1): −1→+1; hold-high [1,2): +1; exhale [2,3): +1→−1; hold-low [3,4): −1.
    expect(modulatorAt(p, 'carrier', 0)).toBeCloseTo(-10, 9); // trough (inhale start)
    expect(modulatorAt(p, 'carrier', 0.5)).toBeCloseTo(0, 9); // mid-inhale ramp
    expect(modulatorAt(p, 'carrier', 1)).toBeCloseTo(10, 9); // peak (inhale end)
    expect(modulatorAt(p, 'carrier', 1.5)).toBeCloseTo(10, 9); // inhale-hold (flat at +1)
    expect(modulatorAt(p, 'carrier', 2.5)).toBeCloseTo(0, 9); // mid-exhale ramp
    expect(modulatorAt(p, 'carrier', 3)).toBeCloseTo(-10, 9); // trough (exhale end)
    expect(modulatorAt(p, 'carrier', 3.5)).toBeCloseTo(-10, 9); // exhale-hold (flat at −1)
    expect(modulatorAt(p, 'carrier', 4.5)).toBeCloseTo(0, 9); // next breath: mid-inhale again
  });

  it('h=0 collapses to a pure triangle sweep (no holds, coherent breathing)', () => {
    const p = preset(20, [{ t: 0, carrier: pp(200, 'linear', boxMod(0)) }]);
    // rampFrac=0.5: −1 at φ0, +1 at φ0.5, −1 at φ1 — a symmetric triangle, no flats.
    expect(modulatorAt(p, 'carrier', 0)).toBeCloseTo(-10, 9);
    expect(modulatorAt(p, 'carrier', 1)).toBeCloseTo(0, 9); // quarter up the inhale
    expect(modulatorAt(p, 'carrier', 2)).toBeCloseTo(10, 9); // peak at mid-cycle
    expect(modulatorAt(p, 'carrier', 3)).toBeCloseTo(0, 9); // quarter down the exhale
  });

  it('defaults the hold ratio to 0.5 when pulseWidth is omitted', () => {
    const noPw = preset(20, [{ t: 0, carrier: pp(200, 'linear', { shape: 'box', periodSec: 4, depth: 0.05 }) }]);
    const half = preset(20, [{ t: 0, carrier: pp(200, 'linear', boxMod(0.5)) }]);
    for (const t of [0, 0.5, 1, 1.5, 2.5, 3]) {
      expect(modulatorAt(noPw, 'carrier', t)).toBeCloseTo(modulatorAt(half, 'carrier', t), 9);
    }
  });

  it('integrates phase analytically across a ramped period (continuous phase)', () => {
    // period 4 s (f0=0.25) → period 2 s (f1=0.5) across [0,2]; depth 8, h=0.5.
    const p = preset(20, [
      { t: 0, carrier: pp(200, 'linear', { shape: 'box', periodSec: 4, depth: 0.04, pulseWidth: 0.5 }) },
      { t: 2, carrier: pp(200, 'linear', { shape: 'box', periodSec: 2, depth: 0.04, pulseWidth: 0.5 }) },
    ]);
    // phase(0.5) = f0·Δt + 0.5·slope·Δt² = 0.25·0.5 + 0.5·0.125·0.5² = 0.140625 cycles (mid-inhale).
    // boxUnit(0.140625, 0.5) = −1 + 2·(0.140625/0.25) = 0.125 → ×8 = 1.0.
    expect(modulatorAt(p, 'carrier', 0.5)).toBeCloseTo(1.0, 9);
    // phase(1) = 0.25·1 + 0.5·0.125·1² = 0.3125 → inhale already complete (+1) → ×8 = 8.
    expect(modulatorAt(p, 'carrier', 1)).toBeCloseTo(8.0, 9);
  });

  it('stays continuous (no jump) even as the period ramps', () => {
    const p = preset(12, [
      { t: 0, carrier: pp(200, 'linear', { shape: 'box', periodSec: 4, depth: 0.05, pulseWidth: 0.5 }) },
      { t: 8, carrier: pp(200, 'linear', { shape: 'box', periodSec: 1, depth: 0.05, pulseWidth: 0.5 }) },
    ]);
    let prev = modulatorAt(p, 'carrier', 0);
    let maxJump = 0;
    for (let t = 0.002; t <= 8; t += 0.002) {
      const cur = modulatorAt(p, 'carrier', t);
      maxJump = Math.max(maxJump, Math.abs(cur - prev));
      prev = cur;
    }
    expect(maxJump).toBeLessThan(0.2); // trapezoid is C0-continuous — only gentle ramps
  });

  it('maps additive (carrier) bipolar and volume into [1−depth, 1]', () => {
    const car = preset(20, [{ t: 0, carrier: pp(200, 'linear', boxMod(0.5)) }]);
    expect(valueAt(car, 'carrier', 1)).toBeCloseTo(210, 9); // peak → base + depth
    expect(valueAt(car, 'carrier', 3)).toBeCloseTo(190, 9); // trough → base − depth

    const vol = preset(20, [{ t: 0, volume: pp(0.8, 'linear', { shape: 'box', periodSec: 4, depth: 0.5, pulseWidth: 0.5 }) }]);
    // multiplier ∈ [1−depth, 1] = [0.5, 1]; valueAt = base × multiplier.
    expect(valueAt(vol, 'volume', 1)).toBeCloseTo(0.8 * 1, 9); // peak → full
    expect(valueAt(vol, 'volume', 3)).toBeCloseTo(0.8 * 0.5, 9); // trough → 1−depth
    expect(valueAt(vol, 'volume', 2.5)).toBeCloseTo(0.8 * 0.75, 9); // mid-exhale → 1−depth/2
  });

  it('works on the spatial pan (the primary breath target)', () => {
    const sp = preset(20, [{ t: 0, spatial: pp(0, 'linear', { shape: 'box', periodSec: 4, depth: 1, pulseWidth: 0.5 }) }]);
    expect(valueAt(sp, 'spatial', 1)).toBeCloseTo(1, 9); // full right at the inhale peak
    expect(valueAt(sp, 'spatial', 3)).toBeCloseTo(-1, 9); // full left at the exhale trough
    expect(valueAt(sp, 'spatial', 1.5)).toBeCloseTo(1, 9); // held right through the hold
  });

  it('ignores steps for box (drives the trapezoid, not a sample-and-hold list)', () => {
    const p = preset(20, [
      { t: 0, carrier: pp(200, 'linear', { shape: 'box', periodSec: 4, depth: 0.05, pulseWidth: 0.5, transition: 'jump', steps: [99, -99] }) },
    ]);
    // If steps were honoured this would be 99/−99; box ignores them → smooth trapezoid.
    expect(modulatorAt(p, 'carrier', 1)).toBeCloseTo(10, 9);
    expect(modulatorAt(p, 'carrier', 3)).toBeCloseTo(-10, 9);
  });
});

describe('box shape — scheduled output == preview parity (mock render)', () => {
  function boxSourceOf(ctx: MockAudioContext): MockConstantSourceNode {
    // after carrierSource, beatSource, spatialSource → the automation-owned box source.
    return ctx.created.constantSources[ctx.created.constantSources.length - 1];
  }

  it('schedules an additive carrier box: a started ConstantSource summed onto carrierParam', () => {
    const p = preset(20, [{ t: 0, carrier: pp(200, 'linear', { shape: 'box', periodSec: 4, depth: 0.05, pulseWidth: 0.5 }) }]);
    const { ctx, voice } = makeVoice();
    ctx.currentTime = 0;
    schedule(p, 'carrier', voice, { startTime: 0 });
    const box = boxSourceOf(ctx);
    expect(box.started).toBe(true);
    expect(box.isConnectedTo(mp(voice.carrierParam))).toBe(true);
    // No warble osc / worklet for box (it is a scheduled ConstantSource only).
    expect(ctx.created.oscillators.length).toBe(2); // oscL, oscR only
    expect(ctx.created.worklets.length).toBe(0);
  });

  it('the rendered carrier (base + box offset) matches valueAt at ramp, hold and trough samples', () => {
    const p = preset(20, [{ t: 0, carrier: pp(200, 'linear', { shape: 'box', periodSec: 4, depth: 0.05, pulseWidth: 0.5 }) }]);
    const { ctx, voice } = makeVoice();
    ctx.currentTime = 0;
    schedule(p, 'carrier', voice, { startTime: 0 });
    const car = mp(voice.carrierParam);
    for (const t of [0.5, 0.7, 1, 1.5, 2, 2.5, 3, 3.5, 5, 6.5, 7, 9, 9.5]) {
      expect(computeParamValueAtTime(car, t)).toBeCloseTo(valueAt(p, 'carrier', t), 6);
    }
  });

  it('the rendered volume multiplier matches valueAt (mapped into [1−depth, 1])', () => {
    const p = preset(20, [{ t: 0, volume: pp(1, 'linear', { shape: 'box', periodSec: 4, depth: 0.5, pulseWidth: 0.5 }) }]);
    const { ctx, voice } = makeVoice();
    ctx.currentTime = 0;
    schedule(p, 'volume', voice, { startTime: 0 });
    // box volume rides on the multiplicative envelope (modVolumeParam) via attachVolumeModulator.
    expect(mp(voice.modVolumeParam).inputs.length).toBeGreaterThan(0);
    for (const t of [1, 1.5, 2, 2.5, 3, 5, 6.5, 9]) {
      // base = 1 → the rendered multiplier equals valueAt(volume) directly.
      expect(computeParamValueAtTime(mp(voice.modVolumeParam), t)).toBeCloseTo(valueAt(p, 'volume', t), 6);
    }
  });

  it('reproduces the h=0 triangle sweep when rendered', () => {
    const p = preset(20, [{ t: 0, carrier: pp(200, 'linear', { shape: 'box', periodSec: 4, depth: 0.05, pulseWidth: 0 }) }]);
    const { ctx, voice } = makeVoice();
    ctx.currentTime = 0;
    schedule(p, 'carrier', voice, { startTime: 0 });
    const car = mp(voice.carrierParam);
    for (const t of [0.5, 1, 1.5, 2, 2.5, 3, 3.5]) {
      expect(computeParamValueAtTime(car, t)).toBeCloseTo(valueAt(p, 'carrier', t), 6);
    }
  });

  it('rebuilds the box source on retarget (re-anchored, no stale wiring)', () => {
    const p0 = preset(40, [{ t: 0, carrier: pp(200, 'linear', { shape: 'box', periodSec: 4, depth: 0.05, pulseWidth: 0.5 }) }]);
    const p1 = preset(40, [{ t: 0, carrier: pp(200, 'linear', { shape: 'box', periodSec: 4, depth: 0.03, pulseWidth: 0.5 }) }]);
    const { ctx, voice } = makeVoice({ supportsCancelAndHold: true });
    ctx.currentTime = 0;
    const lane = schedule(p0, 'carrier', voice, { startTime: 0 });
    const first = boxSourceOf(ctx);
    ctx.currentTime = 10;
    lane.retarget(p1);
    expect(first.stopped).toBe(true); // old box torn down
    expect(ctx.created.constantSources.length).toBeGreaterThan(4); // a fresh box source built
  });
});
