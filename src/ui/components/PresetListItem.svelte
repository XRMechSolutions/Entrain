<!-- PresetListItem — one row in the library (design §7, interfaces §9). Shows name,
     duration (MM:SS), node count, and updated-ago, with Open / Export / Delete actions.
     Delete is behind a confirm in the store; Export runs inside this click (gesture). -->
<script lang="ts">
  import type { PresetSummary } from '../../engine/persistence';
  import { formatClock, formatAgo } from '../lib/format';

  interface Props {
    summary: PresetSummary;
    selected: boolean;
    onopen: () => void;
    onexport: () => void;
    onremove: () => void;
  }
  let { summary, selected, onopen, onexport, onremove }: Props = $props();
</script>

<li class="item" class:selected>
  <button type="button" class="open" onclick={onopen}>
    <span class="name">{summary.name}</span>
    <span class="meta">
      {formatClock(summary.durationSec)} · {summary.nodeCount} node{summary.nodeCount === 1 ? '' : 's'}
      {#if summary.voiceCount > 1}
        · {summary.voiceCount} voices
      {/if}
      · {formatAgo(summary.updatedAt)}
    </span>
  </button>
  <div class="actions">
    <button type="button" class="act" onclick={onexport} aria-label={`Export ${summary.name}`}>Export</button>
    <button type="button" class="act danger" onclick={onremove} aria-label={`Delete ${summary.name}`}>Delete</button>
  </div>
</li>

<style>
  .item {
    display: flex;
    align-items: center;
    gap: var(--sp-3);
    padding: var(--sp-3);
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    list-style: none;
  }
  .item.selected {
    border-color: var(--accent);
  }
  .open {
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-height: var(--tap-min);
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
  }
  .actions {
    display: flex;
    gap: var(--sp-2);
  }
  .act {
    min-height: var(--tap-min);
    padding: 0 var(--sp-3);
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    color: var(--text);
    font-size: 0.85rem;
  }
  .act.danger {
    color: var(--danger);
  }
</style>
