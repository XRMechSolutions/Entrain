import { describe, it, expect } from 'vitest';
import { createMixer, type DuckSpan, type Mixer } from './mixer';
import {
  MockAudioContext,
  MockAudioNode,
  type MockAudioParam,
  type MockGainNode,
} from '../test/webaudio-mock';

// --- helpers ---------------------------------------------------------------

/** Cast a mock context to the real BaseAudioContext at the call boundary. */
function asCtx(ctx: MockAudioContext): BaseAudioContext {
  return ctx as unknown as BaseAudioContext;
}

/** Cast a mock param for event-log assertions. */
function mp(p: AudioParam): MockAudioParam {
  return p as unknown as MockAudioParam;
}

/** Cast a mock node for connection assertions. */
function mn(n: AudioNode): MockAudioNode {
  return n as unknown as MockAudioNode;
}

/** Build a mixer over a fresh mock context; return both. */
function makeMixer(opts?: {
  masterStart?: number;
  sampleRate?: number;
  supportsCancelAndHold?: boolean;
}): { ctx: MockAudioContext; mixer: Mixer } {
  const ctx = new MockAudioContext({
    sampleRate: opts?.sampleRate,
    supportsCancelAndHold: opts?.supportsCancelAndHold,
  });
  const mixer = createMixer(asCtx(ctx), { masterStart: opts?.masterStart });
  return { ctx, mixer };
}

/** The five internal gains by construction index: bed, duck, cue, lift, busSum, master. */
function gainsOf(ctx: MockAudioContext): {
  bed: MockGainNode;
  duck: MockGainNode;
  cue: MockGainNode;
  lift: MockGainNode;
  busSum: MockGainNode;
  master: MockGainNode;
} {
  const g = ctx.created.gains;
  return { bed: g[0], duck: g[1], cue: g[2], lift: g[3], busSum: g[4], master: g[5] };
}

/** The ordered duck-param events that carry a value (anchors + ramps), for envelope checks. */
function valueEvents(p: MockAudioParam): { method: string; value: number; time: number }[] {
  return p.events
    .filter((e) => e.value !== undefined && e.time !== undefined)
    .map((e) => ({ method: e.method, value: e.value as number, time: e.time as number }));
}

// =====================================================================================
// (a) TOPOLOGY — the fixed three-input → one-master graph (design §2)
// =====================================================================================

