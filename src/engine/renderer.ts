// renderer — Layer-1 offline bounce (Web Audio + lamejs/WAV encoding).
//
// Produces a finished audio file from a validated `Preset` by REPLAYING the byte-identical
// live graph — voice + mixer + layers + duck — against an `OfflineAudioContext`, then
// encoding the rendered `AudioBuffer` to MP3 (lamejs, default) or WAV (hand-rolled,
// lossless). It is a thin composition root: it owns context creation, clip pre-decode, the
// SAME `scheduleAll`/`scheduleLayers` calls the transport makes (at offline `t0 = 0`), the
// master 0→trim fade-in + trim→0 end fade-out, and encoding — and NOTHING about the sound.
//
// INVARIANTS it honors (arch §5/§6):
//   - It NEVER imports `transport` (enforced by renderer.test.ts — accidental coupling
//     would drag rAF / MediaSession / createMediaStreamDestination into the render path and
//     break offline reuse). There is intentionally no `from './transport'` import below.
//   - The same calls transport makes: scheduleAll(preset, voice, {startTime:0}) and
//     scheduleLayers(mixer, nodes, layers, {t0:0, startOffsetSec:0}).
//   - Voice in `{master:'bus'}` mode (unity passthrough; no double-attenuation) — the
//     mixer's single-input master owns the session fade.
//   - Single-writer params (D-019): the duck is scheduled BY scheduleLayers; the renderer
//     never touches mixer.duckParam. The master fade is written only via the controller +
//     the closing trim→0 leg on mixer.masterParam.
//   - No-click LINEAR ramps only (D-008): never exponential-to-0, never setValueCurve.
//   - Only the pulse worklet is registered (the Shepard lift is live-only, never rendered).
//
// See .dev/planning/modules/renderer/{design,interfaces,edge-cases,dependencies}.md and
// .dev/planning/phase2-audio-architecture.md §5/§6 (normative).

import { Mp3Encoder } from 'lamejs';

import {
  voiceView,
  type Preset,
  type Layer,
  type Voice as PresetVoice,
  type Waveform,
} from './session-model';
import { createVoice, registerPulseWorklet, type Voice } from './audio-engine';
import { createMixer, type Mixer } from './mixer';
import { createLayerNode, type LayerNode } from './layer-engine';
import { scheduleLayers, type LayerSchedule } from './layer-scheduler';
import { scheduleAll, waveformKeyframes } from './automation';
import { createMasterGainController } from './transport-master-gain';
import { getBlob } from './clip-library';
// NOTE: there is intentionally NO `import … from './transport'` (or './transport-types').
// renderer.test.ts asserts the source of this file contains no such import.

// ===========================================================================
// 1. Public types (interfaces.md §2/§3)
// ===========================================================================

/** Output container choices (D-037). MP3 = default (universal mobile playback, lamejs);
 *  WAV = lossless option, hand-rolled, no dependency. */
export type RenderFormat = 'mp3' | 'wav';

/** Coarse phase discriminator for progress. `startRendering()` has no native progress
 *  (design §5), so `fraction` is omitted during 'rendering'. */
export type RenderPhase = 'decoding' | 'rendering' | 'encoding' | 'done';

export interface RenderProgress {
  phase: RenderPhase;
  /** 0..1 where defined (decoding = clips done/total; encoding = samples done/total;
   *  done = 1). Omitted (undefined) during 'rendering' — show an indeterminate spinner. */
  fraction?: number;
}

export interface RenderOptions {
  /** Output sample rate (Hz). Default 44100. Must be finite and in [8000, 192000];
   *  out-of-range rejects RenderError('INVALID_OPTION'). */
  sampleRate?: number;
  /** Best-effort progress callback (design §5/§8). Wrapped in try/catch — a throwing
   *  handler never aborts the render. */
  onProgress?: (p: RenderProgress) => void;
  /** Cooperative cancellation (design §9). Honored at phase boundaries; a render already
   *  in flight finishes before the cancel is observed. */
  signal?: AbortSignal;
  /** Notices (e.g. missing clipIds rendered as silence, waveform degrade) collected here.
   *  A UI may surface "N clips were unavailable"; never an error. */
  onNotice?: (notice: string) => void;
}

