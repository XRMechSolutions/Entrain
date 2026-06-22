import { describe, expect, it, vi } from 'vitest';
import { createDefaultPreset, RANGES } from '../../engine/session-model';
import {
  computeLayout,
  createRenderLoop,
  renderTimeline,
  tOf,
  vOf,
  xOf,
  yOf,
  type View,
} from './canvas-renderer';

describe('canvas-renderer — coordinate mapping (design §12)', () => {
  const layout = computeLayout(640, 360);
  const view: View = { startSec: 0, endSec: 100 };

  it('builds a lane per value param', () => {
    expect(layout.lanes.map((l) => l.param)).toEqual(['carrier', 'beat', 'volume', 'spatial']);
  });

  it('xOf/tOf round-trip across the visible window', () => {
    const t = 42;
    const x = xOf(layout, view, t);
    expect(tOf(layout, view, x)).toBeCloseTo(t, 6);
  });

  it('yOf maps a param value to a lane pixel and vOf inverts it (within RANGES)', () => {
    const lane = layout.lanes[0]; // carrier
    const v = (RANGES.carrier.min + RANGES.carrier.max) / 2;
    const y = yOf(lane, 'carrier', v);
    expect(vOf(lane, 'carrier', y)).toBeCloseTo(v, 4);
    // min sits at the lane bottom, max at the top
    expect(yOf(lane, 'carrier', RANGES.carrier.max)).toBeLessThan(yOf(lane, 'carrier', RANGES.carrier.min));
  });
});

describe('canvas-renderer — renderTimeline draws imperatively', () => {
  function makeCtx() {
    const calls: Record<string, number> = {};
    const rec = (name: string) => {
      return vi.fn(() => {
        calls[name] = (calls[name] ?? 0) + 1;
      });
    };
    return {
      ctx: {
        clearRect: rec('clearRect'),
        fillRect: rec('fillRect'),
        strokeRect: rec('strokeRect'),
        fillText: rec('fillText'),
        beginPath: rec('beginPath'),
        moveTo: rec('moveTo'),
        lineTo: rec('lineTo'),
        stroke: rec('stroke'),
        arc: rec('arc'),
        fill: rec('fill'),
        save: rec('save'),
        restore: rec('restore'),
        setLineDash: rec('setLineDash'),
        closePath: rec('closePath'),
        fillStyle: '',
        strokeStyle: '',
        lineWidth: 0,
        font: '',
        textBaseline: '',
      } as unknown as CanvasRenderingContext2D,
      calls,
    };
  }

  it('clears then draws base curves and (while playing) the playhead', () => {
    const { ctx, calls } = makeCtx();
    const layout = computeLayout(640, 360);
    renderTimeline(ctx, {
      preset: createDefaultPreset(),
      view: { startSec: 0, endSec: 300 },
      layout,
      positionSec: 120,
      playing: true,
    });
    expect(calls.clearRect).toBeGreaterThan(0);
    expect(calls.lineTo).toBeGreaterThan(0); // base curve sampled
    expect(calls.stroke).toBeGreaterThan(0);
    expect(calls.arc).toBeGreaterThan(0); // node handles + playhead dots
  });

  it('marks each in-view voice cue at its scripted time, skipping off-screen ones (D-043)', () => {
    const { ctx, calls } = makeCtx();
    const layout = computeLayout(640, 360);
    renderTimeline(ctx, {
      preset: createDefaultPreset(),
      view: { startSec: 0, endSec: 300 },
      layout,
      positionSec: 0,
      playing: false,
      cues: [
        { t: 30, label: 'Welcome' },
        { t: 90, label: 'Breathe in' },
        { t: 9999, label: 'off-screen' }, // outside the visible window → skipped
      ],
    });
    expect(calls.setLineDash).toBeGreaterThan(0); // dashed cue markers drawn
    const labels = (ctx.fillText as unknown as { mock: { calls: unknown[][] } }).mock.calls.map((c) => c[0]);
    expect(labels).toContain('Welcome');
    expect(labels).toContain('Breathe in');
    expect(labels).not.toContain('off-screen'); // the out-of-window cue is not labelled
  });

  it('draws no cue markers when cues are absent (pure-binaural unchanged)', () => {
    const { ctx, calls } = makeCtx();
    const layout = computeLayout(640, 360);
    renderTimeline(ctx, {
      preset: createDefaultPreset(),
      view: { startSec: 0, endSec: 300 },
      layout,
      positionSec: 0,
      playing: false,
    });
    expect(calls.setLineDash ?? 0).toBe(0); // no cue pass ran
  });
});

describe('canvas-renderer — the rAF render loop (edge I3/I4)', () => {
  function harness(isPlaying = false) {
    let cb: FrameRequestCallback | null = null;
    let next = 1;
    const raf = vi.fn((c: FrameRequestCallback) => {
      cb = c;
      return next++;
    });
    const caf = vi.fn(() => {
      cb = null; // a cancelled frame never fires
    });
    const draw = vi.fn();
    let pos = 0;
    const position = vi.fn(() => pos);
    const loop = createRenderLoop({ draw, position, isPlaying: () => isPlaying, raf, caf });
    const step = () => {
      const c = cb;
      cb = null;
      c?.(0);
    };
    return { loop, step, draw, raf, caf, position, setPos: (p: number) => (pos = p) };
  }

  it('redraws once on start (dirty) then idles when not playing and not dirty', () => {
    const h = harness(false);
    h.loop.start();
    h.step();
    expect(h.draw).toHaveBeenCalledTimes(1);
    h.step();
    expect(h.draw).toHaveBeenCalledTimes(1); // idle
  });

  it('redraws again when marked dirty (any edit/pan/zoom)', () => {
    const h = harness(false);
    h.loop.start();
    h.step(); // 1
    h.loop.markDirty();
    h.step();
    expect(h.draw).toHaveBeenCalledTimes(2);
  });

  it('while playing, redraws every frame reading position() directly', () => {
    const h = harness(true);
    h.loop.start();
    h.setPos(10);
    h.step();
    h.setPos(20);
    h.step();
    expect(h.draw).toHaveBeenCalledTimes(2);
    expect(h.draw).toHaveBeenNthCalledWith(1, 10);
    expect(h.draw).toHaveBeenNthCalledWith(2, 20);
    expect(h.position).toHaveBeenCalled();
  });

  it('stop() cancels the rAF loop (resource cleanup on unmount)', () => {
    const h = harness(true);
    h.loop.start();
    h.step();
    h.loop.stop();
    expect(h.caf).toHaveBeenCalled();
    expect(h.loop.running).toBe(false);
    const before = h.draw.mock.calls.length;
    h.step(); // no scheduled callback after stop
    expect(h.draw.mock.calls.length).toBe(before);
  });
});
