<!-- App.svelte — the root shell (design §4/§13): global overlays (banner stack + update
     toast), the active screen, and the nav (bottom thumb-bar on mobile, top bar when wide).
     Reads the wired AppContext from Svelte context (provided by bootstrap's mount). On mount
     it runs `onReady` (bootstrap's off-gesture prime() + install-buffer adoption). -->
<script lang="ts">
  import { onMount } from 'svelte';
  import './app.css';
  import { getAppContext } from './context';
  import NavBar from './components/NavBar.svelte';
  import TransportBar from './components/TransportBar.svelte';
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
  <!-- Sticky top chrome: the GLOBAL transport (every screen), the tab bar on wide, and the
       banner sheet — one sticky stack so nothing fights for top:0. The tab bar stays a
       bottom thumb-bar on mobile (rendered below the screen). -->
  <div class="chrome">
    <TransportBar />
    {#if ui.isWide}
      <NavBar tab={ui.tab} onselect={(t) => ui.setTab(t)} />
    {/if}
    <div class="overlays">
      <BannerStack items={notices.items} ondismiss={(id) => notices.dismiss(id)} />
      <UpdateToast
        updateReady={install.updateReady}
        offlineReady={install.offlineReady}
        onreload={() => install.applyUpdate()}
        ondismiss={() => install.dismissUpdate()}
      />
    </div>
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

  {#if !ui.isWide}
    <div class="navbar">
      <NavBar tab={ui.tab} onselect={(t) => ui.setTab(t)} />
    </div>
  {/if}
</div>

<style>
  .app {
    display: flex;
    flex-direction: column;
    min-height: 100dvh;
    padding: var(--safe-top) var(--safe-right) var(--safe-bottom) var(--safe-left);
  }
  /* One sticky top stack: transport bar, tabs (wide), then the banner sheet — so the global
     transport is reachable from every screen and nothing else competes for top:0. */
  .chrome {
    position: sticky;
    top: 0;
    z-index: 10;
    display: flex;
    flex-direction: column;
    background: var(--bg);
  }
  .overlays {
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
  /* Mobile: the tab bar is a bottom thumb-bar (design §13). On wide it renders inside the
     sticky top chrome instead, so there is no bottom .navbar. */
  .navbar {
    position: sticky;
    bottom: 0;
  }
</style>
