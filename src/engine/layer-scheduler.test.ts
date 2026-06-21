// layer-scheduler.test.ts — time composition, source start/range, seek mid-clip,
// duck-span overlap merge, and the retarget/cancel/dispose lifecycle.
//
// Pure arithmetic + op-sequence assertions (design §8): no real AudioContext required.
// A recording Mixer stub captures scheduleDuck/cancelDuck calls; recording LayerNode
// stubs (backed by MockAudioParam doubles from the shared webaudio-mock) capture
// start() and the scheduleLane op-sequences written onto gainParam/panParam. We assert
// the AudioParam op SEQUENCES (never read param.value), the duck-merge MIN-toGain, and
// the relative→absolute time mapping.

import { describe, it, expect } from 'vitest';
import {
  scheduleLayers,
  absPoints,
  laneValueAt,
  mergeDuckSpans,
} from './layer-scheduler';
import { VOLUME_MICRORAMP_SEC } from './automation';
import { MockAudioContext, MockAudioParam } from '../test/webaudio-mock';
import type { Mixer, DuckSpan } from './mixer';
import type { LayerNode } from './layer-engine';
import type { Layer, LanePoint } from './session-model';

// ---------------------------------------------------------------------------
// Recording test doubles
// ---------------------------------------------------------------------------

interface RecordedDuck {
  spans: readonly DuckSpan[];
  t0: number;
  startOffsetSec: number;
}

interface MixerStub extends Mixer {
  duckCalls: RecordedDuck[];
  cancelDuckCalls: number[];
}

function makeMixerStub(ctx: MockAudioContext): MixerStub {
  const duckCalls: RecordedDuck[] = [];
  const cancelDuckCalls: number[] = [];
  // master is read only for its .context (the retarget/cancel default time).
  const master = ctx.createGain();
  const stub = {
    bedInput: ctx.createGain(),
    cueInput: ctx.createGain(),
    liftInput: ctx.createGain(),
    master,
    masterParam: master.gain,
    duckParam: ctx.createGain().gain,
    duckCalls,
    cancelDuckCalls,
    scheduleDuck(spans: readonly DuckSpan[], t0: number, startOffsetSec: number): void {
      duckCalls.push({ spans: spans.map((s) => ({ ...s })), t0, startOffsetSec });
    },
    cancelDuck(atCtxTime: number): void {
      cancelDuckCalls.push(atCtxTime);
    },
    connect(): void {},
    disconnect(): void {},
    dispose(): void {},
  };
  return stub as unknown as MixerStub;
}

interface NodeStub extends LayerNode {
  gainEvents: MockAudioParam;
  panEvents: MockAudioParam;
  startCalls: number[];
  stopCalls: number[];
}

function makeNodeStub(ctx: MockAudioContext, layer: Layer, durationSec = 0): NodeStub {
  const gain = ctx.makeParam(1);
  const pan = ctx.makeParam(0, { min: -1, max: 1 });
  const startCalls: number[] = [];
  const stopCalls: number[] = [];
  const node = {
    id: layer.id,
    kind: layer.kind,
    output: ctx.createStereoPanner(),
    gainParam: gain,
    panParam: pan,
    durationSec,
    missing: false,
    state: 'idle' as const,
    gainEvents: gain,
    panEvents: pan,
    startCalls,
    stopCalls,
    start(atCtx: number): void {
      startCalls.push(atCtx);
    },
    stop(atCtx?: number): void {
      stopCalls.push(atCtx ?? -1);
    },
    dispose(): void {},
  };
  return node as unknown as NodeStub;
}

function setup(
  layers: Layer[],
  durations: readonly number[] = [],
): {
  ctx: MockAudioContext;
  mixer: MixerStub;
  nodes: NodeStub[];
} {
  const ctx = new MockAudioContext();
  const mixer = makeMixerStub(ctx);
  // Each node's durationSec defaults to 0 (point dip) unless a per-index duration is given.
  const nodes = layers.map((l, i) => makeNodeStub(ctx, l, durations[i] ?? 0));
  return { ctx, mixer, nodes };
}

