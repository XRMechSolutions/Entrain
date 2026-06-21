import { describe, expect, it } from 'vitest';
import { formatAgo, formatBytes, formatClock, formatHz, formatPan, formatPercent } from './format';

describe('formatClock', () => {
  it('formats mm:ss (the canonical example)', () => {
    expect(formatClock(754)).toBe('12:34');
  });
  it('handles 0 and > 1h', () => {
    expect(formatClock(0)).toBe('0:00');
    expect(formatClock(3600)).toBe('1:00:00');
    expect(formatClock(3661)).toBe('1:01:01');
  });
  it('renders non-finite / negative safely as 0:00', () => {
    expect(formatClock(-5)).toBe('0:00');
    expect(formatClock(NaN)).toBe('0:00');
    expect(formatClock(Infinity)).toBe('0:00');
  });
});

describe('formatHz', () => {
  it('formats with one decimal by default', () => {
    expect(formatHz(8)).toBe('8.0 Hz');
  });
  it('honours an explicit decimals argument', () => {
    expect(formatHz(200, 0)).toBe('200 Hz');
  });
  it('renders non-finite safely (never "NaN Hz")', () => {
    expect(formatHz(NaN)).toBe('0.0 Hz');
    expect(formatHz(Infinity)).toBe('0.0 Hz');
  });
});

describe('formatPercent', () => {
  it('formats a unit interval as a percent', () => {
    expect(formatPercent(0.8)).toBe('80 %');
    expect(formatPercent(1)).toBe('100 %');
    expect(formatPercent(0)).toBe('0 %');
  });
  it('renders non-finite safely', () => {
    expect(formatPercent(NaN)).toBe('0 %');
  });
});

describe('formatPan', () => {
  it('shows Center at zero (the canonical example)', () => {
    expect(formatPan(0)).toBe('Center');
  });
  it('shows L / R at the extremes', () => {
    expect(formatPan(-1)).toBe('L');
    expect(formatPan(1)).toBe('R');
  });
  it('shows L/R with percentage for intermediate values', () => {
    expect(formatPan(-0.5)).toBe('L 50%');
    expect(formatPan(0.75)).toBe('R 75%');
  });
  it('renders non-finite safely as Center', () => {
    expect(formatPan(NaN)).toBe('Center');
    expect(formatPan(Infinity)).toBe('Center');
  });
});

describe('formatBytes (Phase-2, design §21)', () => {
  it('formats the canonical examples', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(683008)).toBe('667 KB');
    expect(formatBytes(1363149)).toBe('1.3 MB');
  });
  it('drops a trailing .0 (whole KB/MB show no decimal)', () => {
    expect(formatBytes(1024)).toBe('1 KB');
    expect(formatBytes(1024 * 1024)).toBe('1 MB');
  });
  it('renders 0 / negative / non-finite safely (never "NaN KB")', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(-100)).toBe('0 B');
    expect(formatBytes(NaN)).toBe('0 B');
    expect(formatBytes(Infinity)).toBe('0 B');
  });
});

describe('formatAgo', () => {
  const now = 1_700_000_000_000;
  it('says "just now" under a minute', () => {
    expect(formatAgo(now - 0, now)).toBe('just now');
    expect(formatAgo(now - 59_000, now)).toBe('just now');
  });
  it('pluralises minutes correctly at the boundary', () => {
    expect(formatAgo(now - 60_000, now)).toBe('1 minute ago');
    expect(formatAgo(now - 120_000, now)).toBe('2 minutes ago');
  });
  it('reports hours and days', () => {
    expect(formatAgo(now - 2 * 3_600_000, now)).toBe('2 hours ago');
    expect(formatAgo(now - 2 * 86_400_000, now)).toBe('2 days ago');
  });
  it('renders future / non-finite timestamps safely', () => {
    expect(formatAgo(now + 5000, now)).toBe('just now');
    expect(formatAgo(NaN, now)).toBe('just now');
  });
});
