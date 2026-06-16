<!-- WaveformPicker — node 0's oscillator shape (design §6). A committed enum choice
     (segmented buttons) calls `onchange` → session.setWaveform → reapply. One-way: the
     selection is reflected from the `value` prop, not bound to the preset. -->
<script lang="ts">
  import type { Waveform } from '../../engine/session-model';

  interface Props {
    value: Waveform;
    onchange: (w: Waveform) => void;
  }
  let { value, onchange }: Props = $props();

  const options: ReadonlyArray<{ id: Waveform; glyph: string }> = [
    { id: 'sine', glyph: '∿' },
    { id: 'triangle', glyph: '△' },
    { id: 'square', glyph: '⊓' },
    { id: 'sawtooth', glyph: '◺' },
  ];
</script>

<div class="picker" role="group" aria-label="Waveform">
  {#each options as opt (opt.id)}
    <button
      type="button"
      class="opt"
      class:selected={value === opt.id}
      aria-pressed={value === opt.id}
      onclick={() => onchange(opt.id)}
    >
      <span class="glyph" aria-hidden="true">{opt.glyph}</span>
      <span class="name">{opt.id}</span>
    </button>
  {/each}
</div>

<style>
  .picker {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: var(--sp-2);
  }
  .opt {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: var(--sp-1);
    min-height: var(--tap-min);
    padding: var(--sp-2);
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    color: var(--text-dim);
    text-transform: capitalize;
  }
  .opt.selected {
    border-color: var(--accent);
    color: var(--accent);
    background: var(--surface-2);
  }
  .glyph {
    font-size: 1.2rem;
  }
  .name {
    font-size: 0.72rem;
  }
</style>
