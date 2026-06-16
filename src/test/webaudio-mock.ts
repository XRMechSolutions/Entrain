// Minimal fake Web Audio graph for jsdom (which ships no Web Audio API).
//
// This is a SHARED test double: the audio-engine tests use it to verify graph
// wiring, and the Layer-1 modules (automation, transport) reuse it to schedule
// onto the same AudioParam doubles. It is intentionally framework-free (no vitest
// imports) so it can be imported anywhere.
//
// It records enough to assert structure: every AudioParam keeps an ordered list of
// automation events and its set value; every node keeps its outgoing connections
// and incoming sources. `computeParamValue` walks the recorded graph to evaluate an
// AudioParam's steady-state value as the spec's Computation of Value does
// (intrinsic + Σ connected inputs), so the carrier/beat frequency sum is testable.

export type AutomationMethod =
  | 'setValueAtTime'
  | 'linearRampToValueAtTime'
  | 'exponentialRampToValueAtTime'
  | 'setTargetAtTime'
  | 'setValueCurveAtTime'
  | 'cancelScheduledValues'
  | 'cancelAndHoldAtTime';

export interface AutomationEvent {
  method: AutomationMethod;
  value?: number;
  time?: number;
}

export type NodeKind =
  | 'oscillator'
  | 'gain'
  | 'constant'
  | 'merger'
  | 'waveshaper'
  | 'worklet'
  | 'destination'
  | 'generic';

export type ConnectionTarget = MockAudioNode | MockAudioParam;

export interface Connection {
  destination: ConnectionTarget;
  output: number;
  input: number;
}

export class MockAudioParam {
  value: number;
  defaultValue: number;
  minValue: number;
  maxValue: number;
  automationRate: 'a-rate' | 'k-rate' = 'a-rate';

  /** Every scheduling call, in order, for assertions. */
  readonly events: AutomationEvent[] = [];
  /** Nodes whose output is summed into this param (modulator/automation inputs). */
  readonly inputs: MockAudioNode[] = [];

  // Present only when the context advertises support, so the engine's Firefox
  // fallback (cancelScheduledValues + setValueAtTime) is exercisable (edge E1).
  cancelAndHoldAtTime?: (time: number) => MockAudioParam;

  constructor(
    value = 0,
    opts: { min?: number; max?: number; supportsCancelAndHold?: boolean } = {},
  ) {
    this.value = value;
    this.defaultValue = value;
    this.minValue = opts.min ?? -3.4028235e38;
    this.maxValue = opts.max ?? 3.4028235e38;
    if (opts.supportsCancelAndHold !== false) {
      this.cancelAndHoldAtTime = (time: number) => {
        this.events.push({ method: 'cancelAndHoldAtTime', time });
        return this;
      };
    }
  }

  setValueAtTime(value: number, time: number): MockAudioParam {
    this.events.push({ method: 'setValueAtTime', value, time });
    this.value = value;
    return this;
  }

  linearRampToValueAtTime(value: number, time: number): MockAudioParam {
    this.events.push({ method: 'linearRampToValueAtTime', value, time });
    this.value = value;
    return this;
  }

  exponentialRampToValueAtTime(value: number, time: number): MockAudioParam {
    this.events.push({ method: 'exponentialRampToValueAtTime', value, time });
    this.value = value;
    return this;
  }

  setTargetAtTime(target: number, startTime: number, timeConstant: number): MockAudioParam {
    this.events.push({ method: 'setTargetAtTime', value: target, time: startTime });
    void timeConstant;
    this.value = target;
    return this;
  }

  setValueCurveAtTime(values: Float32Array, startTime: number, duration: number): MockAudioParam {
    this.events.push({ method: 'setValueCurveAtTime', time: startTime });
    void values;
    void duration;
    return this;
  }

  cancelScheduledValues(time: number): MockAudioParam {
    this.events.push({ method: 'cancelScheduledValues', time });
    return this;
  }

  /** Convenience for assertions: the ordered list of method names called. */
  get methodLog(): AutomationMethod[] {
    return this.events.map((e) => e.method);
  }

  /**
   * Evaluate this param's INTRINSIC timeline value at an arbitrary context time by
   * replaying the recorded automation events, implementing the Web Audio value-curve
   * semantics (setValueAtTime hold, linear/exponential ramp interpolation) plus the
   * cancelScheduledValues / cancelAndHoldAtTime edits. This is the deterministic
   * stand-in for an OfflineAudioContext render that jsdom cannot provide, so the
   * automation module can assert rendered-value == valueAt(). It excludes connected
   * modulator inputs (see computeParamValueAtTime for intrinsic + Σ inputs).
   */
  valueAtTime(time: number): number {
    return evaluateTimeline(this.effectiveEvents(), time, this.defaultValue);
  }

