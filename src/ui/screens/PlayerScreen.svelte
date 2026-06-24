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
  import DriftButton from '../components/DriftButton.svelte';
  import LiftControl from '../components/LiftControl.svelte';
  import KeepScreenOnToggle from '../components/KeepScreenOnToggle.svelte';
  import HeadphoneReminder from '../components/HeadphoneReminder.svelte';
  import HeadphoneNotice from '../components/HeadphoneNotice.svelte';
  import type { TimeNode } from '../../engine/session-model';

  const { session, playback, ui } = getAppContext();

  // Re-derive on every committed edit. Reading session.revision establishes the dependency;
  // the value itself comes from the plain preset.
  function rev<T>(read: () => T): T {
    void session.revision;
    return read();
  }
  const masterGain = $derived(rev(() => session.preset.masterGain));
  const name = $derived(rev(() => session.preset.name));

  function nodesBinaural(nodes: TimeNode[]): boolean {
    return nodes.some((n) => (n.beat?.value ?? 0) > 0);
  }

  // True when any node in the primary voice OR any extra voice has beat.value > 0,
  // including a keyframed beat that starts at 0 but rises later (perf-safety §4).
  const hasBinauralVoice = $derived(
    rev(() => {
      const p = session.preset;
      return nodesBinaural(p.nodes) || (p.voices ?? []).some((v) => nodesBinaural(v.nodes));
    }),
  );

  // Voice selector — undefined = Primary (preset.nodes); a string id = an extra voice.
  let activeVoiceId = $state<string | undefined>(undefined);
  const voices = $derived(rev(() => session.voices));
</script>

<section class="player" class:wide={ui.isWide}>
  <header class="topline">
    <h1 class="name">{name}</h1>
    {#if session.dirty}<span class="dirty" title="Unsaved changes" aria-label="Unsaved changes">●</span>{/if}
  </header>

  <!-- The transport (play/pause + scrubber) lives in the global TransportBar at the top of the
       shell; this page is a read-only monitor, so it keeps only the permanent headphone caption
       + the one-time reminder above the live readouts (§8). When the preset is binaural
       (beat > 0 anywhere), HeadphoneNotice replaces the generic caption with the full
       disclaimer; for isochronic-only presets the generic caption is shown instead. -->
  {#if hasBinauralVoice}
    <HeadphoneNotice />
  {:else}
    <p class="caption">🎧 Use headphones for the binaural effect</p>
  {/if}

  {#if !ui.headphoneReminderSeen}
    <HeadphoneReminder ondismiss={() => ui.dismissHeadphoneReminder()} />
  {/if}

  <!-- Voice selector strip (one voice monitored at a time); hidden when single-voice. -->
  {#if voices.length > 0}
    <div class="voice-strip" role="tablist" aria-label="Monitor voice">
      <button
        type="button"
        role="tab"
        class="voice-tab"
        class:active={activeVoiceId === undefined}
        aria-selected={activeVoiceId === undefined}
        data-testid="monitor-voice-primary"
        onclick={() => (activeVoiceId = undefined)}
      >
        Primary
      </button>
      {#each voices as voice (voice.id)}
        <button
          type="button"
          role="tab"
          class="voice-tab"
          class:active={activeVoiceId === voice.id}
          aria-selected={activeVoiceId === voice.id}
          data-testid={`monitor-voice-${voice.id}`}
          onclick={() => (activeVoiceId = voice.id)}
        >
          {voice.name || voice.id}
        </button>
      {/each}
    </div>
  {/if}

  <!-- Live signal plots + current-value gauges (read-only; they follow the playhead). -->
  <SignalMonitor voiceId={activeVoiceId} />
  <SignalGauges voiceId={activeVoiceId} />

  <!-- Listening-session controls (NOT signal shaping): output level, lift overlay, screen
       wake. Shaping moved to the Advanced editor. -->
  <div class="playback">
    <h2 class="section-title">Playback</h2>
    <DriftButton
      active={session.driftActive}
      disabled={playback.state !== 'playing'}
      onpress={() => session.toggleDrift()}
    />
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
  .voice-strip {
    display: flex;
    gap: var(--sp-2);
    overflow-x: auto;
    -webkit-overflow-scrolling: touch;
    scrollbar-width: none;
  }
  .voice-strip::-webkit-scrollbar {
    display: none;
  }
  .voice-tab {
    flex-shrink: 0;
    padding: var(--sp-1) var(--sp-3);
    border-radius: var(--radius);
    border: 1px solid var(--border);
    background: transparent;
    color: var(--text-dim);
    font-size: 0.85rem;
    cursor: pointer;
  }
  .voice-tab.active {
    background: var(--accent);
    border-color: var(--accent);
    color: var(--on-accent, #fff);
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
