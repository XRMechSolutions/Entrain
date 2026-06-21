import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  createLayerNode,
  LayerNodeError,
  type LayerNode,
  type LayerNodeErrorCode,
} from './layer-engine';
import {
  MockAudioContext,
  MockStereoPannerNode,
  MockAudioBufferSourceNode,
  makeAudioBuffer,
  type MockAudioParam,
  type MockGainNode,
  type AudioBufferLike,
} from '../test/webaudio-mock';
import type { Layer } from './session-model';

// --- helpers ---------------------------------------------------------------

const asCtx = (ctx: MockAudioContext): BaseAudioContext =>
  ctx as unknown as BaseAudioContext;
const mp = (p: AudioParam): MockAudioParam => p as unknown as MockAudioParam;
const asBuffer = (b: AudioBufferLike): AudioBuffer => b as unknown as AudioBuffer;

// Layer factories — minimal valid shapes per kind (session-model §10).
function toneLayer(over: Partial<Layer> = {}): Layer {
  return {
    id: 'bell',
    kind: 'tone',
    t: 0,
    source: { synth: { shape: 'sine', freqHz: 528, attackSec: 0.005, releaseSec: 3 } },
    ...over,
  };
}
function ambianceLayer(over: Partial<Layer> = {}): Layer {
  return { id: 'rain', kind: 'ambiance', t: 0, source: { clipId: 'rain-clip' }, ...over };
}
function voiceLayer(over: Partial<Layer> = {}): Layer {
  return { id: 'guide', kind: 'voice', t: 0, source: { clipId: 'guide-clip' }, ...over };
}

// Pull the single source / envGain / layerGain / panner out of the created records.
function tailOf(ctx: MockAudioContext): { layerGain: MockGainNode; panner: MockStereoPannerNode } {
  const panner = ctx.created.stereoPanners[0];
  // layerGain is the GainNode that connects to the panner.
  const layerGain = ctx.created.gains.find((g) => g.isConnectedTo(panner))!;
  return { layerGain, panner };
}

function expectLayerError(fn: () => unknown, code: LayerNodeErrorCode): void {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(LayerNodeError);
    expect(e).toBeInstanceOf(Error);
    expect((e as LayerNodeError).code).toBe(code);
    expect((e as LayerNodeError).name).toBe('LayerNodeError');
    return;
  }
  throw new Error(`expected LayerNodeError(${code}) but nothing was thrown`);
}

// ---------------------------------------------------------------------------
// Task 5 — construction defaults, stable output, L0 purity
// ---------------------------------------------------------------------------

