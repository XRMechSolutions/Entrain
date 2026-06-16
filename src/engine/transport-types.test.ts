import { describe, it, expect } from 'vitest';
import {
  TransportError,
  TRANSPORT_DEFAULTS,
  type TransportErrorCode,
  type TransportState,
  type BackgroundAudioMode,
  type TransportNoticeCode,
  type TransportNotice,
  type TickEvent,
  type TransportEventMap,
  type SessionScheduler,
  type TransportOptions,
  type Transport,
} from './transport-types';

// =====================================================================================
// Task 1 — public types, TransportError, event map, §11 constants table
// =====================================================================================

describe('TransportError', () => {
  it('should carry code + message and be an instanceof Error', () => {
    const err = new TransportError('NO_PRESET', 'play() called before load(preset)');
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(TransportError);
    expect(err.code).toBe('NO_PRESET');
    expect(err.message).toBe('play() called before load(preset)');
    expect(err.name).toBe('TransportError');
  });

  it('should default the message to the code when omitted', () => {
    const err = new TransportError('DISPOSED');
    expect(err.message).toBe('DISPOSED');
  });

  it('should expose all three error codes', () => {
    const codes: TransportErrorCode[] = ['NO_PRESET', 'INVALID_SEEK', 'DISPOSED'];
    for (const code of codes) {
      expect(new TransportError(code).code).toBe(code);
    }
  });
});

describe('TRANSPORT_DEFAULTS (§11 constants — single source of truth)', () => {
  it('should equal the design.md §11 table values exactly', () => {
    expect(TRANSPORT_DEFAULTS.fadeInSec).toBe(0.5);
    expect(TRANSPORT_DEFAULTS.fadeOutSec).toBe(0.5);
    expect(TRANSPORT_DEFAULTS.pauseFadeSec).toBe(0.02);
    expect(TRANSPORT_DEFAULTS.seekFadeSec).toBe(0.02);
    expect(TRANSPORT_DEFAULTS.trimRampSec).toBe(0.01);
    expect(TRANSPORT_DEFAULTS.startLeadSec).toBe(0.02);
    expect(TRANSPORT_DEFAULTS.mediaSessionPositionThrottleMs).toBe(1000);
    expect(TRANSPORT_DEFAULTS.minSilentFileSec).toBe(5);
  });

  it('should default backgroundAudioMode to mediastream (the D-018 primary mechanism)', () => {
    expect(TRANSPORT_DEFAULTS.backgroundAudioMode).toBe('mediastream');
  });

  it('should keep the silent-file minimum at the ≥5 s audio-focus rule', () => {
    expect(TRANSPORT_DEFAULTS.minSilentFileSec).toBeGreaterThanOrEqual(5);
  });
});

describe('type shapes (compile-time contract against interfaces.md)', () => {
  it('should accept the documented union/interface members', () => {
    // These assignments fail to compile if the exported shapes drift from interfaces.md.
    const states: TransportState[] = ['idle', 'playing', 'paused', 'interrupted', 'stopped'];
    const modes: BackgroundAudioMode[] = ['mediastream', 'silent-file', 'none'];
    const noticeCodes: TransportNoticeCode[] = [
      'WEB_AUDIO_UNSUPPORTED',
      'SCHEDULE_FAILED',
      'WORKLET_UNAVAILABLE',
      'BACKGROUND_AUDIO_UNAVAILABLE',
      'CONTEXT_INTERRUPTED',
      'CONTEXT_RECOVERED',
      'WAKE_LOCK_UNSUPPORTED',
      'WAKE_LOCK_FAILED',
    ];
    const notice: TransportNotice = { code: 'WORKLET_UNAVAILABLE', message: 'x' };
    const tick: TickEvent = { positionSec: 1, durationSec: 2, state: 'playing' };
    const evt: TransportEventMap['statechange'] = { state: 'paused' };

    expect(states).toHaveLength(5);
    expect(modes).toHaveLength(3);
    expect(noticeCodes).toHaveLength(8);
    expect(notice.code).toBe('WORKLET_UNAVAILABLE');
    expect(tick.state).toBe('playing');
    expect(evt.state).toBe('paused');
  });

  it('should describe a SessionScheduler with apply / retarget / cancel', () => {
    const scheduler: SessionScheduler = {
      apply: () => {},
      retarget: () => {},
      cancel: () => {},
    };
    expect(typeof scheduler.apply).toBe('function');
    expect(typeof scheduler.retarget).toBe('function');
    expect(typeof scheduler.cancel).toBe('function');
  });

  it('should require only scheduler on TransportOptions', () => {
    const opts: TransportOptions = { scheduler: { apply: () => {}, retarget: () => {}, cancel: () => {} } };
    expect(opts.scheduler).toBeDefined();
    // Transport interface is structurally referenced so it stays exported/used.
    const ref: ((t: Transport) => TransportState) = (t) => t.state;
    expect(typeof ref).toBe('function');
  });
});
