// session-model — the persisted data contract for a binaural session.
//
// Pure, dependency-free TypeScript: the Preset/TimeNode/ParamPoint/ModPoint types,
// their runtime validation, canonical JSON serialize/parse, and schema-version
// gating/migration. No Web Audio, no DOM, no I/O. Every other module imports these
// types and the validate/parse/serialize functions; this module consumes none.
//
// See .dev/planning/modules/session-model/{design,interfaces,edge-cases}.md.

// ---------------------------------------------------------------------------
// 1. Schema-version constants
// ---------------------------------------------------------------------------

export const CURRENT_SCHEMA_VERSION = 5;
export const MIN_SUPPORTED_SCHEMA_VERSION = 2;

// ---------------------------------------------------------------------------
// 2. Enum types (closed string unions)
// ---------------------------------------------------------------------------

export type Waveform = 'sine' | 'triangle' | 'square' | 'sawtooth';
export type ParamTransition = 'linear' | 'exp' | 'hold' | 'smooth';
export type ModShape = 'sine' | 'triangle' | 'square' | 'pulse' | 'box';
export type ModTransition = 'glide' | 'jump';
export type AutomatableParam = 'carrier' | 'beat' | 'volume' | 'spatial';

// ---------------------------------------------------------------------------
// 3. Schema types
// ---------------------------------------------------------------------------

export interface ModPoint {
  shape?: ModShape;
  periodSec?: number;
  /** Warble/pulse amount, in the param's depth units (all bounded [0,1]):
   *  - carrier/beat: a FRACTION of the lane's base frequency (e.g. 0.02 = ±2%). Automation
   *    converts it to a Hz swing at each keyframe's base value, so a constant fraction gives
   *    a proportional swing whatever the base. (v5+; v4 stored this as absolute Hz.)
   *  - volume: tremolo depth as a 0..1 multiplier amount.
   *  - spatial: position swing as a 0..1 offset. */
  depth?: number;
  transition?: ModTransition;
  pulseWidth?: number;
  edgeMs?: number;
  steps?: number[];
}

export interface ParamPoint {
  value: number;
  transition?: ParamTransition;
  mod?: ModPoint | null;
}

export interface TimeNode {
  t: number;
  carrier?: ParamPoint;
  beat?: ParamPoint;
  volume?: ParamPoint;
  waveform?: Waveform;
  spatial?: ParamPoint; // stereo pan position [-1,1]; default 0 (center); v3+
}

export interface Preset {
  schemaVersion: 5;
  name: string;
  durationSec: number;
  masterGain: number;
  nodes: TimeNode[];
  layers?: Layer[]; // NEW (v4): stacked audio layers; absent = pure-binaural
}

// ---------------------------------------------------------------------------
// 3a. Schema v4 — Layer types (Phase 2)
// ---------------------------------------------------------------------------

export type LayerKind = 'tone' | 'ambiance' | 'voice';

export interface ToneSpec {
  shape: Waveform; // reuse the oscillator enum
  freqHz: number; // [20, 20000] finite — bell/tone pitch
  attackSec: number; // ≥ 0 finite — envelope attack
  releaseSec: number; // ≥ 0 finite — envelope release; one-shot len = attack+release
}

export type LayerSource = { synth: ToneSpec } | { clipId: string };

export interface LanePoint {
  t: number; // ≥ 0 finite — seconds RELATIVE to the layer's start
  value: number; // gain: [0,1]; spatial: [-1,1]
  transition?: ParamTransition; // toward next point; default 'linear'
}

export interface DuckIntent {
  toGain: number; // [0,1] finite — target gain the bed sub-bus dips TO (reuses RANGES.volume)
  attackSec: number; // ≥ 0 finite — ramp-down time into the dip
  releaseSec: number; // ≥ 0 finite — ramp-back time out of the dip when the cue ends
}

export interface Layer {
  id: string; // non-empty; unique within layers[]
  kind: LayerKind;
  source: LayerSource;
  t: number; // layer start on the SESSION timeline; [0, durationSec]
  loop?: boolean; // default false; ambiance typically true
  gain?: LanePoint[]; // relative-time gain automation; absent = constant unity
  spatial?: LanePoint[]; // relative-time pan automation; absent = center (0)
  duck?: DuckIntent; // NEW (v4): dip the bed sub-bus to toGain while this cue plays (D-038); absent = no duck
}

// ---------------------------------------------------------------------------
// 4. Validation issue model
// ---------------------------------------------------------------------------

export type Severity = 'error' | 'warning';

export type ValidationCode =
  // ---- errors (set ok:false) ----
  | 'INVALID_JSON' | 'NOT_OBJECT'
  | 'SCHEMA_VERSION_MISSING' | 'SCHEMA_VERSION_NOT_INTEGER'
  | 'WRONG_SCHEMA_VERSION' | 'SCHEMA_TOO_OLD' | 'SCHEMA_TOO_NEW'
  | 'NAME_NOT_STRING' | 'NAME_EMPTY' | 'NAME_TOO_LONG'
  | 'DURATION_NOT_FINITE' | 'DURATION_NOT_POSITIVE' | 'DURATION_TOO_LONG'
  | 'MASTER_GAIN_NOT_FINITE' | 'MASTER_GAIN_OUT_OF_RANGE'
  | 'NODES_NOT_ARRAY' | 'NODES_EMPTY'
  | 'NODE_NOT_OBJECT'
  | 'NODE_T_NOT_FINITE' | 'NODE_T_NEGATIVE' | 'NODE_T_EXCEEDS_DURATION'
  | 'NODES_NOT_SORTED' | 'NODES_DUPLICATE_T' | 'NODES_FIRST_T_NONZERO'
  | 'CARRIER_NOT_AT_START'
  | 'PARAM_POINT_NOT_OBJECT' | 'PARAM_VALUE_NOT_FINITE' | 'PARAM_VALUE_OUT_OF_RANGE'
  | 'PARAM_TRANSITION_INVALID' | 'EXP_RAMP_THROUGH_ZERO'
  | 'MOD_NOT_OBJECT_OR_NULL' | 'MOD_SHAPE_INVALID'
  | 'MOD_PERIOD_NOT_FINITE' | 'MOD_PERIOD_NOT_POSITIVE'
  | 'MOD_DEPTH_NOT_FINITE' | 'MOD_DEPTH_NEGATIVE' | 'MOD_DEPTH_OUT_OF_RANGE'
  | 'MOD_TRANSITION_INVALID'
  | 'MOD_PULSE_WIDTH_NOT_FINITE' | 'MOD_PULSE_WIDTH_OUT_OF_RANGE'
  | 'MOD_EDGE_MS_NOT_FINITE' | 'MOD_EDGE_MS_NEGATIVE'
  | 'MOD_STEPS_NOT_ARRAY' | 'MOD_STEPS_EMPTY' | 'MOD_STEP_NOT_FINITE' | 'MOD_STEP_OUT_OF_RANGE'
  | 'WAVEFORM_INVALID'
  // ---- v4 layer errors (set ok:false) ----
  | 'LAYERS_NOT_ARRAY' | 'LAYER_NOT_OBJECT'
  | 'LAYER_ID_NOT_STRING' | 'LAYER_ID_EMPTY' | 'LAYER_ID_DUPLICATE'
  | 'LAYER_KIND_INVALID' | 'LAYER_SOURCE_INVALID'
  | 'LAYER_CLIP_ID_NOT_STRING' | 'LAYER_CLIP_ID_EMPTY'
  | 'TONE_SHAPE_INVALID' | 'TONE_FREQ_NOT_FINITE' | 'TONE_FREQ_OUT_OF_RANGE'
  | 'TONE_ATTACK_NOT_FINITE' | 'TONE_ATTACK_NEGATIVE'
  | 'TONE_RELEASE_NOT_FINITE' | 'TONE_RELEASE_NEGATIVE'
  | 'LAYER_T_NOT_FINITE' | 'LAYER_T_NEGATIVE' | 'LAYER_T_EXCEEDS_DURATION'
  | 'LAYER_LOOP_NOT_BOOLEAN'
  | 'LANE_NOT_ARRAY' | 'LANE_POINT_NOT_OBJECT'
  | 'LANE_T_NOT_FINITE' | 'LANE_T_NEGATIVE'
  | 'LANE_VALUE_NOT_FINITE' | 'LANE_VALUE_OUT_OF_RANGE'
  | 'LANE_TRANSITION_INVALID' | 'LANE_NOT_SORTED' | 'LANE_DUPLICATE_T'
  | 'LANE_EXP_THROUGH_ZERO'
  | 'DUCK_NOT_OBJECT'
  | 'DUCK_TO_GAIN_NOT_FINITE' | 'DUCK_TO_GAIN_OUT_OF_RANGE'
  | 'DUCK_ATTACK_NOT_FINITE' | 'DUCK_ATTACK_NEGATIVE'
  | 'DUCK_RELEASE_NOT_FINITE' | 'DUCK_RELEASE_NEGATIVE'
  // ---- warnings (ok stays true) ----
  | 'UNKNOWN_FIELD' | 'IGNORED_FIELD_FOR_SHAPE'
  | 'MOD_EDGE_EXCEEDS_HALF_PERIOD' | 'STEPS_OVERRIDE_DEPTH' | 'STEPS_REQUIRE_JUMP';

