<!-- TimelineCanvas — the single <canvas> Svelte renders ONCE (design §12, edge I3/I4).
     All drawing is imperative via canvas-renderer in a rAF loop that reads
     transport.position() DIRECTLY each frame; Svelte never re-renders the canvas. Pointer
     gestures mutate the plain preset through the session store (which clamps + reapplies).
     The loop is started on mount and cancelled on unmount. -->
<script lang="ts">
  import { onMount, untrack } from 'svelte';
  import { getAppContext } from '../context';
  import { EDITOR_MIN_VIEW_SEC } from '../lib/constants';
  import {
    computeLayout,
    createRenderLoop,
    renderTimeline,
    tOf,
    vOf,
    type CanvasLayout,
    type View,
  } from './canvas-renderer';
  import {
    clampMoveTime,
    clampParamValue,
    hitTestNode,
    laneParamAt,
    zoomClamp,
    panBy,
    type NodeHit,
  } from './interactions';

  interface Props {
    selected: NodeHit | null;
    onselect: (hit: NodeHit | null) => void;
    activeVoiceId?: string;
  }
  let { selected, onselect, activeVoiceId }: Props = $props();

  const { transport, session, playback, clips } = getAppContext();

  /** Build the narration cue markers (D-043): one per voice-kind layer, at its scheduled `t`,
   *  labelled with the spoken text from the clip library (falling back to a musical ordinal
   *  before the clip is synthesized). Session-global — drawn regardless of the active voice. */
  function buildCues(): Array<{ t: number; label: string }> {
    const layers = session.preset.layers ?? [];
    const out: Array<{ t: number; label: string }> = [];
    let n = 0;
    for (const l of layers) {
      if (l.kind !== 'voice') continue;
      n++;
      const clipId = (l.source as { clipId?: string }).clipId;
      const clip = clipId ? clips.clips.find((c) => c.id === clipId) : undefined;
      const text = clip?.meta.text ?? clip?.meta.name;
      const label = text ? (text.length > 28 ? `${text.slice(0, 27)}…` : text) : `♪ ${n}`;
      out.push({ t: l.t, label });
    }
    return out;
  }

  let canvasEl: HTMLCanvasElement;
  let ctx2d: CanvasRenderingContext2D | null = null;
  let layout: CanvasLayout = computeLayout(640, 360);
  let view = $state<View>({ startSec: 0, endSec: EDITOR_MIN_VIEW_SEC });

  let dragging: NodeHit | null = null;
  let downAt: { x: number; y: number } | null = null;
  let moved = false;

  const loop = createRenderLoop({
    draw: (positionSec) => {
      if (!ctx2d) return;
      renderTimeline(ctx2d, {
        preset: session.voiceView(activeVoiceId),
        view,
        layout,
        positionSec,
        playing: playback.state === 'playing',
        selected,
        cues: buildCues(),
      });
    },
    isPlaying: () => playback.state === 'playing',
    position: () => transport.position(),
  });

  // Mark the loop dirty on any edit, view change, selection change, or voice switch — flips a
  // flag, never re-renders the <canvas> element (purity).
  $effect(() => {
    void session.revision;
    void view;
    void selected;
    void activeVoiceId;
    void clips.clips; // redraw when narration clips load so cue labels fill in (D-043)
    loop.markDirty();
  });

  // When the session DURATION changes (a chip / field edit), re-fit the visible window to the
  // new full span so the timeline reflects the new length at once (§D). A plain `let` (not
  // $state) tracks the last duration so a NORMAL edit — which bumps revision but leaves the
  // duration unchanged — never resets the user's pan/zoom.
  let lastDuration = untrack(() => session.preset.durationSec);
  $effect(() => {
    void session.revision;
    const dur = session.preset.durationSec;
    if (dur !== lastDuration) {
      lastDuration = dur;
      view = { startSec: 0, endSec: Math.max(EDITOR_MIN_VIEW_SEC, dur) };
    }
  });

  function localPoint(e: PointerEvent): { x: number; y: number } {
    const rect = canvasEl.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  function onPointerDown(e: PointerEvent): void {
    const p = localPoint(e);
    downAt = p;
    moved = false;
    dragging = hitTestNode(session.voiceView(activeVoiceId), layout, view, p.x, p.y);
    canvasEl.setPointerCapture?.(e.pointerId);
  }

  function onPointerMove(e: PointerEvent): void {
    if (!downAt) return;
    const p = localPoint(e);
    if (Math.hypot(p.x - downAt.x, p.y - downAt.y) > 4) moved = true;
    if (!moved) return;
    if (dragging) {
      const lane = layout.lanes.find((l) => l.param === dragging!.param)!;
      const newV = clampParamValue(dragging.param, vOf(lane, dragging.param, p.y));
      session.setNodeValue(dragging.index, dragging.param, newV, activeVoiceId);
      const newT = clampMoveTime(session.voiceView(activeVoiceId), dragging.index, tOf(layout, view, p.x));
      session.moveNode(dragging.index, newT, activeVoiceId);
    } else {
      // empty-area horizontal drag → pan the time axis
      const dxSec = ((downAt.x - p.x) / layout.laneWidth) * (view.endSec - view.startSec);
      view = panBy(view, transport.duration(), dxSec);
      downAt = p;
    }
  }

  function onPointerUp(e: PointerEvent): void {
    const p = localPoint(e);
    if (!moved) {
      // a tap: select a node, or add a carry-forward node on an empty lane
      const hit = hitTestNode(session.voiceView(activeVoiceId), layout, view, p.x, p.y);
      if (hit) {
        onselect(hit);
      } else {
        const param = laneParamAt(layout, p.y);
        if (param) {
          const t = tOf(layout, view, p.x);
          session.addNode(t, param, activeVoiceId);
        }
      }
    }
    dragging = null;
    downAt = null;
    canvasEl.releasePointerCapture?.(e.pointerId);
  }

  function onWheel(e: WheelEvent): void {
    e.preventDefault();
    const rect = canvasEl.getBoundingClientRect();
    const centerSec = tOf(layout, view, e.clientX - rect.left);
    view = zoomClamp(view, transport.duration(), e.deltaY > 0 ? 1.1 : 0.9, centerSec);
  }

  onMount(() => {
    try {
      ctx2d = canvasEl.getContext('2d');
    } catch {
      ctx2d = null; // no 2D canvas in this environment; the loop simply no-ops its draw
    }
    layout = computeLayout(canvasEl.clientWidth || 640, canvasEl.clientHeight || 360);
    const dur = transport.duration() || EDITOR_MIN_VIEW_SEC;
    view = { startSec: 0, endSec: Math.max(EDITOR_MIN_VIEW_SEC, dur) };
    loop.start();
    return () => loop.stop(); // cancel the rAF loop on unmount (resource cleanup)
  });
</script>

<canvas
  bind:this={canvasEl}
  class="timeline"
  width="640"
  height="360"
  onpointerdown={onPointerDown}
  onpointermove={onPointerMove}
  onpointerup={onPointerUp}
  onwheel={onWheel}
></canvas>

<style>
  .timeline {
    width: 100%;
    height: 360px;
    touch-action: none;
    display: block;
    border-radius: var(--radius);
    background: var(--bg);
  }
</style>
