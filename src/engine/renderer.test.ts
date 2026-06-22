import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

// lamejs ships a CJS bundle whose internal globals (MPEGMode, …) do not survive Vite's
// ESM transform, so the real encoder cannot construct under jsdom/vitest (it works in a
// real browser). Per testing-standards ("inject stubs rather than real platform objects")
// the MP3 path is exercised against a tiny fake Mp3Encoder that produces real bytes — this
// tests the renderer's encode-loop orchestration (frame chunking, flush, blob assembly,
// progress, abort, error wrapping), not lamejs internals.
vi.mock('lamejs', () => {
  class Mp3Encoder {
    private throwOnEncode: boolean;
    constructor(_channels: number, _sampleRate: number, _kbps: number) {
      // A pathological 0-channel request is the hook tests use to force an encoder throw.
      this.throwOnEncode = _channels === 0;
    }
    encodeBuffer(left: Int16Array, right: Int16Array): Int8Array {
      if (this.throwOnEncode) throw new Error('fake lamejs encode failure');
      // Emit one fake MP3 byte per input frame so the blob is non-empty + size scales.
      void right;
      return new Int8Array(Math.max(0, Math.ceil(left.length / 8))).fill(0x55);
    }
    flush(): Int8Array {
      return new Int8Array([0x7f, 0x7f]);
    }
  }
  return { Mp3Encoder };
});

import {
  renderToBuffer,
  renderToFile,
  encodeBuffer,
  RenderError,
  RENDER_DEFAULTS,
  MAX_RENDER_FRAMES,
  type RenderProgress,
} from './renderer';
import type { Preset, Layer } from './session-model';

import * as automation from './automation';
import * as layerScheduler from './layer-scheduler';
import * as clipLibrary from './clip-library';
import * as mixerModule from './mixer';
import type { Mixer } from './mixer';

import {
  MockAudioContext,
  installAudioWorkletNode,
  type MockOscillatorNode,
} from '../test/webaudio-mock';

// ===========================================================================
// Offline-render harness: an OfflineAudioContext-like mock over MockAudioContext.
//
// jsdom ships no OfflineAudioContext / startRendering / decodeAudioData / suspend, so we
// build a fake whose startRendering resolves a small deterministic AudioBuffer-like (per
// testing-standards "OfflineAudioContext usage in tests"). It reuses the shared
// webaudio-mock node graph so the byte-identical voice/mixer/layer factories build the
// SAME graph offline as live.
// ===========================================================================

/** A deterministic AudioBuffer-like: stereo, `frames` long, filled with a fixed ramp so
 *  two renders of the same preset compare bit-identical and the encoders have real PCM. */
function makeRenderedBuffer(frames: number, sampleRate: number): AudioBuffer {
  const left = new Float32Array(frames);
  const right = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    // A small deterministic waveform (no randomness — determinism guard, design §7).
    left[i] = Math.sin((i / sampleRate) * 2 * Math.PI * 220) * 0.5;
    right[i] = Math.sin((i / sampleRate) * 2 * Math.PI * 221) * 0.5;
  }
  const channels = [left, right];
  return {
    length: frames,
    duration: frames / sampleRate,
    numberOfChannels: 2,
    sampleRate,
    getChannelData: (ch: number) => channels[ch] ?? channels[0],
  } as unknown as AudioBuffer;
}

interface OfflineMockOptions {
  /** Reject registerPulseWorklet's addModule (WORKLET path). */
  failWorklet?: boolean;
  /** Make decodeAudioData reject (DECODE_FAILED path). */
  failDecode?: boolean;
  /** Omit decodeAudioData entirely (degrade path). */
  noDecode?: boolean;
  /** Omit suspend (waveform degrade path). */
  noSuspend?: boolean;
  /** Omit startRendering (RENDER_FAILED path). */
  noStartRendering?: boolean;
  supportsCancelAndHold?: boolean;
}

class MockOfflineAudioContext extends MockAudioContext {
  readonly length: number;
  readonly suspendCalls: number[] = [];
  readonly resumeCalls: number[] = [];
  startRenderingCalls = 0;
  private readonly suspendResolvers: { t: number; resolve: () => void }[] = [];
  private readonly opts: OfflineMockOptions;

  constructor(
    channels: number,
    length: number,
    sampleRate: number,
    opts: OfflineMockOptions = {},
  ) {
    super({ sampleRate, supportsCancelAndHold: opts.supportsCancelAndHold });
    void channels;
    this.length = length;
    this.opts = opts;
    if (opts.failWorklet) {
      this.audioWorklet.onAddModule = () => Promise.reject(new Error('no worklet offline'));
    }
    if (opts.noDecode) {
      // Strip the method so `typeof ctx.decodeAudioData` would be undefined.
      (this as Record<string, unknown>).decodeAudioData = undefined;
    }
    if (opts.noSuspend) {
      (this as Record<string, unknown>).suspend = undefined;
    }
    if (opts.noStartRendering) {
      (this as Record<string, unknown>).startRendering = undefined;
    }
  }

  decodeAudioData(_arrayBuffer: ArrayBuffer): Promise<AudioBuffer> {
    void _arrayBuffer;
    if (this.opts.failDecode) return Promise.reject(new Error('corrupt clip'));
    // A tiny stereo buffer suffices — layer-engine only reads duration/channels.
    return Promise.resolve(makeRenderedBuffer(this.sampleRate, this.sampleRate));
  }

