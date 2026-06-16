<!-- DurationControl — the session-length control (mm:ss or plain seconds) plus quick-pick
     minute chips. ONE-WAY like every other console control: the text field binds a LOCAL
     display $state, never the preset. On commit (change / blur / Enter) it parses
     "mm:ss" / "h:mm:ss" / "ss" and calls `oncommit` (→ session.setDuration, which clamps to
     LIMITS, dirties, bumps revision); a chip commits its minute value directly. The new
     length is reflected at once (the displayed clock / scrubber / canvas span re-derive from
     the working preset); it only takes audible effect on the NEXT play for a running session.
     An unparseable/empty text entry reverts and is not committed. -->
<script lang="ts">
  import { untrack } from 'svelte';
  import { formatClock, parseClock } from '../lib/format';

  interface Props {
    /** Current duration in seconds (derived from the working preset). */
    value: number;
    oncommit: (sec: number) => void;
  }
  let { value, oncommit }: Props = $props();

  // Quick-pick lengths (minutes) — the common session durations, one tap each (§D).
  const QUICK_MINUTES: ReadonlyArray<number> = [5, 10, 15, 20, 30, 45, 60];

  let display = $state(untrack(() => formatClock(value)));
  let lastProp = untrack(() => value);
  // Resync the field only on a genuine external change (chip / reset / clamp / canvas), never
  // while the user is mid-edit (the prop is unchanged until they commit).
  $effect(() => {
    if (value !== lastProp) {
      lastProp = value;
      display = formatClock(value);
    }
  });

  function onCommit(e: Event): void {
    const el = e.currentTarget as HTMLInputElement;
    const sec = parseClock(el.value);
    if (sec === null) {
      // Revert to the last valid display; force the element too, since Svelte won't touch
      // the DOM when `display` is unchanged but the field diverged.
      display = formatClock(value);
      el.value = display;
      return;
    }
    oncommit(sec); // session.setDuration clamps; the value prop resyncs the display
  }

  /** True when `value` currently equals this chip's length (so it reads as selected). */
  function isActive(min: number): boolean {
    return Math.round(value) === min * 60;
  }
</script>

<div class="duration">
  <div class="head">
    <label class="label" for="session-duration">Duration</label>
    <span class="hint">mm:ss · applies on next play</span>
  </div>
  <input
    id="session-duration"
    class="field"
    type="text"
    inputmode="numeric"
    value={display}
    aria-label="Session duration"
    oninput={(e) => (display = (e.currentTarget as HTMLInputElement).value)}
    onchange={onCommit}
    onblur={onCommit}
  />
  <div class="chips" role="group" aria-label="Quick durations">
    {#each QUICK_MINUTES as min (min)}
      <button
        type="button"
        class="chip"
        class:active={isActive(min)}
        aria-pressed={isActive(min)}
        onclick={() => oncommit(min * 60)}
      >
        {min}m
      </button>
    {/each}
  </div>
</div>

<style>
  .duration {
    display: flex;
    flex-direction: column;
    gap: var(--sp-2);
    padding: var(--sp-3);
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
  }
  .head {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    gap: var(--sp-2);
  }
  .label {
    font-weight: 600;
  }
  .hint {
    font-size: 0.72rem;
    color: var(--text-dim);
  }
  .field {
    min-height: var(--tap-min);
    padding: 0 var(--sp-2);
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    font-variant-numeric: tabular-nums;
  }
  .chips {
    display: flex;
    flex-wrap: wrap;
    gap: var(--sp-2);
  }
  .chip {
    min-height: var(--tap-min);
    min-width: var(--tap-min);
    padding: 0 var(--sp-3);
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    color: var(--text-dim);
    font-variant-numeric: tabular-nums;
  }
  .chip.active {
    border-color: var(--accent);
    color: var(--accent);
  }
</style>
