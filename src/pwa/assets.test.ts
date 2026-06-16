import { SILENT_LOOP_URL, SILENT_LOOP_MIN_SEC } from './assets';

// Task [config]: silent-loop value exports (interfaces.md §3, design.md §6.3). The URL is
// base-prefixed via BASE_URL (the single switch point, §6.5); MIN_SEC is the audio-focus
// "effective media duration" floor transport asserts.

describe('assets exports', () => {
  it('SILENT_LOOP_MIN_SEC is 5', () => {
    expect(SILENT_LOOP_MIN_SEC).toBe(5);
  });

  it('SILENT_LOOP_URL resolves to /audio/silence-5s.wav at base "/"', () => {
    expect(SILENT_LOOP_URL).toBe('/audio/silence-5s.wav');
  });

  it('re-prefixes correctly when BASE_URL is a sub-path', async () => {
    vi.stubEnv('BASE_URL', '/app/');
    vi.resetModules();
    const mod = await import('./assets');
    expect(mod.SILENT_LOOP_URL).toBe('/app/audio/silence-5s.wav');
    vi.unstubAllEnvs();
    vi.resetModules();
  });
});
