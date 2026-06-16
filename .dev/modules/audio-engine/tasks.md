# Tasks: audio-engine
# Planning: .dev/planning/modules/audio-engine/
# Architecture: .dev/architecture.md
# Standards: safety
# Stack: typescript

## Agent Briefing
audio-engine is the Layer-0 signal core: it builds and owns the Web Audio node graph
for exactly one binaural voice (two oscillators summed from ConstantSource carrier/beat
offsets → per-ear gains → ChannelMerger(2) → envGain → volumeGain → masterGain →
destination) plus the `pulse` AudioWorklet modulator. It depends on nothing in this
codebase — only Web Audio / platform APIs — and takes plain numbers (Hz, 0..1 gains,
seconds), never a Preset/Node/ModPoint. It exposes raw AudioParam handles for the
`automation` module to schedule onto and an `output` tap for `transport` to fade/route;
those two Layer-1 modules (and `ui`) are its consumers.

## References
- .dev/planning/modules/audio-engine/design.md — node graph, setters, lifecycle, pulse worklet, constants
- .dev/planning/modules/audio-engine/interfaces.md — public Voice contract, types, errors, handles
- .dev/planning/modules/audio-engine/edge-cases.md — every boundary/quirk and the exact handling
- .dev/planning/modules/audio-engine/dependencies.md — Web APIs used; no runtime library
- .dev/planning/system-design.md — §3 parameter model, §5 cross-module contracts, §6 no-click pattern
- .dev/knowledge/web-audio/binaural-voice-graph.md — ChannelMerger graph, Hz-offset-not-detune
- .dev/knowledge/web-audio/audioparam-automation.md — base+LFO summing, ramp/cancel rules, Firefox caveats
- .dev/knowledge/web-audio/continuous-phase-modulator.md — phase-continuous warble + pulse worklet

## Dependencies
None — Layer-0 base module. It deliberately depends on no other project module and pulls
in no npm runtime dependency; it is a thin layer over Web Audio (OscillatorNode, GainNode,
ChannelMergerNode, ConstantSourceNode, AudioParam, AudioWorklet). `automation`, `transport`,
and `ui` depend on this module, never the reverse. This module must be complete before any
Layer-1 module that consumes a `Voice`.

## Tasks

- [x] [impl] Build the static one-voice node graph in createVoice, plus the AudioEngineError class, public types, and the five raw AudioParam handles + output tap | file: src/engine/audio-engine.ts | model: T1
  - Ref: .dev/planning/modules/audio-engine/design.md @ §2 The node graph (what gets built, and why)
  - Ref: .dev/planning/modules/audio-engine/design.md @ §3 Raw AudioParam handles (the automation contract)
  - Ref: .dev/planning/modules/audio-engine/design.md @ §11 Constants (single source of truth)
  - Ref: .dev/planning/modules/audio-engine/interfaces.md @ Types / Errors / The Voice / Module-level functions
  - Ref: .dev/planning/modules/audio-engine/edge-cases.md @ A. Input/parameter boundaries (A3) + H. Graph-construction boundaries (H1, H2, H3)
  - Ref: .dev/knowledge/web-audio/binaural-voice-graph.md @ Recommended graph (one binaural voice)
  - Accepts: createVoice(ctx: BaseAudioContext, options?: VoiceOptions) with optional waveform/carrierHz/beatHz/volume/masterTrim
  - Creates: Voice (readonly ctx, state='idle', carrierParam/beatParam/volumeParam/modVolumeParam/masterGainParam: AudioParam, output: AudioNode); AudioEngineError(code, message?, cause?); Waveform/VoiceState/VoiceOptions/AudioEngineErrorCode types; exported PULSE_PROCESSOR_NAME='pulse'
  - Tests: happy — graph built and output (masterGain) connected to ctx.destination, masterGain.gain=0 at construction, defaults applied (carrier 200, beat 4, volume 1, trim 0.8, sine), oscillator intrinsic frequency=0 with carrierSource(+1 into both) and beatSource(splitL −0.5 / splitR +0.5) summing to fL=carrier−beat/2, fR=carrier+beat/2; error — unknown waveform string or non-finite option throws INVALID_PARAMETER (A3); edge — OfflineAudioContext accepted as BaseAudioContext (H3), output fans out to two destinations losslessly (H2)

