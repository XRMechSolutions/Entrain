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

## Feature: Multi-Voice (v6)

> Multi-voice lands almost entirely here as an ADDITIVE loop over `preset.voices ?? []`; the
> primary "voice 0" path stays byte-identical (multi-voice-architecture.md §3). Each extra voice =
> a `createVoiceFn(c,{master:'bus'})` → single-writer trim GainNode (`Voice.gain`) → the SAME
> `mixer.bedInput`, scheduled by its OWN `scheduler.apply` over a shared `voiceView`. automation
> needs NO change. Layer C — after the schema gate (A) and the mixer `bedHeadroom` opt (B).
> Transport is the integration hub gating the UI.
>
> **Naming:** transport's local `Voice` is the audio-engine RUNTIME handle; import the session-model
> DATA type aliased `import type { Voice as PresetVoice }`.

- [x] [impl] In `startFresh` (transport.ts ~945), after the primary voice's `scheduler.apply`, loop `preset.voices ?? []` building one `{voice, trimGain, source}` record each: `createVoiceFn(c,{master:'bus'})`, drop its destination edge (`voice.output.disconnect(c.destination)` in try/catch — mirrors the primary/mediastream rewire), create a single-writer `trimGain = clamp01(source.gain ?? 1)`, wire `voice.output → trimGain → mixer.bedInput`, `scheduler.apply(voice, voiceView(p, source.nodes), startOffset, t0, {pulseAvailable})`, `voice.start(t0)`. Compute `N = 1 + (preset.voices?.length ?? 0)` and construct the mixer with `{ bedHeadroom: 1/Math.sqrt(N) }`. **All-or-nothing**: any per-voice apply failure disposes every voice created so far and routes the failure through the EXISTING primary SCHEDULE_FAILED path — nest the per-voice loop inside the existing apply-failure `try`, so a throw runs `teardown(false)` + emits a fatal `'error'` `SCHEDULE_FAILED` notice + returns (do NOT throw out of `play()` — §16/I1 convention), preserving I1 "no half-started session" | file: src/engine/transport.ts | model: T1
  - Ref: .dev/planning/multi-voice-architecture.md @ §3 (startFresh row); §2 (bedHeadroom); §1.5 (voiceView)
  - Ref: .dev/planning/decisions-log.md @ D-040, D-041
  - Ref: src/engine/transport.ts @ startFresh (~945; the createVoiceFn + createMixer + scheduler.apply region; the existing primary apply-failure `try` that emits SCHEDULE_FAILED + teardown(false) — the I1 all-or-nothing semantics)
  - Creates: the `extraVoices: {voice,trimGain,source}[]` records keyed by `source.id`; the per-voice create+drop-destination+wire+schedule+start loop; the `bedHeadroom` argument; import `voiceView` + `PresetVoice` from session-model
  - Tests: a preset with 3 extra voices spins up 4 voices, each `{master:'bus'}` → its own trimGain → bedInput, each with NO direct `ctx.destination` edge; assert the `createMixer` DI seam is invoked with `bedHeadroom === 1/Math.sqrt(1 + voices.length)` for a multi-voice preset and `=== 1` for `voices:undefined`; pulse worklet registered exactly once (shared); `voices:undefined` behaves byte-identically to today; a per-voice apply throw aborts the whole start with zero half-started voices AND emits a fatal `'error'` `SCHEDULE_FAILED` notice (does not throw out of `play()`)
  - Ripple: depends on session-model v6 (`Voice`, `preset.voices`, `voiceView`, `LIMITS.maxVoices`) and the mixer `bedHeadroom` opt

- [x] [impl] In `seekWhilePlaying` and `resume`'s reschedule branch, after the primary voice cancel+apply, iterate the extra-voice records calling `scheduler.cancel(rec.voice)` then `scheduler.apply(rec.voice, voiceView(p, rec.source.nodes), t, anchorCtxTime, {pulseAvailable})` — oscillators keep running; the A10 seekToken guard gates the whole batch | file: src/engine/transport.ts | model: T1
  - Ref: .dev/planning/multi-voice-architecture.md @ §3 (seek/resume row)
  - Ref: src/engine/transport.ts @ seekWhilePlaying (~1100) + resume reschedule branch (~1025); the A10 seekToken guard (~1109, gates the whole batch)
  - Tests: seek/resume reschedules every voice from the new offset; the seekToken guard still discards a superseded batch; phase continuity across all voices

