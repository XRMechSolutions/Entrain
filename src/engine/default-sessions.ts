// Built-in session presets seeded into the library (beyond the original four band/use
// starters in persistence). The canonical JSON lives at the repo root in presets/ — the
// SAME files anyone can import/share — so there is one source of truth. Each is
// runtime-validated when seeded (persistence's "every built-in passes validate" test) and
// by default-presets.test.ts, so the cast below can never smuggle in an invalid preset.
//
// Contents: one full-night sleep journey (~90-min cycles, theta<->delta, morning wake ramp)
// + three power naps (descend fast, hold, then ascend to a gentle isochronic wake) + five
// binaural work sessions — beta focus and alpha/alpha->theta creative (all with beat warble
// + spatial drift) — plus three isochronic focus pulses (beta 15/18 + gamma 40): physically-
// present amplitude gating with beat:0, not a binaural beat, so they need no headphones and
// reach gamma 40, which the binaural beat lane (capped at 35 Hz) cannot. Plus one multi-voice
// (v6) meditation: two simultaneous binaural beats on well-separated carriers (alpha on 200 Hz +
// theta on 256 Hz) — the seed example for the dual-beat + narration authoring flow.
import type { Preset } from './session-model';

import sleep8h from '../../presets/8h-sleep-cycles.json';
import nap20 from '../../presets/power-nap-20.json';
import nap40 from '../../presets/power-nap-40.json';
import nap60 from '../../presets/power-nap-60.json';
import focusBeta15 from '../../presets/focus-beta-15-warble-drift.json';
import deepWorkBeta18 from '../../presets/deep-work-beta-18-warble-drift.json';
import createAlpha10 from '../../presets/create-alpha-10-warble-drift.json';
import createAlphaTheta from '../../presets/create-alpha-theta-warble-drift.json';
import focusGamma40 from '../../presets/focus-gamma-40-isochronic-drift.json';
import focusBeta15Iso from '../../presets/focus-beta-15-isochronic-drift.json';
import deepWorkBeta18Iso from '../../presets/deep-work-beta-18-isochronic-drift.json';
import dualBeatMeditation from '../../presets/dual-beat-meditation.json';

// JSON infers schemaVersion as `number`, not the literal `6`; cast once. Validity is
// guaranteed at runtime by the seed-time validate(), not by this cast.
export const DEFAULT_SESSIONS: Preset[] = [
  sleep8h,
  nap20,
  nap40,
  nap60,
  focusBeta15,
  deepWorkBeta18,
  createAlpha10,
  createAlphaTheta,
  focusGamma40,
  focusBeta15Iso,
  deepWorkBeta18Iso,
  dualBeatMeditation,
] as unknown as Preset[];
