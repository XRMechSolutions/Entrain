import { PulseProcessor } from './pulse-worklet';

// The worklet reads the AudioWorkletGlobalScope `sampleRate` global; jsdom has none,
// so install it per test. Each test sets the rate it needs.
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
  frequency?: number | number[];
  depth?: number | number[];
  dutyCycle?: number | number[];
  edgeWidth?: number | number[];
}

function arr(v: number | number[] | undefined, fallback: number): Float32Array {
  if (v === undefined) return new Float32Array([fallback]);
  return Array.isArray(v) ? new Float32Array(v) : new Float32Array([v]);
}

function params(spec: ParamSpec): Record<string, Float32Array> {
  return {
    frequency: arr(spec.frequency, 4),
    depth: arr(spec.depth, 1),
    dutyCycle: arr(spec.dutyCycle, 0.5),
    edgeWidth: arr(spec.edgeWidth, 0.005),
  };
}

function run(p: PulseProcessor, n: number, spec: ParamSpec): Float32Array {
  const out = outputs(n);
  p.process([], out, params(spec));
  return out[0][0];
}

// =====================================================================================
// Task 5 — PulseProcessor algorithm
// =====================================================================================

describe('PulseProcessor.parameterDescriptors', () => {
  it('should declare the four a-rate params with documented defaults/ranges', () => {
    const d = PulseProcessor.parameterDescriptors;
    expect(d).toEqual([
      { name: 'frequency', defaultValue: 4, minValue: 0, maxValue: 20000, automationRate: 'a-rate' },
      { name: 'depth', defaultValue: 1, minValue: 0, maxValue: 1, automationRate: 'a-rate' },
      { name: 'dutyCycle', defaultValue: 0.5, minValue: 0, maxValue: 1, automationRate: 'a-rate' },
      { name: 'edgeWidth', defaultValue: 0.005, minValue: 0, maxValue: 1, automationRate: 'a-rate' },
    ]);
  });
});

describe('PulseProcessor.process — happy path', () => {
  it('should produce a mono 0..1 envelope and return true', () => {
    const p = new PulseProcessor();
    const out = outputs(256);
    G.sampleRate = 1000;
    const keepAlive = p.process([], out, params({ frequency: 4, depth: 1 }));
    expect(keepAlive).toBe(true);
    for (const v of out[0][0]) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
      expect(Number.isFinite(v)).toBe(true);
    }
  });

  it('should hold high=1 and low=1−depth with a hard gate (edge 0)', () => {
    const p = new PulseProcessor();
    G.sampleRate = 1000;
    // freq=1, sr=1000, 1000 samples = exactly one cycle; duty 0.5; edge 0 → hard gate.
    const out = run(p, 1000, { frequency: 1, depth: 0.3, dutyCycle: 0.5, edgeWidth: 0 });
    expect(out[0]).toBeCloseTo(1, 5); // phase 0 → high plateau
    expect(out[600]).toBeCloseTo(0.7, 5); // phase 0.6 → low = 1−0.3 (float32)
  });

  it('should spend the dutyCycle fraction of each cycle at the high level', () => {
    const p = new PulseProcessor();
    G.sampleRate = 1000;
    const out = run(p, 1000, { frequency: 1, depth: 1, dutyCycle: 0.25, edgeWidth: 0 });
    const highCount = Array.from(out).filter((v) => v === 1).length;
    expect(highCount).toBe(250); // 25% of 1000 samples
  });

  it('should cross edges with a raised-cosine (C1-continuous, click-free) shape', () => {
    const p = new PulseProcessor();
    G.sampleRate = 1000;
    // e = edgeWidth·freq = 0.1·1 = 0.1 cycles → rising edge over samples 0..99.
    const out = run(p, 1000, { frequency: 1, depth: 1, dutyCycle: 0.5, edgeWidth: 0.1 });
    expect(out[0]).toBeCloseTo(0, 9); // rising edge starts at low
    expect(out[50]).toBeCloseTo(0.5, 5); // rcos(0.5) = 0.5
    expect(out[200]).toBeCloseTo(1, 9); // high plateau
    // Monotonic, smooth rise across the edge — no click-sized jump.
    let maxJump = 0;
    for (let i = 1; i < 100; i++) {
      expect(out[i]).toBeGreaterThanOrEqual(out[i - 1]);
      maxJump = Math.max(maxJump, out[i] - out[i - 1]);
    }
    expect(maxJump).toBeLessThan(0.1);
  });

  it('should persist phase across process() calls (continuity)', () => {
    const p = new PulseProcessor();
    G.sampleRate = 1000;
    const spec = { frequency: 1, depth: 1, dutyCycle: 0.5, edgeWidth: 0 };
    const first = run(p, 250, spec); // advances phase 0 → 0.250
    const second = run(p, 300, spec); // continues from phase 0.250
    expect(first[0]).toBe(1);
    expect(second[0]).toBe(1); // phase 0.250 → still high
    // Sample 260 sits at phase ≈ 0.510 → low. Had phase reset to 0, it would be
    // at phase 0.260 (still high) — so this distinguishes continuity from a reset.
    expect(second[260]).toBe(0);
  });
});

