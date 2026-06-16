// Test-only support: a fake Transport and a real-store AppContext for component/screen
// tests. Not a *.test.ts (no tests of its own); imported by the screen test files so they
// exercise the real stores wired to a controllable transport. Plain TS — it only CALLS the
// compiled rune stores, it does not declare runes itself.

import { vi } from 'vitest';
import type { Transport, TransportEventMap, TransportState } from '../engine/transport';
import { createNoticeStore, createUiStore } from './stores/notices.svelte';
import { createPlaybackStore, createSessionStore } from './stores/session.svelte';
import { createInstallStore, createLibraryStore } from './stores/library.svelte';
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

/** Build a full AppContext backed by the REAL stores and a fake transport. */
export function makeAppContext(transport: FakeTransport = makeFakeTransport()): AppContext {
  const notices = createNoticeStore();
  const playback = createPlaybackStore({ transport, notices });
  const session = createSessionStore({ transport, playback });
  const library = createLibraryStore({ session, notices });
  const { store: install } = createInstallStore();
  const ui = createUiStore();
  return { transport, session, playback, library, notices, install, ui };
}
