// layer-scheduler — Layer-1 timeline driver for stacked layers (Web Audio only).
//
// The `automation.scheduleAll` analogue for `Preset.layers[]`. Given caller-built,
// caller-routed `LayerNode`s, it: (1) schedules each layer's gain/pan lane onto the
// node's params via the shared `scheduleLane` primitive (D-008 no-click, D-019
// single-writer); (2) starts each node's source at its absolute placement when in
// range (with the seek intra-offset); and (3) computes + MERGES the bed-duck envelope
// from `voice`-kind cue layers and installs it once per merged region via
// `mixer.scheduleDuck`. Pure Web Audio against the mixer's `BaseAudioContext` (no
// transport globals), so `renderer` reuses the identical call offline.
//
// It builds NO AudioNodes and writes NO AudioParam directly — every gain/pan edge goes
// through `scheduleLane`, every duck edge through `mixer.scheduleDuck`. Its only
// original code is pure arithmetic: the relative→absolute time shift and the duck-span
// merge. See .dev/planning/modules/layer-scheduler/{design,interfaces,edge-cases}.md
// and .dev/planning/phase2-audio-architecture.md §3/§4/§6 (NORMATIVE).

import type { Layer, LanePoint } from './session-model';
import type { Mixer, DuckSpan } from './mixer';
import type { LayerNode } from './layer-engine';
import { scheduleLane, VOLUME_MICRORAMP_SEC, RETARGET_LOOKAHEAD_SEC } from './automation';

// ---------------------------------------------------------------------------
// 1. Public types (interfaces.md §2/§3)
// ---------------------------------------------------------------------------

/** Construction options for scheduleLayers. The arch §6 `opts` shape, named. */
export interface ScheduleLayersOpts {
  /** ctx-clock time mapped to SESSION time = startOffsetSec. Identical to the value
   *  transport passes scheduler.apply / scheduleAll: the moment playback of
   *  `startOffsetSec` begins. */
  t0: number;
  /** Session-second the (re)build starts at (seek position; 0 at a fresh start).
   *  Nothing earlier than this is scheduled or started. */
  startOffsetSec: number;
}

/** The handle returned by scheduleLayers. Mirrors automation's SessionSchedule so
 *  transport injects/tears down layers with the SAME lifecycle code. */
export interface LayerSchedule {
  /** LIVE EDIT at the CURRENT position: re-ramp every gain/pan lane to the edited
   *  values from `atCtx`, and re-merge + re-install the duck from `atCtx`. Sources keep
   *  running (no start/stop, no click). `atCtx` defaults to the mixer-ctx currentTime
   *  + RETARGET_LOOKAHEAD_SEC. No-op after dispose. */
  retarget(layers: readonly Layer[], atCtx?: number): void;
  /** TEARDOWN of scheduling only: cancel every lane's future gain/pan events at the
   *  current ctx time (each param HOLDS) and cancel the duck (bed recovers to 1.0).
   *  Does NOT stop or dispose the LayerNodes (one-shots cannot restart). No-op after
   *  dispose. */
  cancel(): void;
  /** Release every scheduler-owned reference. Idempotent. After dispose,
   *  retarget/cancel are no-ops. Does NOT touch the LayerNodes or the mixer graph. */
  dispose(): void;
}

// ---------------------------------------------------------------------------
// 2. Pure time-composition helpers (design §3, exported for direct unit testing)
// ---------------------------------------------------------------------------

const UNITY = 1; // absent gain lane = constant unity (session-model §11.4)
const CENTER = 0; // absent pan lane = center

/** Shift every LanePoint's RELATIVE `t` by `+layerT` into ABSOLUTE session seconds
 *  (value/transition unchanged). An absent/empty lane shifts to an empty list. The
 *  layer's `LanePoint.t` is relative to the layer's start; this lifts it onto the same
 *  absolute session timebase the binaural voice uses, so a single `startOffsetSec`
 *  drives every lane (design §3 "why shift the points"). */
