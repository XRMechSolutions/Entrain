<!-- KeepScreenOnToggle — the optional Wake Lock toggle (design §5, edge F6/F7). The
     change handler calls `onchange` directly (the Wake Lock request needs a gesture, so
     no await precedes it). It reflects the intended state; transport reverts it to off and
     emits a warning if the request fails. `disabled` covers WAKE_LOCK_UNSUPPORTED. -->
<script lang="ts">
  interface Props {
    on: boolean;
    disabled?: boolean;
    onchange: (on: boolean) => void;
  }
  let { on, disabled = false, onchange }: Props = $props();
</script>

<label class="toggle" class:disabled>
  <input
    type="checkbox"
    checked={on}
    {disabled}
    onchange={(e) => onchange((e.currentTarget as HTMLInputElement).checked)}
  />
  <span>Keep screen on</span>
</label>

<style>
  .toggle {
    display: inline-flex;
    align-items: center;
    gap: var(--sp-2);
    min-height: var(--tap-min);
    color: var(--text-dim);
  }
  .toggle.disabled {
    opacity: 0.5;
  }
  input {
    width: 1.2rem;
    height: 1.2rem;
    accent-color: var(--accent);
  }
</style>