- [x] [impl] In `reapply` (transport.ts ~1152), after `scheduler.retarget` for the primary, iterate records calling `scheduler.retarget(rec.voice, voiceView(preset, rec.source.nodes), atCtx)` and re-ramp each `rec.trimGain` to `clamp01(rec.source.gain ?? 1)`; ADD `transport.setVoiceTrim(voiceId, value)` — a single-writer cheap ramp on the keyed per-voice trimGain (the live UI gain path, analogous to `setMasterTrim`). DECLARE `setVoiceTrim(voiceId: string, value: number): void` on the public `Transport` interface (`transport-types.ts`, mirroring `setMasterTrim`) AND in `transport/interfaces.md` — without it the explicitly-typed factory literal (`const transport: Transport = {…}`, transport.ts:1244) is a TS2353 excess-property error and the UI cannot type-resolve the call → `npm run check` red | file: src/engine/transport.ts, src/engine/transport-types.ts | model: T1
  - Ref: .dev/planning/multi-voice-architecture.md @ §3 (reapply row + setVoiceTrim); D-042
  - Ref: .dev/planning/modules/transport/interfaces.md @ setMasterTrim (the analog to mirror — add `setVoiceTrim` beside it)
  - Ref: src/engine/transport.ts @ reapply (~1152) + setMasterTrim (~1130, the impl pattern); transport-types.ts @ `Transport` interface (~223, `setMasterTrim` ~266)
  - Creates: the per-voice retarget loop; `setVoiceTrim(voiceId: string, value: number): void` ON the `Transport` interface (transport-types.ts) + in transport/interfaces.md + in the factory literal. Contract: `clamp01` the value, IGNORE non-finite (early return, like setMasterTrim/A9), ramp `trimGain.gain` over `TRANSPORT_DEFAULTS.trimRampSec`, find the record in `extraVoices` by `voiceId` (single-writer = transport); when no live record exists it is a safe no-op — do NOT store a pending value (unlike `setMasterTrim`; the not-playing per-voice gain is owned by `source.gain` at the next `startFresh`)
  - Tests: a live param edit retargets every voice with phase KEPT; `setVoiceTrim` ramps only the named voice's trim over `trimRampSec` and does NOT trigger a full reschedule; an unknown/not-playing voiceId is a safe no-op; a non-finite value is ignored; `setVoiceTrim` is declared on the `Transport` type so the factory literal and the UI call type-check (`npm run check` green)

- [x] [impl] In `teardown` (transport.ts ~820), after the primary cancel + `v.stop(now+fadeSec)`, iterate records: `scheduler.cancel(rec.voice)` + `rec.voice.stop(now+fadeSec)`; in `finish()` (~849, post-fade) `rec.voice.dispose()` + `rec.trimGain.disconnect()`; clear `extraVoices = []`. The single bus master fade already covers every voice via `bedInput`. Update `transport-types.ts` SessionScheduler doc-comments to state apply/retarget/cancel run once per voice (this is a doc-comment-only change to the **SessionScheduler** interface — no change to its signature; note the `Transport` interface itself separately gained `setVoiceTrim` in task 3) | file: src/engine/transport.ts, src/engine/transport-types.ts | model: T1
  - Ref: .dev/planning/multi-voice-architecture.md @ §3 (teardown row)
  - Ref: src/engine/transport.ts @ teardown (~820) / finish() (~849)
  - Tests: teardown stops + disposes every voice and disconnects every trim on the success path; the single `rampMaster(0,fadeSec)` covers all voices; idempotent re-teardown safe

- [x] [test] Add a 'multi-voice presets' suite to transport.test.ts: N+1 voices each `{master:'bus'}`→trim→bedInput; per-voice apply/cancel/retarget on play/seek/resume/reapply/teardown; `setVoiceTrim` ramps one voice; pulse worklet once; single bus fade on teardown; `voices:undefined` identical to today | file: src/engine/transport.test.ts | model: T2
  - Ref: .dev/planning/multi-voice-architecture.md @ §3; §8
  - Note: bump any `schemaVersion:5` fixture literal here as part of the Layer-A sweep

- [x] [audit] Confirm `automation.ts` requires NO source change (`scheduleAll`/`schedule` never read `preset.voices`, remain per-voice) and the UI scheduler-adapter's `WeakMap<Voice>` already yields independent per-voice schedules; record the cross-module finding that renderer needs the identical per-voice loop | file: src/engine/automation.ts | model: T2
  - Ref: .dev/planning/multi-voice-architecture.md @ §3 (automation UNCHANGED)
  - Note: this audit also bumps the un-owned `automation.test.ts:44` `schemaVersion:5` literal IF the Layer-A sweep has not already — confirm it is 6 and `npm run check` green

