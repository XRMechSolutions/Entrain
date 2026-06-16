# Tasks: persistence
# Planning: .dev/planning/modules/persistence/
# Architecture: .dev/architecture.md
# Standards: security, safety
# Stack: typescript

## Agent Briefing
`persistence` is the preset library and file I/O for the app: localStorage
save/load/list/delete/clear plus idempotent seeding of built-in defaults, and JSON
export/import of presets. It owns ZERO schema knowledge — every preset entering or
leaving funnels through its only internal dependency, `session-model` (Layer 0:
`validate`/`parse`/`serialize`), and it touches only Web Storage, DOM (one `<a>` for
download, one `<input type=file>` for import), Blob/URL/File, and `crypto` — no audio.
It is a stateless store consumed by `ui` (Layer 2); nothing in Layer 0/1 depends on it.

## References
- .dev/planning/modules/persistence/design.md
- .dev/planning/modules/persistence/interfaces.md
- .dev/planning/modules/persistence/edge-cases.md
- .dev/planning/modules/persistence/dependencies.md
- .dev/knowledge/web-audio/mobile-audio-lifecycle.md — user-gesture / autoplay policy family (download + picker gesture rule)
- .dev/knowledge/web-audio/audioparam-automation.md — exp-ramp-through-zero (D-013), surfaced as INVALID_PRESET
- .dev/knowledge/web-audio/pwa-setup.md — offline PWA / secure-context context for crypto.randomUUID

## Dependencies
- `session-model` (Layer 0) must be COMPLETE and export: `Preset`, `ValidationIssue`,
  `validate`, `parse`, `serialize`, `SessionModelError`. This is the only internal
  dependency. No runtime npm packages — platform/Web APIs only (Web Storage, JSON,
  crypto, Blob, URL, File, DOM). See dependencies.md.

## Tasks
- [x] [data] Lay the module foundation: constants, public types, `PersistenceError`, the `session-model` imports, and the empty `STORE_MIGRATIONS` stub | file: src/engine/persistence.ts | model: T2
  - Ref: .dev/planning/modules/persistence/design.md @ 2. Public surface
  - Ref: .dev/planning/modules/persistence/interfaces.md @ 1. Constants
  - Ref: .dev/planning/modules/persistence/interfaces.md @ 2. Error type
  - Ref: .dev/planning/modules/persistence/interfaces.md @ 3. Data shapes
  - Ref: .dev/planning/modules/persistence/design.md @ 12. The single stub
  - Accepts: imports `Preset`, `ValidationIssue`, `validate`, `parse`, `serialize`, `SessionModelError` from `./session-model`
  - Creates: exported consts `STORAGE_KEY='binaural-audio.presetLibrary'`, `STORE_VERSION=1`, `MAX_IMPORT_BYTES=1_048_576`, `EXPORT_MIME='application/json'`, `EXPORT_EXTENSION='.json'`; types `PresetSummary`, `SavedPreset`, `ImportedPreset`, `ImportResult`, `PersistenceErrorCode`; class `PersistenceError` (readonly `name`/`code`, optional `issues`/`cause`); internal `Library`/`StoredRecord` envelope types; empty internal `STORE_MIGRATIONS` map
  - Tests: exact constant values; `PersistenceError` carries `code`, optional `issues[]` and `cause`, and `name==='PersistenceError'`; `instanceof Error` holds; `STORE_MIGRATIONS` is empty and registered in `.dev/.task-state/stub-registry.md`

- [x] [data] Implement the storage-fault boundary: internal `readLibrary`/`writeLibrary`/`clearLibrary` envelope I/O plus `newId`, with error classification and the storeVersion gate | file: src/engine/persistence.ts | model: T1-lite [data]
  - Ref: .dev/planning/modules/persistence/design.md @ 3.3 Reading and writing the envelope
  - Ref: .dev/planning/modules/persistence/design.md @ 4. ID generation
  - Ref: .dev/planning/modules/persistence/edge-cases.md @ A. localStorage availability and quota
  - Ref: .dev/planning/modules/persistence/edge-cases.md @ B. Corrupt or version-mismatched library envelope
  - Ref: .dev/planning/modules/persistence/edge-cases.md @ F. ID generation fallbacks
  - Accepts: raw localStorage string (or null); a `Library` object to persist
  - Creates: `readLibrary(): Library` (access guard -> STORAGE_UNAVAILABLE; absent/blank -> fresh `{storeVersion,seeded:false,records:[]}`; SyntaxError -> STORAGE_CORRUPT; shape+version gate -> STORAGE_CORRUPT / STORE_VERSION_UNSUPPORTED; `seeded` coerced); compact-JSON `writeLibrary` (quota spellings -> QUOTA_EXCEEDED else STORAGE_UNAVAILABLE); `clearLibrary(): void` via `removeItem` (-> STORAGE_UNAVAILABLE); `newId(): string` (randomUUID -> getRandomValues v4 -> `p-`time/random fallback)
  - Tests: throw on read access (A1->STORAGE_UNAVAILABLE); null/`''`/whitespace -> fresh empty lib (A3); bad JSON (B1) and mis-shaped/`records` non-array (B2) -> STORAGE_CORRUPT and NEVER wipes; storeVersion>1 -> STORE_VERSION_UNSUPPORTED (B3), <1/missing -> STORE_VERSION_UNSUPPORTED via empty migrations (B4); quota DOMException variants (`QuotaExceededError`/`NS_ERROR_DOM_QUOTA_REACHED`/code 22/1014) -> QUOTA_EXCEEDED, other write throw -> STORAGE_UNAVAILABLE (A2); `clearLibrary` works without parsing; `newId` falls through all three id strategies and stays unique

