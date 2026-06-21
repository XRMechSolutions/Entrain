import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { tick } from 'svelte';
import { render, cleanup } from '@testing-library/svelte';
import { APP_CONTEXT_KEY } from './context';
import { makeAppContext, makeFakeTransport } from './test-harness';
import App from './App.svelte';

beforeEach(() => {
  // The Advanced tab mounts a <canvas>; jsdom has no 2D context, so return null cleanly to
  // avoid the not-implemented notice (mirrors editor-screen.test.ts).
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
});

// Keep the shell hermetic: the Library screen refreshes from persistence on mount, and the
// Editor screen refreshes the (already-stubbed) clip store.
vi.mock('../engine/persistence', async (importActual) => {
  const actual = await importActual<typeof import('../engine/persistence')>();
  return { ...actual, listPresets: vi.fn(() => []), loadPreset: vi.fn(() => null) };
});

afterEach(cleanup);

function renderApp() {
  const ctx = makeAppContext(makeFakeTransport());
  const result = render(App, {
    context: new Map([[APP_CONTEXT_KEY, ctx]]),
    props: { onReady: () => {} },
  });
  return { ctx, ...result };
}

describe('App shell — the global transport is reachable from every screen', () => {
  it('renders the transport play button + scrubber on the Player, Library and Advanced tabs', async () => {
    const { ctx, getByRole, getAllByLabelText } = renderApp();

    // Player (default screen)
    expect(getByRole('button', { name: 'Play' })).toBeInTheDocument();
    expect(getAllByLabelText('Seek position').length).toBeGreaterThan(0);

    ctx.ui.setTab('library');
    await tick();
    expect(getByRole('button', { name: 'Play' })).toBeInTheDocument();
    expect(getAllByLabelText('Seek position').length).toBeGreaterThan(0);

    ctx.ui.setTab('editor');
    await tick();
    expect(getByRole('button', { name: 'Play' })).toBeInTheDocument();
    expect(getAllByLabelText('Seek position').length).toBeGreaterThan(0);
  });
});
