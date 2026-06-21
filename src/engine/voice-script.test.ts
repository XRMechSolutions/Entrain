// voice-script — deterministic compiler tests (happy + error + edge).
//
// Covers (tasks.md voice-script): constants + types + VoiceScriptError; validate (every error
// code, collect-all, no-mutation, discriminator rule, whitespace/zero edges); voice + rate
// resolution; flatten (inline/block/loop expansion + caps); layout (deterministic t, gap
// precedence, startAtSec, at: anchors + slack, total>duration); and the public entry points
// (synth-once-reuse, dedup, duck carriage, malformed-line short-circuit, SYNTH_FAILED, orThrow).
//
// A FAKE tts adapter + FAKE clipLib are injected (no tts-local import). The clipLib hashes the
// TtsInput deterministically: identical text+voice+language+rateScale → same clip id (dedup),
// durationSec is a fixed-per-text table so layout `t` values are exact and assertable.

import { describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_VOICES,
  MAX_PLACEMENTS,
  MAX_REPEAT_DEPTH,
  VoiceScriptError,
  compileVoiceScript,
  compileVoiceScriptOrThrow,
  effectiveRate,
  flatten,
  layout,
  resolveVoice,
  validate,
  type CompileCode,
  type CompileIssue,
  type Line,
  type SayLine,
  type TtsInput,
  type VoiceScript,
} from './voice-script';
import type { Clip, ClipSourceAdapter } from './clip-library';

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

/** A fake tts adapter satisfying ClipSourceAdapter<TtsInput>; produce() is never called directly
 *  (the clipLib double owns clip creation), but the shape must type-check. */
const fakeTts: ClipSourceAdapter<TtsInput> = {
  source: 'tts' as ClipSourceAdapter<TtsInput>['source'],
  produce: async () => {
    throw new Error('fakeTts.produce should not be called; the fake clipLib owns synthesis');
  },
};

/** Per-text measured durations so layout `t` is exact. Defaults to 1.0s for unknown text. */
const DURATIONS: Record<string, number> = {
  'la manzana': 0.75,
  'the apple': 0.65,
  hi: 0.5,
  one: 1,
  two: 2,
  alpha: 0.4,
  beta: 0.6,
};

function durationOf(text: string): number {
  return DURATIONS[text] ?? 1;
}

/** Build a Clip double. The id is content-derived from text+voice+language+rateScale so two
 *  identical TtsInputs dedup to one clip, and a rate difference yields a distinct clip. */
function makeClip(input: TtsInput): Clip {
  const key = `${input.text}|${input.voice}|${input.language}|${input.rateScale}`;
  const id = `clip_${hashKey(key)}`;
  return {
    id,
    hash: hashKey(key).padEnd(64, '0'),
    format: 'audio/wav',
    durationSec: durationOf(input.text),
    source: 'tts' as Clip['source'],
    meta: { name: input.text, language: input.language, voice: input.voice, text: input.text },
    bytes: 1024,
    createdAt: 0,
    lastUsedAt: 0,
  };
}

function hashKey(s: string): string {
  // tiny deterministic non-crypto hash → hex (enough for unique ids in tests).
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return ('00000000' + h.toString(16)).slice(-8);
}

interface FakeClipLib {
  importVia<T>(adapter: ClipSourceAdapter<T>, input: T): Promise<Clip>;
  calls: TtsInput[];
}

/** A fake clipLib whose importVia records calls and returns content-deduped clips. */
function fakeClipLib(): FakeClipLib {
  const calls: TtsInput[] = [];
  return {
    calls,
    async importVia<T>(_adapter: ClipSourceAdapter<T>, input: T): Promise<Clip> {
      const ttsInput = input as unknown as TtsInput;
      calls.push(ttsInput);
      return makeClip(ttsInput);
    },
  };
}

/** A clipLib double that rejects on the Nth importVia call (1-based). */
function failingClipLib(failOnCall: number, error: unknown): FakeClipLib {
  const calls: TtsInput[] = [];
  return {
    calls,
    async importVia<T>(_adapter: ClipSourceAdapter<T>, input: T): Promise<Clip> {
      const ttsInput = input as unknown as TtsInput;
      calls.push(ttsInput);
      if (calls.length === failOnCall) throw error;
      return makeClip(ttsInput);
    },
  };
}

// ---------------------------------------------------------------------------
// Script builders
// ---------------------------------------------------------------------------

function validScript(overrides: Partial<VoiceScript> = {}): VoiceScript {
  return {
    version: 1,
    purpose: 'general',
    blocks: [{ lines: [{ say: 'hi' }] }],
    ...overrides,
  };
}

