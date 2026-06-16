<!-- Scrubber — the position slider + time/duration readout (design §5, edge C1). While
     dragging, the thumb shows the DRAGGED value and `tick` is IGNORED (onscrubstart sets
     ui.scrubbing; release commits transport.seek and clears it). It reads the $state
     positionSec only to follow the playhead when NOT scrubbing — a cheap DOM update, the
     one place reading the mirror is allowed (edge I4). It never touches the audio path. -->
<script lang="ts">
  import { formatClock } from '../lib/format';

  interface Props {
    positionSec: number;
    durationSec: number;
    onseek: (t: number) => void;
    onscrubstart: () => void;
    onscrubend: () => void;
  }
  let { positionSec, durationSec, onseek, onscrubstart, onscrubend }: Props = $props();

  // Local drag display; while scrubbing this drives the thumb instead of positionSec.
  let scrubbing = $state(false);
  let dragValue = $state(0);

  const max = $derived(durationSec > 0 ? durationSec : 0);
  // Shown value: the dragged value while scrubbing, otherwise the live position (clamped).
  const shown = $derived(scrubbing ? dragValue : Math.min(positionSec, max));

  function begin(): void {
    scrubbing = true;
    dragValue = Math.min(positionSec, max);
    onscrubstart();
  }
  function move(e: Event): void {
    if (!scrubbing) return;
    dragValue = Number((e.currentTarget as HTMLInputElement).value);
  }
  function commit(e: Event): void {
    if (!scrubbing) return;
    const v = Number((e.currentTarget as HTMLInputElement).value);
    scrubbing = false;
    onseek(v); // gesture: seek directly, then clear scrubbing
    onscrubend();
  }
</script>

<div class="scrubber">
  <span class="time" aria-hidden="true">{formatClock(shown)}</span>
  <input
    class="range"
    type="range"
    min="0"
    max={max}
    step="0.1"
    value={shown}
    disabled={max <= 0}
    aria-label="Seek position"
    onpointerdown={begin}
    onkeydown={begin}
    oninput={move}
    onchange={commit}
    onpointerup={commit}
  />
  <span class="time" aria-hidden="true">{formatClock(max)}</span>
</div>

<style>
  .scrubber {
    display: flex;
    align-items: center;
    gap: var(--sp-3);
    width: 100%;
  }
  .range {
    flex: 1;
    min-height: var(--tap-min);
    accent-color: var(--accent);
  }
  .time {
    font-variant-numeric: tabular-nums;
    color: var(--text-dim);
    font-size: 0.85rem;
    min-width: 3.2em;
    text-align: center;
  }
</style>
