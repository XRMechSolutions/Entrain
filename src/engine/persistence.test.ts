import * as sessionModel from './session-model';
import {
  STORAGE_KEY,
  STORE_VERSION,
  MAX_IMPORT_BYTES,
  EXPORT_MIME,
  EXPORT_EXTENSION,
  PersistenceError,
  listPresets,
  loadPreset,
  savePreset,
  deletePreset,
  clearLibrary,
  seedDefaultPresets,
  restoreDefaultPresets,
  buildDefaultLibraryPresets,
  presetToJson,
  presetToBlob,
  exportPreset,
  toSafeFilename,
  parsePresetJson,
  importPresetFile,
  importPresetFromFile,
} from './persistence';
import type { Preset, ValidationIssue } from './session-model';

// --- helpers ---------------------------------------------------------------

function mkPreset(over: Partial<Preset> = {}): Preset {
  return {
    schemaVersion: 6,
    name: 'My Session',
    durationSec: 300,
    masterGain: 0.8,
    nodes: [{ t: 0, carrier: { value: 200 }, beat: { value: 8 }, volume: { value: 1 } }],
    ...over,
  };
}

/**
 * A fully-valid v4 preset carrying `layers`: a synth tone cue, a looping ambiance
 * CLIP layer (`source: { clipId }`), and a voice CLIP layer carrying a `duck` intent.
 * This is the clip-bearing fixture the Phase-2 round-trip is proven against — the clip
 * BYTES are out of scope (JSON is reference-only per D-037); only the `clipId` references
 * travel through serialize/parse.
 */
function layeredFixture(over: Partial<Preset> = {}): Preset {
  return {
    schemaVersion: 6,
    name: 'Guided Drift',
    durationSec: 1800,
    masterGain: 0.8,
    nodes: [{ t: 0, carrier: { value: 200 }, beat: { value: 8 }, volume: { value: 1 } }],
    layers: [
      {
        id: 'open-bell',
        kind: 'tone',
        t: 0,
        source: { synth: { shape: 'sine', freqHz: 528, attackSec: 0.005, releaseSec: 3 } },
      },
      {
        id: 'rain',
        kind: 'ambiance',
        t: 0,
        loop: true,
        source: { clipId: 'clip_rain01' },
        gain: [
          { t: 0, value: 0 },
          { t: 8, value: 0.4 },
        ],
      },
      {
        id: 'guide',
        kind: 'voice',
        t: 60,
        source: { clipId: 'clip_breathe_es' },
        spatial: [
          { t: 0, value: -1, transition: 'linear' },
          { t: 6, value: 1 },
        ],
        duck: { toGain: 0.3, attackSec: 0.4, releaseSec: 1.5 },
      },
    ],
    ...over,
  };
}

/** The canonical normalized form of `layeredFixture()` (session-model key order). */
function normalizedLayeredPreset(): Preset {
  const res = sessionModel.validate(layeredFixture());
  if (!res.ok) throw new Error('layeredFixture must be valid');
  return res.preset;
}

/** Run fn, returning the PersistenceError it throws (fails if it does not throw). */
function caught(fn: () => unknown): PersistenceError {
  try {
    fn();
  } catch (e) {
    return e as PersistenceError;
  }
  throw new Error('expected the call to throw');
}

/** Await a promise, returning the PersistenceError it rejects with (fails if it resolves). */
async function caughtAsync(p: Promise<unknown>): Promise<PersistenceError> {
  try {
    await p;
  } catch (e) {
    return e as PersistenceError;
  }
  throw new Error('expected the promise to reject');
}

/** Construct a real DOMException; optionally shadow its read-only `code` for the test. */
function domEx(opts: { name?: string; code?: number } = {}): DOMException {
  const e = new DOMException('boom', opts.name ?? 'AbortError');
  if (opts.code !== undefined) {
    Object.defineProperty(e, 'code', { value: opts.code, configurable: true });
  }
  return e;
}

function fakeFile(opts: { size?: number; name?: string; text: () => Promise<string> }): File {
  return {
    size: opts.size ?? 256,
    name: opts.name ?? 'preset.json',
    text: opts.text,
  } as unknown as File;
}

function setEnvelope(env: unknown): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(env));
}

function rawEnvelope(): unknown {
  const raw = localStorage.getItem(STORAGE_KEY);
  return raw === null ? null : JSON.parse(raw);
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  localStorage.clear();
});

// ===========================================================================
// Task 1 — foundation: constants, error type
// ===========================================================================

describe('constants', () => {
  it('have the exact documented values', () => {
    expect(STORAGE_KEY).toBe('binaural-audio.presetLibrary');
    expect(STORE_VERSION).toBe(1);
    expect(MAX_IMPORT_BYTES).toBe(1_048_576);
    expect(EXPORT_MIME).toBe('application/json');
    expect(EXPORT_EXTENSION).toBe('.json');
  });
});

describe('PersistenceError', () => {
  it('carries code + name and is an instanceof Error', () => {
    const e = new PersistenceError('STORAGE_UNAVAILABLE', 'localStorage is unavailable');
    expect(e).toBeInstanceOf(Error);
    expect(e).toBeInstanceOf(PersistenceError);
    expect(e.name).toBe('PersistenceError');
    expect(e.code).toBe('STORAGE_UNAVAILABLE');
    expect(e.message).toBe('localStorage is unavailable');
    expect(e.issues).toBeUndefined();
    expect(e.cause).toBeUndefined();
  });

  it('carries optional issues and cause', () => {
    const issues: ValidationIssue[] = [
      { code: 'NOT_OBJECT', severity: 'error', path: '', message: 'x' },
    ];
    const cause = new Error('underlying');
    const e = new PersistenceError('INVALID_PRESET', 'Invalid preset: 1 error(s)', { issues, cause });
    expect(e.code).toBe('INVALID_PRESET');
    expect(e.issues).toBe(issues);
    expect(e.cause).toBe(cause);
  });
});

// ===========================================================================
// Task 2 — storage-fault boundary: readLibrary / writeLibrary / clearLibrary / newId
// ===========================================================================

