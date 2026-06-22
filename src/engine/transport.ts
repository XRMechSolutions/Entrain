// transport — the playback clock and audio-lifecycle owner for ONE session.
//
// Turns a validated Preset into controllable sound: play / pause / seek / stop /
// position + a tick stream. Owns the AudioContext create/resume/suspend/close
// lifecycle, the click-free master fade, the D-018 background-audio bridge +
// MediaSession, the Wake Lock, and recovery from visibilitychange / iOS 'interrupted'.
//
// It imports audio-engine (createVoice / registerPulseWorklet / Voice) directly and
// the Preset type (type-only) from session-model. It orchestrates the timeline through
// an INJECTED SessionScheduler (implemented by automation; never imported here).
//
// See .dev/planning/modules/transport/{design,interfaces,edge-cases}.md.

import { voiceView, type Layer, type Preset, type Voice as PresetVoice } from './session-model';
import { createVoice as defaultCreateVoice, registerPulseWorklet, type Voice } from './audio-engine';
import { createMixer as defaultCreateMixer, type Mixer } from './mixer';
import { createLayerNode, type LayerNode } from './layer-engine';
import { getBlob } from './clip-library';
import {
  createShepardNode as defaultCreateShepard,
  registerShepardWorklet as defaultRegisterShepard,
  type ShepardHandle,
} from './shepard';
import { createMasterGainController, type MasterGainController } from './transport-master-gain';
import {
  TransportError,
  TRANSPORT_DEFAULTS,
  type BackgroundAudioMode,
  type LayerSchedule,
  type LayerSchedulerFactory,
  type LiftOptions,
  type SessionScheduler,
  type Transport,
  type TransportEventMap,
  type TransportNoticeCode,
  type TransportOptions,
  type TransportState,
} from './transport-types';

// Public module surface: consumers (ui composition root, stores) import the full
// contract from '../engine/transport' (the module entry, per interfaces.md), not the
// internal transport-types split file.
export type {
  TransportState,
  BackgroundAudioMode,
  TransportNoticeCode,
  TransportNotice,
  TickEvent,
  TransportEventMap,
  SessionScheduler,
  TransportErrorCode,
  TransportOptions,
  Transport,
  LiftOptions,
  LayerSchedule,
  LayerSchedulerFactory,
} from './transport-types';
export { TransportError, TRANSPORT_DEFAULTS } from './transport-types';

// --- Feature-detected platform shims (typed loosely; everything is optional) ---

interface WakeLockSentinelLike {
  release(): Promise<void>;
  addEventListener?(type: 'release', listener: () => void): void;
}
interface WakeLockLike {
  request(type: 'screen'): Promise<WakeLockSentinelLike>;
}
type MediaSessionActionLike = 'play' | 'pause' | 'stop' | 'seekto';
interface MediaSessionLike {
  metadata: unknown;
  playbackState: 'none' | 'paused' | 'playing';
  setActionHandler(
    action: MediaSessionActionLike,
    handler: ((details: { readonly seekTime?: number }) => void) | null,
  ): void;
  setPositionState?(state: { duration: number; position: number; playbackRate: number }): void;
}

function getWakeLock(): WakeLockLike | undefined {
  if (typeof navigator === 'undefined') return undefined;
  const wl = (navigator as unknown as { wakeLock?: WakeLockLike }).wakeLock;
  return wl && typeof wl.request === 'function' ? wl : undefined;
}
function getMediaSession(): MediaSessionLike | undefined {
  if (typeof navigator === 'undefined' || !('mediaSession' in navigator)) return undefined;
  const ms = (navigator as unknown as { mediaSession?: MediaSessionLike }).mediaSession;
  return ms && typeof ms.setActionHandler === 'function' ? ms : undefined;
}
function getRAF(): ((cb: FrameRequestCallback) => number) | undefined {
  const raf = (globalThis as { requestAnimationFrame?: (cb: FrameRequestCallback) => number })
    .requestAnimationFrame;
  return typeof raf === 'function' ? raf : undefined;
}
function getCAF(): ((handle: number) => void) | undefined {
  const caf = (globalThis as { cancelAnimationFrame?: (handle: number) => void }).cancelAnimationFrame;
  return typeof caf === 'function' ? caf : undefined;
}

function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v));
}

type RetargetableParam = AudioParam & {
  cancelAndHoldAtTime?: (cancelTime: number) => void;
};

// --- Factory ----------------------------------------------------------------

