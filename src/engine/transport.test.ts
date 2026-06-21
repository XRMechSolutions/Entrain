import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createTransport } from './transport';
import { TransportError } from './transport-types';
import type {
  BackgroundAudioMode,
  LayerSchedule,
  LayerSchedulerFactory,
  Mixer,
  SessionScheduler,
  TransportNotice,
} from './transport-types';
import type { ShepardHandle, ShepardOptions } from './shepard';
import { createVoice } from './audio-engine';
import type { Voice } from './audio-engine';
import { createDefaultPreset } from './session-model';
import { scheduleLayers } from './layer-scheduler';
import type { Layer, Preset } from './session-model';
import { MockAudioContext, MockAudioNode, MockAudioParam, MockGainNode } from '../test/webaudio-mock';

// =====================================================================================
// Co-located transport test doubles (NOT the shared webaudio-mock — automation may be
// editing that concurrently). A FakeAudioContext adds the lifecycle surface transport
// needs (suspend/resume/close/state + statechange events, createMediaStreamDestination)
// on top of the shared node factory, plus fakes for <audio>, mediaSession and wakeLock.
// =====================================================================================

/** A MediaStreamAudioDestinationNode stand-in: a node with a `.stream`. */
class FakeMediaStreamDest extends MockAudioNode {
  readonly stream = { id: 'fake-stream' } as unknown as MediaStream;
  constructor(ctx: MockAudioContext) {
    super(ctx, 'destination');
  }
}

class FakeAudioContext {
  currentTime = 0;
  state: 'suspended' | 'running' | 'interrupted' | 'closed' = 'suspended';
  suspendCalls = 0;
  resumeCalls = 0;
  closeCalls = 0;
  resumeFails = false; // when true, resume() leaves the context 'interrupted' (stuck — F5)
  readonly msDests: FakeMediaStreamDest[] = [];
  readonly destination: MockAudioNode;
  readonly created: MockAudioContext['created'];
  createMediaStreamDestination?: () => FakeMediaStreamDest;

  private readonly inner = new MockAudioContext();
  private readonly stateListeners = new Set<() => void>();

  constructor(opts: { mediaStream?: boolean } = {}) {
    this.destination = this.inner.destination;
    this.created = this.inner.created;
    if (opts.mediaStream !== false) {
      this.createMediaStreamDestination = (): FakeMediaStreamDest => {
        const d = new FakeMediaStreamDest(this.inner);
        this.msDests.push(d);
        return d;
      };
    }
  }

  createOscillator() {
    return this.inner.createOscillator();
  }
  createConstantSource() {
    return this.inner.createConstantSource();
  }
  createGain() {
    return this.inner.createGain();
  }
  createChannelMerger(n?: number) {
    return this.inner.createChannelMerger(n);
  }
  createWaveShaper() {
    return this.inner.createWaveShaper();
  }
  createStereoPanner() {
    return this.inner.createStereoPanner();
  }
  createBufferSource() {
    return this.inner.createBufferSource();
  }

  addEventListener(type: string, cb: () => void): void {
    if (type === 'statechange') this.stateListeners.add(cb);
  }
  removeEventListener(type: string, cb: () => void): void {
    if (type === 'statechange') this.stateListeners.delete(cb);
  }
  emitStateChange(): void {
    for (const cb of [...this.stateListeners]) cb();
  }

  suspend = async (): Promise<void> => {
    this.suspendCalls++;
    this.state = 'suspended';
    this.emitStateChange();
  };
  resume = async (): Promise<void> => {
    this.resumeCalls++;
    this.state = this.resumeFails ? 'interrupted' : 'running';
    this.emitStateChange();
  };
  close = async (): Promise<void> => {
    this.closeCalls++;
    this.state = 'closed';
    this.emitStateChange();
  };
}

interface FakeAudio {
  loop: boolean;
  src: string;
  srcObject: unknown;
  paused: boolean;
  play: ReturnType<typeof vi.fn>;
  pause: ReturnType<typeof vi.fn>;
  setAttribute: ReturnType<typeof vi.fn>;
  removeAttribute: ReturnType<typeof vi.fn>;
}

function makeFakeAudio(behavior: () => 'resolve' | 'reject'): FakeAudio {
  const fake: FakeAudio = {
    loop: false,
    src: '',
    srcObject: null,
    paused: true,
    play: vi.fn(() => (behavior() === 'reject' ? Promise.reject(new Error('blocked')) : Promise.resolve())),
    pause: vi.fn(() => {
      fake.paused = true;
    }),
    setAttribute: vi.fn(),
    removeAttribute: vi.fn(() => {
      fake.src = '';
    }),
  };
  return fake;
}

interface FakeMediaSession {
  metadata: unknown;
  playbackState: string;
  readonly handlers: Record<string, ((d: { seekTime?: number }) => void) | null>;
  readonly positionStates: { duration: number; position: number; playbackRate: number }[];
  throwOnSeekto: boolean;
  setActionHandler(action: string, handler: ((d: { seekTime?: number }) => void) | null): void;
  setPositionState(s: { duration: number; position: number; playbackRate: number }): void;
}

function makeFakeMediaSession(): FakeMediaSession {
  const handlers: Record<string, ((d: { seekTime?: number }) => void) | null> = {};
  const positionStates: { duration: number; position: number; playbackRate: number }[] = [];
  return {
    metadata: undefined,
    playbackState: 'none',
    handlers,
    positionStates,
    throwOnSeekto: false,
    setActionHandler(action, handler) {
      if (action === 'seekto' && this.throwOnSeekto) throw new Error('unknown action seekto');
      handlers[action] = handler;
    },
    setPositionState(s) {
      positionStates.push(s);
    },
  };
}

function makeFakeWakeLock(opts: { reject?: boolean } = {}): {
  request: ReturnType<typeof vi.fn>;
  sentinels: { released: boolean; release: ReturnType<typeof vi.fn> }[];
} {
  const sentinels: { released: boolean; release: ReturnType<typeof vi.fn> }[] = [];
  const request = vi.fn(async () => {
    if (opts.reject) throw new Error('low battery');
    const sentinel = {
      released: false,
      release: vi.fn(async () => {
        sentinel.released = true;
      }),
      addEventListener: vi.fn(),
    };
    sentinels.push(sentinel);
    return sentinel;
  });
  return { request, sentinels };
}

function makeScheduler(): { apply: ReturnType<typeof vi.fn>; retarget: ReturnType<typeof vi.fn>; cancel: ReturnType<typeof vi.fn> } {
  return { apply: vi.fn(), retarget: vi.fn(), cancel: vi.fn() };
}

/** Test shepard double: a MockGainNode stands in for the worklet node so it can connect
 *  into the graph; speed/gain are plain MockAudioParams so live ramps are assertable. The
 *  mock instances are retained in `handles` for assertions. */
function makeShepardSpies(fakeCtx: FakeAudioContext) {
  const handles: Array<{ node: MockGainNode; speedParam: MockAudioParam; gainParam: MockAudioParam }> = [];
  const register = vi.fn(() => Promise.resolve());
  const create = vi.fn((_c: BaseAudioContext, opts?: ShepardOptions): ShepardHandle => {
    const node = fakeCtx.createGain();
    const speedParam = new MockAudioParam(opts?.speed ?? 0.25);
    const gainParam = new MockAudioParam(opts?.gain ?? 0.5);
    handles.push({ node, speedParam, gainParam });
    return {
      node: node as unknown as AudioWorkletNode,
      output: node as unknown as AudioNode,
      speedParam: speedParam as unknown as AudioParam,
      gainParam: gainParam as unknown as AudioParam,
      disconnect(): void {
        node.disconnect();
      },
    };
  });
  return { register, create, handles };
}

/** A Mixer test double backed by mock gain nodes so wiring is assertable. `connect`
 *  moves master's SINGLE output edge (drop the prior, connect the new) exactly like the
 *  real mixer's single-input-master invariant, so routing assertions read mixer.master's
 *  one connection. scheduleDuck/cancelDuck/dispose are spies; transport must NEVER call
 *  scheduleDuck (the layer-scheduler owns the duck — D-019 / K8). */
