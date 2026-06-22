// session.svelte.ts — the two stores that mediate between the UI and the engine's
// playback/timeline:
//
//   PlaybackStore — a reactive MIRROR of transport state + position plus the
//   gesture-safe control methods the buttons call (it never touches the audio path;
//   the numbers it exposes drive only the DOM).
//
//   SessionStore — the single source of truth: a PLAIN working Preset (stable identity
//   for transport, never a $state proxy) paired with a $state `revision` counter the
//   DOM derives from. Edits mutate the plain object in place, bump `revision`, set
//   `dirty`, then re-derive the audio via transport.reapply() (NOT seek) — design §3/§6.
//
// THE ONE INVIOLABLE RULE: controls are one-way. A committed edit re-derives audio via
// transport.reapply(); the framework never binds reactive state onto the signal graph.

import {
  baseValueAt,
} from '../../engine/automation';
import {
  createDefaultPreset,
  DEFAULTS,
  LIMITS,
  RANGES,
  sortNodes,
  voiceView as voiceViewModel,
  type AutomatableParam,
  type EmbeddedVoiceScript,
  type Layer,
  type LayerKind,
  type LayerSource,
  type LanePoint,
  type ModPoint,
  type ParamPoint,
  type ParamTransition,
  type Preset,
  type TimeNode,
  type ToneSpec,
  type Voice,
  type Waveform,
} from '../../engine/session-model';
import { DEFAULT_TONE_SPEC } from '../lib/constants';
import type { LiftOptions, Transport, TransportNotice, TransportState } from '../../engine/transport';
import type { NoticeStore } from './notices.svelte';

// ---------------------------------------------------------------------------
// Playback store
// ---------------------------------------------------------------------------

export interface PlaybackStore {
  readonly state: TransportState;
  readonly positionSec: number;
  readonly durationSec: number;
  readonly canPlay: boolean;

  play(): void;
  pause(): void;
  stop(): void;
  seek(t: number): void;
  setKeepScreenOn(on: boolean): void;
  isKeepScreenOn(): boolean;
  /** Enable/update (LiftOptions) or disable (null) the Shepard "lift" overlay. A live,
   *  non-persisted control: passes straight through to transport.setLift. */
  setLift(opts: LiftOptions | null): void;
}

export function createPlaybackStore(deps: { transport: Transport; notices: NoticeStore }): PlaybackStore {
  const { transport, notices } = deps;

  let state = $state<TransportState>(transport.state);
  let positionSec = $state(0);
  let durationSec = $state(transport.duration());
  let canPlay = $state(true);

  function reportError(e: unknown): void {
    const message = e instanceof Error ? e.message : String(e);
    notices.push({ severity: 'error', message: `Something went wrong: ${message}` });
  }

  /** Run a gesture-gated transport call without ever letting a sync throw or a rejected
   *  promise crash the store boundary (edge K1). The transport call is the FIRST thing
   *  invoked — no await precedes it — so the user-gesture activation is preserved. */
  function guard(call: () => Promise<void>): void {
    try {
      call().catch(reportError);
    } catch (e) {
      reportError(e);
    }
  }

  const store: PlaybackStore = {
    get state() {
      return state;
    },
    get positionSec() {
      return positionSec;
    },
    get durationSec() {
      return durationSec;
    },
    get canPlay() {
      return canPlay;
    },
    play() {
      guard(() => transport.play());
    },
    pause() {
      guard(() => transport.pause());
    },
    stop() {
      guard(() => transport.stop());
    },
    seek(t: number) {
      // Guard non-finite here so transport never throws INVALID_SEEK; call seek directly
      // (no await before it) to stay inside the scrubber-release gesture. The scrubbing
      // flag is cleared by the Scrubber component (this store has no ui dependency).
      if (!Number.isFinite(t)) return;
      guard(() => transport.seek(t));
    },
    setKeepScreenOn(on: boolean) {
      guard(() => transport.setKeepScreenOn(on));
    },
    isKeepScreenOn() {
      return transport.isKeepScreenOn();
    },
    setLift(opts: LiftOptions | null) {
      // Synchronous transport call (no gesture/await needed); never let it crash the store.
      try {
        transport.setLift(opts);
      } catch (e) {
        reportError(e);
      }
    },
  };

  transport.on('tick', (e) => {
    positionSec = e.positionSec;
    durationSec = e.durationSec;
  });
  transport.on('statechange', (e) => {
    state = e.state;
  });
  transport.on('ended', () => {
    notices.push({ severity: 'info', message: 'Session complete.' });
  });
  transport.on('error', (n: TransportNotice) => {
    if (n.code === 'WEB_AUDIO_UNSUPPORTED') canPlay = false;
    notices.fromTransport(n, 'error');
  });
  transport.on('warning', (n: TransportNotice) => {
    if (n.code === 'CONTEXT_INTERRUPTED') {
      // The interrupt banner is persistent and carries a Resume action that re-runs the
      // play gesture (a fresh gesture often unsticks iOS where auto-resume can't, F3).
      notices.push({
        severity: 'warning',
        dedupeKey: 'ctx',
        autoDismissMs: 0,
        message: 'Audio was interrupted. Tap Resume to continue.',
        action: { label: 'Resume', run: () => store.play() },
      });
      return;
    }
    notices.fromTransport(n, 'warning');
  });

  return store;
}

