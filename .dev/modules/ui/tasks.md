# Tasks: ui
# Planning: .dev/planning/modules/ui/
# Architecture: .dev/architecture.md
# Standards: safety
# Stack: typescript

## Agent Briefing
The `ui` module is BinauralAudio's mobile-first Svelte 5 (runes) PWA shell: a big
tap-to-play transport, live parameter controls, a preset library, PWA install/update
affordances, a cross-cutting notice/banner system, and (Phase 2) an imperative canvas
timeline node editor. It owns no audio — every sound-affecting action is either a
control call on `transport` or an edit to a plain `Preset` object the engine re-derives
into automation; the framework never touches the audio data path (the one inviolable
rule). It depends only on the public interfaces of the engine modules `transport`,
`automation`, `persistence`, and `session-model`; nothing in the engine imports `ui`
(Layer 2, top) and the end user is the only consumer.

## References
- .dev/planning/modules/ui/design.md
- .dev/planning/modules/ui/interfaces.md
- .dev/planning/modules/ui/edge-cases.md
- .dev/planning/modules/ui/dependencies.md
- .dev/knowledge/web-audio/mobile-audio-lifecycle.md
- .dev/knowledge/web-audio/pwa-setup.md
- .dev/planning/system-design.md (§3 parameter model, §6 patterns)

## Dependencies
Must be complete before this module starts (consumed via their interfaces only):
- `session-model` (Layer 0) — Preset/TimeNode/ParamPoint/Waveform/AutomatableParam types; createDefaultPreset, sortNodes, RANGES, LIMITS, DEFAULTS.
- `automation` (Layer 1) — scheduleAll/waveformKeyframes/SessionSchedule (adapter only); valueAt/baseValueAt (pure reads).
- `transport` (Layer 1) — createTransport + the Transport control surface and event payloads; consumes the SessionScheduler this module produces.
- `persistence` (Layer 1) — listPresets/loadPreset/savePreset/deletePreset/clearLibrary/seedDefaultPresets/exportPreset/importPresetFromFile + error/summary types.
- `pwa-shell` (Config) — app icons (MediaSession `artwork`) and the `virtual:pwa-register` SW glue the UI consumes (stub defaults stand in until then).
- Runtime: Svelte 5. Build: Vite + @sveltejs/vite-plugin-svelte + vite-plugin-pwa (registerType: 'prompt').

## Tasks

- [x] [impl] Build the UI primitives — behavioral constants, control specs (from session-model RANGES), and pure formatters | file: src/ui/lib/controls.ts | model: T2
  - Ref: .dev/planning/modules/ui/design.md @ §6 Live parameter controls (control bounds)
  - Ref: .dev/planning/modules/ui/design.md @ §14 Constants (single source of truth)
  - Ref: .dev/planning/modules/ui/interfaces.md @ §8 Control specs + formatters
  - Ref: .dev/planning/modules/ui/edge-cases.md @ B2 (typed value out of range)
  - Accepts: session-model RANGES/LIMITS/DEFAULTS (carrier/beat/volume/masterGain bounds); raw numbers and epochMs for the formatters
  - Creates: src/ui/lib/constants.ts (WIDE_BREAKPOINT_PX, MIN_TAP_TARGET_PX, PLAY_BUTTON_DIAMETER_PX, WARNING_AUTODISMISS_MS, NOTICE_MAX_VISIBLE, NODE_HIT_RADIUS_PX, CURVE_SAMPLE_PX, MIN_NODE_DT_SEC, EDITOR_MIN_VIEW_SEC); src/ui/lib/controls.ts (`CONTROL: Record<'carrier'|'beat'|'volume'|'masterGain', ControlSpec>` derived from RANGES); src/ui/lib/format.ts (formatClock/formatHz/formatPercent/formatAgo — pure)
  - Tests: happy — formatClock(754)==="12:34", formatHz(8)==="8.0 Hz", formatPercent(0.8)==="80 %", CONTROL.carrier==={min:20,max:1000,step:1,unit:'Hz'}; edge — formatAgo boundaries (just-now/minutes/days), clock for 0 and >1h; error — non-finite/negative inputs render safely; constants exactly match §14 values

