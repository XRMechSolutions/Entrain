import {
  createVoice,
  registerPulseWorklet,
  AudioEngineError,
  PULSE_PROCESSOR_NAME,
  type Voice,
  type Waveform,
  type AudioEngineErrorCode,
} from './audio-engine';
import {
  MockAudioContext,
  MockAudioNode,
  type MockAudioParam,
  type MockOscillatorNode,
  type MockConstantSourceNode,
  type MockGainNode,
  type MockChannelMergerNode,
  type MockWaveShaperNode,
  computeParamValue,
  installAudioWorkletNode,
} from '../test/webaudio-mock';

// --- helpers ---------------------------------------------------------------

const asCtx = (ctx: MockAudioContext): BaseAudioContext =>
  ctx as unknown as BaseAudioContext;
const mp = (p: AudioParam): MockAudioParam => p as unknown as MockAudioParam;
const mn = (n: AudioNode): MockAudioNode => n as unknown as MockAudioNode;

interface Graph {
  oscL: MockOscillatorNode;
  oscR: MockOscillatorNode;
  carrierSource: MockConstantSourceNode;
  beatSource: MockConstantSourceNode;
  spatialSource: MockConstantSourceNode;
  splitL: MockGainNode;
  splitR: MockGainNode;
  gainL: MockGainNode;
  gainR: MockGainNode;
  panGainL: MockGainNode;
  panGainR: MockGainNode;
  negR: MockGainNode;
  spatialAttenL: MockGainNode;
  spatialAttenR: MockGainNode;
  shaperL: MockWaveShaperNode;
  shaperR: MockWaveShaperNode;
  envGain: MockGainNode;
  volumeGain: MockGainNode;
  masterGain: MockGainNode;
  merger: MockChannelMergerNode;
}

// Reads the internal graph by creation order (see createVoice node-build order).
function graphOf(ctx: MockAudioContext): Graph {
  const [oscL, oscR] = ctx.created.oscillators;
  const [carrierSource, beatSource, spatialSource] = ctx.created.constantSources;
  const [splitL, splitR, gainL, gainR, panGainL, panGainR, negR, spatialAttenL, spatialAttenR, envGain, volumeGain, masterGain] =
    ctx.created.gains;
  const [shaperL, shaperR] = ctx.created.waveShapers;
  const [merger] = ctx.created.mergers;
  return {
    oscL, oscR, carrierSource, beatSource, spatialSource, splitL, splitR, gainL, gainR,
    panGainL, panGainR, negR, spatialAttenL, spatialAttenR, shaperL, shaperR,
    envGain, volumeGain, masterGain, merger,
  };
}

function expectAudioError(fn: () => unknown, code: AudioEngineErrorCode): AudioEngineError {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(AudioEngineError);
    expect((e as AudioEngineError).code).toBe(code);
    return e as AudioEngineError;
  }
  throw new Error(`expected AudioEngineError(${code}) but nothing was thrown`);
}

function makeVoice(opts?: Parameters<typeof createVoice>[1], ctxOpts?: ConstructorParameters<typeof MockAudioContext>[0]): {
  ctx: MockAudioContext;
  voice: Voice;
} {
  const ctx = new MockAudioContext(ctxOpts);
  const voice = createVoice(asCtx(ctx), opts);
  return { ctx, voice };
}

// =====================================================================================
// Task 1 — static graph, AudioEngineError, types, raw handles + output tap
// =====================================================================================

