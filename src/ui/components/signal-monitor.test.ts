import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, cleanup } from '@testing-library/svelte';
import { APP_CONTEXT_KEY } from '../context';
import { makeAppContext, makeFakeTransport } from '../test-harness';
import SignalMonitor from './SignalMonitor.svelte';

beforeEach(() => {
  // jsdom has no 2D canvas; return null cleanly so the render loop no-ops its draw.
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
  // Capture the rAF loop without running frames.
  vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1));
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('SignalMonitor — read-only live plots', () => {
  it('mounts a labeled canvas, starts the rAF loop, and tears down cleanly', () => {
    const ctx = makeAppContext(makeFakeTransport());
    const { getByLabelText, unmount } = render(SignalMonitor, { context: new Map([[APP_CONTEXT_KEY, ctx]]) });
    expect(getByLabelText('Live signal plots').tagName).toBe('CANVAS');
    expect(requestAnimationFrame).toHaveBeenCalled();
    expect(() => unmount()).not.toThrow();
  });
});