export function absPoints(
  points: readonly LanePoint[] | undefined,
  layerT: number,
): LanePoint[] {
  if (!points || points.length === 0) return [];
  return points.map((p) => ({ t: p.t + layerT, value: p.value, transition: p.transition }));
}

/** Pure carry-forward + transition evaluator over ALREADY-SHIFTED (absolute session)
 *  points — the layer analogue of automation.baseValueAt (single value, no modulator).
 *  Constant before the first point, held after the last, interpolated between by each
 *  point's ParamTransition. An empty list returns `fallback` (gain unity, pan center). */
export function laneValueAt(
  absPts: readonly LanePoint[],
  t: number,
  fallback: number,
): number {
  if (absPts.length === 0) return fallback;
  if (t <= absPts[0].t) return absPts[0].value; // carry-forward before the first point
  const last = absPts[absPts.length - 1];
  if (t >= last.t) return last.value; // hold after the last point
  for (let i = 0; i + 1 < absPts.length; i++) {
    const ti = absPts[i].t;
    const tj = absPts[i + 1].t;
    if (t >= ti && t < tj) {
      const a = absPts[i].value;
      const b = absPts[i + 1].value;
      const frac = (t - ti) / (tj - ti);
      return laneTransition(a, b, frac, absPts[i].transition ?? 'linear');
    }
  }
  return last.value; // unreachable (t is within [first, last))
}

function laneTransition(a: number, b: number, frac: number, transition: string): number {
  switch (transition) {
    case 'hold':
      return a;
    case 'smooth':
      return a + (b - a) * (frac * frac * (3 - 2 * frac));
    case 'exp':
      return expValid(a, b) ? a * Math.pow(b / a, frac) : a + (b - a) * frac;
    case 'linear':
    default:
      return a + (b - a) * frac;
  }
}

function expValid(a: number, b: number): boolean {
  return (
    Number.isFinite(a) &&
    Number.isFinite(b) &&
    a !== 0 &&
    b !== 0 &&
    Math.sign(a) === Math.sign(b)
  );
}

// ---------------------------------------------------------------------------
// 3. Duck-span computation + merge (design §5, exported for direct unit testing)
// ---------------------------------------------------------------------------

/** A coalesced bed-duck region in SESSION seconds (design §5.2). `attackStart` is where
 *  the bed begins dipping; `releaseEnd` is where unity is regained. */
interface MergedRegion {
  attackStart: number; // session time the attack ramp begins
  releaseEnd: number; // session time unity is regained
  attackSec: number; // first contributing cue's attack
  releaseSec: number; // last contributing cue's release
  toGain: number; // deepest (MIN) gain across the coalesced cues
}

/** Compute the merged bed-duck regions from the voice-kind cue layers (design §5).
 *
 *  RAW SPANS: each `voice`-kind layer whose `layer.duck` is a session-model DuckIntent
 *  contributes a raw span. The cue's audible BODY spans `[L.t, L.t + node.durationSec]`
 *  (the paired LayerNode carries the decoded clip's `durationSec`), so the bed holds its
 *  dip across the whole cue, not just at onset: the floor is reached at `L.t` (after the
 *  attack ramps INTO it) and the release begins at `L.t + node.durationSec` (ramping OUT
 *  after the cue ends). A `voice` layer with no `duck` produces no span, and a non-voice
 *  layer carrying a `duck` is ignored. A node missing for a cue (durationSec 0) collapses
 *  to a zero-body dip at `L.t` — the attack/release still shape a point dip.
 *
 *  MERGE: sort ascending by `attackStart`; forward-walk coalescing while
 *  `current.releaseEnd >= next.attackStart` (touch-or-overlap), taking `releaseEnd =
 *  max(...)` (union) and `toGain = min(...)` (DEEPEST DUCK WINS). The result is one
 *  monotonic region per coalesced group: the bed recovers to 1.0 only after the last
 *  overlapping cue. All times are SESSION seconds. */
