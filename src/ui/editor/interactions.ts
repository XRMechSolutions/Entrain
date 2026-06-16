// interactions.ts — pure editor interaction logic (design §12, edge J). Hit-testing, time
// clamping (neighbour spacing + the nodes[0] pin), pan/zoom window clamping, duration-trim,
// and the two inspector predicates that mirror session-model validation (exp-through-zero,
// edgeMs-exceeds-half-period). All functions are pure: they read the plain preset / geometry
// and RETURN values; the session store performs the actual mutation (and RANGES clamps).

import { RANGES, type AutomatableParam, type Preset, type TimeNode } from '../../engine/session-model';
import { EDITOR_MIN_VIEW_SEC, MIN_NODE_DT_SEC, NODE_HIT_RADIUS_PX } from '../lib/constants';
import { PARAM_ORDER, xOf, yOf, type CanvasLayout, type View } from './canvas-renderer';

export interface NodeHit {
  index: number;
  param: AutomatableParam;
}

/** Find the node handle under a pointer (within NODE_HIT_RADIUS_PX → ≥44px touch target).
 *  Returns the nearest hit across all value lanes, or null. */
export function hitTestNode(
  preset: Preset,
  layout: CanvasLayout,
  view: View,
  px: number,
  py: number,
): NodeHit | null {
  let best: NodeHit | null = null;
  let bestDist = NODE_HIT_RADIUS_PX;
  for (const lane of layout.lanes) {
    preset.nodes.forEach((node, index) => {
      const pp = node[lane.param];
      if (!pp) return;
      const x = xOf(layout, view, node.t);
      const y = yOf(lane, lane.param, pp.value);
      const d = Math.hypot(px - x, py - y);
      if (d <= bestDist) {
        bestDist = d;
        best = { index, param: lane.param };
      }
    });
  }
  return best;
}

/** Which lane (param) contains a y coordinate, for tap-empty-lane add. */
export function laneParamAt(layout: CanvasLayout, py: number): AutomatableParam | null {
  for (const lane of layout.lanes) {
    if (py >= lane.top && py <= lane.top + lane.height) return lane.param;
  }
  return null;
}

/** Clamp a horizontal drag target: nodes[0] is pinned at t=0; other nodes stay within
 *  [0, durationSec] AND ≥ MIN_NODE_DT_SEC from each neighbour (never a duplicate t — J1/J2). */
export function clampMoveTime(preset: Preset, index: number, desiredT: number): number {
  if (index <= 0) return 0; // nodes[0] pinned at t=0
  const nodes = preset.nodes;
  const lo = nodes[index - 1].t + MIN_NODE_DT_SEC;
  const hi = index < nodes.length - 1 ? nodes[index + 1].t - MIN_NODE_DT_SEC : preset.durationSec;
  const lowerBound = Math.max(0, lo);
  const upperBound = Math.min(preset.durationSec, hi);
  if (lowerBound > upperBound) return lowerBound; // degenerate neighbour spacing
  return Math.min(Math.max(desiredT, lowerBound), upperBound);
}

/** Zoom the visible window around centerSec, clamped to [EDITOR_MIN_VIEW_SEC, durationSec]
 *  and kept inside [0, durationSec] (J6). factor < 1 zooms in, > 1 zooms out. */
export function zoomClamp(view: View, durationSec: number, factor: number, centerSec: number): View {
  const span0 = view.endSec - view.startSec || 1;
  const minSpan = Math.min(EDITOR_MIN_VIEW_SEC, durationSec || EDITOR_MIN_VIEW_SEC);
  const maxSpan = Math.max(minSpan, durationSec);
  const span = Math.min(Math.max(span0 * factor, minSpan), maxSpan);
  const rel = (centerSec - view.startSec) / span0;
  let start = centerSec - rel * span;
  start = Math.min(Math.max(start, 0), Math.max(0, durationSec - span));
  return { startSec: start, endSec: start + span };
}

/** Pan the window by deltaSec, keeping it inside [0, durationSec]. */
export function panBy(view: View, durationSec: number, deltaSec: number): View {
  const span = view.endSec - view.startSec;
  let start = view.startSec + deltaSec;
  start = Math.min(Math.max(start, 0), Math.max(0, durationSec - span));
  return { startSec: start, endSec: start + span };
}

/** Trim any node t beyond durationSec to durationSec (J5: never leave a
 *  NODE_T_EXCEEDS_DURATION after a duration decrease). nodes[0] stays at 0. */
export function clampNodesToDuration(nodes: ReadonlyArray<TimeNode>, durationSec: number): TimeNode[] {
  return nodes.map((node, i) => {
    if (i === 0) return { ...node, t: 0 };
    return node.t > durationSec ? { ...node, t: durationSec } : { ...node };
  });
}

// --- Inspector predicates (mirror session-model validation, design §12.1) ----

/** True when an `exp` transition on node[index].<param> would ramp to/through zero —
 *  i.e. this value is 0 or the next node that sets the param has value 0 (mirrors
 *  EXP_RAMP_THROUGH_ZERO; clamped controls never go negative). The inspector greys exp. */
export function expDisabled(preset: Preset, index: number, param: AutomatableParam): boolean {
  const here = preset.nodes[index]?.[param];
  if (!here) return false;
  if (here.value === 0) return true;
  for (let k = index + 1; k < preset.nodes.length; k++) {
    const next = preset.nodes[k][param];
    if (next && next.value !== undefined) return next.value === 0;
  }
  return false;
}

/** True when edgeMs exceeds half the modulator period (mirrors
 *  MOD_EDGE_EXCEEDS_HALF_PERIOD — a warning, not a block). */
export function edgeExceedsHalfPeriod(periodSec: number | undefined, edgeMs: number | undefined): boolean {
  if (periodSec === undefined || edgeMs === undefined) return false;
  return edgeMs > (periodSec * 1000) / 2;
}

/** Clamp a param value to its RANGES (used by vertical drag before session.setNodeValue,
 *  which also clamps — J3). */
export function clampParamValue(param: AutomatableParam, v: number): number {
  const r = RANGES[param];
  return Math.min(r.max, Math.max(r.min, v));
}

export { PARAM_ORDER };
