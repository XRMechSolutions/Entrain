---
topic: binaural voice node graph in web audio
status: current
last-updated: 2026-06-14
tags: [web-audio, channelmerger, binaural, oscillator, node-graph]
source-url:
  - https://developer.mozilla.org/en-US/docs/Web/API/ChannelMergerNode
  - https://developer.mozilla.org/en-US/docs/Web/API/OscillatorNode/detune
---

# Binaural Voice Node Graph

## Recommended graph (one binaural voice)

```text
oscL (sine, carrier)        → gainL → merger.input[0]   (left, output ch 0)
oscR (sine, carrier+beat)   → gainR → merger.input[1]   (right, output ch 1)
merger (ChannelMerger, 2)   → envGain (shared post-merge isochronic envelope)
envGain                     → masterGain (volume + click-free fades)
masterGain                  → ctx.destination
oscL.start(t0); oscR.start(t0)   // same t0
```

## Why these choices (spec-verified)

| Decision | Rationale |
|----------|-----------|
| `ChannelMergerNode(2)`, not StereoPanner/Splitter | The merger gives hard, lossless L/R placement (input 0 → channel 0 left, input 1 → channel 1 right) with no panning math. StereoPanner separates cleanly only at exactly ±1 and leaks off-endpoint; ChannelSplitter is the inverse tool (decompose), useless for already-mono oscillators |
| Beat as **Hz offset** on `oscR.frequency` (carrier + beat) | Keeps the beat rate exact and carrier-independent. `detune` is cents (logarithmic: computedFreq = freq·2^(detune/1200)), so a cents offset makes the beat drift with the carrier — reserve detune for fine pitch trim only |
| Don't set relative start phase | OscillatorNode has no start-phase param, and it doesn't matter: the binaural percept is the central \|fL−fR\| difference; interaural phase sweeps through all values at the beat rate regardless of start. Start both at the same t0 |
| Per-ear `gainL` / `gainR` | Independent L/R level/balance without touching the shared envelope |
| Single `envGain` post-merge | One amplitude envelope gates BOTH ears identically — required for isochronic gating and to preserve the binaural relationship |
| `masterGain` before destination | User volume + click-free start/stop: ramp from 0; never assign `.value` abruptly |

## Sources
- MDN ChannelMergerNode / createChannelMerger (input→channel mapping, connect indices)
- MDN OscillatorNode.detune (computedFreq = freq·2^(detune/1200))
- eNeuro 2020 (beat = \|fL−fR\|, central origin)