/** Extra knobs for encoding; all optional, sensible defaults. */
export interface EncodeOptions {
  /** MP3 constant bitrate in kbps. Default 192. Ignored for WAV. */
  mp3Kbps?: number;
}

/** The descriptor renderToFile returns; the UI owns the actual save/share. */
export interface RenderedFile {
  blob: Blob;
  filename: string; // sanitized from preset.name + extension, e.g. 'guided-drift.mp3'
  mime: string; // 'audio/mpeg' | 'audio/wav'
}

// ===========================================================================
// 2. Error type (interfaces.md §3)
// ===========================================================================

export type RenderErrorCode =
  | 'INVALID_OPTION' // non-finite / out-of-range sampleRate or mp3Kbps, or an invalid format
  | 'WORKLET' // registerPulseWorklet rejected offline (design §3 step 3)
  | 'DECODE_FAILED' // a present clip blob would not decode (distinct from a *missing* clip = silence)
  | 'RENDER_FAILED' // OfflineAudioContext construction / startRendering / OOM-guard
  | 'ENCODE_FAILED' // lamejs / WAV encoding threw
  | 'CANCELLED' // aborted via options.signal (design §9)
  | 'UNSUPPORTED'; // no OfflineAudioContext in this environment

export class RenderError extends Error {
  override readonly name = 'RenderError';
  readonly code: RenderErrorCode;
  readonly cause?: unknown;

  constructor(code: RenderErrorCode, message?: string, cause?: unknown) {
    super(message ?? code);
    this.code = code;
    if (cause !== undefined) this.cause = cause;
    // Restore the prototype chain so `instanceof RenderError` works after transpilation
    // to ES2015+ targets (mirrors the other engine error classes).
    Object.setPrototypeOf(this, RenderError.prototype);
  }
}

// ===========================================================================
// 3. Constants (interfaces.md §5)
// ===========================================================================

export const RENDER_DEFAULTS = {
  sampleRate: 44100, // universal MP3/WAV playback rate (design §3 step 1)
  fadeInSec: 1.5, // 0→trim click-free master fade-in (D-008)
  fadeOutSec: 3, // trim→0 click-free end fade-out
  mp3Kbps: 192, // transparent stereo CBR for ambient/binaural (design §4.1)
} as const;

const SAMPLE_RATE_MIN = 8000;
const SAMPLE_RATE_MAX = 192000;
const MP3_KBPS_MIN = 8;
const MP3_KBPS_MAX = 320;

/** MPEG frame size lamejs expects (one MP3 frame = 1152 samples/channel). Also the
 *  encode chunk granularity for progress + abort checks (design §4.1 / §5). */
const MP3_FRAME = 1152;

/** Pre-flight OOM ceiling (edge-cases §3). Sized so the float render buffer (2 ch × 4 B)
 *  plus the Int16 encode buffer stay within a few hundred MB. 2 h @ 44.1 kHz stereo =
 *  ~635 M frames × 8 B float ≈ 2.5 GB — too big. 30 min @ 44.1 kHz = ~79.4 M frames;
 *  at 8 B float (~635 MB) + Int16 encode (~318 MB) that is the practical single-pass
 *  ceiling, so cap there. Chunked rendering is a deliberate future extension. */
export const MAX_RENDER_FRAMES = 80_000_000;

// ===========================================================================
// 4. Internal helpers — sample/encoder primitives
// ===========================================================================

/** Float→Int16 with clamp to [-1, 1] then scale by 32767. A stray NaN/±Inf becomes 0
 *  (never a garbage 16-bit value — edge-cases §4). One sample. */
function floatToInt16(sample: number): number {
  if (!Number.isFinite(sample)) return 0;
  const clamped = sample < -1 ? -1 : sample > 1 ? 1 : sample;
  return Math.round(clamped * 32767);
}

/** Read a channel's float PCM into a clamped Int16Array (the encoder input).
 *  Channel index out of range (mono buffer) reuses channel 0 so output stays stereo. */
function channelToInt16(buffer: AudioBuffer, channel: number): Int16Array {
  const ch = channel < buffer.numberOfChannels ? channel : 0;
  const data = buffer.getChannelData(ch);
  const out = new Int16Array(data.length);
  for (let i = 0; i < data.length; i++) out[i] = floatToInt16(data[i]);
  return out;
}