// ---------------------------------------------------------------------------
// Session store
// ---------------------------------------------------------------------------

/** Patch shape for a node's modulator (three-state: undefined=carry, null=clear,
 *  object=set). Mirrors session-model.ModPoint. */
export interface ModPatch {
  shape?: ModPoint['shape'];
  periodSec?: number;
  depth?: number;
  transition?: ModPoint['transition'];
  pulseWidth?: number;
  edgeMs?: number;
  steps?: number[];
}

export interface SessionStore {
  readonly preset: Preset;
  readonly revision: number;
  readonly dirty: boolean;
  readonly selectedId: string | null;
  /** The extra voices (voice 0 is the top-level `preset.nodes`, never in this array).
   *  Empty when the preset is single-voice (absent `voices`). */
  readonly voices: readonly Voice[];

  reset(next: Preset, selectedId?: string | null): void;

  // ----- Node mutators. Each takes a TRAILING optional `voiceId?`: `undefined` (and any
  //       unknown/stale id) ⇒ the primary voice 0 (`preset.nodes`); a known id ⇒ that voice's
  //       nodes. Routed through `targetNodes(voiceId)`, which never throws on a missing id. With
  //       no voiceId the behavior is byte-identical to single-voice authoring. -----
  setNodeParam(param: AutomatableParam, value: number, voiceId?: string): void;
  setWaveform(w: Waveform, voiceId?: string): void;
  setName(name: string): void;
  setMasterGain(v: number): void;
  /** Set the working preset's total duration (seconds), clamped to (0, LIMITS max].
   *  Marks dirty + bumps revision; it is NOT a live edit — the new length takes effect
   *  on the next play() (never a mid-session duration change). */
  setDuration(sec: number): void;

  addNode(t: number, param: AutomatableParam, voiceId?: string): string;
  moveNode(index: number, t: number, voiceId?: string): void;
  setNodeValue(index: number, param: AutomatableParam, value: number, voiceId?: string): void;
  setNodeTransition(index: number, param: AutomatableParam, tr: ParamTransition, voiceId?: string): void;
  setNodeMod(index: number, param: AutomatableParam, mod: Partial<ModPatch> | null | undefined, voiceId?: string): void;
  removeNode(index: number, voiceId?: string): void;

