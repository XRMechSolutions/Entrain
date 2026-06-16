# Tasks: session-model
# Planning: .dev/planning/modules/session-model/
# Architecture: .dev/architecture.md
# Standards: security, safety
# Stack: typescript

## Agent Briefing
`session-model` owns the persisted data contract for a binaural session: the
`Preset` / `TimeNode` / `ParamPoint` / `ModPoint` types, their runtime validation,
canonical JSON serialize/parse, and schema-version gating/migration. It is pure,
dependency-free TypeScript in one file (`src/engine/session-model.ts`) — no Web Audio,
no DOM, no I/O. Every other module (`audio-engine`, `automation`, `transport`,
`persistence`, `ui`) imports these types and the `validate` / `parse` / `serialize`
functions; this module consumes none of them.

## References
- .dev/planning/modules/session-model/design.md — behavior, validation phases, the one Web Audio quirk (exp-through-zero)
- .dev/planning/modules/session-model/interfaces.md — the exact public contract (types, signatures, constants)
- .dev/planning/modules/session-model/edge-cases.md — verbatim message templates and every boundary/failure case
- .dev/planning/modules/session-model/dependencies.md — zero-runtime-dep posture; platform APIs used; rejected libraries
- .dev/knowledge/web-audio/audioparam-automation.md — "no exponential ramp to/through 0" (the rule behind `EXP_RAMP_THROUGH_ZERO`)
- .dev/knowledge/web-audio/continuous-phase-modulator.md — why `edgeMs`/`pulseWidth` are honored only by `pulse` (the `IGNORED_FIELD_FOR_SHAPE` warnings)

## Dependencies
None. This is the lowest Layer-0 base module and must be built first. It ships zero
runtime npm dependencies (dependencies.md) and uses only platform APIs (`JSON`,
`structuredClone`, `Number.isFinite`/`isInteger`, string spread, stable `Array.sort`,
`Error` subclassing). All other modules depend on it; it depends on none.

## Tasks

- [x] [data] Declare schema types, enum unions, constants, the validation issue model, and the SessionModelError class | file: src/engine/session-model.ts | model: T1
  - Ref: .dev/planning/modules/session-model/interfaces.md @ §2 Enum types; §3 Schema types
  - Ref: .dev/planning/modules/session-model/interfaces.md @ §4 Validation issue model; §5 Result types; §6 Error class
  - Ref: .dev/planning/modules/session-model/interfaces.md @ §1 Schema-version constants; §7 Constants
  - Ref: .dev/planning/modules/session-model/design.md @ §4 Eval-time defaults; §5 Constants: ranges and limits
  - Accepts: nothing (declarations only)
  - Creates: exported types `Waveform`, `ParamTransition`, `ModShape`, `ModTransition`, `AutomatableParam`, `ModPoint`, `ParamPoint`, `TimeNode`, `Preset`, `Severity`, `ValidationCode`, `ValidationIssue`, `ValidationResult`, `ParseResult`, `MigrateResult`; consts `CURRENT_SCHEMA_VERSION = 2`, `MIN_SUPPORTED_SCHEMA_VERSION = 2`, `RANGES`, `LIMITS`, `DEFAULTS`; class `SessionModelError extends Error` (`name='SessionModelError'`, readonly `issues: ValidationIssue[]`)
  - Tests: `RANGES`/`LIMITS`/`DEFAULTS` carry the exact documented values; `DEFAULTS` has no `carrier` key; both version consts are `2`; `SessionModelError` sets `name` and carries the passed `issues`; type-level: `Preset.schemaVersion` is the literal `2`, `TimeNode` (not `Node`) is exported

