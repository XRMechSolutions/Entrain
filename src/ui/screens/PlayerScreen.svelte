<!-- PlayerScreen — the Phase-1 home (design §5/§6/§8/§13). Wires the AppContext stores to
     the player controls. THE ONE INVIOLABLE RULE is honoured here: every control is
     ONE-WAY. Display values are derived from session.preset through session.revision (the
     plain preset is never reactive); commits flow OUT through session.* / playback.*. The
     primary button calls play()/pause() synchronously (no await before play — edge A1). -->
<script lang="ts">
  import { getAppContext } from '../context';
  import { formatClock } from '../lib/format';
  import type { Waveform } from '../../engine/session-model';
  import TransportButton from '../components/TransportButton.svelte';
  import Scrubber from '../components/Scrubber.svelte';
  import ParamSection from '../components/ParamSection.svelte';
  import WaveformPicker from '../components/WaveformPicker.svelte';
  import MasterVolume from '../components/MasterVolume.svelte';
  import DurationControl from '../components/DurationControl.svelte';
  import LiftControl from '../components/LiftControl.svelte';
  import KeepScreenOnToggle from '../components/KeepScreenOnToggle.svelte';
  import HeadphoneReminder from '../components/HeadphoneReminder.svelte';

  const { session, playback, ui } = getAppContext();

  // Re-derive on every committed edit. Reading session.revision establishes the dependency;
  // the value itself comes from the plain preset.
  function rev<T>(read: () => T): T {
    void session.revision;
    return read();
  }
  const node0 = $derived(rev(() => session.preset.nodes[0]));
  const waveform = $derived<Waveform>(rev(() => node0.waveform ?? 'sine'));
  const masterGain = $derived(rev(() => session.preset.masterGain));
  const name = $derived(rev(() => session.preset.name));
  // Read the WORKING length straight from the preset (transport.duration() returns the same
  // value, but deriving from the preset makes a duration edit reflect at once — clock,
  // scrubber and field — without waiting for the next play, §D).
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

<section class="player" class:wide={ui.isWide}>
  <header class="topline">
    <h1 class="name">{name}</h1>
    {#if session.dirty}<span class="dirty" title="Unsaved changes" aria-label="Unsaved changes">●</span>{/if}
  </header>

  {#if !ui.headphoneReminderSeen}
    <HeadphoneReminder ondismiss={() => ui.dismissHeadphoneReminder()} />
  {/if}

  <div class="transport">
    <TransportButton state={playback.state} canPlay={playback.canPlay} onprimary={onPrimary} />
    <p class="caption">🎧 Use headphones for the binaural effect</p>

    <div class="row">
      {#if showStop}
        <button type="button" class="stop" onclick={() => playback.stop()}>Stop</button>
      {/if}
      <span class="clock" aria-live="off">{formatClock(playback.positionSec)} / {formatClock(durationSec)}</span>
    </div>

    <Scrubber
      positionSec={playback.positionSec}
      {durationSec}
      onseek={(t) => playback.seek(t)}
      onscrubstart={() => ui.setScrubbing(true)}
      onscrubend={() => ui.setScrubbing(false)}
    />
  </div>

  <div class="controls">
    <!-- Node-0 controls, unified with the Advanced editor (ParamSection). The console hides
         the interpolation selector (node-0 interpolation is a no-op — no previous node). -->
    <ParamSection index={0} param="carrier" showInterpolation={false} />
    <ParamSection index={0} param="beat" showInterpolation={false} />
    <ParamSection index={0} param="volume" showInterpolation={false} />
    <ParamSection index={0} param="spatial" showInterpolation={false} />
    <WaveformPicker value={waveform} onchange={(w) => session.setWaveform(w)} />
    <DurationControl value={durationSec} oncommit={(s) => session.setDuration(s)} />
    <MasterVolume value={masterGain} oninput={(v) => session.setMasterGain(v)} />
    <LiftControl oncommit={(lift) => playback.setLift(lift)} />
    <KeepScreenOnToggle on={playback.isKeepScreenOn()} onchange={(on) => playback.setKeepScreenOn(on)} />
  </div>
</section>

<style>
  .player {
    display: flex;
    flex-direction: column;
    gap: var(--sp-4);
    padding: var(--sp-4);
    /* Mobile-first single column; centered with a comfortable max-width on desktop so the
       console never stretches full-bleed (design §13). */
    width: 100%;
    max-width: 520px;
    margin-inline: auto;
  }
  .topline {
    display: flex;
    align-items: center;
    gap: var(--sp-2);
  }
  .name {
    font-size: 1.1rem;
    font-weight: 600;
    margin: 0;
  }
  .dirty {
    color: var(--warning);
    font-size: 0.7rem;
  }
  .transport {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: var(--sp-3);
  }
  .caption {
    margin: 0;
    color: var(--text-dim);
    font-size: 0.85rem;
  }
  .row {
    display: flex;
    align-items: center;
    gap: var(--sp-4);
  }
  .stop {
    min-height: var(--tap-min);
    padding: 0 var(--sp-4);
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    color: var(--text);
  }
  .clock {
    font-variant-numeric: tabular-nums;
    color: var(--text-dim);
  }
  .controls {
    display: flex;
    flex-direction: column;
    gap: var(--sp-4);
  }
</style>
