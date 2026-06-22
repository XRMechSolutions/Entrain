import {
  validate,
  parse,
  parseOrThrow,
  serialize,
  migrate,
  isPreset,
  clonePreset,
  createDefaultPreset,
  sortNodes,
  presetsEqual,
  voiceView,
  SessionModelError,
  CURRENT_SCHEMA_VERSION,
  MIN_SUPPORTED_SCHEMA_VERSION,
  RANGES,
  LIMITS,
  DEFAULTS,
} from './session-model';
import type {
  Preset,
  Voice,
  TimeNode,
  ValidationIssue,
  ValidationCode,
  ValidationResult,
  ParseResult,
  MigrateResult,
  Layer,
  LayerKind,
  LayerSource,
  LanePoint,
  ToneSpec,
  DuckIntent,
} from './session-model';

// --- helpers ---------------------------------------------------------------

type AnyObj = Record<string, unknown>;

function mkPreset(over: AnyObj = {}): AnyObj {
  return {
    schemaVersion: 6,
    name: 'Test Session',
    durationSec: 100,
    masterGain: 0.8,
    nodes: [{ t: 0, carrier: { value: 200 }, beat: { value: 8 }, volume: { value: 1 } }],
    ...over,
  };
}

function oneNode(node: AnyObj): AnyObj {
  return mkPreset({ nodes: [node] });
}

function beatMod(mod: unknown): AnyObj {
  return oneNode({ t: 0, carrier: { value: 200 }, beat: { value: 8, mod } });
}

function volMod(mod: unknown): AnyObj {
  return oneNode({ t: 0, carrier: { value: 200 }, volume: { value: 1, mod } });
}

function codes(r: { issues: ValidationIssue[] }): ValidationCode[] {
  return r.issues.map((i) => i.code);
}

function notOkCode(r: ValidationResult | ParseResult | MigrateResult): ValidationCode | undefined {
  return r.ok ? undefined : r.issues[0]?.code;
}

// --- Task 1: types, enums, constants, error class --------------------------

describe('constants and types', () => {
  it('RANGES carries the documented bounds', () => {
    expect(RANGES.carrier).toEqual({ min: 20, max: 1000 });
    expect(RANGES.beat).toEqual({ min: 0, max: 35 });
    expect(RANGES.volume).toEqual({ min: 0, max: 1 });
    expect(RANGES.masterGain).toEqual({ min: 0, max: 1 });
    expect(RANGES.pulseWidth).toEqual({ min: 0, max: 1 });
    expect(RANGES.depthVolume).toEqual({ min: 0, max: 1 });
    expect(RANGES.spatial).toEqual({ min: -1, max: 1 });
    expect(RANGES.depthSpatial).toEqual({ min: 0, max: 1 });
  });

  it('LIMITS carries the documented values', () => {
    expect(LIMITS.nameMaxCodePoints).toBe(80);
    expect(LIMITS.durationMaxSec).toBe(86400);
  });

  it('DEFAULTS carries eval-time carries and has no carrier key', () => {
    expect(DEFAULTS).toEqual({
      waveform: 'sine',
      beat: 0,
      volume: 1,
      spatial: 0,
      paramTransition: 'linear',
      modShape: 'sine',
      modTransition: 'glide',
      voiceGain: 1,
    });
    expect('carrier' in DEFAULTS).toBe(false);
  });

  it('schema-version constants are 6 (current) and 2 (min supported)', () => {
    expect(CURRENT_SCHEMA_VERSION).toBe(6);
    expect(MIN_SUPPORTED_SCHEMA_VERSION).toBe(2);
  });

  it('RANGES.toneFreq carries the documented bounds (v4)', () => {
    expect(RANGES.toneFreq).toEqual({ min: 20, max: 20000 });
  });

  it('RANGES.depthFreq caps carrier/beat warble depth at 1.0 (v5 fraction-of-base)', () => {
    expect(RANGES.depthFreq).toEqual({ min: 0, max: 1 });
  });

  it('SessionModelError sets name and carries the passed issues', () => {
    const issues: ValidationIssue[] = [
      { code: 'NOT_OBJECT', severity: 'error', path: '', message: 'x' },
    ];
    const e = new SessionModelError('boom', issues);
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe('SessionModelError');
    expect(e.message).toBe('boom');
    expect(e.issues).toBe(issues);
  });

  it('exposes Preset.schemaVersion as literal 6 and the TimeNode type', () => {
    const node: TimeNode = { t: 0, carrier: { value: 200 }, spatial: { value: 0 } };
    const version: 6 = createDefaultPreset().schemaVersion;
    expect(version).toBe(6);
    expect(node.t).toBe(0);
  });
});

// --- Task 2: validate — structure, per-field ranges, normalization ---------

describe('validate — happy path & normalization', () => {
  it('accepts a valid preset and returns a warnings-only normalized clone', () => {
    const input = mkPreset({ extra: 1 });
    const r = validate(input);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.issues.every((i) => i.severity === 'warning')).toBe(true);
      expect(codes(r)).toContain('UNKNOWN_FIELD');
      expect(r.preset.schemaVersion).toBe(6);
      expect('extra' in r.preset).toBe(false);
    }
  });

  it('never mutates its input', () => {
    const input = mkPreset({ extra: 1, nodes: [{ t: 0, carrier: { value: 200, bonus: 9 } }] });
    const snapshot = structuredClone(input);
    validate(input);
    expect(input).toEqual(snapshot);
  });

  it('returns a normalized clone that is an independent object graph', () => {
    const input = mkPreset();
    const r = validate(input);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.preset).not.toBe(input);
      expect(r.preset.nodes).not.toBe(input.nodes);
      r.preset.name = 'mutated';
      expect(input.name).toBe('Test Session');
    }
  });

  it('drops unknown keys and warns at root and nested paths', () => {
    const r = validate({
      schemaVersion: 6,
      name: 'x',
      durationSec: 100,
      masterGain: 1,
      foo: 1,
      nodes: [{ t: 0, carrier: { value: 200, bar: 2 }, baz: 3 }],
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      const paths = r.issues.filter((i) => i.code === 'UNKNOWN_FIELD').map((i) => i.path);
      expect(paths).toContain('foo');
      expect(paths).toContain('nodes[0].baz');
      expect(paths).toContain('nodes[0].carrier.bar');
      expect('foo' in r.preset).toBe(false);
      expect(r.preset.nodes[0].carrier).toEqual({ value: 200 });
    }
  });

  it('preserves mod absent / null / empty-object losslessly', () => {
    const r = validate({
      schemaVersion: 6,
      name: 'x',
      durationSec: 100,
      masterGain: 1,
      nodes: [
        { t: 0, carrier: { value: 200 }, beat: { value: 8 } },
        { t: 10, beat: { value: 6, mod: null } },
        { t: 20, beat: { value: 4, mod: {} } },
      ],
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.preset.nodes[0].beat && 'mod' in r.preset.nodes[0].beat).toBe(false);
      expect(r.preset.nodes[1].beat?.mod).toBeNull();
      expect(r.preset.nodes[2].beat?.mod).toEqual({});
    }
  });

  it('accepts inclusive bounds and rejects just-outside without clamping', () => {
    expect(validate(oneNode({ t: 0, carrier: { value: 20 } })).ok).toBe(true);
    expect(validate(oneNode({ t: 0, carrier: { value: 1000 } })).ok).toBe(true);
    expect(validate(oneNode({ t: 0, carrier: { value: 200 }, beat: { value: 0 } })).ok).toBe(true);
    expect(validate(oneNode({ t: 0, carrier: { value: 200 }, beat: { value: 35 } })).ok).toBe(true);
    expect(validate(oneNode({ t: 0, carrier: { value: 200 }, volume: { value: 0 } })).ok).toBe(true);
    expect(validate(oneNode({ t: 0, carrier: { value: 200 }, volume: { value: 1 } })).ok).toBe(true);

    expect(validate(oneNode({ t: 0, carrier: { value: 19.999 } })).ok).toBe(false);
    expect(validate(oneNode({ t: 0, carrier: { value: 1000.001 } })).ok).toBe(false);
    expect(validate(oneNode({ t: 0, carrier: { value: 200 }, volume: { value: 1.0000001 } })).ok).toBe(false);

    const r = validate(oneNode({ t: 0, carrier: { value: 1000 } }));
    if (r.ok) expect(r.preset.nodes[0].carrier?.value).toBe(1000);
  });

  it('rejects NaN and ±Infinity via *_NOT_FINITE', () => {
    expect(codes(validate(mkPreset({ durationSec: Infinity })))).toContain('DURATION_NOT_FINITE');
    expect(codes(validate(mkPreset({ masterGain: -Infinity })))).toContain('MASTER_GAIN_NOT_FINITE');
    expect(codes(validate(oneNode({ t: 0, carrier: { value: NaN } })))).toContain('PARAM_VALUE_NOT_FINITE');
    expect(codes(validate(oneNode({ t: NaN, carrier: { value: 200 } })))).toContain('NODE_T_NOT_FINITE');
  });

  it('enforces [0,1] on volume depth/steps and caps carrier/beat depth at 1.0', () => {
    expect(validate(volMod({ depth: 1.5 })).ok).toBe(false);
    expect(validate(volMod({ steps: [0.5, 1.5], transition: 'jump' })).ok).toBe(false);
    // carrier/beat depth is now a FRACTION of base in [0,1] — > 1 is out of range.
    expect(validate(beatMod({ depth: 1.5 })).ok).toBe(false);
    expect(validate(beatMod({ depth: 0.2 })).ok).toBe(true);
    expect(validate(beatMod({ steps: [-5, 0, 5], transition: 'jump' })).ok).toBe(true);
    expect(validate(oneNode({ t: 0, carrier: { value: 200, mod: { depth: 1.5 } } })).ok).toBe(false);
    expect(validate(oneNode({ t: 0, carrier: { value: 200, mod: { depth: 0.5 } } })).ok).toBe(true);
  });

  it('collects all independent errors without fail-fast', () => {
    const r = validate({
      schemaVersion: 6,
      name: '',
      durationSec: -1,
      masterGain: 2,
      nodes: [{ t: 0, carrier: { value: 5 } }],
    });
    expect(r.ok).toBe(false);
    const c = codes(r);
    expect(c).toContain('NAME_EMPTY');
    expect(c).toContain('DURATION_NOT_POSITIVE');
    expect(c).toContain('MASTER_GAIN_OUT_OF_RANGE');
    expect(c).toContain('PARAM_VALUE_OUT_OF_RANGE');
    expect(r.issues.length).toBeGreaterThanOrEqual(4);
  });

  it('matches the documented validation-failure example exactly', () => {
    const r = parse('{"schemaVersion":2,"name":"","durationSec":-1,"masterGain":2,"nodes":[]}');
    expect(r.ok).toBe(false);
    expect(codes(r)).toEqual([
      'NAME_EMPTY',
      'DURATION_NOT_POSITIVE',
      'MASTER_GAIN_OUT_OF_RANGE',
      'NODES_EMPTY',
    ]);
  });
});

describe('validate — documented boundary nuances', () => {
  it('measures name length in Unicode code points (emoji counts as 1)', () => {
    expect(validate(mkPreset({ name: 'a'.repeat(80) })).ok).toBe(true);
    expect(codes(validate(mkPreset({ name: 'a'.repeat(81) })))).toContain('NAME_TOO_LONG');
    // 80 rocket emojis = 80 code points (160 UTF-16 units) — accepted via spread counting.
    expect(validate(mkPreset({ name: '🚀'.repeat(80) })).ok).toBe(true);
    expect(codes(validate(mkPreset({ name: '🚀'.repeat(81) })))).toContain('NAME_TOO_LONG');
  });

  it('accepts the inclusive duration ceiling and rejects just past it', () => {
    expect(validate(mkPreset({ durationSec: 86400 })).ok).toBe(true);
    expect(codes(validate(mkPreset({ durationSec: 86400.0001 })))).toContain('DURATION_TOO_LONG');
  });

  it('accepts degenerate-but-legal pulseWidth 0 and 1', () => {
    expect(validate(volMod({ shape: 'pulse', periodSec: 1, pulseWidth: 0 })).ok).toBe(true);
    expect(validate(volMod({ shape: 'pulse', periodSec: 1, pulseWidth: 1 })).ok).toBe(true);
  });

  it('treats -0 as 0 for t and values', () => {
    expect(validate(oneNode({ t: -0, carrier: { value: 200 }, volume: { value: -0 } })).ok).toBe(true);
  });
});

