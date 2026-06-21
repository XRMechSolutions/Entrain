import { afterEach, describe, expect, it, vi } from 'vitest';
import { tick } from 'svelte';
import { render, fireEvent, cleanup } from '@testing-library/svelte';
import {
  exportPreset,
  importPresetFromFile,
  listPresets,
  loadPreset,
  restoreDefaultPresets,
  savePreset,
  type PresetSummary,
} from '../../engine/persistence';
import { createDefaultPreset } from '../../engine/session-model';
import { APP_CONTEXT_KEY } from '../context';
import { makeAppContext, makeFakeTransport } from '../test-harness';
import LibraryScreen from './LibraryScreen.svelte';

vi.mock('../../engine/persistence', async (importActual) => {
  const actual = await importActual<typeof import('../../engine/persistence')>();
  return {
    ...actual,
    listPresets: vi.fn(() => []),
    savePreset: vi.fn(),
    exportPreset: vi.fn(() => 'evening.json'),
    importPresetFromFile: vi.fn(),
    seedDefaultPresets: vi.fn(() => []),
    restoreDefaultPresets: vi.fn(() => []),
    deletePreset: vi.fn(),
    loadPreset: vi.fn(),
  };
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function renderLibrary() {
  const ctx = makeAppContext(makeFakeTransport());
  const result = render(LibraryScreen, { context: new Map([[APP_CONTEXT_KEY, ctx]]) });
  return { ctx, ...result };
}

function summary(id: string, updatedAt: number): PresetSummary {
  return { id, name: id, durationSec: 60, nodeCount: 1, createdAt: 0, updatedAt };
}

describe('LibraryScreen (design §7)', () => {
  it('refreshes on mount and renders the persistence-sorted list', async () => {
    vi.mocked(listPresets).mockReturnValue([summary('Morning', 200), summary('Night', 100)]);
    const { getByText } = renderLibrary();
    await tick();
    expect(getByText('Morning')).toBeInTheDocument();
    expect(getByText('Night')).toBeInTheDocument();
  });

  it('New while dirty confirms discard, and only resets on confirm (edge K4)', async () => {
    const { ctx, getByRole } = renderLibrary();
    ctx.session.setName('edited'); // make it dirty
    const transport = ctx.transport;
    (transport.load as ReturnType<typeof vi.fn>).mockClear();

    vi.stubGlobal('confirm', vi.fn(() => false));
    await fireEvent.click(getByRole('button', { name: 'New' }));
    expect(transport.load).not.toHaveBeenCalled(); // aborted

    vi.stubGlobal('confirm', vi.fn(() => true));
    await fireEvent.click(getByRole('button', { name: 'New' }));
    expect(transport.load).toHaveBeenCalledTimes(1); // reset(createDefaultPreset()) → load
    expect(ctx.session.dirty).toBe(false);
  });

  it('Import runs importPresetFromFile directly in the click (gesture, edge E11)', async () => {
    vi.mocked(importPresetFromFile).mockResolvedValue({
      preset: createDefaultPreset(),
      migratedFrom: null,
      warnings: [],
      filename: 'x.json',
    });
    const { getByRole } = renderLibrary();
    await fireEvent.click(getByRole('button', { name: 'Import' }));
    expect(importPresetFromFile).toHaveBeenCalledTimes(1);
  });

  it('Export current runs exportPreset directly in the click and toasts the filename', async () => {
    const { getByRole, ctx } = renderLibrary();
    await fireEvent.click(getByRole('button', { name: 'Export current' }));
    expect(exportPreset).toHaveBeenCalledWith(ctx.session.preset);
    expect(ctx.notices.items.some((n) => /evening\.json/.test(n.message))).toBe(true);
  });

  it('Restore defaults calls restoreDefaultPresets and toasts the result (one-way)', async () => {
    vi.mocked(restoreDefaultPresets).mockReturnValue([summary('d1', 1), summary('d2', 2)]);
    const { getByRole, ctx } = renderLibrary();
    await fireEvent.click(getByRole('button', { name: 'Restore defaults' }));
    expect(restoreDefaultPresets).toHaveBeenCalledTimes(1);
    expect(ctx.notices.items.some((n) => n.severity === 'info' && /2/.test(n.message))).toBe(true);
  });

  it('Save current persists the working preset', async () => {
    vi.mocked(savePreset).mockReturnValue({ id: 's1', createdAt: 0, updatedAt: 1, preset: createDefaultPreset(), warnings: [] });
    const { getByRole, ctx } = renderLibrary();
    await fireEvent.click(getByRole('button', { name: 'Save' }));
    expect(savePreset).toHaveBeenCalledWith(ctx.session.preset, undefined);
  });

  it('opening a preset loads it and jumps to the Advanced editor', async () => {
    vi.mocked(listPresets).mockReturnValue([summary('Morning', 200)]);
    vi.mocked(loadPreset).mockReturnValue({ id: 'Morning', createdAt: 0, updatedAt: 200, preset: createDefaultPreset(), warnings: [] });
    const { ctx, getByText } = renderLibrary();
    await tick();
    expect(ctx.ui.tab).toBe('player'); // default screen
    await fireEvent.click(getByText('Morning')); // tap the preset row
    expect(ctx.session.selectedId).toBe('Morning'); // loaded as the working preset
    expect(ctx.ui.tab).toBe('editor'); // …and navigated to Advanced
  });

  it('cancelling the discard on a dirty open neither loads nor navigates', async () => {
    vi.mocked(listPresets).mockReturnValue([summary('Morning', 200)]);
    const { ctx, getByText } = renderLibrary();
    ctx.session.setName('edited'); // make it dirty
    await tick();
    vi.stubGlobal('confirm', vi.fn(() => false));
    await fireEvent.click(getByText('Morning'));
    expect(loadPreset).not.toHaveBeenCalled();
    expect(ctx.ui.tab).toBe('player'); // stayed put
  });
});