  // ----- Multi-voice authoring (v6, D-040/D-042; multi-voice-architecture §5). `voiceView`
  //       projects a single voice's nodes onto a Preset-shaped view (shared session-model helper
  //       §1.5) so render == playback == preview. `setVoiceGain` is BOTH an edit-time write and a
  //       live trim ramp (mirrors setMasterGain). `addVoice`/`removeVoice` are STRUCTURAL count
  //       changes: mutate + `transport.load` rebuild — NOT a live reapply, and NOT `reset()`. -----
  /** A Preset-shaped projection of one voice's nodes (shares the nodes BY REFERENCE).
   *  `undefined`/unknown id ⇒ the primary voice 0. Never throws on a missing id. */
  voiceView(voiceId?: string): Preset;
  /** Append a new default extra voice; returns its generated id, or `null` if at the cap
   *  (`1 + voices.length >= LIMITS.maxVoices`). Structural ⇒ `transport.load` rebuild. */
  addVoice(): string | null;
  /** Remove the extra voice with `voiceId` (no-op on an unknown id). Structural rebuild.
   *  Does NOT touch the caller's active-voice selection (that is the EditorScreen's job). */
  removeVoice(voiceId: string): void;
  setVoiceName(voiceId: string, name: string): void;
  /** Clamp to RANGES.voiceGain [0,1], write `preset.voices[k].gain` (edit-time, survives a
   *  save) AND ramp the live trim via transport.setVoiceTrim (D-042) — no reschedule. */
  setVoiceGain(voiceId: string, value: number): void;

  applyLiveEdit(): void;

  // ----- Phase-2 layer authoring (design §17; interfaces §14). Each clamps to v4 RANGES,
  //       bumps revision, sets dirty, and calls applyLiveEdit() — so a live layer edit
  //       reschedules at the unchanged position via transport.reapply(). They never author
  //       a preset that fails session-model.validate (kind/source pairings stay valid). -----
  /** Append a valid default Layer of `kind`; returns its generated unique id. tone →
   *  DEFAULT_TONE_SPEC; ambiance/voice → unbound clip source (silent until a clip is picked). */
  addLayer(kind: LayerKind): string;
  removeLayer(id: string): void;
  setLayerKind(id: string, kind: LayerKind): void;
  setLayerSource(id: string, source: LayerSource): void;
  setLayerToneSpec(id: string, patch: Partial<ToneSpec>): void;
  setLayerStart(id: string, t: number): void;
  setLayerLoop(id: string, loop: boolean): void;

  // per-layer gain / spatial (pan) lanes — LanePoint[] relative to the layer's start
  addLayerLanePoint(id: string, lane: 'gain' | 'spatial', t: number): number; // returns point index
  moveLayerLanePoint(id: string, lane: 'gain' | 'spatial', index: number, t: number): void;
  setLayerLaneValue(id: string, lane: 'gain' | 'spatial', index: number, value: number): void;
  setLayerLaneTransition(id: string, lane: 'gain' | 'spatial', index: number, tr: ParamTransition): void;
  removeLayerLanePoint(id: string, lane: 'gain' | 'spatial', index: number): void;

  /** Append compiled VoiceScript layers into preset.layers (their absolute t already
   *  computed by the compiler — design §20). Bumps revision, dirty, applyLiveEdit(). */
  injectLayers(layers: readonly Layer[]): void;

  /** Rebuild the running layer subsystem at the current position so freshly-synthesized clips
   *  "stream in" mid-playback (auto-synth-on-play, D-043) — passes straight through to
   *  transport.refreshLayers(). No-op unless playing. */
  refreshLayers(): Promise<void>;

  /** The working preset's embedded narration script (D-043), or undefined. Read by the
   *  narration editor; the play coordinator compiles it on play. */
  readonly voiceScript: EmbeddedVoiceScript | undefined;
  /** Replace the embedded narration script. Deep-cloned and given a NEW identity so the next
   *  play recompiles + re-synthesizes the changed lines (incremental). `undefined` removes it. */
  setVoiceScript(script: EmbeddedVoiceScript | undefined): void;
  /** Swap the script-generated voice cues (ids `vs_*`) for a freshly compiled set, leaving
   *  manually-added layers (`layer_*`) untouched — so an edited prompt REPLACES its cue rather
   *  than duplicating it. Used by the play coordinator after a recompile. */
  replaceNarrationLayers(layers: readonly Layer[]): void;

