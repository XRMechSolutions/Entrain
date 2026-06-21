import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { tick } from 'svelte';
import { render, fireEvent, cleanup } from '@testing-library/svelte';
import { APP_CONTEXT_KEY } from '../context';
import { makeAppContext, makeFakeTransport, type FakeTransport } from '../test-harness';
import PlayerScreen from './PlayerScreen.svelte';

beforeEach(() => {
  // The monitor mounts a <canvas>; jsdom has no 2D context, so return null cleanly to avoid
  // the not-implemented notice (the render loop no-ops its draw).
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
});
afterEach(cleanup);

function renderPlayer(transport: FakeTransport = makeFakeTransport()) {
  const ctx = makeAppContext(transport);
  const result = render(PlayerScreen, { context: new Map([[APP_CONTEXT_KEY, ctx]]) });
  return { ctx, ...result };
}

// The Player page is now a READ-ONLY "now playing" monitor: live plots (SignalMonitor) + live
// value gauges (SignalGauges). The play gesture / scrubber / Stop live in the global
// TransportBar (transport-bar.test.ts); signal shaping moved to the Advanced editor.

describe('PlayerScreen — read-only live monitor', () => {
  it('renders the live signal plots and the current-value gauges', () => {
    const { getByLabelText, getByTestId } = renderPlayer();
    expect(getByLabelText('Live signal plots')).toBeInTheDocument(); // the <canvas>
    expect(getByTestId('gauge-carrier')).toBeInTheDocument();
    expect(getByTestId('gauge-beat')).toBeInTheDocument();
    expect(getByTestId('gauge-volume')).toBeInTheDocument();
    expect(getByTestId('gauge-spatial')).toBeInTheDocument();
  });

  it('does NOT expose signal-shaping controls (those moved to Advanced)', () => {
    const { queryByLabelText } = renderPlayer();
    expect(queryByLabelText('Carrier value')).toBeNull();
    expect(queryByLabelText('Beat value')).toBeNull();
  });
});

describe('PlayerScreen — playback controls (not signal shaping)', () => {
  it('master volume streams to setMasterTrim with NO reschedule (design §6.1)', async () => {
    const transport = makeFakeTransport();
    const { getByLabelText } = renderPlayer(transport);
    await fireEvent.input(getByLabelText('Master volume'), { target: { value: '0.5' } });
    expect(transport.setMasterTrim).toHaveBeenCalledWith(0.5);
    expect(transport.reapply).not.toHaveBeenCalled();
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
    // the permanent caption on the monitor is unaffected
    expect(getByText(/Use headphones for the binaural effect/i)).toBeInTheDocument();
  });
});
