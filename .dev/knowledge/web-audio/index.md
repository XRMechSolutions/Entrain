---
topic: web audio + pwa platform knowledge for the binaural engine
status: current
last-updated: 2026-06-14
tags: [web-audio, audioparam, pwa, mobile-audio, audioworklet]
---

# Web Audio & PWA — Engine Platform Notes

Spec-verified Web Audio API and PWA behavior relevant to the binaural engine,
gathered in the Tier-2 research phase (adversarially verified against the W3C spec
and MDN browser-compat-data). Candidates for promotion to shared `platforms/` later.

## Sub-Documents

| File | Covers |
|------|--------|
| [audioparam-automation.md](audioparam-automation.md) | AudioParam scheduling; base-curve + LFO summed on one param; ramp/cancel browser caveats |
| [binaural-voice-graph.md](binaural-voice-graph.md) | The L/R node graph: ChannelMerger, Hz-offset beat, shared post-merge envelope |
| [continuous-phase-modulator.md](continuous-phase-modulator.md) | Phase-continuous warble/pulse: native oscillator vs AudioWorklet accumulator |
| [mobile-audio-lifecycle.md](mobile-audio-lifecycle.md) | Autoplay gesture, background/locked-screen survival, MediaSession, iOS quirks |
| [pwa-setup.md](pwa-setup.md) | Vite + vite-plugin-pwa, manifest, offline, install, iOS quirks |
