// transport-types — public contracts for the Layer-1 transport module.
//
// These are the types the `ui` module builds against, plus the `SessionScheduler`
// contract that `automation` must satisfy (adapted by the composition root). All
// times exposed to callers are SESSION seconds (0..durationSec); internal scheduling
// is in AudioContext seconds. transport imports `audio-engine` (createVoice /
// registerPulseWorklet / Voice) and the `Preset` type (type-only) from session-model.
//
// See .dev/planning/modules/transport/{design,interfaces,edge-cases}.md.

import type { Layer, Preset } from './session-model';
import type { Voice, VoiceOptions } from './audio-engine';
import type { Mixer } from './mixer';
import type { LayerNode } from './layer-engine';
import type { ShepardHandle, ShepardOptions } from './shepard';

// Re-export the Phase-2 bus/layer contracts transport composes by injection, so the
// ui composition root (and tests) reference one surface. These are TYPE-only imports —
// transport never hard-imports mixer / layer-engine, it receives them through the DI
// seams below (createMixer / layerScheduler), the same IoC pattern as `scheduler`.
export type { Mixer, DuckSpan } from './mixer';
export type { LayerNode } from './layer-engine';
export type { Layer } from './session-model';

// --- Public state / mode unions --------------------------------------------

/** Transport lifecycle state. See design.md §2 for the transition table. */
export type TransportState =
  | 'idle' // preset loaded (or none); nothing started
  | 'playing' // context running, voice started, tick firing
  | 'paused' // user paused; context suspended; voice intact
  | 'interrupted' // OS took the context (iOS 'interrupted' / unexpected suspend)
  | 'stopped'; // session ended; voice stopped + disposed

/** How the voice reaches the speakers and earns background audio focus (D-018). */
export type BackgroundAudioMode =
  | 'mediastream' // default: voice → MediaStreamAudioDestinationNode → hidden <audio srcObject>
  | 'silent-file' // direct to destination + a near-silent looping <audio> holds focus
  | 'none'; // direct to destination only; no <audio>, no MediaSession

// --- Notices (carried by 'error' / 'warning' events) -----------------------

/** Non-fatal/fatal platform conditions surfaced as events (see code unions below). */
export type TransportNoticeCode =
  | 'WEB_AUDIO_UNSUPPORTED' // fatal: no AudioContext constructor
  | 'SCHEDULE_FAILED' // fatal: injected scheduler threw during apply()
  | 'WORKLET_UNAVAILABLE' // warn: pulse worklet failed to load; no pulse modulators
  | 'BACKGROUND_AUDIO_UNAVAILABLE' // warn: MediaStream/<audio> bridge failed; using direct output
  | 'CONTEXT_INTERRUPTED' // warn: iOS interruption / unexpected suspend; clock frozen
  | 'CONTEXT_RECOVERED' // warn: context recovered after an interruption
  | 'WAKE_LOCK_UNSUPPORTED' // warn: navigator.wakeLock missing
  | 'WAKE_LOCK_FAILED'; // warn: wakeLock.request rejected

/** A single notice carried by the 'error' / 'warning' events. */
export interface TransportNotice {
  readonly code: TransportNoticeCode;
  readonly message: string; // human-readable, for a banner
}

/** The Shepard–Risset "lift" overlay settings (an independent live layer, NOT part of
 *  the preset). speed is SIGNED octaves/sec: + ascends (rising/lift), − descends. */
export interface LiftOptions {
  readonly speed: number; // octaves/sec, signed (+ ascending / − descending)
  readonly gain: number; // output level 0..1
}

/** Payload of the 'tick' event (UI playhead). */
export interface TickEvent {
  readonly positionSec: number; // clamped 0..durationSec
  readonly durationSec: number;
  readonly state: TransportState;
}

/** Strongly-typed event map for on()/off(). */
export interface TransportEventMap {
  tick: TickEvent;
  statechange: { readonly state: TransportState };
  ended: void; // session reached durationSec and stopped naturally
  error: TransportNotice; // fatal — playback cannot proceed
  warning: TransportNotice; // degraded — playback continues
  // The OS/Bluetooth next/previous-track media keys. This app has no track list, so transport
  // does NOT act on them — it surfaces them as a neutral event and the app decides what they
  // mean (the sleep UI maps next → "drift deeper", previous → "resurface").
  mediaskip: { readonly direction: 'next' | 'previous' };
}