describe('createLayerNode — construction defaults and stable output', () => {
  it('should expose the StereoPanner as output with unity gain and center pan for a tone', () => {
    const ctx = new MockAudioContext();
    const node = createLayerNode(asCtx(ctx), toneLayer());
    expect(node.output).toBe(ctx.created.stereoPanners[0]);
    expect(node.output).toBeInstanceOf(MockStereoPannerNode);
    expect(mp(node.gainParam).value).toBe(1);
    expect(mp(node.panParam).value).toBe(0);
    expect(node.id).toBe('bell');
    expect(node.kind).toBe('tone');
    expect(node.missing).toBe(false);
    expect(node.state).toBe('idle');
  });

  it('should report durationSec = attackSec + releaseSec for a tone (one-shot envelope length)', () => {
    const ctx = new MockAudioContext();
    // attackSec 0.005 + releaseSec 3 = 3.005 (toneLayer default).
    const node = createLayerNode(asCtx(ctx), toneLayer());
    expect(node.durationSec).toBeCloseTo(3.005);
  });

  it('should report durationSec = buffer.duration for ambiance and voice clip layers', () => {
    for (const layer of [ambianceLayer(), voiceLayer()]) {
      const ctx = new MockAudioContext();
      // makeAudioBuffer default = 1 s stereo 48k → duration 1.
      const node = createLayerNode(asCtx(ctx), layer, asBuffer(makeAudioBuffer()));
      expect(node.durationSec).toBeCloseTo(1);
      // A 2.5 s buffer (sampleRate * 2.5 samples) reports durationSec 2.5.
      const ctx2 = new MockAudioContext();
      const longer = createLayerNode(
        asCtx(ctx2),
        layer,
        asBuffer(makeAudioBuffer({ length: 48000 * 2.5 })),
      );
      expect(longer.durationSec).toBeCloseTo(2.5);
    }
  });

  it('should report durationSec = 0 for a missing-clip silent node (no buffer)', () => {
    const ctx = new MockAudioContext();
    const amb = createLayerNode(asCtx(ctx), ambianceLayer(), undefined);
    expect(amb.durationSec).toBe(0);
    const ctx2 = new MockAudioContext();
    const voice = createLayerNode(asCtx(ctx2), voiceLayer(), undefined);
    expect(voice.durationSec).toBe(0);
  });

  it('should report durationSec = 0 for a zero-length buffer (tolerated silence)', () => {
    const ctx = new MockAudioContext();
    const node = createLayerNode(asCtx(ctx), voiceLayer(), asBuffer(makeAudioBuffer({ length: 0 })));
    expect(node.durationSec).toBe(0);
  });

  it('should expose the StereoPanner as output for ambiance and voice with a buffer', () => {
    for (const layer of [ambianceLayer(), voiceLayer()]) {
      const ctx = new MockAudioContext();
      const node = createLayerNode(asCtx(ctx), layer, asBuffer(makeAudioBuffer()));
      expect(node.output).toBe(ctx.created.stereoPanners[0]);
      expect(node.output).toBeInstanceOf(MockStereoPannerNode);
      expect(mp(node.gainParam).value).toBe(1);
      expect(mp(node.panParam).value).toBe(0);
      expect(node.id).toBe(layer.id);
      expect(node.kind).toBe(layer.kind);
      expect(node.missing).toBe(false);
      expect(node.state).toBe('idle');
    }
  });

  it('should wire gainParam to layerGain.gain and panParam to panner.pan', () => {
    const ctx = new MockAudioContext();
    const node = createLayerNode(asCtx(ctx), toneLayer());
    const { layerGain, panner } = tailOf(ctx);
    expect(node.gainParam).toBe(layerGain.gain);
    expect(node.panParam).toBe(panner.pan);
  });

  it('should report panParam native range [-1, 1] (StereoPanner.pan)', () => {
    const ctx = new MockAudioContext();
    const node = createLayerNode(asCtx(ctx), toneLayer());
    expect(mp(node.panParam).minValue).toBe(-1);
    expect(mp(node.panParam).maxValue).toBe(1);
  });

  it('should build identically against an offline-style ctx with a non-48000 sampleRate', () => {
    const ctx = new MockAudioContext({ sampleRate: 44100 });
    const node = createLayerNode(asCtx(ctx), toneLayer(), undefined);
    expect(ctx.sampleRate).toBe(44100);
    expect(node.output).toBe(ctx.created.stereoPanners[0]);
    expect(mp(node.gainParam).value).toBe(1);
    expect(mp(node.panParam).value).toBe(0);
  });
});

describe('layer-engine — L0 purity (offline-reusable, no transport coupling)', () => {
  const raw = readFileSync(resolve(process.cwd(), 'src/engine/layer-engine.ts'), 'utf8');
  // Strip block and line comments so the purity check sees only CODE references, not
  // prose that names a forbidden symbol to explain it is avoided.
  const code = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

  it('should import session-model type-only', () => {
    expect(code).toMatch(/import\s+type\s+\{[^}]*\}\s+from\s+'\.\/session-model'/);
    // No non-type (runtime) import of session-model.
    expect(code).not.toMatch(/import\s+\{[^}]*\}\s+from\s+'\.\/session-model'/);
  });

  it('should not import clip-library, automation, mixer, or transport', () => {
    for (const mod of ['clip-library', 'automation', 'mixer', 'transport']) {
      expect(code).not.toContain(`from './${mod}'`);
    }
  });

  it('should reference no rAF / MediaSession / createMediaStreamDestination / DOM globals', () => {
    for (const sym of [
      'requestAnimationFrame',
      'MediaSession',
      'mediaSession',
      'createMediaStreamDestination',
      'document',
      'window',
    ]) {
      expect(code).not.toContain(sym);
    }
  });
});

// ---------------------------------------------------------------------------
// Task 6 — INVALID_CONTEXT and LayerNodeError shape
// ---------------------------------------------------------------------------

