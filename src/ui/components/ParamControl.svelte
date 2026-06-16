<!-- ParamControl — one carrier/beat/volume control (design §6). THE ONE INVIOLABLE RULE:
     it is ONE-WAY. The slider/number bind to a LOCAL display $state, never to the preset.
     `oninput` fires every drag sample to update the DISPLAY only (no reschedule); `oncommit`
     fires on release / change / Enter / blur and is what calls session.setNodeParam (which
     reschedules via reapply). Out-of-range typed values clamp to spec [min,max]; empty/NaN
     reverts to the last valid value and is NOT committed (never writes a non-finite, edge
     B2/B3). The display re-syncs only when the external `value` prop actually changes. -->
<script lang="ts">
  import { untrack } from 'svelte';
  import type { ControlSpec } from '../lib/controls';
  import { formatHz, formatPan, formatPercent } from '../lib/format';

  interface Props {
    label: string;
    spec: ControlSpec;
    value: number;
    oninput: (v: number) => void;
    oncommit: (v: number) => void;
  }
  let { label, spec, value, oninput, oncommit }: Props = $props();

  // Initial display = the incoming value (captured untracked; later syncs run in the
  // $effect below on a genuine external change).
  let display = $state(untrack(() => value));
  let lastProp = untrack(() => value);
  // Resync ONLY on a genuine external change (open/reset/clamp), never during a drag —
  // the prop is unchanged while dragging, so the local display is never clobbered.
  $effect(() => {
    if (value !== lastProp) {
      lastProp = value;
      display = value;
    }
  });

  function readout(v: number): string {
    if (spec.unit === '%') return formatPercent(v);
    if (spec.unit === 'Hz') return formatHz(v, spec.step < 1 ? 1 : 0);
    if (spec.unit === 'pan') return formatPan(v);
    return String(v);
  }

  function clamp(v: number): number {
    return Math.min(spec.max, Math.max(spec.min, v));
  }

  function onLiveInput(e: Event): void {
    const v = Number((e.currentTarget as HTMLInputElement).value);
    if (!Number.isFinite(v)) return; // a half-typed/empty field updates nothing live
    display = v;
    oninput(v); // DISPLAY ONLY — no reschedule
  }

  function onCommit(e: Event): void {
    const raw = (e.currentTarget as HTMLInputElement).value;
    const v = Number(raw);
    if (raw.trim() === '' || !Number.isFinite(v)) {
      display = value; // revert to last valid; nothing written (B3)
      return;
    }
    const clamped = clamp(v);
    display = clamped;
    oncommit(clamped); // reschedules (session.setNodeParam → reapply)
  }
</script>

<div class="control">
  <div class="head">
    <label class="label" for={`pc-${label}`}>{label}</label>
    <output class="value" aria-live="off">{readout(display)}</output>
  </div>
  <div class="row">
    <input
      id={`pc-${label}`}
      class="slider"
      type="range"
      min={spec.min}
      max={spec.max}
      step={spec.step}
      value={display}
      aria-label={label}
      oninput={onLiveInput}
      onchange={onCommit}
      onpointerup={onCommit}
    />
    <input
      class="number"
      type="number"
      min={spec.min}
      max={spec.max}
      step={spec.step}
      value={display}
      aria-label={`${label} value`}
      oninput={onLiveInput}
      onchange={onCommit}
      onblur={onCommit}
    />
  </div>
</div>

<style>
  .control {
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
  .row {
    display: flex;
    gap: var(--sp-3);
    align-items: center;
  }
  .slider {
    flex: 1;
    min-height: var(--tap-min);
    accent-color: var(--accent);
  }
  .number {
    width: 6rem;
    min-height: var(--tap-min);
    padding: 0 var(--sp-2);
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: var(--radius);
  }
</style>
