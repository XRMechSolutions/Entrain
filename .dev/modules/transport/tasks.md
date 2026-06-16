# Tasks: transport
# Planning: .dev/planning/modules/transport/
# Architecture: .dev/architecture.md
# Standards: security, safety
# Stack: typescript

## Agent Briefing
`transport` is the playback clock and audio-lifecycle owner for one session: it turns a validated `Preset` into controllable sound via `play / pause / seek / stop / position` and a `tick` stream, owning the `AudioContext` create/resume/suspend/close lifecycle, the click-free master fade, the D-018 background-audio bridge + MediaSession, the Wake Lock, and recovery from `visibilitychange` / iOS `'interrupted'`. It imports `audio-engine` (Layer 0) for `createVoice` / `registerPulseWorklet` / `Voice` and the `Preset` type (type-only) from `session-model` (Layer 0), and orchestrates the timeline through an injected `SessionScheduler` (implemented by `automation`, never imported directly). It is consumed by the `ui` module (Layer 2), which builds against `interfaces.md`.

## References
- .dev/planning/modules/transport/design.md
- .dev/planning/modules/transport/interfaces.md
- .dev/planning/modules/transport/edge-cases.md
- .dev/planning/modules/transport/dependencies.md
- .dev/knowledge/web-audio/mobile-audio-lifecycle.md
- .dev/knowledge/web-audio/audioparam-automation.md

## Dependencies
- `audio-engine` (Layer 0) — COMPLETE: frozen `createVoice(ctx)` / `registerPulseWorklet(ctx)` and the `Voice` type (`output`, `masterGainParam`, `start`/`stop`/`dispose`). Direct import.
- `session-model` (Layer 0) — COMPLETE: the `Preset` type only (`name`, `durationSec`, `masterGain`). Type-only import; transport trusts the preset is already validated.
- `automation` (Layer 1) — NOT required to start: transport depends on it only through the injected `SessionScheduler` interface (the composition root adapts it). Build/test transport against a fake scheduler. (Stub: the `automation`→`SessionScheduler` adapter is resolved later in the `automation`/`ui` integration.)

## Tasks

- [x] [impl] Declare the public types, `TransportError`, event map, and the §11 constants table | file: src/engine/transport-types.ts | model: T1-lite
  - Ref: .dev/planning/modules/transport/interfaces.md @ Types
  - Ref: .dev/planning/modules/transport/interfaces.md @ Errors
  - Ref: .dev/planning/modules/transport/interfaces.md @ The SessionScheduler contract
  - Ref: .dev/planning/modules/transport/interfaces.md @ Construction
  - Ref: .dev/planning/modules/transport/design.md @ §11 Constants (single source of truth)
  - Accepts: nothing (declarations only); imports `Preset` (type-only) from session-model and `Voice` from audio-engine.
  - Creates: `TransportState`, `BackgroundAudioMode`, `TransportNoticeCode`, `TransportNotice`, `TickEvent`, `TransportEventMap`, `SessionScheduler`, `TransportErrorCode`, `TransportOptions`, `Transport` (all as in interfaces.md); `class TransportError extends Error` with a readonly `code`; a `TRANSPORT_DEFAULTS` constants object (`fadeInSec` 0.5, `fadeOutSec` 0.5, `pauseFadeSec` 0.02, `seekFadeSec` 0.02, `trimRampSec` 0.01, `startLeadSec` 0.02, `mediaSessionPositionThrottleMs` 1000, `backgroundAudioMode` 'mediastream', `minSilentFileSec` 5).
  - Tests: `TransportError('NO_PRESET', msg)` carries `code`+`message` and `instanceof Error`; the union/interface shapes compile against interfaces.md; every `TRANSPORT_DEFAULTS` value equals the §11 table; default `backgroundAudioMode` is `'mediastream'`.

