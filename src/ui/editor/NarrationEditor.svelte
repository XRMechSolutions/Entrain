<!-- NarrationEditor — full editing of the working preset's embedded narration script (D-043).
     Edit the spoken lines (text / start time / voice / rate), pauses, and their order; every
     change writes back via session.setVoiceScript, so the NEXT play re-synthesizes only the
     lines whose words/voice/rate actually changed (feature C) and streams them in. The script's
     blocks are flattened into one ordered line list here — block labels and repeat/loop are not
     represented (a script using them shows a notice and is edited as its flattened lines). -->
<script lang="ts">
  import { getAppContext } from '../context';

  const { session } = getAppContext();

  type SayEdit = { kind: 'say'; text: string; at: string; voice: string; rate: string; gapAfterSec?: number };
  type PauseEdit = { kind: 'pause'; pauseSec: string };
  type EditLine = SayEdit | PauseEdit;

  interface ScriptShape {
    purpose?: string;
    startAtSec?: number;
    rateScale?: number;
    voices?: unknown;
    duck?: unknown;
    loop?: unknown;
    blocks?: Array<{ pacing?: { gapSec?: number }; repeat?: unknown; lines?: Array<Record<string, unknown>> }>;
  }

  // Fields the flat editor doesn't surface but must preserve on save.
  let purpose = 'meditation';
  let voices: unknown;
  let duck: unknown;

  let startAtSec = $state('0');
  let rateScale = $state('1');
  let lines = $state<EditLine[]>([]);
  let hasAdvanced = $state(false); // repeat/loop present → flat editor can't fully represent it

  function load(): void {
    const s = (session.voiceScript ?? {}) as ScriptShape;
    purpose = s.purpose ?? 'meditation';
    voices = s.voices;
    duck = s.duck;
    startAtSec = String(s.startAtSec ?? 0);
    rateScale = String(s.rateScale ?? 1);
    hasAdvanced = s.loop != null;
    const out: EditLine[] = [];
    for (const block of s.blocks ?? []) {
      if (block && block.repeat != null) hasAdvanced = true;
      const pacing = block?.pacing?.gapSec;
      for (const ln of block?.lines ?? []) {
        if ('say' in ln) {
          out.push({
            kind: 'say',
            text: String(ln.say ?? ''),
            at: ln.at != null ? String(ln.at) : '',
            voice: ln.voice != null ? String(ln.voice) : '',
            rate: ln.rateScale != null ? String(ln.rateScale) : '',
            gapAfterSec: (ln.gapAfterSec as number | undefined) ?? pacing,
          });
        } else if ('pauseSec' in ln) {
          out.push({ kind: 'pause', pauseSec: String(ln.pauseSec ?? 0) });
        } else if ('repeat' in ln) {
          hasAdvanced = true; // inline repeat — dropped from the flat view
        }
      }
    }
    lines = out;
  }
  load();

  function numOrUndef(v: string): number | undefined {
    const n = Number(v);
    return v.trim() !== '' && Number.isFinite(n) ? n : undefined;
  }

  /** Rebuild the voiceScript from the flat model and push it to the session (re-arms the play
   *  guard → next play re-synthesizes the changed lines). */
  function apply(): void {
    const built: Record<string, unknown> = { version: 1, purpose };
    const sa = numOrUndef(startAtSec);
    if (sa !== undefined) built.startAtSec = sa;
    const rs = numOrUndef(rateScale);
    if (rs !== undefined) built.rateScale = rs;
    if (voices !== undefined) built.voices = voices;
    if (duck !== undefined) built.duck = duck;
    built.blocks = [
      {
        lines: lines.map((l) => {
          if (l.kind === 'pause') return { pauseSec: numOrUndef(l.pauseSec) ?? 1 };
          const say: Record<string, unknown> = { say: l.text };
          const at = numOrUndef(l.at);
          if (at !== undefined) say.at = at;
          if (l.voice.trim()) say.voice = l.voice.trim();
          const rate = numOrUndef(l.rate);
          if (rate !== undefined) say.rateScale = rate;
          if (l.gapAfterSec !== undefined) say.gapAfterSec = l.gapAfterSec;
          return say;
        }),
      },
    ];
    session.setVoiceScript(built);
  }

  function addSay(): void {
    lines = [...lines, { kind: 'say', text: 'New line.', at: '', voice: '', rate: '' }];
    apply();
  }
  function addPause(): void {
    lines = [...lines, { kind: 'pause', pauseSec: '5' }];
    apply();
  }
  function removeLine(i: number): void {
    lines = lines.filter((_, j) => j !== i);
    apply();
  }
  function move(i: number, d: -1 | 1): void {
    const j = i + d;
    if (j < 0 || j >= lines.length) return;
    const next = [...lines];
    [next[i], next[j]] = [next[j], next[i]];
    lines = next;
    apply();
  }
  function clearAll(): void {
    lines = [];
    voices = undefined;
    duck = undefined;
    session.setVoiceScript(undefined);
  }