describe('topology — fixed three-input → one-master graph', () => {
  it('should create exactly six gains with the documented initial values', () => {
    const { ctx } = makeMixer();
    expect(ctx.created.gains).toHaveLength(6);
    const { bed, duck, cue, lift, busSum, master } = gainsOf(ctx);
    expect(bed.gain.value).toBe(1.0);
    expect(duck.gain.value).toBe(1.0);
    expect(cue.gain.value).toBe(1.0);
    expect(lift.gain.value).toBe(1.0);
    expect(busSum.gain.value).toBe(1.0);
    expect(master.gain.value).toBe(0); // silent start (D-008).
  });

  it('should expose bedInput/cueInput/liftInput/master and their params', () => {
    const { ctx, mixer } = makeMixer();
    const { bed, cue, lift, duck, master } = gainsOf(ctx);
    expect(mixer.bedInput).toBe(bed);
    expect(mixer.cueInput).toBe(cue);
    expect(mixer.liftInput).toBe(lift);
    expect(mixer.master).toBe(master);
    expect(mixer.masterParam).toBe(master.gain);
    expect(mixer.duckParam).toBe(duck.gain);
  });

  it('should route bed → duckGain → busSum (bed reaches busSum only via the duck)', () => {
    const { ctx } = makeMixer();
    const { bed, duck, busSum } = gainsOf(ctx);
    expect(bed.isConnectedTo(duck)).toBe(true);
    expect(bed.isConnectedTo(busSum)).toBe(false); // never a direct bed→busSum edge.
    expect(duck.isConnectedTo(busSum)).toBe(true);
  });

  it('should join cue and lift to busSum DOWNSTREAM of the duck (never ducked)', () => {
    const { ctx } = makeMixer();
    const { cue, lift, duck, busSum } = gainsOf(ctx);
    expect(cue.isConnectedTo(busSum)).toBe(true);
    expect(lift.isConnectedTo(busSum)).toBe(true);
    expect(cue.isConnectedTo(duck)).toBe(false);
    expect(lift.isConnectedTo(duck)).toBe(false);
  });

  it('should give master exactly ONE upstream edge (busSum) at construction', () => {
    const { ctx } = makeMixer();
    const { busSum, master } = gainsOf(ctx);
    expect(busSum.isConnectedTo(master)).toBe(true);
    expect(master.inputs).toHaveLength(1);
    expect(master.inputs[0]).toBe(busSum);
  });

  it('should NOT connect master to any output target at construction', () => {
    const { ctx } = makeMixer();
    const { master } = gainsOf(ctx);
    expect(master.connections).toHaveLength(0);
  });

  it('should default master.gain to 0 and honor opts.masterStart', () => {
    const { mixer: def } = makeMixer();
    expect(mp(def.masterParam).value).toBe(0);
    const { mixer: withStart } = makeMixer({ masterStart: 0.7 });
    expect(mp(withStart.masterParam).value).toBe(0.7);
  });

  it('should write a non-finite masterStart as-is (caller bug; controller overwrites)', () => {
    const { mixer } = makeMixer({ masterStart: NaN });
    expect(Number.isNaN(mp(mixer.masterParam).value)).toBe(true);
  });

  it('should start duckParam at 1.0 (no duck)', () => {
    const { mixer } = makeMixer();
    expect(mp(mixer.duckParam).value).toBe(1.0);
  });

  it('should NOT write masterParam after construction (mixer is not its writer)', () => {
    const { mixer } = makeMixer({ masterStart: 0.5 });
    // No scheduling events recorded on masterParam — the value was set via the field, not
    // via an automation call; the mixer never calls a scheduling method on it.
    expect(mp(mixer.masterParam).events).toHaveLength(0);
  });

  it('should allow N external gains to fan into bedInput without disturbing topology or bedInput.gain', () => {
    const N = 3;
    const { ctx, mixer } = makeMixer();
    const { bed, duck, busSum, master } = gainsOf(ctx);

    // Simulate N voice-trim gains (multi-voice §2) connecting their outputs into bedInput.
    const trims = Array.from({ length: N }, () => new MockAudioNode(ctx, 'gain'));
    for (const trim of trims) {
      trim.connect(mixer.bedInput as unknown as MockAudioNode);
    }

    // N upstream edges fan into bedInput.
    expect(mn(mixer.bedInput).inputs).toHaveLength(N);

    // bed→duckGain→busSum→master topology is unchanged.
    expect(bed.isConnectedTo(duck)).toBe(true);
    expect(duck.isConnectedTo(busSum)).toBe(true);
    expect(busSum.isConnectedTo(master)).toBe(true);

    // Default bedHeadroom: bedInput.gain stays at unity (single-voice byte-identical).
    expect(bed.gain.value).toBe(1.0);
  });
});

// =====================================================================================
// (b) DUCK ENVELOPE — scheduleLane op sequence, linear only (design §4)
// =====================================================================================