describe('createVoice — node graph (Task 1)', () => {
  it('should build an idle voice whose output (masterGain) is connected to destination', () => {
    const { ctx, voice } = makeVoice();
    const g = graphOf(ctx);
    expect(voice.state).toBe('idle');
    expect(voice.output).toBe(g.masterGain);
    expect(g.masterGain.isConnectedTo(ctx.destination)).toBe(true);
  });

  it('should start masterGain.gain at 0 (silent start for click-free transport fade-in)', () => {
    const { voice } = makeVoice();
    expect(mp(voice.masterGainParam).value).toBe(0);
  });

  it('should apply documented defaults (carrier 200, beat 4, volume 1, sine)', () => {
    const { ctx, voice } = makeVoice();
    const g = graphOf(ctx);
    expect(mp(voice.carrierParam).value).toBe(200);
    expect(mp(voice.beatParam).value).toBe(4);
    expect(mp(voice.volumeParam).value).toBe(1);
    expect(g.oscL.type).toBe('sine');
    expect(g.oscR.type).toBe('sine');
  });

  it('should apply explicit options (clamped) over defaults', () => {
    const { ctx, voice } = makeVoice({ waveform: 'triangle', carrierHz: 5000, beatHz: -3, volume: 1.7 });
    const g = graphOf(ctx);
    expect(g.oscL.type).toBe('triangle');
    expect(mp(voice.carrierParam).value).toBe(1000); // clamped 20..1000
    expect(mp(voice.beatParam).value).toBe(0); // clamped 0..35
    expect(mp(voice.volumeParam).value).toBe(1); // clamped 0..1
  });

  it('should keep oscillator intrinsic frequency at 0, sourcing all frequency from the ConstantSources', () => {
    const { ctx } = makeVoice();
    const g = graphOf(ctx);
    expect(g.oscL.frequency.value).toBe(0);
    expect(g.oscR.frequency.value).toBe(0);
  });

  it('should sum carrier (+1 both ears) and beat (split ∓0.5) to fL=carrier−beat/2, fR=carrier+beat/2', () => {
    const { ctx } = makeVoice({ carrierHz: 200, beatHz: 4 });
    const g = graphOf(ctx);
    // carrier feeds both oscillators; beat feeds the split gains.
    expect(g.carrierSource.isConnectedTo(g.oscL.frequency)).toBe(true);
    expect(g.carrierSource.isConnectedTo(g.oscR.frequency)).toBe(true);
    expect(g.beatSource.isConnectedTo(g.splitL)).toBe(true);
    expect(g.beatSource.isConnectedTo(g.splitR)).toBe(true);
    expect(g.splitL.isConnectedTo(g.oscL.frequency)).toBe(true);
    expect(g.splitR.isConnectedTo(g.oscR.frequency)).toBe(true);
    expect(g.splitL.gain.value).toBe(-0.5);
    expect(g.splitR.gain.value).toBe(0.5);
    // Evaluated like the spec's Computation of Value: intrinsic + Σ inputs.
    expect(computeParamValue(g.oscL.frequency)).toBeCloseTo(198, 9); // 200 − 4/2
    expect(computeParamValue(g.oscR.frequency)).toBeCloseTo(202, 9); // 200 + 4/2
  });

  it('should expose the five raw AudioParam handles bound to the right nodes', () => {
    const { ctx, voice } = makeVoice();
    const g = graphOf(ctx);
    expect(voice.carrierParam).toBe(g.carrierSource.offset);
    expect(voice.beatParam).toBe(g.beatSource.offset);
    expect(voice.volumeParam).toBe(g.volumeGain.gain);
    expect(voice.modVolumeParam).toBe(g.envGain.gain);
    expect(voice.masterGainParam).toBe(g.masterGain.gain);
  });

  it('should wire the post-merge chain merger → envGain → volumeGain → masterGain', () => {
    const { ctx } = makeVoice();
    const g = graphOf(ctx);
    expect(g.merger.isConnectedTo(g.envGain)).toBe(true);
    expect(g.envGain.isConnectedTo(g.volumeGain)).toBe(true);
    expect(g.volumeGain.isConnectedTo(g.masterGain)).toBe(true);
    // The spatial pan-gain pair sits between the static ear gains and the merger (§2.7).
    expect(g.gainL.isConnectedTo(g.panGainL)).toBe(true);
    expect(g.gainR.isConnectedTo(g.panGainR)).toBe(true);
    expect(g.panGainL.isConnectedTo(g.merger)).toBe(true);
    expect(g.panGainR.isConnectedTo(g.merger)).toBe(true);
  });

  // Errors (A3)
  it('should throw INVALID_PARAMETER for an unknown waveform string', () => {
    const ctx = new MockAudioContext();
    expectAudioError(() => createVoice(asCtx(ctx), { waveform: 'wobble' as Waveform }), 'INVALID_PARAMETER');
  });

  it('should throw INVALID_PARAMETER for a non-finite option', () => {
    const ctx = new MockAudioContext();
    expectAudioError(() => createVoice(asCtx(ctx), { carrierHz: NaN }), 'INVALID_PARAMETER');
    expectAudioError(() => createVoice(asCtx(ctx), { beatHz: Infinity }), 'INVALID_PARAMETER');
  });

  it('should throw INVALID_PARAMETER for a bad context', () => {
    expectAudioError(() => createVoice(null as unknown as BaseAudioContext), 'INVALID_PARAMETER');
    expectAudioError(() => createVoice({} as unknown as BaseAudioContext), 'INVALID_PARAMETER');
  });

  // Edge (H3, H2)
  it('should accept an OfflineAudioContext-style BaseAudioContext (any sampleRate) (H3)', () => {
    const { ctx, voice } = makeVoice(undefined, { sampleRate: 44100 });
    expect(voice.state).toBe('idle');
    expect(ctx.sampleRate).toBe(44100);
    expect(computeParamValue(graphOf(ctx).oscL.frequency)).toBeCloseTo(198, 9);
  });

  it('should fan output out to two destinations losslessly (H2)', () => {
    const { ctx, voice } = makeVoice();
    const dest2 = new MockAudioNode(ctx, 'destination');
    mn(voice.output).connect(dest2);
    expect(mn(voice.output).isConnectedTo(ctx.destination)).toBe(true);
    expect(mn(voice.output).isConnectedTo(dest2)).toBe(true);
  });
});