describe('validate — every error code is reachable by one bad field', () => {
  const cases: Array<[string, unknown, ValidationCode]> = [
    ['root not object', 5, 'NOT_OBJECT'],
    ['schemaVersion missing', { name: 'x', durationSec: 100, masterGain: 1, nodes: [{ t: 0, carrier: { value: 200 } }] }, 'SCHEMA_VERSION_MISSING'],
    ['schemaVersion not integer', mkPreset({ schemaVersion: 2.5 }), 'SCHEMA_VERSION_NOT_INTEGER'],
    ['wrong schema version', mkPreset({ schemaVersion: 2 }), 'WRONG_SCHEMA_VERSION'],
    ['name not string', mkPreset({ name: 5 }), 'NAME_NOT_STRING'],
    ['name empty (whitespace)', mkPreset({ name: '   ' }), 'NAME_EMPTY'],
    ['name too long', mkPreset({ name: 'a'.repeat(81) }), 'NAME_TOO_LONG'],
    ['duration not finite', mkPreset({ durationSec: NaN }), 'DURATION_NOT_FINITE'],
    ['duration not positive', mkPreset({ durationSec: 0 }), 'DURATION_NOT_POSITIVE'],
    ['duration too long', mkPreset({ durationSec: 86401 }), 'DURATION_TOO_LONG'],
    ['masterGain not finite', mkPreset({ masterGain: NaN }), 'MASTER_GAIN_NOT_FINITE'],
    ['masterGain out of range', mkPreset({ masterGain: 2 }), 'MASTER_GAIN_OUT_OF_RANGE'],
    ['nodes not array', mkPreset({ nodes: {} }), 'NODES_NOT_ARRAY'],
    ['nodes empty', mkPreset({ nodes: [] }), 'NODES_EMPTY'],
    ['node not object', mkPreset({ nodes: [5] }), 'NODE_NOT_OBJECT'],
    ['node t not finite', oneNode({ t: 'x', carrier: { value: 200 } }), 'NODE_T_NOT_FINITE'],
    ['node t negative', oneNode({ t: -1, carrier: { value: 200 } }), 'NODE_T_NEGATIVE'],
    ['node t exceeds duration', mkPreset({ durationSec: 100, nodes: [{ t: 0, carrier: { value: 200 } }, { t: 200, volume: { value: 1 } }] }), 'NODE_T_EXCEEDS_DURATION'],
    ['nodes not sorted', mkPreset({ nodes: [{ t: 0, carrier: { value: 200 } }, { t: 10, volume: { value: 1 } }, { t: 5, volume: { value: 1 } }] }), 'NODES_NOT_SORTED'],
    ['nodes duplicate t', mkPreset({ nodes: [{ t: 0, carrier: { value: 200 } }, { t: 5, volume: { value: 1 } }, { t: 5, volume: { value: 1 } }] }), 'NODES_DUPLICATE_T'],
    ['nodes first t nonzero', oneNode({ t: 1, carrier: { value: 200 } }), 'NODES_FIRST_T_NONZERO'],
    ['carrier not at start', oneNode({ t: 0, beat: { value: 8 } }), 'CARRIER_NOT_AT_START'],
    ['param point not object', oneNode({ t: 0, carrier: 5 }), 'PARAM_POINT_NOT_OBJECT'],
    ['param value not finite', oneNode({ t: 0, carrier: { value: NaN } }), 'PARAM_VALUE_NOT_FINITE'],
    ['param value out of range', oneNode({ t: 0, carrier: { value: 5 } }), 'PARAM_VALUE_OUT_OF_RANGE'],
    ['param transition invalid', oneNode({ t: 0, carrier: { value: 200, transition: 'wobble' } }), 'PARAM_TRANSITION_INVALID'],
    ['exp ramp through zero', mkPreset({ nodes: [{ t: 0, carrier: { value: 200 }, volume: { value: 1, transition: 'exp' } }, { t: 10, volume: { value: 0 } }] }), 'EXP_RAMP_THROUGH_ZERO'],
    ['mod not object or null', beatMod(5), 'MOD_NOT_OBJECT_OR_NULL'],
    ['mod shape invalid', beatMod({ shape: 'zigzag' }), 'MOD_SHAPE_INVALID'],
    ['mod period not finite', beatMod({ periodSec: Infinity }), 'MOD_PERIOD_NOT_FINITE'],
    ['mod period not positive', beatMod({ periodSec: 0 }), 'MOD_PERIOD_NOT_POSITIVE'],
    ['mod depth not finite', beatMod({ depth: NaN }), 'MOD_DEPTH_NOT_FINITE'],
    ['mod depth negative', beatMod({ depth: -1 }), 'MOD_DEPTH_NEGATIVE'],
    ['mod depth out of range (volume)', volMod({ depth: 1.5 }), 'MOD_DEPTH_OUT_OF_RANGE'],
    ['mod transition invalid', beatMod({ transition: 'slide' }), 'MOD_TRANSITION_INVALID'],
    ['mod pulseWidth not finite', beatMod({ pulseWidth: NaN }), 'MOD_PULSE_WIDTH_NOT_FINITE'],
    ['mod pulseWidth out of range', beatMod({ pulseWidth: 2 }), 'MOD_PULSE_WIDTH_OUT_OF_RANGE'],
    ['mod edgeMs not finite', beatMod({ edgeMs: NaN }), 'MOD_EDGE_MS_NOT_FINITE'],
    ['mod edgeMs negative', beatMod({ edgeMs: -1 }), 'MOD_EDGE_MS_NEGATIVE'],
    ['mod steps not array', beatMod({ steps: 5 }), 'MOD_STEPS_NOT_ARRAY'],
    ['mod steps empty', beatMod({ steps: [] }), 'MOD_STEPS_EMPTY'],
    ['mod step not finite', volMod({ steps: [0.5, NaN], transition: 'jump' }), 'MOD_STEP_NOT_FINITE'],
    ['mod step out of range (volume)', volMod({ steps: [0.5, 1.5], transition: 'jump' }), 'MOD_STEP_OUT_OF_RANGE'],
    ['waveform invalid', oneNode({ t: 0, carrier: { value: 200 }, waveform: 'noise' }), 'WAVEFORM_INVALID'],
    ['spatial value out of range', oneNode({ t: 0, carrier: { value: 200 }, spatial: { value: 1.5 } }), 'PARAM_VALUE_OUT_OF_RANGE'],
    ['spatial mod depth out of range', oneNode({ t: 0, carrier: { value: 200 }, spatial: { value: 0, mod: { depth: 1.5 } } }), 'MOD_DEPTH_OUT_OF_RANGE'],
    ['spatial exp ramp through zero', mkPreset({ nodes: [{ t: 0, carrier: { value: 200 }, spatial: { value: 0.5, transition: 'exp' } }, { t: 10, spatial: { value: -0.5 } }] }), 'EXP_RAMP_THROUGH_ZERO'],
  ];

  it.each(cases)('flags %s as %s', (_desc, input, code) => {
    const r = validate(input);
    expect(r.ok).toBe(false);
    expect(codes(r)).toContain(code);
  });
});

describe('validate — verbatim message templates', () => {
  function find(input: unknown, code: ValidationCode): ValidationIssue | undefined {
    return validate(input).issues.find((i) => i.code === code);
  }

  it('uses the documented templates', () => {
    expect(find(5, 'NOT_OBJECT')?.message).toBe('A preset must be a JSON object, got number');
    expect(find(oneNode({ t: 0, carrier: { value: 5 } }), 'PARAM_VALUE_OUT_OF_RANGE')?.message).toBe(
      '"carrier.value" must be within [20, 1000], got 5',
    );
    expect(find(oneNode({ t: 0, beat: { value: 8 } }), 'CARRIER_NOT_AT_START')?.message).toBe(
      'The first node (t=0) must set "carrier"',
    );
    expect(find(oneNode({ t: -1, carrier: { value: 200 } }), 'NODE_T_NEGATIVE')?.message).toBe(
      'Node "t" must be ≥ 0, got -1',
    );
    expect(find(mkPreset({ extra: 1 }), 'UNKNOWN_FIELD')?.message).toBe('Unknown field "extra" ignored');
    expect(
      find(
        mkPreset({ nodes: [{ t: 0, carrier: { value: 200 } }, { t: 5, volume: { value: 1 } }, { t: 5, volume: { value: 1 } }] }),
        'NODES_DUPLICATE_T',
      )?.message,
    ).toBe('Two nodes share t=5; node times must be unique');
  });
});

// --- Task 3: cross-node temporal rules -------------------------------------

describe('validate — cross-node temporal rules', () => {
  it('reports NODES_NOT_SORTED and does not reorder', () => {
    const input = mkPreset({ nodes: [{ t: 0, carrier: { value: 200 } }, { t: 10, volume: { value: 1 } }, { t: 5, volume: { value: 1 } }] });
    const r = validate(input);
    expect(r.ok).toBe(false);
    expect(codes(r)).toContain('NODES_NOT_SORTED');
    // input untouched (no reorder)
    expect((input.nodes as AnyObj[]).map((n) => n.t)).toEqual([0, 10, 5]);
  });

  it('reports NODES_DUPLICATE_T on exact-equal t', () => {
    const r = validate(mkPreset({ nodes: [{ t: 0, carrier: { value: 200 } }, { t: 5, volume: { value: 1 } }, { t: 5, volume: { value: 1 } }] }));
    expect(codes(r)).toContain('NODES_DUPLICATE_T');
  });

  it('treats near-equal t (1.0 vs 1.0000001) as distinct nodes', () => {
    const r = validate(mkPreset({ nodes: [{ t: 0, carrier: { value: 200 } }, { t: 1.0, volume: { value: 1 } }, { t: 1.0000001, volume: { value: 1 } }] }));
    expect(r.ok).toBe(true);
  });

  it('requires the first node at t=0', () => {
    expect(codes(validate(oneNode({ t: 1, carrier: { value: 200 } })))).toContain('NODES_FIRST_T_NONZERO');
  });

  it('flags a node t greater than durationSec', () => {
    const r = validate(mkPreset({ durationSec: 100, nodes: [{ t: 0, carrier: { value: 200 } }, { t: 150, volume: { value: 1 } }] }));
    expect(codes(r)).toContain('NODE_T_EXCEEDS_DURATION');
  });

  it('requires carrier on nodes[0] but suppresses it when nodes[0] is not an object', () => {
    expect(codes(validate(oneNode({ t: 0, beat: { value: 8 } })))).toContain('CARRIER_NOT_AT_START');
    const r = validate(mkPreset({ nodes: [5, { t: 1, carrier: { value: 200 } }] }));
    expect(codes(r)).toContain('NODE_NOT_OBJECT');
    expect(codes(r)).not.toContain('CARRIER_NOT_AT_START');
  });

  it('rejects exp fade to zero', () => {
    const r = validate(mkPreset({ nodes: [{ t: 0, carrier: { value: 200 }, volume: { value: 1, transition: 'exp' } }, { t: 10, volume: { value: 0 } }] }));
    expect(r.ok).toBe(false);
    const issue = r.issues.find((i) => i.code === 'EXP_RAMP_THROUGH_ZERO');
    expect(issue?.path).toBe('nodes[0].volume.transition');
    expect(issue?.message).toBe(
      '"exp" transition cannot ramp to or across zero (1 → 0); use linear/smooth or keep both endpoints the same nonzero sign',
    );
  });

  it('rejects exp on a beat that reaches zero', () => {
    const r = validate(mkPreset({ nodes: [{ t: 0, carrier: { value: 200 }, beat: { value: 4, transition: 'exp' } }, { t: 10, beat: { value: 0 } }] }));
    expect(codes(r)).toContain('EXP_RAMP_THROUGH_ZERO');
  });

  it('accepts exp on a param last keyframe (no successor, no ramp)', () => {
    const r = validate(mkPreset({ nodes: [{ t: 0, carrier: { value: 200 }, volume: { value: 1 } }, { t: 10, volume: { value: 0, transition: 'exp' } }] }));
    expect(r.ok).toBe(true);
  });

  it('accepts exp on carrier (always ≥ 20, never reaches zero)', () => {
    const r = validate(mkPreset({ nodes: [{ t: 0, carrier: { value: 200, transition: 'exp' } }, { t: 10, carrier: { value: 400 } }] }));
    expect(r.ok).toBe(true);
  });

  it('excludes a non-finite-t node from ordering and exp analysis but still reports it', () => {
    const r = validate(mkPreset({ durationSec: 100, nodes: [
      { t: 0, carrier: { value: 200 }, volume: { value: 1, transition: 'exp' } },
      { t: NaN, volume: { value: 0 } },
      { t: 10, volume: { value: 0.5 } },
    ] }));
    expect(r.ok).toBe(false);
    const c = codes(r);
    expect(c).toContain('NODE_T_NOT_FINITE');
    expect(c).not.toContain('NODES_NOT_SORTED');
    expect(c).not.toContain('EXP_RAMP_THROUGH_ZERO');
  });
});