/** Throw RenderError('CANCELLED') if the signal is aborted. */
function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new RenderError('CANCELLED', 'render cancelled');
}

/** Best-effort progress emit, wrapped so a throwing UI handler never aborts a render
 *  (design §8). */
function emit(
  onProgress: ((p: RenderProgress) => void) | undefined,
  p: RenderProgress,
): void {
  if (!onProgress) return;
  try {
    onProgress(p);
  } catch {
    // A bad progress handler must not waste an expensive render.
  }
}

function notify(onNotice: ((n: string) => void) | undefined, message: string): void {
  if (!onNotice) return;
  try {
    onNotice(message);
  } catch {
    // Notices are advisory only.
  }
}

/** Clamp a per-voice trim into [0, 1] (NaN → 0). Local copy — the renderer must NOT import
 *  from transport (arch §5/§6); transport keeps its own identical clamp01. */
function clamp01(v: number): number {
  return !Number.isFinite(v) ? 0 : v < 0 ? 0 : v > 1 ? 1 : v;
}

// ===========================================================================
// 5. WAV encoder (hand-rolled, no dependency — design §4.2)
// ===========================================================================

const WAV_HEADER_BYTES = 44;

/** Build a canonical 16-bit PCM WAV `Blob` (44-byte RIFF/WAVE/fmt /data header +
 *  interleaved 16-bit LE PCM) over a `DataView`. Stereo always (the engine is inherently
 *  stereo). Bit-exact to the rendered buffer quantized to CD depth = the lossless path. */
function encodeWav(buffer: AudioBuffer): Blob {
  const numChannels = 2;
  const sampleRate = buffer.sampleRate;
  const frames = buffer.length;
  const left = channelToInt16(buffer, 0);
  const right = channelToInt16(buffer, 1);

  const bytesPerSample = 2;
  const blockAlign = numChannels * bytesPerSample;
  const dataBytes = frames * blockAlign;
  const totalBytes = WAV_HEADER_BYTES + dataBytes;

  const ab = new ArrayBuffer(totalBytes);
  const view = new DataView(ab);

  const writeAscii = (offset: number, str: string): void => {
    for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
  };

  // RIFF chunk descriptor.
  writeAscii(0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true); // ChunkSize = 36 + Subchunk2Size
  writeAscii(8, 'WAVE');
  // fmt sub-chunk.
  writeAscii(12, 'fmt ');
  view.setUint32(16, 16, true); // Subchunk1Size = 16 for PCM
  view.setUint16(20, 1, true); // AudioFormat = 1 (PCM)
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true); // ByteRate
  view.setUint16(32, blockAlign, true); // BlockAlign
  view.setUint16(34, 16, true); // BitsPerSample
  // data sub-chunk.
  writeAscii(36, 'data');
  view.setUint32(40, dataBytes, true); // Subchunk2Size

  // Interleaved 16-bit LE PCM (L, R, L, R, …).
  let offset = WAV_HEADER_BYTES;
  for (let i = 0; i < frames; i++) {
    view.setInt16(offset, left[i], true);
    offset += 2;
    view.setInt16(offset, right[i], true);
    offset += 2;
  }

  return new Blob([ab], { type: 'audio/wav' });
}

// ===========================================================================
// 6. MP3 encoder (lamejs — design §4.1)
// ===========================================================================

/** Encode the stereo buffer to an `audio/mpeg` `Blob` via lamejs, in 1152-sample frames
 *  so the loop reports `phase:'encoding'` fraction and checks abort between chunks. The
 *  Blob is built ONLY from the complete chunk list after a successful flush() — never a
 *  truncated blob (edge-cases §4). */
