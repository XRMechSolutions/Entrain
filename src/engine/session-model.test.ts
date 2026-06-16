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
  SessionModelError,
  CURRENT_SCHEMA_VERSION,
  MIN_SUPPORTED_SCHEMA_VERSION,
  RANGES,
  LIMITS,
  DEFAULTS,
} from './session-model';
import type {
  Preset,
  TimeNode,
  ValidationIssue,
  ValidationCode,
  ValidationResult,
  ParseResult,
  MigrateResult,
} from './session-model';

// --- helpers ---------------------------------------------------------------

type AnyObj = Record<string, unknown>;

function mkPreset(over: AnyObj = {}): AnyObj {
  return {
    schemaVersion: 3,
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
    });
    expect('carrier' in DEFAULTS).toBe(false);
  });

  it('schema-version constants are 3 (current) and 2 (min supported)', () => {
    expect(CURRENT_SCHEMA_VERSION).toBe(3);
    expect(MIN_SUPPORTED_SCHEMA_VERSION).toBe(2);
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

  it('exposes Preset.schemaVersion as literal 3 and the TimeNode type', () => {
    const node: TimeNode = { t: 0, carrier: { value: 200 }, spatial: { value: 0 } };
    const version: 3 = createDefaultPreset().schemaVersion;
    expect(version).toBe(3);
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
      expect(r.preset.schemaVersion).toBe(3);
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
      schemaVersion: 3,
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
      schemaVersion: 3,
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

  it('enforces [0,1] on volume depth/steps but no upper cap on carrier/beat depth', () => {
    expect(validate(volMod({ depth: 1.5 })).ok).toBe(false);
    expect(validate(volMod({ steps: [0.5, 1.5], transition: 'jump' })).ok).toBe(false);
    expect(validate(beatMod({ depth: 5000 })).ok).toBe(true);
    expect(validate(beatMod({ steps: [-5, 0, 5], transition: 'jump' })).ok).toBe(true);
    expect(validate(oneNode({ t: 0, carrier: { value: 200, mod: { depth: 5000 } } })).ok).toBe(true);
  });

  it('collects all independent errors without fail-fast', () => {
    const r = validate({
      schemaVersion: 3,
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
    expect(validate(beatMod({ shape: 'box', periodSec: 16, depth: 2 })).ok).toBe(true);
    expect(CURRENT_SCHEMA_VERSION).toBe(3); // box is additive — version stays 3
  });

  it('reads pulseWidth as the box hold ratio: in range, NOT ignored', () => {
    const r = validate(beatMod({ shape: 'box', periodSec: 16, depth: 2, pulseWidth: 0.5 }));
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
      schemaVersion: 3,
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
      schemaVersion: 3,
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
});

// --- Task 5: migrate / parse / parseOrThrow --------------------------------

describe('migrate', () => {
  it('passes a version-3 object through unchanged with fromVersion 3', () => {
    const raw = { schemaVersion: 3, name: 'x' };
    const r = migrate(raw);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value).toBe(raw);
      expect(r.fromVersion).toBe(3);
    }
  });

  it('migrates a version-2 object up to v3 (version-bump) with fromVersion 2', () => {
    const raw = { schemaVersion: 2, name: 'x' };
    const r = migrate(raw);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect((r.value as { schemaVersion: number }).schemaVersion).toBe(3);
      expect((r.value as { name: string }).name).toBe('x');
      expect(r.fromVersion).toBe(2);
    }
  });

  it('gates missing / non-integer / too-old / too-new / non-object', () => {
    expect(notOkCode(migrate({}))).toBe('SCHEMA_VERSION_MISSING');
    expect(notOkCode(migrate({ schemaVersion: '2' }))).toBe('SCHEMA_VERSION_NOT_INTEGER');
    expect(notOkCode(migrate({ schemaVersion: 1 }))).toBe('SCHEMA_TOO_OLD');
    expect(notOkCode(migrate({ schemaVersion: 4 }))).toBe('SCHEMA_TOO_NEW');
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

  it('loads a current (v3) preset with migratedFrom null', () => {
    const r = parse(serialize(createDefaultPreset()));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.migratedFrom).toBeNull();
  });

  it('migrates a v2 JSON preset up to v3 with migratedFrom 2', () => {
    const r = parse('{"schemaVersion":2,"name":"x","durationSec":100,"masterGain":0.8,"nodes":[{"t":0,"carrier":{"value":200}}]}');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.preset.schemaVersion).toBe(3);
      expect(r.migratedFrom).toBe(2);
    }
  });

  it('gates schema versions', () => {
    expect(notOkCode(parse('{"schemaVersion":1,"name":"x","durationSec":1,"masterGain":1,"nodes":[]}'))).toBe('SCHEMA_TOO_OLD');
    expect(notOkCode(parse('{"schemaVersion":4,"name":"x","durationSec":1,"masterGain":1,"nodes":[]}'))).toBe('SCHEMA_TOO_NEW');
    expect(notOkCode(parse('{"name":"x"}'))).toBe('SCHEMA_VERSION_MISSING');
    expect(notOkCode(parse('{"schemaVersion":2.5}'))).toBe('SCHEMA_VERSION_NOT_INTEGER');
  });

  it('pre-sorts out-of-order nodes; only true duplicates survive', () => {
    const ordered = parse('{"schemaVersion":3,"name":"x","durationSec":100,"masterGain":1,"nodes":[{"t":0,"carrier":{"value":200}},{"t":10,"volume":{"value":0.5}},{"t":5,"volume":{"value":0.8}}]}');
    expect(ordered.ok).toBe(true);
    if (ordered.ok) expect(ordered.preset.nodes.map((n) => n.t)).toEqual([0, 5, 10]);

    const dup = parse('{"schemaVersion":3,"name":"x","durationSec":100,"masterGain":1,"nodes":[{"t":0,"carrier":{"value":200}},{"t":5,"volume":{"value":0.5}},{"t":5,"volume":{"value":0.8}}]}');
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
      schemaVersion: 3,
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
    const a = validate({ schemaVersion: 3, name: 'x', durationSec: 100, masterGain: 0.8, nodes: [{ volume: { value: 1 }, beat: { value: 8 }, carrier: { value: 200 }, t: 0 }] });
    const b = validate({ nodes: [{ t: 0, carrier: { value: 200 }, beat: { value: 8 }, volume: { value: 1 } }], masterGain: 0.8, durationSec: 100, name: 'x', schemaVersion: 3 });
    expect(a.ok && b.ok).toBe(true);
    if (a.ok && b.ok) {
      const sa = serialize(a.preset);
      expect(sa).toBe(serialize(b.preset));
      expect(sa.startsWith('{"schemaVersion":3,"name":"x","durationSec":100,"masterGain":0.8,"nodes":[{"t":0,"carrier":')).toBe(true);
    }
  });

  it('selects 2-space indentation when pretty is true', () => {
    const s = serialize(createDefaultPreset(), { pretty: true });
    expect(s).toContain('\n  "name"');
  });

  it('throws SessionModelError on an invalid preset (never writes corrupt JSON)', () => {
    const bad = { schemaVersion: 3, name: '', durationSec: 100, masterGain: 1, nodes: [{ t: 0, carrier: { value: 200 } }] } as unknown as Preset;
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
    const p1 = { schemaVersion: 3, name: 'x', durationSec: 100, masterGain: 0.8, nodes: [{ t: 0, carrier: { value: 200 }, beat: { value: 8 } }] } as Preset;
    const p2 = { nodes: [{ beat: { value: 8 }, carrier: { value: 200 }, t: 0 }], masterGain: 0.8, durationSec: 100, name: 'x', schemaVersion: 3 } as Preset;
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
    const invalid = { schemaVersion: 3, name: '', durationSec: 100, masterGain: 1, nodes: [{ t: 0, carrier: { value: 200 } }] } as unknown as Preset;
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
      schemaVersion: 3,
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
