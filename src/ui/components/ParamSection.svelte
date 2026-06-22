<!-- ParamSection — the UNIFIED per-node control for ONE param of ONE node, shared by the
     main-page console (index 0, no interpolation) and the Advanced inspector (any node, with
     interpolation). It bundles the three things you can edit about a param at a node:

       1. the BASE value          → session.setNodeValue(index, param, v)   (ParamControl)
       2. how it INTERPOLATES      → session.setNodeTransition(index, param, tr)  (when showInterpolation)
          into the next node       (linear | exp | hold | smooth; exp greyed when it would
                                    ramp to/through zero — interactions.expDisabled)
       3. its MODULATION           → <ModulationPanel index param />  (warble / isochronic)

     THE ONE INVIOLABLE RULE is honoured: every display derives from the plain preset through
     session.revision; commits flow OUT through the session store (which re-derives audio via
     reapply). The control never binds onto a preset/audio field. Because the displayed value
     is a revision-derived prop, an EXTERNAL change (a canvas drag moving this node's handle,
     another control, or switching the selected node) flows straight into ParamControl, whose
     local display $state resyncs — fixing the stale-control bug. -->
<script lang="ts">
  import { getAppContext } from '../context';
  import { CONTROL } from '../lib/controls';
  import { DEFAULTS } from '../../engine/session-model';
  import type { AutomatableParam, ParamTransition } from '../../engine/session-model';
  import { expDisabled } from '../editor/interactions';
  import ParamControl from './ParamControl.svelte';
  import ModulationPanel from './ModulationPanel.svelte';

  interface Props {
    index: number;
    param: AutomatableParam;
    /** Show the transition selector. The console hides it (node-0 interpolation is a no-op,
     *  there is no previous node to ramp from); the inspector shows it. */
    showInterpolation?: boolean;
    /** Which voice's nodes to read/mutate. Omit for the primary voice (voice 0). */
    voiceId?: string;
  }
  let { index, param, showInterpolation = false, voiceId }: Props = $props();

  const { session } = getAppContext();

  function read<T>(get: () => T): T {
    void session.revision;
    return get();
  }

  // AutomatableParam is a subset of CONTROL's keys (carrier/beat/volume/spatial all have specs).
  const spec = $derived(CONTROL[param]);
  const label = $derived(param.charAt(0).toUpperCase() + param.slice(1));

  // Derive the active voice's preset view — re-resolves on every revision and voiceId change.
  // All display reads go through this view so an extra-voice inspector shows the correct values.
  const vView = $derived(read(() => session.voiceView(voiceId)));

  // One-way derived displays (all depend on session.revision). An absent lane shows its
  // eval-time default (spatial = 0 center, volume = 1, beat = 0) — NOT spec.min, which for
  // spatial would wrongly read full-left. Carrier is always present, so its min is only a
  // defensive fallback.
  const fallback = $derived(param === 'carrier' ? spec.min : DEFAULTS[param]);
  const value = $derived(vView.nodes[index]?.[param]?.value ?? fallback);
  const transition = $derived<ParamTransition>(vView.nodes[index]?.[param]?.transition ?? 'linear');
  const expGreyed = $derived(expDisabled(vView, index, param));

  const TRANSITIONS: ReadonlyArray<ParamTransition> = ['linear', 'exp', 'hold', 'smooth'];

  function commitValue(v: number): void {
    session.setNodeValue(index, param, v, voiceId);
  }
  function commitTransition(tr: ParamTransition): void {
    session.setNodeTransition(index, param, tr, voiceId);
  }
</script>

<section class="param-section" aria-label={`${label} controls`}>
  <ParamControl {label} {spec} {value} oninput={() => {}} oncommit={commitValue} />

  {#if showInterpolation}
    <label class="interp">
      <span>Transition to next</span>
      <select
        aria-label={`${label} transition`}
        data-testid={`interp-${param}`}
        value={transition}
        onchange={(e) => commitTransition((e.currentTarget as HTMLSelectElement).value as ParamTransition)}
      >
        {#each TRANSITIONS as tr (tr)}
          <option value={tr} disabled={tr === 'exp' && expGreyed}>{tr}</option>
        {/each}
      </select>
    </label>
  {/if}

  <ModulationPanel {param} {index} {voiceId} />
</section>

<style>
  .param-section {
    display: flex;
    flex-direction: column;
    gap: var(--sp-2);
  }
  .interp {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--sp-2);
    padding: 0 var(--sp-1);
    font-size: 0.85rem;
    color: var(--text-dim);
  }
  .interp select {
    min-height: var(--tap-min);
    padding: 0 var(--sp-2);
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: 8px;
    text-transform: capitalize;
  }
</style>
