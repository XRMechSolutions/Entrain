<!-- LayerList — the Editor layer track column (design §17.1, interfaces §16). One row per
     Layer in preset.layers: name/id, a kind badge, a source summary (ToneSpec shape+freq or
     the clip reference), the start t (formatClock), and a loop indicator. "Add layer" offers
     the three kinds; edit opens the Layer Inspector; remove splices the layer (the shared
     clip stays in the library, L10). One-way: every action calls back to the parent, which
     routes through the SessionStore (the framework never touches the audio path). -->
<script lang="ts">
  import { formatClock, formatHz } from '../lib/format';
  import type { Layer, LayerKind } from '../../engine/session-model';

  interface Props {
    layers: ReadonlyArray<Layer>;
    selectedId?: string | null;
    onadd: (kind: LayerKind) => void;
    onedit: (id: string) => void;
    onremove: (id: string) => void;
  }
  let { layers, selectedId = null, onadd, onedit, onremove }: Props = $props();

  const KINDS: ReadonlyArray<LayerKind> = ['tone', 'ambiance', 'voice'];

  /** A short, human source summary for the row. Unbound clip layers read "Pick a clip". */
  function sourceSummary(layer: Layer): string {
    if ('synth' in layer.source) {
      return `${layer.source.synth.shape} · ${formatHz(layer.source.synth.freqHz, 0)}`;
    }
    return layer.source.clipId ? `clip ${layer.source.clipId}` : 'Pick a clip';
  }

  function isUnbound(layer: Layer): boolean {
    return 'clipId' in layer.source && layer.source.clipId === '';
  }
</script>

<section class="layer-list" aria-label="Layers">
  <header class="head">
    <h3 class="title">Layers</h3>
    <div class="add" role="group" aria-label="Add layer">
      {#each KINDS as kind (kind)}
        <button type="button" class="add-btn" onclick={() => onadd(kind)}>+ {kind}</button>
      {/each}
    </div>
  </header>

  {#if layers.length === 0}
    <p class="empty">No layers yet. Add a tone, ambiance, or voice layer above.</p>
  {:else}
    <ul class="list">
      {#each layers as layer (layer.id)}
        <li class="row" class:active={layer.id === selectedId}>
          <button type="button" class="open" onclick={() => onedit(layer.id)}>
            <span class="top">
              <span class="badge {layer.kind}">{layer.kind}</span>
              <span class="src" class:unbound={isUnbound(layer)}>{sourceSummary(layer)}</span>
            </span>
            <span class="meta">
              <span>start {formatClock(layer.t)}</span>
              {#if layer.loop}<span class="loop">loop</span>{/if}
            </span>
          </button>
          <button type="button" class="del" aria-label={`Remove ${layer.kind} layer`} onclick={() => onremove(layer.id)}>
            Remove
          </button>
        </li>
      {/each}
    </ul>
  {/if}
</section>

<style>
  .layer-list {
    display: flex;
    flex-direction: column;
    gap: var(--sp-3);
  }
  .head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--sp-2);
    flex-wrap: wrap;
  }
  .title {
    margin: 0;
    font-size: 1rem;
  }
  .add {
    display: flex;
    gap: var(--sp-2);
  }
  .add-btn {
    min-height: var(--tap-min);
    padding: 0 var(--sp-2);
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    color: var(--accent);
    font-size: 0.85rem;
    text-transform: capitalize;
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
    gap: var(--sp-2);
    padding: var(--sp-2) var(--sp-3);
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
  }
  .row.active {
    border-color: var(--accent);
  }
  .open {
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: var(--sp-1);
    min-height: var(--tap-min);
    justify-content: center;
    background: transparent;
    border: none;
    text-align: left;
  }
  .top {
    display: flex;
    align-items: center;
    gap: var(--sp-2);
  }
  .badge {
    padding: 1px var(--sp-2);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    text-transform: uppercase;
    font-size: 0.65rem;
    letter-spacing: 0.03em;
    color: var(--text-dim);
  }
  .badge.tone {
    color: var(--accent);
  }
  .badge.ambiance {
    color: var(--info);
  }
  .badge.voice {
    color: var(--warning);
  }
  .src {
    font-weight: 600;
    font-size: 0.85rem;
  }
  .src.unbound {
    color: var(--warning);
    font-style: italic;
  }
  .meta {
    display: flex;
    gap: var(--sp-2);
    font-size: 0.78rem;
    color: var(--text-dim);
    font-variant-numeric: tabular-nums;
  }
  .loop {
    color: var(--info);
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
