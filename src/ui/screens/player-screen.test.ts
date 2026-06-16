import { afterEach, describe, expect, it } from 'vitest';
import { tick } from 'svelte';
import { render, fireEvent, cleanup } from '@testing-library/svelte';
import { APP_CONTEXT_KEY } from '../context';
import { makeAppContext, makeFakeTransport, type FakeTransport } from '../test-harness';
import PlayerScreen from './PlayerScreen.svelte';

afterEach(cleanup);

function renderPlayer(transport: FakeTransport = makeFakeTransport()) {
  const ctx = makeAppContext(transport);
  const result = render(PlayerScreen, { context: new Map([[APP_CONTEXT_KEY, ctx]]) });
  return { ctx, ...result };
}

describe('PlayerScreen — the play gesture (design §5, edge A1)', () => {
  it('clicking the primary button (idle) calls transport.play() and never awaits before it', async () => {
    const transport = makeFakeTransport();
    const { getByRole } = renderPlayer(transport);
    await fireEvent.click(getByRole('button', { name: 'Play' }));
    expect(transport.play).toHaveBeenCalledTimes(1);
  });

  it('reflects state: pauses when playing', async () => {
    const transport = makeFakeTransport();
    const { getByRole } = renderPlayer(transport);
    transport.setState('playing');
    await tick();
    await fireEvent.click(getByRole('button', { name: 'Pause' }));
    expect(transport.pause).toHaveBeenCalledTimes(1);
  });

  it('WEB_AUDIO_UNSUPPORTED disables the primary button (edge A4)', async () => {
    const transport = makeFakeTransport();
    const { getByRole } = renderPlayer(transport);
    transport.emit('error', { code: 'WEB_AUDIO_UNSUPPORTED', message: 'no audio' });
    await tick();
    expect(getByRole('button', { name: 'Play' })).toBeDisabled();
  });
});

describe('PlayerScreen — one-way controls (the inviolable rule)', () => {
  it('master volume streams to setMasterTrim with NO reschedule (design §6.1)', async () => {
    const transport = makeFakeTransport();
    const { getByLabelText } = renderPlayer(transport);
    await fireEvent.input(getByLabelText('Master volume'), { target: { value: '0.5' } });
    expect(transport.setMasterTrim).toHaveBeenCalledWith(0.5);
    expect(transport.reapply).not.toHaveBeenCalled();
  });

  it('a committed carrier edit while playing reschedules via reapply (NOT seek, design §6.3)', async () => {
    const transport = makeFakeTransport();
    const { getByLabelText } = renderPlayer(transport);
    transport.setState('playing');
    await tick();
    await fireEvent.change(getByLabelText('Carrier value'), { target: { value: '250' } });
    expect(transport.reapply).toHaveBeenCalledTimes(1);
    expect(transport.seek).not.toHaveBeenCalled();
  });

  it('scrubber drag sets ui.scrubbing so the tick is suppressed (edge C1)', async () => {
    const { ctx, getByLabelText } = renderPlayer();
    await fireEvent.pointerDown(getByLabelText('Seek position'));
    expect(ctx.ui.scrubbing).toBe(true);
  });
});

describe('PlayerScreen — headphone reminder (design §8)', () => {
  it('the dismissible banner closes on ✕ while the permanent caption remains', async () => {
    const { getByLabelText, queryByText, getByText } = renderPlayer();
    expect(getByText(/commonly used for the binaural effect/i)).toBeInTheDocument();
    expect(getByText(/Use headphones for the binaural effect/i)).toBeInTheDocument();

    await fireEvent.click(getByLabelText('Dismiss headphone reminder'));
    await tick();

    expect(queryByText(/commonly used for the binaural effect/i)).not.toBeInTheDocument();
    // the permanent caption beneath the play button is unaffected
    expect(getByText(/Use headphones for the binaural effect/i)).toBeInTheDocument();
  });

  it('the first play also dismisses the reminder', async () => {
    const { ctx, getByRole } = renderPlayer();
    expect(ctx.ui.headphoneReminderSeen).toBe(false);
    await fireEvent.click(getByRole('button', { name: 'Play' }));
    expect(ctx.ui.headphoneReminderSeen).toBe(true);
  });
});
