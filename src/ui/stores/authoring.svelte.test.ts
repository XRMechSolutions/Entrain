// Phase-2 RenderStore + VoiceScriptStore tests (design §19/§20, interfaces §15, edge
// N1–N7 / O1–O8). The engine entry points (renderToFile / compileVoiceScript) and the
// browser download/file APIs are injected or stubbed; asserts observable store phase +
// that render mutates nothing and a malformed compile injects nothing (atomic).

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RenderProgress, RenderedFile } from '../../engine/renderer';
import type { CompileResult } from '../../engine/voice-script';
import type { Transport } from '../../engine/transport';
import { createNoticeStore } from './notices.svelte';
import { createPlaybackStore, createSessionStore } from './session.svelte';
import { createRenderStore, createVoiceScriptStore } from './authoring.svelte';

const flush = () => new Promise((r) => setTimeout(r, 0));

function fakeTransport() {
  return {
    state: 'idle',
    load: vi.fn(),
    reapply: vi.fn(),
    duration: vi.fn(() => 300),
    on: vi.fn(),
    setMasterTrim: vi.fn(),
  } as unknown as Transport;
}

function makeSession() {
  const transport = fakeTransport();
  const notices = createNoticeStore();
  const playback = createPlaybackStore({ transport, notices });
  const session = createSessionStore({ transport, playback });
  return { session, notices, transport };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('RenderStore (§15/§19)', () => {
  it('render("wav") drives renderToFile and produces { blob, filename } from onProgress', async () => {
    const { session, notices } = makeSession();
    const renderToFile = vi.fn(async (_p, _fmt, opts?: { onProgress?: (p: RenderProgress) => void }) => {
      opts?.onProgress?.({ phase: 'rendering', fraction: 0.5 });
      opts?.onProgress?.({ phase: 'encoding', fraction: 0.9 });
      return { blob: new Blob(['x']), filename: 'untitled-session.wav', mime: 'audio/wav' } as RenderedFile;
    });
    const store = createRenderStore({ session, notices, renderToFile: renderToFile as never, hasOffline: () => true });
    store.render('wav');
    await flush();
    expect(renderToFile).toHaveBeenCalledTimes(1);
    expect(renderToFile.mock.calls[0][1]).toBe('wav');
    expect(store.phase).toBe('done');
    expect(store.progress).toBe(1);
    expect(store.result).toEqual({ blob: expect.any(Blob), filename: 'untitled-session.wav' });
  });

  it('render is READ-ONLY over the preset (mutates nothing, purity §19)', async () => {
    const { session, notices } = makeSession();
    const before = structuredClone(session.preset);
    const store = createRenderStore({
      session,
      notices,
      renderToFile: vi.fn(async () => ({ blob: new Blob(), filename: 'x.wav', mime: 'audio/wav' })) as never,
      hasOffline: () => true,
    });
    store.render('wav');
    await flush();
    expect(session.preset).toEqual(before);
  });

  it('canRender=false disables render with the N1 notice when OfflineAudioContext is absent', () => {
    const { session, notices } = makeSession();
    const renderToFile = vi.fn();
    const store = createRenderStore({ session, notices, renderToFile: renderToFile as never, hasOffline: () => false });
    expect(store.canRender).toBe(false);
    store.render('wav');
    expect(renderToFile).not.toHaveBeenCalled();
    expect(notices.items.some((n) => /needs a desktop browser/i.test(n.message))).toBe(true);
  });

  it('a render throw → phase="error", preset untouched (N4)', async () => {
    const { session, notices } = makeSession();
    const before = structuredClone(session.preset);
    const store = createRenderStore({
      session,
      notices,
      renderToFile: vi.fn(async () => {
        throw new Error('boom');
      }) as never,
      hasOffline: () => true,
    });
    store.render('wav');
    await flush();
    expect(store.phase).toBe('error');
    expect(session.preset).toEqual(before);
    expect(notices.items.some((n) => n.severity === 'error')).toBe(true);
  });

  it('a second render while one is in flight is ignored (N7)', async () => {
    const { session, notices } = makeSession();
    let resolve!: (f: RenderedFile) => void;
    const renderToFile = vi.fn(() => new Promise<RenderedFile>((r) => (resolve = r)));
    const store = createRenderStore({ session, notices, renderToFile: renderToFile as never, hasOffline: () => true });
    store.render('wav');
    store.render('wav'); // ignored — still rendering
    expect(renderToFile).toHaveBeenCalledTimes(1);
    resolve({ blob: new Blob(), filename: 'x.wav', mime: 'audio/wav' });
    await flush();
  });

  it('cancel aborts the in-flight render via the AbortSignal (N3) and stays idle', async () => {
    const { session, notices } = makeSession();
    let seenSignal: AbortSignal | undefined;
    const renderToFile = vi.fn((_p, _fmt, opts?: { signal?: AbortSignal }) => {
      seenSignal = opts?.signal;
      return new Promise<RenderedFile>((_res, rej) => {
        opts?.signal?.addEventListener('abort', () => {
          const err = Object.assign(new Error('cancelled'), { code: 'CANCELLED' });
          rej(err);
        });
      });
    });
    const store = createRenderStore({ session, notices, renderToFile: renderToFile as never, hasOffline: () => true });
    store.render('wav');
    expect(seenSignal).toBeInstanceOf(AbortSignal);
    store.cancel();
    await flush();
    expect(seenSignal!.aborted).toBe(true);
    expect(store.phase).toBe('idle'); // a user cancel is not an error
  });

  it('download() fires the <a download> only on the gesture and clears result (N5)', async () => {
    const { session, notices } = makeSession();
    const store = createRenderStore({
      session,
      notices,
      renderToFile: vi.fn(async () => ({ blob: new Blob(['y']), filename: 'sleep.wav', mime: 'audio/wav' })) as never,
      hasOffline: () => true,
    });
    store.render('wav');
    await flush();

    const clickSpy = vi.fn();
    const realCreate = document.createElement.bind(document);
    vi.spyOn(document, 'createElement').mockImplementation((tag: string) => {
      const el = realCreate(tag);
      if (tag === 'a') (el as HTMLAnchorElement).click = clickSpy;
      return el;
    });
    vi.stubGlobal('URL', { createObjectURL: vi.fn(() => 'blob:x'), revokeObjectURL: vi.fn() });

    store.download();
    expect(clickSpy).toHaveBeenCalledTimes(1);
    expect(store.result).toBeNull(); // cleared after the download fires
    vi.unstubAllGlobals();
  });

  it('pre-render missingClipIds surfaces only actually-absent clip ids (N2)', async () => {
    const { session, notices } = makeSession();
    session.injectLayers([
      { id: 'v1', kind: 'voice', source: { clipId: 'c_missing' }, t: 1 },
      { id: 'v2', kind: 'voice', source: { clipId: 'c_present' }, t: 2 },
      { id: 't1', kind: 'tone', source: { synth: { shape: 'sine', freqHz: 440, attackSec: 0, releaseSec: 1 } }, t: 0 },
    ]);
    const clipLib = { hasClip: vi.fn(async (id: string) => id === 'c_present') };
    const store = createRenderStore({
      session,
      notices,
      renderToFile: vi.fn(async () => ({ blob: new Blob(), filename: 'x.wav', mime: 'audio/wav' })) as never,
      hasOffline: () => true,
      clipLib,
    });
    store.render('wav');
    expect(store.missingClipIds).toEqual([]); // async check not yet resolved
    await flush();
    expect(store.missingClipIds).toEqual(['c_missing']); // absent only; c_present excluded
  });
});

describe('VoiceScriptStore (§15/§20)', () => {
  const okResult = (): CompileResult => ({
    ok: true,
    compiled: {
      layers: [
        { id: 'voice_1', kind: 'voice', source: { clipId: 'c1' }, t: 5 },
        { id: 'voice_2', kind: 'voice', source: { clipId: 'c2' }, t: 20 },
      ],
      clips: [],
      totalSec: 25,
    },
    issues: [],
  });

  it('importAndCompile success injects the compiled layers and dirties (O6)', async () => {
    const { session, notices } = makeSession();
    const compileVoiceScript = vi.fn(async () => okResult());
    const store = createVoiceScriptStore({
      session,
      notices,
      compileVoiceScript: compileVoiceScript as never,
      tts: { source: 'tts', produce: vi.fn() } as never,
      clipLib: { importVia: vi.fn() as never },
    });
    store.importAndCompile({ version: 1 });
    await flush();
    expect(compileVoiceScript).toHaveBeenCalledTimes(1);
    expect(session.preset.layers!.map((l) => l.id)).toEqual(['voice_1', 'voice_2']);
    expect(session.preset.layers!.map((l) => l.t)).toEqual([5, 20]); // not re-timed
    expect(session.dirty).toBe(true);
    expect(store.phase).toBe('done');
  });

  it('a malformed script injects NOTHING (atomic, O1)', async () => {
    const { session, notices } = makeSession();
    const before = structuredClone(session.preset);
    const store = createVoiceScriptStore({
      session,
      notices,
      compileVoiceScript: vi.fn(async () => ({
        ok: false,
        issues: [{ code: 'NOT_OBJECT', severity: 'error', path: '', message: 'not an object' }],
      })) as never,
      tts: { source: 'tts', produce: vi.fn() } as never,
      clipLib: { importVia: vi.fn() as never },
    });
    store.importAndCompile('garbage');
    await flush();
    expect(session.preset).toEqual(before); // nothing injected
    expect(store.phase).toBe('error');
    expect(notices.items.some((n) => n.severity === 'error')).toBe(true);
  });

  it('a negative-slack warning still injects (O5)', async () => {
    const { session, notices } = makeSession();
    const store = createVoiceScriptStore({
      session,
      notices,
      compileVoiceScript: vi.fn(async () => ({
        ...okResult(),
        issues: [{ code: 'AT_NEGATIVE_SLACK', severity: 'warning', path: 'blocks[0]', message: 'cadence slack' }],
      })) as never,
      tts: { source: 'tts', produce: vi.fn() } as never,
      clipLib: { importVia: vi.fn() as never },
    });
    store.importAndCompile({ version: 1 });
    await flush();
    expect(session.preset.layers!.length).toBe(2); // still injected
    expect(notices.items.some((n) => n.severity === 'warning')).toBe(true);
    expect(store.phase).toBe('done');
  });

  it('canCompile=false disables compile with the O3 notice when tts is absent', () => {
    const { session, notices } = makeSession();
    const compileVoiceScript = vi.fn();
    const store = createVoiceScriptStore({
      session,
      notices,
      compileVoiceScript: compileVoiceScript as never,
      tts: null,
      clipLib: { importVia: vi.fn() as never },
    });
    expect(store.canCompile).toBe(false);
    store.importAndCompile({ version: 1 });
    expect(compileVoiceScript).not.toHaveBeenCalled();
    expect(notices.items.some((n) => /needs the desktop studio/i.test(n.message))).toBe(true);
  });

  it('passes the working preset duration as durationSec into the compiler deps', async () => {
    const { session, notices } = makeSession();
    session.setDuration(123);
    const compileVoiceScript = vi.fn(async (_script: unknown, _deps: { durationSec?: number }) => okResult());
    const store = createVoiceScriptStore({
      session,
      notices,
      compileVoiceScript: compileVoiceScript as never,
      tts: { source: 'tts', produce: vi.fn() } as never,
      clipLib: { importVia: vi.fn() as never },
    });
    store.importAndCompile({ version: 1 });
    await flush();
    expect(compileVoiceScript.mock.calls[0][1]).toMatchObject({ durationSec: 123 });
  });
});
