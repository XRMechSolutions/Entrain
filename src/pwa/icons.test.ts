import { MANIFEST_ICONS, APP_ICONS } from './icons';
import type { AppIcon } from './icons';

// Task [config]: runtime icon exports (interfaces.md §2, design.md §6.2). APP_ICONS is the
// MediaSession lock-screen artwork (192 + 512 `any` only — NO maskable). MANIFEST_ICONS is
// the three-icon manifest set including the maskable-512. Both base-prefix via BASE_URL.

describe('MANIFEST_ICONS', () => {
  it('has the three install icons: 192 + 512 + maskable-512', () => {
    expect(MANIFEST_ICONS).toHaveLength(3);
    expect(MANIFEST_ICONS.map((i) => i.sizes)).toEqual(['192x192', '512x512', '512x512']);
  });

  it('includes the maskable-512 with purpose "maskable"', () => {
    const maskable = MANIFEST_ICONS.find((i) => i.purpose === 'maskable');
    expect(maskable).toBeDefined();
    expect(maskable).toMatchObject({
      src: '/maskable-icon-512x512.png',
      sizes: '512x512',
      type: 'image/png',
      purpose: 'maskable',
    });
  });

  it('the two non-maskable entries are purpose "any"', () => {
    const anyIcons = MANIFEST_ICONS.filter((i) => i.purpose === 'any');
    expect(anyIcons).toHaveLength(2);
    expect(anyIcons.map((i: AppIcon) => i.src)).toEqual([
      '/pwa-192x192.png',
      '/pwa-512x512.png',
    ]);
  });
});

describe('APP_ICONS', () => {
  it('has exactly 2 entries (192 + 512) and no maskable', () => {
    expect(APP_ICONS).toHaveLength(2);
    // MediaImage has no `purpose`; lock-screen art is never masked.
    for (const icon of APP_ICONS) {
      expect(icon).not.toHaveProperty('purpose');
    }
  });

  it('each entry is a valid MediaImage { src, sizes, type }', () => {
    for (const icon of APP_ICONS) {
      expect(typeof icon.src).toBe('string');
      expect(typeof icon.sizes).toBe('string');
      expect(typeof icon.type).toBe('string');
      expect(Object.keys(icon).sort()).toEqual(['sizes', 'src', 'type']);
    }
  });

  it('matches the documented example value for APP_ICONS[1]', () => {
    expect(APP_ICONS[1]).toEqual({ src: '/pwa-512x512.png', sizes: '512x512', type: 'image/png' });
    expect(APP_ICONS[0]).toEqual({ src: '/pwa-192x192.png', sizes: '192x192', type: 'image/png' });
  });

  it('re-prefixes both exports when BASE_URL is a sub-path', async () => {
    vi.stubEnv('BASE_URL', '/app/');
    vi.resetModules();
    const mod = await import('./icons');
    expect(mod.APP_ICONS.map((i) => i.src)).toEqual([
      '/app/pwa-192x192.png',
      '/app/pwa-512x512.png',
    ]);
    expect(mod.MANIFEST_ICONS[2].src).toBe('/app/maskable-icon-512x512.png');
    vi.unstubAllEnvs();
    vi.resetModules();
  });
});
