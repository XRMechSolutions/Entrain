<!-- LayerInspector — the full Layer editor (design §17.2/§17.3, interfaces §16). Edits kind
     (only valid pairings offered), source (Synth ToneSpec / "Pick clip…" via the ClipPanel in
     pick mode), start t (mm:ss clamped), loop (kept consistent with kind), and the per-layer
     gain & spatial LanePoint lanes. Every committed edit goes through the §14 SessionStore
     methods — the framework NEVER touches the audio path; it mutates the plain preset and
     reschedules through transport.reapply() (no held node). The controls only offer
     schema-valid kind/source/loop pairings so the inspector can never produce a
     LAYER_SOURCE_INVALID. Unbound (L7) and missing-clip (L8) states are flagged inline. -->
<script lang="ts">
  import { getAppContext } from '../context';
  import { formatClock, parseClock, formatPan } from '../lib/format';
  import { CONTROL } from '../lib/controls';
  import type { Layer, LayerKind, Waveform } from '../../engine/session-model';

  interface Props {
    layerId: string;
  }
  let { layerId }: Props = $props();

  const { session, clips } = getAppContext();

  function rev<T>(read: () => T): T {
    void session.revision;
    return read();
  }

  const layer = $derived(rev(() => session.preset.layers?.find((l) => l.id === layerId) ?? null));
  const durationSec = $derived(rev(() => session.preset.durationSec));
  const clipList = $derived(clips.clips);

  const KINDS: ReadonlyArray<LayerKind> = ['tone', 'ambiance', 'voice'];
  const SHAPES: ReadonlyArray<Waveform> = ['sine', 'triangle', 'square', 'sawtooth'];

  const isSynth = $derived(layer ? 'synth' in layer.source : false);
  const clipId = $derived(layer && 'clipId' in layer.source ? layer.source.clipId : '');
  const isUnbound = $derived(!isSynth && clipId === '');
  // "Missing on this device": a bound clipId that isn't in the local library (L8). Editing
  // and play are NOT blocked — the engine plays it as silence + a one-time notice.
  const isMissing = $derived(!isSynth && clipId !== '' && !clipList.some((c) => c.id === clipId));

  // mm:ss start field — local display state, resynced only on a genuine external change.
  let startText = $state('');
  let lastT = $state<number | null>(null);
  $effect(() => {
    const t = layer?.t ?? 0;
    if (t !== lastT) {
      lastT = t;
      startText = formatClock(t);
    }
  });

  function commitStart(e: Event): void {
    const el = e.currentTarget as HTMLInputElement;
    const sec = parseClock(el.value);
    if (sec === null) {
      startText = formatClock(layer?.t ?? 0);
      el.value = startText;
      return;
    }
    session.setLayerStart(layerId, sec);
  }

  function pickClip(): void {
    // Open the ClipPanel in pick mode; on pick the store binds the chosen clip to this layer.
    clips.openPicker((id) => session.setLayerSource(layerId, { clipId: id }));
  }

  function laneLabel(lane: 'gain' | 'spatial', value: number): string {
    return lane === 'spatial' ? formatPan(value) : `${Math.round(value * 100)} %`;
  }

  function lanePoints(l: Layer, lane: 'gain' | 'spatial') {
    return l[lane] ?? [];
  }
</script>

