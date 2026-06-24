import { describe, expect, it, vi, afterEach } from 'vitest';
import { render, fireEvent, cleanup } from '@testing-library/svelte';
import { APP_CONTEXT_KEY } from '../context';
import { makeAppContext, makeFakeTransport } from '../test-harness';
import DriftButton from './DriftButton.svelte';
import PlayerScreen from '../screens/PlayerScreen.svelte';

afterEach(cleanup);

// =====================================================================================
// DriftButton — the sleep "drop me back to sleep" control. One tap commits OUT; disabled
// is honoured (no commit when not playing).
// =====================================================================================

describe('DriftButton — one-tap commit', () => {
  it('fires onpress when tapped', async () => {
    const onpress = vi.fn();
    const { getByRole } = render(DriftButton, { onpress });
    await fireEvent.click(getByRole('button', { name: /drift deeper/i }));
    expect(onpress).toHaveBeenCalledTimes(1);
  });

  it('renders disabled when not playing (the browser blocks the tap)', () => {
    const onpress = vi.fn();
    const { getByRole } = render(DriftButton, { onpress, disabled: true });
    expect(getByRole('button', { name: /drift deeper/i })).toBeDisabled();
  });

  it('reflects the engaged state (label + aria-pressed) when active', () => {
    const onpress = vi.fn();
    const { getByRole } = render(DriftButton, { onpress, active: true });
    const btn = getByRole('button', { name: /resurface/i });
    expect(btn).toHaveAttribute('aria-pressed', 'true');
    expect(btn).toHaveTextContent(/drifting deeper/i);
  });
});

// =====================================================================================
// PlayerScreen integration — the Drift button drives session.driftDeeper → transport
// =====================================================================================

describe('PlayerScreen — Drift deeper wiring', () => {
  it('tapping Drift deeper while playing retargets the transport to a transient overlay', async () => {
    const transport = makeFakeTransport();
    const ctx = makeAppContext(transport);
    transport.setState('playing'); // enable the button (mirrored by the playback store)
    const { getByRole } = render(PlayerScreen, { context: new Map([[APP_CONTEXT_KEY, ctx]]) });

    await fireEvent.click(getByRole('button', { name: /drift deeper/i }));
    expect(transport.retargetTo).toHaveBeenCalledTimes(1);
  });

  it('the Drift button is disabled (no retarget) while idle', async () => {
    const transport = makeFakeTransport();
    const ctx = makeAppContext(transport);
    const { getByRole } = render(PlayerScreen, { context: new Map([[APP_CONTEXT_KEY, ctx]]) });

    await fireEvent.click(getByRole('button', { name: /drift deeper/i }));
    expect(transport.retargetTo).not.toHaveBeenCalled();
  });
});