- [x] [impl] Implement the notices store (Notice model + transport-notice mapping) and the ui store (tab / breakpoint / headphone / scrubbing flags) | file: src/ui/stores/notices.svelte.ts | model: T2
  - Ref: .dev/planning/modules/ui/design.md @ §10 Notices / banners (the source-signal → notice mapping table)
  - Ref: .dev/planning/modules/ui/design.md @ §8 Headphone reminder; §13 Responsive layout (isWide breakpoint)
  - Ref: .dev/planning/modules/ui/interfaces.md @ §5 Notice store; §7 UI store
  - Ref: .dev/planning/modules/ui/edge-cases.md @ F (transport runtime notices), F8 (banner flood/dedupe/cap), I4 (scrubbing suppresses tick)
  - Accepts: Omit<Notice,'id'> on push; (TransportNotice, severity) on fromTransport; Tab/boolean setters on the ui store
  - Creates: NoticeStore (items ≤ NOTICE_MAX_VISIBLE; push/dismiss/clear/fromTransport with dedupeKey + auto-dismiss); UiStore (tab, isWide via matchMedia(720), headphoneReminderSeen in-memory, scrubbing)
  - Tests: happy — push returns an id and renders; fromTransport maps each §10 code to the correct severity/message/action/dedupeKey; edge — dedupeKey 'ctx' replaces the interrupt banner with recover; cap drops the oldest non-error beyond 3; warnings auto-dismiss after WARNING_AUTODISMISS_MS while errors persist; ui isWide tracks matchMedia, headphoneReminderSeen re-shows once per app open

- [x] [impl] [availability] Implement the playback store (transport state/position mirror + control methods) and the session store (plain working preset + revision + edit ops + applyLiveEdit) | file: src/ui/stores/session.svelte.ts | model: T2
  - Ref: .dev/planning/modules/ui/design.md @ §3 State ownership and the single source of truth (plain preset + $state revision)
  - Ref: .dev/planning/modules/ui/design.md @ §5 The play gesture (state→button table); §6 Live parameter controls (§6.1–§6.3 commit model + applyLiveEdit)
  - Ref: .dev/planning/modules/ui/interfaces.md @ §2 Session store; §3 Playback store
  - Ref: .dev/planning/modules/ui/edge-cases.md @ A (autoplay/gesture), B (live edits/controls), C (position/scrubber), I1/I2 (audio-path purity)
  - Ref: .dev/knowledge/web-audio/mobile-audio-lifecycle.md (the gesture chain: play() must not be awaited behind anything)
  - Accepts: deps {transport, notices} / {transport, playback}; param edits (AutomatableParam, value), waveform, name, masterGain, and the Phase-2 node ops; transport 'tick'/'statechange'/'ended'/'error'/'warning' events
  - Creates: PlaybackStore (state/positionSec/durationSec/canPlay mirrors; play/pause/stop/seek/setKeepScreenOn — gesture-safe, no await before the transport call); SessionStore (plain preset + $state revision, dirty, selectedId; reset/setNodeParam/setWaveform/setName/setMasterGain/applyLiveEdit + Phase-2 node ops; clamps to RANGES)
  - Tests: happy — setNodeParam clamps + bumps revision + sets dirty + calls applyLiveEdit; setMasterGain calls transport.setMasterTrim AND writes preset.masterGain with NO reschedule; applyLiveEdit seeks only when playing/paused/interrupted; play() mirrors statechange; edge — out-of-range/NaN typed values clamp/revert (never write non-finite); edits while paused take effect on resume; preset stays a plain (non-$state) object — structuredClone-safe; error — WEB_AUDIO_UNSUPPORTED sets canPlay=false; a transport throw is caught at the store boundary → notice, no crash