- [x] [impl] Imperative no-click setters with clamp, 10 ms linear ramp, JS value-tracking, and Firefox re-target fallback | file: src/engine/audio-engine.ts | model: T1 | [availability]
  - Ref: .dev/planning/modules/audio-engine/design.md @ §4 Imperative setters and the no-click policy
  - Ref: .dev/planning/modules/audio-engine/design.md @ §5 No-click rule (project-wide pattern, enforced here)
  - Ref: .dev/planning/modules/audio-engine/edge-cases.md @ A. Input/parameter boundaries (A1, A2) + D. No-click/ramp quirks (D1–D5) + E. Firefox AudioParam quirks (E1–E3)
  - Ref: .dev/knowledge/web-audio/audioparam-automation.md @ Scheduling rules / Browser caveats
  - Accepts: setCarrier(hz, atTime?), setBeat(hz, atTime?), setVolume(v, atTime?), setMasterGain(v, atTime?), setBalance(pan, atTime?), setWaveform(w)
  - Creates: clamped, anchored 10 ms linearRampToValueAtTime writes to carrierSource.offset / beatSource.offset / volumeGain.gain / masterGain.gain (trim ceiling) / gainL+gainR; oscL.type+oscR.type set immediately; per-param JS-tracked last commanded value
  - Tests: happy — value clamped to documented range (carrier 20..1000, beat 0..35, gains 0..1, pan −1..1) then ramped over 10 ms linear (can reach 0), setBalance pan→gain map (0→1/1, −1→1/0, +1→0/1), setWaveform sets both osc types (D5, not ramped); error — NaN/±Infinity throws INVALID_PARAMETER and is never written to a param (A1); edge — re-ramp anchors from JS-tracked value not param.value (E2), cancelAndHoldAtTime feature-detected with cancelScheduledValues+setValueAtTime fallback (E1), never uses exponentialRamp or setValueCurveAtTime (D2, E3)

- [x] [impl] Voice lifecycle state machine: start/stop/dispose with one shared t0 for all four sources and idle→running→stopped guards | file: src/engine/audio-engine.ts | model: T1 | [availability]
  - Ref: .dev/planning/modules/audio-engine/design.md @ §9 Lifecycle and state machine
  - Ref: .dev/planning/modules/audio-engine/interfaces.md @ The Voice (Lifecycle)
  - Ref: .dev/planning/modules/audio-engine/edge-cases.md @ B. Lifecycle/state (B1–B5) + C. Autoplay/context-gesture (C1) + H. Graph-construction boundaries (H1)
  - Ref: .dev/knowledge/web-audio/mobile-audio-lifecycle.md @ autoplay / suspended-context (schedule without inspecting ctx.state)
  - Accepts: start(atTime?), stop(atTime?), dispose()
  - Creates: start() starts oscL/oscR/carrierSource/beatSource at one t0 = atTime ?? ctx.currentTime and sets state='running'; stop() stops all four at the shared time and sets state='stopped' (terminal); dispose() disconnects every voice node, idempotent
  - Tests: happy — start starts all four sources together, stop stops them, state transitions idle→running→stopped; error — start() twice throws VOICE_ALREADY_STARTED (B1), any setter/start/connectWarble/createPulseNode/attachVolumeModulator after stop() throws VOICE_STOPPED (B2); edge — dispose() twice or before start() is a safe no-op (B4), stop(atTime in past) passes the time through unchanged (B5), start() on a suspended ctx schedules without producing sound and never inspects/changes ctx.state (B3, C1)