describe('createLayerNode — INVALID_CONTEXT and error shape', () => {
  it('should throw INVALID_CONTEXT when ctx is null', () => {
    expectLayerError(() => createLayerNode(null as unknown as BaseAudioContext, toneLayer()), 'INVALID_CONTEXT');
  });

  it('should throw INVALID_CONTEXT when ctx lacks createGain/createStereoPanner', () => {
    expectLayerError(() => createLayerNode({} as unknown as BaseAudioContext, toneLayer()), 'INVALID_CONTEXT');
  });

  it('should produce an error that is instanceof LayerNodeError and Error with name set', () => {
    let caught: unknown;
    try {
      createLayerNode(null as unknown as BaseAudioContext, toneLayer());
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(LayerNodeError);
    expect(caught).toBeInstanceOf(Error);
    expect((caught as LayerNodeError).name).toBe('LayerNodeError');
    expect((caught as LayerNodeError).code).toBe('INVALID_CONTEXT');
  });

  it('should NOT throw for a missing buffer on a clip layer (data condition, not an error)', () => {
    const ctx = new MockAudioContext();
    expect(() => createLayerNode(asCtx(ctx), ambianceLayer(), undefined)).not.toThrow();
    expect(() => createLayerNode(asCtx(ctx), voiceLayer(), undefined)).not.toThrow();
  });

  it('should NOT throw for a zero-length buffer (tolerated as silence)', () => {
    const ctx = new MockAudioContext();
    const zero = asBuffer(makeAudioBuffer({ length: 0 }));
    expect(() => createLayerNode(asCtx(ctx), voiceLayer(), zero)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Task 7 — tone, ambiance, voice node graphs and source flags
// ---------------------------------------------------------------------------

describe('createLayerNode — tone graph and ADSR', () => {
  it('should build osc(shape, freqHz) → envGain(0) → layerGain → panner', () => {
    const ctx = new MockAudioContext();
    createLayerNode(asCtx(ctx), toneLayer());
    const osc = ctx.created.oscillators[0];
    const { layerGain, panner } = tailOf(ctx);
    // envGain is the gain that osc connects to (not layerGain).
    const envGain = ctx.created.gains.find((g) => g !== layerGain)!;
    expect(osc.type).toBe('sine');
    expect(osc.frequency.value).toBe(528);
    expect(osc.isConnectedTo(envGain)).toBe(true);
    expect(envGain.isConnectedTo(layerGain)).toBe(true);
    expect(layerGain.isConnectedTo(panner)).toBe(true);
    expect(envGain.gain.value).toBe(0); // silent start (D-008)
  });

  it('should schedule a linear one-shot ADSR and stop the osc at attack+release on start', () => {
    const ctx = new MockAudioContext();
    const node = createLayerNode(asCtx(ctx), toneLayer()); // attack 0.005, release 3
    const osc = ctx.created.oscillators[0];
    const { layerGain } = tailOf(ctx);
    const envGain = ctx.created.gains.find((g) => g !== layerGain)!;

    const t0 = 0.1;
    node.start(t0);

    expect(envGain.gain.events).toEqual([
      { method: 'setValueAtTime', value: 0, time: t0 },
      { method: 'linearRampToValueAtTime', value: 1, time: t0 + 0.005 },
      { method: 'linearRampToValueAtTime', value: 0, time: t0 + 0.005 + 3 },
    ]);
    // Linear only — never exponential, never setValueCurve (D-008 / Firefox bug).
    expect(envGain.gain.methodLog).not.toContain('exponentialRampToValueAtTime');
    expect(envGain.gain.methodLog).not.toContain('setValueCurveAtTime');

    expect(osc.started).toBe(true);
    expect(osc.startTime).toBe(t0);
    expect(osc.stopped).toBe(true);
    expect(osc.stopTime).toBe(t0 + 0.005 + 3);
  });

  it('should ignore loop and buffer on a tone (one-shot bell, no throw)', () => {
    const ctx = new MockAudioContext();
    const node = createLayerNode(
      asCtx(ctx),
      toneLayer({ loop: true }),
      asBuffer(makeAudioBuffer()),
    );
    // No buffer source built for a tone.
    expect(ctx.created.bufferSources.length).toBe(0);
    expect(ctx.created.oscillators.length).toBe(1);
    expect(node.missing).toBe(false);
  });
});

describe('createLayerNode — ambiance and voice graphs', () => {
  it('should build a looping buffer source for ambiance', () => {
    const ctx = new MockAudioContext();
    createLayerNode(asCtx(ctx), ambianceLayer(), asBuffer(makeAudioBuffer()));
    const src = ctx.created.bufferSources[0];
    const { layerGain, panner } = tailOf(ctx);
    expect(src).toBeInstanceOf(MockAudioBufferSourceNode);
    expect(src.buffer).not.toBeNull();
    expect(src.loop).toBe(true);
    expect(src.isConnectedTo(layerGain)).toBe(true);
    expect(layerGain.isConnectedTo(panner)).toBe(true);
    expect(ctx.created.oscillators.length).toBe(0);
  });

  it('should build a one-shot (loop=false) buffer source for voice', () => {
    const ctx = new MockAudioContext();
    createLayerNode(asCtx(ctx), voiceLayer(), asBuffer(makeAudioBuffer()));
    const src = ctx.created.bufferSources[0];
    const { layerGain } = tailOf(ctx);
    expect(src.loop).toBe(false);
    expect(src.isConnectedTo(layerGain)).toBe(true);
  });

  it('should force ambiance loop=true even when Layer.loop=false', () => {
    const ctx = new MockAudioContext();
    createLayerNode(asCtx(ctx), ambianceLayer({ loop: false }), asBuffer(makeAudioBuffer()));
    expect(ctx.created.bufferSources[0].loop).toBe(true);
  });

  it('should force voice loop=false even when Layer.loop=true', () => {
    const ctx = new MockAudioContext();
    createLayerNode(asCtx(ctx), voiceLayer({ loop: true }), asBuffer(makeAudioBuffer()));
    expect(ctx.created.bufferSources[0].loop).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Task 8 — degenerate ADSR and zero-length / missing-clip silence
// ---------------------------------------------------------------------------

describe('createLayerNode — degenerate ADSR', () => {
  function envOf(ctx: MockAudioContext): MockAudioParam {
    const { layerGain } = tailOf(ctx);
    return ctx.created.gains.find((g) => g !== layerGain)!.gain;
  }

  it('should start and stop the osc at the same instant for attack=0, release=0', () => {
    const ctx = new MockAudioContext();
    const node = createLayerNode(
      asCtx(ctx),
      toneLayer({ source: { synth: { shape: 'sine', freqHz: 440, attackSec: 0, releaseSec: 0 } } }),
    );
    const osc = ctx.created.oscillators[0];
    const t0 = 2;
    node.start(t0);
    const env = envOf(ctx);
    // All three ops resolve at t0 — no NaN, no negative-duration ramp.
    expect(env.events).toEqual([
      { method: 'setValueAtTime', value: 0, time: t0 },
      { method: 'linearRampToValueAtTime', value: 1, time: t0 },
      { method: 'linearRampToValueAtTime', value: 0, time: t0 },
    ]);
    for (const e of env.events) expect(Number.isNaN(e.time!)).toBe(false);
    expect(osc.startTime).toBe(t0);
    expect(osc.stopTime).toBe(t0);
  });

  it('should jump to peak instantly for attack=0, release>0', () => {
    const ctx = new MockAudioContext();
    const node = createLayerNode(
      asCtx(ctx),
      toneLayer({ source: { synth: { shape: 'sine', freqHz: 440, attackSec: 0, releaseSec: 2 } } }),
    );
    const t0 = 1;
    node.start(t0);
    const env = envOf(ctx);
    expect(env.events).toEqual([
      { method: 'setValueAtTime', value: 0, time: t0 },
      { method: 'linearRampToValueAtTime', value: 1, time: t0 },
      { method: 'linearRampToValueAtTime', value: 0, time: t0 + 2 },
    ]);
    expect(ctx.created.oscillators[0].stopTime).toBe(t0 + 2);
  });

  it('should drop immediately at t0+attack for release=0, attack>0', () => {
    const ctx = new MockAudioContext();
    const node = createLayerNode(
      asCtx(ctx),
      toneLayer({ source: { synth: { shape: 'sine', freqHz: 440, attackSec: 1.5, releaseSec: 0 } } }),
    );
    const t0 = 0;
    node.start(t0);
    const env = envOf(ctx);
    expect(env.events).toEqual([
      { method: 'setValueAtTime', value: 0, time: t0 },
      { method: 'linearRampToValueAtTime', value: 1, time: t0 + 1.5 },
      { method: 'linearRampToValueAtTime', value: 0, time: t0 + 1.5 },
    ]);
    expect(ctx.created.oscillators[0].stopTime).toBe(t0 + 1.5);
  });
});

describe('createLayerNode — missing-clip silence and zero-length buffer', () => {
  it('should build a silent node with missing=true and no source for ambiance without a buffer', () => {
    const ctx = new MockAudioContext();
    const node = createLayerNode(asCtx(ctx), ambianceLayer(), undefined);
    expect(node.missing).toBe(true);
    expect(ctx.created.bufferSources.length).toBe(0);
    expect(ctx.created.oscillators.length).toBe(0);
    // The full tail still exists and the handle is fully populated.
    expect(node.output).toBe(ctx.created.stereoPanners[0]);
    expect(mp(node.gainParam).value).toBe(1);
    expect(mp(node.panParam).value).toBe(0);
  });

  it('should build a silent node with missing=true for voice without a buffer', () => {
    const ctx = new MockAudioContext();
    const node = createLayerNode(asCtx(ctx), voiceLayer(), undefined);
    expect(node.missing).toBe(true);
    expect(ctx.created.bufferSources.length).toBe(0);
    expect(node.output).toBe(ctx.created.stereoPanners[0]);
  });

  it('should treat a zero-length buffer as present (missing=false) and build a real source', () => {
    const ctx = new MockAudioContext();
    const node = createLayerNode(asCtx(ctx), voiceLayer(), asBuffer(makeAudioBuffer({ length: 0 })));
    expect(node.missing).toBe(false);
    expect(ctx.created.bufferSources.length).toBe(1);
    expect(ctx.created.bufferSources[0].buffer!.length).toBe(0);
  });

  it('should pass a mono buffer straight through (no channel-count error)', () => {
    const ctx = new MockAudioContext();
    const node = createLayerNode(
      asCtx(ctx),
      ambianceLayer(),
      asBuffer(makeAudioBuffer({ numberOfChannels: 1 })),
    );
    expect(node.missing).toBe(false);
    expect(ctx.created.bufferSources[0].buffer!.numberOfChannels).toBe(1);
  });

  it('should keep missing=false for a tone even with no buffer (normal case)', () => {
    const ctx = new MockAudioContext();
    const node = createLayerNode(asCtx(ctx), toneLayer(), undefined);
    expect(node.missing).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Task 10 — start/stop/dispose lifecycle, ALREADY_STARTED, missing-node no-ops
// ---------------------------------------------------------------------------

describe('LayerNode — lifecycle: start / stop / dispose', () => {
  it('should advance idle → running on start and start the buffer source', () => {
    const ctx = new MockAudioContext();
    const node = createLayerNode(asCtx(ctx), ambianceLayer(), asBuffer(makeAudioBuffer()));
    expect(node.state).toBe('idle');
    node.start(0.5);
    expect(node.state).toBe('running');
    const src = ctx.created.bufferSources[0];
    expect(src.started).toBe(true);
    expect(src.startTime).toBe(0.5);
  });

  it('should advance running → stopped on stop, defaulting atCtx to ctx.currentTime', () => {
    const ctx = new MockAudioContext();
    ctx.currentTime = 7;
    const node = createLayerNode(asCtx(ctx), voiceLayer(), asBuffer(makeAudioBuffer()));
    node.start(0);
    node.stop();
    expect(node.state).toBe('stopped');
    const src = ctx.created.bufferSources[0];
    expect(src.stopped).toBe(true);
    expect(src.stopTime).toBe(7);
  });

  it('should cancel the remaining tone envelope past atCtx on stop', () => {
    const ctx = new MockAudioContext();
    const node = createLayerNode(asCtx(ctx), toneLayer());
    const { layerGain } = tailOf(ctx);
    const env = ctx.created.gains.find((g) => g !== layerGain)!.gain;
    node.start(0);
    node.stop(1.5);
    expect(env.methodLog).toContain('cancelScheduledValues');
    const cancel = env.events.find((e) => e.method === 'cancelScheduledValues')!;
    expect(cancel.time).toBe(1.5);
    expect(ctx.created.oscillators[0].stopTime).toBe(1.5);
  });

  it('should throw ALREADY_STARTED on a second start', () => {
    const ctx = new MockAudioContext();
    const node = createLayerNode(asCtx(ctx), ambianceLayer(), asBuffer(makeAudioBuffer()));
    node.start(0);
    expectLayerError(() => node.start(1), 'ALREADY_STARTED');
  });

  it('should no-op stop before start (state stays idle)', () => {
    const ctx = new MockAudioContext();
    const node = createLayerNode(asCtx(ctx), voiceLayer(), asBuffer(makeAudioBuffer()));
    node.stop();
    expect(node.state).toBe('idle');
    expect(ctx.created.bufferSources[0].stopped).toBe(false);
  });

  it('should no-op a second stop (terminal)', () => {
    const ctx = new MockAudioContext();
    const node = createLayerNode(asCtx(ctx), voiceLayer(), asBuffer(makeAudioBuffer()));
    node.start(0);
    node.stop(1);
    const src = ctx.created.bufferSources[0];
    const firstStopTime = src.stopTime;
    node.stop(2);
    expect(node.state).toBe('stopped');
    expect(src.stopTime).toBe(firstStopTime); // unchanged by the second stop
  });

  it('should pass a past stop time through unchanged ("now")', () => {
    const ctx = new MockAudioContext();
    ctx.currentTime = 10;
    const node = createLayerNode(asCtx(ctx), voiceLayer(), asBuffer(makeAudioBuffer()));
    node.start(0);
    node.stop(3); // in the past relative to currentTime
    expect(ctx.created.bufferSources[0].stopTime).toBe(3);
  });

  it('should disconnect all owned nodes on dispose and be idempotent', () => {
    const ctx = new MockAudioContext();
    const node = createLayerNode(asCtx(ctx), toneLayer());
    const osc = ctx.created.oscillators[0];
    const { layerGain, panner } = tailOf(ctx);
    const envGain = ctx.created.gains.find((g) => g !== layerGain)!;
    node.dispose();
    expect(osc.disconnectCalls).toBe(1);
    expect(envGain.disconnectCalls).toBe(1);
    expect(layerGain.disconnectCalls).toBe(1);
    expect(panner.disconnectCalls).toBe(1);
    node.dispose(); // idempotent — no double-disconnect
    expect(osc.disconnectCalls).toBe(1);
    expect(panner.disconnectCalls).toBe(1);
  });

  it('should no-op start / stop after dispose', () => {
    const ctx = new MockAudioContext();
    const node = createLayerNode(asCtx(ctx), ambianceLayer(), asBuffer(makeAudioBuffer()));
    node.dispose();
    expect(() => node.start(0)).not.toThrow();
    expect(node.state).toBe('idle');
    node.stop();
    expect(node.state).toBe('idle');
    expect(ctx.created.bufferSources[0].started).toBe(false);
  });

  it('should advance a missing-clip node to running on start but be a structural no-op', () => {
    const ctx = new MockAudioContext();
    const node = createLayerNode(asCtx(ctx), ambianceLayer(), undefined);
    node.start(0);
    expect(node.state).toBe('running');
    expect(ctx.created.bufferSources.length).toBe(0);
    node.stop();
    expect(node.state).toBe('stopped');
  });

  it('should throw ALREADY_STARTED on a missing-clip node started twice', () => {
    const ctx = new MockAudioContext();
    const node = createLayerNode(asCtx(ctx), voiceLayer(), undefined);
    node.start(0);
    expectLayerError(() => node.start(1), 'ALREADY_STARTED');
  });

  it('should dispose a missing-clip node tail without error', () => {
    const ctx = new MockAudioContext();
    const node: LayerNode = createLayerNode(asCtx(ctx), voiceLayer(), undefined);
    const { layerGain, panner } = tailOf(ctx);
    node.dispose();
    expect(layerGain.disconnectCalls).toBe(1);
    expect(panner.disconnectCalls).toBe(1);
  });

  it('should allow dispose without stop while running', () => {
    const ctx = new MockAudioContext();
    const node = createLayerNode(asCtx(ctx), voiceLayer(), asBuffer(makeAudioBuffer()));
    node.start(0);
    expect(() => node.dispose()).not.toThrow();
    expect(ctx.created.bufferSources[0].disconnectCalls).toBe(1);
  });
});