function codes(issues: CompileIssue[]): CompileCode[] {
  return issues.map((i) => i.code);
}

async function compileOk(script: VoiceScript, deps?: Partial<{ durationSec: number; clipLib: FakeClipLib }>) {
  const clipLib = deps?.clipLib ?? fakeClipLib();
  const result = await compileVoiceScript(script, {
    tts: fakeTts,
    clipLib,
    durationSec: deps?.durationSec,
  });
  if (!result.ok) {
    throw new Error(`expected ok, got issues: ${JSON.stringify(result.issues)}`);
  }
  return { result, clipLib };
}

// ===========================================================================
// Constants + types + error class
// ===========================================================================

describe('constants and error class', () => {
  it('should expose exactly the four Lang keys in DEFAULT_VOICES, each a non-empty string', () => {
    expect(Object.keys(DEFAULT_VOICES).sort()).toEqual(['en', 'es', 'fr', 'ja']);
    for (const id of Object.values(DEFAULT_VOICES)) {
      expect(typeof id).toBe('string');
      expect(id.length).toBeGreaterThan(0);
    }
  });

  it('should pin MAX_REPEAT_DEPTH=8 and MAX_PLACEMENTS=100000', () => {
    expect(MAX_REPEAT_DEPTH).toBe(8);
    expect(MAX_PLACEMENTS).toBe(100_000);
  });

  it('should set VoiceScriptError name and carry the passed issues', () => {
    const issues: CompileIssue[] = [
      { code: 'NOT_OBJECT', severity: 'error', path: '', message: 'x' },
    ];
    const e = new VoiceScriptError('failed', issues);
    expect(e).toBeInstanceOf(VoiceScriptError);
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe('VoiceScriptError');
    expect(e.issues).toBe(issues);
  });
});

// ===========================================================================
// validate
// ===========================================================================