export interface ValidationIssue {
  code: ValidationCode;
  severity: Severity;
  path: string;
  message: string;
}

// ---------------------------------------------------------------------------
// 5. Result types
// ---------------------------------------------------------------------------

export type ValidationResult =
  | { ok: true; preset: Preset; issues: ValidationIssue[] }
  | { ok: false; issues: ValidationIssue[] };

export type ParseResult =
  | { ok: true; preset: Preset; issues: ValidationIssue[]; migratedFrom: number | null }
  | { ok: false; issues: ValidationIssue[] };

export type MigrateResult =
  | { ok: true; value: unknown; fromVersion: number }
  | { ok: false; issues: ValidationIssue[] };

// ---------------------------------------------------------------------------
// 6. Error class
// ---------------------------------------------------------------------------

export class SessionModelError extends Error {
  readonly name = 'SessionModelError';
  constructor(message: string, readonly issues: ValidationIssue[]) {
    super(message);
  }
}

// ---------------------------------------------------------------------------
// 7. Constants — single source of truth for ranges and limits
// ---------------------------------------------------------------------------

export const RANGES = {
  carrier: { min: 20, max: 1000 },
  beat: { min: 0, max: 35 },
  volume: { min: 0, max: 1 },
  masterGain: { min: 0, max: 1 },
  pulseWidth: { min: 0, max: 1 },
  depthVolume: { min: 0, max: 1 },
  depthFreq: { min: 0, max: 1 }, // carrier/beat warble depth as a fraction of base (0..1 = 0..100%) (v5)
  spatial: { min: -1, max: 1 },
  depthSpatial: { min: 0, max: 1 },
  toneFreq: { min: 20, max: 20000 }, // bell/tone pitch (wider than carrier; bells ring high) (v4)
} as const;

export const LIMITS = {
  nameMaxCodePoints: 80,
  durationMaxSec: 86400,
} as const;

export const DEFAULTS = {
  waveform: 'sine',
  beat: 0,
  volume: 1,
  spatial: 0,
  paramTransition: 'linear',
  modShape: 'sine',
  modTransition: 'glide',
} as const;

// ---------------------------------------------------------------------------
// Internal: canonical key sets, enum membership, small helpers
// ---------------------------------------------------------------------------

const PRESET_KEYS = ['schemaVersion', 'name', 'durationSec', 'masterGain', 'nodes', 'layers'] as const;
const NODE_KEYS = ['t', 'carrier', 'beat', 'volume', 'waveform', 'spatial'] as const;
const PARAM_POINT_KEYS = ['value', 'transition', 'mod'] as const;
const MOD_POINT_KEYS = ['shape', 'periodSec', 'depth', 'transition', 'pulseWidth', 'edgeMs', 'steps'] as const;
const PARAM_NAMES = ['carrier', 'beat', 'volume', 'spatial'] as const;
const LAYER_KEYS = ['id', 'kind', 'source', 't', 'loop', 'gain', 'spatial', 'duck'] as const;
const LANE_POINT_KEYS = ['t', 'value', 'transition'] as const;
const TONE_SPEC_KEYS = ['shape', 'freqHz', 'attackSec', 'releaseSec'] as const;
const DUCK_KEYS = ['toGain', 'attackSec', 'releaseSec'] as const;
const LANE_NAMES = ['gain', 'spatial'] as const;

const WAVEFORMS = ['sine', 'triangle', 'square', 'sawtooth'] as const;
const PARAM_TRANSITIONS = ['linear', 'exp', 'hold', 'smooth'] as const;
const MOD_SHAPES = ['sine', 'triangle', 'square', 'pulse', 'box'] as const;
const MOD_TRANSITIONS = ['glide', 'jump'] as const;
const LAYER_KINDS = ['tone', 'ambiance', 'voice'] as const;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

function isWaveform(v: unknown): v is Waveform {
  return typeof v === 'string' && (WAVEFORMS as readonly string[]).includes(v);
}
function isParamTransition(v: unknown): v is ParamTransition {
  return typeof v === 'string' && (PARAM_TRANSITIONS as readonly string[]).includes(v);
}
function isModShape(v: unknown): v is ModShape {
  return typeof v === 'string' && (MOD_SHAPES as readonly string[]).includes(v);
}
function isModTransition(v: unknown): v is ModTransition {
  return typeof v === 'string' && (MOD_TRANSITIONS as readonly string[]).includes(v);
}
function isLayerKind(v: unknown): v is LayerKind {
  return typeof v === 'string' && (LAYER_KINDS as readonly string[]).includes(v);
}

function typeName(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}

function display(v: unknown): string {
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (typeof v === 'string') return JSON.stringify(v);
  if (v === null) return 'null';
  if (v === undefined) return 'undefined';
  return Object.prototype.toString.call(v);
}

function errIssue(code: ValidationCode, path: string, message: string): ValidationIssue {
  return { code, severity: 'error', path, message };
}
function err(issues: ValidationIssue[], code: ValidationCode, path: string, message: string): void {
  issues.push(errIssue(code, path, message));
}
function warn(issues: ValidationIssue[], code: ValidationCode, path: string, message: string): void {
  issues.push({ code, severity: 'warning', path, message });
}

function checkUnknownKeys(
  obj: Record<string, unknown>,
  known: readonly string[],
  basePath: string,
  issues: ValidationIssue[],
): void {
  for (const key of Object.keys(obj)) {
    if (!known.includes(key)) {
      const path = basePath === '' ? key : `${basePath}.${key}`;
      warn(issues, 'UNKNOWN_FIELD', path, `Unknown field "${key}" ignored`);
    }
  }
}