</script>

<section class="narration" aria-label="Narration script editor">
  <header class="head">
    <h3 class="title">Narration</h3>
    <p class="hint">Edits apply on the next play — only changed lines are re-synthesized.</p>
  </header>

  {#if hasAdvanced}
    <p class="warn" role="note">
      This script uses repeat/loop features that this editor can't show. Editing here will flatten it
      to the lines below.
    </p>
  {/if}

  <div class="globals">
    <label>Start at (s)
      <input type="number" min="0" step="1" bind:value={startAtSec} onchange={apply} />
    </label>
    <label>Speed ×
      <input type="number" min="0.5" max="2" step="0.01" bind:value={rateScale} onchange={apply} />
    </label>
  </div>

  <ol class="lines">
    {#each lines as line, i (i)}
      <li class="line {line.kind}">
        <div class="ord">{i + 1}</div>
        {#if line.kind === 'say'}
          <div class="fields">
            <textarea
              class="say"
              rows="2"
              placeholder="What is spoken…"
              bind:value={line.text}
              onchange={apply}
            ></textarea>
            <div class="row">
              <label class="sm">at (s)
                <input type="number" min="0" step="1" placeholder="auto" bind:value={line.at} onchange={apply} />
              </label>
              <label class="sm">voice
                <input type="text" placeholder="default" bind:value={line.voice} onchange={apply} />
              </label>
              <label class="sm">speed ×
                <input type="number" min="0.5" max="2" step="0.01" placeholder="1" bind:value={line.rate} onchange={apply} />
              </label>
            </div>
          </div>
        {:else}
          <div class="fields">
            <label class="sm">pause (s)
              <input type="number" min="0.1" step="0.5" bind:value={line.pauseSec} onchange={apply} />
            </label>
          </div>
        {/if}
        <div class="ctrls">
          <button type="button" aria-label="Move up" disabled={i === 0} onclick={() => move(i, -1)}>↑</button>
          <button type="button" aria-label="Move down" disabled={i === lines.length - 1} onclick={() => move(i, 1)}>↓</button>
          <button type="button" class="del" aria-label="Remove line" onclick={() => removeLine(i)}>✕</button>
        </div>
      </li>
    {/each}
  </ol>

  <div class="actions">
    <button type="button" onclick={addSay}>+ Spoken line</button>
    <button type="button" onclick={addPause}>+ Pause</button>
    {#if lines.length > 0}
      <button type="button" class="clear" onclick={clearAll}>Remove narration</button>
    {/if}
  </div>
</section>

<style>
  .narration { display: flex; flex-direction: column; gap: 0.75rem; padding: 0.5rem 0; }
  .head { display: flex; align-items: baseline; gap: 0.75rem; flex-wrap: wrap; }
  .title { margin: 0; font-size: 1rem; }
  .hint { margin: 0; color: var(--text-dim, #9aa7b4); font-size: 0.8rem; }
  .warn { margin: 0; padding: 0.4rem 0.6rem; border-radius: 6px; background: #3a2a12; color: #ffce8a; font-size: 0.8rem; }
  .globals { display: flex; gap: 1rem; flex-wrap: wrap; }
  label { display: flex; flex-direction: column; gap: 0.2rem; font-size: 0.8rem; color: var(--text-dim, #9aa7b4); }
  label.sm { font-size: 0.72rem; }
  input, textarea { font: inherit; padding: 0.3rem 0.4rem; border-radius: 5px; border: 1px solid #2b3743; background: #0f151c; color: #e6edf3; }
  input[type='number'] { width: 5.5rem; }
  .lines { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 0.5rem; }
  .line { display: grid; grid-template-columns: 1.5rem 1fr auto; gap: 0.5rem; align-items: start; padding: 0.5rem; border: 1px solid #1d2630; border-radius: 8px; }
  .line.pause { background: #0d1218; }
  .ord { color: var(--text-dim, #9aa7b4); font-size: 0.8rem; padding-top: 0.3rem; }
  .fields { display: flex; flex-direction: column; gap: 0.4rem; min-width: 0; }
  .say { width: 100%; resize: vertical; }
  .row { display: flex; gap: 0.6rem; flex-wrap: wrap; }
  .ctrls { display: flex; flex-direction: column; gap: 0.25rem; }
  .ctrls button { width: 1.9rem; height: 1.6rem; border-radius: 5px; border: 1px solid #2b3743; background: #131a22; color: #e6edf3; cursor: pointer; }
  .ctrls button:disabled { opacity: 0.4; cursor: default; }
  .ctrls .del { color: #ff8a8a; }
  .actions { display: flex; gap: 0.6rem; flex-wrap: wrap; }
  .actions button { padding: 0.35rem 0.7rem; border-radius: 6px; border: 1px solid #2b3743; background: #131a22; color: #e6edf3; cursor: pointer; }
  .actions .clear { margin-left: auto; color: #ff8a8a; }
</style>
