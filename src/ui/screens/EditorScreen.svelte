<!-- EditorScreen — the Advanced node editor (design §12/§13), rebuilt into a REAL editor with
     tools always visible (the owner's "it's just a canvas" gap):

       • a toolbar — preset Name, a prominent Duration control (mm:ss field + quick chips),
         and "+ Add node" (carry-forward node at a chosen time / the playhead);
       • a NODE LIST of chips (each node's mm:ss, the t=0 node labeled "start"; tap to select,
         the selected one highlighted);
       • the TimelineCanvas as the visualization (tap a node → select it), width-constrained
         so it fits the editor container rather than stretching full-bleed;
       • an ALWAYS-VISIBLE inspector (default-selects node 0 — never an empty screen).

     SELECTION IS REORDER-SAFE: it is tracked by stable node OBJECT identity in `$state.raw`
     (raw, so the plain preset node is never wrapped in a reactive proxy and identity holds).
     Dragging/moving a node re-sorts the array, but the selected object is unchanged, so the
     inspector keeps editing the SAME node and its controls follow it. -->
<script lang="ts">
  import { onMount } from 'svelte';
  import { getAppContext } from '../context';
  import { formatClock, parseClock } from '../lib/format';
  import { MIN_NODE_DT_SEC } from '../lib/constants';
  import { PARAM_ORDER } from '../editor/interactions';
  import type { AutomatableParam, LayerKind, TimeNode, Waveform } from '../../engine/session-model';
  import type { NodeHit } from '../editor/interactions';
  import TimelineCanvas from '../editor/TimelineCanvas.svelte';
  import NodeInspector from '../editor/NodeInspector.svelte';
  import LayerList from '../editor/LayerList.svelte';
  import LayerInspector from '../editor/LayerInspector.svelte';
  import DurationControl from '../components/DurationControl.svelte';
  import WaveformPicker from '../components/WaveformPicker.svelte';
  import ClipPanel from '../components/ClipPanel.svelte';
  import RenderSheet from '../components/RenderSheet.svelte';
  import VoiceScriptImport from '../components/VoiceScriptImport.svelte';

  const { ui, session, transport, clips } = getAppContext();

  function rev<T>(read: () => T): T {
    void session.revision;
    return read();
  }

  // ----- Phase-2: which Editor sub-view is active + which layer is selected -----
  type SubTab = 'nodes' | 'layers' | 'clips' | 'export';
  let subTab = $state<SubTab>('nodes');
  let selectedLayerId = $state<string | null>(null);

  const layers = $derived(rev(() => session.preset.layers ?? []));

  // Refresh the clip library once when the editor mounts so the clip panel + missing-clip
  // checks have current metadata (cheap: list() is metadata-only, no blobs in memory).
  onMount(() => {
    clips.refresh();
  });

  function addLayer(kind: LayerKind): void {
    selectedLayerId = session.addLayer(kind);
    subTab = 'layers';
  }
  function editLayer(id: string): void {
    selectedLayerId = id;
  }
  function removeLayer(id: string): void {
    session.removeLayer(id);
    if (selectedLayerId === id) selectedLayerId = null;
  }
  // The layer inspector targets the selected layer, falling back to the first one so the
  // panel is never empty while layers exist.
  const inspectedLayerId = $derived.by<string | null>(() => {
    if (selectedLayerId && layers.some((l) => l.id === selectedLayerId)) return selectedLayerId;
    return layers[0]?.id ?? null;
  });

  // Selection by stable identity ($state.raw keeps the preset node a PLAIN object, not a
  // $state proxy — so `includes`/`indexOf` identity checks hold across re-sorts).
  let selectedNode = $state.raw<TimeNode | null>(null);

  const nodes = $derived(rev(() => session.preset.nodes));
  // Resolve the live selection; fall back to the start node if the tracked node is gone
  // (after reset / removeNode), so the inspector is never empty.
  const resolved = $derived.by<TimeNode | null>(() => {
    const list = nodes;
    if (selectedNode && list.includes(selectedNode)) return selectedNode;
    return list[0] ?? null;
  });
  const selectedIndex = $derived(resolved ? nodes.indexOf(resolved) : -1);

  // The canvas highlights a single (index, param) handle: map the selected node to its first
  // present param. Reorder-safe because selectedIndex re-resolves from identity each revision.
  const selectedHit = $derived.by<NodeHit | null>(() => {
    if (!resolved || selectedIndex < 0) return null;
    const param = PARAM_ORDER.find((p) => resolved[p]);
    return param ? { index: selectedIndex, param } : null;
  });

  const name = $derived(rev(() => session.preset.name));
  const durationSec = $derived(rev(() => session.preset.durationSec));
  // Node-0 oscillator shape (the preset's waveform). Edited here in the Advanced toolbar since
  // the Player page is now a read-only monitor.
  const waveform = $derived<Waveform>(rev(() => session.preset.nodes[0].waveform ?? 'sine'));

  function selectByHit(hit: NodeHit | null): void {
    selectedNode = hit ? (session.preset.nodes[hit.index] ?? null) : null;
  }
  function selectNode(n: TimeNode): void {
    selectedNode = n;
  }

  // --- add a carry-forward node (no sound change) at a chosen time / the playhead ---
  let addTimeText = $state('');
  function addNode(): void {
    const dur = session.preset.durationSec;
    const parsed = parseClock(addTimeText);
    const playhead = transport.position();
    const base = parsed ?? (Number.isFinite(playhead) && playhead > 0 ? playhead : dur / 2);
    // Clamp strictly inside (0, duration) so a new node never duplicates the start node's t=0.
    const t = Math.min(dur - MIN_NODE_DT_SEC, Math.max(MIN_NODE_DT_SEC, base));
    const idx = Number(session.addNode(t, 'carrier' satisfies AutomatableParam));
    selectedNode = session.preset.nodes[idx] ?? selectedNode;
    addTimeText = '';
  }
</script>

<section class="editor" class:wide={ui.isWide}>
  <div class="main">
    <!-- Phase-2 Editor sub-tabs + header actions (design §16.3). Render/Import are
         capability-gated inside their own components, never width-hidden. -->
    <nav class="subtabs" aria-label="Editor sections">
      {#each [['nodes', 'Nodes'], ['layers', 'Layers'], ['clips', 'Clips'], ['export', 'Export']] as const as [id, label] (id)}
        <button
          type="button"
          class="subtab"
          class:active={subTab === id}
          aria-pressed={subTab === id}
          data-testid={`subtab-${id}`}
          onclick={() => (subTab = id)}
        >
          {label}
        </button>
      {/each}
    </nav>

    {#if subTab === 'layers'}
      <LayerList {layers} selectedId={inspectedLayerId} onadd={addLayer} onedit={editLayer} onremove={removeLayer} />
    {:else if subTab === 'clips'}
      <ClipPanel mode={clips.mode} onpick={(id) => clips.pick(id)} />
    {:else if subTab === 'export'}
      <div class="export-actions">
        <RenderSheet />
        <VoiceScriptImport />
      </div>
    {/if}

    <div class="toolbar" class:hidden={subTab !== 'nodes'}>
      <label class="name">
        <span class="lbl">Name</span>
        <input
          class="name-field"
          type="text"
          value={name}
          aria-label="Preset name"
          maxlength="80"
          oninput={(e) => session.setName((e.currentTarget as HTMLInputElement).value)}
        />
      </label>

      <DurationControl value={durationSec} oncommit={(s) => session.setDuration(s)} />

      <div class="waveform">
        <span class="lbl">Waveform</span>
        <WaveformPicker value={waveform} onchange={(w) => session.setWaveform(w)} />
      </div>

      <div class="add-node">
        <input
          class="add-time"
          type="text"
          inputmode="numeric"
          placeholder="mm:ss (playhead)"
          value={addTimeText}
          aria-label="New node time"
          oninput={(e) => (addTimeText = (e.currentTarget as HTMLInputElement).value)}
        />
        <button type="button" class="add-btn" data-testid="add-node" onclick={addNode}>+ Add node</button>
      </div>

      <div class="nodes" role="group" aria-label="Nodes">
        {#each nodes as n, i (n)}
          <button
            type="button"
            class="chip"
            class:active={n === resolved}
            aria-pressed={n === resolved}
            data-testid={`node-chip-${i}`}
            onclick={() => selectNode(n)}
          >
            {i === 0 ? 'start' : formatClock(n.t)}
          </button>
        {/each}
      </div>
    </div>

    {#if subTab === 'nodes'}
      <div class="canvas-wrap">
        <TimelineCanvas selected={selectedHit} onselect={selectByHit} />
      </div>
    {/if}
  </div>

  <div class="inspector-wrap">
    {#if subTab === 'nodes' && resolved}
      <NodeInspector node={resolved} />
    {:else if subTab === 'layers' && inspectedLayerId}
      <LayerInspector layerId={inspectedLayerId} />
    {/if}
  </div>
</section>

<style>
  .editor {
    display: flex;
    flex-direction: column;
    gap: var(--sp-4);
    padding: var(--sp-3);
    /* Centered with a max-width on desktop so the canvas is usable, not stretched
       full-bleed (design §13). */
    width: 100%;
    max-width: 960px;
    margin-inline: auto;
  }
  .main {
    display: flex;
    flex-direction: column;
    gap: var(--sp-3);
    min-width: 0;
    flex: 1;
  }
  .subtabs {
    display: flex;
    gap: var(--sp-2);
    flex-wrap: wrap;
  }
  .subtab {
    min-height: var(--tap-min);
    padding: 0 var(--sp-3);
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    color: var(--text-dim);
  }
  .subtab.active {
    border-color: var(--accent);
    color: var(--accent);
    background: var(--surface-2);
  }
  .export-actions {
    display: flex;
    flex-direction: column;
    gap: var(--sp-4);
  }
  .toolbar {
    display: flex;
    flex-direction: column;
    gap: var(--sp-3);
  }
  .toolbar.hidden {
    display: none;
  }
  .name {
    display: flex;
    flex-direction: column;
    gap: var(--sp-1);
  }
  .waveform {
    display: flex;
    flex-direction: column;
    gap: var(--sp-1);
  }
  .lbl {
    font-weight: 600;
  }
  .name-field {
    min-height: var(--tap-min);
    padding: 0 var(--sp-2);
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: var(--radius);
  }
  .add-node {
    display: flex;
    gap: var(--sp-2);
    align-items: center;
  }
  .add-time {
    flex: 1;
    min-width: 0;
    min-height: var(--tap-min);
    padding: 0 var(--sp-2);
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    font-variant-numeric: tabular-nums;
  }
  .add-btn {
    flex: none;
    min-height: var(--tap-min);
    padding: 0 var(--sp-3);
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    color: var(--accent);
    font-weight: 600;
  }
  .nodes {
    display: flex;
    flex-wrap: wrap;
    gap: var(--sp-2);
  }
  .chip {
    min-height: var(--tap-min);
    min-width: var(--tap-min);
    padding: 0 var(--sp-3);
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    color: var(--text-dim);
    font-variant-numeric: tabular-nums;
  }
  .chip.active {
    border-color: var(--accent);
    color: var(--accent);
    background: var(--surface-2);
  }
  .canvas-wrap {
    min-width: 0;
  }
  .inspector-wrap {
    min-width: 0;
  }

  /* Wide: canvas + tools on the left, inspector a fixed right panel (design §13). */
  .editor.wide {
    flex-direction: row;
    align-items: flex-start;
  }
  .editor.wide .inspector-wrap {
    width: 340px;
    flex: none;
  }
</style>