function encodeMp3(
  buffer: AudioBuffer,
  kbps: number,
  onProgress: ((p: RenderProgress) => void) | undefined,
  signal: AbortSignal | undefined,
): Blob {
  const chunks: Uint8Array[] = [];
  try {
    const left = channelToInt16(buffer, 0);
    const right = channelToInt16(buffer, 1);
    const total = left.length;
    const encoder = new Mp3Encoder(2, buffer.sampleRate, kbps);
    for (let i = 0; i < total; i += MP3_FRAME) {
      throwIfAborted(signal);
      const end = Math.min(i + MP3_FRAME, total);
      const lChunk = left.subarray(i, end);
      const rChunk = right.subarray(i, end);
      const mp3buf = encoder.encodeBuffer(lChunk, rChunk);
      if (mp3buf.length > 0) chunks.push(new Uint8Array(mp3buf));
      emit(onProgress, { phase: 'encoding', fraction: Math.min(1, end / total) });
    }
    const tail = encoder.flush();
    if (tail.length > 0) chunks.push(new Uint8Array(tail));
  } catch (err) {
    if (err instanceof RenderError) throw err; // CANCELLED from throwIfAborted
    throw new RenderError('ENCODE_FAILED', 'lamejs encoding failed', err);
  }

  // Only assemble the Blob from the COMPLETE chunk list after a successful flush().
  return new Blob(chunks as BlobPart[], { type: 'audio/mpeg' });
}

// ===========================================================================
// 7. encodeBuffer — public encoder (interfaces.md §4)
// ===========================================================================

function validateFormat(format: RenderFormat): void {
  if (format !== 'mp3' && format !== 'wav') {
    throw new RenderError('INVALID_OPTION', `unknown format: ${String(format)}`);
  }
}

function resolveKbps(mp3Kbps: number | undefined): number {
  const kbps = mp3Kbps ?? RENDER_DEFAULTS.mp3Kbps;
  if (!Number.isFinite(kbps) || kbps < MP3_KBPS_MIN || kbps > MP3_KBPS_MAX) {
    throw new RenderError(
      'INVALID_OPTION',
      `mp3Kbps must be finite in [${MP3_KBPS_MIN}, ${MP3_KBPS_MAX}]`,
    );
  }
  return kbps;
}

/** Encode an already-rendered buffer (e.g. the caller kept the AudioBuffer from
 *  renderToBuffer). Pure CPU; honors options.signal between chunks. Rejects
 *  INVALID_OPTION for a bad format/bitrate, ENCODE_FAILED on an encoder throw,
 *  CANCELLED on abort. */
export function encodeBuffer(
  buffer: AudioBuffer,
  format: RenderFormat,
  options?: EncodeOptions & {
    onProgress?: (p: RenderProgress) => void;
    signal?: AbortSignal;
  },
): Promise<Blob> {
  // Validation runs synchronously but the contract is a rejected promise (never a throw).
  return Promise.resolve().then(() => {
    validateFormat(format);
    throwIfAborted(options?.signal);
    if (format === 'wav') {
      try {
        const blob = encodeWav(buffer);
        emit(options?.onProgress, { phase: 'encoding', fraction: 1 });
        return blob;
      } catch (cause) {
        throw new RenderError('ENCODE_FAILED', 'WAV encoding failed', cause);
      }
    }
    const kbps = resolveKbps(options?.mp3Kbps);
    return encodeMp3(buffer, kbps, options?.onProgress, options?.signal);
  });
}

// ===========================================================================
// 8. renderToBuffer — offline compose + pre-decode + schedule (interfaces.md §4)
// ===========================================================================

/** Resolve and validate the output sample rate. */
function resolveSampleRate(sampleRate: number | undefined): number {
  const rate = sampleRate ?? RENDER_DEFAULTS.sampleRate;
  if (!Number.isFinite(rate) || rate < SAMPLE_RATE_MIN || rate > SAMPLE_RATE_MAX) {
    throw new RenderError(
      'INVALID_OPTION',
      `sampleRate must be finite in [${SAMPLE_RATE_MIN}, ${SAMPLE_RATE_MAX}]`,
    );
  }
  return rate;
}

/** Clamp the fades so fadeInSec + fadeOutSec ≤ durationSec for very short presets
 *  (edge-cases §6 — proportionally shrink both; never a divide-by-zero / overlap). */
function resolveFades(durationSec: number): { fadeInSec: number; fadeOutSec: number } {
  const { fadeInSec, fadeOutSec } = RENDER_DEFAULTS;
  const sum = fadeInSec + fadeOutSec;
  if (durationSec >= sum) return { fadeInSec, fadeOutSec };
  if (sum <= 0 || durationSec <= 0) return { fadeInSec: 0, fadeOutSec: 0 };
  const scale = durationSec / sum;
  return { fadeInSec: fadeInSec * scale, fadeOutSec: fadeOutSec * scale };
}

/** The OfflineAudioContext constructor type, feature-detected at call time. */
type OfflineCtor = new (
  channels: number,
  length: number,
  sampleRate: number,
) => OfflineAudioContext;

