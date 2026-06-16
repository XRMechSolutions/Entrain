import { describe, expect, it, vi } from 'vitest';
import { createDefaultPreset, type Preset } from '../../engine/session-model';
import type { Transport, TransportNotice, TransportState } from '../../engine/transport';
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
    duration: vi.fn(function (this: { durationSec: number }) {
      return fake.durationSec;
    }),
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

type FakeTransport = ReturnType<typeof makeFakeTransport>;

function setup(opts?: { state?: TransportState }) {
  const transport = makeFakeTransport();
  const notices = createNoticeStore();
  const playback = createPlaybackStore({ transport: transport as unknown as Transport, notices });
  if (opts?.state && opts.state !== 'idle') transport.emit('statechange', { state: opts.state });
  const session = createSessionStore({ transport: transport as unknown as Transport, playback });
  return { transport, notices, playback, session };
}

describe('PlaybackStore', () => {
  it('mirrors statechange / tick / duration from transport', () => {
    const { transport, playback } = setup();
    expect(playback.state).toBe('idle');
    transport.emit('statechange', { state: 'playing' });
    expect(playback.state).toBe('playing');
    transport.emit('tick', { positionSec: 42, durationSec: 300, state: 'playing' });
    expect(playback.positionSec).toBe(42);
    expect(playback.durationSec).toBe(300);
  });

  it('play() calls transport.play first with no await before it (gesture-safe)', () => {
    const { transport, playback } = setup();
    playback.play();
    expect(transport.play).toHaveBeenCalledTimes(1);
  });

  it('seek ignores non-finite values (never throws INVALID_SEEK)', () => {
    const { transport, playback } = setup();
    playback.seek(Number.NaN);
    expect(transport.seek).not.toHaveBeenCalled();
    playback.seek(10);
    expect(transport.seek).toHaveBeenCalledWith(10);
  });

  it('WEB_AUDIO_UNSUPPORTED sets canPlay=false and surfaces a persistent error notice', () => {
    const { transport, playback, notices } = setup();
    expect(playback.canPlay).toBe(true);
    const notice: TransportNotice = { code: 'WEB_AUDIO_UNSUPPORTED', message: 'no audiocontext' };
    transport.emit('error', notice);
    expect(playback.canPlay).toBe(false);
    expect(notices.items.at(-1)).toMatchObject({ severity: 'error' });
  });

  it('CONTEXT_INTERRUPTED produces a persistent banner whose Resume action re-runs play()', () => {
    const { transport, playback, notices } = setup();
    transport.emit('warning', { code: 'CONTEXT_INTERRUPTED', message: 'interrupted' });
    const banner = notices.items.at(-1)!;
    expect(banner).toMatchObject({ severity: 'warning', dedupeKey: 'ctx' });
    expect(banner.autoDismissMs).toBeUndefined();
    banner.action?.run();
    expect(transport.play).toHaveBeenCalledTimes(1);
    void playback; // play() routed through the store mirror
  });

  it('catches a transport throw at the store boundary → notice, no crash', () => {
    const { transport, playback, notices } = setup();
    (transport.play as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw new Error('boom');
    });
    expect(() => playback.play()).not.toThrow();
    expect(notices.items.at(-1)).toMatchObject({ severity: 'error' });
  });
});