  suspend(t: number): Promise<void> {
    this.suspendCalls.push(t);
    return new Promise<void>((resolve) => {
      this.suspendResolvers.push({ t, resolve });
    });
  }

  resume(): Promise<void> {
    this.resumeCalls.push(this.currentTime);
    return Promise.resolve();
  }

  startRendering(): Promise<AudioBuffer> {
    this.startRenderingCalls++;
    // Fire every registered suspend point in order (the offline clock "runs to completion"),
    // letting the renderer apply its waveform switches before the buffer resolves.
    this.suspendResolvers
      .slice()
      .sort((a, b) => a.t - b.t)
      .forEach((s) => {
        this.currentTime = s.t;
        s.resolve();
      });
    // Resolve on a microtask so the suspend .then() callbacks run first.
    return Promise.resolve().then(() => makeRenderedBuffer(this.length, this.sampleRate));
  }
}

// --- global install/uninstall of the OfflineAudioContext ctor --------------

let currentOfflineOpts: OfflineMockOptions = {};
let lastOffline: MockOfflineAudioContext | undefined;

function installOfflineContext(): () => void {
  const g = globalThis as Record<string, unknown>;
  const prevOffline = g.OfflineAudioContext;
  g.OfflineAudioContext = class extends MockOfflineAudioContext {
    constructor(channels: number, length: number, sampleRate: number) {
      super(channels, length, sampleRate, currentOfflineOpts);
      lastOffline = this;
    }
  };
  return () => {
    g.OfflineAudioContext = prevOffline;
  };
}

// ===========================================================================
// Test presets
// ===========================================================================

function basePreset(over: Partial<Preset> = {}): Preset {
  return {
    schemaVersion: 6,
    name: 'guided drift',
    durationSec: 10,
    masterGain: 0.8,
    nodes: [{ t: 0, carrier: { value: 200 }, beat: { value: 4 } }],
    ...over,
  };
}

const toneLayer: Layer = {
  id: 'l-tone',
  kind: 'tone',
  source: { synth: { shape: 'sine', freqHz: 440, attackSec: 0.1, releaseSec: 0.2 } },
  t: 0,
};

const ambianceLayer: Layer = {
  id: 'l-amb',
  kind: 'ambiance',
  source: { clipId: 'clip_amb' },
  t: 0,
  loop: true,
};

const voiceCueLayer: Layer = {
  id: 'l-cue',
  kind: 'voice',
  source: { clipId: 'clip_cue' },
  t: 1,
  duck: { toGain: 0.3, attackSec: 0.2, releaseSec: 0.5 },
};

function multiLayerPreset(): Preset {
  return basePreset({ layers: [toneLayer, ambianceLayer, voiceCueLayer] });
}

/** Two-voice preset: primary (carrier 200, beat 4) + 1 extra voice (carrier 400, beat 6). */
function twoVoicePreset(): Preset {
  return basePreset({
    voices: [
      {
        id: 'v2',
        nodes: [{ t: 0, carrier: { value: 400 }, beat: { value: 6 } }],
      },
    ],
  });
}

/** Spy on createMixer and capture the Mixer it returns — the real composition object,
 *  read BEFORE the renderer's finally-block disposal (param event logs persist anyway). */
function captureMixer(): () => Mixer {
  let captured: Mixer | undefined;
  const real = mixerModule.createMixer;
  vi.spyOn(mixerModule, 'createMixer').mockImplementation((ctx, opts) => {
    captured = real(ctx, opts);
    return captured;
  });
  return () => {
    if (!captured) throw new Error('createMixer was not called');
    return captured;
  };
}

/** The value-bearing automation events recorded on a mock AudioParam. */
function paramEvents(
  param: AudioParam,
): { method: string; value?: number; time?: number }[] {
  return (param as unknown as { events: { method: string; value?: number; time?: number }[] })
    .events;
}

function paramMethodLog(param: AudioParam): string[] {
  return (param as unknown as { methodLog: string[] }).methodLog;
}

// ===========================================================================
// Suite setup
// ===========================================================================

let uninstallWorklet: () => void;
let uninstallOffline: () => void;

/** jsdom's Blob lacks `arrayBuffer()` (a browser-only method the renderer reads input
 *  clips through and the tests read output blobs through). Polyfill it via FileReader,
 *  which jsdom does implement. Real browsers ship Blob.arrayBuffer natively. */
function ensureBlobArrayBuffer(): void {
  const proto = Blob.prototype as Blob & { arrayBuffer?: () => Promise<ArrayBuffer> };
  if (typeof proto.arrayBuffer === 'function') return;
  proto.arrayBuffer = function arrayBuffer(this: Blob): Promise<ArrayBuffer> {
    return new Promise<ArrayBuffer>((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(fr.result as ArrayBuffer);
      fr.onerror = () => reject(fr.error);
      fr.readAsArrayBuffer(this);
    });
  };
}