describe('validate', () => {
  it('should return zero error-severity issues for a valid script', () => {
    const issues = validate(validScript({ duck: { toGain: 0.25, attackSec: 0.3, releaseSec: 0.8 } }));
    expect(issues.filter((i) => i.severity === 'error')).toEqual([]);
  });

  it('should never mutate the input object', () => {
    const script = validScript({ rateScale: 0.9, voices: { en: 'af_heart' } });
    const snapshot = JSON.parse(JSON.stringify(script));
    validate(script);
    expect(script).toEqual(snapshot);
  });

  it('should collect ALL independent errors, not fail-fast', () => {
    const bad = {
      version: 2, // VERSION_INVALID
      purpose: 'sleep', // PURPOSE_INVALID
      blocks: [], // BLOCKS_EMPTY
    };
    const c = codes(validate(bad));
    expect(c).toContain('VERSION_INVALID');
    expect(c).toContain('PURPOSE_INVALID');
    expect(c).toContain('BLOCKS_EMPTY');
  });

  it('should report NOT_OBJECT for a non-object root with the typeof in the message', () => {
    const issues = validate(42);
    expect(issues).toEqual([
      { code: 'NOT_OBJECT', severity: 'error', path: '', message: 'A VoiceScript must be an object, got number' },
    ]);
  });

  const table: Array<{ name: string; script: unknown; code: CompileCode; path?: string }> = [
    { name: 'version !== 1', script: { version: 2, purpose: 'general', blocks: [{ lines: [{ say: 'hi' }] }] }, code: 'VERSION_INVALID' },
    { name: 'bad purpose', script: { version: 1, purpose: 'nope', blocks: [{ lines: [{ say: 'hi' }] }] }, code: 'PURPOSE_INVALID' },
    { name: 'startAtSec NaN', script: validScript({ startAtSec: NaN }), code: 'START_AT_NOT_FINITE' },
    { name: 'startAtSec negative', script: validScript({ startAtSec: -1 }), code: 'START_AT_NEGATIVE' },
    { name: 'rateScale Infinity', script: validScript({ rateScale: Infinity }), code: 'RATE_SCALE_NOT_FINITE' },
    { name: 'rateScale 0', script: validScript({ rateScale: 0 }), code: 'RATE_SCALE_NOT_POSITIVE' },
    { name: 'voices not object', script: { version: 1, purpose: 'general', voices: 5, blocks: [{ lines: [{ say: 'hi' }] }] }, code: 'VOICES_NOT_OBJECT' },
    { name: 'voice id not string', script: { version: 1, purpose: 'general', voices: { en: 7 }, blocks: [{ lines: [{ say: 'hi' }] }] }, code: 'VOICE_ID_NOT_STRING' },
    { name: 'duck not object/null', script: validScript({ duck: 5 as unknown as null }), code: 'DUCK_NOT_OBJECT_OR_NULL' },
    { name: 'duck field not finite', script: validScript({ duck: { toGain: NaN, attackSec: 0, releaseSec: 0 } }), code: 'DUCK_FIELD_NOT_FINITE' },
    { name: 'duck toGain out of range', script: validScript({ duck: { toGain: 2, attackSec: 0, releaseSec: 0 } }), code: 'DUCK_TO_GAIN_OUT_OF_RANGE' },
    { name: 'duck attack negative', script: validScript({ duck: { toGain: 0.5, attackSec: -1, releaseSec: 0 } }), code: 'DUCK_ATTACK_NEGATIVE' },
    { name: 'duck release negative', script: validScript({ duck: { toGain: 0.5, attackSec: 0, releaseSec: -1 } }), code: 'DUCK_RELEASE_NEGATIVE' },
    { name: 'loop not object', script: validScript({ loop: 5 as unknown as undefined }), code: 'LOOP_NOT_OBJECT' },
    { name: 'loop count not integer', script: validScript({ loop: { count: 1.5 } }), code: 'LOOP_COUNT_NOT_INTEGER' },
    { name: 'loop count too small', script: validScript({ loop: { count: 0 } }), code: 'LOOP_COUNT_TOO_SMALL' },
    { name: 'loop until not finite', script: validScript({ loop: { untilSec: Infinity } }), code: 'LOOP_UNTIL_NOT_FINITE' },
    { name: 'loop until negative', script: validScript({ loop: { untilSec: -3 } }), code: 'LOOP_UNTIL_NEGATIVE' },
    { name: 'loop gap negative', script: validScript({ loop: { count: 2, gapSec: -1 } }), code: 'LOOP_GAP_NEGATIVE' },
    { name: 'blocks not array', script: { version: 1, purpose: 'general', blocks: 'x' }, code: 'BLOCKS_NOT_ARRAY' },
    { name: 'blocks empty', script: { version: 1, purpose: 'general', blocks: [] }, code: 'BLOCKS_EMPTY' },
    { name: 'block not object', script: { version: 1, purpose: 'general', blocks: [5] }, code: 'BLOCK_NOT_OBJECT' },
    { name: 'block empty lines', script: { version: 1, purpose: 'general', blocks: [{ lines: [] }] }, code: 'BLOCK_EMPTY' },
    { name: 'block pacing gap invalid', script: { version: 1, purpose: 'general', blocks: [{ pacing: { gapSec: -1 }, lines: [{ say: 'hi' }] }] }, code: 'BLOCK_PACING_GAP_INVALID' },
    { name: 'block repeat count not int', script: { version: 1, purpose: 'general', blocks: [{ repeat: { count: 1.2 }, lines: [{ say: 'hi' }] }] }, code: 'BLOCK_REPEAT_COUNT_NOT_INTEGER' },
    { name: 'block repeat count too small', script: { version: 1, purpose: 'general', blocks: [{ repeat: { count: 0 }, lines: [{ say: 'hi' }] }] }, code: 'BLOCK_REPEAT_COUNT_TOO_SMALL' },
    { name: 'block repeat gap negative', script: { version: 1, purpose: 'general', blocks: [{ repeat: { count: 2, gapSec: -1 }, lines: [{ say: 'hi' }] }] }, code: 'BLOCK_REPEAT_GAP_NEGATIVE' },
    { name: 'line not object', script: { version: 1, purpose: 'general', blocks: [{ lines: ['x'] }] }, code: 'LINE_NOT_OBJECT' },
    { name: 'say rate scale invalid', script: { version: 1, purpose: 'general', blocks: [{ lines: [{ say: 'hi', rateScale: 0 }] }] }, code: 'SAY_RATE_SCALE_INVALID' },
    { name: 'say gap after negative', script: { version: 1, purpose: 'general', blocks: [{ lines: [{ say: 'hi', gapAfterSec: -1 }] }] }, code: 'SAY_GAP_AFTER_NEGATIVE' },
    { name: 'say at negative', script: { version: 1, purpose: 'general', blocks: [{ lines: [{ say: 'hi', at: -2 }] }] }, code: 'SAY_AT_NEGATIVE' },
    { name: 'pause not finite', script: { version: 1, purpose: 'general', blocks: [{ lines: [{ pauseSec: NaN }] }] }, code: 'PAUSE_NOT_FINITE' },
    { name: 'repeat empty', script: { version: 1, purpose: 'general', blocks: [{ lines: [{ repeat: [], count: 2 }] }] }, code: 'REPEAT_EMPTY' },
    { name: 'repeat count not int', script: { version: 1, purpose: 'general', blocks: [{ lines: [{ repeat: [{ say: 'hi' }], count: 1.5 }] }] }, code: 'REPEAT_COUNT_NOT_INTEGER' },
    { name: 'repeat count too small', script: { version: 1, purpose: 'general', blocks: [{ lines: [{ repeat: [{ say: 'hi' }], count: 0 }] }] }, code: 'REPEAT_COUNT_TOO_SMALL' },
    { name: 'repeat gap negative', script: { version: 1, purpose: 'general', blocks: [{ lines: [{ repeat: [{ say: 'hi' }], count: 2, gapSec: -1 }] }] }, code: 'REPEAT_GAP_NEGATIVE' },
  ];

  for (const { name, script, code } of table) {
    it(`should flag ${name} → ${code}`, () => {
      expect(codes(validate(script)).filter((c) => c === code)).toEqual([code]);
    });
  }

  it('should flag LINE_NO_DISCRIMINATOR for a line with zero discriminator keys', () => {
    const issues = validate({ version: 1, purpose: 'general', blocks: [{ lines: [{ lang: 'en' }] }] });
    const found = issues.find((i) => i.code === 'LINE_NO_DISCRIMINATOR')!;
    expect(found.message).toBe('A line must have exactly one of "say", "pauseSec", "repeat"; found 0');
    expect(found.path).toBe('blocks[0].lines[0]');
  });

  it('should flag LINE_MULTI_DISCRIMINATOR with the found count for two discriminators', () => {
    const issues = validate({ version: 1, purpose: 'general', blocks: [{ lines: [{ say: 'hi', pauseSec: 2 }] }] });
    const found = issues.find((i) => i.code === 'LINE_MULTI_DISCRIMINATOR')!;
    expect(found.message).toBe('A line must have exactly one of "say", "pauseSec", "repeat"; found 2');
  });

  it('should flag a whitespace-only say as SAY_EMPTY', () => {
    const issues = validate({ version: 1, purpose: 'general', blocks: [{ lines: [{ say: '   ' }] }] });
    expect(codes(issues)).toContain('SAY_EMPTY');
  });

  it('should reject pauseSec:0 (PAUSE_NOT_POSITIVE) but accept pacing.gapSec:0', () => {
    const pause = validate({ version: 1, purpose: 'general', blocks: [{ lines: [{ pauseSec: 0 }] }] });
    expect(codes(pause)).toContain('PAUSE_NOT_POSITIVE');

    const gapZero = validate({ version: 1, purpose: 'general', blocks: [{ pacing: { gapSec: 0 }, lines: [{ say: 'hi' }] }] });
    expect(gapZero.filter((i) => i.severity === 'error')).toEqual([]);
  });

  it('should flag an unsupported lang as UNKNOWN_LANG', () => {
    const issues = validate({ version: 1, purpose: 'general', blocks: [{ lines: [{ say: 'hallo', lang: 'de' }] }] });
    const found = issues.find((i) => i.code === 'UNKNOWN_LANG')!;
    expect(found.message).toBe('Unsupported language "de" (supported: en, es, fr, ja) or no voice resolvable');
  });

  it('should flag REPEAT_TOO_DEEP beyond MAX_REPEAT_DEPTH', () => {
    // build inline repeats nested MAX_REPEAT_DEPTH+1 deep
    let line: Line = { say: 'hi' };
    for (let d = 0; d <= MAX_REPEAT_DEPTH; d++) {
      line = { repeat: [line], count: 1 } as Line;
    }
    const issues = validate({ version: 1, purpose: 'general', blocks: [{ lines: [line] }] });
    expect(codes(issues)).toContain('REPEAT_TOO_DEEP');
  });

  it('should warn UNKNOWN_FIELD for a say-only key on a pause line', () => {
    const issues = validate({ version: 1, purpose: 'general', blocks: [{ lines: [{ pauseSec: 2, voice: 'af_heart' }] }] });
    const found = issues.find((i) => i.code === 'UNKNOWN_FIELD');
    expect(found?.severity).toBe('warning');
  });
});

