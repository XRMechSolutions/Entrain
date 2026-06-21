// Behavioral constants shared by the UI shell and the Phase-2 editor — the single
// source of truth for the non-CSS numbers in design.md §14. (Breakpoint/spacing
// values that the stylesheet also needs live as CSS custom properties in app.css;
// these are the ones JS/TS logic depends on.)

/** Single responsive breakpoint dividing the mobile / wide layouts (design §13). */
export const WIDE_BREAKPOINT_PX = 720;

/** Standard minimum accessible touch-target size. */
export const MIN_TAP_TARGET_PX = 48;

/** Diameter of the primary tap-to-play transport button. */
export const PLAY_BUTTON_DIAMETER_PX = 120;

/** How long a warning/info banner lingers before auto-dismissing (errors never do). */
export const WARNING_AUTODISMISS_MS = 6000;

/** Maximum number of stacked banners; older non-error notices beyond this are dropped. */
export const NOTICE_MAX_VISIBLE = 3;

/** Hit radius for a canvas node handle (44 px touch diameter, the tap-target rule). */
export const NODE_HIT_RADIUS_PX = 22;

/** Curve sampling resolution: one sample per N CSS pixels across a lane. */
export const CURVE_SAMPLE_PX = 2;

/** Minimum spacing between two node times so they never share a `t` (validation forbids it). */
export const MIN_NODE_DT_SEC = 0.01;

/** Max zoom-in: the editor view always spans at least this many seconds. */
export const EDITOR_MIN_VIEW_SEC = 5;

// ---------------------------------------------------------------------------
// Phase-2 layer-authoring constants + shared literal types (design §21).
// These join the existing single-source-of-truth file so the authoring stores
// and components share one definition (no new CSS tokens — §21).
// ---------------------------------------------------------------------------

import type { ToneSpec } from '../../engine/session-model';

/** The default ToneSpec a fresh `tone` layer gets — a soft, audible bell. Within
 *  RANGES.toneFreq {20,20000} with a one-shot envelope (session-model §10 / arch §6),
 *  so addLayer('tone') always produces a valid, playable synth source (design §21). */
export const DEFAULT_TONE_SPEC: ToneSpec = {
  shape: 'sine',
  freqHz: 528,
  attackSec: 0.005,
  releaseSec: 3,
};

/** The two offered export formats (design §19): WAV dependency-free, MP3 compressed. */
export type RenderFormat = 'wav' | 'mp3';

/** The clip panel's two roles (design §18): browse manages the library; pick returns a
 *  clipId to a layer source. */
export type ClipPanelMode = 'browse' | 'pick';

/** RenderStore lifecycle phases (design §19). */
export type RenderPhase = 'idle' | 'rendering' | 'encoding' | 'done' | 'error';

/** VoiceScriptStore lifecycle phases (design §20). */
export type VoiceScriptPhase = 'idle' | 'compiling' | 'done' | 'error';
