import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { seedDefaultPresets } from '../../engine/persistence';
import type { Transport, TransportOptions } from '../../engine/transport';
import { bootstrap, resetBootstrapForTests, type BootstrapOverrides } from './bootstrap';

// persistence.seedDefaultPresets is the real localStorage-backed seeder; stub it so the
// "seeded once" assertion is deterministic and storage-independent.
vi.mock('../../engine/persistence', async (importActual) => {
  const actual = await importActual<typeof import('../../engine/persistence')>();
  return { ...actual, seedDefaultPresets: vi.fn(() => []), listPresets: vi.fn(() => []) };
});

function makeFakeTransport(durationSec = 300) {
  const handlers: Record<string, ((p: unknown) => void)[]> = {};
  return {
    state: 'idle' as const,
    load: vi.fn(),
    prime: vi.fn().mockResolvedValue(undefined),
    play: vi.fn().mockResolvedValue(undefined),
    pause: vi.fn().mockResolvedValue(undefined),
    seek: vi.fn().mockResolvedValue(undefined),
    reapply: vi.fn(),
    stop: vi.fn().mockResolvedValue(undefined),
    position: vi.fn(() => 0),
    duration: vi.fn(() => durationSec),
    setMasterTrim: vi.fn(),
    setKeepScreenOn: vi.fn().mockResolvedValue(undefined),
    isKeepScreenOn: vi.fn(() => false),
    on: (ev: string, h: (p: unknown) => void) => {
      (handlers[ev] ??= []).push(h);
    },
    off: vi.fn(),
    destroy: vi.fn().mockResolvedValue(undefined),
  };
}

function makeOverrides(extra?: Partial<BootstrapOverrides>) {
  const transport = makeFakeTransport();
  const createTransport = vi.fn((_opts: TransportOptions) => transport as unknown as Transport);
  // mountApp runs onReady synchronously (simulating App's onMount) so prime() is exercised.
  const mountApp = vi.fn((_t, _ctx, onReady: () => void) => onReady());
  const registerSW = vi.fn((_options?: unknown) => vi.fn(() => Promise.resolve()));
  const overrides: BootstrapOverrides = {
    createTransport: createTransport as unknown as typeof import('../../engine/transport').createTransport,
    mountApp,
    registerSW,
    ...extra,
  };
  return { transport, createTransport, mountApp, registerSW, overrides };
}

/** Stub the global matchMedia so the device-aware background-audio choice is testable.
 *  Returns a restore fn. coarse=true simulates a touch device; false a desktop. */
function stubMatchMedia(coarse: boolean): () => void {
  const g = globalThis as { matchMedia?: unknown };
  const orig = g.matchMedia;
  g.matchMedia = (q: string) => ({ matches: q.includes('coarse') ? coarse : false, media: q });
  return () => {
    g.matchMedia = orig;
  };
}

beforeEach(() => {
  resetBootstrapForTests();
  vi.clearAllMocks();
});
afterEach(() => resetBootstrapForTests());