function summarize(issues: ValidationIssue[]): string {
  const errors = issues.filter((i) => i.severity === 'error').length;
  return `Invalid preset: ${errors} error(s)`;
}

// Per-node analysis carried from the per-field pass into the cross-node passes.
interface ParamInfo {
  valueValid: boolean;
  value: number | undefined;
  transition: ParamTransition | undefined;
}
interface NodeInfo {
  index: number;
  isObject: boolean;
  t: number | undefined; // the finite t value if present, else undefined (excluded from cross-node passes)
  params: Partial<Record<AutomatableParam, ParamInfo>>;
}

// ---------------------------------------------------------------------------
// 8. validate — core checker + normalizer (never throws, never mutates)
// ---------------------------------------------------------------------------

export function validate(value: unknown): ValidationResult {
  const issues: ValidationIssue[] = [];

  // Phase 1: root type.
  if (!isPlainObject(value)) {
    err(issues, 'NOT_OBJECT', '', `A preset must be a JSON object, got ${typeName(value)}`);
    return { ok: false, issues };
  }
  const root = value;

  // Phase 2: schemaVersion.
  validateSchemaVersion(root, issues);
  // Phase 3: name.
  validateName(root, issues);
  // Phase 4: durationSec (returns the validated value for the step-9 bound check).
  const duration = validateDuration(root, issues);
  // Phase 5: masterGain.
  validateMasterGain(root, issues);
  // Phases 6, 7, 8, 9, 10, 11: nodes container, per-node, ordering, bounds, carrier, exp.
  validateNodes(root, issues, duration);
  // Phase 12: layers subtree (independent of node errors).
  validateLayers(root, issues, duration);
  // Forward-compat: unknown root keys dropped + warned.
  checkUnknownKeys(root, PRESET_KEYS, '', issues);

  if (issues.some((i) => i.severity === 'error')) {
    return { ok: false, issues };
  }
  return { ok: true, preset: normalizePreset(root), issues };
}

function validateSchemaVersion(root: Record<string, unknown>, issues: ValidationIssue[]): void {
  if (!('schemaVersion' in root)) {
    err(issues, 'SCHEMA_VERSION_MISSING', 'schemaVersion', 'Missing required field "schemaVersion"');
    return;
  }
  const v = root.schemaVersion;
  if (typeof v !== 'number' || !Number.isInteger(v)) {
    err(issues, 'SCHEMA_VERSION_NOT_INTEGER', 'schemaVersion', `"schemaVersion" must be an integer, got ${display(v)}`);
    return;
  }
  if (v !== CURRENT_SCHEMA_VERSION) {
    err(issues, 'WRONG_SCHEMA_VERSION', 'schemaVersion', `Expected schemaVersion ${CURRENT_SCHEMA_VERSION}, got ${v}`);
  }
}

function validateName(root: Record<string, unknown>, issues: ValidationIssue[]): void {
  const name = root.name;
  if (typeof name !== 'string') {
    err(issues, 'NAME_NOT_STRING', 'name', '"name" must be a string');
    return;
  }
  if (name.trim().length < 1) {
    err(issues, 'NAME_EMPTY', 'name', '"name" must not be empty');
    return;
  }
  // Count Unicode code points (spread), not UTF-16 units, so an emoji counts as 1.
  const count = [...name].length;
  if (count > LIMITS.nameMaxCodePoints) {
    err(issues, 'NAME_TOO_LONG', 'name', `"name" must be at most 80 characters, got ${count}`);
  }
}

function validateDuration(root: Record<string, unknown>, issues: ValidationIssue[]): number | undefined {
  const d = root.durationSec;
  if (!isFiniteNumber(d)) {
    err(issues, 'DURATION_NOT_FINITE', 'durationSec', '"durationSec" must be a finite number');
    return undefined;
  }
  if (d <= 0) {
    err(issues, 'DURATION_NOT_POSITIVE', 'durationSec', `"durationSec" must be greater than 0, got ${d}`);
    return undefined;
  }
  if (d > LIMITS.durationMaxSec) {
    err(issues, 'DURATION_TOO_LONG', 'durationSec', `"durationSec" must be at most 86400 (24h), got ${d}`);
    return undefined;
  }
  return d;
}

function validateMasterGain(root: Record<string, unknown>, issues: ValidationIssue[]): void {
  const g = root.masterGain;
  if (!isFiniteNumber(g)) {
    err(issues, 'MASTER_GAIN_NOT_FINITE', 'masterGain', '"masterGain" must be a finite number');
    return;
  }
  if (g < RANGES.masterGain.min || g > RANGES.masterGain.max) {
    err(issues, 'MASTER_GAIN_OUT_OF_RANGE', 'masterGain', `"masterGain" must be within [0, 1], got ${g}`);
  }
}

function validateNodes(root: Record<string, unknown>, issues: ValidationIssue[], duration: number | undefined): void {
  const nodes = root.nodes;
  if (!Array.isArray(nodes)) {
    err(issues, 'NODES_NOT_ARRAY', 'nodes', '"nodes" must be an array');
    return;
  }
  if (nodes.length < 1) {
    err(issues, 'NODES_EMPTY', 'nodes', '"nodes" must contain at least one node');
    return;
  }

  // Phase 7: per-node field checks.
  const infos = nodes.map((n, i) => validateNode(n, i, issues));

  // Phase 8: ordering (sorted / unique / first-at-zero) over finite-t nodes only.
  validateOrdering(infos, issues);

  // Phase 9: t <= durationSec (needs a valid duration).
  if (duration !== undefined) {
    for (const info of infos) {
      if (info.t !== undefined && info.t > duration) {
        err(issues, 'NODE_T_EXCEEDS_DURATION', `nodes[${info.index}].t`,
          `Node "t" ${info.t} exceeds durationSec ${duration}`);
      }
    }
  }

  // Phase 10: carrier required at the start node.
  const first = infos[0];
  if (first.isObject && first.params.carrier === undefined) {
    err(issues, 'CARRIER_NOT_AT_START', 'nodes[0]', 'The first node (t=0) must set "carrier"');
  }

  // Phase 11: exponential ramp cannot reach or cross zero, per param.
  validateExpThroughZero(infos, issues);
}

function validateNode(node: unknown, i: number, issues: ValidationIssue[]): NodeInfo {
  const info: NodeInfo = { index: i, isObject: false, t: undefined, params: {} };
  const base = `nodes[${i}]`;

  if (!isPlainObject(node)) {
    err(issues, 'NODE_NOT_OBJECT', base, 'Node must be an object');
    return info; // inner checks skipped; excluded from ordering / exp analysis.
  }
  info.isObject = true;

  // t — finite >= 0. Only a non-finite t excludes the node from cross-node passes.
  const t = node.t;
  if (!isFiniteNumber(t)) {
    err(issues, 'NODE_T_NOT_FINITE', `${base}.t`, 'Node "t" must be a finite number');
  } else {
    info.t = t;
    if (t < 0) {
      err(issues, 'NODE_T_NEGATIVE', `${base}.t`, `Node "t" must be ≥ 0, got ${t}`);
    }
  }

  // ParamPoints.
  for (const p of PARAM_NAMES) {
    if (p in node) {
      info.params[p] = validateParamPoint(node[p], p, `${base}.${p}`, issues);
    }
  }

  // waveform — discrete enum, no cross-node rule.
  if ('waveform' in node && !isWaveform(node.waveform)) {
    err(issues, 'WAVEFORM_INVALID', `${base}.waveform`, '"waveform" must be one of sine, triangle, square, sawtooth');
  }

  checkUnknownKeys(node, NODE_KEYS, base, issues);
  return info;
}

