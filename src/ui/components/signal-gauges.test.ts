import { afterEach, describe, expect, it } from 'vitest';
import { tick } from 'svelte';
import { render, cleanup } from '@testing-library/svelte';
import { valueAt } from '../../engine/automation';
import { formatHz, formatPan } from '../lib/format';
import { APP_CONTEXT_KEY } from '../context';
import { makeAppContext, makeFakeTransport } from '../test-harness';
import SignalGauges from './SignalGauges.svelte';

afterEach(cleanup);

function renderGauges() {
  const transport = makeFakeTransport();
  const ctx = makeAppContext(transport);
  const result = render(SignalGauges, { context: new Map([[APP_CONTEXT_KEY, ctx]]) });
  return { ctx, transport, ...result };
}

describe('SignalGauges — live current-value readouts (read-only)', () => {
  it('shows the value each signal is driven to at the playhead (t=0)', async () => {
    const { ctx, transport, getByTestId } = renderGauges();
    transport.emit('tick', { positionSec: 0, durationSec: ctx.session.preset.durationSec, state: 'playing' });
    await tick();
    expect(getByTestId('gauge-carrier').textContent).toContain(formatHz(valueAt(ctx.session.preset, 'carrier', 0), 0));
    expect(getByTestId('gauge-spatial').textContent).toContain(formatPan(valueAt(ctx.session.preset, 'spatial', 0)));
  });

  it('follows the playhead as the carrier ramps between nodes', async () => {
    const { ctx, transport, getByTestId } = renderGauges();
    ctx.session.setNodeValue(0, 'carrier', 200);
    const i = Number(ctx.session.addNode(10, 'carrier'));
    ctx.session.setNodeValue(i, 'carrier', 400);
    await tick();

    transport.emit('tick', { positionSec: 0, durationSec: ctx.session.preset.durationSec, state: 'playing' });
    await tick();
    expect(getByTestId('gauge-carrier').textContent).toContain('200 Hz');

    transport.emit('tick', { positionSec: 10, durationSec: ctx.session.preset.durationSec, state: 'playing' });
    await tick();
    expect(getByTestId('gauge-carrier').textContent).toContain('400 Hz');
  });
});