export function createTransport(options: TransportOptions): Transport {
  const scheduler: SessionScheduler = options.scheduler;
  const fadeInSec = options.fadeInSec ?? TRANSPORT_DEFAULTS.fadeInSec;
  const fadeOutSec = options.fadeOutSec ?? TRANSPORT_DEFAULTS.fadeOutSec;
  const pauseFadeSec = TRANSPORT_DEFAULTS.pauseFadeSec;
  const seekFadeSec = TRANSPORT_DEFAULTS.seekFadeSec;
  const trimRampSec = TRANSPORT_DEFAULTS.trimRampSec;
  const startLeadSec = TRANSPORT_DEFAULTS.startLeadSec;
  const backgroundAudioMode: BackgroundAudioMode =
    options.backgroundAudioMode ?? TRANSPORT_DEFAULTS.backgroundAudioMode;
  // silentFileUrl / artwork are injected by the composition root (pwa-shell's
  // SILENT_LOOP_URL / APP_ICONS, passed through createTransport). Absent → no
  // silent-file background fallback / no lock-screen art (both legitimate states).
  const silentFileUrl: string | undefined = options.silentFileUrl;
  const artwork: readonly MediaImage[] = options.artwork ?? [];
  const positionThrottleMs =
    options.mediaSessionPositionThrottleMs ?? TRANSPORT_DEFAULTS.mediaSessionPositionThrottleMs;
  const audioContextFactory = options.audioContextFactory;
  const registerWorklet = options.registerWorklet ?? registerPulseWorklet;
  const createVoiceFn = options.createVoice ?? defaultCreateVoice;
  const createMixerFn = options.createMixer ?? defaultCreateMixer;
  const layerScheduler: LayerSchedulerFactory | undefined = options.layerScheduler;
  const registerShepardFn = options.registerShepard ?? defaultRegisterShepard;
  const createShepardFn = options.createShepard ?? defaultCreateShepard;

  // --- Mutable state ---
  let state: TransportState = 'idle';
  let preset: Preset | undefined;
  let disposed = false;

  let ctx: AudioContext | undefined;
  let voice: Voice | undefined;
  let mixer: Mixer | undefined; // the per-session summation bus (D-036); nulled on teardown
  // MULTI-VOICE (v6, D-040/D-041): one record per preset.voices[] entry, keyed by source.id.
  // Each extra voice is a full createVoice graph in 'bus' mode → its own single-writer trim
  // GainNode → the SAME mixer.bedInput. Built in startFresh; the single bus master fade covers
  // every voice via bedInput. Empty when voices is absent (single-voice byte-identical).
  let extraVoices: { voice: Voice; trimGain: GainNode; source: PresetVoice }[] = [];
  let masterCtrl: MasterGainController | undefined;
  let pulseReady = false;

  // --- Phase-2 layers (D-036) — built per session, disposed + rebuilt on seek ---
  let layerNodes: LayerNode[] = []; // one LayerNode per preset.layers entry
  let layerSchedule: LayerSchedule | null = null; // the injected scheduler's handle
  // Decoded clip buffers, cached by clipId so a seek-driven rebuild reuses the decode
  // (decodeAudioData is async + costly; the buffer never changes for a given clip).
  const decodedClips = new Map<string, AudioBuffer>();
  let primePromise: Promise<void> | undefined;
  let workletPromise: Promise<void> | undefined;
  let webAudioUnsupported = false;

  let trim = 1; // session ceiling; set from preset.masterGain on load(), live via setMasterTrim
  let startOffset = 0; // seek-while-not-playing target; the next play() schedules from here
  let anchorSessionPos = 0; // session seconds at anchorCtxTime
  let anchorCtxTime = 0; // ctx.currentTime mapped to anchorSessionPos
  let frozenPos = 0; // position captured at stop (read while 'stopped')

  let seekToken = 0; // monotonic — a stale pending seek aborts (A10)
  let needsReschedule = false; // a seek happened while paused/interrupted

  let keepScreenOn = false; // intended Wake Lock toggle (default off)
  let wakeSentinel: WakeLockSentinelLike | undefined;

  let msDest: MediaStreamAudioDestinationNode | undefined;
  let audioEl: HTMLAudioElement | undefined;

  // The node the voice (and the parallel lift) feed: the mediastream dest when bridged,
  // else ctx.destination. Tracked so the lift can join the SAME audible path (D-018).
  let outputTarget: AudioNode | undefined;

  // --- Shepard "lift" overlay (an independent PARALLEL aux path; design — live layer) ---
  let liftIntent: LiftOptions | null = null; // desired lift, (re)applied on play()
  let liftHandle: ShepardHandle | undefined; // the live shepard node + params
  let liftGain: GainNode | undefined; // aux fade-envelope gain (0→1 enable / 1→0 disable)
  let liftEnvTracked = 0; // JS-tracked aux envelope value (ramp anchor)
  let liftSpeedTracked = 0; // JS-tracked shepard speed (ramp anchor)
  let liftGainTracked = 0; // JS-tracked shepard gain (ramp anchor)
  let shepardPromise: Promise<void> | undefined; // single in-flight shepard registration
  let shepardReady = false;

  let endTimer: ReturnType<typeof setTimeout> | undefined;
  let rafHandle: number | undefined;
  let controlledSuspend = false; // suppress the statechange→interrupted handler during our own suspend
  let lastPositionStateMs = 0; // MediaSession setPositionState throttle clock

  let stateChangeHandler: (() => void) | undefined;
  let visibilityHandler: (() => void) | undefined;

  // --- Typed event emitter ---
  const listeners: Record<keyof TransportEventMap, Set<(p: never) => void>> = {
    tick: new Set(),
    statechange: new Set(),
    ended: new Set(),
    error: new Set(),
    warning: new Set(),
  };
  function emit<K extends keyof TransportEventMap>(event: K, payload: TransportEventMap[K]): void {
    for (const h of [...listeners[event]]) (h as (p: TransportEventMap[K]) => void)(payload);
  }
  function emitNotice(kind: 'error' | 'warning', code: TransportNoticeCode, message: string): void {
    emit(kind, { code, message });
  }
  function on<K extends keyof TransportEventMap>(
    event: K,
    handler: (payload: TransportEventMap[K]) => void,
  ): void {
    assertNotDisposed();
    listeners[event].add(handler as (p: never) => void);
  }
  function off<K extends keyof TransportEventMap>(
    event: K,
    handler: (payload: TransportEventMap[K]) => void,
  ): void {
    assertNotDisposed();
    listeners[event].delete(handler as (p: never) => void);
  }

  // --- Guards / state machine ---
  function assertNotDisposed(): void {
    if (disposed) throw new TransportError('DISPOSED', 'transport has been destroyed');
  }
  function transitionTo(next: TransportState): void {
    if (state === next) return;
    state = next;
    emit('statechange', { state: next });
  }

  // --- Position / clock ---
  function durationSec(): number {
    return preset ? preset.durationSec : 0;
  }
  function clampPos(p: number): number {
    return Math.min(durationSec(), Math.max(0, p));
  }
  function livePosition(): number {
    const now = ctx ? ctx.currentTime : anchorCtxTime;
    return clampPos(anchorSessionPos + (now - anchorCtxTime));
  }
  function computePosition(): number {
    if (state === 'stopped') return clampPos(frozenPos);
    if (state === 'idle') return clampPos(startOffset);
    return livePosition(); // playing / paused / interrupted (clock frozen while suspended)
  }

  // --- AudioContext creation + listeners ---
  function createContext(): AudioContext | undefined {
    if (audioContextFactory) return audioContextFactory();
    const g = globalThis as { AudioContext?: new () => AudioContext; webkitAudioContext?: new () => AudioContext };
    const Ctor = g.AudioContext ?? g.webkitAudioContext;
    if (!Ctor) return undefined;
    return new Ctor();
  }
  function attachContextListeners(c: AudioContext): void {
    stateChangeHandler = () => {
      onStateChange();
    };
    if (typeof c.addEventListener === 'function') {
      c.addEventListener('statechange', stateChangeHandler);
    }
    visibilityHandler = () => {
      void onVisibilityChange();
    };
    if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
      document.addEventListener('visibilitychange', visibilityHandler);
    }
  }
  function detachContextListeners(): void {
    if (ctx && stateChangeHandler && typeof ctx.removeEventListener === 'function') {
      ctx.removeEventListener('statechange', stateChangeHandler);
    }
    if (visibilityHandler && typeof document !== 'undefined' && typeof document.removeEventListener === 'function') {
      document.removeEventListener('visibilitychange', visibilityHandler);
    }
    stateChangeHandler = undefined;
    visibilityHandler = undefined;
  }

  // --- F. visibility / iOS interruption (design §14) ---
  function onStateChange(): void {
    if (!ctx || controlledSuspend) return;
    // An unexpected drop out of 'running' while we believe we are playing = an OS
    // interruption (iOS 'interrupted' or an unexpected 'suspended'). Clock is already
    // frozen, so position() holds (F2).
    if (state === 'playing' && ctx.state !== 'running') {
      stopTick();
      clearEndTimer();
      transitionTo('interrupted');
      emitNotice('warning', 'CONTEXT_INTERRUPTED', 'the audio context was interrupted; playback is paused');
    }
  }
  async function onVisibilityChange(): Promise<void> {
    if (disposed || typeof document === 'undefined') return;
    if (document.visibilityState !== 'visible') return;
    // Recover only when we INTEND to be playing — never after a deliberate pause (F6).
    if ((state === 'playing' || state === 'interrupted') && ctx && ctx.state !== 'running') {
      await recoverContext();
    }
    // The browser auto-releases the screen Wake Lock when hidden; re-acquire (G3).
    if (keepScreenOn && state === 'playing') {
      await reacquireWakeLock();
    }
  }
  async function recoverContext(): Promise<void> {
    if (!ctx) return;
    controlledSuspend = true;
    try {
      // iOS resume() alone can get stuck (WebKit 276016); suspend→resume unsticks it.
      if (typeof ctx.suspend === 'function') await ctx.suspend().catch(() => {});
      if (typeof ctx.resume === 'function') await ctx.resume();
    } catch {
      /* best-effort */
    } finally {
      controlledSuspend = false;
    }
    if (ctx.state === 'running') {
      // currentTime resumes from the frozen value, so the existing anchor is still
      // valid; just re-arm the end timer with the recomputed remaining (F4).
      armEndTimer();
      startTick();
      setMediaPlaybackState('playing');
      transitionTo('playing');
      emitNotice('warning', 'CONTEXT_RECOVERED', 'the audio context recovered');
    } else if (state !== 'interrupted') {
      // Stay interrupted; leave the CONTEXT_INTERRUPTED banner up for a tap-to-resume (F5).
      transitionTo('interrupted');
    }
  }

  // --- G. Wake Lock (design §15) ---
  async function acquireWakeLock(): Promise<void> {
    const wl = getWakeLock();
    if (!wl) {
      keepScreenOn = false;
      emitNotice('warning', 'WAKE_LOCK_UNSUPPORTED', 'screen Wake Lock is not available');
      return;
    }
    try {
      wakeSentinel = await wl.request('screen');
      keepScreenOn = true;
      if (wakeSentinel && typeof wakeSentinel.addEventListener === 'function') {
        wakeSentinel.addEventListener('release', () => {
          // Auto-released (e.g. on hide); the intended toggle stays on for re-acquire.
        });
      }
    } catch {
      keepScreenOn = false;
      wakeSentinel = undefined;
      emitNotice('warning', 'WAKE_LOCK_FAILED', 'the screen Wake Lock request was rejected');
    }
  }
  async function reacquireWakeLock(): Promise<void> {
    const wl = getWakeLock();
    if (!wl) return;
    try {
      wakeSentinel = await wl.request('screen');
    } catch {
      /* best-effort; the toggle remains intended-on */
    }
  }
  async function releaseWakeLock(): Promise<void> {
    const s = wakeSentinel;
    wakeSentinel = undefined;
    if (s && typeof s.release === 'function') {
      try {
        await s.release();
      } catch {
        /* ignore */
      }
    }
  }

  // --- 8. Output routing & background bridge (design §8) ---
  function getAudioElement(): HTMLAudioElement | undefined {
    if (audioEl) return audioEl;
    if (typeof document === 'undefined' || typeof document.createElement !== 'function') return undefined;
    const el = document.createElement('audio');
    el.loop = false;
    el.setAttribute('aria-hidden', 'true');
    audioEl = el;
    return el;
  }
  function routeOutput(m: Mixer): void {
    if (!ctx) return;
    // Phase-2: the audible edge is mixer.master's SINGLE output edge (its only upstream
    // is busSum, so moving it moves exactly one edge — arch §1). The voice's own
    // destination edge was already dropped in startFresh; the voice now feeds
    // mixer.bedInput, so there is exactly one audible path. The lift rides the same SUM
    // via mixer.liftInput. Default: connect master direct to ctx.destination.
    m.connect(ctx.destination);
    outputTarget = ctx.destination;
    if (backgroundAudioMode === 'none') return; // direct only, no <audio>, no MediaSession (D6)

    if (backgroundAudioMode === 'mediastream') {
      // J6: an OfflineAudioContext lacks createMediaStreamDestination → degrade to direct.
      if (typeof ctx.createMediaStreamDestination !== 'function') return;
      const dest = ctx.createMediaStreamDestination();
      msDest = dest;
      outputTarget = dest;
      // Exactly one audible path: move mixer.master's single output edge from the
      // destination to the stream dest (connect() drops the prior edge internally).
      m.connect(dest);
      const el = getAudioElement();
      if (el) {
        (el as unknown as { srcObject: MediaStream | null }).srcObject = dest.stream;
      }
      return;
    }

    // silent-file: keep the direct destination; a near-silent looping <audio> holds focus.
    if (silentFileUrl) {
      const el = getAudioElement();
      if (el) {
        el.src = silentFileUrl;
        el.loop = true;
      }
    }
  }
  async function playBridgeElement(): Promise<void> {
    if (backgroundAudioMode === 'none') return;
    const el = audioEl;
    if (!el || typeof el.play !== 'function') return;
    try {
      await el.play();
      // Resolved: the <audio> element is the audible path (mediastream) or focus
      // holder (silent-file) and holds platform audio focus (D1).
    } catch {
      // Rejected (iOS often): fall back to the direct destination, no doubling (D2).
      // Move ONLY mixer.master back to ctx.destination (its single output edge). The
      // lift rides the bus via mixer.liftInput → busSum → master, so it follows master
      // automatically and must NOT be rewired separately (arch §19.3).
      if (backgroundAudioMode === 'mediastream' && mixer && ctx && msDest) {
        mixer.connect(ctx.destination);
        outputTarget = ctx.destination;
        try {
          el.pause();
        } catch {
          /* ignore */
        }
        (el as unknown as { srcObject: MediaStream | null }).srcObject = null;
      }
      emitNotice(
        'warning',
        'BACKGROUND_AUDIO_UNAVAILABLE',
        'background audio bridge unavailable; using direct output',
      );
    }
  }

  // --- Shepard "lift" overlay — a PARALLEL aux path (independent live layer) ---
  // The lift never touches the voice/bridge wiring: a dedicated aux GainNode (the
  // click-free fade envelope) fed by the shepard node joins the bus at mixer.liftInput
  // (Phase-2; a POST-DUCK overlay — arch §19.4). The shepard node's own `gain` param
  // carries the user level; the aux gain only fades the whole layer in/out (enable/disable).
  function liftTarget(): AudioNode | undefined {
    // Phase-2: the lift is a POST-DUCK overlay summed into the bus at mixer.liftInput
    // (downstream of duckGain, so the bed duck never pumps it; master fade/trim/teardown
    // still cover it — arch §1/§4/§19.4). Fall back to the destination only when there is
    // no live mixer (defensive; a session always composes the mixer before applyLift).
    if (mixer) return mixer.liftInput;
    return outputTarget ?? (ctx ? ctx.destination : undefined);
  }
  /** No-click param write: anchor from the JS-tracked value, 10 ms linear ramp to target
   *  (mirrors the audio-engine setters). */
  function rampLiftParam(param: AudioParam, from: number, to: number, sec: number): void {
    if (!ctx) return;
    const now = ctx.currentTime;
    const p = param as RetargetableParam;
    if (typeof p.cancelAndHoldAtTime === 'function') {
      p.cancelAndHoldAtTime(now);
    } else {
      param.cancelScheduledValues(now);
    }
    if (sec > 0) {
      param.setValueAtTime(from, now);
      param.linearRampToValueAtTime(to, now + sec);
    } else {
      param.setValueAtTime(to, now);
    }
  }
  function ensureShepardRegistered(c: AudioContext): Promise<void> {
    if (shepardPromise) return shepardPromise;
    shepardPromise = registerShepardFn(c).then(
      () => {
        shepardReady = true;
      },
      () => {
        shepardReady = false;
        emitNotice('warning', 'WORKLET_UNAVAILABLE', 'lift worklet failed to load; the lift overlay is unavailable');
      },
    );
    return shepardPromise;
  }
  /** Enable/update the lift to match liftIntent, or dispose it when the intent is null.
   *  Register-before-create; a no-op when there is no active context. */
  async function applyLift(): Promise<void> {
    const c = ctx;
    if (!c) return;
    const intent = liftIntent;
    if (!intent) {
      // Mid-session disable (setLift(null)): self-fade the aux gain to 0 then dispose —
      // the bus master is NOT fading here (the session keeps playing), so the lift must
      // fade itself (arch §19.4 "keep the aux fade for mid-session enable/disable").
      disposeLift(trimRampSec, true);
      return;
    }
    if (!shepardReady) {
      await ensureShepardRegistered(c);
      // The session may have ended (or the lift been disabled) while registration ran.
      if (ctx !== c || !liftIntent || !voice) return;
      if (!shepardReady) return; // load failed (already warned) — leave the lift off
    }
    if (!liftHandle) {
      // First enable: build the node, route through a silent aux gain, fade in click-free.
      const handle = createShepardFn(c, { speed: intent.speed, gain: intent.gain });
      const g = c.createGain();
      g.gain.value = 0;
      handle.output.connect(g);
      const target = liftTarget();
      if (target) g.connect(target);
      liftHandle = handle;
      liftGain = g;
      liftSpeedTracked = intent.speed;
      liftGainTracked = clamp01(intent.gain);
      handle.gainParam.value = liftGainTracked;
      liftEnvTracked = 0;
      rampLiftParam(g.gain, 0, 1, trimRampSec); // 10 ms fade-in
      liftEnvTracked = 1;
    } else {
      // Update live: re-ramp speed + gain on the running node (phase stays continuous).
      rampLiftParam(liftHandle.speedParam, liftSpeedTracked, intent.speed, trimRampSec);
      liftSpeedTracked = intent.speed;
      const g = clamp01(intent.gain);
      rampLiftParam(liftHandle.gainParam, liftGainTracked, g, trimRampSec);
      liftGainTracked = g;
    }
  }
  /** Disconnect + dispose the lift nodes. When `selfFade` is true (mid-session
   *  enable/disable, e.g. setLift(null)) the aux gain self-fades to 0 over `fadeSec`
   *  before disposal. On TEARDOWN the lift rides the bus (mixer.liftInput → busSum →
   *  master), so the single bus master fade-out already covers it — the lift no longer
   *  self-fades at teardown (arch §19.4); the caller passes `selfFade=false` and disposal
   *  is deferred by `fadeSec` only to keep the tail alive until the bus fade completes. */
  function disposeLift(fadeSec: number, selfFade: boolean): void {
    const handle = liftHandle;
    const g = liftGain;
    if (!handle && !g) return;
    const sec = ctx ? fadeSec : 0;
    if (selfFade && g) {
      rampLiftParam(g.gain, liftEnvTracked, 0, sec);
      liftEnvTracked = 0;
    }
    const finish = (): void => {
      if (handle) {
        try {
          handle.disconnect();
        } catch {
          /* idempotent */
        }
      }
      if (g) {
        try {
          g.disconnect();
        } catch {
          /* idempotent */
        }
      }
    };
    if (sec > 0) {
      setTimeout(finish, sec * 1000);
    } else {
      finish();
    }
    liftHandle = undefined;
    liftGain = undefined;
  }

  // --- Phase-2 layers (design §19.5) — build, schedule, dispose, rebuild on seek ---

  /** A clip layer carries `{ clipId }`; a tone layer carries `{ synth }`. */
  function clipIdOf(layer: Layer): string | undefined {
    const src = layer.source as { clipId?: string };
    return typeof src.clipId === 'string' ? src.clipId : undefined;
  }

  /** Resolve the decoded AudioBuffer for a clip layer: cached → reuse (a seek rebuild
   *  must not re-decode); else getBlob → ctx.decodeAudioData, cached by clipId. Returns
   *  undefined for a missing/un-decodable clip (layer-engine then builds a silent node).
   *  Tone layers need no buffer. */
  async function decodeClipBuffer(c: AudioContext, clipId: string): Promise<AudioBuffer | undefined> {
    const cached = decodedClips.get(clipId);
    if (cached) return cached;
    if (typeof c.decodeAudioData !== 'function') return undefined;
    try {
      const blob = await getBlob(clipId);
      if (!blob) return undefined;
      const bytes = await blob.arrayBuffer();
      const buf = await c.decodeAudioData(bytes);
      decodedClips.set(clipId, buf);
      return buf;
    } catch {
      return undefined; // missing/undecodable → silent node (D-023), never fatal
    }
  }

  /** Build a LayerNode per `preset.layers`, connecting each output to mixer.bedInput
   *  (tone/ambiance) or mixer.cueInput (voice-kind cue, post-duck so a cue never ducks
   *  itself — arch §4), then drive the injected scheduleLayers(mixer, nodes, layers,
   *  {t0, startOffsetSec}) alongside scheduler.apply. A no-op when no layerScheduler is
   *  injected or the preset has no layers (K5): the mixer is still composed, only the
   *  layer build/schedule is skipped. Async because clip layers decode their buffer. */
  async function scheduleLayersFor(
    c: AudioContext,
    m: Mixer,
    p: Preset,
    t0: number,
    startOffsetSec: number,
  ): Promise<void> {
    const layers = p.layers;
    if (!layerScheduler || !layers || layers.length === 0) return; // K5: no layers

    const nodes: LayerNode[] = [];
    for (const layer of layers) {
      const clipId = clipIdOf(layer);
      const buffer = clipId ? await decodeClipBuffer(c, clipId) : undefined;
      // The session may have ended (teardown nulls the mixer) while a decode awaited.
      if (mixer !== m) {
        for (const n of nodes) n.dispose();
        return;
      }
      const node = createLayerNode(c, layer, buffer);
      node.output.connect(layer.kind === 'voice' ? m.cueInput : m.bedInput);
      nodes.push(node);
    }
    layerNodes = nodes;
    // The injected scheduler owns source-starting: scheduleLayers starts each in-range
    // source itself (startSources: true) and gates one-shots via inRange. Transport must
    // NOT also start them — a second node.start() throws ALREADY_STARTED and replays
    // out-of-range one-shots on seek (matches the renderer, which starts only the voice).
    layerSchedule = layerScheduler(m, nodes, layers, { t0, startOffsetSec });
  }

  /** Dispose the current layer schedule + every layer node and clear the per-session
   *  layer refs (the decode cache survives — buffers are reused across seeks/rebuilds). */
  function disposeLayers(): void {
    if (layerSchedule) {
      try {
        layerSchedule.dispose();
      } catch {
        /* idempotent */
      }
      layerSchedule = null;
    }
    for (const node of layerNodes) {
      try {
        node.dispose();
      } catch {
        /* idempotent */
      }
    }
    layerNodes = [];
  }

  // --- 12. MediaSession (design §12) ---
  function attachMediaSession(p: Preset): void {
    if (backgroundAudioMode === 'none') return; // no audible element to attach to (D6)
    const ms = getMediaSession();
    if (!ms) return; // E1: skip entirely, playback unaffected
    try {
      const MM = (globalThis as { MediaMetadata?: new (init: MediaMetadataInit) => MediaMetadata }).MediaMetadata;
      if (MM) {
        ms.metadata = new MM({ title: p.name, artist: 'BinauralAudio', artwork: [...artwork] });
      }
    } catch {
      /* ignore */
    }
    setActionHandlerSafe(ms, 'play', () => {
      void play();
    });
    setActionHandlerSafe(ms, 'pause', () => {
      void pause();
    });
    setActionHandlerSafe(ms, 'stop', () => {
      void stop();
    });
    setActionHandlerSafe(ms, 'seekto', (details) => {
      if (details && typeof details.seekTime === 'number') void seek(details.seekTime);
    });
  }
  function setActionHandlerSafe(
    ms: MediaSessionLike,
    action: MediaSessionActionLike,
    handler: (details: { readonly seekTime?: number }) => void,
  ): void {
    try {
      ms.setActionHandler(action, handler);
    } catch {
      // E2: an unknown action (e.g. 'seekto' on an old browser) is skipped, not fatal.
    }
  }
  function setMediaPlaybackState(s: 'none' | 'paused' | 'playing'): void {
    const ms = getMediaSession();
    if (!ms) return;
    try {
      ms.playbackState = s;
    } catch {
      /* ignore */
    }
  }
  function clearMediaSession(): void {
    const ms = getMediaSession();
    if (!ms) return;
    for (const a of ['play', 'pause', 'stop', 'seekto'] as const) {
      try {
        ms.setActionHandler(a, null);
      } catch {
        /* ignore */
      }
    }
    try {
      ms.metadata = null;
    } catch {
      /* ignore */
    }
    try {
      ms.playbackState = 'none';
    } catch {
      /* ignore */
    }
  }
  function updateMediaPosition(): void {
    const ms = getMediaSession();
    if (!ms || typeof ms.setPositionState !== 'function') return;
    const now = Date.now();
    if (now - lastPositionStateMs < positionThrottleMs) return; // E4: throttle
    lastPositionStateMs = now;
    try {
      ms.setPositionState({ duration: durationSec(), position: computePosition(), playbackRate: 1 });
    } catch {
      /* best-effort */
    }
  }

  // --- 13. Tick loop + end-of-session (design §13) ---
  function emitTick(): void {
    if (!preset) return;
    emit('tick', { positionSec: computePosition(), durationSec: preset.durationSec, state });
  }
  function startTick(): void {
    stopTick();
    const raf = getRAF();
    if (!raf) return; // J6: no rAF (offline) → the end timer is authoritative
    const loop = (): void => {
      if (state !== 'playing') return;
      emitTick();
      updateMediaPosition();
      if (preset && computePosition() >= preset.durationSec) {
        endSession(); // foreground end backup
        return;
      }
      rafHandle = raf(loop);
    };
    rafHandle = raf(loop);
  }
  function stopTick(): void {
    if (rafHandle !== undefined) {
      const caf = getCAF();
      if (caf) caf(rafHandle);
      rafHandle = undefined;
    }
  }
  function armEndTimer(): void {
    clearEndTimer();
    if (!preset) return;
    // durationSec ≤ 86400 (session-model LIMITS) → remainingMs < 2^31, safe for setTimeout (H5).
    const remainingMs = Math.max(0, (preset.durationSec - livePosition()) * 1000);
    endTimer = setTimeout(() => {
      endSession();
    }, remainingMs);
  }
  function clearEndTimer(): void {
    if (endTimer !== undefined) {
      clearTimeout(endTimer);
      endTimer = undefined;
    }
  }

  // --- Shared teardown (design §13) ---
  function teardownRouting(): void {
    if (msDest) {
      try {
        msDest.disconnect();
      } catch {
        /* ignore */
      }
      msDest = undefined;
    }
    const el = audioEl;
    if (el) {
      try {
        el.pause();
      } catch {
        /* ignore */
      }
      try {
        (el as unknown as { srcObject: MediaStream | null }).srcObject = null;
      } catch {
        /* ignore */
      }
      try {
        el.removeAttribute('src');
      } catch {
        /* ignore */
      }
    }
  }
  function teardown(fade: boolean): void {
    const c = ctx;
    const now = c ? c.currentTime : 0;
    // Capture the frozen position BEFORE the anchor goes stale.
    frozenPos = computePosition();
    stopTick();
    clearEndTimer();

    const v = voice;
    const m = mixer;
    const mc = masterCtrl;
    const ls = layerSchedule;
    const nodes = layerNodes;
    const evs = extraVoices; // capture the per-session voice set (a new startFresh must not retarget this deferred finish)
    const fadeSec = fade ? fadeOutSec : 0;
    // The bus master fade-out now fades the whole SUM (voice + every layer + the
    // post-duck lift) to silence in ONE ramp before disposal — one master, one fade
    // (arch §1/§19.6). The lift no longer self-fades here (selfFade=false); the bus
    // master covers it.
    if (mc) mc.rampMaster(0, fadeSec);
    disposeLift(fadeSec, false); // dispose the lift; the bus master fade covers its tail
    if (v) {
      scheduler.cancel(v); // cancel queued base ramps + dispose modulators (oscillators keep running)
      try {
        v.stop(now + fadeSec); // schedule the source stop at the fade end
      } catch {
        /* already stopped */
      }
    }
    // Phase-2 multi-voice: each extra voice fades to silence through the SAME bus master
    // ramp (trimGain → bedInput), so no per-voice fade is needed — cancel queued base ramps
    // and schedule the source stop at the fade end, once per voice (arch §3 teardown row).
    for (const rec of evs) {
      scheduler.cancel(rec.voice);
      try {
        rec.voice.stop(now + fadeSec);
      } catch {
        /* already stopped */
      }
    }
    // Defer node disposal until after the fade so the tail is not cut early.
    const finish = (): void => {
      if (v) {
        try {
          v.dispose();
        } catch {
          /* idempotent */
        }
      }
      // Dispose every extra voice + drop its trim edge into the bus, post-fade (at silence).
      for (const rec of evs) {
        try {
          rec.voice.dispose();
        } catch {
          /* idempotent */
        }
        try {
          rec.trimGain.disconnect();
        } catch {
          /* idempotent */
        }
      }
      // Phase-2: dispose the layer schedule + nodes, then the mixer, AFTER the fade
      // (disposal happens at silence — K7/§19.6). The AudioContext stays open for reuse.
      if (ls) {
        try {
          ls.dispose();
        } catch {
          /* idempotent */
        }
      }
      for (const node of nodes) {
        try {
          node.dispose();
        } catch {
          /* idempotent */
        }
      }
      if (m) {
        try {
          m.dispose();
        } catch {
          /* idempotent */
        }
      }
      teardownRouting();
      clearMediaSession();
      void releaseWakeLock();
    };
    if (fadeSec > 0) {
      setTimeout(finish, fadeSec * 1000);
    } else {
      finish();
    }

    voice = undefined;
    mixer = undefined; // null the per-session bus (a second teardown finds it absent)
    masterCtrl = undefined;
    layerSchedule = null;
    layerNodes = [];
    extraVoices = []; // drop the per-session voice set (a second teardown finds it empty)
    transitionTo('stopped');
  }
  function endSession(): void {
    if (state !== 'playing') return; // guard double/late fire (H4)
    teardown(true);
    emit('ended', undefined as never);
  }

  // --- 5. prime() (design §5) ---
  async function prime(): Promise<void> {
    assertNotDisposed();
    if (primePromise) return primePromise;
    primePromise = doPrime();
    return primePromise;
  }
  async function doPrime(): Promise<void> {
    if (!ctx) {
      const created = createContext();
      if (!created) {
        webAudioUnsupported = true;
        emitNotice('error', 'WEB_AUDIO_UNSUPPORTED', 'this browser has no AudioContext; audio cannot start');
        return; // stay idle (B3)
      }
      ctx = created;
      attachContextListeners(ctx);
    }
    // Kick off pulse-worklet registration but do NOT await it here. prime() must
    // resolve once the context exists (registration in flight) so the play() gesture
    // that awaits prime() is never blocked on addModule — awaiting it would break the
    // synchronous gesture chain and reject autoplay on Safari (design §5/§6 step 1,
    // edge B2/B5). pulseReady flips when registration settles; a session that starts
    // before then runs with pulseAvailable=false (documented trade).
    void startWorkletRegistration(ctx);
  }
  function startWorkletRegistration(c: AudioContext): Promise<void> {
    if (workletPromise) return workletPromise;
    workletPromise = registerWorklet(c).then(
      () => {
        pulseReady = true;
      },
      () => {
        // Worklet load failed: the binaural core + sine/triangle warble still work (B2).
        pulseReady = false;
        emitNotice('warning', 'WORKLET_UNAVAILABLE', 'pulse worklet failed to load; isochronic pulse is unavailable');
      },
    );
    return workletPromise;
  }

  // --- 6. play() start sequence (design §6) ---
  async function startFresh(): Promise<void> {
    await prime();
    const c = ctx;
    if (!c) {
      if (!webAudioUnsupported) {
        emitNotice('error', 'WEB_AUDIO_UNSUPPORTED', 'this browser has no AudioContext; audio cannot start');
      }
      return; // cannot proceed (B3)
    }
    const p = preset;
    if (!p) return; // guarded by play()

    // Fire resume() in the gesture but do NOT block on it — scheduling on a still-
    // suspended context is correct (audio-engine C1 / edge H7).
    if (typeof c.resume === 'function') c.resume().catch(() => {});

    // Phase-2: compose the unified bus in a fixed order so mixer.master always has
    // exactly one upstream edge (arch §1/§19.2). The voice is created in 'bus' mode so
    // its internal masterGain is a unity passthrough (no double-attenuation — K1); the
    // mixer owns the only master. (1) voice → (2) mixer → (3) drop the voice's default
    // destination edge → (4) voice.output → mixer.bedInput → (5) bind the controller to
    // mixer.masterParam (starts at 0, click-free 0→trim fade) → (6) routeOutput(mixer).
    const v = createVoiceFn(c, { master: 'bus' });
    voice = v;
    // MULTI-VOICE (v6): equal-power headroom on bedInput for N = primary + extra voices, so
    // summing N near-full-scale voices does not overdrive busSum → master (§2/D-041). N=1
    // ⇒ bedHeadroom 1 ⇒ single-voice byte-identical.
    const N = 1 + (p.voices?.length ?? 0);
    const m = createMixerFn(c, { bedHeadroom: 1 / Math.sqrt(N) });
    mixer = m;
    extraVoices = []; // fresh per-session set (teardown disposal lands in a later task)
    try {
      v.output.disconnect(c.destination); // drop the voice's default destination edge
    } catch {
      /* the edge may already be absent (mirrors the mediastream rewire) */
    }
    v.output.connect(m.bedInput); // the voice joins the BED sub-bus (ducked path)
    masterCtrl = createMasterGainController(m.masterParam, () => c.currentTime);
    routeOutput(m);

    const t0 = c.currentTime + startLeadSec;
    anchorCtxTime = t0;
    anchorSessionPos = startOffset;

    try {
      scheduler.apply(v, p, startOffset, t0, { pulseAvailable: pulseReady });
      // MULTI-VOICE (v6, §3): each extra voice is an independent createVoice graph in 'bus'
      // mode → single-writer trim GainNode → the SAME mixer.bedInput, scheduled by its OWN
      // scheduler.apply over a shared voiceView. ALL-OR-NOTHING: nested in this same try so a
      // per-voice apply throw runs the EXISTING SCHEDULE_FAILED path below (I1 — no
      // half-started session); the catch disposes every extra voice created so far.
      for (const source of p.voices ?? []) {
        const ev = createVoiceFn(c, { master: 'bus' });
        try {
          ev.output.disconnect(c.destination); // drop the default destination edge
        } catch {
          /* the edge may already be absent (mirrors the primary/mediastream rewire) */
        }
        const trimGain = c.createGain(); // single-writer (transport): the per-voice mix trim
        trimGain.gain.value = clamp01(source.gain ?? 1);
        ev.output.connect(trimGain);
        trimGain.connect(m.bedInput);
        extraVoices.push({ voice: ev, trimGain, source });
        scheduler.apply(ev, voiceView(p, source.nodes), startOffset, t0, { pulseAvailable: pulseReady });
        ev.start(t0); // the source start, IN the gesture (autoplay requirement, B5)
      }
    } catch {
      // I1: a scheduler failure aborts the start — no half-played session. All-or-nothing:
      // dispose every extra voice built so far (teardown(false) covers only the primary until
      // the teardown multi-voice task lands), then route through the primary SCHEDULE_FAILED path.
      for (const rec of extraVoices) {
        try {
          rec.voice.dispose();
        } catch {
          /* best-effort */
        }
        try {
          rec.trimGain.disconnect();
        } catch {
          /* best-effort */
        }
      }
      extraVoices = [];
      teardown(false);
      emitNotice('error', 'SCHEDULE_FAILED', 'the session scheduler failed; playback aborted');
      return;
    }

    v.start(t0); // the source start, IN the gesture (autoplay requirement, B5)
    // Layers ride ALONGSIDE the binaural scheduler (additive; the apply call is
    // unchanged). The layer scheduler computes voice-kind duck spans and calls
    // mixer.scheduleDuck itself — transport never writes duckParam (D-019, K8).
    void scheduleLayersFor(c, m, p, t0, startOffset);
    masterCtrl.rampMaster(trim, fadeInSec); // master fade-in 0 → trim (the whole bus SUM)
    void playBridgeElement(); // audio.play() for the bridge (does not block the gesture)
    attachMediaSession(p);
    setMediaPlaybackState('playing');
    needsReschedule = false;

    armEndTimer();
    transitionTo('playing');
    startTick();
    if (keepScreenOn) void reacquireWakeLock();
    if (liftIntent) void applyLift(); // (re)attach the parallel lift overlay if requested
  }
  async function resume(): Promise<void> {
    const c = ctx;
    const v = voice;
    const mc = masterCtrl;
    const p = preset;
    if (!c || !v || !mc || !p) return;
    controlledSuspend = true;
    try {
      if (c.state !== 'running') {
        if (typeof c.suspend === 'function') await c.suspend().catch(() => {});
        if (typeof c.resume === 'function') await c.resume().catch(() => {});
      }
    } finally {
      controlledSuspend = false;
    }
    if (needsReschedule) {
      // A seek happened while paused/interrupted: rebuild the schedule from the new
      // offset against the now-running clock (design §7/§8.3).
      scheduler.cancel(v);
      anchorSessionPos = startOffset;
      anchorCtxTime = c.currentTime + startLeadSec;
      scheduler.apply(v, p, startOffset, anchorCtxTime, { pulseAvailable: pulseReady });
      // MULTI-VOICE (v6, §3): reschedule each extra voice from the same new offset against
      // the same anchor (oscillators keep running). Mirrors the seekWhilePlaying batch.
      for (const rec of extraVoices) {
        scheduler.cancel(rec.voice);
        scheduler.apply(rec.voice, voiceView(p, rec.source.nodes), startOffset, anchorCtxTime, {
          pulseAvailable: pulseReady,
        });
      }
      needsReschedule = false;
    }
    mc.rampMaster(trim, pauseFadeSec); // fade back up
    setMediaPlaybackState('playing');
    armEndTimer();
    transitionTo('playing');
    startTick();
    if (keepScreenOn) void reacquireWakeLock();
  }
  async function play(): Promise<void> {
    assertNotDisposed();
    if (!preset) throw new TransportError('NO_PRESET', 'play() called before load(preset)');
    if (state === 'playing') return; // A4 no-op
    if (state === 'paused' || state === 'interrupted') {
      await resume();
      return;
    }
    await startFresh(); // idle / stopped → fresh voice on the reused context
  }

  // --- 7. pause() (design §7) ---
  async function pause(): Promise<void> {
    assertNotDisposed();
    if (state !== 'playing') return; // A5 no-op
    const c = ctx;
    const mc = masterCtrl;
    if (!c || !mc) return;
    mc.rampMaster(0, pauseFadeSec); // fade to silence first (no-click, C3)
    stopTick();
    clearEndTimer();
    await delay(pauseFadeSec);
    if (state !== 'playing') return; // superseded (e.g. stop() during the fade)
    controlledSuspend = true;
    try {
      if (typeof c.suspend === 'function') await c.suspend().catch(() => {});
    } finally {
      controlledSuspend = false;
    }
    if (state !== 'playing') return;
    setMediaPlaybackState('paused');
    transitionTo('paused');
  }

  // --- 8.3 seek() (design §8.3) ---
  async function seek(t: number): Promise<void> {
    assertNotDisposed();
    if (!preset) throw new TransportError('NO_PRESET', 'seek() called before load(preset)');
    if (typeof t !== 'number' || !Number.isFinite(t)) {
      throw new TransportError('INVALID_SEEK', 'seek(t) requires a finite t');
    }
    const clamped = clampPos(t);
    const token = ++seekToken;
    if (state === 'playing') {
      await seekWhilePlaying(clamped, token);
      return;
    }
    if (state === 'paused' || state === 'interrupted') {
      // Defer the cancel+reschedule to the next resume (avoid scheduling on a frozen clock).
      startOffset = clamped;
      anchorSessionPos = clamped;
      anchorCtxTime = ctx ? ctx.currentTime : anchorCtxTime;
      needsReschedule = true;
      return;
    }
    // idle / stopped: the next play() schedules from here.
    startOffset = clamped;
    frozenPos = clamped;
  }
  async function seekWhilePlaying(t: number, token: number): Promise<void> {
    const c = ctx;
    const v = voice;
    const mc = masterCtrl;
    const p = preset;
    if (!c || !v || !mc || !p) return;
    mc.rampMaster(0, seekFadeSec);
    clearEndTimer();
    await delay(seekFadeSec);
    if (token !== seekToken || state !== 'playing') return; // A10: only the latest seek completes
    scheduler.cancel(v); // cancel base events + dispose modulators (oscillators keep running)
    anchorSessionPos = t;
    anchorCtxTime = c.currentTime + startLeadSec;
    startOffset = t;
    scheduler.apply(v, p, t, anchorCtxTime, { pulseAvailable: pulseReady }); // fresh schedule from t
    // MULTI-VOICE (v6, §3): reschedule each extra voice from the same offset against the
    // same anchor. The oscillators keep running (scheduler.cancel only drops base events +
    // disposes modulators); the A10 seekToken guard above gates the whole batch — a stale
    // seek returns before any cancel, so no voice is half-rescheduled.
    for (const rec of extraVoices) {
      scheduler.cancel(rec.voice);
      scheduler.apply(rec.voice, voiceView(p, rec.source.nodes), t, anchorCtxTime, {
        pulseAvailable: pulseReady,
      });
    }
    // Phase-2: layer one-shot sources cannot restart (audio-engine B1 analogue), so a
    // seek DISPOSES + REBUILDS the layer nodes from the new offset (K6 / §19.5). The
    // mixer stays (only master moved by the fade), and the rebuild rides the same
    // seekFade window that masks the binaural reschedule. The decode cache is reused.
    const m = mixer;
    if (m) {
      disposeLayers();
      void scheduleLayersFor(c, m, p, anchorCtxTime, t);
    }
    mc.rampMaster(trim, seekFadeSec);
    armEndTimer();
    emitTick(); // snap the UI playhead
  }

  // --- 10. live controls (design §10) ---
  function setMasterTrim(v: number): void {
    assertNotDisposed();
    if (typeof v !== 'number' || !Number.isFinite(v)) return; // A9: ignore non-finite
    trim = clamp01(v);
    if (state === 'playing' && masterCtrl) {
      masterCtrl.rampMaster(trim, trimRampSec);
    }
  }
  // MULTI-VOICE (v6, §3, D-042): live per-voice mix trim — the UI gain-slider path. A cheap
  // single-writer (transport) ramp on the keyed extra-voice trimGain, analogous to
  // setMasterTrim (no whole-session reapply). Unknown voiceId / non-finite value is a no-op.
  function setVoiceTrim(voiceId: string, value: number): void {
    assertNotDisposed();
    if (typeof value !== 'number' || !Number.isFinite(value)) return; // A9: ignore non-finite
    const rec = extraVoices.find((r) => r.source.id === voiceId);
    if (!rec) return; // unknown / not-playing → safe no-op (no pending store; source.gain owns it next startFresh)
    rampLiftParam(rec.trimGain.gain, rec.trimGain.gain.value, clamp01(value), trimRampSec);
  }
  function setLift(opts: LiftOptions | null): void {
    assertNotDisposed();
    if (opts === null) {
      liftIntent = null;
    } else {
      if (!Number.isFinite(opts.speed) || !Number.isFinite(opts.gain)) return; // A9-style: ignore non-finite
      liftIntent = { speed: opts.speed, gain: clamp01(opts.gain) };
    }
    // Apply now only when a session is live (ctx + voice exist); otherwise the stored
    // intent is (re)applied by the next play() (startFresh).
    if (ctx && voice && (state === 'playing' || state === 'paused' || state === 'interrupted')) {
      void applyLift();
    }
  }
  function reapply(): void {
    assertNotDisposed();
    if (!preset) throw new TransportError('NO_PRESET', 'reapply() called before load(preset)');
    if (state !== 'playing' && state !== 'paused' && state !== 'interrupted') return; // no-op idle/stopped
    const c = ctx;
    const v = voice;
    if (!c || !v) return;
    // Live edit at the SAME position: re-ramp base lanes + keep modulator phase (I3b).
    const atCtx = c.currentTime + startLeadSec;
    scheduler.retarget(v, preset, atCtx);
    // MULTI-VOICE (v6, §3): retarget each extra voice at the SAME position (phase kept —
    // retarget, not apply) over its own voiceView, and re-ramp its single-writer trim to the
    // edited Voice.gain. The voice set is the one captured at startFresh (count changes are a
    // STRUCTURAL load(), not a reapply — §3).
    for (const rec of extraVoices) {
      scheduler.retarget(rec.voice, voiceView(preset, rec.source.nodes), atCtx);
      rampLiftParam(rec.trimGain.gain, rec.trimGain.gain.value, clamp01(rec.source.gain ?? 1), trimRampSec);
    }
    // Phase-2: a same-position live edit RETARGETS the layer schedule (keeps the running
    // layer nodes — the layer analogue of §10's modulator-phase rule; NOT a rebuild,
    // which is seek-only — K6/§19.5). No-op when no layers/scheduler are active.
    if (layerSchedule && preset.layers) {
      layerSchedule.retarget(preset.layers, atCtx);
    }
  }

  // --- Lifecycle ---
  function load(p: Preset): void {
    assertNotDisposed();
    if (state === 'playing' || state === 'paused' || state === 'interrupted') {
      teardown(false); // stop the active session first (A8)
    }
    preset = p;
    startOffset = 0;
    anchorSessionPos = 0;
    anchorCtxTime = 0;
    frozenPos = 0;
    trim = p.masterGain; // the session ceiling (design §3)
    needsReschedule = false;
    transitionTo('idle');
  }
  async function stop(): Promise<void> {
    assertNotDisposed();
    if (state === 'idle' || state === 'stopped') return; // A6 no-op
    liftIntent = null; // a user stop() clears the lift intent (not re-applied on next play)
    teardown(true); // fade out + dispose; NO 'ended' (user-initiated)
  }
  async function destroy(): Promise<void> {
    if (disposed) return; // J2 idempotent
    teardown(false); // immediate, no fade
    const c = ctx;
    if (c && typeof c.close === 'function') {
      try {
        await c.close();
      } catch {
        /* ignore */
      }
    }
    detachContextListeners();
    await releaseWakeLock();
    if (audioEl) {
      try {
        audioEl.pause();
      } catch {
        /* ignore */
      }
      audioEl = undefined;
    }
    for (const set of Object.values(listeners)) set.clear();
    decodedClips.clear(); // release the per-context decode cache (buffers are ctx-bound)
    ctx = undefined;
    disposed = true;
  }

  /**
   * Rebuild + reschedule the layer subsystem at the CURRENT playback position without touching
   * the binaural voices (auto-synth-on-play, D-043). After background TTS synthesis populates the
   * clip library, this is how a freshly-synthesized voice clip becomes audible: a missing-clip
   * LayerNode is silent for its whole life (one-shot sources can't gain a buffer later), so the
   * only way to "stream it in" is to dispose the old silent nodes and rebuild from the live
   * `preset.layers` (decoding the now-present buffers), scheduled from here forward. Cues whose
   * time already passed are not restarted (scheduleLayers gates each one-shot by inRange). Reads
   * `preset.layers` by reference, so cues injected since play() are picked up. No-op unless
   * actively playing with a mixer + layer scheduler; safe to call repeatedly as clips arrive.
   */
  async function refreshLayers(): Promise<void> {
    if (disposed || state !== 'playing' || !ctx || !mixer || !preset || !layerScheduler) return;
    const c = ctx;
    const m = mixer;
    const p = preset;
    const pos = computePosition();
    disposeLayers();
    // t0 = now maps to session position `pos` under the running anchor, so the rebuilt cues line
    // up with the ongoing binaural timeline; scheduleLayers starts only the in-range/future ones.
    await scheduleLayersFor(c, m, p, c.currentTime, pos);
  }

  function position(): number {
    assertNotDisposed();
    return computePosition();
  }
  function duration(): number {
    assertNotDisposed();
    return durationSec();
  }
  async function setKeepScreenOn(on: boolean): Promise<void> {
    assertNotDisposed();
    if (!on) {
      keepScreenOn = false;
      await releaseWakeLock();
      return;
    }
    await acquireWakeLock();
  }
  function isKeepScreenOn(): boolean {
    assertNotDisposed();
    return keepScreenOn;
  }

  function delay(sec: number): Promise<void> {
    return new Promise<void>((resolve) => setTimeout(resolve, sec * 1000));
  }

  const transport: Transport = {
    get state() {
      return state;
    },
    load,
    prime,
    play,
    pause,
    seek,
    reapply,
    refreshLayers,
    stop,
    position,
    duration,
    setMasterTrim,
    setVoiceTrim,
    setLift,
    setKeepScreenOn,
    isKeepScreenOn,
    on,
    off,
    destroy,
  };
  return transport;
}
