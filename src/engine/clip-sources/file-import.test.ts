// file-import adapter tests — happy + error + edge.
//
// Central concern: the pinned hash-BEFORE-decode / decode-from-copy ordering (design
// §5.1). decodeAudioData DETACHES its ArrayBuffer; if the adapter hashed the same buffer
// after decoding, every clip would hash an empty buffer to one identical digest. These
// tests prove the hash is computed from an intact buffer and is unaffected by the decode
// detaching its (separate) copy.
//
// No real OfflineAudioContext: decodeCtx is an injected stub. The File is a structured-
// clone-safe FakeFile (jsdom's Blob has no arrayBuffer()).

import { describe, it, expect } from 'vitest';
import { createFileImportAdapter } from './file-import';
import { ClipLibraryError, sha256Hex } from '../clip-library';

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

/**
 * Minimal File double. Data props live on the instance; arrayBuffer/slice on the
 * prototype. Each arrayBuffer() returns a FRESH ArrayBuffer copy of the bytes, so a
 * detaching consumer (decodeAudioData) cannot neuter the source bytes.
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
    // A fresh copy each call — mirrors File.arrayBuffer() returning a new buffer.
    return Promise.resolve(this._bytes.slice().buffer);
  }
}

function fakeFile(bytes: number[], name = 'rain.ogg', type = 'audio/ogg'): File {
  return new FakeFile(new Uint8Array(bytes), name, type) as unknown as File;
}

interface DecodeRecord {
  arg: ArrayBuffer;
  argByteLength: number;
}

/**
 * A decodeCtx stub. Records every decodeAudioData call (the buffer it received and its
 * length AT CALL TIME), then DETACHES the argument the way the real API does, and
 * resolves a fake AudioBuffer with the configured duration.
 */
function makeDecodeStub(duration: number | (() => number)): {
  ctx: BaseAudioContext;
  calls: DecodeRecord[];
} {
  const calls: DecodeRecord[] = [];
  const ctx = {
    decodeAudioData(buf: ArrayBuffer): Promise<AudioBuffer> {
      calls.push({ arg: buf, argByteLength: buf.byteLength });
      // Simulate the real detach: transfer the buffer so its byteLength becomes 0.
      try {
        structuredClone(buf, { transfer: [buf] });
      } catch {
        // Some environments cannot transfer; the length record above already captured
        // the pre-detach length, which is all the assertions need.
      }
      const d = typeof duration === 'function' ? duration() : duration;
      return Promise.resolve({ duration: d } as AudioBuffer);
    },
  } as unknown as BaseAudioContext;
  return { ctx, calls };
}

function rejectingDecodeStub(reason: unknown): {
  ctx: BaseAudioContext;
  calls: DecodeRecord[];
} {
  const calls: DecodeRecord[] = [];
  const ctx = {
    decodeAudioData(buf: ArrayBuffer): Promise<AudioBuffer> {
      calls.push({ arg: buf, argByteLength: buf.byteLength });
      return Promise.reject(reason);
    },
  } as unknown as BaseAudioContext;
  return { ctx, calls };
}