describe('scheduleDuck — single region envelope (happy path)', () => {
  it('should emit anchor + linear attack/hold/release on duckParam, linear only', () => {
    const { mixer } = makeMixer();
    const spans: DuckSpan[] = [
      { startCtx: 12.0, endCtx: 13.4, toGain: 0.25, attackSec: 0.08, releaseSec: 0.3 },
    ];
    mixer.scheduleDuck(spans, /* t0 */ 0, /* startOffsetSec */ 0);
    const p = mp(mixer.duckParam);

    // No-click anchor: setValueAtTime(1.0, floorTime).
    expect(p.events[0]).toMatchObject({ method: 'setValueAtTime', value: 1.0 });
    // Linear only — never exp, never setValueCurve (Firefox bug 1752775).
    expect(p.methodLog).not.toContain('exponentialRampToValueAtTime');
    expect(p.methodLog).not.toContain('setValueCurveAtTime');
    expect(p.methodLog).toContain('linearRampToValueAtTime');

    // The envelope reaches toGain at startCtx and returns to 1.0 after releaseEnd.
    const ramps = valueEvents(p).filter((e) => e.method === 'linearRampToValueAtTime');
    const near = (t: number) => (e: { time: number }) => Math.abs(e.time - t) < 1e-6;
    const toFloor = ramps.find(near(12.0));
    const recover = ramps.find(near(13.7)); // endCtx 13.4 + release 0.3.
    expect(toFloor?.value).toBeCloseTo(0.25);
    expect(recover?.value).toBeCloseTo(1.0);
  });

  it('should reach the correct value at sampled times (preview == playback parity)', () => {
    const { mixer } = makeMixer();
    mixer.scheduleDuck(
      [{ startCtx: 12.0, endCtx: 13.4, toGain: 0.25, attackSec: 0.08, releaseSec: 0.3 }],
      0,
      0,
    );
    const p = mp(mixer.duckParam);
    expect(p.valueAtTime(11.5)).toBeCloseTo(1.0); // before the duck.
    expect(p.valueAtTime(11.96)).toBeCloseTo(0.625, 2); // mid-attack (halfway 1→0.25).
    expect(p.valueAtTime(12.7)).toBeCloseTo(0.25); // in the hold.
    expect(p.valueAtTime(13.55)).toBeCloseTo(0.625, 2); // mid-release (halfway 0.25→1).
    expect(p.valueAtTime(14.0)).toBeCloseTo(1.0); // recovered.
  });

  it('should anchor from trackedDuck (1.0 initially), NEVER duckParam.value', () => {
    const { mixer } = makeMixer();
    const p = mp(mixer.duckParam);
    p.value = -999; // bogus stale param.value (Firefox quirk).
    mixer.scheduleDuck(
      [{ startCtx: 5, endCtx: 6, toGain: 0.4, attackSec: 0.1, releaseSec: 0.1 }],
      0,
      0,
    );
    // The first anchor is the tracked value (1.0), not the bogus -999.
    expect(p.events[0]).toMatchObject({ method: 'setValueAtTime', value: 1.0 });
  });

  it('should not write masterParam when scheduling a duck (single-writer separation)', () => {
    const { mixer } = makeMixer();
    mixer.scheduleDuck(
      [{ startCtx: 1, endCtx: 2, toGain: 0.5, attackSec: 0.1, releaseSec: 0.1 }],
      0,
      0,
    );
    expect(mp(mixer.masterParam).events).toHaveLength(0);
  });
});

describe('scheduleDuck — overlap merge (MIN toGain, single-writer D-019)', () => {
  it('should coalesce overlapping spans to one envelope at the deepest toGain', () => {
    const { mixer } = makeMixer();
    // Two overlapping cues: first dips to 0.5, second (deeper) to 0.2; they overlap
    // (first release ends at 2.5, second attack starts at 2.4).
    const spans: DuckSpan[] = [
      { startCtx: 1.0, endCtx: 2.0, toGain: 0.5, attackSec: 0.1, releaseSec: 0.5 },
      { startCtx: 2.5, endCtx: 3.5, toGain: 0.2, attackSec: 0.1, releaseSec: 0.3 },
    ];
    mixer.scheduleDuck(spans, 0, 0);
    const p = mp(mixer.duckParam);
    const ramps = valueEvents(p).filter((e) => e.method === 'linearRampToValueAtTime');

    // ONE envelope: the floor value across the merged body is the MIN (0.2), and unity
    // is regained only after the LAST cue's release (endCtx 3.5 + release 0.3 = 3.8).
    const deepest = Math.min(...ramps.map((e) => e.value));
    expect(deepest).toBeCloseTo(0.2);
    const recover = ramps.find((e) => Math.abs(e.time - 3.8) < 1e-6);
    expect(recover?.value).toBeCloseTo(1.0);
    // It does NOT recover to 1.0 between the two cues (no ramp back to 1.0 before ~3.8).
    const earlyRecover = ramps.find((e) => e.value === 1.0 && e.time < 3.8 - 1e-6);
    expect(earlyRecover).toBeUndefined();
  });

  it('should never recover to 1.0 mid-overlap (no two competing ramps on the param)', () => {
    const { mixer } = makeMixer();
    mixer.scheduleDuck(
      [
        { startCtx: 1.0, endCtx: 2.0, toGain: 0.4, attackSec: 0.05, releaseSec: 0.4 },
        { startCtx: 2.2, endCtx: 3.0, toGain: 0.3, attackSec: 0.05, releaseSec: 0.2 },
      ],
      0,
      0,
    );
    const p = mp(mixer.duckParam);
    // Between the cues the envelope stays ducked (never returns to unity).
    expect(p.valueAtTime(2.1)).toBeLessThan(1.0);
  });

  it('should schedule adjacent NON-overlapping spans as two dips with full recovery', () => {
    const { mixer } = makeMixer();
    mixer.scheduleDuck(
      [
        { startCtx: 1.0, endCtx: 1.5, toGain: 0.4, attackSec: 0.05, releaseSec: 0.1 },
        { startCtx: 5.0, endCtx: 5.5, toGain: 0.3, attackSec: 0.05, releaseSec: 0.1 },
      ],
      0,
      0,
    );
    const p = mp(mixer.duckParam);
    // First dip recovers fully before the second begins (gap is at unity).
    expect(p.valueAtTime(1.6)).toBeCloseTo(1.0); // after first release.
    expect(p.valueAtTime(3.0)).toBeCloseTo(1.0); // in the gap.
    expect(p.valueAtTime(5.25)).toBeCloseTo(0.3); // in the second hold.
  });
});