- [x] [impl] Build the analytic master-gain ramp helper (`rampMaster` / `currentMasterValue`), Firefox-safe and linear-only | file: src/engine/transport-master-gain.ts | model: T1 [availability]
  - Ref: .dev/planning/modules/transport/design.md @ §4 Master-gain ramp helper — rampMaster(target, durationSec)
  - Ref: .dev/planning/modules/transport/design.md @ §3 The master fade vs. preset volume fades
  - Ref: .dev/planning/modules/transport/edge-cases.md @ C. No-click / AudioParam ramp quirks
  - Ref: .dev/knowledge/web-audio/audioparam-automation.md @ Browser caveats (MDN browser-compat-data)
  - Accepts: `masterGainParam: AudioParam`, `target: number`, `durationSec: number`, `now: number` (= `ctx.currentTime`).
  - Creates: a controller exposing `rampMaster(target, durationSec)` and `currentMasterValue(now)` that tracks `{ startTime, startValue, endTime, endValue }`; feature-detects `typeof cancelAndHoldAtTime === 'function'` (else `cancelScheduledValues(now)`), anchors `setValueAtTime(currentMasterValue(now), now)`, then `linearRampToValueAtTime(target, now+durationSec)`; `durationSec === 0` collapses to an immediate `setValueAtTime(target, now)`; never reads `param.value`, never uses exponential ramps or `setValueCurveAtTime`.
  - Tests: a 0→trim ramp records the correct record (C1); `currentMasterValue` returns startValue before, endValue after, linear interp between (C6); `cancelAndHoldAtTime` absent → `cancelScheduledValues` fallback called (C5); only `setValueAtTime`+`linearRampToValueAtTime` invoked, never exponential/curve (C2/C7); `param.value` is never read (C6); `durationSec 0` → single `setValueAtTime`.

- [x] [impl] Scaffold the transport: state machine, typed event emitter, `load`, `position`/`duration`, `setMasterTrim`, seek validation/offset path | file: src/engine/transport.ts | file: src/engine/transport-types.ts | model: T1-lite
  - Ref: .dev/planning/modules/transport/design.md @ §2 State machine (the spine of the module)
  - Ref: .dev/planning/modules/transport/design.md @ §7 pause / resume / position (the position formula)
  - Ref: .dev/planning/modules/transport/design.md @ §10 Live controls beyond play/pause/seek
  - Ref: .dev/planning/modules/transport/interfaces.md @ The Transport
  - Ref: .dev/planning/modules/transport/edge-cases.md @ A. Control-surface input / state boundaries
  - Ref: .dev/planning/modules/transport/edge-cases.md @ H. Clock / position / end-of-session
  - Accepts: `createTransport(options: TransportOptions)`; `load(preset: Preset)`; `on/off(event, handler)`; `position()`; `duration()`; `setMasterTrim(v: number)`; `seek(t)` while not playing.
  - Creates: the `createTransport` factory returning a `Transport`; the five-state machine with a single transition helper that emits `statechange` on every change; an identity-based typed event emitter (`on`/`off`); a `disposed` guard helper (throws `TransportError('DISPOSED')` for every method post-`destroy`); `load()` (stops any active session first, stores preset, `startOffset=0`, → `idle`); `position()` (clamped 0..durationSec — `frozenPos` when stopped, `startOffset` when idle, clock-derived `anchorSessionPos + (currentTime − anchorCtxTime)` when playing/paused); `duration()`; `setMasterTrim()` (clamp finite to 0..1, ignore non-finite, store `trim`; the playing-ramp branch is wired in the playback task); `seek()` validation (throw `INVALID_SEEK` on non-finite, `NO_PRESET` with no preset, clamp finite to `[0, durationSec]`) and the idle/stopped/paused offset-store path with `seekToken`/`needsReschedule` fields.
  - Tests: transition table — A4 play-while-playing no-op, A5 pause-not-playing no-op, A6 stop-while-idle/stopped no-op, A8 load-while-active stops first then → idle; A7 any method after destroy throws DISPOSED; A2/A3 seek clamps finite + throws INVALID_SEEK on non-finite + NO_PRESET when nothing loaded; A9 setMasterTrim clamps 0..1 and ignores non-finite; H1 position frozen when stopped, returns startOffset when idle; `on`/`off` add/remove by identity and `statechange` fires on transitions.