// ===========================================================================
// resolveVoice + effectiveRate
// ===========================================================================

describe('voice and rate resolution', () => {
  const script = validScript({ voices: { en: 'mapped_en' }, rateScale: 0.9 });

  it('should prefer Line.voice over script.voices over DEFAULT_VOICES', () => {
    expect(resolveVoice({ say: 'x', voice: 'line_voice' } as SayLine, 'en', script)).toBe('line_voice');
    expect(resolveVoice({ say: 'x' } as SayLine, 'en', script)).toBe('mapped_en');
    expect(resolveVoice({ say: 'x' } as SayLine, 'es', script)).toBe(DEFAULT_VOICES.es);
  });

  it('should compose effective rate multiplicatively (0.9 × 1.1 = 0.99; defaults → 1)', () => {
    expect(effectiveRate({ say: 'x', rateScale: 1.1 } as SayLine, script)).toBeCloseTo(0.99, 10);
    expect(effectiveRate({ say: 'x' } as SayLine, validScript())).toBe(1);
  });

  it('should be referentially transparent', () => {
    const a = resolveVoice({ say: 'x' } as SayLine, 'en', script);
    const b = resolveVoice({ say: 'x' } as SayLine, 'en', script);
    expect(a).toBe(b);
  });
});

// ===========================================================================
// flatten
// ===========================================================================