  /** Fold cancelScheduledValues / cancelAndHoldAtTime into a flat event list. */
  private effectiveEvents(): AutomationEvent[] {
    let eff: AutomationEvent[] = [];
    for (const e of this.events) {
      if (e.method === 'cancelScheduledValues') {
        const t = e.time ?? 0;
        eff = eff.filter((ev) => (ev.time ?? 0) < t);
      } else if (e.method === 'cancelAndHoldAtTime') {
        const t = e.time ?? 0;
        const held = evaluateTimeline(eff, t, this.defaultValue);
        const kept: AutomationEvent[] = [];
        let crossing: AutomationEvent | null = null;
        for (const ev of eff) {
          if ((ev.time ?? 0) <= t) {
            kept.push(ev);
          } else if (
            !crossing &&
            (ev.method === 'linearRampToValueAtTime' ||
              ev.method === 'exponentialRampToValueAtTime')
          ) {
            // The ramp crossing t is cut at t, holding the value it would reach there.
            crossing = { method: ev.method, value: held, time: t };
          }
        }
        kept.push(crossing ?? { method: 'setValueAtTime', value: held, time: t });
        eff = kept;
      } else if (e.method === 'setValueAtTime' || e.method === 'linearRampToValueAtTime' || e.method === 'exponentialRampToValueAtTime') {
        eff.push(e);
      }
      // setTargetAtTime / setValueCurveAtTime are never emitted by automation and are
      // intentionally ignored here (the module's contract forbids them).
    }
    return eff;
  }
}

/** Replay a value-bearing automation timeline at one instant (spec value semantics). */
function evaluateTimeline(events: AutomationEvent[], time: number, fallback: number): number {
  const evs = events
    .filter((e): e is AutomationEvent & { value: number; time: number } =>
      e.value !== undefined && e.time !== undefined,
    )
    .slice()
    .sort((a, b) => a.time - b.time);
  if (evs.length === 0) return fallback;

  let prev: { value: number; time: number; method: AutomationMethod } | null = null;
  for (const ev of evs) {
    if (ev.time > time) {
      if (prev === null) return ev.value; // before the first event: hold back the first value
      if (ev.method === 'linearRampToValueAtTime') {
        const span = ev.time - prev.time;
        if (span <= 0) return ev.value;
        return prev.value + (ev.value - prev.value) * ((time - prev.time) / span);
      }
      if (ev.method === 'exponentialRampToValueAtTime') {
        const span = ev.time - prev.time;
        if (span <= 0 || prev.value === 0 || Math.sign(prev.value) !== Math.sign(ev.value)) {
          return ev.value;
        }
        return prev.value * Math.pow(ev.value / prev.value, (time - prev.time) / span);
      }
      // The next event is a setValueAtTime — the param holds prev's value until then.
      return prev.value;
    }
    prev = { value: ev.value, time: ev.time, method: ev.method };
  }
  return prev ? prev.value : fallback;
}

function dropInput(target: ConnectionTarget, source: MockAudioNode): void {
  const list = target.inputs;
  const idx = list.indexOf(source);
  if (idx !== -1) list.splice(idx, 1);
}

export class MockAudioNode {
  readonly context: MockAudioContext;
  readonly kind: NodeKind;
  numberOfInputs = 1;
  numberOfOutputs = 1;
  channelCount = 2;

  /** Outgoing connections made FROM this node. */
  connections: Connection[] = [];
  /** Nodes connected INTO this node's main input (for gain summing in compute). */
  readonly inputs: MockAudioNode[] = [];

  disconnectCalls = 0;

  constructor(context: MockAudioContext, kind: NodeKind = 'generic') {
    this.context = context;
    this.kind = kind;
  }

  connect(destination: MockAudioNode, output?: number, input?: number): MockAudioNode;
  connect(destination: MockAudioParam, output?: number): void;
  connect(destination: ConnectionTarget, output = 0, input = 0): MockAudioNode | void {
    this.connections.push({ destination, output, input });
    destination.inputs.push(this);
    if (destination instanceof MockAudioNode) return destination;
  }

  disconnect(target?: ConnectionTarget): void {
    this.disconnectCalls++;
    if (target === undefined) {
      for (const c of this.connections) dropInput(c.destination, this);
      this.connections = [];
      return;
    }
    this.connections = this.connections.filter((c) => {
      if (c.destination === target) {
        dropInput(target, this);
        return false;
      }
      return true;
    });
  }

