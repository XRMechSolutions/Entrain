// library.svelte.ts — the preset-library store (thin wrappers over `persistence` with
// dirty-aware discard confirmation and PersistenceError→Notice mapping) and the PWA
// install store (beforeinstallprompt capture, iOS A2HS detection, and the prompt-mode
// service-worker update hooks). Both are Svelte-5 runes factories.
//
// Persistence errors map to friendly banners per design §10 / edge-cases E. The SW
// update toast NEVER auto-reloads — a reload only happens on the user's explicit
// applyUpdate() click (D-017, edge H5).

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
  type PresetSummary,
} from '../../engine/persistence';
import {
  ClipLibraryError,
  createFileImportAdapter as defaultCreateFileImportAdapter,
  importVia as defaultImportVia,
  list as defaultListClips,
  remove as defaultRemoveClip,
  totalBytes as defaultTotalBytes,
  type Clip,
} from '../../engine/clip-library';
import type { ValidationIssue } from '../../engine/session-model';
import type { ClipPanelMode } from '../lib/constants';
import type { SessionStore } from './session.svelte';
import type { NoticeStore } from './notices.svelte';

// ---------------------------------------------------------------------------
// Library store
// ---------------------------------------------------------------------------

export interface LibraryStore {
  readonly items: ReadonlyArray<PresetSummary>;
  readonly loading: boolean;

  refresh(): void;
  seed(): void;
  restoreDefaults(): void;
  open(id: string): void;
  saveCurrent(): void;
  saveAsNew(): void;
  remove(id: string): void;
  exportCurrent(): void;
  /** Import a preset file: auto-save it into the library and adopt it as the selected,
   *  clean working preset (no separate Save). Resolves true when a preset was imported and
   *  saved (the caller navigates to the editor on true), false on cancel/error. */
  importFromFile(): Promise<boolean>;
}

function confirmDiscard(): boolean {
  if (typeof window === 'undefined' || typeof window.confirm !== 'function') return true;
  return window.confirm('Discard unsaved changes?');
}

function confirmDelete(): boolean {
  if (typeof window === 'undefined' || typeof window.confirm !== 'function') return true;
  return window.confirm('Delete this preset? This cannot be undone.');
}

function issuesList(issues: ValidationIssue[] | undefined): string {
  if (!issues || issues.length === 0) return '';
  return issues.map((i) => `${i.path || 'preset'}: ${i.message}`).join('; ');
}

