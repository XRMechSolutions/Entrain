# Tasks: clip-library
# Planning: .dev/planning/modules/clip-library/
# Architecture: .dev/modules/clip-library/architecture.md
# Standards: security, safety
# Stack: typescript

## Agent Briefing

`clip-library` is the device-local, content-addressed IndexedDB store of audio clips and the
`ClipSourceAdapter` extensibility seam by which any sound source becomes a stored, reusable clip.
It imports no other project module (a clip id is just a string — D-023); it is consumed by
`layer-engine`, `renderer`, `tts-local`, `voice-script`, and `ui`. Layer 0 (Phase 2), pure
storage + Web Crypto + a decode-at-import adapter, no transport coupling. Primary file
`src/engine/clip-library.ts`; the Phase-2.0 adapter lives in `src/engine/clip-sources/file-import.ts`.

This work is on the serialization/storage boundary: dedup, the id-prefix collision rule, `getBlob`
atomicity, and the hash-before-decode ordering are all correctness-critical (T1). Two persistence
mistakes — hashing a detached buffer, or a non-atomic read-modify-write of `lastUsedAt` — silently
corrupt the entire library, so they are pinned in the planning docs and must be implemented exactly.

## References
- .dev/planning/modules/clip-library/design.md
- .dev/planning/modules/clip-library/interfaces.md
- .dev/planning/modules/clip-library/edge-cases.md
- .dev/planning/modules/clip-library/dependencies.md
- .dev/planning/phase2-audio-architecture.md  (§0 the Clip/ClipSourceAdapter/ClipDraft seam; §5.6 renderer pre-decodes via getBlob; §6 contract spine + build order)

## Dependencies
- None within this module's planning graph. `clip-library` imports no other project module (D-023).
- Build-order note (phase2-audio-architecture.md §6): the `session-model` schema bump (§0) defines
  `Layer.source.clipId`, which *references* clip ids but does not import this module — so this module
  can be built independently and in parallel with the session-model schema task. No code dependency.

## Tasks

### Layer 0: Prerequisite

- [x] [config] Add the `idb` ^8 runtime dependency to package.json | file: package.json | model: T3
  - Ref: .dev/planning/modules/clip-library/dependencies.md @ idb (IndexedDB promise wrapper)
  - Ref: .dev/planning/modules/clip-library/dependencies.md @ Dependency summary
  - Behavior: add a `"dependencies"` block (none exists yet in the repo — the project has only
    devDependencies today) with `"idb": "^8"`; run the install so `node_modules/idb` and the
    lockfile resolve. Do not add Dexie or any other storage package — `idb` is the only one (zero
    transitive deps).
  - Accepts: current package.json (no `dependencies` key).
  - Creates: `dependencies: { idb: "^8" }` in package.json; resolved lockfile entry.
  - Tests: `npm test` (vitest) still runs green — config-only change adds no failures; `import { openDB } from 'idb'` resolves.

### Layer 1: Storage core

- [x] [impl] Define clip-library types, error class, and the shared sha256Hex hex helper | file: src/engine/clip-library.ts | model: T1
  - Ref: .dev/planning/modules/clip-library/interfaces.md @ 1. Types
  - Ref: .dev/planning/modules/clip-library/interfaces.md @ 2. Adapter interface (the extensibility seam)
  - Ref: .dev/planning/modules/clip-library/interfaces.md @ 4. Errors
  - Ref: .dev/planning/modules/clip-library/design.md @ 2. Data model  (hex encoding: lowercase, padStart(2,'0') per byte — the padStart is mandatory)
  - Ref: .dev/planning/modules/clip-library/design.md @ 5. Hashing & decode
  - Ref: .dev/planning/modules/clip-library/edge-cases.md @ 1. Platform unavailable
  - Ref: .dev/planning/phase2-audio-architecture.md @ 0. Gating Prerequisite  (the Clip/ClipSourceAdapter/ClipDraft seam shapes are normative)
  - Accepts: nothing (pure type + helper module surface).
  - Creates: `ClipSource`, `ClipMeta`, `ClipDraft`, `Clip`, `ClipSourceAdapter<TInput>` types;
    `ClipLibraryErrorCode` union and `ClipLibraryError extends Error` (readonly `name`/`code`/`cause`,
    prototype restored so `instanceof` holds after transpile);
    an exported `sha256Hex(bytes: ArrayBuffer): Promise<string>` that calls
    `crypto.subtle.digest('SHA-256', bytes)` and encodes `Array.from(new Uint8Array(d)).map(b => b.toString(16).padStart(2,'0')).join('')` → 64-char lowercase hex.
  - Behavior: `sha256Hex` reads but does NOT detach its input buffer (digest does not neuter); this
    is the single hashing source of truth reused by storage and every adapter so identical bytes agree.
    The seam types (`Clip`/`ClipSourceAdapter`/`ClipDraft`) are byte-identical to the architecture §0/§6 surface.
  - Handles: `crypto.subtle` unavailable (insecure context) → reject `ClipLibraryError('UNSUPPORTED')` (edge-cases §1), never a raw error.
  - Tests: a known byte vector hashes to the exact expected 64-char lowercase hex; a digest whose
    leading byte is `< 0x10` still emits two chars (padStart) and does NOT shift following bytes;
    `ClipLibraryError` carries `code` + `cause` and `instanceof` holds; an absent `crypto.subtle` path rejects `UNSUPPORTED`.
  - Stubs expected: storage functions referenced by later tasks may be imported but unimplemented until the next tasks — register in stub-registry if so.

