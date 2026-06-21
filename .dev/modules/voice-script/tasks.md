# Tasks: voice-script
# Planning: .dev/planning/modules/voice-script/
# Architecture: .dev/modules/voice-script/architecture.md
# Standards: security, safety
# Stack: typescript

## Agent Briefing
`voice-script` is the deterministic compiler that turns an AI-authorable **VoiceScript** JSON into
playable artifacts: voice-kind `Layer`s + their deduped `Clip`s + a per-cue duck intent. It is a
pure-TS, authoring-time-only module in one file (`src/engine/voice-script.ts`) with **zero npm
runtime dependency**. It imports `session-model` (types: `Layer`/`LayerKind`/`LanePoint`) and
`clip-library` (`Clip`, `ClipSourceAdapter`, `importVia`), and consumes a `tts-local` adapter
**injected** through `CompileDeps.tts` — it never imports `tts-local`. Consumers (ui /
preset-builder) merge the emitted layers into `Preset.layers`, add the clips to the library, and
hand the `layers` to `layer-scheduler`, which reads each cue's duck off `Layer.duck` (D-038). The
single public entry is `compileVoiceScript(script, { tts, clipLib })`.

## References
- .dev/planning/modules/voice-script/design.md — the five-phase pipeline (validate → resolve →
  flatten → synthesize → layout/emit), gap precedence, the three repeat mechanisms, `at:` anchors,
  duck-intent carriage, synthesis-failure handling, determinism guarantees
- .dev/planning/modules/voice-script/interfaces.md — exact TS for every type, signature, constant,
  the diagnostics model, and the error class (§1–§5)
- .dev/planning/modules/voice-script/edge-cases.md — verbatim message templates (§1) and every
  failure mode / boundary (§2–§11)
- .dev/planning/modules/voice-script/dependencies.md — zero-runtime-dep posture; the injected
  `ClipSourceAdapter` seam (D-023); why no ajv
- .dev/planning/phase2-audio-architecture.md — §6 (the `compileVoiceScript` contract row, restated
  verbatim in interfaces.md §2.1, + build order); §4 (the duck intent triple consumed by
  layer-scheduler)
- .dev/modules/voice-script/architecture.md — execution map (file structure, public interface)

## Dependencies
Hard prerequisites that MUST be complete and green before this module starts (arch §6 build order:
"authoring (tts-local, voice-script)" is last):
- **session-model schema bump v3→v4** (arch §0) landed: `Layer`, `LayerKind =
  'tone'|'ambiance'|'voice'`, `LanePoint`, `Preset.layers` exist; `session-model.test.ts` green.
- **clip-library** landed: `Clip`, `ClipSourceAdapter`, and `importVia(adapter, input): Promise<Clip>`
  exist (content-hash cache, dedup, measured `durationSec`).
- **tts-local** landed: `createTtsAdapter()` returns a `ClipSourceAdapter<TtsInput>` (used only as a
  real adapter at integration time; unit tests use a stub adapter).

**Cohesion guardrail (whole module):** `voice-script` is additive — it touches NO existing engine
file. The Phase-1 guardrail suites are byte-identical and MUST run green BEFORE and AFTER this
module's work, unchanged: `src/engine/automation.test.ts` (the `scheduleLane` extraction op-sequence
check), `src/engine/audio-engine.test.ts` (the `master` flag defaults to `'internal'`), and
`src/engine/transport-master-gain.test.ts`. No-click ramps (D-008) and single-writer-per-param
(D-019) are owned by mixer / layer-scheduler, NOT here — this module emits only a declarative duck
*intent* and never writes an `AudioParam`. Any change to those three suites is out of scope and a
sign of accidental coupling.

## Tasks

