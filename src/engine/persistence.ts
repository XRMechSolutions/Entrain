// persistence — the preset library and file I/O for the app.
//
// Four jobs and nothing else: a single-key localStorage preset library
// (save/load/list/delete/clear + idempotent default-seeding), JSON file export,
// JSON file import, and delegating ALL schema work to session-model. It owns zero
// schema knowledge; every preset entering or leaving funnels through
// session-model.validate / parse / serialize. No audio, no AudioContext.
//
// See .dev/planning/modules/persistence/{design,interfaces,edge-cases}.md.

import { validate, parse, serialize, SessionModelError } from './session-model';
import type { Preset, ValidationIssue } from './session-model';
import { DEFAULT_SESSIONS } from './default-sessions';

// ---------------------------------------------------------------------------
// 1. Constants
// ---------------------------------------------------------------------------

/** The single localStorage key holding the whole preset library envelope. */
export const STORAGE_KEY = 'binaural-audio.presetLibrary';

/** Format version of the storage *container* (NOT Preset.schemaVersion). */
export const STORE_VERSION = 1;

/** Hard cap on an imported file's size (bytes). A real preset is a few KB. */
export const MAX_IMPORT_BYTES = 1_048_576; // 1 MiB

/** MIME type and extension used by export. */
export const EXPORT_MIME = 'application/json';
export const EXPORT_EXTENSION = '.json';

// ---------------------------------------------------------------------------
// 2. Error type
// ---------------------------------------------------------------------------

export type PersistenceErrorCode =
  | 'STORAGE_UNAVAILABLE' // localStorage threw on access (disabled / sandboxed / privacy mode)
  | 'STORAGE_CORRUPT' // the library envelope JSON is unparseable or mis-shaped
  | 'STORE_VERSION_UNSUPPORTED' // envelope storeVersion this build cannot read (e.g. > 1)
  | 'QUOTA_EXCEEDED' // setItem threw a quota error (storage full / Safari private mode)
  | 'INVALID_PRESET' // a preset failed session-model validation (issues attached)
  | 'DOM_UNAVAILABLE' // export/import called without document/Blob/URL (non-browser)
  | 'IMPORT_TOO_LARGE' // chosen file exceeds MAX_IMPORT_BYTES
  | 'IMPORT_READ_FAILED' // file could not be read as text
  | 'IMPORT_CANCELLED'; // user dismissed the file picker

export class PersistenceError extends Error {
  readonly name = 'PersistenceError';
  readonly code: PersistenceErrorCode;
  /** Present only for INVALID_PRESET: the session-model issues that caused it. */
  readonly issues?: ValidationIssue[];
  /** Present for wrapped lower-level faults (DOMException, SyntaxError, FileReader error). */
  readonly cause?: unknown;

  constructor(
    code: PersistenceErrorCode,
    message?: string,
    opts?: { issues?: ValidationIssue[]; cause?: unknown },
  ) {
    super(message);
    this.code = code;
    if (opts?.issues !== undefined) this.issues = opts.issues;
    if (opts?.cause !== undefined) this.cause = opts.cause;
  }
}

// ---------------------------------------------------------------------------
// 3. Data shapes (public)
// ---------------------------------------------------------------------------

/** Lightweight library entry — returned by listPresets(); no full node body. */
export interface PresetSummary {
  id: string;
  name: string;
  durationSec: number;
  nodeCount: number;
  createdAt: number;
  updatedAt: number;
}

/** A loaded/saved record: metadata + the validated, normalized preset. */
export interface SavedPreset {
  id: string;
  createdAt: number;
  updatedAt: number;
  preset: Preset;
  warnings: ValidationIssue[];
}

/** Result of a successful file/string import (NOT yet saved to the library). */
export interface ImportedPreset {
  preset: Preset;
  migratedFrom: number | null;
  warnings: ValidationIssue[];
  filename: string;
}