describe('flatten', () => {
  function sayCount(script: VoiceScript): number {
    return flatten(script).filter((p) => p.kind === 'say').length;
  }

  it('should expand inline repeat count 2 into inner lines twice', () => {
    const script = validScript({
      blocks: [{ lines: [{ repeat: [{ say: 'one' }, { say: 'two' }], count: 2, gapSec: 0.5 }] }],
    });
    const flat = flatten(script);
    // 2 iterations × 2 says = 4 says, plus 1 between-iteration pause (not after last)
    expect(flat.filter((p) => p.kind === 'say').length).toBe(4);
    expect(flat.filter((p) => p.kind === 'pause').length).toBe(1);
  });

  it('should expand block repeat count 3 into block lines ×3', () => {
    const script = validScript({ blocks: [{ repeat: { count: 3 }, lines: [{ say: 'one' }, { say: 'two' }] }] });
    expect(sayCount(script)).toBe(6);
  });

  it('should treat loop.count:1 as a single pass', () => {
    const script = validScript({ blocks: [{ lines: [{ say: 'one' }] }], loop: { count: 1 } });
    expect(sayCount(script)).toBe(1);
  });

  it('should treat loop:{} (no bound) as exactly one pass', () => {
    const script = validScript({ blocks: [{ lines: [{ say: 'one' }] }], loop: {} });
    expect(sayCount(script)).toBe(1);
  });

  it('should expand loop.count:3 into body ×3', () => {
    const script = validScript({ blocks: [{ lines: [{ say: 'one' }] }], loop: { count: 3 } });
    expect(sayCount(script)).toBe(3);
  });

  it('should compose nesting (inline inside block inside loop) to the expected linear count', () => {
    const script = validScript({
      blocks: [{ repeat: { count: 2 }, lines: [{ repeat: [{ say: 'one' }], count: 3 }] }],
      loop: { count: 2 },
    });
    // loop 2 × block 2 × inline 3 = 12 says
    expect(sayCount(script)).toBe(12);
  });

  it('should abort with SCRIPT_TOO_LARGE past MAX_PLACEMENTS', () => {
    const script = validScript({
      blocks: [{ repeat: { count: 1000 }, lines: [{ repeat: [{ say: 'one' }], count: 1000 }] }],
    });
    expect(() => flatten(script)).toThrow();
  });

  it('should be deterministic across two calls', () => {
    const script = validScript({ blocks: [{ lines: [{ say: 'one' }, { say: 'two' }] }], loop: { count: 2 } });
    expect(flatten(script)).toEqual(flatten(script));
  });
});

// ===========================================================================
// layout (via compile, asserting exact t values)
// ===========================================================================

