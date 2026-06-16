// scheduler-adapter.ts — the ONE cross-module contract the UI produces: it adapts
// automation's scheduling API (scheduleAll / SessionSchedule / waveformKeyframes) to the
// transport.SessionScheduler shape { apply, retarget, cancel }. This is the registered
// stub "SessionScheduler adapter passed to createTransport — resolves in automation + ui
// integration". See design.md §11.
//
// Responsibilities (decided in §11 so this file makes no judgment calls):
//  - apply:    build a fresh SessionSchedule and apply the waveform timeline. The three
//              AudioParam lanes are scheduled by automation; WAVEFORM is not an AudioParam,
//              so the adapter sets the one in effect at fromSec immediately and arms a
//              setTimeout per later keyframe. The schedule + mapping are stored per Voice.
//  - retarget: re-ramp the base curves in place (SessionSchedule.retarget) and re-arm the
//              waveform timers from the CURRENT offset, keeping the original session↔ctx
//              mapping (the position is unchanged).
//  - cancel:   clear the waveform timers, stop(now) + dispose() the schedule WITHOUT
//              stopping the oscillators (so transport's seek can reuse the running voice).
// It NEVER calls voice.start / voice.stop — transport owns the source lifecycle.

import { scheduleAll, waveformKeyframes, type SessionSchedule } from '../../engine/automation';
import type { Voice } from '../../engine/audio-engine';
import type { Preset } from '../../engine/session-model';
import type { SessionScheduler } from '../../engine/transport';

interface Entry {
  schedule: SessionSchedule;
  waveformTimers: ReturnType<typeof setTimeout>[];
  /** session second mapped to atCtxTime (the start offset of this schedule). */
  fromSec: number;
  /** ctx-clock time mapped to fromSec. */
  atCtxTime: number;
}

export function createSchedulerAdapter(): SessionScheduler {
  const entries = new WeakMap<Voice, Entry>();

  function clearTimers(entry: Entry): void {
    for (const t of entry.waveformTimers) clearTimeout(t);
    entry.waveformTimers = [];
  }

  /** Apply the waveform in effect at `effectiveSec` immediately and arm a timer per later
   *  keyframe. The session↔ctx mapping (`mapFromSec` → `mapCtxTime`) is the schedule's
   *  ORIGINAL anchor, unchanged across retarget — so a keyframe at session time kf.t fires
   *  at ctx time (mapCtxTime + kf.t − mapFromSec). */
  function armWaveforms(
    voice: Voice,
    preset: Preset,
    effectiveSec: number,
    mapCtxTime: number,
    mapFromSec: number,
    entry: Entry,
  ): void {
    const kfs = waveformKeyframes(preset); // always includes { t:0, ... }
    const now = voice.ctx.currentTime;

    let current = kfs[0].waveform;
    for (const kf of kfs) {
      if (kf.t <= effectiveSec) current = kf.waveform;
    }
    voice.setWaveform(current);

    for (const kf of kfs) {
      if (kf.t > effectiveSec) {
        const delayMs = Math.max(0, (mapCtxTime + kf.t - mapFromSec - now) * 1000);
        entry.waveformTimers.push(setTimeout(() => voice.setWaveform(kf.waveform), delayMs));
      }
    }
  }

  return {
    apply(voice, preset, fromSec, atCtxTime, _opts) {
      // pulseAvailable (_opts) is advisory: automation already catches a missing worklet
      // and degrades the lane, and scheduleAll never throws on it — so the adapter just
      // passes through (design §11.3).
      const schedule = scheduleAll(preset, voice, { startTime: atCtxTime, startOffsetSec: fromSec });
      const entry: Entry = { schedule, waveformTimers: [], fromSec, atCtxTime };
      armWaveforms(voice, preset, fromSec, atCtxTime, fromSec, entry);
      entries.set(voice, entry);
    },

    retarget(voice, preset, atCtxTime) {
      const entry = entries.get(voice);
      if (!entry) return;
      // Base carrier/beat/volume curves re-ramp in place, keeping each running modulator
      // node (phase continuity) — automation handles all of that.
      entry.schedule.retarget(preset, atCtxTime);

      // Waveform is not covered by SessionSchedule.retarget; re-apply it from the current
      // offset using the schedule's UNCHANGED original mapping.
      const nowSec = entry.fromSec + (voice.ctx.currentTime - entry.atCtxTime);
      clearTimers(entry);
      armWaveforms(voice, preset, nowSec, entry.atCtxTime, entry.fromSec, entry);
    },

    cancel(voice) {
      const entry = entries.get(voice);
      if (!entry) return;
      clearTimers(entry);
      entry.schedule.stop(voice.ctx.currentTime); // cancel queued base ramps + tear down modulators
      entry.schedule.dispose(); // disconnect automation-owned nodes; restore engine mod gains
      entries.delete(voice);
      // Deliberately NO voice.stop() — transport reuses the running voice for seek/resume.
    },
  };
}