describe('AudioEngineError (Task 1)', () => {
  it('should carry a code, message and optional cause', () => {
    const cause = new Error('boom');
    const err = new AudioEngineError('WORKLET_LOAD_FAILED', 'load failed', cause);
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(AudioEngineError);
    expect(err.code).toBe('WORKLET_LOAD_FAILED');
    expect(err.message).toBe('load failed');
    expect(err.cause).toBe(cause);
  });
});

// =====================================================================================
// Task 2 — imperative no-click setters
// =====================================================================================

describe('imperative setters (Task 2)', () => {
  it('should clamp carrier to 20..1000 then ramp 10 ms linearly', () => {
    const { ctx, voice } = makeVoice();
    ctx.currentTime = 5;
    voice.setCarrier(5000);
    const p = mp(voice.carrierParam);
    expect(p.value).toBe(1000);
    const ramp = p.events.find((e) => e.method === 'linearRampToValueAtTime');
    const anchor = p.events.find((e) => e.method === 'setValueAtTime');
    expect(ramp?.value).toBe(1000);
    expect(anchor?.time).toBe(5);
    expect(ramp?.time).toBeCloseTo(5.01, 9); // 10 ms ramp
  });

  it('should clamp beat to 0..35', () => {
    const { voice } = makeVoice();
    voice.setBeat(100);
    expect(mp(voice.beatParam).value).toBe(35);
    voice.setBeat(-5);
    expect(mp(voice.beatParam).value).toBe(0);
  });

  it('should ramp a gain to 0 with a linear ramp (can reach 0)', () => {
    const { voice } = makeVoice();
    voice.setVolume(0);
    expect(mp(voice.volumeParam).value).toBe(0);
    expect(mp(voice.volumeParam).methodLog).toContain('linearRampToValueAtTime');
  });

  it('should map setBalance pan to ear gains (0→1/1, −1→1/0, +1→0/1)', () => {
    const { ctx, voice } = makeVoice();
    const g = graphOf(ctx);
    voice.setBalance(0);
    expect(g.gainL.gain.value).toBe(1);
    expect(g.gainR.gain.value).toBe(1);
    voice.setBalance(-1);
    expect(g.gainL.gain.value).toBe(1);
    expect(g.gainR.gain.value).toBe(0);
    voice.setBalance(1);
    expect(g.gainL.gain.value).toBe(0);
    expect(g.gainR.gain.value).toBe(1);
  });

  it('should clamp pan to −1..1', () => {
    const { ctx, voice } = makeVoice();
    const g = graphOf(ctx);
    voice.setBalance(-3);
    expect(g.gainL.gain.value).toBe(1);
    expect(g.gainR.gain.value).toBe(0);
  });

  it('should set both oscillator types immediately on setWaveform (D5, not ramped)', () => {
    const { ctx, voice } = makeVoice();
    const g = graphOf(ctx);
    voice.setWaveform('square');
    expect(g.oscL.type).toBe('square');
    expect(g.oscR.type).toBe('square');
  });

  // Errors (A1)
  it('should throw INVALID_PARAMETER and never write the param for NaN/±Infinity', () => {
    const { voice } = makeVoice();
    const p = mp(voice.carrierParam);
    const before = p.events.length;
    expectAudioError(() => voice.setCarrier(NaN), 'INVALID_PARAMETER');
    expectAudioError(() => voice.setVolume(Infinity), 'INVALID_PARAMETER');
    expectAudioError(() => voice.setBeat(-Infinity), 'INVALID_PARAMETER');
    expect(p.events.length).toBe(before); // never written
    expect(p.value).toBe(200); // unchanged
  });

  // Edge (E1, E2, E3, D2)
  it('should anchor a re-ramp from the JS-tracked value, not the (possibly stale) param.value (E2)', () => {
    const { voice } = makeVoice();
    voice.setVolume(0.5);
    const p = mp(voice.volumeParam);
    p.value = 0.123; // simulate Firefox returning a stale param.value
    const before = p.events.length;
    voice.setVolume(0.8);
    const anchor = p.events.slice(before).find((e) => e.method === 'setValueAtTime');
    expect(anchor?.value).toBe(0.5); // tracked value, not 0.123
  });

  it('should use cancelAndHoldAtTime when available (E1)', () => {
    const { voice } = makeVoice(undefined, { supportsCancelAndHold: true });
    voice.setVolume(0.4);
    const log = mp(voice.volumeParam).methodLog;
    expect(log[0]).toBe('cancelAndHoldAtTime');
    expect(log).toContain('setValueAtTime');
    expect(log).toContain('linearRampToValueAtTime');
  });

  it('should fall back to cancelScheduledValues + setValueAtTime when cancelAndHoldAtTime is absent (E1)', () => {
    const { voice } = makeVoice(undefined, { supportsCancelAndHold: false });
    voice.setVolume(0.4);
    const log = mp(voice.volumeParam).methodLog;
    expect(log).not.toContain('cancelAndHoldAtTime');
    expect(log[0]).toBe('cancelScheduledValues');
    expect(log[1]).toBe('setValueAtTime');
    expect(log[2]).toBe('linearRampToValueAtTime');
  });

  it('should never use exponentialRamp or setValueCurveAtTime (D2, E3)', () => {
    const { ctx, voice } = makeVoice();
    voice.setCarrier(300);
    voice.setBeat(8);
    voice.setVolume(0.6);
    voice.setMasterGain(0.7);
    voice.setBalance(0.3);
    voice.setSpatial(0.4);
    const g = graphOf(ctx);
    const allParams = [
      g.carrierSource.offset,
      g.beatSource.offset,
      g.volumeGain.gain,
      g.masterGain.gain,
      g.gainL.gain,
      g.gainR.gain,
      g.spatialSource.offset,
    ];
    for (const param of allParams) {
      expect(param.methodLog).not.toContain('exponentialRampToValueAtTime');
      expect(param.methodLog).not.toContain('setValueCurveAtTime');
    }
  });

  it('should record the master trim while ramping masterGain.gain', () => {
    const { voice } = makeVoice();
    voice.setMasterGain(1.5); // clamp to 1
    expect(mp(voice.masterGainParam).value).toBe(1);
  });
});