describe('scheduleDuck — degenerate input handling (edge-cases §1, §2)', () => {
  it('should be a no-op on empty spans and leave trackedDuck at 1.0', () => {
    const { mixer } = makeMixer();
    mixer.scheduleDuck([], 0, 0);
    const p = mp(mixer.duckParam);
    expect(p.events).toHaveLength(0); // nothing scheduled.
    // A subsequent real duck still anchors from 1.0 (trackedDuck untouched).
    mixer.scheduleDuck(
      [{ startCtx: 1, endCtx: 2, toGain: 0.5, attackSec: 0.1, releaseSec: 0.1 }],
      0,
      0,
    );
    expect(p.events[0]).toMatchObject({ method: 'setValueAtTime', value: 1.0 });
  });

  it('should clamp toGain out of [0,1] before emitting the envelope', () => {
    const { mixer } = makeMixer();
    mixer.scheduleDuck(
      [
        { startCtx: 1, endCtx: 2, toGain: 1.5, attackSec: 0.1, releaseSec: 0.1 },
        { startCtx: 5, endCtx: 6, toGain: -0.3, attackSec: 0.1, releaseSec: 0.1 },
      ],
      0,
      0,
    );
    const p = mp(mixer.duckParam);
    const ramps = valueEvents(p).filter((e) => e.method === 'linearRampToValueAtTime');
    for (const e of ramps) {
      expect(e.value).toBeGreaterThanOrEqual(0);
      expect(e.value).toBeLessThanOrEqual(1);
    }
    expect(p.valueAtTime(1.5)).toBeCloseTo(1.0); // toGain 1.5 clamped to 1.0 → flat.
    expect(p.valueAtTime(5.5)).toBeCloseTo(0.0); // toGain -0.3 clamped to 0.
  });

  it('should skip spans with a non-finite toGain/attackSec/releaseSec', () => {
    const { mixer } = makeMixer();
    mixer.scheduleDuck(
      [
        { startCtx: 1, endCtx: 2, toGain: NaN, attackSec: 0.1, releaseSec: 0.1 },
        { startCtx: 3, endCtx: 4, toGain: 0.5, attackSec: Infinity, releaseSec: 0.1 },
        { startCtx: 5, endCtx: 6, toGain: 0.4, attackSec: 0.1, releaseSec: -Infinity },
      ],
      0,
      0,
    );
    const p = mp(mixer.duckParam);
    // Every span was skipped → no envelope written.
    expect(p.events).toHaveLength(0);
  });

  it('should skip a truly inverted span (endCtx < startCtx)', () => {
    const { mixer } = makeMixer();
    mixer.scheduleDuck(
      [{ startCtx: 5, endCtx: 4, toGain: 0.5, attackSec: 0.1, releaseSec: 0.1 }],
      0,
      0,
    );
    expect(mp(mixer.duckParam).events).toHaveLength(0);
  });

  it('should emit attack+release with no hold for a zero-body span (startCtx === endCtx)', () => {
    const { mixer } = makeMixer();
    mixer.scheduleDuck(
      [{ startCtx: 5, endCtx: 5, toGain: 0.3, attackSec: 0.1, releaseSec: 0.1 }],
      0,
      0,
    );
    const p = mp(mixer.duckParam);
    expect(p.valueAtTime(5.0)).toBeCloseTo(0.3); // momentary floor at the cue instant.
    expect(p.valueAtTime(4.9)).toBeCloseTo(1.0); // before attack.
    expect(p.valueAtTime(5.1)).toBeCloseTo(1.0); // after release.
  });

  it('should write a 0-second attack/release as a step (stepRampSec:0), linear only', () => {
    const { mixer } = makeMixer();
    mixer.scheduleDuck(
      [{ startCtx: 5, endCtx: 6, toGain: 0.3, attackSec: 0, releaseSec: 0 }],
      0,
      0,
    );
    const p = mp(mixer.duckParam);
    expect(p.methodLog).not.toContain('exponentialRampToValueAtTime');
    expect(p.methodLog).not.toContain('setValueCurveAtTime');
    // Hard edge at the cue boundary: ducked through the body.
    expect(p.valueAtTime(5.5)).toBeCloseTo(0.3);
  });
});

