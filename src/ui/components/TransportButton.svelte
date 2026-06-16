<!-- TransportButton — the big tap-to-play primary control (design §5). The label/icon
     follow the playback.state table; the click handler calls `onprimary` SYNCHRONOUSLY
     (the parent maps it to play/pause; play() must be the first call with no await before
     it — gesture-safe autoplay, edge A1). Disabled when audio is unavailable (canPlay
     false → WEB_AUDIO_UNSUPPORTED, edge A4). -->
<script lang="ts">
  import type { TransportState } from '../../engine/transport';
  import { PLAY_BUTTON_DIAMETER_PX } from '../lib/constants';

  interface Props {
    state: TransportState;
    canPlay: boolean;
    onprimary: () => void;
  }
  let { state, canPlay, onprimary }: Props = $props();

  // §5 table: playing → Pause; everything else → Play/Resume.
  const label = $derived(
    state === 'playing' ? 'Pause' : state === 'paused' || state === 'interrupted' ? 'Resume' : 'Play',
  );
  const isPause = $derived(state === 'playing');
</script>

<button
  type="button"
  class="play"
  class:is-pause={isPause}
  style="--d: {PLAY_BUTTON_DIAMETER_PX}px"
  disabled={!canPlay}
  aria-label={label}
  onclick={onprimary}
>
  <span class="glyph" aria-hidden="true">{isPause ? '⏸' : '▶'}</span>
  <span class="text">{label}</span>
</button>

<style>
  .play {
    width: var(--d);
    height: var(--d);
    border-radius: 50%;
    border: none;
    background: var(--accent);
    color: var(--accent-contrast);
    display: inline-flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: var(--sp-1);
    box-shadow: 0 6px 24px rgba(74, 168, 255, 0.35);
    transition: transform 0.08s ease;
  }
  .play:active {
    transform: scale(0.96);
  }
  .play.is-pause {
    background: var(--surface-2);
    color: var(--text);
    box-shadow: 0 6px 24px rgba(0, 0, 0, 0.4);
  }
  .glyph {
    font-size: 2.4rem;
    line-height: 1;
  }
  .text {
    font-size: 0.95rem;
    font-weight: 600;
    letter-spacing: 0.02em;
  }
</style>
