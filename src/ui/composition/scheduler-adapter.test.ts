import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { scheduleAll, waveformKeyframes } from '../../engine/automation';
import type { Voice } from '../../engine/audio-engine';
import { createDefaultPreset, type Preset, type Waveform } from '../../engine/session-model';
import { createSchedulerAdapter } from './scheduler-adapter';

vi.mock('../../engine/automation', () => ({
  scheduleAll: vi.fn(),
  waveformKeyframes: vi.fn(),
}));

function makeSchedule() {
  return { lanes: {}, retarget: vi.fn(), stop: vi.fn(), dispose: vi.fn() };
}

function makeVoice(currentTime = 0) {
  const ctx = { currentTime };
  return {
    ctx,
    setWaveform: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
  };
}

type FakeVoice = ReturnType<typeof makeVoice>;

function setKeyframes(kfs: { t: number; waveform: Waveform }[]) {
  vi.mocked(waveformKeyframes).mockReturnValue(kfs);
}

const PRESET: Preset = createDefaultPreset();

function squareCalls(voice: FakeVoice): number {
  return voice.setWaveform.mock.calls.filter((c) => c[0] === 'square').length;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.mocked(scheduleAll).mockReset();
  vi.mocked(waveformKeyframes).mockReset();
});
afterEach(() => vi.useRealTimers());

describe('scheduler adapter — apply', () => {
  it('calls scheduleAll with { startTime, startOffsetSec } and applies the waveform at fromSec immediately', () => {
    const schedule = makeSchedule();
    vi.mocked(scheduleAll).mockReturnValue(schedule as never);
    setKeyframes([
      { t: 0, waveform: 'sine' },
      { t: 10, waveform: 'square' },
    ]);
    const voice = makeVoice(2);
    const adapter = createSchedulerAdapter();

    adapter.apply(voice as unknown as Voice, PRESET, 0, 5, { pulseAvailable: true });

    expect(scheduleAll).toHaveBeenCalledWith(PRESET, voice, { startTime: 5, startOffsetSec: 0 });
    expect(voice.setWaveform).toHaveBeenCalledWith('sine'); // waveform in effect at fromSec=0
    expect(squareCalls(voice)).toBe(0); // later keyframe not yet fired
    expect(voice.start).not.toHaveBeenCalled();
    expect(voice.stop).not.toHaveBeenCalled();
  });

  it('fires later keyframes at (atCtxTime + kf.t − fromSec − now) ms', () => {
    vi.mocked(scheduleAll).mockReturnValue(makeSchedule() as never);
    setKeyframes([
      { t: 0, waveform: 'sine' },
      { t: 10, waveform: 'square' },
    ]);
    const voice = makeVoice(2);
    const adapter = createSchedulerAdapter();
    adapter.apply(voice as unknown as Voice, PRESET, 0, 5, { pulseAvailable: true });

    // delay = (5 + 10 − 0 − 2) * 1000 = 13000 ms
    vi.advanceTimersByTime(12_999);
    expect(squareCalls(voice)).toBe(0);
    vi.advanceTimersByTime(2);
    expect(squareCalls(voice)).toBe(1);
  });

  it('applies the waveform in effect at a mid-timeline fromSec', () => {
    vi.mocked(scheduleAll).mockReturnValue(makeSchedule() as never);
    setKeyframes([
      { t: 0, waveform: 'sine' },
      { t: 10, waveform: 'square' },
      { t: 20, waveform: 'triangle' },
    ]);
    const voice = makeVoice(0);
    const adapter = createSchedulerAdapter();
    adapter.apply(voice as unknown as Voice, PRESET, 12, 0, { pulseAvailable: true });
    expect(voice.setWaveform).toHaveBeenLastCalledWith('square'); // last kf with t <= 12
  });

  it('passes through a missing worklet (pulseAvailable=false) without throwing', () => {
    vi.mocked(scheduleAll).mockReturnValue(makeSchedule() as never);
    setKeyframes([{ t: 0, waveform: 'sine' }]);
    const voice = makeVoice(0);
    const adapter = createSchedulerAdapter();
    expect(() => adapter.apply(voice as unknown as Voice, PRESET, 0, 0, { pulseAvailable: false })).not.toThrow();
  });
});