// --- The SessionScheduler contract (implemented by `automation`) -----------
//
// Per-voice contract. Every method operates on ONE voice + its own preset view and
// holds no cross-voice state. In a multi-voice session (multi-voice-architecture.md §3)
// transport invokes apply/retarget/cancel ONCE PER VOICE — the primary voice off
// `preset.nodes`, then each extra voice off its `voiceView(preset, voice.nodes)` — so
// each voice gets an independent schedule. Single-voice presets call each method exactly
// once (byte-identical to pre-multi-voice). (The multi-voice mix trim + teardown live on
// transport, not here: the `Transport` interface separately gained `setVoiceTrim`, and
// transport drives each voice's fade through the shared bus master.)

export interface SessionScheduler {
  /** INITIAL START. Build a FRESH schedule for the WHOLE preset onto the voice:
   *  anchor every param at `atCtxTime`, wire/drive all modulators, set the initial
   *  waveform, mapping session time `fromSec` → context time `atCtxTime`, covering
   *  through preset.durationSec. When `pulseAvailable` is false, skip pulse modulators
   *  (do NOT call createPulseNode). Must not stop or start the voice's sources.
   *  Used at start, seek, and resume-after-paused-seek. */
  apply(
    voice: Voice,
    preset: Preset,
    fromSec: number,
    atCtxTime: number,
    opts: { readonly pulseAvailable: boolean },
  ): void;

  /** LIVE EDIT (playback position UNCHANGED). The preset was edited at the SAME
   *  position; re-ramp the base carrier/beat/volume curves to the new values from
   *  `atCtxTime`, AND reconcile the modulators KEEPING their running node where the
   *  modulator identity is unchanged so phase stays continuous. Must not stop or start
   *  the voice's sources. Used by transport's live-edit entry point (`reapply()`),
   *  NOT by seek. */
  retarget(voice: Voice, preset: Preset, atCtxTime: number): void;

  /** TEARDOWN. Cancel the base carrier/beat/volume params' future scheduled values
   *  AND dispose the modulator handles, WITHOUT stopping its oscillators (so
   *  seek/resume can keep them running). MUST cancel the queued base ramps, not only
   *  dispose modulator nodes. */
  cancel(voice: Voice): void;
}

// --- Phase-2 contracts (the unified bus + layers — D-036) ------------------
//
// The AUTHORITATIVE source is phase2-audio-architecture.md §6 (the cross-module
// contract spine). `LayerSchedule` / `LayerSchedulerFactory` are restated VERBATIM
// from §6 / interfaces.md and must not drift — if they ever diverge, §6 wins.
// Transport receives the `scheduleLayers` free function by injection
// (`TransportOptions.layerScheduler`), the same IoC pattern as `SessionScheduler`,
// and never imports `layer-scheduler` directly.

/** The handle the injected layer scheduler returns (one per session). Restated
 *  verbatim from arch §6: `{ retarget(layers, atCtx?); cancel(); dispose() }`. */
export interface LayerSchedule {
  /** LIVE EDIT: re-ramp the layer lanes (gain/pan) + the bed duck to the edited
   *  layers from `atCtx`, keeping the running layer nodes (the layer analogue of
   *  `scheduler.retarget`). Driven by transport's `reapply()`. */
  retarget(layers: readonly Layer[], atCtx?: number): void;
  /** Cancel the scheduled layer lane + duck automation (without disposing nodes). */
  cancel(): void;
  /** Dispose the schedule's owned resources. The layer NODES are owned + disposed by
   *  transport (it builds them); this disposes the scheduler-side bookkeeping. */
  dispose(): void;
}

/** The injected factory shape transport calls (the `automation` scheduleLayers
 *  adapter, supplied by the ui composition root). Matches arch §6's `scheduleLayers`
 *  free-function signature exactly; transport never imports layer-scheduler. */
export type LayerSchedulerFactory = (
  mixer: Mixer,
  nodes: readonly LayerNode[],
  layers: readonly Layer[],
  opts: { readonly t0: number; readonly startOffsetSec: number },
) => LayerSchedule;

// --- Errors ----------------------------------------------------------------

/** The only error TYPE transport throws (programmer/contract misuse).
 *  Platform/runtime conditions are EMITTED as 'error'/'warning', not thrown. */
export type TransportErrorCode =
  | 'NO_PRESET' // play()/seek() called before load()
  | 'INVALID_SEEK' // seek(t) with a non-finite t
  | 'DISPOSED'; // any method after destroy()

export class TransportError extends Error {
  readonly code: TransportErrorCode;

  constructor(code: TransportErrorCode, message?: string) {
    super(message ?? code);
    this.name = 'TransportError';
    this.code = code;
    // Restore the prototype chain so `instanceof TransportError` survives ES2015+
    // transpilation (matches the audio-engine / session-model error pattern).
    Object.setPrototypeOf(this, TransportError.prototype);
  }
}

// --- Construction ----------------------------------------------------------

export interface TransportOptions {
  /** REQUIRED. The automation-backed scheduler (no default; injected to keep
   *  transport decoupled from automation's not-yet-frozen API). */
  scheduler: SessionScheduler;