function validateParamPoint(
  pp: unknown,
  param: AutomatableParam,
  path: string,
  issues: ValidationIssue[],
): ParamInfo {
  const info: ParamInfo = { valueValid: false, value: undefined, transition: undefined };

  if (!isPlainObject(pp)) {
    err(issues, 'PARAM_POINT_NOT_OBJECT', path, `"${param}" must be an object with a "value"`);
    return info;
  }

  // value — required, finite, in the param's range.
  const value = pp.value;
  if (!isFiniteNumber(value)) {
    err(issues, 'PARAM_VALUE_NOT_FINITE', `${path}.value`, `"${param}.value" must be a finite number`);
  } else {
    const range = RANGES[param];
    if (value < range.min || value > range.max) {
      err(issues, 'PARAM_VALUE_OUT_OF_RANGE', `${path}.value`,
        `"${param}.value" must be within [${range.min}, ${range.max}], got ${value}`);
    } else {
      info.valueValid = true;
      info.value = value;
    }
  }

  // transition.
  if ('transition' in pp) {
    if (!isParamTransition(pp.transition)) {
      err(issues, 'PARAM_TRANSITION_INVALID', `${path}.transition`,
        `"${param}.transition" must be one of linear, exp, hold, smooth`);
    } else {
      info.transition = pp.transition;
    }
  }

  // mod — three-state: absent (carry), null (clear), object (set/keyframe).
  if ('mod' in pp) {
    const mod = pp.mod;
    if (mod === null) {
      // explicit clear — valid, preserved losslessly.
    } else if (isPlainObject(mod)) {
      validateModPoint(mod, param, `${path}.mod`, issues);
    } else {
      err(issues, 'MOD_NOT_OBJECT_OR_NULL', `${path}.mod`, `"${param}.mod" must be an object or null`);
    }
  }

  checkUnknownKeys(pp, PARAM_POINT_KEYS, path, issues);
  return info;
}

function validateModPoint(
  mod: Record<string, unknown>,
  param: AutomatableParam,
  path: string,
  issues: ValidationIssue[],
): void {
  // shape.
  let shape: ModShape | undefined;
  if ('shape' in mod) {
    if (!isModShape(mod.shape)) {
      err(issues, 'MOD_SHAPE_INVALID', `${path}.shape`, `"${param}.mod.shape" must be one of sine, triangle, square, pulse, box`);
    } else {
      shape = mod.shape;
    }
  }

  // periodSec — finite, > 0.
  let periodSec: number | undefined;
  if ('periodSec' in mod) {
    const ps = mod.periodSec;
    if (!isFiniteNumber(ps)) {
      err(issues, 'MOD_PERIOD_NOT_FINITE', `${path}.periodSec`, `"${param}.mod.periodSec" must be a finite number`);
    } else if (ps <= 0) {
      err(issues, 'MOD_PERIOD_NOT_POSITIVE', `${path}.periodSec`, `"${param}.mod.periodSec" must be greater than 0, got ${ps}`);
    } else {
      periodSec = ps;
    }
  }

  // depth — finite, in [0,1] for every param: volume (multiplier), spatial (position), and
  // carrier/beat (fraction of base frequency, v5; previously an uncapped absolute Hz).
  if ('depth' in mod) {
    const d = mod.depth;
    if (!isFiniteNumber(d)) {
      err(issues, 'MOD_DEPTH_NOT_FINITE', `${path}.depth`, `"${param}.mod.depth" must be a finite number`);
    } else if (d < 0) {
      err(issues, 'MOD_DEPTH_NEGATIVE', `${path}.depth`, `"${param}.mod.depth" must be ≥ 0, got ${d}`);
    } else {
      const depthMax =
        param === 'volume' ? RANGES.depthVolume.max : param === 'spatial' ? RANGES.depthSpatial.max : RANGES.depthFreq.max;
      if (d > depthMax) {
        err(issues, 'MOD_DEPTH_OUT_OF_RANGE', `${path}.depth`, `"${param}.mod.depth" must be within [0, ${depthMax}], got ${d}`);
      }
    }
  }

  // transition.
  let modTransition: ModTransition | undefined;
  if ('transition' in mod) {
    if (!isModTransition(mod.transition)) {
      err(issues, 'MOD_TRANSITION_INVALID', `${path}.transition`, `"${param}.mod.transition" must be glide or jump`);
    } else {
      modTransition = mod.transition;
    }
  }

  // pulseWidth — finite, [0,1].
  if ('pulseWidth' in mod) {
    const pw = mod.pulseWidth;
    if (!isFiniteNumber(pw)) {
      err(issues, 'MOD_PULSE_WIDTH_NOT_FINITE', `${path}.pulseWidth`, `"${param}.mod.pulseWidth" must be a finite number`);
    } else if (pw < RANGES.pulseWidth.min || pw > RANGES.pulseWidth.max) {
      err(issues, 'MOD_PULSE_WIDTH_OUT_OF_RANGE', `${path}.pulseWidth`, `"${param}.mod.pulseWidth" must be within [0, 1], got ${pw}`);
    }
  }

  // edgeMs — finite, >= 0.
  let edgeMs: number | undefined;
  if ('edgeMs' in mod) {
    const e = mod.edgeMs;
    if (!isFiniteNumber(e)) {
      err(issues, 'MOD_EDGE_MS_NOT_FINITE', `${path}.edgeMs`, `"${param}.mod.edgeMs" must be a finite number`);
    } else if (e < 0) {
      err(issues, 'MOD_EDGE_MS_NEGATIVE', `${path}.edgeMs`, `"${param}.mod.edgeMs" must be ≥ 0, got ${e}`);
    } else {
      edgeMs = e;
    }
  }

  // steps — non-empty array; each finite; volume-only each in [0,1].
  let hasSteps = false;
  if ('steps' in mod) {
    const steps = mod.steps;
    if (!Array.isArray(steps)) {
      err(issues, 'MOD_STEPS_NOT_ARRAY', `${path}.steps`, `"${param}.mod.steps" must be an array of numbers`);
    } else if (steps.length < 1) {
      err(issues, 'MOD_STEPS_EMPTY', `${path}.steps`, `"${param}.mod.steps" must contain at least one value`);
    } else {
      hasSteps = true;
      for (let i = 0; i < steps.length; i++) {
        const s = steps[i];
        if (!isFiniteNumber(s)) {
          err(issues, 'MOD_STEP_NOT_FINITE', `${path}.steps[${i}]`, `"${param}.mod.steps[${i}]" must be a finite number`);
        } else if (param === 'volume' && (s < 0 || s > 1)) {
          err(issues, 'MOD_STEP_OUT_OF_RANGE', `${path}.steps[${i}]`, `"volume.mod.steps[${i}]" must be within [0, 1], got ${s}`);
        } else if (param === 'spatial' && (s < -1 || s > 1)) {
          err(issues, 'MOD_STEP_OUT_OF_RANGE', `${path}.steps[${i}]`, `"spatial.mod.steps[${i}]" must be within [-1, 1], got ${s}`);
        }
      }
    }
  }

  // Advisory warnings (structurally valid; never set ok:false).
  // `box` reuses pulseWidth as its hold ratio, so it is NOT ignored for box.
  if ('pulseWidth' in mod && (shape === 'sine' || shape === 'triangle')) {
    warn(issues, 'IGNORED_FIELD_FOR_SHAPE', `${path}.pulseWidth`, `"${param}.mod.pulseWidth" has no effect with shape "${shape}"`);
  }
  // edgeMs softens only the pulse gate; sine/triangle/square/box all ignore it.
  if ('edgeMs' in mod && (shape === 'sine' || shape === 'triangle' || shape === 'square' || shape === 'box')) {
    warn(issues, 'IGNORED_FIELD_FOR_SHAPE', `${path}.edgeMs`, `"${param}.mod.edgeMs" has no effect with shape "${shape}"`);
  }
  // box drives its own trapezoid trajectory and never sample-and-holds a steps[] list.
  if ('steps' in mod && shape === 'box') {
    warn(issues, 'IGNORED_FIELD_FOR_SHAPE', `${path}.steps`, `"${param}.mod.steps" has no effect with shape "box"`);
  }
  if (edgeMs !== undefined && periodSec !== undefined && edgeMs > (periodSec * 1000) / 2) {
    const halfMs = (periodSec * 1000) / 2;
    warn(issues, 'MOD_EDGE_EXCEEDS_HALF_PERIOD', `${path}.edgeMs`,
      `"${param}.mod.edgeMs" (${edgeMs}ms) exceeds half the period (${halfMs}ms); edges will be clamped`);
  }
  if (hasSteps && 'depth' in mod) {
    warn(issues, 'STEPS_OVERRIDE_DEPTH', path, `"${param}.mod" sets both steps and depth; steps take precedence and depth is ignored`);
  }
  if (hasSteps && modTransition !== 'jump') {
    warn(issues, 'STEPS_REQUIRE_JUMP', `${path}.steps`, `"${param}.mod.steps" only applies with transition "jump"; it is ignored otherwise`);
  }

  checkUnknownKeys(mod, MOD_POINT_KEYS, path, issues);
}