- [x] [impl] Implement lazy DB open + versioned upgrade (binaural-clips v1, clips store, by-hash/by-source indexes) and persist() | file: src/engine/clip-library.ts | model: T1 [data]
  - Ref: .dev/planning/modules/clip-library/design.md @ 4. Storage design (IndexedDB)
  - Ref: .dev/planning/modules/clip-library/interfaces.md @ 6. Persisted IndexedDB schema (contract — literal names)
  - Ref: .dev/planning/modules/clip-library/design.md @ 7. Storage pressure & persistence
  - Ref: .dev/planning/modules/clip-library/edge-cases.md @ 1. Platform unavailable
  - Ref: .dev/planning/modules/clip-library/dependencies.md @ idb (IndexedDB promise wrapper)
  - Accepts: nothing (lazy, cached singleton).
  - Creates: an internal `getDb()` using `idb`'s `openDB('binaural-clips', 1, { upgrade })`; the
    `upgrade` creates `db.createObjectStore('clips', { keyPath: 'id' })` then
    `store.createIndex('by-hash', 'hash', { unique: true })` and
    `store.createIndex('by-source', 'source', { unique: false })`. DB handle memoized for the page
    lifetime (no explicit close). A one-time best-effort `navigator.storage.persist()` call on first
    open (swallow rejection/absence).
  - Behavior: literal names `binaural-clips` / `clips` / `by-hash` / `by-source` and keyPath `id` are
    the persisted contract — fixed at version 1, only change under a versioned upgrade. On open/upgrade
    failure the memoized promise rejects so every public call surfaces `UNSUPPORTED`/`DB_ERROR`.
  - Handles: IndexedDB missing/blocked → reject `ClipLibraryError('UNSUPPORTED')` (edge-cases §1);
    `persist()` absent or rejecting → ignored, never propagated (edge-cases §2, design §7).
  - Tests: first open creates the store with keyPath `id` and BOTH indexes with the exact unique
    flags (`by-hash` unique, `by-source` non-unique); a missing `indexedDB` global rejects
    `UNSUPPORTED`; `persist()` throwing does not fail the open.

- [x] [impl] Implement get / getByHash / list / remove / totalBytes | file: src/engine/clip-library.ts | model: T2 [data]
  - Ref: .dev/planning/modules/clip-library/interfaces.md @ 3. Functions
  - Ref: .dev/planning/modules/clip-library/design.md @ 4. Storage design (IndexedDB)  (list = metadata only)
  - Ref: .dev/planning/modules/clip-library/edge-cases.md @ 4. Missing clip at read time (the portability case)
  - Ref: .dev/planning/modules/clip-library/edge-cases.md @ 6. Delete semantics
  - Accepts: `get(id)` / `remove(id)` a clip id; `getByHash(hash)` a full 64-char hash; `list()` / `totalBytes()` nothing.
  - Creates: `get` (read by primary key `id`); `getByHash` (read via the `by-hash` index); `list`
    (`getAll` then strip each record's `blob` → metadata-only `Clip[]`, so browsing never pulls audio
    into memory); `remove` (delete by id, resolve `true` iff a record existed); `totalBytes`
    (sum of stored `blob.size`).
  - Behavior: `list` returns the stored `Clip` minus its blob field; callers fetch bytes via `getBlob`
    only when about to decode/play/render (design §4).
  - Handles: unknown/evicted id → `get`/`getByHash` resolve `undefined` (FIRST-CLASS expected state,
    NOT an error — edge-cases §4); `remove` of an unknown id → `false`, no error (edge-cases §6);
    any unexpected IndexedDB failure → `ClipLibraryError('DB_ERROR')` preserving `.cause`, never a raw DOMException.
  - Tests: `get`/`getByHash` of an absent id resolve `undefined` (not throw); `list` returns records
    with no `blob` field and never loads blobs; `remove` returns `true` then `false` on re-delete of
    the same id; `totalBytes` equals the sum of stored sizes; a forced DB failure surfaces `DB_ERROR` with `.cause` set.

