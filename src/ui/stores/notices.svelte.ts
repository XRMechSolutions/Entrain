// notices.svelte.ts — the cross-cutting banner queue (NoticeStore) and the small
// UI-chrome store (UiStore: tab / breakpoint / headphone reminder / scrubbing flag).
// Both are Svelte-5 runes stores: factory functions returning $state-backed getters +
// methods, constructed once in the composition root and unit-testable in isolation.
//
// The Notice→severity/message/dedupe mapping for transport conditions follows
// design.md §10. The Resume *action* on a CONTEXT_INTERRUPTED banner is attached by the
// playback store (which holds play()), since createNoticeStore() takes no deps.

import { NOTICE_MAX_VISIBLE, WARNING_AUTODISMISS_MS, WIDE_BREAKPOINT_PX } from '../lib/constants';
import type { TransportNotice } from '../../engine/transport';

// ---------------------------------------------------------------------------
// Notice store
// ---------------------------------------------------------------------------

export type NoticeSeverity = 'error' | 'warning' | 'info';

export interface NoticeAction {
  readonly label: string;
  readonly run: () => void;
}

export interface Notice {
  readonly id: string;
  readonly severity: NoticeSeverity;
  readonly message: string;
  readonly action?: NoticeAction;
  readonly autoDismissMs?: number;
  readonly dedupeKey?: string;
}

export interface NoticeStore {
  readonly items: ReadonlyArray<Notice>;
  push(n: Omit<Notice, 'id'>): string;
  dismiss(id: string): void;
  clear(): void;
  fromTransport(n: TransportNotice, severity: 'error' | 'warning'): void;
}

/** Resolve the effective auto-dismiss delay. An explicit positive `autoDismissMs`
 *  wins; an explicit 0/negative means "persistent". Otherwise errors are persistent
 *  and warnings/info default to WARNING_AUTODISMISS_MS (design §10). */
function resolveDismiss(n: Omit<Notice, 'id'>): number | undefined {
  if (n.autoDismissMs !== undefined) return n.autoDismissMs > 0 ? n.autoDismissMs : undefined;
  return n.severity === 'error' ? undefined : WARNING_AUTODISMISS_MS;
}