- [x] [impl] connectWarble glide helper: native sine/triangle LFO → depth gain → target param, returning a WarbleHandle | file: src/engine/audio-engine.ts | model: T1
  - Ref: .dev/planning/modules/audio-engine/design.md @ §6 Warble (glide) helper — connectWarble (D-013, D-014)
  - Ref: .dev/planning/modules/audio-engine/interfaces.md @ Handles returned by helpers (WarbleHandle) + WarbleOptions
  - Ref: .dev/planning/modules/audio-engine/edge-cases.md @ A. Input/parameter boundaries (A4, A5) + H. Graph-construction boundaries (H4, H5)
  - Ref: .dev/knowledge/web-audio/continuous-phase-modulator.md @ Native oscillator is phase-continuous by spec
  - Accepts: connectWarble(target: AudioParam, opts?: WarbleOptions) where target ∈ {carrierParam, beatParam, modVolumeParam}
  - Creates: OscillatorNode(opts.shape, default sine) → GainNode(opts.depth) → target, osc.frequency = opts.frequencyHz, started at opts.startTime ?? ctx.currentTime; WarbleHandle { osc, frequencyParam (=osc.frequency), depthParam (=depthGain.gain), disconnect() }
  - Tests: happy — osc→depthGain→target wired, frequency/depth set, osc started, handle exposes osc.frequency + depthGain.gain as a-rate params summed onto target; edge — engine does NOT bound the connected depth (A4 frequency / A5 volume bounds are automation's contract), params stay a-rate (H4), handle.disconnect() stops the LFO and frees its nodes (H5); error — connectWarble after stop() throws VOICE_STOPPED

- [x] [impl] Pulse AudioWorkletProcessor: persistent phase accumulator, variable duty, clamped raised-cosine edges, zero per-block allocation | file: src/engine/pulse-worklet.ts | model: T1 | [availability]
  - Ref: .dev/planning/modules/audio-engine/design.md @ §7.3 Processor algorithm (pulse-worklet.ts) — fully specified
  - Ref: .dev/planning/modules/audio-engine/interfaces.md @ Worklet processor (internal, src/engine/pulse-worklet.ts) — parameterDescriptors
  - Ref: .dev/planning/modules/audio-engine/edge-cases.md @ F. AudioWorklet (pulse) failures (F4–F7) + A. Input/parameter boundaries (A6, A7)
  - Ref: .dev/knowledge/web-audio/continuous-phase-modulator.md @ AudioWorklet for pulse / variable-duty / soft-edge
  - Accepts: parameters { frequency, depth, dutyCycle, edgeWidth } (all a-rate); writes outputs[0][0] of length n per process() call
  - Creates: PulseProcessor with parameterDescriptors (frequency 4/0/20000, depth 1/0/1, dutyCycle 0.5/0/1, edgeWidth 0.005/0/1), phase-in-cycles accumulator persisted across process() calls, edge fraction e = min(edgeWidth·frequency, dutyCycle·0.999, (1−dutyCycle)·0.999), raised-cosine rcos(x)=0.5·(1−cos(π·x)); registerProcessor(PULSE_PROCESSOR_NAME); process() returns true
  - Tests: happy — mono 0..1 envelope, high=1 / low=1−depth, dutyCycle fraction at high, raised-cosine edges are C1-continuous (click-free); edge — reads outputs[0][0].length every call (never hardcodes 128, F4), reads global sampleRate each block (not 44100/48000, F5), length-1 (constant block) vs length-n param arrays both handled (F7), dutyCycle 0/1 and oversized edge well-defined with e==0 → hard step and no divide-by-zero (A6), frequency 0 → held DC envelope = low (A7), allocates nothing per sample or per block (F6)

- [x] [impl] registerPulseWorklet (idempotent per-context) + createPulseNode + attach/detachVolumeModulator multiplicative gate | file: src/engine/audio-engine.ts | model: T1
  - Ref: .dev/planning/modules/audio-engine/design.md @ §7.1 Registration + §7.2 Instantiation — createPulseNode
  - Ref: .dev/planning/modules/audio-engine/design.md @ §8 Volume modulator attach/detach (multiplicative gating)
  - Ref: .dev/planning/modules/audio-engine/interfaces.md @ Module-level functions + Handles returned by helpers (PulseHandle)
  - Ref: .dev/planning/modules/audio-engine/edge-cases.md @ F. AudioWorklet (pulse) failures (F1–F3)
  - Ref: .dev/knowledge/web-audio/continuous-phase-modulator.md @ AudioWorklet for pulse / variable-duty / soft-edge
  - Accepts: registerPulseWorklet(ctx, moduleUrl?): Promise<void>, createPulseNode(opts?: PulseOptions), attachVolumeModulator(source: AudioNode), detachVolumeModulator()
  - Creates: addModule called once per BaseAudioContext (tracked in module-level WeakSet) with default url new URL('./pulse-worklet.js', import.meta.url).href; AudioWorkletNode('pulse') with one output channel + four a-rate params → PulseHandle { node, output, frequencyParam, depthParam, dutyCycleParam, edgeWidthParam, disconnect() }; attach ramps envGain.gain→0 over 10 ms then connects source; detach disconnects source and ramps envGain.gain→1.0
  - Tests: happy — register resolves and addModule runs once, createPulseNode builds the node with PulseOptions defaults (4/1/0.5/0.005), attach makes envGain.gain the connected 0..1 envelope (replace-mode gate) and detach restores pass-through 1.0; error — addModule rejection → WORKLET_LOAD_FAILED with cause (F1), createPulseNode before register resolved → WORKLET_NOT_REGISTERED (F2); edge — second register for the same context is a no-op resolving immediately (F3), createPulseNode/attach after stop() throws VOICE_STOPPED

- [x] [impl] Spatial pan (D-021): panGainL/panGainR pair + spatialSource + spatialParam handle + setSpatial; the constant-loudness floored balance law; spatialSource joins the started/stopped sources | file: src/engine/audio-engine.ts | model: T1
  - Ref: .dev/planning/modules/audio-engine/design.md @ §2.7 Spatial pan — panGainL/panGainR + spatialSource (D-021)
  - Ref: .dev/planning/modules/audio-engine/design.md @ §2.5 Per-ear gains (gainL/gainR stay static; pan rides the separate pair); §9 Lifecycle (five sources); §11 Constants (SPATIAL_FAR_EAR_FLOOR, ranges)
  - Ref: .dev/planning/modules/audio-engine/interfaces.md @ The Voice (spatialParam, setSpatial); connectWarble target ∈ {…, spatialParam}
  - Ref: .dev/planning/decisions-log.md @ D-021 (ILD-only; both-ear modulation authorized; bounded by the −12 dB floor)
  - Accepts: setSpatial(pos, atTime?) clamp −1..1; sweep via connectWarble(voice.spatialParam, …)
  - Creates: spatialSource (ConstantSourceNode.offset, default 0) exposed as spatialParam; panGainL/panGainR (default 1.0) inserted gainL/R → panGain → merger; the mapping panGainL = 1 − (1−F)·max(0,s), panGainR = 1 − (1−F)·max(0,−s) with F=SPATIAL_FAR_EAR_FLOOR (0.25), realized click-free at a-rate via two memoryless WaveShaperNode(y=max(0,±x)) summed into each panGain.gain intrinsic 1.0; 10 ms-ramped setSpatial; spatialSource started/stopped at the shared t0 (now five sources)
  - Tests: happy — s=0 → panGainL=panGainR=1 (no effect); s=+1 → panGainR=1, panGainL=F (full right), s=−1 mirror; near ear stays unity across the sweep (no center dip), far ear floored at F (both ears always audible → beat survives); connectWarble(spatialParam) sums a sweep onto the position; setSpatial clamps −1..1 and ramps; error — non-finite pos → INVALID_PARAMETER, any op after stop() → VOICE_STOPPED; edge — spatialSource started/stopped with the other four sources; gainL/gainR (setBalance) unaffected; pan stacks with a concurrent volume modulator (panGain pre-merge, envGain post-merge)

- [x] [audit] Behavioral audit: audio-engine | file: .dev/.task-state/audit-audio-engine.md | model: T1
  - Ref: C:/Projects/.dev-shared/behavioral-audit.md
  - Ref: .dev/planning/modules/audio-engine/interfaces.md
  - Ref: .dev/planning/modules/audio-engine/edge-cases.md
  - Verify the module's observable behavior matches its interfaces.md + edge-cases.md: trace every public interface (createVoice, registerPulseWorklet, all Voice params/setters/helpers/lifecycle, the pulse worklet) input → implementation → observable output; confirm every documented edge case (A–H) has evidence of handling and no silent valid-looking default; PASS required before the module is considered complete.

## Completion Criteria
- [ ] All tasks marked [x] — zero tasks left [ ] (Pending) or [!] (Needs-Attention)
- [ ] Zero active stubs for this module in .dev/.task-state/stub-registry.md
- [ ] All module tests passing (full suite, not just current task tests)
- [ ] Audit PASS for every task
- [ ] last-step-summary.md written for every task with a concrete Observable Verification entry
- [ ] Behavioral audit PASS (every interface in interfaces.md traces input→output; every edge case A–H handled)