/** Discriminated result of the DOM-free import core. Never thrown. */
export type ImportResult =
  | { ok: true; preset: Preset; migratedFrom: number | null; warnings: ValidationIssue[] }
  | { ok: false; issues: ValidationIssue[] };

// ---------------------------------------------------------------------------
// 3b. Internal envelope shapes
// ---------------------------------------------------------------------------

interface StoredRecord {
  id: string;
  createdAt: number;
  updatedAt: number;
  preset: Preset;
}

interface Library {
  storeVersion: number;
  seeded: boolean;
  records: StoredRecord[];
}

// Registry of structural up-migrations: STORE_MIGRATIONS[from] transforms a
// from-version envelope into the (from+1)-version shape — the seam for any future
// container-format change. Currently empty by design because STORE_VERSION is 1 (the
// first and only format), exactly mirroring session-model's empty MIGRATIONS. Any
// envelope storeVersion other than 1 therefore returns STORE_VERSION_UNSUPPORTED.
// TODO(stub): future presetLibrary STORE_VERSION migrations register at STORE_MIGRATIONS[from] — resolves when STORE_VERSION is bumped past 1
const STORE_MIGRATIONS: Record<number, (env: Record<string, unknown>) => Record<string, unknown>> =
  {};

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Build the single INVALID_PRESET error with the upstream issues attached. */
function invalidPresetError(issues: ValidationIssue[]): PersistenceError {
  const errorCount = issues.filter((i) => i.severity === 'error').length;
  return new PersistenceError('INVALID_PRESET', `Invalid preset: ${errorCount} error(s)`, { issues });
}

function isQuotaExceeded(e: unknown): boolean {
  return (
    typeof DOMException !== 'undefined' &&
    e instanceof DOMException &&
    (e.name === 'QuotaExceededError' ||
      e.name === 'NS_ERROR_DOM_QUOTA_REACHED' ||
      e.code === 22 ||
      e.code === 1014)
  );
}

// ---------------------------------------------------------------------------
// 4. ID generation
// ---------------------------------------------------------------------------