- [x] [impl] [data] Implement validate: structure, per-field range checks, and whitelist/canonical-order normalization | file: src/engine/session-model.ts | model: T1
  - Ref: .dev/planning/modules/session-model/design.md @ §6 validate — the core checker and normalizer (§6.1 collect-all/never-throw/never-mutate, §6.2 normalization, §6.3 phase order steps 1–7)
  - Ref: .dev/planning/modules/session-model/design.md @ §7 Per-field and cross-node rules — §7.1 error-vs-warning, §7.2 t, §7.3 ParamPoints/waveform, §7.7 ModPoint warnings, §7.8 ModPoint ranges
  - Ref: .dev/planning/modules/session-model/edge-cases.md @ §1 Message templates (write messages verbatim); §2 Input/structural failures; §3 Numeric boundaries; §5 Parameter/modulator semantic boundaries
  - Ref: .dev/planning/modules/session-model/interfaces.md @ §4 Validation issue model; §5 Result types
  - Accepts: `value: unknown`
  - Creates: `validate(value): ValidationResult` covering phases 1–7 — root-object, `schemaVersion` (`=== 2`), `name`, `durationSec`, `masterGain`, `nodes` container, and per-node field checks (`t` finite/≥0; the three ParamPoints incl. `value` finite + in-range, `transition` enum, `mod` object/null; ModPoint field ranges; `waveform` enum); the advisory ModPoint warnings (`IGNORED_FIELD_FOR_SHAPE`, `MOD_EDGE_EXCEEDS_HALF_PERIOD`, `STEPS_OVERRIDE_DEPTH`, `STEPS_REQUIRE_JUMP`); `UNKNOWN_FIELD` drop-and-warn; and the canonical-key-order normalized clone returned only on `ok` (cross-node temporal rules are added in the next task)
  - Tests: valid preset → `ok:true`, normalized clone, warnings-only issues; each error code triggered by one bad field; collect-all (multiple independent errors at once, no fail-fast); input never mutated; unknown keys dropped + `UNKNOWN_FIELD`; `mod` absent/`null`/`{}` each preserved; inclusive bounds accepted and just-outside rejected (no clamping); `NaN`/`±Infinity` rejected via `*_NOT_FINITE`; volume-only `depth`/`steps` `[0,1]` enforced while carrier/beat `depth` has no upper cap

- [x] [impl] [data] Implement validate cross-node temporal rules: ordering, carrier-at-start, exp-through-zero | file: src/engine/session-model.ts | model: T1
  - Ref: .dev/planning/modules/session-model/design.md @ §6 validate (§6.3 phase order steps 8–11)
  - Ref: .dev/planning/modules/session-model/design.md @ §7 Per-field and cross-node rules — §7.4 ordering (sorted/unique/first-at-zero), §7.5 exponential transition cannot reach or cross zero, §7.6 carrier required at the start node
  - Ref: .dev/planning/modules/session-model/edge-cases.md @ §4 Node-ordering boundaries; §5 Parameter/modulator semantic boundaries (the `exp` rows)
  - Ref: .dev/knowledge/web-audio/audioparam-automation.md — `exponentialRampToValueAtTime` needs same-sign nonzero endpoints (the rule encoded as `EXP_RAMP_THROUGH_ZERO`)
  - Accepts: the per-node-validated `nodes` (extends `validate` from the prior task)
  - Creates: ordering checks `NODES_NOT_SORTED`, `NODES_DUPLICATE_T` (exact equality, no epsilon), `NODES_FIRST_T_NONZERO`; `NODE_T_EXCEEDS_DURATION` (step 9); `CARRIER_NOT_AT_START` (suppressed when `nodes[0]` is not an object); and `EXP_RAMP_THROUGH_ZERO` via per-param consecutive-keyframe analysis over `{carrier, beat, volume}` using only value-valid nodes
  - Tests: out-of-order → `NODES_NOT_SORTED` (validate does not reorder); duplicate `t` → `NODES_DUPLICATE_T`; near-equal `t` (`1.0` vs `1.0000001`) accepted as distinct; first node `t≠0` → `NODES_FIRST_T_NONZERO`; `t>durationSec` → exceed; `nodes[0]` without carrier → `CARRIER_NOT_AT_START`; exp fade to `0` and exp sign-flip rejected; exp on a param's last keyframe accepted; exp on carrier passes (never ≤0); non-finite `t` node excluded from ordering/exp analysis but still reported

- [x] [impl] Implement the pure helpers: sortNodes, clonePreset, createDefaultPreset | file: src/engine/session-model.ts | model: T1
  - Ref: .dev/planning/modules/session-model/design.md @ §9 Migration, helpers, and the default preset — §9.2 createDefaultPreset, §9.3 sortNodes, §9.4 clonePreset
  - Ref: .dev/planning/modules/session-model/interfaces.md @ §8 Functions; §9 Example values (the `createDefaultPreset()` return)
  - Ref: .dev/planning/modules/session-model/edge-cases.md @ §7 Function-specific failure modes (sortNodes/clonePreset rows)
  - Accepts: `sortNodes(nodes: TimeNode[])`; `clonePreset(preset: Preset)`; `createDefaultPreset()`
  - Creates: `sortNodes` → new array, stable ascending sort by `t`, input untouched; `clonePreset` → `structuredClone` deep copy of a trusted preset (no validation); `createDefaultPreset` → the fixed valid starter (`schemaVersion 2`, `'Untitled Session'`, `durationSec 300`, `masterGain 0.8`, single `t:0` node with carrier 200 / beat 8 / volume 1)
  - Tests: `sortNodes` returns a new array, leaves input unchanged, and is stable for equal `t`; `clonePreset` returns a deep-equal independent graph preserving `null` and double precision; `createDefaultPreset()` deep-equals the documented object and passes `validate` (`ok:true`, carrier at start, `nodes[0].t===0`)

