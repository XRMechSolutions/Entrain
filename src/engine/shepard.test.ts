import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  registerShepardWorklet,
  createShepardNode,
  ShepardError,
  SHEPARD_PROCESSOR_NAME,
} from './shepard';
import { MockAudioContext, installAudioWorkletNode } from '../test/webaudio-mock';

const asCtx = (c: MockAudioContext): BaseAudioContext => c as unknown as BaseAudioContext;
const val = (p: AudioParam): number => (p as unknown as { value: number }).value;
const named = (n: AudioWorkletNode): string => (n as unknown as { name: string }).name;
const opts = (n: AudioWorkletNode): { outputChannelCount?: number[]; numberOfInputs?: number } =>
  (n as unknown as { options: { outputChannelCount?: number[]; numberOfInputs?: number } }).options;
const disconnects = (n: AudioWorkletNode): number => (n as unknown as { disconnectCalls: number }).disconnectCalls;

// =====================================================================================
// registerShepardWorklet — addModule, idempotency, failure mapping
// =====================================================================================

describe('registerShepardWorklet', () => {
  it('adds the module once and is idempotent per context', async () => {
    const ctx = new MockAudioContext();
    await registerShepardWorklet(asCtx(ctx), 'first://');
    await registerShepardWorklet(asCtx(ctx), 'second://'); // same ctx → no-op
    expect(ctx.audioWorklet.addModuleCalls).toEqual(['first://']);
  });

  it('defaults the module url to the bundled shepard-worklet chunk', async () => {
    const ctx = new MockAudioContext();
    await registerShepardWorklet(asCtx(ctx));
    expect(ctx.audioWorklet.addModuleCalls[0]).toContain('shepard-worklet');
  });

  it('maps an addModule rejection to a ShepardError carrying the cause', async () => {
    const ctx = new MockAudioContext();
    const boom = new Error('no AudioWorklet');
    ctx.audioWorklet.onAddModule = () => Promise.reject(boom);
    try {
      await registerShepardWorklet(asCtx(ctx));
      throw new Error('expected rejection');
    } catch (e) {
      expect(e).toBeInstanceOf(ShepardError);
      expect((e as ShepardError).cause).toBe(boom);
    }
  });
});

// =====================================================================================
// createShepardNode — node shape + params, register-before-create
// =====================================================================================

describe('createShepardNode', () => {
  let uninstall: () => void;
  beforeEach(() => {
    uninstall = installAudioWorkletNode();
  });
  afterEach(() => {
    uninstall();
  });

  it('builds a single-output "shepard" node and exposes speed/gain params with defaults', async () => {
    const ctx = new MockAudioContext();
    await registerShepardWorklet(asCtx(ctx));
    const handle = createShepardNode(asCtx(ctx));
    expect(named(handle.node)).toBe(SHEPARD_PROCESSOR_NAME);
    expect(handle.output).toBe(handle.node);
    expect(val(handle.speedParam)).toBe(0.25);
    expect(val(handle.gainParam)).toBe(0.5);
    expect(opts(handle.node).outputChannelCount).toEqual([1]);
    expect(opts(handle.node).numberOfInputs).toBe(0);
  });

  it('applies options: signed speed passes through; gain clamps to 0..1', async () => {
    const ctx = new MockAudioContext();
    await registerShepardWorklet(asCtx(ctx));
    const handle = createShepardNode(asCtx(ctx), { speed: -2, gain: 5 });
    expect(val(handle.speedParam)).toBe(-2); // signed (descending), unclamped by the module
    expect(val(handle.gainParam)).toBe(1); // clamped 0..1
  });

  it('throws ShepardError when created before registration resolved', () => {
    const ctx = new MockAudioContext();
    expect(() => createShepardNode(asCtx(ctx))).toThrow(ShepardError);
  });

  it('disconnect() disconnects the node from all targets', async () => {
    const ctx = new MockAudioContext();
    await registerShepardWorklet(asCtx(ctx));
    const handle = createShepardNode(asCtx(ctx));
    handle.disconnect();
    expect(disconnects(handle.node)).toBeGreaterThan(0);
  });
});