interface FakeMixer {
  readonly bedInput: MockGainNode;
  readonly cueInput: MockGainNode;
  readonly liftInput: MockGainNode;
  readonly master: MockGainNode;
  readonly masterParam: MockAudioParam;
  readonly duckParam: MockAudioParam;
  readonly scheduleDuckSpy: ReturnType<typeof vi.fn>;
  readonly disposeSpy: ReturnType<typeof vi.fn>;
  /** The Mixer-typed view handed to transport (cast at the DI boundary, the same
   *  pattern the rest of this suite uses to bridge mock ↔ real Web Audio types). */
  readonly asMixer: Mixer;
}
function makeFakeMixer(fakeCtx: FakeAudioContext): FakeMixer {
  const bedInput = fakeCtx.createGain();
  const cueInput = fakeCtx.createGain();
  const liftInput = fakeCtx.createGain();
  const busSum = fakeCtx.createGain();
  const master = fakeCtx.createGain();
  busSum.connect(master); // master's single upstream (mirrors the real graph)
  let currentTarget: MockAudioNode | null = null;
  const scheduleDuckSpy = vi.fn();
  const disposeSpy = vi.fn();
  const asMixer = {
    bedInput: bedInput as unknown as AudioNode,
    cueInput: cueInput as unknown as AudioNode,
    liftInput: liftInput as unknown as AudioNode,
    master: master as unknown as GainNode,
    masterParam: master.gain as unknown as AudioParam,
    duckParam: busSum.gain as unknown as AudioParam,
    scheduleDuck: scheduleDuckSpy as unknown as Mixer['scheduleDuck'],
    cancelDuck: vi.fn() as unknown as Mixer['cancelDuck'],
    connect(target: AudioNode): void {
      const t = target as unknown as MockAudioNode;
      if (currentTarget) master.disconnect(currentTarget);
      master.connect(t);
      currentTarget = t;
    },
    disconnect(): void {
      if (currentTarget) {
        master.disconnect(currentTarget);
        currentTarget = null;
      }
    },
    dispose: disposeSpy as unknown as Mixer['dispose'],
  } satisfies Mixer;
  return {
    bedInput,
    cueInput,
    liftInput,
    master,
    masterParam: master.gain,
    duckParam: busSum.gain,
    scheduleDuckSpy,
    disposeSpy,
    asMixer,
  };
}

/** A LayerSchedule test double: retarget/cancel/dispose are spies. */
interface FakeLayerSchedule extends LayerSchedule {
  readonly retargetSpy: ReturnType<typeof vi.fn>;
  readonly cancelSpy: ReturnType<typeof vi.fn>;
  readonly disposeSpy: ReturnType<typeof vi.fn>;
}
/** A LayerSchedulerFactory test double recording every call (mixer/nodes/layers/opts)
 *  and the LayerSchedule it returned, so the layer-driving contract is assertable. */
interface FakeLayerScheduler {
  factory: LayerSchedulerFactory;
  calls: Array<{
    mixer: Mixer;
    nodes: ReadonlyArray<{ id: string; kind: string }>;
    layers: readonly Layer[];
    opts: { t0: number; startOffsetSec: number };
  }>;
  schedules: FakeLayerSchedule[];
}
function makeFakeLayerScheduler(): FakeLayerScheduler {
  const calls: FakeLayerScheduler['calls'] = [];
  const schedules: FakeLayerSchedule[] = [];
  const factory: LayerSchedulerFactory = (mixer, nodes, layers, opts) => {
    const retargetSpy = vi.fn();
    const cancelSpy = vi.fn();
    const disposeSpy = vi.fn();
    const schedule: FakeLayerSchedule = {
      retarget: retargetSpy,
      cancel: cancelSpy,
      dispose: disposeSpy,
      retargetSpy,
      cancelSpy,
      disposeSpy,
    };
    calls.push({
      mixer,
      nodes: nodes.map((n) => ({ id: n.id, kind: n.kind })),
      layers,
      opts: { t0: opts.t0, startOffsetSec: opts.startOffsetSec },
    });
    schedules.push(schedule);
    return schedule;
  };
  return { factory, calls, schedules };
}

/** A tone Layer (synth) — built synchronously by layer-engine, no clip decode. */
function toneLayer(id: string, kind: 'tone' | 'ambiance' | 'voice' = 'tone', t = 0): Layer {
  return {
    id,
    kind,
    source: { synth: { shape: 'sine', freqHz: 440, attackSec: 0.1, releaseSec: 0.1 } },
    t,
  };
}

function makePreset(over: Partial<Preset> = {}): Preset {
  return { ...createDefaultPreset(), ...over };
}

// --- test-wide fixtures ----------------------------------------------------

const realCreateElement = document.createElement.bind(document);
let fakeAudio: FakeAudio;
let audioPlayBehavior: 'resolve' | 'reject';
let rafCallbacks: FrameRequestCallback[];

function flushRaf(): void {
  const cbs = rafCallbacks;
  rafCallbacks = [];
  for (const cb of cbs) cb(0);
}
async function microflush(times = 8): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve();
}

function installMediaSession(): FakeMediaSession {
  const ms = makeFakeMediaSession();
  Object.defineProperty(navigator, 'mediaSession', { value: ms, configurable: true, writable: true });
  vi.stubGlobal(
    'MediaMetadata',
    class {
      constructor(public init: unknown) {}
    },
  );
  return ms;
}
function installWakeLock(opts: { reject?: boolean } = {}): ReturnType<typeof makeFakeWakeLock> {
  const wl = makeFakeWakeLock(opts);
  Object.defineProperty(navigator, 'wakeLock', { value: { request: wl.request }, configurable: true, writable: true });
  return wl;
}

interface SetupOpts {
  scheduler?: ReturnType<typeof makeScheduler>;
  registerWorklet?: (ctx: BaseAudioContext) => Promise<void>;
  backgroundAudioMode?: BackgroundAudioMode;
  silentFileUrl?: string;
  noFactory?: boolean;
  fakeOpts?: { mediaStream?: boolean };
  duration?: number;
  masterGain?: number;
  autoload?: boolean;
  /** PHASE-2: inject a FakeMixer (so bus internals — bedInput/cueInput/liftInput/master —
   *  are referenceable). When omitted, the REAL createMixer is used (the existing fade /
   *  routing tests rely on master being the last gain created). */
  fakeMixer?: boolean;
  /** PHASE-2: inject a FakeLayerScheduler so layer driving is assertable. */
  layers?: boolean;
  /** PHASE-2: inject a CONCRETE LayerSchedulerFactory (e.g. the real engine
   *  `scheduleLayers`) instead of the fake — exercises the real start/range seam. */
  layerSchedulerFactory?: LayerSchedulerFactory;
  preset?: Preset;
}

function setup(opts: SetupOpts = {}) {
  const fakeCtx = new FakeAudioContext(opts.fakeOpts);
  const scheduler = opts.scheduler ?? makeScheduler();
  const factory = vi.fn(() => fakeCtx as unknown as AudioContext);
  const preset = opts.preset ?? makePreset({
    durationSec: opts.duration ?? 100,
    masterGain: opts.masterGain ?? 0.8,
  });
  const notices: { error: TransportNotice[]; warning: TransportNotice[] } = { error: [], warning: [] };
  // Lift (shepard) spies — wired into every transport; only exercised by tests that call
  // setLift, so non-lift tests are unaffected (create/register stay un-called).
  const shepard = makeShepardSpies(fakeCtx);
  // PHASE-2: a fake mixer is composed per session (held here so tests reference its
  // bedInput/cueInput/liftInput/master). Created lazily by the factory at startFresh.
  let mixer: FakeMixer | undefined;
  const createMixer = opts.fakeMixer
    ? (): Mixer => {
        mixer = makeFakeMixer(fakeCtx);
        return mixer.asMixer;
      }
    : undefined;
  const layerScheduler = opts.layers ? makeFakeLayerScheduler() : undefined;
  const transport = createTransport({
    scheduler: scheduler as unknown as SessionScheduler,
    audioContextFactory: opts.noFactory ? undefined : (factory as unknown as () => AudioContext),
    registerWorklet: opts.registerWorklet ?? ((): Promise<void> => Promise.resolve()),
    backgroundAudioMode: opts.backgroundAudioMode ?? 'none',
    silentFileUrl: opts.silentFileUrl,
    registerShepard: shepard.register,
    createShepard: shepard.create,
    createMixer,
    layerScheduler: opts.layerSchedulerFactory ?? layerScheduler?.factory,
  });
  transport.on('error', (n) => notices.error.push(n));
  transport.on('warning', (n) => notices.warning.push(n));
  if (opts.autoload !== false) transport.load(preset);
  return {
    transport,
    fakeCtx,
    scheduler,
    factory,
    preset,
    notices,
    shepard,
    layerScheduler,
    getMixer: (): FakeMixer | undefined => mixer,
  };
}