- [x] [data] Implement the localStorage library CRUD: `listPresets`, `loadPreset` (validate+migrate+self-heal), `savePreset`, `deletePreset`, `clearLibrary` export | file: src/engine/persistence.ts | model: T2 [data]
  - Ref: .dev/planning/modules/persistence/design.md @ 6. Library operations
  - Ref: .dev/planning/modules/persistence/design.md @ 10. Validation and migration are wholly delegated
  - Ref: .dev/planning/modules/persistence/interfaces.md @ 4. localStorage library functions
  - Ref: .dev/planning/modules/persistence/edge-cases.md @ C. Per-record corruption and on-load migration
  - Ref: .dev/planning/modules/persistence/edge-cases.md @ I. Miscellaneous boundaries
  - Accepts: `loadPreset(id)`, `savePreset(preset, id?)`, `deletePreset(id)`; `listPresets()`/`clearLibrary()` no args
  - Creates: `listPresets(): PresetSummary[]` (per-record-resilient skip+warn, total sort updatedAt-desc/createdAt-desc/id-asc); `loadPreset(id): SavedPreset|null` (`parse(JSON.stringify(record.preset))`; null if absent; INVALID_PRESET on ok:false; best-effort write-back when `migratedFrom!==null`); `savePreset(preset, id?): SavedPreset` (validate-first, store normalized clone, create/overwrite/create-with-id); `deletePreset(id): boolean`; `clearLibrary(): void` (re-exports task-2 helper)
  - Tests: list skips a tampered record without deleting it (C1) and sorts deterministically; missing id -> `loadPreset` null / `deletePreset` false (I1); corrupt body -> INVALID_PRESET with issues, no auto-delete (C2); older-schema body migrates and is written back preserving timestamps, and still returns the preset when write-back throws (C3); SCHEMA_TOO_NEW -> INVALID_PRESET, record intact (C4); save validates first and stores the normalized clone, overwrite bumps `updatedAt`/keeps `createdAt`/`id`, save-with-unknown-id creates that id (I2); no name-uniqueness enforcement (D6); QUOTA_EXCEEDED/STORAGE_* propagate

- [x] [impl] Implement default-preset seeding: pure `buildDefaultLibraryPresets` and idempotent `seedDefaultPresets` | file: src/engine/persistence.ts | model: T2 [data]
  - Ref: .dev/planning/modules/persistence/design.md @ 7. Seeding the built-in default presets
  - Ref: .dev/planning/modules/persistence/interfaces.md @ 4. localStorage library functions
  - Ref: .dev/planning/modules/persistence/edge-cases.md @ I. Miscellaneous boundaries
  - Accepts: no args
  - Creates: `buildDefaultLibraryPresets(): Preset[]` (the four literal presets transcribed exactly from design §7 — Relax/Alpha, Meditate/Theta, Sleep Descent/Delta, Isochronic Focus; all `schemaVersion:2`, `masterGain:0.8`); `seedDefaultPresets(): PresetSummary[]` (gated by the `seeded` flag, fresh `newId()` + `now` per record, sets `seeded=true`, returns added summaries)
  - Tests: every built-in passes `session-model.validate` (carrier at nodes[0], t===0, sorted/unique t, no exp-through-zero, preset-4 `edgeMs:8 < periodSec/2` raises no MOD_EDGE warning); seed on fresh lib adds four and returns their summaries (I3); second call returns `[]`; deleting all defaults then re-seeding stays empty (seeded gate, I4); `clearLibrary()` then `seedDefaultPresets()` re-seeds (factory reset)