// Lane point helpers.
const pt = (t: number, value: number, transition?: LanePoint['transition']): LanePoint =>
  transition ? { t, value, transition } : { t, value };

const toneLayer = (over: Partial<Layer> & Pick<Layer, 'id' | 't'>): Layer => ({
  kind: 'tone',
  source: { synth: { shape: 'sine', freqHz: 440, attackSec: 0.5, releaseSec: 1.0 } },
  ...over,
});

const ambianceLayer = (over: Partial<Layer> & Pick<Layer, 'id' | 't'>): Layer => ({
  kind: 'ambiance',
  source: { clipId: 'amb-1' },
  loop: true,
  ...over,
});

const voiceLayer = (over: Partial<Layer> & Pick<Layer, 'id' | 't'>): Layer => ({
  kind: 'voice',
  source: { clipId: 'cue-1' },
  ...over,
});

// ---------------------------------------------------------------------------
// 1. Pure helpers: absPoints + laneValueAt (design §3, tasks "impl helpers")
// ---------------------------------------------------------------------------

describe('absPoints — relative→absolute session shift', () => {
  it('should shift every point t by +layerT, leaving value/transition untouched', () => {
    const rel = [pt(0, 0), pt(5, 1, 'smooth')];
    const abs = absPoints(rel, 60);
    expect(abs).toEqual([
      { t: 60, value: 0 },
      { t: 65, value: 1, transition: 'smooth' },
    ]);
  });

  it('should return an empty list for an absent or empty lane (edge §4a)', () => {
    expect(absPoints(undefined, 30)).toEqual([]);
    expect(absPoints([], 30)).toEqual([]);
  });
});

describe('laneValueAt — carry-forward + transition evaluator', () => {
  it('should interpolate linearly mid-segment, hold after last, carry before first', () => {
    const abs = absPoints([pt(0, 0), pt(10, 1)], 60); // [60,0]..[70,1]
    expect(laneValueAt(abs, 55, 1)).toBeCloseTo(0); // before first → first value
    expect(laneValueAt(abs, 65, 1)).toBeCloseTo(0.5); // mid-segment
    expect(laneValueAt(abs, 80, 1)).toBeCloseTo(1); // after last → held
  });

  it('should return the point value exactly on a point (no double-event, §1b)', () => {
    const abs = absPoints([pt(0, 0.2), pt(10, 0.8)], 0);
    expect(laneValueAt(abs, 10, 1)).toBeCloseTo(0.8);
    expect(laneValueAt(abs, 0, 1)).toBeCloseTo(0.2);
  });

  it('should be constant at the fallback for an empty lane (unity / center)', () => {
    expect(laneValueAt([], 5, 1)).toBe(1); // gain fallback unity
    expect(laneValueAt([], 5, 0)).toBe(0); // pan fallback center
  });

  it('should be constant for a single-point lane everywhere (§4b)', () => {
    const abs = absPoints([pt(0, 0.4)], 100);
    expect(laneValueAt(abs, 50, 1)).toBeCloseTo(0.4);
    expect(laneValueAt(abs, 100, 1)).toBeCloseTo(0.4);
    expect(laneValueAt(abs, 999, 1)).toBeCloseTo(0.4);
  });

  it('should hold across a hold transition and exp-interpolate an exp transition', () => {
    const held = absPoints([pt(0, 0.2, 'hold'), pt(10, 0.8)], 0);
    expect(laneValueAt(held, 5, 1)).toBeCloseTo(0.2); // hold = a until the next point
    const exp = absPoints([pt(0, 1, 'exp'), pt(10, 100)], 0);
    expect(laneValueAt(exp, 5, 1)).toBeCloseTo(10); // geometric mid-point
  });
});

// ---------------------------------------------------------------------------
// 2. Time composition — gain/pan lanes land at t0 + (L.t + p.t - startOffsetSec)
// ---------------------------------------------------------------------------

