<!-- ModulationPanel — the live modulation controls for ONE param of ONE node (the console's
     "Warble" for carrier/beat, "Isochronic pulse" for volume). The console renders it at
     `index=0`; the Advanced inspector passes the selected node's index, so the SAME friendly
     panel edits any node's modulator. THE ONE INVIOLABLE RULE is honoured: every control is
     ONE-WAY. Displays derive from the plain preset through session.revision; commits flow OUT
     through session.setNodeMod(index, param, patch) (off → null/clear, on → a ModPoint). Rate
     is shown in Hz and converted to periodSec = 1/rate (clamped 0.01–40 Hz, periodSec > 0); a
     read-only cycle-time readout (seconds per cycle) sits beside it so a slow pan/breath sweep
     reads as a cadence (e.g. 0.06 Hz ≈ 16 s) you can match to a breathing pattern. -->
<script lang="ts">
  import { getAppContext } from '../context';
  import { CONTROL, type ControlSpec } from '../lib/controls';
  import { RANGES, type AutomatableParam, type ModPoint, type ModShape, type ModTransition } from '../../engine/session-model';
  import type { ModPatch } from '../stores/session.svelte';
  import ParamControl from './ParamControl.svelte';

  interface Props {
    param: AutomatableParam;
    /** Which node's modulator this panel edits. The console uses 0; the inspector passes
     *  the selected node's (reorder-resolved) index. */
    index?: number;
    /** Which voice's nodes to read/mutate. Omit for the primary voice (voice 0). */
    voiceId?: string;
  }
  let { param, index = 0, voiceId }: Props = $props();

  const { session } = getAppContext();

  // Re-derive on every committed edit; the value itself comes from the plain preset.
  function read<T>(get: () => T): T {
    void session.revision;
    return get();
  }

  const MOD_SHAPES: ReadonlyArray<ModShape> = ['sine', 'triangle', 'square', 'pulse', 'box'];
  // `box` is the breath trapezoid (ramp-hold-ramp-hold); label it so users find it.
  const SHAPE_LABELS: Record<ModShape, string> = {
    sine: 'sine',
    triangle: 'triangle',
    square: 'square',
    pulse: 'pulse',
    box: 'box (breath)',
  };

  // Rate clamps so periodSec = 1/rate is always finite and > 0 (session-model requires it).
  const RATE_MIN_HZ = 0.01;
  const RATE_MAX_HZ = 40;
  const RATE_SPEC: ControlSpec = { min: RATE_MIN_HZ, max: RATE_MAX_HZ, step: 0.01, unit: 'Hz' };
  // Depth is a 0–1 fraction for every param (shown %): for carrier/beat it is the warble
  // swing as a fraction of the base frequency (±%), for volume the tremolo amount, for
  // spatial the position swing. (carrier/beat were absolute Hz before schema v5.)
  const DEPTH_SPEC: Readonly<Record<AutomatableParam, ControlSpec>> = {
    carrier: { min: 0, max: 1, step: 0.01, unit: '%' },
    beat: { min: 0, max: 1, step: 0.01, unit: '%' },
    volume: { min: 0, max: 1, step: 0.01, unit: '%' },
    spatial: { min: 0, max: 1, step: 0.01, unit: '' },
  };
  const PULSE_WIDTH_SPEC: ControlSpec = { min: 0, max: 1, step: 0.05, unit: '%' };
  // Hold ratio for the box shape: 0 = smooth sweep, 0.5 = even 4-4-4-4 box, →1 mostly hold.
  const HOLD_SPEC: ControlSpec = { min: 0, max: 1, step: 0.05, unit: '%' };
  const EDGE_SPEC: ControlSpec = { min: 0, max: 50, step: 1, unit: 'ms' };

  const heading = $derived(param === 'volume' ? 'Isochronic pulse' : 'Warble');
  const range = $derived(RANGES[param]);
  const stepStep = $derived(CONTROL[param].step);

  /** A sensible default ModPoint for the On toggle: pulse for volume (isochronic), a slow
   *  sine warble for carrier/beat. */
  function defaultMod(): ModPatch {
    if (param === 'volume') {
      return { shape: 'pulse', periodSec: 0.1, depth: 0.9, transition: 'glide', pulseWidth: 0.5, edgeMs: 2 };
    }
    if (param === 'beat') return { shape: 'sine', periodSec: 10, depth: 0.15, transition: 'glide' };
    return { shape: 'sine', periodSec: 5, depth: 0.03, transition: 'glide' };
  }

  function clampRate(hz: number): number {
    return Math.min(RATE_MAX_HZ, Math.max(RATE_MIN_HZ, hz));
  }
  /** Display rate (Hz) from a stored periodSec; falls back to the param's default rate when
   *  the period is missing or non-positive. */
  function rateFromPeriod(periodSec: number | undefined): number {
    const p = periodSec && periodSec > 0 ? periodSec : (defaultMod().periodSec ?? 1);
    return clampRate(1 / p);
  }
  function clampStep(v: number): number {
    return Math.min(range.max, Math.max(range.min, v));
  }
  function edgeExceedsHalfPeriod(periodSec?: number, edgeMs?: number): boolean {
    if (periodSec === undefined || edgeMs === undefined) return false;
    return edgeMs > (periodSec * 1000) / 2;
  }

  // Derive the active voice's preset view — a NEW object on every revision, so all downstream
  // deriveds re-run even when the underlying nodes array reference hasn't changed.
  const vView = $derived(read(() => session.voiceView(voiceId)));

  // --- one-way derived display state ---
  const isOn = $derived(
    (() => {
      const m = vView.nodes[index]?.[param]?.mod;
      return m !== undefined && m !== null;
    })(),
  );
  const mod = $derived<ModPoint>(
    (() => {
      const m = vView.nodes[index]?.[param]?.mod;
      return m && typeof m === 'object' ? m : {};
    })(),
  );
  const shape = $derived<ModShape>(mod.shape ?? (param === 'volume' ? 'pulse' : 'sine'));
  const transition = $derived<ModTransition>(mod.transition ?? 'glide');
  const rateHz = $derived(rateFromPeriod(mod.periodSec));
  // Cycle time (seconds per full cycle) shown next to the Hz rate so a slow sweep reads as a
  // breathing cadence — e.g. 0.06 Hz ≈ 16 s/cycle — instead of an opaque fraction of a hertz.
  const cycleSec = $derived(1 / rateHz);
  const cycleLabel = $derived(cycleSec >= 10 ? `${cycleSec.toFixed(1)} s` : `${cycleSec.toFixed(2)} s`);
  const depth = $derived(mod.depth ?? defaultMod().depth ?? 0);
  const pulseWidth = $derived(mod.pulseWidth ?? 0.5);
  const edgeMs = $derived(mod.edgeMs ?? 0);
  const steps = $derived<number[]>(mod.steps ?? []);
  const baseValue = $derived(vView.nodes[index]?.[param]?.value ?? range.min);

  // --- commits (all flow through the session store's three-state setNodeMod) ---
  function toggle(on: boolean): void {
    session.setNodeMod(index, param, on ? defaultMod() : null, voiceId);
  }
  /** Merge a partial change onto the current ModPoint and re-commit. */
  function patch(p: Partial<ModPatch>): void {
    session.setNodeMod(index, param, { ...mod, ...p }, voiceId);
  }
  function commitRate(hz: number): void {
    patch({ periodSec: 1 / clampRate(hz) });
  }
  function setSteps(next: number[]): void {
    const merged: ModPatch = { ...mod };
    if (next.length === 0) delete merged.steps; // never author an empty steps[] (would be invalid)
    else merged.steps = next;
    session.setNodeMod(index, param, merged, voiceId);
  }
  function addStep(): void {
    setSteps([...steps, clampStep(baseValue)]);
  }
  function editStep(i: number, v: number): void {
    if (!Number.isFinite(v)) return; // never write a non-finite step
    setSteps(steps.map((s, idx) => (idx === i ? clampStep(v) : s)));
  }
  function removeStep(i: number): void {
    setSteps(steps.filter((_, idx) => idx !== i));
  }
