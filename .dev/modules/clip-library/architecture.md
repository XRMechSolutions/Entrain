# Architecture: clip-library

Execution-focused map for the implementing agent. The WHY lives in the Tier-3 planning docs
(`.dev/planning/modules/clip-library/{design,interfaces,edge-cases,dependencies}.md`) and the
normative seam in `.dev/planning/phase2-audio-architecture.md` §0 / §6. Read those before coding;
this file is the summary.

## Role (one paragraph)

`clip-library` is the device-local, content-addressed store of audio **clips** and the
**extensibility seam** (`ClipSourceAdapter`) by which any sound source — imported files, TTS,
future mic recordings — becomes a stored, reusable clip. It owns IndexedDB persistence of encoded
audio `Blob`s + metadata and dedup by content hash. It imports **no other project module** (a clip
id is just a string; `session-model` references clip ids but the two never import each other —
D-023, design §1). Layer 0 (Phase 2), no transport coupling.

## File structure

| File | Contents |
|---|---|
| `src/engine/clip-library.ts` | Types (`ClipSource`, `ClipMeta`, `ClipDraft`, `Clip`, `ClipSourceAdapter`), `ClipLibraryError` + `ClipLibraryErrorCode`, lazy DB open/upgrade, and the public functions `add` / `importVia` / `get` / `getByHash` / `getBlob` / `list` / `remove` / `totalBytes`, plus the `sha256Hex` hashing helper and the `createFileImportAdapter` re-export. |
| `src/engine/clip-sources/file-import.ts` | `createFileImportAdapter(opts?)` — the Phase-2.0 `ClipSourceAdapter<File>`: read bytes once → hash FIRST → decode a copy → package a `ClipDraft`. Hashing helper is shared with `clip-library.ts` (single `sha256Hex` source of truth). |
| `src/engine/clip-library.test.ts` | Storage + dedup + collision + atomicity + error tests (vitest, jsdom). |
| `src/engine/clip-sources/file-import.test.ts` | Adapter tests: detached-buffer ordering, decode failure, zero/NaN duration. |

## Public interface (contract — see interfaces.md for full types)

```ts
add(draft: ClipDraft): Promise<Clip>                       // dedup by full hash; mint id; one readwrite txn
importVia<T>(a: ClipSourceAdapter<T>, input: T): Promise<Clip>  // add(await a.produce(input)); rethrows AS-IS
get(id: string): Promise<Clip | undefined>                 // by primary key 'id'
getByHash(hash: string): Promise<Clip | undefined>         // via 'by-hash' index
getBlob(id: string): Promise<Blob | undefined>             // atomic read + lastUsedAt bump (one readwrite txn)
list(): Promise<Clip[]>                                     // metadata only, no blobs
remove(id: string): Promise<boolean>                       // true if deleted
totalBytes(): Promise<number>                              // sum of stored blob sizes
createFileImportAdapter(opts?: { decodeCtx?: BaseAudioContext }): ClipSourceAdapter<File>
```

Errors: every async fn rejects with `ClipLibraryError` (codes `QUOTA_EXCEEDED` | `DECODE_FAILED` |
`UNSUPPORTED` | `DB_ERROR`); never a raw `DOMException`, never a synchronous throw, never a silent
default. A missing/evicted clip is `undefined`, **not** an error (design §1, edge-cases §4).

## Persisted schema (contract — literal names, interfaces.md §6)

- DB `binaural-clips` (version 1); store `clips` with `keyPath: 'id'` (in-line primary key).
- Index `by-hash` on `hash`, `{ unique: true }` (dedup; uniqueness backstops a concurrent
  double-import — design §6).
- Index `by-source` on `source`, `{ unique: false }` (future "filter by source" UI).
These names and the `id` keyPath only change under a versioned `upgrade`.

## Load-bearing rules the agent must not decide on its own

- **Hex encoding (design §2):** lowercase, `padStart(2, '0')` per byte. One `sha256Hex` shared by
  storage and every adapter so identical bytes agree on a digest.
- **Hash-before-decode (BLOCKER, design §5.1 / interfaces §7):** `decodeAudioData` **detaches** its
  `ArrayBuffer`. Read `file.arrayBuffer()` once, hash that buffer FIRST while intact, decode
  `buf.slice(0)` (a disposable copy), store the original `File` as the blob.
- **id-prefix collision (design §2.1 / edge-cases §8):** dedup on full hash first; on a different-
  hash 16-char id collision, lengthen the prefix in fixed 8-char steps up to the full 64-char hash —
  deterministic, content-derived, atomic inside `add`'s single transaction.
- **`getBlob` atomicity (design §6.1):** read + `lastUsedAt` bump in ONE `readwrite` transaction;
  absent id → `undefined`, no write.
- **`importVia` transparency (design §6.3):** thin compose; rethrow the adapter's typed error AS-IS,
  no wrapping/re-coding.
- **Storage-owned fields (design §5.2):** `add` sets `bytes = draft.blob.size`, `createdAt =
  lastUsedAt = Date.now()`; an adapter never supplies these.
- **`persist()` once (design §7):** best-effort `navigator.storage.persist()` on first use; absence
  degrades gracefully, never throws.

## Dependencies

- **Runtime:** `idb` ^8 (promise wrapper over IndexedDB; ~1 KB, zero transitive deps — dependencies.md).
  This is the module's prerequisite task (added to `package.json` first; no `dependencies` block
  exists yet in the repo).
- **Built-in platform APIs:** `crypto.subtle.digest('SHA-256', …)`, `OfflineAudioContext.decodeAudioData`,
  `navigator.storage.persist()/.estimate()`, `Blob`/`File` (dependencies.md). No other npm package.
- **Project modules:** none (D-023). Consumed by `layer-engine` (`getBlob` → decode), `renderer`
  (pre-decode via `getBlob`, architecture §5.6), `tts-local` / `voice-script` (authoring produces
  drafts and `clips: Clip[]`), and `ui`. None of these import back into this module's internals.

## Cohesion guardrails (acceptance, not optional)

The existing byte-identical guardrail suites must run green BEFORE and AFTER this module lands —
this module touches none of their code, so any change is a regression to investigate:
`src/engine/automation.test.ts` (scheduleLane extraction), `src/engine/audio-engine.test.ts`
(master-flag default internal), `src/engine/transport-master-gain.test.ts` (unchanged). No-click
ramps (D-008) and single-writer params (D-019) are not in this module's surface but must remain
intact across the wider suite.

## Test runner

vitest (`npm test` → `vitest run`), jsdom environment. IndexedDB is provided by jsdom/fake-indexeddb
shims as the existing suite already does; `decodeCtx` is injected into the file-import adapter so
tests stub decode without a real `OfflineAudioContext`.
