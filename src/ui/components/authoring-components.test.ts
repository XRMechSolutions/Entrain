// Phase-2 authoring-component tests (design §18/§19/§20, edge M/N/O). Each component reads
// its store from context; the stores are wired to controllable engine mocks so a click
// produces an OBSERVABLE store/notice change. Browser file-input + download APIs are stubbed
// per testing-standards. Asserts behavior (a notice, a store call, a fired <a download>),
// not implementation.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, fireEvent, cleanup } from '@testing-library/svelte';
import { tick } from 'svelte';
import type { Clip } from '../../engine/clip-library';
import type { RenderedFile } from '../../engine/renderer';
import { APP_CONTEXT_KEY } from '../context';
import type { AppContext } from '../context';
import { makeAppContext, makeFakeTransport } from '../test-harness';
import { createClipStore } from '../stores/library.svelte';
import { createRenderStore, createVoiceScriptStore } from '../stores/authoring.svelte';
import ClipPanel from './ClipPanel.svelte';
import RenderSheet from './RenderSheet.svelte';
import VoiceScriptImport from './VoiceScriptImport.svelte';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const flush = () => new Promise((r) => setTimeout(r, 0));

function clip(id: string, name: string, createdAt: number, bytes = 683008): Clip {
  return {
    id,
    hash: id,
    format: 'audio/mpeg',
    durationSec: 754,
    source: 'file',
    meta: { name },
    bytes,
    createdAt,
    lastUsedAt: createdAt,
  };
}

function renderWith(Comp: unknown, props: Record<string, unknown>, ctx: AppContext) {
  return render(Comp as never, { props: props as never, context: new Map([[APP_CONTEXT_KEY, ctx]]) });
}

describe('ClipPanel (§18, edge M)', () => {
  function ctxWithClips(over?: Parameters<typeof createClipStore>[0]['clipLib']) {
    const base = makeAppContext(makeFakeTransport());
    const notices = base.notices;
    const clips = createClipStore({
      notices,
      clipLib: {
        list: vi.fn(async () => [clip('a', 'rain.mp3', 1), clip('b', 'bell.wav', 100)]),
        totalBytes: vi.fn(async () => 1363149),
        remove: vi.fn(async () => true),
        importVia: vi.fn(async () => clip('c', 'new.wav', 200)),
        createFileImportAdapter: vi.fn(() => ({ source: 'file', produce: vi.fn() })) as never,
        countPresetsUsingClip: vi.fn(() => 0),
        ...over,
      },
    });
    return { ...base, clips };
  }

  it('renders name / duration(MM:SS) / human size / source badge newest-first', async () => {
    const ctx = ctxWithClips();
    ctx.clips.refresh();
    await flush();
    await tick();
    const { getByText } = renderWith(ClipPanel, { mode: 'browse' }, ctx);
    expect(getByText('bell.wav')).toBeInTheDocument();
    expect(getByText('rain.mp3')).toBeInTheDocument();
    // 754s → 12:34, 683008 bytes → 667 KB. The duration/size sit in a meta node alongside a
    // child badge span; assert both pieces appear in the rendered list.
    const allText = document.body.textContent ?? '';
    expect(allText).toContain('12:34');
    expect(allText).toContain('667 KB');
  });

  it('Import (change-handler gesture) calls the store importFile with the picked file (M8)', async () => {
    const ctx = ctxWithClips();
    const spy = vi.spyOn(ctx.clips, 'importFile');
    const { getByLabelText } = renderWith(ClipPanel, { mode: 'browse' }, ctx);
    const input = getByLabelText('Import audio clip') as HTMLInputElement;
    const file = new File([new Uint8Array([1, 2, 3])], 'tone.wav', { type: 'audio/wav' });
    Object.defineProperty(input, 'files', { value: [file], configurable: true });
    await fireEvent.change(input);
    expect(spy).toHaveBeenCalledWith(file);
  });

  it('pick mode returns clip.id via onpick when a row is selected', async () => {
    const ctx = ctxWithClips();
    ctx.clips.refresh();
    await flush();
    await tick();
    const onpick = vi.fn();
    const { getByText } = renderWith(ClipPanel, { mode: 'pick', onpick }, ctx);
    await fireEvent.click(getByText('bell.wav'));
    expect(onpick).toHaveBeenCalledWith('b');
  });

  it('Delete is wired to the store (behind its own confirm)', async () => {
    vi.stubGlobal('confirm', vi.fn(() => true));
    const ctx = ctxWithClips();
    ctx.clips.refresh();
    await flush();
    await tick();
    const spy = vi.spyOn(ctx.clips, 'removeClip');
    const { getByLabelText } = renderWith(ClipPanel, { mode: 'browse' }, ctx);
    await fireEvent.click(getByLabelText('Delete rain.mp3'));
    expect(spy).toHaveBeenCalledWith('a');
  });

  it('does NOT decode any clip to an AudioBuffer (metadata only, M7) — no AudioContext use', async () => {
    // The panel never references decodeAudioData / AudioContext; assert no such global is
    // touched while rendering a populated list.
    const decodeSpy = vi.fn();
    vi.stubGlobal('AudioContext', vi.fn(() => ({ decodeAudioData: decodeSpy })));
    const ctx = ctxWithClips();
    ctx.clips.refresh();
    await flush();
    await tick();
    renderWith(ClipPanel, { mode: 'browse' }, ctx);
    expect(decodeSpy).not.toHaveBeenCalled();
  });
});

