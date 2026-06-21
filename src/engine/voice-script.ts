// voice-script — the deterministic VoiceScript compiler (Phase 2, authoring-time only).
//
// Turns an AI-authorable VoiceScript JSON (system-design §8.8) into the concrete playable
// artifacts: voice-kind `Layer`s + the deduped `Clip`s they reference, each cue carrying its
// bed-dip instruction on the session-model `Layer.duck` field (D-038).
//
// The five-phase, fully-deterministic pipeline (design.md §3):
//   1. validate   — untrusted-input structural + range checks; collect ALL issues, never throw,
//                   synthesize nothing on error (§7).
//   2. resolve    — per-language voice id + composed effective rate; pure, no I/O (§4).
//   3. flatten    — expand inline `repeat`, block `repeat`, and script `loop` into ONE linear
//                   placement list, with the placement/depth caps (§6).
//   4. synthesize — for each distinct placement key, `clipLib.importVia(tts, input)` once;
//                   reuse the returned clip across every repeat/loop occurrence; dedup clips (§6, §10).
//   5. layout/emit— single left-to-right cursor walk over REAL clip durations; gap precedence,
//                   `at:` anchors with silence-padding, `startAtSec` offset; emit one voice Layer
//                   per say placement carrying `Layer.duck` (§5, §8, §9).
//
// Zero npm runtime dependency. Imports session-model TYPES only and clip-library types; the
// `tts-local` adapter is INJECTED via `CompileDeps.tts` and is NEVER imported here (D-023 seam).
// Diagnostics are RETURNED (never `console.*`, D-035). Writes no `AudioParam` (no D-008/D-019 here).

import type { Layer, DuckIntent } from './session-model';
import type { Clip, ClipSourceAdapter } from './clip-library';

// ---------------------------------------------------------------------------
// 1. VoiceScript types (the AI contract — exact TS of system-design §8.8)
// ---------------------------------------------------------------------------

export type Lang = 'en' | 'es' | 'fr' | 'ja'; // D-033; extensible

export type VoicePurpose =
  | 'language-learning'
  | 'meditation'
  | 'hypnosis'
  | 'general';

export interface VoiceScript {
  version: 1; // literal 1
  purpose: VoicePurpose; // advisory metadata; compiler does not branch on it
  startAtSec?: number; // ≥ 0 finite; narration start on the session timeline; default 0
  voices?: Partial<Record<Lang, string>>; // language → Kokoro voice id; merged over DEFAULT_VOICES
  rateScale?: number; // > 0 finite; global speaking-rate multiplier; default 1
  duck?: DuckIntent | null; // bed dip under speech; null = no duck; absent = no duck
  loop?: ScriptLoop; // repeat the whole body (sleep packs); absent = single pass
  blocks: Block[]; // non-empty
}

export interface ScriptLoop {
  untilSec?: number; // ≥ 0 finite; repeat whole body until cursor reaches this
  count?: number; // integer ≥ 1; repeat whole body N times
  gapSec?: number; // ≥ 0 finite; silence between whole-body iterations; default 0
}

export interface Block {
  label?: string; // "intro", "vocab set 1"; display only
  pacing?: { gapSec: number }; // ≥ 0 finite; default silence between THIS block's lines
  repeat?: { count: number; gapSec?: number }; // count integer ≥ 1; gapSec ≥ 0; repeat the whole block
  lines: Line[]; // non-empty
}

// Line is a discriminated union — EXACTLY ONE of say / pauseSec / repeat must be present.
export type Line = SayLine | PauseLine | InlineRepeatLine;

export interface SayLine {
  say: string; // non-empty after trim; the utterance text
  lang?: Lang; // default 'en'
  voice?: string; // per-line voice override
  rateScale?: number; // > 0 finite; per-line rate; composes × script.rateScale
  gapAfterSec?: number; // ≥ 0 finite; trailing gap (overrides block pacing)
  at?: number; // ≥ 0 finite; pin to this absolute session time (silence-padded)
}

export interface PauseLine {
  pauseSec: number; // > 0 finite; explicit silence
}

export interface InlineRepeatLine {
  repeat: Line[]; // non-empty; the sub-sequence to drill
  count: number; // integer ≥ 1
  gapSec?: number; // ≥ 0 finite; silence between iterations; default 0
}

// ---------------------------------------------------------------------------
// Compiler constants
// ---------------------------------------------------------------------------

/**
 * D-033 Kokoro-82M speaker ids, one per supported language. The exact ids are a config
 * detail (tts-local design §3.4); these match the interfaces.md worked example
 * (`af_heart` en, `ef_dora` es) and the bundled Kokoro speaker set.
 */
export const DEFAULT_VOICES: Record<Lang, string> = {
  en: 'af_heart',
  es: 'ef_dora',
  fr: 'ff_siwis',
  ja: 'jf_alpha',
};

export const MAX_REPEAT_DEPTH = 8 as const; // inline-repeat nesting cap (REPEAT_TOO_DEEP)
export const MAX_PLACEMENTS = 100_000 as const; // flattened placement cap (SCRIPT_TOO_LARGE)

const SUPPORTED_LANGS: readonly Lang[] = ['en', 'es', 'fr', 'ja'];
const PURPOSES: readonly VoicePurpose[] = [
  'language-learning',
  'meditation',
  'hypnosis',
  'general',
];

// ---------------------------------------------------------------------------
// 2. Result + dependency types
// ---------------------------------------------------------------------------

export type CompileResult =
  | { ok: true; compiled: CompiledVoice; issues: CompileIssue[] } // issues = warnings only (may be [])
  | { ok: false; issues: CompileIssue[] }; // ≥1 error-severity issue