export function createNoticeStore(): NoticeStore {
  const items = $state<Notice[]>([]);
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  let seq = 0;

  function clearTimer(id: string): void {
    const t = timers.get(id);
    if (t !== undefined) {
      clearTimeout(t);
      timers.delete(id);
    }
  }

  function removeById(id: string): void {
    const idx = items.findIndex((i) => i.id === id);
    if (idx !== -1) items.splice(idx, 1);
    clearTimer(id);
  }

  function armDismiss(notice: Notice, ms: number | undefined): void {
    if (ms !== undefined && ms > 0) {
      timers.set(
        notice.id,
        setTimeout(() => removeById(notice.id), ms),
      );
    }
  }

  function enforceCap(): void {
    while (items.length > NOTICE_MAX_VISIBLE) {
      // Prefer dropping the oldest non-error; only fall back to an error if all are errors.
      let idx = items.findIndex((i) => i.severity !== 'error');
      if (idx === -1) idx = 0;
      removeById(items[idx].id);
    }
  }

  function push(n: Omit<Notice, 'id'>): string {
    const id = `n${++seq}`;
    const ms = resolveDismiss(n);
    const notice: Notice = {
      id,
      severity: n.severity,
      message: n.message,
      ...(n.action ? { action: n.action } : {}),
      ...(n.dedupeKey ? { dedupeKey: n.dedupeKey } : {}),
      ...(ms !== undefined ? { autoDismissMs: ms } : {}),
    };

    if (n.dedupeKey) {
      const idx = items.findIndex((i) => i.dedupeKey === n.dedupeKey);
      if (idx !== -1) {
        clearTimer(items[idx].id);
        items[idx] = notice; // replace in place, preserving stack position
        armDismiss(notice, ms);
        return id;
      }
    }

    items.push(notice);
    armDismiss(notice, ms);
    enforceCap();
    return id;
  }

  function fromTransport(n: TransportNotice, severity: 'error' | 'warning'): void {
    switch (n.code) {
      case 'WEB_AUDIO_UNSUPPORTED':
        push({ severity: 'error', message: "This browser can't synthesize audio, so playback is unavailable." });
        return;
      case 'SCHEDULE_FAILED':
        push({ severity: 'error', message: "Couldn't start the session." });
        return;
      case 'WORKLET_UNAVAILABLE':
        push({
          severity: 'warning',
          dedupeKey: 'worklet',
          message: "Isochronic and square pulse aren't available in this browser; other effects still play.",
        });
        return;
      case 'BACKGROUND_AUDIO_UNAVAILABLE':
        push({ severity: 'warning', message: 'Audio may stop when the screen turns off on this device.' });
        return;
      case 'CONTEXT_INTERRUPTED':
        push({ severity: 'warning', dedupeKey: 'ctx', autoDismissMs: 0, message: 'Audio was interrupted.' });
        return;
      case 'CONTEXT_RECOVERED':
        push({ severity: 'info', dedupeKey: 'ctx', message: 'Audio resumed.' });
        return;
      case 'WAKE_LOCK_UNSUPPORTED':
        push({ severity: 'warning', message: "Keeping the screen on isn't supported on this device." });
        return;
      case 'WAKE_LOCK_FAILED':
        push({ severity: 'warning', message: "Couldn't keep the screen on." });
        return;
      default:
        // Forward-compat: an unknown transport code surfaces with the raw message.
        push({ severity, message: n.message });
        return;
    }
  }

  return {
    get items() {
      return items;
    },
    push,
    dismiss: removeById,
    clear() {
      for (const id of timers.keys()) clearTimeout(timers.get(id)!);
      timers.clear();
      items.splice(0, items.length);
    },
    fromTransport,
  };
}

// ---------------------------------------------------------------------------
// UI store
// ---------------------------------------------------------------------------

export type Tab = 'player' | 'library' | 'editor'; // 'editor' is Phase 2 only

export interface UiStore {
  readonly tab: Tab;
  readonly isWide: boolean;
  readonly headphoneReminderSeen: boolean;
  readonly scrubbing: boolean;

  setTab(t: Tab): void;
  dismissHeadphoneReminder(): void;
  setScrubbing(on: boolean): void;
}

interface MediaQueryListLike {
  matches: boolean;
  addEventListener?(type: 'change', listener: (e: { matches: boolean }) => void): void;
  addListener?(listener: (e: { matches: boolean }) => void): void; // legacy Safari
}

function matchWide(): MediaQueryListLike | undefined {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return undefined;
  return window.matchMedia(`(min-width:${WIDE_BREAKPOINT_PX}px)`);
}

export function createUiStore(): UiStore {
  let tab = $state<Tab>('player');
  let headphoneReminderSeen = $state(false);
  let scrubbing = $state(false);

  const mql = matchWide();
  let isWide = $state(mql ? mql.matches : false);

  if (mql) {
    const onChange = (e: { matches: boolean }): void => {
      isWide = e.matches;
    };
    if (typeof mql.addEventListener === 'function') mql.addEventListener('change', onChange);
    else if (typeof mql.addListener === 'function') mql.addListener(onChange);
  }

  return {
    get tab() {
      return tab;
    },
    get isWide() {
      return isWide;
    },
    get headphoneReminderSeen() {
      return headphoneReminderSeen;
    },
    get scrubbing() {
      return scrubbing;
    },
    setTab(t: Tab) {
      tab = t;
    },
    dismissHeadphoneReminder() {
      headphoneReminderSeen = true;
    },
    setScrubbing(on: boolean) {
      scrubbing = on;
    },
  };
}