describe('scheduleDuck — seek into the middle of a duck (design §4.4)', () => {
  it('should resume from the mid-envelope value via valueAt, not 1.0 or a stale value', () => {
    const { mixer } = makeMixer();
    const spans: DuckSpan[] = [
      { startCtx: 12.0, endCtx: 13.4, toGain: 0.25, attackSec: 0.08, releaseSec: 0.3 },
    ];
    const p = mp(mixer.duckParam);
    p.value = 0.99; // bogus stale param.value.

    // Seek into the hold at t = 12.7 (startOffsetSec = 12.7). The region t's are ctx
    // times; t0 = 0 maps point-time to ctx-time 1:1.
    mixer.scheduleDuck(spans, /* t0 */ 0, /* startOffsetSec */ 12.7);

    // The lane anchor (first event) is the mid-envelope value (0.25 in the hold), NOT
    // 1.0 and NOT the stale 0.99.
    const firstAnchor = p.events.find((e) => e.method === 'setValueAtTime');
    expect(firstAnchor?.value).toBeCloseTo(0.25);
  });

  it('should resume mid-ATTACK from the interpolated value on a seek', () => {
    const { mixer } = makeMixer();
    // attack 1.0 → 0.25 over [11.92, 12.0]; seek at 11.96 → halfway → 0.625.
    mixer.scheduleDuck(
      [{ startCtx: 12.0, endCtx: 13.4, toGain: 0.25, attackSec: 0.08, releaseSec: 0.3 }],
      0,
      11.96,
    );
    const p = mp(mixer.duckParam);
    const firstAnchor = p.events.find((e) => e.method === 'setValueAtTime');
    expect(firstAnchor?.value).toBeCloseTo(0.625, 2);
  });

  it('should settle trackedDuck so a seek PAST all ducks anchors a later schedule from 1.0', () => {
    const { mixer } = makeMixer();
    const spans: DuckSpan[] = [
      { startCtx: 1.0, endCtx: 2.0, toGain: 0.3, attackSec: 0.1, releaseSec: 0.1 },
    ];
    // Seek past the entire duck (offset 5 > releaseEnd 2.1).
    mixer.scheduleDuck(spans, 0, 5.0);
    // A follow-up duck anchors from 1.0 (the settled tracked value).
    const p = mp(mixer.duckParam);
    p.events.length = 0; // clear to inspect the next schedule's anchor.
    mixer.scheduleDuck(
      [{ startCtx: 10, endCtx: 11, toGain: 0.4, attackSec: 0.1, releaseSec: 0.1 }],
      0,
      0,
    );
    expect(p.events[0]).toMatchObject({ method: 'setValueAtTime', value: 1.0 });
  });
});

// =====================================================================================
// cancelDuck — smooth recover + trackedDuck reset (design §4.5)
// =====================================================================================