// =====================================================================================
// Task 3 — lifecycle state machine
// =====================================================================================

describe('lifecycle (Task 3)', () => {
  it('should start all five sources at one shared t0 and transition idle→running', () => {
    const { ctx, voice } = makeVoice();
    const g = graphOf(ctx);
    ctx.currentTime = 2;
    expect(voice.state).toBe('idle');
    voice.start();
    expect(voice.state).toBe('running');
    for (const src of [g.oscL, g.oscR, g.carrierSource, g.beatSource, g.spatialSource]) {
      expect(src.started).toBe(true);
      expect(src.startTime).toBe(2);
    }
  });

  it('should stop all five sources and transition running→stopped (terminal)', () => {
    const { ctx, voice } = makeVoice();
    const g = graphOf(ctx);
    voice.start();
    ctx.currentTime = 9;
    voice.stop();
    expect(voice.state).toBe('stopped');
    for (const src of [g.oscL, g.oscR, g.carrierSource, g.beatSource, g.spatialSource]) {
      expect(src.stopped).toBe(true);
      expect(src.stopTime).toBe(9);
    }
  });

  it('should throw VOICE_ALREADY_STARTED on a second start (B1)', () => {
    const { voice } = makeVoice();
    voice.start();
    expectAudioError(() => voice.start(), 'VOICE_ALREADY_STARTED');
  });

  it('should throw VOICE_STOPPED for any operation after stop (B2)', () => {
    const { voice } = makeVoice();
    voice.start();
    voice.stop();
    expectAudioError(() => voice.setCarrier(300), 'VOICE_STOPPED');
    expectAudioError(() => voice.setBeat(8), 'VOICE_STOPPED');
    expectAudioError(() => voice.setVolume(0.5), 'VOICE_STOPPED');
    expectAudioError(() => voice.setMasterGain(0.5), 'VOICE_STOPPED');
    expectAudioError(() => voice.setBalance(0.2), 'VOICE_STOPPED');
    expectAudioError(() => voice.setSpatial(0.2), 'VOICE_STOPPED');
    expectAudioError(() => voice.setWaveform('square'), 'VOICE_STOPPED');
    expectAudioError(() => voice.start(), 'VOICE_STOPPED');
    expectAudioError(() => voice.connectWarble(voice.carrierParam), 'VOICE_STOPPED');
    expectAudioError(() => voice.createPulseNode(), 'VOICE_STOPPED');
    expectAudioError(() => voice.attachVolumeModulator(voice.output), 'VOICE_STOPPED');
  });

  it('should treat dispose() as an idempotent no-op (twice, and before start) (B4)', () => {
    const { ctx, voice } = makeVoice();
    const g = graphOf(ctx);
    expect(() => voice.dispose()).not.toThrow(); // before start
    expect(g.masterGain.disconnectCalls).toBeGreaterThan(0);
    expect(() => voice.dispose()).not.toThrow(); // twice
  });

  it('should pass stop(atTime) in the past through unchanged (B5)', () => {
    const { ctx, voice } = makeVoice();
    const g = graphOf(ctx);
    ctx.currentTime = 10;
    voice.start();
    voice.stop(3); // a past time
    expect(g.oscL.stopTime).toBe(3);
    expect(g.beatSource.stopTime).toBe(3);
  });

  it('should schedule on a suspended context without inspecting or changing ctx.state (B3, C1)', () => {
    const { ctx, voice } = makeVoice();
    expect(ctx.state).toBe('suspended');
    voice.start();
    expect(voice.state).toBe('running');
    expect(ctx.state).toBe('suspended'); // engine never touched context state
    expect(graphOf(ctx).oscL.started).toBe(true);
  });
});

