// authoring.svelte.ts — the two Phase-2 authoring stores that drive the offline render
// (RenderStore) and the VoiceScript compile→inject flow (VoiceScriptStore). Both are
// Svelte-5 runes factories, constructed once in the composition root, and unit-testable in
// isolation (each gets only the deps it needs — design §16.2).
//
// THE ONE INVIOLABLE RULE still holds: neither store touches the audio data path. Render
// is READ-ONLY over the working preset (it never mutates it — design §19); VoiceScript
// only appends plain `Layer[]` data into `preset.layers` via session.injectLayers (the bed
// duck falls out of engine scheduling, single-writer D-019 — the UI never writes a gain).
// Neither holds a Voice/Mixer/LayerNode or an AudioParam — render returns a Blob, compile
// returns plain Layer[]/Clip[].

import { renderToFile as defaultRenderToFile, type RenderFormat as EngineRenderFormat, type RenderProgress } from '../../engine/renderer';
import { compileVoiceScript as defaultCompileVoiceScript } from '../../engine/voice-script';
import type { CompileDeps, CompileResult } from '../../engine/voice-script';
import type { ClipSourceAdapter } from '../../engine/clip-library';
import type { TtsInput } from '../../engine/clip-sources/tts-local';
import type { RenderFormat, RenderPhase, VoiceScriptPhase } from '../lib/constants';
import type { SessionStore } from './session.svelte';
import type { NoticeStore } from './notices.svelte';

// ---------------------------------------------------------------------------
// Render store
// ---------------------------------------------------------------------------

/** What renderToFile returns; re-stated as the UI-owned shape RenderStore exposes. */
export interface RenderResult {
  blob: Blob;
  filename: string;
}

export interface RenderStore {
  readonly phase: RenderPhase;
  readonly progress: number; // 0..1 across the rendering + encoding phases
  readonly canRender: boolean; // false when OfflineAudioContext is unavailable (N1)
  readonly result: RenderResult | null;
  readonly missingClipIds: ReadonlyArray<string>;

  /** Bounce the working preset to a downloadable file. Read-only over the preset (never
   *  mutates it). A second call while rendering/encoding is ignored (N7). */
  render(format: RenderFormat): void;
  /** Abort an in-flight render via its AbortSignal (N3). */
  cancel(): void;
  /** Trigger the <a download> (gesture) for the finished blob, then clear the result (N5). */
  download(): void;
}

/** The renderer entry the store drives — `renderToFile(preset, format, opts)`. Injected so
 *  tests stub it; defaults to the real engine function. */
type RenderToFileFn = typeof defaultRenderToFile;

/** Detect the offline-render capability (laptop-class, design §16.1). */
function hasOfflineAudioContext(): boolean {
  return (
    typeof OfflineAudioContext !== 'undefined' ||
    typeof (globalThis as { webkitOfflineAudioContext?: unknown }).webkitOfflineAudioContext !== 'undefined'
  );
}

/** Minimal clip-presence probe injected into RenderStore — only what it needs to distinguish
 *  missing from present clip ids (N2). */
export interface RenderClipLib {
  hasClip(id: string): Promise<boolean>;
}

/** Collect clipIds referenced by clip-backed layers. Used as the candidate set for the
 *  async presence probe that filters to only absent ids (N2). */
function referencedClipIds(layers: readonly { source: unknown }[] | undefined): string[] {
  if (!layers) return [];
  const ids: string[] = [];
  for (const layer of layers) {
    const src = layer.source as { clipId?: unknown };
    if (src && typeof src.clipId === 'string' && !ids.includes(src.clipId)) ids.push(src.clipId);
  }
  return ids;
}

