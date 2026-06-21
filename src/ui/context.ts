// The Svelte-context contract: the wired store bundle (AppContext) that bootstrap()
// builds once and provides to <App> via the mount `context` map. Screens/components
// read it with getAppContext(); none of them constructs a store. Defined here (not in
// bootstrap.ts) so App.svelte and bootstrap.ts share the type + key without a cycle
// (bootstrap imports App, App imports this; this imports neither).

import { getContext } from 'svelte';
import type { Transport } from '../engine/transport';
import type { PlaybackStore, SessionStore } from './stores/session.svelte';
import type { ClipStore, InstallStore, LibraryStore } from './stores/library.svelte';
import type { NoticeStore, UiStore } from './stores/notices.svelte';
import type { RenderStore, VoiceScriptStore } from './stores/authoring.svelte';

/** The wired singletons bootstrap() assembles and provides to App via context. */
export interface AppContext {
  readonly transport: Transport;
  readonly session: SessionStore;
  readonly playback: PlaybackStore;
  readonly library: LibraryStore;
  readonly notices: NoticeStore;
  readonly install: InstallStore;
  readonly ui: UiStore;
  // Phase-2 authoring stores (design §16.2, interfaces §1/§16).
  readonly clips: ClipStore;
  readonly render: RenderStore;
  readonly voiceScript: VoiceScriptStore;
}

/** Context key for the AppContext (a unique symbol so it never collides). */
export const APP_CONTEXT_KEY: unique symbol = Symbol('binaural.appContext');

/** Read the wired AppContext provided by bootstrap()'s mount. Only valid inside a
 *  component that descends from the bootstrapped <App> (there is no pre-init window —
 *  edge K2). */
export function getAppContext(): AppContext {
  return getContext<AppContext>(APP_CONTEXT_KEY);
}