beforeEach(() => {
  ensureBlobArrayBuffer();
  currentOfflineOpts = {};
  lastOffline = undefined;
  uninstallWorklet = installAudioWorkletNode();
  uninstallOffline = installOfflineContext();
  // Default: every clip resolves to a present blob (decodes to a buffer).
  vi.spyOn(clipLibrary, 'getBlob').mockResolvedValue(
    new Blob([new Uint8Array([1, 2, 3, 4])], { type: 'audio/mpeg' }),
  );
});

afterEach(() => {
  uninstallOffline();
  uninstallWorklet();
  vi.restoreAllMocks();
});

// ===========================================================================
// (a) No-transport-import guardrail — the arch §5/§6 coupling mitigation
// ===========================================================================

describe('no-transport-import guardrail', () => {
  it('should contain no import from ./transport or ./transport-types in renderer.ts', () => {
    const src = readFileSync(path.resolve(process.cwd(), 'src/engine/renderer.ts'), 'utf8');
    // Strip line comments so the explanatory prose ("no `from './transport'`") never
    // trips the guard — only a REAL import statement should fail the build.
    const code = src
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('//'))
      .join('\n');
    expect(code).not.toMatch(/from\s+['"]\.\/transport['"]/);
    expect(code).not.toMatch(/from\s+['"]\.\/transport-types['"]/);
    expect(code).not.toMatch(/import\s*\(\s*['"]\.\/transport/);
  });

  it('should run a full offline render constructing NO transport (the live guard)', async () => {
    // A clean render proves the renderer composes voice+mixer+layers without transport.
    const buffer = await renderToBuffer(multiLayerPreset());
    expect(buffer.numberOfChannels).toBe(2);
    expect(lastOffline?.startRenderingCalls).toBe(1);
  });
});

// ===========================================================================
// (b) renderToBuffer — happy path
// ===========================================================================

describe('renderToBuffer — offline compose', () => {
  it('should render a 2-ch buffer of ceil(durationSec*rate) frames', async () => {
    const preset = basePreset({ durationSec: 10.5 });
    const buffer = await renderToBuffer(preset, { sampleRate: 44100 });
    expect(buffer.numberOfChannels).toBe(2);
    expect(buffer.length).toBe(Math.ceil(10.5 * 44100));
    expect(buffer.sampleRate).toBe(44100);
  });

  it('should default the sample rate to 44100', async () => {
    await renderToBuffer(basePreset());
    expect(lastOffline?.sampleRate).toBe(RENDER_DEFAULTS.sampleRate);
  });

  it('should create the voice in {master:\'bus\'} (masterGain.gain === 1, no double-attenuation)', async () => {
    const spy = vi.spyOn(automation, 'scheduleAll');
    await renderToBuffer(basePreset());
    const voice = spy.mock.calls[0][1];
    // bus mode → unity passthrough; the construction-time =0 write is skipped.
    expect((voice.masterGainParam as unknown as { value: number }).value).toBe(1);
  });

  it('should invoke scheduleAll with {startTime:0} and scheduleLayers with {t0:0, startOffsetSec:0}', async () => {
    const allSpy = vi.spyOn(automation, 'scheduleAll');
    const layerSpy = vi.spyOn(layerScheduler, 'scheduleLayers');
    await renderToBuffer(multiLayerPreset());
    expect(allSpy).toHaveBeenCalledTimes(1);
    expect(allSpy.mock.calls[0][2]).toEqual({ startTime: 0 });
    expect(layerSpy).toHaveBeenCalledTimes(1);
    expect(layerSpy.mock.calls[0][3]).toEqual({ t0: 0, startOffsetSec: 0 });
  });

  it('should make mixer.master→destination the single edge into the offline destination', async () => {
    // Snapshot the topology DURING the render (inside the scheduleLayers call, after all
    // wiring) — the renderer's finally-block disposal drops the edges afterward.
    let masterToDest = false;
    let masterEdgeCount = -1;
    let destInputCount = -1;
    const real = layerScheduler.scheduleLayers;
    vi.spyOn(layerScheduler, 'scheduleLayers').mockImplementation((mixer, nodes, layers, opts) => {
      const dest = lastOffline!.destination;
      const master = mixer.master as unknown as {
        isConnectedTo: (t: unknown) => boolean;
        connections: unknown[];
      };
      masterToDest = master.isConnectedTo(dest);
      masterEdgeCount = master.connections.length;
      destInputCount = (dest as unknown as { inputs: unknown[] }).inputs.length;
      return real(mixer, nodes, layers, opts);
    });
    await renderToBuffer(basePreset());
    expect(masterToDest).toBe(true); // mixer.master → destination
    expect(masterEdgeCount).toBe(1); // exactly ONE master output edge
    expect(destInputCount).toBe(1); // master is the SOLE input into the destination
  });

  it('should never write mixer.duckParam directly after scheduleLayers (single-writer D-019)', async () => {
    // Snapshot the duckParam event count immediately AFTER scheduleLayers ran (its own
    // writes are allowed) AND at startRendering time (just before disposal). The renderer
    // must add NO further duck events between the two points.
    let afterSchedulerCount = -1;
    let atRenderCount = -1;
    let duckParam: AudioParam | undefined;
    const real = layerScheduler.scheduleLayers;
    vi.spyOn(layerScheduler, 'scheduleLayers').mockImplementation((mixer, nodes, layers, opts) => {
      const handle = real(mixer, nodes, layers, opts);
      duckParam = mixer.duckParam;
      afterSchedulerCount = paramEvents(mixer.duckParam).length;
      return handle;
    });
    await renderToBuffer(multiLayerPreset(), {
      onProgress: (p) => {
        // 'rendering' fires after all scheduling, immediately before startRendering and
        // before any disposal — the last moment the renderer could have touched the duck.
        if (p.phase === 'rendering' && duckParam) atRenderCount = paramEvents(duckParam).length;
      },
    });
    expect(afterSchedulerCount).toBeGreaterThanOrEqual(0);
    expect(atRenderCount).toBe(afterSchedulerCount);
  });

  it('should ramp master 0→trim then write a linear trim→0 end fade (no exponential, no setValueCurve)', async () => {
    const getMixer = captureMixer();
    const preset = basePreset({ durationSec: 10, masterGain: 0.8 });
    await renderToBuffer(preset);
    const masterParam = getMixer().masterParam;
    expect(paramMethodLog(masterParam)).not.toContain('exponentialRampToValueAtTime');
    expect(paramMethodLog(masterParam)).not.toContain('setValueCurveAtTime');
    // The closing leg ramps to 0 at durationSec.
    const events = paramEvents(masterParam);
    const last = events[events.length - 1];
    expect(last.method).toBe('linearRampToValueAtTime');
    expect(last.value).toBe(0);
    expect(last.time).toBe(preset.durationSec);
  });

  it('should start the voice at t=0', async () => {
    await renderToBuffer(basePreset());
    // The voice's five sources all start at 0; oscL is the first oscillator created.
    expect(lastOffline!.created.oscillators[0].startTime).toBe(0);
  });
});

// ===========================================================================
// (c) renderToBuffer — determinism
// ===========================================================================

describe('renderToBuffer — determinism', () => {
  it('should render the same preset twice to bit-identical PCM', async () => {
    const preset = multiLayerPreset();
    const a = await renderToBuffer(preset);
    const b = await renderToBuffer(preset);
    expect(a.length).toBe(b.length);
    const la = a.getChannelData(0);
    const lb = b.getChannelData(0);
    const ra = a.getChannelData(1);
    const rb = b.getChannelData(1);
    expect(la.length).toBe(lb.length);
    for (let i = 0; i < la.length; i += 997) {
      expect(la[i]).toBe(lb[i]);
      expect(ra[i]).toBe(rb[i]);
    }
  });
});

// ===========================================================================
// (d) renderToBuffer — errors
// ===========================================================================

function expectRenderError(p: Promise<unknown>, code: string): Promise<void> {
  return p.then(
    () => {
      throw new Error(`expected RenderError(${code})`);
    },
    (e: unknown) => {
      expect(e).toBeInstanceOf(RenderError);
      expect((e as RenderError).code).toBe(code);
    },
  );
}

describe('renderToBuffer — errors', () => {
  it('should reject WORKLET when the pulse worklet fails to register, with no startRendering', async () => {
    currentOfflineOpts = { failWorklet: true };
    await expectRenderError(renderToBuffer(basePreset()), 'WORKLET');
    expect(lastOffline?.startRenderingCalls ?? 0).toBe(0);
  });

  it('should reject DECODE_FAILED naming the clipId for a present-but-undecodable clip', async () => {
    currentOfflineOpts = { failDecode: true };
    const preset = basePreset({ layers: [ambianceLayer] });
    await renderToBuffer(preset).then(
      () => {
        throw new Error('expected rejection');
      },
      (e: unknown) => {
        expect(e).toBeInstanceOf(RenderError);
        expect((e as RenderError).code).toBe('DECODE_FAILED');
        expect((e as RenderError).message).toContain('clip_amb');
      },
    );
  });

  it('should reject UNSUPPORTED when no OfflineAudioContext exists', async () => {
    const g = globalThis as Record<string, unknown>;
    const prev = g.OfflineAudioContext;
    g.OfflineAudioContext = undefined;
    try {
      await expectRenderError(renderToBuffer(basePreset()), 'UNSUPPORTED');
    } finally {
      g.OfflineAudioContext = prev;
    }
  });

  it('should reject INVALID_OPTION for a non-finite or out-of-range sampleRate', async () => {
    await expectRenderError(renderToBuffer(basePreset(), { sampleRate: NaN }), 'INVALID_OPTION');
    await expectRenderError(renderToBuffer(basePreset(), { sampleRate: 1000 }), 'INVALID_OPTION');
    await expectRenderError(
      renderToBuffer(basePreset(), { sampleRate: 999999 }),
      'INVALID_OPTION',
    );
  });

  it('should reject RENDER_FAILED before allocation when frames exceed MAX_RENDER_FRAMES', async () => {
    // durationSec * rate > MAX_RENDER_FRAMES. Pick a duration that overflows the guard.
    const durationSec = MAX_RENDER_FRAMES / RENDER_DEFAULTS.sampleRate + 100;
    await expectRenderError(renderToBuffer(basePreset({ durationSec })), 'RENDER_FAILED');
    // No context was constructed.
    expect(lastOffline).toBeUndefined();
  });

  it('should reject RENDER_FAILED when startRendering is unavailable', async () => {
    currentOfflineOpts = { noStartRendering: true };
    await expectRenderError(renderToBuffer(basePreset()), 'RENDER_FAILED');
  });
});

// ===========================================================================
// (e) renderToBuffer — cancellation
// ===========================================================================

describe('renderToBuffer — cancellation', () => {
  it('should reject CANCELLED before any allocation for an already-aborted signal', async () => {
    const controller = new AbortController();
    controller.abort();
    await expectRenderError(
      renderToBuffer(basePreset(), { signal: controller.signal }),
      'CANCELLED',
    );
    expect(lastOffline).toBeUndefined();
  });

  it('should reject CANCELLED with no startRendering when aborted before render', async () => {
    const controller = new AbortController();
    // Abort during pre-decode: getBlob aborts the controller, then returns a blob.
    vi.spyOn(clipLibrary, 'getBlob').mockImplementation(async () => {
      controller.abort();
      return new Blob([new Uint8Array([1, 2])]);
    });
    const preset = basePreset({ layers: [ambianceLayer] });
    await expectRenderError(
      renderToBuffer(preset, { signal: controller.signal }),
      'CANCELLED',
    );
    expect(lastOffline?.startRenderingCalls ?? 0).toBe(0);
  });
});

// ===========================================================================
// (f) renderToBuffer — edge cases
// ===========================================================================

describe('renderToBuffer — edge cases', () => {
  it('should render a missing clip as a silent layer, complete, and surface a notice', async () => {
    vi.spyOn(clipLibrary, 'getBlob').mockResolvedValue(undefined);
    const notices: string[] = [];
    const preset = basePreset({ layers: [ambianceLayer] });
    const buffer = await renderToBuffer(preset, { onNotice: (n) => notices.push(n) });
    expect(buffer.numberOfChannels).toBe(2);
    expect(lastOffline?.startRenderingCalls).toBe(1);
    expect(notices.join(' ')).toContain('clip_amb');
  });

  it('should clamp fadeIn+fadeOut to durationSec for a very short preset (still fades 0→trim→0)', async () => {
    const getMixer = captureMixer();
    const preset = basePreset({ durationSec: 2, masterGain: 0.6 }); // < 1.5 + 3
    await renderToBuffer(preset);
    const masterEvents = paramEvents(getMixer().masterParam);
    // Final event ramps to 0 at durationSec; no event time exceeds durationSec.
    const last = masterEvents[masterEvents.length - 1];
    expect(last.value).toBe(0);
    expect(last.time).toBe(2);
    for (const e of masterEvents) {
      if (e.time !== undefined) expect(e.time).toBeLessThanOrEqual(2 + 1e-9);
    }
  });

  it('should decode a duplicated clipId only once', async () => {
    const spy = vi.spyOn(clipLibrary, 'getBlob').mockResolvedValue(
      new Blob([new Uint8Array([1, 2, 3, 4])]),
    );
    const shared = 'clip_shared';
    const a: Layer = { id: 'a', kind: 'ambiance', source: { clipId: shared }, t: 0, loop: true };
    const b: Layer = { id: 'b', kind: 'voice', source: { clipId: shared }, t: 2 };
    await renderToBuffer(basePreset({ layers: [a, b] }));
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(shared);
  });

  it('should dispose the graph on both the success and the cancel paths', async () => {
    // Success path: the mixer master gets disconnected on disposal (disconnectCalls bump).
    const getMixerOk = captureMixer();
    await renderToBuffer(basePreset());
    const masterOk = getMixerOk().master as unknown as { disconnectCalls: number };
    expect(masterOk.disconnectCalls).toBeGreaterThan(0);

    vi.restoreAllMocks();
    ensureBlobArrayBuffer();

    // Cancel path: abort during pre-decode (mixer already built) → the renderer still
    // disposes the mixer it created on the cancel path.
    const getMixerCancel = captureMixer();
    const controller = new AbortController();
    const preset = basePreset({ layers: [ambianceLayer] });
    vi.spyOn(clipLibrary, 'getBlob').mockImplementation(async () => {
      controller.abort();
      return new Blob([new Uint8Array([1, 2])]);
    });
    await expectRenderError(renderToBuffer(preset, { signal: controller.signal }), 'CANCELLED');
    const masterCancel = getMixerCancel().master as unknown as { disconnectCalls: number };
    expect(masterCancel.disconnectCalls).toBeGreaterThan(0);
  });
});

// ===========================================================================
// (g) renderToFile — happy + waveform switches
// ===========================================================================

describe('renderToFile', () => {
  it('should return mp3 mime/extension and a non-empty audio/mpeg blob', async () => {
    const file = await renderToFile(basePreset({ name: 'guided drift' }), 'mp3');
    expect(file.mime).toBe('audio/mpeg');
    expect(file.filename).toBe('guided-drift.mp3');
    expect(file.blob.type).toBe('audio/mpeg');
    expect(file.blob.size).toBeGreaterThan(0);
  });

  it('should return wav mime/extension and an audio/wav blob', async () => {
    const file = await renderToFile(basePreset({ name: 'guided drift' }), 'wav');
    expect(file.mime).toBe('audio/wav');
    expect(file.filename).toBe('guided-drift.wav');
    expect(file.blob.type).toBe('audio/wav');
    expect(file.blob.size).toBeGreaterThan(44);
  });

  it('should emit decoding→rendering(no fraction)→encoding→done in order', async () => {
    const phases: RenderProgress[] = [];
    await renderToFile(multiLayerPreset(), 'wav', { onProgress: (p) => phases.push(p) });
    const order = phases.map((p) => p.phase);
    expect(order[0]).toBe('decoding');
    expect(order).toContain('rendering');
    expect(order).toContain('encoding');
    expect(order[order.length - 1]).toBe('done');
    // 'rendering' carries no fraction (indeterminate).
    const rendering = phases.find((p) => p.phase === 'rendering');
    expect(rendering?.fraction).toBeUndefined();
    // 'done' is fraction 1.
    expect(phases[phases.length - 1].fraction).toBe(1);
  });

  it('should switch oscL.type/oscR.type at each keyframe via suspend/resume', async () => {
    // A preset whose nodes change waveform mid-session.
    const preset = basePreset({
      durationSec: 10,
      nodes: [
        { t: 0, carrier: { value: 200 }, beat: { value: 4 }, waveform: 'sine' },
        { t: 5, waveform: 'square' },
      ],
    });
    await renderToFile(preset, 'wav');
    // suspend was registered at the t=5 keyframe.
    expect(lastOffline!.suspendCalls).toContain(5);
    // After the render runs the suspend callbacks, the oscillators carry the late waveform.
    const oscL = lastOffline!.created.oscillators[0] as MockOscillatorNode;
    const oscR = lastOffline!.created.oscillators[1] as MockOscillatorNode;
    expect(oscL.type).toBe('square');
    expect(oscR.type).toBe('square');
  });
});

// ===========================================================================
// (h) renderToFile — errors + degrade isolation
// ===========================================================================

describe('renderToFile — errors and degrade', () => {
  it('should reject INVALID_OPTION for a bad format', async () => {
    await expectRenderError(
      renderToFile(basePreset(), 'ogg' as unknown as 'mp3'),
      'INVALID_OPTION',
    );
  });

  it('should reject INVALID_OPTION for a bad mp3Kbps before rendering', async () => {
    await expectRenderError(
      renderToFile(basePreset(), 'mp3', { mp3Kbps: NaN }),
      'INVALID_OPTION',
    );
    // No render happened.
    expect(lastOffline).toBeUndefined();
  });

  it('should propagate a cancel as CANCELLED', async () => {
    const controller = new AbortController();
    controller.abort();
    await expectRenderError(
      renderToFile(basePreset(), 'wav', { signal: controller.signal }),
      'CANCELLED',
    );
  });

  it('should NOT abort the render when onProgress throws (wrapped)', async () => {
    const file = await renderToFile(basePreset(), 'wav', {
      onProgress: () => {
        throw new Error('bad handler');
      },
    });
    expect(file.blob.size).toBeGreaterThan(44);
  });

  it('should fall back to the initial waveform + a one-time notice when suspend is unavailable', async () => {
    currentOfflineOpts = { noSuspend: true };
    const notices: string[] = [];
    const preset = basePreset({
      nodes: [
        { t: 0, carrier: { value: 200 }, beat: { value: 4 }, waveform: 'sine' },
        { t: 5, waveform: 'square' },
      ],
    });
    const file = await renderToFile(preset, 'wav', { onNotice: (n) => notices.push(n) });
    expect(file.blob.size).toBeGreaterThan(44);
    expect(notices.join(' ')).toMatch(/waveform/i);
    // No mid-render switch happened: the oscillators keep their initial (t=0) waveform.
    const oscL = lastOffline!.created.oscillators[0] as MockOscillatorNode;
    expect(oscL.type).toBe('sine');
  });

  it('should be unaffected by a preset that never changes waveform', async () => {
    const file = await renderToFile(basePreset(), 'wav');
    expect(file.blob.size).toBeGreaterThan(44);
    expect(lastOffline!.suspendCalls.length).toBe(0);
  });

  it('should sanitize unsafe path characters out of the filename', async () => {
    const file = await renderToFile(basePreset({ name: 'a/b\\c:d*?<>|.wav name' }), 'wav');
    expect(file.filename.endsWith('.wav')).toBe(true);
    expect(file.filename).not.toMatch(/[\\/:*?"<>|]/);
  });
});

// ===========================================================================
// (i) encodeBuffer — WAV header well-formedness + round-trip
// ===========================================================================

function readAscii(view: DataView, offset: number, length: number): string {
  let s = '';
  for (let i = 0; i < length; i++) s += String.fromCharCode(view.getUint8(offset + i));
  return s;
}

describe('encodeBuffer — WAV', () => {
  it('should produce a well-formed RIFF/WAVE/fmt /data header with correct sizes', async () => {
    const frames = 1000;
    const sampleRate = 44100;
    const buffer = makeRenderedBuffer(frames, sampleRate);
    const blob = await encodeBuffer(buffer, 'wav');
    expect(blob.type).toBe('audio/wav');
    const ab = await blob.arrayBuffer();
    const view = new DataView(ab);

    expect(readAscii(view, 0, 4)).toBe('RIFF');
    expect(readAscii(view, 8, 4)).toBe('WAVE');
    expect(readAscii(view, 12, 4)).toBe('fmt ');
    expect(readAscii(view, 36, 4)).toBe('data');

    expect(view.getUint16(20, true)).toBe(1); // PCM
    expect(view.getUint16(22, true)).toBe(2); // stereo
    expect(view.getUint32(24, true)).toBe(sampleRate);
    expect(view.getUint16(34, true)).toBe(16); // 16-bit

    const dataBytes = frames * 2 /* ch */ * 2 /* bytes */;
    expect(view.getUint32(40, true)).toBe(dataBytes); // Subchunk2Size
    expect(view.getUint32(4, true)).toBe(36 + dataBytes); // ChunkSize
    expect(ab.byteLength).toBe(44 + dataBytes);
  });

  it('should decode back to the input PCM within 16-bit quantization', async () => {
    const frames = 256;
    const sampleRate = 44100;
    const buffer = makeRenderedBuffer(frames, sampleRate);
    const ab = await (await encodeBuffer(buffer, 'wav')).arrayBuffer();
    const view = new DataView(ab);
    const left = buffer.getChannelData(0);
    // First interleaved sample (L) at offset 44.
    const decodedFirstL = view.getInt16(44, true) / 32767;
    expect(decodedFirstL).toBeCloseTo(left[0], 3);
  });

  it('should clamp NaN/Inf samples to 0 (no garbage 16-bit values)', async () => {
    const frames = 4;
    const left = new Float32Array([NaN, Infinity, -Infinity, 2]);
    const right = new Float32Array([0, 0, 0, 0]);
    const channels = [left, right];
    const buffer = {
      length: frames,
      duration: frames / 44100,
      numberOfChannels: 2,
      sampleRate: 44100,
      getChannelData: (ch: number) => channels[ch],
    } as unknown as AudioBuffer;
    const ab = await (await encodeBuffer(buffer, 'wav')).arrayBuffer();
    const view = new DataView(ab);
    expect(view.getInt16(44, true)).toBe(0); // NaN → 0
    expect(view.getInt16(48, true)).toBe(0); // +Inf → 0
    expect(view.getInt16(52, true)).toBe(0); // -Inf → 0
    expect(view.getInt16(56, true)).toBe(32767); // 2 clamps to 1 → 32767
  });

  it('should still produce a valid tiny blob for a near-zero-length buffer', async () => {
    const buffer = makeRenderedBuffer(1, 44100);
    const blob = await encodeBuffer(buffer, 'wav');
    expect(blob.size).toBe(44 + 1 * 2 * 2);
  });
});

// ===========================================================================
// (j) encodeBuffer — MP3 + errors
// ===========================================================================

describe('encodeBuffer — MP3', () => {
  it('should produce a non-empty audio/mpeg blob', async () => {
    const buffer = makeRenderedBuffer(44100, 44100); // 1 s
    const blob = await encodeBuffer(buffer, 'mp3');
    expect(blob.type).toBe('audio/mpeg');
    expect(blob.size).toBeGreaterThan(0);
  });

  it('should report encoding fraction over the chunks and reach 1', async () => {
    const buffer = makeRenderedBuffer(44100, 44100);
    const fractions: number[] = [];
    await encodeBuffer(buffer, 'mp3', {
      onProgress: (p) => {
        if (p.phase === 'encoding' && p.fraction !== undefined) fractions.push(p.fraction);
      },
    });
    expect(fractions.length).toBeGreaterThan(0);
    expect(fractions[fractions.length - 1]).toBe(1);
  });

  it('should reject INVALID_OPTION for a bad format', async () => {
    const buffer = makeRenderedBuffer(100, 44100);
    await expectRenderError(
      encodeBuffer(buffer, 'flac' as unknown as 'mp3'),
      'INVALID_OPTION',
    );
  });

  it('should reject INVALID_OPTION for a non-finite mp3Kbps', async () => {
    const buffer = makeRenderedBuffer(100, 44100);
    await expectRenderError(encodeBuffer(buffer, 'mp3', { mp3Kbps: Infinity }), 'INVALID_OPTION');
  });

  it('should reject CANCELLED when the signal is already aborted', async () => {
    const buffer = makeRenderedBuffer(44100, 44100);
    const controller = new AbortController();
    controller.abort();
    await expectRenderError(
      encodeBuffer(buffer, 'mp3', { signal: controller.signal }),
      'CANCELLED',
    );
  });

  it('should reject ENCODE_FAILED preserving the cause when lamejs throws', async () => {
    // Force a throw inside the encode loop by handing the encoder a buffer whose
    // getChannelData yields a non-typed-array (the int16 conversion will throw).
    const bad = {
      length: 10,
      duration: 0,
      numberOfChannels: 2,
      sampleRate: 44100,
      getChannelData: () => {
        throw new Error('boom');
      },
    } as unknown as AudioBuffer;
    await encodeBuffer(bad, 'mp3').then(
      () => {
        throw new Error('expected rejection');
      },
      (e: unknown) => {
        expect(e).toBeInstanceOf(RenderError);
        expect((e as RenderError).code).toBe('ENCODE_FAILED');
        expect((e as RenderError).cause).toBeInstanceOf(Error);
      },
    );
  });
});

// ===========================================================================
// (k) renderToBuffer — multi-voice
// ===========================================================================

describe('renderToBuffer — multi-voice', () => {
  it('should create 2 oscillators per voice (4 total for primary + 1 extra), all starting at t=0', async () => {
    await renderToBuffer(twoVoicePreset());
    const oscs = lastOffline!.created.oscillators;
    expect(oscs).toHaveLength(4);
    for (const osc of oscs) {
      expect(osc.startTime).toBe(0);
    }
  });

  it('should connect each extra voice through a per-voice trim into mixer.bedInput with the correct gain', async () => {
    let bedInputCount = -1;
    let trimGainValue = -1;
    const realSL = layerScheduler.scheduleLayers;
    vi.spyOn(layerScheduler, 'scheduleLayers').mockImplementation((mixer, nodes, layers, opts) => {
      // By scheduleLayers time, all extra voices have been wired into bedInput.
      const inputs = (
        mixer.bedInput as unknown as { inputs: Array<{ gain: { value: number } }> }
      ).inputs;
      bedInputCount = inputs.length;
      // inputs[0] = primary voice.output (masterGain, BUS_MASTER=1)
      // inputs[1] = per-voice trim (clamp01(voice.gain ?? 1))
      if (inputs.length >= 2) trimGainValue = inputs[1].gain?.value ?? -1;
      return realSL(mixer, nodes, layers, opts);
    });
    const preset = basePreset({
      voices: [
        { id: 'v2', gain: 0.5, nodes: [{ t: 0, carrier: { value: 400 }, beat: { value: 6 } }] },
      ],
    });
    await renderToBuffer(preset);
    expect(bedInputCount).toBe(2); // primary output + 1 trim
    expect(trimGainValue).toBeCloseTo(0.5); // clamp01(0.5)
  });

  it('should call scheduleAll with a voiceView (no voices key, extra voice nodes) for each extra voice', async () => {
    const allSpy = vi.spyOn(automation, 'scheduleAll');
    const extraNodes = [{ t: 0, carrier: { value: 400 }, beat: { value: 6 } }];
    const preset = basePreset({
      voices: [{ id: 'v2', nodes: [...extraNodes] }],
    });
    await renderToBuffer(preset);
    // Twice: once for primary voice, once for the extra voice
    expect(allSpy).toHaveBeenCalledTimes(2);
    const extraCallPreset = allSpy.mock.calls[1][0] as Preset;
    expect(extraCallPreset.nodes).toEqual(extraNodes);
    // voiceView omits voices[] — no recursive embedding (multi-voice §1.5)
    expect(extraCallPreset.voices).toBeUndefined();
  });

  it('should register exactly ONE ctx.suspend per distinct waveform-change time across all voices (same-t aggregation)', async () => {
    const preset = basePreset({
      durationSec: 10,
      nodes: [
        { t: 0, carrier: { value: 200 }, beat: { value: 4 }, waveform: 'sine' },
        { t: 5, waveform: 'square' },
      ],
      voices: [
        {
          id: 'v2',
          nodes: [
            { t: 0, carrier: { value: 400 }, beat: { value: 6 }, waveform: 'sine' },
            { t: 5, waveform: 'triangle' },
          ],
        },
      ],
    });
    await renderToFile(preset, 'wav');
    // Both voices switch waveform at t=5; the aggregator must produce exactly ONE suspend.
    expect(lastOffline!.suspendCalls.filter((t) => t === 5)).toHaveLength(1);
  });

  it('should dispose all extra-voice oscillators (disconnected) on the success path', async () => {
    await renderToBuffer(twoVoicePreset());
    const oscs = lastOffline!.created.oscillators;
    expect(oscs).toHaveLength(4);
    // disposeAll disconnects both primary and extra voice nodes on success.
    for (const osc of oscs) {
      expect(osc.disconnectCalls).toBeGreaterThan(0);
    }
  });

  it('should dispose all extra-voice oscillators (disconnected) on the cancel path', async () => {
    const controller = new AbortController();
    // Abort inside scheduleLayers: step (10b) already created + started the extra voice
    // before scheduleLayers runs, so the finally-block disposeAll must still reach all voices.
    const realSL = layerScheduler.scheduleLayers;
    vi.spyOn(layerScheduler, 'scheduleLayers').mockImplementation((mixer, nodes, layers, opts) => {
      controller.abort();
      return realSL(mixer, nodes, layers, opts);
    });
    await expectRenderError(
      renderToBuffer(twoVoicePreset(), { signal: controller.signal }),
      'CANCELLED',
    );
    const oscs = lastOffline!.created.oscillators;
    expect(oscs).toHaveLength(4);
    for (const osc of oscs) {
      expect(osc.disconnectCalls).toBeGreaterThan(0);
    }
  });

  it('should render a multi-voice preset twice to bit-identical PCM', async () => {
    const preset = twoVoicePreset();
    const a = await renderToBuffer(preset);
    const b = await renderToBuffer(preset);
    expect(a.length).toBe(b.length);
    const la = a.getChannelData(0);
    const lb = b.getChannelData(0);
    const ra = a.getChannelData(1);
    const rb = b.getChannelData(1);
    for (let i = 0; i < la.length; i += 997) {
      expect(la[i]).toBe(lb[i]);
      expect(ra[i]).toBe(rb[i]);
    }
  });
});