// =====================================================================================
// Spatial pan (D-021) — ILD pan-gain pair + spatialParam + setSpatial
// =====================================================================================

describe('spatial pan (D-021)', () => {
  it('exposes spatialParam bound to spatialSource.offset, defaulting to 0 (center)', () => {
    const { ctx, voice } = makeVoice();
    const g = graphOf(ctx);
    expect(voice.spatialParam).toBe(g.spatialSource.offset);
    expect(mp(voice.spatialParam).value).toBe(0);
    expect(g.panGainL.gain.value).toBe(1);
    expect(g.panGainR.gain.value).toBe(1);
  });

  it('maps centre 0 → both ears at unity (no effect)', () => {
    const { ctx, voice } = makeVoice();
    const g = graphOf(ctx);
    voice.setSpatial(0);
    expect(computeParamValue(g.panGainL.gain)).toBeCloseTo(1, 9);
    expect(computeParamValue(g.panGainR.gain)).toBeCloseTo(1, 9);
  });

  it('keeps the near ear at unity and floors the far ear at full pan (constant-loudness law)', () => {
    const { ctx, voice } = makeVoice();
    const g = graphOf(ctx);
    voice.setSpatial(1); // full right
    expect(computeParamValue(g.panGainR.gain)).toBeCloseTo(1, 9); // near ear unity
    expect(computeParamValue(g.panGainL.gain)).toBeCloseTo(0.25, 9); // far ear floored (−12 dB)
    voice.setSpatial(-1); // full left
    expect(computeParamValue(g.panGainL.gain)).toBeCloseTo(1, 9);
    expect(computeParamValue(g.panGainR.gain)).toBeCloseTo(0.25, 9);
  });

  it('keeps both ears above the floor at a partial pan (the binaural beat survives)', () => {
    const { ctx, voice } = makeVoice();
    const g = graphOf(ctx);
    voice.setSpatial(0.5);
    expect(computeParamValue(g.panGainL.gain)).toBeCloseTo(0.625, 9); // 1 − 0.75·0.5
    expect(computeParamValue(g.panGainR.gain)).toBeCloseTo(1, 9);
    expect(computeParamValue(g.panGainL.gain)).toBeGreaterThan(0);
    expect(computeParamValue(g.panGainR.gain)).toBeGreaterThan(0);
  });

  it('clamps setSpatial to [-1, 1] and ramps (no-click, no exp/curve)', () => {
    const { ctx, voice } = makeVoice();
    const g = graphOf(ctx);
    voice.setSpatial(5); // clamp to 1
    expect(mp(voice.spatialParam).value).toBe(1);
    const log = g.spatialSource.offset.methodLog;
    expect(log).toContain('linearRampToValueAtTime');
    expect(log).not.toContain('exponentialRampToValueAtTime');
    expect(log).not.toContain('setValueCurveAtTime');
  });

  it('throws INVALID_PARAMETER for a non-finite spatial value', () => {
    const { voice } = makeVoice();
    expectAudioError(() => voice.setSpatial(NaN), 'INVALID_PARAMETER');
  });

  it('accepts a sweep warble summed onto spatialParam (stacks like carrier/beat)', () => {
    const { ctx, voice } = makeVoice();
    const g = graphOf(ctx);
    const w = voice.connectWarble(voice.spatialParam, { shape: 'sine', frequencyHz: 0.1, depth: 0.6 });
    expect(g.spatialSource.offset.inputs.length).toBeGreaterThan(0);
    w.disconnect();
  });

  it('leaves the static setBalance trim (gainL/gainR) independent of the spatial pan', () => {
    const { ctx, voice } = makeVoice();
    const g = graphOf(ctx);
    voice.setSpatial(1); // pan fully right via the pan pair
    voice.setBalance(-0.5); // static trim on gainL/gainR
    expect(g.gainL.gain.value).toBe(1); // pan −0.5: near (L) stays 1
    expect(g.gainR.gain.value).toBe(0.5); // far (R) trimmed to 0.5
    // spatial did not touch gainL/gainR; the pan lives on the separate pair.
    expect(computeParamValue(g.panGainL.gain)).toBeCloseTo(0.25, 9);
    expect(computeParamValue(g.panGainR.gain)).toBeCloseTo(1, 9);
  });
});