- [x] [prereq] Add the `voice-script` source file to the engine entry and confirm the three project module deps resolve (session-model types, clip-library importVia, the injected tts adapter shape) — no logic yet | file: src/engine/voice-script.ts | model: T3
  - Ref: .dev/planning/modules/voice-script/dependencies.md @ Project dependencies — types-only `session-model`; `import` of `clip-library` (`Clip`, `ClipSourceAdapter`, `importVia`); `tts-local` interface-only/injected (NEVER imported)
  - Ref: .dev/planning/phase2-audio-architecture.md @ §6 (build order — voice-script is last, after session-model schema + clip-library + tts-local)
  - Ref: .dev/modules/voice-script/architecture.md @ Dependencies
  - Accepts: nothing (scaffolding only)
  - Creates: `src/engine/voice-script.ts` with the import lines (`type { Layer, LayerKind, LanePoint } from './session-model'`; `{ type Clip, type ClipSourceAdapter } from './clip-library'`) and a file-level doc comment naming the five phases; build/typecheck passes with the file present
  - Behavior: NO runtime logic; this is the dependency-wiring prereq so later tasks compile. Confirm there is NO `import` of `tts-local` (the adapter is injected via `CompileDeps`, dependencies.md)
  - Tests: project typecheck/build succeeds with the new file; a presence test asserts the module imports without side effects (no top-level execution); grep-level assertion in review that `tts-local` is not imported
  - Stubs expected: the file body is a stub until the type/impl tasks below land — register in .dev/.task-state/stub-registry.md

