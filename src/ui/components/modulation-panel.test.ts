import { afterEach, describe, expect, it } from 'vitest';
import { tick } from 'svelte';
import { render, fireEvent, cleanup } from '@testing-library/svelte';
import { APP_CONTEXT_KEY } from '../context';
import { makeAppContext } from '../test-harness';
import type { AutomatableParam } from '../../engine/session-model';
import ModulationPanel from './ModulationPanel.svelte';

afterEach(cleanup);

function renderPanel(param: AutomatableParam) {
  const ctx = makeAppContext();
  const result = render(ModulationPanel, {
    props: { param },
    context: new Map([[APP_CONTEXT_KEY, ctx]]),
  });
  return { ctx, ...result };
}

const modOf = (ctx: ReturnType<typeof makeAppContext>, p: AutomatableParam) => ctx.session.preset.nodes[0][p]?.mod;

describe('ModulationPanel — index prop targets that node (not always node 0)', () => {
  it('edits nodes[index].<param>.mod, leaving node 0 untouched', async () => {
    const ctx = makeAppContext();
    const idx = Number(ctx.session.addNode(120, 'carrier')); // a second node
    const { getByLabelText } = render(ModulationPanel, {
      props: { param: 'carrier' as AutomatableParam, index: idx },
      context: new Map([[APP_CONTEXT_KEY, ctx]]),
    });
    expect(ctx.session.preset.nodes[idx].carrier?.mod).toBeUndefined();

    await fireEvent.click(getByLabelText('Warble enabled'));
    await tick();
    expect(ctx.session.preset.nodes[idx].carrier?.mod).toMatchObject({ shape: 'sine' });
    expect(ctx.session.preset.nodes[0].carrier?.mod).toBeUndefined(); // node 0 not touched
  });

  it('defaults to index 0 (the console keeps editing node 0)', async () => {
    const { ctx, getByLabelText } = renderPanel('carrier');
    await fireEvent.click(getByLabelText('Warble enabled'));
    await tick();
    expect(ctx.session.preset.nodes[0].carrier?.mod).toMatchObject({ shape: 'sine' });
  });
});

describe('ModulationPanel — on/off three-state (sets a ModPoint / clears to null)', () => {
  it('toggling on writes a default ModPoint to node 0; toggling off clears it to null', async () => {
    const { ctx, getByLabelText } = renderPanel('carrier');
    expect(modOf(ctx, 'carrier')).toBeUndefined(); // off (carry) by default

    await fireEvent.click(getByLabelText('Warble enabled'));
    await tick();
    expect(modOf(ctx, 'carrier')).toMatchObject({ shape: 'sine', transition: 'glide' });

    await fireEvent.click(getByLabelText('Warble enabled'));
    await tick();
    expect(modOf(ctx, 'carrier')).toBeNull(); // explicit clear, NOT undefined
  });

  it('volume uses the "Isochronic pulse" label and a pulse default (pulse width + edge shown)', async () => {
    const { ctx, getByLabelText } = renderPanel('volume');
    await fireEvent.click(getByLabelText('Isochronic pulse enabled'));
    await tick();
    expect(modOf(ctx, 'volume')).toMatchObject({ shape: 'pulse' });
    expect(getByLabelText('Pulse width value')).toBeInTheDocument();
    expect(getByLabelText('Edge value')).toBeInTheDocument();
  });
});

describe('ModulationPanel — rate ↔ periodSec conversion (periodSec = 1/rateHz)', () => {
  it('committing a rate in Hz writes periodSec = 1/rate', async () => {
    const { ctx, getByLabelText } = renderPanel('carrier');
    await fireEvent.click(getByLabelText('Warble enabled'));
    await tick();
    await fireEvent.change(getByLabelText('Rate value'), { target: { value: '2' } });
    await tick();
    expect(modOf(ctx, 'carrier')?.periodSec).toBeCloseTo(0.5, 6);

    await fireEvent.change(getByLabelText('Rate value'), { target: { value: '10' } });
    await tick();
    expect(modOf(ctx, 'carrier')?.periodSec).toBeCloseTo(0.1, 6);
  });

  it('shows the cycle time in seconds beside the Hz rate (so a sweep reads as a breathing cadence)', async () => {
    const { getByLabelText, getByTestId } = renderPanel('spatial');
    await fireEvent.click(getByLabelText('Warble enabled'));
    await tick();
    // default spatial sweep periodSec = 5 → 0.2 Hz ≈ "5.00 s per cycle"
    expect(getByTestId('mod-cycle-spatial').textContent).toMatch(/5\.00 s/);

    // dial a 16 s box-breath cadence (0.0625 Hz) and the readout follows
    await fireEvent.change(getByLabelText('Rate value'), { target: { value: '0.0625' } });
    await tick();
    expect(getByTestId('mod-cycle-spatial').textContent).toMatch(/16\.0 s/);
  });

  it('clamps an out-of-range rate so periodSec stays finite and > 0', async () => {
    const { ctx, getByLabelText } = renderPanel('carrier');
    await fireEvent.click(getByLabelText('Warble enabled'));
    await tick();
    // ParamControl clamps to the slider max (40 Hz) → periodSec = 1/40 = 0.025
    await fireEvent.change(getByLabelText('Rate value'), { target: { value: '5000' } });
    await tick();
    const ps = modOf(ctx, 'carrier')?.periodSec ?? 0;
    expect(ps).toBeGreaterThan(0);
    expect(ps).toBeCloseTo(0.025, 6);
  });
});