</script>

<div class="mod" class:on={isOn}>
  <label class="switch">
    <input
      type="checkbox"
      checked={isOn}
      aria-label={`${heading} enabled`}
      data-testid={`mod-toggle-${param}`}
      onchange={(e) => toggle((e.currentTarget as HTMLInputElement).checked)}
    />
    <span class="legend">{heading}</span>
  </label>

  {#if isOn}
    <div class="body">
      <label class="select">
        <span>Shape</span>
        <select
          aria-label={`${heading} shape`}
          data-testid={`mod-shape-${param}`}
          value={shape}
          onchange={(e) => patch({ shape: (e.currentTarget as HTMLSelectElement).value as ModShape })}
        >
          {#each MOD_SHAPES as sh (sh)}<option value={sh}>{SHAPE_LABELS[sh]}</option>{/each}
        </select>
      </label>

      <ParamControl label="Rate" spec={RATE_SPEC} value={rateHz} oninput={() => {}} oncommit={commitRate} />
      <p class="cycle" data-testid={`mod-cycle-${param}`}>≈ {cycleLabel} per cycle</p>
      <ParamControl label="Depth" spec={DEPTH_SPEC[param]} value={depth} oninput={() => {}} oncommit={(v) => patch({ depth: v })} />

      <label class="select">
        <span>Transition</span>
        <select
          aria-label={`${heading} transition`}
          data-testid={`mod-transition-${param}`}
          value={transition}
          onchange={(e) => patch({ transition: (e.currentTarget as HTMLSelectElement).value as ModTransition })}
        >
          <option value="glide">glide</option>
          <option value="jump">jump</option>
        </select>
      </label>

      {#if shape === 'pulse' || shape === 'square'}
        <!-- Duty cycle applies to both square and pulse (the engine honours pulseWidth for
             both; only sine/triangle ignore it). Edge softening is pulse-only (square = hard). -->
        <ParamControl label="Pulse width" spec={PULSE_WIDTH_SPEC} value={pulseWidth} oninput={() => {}} oncommit={(v) => patch({ pulseWidth: v })} />
      {/if}
      {#if shape === 'pulse'}
        <ParamControl label="Edge" spec={EDGE_SPEC} value={edgeMs} oninput={() => {}} oncommit={(v) => patch({ edgeMs: v })} />
        {#if edgeExceedsHalfPeriod(mod.periodSec, mod.edgeMs)}
          <p class="warn" role="status">Edge exceeds half the period; edges will be clamped.</p>
        {/if}
      {/if}

      {#if shape === 'box'}
        <!-- Hold ratio reuses pulseWidth: 0 = smooth sweep, 0.5 = even box, →1 mostly hold.
             Edge and the steps list are hidden for box (it owns its trapezoid trajectory). -->
        <ParamControl label="Hold" spec={HOLD_SPEC} value={pulseWidth} oninput={() => {}} oncommit={(v) => patch({ pulseWidth: v })} />
      {/if}

      {#if transition === 'jump' && shape !== 'box'}
        <div class="steps">
          <p class="steps-head">Steps — one value per cycle (snaps through these)</p>
          {#each steps as s, i (i)}
            <div class="step-row">
              <input
                class="step-input"
                type="number"
                min={range.min}
                max={range.max}
                step={stepStep}
                value={s}
                aria-label={`${heading} step ${i + 1}`}
                onchange={(e) => editStep(i, Number((e.currentTarget as HTMLInputElement).value))}
              />
              <button type="button" class="step-remove" aria-label={`Remove step ${i + 1}`} onclick={() => removeStep(i)}>✕</button>
            </div>
          {/each}
          <button type="button" class="add-step" data-testid={`mod-add-step-${param}`} onclick={addStep}>+ Add step</button>
        </div>
      {/if}
    </div>
  {/if}
</div>

<style>
  .mod {
    display: flex;
    flex-direction: column;
    gap: var(--sp-3);
    padding: var(--sp-3);
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
  }
  .switch {
    display: inline-flex;
    align-items: center;
    gap: var(--sp-2);
    min-height: var(--tap-min);
  }
  .switch input {
    width: 1.2rem;
    height: 1.2rem;
    accent-color: var(--accent);
  }
  .legend {
    font-weight: 600;
    color: var(--accent);
  }
  .body {
    display: flex;
    flex-direction: column;
    gap: var(--sp-3);
    border-top: 1px dashed var(--border);
    padding-top: var(--sp-3);
  }
  .select {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--sp-2);
    font-size: 0.85rem;
    color: var(--text-dim);
  }
  .select select {
    min-height: var(--tap-min);
    padding: 0 var(--sp-2);
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: 8px;
    text-transform: capitalize;
  }
  .cycle {
    /* Pull the readout up under the Rate control (countering the .body gap) so it reads as a
       sub-label of the rate, not a separate row. */
    margin: calc(-1 * var(--sp-2)) 0 0;
    font-size: 0.8rem;
    color: var(--text-dim);
    font-variant-numeric: tabular-nums;
  }
  .warn {
    margin: 0;
    color: var(--warning);
    font-size: 0.8rem;
  }
  .steps {
    display: flex;
    flex-direction: column;
    gap: var(--sp-2);
    border-top: 1px dashed var(--border);
    padding-top: var(--sp-2);
  }
  .steps-head {
    margin: 0;
    font-size: 0.8rem;
    color: var(--text-dim);
  }
  .step-row {
    display: flex;
    gap: var(--sp-2);
    align-items: center;
  }
  .step-input {
    flex: 1;
    min-height: var(--tap-min);
    padding: 0 var(--sp-2);
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: var(--radius);
  }
  .step-remove {
    flex: none;
    width: var(--tap-min);
    height: var(--tap-min);
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    color: var(--danger);
  }
  .add-step {
    min-height: var(--tap-min);
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    color: var(--accent);
  }
</style>