- [x] [impl] AudioContext lifecycle, resource cleanup, and iOS-interruption recovery: prime/create, visibility/statechange recovery, Wake Lock, shared teardown, destroy | file: src/engine/transport.ts | model: T1 [availability]
  - Ref: .dev/planning/modules/transport/design.md @ §5 Priming and the autoplay/worklet ordering — prime() then play()
  - Ref: .dev/planning/modules/transport/design.md @ §14 visibilitychange and the iOS 'interrupted' state (recovery)
  - Ref: .dev/planning/modules/transport/design.md @ §15 Wake Lock — the optional screen-on toggle
  - Ref: .dev/planning/modules/transport/design.md @ §13 The tick loop and end-of-session (shared teardown(fade))
  - Ref: .dev/planning/modules/transport/design.md @ §17 Teardown — destroy()
  - Ref: .dev/planning/modules/transport/edge-cases.md @ B. Autoplay / user-gesture requirement
  - Ref: .dev/planning/modules/transport/edge-cases.md @ F. visibilitychange / iOS interruption
  - Ref: .dev/planning/modules/transport/edge-cases.md @ G. Wake Lock
  - Ref: .dev/planning/modules/transport/edge-cases.md @ J. Resource lifecycle
  - Ref: .dev/knowledge/web-audio/mobile-audio-lifecycle.md @ Returning to foreground / iOS
  - Accepts: `prime(): Promise<void>`; `setKeepScreenOn(on): Promise<void>`; `isKeepScreenOn(): boolean`; `destroy(): Promise<void>`; the `audioContextFactory` / `registerWorklet` / `createVoice` DI seams; the loaded `preset`.
  - Creates: `prime()` — lazily build a suspended `AudioContext` (factory or `new (AudioContext ?? webkitAudioContext)()`; if neither, emit fatal `error` `WEB_AUDIO_UNSUPPORTED` and stay idle), `await registerPulseWorklet(ctx)` setting `pulseReady` true/false (false → `warning` `WORKLET_UNAVAILABLE`), idempotent, resolves once context exists and registration settled; `visibilitychange` + ctx `statechange` listeners; the → `interrupted` path (set state, stop tick, clear end timer, `warning` `CONTEXT_INTERRUPTED`); `recoverContext()` (`await ctx.suspend().catch(()=>{}); await ctx.resume();` unstick, on running → `warning` `CONTEXT_RECOVERED`, else stay interrupted) invoked only when intending to play; Wake Lock `request('screen')`/`release` with `WAKE_LOCK_UNSUPPORTED`/`WAKE_LOCK_FAILED` warnings, transparent re-acquire on visible while playing, intended-state `isKeepScreenOn()`; shared `teardown(fade)` (rampMaster(0, fade?fadeOutSec:0) → `voice.stop`/`dispose`, `scheduler.cancel`, disconnect `msDest`, pause `<audio>`+clear `srcObject`, clear MediaSession, release Wake Lock, clear timers/tick, record `frozenPos`, → stopped, context stays open); `destroy()` (`teardown(false)`, `await ctx.close()`, remove listeners, drop `<audio>`, clear subscribers, set `disposed`; idempotent).
  - Tests: B3 `WEB_AUDIO_UNSUPPORTED` fatal + stays idle; prime idempotent and surfaces `WORKLET_UNAVAILABLE` on load failure (B2); F2 statechange → interrupted; F3/F4 recover suspend→resume → running → `CONTEXT_RECOVERED`; F5 recover fails → stays interrupted; F6 no recovery after a user `pause()`; G1/G2 wake-lock unsupported/failed emit warnings, toggle stays false; G3 re-acquire on visible; J1 same context reused across play→stop cycles; J2 destroy twice is a no-op; J3 destroy while playing tears down + closes; J6 OfflineAudioContext feature-detects (`createMediaStreamDestination`/`mediaSession`/`wakeLock`/`requestAnimationFrame`) degrade to no-ops.