describe('ModulationPanel — shape / depth / transition commit through the session store', () => {
  it('changing shape, depth and transition mutates node 0 via setNodeMod', async () => {
    const { ctx, getByLabelText } = renderPanel('beat');
    await fireEvent.click(getByLabelText('Warble enabled'));
    await tick();

    await fireEvent.change(getByLabelText('Warble shape'), { target: { value: 'square' } });
    await tick();
    expect(modOf(ctx, 'beat')?.shape).toBe('square');

    await fireEvent.change(getByLabelText('Depth value'), { target: { value: '0.35' } });
    await tick();
    expect(modOf(ctx, 'beat')?.depth).toBeCloseTo(0.35, 6);

    await fireEvent.change(getByLabelText('Warble transition'), { target: { value: 'jump' } });
    await tick();
    expect(modOf(ctx, 'beat')?.transition).toBe('jump');
  });
});

describe('ModulationPanel — steps editor (the explicit jump list)', () => {
  it('adds, edits and removes steps clamped to the param range', async () => {
    const { ctx, getByTestId, getByLabelText, queryByLabelText } = renderPanel('carrier');
    await fireEvent.click(getByLabelText('Warble enabled'));
    await tick();
    await fireEvent.change(getByLabelText('Warble transition'), { target: { value: 'jump' } });
    await tick();

    // first add seeds from the base carrier value (200)
    await fireEvent.click(getByTestId('mod-add-step-carrier'));
    await tick();
    expect(modOf(ctx, 'carrier')?.steps).toEqual([200]);

    await fireEvent.click(getByTestId('mod-add-step-carrier'));
    await tick();
    expect(modOf(ctx, 'carrier')?.steps).toEqual([200, 200]);

    // edit step 1 above the carrier max (1000) → clamps to 1000
    await fireEvent.change(getByLabelText('Warble step 1'), { target: { value: '5000' } });
    await tick();
    expect(modOf(ctx, 'carrier')?.steps).toEqual([1000, 200]);

    // remove step 1 → only the second remains
    await fireEvent.click(getByLabelText('Remove step 1'));
    await tick();
    expect(modOf(ctx, 'carrier')?.steps).toEqual([200]);

    // removing the last step drops the steps array entirely (never an empty [])
    await fireEvent.click(getByLabelText('Remove step 1'));
    await tick();
    expect(modOf(ctx, 'carrier')?.steps).toBeUndefined();
    expect(queryByLabelText('Warble step 1')).not.toBeInTheDocument();
  });
});

describe('ModulationPanel — box (breath) shape controls', () => {
  it('selecting box shows a Hold control and hides pulse width + edge', async () => {
    const { ctx, getByLabelText, queryByLabelText } = renderPanel('carrier');
    await fireEvent.click(getByLabelText('Warble enabled'));
    await tick();

    await fireEvent.change(getByLabelText('Warble shape'), { target: { value: 'box' } });
    await tick();
    expect(modOf(ctx, 'carrier')?.shape).toBe('box');

    expect(getByLabelText('Hold value')).toBeInTheDocument(); // hold ratio (pulseWidth)
    expect(getByLabelText('Rate value')).toBeInTheDocument(); // rate stays
    expect(getByLabelText('Depth value')).toBeInTheDocument(); // depth stays
    expect(queryByLabelText('Pulse width value')).not.toBeInTheDocument();
    expect(queryByLabelText('Edge value')).not.toBeInTheDocument();
  });

  it('committing Hold writes pulseWidth (the hold ratio) through setNodeMod', async () => {
    const { ctx, getByLabelText } = renderPanel('carrier');
    await fireEvent.click(getByLabelText('Warble enabled'));
    await tick();
    await fireEvent.change(getByLabelText('Warble shape'), { target: { value: 'box' } });
    await tick();

    await fireEvent.change(getByLabelText('Hold value'), { target: { value: '0.25' } });
    await tick();
    expect(modOf(ctx, 'carrier')?.pulseWidth).toBeCloseTo(0.25, 6);
  });

  it('hides the steps editor for box even when transition is jump', async () => {
    const { ctx, getByLabelText, queryByTestId } = renderPanel('carrier');
    await fireEvent.click(getByLabelText('Warble enabled'));
    await tick();
    await fireEvent.change(getByLabelText('Warble shape'), { target: { value: 'box' } });
    await tick();
    await fireEvent.change(getByLabelText('Warble transition'), { target: { value: 'jump' } });
    await tick();
    expect(modOf(ctx, 'carrier')?.transition).toBe('jump');
    expect(queryByTestId('mod-add-step-carrier')).not.toBeInTheDocument();
  });

  it('offers box (breath) in the shape selector for the volume lane too', async () => {
    const { ctx, getByLabelText } = renderPanel('volume');
    await fireEvent.click(getByLabelText('Isochronic pulse enabled'));
    await tick();
    await fireEvent.change(getByLabelText('Isochronic pulse shape'), { target: { value: 'box' } });
    await tick();
    expect(modOf(ctx, 'volume')?.shape).toBe('box');
    expect(getByLabelText('Hold value')).toBeInTheDocument();
  });
});

describe('ModulationPanel — one-way (never binds the preset; stays a plain object)', () => {
  it('after edits the working preset is still structuredClone-safe (no $state proxy)', async () => {
    const { ctx, getByLabelText } = renderPanel('carrier');
    await fireEvent.click(getByLabelText('Warble enabled'));
    await tick();
    const clone = structuredClone(ctx.session.preset); // throws if a reactive proxy leaked in
    expect(clone.nodes[0].carrier?.mod).toMatchObject({ shape: 'sine' });
  });
});