## Completion Criteria
- [ ] All tasks above marked [x] — none left [ ] (Pending) or [!] (Needs-Attention)
- [ ] Zero active stubs for the `transport` module in .dev/.task-state/stub-registry.md
- [ ] All `transport` module tests passing (full suite, not just the current task's)
- [ ] Per-task audit PASS for every task
- [ ] last-step-summary.md written for every task with a concrete Observable Verification entry
- [ ] Behavioral audit PASS (audit-transport.md verdict = PASS)

## Feature: mixer bus + layers (Phase 2)

Phase 2 (D-036/D-037) moves `master` off the voice and onto a single per-session
summation **bus** (`mixer`): the binaural voice and all layers share one master, one
duck, and one output retarget. Transport composes that bus, retargets routing to
`mixer.master`, rides the Shepard lift through `mixer.liftInput`, and drives the
injected `scheduleLayers` factory. The normative contract is
phase2-audio-architecture.md §1 / §2.2 / §4 / §5 / §6; design §19 describes only
what transport does to honor it; where they disagree, the arch doc wins. This
feature stays entirely within `src/engine/transport.ts`, `src/engine/transport-types.ts`,
and `src/engine/transport.test.ts` — `mixer` / `layer-engine` / `layer-scheduler`
are composed by injection and imported type-only, never modified here.

### Dependencies (must be complete before this feature starts)
- `session-model` v3→v4 schema bump (`Layer`, `LayerKind`, `Preset.layers`) — the §0
  gating blocker; `Preset`/`Layer` types must exist for the type-only imports.
- `mixer` (Layer-0, NEW) — `createMixer` and the `Mixer`/`DuckSpan` types (arch §1/§6).
- `layer-engine` (Layer-0, NEW) — `createLayerNode` and the `LayerNode` type (arch §6).
- `audio-engine` `VoiceOptions.master?: 'internal' | 'bus'` flag (arch §2.1/§6).
- `layer-scheduler` (Layer-1, NEW) — the `scheduleLayers` free function the ui
  composition root adapts into `TransportOptions.layerScheduler`. NOT required to
  start: transport drives it through the injected `LayerSchedulerFactory` and is
  built/tested against a fake. (Stub: the `automation`→`layerScheduler` adapter is
  resolved in the `automation`/`ui` integration, same seam as `SessionScheduler`.)

### Cohesion guardrails (acceptance criteria for EVERY task below)
- The existing test suites are byte-identical guardrails: `automation.test.ts`
  (scheduleLane extraction), `audio-engine.test.ts` (the `master` flag defaults to
  `'internal'` so every Phase-1 voice test is unchanged), `transport-master-gain.test.ts`
  (param-agnostic controller, no signature change). Run the FULL suite green BEFORE
  and AFTER each task; any pre-existing-test diff outside `transport.test.ts` is a
  regression, not a spec change.
- No-click ramps only (D-008): `setValueAtTime(JS-anchor)` + `linearRampToValueAtTime`;
  never exponential, never `setValueCurveAtTime`. `mixer.master` starts at 0, so the
  start fade-in stays the click-free `0 → trim` ramp.
- Single-writer params (D-019): only `transport-master-gain` writes `mixer.masterParam`;
  only `mixer.scheduleDuck` writes `duckParam`. Transport NEVER writes `duckParam` and
  never reads `param.value` (analytic tracking, design §4).

- [x] [prereq] Add the Phase-2 bus/layer contract imports and the `layerScheduler` injection seam to `TransportOptions` | file: src/engine/transport-types.ts | model: T1-lite
  - Ref: .dev/planning/modules/transport/interfaces.md @ Phase-2 contracts (the unified bus + layers — D-036)
  - Ref: .dev/planning/modules/transport/interfaces.md @ Construction (TransportOptions: layerScheduler, createMixer, createVoice with VoiceOptions)
  - Ref: .dev/planning/modules/transport/design.md @ §19.5 Layer nodes + the injected scheduleLayers
  - Ref: .dev/planning/modules/transport/edge-cases.md @ K5 (no layers / layerScheduler not injected — optional)
  - Ref: C:/Projects/BinauralAudio/.dev/planning/phase2-audio-architecture.md @ §6 Cross-Module Contract Spine (createMixer / createLayerNode / scheduleLayers / VoiceOptions.master — VERBATIM)
  - Ref: C:/Projects/BinauralAudio/.dev/planning/phase2-audio-architecture.md @ §2.2 transport-types.ts (add layerScheduler to TransportOptions)
  - Accepts: nothing (declarations only); type-only imports of `Layer` from session-model, `VoiceOptions` from audio-engine, `Mixer`/`DuckSpan` from mixer, `LayerNode` from layer-engine.
  - Creates: type-only re-imports of `Mixer`, `LayerNode`, `Layer`; the `LayerSchedule` interface (`retarget(layers, atCtx?)`/`cancel()`/`dispose()`) and the `LayerSchedulerFactory` type — both restated VERBATIM from arch §6; three OPTIONAL `TransportOptions` fields: `layerScheduler?: LayerSchedulerFactory`, `createMixer?: (ctx: BaseAudioContext) => Mixer`, and the `createVoice` DI seam widened to `(ctx, opts?: VoiceOptions) => Voice` so `{ master: 'bus' }` is passable. Existing Phase-1 `TransportOptions` fields and `TransportError`/event map/§11 constants are untouched.
  - Behavior: every new field is OPTIONAL (a Phase-1 host that omits them must still compile and run — K5); signatures match arch §6 byte-for-byte (`if they ever diverge, §6 wins`); imports are type-only so transport composes mixer/layer-engine by injection and never hard-imports them.
  - Ripple: consumers of `TransportOptions` (the ui composition root, transport.ts). All additions optional → no existing call site breaks. `transport-types.test.ts` must stay green.
  - Tests: `LayerSchedulerFactory` and `LayerSchedule` shapes compile against arch §6; `TransportOptions` with NONE of the new fields still type-checks (Phase-1 host); `TransportOptions` with `layerScheduler`/`createMixer`/`createVoice({master:'bus'})` type-checks; the new imports are type-only (no runtime import of mixer/layer-engine in the emitted module).

- [x] [impl] Compose the unified bus in `startFresh`: createMixer, createVoice({master:'bus'}), rewire voice.output→mixer.bedInput, bind masterCtrl to mixer.masterParam, routeOutput(mixer) | file: src/engine/transport.ts | model: T1 [availability]
  - Ref: .dev/planning/modules/transport/design.md @ §19.1 What changes and what does not
  - Ref: .dev/planning/modules/transport/design.md @ §19.2 startFresh — compose the bus and bind the controller
  - Ref: .dev/planning/modules/transport/design.md @ §6 play() — the start sequence (the in-gesture createVoice/route/schedule block this refactors)
  - Ref: .dev/planning/modules/transport/edge-cases.md @ K1 (double-attenuation guard — master:'bus')
  - Ref: .dev/planning/modules/transport/edge-cases.md @ K5 (mixer always composed even with no layers)
  - Ref: C:/Projects/BinauralAudio/.dev/planning/phase2-audio-architecture.md @ §1 The Unified Bus Topology (single-fan-in, single-input master, master constructed at 0)
  - Ref: C:/Projects/BinauralAudio/.dev/planning/phase2-audio-architecture.md @ §2.2 transport.ts — startFresh (~824-827)
  - Ref: C:/Projects/BinauralAudio/.dev/planning/phase2-audio-architecture.md @ §2.1 audio-engine master flag (why the voice no longer self-attenuates)
  - Accepts: the loaded `preset`; `createVoiceFn`/`createMixer` DI seams (transport-types from the prereq); the existing routing/ramp primitives; `c = ctx`.
  - Creates: in `startFresh` (~824-827), in this fixed order so `master` always has exactly one upstream — (1) `const v = createVoiceFn(c, { master: 'bus' })`; (2) `const mixer = createMixer(c)` held in a per-session `let` (default `(ctx) => createMixerImpl(ctx)`, overridable for tests; nulled on teardown); (3) `try { v.output.disconnect(c.destination); } catch {}` (drop the voice's default destination edge — mirrors the existing mediastream rewire); (4) `v.output.connect(mixer.bedInput)` (the voice joins the BED sub-bus); (5) `masterCtrl = createMasterGainController(mixer.masterParam, () => c.currentTime)` (the controller now binds the bus master param — analytic discipline §4 unchanged); (6) `routeOutput(mixer)`.
  - Behavior: voice created with `{ master: 'bus' }` so its internal `masterGain` is a unity passthrough and the bus master is the only master (no double-attenuation, K1); `mixer.master` constructed at 0, so `rampMaster(trim, fadeInSec)` is the same click-free `0 → trim` start fade (D-008 moves from voice DEFAULT_MASTER=0 to mixer.master at 0 — equivalent); the mixer is composed REGARDLESS of layers (binaural voice always rides bedInput — K5). Lifecycle (§2/§5-§7/§12-§17) untouched.
  - Handles: the `try/catch` around the destination disconnect (edge may already be absent); `createMasterGainController` binding any `AudioParam` (param-agnostic — arch §2.3) so only the param identity changed.
  - Ripple: `routeOutput`/`playBridgeElement`/`liftTarget`/`teardown` now operate against `mixer` (handed off to the next tasks). `transport-master-gain.ts` is NOT edited (comment-only at most) — its test must stay green.
  - Tests: a session start builds the voice with `{ master: 'bus' }` (DI seam observes the opts); `voice.output` is disconnected from `ctx.destination` then connected to `mixer.bedInput` (the voice no longer connects to the destination directly); `createMasterGainController` is constructed with `mixer.masterParam`; `mixer.master` begins at 0 and the start fade ramps `0 → trim` linearly (no exponential/curve op); K5 — a preset with no `layers` still composes the mixer and routes voice→bedInput→…→master; K1 — in bus mode the voice's `masterGain.gain === 1` and `setMasterGain` is a no-op while non-finite still throws. Full suite green before & after.

- [x] [impl] Retarget routing to `mixer.master` and ride the lift on `mixer.liftInput`: routeOutput/playBridgeElement move only mixer.master, liftTarget→mixer.liftInput, disposeLift keeps only the mid-session enable/disable fade | file: src/engine/transport.ts | model: T1 [availability]
  - Ref: .dev/planning/modules/transport/design.md @ §19.3 routeOutput / playBridgeElement move only mixer.master
  - Ref: .dev/planning/modules/transport/design.md @ §19.4 The Shepard lift rides the bus (liftInput, post-duck)
  - Ref: .dev/planning/modules/transport/design.md @ §8 Output routing & the background-audio bridge (the routing logic being retargeted)
  - Ref: .dev/planning/modules/transport/edge-cases.md @ K2 (routing test retarget — move only mixer.master)
  - Ref: .dev/planning/modules/transport/edge-cases.md @ K3 (single audible path — mixer.master.connections length 1)
  - Ref: .dev/planning/modules/transport/edge-cases.md @ K4 (lift control retarget — liftInput, keep mid-session setLift(null) self-fade)
  - Ref: C:/Projects/BinauralAudio/.dev/planning/phase2-audio-architecture.md @ §1 (single-input-master invariant; lift is a post-duck overlay)
  - Ref: C:/Projects/BinauralAudio/.dev/planning/phase2-audio-architecture.md @ §2.2 transport.ts — routeOutput (369-404) / playBridgeElement (415-438) / liftTarget (452-454) / disposeLift (529-561)
  - Ref: C:/Projects/BinauralAudio/.dev/planning/phase2-audio-architecture.md @ §4 Ducking (lift is post-duck, never pumped)
  - Accepts: the per-session `mixer` (from the prior task); the existing `msDest`/`<audio>`/`liftGain` machinery; `backgroundAudioMode`.
  - Creates: `routeOutput` operating on `mixer` — the mediastream branch moves `mixer.master` between `ctx.destination` and `msDest` (default: `mixer.master.connect(ctx.destination)`, the voice's destination edge already dropped in startFresh); the `none`/`silent-file` branches connect/reference `mixer.master`. `playBridgeElement` (iOS `<audio>` fallback) moves ONLY `mixer.master` between destinations, with the old `liftGain` rewire block (lines 423-430) DELETED. `liftTarget` returns `mixer.liftInput` (`applyLift` connects the aux `liftGain` there via the existing `g.connect(target)`). `disposeLift` DROPS the teardown self-fade (the bus master fade-out covers the in-bus lift on `teardown(true)`) but KEEPS the aux `liftGain` fade for mid-session enable/disable (`setLift(null)` still ramps the aux gain linearly to 0 and disconnects it).
  - Behavior: `mixer.master` is the single node with one upstream (`busSum`), so `connect`/`disconnect` move exactly one edge (single-input-master invariant — K3); the lift joins `busSum` downstream of `duckGain` so master fade/trim/teardown cover it but the bed duck never pumps it (K4, reconciles D-026); no doubling because the voice's destination edge was dropped in startFresh.
  - Handles: the deleted `playBridgeElement` lift rewire (lift now follows `mixer.master` automatically via `liftInput` and must NOT be rewired separately — K4); teardown no longer self-fades the lift, mid-session disable still does.
  - Ripple: `transport.test.ts` routing assertions (~822-836) and the lift/`setLift` assertions are retargeted in the test task below (K2/K3/K4). No other consumer affected (routing is internal).
  - Tests: K2 — mediastream resolve/reject, silent-file, none, and the iOS `playBridgeElement` fallback all move ONLY `mixer.master` between `ctx.destination` and `msDest`; K3 — exactly one audible path: `mixer.master` has one upstream and one downstream destination (length 1), the voice has no direct destination edge; K4 — the aux `liftGain` connects to `mixer.liftInput`; on `teardown(true)` the lift is NOT self-faded (covered by the bus master fade) but on mid-session `setLift(null)` the aux gain still ramps linearly to 0 and disconnects (`lastRampTarget(aux.gain,'linear') === 0`, `aux.disconnectCalls > 0`); D1/D2/D3/D6 routing behaviors still hold with the bus. Full suite green before & after.

- [x] [impl] Drive the injected `scheduleLayers`: build LayerNodes by kind, schedule alongside scheduler.apply/retarget, dispose+rebuild layer nodes on seek, retarget on reapply | file: src/engine/transport.ts | model: T1
  - Ref: .dev/planning/modules/transport/design.md @ §19.5 Layer nodes + the injected scheduleLayers
  - Ref: .dev/planning/modules/transport/design.md @ §9 Orchestrating automation through an injected SessionScheduler (the apply/retarget/cancel ordering layers ride alongside)
  - Ref: .dev/planning/modules/transport/design.md @ §8.3 seek(t) — the only operation that re-schedules (one-shot sources rebuild)
  - Ref: .dev/planning/modules/transport/design.md @ §10 reapply() — live-edit entry point (keep running nodes, no rebuild)
  - Ref: .dev/planning/modules/transport/interfaces.md @ Phase-2 contracts (LayerSchedule / LayerSchedulerFactory / createLayerNode / scheduleLayers)
  - Ref: .dev/planning/modules/transport/edge-cases.md @ K5 (no layers / layerScheduler absent — build none, schedule none)
  - Ref: .dev/planning/modules/transport/edge-cases.md @ K6 (seek with active layers — dispose+rebuild; reapply keeps running nodes)
  - Ref: .dev/planning/modules/transport/edge-cases.md @ K8 (duck is single-writer / coalesced in layer-scheduler — NOT transport's concern)
  - Ref: C:/Projects/BinauralAudio/.dev/planning/phase2-audio-architecture.md @ §6 Cross-Module Contract Spine (scheduleLayers signature / layer-engine createLayerNode / connect by kind)
  - Ref: C:/Projects/BinauralAudio/.dev/planning/phase2-audio-architecture.md @ §2.2 transport.ts — startFresh / seekWhilePlaying / reapply (build LayerNodes, call scheduleLayers)
  - Ref: C:/Projects/BinauralAudio/.dev/planning/phase2-audio-architecture.md @ §4 Ducking (cue layers → cueInput, never duck themselves; transport never writes duckParam)
  - Accepts: the injected `layerScheduler?: LayerSchedulerFactory` (from TransportOptions); the per-session `mixer`; `preset.layers`; `createLayerNode` (Layer-0); the existing `scheduler.apply`/`retarget` calls in startFresh/seekWhilePlaying/reapply; `t0`/`startOffsetSec`.
  - Creates: a per-session `LayerNode[]` and a per-session `LayerSchedule | null`. In `startFresh`: for each `preset.layers` entry, `createLayerNode(ctx, layer, buffer?)`, connect its `output` to `mixer.bedInput` for `kind 'tone'|'ambiance'` or `mixer.cueInput` for `kind 'voice'`, then call `layerScheduler(mixer, nodes, layers, { t0, startOffsetSec })` RIGHT AFTER `scheduler.apply`, storing the returned `LayerSchedule`. In `seekWhilePlaying`: DISPOSE the current `LayerSchedule` + `LayerNode`s, build FRESH nodes from `preset.layers`, reconnect by kind, and call `scheduleLayers(… { t0, startOffsetSec: t })` from the new offset under the existing `seekFade` window. In `reapply`: call `LayerSchedule.retarget(preset.layers, atCtx?)` (keep running nodes — the layer analogue of §10's modulator-phase rule), NOT a rebuild.
  - Behavior: layers ride ALONGSIDE the binaural scheduler (the `scheduler.apply`/`retarget`/`cancel` calls are unchanged — layers are additive); voice-kind cue layers route to `cueInput` (downstream of `duckGain`) so a cue never ducks itself (K8); the layer scheduler computes voice-kind duck spans and calls `mixer.scheduleDuck` itself — transport NEVER touches the duck (single-writer D-019, K8); one-shot layer sources cannot restart, so seek disposes+rebuilds (mirrors the fresh-voice-on-stop and the binaural modulator rebuild of §8.3) — looping ambiance and one-shot tone/voice restart cleanly at the new offset under the seekFade.
  - Handles: K5 — when `layerScheduler` is absent OR `preset.layers` is empty, build NO LayerNodes and call NO scheduleLayers (the mixer is still composed; routing/master/teardown uniform); the `LayerSchedule` stays null; the stale-`seekToken` abort already guarding the binaural seek also guards the layer rebuild (rapid seeks → only the latest completes).
  - Ripple: `teardown` must dispose the new per-session `LayerSchedule` + `LayerNode`s (handed to the teardown task). No consumer outside transport — layers are driven internally via the injected factory.
  - Tests: with `layerScheduler` injected and a preset carrying tone/ambiance/voice layers — `createLayerNode` is called per layer, tone/ambiance connect to `mixer.bedInput`, voice connects to `mixer.cueInput`, and `scheduleLayers(mixer, nodes, layers, { t0, startOffsetSec })` is called right after `scheduler.apply` with the matching `t0`/offset; K6 — a seek while playing disposes the prior `LayerSchedule`+nodes, rebuilds fresh nodes, and calls `scheduleLayers` with `startOffsetSec: t`; reapply calls `LayerSchedule.retarget` and does NOT dispose/rebuild nodes (running-node continuity); A10 — rapid seeks only complete the latest `seekToken`'s rebuild; K5 — no `layerScheduler` (and/or empty `layers`) builds no nodes and calls no scheduleLayers but still composes the mixer; K8 — transport never calls anything that writes `duckParam`. Full suite green before & after.

- [x] [impl] Teardown disposes the bus: LayerSchedule.dispose + LayerNode disposal + mixer.dispose after the single bus master fade-out, nulling the per-session mixer var | file: src/engine/transport.ts | model: T1 [availability]
  - Ref: .dev/planning/modules/transport/design.md @ §19.6 Teardown disposes the mixer
  - Ref: .dev/planning/modules/transport/design.md @ §13 The tick loop and end-of-session (shared teardown(fade))
  - Ref: .dev/planning/modules/transport/design.md @ §17 Teardown — destroy()
  - Ref: .dev/planning/modules/transport/edge-cases.md @ K7 (teardown with a live mixer + layers — fade the SUM, then dispose schedule/nodes/mixer)
  - Ref: .dev/planning/modules/transport/edge-cases.md @ J. Resource lifecycle (context stays open; idempotent destroy)
  - Ref: C:/Projects/BinauralAudio/.dev/planning/phase2-audio-architecture.md @ §2.2 transport.ts — teardown (716-759): add mixer.dispose() in finish() after the fade; null the per-session mixer var
  - Ref: C:/Projects/BinauralAudio/.dev/planning/phase2-audio-architecture.md @ §1 (master fade covers voice + all layers + post-duck lift — one master, one fade)
  - Accepts: the per-session `mixer`, `LayerSchedule | null`, and `LayerNode[]` from the prior tasks; the existing shared `teardown(fade)` and `finish()`; `mc.rampMaster(0, fadeSec)`.
  - Creates: in the shared teardown's `finish()` (after `mc.rampMaster(0, fadeSec)` completes and alongside `v.dispose()`) — `LayerSchedule?.dispose()` (if one exists), dispose each `LayerNode`, then `mixer.dispose()`, then NULL the per-session mixer / LayerSchedule / LayerNode references.
  - Behavior: the `rampMaster(0, fadeSec)` fade-out now fades the bus SUM (voice + every layer + the post-duck lift) to silence in ONE ramp before disposal — one master, one fade, no per-source teardown fades (this is why disposeLift dropped its teardown self-fade in the routing task); the `AudioContext` STAYS OPEN for reuse (only the per-session bus is torn down — J unchanged); ordering is fade → cancel/stop/dispose so disposal happens at silence.
  - Handles: `LayerSchedule` may be null (no layers — K5) → skip its dispose; `mixer.dispose()` is the last per-session step; `destroy()` runs `teardown(false)` (no fade) then `ctx.close()` and stays idempotent (J2) — a second teardown finds the mixer var already nulled and no-ops.
  - Ripple: none outside transport — teardown is internal. Confirms K7 closes the lifecycle opened by startFresh.
  - Tests: K7 — on `teardown(true)` (stop/end) the bus master fades `trim → 0` in one ramp, THEN `LayerSchedule.dispose()`, each `LayerNode.dispose()`, and `mixer.dispose()` are called, and the per-session mixer/schedule/nodes refs are nulled; the `AudioContext` is NOT closed by teardown (stays open, J1 reuse across play→stop cycles); `destroy()` runs `teardown(false)` then closes the context and is idempotent (J2 — second call no-ops, J3 — destroy while playing tears down + closes); with no layers (K5) teardown skips the LayerSchedule dispose and still disposes voice + mixer. Full suite green before & after.

- [x] [test] Retarget transport.test.ts routing + lift assertions from voice.output to mixer.master / mixer.liftInput per the arch test-retargets | file: src/engine/transport.test.ts | model: T1-lite
  - Ref: C:/Projects/BinauralAudio/.dev/planning/phase2-audio-architecture.md @ Test retargets (existing files) — transport.test.ts routing ~822-836 → mixer.master; D3 single-audible-path → mixer.master.connections length 1; lift-control → mixer.liftInput, bus master fade on teardown, still self-fades on mid-session setLift(null)
  - Ref: .dev/planning/modules/transport/edge-cases.md @ K2 (routing assertions → mixer.master)
  - Ref: .dev/planning/modules/transport/edge-cases.md @ K3 (single audible path → mixer.master.connections length 1)
  - Ref: .dev/planning/modules/transport/edge-cases.md @ K4 (lift → mixer.liftInput; teardown covered by bus fade; mid-session setLift(null) still self-fades)
  - Ref: .dev/planning/modules/transport/edge-cases.md @ K1 (bus-mode voice masterGain.gain === 1, setMasterGain no-op)
  - Ref: .dev/testing-standards.md — test conventions and rules
  - Accepts: the existing `transport.test.ts` routing/lift/D-series cases (the only existing test file edited — `automation.test.ts`/`audio-engine.test.ts`/`transport-master-gain.test.ts` stay byte-identical).
  - Creates: updated assertions — the routing block (~822-836) asserts on `mixer.master` (mediastream/silent-file/none + iOS `playBridgeElement` fallback move ONLY `mixer.master` between `ctx.destination` and `msDest`); the D3 single-audible-path assertion becomes `mixer.master.connections` length 1 with no direct `voice.output → ctx.destination` edge; the lift-control case asserts the aux `liftGain` connects to `mixer.liftInput`, is covered by the bus master fade on `teardown(true)` (no lift self-fade), and STILL self-fades on mid-session `setLift(null)` (`lastRampTarget(aux.gain,'linear') === 0`, `aux.disconnectCalls > 0`); one bus-mode assertion that the voice is created `{ master: 'bus' }` with `voice.masterGain.gain === 1` and `setMasterGain` a no-op (non-finite still throws — K1).
  - Behavior: only `transport.test.ts` changes; the fake mixer/layer-engine/layer-scheduler used here mirror the injected DI seams; happy + error + edge are all covered (routing happy path, reject fallback, lift disable error path, single-path edge).
  - Tests: this IS the test task — it must (a) cover the happy path (mediastream resolve → mixer.master is the sole audible edge), (b) the error path (mediastream reject → mixer.master reconnects direct + BACKGROUND_AUDIO_UNAVAILABLE), and (c) the edge (mid-session setLift(null) self-fade vs teardown bus-fade; K5 no-layers routing uniform). After this task the FULL suite is green and the three guardrail suites are byte-identical to their pre-feature state.

- [x] [audit] Module behavioral audit: mixer bus + layers (Phase 2) | file: .dev/.task-state/transport/behavioral-audit-phase2-bus.md | model: T1
  - Ref: C:/Projects/.dev-shared/behavioral-audit.md — Module Behavioral Audit checklist
  - Ref: .dev/planning/modules/transport/interfaces.md @ Phase-2 contracts (createMixer / createLayerNode / scheduleLayers / LayerSchedulerFactory / VoiceOptions.master) and @ Construction (layerScheduler / createMixer / createVoice options)
  - Ref: .dev/planning/modules/transport/design.md @ §19 Phase-2 refactor (§19.1–§19.7)
  - Ref: .dev/planning/modules/transport/edge-cases.md @ K. Phase-2 unified bus + layers (K1–K8)
  - Ref: C:/Projects/BinauralAudio/.dev/planning/phase2-audio-architecture.md @ §1 / §2.2 / §4 / §6 (the authoritative contract spine)
  - For each Phase-2 contract: trace input → implementation → observable output — `startFresh` composes `createMixer` + `createVoice({master:'bus'})` + `voice.output → mixer.bedInput` + `masterCtrl(mixer.masterParam)` + `routeOutput(mixer)`; `routeOutput`/`playBridgeElement` move ONLY `mixer.master`; the lift rides `mixer.liftInput` and `disposeLift` keeps only the mid-session fade; `scheduleLayers` is driven alongside `scheduler.apply/retarget` with layers connected by kind (bed/cue); seek disposes+rebuilds layer nodes; reapply retargets; teardown disposes `LayerSchedule`+nodes+`mixer` after one bus master fade.
  - Verify every K-case (K1–K8) has evidence of handling in the code, and that the invariants hold: master constructed at 0 (D-008), only transport-master-gain writes masterParam and only mixer.scheduleDuck writes duckParam (D-019), transport never reads `param.value`, the mixer is composed even with no layers (K5), and no double-attenuation (bus-mode masterGain.gain === 1, K1).
  - Verify the cohesion guardrails: `automation.test.ts` / `audio-engine.test.ts` / `transport-master-gain.test.ts` are byte-identical to pre-feature and green; only `transport.test.ts` changed; the full suite is green.
  - Confirm no consumer (ui composition root) is broken: the new `TransportOptions` fields are all optional (Phase-1 host still compiles — K5).
  - Write findings to .dev/.task-state/transport/behavioral-audit-phase2-bus.md; PASS required before this feature is considered complete.

## Cleanup (Phase 2)

- [x] [cleanup] Fix: transport double-starts every layer source — remove the redundant node-start loop in `scheduleLayersFor` | file: src/engine/transport.ts | model: T1
  - Ref: behavioral audit 2026-06-16 (.dev/.task-state/transport/behavioral-audit-phase2-bus.md) — CRITICAL.
  - The injected `scheduleLayers` (production: `bootstrap.ts` → `createLayerScheduler()` → engine `scheduleLayers`) ALREADY starts each in-range source (`startSources: true`, layer-scheduler.ts:316-325). Transport's own loop at transport.ts:640-645 then calls `node.start()` again → `LayerNodeError('ALREADY_STARTED')` (layer-engine.ts:194-198) on every in-range node, swallowed by the `void scheduleLayersFor(...)` at transport.ts:999/1124. On seek it also erroneously starts out-of-range one-shots that `scheduleLayers` correctly skips.
  - Fix: delete the `for (const node of nodes) { … node.start(at); }` loop in `scheduleLayersFor` (transport.ts:640-645). `scheduleLayers` owns source-starting — match the renderer, which starts only the voice and comments "scheduleLayers already started layer sources" (renderer.ts:611-614).
  - Add a test that wires the REAL `scheduleLayers` (or `createLayerScheduler()`) into transport with a layered preset and asserts start/seek do NOT throw and out-of-range one-shots are not replayed — the current transport.test.ts fake (`makeFakeLayerScheduler`, transport.test.ts:298) never starts sources and masks this. Full suite green after.

- [x] [cleanup] Fix: stale stub-registry entry for the ui layerScheduler wiring | file: .dev/.task-state/stub-registry.md | model: T1-lite
  - Ref: behavioral audit 2026-06-16 — NOTE.
  - `bootstrap.ts:74,83` already injects `createLayerScheduler()` into `createTransport`; move the "layerScheduler factory passed to createTransport" row from Active Stubs to Resolved Stubs.