describe('scheduler adapter — cancel', () => {
  it('stops(now) + disposes the schedule, clears timers, and leaves the voice running', () => {
    const schedule = makeSchedule();
    vi.mocked(scheduleAll).mockReturnValue(schedule as never);
    setKeyframes([
      { t: 0, waveform: 'sine' },
      { t: 10, waveform: 'square' },
    ]);
    const voice = makeVoice(3);
    const adapter = createSchedulerAdapter();
    adapter.apply(voice as unknown as Voice, PRESET, 0, 0, { pulseAvailable: true });

    adapter.cancel(voice as unknown as Voice);
    expect(schedule.stop).toHaveBeenCalledWith(3); // stop(ctx.currentTime) — the bug-fix step
    expect(schedule.dispose).toHaveBeenCalledTimes(1);
    expect(voice.start).not.toHaveBeenCalled();
    expect(voice.stop).not.toHaveBeenCalled(); // oscillators keep running for seek reuse

    // the pending later-keyframe timer was cleared
    vi.advanceTimersByTime(60_000);
    expect(squareCalls(voice)).toBe(0);
  });

  it('cancel on an unknown voice is a no-op', () => {
    const adapter = createSchedulerAdapter();
    const voice = makeVoice(0);
    expect(() => adapter.cancel(voice as unknown as Voice)).not.toThrow();
  });

  it('re-apply after cancel builds a fresh schedule', () => {
    vi.mocked(scheduleAll).mockReturnValue(makeSchedule() as never);
    setKeyframes([{ t: 0, waveform: 'sine' }]);
    const voice = makeVoice(0);
    const adapter = createSchedulerAdapter();
    adapter.apply(voice as unknown as Voice, PRESET, 0, 0, { pulseAvailable: true });
    adapter.cancel(voice as unknown as Voice);
    adapter.apply(voice as unknown as Voice, PRESET, 0, 0, { pulseAvailable: true });
    expect(scheduleAll).toHaveBeenCalledTimes(2);
  });

  it('does not leak waveform timers across apply/cancel cycles', () => {
    vi.mocked(scheduleAll).mockReturnValue(makeSchedule() as never);
    setKeyframes([
      { t: 0, waveform: 'sine' },
      { t: 10, waveform: 'square' },
    ]);
    const voice = makeVoice(0);
    const adapter = createSchedulerAdapter();
    for (let i = 0; i < 3; i++) {
      adapter.apply(voice as unknown as Voice, PRESET, 0, 0, { pulseAvailable: true });
      adapter.cancel(voice as unknown as Voice);
    }
    vi.advanceTimersByTime(60_000);
    expect(squareCalls(voice)).toBe(0); // every armed timer was cleared on cancel
  });
});

describe('scheduler adapter — retarget', () => {
  it('re-ramps in place via SessionSchedule.retarget and re-arms waveform timers from the current offset', () => {
    const schedule = makeSchedule();
    vi.mocked(scheduleAll).mockReturnValue(schedule as never);
    setKeyframes([
      { t: 0, waveform: 'sine' },
      { t: 10, waveform: 'square' },
    ]);
    const voice = makeVoice(0);
    const adapter = createSchedulerAdapter();
    adapter.apply(voice as unknown as Voice, PRESET, 0, 0, { pulseAvailable: true });

    // Advance the audio clock to 4 s, then a live edit retargets at the same position.
    voice.ctx.currentTime = 4;
    const edited = createDefaultPreset();
    adapter.retarget(voice as unknown as Voice, edited, 4);

    expect(schedule.retarget).toHaveBeenCalledWith(edited, 4);
    // nowSec = 0 + (4 − 0) = 4 → 'sine' is still in effect; re-armed timer for t=10 fires
    // at (entry.atCtxTime 0 + 10 − entry.fromSec 0 − now 4) * 1000 = 6000 ms.
    vi.advanceTimersByTime(6000);
    expect(squareCalls(voice)).toBe(1);
    vi.advanceTimersByTime(60_000);
    expect(squareCalls(voice)).toBe(1); // the original apply timer was cleared (no double fire)
    expect(voice.start).not.toHaveBeenCalled();
    expect(voice.stop).not.toHaveBeenCalled();
  });

  it('retarget on an unknown voice is a no-op', () => {
    const adapter = createSchedulerAdapter();
    const voice = makeVoice(0);
    expect(() => adapter.retarget(voice as unknown as Voice, PRESET, 0)).not.toThrow();
  });
});
