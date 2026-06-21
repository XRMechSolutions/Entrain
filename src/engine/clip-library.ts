// clip-library — the device-local, content-addressed IndexedDB store of audio clips
// and the ClipSourceAdapter extensibility seam.
//
// One job: persist an encoded audio Blob + metadata under a content hash, dedup
// identical content, retrieve bytes / metadata / list, delete, and run a source
// adapter to produce a clip. It imports NO other project module (a clip id is just a
// string — D-023); it does not decode for playback, synthesize speech, or know the
// Preset/Layer schema. The file-import adapter lives in ./clip-sources/file-import.ts.
//
// Storage: db `binaural-clips` v1, store `clips` (keyPath 'id'), indexes
// `by-hash` (unique) + `by-source` (non-unique). Hash: SHA-256 hex, lowercase,
// two chars per byte (padStart mandatory). See
// .dev/planning/modules/clip-library/{design,interfaces,edge-cases}.md.

import { openDB } from 'idb';
import type { DBSchema, IDBPDatabase, IDBPObjectStore } from 'idb';

// ---------------------------------------------------------------------------
// 1. Types (the Clip / ClipSourceAdapter / ClipDraft seam — phase2 §0/§6)
// ---------------------------------------------------------------------------

export type ClipSource = 'file' | 'tts' | 'record';

export interface ClipMeta {
  /** display name (file name, or first words of a TTS line) */
  name: string;
  /** tag for tts/voice clips ('en','es','fr','ja') */
  language?: string;
  /** voice id for tts clips */
  voice?: string;
  /** source text for tts clips (part of the cache basis) */
  text?: string;
}

/** What an adapter produces; not yet stored. */
export interface ClipDraft {
  /**
   * Full 64-char LOWERCASE hex SHA-256 of the adapter's generating inputs; encode as
   * bytes.map(b => b.toString(16).padStart(2,'0')).
   */
  hash: string;
  /** encoded audio bytes (the File itself for file-import) */
  blob: Blob;
  /** mime, e.g. 'audio/mpeg' */
  format: string;
  /** measured by the adapter (decoded once), finite > 0 */
  durationSec: number;
  source: ClipSource;
  meta: ClipMeta;
}

/** The stored record (returned by reads). */
export interface Clip {
  /**
   * 'clip_' + hash.slice(0,16); content-derived, stable. On a 16-char-prefix collision
   * with a DIFFERENT full hash, add() uses a longer prefix (clip_ + slice(0,24|32|…) …
   * full hash) — see design §2.1 / edge-cases §8. Treat as opaque.
   */
  id: string;
  /** full 64-char lowercase hex */
  hash: string;
  format: string;
  durationSec: number;
  source: ClipSource;
  meta: ClipMeta;
  /** = blob.size, set by add() (NOT supplied by the adapter) */
  bytes: number;
  /** epoch ms; = Date.now() at first write */
  createdAt: number;
  /** epoch ms; = createdAt at first write; bumped on dedup hit and on every getBlob */
  lastUsedAt: number;
}

// ---------------------------------------------------------------------------
// 2. Adapter interface (the extensibility seam)
// ---------------------------------------------------------------------------

export interface ClipSourceAdapter<TInput> {
  readonly source: ClipSource;
  /** hash + decode + package; throws ClipLibraryError('DECODE_FAILED') */
  produce(input: TInput): Promise<ClipDraft>;
}

// ---------------------------------------------------------------------------
// 3. Errors
// ---------------------------------------------------------------------------

export type ClipLibraryErrorCode =
  | 'QUOTA_EXCEEDED' // IndexedDB storage full on add
  | 'DECODE_FAILED' // adapter could not decode the input as audio
  | 'UNSUPPORTED' // IndexedDB or crypto.subtle unavailable (e.g. insecure context)
  | 'DB_ERROR'; // unexpected IndexedDB failure

export class ClipLibraryError extends Error {
  readonly name = 'ClipLibraryError';
  readonly code: ClipLibraryErrorCode;
  readonly cause?: unknown;

  constructor(code: ClipLibraryErrorCode, message?: string, cause?: unknown) {
    super(message ?? code);
    this.code = code;
    if (cause !== undefined) this.cause = cause;
    // Restore the prototype so `instanceof` holds even when a down-level transpile
    // target breaks the native Error subclass chain.
    Object.setPrototypeOf(this, ClipLibraryError.prototype);
  }
}

