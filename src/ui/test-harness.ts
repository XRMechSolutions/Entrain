// Test-only support: a fake Transport and a real-store AppContext for component/screen
// tests. Not a *.test.ts (no tests of its own); imported by the screen test files so they
// exercise the real stores wired to a controllable transport. Plain TS — it only CALLS the
// compiled rune stores, it does not declare runes itself.

import { vi } from 'vitest';
import type { Transport, TransportEventMap, TransportState } from '../engine/transport';
import { createNoticeStore, createUiStore } from './stores/notices.svelte';
import { createPlaybackStore, createSessionStore } from './stores/session.svelte';
import { createClipStore, createInstallStore, createLibraryStore } from './stores/library.svelte';
import { createRenderStore, createVoiceScriptStore } from './stores/authoring.svelte';
import type { AppContext } from './context';

type Handler = (p: unknown) => void;

export interface FakeTransport extends Transport {
  emit<K extends keyof TransportEventMap>(event: K, payload: TransportEventMap[K]): void;
  setState(state: TransportState): void;
}

/** A fake transport that records calls and lets a test drive its events/state. */
export function makeFakeTransport(durationSec = 300): FakeTransport {
  const handlers: Record<string, Handler[]> = {};
  let state: TransportState = 'idle';
  const fake = {
    get state() {
      return state;
    },
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
    setLift: vi.fn(),
    setKeepScreenOn: vi.fn().mockResolvedValue(undefined),
    isKeepScreenOn: vi.fn(() => false),
    on: (ev: string, h: Handler) => {
      (handlers[ev] ??= []).push(h);
    },
    off: vi.fn(),
    destroy: vi.fn().mockResolvedValue(undefined),
    emit(ev: string, payload: unknown) {
      (handlers[ev] ?? []).forEach((h) => h(payload));
    },
    setState(next: TransportState) {
      state = next;
      (handlers['statechange'] ?? []).forEach((h) => h({ state: next }));
    },
  };
  return fake as unknown as FakeTransport;
}

/** Build a full AppContext backed by the REAL stores and a fake transport. The Phase-2
 *  authoring stores use injected stubs so a harness-built context never touches a real
 *  OfflineAudioContext / clip-library / tts model (component/screen tests stay hermetic). */
export function makeAppContext(transport: FakeTransport = makeFakeTransport()): AppContext {
  const notices = createNoticeStore();
  const playback = createPlaybackStore({ transport, notices });
  const session = createSessionStore({ transport, playback });
  const library = createLibraryStore({ session, notices });
  const { store: install } = createInstallStore();
  const ui = createUiStore();

  const clips = createClipStore({
    notices,
    clipLib: {
      list: vi.fn(async () => []),
      totalBytes: vi.fn(async () => 0),
      remove: vi.fn(async () => true),
      importVia: vi.fn(async () => {
        throw new Error('importVia not stubbed in this test');
      }),
      createFileImportAdapter: vi.fn(() => ({ source: 'file', produce: vi.fn() })) as never,
      countPresetsUsingClip: vi.fn(() => 0),
    },
  });
  const render = createRenderStore({
    session,
    notices,
    renderToFile: vi.fn(async () => ({ blob: new Blob(), filename: 'x.wav', mime: 'audio/wav' })) as never,
    hasOffline: () => true,
  });
  const voiceScript = createVoiceScriptStore({
    session,
    notices,
    compileVoiceScript: vi.fn(async () => ({ ok: false, issues: [] })) as never,
    tts: { source: 'tts', produce: vi.fn() } as never,
    clipLib: { importVia: vi.fn() as never },
  });

  return { transport, session, playback, library, notices, install, ui, clips, render, voiceScript };
}
