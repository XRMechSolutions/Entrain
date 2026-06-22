import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { tick } from 'svelte';
import { render, fireEvent, cleanup } from '@testing-library/svelte';
import { APP_CONTEXT_KEY } from '../context';
import { makeAppContext, makeFakeTransport, type FakeTransport } from '../test-harness';
import PlayerScreen from './PlayerScreen.svelte';
import type { Preset } from '../../engine/session-model';

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
  it('the dismissible banner closes on ✕ while the binaural notice remains', async () => {
    // default preset has beat=8 → hasBinauralVoice=true → HeadphoneNotice is shown
    const { getByLabelText, queryByText, getByTestId } = renderPlayer();
    expect(getByTestId('binaural-notice')).toBeInTheDocument();
    expect(queryByText(/commonly used for the binaural effect/i)).toBeInTheDocument();

    await fireEvent.click(getByLabelText('Dismiss headphone reminder'));
    await tick();

    expect(queryByText(/commonly used for the binaural effect/i)).not.toBeInTheDocument();
    // the binaural notice is permanent and not affected by dismissal
    expect(getByTestId('binaural-notice')).toBeInTheDocument();
  });
});

describe('PlayerScreen — binaural notice (perf-safety §4)', () => {
  it('shows for the default preset (beat=8 at t=0)', () => {
    const { getByTestId } = renderPlayer();
    expect(getByTestId('binaural-notice')).toBeInTheDocument();
  });

  it('hidden for an isochronic-only preset (beat=0 everywhere); generic caption shown instead', async () => {
    const { ctx, queryByTestId, getByText } = renderPlayer();
    const isoPreset: Preset = {
      schemaVersion: 6,
      name: 'Iso only',
      durationSec: 300,
      masterGain: 0.8,
      nodes: [{ t: 0, carrier: { value: 200 }, beat: { value: 0 }, volume: { value: 1 } }],
    };
    ctx.session.reset(isoPreset);
    await tick();
    expect(queryByTestId('binaural-notice')).not.toBeInTheDocument();
    expect(getByText(/Use headphones for the binaural effect/i)).toBeInTheDocument();
  });

  it('shows when a keyframed beat is 0 at t=0 but > 0 later', async () => {
    const { ctx, getByTestId } = renderPlayer();
    const delayedBeatPreset: Preset = {
      schemaVersion: 6,
      name: 'Delayed beat',
      durationSec: 300,
      masterGain: 0.8,
      nodes: [
        { t: 0, carrier: { value: 200 }, beat: { value: 0 }, volume: { value: 1 } },
        { t: 60, beat: { value: 4 } },
      ],
    };
    ctx.session.reset(delayedBeatPreset);
    await tick();
    expect(getByTestId('binaural-notice')).toBeInTheDocument();
  });

  it('shows when an extra voice has beat > 0 even if the primary voice does not', async () => {
    const { ctx, getByTestId } = renderPlayer();
    const extraVoiceBinauralPreset: Preset = {
      schemaVersion: 6,
      name: 'Extra voice binaural',
      durationSec: 300,
      masterGain: 0.8,
      nodes: [{ t: 0, carrier: { value: 200 }, beat: { value: 0 }, volume: { value: 1 } }],
      voices: [{ id: 'v1', nodes: [{ t: 0, carrier: { value: 300 }, beat: { value: 6 }, volume: { value: 1 } }] }],
    };
    ctx.session.reset(extraVoiceBinauralPreset);
    await tick();
    expect(getByTestId('binaural-notice')).toBeInTheDocument();
  });
});
