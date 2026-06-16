// Install-event buffer read helpers (interfaces.md §4). The reactive install store lives
// in `ui`; pwa-shell only provides the early-capture buffer (filled by the index.html
// snippet, design.md §7) and these pure read helpers so `ui` can adopt anything captured
// before the bundle ran. No reactivity, no UI — deterministic reads only.

/** Take ownership of any beforeinstallprompt event captured before the app booted,
 *  clearing the buffer so it is consumed exactly once. Returns null if none buffered.
 *  ui's install store calls this in its constructor, then continues listening itself. */
export function consumeBufferedInstallPrompt(): BeforeInstallPromptEvent | null {
  const e = window.__deferredInstallPrompt;
  window.__deferredInstallPrompt = null;
  return e ?? null;
}

/** True if the 'appinstalled' event fired before the app booted. */
export function wasInstalledBeforeBoot(): boolean {
  return window.__appInstalled === true;
}

/** Running as an installed/standalone app (display-mode standalone, or iOS
 *  navigator.standalone). ui uses this to hide all install affordances. */
export function isStandaloneDisplay(): boolean {
  return (
    window.matchMedia('(display-mode: standalone)').matches ||
    window.navigator.standalone === true
  );
}