export function mergeDuckSpans(pairs: readonly Pair[]): MergedRegion[] {
  const raw: MergedRegion[] = [];
  for (const { node, layer } of pairs) {
    if (layer.kind !== 'voice') continue; // only voice-kind cues drive the bed duck (§3h)
    const duck = layer.duck;
    if (!duck) continue; // a cue with no DuckIntent does not duck (§3f)
    const attackSec = Math.max(0, duck.attackSec);
    const releaseSec = Math.max(0, duck.releaseSec);
    const bodySec = Math.max(0, node.durationSec); // cue body length (clip durationSec)
    raw.push({
      attackStart: layer.t - attackSec, // bed begins dipping `attackSec` before the cue floor
      releaseEnd: layer.t + bodySec + releaseSec, // unity regained `releaseSec` after the cue BODY
      attackSec,
      releaseSec,
      toGain: duck.toGain,
    });
  }

  raw.sort((a, b) => a.attackStart - b.attackStart);

  const merged: MergedRegion[] = [];
  for (const r of raw) {
    const prev = merged[merged.length - 1];
    if (prev && prev.releaseEnd >= r.attackStart) {
      // Overlap (or exact abut) → coalesce. Deepest (MIN) toGain wins; union the
      // interval; the release/recover belongs to the LATER-finishing cue.
      if (r.releaseEnd >= prev.releaseEnd) prev.releaseSec = r.releaseSec; // later cue owns recovery
      prev.releaseEnd = Math.max(prev.releaseEnd, r.releaseEnd);
      prev.toGain = Math.min(prev.toGain, r.toGain);
    } else {
      merged.push({ ...r });
    }
  }
  return merged;
}

/** Map a merged session-time region to the mixer's DuckSpan shape. The mixer derives
 *  `attackStart = startCtx - attackSec` and `releaseEnd = endCtx + releaseSec`, so
 *  `startCtx`/`endCtx` carry the floor-reached / release-begin instants in SESSION
 *  seconds; `mixer.scheduleDuck` maps them to ctx time via (t0, startOffsetSec). */
function regionToSpan(r: MergedRegion): DuckSpan {
  return {
    startCtx: r.attackStart + r.attackSec, // floor reached (attack ends)
    endCtx: r.releaseEnd - r.releaseSec, // release begins (hold ends)
    toGain: r.toGain,
    attackSec: r.attackSec,
    releaseSec: r.releaseSec,
  };
}

// ---------------------------------------------------------------------------
// 4. The factory (interfaces.md §3)
// ---------------------------------------------------------------------------

/** Pair `nodes[i]` ↔ `layers[i]`, cross-checking `node.id === layer.id` so a mis-built
 *  array degrades to skip-that-layer rather than mis-routing a lane (edge-cases §7). */
interface Pair {
  node: LayerNode;
  layer: Layer;
}

function pairByIndexAndId(
  nodes: readonly LayerNode[],
  layers: readonly Layer[],
): Pair[] {
  const out: Pair[] = [];
  const layerById = new Map<string, Layer>();
  for (const l of layers) layerById.set(l.id, l);
  const n = Math.min(nodes.length, layers.length);
  const used = new Set<LayerNode>();
  // Fast path: index-parallel pairs whose ids agree (the contract).
  for (let i = 0; i < n; i++) {
    if (nodes[i].id === layers[i].id) {
      out.push({ node: nodes[i], layer: layers[i] });
      used.add(nodes[i]);
    }
  }
  // Defensive path: any remaining node matched to a layer by id (length mismatch /
  // reorder). A node with no matching layer is left inert (§7b).
  if (out.length < nodes.length) {
    for (const node of nodes) {
      if (used.has(node)) continue;
      const layer = layerById.get(node.id);
      if (layer) {
        out.push({ node, layer });
        used.add(node);
      }
    }
  }
  return out;
}

