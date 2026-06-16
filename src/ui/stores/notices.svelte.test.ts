import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TransportNotice, TransportNoticeCode } from '../../engine/transport';
import { WARNING_AUTODISMISS_MS } from '../lib/constants';
import { createNoticeStore, createUiStore } from './notices.svelte';

function tn(code: TransportNoticeCode): TransportNotice {
  return { code, message: `raw:${code}` };
}

describe('NoticeStore', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('push returns an id and renders the notice', () => {
    const store = createNoticeStore();
    const id = store.push({ severity: 'info', message: 'hello' });
    expect(typeof id).toBe('string');
    expect(store.items).toHaveLength(1);
    expect(store.items[0]).toMatchObject({ id, severity: 'info', message: 'hello' });
  });

  it('maps each transport code to the correct severity / message / dedupeKey', () => {
    const store = createNoticeStore();

    store.fromTransport(tn('WEB_AUDIO_UNSUPPORTED'), 'error');
    expect(store.items.at(-1)).toMatchObject({ severity: 'error' });
    expect(store.items.at(-1)?.autoDismissMs).toBeUndefined(); // errors persist

    store.fromTransport(tn('SCHEDULE_FAILED'), 'error');
    expect(store.items.at(-1)).toMatchObject({ severity: 'error', message: "Couldn't start the session." });

    store.clear();
    store.fromTransport(tn('WORKLET_UNAVAILABLE'), 'warning');
    expect(store.items.at(-1)).toMatchObject({ severity: 'warning', dedupeKey: 'worklet' });
    expect(store.items.at(-1)?.autoDismissMs).toBe(WARNING_AUTODISMISS_MS);

    store.fromTransport(tn('BACKGROUND_AUDIO_UNAVAILABLE'), 'warning');
    expect(store.items.at(-1)).toMatchObject({ severity: 'warning' });

    store.fromTransport(tn('WAKE_LOCK_UNSUPPORTED'), 'warning');
    expect(store.items.at(-1)).toMatchObject({ severity: 'warning' });
  });

  it('CONTEXT_INTERRUPTED is a persistent warning; CONTEXT_RECOVERED replaces it via dedupeKey "ctx"', () => {
    const store = createNoticeStore();
    store.fromTransport(tn('CONTEXT_INTERRUPTED'), 'warning');
    expect(store.items).toHaveLength(1);
    expect(store.items[0]).toMatchObject({ severity: 'warning', dedupeKey: 'ctx' });
    expect(store.items[0].autoDismissMs).toBeUndefined(); // persistent

    store.fromTransport(tn('CONTEXT_RECOVERED'), 'warning');
    expect(store.items).toHaveLength(1); // replaced, not stacked
    expect(store.items[0]).toMatchObject({ severity: 'info', dedupeKey: 'ctx', message: 'Audio resumed.' });
  });

  it('caps the stack at 3 and drops the oldest non-error first', () => {
    const store = createNoticeStore();
    store.push({ severity: 'error', message: 'E', autoDismissMs: 0 }); // persistent error, oldest
    const w1 = store.push({ severity: 'warning', message: 'W1' });
    store.push({ severity: 'warning', message: 'W2' });
    store.push({ severity: 'warning', message: 'W3' }); // 4th → drop oldest NON-error (W1)

    expect(store.items).toHaveLength(3);
    expect(store.items.find((i) => i.id === w1)).toBeUndefined();
    expect(store.items.some((i) => i.message === 'E')).toBe(true); // the error is retained
  });

  it('auto-dismisses warnings after WARNING_AUTODISMISS_MS while errors persist', () => {
    const store = createNoticeStore();
    store.fromTransport(tn('SCHEDULE_FAILED'), 'error'); // persistent
    store.fromTransport(tn('WORKLET_UNAVAILABLE'), 'warning'); // auto-dismiss

    expect(store.items).toHaveLength(2);
    vi.advanceTimersByTime(WARNING_AUTODISMISS_MS + 1);
    expect(store.items).toHaveLength(1);
    expect(store.items[0].severity).toBe('error');
  });

  it('dismiss(id) and clear() remove notices and their timers', () => {
    const store = createNoticeStore();
    const id = store.push({ severity: 'info', message: 'x' });
    store.dismiss(id);
    expect(store.items).toHaveLength(0);

    store.push({ severity: 'warning', message: 'a' });
    store.push({ severity: 'warning', message: 'b' });
    store.clear();
    expect(store.items).toHaveLength(0);
    vi.advanceTimersByTime(WARNING_AUTODISMISS_MS + 1); // no late timer fires after clear
    expect(store.items).toHaveLength(0);
  });
});

describe('UiStore', () => {
  function stubMatchMedia(initial: boolean) {
    let handler: ((e: { matches: boolean }) => void) | undefined;
    const mql = {
      matches: initial,
      media: '',
      addEventListener: (_t: 'change', h: (e: { matches: boolean }) => void) => {
        handler = h;
      },
      removeEventListener: () => {},
    };
    vi.stubGlobal('matchMedia', vi.fn().mockReturnValue(mql));
    return {
      fire(matches: boolean) {
        mql.matches = matches;
        handler?.({ matches });
      },
    };
  }

  afterEach(() => vi.unstubAllGlobals());

  it('isWide tracks matchMedia(720) changes', () => {
    const mm = stubMatchMedia(false);
    const ui = createUiStore();
    expect(ui.isWide).toBe(false);
    mm.fire(true);
    expect(ui.isWide).toBe(true);
    mm.fire(false);
    expect(ui.isWide).toBe(false);
  });

  it('headphoneReminderSeen starts false (re-shows once per app open) and dismisses', () => {
    stubMatchMedia(false);
    const ui = createUiStore();
    expect(ui.headphoneReminderSeen).toBe(false);
    ui.dismissHeadphoneReminder();
    expect(ui.headphoneReminderSeen).toBe(true);

    // A fresh store == a fresh app open → the reminder shows again (in-memory flag).
    const reopened = createUiStore();
    expect(reopened.headphoneReminderSeen).toBe(false);
  });

  it('setTab and setScrubbing update reactive state', () => {
    stubMatchMedia(false);
    const ui = createUiStore();
    expect(ui.tab).toBe('player');
    ui.setTab('library');
    expect(ui.tab).toBe('library');
    expect(ui.scrubbing).toBe(false);
    ui.setScrubbing(true);
    expect(ui.scrubbing).toBe(true);
  });
});
