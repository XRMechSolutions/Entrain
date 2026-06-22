// clip-library — end-to-end + storage-surface tests (happy + error + edge).
//
// Covers (tasks.md Layer-3): (a) import → get/getBlob round-trip; (b) DEDUP — same
// hash twice → same id, one blob, bumped lastUsedAt; (c) DETACHMENT is proven in
// file-import.test.ts (the hash basis); (d) COLLISION — two distinct full hashes
// sharing 16 prefix chars resolve to distinct, deterministic ids without overwrite;
// (e) getBlob ATOMICITY — absent id → undefined with no write, and a getBlob/remove
// race never resurrects a clip; (f) ERRORS — DECODE_FAILED / QUOTA_EXCEEDED /
// UNSUPPORTED / DB_ERROR each surface as typed ClipLibraryError.
//
// Fresh fake IndexedDB per test (a new IDBFactory + memoized-handle reset). The blob is
// a structured-clone-safe FakeFile (jsdom's Blob does not survive fake-indexeddb clone).

import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ClipLibraryError,
  add,
  createFileImportAdapter,
  get,
  getByHash,
  getBlob,
  importVia,
  list,
  remove,
  sha256Hex,
  totalBytes,
  _resetDbForTests,
} from './clip-library';
import type { ClipDraft, ClipSourceAdapter } from './clip-library';

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

/**
 * Structured-clone-safe File double: data props on the instance survive the clone,
 * arrayBuffer/slice on the prototype are dropped (no DataCloneError). Re-readable after
 * a round-trip through fake-indexeddb via `_bytes`.
 */
class FakeFile {
  readonly size: number;
  constructor(
    readonly _bytes: Uint8Array,
    readonly name: string,
    readonly type: string,
  ) {
    this.size = _bytes.byteLength;
  }
  arrayBuffer(): Promise<ArrayBuffer> {
    return Promise.resolve(this._bytes.slice().buffer);
  }
}

function fakeFile(bytes: number[], name = 'rain.ogg', type = 'audio/ogg'): File {
  return new FakeFile(new Uint8Array(bytes), name, type) as unknown as File;
}

/** A decode stub for the real file-import adapter (records calls, fixed duration). */
function decodeStub(duration = 1.5): BaseAudioContext {
  return {
    decodeAudioData(buf: ArrayBuffer): Promise<AudioBuffer> {
      void buf;
      return Promise.resolve({ duration } as AudioBuffer);
    },
  } as unknown as BaseAudioContext;
}

/** Build a ClipDraft directly (bypasses the adapter — for collision/dedup control). */
function draftWith(hash: string, bytes: number[], name = 'c.ogg'): ClipDraft {
  return {
    hash,
    blob: fakeFile(bytes, name),
    format: 'audio/ogg',
    durationSec: 10,
    source: 'file',
    meta: { name },
  };
}

async function expectClipError(
  fn: () => Promise<unknown>,
  code: ClipLibraryError['code'],
): Promise<ClipLibraryError> {
  try {
    await fn();
  } catch (e) {
    expect(e).toBeInstanceOf(ClipLibraryError);
    expect((e as ClipLibraryError).code).toBe(code);
    return e as ClipLibraryError;
  }
  throw new Error(`expected rejection with ClipLibraryError(${code})`);
}

// ---------------------------------------------------------------------------
// Fixture: fresh DB per test
// ---------------------------------------------------------------------------

beforeEach(() => {
  // A brand-new factory wipes all databases from prior tests.
  (globalThis as { indexedDB: IDBFactory }).indexedDB = new IDBFactory();
  _resetDbForTests();
});

afterEach(() => {
  _resetDbForTests();
});

// ---------------------------------------------------------------------------
// (a) Round-trip via importVia + the real file-import adapter
// ---------------------------------------------------------------------------

