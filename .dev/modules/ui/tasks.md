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

- [x] [cleanup] Fix: RenderStore.missingClipIds lists ALL referenced clip ids, not the actually-missing ones (false "will render as silence" warning) | file: src/ui/stores/authoring.svelte.ts | model: T2
  - Ref: behavioral audit 2026-06-16 (.dev/.task-state/ui/behavioral-audit-phase2.md) FIX-1 (edge N2)
  - `referencedClipIds()` (authoring.svelte.ts:63-71) has no clip-library presence probe; `render()` assigns the whole referenced set to `missingClipIds` (:106), which RenderSheet.svelte:43-46 renders as "N clip(s) are missing and will render as silence" — a false warning when all clips are present
  - Inject a clip-presence probe into createRenderStore (e.g. `clipLib.list()`/a `hasClip(id)` seam) and filter `missingClipIds` to ids ABSENT from the library; tighten authoring.svelte.test.ts:158 to assert a PRESENT clip is excluded

- [x] [cleanup] Fix: setDuration does not re-clamp existing node/layer t on a duration DECREASE (J5/L4) | file: src/ui/stores/session.svelte.ts | model: T2
  - Ref: behavioral audit 2026-06-16 FIX-2 (edge J5 / L4)
  - setDuration (session.svelte.ts:415-423) clamps only the duration scalar; a node/layer with t > newDuration is left overflowing (currently caught LOUDLY at save via LAYER_T_EXCEEDS_DURATION / NODE_T_EXCEEDS_DURATION → INVALID_PRESET, but not proactively clamped as the edge cases specify)
  - On a duration decrease, clamp node.t / layer.t down to the new durationSec (or block the decrease below the last node's t); add a session-layers test for the shrink case

## Feature: layer authoring + clips + render (Phase 2)

Phase-2 adds four authoring surfaces under the Editor tab family — layer track authoring,
a clip-library panel, Render/Export, and VoiceScript import — built on the **same one
inviolable rule** as Phase 1 (design §1/§16): the framework never touches the audio data
path. Every surface edits the **plain** working `Preset` (`preset.layers`) or calls a pure
async engine entry point inside a gesture; nothing here holds a `Voice`/`Mixer`/`LayerNode`
or writes an `AudioParam` (D-019 single-writer; D-008 no-click stay engine-owned). The new
layer-scheduling contract is injected at the composition root exactly like the Phase-1
`scheduler` (arch §2.2/§6, D-036/D-037). COHESION GUARDRAIL for every task below: the
existing Phase-1 suites are byte-identical guardrails — `automation.test.ts`
(scheduleLane extraction), `audio-engine.test.ts` (master flag default 'internal'),
`transport-master-gain.test.ts` (unchanged) — run the **full** suite green BEFORE and AFTER
each task; a diff in those three files is a regression, not a spec change.

### Phase-2 dependencies (must be complete before this feature starts)
- `session-model` v4 — `Layer`/`LayerKind`/`LayerSource`/`ToneSpec`/`LanePoint` types; `RANGES.toneFreq`; `LAYER_*`/`TONE_*`/`LANE_*` validation codes.
- `clip-library` (Layer 0) — `list`/`importVia`/`createFileImportAdapter`/`remove`/`getBlob`/`totalBytes`; `Clip`/`ClipDraft`/`ClipSourceAdapter`/`ClipLibraryError`/`ClipLibraryErrorCode`.
- `layer-scheduler` (Layer 1) — `createLayerScheduler` factory (arch §6); injected into transport, never called by the UI.
- `renderer` (Layer 1) — `renderToBuffer(preset, { sampleRate, onProgress, signal })` + encoder (arch §5, no transport import).
- `voice-script` + `tts-local` (Layer 1, laptop-only) — `compileVoiceScript(script, { tts, clipLib })`; `createTtsAdapter()`.
- `transport` — the `layerScheduler?` option added to `TransportOptions` (arch §2.2).

- [x] [prereq] Add the Phase-2 constants and pure helpers (DEFAULT_TONE_SPEC, formatBytes, RenderFormat/ClipPanelMode literals) the authoring stores and components share | file: src/ui/lib/format.ts | model: T2
  - Ref: .dev/planning/modules/ui/design.md @ §21 Phase-2 constants and helpers (extends §14)
  - Ref: .dev/planning/modules/ui/interfaces.md @ §13 ClipPanelMode; §15 RenderFormat/RenderPhase/VoiceScriptPhase
  - Ref: .dev/planning/modules/ui/edge-cases.md @ M1 (formatBytes drives the clip-panel size display)
  - Ref: .dev/planning/phase2-audio-architecture.md @ §6 (ToneSpec shape — DEFAULT_TONE_SPEC must be a valid one-shot synth source)
  - Accepts: a byte count (number) for formatBytes; no input for the constants
  - Creates: `formatBytes(n: number): string` in src/ui/lib/format.ts (pure → "667 KB" / "1.3 MB"); `DEFAULT_TONE_SPEC = { shape:'sine', freqHz:528, attackSec:0.005, releaseSec:3 }` and the `RenderFormat`/`ClipPanelMode`/`RenderPhase`/`VoiceScriptPhase` literal types in src/ui/lib/constants.ts — all joining the existing single-source-of-truth files (no new CSS tokens, §21)
  - Behavior: formatBytes is pure and total — never throws on 0, negative, NaN, or Infinity (renders a safe placeholder); DEFAULT_TONE_SPEC values land inside RANGES.toneFreq {20,20000} with attack/release ≥ 0
  - Tests: happy — formatBytes(683008)==="667 KB", formatBytes(1363149)≈"1.3 MB", formatBytes(512)==="512 B", DEFAULT_TONE_SPEC matches §21 exactly and passes session-model toneSpec validation; edge — formatBytes(0)/negative/NaN/Infinity render safely (no throw); error — non-finite input never produces "NaN KB"
  - Guardrail: pure additive helpers only; full suite (incl. the three byte-identical Phase-1 files) green before and after.

- [x] [integration] Wire the Phase-2 composition root — inject createLayerScheduler() into createTransport and construct the clip/render/voiceScript stores; resolves the registered layerScheduler stub | file: src/ui/composition/bootstrap.ts | model: T1-lite
  - Ref: .dev/planning/modules/ui/design.md @ §16.2 Composition-root wiring (the new boot steps 1a/2a + the new stores)
  - Ref: .dev/planning/modules/ui/interfaces.md @ §16 (bootstrap.ts Phase-2 wiring) + §1 AppContext (the three new readonly stores added to the bundle)
  - Ref: .dev/planning/modules/ui/interfaces.md @ §12 (createLayerScheduler / renderToBuffer / compileVoiceScript signatures — consumed verbatim, never re-derived)
  - Ref: .dev/planning/phase2-audio-architecture.md @ §2.2 (`layerScheduler?: LayerSchedulerFactory` on TransportOptions; same injection shape as `scheduler`); §6 (the contract spine)
  - Ref: .dev/planning/modules/ui/edge-cases.md @ I5 (idempotent bootstrap/HMR — the new factory + stores build exactly once)
  - Ref: .dev/.task-state/stub-registry.md — resolves "layerScheduler factory passed to createTransport" (src/ui composition root, design §16.2)
  - Accepts: the existing bootstrap target?; the engine factories createLayerScheduler/createTransport, renderToBuffer + encode, compileVoiceScript + createTtsAdapter, and the live clip-library module
  - Creates: extends bootstrap() to build `createLayerScheduler()` and pass it as `createTransport({ scheduler, layerScheduler, artwork, … })`; constructs `createClipStore({ notices })`, `createRenderStore({ session, notices, renderToBuffer, encode })`, `createVoiceScriptStore({ session, notices, compileVoiceScript, tts: createTtsAdapter(), clipLib: clipLibrary })`; adds `clips`/`render`/`voiceScript` to the AppContext bundle and provides them to App via context — all under the existing module-level idempotent guard
  - Behavior: the UI never implements layer scheduling — it only wires the engine factory in; a live layer edit reschedules through the SAME `transport.reapply()` path the Phase-1 controls use (no new audio coupling). The clip/render/voiceScript stores get only the deps they need, so they stay unit-testable in isolation.
  - Handles: a double bootstrap()/HMR builds exactly one transport with one injected layerScheduler and one set of new stores (idempotent guard, I5)
  - Tests: happy — bootstrap returns the wired AppContext including clips/render/voiceScript; transport receives the injected layerScheduler (same shape as scheduler); the three new stores are constructed with their declared deps; edge — a double bootstrap()/HMR builds exactly one transport + one layerScheduler (idempotent); Phase-1 boot order (§4) and the prime()/listener attach path are unchanged; purity — bootstrap holds no Layer/Mixer/LayerNode handle, only injects factories
  - Resolves stubs: src/ui/ (composition root) — layerScheduler factory passed to createTransport
  - Guardrail: transport-master-gain.test.ts / automation.test.ts / audio-engine.test.ts stay byte-identical; full suite green before and after.

- [x] [impl] [data] Add the Phase-2 layer edits to SessionStore and build the ClipStore (clip-library list/import/delete + pick mode) | file: src/ui/stores/session.svelte.ts | model: T2
  - Ref: .dev/planning/modules/ui/design.md @ §16.4 (one-source-of-truth, validation-bounded authoring, clip references not bytes); §17 Layer track/lane authoring; §18 Clip-library panel
  - Ref: .dev/planning/modules/ui/interfaces.md @ §14 Session store Phase-2 layer edits (addLayer/removeLayer/setLayerKind/setLayerSource/setLayerToneSpec/setLayerStart/setLayerLoop/the gain & spatial lane ops/injectLayers); §13 ClipStore
  - Ref: .dev/planning/modules/ui/edge-cases.md @ L (layer authoring L1–L10), M (clip panel M1–M9)
  - Ref: .dev/planning/phase2-audio-architecture.md @ §0 (v4 layer invariants: unique non-empty id; ambiance⇒looping clip, tone⇒one-shot synth, voice⇒one-shot cue clip); §6 (clip-library + scheduler contracts)
  - Accepts: SessionStore deps unchanged; ClipStore deps { notices }; LayerKind/LayerSource/ToneSpec/LanePoint edits; a picked File for import; an onPick(clipId) callback for pick mode
  - Creates: the §14 SessionStore layer methods on the existing store (each clamps to v4 RANGES — toneFreq {20,20000}, gain=RANGES.volume {0,1}, spatial=RANGES.spatial {−1,1}, t∈[0,durationSec] — bumps revision, sets dirty, and calls applyLiveEdit(); addLayer generates a collision-free unique id; lanes kept sorted ascending + dedup-t; injectLayers appends compiled layers); ClipStore in stores/library.svelte.ts (refresh via list()+totalBytes(), importFile via importVia(createFileImportAdapter(), file) with dedup-hit "already in your library", removeClip with a courtesy "used by N presets" scan behind a confirm, openPicker/pick/closePicker)
  - Behavior: the UI mutates only the plain preset's `layers` data (stable identity for transport.reapply()/renderToBuffer); it never holds a Layer's engine node. The store cannot author a layer that fails session-model.validate (the §10 notice table maps a thrown INVALID_PRESET with its LAYER_*/TONE_*/LANE_* issues). The clip panel manages metadata + opaque blobs only — never decodes to an AudioBuffer or holds an AudioContext.
  - Handles: kind/source validity (only valid pairings offered, L3); unbound clip layer = silent + Save-blocked until bound (L7); a clipId missing on this device = flag the row, never block edit/play (L8); ClipLibraryErrorCode→notice (DECODE_FAILED/QUOTA_EXCEEDED/UNSUPPORTED, M1/M2/M6); remove returning false = already-gone (M4); dedup hit returns the same id, not a second copy (M5)
  - Tests: happy — addLayer('tone') appends DEFAULT_TONE_SPEC and bumps revision+dirty+applyLiveEdit; setLayerToneSpec clamps freqHz to RANGES.toneFreq; a gain lane point clamps to {0,1}, a spatial lane to {−1,1}, lanes stay sorted+dedup-t; ClipStore.refresh exposes Clip[] newest-first + totalBytes; importFile dedup hit toasts "already in your library" with the same id; error — out-of-range tone freq / lane value clamps (never authors INVALID_PRESET); DECODE_FAILED/QUOTA_EXCEEDED/UNSUPPORTED each map to the §18 friendly notice; edge — addLayer ids are collision-free (L1); an ambiance layer forces loop=true and only offers a Clip source (L3); removeLayer leaves the clip in the library (L10); injectLayers appends without re-timing; purity — the preset stays a plain object (structuredClone-safe), the UI holds no engine node
  - Guardrail: the three byte-identical Phase-1 test files stay unchanged; full suite green before and after.

- [x] [impl] Build the RenderStore and VoiceScriptStore (offline bounce + download lifecycle; compile→inject voice layers) | file: src/ui/stores/authoring.svelte.ts | model: T2
  - Ref: .dev/planning/modules/ui/design.md @ §19 Render / Export (the renderer wiring — read-only over the preset); §20 VoiceScript import (compile → inject voice layers); §16.1 (laptop-class capability gating)
  - Ref: .dev/planning/modules/ui/interfaces.md @ §15 Render + VoiceScript stores (RenderStore/RenderPhase/RenderFormat; VoiceScriptStore/VoiceScriptPhase — the factory dep shapes); §14 injectLayers (the merge entry point)
  - Ref: .dev/planning/modules/ui/edge-cases.md @ N (render N1–N7), O (VoiceScript O1–O8)
  - Ref: .dev/planning/phase2-audio-architecture.md @ §5 (renderToBuffer composes the byte-identical bus offline, pre-decodes clips, NO transport import); §6 (compileVoiceScript verbatim; the duck falls out of scheduling — the UI never writes duckGain, D-019)
  - Accepts: RenderStore deps { session, notices, renderToBuffer, encode }; VoiceScriptStore deps { session, notices, compileVoiceScript, tts, clipLib }; a RenderFormat; a parsed VoiceScript JSON (unknown)
  - Creates: stores/authoring.svelte.ts — RenderStore (phase/progress/canRender/result/missingClipIds; render(format) → renderToBuffer(preset,{onProgress,signal})→encode→{blob,filename}; cancel() via AbortSignal; download() triggers the <a download> in a gesture and clears result) and VoiceScriptStore (phase/progress/canCompile; importAndCompile(scriptJson) → compileVoiceScript({tts,clipLib}) → session.injectLayers — atomic: nothing injected unless compile fully succeeds)
  - Behavior: render is READ-ONLY over the preset (clones/reads the stable-identity working preset, never mutates — editing during a render is safe); the download is user-initiated only (never auto-download, mirrors §9's reload-only-on-click). VoiceScript inject appends layers (their absolute t already computed by the compiler — the UI does not re-time), bumps revision/dirty, applyLiveEdit() so a live session picks them up; the bed duck falls out of layer-scheduler→mixer.scheduleDuck — the UI never writes the duck gain (single-writer, D-019).
  - Handles: canRender=false when OfflineAudioContext absent → disabled + "Rendering needs a desktop browser" (N1); pre-render missing-clip warning listing the ids, renders anyway (N2); a second render ignored while phase∈{rendering,encoding} (N7); render/encode failure → phase='error', preset untouched (N4); MP3 with no encoder → offer WAV + note (N6); canCompile=false when tts-local absent → disabled + "Voice narration needs the desktop studio" (O3); a malformed VoiceScript / unsupported language → notice, nothing injected (O1/O2); a negative-slack cadence warning still injects (O5)
  - Tests: happy — render('wav') drives renderToBuffer with onProgress→progress and produces { blob, filename } from preset.name; download() fires the <a download> only on the gesture; importAndCompile success calls session.injectLayers with the returned layers and sets dirty (clips already in clip-library, shown after refresh, O6); error — render throw → phase='error', preset untouched (N4); a malformed script injects nothing (atomic, O1); edge — canRender=false disables render with the N1 notice; canCompile=false disables compile with the O3 notice; a second render while rendering is ignored (N7); a negative-slack warning still injects (O5); purity — render mutates nothing; neither store holds an AudioParam/node (returns blobs + plain Layer[])
  - Guardrail: full suite incl. the three byte-identical Phase-1 files green before and after.

- [x] [ui] Build the layer authoring UI — the Editor layer list/track column and the Layer Inspector (kind/source/t/loop + gain & spatial lanes) | file: src/ui/editor/LayerInspector.svelte | model: T2
  - Ref: .dev/planning/modules/ui/design.md @ §17 Layer track/lane authoring (§17.1 list, §17.2 inspector, §17.3 unbound/missing clip state); §16.3 (renders under the Editor tab — left strip on wide, scrollable list above the canvas on mobile; inspector as bottom sheet/side panel); §13 (responsive layout)
  - Ref: .dev/planning/modules/ui/interfaces.md @ §16 LayerList/LayerInspector props; §14 SessionStore layer edits (the store methods these components call)
  - Ref: .dev/planning/modules/ui/edge-cases.md @ L (L1–L10 layer authoring); §17.2 lane editor reuses the §12 canvas draw/interaction approach (value-at-t for display only, no audio cost)
  - Ref: .dev/planning/phase2-audio-architecture.md @ §0 (the kind/source/loop invariants the controls must respect); §6 (clip-library pick contract)
  - Accepts: the AppContext via context (session + ui stores); user taps on the layer list and inspector controls; a clip pick returned from the ClipPanel in pick mode
  - Creates: src/ui/screens/EditorScreen.svelte updates to host the layer list/track column; src/ui/editor/{LayerList,LayerInspector}.svelte — the list renders one row per Layer (id/name, kind badge, source summary, start t via formatClock, loop indicator) with edit/remove; the inspector edits kind (only valid pairings offered), source (Synth ToneSpec editor / "Pick clip…" opening the ClipPanel in pick mode), t (mm:ss clamped), loop (kept consistent with kind), and the gain & spatial LanePoint lanes (add/move/remove, reusing the §12 canvas draw approach; absent gain = unity, absent spatial = center shown as the implicit default); every committed edit goes through the §14 SessionStore methods
  - Behavior: the framework never touches the audio path — every interaction mutates the plain preset via the SessionStore and reschedules through transport.reapply() (no held node). The controls only offer schema-valid kind/source/loop pairings so the inspector can never produce a LAYER_SOURCE_INVALID.
  - Handles: unbound ambiance/voice layer → "Pick a clip" affordance + Save blocked inline until bound/removed (L7); a clipId missing on this device → "clip missing on this device" row flag, edit/play not blocked (L8); nodes/lanes clamp to RANGES, lanes stay sorted+dedup-t with exp disabled to/through 0 (L5/L6); removing a layer keeps the shared clip (L10)
  - Tests: happy — the list renders kind badge + source summary + formatted start t + loop; Add layer offers the three kinds and appends a valid default; the inspector round-trips kind/source/t/loop and edits the gain (0..1) and spatial (−1..1) lanes; a "Pick clip…" opens the ClipPanel in pick mode and binds the returned clipId; edge — an unbound clip layer shows "Pick a clip" and blocks Save inline (L7); a missing clipId shows the row flag without blocking edit/play (L8); an ambiance only offers a looping Clip source (L3); the inspector is a bottom sheet on mobile and a side panel on wide (§16.3/§13); purity — no bind:value to the preset (controls are one-way through the SessionStore)
  - Guardrail: full suite incl. the three byte-identical Phase-1 files green before and after.

- [x] [ui] [data] Build the clip-library panel (browse + pick modes: list with name/duration/size/source, file import, delete behind a confirm) | file: src/ui/components/ClipPanel.svelte | model: T2
  - Ref: .dev/planning/modules/ui/design.md @ §18 Clip-library panel (list/import/delete, browse vs pick); §16.3 (reachable from the Editor "Clips" sub-tab and from the layer source picker)
  - Ref: .dev/planning/modules/ui/interfaces.md @ §16 ClipPanel props (mode + onpick); §13 ClipStore (the store this panel reads/calls)
  - Ref: .dev/planning/modules/ui/edge-cases.md @ M (M1–M9 clip panel)
  - Ref: .dev/planning/phase2-audio-architecture.md @ §6 (clip-library list/importVia/createFileImportAdapter/remove/getBlob/totalBytes contracts)
  - Accepts: the ClipStore via context; mode ('browse'|'pick'); an onpick(clipId) callback in pick mode; a picked File from the hidden <input type="file" accept="audio/*">
  - Creates: src/ui/components/ClipPanel.svelte — a scrolling list of clips (meta.name, formatClock(durationSec), formatBytes(bytes) human size, a file/tts/record source badge, optional totalBytes() library-size line, newest first); an "Import clip" button whose change handler (the gesture) calls ClipStore.importFile(file) with NO preceding await; a per-row Delete behind a confirm with the courtesy "used by N saved presets" scan; in pick mode selecting a row returns clip.id via onpick and closes the panel (Import still available for import-then-pick)
  - Behavior: the panel never decodes a clip to an AudioBuffer and never holds an AudioContext — it manages metadata and opaque blobs only (decoding for playback is layer-engine's job). Import runs inside its DOM gesture (file-picker policy), like every other picker.
  - Handles: DECODE_FAILED/QUOTA_EXCEEDED/UNSUPPORTED surfaced as the §18 friendly notices via the store (M1/M2/M6); a dedup hit toasts "already in your library" and selects it rather than erroring (M5); delete of a referenced clip warns then proceeds, leaving the layer as the missing-clip case (M3); an unknown/already-gone id is treated as removed (M4); a large library shows metadata only — no blobs in memory (M7)
  - Tests: happy — the list renders name/duration(MM:SS)/human size/source badge newest-first; Import (in the change-handler gesture) adds a clip and refreshes; pick mode returns clip.id and closes; Delete is behind a confirm; edge — a dedup re-import toasts "already in your library" with the same id (M5); DECODE_FAILED/QUOTA_EXCEEDED render the friendly copy (M1/M2); a delete of a referenced clip warns "used by N presets" then succeeds (M3); UNSUPPORTED degrades to read-disabled (M6); purity — no clip is decoded to an AudioBuffer in the panel (M7); import has no await before importVia (M8)
  - Guardrail: full suite incl. the three byte-identical Phase-1 files green before and after.

- [x] [ui] Build the Render/Export sheet and the VoiceScript import action in the Editor header (format select, progress, cancel, download; pick→compile→inject) | file: src/ui/components/RenderSheet.svelte | model: T2
  - Ref: .dev/planning/modules/ui/design.md @ §19 Render / Export (the render sheet — format, progress bar, Download); §20 VoiceScript import (pick→compile→inject flow); §16.1/§16.3 (Editor-header actions; laptop-class capability gating, not width-gated)
  - Ref: .dev/planning/modules/ui/interfaces.md @ §16 RenderSheet/VoiceScriptImport props; §15 RenderStore/VoiceScriptStore (the stores these read via context)
  - Ref: .dev/planning/modules/ui/edge-cases.md @ N (render N1–N7), O (VoiceScript O1–O8)
  - Ref: .dev/planning/phase2-audio-architecture.md @ §5 (the renderer the sheet drives — offline, no transport import); §6 (compileVoiceScript; the injected layers carry their own absolute t)
  - Accepts: the RenderStore + VoiceScriptStore via context; a chosen RenderFormat; a picked .json file (accept=".json,application/json") for VoiceScript
  - Creates: src/ui/components/{RenderSheet,VoiceScriptImport}.svelte and the Editor-header "Render…" / "Import VoiceScript…" actions — RenderSheet offers WAV/MP3, a 0..1 progress bar, a Cancel, a missing-clip pre-render warning list, and a Download button (the gesture) driving an <a download> named from preset.name + extension; VoiceScriptImport runs the file-pick→importAndCompile→inject flow with a progress indicator and surfaces the compiler's diagnostics
  - Behavior: render is non-blocking and cancellable; the UI never auto-downloads (download policy needs user activation, mirrors §9). Both actions are capability-gated (disabled with a notice where OfflineAudioContext or the tts-local model is absent) — gated on capability, not screen size; they are not hidden on mobile.
  - Handles: canRender=false → disabled "Render" + "Rendering needs a desktop browser" (N1); a missing-clip pre-render warning listing the clips, then renders anyway (N2); a long render shows progress + Cancel (N3); a second render disabled while rendering/encoding (N7); MP3 with no encoder → WAV + note (N6); canCompile=false → disabled "Import VoiceScript" + "Voice narration needs the desktop studio" (O3); a malformed VoiceScript injects nothing (atomic, O1); a negative-slack cadence warning still injects (O5); compiled layers are not auto-persisted — Save is explicit (O7)
  - Tests: happy — the render sheet selects WAV, shows the progress bar from the store, and Download (gesture) fires the <a download> with the preset-name filename; "Import VoiceScript…" picks a .json and injects the compiled layers (dirty, shown in the layer list); edge — Render disabled + N1 notice when OfflineAudioContext absent; "Import VoiceScript" disabled + O3 notice when tts-local absent; Cancel aborts an in-flight render (N3); a second render is blocked while one runs (N7); a malformed script injects nothing (O1); purity — neither action mutates the preset except the explicit VoiceScript inject; no held audio node
  - Guardrail: full suite incl. the three byte-identical Phase-1 files green before and after.

- [x] [audit] Behavioral audit: layer authoring + clips + render (Phase 2) | file: .dev/.task-state/ui/behavioral-audit-phase2.md | model: T1
  - Ref: C:/Projects/.dev-shared/behavioral-audit.md — the Module Behavioral Audit checklist
  - Ref: .dev/planning/modules/ui/interfaces.md @ §12–§16 — every Phase-2 public store/component/composition-root contract must trace input → observable output (SessionStore layer edits, ClipStore, RenderStore, VoiceScriptStore, the bootstrap layerScheduler injection, and the LayerList/LayerInspector/ClipPanel/RenderSheet/VoiceScriptImport props)
  - Ref: .dev/planning/modules/ui/design.md @ §16–§21 — verify the intended behavior matches the implementation (plain-preset authoring, capability gating, gesture discipline, single-writer duck)
  - Ref: .dev/planning/modules/ui/edge-cases.md @ L, M, N, O — verify every documented Phase-2 edge case has evidence of handling in the code
  - Ref: .dev/planning/phase2-audio-architecture.md @ §2.2/§5/§6 (D-036/D-037) — confirm the UI injects createLayerScheduler verbatim, never calls scheduleLayers, never writes an AudioParam, and holds no Voice/Mixer/LayerNode (D-019/D-008 stay engine-owned)
  - For each Phase-2 interface: trace input → implementation → observable output; for each consumer (composition root, screens), verify it reads correct field names/shapes; confirm no silent valid-looking default masks a real failure (e.g. a missing clip silently treated as valid audio)
  - Confirm the COHESION GUARDRAIL: the full suite is green and automation.test.ts / audio-engine.test.ts / transport-master-gain.test.ts are byte-identical to their pre-feature state
  - Write findings + PASS/FAIL to .dev/.task-state/ui/behavioral-audit-phase2.md
  - PASS required before the Phase-2 feature is considered complete

## Feature: Multi-Voice (v6)

> The largest lift. Every authoring/monitor surface is hardwired to `session.preset.nodes` (the
> primary "voice 0"); multi-voice introduces an `activeVoiceId` and routes through a `voiceView`
> (multi-voice-architecture.md §5). Layer D — depends on the schema gate (A, for types/cap) and
> transport (C, for multi-voice load/reapply + `setVoiceTrim`). Each voice is edited with the SAME
> node editor as today; a voice can be binaural (beat>0) or isochronic (beat=0 + a volume pulse).
> Build the SessionStore spine FIRST (the cross-component contract), then the screens.

- [x] [ui] Extend `createSessionStore`: a `voices` accessor; `addVoice`/`removeVoice`/`setVoiceName`/`setVoiceGain`; a `voiceView(voiceId?): Preset` builder that DELEGATES to the shared session-model `voiceView(preset, nodes)` helper (sharing each voice's nodes by reference — NOT a hand-rolled literal, so render==playback==preview stay byte-identical, §1.5); and a trailing optional `voiceId?: string` on all 8 node mutators routed through a `targetNodes(voiceId?)` resolver. SENTINEL CONVENTION: `voiceId` is `string | undefined`, where `undefined` (and any unknown/stale id) ⇒ the primary voice 0 (`preset.nodes`); `voiceView`/`targetNodes` NEVER throw on a missing id (fall back to primary). `setVoiceGain(voiceId, value)`: clamp to `RANGES.voiceGain` [0,1], WRITE `preset.voices[k].gain` + set `dirty` + bump revision AND call `transport.setVoiceTrim` (live ramp) — the edit-time AND live channel (D-042), mirroring `setMasterGain`. `addVoice`/`removeVoice` are STRUCTURAL count changes ⇒ mutate `preset.voices`, set `dirty=true`, bump, then `transport.load(preset)` to rebuild — do NOT call `session.reset()` (it clears `dirty` + `selectedId`, losing the unsaved-changes guard and detaching the library record); this is the `addLayer`/`removeLayer` mutate+commit precedent, not a live reapply. Removing the active voice reselects Primary (`activeVoiceId → undefined`) | file: src/ui/stores/session.svelte.ts | model: T1
  - Ref: .dev/planning/multi-voice-architecture.md @ §5 (SessionStore); §3 (add/remove = rebuild; setVoiceTrim); §1.5 (shared `voiceView`)
  - Ref: .dev/planning/decisions-log.md @ D-040, D-042 (Voice.gain is edit-time AND live-adjustable)
  - Ref: src/ui/stores/session.svelte.ts @ setMasterGain (the write-preset+dirty+bump+transport.setMasterTrim dual-write analog to mirror), reset() (clears dirty/selectedId — why NOT to call it for add/remove), addLayer/removeLayer (the structural mutate+commit precedent)
  - Creates: the voice CRUD + `voiceView` (delegating to session-model) + the `voiceId?`-threaded mutators (the cross-component spine every other UI task builds on)
  - Behavior: the cap uses the `1 + voices.length` formula (mirrors `LIMITS.maxVoices`); a voice's nodes are shared by reference so canvas edits mutate the live voice
  - Tests: addVoice past the cap is rejected; mutators with no voiceId target voice 0 (byte-identical to today); an unknown/absent voiceId falls back to the primary (no throw); `voiceView(id)` returns a valid single-voice Preset and delegates to the shared session-model helper; `setVoiceGain` writes `preset.voices[k].gain` (survives a save) AND calls `transport.setVoiceTrim` without a full reschedule; `addVoice`/`removeVoice` trigger `transport.load` (rebuild) with `dirty=true` and a preserved `selectedId`, and do NOT call `reset()`/`reapply`/`setVoiceTrim`; removing the active voice reselects Primary

- [x] [ui] Rebuild EditorScreen's Nodes view with a voice selector strip (Primary + extra-voice tabs), Add/Remove voice buttons (Add disabled at `1 + voices.length >= MAX_VOICES` with an explanatory title), a per-voice name+gain header for non-primary voices, and `activeVoiceId: string | undefined` `$state` (initial `undefined` = Primary; on Remove of the active voice, reset to `undefined`) threaded into the toolbar/canvas/inspector | file: src/ui/screens/EditorScreen.svelte | model: T2
  - Ref: .dev/planning/multi-voice-architecture.md @ §5; §1.3 (cap formula)
  - Tests: selecting a voice re-targets the canvas/inspector; Add disabled at the cap; per-voice gain slider drives setVoiceGain

- [x] [ui] Add an `activeVoiceId` prop to TimelineCanvas so it renders + hit-tests via `session.voiceView(activeVoiceId)` and routes `setNodeValue`/`moveNode`/`addNode` with that voiceId | file: src/ui/editor/TimelineCanvas.svelte | model: T2
  - Ref: .dev/planning/multi-voice-architecture.md @ §5
  - Tests: canvas of voice k shows voice k's nodes; edits land on voice k

- [x] [ui] Thread an optional `voiceId` prop through NodeInspector, ParamSection, and ModulationPanel so index resolution, the display/carry-forward READS, and every `session.setNode*` call all target the active voice's `voiceView` — including the non-mutator reads `baseValueAt`/`valueAt`/`expDisabled` and the `session.preset.nodes[index]?.[param]` lookups (NodeInspector.svelte:73, ParamSection.svelte:51-53, ModulationPanel.svelte:95/101/116), NOT just the mutators — else an extra voice's inspector would DISPLAY voice 0's values. Same control set as today (carrier/beat/volume/spatial/waveform + warble mods) | file: src/ui/editor/NodeInspector.svelte, src/ui/components/ParamSection.svelte, src/ui/components/ModulationPanel.svelte | model: T2
  - Ref: .dev/planning/multi-voice-architecture.md @ §5 (components "render/hit-test/mutate via the active voice")
  - Ref: src/ui/editor/NodeInspector.svelte @ 73 (baseValueAt); src/ui/components/ParamSection.svelte @ 51-53 (value/transition/expDisabled reads); src/ui/components/ModulationPanel.svelte @ 95/101/116 (mod/baseValue reads)
  - Tests: inspector edits target the active voice; an extra voice's inspector DISPLAYS that voice's values (not voice 0's); an isochronic voice (beat 0 + volume pulse) authors via the existing modulation panel

- [x] [ui] Add `MAX_VOICES` (mirrored from session-model `LIMITS.maxVoices`, same `1 + voices.length` formula) to lib/constants.ts and a `CONTROL.voiceGain` spec to lib/controls.ts for the per-voice trim slider | file: src/ui/lib/constants.ts, src/ui/lib/controls.ts | model: T3
  - Ref: .dev/planning/multi-voice-architecture.md @ §1.3; §5
  - Tests: `MAX_VOICES === LIMITS.maxVoices` (tripwire so the UI mirror can't drift from session-model — spec §1.3 "UI mirrors it, never a bare voices.length compare"); `CONTROL.voiceGain` range derives from `RANGES.voiceGain` {0,1}

- [x] [ui] Add a voice selector to PlayerScreen passing a `voiceId` into SignalMonitor and SignalGauges so each renders the selected voice via `session.voiceView(voiceId)` (one voice monitored at a time) | file: src/ui/screens/PlayerScreen.svelte, src/ui/components/SignalMonitor.svelte, src/ui/components/SignalGauges.svelte | model: T2
  - Ref: .dev/planning/multi-voice-architecture.md @ §5
  - Tests: the monitor follows the selected voice

- [x] [ui] Show a voice-count badge in PresetListItem when `PresetSummary.voiceCount > 1` (rendered only when present) | file: src/ui/components/PresetListItem.svelte | model: T3
  - Ref: .dev/planning/multi-voice-architecture.md @ §5; D-042
  - Tests: badge renders when `voiceCount > 1`; hidden when `=== 1` or absent

- [x] [ux] Make the voice selector responsive (horizontal thumb-scroll strip below 720px, inline tabs when `ui.isWide`) and document the multi-voice mobile+wide behavior in ui/design.md §13 and the new SessionStore voice contract in interfaces.md | file: src/ui/screens/EditorScreen.svelte, .dev/planning/modules/ui/design.md, .dev/planning/modules/ui/interfaces.md | model: T2
  - Ref: .dev/planning/multi-voice-architecture.md @ §5 (responsive REQUIRED)
  - Tests: the selector renders as a horizontal scroll strip below 720px and as inline tabs when `ui.isWide`

- [x] [ui] Show a "headphones required for binaural voices · experimental, no medical/therapeutic claims" notice whenever a loaded preset contains a binaural voice. PREDICATE: any node in the primary `preset.nodes` OR any `preset.voices[k].nodes` sets `beat` with `value > 0` (include voice 0; a keyframed beat that is 0 at t=0 but >0 later still counts). RECONCILE with the existing UNCONDITIONAL caption + one-time `HeadphoneReminder` already in `PlayerScreen.svelte:38-42` — do NOT add a redundant third headphone element; either fold the new binaural-specific disclaimer into the existing reminder copy or render this conditional notice in place of the generic caption when the predicate holds | file: src/ui/components/HeadphoneNotice.svelte (new) + src/ui/screens/PlayerScreen.svelte + its test | model: T2
  - Ref: .dev/planning/multi-voice-architecture.md @ §6 (integrity notice)
  - Ref: .dev/planning/modules/perf-safety-binaural-integrity/design.md @ §4 (any voice with beat>0; isochronic-only presets play on speakers)
  - Ref: src/ui/screens/PlayerScreen.svelte @ 38-42 (existing caption + HeadphoneReminder to reconcile with); .dev/knowledge/binaural-beats/safety.md (no medical claims)
  - Tests: notice shows for a binaural preset (incl. one whose only binaural voice is an extra voice, and a keyframed beat 0→>0); hidden for an all-isochronic preset; no duplicate headphone element rendered

- [x] [audit] Verify canvas-renderer.ts and interactions.ts need ZERO code change by feeding them `voiceView` (they only read `preset.nodes`/`durationSec`); then behavioral audit of the ui multi-voice surface | file: .dev/.task-state/ui/behavioral-audit-v6-voices.md | model: T1
  - Ref: C:/Projects/.dev-shared/behavioral-audit.md
  - Ref: .dev/planning/multi-voice-architecture.md @ §5
  - Verify the active-voice routing end to end (select → edit → schedule via transport reapply/setVoiceTrim), the cap formula, the responsive layout, that single-voice authoring is byte-identical when no extra voices exist, and that voice add/remove is a STRUCTURAL `transport.load` rebuild (dirty set, selectedId preserved) — NOT a live reapply
  - DONE: PARTIAL. Part-A ZERO-change claim VERIFIED (canvas-renderer.ts/interactions.ts read only `preset.nodes`/`durationSec` + delegate to automation funcs that do the same; voiceView supplies exactly that field set; neither file is in the v6 diff). Data spine, selector, monitor, badge, headphone predicate, cap formula all PASS. Cleanup tasks created (FIX-1/2/3) for: EditorScreen not threading activeVoiceId into TimelineCanvas/NodeInspector (extra-voice canvas+inspector editing broken), and the red `npm run check` gate (§0 guardrail).

## Cleanup (Multi-Voice v6 behavioral audit — 2026-06-21)

- [x] [cleanup] Fix: EditorScreen does not thread `activeVoiceId` into TimelineCanvas / NodeInspector — extra-voice canvas + inspector editing is non-functional | file: src/ui/screens/EditorScreen.svelte | model: T2
  - Ref: behavioral audit 2026-06-21 (.dev/.task-state/ui/behavioral-audit-v6-voices.md) FIX-1
  - EditorScreen.svelte:316 `<TimelineCanvas …/>` lacks `activeVoiceId={activeVoiceId}` ⇒ canvas always draws/hit-tests/edits voice 0; EditorScreen.svelte:323 `<NodeInspector node={resolved} />` lacks `voiceId={activeVoiceId}` ⇒ for an extra voice `indexOf(node)===-1` so the inspector renders nothing
  - Pass `activeVoiceId={activeVoiceId}` to `<TimelineCanvas>` and `voiceId={activeVoiceId}` to `<NodeInspector>`; add a regression test that edits an extra voice through the canvas (drag/tap) and the Node Inspector (param + mod), asserting edits land on `preset.voices[k].nodes` and NOT `preset.nodes`

- [x] [cleanup] Fix: HeadphoneNotice.svelte is scriptless → `npm run check` cannot resolve the module (implicit any) | file: src/ui/components/HeadphoneNotice.svelte | model: T3
  - Ref: behavioral audit 2026-06-21 FIX-2
  - PlayerScreen.svelte:16 import errors "Could not find a declaration file for module '../components/HeadphoneNotice.svelte'"; add an empty `<script lang="ts"></script>` block (no behavior change), confirm `npm run check` clears the error

- [x] [cleanup] Fix: three library UI test fixtures omit the now-required `PresetSummary.voiceCount` | file: src/ui/components/library-components.test.ts | model: T3
  - Ref: behavioral audit 2026-06-21 FIX-3
  - `voiceCount` is required (persistence.ts:77); add `voiceCount: 1` to the PresetSummary fixtures at library-components.test.ts:12, src/ui/screens/library-screen.test.ts:45, and src/ui/stores/library.svelte.test.ts:84 (do not type it optional); re-run `npm run check` green

- [x] [cleanup] MAX_VOICES is unused and the spec-mandated drift tripwire is missing | file: src/ui/lib/constants.ts | model: T3
  - Ref: behavioral audit 2026-06-21 NOTE-1; tasks #321/#323
  - Removed unused MAX_VOICES constant (lines 64-66); cap is already enforced via LIMITS.maxVoices in session-model

> NOTE-2 (cross-module, NOT ui-owned): 4 of the 8 `npm run check` errors are engine-file
> unused-symbol errors from the v6 landing (`mixer.ts:27` ScheduleLaneOpts, `renderer.ts:34`
> Waveform, `mixer.test.ts:673,684` mod). They keep the shared check gate red (§0 guardrail);
> route their fixes to the mixer/renderer module task lists.

## Completion Criteria
- [ ] All tasks above marked [x] — none left [ ] (Pending) or [!] (Needs-Attention)
- [ ] Zero active stubs for `ui` (the SessionScheduler adapter stub is resolved by the scheduler-adapter task)
- [ ] All `ui` module tests passing (full suite, not just the current task's tests)
- [ ] Per-task audit PASS for every task
- [ ] last-step-summary.md written for every task with a concrete Observable Verification entry
- [ ] Behavioral audit PASS