describe('SessionStore — Phase-1 edits', () => {
  function reapplyCount(t: FakeTransport): number {
    return (t.reapply as ReturnType<typeof vi.fn>).mock.calls.length;
  }

  it('setNodeParam clamps to RANGES, bumps revision, sets dirty, and reschedules while playing', () => {
    const { transport, session } = setup({ state: 'playing' });
    const rev0 = session.revision;
    session.setNodeParam('carrier', 5000); // above max 1000
    expect(session.preset.nodes[0].carrier?.value).toBe(1000);
    expect(session.revision).toBe(rev0 + 1);
    expect(session.dirty).toBe(true);
    expect(reapplyCount(transport)).toBe(1);
    expect(transport.seek).not.toHaveBeenCalled(); // reapply, NOT seek
  });

  it('never writes a non-finite typed value (reverts to the last valid value)', () => {
    const { transport, session } = setup({ state: 'playing' });
    const before = session.preset.nodes[0].carrier?.value;
    session.setNodeParam('carrier', Number.NaN);
    expect(session.preset.nodes[0].carrier?.value).toBe(before);
    expect(reapplyCount(transport)).toBe(0); // no commit on a rejected value
  });

  it('setMasterGain writes preset.masterGain AND calls setMasterTrim with NO reschedule', () => {
    const { transport, session } = setup({ state: 'playing' });
    session.setMasterGain(0.5);
    expect(session.preset.masterGain).toBe(0.5);
    expect(transport.setMasterTrim).toHaveBeenCalledWith(0.5);
    expect(reapplyCount(transport)).toBe(0); // the cheap live path never reschedules
    expect(session.dirty).toBe(true);
    session.setMasterGain(5); // clamps 0..1
    expect(session.preset.masterGain).toBe(1);
  });

  it('setDuration sets preset.durationSec, clamps to (0, LIMITS], dirties + bumps, NO reschedule', () => {
    const { transport, session } = setup({ state: 'playing' });
    const rev0 = session.revision;
    session.setDuration(600);
    expect(session.preset.durationSec).toBe(600);
    expect(session.dirty).toBe(true);
    expect(session.revision).toBe(rev0 + 1);
    expect(reapplyCount(transport)).toBe(0); // duration applies on the next play, not live
    expect(transport.seek).not.toHaveBeenCalled();

    session.setDuration(0); // below the lower bound → clamps up to 1s
    expect(session.preset.durationSec).toBe(1);
    session.setDuration(10_000_000); // above LIMITS.durationMaxSec (86400) → clamps down
    expect(session.preset.durationSec).toBe(86400);
  });

  it('setDuration ignores a non-finite value (never authors NaN/Infinity)', () => {
    const { session } = setup();
    const before = session.preset.durationSec;
    session.setDuration(Number.NaN);
    expect(session.preset.durationSec).toBe(before);
    session.setDuration(Number.POSITIVE_INFINITY);
    expect(session.preset.durationSec).toBe(before);
  });

  it('setWaveform mutates nodes[0].waveform and reschedules', () => {
    const { transport, session } = setup({ state: 'playing' });
    session.setWaveform('square');
    expect(session.preset.nodes[0].waveform).toBe('square');
    expect(reapplyCount(transport)).toBe(1);
  });

  it('setName marks dirty + bumps revision but never reschedules (not audible)', () => {
    const { transport, session } = setup({ state: 'playing' });
    const rev0 = session.revision;
    session.setName('Evening Calm');
    expect(session.preset.name).toBe('Evening Calm');
    expect(session.dirty).toBe(true);
    expect(session.revision).toBe(rev0 + 1);
    expect(reapplyCount(transport)).toBe(0);
  });

  it('applyLiveEdit reapplies (not seeks) only while playing / paused / interrupted', () => {
    for (const state of ['playing', 'paused', 'interrupted'] as const) {
      const { transport, session } = setup({ state });
      session.setNodeParam('beat', 6);
      expect(reapplyCount(transport)).toBe(1);
      expect(transport.seek).not.toHaveBeenCalled();
    }
    for (const state of ['idle', 'stopped'] as const) {
      const { transport, session } = setup({ state });
      session.setNodeParam('beat', 6);
      expect(reapplyCount(transport)).toBe(0); // no-op when not active
    }
  });

  it('an edit committed while paused still re-derives (takes effect on resume)', () => {
    const { transport, session } = setup({ state: 'paused' });
    session.setNodeParam('volume', 0.5);
    expect(reapplyCount(transport)).toBe(1);
  });

  it('reset adopts the next preset BY REFERENCE, clears dirty, sets selectedId, reloads transport', () => {
    const { transport, session } = setup();
    const next = createDefaultPreset();
    next.name = 'Loaded';
    session.setNodeParam('carrier', 333); // make it dirty first
    session.reset(next, 'lib-42');
    expect(session.preset).toBe(next); // SAME object reference (stable identity for transport)
    expect(session.dirty).toBe(false);
    expect(session.selectedId).toBe('lib-42');
    expect(transport.load).toHaveBeenLastCalledWith(next);
  });

  it('the working preset stays a PLAIN object — structuredClone-safe, stable identity', () => {
    const { session } = setup();
    const original: Preset = session.preset;
    session.setNodeParam('carrier', 250); // mutate in place
    expect(session.preset).toBe(original); // identity unchanged after an edit
    const clone = structuredClone(session.preset); // never a $state proxy → clones cleanly
    expect(clone).toEqual(session.preset);
    expect(clone).not.toBe(session.preset);
  });

  it('markSaved / markUnsaved / clearSelection manage selectedId + dirty without reloading transport', () => {
    const { transport, session } = setup();
    transport.load.mockClear();
    session.markSaved('saved-1');
    expect(session.selectedId).toBe('saved-1');
    expect(session.dirty).toBe(false);
    session.markUnsaved();
    expect(session.dirty).toBe(true);
    session.clearSelection();
    expect(session.selectedId).toBeNull();
    expect(transport.load).not.toHaveBeenCalled(); // none of these reload the engine
  });
});

describe('SessionStore — Phase-2 node ops', () => {
  it('addNode inserts a carry-forward node and keeps nodes sorted', () => {
    const transport = makeFakeTransport();
    const notices = createNoticeStore();
    const playback = createPlaybackStore({ transport: transport as unknown as Transport, notices });
    const session = createSessionStore({ transport: transport as unknown as Transport, playback });

    const key = session.addNode(120, 'carrier');
    expect(session.preset.nodes).toHaveLength(2);
    const idx = Number(key);
    expect(session.preset.nodes[idx].t).toBe(120);
    // carry-forward: equals the base value at t=120 (node 0's carrier, no change in sound)
    expect(session.preset.nodes[idx].carrier?.value).toBe(session.preset.nodes[0].carrier?.value);
  });

  it('moveNode pins nodes[0] at t=0 and removeNode refuses to remove it', () => {
    const transport = makeFakeTransport();
    const notices = createNoticeStore();
    const playback = createPlaybackStore({ transport: transport as unknown as Transport, notices });
    const session = createSessionStore({ transport: transport as unknown as Transport, playback });

    session.addNode(100, 'beat');
    session.moveNode(0, 50); // ignored — start node pinned
    expect(session.preset.nodes[0].t).toBe(0);

    const len = session.preset.nodes.length;
    session.removeNode(0); // refused
    expect(session.preset.nodes).toHaveLength(len);
    session.removeNode(1); // allowed
    expect(session.preset.nodes).toHaveLength(len - 1);
  });
});
