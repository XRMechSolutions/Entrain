// file-import — the Phase-2.0 ClipSourceAdapter<File>.
//
// Turns a user-picked File into a ClipDraft: read the bytes once, HASH FIRST (while the
// buffer is intact), then DECODE a COPY (decodeAudioData detaches the buffer it is
// given). The stored blob is the original File. This hash-before-decode / decode-from-
// copy ordering is the pinned BLOCKER (design §5.1 / interfaces §7): reversing it would
// hash a detached, empty buffer and collapse every import to one identical digest.
//
// Imports only sha256Hex + ClipLibraryError from clip-library (the single hashing source
// of truth so every adapter agrees on identical bytes). No other project module.

import { ClipLibraryError, sha256Hex } from '../clip-library';
import type { ClipDraft, ClipSourceAdapter } from '../clip-library';

export interface FileImportOptions {
  /**
   * Injected for tests; default is a throwaway, reused OfflineAudioContext. Only
   * decodeAudioData is used (it ignores the context's own length/rate — edge-cases §7).
   */
  decodeCtx?: BaseAudioContext;
}

/**
 * Lazily build (and reuse) a minimal throwaway OfflineAudioContext for decodeAudioData.
 * `new OfflineAudioContext(1, 1, 44100)` is safe across browsers (length >= 1, valid
 * rate) and needs no user gesture, so import works before any play gesture.
 */
function makeDefaultDecodeCtx(): BaseAudioContext {
  return new OfflineAudioContext(1, 1, 44100) as unknown as BaseAudioContext;
}

/**
 * Create a ClipSourceAdapter<File> (source: 'file'). produce(file) follows the exact
 * ordered rule (design §5.1):
 *   1. buf = await file.arrayBuffer()  — read bytes ONCE (the File/Blob is not consumed)
 *   2. hash = await sha256Hex(buf)     — hash FIRST, while buf is intact (digest does
 *                                        not detach)
 *   3. decodeAudioData(buf.slice(0))   — decode a COPY; the copy is what gets detached,
 *                                        buf stays intact and unused afterward
 *   4. durationSec = decoded.duration  — must be finite and > 0
 *   5. return the draft with blob = the ORIGINAL File (never buf or the copy)
 */
export function createFileImportAdapter(
  opts?: FileImportOptions,
): ClipSourceAdapter<File> {
  let ctx: BaseAudioContext | undefined = opts?.decodeCtx;
  // Default context is created once, lazily, and reused across imports (edge-cases §7).
  const getCtx = (): BaseAudioContext => {
    if (!ctx) ctx = makeDefaultDecodeCtx();
    return ctx;
  };

  return {
    source: 'file',
    async produce(file: File): Promise<ClipDraft> {
      // 1. Read the file's bytes exactly once. The File/Blob itself is not consumed and
      //    is what we store as the clip blob.
      const buf = await file.arrayBuffer();

      // 2. Hash the intact buffer FIRST (digest reads but does not detach it).
      const hash = await sha256Hex(buf);

      // 3. Decode a fresh COPY — never `buf` directly. The copy is what decodeAudioData
      //    detaches; `buf` stays intact and unused afterward.
      let decoded: AudioBuffer;
      try {
        decoded = await getCtx().decodeAudioData(buf.slice(0));
      } catch (cause) {
        throw new ClipLibraryError(
          'DECODE_FAILED',
          `Could not read "${file.name}" as audio`,
          cause,
        );
      }

      // 4. A 0 / NaN duration is a decode failure — never stored with durationSec: 0.
      if (!(decoded.duration > 0)) {
        throw new ClipLibraryError(
          'DECODE_FAILED',
          `"${file.name}" decoded to zero-length audio`,
        );
      }

      // 5. The stored blob is the ORIGINAL File; neither ArrayBuffer is retained.
      return {
        hash,
        blob: file,
        format: file.type,
        durationSec: decoded.duration,
        source: 'file',
        meta: { name: file.name },
      };
    },
  };
}