  /** PHASE-2 (D-036), OPTIONAL. The layer-scheduler factory (the `automation`
   *  `scheduleLayers` adapter), injected by the ui composition root exactly like
   *  `scheduler`. When present, transport builds `LayerNode`s for `preset.layers`
   *  and drives `scheduleLayers(mixer, nodes, layers, …)` alongside the binaural
   *  scheduler (design §19.5). When absent (Phase-1 host, or a preset with no
   *  layers), transport composes the mixer and routes the voice through it but
   *  schedules no layers. See phase2-audio-architecture.md §2.2 / §6. */
  layerScheduler?: LayerSchedulerFactory;

  /** Master fade-in / fade-out (seconds). Defaults 0.5 / 0.5. */
  fadeInSec?: number;
  fadeOutSec?: number;

  /** Background routing strategy (D-018). Default 'mediastream'. */
  backgroundAudioMode?: BackgroundAudioMode;
  /** Near-silent ≥5s loop for 'silent-file' mode. Default: bundled pwa-shell asset (stub). */
  silentFileUrl?: string;

  /** MediaSession artwork (lock-screen icon). Default: [] (UI/pwa-shell may supply). */
  artwork?: readonly MediaImage[];

  /** Min ms between MediaSession setPositionState updates. Default 1000. */
  mediaSessionPositionThrottleMs?: number;

  // --- Testing / DI seams (all default to the standard platform / audio-engine) ---
  /** Build the AudioContext. Default () => new (AudioContext ?? webkitAudioContext)().
   *  Inject an OfflineAudioContext factory for tests. */
  audioContextFactory?: () => AudioContext;
  /** Register the pulse worklet. Default audio-engine.registerPulseWorklet. */
  registerWorklet?: (ctx: BaseAudioContext) => Promise<void>;
  /** Build a fresh voice. Default (ctx, opts) => audio-engine.createVoice(ctx, opts).
   *  PHASE-2: transport calls this with `{ master: 'bus' }` so the voice's internal
   *  master is a unity passthrough and the `mixer` owns the only master (no
   *  double-attenuation; phase2-audio-architecture.md §2.1 / §2.2). */
  createVoice?: (ctx: BaseAudioContext, opts?: VoiceOptions) => Voice;
  /** PHASE-2, OPTIONAL. Build the per-session mixer (the unified bus).
   *  Default (ctx, opts) => mixer.createMixer(ctx, opts). Inject a fake in tests.
   *  MULTI-VOICE (v6): transport passes `{ bedHeadroom: 1/√N }` (N = 1 + extra voices)
   *  so summing N voices at `bedInput` does not overdrive busSum → master
   *  (multi-voice-architecture.md §2, D-041). Default 1 ⇒ single-voice byte-identical. */
  createMixer?: (ctx: BaseAudioContext, opts?: { bedHeadroom?: number; masterStart?: number }) => Mixer;
  /** Register the shepard ("lift") worklet. Default shepard.registerShepardWorklet. */
  registerShepard?: (ctx: BaseAudioContext) => Promise<void>;
  /** Build a shepard ("lift") node. Default shepard.createShepardNode. */
  createShepard?: (ctx: BaseAudioContext, opts?: ShepardOptions) => ShepardHandle;
}

// --- The Transport ---------------------------------------------------------

export interface Transport {
  readonly state: TransportState;

  /** Load (or replace) the preset to play. Stops any active session first, then
   *  resets to 'idle' with startOffset 0. Trusts the Preset is session-model-valid. */
  load(preset: Preset): void;

  /** Create the AudioContext (suspended — autoplay-safe) and begin/await pulse
   *  worklet registration. Idempotent. Resolves once the context exists and
   *  registration has settled. */
  prime(): Promise<void>;

  /** START or RESUME, depending on state. MUST be called from a user gesture.
   *  No-op while already 'playing'. Throws NO_PRESET if nothing is loaded. */
  play(): Promise<void>;

  /** Fade to silence then suspend the context (clock + timeline freeze together).
   *  No-op unless 'playing'. */
  pause(): Promise<void>;

  /** Jump to session second `t` (clamped 0..durationSec). While playing: fade,
   *  reschedule from t, fade back. While paused/idle/stopped: store the offset.
   *  Throws INVALID_SEEK if t is non-finite, NO_PRESET if nothing is loaded. */
  seek(t: number): Promise<void>;

  /** LIVE EDIT at the CURRENT position. Re-derive the running timeline by routing
   *  through `scheduler.retarget`. No-op unless playing/paused/interrupted.
   *  Synchronous. Throws NO_PRESET if nothing is loaded. See design §10. */
  reapply(): void;