function newId(): string {
  const c: Crypto | undefined = typeof crypto !== 'undefined' ? crypto : undefined;
  if (c && typeof c.randomUUID === 'function') {
    return c.randomUUID();
  }
  if (c && typeof c.getRandomValues === 'function') {
    return uuidV4FromBytes(c);
  }
  // Last resort: non-cryptographic, but collision-improbable within one device's library.
  return `p-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function uuidV4FromBytes(c: Crypto): string {
  const bytes = c.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40; // version 4
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // RFC-4122 variant
  const hex: string[] = [];
  for (let i = 0; i < 16; i++) hex.push(bytes[i].toString(16).padStart(2, '0'));
  return (
    hex.slice(0, 4).join('') +
    '-' +
    hex.slice(4, 6).join('') +
    '-' +
    hex.slice(6, 8).join('') +
    '-' +
    hex.slice(8, 10).join('') +
    '-' +
    hex.slice(10, 16).join('')
  );
}

// ---------------------------------------------------------------------------
// 5. Envelope I/O (internal) — the storage-fault boundary
// ---------------------------------------------------------------------------

function freshLibrary(): Library {
  return { storeVersion: STORE_VERSION, seeded: false, records: [] };
}

function readLibrary(): Library {
  let raw: string | null;
  try {
    raw = localStorage.getItem(STORAGE_KEY);
  } catch (cause) {
    throw new PersistenceError('STORAGE_UNAVAILABLE', 'localStorage is unavailable', { cause });
  }

  // First run, or foreign blank/whitespace tampering: treat as no data.
  if (raw === null || raw.trim() === '') {
    return freshLibrary();
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    // Never silently wipe — losing the user's whole library without consent is
    // unacceptable. Recovery is the explicit clearLibrary() escape hatch.
    throw new PersistenceError('STORAGE_CORRUPT', 'Preset library is corrupt (unparseable JSON)', {
      cause,
    });
  }

  if (!isPlainObject(parsed) || !Array.isArray(parsed.records)) {
    throw new PersistenceError('STORAGE_CORRUPT', 'Preset library envelope is mis-shaped');
  }

  let env: Record<string, unknown> = parsed;
  const sv = env.storeVersion;
  if (sv !== STORE_VERSION) {
    if (typeof sv === 'number' && sv > STORE_VERSION) {
      throw new PersistenceError(
        'STORE_VERSION_UNSUPPORTED',
        `Preset library storeVersion ${sv} is newer than this build supports (${STORE_VERSION})`,
      );
    }
    // storeVersion < 1, missing, or non-number: walk the (currently empty) migration seam.
    let from = typeof sv === 'number' ? sv : Number.NaN;
    while (from < STORE_VERSION) {
      const step = STORE_MIGRATIONS[from];
      if (!step) break;
      env = step(env);
      from++;
    }
    if (from !== STORE_VERSION) {
      const shown = typeof sv === 'number' ? String(sv) : 'missing';
      throw new PersistenceError(
        'STORE_VERSION_UNSUPPORTED',
        `Preset library storeVersion ${shown} is not supported by this build`,
      );
    }
  }

  const records = env.records;
  if (!Array.isArray(records)) {
    throw new PersistenceError('STORAGE_CORRUPT', 'Preset library envelope is mis-shaped');
  }

  return {
    storeVersion: STORE_VERSION,
    seeded: env.seeded === true,
    records: records as StoredRecord[],
  };
}

function writeLibrary(lib: Library): void {
  // Compact (no pretty-print) for storage efficiency; canonical key order comes from
  // the object literal shape (storeVersion, seeded, records) and the stored bodies.
  const raw = JSON.stringify(lib);
  try {
    localStorage.setItem(STORAGE_KEY, raw);
  } catch (cause) {
    if (isQuotaExceeded(cause)) {
      throw new PersistenceError('QUOTA_EXCEEDED', 'Storage quota exceeded', { cause });
    }
    throw new PersistenceError('STORAGE_UNAVAILABLE', 'localStorage is unavailable', { cause });
  }
}

// ---------------------------------------------------------------------------
// 6. Library operations (localStorage CRUD)
// ---------------------------------------------------------------------------

function summaryOf(record: unknown): PresetSummary | null {
  if (!isPlainObject(record)) return null;
  const { id, createdAt, updatedAt, preset } = record;
  if (typeof id !== 'string') return null;
  if (typeof createdAt !== 'number' || typeof updatedAt !== 'number') return null;
  if (!isPlainObject(preset)) return null;
  const { name, durationSec, nodes } = preset;
  if (typeof name !== 'string') return null;
  if (typeof durationSec !== 'number') return null;
  if (!Array.isArray(nodes)) return null;
  return { id, name, durationSec, nodeCount: nodes.length, createdAt, updatedAt };
}

// Total order: most-recently-edited first, then most-recently-created, then by unique
// id (guarantees a deterministic, total order with no nondeterministic ties).
function compareSummaries(a: PresetSummary, b: PresetSummary): number {
  if (b.updatedAt !== a.updatedAt) return b.updatedAt - a.updatedAt;
  if (b.createdAt !== a.createdAt) return b.createdAt - a.createdAt;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export function listPresets(): PresetSummary[] {
  const lib = readLibrary();
  const summaries: PresetSummary[] = [];
  for (const record of lib.records) {
    const summary = summaryOf(record);
    if (summary === null) {
      // Only reachable via external tampering. Skip (never delete — non-destructive) so
      // one bad record cannot make the whole picker un-listable.
      console.warn('[persistence] Skipping malformed preset record while listing', record);
      continue;
    }
    summaries.push(summary);
  }
  summaries.sort(compareSummaries);
  return summaries;
}

export function loadPreset(id: string): SavedPreset | null {
  const lib = readLibrary();
  const record = lib.records.find((r) => isPlainObject(r) && r.id === id);
  if (!record) return null; // A stale picker entry is not an exception.

  // Re-serialize the stored body and run the SAME untrusted pipeline as file import:
  // parse → migrate → stable-sort → validate. One shared validation path.
  const res = parse(JSON.stringify(record.preset));
  if (!res.ok) {
    // Corrupt/tampered or future-incompatible body. Surface it; do not auto-delete.
    throw invalidPresetError(res.issues);
  }

  if (res.migratedFrom !== null) {
    // Self-heal: the stored body was an older schema and session-model upgraded it.
    // Write it back in place (best-effort), preserving timestamps — a migration is a
    // system action, not a user edit. A failed heal-write must NOT fail the read.
    record.preset = res.preset;
    try {
      writeLibrary(lib);
    } catch (e) {
      console.warn(
        '[persistence] Best-effort migration write-back failed; returning migrated preset anyway',
        e,
      );
    }
  }

  return {
    id: record.id,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    preset: res.preset,
    warnings: res.issues,
  };
}

export function savePreset(preset: Preset, id?: string): SavedPreset {
  // Validate first (defense in depth — never persist corrupt data). Store the
  // normalized clone so the body is always canonical, unknown-key-stripped.
  const res = validate(preset);
  if (!res.ok) throw invalidPresetError(res.issues);

  const lib = readLibrary();
  const now = Date.now();

  let record: StoredRecord;
  if (id === undefined) {
    record = { id: newId(), createdAt: now, updatedAt: now, preset: res.preset };
    lib.records.push(record);
  } else {
    const existing = lib.records.find((r) => isPlainObject(r) && r.id === id);
    if (existing) {
      existing.preset = res.preset;
      existing.updatedAt = now;
      record = existing;
    } else {
      // id given but missing → create a record WITH that id (supports restoring a known
      // id, e.g. after import-with-id); there is no "not found on save" error.
      record = { id, createdAt: now, updatedAt: now, preset: res.preset };
      lib.records.push(record);
    }
  }

  writeLibrary(lib);
  return {
    id: record.id,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    preset: res.preset,
    warnings: res.issues,
  };
}

export function deletePreset(id: string): boolean {
  const lib = readLibrary();
  const index = lib.records.findIndex((r) => isPlainObject(r) && r.id === id);
  if (index === -1) return false; // "Absent" is not exceptional — no NOT_FOUND code.
  lib.records.splice(index, 1);
  writeLibrary(lib);
  return true;
}

export function clearLibrary(): void {
  // Escape hatch for STORAGE_CORRUPT: never reads or parses, so it works even when the
  // envelope is unreadable. Removing the key resets `seeded`, so a subsequent
  // seedDefaultPresets() re-seeds (clearLibrary + seed = factory reset).
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch (cause) {
    throw new PersistenceError('STORAGE_UNAVAILABLE', 'localStorage is unavailable', { cause });
  }
}

// ---------------------------------------------------------------------------
// 7. Seeding the built-in default presets
// ---------------------------------------------------------------------------

// Four concrete, already-valid presets. Framed per D-009 (honesty stance): names
// describe the band/use, never claim to induce a state. Transcribed literally from
// design.md §7 — zero judgment calls.
export function buildDefaultLibraryPresets(): Preset[] {
  return [
    {
      schemaVersion: 3,
      name: 'Relax — Alpha 10 Hz',
      durationSec: 600,
      masterGain: 0.8,
      nodes: [
        { t: 0, carrier: { value: 200 }, beat: { value: 10 }, volume: { value: 0, transition: 'linear' } },
        { t: 10, volume: { value: 1 } },
        { t: 585, volume: { value: 1, transition: 'linear' } },
        { t: 600, volume: { value: 0 } },
      ],
    },
    {
      schemaVersion: 3,
      name: 'Meditate — Theta 6 Hz',
      durationSec: 1200,
      masterGain: 0.8,
      nodes: [
        {
          t: 0,
          carrier: { value: 180 },
          beat: { value: 10, transition: 'linear' },
          volume: { value: 0, transition: 'linear' },
        },
        { t: 20, volume: { value: 1 } },
        { t: 600, beat: { value: 6 } },
        { t: 1185, volume: { value: 1, transition: 'linear' } },
        { t: 1200, volume: { value: 0 } },
      ],
    },
    {
      schemaVersion: 3,
      name: 'Sleep Descent — Delta',
      durationSec: 1800,
      masterGain: 0.8,
      nodes: [
        {
          t: 0,
          carrier: { value: 120 },
          beat: { value: 8, transition: 'linear' },
          volume: { value: 0, transition: 'linear' },
        },
        { t: 30, volume: { value: 1 } },
        { t: 900, beat: { value: 4 } },
        { t: 1700, volume: { value: 1, transition: 'linear' } },
        { t: 1800, beat: { value: 2 }, volume: { value: 0 } },
      ],
    },
    {
      schemaVersion: 3,
      name: 'Isochronic Focus — 10 Hz pulse',
      durationSec: 600,
      masterGain: 0.8,
      nodes: [
        {
          t: 0,
          carrier: { value: 220 },
          beat: { value: 0 },
          volume: {
            value: 0,
            transition: 'linear',
            mod: {
              shape: 'pulse',
              periodSec: 0.1,
              depth: 1,
              transition: 'glide',
              pulseWidth: 0.5,
              edgeMs: 8,
            },
          },
        },
        { t: 10, volume: { value: 1 } },
        { t: 590, volume: { value: 1, transition: 'linear' } },
        { t: 600, volume: { value: 0 } },
      ],
    },
    ...DEFAULT_SESSIONS,
  ];
}

export function seedDefaultPresets(): PresetSummary[] {
  const lib = readLibrary();
  // Gate on the `seeded` flag — NOT on record count — so a user who deletes the
  // defaults does not get them resurrected on the next launch.
  if (lib.seeded) return [];

  const now = Date.now();
  const added: PresetSummary[] = [];
  for (const preset of buildDefaultLibraryPresets()) {
    // Validate to store the normalized clone (the universal record-body invariant). A
    // built-in failing here is a loud bug, not silent fake success.
    const res = validate(preset);
    if (!res.ok) throw invalidPresetError(res.issues);
    const record: StoredRecord = { id: newId(), createdAt: now, updatedAt: now, preset: res.preset };
    lib.records.push(record);
    added.push({
      id: record.id,
      name: res.preset.name,
      durationSec: res.preset.durationSec,
      nodeCount: res.preset.nodes.length,
      createdAt: now,
      updatedAt: now,
    });
  }

  lib.seeded = true;
  writeLibrary(lib);
  return added;
}

// Non-destructive TOP-UP: append only the built-ins whose name is not already present,
// so a user who was seeded BEFORE new defaults shipped can pull in the missing ones on
// demand without ever wiping, reordering, or modifying their own presets. Unlike
// seedDefaultPresets it IGNORES the `seeded` gate (this is an explicit user action) and
// is idempotent — once every default name is present a second call adds nothing.
export function restoreDefaultPresets(): PresetSummary[] {
  const lib = readLibrary();

  // The set of names already in the library. A built-in matching any of these is SKIPPED
  // (never overwritten, never duplicated). Tampered records without a string name simply
  // don't contribute a name and can't shadow a default.
  const existingNames = new Set<string>();
  for (const r of lib.records) {
    if (isPlainObject(r) && isPlainObject(r.preset) && typeof r.preset.name === 'string') {
      existingNames.add(r.preset.name);
    }
  }

  const now = Date.now();
  const added: PresetSummary[] = [];
  for (const preset of buildDefaultLibraryPresets()) {
    if (existingNames.has(preset.name)) continue; // already have it — leave it untouched
    // Validate to store the normalized clone (the universal record-body invariant). A
    // built-in failing here is a loud bug, not silent fake success.
    const res = validate(preset);
    if (!res.ok) throw invalidPresetError(res.issues);
    const record: StoredRecord = { id: newId(), createdAt: now, updatedAt: now, preset: res.preset };
    lib.records.push(record);
    existingNames.add(res.preset.name); // guard against duplicate names within the defaults
    added.push({
      id: record.id,
      name: res.preset.name,
      durationSec: res.preset.durationSec,
      nodeCount: res.preset.nodes.length,
      createdAt: now,
      updatedAt: now,
    });
  }

  // Mark seeded (a user who tops up has, by definition, the defaults) but write ONLY when
  // something changed — an idempotent call must not rewrite the envelope or touch storage.
  if (added.length > 0) {
    lib.seeded = true;
    writeLibrary(lib);
  }
  return added;
}

// ---------------------------------------------------------------------------
// 8. Export (Preset → downloadable file)
// ---------------------------------------------------------------------------

export function presetToJson(preset: Preset): string {
  // serialize validates first and throws SessionModelError if invalid; rewrap it so
  // this module exposes a single thrown error type.
  try {
    return serialize(preset, { pretty: true });
  } catch (e) {
    if (e instanceof SessionModelError) throw invalidPresetError(e.issues);
    throw e;
  }
}

export function presetToBlob(preset: Preset): Blob {
  if (typeof Blob === 'undefined') {
    throw new PersistenceError('DOM_UNAVAILABLE', 'Blob is not available in this environment');
  }
  return new Blob([presetToJson(preset)], { type: EXPORT_MIME });
}

const RESERVED_DEVICE_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
// Control chars plus the union of characters illegal on Windows / macOS / Linux.
const ILLEGAL_FILENAME_CHARS = /[\x00-\x1f<>:"/\\|?*]/g;

export function toSafeFilename(name: string): string {
  let base = (name ?? '').normalize('NFC');
  base = base.replace(ILLEGAL_FILENAME_CHARS, '-');
  base = base.replace(/\s+/g, ' ').trim(); // collapse internal whitespace runs
  base = base.replace(/^[.\s]+|[.\s]+$/g, ''); // strip leading/trailing dots and spaces
  if (base.length > 64) base = base.slice(0, 64).trim(); // cap at 64 code units
  if (base === '') base = 'preset';
  if (RESERVED_DEVICE_NAME.test(base)) base = `_${base}`;
  if (!/\.json$/i.test(base)) base += EXPORT_EXTENSION;
  return base;
}

export function exportPreset(preset: Preset, opts?: { filename?: string }): string {
  // MUST be called inside a user gesture (download policy); not enforceable here.
  if (
    typeof document === 'undefined' ||
    typeof URL === 'undefined' ||
    typeof URL.createObjectURL !== 'function' ||
    typeof Blob === 'undefined'
  ) {
    throw new PersistenceError(
      'DOM_UNAVAILABLE',
      'Export requires a browser document, Blob, and URL.createObjectURL',
    );
  }

  const filename = toSafeFilename(opts?.filename ?? preset.name);
  // Validate BEFORE creating any object URL / anchor, so an invalid preset never
  // writes a (corrupt) file.
  const blob = presetToBlob(preset);
  const url = URL.createObjectURL(blob);

  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.rel = 'noopener';
  // Some engines require the anchor to be in the document for a programmatic click.
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();

  // Revoke on a delay, not synchronously: an immediate revoke can cancel the in-flight
  // download in some browsers; 1000 ms is long enough to start the transfer, short
  // enough not to matter, and avoids leaking the URL.
  setTimeout(() => URL.revokeObjectURL(url), 1000);

  return filename;
}

// ---------------------------------------------------------------------------
// 9. Import (file → validated Preset, un-saved)
// ---------------------------------------------------------------------------

export function parsePresetJson(json: string): ImportResult {
  // Strip a leading BOM (U+FEFF) defensively: bare JSON.parse throws on it, and
  // paste-JSON / test callers may pass a BOM-prefixed string.
  const text = json.charCodeAt(0) === 0xfeff ? json.slice(1) : json;
  const res = parse(text); // delegate the whole untrusted pipeline; never throws.
  if (!res.ok) return { ok: false, issues: res.issues };
  return { ok: true, preset: res.preset, migratedFrom: res.migratedFrom, warnings: res.issues };
}

export async function importPresetFile(file: File): Promise<ImportedPreset> {
  // Size guard BEFORE reading the bytes into memory.
  if (file.size > MAX_IMPORT_BYTES) {
    throw new PersistenceError(
      'IMPORT_TOO_LARGE',
      `File is too large (${file.size} bytes); maximum is ${MAX_IMPORT_BYTES} bytes`,
    );
  }

  let text: string;
  try {
    text = await file.text(); // Blob.text() decodes UTF-8 and strips a leading BOM.
  } catch (cause) {
    throw new PersistenceError('IMPORT_READ_FAILED', 'Could not read the selected file', { cause });
  }

  const res = parsePresetJson(text);
  if (!res.ok) throw invalidPresetError(res.issues);

  // Does NOT save — the UI decides whether/where to store it. filename is advisory.
  return {
    preset: res.preset,
    migratedFrom: res.migratedFrom,
    warnings: res.warnings,
    filename: file.name,
  };
}

export function importPresetFromFile(): Promise<ImportedPreset> {
  return new Promise<ImportedPreset>((resolve, reject) => {
    if (typeof document === 'undefined') {
      reject(new PersistenceError('DOM_UNAVAILABLE', 'File import requires a browser document'));
      return;
    }

    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'application/json,.json';
    input.style.display = 'none';
    document.body.appendChild(input);

    // A single guard so the returned promise settles exactly once across the competing
    // listeners (change / cancel / focus-fallback).
    let settled = false;
    let focusTimer: ReturnType<typeof setTimeout> | undefined;

    const cleanup = (): void => {
      input.removeEventListener('change', onChange);
      input.removeEventListener('cancel', onCancel);
      window.removeEventListener('focus', onFocus);
      if (focusTimer !== undefined) clearTimeout(focusTimer);
      input.remove();
    };

    const settleResolve = (value: Promise<ImportedPreset>): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    };
    const settleReject = (err: PersistenceError): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    };

    function onChange(): void {
      const file = input.files?.[0];
      if (!file) {
        settleReject(new PersistenceError('IMPORT_CANCELLED', 'No file was selected'));
        return;
      }
      settleResolve(importPresetFile(file));
    }

    // Modern engines (Chrome 113+/FF/Safari 16.4+) fire a `cancel` event on dismissal.
    function onCancel(): void {
      settleReject(new PersistenceError('IMPORT_CANCELLED', 'File selection was cancelled'));
    }

    // Fallback for engines without `cancel`: on the first focus back to the window after
    // the picker opened, give any pending `change` a moment, then treat an empty
    // selection as a cancellation.
    function onFocus(): void {
      if (focusTimer !== undefined) return;
      focusTimer = setTimeout(() => {
        if (!settled && (input.files?.length ?? 0) === 0) {
          settleReject(new PersistenceError('IMPORT_CANCELLED', 'File selection was cancelled'));
        }
      }, 300);
    }

    input.addEventListener('change', onChange);
    input.addEventListener('cancel', onCancel);
    window.addEventListener('focus', onFocus);

    // Opens the OS picker only inside a user gesture (policy; not enforceable here).
    input.click();
  });
}