// ---------------------------------------------------------------------------
// 4. Hashing — the single source of truth reused by storage and every adapter
// ---------------------------------------------------------------------------

/**
 * SHA-256 of `bytes` as 64-char LOWERCASE hex. `crypto.subtle.digest` reads the buffer
 * but does NOT detach it, so the caller's buffer stays intact (the file-import adapter
 * relies on this to hash before decoding a copy — design §5.1). The padStart(2,'0') is
 * mandatory: a byte < 0x10 must emit two chars or it would shift every following byte.
 */
export async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const subtle =
    typeof crypto !== 'undefined' && crypto && (crypto as Crypto).subtle
      ? (crypto as Crypto).subtle
      : undefined;
  if (!subtle) {
    throw new ClipLibraryError(
      'UNSUPPORTED',
      'crypto.subtle is unavailable (insecure context?)',
    );
  }
  let digest: ArrayBuffer;
  try {
    digest = await subtle.digest('SHA-256', bytes);
  } catch (cause) {
    throw new ClipLibraryError('UNSUPPORTED', 'SHA-256 digest failed', cause);
  }
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

// ---------------------------------------------------------------------------
// 5. IndexedDB schema + lazy open
// ---------------------------------------------------------------------------

const DB_NAME = 'binaural-clips';
const DB_VERSION = 1;
const STORE = 'clips';
const IDX_HASH = 'by-hash';
const IDX_SOURCE = 'by-source';

interface ClipDbSchema extends DBSchema {
  clips: {
    key: string;
    value: StoredClip;
    indexes: {
      'by-hash': string;
      'by-source': ClipSource;
    };
  };
}

/** The on-disk record: every public Clip field plus the inline blob. */
interface StoredClip extends Clip {
  blob: Blob;
}

let dbPromise: Promise<IDBPDatabase<ClipDbSchema>> | undefined;

/**
 * Lazily open (and memoize) the `binaural-clips` DB. The handle is cached for the page
 * lifetime; no explicit close. A failed open rejects the memoized promise so every
 * public call surfaces UNSUPPORTED/DB_ERROR. On first open we best-effort request
 * persistent storage (swallowing absence/rejection — never propagated).
 */
function getDb(): Promise<IDBPDatabase<ClipDbSchema>> {
  if (dbPromise) return dbPromise;
  dbPromise = openClipDb();
  return dbPromise;
}

async function openClipDb(): Promise<IDBPDatabase<ClipDbSchema>> {
  if (typeof indexedDB === 'undefined' || indexedDB === null) {
    throw new ClipLibraryError('UNSUPPORTED', 'IndexedDB is unavailable');
  }
  let db: IDBPDatabase<ClipDbSchema>;
  try {
    db = await openDB<ClipDbSchema>(DB_NAME, DB_VERSION, {
      upgrade(database) {
        const store = database.createObjectStore(STORE, { keyPath: 'id' });
        store.createIndex(IDX_HASH, 'hash', { unique: true });
        store.createIndex(IDX_SOURCE, 'source', { unique: false });
      },
    });
  } catch (cause) {
    throw new ClipLibraryError('UNSUPPORTED', 'Could not open the clip database', cause);
  }
  await requestPersistence();
  return db;
}

/** One-time best-effort persistent-storage request; absence/rejection is ignored. */
async function requestPersistence(): Promise<void> {
  try {
    const storage =
      typeof navigator !== 'undefined' && navigator && navigator.storage
        ? navigator.storage
        : undefined;
    if (storage && typeof storage.persist === 'function') {
      await storage.persist();
    }
  } catch {
    // Persistence is advisory only — never fail the open on it.
  }
}

/** Test-only reset of the memoized DB handle. Not part of the public contract. */
export function _resetDbForTests(): void {
  dbPromise = undefined;
}

// ---------------------------------------------------------------------------
// 6. Error mapping helpers
// ---------------------------------------------------------------------------

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

/** Map an unexpected IndexedDB fault to a typed ClipLibraryError, preserving cause. */
function asDbError(cause: unknown): ClipLibraryError {
  if (cause instanceof ClipLibraryError) return cause;
  if (isQuotaExceeded(cause)) {
    return new ClipLibraryError('QUOTA_EXCEEDED', 'Storage quota exceeded', cause);
  }
  return new ClipLibraryError('DB_ERROR', 'Unexpected IndexedDB failure', cause);
}

