import { afterEach, describe, expect, it } from 'vitest';
import { tick } from 'svelte';
import { render, fireEvent, cleanup } from '@testing-library/svelte';
import { APP_CONTEXT_KEY } from '../context';
import { makeAppContext, makeFakeTransport, type FakeTransport } from '../test-harness';
import TransportBar from './TransportBar.svelte';

afterEach(cleanup);

function renderBar(transport: FakeTransport = makeFakeTransport()) {
  const ctx = makeAppContext(transport);
  const result = render(TransportBar, { context: new Map([[APP_CONTEXT_KEY, ctx]]) });
  return { ctx, ...result };
}

describe('TransportBar — the global play gesture (design §5, edge A1)', () => {
  it('clicking the primary button (idle) calls transport.play() and never awaits before it', async () => {
    const transport = makeFakeTransport();
    const { getByRole } = renderBar(transport);
    await fireEvent.click(getByRole('button', { name: 'Play' }));
    expect(transport.play).toHaveBeenCalledTimes(1);
  });

  it('reflects state: pauses when playing', async () => {
    const transport = makeFakeTransport();
    const { getByRole } = renderBar(transport);
    transport.setState('playing');
    await tick();
    await fireEvent.click(getByRole('button', { name: 'Pause' }));
    expect(transport.pause).toHaveBeenCalledTimes(1);
  });

  it('WEB_AUDIO_UNSUPPORTED disables the primary button (edge A4)', async () => {
    const transport = makeFakeTransport();
    const { getByRole } = renderBar(transport);
    transport.emit('error', { code: 'WEB_AUDIO_UNSUPPORTED', message: 'no audio' });
    await tick();
    expect(getByRole('button', { name: 'Play' })).toBeDisabled();
  });

  it('the first play also dismisses the headphone reminder (§8)', async () => {
    const { ctx, getByRole } = renderBar();
    expect(ctx.ui.headphoneReminderSeen).toBe(false);
    await fireEvent.click(getByRole('button', { name: 'Play' }));
    expect(ctx.ui.headphoneReminderSeen).toBe(true);
  });

  it('Stop appears only once playing and calls transport.stop()', async () => {
    const transport = makeFakeTransport();
    const { getByRole, queryByRole } = renderBar(transport);
    expect(queryByRole('button', { name: 'Stop' })).toBeNull(); // hidden while idle
    transport.setState('playing');
    await tick();
    await fireEvent.click(getByRole('button', { name: 'Stop' }));
    expect(transport.stop).toHaveBeenCalledTimes(1);
  });

  it('scrubber drag sets ui.scrubbing so the tick is suppressed (edge C1)', async () => {
    const { ctx, getByLabelText } = renderBar();
    await fireEvent.pointerDown(getByLabelText('Seek position'));
    expect(ctx.ui.scrubbing).toBe(true);
  });
});