- [x] [impl] [data] Implement the library store (persistence wrappers + dirty tracking + error→notice mapping) and the install store (PWA install capture + SW update hooks) | file: src/ui/stores/library.svelte.ts | model: T2
  - Ref: .dev/planning/modules/ui/design.md @ §7 Preset library (persistence)
  - Ref: .dev/planning/modules/ui/design.md @ §9 PWA install affordances and the update toast
  - Ref: .dev/planning/modules/ui/interfaces.md @ §4 Library store; §6 Install store
  - Ref: .dev/planning/modules/ui/edge-cases.md @ E (persistence faults), H (PWA install / service worker)
  - Ref: .dev/knowledge/web-audio/pwa-setup.md (registerType:'prompt', iOS Add-to-Home-Screen, standalone detection)
  - Accepts: deps {session, notices}; persistence results (PresetSummary[]/SavedPreset/ImportedPreset/PersistenceError); BeforeInstallPromptEvent; SwUpdateHooks (onNeedRefresh/onOfflineReady)
  - Creates: LibraryStore (items/loading; refresh/seed/open/saveCurrent/saveAsNew/remove/exportCurrent/importFromFile; PersistenceError.code→Notice per §10, IMPORT_CANCELLED ignored, STORAGE_CORRUPT→"Reset library" action; dirty + confirm-on-discard); InstallStore + hooks (canInstall/isStandalone/isIos/updateReady/offlineReady; promptInstall/applyUpdate/dismissUpdate; reload only on click)
  - Tests: happy — refresh exposes the sorted items, open→session.reset, saveCurrent→refresh; export/import invoked directly in a gesture; edge — loadPreset null→info notice + refresh; import migratedFrom→toast + unsaved; STORAGE_CORRUPT→Reset action clears+seeds+refreshes; error — QUOTA_EXCEEDED / INVALID_PRESET surface friendly copy listing issues; install — beforeinstallprompt captured and single-use, isStandalone hides affordances, updateReady never auto-reloads

- [x] [integration] [availability] Build the scheduler adapter bridging automation.scheduleAll/waveformKeyframes to transport.SessionScheduler {apply,cancel} — resolves the registered stub | file: src/ui/composition/scheduler-adapter.ts | model: T1-lite
  - Ref: .dev/planning/modules/ui/design.md @ §11 The scheduler adapter (composition/scheduler-adapter.ts)
  - Ref: .dev/planning/modules/ui/interfaces.md @ §1 Composition root + scheduler adapter (the cross-module contract)
  - Ref: .dev/planning/modules/ui/edge-cases.md @ B8 (waveform changed live), D (no-click/AudioParam quirks live in transport, not the adapter)
  - Ref: .dev/.task-state/stub-registry.md — resolves "SessionScheduler adapter passed to createTransport" (src/ui composition root)
  - Accepts: apply(voice, preset, fromSec, atCtxTime, { pulseAvailable }): void; cancel(voice): void
  - Creates: createSchedulerAdapter(): SessionScheduler — stores the SessionSchedule per Voice in a WeakMap; applies the waveform in effect at fromSec via voice.setWaveform and arms a setTimeout per later keyframe; forwards pulseUnavailable advisories; cancel clears the waveform timers, calls schedule.dispose() WITHOUT stopping the oscillators, drops the WeakMap entry; never calls voice.start/voice.stop
  - Tests: happy — apply calls scheduleAll with { startTime:atCtxTime, startOffsetSec:fromSec } and stores the schedule; the waveform at fromSec applies immediately and later keyframes fire at the computed offsets; cancel disposes + clears timers + leaves the voice running; edge — multi-keyframe timer cleanup, re-apply after cancel, missing-worklet (pulseAvailable=false) passes through without throwing; resource — no timer leak across apply/cancel cycles

