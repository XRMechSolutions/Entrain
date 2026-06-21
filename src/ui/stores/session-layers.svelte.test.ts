// Phase-2 SessionStore layer-authoring tests (design §17, interfaces §14, edge L1–L10).
// Kept in a dedicated file so the Phase-1 session.svelte.test.ts stays focused. Asserts
// observable preset state + that an audible edit reschedules via transport.reapply().

import { describe, expect, it, vi } from 'vitest';
import { validate, type Preset } from '../../engine/session-model';
import type { Transport, TransportState } from '../../engine/transport';
import { DEFAULT_TONE_SPEC } from '../lib/constants';
import { createNoticeStore } from './notices.svelte';
import { createPlaybackStore, createSessionStore } from './session.svelte';

type Handler = (payload: unknown) => void;

function makeFakeTransport() {
  const handlers: Record<string, Handler[]> = {};
  const fake = {
    state: 'idle' as TransportState,
    durationSec: 300,
    load: vi.fn(),
    prime: vi.fn().mockResolvedValue(undefined),
    play: vi.fn().mockResolvedValue(undefined),
    pause: vi.fn().mockResolvedValue(undefined),
    seek: vi.fn().mockResolvedValue(undefined),
    reapply: vi.fn(),
    stop: vi.fn().mockResolvedValue(undefined),
    position: vi.fn().mockReturnValue(0),
    duration: vi.fn(() => fake.durationSec),
    setMasterTrim: vi.fn(),
    setKeepScreenOn: vi.fn().mockResolvedValue(undefined),
    isKeepScreenOn: vi.fn().mockReturnValue(false),
    on: (ev: string, h: Handler) => {
      (handlers[ev] ??= []).push(h);
    },
    off: () => {},
    destroy: vi.fn().mockResolvedValue(undefined),
    emit(ev: string, payload?: unknown) {
      (handlers[ev] ?? []).forEach((h) => h(payload));
    },
  };
  return fake;
}

function setup(opts?: { state?: TransportState }) {
  const transport = makeFakeTransport();
  const notices = createNoticeStore();
  const playback = createPlaybackStore({ transport: transport as unknown as Transport, notices });
  if (opts?.state && opts.state !== 'idle') transport.emit('statechange', { state: opts.state });
  const session = createSessionStore({ transport: transport as unknown as Transport, playback });
  return { transport, notices, playback, session };
}