function lastMasterGain(fakeCtx: FakeAudioContext): MockAudioParam {
  const gains = fakeCtx.created.gains;
  return gains[gains.length - 1].gain;
}
function lastRampTarget(param: MockAudioParam, method: 'linearRampToValueAtTime' | 'setValueAtTime'): number | undefined {
  const evts = param.events.filter((e) => e.method === method);
  return evts.length ? evts[evts.length - 1].value : undefined;
}

beforeEach(() => {
  vi.useFakeTimers();
  audioPlayBehavior = 'resolve';
  fakeAudio = makeFakeAudio(() => audioPlayBehavior);
  const spy = vi.spyOn(document, 'createElement') as unknown as {
    mockImplementation(fn: (tag: string) => unknown): void;
  };
  spy.mockImplementation((tag: string) => (tag === 'audio' ? fakeAudio : realCreateElement(tag)));
  Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
  rafCallbacks = [];
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    rafCallbacks.push(cb);
    return rafCallbacks.length;
  });
  vi.stubGlobal('cancelAnimationFrame', () => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  delete (navigator as unknown as Record<string, unknown>).mediaSession;
  delete (navigator as unknown as Record<string, unknown>).wakeLock;
});

// =====================================================================================
// Task 3 — state machine, event emitter, load, position/duration, setMasterTrim, seek
// =====================================================================================

describe('state machine & control-surface boundaries (Task 3 — A1–A9, H1)', () => {
  it('A4: play() while already playing is a no-op', async () => {
    const { transport, scheduler } = setup();
    await transport.play();
    expect(transport.state).toBe('playing');
    expect(scheduler.apply).toHaveBeenCalledTimes(1);
    await transport.play();
    expect(scheduler.apply).toHaveBeenCalledTimes(1); // no second schedule
    expect(transport.state).toBe('playing');
  });

  it('A5: pause() while not playing is a no-op', async () => {
    const { transport } = setup();
    await transport.pause(); // idle
    expect(transport.state).toBe('idle');
  });

  it('A6: stop() while idle or stopped is a no-op', async () => {
    const { transport, scheduler } = setup();
    await transport.stop(); // idle
    expect(transport.state).toBe('idle');
    expect(scheduler.cancel).not.toHaveBeenCalled();
  });

  it('A8: load() while active stops the session first, then resets to idle', async () => {
    const { transport, scheduler } = setup();
    await transport.play();
    expect(transport.state).toBe('playing');
    transport.load(makePreset({ durationSec: 50 }));
    expect(scheduler.cancel).toHaveBeenCalledTimes(1); // old session torn down
    expect(transport.state).toBe('idle');
    expect(transport.position()).toBe(0); // startOffset reset
    expect(transport.duration()).toBe(50);
  });

  it('A7: any method after destroy() throws DISPOSED', async () => {
    const { transport } = setup();
    await transport.destroy();
    expect(() => transport.position()).toThrow(TransportError);
    expect(() => transport.duration()).toThrow(TransportError);
    expect(() => transport.setMasterTrim(0.5)).toThrow(TransportError);
    expect(() => transport.reapply()).toThrow(TransportError);
    expect(() => transport.isKeepScreenOn()).toThrow(TransportError);
    expect(() => transport.load(makePreset())).toThrow(TransportError);
    expect(() => transport.on('tick', () => {})).toThrow(TransportError);
    await expect(transport.play()).rejects.toBeInstanceOf(TransportError);
    await expect(transport.pause()).rejects.toBeInstanceOf(TransportError);
    await expect(transport.seek(1)).rejects.toBeInstanceOf(TransportError);
    await expect(transport.prime()).rejects.toBeInstanceOf(TransportError);
    await expect(transport.setKeepScreenOn(true)).rejects.toBeInstanceOf(TransportError);
    try {
      transport.position();
    } catch (e) {
      expect((e as TransportError).code).toBe('DISPOSED');
    }
  });

  it('A2/A3: seek clamps finite t and throws INVALID_SEEK on non-finite', async () => {
    const { transport } = setup({ duration: 100 });
    await transport.seek(-10); // idle: clamp to 0
    expect(transport.position()).toBe(0);
    await transport.seek(99999); // clamp to durationSec
    expect(transport.position()).toBe(100);
    await expect(transport.seek(Number.NaN)).rejects.toMatchObject({ code: 'INVALID_SEEK' });
    await expect(transport.seek(Number.POSITIVE_INFINITY)).rejects.toMatchObject({ code: 'INVALID_SEEK' });
  });

  it('A1: play()/seek() with no preset loaded throws NO_PRESET', async () => {
    const { transport } = setup({ autoload: false });
    await expect(transport.play()).rejects.toMatchObject({ code: 'NO_PRESET' });
    await expect(transport.seek(1)).rejects.toMatchObject({ code: 'NO_PRESET' });
  });

  it('A9: setMasterTrim clamps to 0..1 and ignores non-finite', async () => {
    const { transport, fakeCtx } = setup();
    await transport.play();
    const mg = lastMasterGain(fakeCtx);
    transport.setMasterTrim(2); // clamp to 1
    expect(lastRampTarget(mg, 'linearRampToValueAtTime')).toBeCloseTo(1);
    transport.setMasterTrim(-1); // clamp to 0
    expect(lastRampTarget(mg, 'linearRampToValueAtTime')).toBeCloseTo(0);
    const before = mg.events.length;
    transport.setMasterTrim(Number.NaN); // ignored — no new ramp written
    expect(mg.events.length).toBe(before);
  });

  it('H1: position() is frozen when stopped and reads startOffset while idle', async () => {
    const { transport, fakeCtx } = setup({ duration: 100 });
    await transport.seek(40);
    expect(transport.position()).toBe(40); // idle → startOffset
    await transport.play();
    fakeCtx.currentTime = 10;
    const playingPos = transport.position();
    expect(playingPos).toBeGreaterThan(40);
    await transport.stop();
    const frozen = transport.position();
    fakeCtx.currentTime = 90; // clock keeps advancing after stop
    expect(transport.position()).toBe(frozen); // still frozen
  });

  it('on/off add and remove handlers by identity; statechange fires on transitions', async () => {
    const { transport } = setup();
    const h = vi.fn();
    transport.on('statechange', h);
    await transport.play();
    expect(h).toHaveBeenCalledWith({ state: 'playing' });
    expect(h).toHaveBeenCalledTimes(1);
    transport.off('statechange', h);
    await transport.stop();
    expect(h).toHaveBeenCalledTimes(1); // not called after off()
  });
});

// =====================================================================================
// Task 6 — play start sequence, pause/resume, seek reschedule, fades, tick, end timer
// =====================================================================================

