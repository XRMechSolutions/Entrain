<!-- PlayerScreen — the "now playing" MONITOR (design §6/§8/§13). It shows the current state of
     every signal and follows it as the preset drives it: live timeline plots (SignalMonitor)
     with a moving playhead + per-lane dots, and live value gauges (SignalGauges). It is
     READ-ONLY — all signal shaping (carrier/beat/volume/spatial/waveform/duration) lives in the
     Advanced editor, where opening a preset now lands you. Only the listening-session controls
     (master output, lift overlay, keep-screen-on) remain here, plus the headphone reminder. The
     transport (play/pause + scrubber) lives in the global TransportBar at the top of the shell. -->
<script lang="ts">
  import { getAppContext } from '../context';
  import SignalMonitor from '../components/SignalMonitor.svelte';
  import SignalGauges from '../components/SignalGauges.svelte';
  import MasterVolume from '../components/MasterVolume.svelte';
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
  const masterGain = $derived(rev(() => session.preset.masterGain));
  const name = $derived(rev(() => session.preset.name));
</script>

<section class="player" class:wide={ui.isWide}>
  <header class="topline">
    <h1 class="name">{name}</h1>
    {#if session.dirty}<span class="dirty" title="Unsaved changes" aria-label="Unsaved changes">●</span>{/if}
  </header>

  <!-- The transport (play/pause + scrubber) lives in the global TransportBar at the top of the
       shell; this page is a read-only monitor, so it keeps only the permanent headphone caption
       + the one-time reminder above the live readouts (§8). -->
  <p class="caption">🎧 Use headphones for the binaural effect</p>

  {#if !ui.headphoneReminderSeen}
    <HeadphoneReminder ondismiss={() => ui.dismissHeadphoneReminder()} />
  {/if}

  <!-- Live signal plots + current-value gauges (read-only; they follow the playhead). -->
  <SignalMonitor />
  <SignalGauges />

  <!-- Listening-session controls (NOT signal shaping): output level, lift overlay, screen
       wake. Shaping moved to the Advanced editor. -->
  <div class="playback">
    <h2 class="section-title">Playback</h2>
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
       monitor never stretches full-bleed (design §13). */
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
  .caption {
    margin: 0;
    color: var(--text-dim);
    font-size: 0.85rem;
  }
  .playback {
    display: flex;
    flex-direction: column;
    gap: var(--sp-4);
    border-top: 1px solid var(--border);
    padding-top: var(--sp-4);
  }
  .section-title {
    margin: 0;
    font-size: 0.8rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--text-dim);
  }
</style>