describe('bootstrap — composition root', () => {
  it('returns the wired AppContext with all ten singletons (incl. Phase-2 stores)', () => {
    const { overrides } = makeOverrides();
    const ctx = bootstrap(document.createElement('div'), overrides);
    for (const key of [
      'transport',
      'session',
      'playback',
      'library',
      'notices',
      'install',
      'ui',
      'clips',
      'render',
      'voiceScript',
    ] as const) {
      expect(ctx[key]).toBeDefined();
    }
  });

  it('builds transport with the INJECTED scheduler + pwa artwork + silentFileUrl', () => {
    const { createTransport, overrides } = makeOverrides();
    bootstrap(document.createElement('div'), overrides);
    expect(createTransport).toHaveBeenCalledTimes(1);
    const opts = createTransport.mock.calls[0][0] as TransportOptions;
    expect(opts.scheduler).toBeDefined();
    expect(typeof opts.scheduler.apply).toBe('function');
    expect(Array.isArray(opts.artwork)).toBe(true);
    expect(opts.artwork && opts.artwork.length).toBeGreaterThan(0); // APP_ICONS injected
    expect(typeof opts.silentFileUrl).toBe('string'); // SILENT_LOOP_URL injected
  });

  it('injects the layerScheduler factory into transport (same IoC shape as scheduler, arch §2.2)', () => {
    const { createTransport, overrides } = makeOverrides();
    bootstrap(document.createElement('div'), overrides);
    const opts = createTransport.mock.calls[0][0] as TransportOptions;
    // The factory matches the LayerSchedulerFactory shape (a function transport calls).
    expect(typeof opts.layerScheduler).toBe('function');
  });

  it('constructs the three Phase-2 stores with their declared shapes (clips/render/voiceScript)', () => {
    const { overrides } = makeOverrides();
    const ctx = bootstrap(document.createElement('div'), overrides);
    expect(typeof ctx.clips.refresh).toBe('function');
    expect(typeof ctx.clips.importFile).toBe('function');
    expect(typeof ctx.render.render).toBe('function');
    expect(typeof ctx.render.download).toBe('function');
    expect(typeof ctx.voiceScript.importAndCompile).toBe('function');
  });

  it('engages the mediastream background bridge on coarse-pointer (touch) devices', () => {
    const restore = stubMatchMedia(true);
    try {
      const { createTransport, overrides } = makeOverrides();
      bootstrap(document.createElement('div'), overrides);
      const opts = createTransport.mock.calls[0][0] as TransportOptions;
      expect(opts.backgroundAudioMode).toBe('mediastream');
    } finally {
      restore();
    }
  });

  it('uses direct output (no bridge) on fine-pointer / desktop', () => {
    const restore = stubMatchMedia(false);
    try {
      const { createTransport, overrides } = makeOverrides();
      bootstrap(document.createElement('div'), overrides);
      const opts = createTransport.mock.calls[0][0] as TransportOptions;
      expect(opts.backgroundAudioMode).toBe('none');
    } finally {
      restore();
    }
  });

  it('seeds the library exactly once and sets a working preset so duration() > 0', () => {
    const { transport, overrides } = makeOverrides();
    const ctx = bootstrap(document.createElement('div'), overrides);
    expect(seedDefaultPresets).toHaveBeenCalledTimes(1);
    expect(transport.load).toHaveBeenCalledTimes(1); // session.reset(createDefaultPreset())
    expect(ctx.session.preset.durationSec).toBeGreaterThan(0);
    expect(transport.duration()).toBeGreaterThan(0);
  });

  it('registers the SW in prompt mode (immediate + onNeedRefresh/onOfflineReady)', () => {
    const { registerSW, overrides } = makeOverrides();
    bootstrap(document.createElement('div'), overrides);
    expect(registerSW).toHaveBeenCalledTimes(1);
    const opts = registerSW.mock.calls[0][0] as { immediate?: boolean; onNeedRefresh?: unknown; onOfflineReady?: unknown };
    expect(opts.immediate).toBe(true);
    expect(typeof opts.onNeedRefresh).toBe('function');
    expect(typeof opts.onOfflineReady).toBe('function');
  });

  it('primes the audio context off-gesture on App mount (no play() outside a gesture, A5)', () => {
    const { transport, overrides } = makeOverrides();
    bootstrap(document.createElement('div'), overrides);
    expect(transport.prime).toHaveBeenCalledTimes(1);
    expect(transport.play).not.toHaveBeenCalled(); // never auto-starts audio
  });

  it('swallows a prime() rejection (surfaced via the transport warning path, edge A3)', async () => {
    const { transport, overrides } = makeOverrides();
    transport.prime.mockRejectedValueOnce(new Error('worklet failed'));
    expect(() => bootstrap(document.createElement('div'), overrides)).not.toThrow();
    await Promise.resolve(); // let the rejected prime() settle
    expect(transport.prime).toHaveBeenCalledTimes(1);
  });

  it('is idempotent: a double bootstrap()/HMR builds exactly one transport (edge I5)', () => {
    const { createTransport, overrides } = makeOverrides();
    const a = bootstrap(document.createElement('div'), overrides);
    const b = bootstrap(document.createElement('div'), overrides);
    expect(a).toBe(b);
    expect(createTransport).toHaveBeenCalledTimes(1);
  });
});