export function createLibraryStore(deps: { session: SessionStore; notices: NoticeStore }): LibraryStore {
  const { session, notices } = deps;

  let items = $state<PresetSummary[]>([]);
  let loading = $state(false);

  function refresh(): void {
    try {
      items = listPresets();
    } catch (e) {
      handleError(e);
    }
  }

  function resetLibrary(): void {
    try {
      clearLibrary();
      seedDefaultPresets();
      refresh();
    } catch (e) {
      handleError(e);
    }
  }

  function handleError(e: unknown): void {
    if (e instanceof PersistenceError) {
      switch (e.code) {
        case 'IMPORT_CANCELLED':
          return; // benign — the user dismissed the picker (E7)
        case 'STORAGE_CORRUPT':
        case 'STORE_VERSION_UNSUPPORTED':
          notices.push({
            severity: 'error',
            message: "Your saved library couldn't be read.",
            action: { label: 'Reset library', run: resetLibrary },
          });
          return;
        case 'INVALID_PRESET':
          notices.push({ severity: 'error', message: `That preset isn't valid — ${issuesList(e.issues)}` });
          return;
        case 'QUOTA_EXCEEDED':
          notices.push({ severity: 'error', message: "Storage is full — couldn't save. Try exporting instead." });
          return;
        case 'STORAGE_UNAVAILABLE':
          notices.push({ severity: 'error', message: "Can't access storage — your presets won't be saved." });
          return;
        case 'DOM_UNAVAILABLE':
          notices.push({ severity: 'error', message: 'This action needs a browser environment.' });
          return;
        case 'IMPORT_TOO_LARGE':
          notices.push({ severity: 'error', message: 'That file is too large to import.' });
          return;
        case 'IMPORT_READ_FAILED':
          notices.push({ severity: 'error', message: "Couldn't read that file." });
          return;
        default:
          notices.push({ severity: 'error', message: e.message || 'Something went wrong.' });
          return;
      }
    }
    notices.push({ severity: 'error', message: e instanceof Error ? e.message : String(e) });
  }

  function open(id: string): void {
    if (session.dirty && !confirmDiscard()) return;
    let saved;
    try {
      saved = loadPreset(id);
    } catch (e) {
      handleError(e);
      return;
    }
    if (saved === null) {
      notices.push({ severity: 'info', message: 'That preset is no longer in your library.' });
      refresh();
      return;
    }
    session.reset(saved.preset, saved.id);
    if (saved.warnings.length > 0) {
      notices.push({ severity: 'info', message: `Loaded with notes — ${issuesList(saved.warnings)}` });
    }
  }

  function saveCurrent(): void {
    try {
      const saved = savePreset(session.preset, session.selectedId ?? undefined);
      session.markSaved(saved.id);
      refresh();
    } catch (e) {
      handleError(e);
    }
  }

  function saveAsNew(): void {
    try {
      const saved = savePreset(session.preset);
      session.markSaved(saved.id);
      refresh();
    } catch (e) {
      handleError(e);
    }
  }

  function remove(id: string): void {
    if (!confirmDelete()) return;
    try {
      deletePreset(id);
      if (session.selectedId === id) session.clearSelection();
      refresh();
    } catch (e) {
      handleError(e);
    }
  }

  function exportCurrent(): void {
    // Called directly inside the click handler (download policy) — no await before it.
    try {
      const filename = exportPreset(session.preset);
      notices.push({ severity: 'info', message: `Exported ${filename}` });
    } catch (e) {
      handleError(e);
    }
  }

  function importFromFile(): Promise<boolean> {
    // importPresetFromFile() opens the picker synchronously (gesture-safe) and resolves
    // after the user chooses a file. On success we save it straight into the library and
    // adopt it as the selected, clean working preset — so the user lands in the editor
    // ready to shape it, with no separate Save step. We save BEFORE reset(), so a failed
    // save (e.g. QUOTA_EXCEEDED) leaves the current working preset untouched. Resolves true
    // only when an import was saved (the caller navigates on true), false on cancel/error.
    loading = true;
    return importPresetFromFile()
      .then((imported) => {
        const savedRec = savePreset(imported.preset);
        session.reset(imported.preset, savedRec.id);
        refresh();
        notices.push({ severity: 'info', message: `Added "${imported.preset.name}" to your library.` });
        if (imported.migratedFrom !== null) {
          notices.push({ severity: 'info', message: `Upgraded from schema v${imported.migratedFrom}` });
        }
        if (imported.warnings.length > 0) {
          notices.push({ severity: 'info', message: `Imported with notes — ${issuesList(imported.warnings)}` });
        }
        return true;
      })
      .catch((e) => {
        handleError(e);
        return false;
      })
      .finally(() => {
        loading = false;
      });
  }

  return {
    get items() {
      return items;
    },
    get loading() {
      return loading;
    },
    refresh,
    seed() {
      try {
        seedDefaultPresets(); // idempotent (persistence guards the seeded flag)
      } catch (e) {
        handleError(e);
      }
    },
    restoreDefaults() {
      // Non-destructive top-up: append any missing built-ins, never touching the user's
      // own presets. Idempotent (an all-present library adds nothing).
      try {
        const added = restoreDefaultPresets();
        refresh();
        notices.push(
          added.length > 0
            ? { severity: 'info', message: `Restored ${added.length} default preset(s)` }
            : { severity: 'info', message: 'Your library already has all default presets' },
        );
      } catch (e) {
        handleError(e);
      }
    },
    open,
    saveCurrent,
    saveAsNew,
    remove,
    exportCurrent,
    importFromFile,
  };
}

// ---------------------------------------------------------------------------
// Install store
// ---------------------------------------------------------------------------

export interface InstallStore {
  readonly canInstall: boolean;
  readonly isStandalone: boolean;
  readonly isIos: boolean;
  readonly updateReady: boolean;
  readonly offlineReady: boolean;

  promptInstall(): void;
  applyUpdate(): void;
  dismissUpdate(): void;
}

/** registerSW callbacks main.ts forwards into the store (vite-plugin-pwa prompt mode). */
export interface SwUpdateHooks {
  onNeedRefresh: () => void;
  onOfflineReady: () => void;
}

/** The Android/Chromium beforeinstallprompt event (not in lib.dom). */
interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  readonly userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

/** registerSW's returned updater: updateServiceWorker(reloadPage?). */
type UpdateSW = (reloadPage?: boolean) => Promise<void>;

/** The bundle createInstallStore returns: the public store, the SW hooks bootstrap
 *  forwards to registerSW, and setUpdateSW (bootstrap feeds back registerSW's return so
 *  applyUpdate can reload via updateServiceWorker(true) — the §6 contract is a superset). */
export interface InstallStoreBundle {
  store: InstallStore;
  hooks: SwUpdateHooks;
  setUpdateSW(fn: UpdateSW): void;
}

