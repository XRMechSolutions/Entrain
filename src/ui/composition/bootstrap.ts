// bootstrap.ts — the composition root. The ONE place concrete modules are wired:
// build the scheduler adapter → transport → the six stores → seed the library → set the
// working preset → register the service worker → mount <App>; on App mount prime the
// audio context off-gesture and adopt any buffered install prompt. A module-level guard
// makes a double bootstrap()/HMR build exactly one transport (edge I5).
//
// The fixed boot order is design §4. registerSW is INJECTED (main.ts wires the real
// `virtual:pwa-register`; tests inject a mock) so this file never imports the virtual
// module and stays unit-testable — the vitest config does not run vite-plugin-pwa, so a
// static `virtual:pwa-register` import would fail to resolve.
//
// RESOLVES the transport artwork + silentFileUrl stubs by injection (APP_ICONS /
// SILENT_LOOP_URL from pwa-shell).

import { mount } from 'svelte';
import { createTransport as defaultCreateTransport } from '../../engine/transport';
import { createDefaultPreset } from '../../engine/session-model';
import { APP_ICONS } from '../../pwa/icons';
import { SILENT_LOOP_URL } from '../../pwa/assets';
import { consumeBufferedInstallPrompt } from '../../pwa/install-buffer';
import { createSchedulerAdapter } from './scheduler-adapter';
import { createNoticeStore, createUiStore } from '../stores/notices.svelte';
import { createPlaybackStore, createSessionStore } from '../stores/session.svelte';
import { createInstallStore, createLibraryStore } from '../stores/library.svelte';
import App from '../App.svelte';
import { APP_CONTEXT_KEY, type AppContext } from '../context';

export type { AppContext } from '../context';

/** The prompt-mode registerSW options bootstrap forwards (a structural subset of
 *  vite-plugin-pwa's RegisterSWOptions). */
export interface BootstrapRegisterSWOptions {
  immediate?: boolean;
  onNeedRefresh?: () => void;
  onOfflineReady?: () => void;
}

/** The shape of `virtual:pwa-register`'s registerSW (injected; see file header). */
export type RegisterSWFn = (
  options?: BootstrapRegisterSWOptions,
) => (reloadPage?: boolean) => Promise<void>;

/** Test/integration injection seams. All default to the real platform wiring. */
export interface BootstrapOverrides {
  /** The real `virtual:pwa-register` registerSW (wired by main.ts). When omitted, no SW
   *  is registered (the unit-test default; tests pass a mock to assert prompt mode). */
  registerSW?: RegisterSWFn;
  /** Defaults to engine.createTransport; injectable so tests assert the injected scheduler. */
  createTransport?: typeof defaultCreateTransport;
  /** Mount <App>; default uses svelte `mount`. Injectable so the bootstrap unit test can
   *  drive the onReady (App-mount) hook without a full render. */
  mountApp?: (target: HTMLElement, ctx: AppContext, onReady: () => void) => void;
}

/** Module-level idempotent guard (edge I5): a second bootstrap()/HMR returns the same
 *  wired context and never builds a second transport. */
let current: AppContext | undefined;

export function bootstrap(target?: HTMLElement, overrides: BootstrapOverrides = {}): AppContext {
  if (current) return current;

  const createTransport = overrides.createTransport ?? defaultCreateTransport;

  // 1. scheduler adapter → 2. transport (artwork + silentFileUrl stubs resolved here).
  const scheduler = createSchedulerAdapter();
  // The MediaStream→<audio> bridge (D-018) exists only to hold Android background/locked-
  // screen audio focus. On desktop it adds a glitchy media hop (startup stutter/dropouts)
  // with no benefit, so use direct Web Audio output there. Engage the bridge only on
  // touch / coarse-pointer devices (phones/tablets), where background audio matters.
  const wantsBackgroundBridge =
    typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
  const transport = createTransport({
    scheduler,
    artwork: APP_ICONS,
    silentFileUrl: SILENT_LOOP_URL,
    backgroundAudioMode: wantsBackgroundBridge ? 'mediastream' : 'none',
  });

  // 3. + 4. the six stores, wired to transport (playback/notices subscribe in their ctors).
  const notices = createNoticeStore();
  const playback = createPlaybackStore({ transport, notices });
  const session = createSessionStore({ transport, playback });
  const library = createLibraryStore({ session, notices });
  const { store: install, hooks, setUpdateSW } = createInstallStore();
  const ui = createUiStore();

  // 5. seed the library once (idempotent) and adopt the working preset BY REFERENCE so
  //    duration() > 0 and the scrubber has a range from the first frame.
  library.seed();
  session.reset(createDefaultPreset());

  // 6. register the SW in prompt mode (D-017) — reload only ever on the user's click.
  if (overrides.registerSW) {
    const updateSW = overrides.registerSW({
      immediate: true,
      onNeedRefresh: hooks.onNeedRefresh,
      onOfflineReady: hooks.onOfflineReady,
    });
    setUpdateSW(updateSW);
  }

  const ctx: AppContext = { transport, session, playback, library, notices, install, ui };
  current = ctx;

  // 8. On App mount (autoplay-safe, OFF gesture): create the suspended context + load the
  //    pulse worklet so it is ready before the first tap; a rejection is swallowed (the
  //    transport surfaces a WORKLET_UNAVAILABLE warning of its own — edge A3). Also adopt
  //    any install prompt the index.html snippet captured before the bundle ran.
  const onReady = (): void => {
    transport.prime().catch(() => {
      /* surfaced via the transport 'warning' path; never throws here */
    });
    adoptBufferedInstall();
  };

  const mountApp = overrides.mountApp ?? defaultMountApp;
  mountApp(target ?? defaultTarget(), ctx, onReady);

  return ctx;
}

/** The index.html mount host (`#app`), falling back to <body>. */
function defaultTarget(): HTMLElement {
  if (typeof document === 'undefined') return undefined as never;
  return document.getElementById('app') ?? document.body;
}

function defaultMountApp(target: HTMLElement, ctx: AppContext, onReady: () => void): void {
  mount(App, {
    target,
    context: new Map<unknown, unknown>([[APP_CONTEXT_KEY, ctx]]),
    props: { onReady },
  });
}

/** Re-dispatch any beforeinstallprompt captured by the early index.html snippet so the
 *  install store's own listener adopts it (it attaches after the snippet; without this a
 *  prompt that fired pre-bundle would be lost — edge H1). Defensive: a stale event that
 *  can no longer be dispatched is ignored. */
function adoptBufferedInstall(): void {
  if (typeof window === 'undefined') return;
  const buffered = consumeBufferedInstallPrompt();
  if (!buffered) return;
  try {
    window.dispatchEvent(buffered);
  } catch {
    /* a finished/locked event can't be re-dispatched; harmless */
  }
}

/** TEST-ONLY: clear the module-level guard so each bootstrap() unit test starts fresh.
 *  Never called in production (the guard is meant to persist for the app's lifetime). */
export function resetBootstrapForTests(): void {
  current = undefined;
}
