import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { tick } from 'svelte';
import { render, fireEvent, cleanup } from '@testing-library/svelte';
import { APP_CONTEXT_KEY } from '../context';
import { makeAppContext, makeFakeTransport } from '../test-harness';
import EditorScreen from './EditorScreen.svelte';

let rafSpy: ReturnType<typeof vi.fn>;
let cafSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  // jsdom has no 2D canvas; return null cleanly so it doesn't emit a not-implemented notice.
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
  // Capture the rAF loop without actually running frames.
  rafSpy = vi.fn(() => 1);
  cafSpy = vi.fn();
  vi.stubGlobal('requestAnimationFrame', rafSpy);
  vi.stubGlobal('cancelAnimationFrame', cafSpy);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function renderEditor() {
  const ctx = makeAppContext(makeFakeTransport());
  const result = render(EditorScreen, { context: new Map([[APP_CONTEXT_KEY, ctx]]) });
  const canvas = result.container.querySelector('canvas') as HTMLCanvasElement;
  return { ctx, canvas, ...result };
}

describe('EditorScreen / TimelineCanvas (design §12, edge I3/I4/J4)', () => {
  it('starts the rAF render loop on mount', () => {
    renderEditor();
    expect(rafSpy).toHaveBeenCalled();
  });

  it('edits the preset waveform from the toolbar (relocated here from the read-only Player)', async () => {
    const { ctx, getByRole } = renderEditor();
    expect(ctx.session.preset.nodes[0].waveform ?? 'sine').not.toBe('square');
    await fireEvent.click(getByRole('button', { name: /square/i }));
    await tick();
    expect(ctx.session.preset.nodes[0].waveform).toBe('square');
  });

  it('tap on an empty lane adds a carry-forward node (no sound change, edge J4)', async () => {
    const { ctx, canvas } = renderEditor();
    const before = ctx.session.preset.nodes.length;
    // jsdom has no PointerEvent; MouseEvent carries clientX/Y under the pointer event names.
    await fireEvent(canvas, new MouseEvent('pointerdown', { clientX: 320, clientY: 50, bubbles: true }));
    await fireEvent(canvas, new MouseEvent('pointerup', { clientX: 320, clientY: 50, bubbles: true }));
    expect(ctx.session.preset.nodes.length).toBe(before + 1);
  });

  it('Svelte never replaces the <canvas> element across an edit (purity)', async () => {
    const { ctx, canvas } = renderEditor();
    ctx.session.setNodeParam('carrier', 333); // an edit bumps revision
    await tick();
    expect(canvas.isConnected).toBe(true);
    expect(canvas).toBe(canvas.ownerDocument.querySelector('canvas')); // same node, not re-rendered
  });

  it('cancels the rAF loop on unmount (resource cleanup)', () => {
    const { unmount } = renderEditor();
    unmount();
    expect(cafSpy).toHaveBeenCalled();
  });
});

describe('EditorScreen — tools always visible (add / select / remove nodes)', () => {
  it('the inspector is visible by default (node 0 selected — never an empty screen)', () => {
    const { getByLabelText } = renderEditor();
    // node 0 is the start node: its time reads "0:00 · start"
    expect(getByLabelText('Start node time')).toBeInTheDocument();
  });

  it('"+ Add node" adds a carry-forward node at the chosen time and selects it', async () => {
    const { ctx, getByTestId, getByLabelText } = renderEditor();
    const before = ctx.session.preset.nodes.length;
    await fireEvent.input(getByLabelText('New node time'), { target: { value: '1:00' } });
    await fireEvent.click(getByTestId('add-node'));
    await tick();
    expect(ctx.session.preset.nodes.length).toBe(before + 1);
    expect(ctx.session.preset.nodes.some((n) => n.t === 60)).toBe(true);
    // the new node is now the selected one → its editable time field shows 1:00
    expect((getByLabelText('Node time') as HTMLInputElement).value).toBe('1:00');
  });

  it('tapping a node chip selects that node (inspector edits it)', async () => {
    const { ctx, getByTestId, getByLabelText } = renderEditor();
    const idx = Number(ctx.session.addNode(90, 'carrier'));
    await tick();
    await fireEvent.click(getByTestId(`node-chip-${idx}`));
    await tick();
    expect((getByLabelText('Node time') as HTMLInputElement).value).toBe('1:30');
  });

  it('Remove deletes the selected non-start node', async () => {
    const { ctx, getByTestId, getByRole } = renderEditor();
    const idx = Number(ctx.session.addNode(90, 'carrier'));
    await tick();
    await fireEvent.click(getByTestId(`node-chip-${idx}`));
    await tick();
    const before = ctx.session.preset.nodes.length;
    await fireEvent.click(getByRole('button', { name: 'Remove' }));
    await tick();
    expect(ctx.session.preset.nodes.length).toBe(before - 1);
    expect(ctx.session.preset.nodes.some((n) => n.t === 90)).toBe(false);
  });
});

