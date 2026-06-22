import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, fireEvent, cleanup, within } from '@testing-library/svelte';
import type { PresetSummary } from '../../engine/persistence';
import PresetListItem from './PresetListItem.svelte';
import PresetList from './PresetList.svelte';
import InstallPrompt from './InstallPrompt.svelte';
import UpdateToast from './UpdateToast.svelte';

afterEach(cleanup);

function summary(over: Partial<PresetSummary> = {}): PresetSummary {
  return { id: 'p1', name: 'Evening Calm', durationSec: 754, nodeCount: 3, voiceCount: 1, createdAt: 0, updatedAt: Date.now(), ...over };
}

describe('PresetListItem (design §7, interfaces §9)', () => {
  it('renders name, duration MM:SS, node count, and forwards row actions', async () => {
    const onopen = vi.fn();
    const onexport = vi.fn();
    const onremove = vi.fn();
    const { getByText, getByRole } = render(PresetListItem, {
      summary: summary(),
      selected: false,
      onopen,
      onexport,
      onremove,
    });
    expect(getByText('Evening Calm')).toBeInTheDocument();
    expect(getByText(/12:34/)).toBeInTheDocument(); // 754s → 12:34
    expect(getByText(/3 nodes/)).toBeInTheDocument();

    await fireEvent.click(getByRole('button', { name: /^Evening Calm/ }));
    expect(onopen).toHaveBeenCalledTimes(1);
    await fireEvent.click(getByRole('button', { name: /Export Evening Calm/ }));
    expect(onexport).toHaveBeenCalledTimes(1);
    await fireEvent.click(getByRole('button', { name: /Delete Evening Calm/ }));
    expect(onremove).toHaveBeenCalledTimes(1);
  });
});

describe('PresetList', () => {
  it('renders items in the given (persistence-sorted) order and forwards open by id', async () => {
    const onopen = vi.fn();
    const items = [summary({ id: 'a', name: 'A' }), summary({ id: 'b', name: 'B' })];
    const { getAllByRole } = render(PresetList, {
      items,
      selectedId: null,
      onopen,
      onexport: vi.fn(),
      onremove: vi.fn(),
    });
    const rows = getAllByRole('listitem');
    expect(within(rows[0]).getByText('A')).toBeInTheDocument();
    expect(within(rows[1]).getByText('B')).toBeInTheDocument();
    await fireEvent.click(within(rows[1]).getByRole('button', { name: /^B/ }));
    expect(onopen).toHaveBeenCalledWith('b');
  });

  it('shows an empty state when there are no presets', () => {
    const { getByText } = render(PresetList, {
      items: [],
      selectedId: null,
      onopen: vi.fn(),
      onexport: vi.fn(),
      onremove: vi.fn(),
    });
    expect(getByText(/No saved sessions yet/i)).toBeInTheDocument();
  });
});

describe('InstallPrompt (design §9, edge H)', () => {
  it('shows the install button only when canInstall', async () => {
    const oninstall = vi.fn();
    const { getByRole, rerender, queryByRole } = render(InstallPrompt, { canInstall: true, isIos: false, oninstall });
    await fireEvent.click(getByRole('button', { name: 'Install app' }));
    expect(oninstall).toHaveBeenCalledTimes(1);

    await rerender({ canInstall: false, isIos: false, oninstall });
    expect(queryByRole('button', { name: 'Install app' })).not.toBeInTheDocument();
  });

  it('shows the iOS A2HS card when isIos (and hides nothing when standalone — both false)', () => {
    const { getByText, container } = render(InstallPrompt, { canInstall: false, isIos: true, oninstall: vi.fn() });
    expect(getByText(/Add to Home Screen/i)).toBeInTheDocument();

    cleanup();
    const standalone = render(InstallPrompt, { canInstall: false, isIos: false, oninstall: vi.fn() });
    expect(standalone.container.textContent?.trim()).toBe('');
    void container;
  });
});

describe('UpdateToast (design §9, D-017, edge H5/H7)', () => {
  it('reloads ONLY on the explicit Reload click; ✕ dismisses without reloading', async () => {
    const onreload = vi.fn();
    const ondismiss = vi.fn();
    const { getByRole } = render(UpdateToast, { updateReady: true, offlineReady: false, onreload, ondismiss });
    expect(onreload).not.toHaveBeenCalled(); // never auto-reloads
    await fireEvent.click(getByRole('button', { name: 'Reload' }));
    expect(onreload).toHaveBeenCalledTimes(1);

    await fireEvent.click(getByRole('button', { name: 'Dismiss update' }));
    expect(ondismiss).toHaveBeenCalledTimes(1);
  });

  it('shows the one-time offline-ready toast and lets it be dismissed', async () => {
    const { getByText, queryByText, getByRole } = render(UpdateToast, {
      updateReady: false,
      offlineReady: true,
      onreload: vi.fn(),
      ondismiss: vi.fn(),
    });
    expect(getByText(/Ready to work offline/i)).toBeInTheDocument();
    await fireEvent.click(getByRole('button', { name: 'Dismiss' }));
    expect(queryByText(/Ready to work offline/i)).not.toBeInTheDocument();
  });
});
