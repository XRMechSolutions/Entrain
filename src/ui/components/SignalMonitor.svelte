<!-- SignalMonitor — the READ-ONLY live plots for the Player "now playing" page. It reuses the
     Advanced timeline renderer (canvas-renderer) but with NO pointer editing: it draws the
     carrier/beat/volume/spatial base curves over the WHOLE session plus a moving playhead and
     a live combined dot (base + modulator) per lane, so you watch the signals as the preset
     drives them. Like the editor it draws imperatively in a rAF loop reading transport.position()
     directly each frame (edge I3/I4); Svelte never re-renders the <canvas>. -->
<script lang="ts">
  import { onMount, untrack } from 'svelte';
  import { getAppContext } from '../context';
  import { EDITOR_MIN_VIEW_SEC } from '../lib/constants';
  import { computeLayout, createRenderLoop, renderTimeline, type CanvasLayout, type View } from '../editor/canvas-renderer';

  const { transport, session, playback } = getAppContext();

  let canvasEl: HTMLCanvasElement;
  let ctx2d: CanvasRenderingContext2D | null = null;
  let layout: CanvasLayout = computeLayout(640, 280);
  // A monitor shows the FULL journey, not a zoom window — the view is always [0, duration].
  let view = $state<View>({ startSec: 0, endSec: EDITOR_MIN_VIEW_SEC });

  const loop = createRenderLoop({
    draw: (positionSec) => {
      if (!ctx2d) return;
      renderTimeline(ctx2d, {
        preset: session.preset,
        view,
        layout,
        positionSec,
        // Always draw the playhead + live dots so the page shows the current state of every
        // signal even before the first play / while paused (read-only: never a selection).
        playing: true,
        selected: null,
      });
    },
    isPlaying: () => playback.state === 'playing',
    position: () => transport.position(),
  });

  // Redraw on a preset change or a tick (a play frame / seek) — flips a flag, never re-renders
  // the <canvas> element (purity). While playing the loop already redraws every frame.
  $effect(() => {
    void session.revision;
    void playback.positionSec;
    void view;
    loop.markDirty();
  });

  // Keep the visible window pinned to the whole session; re-fit only when the duration changes
  // (a plain `let` tracks the last duration so a normal edit never resets the window).
  let lastDuration = untrack(() => session.preset.durationSec);
  $effect(() => {
    void session.revision;
    const dur = session.preset.durationSec;
    if (dur !== lastDuration) {
      lastDuration = dur;
      view = { startSec: 0, endSec: Math.max(EDITOR_MIN_VIEW_SEC, dur) };
    }
  });

  onMount(() => {
    try {
      ctx2d = canvasEl.getContext('2d');
    } catch {
      ctx2d = null; // no 2D canvas here (e.g. jsdom); the loop simply no-ops its draw
    }
    layout = computeLayout(canvasEl.clientWidth || 640, canvasEl.clientHeight || 280);
    const dur = transport.duration() || EDITOR_MIN_VIEW_SEC;
    lastDuration = session.preset.durationSec;
    view = { startSec: 0, endSec: Math.max(EDITOR_MIN_VIEW_SEC, dur) };
    loop.start();
    return () => loop.stop(); // cancel the rAF loop on unmount
  });
</script>

<canvas bind:this={canvasEl} class="monitor" width="640" height="280" aria-label="Live signal plots"></canvas>

<style>
  .monitor {
    width: 100%;
    height: 280px;
    display: block;
    border-radius: var(--radius);
    background: var(--bg);
  }
</style>