describe('storage-fault boundary', () => {
  it('A1: read access throwing surfaces STORAGE_UNAVAILABLE', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw domEx({ name: 'SecurityError' });
    });
    const e = caught(() => listPresets());
    expect(e.code).toBe('STORAGE_UNAVAILABLE');
    expect(e.cause).toBeInstanceOf(DOMException);
  });

  it('A3: null / empty / whitespace storage reads as a fresh empty library', () => {
    expect(listPresets()).toEqual([]);
    localStorage.setItem(STORAGE_KEY, '');
    expect(listPresets()).toEqual([]);
    localStorage.setItem(STORAGE_KEY, '   \n\t ');
    expect(listPresets()).toEqual([]);
  });

  it('B1: unparseable envelope JSON → STORAGE_CORRUPT and never wipes', () => {
    localStorage.setItem(STORAGE_KEY, '{ not json');
    const e = caught(() => listPresets());
    expect(e.code).toBe('STORAGE_CORRUPT');
    expect(localStorage.getItem(STORAGE_KEY)).toBe('{ not json');
  });

  it('B2: mis-shaped envelope (not object / records not array) → STORAGE_CORRUPT, not wiped', () => {
    localStorage.setItem(STORAGE_KEY, '[]');
    expect(caught(() => listPresets()).code).toBe('STORAGE_CORRUPT');
    setEnvelope({ storeVersion: 1, seeded: false, records: 'nope' });
    expect(caught(() => listPresets()).code).toBe('STORAGE_CORRUPT');
    expect(localStorage.getItem(STORAGE_KEY)).not.toBeNull();
  });

  it('B3: newer storeVersion (> 1) → STORE_VERSION_UNSUPPORTED', () => {
    setEnvelope({ storeVersion: 2, seeded: true, records: [] });
    expect(caught(() => listPresets()).code).toBe('STORE_VERSION_UNSUPPORTED');
  });

  it('B4: storeVersion < 1 or missing → STORE_VERSION_UNSUPPORTED (empty migration seam)', () => {
    setEnvelope({ storeVersion: 0, seeded: false, records: [] });
    expect(caught(() => listPresets()).code).toBe('STORE_VERSION_UNSUPPORTED');
    setEnvelope({ seeded: false, records: [] });
    expect(caught(() => listPresets()).code).toBe('STORE_VERSION_UNSUPPORTED');
  });

  it('A2: setItem quota variants → QUOTA_EXCEEDED, anything else → STORAGE_UNAVAILABLE', () => {
    const quotaVariants = [
      domEx({ name: 'QuotaExceededError' }),
      domEx({ name: 'NS_ERROR_DOM_QUOTA_REACHED' }),
      domEx({ name: 'WhateverError', code: 22 }),
      domEx({ name: 'WhateverError', code: 1014 }),
    ];
    for (const v of quotaVariants) {
      localStorage.clear();
      const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
        throw v;
      });
      expect(caught(() => savePreset(mkPreset())).code).toBe('QUOTA_EXCEEDED');
      spy.mockRestore();
    }
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('disk error');
    });
    expect(caught(() => savePreset(mkPreset())).code).toBe('STORAGE_UNAVAILABLE');
  });

  it('clearLibrary removes the key without parsing it (works even when corrupt)', () => {
    localStorage.setItem(STORAGE_KEY, '{ corrupt');
    expect(() => clearLibrary()).not.toThrow();
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it('clearLibrary surfaces STORAGE_UNAVAILABLE when removeItem throws', () => {
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => {
      throw domEx({ name: 'SecurityError' });
    });
    expect(caught(() => clearLibrary()).code).toBe('STORAGE_UNAVAILABLE');
  });

  it('F1: newId uses crypto.randomUUID when available', () => {
    const saved = savePreset(mkPreset());
    expect(saved.id).toMatch(UUID_RE);
  });

  it('F2: newId falls back to a v4 UUID built from getRandomValues', () => {
    const getRandomValues = vi.fn((a: Uint8Array) => {
      for (let i = 0; i < a.length; i++) a[i] = (i * 17 + 3) & 0xff;
      return a;
    });
    vi.stubGlobal('crypto', { getRandomValues });
    const saved = savePreset(mkPreset());
    expect(getRandomValues).toHaveBeenCalled();
    expect(saved.id).toMatch(UUID_RE);
  });

  it('F3: newId falls back to a p- id when no crypto exists', () => {
    vi.stubGlobal('crypto', undefined);
    const saved = savePreset(mkPreset());
    expect(saved.id).toMatch(/^p-[0-9a-z]+-[0-9a-z]+$/);
  });

  it('newId stays unique across many saves', () => {
    const ids = new Set<string>();
    for (let i = 0; i < 50; i++) ids.add(savePreset(mkPreset({ name: `n${i}` })).id);
    expect(ids.size).toBe(50);
  });
});

// ===========================================================================
// Task 3 — localStorage library CRUD
// ===========================================================================

