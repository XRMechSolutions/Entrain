import { afterEach, describe, expect, it } from 'vitest';
import { tick } from 'svelte';
import { render, fireEvent, cleanup } from '@testing-library/svelte';
import { APP_CONTEXT_KEY } from '../context';
import { makeAppContext } from '../test-harness';
import type { TimeNode } from '../../engine/session-model';
import NodeInspector from './NodeInspector.svelte';

afterEach(cleanup);

function renderInspector(pick: (ctx: ReturnType<typeof makeAppContext>) => TimeNode = (ctx) => ctx.session.preset.nodes[0]) {
  const ctx = makeAppContext();
  const node = pick(ctx);
  const result = render(NodeInspector, {
    props: { node },
    context: new Map([[APP_CONTEXT_KEY, ctx]]),
  });
  return { ctx, node, ...result };
}

describe('NodeInspector — the start node is pinned (edge J2)', () => {
  it('disables Remove and shows the time as 0:00 · start (cannot move/remove)', () => {
    const { getByRole, getByLabelText } = renderInspector();
    expect(getByRole('button', { name: 'Pinned' })).toBeDisabled();
    expect((getByLabelText('Start node time') as HTMLElement).textContent).toMatch(/0:00/);
  });
});

describe('NodeInspector — add-param affordance (a node gains a keyframe it lacked)', () => {
  it('adds a carry-forward beat keyframe to a node that only sets carrier', async () => {
    const { ctx, getByTestId } = renderInspector((c) => {
      const idx = Number(c.session.addNode(120, 'carrier'));
      return c.session.preset.nodes[idx];
    });
    const node = ctx.session.preset.nodes.find((n) => n.t === 120)!;
    expect(node.beat).toBeUndefined();

    await fireEvent.click(getByTestId('add-param-beat'));
    await tick();
    // carry-forward value (node 0's beat is 8), in range, sound unchanged
    expect(node.beat?.value).toBeCloseTo(8, 6);
  });
});

describe('NodeInspector — editable node time → moveNode', () => {
  it('committing a mm:ss time moves the node (the start node stays pinned)', async () => {
    const { ctx, getByLabelText } = renderInspector((c) => {
      const idx = Number(c.session.addNode(120, 'carrier'));
      return c.session.preset.nodes[idx];
    });
    const node = ctx.session.preset.nodes.find((n) => n.t === 120)!;
    await fireEvent.change(getByLabelText('Node time'), { target: { value: '0:30' } });
    await tick();
    expect(node.t).toBe(30);
  });
});

describe('NodeInspector — selection robust to reorder (identity, not index)', () => {
  it('after a time move re-sorts the array, edits still target the SAME node', async () => {
    // start(0), A(100), B(200); inspect B by identity.
    const { ctx, getByLabelText } = renderInspector((c) => {
      c.session.addNode(100, 'carrier');
      const idxB = Number(c.session.addNode(200, 'carrier'));
      return c.session.preset.nodes[idxB];
    });
    const nodeB = ctx.session.preset.nodes.find((n) => n.t === 200)!;

    // Move B to t=30 — it now sorts BEFORE the t=100 node (its index changes).
    await fireEvent.change(getByLabelText('Node time'), { target: { value: '0:30' } });
    await tick();
    expect(nodeB.t).toBe(30);

    // Editing carrier must still write to B (re-resolved by identity), not the node now at B's old index.
    await fireEvent.change(getByLabelText('Carrier value'), { target: { value: '321' } });
    await tick();
    expect(nodeB.carrier?.value).toBe(321);
    // the node at t=100 is untouched (still its carry-forward default)
    expect(ctx.session.preset.nodes.find((n) => n.t === 100)!.carrier?.value).toBe(200);
  });
});

describe('NodeInspector — exp transition greyed when ramping through 0 (mirrors EXP_RAMP_THROUGH_ZERO)', () => {
  it('disables the exp option for a param whose value is 0', async () => {
    const { getAllByRole } = renderInspector((c) => {
      c.session.setNodeValue(0, 'volume', 0);
      return c.session.preset.nodes[0];
    });
    await tick();
    const expOptions = getAllByRole('option', { name: 'exp', hidden: true }) as HTMLOptionElement[];
    expect(expOptions.some((o) => o.disabled)).toBe(true);
  });
});