- [x] [impl] Implement add(): dedup-by-full-hash + id-prefix collision + ClipDraft→Clip mapping, all in ONE readwrite transaction | file: src/engine/clip-library.ts | model: T1 [data]
  - Ref: .dev/planning/modules/clip-library/design.md @ 4. Storage design (IndexedDB)  (the add() transaction)
  - Ref: .dev/planning/modules/clip-library/design.md @ 2.1 id-prefix collision (different full hash, same 16-char prefix)
  - Ref: .dev/planning/modules/clip-library/design.md @ 5.2 ClipDraft → Clip mapping (what add writes)
  - Ref: .dev/planning/modules/clip-library/design.md @ 6. Lifecycle & concurrency  (concurrent add of same hash)
  - Ref: .dev/planning/modules/clip-library/edge-cases.md @ 2. Storage pressure
  - Ref: .dev/planning/modules/clip-library/edge-cases.md @ 5. Dedup & concurrency
  - Ref: .dev/planning/modules/clip-library/edge-cases.md @ 8. id-prefix collision (different full hash, same 16-char id)
  - Accepts: a `ClipDraft` (`hash`, `blob`, `format`, `durationSec`, `source`, `meta`).
  - Creates: `add(draft)` — in ONE `readwrite` transaction on `clips`: (1) look up `draft.hash` via
    `by-hash`; if present, bump that record's `lastUsedAt = Date.now()`, `put`, return it (dedup — no
    second copy, `id`/`createdAt`/`bytes` left as stored). (2) Else mint `id = 'clip_' + hash.slice(0,16)`;
    if that id is held by a DIFFERENT full hash, lengthen the prefix in fixed 8-char steps
    (`slice(0,24)`, `slice(0,32)`, … up to the full 64-char hash), stopping at the first id not bound
    to a different full hash. (3) Build the `Clip` per the §5.2 mapping — `bytes = draft.blob.size`,
    `createdAt = lastUsedAt = Date.now()` set by storage (adapter never supplies these) — write, return it.
  - Behavior: the hash read, the collision-id read, and the write all share the single transaction so
    the dedup/collision decision is atomic against a racing `add` (design §2.1, §6). The collision step
    sequence is hash-derived → the same content resolves to the same id on every device.
  - Handles: `QuotaExceededError` → `ClipLibraryError('QUOTA_EXCEEDED')`, failed transaction rolls back
    leaving no partial record (edge-cases §2); concurrent `add` of the same hash → the unique `by-hash`
    constraint fails the second write, which is caught, re-read by hash, returns the existing record
    (idempotent, no duplicate, no throw — edge-cases §5, design §6); any other failure → `DB_ERROR` with `.cause`.
  - Tests (happy): a fresh draft writes a `Clip` with `id='clip_'+hash.slice(0,16)`, `bytes=blob.size`,
    `createdAt===lastUsedAt`. Tests (dedup): re-`add` of the same full hash returns the SAME id, writes
    no second blob, bumps `lastUsedAt`, leaves `createdAt`/`bytes` unchanged. Tests (edge — collision):
    two drafts with different full hashes sharing the first 16 hex chars → second gets a longer-prefix
    id, first clip's bytes are never overwritten, and the resolved id is deterministic on a repeat run.
    Tests (error): a simulated quota failure rejects `QUOTA_EXCEEDED` with no partial record left; a
    simulated concurrent same-hash write resolves to the single existing record.