/** True when a write failed the unique `by-hash` constraint (concurrent same-hash add). */
function isConstraintError(e: unknown): boolean {
  return (
    typeof DOMException !== 'undefined' &&
    e instanceof DOMException &&
    e.name === 'ConstraintError'
  );
}

/** Strip the inline blob — list/get/getByHash return metadata-only Clips. */
function toClip(record: StoredClip): Clip {
  const { blob: _blob, ...meta } = record;
  void _blob;
  return meta;
}

// ---------------------------------------------------------------------------
// 7. Reads: get / getByHash / list / totalBytes / remove
// ---------------------------------------------------------------------------

export async function get(id: string): Promise<Clip | undefined> {
  const db = await getDb();
  try {
    const record = await db.get(STORE, id);
    return record ? toClip(record) : undefined;
  } catch (cause) {
    throw asDbError(cause);
  }
}

export async function getByHash(hash: string): Promise<Clip | undefined> {
  const db = await getDb();
  try {
    const record = await db.getFromIndex(STORE, IDX_HASH, hash);
    return record ? toClip(record) : undefined;
  } catch (cause) {
    throw asDbError(cause);
  }
}

/** Metadata only — every record minus its blob, so browsing never pulls audio in. */
export async function list(): Promise<Clip[]> {
  const db = await getDb();
  try {
    const records = await db.getAll(STORE);
    return records.map(toClip);
  } catch (cause) {
    throw asDbError(cause);
  }
}

/** Sum of every stored blob's size. */
export async function totalBytes(): Promise<number> {
  const db = await getDb();
  try {
    const records = await db.getAll(STORE);
    let total = 0;
    for (const r of records) total += r.blob.size;
    return total;
  } catch (cause) {
    throw asDbError(cause);
  }
}

/** Delete by id; resolves true iff a record existed. Unknown id → false, no error. */
export async function remove(id: string): Promise<boolean> {
  const db = await getDb();
  try {
    const tx = db.transaction(STORE, 'readwrite');
    const existing = await tx.store.get(id);
    if (existing === undefined) {
      await tx.done;
      return false;
    }
    await tx.store.delete(id);
    await tx.done;
    return true;
  } catch (cause) {
    throw asDbError(cause);
  }
}

// ---------------------------------------------------------------------------
// 8. add() — dedup + id-prefix collision + ClipDraft→Clip mapping (one txn)
// ---------------------------------------------------------------------------

/**
 * Store a draft in ONE readwrite transaction: dedup by full hash (bump lastUsedAt and
 * return the existing record), else mint a content-derived id (lengthening the prefix
 * on a different-hash collision, §2.1), build the Clip per the §5.2 mapping, write,
 * and return it. A concurrent same-hash race fails the unique by-hash constraint; we
 * catch it, re-read by hash, and return the existing record (idempotent, no duplicate).
 */
export async function add(draft: ClipDraft): Promise<Clip> {
  const db = await getDb();
  try {
    return await addOnce(db, draft);
  } catch (cause) {
    if (isConstraintError(cause)) {
      // Concurrent add of the same hash committed first — re-read and return it.
      const existing = await getByHash(draft.hash);
      if (existing) return existing;
    }
    throw asDbError(cause);
  }
}

async function addOnce(
  db: IDBPDatabase<ClipDbSchema>,
  draft: ClipDraft,
): Promise<Clip> {
  const tx = db.transaction(STORE, 'readwrite');
  const store = tx.store;
  const hashIndex = store.index(IDX_HASH);

  // (1) Dedup: a record with the same FULL hash already exists → bump + return it.
  const existing = await hashIndex.get(draft.hash);
  if (existing) {
    existing.lastUsedAt = Date.now();
    await store.put(existing);
    await tx.done;
    return toClip(existing);
  }

  // (2) Mint the content-derived id, lengthening the prefix only on a DIFFERENT-hash
  //     collision (§2.1). The step sequence is hash-derived, so the resolved id is
  //     reproducible on every device.
  const id = await resolveId(store, draft.hash);

  // (3) Build the Clip per the §5.2 mapping (storage owns bytes + timestamps).
  const now = Date.now();
  const record: StoredClip = {
    id,
    hash: draft.hash,
    format: draft.format,
    durationSec: draft.durationSec,
    source: draft.source,
    meta: draft.meta,
    bytes: draft.blob.size,
    createdAt: now,
    lastUsedAt: now,
    blob: draft.blob,
  };
  await store.add(record);
  await tx.done;
  return toClip(record);
}

