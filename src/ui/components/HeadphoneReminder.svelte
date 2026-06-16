<!-- HeadphoneReminder — the dismissible "use headphones" banner (design §8). Shown once
     per app open (ui.headphoneReminderSeen, in-memory); the parent hides it after the ✕
     or the first play. Honest framing (D-009): no medical claims. The PERMANENT caption
     beneath the play button lives in PlayerScreen and is unaffected by dismissal. -->
<script lang="ts">
  interface Props {
    ondismiss: () => void;
  }
  let { ondismiss }: Props = $props();
</script>

<div class="reminder" role="note">
  <span class="msg">🎧 Headphones are commonly used for the binaural effect (a different tone in each ear).</span>
  <button type="button" class="close" aria-label="Dismiss headphone reminder" onclick={ondismiss}>✕</button>
</div>

<style>
  .reminder {
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
    font-size: 0.9rem;
    color: var(--text-dim);
  }
  .close {
    flex: none;
    width: var(--tap-min);
    height: var(--tap-min);
    background: transparent;
    border: none;
    color: var(--text-dim);
    font-size: 1.1rem;
  }
</style>
