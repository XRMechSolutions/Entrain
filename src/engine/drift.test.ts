import { describe, expect, it } from 'vitest';
import { deriveDriftPreset, driftWindow, DRIFT_DEFAULTS } from './drift';
import { baseValueAt } from './automation';
import { validate, type Preset } from './session-model';

// A small, deterministic binaural arc: beat 10 → 6 (by t=500) → 8 (by t=1000), carrier 200 →
// 180 → 200. A multi-lane node at t=300 (carrier+beat+volume) sits INSIDE a default-window dip
// at atSec=200 (window 200..575) so the "strip only carrier+beat, keep volume" path is exercised.
function makeBase(): Preset {
  return {
    schemaVersion: 6,
    name: 'Drift Test',
    durationSec: 1000,
    masterGain: 0.5,
    nodes: [
      { t: 0, carrier: { value: 200 }, beat: { value: 10 }, volume: { value: 1 } },
      { t: 300, carrier: { value: 150 }, beat: { value: 4 }, volume: { value: 0.5 } },
      { t: 500, carrier: { value: 180 }, beat: { value: 6 } },
      { t: 1000, carrier: { value: 200 }, beat: { value: 8 } },
    ],
  };
}

describe('deriveDriftPreset', () => {
  it('produces a valid preset that keeps duration, voices/layers shape, and never mutates the base', () => {
    const base = makeBase();
    const snapshot = JSON.stringify(base);
    const derived = deriveDriftPreset(base, 200);

    expect(validate(derived).ok).toBe(true);
    expect(derived.durationSec).toBe(base.durationSec);
    expect(derived).not.toBe(base);
    expect(JSON.stringify(base)).toBe(snapshot); // base untouched
  });

  it('eases the beat down to the deep target and the carrier down by the drop, holding through the window', () => {
    const base = makeBase();
    const derived = deriveDriftPreset(base, 200); // window: descend→245, hold→485, rejoin→575

    // Continuity: at the playhead the dip starts from the CURRENT base value (no step).
    expect(baseValueAt(derived, 'beat', 200)).toBeCloseTo(baseValueAt(base, 'beat', 200), 5);
    expect(baseValueAt(derived, 'carrier', 200)).toBeCloseTo(baseValueAt(base, 'carrier', 200), 5);

    // Deep target reached and held flat across the hold span.
    expect(baseValueAt(derived, 'beat', 245)).toBeCloseTo(DRIFT_DEFAULTS.beatTargetHz, 5);
    expect(baseValueAt(derived, 'beat', 365)).toBeCloseTo(DRIFT_DEFAULTS.beatTargetHz, 5);
    expect(baseValueAt(derived, 'carrier', 245)).toBeCloseTo(
      baseValueAt(base, 'carrier', 200) - DRIFT_DEFAULTS.carrierDropHz,
      5,
    );
  });

  it('rejoins the original curve exactly at the rejoin point and after', () => {
    const base = makeBase();
    const derived = deriveDriftPreset(base, 200);

    expect(baseValueAt(derived, 'beat', 575)).toBeCloseTo(baseValueAt(base, 'beat', 575), 5);
    expect(baseValueAt(derived, 'carrier', 575)).toBeCloseTo(baseValueAt(base, 'carrier', 575), 5);
    // Original keyframe past the window is untouched.
    expect(baseValueAt(derived, 'beat', 1000)).toBeCloseTo(8, 5);
  });

  it('strips only carrier+beat from in-window nodes, preserving their other lanes', () => {
    const base = makeBase();
    const derived = deriveDriftPreset(base, 200);

    // The t=300 node's beat (4) is gone — the dip drives it to the held deep target instead.
    expect(baseValueAt(derived, 'beat', 300)).toBeCloseTo(DRIFT_DEFAULTS.beatTargetHz, 5);
    // …but its volume keyframe (0.5) survives, identical to the base.
    expect(baseValueAt(derived, 'volume', 400)).toBeCloseTo(baseValueAt(base, 'volume', 400), 5);
    expect(baseValueAt(derived, 'volume', 400)).toBeCloseTo(0.5, 5);
  });

  it('leaves a non-binaural (beat=0) voice silent on the beat lane but still lowers the carrier', () => {
    const base: Preset = {
      schemaVersion: 6,
      name: 'Isochronic',
      durationSec: 1000,
      masterGain: 0.5,
      nodes: [
        { t: 0, carrier: { value: 200 }, beat: { value: 0 }, volume: { value: 1 } },
        { t: 1000, carrier: { value: 200 } },
      ],
    };
    const derived = deriveDriftPreset(base, 200);
    expect(validate(derived).ok).toBe(true);
    expect(baseValueAt(derived, 'beat', 245)).toBe(0);
    expect(baseValueAt(derived, 'carrier', 245)).toBeCloseTo(200 - DRIFT_DEFAULTS.carrierDropHz, 5);
  });

  it('returns the preset unchanged when there is no room before the session ends', () => {
    const base = makeBase();
    const snapshot = JSON.stringify(base);
    const derived = deriveDriftPreset(base, 999); // rejoin would not fit within durationSec
    expect(validate(derived).ok).toBe(true);
    expect(JSON.stringify(derived)).toBe(snapshot);
  });

  it('honours custom options (deeper target, longer hold)', () => {
    const base = makeBase();
    const derived = deriveDriftPreset(base, 100, { beatTargetHz: 1.8, descendSec: 30, holdSec: 120, rejoinSec: 60 });
    // descend → 130; deep target reached there.
    expect(baseValueAt(derived, 'beat', 130)).toBeCloseTo(1.8, 5);
    expect(validate(derived).ok).toBe(true);
  });
});

describe('driftWindow', () => {
  it('spans the press position to the rejoin point (descend + hold + rejoin)', () => {
    const base = makeBase();
    const w = driftWindow(base, 200);
    expect(w.startSec).toBe(200);
    expect(w.endSec).toBe(200 + DRIFT_DEFAULTS.descendSec + DRIFT_DEFAULTS.holdSec + DRIFT_DEFAULTS.rejoinSec);
  });

  it('clamps the window to the session end (degenerate near the end → no room)', () => {
    const base = makeBase(); // durationSec 1000
    const w = driftWindow(base, 999);
    expect(w.startSec).toBe(999);
    expect(w.endSec).toBe(1000); // clamped; endSec - startSec <= 1 ⇒ deriveDriftPreset is a no-op
  });
});
