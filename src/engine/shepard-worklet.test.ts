import {
  ShepardProcessor,
  SHEPARD_PARTIALS,
  SHEPARD_F_BASE,
  shepardOctave,
  shepardPartialFrequency,
  shepardPartialBell,
} from './shepard-worklet';

// The worklet reads the AudioWorkletGlobalScope `sampleRate` global; jsdom has none, so
// install it per test. Each test sets the rate it needs.
const G = globalThis as unknown as { sampleRate?: number };

beforeEach(() => {
  G.sampleRate = 48000;
});
afterEach(() => {
  delete G.sampleRate;
});

// --- helpers ---------------------------------------------------------------

function outputs(n: number): Float32Array[][] {
  return [[new Float32Array(n)]];
}

interface ParamSpec {
  speed?: number | number[];
  gain?: number | number[];
}

function arr(v: number | number[] | undefined, fallback: number): Float32Array {
  if (v === undefined) return new Float32Array([fallback]);
  return Array.isArray(v) ? new Float32Array(v) : new Float32Array([v]);
}

function params(spec: ParamSpec): Record<string, Float32Array> {
  return { speed: arr(spec.speed, 0.25), gain: arr(spec.gain, 0.5) };
}

function run(p: ShepardProcessor, n: number, spec: ParamSpec): Float32Array {
  const out = outputs(n);
  p.process([], out, params(spec));
  return out[0][0];
}

// =====================================================================================
// ShepardProcessor — descriptors
// =====================================================================================

describe('ShepardProcessor.parameterDescriptors', () => {
  it('declares signed speed (default 0.25, −8..8) and gain (default 0.5, 0..1), both a-rate', () => {
    expect(ShepardProcessor.parameterDescriptors).toEqual([
      { name: 'speed', defaultValue: 0.25, minValue: -8, maxValue: 8, automationRate: 'a-rate' },
      { name: 'gain', defaultValue: 0.5, minValue: 0, maxValue: 1, automationRate: 'a-rate' },
    ]);
  });
});

// =====================================================================================
// Spectral design — octave-spaced partials + the click-free bell at the wrap seam
// =====================================================================================

describe('Shepard spectrum — octave-spaced partials', () => {
  it('places N partials exactly one octave apart, spanning ~20 Hz .. ~5–8 kHz', () => {
    const freqs = Array.from({ length: SHEPARD_PARTIALS }, (_, i) => shepardPartialFrequency(i, 0));
    expect(freqs[0]).toBeCloseTo(SHEPARD_F_BASE, 5); // lowest partial = F_BASE
    expect(freqs[0]).toBeGreaterThanOrEqual(20);
    expect(freqs[0]).toBeLessThanOrEqual(32);
    for (let i = 1; i < SHEPARD_PARTIALS; i++) {
      expect(freqs[i] / freqs[i - 1]).toBeCloseTo(2, 6); // each partial is 2× the previous
    }
    // As a partial sweeps to the top seam its frequency approaches F_BASE·2^N before
    // wrapping — the effective spectral ceiling.
    const spectralTop = SHEPARD_F_BASE * Math.pow(2, SHEPARD_PARTIALS);
    expect(spectralTop).toBeGreaterThan(5000);
    expect(spectralTop).toBeLessThan(8000);
  });
});

describe('Shepard bell — ≈0 at the wrap seam (seamless, click-free)', () => {
  it('peaks at the middle octave and is ≈0 at both seams (x=0 and x→1)', () => {
    // octave position N/2 → x=0.5 → peak of the raised-cosine bell
    expect(shepardPartialBell(0, SHEPARD_PARTIALS / 2)).toBeCloseTo(1, 6);
    // octave position 0 → x=0 → silent (bottom seam)
    expect(shepardPartialBell(0, 0)).toBeCloseTo(0, 6);
    // a partial about to wrap off the top (x→1) is ~silent
    expect(shepardPartialBell(0, SHEPARD_PARTIALS - 1e-4)).toBeLessThan(1e-3);
    // and just after it re-enters at the bottom (x→0⁺) it is still ~silent
    expect(shepardPartialBell(0, 1e-4)).toBeLessThan(1e-3);
  });

  it('keeps the summed spectral envelope constant across the seam (no level dip → no click)', () => {
    for (const p of [0, 0.5, 1, 3.9999, 4.0001, 7.5]) {
      let sum = 0;
      for (let i = 0; i < SHEPARD_PARTIALS; i++) sum += shepardPartialBell(i, p);
      expect(sum).toBeCloseTo(SHEPARD_PARTIALS / 2, 4); // Σ bell == N/2 for every position
    }
  });

  it('wraps the octave position into [0, N) for any sign of p', () => {
    expect(shepardOctave(0, -1)).toBeCloseTo(SHEPARD_PARTIALS - 1, 9);
    expect(shepardOctave(0, SHEPARD_PARTIALS + 0.25)).toBeCloseTo(0.25, 9);
  });
});

