<!-- UpdateToast — the service-worker update + offline-ready toasts (design §9, D-017,
     edge H5/H7). registerType:'prompt': a new SW shows "New version — Reload" and reloads
     ONLY on the explicit Reload click (install.applyUpdate → updateServiceWorker(true)).
     We NEVER auto-reload (it would cut a running session). offlineReady is a one-time
     neutral toast. -->
<script lang="ts">
  interface Props {
    updateReady: boolean;
    offlineReady: boolean;
    onreload: () => void;
    ondismiss: () => void;
  }
  let { updateReady, offlineReady, onreload, ondismiss }: Props = $props();

  let offlineDismissed = $state(false);
</script>

{#if updateReady}
  <div class="toast update" role="status">
    <span class="msg">New version available.</span>
    <button type="button" class="reload" onclick={onreload}>Reload</button>
    <button type="button" class="close" aria-label="Dismiss update" onclick={ondismiss}>✕</button>
  </div>
{:else if offlineReady && !offlineDismissed}
  <div class="toast offline" role="status">
    <span class="msg">Ready to work offline.</span>
    <button type="button" class="close" aria-label="Dismiss" onclick={() => (offlineDismissed = true)}>✕</button>
  </div>
{/if}

<style>
  .toast {
    display: flex;
    align-items: center;
    gap: var(--sp-3);
    padding: var(--sp-3);
    border-radius: var(--radius);
    border: 1px solid var(--border);
    background: var(--surface-2);
  }
  .toast.update {
    border-color: var(--accent);
  }
  .msg {
    flex: 1;
    font-size: 0.9rem;
  }
  .reload {
    flex: none;
    min-height: 36px;
    padding: 0 var(--sp-3);
    background: var(--accent);
    color: var(--accent-contrast);
    border: none;
    border-radius: var(--radius);
    font-weight: 600;
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