describe('SessionStore — Phase-2 layer authoring (§14)', () => {
  it('addLayer("tone") appends DEFAULT_TONE_SPEC + bumps revision/dirty/applyLiveEdit', () => {
    const { session, transport } = setup({ state: 'playing' });
    const rev0 = session.revision;
    const id = session.addLayer('tone');
    const layer = session.preset.layers!.find((l) => l.id === id)!;
    expect(layer.kind).toBe('tone');
    expect(layer.source).toEqual({ synth: DEFAULT_TONE_SPEC });
    expect(layer.t).toBe(0);
    expect(layer.loop).toBe(false);
    expect(session.revision).toBeGreaterThan(rev0);
    expect(session.dirty).toBe(true);
    expect(transport.reapply).toHaveBeenCalled(); // audible edit reschedules (L9)
  });

  it('addLayer ids are collision-free across many adds (L1)', () => {
    const { session } = setup();
    const ids = new Set<string>();
    for (let i = 0; i < 10; i++) ids.add(session.addLayer('tone'));
    expect(ids.size).toBe(10);
  });

  it('addLayer("ambiance") makes a looping, unbound clip source (L3/L7)', () => {
    const { session } = setup();
    const id = session.addLayer('ambiance');
    const layer = session.preset.layers!.find((l) => l.id === id)!;
    expect(layer.loop).toBe(true);
    expect(layer.source).toEqual({ clipId: '' }); // unbound until a clip is picked
  });

  it('setLayerToneSpec clamps freqHz to RANGES.toneFreq and attack/release to ≥0 (L2)', () => {
    const { session } = setup();
    const id = session.addLayer('tone');
    session.setLayerToneSpec(id, { freqHz: 999999, attackSec: -1, releaseSec: -2 });
    const layer = session.preset.layers!.find((l) => l.id === id)!;
    const synth = (layer.source as { synth: { freqHz: number; attackSec: number; releaseSec: number } }).synth;
    expect(synth.freqHz).toBe(20000);
    expect(synth.attackSec).toBe(0);
    expect(synth.releaseSec).toBe(0);

    session.setLayerToneSpec(id, { freqHz: 1 });
    expect((layer.source as { synth: { freqHz: number } }).synth.freqHz).toBe(20);
  });

  it('setLayerKind keeps kind/source valid (tone⇒synth, ambiance⇒clip) so validate stays ok (L3)', () => {
    const { session } = setup();
    const id = session.addLayer('tone');
    session.setLayerKind(id, 'ambiance');
    let layer = session.preset.layers!.find((l) => l.id === id)!;
    expect('clipId' in layer.source).toBe(true);
    expect(layer.loop).toBe(true);

    session.setLayerKind(id, 'tone');
    layer = session.preset.layers!.find((l) => l.id === id)!;
    expect('synth' in layer.source).toBe(true);
    expect(layer.loop).toBe(false);
  });

  it('ambiance setLayerLoop(false) is refused (a bed must loop, L3)', () => {
    const { session } = setup();
    const id = session.addLayer('ambiance');
    session.setLayerLoop(id, false);
    expect(session.preset.layers!.find((l) => l.id === id)!.loop).toBe(true);
  });

  it('setLayerStart clamps to [0, durationSec] (L4)', () => {
    const { session } = setup();
    const id = session.addLayer('tone');
    session.setLayerStart(id, 9999);
    expect(session.preset.layers!.find((l) => l.id === id)!.t).toBe(session.preset.durationSec);
    session.setLayerStart(id, -5);
    expect(session.preset.layers!.find((l) => l.id === id)!.t).toBe(0);
  });

  it('gain lane clamps to {0,1}, spatial lane to {−1,1}, lanes stay sorted + dedup-t (L5/L6)', () => {
    const { session } = setup();
    const id = session.addLayer('tone');
    session.addLayerLanePoint(id, 'gain', 2);
    session.addLayerLanePoint(id, 'gain', 1);
    session.addLayerLanePoint(id, 'gain', 1); // duplicate t → nudged
    const gain = session.preset.layers!.find((l) => l.id === id)!.gain!;
    const ts = gain.map((p) => p.t);
    expect([...ts]).toEqual([...ts].sort((a, b) => a - b)); // sorted ascending
    expect(new Set(ts).size).toBe(ts.length); // no duplicate t

    session.setLayerLaneValue(id, 'gain', 0, 5); // out of range
    expect(session.preset.layers!.find((l) => l.id === id)!.gain![0].value).toBe(1);

    session.addLayerLanePoint(id, 'spatial', 0);
    session.setLayerLaneValue(id, 'spatial', 0, -9);
    expect(session.preset.layers!.find((l) => l.id === id)!.spatial![0].value).toBe(-1);
  });

  it('an out-of-range / NaN lane value never authors a non-finite value', () => {
    const { session } = setup();
    const id = session.addLayer('tone');
    session.addLayerLanePoint(id, 'gain', 0);
    session.setLayerLaneValue(id, 'gain', 0, Number.NaN);
    expect(Number.isFinite(session.preset.layers!.find((l) => l.id === id)!.gain![0].value)).toBe(true);
  });

  it('removeLayer leaves the (shared) clip alone — only the layer is spliced (L10)', () => {
    const { session } = setup();
    const id = session.addLayer('ambiance');
    session.setLayerSource(id, { clipId: 'clip_abc' });
    expect(session.preset.layers!.length).toBe(1);
    session.removeLayer(id);
    expect(session.preset.layers!.find((l) => l.id === id)).toBeUndefined();
    // removeLayer never calls into clip-library (it only mutates preset.layers).
  });

  it('a fully authored tone layer passes session-model.validate (cannot author INVALID_PRESET)', () => {
    const { session } = setup();
    const id = session.addLayer('tone');
    session.setLayerToneSpec(id, { freqHz: 440 });
    session.addLayerLanePoint(id, 'gain', 1);
    const result = validate(session.preset);
    expect(result.ok).toBe(true);
  });

  it('injectLayers appends compiled layers without re-timing them, dirty + reapply (O6)', () => {
    const { session, transport } = setup({ state: 'playing' });
    const incoming = [
      { id: 'voice_1', kind: 'voice' as const, source: { clipId: 'c1' }, t: 12 },
      { id: 'voice_2', kind: 'voice' as const, source: { clipId: 'c2' }, t: 30 },
    ];
    session.injectLayers(incoming);
    const layers = session.preset.layers!;
    expect(layers.map((l) => l.id)).toEqual(['voice_1', 'voice_2']);
    expect(layers.map((l) => l.t)).toEqual([12, 30]); // absolute t preserved
    expect(session.dirty).toBe(true);
    expect(transport.reapply).toHaveBeenCalled();
  });

  it('the preset stays a PLAIN object after layer edits (structuredClone-safe, purity)', () => {
    const { session } = setup();
    session.addLayer('tone');
    session.addLayerLanePoint(session.preset.layers![0].id, 'gain', 1);
    const cloned: Preset = structuredClone(session.preset);
    expect(cloned.layers!.length).toBe(1);
  });

  it('an idle/stopped layer edit does NOT reschedule (B6)', () => {
    const { session, transport } = setup({ state: 'idle' });
    session.addLayer('tone');
    expect(transport.reapply).not.toHaveBeenCalled();
  });
});
