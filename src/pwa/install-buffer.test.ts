import {
  consumeBufferedInstallPrompt,
  wasInstalledBeforeBoot,
  isStandaloneDisplay,
} from './install-buffer';

// Task [impl]: install-event buffer read helpers (interfaces.md §4, edge-cases B5/B6/B7).
// The buffer globals are filled by the index.html capture snippet; these helpers are pure
// reads. consumeBufferedInstallPrompt must consume EXACTLY once (cannot be replayed).

function setStandalone(value: boolean | undefined): void {
  Object.defineProperty(window.navigator, 'standalone', { value, configurable: true });
}

beforeEach(() => {
  window.__deferredInstallPrompt = null;
  window.__appInstalled = false;
  setStandalone(undefined);
  // jsdom does not implement matchMedia — default it to "no match".
  window.matchMedia = vi
    .fn()
    .mockReturnValue({ matches: false }) as unknown as typeof window.matchMedia;
});

describe('consumeBufferedInstallPrompt', () => {
  it('returns the buffered event on the first call and null on the second (single-use)', () => {
    const buffered = new Event('beforeinstallprompt') as BeforeInstallPromptEvent;
    window.__deferredInstallPrompt = buffered;

    expect(consumeBufferedInstallPrompt()).toBe(buffered);
    // Cleared on consume — cannot be replayed (edge-cases B6).
    expect(window.__deferredInstallPrompt).toBeNull();
    expect(consumeBufferedInstallPrompt()).toBeNull();
  });

  it('returns null when nothing is buffered', () => {
    expect(consumeBufferedInstallPrompt()).toBeNull();
  });

  it('treats an undefined global as null', () => {
    // Simulate the snippet never having run (global absent).
    delete (window as Partial<Window>).__deferredInstallPrompt;
    expect(consumeBufferedInstallPrompt()).toBeNull();
  });
});

describe('wasInstalledBeforeBoot', () => {
  it('tracks the __appInstalled flag', () => {
    expect(wasInstalledBeforeBoot()).toBe(false);
    window.__appInstalled = true;
    expect(wasInstalledBeforeBoot()).toBe(true);
  });
});

describe('isStandaloneDisplay', () => {
  it('is true for display-mode standalone', () => {
    window.matchMedia = vi
      .fn()
      .mockReturnValue({ matches: true }) as unknown as typeof window.matchMedia;
    expect(isStandaloneDisplay()).toBe(true);
  });

  it('is true for iOS navigator.standalone even when matchMedia does not match', () => {
    setStandalone(true);
    expect(isStandaloneDisplay()).toBe(true);
  });

  it('is false when neither display-mode standalone nor iOS standalone', () => {
    setStandalone(false);
    expect(isStandaloneDisplay()).toBe(false);
  });

  it('queries the (display-mode: standalone) media query', () => {
    const spy = vi
      .fn()
      .mockReturnValue({ matches: false }) as unknown as typeof window.matchMedia;
    window.matchMedia = spy;
    isStandaloneDisplay();
    expect(spy).toHaveBeenCalledWith('(display-mode: standalone)');
  });
});