- [x] [impl] Implement the export pipeline: pure `presetToJson` and `toSafeFilename`, `presetToBlob`, and DOM `exportPreset` | file: src/engine/persistence.ts | model: T2
  - Ref: .dev/planning/modules/persistence/design.md @ 8. Export
  - Ref: .dev/planning/modules/persistence/interfaces.md @ 5. File export functions
  - Ref: .dev/planning/modules/persistence/edge-cases.md @ E. Export failures and filename boundaries
  - Ref: .dev/planning/modules/persistence/edge-cases.md @ H. Folded Web-Audio / platform quirks
  - Ref: .dev/knowledge/web-audio/mobile-audio-lifecycle.md — user-gesture policy family (download must run inside a click handler; documented, not enforceable)
  - Accepts: `presetToJson(preset)`, `presetToBlob(preset)`, `exportPreset(preset, opts?)`, `toSafeFilename(name)`
  - Creates: `presetToJson(preset): string` (`serialize(preset,{pretty:true})`, rewraps SessionModelError as INVALID_PRESET); `presetToBlob(preset): Blob` (DOM_UNAVAILABLE if no Blob); `exportPreset(preset, opts?): string` (DOM guard; temp `<a download rel=noopener>` appended/clicked/removed; object URL revoked on 1000 ms timeout; returns filename); `toSafeFilename(name): string` (NFC, illegal/control->`-`, collapse/trim spaces, strip edge dots/spaces, cap 64, empty->`preset`, Windows reserved-name prefix `_`, append `.json` unless present)
  - Tests: invalid preset -> INVALID_PRESET, never writes a file (E1); filename mapping E2-E7 (`Deep/Sleep: v2`->`Deep-Sleep- v2.json`, whitespace->`preset.json`, `NUL`->`_NUL.json`, 64-cap, emoji kept, `.json`/`.JSON` not doubled); no-document/Blob/URL -> DOM_UNAVAILABLE (E9); URL revoked on timer not synchronously (E8); anchor present in DOM at click then removed (E11)

- [x] [data] Implement the import pipeline: pure DOM-free `parsePresetJson`, `importPresetFile`, and picker `importPresetFromFile` | file: src/engine/persistence.ts | model: T1-lite [data]
  - Ref: .dev/planning/modules/persistence/design.md @ 9. Import
  - Ref: .dev/planning/modules/persistence/design.md @ 11. Error philosophy and threading
  - Ref: .dev/planning/modules/persistence/interfaces.md @ 6. File import functions
  - Ref: .dev/planning/modules/persistence/edge-cases.md @ D. Import failures and boundaries
  - Ref: .dev/knowledge/web-audio/audioparam-automation.md — exp-ramp-through-zero (D-013) returns as EXP_RAMP_THROUGH_ZERO -> surfaced as INVALID_PRESET (edge-cases §D5)
  - Ref: .dev/knowledge/web-audio/mobile-audio-lifecycle.md — picker `input.click()` needs a user gesture (edge-cases §D8)
  - Accepts: `parsePresetJson(json)`, `importPresetFile(file)`, `importPresetFromFile()` (no args)
  - Creates: `parsePresetJson(json): ImportResult` (strip leading BOM, delegate to `session-model.parse`, never throws; maps ok->{preset,migratedFrom,warnings} / fail->{issues}); `importPresetFile(file): Promise<ImportedPreset>` (size guard `> MAX_IMPORT_BYTES`->IMPORT_TOO_LARGE before read; `file.text()` reject->IMPORT_READ_FAILED; ok:false->INVALID_PRESET; resolves un-saved preset + filename); `importPresetFromFile(): Promise<ImportedPreset>` (DOM guard->DOM_UNAVAILABLE; hidden `<input>`; single `settled` guard; `change` success; `cancel` event + ~300 ms window-`focus` fallback->IMPORT_CANCELLED; cleanup listeners/element)
  - Tests: BOM-prefixed JSON parses (D4); bad JSON/non-object/old/new schema/exp-through-zero -> {ok:false,issues} and `importPresetFile` rejects INVALID_PRESET with issues (D5), no module-added rules; oversize file rejects IMPORT_TOO_LARGE before reading bytes (D2); `file.text()` rejection -> IMPORT_READ_FAILED with cause (D3); import does NOT save; non-fatal warnings returned (D7); picker cancel via `cancel` and via focus-fallback both reject IMPORT_CANCELLED exactly once (D1); no document -> DOM_UNAVAILABLE (D10)

- [x] [audit] Behavioral audit: persistence | file: .dev/.task-state/audit-persistence.md | model: T1
  - Ref: C:/Projects/.dev-shared/behavioral-audit.md
  - Verify the module's observable behavior matches its interfaces.md + edge-cases.md; check every edge case is handled.
  - For each public export in interfaces.md (§1-§6): trace input -> implementation -> observable output, confirm the single `PersistenceError` family, and confirm `ui` (the consumer) reads correct field names/shapes.
  - Confirm every edge case in edge-cases.md §A-§I has evidence of handling; confirm no path silently wipes/overwrites user data (non-destructive invariant); write findings and PASS/FAIL to the report file.

## Completion Criteria
- [ ] All tasks above marked [x] — none left [ ] (Pending) or [!] (Needs-Attention)
- [ ] Zero active stubs for this module EXCEPT the registered `STORE_MIGRATIONS` seam (design.md §12) — an intentional, accepted deferral until `STORE_VERSION` is bumped past 1 (mirrors `session-model`'s empty `MIGRATIONS`)
- [ ] All module tests passing (full suite, not just the current task's)
- [ ] Audit PASS for every task
- [ ] last-step-summary.md written for every task with a concrete Observable Verification entry
- [ ] Behavioral audit PASS (see audit task above)