function detectStandalone(): boolean {
  if (typeof window === 'undefined') return false;
  const displayMode = typeof window.matchMedia === 'function' && window.matchMedia('(display-mode: standalone)').matches;
  const iosStandalone =
    typeof navigator !== 'undefined' && (navigator as Navigator & { standalone?: boolean }).standalone === true;
  return Boolean(displayMode || iosStandalone);
}

function detectIos(standalone: boolean): boolean {
  if (typeof navigator === 'undefined') return false;
  const isIosUa = /iphone|ipad|ipod/i.test(navigator.userAgent || '');
  return isIosUa && !standalone;
}

export function createInstallStore(): InstallStoreBundle {
  const standalone = detectStandalone();
  const ios = detectIos(standalone);

  let canInstall = $state(false);
  let updateReady = $state(false);
  let offlineReady = $state(false);

  let deferred: BeforeInstallPromptEvent | undefined;
  let updateSW: UpdateSW | undefined;

  if (typeof window !== 'undefined') {
    window.addEventListener('beforeinstallprompt', (ev) => {
      ev.preventDefault(); // suppress the mini-infobar; we present our own button
      if (standalone) return;
      deferred = ev as BeforeInstallPromptEvent;
      canInstall = true;
    });
    window.addEventListener('appinstalled', () => {
      deferred = undefined;
      canInstall = false;
    });
  }

  const store: InstallStore = {
    get canInstall() {
      return canInstall;
    },
    get isStandalone() {
      return standalone;
    },
    get isIos() {
      return ios;
    },
    get updateReady() {
      return updateReady;
    },
    get offlineReady() {
      return offlineReady;
    },
    promptInstall() {
      const e = deferred;
      if (!e) return;
      deferred = undefined; // single-use (H4)
      canInstall = false;
      e.prompt(); // gesture: call directly, no await before it
      void e.userChoice.catch(() => {});
    },
    applyUpdate() {
      // The ONLY reload path, and only on an explicit click (D-017). Never auto-reload.
      if (updateSW) void updateSW(true);
      updateReady = false;
    },
    dismissUpdate() {
      updateReady = false;
    },
  };

  return {
    store,
    hooks: {
      onNeedRefresh() {
        updateReady = true;
      },
      onOfflineReady() {
        offlineReady = true;
      },
    },
    setUpdateSW(fn: UpdateSW) {
      updateSW = fn;
    },
  };
}

// ---------------------------------------------------------------------------
// Clip store (Phase-2) — co-located with LibraryStore (design §16.2, interfaces §13)
// ---------------------------------------------------------------------------

export interface ClipStore {
  readonly clips: ReadonlyArray<Clip>; // list() metadata, newest first
  readonly loading: boolean;
  readonly totalBytes: number; // from clip-library.totalBytes()
  readonly mode: ClipPanelMode; // 'pick' when choosing a layer source
  readonly importing: boolean;

  /** list() + totalBytes() → $state. UNSUPPORTED → notice (degrade read-disabled). */
  refresh(): void;
  /** Import a picked file (gesture): importVia(createFileImportAdapter(), file). A dedup
   *  hit toasts "already in your library" (same clip.id, no second copy). Maps
   *  ClipLibraryErrorCode → notice (DECODE_FAILED / QUOTA_EXCEEDED / UNSUPPORTED). */
  importFile(file: File): void;
  /** Delete (confirm): a courtesy "used by N presets" scan first, then remove(id). */
  removeClip(id: string): void;

  // pick-mode flow (driven by the layer source picker, §17.2):
  openPicker(onPick: (clipId: string) => void): void; // mode='pick'
  pick(id: string): void; // returns clip.id, closes picker
  closePicker(): void; // mode='browse'
}

/** Injection seams so the ClipStore stays unit-testable without IndexedDB. Default to the
 *  live clip-library module functions. */
export interface ClipLibraryDeps {
  list: typeof defaultListClips;
  totalBytes: typeof defaultTotalBytes;
  remove: typeof defaultRemoveClip;
  importVia: typeof defaultImportVia;
  createFileImportAdapter: typeof defaultCreateFileImportAdapter;
  /** Scan saved presets for layers referencing a clipId (courtesy "used by N presets", M3).
   *  Returns the number of saved presets referencing the id. Best-effort; never throws. */
  countPresetsUsingClip?: (clipId: string) => number;
}

function defaultCountPresetsUsingClip(clipId: string): number {
  try {
    const summaries = listPresets();
    let count = 0;
    for (const summary of summaries) {
      const saved = loadPreset(summary.id);
      const layers = saved?.preset.layers ?? [];
      if (layers.some((l) => 'clipId' in l.source && l.source.clipId === clipId)) count++;
    }
    return count;
  } catch {
    return 0; // a faulty scan must never block a delete (it is only a courtesy)
  }
}