  /** TRANSIENT OVERLAY. Live-retarget the running voice(s) to a SUPPLIED preset at the
   *  current position, preserving modulator phase — the same continuity-keeping path as
   *  reapply(), but to an externally-derived preset instead of the loaded one. Does NOT
   *  change the loaded preset, the duration, or the playhead; a later reapply()/seek()
   *  schedules from the loaded preset again, so the overlay naturally ends. Intended for
   *  non-persisted nudges such as the sleep "drift deeper" control. Synchronous; no-op
   *  unless playing/paused/interrupted. */
  retargetTo(preset: Preset): void;

  /** Rebuild + reschedule the LAYER subsystem at the current position WITHOUT touching the
   *  binaural voices (auto-synth-on-play, D-043). Disposes the current layer nodes and rebuilds
   *  them from the live `preset.layers` (decoding any now-available clip buffers), scheduling
   *  from here forward — so a voice clip synthesized in the background after play() "streams in"
   *  for the rest of the session (a missing-clip node is silent for life; the only fix is a
   *  rebuild). Cues already past are not restarted. No-op unless actively playing with a layer
   *  scheduler. Idempotent and safe to call repeatedly as clips arrive. */
  refreshLayers(): Promise<void>;

  /** End the session: fade out, stop + dispose the voice, clear MediaSession,
   *  release Wake Lock. → 'stopped'. The AudioContext stays open for reuse.
   *  No 'ended' event. No-op if already 'stopped'/'idle'. */
  stop(): Promise<void>;

  /** Current playhead in session seconds (clamped 0..durationSec). */
  position(): number;

  /** The loaded preset's durationSec, or 0 if none loaded. */
  duration(): number;

  /** Live master-volume trim (the one non-automated control). v clamped 0..1.
   *  Ramps masterGain over 10 ms if playing; otherwise stored for the next fade-in. */
  setMasterTrim(v: number): void;

  /** MULTI-VOICE (v6): live per-voice mix trim — the UI gain-slider path for an extra
   *  voice (keyed by Voice.id). value clamped 0..1, cheap single-writer 10 ms ramp on that
   *  voice's trim gain (analogous to setMasterTrim; no whole-session reapply). Unknown
   *  voiceId or non-finite value is a no-op. */
  setVoiceTrim(voiceId: string, value: number): void;

  /** Enable/update/disable the Shepard–Risset "lift" overlay (an endless ascending or
   *  descending glissando mixed in PARALLEL to the binaural voice, feeding the same
   *  output target without disturbing the voice/bridge routing). Pass LiftOptions to
   *  enable (click-free 10 ms fade-in) or update speed/gain live; pass null to fade out
   *  + dispose. While not playing the intent is stored and (re)applied on the next
   *  play(); a user stop() clears it. Non-finite speed/gain is ignored. */
  setLift(opts: LiftOptions | null): void;

  /** Optional Wake Lock "keep screen on" toggle (default off). Async. Emits
   *  WAKE_LOCK_UNSUPPORTED / WAKE_LOCK_FAILED on failure. */
  setKeepScreenOn(on: boolean): Promise<void>;
  /** The intended toggle state (independent of momentary auto-release while hidden). */
  isKeepScreenOn(): boolean;

  /** Subscribe / unsubscribe. Multiple handlers per event; off() removes by identity. */
  on<K extends keyof TransportEventMap>(event: K, handler: (payload: TransportEventMap[K]) => void): void;
  off<K extends keyof TransportEventMap>(event: K, handler: (payload: TransportEventMap[K]) => void): void;

  /** Terminal teardown: stop, close the AudioContext, remove listeners. Idempotent.
   *  Any later call throws DISPOSED. */
  destroy(): Promise<void>;
}

// --- Constants (single source of truth, design §11) ------------------------

/** Transport timing/behaviour defaults. Fade durations are overridable via
 *  TransportOptions; the rest are fixed. Values mirror design.md §11 exactly. */
export const TRANSPORT_DEFAULTS = {
  fadeInSec: 0.5, // master fade-in (s)
  fadeOutSec: 0.5, // master fade-out before teardown (s)
  pauseFadeSec: 0.02, // 20 ms fade to silence before suspend(), and back on resume
  seekFadeSec: 0.02, // 20 ms fade around the reschedule jump
  trimRampSec: 0.01, // 10 ms live master-volume change (engine no-click window)
  startLeadSec: 0.02, // 20 ms scheduling lead so events never land in the past
  mediaSessionPositionThrottleMs: 1000, // min spacing of setPositionState updates
  backgroundAudioMode: 'mediastream', // the D-018 primary mechanism
  minSilentFileSec: 5, // audio-focus "effective media duration" minimum
} as const;