  /** True if this node has an outgoing connection to the given target. */
  isConnectedTo(target: ConnectionTarget): boolean {
    return this.connections.some((c) => c.destination === target);
  }
}

abstract class MockScheduledSource extends MockAudioNode {
  started = false;
  stopped = false;
  startTime: number | null = null;
  stopTime: number | null = null;

  start(when = 0): void {
    this.started = true;
    this.startTime = when;
  }

  stop(when = 0): void {
    this.stopped = true;
    this.stopTime = when;
  }
}

export class MockOscillatorNode extends MockScheduledSource {
  type: OscillatorType = 'sine';
  readonly frequency: MockAudioParam;
  readonly detune: MockAudioParam;

  constructor(context: MockAudioContext) {
    super(context, 'oscillator');
    this.numberOfInputs = 0;
    this.frequency = context.makeParam(440);
    this.detune = context.makeParam(0);
  }
}

export class MockConstantSourceNode extends MockScheduledSource {
  readonly offset: MockAudioParam;

  constructor(context: MockAudioContext) {
    super(context, 'constant');
    this.numberOfInputs = 0;
    this.offset = context.makeParam(1);
  }
}

export class MockGainNode extends MockAudioNode {
  readonly gain: MockAudioParam;

  constructor(context: MockAudioContext) {
    super(context, 'gain');
    this.gain = context.makeParam(1);
  }
}

export class MockChannelMergerNode extends MockAudioNode {
  constructor(context: MockAudioContext, numberOfInputs: number) {
    super(context, 'merger');
    this.numberOfInputs = numberOfInputs;
  }
}

export class MockWaveShaperNode extends MockAudioNode {
  curve: Float32Array | null = null;
  oversample: 'none' | '2x' | '4x' = 'none';

  constructor(context: MockAudioContext) {
    super(context, 'waveshaper');
  }
}

export class MockAudioParamMap {
  private readonly map = new Map<string, MockAudioParam>();

  constructor(private readonly context: MockAudioContext) {}

  // Auto-vivifies so the node need not know its descriptors in advance; the engine
  // sets each value explicitly after construction.
  get(name: string): MockAudioParam {
    let p = this.map.get(name);
    if (!p) {
      p = this.context.makeParam(0);
      this.map.set(name, p);
    }
    return p;
  }

  has(name: string): boolean {
    return this.map.has(name);
  }
}

export interface AudioWorkletNodeOptionsLike {
  numberOfInputs?: number;
  numberOfOutputs?: number;
  outputChannelCount?: number[];
}

export class MockAudioWorkletNode extends MockAudioNode {
  readonly name: string;
  readonly options?: AudioWorkletNodeOptionsLike;
  readonly parameters: MockAudioParamMap;

  constructor(
    context: MockAudioContext,
    name: string,
    options?: AudioWorkletNodeOptionsLike,
  ) {
    super(context, 'worklet');
    this.name = name;
    this.options = options;
    this.numberOfInputs = options?.numberOfInputs ?? 1;
    this.numberOfOutputs = options?.numberOfOutputs ?? 1;
    this.parameters = new MockAudioParamMap(context);
    context.created.worklets.push(this);
  }
}

export class MockAudioWorklet {
  readonly addModuleCalls: string[] = [];
  /** Override per-test to simulate addModule rejection (edge F1). */
  onAddModule: (url: string) => Promise<void> = () => Promise.resolve();

  addModule = (url: string): Promise<void> => {
    this.addModuleCalls.push(url);
    return this.onAddModule(url);
  };
}

export interface MockAudioContextOptions {
  sampleRate?: number;
  /** When false, params omit cancelAndHoldAtTime (simulates Firefox, edge E1). */
  supportsCancelAndHold?: boolean;
}

export class MockAudioContext {
  currentTime = 0;
  sampleRate: number;
  state: 'suspended' | 'running' | 'closed' = 'suspended';
  readonly destination: MockAudioNode;
  readonly audioWorklet = new MockAudioWorklet();
  private readonly supportsCancelAndHold: boolean;

  /** Every node created through this context, in creation order, for assertions. */
  readonly created = {
    oscillators: [] as MockOscillatorNode[],
    constantSources: [] as MockConstantSourceNode[],
    gains: [] as MockGainNode[],
    mergers: [] as MockChannelMergerNode[],
    waveShapers: [] as MockWaveShaperNode[],
    worklets: [] as MockAudioWorkletNode[],
  };

  constructor(opts: MockAudioContextOptions = {}) {
    this.sampleRate = opts.sampleRate ?? 48000;
    this.supportsCancelAndHold = opts.supportsCancelAndHold ?? true;
    this.destination = new MockAudioNode(this, 'destination');
  }