describe('listPresets', () => {
  it('C1: skips a malformed record (warns) without deleting it, and sorts deterministically', () => {
    const good = mkPreset();
    setEnvelope({
      storeVersion: 1,
      seeded: true,
      records: [
        { id: 'a', createdAt: 100, updatedAt: 200, preset: good },
        { id: 'b', createdAt: 100, updatedAt: 300, preset: good },
        { id: 'c', createdAt: 150, updatedAt: 200, preset: good },
        { id: 'bad', createdAt: 1, updatedAt: 1, preset: 'not-an-object' },
        null,
      ],
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const list = listPresets();

    // updatedAt desc (b:300), tie at 200 broken by createdAt desc (c:150 before a:100).
    expect(list.map((s) => s.id)).toEqual(['b', 'c', 'a']);
    expect(list[0]).toMatchObject({ name: 'My Session', durationSec: 300, nodeCount: 1 });
    expect(warn).toHaveBeenCalled();

    // Non-destructive: the bad record is still present.
    const after = rawEnvelope() as { records: unknown[] };
    expect(after.records).toHaveLength(5);
  });
});

describe('loadPreset / deletePreset', () => {
  it('I1: unknown id → loadPreset null, deletePreset false', () => {
    expect(loadPreset('nope')).toBeNull();
    expect(deletePreset('nope')).toBe(false);
  });

  it('round-trips a saved preset', () => {
    const saved = savePreset(mkPreset({ name: 'Keep' }));
    const loaded = loadPreset(saved.id);
    expect(loaded?.preset.name).toBe('Keep');
    expect(loaded?.id).toBe(saved.id);
    expect(loaded?.warnings).toEqual([]);
  });

  it('deletePreset removes an existing record and returns true', () => {
    const a = savePreset(mkPreset());
    expect(deletePreset(a.id)).toBe(true);
    expect(loadPreset(a.id)).toBeNull();
  });

  it('C2: corrupt stored body → INVALID_PRESET with issues, record left intact', () => {
    setEnvelope({
      storeVersion: 1,
      seeded: true,
      records: [
        {
          id: 'x',
          createdAt: 1,
          updatedAt: 1,
          preset: { schemaVersion: 6, name: '', durationSec: 300, masterGain: 0.8, nodes: [{ t: 0, carrier: { value: 200 } }] },
        },
      ],
    });
    const e = caught(() => loadPreset('x'));
    expect(e.code).toBe('INVALID_PRESET');
    expect(e.issues && e.issues.length).toBeGreaterThan(0);
    expect((rawEnvelope() as { records: unknown[] }).records).toHaveLength(1);
  });

  it('C4: future schemaVersion body → INVALID_PRESET (SCHEMA_TOO_NEW), record intact', () => {
    setEnvelope({
      storeVersion: 1,
      seeded: true,
      records: [
        {
          id: 'f',
          createdAt: 1,
          updatedAt: 1,
          preset: { schemaVersion: 7, name: 'Future', durationSec: 300, masterGain: 0.8, nodes: [{ t: 0, carrier: { value: 200 } }] },
        },
      ],
    });
    const e = caught(() => loadPreset('f'));
    expect(e.code).toBe('INVALID_PRESET');
    expect(e.issues?.some((i) => i.code === 'SCHEMA_TOO_NEW')).toBe(true);
    expect((rawEnvelope() as { records: unknown[] }).records).toHaveLength(1);
  });

  it('C3: older-schema body self-heals — migrates, writes back, preserves timestamps', () => {
    const saved = savePreset(mkPreset({ name: 'Old' }));
    const migrated = mkPreset({ name: 'Upgraded' });
    vi.spyOn(sessionModel, 'parse').mockReturnValue({
      ok: true,
      preset: migrated,
      issues: [],
      migratedFrom: 1,
    });

    const loaded = loadPreset(saved.id);
    expect(loaded?.preset.name).toBe('Upgraded');
    expect(loaded?.createdAt).toBe(saved.createdAt);
    expect(loaded?.updatedAt).toBe(saved.updatedAt);

    // The upgraded body was written back in place (read again with the real parser).
    vi.restoreAllMocks();
    expect(loadPreset(saved.id)?.preset.name).toBe('Upgraded');
  });

  it('C3: still returns the migrated preset when the heal write-back throws', () => {
    const saved = savePreset(mkPreset({ name: 'Old' }));
    const migrated = mkPreset({ name: 'Upgraded' });
    vi.spyOn(sessionModel, 'parse').mockReturnValue({
      ok: true,
      preset: migrated,
      issues: [],
      migratedFrom: 1,
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw domEx({ name: 'QuotaExceededError' });
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const loaded = loadPreset(saved.id);
    expect(loaded?.preset.name).toBe('Upgraded');
    expect(warn).toHaveBeenCalled();
  });
});

describe('savePreset', () => {
  it('validates first: an invalid preset → INVALID_PRESET and writes nothing', () => {
    const e = caught(() => savePreset(mkPreset({ name: '' })));
    expect(e.code).toBe('INVALID_PRESET');
    expect(e.issues && e.issues.length).toBeGreaterThan(0);
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it('I2: create / overwrite / save-with-unknown-id semantics + normalized clone', () => {
    const nowSpy = vi.spyOn(Date, 'now');

    nowSpy.mockReturnValue(1000);
    const a = savePreset(mkPreset({ name: 'A' }));
    expect(a.createdAt).toBe(1000);
    expect(a.updatedAt).toBe(1000);

    nowSpy.mockReturnValue(2000);
    const a2 = savePreset(mkPreset({ name: 'A edited' }), a.id);
    expect(a2.id).toBe(a.id); // same record
    expect(a2.createdAt).toBe(1000); // createdAt kept
    expect(a2.updatedAt).toBe(2000); // updatedAt bumped
    expect(listPresets()).toHaveLength(1);

    nowSpy.mockReturnValue(3000);
    const withId = savePreset(mkPreset({ name: 'restored' }), 'restore-me');
    expect(withId.id).toBe('restore-me');
    expect(withId.createdAt).toBe(3000);
    expect(loadPreset('restore-me')?.preset.name).toBe('restored');

    // Stores the normalized clone: an unknown field is dropped (and warned).
    const dirty = { ...mkPreset({ name: 'Dirty' }), bogus: 123 };
    const d = savePreset(dirty);
    expect((d.preset as unknown as Record<string, unknown>).bogus).toBeUndefined();
    expect(d.warnings.some((w) => w.code === 'UNKNOWN_FIELD')).toBe(true);
  });

  it('D6: no name-uniqueness enforcement — same-name saves are distinct records', () => {
    const a = savePreset(mkPreset({ name: 'Same' }));
    const b = savePreset(mkPreset({ name: 'Same' }));
    expect(a.id).not.toBe(b.id);
    expect(listPresets()).toHaveLength(2);
  });

  it('propagates QUOTA_EXCEEDED from the write', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw domEx({ name: 'QuotaExceededError' });
    });
    expect(caught(() => savePreset(mkPreset())).code).toBe('QUOTA_EXCEEDED');
  });
});

// ===========================================================================
// Task 4 — default-preset seeding
// ===========================================================================

describe('default presets', () => {
  it('every built-in passes session-model.validate with the documented invariants', () => {
    const defs = buildDefaultLibraryPresets();
    expect(defs).toHaveLength(16);

    for (const p of defs) {
      const res = sessionModel.validate(p);
      expect(res.ok).toBe(true);
      expect(p.schemaVersion).toBe(6);
      expect(p.masterGain).toBeGreaterThan(0);
      expect(p.masterGain).toBeLessThanOrEqual(1);
      expect(p.nodes[0].t).toBe(0); // carrier at the start node, t === 0
      expect(p.nodes[0].carrier).toBeDefined();

      const ts = p.nodes.map((n) => n.t);
      expect(ts).toEqual([...ts].sort((x, y) => x - y)); // sorted
      expect(new Set(ts).size).toBe(ts.length); // unique
    }

    // No EXP_RAMP_THROUGH_ZERO anywhere; preset-4 raises no MOD_EDGE warning.
    for (const p of defs) {
      const res = sessionModel.validate(p);
      if (res.ok) {
        expect(res.issues.some((i) => i.code === 'EXP_RAMP_THROUGH_ZERO')).toBe(false);
      }
    }
    const p4 = sessionModel.validate(defs[3]);
    if (p4.ok) {
      expect(p4.issues.some((i) => i.code === 'MOD_EDGE_EXCEEDS_HALF_PERIOD')).toBe(false);
    }
  });

  it('I3: seed on a fresh library adds the built-ins and returns their summaries; second call is []', () => {
    const added = seedDefaultPresets();
    expect(added).toHaveLength(16);
    // The original four band/use starters seed first, in order.
    expect(added.slice(0, 4).map((s) => s.name)).toEqual([
      'Relax — Alpha 10 Hz',
      'Meditate — Theta 6 Hz',
      'Sleep Descent — Delta',
      'Isochronic Focus — 10 Hz pulse',
    ]);
    // Then the power naps.
    const names = added.map((s) => s.name);
    expect(names.some((n) => n.startsWith('Power Nap — 20'))).toBe(true);
    expect(names.some((n) => n.startsWith('Power Nap — 60'))).toBe(true);
    for (const s of added) expect(s.id).toMatch(UUID_RE);
    expect(listPresets()).toHaveLength(16);

    expect(seedDefaultPresets()).toEqual([]);
    expect(listPresets()).toHaveLength(16);
  });

  it('I4: deleting all defaults then re-seeding stays empty (seeded gate)', () => {
    seedDefaultPresets();
    for (const s of listPresets()) deletePreset(s.id);
    expect(listPresets()).toHaveLength(0);
    expect(seedDefaultPresets()).toEqual([]);
    expect(listPresets()).toHaveLength(0);
  });

  it('clearLibrary then seedDefaultPresets re-seeds (factory reset)', () => {
    seedDefaultPresets();
    clearLibrary();
    expect(seedDefaultPresets()).toHaveLength(16);
    expect(listPresets()).toHaveLength(16);
  });
});

// ===========================================================================
// Task 4b — non-destructive top-up: restoreDefaultPresets
// ===========================================================================

describe('restoreDefaultPresets (non-destructive top-up)', () => {
  const DEFAULT_NAMES = buildDefaultLibraryPresets().map((p) => p.name);

  it('R1: a FRESH library gains all 16 built-ins and they are returned, in order', () => {
    const added = restoreDefaultPresets();
    expect(added).toHaveLength(16);
    expect(added.map((s) => s.name)).toEqual(DEFAULT_NAMES); // same order as buildDefaultLibraryPresets
    for (const s of added) expect(s.id).toMatch(UUID_RE);

    const list = listPresets();
    expect(list).toHaveLength(16);
    // Every returned id is actually present in the library.
    const presentIds = new Set(list.map((s) => s.id));
    for (const s of added) expect(presentIds.has(s.id)).toBe(true);

    // Restore ignores (and sets) the seeded flag — so seedDefaultPresets is now a no-op.
    expect((rawEnvelope() as { seeded: boolean }).seeded).toBe(true);
    expect(seedDefaultPresets()).toEqual([]);
  });

  it('R2: a PARTIAL library gains ONLY the missing defaults; every existing record is byte-identical', () => {
    // Pre-seed a few defaults (first three) + one user preset, all with FIXED ids/timestamps.
    const defs = buildDefaultLibraryPresets();
    const preExisting = [
      { id: 'def-0', createdAt: 11, updatedAt: 12, preset: defs[0] },
      { id: 'def-1', createdAt: 13, updatedAt: 14, preset: defs[1] },
      { id: 'def-2', createdAt: 15, updatedAt: 16, preset: defs[2] },
      { id: 'user-1', createdAt: 17, updatedAt: 18, preset: mkPreset({ name: 'My Own Mix' }) },
    ];
    setEnvelope({ storeVersion: 1, seeded: true, records: preExisting });
    const before = rawEnvelope() as { records: Array<{ id: string }> };
    const beforeById = new Map(before.records.map((r) => [r.id, JSON.stringify(r)]));

    const added = restoreDefaultPresets();

    // Only the defaults NOT already present were added (16 total - 3 pre-seeded).
    expect(added).toHaveLength(13);
    const addedNames = added.map((s) => s.name);
    expect(addedNames).not.toContain(defs[0].name);
    expect(addedNames).not.toContain(defs[1].name);
    expect(addedNames).not.toContain(defs[2].name);
    expect(addedNames).not.toContain('My Own Mix'); // the user preset was never a default

    // Every pre-existing record is untouched — same id, timestamps, and body bytes.
    const after = rawEnvelope() as { records: Array<{ id: string }> };
    for (const [id, json] of beforeById) {
      const stillThere = after.records.find((r) => r.id === id);
      expect(stillThere).toBeDefined();
      expect(JSON.stringify(stillThere)).toBe(json); // byte-identical
    }

    // Total = 4 pre-existing + 13 appended = 17, with the user preset still present once.
    expect(after.records).toHaveLength(17);
    expect(after.records.filter((r) => r.id === 'user-1')).toHaveLength(1);
    // No default name appears twice (no duplicates created).
    const allNames = listPresets().map((s) => s.name);
    for (const name of DEFAULT_NAMES) {
      expect(allNames.filter((n) => n === name)).toHaveLength(1);
    }
  });

  it('R3: IDEMPOTENT — a second call returns [] and does not rewrite storage', () => {
    restoreDefaultPresets();
    const snapshot = localStorage.getItem(STORAGE_KEY);

    // Guard: an idempotent (no-op) call must not call setItem at all.
    const setSpy = vi.spyOn(Storage.prototype, 'setItem');
    expect(restoreDefaultPresets()).toEqual([]);
    expect(setSpy).not.toHaveBeenCalled();
    expect(localStorage.getItem(STORAGE_KEY)).toBe(snapshot); // unchanged bytes
    expect(listPresets()).toHaveLength(16);
  });

  it('R4: after deleting two defaults, restore re-adds EXACTLY those two', () => {
    restoreDefaultPresets();
    const list = listPresets();
    // Delete two specific defaults by id.
    const victims = [list[0], list[1]];
    for (const v of victims) deletePreset(v.id);
    expect(listPresets()).toHaveLength(14);

    const added = restoreDefaultPresets();
    expect(added).toHaveLength(2);
    expect(new Set(added.map((s) => s.name))).toEqual(new Set(victims.map((v) => v.name)));
    expect(listPresets()).toHaveLength(16);

    // And it's idempotent again.
    expect(restoreDefaultPresets()).toEqual([]);
  });

  it('R5: a storage WRITE fault propagates the matching PersistenceError code', () => {
    // Quota on the top-up write → QUOTA_EXCEEDED (mirrors the other writers).
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw domEx({ name: 'QuotaExceededError' });
    });
    expect(caught(() => restoreDefaultPresets()).code).toBe('QUOTA_EXCEEDED');
  });

  it('R5: a storage READ fault propagates STORAGE_UNAVAILABLE', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw domEx({ name: 'SecurityError' });
    });
    expect(caught(() => restoreDefaultPresets()).code).toBe('STORAGE_UNAVAILABLE');
  });
});

