import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDefaultPreset, type Preset } from '../../engine/session-model';
import {
  PersistenceError,
  clearLibrary,
  deletePreset,
  exportPreset,
  importPresetFromFile,
  listPresets,
  loadPreset,
  restoreDefaultPresets,
  savePreset,
  seedDefaultPresets,
  type ImportedPreset,
  type PresetSummary,
  type SavedPreset,
} from '../../engine/persistence';
import { createInstallStore, createLibraryStore } from './library.svelte';
import { createNoticeStore } from './notices.svelte';
import type { SessionStore } from './session.svelte';

vi.mock('../../engine/persistence', async (importActual) => {
  const actual = await importActual<typeof import('../../engine/persistence')>();
  return {
    ...actual,
    listPresets: vi.fn(),
    loadPreset: vi.fn(),
    savePreset: vi.fn(),
    deletePreset: vi.fn(),
    clearLibrary: vi.fn(),
    seedDefaultPresets: vi.fn(),
    restoreDefaultPresets: vi.fn(),
    exportPreset: vi.fn(),
    importPresetFromFile: vi.fn(),
  };
});

const flush = (): Promise<void> => new Promise((r) => setTimeout(r));

function makeFakeSession() {
  const s = {
    preset: createDefaultPreset() as Preset,
    revision: 0,
    dirty: false,
    selectedId: null as string | null,
    reset: vi.fn((next: Preset, id: string | null = null) => {
      s.preset = next;
      s.selectedId = id;
      s.dirty = false;
    }),
    markSaved: vi.fn((id: string) => {
      s.selectedId = id;
      s.dirty = false;
    }),
    markUnsaved: vi.fn(() => {
      s.dirty = true;
    }),
    clearSelection: vi.fn(() => {
      s.selectedId = null;
    }),
    setNodeParam: vi.fn(),
    setWaveform: vi.fn(),
    setName: vi.fn(),
    setMasterGain: vi.fn(),
    addNode: vi.fn(() => '0'),
    moveNode: vi.fn(),
    setNodeValue: vi.fn(),
    setNodeTransition: vi.fn(),
    setNodeMod: vi.fn(),
    removeNode: vi.fn(),
    applyLiveEdit: vi.fn(),
  };
  return s;
}

function setup() {
  const session = makeFakeSession();
  const notices = createNoticeStore();
  const library = createLibraryStore({ session: session as unknown as SessionStore, notices });
  return { session, notices, library };
}

function summary(id: string, updatedAt: number): PresetSummary {
  return { id, name: id, durationSec: 60, nodeCount: 1, voiceCount: 1, createdAt: 0, updatedAt };
}
function saved(id: string, warnings: SavedPreset['warnings'] = []): SavedPreset {
  return { id, createdAt: 0, updatedAt: 1, preset: createDefaultPreset(), warnings };
}

afterEach(() => vi.unstubAllGlobals());