/** Fixed prefix lengths for the §2.1 collision walk: 16, 24, 32, … 64. */
const PREFIX_LENGTHS = [16, 24, 32, 40, 48, 56, 64] as const;

/**
 * Resolve the id for a NEW hash (already known not to be a dedup hit). Start at the
 * 16-char prefix; if that id is held by a record with a DIFFERENT full hash, lengthen
 * the prefix in fixed 8-char steps up to the full 64-char hash, stopping at the first
 * id not bound to a different full hash. Reads share the caller's transaction (atomic).
 */
async function resolveId(
  store: ClipsStore,
  hash: string,
): Promise<string> {
  for (const len of PREFIX_LENGTHS) {
    const id = 'clip_' + hash.slice(0, len);
    const holder = await store.get(id);
    if (holder === undefined || holder.hash === hash) {
      // Free, or (defensively) already ours — either way this id is usable. A same-hash
      // holder would have been caught as a dedup hit upstream; this guard keeps the walk
      // total even in that degenerate case.
      return id;
    }
    // Held by a DIFFERENT full hash → lengthen the prefix and retry.
  }
  // All prefixes up to the full 64-char hash are held by different hashes — only a true
  // SHA-256 collision, which the upstream dedup read already excluded. Fall back to the
  // full hash id (defensive; unreachable in practice).
  return 'clip_' + hash;
}

// idb's typed readwrite ObjectStore within a transaction. Aliased so resolveId reads cleanly.
type ClipsStore = IDBPObjectStore<ClipDbSchema, ['clips'], 'clips', 'readwrite'>;

// ---------------------------------------------------------------------------
// 9. getBlob() — atomic read + lastUsedAt bump in one readwrite transaction
// ---------------------------------------------------------------------------

/**
 * Read a clip's blob and bump lastUsedAt ATOMICALLY in one readwrite transaction. An
 * absent id resolves undefined with NO write (the LRU bump simply does not happen). The
 * read and the bumped-lastUsedAt write share one transaction, so no other op interleaves
 * between them — a remove committing between read and put is impossible (no resurrected
 * clip), and the LRU timestamp can never be lost or clobbered (design §6.1/§6.2).
 */
export async function getBlob(id: string): Promise<Blob | undefined> {
  const db = await getDb();
  try {
    const tx = db.transaction(STORE, 'readwrite');
    const record = await tx.store.get(id);
    if (record === undefined) {
      await tx.done; // no write — the bump does not happen for an absent clip
      return undefined;
    }
    record.lastUsedAt = Date.now();
    await tx.store.put(record);
    await tx.done;
    return record.blob;
  } catch (cause) {
    throw asDbError(cause);
  }
}

// ---------------------------------------------------------------------------
// 10. importVia() — transparent compose of adapter.produce + add
// ---------------------------------------------------------------------------

/**
 * Run an adapter then add() — the one-call import path. Equivalent to
 * add(await adapter.produce(input)). A produce-stage error (e.g. DECODE_FAILED) and an
 * add-stage error (QUOTA_EXCEEDED/DB_ERROR) both propagate AS-IS — same code/message/
 * cause, never re-coded or wrapped (design §6.3). The caller always sees one typed
 * ClipLibraryError whose code names the real failure stage.
 */
export async function importVia<T>(
  adapter: ClipSourceAdapter<T>,
  input: T,
): Promise<Clip> {
  return add(await adapter.produce(input));
}

// ---------------------------------------------------------------------------
// 11. Adapter re-export — the Phase-2.0 file-import adapter is part of this
//     module's public surface (interfaces §3), though it lives in its own file
//     so the seam stays small. clip-library still imports no OTHER project module.
// ---------------------------------------------------------------------------

export { createFileImportAdapter } from './clip-sources/file-import';
export type { FileImportOptions } from './clip-sources/file-import';
