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

export const CURRENT_SCHEMA_VERSION = 3;
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
  schemaVersion: 3;
  name: string;
  durationSec: number;
  masterGain: number;
  nodes: TimeNode[];
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
  spatial: { min: -1, max: 1 },
  depthSpatial: { min: 0, max: 1 },
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

const PRESET_KEYS = ['schemaVersion', 'name', 'durationSec', 'masterGain', 'nodes'] as const;
const NODE_KEYS = ['t', 'carrier', 'beat', 'volume', 'waveform', 'spatial'] as const;
const PARAM_POINT_KEYS = ['value', 'transition', 'mod'] as const;
const MOD_POINT_KEYS = ['shape', 'periodSec', 'depth', 'transition', 'pulseWidth', 'edgeMs', 'steps'] as const;
const PARAM_NAMES = ['carrier', 'beat', 'volume', 'spatial'] as const;

const WAVEFORMS = ['sine', 'triangle', 'square', 'sawtooth'] as const;
const PARAM_TRANSITIONS = ['linear', 'exp', 'hold', 'smooth'] as const;
const MOD_SHAPES = ['sine', 'triangle', 'square', 'pulse', 'box'] as const;
const MOD_TRANSITIONS = ['glide', 'jump'] as const;

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

  // depth — finite, >= 0; volume/spatial also <= 1 (carrier/beat have no upper cap).
  if ('depth' in mod) {
    const d = mod.depth;
    if (!isFiniteNumber(d)) {
      err(issues, 'MOD_DEPTH_NOT_FINITE', `${path}.depth`, `"${param}.mod.depth" must be a finite number`);
    } else if (d < 0) {
      err(issues, 'MOD_DEPTH_NEGATIVE', `${path}.depth`, `"${param}.mod.depth" must be ≥ 0, got ${d}`);
    } else {
      const depthMax =
        param === 'volume' ? RANGES.depthVolume.max : param === 'spatial' ? RANGES.depthSpatial.max : undefined;
      if (depthMax !== undefined && d > depthMax) {
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

// Normalized clone — built only when validation succeeds, so every read below is of
// already-validated data. Copies known keys in canonical order; drops unknowns;
// preserves mod:null and absent optionals; produces a fresh, unshared object graph.
function normalizePreset(root: Record<string, unknown>): Preset {
  return {
    schemaVersion: CURRENT_SCHEMA_VERSION as 3,
    name: root.name as string,
    durationSec: root.durationSec as number,
    masterGain: root.masterGain as number,
    nodes: (root.nodes as unknown[]).map((n) => normalizeNode(n as Record<string, unknown>)),
  };
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

// ---------------------------------------------------------------------------
// 9. migrate — version gating + structural up-migration to the v2 shape
// ---------------------------------------------------------------------------

// Registry of structural up-migrations: MIGRATIONS[from] transforms a from-version
// object into the (from+1)-version shape. MIGRATIONS[2] (v2→v3) is a pure version-bump:
// `spatial` is a new optional TimeNode field (absent = centered), so no structural change
// is needed beyond stamping schemaVersion=3 (D-021). There is no MIGRATIONS[1] — D-011
// replaced the never-released v1 model and no v1 JSON contract exists, so any schemaVersion
// < 2 returns SCHEMA_TOO_OLD (a loud failure, not fake success).
// TODO(stub): future schemaVersion migrations register at MIGRATIONS[from] — next entry resolves when a >v3 schema is introduced
const MIGRATIONS: Record<number, (obj: Record<string, unknown>) => Record<string, unknown>> = {
  2: (obj) => ({ ...obj, schemaVersion: 3 }),
};

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
    schemaVersion: CURRENT_SCHEMA_VERSION as 3,
    name: 'Untitled Session',
    durationSec: 300,
    masterGain: 0.8,
    nodes: [{ t: 0, carrier: { value: 200 }, beat: { value: 8 }, volume: { value: 1 } }],
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
