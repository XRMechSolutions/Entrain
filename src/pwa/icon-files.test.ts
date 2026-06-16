import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { ICON_FILES } from './icon-files';
import type { IconFileKey } from './icon-files';

// Task [config]: the single-source icon-filename constants + the Node/browser-safe import.
// ICON_FILES must have no `import.meta` so it loads identically from the browser runtime
// and the Node-side vite.config.ts (interfaces.md §1).

const publicDir = join(process.cwd(), 'public');

describe('ICON_FILES', () => {
  it('exposes exactly the 7 declared keys', () => {
    const keys = Object.keys(ICON_FILES).sort();
    expect(keys).toEqual(
      [
        'pwa64',
        'pwa192',
        'pwa512',
        'maskable512',
        'appleTouch180',
        'faviconIco',
        'faviconSvg',
      ].sort(),
    );
  });

  it('maps each key to its committed filename', () => {
    expect(ICON_FILES.pwa64).toBe('pwa-64x64.png');
    expect(ICON_FILES.pwa192).toBe('pwa-192x192.png');
    expect(ICON_FILES.pwa512).toBe('pwa-512x512.png');
    expect(ICON_FILES.maskable512).toBe('maskable-icon-512x512.png');
    expect(ICON_FILES.appleTouch180).toBe('apple-touch-icon-180x180.png');
    expect(ICON_FILES.faviconIco).toBe('favicon.ico');
    expect(ICON_FILES.faviconSvg).toBe('favicon.svg');
  });

  it('every filename exists in /public (committed generator output)', () => {
    for (const key of Object.keys(ICON_FILES) as IconFileKey[]) {
      const file = join(publicDir, ICON_FILES[key]);
      expect(existsSync(file), `${ICON_FILES[key]} must exist in /public`).toBe(true);
    }
  });

  it('is Node-safe — contains no import.meta so it imports from both runtimes', () => {
    const src = readFileSync(join(process.cwd(), 'src/pwa/icon-files.ts'), 'utf8');
    expect(src).not.toContain('import.meta');
  });
});
