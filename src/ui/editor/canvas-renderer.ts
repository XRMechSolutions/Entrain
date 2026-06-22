// canvas-renderer.ts — the imperative Phase-2 timeline renderer (design §12). PURE drawing
// + coordinate math; no Svelte, no state ownership. Given a 2D context, the working preset,
// the visible time window, and the layout, it draws the carrier/beat/volume/spatial lanes
// (base curve sampled every CURVE_SAMPLE_PX via automation.baseValueAt), the node handles,
// the stepped waveform lane, and — while playing — a live combined dot at the playhead
// (automation.valueAt). Svelte never re-renders the canvas; TimelineCanvas drives this in a
// rAF loop reading transport.position() directly (edge I3/I4).

import { baseValueAt, valueAt, waveformAt } from '../../engine/automation';
import { RANGES, type AutomatableParam, type Preset } from '../../engine/session-model';
import { CURVE_SAMPLE_PX, NODE_HIT_RADIUS_PX } from '../lib/constants';

/** The visible time window (session seconds). */
export interface View {
  startSec: number;
  endSec: number;
}

/** One value lane's vertical band in CSS pixels. */
export interface Lane {
  param: AutomatableParam;
  top: number;
  height: number;
}

/** The full canvas layout: the horizontal plot band shared by all lanes, the four value
 *  lanes, and the thin waveform strip. */
export interface CanvasLayout {
  width: number;
  height: number;
  laneLeft: number;
  laneWidth: number;
  lanes: Lane[];
  waveform: { top: number; height: number };
}

export const PARAM_ORDER: ReadonlyArray<AutomatableParam> = ['carrier', 'beat', 'volume', 'spatial'];

/** Build a default stacked layout for a canvas of the given CSS size. */
export function computeLayout(width: number, height: number): CanvasLayout {
  const laneLeft = 8;
  const laneWidth = Math.max(1, width - laneLeft - 8);
  const waveformH = 22;
  const usable = Math.max(1, height - waveformH - 8);
  const laneH = usable / PARAM_ORDER.length;
  const lanes: Lane[] = PARAM_ORDER.map((param, i) => ({
    param,
    top: 4 + i * laneH,
    height: laneH - 6,
  }));
  return {
    width,
    height,
    laneLeft,
    laneWidth,
    lanes,
    waveform: { top: 4 + PARAM_ORDER.length * laneH, height: waveformH },
  };
}

// --- Coordinate mapping (design §12) -----------------------------------------

export function xOf(layout: CanvasLayout, view: View, t: number): number {
  const span = view.endSec - view.startSec || 1;
  return layout.laneLeft + ((t - view.startSec) / span) * layout.laneWidth;
}

export function tOf(layout: CanvasLayout, view: View, px: number): number {
  const span = view.endSec - view.startSec || 1;
  return view.startSec + ((px - layout.laneLeft) / layout.laneWidth) * span;
}

export function yOf(lane: Lane, param: AutomatableParam, v: number): number {
  const r = RANGES[param];
  const frac = (v - r.min) / (r.max - r.min || 1);
  return lane.top + lane.height * (1 - frac);
}

export function vOf(lane: Lane, param: AutomatableParam, py: number): number {
  const r = RANGES[param];
  const frac = 1 - (py - lane.top) / (lane.height || 1);
  return r.min + frac * (r.max - r.min);
}

// --- Drawing -----------------------------------------------------------------

export interface RenderState {
  preset: Preset;
  view: View;
  layout: CanvasLayout;
  positionSec: number;
  playing: boolean;
  selected?: { index: number; param: AutomatableParam } | null;
  /** Voice-narration cues to mark on the timeline at their scheduled session times (D-043).
   *  Each is a voice-kind layer's `t` plus a short label (ordinal or the spoken text). Absent
   *  ⇒ no markers (pure-binaural / no narration), so the lane drawing is unchanged. */
  cues?: ReadonlyArray<{ t: number; label: string }>;
}

