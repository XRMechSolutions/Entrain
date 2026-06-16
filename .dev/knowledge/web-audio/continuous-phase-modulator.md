---
topic: phase-continuous warble and pulse modulator in web audio
status: current
last-updated: 2026-06-14
tags: [web-audio, audioworklet, lfo, phase-continuity, isochronic, oscillator]
source-url:
  - https://webaudio.github.io/web-audio-api/
  - https://developer.mozilla.org/en-US/docs/Web/API/AudioWorkletProcessor/process
  - https://github.com/pendragon-andyh/WebAudio-PulseOscillator
---

# Phase-Continuous Warble / Pulse Modulator

## Native oscillator is phase-continuous by spec (verified)

The spec defines an oscillator's instantaneous phase as the **definite time integral
of its frequency**. So automating frequency changes the *rate* of phase advance, not
the phase value — ramping (or even stepping) an LFO oscillator's frequency never
produces an amplitude discontinuity (a step yields only a slope kink). This satisfies
the requirement that warble phase stay continuous as the period changes.

**Use a native `OscillatorNode` (sine/triangle)** for the simple glide warble:
`osc.frequency` automated via ramps; depth via a `GainNode` whose gain is ramped.

## AudioWorklet for pulse / variable-duty / soft-edge (isochronic)

Native `square` is locked to 50% duty. For variable duty cycle, raised-cosine
(anti-click) edges, and shape morphing under one continuous phase reference, use an
**AudioWorkletProcessor** with a single persistent phase accumulator:

| Aspect | Detail |
|--------|--------|
| Phase | `phase += 2π·freq[i]/sampleRate` per sample, wrapped mod 2π; kept as instance state across `process()` calls — continuity is independent of period/depth/shape changes |
| Params | a-rate AudioParams for frequency, depth, dutyCycle, edgeWidth |
| Pulse | high when normalized phase p < duty else low; cross each edge with raised-cosine `0.5·(1−cos(π·x))` over edgeWidth → C1-continuous, no clicks |
| Array length | Read the param/output array length each call; don't hardcode 128 (render-quantum size may vary) |
| Avoid | per-sample allocations (GC glitches); consider WASM for heavy shaping |

Raised-cosine edges kill clicks but are **not band-limited**; fine for a sub-audio
LFO/pulse, but if edges get very sharp relative to sampleRate, add oversampling/PolyBLEP.

## Decision for the engine

Hybrid: native oscillator for sine/triangle warble; AudioWorklet phase-accumulator for
`pulse` (isochronic) and any variable-duty / soft-edge shape.

## Sources
- W3C Web Audio API spec (oscillator phase = integral of frequency; AudioWorklet globals)
- MDN AudioWorkletProcessor.process (a-rate param arrays, render quantum)
- pendragon-andyh/WebAudio-PulseOscillator (native variable-duty technique)