// =====================================================================================
// Task 4 — connectWarble glide helper
// =====================================================================================

describe('connectWarble (Task 4)', () => {
  it('should wire osc → depthGain → target, set rate/depth, and start the LFO', () => {
    const { ctx, voice } = makeVoice();
    const handle = voice.connectWarble(voice.carrierParam, { shape: 'triangle', frequencyHz: 0.5, depth: 3 });
    const warbleOsc = ctx.created.oscillators[2]; // after oscL, oscR
    const depthGain = ctx.created.gains[ctx.created.gains.length - 1];
    expect(handle.osc).toBe(warbleOsc);
    expect(warbleOsc.type).toBe('triangle');
    expect(mp(handle.frequencyParam).value).toBe(0.5);
    expect(mp(handle.depthParam).value).toBe(3);
    expect(warbleOsc.isConnectedTo(depthGain)).toBe(true);
    expect(depthGain.isConnectedTo(mp(voice.carrierParam))).toBe(true);
    expect(warbleOsc.started).toBe(true);
  });

  it('should default shape sine, frequency 0 and depth 0; start at ctx.currentTime', () => {
    const { ctx, voice } = makeVoice();
    ctx.currentTime = 4;
    const handle = voice.connectWarble(voice.beatParam);
    expect(handle.osc.type).toBe('sine');
    expect(mp(handle.frequencyParam).value).toBe(0);
    expect(mp(handle.depthParam).value).toBe(0);
    expect((handle.osc as unknown as MockOscillatorNode).startTime).toBe(4);
  });

  it('should expose frequency/depth as a-rate params summed onto the target (H4)', () => {
    const { voice } = makeVoice();
    const handle = voice.connectWarble(voice.modVolumeParam, { depth: 0.2 });
    expect(mp(handle.frequencyParam).automationRate).toBe('a-rate');
    expect(mp(handle.depthParam).automationRate).toBe('a-rate');
    expect(mp(voice.modVolumeParam).inputs.length).toBeGreaterThan(0);
  });

  it('should NOT bound the connected warble depth/frequency (A4/A5 — automation owns bounds)', () => {
    const { voice } = makeVoice();
    const handle = voice.connectWarble(voice.carrierParam, { frequencyHz: 100000, depth: 999999 });
    expect(mp(handle.frequencyParam).value).toBe(100000);
    expect(mp(handle.depthParam).value).toBe(999999);
  });

  it('should stop the LFO and free its nodes on disconnect() (H5)', () => {
    const { ctx, voice } = makeVoice();
    const handle = voice.connectWarble(voice.carrierParam, { frequencyHz: 0.5, depth: 2 });
    const warbleOsc = ctx.created.oscillators[2];
    const depthGain = ctx.created.gains[ctx.created.gains.length - 1];
    handle.disconnect();
    expect(warbleOsc.stopped).toBe(true);
    expect(warbleOsc.disconnectCalls).toBeGreaterThan(0);
    expect(depthGain.disconnectCalls).toBeGreaterThan(0);
  });

  it('should throw VOICE_STOPPED when connecting a warble after stop()', () => {
    const { voice } = makeVoice();
    voice.start();
    voice.stop();
    expectAudioError(() => voice.connectWarble(voice.carrierParam), 'VOICE_STOPPED');
  });
});