const COLORS = {
  bg: '#0b0f14',
  laneBg: '#131a22',
  grid: '#27323d',
  curve: '#4aa8ff',
  node: '#e6edf3',
  nodeSel: '#ffb454',
  playhead: '#5ad17a',
  text: '#9aa7b4',
  cue: '#c792ea', // voice-narration cue markers (distinct from beat curves)
};

/** Draw the whole timeline. Idempotent: clears then redraws every element. */
export function renderTimeline(ctx: CanvasRenderingContext2D, state: RenderState): void {
  const { layout } = state;
  ctx.clearRect(0, 0, layout.width, layout.height);
  ctx.fillStyle = COLORS.bg;
  ctx.fillRect(0, 0, layout.width, layout.height);

  for (const lane of layout.lanes) {
    drawLaneBackground(ctx, layout, lane);
    drawBaseCurve(ctx, state, lane);
    drawNodes(ctx, state, lane);
  }
  drawWaveformLane(ctx, state);
  drawVoiceCues(ctx, state);
  if (state.playing) drawPlayhead(ctx, state);
}

/** Mark each voice-narration cue at its scheduled time: a dashed vertical line across the plot,
 *  a speech triangle at the top, and a short label (the spoken text or an ordinal) — so the
 *  scripted narration is visible on the timeline alongside the beat curves (D-043). Cues outside
 *  the visible window are skipped. A no-op when there are no cues. */
function drawVoiceCues(ctx: CanvasRenderingContext2D, state: RenderState): void {
  const cues = state.cues;
  if (!cues || cues.length === 0) return;
  const { layout, view } = state;
  ctx.save();
  ctx.font = '10px system-ui, sans-serif';
  ctx.textBaseline = 'alphabetic';
  for (const cue of cues) {
    const x = xOf(layout, view, cue.t);
    if (x < layout.laneLeft - 2 || x > layout.laneLeft + layout.laneWidth + 2) continue;
    ctx.strokeStyle = COLORS.cue;
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(x, 9);
    ctx.lineTo(x, layout.height);
    ctx.stroke();
    ctx.setLineDash([]);
    // speech triangle marker at the top of the line
    ctx.fillStyle = COLORS.cue;
    ctx.beginPath();
    ctx.moveTo(x, 9);
    ctx.lineTo(x - 4, 2);
    ctx.lineTo(x + 4, 2);
    ctx.closePath();
    ctx.fill();
    ctx.fillText(cue.label, x + 6, 9);
  }
  ctx.restore();
}

function drawLaneBackground(ctx: CanvasRenderingContext2D, layout: CanvasLayout, lane: Lane): void {
  ctx.fillStyle = COLORS.laneBg;
  ctx.fillRect(layout.laneLeft, lane.top, layout.laneWidth, lane.height);
  ctx.strokeStyle = COLORS.grid;
  ctx.lineWidth = 1;
  ctx.strokeRect(layout.laneLeft, lane.top, layout.laneWidth, lane.height);
  ctx.fillStyle = COLORS.text;
  ctx.font = '11px system-ui, sans-serif';
  ctx.fillText(lane.param, layout.laneLeft + 4, lane.top + 12);
}

function drawBaseCurve(ctx: CanvasRenderingContext2D, state: RenderState, lane: Lane): void {
  const { layout, view, preset } = state;
  ctx.beginPath();
  ctx.strokeStyle = COLORS.curve;
  ctx.lineWidth = 2;
  let first = true;
  for (let px = 0; px <= layout.laneWidth; px += CURVE_SAMPLE_PX) {
    const t = tOf(layout, view, layout.laneLeft + px);
    const v = baseValueAt(preset, lane.param, Math.max(0, Math.min(preset.durationSec, t)));
    const x = layout.laneLeft + px;
    const y = yOf(lane, lane.param, v);
    if (first) {
      ctx.moveTo(x, y);
      first = false;
    } else {
      ctx.lineTo(x, y);
    }
  }
  ctx.stroke();
}

