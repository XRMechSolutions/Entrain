import { afterEach, describe, expect, it } from 'vitest';
import { tick } from 'svelte';
import { render, fireEvent, cleanup } from '@testing-library/svelte';
import { APP_CONTEXT_KEY } from '../context';
import { makeAppContext } from '../test-harness';
import type { AutomatableParam } from '../../engine/session-model';
import ParamSection from './ParamSection.svelte';

afterEach(cleanup);

function renderSection(props: { index: number; param: AutomatableParam; showInterpolation?: boolean }) {
  const ctx = makeAppContext();
  const result = render(ParamSection, {
    props,
    context: new Map([[APP_CONTEXT_KEY, ctx]]),
  });
  return { ctx, ...result };
}

describe('ParamSection — base value commits through the store at the given index', () => {
  it('committing the base slider writes nodes[index].<param>.value', async () => {
    const ctx = makeAppContext();
    const idx = Number(ctx.session.addNode(120, 'beat')); // a second node carrying beat
    const { getByLabelText } = render(ParamSection, {
      props: { index: idx, param: 'beat' as AutomatableParam, showInterpolation: true },
      context: new Map([[APP_CONTEXT_KEY, ctx]]),
    });
    await fireEvent.change(getByLabelText('Beat value'), { target: { value: '12' } });
    await tick();
    expect(ctx.session.preset.nodes[idx].beat?.value).toBe(12);
    // node 0 is NOT touched (parameterised by index)
    expect(ctx.session.preset.nodes[0].beat?.value).toBe(8);
  });
});

describe('ParamSection — interpolation selector (the transition into the next node)', () => {
  it('shown only when showInterpolation, and commits via setNodeTransition', async () => {
    const { ctx, getByTestId } = renderSection({ index: 0, param: 'carrier', showInterpolation: true });
    await fireEvent.change(getByTestId('interp-carrier'), { target: { value: 'smooth' } });
    await tick();
    expect(ctx.session.preset.nodes[0].carrier?.transition).toBe('smooth');
  });

  it('the console hides the interpolation selector (showInterpolation=false)', () => {
    const { queryByTestId } = renderSection({ index: 0, param: 'carrier', showInterpolation: false });
    expect(queryByTestId('interp-carrier')).not.toBeInTheDocument();
  });
});

describe('ParamSection — modulation panel is wired to the same node index', () => {
  it('toggling Warble sets the modulator on nodes[index]', async () => {
    const { ctx, getByLabelText } = renderSection({ index: 0, param: 'carrier', showInterpolation: true });
    await fireEvent.click(getByLabelText('Warble enabled'));
    await tick();
    expect(ctx.session.preset.nodes[0].carrier?.mod).toMatchObject({ shape: 'sine' });
  });
});

describe('ParamSection — bug #4: the control display resyncs to an EXTERNAL preset change', () => {
  it('a canvas-style setNodeValue updates the displayed base value (no stale control)', async () => {
    const { ctx, getByLabelText } = renderSection({ index: 0, param: 'beat', showInterpolation: false });
    const number = getByLabelText('Beat value') as HTMLInputElement;
    expect(number.value).toBe('8'); // default beat

    // Simulate a canvas drag moving this node's beat handle (an external commit).
    ctx.session.setNodeValue(0, 'beat', 12);
    await tick();
    expect(number.value).toBe('12'); // the control followed the preset, not stale
  });
});
