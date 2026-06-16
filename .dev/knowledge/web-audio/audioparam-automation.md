---
topic: web audio audioparam automation and modulator coexistence
status: current
last-updated: 2026-06-14
tags: [audioparam, automation, lfo, scheduling, web-audio]
source-url:
  - https://webaudio.github.io/web-audio-api/#computation-of-value
  - https://webaudio.github.io/web-audio-api/#dom-audionode-connect-destinationparam-output
  - https://github.com/mdn/browser-compat-data/blob/main/api/AudioParam.json
---

# AudioParam Automation & Modulator Coexistence

## Load-bearing fact: base curve + LFO sum on ONE param (spec-verified)

Per the spec's Computation of Value, an AudioParam's per-quantum value is:

`paramComputedValue = paramIntrinsicValue (timeline automation) + Σ(connected audio inputs)`, then clamped to the nominal range.

So a connected modulator — `OscillatorNode → GainNode(depth) → param` — **adds** to
scheduled automation; it does not replace it. Our "base ramp + warble on one
parameter" works natively, sample-accurate (a-rate), with no extra mixer node. The
spec's canonical example is `lfo → modGain(gain=50) → osc.detune`.

`param.value` returns the **intrinsic** timeline value WITHOUT the connected LFO —
the correct anchor for re-scheduling the base curve.

## Scheduling rules

| Rule | Detail |
|------|--------|
| Anchor before ramping | A ramp starts from the *previous event's* value; an unanchored ramp starts from the value at `currentTime`. Always `setValueAtTime(start, t0)` before `linearRamp…`/`setValueCurve…` |
| No exponential ramp to/through 0 | `exponentialRampToValueAtTime` needs same-sign nonzero endpoints. Fades use linear ramps or `setTargetAtTime`, or a small floor (0.01), never 0 |
| Keep params a-rate | `OscillatorNode.frequency/detune` and `GainNode.gain` are a-rate by default — needed for smooth per-sample modulation. Don't switch to k-rate |
| Clamping is output-only | Automation computes unclamped, clips at output. Frequency params have no protective clamp, so bound depth so base±depth stays in (0, Nyquist) |
| setValueCurve exclusivity | `setValueCurveAtTime` forbids other *timeline events* in its open interval (T, T+D) — but a connected modulator input still sums fine (separate input buffer) |

## Browser caveats (MDN browser-compat-data — these bite the fallback path)

- **Firefox lacks `cancelAndHoldAtTime`** (bug 1308431, NEW). Feature-detect; fall
  back to `cancelScheduledValues(now)` + `setValueAtTime(value, now)`.
- **`param.value` can be stale on Firefox Android / Firefox < 134** — returns only
  the last explicitly-set value, not the scheduled position. For robust re-targeting,
  track the base value in JS (you know the ramp endpoints/times) and anchor with the
  computed value rather than reading `param.value`.
- **Firefox `cancelScheduledValues` won't cancel an in-progress `setValueCurveAtTime`**
  (bug 1752775; also old Chrome/Safari). So prefer `setValueAtTime`+ramps, or put the
  base curve on a `ConstantSourceNode.offset` summed into the param, so re-targeting is
  independent of curve-cancellation quirks.

## Engine recommendation

Base timeline via anchored `setValueAtTime` + linear ramps (or a
`ConstantSourceNode.offset` for robust mid-session re-targeting); warble as
`Oscillator → Gain(depth) → sameParam`. Re-target with feature-detected
`cancelAndHoldAtTime`, else `cancelScheduledValues` + a JS-tracked anchor value.

## Sources
- W3C Web Audio API — Computation of Value; connect()→AudioParam; ramp/cancel methods
- MDN browser-compat-data AudioParam.json (Firefox caveats)
