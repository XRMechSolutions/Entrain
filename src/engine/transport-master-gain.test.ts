import { describe, it, expect } from 'vitest';
import { createMasterGainController } from './transport-master-gain';
import { MockAudioContext, type MockAudioParam } from '../test/webaudio-mock';

// --- helpers ---------------------------------------------------------------

function makeParam(supportsCancelAndHold = true): MockAudioParam {
  const ctx = new MockAudioContext({ supportsCancelAndHold });
  return ctx.makeParam(0);
}

/** A controller over a mock param plus a mutable `now`, exposed for ramp-time control. */
function makeController(supportsCancelAndHold = true): {
  param: MockAudioParam;
  setNow: (n: number) => void;
  ctrl: ReturnType<typeof createMasterGainController>;
} {
  const param = makeParam(supportsCancelAndHold);
  let now = 0;
  const ctrl = createMasterGainController(param as unknown as AudioParam, () => now);
  return { param, setNow: (n) => (now = n), ctrl };
}

// =====================================================================================
// Task 2 — rampMaster / currentMasterValue: Firefox-safe, analytic, linear-only
// =====================================================================================

describe('rampMaster — record + value tracking (C1, C6)', () => {
  it('should record a 0→trim ramp and interpolate it analytically', () => {
    const { ctrl, setNow } = makeController();
    setNow(0);
    ctrl.rampMaster(0.8, 0.5);

    expect(ctrl.currentMasterValue(0)).toBeCloseTo(0); // startValue before
    expect(ctrl.currentMasterValue(0.25)).toBeCloseTo(0.4); // linear midpoint
    expect(ctrl.currentMasterValue(0.5)).toBeCloseTo(0.8); // endValue after
    expect(ctrl.currentMasterValue(2)).toBeCloseTo(0.8); // clamps at endValue past end
  });

  it('should emit anchor setValueAtTime(0, now) then linearRampToValueAtTime(target, now+dur)', () => {
    const { param, ctrl, setNow } = makeController();
    setNow(0);
    ctrl.rampMaster(0.8, 0.5);

    const setValue = param.events.find((e) => e.method === 'setValueAtTime');
    const ramp = param.events.find((e) => e.method === 'linearRampToValueAtTime');
    expect(setValue).toMatchObject({ value: 0, time: 0 });
    expect(ramp).toMatchObject({ value: 0.8, time: 0.5 });
  });
});

describe('currentMasterValue — never reads param.value (C6)', () => {
  it('should compute analytically even when param.value is stale', () => {
    const { param, ctrl, setNow } = makeController();
    setNow(0);
    ctrl.rampMaster(1, 1); // 0 → 1 over 1 s

    // The mock writes param.value to the last scheduled value (1) — a STALE reading.
    expect(param.value).toBe(1);
    setNow(0.5);
    expect(ctrl.currentMasterValue(0.5)).toBeCloseTo(0.5); // analytic, NOT param.value
  });

  it('should anchor a re-ramp from the analytic current value, not param.value', () => {
    const { param, ctrl, setNow } = makeController();
    setNow(0);
    ctrl.rampMaster(1, 1);
    expect(param.value).toBe(1); // stale

    setNow(0.5);
    ctrl.rampMaster(0, 1); // re-ramp down; must anchor at analytic 0.5
    const anchors = param.events.filter((e) => e.method === 'setValueAtTime');
    const lastAnchor = anchors[anchors.length - 1];
    expect(lastAnchor.value).toBeCloseTo(0.5); // 0.5, never the stale 1
    expect(lastAnchor.time).toBeCloseTo(0.5);
  });
});

describe('cancel discipline (C5)', () => {
  it('should use cancelAndHoldAtTime when present', () => {
    const { param, ctrl, setNow } = makeController(true);
    setNow(1);
    ctrl.rampMaster(0.5, 0.2);
    expect(param.methodLog).toContain('cancelAndHoldAtTime');
    expect(param.methodLog).not.toContain('cancelScheduledValues');
  });

  it('should fall back to cancelScheduledValues when cancelAndHoldAtTime is absent (Firefox)', () => {
    const { param, ctrl, setNow } = makeController(false);
    setNow(1);
    ctrl.rampMaster(0.5, 0.2);
    expect(param.methodLog).toContain('cancelScheduledValues');
    expect(param.methodLog).not.toContain('cancelAndHoldAtTime');
  });
});

describe('linear-only discipline (C2, C7)', () => {
  it('should never use exponential ramps or setValueCurveAtTime', () => {
    const { param, ctrl, setNow } = makeController();
    setNow(0);
    ctrl.rampMaster(0.8, 0.5);
    ctrl.rampMaster(0, 0.5);
    expect(param.methodLog).not.toContain('exponentialRampToValueAtTime');
    expect(param.methodLog).not.toContain('setValueCurveAtTime');
  });
});

describe('durationSec === 0 (instant set)', () => {
  it('should collapse to a single setValueAtTime(target, now) with no ramp', () => {
    const { param, ctrl, setNow } = makeController();
    setNow(2);
    ctrl.rampMaster(0.3, 0);

    const setValues = param.events.filter((e) => e.method === 'setValueAtTime');
    expect(setValues).toHaveLength(1);
    expect(setValues[0]).toMatchObject({ value: 0.3, time: 2 });
    expect(param.methodLog).not.toContain('linearRampToValueAtTime');

    expect(ctrl.currentMasterValue(2)).toBeCloseTo(0.3);
    expect(ctrl.currentMasterValue(5)).toBeCloseTo(0.3);
  });
});