// ===========================================================================
// Task 5 — export pipeline
// ===========================================================================

describe('presetToJson / toSafeFilename', () => {
  it('presetToJson returns validated, pretty, canonical JSON', () => {
    const json = presetToJson(mkPreset());
    expect(json).toContain('\n'); // pretty (2-space)
    expect(JSON.parse(json).name).toBe('My Session');
  });

  it('E1: presetToJson on an invalid preset → INVALID_PRESET with issues', () => {
    const e = caught(() => presetToJson(mkPreset({ masterGain: 5 })));
    expect(e.code).toBe('INVALID_PRESET');
    expect(e.issues && e.issues.length).toBeGreaterThan(0);
  });

  it('E2-E7: filename mapping', () => {
    expect(toSafeFilename('Deep/Sleep: v2')).toBe('Deep-Sleep- v2.json'); // E2
    expect(toSafeFilename('   ')).toBe('preset.json'); // E3
    expect(toSafeFilename('NUL')).toBe('_NUL.json'); // E4
    expect(toSafeFilename('com1')).toBe('_com1.json'); // E4 (case-insensitive)
    expect(toSafeFilename('a'.repeat(200))).toBe('a'.repeat(64) + '.json'); // E5
    expect(toSafeFilename('🌙 night')).toBe('🌙 night.json'); // E6
    expect(toSafeFilename('mix.json')).toBe('mix.json'); // E7
    expect(toSafeFilename('mix.JSON')).toBe('mix.JSON'); // E7
  });
});