function getOfflineCtor(): OfflineCtor | undefined {
  const g = globalThis as Record<string, unknown>;
  const ctor = g.OfflineAudioContext ?? g.webkitOfflineAudioContext;
  return typeof ctor === 'function' ? (ctor as OfflineCtor) : undefined;
}

interface DecodedClips {
  /** clipId → decoded buffer (de-duped); a *missing* clip is absent from this map. */
  byId: Map<string, AudioBuffer>;
  /** clipIds that resolved to no blob (missing) — rendered as silence, surfaced as notice. */
  missing: Set<string>;
}

/** Pre-decode every distinct clipId referenced by a layer, BEFORE any scheduling (an
 *  offline render runs in one shot and cannot await mid-render — design §3 step 7).
 *  Missing clip (getBlob → undefined) = silent layer (not an error); a present-but-
 *  undecodable blob → DECODE_FAILED naming the clipId. */
async function preDecodeClips(
  ctx: OfflineAudioContext,
  layers: readonly Layer[],
  onProgress: ((p: RenderProgress) => void) | undefined,
  signal: AbortSignal | undefined,
): Promise<DecodedClips> {
  const clipIds: string[] = [];
  const seen = new Set<string>();
  for (const layer of layers) {
    const source = layer.source as { clipId?: string };
    if (typeof source.clipId === 'string' && !seen.has(source.clipId)) {
      seen.add(source.clipId);
      clipIds.push(source.clipId);
    }
  }

  const byId = new Map<string, AudioBuffer>();
  const missing = new Set<string>();
  const total = clipIds.length;

  // Always emit at least one decoding tick (fraction 1 when there are no clips).
  emit(onProgress, { phase: 'decoding', fraction: total === 0 ? 1 : 0 });

  let done = 0;
  for (const clipId of clipIds) {
    throwIfAborted(signal);
    const blob = await getBlob(clipId);
    if (blob === undefined) {
      missing.add(clipId); // missing clip = silence for that layer (edge-cases §2)
    } else {
      const arrayBuffer = await blob.arrayBuffer();
      let decoded: AudioBuffer;
      try {
        decoded = await ctx.decodeAudioData(arrayBuffer);
      } catch (cause) {
        throw new RenderError(
          'DECODE_FAILED',
          `clip ${clipId} could not be decoded`,
          cause,
        );
      }
      byId.set(clipId, decoded);
    }
    done++;
    emit(onProgress, { phase: 'decoding', fraction: total === 0 ? 1 : done / total });
  }

  return { byId, missing };
}

/** Register the offline waveform keyframes via suspend/resume (design §6; multi-voice §4).
 *  An ALL-VOICES aggregator: each t>0 waveform switch is collected from the primary voice
 *  AND every extra voice — each voice's keyframes come from its OWN nodes via the shared
 *  `voiceView` (multi-voice §1.5) — then keyed by distinct offline time so EXACTLY ONE
 *  `ctx.suspend(t)` is registered per time, applying every due `voice.setWaveform` in that
 *  single callback before `ctx.resume()` (OfflineAudioContext rejects two suspends in the
 *  same render quantum, so two voices switching at the same t MUST share one suspend). The
 *  t=0 waveform is the one each voice was built with. If the context lacks `suspend`, fall
 *  back to the initial waveform + a one-time notice (edge-cases §7) and never block the
 *  render. */
function registerWaveformKeyframes(
  ctx: OfflineAudioContext,
  voice: Voice,
  preset: Preset,
  extraVoices: readonly ExtraVoiceRecord[],
  onNotice: ((n: string) => void) | undefined,
): void {
  // time → every voice's discrete switch due at that time (keyed so a shared time = one suspend).
  const dueByTime = new Map<number, { voice: Voice; waveform: Waveform }[]>();
  const collect = (v: Voice, p: Preset): void => {
    for (const kf of waveformKeyframes(p)) {
      if (kf.t <= 0) continue; // t=0 is the waveform the voice was built with
      const due = dueByTime.get(kf.t);
      if (due) due.push({ voice: v, waveform: kf.waveform });
      else dueByTime.set(kf.t, [{ voice: v, waveform: kf.waveform }]);
    }
  };
  collect(voice, preset);
  for (const rec of extraVoices) collect(rec.voice, voiceView(preset, rec.source.nodes));

  if (dueByTime.size === 0) return;

  if (typeof ctx.suspend !== 'function') {
    notify(
      onNotice,
      'this browser cannot switch waveform mid-render; using the initial waveform',
    );
    return;
  }

  for (const [t, due] of dueByTime) {
    // suspend(t) resolves when the offline clock reaches t; apply every voice's discrete
    // switch due at t, then resume. ONE suspend per distinct time across all voices.
    void ctx.suspend(t).then(() => {
      for (const { voice: v, waveform } of due) v.setWaveform(waveform);
      void ctx.resume();
    });
  }
}

