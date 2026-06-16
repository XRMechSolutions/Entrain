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
  LIMITS,
  RANGES,
  sortNodes,
  type AutomatableParam,
  type ModPoint,
  type ParamPoint,
  type ParamTransition,
  type Preset,
  type TimeNode,
  type Waveform,
} from '../../engine/session-model';
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

  reset(next: Preset, selectedId?: string | null): void;

  setNodeParam(param: AutomatableParam, value: number): void;
  setWaveform(w: Waveform): void;
  setName(name: string): void;
  setMasterGain(v: number): void;
  /** Set the working preset's total duration (seconds), clamped to (0, LIMITS max].
   *  Marks dirty + bumps revision; it is NOT a live edit — the new length takes effect
   *  on the next play() (never a mid-session duration change). */
  setDuration(sec: number): void;

  addNode(t: number, param: AutomatableParam): string;
  moveNode(index: number, t: number): void;
  setNodeValue(index: number, param: AutomatableParam, value: number): void;
  setNodeTransition(index: number, param: AutomatableParam, tr: ParamTransition): void;
  setNodeMod(index: number, param: AutomatableParam, mod: Partial<ModPatch> | null | undefined): void;
  removeNode(index: number): void;

  applyLiveEdit(): void;

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

    reset(next: Preset, id: string | null = null) {
      preset = next; // adopt BY REFERENCE as the new source of truth
      selectedId = id;
      dirty = false;
      transport.load(preset);
      bump();
    },

    setNodeParam(param: AutomatableParam, value: number) {
      const clamped = clampParam(param, value);
      if (clamped === null) return;
      paramPoint(preset.nodes[0], param).value = clamped;
      commit();
    },

    setWaveform(w: Waveform) {
      preset.nodes[0].waveform = w;
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
      // NOT a live edit — no reapply(); the new length is read by the next play() (B6).
      dirty = true;
      bump();
    },

    addNode(t: number, param: AutomatableParam): string {
      const clampedT = Math.min(preset.durationSec, Math.max(0, t));
      // Carry-forward value so adding a node does not change the sound until it is moved (J4).
      const carry = clampParam(param, baseValueAt(preset, param, clampedT)) ?? RANGES[param].min;
      const node: TimeNode = { t: clampedT, [param]: { value: carry } };
      preset.nodes = sortNodes([...preset.nodes, node]);
      commit();
      return String(preset.nodes.indexOf(node));
    },

    moveNode(index: number, t: number) {
      if (index === 0) return; // nodes[0] is pinned at t=0 (J2)
      const node = preset.nodes[index];
      if (!node) return;
      node.t = Math.min(preset.durationSec, Math.max(0, t));
      preset.nodes = sortNodes(preset.nodes);
      commit();
    },

    setNodeValue(index: number, param: AutomatableParam, value: number) {
      const node = preset.nodes[index];
      if (!node) return;
      const clamped = clampParam(param, value);
      if (clamped === null) return;
      paramPoint(node, param).value = clamped;
      commit();
    },

    setNodeTransition(index: number, param: AutomatableParam, tr: ParamTransition) {
      const node = preset.nodes[index];
      if (!node) return;
      paramPoint(node, param).transition = tr;
      commit();
    },

    setNodeMod(index: number, param: AutomatableParam, mod: Partial<ModPatch> | null | undefined) {
      const node = preset.nodes[index];
      if (!node) return;
      const pp = paramPoint(node, param);
      if (mod === undefined) delete pp.mod; // carry
      else if (mod === null) pp.mod = null; // clear
      else pp.mod = { ...mod } as ModPoint; // set
      commit();
    },

    removeNode(index: number) {
      if (index === 0) return; // refuse to remove the start node (carrier required, J2)
      if (index < 0 || index >= preset.nodes.length) return;
      preset.nodes.splice(index, 1);
      commit();
    },

    applyLiveEdit,

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