describe('exportPreset / presetToBlob (DOM)', () => {
  let createObjectURL: ReturnType<typeof vi.fn>;
  let revokeObjectURL: ReturnType<typeof vi.fn>;
  let origCreate: typeof URL.createObjectURL;
  let origRevoke: typeof URL.revokeObjectURL;

  beforeEach(() => {
    origCreate = URL.createObjectURL;
    origRevoke = URL.revokeObjectURL;
    createObjectURL = vi.fn(() => 'blob:mock-url');
    revokeObjectURL = vi.fn();
    URL.createObjectURL = createObjectURL as unknown as typeof URL.createObjectURL;
    URL.revokeObjectURL = revokeObjectURL as unknown as typeof URL.revokeObjectURL;
  });

  afterEach(() => {
    URL.createObjectURL = origCreate;
    URL.revokeObjectURL = origRevoke;
  });

  it('presetToBlob returns an application/json Blob', () => {
    const blob = presetToBlob(mkPreset());
    expect(blob).toBeInstanceOf(Blob);
    expect(blob.type).toBe('application/json');
  });

  it('E9: presetToBlob without Blob → DOM_UNAVAILABLE', () => {
    vi.stubGlobal('Blob', undefined);
    expect(caught(() => presetToBlob(mkPreset())).code).toBe('DOM_UNAVAILABLE');
  });

  it('E11: exportPreset appends the anchor, clicks it in the DOM, then removes it', () => {
    vi.spyOn(HTMLElement.prototype, 'click').mockImplementation(function (this: HTMLElement) {
      const a = this as HTMLAnchorElement;
      expect(document.body.contains(a)).toBe(true);
      expect(a.download).toBe('My Session.json');
      expect(a.rel).toBe('noopener');
    });

    const name = exportPreset(mkPreset());
    expect(name).toBe('My Session.json');
    expect(createObjectURL).toHaveBeenCalledTimes(1);
    expect(document.querySelector('a[download]')).toBeNull(); // removed after click
  });

  it('E8: revokes the object URL on a 1000ms timer, not synchronously', () => {
    vi.useFakeTimers();
    vi.spyOn(HTMLElement.prototype, 'click').mockImplementation(() => undefined);

    exportPreset(mkPreset());
    expect(revokeObjectURL).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1000);
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:mock-url');
  });

  it('E1: exportPreset on an invalid preset → INVALID_PRESET and never writes a file', () => {
    vi.spyOn(HTMLElement.prototype, 'click').mockImplementation(() => undefined);
    const e = caught(() => exportPreset(mkPreset({ masterGain: 9 })));
    expect(e.code).toBe('INVALID_PRESET');
    expect(createObjectURL).not.toHaveBeenCalled();
  });

  it('uses opts.filename when provided', () => {
    vi.spyOn(HTMLElement.prototype, 'click').mockImplementation(() => undefined);
    expect(exportPreset(mkPreset(), { filename: 'My Mix' })).toBe('My Mix.json');
  });

  it('E9: exportPreset without Blob → DOM_UNAVAILABLE', () => {
    vi.stubGlobal('Blob', undefined);
    expect(caught(() => exportPreset(mkPreset())).code).toBe('DOM_UNAVAILABLE');
  });
});

// ===========================================================================
// Task 6 — import pipeline
// ===========================================================================

describe('parsePresetJson (pure)', () => {
  it('maps a valid preset to ok with empty warnings + null migratedFrom', () => {
    const res = parsePresetJson(JSON.stringify(mkPreset()));
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.preset.name).toBe('My Session');
      expect(res.migratedFrom).toBeNull();
      expect(res.warnings).toEqual([]);
    }
  });

  it('D4: strips a leading BOM before parsing', () => {
    const res = parsePresetJson('﻿' + JSON.stringify(mkPreset()));
    expect(res.ok).toBe(true);
  });

  it('D5: maps invalid input to { ok:false, issues } and never throws', () => {
    expect(() => parsePresetJson('﻿{ not json')).not.toThrow();
    expect(parsePresetJson('{ not json').ok).toBe(false);

    const nonObject = parsePresetJson('123');
    expect(nonObject.ok).toBe(false);
    if (!nonObject.ok) expect(nonObject.issues.some((i) => i.code === 'NOT_OBJECT')).toBe(true);
  });

  it('D5: surfaces an exp-ramp-through-zero as an upstream issue (no module-added rules)', () => {
    const expPreset = mkPreset({
      nodes: [
        { t: 0, carrier: { value: 200 }, volume: { value: 1, transition: 'exp' } },
        { t: 10, volume: { value: 0 } },
      ],
    });
    const res = parsePresetJson(JSON.stringify(expPreset));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.issues.some((i) => i.code === 'EXP_RAMP_THROUGH_ZERO')).toBe(true);
  });
});