- [x] [integration] Wire the composition root — bootstrap (adapter→transport→stores→seed→working preset→registerSW→mount) and prime()/listeners on App mount | file: src/ui/main.ts | model: T1-lite
  - Ref: .dev/planning/modules/ui/design.md @ §4 Module layout and the composition root (the fixed boot order)
  - Ref: .dev/planning/modules/ui/design.md @ §5 The play gesture, priming, and autoplay (prime early, off-gesture)
  - Ref: .dev/planning/modules/ui/interfaces.md @ §1 (bootstrap / AppContext); §10 Usage example (how main.ts wires it all)
  - Ref: .dev/planning/modules/ui/edge-cases.md @ A5 (no non-gesture start path), I5 (idempotent bootstrap / HMR), K2 (no pre-init window)
  - Ref: .dev/knowledge/web-audio/pwa-setup.md (registerSW prompt mode); .dev/knowledge/web-audio/mobile-audio-lifecycle.md (prime creates a suspended, autoplay-safe context)
  - Accepts: optional target HTMLElement
  - Creates: src/ui/composition/bootstrap.ts + src/ui/main.ts — bootstrap(target?): AppContext that builds createSchedulerAdapter→createTransport({scheduler, artwork, backgroundAudioMode:'mediastream'})→the six stores, calls library.seed(), session.reset(createDefaultPreset()) (+ transport.load), registerSW({immediate, onNeedRefresh, onOfflineReady}), mounts App with the context; on App mount runs transport.prime().catch(...) and attaches the install store's beforeinstallprompt/visibility listeners; a module-level idempotent guard
  - Tests: happy — bootstrap returns the wired AppContext, transport receives the injected scheduler, the library is seeded once, the working preset is set so duration()>0, the SW registers in prompt mode; edge — a double bootstrap()/HMR builds exactly one transport (idempotent guard), a prime() rejection is swallowed (surfaced as a WORKLET_UNAVAILABLE warning), no audio starts outside a gesture

- [x] [ui] Build the app shell, design tokens, and the Phase-1 player UI (transport button, scrubber, param controls, master volume, keep-screen-on, headphone reminder, nav, banners) | file: src/ui/App.svelte | model: T2
  - Ref: .dev/planning/modules/ui/design.md @ §5 (play-button behavior by state); §6 (live controls, commit on release); §8 (headphone reminder); §10 (banner stack); §13 (responsive layout, </≥720)
  - Ref: .dev/planning/modules/ui/design.md @ §1 The one inviolable rule (one-way controls, never bind a $state to the audio)
  - Ref: .dev/planning/modules/ui/interfaces.md @ §9 Key component props
  - Ref: .dev/planning/modules/ui/edge-cases.md @ A (gesture), B (controls), C (scrubber/playhead), I1/I4 (no bind to preset; scrubber may read $state)
  - Ref: .dev/knowledge/web-audio/mobile-audio-lifecycle.md (the click handler calls play() first, no await); .dev/knowledge/web-audio/pwa-setup.md (viewport-fit=cover + safe-area insets)
  - Accepts: the AppContext via Svelte context (transport + stores); user pointer/keyboard events
  - Creates: src/ui/App.svelte (nav + active screen + global overlays); src/ui/app.css (tokens/reset/safe-area insets, dark theme); src/ui/screens/PlayerScreen.svelte; src/ui/components/{TransportButton,Scrubber,ParamControl,WaveformPicker,MasterVolume,KeepScreenOnToggle,HeadphoneReminder,NavBar,BannerStack}.svelte
  - Tests: happy — the primary button's label/action follow the playback.state table; ParamControl oninput updates the display only while oncommit calls session.setNodeParam (reschedules); master volume streams via setMasterGain; edge — scrubber drag sets ui.scrubbing and ignores tick until release; WEB_AUDIO_UNSUPPORTED disables the button + shows the persistent banner; the headphone banner dismisses (✕ / first play) with the permanent caption remaining; layout switches at 720; purity — no bind:value to the preset (controls are one-way)

- [x] [ui] [data] Build the Library screen (preset list with open/export/delete, header New/Import/Install) and the PWA install/update components | file: src/ui/screens/LibraryScreen.svelte | model: T2
  - Ref: .dev/planning/modules/ui/design.md @ §7 Preset library (list/new/open/save/delete/import/export, dirty confirm)
  - Ref: .dev/planning/modules/ui/design.md @ §9 PWA install affordances and the update toast; §13 (library layout — full-screen list vs persistent rail)
  - Ref: .dev/planning/modules/ui/interfaces.md @ §4 Library store; §6 Install store; §9 (PresetListItem props)
  - Ref: .dev/planning/modules/ui/edge-cases.md @ E (persistence faults surfaced), H (install / SW update / iOS A2HS)
  - Ref: .dev/knowledge/web-audio/pwa-setup.md (beforeinstallprompt button, iOS Add-to-Home-Screen card, never auto-reload)
  - Accepts: library.items (PresetSummary[]) and install-store state; user taps (open/export/delete/new/import/install/reload)
  - Creates: src/ui/screens/LibraryScreen.svelte; src/ui/components/{PresetList,PresetListItem,InstallPrompt,UpdateToast}.svelte
  - Tests: happy — the list renders name/duration(MM:SS)/nodeCount/updated-ago sorted updatedAt-desc; Open→library.open, Export/Import run inside a gesture; New/Open while dirty confirms discard; Delete is behind a confirm; edge — the install button shows only when canInstall, hides when standalone, iOS shows the A2HS card; UpdateToast reloads only on click (no auto-reload); offlineReady is a one-time toast; error — persistence faults render the §10 banner/copy