export function createRenderStore(deps: {
  session: SessionStore;
  notices: NoticeStore;
  /** Defaults to engine.renderToFile; injected so tests assert the call without a real render. */
  renderToFile?: RenderToFileFn;
  /** Override the capability probe (tests simulate a mobile browser with no OfflineAudioContext). */
  hasOffline?: () => boolean;
  /** Clip-library presence probe — filters referenced ids to actually-absent ones (N2).
   *  When absent, `missingClipIds` stays empty (no warning, no false positive). */
  clipLib?: RenderClipLib;
}): RenderStore {
  const { session, notices } = deps;
  const renderToFile = deps.renderToFile ?? defaultRenderToFile;
  const probe = deps.hasOffline ?? hasOfflineAudioContext;

  const canRender = probe();
  let phase = $state<RenderPhase>('idle');
  let progress = $state(0);
  let result = $state<RenderResult | null>(null);
  let missingClipIds = $state<string[]>([]);
  let controller: AbortController | undefined;

  function isBusy(): boolean {
    return phase === 'rendering' || phase === 'encoding';
  }

  function render(format: RenderFormat): void {
    if (!canRender) {
      notices.push({ severity: 'warning', message: 'Rendering needs a desktop browser.' });
      return;
    }
    if (isBusy()) return; // a second render is ignored while one runs (N7)

    const preset = session.preset;
    const referenced = referencedClipIds(preset.layers);

    phase = 'rendering';
    progress = 0;
    result = null;
    missingClipIds = [];
    controller = new AbortController();
    const signal = controller.signal;

    // Probe which referenced clip ids are actually absent from the library — runs in
    // parallel with the render so the warning appears as soon as the presence check
    // resolves (N2 contract). Failure → no warning (no false positive).
    if (referenced.length > 0 && deps.clipLib) {
      const lib = deps.clipLib;
      Promise.all(referenced.map((id) => lib.hasClip(id).then((present) => (present ? null : id))))
        .then((results) => {
          if (!signal.aborted) missingClipIds = results.filter((id): id is string => id !== null);
        })
        .catch(() => {
          // probe failure → leave missingClipIds empty (no false warnings)
        });
    }

    const onProgress = (p: RenderProgress): void => {
      if (p.phase === 'encoding') phase = 'encoding';
      if (typeof p.fraction === 'number') progress = p.fraction;
    };

    renderToFile(preset, format as EngineRenderFormat, { onProgress, signal })
      .then((file) => {
        if (signal.aborted) return; // cancelled — leave the cancel() state untouched
        result = { blob: file.blob, filename: file.filename };
        progress = 1;
        phase = 'done';
      })
      .catch((e: unknown) => {
        const code = (e as { code?: string }).code;
        if (code === 'CANCELLED') {
          phase = 'idle';
          progress = 0;
          return; // a user-initiated cancel is not an error
        }
        phase = 'error';
        if (code === 'UNSUPPORTED') {
          notices.push({ severity: 'warning', message: 'Rendering needs a desktop browser.' });
        } else {
          const message = e instanceof Error ? e.message : String(e);
          notices.push({ severity: 'error', message: `Render failed: ${message}` });
        }
      })
      .finally(() => {
        controller = undefined;
      });
  }

  function cancel(): void {
    controller?.abort();
  }

  function download(): void {
    // User-initiated only (gesture) — never an auto-download (mirrors §9's reload-on-click).
    const current = result;
    if (!current) return;
    if (typeof document === 'undefined' || typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') {
      notices.push({ severity: 'error', message: 'Downloading needs a browser environment.' });
      return;
    }
    const url = URL.createObjectURL(current.blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = current.filename;
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    result = null; // a finished download clears the staged file
    phase = 'idle';
    progress = 0;
  }

  return {
    get phase() {
      return phase;
    },
    get progress() {
      return progress;
    },
    get canRender() {
      return canRender;
    },
    get result() {
      return result;
    },
    get missingClipIds() {
      return missingClipIds;
    },
    render,
    cancel,
    download,
  };
}

// ---------------------------------------------------------------------------
// VoiceScript store
// ---------------------------------------------------------------------------

export interface VoiceScriptStore {
  readonly phase: VoiceScriptPhase;
  readonly progress: number; // 0..1 synthesis progress (coarse: lines done / total)
  readonly canCompile: boolean; // false when the tts-local model is unavailable (O3)

  /** Pick→compile→inject. Atomic: nothing is injected unless the compile fully succeeds
   *  (design §20 / edge O1). Warnings still inject (O5). */
  importAndCompile(scriptJson: unknown): void;

  /** Auto-synth-on-play (D-043): when playback starts on a preset carrying an embedded
   *  `voiceScript`, compile it in the BACKGROUND (feature C synthesizes only un-cached clips),
   *  inject the timed cues, and stream them into the running session via refreshLayers — no
   *  user steps, beats never blocked. No-op without a script, without studio TTS (mobile), or
   *  when already prepared for the current preset. Failures surface as a notice, never throw. */
  ensureNarrationForPlayback(): Promise<void>;
}

type CompileVoiceScriptFn = typeof defaultCompileVoiceScript;

export function createVoiceScriptStore(deps: {
  session: SessionStore;
  notices: NoticeStore;
  /** The compiler — injected so tests stub it; defaults to the real engine function. */
  compileVoiceScript?: CompileVoiceScriptFn;
  /** The tts-local adapter (laptop-only). `null`/absent ⇒ the capability gate disables compile. */
  tts: ClipSourceAdapter<TtsInput> | null;
  /** The live clip-library facade (importVia) the compiler stores clips through. */
  clipLib: CompileDeps['clipLib'];
}): VoiceScriptStore {
  const { session, notices, tts, clipLib } = deps;
  const compileVoiceScript = deps.compileVoiceScript ?? defaultCompileVoiceScript;

  const canCompile = tts !== null && tts !== undefined;
  let phase = $state<VoiceScriptPhase>('idle');
  let progress = $state(0);

  function issuesList(issues: CompileResult['issues']): string {
    return issues.map((i) => `${i.path || 'script'}: ${i.message}`).join('; ');
  }

  function importAndCompile(scriptJson: unknown): void {
    if (!canCompile || !tts) {
      notices.push({ severity: 'warning', message: 'Voice narration needs the desktop studio.' });
      return;
    }
    if (phase === 'compiling') return; // one compile at a time

    phase = 'compiling';
    progress = 0;

    // The compiler returns a CompileResult union ({ ok, ... }); a synth-layer throw (a bad
    // adapter, not a script error) is caught at the boundary so a UI bug never crashes here.
    Promise.resolve()
      .then(() =>
        compileVoiceScript(scriptJson as never, {
          tts,
          clipLib,
          durationSec: session.preset.durationSec,
        }),
      )
      .then((res: CompileResult) => {
        if (!res.ok) {
          // Atomic failure: NOTHING injected, the working preset is untouched (O1/O2).
          phase = 'error';
          notices.push({ severity: 'error', message: `Couldn't compile that VoiceScript — ${issuesList(res.issues)}` });
          return;
        }
        // Success: append the compiled voice layers (their absolute t is already computed —
        // the UI does not re-time them, O6). Warnings (e.g. negative-slack cadence) are
        // surfaced but DO NOT block the inject (O5).
        session.injectLayers(res.compiled.layers);
        const warnings = res.issues.filter((i) => i.severity === 'warning');
        if (warnings.length > 0) {
          notices.push({ severity: 'warning', message: `Imported with notes — ${issuesList(warnings)}` });
        } else {
          notices.push({ severity: 'info', message: `Added ${res.compiled.layers.length} voice layer(s).` });
        }
        progress = 1;
        phase = 'done';
      })
      .catch((e: unknown) => {
        phase = 'error';
        const message = e instanceof Error ? e.message : String(e);
        notices.push({ severity: 'error', message: `Couldn't compile that VoiceScript: ${message}` });
      });
  }

  // Tracks the exact voiceScript object we've already auto-synthesized for, so entering 'playing'
  // again (pause/resume, re-press play) doesn't recompile. Keyed on the SCRIPT reference, not the
  // preset: editing the narration assigns a new script identity (session.setVoiceScript), which
  // re-arms this so the next play recompiles + re-synthesizes only the changed lines. A new preset
  // load also brings a new script identity; a transient failure clears it so the next play retries.
  let ensuredScript: unknown = null;

  async function ensureNarrationForPlayback(): Promise<void> {
    if (!canCompile || !tts) return; // no studio TTS (e.g. mobile) → beats play, narration silent
    const preset = session.preset;
    const script = preset.voiceScript;
    if (!script || typeof script !== 'object') return; // preset carries no embedded narration
    if (ensuredScript === script) return; // this exact script already prepared
    ensuredScript = script;
    try {
      const res = await compileVoiceScript(script as never, {
        tts,
        clipLib,
        durationSec: preset.durationSec,
      });
      if (!res.ok) {
        notices.push({ severity: 'error', message: `Couldn't prepare narration — ${issuesList(res.issues)}` });
        return;
      }
      // REPLACE the script's cues (an edited line keeps its positional id but points at a new
      // clip), then rebuild the LIVE layer subsystem so the freshly-synthesized clips stream in
      // for the rest of the run. Manual (non-`vs_`) layers are left untouched.
      session.replaceNarrationLayers(res.compiled.layers);
      await session.refreshLayers();
    } catch (e) {
      ensuredScript = null; // transient failure (e.g. model load) → let the next play retry
      const message = e instanceof Error ? e.message : String(e);
      notices.push({ severity: 'error', message: `Couldn't prepare narration: ${message}` });
    }
  }

  return {
    get phase() {
      return phase;
    },
    get progress() {
      return progress;
    },
    get canCompile() {
      return canCompile;
    },
    importAndCompile,
    ensureNarrationForPlayback,
  };
}