describe('validate — ModPoint advisory warnings keep ok:true', () => {
  it('warns IGNORED_FIELD_FOR_SHAPE for pulseWidth on sine', () => {
    const r = validate(volMod({ shape: 'sine', pulseWidth: 0.5 }));
    expect(r.ok).toBe(true);
    if (r.ok) {
      const w = r.issues.find((i) => i.code === 'IGNORED_FIELD_FOR_SHAPE');
      expect(w?.path).toBe('nodes[0].volume.mod.pulseWidth');
      expect(w?.message).toBe('"volume.mod.pulseWidth" has no effect with shape "sine"');
    }
  });

  it('warns IGNORED_FIELD_FOR_SHAPE for edgeMs on square', () => {
    expect(codes(validate(volMod({ shape: 'square', edgeMs: 5 })))).toContain('IGNORED_FIELD_FOR_SHAPE');
  });

  it('does not warn when shape pulse honors pulseWidth and edgeMs', () => {
    const r = validate(volMod({ shape: 'pulse', periodSec: 1, pulseWidth: 0.5, edgeMs: 5 }));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.issues.find((i) => i.code === 'IGNORED_FIELD_FOR_SHAPE')).toBeUndefined();
  });

  it('warns MOD_EDGE_EXCEEDS_HALF_PERIOD', () => {
    const r = validate(volMod({ shape: 'pulse', periodSec: 0.1, edgeMs: 200 }));
    expect(r.ok).toBe(true);
    if (r.ok) expect(codes(r)).toContain('MOD_EDGE_EXCEEDS_HALF_PERIOD');
  });

  it('warns STEPS_OVERRIDE_DEPTH when both present', () => {
    const r = validate(volMod({ steps: [0.5, 1], depth: 0.5, transition: 'jump' }));
    expect(r.ok).toBe(true);
    if (r.ok) expect(codes(r)).toContain('STEPS_OVERRIDE_DEPTH');
  });

  it('warns STEPS_REQUIRE_JUMP when transition is not jump', () => {
    const r = validate(volMod({ steps: [0.5, 1] }));
    expect(r.ok).toBe(true);
    if (r.ok) expect(codes(r)).toContain('STEPS_REQUIRE_JUMP');
  });
});

// --- box (trapezoid / breath) shape ----------------------------------------

describe('validate — box modulator shape', () => {
  it('accepts box as a valid mod shape (additive enum, no schema bump)', () => {
    expect(validate(beatMod({ shape: 'box', periodSec: 16, depth: 0.2 })).ok).toBe(true);
    expect(CURRENT_SCHEMA_VERSION).toBe(6); // box is additive — version is the current schema
  });

  it('reads pulseWidth as the box hold ratio: in range, NOT ignored', () => {
    const r = validate(beatMod({ shape: 'box', periodSec: 16, depth: 0.2, pulseWidth: 0.5 }));
    expect(r.ok).toBe(true);
    if (r.ok) {
      // box uses pulseWidth (hold ratio) → no IGNORED_FIELD_FOR_SHAPE for pulseWidth.
      expect(r.issues.find((i) => i.code === 'IGNORED_FIELD_FOR_SHAPE')).toBeUndefined();
    }
  });

  it('still range-checks pulseWidth [0,1] for box (hold ratio bounds)', () => {
    expect(notOkCode(validate(beatMod({ shape: 'box', periodSec: 16, pulseWidth: 2 })))).toBe(
      'MOD_PULSE_WIDTH_OUT_OF_RANGE',
    );
    expect(validate(beatMod({ shape: 'box', periodSec: 16, pulseWidth: 0 })).ok).toBe(true);
    expect(validate(beatMod({ shape: 'box', periodSec: 16, pulseWidth: 1 })).ok).toBe(true);
  });

  it('warns IGNORED_FIELD_FOR_SHAPE for edgeMs on box (like sine/triangle)', () => {
    const r = validate(beatMod({ shape: 'box', periodSec: 16, edgeMs: 5 }));
    expect(r.ok).toBe(true);
    if (r.ok) {
      const w = r.issues.find((i) => i.code === 'IGNORED_FIELD_FOR_SHAPE');
      expect(w?.path).toBe('nodes[0].beat.mod.edgeMs');
      expect(w?.message).toBe('"beat.mod.edgeMs" has no effect with shape "box"');
    }
  });

  it('warns IGNORED_FIELD_FOR_SHAPE for steps on box (box owns its trajectory)', () => {
    const r = validate(beatMod({ shape: 'box', periodSec: 16, transition: 'jump', steps: [1, 2] }));
    expect(r.ok).toBe(true);
    if (r.ok) {
      const w = r.issues.find(
        (i) => i.code === 'IGNORED_FIELD_FOR_SHAPE' && i.path === 'nodes[0].beat.mod.steps',
      );
      expect(w?.message).toBe('"beat.mod.steps" has no effect with shape "box"');
    }
  });

  it('error message for an invalid shape lists box', () => {
    const r = validate(beatMod({ shape: 'zigzag' }));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      const e = r.issues.find((i) => i.code === 'MOD_SHAPE_INVALID');
      expect(e?.message).toContain('box');
    }
  });
});

// --- Task 4: pure helpers --------------------------------------------------

describe('sortNodes', () => {
  it('returns a new array, leaves the input unchanged, and is stable for equal t', () => {
    const a: TimeNode = { t: 5, carrier: { value: 1 } };
    const b: TimeNode = { t: 5, carrier: { value: 2 } };
    const c: TimeNode = { t: 0 };
    const input = [a, b, c];
    const sorted = sortNodes(input);

    expect(sorted).not.toBe(input);
    expect(input).toEqual([a, b, c]); // input untouched
    expect(sorted.map((n) => n.t)).toEqual([0, 5, 5]);
    expect(sorted[0]).toBe(c);
    expect(sorted[1]).toBe(a); // stability: a before b preserved
    expect(sorted[2]).toBe(b);
  });
});

describe('clonePreset', () => {
  it('returns a deep-equal, independent graph preserving null and double precision', () => {
    const p: Preset = {
      schemaVersion: 6,
      name: 'x',
      durationSec: 100,
      masterGain: 0.123456789012345,
      nodes: [{ t: 0, carrier: { value: 200 }, beat: { value: 8, mod: null } }],
    };
    const c = clonePreset(p);
    expect(c).toEqual(p);
    expect(c).not.toBe(p);
    expect(c.nodes).not.toBe(p.nodes);
    expect(c.nodes[0].beat?.mod).toBeNull();
    expect(c.masterGain).toBe(0.123456789012345);
    c.name = 'changed';
    expect(p.name).toBe('x');
  });
});

describe('createDefaultPreset', () => {
  it('deep-equals the documented starter object', () => {
    expect(createDefaultPreset()).toEqual({
      schemaVersion: 6,
      name: 'Untitled Session',
      durationSec: 300,
      masterGain: 0.8,
      nodes: [{ t: 0, carrier: { value: 200 }, beat: { value: 8 }, volume: { value: 1 } }],
    });
  });

  it('passes validate with carrier at start and nodes[0].t === 0', () => {
    const r = validate(createDefaultPreset());
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.issues).toEqual([]);
      expect(r.preset.nodes[0].t).toBe(0);
      expect(r.preset.nodes[0].carrier).toBeDefined();
    }
  });

  it('is a v4 pure-binaural preset with no layers key', () => {
    expect('layers' in createDefaultPreset()).toBe(false);
  });
});

// --- Task 5: migrate / parse / parseOrThrow --------------------------------

describe('migrate', () => {
  it('passes a version-6 object through unchanged with fromVersion 6', () => {
    const raw = { schemaVersion: 6, name: 'x' };
    const r = migrate(raw);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value).toBe(raw);
      expect(r.fromVersion).toBe(6);
    }
  });

  it('migrates a version-5 object up to v6 (version-bumps) with fromVersion 5', () => {
    const raw = { schemaVersion: 5, name: 'x' };
    const r = migrate(raw);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect((r.value as { schemaVersion: number }).schemaVersion).toBe(6);
      expect((r.value as { name: string }).name).toBe('x');
      expect(r.fromVersion).toBe(5);
    }
  });

  it('migrates a version-3 object up to v6 (version-bumps) with fromVersion 3', () => {
    const raw = { schemaVersion: 3, name: 'x' };
    const r = migrate(raw);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect((r.value as { schemaVersion: number }).schemaVersion).toBe(6);
      expect((r.value as { name: string }).name).toBe('x');
      expect(r.fromVersion).toBe(3);
    }
  });

  it('migrates a version-2 object up to v6 (four version-bumps) with fromVersion 2', () => {
    const raw = { schemaVersion: 2, name: 'x' };
    const r = migrate(raw);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect((r.value as { schemaVersion: number }).schemaVersion).toBe(6);
      expect((r.value as { name: string }).name).toBe('x');
      expect(r.fromVersion).toBe(2);
    }
  });

  it('converts v4 carrier/beat warble depth from Hz to a fraction of base on v4→v5', () => {
    const raw = {
      schemaVersion: 4,
      name: 'x',
      durationSec: 100,
      masterGain: 0.8,
      nodes: [
        {
          t: 0,
          carrier: { value: 200, mod: { shape: 'sine', periodSec: 10, depth: 20 } },
          beat: { value: 10, mod: { shape: 'sine', periodSec: 4, depth: 2 } },
          volume: { value: 1, mod: { shape: 'sine', periodSec: 8, depth: 0.5 } },
        },
      ],
    };
    const r = migrate(raw);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.fromVersion).toBe(4);
      const node = (r.value as { nodes: AnyObj[] }).nodes[0];
      // carrier base 200, depth 20 → 20/200 = 0.1
      expect((node.carrier as AnyObj).mod).toMatchObject({ depth: 0.1 });
      // beat base 10, depth 2 → 2/10 = 0.2
      expect((node.beat as AnyObj).mod).toMatchObject({ depth: 0.2 });
      // volume depth untouched (already a 0..1 multiplier)
      expect((node.volume as AnyObj).mod).toMatchObject({ depth: 0.5 });
    }
  });

  it('clamps v4→v5 carrier/beat depth to 1 when the Hz depth ≥ base, untouched volume/spatial/steps', () => {
    const raw = {
      schemaVersion: 4,
      name: 'x',
      durationSec: 100,
      masterGain: 0.8,
      nodes: [
        {
          t: 0,
          carrier: { value: 200 },
          beat: { value: 10, mod: { shape: 'sine', periodSec: 4, depth: 50 } },
          volume: { value: 1, mod: { depth: 0.7, steps: [0.2, 0.8], transition: 'jump' } },
          spatial: { value: 0, mod: { depth: 0.6, steps: [-0.5, 0.5], transition: 'jump' } },
        },
      ],
    };
    const r = migrate(raw);
    expect(r.ok).toBe(true);
    if (r.ok) {
      const node = (r.value as { nodes: AnyObj[] }).nodes[0];
      // beat base 10, depth 50 ≥ base → clamped to 1
      expect((node.beat as AnyObj).mod).toMatchObject({ depth: 1 });
      // volume/spatial depth + steps untouched
      expect((node.volume as AnyObj).mod).toMatchObject({ depth: 0.7, steps: [0.2, 0.8] });
      expect((node.spatial as AnyObj).mod).toMatchObject({ depth: 0.6, steps: [-0.5, 0.5] });
    }
  });

  it('gates missing / non-integer / too-old / too-new / non-object', () => {
    expect(notOkCode(migrate({}))).toBe('SCHEMA_VERSION_MISSING');
    expect(notOkCode(migrate({ schemaVersion: '2' }))).toBe('SCHEMA_VERSION_NOT_INTEGER');
    expect(notOkCode(migrate({ schemaVersion: 1 }))).toBe('SCHEMA_TOO_OLD');
    expect(notOkCode(migrate({ schemaVersion: 7 }))).toBe('SCHEMA_TOO_NEW');
    expect(notOkCode(migrate(5))).toBe('NOT_OBJECT');
  });
});