  makeParam(value = 0, range?: { min?: number; max?: number }): MockAudioParam {
    return new MockAudioParam(value, {
      min: range?.min,
      max: range?.max,
      supportsCancelAndHold: this.supportsCancelAndHold,
    });
  }

  createOscillator(): MockOscillatorNode {
    const node = new MockOscillatorNode(this);
    this.created.oscillators.push(node);
    return node;
  }

  createConstantSource(): MockConstantSourceNode {
    const node = new MockConstantSourceNode(this);
    this.created.constantSources.push(node);
    return node;
  }

  createGain(): MockGainNode {
    const node = new MockGainNode(this);
    this.created.gains.push(node);
    return node;
  }

  createChannelMerger(numberOfInputs = 6): MockChannelMergerNode {
    const node = new MockChannelMergerNode(this, numberOfInputs);
    this.created.mergers.push(node);
    return node;
  }

  createWaveShaper(): MockWaveShaperNode {
    const node = new MockWaveShaperNode(this);
    this.created.waveShapers.push(node);
    return node;
  }
}

/**
 * Evaluate an AudioParam's steady-state value the way the Web Audio spec does:
 * intrinsic timeline value + the sum of every connected source's output. A
 * ConstantSource contributes its offset; a GainNode contributes gain × (sum of its
 * own inputs). This lets a test assert fL = carrier − beat/2 from the wired graph.
 */
export function computeParamValue(param: MockAudioParam): number {
  let total = param.value;
  for (const source of param.inputs) total += nodeOutput(source);
  return total;
}

function nodeOutput(node: MockAudioNode): number {
  switch (node.kind) {
    case 'constant':
      return (node as MockConstantSourceNode).offset.value;
    case 'gain': {
      const gain = (node as MockGainNode).gain.value;
      let sum = 0;
      for (const source of node.inputs) sum += nodeOutput(source);
      return gain * sum;
    }
    case 'waveshaper': {
      let sum = 0;
      for (const source of node.inputs) sum += nodeOutput(source);
      return applyCurve((node as MockWaveShaperNode).curve, sum);
    }
    default:
      return 0;
  }
}

/** Apply a WaveShaper curve to a sample: map input [−1,1] across the curve with
 *  linear interpolation, clamping out-of-range inputs to the endpoints (Web Audio
 *  curve semantics). A null/empty curve passes the input through unchanged. */
function applyCurve(curve: Float32Array | null, x: number): number {
  if (!curve || curve.length === 0) return x;
  if (curve.length === 1) return curve[0];
  const clamped = Math.min(1, Math.max(-1, x));
  const pos = ((clamped + 1) / 2) * (curve.length - 1);
  const i0 = Math.floor(pos);
  const i1 = Math.min(i0 + 1, curve.length - 1);
  return curve[i0] + (curve[i1] - curve[i0]) * (pos - i0);
}

/**
 * Time-aware sibling of computeParamValue: the param's intrinsic timeline value at
 * `time` plus the sum of every connected source's output evaluated at the same
 * instant. A ConstantSource contributes offset(time); a GainNode contributes
 * gain(time) × (sum of its own inputs). Oscillators/worklets contribute 0 (the mock
 * does not synthesise a waveform), so this is used to verify additive base-curve +
 * step-sequencer (ConstantSource) sums against valueAt(), not raw LFO output.
 */
export function computeParamValueAtTime(param: MockAudioParam, time: number): number {
  let total = param.valueAtTime(time);
  for (const source of param.inputs) total += nodeOutputAtTime(source, time);
  return total;
}

function nodeOutputAtTime(node: MockAudioNode, time: number): number {
  switch (node.kind) {
    case 'constant':
      return (node as MockConstantSourceNode).offset.valueAtTime(time);
    case 'gain': {
      const gain = (node as MockGainNode).gain.valueAtTime(time);
      let sum = 0;
      for (const source of node.inputs) sum += nodeOutputAtTime(source, time);
      return gain * sum;
    }
    case 'waveshaper': {
      let sum = 0;
      for (const source of node.inputs) sum += nodeOutputAtTime(source, time);
      return applyCurve((node as MockWaveShaperNode).curve, sum);
    }
    default:
      return 0;
  }
}

/**
 * Install the global `AudioWorkletNode` constructor (jsdom lacks it). Returns an
 * uninstaller. createPulseNode uses the global constructor, matching the real API.
 */
export function installAudioWorkletNode(): () => void {
  const g = globalThis as Record<string, unknown>;
  const prev = g.AudioWorkletNode;
  g.AudioWorkletNode = MockAudioWorkletNode;
  return () => {
    g.AudioWorkletNode = prev;
  };
}