describe('importPresetFile', () => {
  it('resolves an ImportedPreset and does NOT save', async () => {
    const file = fakeFile({ name: 'cool.json', text: async () => JSON.stringify(mkPreset()) });
    const imported = await importPresetFile(file);
    expect(imported.preset.name).toBe('My Session');
    expect(imported.filename).toBe('cool.json');
    expect(imported.migratedFrom).toBeNull();
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it('D2: oversize file rejects IMPORT_TOO_LARGE before reading bytes', async () => {
    const text = vi.fn(async () => '{}');
    const file = fakeFile({ size: MAX_IMPORT_BYTES + 1, text });
    await expect(importPresetFile(file)).rejects.toMatchObject({ code: 'IMPORT_TOO_LARGE' });
    expect(text).not.toHaveBeenCalled();
  });

  it('D3: a failed read rejects IMPORT_READ_FAILED with the cause attached', async () => {
    const cause = new Error('io failure');
    const file = fakeFile({
      text: async () => {
        throw cause;
      },
    });
    const err = await caughtAsync(importPresetFile(file));
    expect(err.code).toBe('IMPORT_READ_FAILED');
    expect(err.cause).toBe(cause);
  });

  it('D5: invalid contents reject INVALID_PRESET with issues', async () => {
    const file = fakeFile({ text: async () => '{"not":"a preset"}' });
    const err = await caughtAsync(importPresetFile(file));
    expect(err.code).toBe('INVALID_PRESET');
    expect(err.issues && err.issues.length).toBeGreaterThan(0);
  });

  it('D4: BOM-prefixed file contents import cleanly', async () => {
    const file = fakeFile({ text: async () => '﻿' + JSON.stringify(mkPreset()) });
    const imported = await importPresetFile(file);
    expect(imported.preset.name).toBe('My Session');
  });

  it('D7: non-fatal warnings are returned and unknown fields are dropped', async () => {
    const dirty = { ...mkPreset(), extra: 1 };
    const file = fakeFile({ text: async () => JSON.stringify(dirty) });
    const imported = await importPresetFile(file);
    expect(imported.warnings.some((w) => w.code === 'UNKNOWN_FIELD')).toBe(true);
    expect((imported.preset as unknown as Record<string, unknown>).extra).toBeUndefined();
  });
});

describe('importPresetFromFile (picker)', () => {
  it('D10: rejects DOM_UNAVAILABLE when there is no document', async () => {
    vi.stubGlobal('document', undefined);
    await expect(importPresetFromFile()).rejects.toMatchObject({ code: 'DOM_UNAVAILABLE' });
  });

  it('resolves the chosen file via the change event, then cleans up the input', async () => {
    vi.spyOn(HTMLElement.prototype, 'click').mockImplementation(() => undefined);
    const promise = importPresetFromFile();

    const input = document.body.querySelector('input[type=file]') as HTMLInputElement;
    expect(input).not.toBeNull();

    // jsdom's File does not implement Blob.text(), so use a duck-typed File for the
    // change→importPresetFile wiring (importPresetFile itself is covered above).
    const file = fakeFile({ name: 'picked.json', text: async () => JSON.stringify(mkPreset()) });
    Object.defineProperty(input, 'files', { value: [file], configurable: true });
    input.dispatchEvent(new Event('change'));

    const imported = await promise;
    expect(imported.filename).toBe('picked.json');
    expect(imported.preset.name).toBe('My Session');
    expect(document.body.querySelector('input[type=file]')).toBeNull();
  });

  it('D1: rejects IMPORT_CANCELLED on the cancel event (exactly once)', async () => {
    vi.spyOn(HTMLElement.prototype, 'click').mockImplementation(() => undefined);
    const promise = importPresetFromFile();
    const assertion = expect(promise).rejects.toMatchObject({ code: 'IMPORT_CANCELLED' });

    const input = document.body.querySelector('input[type=file]') as HTMLInputElement;
    input.dispatchEvent(new Event('cancel'));
    input.dispatchEvent(new Event('cancel')); // second settlement must be ignored

    await assertion;
    expect(document.body.querySelector('input[type=file]')).toBeNull();
  });

  it('D1: rejects IMPORT_CANCELLED via the focus fallback (~300ms)', async () => {
    vi.useFakeTimers();
    vi.spyOn(HTMLElement.prototype, 'click').mockImplementation(() => undefined);

    const settled = caughtAsync(importPresetFromFile()); // attaches the catch synchronously

    window.dispatchEvent(new Event('focus'));
    vi.advanceTimersByTime(300);

    const err = await settled;
    expect(err.code).toBe('IMPORT_CANCELLED');
  });
});

// ===========================================================================
// Phase 2 — clip-bearing (v4 layered) presets round-trip REFERENCE-ONLY
//
// A v4 Preset may carry `layers`, and a layer's `source` may be `{ clipId }` —
// a reference to an audio clip stored in IndexedDB by `clip-library`. Per D-037
// the JSON path is REFERENCE-ONLY: `clipId`s are serialized verbatim, but the clip
// BYTES never enter persistence (they live in IndexedDB, out of scope — D-025).
// These tests prove the round-trip is delivered by the UNCHANGED serializer (design
// §13.1): no new persistence.ts export, no changed signature — only the v4 schema
// owned by `session-model`. They exercise only the existing public surface.
// ===========================================================================

describe('v4 clip-bearing presets — reference-only round-trip', () => {
  it('savePreset → loadPreset preserves layers/clipId verbatim (deep-equal normalized body)', () => {
    const expected = normalizedLayeredPreset();

    const saved = savePreset(layeredFixture());
    const loaded = loadPreset(saved.id);

    // The whole normalized v4 body survives the localStorage round-trip, layers and all.
    expect(loaded?.preset).toEqual(expected);

    // The clip-source layers carry their clipId references unchanged (no clip bytes).
    expect(loaded?.preset.layers?.[1].source).toEqual({ clipId: 'clip_rain01' });
    expect(loaded?.preset.layers?.[2].source).toEqual({ clipId: 'clip_breathe_es' });
    // The synth-tone cue and the voice duck intent are preserved too.
    expect(loaded?.preset.layers?.[0].source).toEqual({
      synth: { shape: 'sine', freqHz: 528, attackSec: 0.005, releaseSec: 3 },
    });
    expect(loaded?.preset.layers?.[2].duck).toEqual({ toGain: 0.3, attackSec: 0.4, releaseSec: 1.5 });
  });

  it('presetToJson → parsePresetJson yields ok:true with identical layers/clipId', () => {
    const json = presetToJson(layeredFixture());
    const res = parsePresetJson(json);

    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.preset).toEqual(normalizedLayeredPreset());
      expect(res.migratedFrom).toBeNull();
      expect(res.preset.layers?.map((l) => l.source)).toEqual([
        { synth: { shape: 'sine', freqHz: 528, attackSec: 0.005, releaseSec: 3 } },
        { clipId: 'clip_rain01' },
        { clipId: 'clip_breathe_es' },
      ]);
    }
  });

  it('the stored envelope JSON is byte-stable across a save → load → save cycle (§3.2 canonical key order)', () => {
    // Freeze the clock so an overwrite re-save keeps the same updatedAt — this isolates the
    // PRESET BODY's byte-stability (the only thing the layers can affect) from the timestamp.
    vi.spyOn(Date, 'now').mockReturnValue(1000);

    const saved = savePreset(layeredFixture());
    const afterFirstSave = localStorage.getItem(STORAGE_KEY);

    // loadPreset re-runs the body through session-model.parse; an overwrite re-save must
    // re-serialize to the SAME bytes — no key-order drift, no field churn from the layers.
    const loaded = loadPreset(saved.id);
    expect(loaded).not.toBeNull();
    savePreset(loaded!.preset, saved.id);
    const afterReSave = localStorage.getItem(STORAGE_KEY);

    expect(afterReSave).toBe(afterFirstSave);
  });

  it('error: a v4 preset that fails session-model.validate → INVALID_PRESET, writes no record', () => {
    // A LAYER_* issue from the delegate: empty layer id. persistence adds no rules of its own.
    const bad = layeredFixture({
      layers: [{ id: '   ', kind: 'tone', t: 0, source: { clipId: 'c1' } }],
    } as Partial<Preset>);

    const e = caught(() => savePreset(bad));
    expect(e.code).toBe('INVALID_PRESET');
    expect(e.issues?.some((i) => i.code === 'LAYER_ID_EMPTY')).toBe(true);
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull(); // never wrote a record

    // The pure import core surfaces the SAME upstream issues as { ok:false, issues }.
    const res = parsePresetJson(JSON.stringify(bad));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.issues.some((i) => i.code === 'LAYER_ID_EMPTY')).toBe(true);
  });

  it('edge (D11): a clipId naming a clip absent on this device imports cleanly — dangling is structurally valid', async () => {
    // The clip bytes were never in the JSON; on a fresh device the clipId resolves to no
    // local clip. parse/import still succeed — persistence neither detects nor repairs the
    // dangling reference (that is the clip-library/layer-engine runtime case).
    const danglingJson = presetToJson(layeredFixture());

    const res = parsePresetJson(danglingJson);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.preset.layers?.[1].source).toEqual({ clipId: 'clip_rain01' });

    const file = fakeFile({ name: 'guided.json', text: async () => danglingJson });
    const imported = await importPresetFile(file);
    expect(imported.preset.layers?.[2].source).toEqual({ clipId: 'clip_breathe_es' });
    expect(imported.filename).toBe('guided.json');
    // Import does NOT save (the dangling reference is left for the UI/clip-library to resolve).
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it('edge (D12, §C3): a v3 (pre-layers) preset JSON migrates to v6 through the delegated path; loadPreset self-heals', () => {
    // A v3 body has no `layers`; session-model.parse up-migrates it to v6 and reports
    // migratedFrom. This is the SAME delegated migrate path layered presets use — no new branch.
    const v3 = {
      schemaVersion: 3,
      name: 'Legacy Mix',
      durationSec: 300,
      masterGain: 0.7,
      nodes: [{ t: 0, carrier: { value: 200 }, beat: { value: 8 }, volume: { value: 1 } }],
    };

    const res = parsePresetJson(JSON.stringify(v3));
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.migratedFrom).toBe(3);
      expect(res.preset.schemaVersion).toBe(6);
    }

    // Store the v3 body raw, then loadPreset self-heals it: migrates to v6 AND writes back.
    setEnvelope({
      storeVersion: 1,
      seeded: true,
      records: [{ id: 'legacy', createdAt: 11, updatedAt: 22, preset: v3 }],
    });
    const loaded = loadPreset('legacy');
    expect(loaded?.preset.schemaVersion).toBe(6);
    expect(loaded?.createdAt).toBe(11); // migration preserves timestamps (system action)
    expect(loaded?.updatedAt).toBe(22);

    // The upgraded v6 body was written back in place (read again — now no migration needed).
    const after = rawEnvelope() as { records: Array<{ preset: { schemaVersion: number } }> };
    expect(after.records[0].preset.schemaVersion).toBe(6);
  });

  it('edge: MAX_IMPORT_BYTES still guards the v4 JSON (a layered preset is a few KB)', async () => {
    const json = presetToJson(layeredFixture());
    // A real clip-bearing preset is comfortably under the 1 MiB cap.
    expect(json.length).toBeLessThan(MAX_IMPORT_BYTES);

    // The size guard fires before reading bytes, layered preset or not.
    const text = vi.fn(async () => json);
    const oversize = fakeFile({ size: MAX_IMPORT_BYTES + 1, name: 'big.json', text });
    await expect(importPresetFile(oversize)).rejects.toMatchObject({ code: 'IMPORT_TOO_LARGE' });
    expect(text).not.toHaveBeenCalled();
  });

  it('behavior: the round-trip uses ONLY the existing public surface (no new export, no changed signature)', () => {
    // savePreset/loadPreset/presetToJson/parsePresetJson/importPresetFile are the SAME
    // Phase-1 functions; a v4 layered preset is just a larger object to them (design §13.1).
    expect(typeof savePreset).toBe('function');
    expect(typeof loadPreset).toBe('function');
    expect(typeof presetToJson).toBe('function');
    expect(typeof parsePresetJson).toBe('function');
    expect(typeof importPresetFile).toBe('function');

    // The whole layered fixture survives every path identically — proof the unchanged
    // serializer delivers the round-trip.
    const saved = savePreset(layeredFixture());
    expect(loadPreset(saved.id)?.preset).toEqual(normalizedLayeredPreset());
    const reparsed = parsePresetJson(presetToJson(layeredFixture()));
    expect(reparsed.ok && reparsed.preset).toEqual(normalizedLayeredPreset());
  });
});