- [x] [ui] [availability] Build the Phase-2 canvas timeline node editor (imperative renderer + interactions + Node Inspector) | file: src/ui/editor/canvas-renderer.ts | model: T2
  - Ref: .dev/planning/modules/ui/design.md @ §12 Phase-2 canvas timeline node editor (lanes, coordinate mapping, curve drawing, interactions, render loop)
  - Ref: .dev/planning/modules/ui/design.md @ §12.1 Node Inspector — every option editable
  - Ref: .dev/planning/modules/ui/interfaces.md @ §2 (addNode/moveNode/setNodeValue/setNodeTransition/setNodeMod/removeNode + ModPatch)
  - Ref: .dev/planning/modules/ui/edge-cases.md @ J (node editor boundaries), I3/I4 (canvas rendered once; the loop reads transport.position() directly)
  - Accepts: session-store node edits; pointer drag/pan/pinch on the canvas; transport.position() each frame while playing
  - Creates: src/ui/screens/EditorScreen.svelte; src/ui/editor/{TimelineCanvas.svelte, canvas-renderer.ts, interactions.ts, NodeInspector.svelte}; reads automation.baseValueAt/valueAt for the base curve + live combined dot
  - Tests: happy — tap-empty-lane adds a carry-forward node (no sound change) then sortNodes; vertical drag clamps the value to RANGES; horizontal drag keeps ≥ MIN_NODE_DT_SEC from neighbors and pins nodes[0] at t=0; the rAF loop redraws on needsRedraw and every frame while playing, reading transport.position() directly; edge — zoom clamped to [EDITOR_MIN_VIEW_SEC, durationSec], node t>durationSec trimmed on a duration decrease, inspector greys exp through 0 / warns when edgeMs>half-period / round-trips the three-state mod (carry/clear/set); purity — Svelte never re-renders the canvas; resource — the rAF loop is cancelled on unmount

- [x] [ui] Spatial controls (D-021): a Phase-1 "Spatial" control group (position + enable + swing width / cycle seconds / shape) editing nodes[0].spatial, the spatial value lane + param/mod in the Phase-2 node inspector, and the spatial control spec in controls.ts | file: src/ui/components/ParamControl.svelte | model: T2
  - Ref: .dev/planning/modules/ui/design.md @ §2 (live controls incl. spatial); §6 controls table (Spatial pan / sweep rows + the collapsible group note)
  - Ref: .dev/planning/modules/ui/design.md @ §12 lanes (4th spatial lane −1..1); §12.1 Node Inspector (carrier/beat/volume/spatial)
  - Ref: .dev/planning/modules/session-model/interfaces.md @ §7 RANGES.spatial / depthSpatial (control bounds)
  - Ref: .dev/planning/decisions-log.md @ D-021 (cycle authored in seconds; off until enabled; stacks with other modulators)
  - Accepts: nodes[0].spatial edits via session.setNodeParam('spatial', …) + a mod editor (depth/periodSec/shape, on/off); RANGES.spatial/depthSpatial
  - Creates: CONTROL.spatial (+ the sweep sub-specs) in src/ui/lib/controls.ts from RANGES; a grouped, collapsible Spatial section in the Phase-1 player (position slider −1..1 with L/Center/R display; enable toggle; swing width 0..1; cycle 1..60 s; shape sine/triangle/square/pulse) editing nodes[0].spatial, reschedule-on-commit; the spatial value lane in the canvas editor + spatial in the Node Inspector; purity unchanged (one-way; edits mutate the plain preset then applyLiveEdit)
  - Tests: happy — the position slider writes nodes[0].spatial.value (clamped −1..1) + commits a reschedule; enabling the sweep sets nodes[0].spatial.mod (depth/periodSec/shape) and disabling clears it (mod absent); cycle shown in seconds; edge — the group is collapsed/off when spatial is absent; the spatial lane renders in the editor (−1..1) and the inspector round-trips spatial value/transition/mod; purity — no bind:value to the preset