describe('play() start sequence (Task 6 — §6 / B5 / I1 / I2)', () => {
  it('§6/B5: fires resume() and starts the source at t0 in the gesture; masterGain fades 0→trim', async () => {
    const { transport, fakeCtx, scheduler } = setup({ masterGain: 0.7 });
    await transport.play();

    expect(fakeCtx.resumeCalls).toBeGreaterThanOrEqual(1); // resume fired
    const oscs = fakeCtx.created.oscillators;
    const oscL = oscs[oscs.length - 2];
    expect(oscL.started).toBe(true);
    expect(oscL.startTime).toBeCloseTo(0.02); // t0 = currentTime(0) + startLeadSec

    const mg = lastMasterGain(fakeCtx);
    expect(mg.events[0]).toMatchObject({ method: 'cancelAndHoldAtTime' });
    const anchor = mg.events.find((e) => e.method === 'setValueAtTime');
    expect(anchor?.value).toBeCloseTo(0); // begins at 0
    expect(lastRampTarget(mg, 'linearRampToValueAtTime')).toBeCloseTo(0.7); // fades to trim

    expect(scheduler.apply).toHaveBeenCalledTimes(1);
    const args = scheduler.apply.mock.calls[0];
    expect(args[2]).toBe(0); // fromSec = startOffset
    expect(args[3]).toBeCloseTo(0.02); // atCtxTime = t0
    expect(args[4]).toEqual({ pulseAvailable: true });
  });

  it('I2: passes pulseAvailable=false when the worklet is not ready', async () => {
    const { transport, scheduler, notices } = setup({
      registerWorklet: () => Promise.reject(new Error('addModule failed')),
    });
    await transport.play();
    expect(scheduler.apply.mock.calls[0][4]).toEqual({ pulseAvailable: false });
    expect(notices.warning.some((n) => n.code === 'WORKLET_UNAVAILABLE')).toBe(true);
  });

  it('B5: play() never blocks on in-flight worklet registration (gesture-safe autoplay)', async () => {
    // Regression: doPrime() must NOT await registerWorklet. If it did, this play()
    // whose registration never settles during the gesture would hang here, and on real
    // Safari ctx.resume()/voice.start() would fall outside the user-activation window.
    let settle: () => void = () => {};
    const registerWorklet = vi.fn(() => new Promise<void>((res) => { settle = res; }));
    const { transport, fakeCtx, scheduler } = setup({ registerWorklet });

    await transport.play(); // resolves despite registration still pending

    expect(scheduler.apply).toHaveBeenCalledTimes(1);
    expect(scheduler.apply.mock.calls[0][4]).toEqual({ pulseAvailable: false });
    const oscs = fakeCtx.created.oscillators;
    expect(oscs[oscs.length - 2].started).toBe(true); // voice.start() ran in the gesture
    expect(registerWorklet).toHaveBeenCalledTimes(1);

    settle(); // late registration completes harmlessly
    await Promise.resolve();
  });

  it('I1: a scheduler.apply failure aborts the start with a fatal SCHEDULE_FAILED and no half-played session', async () => {
    const scheduler = makeScheduler();
    scheduler.apply.mockImplementation(() => {
      throw new Error('boom');
    });
    const { transport, fakeCtx, notices } = setup({ scheduler });
    await transport.play();
    expect(notices.error.some((n) => n.code === 'SCHEDULE_FAILED')).toBe(true);
    expect(transport.state).toBe('stopped');
    expect(scheduler.cancel).toHaveBeenCalledTimes(1); // teardown(false) ran
    const oscs = fakeCtx.created.oscillators;
    expect(oscs[oscs.length - 1].started).toBe(false); // voice never started
  });
});

describe('pause / resume (Task 6 — C3 / §7)', () => {
  it('C3: pause fades to silence then suspends; resume fades up and re-arms the end timer', async () => {
    const { transport, fakeCtx } = setup({ duration: 100 });
    await transport.play();
    fakeCtx.currentTime = 30; // simulate 30 s of playback
    const mg = lastMasterGain(fakeCtx);

    const pausePromise = transport.pause();
    expect(lastRampTarget(mg, 'linearRampToValueAtTime')).toBeCloseTo(0); // fade to silence first
    expect(fakeCtx.suspendCalls).toBe(0); // not yet — only after the fade
    await vi.advanceTimersByTimeAsync(20); // pauseFadeSec
    await pausePromise;
    expect(fakeCtx.suspendCalls).toBe(1);
    expect(transport.state).toBe('paused');

    const ended = vi.fn();
    transport.on('ended', ended);
    await transport.play(); // resume
    expect(transport.state).toBe('playing');
    expect(lastRampTarget(mg, 'linearRampToValueAtTime')).toBeCloseTo(transport.position() > 0 ? 0.8 : 0.8); // fade back to trim

    const remainingMs = (100 - transport.position()) * 1000;
    await vi.advanceTimersByTimeAsync(remainingMs + 50);
    expect(ended).toHaveBeenCalledTimes(1); // end timer was re-armed with recomputed remaining
  });

  it('§7: a seek while paused reschedules from the new offset on resume', async () => {
    const { transport, scheduler, fakeCtx } = setup({ duration: 100 });
    await transport.play();
    const pausePromise = transport.pause();
    await vi.advanceTimersByTimeAsync(20);
    await pausePromise;
    scheduler.cancel.mockClear();
    scheduler.apply.mockClear();

    await transport.seek(55); // paused → store + needsReschedule
    expect(transport.position()).toBe(55);

    await transport.play(); // resume → cancel + apply from 55
    expect(scheduler.cancel).toHaveBeenCalledTimes(1);
    expect(scheduler.apply).toHaveBeenCalledTimes(1);
    expect(scheduler.apply.mock.calls[0][2]).toBe(55);
    expect(fakeCtx.resumeCalls).toBeGreaterThanOrEqual(1);
  });
});

describe('seek while playing (Task 6 — C4 / A10)', () => {
  it('C4: fades to silence, cancels, reschedules from t, fades back, re-arms, emits one tick', async () => {
    const { transport, scheduler, fakeCtx } = setup({ duration: 100 });
    await transport.play();
    scheduler.apply.mockClear();
    const mg = lastMasterGain(fakeCtx);
    const tick = vi.fn();
    transport.on('tick', tick);

    const seekPromise = transport.seek(60);
    expect(lastRampTarget(mg, 'linearRampToValueAtTime')).toBeCloseTo(0); // fade down first
    await vi.advanceTimersByTimeAsync(20); // seekFadeSec
    await seekPromise;

    expect(scheduler.cancel).toHaveBeenCalledTimes(1);
    expect(scheduler.apply).toHaveBeenCalledTimes(1);
    expect(scheduler.apply.mock.calls[0][2]).toBe(60); // fresh schedule from t
    expect(lastRampTarget(mg, 'linearRampToValueAtTime')).toBeCloseTo(0.8); // fade back to trim
    expect(tick).toHaveBeenCalled(); // snaps the playhead
  });

  it('A10: rapid successive seeks — only the latest token completes', async () => {
    const { transport, scheduler } = setup({ duration: 100 });
    await transport.play();
    scheduler.apply.mockClear();
    scheduler.cancel.mockClear();

    void transport.seek(10);
    void transport.seek(20);
    void transport.seek(30);
    await vi.advanceTimersByTimeAsync(20);
    await microflush();

    expect(scheduler.cancel).toHaveBeenCalledTimes(1); // only the latest reaches cancel
    expect(scheduler.apply).toHaveBeenCalledTimes(1);
    expect(scheduler.apply.mock.calls[0][2]).toBe(30); // latest seek
  });
});

describe('tick loop & end-of-session (Task 6 — H3/H4/H5, ended)', () => {
  it('emits tick with a clamped position and the current state', async () => {
    const { transport } = setup({ duration: 100 });
    const tick = vi.fn();
    transport.on('tick', tick);
    await transport.play();
    flushRaf();
    expect(tick).toHaveBeenCalled();
    const payload = tick.mock.calls[0][0] as { positionSec: number; durationSec: number; state: string };
    expect(payload.durationSec).toBe(100);
    expect(payload.state).toBe('playing');
    expect(payload.positionSec).toBeGreaterThanOrEqual(0);
    expect(payload.positionSec).toBeLessThanOrEqual(100);
  });

  it('H3: the end timer is authoritative — it fires even when rAF never runs (backgrounded)', async () => {
    const { transport } = setup({ duration: 10 });
    const ended = vi.fn();
    transport.on('ended', ended);
    await transport.play();
    // Never flushRaf() — simulate a hidden tab where rAF is throttled to zero.
    await vi.advanceTimersByTimeAsync(10_000);
    expect(ended).toHaveBeenCalledTimes(1);
    expect(transport.state).toBe('stopped');
  });

  it('H4: a late/extra timer fire is harmless — ended is emitted exactly once', async () => {
    const { transport } = setup({ duration: 10 });
    const ended = vi.fn();
    transport.on('ended', ended);
    await transport.play();
    await vi.advanceTimersByTimeAsync(10_000);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(ended).toHaveBeenCalledTimes(1);
  });

  it('H5: a 24 h duration arms the end timer without overflow', async () => {
    const { transport } = setup({ duration: 86_400 });
    const ended = vi.fn();
    transport.on('ended', ended);
    await transport.play();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(ended).not.toHaveBeenCalled(); // would fire instantly if remainingMs had wrapped
    await vi.advanceTimersByTimeAsync(86_400_000);
    expect(ended).toHaveBeenCalledTimes(1);
  });

  it('emits ended on natural end but NOT on a user stop()', async () => {
    const stopped = setup({ duration: 10 });
    const endedOnStop = vi.fn();
    stopped.transport.on('ended', endedOnStop);
    await stopped.transport.play();
    await stopped.transport.stop();
    await vi.advanceTimersByTimeAsync(600); // flush the fade-out teardown
    expect(endedOnStop).not.toHaveBeenCalled();
    expect(stopped.transport.state).toBe('stopped');
  });
});