describe('parse', () => {
  it('returns INVALID_JSON without throwing on malformed JSON', () => {
    let r: ParseResult | undefined;
    expect(() => {
      r = parse('{ not valid');
    }).not.toThrow();
    expect(r?.ok).toBe(false);
    expect(r && notOkCode(r)).toBe('INVALID_JSON');
  });

  it('returns NOT_OBJECT for non-object JSON', () => {
    expect(notOkCode(parse('5'))).toBe('NOT_OBJECT');
    expect(notOkCode(parse('[]'))).toBe('NOT_OBJECT');
    expect(notOkCode(parse('null'))).toBe('NOT_OBJECT');
    expect(notOkCode(parse('"hi"'))).toBe('NOT_OBJECT');
  });

  it('loads a current (v6) preset with migratedFrom null', () => {
    const r = parse(serialize(createDefaultPreset()));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.migratedFrom).toBeNull();
  });

  it('migrates a v2 JSON preset up to v6 with migratedFrom 2', () => {
    const r = parse('{"schemaVersion":2,"name":"x","durationSec":100,"masterGain":0.8,"nodes":[{"t":0,"carrier":{"value":200}}]}');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.preset.schemaVersion).toBe(6);
      expect(r.migratedFrom).toBe(2);
    }
  });

  it('migrates a v3 JSON preset (with spatial) up to v6 with migratedFrom 3', () => {
    const r = parse('{"schemaVersion":3,"name":"x","durationSec":100,"masterGain":0.8,"nodes":[{"t":0,"carrier":{"value":200},"spatial":{"value":-0.5}}]}');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.preset.schemaVersion).toBe(6);
      expect(r.migratedFrom).toBe(3);
      expect('layers' in r.preset).toBe(false); // v3→v6 adds no layers
      expect(r.preset.nodes[0].spatial).toEqual({ value: -0.5 });
    }
  });

  it('gates schema versions', () => {
    expect(notOkCode(parse('{"schemaVersion":1,"name":"x","durationSec":1,"masterGain":1,"nodes":[]}'))).toBe('SCHEMA_TOO_OLD');
    expect(notOkCode(parse('{"schemaVersion":7,"name":"x","durationSec":1,"masterGain":1,"nodes":[]}'))).toBe('SCHEMA_TOO_NEW');
    expect(notOkCode(parse('{"name":"x"}'))).toBe('SCHEMA_VERSION_MISSING');
    expect(notOkCode(parse('{"schemaVersion":2.5}'))).toBe('SCHEMA_VERSION_NOT_INTEGER');
  });

  it('pre-sorts out-of-order nodes; only true duplicates survive', () => {
    const ordered = parse('{"schemaVersion":6,"name":"x","durationSec":100,"masterGain":1,"nodes":[{"t":0,"carrier":{"value":200}},{"t":10,"volume":{"value":0.5}},{"t":5,"volume":{"value":0.8}}]}');
    expect(ordered.ok).toBe(true);
    if (ordered.ok) expect(ordered.preset.nodes.map((n) => n.t)).toEqual([0, 5, 10]);

    const dup = parse('{"schemaVersion":6,"name":"x","durationSec":100,"masterGain":1,"nodes":[{"t":0,"carrier":{"value":200}},{"t":5,"volume":{"value":0.5}},{"t":5,"volume":{"value":0.8}}]}');
    expect(dup.ok).toBe(false);
    expect(codes(dup)).toContain('NODES_DUPLICATE_T');
  });
});

describe('parseOrThrow', () => {
  it('returns the Preset on valid input', () => {
    const p = parseOrThrow(serialize(createDefaultPreset()));
    expect(p.name).toBe('Untitled Session');
  });

  it('throws SessionModelError on invalid input', () => {
    expect(() => parseOrThrow('{ broken')).toThrow(SessionModelError);
    try {
      parseOrThrow('5');
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(SessionModelError);
      if (e instanceof SessionModelError) expect(e.issues[0].code).toBe('NOT_OBJECT');
    }
  });
});

// --- Task 6: serialize / isPreset / presetsEqual ---------------------------

describe('serialize', () => {
  it('round-trips serialize → parse to a presetsEqual preset', () => {
    const p = createDefaultPreset();
    const round = parseOrThrow(serialize(p));
    expect(presetsEqual(p, round)).toBe(true);
  });

  it('preserves mod:null through the round-trip', () => {
    const p: Preset = {
      schemaVersion: 6,
      name: 'x',
      durationSec: 100,
      masterGain: 1,
      nodes: [{ t: 0, carrier: { value: 200 } }, { t: 10, beat: { value: 6, mod: null } }],
    };
    const s = serialize(p);
    expect(s).toContain('"mod":null');
    const round = parseOrThrow(s);
    expect(round.nodes[1].beat?.mod).toBeNull();
  });

  it('omits absent optional fields', () => {
    const s = serialize(createDefaultPreset());
    expect(s).not.toContain('transition');
    expect(s).not.toContain('"mod"');
    expect(s).not.toContain('waveform');
  });

  it('produces canonical key order regardless of input key order', () => {
    const a = validate({ schemaVersion: 6, name: 'x', durationSec: 100, masterGain: 0.8, nodes: [{ volume: { value: 1 }, beat: { value: 8 }, carrier: { value: 200 }, t: 0 }] });
    const b = validate({ nodes: [{ t: 0, carrier: { value: 200 }, beat: { value: 8 }, volume: { value: 1 } }], masterGain: 0.8, durationSec: 100, name: 'x', schemaVersion: 6 });
    expect(a.ok && b.ok).toBe(true);
    if (a.ok && b.ok) {
      const sa = serialize(a.preset);
      expect(sa).toBe(serialize(b.preset));
      expect(sa.startsWith('{"schemaVersion":6,"name":"x","durationSec":100,"masterGain":0.8,"nodes":[{"t":0,"carrier":')).toBe(true);
    }
  });

  it('selects 2-space indentation when pretty is true', () => {
    const s = serialize(createDefaultPreset(), { pretty: true });
    expect(s).toContain('\n  "name"');
  });

  it('throws SessionModelError on an invalid preset (never writes corrupt JSON)', () => {
    const bad = { schemaVersion: 6, name: '', durationSec: 100, masterGain: 1, nodes: [{ t: 0, carrier: { value: 200 } }] } as unknown as Preset;
    expect(() => serialize(bad)).toThrow(SessionModelError);
  });
});

describe('isPreset', () => {
  it('is true only when there is no error-severity issue', () => {
    expect(isPreset(createDefaultPreset())).toBe(true);
    expect(isPreset(mkPreset({ extra: 1 }))).toBe(true); // warning-only stays valid
    expect(isPreset(mkPreset({ name: '' }))).toBe(false);
    expect(isPreset(5)).toBe(false);
  });
});

describe('presetsEqual', () => {
  it('is key-order-independent', () => {
    const p1 = { schemaVersion: 6, name: 'x', durationSec: 100, masterGain: 0.8, nodes: [{ t: 0, carrier: { value: 200 }, beat: { value: 8 } }] } as Preset;
    const p2 = { nodes: [{ beat: { value: 8 }, carrier: { value: 200 }, t: 0 }], masterGain: 0.8, durationSec: 100, name: 'x', schemaVersion: 6 } as Preset;
    expect(presetsEqual(p1, p2)).toBe(true);
  });

  it('returns false for structurally different presets', () => {
    const p1 = createDefaultPreset();
    const p2 = clonePreset(p1);
    p2.nodes[0].beat = { value: 9 };
    expect(presetsEqual(p1, p2)).toBe(false);
  });

  it('throws SessionModelError when either argument is invalid', () => {
    const valid = createDefaultPreset();
    const invalid = { schemaVersion: 6, name: '', durationSec: 100, masterGain: 1, nodes: [{ t: 0, carrier: { value: 200 } }] } as unknown as Preset;
    expect(() => presetsEqual(valid, invalid)).toThrow(SessionModelError);
    expect(() => presetsEqual(invalid, valid)).toThrow(SessionModelError);
  });
});

// --- v3: spatial pan -------------------------------------------------------

describe('spatial pan (v3)', () => {
  it('accepts a node with a spatial pan + sweep modulator', () => {
    const r = validate(
      oneNode({ t: 0, carrier: { value: 200 }, spatial: { value: -0.5, mod: { shape: 'sine', periodSec: 12, depth: 0.6 } } }),
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.preset.nodes[0].spatial).toEqual({ value: -0.5, mod: { shape: 'sine', periodSec: 12, depth: 0.6 } });
    }
  });

  it('accepts inclusive spatial bounds [-1,1] and rejects just-outside', () => {
    expect(validate(oneNode({ t: 0, carrier: { value: 200 }, spatial: { value: -1 } })).ok).toBe(true);
    expect(validate(oneNode({ t: 0, carrier: { value: 200 }, spatial: { value: 1 } })).ok).toBe(true);
    expect(validate(oneNode({ t: 0, carrier: { value: 200 }, spatial: { value: -1.0001 } })).ok).toBe(false);
    expect(validate(oneNode({ t: 0, carrier: { value: 200 }, spatial: { value: 1.0001 } })).ok).toBe(false);
  });

  it('caps spatial mod depth at 1 and spatial steps at [-1,1]', () => {
    expect(validate(oneNode({ t: 0, carrier: { value: 200 }, spatial: { value: 0, mod: { depth: 1 } } })).ok).toBe(true);
    expect(validate(oneNode({ t: 0, carrier: { value: 200 }, spatial: { value: 0, mod: { depth: 1.5 } } })).ok).toBe(false);
    expect(validate(oneNode({ t: 0, carrier: { value: 200 }, spatial: { value: 0, mod: { steps: [-1, 0, 1], transition: 'jump' } } })).ok).toBe(true);
    expect(validate(oneNode({ t: 0, carrier: { value: 200 }, spatial: { value: 0, mod: { steps: [-1.5], transition: 'jump' } } })).ok).toBe(false);
  });

  it('round-trips spatial (incl. mod) through serialize → parse', () => {
    const p: Preset = {
      schemaVersion: 6,
      name: 'spatial',
      durationSec: 100,
      masterGain: 0.8,
      nodes: [{ t: 0, carrier: { value: 200 }, beat: { value: 8 }, spatial: { value: 0, mod: { shape: 'sine', periodSec: 12, depth: 0.6 } } }],
    };
    const round = parseOrThrow(serialize(p));
    expect(presetsEqual(p, round)).toBe(true);
    expect(round.nodes[0].spatial?.mod).toEqual({ shape: 'sine', periodSec: 12, depth: 0.6 });
  });

  it('keeps spatial absent in createDefaultPreset (centered)', () => {
    expect('spatial' in createDefaultPreset().nodes[0]).toBe(false);
  });
});