function validateOrdering(infos: NodeInfo[], issues: ValidationIssue[]): void {
  const valid: { index: number; t: number }[] = [];
  for (const info of infos) {
    if (info.t !== undefined) valid.push({ index: info.index, t: info.t });
  }
  if (valid.length === 0) return;

  if (valid[0].t !== 0) {
    err(issues, 'NODES_FIRST_T_NONZERO', `nodes[${valid[0].index}].t`, `The first node must be at t=0, got ${valid[0].t}`);
  }
  for (let k = 1; k < valid.length; k++) {
    const prev = valid[k - 1].t;
    const cur = valid[k].t;
    if (cur < prev) {
      err(issues, 'NODES_NOT_SORTED', `nodes[${valid[k].index}].t`, 'Nodes must be sorted ascending by "t"');
    } else if (cur === prev) {
      err(issues, 'NODES_DUPLICATE_T', `nodes[${valid[k].index}].t`, `Two nodes share t=${cur}; node times must be unique`);
    }
  }
}

function validateExpThroughZero(infos: NodeInfo[], issues: ValidationIssue[]): void {
  for (const p of PARAM_NAMES) {
    // Ordered sublist of nodes that set p with an in-range value and a finite t.
    const sub: { index: number; value: number; isExp: boolean }[] = [];
    for (const info of infos) {
      if (info.t === undefined) continue;
      const pi = info.params[p];
      if (pi && pi.valueValid && pi.value !== undefined) {
        sub.push({ index: info.index, value: pi.value, isExp: pi.transition === 'exp' });
      }
    }
    for (let k = 0; k + 1 < sub.length; k++) {
      const n0 = sub[k];
      if (!n0.isExp) continue;
      const v0 = n0.value;
      const v1 = sub[k + 1].value;
      if (v0 === 0 || v1 === 0 || Math.sign(v0) !== Math.sign(v1)) {
        err(issues, 'EXP_RAMP_THROUGH_ZERO', `nodes[${n0.index}].${p}.transition`,
          `"exp" transition cannot ramp to or across zero (${v0} → ${v1}); use linear/smooth or keep both endpoints the same nonzero sign`);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Phase 12: layers subtree (v4). Independent of node errors — an invalid binaural
// voice does not suppress layer diagnostics (§6.1/§6.3 step 12).
// ---------------------------------------------------------------------------

function validateLayers(root: Record<string, unknown>, issues: ValidationIssue[], duration: number | undefined): void {
  if (!('layers' in root)) return; // absent = pure-binaural; no checks.
  const layers = root.layers;
  if (!Array.isArray(layers)) {
    err(issues, 'LAYERS_NOT_ARRAY', 'layers', '"layers" must be an array');
    return; // stop layer checks; siblings already ran.
  }

  // First pass: per-layer structure + fields. Track ids for the uniqueness scan.
  const seenIds = new Set<string>();
  for (let i = 0; i < layers.length; i++) {
    validateLayer(layers[i], i, issues, duration, seenIds);
  }
}

function validateLayer(
  layer: unknown,
  i: number,
  issues: ValidationIssue[],
  duration: number | undefined,
  seenIds: Set<string>,
): void {
  const base = `layers[${i}]`;
  if (!isPlainObject(layer)) {
    err(issues, 'LAYER_NOT_OBJECT', base, 'Layer must be an object');
    return; // skip inner checks; excluded from id-uniqueness scan.
  }

  // id — non-empty string, unique across layers.
  const id = layer.id;
  if (typeof id !== 'string') {
    err(issues, 'LAYER_ID_NOT_STRING', `${base}.id`, 'Layer "id" must be a string');
  } else if (id.trim().length < 1) {
    err(issues, 'LAYER_ID_EMPTY', `${base}.id`, 'Layer "id" must not be empty');
  } else if (seenIds.has(id)) {
    err(issues, 'LAYER_ID_DUPLICATE', `${base}.id`, `Duplicate layer id ${display(id)}; layer ids must be unique`);
  } else {
    seenIds.add(id);
  }

  // kind — enum. Independent of source.
  if (!isLayerKind(layer.kind)) {
    err(issues, 'LAYER_KIND_INVALID', `${base}.kind`, 'Layer "kind" must be one of tone, ambiance, voice');
  }

  // source — exactly one of { synth } | { clipId }.
  validateLayerSource(layer.source, base, issues);

  // t — finite, ≥ 0, and ≤ durationSec (gated on a valid duration, like node phase 9).
  const t = layer.t;
  if (!isFiniteNumber(t)) {
    err(issues, 'LAYER_T_NOT_FINITE', `${base}.t`, 'Layer "t" must be a finite number');
  } else {
    if (t < 0) {
      err(issues, 'LAYER_T_NEGATIVE', `${base}.t`, `Layer "t" must be ≥ 0, got ${t}`);
    }
    if (duration !== undefined && t > duration) {
      err(issues, 'LAYER_T_EXCEEDS_DURATION', `${base}.t`, `Layer "t" ${t} exceeds durationSec ${duration}`);
    }
  }

  // loop — boolean if present.
  if ('loop' in layer && typeof layer.loop !== 'boolean') {
    err(issues, 'LAYER_LOOP_NOT_BOOLEAN', `${base}.loop`, 'Layer "loop" must be a boolean');
  }

  // gain / spatial lanes.
  for (const lane of LANE_NAMES) {
    if (lane in layer) {
      validateLane(layer[lane], lane, base, issues);
    }
  }

  // duck — DuckIntent if present.
  if ('duck' in layer) {
    validateDuck(layer.duck, base, issues);
  }

  checkUnknownKeys(layer, LAYER_KEYS, base, issues);
}

function validateLayerSource(source: unknown, base: string, issues: ValidationIssue[]): void {
  const path = `${base}.source`;
  if (!isPlainObject(source)) {
    err(issues, 'LAYER_SOURCE_INVALID', path, 'Layer "source" must be exactly one of { synth } or { clipId }');
    return;
  }
  const hasSynth = 'synth' in source;
  const hasClip = 'clipId' in source;
  if (hasSynth === hasClip) {
    // neither or both — ambiguous, rejected.
    err(issues, 'LAYER_SOURCE_INVALID', path, 'Layer "source" must be exactly one of { synth } or { clipId }');
    return;
  }

  if (hasClip) {
    const clipId = source.clipId;
    if (typeof clipId !== 'string') {
      err(issues, 'LAYER_CLIP_ID_NOT_STRING', `${path}.clipId`, '"source.clipId" must be a string');
    } else if (clipId.trim().length < 1) {
      err(issues, 'LAYER_CLIP_ID_EMPTY', `${path}.clipId`, '"source.clipId" must not be empty');
    }
    // clip existence NOT validated (D-023).
    return;
  }

  // synth — a ToneSpec object.
  const synth = source.synth;
  if (!isPlainObject(synth)) {
    err(issues, 'LAYER_SOURCE_INVALID', path, 'Layer "source" must be exactly one of { synth } or { clipId }');
    return;
  }
  const synthPath = `${path}.synth`;

  if (!isWaveform(synth.shape)) {
    err(issues, 'TONE_SHAPE_INVALID', `${synthPath}.shape`, '"source.synth.shape" must be one of sine, triangle, square, sawtooth');
  }

  const freqHz = synth.freqHz;
  if (!isFiniteNumber(freqHz)) {
    err(issues, 'TONE_FREQ_NOT_FINITE', `${synthPath}.freqHz`, '"source.synth.freqHz" must be a finite number');
  } else if (freqHz < RANGES.toneFreq.min || freqHz > RANGES.toneFreq.max) {
    err(issues, 'TONE_FREQ_OUT_OF_RANGE', `${synthPath}.freqHz`, `"source.synth.freqHz" must be within [20, 20000], got ${freqHz}`);
  }

  const attackSec = synth.attackSec;
  if (!isFiniteNumber(attackSec)) {
    err(issues, 'TONE_ATTACK_NOT_FINITE', `${synthPath}.attackSec`, '"source.synth.attackSec" must be a finite number');
  } else if (attackSec < 0) {
    err(issues, 'TONE_ATTACK_NEGATIVE', `${synthPath}.attackSec`, `"source.synth.attackSec" must be ≥ 0, got ${attackSec}`);
  }

  const releaseSec = synth.releaseSec;
  if (!isFiniteNumber(releaseSec)) {
    err(issues, 'TONE_RELEASE_NOT_FINITE', `${synthPath}.releaseSec`, '"source.synth.releaseSec" must be a finite number');
  } else if (releaseSec < 0) {
    err(issues, 'TONE_RELEASE_NEGATIVE', `${synthPath}.releaseSec`, `"source.synth.releaseSec" must be ≥ 0, got ${releaseSec}`);
  }

  checkUnknownKeys(synth, TONE_SPEC_KEYS, synthPath, issues);
}

function validateLane(lane: unknown, name: 'gain' | 'spatial', base: string, issues: ValidationIssue[]): void {
  const path = `${base}.${name}`;
  if (!Array.isArray(lane)) {
    err(issues, 'LANE_NOT_ARRAY', path, `"${name}" must be an array of lane points`);
    return;
  }
  const range = name === 'gain' ? RANGES.volume : RANGES.spatial;

  // Per-point checks. Track each point's analysis for the ordering + exp passes.
  interface LanePointInfo {
    index: number;
    t: number | undefined; // finite t, else undefined (excluded from ordering/exp).
    valueValid: boolean;
    value: number | undefined;
    transition: ParamTransition | undefined;
  }
  const infos: LanePointInfo[] = [];

  for (let j = 0; j < lane.length; j++) {
    const pPath = `${path}[${j}]`;
    const info: LanePointInfo = { index: j, t: undefined, valueValid: false, value: undefined, transition: undefined };
    const point = lane[j];
    if (!isPlainObject(point)) {
      err(issues, 'LANE_POINT_NOT_OBJECT', pPath, `"${name}" point must be an object with a "value"`);
      infos.push(info); // excluded from ordering/exp (t undefined).
      continue;
    }

    const t = point.t;
    if (!isFiniteNumber(t)) {
      err(issues, 'LANE_T_NOT_FINITE', `${pPath}.t`, `"${name}.t" must be a finite number`);
    } else {
      info.t = t;
      if (t < 0) {
        err(issues, 'LANE_T_NEGATIVE', `${pPath}.t`, `"${name}.t" must be ≥ 0, got ${t}`);
      }
    }

    const value = point.value;
    if (!isFiniteNumber(value)) {
      err(issues, 'LANE_VALUE_NOT_FINITE', `${pPath}.value`, `"${name}.value" must be a finite number`);
    } else if (value < range.min || value > range.max) {
      err(issues, 'LANE_VALUE_OUT_OF_RANGE', `${pPath}.value`, `"${name}.value" must be within [${range.min}, ${range.max}], got ${value}`);
    } else {
      info.valueValid = true;
      info.value = value;
    }

    if ('transition' in point) {
      if (!isParamTransition(point.transition)) {
        err(issues, 'LANE_TRANSITION_INVALID', `${pPath}.transition`, `"${name}.transition" must be one of linear, exp, hold, smooth`);
      } else {
        info.transition = point.transition;
      }
    }

    checkUnknownKeys(point, LANE_POINT_KEYS, pPath, issues);
    infos.push(info);
  }

  // Ordering — reject out-of-order (no pre-sort); no first-at-zero requirement.
  const valid = infos.filter((p) => p.t !== undefined) as Array<LanePointInfo & { t: number }>;
  for (let k = 1; k < valid.length; k++) {
    const prev = valid[k - 1].t;
    const cur = valid[k].t;
    if (cur < prev) {
      err(issues, 'LANE_NOT_SORTED', `${path}[${valid[k].index}].t`, `"${name}" points must be sorted ascending by "t"`);
    } else if (cur === prev) {
      err(issues, 'LANE_DUPLICATE_T', `${path}[${valid[k].index}].t`, `Two "${name}" points share t=${cur}; lane point times must be unique`);
    }
  }

  // Per-lane exp-through-zero (§7.5 reused). Use value-valid, finite-t points in array order.
  const sub = infos.filter((p) => p.t !== undefined && p.valueValid && p.value !== undefined) as Array<
    LanePointInfo & { t: number; value: number }
  >;
  for (let k = 0; k + 1 < sub.length; k++) {
    const p0 = sub[k];
    if (p0.transition !== 'exp') continue;
    const v0 = p0.value;
    const v1 = sub[k + 1].value;
    if (v0 === 0 || v1 === 0 || Math.sign(v0) !== Math.sign(v1)) {
      err(issues, 'LANE_EXP_THROUGH_ZERO', `${path}[${p0.index}].transition`,
        `"exp" transition cannot ramp to or across zero (${v0} → ${v1}); use linear/smooth or keep both endpoints the same nonzero sign`);
    }
  }
}

function validateDuck(duck: unknown, base: string, issues: ValidationIssue[]): void {
  const path = `${base}.duck`;
  if (!isPlainObject(duck)) {
    err(issues, 'DUCK_NOT_OBJECT', path, '"duck" must be an object with "toGain", "attackSec", and "releaseSec"');
    return;
  }

  const toGain = duck.toGain;
  if (!isFiniteNumber(toGain)) {
    err(issues, 'DUCK_TO_GAIN_NOT_FINITE', `${path}.toGain`, '"duck.toGain" must be a finite number');
  } else if (toGain < RANGES.volume.min || toGain > RANGES.volume.max) {
    err(issues, 'DUCK_TO_GAIN_OUT_OF_RANGE', `${path}.toGain`, `"duck.toGain" must be within [0, 1], got ${toGain}`);
  }

  const attackSec = duck.attackSec;
  if (!isFiniteNumber(attackSec)) {
    err(issues, 'DUCK_ATTACK_NOT_FINITE', `${path}.attackSec`, '"duck.attackSec" must be a finite number');
  } else if (attackSec < 0) {
    err(issues, 'DUCK_ATTACK_NEGATIVE', `${path}.attackSec`, `"duck.attackSec" must be ≥ 0, got ${attackSec}`);
  }

  const releaseSec = duck.releaseSec;
  if (!isFiniteNumber(releaseSec)) {
    err(issues, 'DUCK_RELEASE_NOT_FINITE', `${path}.releaseSec`, '"duck.releaseSec" must be a finite number');
  } else if (releaseSec < 0) {
    err(issues, 'DUCK_RELEASE_NEGATIVE', `${path}.releaseSec`, `"duck.releaseSec" must be ≥ 0, got ${releaseSec}`);
  }

  checkUnknownKeys(duck, DUCK_KEYS, path, issues);
}

// Normalized clone — built only when validation succeeds, so every read below is of
// already-validated data. Copies known keys in canonical order; drops unknowns;
// preserves mod:null and absent optionals; produces a fresh, unshared object graph.
function normalizePreset(root: Record<string, unknown>): Preset {
  const out: Preset = {
    schemaVersion: CURRENT_SCHEMA_VERSION as 5,
    name: root.name as string,
    durationSec: root.durationSec as number,
    masterGain: root.masterGain as number,
    nodes: (root.nodes as unknown[]).map((n) => normalizeNode(n as Record<string, unknown>)),
  };
  // Absent `layers` stays absent (sparse); a present array (even empty) is preserved.
  if ('layers' in root) {
    out.layers = (root.layers as unknown[]).map((l) => normalizeLayer(l as Record<string, unknown>));
  }
  return out;
}

function normalizeNode(node: Record<string, unknown>): TimeNode {
  const out: TimeNode = { t: node.t as number };
  if ('carrier' in node) out.carrier = normalizeParam(node.carrier as Record<string, unknown>);
  if ('beat' in node) out.beat = normalizeParam(node.beat as Record<string, unknown>);
  if ('volume' in node) out.volume = normalizeParam(node.volume as Record<string, unknown>);
  if ('waveform' in node) out.waveform = node.waveform as Waveform;
  if ('spatial' in node) out.spatial = normalizeParam(node.spatial as Record<string, unknown>);
  return out;
}

function normalizeParam(pp: Record<string, unknown>): ParamPoint {
  const out: ParamPoint = { value: pp.value as number };
  if ('transition' in pp) out.transition = pp.transition as ParamTransition;
  if ('mod' in pp) {
    const mod = pp.mod;
    out.mod = mod === null ? null : normalizeMod(mod as Record<string, unknown>);
  }
  return out;
}

function normalizeMod(mod: Record<string, unknown>): ModPoint {
  const out: ModPoint = {};
  if ('shape' in mod) out.shape = mod.shape as ModShape;
  if ('periodSec' in mod) out.periodSec = mod.periodSec as number;
  if ('depth' in mod) out.depth = mod.depth as number;
  if ('transition' in mod) out.transition = mod.transition as ModTransition;
  if ('pulseWidth' in mod) out.pulseWidth = mod.pulseWidth as number;
  if ('edgeMs' in mod) out.edgeMs = mod.edgeMs as number;
  if ('steps' in mod) out.steps = (mod.steps as number[]).slice();
  return out;
}

// Layer normalization (v4): canonical key order id,kind,source,t,loop,gain,spatial,duck.
// Empty gain/spatial arrays are DROPPED (treat-as-absent); absent loop/duck not created.
function normalizeLayer(layer: Record<string, unknown>): Layer {
  const out = {
    id: layer.id as string,
    kind: layer.kind as LayerKind,
    source: normalizeLayerSource(layer.source as Record<string, unknown>),
    t: layer.t as number,
  } as Layer;
  if ('loop' in layer) out.loop = layer.loop as boolean;
  for (const lane of LANE_NAMES) {
    if (lane in layer) {
      const points = layer[lane] as unknown[];
      // Empty lane → treat-as-absent (key not created).
      if (points.length > 0) {
        out[lane] = points.map((p) => normalizeLanePoint(p as Record<string, unknown>));
      }
    }
  }
  if ('duck' in layer) out.duck = normalizeDuckIntent(layer.duck as Record<string, unknown>);
  return out;
}

function normalizeLayerSource(source: Record<string, unknown>): LayerSource {
  // Validated to carry exactly one discriminant; copy only the present one.
  if ('synth' in source) {
    return { synth: normalizeToneSpec(source.synth as Record<string, unknown>) };
  }
  return { clipId: source.clipId as string };
}

function normalizeToneSpec(synth: Record<string, unknown>): ToneSpec {
  return {
    shape: synth.shape as Waveform,
    freqHz: synth.freqHz as number,
    attackSec: synth.attackSec as number,
    releaseSec: synth.releaseSec as number,
  };
}

function normalizeLanePoint(point: Record<string, unknown>): LanePoint {
  const out: LanePoint = { t: point.t as number, value: point.value as number };
  if ('transition' in point) out.transition = point.transition as ParamTransition;
  return out;
}

function normalizeDuckIntent(duck: Record<string, unknown>): DuckIntent {
  return {
    toGain: duck.toGain as number,
    attackSec: duck.attackSec as number,
    releaseSec: duck.releaseSec as number,
  };
}

// ---------------------------------------------------------------------------
// 9. migrate — version gating + structural up-migration to the v4 shape
// ---------------------------------------------------------------------------

// Registry of structural up-migrations: MIGRATIONS[from] transforms a from-version
// object into the (from+1)-version shape.
//   MIGRATIONS[2] (v2→v3): `spatial` is a new optional TimeNode field (absent = centered);
//     a pure version-bump stamping schemaVersion=3 (D-021).
//   MIGRATIONS[3] (v3→v4): `layers` is a new optional Preset field (absent = pure-binaural);
//     a pure version-bump stamping schemaVersion=4 (D-022; design §11.6).
//   MIGRATIONS[4] (v4→v5): carrier/beat `mod.depth` changes MEANING from an absolute Hz
//     offset to a FRACTION of the lane's base frequency (percentage warble). The transform
//     rewrites each carrier/beat modulator depth to `depth / value` (the sibling ParamPoint
//     value at that node), clamped to [0,1]; a non-positive/absent base yields 0 (a base of
//     0 Hz has no proportional warble — the engine already floors it to 0). volume/spatial
//     depths are already fractional/positional and `steps` are explicit offsets, so both are
//     left untouched. This is the one value-rewriting migration; the rest are version-bumps.
// So a v4 preset walks v4→v5, a v3 preset v3→v4→v5, a v2 preset v2→v3→v4→v5; all stamp to the
// current version, so the normalized output is always v5. There is no MIGRATIONS[1] — D-011
// replaced the never-released v1 model and no v1 JSON contract exists, so any schemaVersion
// < 2 returns SCHEMA_TOO_OLD (a loud failure, not fake success).
// TODO(stub): future schemaVersion migrations register at MIGRATIONS[from] — next entry resolves when a >v5 schema is introduced
const MIGRATIONS: Record<number, (obj: Record<string, unknown>) => Record<string, unknown>> = {
  2: (obj) => ({ ...obj, schemaVersion: 3 }),
  3: (obj) => ({ ...obj, schemaVersion: 4 }),
  4: (obj) => migrateV4ToV5(obj),
};

// v4→v5: convert carrier/beat warble depth from absolute Hz to a fraction of the base
// frequency (see MIGRATIONS comment). Defensive over untrusted input — only rewrites when
// both the base value and the depth are finite numbers with base > 0 and depth ≥ 0;
// anything else is left as-is for `validate` to diagnose. Never mutates the input.
function migrateV4ToV5(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...obj, schemaVersion: 5 };
  if (Array.isArray(obj.nodes)) {
    out.nodes = obj.nodes.map((n) => (isPlainObject(n) ? convertFreqWarbleDepth(n) : n));
  }
  return out;
}

function convertFreqWarbleDepth(node: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...node };
  for (const param of ['carrier', 'beat'] as const) {
    const pp = node[param];
    if (!isPlainObject(pp)) continue;
    const mod = pp.mod;
    if (!isPlainObject(mod) || !('depth' in mod)) continue;
    const base = pp.value;
    const depth = mod.depth;
    if (
      typeof base === 'number' && Number.isFinite(base) && base > 0 &&
      typeof depth === 'number' && Number.isFinite(depth) && depth >= 0
    ) {
      const frac = Math.min(RANGES.depthFreq.max, depth / base);
      out[param] = { ...pp, mod: { ...mod, depth: frac } };
    }
  }
  return out;
}

export function migrate(raw: unknown): MigrateResult {
  if (!isPlainObject(raw)) {
    return { ok: false, issues: [errIssue('NOT_OBJECT', '', `A preset must be a JSON object, got ${typeName(raw)}`)] };
  }
  if (!('schemaVersion' in raw)) {
    return { ok: false, issues: [errIssue('SCHEMA_VERSION_MISSING', 'schemaVersion', 'Missing required field "schemaVersion"')] };
  }
  const v = raw.schemaVersion;
  if (typeof v !== 'number' || !Number.isInteger(v)) {
    return { ok: false, issues: [errIssue('SCHEMA_VERSION_NOT_INTEGER', 'schemaVersion', `"schemaVersion" must be an integer, got ${display(v)}`)] };
  }
  if (v === CURRENT_SCHEMA_VERSION) {
    return { ok: true, value: raw, fromVersion: v };
  }
  if (v > CURRENT_SCHEMA_VERSION) {
    return { ok: false, issues: [errIssue('SCHEMA_TOO_NEW', 'schemaVersion', `Schema version ${v} is newer than this app supports (${CURRENT_SCHEMA_VERSION}); update the app`)] };
  }

  // v < CURRENT: walk the migration registry up to the current version.
  let current: Record<string, unknown> = raw;
  let ver = v;
  while (ver < CURRENT_SCHEMA_VERSION) {
    const step = MIGRATIONS[ver];
    if (!step) {
      return { ok: false, issues: [errIssue('SCHEMA_TOO_OLD', 'schemaVersion', `Schema version ${v} is older than the minimum supported (${MIN_SUPPORTED_SCHEMA_VERSION}) and cannot be migrated`)] };
    }
    current = step(current);
    ver++;
  }
  return { ok: true, value: current, fromVersion: v };
}

// ---------------------------------------------------------------------------
// 10. parse / parseOrThrow — untrusted JSON in
// ---------------------------------------------------------------------------

export function parse(json: string): ParseResult {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, issues: [errIssue('INVALID_JSON', '', `Not valid JSON: ${msg}`)] };
  }

  if (!isPlainObject(raw)) {
    return { ok: false, issues: [errIssue('NOT_OBJECT', '', `A preset must be a JSON object, got ${typeName(raw)}`)] };
  }

  const migrated = migrate(raw);
  if (!migrated.ok) {
    return { ok: false, issues: migrated.issues };
  }

  const presorted = preSortNodes(migrated.value);
  const result = validate(presorted);
  // A migration "actually ran" only when the original version differed from current.
  const migratedFrom = migrated.fromVersion !== CURRENT_SCHEMA_VERSION ? migrated.fromVersion : null;

  if (!result.ok) {
    return { ok: false, issues: result.issues };
  }
  return { ok: true, preset: result.preset, issues: result.issues, migratedFrom };
}