describe('scheduleLayers — time composition (design §3)', () => {
  it('should land a layer-at-60 gain fade at ctxTime = t0 + (60 + p.t - startOffsetSec)', () => {
    const layer = toneLayer({ id: 'a', t: 60, gain: [pt(0, 0), pt(5, 1)] });
    const { mixer, nodes } = setup([layer]);
    scheduleLayers(mixer, nodes, [layer], { t0: 100, startOffsetSec: 0 });

    const g = nodes[0].gainEvents;
    // Anchor at floorT(t0)=100 with the lane-start value (0).
    expect(g.events[0]).toMatchObject({ method: 'setValueAtTime', value: 0, time: 100 });
    // The ramp to 1 lands at ctxTime = 100 + (60 + 5 - 0) = 165.
    const ramp = g.events.find((e) => e.method === 'linearRampToValueAtTime' && e.value === 1);
    expect(ramp?.time).toBeCloseTo(165);
  });

  it('should schedule the gain lane with the VOLUME_MICRORAMP_SEC step fork and pan with a bare step', () => {
    const layer = toneLayer({
      id: 'a',
      t: 0,
      gain: [pt(0, 0.5, 'hold'), pt(2, 0.9)], // a stepped gain → micro-ramp
      spatial: [pt(0, -0.5, 'hold'), pt(2, 0.5)], // a stepped pan → bare step
    });
    const { mixer, nodes } = setup([layer]);
    scheduleLayers(mixer, nodes, [layer], { t0: 0, startOffsetSec: 0 });

    // Gain: a hold step micro-ramps over VOLUME_MICRORAMP_SEC (setValueAtTime then ramp).
    const g = nodes[0].gainEvents;
    const microRamp = g.events.find(
      (e) => e.method === 'linearRampToValueAtTime' && Math.abs((e.time ?? 0) - (2 + VOLUME_MICRORAMP_SEC)) < 1e-9,
    );
    expect(microRamp?.value).toBeCloseTo(0.9);

    // Pan: a hold step is a bare setValueAtTime at the boundary, never a ramp.
    const p = nodes[0].panEvents;
    expect(p.methodLog).not.toContain('linearRampToValueAtTime');
    const step = p.events.find((e) => e.method === 'setValueAtTime' && e.value === 0.5);
    expect(step?.time).toBeCloseTo(2);
  });

  it('should anchor an absent gain/spatial lane to a single constant write (unity / center)', () => {
    const layer = ambianceLayer({ id: 'a', t: 0 }); // no gain/spatial
    const { mixer, nodes } = setup([layer]);
    scheduleLayers(mixer, nodes, [layer], { t0: 10, startOffsetSec: 0 });

    const g = nodes[0].gainEvents;
    const p = nodes[0].panEvents;
    // One anchored setValueAtTime each: unity gain, center pan. No ramps.
    expect(g.events).toHaveLength(1);
    expect(g.events[0]).toMatchObject({ method: 'setValueAtTime', value: 1, time: 10 });
    expect(p.events).toHaveLength(1);
    expect(p.events[0]).toMatchObject({ method: 'setValueAtTime', value: 0, time: 10 });
    // Never reads param.value — assert via the op sequence only.
    expect(g.methodLog).not.toContain('linearRampToValueAtTime');
  });
});

// ---------------------------------------------------------------------------
// 3. Source start placement + range / seek intra-offset (design §4)
// ---------------------------------------------------------------------------

