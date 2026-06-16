<!-- NodeInspector — full editing of the selected node (design §12.1), rebuilt to use the
     SHARED ParamSection (base value + interpolation + modulation), so a node is edited with
     the exact controls the main-page console exposes for node 0, plus the per-segment
     interpolation (linear | exp | hold | smooth).

     REORDER-SAFE SELECTION: the parent tracks the selected node by stable OBJECT identity and
     hands it here as `node`; this component re-resolves the node's CURRENT index from the live
     preset on every read (`indexOf`), so after a time change re-sorts the array every session
     call still targets the SAME node. (A fixed index prop would go stale on reorder — the
     root of the canvas↔control desync.)

     ALWAYS VISIBLE: the editor default-selects node 0, so this panel is never an empty screen.
     The start node (index 0) is pinned at t=0 and cannot be removed (carrier required there).
     Every edit goes through the session store (clamps to RANGES, bumps revision, reapply). -->
<script lang="ts">
  import { untrack } from 'svelte';
  import { getAppContext } from '../context';
  import { baseValueAt } from '../../engine/automation';
  import { formatClock, parseClock } from '../lib/format';
  import type { AutomatableParam, TimeNode } from '../../engine/session-model';
  import { PARAM_ORDER } from './interactions';
  import ParamSection from '../components/ParamSection.svelte';

  interface Props {
    /** The selected node, tracked by identity by the parent (reorder-safe). */
    node: TimeNode;
  }
  let { node }: Props = $props();

  const { session } = getAppContext();

  function read<T>(get: () => T): T {
    void session.revision;
    return get();
  }

  // Re-resolve the live index from identity on every revision — the array re-sorts on a time
  // change, so a cached index would point at a DIFFERENT node afterwards.
  const index = $derived(read(() => session.preset.nodes.indexOf(node)));
  const isStart = $derived(index === 0);
  const tSec = $derived(read(() => session.preset.nodes[index]?.t ?? 0));

  // Params this node already sets, and the ones it could still add (add-param affordance).
  const present = $derived(read(() => PARAM_ORDER.filter((p) => session.preset.nodes[index]?.[p])));
  const addable = $derived(read(() => PARAM_ORDER.filter((p) => !session.preset.nodes[index]?.[p])));

  // --- editable node time (non-start nodes → moveNode; start node pinned at 0:00) ---
  let timeText = $state(untrack(() => formatClock(tSec)));
  let lastTSec = untrack(() => tSec);
  // Resync the time field only on a genuine external change (selection switch, canvas drag,
  // clamp), never while the user is mid-edit — mirrors DurationControl's lastProp pattern.
  $effect(() => {
    if (tSec !== lastTSec) {
      lastTSec = tSec;
      timeText = formatClock(tSec);
    }
  });

  function commitTime(e: Event): void {
    const el = e.currentTarget as HTMLInputElement;
    const sec = parseClock(el.value);
    if (sec === null) {
      timeText = formatClock(tSec);
      el.value = timeText;
      return;
    }
    session.moveNode(index, sec); // clamps to [0, durationSec]; revision resyncs the field
  }

  /** Add a param keyframe the node lacks, carrying the param's current value at this time so
   *  the sound does not change until it is edited (mirrors addNode's carry-forward). */
  function addParam(param: AutomatableParam): void {
    const carry = baseValueAt(session.preset, param, tSec);
    session.setNodeValue(index, param, carry);
  }

  function remove(): void {
    session.removeNode(index);
  }
</script>

{#if index >= 0}
  <aside class="inspector">
    <header class="head">
      <h2>{isStart ? 'Start node' : `Node ${index}`}</h2>
      <button type="button" class="remove" disabled={isStart} onclick={remove}>
        {isStart ? 'Pinned' : 'Remove'}
      </button>
    </header>

    <label class="time">
      <span>Time</span>
      {#if isStart}
        <output class="pinned" aria-label="Start node time">0:00 · start</output>
      {:else}
        <input
          class="time-field"
          type="text"
          inputmode="numeric"
          value={timeText}
          aria-label="Node time"
          oninput={(e) => (timeText = (e.currentTarget as HTMLInputElement).value)}
          onchange={commitTime}
          onblur={commitTime}
        />
      {/if}
    </label>

    {#each present as param (param)}
      <fieldset class="param">
        <legend>{param}</legend>
        <ParamSection {index} {param} showInterpolation={true} />
      </fieldset>
    {/each}

    {#if addable.length > 0}
      <div class="add-param" role="group" aria-label="Add a parameter">
        <span class="add-label">Add param</span>
        {#each addable as param (param)}
          <button type="button" class="add" data-testid={`add-param-${param}`} onclick={() => addParam(param)}>
            + {param}
          </button>
        {/each}
      </div>
    {/if}
  </aside>
{/if}

<style>
  .inspector {
    display: flex;
    flex-direction: column;
    gap: var(--sp-3);
    padding: var(--sp-4);
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
  }
  .head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--sp-2);
  }
  .head h2 {
    font-size: 1rem;
    margin: 0;
  }
  .remove {
    min-height: var(--tap-min);
    padding: 0 var(--sp-3);
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    color: var(--danger);
  }
  .remove:disabled {
    color: var(--text-dim);
    opacity: 0.6;
  }
  .time {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--sp-2);
    font-size: 0.85rem;
    color: var(--text-dim);
  }
  .time-field {
    min-height: var(--tap-min);
    width: 8rem;
    padding: 0 var(--sp-2);
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: 8px;
    font-variant-numeric: tabular-nums;
  }
  .pinned {
    font-variant-numeric: tabular-nums;
    color: var(--text-dim);
  }
  .param {
    display: flex;
    flex-direction: column;
    gap: var(--sp-2);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: var(--sp-3);
    margin: 0;
  }
  legend {
    text-transform: capitalize;
    color: var(--accent);
    padding: 0 var(--sp-1);
  }
  .add-param {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--sp-2);
  }
  .add-label {
    font-size: 0.85rem;
    color: var(--text-dim);
  }
  .add {
    min-height: var(--tap-min);
    padding: 0 var(--sp-3);
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    color: var(--accent);
    text-transform: capitalize;
  }
</style>
