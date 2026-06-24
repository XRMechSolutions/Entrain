// drift — derive a transient "drift deeper" preset for the sleep "drop me back to sleep" nudge.
//
// Pure, framework-agnostic transform: given the loaded preset and the live playhead, return a
// NEW preset whose PRIMARY voice carrier + beat lanes dip toward a deeper (lower) target for a
// few minutes, then rejoin the original curve exactly where it would have been. Every other lane
// (volume, spatial, waveform), every modulator (the slow breath-warble carries through, since the
// dip keyframes set no `mod`), and every extra voice / layer is preserved verbatim. The caller
// retargets the running session to this preset (transport.retargetTo) — a transient overlay that
// never edits, dirties, or saves the underlying preset.
//
// Depends down only on session-model (types/RANGES/sortNodes) and automation (baseValueAt, the
// base-curve value used for both the continuity anchor and the rejoin target). Never mutates the
// input preset; never throws.

import { baseValueAt } from './automation';
import {
  RANGES,
  sortNodes,
  type ParamTransition,
  type Preset,
  type TimeNode,
} from './session-model';

/** A "drift deeper" lane is one of the two binaural-defining lanes the nudge bends downward. */
type DriftLane = 'carrier' | 'beat';

export interface DriftOptions {
  /** The deep binaural beat (Hz) to settle toward; the dip never RAISES the beat, so a beat
   *  already below this is left where it is. Default 2.5 (delta). */
  beatTargetHz?: number;
  /** Never push the beat below this — keep it perceptible as a binaural beat. Default 1.5. */
  beatFloorHz?: number;
  /** Lower the carrier by this many Hz for a "heavier" tone (floored at the carrier min).
   *  Default 20. */
  carrierDropHz?: number;
  /** Glide-down time from the current value to the deep target. Default 45 s. */
  descendSec?: number;
  /** Time held at the deep target. Default 240 s (4 min). */
  holdSec?: number;
  /** Glide back up onto the original curve. Default 90 s. */
  rejoinSec?: number;
}

export const DRIFT_DEFAULTS = {
  beatTargetHz: 2.5,
  beatFloorHz: 1.5,
  carrierDropHz: 20,
  descendSec: 45,
  holdSec: 240,
  rejoinSec: 90,
} as const;

/** Two keyframe times are "the same node" when within this tolerance — the live playhead is a
 *  float, so a dip time may land a hair off an existing integer-t node; merge rather than risk a
 *  duplicate-t (which session-model rejects). */
const SAME_T_EPS = 1e-6;

/** The session-time span a drift dip occupies: from the press position to where it rejoins the
 *  original curve. The caller (session store) uses it to know when the overlay is "active" — so
 *  the monitor reflects the dip while it runs and reverts once the track rejoins. */
export interface DriftWindow {
  startSec: number;
  endSec: number;
}

/** Compute the dip window for `deriveDriftPreset(base, atSec, opts)` WITHOUT building the preset.
 *  `endSec <= startSec` (degenerate) means there is no room to dip + rejoin before the session
 *  ends, i.e. deriveDriftPreset would return the track unchanged. */
export function driftWindow(base: Preset, atSec: number, opts?: DriftOptions): DriftWindow {
  const o = { ...DRIFT_DEFAULTS, ...opts };
  const dur = base.durationSec;
  const startSec = Math.min(Math.max(0, atSec), dur);
  const deepT = Math.min(startSec + o.descendSec, dur);
  const holdEndT = Math.min(deepT + o.holdSec, dur);
  const endSec = Math.min(holdEndT + o.rejoinSec, dur);
  return { startSec, endSec };
}

/**
 * Derive a transient deeper-sleep preset from `base`, dipping at the live position `atSec`.
 * Returns a NEW preset (deep clone); `base` is never mutated. When there is no meaningful room
 * left before the session ends (the rejoin would not fit) the clone is returned unchanged.
 */
export function deriveDriftPreset(base: Preset, atSec: number, opts?: DriftOptions): Preset {
  const o = { ...DRIFT_DEFAULTS, ...opts };
  const clone = structuredClone(base);
  const dur = clone.durationSec;

  // Window endpoints, each clamped within the session so the rejoin always lands on the timeline.
  const startT = Math.min(Math.max(0, atSec), dur);
  const deepT = Math.min(startT + o.descendSec, dur);
  const holdEndT = Math.min(deepT + o.holdSec, dur);
  const rejoinT = Math.min(holdEndT + o.rejoinSec, dur);
  // Nothing worth doing if the descend + rejoin can't fit before the session ends.
  if (rejoinT <= startT + 1) return clone;

  rewriteDipLane(clone, base, 'carrier', startT, deepT, holdEndT, rejoinT, (cur) =>
    clampLane('carrier', cur - o.carrierDropHz),
  );
  rewriteDipLane(clone, base, 'beat', startT, deepT, holdEndT, rejoinT, (cur) => {
    if (cur <= 0) return 0; // a non-binaural (isochronic) voice has nothing to deepen
    return clampLane('beat', Math.max(o.beatFloorHz, Math.min(cur, o.beatTargetHz)));
  });

  return clone;
}

/** Rewrite one lane of `clone.nodes` into the descend→hold→rejoin dip. Values are read from the
 *  ORIGINAL `base` (the clone's in-window keyframes are about to be stripped). */
function rewriteDipLane(
  clone: Preset,
  base: Preset,
  lane: DriftLane,
  startT: number,
  deepT: number,
  holdEndT: number,
  rejoinT: number,
  deepValueFor: (current: number) => number,
): void {
  const curVal = baseValueAt(base, lane, startT); // base-curve value (no modulator) at the playhead
  const rejoinVal = baseValueAt(base, lane, rejoinT); // where the original curve will be at rejoin
  const deep = deepValueFor(curVal);

  // 1. Strip this lane's keyframes STRICTLY inside the window so the dip is its only driver.
  //    Only the lane field is removed; the node (and its other lanes) is kept — a bare `{ t }`
  //    node is valid and contributes to no lane.
  for (const node of clone.nodes) {
    if (node.t > startT && node.t < rejoinT && node[lane]) delete node[lane];
  }

  // 2. Lay down the dip keyframes. The anchor holds the CURRENT value so the retarget re-ramps
  //    from where the lane already is (no step). Transitions govern the segment AFTER each
  //    keyframe: smooth descent → flat hold → smooth rejoin. No `mod` anywhere ⇒ the active
  //    warble span carries through untouched.
  upsertLane(clone.nodes, startT, lane, { value: curVal, transition: 'smooth' });
  upsertLane(clone.nodes, deepT, lane, { value: deep, transition: 'hold' });
  upsertLane(clone.nodes, holdEndT, lane, { value: deep, transition: 'smooth' });
  upsertLane(clone.nodes, rejoinT, lane, { value: rejoinVal });

  clone.nodes = sortNodes(clone.nodes);
}

/** Set `lane` on the node at time `t` (within tolerance), creating the node if none exists. */
function upsertLane(
  nodes: TimeNode[],
  t: number,
  lane: DriftLane,
  point: { value: number; transition?: ParamTransition },
): void {
  const existing = nodes.find((n) => Math.abs(n.t - t) < SAME_T_EPS);
  if (existing) existing[lane] = { ...point };
  else nodes.push({ t, [lane]: { ...point } });
}

function clampLane(lane: DriftLane, v: number): number {
  const r = RANGES[lane];
  return Math.min(r.max, Math.max(r.min, v));
}
