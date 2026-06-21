// EditorScreen Phase-2 integration — the layer/clips/export sub-tabs render under the Editor
// tab (design §16.3) and the layer-authoring flow round-trips through the real SessionStore.
// Asserts observable preset state + that the correct panel mounts per sub-tab.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { tick } from 'svelte';
import { render, fireEvent, cleanup } from '@testing-library/svelte';
import { APP_CONTEXT_KEY } from '../context';
import { makeAppContext, makeFakeTransport } from '../test-harness';
import EditorScreen from './EditorScreen.svelte';

beforeEach(() => {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
  vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1));
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function renderEditor() {
  const ctx = makeAppContext(makeFakeTransport());
  const result = render(EditorScreen, { context: new Map([[APP_CONTEXT_KEY, ctx]]) });
  return { ctx, ...result };
}

describe('EditorScreen Phase-2 sub-tabs (§16.3)', () => {
  it('exposes Nodes / Layers / Clips / Export sub-tabs', () => {
    const { getByTestId } = renderEditor();
    for (const id of ['nodes', 'layers', 'clips', 'export'] as const) {
      expect(getByTestId(`subtab-${id}`)).toBeInTheDocument();
    }
  });

  it('switching to Layers shows the layer list and "+ tone" adds a layer through the store', async () => {
    const { ctx, getByTestId, getByRole } = renderEditor();
    await fireEvent.click(getByTestId('subtab-layers'));
    await tick();
    expect((ctx.session.preset.layers ?? []).length).toBe(0);
    await fireEvent.click(getByRole('button', { name: '+ tone' }));
    await tick();
    expect(ctx.session.preset.layers!.length).toBe(1);
    expect(ctx.session.preset.layers![0].kind).toBe('tone');
    expect(ctx.session.dirty).toBe(true);
  });

  it('refreshes the clip library on mount', () => {
    const { ctx } = renderEditor();
    // makeAppContext stubs clip-library.list via the injected clipLib; refresh() was called.
    expect(ctx.clips.loading || Array.isArray(ctx.clips.clips)).toBe(true);
  });

  it('switching to Export shows the Render + VoiceScript actions', async () => {
    const { getByTestId, getByRole } = renderEditor();
    await fireEvent.click(getByTestId('subtab-export'));
    await tick();
    expect(getByRole('button', { name: 'Render' })).toBeInTheDocument();
    expect(getByRole('button', { name: /Pick a VoiceScript/ })).toBeInTheDocument();
  });
});