describe('EditorScreen — duration is editable and reflected at once (§D)', () => {
  it('a duration chip updates the working length and the field display immediately', async () => {
    const { ctx, getByRole, getByLabelText } = renderEditor();
    await fireEvent.click(getByRole('button', { name: '15m' }));
    await tick();
    expect(ctx.session.preset.durationSec).toBe(900);
    expect((getByLabelText('Session duration') as HTMLInputElement).value).toBe('15:00');
  });
});

describe('EditorScreen — selection survives a reorder (identity, not index)', () => {
  it('editing after a time move targets the same node', async () => {
    const { ctx, getByTestId, getByLabelText } = renderEditor();
    ctx.session.addNode(100, 'carrier');
    const idxB = Number(ctx.session.addNode(200, 'carrier'));
    await tick();
    const nodeB = ctx.session.preset.nodes[idxB];
    await fireEvent.click(getByTestId(`node-chip-${idxB}`));
    await tick();

    // Move B to t=30, which re-sorts it before the t=100 node.
    await fireEvent.change(getByLabelText('Node time'), { target: { value: '0:30' } });
    await tick();
    expect(nodeB.t).toBe(30);

    // Editing carrier still writes to B, not to the node now at B's old index.
    await fireEvent.change(getByLabelText('Carrier value'), { target: { value: '321' } });
    await tick();
    expect(nodeB.carrier?.value).toBe(321);
  });
});

describe('EditorScreen — multi-voice routing (FIX-1 regression)', () => {
  it('canvas tap adds a node to the active extra voice, not the primary', async () => {
    const { ctx, canvas, getByTestId } = renderEditor();
    const voiceId = ctx.session.addVoice()!;
    await tick();
    await fireEvent.click(getByTestId(`voice-tab-${voiceId}`));
    await tick();

    const primaryBefore = ctx.session.preset.nodes.length;
    const extraBefore = ctx.session.preset.voices![0].nodes.length;

    await fireEvent(canvas, new MouseEvent('pointerdown', { clientX: 320, clientY: 50, bubbles: true }));
    await fireEvent(canvas, new MouseEvent('pointerup', { clientX: 320, clientY: 50, bubbles: true }));

    expect(ctx.session.preset.nodes.length).toBe(primaryBefore);
    expect(ctx.session.preset.voices![0].nodes.length).toBe(extraBefore + 1);
  });

  it('NodeInspector param edit lands on the extra voice, not the primary', async () => {
    const { ctx, getByTestId, getByLabelText } = renderEditor();
    const voiceId = ctx.session.addVoice()!;
    await tick();
    await fireEvent.click(getByTestId(`voice-tab-${voiceId}`));
    await tick();

    // Extra voice node 0 has carrier=250 Hz; change to a distinctive value.
    await fireEvent.change(getByLabelText('Carrier value'), { target: { value: '333' } });
    await tick();

    expect(ctx.session.preset.voices![0].nodes[0].carrier?.value).toBe(333);
    expect(ctx.session.preset.nodes[0].carrier?.value).not.toBe(333); // primary untouched
  });

  it('shows a Save button that invokes library.save()', async () => {
    const { ctx, getByTestId } = renderEditor();
    const saveSpy = vi.spyOn(ctx.library, 'save').mockImplementation(() => {});
    await fireEvent.click(getByTestId('editor-save'));
    expect(saveSpy).toHaveBeenCalledTimes(1);
  });

  it('Save is disabled for a loaded, unedited preset and enables after an edit', async () => {
    const { ctx, getByTestId } = renderEditor();
    ctx.session.reset(ctx.session.preset, 'lib-1'); // loaded record, no unsaved edits
    await tick();
    expect((getByTestId('editor-save') as HTMLButtonElement).disabled).toBe(true);
    ctx.session.setNodeParam('carrier', 250); // an edit dirties the working preset
    await tick();
    expect((getByTestId('editor-save') as HTMLButtonElement).disabled).toBe(false);
  });

  it('Save stays enabled for a brand-new (unsaved) session even when clean', async () => {
    const { ctx, getByTestId } = renderEditor();
    expect(ctx.session.selectedId).toBeNull(); // fresh harness session, never saved
    expect((getByTestId('editor-save') as HTMLButtonElement).disabled).toBe(false);
  });
});
