// Built-in session presets seeded into the library (beyond the original four band/use
// starters in persistence). The canonical JSON lives at the repo root in presets/ — the
// SAME files anyone can import/share — so there is one source of truth. Each is
// runtime-validated when seeded (persistence's "every built-in passes validate" test) and
// by default-presets.test.ts, so the cast below can never smuggle in an invalid preset.
//
// Three power naps: descend fast, hold, then ascend to a gentle isochronic wake.
import type { Preset } from './session-model';

import nap20 from '../../presets/power-nap-20.json';
import nap40 from '../../presets/power-nap-40.json';
import nap60 from '../../presets/power-nap-60.json';

// JSON infers schemaVersion as `number`, not the literal `3`; cast once. Validity is
// guaranteed at runtime by the seed-time validate(), not by this cast.
export const DEFAULT_SESSIONS: Preset[] = [nap20, nap40, nap60] as unknown as Preset[];
