<!-- VoiceScriptImport — the "Import VoiceScript…" action (design §20, interfaces §15/§16).
     A file pick (accept=.json) → parse → VoiceScriptStore.importAndCompile → inject the
     compiled voice layers. The store is atomic (nothing injected unless compile fully
     succeeds, O1) and surfaces the compiler's diagnostics as notices. Capability-gated
     (disabled with a notice when tts-local is absent, O3) — gated on capability, not width.
     The file read runs inside the change-handler gesture; parse failures surface a notice. -->
<script lang="ts">
  import { getAppContext } from '../context';

  const { voiceScript, notices } = getAppContext();

  let fileInput = $state<HTMLInputElement | null>(null);

  const busy = $derived(voiceScript.phase === 'compiling');

  async function onPick(e: Event): Promise<void> {
    const input = e.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    input.value = ''; // allow re-picking the same file
    if (!file) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(await file.text());
    } catch {
      notices.push({ severity: 'error', message: "That file isn't valid JSON." });
      return;
    }
    voiceScript.importAndCompile(parsed);
  }
</script>

<section class="vs-import" aria-label="Import VoiceScript">
  <h3 class="title">Import VoiceScript…</h3>

  {#if !voiceScript.canCompile}
    <p class="gate" data-testid="voicescript-gate">Voice narration needs the desktop studio.</p>
  {/if}

  <button
    type="button"
    class="pick"
    disabled={!voiceScript.canCompile || busy}
    onclick={() => fileInput?.click()}
  >
    {busy ? 'Compiling…' : 'Pick a VoiceScript (.json)'}
  </button>
  <input
    bind:this={fileInput}
    class="visually-hidden"
    type="file"
    accept=".json,application/json"
    aria-label="VoiceScript JSON file"
    onchange={onPick}
  />

  {#if busy}
    <progress value={voiceScript.progress} max="1" aria-label="Compile progress"></progress>
  {/if}
</section>

<style>
  .vs-import {
    display: flex;
    flex-direction: column;
    gap: var(--sp-3);
    padding: var(--sp-3);
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
  }
  .title {
    margin: 0;
    font-size: 1rem;
  }
  .gate {
    margin: 0;
    font-size: 0.85rem;
    color: var(--warning);
  }
  .pick {
    min-height: var(--tap-min);
    padding: 0 var(--sp-4);
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    color: var(--accent);
    font-weight: 600;
  }
</style>
