<!-- PresetList — the scrolling list of saved presets (design §7/§13). Items arrive already
     sorted updatedAt-desc from persistence; this renders them and forwards row actions. -->
<script lang="ts">
  import type { PresetSummary } from '../../engine/persistence';
  import PresetListItem from './PresetListItem.svelte';

  interface Props {
    items: ReadonlyArray<PresetSummary>;
    selectedId: string | null;
    onopen: (id: string) => void;
    onexport: (id: string) => void;
    onremove: (id: string) => void;
  }
  let { items, selectedId, onopen, onexport, onremove }: Props = $props();
</script>

{#if items.length === 0}
  <p class="empty">No saved sessions yet. Tap “New”, shape a sound, then Save.</p>
{:else}
  <ul class="list">
    {#each items as item (item.id)}
      <PresetListItem
        summary={item}
        selected={item.id === selectedId}
        onopen={() => onopen(item.id)}
        onexport={() => onexport(item.id)}
        onremove={() => onremove(item.id)}
      />
    {/each}
  </ul>
{/if}

<style>
  .list {
    display: flex;
    flex-direction: column;
    gap: var(--sp-2);
    margin: 0;
    padding: 0;
  }
  .empty {
    color: var(--text-dim);
    padding: var(--sp-4);
    text-align: center;
  }
</style>