/** A composed extra voice (multi-voice §4): its runtime graph, the single-writer per-voice
 *  trim GainNode (voice.output → trim → mixer.bedInput), and the source `Voice` it came from
 *  (mirrors transport's `extraVoices` record so the waveform aggregator can reach each voice's
 *  nodes). */
interface ExtraVoiceRecord {
  voice: Voice;
  trim: GainNode;
  source: PresetVoice;
}

/** Dispose every render-owned graph object best-effort (each in its own try/catch) so a
 *  finished OR cancelled render leaks no live graph (design §3 step 11 / §9). */
function disposeAll(
  schedule: LayerSchedule | undefined,
  layerNodes: readonly LayerNode[],
  voice: Voice | undefined,
  mixer: Mixer | undefined,
  extraVoices: readonly ExtraVoiceRecord[],
): void {
  const safe = (fn: () => void): void => {
    try {
      fn();
    } catch {
      // best-effort teardown
    }
  };
  if (schedule) safe(() => schedule.dispose());
  for (const node of layerNodes) safe(() => node.dispose());
  if (voice) safe(() => voice.dispose());
  // Each extra voice: dispose its runtime graph and disconnect its per-voice trim (§4).
  for (const rec of extraVoices) {
    safe(() => rec.voice.dispose());
    safe(() => rec.trim.disconnect());
  }
  if (mixer) safe(() => mixer.dispose());
}

/** Render a validated preset to a stereo AudioBuffer by replaying the live graph on an
 *  OfflineAudioContext (design §3 — the same calls transport makes). */