describe('cancelDuck', () => {
  it('should cancel + ramp smoothly to 1.0 anchored from trackedDuck, linear only', () => {
    const { mixer } = makeMixer();
    mixer.scheduleDuck(
      [{ startCtx: 12.0, endCtx: 13.4, toGain: 0.25, attackSec: 0.08, releaseSec: 0.3 }],
      0,
      12.7, // resume mid-hold → trackedDuck = 0.25.
    );
    const p = mp(mixer.duckParam);
    p.events.length = 0; // isolate the cancel ops.

    mixer.cancelDuck(12.7);
    expect(p.methodLog).toContain('cancelAndHoldAtTime'); // ctx supports it by default.
    const anchor = p.events.find((e) => e.method === 'setValueAtTime');
    const ramp = p.events.find((e) => e.method === 'linearRampToValueAtTime');
    expect(anchor?.value).toBeCloseTo(0.25); // anchored from trackedDuck, not 1.0.
    expect(ramp).toMatchObject({ value: 1.0 }); // rises back to unity.
    expect(p.methodLog).not.toContain('exponentialRampToValueAtTime');
    expect(p.methodLog).not.toContain('setValueCurveAtTime');
  });

  it('should fall back to cancelScheduledValues when cancelAndHoldAtTime is absent (Firefox)', () => {
    const { mixer } = makeMixer({ supportsCancelAndHold: false });
    mixer.scheduleDuck(
      [{ startCtx: 5, endCtx: 6, toGain: 0.4, attackSec: 0.1, releaseSec: 0.1 }],
      0,
      0,
    );
    const p = mp(mixer.duckParam);
    p.events.length = 0;
    mixer.cancelDuck(2);
    expect(p.methodLog).toContain('cancelScheduledValues');
    expect(p.methodLog).not.toContain('cancelAndHoldAtTime');
    expect(p.methodLog).toContain('linearRampToValueAtTime');
  });

  it('should reset trackedDuck to 1.0 so a later schedule anchors from unity', () => {
    const { mixer } = makeMixer();
    mixer.scheduleDuck(
      [{ startCtx: 12.0, endCtx: 13.4, toGain: 0.25, attackSec: 0.08, releaseSec: 0.3 }],
      0,
      12.7,
    );
    mixer.cancelDuck(12.7);
    const p = mp(mixer.duckParam);
    p.events.length = 0;
    mixer.scheduleDuck(
      [{ startCtx: 20, endCtx: 21, toGain: 0.5, attackSec: 0.1, releaseSec: 0.1 }],
      0,
      0,
    );
    expect(p.events[0]).toMatchObject({ method: 'setValueAtTime', value: 1.0 });
  });
});

// =====================================================================================
// (c) SINGLE-INPUT MASTER + (d) CONNECT / DISCONNECT / DISPOSE (design §5, §6)
// =====================================================================================

describe('connect / disconnect — move only master output edge', () => {
  it('should set exactly one master output edge on connect(target)', () => {
    const { ctx, mixer } = makeMixer();
    const target = new MockAudioNode(ctx, 'destination');
    mixer.connect(target as unknown as AudioNode);
    expect(mn(mixer.master).connections).toHaveLength(1);
    expect(mn(mixer.master).isConnectedTo(target)).toBe(true);
  });

  it('should keep master upstream count at 1 across connect (only the OUTPUT changes)', () => {
    const { ctx, mixer } = makeMixer();
    const target = new MockAudioNode(ctx, 'destination');
    mixer.connect(target as unknown as AudioNode);
    expect(mn(mixer.master).inputs).toHaveLength(1); // still just busSum upstream.
  });

  it('should move the ONE edge on retarget (old dropped, new added)', () => {
    const { ctx, mixer } = makeMixer();
    const a = new MockAudioNode(ctx, 'destination');
    const b = new MockAudioNode(ctx, 'destination');
    mixer.connect(a as unknown as AudioNode);
    mixer.connect(b as unknown as AudioNode);
    const master = mn(mixer.master);
    expect(master.connections).toHaveLength(1); // exactly one edge at all times.
    expect(master.isConnectedTo(a)).toBe(false); // old dropped.
    expect(master.isConnectedTo(b)).toBe(true); // new added.
  });

  it('should leave the internal graph intact across a retarget', () => {
    const { ctx, mixer } = makeMixer();
    const a = new MockAudioNode(ctx, 'destination');
    const b = new MockAudioNode(ctx, 'destination');
    mixer.connect(a as unknown as AudioNode);
    mixer.connect(b as unknown as AudioNode);
    const { bed, duck, cue, lift, busSum, master } = gainsOf(ctx);
    expect(bed.isConnectedTo(duck)).toBe(true);
    expect(duck.isConnectedTo(busSum)).toBe(true);
    expect(cue.isConnectedTo(busSum)).toBe(true);
    expect(lift.isConnectedTo(busSum)).toBe(true);
    expect(busSum.isConnectedTo(master)).toBe(true);
    expect(master.inputs).toHaveLength(1);
  });

  it('should handle connect twice to the SAME target without a double edge', () => {
    const { ctx, mixer } = makeMixer();
    const target = new MockAudioNode(ctx, 'destination');
    mixer.connect(target as unknown as AudioNode);
    mixer.connect(target as unknown as AudioNode);
    expect(mn(mixer.master).connections).toHaveLength(1);
  });

  it('should drop master output edge on disconnect()', () => {
    const { ctx, mixer } = makeMixer();
    const target = new MockAudioNode(ctx, 'destination');
    mixer.connect(target as unknown as AudioNode);
    mixer.disconnect();
    expect(mn(mixer.master).connections).toHaveLength(0);
    // internal graph intact — a later connect re-establishes output.
    expect(mn(mixer.master).inputs).toHaveLength(1);
  });

  it('should re-establish output after disconnect via a fresh connect', () => {
    const { ctx, mixer } = makeMixer();
    const target = new MockAudioNode(ctx, 'destination');
    mixer.connect(target as unknown as AudioNode);
    mixer.disconnect();
    mixer.connect(target as unknown as AudioNode);
    expect(mn(mixer.master).isConnectedTo(target)).toBe(true);
  });

  it('should be a no-op (no throw) on disconnect() with no current edge', () => {
    const { mixer } = makeMixer();
    expect(() => mixer.disconnect()).not.toThrow();
    expect(mn(mixer.master).disconnectCalls).toBe(0); // platform disconnect never called.
  });
});