function confirmDeleteClip(usedBy: number): boolean {
  const note = usedBy > 0 ? ` It's used by ${usedBy} saved preset${usedBy === 1 ? '' : 's'}.` : '';
  if (typeof window === 'undefined' || typeof window.confirm !== 'function') return true;
  return window.confirm(`Delete this clip?${note} This cannot be undone.`);
}

export function createClipStore(deps: { notices: NoticeStore; clipLib?: Partial<ClipLibraryDeps> }): ClipStore {
  const { notices } = deps;
  const lib: ClipLibraryDeps = {
    list: deps.clipLib?.list ?? defaultListClips,
    totalBytes: deps.clipLib?.totalBytes ?? defaultTotalBytes,
    remove: deps.clipLib?.remove ?? defaultRemoveClip,
    importVia: deps.clipLib?.importVia ?? defaultImportVia,
    createFileImportAdapter: deps.clipLib?.createFileImportAdapter ?? defaultCreateFileImportAdapter,
    countPresetsUsingClip: deps.clipLib?.countPresetsUsingClip ?? defaultCountPresetsUsingClip,
  };

  let clips = $state<Clip[]>([]);
  let loading = $state(false);
  let total = $state(0);
  let mode = $state<ClipPanelMode>('browse');
  let importing = $state(false);
  let onPickCb: ((clipId: string) => void) | undefined;

  function handleClipError(e: unknown): void {
    if (e instanceof ClipLibraryError) {
      switch (e.code) {
        case 'DECODE_FAILED':
          notices.push({ severity: 'error', message: "Couldn't read that as audio." });
          return;
        case 'QUOTA_EXCEEDED':
          notices.push({ severity: 'error', message: 'Storage is full — delete some clips to free space.' });
          return;
        case 'UNSUPPORTED':
          notices.push({ severity: 'error', message: "Clip storage isn't available here." });
          return;
        default:
          notices.push({ severity: 'error', message: e.message || 'Clip storage error.' });
          return;
      }
    }
    notices.push({ severity: 'error', message: e instanceof Error ? e.message : String(e) });
  }

  function refresh(): void {
    loading = true;
    Promise.all([lib.list(), lib.totalBytes()])
      .then(([list, bytes]) => {
        // list() order is unspecified; show newest first by createdAt.
        clips = [...list].sort((a, b) => b.createdAt - a.createdAt);
        total = bytes;
      })
      .catch(handleClipError)
      .finally(() => {
        loading = false;
      });
  }

  function importFile(file: File): void {
    // Gesture: importVia is called with NO await before it (the file-picker policy, M8).
    importing = true;
    const known = new Set(clips.map((c) => c.id));
    lib
      .importVia(lib.createFileImportAdapter(), file)
      .then((clip) => {
        if (known.has(clip.id)) {
          // Dedup hit: the SAME id came back (content hash). Don't store a second copy — just
          // surface it and, in pick mode, select it (M5).
          notices.push({ severity: 'info', message: `"${clip.meta.name}" is already in your library.` });
        } else {
          notices.push({ severity: 'info', message: `Imported "${clip.meta.name}".` });
        }
        refresh();
        if (mode === 'pick' && onPickCb) {
          const cb = onPickCb;
          onPickCb = undefined;
          mode = 'browse';
          cb(clip.id);
        }
      })
      .catch(handleClipError)
      .finally(() => {
        importing = false;
      });
  }

  function removeClip(id: string): void {
    const usedBy = lib.countPresetsUsingClip ? lib.countPresetsUsingClip(id) : 0;
    if (!confirmDeleteClip(usedBy)) return;
    lib
      .remove(id)
      .then(() => {
        // remove(false) = unknown/already-gone id (M4) — treat as removed, no error.
        refresh();
      })
      .catch(handleClipError);
  }

  return {
    get clips() {
      return clips;
    },
    get loading() {
      return loading;
    },
    get totalBytes() {
      return total;
    },
    get mode() {
      return mode;
    },
    get importing() {
      return importing;
    },
    refresh,
    importFile,
    removeClip,
    openPicker(onPick: (clipId: string) => void) {
      onPickCb = onPick;
      mode = 'pick';
    },
    pick(id: string) {
      const cb = onPickCb;
      onPickCb = undefined;
      mode = 'browse';
      cb?.(id);
    },
    closePicker() {
      onPickCb = undefined;
      mode = 'browse';
    },
  };
}