/** Schedule every layer's gain + pan lane onto its LayerNode, start each node's source
 *  in range, and install the merged bed-duck envelope. Pure Web Audio against `mixer`'s
 *  context — no transport globals, so renderer reuses it offline byte-for-byte.
 *
 *  - Maps each layer's RELATIVE lane time to ctx time as
 *      ctxTime = t0 + (layer.t + lanePoint.t - startOffsetSec)
 *    via scheduleLane's startTime/startOffsetSec/floorTime (design §3). NEVER schedules
 *    before t0.
 *  - gain lane → scheduleLane(node.gainParam, absPoints(layer.gain, layer.t),
 *      { policy:{ stepRampSec: VOLUME_MICRORAMP_SEC } }).
 *  - pan  lane → scheduleLane(node.panParam, absPoints(layer.spatial, layer.t),
 *      { policy:{ stepRampSec: 0 } }).
 *  - node.start(t0 + layer.t - startOffsetSec) when the layer is in range at/after
 *    startOffsetSec; seek mid-layer starts at t0 (engine advances the buffer);
 *    out-of-range one-shots are NOT started.
 *  - Computes duck spans from voice-kind layers whose `layer.duck` is a DuckIntent, spanning
 *    the held dip across the cue's BODY [L.t, L.t + node.durationSec] (the paired node carries
 *    the clip duration), MERGES overlaps (prev.releaseEnd >= next.attackStart, MIN toGain), and
 *    calls mixer.scheduleDuck ONCE per merged region (design §5). */
export function scheduleLayers(
  mixer: Mixer,
  nodes: readonly LayerNode[],
  layers: readonly Layer[],
  opts: ScheduleLayersOpts,
): LayerSchedule {
  const { t0, startOffsetSec } = opts;

  let disposed = false;
  // Keep the node references (paired by id on each retarget) and the mixer for the
  // handle. No AudioNodes are owned — these are caller-built.
  let currentNodes: readonly LayerNode[] = nodes;

  // --- the per-pair scheduling pass (shared by the initial schedule and retarget) ---
  function scheduleLanesAndStart(
    pairs: Pair[],
    laneT0: number,
    laneOffset: number,
    floorTime: number,
    startSources: boolean,
  ): void {
    for (const { node, layer } of pairs) {
      if (!inRange(layer, laneOffset)) continue; // out-of-range: no lanes, no start (§4)

      // gain lane — micro-ramp on a step like the binaural volume lane (D-008).
      const gainAbs = absPoints(layer.gain, layer.t);
      scheduleLane(node.gainParam, gainAbs, {
        startTime: laneT0,
        startOffsetSec: laneOffset,
        floorTime,
        anchorValue: laneValueAt(gainAbs, laneOffset, UNITY),
        valueAt: (t) => laneValueAt(gainAbs, t, UNITY),
        policy: { stepRampSec: VOLUME_MICRORAMP_SEC, expFallback: true },
      });

      // pan lane — bare setValueAtTime step (matching the freq/spatial fork).
      const panAbs = absPoints(layer.spatial, layer.t);
      scheduleLane(node.panParam, panAbs, {
        startTime: laneT0,
        startOffsetSec: laneOffset,
        floorTime,
        anchorValue: laneValueAt(panAbs, laneOffset, CENTER),
        valueAt: (t) => laneValueAt(panAbs, t, CENTER),
        policy: { stepRampSec: 0, expFallback: true },
      });

      // Start the source in range. node.start clamps a mid-layer seek to laneT0; the
      // engine advances the buffer by (startOffsetSec - L.t). One-shots self-stop;
      // loops stop on dispose. NOT done on retarget (sources keep running, design §6).
      if (startSources) {
        const nodeStartCtx = laneT0 + (layer.t - laneOffset);
        node.start(Math.max(nodeStartCtx, laneT0));
      }
    }
  }

  // --- initial schedule ---
  const initialPairs = pairByIndexAndId(nodes, layers);
  scheduleLanesAndStart(initialPairs, t0, startOffsetSec, t0, true);
  // Install the merged bed-duck once, all regions in a single scheduleDuck call.
  const initialRegions = mergeDuckSpans(initialPairs);
  if (initialRegions.length > 0) {
    mixer.scheduleDuck(initialRegions.map(regionToSpan), t0, startOffsetSec);
  }

  // --- the public handle ---
  const handle: LayerSchedule = {
    retarget(editedLayers: readonly Layer[], atCtx?: number): void {
      if (disposed) return; // no-op after dispose (§6d)
      const now = mixerNow(mixer);
      const tr = Math.max(atCtx ?? now + RETARGET_LOOKAHEAD_SEC, now);
      // The retarget offset under the original mapping: where on the session timeline
      // `tr` lands. The lane re-ramps from `tr` to the edited values; sources keep
      // running (NO start/stop), so this drives only the gain/pan lanes + the duck.
      const offset = startOffsetSec + (tr - t0);
      const pairs = pairByIndexAndId(currentNodes, editedLayers);
      // Cancel-and-hold each lane's param at `tr` BEFORE rescheduling so the new ramps
      // replace (not stack on top of) the old ones — the automation retarget pattern.
      // scheduleLane only appends; without this, stale ramps would survive (design §6a).
      for (const { node } of pairs) {
        cancelParamAt(node.gainParam, tr);
        cancelParamAt(node.panParam, tr);
      }
      scheduleLanesAndStart(pairs, tr, offset, tr, false);
      // Re-merge + re-install the duck from the edited layers, from `tr`.
      const regions = mergeDuckSpans(pairs);
      if (regions.length > 0) {
        mixer.scheduleDuck(regions.map(regionToSpan), tr, offset);
      } else {
        // The edit removed every cue → cancel the bed duck so it recovers (§6e tolerant).
        mixer.cancelDuck(tr);
      }
    },

    cancel(): void {
      if (disposed) return; // no-op after dispose (§6d)
      const now = mixerNow(mixer);
      // Cancel each lane's future gain/pan events at now; the param HOLDS its value.
      for (const node of currentNodes) {
        cancelParamAt(node.gainParam, now);
        cancelParamAt(node.panParam, now);
      }
      // Cancel the duck (bed recovers to 1.0). Tolerated no-op when no duck was installed.
      mixer.cancelDuck(now);
    },

    dispose(): void {
      if (disposed) return; // idempotent (§6d)
      disposed = true;
      currentNodes = [];
    },
  };

  return handle;
}

