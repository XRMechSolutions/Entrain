import { describe, expect, it } from 'vitest';
import * as C from './constants';
import { createDefaultPreset, validate } from '../../engine/session-model';

// Constants are a single source of truth — they must match design.md §14 exactly.
describe('lib/constants', () => {
  it('matches the §14 values', () => {
    expect(C.WIDE_BREAKPOINT_PX).toBe(720);
    expect(C.MIN_TAP_TARGET_PX).toBe(48);
    expect(C.PLAY_BUTTON_DIAMETER_PX).toBe(120);
    expect(C.WARNING_AUTODISMISS_MS).toBe(6000);
    expect(C.NOTICE_MAX_VISIBLE).toBe(3);
    expect(C.NODE_HIT_RADIUS_PX).toBe(22);
    expect(C.CURVE_SAMPLE_PX).toBe(2);
    expect(C.MIN_NODE_DT_SEC).toBe(0.01);
    expect(C.EDITOR_MIN_VIEW_SEC).toBe(5);
  });
});

describe('DEFAULT_TONE_SPEC (Phase-2, design §21)', () => {
  it('matches the §21 values exactly', () => {
    expect(C.DEFAULT_TONE_SPEC).toEqual({ shape: 'sine', freqHz: 528, attackSec: 0.005, releaseSec: 3 });
  });

  it('is a valid one-shot synth source (passes session-model.validate as a tone layer)', () => {
    const preset = createDefaultPreset();
    preset.layers = [{ id: 'l1', kind: 'tone', source: { synth: C.DEFAULT_TONE_SPEC }, t: 0 }];
    const result = validate(preset);
    expect(result.ok).toBe(true);
  });
});
