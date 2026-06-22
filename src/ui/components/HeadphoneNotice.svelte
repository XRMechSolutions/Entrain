<script lang="ts">
  // Presentational component — displays binaural voice disclaimer
</script>

<!-- HeadphoneNotice — permanent binaural-voice disclaimer (perf-safety §4).
     Shown in place of the generic caption whenever the preset has a binaural voice
     (any node in preset.nodes or voices[k].nodes with beat.value > 0). Non-dismissible.
     No medical or therapeutic claims — honesty stance (D-009 / safety.md). -->
<p class="notice" data-testid="binaural-notice">
  🎧 Headphones required for binaural voices · experimental, no medical/therapeutic claims
</p>

<style>
  .notice {
    margin: 0;
    color: var(--text-dim);
    font-size: 0.85rem;
  }
</style>