// =====================================================================================
// Task 4 — AudioContext lifecycle, recovery, Wake Lock, teardown, destroy
// =====================================================================================

describe('AudioContext lifecycle & autoplay (Task 4 — B2/B3, J1/J2/J3/J6)', () => {
  it('B3: with no AudioContext constructor, prime/play emit a fatal WEB_AUDIO_UNSUPPORTED and stay idle', async () => {
    const { transport, notices } = setup({ noFactory: true });
    await transport.prime();
    expect(notices.error.some((n) => n.code === 'WEB_AUDIO_UNSUPPORTED')).toBe(true);
    expect(transport.state).toBe('idle');
    await transport.play();
    expect(transport.state).toBe('idle'); // still cannot proceed
  });

  it('B2: prime() is idempotent and surfaces WORKLET_UNAVAILABLE when registration fails', async () => {
    const registerWorklet = vi.fn(() => Promise.reject(new Error('addModule failed')));
    const { transport, notices } = setup({ registerWorklet });
    await transport.prime();
    await transport.prime();
    expect(registerWorklet).toHaveBeenCalledTimes(1); // idempotent
    expect(notices.warning.some((n) => n.code === 'WORKLET_UNAVAILABLE')).toBe(true);
  });

  it('J1: many play→stop cycles reuse the same context and re-register the worklet once', async () => {
    const registerWorklet = vi.fn(() => Promise.resolve());
    const { transport, fakeCtx, factory } = setup({ registerWorklet });
    await transport.play();
    await transport.stop();
    await vi.advanceTimersByTimeAsync(600);
    await transport.play();
    expect(factory).toHaveBeenCalledTimes(1); // same AudioContext reused
    expect(registerWorklet).toHaveBeenCalledTimes(1);
    expect(fakeCtx.created.oscillators.length).toBe(4); // a fresh voice (2 oscs) per play
  });

  it('J2: destroy() twice is a no-op (close called once)', async () => {
    const { transport, fakeCtx } = setup();
    await transport.prime();
    await transport.destroy();
    await transport.destroy();
    expect(fakeCtx.closeCalls).toBe(1);
  });

  it('J3: destroy() while playing tears down and closes the context', async () => {
    const { transport, fakeCtx } = setup();
    await transport.play();
    await transport.destroy();
    expect(fakeCtx.closeCalls).toBe(1);
    expect(() => transport.position()).toThrow(TransportError);
  });

  it('J6: an offline-style context (no MediaStream / rAF / mediaSession / wakeLock) degrades to no-ops', async () => {
    vi.stubGlobal('requestAnimationFrame', undefined);
    vi.stubGlobal('cancelAnimationFrame', undefined);
    const { transport, fakeCtx, scheduler, notices } = setup({
      fakeOpts: { mediaStream: false },
      backgroundAudioMode: 'mediastream',
      duration: 5,
    });
    await transport.play();
    expect(transport.state).toBe('playing'); // core scheduling path still works
    expect(scheduler.apply).toHaveBeenCalledTimes(1);
    expect(fakeCtx.msDests).toHaveLength(0); // createMediaStreamDestination absent → direct
    expect(notices.error).toHaveLength(0);
    // The end timer (not rAF) still drives the session end.
    const ended = vi.fn();
    transport.on('ended', ended);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(ended).toHaveBeenCalledTimes(1);
  });
});

describe('visibility / iOS interruption recovery (Task 4 — F2–F6)', () => {
  it('F2: an unexpected statechange away from running marks the transport interrupted', async () => {
    const { transport, fakeCtx, notices } = setup();
    await transport.play();
    fakeCtx.state = 'interrupted';
    fakeCtx.emitStateChange();
    expect(transport.state).toBe('interrupted');
    expect(notices.warning.some((n) => n.code === 'CONTEXT_INTERRUPTED')).toBe(true);
  });

  it('F3/F4: returning to visible runs suspend→resume and recovers when running', async () => {
    const { transport, fakeCtx, notices } = setup();
    await transport.play();
    fakeCtx.state = 'interrupted';
    fakeCtx.emitStateChange();
    expect(transport.state).toBe('interrupted');

    const suspendBefore = fakeCtx.suspendCalls;
    document.dispatchEvent(new Event('visibilitychange'));
    await microflush();
    expect(fakeCtx.suspendCalls).toBe(suspendBefore + 1); // suspend→resume unstick
    expect(transport.state).toBe('playing');
    expect(notices.warning.some((n) => n.code === 'CONTEXT_RECOVERED')).toBe(true);
  });

  it('F5: when resume stays stuck, the transport stays interrupted (no recovery)', async () => {
    const { transport, fakeCtx, notices } = setup();
    await transport.play();
    fakeCtx.state = 'interrupted';
    fakeCtx.emitStateChange();
    fakeCtx.resumeFails = true;

    document.dispatchEvent(new Event('visibilitychange'));
    await microflush();
    expect(transport.state).toBe('interrupted');
    expect(notices.warning.filter((n) => n.code === 'CONTEXT_RECOVERED')).toHaveLength(0);
  });

  it('F6: no recovery is attempted after a deliberate user pause()', async () => {
    const { transport, fakeCtx } = setup();
    await transport.play();
    const pausePromise = transport.pause();
    await vi.advanceTimersByTimeAsync(20);
    await pausePromise;
    expect(transport.state).toBe('paused');

    const resumeBefore = fakeCtx.resumeCalls;
    document.dispatchEvent(new Event('visibilitychange'));
    await microflush();
    expect(fakeCtx.resumeCalls).toBe(resumeBefore); // never auto-recovered
    expect(transport.state).toBe('paused');
  });
});

describe('Wake Lock (Task 4 — G1/G2/G3)', () => {
  it('G1: setKeepScreenOn(true) without wakeLock support warns and stays off', async () => {
    const { transport, notices } = setup();
    await transport.setKeepScreenOn(true);
    expect(notices.warning.some((n) => n.code === 'WAKE_LOCK_UNSUPPORTED')).toBe(true);
    expect(transport.isKeepScreenOn()).toBe(false);
  });

  it('G2: a rejected wakeLock.request warns and the toggle stays off', async () => {
    installWakeLock({ reject: true });
    const { transport, notices } = setup();
    await transport.setKeepScreenOn(true);
    expect(notices.warning.some((n) => n.code === 'WAKE_LOCK_FAILED')).toBe(true);
    expect(transport.isKeepScreenOn()).toBe(false);
  });

  it('G3: re-acquires the lock on visibilitychange while playing with the toggle on', async () => {
    const wl = installWakeLock();
    const { transport } = setup();
    await transport.play();
    await transport.setKeepScreenOn(true);
    expect(transport.isKeepScreenOn()).toBe(true);
    expect(wl.request).toHaveBeenCalledTimes(1);

    document.dispatchEvent(new Event('visibilitychange'));
    await microflush();
    expect(wl.request).toHaveBeenCalledTimes(2); // transparently re-acquired
  });
});

// =====================================================================================
// Task 5 — background-audio bridge (D-018) and MediaSession
// =====================================================================================