describe('scheduleLayers — source start placement and range (design §4)', () => {
  it('should start a layer-at-60 at t0 + 60 when startOffsetSec is 0 (in range)', () => {
    const layer = ambianceLayer({ id: 'a', t: 60 });
    const { mixer, nodes } = setup([layer]);
    scheduleLayers(mixer, nodes, [layer], { t0: 5, startOffsetSec: 0 });
    expect(nodes[0].startCalls).toEqual([65]); // 5 + 60 - 0
  });

  it('should clamp a seek-mid-layer start to t0 (engine advances the buffer)', () => {
    // ambiance loop, seek 600 into a layer placed at 500 (intoLayer = 100).
    const layer = ambianceLayer({ id: 'a', t: 500 });
    const { mixer, nodes } = setup([layer]);
    scheduleLayers(mixer, nodes, [layer], { t0: 2, startOffsetSec: 600 });
    // nodeStartCtx = 2 + (500 - 600) = -98 → clamped to t0 = 2.
    expect(nodes[0].startCalls).toEqual([2]);
  });

  it('should anchor lanes at laneValueAt(abs, startOffsetSec) on a mid-layer seek', () => {
    // gain fade 0→1 over [500,510]; seek to 505 → mid-fade anchor 0.5 at t0.
    const layer = ambianceLayer({ id: 'a', t: 500, gain: [pt(0, 0), pt(10, 1)] });
    const { mixer, nodes } = setup([layer]);
    scheduleLayers(mixer, nodes, [layer], { t0: 3, startOffsetSec: 505 });
    const g = nodes[0].gainEvents;
    // The lane seek anchor (JS-tracked, NOT param.value) is the mid-fade value 0.5 at t0.
    expect(g.events[0]).toMatchObject({ method: 'setValueAtTime', time: 3 });
    expect(g.events[0].value).toBeCloseTo(0.5);
  });

  it('should keep a looping ambiance in range many loop-lengths past its start (§2a)', () => {
    const layer = ambianceLayer({ id: 'a', t: 0 });
    const { mixer, nodes } = setup([layer]);
    scheduleLayers(mixer, nodes, [layer], { t0: 1, startOffsetSec: 9999 });
    expect(nodes[0].startCalls).toEqual([1]); // still started (clamped to t0)
  });

  it('should NOT start a one-shot tone fully ended before the offset (out of range, §1c)', () => {
    // tone length = attack 0.5 + release 1.0 = 1.5; placed at 10 → ends at 11.5.
    const layer = toneLayer({ id: 'a', t: 10, gain: [pt(0, 0), pt(1, 1)] });
    const { mixer, nodes } = setup([layer]);
    scheduleLayers(mixer, nodes, [layer], { t0: 0, startOffsetSec: 20 });
    expect(nodes[0].startCalls).toEqual([]); // not started
    // Out-of-range → no lanes scheduled either.
    expect(nodes[0].gainEvents.events).toHaveLength(0);
    expect(nodes[0].panEvents.events).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 4. Duck-span computation + overlap MERGE (design §5)
// ---------------------------------------------------------------------------

describe('mergeDuckSpans — overlap coalesce (design §5.2)', () => {
  const duck = (toGain: number, attackSec = 0.1, releaseSec = 0.5) => ({
    toGain,
    attackSec,
    releaseSec,
  });

  // Pair each layer with a recording node carrying `durationSec` (the cue body length).
  // `durations[i]` defaults to 0 (a zero-body point dip), preserving the legacy
  // `releaseEnd = L.t + releaseSec` arithmetic where the cue body is not under test.
  function pairs(
    layers: Layer[],
    durations: readonly number[] = [],
  ): { node: LayerNode; layer: Layer }[] {
    const ctx = new MockAudioContext();
    return layers.map((l, i) => ({
      node: makeNodeStub(ctx, l, durations[i] ?? 0) as unknown as LayerNode,
      layer: l,
    }));
  }

  it('should ignore voice cues without a DuckIntent and non-voice layers carrying one', () => {
    const regions = mergeDuckSpans(
      pairs([
        voiceLayer({ id: 'v', t: 1 }), // voice, no duck → no span (§3f)
        toneLayer({ id: 't', t: 2, duck: duck(0.5) }), // tone w/ duck → ignored (§3h)
        ambianceLayer({ id: 'a', t: 3, duck: duck(0.5) }), // ambiance w/ duck → ignored
      ]),
    );
    expect(regions).toHaveLength(0);
  });

  it('should keep two disjoint cues as separate regions', () => {
    const regions = mergeDuckSpans(
      pairs([
        voiceLayer({ id: 'v1', t: 10, duck: duck(0.4, 0.1, 0.2) }), // releaseEnd 10.2
        voiceLayer({ id: 'v2', t: 50, duck: duck(0.3, 0.1, 0.2) }), // attackStart 49.9
      ]),
    );
    expect(regions).toHaveLength(2);
    expect(regions[0].toGain).toBeCloseTo(0.4);
    expect(regions[1].toGain).toBeCloseTo(0.3);
  });

  it('should coalesce two OVERLAPPING cues into one region with MIN toGain and max releaseEnd', () => {
    // v1: attackStart 0.9, releaseEnd 1.5 ; v2 at 1.4: attackStart 1.3 (<= 1.5 → overlap).
    const regions = mergeDuckSpans(
      pairs([
        voiceLayer({ id: 'v1', t: 1.0, duck: duck(0.5, 0.1, 0.5) }), // releaseEnd 1.5
        voiceLayer({ id: 'v2', t: 1.4, duck: duck(0.2, 0.1, 0.3) }), // attackStart 1.3
      ]),
    );
    expect(regions).toHaveLength(1);
    expect(regions[0].toGain).toBeCloseTo(0.2); // deepest wins
    expect(regions[0].releaseEnd).toBeCloseTo(1.7); // 1.4 + 0.3 (later cue's recovery)
    expect(regions[0].releaseSec).toBeCloseTo(0.3); // later cue owns release
  });

  it('should span the held dip across the cue body (releaseEnd = L.t + durationSec + releaseSec)', () => {
    // A 4 s voice cue at t=2 with a 0.1 s attack and 0.5 s release. The dip is held across
    // the WHOLE body [2, 6], not just at onset: floor reached at 2, release begins at 6.
    const regions = mergeDuckSpans(
      pairs([voiceLayer({ id: 'v', t: 2, duck: duck(0.3, 0.1, 0.5) })], [4]),
    );
    expect(regions).toHaveLength(1);
    expect(regions[0].attackStart).toBeCloseTo(1.9); // 2 - 0.1 (attack into floor)
    expect(regions[0].releaseEnd).toBeCloseTo(6.5); // 2 + 4 (body) + 0.5 (release)
    // The held-dip region (floor reached → release begins) spans the cue duration: the
    // mapped span is startCtx = attackStart + attackSec = 2, endCtx = releaseEnd - releaseSec
    // = 6, so endCtx - startCtx == durationSec (4).
    const startCtxSession = regions[0].attackStart + regions[0].attackSec;
    const endCtxSession = regions[0].releaseEnd - regions[0].releaseSec;
    expect(endCtxSession - startCtxSession).toBeCloseTo(4); // == node.durationSec
  });

  it('should NOT coalesce two cues whose bodies leave a gap (body span keeps them disjoint)', () => {
    // Both 1 s cues: v1 body [0,1] release→1.5 ; v2 at 3 body [3,4] attackStart 2.9 (> 1.5).
    const regions = mergeDuckSpans(
      pairs(
        [
          voiceLayer({ id: 'v1', t: 0, duck: duck(0.4, 0.1, 0.5) }),
          voiceLayer({ id: 'v2', t: 3, duck: duck(0.3, 0.1, 0.5) }),
        ],
        [1, 1],
      ),
    );
    expect(regions).toHaveLength(2);
  });

  it('should treat an EXACT abut as overlap (>=, §3b)', () => {
    // v1 releaseEnd = 1 + 0 = 1.0 ; v2 attackStart = 1.0 - 0 = 1.0 → equal → merge.
    const regions = mergeDuckSpans(
      pairs([
        voiceLayer({ id: 'v1', t: 1.0, duck: duck(0.5, 0, 0) }),
        voiceLayer({ id: 'v2', t: 1.0, duck: duck(0.3, 0, 0) }),
      ]),
    );
    expect(regions).toHaveLength(1);
    expect(regions[0].toGain).toBeCloseTo(0.3);
  });

  it('should transitively merge a 3-cue chain A∪B∪C into one region (§3d)', () => {
    // A at 1 (relEnd 1.6), B at 1.5 (relEnd 2.1), C at 2.0 (relEnd 2.6). A..C all chain.
    const regions = mergeDuckSpans(
      pairs([
        voiceLayer({ id: 'A', t: 1.0, duck: duck(0.6, 0.1, 0.6) }),
        voiceLayer({ id: 'B', t: 1.5, duck: duck(0.3, 0.1, 0.6) }),
        voiceLayer({ id: 'C', t: 2.0, duck: duck(0.5, 0.1, 0.6) }),
      ]),
    );
    expect(regions).toHaveLength(1);
    expect(regions[0].toGain).toBeCloseTo(0.3); // deepest across the chain
    expect(regions[0].releaseEnd).toBeCloseTo(2.6); // C's recovery
  });

  it('should keep the deeper floor for a fully nested cue (§3c)', () => {
    // outer at 0 with long release (relEnd 10) ; inner at 2 deeper, short (relEnd 2.6).
    const regions = mergeDuckSpans(
      pairs([
        voiceLayer({ id: 'outer', t: 0, duck: duck(0.6, 0.1, 10) }),
        voiceLayer({ id: 'inner', t: 2, duck: duck(0.2, 0.1, 0.5) }),
      ]),
    );
    expect(regions).toHaveLength(1);
    expect(regions[0].toGain).toBeCloseTo(0.2);
    expect(regions[0].releaseEnd).toBeCloseTo(10); // outer's later release bounds it
  });
});

describe('scheduleLayers — duck install (design §5, one call per scheduleLayers)', () => {
  const duck = (toGain: number) => ({ toGain, attackSec: 0.1, releaseSec: 0.2 });

  it('should call mixer.scheduleDuck exactly ONCE with all merged regions', () => {
    const layers = [
      voiceLayer({ id: 'v1', t: 10, duck: duck(0.4) }),
      voiceLayer({ id: 'v2', t: 50, duck: duck(0.3) }),
    ];
    const { mixer, nodes } = setup(layers);
    scheduleLayers(mixer, nodes, layers, { t0: 0, startOffsetSec: 0 });
    expect(mixer.duckCalls).toHaveLength(1);
    expect(mixer.duckCalls[0].spans).toHaveLength(2); // two disjoint regions
    expect(mixer.duckCalls[0].t0).toBe(0);
    expect(mixer.duckCalls[0].startOffsetSec).toBe(0);
  });

  it('should emit a DuckSpan the mixer maps back to attackStart=L.t-attack, releaseEnd=L.t+release (zero-body cue)', () => {
    const layers = [voiceLayer({ id: 'v', t: 30, duck: duck(0.25) })];
    const { mixer, nodes } = setup(layers); // durationSec 0 (point dip)
    scheduleLayers(mixer, nodes, layers, { t0: 0, startOffsetSec: 0 });
    const span = mixer.duckCalls[0].spans[0];
    // startCtx = attackStart + attackSec = (30 - 0.1) + 0.1 = 30 ; endCtx = releaseEnd - releaseSec.
    expect(span.startCtx).toBeCloseTo(30);
    expect(span.endCtx).toBeCloseTo(30);
    expect(span.toGain).toBeCloseTo(0.25);
    expect(span.attackSec).toBeCloseTo(0.1);
    expect(span.releaseSec).toBeCloseTo(0.2);
  });

  it('should span the duck region across the cue duration (endCtx - startCtx == node.durationSec)', () => {
    const layers = [voiceLayer({ id: 'v', t: 30, duck: duck(0.25) })];
    const { mixer, nodes } = setup(layers, [5]); // 5 s cue body
    scheduleLayers(mixer, nodes, layers, { t0: 0, startOffsetSec: 0 });
    const span = mixer.duckCalls[0].spans[0];
    // The held-dip region is [L.t, L.t + durationSec] in session seconds: floor reached at
    // 30 (attack ramps INTO it), release begins at 35 (ramps OUT after the cue body).
    expect(span.startCtx).toBeCloseTo(30); // floor reached = L.t
    expect(span.endCtx).toBeCloseTo(35); // release begins = L.t + durationSec
    expect(span.endCtx - span.startCtx).toBeCloseTo(5); // == node.durationSec
    expect(span.toGain).toBeCloseTo(0.25);
    expect(span.attackSec).toBeCloseTo(0.1);
    expect(span.releaseSec).toBeCloseTo(0.2);
  });

  it('should NOT call scheduleDuck when there are no cues', () => {
    const layers = [ambianceLayer({ id: 'a', t: 0 })];
    const { mixer, nodes } = setup(layers);
    scheduleLayers(mixer, nodes, layers, { t0: 0, startOffsetSec: 0 });
    expect(mixer.duckCalls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 5. Malformed caller inputs (defensive, edge §7)
// ---------------------------------------------------------------------------

describe('scheduleLayers — defensive pairing (edge §7)', () => {
  it('should pair by id and skip an unmatched node on a length mismatch (§7a/§7b)', () => {
    const l1 = ambianceLayer({ id: 'a', t: 1 });
    const l2 = ambianceLayer({ id: 'b', t: 2 });
    const { ctx, mixer } = setup([l1, l2]);
    // Three nodes, two layers; node 'c' has no matching layer.
    const nodes = [
      makeNodeStub(ctx, l1),
      makeNodeStub(ctx, l2),
      makeNodeStub(ctx, ambianceLayer({ id: 'c', t: 3 })),
    ];
    expect(() =>
      scheduleLayers(mixer, nodes, [l1, l2], { t0: 0, startOffsetSec: 0 }),
    ).not.toThrow();
    expect(nodes[0].startCalls).toHaveLength(1); // a matched
    expect(nodes[1].startCalls).toHaveLength(1); // b matched
    expect(nodes[2].startCalls).toHaveLength(0); // c inert (no matching layer)
  });

  it('should return a no-op handle for empty layers (§7c)', () => {
    const { mixer } = setup([]);
    const handle = scheduleLayers(mixer, [], [], { t0: 0, startOffsetSec: 0 });
    expect(mixer.duckCalls).toHaveLength(0);
    expect(() => {
      handle.retarget([]);
      handle.cancel();
      handle.dispose();
    }).not.toThrow();
  });

  it('should propagate a non-finite t0 as scheduleLane has no chance to swallow it', () => {
    // scheduleLane is called with a non-finite startTime; the time arithmetic produces
    // NaN ctx times which the param doubles record — the module does not catch/re-wrap.
    const layer = ambianceLayer({ id: 'a', t: 0, gain: [pt(0, 0), pt(1, 1)] });
    const { mixer, nodes } = setup([layer]);
    scheduleLayers(mixer, nodes, [layer], { t0: NaN, startOffsetSec: 0 });
    // The anchor write happened with a NaN time (not re-wrapped into a new error type).
    expect(nodes[0].gainEvents.events[0].time).toBeNaN();
  });
});

// ---------------------------------------------------------------------------
// 6. Lifecycle: retarget / cancel / dispose (design §6/§7, edge §6)
// ---------------------------------------------------------------------------

describe('LayerSchedule.retarget — live edit (design §6)', () => {
  const duck = (toGain: number) => ({ toGain, attackSec: 0.1, releaseSec: 0.2 });

  it('should re-ramp lanes and re-install the merged duck WITHOUT starting/stopping sources', () => {
    const layer = voiceLayer({ id: 'v', t: 5, gain: [pt(0, 0), pt(2, 1)], duck: duck(0.4) });
    const { ctx, mixer, nodes } = setup([layer]);
    ctx.currentTime = 1;
    const handle = scheduleLayers(mixer, nodes, [layer], { t0: 0, startOffsetSec: 0 });
    const startsBefore = nodes[0].startCalls.length;
    const stopsBefore = nodes[0].stopCalls.length;

    // Edit: deeper duck.
    const edited = voiceLayer({ id: 'v', t: 5, gain: [pt(0, 0), pt(2, 1)], duck: duck(0.1) });
    handle.retarget([edited]);

    // A second scheduleDuck call (the re-merge), no extra start/stop.
    expect(mixer.duckCalls).toHaveLength(2);
    expect(mixer.duckCalls[1].spans[0].toGain).toBeCloseTo(0.1);
    expect(nodes[0].startCalls.length).toBe(startsBefore);
    expect(nodes[0].stopCalls.length).toBe(stopsBefore);
    // The gain lane was cancel-and-held before the re-ramp so old ramps do not stack.
    expect(nodes[0].gainEvents.methodLog).toContain('cancelAndHoldAtTime');
  });

  it('should cancel the duck when a retarget removes every cue (§6e tolerant)', () => {
    const layer = voiceLayer({ id: 'v', t: 5, duck: duck(0.4) });
    const { ctx, mixer, nodes } = setup([layer]);
    ctx.currentTime = 1;
    const handle = scheduleLayers(mixer, nodes, [layer], { t0: 0, startOffsetSec: 0 });
    // Edit removes the duck.
    handle.retarget([voiceLayer({ id: 'v', t: 5 })]);
    expect(mixer.cancelDuckCalls).toHaveLength(1);
  });
});

describe('LayerSchedule.cancel — teardown of scheduling only (design §6)', () => {
  it('should cancel lane params at now and cancelDuck, without stopping sources', () => {
    const layer = voiceLayer({
      id: 'v',
      t: 0,
      gain: [pt(0, 0), pt(2, 1)],
      duck: { toGain: 0.4, attackSec: 0.1, releaseSec: 0.2 },
    });
    const { ctx, mixer, nodes } = setup([layer]);
    ctx.currentTime = 4;
    const handle = scheduleLayers(mixer, nodes, [layer], { t0: 0, startOffsetSec: 0 });
    handle.cancel();

    // The duck was cancelled at now=4.
    expect(mixer.cancelDuckCalls).toEqual([4]);
    // The gain param's future events were cancelled (cancelAndHoldAtTime on the supporting mock).
    expect(nodes[0].gainEvents.methodLog).toContain('cancelAndHoldAtTime');
    // Sources are NOT stopped (one-shots cannot restart; caller disposes the nodes).
    expect(nodes[0].stopCalls).toHaveLength(0);
  });

  it('should tolerate cancel when no duck was installed (§6e)', () => {
    const layer = ambianceLayer({ id: 'a', t: 0 });
    const { ctx, mixer, nodes } = setup([layer]);
    ctx.currentTime = 2;
    const handle = scheduleLayers(mixer, nodes, [layer], { t0: 0, startOffsetSec: 0 });
    expect(() => handle.cancel()).not.toThrow();
    expect(mixer.cancelDuckCalls).toEqual([2]); // still called (tolerated no-op in mixer)
  });

  it('should fall back to cancelScheduledValues on a Firefox-style param (no cancelAndHold)', () => {
    const layer = voiceLayer({ id: 'v', t: 0, gain: [pt(0, 0), pt(2, 1)] });
    const ctx = new MockAudioContext({ supportsCancelAndHold: false });
    const mixer = makeMixerStub(ctx);
    const node = makeNodeStub(ctx, layer);
    ctx.currentTime = 3;
    const handle = scheduleLayers(mixer, [node], [layer], { t0: 0, startOffsetSec: 0 });
    handle.cancel();
    expect(node.gainEvents.methodLog).toContain('cancelScheduledValues');
    expect(node.gainEvents.methodLog).not.toContain('cancelAndHoldAtTime');
  });
});

describe('LayerSchedule.dispose — idempotent, makes retarget/cancel no-ops (edge §6d)', () => {
  it('should make retarget and cancel no-ops after dispose and be safe to double-dispose', () => {
    const layer = voiceLayer({
      id: 'v',
      t: 0,
      duck: { toGain: 0.4, attackSec: 0.1, releaseSec: 0.2 },
    });
    const { ctx, mixer, nodes } = setup([layer]);
    ctx.currentTime = 1;
    const handle = scheduleLayers(mixer, nodes, [layer], { t0: 0, startOffsetSec: 0 });
    const duckCallsBefore = mixer.duckCalls.length;
    const cancelCallsBefore = mixer.cancelDuckCalls.length;

    handle.dispose();
    handle.dispose(); // double dispose is safe
    handle.retarget([layer]); // no-op
    handle.cancel(); // no-op

    expect(mixer.duckCalls.length).toBe(duckCallsBefore); // no new schedule
    expect(mixer.cancelDuckCalls.length).toBe(cancelCallsBefore); // no new cancel
  });
});
