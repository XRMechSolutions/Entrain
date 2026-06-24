<!-- DriftButton — the sleep "drop me back to sleep" control. A single large, low-effort tap that
     TOGGLES a deeper-sleep overlay: tap once to ease the running session lower (beat + carrier
     down toward a deeper target for a few minutes, then rejoin the track); tap again, while it is
     still active, to resurface (return to the programmed track) rather than re-deepening from it.
     It is a LIVE, non-persisted overlay: pressing commits OUT through `onpress`
     (→ session.toggleDrift → transport), and it never edits or saves the preset. `active`
     reflects the engaged state (it auto-clears once the dip rejoins). Disabled unless playing. -->
<script lang="ts">
  interface Props {
    disabled?: boolean;
    active?: boolean;
    onpress: () => void;
  }
  let { disabled = false, active = false, onpress }: Props = $props();
</script>

<button
  type="button"
  class="drift"
  class:active
  {disabled}
  data-testid="drift-deeper"
  aria-pressed={active}
  aria-label={active ? 'Resurface — return to the programmed track' : 'Drift deeper — ease back toward sleep'}
  onclick={onpress}
>
  <span class="title">{active ? 'Drifting deeper' : 'Drift deeper'}</span>
  <span class="hint">{active ? 'tap to resurface to the programmed track' : 'ease the beat back down toward sleep'}</span>
</button>

<style>
  .drift {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: var(--sp-1);
    width: 100%;
    min-height: calc(var(--tap-min) * 1.8);
    padding: var(--sp-3);
    background: var(--surface-2, var(--surface));
    border: 1px solid var(--accent);
    border-radius: var(--radius);
    color: var(--accent);
    cursor: pointer;
  }
  /* Engaged: filled accent so it's unmistakable that a dip is running. */
  .drift.active {
    background: var(--accent);
    color: var(--on-accent, #fff);
  }
  .drift:disabled {
    opacity: 0.45;
    cursor: default;
    border-color: var(--border);
    color: var(--text-dim);
    background: var(--surface-2, var(--surface));
  }
  .title {
    font-weight: 600;
    font-size: 1rem;
  }
  .hint {
    color: var(--text-dim);
    font-size: 0.78rem;
  }
  .drift.active .hint {
    color: var(--on-accent, #fff);
    opacity: 0.85;
  }
</style>
