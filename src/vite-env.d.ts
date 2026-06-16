/// <reference types="vite/client" />
/// <reference types="vite-plugin-pwa/client" />

// Ambient/global contracts published by pwa-shell (interfaces.md §5). This file owns
// the project's env types so `import.meta.env`, `virtual:pwa-register` (the module ui
// imports), the non-standard `BeforeInstallPromptEvent`, the index.html install-capture
// globals, and iOS `navigator.standalone` all type-check across the codebase.

/** Chromium-only event; not in lib.dom yet, declared here (whatwg/html#5436). */
interface BeforeInstallPromptEvent extends Event {
  readonly platforms: ReadonlyArray<string>;
  readonly userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>;
  prompt(): Promise<void>;
}

interface WindowEventMap {
  beforeinstallprompt: BeforeInstallPromptEvent;
  appinstalled: Event;
}

interface Window {
  /** Filled by the index.html capture snippet; consumed once by ui via
   *  consumeBufferedInstallPrompt(). */
  __deferredInstallPrompt: BeforeInstallPromptEvent | null;
  /** Set true by the snippet on 'appinstalled'. */
  __appInstalled: boolean;
}

interface Navigator {
  /** iOS Safari only: true when launched from the home screen. */
  standalone?: boolean;
}