{#if layer}
  <section class="inspector" aria-label="Layer inspector">
    <!-- kind -->
    <div class="field">
      <span class="lbl">Kind</span>
      <div class="seg" role="group" aria-label="Layer kind">
        {#each KINDS as k (k)}
          <button
            type="button"
            class="seg-btn"
            class:active={layer.kind === k}
            aria-pressed={layer.kind === k}
            onclick={() => session.setLayerKind(layerId, k)}
          >
            {k}
          </button>
        {/each}
      </div>
    </div>

    <!-- source -->
    <div class="field">
      <span class="lbl">Source</span>
      {#if isSynth && 'synth' in layer.source}
        <div class="synth">
          <label class="sub">
            <span>Shape</span>
            <select
              value={layer.source.synth.shape}
              aria-label="Tone shape"
              onchange={(e) => session.setLayerToneSpec(layerId, { shape: (e.currentTarget as HTMLSelectElement).value as Waveform })}
            >
              {#each SHAPES as s (s)}
                <option value={s}>{s}</option>
              {/each}
            </select>
          </label>
          <label class="sub">
            <span>Freq (Hz)</span>
            <input
              type="number"
              min={20}
              max={20000}
              step={1}
              value={layer.source.synth.freqHz}
              aria-label="Tone frequency"
              onchange={(e) => session.setLayerToneSpec(layerId, { freqHz: Number((e.currentTarget as HTMLInputElement).value) })}
            />
          </label>
          <label class="sub">
            <span>Attack (s)</span>
            <input
              type="number"
              min={0}
              step={0.001}
              value={layer.source.synth.attackSec}
              aria-label="Tone attack"
              onchange={(e) => session.setLayerToneSpec(layerId, { attackSec: Number((e.currentTarget as HTMLInputElement).value) })}
            />
          </label>
          <label class="sub">
            <span>Release (s)</span>
            <input
              type="number"
              min={0}
              step={0.1}
              value={layer.source.synth.releaseSec}
              aria-label="Tone release"
              onchange={(e) => session.setLayerToneSpec(layerId, { releaseSec: Number((e.currentTarget as HTMLInputElement).value) })}
            />
          </label>
        </div>
      {:else}
        <div class="clip-source">
          {#if isUnbound}
            <p class="flag warn" data-testid="unbound-flag">Pick a clip to play this layer (Save is blocked until bound).</p>
          {:else if isMissing}
            <p class="flag warn" data-testid="missing-flag">Clip missing on this device — re-import the file to restore it.</p>
          {:else}
            <p class="flag">Clip: {clipId}</p>
          {/if}
          <button type="button" class="pick-btn" onclick={pickClip}>Pick clip…</button>
        </div>
      {/if}
    </div>

    <!-- start time -->
    <div class="field">
      <label class="lbl" for={`layer-start-${layerId}`}>Start (mm:ss)</label>
      <input
        id={`layer-start-${layerId}`}
        class="start-field"
        type="text"
        inputmode="numeric"
        value={startText}
        aria-label="Layer start time"
        onchange={commitStart}
        onblur={commitStart}
      />
      <span class="hint">0 – {formatClock(durationSec)}</span>
    </div>

    <!-- loop -->
    <div class="field row">
      <label class="lbl" for={`layer-loop-${layerId}`}>Loop</label>
      <input
        id={`layer-loop-${layerId}`}
        type="checkbox"
        checked={layer.loop ?? false}
        disabled={layer.kind === 'ambiance'}
        aria-label="Loop layer"
        onchange={(e) => session.setLayerLoop(layerId, (e.currentTarget as HTMLInputElement).checked)}
      />
      {#if layer.kind === 'ambiance'}<span class="hint">Ambiance always loops</span>{/if}
    </div>

    <!-- gain + spatial lanes -->
    {#each ['gain', 'spatial'] as const as lane (lane)}
      <div class="field lane">
        <div class="lane-head">
          <span class="lbl">{lane === 'gain' ? 'Gain lane' : 'Spatial lane'}</span>
          <button type="button" class="lane-add" onclick={() => session.addLayerLanePoint(layerId, lane, 0)}>
            + point
          </button>
        </div>
        {#if lanePoints(layer, lane).length === 0}
          <p class="hint">{lane === 'gain' ? 'Unity (constant 1)' : 'Center'} — add a point to automate.</p>
        {:else}
          <ul class="points">
            {#each lanePoints(layer, lane) as pt, i (i)}
              <li class="point">
                <span class="pt-t">{formatClock(pt.t)}</span>
                <input
                  type="range"
                  min={CONTROL[lane === 'gain' ? 'volume' : 'spatial'].min}
                  max={CONTROL[lane === 'gain' ? 'volume' : 'spatial'].max}
                  step={0.01}
                  value={pt.value}
                  aria-label={`${lane} point ${i + 1} value`}
                  oninput={(e) => session.setLayerLaneValue(layerId, lane, i, Number((e.currentTarget as HTMLInputElement).value))}
                />
                <span class="pt-v">{laneLabel(lane, pt.value)}</span>
                <button
                  type="button"
                  class="pt-del"
                  aria-label={`Remove ${lane} point ${i + 1}`}
                  onclick={() => session.removeLayerLanePoint(layerId, lane, i)}
                >
                  ×
                </button>
              </li>
            {/each}
          </ul>
        {/if}
      </div>
    {/each}
  </section>
{/if}

<style>
  .inspector {
    display: flex;
    flex-direction: column;
    gap: var(--sp-4);
    padding: var(--sp-3);
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
  }
  .field {
    display: flex;
    flex-direction: column;
    gap: var(--sp-2);
  }
  .field.row {
    flex-direction: row;
    align-items: center;
    gap: var(--sp-3);
  }
  .lbl {
    font-weight: 600;
    font-size: 0.9rem;
  }
  .seg {
    display: flex;
    gap: var(--sp-2);
  }
  .seg-btn {
    flex: 1;
    min-height: var(--tap-min);
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    color: var(--text-dim);
    text-transform: capitalize;
  }
  .seg-btn.active {
    border-color: var(--accent);
    color: var(--accent);
  }
  .synth {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: var(--sp-2);
  }
  .sub {
    display: flex;
    flex-direction: column;
    gap: var(--sp-1);
    font-size: 0.78rem;
    color: var(--text-dim);
  }
  .sub select,
  .sub input,
  .start-field {
    min-height: var(--tap-min);
    padding: 0 var(--sp-2);
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    color: var(--text);
  }
  .clip-source {
    display: flex;
    flex-direction: column;
    gap: var(--sp-2);
  }
  .flag {
    margin: 0;
    font-size: 0.85rem;
    color: var(--text-dim);
  }
  .flag.warn {
    color: var(--warning);
  }
  .pick-btn {
    align-self: flex-start;
    min-height: var(--tap-min);
    padding: 0 var(--sp-3);
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    color: var(--accent);
    font-weight: 600;
  }
  .hint {
    font-size: 0.75rem;
    color: var(--text-dim);
  }
  .lane-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }
  .lane-add {
    min-height: var(--tap-min);
    padding: 0 var(--sp-2);
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    color: var(--accent);
    font-size: 0.8rem;
  }
  .points {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: var(--sp-2);
  }
  .point {
    display: flex;
    align-items: center;
    gap: var(--sp-2);
  }
  .pt-t,
  .pt-v {
    font-size: 0.75rem;
    color: var(--text-dim);
    font-variant-numeric: tabular-nums;
    min-width: 3.5rem;
  }
  .point input[type='range'] {
    flex: 1;
  }
  .pt-del {
    background: transparent;
    border: none;
    color: var(--danger);
    font-size: 1.2rem;
    line-height: 1;
  }
</style>