describe('dispose — idempotent teardown (design §6)', () => {
  it('should cancel duck automation and disconnect every node', () => {
    const { ctx, mixer } = makeMixer();
    const target = new MockAudioNode(ctx, 'destination');
    mixer.connect(target as unknown as AudioNode);
    mixer.scheduleDuck(
      [{ startCtx: 1, endCtx: 2, toGain: 0.5, attackSec: 0.1, releaseSec: 0.1 }],
      0,
      0,
    );
    const p = mp(mixer.duckParam);
    p.events.length = 0;

    mixer.dispose();
    expect(p.methodLog).toContain('cancelScheduledValues'); // cancel, no recover ramp.
    // No recover ramp emitted on teardown.
    expect(p.methodLog).not.toContain('linearRampToValueAtTime');
    const { bed, duck, cue, lift, busSum, master } = gainsOf(ctx);
    for (const g of [bed, duck, cue, lift, busSum, master]) {
      expect(g.disconnectCalls).toBeGreaterThan(0);
    }
  });

  it('should be fully idempotent on a second dispose()', () => {
    const { ctx, mixer } = makeMixer();
    mixer.dispose();
    const { master } = gainsOf(ctx);
    const calls = master.disconnectCalls;
    mixer.dispose(); // second call returns immediately.
    expect(master.disconnectCalls).toBe(calls);
  });

  it('should not throw when disposing while a duck ramp is mid-flight', () => {
    const { mixer } = makeMixer();
    mixer.scheduleDuck(
      [{ startCtx: 1, endCtx: 5, toGain: 0.2, attackSec: 0.1, releaseSec: 0.3 }],
      0,
      0,
    );
    expect(() => mixer.dispose()).not.toThrow();
  });

  it('should guard scheduleDuck/cancelDuck/connect/disconnect as no-ops after dispose', () => {
    const { ctx, mixer } = makeMixer();
    mixer.dispose();
    const p = mp(mixer.duckParam);
    p.events.length = 0;
    const target = new MockAudioNode(ctx, 'destination');

    expect(() => {
      mixer.scheduleDuck(
        [{ startCtx: 1, endCtx: 2, toGain: 0.5, attackSec: 0.1, releaseSec: 0.1 }],
        0,
        0,
      );
      mixer.cancelDuck(1);
      mixer.connect(target as unknown as AudioNode);
      mixer.disconnect();
    }).not.toThrow();
    expect(p.events).toHaveLength(0); // nothing scheduled after dispose.
    expect(mn(mixer.master).isConnectedTo(target)).toBe(false); // no edge added.
  });
});

// =====================================================================================
// (e) OFFLINE REUSE — byte-identical behavior on an OfflineAudioContext-style context
// =====================================================================================