function drawNodes(ctx: CanvasRenderingContext2D, state: RenderState, lane: Lane): void {
  const { layout, view, preset, selected } = state;
  preset.nodes.forEach((node, index) => {
    const pp = node[lane.param];
    if (!pp) return;
    const x = xOf(layout, view, node.t);
    if (x < layout.laneLeft - NODE_HIT_RADIUS_PX || x > layout.laneLeft + layout.laneWidth + NODE_HIT_RADIUS_PX) return;
    const y = yOf(lane, lane.param, pp.value);
    const isSel = selected != null && selected.index === index && selected.param === lane.param;
    ctx.beginPath();
    ctx.fillStyle = isSel ? COLORS.nodeSel : COLORS.node;
    ctx.arc(x, y, 6, 0, Math.PI * 2);
    ctx.fill();
    if (pp.mod) {
      // warble glyph: a small ring indicating a modulator is present (period/depth not
      // drawn per-sample, design §12).
      ctx.beginPath();
      ctx.strokeStyle = COLORS.nodeSel;
      ctx.lineWidth = 1.5;
      ctx.arc(x, y, 10, 0, Math.PI * 2);
      ctx.stroke();
    }
  });
}

function drawWaveformLane(ctx: CanvasRenderingContext2D, state: RenderState): void {
  const { layout, view, preset } = state;
  const { top, height } = layout.waveform;
  ctx.fillStyle = COLORS.laneBg;
  ctx.fillRect(layout.laneLeft, top, layout.laneWidth, height);
  ctx.fillStyle = COLORS.text;
  ctx.font = '10px system-ui, sans-serif';
  let lastLabel = '';
  for (let px = 0; px <= layout.laneWidth; px += 24) {
    const t = tOf(layout, view, layout.laneLeft + px);
    const wf = waveformAt(preset, Math.max(0, Math.min(preset.durationSec, t)));
    if (wf !== lastLabel) {
      ctx.fillText(wf, layout.laneLeft + px + 2, top + 14);
      lastLabel = wf;
    }
  }
}

// --- The render loop (design §12 "Render loop") ------------------------------

/** A rAF-driven redraw loop, kept out of Svelte's scheduler (edge I3/I4). It redraws when
 *  marked dirty (any edit/pan/zoom) AND every frame while playing — reading the playhead
 *  from `position()` (i.e. transport.position()) DIRECTLY each frame, never a $state mirror.
 *  Extracted from the component so the start/stop/dirty/while-playing behaviour is unit
 *  testable without a 2D canvas (jsdom has none). */
export interface RenderLoop {
  start(): void;
  stop(): void;
  markDirty(): void;
  readonly running: boolean;
}

export function createRenderLoop(opts: {
  draw: (positionSec: number) => void;
  isPlaying: () => boolean;
  position: () => number;
  raf?: (cb: FrameRequestCallback) => number;
  caf?: (handle: number) => void;
}): RenderLoop {
  const raf = opts.raf ?? requestAnimationFrame;
  const caf = opts.caf ?? cancelAnimationFrame;
  let handle: number | undefined;
  let dirty = true; // draw once on start
  let running = false;

  const frame = (): void => {
    const playing = opts.isPlaying();
    if (dirty || playing) {
      dirty = false;
      opts.draw(opts.position()); // read transport.position() directly each frame
    }
    handle = raf(frame);
  };

  return {
    start(): void {
      if (running) return;
      running = true;
      dirty = true;
      handle = raf(frame);
    },
    stop(): void {
      running = false;
      if (handle !== undefined) caf(handle);
      handle = undefined;
    },
    markDirty(): void {
      dirty = true;
    },
    get running() {
      return running;
    },
  };
}

function drawPlayhead(ctx: CanvasRenderingContext2D, state: RenderState): void {
  const { layout, view, preset, positionSec } = state;
  const x = xOf(layout, view, positionSec);
  ctx.strokeStyle = COLORS.playhead;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(x, 0);
  ctx.lineTo(x, layout.height);
  ctx.stroke();
  // Live combined dot (base + modulator) per lane at the playhead.
  for (const lane of layout.lanes) {
    const v = valueAt(preset, lane.param, Math.max(0, Math.min(preset.durationSec, positionSec)));
    ctx.beginPath();
    ctx.fillStyle = COLORS.playhead;
    ctx.arc(x, yOf(lane, lane.param, v), 4, 0, Math.PI * 2);
    ctx.fill();
  }
}
