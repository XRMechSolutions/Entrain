<!-- ClipPanel — the Phase-2 clip-library browser (design §18, interfaces §13/§16). Two
     modes: 'browse' (manage the library) and 'pick' (choose a clip for a layer source).
     Reads the ClipStore via context; the panel manages METADATA + opaque blobs only — it
     NEVER decodes a clip to an AudioBuffer or holds an AudioContext (M7). Import runs inside
     the hidden <input type=file> change handler (the gesture, M8); the store maps every
     ClipLibraryErrorCode to a friendly notice. -->
<script lang="ts">
  import { getAppContext } from '../context';
  import { formatClock, formatBytes } from '../lib/format';
  import type { ClipPanelMode } from '../lib/constants';

  interface Props {
    mode?: ClipPanelMode;
    onpick?: (clipId: string) => void;
  }
  let { mode = 'browse', onpick }: Props = $props();

  const { clips } = getAppContext();

  // Drive the store mode from the prop (pick mode is entered by the source picker). The
  // store owns the onPick callback; here we forward the prop's onpick on a row selection.
  let fileInput = $state<HTMLInputElement | null>(null);

  function onImportChange(e: Event): void {
    // Gesture: call importFile with NO await before it (file-picker policy, M8).
    const input = e.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    if (file) clips.importFile(file);
    input.value = ''; // allow re-picking the same file
  }

  function selectRow(id: string): void {
    if (mode !== 'pick') return;
    // In pick mode, return the chosen clip.id and close the panel (the store also flips back
    // to 'browse' via its own pick(), but this component is prop-driven, so call onpick).
    onpick?.(id);
  }
</script>

<section class="clip-panel" aria-label={mode === 'pick' ? 'Pick a clip' : 'Clip library'}>
  <header class="head">
    <h3 class="title">{mode === 'pick' ? 'Pick a clip' : 'Clips'}</h3>
    <div class="head-actions">
      <span class="lib-size" aria-label="Library size">{formatBytes(clips.totalBytes)}</span>
      <button
        type="button"
        class="import-btn"
        onclick={() => fileInput?.click()}
        disabled={clips.importing}
      >
        {clips.importing ? 'Importing…' : 'Import clip'}
      </button>
      <input
        bind:this={fileInput}
        class="visually-hidden"
        type="file"
        accept="audio/*"
        aria-label="Import audio clip"
        onchange={onImportChange}
      />
    </div>
  </header>

  {#if clips.clips.length === 0}
    <p class="empty">{clips.loading ? 'Loading…' : 'No clips yet. Import an audio file to get started.'}</p>
  {:else}
    <ul class="list">
      {#each clips.clips as clip (clip.id)}
        <li class="row">
          {#if mode === 'pick'}
            <button type="button" class="pick" onclick={() => selectRow(clip.id)}>
              <span class="name">{clip.meta.name}</span>
              <span class="meta">
                {formatClock(clip.durationSec)} · {formatBytes(clip.bytes)}
                <span class="badge">{clip.source}</span>
              </span>
            </button>
          {:else}
            <div class="info">
              <span class="name">{clip.meta.name}</span>
              <span class="meta">
                {formatClock(clip.durationSec)} · {formatBytes(clip.bytes)}
                <span class="badge">{clip.source}</span>
              </span>
            </div>
            <button
              type="button"
              class="del"
              aria-label={`Delete ${clip.meta.name}`}
              onclick={() => clips.removeClip(clip.id)}
            >
              Delete
            </button>
          {/if}
        </li>
      {/each}
    </ul>
  {/if}
</section>

<style>
  .clip-panel {
    display: flex;
    flex-direction: column;
    gap: var(--sp-3);
  }
  .head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--sp-2);
  }
  .title {
    margin: 0;
    font-size: 1rem;
  }
  .head-actions {
    display: flex;
    align-items: center;
    gap: var(--sp-2);
  }
  .lib-size {
    font-size: 0.78rem;
    color: var(--text-dim);
    font-variant-numeric: tabular-nums;
  }
  .import-btn {
    min-height: var(--tap-min);
    padding: 0 var(--sp-3);
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    color: var(--accent);
    font-weight: 600;
  }
  .empty {
    color: var(--text-dim);
    font-size: 0.85rem;
  }
  .list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: var(--sp-2);
  }
  .row {
    display: flex;
    align-items: center;
    gap: var(--sp-3);
    padding: var(--sp-2) var(--sp-3);
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
  }
  .pick,
  .info {
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-height: var(--tap-min);
    justify-content: center;
    background: transparent;
    border: none;
    text-align: left;
  }
  .name {
    font-weight: 600;
  }
  .meta {
    font-size: 0.78rem;
    color: var(--text-dim);
    display: flex;
    align-items: center;
    gap: var(--sp-2);
    font-variant-numeric: tabular-nums;
  }
  .badge {
    padding: 1px var(--sp-2);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    text-transform: uppercase;
    font-size: 0.65rem;
    letter-spacing: 0.03em;
  }
  .del {
    min-height: var(--tap-min);
    padding: 0 var(--sp-3);
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    color: var(--danger);
    font-size: 0.85rem;
  }
</style>
