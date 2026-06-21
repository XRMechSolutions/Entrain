// mixer — Layer-0 summation graph + bed-duck envelope (pure Web Audio).
//
// Owns all summation for a session: a fixed three-input → one-master Web Audio
// graph plus the single bed-duck envelope. Depends ONLY on `automation`'s
// `scheduleLane` (the shared no-click param writer) and the session-model `LanePoint`
// type; imports no other project module. Consumed by `transport`, `renderer`, and
// `layer-scheduler`. Pure Web Audio against any `BaseAudioContext` so `renderer`
// reuses the byte-identical graph offline against an `OfflineAudioContext`.
//
// Invariants:
//   - single-input master (its only upstream is busSum; connect/disconnect move ONLY
//     master's OUTPUT edge — arch §1/§2.2).
//   - bed-only duck: duckGain sits between bedInput and busSum; cue/lift join busSum
//     downstream, so they are never ducked (structural, arch §4).
//   - single-writer duckParam (D-019): scheduleDuck is the sole writer; the within-call
//     MIN-toGain interval merge guarantees the param never receives two competing ramps.
//   - no-click linear ramps (D-008): the duck reuses scheduleLane's
//     setValueAtTime(anchor)+linearRampToValueAtTime op sequence — linear only, never
//     exp, never setValueCurveAtTime (Firefox bug 1752775).
//   - JS-tracked anchor: every duck schedule anchors from `trackedDuck`, NEVER
//     duckParam.value (Firefox returns a stale param.value after scheduling).
//   - No transport globals (no animation-frame loop, no media-session, no wake lock, no
//     timers, no media-stream destination) — that would break offline reuse (arch §6 "L0").
//
// See .dev/planning/modules/mixer/{design,interfaces,edge-cases}.md.

import { scheduleLane, type LanePoint, type ScheduleLaneOpts } from './automation';

// ---------------------------------------------------------------------------
// 1. Constants
// ---------------------------------------------------------------------------

/** Short fixed recover time for `cancelDuck`'s no-click rise back to unity (design §4.5).
 *  A precise release is only meaningful when a real span drives it; this is the floor. */
const CANCEL_RECOVER_SEC = 0.05;

/** Bed gain when no duck is active. */
const UNITY = 1.0;

// ---------------------------------------------------------------------------
// 2. Public types (interfaces.md §1)
// ---------------------------------------------------------------------------

/** One ducking region, as produced (already merged, MIN-toGain) by layer-scheduler.
 *  All ctx seconds. `toGain` ∈ [0,1] is the bed gain at the cue floor; attack/release
 *  are the ramp durations into/out of toGain. (Restated verbatim from arch §6.) */
export interface DuckSpan {
  startCtx: number; // ctx time the cue's audible onset begins (attack ends here)
  endCtx: number; // ctx time the cue ends (release begins here)
  toGain: number; // [0,1] finite — bed gain during the cue (deepest wins on overlap)
  attackSec: number; // ≥ 0 finite — ramp-down duration into toGain (ends at startCtx)
  releaseSec: number; // ≥ 0 finite — ramp-up duration back to 1.0 (begins at endCtx)
}

export interface Mixer {
  /** Bed fan-in: binaural voice + tone + ambiance connect here. Through duckGain → busSum. */
  readonly bedInput: AudioNode;
  /** Voice-cue fan-in: joins busSum DOWNSTREAM of the duck (a cue never ducks itself). */
  readonly cueInput: AudioNode;
  /** Shepard-lift fan-in: post-duck overlay; joins busSum downstream of the duck. */
  readonly liftInput: AudioNode;

  /** The single-input master. Its only upstream is the internal busSum. connect/disconnect
   *  move ONLY this node. Constructed at gain 0 (or opts.masterStart). */
  readonly master: GainNode;
  /** master.gain — bound by transport-master-gain's createMasterGainController. The mixer
   *  never writes this after construction; it only exposes it (controller is the single
   *  writer; arch §2.3). */
  readonly masterParam: AudioParam;
  /** duckGain.gain — the bed-only duck. mixer.scheduleDuck is the SOLE writer (D-019). */
  readonly duckParam: AudioParam;

  /** Schedule the bed duck from already-merged spans. Reuses scheduleLane on duckParam,
   *  anchored from the JS-tracked trackedDuck. Re-applies the MIN-toGain overlap merge
   *  defensively. See design §4. */
  scheduleDuck(spans: readonly DuckSpan[], t0: number, startOffsetSec: number): void;