- [x] [impl] Background-audio bridge and MediaSession (D-018): output routing for mediastream/silent-file/none + lock-screen metadata, handlers, position | file: src/engine/transport.ts | model: T1
  - Ref: .dev/planning/modules/transport/design.md @ §8 Output routing & the background-audio bridge (D-018)
  - Ref: .dev/planning/modules/transport/design.md @ §12 MediaSession (D-018)
  - Ref: .dev/planning/modules/transport/edge-cases.md @ D. Background-audio bridge (D-018 — empirical)
  - Ref: .dev/planning/modules/transport/edge-cases.md @ E. MediaSession (D-018)
  - Ref: .dev/planning/modules/transport/dependencies.md @ Web APIs used (MediaStreamAudioDestinationNode / HTMLAudioElement / navigator.mediaSession)
  - Ref: .dev/knowledge/web-audio/mobile-audio-lifecycle.md @ Background / locked-screen survival; @ MediaSession
  - Accepts: `backgroundAudioMode`, `silentFileUrl`, `artwork`, `mediaSessionPositionThrottleMs` (from options); `voice: Voice`; `preset: Preset`; throttled position from the tick loop.
  - Creates: `routeOutput(voice)` per mode — `mediastream` (createMediaStreamDestination, disconnect `voice.output`→destination then connect→`msDest`, `audio.srcObject=stream`, `audio.play()` resolve → proceed / reject → reconnect direct + pause `<audio>` + `warning` `BACKGROUND_AUDIO_UNAVAILABLE`); `silent-file` (keep direct to destination + a looping near-silent ≥5 s `<audio src=silentFileUrl loop>`); `none` (direct only, no `<audio>`, no MediaSession); a single reused hidden `<audio>` element; `attachMediaSession(preset)` (feature-detect `'mediaSession' in navigator`, set `MediaMetadata{title,artist,artwork}`, `playbackState`, required `play`/`pause`/`stop` handlers each in try/catch routed to `this.play/pause/stop`, best-effort `seekto` + throttled `setPositionState`); `clearMediaSession()` (handlers `null`, `metadata=null`, `playbackState='none'`); a throttled `updateMediaPosition()` hook for the tick loop.
  - Tests: D1 mediastream resolve → `<audio>` is the sole audible path; D2 reject → reconnect direct + `BACKGROUND_AUDIO_UNAVAILABLE`; D3 never both paths connected (no doubling); D6 `none` mode attaches no MediaSession; E1 `mediaSession` absent → all calls skipped, playback unaffected; E2 `setActionHandler` throw is caught per handler; E3 lock-screen play/pause/stop route to the methods + `playbackState` kept in sync; E4 `setPositionState` throttled to `mediaSessionPositionThrottleMs`; E5 stop/end clears handlers + metadata + sets `'none'`; silent-file element is `loop` and the asset is ≥5 s (D5).