- [x] [impl] Implement getBlob(): atomic read + lastUsedAt bump in one readwrite transaction | file: src/engine/clip-library.ts | model: T1 [data]
  - Ref: .dev/planning/modules/clip-library/design.md @ 6.1 getBlob lastUsedAt — single readwrite transaction
  - Ref: .dev/planning/modules/clip-library/design.md @ 6.2 Concurrent getBlob / remove / add interleaving (same id)
  - Ref: .dev/planning/modules/clip-library/interfaces.md @ 3. Functions  (getBlob)
  - Ref: .dev/planning/modules/clip-library/edge-cases.md @ 4. Missing clip at read time (the portability case)
  - Ref: .dev/planning/modules/clip-library/edge-cases.md @ 5. Dedup & concurrency  (concurrent getBlob and remove)
  - Ref: .dev/planning/phase2-audio-architecture.md @ 5. Renderer — Reuse the Bus Offline  (step 6: renderer PRE-DECODEs every clip via getBlob before scheduling)
  - Accepts: a clip id.
  - Creates: `getBlob(id)` — open ONE `readwrite` transaction on `clips`, `store.get(id)`; if absent
    resolve `undefined` with NO write; if present set `record.lastUsedAt = Date.now()`, `store.put(record)`
    INSIDE the same transaction, then resolve `record.blob`.
  - Behavior: read and the bumped-`lastUsedAt` write are atomic — no other transaction interleaves
    between them, so the LRU timestamp can never be lost to, or clobber, a concurrent op on the same
    record; and a `remove` that commits between read and put is impossible (no resurrected-clip stale put — design §6.2).
  - Handles: absent/evicted id → `undefined`, no write, no error (edge-cases §4); concurrent `remove`
    of the same id → whichever transaction commits first wins, both orders safe (design §6.2);
    unexpected failure → `DB_ERROR` with `.cause`.
  - Tests (happy): `getBlob` of a stored clip returns its `Blob` and advances `lastUsedAt`. Tests
    (edge): `getBlob` of an absent id returns `undefined` and performs NO write (verify the record set
    is unchanged). Tests (concurrency): a `getBlob` interleaved with `remove` of the same id never
    resurrects the deleted record via a stale put — after both settle the clip is gone and `getBlob` returns `undefined`.

- [x] [impl] Implement importVia() — transparent compose of adapter.produce + add | file: src/engine/clip-library.ts | model: T1
  - Ref: .dev/planning/modules/clip-library/design.md @ 6.3 importVia error propagation
  - Ref: .dev/planning/modules/clip-library/interfaces.md @ 3. Functions  (importVia)
  - Ref: .dev/planning/modules/clip-library/edge-cases.md @ 3. Adapter / decode failures
  - Accepts: a `ClipSourceAdapter<T>` and its `input: T`.
  - Creates: `importVia(adapter, input)` = `await add(await adapter.produce(input))` — a thin,
    transparent compose with NO error translation of its own.
  - Behavior: an error thrown by `adapter.produce` (e.g. `DECODE_FAILED`) propagates AS-IS — same
    `code`/`message`/`cause`, never wrapped into `DB_ERROR`; an `add`-stage error
    (`QUOTA_EXCEEDED`/`DB_ERROR`) likewise propagates unchanged. The caller always sees one typed
    `ClipLibraryError` whose `code` names the real failure stage.
  - Handles: produce-stage vs add-stage errors both rethrown unchanged (design §6.3); no swallowed or re-coded errors.
  - Tests (happy): `importVia` with a stub adapter returns the `Clip` from `add`. Tests (error): a
    stub adapter throwing `DECODE_FAILED` → `importVia` rejects with that exact code/cause (NOT
    re-coded); an `add`-stage `QUOTA_EXCEEDED` propagates unchanged.

### Layer 2: File-import adapter