// ===========================================================================
// Phase-2 multi-voice (v6 `voices[]`) — round-trip + self-heal
//
// A v6 Preset may carry `voices: Voice[]` — additional INDEPENDENT generators
// (each its own carrier/beat `nodes`) summed at the master bus; absent = single
// voice (D-040). persistence ships NO serializer change: the round-trip is
// delivered by the UNCHANGED `normalizePreset`/`parse` path the moment
// session-model copies `voices` in `normalizeVoice`/`PRESET_KEYS`
// (multi-voice-architecture §1.4 — the make-or-break channel). These tests are
// that executable proof: if the `voices` copy were missed the feature would go
// inert with every OTHER test still green, and ONLY the round-trip/self-heal
// assertions below would fail.
// ===========================================================================

/**
 * A fully-valid v6 multi-voice preset: the primary binaural voice (top-level
 * `nodes`) plus two extra voices — an isochronic voice carrying a per-voice
 * `name`/`gain`, and a binaural voice with a second automation node. Carriers
 * (200 / 320 / 480 Hz) are ≥ ratio 1.25 apart, so no `VOICES_CARRIER_TOO_CLOSE`
 * advisory fires and the bundle stays a clean 3-of-4 voices.
 */
function multiVoiceFixture(over: Partial<Preset> = {}): Preset {
  return {
    schemaVersion: 6,
    name: 'Dual Carrier',
    durationSec: 300,
    masterGain: 0.8,
    nodes: [{ t: 0, carrier: { value: 200 }, beat: { value: 8 }, volume: { value: 1 } }],
    voices: [
      {
        id: 'iso',
        name: 'Iso Pulse',
        gain: 0.7,
        nodes: [{ t: 0, carrier: { value: 320 }, beat: { value: 0 }, volume: { value: 1 } }],
      },
      {
        id: 'beta',
        gain: 0.5,
        nodes: [
          { t: 0, carrier: { value: 480 }, beat: { value: 6 }, volume: { value: 1 } },
          { t: 120, beat: { value: 4 } },
        ],
      },
    ],
    ...over,
  };
}

