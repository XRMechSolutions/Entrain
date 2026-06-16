import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { consumeBufferedInstallPrompt } from './install-buffer';

// Task [config]: index.html iOS head tags, critical safe-area CSS, and the early
// install-capture snippet (design.md §4/§5/§7, interfaces.md §6, edge-cases B5/C3/E2).

const root = process.cwd();
const html = readFileSync(join(root, 'index.html'), 'utf8');
const viteConfig = readFileSync(join(root, 'vite.config.ts'), 'utf8');
const doc = new DOMParser().parseFromString(html, 'text/html');

function metaContent(name: string): string | null {
  return doc.querySelector(`meta[name="${name}"]`)?.getAttribute('content') ?? null;
}

describe('index.html iOS head tags', () => {
  it('viewport enables safe-area insets (viewport-fit=cover)', () => {
    expect(metaContent('viewport')).toBe(
      'width=device-width, initial-scale=1, viewport-fit=cover',
    );
  });

  it('declares both standalone-capable spellings = yes', () => {
    expect(metaContent('apple-mobile-web-app-capable')).toBe('yes');
    expect(metaContent('mobile-web-app-capable')).toBe('yes');
  });

  it('sets the iOS status-bar style, title and application-name', () => {
    expect(metaContent('apple-mobile-web-app-status-bar-style')).toBe('black-translucent');
    expect(metaContent('apple-mobile-web-app-title')).toBe('Binaural');
    expect(metaContent('application-name')).toBe('Binaural');
  });

  it('sets color-scheme dark', () => {
    expect(metaContent('color-scheme')).toBe('dark');
  });

  it('links the 180px apple-touch-icon and both favicons', () => {
    expect(doc.querySelector('link[rel="apple-touch-icon"]')?.getAttribute('href')).toBe(
      '/apple-touch-icon-180x180.png',
    );
    expect(doc.querySelector('link[rel="icon"][href="/favicon.ico"]')).not.toBeNull();
    expect(doc.querySelector('link[rel="icon"][href="/favicon.svg"]')).not.toBeNull();
  });
});

describe('index.html color contract (no seam)', () => {
  it('theme-color meta == manifest theme_color == --app-bg (#0B0F14)', () => {
    expect(metaContent('theme-color')).toBe('#0B0F14');
    expect(html).toMatch(/--app-bg:\s*#0B0F14/);
    // Manifest theme_color + background_color authored in vite.config.ts.
    expect(viteConfig).toMatch(/theme_color:\s*'#0B0F14'/);
    expect(viteConfig).toMatch(/background_color:\s*'#0B0F14'/);
  });
});

describe('index.html critical CSS', () => {
  it('defines all four --safe-* tokens with a 0px fallback (E2 unsupported env())', () => {
    expect(html).toMatch(/--safe-top:\s*env\(safe-area-inset-top,\s*0px\)/);
    expect(html).toMatch(/--safe-right:\s*env\(safe-area-inset-right,\s*0px\)/);
    expect(html).toMatch(/--safe-bottom:\s*env\(safe-area-inset-bottom,\s*0px\)/);
    expect(html).toMatch(/--safe-left:\s*env\(safe-area-inset-left,\s*0px\)/);
  });

  it('paints the dark background and degrades 100dvh gracefully', () => {
    expect(html).toMatch(/html,\s*body\s*\{[^}]*background:\s*var\(--app-bg\)/s);
    expect(html).toMatch(/min-height:\s*100dvh/);
    expect(html).toMatch(/overscroll-behavior:\s*none/);
    // height:100% keeps the page filled where 100dvh is unsupported (E3).
    expect(html).toMatch(/height:\s*100%/);
  });

  it('the background-painting <style> precedes the module bundle (no white flash, C3)', () => {
    const styleIdx = html.indexOf('<style>');
    const bundleIdx = html.indexOf('type="module"');
    expect(styleIdx).toBeGreaterThan(-1);
    expect(bundleIdx).toBeGreaterThan(-1);
    expect(styleIdx).toBeLessThan(bundleIdx);
  });
});

describe('index.html manifest link', () => {
  it('does NOT hand-write <link rel="manifest"> (the plugin injects it)', () => {
    expect(doc.querySelector('link[rel="manifest"]')).toBeNull();
    expect(html).not.toMatch(/rel=["']manifest["']/);
  });
});

describe('index.html early install-capture snippet', () => {
  it('buffers a beforeinstallprompt fired before the bundle, adoptable via consume()', () => {
    // Extract the classic inline snippet (not the module bundle) and run it, simulating
    // the parse-time execution that happens before the ES-module bundle evaluates.
    const scripts = Array.from(doc.querySelectorAll('script')).filter(
      (s) => !s.getAttribute('src') && (s.textContent ?? '').includes('beforeinstallprompt'),
    );
    expect(scripts).toHaveLength(1);
    new Function(scripts[0].textContent ?? '')();

    const evt = new Event('beforeinstallprompt') as BeforeInstallPromptEvent;
    window.dispatchEvent(evt);

    // ui adopts it after boot.
    expect(consumeBufferedInstallPrompt()).toBe(evt);
    expect(consumeBufferedInstallPrompt()).toBeNull();
  });

  it('sets __appInstalled and clears the buffer on appinstalled (B7)', () => {
    new Function(
      Array.from(doc.querySelectorAll('script'))
        .find((s) => !s.getAttribute('src') && (s.textContent ?? '').includes('beforeinstallprompt'))
        ?.textContent ?? '',
    )();
    window.__deferredInstallPrompt = new Event('beforeinstallprompt') as BeforeInstallPromptEvent;
    window.dispatchEvent(new Event('appinstalled'));
    expect(window.__appInstalled).toBe(true);
    expect(window.__deferredInstallPrompt).toBeNull();
  });
});