- [x] [data] Declare the VoiceScript types, the diagnostics model, the result/companion types, constants, and the VoiceScriptError class | file: src/engine/voice-script.ts | model: T1Lite
  - Ref: .dev/planning/modules/voice-script/interfaces.md @ §1 VoiceScript types (`Lang`, `VoicePurpose`, `DuckIntent`, `VoiceScript`, `ScriptLoop`, `Block`, `Line` = `SayLine | PauseLine | InlineRepeatLine`)
  - Ref: .dev/planning/modules/voice-script/interfaces.md @ §1 Compiler constants (`DEFAULT_VOICES`, `MAX_REPEAT_DEPTH = 8`, `MAX_PLACEMENTS = 100_000`); §2.1/§2.2 result + deps types (`CompileResult`, `CompiledVoice`, `CompileDeps`, `TtsInput`, `ClipLibraryFacade`); §3 diagnostics (`Severity`, `CompileCode`, `CompileIssue`); §4 `VoiceScriptError`
  - Ref: .dev/planning/phase2-audio-architecture.md @ §6 (the `compileVoiceScript` return shape `Promise<{ layers: Layer[]; clips: Clip[] }>` — the success arm of `CompiledVoice` must be byte-for-byte this shape); §4 (the `DuckIntent` triple `{ toGain, attackSec, releaseSec }` is identical to the arch `DuckSpan` gain triple; `DuckIntent` is imported from `session-model`, D-038, and rides each cue's `Layer.duck`)
  - Ref: .dev/planning/modules/voice-script/edge-cases.md @ §1 (the complete `CompileCode` set must match every message-template row)
  - Accepts: nothing (declarations only)
  - Creates: all exported types/interfaces from interfaces.md §1–§4; `DEFAULT_VOICES: Record<Lang, string>` populated with the D-033 Kokoro ids (one per en/es/fr/ja); `MAX_REPEAT_DEPTH = 8`; `MAX_PLACEMENTS = 100_000`; `class VoiceScriptError extends Error` with `readonly name: 'VoiceScriptError'` and `readonly issues: CompileIssue[]`
  - Behavior: `CompileResult` is the discriminated union `{ ok:true; compiled; issues } | { ok:false; issues }`; `CompiledVoice` carries `layers`/`clips`/`totalSec` (no `duckIntents` map); `CompileCode` enumerates EVERY code in edge-cases §1 (errors + the four warnings `AT_NEGATIVE_SLACK`/`TOTAL_EXCEEDS_DURATION`/`AT_INSIDE_REPEAT`/`UNKNOWN_FIELD`). Carriage decision (design §8): the duck intent rides each cue's `Layer.duck` (D-038: duck rides Layer.duck), NOT a `CompiledVoice.duckIntents` companion map; `DuckIntent` is imported from `session-model` (the owner), never redeclared here
  - Tests: `DEFAULT_VOICES` has exactly the four `Lang` keys, each a non-empty string; `MAX_REPEAT_DEPTH===8` and `MAX_PLACEMENTS===100_000`; `VoiceScriptError` sets `name` and carries the passed `issues`; type-level — `Line` is the three-arm union, `CompiledVoice.layers` is `Layer[]`, `CompileResult` narrows on `ok`; the `CompileCode` union contains every code that appears in an edge-cases §1 message template (no orphans either direction)

- [x] [impl] Implement validate: untrusted-input structural + range checks, the exactly-one-discriminator Line rule, collect-all-never-throw, JSON-style paths | file: src/engine/voice-script.ts | model: T1
  - Ref: .dev/planning/modules/voice-script/design.md @ §7 Validation (collect all, synthesize nothing on error; top-level shape; the malformed-Line discriminator rule; unknown language; empty blocks; ranges/positivity; recursion/placement caps)
  - Ref: .dev/planning/modules/voice-script/edge-cases.md @ §1 Message templates (write EVERY message verbatim, `{…}` interpolated); §3 Unknown language; §4 Empty/degenerate; §5 Malformed Line; §9 negative gaps (the `*_GAP_*NEGATIVE` errors)
  - Ref: .dev/planning/modules/voice-script/interfaces.md @ §3 diagnostics model (`CompileIssue` shape, path format `blocks[1].lines[0].say`)
  - Ref: .dev/planning/phase2-audio-architecture.md @ §4 (`duck` must be a valid `{ toGain∈[0,1], attackSec≥0, releaseSec≥0 }` triple or null)
  - Accepts: `value: unknown` (the candidate VoiceScript)
  - Creates: an internal `validate(value): CompileIssue[]` (error-severity issues collected over: root object; `version===1`; `purpose` in the closed set; finite/range `startAtSec`≥0, `rateScale`>0; `voices` object with string ids; `duck` object-or-null with `toGain∈[0,1]`/`attackSec≥0`/`releaseSec≥0`; non-empty `blocks`; per-block `pacing.gapSec`≥0, `repeat.count` int≥1/`gapSec`≥0, non-empty `lines`; per-line EXACTLY-ONE-of `say`/`pauseSec`/`repeat` → `LINE_NO_DISCRIMINATOR`(0)/`LINE_MULTI_DISCRIMINATOR`(n); `say` non-empty-after-trim, `rateScale`>0, `gapAfterSec`≥0, `at`≥0, resolvable `lang`→`UNKNOWN_LANG`; `pauseSec`>0; inline `repeat` non-empty/`count` int≥1/`gapSec`≥0). Auxiliary keys on non-`say` lines → `UNKNOWN_FIELD` warning. Never throws; never mutates input
  - Behavior: ALL issues collected (no fail-fast); paths are JSON-style (object keys dot-joined, array indices bracketed, `""` for root). On any error-severity issue the caller must run NO synthesis (enforced by the entry-point task). Recursion-depth (`MAX_REPEAT_DEPTH` → `REPEAT_TOO_DEEP`) is checked while walking nested inline `repeat` here; the flattened-count cap (`SCRIPT_TOO_LARGE`) is checked in the flatten task
  - Handles: `NaN`/`±Infinity` everywhere → the matching `*_NOT_FINITE`; line that is not an object → `LINE_NOT_OBJECT`; all-whitespace `say` → `SAY_EMPTY`; `pauseSec:0` → `PAUSE_NOT_POSITIVE` (while `gapSec:0` is legal); negative gaps → `*_GAP_*NEGATIVE`
  - Tests: a valid script → zero error-severity issues; EACH error code triggered by exactly one bad field (table-driven over edge-cases §1); collect-all — a script with three independent errors returns all three; input object never mutated; `LINE_NO_DISCRIMINATOR` for `{ lang:'en' }`, `LINE_MULTI_DISCRIMINATOR` (count 2) for `{ say, pauseSec }`; whitespace-only `say` → `SAY_EMPTY`; `pauseSec:0` → `PAUSE_NOT_POSITIVE` but `pacing.gapSec:0` accepted; unsupported `lang:'de'` → `UNKNOWN_LANG`; messages match the verbatim templates (path + interpolated values exact)

- [x] [impl] Implement deterministic voice + effective-rate resolution (no I/O) | file: src/engine/voice-script.ts | model: T1Lite
  - Ref: .dev/planning/modules/voice-script/design.md @ §4 Voice & rate resolution (voice id precedence `Line.voice` → `script.voices[lang]` → `DEFAULT_VOICES[lang]`; effective rate = `(Line.rateScale ?? 1) * (script.rateScale ?? 1)`, multiplicative; rate affects synthesis only, never gaps/pauses and never post-stretch)
  - Ref: .dev/planning/modules/voice-script/edge-cases.md @ §3 Unknown/unsupported language (unresolvable voice → `UNKNOWN_LANG`, already caught in validate); §10 a line differing only in effective rate is a distinct clip
  - Ref: .dev/planning/phase2-audio-architecture.md @ §6 (the tts adapter hash is `SHA256(model+voice+lang+text+rate)` — the COMPOSED effective rate is part of the cache key, so resolution must produce the exact value passed to the adapter)
  - Accepts: a `SayLine`, its block/script context, and the validated `script`
  - Creates: internal pure helpers `resolveVoice(line, lang, script): string` and `effectiveRate(line, script): number`; `lang` defaults to `'en'` when `Line.lang` is absent
  - Behavior: pure, no I/O, no wall-clock — same inputs → same outputs (design §11). The resolved voice + composed rate are the values handed to the synthesize task's `TtsInput`, so two say placements with identical `text+voice+lang+effectiveRate` produce the SAME cache key (one clip), and two differing only in effective rate produce DISTINCT clips
  - Tests: per-line `voice` override beats `script.voices[lang]` beats `DEFAULT_VOICES[lang]`; missing `Line.lang` resolves as `'en'`; effective rate composes multiplicatively (global `0.9` × per-line `1.1` = `0.99`; default both → `1`); resolution is referentially transparent (called twice, identical result); a line differing only in `rateScale` yields a different composed rate (drives a distinct clip downstream)

- [x] [impl] Implement the flatten phase: expand inline `repeat`, block `repeat`, and script `loop` into one linear placement list with the placement/depth caps | file: src/engine/voice-script.ts | model: T1
  - Ref: .dev/planning/modules/voice-script/design.md @ §6 The three repetition mechanisms + clip reuse (inline `repeat` in-place ×count with `gapSec` BETWEEN iterations not after last; block `repeat` repeats the block's flattened lines; script `loop` repeats the whole body; the innermost-first interaction order; `loop` resolution rules — `count`, `untilSec` whole-iterations-only, both → more-restrictive bound wins, neither → single pass)
  - Ref: .dev/planning/modules/voice-script/design.md @ §5.3 (note: a repeat's between-iteration `gapSec` is a DISTINCT gap from the per-line/block-pacing trailing gap)
  - Ref: .dev/planning/modules/voice-script/edge-cases.md @ §8 Repetition bounds & explosion (`MAX_REPEAT_DEPTH`→`REPEAT_TOO_DEEP`; `MAX_PLACEMENTS`→`SCRIPT_TOO_LARGE` counted DURING expansion before synthesis; `count:1` legal no-op; `loop` neither bound → single pass; both → more-restrictive)
  - Ref: .dev/planning/phase2-audio-architecture.md @ §6 (output feeds layout which must remain a single linear walk — flatten resolves all repetition so layout never sees a loop)
  - Accepts: the validated `script`
  - Creates: internal `flatten(script): Placement[]` — an ordered list of atomic say/pause placements, each tagged with its resolved voice/lang/effectiveRate (via the resolution helpers) and its effective trailing-gap context plus any synthetic between-iteration pause; loops/repeats fully expanded; aborts with a `SCRIPT_TOO_LARGE` error when the running count would exceed `MAX_PLACEMENTS`
  - Behavior: pure and deterministic. Expansion order innermost-first: inline `repeat` within its line → block `repeat` over the block's already-expanded lines → script `loop` over the already-expanded body. `loop.untilSec` emits whole iterations only (no mid-line truncation; the last may run past `untilSec` since lines are atomic) and is bounded; `count`+`untilSec` together stop at whichever triggers first. Between-iteration `gapSec` (inline/block/loop) becomes a synthetic pause between iterations, never after the last
  - Handles: `count:1` → one pass (no-op); empty `loop:{}` → single pass (NEVER infinite); deeply nested inline `repeat` beyond `MAX_REPEAT_DEPTH` → `REPEAT_TOO_DEEP` (already flagged in validate, re-guarded here defensively); placement explosion → `SCRIPT_TOO_LARGE` counted as it expands
  - Tests: inline `repeat` count 2 → inner lines emitted twice with `gapSec` between only; block `repeat` count 3 → block lines ×3, block `pacing` still governs intra-iteration spacing; `loop.count:1` → single pass; `loop.count:3` → body ×3 with `loop.gapSec` between; `loop.untilSec` → whole iterations until cursor reaches the bound, last iteration not truncated; `loop` with both `count` and `untilSec` → more-restrictive wins; `loop:{}` → exactly one pass; nesting order composes (inline inside block inside loop produces the expected linear count); an expansion exceeding `MAX_PLACEMENTS` → `SCRIPT_TOO_LARGE`; flatten is deterministic across two calls

- [x] [impl] Implement the layout walk + voice-layer/duck-intent emission: absolute time from real durations, gap precedence, `at:` anchors, `startAtSec` | file: src/engine/voice-script.ts | model: T1
  - Ref: .dev/planning/modules/voice-script/design.md @ §5 Layout walk (the single `cursor` in session-timeline seconds initialized to `startAtSec ?? 0`; per-placement advance for say vs pause; §5.3 gap precedence `effectiveGap = line.gapAfterSec ?? (isLastLineOfBlock ? 0 : block.pacing?.gapSec ?? 0)`; §5.4 `startAtSec` composition)
  - Ref: .dev/planning/modules/voice-script/design.md @ §8 Emitting voice layers + the duck intent (the `{ id, kind:'voice', source:{clipId}, t, duck }` shape; deterministic positional id `vs_<blockIdx>_<lineIdx>_<iteration>`; the script-level `duck` copied per cue onto `Layer.duck` (D-038, the session-model field); `duck:null` → `Layer.duck` omitted); §9 diagnostics (`AT_NEGATIVE_SLACK`, `TOTAL_EXCEEDS_DURATION` — returned, never `console`)
  - Ref: .dev/planning/modules/voice-script/edge-cases.md @ §6 total vs preset duration; §7 `at:` anchors (positive slack pads silence, negative slack places at current cursor + `AT_NEGATIVE_SLACK` warning, equal → no padding, inside repeat/loop → first occurrence only + `AT_INSIDE_REPEAT`, `at` before `startAtSec` → negative slack); §9 gap/pacing edge cases (pause + pacing SUM, `gapAfterSec` wins, last line of block no trailing pacing gap)
  - Ref: .dev/planning/phase2-audio-architecture.md @ §1/§4 (voice-kind layers route through `cueInput` downstream of `duckGain` — a cue never ducks itself; the duck intent triple is consumed by layer-scheduler off `layer.duck`, this module only sets it)
  - Accepts: the flattened `Placement[]`, the per-placement measured `clip.durationSec` (supplied by the synthesize task), the `script` (for `duck`, `startAtSec`), and optional `durationSec`
  - Creates: internal `layout(placements, durations, script, durationSec?): { layers: Layer[]; totalSec: number; warnings: CompileIssue[] }` — one `{ kind:'voice', source:{ clipId }, t, duck }` `Layer` per say placement at its absolute `t`, each carrying its `Layer.duck` (when `script.duck` is set), the final `cursor` as `totalSec`, and warning-severity issues. The layers it returns carry their own duck; there is no separate `duckIntents` return
  - Behavior: single left-to-right walk over one `cursor` (the ONLY layout state). Say: emit a layer at `t=cursor` with `Layer.duck` copied from `script.duck`, advance `cursor += clip.durationSec + effectiveGap`. Pause: emit no layer, advance `cursor += pauseSec` (sums with surrounding pacing). Gap precedence per §5.3 (per-line `gapAfterSec` wins; else block pacing except after a block's last line; pacing attaches to say lines only). `at:` positive slack → pad silence to `at`; negative slack → place at current cursor + `AT_NEGATIVE_SLACK` warning (never moves backward, never overlaps); equal → no padding; inside repeat/loop → honored on the first occurrence only + `AT_INSIDE_REPEAT`. Ids are positional and stable so recompiling yields identical ids/`t` (idempotent re-import, design §10/§11). Uses MEASURED durations only — never an estimate
  - Handles: final cursor > `durationSec` (when supplied) → `TOTAL_EXCEEDS_DURATION` warning, full layers still returned (no tail-drop); `durationSec` absent → check skipped; `duck:null`/absent → `Layer.duck` omitted on every cue. All diagnostics RETURNED in `warnings`, never `console.*` (D-035)
  - Tests: deterministic layout — a fixed script + fixed durations yields exact `t` values and is byte-identical across two runs; gap precedence — `gapAfterSec` overrides block `pacing`, last line of block carries no trailing pacing gap, pause + pacing SUM; `startAtSec` offsets every `t` additively; positive-slack `at:` pads silence (no warning); negative-slack `at:` places at cursor + `AT_NEGATIVE_SLACK` with exact `requestedAt`/`actualT`/`overrunSec`; `at:` equal to cursor → no padding/no warning; `at:` inside a repeat → first occurrence pinned, later flow + `AT_INSIDE_REPEAT`; total > `durationSec` → `TOTAL_EXCEEDS_DURATION`, all layers returned; ids are positional and stable across recompile; each emitted cue carries `Layer.duck === script.duck` (omitted when `duck:null`); NO `console` call occurs (spy asserts zero calls)

- [x] [impl] [integration] Implement the public entry points: orchestrate validate → resolve → flatten → synthesize (sequential importVia, cache reuse, dedup) → layout → emit; wire compileVoiceScript + compileVoiceScriptOrThrow | file: src/engine/voice-script.ts | model: T1
  - Ref: .dev/planning/modules/voice-script/design.md @ §3 the deterministic compile pipeline (five ordered phases); §6 clip reuse across all repetition (one synthesis per distinct `text+voice+lang+effectiveRate`; `layers` may point at the same clip id many times, `clips` is DEDUPED one per id); §10 failure during synthesis (sequential `importVia`; first rejection → `SYNTH_FAILED` error, NO partial `{layers,clips}`, NO rollback — stored clips stay valid)
  - Ref: .dev/planning/modules/voice-script/interfaces.md @ §2.1 the entry signature (RESTATED VERBATIM from arch §6 — success arm `compiled.{layers,clips}` is byte-for-byte `{ layers: Layer[]; clips: Clip[] }`); §2.2 `CompileDeps`/`TtsInput`/`ClipLibraryFacade`; §2.3 `compileVoiceScriptOrThrow`; §4 `VoiceScriptError`
  - Ref: .dev/planning/modules/voice-script/edge-cases.md @ §2 synthesis failure mid-compile; §10 determinism/idempotency (recompile → identical layers (incl. each `Layer.duck`)/clips; deduped clips); §11 dependency/injection edge cases (missing `tts`, `importVia` rejecting with `QUOTA_EXCEEDED`/`UNSUPPORTED`/`DB_ERROR` → caught as `SYNTH_FAILED`; `durationSec` absent → check skipped)
  - Ref: .dev/planning/phase2-audio-architecture.md @ §6 (the `compileVoiceScript` row — the public contract this entry satisfies verbatim on the success path); §4 (each cue's `Layer.duck` feeds layer-scheduler, D-038)
  - Accepts: `script: VoiceScript`, `deps: CompileDeps` (`{ tts, clipLib, durationSec? }`)
  - Creates: `compileVoiceScript(script, deps): Promise<CompileResult>` and `compileVoiceScriptOrThrow(script, deps): Promise<{ layers: Layer[]; clips: Clip[] }>`
  - Behavior: (1) run validate; on ANY error-severity issue resolve `{ ok:false, issues }` and call NEITHER `tts` NOR `importVia` (fail fast = fail cheap). (2) flatten. (3) synthesize SEQUENTIALLY: for each distinct placement key call `clipLib.importVia(tts, ttsInput)` once, key by `text+voice+lang+effectiveRate`, reuse the returned `Clip` across every repeat/loop occurrence, collect a DEDUPED `clips` array (one `Clip` per id). (4) layout/emit (each cue's `Layer.duck` set from `script.duck`). Resolve `{ ok:true, compiled:{ layers, clips, totalSec }, issues: warnings }`. `compileVoiceScriptOrThrow` throws `VoiceScriptError(issues)` on any error-severity issue, drops warnings, returns the bare `{ layers, clips }`
  - Handles: any `importVia` rejection (incl. clip-library `ClipLibraryError.code` and a missing/wrong `tts` adapter) caught and converted to a `SYNTH_FAILED` error (path = failing line, `textPreview` ≈ first 40 chars, `adapterMessage` = caught `.message`/`.cause`); resolves `{ ok:false, issues }` with NO partial artifacts; the raw rejection NEVER escapes. No rollback of earlier-stored clips (content-addressed, design §10). `durationSec` absent → `TOTAL_EXCEEDS_DURATION` skipped
  - Tests: happy path — a valid multi-block script with a repeat resolves `ok:true`, `compiled.layers` shape matches arch §6 (`{ kind:'voice', source:{clipId}, t, duck }`), `compiled.clips` deduped, each cue carries `Layer.duck`; **deterministic layout** — recompiling the same script yields byte-identical `layers`/`clips`/`totalSec`; **repeat/loop** — a phrase repeated N× synthesizes ONCE (`importVia` called once for it) yet emits N layers at the right `t`, clips deduped; **duck-intent carriage** — every emitted cue has `layer.duck` equal to `script.duck` (and `Layer.duck` omitted when `duck:null`); **malformed-line handling** — `{ say, pauseSec }` → `{ ok:false, issues:[LINE_MULTI_DISCRIMINATOR…] }` with `importVia` NEVER called (spy asserts zero calls); error path — `importVia` rejection → `SYNTH_FAILED`, `ok:false`, no partial `{layers,clips}`, no uncaught rejection; `compileVoiceScriptOrThrow` throws `VoiceScriptError` on invalid input and returns the bare `{layers,clips}` on valid; injection — a stub adapter drives all tests (no `tts-local` import)

## Behavioral Audit (runs after all tasks above are [x])

- [x] [audit] Module behavioral audit | file: .dev/.task-state/voice-script/behavioral-audit.md | model: T1
  - Ref: C:/Projects/.dev-shared/behavioral-audit.md — Module Behavioral Audit checklist
  - Ref: .dev/planning/modules/voice-script/interfaces.md — every public interface must be verified (`compileVoiceScript`, `compileVoiceScriptOrThrow`, the exported types/constants/`VoiceScriptError`)
  - Ref: .dev/planning/modules/voice-script/design.md — verify intended behavior: deterministic five-phase pipeline, gap precedence, the three repeat mechanisms, `at:` anchors, duck-intent carriage on `Layer.duck` (D-038), synthesis-failure atomicity
  - Ref: .dev/planning/modules/voice-script/edge-cases.md — verify EVERY edge case §2–§11 has handling evidence in the code (verbatim message templates §1, malformed-line discriminator §5, `at:` slack §7, repetition caps §8, gap/pacing §9, determinism §10, injection §11)
  - Ref: .dev/planning/phase2-audio-architecture.md @ §6 (success arm is byte-for-byte `{ layers: Layer[]; clips: Clip[] }`); §4 (the `Layer.duck` triple matches the layer-scheduler `DuckSpan` gain shape)
  - For each public interface: trace input → validate/flatten/synthesize/layout → observable output (layers each carrying `Layer.duck`, deduped clips, totalSec); confirm no silent default masks a real failure (a malformed script returns `ok:false`, never an empty-but-valid-looking success)
  - For each consumer (ui / preset-builder → `Preset.layers`; layer-scheduler ← `layer.duck`): verify they read the correct field names/shapes (`layer.id`, `source.clipId`, `t`, `layer.duck.{toGain,attackSec,releaseSec}`)
  - Confirm the cohesion guardrail: `automation.test.ts`, `audio-engine.test.ts`, `transport-master-gain.test.ts` are byte-identical and green (this module added NO edits to them); confirm `voice-script.ts` does NOT import `tts-local` and writes NO `AudioParam` (no D-019 second-writer, no D-008 ramp)
  - Write findings to .dev/.task-state/voice-script/behavioral-audit.md
  - PASS required before marking this module complete

## Cleanup

- [x] [cleanup] Fix: `clipKey` joins the clip cache/dedup key with literal NUL bytes (`\x00`), making git/grep classify `voice-script.ts` as a binary file (diffs render as "Binary file differs"; the file is unreviewable via normal tooling and the module's own byte-identical cohesion-guardrail diffing cannot apply to it). Replace the NUL delimiter with a non-NUL unambiguous key (e.g. `JSON.stringify([text, voice, lang, rate])`). | file: src/engine/voice-script.ts | model: T2
  - Ref: behavioral audit 2026-06-16 — FIX: NUL-byte delimiter in `clipKey` (voice-script.ts:1047); functionally correct + deterministic, no contract break, but a tooling/maintainability defect
  - Also update the `durations` Map keys in the "should never call console during layout" test (voice-script.test.ts:555) to match the new key fn so it exercises real (non-zero) durations — see behavioral audit NOTE

## Completion Criteria
- [x] All tasks above marked [x] — none left [ ] (Pending) or [!] (Needs-Attention) — cleanup NUL-byte clipKey resolved 2026-06-16
- [x] Zero active stubs for this module in .dev/.task-state/stub-registry.md (the prereq file-body stub is resolved by the type/impl tasks) — verified 2026-06-16: no voice-script entry in the active/Phase-2 stub tables
- [x] All voice-script module tests passing (deterministic layout, repeat/loop, duck-intent carriage, malformed-line handling — happy + error + edge) — 86 tests green 2026-06-16
- [ ] The three cohesion-guardrail suites green and byte-identical: automation.test.ts, audio-engine.test.ts, transport-master-gain.test.ts — GREEN, and voice-script added NO edits; NOT byte-identical vs the Phase-1 baseline, but the diffs are from other Phase-2 modules (session-model v4 schemaVersion bump; audio-engine D-036 `master:'bus'`), not this module (see behavioral-audit.md Cohesion Guardrail). Leave unchecked until verified against the committed baseline.
- [ ] Per-task audit PASS for every task — no separate per-task audit reports found under .dev/.task-state/voice-script/; cannot verify here
- [x] last-step-summary.md written for every task with a concrete Observable Verification entry — verified 2026-06-16: summaries present with Observable Verification sections
- [x] Behavioral audit PASS (see audit task above) — PASS, behavioral-audit.md written 2026-06-16