- [x] [audit] Behavioral audit: ui | file: .dev/.task-state/audit-ui.md | model: T1
  - Ref: C:/Projects/.dev-shared/behavioral-audit.md — the Module Behavioral Audit checklist
  - Ref: .dev/planning/modules/ui/interfaces.md — every public store / adapter / bootstrap / component contract must trace input → observable output
  - Ref: .dev/planning/modules/ui/edge-cases.md — verify every documented edge case (A–K) has evidence of handling in the code
  - Verify the module's observable behavior matches its interfaces.md + edge-cases.md; trace each public interface from input to observable output, confirm no consumer reads a wrong field/shape, and check every edge case is handled; write findings + PASS/FAIL to .dev/.task-state/audit-ui.md (PASS required before the module is complete)

## Cleanup

- [x] [cleanup] Reconcile ui contract docs with the shipped surface | file: .dev/planning/modules/ui/interfaces.md | model: T2
  - Ref: behavioral audit 2026-06-15 (.dev/.task-state/audit-ui.md) NOTE-1 — interfaces.md/edge-cases.md/design.md lag the shipped, correct code
  - interfaces.md §2: add `setDuration`, `markSaved`, `markUnsaved`, `clearSelection`
  - interfaces.md §3: add `setLift(opts: LiftOptions | null)` (+ import `LiftOptions` from transport)
  - interfaces.md §8: add the `spatial` key to `CONTROL` (RANGES.spatial-derived); note `parseClock`
  - interfaces.md §9: document `ParamSection`, `ModulationPanel`, `DurationControl`, `LiftControl`
  - interfaces.md §3/§6/§7 (or NOTE-2): record that playback/install/ui factories live in session/library/notices .svelte.ts (consolidated homes)
  - edge-cases.md: add spatial (4th lane, −1..1), the `box`/breath shape, modulator `steps[]`, lift overlay, and duration-edit cases
  - design.md §6/§12.1: cover the spatial group + the unified ParamSection
  - No behavior change — docs only; both gates already green (654 tests / svelte-check 476/0/0)

- [x] [cleanup] Fix stale ui code comments | file: src/ui/editor/canvas-renderer.ts | model: T2
  - Ref: behavioral audit 2026-06-15 NOTE-3 — comments contradict the 4-lane layout
  - canvas-renderer.ts:3,26: "three lanes" / "carrier/beat/volume lanes" → four lanes incl. spatial (PARAM_ORDER)
  - components/ParamSection.svelte:42-44: the comment claims spatial "gets its own pan control" but spatial renders THROUGH ParamSection (CONTROL.spatial exists); correct the comment and consider dropping the `as 'carrier'|'beat'|'volume'` cast on :45

- [x] [cleanup] Spatial L/Center/R pan readout | file: src/ui/components/ParamControl.svelte | model: T2
  - Ref: behavioral audit 2026-06-15 NOTE-4 + ui task "Spatial controls (D-021)" — slider shows a raw number, not the L/Center/R affordance the task described
  - Render the spatial position as L / Center / R (value clamped −1..1); behavior already correct (writes nodes[0].spatial.value + reschedules) — display-only change

## Completion Criteria
- [ ] All tasks above marked [x] — none left [ ] (Pending) or [!] (Needs-Attention)
- [ ] Zero active stubs for `ui` (the SessionScheduler adapter stub is resolved by the scheduler-adapter task)
- [ ] All `ui` module tests passing (full suite, not just the current task's tests)
- [ ] Per-task audit PASS for every task
- [ ] last-step-summary.md written for every task with a concrete Observable Verification entry
- [ ] Behavioral audit PASS