export interface CompiledVoice {
  layers: Layer[]; // arch §6: voice-kind Layer[]; each cue carries its own `Layer.duck`
  clips: Clip[]; // arch §6: deduped Clip[], one per distinct id
  totalSec: number; // final cursor (narration end on the session timeline)
}

export interface CompileDeps {
  tts: ClipSourceAdapter<TtsInput>; // from tts-local; THIS module never imports tts-local
  clipLib: ClipLibraryFacade; // the importVia surface of clip-library
  durationSec?: number; // target preset duration, for the TOTAL_EXCEEDS_DURATION check
}

// The narrow tts-local adapter input (arch §6: createTtsAdapter<{ text; voice?; language?; rateScale? }>).
export interface TtsInput {
  text: string;
  voice?: string;
  language?: Lang;
  rateScale?: number; // the COMPOSED effective rate (design.md §4)
}

// The minimal clip-library surface this module needs.
export interface ClipLibraryFacade {
  importVia<T>(adapter: ClipSourceAdapter<T>, input: T): Promise<Clip>;
}

// ---------------------------------------------------------------------------
// 3. Diagnostics model
// ---------------------------------------------------------------------------

export type Severity = 'error' | 'warning';

export type CompileCode =
  // ---- errors (set ok:false; NO synthesis runs) ----
  | 'NOT_OBJECT'
  | 'VERSION_INVALID'
  | 'PURPOSE_INVALID'
  | 'START_AT_NOT_FINITE'
  | 'START_AT_NEGATIVE'
  | 'RATE_SCALE_NOT_FINITE'
  | 'RATE_SCALE_NOT_POSITIVE'
  | 'VOICES_NOT_OBJECT'
  | 'VOICE_ID_NOT_STRING'
  | 'DUCK_NOT_OBJECT_OR_NULL'
  | 'DUCK_TO_GAIN_OUT_OF_RANGE'
  | 'DUCK_ATTACK_NEGATIVE'
  | 'DUCK_RELEASE_NEGATIVE'
  | 'DUCK_FIELD_NOT_FINITE'
  | 'LOOP_NOT_OBJECT'
  | 'LOOP_COUNT_NOT_INTEGER'
  | 'LOOP_COUNT_TOO_SMALL'
  | 'LOOP_UNTIL_NOT_FINITE'
  | 'LOOP_UNTIL_NEGATIVE'
  | 'LOOP_GAP_NEGATIVE'
  | 'BLOCKS_NOT_ARRAY'
  | 'BLOCKS_EMPTY'
  | 'BLOCK_NOT_OBJECT'
  | 'BLOCK_EMPTY'
  | 'BLOCK_PACING_GAP_INVALID'
  | 'BLOCK_REPEAT_COUNT_NOT_INTEGER'
  | 'BLOCK_REPEAT_COUNT_TOO_SMALL'
  | 'BLOCK_REPEAT_GAP_NEGATIVE'
  | 'LINE_NOT_OBJECT'
  | 'LINE_NO_DISCRIMINATOR'
  | 'LINE_MULTI_DISCRIMINATOR'
  | 'SAY_EMPTY'
  | 'SAY_RATE_SCALE_INVALID'
  | 'SAY_GAP_AFTER_NEGATIVE'
  | 'SAY_AT_NEGATIVE'
  | 'UNKNOWN_LANG'
  | 'PAUSE_NOT_POSITIVE'
  | 'PAUSE_NOT_FINITE'
  | 'REPEAT_EMPTY'
  | 'REPEAT_COUNT_NOT_INTEGER'
  | 'REPEAT_COUNT_TOO_SMALL'
  | 'REPEAT_GAP_NEGATIVE'
  | 'REPEAT_TOO_DEEP'
  | 'SCRIPT_TOO_LARGE'
  | 'SYNTH_FAILED'
  // ---- warnings (ok stays true; artifacts still returned) ----
  | 'AT_NEGATIVE_SLACK'
  | 'TOTAL_EXCEEDS_DURATION'
  | 'AT_INSIDE_REPEAT'
  | 'UNKNOWN_FIELD';

export interface CompileIssue {
  code: CompileCode;
  severity: Severity;
  path: string; // JSON-style: "blocks[1].lines[0].say"; "" for the root
  message: string; // deterministic English (templates in edge-cases.md §1)
}

// ---------------------------------------------------------------------------
// 4. Error class
// ---------------------------------------------------------------------------

export class VoiceScriptError extends Error {
  readonly name = 'VoiceScriptError';
  readonly issues: CompileIssue[];

  constructor(message: string, issues: CompileIssue[]) {
    super(message);
    this.issues = issues;
    // Restore the prototype so `instanceof` holds even when a down-level transpile target
    // breaks the native Error subclass chain.
    Object.setPrototypeOf(this, VoiceScriptError.prototype);
  }
}

// ===========================================================================
// Internal helpers — issue construction
// ===========================================================================

function issue(
  code: CompileCode,
  severity: Severity,
  path: string,
  message: string,
): CompileIssue {
  return { code, severity, path, message };
}

function err(code: CompileCode, path: string, message: string): CompileIssue {
  return issue(code, 'error', path, message);
}

function warn(code: CompileCode, path: string, message: string): CompileIssue {
  return issue(code, 'warning', path, message);
}