- [x] [impl] [data] Implement migrate, parse, and parseOrThrow (the untrusted-input pipeline) | file: src/engine/session-model.ts | model: T1
  - Ref: .dev/planning/modules/session-model/design.md @ §9 Migration, helpers, and the default preset — §9.1 migrate (version gating + the empty `MIGRATIONS` registry)
  - Ref: .dev/planning/modules/session-model/design.md @ §8 parse — JSON string → Preset (JSON.parse → migrate → pre-sort → validate → migratedFrom)
  - Ref: .dev/planning/modules/session-model/edge-cases.md @ §2 Input/structural failures; §7 Function-specific failure modes
  - Ref: .dev/planning/modules/session-model/interfaces.md @ §5 Result types (`ParseResult`, `MigrateResult`); §8 Functions
  - Accepts: `migrate(raw: unknown)`; `parse(json: string)`; `parseOrThrow(json: string)`
  - Creates: `migrate` → version gate (`SCHEMA_VERSION_MISSING`/`SCHEMA_VERSION_NOT_INTEGER`; `===2` passthrough with `fromVersion:2`; `>2` → `SCHEMA_TOO_NEW`; `<2` walks the empty `MIGRATIONS` registry → `SCHEMA_TOO_OLD`); `parse` → `INVALID_JSON` (no throw), `NOT_OBJECT`, migrate, stable pre-sort via `sortNodes`, `validate`, and `migratedFrom` (original version if a step ran, else `null`); `parseOrThrow` → returns `Preset` or throws `SessionModelError(issues)`
  - Tests: malformed JSON → `INVALID_JSON` without throwing; non-object → `NOT_OBJECT`; version 2 passes; version 1 → `SCHEMA_TOO_OLD`; version 3 → `SCHEMA_TOO_NEW`; missing / non-integer version handled; out-of-order nodes load via pre-sort (only true duplicates survive to `NODES_DUPLICATE_T`); `migratedFrom` is `null` when no migration ran; `parseOrThrow` throws on invalid and returns the `Preset` on valid input
  - Note: register the empty-`MIGRATIONS` extension point as this module's single stub in .dev/.task-state/stub-registry.md

- [x] [impl] [data] Implement serialize, isPreset, and presetsEqual (canonical output + equality on validate) | file: src/engine/session-model.ts | model: T1
  - Ref: .dev/planning/modules/session-model/design.md @ §9 Migration, helpers, and the default preset — §9.5 serialize, §9.4 presetsEqual
  - Ref: .dev/planning/modules/session-model/design.md @ §6 validate (§6.2 canonical key order — the basis for byte-stable output and order-independent equality)
  - Ref: .dev/planning/modules/session-model/edge-cases.md @ §7 Function-specific failure modes; §8 Round-trip guarantees
  - Ref: .dev/planning/modules/session-model/interfaces.md @ §8 Functions
  - Accepts: `serialize(preset: Preset, opts?: { pretty?: boolean })`; `isPreset(value: unknown)`; `presetsEqual(a: Preset, b: Preset)`
  - Creates: `serialize` → validates first and throws `SessionModelError(issues)` if invalid, else `JSON.stringify` of the normalized (canonical) preset, `pretty` selecting 2-space indent; `isPreset` → `validate(value).ok` type guard; `presetsEqual` → normalizes both via `validate` (throws `SessionModelError` if either invalid) and compares canonical serialized strings
  - Tests: serialize→parse round-trip is `presetsEqual` true; `mod:null` survives; absent optionals stay omitted; canonical key order is stable regardless of input key order; `serialize` throws on an invalid preset (never writes corrupt JSON); `isPreset` returns true only when no error-severity issue; `presetsEqual` is key-order-independent and throws when either argument is invalid

