<!-- RenderSheet — the Render/Export action (design §19, interfaces §15/§16). Offers WAV/MP3,
     a 0..1 progress bar, a Cancel, a missing-clip pre-render warning, and a Download button
     (the gesture) driving an <a download> named from preset.name. Reads the RenderStore via
     context. The UI owns only the job lifecycle + download; it never schedules anything and
     never auto-downloads. Capability-gated (disabled with a notice when OfflineAudioContext
     is absent, N1) — gated on capability, NOT screen width. -->
<script lang="ts">
  import { getAppContext } from '../context';
  import type { RenderFormat } from '../lib/constants';

  const { render } = getAppContext();

  let format = $state<RenderFormat>('wav');

  const busy = $derived(render.phase === 'rendering' || render.phase === 'encoding');
</script>

<section class="render-sheet" aria-label="Render and export">
  <h3 class="title">Render…</h3>

  {#if !render.canRender}
    <p class="gate" data-testid="render-gate">Rendering needs a desktop browser.</p>
  {/if}

  <div class="row">
    <label class="fmt">
      <span>Format</span>
      <select value={format} aria-label="Render format" disabled={busy} onchange={(e) => (format = (e.currentTarget as HTMLSelectElement).value as RenderFormat)}>
        <option value="wav">WAV</option>
        <option value="mp3">MP3</option>
      </select>
    </label>
    <button
      type="button"
      class="run"
      disabled={!render.canRender || busy}
      onclick={() => render.render(format)}
    >
      {busy ? 'Rendering…' : 'Render'}
    </button>
  </div>

  {#if render.missingClipIds.length > 0}
    <p class="warn" data-testid="missing-clips">
      {render.missingClipIds.length} clip(s) are missing and will render as silence: {render.missingClipIds.join(', ')}
    </p>
  {/if}

  {#if busy}
    <div class="progress" aria-label="Render progress">
      <progress value={render.progress} max="1"></progress>
      <button type="button" class="cancel" onclick={() => render.cancel()}>Cancel</button>
    </div>
  {/if}

  {#if render.phase === 'done' && render.result}
    <button type="button" class="download" onclick={() => render.download()}>
      Download {render.result.filename}
    </button>
  {/if}
</section>

<style>
  .render-sheet {
    display: flex;
    flex-direction: column;
    gap: var(--sp-3);
    padding: var(--sp-3);
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
  }
  .title {
    margin: 0;
    font-size: 1rem;
  }
  .gate,
  .warn {
    margin: 0;
    font-size: 0.85rem;
    color: var(--warning);
  }
  .row {
    display: flex;
    align-items: flex-end;
    gap: var(--sp-3);
  }
  .fmt {
    display: flex;
    flex-direction: column;
    gap: var(--sp-1);
    font-size: 0.78rem;
    color: var(--text-dim);
  }
  .fmt select {
    min-height: var(--tap-min);
    padding: 0 var(--sp-2);
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    color: var(--text);
  }
  .run,
  .download {
    min-height: var(--tap-min);
    padding: 0 var(--sp-4);
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    color: var(--accent);
    font-weight: 600;
  }
  .progress {
    display: flex;
    align-items: center;
    gap: var(--sp-3);
  }
  .progress progress {
    flex: 1;
  }
  .cancel {
    min-height: var(--tap-min);
    padding: 0 var(--sp-3);
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    color: var(--danger);
  }
</style>
