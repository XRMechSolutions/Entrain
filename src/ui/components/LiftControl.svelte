<!-- LiftControl — the console group for the Shepard–Risset "lift" overlay (an endless
     ASCENDING/descending glissando mixed alongside the binaural beats). This is a LIVE
     overlay, NOT persisted in the preset yet, so it owns its own local $state and commits
     every change OUT through `oncommit` (→ playback.setLift → transport.setLift). It still
     honours the one-way rule: it never binds reactive state onto the signal graph.

     Direction maps to the SIGN of speed (Ascending = +rate = rising/lift, Descending =
     −rate = return). Rate is the octaves/sec magnitude; Level is the 0..1 gain. Toggling
     Off commits null (fade out + dispose). -->
<script lang="ts">
  import type { LiftOptions } from '../../engine/transport';
  import { formatPercent } from '../lib/format';

  interface Props {
    oncommit: (lift: LiftOptions | null) => void;
  }
  let { oncommit }: Props = $props();

  const RATE_MIN = 0.05;
  const RATE_MAX = 1.0;
  const RATE_STEP = 0.05;
  const LEVEL_STEP = 0.01;

  // Local display state (this layer has no preset to mirror). Sensible defaults.
  let enabled = $state(false);
  let direction = $state<'up' | 'down'>('up');
  let rate = $state(0.25); // octaves/sec magnitude
  let level = $state(0.4); // 0..1 gain

  function commit(): void {
    if (!enabled) {
      oncommit(null);
      return;
    }
    const speed = direction === 'up' ? rate : -rate;
    oncommit({ speed, gain: level });
  }

  function toggle(e: Event): void {
    enabled = (e.currentTarget as HTMLInputElement).checked;
    commit();
  }
  function setDirection(d: 'up' | 'down'): void {
    direction = d;
    if (enabled) commit();
  }
  function onRate(e: Event): void {
    const v = Number((e.currentTarget as HTMLInputElement).value);
    if (!Number.isFinite(v)) return;
    rate = v;
    if (enabled) commit();
  }
  function onLevel(e: Event): void {
    const v = Number((e.currentTarget as HTMLInputElement).value);
    if (!Number.isFinite(v)) return;
    level = v;
    if (enabled) commit();
  }
</script>

<div class="lift" role="group" aria-label="Lift">
  <div class="head">
    <label class="toggle">
      <input type="checkbox" checked={enabled} aria-label="Lift" onchange={toggle} />
      <span class="title">Lift</span>
    </label>
    <span class="hint">endless rising tone</span>
  </div>

  <div class="body" class:off={!enabled}>
    <div class="direction" role="group" aria-label="Lift direction">
      <button
        type="button"
        class="opt"
        class:selected={direction === 'up'}
        aria-pressed={direction === 'up'}
        disabled={!enabled}
        onclick={() => setDirection('up')}
      >
        Ascending
      </button>
      <button
        type="button"
        class="opt"
        class:selected={direction === 'down'}
        aria-pressed={direction === 'down'}
        disabled={!enabled}
        onclick={() => setDirection('down')}
      >
        Descending
      </button>
    </div>

    <div class="slot">
      <div class="slot-head">
        <label class="label" for="lift-rate">Rate</label>
        <output class="value">{rate.toFixed(2)} oct/s</output>
      </div>
      <input
        id="lift-rate"
        class="slider"
        type="range"
        min={RATE_MIN}
        max={RATE_MAX}
        step={RATE_STEP}
        value={rate}
        aria-label="Lift rate"
        disabled={!enabled}
        oninput={onRate}
      />
    </div>

    <div class="slot">
      <div class="slot-head">
        <label class="label" for="lift-level">Level</label>
        <output class="value">{formatPercent(level)}</output>
      </div>
      <input
        id="lift-level"
        class="slider"
        type="range"
        min={0}
        max={1}
        step={LEVEL_STEP}
        value={level}
        aria-label="Lift level"
        disabled={!enabled}
        oninput={onLevel}
      />
    </div>
  </div>
</div>

<style>
  .lift {
    display: flex;
    flex-direction: column;
    gap: var(--sp-3);
    padding: var(--sp-3);
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
  }
  .head {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
  }
  .toggle {
    display: inline-flex;
    align-items: center;
    gap: var(--sp-2);
    min-height: var(--tap-min);
  }
  .toggle input {
    width: 1.2rem;
    height: 1.2rem;
    accent-color: var(--accent);
  }
  .title {
    font-weight: 600;
  }
  .hint {
    color: var(--text-dim);
    font-size: 0.78rem;
  }
  .body {
    display: flex;
    flex-direction: column;
    gap: var(--sp-3);
  }
  .body.off {
    opacity: 0.5;
  }
  .direction {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: var(--sp-2);
  }
  .opt {
    min-height: var(--tap-min);
    padding: var(--sp-2);
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    color: var(--text-dim);
  }
  .opt.selected {
    border-color: var(--accent);
    color: var(--accent);
    background: var(--surface-2);
  }
  .slot {
    display: flex;
    flex-direction: column;
    gap: var(--sp-2);
  }
  .slot-head {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
  }
  .label {
    font-weight: 600;
  }
  .value {
    font-variant-numeric: tabular-nums;
    color: var(--accent);
  }
  .slider {
    min-height: var(--tap-min);
    accent-color: var(--accent);
  }
</style>