// --- v4: layers ------------------------------------------------------------

// A layer fixture helper: wrap a layers array into an otherwise-valid v4 preset.
function withLayers(layers: unknown, over: AnyObj = {}): AnyObj {
  return mkPreset({ layers, ...over });
}

// The interfaces.md §10 layered example — the happy-path fixture.
function layeredFixture(): Preset {
  return {
    schemaVersion: 6,
    name: 'Guided Drift',
    durationSec: 1800,
    masterGain: 0.8,
    nodes: [{ t: 0, carrier: { value: 200 }, beat: { value: 8 }, volume: { value: 1 } }],
    layers: [
      {
        id: 'open-bell',
        kind: 'tone',
        t: 0,
        source: { synth: { shape: 'sine', freqHz: 528, attackSec: 0.005, releaseSec: 3 } },
      },
      {
        id: 'rain',
        kind: 'ambiance',
        t: 0,
        loop: true,
        source: { clipId: 'clip_rain01' },
        gain: [
          { t: 0, value: 0 },
          { t: 8, value: 0.4 },
        ],
      },
      {
        id: 'guide',
        kind: 'voice',
        t: 60,
        source: { clipId: 'clip_breathe_es' },
        spatial: [
          { t: 0, value: -1, transition: 'linear' },
          { t: 6, value: 1 },
        ],
        duck: { toGain: 0.3, attackSec: 0.4, releaseSec: 1.5 },
      },
    ],
  };
}

describe('v4 layer types (type-level)', () => {
  it('exposes Layer / LayerKind / LayerSource / LanePoint / ToneSpec / DuckIntent shapes', () => {
    const kind: LayerKind = 'voice';
    const synthSrc: LayerSource = { synth: { shape: 'sine', freqHz: 440, attackSec: 0, releaseSec: 1 } };
    const clipSrc: LayerSource = { clipId: 'c1' };
    const tone: ToneSpec = { shape: 'triangle', freqHz: 880, attackSec: 0.1, releaseSec: 0.5 };
    const lane: LanePoint = { t: 0, value: 0.5 };
    const laneT: LanePoint = { t: 1, value: 1, transition: 'exp' };
    const duck: DuckIntent = { toGain: 0.2, attackSec: 0.3, releaseSec: 1 };
    const layer: Layer = { id: 'x', kind, source: clipSrc, t: 0, loop: true, gain: [lane, laneT], duck };
    const preset: Preset = { ...createDefaultPreset(), layers: [layer] };
    expect(synthSrc).toBeDefined();
    expect(tone.freqHz).toBe(880);
    expect(preset.layers?.[0].id).toBe('x');
  });
});

describe('v4 layers — happy path & round-trip', () => {
  it('accepts a fully-valid layered preset (synth tone + looping ambiance + voice clip)', () => {
    const r = validate(layeredFixture());
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.issues).toEqual([]);
      expect(r.preset.layers).toHaveLength(3);
    }
  });

  it('round-trips the layered example through serialize → parse as presetsEqual', () => {
    const p = layeredFixture();
    const round = parseOrThrow(serialize(p));
    expect(presetsEqual(p, round)).toBe(true);
    // Discriminant + lane points + present/absent loop preserved.
    expect(round.layers?.[0].source).toEqual({ synth: { shape: 'sine', freqHz: 528, attackSec: 0.005, releaseSec: 3 } });
    expect(round.layers?.[1].source).toEqual({ clipId: 'clip_rain01' });
    expect(round.layers?.[1].loop).toBe(true);
    expect('loop' in (round.layers![0] as object)).toBe(false);
    expect(round.layers?.[2].duck).toEqual({ toGain: 0.3, attackSec: 0.4, releaseSec: 1.5 });
  });

  it('normalizes layer / lane / source / tone / duck keys into canonical order', () => {
    const scrambled = withLayers([
      {
        duck: { releaseSec: 1, toGain: 0.2, attackSec: 0.3 },
        spatial: [{ value: 0.5, t: 1, transition: 'linear' }],
        t: 0,
        source: { synth: { releaseSec: 2, attackSec: 0, freqHz: 440, shape: 'sine' } },
        kind: 'voice',
        id: 'a',
      },
    ]);
    const r = validate(scrambled);
    expect(r.ok).toBe(true);
    if (r.ok) {
      const json = JSON.stringify(r.preset.layers);
      expect(json).toContain('{"id":"a","kind":"voice","source":{"synth":{"shape":"sine","freqHz":440,"attackSec":0,"releaseSec":2}},"t":0');
      expect(json).toContain('"spatial":[{"t":1,"value":0.5,"transition":"linear"}]');
      expect(json).toContain('"duck":{"toGain":0.2,"attackSec":0.3,"releaseSec":1}');
    }
  });

  it('keeps source-discriminant exclusive: only the present variant materializes', () => {
    const r = validate(withLayers([{ id: 'a', kind: 'tone', t: 0, source: { clipId: 'c1' } }]));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.preset.layers?.[0].source).toEqual({ clipId: 'c1' });
  });
});

describe('v4 layers — container & structure', () => {
  it('treats absent layers as a pure-binaural preset (no key created)', () => {
    const r = validate(mkPreset());
    expect(r.ok).toBe(true);
    if (r.ok) expect('layers' in r.preset).toBe(false);
  });

  it('preserves an empty top-level layers:[] as an explicit author choice', () => {
    const r = validate(withLayers([]));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.preset.layers).toEqual([]);
      expect('layers' in r.preset).toBe(true);
    }
  });

  it('flags a non-array layers as LAYERS_NOT_ARRAY but still checks siblings', () => {
    const r = validate(withLayers({}, { name: '' }));
    expect(r.ok).toBe(false);
    const c = codes(r);
    expect(c).toContain('LAYERS_NOT_ARRAY');
    expect(c).toContain('NAME_EMPTY'); // sibling check still ran
  });

  it('flags a non-object layer and still checks sibling layers', () => {
    const r = validate(
      withLayers([5, { id: 'b', kind: 'tone', t: 0, source: { clipId: 'c1' } }]),
    );
    expect(r.ok).toBe(false);
    const c = codes(r);
    expect(c).toContain('LAYER_NOT_OBJECT');
    // the sibling layer is valid → no further layer error from it.
  });
});

describe('v4 layers — every layer/source/tone error code is reachable', () => {
  const L = (over: AnyObj): AnyObj => ({ id: 'L', kind: 'tone', t: 0, source: { clipId: 'c1' }, ...over });
  const cases: Array<[string, unknown, ValidationCode]> = [
    ['layers not array', withLayers({}), 'LAYERS_NOT_ARRAY'],
    ['layer not object', withLayers([5]), 'LAYER_NOT_OBJECT'],
    ['id not string', withLayers([L({ id: 5 })]), 'LAYER_ID_NOT_STRING'],
    ['id empty', withLayers([L({ id: '  ' })]), 'LAYER_ID_EMPTY'],
    ['id duplicate', withLayers([L({ id: 'dup' }), L({ id: 'dup' })]), 'LAYER_ID_DUPLICATE'],
    ['kind invalid', withLayers([L({ kind: 'drone' })]), 'LAYER_KIND_INVALID'],
    ['source absent', withLayers([{ id: 'L', kind: 'tone', t: 0 }]), 'LAYER_SOURCE_INVALID'],
    ['source non-object', withLayers([L({ source: 5 })]), 'LAYER_SOURCE_INVALID'],
    ['source neither', withLayers([L({ source: {} })]), 'LAYER_SOURCE_INVALID'],
    ['source both', withLayers([L({ source: { synth: { shape: 'sine', freqHz: 440, attackSec: 0, releaseSec: 1 }, clipId: 'c1' } })]), 'LAYER_SOURCE_INVALID'],
    ['clipId not string', withLayers([L({ source: { clipId: 5 } })]), 'LAYER_CLIP_ID_NOT_STRING'],
    ['clipId empty', withLayers([L({ source: { clipId: '  ' } })]), 'LAYER_CLIP_ID_EMPTY'],
    ['synth not object', withLayers([L({ source: { synth: 5 } })]), 'LAYER_SOURCE_INVALID'],
    ['tone shape invalid', withLayers([L({ source: { synth: { shape: 'noise', freqHz: 440, attackSec: 0, releaseSec: 1 } } })]), 'TONE_SHAPE_INVALID'],
    ['tone freq not finite', withLayers([L({ source: { synth: { shape: 'sine', freqHz: NaN, attackSec: 0, releaseSec: 1 } } })]), 'TONE_FREQ_NOT_FINITE'],
    ['tone freq out of range', withLayers([L({ source: { synth: { shape: 'sine', freqHz: 19, attackSec: 0, releaseSec: 1 } } })]), 'TONE_FREQ_OUT_OF_RANGE'],
    ['tone attack not finite', withLayers([L({ source: { synth: { shape: 'sine', freqHz: 440, attackSec: Infinity, releaseSec: 1 } } })]), 'TONE_ATTACK_NOT_FINITE'],
    ['tone attack negative', withLayers([L({ source: { synth: { shape: 'sine', freqHz: 440, attackSec: -1, releaseSec: 1 } } })]), 'TONE_ATTACK_NEGATIVE'],
    ['tone release not finite', withLayers([L({ source: { synth: { shape: 'sine', freqHz: 440, attackSec: 0, releaseSec: NaN } } })]), 'TONE_RELEASE_NOT_FINITE'],
    ['tone release negative', withLayers([L({ source: { synth: { shape: 'sine', freqHz: 440, attackSec: 0, releaseSec: -2 } } })]), 'TONE_RELEASE_NEGATIVE'],
    ['layer t not finite', withLayers([L({ t: 'x' })]), 'LAYER_T_NOT_FINITE'],
    ['layer t negative', withLayers([L({ t: -1 })]), 'LAYER_T_NEGATIVE'],
    ['layer t exceeds duration', withLayers([L({ t: 200 })], { durationSec: 100 }), 'LAYER_T_EXCEEDS_DURATION'],
    ['layer loop not boolean', withLayers([L({ loop: 'yes' })]), 'LAYER_LOOP_NOT_BOOLEAN'],
    ['lane not array', withLayers([L({ gain: {} })]), 'LANE_NOT_ARRAY'],
    ['lane point not object', withLayers([L({ gain: [5] })]), 'LANE_POINT_NOT_OBJECT'],
    ['lane t not finite', withLayers([L({ gain: [{ t: NaN, value: 0.5 }] })]), 'LANE_T_NOT_FINITE'],
    ['lane t negative', withLayers([L({ gain: [{ t: -1, value: 0.5 }] })]), 'LANE_T_NEGATIVE'],
    ['lane value not finite', withLayers([L({ gain: [{ t: 0, value: NaN }] })]), 'LANE_VALUE_NOT_FINITE'],
    ['gain value out of range', withLayers([L({ gain: [{ t: 0, value: 1.1 }] })]), 'LANE_VALUE_OUT_OF_RANGE'],
    ['spatial value out of range', withLayers([L({ spatial: [{ t: 0, value: -1.1 }] })]), 'LANE_VALUE_OUT_OF_RANGE'],
    ['lane transition invalid', withLayers([L({ gain: [{ t: 0, value: 0.5, transition: 'wobble' }] })]), 'LANE_TRANSITION_INVALID'],
    ['lane not sorted', withLayers([L({ gain: [{ t: 0, value: 0.5 }, { t: 5, value: 0.5 }, { t: 3, value: 0.5 }] })]), 'LANE_NOT_SORTED'],
    ['lane duplicate t', withLayers([L({ gain: [{ t: 0, value: 0.5 }, { t: 5, value: 0.5 }, { t: 5, value: 0.5 }] })]), 'LANE_DUPLICATE_T'],
    ['lane exp through zero', withLayers([L({ gain: [{ t: 0, value: 0.5, transition: 'exp' }, { t: 5, value: 0 }] })]), 'LANE_EXP_THROUGH_ZERO'],
    ['duck not object', withLayers([L({ kind: 'voice', duck: 5 })]), 'DUCK_NOT_OBJECT'],
    ['duck toGain not finite', withLayers([L({ kind: 'voice', duck: { toGain: NaN, attackSec: 0, releaseSec: 1 } })]), 'DUCK_TO_GAIN_NOT_FINITE'],
    ['duck toGain out of range', withLayers([L({ kind: 'voice', duck: { toGain: 1.5, attackSec: 0, releaseSec: 1 } })]), 'DUCK_TO_GAIN_OUT_OF_RANGE'],
    ['duck attack not finite', withLayers([L({ kind: 'voice', duck: { toGain: 0.3, attackSec: Infinity, releaseSec: 1 } })]), 'DUCK_ATTACK_NOT_FINITE'],
    ['duck attack negative', withLayers([L({ kind: 'voice', duck: { toGain: 0.3, attackSec: -1, releaseSec: 1 } })]), 'DUCK_ATTACK_NEGATIVE'],
    ['duck release not finite', withLayers([L({ kind: 'voice', duck: { toGain: 0.3, attackSec: 0, releaseSec: NaN } })]), 'DUCK_RELEASE_NOT_FINITE'],
    ['duck release negative', withLayers([L({ kind: 'voice', duck: { toGain: 0.3, attackSec: 0, releaseSec: -1 } })]), 'DUCK_RELEASE_NEGATIVE'],
  ];

  it.each(cases)('flags %s as %s', (_desc, input, code) => {
    const r = validate(input);
    expect(r.ok).toBe(false);
    expect(codes(r)).toContain(code);
  });
});