describe('layout via compile', () => {
  it('should produce exact deterministic t values and be byte-identical across runs', async () => {
    const script = validScript({
      voices: { es: 'ef_dora', en: 'af_heart' },
      duck: { toGain: 0.25, attackSec: 0.3, releaseSec: 0.8 },
      blocks: [
        {
          pacing: { gapSec: 1.2 },
          lines: [
            { say: 'la manzana', lang: 'es' },
            { say: 'the apple', lang: 'en', gapAfterSec: 2 },
            { repeat: [{ say: 'la manzana', lang: 'es' }], count: 2, gapSec: 0.5 },
            { pauseSec: 3 },
          ],
        },
      ],
    });
    const { result } = await compileOk(script, { durationSec: 600 });
    const ts = result.compiled.layers.map((l) => l.t);
    // matches the interfaces.md worked example: 0, 1.95, 4.6, 5.85
    expect(ts).toEqual([0, 1.95, 4.6, 5.85]);

    const { result: again } = await compileOk(script, { durationSec: 600 });
    expect(again.compiled.layers).toEqual(result.compiled.layers);
    expect(again.compiled.totalSec).toBe(result.compiled.totalSec);
  });

  it('should let gapAfterSec override block pacing and drop pacing after the last block line', async () => {
    const script = validScript({
      blocks: [
        {
          pacing: { gapSec: 1 },
          lines: [
            { say: 'one' }, // dur 1, +pacing 1 → next at 2
            { say: 'two', gapAfterSec: 5 }, // dur 2, +override 5 → next at 9
            { say: 'one' }, // last line: no trailing pacing gap
          ],
        },
      ],
    });
    const { result } = await compileOk(script);
    expect(result.compiled.layers.map((l) => l.t)).toEqual([0, 2, 9]);
    // total = 9 + dur(one)=1 + 0 (last line, no pacing) = 10
    expect(result.compiled.totalSec).toBe(10);
  });

  it('should SUM an explicit pause with surrounding pacing', async () => {
    const script = validScript({
      blocks: [
        {
          pacing: { gapSec: 1 },
          lines: [
            { say: 'one' }, // t=0, dur 1, +pacing 1 → cursor 2
            { pauseSec: 3 }, // cursor 5
            { say: 'two' }, // t=5
          ],
        },
      ],
    });
    const { result } = await compileOk(script);
    expect(result.compiled.layers.map((l) => l.t)).toEqual([0, 5]);
  });

  it('should offset every t additively by startAtSec', async () => {
    const script = validScript({
      startAtSec: 100,
      blocks: [{ pacing: { gapSec: 1 }, lines: [{ say: 'one' }, { say: 'two' }] }],
    });
    const { result } = await compileOk(script);
    expect(result.compiled.layers.map((l) => l.t)).toEqual([100, 102]);
  });

  it('should pad silence for positive-slack at: with no warning', async () => {
    const script = validScript({
      blocks: [{ lines: [{ say: 'one' }, { say: 'two', at: 10 }] }],
    });
    const { result } = await compileOk(script);
    expect(result.compiled.layers.map((l) => l.t)).toEqual([0, 10]);
    expect(result.issues.filter((i) => i.code === 'AT_NEGATIVE_SLACK')).toEqual([]);
  });

  it('should place negative-slack at: at the cursor with an AT_NEGATIVE_SLACK warning carrying exact values', async () => {
    const script = validScript({
      // 'one' dur 1, 'two' dur 2 → cursor 3 before the anchored line; at:1 is in the past
      blocks: [{ lines: [{ say: 'one' }, { say: 'two' }, { say: 'one', at: 1 }] }],
    });
    const { result } = await compileOk(script);
    const ts = result.compiled.layers.map((l) => l.t);
    expect(ts).toEqual([0, 1, 3]); // third placed at cursor 3, not moved back to 1
    const w = result.issues.find((i) => i.code === 'AT_NEGATIVE_SLACK')!;
    expect(w.severity).toBe('warning');
    expect(w.message).toBe('Line cannot start at 1s (earliest is 3s, overrun 2s); placed at 3s');
  });

  it('should place at: equal to cursor with no padding and no warning', async () => {
    const script = validScript({
      // 'one' dur 1 → cursor 1; anchor at:1 equals cursor
      blocks: [{ lines: [{ say: 'one' }, { say: 'two', at: 1 }] }],
    });
    const { result } = await compileOk(script);
    expect(result.compiled.layers.map((l) => l.t)).toEqual([0, 1]);
    expect(result.issues.filter((i) => i.code === 'AT_NEGATIVE_SLACK' || i.code === 'AT_INSIDE_REPEAT')).toEqual([]);
  });

  it('should pin at: on the first repeat occurrence only and warn AT_INSIDE_REPEAT', async () => {
    const script = validScript({
      blocks: [
        {
          lines: [
            { say: 'one' }, // t=0, dur 1 → cursor 1
            { repeat: [{ say: 'two', at: 5 }], count: 2, gapSec: 0.5 },
          ],
        },
      ],
    });
    const { result } = await compileOk(script);
    const ts = result.compiled.layers.map((l) => l.t);
    // first 'two' pinned at 5; second flows: 5 + dur(two)=2 + gap 0.5 = 7.5
    expect(ts).toEqual([0, 5, 7.5]);
    expect(result.issues.filter((i) => i.code === 'AT_INSIDE_REPEAT').length).toBe(1);
  });

  it('should warn TOTAL_EXCEEDS_DURATION but still return all layers', async () => {
    const script = validScript({ blocks: [{ lines: [{ say: 'two' }] }] }); // dur 2
    const { result } = await compileOk(script, { durationSec: 1 });
    expect(result.compiled.layers.length).toBe(1);
    const w = result.issues.find((i) => i.code === 'TOTAL_EXCEEDS_DURATION')!;
    expect(w.message).toBe('Narration ends at 2s, beyond the preset duration of 1s');
  });

  it('should skip the duration check when durationSec is absent', async () => {
    const script = validScript({ blocks: [{ lines: [{ say: 'two' }] }] });
    const { result } = await compileOk(script);
    expect(result.issues.filter((i) => i.code === 'TOTAL_EXCEEDS_DURATION')).toEqual([]);
  });

  it('should emit positional, stable ids across recompile', async () => {
    const script = validScript({ blocks: [{ lines: [{ repeat: [{ say: 'one' }], count: 2 }] }] });
    const { result: a } = await compileOk(script);
    const { result: b } = await compileOk(script);
    expect(a.compiled.layers.map((l) => l.id)).toEqual(['vs_0_0_0', 'vs_0_0_1']);
    expect(b.compiled.layers.map((l) => l.id)).toEqual(a.compiled.layers.map((l) => l.id));
  });

  it('should never call console during layout', () => {
    const spy = vi.spyOn(console, 'warn');
    const errSpy = vi.spyOn(console, 'error');
    const logSpy = vi.spyOn(console, 'log');
    const script = validScript({ blocks: [{ lines: [{ say: 'one' }, { say: 'two', at: 0.1 }] }] });
    const placements = flatten(script);
    // supply durations for layout directly
    const durations = new Map<string, number>([
      [JSON.stringify(['one', 'af_heart', 'en', 1]), 1],
      [JSON.stringify(['two', 'af_heart', 'en', 1]), 2],
    ]);
    layout(placements, durations, script, 0.5);
    expect(spy).not.toHaveBeenCalled();
    expect(errSpy).not.toHaveBeenCalled();
    expect(logSpy).not.toHaveBeenCalled();
    spy.mockRestore();
    errSpy.mockRestore();
    logSpy.mockRestore();
  });
});