- [x] [impl] Playback and clock: play() start sequence, pause/resume, seek reschedule, master fades, tick loop, end-of-session timer, and SessionScheduler orchestration | file: src/engine/transport.ts | model: T1-lite [availability]
  - Ref: .dev/planning/modules/transport/design.md @ §6 play() — the start sequence (idle/stopped → playing)
  - Ref: .dev/planning/modules/transport/design.md @ §7 pause() / resume / position
  - Ref: .dev/planning/modules/transport/design.md @ §8.3 seek(t) — the only operation that re-schedules
  - Ref: .dev/planning/modules/transport/design.md @ §9 Orchestrating automation through an injected SessionScheduler
  - Ref: .dev/planning/modules/transport/design.md @ §13 The tick loop and end-of-session
  - Ref: .dev/planning/modules/transport/design.md @ §16 Errors: thrown vs. emitted (SCHEDULE_FAILED)
  - Ref: .dev/planning/modules/transport/edge-cases.md @ A. Control-surface input / state boundaries
  - Ref: .dev/planning/modules/transport/edge-cases.md @ C. No-click / AudioParam ramp quirks (pause/seek micro-fades)
  - Ref: .dev/planning/modules/transport/edge-cases.md @ H. Clock / position / end-of-session
  - Ref: .dev/planning/modules/transport/edge-cases.md @ I. Orchestration / scheduler (automation) failures
  - Ref: .dev/knowledge/web-audio/mobile-audio-lifecycle.md @ Start: autoplay policy
  - Accepts: `play()/pause()/seek(t)/stop(): Promise<void>`; the injected `SessionScheduler`; the lifecycle/routing/ramp primitives built by the prior tasks.
  - Creates: `play()` start sequence (await `prime()`, fire `ctx.resume()` non-blocking, `createVoice(ctx)`, `routeOutput`, `t0 = currentTime + startLeadSec` + set `anchorCtxTime`/`anchorSessionPos`, `scheduler.apply(voice, preset, startOffset, t0, { pulseAvailable: pulseReady })`, `voice.start(t0)` in-gesture, `rampMaster(trim, fadeInSec)`, `audio.play()`+attach MediaSession, arm end timer + start tick, → playing) plus the paused/interrupted resume path (resume/recover, optional `needsReschedule` cancel+reapply, fade up, re-arm end timer); `pause()` (rampMaster(0, pauseFadeSec) → setTimeout → `ctx.suspend()`, stop tick, clear end timer, MediaSession `paused`, → paused); `seek()` playing path (rampMaster(0, seekFadeSec) → `scheduler.cancel` → re-anchor at `t` → `scheduler.apply` → rampMaster(trim, seekFadeSec) + re-arm end timer + emit one tick, with stale-`seekToken` abort); the rAF tick loop emitting `TickEvent{positionSec,durationSec,state}` + throttled MediaSession position + foreground end backup; `endTimer = setTimeout(endSession, remainingMs)` armed on every → playing and cleared on pause/seek/stop/interrupt, `endSession()` runs `teardown(true)` + emits `ended`; `stop()` = `teardown(true)` with no `ended`; the playing-branch of `setMasterTrim` (rampMaster over trimRampSec); `SCHEDULE_FAILED` handling (scheduler.apply throws → `teardown(false)` + fatal `error`).
  - Tests: §6/B5 start ordering — `resume()` fired and `voice.start(t0)` in the gesture, masterGain begins 0 and fades to trim; A1 `play()`/`seek()` with no preset throws NO_PRESET; C3 pause fades to silence then suspends; resume fades up and re-arms the end timer with recomputed remaining; C4 seek fades/reschedules/fades, A10 rapid seeks → only latest `seekToken` completes; H3 endTimer is authoritative (fires when rAF is throttled), H4 late fire harmless, H5 24 h duration `remainingMs < 2^31` no overflow; tick emits clamped position + state; I1 `SCHEDULE_FAILED` → `teardown(false)` + fatal error (no half-played session); I2 `pulseAvailable=false` passed when worklet not ready; `ended` emitted on natural end but not on user `stop()`.

- [x] [audit] Behavioral audit: transport | file: .dev/.task-state/audit-transport.md | model: T1
  - Ref: C:/Projects/.dev-shared/behavioral-audit.md
  - Ref: .dev/planning/modules/transport/interfaces.md
  - Ref: .dev/planning/modules/transport/edge-cases.md
  - Verify the module's observable behavior matches `interfaces.md` (trace every public interface — `createTransport`, `load`, `prime`, `play`, `pause`, `seek`, `stop`, `position`, `duration`, `setMasterTrim`, `setKeepScreenOn`, `isKeepScreenOn`, `on`/`off`, `destroy`, the `SessionScheduler` contract, the `error`/`warning`/`tick`/`statechange`/`ended` events) from input → implementation → observable output, with no silent defaults and no broken consumers.
  - Verify every edge case in `edge-cases.md` (A1–A10, B1–B5, C1–C7, D1–D7, E1–E5, F1–F7, G1–G4, H1–H6, I1–I4, J1–J6) has evidence of handling in the code.
  - Write findings to `.dev/.task-state/audit-transport.md`; PASS required before the module is complete.

## Completion Criteria
- [ ] All tasks above marked [x] — none left [ ] (Pending) or [!] (Needs-Attention)
- [ ] Zero active stubs for the `transport` module in .dev/.task-state/stub-registry.md
- [ ] All `transport` module tests passing (full suite, not just the current task's)
- [ ] Per-task audit PASS for every task
- [ ] last-step-summary.md written for every task with a concrete Observable Verification entry
- [ ] Behavioral audit PASS (audit-transport.md verdict = PASS)