- [x] [impl] Implement createFileImportAdapter — hash-before-decode, decode-from-copy, store the original File | file: src/engine/clip-sources/file-import.ts | model: T1
  - Ref: .dev/planning/modules/clip-library/design.md @ 5.1 file-import buffer handling (BLOCKER — pinned)
  - Ref: .dev/planning/modules/clip-library/interfaces.md @ 7. file-import buffer handling (worked example)
  - Ref: .dev/planning/modules/clip-library/interfaces.md @ 2. Adapter interface (the extensibility seam)
  - Ref: .dev/planning/modules/clip-library/design.md @ 3. The adapter seam (ClipSourceAdapter)
  - Ref: .dev/planning/modules/clip-library/edge-cases.md @ 3. Adapter / decode failures
  - Ref: .dev/planning/modules/clip-library/edge-cases.md @ 7. Decode context
  - Accepts: `createFileImportAdapter(opts?: { decodeCtx?: BaseAudioContext })`; the produced adapter's `produce(file: File)`.
  - Creates: a `ClipSourceAdapter<File>` with `source: 'file'`. `produce(file)` follows the EXACT
    ordered rule: (1) `const buf = await file.arrayBuffer()` — read bytes ONCE (the File/Blob is not
    consumed). (2) `const hash = await sha256Hex(buf)` — hash FIRST, while `buf` is intact (digest does
    not detach). (3) `decodeCtx.decodeAudioData(buf.slice(0))` — decode a COPY; the copy is what gets
    detached, `buf` stays intact and unused after. (4) `durationSec = decoded.duration`, which must be
    finite and `> 0`. (5) return `{ hash, blob: file, format: file.type, durationSec, source: 'file', meta: { name: file.name } }`.
    Default `decodeCtx` is a throwaway reused `new OfflineAudioContext(1, 1, 44100)`; `opts.decodeCtx`
    is injected for tests. Imports `sha256Hex` from `clip-library.ts` (single hashing source of truth).
  - Behavior: the hash input and the decode input are NEVER the same buffer — reversing the order
    (decode then hash) would hash a detached/empty buffer and collapse every import to one identical
    digest. Neither ArrayBuffer is retained after `produce` returns; the stored blob is the original `File`.
  - Handles: non-audio/corrupt/zero-length/unsupported-codec input → `decodeAudioData` rejects → throw
    `ClipLibraryError('DECODE_FAILED', 'Could not read "<name>" as audio', cause)` (edge-cases §3); a
    decode that succeeds but yields `duration` 0/NaN → `DECODE_FAILED` ("decoded to zero-length audio"),
    never stored with `durationSec: 0` (edge-cases §3); `OfflineAudioContext(1,1,44100)` minimal
    construction is safe across browsers, context reused across imports (edge-cases §7); Promise overload of `decodeAudioData` only.
  - Tests (happy): a valid audio file → draft with correct `hash`, `blob === file`, `format`,
    `durationSec === decoded.duration`, `source:'file'`, `meta.name`. Tests (edge — detachment): the
    hash equals an independent `sha256Hex` of the file bytes EVEN THOUGH decode detaches its copy — i.e.
    detachment of the decode copy does not change the hash; verify `buf` is not the buffer passed to
    decode, and two different files hash differently (order proven). Tests (error): a stub `decodeCtx`
    whose `decodeAudioData` rejects → `DECODE_FAILED` naming the file; a stub returning `{ duration: 0 }`
    (and NaN) → `DECODE_FAILED`, nothing stored; the injected `decodeCtx` is used and reused across two produces.

### Layer 3: Tests

- [x] [test] End-to-end clip-library + file-import tests: dedup, detachment, collision, atomicity, errors | file: src/engine/clip-library.test.ts | model: T1Lite
  - Ref: .dev/planning/modules/clip-library/interfaces.md @ 5. Example  (round-trip importVia → getBlob)
  - Ref: .dev/planning/modules/clip-library/edge-cases.md @ 5. Dedup & concurrency
  - Ref: .dev/planning/modules/clip-library/edge-cases.md @ 8. id-prefix collision (different full hash, same 16-char id)
  - Ref: .dev/planning/modules/clip-library/design.md @ 5.1 file-import buffer handling (BLOCKER — pinned)
  - Ref: .dev/planning/modules/clip-library/design.md @ 6.1 getBlob lastUsedAt — single readwrite transaction
  - Ref: .dev/planning/modules/clip-library/edge-cases.md @ 1. Platform unavailable  (UNSUPPORTED)
  - Accepts: a fresh fake IndexedDB per test (reset between tests, as the existing engine suite does) and an injected stub `decodeCtx`.
  - Creates: `src/engine/clip-library.test.ts` and `src/engine/clip-sources/file-import.test.ts`
    covering, at minimum: (a) import → `get`/`getBlob` round-trip matches interfaces §5; (b) DEDUP —
    importing the same file/bytes twice yields the same `clip.id`, one stored blob, bumped `lastUsedAt`;
    (c) DETACHMENT — the file-import hash is unaffected by decode detaching its copy (the central
    §5.1 bug class); (d) COLLISION — two distinct full hashes sharing 16 prefix chars resolve to
    distinct, deterministic ids without overwrite; (e) `getBlob` ATOMICITY — absent id → `undefined`
    with no write, and a `getBlob`/`remove` race never resurrects a clip; (f) ERRORS — `DECODE_FAILED`,
    `QUOTA_EXCEEDED`, `UNSUPPORTED`, `DB_ERROR` each surface as typed `ClipLibraryError`, never raw.
  - Behavior: tests stub decode via the injected `decodeCtx` so no real `OfflineAudioContext` is needed;
    they assert observable storage state (record presence, blob identity, timestamps, id strings), not internals.
  - Handles: this task is the verification of every edge case in edge-cases.md §1–§8 referenced above.
  - Tests: this IS the test task — happy + error + edge for the whole module surface; all green under `npm test`.

