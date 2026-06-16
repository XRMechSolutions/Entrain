<!-- MasterVolume — the ONE cheap live control (design §6.1). Unlike the param controls it
     does NOT reschedule: every `input` sample streams straight to session.setMasterGain
     (→ transport.setMasterTrim, a 10ms no-click ramp) and is safe to fire continuously
     during a drag. Still one-way: reflects `value`, never binds the preset. -->
<script lang="ts">
  import { untrack } from 'svelte';
  import { formatPercent } from '../lib/format';
  import { CONTROL } from '../lib/controls';

  interface Props {
    value: number;
    oninput: (v: number) => void;
  }
  let { value, oninput }: Props = $props();

  const spec = CONTROL.masterGain;
  let display = $state(untrack(() => value));
  let lastProp = untrack(() => value);
  $effect(() => {
    if (value !== lastProp) {
      lastProp = value;
      display = value;
    }
  });

  function stream(e: Event): void {
    const v = Number((e.currentTarget as HTMLInputElement).value);
    if (!Number.isFinite(v)) return;
    display = v;
    oninput(v); // the cheap live path — streams every sample
  }
</script>

<div class="master">
  <div class="head">
    <label class="label" for="master-volume">Master volume</label>
    <output class="value">{formatPercent(display)}</output>
  </div>
  <input
    id="master-volume"
    class="slider"
    type="range"
    min={spec.min}
    max={spec.max}
    step={spec.step}
    value={display}
    aria-label="Master volume"
    oninput={stream}
  />
</div>

<style>
  .master {
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
