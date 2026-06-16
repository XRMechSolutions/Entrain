// main.ts — the thin UI entry point. It is the ONLY file that imports the
// `virtual:pwa-register` virtual module (provided by vite-plugin-pwa at build time);
// it injects the real registerSW into the composition root so bootstrap.ts stays free
// of the virtual module and therefore unit-testable (the vitest config does not run
// vite-plugin-pwa). The top-level app entry (Integration scope) imports this `bootstrap`.
//
// Per interfaces.md §1/§10, both `bootstrap` and `createSchedulerAdapter` have one home
// (under composition/) and are surfaced from here.

import { registerSW } from 'virtual:pwa-register';
import { bootstrap as bootstrapCore, type BootstrapOverrides } from './composition/bootstrap';

export { createSchedulerAdapter } from './composition/scheduler-adapter';
export type { AppContext } from './context';

/** Composition root: build the adapter + transport + stores, seed the library, set the
 *  working preset, register the service worker (real prompt-mode registerSW), mount
 *  <App>. Idempotent (HMR/double-invoke safe). Returns the live store bundle. */
export function bootstrap(target?: HTMLElement, overrides: Omit<BootstrapOverrides, 'registerSW'> = {}) {
  return bootstrapCore(target, { ...overrides, registerSW });
}