  /** Cancel scheduled duck automation at/after atCtxTime and recover the bed to unity
   *  (1.0) with a short no-click ramp; resets trackedDuck to 1.0. See design §4.5. */
  cancelDuck(atCtxTime: number): void;

  /** Move master's single output edge to target. Re-calling with a new target moves the
   *  one edge (disconnect old, connect new). See design §5. */
  connect(target: AudioNode): void;
  /** Drop master's output edge if present (idempotent; never throws on no-edge). */
  disconnect(): void;

  /** Idempotent teardown: cancel duck automation, disconnect master + every internal node,
   *  go inert. Does NOT close the context or stop sources (owned elsewhere). See design §6. */
  dispose(): void;
}

// ---------------------------------------------------------------------------
// 3. Internal duck-region shape (the within-call merge output)
// ---------------------------------------------------------------------------

/** A coalesced, well-formed duck region in ctx seconds, ready to emit as LanePoints. */
interface DuckRegion {
  attackStart: number; // ctx time the attack ramp begins (startCtx - attackSec)
  startCtx: number; // ctx time the floor is reached (attack ends, hold begins)
  endCtx: number; // ctx time the release begins (hold ends)
  releaseEnd: number; // ctx time unity is regained (endCtx + releaseSec)
  toGain: number; // [0,1] clamped — deepest (MIN) gain across the coalesced cues
}

// ---------------------------------------------------------------------------
// 4. The factory
// ---------------------------------------------------------------------------

/** Build the arch §1 topology and the single bed-duck writer. Total over any real
 *  `BaseAudioContext` (online or offline); originates no error type (interfaces.md §3). */
