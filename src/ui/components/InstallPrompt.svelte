<!-- InstallPrompt — PWA install affordances (design §9, edge H). The Android/Chromium
     "Install app" button shows ONLY when a beforeinstallprompt was captured (canInstall);
     iOS shows a dismissible "Add to Home Screen" card (no programmatic install). When the
     app runs standalone both flags are false, so nothing renders. -->
<script lang="ts">
  interface Props {
    canInstall: boolean;
    isIos: boolean;
    oninstall: () => void;
  }
  let { canInstall, isIos, oninstall }: Props = $props();

  let iosDismissed = $state(false);
</script>

{#if canInstall}
  <button type="button" class="install" onclick={oninstall}>Install app</button>
{:else if isIos && !iosDismissed}
  <div class="a2hs" role="note">
    <span class="msg">Install: tap <strong>Share</strong>, then <strong>Add to Home Screen</strong>.</span>
    <button type="button" class="close" aria-label="Dismiss install hint" onclick={() => (iosDismissed = true)}>✕</button>
  </div>
{/if}

<style>
  .install {
    min-height: var(--tap-min);
    padding: 0 var(--sp-4);
    background: var(--accent);
    color: var(--accent-contrast);
    border: none;
    border-radius: var(--radius);
    font-weight: 600;
  }
  .a2hs {
    display: flex;
    align-items: center;
    gap: var(--sp-3);
    padding: var(--sp-3);
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: var(--radius);
  }
  .msg {
    flex: 1;
    font-size: 0.85rem;
    color: var(--text-dim);
  }
  .close {
    flex: none;
    width: 36px;
    height: 36px;
    background: transparent;
    border: none;
    color: var(--text-dim);
  }
</style>
