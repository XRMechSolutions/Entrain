<!-- SignalGauges — the live current-value readouts for the Player "now playing" page. For each
     signal it shows the instantaneous value the preset drives at the playhead
     (automation.valueAt — base curve + modulator), following the rAF-driven tick (~60 Hz while
     playing). Read-only: it derives from session.preset through session.revision + the playback
     position mirror and never writes. Carrier/Beat are numbers; Volume is a level meter; Spatial
     is an L↔R position dot, so "where the pan is" reads at a glance. -->
<script lang="ts">
  import { getAppContext } from '../context';
  import { valueAt } from '../../engine/automation';
  import { formatHz, formatPan, formatPercent } from '../lib/format';
  import type { AutomatableParam } from '../../engine/session-model';

  interface Props { voiceId?: string | undefined }
  const { voiceId = undefined }: Props = $props();

  const { session, playback } = getAppContext();

  function rev<T>(read: () => T): T {
    void session.revision;
    return read();
  }
  const durationSec = $derived(rev(() => session.preset.durationSec));
  // Clamp the playhead into the session so a value is always defined (valueAt holds the first/
  // last keyframe outside the span anyway, but this keeps the dots on-axis).
  const tNow = $derived(Math.max(0, Math.min(durationSec, playback.positionSec)));

  function live(param: AutomatableParam): number {
    void session.revision; // recompute if the preset changes (load); tNow covers the playhead
    return valueAt(session.voiceView(voiceId), param, tNow);
  }
  const carrier = $derived(live('carrier'));
  const beat = $derived(live('beat'));
  const volume = $derived(live('volume'));
  const spatial = $derived(live('spatial'));

  // Pan dot position: −1 → 0% (full left), +1 → 100% (full right), 0 → 50% (center).
  const panPct = $derived(((Math.max(-1, Math.min(1, spatial)) + 1) / 2) * 100);
  const volPct = $derived(Math.round(Math.max(0, Math.min(1, volume)) * 100));
</script>

<div class="gauges">
  <div class="gauge" data-testid="gauge-carrier">
    <span class="lbl">Carrier</span>
    <span class="val">{formatHz(carrier, 0)}</span>
  </div>
  <div class="gauge" data-testid="gauge-beat">
    <span class="lbl">Beat</span>
    <span class="val">{formatHz(beat, 1)}</span>
  </div>

  <div class="gauge wide" data-testid="gauge-volume">
    <div class="row">
      <span class="lbl">Volume</span>
      <span class="val">{formatPercent(volume)}</span>
    </div>
    <div class="meter" role="meter" aria-valuemin="0" aria-valuemax="100" aria-valuenow={volPct} aria-label="Volume level">
      <div class="meter-fill" style="width:{volPct}%"></div>
    </div>
  </div>

  <div class="gauge wide" data-testid="gauge-spatial">
    <div class="row">
      <span class="lbl">Spatial</span>
      <span class="val">{formatPan(spatial)}</span>
    </div>
    <div class="pan" aria-hidden="true">
      <span class="tick l">L</span>
      <span class="axis"></span>
      <span class="tick r">R</span>
      <span class="dot" style="left:{panPct}%"></span>
    </div>
  </div>
</div>

<style>
  .gauges {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: var(--sp-3);
  }
  .gauge {
    display: flex;
    flex-direction: column;
    gap: var(--sp-1);
    padding: var(--sp-3);
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
  }
  .gauge.wide {
    grid-column: 1 / -1;
  }
  .row {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
  }
  .lbl {
    font-size: 0.8rem;
    color: var(--text-dim);
  }
  .val {
    font-size: 1.25rem;
    font-weight: 600;
    font-variant-numeric: tabular-nums;
    color: var(--accent);
  }
  /* Volume level meter */
  .meter {
    height: 8px;
    border-radius: 999px;
    background: var(--surface-2);
    overflow: hidden;
  }
  .meter-fill {
    height: 100%;
    background: var(--accent);
    /* a short transition smooths the per-tick steps without lagging the signal */
    transition: width 0.08s linear;
  }
  /* Spatial L↔R position indicator */
  .pan {
    position: relative;
    height: 20px;
    display: flex;
    align-items: center;
  }
  .pan .axis {
    flex: 1;
    height: 2px;
    background: var(--surface-2);
    margin: 0 var(--sp-2);
  }
  .pan .tick {
    font-size: 0.7rem;
    color: var(--text-dim);
    width: 1ch;
    text-align: center;
  }
  .pan .dot {
    position: absolute;
    top: 50%;
    width: 12px;
    height: 12px;
    border-radius: 50%;
    background: var(--accent);
    transform: translate(-50%, -50%);
    transition: left 0.08s linear;
  }
</style>
