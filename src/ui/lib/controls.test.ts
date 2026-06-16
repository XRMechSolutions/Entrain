import { describe, expect, it } from 'vitest';
import { RANGES } from '../../engine/session-model';
import { CONTROL } from './controls';

describe('lib/controls CONTROL specs', () => {
  it('derives carrier exactly from RANGES (the canonical example)', () => {
    expect(CONTROL.carrier).toEqual({ min: 20, max: 1000, step: 1, unit: 'Hz' });
  });

  it('derives beat / volume / masterGain bounds from RANGES with the §14 steps', () => {
    expect(CONTROL.beat).toEqual({ min: RANGES.beat.min, max: RANGES.beat.max, step: 0.1, unit: 'Hz' });
    expect(CONTROL.volume).toEqual({ min: RANGES.volume.min, max: RANGES.volume.max, step: 0.01, unit: '%' });
    expect(CONTROL.masterGain).toEqual({
      min: RANGES.masterGain.min,
      max: RANGES.masterGain.max,
      step: 0.01,
      unit: '%',
    });
  });

  it('gives spatial the pan unit and §14 step', () => {
    expect(CONTROL.spatial).toEqual({ min: RANGES.spatial.min, max: RANGES.spatial.max, step: 0.01, unit: 'pan' });
  });

  it('keeps every bound inside the session-model RANGES (never authors out-of-range)', () => {
    expect(CONTROL.carrier.min).toBe(RANGES.carrier.min);
    expect(CONTROL.carrier.max).toBe(RANGES.carrier.max);
  });
});
