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

## Feature: v4 layers (Phase 2)

> **GATING PREREQUISITE (phase2-audio-architecture.md §0 — land FIRST).** This section
> ships the v4 schema close-out: `Layer` / `LayerKind` / `ToneSpec` / `LanePoint` /
> `LayerSource` + `Preset.layers`, the layers validation phase (12), layer normalization,
> the v3→v4 migration (`MIGRATIONS[3]` + `CURRENT_SCHEMA_VERSION = 4`), and tests. The
> entire Phase-2 layer/clip/mix/render feature (mixer, layer-engine, layer-scheduler,
> renderer, voice-script, tts-local) references these contracts as if they exist; **no NEW
> Layer-0/Layer-1 Phase-2 module may begin until this section is [x].** It is a hard
> dependency edge for every downstream module (phase2 §0, §6 build order).
>
> **Cohesion guardrails (acceptance criteria for every task here).** These are
> byte-identical guardrails — run GREEN before AND after every task in this section, with
> zero edits to them:
> - `src/engine/session-model.test.ts` — the v3 guardrail; every existing v3 assertion
>   stays passing (additive change only). The ONLY edits permitted are the version-const
>   tests (`CURRENT === 4`, `MIN === 2`) and `createDefaultPreset` (`schemaVersion 4`),
>   plus NEW layer cases appended.
> - `src/engine/automation.test.ts` (scheduleLane extraction), `src/engine/audio-engine.test.ts`
>   (master flag default `'internal'`), `src/engine/transport-master-gain.test.ts` — these
>   live in other modules; this section must NOT touch them, but the agent must confirm the
>   full suite stays green so the schema bump introduces no cross-module break.
>
> Schema-owner invariants carried here: no-click ramps (D-008) — `session-model` only
> *permits* the data (`exp`-through-zero is the one rejected Web-Audio case, §7.5/§7.10),
> never ramps; single-writer params (D-019) — pure data, no scheduling. `clipId` existence
> is NOT validated (D-023) — keeps the module clip-store-free and presets portable.

- [x] [data] Declare v4 layer types (`LayerKind`/`ToneSpec`/`LayerSource`/`LanePoint`/`Layer`) + `Preset.layers`, append the layer `ValidationCode` members, add `RANGES.toneFreq`, and bump version consts to v4 | file: src/engine/session-model.ts | model: T1
  - Ref: .dev/planning/modules/session-model/interfaces.md @ §10 (the verbatim `LayerKind`/`ToneSpec`/`LayerSource`/`LanePoint`/`Layer` contracts, the appended `ValidationCode` union members, `RANGES.toneFreq {20,20000}`); §1 schema-version constants (`CURRENT_SCHEMA_VERSION: 4`, `MIN_SUPPORTED_SCHEMA_VERSION: 2`); §3 `Preset.schemaVersion: 4` literal + `Preset.layers?: Layer[]`
  - Ref: .dev/planning/modules/session-model/design.md @ §11.1–§11.3 (what v4 adds; the new types; why `LanePoint` not `ParamPoint`/`TimeNode` — lane `t` is RELATIVE to layer start); §11.7 (new constants); §5 schemaVersion row (`=== 4` for `validate`)
  - Ref: .dev/planning/phase2-audio-architecture.md @ §0 (gating prerequisite — the exact symbol set this task ships); §6 spine (`LayerKind`/`LanePoint` are restated VERBATIM and must stay byte-identical to the spine: `LayerKind = 'tone'|'ambiance'|'voice'`; `LanePoint { t; value; transition? }`)
  - Ref: .dev/planning/decisions-log.md @ D-022 (layers added), D-027 (layer shape); D-023 (clipId existence not validated)
  - Accepts: nothing (declarations + const value changes only)
  - Creates: exported types `LayerKind = 'tone'|'ambiance'|'voice'`, `ToneSpec { shape: Waveform; freqHz; attackSec; releaseSec }`, `LayerSource = { synth: ToneSpec } | { clipId: string }`, `LanePoint { t; value; transition?: ParamTransition }`, `Layer { id; kind; source; t; loop?; gain?: LanePoint[]; spatial?: LanePoint[] }`; `Preset.layers?: Layer[]` and `Preset.schemaVersion` literal `4`; the appended `ValidationCode` members (`LAYERS_NOT_ARRAY`, `LAYER_NOT_OBJECT`, `LAYER_ID_NOT_STRING`, `LAYER_ID_EMPTY`, `LAYER_ID_DUPLICATE`, `LAYER_KIND_INVALID`, `LAYER_SOURCE_INVALID`, `LAYER_CLIP_ID_NOT_STRING`, `LAYER_CLIP_ID_EMPTY`, `TONE_SHAPE_INVALID`, `TONE_FREQ_NOT_FINITE`, `TONE_FREQ_OUT_OF_RANGE`, `TONE_ATTACK_NOT_FINITE`, `TONE_ATTACK_NEGATIVE`, `TONE_RELEASE_NOT_FINITE`, `TONE_RELEASE_NEGATIVE`, `LAYER_T_NOT_FINITE`, `LAYER_T_NEGATIVE`, `LAYER_T_EXCEEDS_DURATION`, `LAYER_LOOP_NOT_BOOLEAN`, `LANE_NOT_ARRAY`, `LANE_POINT_NOT_OBJECT`, `LANE_T_NOT_FINITE`, `LANE_T_NEGATIVE`, `LANE_VALUE_NOT_FINITE`, `LANE_VALUE_OUT_OF_RANGE`, `LANE_TRANSITION_INVALID`, `LANE_NOT_SORTED`, `LANE_DUPLICATE_T`, `LANE_EXP_THROUGH_ZERO`); `RANGES.toneFreq { min: 20, max: 20000 }`; `CURRENT_SCHEMA_VERSION = 4`, `MIN_SUPPORTED_SCHEMA_VERSION = 2` (unchanged)
  - Behavior: additive only — every existing v3 type/const stays byte-identical except the two version literals and the `Preset` interface gaining `layers?`. `LayerKind` and `LanePoint` MUST be byte-identical to the phase2 §6 spine so `automation.scheduleLane` consumes a layer lane with no adapter. `kind` and `source` are independent (no coupling type constraint).
  - Tests: `CURRENT_SCHEMA_VERSION === 4` and `MIN_SUPPORTED_SCHEMA_VERSION === 2`; `RANGES.toneFreq` is `{min:20,max:20000}`; type-level — `Preset.schemaVersion` is literal `4`, `Preset.layers` is `Layer[] | undefined`, `LayerSource` is the `{synth}|{clipId}` union, `LanePoint.t/value` are `number` and `transition` optional; the appended `ValidationCode` members are assignable
  - Ripple: every consumer of `Preset`/`schemaVersion` (audio-engine, automation, transport, persistence, ui, renderer, mixer, layer-engine, layer-scheduler) now sees `schemaVersion: 4` + optional `layers`; additive so v3-shaped presets still type-check (layers optional). Downstream Phase-2 modules build against these exact contracts.