export async function renderToBuffer(
  preset: Preset,
  options?: RenderOptions,
): Promise<AudioBuffer> {
  const { onProgress, signal, onNotice } = options ?? {};

  // (0) An already-aborted signal wastes nothing — reject before any allocation.
  throwIfAborted(signal);

  // (1) Resolve + validate the sample rate (reject up front, not an opaque ctor throw).
  const sampleRate = resolveSampleRate(options?.sampleRate);

  // (2) Environment guard + the OOM pre-flight frame-count guard (before any allocation).
  const Offline = getOfflineCtor();
  if (!Offline) {
    throw new RenderError('UNSUPPORTED', 'OfflineAudioContext is unavailable');
  }
  const frames = Math.ceil(preset.durationSec * sampleRate);
  if (!Number.isFinite(frames) || frames < 1) {
    throw new RenderError('RENDER_FAILED', 'preset duration produced no renderable frames');
  }
  if (frames > MAX_RENDER_FRAMES) {
    throw new RenderError(
      'RENDER_FAILED',
      `preset too long to render in one pass (${frames} frames > ${MAX_RENDER_FRAMES}); try a shorter duration`,
    );
  }

  // (3) Construct the offline context (an allocation/RangeError → RENDER_FAILED).
  let ctx: OfflineAudioContext;
  try {
    ctx = new Offline(2, frames, sampleRate);
  } catch (cause) {
    throw new RenderError('RENDER_FAILED', 'OfflineAudioContext construction failed', cause);
  }

  let voice: Voice | undefined;
  let mixer: Mixer | undefined;
  let schedule: LayerSchedule | undefined;
  const layerNodes: LayerNode[] = [];
  const extraVoices: ExtraVoiceRecord[] = [];

  try {
    // (4) Register the pulse worklet — AWAIT to completion. Offline there is no gesture
    //     and no autoplay policy, so we await freely. A reject is a HARD WORKLET error
    //     (a degraded render is a *different* file than the user heard — edge-cases §1).
    //     The Shepard lift worklet is NOT registered (it is a live-only overlay).
    try {
      await registerPulseWorklet(ctx);
    } catch (cause) {
      throw new RenderError('WORKLET', 'pulse worklet failed to register offline', cause);
    }

    throwIfAborted(signal);

    // (5) Build the voice in BUS mode (unity passthrough; the mixer owns the master fade).
    voice = createVoice(ctx, { master: 'bus' });

    // (6) Compose the mixer and rewire: drop voice→destination, route voice into the bed,
    //     and make mixer.master→destination the ONLY edge into the offline destination.
    //     MULTI-VOICE (v6, §2/D-041): equal-power headroom on bedInput for N = primary +
    //     extra voices, so summing N near-full-scale voices does not overdrive busSum →
    //     master. N=1 ⇒ bedHeadroom 1 ⇒ single-voice byte-identical. Matches transport.
    const N = 1 + (preset.voices?.length ?? 0);
    mixer = createMixer(ctx, { bedHeadroom: 1 / Math.sqrt(N) });
    try {
      voice.output.disconnect(ctx.destination);
    } catch {
      // best-effort: the construction edge may already be absent
    }
    voice.output.connect(mixer.bedInput);
    mixer.connect(ctx.destination);

    const layers = preset.layers ?? [];

    // (7) PRE-DECODE all clip blobs FIRST (before any scheduling). De-dup shared clipIds.
    const decoded = await preDecodeClips(ctx, layers, onProgress, signal);
    if (decoded.missing.size > 0) {
      notify(
        onNotice,
        `${decoded.missing.size} clip(s) were unavailable and rendered as silence: ${[...decoded.missing].join(', ')}`,
      );
    }

    throwIfAborted(signal);

    // (8) Build LayerNodes and connect by kind: tone/ambiance → bedInput (ducked bed),
    //     voice (cue) → cueInput (post-duck overlay). A missing clip builds a silent node.
    for (const layer of layers) {
      const source = layer.source as { clipId?: string };
      const buffer =
        typeof source.clipId === 'string' ? decoded.byId.get(source.clipId) : undefined;
      const node = createLayerNode(ctx, layer, buffer);
      layerNodes.push(node);
      const target = layer.kind === 'voice' ? mixer.cueInput : mixer.bedInput;
      node.output.connect(target);
    }

    // (10) Schedule EVERYTHING at offline t0 = 0 — the SAME calls transport makes.
    //      scheduleAll drives the four binaural lanes; scheduleLayers drives the layer
    //      gain/pan lanes AND the duck (single-writer D-019 — the renderer never writes
    //      duckParam itself).
    scheduleAll(preset, voice, { startTime: 0 });

    // (10b) MULTI-VOICE (v6, §4): sum each extra voice on the SAME OfflineAudioContext.
    //       Each is an independent createVoice graph in 'bus' mode whose default
    //       masterGain → ctx.destination edge MUST be dropped (audio-engine.ts:341 connects
    //       it unconditionally even in bus mode — without the drop the voice double-routes at
    //       full unity straight to the offline destination, bypassing the per-voice trim, the
    //       1/√N bedHeadroom, the master fades and the duck → an audibly wrong render). Then
    //       voice.output → single-writer per-voice trim (clamp01(gain ?? 1)) → mixer.bedInput,
    //       scheduled by its OWN scheduleAll over the shared voiceView (guarantees
    //       render == playback), and started at offline t0 = 0. Each record is tracked so the
    //       waveform aggregator and disposeAll can reach every voice's nodes.
    for (const source of preset.voices ?? []) {
      const voiceNode = createVoice(ctx, { master: 'bus' });
      try {
        voiceNode.output.disconnect(ctx.destination); // drop the default destination edge
      } catch {
        // best-effort: the construction edge may already be absent (mirrors the primary)
      }
      const trim = ctx.createGain();
      trim.gain.value = clamp01(source.gain ?? 1);
      voiceNode.output.connect(trim);
      trim.connect(mixer.bedInput);
      extraVoices.push({ voice: voiceNode, trim, source });
      scheduleAll(voiceView(preset, source.nodes), voiceNode, { startTime: 0 });
      voiceNode.start(0);
    }

    // (10c) Register the offline waveform keyframes (suspend/resume) BEFORE startRendering —
    //       an ALL-VOICES aggregator: exactly ONE suspend per distinct keyframe time across the
    //       primary + every extra voice (two suspends in the same render quantum are rejected).
    registerWaveformKeyframes(ctx, voice, preset, extraVoices, onNotice);

    schedule = scheduleLayers(mixer, layerNodes, layers, { t0: 0, startOffsetSec: 0 });

    // (11) Master fade-in (0 → trim) via the param-agnostic controller, then the closing
    //      trim → 0 end fade written directly on mixer.masterParam (hold at trim until
    //      durationSec - fadeOutSec, then a LINEAR ramp to 0 at durationSec). Linear only
    //      (never exp-to-0, never setValueCurve — Firefox bug 1752775). Fades clamped so
    //      fadeInSec + fadeOutSec ≤ durationSec for very short presets.
    const trim = preset.masterGain;
    const { fadeInSec, fadeOutSec } = resolveFades(preset.durationSec);
    const mc = createMasterGainController(mixer.masterParam, () => ctx.currentTime);
    mc.rampMaster(trim, fadeInSec); // 0 → trim from ctx.currentTime (== 0 at compose time)
    const holdUntil = Math.max(fadeInSec, preset.durationSec - fadeOutSec);
    mixer.masterParam.setValueAtTime(trim, holdUntil);
    mixer.masterParam.linearRampToValueAtTime(0, preset.durationSec);

    // (12) Start the sources. voice.start(0); each layer starts at its session-timeline
    //      placement (scheduleLayers already started layer sources; voice is the renderer's
    //      to start — scheduleAll does not start the voice).
    voice.start(0);

    // (13) Cancellation check at the phase boundary BEFORE startRendering (mid-render
    //      abort is impossible — Web Audio gives no abort handle).
    throwIfAborted(signal);

    if (typeof ctx.startRendering !== 'function') {
      throw new RenderError('RENDER_FAILED', 'OfflineAudioContext.startRendering is unavailable');
    }
    emit(onProgress, { phase: 'rendering' }); // indeterminate — no native render progress

    let buffer: AudioBuffer;
    try {
      buffer = await ctx.startRendering();
    } catch (cause) {
      if (cause instanceof RenderError) throw cause;
      throw new RenderError('RENDER_FAILED', 'offline render failed', cause);
    }

    // (14) Honor a cancel observed during the render at the next boundary (discard buffer).
    throwIfAborted(signal);

    return buffer;
  } finally {
    // Dispose on BOTH the success and the cancel/error paths (best-effort each).
    disposeAll(schedule, layerNodes, voice, mixer, extraVoices);
  }
}