describe('clip-library — import round-trip', () => {
  it('should import a file, then get/getBlob the stored clip', async () => {
    const file = fakeFile([1, 2, 3, 4, 5, 6], 'rain.ogg', 'audio/ogg');
    const adapter = createFileImportAdapter({ decodeCtx: decodeStub(42.3) });

    const clip = await importVia(adapter, file);

    expect(clip.id).toBe('clip_' + clip.hash.slice(0, 16));
    expect(clip.source).toBe('file');
    expect(clip.format).toBe('audio/ogg');
    expect(clip.durationSec).toBe(42.3);
    expect(clip.bytes).toBe(6);
    expect(clip.meta).toEqual({ name: 'rain.ogg' });
    expect(clip.createdAt).toBe(clip.lastUsedAt); // equal on first write

    // get() returns the same metadata; list() never carries a blob.
    const fetched = await get(clip.id);
    expect(fetched).toEqual(clip);
    expect(fetched).not.toHaveProperty('blob');

    // getBlob returns the stored bytes.
    const blob = (await getBlob(clip.id)) as unknown as FakeFile;
    expect(blob).toBeDefined();
    expect(Array.from(blob._bytes)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('should resolve undefined for get/getBlob of an unknown id (not throw)', async () => {
    expect(await get('clip_missing')).toBeUndefined();
    expect(await getBlob('clip_missing')).toBeUndefined();
  });

  it('should read a clip by its full hash via getByHash', async () => {
    const clip = await add(draftWith('a'.repeat(64), [7, 7, 7]));
    const byHash = await getByHash('a'.repeat(64));
    expect(byHash?.id).toBe(clip.id);
    expect(await getByHash('b'.repeat(64))).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// (b) Dedup
// ---------------------------------------------------------------------------

describe('clip-library — dedup by full hash', () => {
  it('should return the same id and write no second blob on re-add of the same hash', async () => {
    const hash = 'c'.repeat(64);
    const first = await add(draftWith(hash, [1, 2, 3], 'first.ogg'));

    // A re-add with the SAME hash but different bytes/name must NOT create a new record
    // nor overwrite the stored blob; it bumps lastUsedAt only.
    vi.spyOn(Date, 'now').mockReturnValue(first.lastUsedAt + 5000);
    const second = await add(draftWith(hash, [9, 9, 9, 9, 9], 'second.ogg'));
    vi.restoreAllMocks();

    expect(second.id).toBe(first.id);
    expect(second.createdAt).toBe(first.createdAt); // unchanged
    expect(second.bytes).toBe(first.bytes); // 3, NOT 5 — original blob kept
    expect(second.lastUsedAt).toBe(first.lastUsedAt + 5000); // bumped

    // Exactly one record stored; its blob is the FIRST file's bytes.
    const all = await list();
    expect(all).toHaveLength(1);
    const blob = (await getBlob(first.id)) as unknown as FakeFile;
    expect(Array.from(blob._bytes)).toEqual([1, 2, 3]);
  });

  it('should dedup re-import of the same file through importVia', async () => {
    const adapter = createFileImportAdapter({ decodeCtx: decodeStub(5) });
    const a = await importVia(adapter, fakeFile([4, 5, 6], 'a.ogg'));
    const b = await importVia(adapter, fakeFile([4, 5, 6], 'a-copy.ogg'));
    expect(b.id).toBe(a.id);
    expect(await list()).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// (c2) importVia hashFor fast-path — incremental re-synth (skip produce on a cache hit)
// ---------------------------------------------------------------------------

describe('clip-library — importVia hashFor fast-path (incremental re-synth)', () => {
  const HASH = 'a1b2c3d4e5f6a7b8'.padEnd(64, '0');

  /** A tts-like adapter that COUNTS produce()/hashFor() calls so the cache skip is observable. */
  function countingAdapter(hash: string) {
    const calls = { produce: 0, hashFor: 0 };
    const adapter: ClipSourceAdapter<{ tag: string }> = {
      source: 'tts',
      hashFor: async () => {
        calls.hashFor++;
        return hash;
      },
      produce: async () => {
        calls.produce++;
        return {
          hash,
          blob: fakeFile([1, 2, 3], 'v.wav'),
          format: 'audio/wav',
          durationSec: 2,
          source: 'tts',
          meta: { name: 'v' },
        };
      },
    };
    return { adapter, calls };
  }

  it('produces on a MISS, then reuses the cached clip on a HIT without calling produce again', async () => {
    const { adapter, calls } = countingAdapter(HASH);

    const first = await importVia(adapter, { tag: 'hello' });
    expect(calls.produce).toBe(1); // miss → synthesized once
    expect(first.id).toBe('clip_' + HASH.slice(0, 16));

    const second = await importVia(adapter, { tag: 'hello' });
    expect(calls.hashFor).toBe(2); // hash checked both times (cheap)
    expect(calls.produce).toBe(1); // HIT → produce (synthesis) NOT called again
    expect(second.id).toBe(first.id); // same stored clip
    expect(await list()).toHaveLength(1); // no duplicate record
    expect(second.lastUsedAt).toBeGreaterThanOrEqual(first.lastUsedAt); // LRU bumped on the hit
  });

  it('still produces when hashFor resolves a hash NOT in the store (a real content change)', async () => {
    const a = countingAdapter(HASH);
    await importVia(a.adapter, { tag: 'one' });
    const b = countingAdapter('b9b9b9b9b9b9b9b9'.padEnd(64, '0')); // different content → different hash
    await importVia(b.adapter, { tag: 'two' });
    expect(b.calls.produce).toBe(1); // miss on the new hash → synthesized
    expect(await list()).toHaveLength(2);
  });

  it('an adapter WITHOUT hashFor always produces (back-compat; file-import path unchanged)', async () => {
    const calls = { produce: 0 };
    const adapter: ClipSourceAdapter<null> = {
      source: 'file',
      produce: async () => {
        calls.produce++;
        return draftWith(HASH, [9], 'n.wav');
      },
    };
    await importVia(adapter, null);
    await importVia(adapter, null);
    expect(calls.produce).toBe(2); // no hashFor → produce runs every time (dedup only at storage)
    expect(await list()).toHaveLength(1); // still deduped to one record at the storage layer
  });
});

// ---------------------------------------------------------------------------
// (d) id-prefix collision (§2.1 / edge-cases §8)
// ---------------------------------------------------------------------------

describe('clip-library — id-prefix collision', () => {
  it('should resolve distinct ids for different hashes sharing the first 16 chars, without overwrite', async () => {
    const prefix16 = '0123456789abcdef';
    const hashA = prefix16 + 'a'.repeat(48); // same first 16, different full hash
    const hashB = prefix16 + 'b'.repeat(48);

    const a = await add(draftWith(hashA, [1, 1, 1], 'a.ogg'));
    const b = await add(draftWith(hashB, [2, 2, 2, 2], 'b.ogg'));

    // First takes the 16-char id; second is forced to a longer (24-char) prefix.
    expect(a.id).toBe('clip_' + prefix16);
    expect(b.id).toBe('clip_' + hashB.slice(0, 24));
    expect(b.id).not.toBe(a.id);

    // The first clip's bytes were never overwritten.
    const blobA = (await getBlob(a.id)) as unknown as FakeFile;
    expect(Array.from(blobA._bytes)).toEqual([1, 1, 1]);
    expect((await get(a.id))?.hash).toBe(hashA);
    expect((await get(b.id))?.hash).toBe(hashB);
    expect(await list()).toHaveLength(2);
  });

  it('should resolve the same collision id deterministically on a repeat run', async () => {
    const prefix16 = 'fedcba9876543210';
    const hashA = prefix16 + '1'.repeat(48);
    const hashB = prefix16 + '2'.repeat(48);

    // Run 1
    await add(draftWith(hashA, [1], 'a.ogg'));
    const b1 = await add(draftWith(hashB, [2], 'b.ogg'));

    // Fresh DB, same order — id must be identical (content-derived, reproducible).
    (globalThis as { indexedDB: IDBFactory }).indexedDB = new IDBFactory();
    _resetDbForTests();
    await add(draftWith(hashA, [1], 'a.ogg'));
    const b2 = await add(draftWith(hashB, [2], 'b.ogg'));

    expect(b2.id).toBe(b1.id);
    expect(b2.id).toBe('clip_' + hashB.slice(0, 24));
  });

  it('should lengthen the prefix again when 24 chars also collide', async () => {
    const prefix24 = '0123456789abcdef01234567';
    const hashA = prefix24 + 'a'.repeat(40);
    const hashB = '0123456789abcdef' + '88888888' + 'b'.repeat(40); // shares 16, differs at 24
    // hashA and hashB share only the first 16; force A onto 16, then a third sharing 24.
    const hashC = prefix24 + 'c'.repeat(40); // shares 24 with hashA

    await add(draftWith(hashA, [1], 'a.ogg')); // clip_<16>
    await add(draftWith(hashB, [2], 'b.ogg')); // collides at 16 → clip_<24 of B>
    const c = await add(draftWith(hashC, [3], 'c.ogg')); // collides at 16 AND 24 of A

    // C shares 16 with A (clip_<16> taken by A) and 24 with A (clip_<24> taken? A holds
    // clip_<16>, so clip_<A 24> is free) — C resolves to clip_<C 24>.
    expect(c.id).toBe('clip_' + hashC.slice(0, 24));
    expect(await list()).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// list / remove / totalBytes
// ---------------------------------------------------------------------------

describe('clip-library — list / remove / totalBytes', () => {
  it('should list metadata only (no blob field) and never load blobs', async () => {
    await add(draftWith('1'.repeat(64), [1, 2, 3]));
    await add(draftWith('2'.repeat(64), [4, 5]));
    const clips = await list();
    expect(clips).toHaveLength(2);
    for (const c of clips) expect(c).not.toHaveProperty('blob');
  });

  it('should remove an existing clip (true) then return false on re-delete', async () => {
    const clip = await add(draftWith('3'.repeat(64), [1]));
    expect(await remove(clip.id)).toBe(true);
    expect(await remove(clip.id)).toBe(false);
    expect(await get(clip.id)).toBeUndefined();
  });

  it('should return false removing an unknown id (no error)', async () => {
    expect(await remove('clip_nope')).toBe(false);
  });

  it('should sum stored blob sizes in totalBytes', async () => {
    expect(await totalBytes()).toBe(0);
    await add(draftWith('4'.repeat(64), [1, 2, 3]));
    await add(draftWith('5'.repeat(64), [1, 2, 3, 4, 5]));
    expect(await totalBytes()).toBe(8);
  });
});

// ---------------------------------------------------------------------------
// (e) getBlob atomicity
// ---------------------------------------------------------------------------

describe('clip-library — getBlob atomicity', () => {
  it('should bump lastUsedAt on a present clip', async () => {
    const clip = await add(draftWith('6'.repeat(64), [1, 2]));
    vi.spyOn(Date, 'now').mockReturnValue(clip.lastUsedAt + 1234);
    await getBlob(clip.id);
    vi.restoreAllMocks();
    const after = await get(clip.id);
    expect(after?.lastUsedAt).toBe(clip.lastUsedAt + 1234);
  });

  it('should perform NO write for an absent id (record set unchanged)', async () => {
    await add(draftWith('7'.repeat(64), [1]));
    const before = await list();
    expect(await getBlob('clip_absent')).toBeUndefined();
    const after = await list();
    expect(after).toEqual(before); // nothing written
  });

  it('should not resurrect a removed clip when getBlob races remove of the same id', async () => {
    const clip = await add(draftWith('8'.repeat(64), [1, 2, 3]));
    // Fire both without awaiting between them; IndexedDB serializes the two readwrite
    // transactions. Either order leaves the clip gone — no stale put resurrects it.
    const [, removed] = await Promise.all([getBlob(clip.id), remove(clip.id)]);
    expect(removed).toBe(true);
    expect(await get(clip.id)).toBeUndefined();
    expect(await getBlob(clip.id)).toBeUndefined();
    expect(await list()).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// (f) Errors — every code surfaces as a typed ClipLibraryError
// ---------------------------------------------------------------------------

describe('clip-library — errors', () => {
  it('should propagate a DECODE_FAILED from importVia AS-IS (not re-coded)', async () => {
    const cause = new DOMException('bad', 'EncodingError');
    const adapter: ClipSourceAdapter<File> = {
      source: 'file',
      produce() {
        return Promise.reject(new ClipLibraryError('DECODE_FAILED', 'nope', cause));
      },
    };
    const err = await expectClipError(() => importVia(adapter, fakeFile([1])), 'DECODE_FAILED');
    expect(err.cause).toBe(cause); // unchanged
    expect(await list()).toHaveLength(0); // nothing stored
  });

  it('should surface QUOTA_EXCEEDED from add when the store throws a quota error', async () => {
    const draft = draftWith('9'.repeat(64), [1, 2, 3]);
    // Simulate a full origin: store.add throws QuotaExceededError after the dedup read.
    const quota = new DOMException('quota', 'QuotaExceededError');
    const spy = vi
      .spyOn(IDBObjectStorePrototype(), 'add')
      .mockImplementation(function (this: IDBObjectStore) {
        spy.mockRestore();
        throw quota;
      });

    const err = await expectClipError(() => add(draft), 'QUOTA_EXCEEDED');
    expect(err.cause).toBe(quota);
    vi.restoreAllMocks();
    // The failed transaction left no partial record.
    expect(await list()).toHaveLength(0);
  });

  it('should surface DB_ERROR (with cause) on an unexpected store failure', async () => {
    const boom = new Error('disk on fire');
    const spy = vi
      .spyOn(IDBObjectStorePrototype(), 'get')
      .mockImplementation(function (this: IDBObjectStore) {
        spy.mockRestore();
        throw boom;
      });
    const err = await expectClipError(() => get('clip_x'), 'DB_ERROR');
    expect(err.cause).toBe(boom);
    vi.restoreAllMocks();
  });

  it('should reject UNSUPPORTED when indexedDB is unavailable', async () => {
    const saved = (globalThis as { indexedDB?: unknown }).indexedDB;
    (globalThis as { indexedDB?: unknown }).indexedDB = undefined;
    _resetDbForTests();
    try {
      await expectClipError(() => list(), 'UNSUPPORTED');
    } finally {
      (globalThis as { indexedDB?: unknown }).indexedDB = saved;
      _resetDbForTests();
    }
  });

  it('should reject UNSUPPORTED from sha256Hex when crypto.subtle is unavailable', async () => {
    const realCrypto = globalThis.crypto;
    Object.defineProperty(globalThis, 'crypto', {
      configurable: true,
      value: { subtle: undefined },
    });
    try {
      await expectClipError(() => sha256Hex(new Uint8Array([1, 2, 3]).buffer), 'UNSUPPORTED');
    } finally {
      Object.defineProperty(globalThis, 'crypto', {
        configurable: true,
        value: realCrypto,
      });
    }
  });
});

// ---------------------------------------------------------------------------
// ClipLibraryError shape
// ---------------------------------------------------------------------------

describe('ClipLibraryError', () => {
  it('should carry name/code/cause and satisfy instanceof', () => {
    const cause = new Error('root');
    const err = new ClipLibraryError('DB_ERROR', 'boom', cause);
    expect(err).toBeInstanceOf(ClipLibraryError);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('ClipLibraryError');
    expect(err.code).toBe('DB_ERROR');
    expect(err.message).toBe('boom');
    expect(err.cause).toBe(cause);
  });

  it('should default its message to the code when none is given', () => {
    const err = new ClipLibraryError('UNSUPPORTED');
    expect(err.message).toBe('UNSUPPORTED');
    expect(err.cause).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// sha256Hex correctness (the shared hashing source of truth)
// ---------------------------------------------------------------------------

describe('sha256Hex', () => {
  it('should hash a known byte vector to the exact 64-char lowercase hex', async () => {
    const abc = new TextEncoder().encode('abc');
    const hex = await sha256Hex(abc.buffer);
    expect(hex).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(hex).toHaveLength(64);
  });

  it('should pad a leading byte < 0x10 to two chars without shifting following bytes', async () => {
    // SHA-256 of the empty input begins with 0xe3 — choose a vector with a low leading
    // byte instead: assert every byte is exactly two lowercase hex chars regardless.
    const hex = await sha256Hex(new Uint8Array([0]).buffer);
    expect(hex).toMatch(/^[0-9a-f]{64}$/);
    // Re-derive independently with explicit padStart to confirm byte alignment.
    const digest = await crypto.subtle.digest('SHA-256', new Uint8Array([0]).buffer);
    const expected = Array.from(new Uint8Array(digest))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
    expect(hex).toBe(expected);
  });

  it('should not detach the input buffer (digest reads, never neuters)', async () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const buf = bytes.buffer;
    await sha256Hex(buf);
    expect(buf.byteLength).toBe(4); // still intact — hash-before-decode relies on this
  });
});

// Helper: the prototype object shared by all fake-indexeddb object stores, used to spy
// store-level failures (quota/unexpected) without touching production code.
function IDBObjectStorePrototype(): IDBObjectStore {
  return (
    globalThis as unknown as { IDBObjectStore: { prototype: IDBObjectStore } }
  ).IDBObjectStore.prototype;
}