export function parseOrThrow(json: string): Preset {
  const result = parse(json);
  if (!result.ok) {
    throw new SessionModelError(summarize(result.issues), result.issues);
  }
  return result.preset;
}

// Stable pre-sort of a migrated object's nodes by ascending t, without mutating the
// input. Nodes with a non-numeric t produce a NaN comparison, which the spec coerces
// to 0 — so they keep their relative order and fail later in validate.
function preSortNodes(value: unknown): unknown {
  if (!isPlainObject(value)) return value;
  const nodes = value.nodes;
  if (!Array.isArray(nodes)) return value;
  const sorted = [...nodes].sort((a, b) => {
    const ta = isPlainObject(a) && typeof a.t === 'number' ? a.t : NaN;
    const tb = isPlainObject(b) && typeof b.t === 'number' ? b.t : NaN;
    return ta - tb;
  });
  return { ...value, nodes: sorted };
}

// ---------------------------------------------------------------------------
// 11. serialize — Preset out (canonical JSON; validates first)
// ---------------------------------------------------------------------------

export function serialize(preset: Preset, opts?: { pretty?: boolean }): string {
  const result = validate(preset);
  if (!result.ok) {
    throw new SessionModelError(summarize(result.issues), result.issues);
  }
  return JSON.stringify(result.preset, null, opts?.pretty ? 2 : undefined);
}