// ===========================================================================
// 9. renderToFile — render + encode (interfaces.md §4)
// ===========================================================================

/** Strip unsafe path characters from `preset.name` → a safe filename stem. Collapses
 *  whitespace/illegal chars to '-', trims, and falls back to 'render' when empty. */
function sanitizeFilename(name: string): string {
  const stem = String(name ?? '')
    .normalize('NFKD')
    .replace(/[\\/:*?"<>|\x00-\x1f]/g, '-') // path-illegal + control chars
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 120);
  return stem.length > 0 ? stem : 'render';
}

const MIME_BY_FORMAT: Record<RenderFormat, string> = {
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
};

/** Render then encode to a file blob (design §4). Forwards onProgress/signal to
 *  renderToBuffer and continues reporting progress over the encode phase. Returns
 *  { blob, filename, mime }; the UI owns the actual save/share. */
export async function renderToFile(
  preset: Preset,
  format: RenderFormat,
  options?: RenderOptions & EncodeOptions,
): Promise<RenderedFile> {
  // Validate format up front (a bad format must not waste an expensive render).
  validateFormat(format);
  if (format === 'mp3') resolveKbps(options?.mp3Kbps); // INVALID_OPTION before rendering

  const { onProgress, signal } = options ?? {};

  const buffer = await renderToBuffer(preset, options);

  // The render phase succeeded; continue reporting encode-phase progress.
  const blob = await encodeBuffer(buffer, format, {
    mp3Kbps: options?.mp3Kbps,
    onProgress,
    signal,
  });

  emit(onProgress, { phase: 'done', fraction: 1 });

  const mime = MIME_BY_FORMAT[format];
  const filename = `${sanitizeFilename(preset.name)}.${format}`;
  return { blob, filename, mime };
}
