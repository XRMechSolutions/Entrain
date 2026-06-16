import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Task [config]: the ambient/global type contract (interfaces.md §5). These declarations
// are compile-time only (erased at runtime), so this test verifies the published contract
// by inspecting the .d.ts: the triple-slash references that surface `import.meta.env` and
// `virtual:pwa-register`, the non-standard BeforeInstallPromptEvent, the WindowEventMap
// augmentation, the install-buffer globals, and iOS navigator.standalone. The full
// `tsc` type-check is run separately against the project (downstream .ts files resolve
// `virtual:pwa-register` and BeforeInstallPromptEvent because of these references).

const src = readFileSync(join(process.cwd(), 'src/vite-env.d.ts'), 'utf8');

describe('vite-env.d.ts ambient contract', () => {
  it('references vite/client and vite-plugin-pwa/client', () => {
    expect(src).toContain('/// <reference types="vite/client" />');
    expect(src).toContain('/// <reference types="vite-plugin-pwa/client" />');
  });

  it('declares the non-standard BeforeInstallPromptEvent with prompt()/userChoice/platforms', () => {
    expect(src).toContain('interface BeforeInstallPromptEvent extends Event');
    expect(src).toContain('readonly platforms: ReadonlyArray<string>');
    expect(src).toContain('readonly userChoice: Promise<');
    expect(src).toContain('prompt(): Promise<void>');
  });

  it('augments WindowEventMap with beforeinstallprompt + appinstalled', () => {
    expect(src).toContain('interface WindowEventMap');
    expect(src).toContain('beforeinstallprompt: BeforeInstallPromptEvent');
    expect(src).toContain('appinstalled: Event');
  });

  it('declares the install-buffer Window globals', () => {
    expect(src).toContain('__deferredInstallPrompt: BeforeInstallPromptEvent | null');
    expect(src).toContain('__appInstalled: boolean');
  });

  it('declares iOS Navigator.standalone as optional boolean', () => {
    expect(src).toContain('standalone?: boolean');
  });

  it('types the globals at runtime via the ambient Window declaration', () => {
    // Type-level smoke: these assignments only compile because vite-env.d.ts is in scope.
    window.__deferredInstallPrompt = null;
    window.__appInstalled = false;
    const e: BeforeInstallPromptEvent | null = window.__deferredInstallPrompt;
    expect(e).toBeNull();
    expect(window.__appInstalled).toBe(false);
  });
});
