<!-- App.svelte — the root shell (design §4/§13): global overlays (banner stack + update
     toast), the active screen, and the nav (bottom thumb-bar on mobile, top bar when wide).
     Reads the wired AppContext from Svelte context (provided by bootstrap's mount). On mount
     it runs `onReady` (bootstrap's off-gesture prime() + install-buffer adoption). -->
<script lang="ts">
  import { onMount } from 'svelte';
  import './app.css';
  import { getAppContext } from './context';
  import NavBar from './components/NavBar.svelte';
  import BannerStack from './components/BannerStack.svelte';
  import UpdateToast from './components/UpdateToast.svelte';
  import PlayerScreen from './screens/PlayerScreen.svelte';
  import LibraryScreen from './screens/LibraryScreen.svelte';
  import EditorScreen from './screens/EditorScreen.svelte';

  interface Props {
    onReady?: () => void;
  }
  let { onReady }: Props = $props();

  const { ui, notices, install } = getAppContext();

  onMount(() => {
    onReady?.();
  });
</script>

<div class="app" class:wide={ui.isWide}>
  <div class="overlays">
    <BannerStack items={notices.items} ondismiss={(id) => notices.dismiss(id)} />
    <UpdateToast
      updateReady={install.updateReady}
      offlineReady={install.offlineReady}
      onreload={() => install.applyUpdate()}
      ondismiss={() => install.dismissUpdate()}
    />
  </div>

  <main class="screen">
    {#if ui.tab === 'player'}
      <PlayerScreen />
    {:else if ui.tab === 'library'}
      <LibraryScreen />
    {:else if ui.tab === 'editor'}
      <EditorScreen />
    {/if}
  </main>

  <div class="navbar">
    <NavBar tab={ui.tab} onselect={(t) => ui.setTab(t)} />
  </div>
</div>

<style>
  .app {
    display: flex;
    flex-direction: column;
    min-height: 100dvh;
    padding: var(--safe-top) var(--safe-right) var(--safe-bottom) var(--safe-left);
  }
  .overlays {
    position: sticky;
    top: 0;
    z-index: 10;
    display: flex;
    flex-direction: column;
    gap: var(--sp-2);
    padding: var(--sp-2);
    background: linear-gradient(var(--bg), transparent);
    pointer-events: none;
  }
  .overlays :global(.banner),
  .overlays :global(.toast) {
    pointer-events: auto;
  }
  .screen {
    flex: 1;
    overflow-y: auto;
  }
  .navbar {
    position: sticky;
    bottom: 0;
  }

  /* Wide: nav moves to the top (design §13). */
  .app.wide {
    flex-direction: column;
  }
  .app.wide .navbar {
    order: -1;
    position: sticky;
    top: 0;
    bottom: auto;
  }
</style>