describe('v4 layers — verbatim message templates & paths', () => {
  function findIn(input: unknown, code: ValidationCode): ValidationIssue | undefined {
    return validate(input).issues.find((i) => i.code === code);
  }
  const L = (over: AnyObj): AnyObj => ({ id: 'L', kind: 'tone', t: 0, source: { clipId: 'c1' }, ...over });

  it('uses documented messages and layers[i]... paths', () => {
    expect(findIn(withLayers({}), 'LAYERS_NOT_ARRAY')?.message).toBe('"layers" must be an array');
    expect(findIn(withLayers([5]), 'LAYER_NOT_OBJECT')?.path).toBe('layers[0]');
    expect(findIn(withLayers([L({ kind: 'x' })]), 'LAYER_KIND_INVALID')?.message).toBe(
      'Layer "kind" must be one of tone, ambiance, voice',
    );
    expect(findIn(withLayers([L({ source: {} })]), 'LAYER_SOURCE_INVALID')?.message).toBe(
      'Layer "source" must be exactly one of { synth } or { clipId }',
    );
    const dup = findIn(withLayers([L({ id: 'dup' }), L({ id: 'dup' })]), 'LAYER_ID_DUPLICATE');
    expect(dup?.path).toBe('layers[1].id');
    expect(dup?.message).toBe('Duplicate layer id "dup"; layer ids must be unique');
    const freq = findIn(withLayers([L({ source: { synth: { shape: 'sine', freqHz: 5, attackSec: 0, releaseSec: 1 } } })]), 'TONE_FREQ_OUT_OF_RANGE');
    expect(freq?.path).toBe('layers[0].source.synth.freqHz');
    expect(freq?.message).toBe('"source.synth.freqHz" must be within [20, 20000], got 5');
    const gv = findIn(withLayers([L({ gain: [{ t: 0, value: 1.1 }] })]), 'LANE_VALUE_OUT_OF_RANGE');
    expect(gv?.path).toBe('layers[0].gain[0].value');
    expect(gv?.message).toBe('"gain.value" must be within [0, 1], got 1.1');
    const sv = findIn(withLayers([L({ spatial: [{ t: 0, value: -1.1 }] })]), 'LANE_VALUE_OUT_OF_RANGE');
    expect(sv?.message).toBe('"spatial.value" must be within [-1, 1], got -1.1');
    const exp = findIn(withLayers([L({ gain: [{ t: 0, value: 0.5, transition: 'exp' }, { t: 5, value: 0 }] })]), 'LANE_EXP_THROUGH_ZERO');
    expect(exp?.path).toBe('layers[0].gain[0].transition');
    expect(exp?.message).toBe(
      '"exp" transition cannot ramp to or across zero (0.5 → 0); use linear/smooth or keep both endpoints the same nonzero sign',
    );
    expect(findIn(withLayers([L({ kind: 'voice', duck: 5 })]), 'DUCK_NOT_OBJECT')?.message).toBe(
      '"duck" must be an object with "toGain", "attackSec", and "releaseSec"',
    );
  });
});

describe('v4 layers — boundary nuances', () => {
  const L = (over: AnyObj): AnyObj => ({ id: 'L', kind: 'tone', t: 0, source: { clipId: 'c1' }, ...over });

  it('accepts kind/source independence (tone-kind backed by a clipId)', () => {
    expect(validate(withLayers([{ id: 'a', kind: 'tone', t: 0, source: { clipId: 'c1' } }])).ok).toBe(true);
    expect(validate(withLayers([{ id: 'a', kind: 'ambiance', t: 0, source: { synth: { shape: 'sine', freqHz: 440, attackSec: 0, releaseSec: 1 } } }])).ok).toBe(true);
  });

  it('accepts a clipId referencing an absent clip (existence not validated, D-023)', () => {
    expect(validate(withLayers([{ id: 'a', kind: 'voice', t: 0, source: { clipId: 'nope_missing' } }])).ok).toBe(true);
  });

  it('accepts inclusive toneFreq bounds [20,20000] and rejects just-outside', () => {
    const tone = (freqHz: number): AnyObj => L({ source: { synth: { shape: 'sine', freqHz, attackSec: 0, releaseSec: 1 } } });
    expect(validate(withLayers([tone(20)])).ok).toBe(true);
    expect(validate(withLayers([tone(20000)])).ok).toBe(true);
    expect(validate(withLayers([tone(19.999)])).ok).toBe(false);
    expect(validate(withLayers([tone(20000.001)])).ok).toBe(false);
  });

  it('accepts 0 envelope times and rejects negatives', () => {
    const env = (attackSec: number, releaseSec: number): AnyObj => L({ source: { synth: { shape: 'sine', freqHz: 440, attackSec, releaseSec } } });
    expect(validate(withLayers([env(0, 0)])).ok).toBe(true);
    expect(validate(withLayers([env(-0.001, 0)])).ok).toBe(false);
  });

  it('accepts layer t === durationSec and gates LAYER_T_EXCEEDS_DURATION on a valid durationSec', () => {
    expect(validate(withLayers([L({ t: 100 })], { durationSec: 100 })).ok).toBe(true);
    // bad durationSec suppresses the single bound but still reports finite/negative t.
    const r = validate(withLayers([L({ t: 50 })], { durationSec: -1 }));
    expect(r.ok).toBe(false);
    const c = codes(r);
    expect(c).toContain('DURATION_NOT_POSITIVE');
    expect(c).not.toContain('LAYER_T_EXCEEDS_DURATION');
  });

  it('accepts a lane that begins after the layer start (relative t, no zero-point requirement)', () => {
    expect(validate(withLayers([L({ gain: [{ t: 5, value: 0.5 }, { t: 10, value: 1 }] })])).ok).toBe(true);
  });

  it('accepts a single lane point with no ordering to check', () => {
    expect(validate(withLayers([L({ gain: [{ t: 3, value: 0.7 }] })])).ok).toBe(true);
  });

  it('does NOT sort lanes — an out-of-order lane is rejected, not repaired', () => {
    const r = validate(withLayers([L({ gain: [{ t: 0, value: 0.5 }, { t: 8, value: 1 }, { t: 4, value: 0.2 }] })]));
    expect(r.ok).toBe(false);
    expect(codes(r)).toContain('LANE_NOT_SORTED');
  });

  it('rejects an exp spatial sweep that crosses center (+1 → −1)', () => {
    expect(validate(withLayers([L({ spatial: [{ t: 0, value: 1, transition: 'exp' }, { t: 5, value: -1 }] })])).ok).toBe(false);
  });

  it('accepts exp on a lane last point (no successor, no ramp)', () => {
    expect(validate(withLayers([L({ gain: [{ t: 0, value: 0.5 }, { t: 5, value: 0, transition: 'exp' }] })])).ok).toBe(true);
  });

  it('excludes a non-finite-t lane point from ordering/exp but still reports it', () => {
    const r = validate(withLayers([L({ gain: [{ t: 0, value: 0.5, transition: 'exp' }, { t: NaN, value: 0 }, { t: 5, value: 0.5 }] })]));
    expect(r.ok).toBe(false);
    const c = codes(r);
    expect(c).toContain('LANE_T_NOT_FINITE');
    expect(c).not.toContain('LANE_NOT_SORTED');
    expect(c).not.toContain('LANE_EXP_THROUGH_ZERO');
  });

  it('validates duck independent of kind (a tone layer may carry a duck)', () => {
    expect(validate(withLayers([L({ kind: 'tone', duck: { toGain: 0.5, attackSec: 0.1, releaseSec: 0.2 } })])).ok).toBe(true);
  });

  it('accepts duck toGain 0 and 1 and 0 ramp times', () => {
    expect(validate(withLayers([L({ kind: 'voice', duck: { toGain: 0, attackSec: 0, releaseSec: 0 } })])).ok).toBe(true);
    expect(validate(withLayers([L({ kind: 'voice', duck: { toGain: 1, attackSec: 0, releaseSec: 0 } })])).ok).toBe(true);
  });

  it('drops unknown layer / synth / duck keys with UNKNOWN_FIELD warnings', () => {
    const r = validate(
      withLayers([
        {
          id: 'a',
          kind: 'voice',
          t: 0,
          source: { synth: { shape: 'sine', freqHz: 440, attackSec: 0, releaseSec: 1, decaySec: 9 } },
          duck: { toGain: 0.3, attackSec: 0, releaseSec: 1, holdSec: 2 },
          bonus: 'x',
        },
      ]),
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      const paths = r.issues.filter((i) => i.code === 'UNKNOWN_FIELD').map((i) => i.path);
      expect(paths).toContain('layers[0].bonus');
      expect(paths).toContain('layers[0].source.synth.decaySec');
      expect(paths).toContain('layers[0].duck.holdSec');
    }
  });
});

describe('v4 layers — normalization edge cases', () => {
  const L = (over: AnyObj): AnyObj => ({ id: 'L', kind: 'tone', t: 0, source: { clipId: 'c1' }, ...over });

  it('drops empty gain/spatial lanes so {gain:[]} round-trips equal to an absent gain', () => {
    const withEmpty = validate(withLayers([L({ gain: [], spatial: [] })]));
    const withoutLanes = validate(withLayers([L({})]));
    expect(withEmpty.ok && withoutLanes.ok).toBe(true);
    if (withEmpty.ok && withoutLanes.ok) {
      expect('gain' in (withEmpty.preset.layers![0] as object)).toBe(false);
      expect('spatial' in (withEmpty.preset.layers![0] as object)).toBe(false);
      expect(JSON.stringify(withEmpty.preset.layers)).toBe(JSON.stringify(withoutLanes.preset.layers));
    }
  });

  it('keeps absent loop/duck absent on the normalized clone', () => {
    const r = validate(withLayers([L({})]));
    expect(r.ok).toBe(true);
    if (r.ok) {
      const layer = r.preset.layers![0] as object;
      expect('loop' in layer).toBe(false);
      expect('duck' in layer).toBe(false);
    }
  });

  it('never mutates the input layered preset', () => {
    const input = layeredFixture();
    const snapshot = structuredClone(input);
    validate(input);
    expect(input).toEqual(snapshot);
  });

  it('reports an invalid node AND an invalid layer in one pass (collect-all)', () => {
    const r = validate(
      mkPreset({
        nodes: [{ t: 0, carrier: { value: 5 } }],
        layers: [{ id: 'a', kind: 'wrong', t: 0, source: { clipId: 'c1' } }],
      }),
    );
    expect(r.ok).toBe(false);
    const c = codes(r);
    expect(c).toContain('PARAM_VALUE_OUT_OF_RANGE'); // node issue
    expect(c).toContain('LAYER_KIND_INVALID'); // layer issue
    // node issues precede layer issues (deterministic ordering).
    const nodeIdx = r.issues.findIndex((i) => i.code === 'PARAM_VALUE_OUT_OF_RANGE');
    const layerIdx = r.issues.findIndex((i) => i.code === 'LAYER_KIND_INVALID');
    expect(nodeIdx).toBeLessThan(layerIdx);
  });
});

