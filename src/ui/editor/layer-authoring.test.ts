// Phase-2 layer-authoring UI tests (design §17, edge L). LayerList is props-driven; the
// LayerInspector reads/writes through the real SessionStore (via the test-harness context),
// so these assert OBSERVABLE preset state after a click — not implementation. Purity: the
// controls are one-way (value in, store method out), never a bind:value to the preset.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, fireEvent, cleanup } from '@testing-library/svelte';
import { tick } from 'svelte';
import { APP_CONTEXT_KEY } from '../context';
import { makeAppContext, makeFakeTransport } from '../test-harness';
import type { AppContext } from '../context';
import type { Layer } from '../../engine/session-model';
import LayerList from './LayerList.svelte';
import LayerInspector from './LayerInspector.svelte';

afterEach(cleanup);

function ctxRender<P extends Record<string, unknown>>(Comp: unknown, props: P, ctx?: AppContext) {
  const context = ctx ?? makeAppContext(makeFakeTransport());
  const result = render(Comp as never, { props: props as never, context: new Map([[APP_CONTEXT_KEY, context]]) });
  return { ctx: context, ...result };
}

function toneLayer(over: Partial<Layer> = {}): Layer {
  return {
    id: 'l1',
    kind: 'tone',
    source: { synth: { shape: 'sine', freqHz: 528, attackSec: 0.005, releaseSec: 3 } },
    t: 12,
    loop: false,
    ...over,
  };
}

describe('LayerList (§17.1)', () => {
  it('renders kind badge + source summary + formatted start t + loop indicator', () => {
    const layers = [toneLayer(), { id: 'l2', kind: 'ambiance' as const, source: { clipId: 'c1' }, t: 0, loop: true }];
    const { getByText, getAllByText } = render(LayerList, {
      layers,
      selectedId: null,
      onadd: vi.fn(),
      onedit: vi.fn(),
      onremove: vi.fn(),
    });
    expect(getAllByText('tone').length).toBeGreaterThan(0); // badge
    expect(getByText(/528 Hz/)).toBeInTheDocument(); // synth source summary
    expect(getByText(/0:12/)).toBeInTheDocument(); // start t (12s → 0:12)
    expect(getByText('loop')).toBeInTheDocument(); // ambiance loop indicator
  });

  it('Add offers the three kinds and forwards onadd(kind)', async () => {
    const onadd = vi.fn();
    const { getByRole } = render(LayerList, { layers: [], selectedId: null, onadd, onedit: vi.fn(), onremove: vi.fn() });
    await fireEvent.click(getByRole('button', { name: '+ tone' }));
    await fireEvent.click(getByRole('button', { name: '+ ambiance' }));
    await fireEvent.click(getByRole('button', { name: '+ voice' }));
    expect(onadd.mock.calls.map((c) => c[0])).toEqual(['tone', 'ambiance', 'voice']);
  });

  it('an unbound clip layer shows "Pick a clip" in the row source summary (L7)', () => {
    const { getByText } = render(LayerList, {
      layers: [{ id: 'l3', kind: 'voice', source: { clipId: '' }, t: 0 }],
      selectedId: null,
      onadd: vi.fn(),
      onedit: vi.fn(),
      onremove: vi.fn(),
    });
    expect(getByText('Pick a clip')).toBeInTheDocument();
  });

  it('forwards edit + remove by id', async () => {
    const onedit = vi.fn();
    const onremove = vi.fn();
    const { getByRole } = render(LayerList, {
      layers: [toneLayer()],
      selectedId: null,
      onadd: vi.fn(),
      onedit,
      onremove,
    });
    await fireEvent.click(getByRole('button', { name: /528 Hz/ }));
    expect(onedit).toHaveBeenCalledWith('l1');
    await fireEvent.click(getByRole('button', { name: /Remove tone layer/ }));
    expect(onremove).toHaveBeenCalledWith('l1');
  });
});

describe('LayerInspector (§17.2/§17.3)', () => {
  it('round-trips kind (tone→ambiance swaps source to a clip and forces loop, L3)', async () => {
    const ctx = makeAppContext(makeFakeTransport());
    ctx.session.addLayer('tone');
    const id = ctx.session.preset.layers![0].id;
    const { getByRole } = ctxRender(LayerInspector, { layerId: id }, ctx);
    await fireEvent.click(getByRole('button', { name: 'ambiance' }));
    const layer = ctx.session.preset.layers![0];
    expect('clipId' in layer.source).toBe(true);
    expect(layer.loop).toBe(true);
  });

  it('edits the ToneSpec freq through the store (clamped, one-way)', async () => {
    const ctx = makeAppContext(makeFakeTransport());
    ctx.session.addLayer('tone');
    const id = ctx.session.preset.layers![0].id;
    const { getByLabelText } = ctxRender(LayerInspector, { layerId: id }, ctx);
    const freq = getByLabelText('Tone frequency') as HTMLInputElement;
    await fireEvent.change(freq, { target: { value: '440' } });
    expect((ctx.session.preset.layers![0].source as { synth: { freqHz: number } }).synth.freqHz).toBe(440);
  });

  it('an unbound clip layer shows the "Pick a clip" flag and blocks-save messaging (L7)', () => {
    const ctx = makeAppContext(makeFakeTransport());
    ctx.session.addLayer('voice'); // unbound clip source
    const id = ctx.session.preset.layers![0].id;
    const { getByTestId } = ctxRender(LayerInspector, { layerId: id }, ctx);
    expect(getByTestId('unbound-flag')).toBeInTheDocument();
  });

  it('a clipId missing on this device shows the row flag without blocking edit (L8)', async () => {
    const ctx = makeAppContext(makeFakeTransport());
    ctx.session.addLayer('voice');
    const id = ctx.session.preset.layers![0].id;
    ctx.session.setLayerSource(id, { clipId: 'clip_gone' }); // bound, but not in the (empty) library
    const { getByTestId } = ctxRender(LayerInspector, { layerId: id }, ctx);
    await tick();
    expect(getByTestId('missing-flag')).toBeInTheDocument();
  });

  it('adds a gain lane point through the store, clamped to {0,1}', async () => {
    const ctx = makeAppContext(makeFakeTransport());
    ctx.session.addLayer('tone');
    const id = ctx.session.preset.layers![0].id;
    const { getAllByRole } = ctxRender(LayerInspector, { layerId: id }, ctx);
    const addButtons = getAllByRole('button', { name: '+ point' }); // gain + spatial lanes
    await fireEvent.click(addButtons[0]); // the gain lane's add
    expect(ctx.session.preset.layers![0].gain?.length).toBe(1);
    const value = ctx.session.preset.layers![0].gain![0].value;
    expect(value).toBeGreaterThanOrEqual(0);
    expect(value).toBeLessThanOrEqual(1);
  });
});