/** The canonical normalized form of `multiVoiceFixture()` (session-model key order). */
function normalizedMultiVoice(): Preset {
  const res = sessionModel.validate(multiVoiceFixture());
  if (!res.ok) throw new Error('multiVoiceFixture must be valid');
  return res.preset;
}

describe('v6 multi-voice — round-trip + self-heal', () => {
  it('savePreset → loadPreset preserves voices verbatim (deep-equal normalized body)', () => {
    const expected = normalizedMultiVoice();

    const saved = savePreset(multiVoiceFixture());
    const loaded = loadPreset(saved.id);

    // The whole normalized v6 body survives localStorage — voices array and all.
    expect(loaded?.preset).toEqual(expected);

    // Both extra voices carry their full identity/gain/nodes through the round-trip.
    expect(loaded?.preset.voices).toHaveLength(2);
    expect(loaded?.preset.voices?.[0]).toMatchObject({ id: 'iso', name: 'Iso Pulse', gain: 0.7 });
    expect(loaded?.preset.voices?.[1]).toMatchObject({ id: 'beta', gain: 0.5 });
    expect(loaded?.preset.voices?.[1].nodes).toHaveLength(2);
    // The primary "voice 0" (top-level nodes) is unchanged alongside the extras.
    expect(loaded?.preset.nodes[0].carrier).toEqual({ value: 200 });
  });

  it('presetToJson → parsePresetJson yields ok:true with identical voices', () => {
    const json = presetToJson(multiVoiceFixture());
    const res = parsePresetJson(json);

    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.preset).toEqual(normalizedMultiVoice());
      expect(res.migratedFrom).toBeNull();
      // The per-voice carrier bases survive serialization unchanged.
      expect(res.preset.voices?.map((v) => v.nodes[0].carrier)).toEqual([
        { value: 320 },
        { value: 480 },
      ]);
    }
  });

  it('the stored envelope JSON is byte-stable across a save → load → save cycle', () => {
    // Freeze the clock so an overwrite re-save keeps the same updatedAt — this isolates the
    // PRESET BODY's byte-stability (the only thing the voices can affect) from the timestamp.
    vi.spyOn(Date, 'now').mockReturnValue(1000);

    const saved = savePreset(multiVoiceFixture());
    const afterFirstSave = localStorage.getItem(STORAGE_KEY);

    const loaded = loadPreset(saved.id);
    expect(loaded).not.toBeNull();
    savePreset(loaded!.preset, saved.id);
    const afterReSave = localStorage.getItem(STORAGE_KEY);

    // No key-order drift, no field churn from the voices subtree.
    expect(afterReSave).toBe(afterFirstSave);
  });

  it('a stored v5 preset self-heals to v6 on load (migratedFrom:5 write-back)', () => {
    // A v5 body (CURRENT_SCHEMA_VERSION before the multi-voice bump) carrying voices: parse
    // walks MIGRATIONS[5] (pure version-bump) up to v6 and reports migratedFrom=5.
    const v5 = { ...multiVoiceFixture(), schemaVersion: 5 };

    const res = parsePresetJson(JSON.stringify(v5));
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.migratedFrom).toBe(5);
      expect(res.preset.schemaVersion).toBe(6);
      expect(res.preset.voices).toHaveLength(2);
    }

    // Store the v5 body raw, then loadPreset self-heals it: migrates to v6 AND writes back.
    setEnvelope({
      storeVersion: 1,
      seeded: true,
      records: [{ id: 'legacy5', createdAt: 11, updatedAt: 22, preset: v5 }],
    });
    const loaded = loadPreset('legacy5');
    expect(loaded?.preset.schemaVersion).toBe(6);
    expect(loaded?.preset.voices).toHaveLength(2);
    expect(loaded?.createdAt).toBe(11); // migration preserves timestamps (system action)
    expect(loaded?.updatedAt).toBe(22);

    // The upgraded v6 body was written back in place (read again — now no migration needed).
    const after = rawEnvelope() as { records: Array<{ preset: { schemaVersion: number } }> };
    expect(after.records[0].preset.schemaVersion).toBe(6);
  });

  it('an invalid voice → INVALID_PRESET, writes no record', () => {
    // A voice-subtree issue from the delegate (empty voice id). persistence adds no rules of
    // its own; assert generically on the code, not the exact VOICE_* name.
    const bad = multiVoiceFixture({
      voices: [{ id: '   ', nodes: [{ t: 0, carrier: { value: 320 } }] }],
    } as Partial<Preset>);

    const e = caught(() => savePreset(bad));
    expect(e.code).toBe('INVALID_PRESET');
    expect(e.issues && e.issues.length).toBeGreaterThan(0);
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull(); // never wrote a record

    // The pure import core surfaces the SAME upstream failure as { ok:false, issues }.
    const res = parsePresetJson(JSON.stringify(bad));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.issues.length).toBeGreaterThan(0);
  });
});