// =====================================================================================
// process() — direction, gain, finiteness, block length + sampleRate
// =====================================================================================

describe('ShepardProcessor.process — direction (speed SIGN)', () => {
  it('ascending (+speed) advances the position up; descending (−speed) advances it down', () => {
    G.sampleRate = 100;
    const up = new ShepardProcessor();
    run(up, 100, { speed: 1, gain: 0.5 }); // +1 octave/sec for 1 s → +1 octave
    expect(up.position).toBeCloseTo(1, 5);

    const down = new ShepardProcessor();
    run(down, 100, { speed: -1, gain: 0.5 }); // −1 octave/sec → −1 octave (wraps to N−1)
    expect(down.position).toBeCloseTo(SHEPARD_PARTIALS - 1, 5);

    expect(up.position).not.toBeCloseTo(down.position, 3); // the sign genuinely flips direction
  });

  it('persists the glissando position across process() calls (continuity)', () => {
    G.sampleRate = 100;
    const split = new ShepardProcessor();
    run(split, 50, { speed: 1, gain: 1 });
    run(split, 50, { speed: 1, gain: 1 }); // 100 samples total → +1 octave
    expect(split.position).toBeCloseTo(1, 5);
  });
});

describe('ShepardProcessor.process — level + finiteness', () => {
  it('gain 0 → exact silence and returns true (keep-alive)', () => {
    const p = new ShepardProcessor();
    const out = outputs(256);
    const keepAlive = p.process([], out, params({ speed: 0.25, gain: 0 }));
    expect(keepAlive).toBe(true);
    for (const v of out[0][0]) expect(Math.abs(v)).toBe(0); // exact silence (±0)
  });

  it('produces a finite, normalized (|v| ≤ 1) signal for a fast sweep at full gain', () => {
    G.sampleRate = 44100;
    const out = run(new ShepardProcessor(), 1024, { speed: 4, gain: 1 });
    for (const v of out) {
      expect(Number.isFinite(v)).toBe(true);
      expect(Math.abs(v)).toBeLessThanOrEqual(1 + 1e-6);
    }
  });

  it('never produces NaN at the speed extremes (±8) or on a descending sweep', () => {
    G.sampleRate = 48000;
    for (const speed of [8, -8, -0.5]) {
      const out = run(new ShepardProcessor(), 512, { speed, gain: 1 });
      for (const v of out) expect(Number.isFinite(v)).toBe(true);
    }
  });

  it('honors a-rate per-sample param arrays as well as length-1 constant blocks', () => {
    G.sampleRate = 48000;
    // length-n speed array, length-1 gain — must not throw and stays finite.
    const out = run(new ShepardProcessor(), 4, { speed: [0.1, 0.2, 0.3, 0.4], gain: 1 });
    for (const v of out) expect(Number.isFinite(v)).toBe(true);
  });
});

describe('ShepardProcessor.process — reads block length + global sampleRate', () => {
  it('writes EVERY sample of the provided buffer (reads length, no hardcoded 128) (F4)', () => {
    const out = outputs(200);
    out[0][0].fill(Number.NaN); // sentinel: any index left unwritten stays NaN
    new ShepardProcessor().process([], out, params({ speed: 0.25, gain: 1 }));
    expect(out[0][0].length).toBe(200);
    for (const v of out[0][0]) expect(Number.isFinite(v)).toBe(true); // all 200 overwritten
  });

  it('reads the global sampleRate each block (the position advance scales with 1/sr) (F5)', () => {
    const slow = new ShepardProcessor();
    G.sampleRate = 100;
    run(slow, 100, { speed: 1, gain: 1 }); // 100 · 1 / 100 = 1.0 octave
    expect(slow.position).toBeCloseTo(1, 5);

    const fast = new ShepardProcessor();
    G.sampleRate = 200;
    run(fast, 100, { speed: 1, gain: 1 }); // 100 · 1 / 200 = 0.5 octave
    expect(fast.position).toBeCloseTo(0.5, 5);
  });

  it('writes in place into the provided buffer (no per-block output allocation) (F6)', () => {
    const out = outputs(128);
    const channelRef = out[0][0];
    new ShepardProcessor().process([], out, params({ speed: 0.25, gain: 1 }));
    expect(out[0][0]).toBe(channelRef);
  });
});