  // --- state transitions used by the library store's save/import flows (these change
  //     selectedId/dirty WITHOUT reloading transport, which reset() would do) ---
  /** Record a successful save: adopt the saved id, mark clean. */
  markSaved(id: string): void;
  /** Mark the working preset as having unsaved changes. */
  markUnsaved(): void;
  /** Detach from the loaded library record (e.g. after deleting it). */
  clearSelection(): void;
}

export function createSessionStore(deps: { transport: Transport; playback: PlaybackStore }): SessionStore {
  const { transport, playback } = deps;

  // PLAIN object — deliberately NOT $state, so identity is stable for transport and it
  // stays structuredClone/serialize-safe (design §3, edge-cases I1/I2).
  let preset: Preset = createDefaultPreset();
  let revision = $state(0);
  let dirty = $state(false);
  let selectedId = $state<string | null>(null);

  function bump(): void {
    revision++;
  }

  function clampParam(param: AutomatableParam, value: number): number | null {
    if (!Number.isFinite(value)) return null; // never write a non-finite into a ParamPoint (B3)
    const r = RANGES[param];
    return Math.min(r.max, Math.max(r.min, value));
  }

  function paramPoint(node: TimeNode, param: AutomatableParam): ParamPoint {
    let pp = node[param];
    if (!pp) {
      pp = { value: RANGES[param].min };
      node[param] = pp;
    }
    return pp;
  }

  function applyLiveEdit(): void {
    const s = playback.state;
    if (s === 'playing' || s === 'paused' || s === 'interrupted') {
      // reapply() retargets at the UNCHANGED position (preserves modulator phase). It is
      // NOT a seek. NO_PRESET cannot happen (reset() always loads); guard defensively so
      // an engine throw never crashes the edit (edge K1).
      try {
        transport.reapply();
      } catch {
        /* preset always loaded; nothing to surface from this store boundary */
      }
    }
    // idle / stopped: no-op — the next play() reads the mutated preset (B6).
  }

  function commit(): void {
    dirty = true;
    bump();
    applyLiveEdit();
  }

  // ----- Phase-2 layer helpers -----------------------------------------------------------

  /** The mutable layers array, lazily created (createDefaultPreset omits `layers`). */
  function layers(): Layer[] {
    if (!preset.layers) preset.layers = [];
    return preset.layers;
  }

  function findLayer(id: string): Layer | undefined {
    return preset.layers?.find((l) => l.id === id);
  }

  /** A collision-free unique layer id (never asks the user to type one — L1). */
  function freshLayerId(): string {
    const existing = new Set((preset.layers ?? []).map((l) => l.id));
    let n = existing.size + 1;
    let id = `layer_${n}`;
    while (existing.has(id)) id = `layer_${++n}`;
    return id;
  }

  function clampToneFreq(freqHz: number): number {
    const r = RANGES.toneFreq;
    return Math.min(r.max, Math.max(r.min, freqHz));
  }

  /** Clamp a lane point value to the lane's range (gain = volume {0,1}, spatial {−1,1}). */
  function clampLaneValue(lane: 'gain' | 'spatial', value: number): number | null {
    if (!Number.isFinite(value)) return null;
    const r = lane === 'gain' ? RANGES.volume : RANGES.spatial;
    return Math.min(r.max, Math.max(r.min, value));
  }

  /** Keep a lane sorted ascending by t and free of duplicate t (mirrors LANE_NOT_SORTED /
   *  LANE_DUPLICATE_T). A point landing on an existing t is nudged by MIN_NODE_DT analogue. */
  function normalizeLane(points: LanePoint[]): LanePoint[] {
    const sorted = [...points].sort((a, b) => a.t - b.t);
    const out: LanePoint[] = [];
    let lastT = -Infinity;
    for (const p of sorted) {
      let t = p.t;
      if (t <= lastT) t = lastT + 0.01; // dedup-t: never two points at the same relative t
      out.push({ ...p, t });
      lastT = t;
    }
    return out;
  }

  function getLane(layer: Layer, lane: 'gain' | 'spatial'): LanePoint[] {
    let arr = layer[lane];
    if (!arr) {
      arr = [];
      layer[lane] = arr;
    }
    return arr;
  }

  /** A layer's start clamp — [0, durationSec]. */
  function clampLayerStart(t: number): number {
    if (!Number.isFinite(t)) return 0;
    return Math.min(preset.durationSec, Math.max(0, t));
  }

  /** Default loop for a kind (ambiance must loop; tone/voice default off). */
  function defaultLoopFor(kind: LayerKind): boolean {
    return kind === 'ambiance';
  }

  /** A valid default source for a kind: tone ⇒ a synth ToneSpec; ambiance/voice ⇒ an
   *  unbound clip placeholder (empty clipId = the "Pick a clip" state, L7). */
  function defaultSourceFor(kind: LayerKind): LayerSource {
    return kind === 'tone' ? { synth: { ...DEFAULT_TONE_SPEC } } : { clipId: '' };
  }

  // ----- Multi-voice helpers (v6) --------------------------------------------------------

  /** Resolve the node-bearing container an edit targets. SENTINEL: `undefined` — and any
   *  unknown/stale id — falls back to the primary voice 0 (the Preset itself, whose `.nodes`
   *  is voice 0). NEVER throws on a missing id (D-040). Returns the container (not the array)
   *  so reassigning callers (addNode/moveNode/sortNodes) can write `.nodes` back uniformly —
   *  both `Preset` and `Voice` expose `nodes: TimeNode[]`. */
  function targetNodes(voiceId?: string): { nodes: TimeNode[] } {
    if (voiceId === undefined) return preset;
    return preset.voices?.find((v) => v.id === voiceId) ?? preset;
  }

  /** A collision-free unique voice id (the primary voice has none; these are extra voices). */
  function freshVoiceId(): string {
    const existing = new Set((preset.voices ?? []).map((v) => v.id));
    let n = existing.size + 1;
    let id = `voice_${n}`;
    while (existing.has(id)) id = `voice_${++n}`;
    return id;
  }

  /** A valid default extra voice: a single binaural carrier at t=0, separated ~ratio 1.25
   *  from the primary's 200 Hz default so the two voices don't mask/cross-beat (§6). */
  function defaultVoiceNodes(): TimeNode[] {
    return [{ t: 0, carrier: { value: 250 }, beat: { value: 8 }, volume: { value: 1 } }];
  }

  const store: SessionStore = {
    get preset() {
      return preset;
    },
    get revision() {
      return revision;
    },
    get dirty() {
      return dirty;
    },
    get selectedId() {
      return selectedId;
    },
    get voices() {
      return preset.voices ?? [];
    },

    reset(next: Preset, id: string | null = null) {
      preset = next; // adopt BY REFERENCE as the new source of truth
      selectedId = id;
      dirty = false;
      transport.load(preset);
      bump();
    },

    setNodeParam(param: AutomatableParam, value: number, voiceId?: string) {
      const clamped = clampParam(param, value);
      if (clamped === null) return;
      paramPoint(targetNodes(voiceId).nodes[0], param).value = clamped;
      commit();
    },

    setWaveform(w: Waveform, voiceId?: string) {
      targetNodes(voiceId).nodes[0].waveform = w;
      commit();
    },

    setName(name: string) {
      // Name is not audible — dirty + revision only, no reschedule.
      preset.name = name;
      dirty = true;
      bump();
    },

    setMasterGain(v: number) {
      if (!Number.isFinite(v)) return;
      const clamped = Math.min(1, Math.max(0, v));
      preset.masterGain = clamped;
      transport.setMasterTrim(clamped); // the cheap live path — NO reschedule (§6.1)
      dirty = true;
      bump();
    },

    setDuration(sec: number) {
      if (!Number.isFinite(sec)) return; // never author a non-finite durationSec
      // Clamp to (0, LIMITS max]: a session must be at least 1s and at most 24h.
      const clamped = Math.min(LIMITS.durationMaxSec, Math.max(1, Math.round(sec)));
      preset.durationSec = clamped;
      // Re-clamp nodes and layers whose t now exceeds the new duration (J5, L4).
      for (let i = 1; i < preset.nodes.length; i++) {
        if (preset.nodes[i].t > clamped) preset.nodes[i].t = clamped;
      }
      if (preset.nodes.length > 1) preset.nodes = sortNodes(preset.nodes);
      if (preset.layers) {
        for (const layer of preset.layers) {
          if (layer.t > clamped) layer.t = clamped;
        }
      }
      // NOT a live edit — no reapply(); the new length is read by the next play() (B6).
      dirty = true;
      bump();
    },

    addNode(t: number, param: AutomatableParam, voiceId?: string): string {
      const target = targetNodes(voiceId);
      const clampedT = Math.min(preset.durationSec, Math.max(0, t));
      // Carry-forward value so adding a node does not change the sound until it is moved (J4).
      // baseValueAt reads the TARGET voice's nodes via its voiceView (not always voice 0).
      const carry =
        clampParam(param, baseValueAt(voiceViewModel(preset, target.nodes), param, clampedT)) ??
        RANGES[param].min;
      const node: TimeNode = { t: clampedT, [param]: { value: carry } };
      target.nodes = sortNodes([...target.nodes, node]);
      commit();
      return String(target.nodes.indexOf(node));
    },

    moveNode(index: number, t: number, voiceId?: string) {
      if (index === 0) return; // nodes[0] is pinned at t=0 (J2)
      const target = targetNodes(voiceId);
      const node = target.nodes[index];
      if (!node) return;
      node.t = Math.min(preset.durationSec, Math.max(0, t));
      target.nodes = sortNodes(target.nodes);
      commit();
    },

    setNodeValue(index: number, param: AutomatableParam, value: number, voiceId?: string) {
      const node = targetNodes(voiceId).nodes[index];
      if (!node) return;
      const clamped = clampParam(param, value);
      if (clamped === null) return;
      paramPoint(node, param).value = clamped;
      commit();
    },

    setNodeTransition(index: number, param: AutomatableParam, tr: ParamTransition, voiceId?: string) {
      const node = targetNodes(voiceId).nodes[index];
      if (!node) return;
      paramPoint(node, param).transition = tr;
      commit();
    },

    setNodeMod(index: number, param: AutomatableParam, mod: Partial<ModPatch> | null | undefined, voiceId?: string) {
      const node = targetNodes(voiceId).nodes[index];
      if (!node) return;
      const pp = paramPoint(node, param);
      if (mod === undefined) delete pp.mod; // carry
      else if (mod === null) pp.mod = null; // clear
      else pp.mod = { ...mod } as ModPoint; // set
      commit();
    },

    removeNode(index: number, voiceId?: string) {
      if (index === 0) return; // refuse to remove the start node (carrier required, J2)
      const target = targetNodes(voiceId);
      if (index < 0 || index >= target.nodes.length) return;
      target.nodes.splice(index, 1);
      commit();
    },

    applyLiveEdit,

    // ----- Multi-voice authoring (v6) -----

    voiceView(voiceId?: string): Preset {
      // DELEGATE to the shared session-model helper, sharing the voice's nodes BY REFERENCE
      // (never a hand-rolled literal) so render == playback == preview stay byte-identical (§1.5).
      return voiceViewModel(preset, targetNodes(voiceId).nodes);
    },

    addVoice(): string | null {
      // Cap is the `1 + voices.length` formula (counts the primary) — mirrors LIMITS.maxVoices.
      const total = 1 + (preset.voices?.length ?? 0);
      if (total >= LIMITS.maxVoices) return null;
      if (!preset.voices) preset.voices = [];
      const id = freshVoiceId();
      preset.voices.push({ id, gain: DEFAULTS.voiceGain, nodes: defaultVoiceNodes() });
      // STRUCTURAL count change: mutate + rebuild via transport.load (like a duration change),
      // NOT a live reapply. Deliberately NOT session.reset() — that would clear dirty +
      // selectedId, losing the unsaved-changes guard and detaching the loaded library record.
      dirty = true;
      bump();
      transport.load(preset);
      return id;
    },

    removeVoice(voiceId: string) {
      const arr = preset.voices;
      if (!arr) return;
      const idx = arr.findIndex((v) => v.id === voiceId);
      if (idx === -1) return; // unknown id: no-op
      arr.splice(idx, 1);
      if (arr.length === 0) delete preset.voices; // sparseness: absent voices = single-voice
      // STRUCTURAL rebuild (see addVoice). Active-voice reselection to Primary is the caller's
      // (EditorScreen's) concern — this store holds no activeVoiceId.
      dirty = true;
      bump();
      transport.load(preset);
    },

    setVoiceName(voiceId: string, name: string) {
      const voice = preset.voices?.find((v) => v.id === voiceId);
      if (!voice) return;
      // Name is not audible — dirty + revision only, no reschedule (mirrors setName).
      voice.name = name;
      dirty = true;
      bump();
    },

    setVoiceGain(voiceId: string, value: number) {
      if (!Number.isFinite(value)) return;
      const voice = preset.voices?.find((v) => v.id === voiceId);
      if (!voice) return;
      const r = RANGES.voiceGain;
      const clamped = Math.min(r.max, Math.max(r.min, value));
      voice.gain = clamped; // edit-time channel: written into the preset, survives a save
      transport.setVoiceTrim(voiceId, clamped); // live channel (D-042): cheap ramp, NO reschedule
      dirty = true;
      bump();
    },

    // ----- Phase-2 layer authoring -----

    addLayer(kind: LayerKind): string {
      const id = freshLayerId();
      const layer: Layer = {
        id,
        kind,
        source: defaultSourceFor(kind),
        t: 0,
        loop: defaultLoopFor(kind),
      };
      layers().push(layer);
      commit();
      return id;
    },

    removeLayer(id: string) {
      const arr = preset.layers;
      if (!arr) return;
      const idx = arr.findIndex((l) => l.id === id);
      if (idx === -1) return;
      arr.splice(idx, 1); // the referenced clip stays in the library (shared, L10)
      commit();
    },

    setLayerKind(id: string, kind: LayerKind) {
      const layer = findLayer(id);
      if (!layer) return;
      if (layer.kind === kind) return;
      layer.kind = kind;
      // Re-validate the source against the new kind constraint (L3): a tone needs a synth
      // source; ambiance/voice need a clip source. Swap to a valid default when the current
      // source no longer fits, so the inspector can never produce a LAYER_SOURCE_INVALID.
      const hasSynth = 'synth' in layer.source;
      const needsSynth = kind === 'tone';
      if (needsSynth !== hasSynth) layer.source = defaultSourceFor(kind);
      layer.loop = defaultLoopFor(kind); // ambiance must loop; tone/voice default off
      commit();
    },

    setLayerSource(id: string, source: LayerSource) {
      const layer = findLayer(id);
      if (!layer) return;
      layer.source = source;
      commit();
    },

    setLayerToneSpec(id: string, patch: Partial<ToneSpec>) {
      const layer = findLayer(id);
      if (!layer || !('synth' in layer.source)) return; // only a synth source has a ToneSpec
      const spec = layer.source.synth;
      if (patch.shape !== undefined) spec.shape = patch.shape;
      if (patch.freqHz !== undefined && Number.isFinite(patch.freqHz)) spec.freqHz = clampToneFreq(patch.freqHz);
      if (patch.attackSec !== undefined && Number.isFinite(patch.attackSec)) spec.attackSec = Math.max(0, patch.attackSec);
      if (patch.releaseSec !== undefined && Number.isFinite(patch.releaseSec)) spec.releaseSec = Math.max(0, patch.releaseSec);
      commit();
    },

    setLayerStart(id: string, t: number) {
      const layer = findLayer(id);
      if (!layer) return;
      layer.t = clampLayerStart(t);
      commit();
    },

    setLayerLoop(id: string, loop: boolean) {
      const layer = findLayer(id);
      if (!layer) return;
      // ambiance must loop (the clip is a bed); ignore an attempt to turn it off (L3).
      layer.loop = layer.kind === 'ambiance' ? true : loop;
      commit();
    },

    addLayerLanePoint(id: string, lane: 'gain' | 'spatial', t: number): number {
      const layer = findLayer(id);
      if (!layer) return -1;
      const arr = getLane(layer, lane);
      const relT = Number.isFinite(t) ? Math.max(0, t) : 0;
      // Carry-forward value so adding a point does not change the sound until it is moved:
      // an absent gain lane = unity (1), an absent spatial lane = center (0).
      const carry = lane === 'gain' ? RANGES.volume.max : 0;
      const point: LanePoint = { t: relT, value: carry };
      const normalized = normalizeLane([...arr, point]);
      layer[lane] = normalized;
      commit();
      return normalized.findIndex((p) => p === point || (p.t === point.t && p.value === point.value));
    },

    moveLayerLanePoint(id: string, lane: 'gain' | 'spatial', index: number, t: number) {
      const layer = findLayer(id);
      if (!layer) return;
      const arr = layer[lane];
      if (!arr || index < 0 || index >= arr.length) return;
      arr[index] = { ...arr[index], t: Number.isFinite(t) ? Math.max(0, t) : arr[index].t };
      layer[lane] = normalizeLane(arr);
      commit();
    },

    setLayerLaneValue(id: string, lane: 'gain' | 'spatial', index: number, value: number) {
      const layer = findLayer(id);
      if (!layer) return;
      const arr = layer[lane];
      if (!arr || index < 0 || index >= arr.length) return;
      const clamped = clampLaneValue(lane, value);
      if (clamped === null) return; // never author a non-finite lane value
      arr[index] = { ...arr[index], value: clamped };
      commit();
    },

    setLayerLaneTransition(id: string, lane: 'gain' | 'spatial', index: number, tr: ParamTransition) {
      const layer = findLayer(id);
      if (!layer) return;
      const arr = layer[lane];
      if (!arr || index < 0 || index >= arr.length) return;
      arr[index] = { ...arr[index], transition: tr };
      commit();
    },

    removeLayerLanePoint(id: string, lane: 'gain' | 'spatial', index: number) {
      const layer = findLayer(id);
      if (!layer) return;
      const arr = layer[lane];
      if (!arr || index < 0 || index >= arr.length) return;
      arr.splice(index, 1);
      if (arr.length === 0) delete layer[lane]; // empty lane = the implicit default
      commit();
    },

    injectLayers(incoming: readonly Layer[]) {
      // Append the compiled layers — their absolute t is already computed by the compiler;
      // the UI does NOT re-time them (O6). Push by reference (they are plain Layer data).
      const arr = layers();
      for (const l of incoming) arr.push(l);
      commit();
    },

    refreshLayers() {
      // Authoritative rebuild of the layer subsystem at the live position (D-043). injectLayers'
      // reapply() only retargets existing lanes; newly-injected cues need their nodes BUILT (and
      // their now-present clip buffers decoded), which only this does.
      return transport.refreshLayers();
    },

    get voiceScript() {
      return preset.voiceScript;
    },

    setVoiceScript(script: EmbeddedVoiceScript | undefined) {
      // Assign a fresh deep clone (new object identity) so the play-coordinator's reference guard
      // re-arms and the next play recompiles — feature C then re-synthesizes only the lines whose
      // words/voice/rate actually changed. undefined removes the embedded narration entirely.
      if (script === undefined) delete preset.voiceScript;
      else preset.voiceScript = structuredClone(script);
      commit();
    },

    replaceNarrationLayers(newLayers: readonly Layer[]) {
      // Drop the previous script-generated cues (ids `vs_*`) and append the freshly compiled set;
      // manual layers (`layer_*`) are preserved. So a reworded prompt replaces its cue (its
      // positional id is stable but its clipId changed) instead of stacking a duplicate.
      const arr = layers();
      const kept = arr.filter((l) => !l.id.startsWith('vs_'));
      arr.length = 0;
      for (const l of kept) arr.push(l);
      for (const l of newLayers) arr.push(l);
      commit();
    },

    markSaved(id: string) {
      selectedId = id;
      dirty = false;
      bump();
    },
    markUnsaved() {
      dirty = true;
      bump();
    },
    clearSelection() {
      selectedId = null;
      bump();
    },
  };

  return store;
}