- [x] [audit] Cohesion guardrail check — existing byte-identical suites green before and after | file: .dev/.task-state/clip-library/guardrail-check.md | model: T2
  - Ref: .dev/planning/phase2-audio-architecture.md @ Test retargets (existing files)  (automation/audio-engine/transport-master-gain guardrails)
  - Ref: .dev/modules/clip-library/architecture.md @ Cohesion guardrails (acceptance, not optional)
  - Behavior: this module touches NONE of the existing engine code, so the guardrail suites must be
    byte-identical-green both before this module's work and after it lands. Run the full suite and
    confirm `src/engine/automation.test.ts` (scheduleLane extraction), `src/engine/audio-engine.test.ts`
    (master-flag default internal), and `src/engine/transport-master-gain.test.ts` (unchanged) all pass
    with no edits to their files. No-click ramps (D-008) and single-writer params (D-019) elsewhere in
    the suite remain intact.
  - Handles: any new failure in those three suites is a regression to investigate, not to be silenced
    by editing the guardrail tests.
  - Tests: `npm test` (full suite, not just clip-library) green; the three named guardrail files
    unmodified (verify via git diff status). Write the before/after result to .dev/.task-state/clip-library/guardrail-check.md.

## Behavioral Audit (runs after all tasks above are [x])

- [x] [audit] Module behavioral audit | file: .dev/.task-state/clip-library/behavioral-audit.md | model: T1
  - Ref: C:/Projects/.dev-shared/behavioral-audit.md — Module Behavioral Audit checklist
  - Ref: .dev/planning/modules/clip-library/interfaces.md — every public interface must be verified (add, importVia, get, getByHash, getBlob, list, remove, totalBytes, createFileImportAdapter, ClipLibraryError)
  - Ref: .dev/planning/modules/clip-library/design.md — verify intended behavior matches implementation (dedup, §2.1 collision, §5.1 hash-before-decode, §5.2 mapping, §6.1 getBlob atomicity, §6.3 importVia transparency)
  - Ref: .dev/planning/modules/clip-library/edge-cases.md — verify all documented edge cases §1–§8 are handled
  - Ref: .dev/planning/phase2-audio-architecture.md @ 6. Cross-Module Contract Spine — confirm `getBlob`/`Clip`/`ClipSourceAdapter`/`ClipDraft` shapes match what renderer/layer-engine/tts-local/voice-script consume
  - For each public interface: trace input → implementation → observable output (record written, blob
    returned, id minted, error code raised); confirm the persisted schema names (`binaural-clips`,
    `clips`, `by-hash`, `by-source`, keyPath `id`) match the contract literally.
  - For each consumer (layer-engine/renderer via getBlob, tts-local/voice-script via the adapter seam):
    verify they read correct field names and shapes; confirm a missing clip is `undefined` (not a
    silent valid-looking default that a consumer would treat as real audio).
  - Confirm no silent default masks a real failure: storage errors are typed `ClipLibraryError`, not
    swallowed; a detached-buffer hash bug (every clip hashing identically) would show as collapsed
    dedup — verify it does not occur.
  - Write findings to .dev/.task-state/clip-library/behavioral-audit.md
  - PASS required before marking this module complete

## Completion Criteria
- [x] All tasks marked [x] — zero tasks left [ ] (Pending) or [!] (Needs-Attention)
- [x] Zero active stubs for this module in .dev/.task-state/stub-registry.md (the lone `clip-sources/tts-local.ts` stub is owned by the tts-local module, not clip-library)
- [x] All module tests passing (`npm test`, full suite — not just clip-library tests) — 55 files / 1186 tests / 0 failures (2026-06-16)
- [x] The three guardrail suites (automation.test.ts, audio-engine.test.ts, transport-master-gain.test.ts) green and their files unmodified (guardrail-check.md)
- [x] Audit PASS for every task — all impl/test/audit tasks [x] (each passed its post-implement audit gate); cohesion guardrail audit → guardrail-check.md
- [x] last-step-summary.md written for every task with a concrete Observable Verification entry
- [x] Behavioral audit PASS (see above) — behavioral-audit.md verdict PASS