describe('LibraryStore — happy paths', () => {
  it('refresh exposes the listPresets result (already sorted by persistence)', () => {
    const { library } = setup();
    const rows = [summary('b', 200), summary('a', 100)];
    vi.mocked(listPresets).mockReturnValue(rows);
    library.refresh();
    expect(library.items).toEqual(rows);
  });

  it('open() loads the preset into the session and surfaces warning notes', () => {
    const { library, session, notices } = setup();
    const rec = saved('lib-1', [{ code: 'STEPS_REQUIRE_JUMP', severity: 'warning', path: 'nodes[0]', message: 'note' }]);
    vi.mocked(loadPreset).mockReturnValue(rec);
    library.open('lib-1');
    expect(session.reset).toHaveBeenCalledWith(rec.preset, 'lib-1');
    expect(notices.items.some((n) => n.severity === 'info')).toBe(true);
  });

  it('open() with a missing record raises an info notice and refreshes (not an error)', () => {
    const { library, session, notices } = setup();
    vi.mocked(loadPreset).mockReturnValue(null);
    vi.mocked(listPresets).mockReturnValue([]);
    library.open('gone');
    expect(session.reset).not.toHaveBeenCalled();
    expect(notices.items.at(-1)).toMatchObject({ severity: 'info' });
    expect(listPresets).toHaveBeenCalled();
  });

  it('saveCurrent() saves with the selectedId, marks saved, and refreshes', () => {
    const { library, session } = setup();
    session.selectedId = 'lib-9';
    vi.mocked(savePreset).mockReturnValue(saved('lib-9'));
    vi.mocked(listPresets).mockReturnValue([summary('lib-9', 5)]);
    library.saveCurrent();
    expect(savePreset).toHaveBeenCalledWith(session.preset, 'lib-9');
    expect(session.markSaved).toHaveBeenCalledWith('lib-9');
    expect(library.items).toHaveLength(1);
  });

  it('saveAsNew() saves with no id', () => {
    const { library, session } = setup();
    vi.mocked(savePreset).mockReturnValue(saved('new-1'));
    vi.mocked(listPresets).mockReturnValue([]);
    library.saveAsNew();
    expect(savePreset).toHaveBeenCalledWith(session.preset);
    expect(session.markSaved).toHaveBeenCalledWith('new-1');
  });

  it('exportCurrent() invokes exportPreset directly and toasts the filename', () => {
    const { library, session, notices } = setup();
    vi.mocked(exportPreset).mockReturnValue('evening.json');
    library.exportCurrent();
    expect(exportPreset).toHaveBeenCalledWith(session.preset);
    expect(notices.items.at(-1)?.message).toContain('evening.json');
  });

  it('restoreDefaults() tops up, refreshes, and toasts the count when defaults were added', () => {
    const { library, notices } = setup();
    vi.mocked(restoreDefaultPresets).mockReturnValue([summary('d1', 1), summary('d2', 2)]);
    vi.mocked(listPresets).mockReturnValue([summary('d1', 1), summary('d2', 2)]);
    library.restoreDefaults();
    expect(restoreDefaultPresets).toHaveBeenCalledTimes(1);
    expect(listPresets).toHaveBeenCalled(); // refreshed
    expect(library.items).toHaveLength(2);
    expect(notices.items.at(-1)).toMatchObject({ severity: 'info' });
    expect(notices.items.at(-1)?.message).toContain('2');
  });

  it('restoreDefaults() toasts an "already has all" info notice when nothing was added', () => {
    const { library, notices } = setup();
    vi.mocked(restoreDefaultPresets).mockReturnValue([]);
    vi.mocked(listPresets).mockReturnValue([summary('d1', 1)]);
    library.restoreDefaults();
    expect(notices.items.at(-1)).toMatchObject({ severity: 'info' });
    expect(notices.items.at(-1)?.message).toMatch(/already has all/i);
  });

  it('restoreDefaults() maps a PersistenceError to an error notice (no throw)', () => {
    const { library, notices } = setup();
    vi.mocked(restoreDefaultPresets).mockImplementationOnce(() => {
      throw new PersistenceError('QUOTA_EXCEEDED', 'full');
    });
    library.restoreDefaults();
    expect(notices.items.at(-1)).toMatchObject({ severity: 'error' });
    expect(notices.items.at(-1)?.message).toMatch(/full/i);
  });

  it('importFromFile() auto-saves the import, selects it clean, and toasts a migration', async () => {
    const { library, session, notices } = setup();
    const imported: ImportedPreset = {
      preset: createDefaultPreset(),
      migratedFrom: 1,
      warnings: [],
      filename: 'old.json',
    };
    vi.mocked(importPresetFromFile).mockResolvedValue(imported);
    vi.mocked(savePreset).mockReturnValue(saved('imp-1'));
    vi.mocked(listPresets).mockReturnValue([summary('imp-1', 5)]);
    const ok = await library.importFromFile();
    expect(ok).toBe(true);
    expect(savePreset).toHaveBeenCalledWith(imported.preset); // saved with no id → new library entry
    expect(session.reset).toHaveBeenCalledWith(imported.preset, 'imp-1'); // selected + clean, no markUnsaved
    expect(session.markUnsaved).not.toHaveBeenCalled();
    expect(library.items).toHaveLength(1); // refreshed
    expect(notices.items.some((n) => /schema v1/.test(n.message))).toBe(true);
  });

  it('importFromFile() resolves false and does not select when the save fails', async () => {
    const { library, session, notices } = setup();
    vi.mocked(importPresetFromFile).mockResolvedValue({
      preset: createDefaultPreset(),
      migratedFrom: null,
      warnings: [],
      filename: 'x.json',
    });
    vi.mocked(savePreset).mockImplementation(() => {
      throw new PersistenceError('QUOTA_EXCEEDED', 'full');
    });
    const ok = await library.importFromFile();
    expect(ok).toBe(false);
    expect(session.reset).not.toHaveBeenCalled(); // working preset left untouched
    expect(notices.items.at(-1)?.message).toMatch(/full/i);
  });
});