describe('PulseProcessor.process — edge cases', () => {
  it('should read outputs[0][0].length every call (no hardcoded 128) (F4)', () => {
    const p = new PulseProcessor();
    G.sampleRate = 1000;
    // duty 1 + edge 0 → always high=1. A 1 written at index 129 (>128) proves the
    // full length-130 buffer was processed (arrays init to 0).
    const out = run(p, 130, { frequency: 1, depth: 1, dutyCycle: 1, edgeWidth: 0 });
    expect(out.length).toBe(130);
    expect(out[129]).toBe(1);
  });

  it('should read the global sampleRate each block (F5)', () => {
    const spec = { frequency: 500, depth: 1, dutyCycle: 0.5, edgeWidth: 0 };
    G.sampleRate = 1000; // advance 0.5/sample → cycle every 2 samples → [1,0,1,0]
    const slow = run(new PulseProcessor(), 4, spec);
    G.sampleRate = 2000; // advance 0.25/sample → cycle every 4 samples → [1,1,0,0]
    const fast = run(new PulseProcessor(), 4, spec);
    expect(Array.from(slow)).toEqual([1, 0, 1, 0]);
    expect(Array.from(fast)).toEqual([1, 1, 0, 0]);
  });

  it('should handle length-1 (constant block) and length-n param arrays alike (F7)', () => {
    G.sampleRate = 1000;
    // Constant length-1 depth.
    const constOut = run(new PulseProcessor(), 4, { frequency: 0, depth: 0.3 });
    for (const v of constOut) expect(v).toBeCloseTo(0.7, 5);
    // Per-sample length-n depth honored at each index (freq 0 → out = low = 1−depth).
    const varOut = run(new PulseProcessor(), 4, { frequency: 0, depth: [0, 1, 0, 1] });
    expect(Array.from(varOut)).toEqual([1, 0, 1, 0]);
  });

  it('should treat dutyCycle 0/1 and oversized edge as a well-defined hard gate (no NaN, A6)', () => {
    G.sampleRate = 1000;
    const allLow = run(new PulseProcessor(), 100, { frequency: 1, depth: 1, dutyCycle: 0, edgeWidth: 5 });
    const allHigh = run(new PulseProcessor(), 100, { frequency: 1, depth: 1, dutyCycle: 1, edgeWidth: 5 });
    for (const v of allLow) expect(v).toBe(0);
    for (const v of allHigh) expect(v).toBe(1);
    // Oversized edge with a mid duty: still finite and bounded, no divide-by-zero.
    const oversized = run(new PulseProcessor(), 200, { frequency: 10, depth: 1, dutyCycle: 0.5, edgeWidth: 10 });
    for (const v of oversized) {
      expect(Number.isFinite(v)).toBe(true);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });

  it('should hold a DC envelope at the low level when frequency is 0 (A7)', () => {
    G.sampleRate = 1000;
    const out = run(new PulseProcessor(), 64, { frequency: 0, depth: 0.6, dutyCycle: 0.5, edgeWidth: 0.005 });
    for (const v of out) expect(v).toBeCloseTo(0.4, 5); // low = 1 − 0.6 (float32)
  });

  it('should write into the provided buffer in place (no per-block output allocation) (F6)', () => {
    const p = new PulseProcessor();
    G.sampleRate = 1000;
    const out = outputs(128);
    const channelRef = out[0][0];
    p.process([], out, params({ frequency: 4, depth: 1 }));
    expect(out[0][0]).toBe(channelRef); // same Float32Array instance, mutated in place
  });
});
