<!-- NavBar — tab switcher (design §13). Bottom thumb-bar on mobile, top bar when wide
     (the App lays it out; this just renders the tabs). Player | Library | Advanced. The
     Player console is the default screen; "Advanced" hosts the multi-node timeline editor. -->
<script lang="ts">
  import type { Tab } from '../stores/notices.svelte';

  interface Props {
    tab: Tab;
    onselect: (t: Tab) => void;
  }
  let { tab, onselect }: Props = $props();

  const tabs: ReadonlyArray<{ id: Tab; label: string; glyph: string }> = [
    { id: 'player', label: 'Player', glyph: '▶' },
    { id: 'library', label: 'Library', glyph: '☰' },
    { id: 'editor', label: 'Advanced', glyph: '✎' },
  ];
</script>

<nav class="nav" aria-label="Sections">
  {#each tabs as t (t.id)}
    <button
      type="button"
      class="tab"
      class:active={tab === t.id}
      aria-current={tab === t.id ? 'page' : undefined}
      onclick={() => onselect(t.id)}
    >
      <span class="glyph" aria-hidden="true">{t.glyph}</span>
      <span class="label">{t.label}</span>
    </button>
  {/each}
</nav>

<style>
  .nav {
    display: flex;
    gap: var(--sp-1);
    background: var(--surface);
    border-top: 1px solid var(--border);
  }
  .tab {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 2px;
    min-height: var(--tap-min);
    padding: var(--sp-2);
    background: transparent;
    border: none;
    color: var(--text-dim);
  }
  .tab.active {
    color: var(--accent);
  }
  .glyph {
    font-size: 1.1rem;
  }
  .label {
    font-size: 0.72rem;
  }
</style>
