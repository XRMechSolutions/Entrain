/** Minimum duration (s) the background silent loop must be, per the audio-focus
 *  "effective media duration" rule (D-018, mobile-audio-lifecycle). pwa-shell's
 *  build/test guarantees the asset is ≥5 s; transport consumes the URL opaquely. */
export const SILENT_LOOP_MIN_SEC = 5;

/** URL of the committed near-silent ≥5 s loop (public/audio/silence-5s.wav).
 *  Passed to transport via createTransport({ silentFileUrl: SILENT_LOOP_URL }) for the
 *  D-018 'silent-file' fallback. Resolves the registry stub
 *  "default silentFileUrl points at a bundled near-silent ≥5s loop asset".
 *  Base-prefixed via import.meta.env.BASE_URL (design.md §6.5, the single switch point). */
export const SILENT_LOOP_URL: string = `${import.meta.env.BASE_URL}audio/silence-5s.wav`;
