// @vitest-environment node
// vite.config.ts imports @sveltejs/vite-plugin-svelte, which loads esbuild; esbuild's
// `TextEncoder` invariant is broken under jsdom, so this config file runs in the node
// environment to import and inspect the live Vite config object.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Task [config]: the VitePWA() build-config block + pwa-assets generator config
// (interfaces.md §7, design.md §2/§3, edge-cases A3/A6/A8/B2). These are fixed config
// objects, not an importable API, so the manifest/Workbox fields are asserted from the
// authored source, and the live config objects are imported to prove they are valid and
// wire the expected plugins/preset. A full `vite build` is gated on ui's src/main.ts entry
// (a different module), so it is not executed inside the unit suite.

const root = process.cwd();
const viteConfig = readFileSync(join(root, 'vite.config.ts'), 'utf8');
const assetsConfig = readFileSync(join(root, 'pwa-assets.config.ts'), 'utf8');

describe('vite.config.ts — VitePWA manifest', () => {
  it('derives a build-aware base (default "/") and uses it for the manifest identity', () => {
    // base = process.env.BASE_PATH || '/' — root locally, the repo subpath on GitHub Pages.
    expect(viteConfig).toMatch(/const base\s*=\s*process\.env\.BASE_PATH\s*\|\|\s*'\/'/);
    expect(viteConfig).toMatch(/id:\s*base/);
    expect(viteConfig).toMatch(/start_url:\s*base/);
    expect(viteConfig).toMatch(/scope:\s*base/);
  });

  it('declares display standalone and dark theme/background (Chromium install criteria)', () => {
    expect(viteConfig).toMatch(/display:\s*'standalone'/);
    expect(viteConfig).toMatch(/theme_color:\s*'#0B0F14'/);
    expect(viteConfig).toMatch(/background_color:\s*'#0B0F14'/);
    expect(viteConfig).toMatch(/name:\s*'BinauralAudio'/);
    expect(viteConfig).toMatch(/short_name:\s*'Binaural'/);
  });

  it('uses honest non-medical categories (D-009)', () => {
    expect(viteConfig).toMatch(/categories:\s*\['music',\s*'lifestyle'\]/);
    expect(viteConfig).not.toMatch(/'health'/);
  });

  it('references the 192 + 512 + maskable-512 icons via ICON_FILES', () => {
    expect(viteConfig).toContain('ICON_FILES.pwa192');
    expect(viteConfig).toContain('ICON_FILES.pwa512');
    expect(viteConfig).toContain('ICON_FILES.maskable512');
    expect(viteConfig).toMatch(/purpose:\s*'maskable'/);
  });
});

describe('vite.config.ts — service worker / Workbox (prompt update model)', () => {
  it('registerType prompt + injectRegister null (D-017, no double registration)', () => {
    expect(viteConfig).toMatch(/registerType:\s*'prompt'/);
    expect(viteConfig).toMatch(/injectRegister:\s*null/);
  });

  it('skipWaiting:false so a waiting SW never auto-activates mid-session', () => {
    expect(viteConfig).toMatch(/skipWaiting:\s*false/);
  });

  it('precaches the silent .wav and the worklet .js chunk via globPatterns', () => {
    const glob = viteConfig.match(/globPatterns:\s*\[([^\]]*)\]/)?.[1] ?? '';
    expect(glob).toContain('wav');
    expect(glob).toContain('js');
    expect(viteConfig).toMatch(/navigateFallback:\s*'index\.html'/);
    expect(viteConfig).toMatch(/cleanupOutdatedCaches:\s*true/);
    expect(viteConfig).toMatch(/clientsClaim:\s*true/);
  });

  it('includeAssets covers the favicon svg, apple-touch icon and the silent loop', () => {
    expect(viteConfig).toContain('ICON_FILES.faviconSvg');
    expect(viteConfig).toContain('ICON_FILES.appleTouch180');
    expect(viteConfig).toContain("'audio/silence-5s.wav'");
  });

  it('disables the SW in `vite dev` (no stale dev cache shadowing HMR)', () => {
    expect(viteConfig).toMatch(/devOptions:\s*\{\s*enabled:\s*false\s*\}/);
  });
});

describe('vite.config.ts — live config object', () => {
  it('exports base "/" and wires the svelte + VitePWA plugins', async () => {
    const mod = await import('../../vite.config');
    const config = (await mod.default) as { base?: string; plugins?: unknown[] };
    expect(config.base).toBe('/');
    expect(Array.isArray(config.plugins)).toBe(true);
    expect((config.plugins as unknown[]).length).toBeGreaterThanOrEqual(2);
  });
});

describe('pwa-assets.config.ts — deterministic icon generation', () => {
  it('uses the minimal-2023 preset from a single source SVG with opaque overrides', () => {
    expect(assetsConfig).toContain("import { defineConfig, minimal2023Preset } from '@vite-pwa/assets-generator/config'");
    expect(assetsConfig).toMatch(/images:\s*\['public\/favicon\.svg'\]/);
    expect(assetsConfig).toContain('...minimal2023Preset');
  });

  it('resolves to opaque #0B0F14 maskable + apple backgrounds (no transparent corners)', async () => {
    const mod = await import('../../pwa-assets.config');
    const cfg = mod.default as {
      images: string[];
      preset: {
        transparent: { sizes: number[] };
        maskable: { resizeOptions?: { background?: string } };
        apple: { resizeOptions?: { background?: string } };
      };
    };
    expect(cfg.images).toEqual(['public/favicon.svg']);
    expect(cfg.preset.maskable.resizeOptions?.background).toBe('#0B0F14');
    expect(cfg.preset.apple.resizeOptions?.background).toBe('#0B0F14');
    expect(cfg.preset.transparent.sizes).toEqual([64, 192, 512]);
  });
});
