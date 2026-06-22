// Built-in session presets seeded into the library (beyond the original four band/use
// starters in persistence). The canonical JSON lives at the repo root in presets/ — the
// SAME files anyone can import/share — so there is one source of truth. Each is
// runtime-validated when seeded (persistence's "every built-in passes validate" test) and
// by default-presets.test.ts, so the cast below can never smuggle in an invalid preset.
//
// COMMITTED set (always present, statically imported): one full-night sleep journey + three
// power naps + beta/alpha creative work sessions + one multi-voice (v6) narrated meditation
// (two simultaneous binaural beats on well-separated carriers, the dual-beat + narration seed).
//
// LOCAL-ONLY extras: `presets/focus-*.json` are personal/testing presets kept OUT of the public
// repo (.gitignore: "kept local for now, not part of the initial public release"). They are
// pulled in with import.meta.glob, which includes ONLY the files that actually exist at build
// time — so the committed/CI build never imports or requires them (a fresh checkout has none →
// the build resolves cleanly with zero focus files), yet a dev who keeps them locally still gets
// them seeded for personal testing. The seeded COUNT is therefore environment-dependent; tests
// derive it from buildDefaultLibraryPresets() rather than hard-coding a number.
import type { Preset } from './session-model';

import sleep8h from '../../presets/8h-sleep-cycles.json';
import nap20 from '../../presets/power-nap-20.json';
import nap40 from '../../presets/power-nap-40.json';
import nap60 from '../../presets/power-nap-60.json';
import deepWorkBeta18 from '../../presets/deep-work-beta-18-warble-drift.json';
import createAlpha10 from '../../presets/create-alpha-10-warble-drift.json';
import createAlphaTheta from '../../presets/create-alpha-theta-warble-drift.json';
import deepWorkBeta18Iso from '../../presets/deep-work-beta-18-isochronic-drift.json';
import dualBeatMeditation from '../../presets/dual-beat-meditation.json';

// Local-only focus presets (gitignored). import.meta.glob over a pattern with NO matches yields
// an empty object, so the committed/CI build resolves with zero focus files and never fails on
// their absence. Keys are sorted for a deterministic seed order wherever the files are present.
const localFocusModules = import.meta.glob('../../presets/focus-*.json', {
  eager: true,
  import: 'default',
}) as Record<string, unknown>;
const localFocusSessions = Object.keys(localFocusModules)
  .sort()
  .map((k) => localFocusModules[k]);

// JSON infers schemaVersion as `number`, not the literal `6`; cast once. Validity is
// guaranteed at runtime by the seed-time validate(), not by this cast.
export const DEFAULT_SESSIONS: Preset[] = [
  sleep8h,
  nap20,
  nap40,
  nap60,
  deepWorkBeta18,
  createAlpha10,
  createAlphaTheta,
  deepWorkBeta18Iso,
  dualBeatMeditation,
  ...localFocusSessions,
] as unknown as Preset[];