describe('LibraryStore — confirms + errors', () => {
  it('open() while dirty confirms discard and aborts on cancel', () => {
    const { library, session } = setup();
    session.dirty = true;
    vi.stubGlobal('confirm', vi.fn().mockReturnValue(false));
    library.open('lib-1');
    expect(loadPreset).not.toHaveBeenCalled();

    vi.stubGlobal('confirm', vi.fn().mockReturnValue(true));
    vi.mocked(loadPreset).mockReturnValue(saved('lib-1'));
    library.open('lib-1');
    expect(loadPreset).toHaveBeenCalledWith('lib-1');
  });

  it('remove() is behind a confirm and clears the selection when deleting the open record', () => {
    const { library, session } = setup();
    session.selectedId = 'lib-1';
    vi.stubGlobal('confirm', vi.fn().mockReturnValue(false));
    library.remove('lib-1');
    expect(deletePreset).not.toHaveBeenCalled();

    vi.stubGlobal('confirm', vi.fn().mockReturnValue(true));
    vi.mocked(deletePreset).mockReturnValue(true);
    vi.mocked(listPresets).mockReturnValue([]);
    library.remove('lib-1');
    expect(deletePreset).toHaveBeenCalledWith('lib-1');
    expect(session.clearSelection).toHaveBeenCalled();
  });

  it('STORAGE_CORRUPT exposes a "Reset library" action that clears + seeds + refreshes', () => {
    const { library, notices } = setup();
    vi.mocked(listPresets).mockImplementationOnce(() => {
      throw new PersistenceError('STORAGE_CORRUPT', 'bad blob');
    });
    library.refresh();
    const banner = notices.items.at(-1)!;
    expect(banner).toMatchObject({ severity: 'error' });
    expect(banner.action?.label).toBe('Reset library');

    vi.mocked(listPresets).mockReturnValue([]);
    banner.action!.run();
    expect(clearLibrary).toHaveBeenCalled();
    expect(seedDefaultPresets).toHaveBeenCalled();
    expect(listPresets).toHaveBeenCalled();
  });

  it('QUOTA_EXCEEDED and INVALID_PRESET surface friendly copy (issues listed)', () => {
    const { library, notices } = setup();
    vi.mocked(savePreset).mockImplementationOnce(() => {
      throw new PersistenceError('QUOTA_EXCEEDED', 'full');
    });
    library.saveCurrent();
    expect(notices.items.at(-1)?.message).toMatch(/full/i);

    vi.mocked(savePreset).mockImplementationOnce(() => {
      throw new PersistenceError('INVALID_PRESET', 'invalid', {
        issues: [{ code: 'NAME_EMPTY', severity: 'error', path: 'name', message: 'name must not be empty' }],
      });
    });
    library.saveCurrent();
    expect(notices.items.at(-1)?.message).toContain('name must not be empty');
  });

  it('IMPORT_CANCELLED is silently ignored (no banner)', async () => {
    const { library, notices } = setup();
    vi.mocked(importPresetFromFile).mockRejectedValue(new PersistenceError('IMPORT_CANCELLED', 'cancelled'));
    library.importFromFile();
    await flush();
    expect(notices.items).toHaveLength(0);
  });
});

describe('InstallStore', () => {
  function fakeBeforeInstallPrompt() {
    const e = new Event('beforeinstallprompt') as Event & {
      prompt: ReturnType<typeof vi.fn>;
      userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
    };
    e.prompt = vi.fn().mockResolvedValue(undefined);
    e.userChoice = Promise.resolve({ outcome: 'accepted' });
    return e;
  }

  it('captures beforeinstallprompt (single-use) and prompts on click', () => {
    vi.stubGlobal('matchMedia', vi.fn().mockReturnValue({ matches: false, addEventListener: vi.fn() }));
    const { store } = createInstallStore();
    expect(store.canInstall).toBe(false);

    const e = fakeBeforeInstallPrompt();
    window.dispatchEvent(e);
    expect(store.canInstall).toBe(true);

    store.promptInstall();
    expect(e.prompt).toHaveBeenCalledTimes(1);
    expect(store.canInstall).toBe(false); // single-use: cleared after prompt
  });

  it('hides install affordances when already standalone', () => {
    vi.stubGlobal(
      'matchMedia',
      vi.fn((q: string) => ({ matches: q.includes('standalone'), addEventListener: vi.fn() })),
    );
    const { store } = createInstallStore();
    expect(store.isStandalone).toBe(true);

    window.dispatchEvent(fakeBeforeInstallPrompt());
    expect(store.canInstall).toBe(false); // never captured while standalone
  });

  it('detects iOS (UA + not standalone) for the A2HS card', () => {
    vi.stubGlobal('matchMedia', vi.fn().mockReturnValue({ matches: false, addEventListener: vi.fn() }));
    vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0)', standalone: false });
    const { store } = createInstallStore();
    expect(store.isIos).toBe(true);
  });

  it('SW update is one user-click reload only — never auto-reloads', () => {
    vi.stubGlobal('matchMedia', vi.fn().mockReturnValue({ matches: false, addEventListener: vi.fn() }));
    const { store, hooks, setUpdateSW } = createInstallStore();
    const updateSW = vi.fn().mockResolvedValue(undefined);
    setUpdateSW(updateSW);

    expect(store.updateReady).toBe(false);
    hooks.onNeedRefresh();
    expect(store.updateReady).toBe(true);
    expect(updateSW).not.toHaveBeenCalled(); // ready != reloaded

    store.applyUpdate();
    expect(updateSW).toHaveBeenCalledWith(true); // reload only on click
    expect(store.updateReady).toBe(false);
  });

  it('onOfflineReady raises the one-time flag; dismissUpdate clears updateReady without reloading', () => {
    vi.stubGlobal('matchMedia', vi.fn().mockReturnValue({ matches: false, addEventListener: vi.fn() }));
    const { store, hooks, setUpdateSW } = createInstallStore();
    const updateSW = vi.fn().mockResolvedValue(undefined);
    setUpdateSW(updateSW);

    hooks.onOfflineReady();
    expect(store.offlineReady).toBe(true);

    hooks.onNeedRefresh();
    store.dismissUpdate();
    expect(store.updateReady).toBe(false);
    expect(updateSW).not.toHaveBeenCalled();
  });
});
