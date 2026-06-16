// Pure display formatters. No state, no DOM, no engine access — given a number/epoch
// they return the string the UI shows. Every one renders SAFELY on non-finite input
// (never "NaN"/"Infinity" in the UI) per the controls/edge-cases (B3) contract.

/** Seconds → clock string: 754 → "12:34", 0 → "0:00", 3661 → "1:01:01". Non-finite or
 *  negative inputs clamp to 0 (no meaningful negative time on the playhead). */
export function formatClock(sec: number): string {
  let s = Number.isFinite(sec) && sec > 0 ? Math.floor(sec) : 0;
  const h = Math.floor(s / 3600);
  s -= h * 3600;
  const m = Math.floor(s / 60);
  s -= m * 60;
  const pad = (n: number): string => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

/** Parse "ss" / "mm:ss" / "h:mm:ss" → seconds, or null if any segment is non-numeric or
 *  there are more than three segments. Empty/whitespace returns null. Shared by the
 *  duration field and the editor's per-node time field so both accept the same syntax. */
export function parseClock(text: string): number | null {
  const trimmed = text.trim();
  if (trimmed === '') return null;
  const parts = trimmed.split(':').map((p) => p.trim());
  if (parts.length > 3) return null;
  let total = 0;
  for (const part of parts) {
    if (part === '' || !/^\d+(\.\d+)?$/.test(part)) return null;
    total = total * 60 + Number(part);
  }
  return Number.isFinite(total) ? total : null;
}

/** Hz with a fixed number of decimals: 8 → "8.0 Hz", (200, 0) → "200 Hz". Non-finite
 *  input renders as 0 rather than "NaN Hz". */
export function formatHz(hz: number, decimals = 1): string {
  const v = Number.isFinite(hz) ? hz : 0;
  return `${v.toFixed(decimals)} Hz`;
}

/** Unit interval → percent: 0.8 → "80 %". Non-finite input renders as 0. */
export function formatPercent(unit01: number): string {
  const v = Number.isFinite(unit01) ? unit01 : 0;
  return `${Math.round(v * 100)} %`;
}

/** Stereo pan −1..+1 → "L", "L 50%", "Center", "R 50%", "R". Non-finite renders as Center. */
export function formatPan(v: number): string {
  if (!Number.isFinite(v) || v === 0) return 'Center';
  const pct = Math.round(Math.abs(v) * 100);
  if (v < 0) return pct === 100 ? 'L' : `L ${pct}%`;
  return pct === 100 ? 'R' : `R ${pct}%`;
}

/** Relative time from an epoch (ms): "just now", "2 minutes ago", "2 days ago". `now`
 *  defaults to Date.now() (read at call time so tests can pass a fixed clock). Future
 *  or non-finite timestamps render as "just now". */
export function formatAgo(epochMs: number, now: number = Date.now()): string {
  if (!Number.isFinite(epochMs) || !Number.isFinite(now)) return 'just now';
  const secs = Math.floor((now - epochMs) / 1000);
  if (secs < 60) return 'just now';
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins} minute${mins === 1 ? '' : 's'} ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}