export function createMixer(ctx: BaseAudioContext, opts?: { masterStart?: number }): Mixer {
  // --- the fixed node graph (design §2) ---
  // bedInput(1.0) → duckGain(1.0) ┐
  //                                ├→ busSum(1.0) → master(0.0) → (target via connect())
  // cueInput(1.0) ────────────────┤
  // liftInput(1.0) ───────────────┘
  const bedInput = ctx.createGain();
  const duckGain = ctx.createGain();
  const cueInput = ctx.createGain();
  const liftInput = ctx.createGain();
  const busSum = ctx.createGain();
  const master = ctx.createGain();

  // Initial gains: everything unity except master (silent start, D-008).
  bedInput.gain.value = UNITY;
  duckGain.gain.value = UNITY; // = "no duck"
  cueInput.gain.value = UNITY;
  liftInput.gain.value = UNITY;
  busSum.gain.value = UNITY;
  // master.gain written EXACTLY ONCE here; the controller is its sole writer thereafter.
  master.gain.value = opts?.masterStart ?? 0;

  // Fixed wiring, once.
  bedInput.connect(duckGain);
  duckGain.connect(busSum);
  cueInput.connect(busSum);
  liftInput.connect(busSum);
  busSum.connect(master);
  // master is NOT connected to any output target here — the consumer calls connect().

  const duckParam = duckGain.gain;

  // --- mutable state ---
  let trackedDuck = UNITY; // JS mirror of the duck envelope value (never read param.value).
  let currentTarget: AudioNode | null = null; // master's current output edge target.
  let disposed = false;

  // --- duck implementation (design §4) ---

  /** Clamp into [0,1] (a duck GAIN outside unity range is meaningless — edge-cases §2). */
  function clampGain(v: number): number {
    return Math.min(1, Math.max(0, v));
  }

  /** Sort + coalesce spans into well-formed DuckRegions (design §4.6 / edge-cases §2,§3).
   *  - non-finite toGain/attackSec/releaseSec → span skipped.
   *  - inverted span (endCtx < startCtx) → skipped; zero-body (startCtx === endCtx) kept.
   *  - toGain clamped to [0,1].
   *  - overlapping regions (prev.releaseEnd >= next.attackStart) coalesce: MIN toGain
   *    (deepest wins), union interval, recover to 1.0 only after the last overlapping cue. */
  function mergeSpans(spans: readonly DuckSpan[]): DuckRegion[] {
    const regions: DuckRegion[] = [];
    for (const s of spans) {
      if (
        !Number.isFinite(s.toGain) ||
        !Number.isFinite(s.attackSec) ||
        !Number.isFinite(s.releaseSec) ||
        !Number.isFinite(s.startCtx) ||
        !Number.isFinite(s.endCtx)
      ) {
        continue; // non-finite field → skip (don't corrupt the single-writer param).
      }
      if (s.endCtx < s.startCtx) continue; // truly inverted → skip.
      const attackSec = Math.max(0, s.attackSec);
      const releaseSec = Math.max(0, s.releaseSec);
      regions.push({
        attackStart: s.startCtx - attackSec,
        startCtx: s.startCtx,
        endCtx: s.endCtx, // startCtx === endCtx is a zero-body region (attack+release only).
        releaseEnd: s.endCtx + releaseSec,
        toGain: clampGain(s.toGain),
      });
    }
    regions.sort((a, b) => a.startCtx - b.startCtx);

    const merged: DuckRegion[] = [];
    for (const r of regions) {
      const prev = merged[merged.length - 1];
      if (prev && prev.releaseEnd >= r.attackStart) {
        // Overlap → coalesce. Deepest (MIN) toGain wins; union the interval; the floor
        // body spans both cues and unity is regained only after the LAST cue's release.
        prev.toGain = Math.min(prev.toGain, r.toGain);
        prev.startCtx = Math.min(prev.startCtx, r.startCtx);
        prev.endCtx = Math.max(prev.endCtx, r.endCtx);
        prev.releaseEnd = Math.max(prev.releaseEnd, r.releaseEnd);
        prev.attackStart = Math.min(prev.attackStart, r.attackStart);
      } else {
        merged.push({ ...r });
      }
    }
    return merged;
  }

  /** Emit the [0,1] duck LanePoints for one region: attack (1.0→toGain), hold, release
   *  (toGain→1.0). Every point is transition:'linear' (duck is linear ONLY). The points
   *  are in ctx-time; scheduleDuck maps them through the (t0, startOffsetSec) origin. */
  function regionPoints(r: DuckRegion): LanePoint[] {
    return [
      { t: r.attackStart, value: UNITY, transition: 'linear' },
      { t: r.startCtx, value: r.toGain, transition: 'linear' },
      { t: r.endCtx, value: r.toGain, transition: 'linear' },
      { t: r.releaseEnd, value: UNITY, transition: 'linear' },
    ];
  }

  /** Pure value-at-t over the full merged-region point list (mid-envelope seek resume,
   *  design §4.4). Outside every region the duck is at unity; inside, linear-interpolate
   *  the active region's envelope. `t` is a ctx-time. */
  function makeValueAt(regions: DuckRegion[]): (t: number) => number {
    return (t: number): number => {
      for (const r of regions) {
        if (t <= r.attackStart || t >= r.releaseEnd) continue;
        if (t < r.startCtx) {
          // attack ramp 1.0 → toGain
          const span = r.startCtx - r.attackStart;
          if (span <= 0) return r.toGain;
          return UNITY + (r.toGain - UNITY) * ((t - r.attackStart) / span);
        }
        if (t <= r.endCtx) return r.toGain; // hold
        // release ramp toGain → 1.0
        const span = r.releaseEnd - r.endCtx;
        if (span <= 0) return UNITY;
        return r.toGain + (UNITY - r.toGain) * ((t - r.endCtx) / span);
      }
      return UNITY;
    };
  }

  function scheduleDuck(
    spans: readonly DuckSpan[],
    t0: number,
    startOffsetSec: number,
  ): void {
    if (disposed) return; // guarded no-op after dispose (edge-cases §6).
    const regions = mergeSpans(spans);
    if (regions.length === 0) {
      // Empty / all-skipped spans → no-op; trackedDuck stays at its current value
      // (edge-cases §1). A duck with no driving cue is simply no duck.
      return;
    }

    // Flatten every region's points into one ascending lane on [0,1] — one scheduleLane
    // call writes the WHOLE envelope, so the single-writer param never gets two ramps.
    const points: LanePoint[] = [];
    for (const r of regions) points.push(...regionPoints(r));

    const valueAt = makeValueAt(regions);
    // The seek anchor is the duck envelope's value AT the seek point — the JS-tracked
    // mirror of where the envelope is at `startOffsetSec`. It is computed from `valueAt`
    // (a pure function over THESE points), NEVER from duckParam.value (D-019; Firefox
    // returns a stale param.value). On a normal start (offset 0, before every region)
    // this is 1.0; on a seek into a region it is the mid-envelope value (design §4.4).
    trackedDuck = valueAt(startOffsetSec);

    // t0 maps span-time origin to the ctx clock; startOffsetSec is the seek point. The
    // region point t's are already ctx-times, so startTime = t0 and we forward
    // startOffsetSec/floorTime exactly as the binaural/layer callers do.
    scheduleLane(duckParam, points, {
      startTime: t0,
      startOffsetSec,
      floorTime: t0, // no event before the live now/anchor (the mapped t0).
      anchorValue: trackedDuck, // JS-tracked seek anchor; NEVER duckParam.value (D-019).
      valueAt, // mid-segment start values for later segments after the seek.
      policy: { stepRampSec: 0, expFallback: true }, // bare linear edges, not the volume fork.
    });

    // Settle trackedDuck to the value the emitted envelope reaches once it is past every
    // region (unity), so a subsequent schedule/cancel anchors correctly.
    if (startOffsetSec >= points[points.length - 1].t) trackedDuck = UNITY;
  }

  function cancelDuck(atCtxTime: number): void {
    if (disposed) return; // guarded no-op after dispose (edge-cases §6).
    // Cancel any scheduled duck automation at/after atCtxTime, then a short no-click rise
    // back to unity anchored from the JS-tracked value (design §4.5).
    const rp = duckParam as AudioParam & {
      cancelAndHoldAtTime?: (cancelTime: number) => void;
    };
    if (typeof rp.cancelAndHoldAtTime === 'function') {
      rp.cancelAndHoldAtTime(atCtxTime);
    } else {
      duckParam.cancelScheduledValues(atCtxTime);
    }
    // Anchor from trackedDuck then ramp up to unity (linear, no click).
    duckParam.setValueAtTime(trackedDuck, atCtxTime);
    duckParam.linearRampToValueAtTime(UNITY, atCtxTime + CANCEL_RECOVER_SEC);
    trackedDuck = UNITY;
  }

  // --- connect / disconnect (move ONLY master's output edge — design §5) ---

  function connect(target: AudioNode): void {
    if (disposed) return; // guarded no-op after dispose (edge-cases §5,§6).
    // Re-establish exactly one master output edge: drop the current one (if any), then
    // connect the new target. Disconnect-first keeps the tracked-target bookkeeping exact
    // and avoids a double edge on a same-target reconnect (edge-cases §5).
    if (currentTarget !== null) {
      safeDisconnect(() => master.disconnect(currentTarget as AudioNode));
    }
    master.connect(target);
    currentTarget = target;
  }

  function disconnect(): void {
    if (disposed) return; // guarded no-op after dispose (edge-cases §5,§6).
    // Only call the platform disconnect when an edge actually exists — a no-edge
    // disconnect would throw InvalidAccessError (edge-cases §5).
    if (currentTarget !== null) {
      safeDisconnect(() => master.disconnect(currentTarget as AudioNode));
      currentTarget = null;
    }
  }

  // --- dispose (idempotent teardown — design §6) ---

  function dispose(): void {
    if (disposed) return; // second+ calls are no-ops (edge-cases §6).
    disposed = true;
    // Cancel pending duck automation — no recover ramp on teardown (the graph is going).
    safeDisconnect(() => duckParam.cancelScheduledValues(0));
    // Drop master's output edge (if any).
    if (currentTarget !== null) {
      safeDisconnect(() => master.disconnect(currentTarget as AudioNode));
      currentTarget = null;
    }
    // Disconnect every internal node, each wrapped so an already-disconnected node
    // never throws. Does NOT stop sources or close the context (owned elsewhere).
    for (const node of [bedInput, duckGain, cueInput, liftInput, busSum, master]) {
      safeDisconnect(() => node.disconnect());
    }
  }

  return {
    bedInput,
    cueInput,
    liftInput,
    master,
    masterParam: master.gain,
    duckParam,
    scheduleDuck,
    cancelDuck,
    connect,
    disconnect,
    dispose,
  };
}

/** Run a teardown/disconnect call, swallowing the platform throw an already-disconnected
 *  or already-cancelled node may raise — the same idempotent pattern transport/voice use. */
function safeDisconnect(fn: () => void): void {
  try {
    fn();
  } catch {
    // best-effort teardown; the node may already be disconnected.
  }
}
