<!-- BannerStack — the global notice surface (design §10). Renders up to NOTICE_MAX_VISIBLE
     banners by severity (error red/persistent, warning amber, info neutral), each with an
     optional inline action (e.g. "Resume", "Reset library") and a ✕. The store owns dedupe,
     the cap, and auto-dismiss; this component is pure presentation. -->
<script lang="ts">
  import type { Notice } from '../stores/notices.svelte';

  interface Props {
    items: ReadonlyArray<Notice>;
    ondismiss: (id: string) => void;
  }
  let { items, ondismiss }: Props = $props();

  const roleFor = (sev: Notice['severity']): 'alert' | 'status' => (sev === 'error' ? 'alert' : 'status');
</script>

{#if items.length > 0}
  <div class="stack" aria-live="polite">
    {#each items as n (n.id)}
      <div class="banner {n.severity}" role={roleFor(n.severity)}>
        <span class="msg">{n.message}</span>
        {#if n.action}
          <button type="button" class="action" onclick={n.action.run}>{n.action.label}</button>
        {/if}
        <button type="button" class="close" aria-label="Dismiss" onclick={() => ondismiss(n.id)}>✕</button>
      </div>
    {/each}
  </div>
{/if}

<style>
  .stack {
    display: flex;
    flex-direction: column;
    gap: var(--sp-2);
  }
  .banner {
    display: flex;
    align-items: center;
    gap: var(--sp-3);
    padding: var(--sp-3);
    border-radius: var(--radius);
    border: 1px solid var(--border);
    background: var(--surface-2);
  }
  .banner.error {
    border-color: var(--danger);
    background: rgba(255, 93, 93, 0.12);
  }
  .banner.warning {
    border-color: var(--warning);
    background: rgba(255, 180, 84, 0.12);
  }
  .banner.info {
    border-color: var(--info);
    background: rgba(102, 217, 192, 0.12);
  }
  .msg {
    flex: 1;
    font-size: 0.9rem;
  }
  .action {
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