// ---------------------------------------------------------------------------
// 5. Range + small param/ctx helpers
// ---------------------------------------------------------------------------

/** Whether a layer is in range at the given session offset (design §4). A looping clip
 *  is UNBOUNDED (always in range for any offset >= L.t). A one-shot's natural length is
 *  the tone ADSR length or the clip duration; lacking the buffer here, a non-looping
 *  layer is in range whenever the offset is at/before its placement OR it has begun — we
 *  conservatively keep it in range for offset within a generous bound. A one-shot fully
 *  ended before the offset is left inert (no lanes, no start). */
function inRange(layer: Layer, offset: number): boolean {
  // A looping clip (ambiance) never ends before the seek target (unbounded length).
  if (layer.loop === true) return true;
  // For tone one-shots we know the envelope length; an offset past it is out-of-range.
  if (layer.kind === 'tone' && 'synth' in layer.source) {
    const synth = layer.source.synth;
    const layerEnd = synth.attackSec + synth.releaseSec;
    return offset < layer.t + layerEnd;
  }
  // Voice/ambiance clip without a known duration here: in range from t=0 onward (the
  // node is harmless to start; a finished cue self-stops). The duration-bounded
  // out-of-range trim for clips is the caller's rebuild concern (design §4 ownership).
  return true;
}

/** Read the mixer's context clock — used ONLY for the retarget/cancel default time,
 *  never to anchor a param value (design §8 / dependencies.md). */
function mixerNow(mixer: Mixer): number {
  const ctx = (mixer.master as AudioNode).context;
  return ctx ? ctx.currentTime : 0;
}

/** Cancel a param's future events at `t`, holding its current value (cancel == automation
 *  stop semantics). Uses cancelAndHoldAtTime when available; falls back to
 *  cancelScheduledValues (Firefox) — never reads param.value (D-019). */
function cancelParamAt(param: AudioParam, t: number): void {
  const rp = param as AudioParam & { cancelAndHoldAtTime?: (cancelTime: number) => void };
  if (typeof rp.cancelAndHoldAtTime === 'function') {
    rp.cancelAndHoldAtTime(t);
  } else {
    param.cancelScheduledValues(t);
  }
}