// ---------------------------------------------------------------------------
// 12. Type guard, clone, default factory, sort, structural equality
// ---------------------------------------------------------------------------

export function isPreset(value: unknown): value is Preset {
  return validate(value).ok;
}

// Deep copy of a TRUSTED, valid preset. structuredClone is exact (preserves null and
// full double precision); validation is intentionally skipped on known-good data.
export function clonePreset(preset: Preset): Preset {
  return structuredClone(preset);
}

export function createDefaultPreset(): Preset {
  return {
    schemaVersion: CURRENT_SCHEMA_VERSION as 5,
    name: 'Untitled Session',
    durationSec: 300,
    masterGain: 0.8,
    nodes: [{ t: 0, carrier: { value: 200 }, beat: { value: 8 }, volume: { value: 1 } }],
    // layers omitted — a fresh session is pure-binaural; the author adds layers later.
  };
}

export function sortNodes(nodes: TimeNode[]): TimeNode[] {
  return [...nodes].sort((a, b) => a.t - b.t);
}

export function presetsEqual(a: Preset, b: Preset): boolean {
  const ra = validate(a);
  if (!ra.ok) throw new SessionModelError(summarize(ra.issues), ra.issues);
  const rb = validate(b);
  if (!rb.ok) throw new SessionModelError(summarize(rb.issues), rb.issues);
  // Canonical normalization makes JSON equality exactly key-order-independent
  // structural equality, with null/number fidelity intact.
  return JSON.stringify(ra.preset) === JSON.stringify(rb.preset);
}