describe('v4 layers — migration', () => {
  it('migrates a v2 preset → v6 (migratedFrom 2, no spatial, no layers)', () => {
    const r = parse('{"schemaVersion":2,"name":"x","durationSec":100,"masterGain":0.8,"nodes":[{"t":0,"carrier":{"value":200}}]}');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.preset.schemaVersion).toBe(6);
      expect(r.migratedFrom).toBe(2);
      expect('layers' in r.preset).toBe(false);
      expect('spatial' in r.preset.nodes[0]).toBe(false);
    }
  });

  it('migrates a v3 preset → v6 (migratedFrom 3, layers absent)', () => {
    const r = parse('{"schemaVersion":3,"name":"x","durationSec":100,"masterGain":0.8,"nodes":[{"t":0,"carrier":{"value":200}}]}');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.preset.schemaVersion).toBe(6);
      expect(r.migratedFrom).toBe(3);
      expect('layers' in r.preset).toBe(false);
    }
  });

  it('passes a v6 layered preset through with migratedFrom null', () => {
    const r = parse(serialize(layeredFixture()));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.migratedFrom).toBeNull();
      expect(r.preset.layers).toHaveLength(3);
    }
  });

  it('gates schemaVersion 7 (too new) and 1 (too old)', () => {
    expect(notOkCode(parse('{"schemaVersion":7,"name":"x","durationSec":1,"masterGain":1,"nodes":[]}'))).toBe('SCHEMA_TOO_NEW');
    expect(notOkCode(parse('{"schemaVersion":1,"name":"x","durationSec":1,"masterGain":1,"nodes":[]}'))).toBe('SCHEMA_TOO_OLD');
  });
});

describe('v4 layers — sparse round-trip guarantees', () => {
  it('keeps an absent layers absent through serialize → parse', () => {
    const p = createDefaultPreset();
    const round = parseOrThrow(serialize(p));
    expect('layers' in round).toBe(false);
    expect(presetsEqual(p, round)).toBe(true);
  });

  it('keeps a present empty layers:[] through serialize → parse', () => {
    const p: Preset = { ...createDefaultPreset(), layers: [] };
    const s = serialize(p);
    expect(s).toContain('"layers":[]');
    const round = parseOrThrow(s);
    expect(round.layers).toEqual([]);
    expect(presetsEqual(p, round)).toBe(true);
  });

  it('treats a layer with {gain:[]} as equal to one with gain omitted under presetsEqual', () => {
    const withEmpty: Preset = {
      ...createDefaultPreset(),
      layers: [{ id: 'a', kind: 'tone', t: 0, source: { clipId: 'c1' }, gain: [] }],
    };
    const without: Preset = {
      ...createDefaultPreset(),
      layers: [{ id: 'a', kind: 'tone', t: 0, source: { clipId: 'c1' } }],
    };
    expect(presetsEqual(withEmpty, without)).toBe(true);
  });

  it('round-trips a present duck and keeps an absent duck absent', () => {
    const p: Preset = {
      ...createDefaultPreset(),
      layers: [
        { id: 'cue', kind: 'voice', t: 0, source: { clipId: 'c1' }, duck: { toGain: 0.2, attackSec: 0.3, releaseSec: 1 } },
        { id: 'amb', kind: 'ambiance', t: 0, source: { clipId: 'c2' }, loop: true },
      ],
    };
    const round = parseOrThrow(serialize(p));
    expect(round.layers?.[0].duck).toEqual({ toGain: 0.2, attackSec: 0.3, releaseSec: 1 });
    expect('duck' in (round.layers![1] as object)).toBe(false);
    expect(presetsEqual(p, round)).toBe(true);
  });
});

// --- v6: multi-voice (voices[]) --------------------------------------------
// Each voice is an independent generator stacked on the session; its `nodes` reuse the SAME
// shape + validation as the top-level (primary) nodes (multi-voice-architecture §1). The
// container/identity/gain/cap/separation surface mints the NEW VOICE_*/VOICES_* codes (§1.2).

// A well-separated extra voice (carrier 400 vs the mkPreset primary's 200 → ratio 2.0,
// gap 200 Hz) — clears the VOICES_CARRIER_TOO_CLOSE advisory by default.
function mkVoice(over: AnyObj = {}): AnyObj {
  return { id: 'v1', nodes: [{ t: 0, carrier: { value: 400 }, beat: { value: 6 } }], ...over };
}

// Wrap a voices value onto an otherwise-valid single-voice preset.
function withVoices(voices: unknown, over: AnyObj = {}): AnyObj {
  return mkPreset({ voices, ...over });
}

describe('v6 multi-voice — constants', () => {
  it('RANGES.voiceGain caps per-voice trim at [0,1]', () => {
    expect(RANGES.voiceGain).toEqual({ min: 0, max: 1 });
  });

  it('LIMITS carries the v6 voice caps (1 + voices.length ≤ 4; ≤ 8 pulse worklets)', () => {
    expect(LIMITS.maxVoices).toBe(4);
    expect(LIMITS.maxPulseWorklets).toBe(8);
  });

  it('DEFAULTS.voiceGain is 1 (eval-time carry, never baked)', () => {
    expect(DEFAULTS.voiceGain).toBe(1);
  });
});

describe('v6 multi-voice — Voice type (type-level)', () => {
  it('exposes the Voice shape and Preset.voices', () => {
    const voice: Voice = { id: 'iso', name: 'Gamma', gain: 0.7, nodes: [{ t: 0, carrier: { value: 432 } }] };
    const minimal: Voice = { id: 'beta', nodes: [{ t: 0, carrier: { value: 700 } }] };
    const preset: Preset = { ...createDefaultPreset(), voices: [voice, minimal] };
    expect(preset.voices?.[0].id).toBe('iso');
    expect(preset.voices?.[1].gain).toBeUndefined();
  });
});

describe('voiceView', () => {
  it('projects a voice\'s nodes onto the session-global fields, dropping layers/voices', () => {
    const preset = layeredFixture();
    const voiceNodes: TimeNode[] = [{ t: 0, carrier: { value: 400 }, beat: { value: 0 } }];
    const view = voiceView(preset, voiceNodes);
    expect(view).toEqual({
      schemaVersion: 6,
      name: preset.name,
      durationSec: preset.durationSec,
      masterGain: preset.masterGain,
      nodes: voiceNodes,
    });
    expect('layers' in view).toBe(false);
    expect('voices' in view).toBe(false);
  });

  it('shares the passed nodes by reference (no copy) so edits stay in sync', () => {
    const preset = createDefaultPreset();
    expect(voiceView(preset, preset.nodes).nodes).toBe(preset.nodes);
  });

  it('returns a Preset that itself validates (render == playback by construction)', () => {
    const view = voiceView(createDefaultPreset(), [{ t: 0, carrier: { value: 400 }, beat: { value: 6 } }]);
    expect(validate(view).ok).toBe(true);
  });
});

describe('v6 multi-voice — happy path & normalization', () => {
  it('accepts a preset with a well-separated isochronic extra voice (no issues)', () => {
    const r = validate(withVoices([
      { id: 'iso', nodes: [{ t: 0, carrier: { value: 432 }, beat: { value: 0 }, volume: { value: 1, mod: { shape: 'pulse', periodSec: 0.025, depth: 0.8 } } }] },
    ]));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.issues).toEqual([]);
      expect(r.preset.voices).toHaveLength(1);
    }
  });

  it('treats absent voices as single-voice (no key created on the normalized clone)', () => {
    const r = validate(mkPreset());
    expect(r.ok).toBe(true);
    if (r.ok) expect('voices' in r.preset).toBe(false);
  });

  it('preserves an explicit empty voices:[] (present, like layers:[])', () => {
    const r = validate(withVoices([]));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.preset.voices).toEqual([]);
      expect('voices' in r.preset).toBe(true);
    }
  });

  it('normalizes voice keys into canonical order id, name, gain, nodes', () => {
    const r = validate(withVoices([{ nodes: [{ carrier: { value: 400 }, t: 0 }], gain: 0.5, name: 'B', id: 'b' }]));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(JSON.stringify(r.preset.voices)).toContain(
        '{"id":"b","name":"B","gain":0.5,"nodes":[{"t":0,"carrier":{"value":400}}]}',
      );
    }
  });

  it('keeps absent name/gain absent on the normalized voice (sparse)', () => {
    const r = validate(withVoices([mkVoice()]));
    expect(r.ok).toBe(true);
    if (r.ok) {
      const v = r.preset.voices![0] as object;
      expect('name' in v).toBe(false);
      expect('gain' in v).toBe(false);
    }
  });

  it('never mutates the input multi-voice preset', () => {
    const input = withVoices([mkVoice({ gain: 0.5, name: 'B' })]);
    const snapshot = structuredClone(input);
    validate(input);
    expect(input).toEqual(snapshot);
  });
});

describe('v6 multi-voice — every container/identity/gain/cap code is reachable', () => {
  const V = (over: AnyObj): AnyObj => ({ id: 'V', nodes: [{ t: 0, carrier: { value: 400 } }], ...over });
  const cases: Array<[string, unknown, ValidationCode]> = [
    ['voices not array', withVoices({}), 'VOICES_NOT_ARRAY'],
    ['voice not object', withVoices([5]), 'VOICE_NOT_OBJECT'],
    ['id not string', withVoices([V({ id: 5 })]), 'VOICE_ID_NOT_STRING'],
    ['id empty (whitespace)', withVoices([V({ id: '  ' })]), 'VOICE_ID_EMPTY'],
    ['id duplicate', withVoices([V({ id: 'dup' }), V({ id: 'dup', nodes: [{ t: 0, carrier: { value: 700 } }] })]), 'VOICE_ID_DUPLICATE'],
    ['gain not finite', withVoices([V({ gain: NaN })]), 'VOICE_GAIN_NOT_FINITE'],
    ['gain out of range', withVoices([V({ gain: 1.5 })]), 'VOICE_GAIN_OUT_OF_RANGE'],
    ['nodes not array', withVoices([V({ nodes: {} })]), 'VOICE_NODES_NOT_ARRAY'],
    ['nodes empty', withVoices([V({ nodes: [] })]), 'VOICE_NODES_EMPTY'],
    ['too many voices', withVoices([
      V({ id: 'a', nodes: [{ t: 0, carrier: { value: 300 } }] }),
      V({ id: 'b', nodes: [{ t: 0, carrier: { value: 450 } }] }),
      V({ id: 'c', nodes: [{ t: 0, carrier: { value: 600 } }] }),
      V({ id: 'd', nodes: [{ t: 0, carrier: { value: 900 } }] }),
    ]), 'VOICES_TOO_MANY'],
  ];

  it.each(cases)('flags %s as %s', (_desc, input, code) => {
    const r = validate(input);
    expect(r.ok).toBe(false);
    expect(codes(r)).toContain(code);
  });
});