- [x] [impl] [data] Schema v3 (D-021): add TimeNode.spatial + 'spatial' to AutomatableParam, RANGES.spatial/depthSpatial, DEFAULTS.spatial, bump CURRENT_SCHEMA_VERSION to 3, validate the spatial lane, and the v2→v3 migration (MIGRATIONS[2]) | file: src/engine/session-model.ts | model: T1
  - Ref: .dev/planning/modules/session-model/interfaces.md @ §1 schema-version constants (3 / 2); §2 AutomatableParam (+spatial); §3 TimeNode.spatial; §7 RANGES (spatial, depthSpatial) + DEFAULTS (spatial 0)
  - Ref: .dev/planning/data-models.md @ Entity Node (spatial row); Validation (spatial value −1..1, depth 0..1); Persistence (v2→v3 version-bump)
  - Ref: .dev/planning/decisions-log.md @ D-021 (spatial reuses the generic ParamPoint/ModPoint codes; only the range table differs)
  - Ref: .dev/.task-state/stub-registry.md — resolves the MIGRATIONS[from] v3 stub (first entry MIGRATIONS[2])
  - Accepts: presets containing nodes[i].spatial (a ParamPoint) and schemaVersion 2 or 3
  - Creates: CURRENT_SCHEMA_VERSION=3 (MIN_SUPPORTED stays 2); Preset.schemaVersion literal 3; TimeNode.spatial?: ParamPoint; AutomatableParam includes 'spatial'; RANGES.spatial {−1,1} + depthSpatial {0,1}; DEFAULTS.spatial 0; validate() walks spatial as a 4th lane (value −1..1 via PARAM_VALUE_OUT_OF_RANGE, transition/mod/exp-through-0/depth via the existing codes, paths "nodes[i].spatial.*"); migrate() MIGRATIONS[2] = version-bump v2→v3 (no structural change; spatial absent = center); createDefaultPreset bumped to schemaVersion 3 (still no spatial)
  - Tests: v3 preset with spatial validates; spatial value outside [−1,1] → PARAM_VALUE_OUT_OF_RANGE at nodes[i].spatial.value; spatial mod depth >1 → MOD_DEPTH_OUT_OF_RANGE; exp transition through 0 on spatial rejected; a v2 preset parses and migrates to v3 (migratedFrom=2, no spatial); absent spatial = centered at eval (DEFAULTS.spatial 0); serialize/parse round-trip preserves spatial + its mod (incl. mod:null); the first task's version-const test updates to CURRENT=3 / MIN=2

- [x] [audit] Behavioral audit: session-model | file: .dev/.task-state/audit-session-model.md | model: T1
  - Ref: C:/Projects/.dev-shared/behavioral-audit.md
  - Verify the module's observable behavior matches interfaces.md + edge-cases.md: every exported function/type/const exists and is reachable; trace `validate`/`parse`/`serialize`/`migrate` input → output; confirm the `EXP_RAMP_THROUGH_ZERO`, carrier-at-start, ordering, and three-state `mod` (absent/null/object) behaviors hold; confirm every edge case in edge-cases.md §2–§8 has handling evidence; write findings to .dev/.task-state/audit-session-model.md (PASS required before the module is complete)

## Cleanup

- [x] [cleanup] Sync ModShape `box` into the session-model planning docs | file: .dev/planning/modules/session-model/interfaces.md, .dev/planning/modules/session-model/edge-cases.md | model: T2
  - Ref: behavioral audit 2026-06-15 (.dev/.task-state/audit-session-model.md, NOTE) — code's `ModShape` includes the additive `box` shape (audited PASS in audit-box-shape.md), but interfaces.md §2 and the `MOD_SHAPE_INVALID` template in edge-cases.md §1/§5 still list only sine/triangle/square/pulse. Add `box` to interfaces.md §2, update the `MOD_SHAPE_INVALID` verbatim template (".. must be one of sine, triangle, square, pulse, box"), and add box's per-shape behavior (pulseWidth = hold ratio; edgeMs/steps IGNORED_FIELD_FOR_SHAPE) to edge-cases.md §5. Docs-only; no code change.

## Completion Criteria
- [ ] All tasks above marked [x] — none left [ ] (Pending) or [!] (Needs-Attention)
- [ ] Zero active stubs for this module in .dev/.task-state/stub-registry.md (the Schema v3 task populates `MIGRATIONS[2]` (v2→v3); the extension point remains documented for any future >v3 bump)
- [ ] All session-model module tests passing
- [ ] Per-task audit PASS for every task
- [ ] last-step-summary.md written for every task with a concrete Observable Verification entry
- [ ] Behavioral audit PASS (see audit task above)