// =====================================================================================
// Task 6 — registerPulseWorklet + createPulseNode + attach/detach
// =====================================================================================

describe('pulse worklet wiring (Task 6)', () => {
  let uninstall: () => void;
  beforeEach(() => {
    uninstall = installAudioWorkletNode();
  });
  afterEach(() => {
    uninstall();
  });

  it('should resolve registration and call addModule exactly once', async () => {
    const ctx = new MockAudioContext();
    await registerPulseWorklet(asCtx(ctx), 'mock://pulse.js');
    expect(ctx.audioWorklet.addModuleCalls).toEqual(['mock://pulse.js']);
  });

  it('should default the module url to the bundled pulse-worklet.js', async () => {
    const ctx = new MockAudioContext();
    await registerPulseWorklet(asCtx(ctx));
    expect(ctx.audioWorklet.addModuleCalls[0]).toContain('pulse-worklet');
  });

  it('should build the pulse node with PulseOptions defaults (4/1/0.5/0.005)', async () => {
    const { ctx, voice } = makeVoice();
    await registerPulseWorklet(asCtx(ctx));
    const handle = voice.createPulseNode();
    expect((handle.node as unknown as { name: string }).name).toBe(PULSE_PROCESSOR_NAME);
    expect(mp(handle.frequencyParam).value).toBe(4);
    expect(mp(handle.depthParam).value).toBe(1);
    expect(mp(handle.dutyCycleParam).value).toBe(0.5);
    expect(mp(handle.edgeWidthParam).value).toBe(0.005);
    const opts = (handle.node as unknown as { options?: { outputChannelCount?: number[]; numberOfInputs?: number } }).options;
    expect(opts?.outputChannelCount).toEqual([1]);
    expect(opts?.numberOfInputs).toBe(0);
  });

  it('should apply and clamp PulseOptions (depth/duty 0..1, frequency 0 allowed A7)', async () => {
    const { ctx, voice } = makeVoice();
    await registerPulseWorklet(asCtx(ctx));
    const handle = voice.createPulseNode({ frequencyHz: 0, depth: 5, dutyCycle: -1, edgeSec: 0.002 });
    expect(mp(handle.frequencyParam).value).toBe(0); // allowed (held DC)
    expect(mp(handle.depthParam).value).toBe(1); // clamped 0..1
    expect(mp(handle.dutyCycleParam).value).toBe(0); // clamped 0..1
    expect(mp(handle.edgeWidthParam).value).toBe(0.002);
  });

  it('should gate envGain to 0 and connect the source on attach (replace-mode)', async () => {
    const { ctx, voice } = makeVoice();
    await registerPulseWorklet(asCtx(ctx));
    const pulse = voice.createPulseNode();
    voice.attachVolumeModulator(pulse.output);
    expect(mp(voice.modVolumeParam).value).toBe(0);
    expect(mn(pulse.output).isConnectedTo(mp(voice.modVolumeParam))).toBe(true);
  });

  it('should restore envGain pass-through to 1.0 and disconnect the source on detach', async () => {
    const { ctx, voice } = makeVoice();
    await registerPulseWorklet(asCtx(ctx));
    const pulse = voice.createPulseNode();
    voice.attachVolumeModulator(pulse.output);
    voice.detachVolumeModulator();
    expect(mp(voice.modVolumeParam).value).toBe(1);
    expect(mn(pulse.output).disconnectCalls).toBeGreaterThan(0);
  });

  // Errors (F1, F2)
  it('should reject with WORKLET_LOAD_FAILED (carrying the cause) when addModule rejects (F1)', async () => {
    const ctx = new MockAudioContext();
    const boom = new Error('no AudioWorklet');
    ctx.audioWorklet.onAddModule = () => Promise.reject(boom);
    try {
      await registerPulseWorklet(asCtx(ctx));
      throw new Error('expected rejection');
    } catch (e) {
      expect(e).toBeInstanceOf(AudioEngineError);
      expect((e as AudioEngineError).code).toBe('WORKLET_LOAD_FAILED');
      expect((e as AudioEngineError).cause).toBe(boom);
    }
  });

  it('should throw WORKLET_NOT_REGISTERED when createPulseNode runs before registration (F2)', () => {
    const { voice } = makeVoice();
    expectAudioError(() => voice.createPulseNode(), 'WORKLET_NOT_REGISTERED');
  });

  // Edge (F3, B2)
  it('should make a second registration for the same context a no-op (F3)', async () => {
    const ctx = new MockAudioContext();
    await registerPulseWorklet(asCtx(ctx), 'first://');
    await registerPulseWorklet(asCtx(ctx), 'second://');
    expect(ctx.audioWorklet.addModuleCalls).toEqual(['first://']);
  });

  it('should throw VOICE_STOPPED for createPulseNode / attach after stop()', async () => {
    const { ctx, voice } = makeVoice();
    await registerPulseWorklet(asCtx(ctx));
    voice.start();
    voice.stop();
    expectAudioError(() => voice.createPulseNode(), 'VOICE_STOPPED');
    expectAudioError(() => voice.attachVolumeModulator(voice.output), 'VOICE_STOPPED');
  });
});