describe('background-audio bridge — D-018 (Task 5 — D1/D2/D3/D5/D6)', () => {
  it('D1: mediastream resolve routes the voice through the <audio> as the sole audible path', async () => {
    const { transport, fakeCtx } = setup({ backgroundAudioMode: 'mediastream' });
    await transport.play();
    await microflush();
    const msDest = fakeCtx.msDests[0];
    const masterGain = fakeCtx.created.gains[fakeCtx.created.gains.length - 1];
    expect(masterGain.isConnectedTo(msDest)).toBe(true);
    expect(masterGain.isConnectedTo(fakeCtx.destination)).toBe(false); // not doubled
    expect(fakeAudio.srcObject).toBe(msDest.stream);
    expect(fakeAudio.play).toHaveBeenCalled();
  });

  it('D2: mediastream reject reconnects direct and warns BACKGROUND_AUDIO_UNAVAILABLE', async () => {
    audioPlayBehavior = 'reject';
    const { transport, fakeCtx, notices } = setup({ backgroundAudioMode: 'mediastream' });
    await transport.play();
    await microflush();
    const masterGain = fakeCtx.created.gains[fakeCtx.created.gains.length - 1];
    expect(masterGain.isConnectedTo(fakeCtx.destination)).toBe(true); // direct fallback
    const msDest = fakeCtx.msDests[0];
    expect(masterGain.isConnectedTo(msDest)).toBe(false);
    expect(fakeAudio.pause).toHaveBeenCalled();
    expect(notices.warning.some((n) => n.code === 'BACKGROUND_AUDIO_UNAVAILABLE')).toBe(true);
  });

  it('D3: exactly one audible path is connected at a time (no doubling)', async () => {
    const { transport, fakeCtx } = setup({ backgroundAudioMode: 'mediastream' });
    await transport.play();
    await microflush();
    const masterGain = fakeCtx.created.gains[fakeCtx.created.gains.length - 1];
    expect(masterGain.connections).toHaveLength(1);
    expect(masterGain.connections[0].destination).toBe(fakeCtx.msDests[0]);
  });

  it('D5: silent-file mode plays a looping <audio> of the bundled asset', async () => {
    const { transport } = setup({ backgroundAudioMode: 'silent-file', silentFileUrl: '/silent-5s.mp3' });
    await transport.play();
    await microflush();
    expect(fakeAudio.loop).toBe(true);
    expect(fakeAudio.src).toBe('/silent-5s.mp3');
    expect(fakeAudio.play).toHaveBeenCalled();
  });

  it('D6: none mode connects directly and attaches no MediaSession', async () => {
    const ms = installMediaSession();
    const { transport, fakeCtx } = setup({ backgroundAudioMode: 'none' });
    await transport.play();
    const masterGain = fakeCtx.created.gains[fakeCtx.created.gains.length - 1];
    expect(masterGain.isConnectedTo(fakeCtx.destination)).toBe(true);
    expect(fakeCtx.msDests).toHaveLength(0);
    expect(ms.handlers.play).toBeUndefined(); // no MediaSession in none mode
  });
});

describe('MediaSession — D-018 (Task 5 — E1/E2/E3/E4/E5)', () => {
  it('E1: with navigator.mediaSession absent, playback is unaffected', async () => {
    const { transport } = setup({ backgroundAudioMode: 'mediastream' });
    await transport.play();
    await microflush();
    expect(transport.state).toBe('playing'); // no throw, no MediaSession
  });

  it('E2: a setActionHandler that throws for an unknown action is caught per handler', async () => {
    const ms = installMediaSession();
    ms.throwOnSeekto = true;
    const { transport } = setup({ backgroundAudioMode: 'mediastream' });
    await transport.play();
    await microflush();
    expect(ms.handlers.play).toBeTypeOf('function');
    expect(ms.handlers.pause).toBeTypeOf('function');
    expect(ms.handlers.stop).toBeTypeOf('function');
    expect(transport.state).toBe('playing'); // the seekto throw did not break setup
  });

  it('E3/E5: lock-screen stop routes to stop() and clears handlers + playbackState', async () => {
    const ms = installMediaSession();
    const { transport } = setup({ backgroundAudioMode: 'mediastream' });
    await transport.play();
    await microflush();
    expect(ms.playbackState).toBe('playing');

    ms.handlers.stop?.({}); // lock-screen stop
    expect(transport.state).toBe('stopped'); // routed to stop() immediately
    await vi.advanceTimersByTimeAsync(600); // flush the fade-out teardown that clears MediaSession
    expect(ms.handlers.play).toBeNull();
    expect(ms.metadata).toBeNull();
    expect(ms.playbackState).toBe('none');
  });

  it('E4: setPositionState is throttled to mediaSessionPositionThrottleMs', async () => {
    const ms = installMediaSession();
    const { transport } = setup({ backgroundAudioMode: 'mediastream', duration: 100 });
    await transport.play();
    await microflush();
    flushRaf();
    flushRaf();
    flushRaf();
    const after1s = ms.positionStates.length;
    await vi.advanceTimersByTimeAsync(1_000);
    flushRaf();
    flushRaf();
    expect(ms.positionStates.length).toBe(after1s + 1); // at most one more per throttle window
  });
});

// =====================================================================================
// Task 6 — reapply (live edit, I3b)
// =====================================================================================

describe('reapply() — live edit (Task 6 — I3b / §10)', () => {
  it('routes through scheduler.retarget while playing without moving the playhead', async () => {
    const { transport, scheduler } = setup();
    await transport.play();
    const pos = transport.position();
    transport.reapply();
    expect(scheduler.retarget).toHaveBeenCalledTimes(1);
    expect(transport.position()).toBeCloseTo(pos); // playhead unchanged
  });

  it('is a no-op while idle/stopped and throws NO_PRESET with nothing loaded', async () => {
    const idle = setup();
    idle.transport.reapply(); // idle → no-op
    expect(idle.scheduler.retarget).not.toHaveBeenCalled();

    const empty = setup({ autoload: false });
    expect(() => empty.transport.reapply()).toThrow(TransportError);
  });
});

// =====================================================================================
// Shepard "lift" overlay — a parallel aux path (independent live layer)
// =====================================================================================

describe('setLift() — the parallel Shepard "lift" aux path', () => {
  // The shepard node feeds an aux fade-gain; that gain connects to the output target.
  function liftFadeGain(node: MockGainNode): MockGainNode {
    return node.connections[0].destination as unknown as MockGainNode;
  }

  it('K4: attaches the aux lift to mixer.liftInput (post-duck overlay), fading in click-free', async () => {
    const { transport, fakeCtx, shepard, getMixer } = setup({ backgroundAudioMode: 'none', fakeMixer: true });
    await transport.play();
    const mixer = getMixer();
    if (!mixer) throw new Error('mixer not composed');
    // mixer.master is the single audible edge; the voice has no direct destination edge.
    expect(mixer.master.isConnectedTo(fakeCtx.destination)).toBe(true);
    const masterConnsBefore = mixer.master.connections.length;

    transport.setLift({ speed: 0.3, gain: 0.4 });
    await microflush();

    expect(shepard.register).toHaveBeenCalledTimes(1); // register-before-create
    expect(shepard.create).toHaveBeenCalledTimes(1);
    const node = shepard.handles[0].node;
    const aux = liftFadeGain(node);
    expect(node.isConnectedTo(aux)).toBe(true); // shepard → aux gain
    // K4: the aux lift joins the bus at mixer.liftInput (post-duck), NOT the destination.
    expect(aux.isConnectedTo(mixer.liftInput)).toBe(true);
    expect(aux.isConnectedTo(fakeCtx.destination)).toBe(false);

    // Click-free 10 ms fade-in: anchored at 0, ramps to 1.
    expect(lastRampTarget(aux.gain, 'linearRampToValueAtTime')).toBeCloseTo(1);
    const anchor = aux.gain.events.find((e) => e.method === 'setValueAtTime');
    expect(anchor?.value).toBeCloseTo(0);

    // The voice/bridge routing (mixer.master) is untouched (a strictly parallel path).
    expect(mixer.master.connections.length).toBe(masterConnsBefore);
    expect(mixer.master.isConnectedTo(fakeCtx.destination)).toBe(true);
  });

  it('updates speed/gain live on the running node without rebuilding it', async () => {
    const { transport, shepard } = setup();
    await transport.play();
    transport.setLift({ speed: 0.3, gain: 0.4 });
    await microflush();
    expect(shepard.create).toHaveBeenCalledTimes(1);
    const { speedParam, gainParam } = shepard.handles[0];

    transport.setLift({ speed: -0.6, gain: 0.8 }); // descending, louder
    await microflush();

    expect(shepard.create).toHaveBeenCalledTimes(1); // SAME node — not rebuilt (phase continuity)
    expect(lastRampTarget(speedParam, 'linearRampToValueAtTime')).toBeCloseTo(-0.6);
    expect(lastRampTarget(gainParam, 'linearRampToValueAtTime')).toBeCloseTo(0.8);
  });

  it('setLift(null) fades the aux gain out and disposes the node', async () => {
    const { transport, shepard } = setup();
    await transport.play();
    transport.setLift({ speed: 0.3, gain: 0.4 });
    await microflush();
    const node = shepard.handles[0].node;
    const aux = liftFadeGain(node);

    transport.setLift(null);
    expect(lastRampTarget(aux.gain, 'linearRampToValueAtTime')).toBeCloseTo(0); // fade to silence
    await vi.advanceTimersByTimeAsync(50); // > trimRampSec → disposal fires
    expect(node.disconnectCalls).toBeGreaterThan(0);
    expect(aux.disconnectCalls).toBeGreaterThan(0);
  });

  it('disposes the lift on teardown (stop) and ignores non-finite speed/gain', async () => {
    const { transport, shepard } = setup({ duration: 100 });
    await transport.play();
    transport.setLift({ speed: 0.3, gain: 0.4 });
    await microflush();
    const node = shepard.handles[0].node;
    const aux = liftFadeGain(node);

    transport.setLift({ speed: Number.NaN, gain: 0.5 }); // ignored — no rebuild, no throw
    await microflush();
    expect(shepard.create).toHaveBeenCalledTimes(1);

    await transport.stop();
    await vi.advanceTimersByTimeAsync(600); // flush the fade-out teardown
    expect(node.disconnectCalls).toBeGreaterThan(0);
    expect(aux.disconnectCalls).toBeGreaterThan(0);
  });

  it('stores the lift while idle and applies it on the next play(); a user stop() clears it', async () => {
    const { transport, shepard } = setup();
    transport.setLift({ speed: 0.3, gain: 0.4 }); // idle → stored, not yet applied
    expect(shepard.create).not.toHaveBeenCalled();

    await transport.play();
    await microflush();
    expect(shepard.create).toHaveBeenCalledTimes(1); // re-applied on play

    await transport.stop();
    await vi.advanceTimersByTimeAsync(600);
    await transport.play(); // a fresh session
    await microflush();
    expect(shepard.create).toHaveBeenCalledTimes(1); // intent was cleared on stop → not re-created
  });
});

