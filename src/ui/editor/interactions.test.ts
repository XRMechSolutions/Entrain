import { describe, expect, it } from 'vitest';
import { createDefaultPreset, RANGES, type Preset } from '../../engine/session-model';
import { EDITOR_MIN_VIEW_SEC, MIN_NODE_DT_SEC } from '../lib/constants';
import { computeLayout, xOf, yOf, type View } from './canvas-renderer';
import {
  clampMoveTime,
  clampNodesToDuration,
  clampParamValue,
  edgeExceedsHalfPeriod,
  expDisabled,
  hitTestNode,
  zoomClamp,
} from './interactions';

function threeNodePreset(): Preset {
  const p = createDefaultPreset();
  p.durationSec = 300;
  p.nodes = [
    { t: 0, carrier: { value: 200 }, beat: { value: 8 }, volume: { value: 1 } },
    { t: 100, carrier: { value: 300 } },
    { t: 200, carrier: { value: 400 } },
  ];
  return p;
}

const layout = computeLayout(640, 360);
const view: View = { startSec: 0, endSec: 300 };

describe('interactions — hit testing (≥44px touch target, design §12)', () => {
  it('finds the node handle under the pointer', () => {
    const preset = threeNodePreset();
    const lane = layout.lanes.find((l) => l.param === 'carrier')!;
    const x = xOf(layout, view, 100);
    const y = yOf(lane, 'carrier', 300);
    const hit = hitTestNode(preset, layout, view, x, y);
    expect(hit).toEqual({ index: 1, param: 'carrier' });
  });

  it('returns null when the pointer is far from every handle', () => {
    const preset = threeNodePreset();
    expect(hitTestNode(preset, layout, view, 5, 5)).toBeNull();
  });
});

describe('interactions — horizontal drag clamps (edge J1/J2)', () => {
  it('pins nodes[0] at t=0', () => {
    const preset = threeNodePreset();
    expect(clampMoveTime(preset, 0, 50)).toBe(0);
  });

  it('keeps a node ≥ MIN_NODE_DT_SEC from both neighbours', () => {
    const preset = threeNodePreset();
    // node 1 (t=100) between node 0 (t=0) and node 2 (t=200)
    expect(clampMoveTime(preset, 1, -10)).toBeCloseTo(MIN_NODE_DT_SEC, 6); // can't reach 0
    expect(clampMoveTime(preset, 1, 999)).toBeCloseTo(200 - MIN_NODE_DT_SEC, 6); // can't reach node 2
    expect(clampMoveTime(preset, 1, 150)).toBe(150); // free in the middle
  });

  it('clamps the last node to durationSec', () => {
    const preset = threeNodePreset();
    expect(clampMoveTime(preset, 2, 9999)).toBe(300);
  });
});

describe('interactions — vertical drag clamps to RANGES (edge J3)', () => {
  it('clamps each param to its range', () => {
    expect(clampParamValue('carrier', 5000)).toBe(RANGES.carrier.max);
    expect(clampParamValue('beat', -5)).toBe(RANGES.beat.min);
    expect(clampParamValue('volume', 2)).toBe(RANGES.volume.max);
  });
});

describe('interactions — zoom/pan window clamps (edge J6)', () => {
  it('clamps zoom-in to EDITOR_MIN_VIEW_SEC', () => {
    const v = zoomClamp({ startSec: 0, endSec: 300 }, 300, 0.001, 150);
    expect(v.endSec - v.startSec).toBeCloseTo(EDITOR_MIN_VIEW_SEC, 6);
  });

  it('clamps zoom-out to durationSec and keeps the window inside [0, duration]', () => {
    const v = zoomClamp({ startSec: 50, endSec: 60 }, 300, 1000, 55);
    expect(v.endSec - v.startSec).toBeCloseTo(300, 6);
    expect(v.startSec).toBeGreaterThanOrEqual(0);
    expect(v.endSec).toBeLessThanOrEqual(300);
  });
});

describe('interactions — duration trim (edge J5)', () => {
  it('trims any node t beyond a decreased duration; nodes[0] stays at 0', () => {
    const preset = threeNodePreset();
    const trimmed = clampNodesToDuration(preset.nodes, 120);
    expect(trimmed[0].t).toBe(0);
    expect(Math.max(...trimmed.map((n) => n.t))).toBeLessThanOrEqual(120);
  });
});

describe('interactions — inspector predicates (design §12.1)', () => {
  it('expDisabled mirrors EXP_RAMP_THROUGH_ZERO (this value 0 or the next 0)', () => {
    const p = createDefaultPreset();
    p.nodes = [
      { t: 0, volume: { value: 0 } },
      { t: 10, volume: { value: 1 } },
    ];
    expect(expDisabled(p, 0, 'volume')).toBe(true); // ramps from 0
    p.nodes = [
      { t: 0, volume: { value: 1 } },
      { t: 10, volume: { value: 0 } },
    ];
    expect(expDisabled(p, 0, 'volume')).toBe(true); // ramps to 0
    p.nodes = [
      { t: 0, volume: { value: 0.5 } },
      { t: 10, volume: { value: 1 } },
    ];
    expect(expDisabled(p, 0, 'volume')).toBe(false);
  });

  it('edgeExceedsHalfPeriod mirrors MOD_EDGE_EXCEEDS_HALF_PERIOD', () => {
    expect(edgeExceedsHalfPeriod(1, 600)).toBe(true); // 600ms > 500ms (half of 1s)
    expect(edgeExceedsHalfPeriod(1, 400)).toBe(false);
    expect(edgeExceedsHalfPeriod(undefined, 400)).toBe(false);
  });
});