describe('v6 multi-voice — per-voice nodes reuse the node contract at voices[k].nodes paths', () => {
  it('flags an out-of-range carrier inside a voice at voices[0].nodes[0].carrier.value', () => {
    const r = validate(withVoices([{ id: 'a', nodes: [{ t: 0, carrier: { value: 5 } }] }]));
    expect(r.ok).toBe(false);
    const issue = r.issues.find((i) => i.code === 'PARAM_VALUE_OUT_OF_RANGE');
    expect(issue?.path).toBe('voices[0].nodes[0].carrier.value');
    // message stays param-relative (not path-prefixed), mirroring spatial's reuse.
    expect(issue?.message).toBe('"carrier.value" must be within [20, 1000], got 5');
  });

  it('requires carrier at t=0 inside a voice (CARRIER_NOT_AT_START at voices[0].nodes[0])', () => {
    const r = validate(withVoices([{ id: 'a', nodes: [{ t: 0, beat: { value: 8 } }] }]));
    expect(r.ok).toBe(false);
    expect(r.issues.find((i) => i.code === 'CARRIER_NOT_AT_START')?.path).toBe('voices[0].nodes[0]');
  });

  it('enforces unique t and t ≤ durationSec per voice', () => {
    const dup = validate(withVoices([{ id: 'a', nodes: [{ t: 0, carrier: { value: 400 } }, { t: 5, beat: { value: 6 } }, { t: 5, beat: { value: 4 } }] }]));
    expect(codes(dup)).toContain('NODES_DUPLICATE_T');
    const exceeds = validate(withVoices([{ id: 'a', nodes: [{ t: 0, carrier: { value: 400 } }, { t: 200, beat: { value: 6 } }] }], { durationSec: 100 }));
    expect(codes(exceeds)).toContain('NODE_T_EXCEEDS_DURATION');
  });

  it('reports a primary-node error AND a voice-node error in one pass (collect-all)', () => {
    const r = validate(mkPreset({
      nodes: [{ t: 0, carrier: { value: 5 } }],
      voices: [{ id: 'a', nodes: [{ t: 0, carrier: { value: 9 } }] }],
    }));
    expect(r.ok).toBe(false);
    const paths = r.issues.filter((i) => i.code === 'PARAM_VALUE_OUT_OF_RANGE').map((i) => i.path);
    expect(paths).toContain('nodes[0].carrier.value');
    expect(paths).toContain('voices[0].nodes[0].carrier.value');
  });
});

describe('v6 multi-voice — verbatim container/identity/gain messages', () => {
  function findIn(input: unknown, code: ValidationCode): ValidationIssue | undefined {
    return validate(input).issues.find((i) => i.code === code);
  }
  const V = (over: AnyObj): AnyObj => ({ id: 'V', nodes: [{ t: 0, carrier: { value: 400 } }], ...over });

  it('uses documented messages and voices[i]… paths', () => {
    expect(findIn(withVoices({}), 'VOICES_NOT_ARRAY')?.message).toBe('"voices" must be an array');
    expect(findIn(withVoices([5]), 'VOICE_NOT_OBJECT')?.path).toBe('voices[0]');
    expect(findIn(withVoices([5]), 'VOICE_NOT_OBJECT')?.message).toBe('Voice must be an object');
    const dup = findIn(withVoices([V({ id: 'dup' }), V({ id: 'dup', nodes: [{ t: 0, carrier: { value: 700 } }] })]), 'VOICE_ID_DUPLICATE');
    expect(dup?.path).toBe('voices[1].id');
    expect(dup?.message).toBe('Duplicate voice id "dup"; voice ids must be unique');
    expect(findIn(withVoices([V({ gain: 1.5 })]), 'VOICE_GAIN_OUT_OF_RANGE')?.message).toBe('"gain" must be within [0, 1], got 1.5');
    const many = findIn(withVoices([
      V({ id: 'a', nodes: [{ t: 0, carrier: { value: 300 } }] }),
      V({ id: 'b', nodes: [{ t: 0, carrier: { value: 450 } }] }),
      V({ id: 'c', nodes: [{ t: 0, carrier: { value: 600 } }] }),
      V({ id: 'd', nodes: [{ t: 0, carrier: { value: 900 } }] }),
    ]), 'VOICES_TOO_MANY');
    expect(many?.path).toBe('voices');
    expect(many?.message).toBe('A session may have at most 4 voices (1 primary + 3 additional), got 5');
  });
});

describe('v6 multi-voice — carrier-separation advisory (warning, ok stays true)', () => {
  it('warns VOICES_CARRIER_TOO_CLOSE when two t=0 carriers are within 30 Hz', () => {
    // primary carrier 200 (mkPreset), voice 210 → gap 20 Hz < 30 (also ratio 1.05 < 1.1).
    const r = validate(withVoices([{ id: 'a', nodes: [{ t: 0, carrier: { value: 210 }, beat: { value: 6 } }] }]));
    expect(r.ok).toBe(true);
    if (r.ok) {
      const w = r.issues.find((i) => i.code === 'VOICES_CARRIER_TOO_CLOSE');
      expect(w?.severity).toBe('warning');
      expect(w?.path).toBe('voices[0].nodes[0].carrier');
      expect(w?.message).toBe(
        'Voice carriers 200 Hz and 210 Hz are too close (within ratio 1.1 or 30 Hz); separate them by ≥ ratio 1.25 (≈ one critical band) so the voices don\'t mask or cross-beat',
      );
    }
  });

  it('does not warn when carriers clear ratio 1.1 and 30 Hz', () => {
    const r = validate(withVoices([{ id: 'a', nodes: [{ t: 0, carrier: { value: 400 }, beat: { value: 6 } }] }]));
    expect(r.ok).toBe(true);
    if (r.ok) expect(codes(r)).not.toContain('VOICES_CARRIER_TOO_CLOSE');
  });
});

describe('v6 multi-voice — pulse-worklet cap across all voices', () => {
  const carrierPulse = { shape: 'pulse', periodSec: 1, depth: 0.2 };
  const volPulse = { shape: 'pulse', periodSec: 1, depth: 0.5 };
  const lanedNode = (carrier: number): AnyObj => ({
    t: 0,
    carrier: { value: carrier, mod: carrierPulse },
    beat: { value: 6, mod: carrierPulse },
    volume: { value: 1, mod: volPulse },
    spatial: { value: 0, mod: volPulse },
  });

  it('flags VOICES_TOO_MANY_PULSES when pulse-shaped mods across voices exceed 8', () => {
    // primary 4 lanes + voice a 4 lanes + voice b 1 lane = 9 > 8.
    const r = validate(mkPreset({
      nodes: [lanedNode(200)],
      voices: [
        { id: 'a', nodes: [lanedNode(450)] },
        { id: 'b', nodes: [{ t: 0, carrier: { value: 700 }, beat: { value: 6, mod: carrierPulse } }] },
      ],
    }));
    expect(r.ok).toBe(false);
    expect(codes(r)).toContain('VOICES_TOO_MANY_PULSES');
  });

  it('accepts pulse mods at or below the limit of 8', () => {
    const r = validate(mkPreset({
      nodes: [{ t: 0, carrier: { value: 200 }, beat: { value: 6, mod: carrierPulse } }],
      voices: [{ id: 'a', nodes: [{ t: 0, carrier: { value: 400 }, beat: { value: 6, mod: carrierPulse } }] }],
    }));
    expect(r.ok).toBe(true);
    if (r.ok) expect(codes(r)).not.toContain('VOICES_TOO_MANY_PULSES');
  });
});

describe('v6 multi-voice — round-trip linchpin (the executable channel proof)', () => {
  function multiVoiceFixture(): Preset {
    return {
      schemaVersion: 6,
      name: 'Dual',
      durationSec: 600,
      masterGain: 0.8,
      nodes: [{ t: 0, carrier: { value: 200 }, beat: { value: 8 }, volume: { value: 1 } }],
      voices: [
        { id: 'iso', name: 'Gamma Pulse', gain: 0.6, nodes: [{ t: 0, carrier: { value: 432 }, beat: { value: 0 }, volume: { value: 1, mod: { shape: 'pulse', periodSec: 0.025, depth: 0.8 } } }] },
        { id: 'beta', nodes: [{ t: 0, carrier: { value: 700 }, beat: { value: 18 } }] },
      ],
    };
  }

  it('survives serialize → parse as presetsEqual (proves normalizeVoice + PRESET_KEYS are live)', () => {
    const p = multiVoiceFixture();
    const round = parseOrThrow(serialize(p));
    expect(presetsEqual(p, round)).toBe(true);
    expect(round.voices).toHaveLength(2);
    expect(round.voices?.[0]).toEqual({
      id: 'iso',
      name: 'Gamma Pulse',
      gain: 0.6,
      nodes: [{ t: 0, carrier: { value: 432 }, beat: { value: 0 }, volume: { value: 1, mod: { shape: 'pulse', periodSec: 0.025, depth: 0.8 } } }],
    });
    // a voice with no name/gain keeps them absent through the round-trip.
    expect('name' in (round.voices![1] as object)).toBe(false);
    expect('gain' in (round.voices![1] as object)).toBe(false);
  });

  it('keeps absent voices absent through serialize → parse', () => {
    const p = createDefaultPreset();
    const round = parseOrThrow(serialize(p));
    expect('voices' in round).toBe(false);
    expect(presetsEqual(p, round)).toBe(true);
  });

  it('keeps a present empty voices:[] through serialize → parse', () => {
    const p: Preset = { ...createDefaultPreset(), voices: [] };
    const s = serialize(p);
    expect(s).toContain('"voices":[]');
    const round = parseOrThrow(s);
    expect(round.voices).toEqual([]);
    expect(presetsEqual(p, round)).toBe(true);
  });
});

describe('v6 multi-voice — migration', () => {
  it('passes a v6 multi-voice preset through with migratedFrom null', () => {
    const p: Preset = { ...createDefaultPreset(), voices: [{ id: 'a', nodes: [{ t: 0, carrier: { value: 400 }, beat: { value: 6 } }] }] };
    const r = parse(serialize(p));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.migratedFrom).toBeNull();
      expect(r.preset.voices).toHaveLength(1);
    }
  });

  it('migrates a v5 preset → v6 with voices absent (migratedFrom 5)', () => {
    const r = parse('{"schemaVersion":5,"name":"x","durationSec":100,"masterGain":0.8,"nodes":[{"t":0,"carrier":{"value":200}}]}');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.preset.schemaVersion).toBe(6);
      expect(r.migratedFrom).toBe(5);
      expect('voices' in r.preset).toBe(false);
    }
  });
});

describe('v6 voiceScript — embedded narration script (D-043)', () => {
  const SCRIPT = { version: 1, purpose: 'meditation', blocks: [{ lines: [{ say: 'hello' }] }] };

  it('normalize preserves an embedded voiceScript verbatim (the allowlist-copy linchpin)', () => {
    const r = validate({ ...createDefaultPreset(), voiceScript: SCRIPT });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.preset.voiceScript).toEqual(SCRIPT);
  });

  it('round-trips through serialize→parse (save/load) unchanged', () => {
    const p = { ...createDefaultPreset(), voiceScript: SCRIPT } as Preset;
    const r = parse(serialize(p));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.preset.voiceScript).toEqual(SCRIPT);
  });

  it('deep-clones so the normalized preset never aliases the input object', () => {
    const input = { ...createDefaultPreset(), voiceScript: { version: 1, blocks: [{ lines: [{ say: 'x' }] }] } };
    const r = validate(input);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.preset.voiceScript).not.toBe(input.voiceScript); // distinct reference (deep clone)
      expect(r.preset.voiceScript).toEqual(input.voiceScript); // same content
    }
  });

  it('absent voiceScript stays absent (sparse, like layers/voices)', () => {
    const r = validate(createDefaultPreset());
    expect(r.ok).toBe(true);
    if (r.ok) expect('voiceScript' in r.preset).toBe(false);
  });

  it('rejects a non-object voiceScript with VOICE_SCRIPT_NOT_OBJECT', () => {
    for (const bad of [[1, 2], 'a string', 42, true]) {
      const r = validate({ ...createDefaultPreset(), voiceScript: bad });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.issues.some((i) => i.code === 'VOICE_SCRIPT_NOT_OBJECT')).toBe(true);
    }
  });
});