- [x] [impl] [data] Implement validate phase 12 — the layers subtree: per-layer structure/id/kind/source(synth|clipId)/t/loop, then per-lane (`gain`/`spatial`) point checks, ordering, and exp-through-zero | file: src/engine/session-model.ts | model: T1
  - Ref: .dev/planning/modules/session-model/design.md @ §6.3 step 12 (layers phase placement — runs even when node checks errored; deterministic traversal: structure→id→kind→source→t→loop→gain lane→spatial lane); §7.9 (per-layer rules: `LAYERS_NOT_ARRAY`/`LAYER_NOT_OBJECT`; id non-empty-string + unique via `LAYER_ID_DUPLICATE` at the *second* occurrence, exact string equality; `kind` enum; `source` exactly-one-of synth/clipId; ToneSpec checks; `t` finite/≥0 + `≤ durationSec` GATED on a valid `durationSec` like node phase 9; `loop` boolean)
  - Ref: .dev/planning/modules/session-model/design.md @ §7.10 (lane validation: per-point object/`t` finite≥0/`value` in lane range — gain `[0,1]`=`RANGES.volume`, spatial `[-1,1]`=`RANGES.spatial`/`transition`; ordering `LANE_NOT_SORTED`/`LANE_DUPLICATE_T` exact-equality, NO pre-sort, NO first-point-at-zero requirement, non-finite-`t` points excluded; per-lane `LANE_EXP_THROUGH_ZERO` reusing §7.5 skip-last/skip-bad/`sign(x)=x>0?1:-1`)
  - Ref: .dev/planning/modules/session-model/design.md @ §11.4 (validation rules summary; all error-severity); §11.5 (clipId existence NOT validated — D-023); §7.5 (the exp-through-zero algorithm being reused per lane)
  - Ref: .dev/planning/modules/session-model/edge-cases.md @ §1 v4 layer codes (write every message template VERBATIM); §9.1 (`layers` container & per-layer structure); §9.2 (`source` discriminated union — both/neither/empty/non-object cases); §9.3 (`gain`/`spatial` lanes — point/ordering/exp boundaries, relative-`t` no-duration-bound, single point, out-of-order rejected not sorted)
  - Ref: .dev/planning/modules/session-model/interfaces.md @ §4 ValidationIssue path format (`layers[{i}].source.synth.freqHz`, `layers[{i}].{lane}[{j}].value`, `layers[{i}].{lane}[{j}].transition`)
  - Ref: .dev/planning/phase2-audio-architecture.md @ §0 (`ambiance` = looping clips, `tone` = one-shot tone/bell, `voice` = one-shot cue — semantic labels, NOT a source constraint: kind/source independent)
  - Accepts: the already-node-validated value (extends `validate` with phase 12, after phases 1–11)
  - Creates: the layers phase of `validate` — runs independently of node errors; emits `LAYERS_NOT_ARRAY` (stops layer checks, siblings still run), `LAYER_NOT_OBJECT` (skip that layer's inner checks + exclude from id-uniqueness scan), `LAYER_ID_NOT_STRING`/`LAYER_ID_EMPTY`/`LAYER_ID_DUPLICATE`, `LAYER_KIND_INVALID`, `LAYER_SOURCE_INVALID` (absent/non-object/neither/both), `LAYER_CLIP_ID_NOT_STRING`/`LAYER_CLIP_ID_EMPTY`, the `TONE_*` ToneSpec checks (`freqHz` in `RANGES.toneFreq`, `attackSec`/`releaseSec` finite ≥0), `LAYER_T_*` (`EXCEEDS_DURATION` gated on valid `durationSec`), `LAYER_LOOP_NOT_BOOLEAN`, and the lane codes `LANE_NOT_ARRAY`/`LANE_POINT_NOT_OBJECT`/`LANE_T_*`/`LANE_VALUE_*`/`LANE_TRANSITION_INVALID`/`LANE_NOT_SORTED`/`LANE_DUPLICATE_T`/`LANE_EXP_THROUGH_ZERO`; unknown layer/synth keys → `UNKNOWN_FIELD` warning
  - Handles: `layers` absent → no checks (valid); `clipId` with no backing clip → valid (D-023); empty lane `[]` → valid; non-finite lane/layer `t` excluded from ordering/exp passes but still reported; one bad `durationSec` does not spray spurious `LAYER_T_EXCEEDS_DURATION`
  - Tests: a fully-valid layered preset (synth tone + looping ambiance clip + voice clip with gain/spatial lanes) → `ok:true`; each layer error code triggered by one bad field (path matches the documented `layers[i]...` shape); `source` with both synth+clipId and with neither → `LAYER_SOURCE_INVALID`; duplicate `id` → `LAYER_ID_DUPLICATE` at the second; `kind:'tone'` + `clipId` accepted (kind/source independent); `freqHz` outside `[20,20000]` → `TONE_FREQ_OUT_OF_RANGE`; `attackSec` `-1` → `TONE_ATTACK_NEGATIVE`, `0` accepted; `t > durationSec` → `LAYER_T_EXCEEDS_DURATION`, `t === durationSec` accepted, and an invalid `durationSec` suppresses that one bound; gain lane value `1.1` → `LANE_VALUE_OUT_OF_RANGE [0,1]`, spatial `-1.1` → `LANE_VALUE_OUT_OF_RANGE [-1,1]`; out-of-order lane → `LANE_NOT_SORTED` (validate does NOT sort lanes); duplicate lane `t` → `LANE_DUPLICATE_T`; a lane that begins at relative `t=5` (no zero point) is accepted; `exp` gain fade to `0` → `LANE_EXP_THROUGH_ZERO`, `exp` spatial `+1→-1` (crosses center) rejected, `exp` on a lane's last point accepted; collect-all (an invalid node AND invalid layer both reported in one pass); `clipId` referencing an absent clip → valid; input never mutated
  - Ripple: none outside this module (internal `validate` extension); downstream consumers see richer `issues[]` only on invalid layered presets

- [x] [impl] [data] Implement layer normalization, the v3→v4 migration (`MIGRATIONS[3]`), and bump `createDefaultPreset` to v4 | file: src/engine/session-model.ts | model: T1
  - Ref: .dev/planning/modules/session-model/design.md @ §6.2 (layer normalization rules: `normalizeLayer` canonical order `id,kind,source,t,loop,gain,spatial`; `normalizeLanePoint` `t,value,transition`; `normalizeToneSpec` `shape,freqHz,attackSec,releaseSec`; `LayerSource` discriminated-union normalization — copy ONLY the present discriminant; empty `gain`/`spatial` arrays DROPPED = treat-as-absent; empty top-level `layers:[]` PRESERVED; absent `layers` stays absent)
  - Ref: .dev/planning/modules/session-model/design.md @ §9.1 (`MIGRATIONS` carries `MIGRATIONS[2]` and `MIGRATIONS[3]`; v2 walks v2→v3→v4, v3 walks v3→v4, v4 passthrough `fromVersion:4`; `> 4` → `SCHEMA_TOO_NEW`; `< 2` → `SCHEMA_TOO_OLD`; no `MIGRATIONS[1]`); §11.6 (`MIGRATIONS[3] = (obj) => ({ ...obj, schemaVersion: 4 })` pure version-bump; `MIN_SUPPORTED` stays 2); §9.2 (`createDefaultPreset` → `schemaVersion: 4`, `layers` omitted — fresh session is pure-binaural); §11.7 (sparse philosophy; layer behavioral defaults applied by consumers, never baked in)
  - Ref: .dev/planning/modules/session-model/edge-cases.md @ §7 (migrate version table: `== 4` passthrough `fromVersion:4`; `== 3` → `MIGRATIONS[3]` `fromVersion:3`; `== 2` → `MIGRATIONS[2]` then `MIGRATIONS[3]` `fromVersion:2`); §8 round-trip guarantees (`layers` round-trip — discriminant, lane points, absent-vs-present `loop`/`gain`/`spatial` all preserved); §9.1 (`layers:[]` preserved vs empty lane dropped; absent `layers` stays absent)
  - Ref: .dev/planning/phase2-audio-architecture.md @ §0 (migration is part of the gating schema task); §6 (build order: session-model schema lands before all NEW Phase-2 modules)
  - Ref: .dev/.task-state/stub-registry.md — resolves the `MIGRATIONS[from]` forward-extension stub for the v3→v4 step (register `MIGRATIONS[3]`; the extension point itself stays documented for any future >v4 bump)
  - Accepts: presets/raw objects with `schemaVersion` 2, 3, or 4 (and out-of-range for the gate); layered and pure-binaural presets through `validate`'s normalizer
  - Creates: `normalizeLayer`/`normalizeLanePoint`/`normalizeToneSpec` + `LayerSource` discriminant normalization wired into `validate`'s normalized-clone builder; `MIGRATIONS[3] = (obj) => ({ ...obj, schemaVersion: 4 })`; `createDefaultPreset()` returning `schemaVersion: 4` with `layers` omitted; `parse`'s `migratedFrom` correct for v2/v3/v4 inputs
  - Handles: absent `layers` → key not created (sparse round-trip of v3-shaped presets); `gain:[]`/`spatial:[]` → dropped so they normalize byte-identically to absent (and compare equal under `presetsEqual`); `layers:[]` → preserved; `mod:null` and lane `transition` absence preserved; `LayerSource` other-variant key never materialized
  - Tests: a v2 preset parses → migrates to v4 (`migratedFrom: 2`, no `spatial`, no `layers`); a v3 preset (with `spatial`) parses → migrates to v4 (`migratedFrom: 3`, `layers` absent); a v4 preset passes through (`migratedFrom: null`); `schemaVersion 5` → `SCHEMA_TOO_NEW`; `schemaVersion 1` → `SCHEMA_TOO_OLD`; `createDefaultPreset()` deep-equals the documented v4 object, has no `layers` key, and passes `validate` (`ok:true`); serialize→parse round-trip of the layered example (`interfaces.md` §10) is `presetsEqual` true — `LayerSource` discriminant, lane points, and present/absent `loop`/`gain`/`spatial` all preserved; canonical key order stable regardless of input layer/lane/source key order; `{gain:[]}` round-trips equal to an absent `gain`; `layers:[]` survives as an empty array; absent `layers` stays absent through round-trip
  - Ripple: `persistence` re-saves migrated presets at v4 (reads `migratedFrom`); `createDefaultPreset` consumers (ui "New session") now get a v4 preset; serialized JSON now carries `schemaVersion:4`

- [x] [test] Extend session-model.test.ts with the v4 layer suite (guardrail-preserving) — happy/error/edge for layers, migration, normalization, and round-trip | file: src/engine/session-model.test.ts | model: T1/T1/T2/T3
  - Ref: .dev/testing-standards.md — test conventions
  - Ref: .dev/planning/modules/session-model/edge-cases.md @ §9 (every v4 layer boundary is a test row: §9.1 container/structure, §9.2 source union, §9.3 lanes); §1 v4 layer codes (assert the verbatim messages); §8 round-trip guarantees (incl. the `layers` row)
  - Ref: .dev/planning/modules/session-model/interfaces.md @ §10 (the `layered` example preset is the happy-path fixture; the v3/v2 examples are migration fixtures); §9 (existing examples stay valid post-bump)
  - Ref: .dev/planning/modules/session-model/design.md @ §6.3 step 12 (assert deterministic issue ordering: node issues before layer issues; within a layer structure→id→kind→source→t→loop→gain→spatial); §11.6 (migration assertions)
  - Ref: .dev/planning/phase2-audio-architecture.md @ §0 (`session-model.test.ts` is the named guardrail)
  - Accepts: nothing (test file)
  - Creates: appended v4 layer describe-blocks — valid layered preset; one case per layer/lane error code with the exact path and verbatim message; `source` both/neither; duplicate `id`; kind/source independence; ToneSpec range/negative cases; `LAYER_T_EXCEEDS_DURATION` gating; lane ordering (out-of-order rejected, NOT sorted; no first-at-zero requirement); per-lane `LANE_EXP_THROUGH_ZERO` (gain fade-to-0, spatial center-cross, exp-on-last accepted); v2→v4 and v3→v4 migration with correct `migratedFrom`; `createDefaultPreset` v4 shape; round-trip of the layered example via `presetsEqual`; `{gain:[]}`≡absent and `layers:[]` preserved
  - Handles: the existing v3 guardrail — EVERY pre-existing assertion stays passing untouched, EXCEPT the version-const tests updated to `CURRENT===4`/`MIN===2` and `createDefaultPreset` updated to `schemaVersion 4` (these were already authored against the prior bump pattern; mirror it)
  - Tests (this task IS the tests): run `npx vitest run src/engine/session-model.test.ts` green; then run the full suite (`npx vitest run`) and confirm `automation.test.ts`, `audio-engine.test.ts`, `transport-master-gain.test.ts` and all others stay green — the schema bump must introduce zero cross-module regression (cohesion guardrail)
  - Ripple: none (test-only)

- [x] [audit] Behavioral audit: session-model v4 layers | file: .dev/.task-state/session-model/behavioral-audit-v4-layers.md | model: T1
  - Ref: C:/Projects/.dev-shared/behavioral-audit.md — Module Behavioral Audit checklist (existence → input→output trace → consumer verification → failure-path → edge cases)
  - Ref: .dev/planning/modules/session-model/interfaces.md @ §10 — verify every new exported type/const exists and is reachable (`LayerKind`, `ToneSpec`, `LayerSource`, `LanePoint`, `Layer`, `Preset.layers`, the appended `ValidationCode` members, `RANGES.toneFreq`)
  - Ref: .dev/planning/modules/session-model/design.md @ §6.2/§6.3/§7.9/§7.10/§9.1/§11 — verify intended behavior: validate phase 12 traces input→issues; normalization canonical order + discriminant + empty-lane-drop; `MIGRATIONS[2]`/`MIGRATIONS[3]` two-step/one-step migration to v4; `createDefaultPreset` v4
  - Ref: .dev/planning/modules/session-model/edge-cases.md @ §7/§8/§9 — verify every v4 edge case (§9.1–§9.3) has handling evidence and the `layers`/`clipId`/empty-lane behaviors hold; no silent valid-looking default where real data should flow
  - Ref: .dev/planning/phase2-audio-architecture.md @ §0/§6 — confirm the gating-prerequisite symbol set is shipped byte-identical to the §6 spine (`LayerKind`, `LanePoint`) so downstream mixer/layer-engine/layer-scheduler/renderer can build against it; confirm `clipId` existence is NOT validated (D-023)
  - Verify the cohesion guardrails: `session-model.test.ts` green (v3 assertions intact + new layer cases), and the full suite (`automation.test.ts`, `audio-engine.test.ts`, `transport-master-gain.test.ts` unchanged) green before AND after
  - Write findings to .dev/.task-state/session-model/behavioral-audit-v4-layers.md
  - PASS required before the v4 layers feature is considered complete (and before any NEW Phase-2 module begins — phase2 §0)

## Cleanup

- [x] [cleanup] Sync ModShape `box` into the session-model planning docs | file: .dev/planning/modules/session-model/interfaces.md, .dev/planning/modules/session-model/edge-cases.md | model: T2
  - Ref: behavioral audit 2026-06-15 (.dev/.task-state/audit-session-model.md, NOTE) — code's `ModShape` includes the additive `box` shape (audited PASS in audit-box-shape.md), but interfaces.md §2 and the `MOD_SHAPE_INVALID` template in edge-cases.md §1/§5 still list only sine/triangle/square/pulse. Add `box` to interfaces.md §2, update the `MOD_SHAPE_INVALID` verbatim template (".. must be one of sine, triangle, square, pulse, box"), and add box's per-shape behavior (pulseWidth = hold ratio; edgeMs/steps IGNORED_FIELD_FOR_SHAPE) to edge-cases.md §5. Docs-only; no code change.

## Feature: Multi-Voice (v6)

> **GATING PREREQUISITE (multi-voice-architecture.md §0 — land FIRST, as ONE ATOMIC bundle).**
> This section ships schema **v6**: the `Voice` type + `Preset.voices?`, `validateVoices`
> (phase 13), `normalizeVoice`, `MIGRATIONS[5]` (v5→v6), the merged `VOICE_*`/`VOICES_*` codes,
> `LIMITS.maxVoices`/`maxPulseWorklets`, and the shared `voiceView` helper. Every downstream
> multi-voice module (mixer, transport, renderer, ui) depends on these contracts — **no
> multi-voice module may begin until this section is [x] and the Layer-A checkpoint PASSes.**
>
> **Atomic-bundle guardrail (acceptance criteria for the whole section).** `CURRENT_SCHEMA_VERSION`
> 5→6 ripples to EVERY hardcoded `schemaVersion: 5` literal (16 `presets/*.json`, 4 inline
> built-ins in `persistence.ts`, and test literals in `session-model.test.ts`,
> `persistence.test.ts`, `renderer.test.ts`, and the un-owned **`automation.test.ts:44`**). The
> bundle lands together and the gate is **`npm test` AND `npm run check` (svelte-check) green
> before AND after** — the literal-type breakage is invisible to vitest (esbuild strips types).
> The cross-tree literal sweep is the dedicated `[data]` task below; the persistence data half +
> round-trip tests live in `modules/persistence/tasks.md` under the same Layer-A checkpoint.
>
> **The linchpin.** `normalizePreset` is an allowlist clone — miss the `voices` copy or the
> `PRESET_KEYS` append and `voices` is SILENTLY stripped on every validate/parse/round-trip
> while tests stay green. The round-trip `presetsEqual` test (task 4) is the executable proof.

- [x] [data] Declare the `Voice` interface + `Preset.voices?`, bump `CURRENT_SCHEMA_VERSION` 5→6 (Preset literal at :63 + both `as 5` casts at normalizePreset:997 and createDefaultPreset:1272 → `as 6`; LEAVE the third in-file `schemaVersion: 5` at :1129 — `migrateV4ToV5`'s v4→v5 output stamp — UNCHANGED; it is permanently 5, not a bundle target), append `'voices'` to `PRESET_KEYS`, add `LIMITS.maxVoices=4`/`maxPulseWorklets=8` + `RANGES.voiceGain {0,1}` + `DEFAULTS.voiceGain=1`, and the merged `VOICE_*`/`VOICES_*` ValidationCode members | file: src/engine/session-model.ts | model: T1
  - Ref: .dev/planning/multi-voice-architecture.md @ §1.1 Types; §1.2 codes; §1.3 limits/ranges/defaults; §0 atomic bundle
  - Ref: .dev/planning/data-models.md @ Entity Voice; Preset.voices row
  - Ref: .dev/planning/decisions-log.md @ D-040
  - Creates: `export interface Voice { id: string; name?: string; gain?: number; nodes: TimeNode[] }`; `Preset.schemaVersion` literal `6` + `Preset.voices?: Voice[]`; `CURRENT_SCHEMA_VERSION=6` (MIN stays 2); `PRESET_KEYS` append `'voices'`; `LIMITS.maxVoices=4`, `LIMITS.maxPulseWorklets=8`; `RANGES.voiceGain {min:0,max:1}`; `DEFAULTS.voiceGain=1`; the NEW codes `VOICES_NOT_ARRAY`, `VOICES_TOO_MANY`, `VOICES_TOO_MANY_PULSES`, `VOICE_NOT_OBJECT`, `VOICE_ID_NOT_STRING`/`_EMPTY`/`_DUPLICATE`, `VOICE_GAIN_NOT_FINITE`/`_OUT_OF_RANGE`, `VOICE_NODES_NOT_ARRAY`/`_EMPTY`, and warning `VOICES_CARRIER_TOO_CLOSE`
  - Behavior: additive only — every v5 type/const stays byte-identical except the two version literals and `Preset` gaining `voices?`. Per-voice node-field errors REUSE the existing `NODE_*`/`PARAM_*`/`MOD_*`/`NODES_*`/`CARRIER_NOT_AT_START`/`EXP_RAMP_THROUGH_ZERO` codes at `voices[k].nodes[…]` paths (do NOT mint duplicates)
  - Tests: `CURRENT_SCHEMA_VERSION===6`/`MIN===2`; `LIMITS.maxVoices===4`; `RANGES.voiceGain`==`{0,1}`; type-level — `Preset.schemaVersion` literal `6`, `Preset.voices` is `Voice[]|undefined`, `Voice` shape; the new codes assignable
  - Ripple: every `Preset`/`schemaVersion` consumer (audio-engine, automation, transport, persistence, ui, renderer, mixer) now sees `schemaVersion:6` + optional `voices` — additive, so single-voice presets still type-check

- [x] [impl] Thread a `pathPrefix` (default `'nodes'`) through `validateNodes`/`validateNode`/`validateOrdering`/`validateExpThroughZero` so top-level paths stay byte-identical, then add `validateVoices` (phase 13, wired after `validateLayers`) reusing them per voice plus container/id-uniqueness/name-length/gain-range/cap/pulse-cap checks and the `VOICES_CARRIER_TOO_CLOSE` advisory warning | file: src/engine/session-model.ts | model: T1
  - Ref: .dev/planning/multi-voice-architecture.md @ §1.1 Types (Voice.name "≤ 80 chars, reuse the name rule"); §1.2 codes (reuse-with-prefix strategy); §1.3 cap formula `1 + voices.length`; §6 carrier separation + pulse-worklet cap
  - Ref: .dev/planning/modules/perf-safety-binaural-integrity/design.md @ §1 (pulse-worklet count SCOPE — counts voice 0; the 4-voice × 4-lane = 16 worst case); §2 (carrier-too-close predicate — ratio < 1.1 OR |Δ| < 30 Hz, uses the t=0 carrier base)
  - Ref: .dev/planning/modules/session-model/edge-cases.md @ §1 (emit the VOICE_*/VOICES_* message templates VERBATIM — author them consistent with the §11/edge-cases docs task)
  - Ref: src/engine/session-model.ts @ validateNodes/validateNode/validateOrdering/validateExpThroughZero (423-724) — the validators being prefixed; validateLayers (731) — the phase-12 placement precedent; validateName (378-391) — the NAME_NOT_STRING/NAME_TOO_LONG rule to reuse
  - Accepts: a value whose top-level nodes + layers are already validated (extends `validate`)
  - Creates: phase-13 `validateVoices` — `VOICES_NOT_ARRAY`; `VOICES_TOO_MANY` when `1 + voices.length > LIMITS.maxVoices`; per voice `VOICE_NOT_OBJECT`, `VOICE_ID_*` (unique within `voices[]`), `VOICE_GAIN_*` (finite, [0,1]); when `name` is PRESENT, REUSE `NAME_NOT_STRING`/`NAME_TOO_LONG` (≤80) at path `voices[k].name` (spec §1.1 "reuse the name rule"); `VOICE_NODES_NOT_ARRAY`/`_EMPTY`, then the full per-node validation at `voices[k].nodes[…]` paths (carrier@t=0, sorted/unique t≤durationSec, ParamPoint/ModPoint/spatial/exp); `VOICES_TOO_MANY_PULSES` when the total worklet-spawning lane count exceeds `LIMITS.maxPulseWorklets` — COUNTING: across the PRIMARY voice's top-level `preset.nodes` AND every `voices[k].nodes` (counts voice 0, matching the `1 + voices.length` cap), counting ONE per `(voice, param-lane)` whose mod shape spawns an AudioWorklet — `pulse` OR `square` (NOT `box`/`steps`/`sine`/`triangle`, which use ConstantSource/native osc — cf. automation.ts `schedulePulseSpan` vs `scheduleBoxSpan`/`scheduleStepSpan`), since a continuous-phase lane is one persistent worklet regardless of keyframe count; the `VOICES_CARRIER_TOO_CLOSE` warning when any two voices' t=0 carrier base values (the PRIMARY `preset.nodes[0].carrier` participates in the pairwise scan) are within ratio < 1.1 OR |Δ| < 30 Hz
  - Handles: `voices` absent → no checks (valid, single-voice); the prefix default keeps top-level node paths byte-identical (existing tests unchanged); carrier-too-close is a WARNING (ok stays true)
  - Tests: a valid 3-extra-voice preset → ok:true; each new code triggered by one bad field at the documented path; `1 + voices.length > 4` → `VOICES_TOO_MANY`; per-voice missing carrier@t=0 → `CARRIER_NOT_AT_START` at `voices[k].nodes[0]`; duplicate voice id → `VOICE_ID_DUPLICATE`; a `voices[k].name` of 81 chars → `NAME_TOO_LONG` at `voices[k].name`; the primary's t=0 carrier participates (primary 200 + extra 210 → `VOICES_CARRIER_TOO_CLOSE`), and two carriers 200 & 205 Hz → `VOICES_CARRIER_TOO_CLOSE` (warning, ok:true); >8 worklet-spawning (pulse/square) lanes across primary+extras → `VOICES_TOO_MANY_PULSES` (8 accepted), while a `box`/`steps`-only preset does NOT trigger it; top-level node-error paths still read `nodes[i]…` (no regression)

- [x] [impl] [data] Add `normalizeVoice` (canonical order id,name,gain,nodes; per-voice nodes via the existing `normalizeNode`) wired into `normalizePreset` AFTER layers; register `MIGRATIONS[5]` as the pure v5→v6 version-bump; add the `voiceView(preset, nodes)` shared helper; update the stub-registry MIGRATIONS marker AND the stale in-code migration comments | file: src/engine/session-model.ts, .dev/.task-state/stub-registry.md | model: T1
  - Ref: .dev/planning/multi-voice-architecture.md @ §1.4 normalization/migration/linchpin; §1.5 voiceView helper
  - Ref: src/engine/session-model.ts @ normalizePreset (995-1008, the allowlist clone — add the `voices` copy block mirroring `'layers' in root`); MIGRATIONS (1118-1122); the migration narrative comment + `TODO(stub)` marker (1113-1117 — update "output is always v5" → "always v6" and ">v5 schema" → ">v6 schema"; these are prose, NOT caught by the literal sweep)
  - Ref: .dev/.task-state/stub-registry.md — advance the `MIGRATIONS[from]` forward-extension marker to MIGRATIONS[5] (v5→v6); ALSO reconcile the stale baseline — add a Resolved row for the already-shipped `MIGRATIONS[4]` (v4→v5, a STRUCTURAL migration, not a pure bump) and correct the Active row text from ">v4" to ">v6"; the extension point stays for any future >v6 bump
  - Creates: `normalizeVoice` wired into `normalizePreset` after the layers copy (absent `voices` stays absent — sparse); `MIGRATIONS[5] = (obj) => ({ ...obj, schemaVersion: 6 })`; `export function voiceView(preset: Preset, nodes: TimeNode[]): Preset` returning the non-recursive `{schemaVersion,name,durationSec,masterGain,nodes}` (no voices/layers); `createDefaultPreset` stays single-voice (no `voices` key)
  - Tests: a v5 preset parses → migrates to v6 (`migratedFrom:5`, no `voices`); v6 passthrough (`migratedFrom:null`); `schemaVersion 7` → `SCHEMA_TOO_NEW`; **round-trip `presetsEqual` true** for a multi-voice preset (the linchpin proof — canonical voice key order, per-voice nodes preserved); absent `voices` stays absent through round-trip; `voiceView(preset, voices[0].nodes)` yields a valid single-voice Preset whose nodes === that voice's nodes
  - Ripple: `persistence` re-saves migrated v5 presets at v6 (reads `migratedFrom`); transport + renderer consume `voiceView`

- [x] [data] Cross-tree atomic literal sweep — bump every remaining `schemaVersion: 5` literal to `6` (EXCEPT the permanent must-stay-5 sites: `session-model.ts:1129` (`migrateV4ToV5`'s v4→v5 output stamp) and any test fixture that intentionally feeds v5 INPUT to a migration) so the schema bundle lands green on `npm run check` | file: (multiple — atomic schema bundle) | model: T1
  - Ref: .dev/planning/multi-voice-architecture.md @ §0 (the atomic bundle file list); §8 (the `automation.test.ts:44` un-owned literal)
  - Accepts: nothing (mechanical version-literal sweep)
  - Creates: `"schemaVersion": 5 → 6` in all 16 `presets/*.json`; the 4 inline built-ins in `src/engine/persistence.ts` → 6; the `default-sessions.ts:27` comment (`5`→`6`, per spec §0 bundle list); the `Preset`-typed `schemaVersion: 5` literals in `src/engine/automation.test.ts:44`, `src/engine/renderer.test.ts` (basePreset), `src/engine/persistence.test.ts`, and any remaining test fixtures (`grep -rn 'schemaVersion.*5'`). SEPARATELY move the `SCHEMA_TOO_NEW` "future" sentinels from `6`→`7` (NOT 5→6): the `session-model.test.ts` gate tests and `persistence.test.ts` C4 (`:385`) — after the bump v6 is current, so a v6 body is VALID and a too-new gate must use v7
  - Behavior: lands in the SAME commit/landing as the three session-model tasks above and the persistence data tasks — partial landing crashes `seedDefaultPresets` (WRONG_SCHEMA_VERSION) or fails `npm run check`
  - Tests: `npm test` AND `npm run check` both green; `grep -rn 'schemaVersion.*5'` returns NO hits except the ALLOWLIST — `session-model.ts:1129` (the `migrateV4ToV5` output, permanently 5) and migration-fixture tests that intentionally feed v5 INPUT; and no `schemaVersion: 6` `SCHEMA_TOO_NEW` sentinel remains (they moved to 7)
  - Ripple: every seed + import path now emits/accepts v6; the default-presets glob test still passes (files validate as v6)

- [x] [test] Extend session-model.test.ts: version-literal sweep to 6 (mkPreset + inline literals; gate tests 6→7; rewrite the v5-identity migrate test to v5→v6 + add a v6 passthrough; retarget v2/v3/v4 migrate-target + canonical-order assertions to v6) and append the multi-voice describe blocks | file: src/engine/session-model.test.ts | model: T1/T1/T2/T3
  - Ref: .dev/testing-standards.md
  - Ref: .dev/planning/multi-voice-architecture.md @ §1 (every voice boundary is a test row); §8 (round-trip linchpin proof)
  - Ref: .dev/planning/modules/session-model/edge-cases.md @ §1 (assert the verbatim VOICE_*/VOICES_* message templates)
  - Creates: appended v6 voice describe-blocks — valid multi-voice preset; one case per new code at the exact path + verbatim message; cap `VOICES_TOO_MANY`; `VOICES_CARRIER_TOO_CLOSE` warning (ok:true); per-voice reuse of node codes at `voices[k].nodes[…]`; v5→v6 migration (`migratedFrom:5`); round-trip `presetsEqual`; `{voices:[]}` vs absent; canonical key order stable
  - Handles: the existing v5 guardrail — every pre-existing assertion stays passing EXCEPT the version-const/gate/migrate-target updates (mirror the v4→v5 bump pattern)
  - Tests (this task IS the tests): `npx vitest run src/engine/session-model.test.ts` green, then full `npm test` + `npm run check` green (zero cross-module regression)

- [x] [data] Add the Voice contract to interfaces.md §11 (Voice + Preset.voices + the merged VOICE_*/VOICES_* union + LIMITS.maxVoices/maxPulseWorklets + voiceView), the VOICE_* verbatim message templates + voice-cap/round-trip rows to edge-cases.md, and correct the STALE `CURRENT_SCHEMA_VERSION` (interfaces.md:16 says 4) to 6 | file: .dev/planning/modules/session-model/interfaces.md, .dev/planning/modules/session-model/edge-cases.md | model: T2
  - Ref: .dev/planning/multi-voice-architecture.md @ §1; §8
  - Behavior: the published union in §11 is the contract UI error-display and persistence assertions code against — publish it BEFORE those modules build
  - Tests: docs-only; no code change

- [x] [audit] Behavioral audit: session-model v6 multi-voice | file: .dev/.task-state/session-model/behavioral-audit-v6-voices.md | model: T1
  - Ref: C:/Projects/.dev-shared/behavioral-audit.md
  - Ref: .dev/planning/multi-voice-architecture.md @ §0/§1/§8
  - Verify every new export is reachable; trace `validate`→issues for voices; `MIGRATIONS[5]` two-/one-/zero-step walk to v6; normalization canonical order + absent-voices sparseness; the round-trip linchpin holds; the atomic bundle is complete (`npm test` AND `npm run check` green before AND after; zero `schemaVersion: 5` literals remain outside intentional v5-input fixtures)
  - Write findings; PASS required before any multi-voice module begins (Layer-A checkpoint)

## Completion Criteria
- [x] All tasks above marked [x] — none left [ ] (Pending) or [!] (Needs-Attention)
- [x] Zero active stubs for this module in .dev/.task-state/stub-registry.md (the multi-voice task registers `MIGRATIONS[5]` (v5→v6); the `MIGRATIONS[from]` forward-extension point remains documented for any future >v6 bump)
- [x] All session-model module tests passing
- [x] Per-task audit PASS for every task
- [x] last-step-summary.md written for every task with a concrete Observable Verification entry
- [x] Behavioral audit PASS (see audit task above)