// =====================================================================================
// Phase 2 — the unified mixer bus + layers (D-036; arch §1/§2.2/§4/§6, design §19, K1–K8)
// =====================================================================================

describe('Phase-2 bus composition (K1/K2/K3/K5 — §19.2/§19.3)', () => {
  it('K1: builds the voice with { master: "bus" } so its internal masterGain is unity passthrough', async () => {
    const createVoiceSpy = vi.fn(createVoice);
    const fakeCtx = new FakeAudioContext({ mediaStream: false });
    const transport = createTransport({
      scheduler: makeScheduler() as unknown as SessionScheduler,
      audioContextFactory: (() => fakeCtx) as unknown as () => AudioContext,
      registerWorklet: () => Promise.resolve(),
      backgroundAudioMode: 'none',
      createVoice: createVoiceSpy as unknown as (ctx: BaseAudioContext) => Voice,
    });
    transport.load(makePreset());
    await transport.play();

    // The DI seam observed { master: 'bus' }.
    expect(createVoiceSpy).toHaveBeenCalledTimes(1);
    expect(createVoiceSpy.mock.calls[0][1]).toEqual({ master: 'bus' });

    // Double-attenuation guard: the voice's own masterGain is unity (1) and setMasterGain
    // is a no-op (non-finite still throws — contract parity).
    const voice = createVoiceSpy.mock.results[0].value as Voice;
    expect((voice.masterGainParam as unknown as MockAudioParam).valueAtTime(0)).toBeCloseTo(1);
    const before = (voice.masterGainParam as unknown as MockAudioParam).events.length;
    voice.setMasterGain(0.3); // bus mode → guarded no-op
    expect((voice.masterGainParam as unknown as MockAudioParam).events.length).toBe(before);
    expect(() => voice.setMasterGain(Number.NaN)).toThrow();
  });

  it('K3: the voice feeds mixer.bedInput and mixer.master is the single audible edge (no direct destination edge)', async () => {
    const { transport, fakeCtx, getMixer } = setup({ fakeMixer: true, backgroundAudioMode: 'none' });
    await transport.play();
    const mixer = getMixer();
    if (!mixer) throw new Error('mixer not composed');
    // The voice joins the BED sub-bus; it has NO direct destination edge.
    expect(mixer.bedInput.inputs.length).toBeGreaterThan(0); // the voice.output connected here
    const voiceMaster = mixer.bedInput.inputs[0] as unknown as MockGainNode;
    expect(voiceMaster.isConnectedTo(fakeCtx.destination as unknown as MockAudioNode)).toBe(false);
    // Single-input master: master has exactly one downstream edge (the destination).
    expect(mixer.master.connections).toHaveLength(1);
    expect(mixer.master.connections[0].destination).toBe(fakeCtx.destination);
  });

  it('K2: mediastream resolve moves ONLY mixer.master between destination and msDest', async () => {
    const { transport, fakeCtx, getMixer } = setup({ fakeMixer: true, backgroundAudioMode: 'mediastream' });
    await transport.play();
    await microflush();
    const mixer = getMixer();
    if (!mixer) throw new Error('mixer not composed');
    const msDest = fakeCtx.msDests[0];
    expect(mixer.master.isConnectedTo(msDest)).toBe(true);
    expect(mixer.master.isConnectedTo(fakeCtx.destination)).toBe(false); // moved, not doubled
    expect(mixer.master.connections).toHaveLength(1); // exactly one audible edge
  });

  it('K2: iOS playBridgeElement fallback moves ONLY mixer.master back to the destination', async () => {
    audioPlayBehavior = 'reject';
    const { transport, fakeCtx, getMixer, notices } = setup({ fakeMixer: true, backgroundAudioMode: 'mediastream' });
    await transport.play();
    await microflush();
    const mixer = getMixer();
    if (!mixer) throw new Error('mixer not composed');
    const msDest = fakeCtx.msDests[0];
    expect(mixer.master.isConnectedTo(fakeCtx.destination)).toBe(true); // direct fallback
    expect(mixer.master.isConnectedTo(msDest)).toBe(false);
    expect(mixer.master.connections).toHaveLength(1);
    expect(notices.warning.some((n) => n.code === 'BACKGROUND_AUDIO_UNAVAILABLE')).toBe(true);
  });

  it('K5: a preset with no layers still composes the mixer and routes voice→bedInput→master', async () => {
    const { transport, fakeCtx, getMixer, layerScheduler } = setup({
      fakeMixer: true,
      layers: true,
      backgroundAudioMode: 'none',
      preset: makePreset({ layers: undefined }),
    });
    await transport.play();
    await microflush();
    const mixer = getMixer();
    if (!mixer) throw new Error('mixer composed even with no layers');
    expect(mixer.bedInput.inputs.length).toBeGreaterThan(0); // voice → bedInput
    expect(mixer.master.isConnectedTo(fakeCtx.destination)).toBe(true);
    expect(layerScheduler?.calls).toHaveLength(0); // no layers → no scheduleLayers
  });

  it('K8: transport never writes the duck param (mixer.scheduleDuck is the layer scheduler\'s job)', async () => {
    const { transport, getMixer } = setup({
      fakeMixer: true,
      layers: true,
      backgroundAudioMode: 'none',
      preset: makePreset({ layers: [toneLayer('v1', 'voice')] }),
    });
    await transport.play();
    await microflush();
    const mixer = getMixer();
    expect(mixer?.scheduleDuckSpy).not.toHaveBeenCalled(); // single-writer (D-019): transport never ducks
  });
});

