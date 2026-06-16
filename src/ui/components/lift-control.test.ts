import { describe, expect, it, vi, afterEach } from 'vitest';
import { render, fireEvent, cleanup } from '@testing-library/svelte';
import { APP_CONTEXT_KEY } from '../context';
import { makeAppContext, makeFakeTransport } from '../test-harness';
import LiftControl from './LiftControl.svelte';
import PlayerScreen from '../screens/PlayerScreen.svelte';

afterEach(cleanup);

// =====================================================================================
// LiftControl — the live overlay control commits OUT (the one-way rule); Direction maps
// to the SIGN of speed, Rate to its magnitude, Level to gain.
// =====================================================================================

describe('LiftControl — one-way commits', () => {
  it('toggling On commits the ascending lift (positive speed); Off commits null', async () => {
    const oncommit = vi.fn();
    const { getByRole } = render(LiftControl, { oncommit });

    await fireEvent.click(getByRole('checkbox', { name: 'Lift' })); // On
    expect(oncommit).toHaveBeenLastCalledWith({ speed: 0.25, gain: 0.4 }); // defaults, ascending

    await fireEvent.click(getByRole('checkbox', { name: 'Lift' })); // Off
    expect(oncommit).toHaveBeenLastCalledWith(null); // fade out + dispose
  });

  it('Descending flips the SIGN of speed (rising → return)', async () => {
    const oncommit = vi.fn();
    const { getByRole } = render(LiftControl, { oncommit });
    await fireEvent.click(getByRole('checkbox', { name: 'Lift' })); // enable first
    await fireEvent.click(getByRole('button', { name: /descending/i }));
    expect(oncommit).toHaveBeenLastCalledWith({ speed: -0.25, gain: 0.4 }); // negative speed
  });

  it('Rate sets the speed magnitude and Level sets the gain (only while enabled)', async () => {
    const oncommit = vi.fn();
    const { getByLabelText, getByRole } = render(LiftControl, { oncommit });

    // While OFF, moving a slider must not commit a lift (it stays disabled/silent).
    await fireEvent.input(getByLabelText('Lift rate'), { target: { value: '0.5' } });
    expect(oncommit).not.toHaveBeenCalled();

    await fireEvent.click(getByRole('checkbox', { name: 'Lift' })); // enable
    await fireEvent.input(getByLabelText('Lift rate'), { target: { value: '0.75' } });
    expect(oncommit).toHaveBeenLastCalledWith({ speed: 0.75, gain: 0.4 });
    await fireEvent.input(getByLabelText('Lift level'), { target: { value: '0.9' } });
    expect(oncommit).toHaveBeenLastCalledWith({ speed: 0.75, gain: 0.9 });
  });
});

// =====================================================================================
// PlayerScreen integration — the Lift control commits straight to transport.setLift
// =====================================================================================

describe('PlayerScreen — Lift overlay wiring', () => {
  it('toggling the Lift control commits through the store to transport.setLift', async () => {
    const transport = makeFakeTransport();
    const ctx = makeAppContext(transport);
    const { getByRole } = render(PlayerScreen, { context: new Map([[APP_CONTEXT_KEY, ctx]]) });

    await fireEvent.click(getByRole('checkbox', { name: 'Lift' }));
    expect(transport.setLift).toHaveBeenCalledWith({ speed: 0.25, gain: 0.4 });

    await fireEvent.click(getByRole('checkbox', { name: 'Lift' }));
    expect(transport.setLift).toHaveBeenLastCalledWith(null);
  });
});