async function expectDecodeFailed(fn: () => Promise<unknown>): Promise<ClipLibraryError> {
  try {
    await fn();
  } catch (e) {
    expect(e).toBeInstanceOf(ClipLibraryError);
    expect((e as ClipLibraryError).code).toBe('DECODE_FAILED');
    return e as ClipLibraryError;
  }
  throw new Error('expected produce() to reject with DECODE_FAILED');
}

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe('createFileImportAdapter — happy', () => {
  it('should produce a draft with hash, original file as blob, format, duration, source, meta', async () => {
    const bytes = [1, 2, 3, 4, 5, 6, 7, 8];
    const file = fakeFile(bytes, 'rain.ogg', 'audio/ogg');
    const { ctx } = makeDecodeStub(42.3);
    const adapter = createFileImportAdapter({ decodeCtx: ctx });

    const draft = await adapter.produce(file);

    expect(draft.source).toBe('file');
    expect(draft.blob).toBe(file); // the ORIGINAL File, not a copy
    expect(draft.format).toBe('audio/ogg');
    expect(draft.durationSec).toBe(42.3);
    expect(draft.meta).toEqual({ name: 'rain.ogg' });
    // hash equals an independent SHA-256 of the same bytes.
    const expected = await sha256Hex(new Uint8Array(bytes).buffer);
    expect(draft.hash).toBe(expected);
    expect(draft.hash).toHaveLength(64);
    expect(draft.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('should expose source "file" on the adapter', () => {
    const adapter = createFileImportAdapter({ decodeCtx: makeDecodeStub(1).ctx });
    expect(adapter.source).toBe('file');
  });
});

// ---------------------------------------------------------------------------
// Edge — detachment / ordering (the §5.1 bug class)
// ---------------------------------------------------------------------------

describe('createFileImportAdapter — detachment & ordering (§5.1)', () => {
  it('should hash the intact buffer even though decode detaches its copy', async () => {
    const bytes = [10, 20, 30, 40, 50];
    const file = fakeFile(bytes, 'tone.wav', 'audio/wav');
    const stub = makeDecodeStub(3.0);
    const adapter = createFileImportAdapter({ decodeCtx: stub.ctx });

    const draft = await adapter.produce(file);

    // The decode received a NON-empty buffer (hash ran first, on a separate buffer).
    expect(stub.calls).toHaveLength(1);
    expect(stub.calls[0].argByteLength).toBe(bytes.length);

    // The hash is the correct digest of the real bytes — NOT a digest of an empty
    // buffer (which would be the SHA-256 of zero bytes). Reversed order would yield that.
    const emptyDigest = await sha256Hex(new Uint8Array(0).buffer);
    expect(draft.hash).not.toBe(emptyDigest);
    const expected = await sha256Hex(new Uint8Array(bytes).buffer);
    expect(draft.hash).toBe(expected);
  });

  it('should give different hashes for two different files (order proven, not collapsed)', async () => {
    const a = fakeFile([1, 1, 1, 1], 'a.ogg');
    const b = fakeFile([2, 2, 2, 2], 'b.ogg');
    const adapterA = createFileImportAdapter({ decodeCtx: makeDecodeStub(1).ctx });
    const adapterB = createFileImportAdapter({ decodeCtx: makeDecodeStub(1).ctx });

    const draftA = await adapterA.produce(a);
    const draftB = await adapterB.produce(b);

    // If the order were reversed (hash a detached buffer), both would hash empty → equal.
    expect(draftA.hash).not.toBe(draftB.hash);
  });

  it('should keep the same hash across re-imports of identical bytes (dedup basis)', async () => {
    const adapter = createFileImportAdapter({ decodeCtx: makeDecodeStub(5).ctx });
    const h1 = (await adapter.produce(fakeFile([9, 8, 7], 'x.ogg'))).hash;
    const h2 = (await adapter.produce(fakeFile([9, 8, 7], 'x-copy.ogg'))).hash;
    expect(h1).toBe(h2);
  });
});

// ---------------------------------------------------------------------------
// Error — decode failures
// ---------------------------------------------------------------------------

describe('createFileImportAdapter — decode errors', () => {
  it('should throw DECODE_FAILED naming the file when decodeAudioData rejects', async () => {
    const cause = new DOMException('not audio', 'EncodingError');
    const { ctx } = rejectingDecodeStub(cause);
    const adapter = createFileImportAdapter({ decodeCtx: ctx });

    const err = await expectDecodeFailed(() => adapter.produce(fakeFile([0, 0], 'broken.bin', '')));
    expect(err.message).toContain('broken.bin');
    expect(err.cause).toBe(cause); // original cause preserved
  });

  it('should throw DECODE_FAILED for a zero duration (decoded to zero-length audio)', async () => {
    const { ctx } = makeDecodeStub(0);
    const adapter = createFileImportAdapter({ decodeCtx: ctx });
    const err = await expectDecodeFailed(() => adapter.produce(fakeFile([1, 2, 3], 'silent.ogg')));
    expect(err.message).toContain('silent.ogg');
    expect(err.message).toContain('zero-length');
  });

  it('should throw DECODE_FAILED for a NaN duration', async () => {
    const { ctx } = makeDecodeStub(NaN);
    const adapter = createFileImportAdapter({ decodeCtx: ctx });
    await expectDecodeFailed(() => adapter.produce(fakeFile([1, 2, 3], 'nan.ogg')));
  });
});

// ---------------------------------------------------------------------------
// Edge — decode context reuse
// ---------------------------------------------------------------------------

describe('createFileImportAdapter — decode context', () => {
  it('should use the injected decodeCtx and reuse it across two produces', async () => {
    const stub = makeDecodeStub(2.5);
    const adapter = createFileImportAdapter({ decodeCtx: stub.ctx });

    await adapter.produce(fakeFile([1], 'one.ogg'));
    await adapter.produce(fakeFile([2], 'two.ogg'));

    // Both imports decoded through the SAME injected stub (two recorded calls).
    expect(stub.calls).toHaveLength(2);
  });
});
