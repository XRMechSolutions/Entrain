// Phase-2 ClipStore tests (design §18, interfaces §13, edge M1–M9). The clip-library
// module functions are injected (no IndexedDB); asserts observable store state + the
// ClipLibraryErrorCode → notice mapping. The panel never decodes a clip (metadata only).

import { describe, expect, it, vi } from 'vitest';
import { ClipLibraryError, type Clip } from '../../engine/clip-library';
import { createNoticeStore } from './notices.svelte';
import { createClipStore, type ClipLibraryDeps } from './library.svelte';

function clip(id: string, name: string, createdAt: number, bytes = 1000): Clip {
  return {
    id,
    hash: id,
    format: 'audio/mpeg',
    durationSec: 5,
    source: 'file',
    meta: { name },
    bytes,
    createdAt,
    lastUsedAt: createdAt,
  };
}

function setup(libOverrides?: Partial<ClipLibraryDeps>) {
  const notices = createNoticeStore();
  const lib: ClipLibraryDeps = {
    list: vi.fn(async () => []),
    totalBytes: vi.fn(async () => 0),
    remove: vi.fn(async () => true),
    importVia: vi.fn(async () => clip('clip_new', 'new.mp3', 5)),
    createFileImportAdapter: vi.fn(() => ({ source: 'file', produce: vi.fn() })) as never,
    countPresetsUsingClip: vi.fn(() => 0),
    ...libOverrides,
  };
  const store = createClipStore({ notices, clipLib: lib });
  return { store, notices, lib };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('ClipStore (§13/§18)', () => {
  it('refresh exposes Clip[] newest-first + totalBytes', async () => {
    const { store } = setup({
      list: vi.fn(async () => [clip('a', 'old', 1), clip('b', 'new', 100)]),
      totalBytes: vi.fn(async () => 4242),
    });
    store.refresh();
    await flush();
    expect(store.clips.map((c) => c.id)).toEqual(['b', 'a']); // newest createdAt first
    expect(store.totalBytes).toBe(4242);
  });

  it('importFile calls importVia(createFileImportAdapter(), file) and refreshes (M8)', async () => {
    const { store, lib } = setup();
    const file = new File([new Uint8Array([1, 2, 3])], 'tone.wav', { type: 'audio/wav' });
    store.importFile(file);
    expect(lib.importVia).toHaveBeenCalledTimes(1);
    // The adapter is built and passed as the first arg, the file as the second.
    expect(lib.createFileImportAdapter).toHaveBeenCalled();
    expect(vi.mocked(lib.importVia).mock.calls[0][1]).toBe(file);
    await flush();
    expect(lib.list).toHaveBeenCalled(); // refreshed after import
  });

  it('a dedup hit toasts "already in your library" with the same id (M5)', async () => {
    const existing = clip('clip_dup', 'dup.mp3', 10);
    const { store, notices } = setup({
      list: vi.fn(async () => [existing]),
      importVia: vi.fn(async () => existing), // same id already present
    });
    store.refresh();
    await flush();
    store.importFile(new File([new Uint8Array([1])], 'dup.mp3'));
    await flush();
    expect(notices.items.some((n) => /already in your library/i.test(n.message))).toBe(true);
  });

  it('DECODE_FAILED → "Couldn\'t read that as audio" notice (M1)', async () => {
    const { store, notices } = setup({
      importVia: vi.fn(async () => {
        throw new ClipLibraryError('DECODE_FAILED');
      }),
    });
    store.importFile(new File([new Uint8Array([1])], 'x.txt'));
    await flush();
    expect(notices.items.some((n) => n.severity === 'error' && /read that as audio/i.test(n.message))).toBe(true);
  });

  it('QUOTA_EXCEEDED → "Storage is full" notice (M2)', async () => {
    const { store, notices } = setup({
      importVia: vi.fn(async () => {
        throw new ClipLibraryError('QUOTA_EXCEEDED');
      }),
    });
    store.importFile(new File([new Uint8Array([1])], 'big.wav'));
    await flush();
    expect(notices.items.some((n) => /storage is full/i.test(n.message))).toBe(true);
  });

  it('UNSUPPORTED on refresh → "Clip storage isn\'t available" notice (M6)', async () => {
    const { store, notices } = setup({
      list: vi.fn(async () => {
        throw new ClipLibraryError('UNSUPPORTED');
      }),
    });
    store.refresh();
    await flush();
    expect(notices.items.some((n) => /isn't available/i.test(n.message))).toBe(true);
  });

  it('removeClip warns "used by N presets" then removes on confirm (M3)', async () => {
    const confirmSpy = vi.fn((_msg?: string) => true);
    vi.stubGlobal('confirm', confirmSpy);
    const { store, lib } = setup({ countPresetsUsingClip: vi.fn(() => 2) });
    store.removeClip('clip_x');
    expect(confirmSpy).toHaveBeenCalledTimes(1);
    expect(confirmSpy.mock.calls[0][0]).toMatch(/2 saved presets/);
    expect(lib.remove).toHaveBeenCalledWith('clip_x');
    await flush();
    vi.unstubAllGlobals();
  });

  it('removeClip aborts when the confirm is declined', async () => {
    vi.stubGlobal('confirm', vi.fn(() => false));
    const { store, lib } = setup();
    store.removeClip('clip_x');
    expect(lib.remove).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('removeClip with an unknown id (remove→false) is treated as already-gone (M4)', async () => {
    vi.stubGlobal('confirm', vi.fn(() => true));
    const { store, lib } = setup({ remove: vi.fn(async () => false) });
    store.removeClip('gone');
    await flush();
    expect(lib.list).toHaveBeenCalled(); // refreshed, no error
    vi.unstubAllGlobals();
  });

  it('pick mode: openPicker → pick returns the id and closes back to browse', () => {
    const { store } = setup();
    const onPick = vi.fn();
    store.openPicker(onPick);
    expect(store.mode).toBe('pick');
    store.pick('clip_chosen');
    expect(onPick).toHaveBeenCalledWith('clip_chosen');
    expect(store.mode).toBe('browse');
  });

  it('importing in pick mode binds the imported clip and closes the picker (import-then-pick)', async () => {
    const { store, lib } = setup({ importVia: vi.fn(async () => clip('clip_imp', 'imp.wav', 1)) });
    const onPick = vi.fn();
    store.openPicker(onPick);
    void lib; // satisfy lint
    store.importFile(new File([new Uint8Array([1])], 'imp.wav'));
    await flush();
    expect(onPick).toHaveBeenCalledWith('clip_imp');
    expect(store.mode).toBe('browse');
  });
});
