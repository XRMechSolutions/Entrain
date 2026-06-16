// transport-master-gain — the analytic, Firefox-safe master-gain ramp helper.
//
// Every master-gain change transport makes (fade-in/out, pause/seek micro-fade,
// live-trim ramp) goes through ONE controller so the no-click rule and the Firefox
// AudioParam quirks are handled in exactly one place (design.md §4, edge-cases C).
//
// It tracks the current ramp ANALYTICALLY — it never reads `param.value`, which can
// be stale on Firefox Android / Firefox < 134 (audioparam-automation.md). Because
// every transport master ramp is linear, the value at any `now` is an exact linear
// interpolation between the tracked ramp endpoints.

interface RampRecord {
  startTime: number;
  startValue: number;
  endTime: number;
  endValue: number;
}

/** A param that MAY expose cancelAndHoldAtTime (Firefox does not — bug 1308431). */
type RetargetableParam = AudioParam & {
  cancelAndHoldAtTime?: (cancelTime: number) => void;
};

export interface MasterGainController {
  /** Ramp masterGain to `target` over `durationSec`, anchored from the analytic
   *  current value. `durationSec <= 0` collapses to an immediate setValueAtTime. */
  rampMaster(target: number, durationSec: number): void;
  /** The true gain at `now`: startValue before the ramp, endValue after, linear
   *  interpolation in between. Never reads `param.value`. */
  currentMasterValue(now: number): number;
}

/**
 * Build a master-gain controller bound to one voice's `masterGainParam`. `getNow`
 * returns the controlling `ctx.currentTime`. The voice's masterGain starts at 0
 * (audio-engine DEFAULT_MASTER), so the initial record is a flat 0.
 */
export function createMasterGainController(
  param: AudioParam,
  getNow: () => number,
): MasterGainController {
  let record: RampRecord = { startTime: 0, startValue: 0, endTime: 0, endValue: 0 };

  function currentMasterValue(now: number): number {
    if (now <= record.startTime) return record.startValue;
    if (now >= record.endTime) return record.endValue;
    const span = record.endTime - record.startTime;
    const frac = span > 0 ? (now - record.startTime) / span : 1;
    return record.startValue + frac * (record.endValue - record.startValue);
  }

  function rampMaster(target: number, durationSec: number): void {
    const now = getNow();
    const cur = currentMasterValue(now);
    const p = param as RetargetableParam;

    // Cancel the in-flight ramp. Feature-detect cancelAndHoldAtTime; Firefox lacks it
    // (bug 1308431) so fall back to cancelScheduledValues(now). Cancelling is required
    // even for the instant path, or a queued ramp would resume from the new anchor.
    if (typeof p.cancelAndHoldAtTime === 'function') {
      p.cancelAndHoldAtTime(now);
    } else {
      param.cancelScheduledValues(now);
    }

    if (durationSec <= 0) {
      // Instant set (used internally where a jump is safe, e.g. teardown(false)).
      param.setValueAtTime(target, now);
      record = { startTime: now, startValue: target, endTime: now, endValue: target };
      return;
    }

    // Anchor from the analytic current value (defends against a stale param.value and
    // satisfies the spec's "anchor before ramp" rule), then a LINEAR ramp — never
    // exponential (can't reach 0) and never setValueCurveAtTime (Firefox can't cancel
    // an in-progress curve — bug 1752775).
    param.setValueAtTime(cur, now);
    param.linearRampToValueAtTime(target, now + durationSec);
    record = { startTime: now, startValue: cur, endTime: now + durationSec, endValue: target };
  }

  return { rampMaster, currentMasterValue };
}
