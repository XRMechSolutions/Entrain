<!-- TransportBar — the GLOBAL transport, pinned at the top of the app shell so play/pause +
     scrubbing are reachable from every screen (Player / Library / Advanced). It is the single
     home of the play gesture: the primary button calls play()/pause() SYNCHRONOUSLY (no await
     before play() — gesture-safe autoplay, edge A1), and the first play clears the headphone
     reminder (§8). Like the player console it is ONE-WAY: it reads the playback mirror + the
     working duration (via session.revision) for display only and commits out through
     playback.*. The Scrubber's built-in time readouts double as the clock, so the bar needs no
     separate clock. -->
<script lang="ts">
  import { getAppContext } from '../context';
  import TransportButton from './TransportButton.svelte';
  import Scrubber from './Scrubber.svelte';

  const { session, playback, ui } = getAppContext();

  // Re-derive on every committed edit (same pattern as the screens): reading session.revision
  // establishes the dependency; the value itself comes from the plain preset. Deriving the
  // working length here makes a duration edit reflect in the bar at once.
  function rev<T>(read: () => T): T {
    void session.revision;
    return read();
  }
  const durationSec = $derived(rev(() => session.preset.durationSec));

  const showStop = $derived(
    playback.state === 'playing' || playback.state === 'paused' || playback.state === 'interrupted',
  );

  function onPrimary(): void {
    // play() FIRST, no await before it (gesture-safe autoplay). Pause when playing.
    if (playback.state === 'playing') {
      playback.pause();
    } else {
      playback.play();
      ui.dismissHeadphoneReminder(); // first play also clears the reminder (§8)
    }
  }
</script>

<div class="transport-bar">
  <TransportButton state={playback.state} canPlay={playback.canPlay} onprimary={onPrimary} compact />
  {#if showStop}
    <button type="button" class="stop" onclick={() => playback.stop()}>Stop</button>
  {/if}
  <Scrubber
    positionSec={playback.positionSec}
    {durationSec}
    onseek={(t) => playback.seek(t)}
    onscrubstart={() => ui.setScrubbing(true)}
    onscrubend={() => ui.setScrubbing(false)}
  />
</div>

<style>
  .transport-bar {
    display: flex;
    align-items: center;
    gap: var(--sp-3);
    padding: var(--sp-2) var(--sp-3);
    background: var(--surface);
    border-bottom: 1px solid var(--border);
  }
  .stop {
    flex: none;
    min-height: var(--tap-min);
    padding: 0 var(--sp-3);
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    color: var(--text);
  }
  /* The Scrubber is the flexible middle: it carries the position slider + time readouts. */
  .transport-bar :global(.scrubber) {
    flex: 1;
    min-width: 0;
  }
</style>