// ===========================================================================
// compileVoiceScript — orchestration, dedup, duck carriage, errors
// ===========================================================================

describe('compileVoiceScript', () => {
  it('should resolve ok:true with arch-§6 layer shape and deduped clips for a valid multi-line script', async () => {
    const script = validScript({
      duck: { toGain: 0.25, attackSec: 0.3, releaseSec: 0.8 },
      blocks: [{ lines: [{ say: 'one' }, { say: 'one' }, { say: 'two' }] }],
    });
    const { result, clipLib } = await compileOk(script);
    expect(result.compiled.layers.length).toBe(3);
    for (const l of result.compiled.layers) {
      expect(l.kind).toBe('voice');
      expect(l.source).toHaveProperty('clipId');
      expect(typeof (l.source as { clipId: string }).clipId).toBe('string');
      expect(typeof l.t).toBe('number');
    }
    // 'one' appears twice but synthesizes once → 2 distinct clips total
    expect(result.compiled.clips.length).toBe(2);
    expect(clipLib.calls.length).toBe(2);
    // distinct ids in clips
    expect(new Set(result.compiled.clips.map((c) => c.id)).size).toBe(2);
  });

  it('should synthesize a repeated phrase ONCE yet emit N layers pointing at the same clip', async () => {
    const script = validScript({
      blocks: [{ lines: [{ repeat: [{ say: 'one' }], count: 5 }] }],
    });
    const { result, clipLib } = await compileOk(script);
    expect(clipLib.calls.length).toBe(1);
    expect(result.compiled.layers.length).toBe(5);
    const clipIds = result.compiled.layers.map((l) => (l.source as { clipId: string }).clipId);
    expect(new Set(clipIds).size).toBe(1);
    expect(result.compiled.clips.length).toBe(1);
  });

  it('should carry Layer.duck === script.duck on every cue when duck is set', async () => {
    const duck = { toGain: 0.3, attackSec: 0.2, releaseSec: 0.5 };
    const script = validScript({ duck, blocks: [{ lines: [{ say: 'one' }, { say: 'two' }] }] });
    const { result } = await compileOk(script);
    for (const l of result.compiled.layers) {
      expect(l.duck).toEqual(duck);
    }
  });

  it('should omit Layer.duck when script.duck is null', async () => {
    const script = validScript({ duck: null, blocks: [{ lines: [{ say: 'one' }] }] });
    const { result } = await compileOk(script);
    expect(result.compiled.layers[0]).not.toHaveProperty('duck');
  });

  it('should omit Layer.duck when script.duck is absent', async () => {
    const script = validScript({ blocks: [{ lines: [{ say: 'one' }] }] });
    const { result } = await compileOk(script);
    expect(result.compiled.layers[0].duck).toBeUndefined();
  });

  it('should return ok:false with LINE_MULTI_DISCRIMINATOR and NEVER call importVia for a malformed line', async () => {
    const clipLib = fakeClipLib();
    const script = {
      version: 1,
      purpose: 'general',
      blocks: [{ lines: [{ say: 'hi', pauseSec: 2 }] }],
    } as unknown as VoiceScript;
    const result = await compileVoiceScript(script, { tts: fakeTts, clipLib });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(codes(result.issues)).toContain('LINE_MULTI_DISCRIMINATOR');
    }
    expect(clipLib.calls.length).toBe(0);
  });

  it('should convert an importVia rejection into SYNTH_FAILED, return no partial artifacts, and not leak the rejection', async () => {
    const clipLib = failingClipLib(2, new Error('model OOM'));
    const script = validScript({ blocks: [{ lines: [{ say: 'one' }, { say: 'two' }] }] });
    const result = await compileVoiceScript(script, { tts: fakeTts, clipLib });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const f = result.issues.find((i) => i.code === 'SYNTH_FAILED')!;
      expect(f.severity).toBe('error');
      expect(f.path).toBe('blocks[0].lines[1]');
      expect(f.message).toContain('Speech synthesis failed for "two"');
      expect(f.message).toContain('model OOM');
      // no compiled artifacts on the failure arm
      expect(result).not.toHaveProperty('compiled');
    }
  });

  it('should surface a ClipLibraryError code in the SYNTH_FAILED message', async () => {
    const clipLib = failingClipLib(1, Object.assign(new Error('IndexedDB full'), { code: 'QUOTA_EXCEEDED', name: 'ClipLibraryError' }));
    const script = validScript({ blocks: [{ lines: [{ say: 'one' }] }] });
    const result = await compileVoiceScript(script, { tts: fakeTts, clipLib });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues[0].code).toBe('SYNTH_FAILED');
      expect(result.issues[0].message).toContain('IndexedDB full');
    }
  });

  it('should be deterministic — recompiling yields byte-identical layers/clips/totalSec', async () => {
    const script = validScript({
      duck: { toGain: 0.25, attackSec: 0.3, releaseSec: 0.8 },
      blocks: [{ pacing: { gapSec: 0.5 }, lines: [{ say: 'one' }, { say: 'two' }] }],
      loop: { count: 2 },
    });
    const { result: a } = await compileOk(script);
    const { result: b } = await compileOk(script);
    expect(a.compiled.layers).toEqual(b.compiled.layers);
    expect(a.compiled.clips).toEqual(b.compiled.clips);
    expect(a.compiled.totalSec).toBe(b.compiled.totalSec);
  });

  it('should expand an untilSec loop into whole iterations bounded by the cursor', async () => {
    // body = single 'two' (dur 2), no gaps → each pass advances cursor by 2.
    const script = validScript({
      blocks: [{ lines: [{ say: 'two' }] }],
      loop: { untilSec: 5 },
    });
    const { result } = await compileOk(script);
    // passes start at cursor 0,2,4 (<5); next would be 6 (≥5) → stop. 3 iterations.
    expect(result.compiled.layers.map((l) => l.t)).toEqual([0, 2, 4]);
    expect(result.compiled.layers.map((l) => l.id)).toEqual(['vs_0_0_0', 'vs_0_0_1', 'vs_0_0_2']);
  });

  it('should stop an untilSec+count loop at the more restrictive count bound', async () => {
    const script = validScript({
      blocks: [{ lines: [{ say: 'two' }] }],
      loop: { untilSec: 100, count: 2 },
    });
    const { result } = await compileOk(script);
    expect(result.compiled.layers.map((l) => l.t)).toEqual([0, 2]);
  });
});

// ===========================================================================
// compileVoiceScriptOrThrow
// ===========================================================================

describe('compileVoiceScriptOrThrow', () => {
  it('should throw VoiceScriptError carrying issues on invalid input', async () => {
    const script = { version: 1, purpose: 'general', blocks: [] } as unknown as VoiceScript;
    await expect(compileVoiceScriptOrThrow(script, { tts: fakeTts, clipLib: fakeClipLib() })).rejects.toMatchObject({
      name: 'VoiceScriptError',
    });
    try {
      await compileVoiceScriptOrThrow(script, { tts: fakeTts, clipLib: fakeClipLib() });
    } catch (e) {
      expect(e).toBeInstanceOf(VoiceScriptError);
      expect(codes((e as VoiceScriptError).issues)).toContain('BLOCKS_EMPTY');
    }
  });

  it('should return the bare { layers, clips } shape on valid input', async () => {
    const script = validScript({ blocks: [{ lines: [{ say: 'one' }] }] });
    const out = await compileVoiceScriptOrThrow(script, { tts: fakeTts, clipLib: fakeClipLib() });
    expect(Object.keys(out).sort()).toEqual(['clips', 'layers']);
    expect(out.layers.length).toBe(1);
    expect(out.clips.length).toBe(1);
  });
});