describe('Phase-2 layer driving (K5/K6/K8 — §19.5)', () => {
  it('builds a LayerNode per layer, connects tone/ambiance→bedInput and voice→cueInput, drives scheduleLayers after apply', async () => {
    const layers: Layer[] = [
      toneLayer('tone1', 'tone', 0),
      toneLayer('amb1', 'ambiance', 0),
      toneLayer('cue1', 'voice', 5),
    ];
    const { transport, getMixer, layerScheduler, scheduler } = setup({
      fakeMixer: true,
      layers: true,
      backgroundAudioMode: 'none',
      preset: makePreset({ layers }),
    });
    await transport.play();
    await microflush();
    const mixer = getMixer();
    if (!mixer || !layerScheduler) throw new Error('mixer + layerScheduler composed');

    // scheduleLayers driven exactly once, right after scheduler.apply, with t0/offset.
    expect(scheduler.apply).toHaveBeenCalledTimes(1);
    expect(layerScheduler.calls).toHaveLength(1);
    const call = layerScheduler.calls[0];
    expect(call.mixer).toBe(mixer.asMixer);
    expect(call.opts.startOffsetSec).toBe(0);
    expect(call.opts.t0).toBeCloseTo(0.02); // currentTime(0) + startLeadSec

    // One node per layer, routed by kind.
    expect(call.nodes.map((n) => n.id)).toEqual(['tone1', 'amb1', 'cue1']);
    expect(call.nodes.map((n) => n.kind)).toEqual(['tone', 'ambiance', 'voice']);
    // tone + ambiance → bedInput (2 inputs besides the voice); voice → cueInput (1).
    expect(mixer.cueInput.inputs.length).toBe(1);
    // bedInput receives the voice + the two non-voice layers.
    expect(mixer.bedInput.inputs.length).toBe(3);
  });

  it('K6: a seek while playing disposes + rebuilds the layer nodes and re-schedules from the new offset', async () => {
    const layers: Layer[] = [toneLayer('amb1', 'ambiance', 0)];
    const { transport, layerScheduler } = setup({
      fakeMixer: true,
      layers: true,
      duration: 100,
      backgroundAudioMode: 'none',
      preset: makePreset({ durationSec: 100, layers }),
    });
    await transport.play();
    await microflush();
    expect(layerScheduler?.calls).toHaveLength(1);
    const firstSchedule = layerScheduler?.schedules[0];

    const seekPromise = transport.seek(60);
    await vi.advanceTimersByTimeAsync(20); // seekFadeSec
    await seekPromise;
    await microflush();

    // The prior schedule was disposed; a fresh scheduleLayers ran from startOffsetSec=60.
    expect(firstSchedule?.disposeSpy).toHaveBeenCalledTimes(1);
    expect(layerScheduler?.calls).toHaveLength(2);
    expect(layerScheduler?.calls[1].opts.startOffsetSec).toBe(60);
    // The second call got FRESH node instances (rebuild, not reuse).
    expect(layerScheduler?.schedules[1]).not.toBe(firstSchedule);
  });

  it('reapply retargets the LayerSchedule and does NOT dispose/rebuild the nodes (running-node continuity)', async () => {
    const layers: Layer[] = [toneLayer('amb1', 'ambiance', 0)];
    const presetObj = makePreset({ layers });
    const { transport, layerScheduler } = setup({
      fakeMixer: true,
      layers: true,
      backgroundAudioMode: 'none',
      preset: presetObj,
    });
    await transport.play();
    await microflush();
    const schedule = layerScheduler?.schedules[0];

    transport.reapply();

    expect(schedule?.retargetSpy).toHaveBeenCalledTimes(1);
    expect(schedule?.retargetSpy.mock.calls[0][0]).toBe(presetObj.layers); // retargeted with the edited layers
    expect(schedule?.disposeSpy).not.toHaveBeenCalled(); // NOT rebuilt
    expect(layerScheduler?.calls).toHaveLength(1); // no second scheduleLayers (no rebuild)
  });

  it('A10: rapid seeks only complete the latest rebuild', async () => {
    const layers: Layer[] = [toneLayer('amb1', 'ambiance', 0)];
    const { transport, layerScheduler } = setup({
      fakeMixer: true,
      layers: true,
      duration: 100,
      backgroundAudioMode: 'none',
      preset: makePreset({ durationSec: 100, layers }),
    });
    await transport.play();
    await microflush();
    expect(layerScheduler?.calls).toHaveLength(1);

    void transport.seek(10);
    void transport.seek(20);
    void transport.seek(30);
    await vi.advanceTimersByTimeAsync(20);
    await microflush();

    // Only the latest seek (30) reached the rebuild → exactly one new scheduleLayers.
    expect(layerScheduler?.calls).toHaveLength(2);
    expect(layerScheduler?.calls[1].opts.startOffsetSec).toBe(30);
  });

  it('K7: teardown disposes the LayerSchedule + nodes + mixer after one bus master fade, and reuses the context', async () => {
    const layers: Layer[] = [toneLayer('amb1', 'ambiance', 0)];
    const { transport, fakeCtx, getMixer, layerScheduler } = setup({
      fakeMixer: true,
      layers: true,
      duration: 100,
      backgroundAudioMode: 'none',
      preset: makePreset({ durationSec: 100, layers }),
    });
    await transport.play();
    await microflush();
    const mixer = getMixer();
    const schedule = layerScheduler?.schedules[0];

    await transport.stop(); // teardown(true)
    await vi.advanceTimersByTimeAsync(600); // flush the fade-out → deferred disposal

    expect(schedule?.disposeSpy).toHaveBeenCalledTimes(1);
    expect(mixer?.disposeSpy).toHaveBeenCalledTimes(1);
    expect(fakeCtx.closeCalls).toBe(0); // the AudioContext stays OPEN for reuse (J1)

    // J1: a fresh play composes a NEW mixer on the SAME context.
    await transport.play();
    await microflush();
    expect(getMixer()).not.toBe(mixer);
  });

  it('K5: no layerScheduler injected builds no layer nodes but still composes the mixer', async () => {
    const layers: Layer[] = [toneLayer('amb1', 'ambiance', 0)];
    // fakeMixer but NO layers:true → layerScheduler omitted (a Phase-1 host).
    const { transport, fakeCtx, getMixer } = setup({
      fakeMixer: true,
      backgroundAudioMode: 'none',
      preset: makePreset({ layers }),
    });
    await transport.play();
    await microflush();
    const mixer = getMixer();
    if (!mixer) throw new Error('mixer composed even without a layerScheduler');
    expect(mixer.bedInput.inputs.length).toBe(1); // only the voice (no layer nodes built)
    expect(mixer.master.isConnectedTo(fakeCtx.destination)).toBe(true);
  });

  it('integration: the REAL scheduleLayers owns source-starting — transport never double-starts or replays one-shots', async () => {
    // Regression guard for the removed node-start loop (behavioral audit 2026-06-16): with
    // the engine `scheduleLayers` injected verbatim (the production seam via createLayerScheduler),
    // the scheduler starts each in-range source ITSELF. Transport must NOT also start them — the
    // old loop called node.start() a second time (→ ALREADY_STARTED) and replayed out-of-range
    // one-shots on seek. The fake scheduler in the K-tests never starts sources, so it masks this.
    // We wrap each REAL LayerNode's start() to count calls per scheduler invocation, then delegate.
    const cue1 = toneLayer('cue1', 'tone', 0); // one-shot: in range at offset 0, OUT past its 0.2s ADSR
    const cue2 = toneLayer('cue2', 'tone', 70); // in range at offset 0 AND 60 (placed at t=70)
    const calls: Array<{ offset: number; started: string[] }> = [];
    const factory: LayerSchedulerFactory = (mixer, nodes, layers, opts) => {
      const started: string[] = [];
      for (const node of nodes) {
        const orig = node.start.bind(node);
        (node as { start: (at: number) => void }).start = (at: number): void => {
          started.push(node.id);
          orig(at);
        };
      }
      calls.push({ offset: opts.startOffsetSec, started });
      return scheduleLayers(mixer, nodes, layers, opts);
    };
    const { transport, notices } = setup({
      fakeMixer: true,
      layerSchedulerFactory: factory,
      duration: 100,
      backgroundAudioMode: 'none',
      preset: makePreset({ durationSec: 100, layers: [cue1, cue2] }),
    });

    await transport.play();
    await microflush();

    // Fresh start (offset 0): both tones in range, each started EXACTLY once — no double-start.
    expect(calls).toHaveLength(1);
    expect(calls[0].offset).toBe(0);
    expect(calls[0].started).toEqual(['cue1', 'cue2']);
    expect(new Set(calls[0].started).size).toBe(calls[0].started.length); // no id started twice
    expect(notices.error).toHaveLength(0); // no ALREADY_STARTED rejection surfaced

    // Seek past cue1's ADSR (offset 60): rebuild from 60. scheduleLayers gates the out-of-range
    // one-shot (cue1) and starts only the still-in-range cue2 — no erroneous replay of cue1.
    const seekPromise = transport.seek(60);
    await vi.advanceTimersByTimeAsync(20); // seekFadeSec
    await seekPromise;
    await microflush();

    expect(calls).toHaveLength(2);
    expect(calls[1].offset).toBe(60);
    expect(calls[1].started).toEqual(['cue2']); // cue1 NOT replayed; only the in-range cue2 starts
    expect(notices.error).toHaveLength(0);
  });
});