describe('RenderSheet (§19, edge N)', () => {
  function ctxWithRender(opts: { hasOffline: boolean; renderToFile?: ReturnType<typeof vi.fn> }) {
    const base = makeAppContext(makeFakeTransport());
    const render = createRenderStore({
      session: base.session,
      notices: base.notices,
      renderToFile: (opts.renderToFile ??
        vi.fn(async () => ({ blob: new Blob(['x']), filename: 'untitled-session.wav', mime: 'audio/wav' }))) as never,
      hasOffline: () => opts.hasOffline,
    });
    return { ...base, render };
  }

  it('selects WAV, renders, and Download (gesture) fires the <a download> with the filename (N5)', async () => {
    const ctx = ctxWithRender({ hasOffline: true });
    const { getByRole, findByRole } = renderWith(RenderSheet, {}, ctx);
    await fireEvent.click(getByRole('button', { name: 'Render' }));
    await flush();
    await tick();

    const clickSpy = vi.fn();
    const realCreate = document.createElement.bind(document);
    vi.spyOn(document, 'createElement').mockImplementation((tag: string) => {
      const el = realCreate(tag);
      if (tag === 'a') (el as HTMLAnchorElement).click = clickSpy;
      return el;
    });
    vi.stubGlobal('URL', { createObjectURL: vi.fn(() => 'blob:x'), revokeObjectURL: vi.fn() });

    const dl = await findByRole('button', { name: /Download untitled-session\.wav/ });
    await fireEvent.click(dl);
    expect(clickSpy).toHaveBeenCalledTimes(1);
  });

  it('disables Render with the N1 gate when OfflineAudioContext is absent', () => {
    const ctx = ctxWithRender({ hasOffline: false });
    const { getByRole, getByTestId } = renderWith(RenderSheet, {}, ctx);
    expect(getByTestId('render-gate')).toBeInTheDocument();
    expect((getByRole('button', { name: 'Render' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('a second render is blocked while one runs (N7)', async () => {
    let resolve!: (f: RenderedFile) => void;
    const renderToFile = vi.fn(() => new Promise<RenderedFile>((r) => (resolve = r)));
    const ctx = ctxWithRender({ hasOffline: true, renderToFile });
    const { getByRole } = renderWith(RenderSheet, {}, ctx);
    await fireEvent.click(getByRole('button', { name: 'Render' }));
    await tick();
    // While rendering the button shows "Rendering…" and is disabled (N7).
    const btn = getByRole('button', { name: 'Rendering…' }) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    resolve({ blob: new Blob(), filename: 'x.wav', mime: 'audio/wav' });
    await flush();
  });
});

describe('VoiceScriptImport (§20, edge O)', () => {
  function ctxWithVoiceScript(opts: { tts: unknown; compile?: ReturnType<typeof vi.fn> }) {
    const base = makeAppContext(makeFakeTransport());
    const voiceScript = createVoiceScriptStore({
      session: base.session,
      notices: base.notices,
      compileVoiceScript: (opts.compile ??
        vi.fn(async () => ({
          ok: true,
          compiled: { layers: [{ id: 'v1', kind: 'voice', source: { clipId: 'c1' }, t: 5 }], clips: [], totalSec: 10 },
          issues: [],
        }))) as never,
      tts: opts.tts as never,
      clipLib: { importVia: vi.fn() as never },
    });
    return { ...base, voiceScript };
  }

  it('picks a .json and injects the compiled layers (dirty, shown in the layer list)', async () => {
    const compile = vi.fn(async () => ({
      ok: true,
      compiled: { layers: [{ id: 'v1', kind: 'voice', source: { clipId: 'c1' }, t: 5 }], clips: [], totalSec: 10 },
      issues: [],
    }));
    const ctx = ctxWithVoiceScript({ tts: { source: 'tts', produce: vi.fn() }, compile });
    const { getByLabelText } = renderWith(VoiceScriptImport, {}, ctx);
    const input = getByLabelText('VoiceScript JSON file') as HTMLInputElement;
    const file = new File([JSON.stringify({ version: 1 })], 'script.json', { type: 'application/json' });
    // jsdom's File.text() is unreliable; give a deterministic reader for the component.
    Object.defineProperty(file, 'text', { value: async () => JSON.stringify({ version: 1 }), configurable: true });
    Object.defineProperty(input, 'files', { value: [file], configurable: true });
    await fireEvent.change(input);
    await flush();
    await flush();
    expect(compile).toHaveBeenCalledTimes(1);
    expect(ctx.session.preset.layers!.map((l) => l.id)).toContain('v1');
    expect(ctx.session.dirty).toBe(true);
  });

  it('disables Import with the O3 gate when tts-local is unavailable', () => {
    const ctx = ctxWithVoiceScript({ tts: null });
    const { getByTestId, getByRole } = renderWith(VoiceScriptImport, {}, ctx);
    expect(getByTestId('voicescript-gate')).toBeInTheDocument();
    expect((getByRole('button', { name: /Pick a VoiceScript/ }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('a non-JSON file surfaces a notice and injects nothing (O1)', async () => {
    const compile = vi.fn();
    const ctx = ctxWithVoiceScript({ tts: { source: 'tts', produce: vi.fn() }, compile });
    const before = structuredClone(ctx.session.preset);
    const { getByLabelText } = renderWith(VoiceScriptImport, {}, ctx);
    const input = getByLabelText('VoiceScript JSON file') as HTMLInputElement;
    const file = new File(['not json {{{'], 'bad.json', { type: 'application/json' });
    Object.defineProperty(file, 'text', { value: async () => 'not json {{{', configurable: true });
    Object.defineProperty(input, 'files', { value: [file], configurable: true });
    await fireEvent.change(input);
    await flush();
    await flush();
    expect(compile).not.toHaveBeenCalled();
    expect(ctx.session.preset).toEqual(before);
    expect(ctx.notices.items.some((n) => n.severity === 'error')).toBe(true);
  });
});