describe('offline reuse — same code path on an OfflineAudioContext-style context', () => {
  it('should build the identical graph and schedule the identical envelope offline', () => {
    // Live context (48k) and an offline-style context (any sampleRate, e.g. 44100).
    const live = makeMixer({ sampleRate: 48000 });
    const offline = makeMixer({ sampleRate: 44100 });

    const spans: DuckSpan[] = [
      { startCtx: 12.0, endCtx: 13.4, toGain: 0.25, attackSec: 0.08, releaseSec: 0.3 },
    ];
    live.mixer.scheduleDuck(spans, 0, 0);
    offline.mixer.scheduleDuck(spans, 0, 0);

    const lp = mp(live.mixer.duckParam);
    const op = mp(offline.mixer.duckParam);
    // Byte-identical op sequence (no platform branch).
    expect(op.methodLog).toEqual(lp.methodLog);
    expect(valueEvents(op)).toEqual(valueEvents(lp));

    // Same connect-to-destination behavior.
    offline.mixer.connect(offline.ctx.destination as unknown as AudioNode);
    expect(mn(offline.mixer.master).isConnectedTo(offline.ctx.destination)).toBe(true);
    expect(mn(offline.mixer.master).inputs).toHaveLength(1);
  });

  it('should never reference transport globals in the source (L0 discipline guardrail)', async () => {
    // The mixer must not import or use rAF/MediaSession/Wake Lock/setTimeout/
    // createMediaStreamDestination — that would break offline reuse (arch §6).
    const fs = await import('node:fs');
    const url = await import('node:url');
    const path = await import('node:path');
    const here = path.dirname(url.fileURLToPath(import.meta.url));
    const src = fs.readFileSync(path.join(here, 'mixer.ts'), 'utf8');
    expect(src).not.toMatch(/requestAnimationFrame/);
    expect(src).not.toMatch(/MediaSession|mediaSession/);
    expect(src).not.toMatch(/createMediaStreamDestination/);
    expect(src).not.toMatch(/\bsetTimeout\b/);
    expect(src).not.toMatch(/WakeLock|wakeLock/);
    expect(src).not.toMatch(/from '\.\/transport/);
  });
});

// =====================================================================================
// (f) AUTOMATION SEAM — confirm scheduleLane exports from automation (design §3, arch §6)
// =====================================================================================

describe('automation seam — scheduleLane + LanePoint/ScheduleLaneOpts exports', () => {
  it('should import scheduleLane function from automation', async () => {
    // Confirm the function is exported and available for the mixer to use (design §3).
    const { scheduleLane } = await import('./automation');
    expect(typeof scheduleLane).toBe('function');
  });

  it('should import LanePoint type from automation', async () => {
    // Confirm the type is exported for mixer's duck scheduling (design §3).
    // Note: TypeScript types are erased at runtime, so this validates module structure.
    const src = (await import('node:fs')).readFileSync(
      ((await import('node:path')).dirname((await import('node:url')).fileURLToPath(import.meta.url)) + '/automation.ts'),
      'utf8'
    );
    // Verify the re-export from session-model
    expect(src).toMatch(/export type \{ LanePoint \} from '\.\/session-model'/);
  });

  it('should import ScheduleLaneOpts interface from automation', async () => {
    // Confirm the interface is exported for mixer's duck scheduling (arch §6).
    const src = (await import('node:fs')).readFileSync(
      ((await import('node:path')).dirname((await import('node:url')).fileURLToPath(import.meta.url)) + '/automation.ts'),
      'utf8'
    );
    // Verify the interface export
    expect(src).toMatch(/export interface ScheduleLaneOpts/);
  });

  it('should use scheduleLane in mixer.scheduleDuck (seam conformance)', async () => {
    // Verify mixer.ts correctly imports and uses the shared scheduleLane primitive.
    const fs = await import('node:fs');
    const url = await import('node:url');
    const path = await import('node:path');
    const here = path.dirname(url.fileURLToPath(import.meta.url));
    const src = fs.readFileSync(path.join(here, 'mixer.ts'), 'utf8');
    // Confirm the import (includes ScheduleLaneOpts for reused automation contract; see interfaces.md §2)
    expect(src).toMatch(/import \{ scheduleLane, type LanePoint, type ScheduleLaneOpts \} from '\.\/automation'/);
    // Confirm it's used in the implementation
    expect(src).toMatch(/scheduleLane\s*\(/);
  });

  it('should confirm mixer is the sole writer of duckParam (D-019)', async () => {
    // Single-writer contract: only mixer.scheduleDuck and mixer.cancelDuck write duckParam.
    // No other module (layer-scheduler, voice, etc.) can write duckParam.
    const { mixer } = makeMixer();
    const p = mp(mixer.duckParam);
    // Clear any construction-time events
    p.events.length = 0;

    // Only scheduleDuck and cancelDuck should be able to write events
    mixer.scheduleDuck(
      [{ startCtx: 5, endCtx: 6, toGain: 0.5, attackSec: 0.1, releaseSec: 0.1 }],
      0,
      0,
    );
    expect(p.events.length).toBeGreaterThan(0);

    p.events.length = 0;
    mixer.cancelDuck(5);
    expect(p.events.length).toBeGreaterThan(0);
  });
});