function typeofValue(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

/** JSON-style path join (object keys dot-joined; "" for the root). */
function childKey(base: string, key: string): string {
  return base === '' ? key : `${base}.${key}`;
}

/** JSON-style path join for an array index. */
function childIndex(base: string, index: number): string {
  return `${base}[${index}]`;
}

// ===========================================================================
// Phase 1 — validate (collect ALL; never throw; never mutate input)
// ===========================================================================

const DISCRIMINATORS = ['say', 'pauseSec', 'repeat'] as const;
const SAY_FIELDS = new Set([
  'say',
  'lang',
  'voice',
  'rateScale',
  'gapAfterSec',
  'at',
]);

/**
 * Structural + range validation of an untrusted candidate VoiceScript. Returns every
 * error-severity issue (and the UNKNOWN_FIELD warnings) collected over the whole document.
 * Pure: never throws, never mutates `value`.
 */
export function validate(value: unknown): CompileIssue[] {
  const issues: CompileIssue[] = [];

  if (!isPlainObject(value)) {
    issues.push(
      err('NOT_OBJECT', '', `A VoiceScript must be an object, got ${typeofValue(value)}`),
    );
    return issues;
  }

  const s = value;

  // version === 1
  if (s.version !== 1) {
    issues.push(err('VERSION_INVALID', 'version', `"version" must be 1, got ${fmt(s.version)}`));
  }

  // purpose in the closed set
  if (!PURPOSES.includes(s.purpose as VoicePurpose)) {
    issues.push(
      err(
        'PURPOSE_INVALID',
        'purpose',
        `"purpose" must be one of language-learning, meditation, hypnosis, general; got ${fmt(s.purpose)}`,
      ),
    );
  }

  // startAtSec ≥ 0 finite (optional)
  if (s.startAtSec !== undefined) {
    if (!isFiniteNumber(s.startAtSec)) {
      issues.push(err('START_AT_NOT_FINITE', 'startAtSec', `"startAtSec" must be a finite number`));
    } else if (s.startAtSec < 0) {
      issues.push(
        err('START_AT_NEGATIVE', 'startAtSec', `"startAtSec" must be ≥ 0, got ${fmt(s.startAtSec)}`),
      );
    }
  }

  // rateScale > 0 finite (optional)
  if (s.rateScale !== undefined) {
    if (!isFiniteNumber(s.rateScale)) {
      issues.push(err('RATE_SCALE_NOT_FINITE', 'rateScale', `"rateScale" must be a finite number`));
    } else if (s.rateScale <= 0) {
      issues.push(
        err(
          'RATE_SCALE_NOT_POSITIVE',
          'rateScale',
          `"rateScale" must be greater than 0, got ${fmt(s.rateScale)}`,
        ),
      );
    }
  }

  // voices: object mapping lang → string id (optional)
  if (s.voices !== undefined) {
    if (!isPlainObject(s.voices)) {
      issues.push(
        err('VOICES_NOT_OBJECT', 'voices', `"voices" must be an object mapping language → voice id`),
      );
    } else {
      for (const lang of Object.keys(s.voices)) {
        const id = (s.voices as Record<string, unknown>)[lang];
        if (typeof id !== 'string') {
          issues.push(
            err(
              'VOICE_ID_NOT_STRING',
              childKey('voices', lang),
              `Voice id for "${lang}" must be a string`,
            ),
          );
        }
      }
    }
  }

  // duck: object-or-null (optional)
  validateDuck(s.duck, issues);

  // loop (optional)
  if (s.loop !== undefined) validateLoop(s.loop, issues);

  // blocks: non-empty array
  if (!Array.isArray(s.blocks)) {
    issues.push(err('BLOCKS_NOT_ARRAY', 'blocks', `"blocks" must be an array`));
  } else if (s.blocks.length === 0) {
    issues.push(err('BLOCKS_EMPTY', 'blocks', `"blocks" must contain at least one block`));
  } else {
    s.blocks.forEach((block, bi) => {
      validateBlock(block, childIndex('blocks', bi), s, issues);
    });
  }

  return issues;
}

function fmt(v: unknown): string {
  if (typeof v === 'string') return v;
  if (v === undefined) return 'undefined';
  if (v === null) return 'null';
  return String(v);
}

function validateDuck(duck: unknown, issues: CompileIssue[]): void {
  if (duck === undefined || duck === null) return; // null/absent = no duck
  if (!isPlainObject(duck)) {
    issues.push(err('DUCK_NOT_OBJECT_OR_NULL', 'duck', `"duck" must be an object or null`));
    return;
  }
  const fields: Array<['toGain' | 'attackSec' | 'releaseSec', string]> = [
    ['toGain', 'duck.toGain'],
    ['attackSec', 'duck.attackSec'],
    ['releaseSec', 'duck.releaseSec'],
  ];
  for (const [field, path] of fields) {
    const v = duck[field];
    if (!isFiniteNumber(v)) {
      issues.push(err('DUCK_FIELD_NOT_FINITE', path, `"duck.${field}" must be a finite number`));
    }
  }
  if (isFiniteNumber(duck.toGain) && (duck.toGain < 0 || duck.toGain > 1)) {
    issues.push(
      err(
        'DUCK_TO_GAIN_OUT_OF_RANGE',
        'duck.toGain',
        `"duck.toGain" must be within [0, 1], got ${fmt(duck.toGain)}`,
      ),
    );
  }
  if (isFiniteNumber(duck.attackSec) && duck.attackSec < 0) {
    issues.push(
      err('DUCK_ATTACK_NEGATIVE', 'duck.attackSec', `"duck.attackSec" must be ≥ 0, got ${fmt(duck.attackSec)}`),
    );
  }
  if (isFiniteNumber(duck.releaseSec) && duck.releaseSec < 0) {
    issues.push(
      err(
        'DUCK_RELEASE_NEGATIVE',
        'duck.releaseSec',
        `"duck.releaseSec" must be ≥ 0, got ${fmt(duck.releaseSec)}`,
      ),
    );
  }
}

function validateLoop(loop: unknown, issues: CompileIssue[]): void {
  if (!isPlainObject(loop)) {
    issues.push(err('LOOP_NOT_OBJECT', 'loop', `"loop" must be an object`));
    return;
  }
  if (loop.count !== undefined) {
    if (typeof loop.count !== 'number' || !Number.isInteger(loop.count)) {
      issues.push(err('LOOP_COUNT_NOT_INTEGER', 'loop.count', `"loop.count" must be an integer`));
    } else if (loop.count < 1) {
      issues.push(err('LOOP_COUNT_TOO_SMALL', 'loop.count', `"loop.count" must be ≥ 1, got ${fmt(loop.count)}`));
    }
  }
  if (loop.untilSec !== undefined) {
    if (!isFiniteNumber(loop.untilSec)) {
      issues.push(err('LOOP_UNTIL_NOT_FINITE', 'loop.untilSec', `"loop.untilSec" must be a finite number`));
    } else if (loop.untilSec < 0) {
      issues.push(
        err('LOOP_UNTIL_NEGATIVE', 'loop.untilSec', `"loop.untilSec" must be ≥ 0, got ${fmt(loop.untilSec)}`),
      );
    }
  }
  if (loop.gapSec !== undefined) {
    if (!isFiniteNumber(loop.gapSec) || loop.gapSec < 0) {
      issues.push(err('LOOP_GAP_NEGATIVE', 'loop.gapSec', `"loop.gapSec" must be ≥ 0, got ${fmt(loop.gapSec)}`));
    }
  }
}

function validateBlock(
  block: unknown,
  path: string,
  script: Record<string, unknown>,
  issues: CompileIssue[],
): void {
  if (!isPlainObject(block)) {
    issues.push(err('BLOCK_NOT_OBJECT', path, `Block must be an object`));
    return;
  }

  // pacing.gapSec ≥ 0 finite (optional)
  if (block.pacing !== undefined) {
    const pacing = block.pacing;
    const g = isPlainObject(pacing) ? pacing.gapSec : undefined;
    if (!isFiniteNumber(g) || g < 0) {
      issues.push(
        err(
          'BLOCK_PACING_GAP_INVALID',
          childKey(path, 'pacing.gapSec'),
          `Block "pacing.gapSec" must be a finite number ≥ 0, got ${fmt(g)}`,
        ),
      );
    }
  }

  // repeat { count int ≥ 1; gapSec ≥ 0 } (optional)
  if (block.repeat !== undefined && isPlainObject(block.repeat)) {
    const r = block.repeat;
    if (typeof r.count !== 'number' || !Number.isInteger(r.count)) {
      issues.push(
        err(
          'BLOCK_REPEAT_COUNT_NOT_INTEGER',
          childKey(path, 'repeat.count'),
          `Block "repeat.count" must be an integer`,
        ),
      );
    } else if (r.count < 1) {
      issues.push(
        err(
          'BLOCK_REPEAT_COUNT_TOO_SMALL',
          childKey(path, 'repeat.count'),
          `Block "repeat.count" must be ≥ 1, got ${fmt(r.count)}`,
        ),
      );
    }
    if (r.gapSec !== undefined && (!isFiniteNumber(r.gapSec) || r.gapSec < 0)) {
      issues.push(
        err(
          'BLOCK_REPEAT_GAP_NEGATIVE',
          childKey(path, 'repeat.gapSec'),
          `Block "repeat.gapSec" must be ≥ 0, got ${fmt(r.gapSec)}`,
        ),
      );
    }
  }

  // lines: non-empty array
  if (!Array.isArray(block.lines) || block.lines.length === 0) {
    issues.push(err('BLOCK_EMPTY', path, `Block "lines" must contain at least one line`));
    return;
  }

  block.lines.forEach((line, li) => {
    validateLine(line, childKey(path, `lines[${li}]`), script, issues, 0);
  });
}

function validateLine(
  line: unknown,
  path: string,
  script: Record<string, unknown>,
  issues: CompileIssue[],
  depth: number,
): void {
  if (!isPlainObject(line)) {
    issues.push(err('LINE_NOT_OBJECT', path, `A line must be an object`));
    return;
  }

  const present = DISCRIMINATORS.filter((k) => line[k] !== undefined);
  if (present.length === 0) {
    issues.push(
      err(
        'LINE_NO_DISCRIMINATOR',
        path,
        `A line must have exactly one of "say", "pauseSec", "repeat"; found 0`,
      ),
    );
    return;
  }
  if (present.length > 1) {
    issues.push(
      err(
        'LINE_MULTI_DISCRIMINATOR',
        path,
        `A line must have exactly one of "say", "pauseSec", "repeat"; found ${present.length}`,
      ),
    );
    return;
  }

  const kind = present[0];
  if (kind === 'say') {
    validateSay(line, path, script, issues);
  } else if (kind === 'pauseSec') {
    validatePause(line, path, issues);
  } else {
    validateInlineRepeat(line, path, script, issues, depth);
  }
}

function validateSay(
  line: Record<string, unknown>,
  path: string,
  script: Record<string, unknown>,
  issues: CompileIssue[],
): void {
  if (typeof line.say !== 'string' || line.say.trim() === '') {
    issues.push(err('SAY_EMPTY', childKey(path, 'say'), `"say" must be a non-empty string`));
  }
  if (line.rateScale !== undefined && (!isFiniteNumber(line.rateScale) || line.rateScale <= 0)) {
    issues.push(
      err(
        'SAY_RATE_SCALE_INVALID',
        childKey(path, 'rateScale'),
        `Line "rateScale" must be a finite number > 0, got ${fmt(line.rateScale)}`,
      ),
    );
  }
  if (line.gapAfterSec !== undefined && (!isFiniteNumber(line.gapAfterSec) || line.gapAfterSec < 0)) {
    issues.push(
      err(
        'SAY_GAP_AFTER_NEGATIVE',
        childKey(path, 'gapAfterSec'),
        `Line "gapAfterSec" must be ≥ 0, got ${fmt(line.gapAfterSec)}`,
      ),
    );
  }
  if (line.at !== undefined && (!isFiniteNumber(line.at) || line.at < 0)) {
    issues.push(err('SAY_AT_NEGATIVE', childKey(path, 'at'), `Line "at" must be ≥ 0, got ${fmt(line.at)}`));
  }
  // language resolution: default 'en'; an unsupported lang has no resolvable voice.
  const lang = line.lang === undefined ? 'en' : line.lang;
  if (!SUPPORTED_LANGS.includes(lang as Lang)) {
    issues.push(
      err(
        'UNKNOWN_LANG',
        childKey(path, 'lang'),
        `Unsupported language "${fmt(lang)}" (supported: en, es, fr, ja) or no voice resolvable`,
      ),
    );
  } else if (!resolveVoiceId(line, lang as Lang, script)) {
    issues.push(
      err(
        'UNKNOWN_LANG',
        childKey(path, 'lang'),
        `Unsupported language "${fmt(lang)}" (supported: en, es, fr, ja) or no voice resolvable`,
      ),
    );
  }
}

function validatePause(line: Record<string, unknown>, path: string, issues: CompileIssue[]): void {
  if (!isFiniteNumber(line.pauseSec)) {
    issues.push(err('PAUSE_NOT_FINITE', childKey(path, 'pauseSec'), `"pauseSec" must be a finite number`));
  } else if (line.pauseSec <= 0) {
    issues.push(
      err(
        'PAUSE_NOT_POSITIVE',
        childKey(path, 'pauseSec'),
        `"pauseSec" must be greater than 0, got ${fmt(line.pauseSec)}`,
      ),
    );
  }
  // Auxiliary say-only keys on a pause line → UNKNOWN_FIELD warning.
  flagUnknownFields(line, 'pauseSec', path, issues);
}

function validateInlineRepeat(
  line: Record<string, unknown>,
  path: string,
  script: Record<string, unknown>,
  issues: CompileIssue[],
  depth: number,
): void {
  if (depth + 1 > MAX_REPEAT_DEPTH) {
    issues.push(
      err(
        'REPEAT_TOO_DEEP',
        path,
        `Inline "repeat" nesting exceeds the maximum depth of ${MAX_REPEAT_DEPTH}`,
      ),
    );
    return;
  }
  if (!Array.isArray(line.repeat) || line.repeat.length === 0) {
    issues.push(err('REPEAT_EMPTY', childKey(path, 'repeat'), `"repeat" must contain at least one line`));
  }
  if (typeof line.count !== 'number' || !Number.isInteger(line.count)) {
    issues.push(err('REPEAT_COUNT_NOT_INTEGER', childKey(path, 'count'), `"repeat.count" must be an integer`));
  } else if (line.count < 1) {
    issues.push(
      err('REPEAT_COUNT_TOO_SMALL', childKey(path, 'count'), `"repeat.count" must be ≥ 1, got ${fmt(line.count)}`),
    );
  }
  if (line.gapSec !== undefined && (!isFiniteNumber(line.gapSec) || line.gapSec < 0)) {
    issues.push(
      err('REPEAT_GAP_NEGATIVE', childKey(path, 'gapSec'), `"repeat.gapSec" must be ≥ 0, got ${fmt(line.gapSec)}`),
    );
  }
  // Auxiliary say-only keys on a repeat line → UNKNOWN_FIELD warning.
  flagUnknownFields(line, 'repeat', path, issues);

  if (Array.isArray(line.repeat)) {
    line.repeat.forEach((inner, ii) => {
      validateLine(inner, childKey(path, `repeat[${ii}]`), script, issues, depth + 1);
    });
  }
}

/** Flag say-only auxiliary keys attached to a non-say line as UNKNOWN_FIELD warnings. */
function flagUnknownFields(
  line: Record<string, unknown>,
  ownDiscriminator: 'pauseSec' | 'repeat',
  path: string,
  issues: CompileIssue[],
): void {
  const allowed = ownDiscriminator === 'repeat' ? new Set(['repeat', 'count', 'gapSec']) : new Set(['pauseSec']);
  for (const key of Object.keys(line)) {
    if (allowed.has(key)) continue;
    if (SAY_FIELDS.has(key)) {
      issues.push(warn('UNKNOWN_FIELD', path, `Unknown field "${key}" ignored at ${path}`));
    }
  }
}

// ===========================================================================
// Phase 2 — voice + effective-rate resolution (pure, no I/O)
// ===========================================================================

/** Voice id precedence: Line.voice → script.voices[lang] → DEFAULT_VOICES[lang]. */
function resolveVoiceId(
  line: Record<string, unknown>,
  lang: Lang,
  script: Record<string, unknown>,
): string | undefined {
  if (typeof line.voice === 'string' && line.voice !== '') return line.voice;
  const voices = isPlainObject(script.voices) ? script.voices : undefined;
  const mapped = voices ? voices[lang] : undefined;
  if (typeof mapped === 'string' && mapped !== '') return mapped;
  return DEFAULT_VOICES[lang];
}

/** Public, typed voice resolution (design §4). `lang` defaults to 'en'. */
export function resolveVoice(line: SayLine, lang: Lang, script: VoiceScript): string {
  const id = resolveVoiceId(
    line as unknown as Record<string, unknown>,
    lang,
    script as unknown as Record<string, unknown>,
  );
  // Validation guarantees a resolvable voice before this runs; the `??` is a defensive default.
  return id ?? DEFAULT_VOICES[lang];
}

/** Effective rate = (Line.rateScale ?? 1) * (script.rateScale ?? 1), multiplicative (design §4). */
export function effectiveRate(line: SayLine, script: VoiceScript): number {
  return (line.rateScale ?? 1) * (script.rateScale ?? 1);
}

// ===========================================================================
// Phase 3 — flatten (expand inline repeat / block repeat / script loop)
// ===========================================================================

/** An atomic placement on the linear timeline (after all repetition is resolved). */
interface Placement {
  kind: 'say' | 'pause';
  // say fields:
  text?: string;
  lang?: Lang;
  voice?: string;
  rate?: number; // composed effective rate
  /** trailing gap after a say placement (gap precedence already resolved). */
  trailingGap?: number;
  /** the absolute `at:` anchor, honored on first occurrence only (AT_INSIDE_REPEAT otherwise). */
  at?: number;
  /** true when this placement is inside any repeat/loop expansion (suppresses `at:` after first). */
  insideRepeat?: boolean;
  // pause fields:
  pauseSec?: number;
  // identity for the emitted layer (positional, stable):
  blockIdx?: number;
  lineIdx?: number;
  iteration?: number; // occurrence index within layers (incremented per emitted say cue id)
}

/** Thrown internally by flatten to abort with a typed error issue. */
class FlattenAbort {
  constructor(readonly issue: CompileIssue) {}
}

/**
 * Expand the validated script into one linear placement list. Pure & deterministic.
 * Expansion order is innermost-first: inline `repeat` → block `repeat` → script `loop` (design §6).
 * Aborts (throws FlattenAbort) with SCRIPT_TOO_LARGE when the running count exceeds MAX_PLACEMENTS.
 */
export function flatten(script: VoiceScript): Placement[] {
  const out: Placement[] = [];
  const counter = { n: 0 };

  const pushPlacement = (p: Placement): void => {
    counter.n += 1;
    if (counter.n > MAX_PLACEMENTS) {
      throw new FlattenAbort(
        err(
          'SCRIPT_TOO_LARGE',
          '',
          `Compiled placement count ${counter.n} exceeds the maximum of ${MAX_PLACEMENTS}`,
        ),
      );
    }
    out.push(p);
  };

  // One whole pass over all blocks → an ordered placement list (block repeats expanded).
  const expandBody = (insideOuterRepeat: boolean): void => {
    script.blocks.forEach((block, bi) => {
      const blockRepeatCount = block.repeat?.count ?? 1;
      const blockRepeatGap = block.repeat?.gapSec ?? 0;
      const blockRepeated = blockRepeatCount > 1;
      for (let iter = 0; iter < blockRepeatCount; iter++) {
        expandBlockLines(block, bi, insideOuterRepeat || blockRepeated);
        // gap BETWEEN block iterations, not after the last.
        if (iter < blockRepeatCount - 1 && blockRepeatGap > 0) {
          pushPlacement({ kind: 'pause', pauseSec: blockRepeatGap });
        }
      }
    });
  };

  // `insideRepeat` = inside ANY repeat/loop (drives `at:` first-occurrence-only, §7/§8).
  // `insideInline` = inside an INLINE repeat specifically (suppresses block pacing, §6/§5.3:
  // block pacing governs the block's own top-level lines, NOT a repeat's internal sequence).
  const expandBlockLines = (block: Block, bi: number, insideRepeat: boolean): void => {
    block.lines.forEach((line, li) => {
      const isLastLine = li === block.lines.length - 1;
      expandLine(line, bi, li, block, isLastLine, insideRepeat, false);
    });
  };

  const expandLine = (
    line: Line,
    bi: number,
    li: number,
    block: Block,
    isLastLineOfBlock: boolean,
    insideRepeat: boolean,
    insideInline: boolean,
  ): void => {
    if ('say' in line) {
      const lang: Lang = line.lang ?? 'en';
      const trailingGap = insideInline
        ? line.gapAfterSec ?? 0
        : line.gapAfterSec ?? (isLastLineOfBlock ? 0 : block.pacing?.gapSec ?? 0);
      pushPlacement({
        kind: 'say',
        text: line.say,
        lang,
        voice: resolveVoice(line, lang, script),
        rate: effectiveRate(line, script),
        trailingGap,
        at: line.at,
        insideRepeat,
        blockIdx: bi,
        lineIdx: li,
      });
    } else if ('pauseSec' in line) {
      pushPlacement({ kind: 'pause', pauseSec: line.pauseSec });
    } else {
      // inline repeat: expand the inner sub-sequence `count` times, gapSec between iterations.
      const innerGap = line.gapSec ?? 0;
      for (let iter = 0; iter < line.count; iter++) {
        line.repeat.forEach((inner, ii) => {
          const innerLast = ii === line.repeat.length - 1;
          expandLine(inner, bi, li, block, isLastLineOfBlock && innerLast, true, true);
        });
        if (iter < line.count - 1 && innerGap > 0) {
          pushPlacement({ kind: 'pause', pauseSec: innerGap });
        }
      }
    }
  };

  // Script loop: bound the number of whole-body passes (design §6).
  const loop = script.loop;
  const loopGap = loop?.gapSec ?? 0;
  const hasCount = isFiniteNumber(loop?.count);
  const hasUntil = isFiniteNumber(loop?.untilSec);
  const maxPasses = hasCount ? (loop!.count as number) : Number.POSITIVE_INFINITY;
  const untilSec = hasUntil ? (loop!.untilSec as number) : Number.POSITIVE_INFINITY;

  // We expand passes one at a time, measuring nothing here (layout uses real durations later),
  // so `untilSec` is enforced in layout by COUNT here using a conservative bound: when neither
  // bound is set → single pass; with count → exactly count; with untilSec → we cannot know the
  // real duration at flatten time, so we expand a single pass and let layout replay it untilSec.
  // To keep flatten pure of clip durations yet honor untilSec deterministically, untilSec-only and
  // untilSec+count loops are expanded during LAYOUT (which has the real durations). Flatten emits
  // ONE body pass tagged as the loop template when an untilSec bound exists; otherwise it fully
  // expands `count` passes here.
  const looped = (hasCount && maxPasses > 1) || hasUntil;

  if (hasUntil) {
    // Defer loop expansion to layout (needs real durations). Emit a single body pass; mark all
    // placements as insideRepeat so `at:` degrades after the first body. The loop metadata is
    // attached to the returned list via a non-enumerable carrier.
    expandBody(true);
    (out as PlacementListWithLoop).loop = {
      untilSec,
      maxPasses,
      gapSec: loopGap,
    };
  } else {
    const passes = hasCount ? maxPasses : 1;
    for (let p = 0; p < passes; p++) {
      expandBody(looped);
      if (p < passes - 1 && loopGap > 0) {
        pushPlacement({ kind: 'pause', pauseSec: loopGap });
      }
    }
  }

  return out;
}

interface LoopMeta {
  untilSec: number;
  maxPasses: number;
  gapSec: number;
}
type PlacementListWithLoop = Placement[] & { loop?: LoopMeta };

// ===========================================================================
// Phase 5 — layout walk + emit (uses MEASURED durations)
// ===========================================================================

interface LayoutOutput {
  layers: Layer[];
  totalSec: number;
  warnings: CompileIssue[];
}

/**
 * Single left-to-right cursor walk over the flattened placements. `durations` maps a
 * say-placement clip key (text|voice|lang|rate) → measured durationSec. Emits one voice Layer
 * per say placement at its absolute `t`, each carrying `Layer.duck` (when `script.duck` is set),
 * the final cursor as `totalSec`, and any warning-severity diagnostics. No `console.*`.
 */
export function layout(
  placements: Placement[],
  durations: Map<string, number>,
  script: VoiceScript,
  durationSec?: number,
): LayoutOutput {
  const layers: Layer[] = [];
  const warnings: CompileIssue[] = [];
  const duck = script.duck ?? undefined; // null/absent → omit Layer.duck
  const startAt = script.startAtSec ?? 0;

  // unique-within-layers id counter per (block,line) position so repeats get _0, _1, …
  const iterByPos = new Map<string, number>();
  // track which (block,line) positions have already consumed their `at:` anchor (first-only).
  const anchoredPos = new Set<string>();

  const loopMeta = (placements as PlacementListWithLoop).loop;

  const runBodyOnce = (cursorStart: number): { cursor: number; emitted: number } => {
    let cursor = cursorStart;
    let emitted = 0;
    for (const p of placements) {
      if (p.kind === 'pause') {
        cursor += p.pauseSec ?? 0;
        continue;
      }
      // say
      const key = clipKey(p.text!, p.voice!, p.lang!, p.rate!);
      const dur = durations.get(key) ?? 0;
      const posKey = `${p.blockIdx}_${p.lineIdx}`;
      const iteration = iterByPos.get(posKey) ?? 0;
      iterByPos.set(posKey, iteration + 1);

      let t = cursor;
      if (p.at !== undefined) {
        const firstOccurrence = !anchoredPos.has(posKey);
        if (p.insideRepeat && !firstOccurrence) {
          // later occurrence inside a repeat/loop: flow (cursor-relative). Warning emitted once.
        } else {
          if (p.insideRepeat && firstOccurrence) {
            warnings.push(
              warn(
                'AT_INSIDE_REPEAT',
                positionalPath(p),
                `"at" anchor inside a repeat/loop is applied to the first occurrence only; later occurrences flow`,
              ),
            );
          }
          anchoredPos.add(posKey);
          if (p.at > cursor) {
            t = p.at; // positive slack → pad silence to the anchor
          } else if (p.at < cursor) {
            // negative slack: place at current cursor, warn with overrun.
            const overrun = round(cursor - p.at);
            warnings.push(
              warn(
                'AT_NEGATIVE_SLACK',
                positionalPath(p),
                `Line cannot start at ${trimNum(p.at)}s (earliest is ${trimNum(cursor)}s, overrun ${trimNum(overrun)}s); placed at ${trimNum(cursor)}s`,
              ),
            );
            t = cursor;
          } else {
            t = p.at; // equal → no padding, no warning
          }
        }
      }

      const layer: Layer = {
        id: `vs_${p.blockIdx}_${p.lineIdx}_${iteration}`,
        kind: 'voice',
        source: { clipId: clipIdFor(p, durations) },
        t: round(t),
      };
      if (duck) layer.duck = duck;
      layers.push(layer);
      emitted += 1;

      cursor = t + dur + (p.trailingGap ?? 0);
    }
    return { cursor, emitted };
  };

  let cursor = startAt;
  if (loopMeta) {
    // untilSec (and optional count) loop: replay the body until the cursor would reach untilSec
    // or maxPasses is hit, whichever triggers first. Whole iterations only (last may overrun).
    let passes = 0;
    while (passes < loopMeta.maxPasses) {
      // an iteration is emitted only if it can start strictly before untilSec.
      if (passes > 0 && !(cursor < loopMeta.untilSec)) break;
      const before = cursor;
      const { cursor: after } = runBodyOnce(cursor);
      cursor = after;
      passes += 1;
      // guard against a zero-length body never advancing under an untilSec bound.
      if (cursor === before) break;
      // hard cap so a tiny-duration body under a huge untilSec can never explode memory.
      if (layers.length > MAX_PLACEMENTS) break;
      if (passes < loopMeta.maxPasses && cursor < loopMeta.untilSec && loopMeta.gapSec > 0) {
        cursor += loopMeta.gapSec;
      }
    }
  } else {
    const { cursor: after } = runBodyOnce(cursor);
    cursor = after;
  }

  const totalSec = round(cursor);
  if (durationSec !== undefined && totalSec > durationSec) {
    warnings.push(
      warn(
        'TOTAL_EXCEEDS_DURATION',
        '',
        `Narration ends at ${trimNum(totalSec)}s, beyond the preset duration of ${trimNum(durationSec)}s`,
      ),
    );
  }

  return { layers, totalSec, warnings };
}

function positionalPath(p: Placement): string {
  return `blocks[${p.blockIdx}].lines[${p.lineIdx}]`;
}

function clipKey(text: string, voice: string, lang: Lang, rate: number): string {
  return JSON.stringify([text, voice, lang, rate]);
}

// During layout we have the synthesized clip ids keyed the same way as durations; the caller
// supplies a parallel id map by reusing the durations map's key space. To keep layout independent
// of the id map, the orchestrator stitches clip ids onto placements before layout. We store the id
// on the placement (set in compile) and fall back to '' (never reached on the success path).
function clipIdFor(p: Placement, _durations: Map<string, number>): string {
  return (p as Placement & { clipId?: string }).clipId ?? '';
}

/** Round to a stable precision so floating-point accumulation is deterministic across runs. */
function round(n: number): number {
  return Math.round(n * 1e9) / 1e9;
}

/** Format a number for a message: drop trailing zeros from the rounded value. */
function trimNum(n: number): number {
  return round(n);
}

// ===========================================================================
// Public entry points — orchestrate the five phases
// ===========================================================================

/**
 * Compile a VoiceScript into voice layers + deduped clips. Resolves to a `CompileResult`:
 * `{ ok:true, compiled, issues:warnings }` on success, `{ ok:false, issues }` on any
 * error-severity issue. Never throws for invalid input; a dependency rejection is caught and
 * surfaced as a `SYNTH_FAILED` error (no partial artifacts, no uncaught rejection).
 */
export async function compileVoiceScript(
  script: VoiceScript,
  deps: CompileDeps,
): Promise<CompileResult> {
  // (1) validate — on ANY error, fail fast & cheap: no flatten, no tts, no importVia.
  const validationIssues = validate(script as unknown);
  const errors = validationIssues.filter((i) => i.severity === 'error');
  if (errors.length > 0) {
    return { ok: false, issues: validationIssues };
  }
  const warningsFromValidate = validationIssues.filter((i) => i.severity === 'warning');

  // (2)+(3) flatten (resolution happens inside flatten via the pure helpers).
  let placements: Placement[];
  try {
    placements = flatten(script);
  } catch (e) {
    if (e instanceof FlattenAbort) {
      return { ok: false, issues: [...warningsFromValidate, e.issue] };
    }
    throw e;
  }

  // (4) synthesize SEQUENTIALLY — one importVia per distinct clip key; reuse across occurrences.
  const durations = new Map<string, number>();
  const clipIdByKey = new Map<string, string>();
  const clipsById = new Map<string, Clip>();

  for (const p of placements) {
    if (p.kind !== 'say') continue;
    const key = clipKey(p.text!, p.voice!, p.lang!, p.rate!);
    if (!clipIdByKey.has(key)) {
      const input: TtsInput = {
        text: p.text!,
        voice: p.voice,
        language: p.lang,
        rateScale: p.rate,
      };
      let clip: Clip;
      try {
        clip = await deps.clipLib.importVia(deps.tts, input);
      } catch (cause) {
        return {
          ok: false,
          issues: [synthFailedIssue(p, cause)],
        };
      }
      clipIdByKey.set(key, clip.id);
      durations.set(key, clip.durationSec);
      if (!clipsById.has(clip.id)) clipsById.set(clip.id, clip);
    }
    // stitch the resolved clip id onto the placement for layout.
    (p as Placement & { clipId?: string }).clipId = clipIdByKey.get(key);
  }

  // (5) layout + emit.
  const { layers, totalSec, warnings: layoutWarnings } = layout(
    placements,
    durations,
    script,
    deps.durationSec,
  );

  const clips = Array.from(clipsById.values());
  const issues = [...warningsFromValidate, ...layoutWarnings];

  return { ok: true, compiled: { layers, clips, totalSec }, issues };
}

function synthFailedIssue(p: Placement, cause: unknown): CompileIssue {
  const textPreview = (p.text ?? '').slice(0, 40);
  const adapterMessage =
    cause instanceof Error
      ? cause.message
      : typeof cause === 'string'
        ? cause
        : String((cause as { message?: unknown })?.message ?? cause);
  return err(
    'SYNTH_FAILED',
    positionalPath(p),
    `Speech synthesis failed for "${textPreview}" (${p.lang}): ${adapterMessage}`,
  );
}

/**
 * Compile, or throw `VoiceScriptError(issues)` on any error-severity issue. Warnings are dropped.
 * Returns the bare arch-§6 success shape `{ layers, clips }`.
 */
export async function compileVoiceScriptOrThrow(
  script: VoiceScript,
  deps: CompileDeps,
): Promise<{ layers: Layer[]; clips: Clip[] }> {
  const result = await compileVoiceScript(script, deps);
  if (!result.ok) {
    throw new VoiceScriptError('VoiceScript compilation failed', result.issues);
  }
  return { layers: result.compiled.layers, clips: result.compiled.clips };
}
