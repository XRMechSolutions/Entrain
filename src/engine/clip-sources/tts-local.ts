// tts-local — the `source: 'tts'` arm of the ClipSourceAdapter seam.
//
// One job: turn a line of text (+ optional voice / language / rate) into a stored,
// content-addressed ClipDraft by running a neural TTS model in-browser. Lazily loads
// Kokoro-82M via kokoro-js once per page (device-negotiated webgpu -> wasm); kokoro-js
// fetches the ONNX weights from the HF hub on first use and the browser caches them, so
// subsequent loads are offline (D-039). kokoro-js owns G2P for its languages. We then
// synthesize Float32 PCM, encode it to a WAV blob, measure duration, compute the content
// hash from the NORMALIZED inputs, and return a ClipDraft.
//
// AUTHORING-ONLY (D-024 / D-028 / D-031; arch §6 / design §5): this module is NEVER
// imported by transport, renderer, mixer, layer-engine, or layer-scheduler — synthesis
// must never run on the playback or offline-render path. Its only consumers are
// voice-script (D-034) and the authoring ui. It imports clip-library for TYPES ONLY
// (ClipSourceAdapter / ClipDraft / ClipMeta / ClipSource) and never its storage functions;
// the caller stores the draft via clip-library.add / importVia.
//
// The real synthesizer lives behind an INJECTABLE `synth` seam (TtsSynth): the default
// synth lazily dynamic-imports kokoro-js and runs the Kokoro q8 graph; tests inject a fake
// synth returning a small Float32 PCM buffer so the unit suite never loads the model. See
// `defaultSynth` below.
//
// !!! RUNTIME / AUTHORING MEASUREMENT (Tier-5 validation task, design §8) !!!
// The REAL Kokoro-82M q8 audible quality, per-line synthesis latency (webgpu vs
// single-threaded wasm), and the Kokoro Japanese G2P pronunciation quality are
// measurements taken on the USER'S MACHINE, recorded in
// .dev/.task-state/tts-local/q8-ja-validation.md. They are deliberately NOT covered by the
// unit tests in this module: the tests inject a fake synth and assert the ClipDraft
// contract (shape, deterministic hash, duration, error paths), not model fidelity. A
// FALLBACK verdict (dtype q8 -> fp32/q4, or the ja arm -> sherpa-onnx VITS) is a config /
// modelId change behind this same `produce` contract — only the affected clips re-synth
// because modelId is part of the hash.

import { sha256Hex } from '../clip-library';
import type {
  ClipDraft,
  ClipMeta,
  ClipSource,
  ClipSourceAdapter,
} from '../clip-library';

// ---------------------------------------------------------------------------
// 1. Module types (interfaces.md §3)
// ---------------------------------------------------------------------------

/** The four supported TTS languages (D-033). */
export type TtsLanguage = 'en' | 'es' | 'fr' | 'ja';

/** Adapter input — the §6 shape `{ text; voice?; language?; rateScale? }`, typed. */
export interface TtsInput {
  /** line to synthesize; required, non-empty after trim */
  text: string;
  /** Kokoro speaker id; default = per-language default voice (VOICES) */
  voice?: string;
  /** default 'en'; never auto-detected (authoring is explicit) */
  language?: TtsLanguage;
  /** speaking-rate multiplier; default 1.0; clamped to [0.5, 2.0] */
  rateScale?: number;
}

/** Options for the factory (all optional; sensible bundled defaults). */
export interface TtsAdapterOptions {
  /** default 'auto' = feature-detect webgpu, else wasm (design §3.3) */
  device?: 'auto' | 'webgpu' | 'wasm';
  /** default 'q8' (D-037; validate — design §8) */
  dtype?: 'q8' | 'q4' | 'fp32';
  /**
   * HF-hub model id kokoro-js loads; default onnx-community/Kokoro-82M-v1.0-ONNX (fetched
   * on first use, then browser-cached).
   */
  hubModelId?: string;
  /** model identity used in the hash; default `kokoro-82m-<dtype>` */
  modelId?: string;
  /**
   * INJECTABLE synthesis seam. Default lazily dynamic-imports kokoro-js and runs Kokoro q8
   * (webgpu -> wasm). Tests inject a fake returning small PCM so the real model never loads.
   * The default synth is built from `device`/`dtype`/`hubModelId`.
   */
  synth?: TtsSynth;
}

// ---------------------------------------------------------------------------
// 2. The synthesis seam (TtsSynth) — what the engine loader hides behind
// ---------------------------------------------------------------------------

/** A request handed to the synth after validation/normalization. */
export interface TtsSynthRequest {
  /** normalized (trimmed) text */
  text: string;
  /** resolved language */
  language: TtsLanguage;
  /** resolved speaker id (always present after normalization) */
  voice: string;
  /** clamped speaking rate in [0.5, 2.0] */
  rate: number;
}

/** Raw synthesis output: mono Float32 PCM at the model's native sample rate. */
export interface TtsSynthResult {
  pcm: Float32Array;
  /** model native sample rate (Kokoro = 24000) */
  sampleRate: number;
}

/**
 * The injectable synthesizer. `load()` is the lazy, once-per-page engine load
 * (device-negotiated webgpu -> wasm; Kokoro via kokoro-js, HF-hub fetch on first use then
 * browser-cached); a rejected load is NOT cached (the next produce retries). `synthesize()`
 * runs one inference. The default impl wires the real kokoro-js Kokoro engine; tests inject
 * a fake.
 */
export interface TtsSynth {
  /**
   * Ensure the engine is ready for the given language. Resolves when the Kokoro session is
   * loaded (kokoro-js owns G2P, so no separate per-language dictionary). May be called
   * concurrently; the implementation memoizes a single in-flight load.
   */
  load(language: TtsLanguage): Promise<void>;
  /** Run one inference, returning mono Float32 PCM + its sample rate. */
  synthesize(req: TtsSynthRequest): Promise<TtsSynthResult>;
}

// ---------------------------------------------------------------------------
// 3. Voices & languages (VOICES table — design §3.4, D-033)
// ---------------------------------------------------------------------------

/**
 * Per-language allowed Kokoro speaker ids + the default used when `voice` is absent. A
 * config constant, NOT an architectural decision (D-032): coverage is per-voice config.
 * The exact ids are validated/finalized against the bundled voice packs at impl time
 * (design §8 item 4); the SHAPE — a default + an allowed set per language — is the
 * contract the tests assert against.
 */
interface VoiceTable {
  /** voice used when the caller omits `voice` */
  default: string;
  /** every speaker id valid for this language (includes `default`) */
  allowed: readonly string[];
}

export const VOICES: Readonly<Record<TtsLanguage, VoiceTable>> = {
  en: { default: 'af_heart', allowed: ['af_heart', 'af_bella', 'am_michael'] },
  es: { default: 'ef_dora', allowed: ['ef_dora', 'em_alex'] },
  fr: { default: 'ff_siwis', allowed: ['ff_siwis'] },
  ja: { default: 'jf_alpha', allowed: ['jf_alpha', 'jm_kumo'] },
} as const;

const SUPPORTED_LANGUAGES = Object.keys(VOICES) as TtsLanguage[];

// ---------------------------------------------------------------------------
// 4. Errors (interfaces.md §5)
// ---------------------------------------------------------------------------

export type TtsErrorCode =
  | 'EMPTY_TEXT' // text empty/whitespace-only after trim
  | 'UNSUPPORTED_LANGUAGE' // language not in 'en'|'es'|'fr'|'ja'
  | 'UNKNOWN_VOICE' // voice id not valid for the requested language
  | 'MODEL_LOAD_FAILED' // Kokoro ONNX failed to load (webgpu AND wasm)
  | 'PHONEMIZER_UNAVAILABLE' // Japanese-only: the JA engine/G2P failed to load
  | 'SYNTHESIS_FAILED'; // inference produced no/invalid PCM (NaN, empty, non-finite duration)

/**
 * The module's typed error. `produce` ALWAYS rejects with one of these — it never lets a
 * raw library error / DOMException escape (interfaces.md §5): underlying faults are wrapped
 * with `.cause` preserved. It never throws synchronously; every failure is a rejected
 * Promise.
 */
export class TtsError extends Error {
  readonly name = 'TtsError';
  readonly code: TtsErrorCode;
  readonly cause?: unknown;

  constructor(code: TtsErrorCode, message?: string, cause?: unknown) {
    super(message ?? code);
    this.code = code;
    if (cause !== undefined) this.cause = cause;
    // Restore the prototype so `instanceof` holds even when a down-level transpile target
    // breaks the native Error subclass chain (matches ClipLibraryError).
    Object.setPrototypeOf(this, TtsError.prototype);
  }
}

// ---------------------------------------------------------------------------
// 5. WAV encoder — dependency-free RIFF/WAVE PCM-16 mono (design §3.7)
// ---------------------------------------------------------------------------

const WAV_HEADER_BYTES = 44;

/**
 * Encode mono Float32 PCM to a WAV (PCM-16, mono, the given sample rate) Blob with a
 * standard 44-byte RIFF/WAVE header. Samples are CLAMPED to [-1, 1] and NaN -> 0 before
 * scaling to 16-bit signed little-endian, so a malformed PCM frame can never produce
 * out-of-range 16-bit output (the encoder is the last guard before the duration check).
 * `format` of the produced Blob is `'audio/wav'`.
 */
export function encodeWav(pcm: Float32Array, sampleRate: number): Blob {
  const numSamples = pcm.length;
  const bytesPerSample = 2; // PCM-16
  const numChannels = 1; // mono
  const blockAlign = numChannels * bytesPerSample;
  const byteRate = sampleRate * blockAlign;
  const dataBytes = numSamples * blockAlign;
  const buffer = new ArrayBuffer(WAV_HEADER_BYTES + dataBytes);
  const view = new DataView(buffer);

  // RIFF chunk descriptor
  writeAscii(view, 0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true); // ChunkSize = 4 + (8 + 16) + (8 + dataBytes)
  writeAscii(view, 8, 'WAVE');
  // fmt sub-chunk
  writeAscii(view, 12, 'fmt ');
  view.setUint32(16, 16, true); // Subchunk1Size = 16 (PCM)
  view.setUint16(20, 1, true); // AudioFormat = 1 (PCM)
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bytesPerSample * 8, true); // BitsPerSample = 16
  // data sub-chunk
  writeAscii(view, 36, 'data');
  view.setUint32(40, dataBytes, true);

  // Samples: clamp [-1,1], NaN -> 0, scale to signed 16-bit, little-endian.
  let offset = WAV_HEADER_BYTES;
  for (let i = 0; i < numSamples; i++) {
    let s = pcm[i];
    if (Number.isNaN(s)) s = 0;
    if (s > 1) s = 1;
    else if (s < -1) s = -1;
    // Asymmetric scale matches the signed-16 range [-32768, 32767].
    const int16 = s < 0 ? s * 0x8000 : s * 0x7fff;
    view.setInt16(offset, int16, true);
    offset += bytesPerSample;
  }

  return new Blob([buffer], { type: 'audio/wav' });
}

function writeAscii(view: DataView, offset: number, text: string): void {
  for (let i = 0; i < text.length; i++) {
    view.setUint8(offset + i, text.charCodeAt(i));
  }
}

// ---------------------------------------------------------------------------
// 6. Hashing & rate normalization (design §4)
// ---------------------------------------------------------------------------

const RATE_MIN = 0.5;
const RATE_MAX = 2.0;
const DEFAULT_RATE = 1.0;

/**
 * Clamp `rateScale` into [0.5, 2.0]. Non-finite (NaN / ±Infinity) and undefined collapse
 * to the default 1.0 (edge-cases §8) — clamping is forgiving, never an error.
 */
function clampRate(rateScale: number | undefined): number {
  if (rateScale === undefined || !Number.isFinite(rateScale)) return DEFAULT_RATE;
  if (rateScale < RATE_MIN) return RATE_MIN;
  if (rateScale > RATE_MAX) return RATE_MAX;
  return rateScale;
}

/** Canonical rate string for the hash basis, e.g. 1 -> '1.00', 0.9 -> '0.90'. */
function formatRate(rate: number): string {
  return rate.toFixed(2);
}

/**
 * hash = hex(SHA-256(utf-8(join(modelId, voice, lang, text, rate)))) over NORMALIZED
 * inputs (resolved voice, clamped+canonical rate, trimmed text), JSON-array-encoded (design §4).
 * Encoding and device are deliberately excluded from the basis. `crypto.subtle` via the
 * shared `sha256Hex` (no hashing lib) — a missing subtle surfaces as a wrapped reject.
 */
async function computeHash(
  modelId: string,
  voice: string,
  language: TtsLanguage,
  text: string,
  rate: number,
): Promise<string> {
  const basis = JSON.stringify([modelId, voice, language, text, formatRate(rate)]);
  const bytes = new TextEncoder().encode(basis);
  // Hand a freshly-sliced ArrayBuffer (not the possibly-shared view buffer) to digest.
  return sha256Hex(bytes.buffer.slice(0));
}

// ---------------------------------------------------------------------------
// 7. Default synth — the REAL engine seam (lazy, in-browser Kokoro via kokoro-js)
// ---------------------------------------------------------------------------

/** Resolved, effective config for the default synth. */
interface ResolvedConfig {
  device: 'auto' | 'webgpu' | 'wasm';
  dtype: 'q8' | 'q4' | 'fp32';
  /** HF-hub model id kokoro-js fetches (then the browser caches) on first load. */
  hubModelId: string;
  /** modelId used in the content hash (so a dtype/model change re-synths clips). */
  modelId: string;
}

const DEFAULT_HUB_MODEL_ID = 'onnx-community/Kokoro-82M-v1.0-ONNX';
const DEFAULT_DTYPE = 'q8';

function resolveConfig(opts?: TtsAdapterOptions): ResolvedConfig {
  const dtype = opts?.dtype ?? DEFAULT_DTYPE;
  return {
    device: opts?.device ?? 'auto',
    dtype,
    hubModelId: opts?.hubModelId ?? DEFAULT_HUB_MODEL_ID,
    modelId: opts?.modelId ?? `kokoro-82m-${dtype}`,
  };
}

/**
 * Build the DEFAULT synthesizer: the real, in-browser Kokoro engine via kokoro-js. Tests
 * REPLACE this seam (inject a fake synth), so the body never runs under the unit suite; its
 * real fidelity & latency are the Tier-5 validation measurement (see the file header banner).
 * kokoro-js fetches the ONNX weights from the HF hub on first use and the browser caches them,
 * so subsequent loads are offline (D-039). The in-flight load is memoized; a REJECTED load is
 * discarded (not cached) so the next produce retries. kokoro-js owns G2P for its languages.
 */
function defaultSynth(config: ResolvedConfig): TtsSynth {
  let enginePromise: Promise<KokoroEngine> | undefined;

  function ensureEngine(): Promise<KokoroEngine> {
    if (!enginePromise) {
      enginePromise = loadKokoroEngine(config).catch((err) => {
        enginePromise = undefined;
        throw err;
      });
    }
    return enginePromise;
  }

  return {
    async load(_language: TtsLanguage): Promise<void> {
      await ensureEngine();
    },
    async synthesize(req: TtsSynthRequest): Promise<TtsSynthResult> {
      const engine = await ensureEngine();
      const pcm = await engine.synthesize(req.text, req.voice, req.language, req.rate);
      return { pcm, sampleRate: engine.sampleRate };
    },
  };
}

interface KokoroEngine {
  readonly sampleRate: number;
  synthesize(
    text: string,
    voice: string,
    language: TtsLanguage,
    rate: number,
  ): Promise<Float32Array>;
}

/**
 * Load the in-browser Kokoro engine via kokoro-js with webgpu -> wasm negotiation. kokoro-js
 * fetches the ONNX weights from the HF hub on first use (then browser-cached; offline after —
 * D-039). RUNTIME ONLY — replaced by the injected fake synth in tests.
 */
async function loadKokoroEngine(config: ResolvedConfig): Promise<KokoroEngine> {
  const device = await negotiateDevice(config.device);
  try {
    return await constructKokoro(config, device);
  } catch (cause) {
    if (device === 'webgpu') {
      try {
        return await constructKokoro(config, 'wasm');
      } catch (wasmCause) {
        throw new TtsError('MODEL_LOAD_FAILED', 'Kokoro failed to load on webgpu and wasm', wasmCause);
      }
    }
    throw new TtsError('MODEL_LOAD_FAILED', 'Kokoro failed to load', cause);
  }
}

/**
 * Construct the Kokoro engine on a specific device via kokoro-js. kokoro-js owns the model
 * fetch (HF hub -> browser cache), the StyleTextToSpeech2 graph, voice selection, and G2P;
 * we hand it (text, voice, speed) and read back mono Float32 PCM @ 24 kHz.
 */
async function constructKokoro(
  config: ResolvedConfig,
  device: 'webgpu' | 'wasm',
): Promise<KokoroEngine> {
  const { KokoroTTS } = await import('kokoro-js');
  const tts = await KokoroTTS.from_pretrained(config.hubModelId, {
    dtype: config.dtype,
    device,
  });
  return {
    sampleRate: 24000,
    async synthesize(text, voice, _language, rate) {
      const out = await tts.generate(text, {
        voice,
        speed: rate,
      } as unknown as Parameters<typeof tts.generate>[1]);
      return out.audio as Float32Array;
    },
  };
}

/**
 * Device negotiation (design §3.3): 'auto' probes navigator.gpu + requestAdapter() — a
 * non-null adapter -> 'webgpu', else 'wasm'. A forced device is honored as a hint (forced
 * 'webgpu' on a no-GPU machine still construct-fails and retries on wasm upstream).
 */
async function negotiateDevice(
  requested: 'auto' | 'webgpu' | 'wasm',
): Promise<'webgpu' | 'wasm'> {
  if (requested === 'wasm') return 'wasm';
  if (requested === 'webgpu') return 'webgpu';
  const gpu = (globalThis.navigator as { gpu?: GpuLike } | undefined)?.gpu;
  if (gpu && typeof gpu.requestAdapter === 'function') {
    try {
      const adapter = await gpu.requestAdapter();
      if (adapter) return 'webgpu';
    } catch {
      // Probe failure -> wasm (never an error).
    }
  }
  return 'wasm';
}

interface GpuLike {
  requestAdapter(): Promise<unknown>;
}

// ---------------------------------------------------------------------------
// 8. Validation & normalization (design §2 step 1)
// ---------------------------------------------------------------------------

interface NormalizedInput {
  text: string;
  language: TtsLanguage;
  voice: string;
  rate: number;
}

const NAME_WORD_COUNT = 5;

/** Short display label = the first few words of the normalized text (design §4). */
function deriveName(text: string): string {
  const words = text.split(/\s+/).filter(Boolean).slice(0, NAME_WORD_COUNT);
  const name = words.join(' ');
  // If we truncated (more words than we kept), mark it with an ellipsis.
  return /\s/.test(text.trim()) && text.split(/\s+/).filter(Boolean).length > NAME_WORD_COUNT
    ? `${name}…`
    : name;
}

/**
 * Validate & normalize the input BEFORE any model work (design §2 step 1): trim text,
 * resolve default language ('en') / voice (per-language default), clamp rate. Throws a
 * typed TtsError for EMPTY_TEXT / UNSUPPORTED_LANGUAGE / UNKNOWN_VOICE so these reject fast,
 * cheap, and deterministically — never reaching the engine load (edge-cases §4, §5).
 */
function normalize(input: TtsInput): NormalizedInput {
  const language: TtsLanguage = input.language ?? 'en';
  if (!SUPPORTED_LANGUAGES.includes(language)) {
    throw new TtsError(
      'UNSUPPORTED_LANGUAGE',
      `Unsupported language: ${String(language)}`,
    );
  }

  const text = (input.text ?? '').trim();
  if (text.length === 0) {
    throw new TtsError('EMPTY_TEXT', 'text is empty or whitespace-only');
  }

  const table = VOICES[language];
  const voice = input.voice ?? table.default;
  if (!table.allowed.includes(voice)) {
    throw new TtsError(
      'UNKNOWN_VOICE',
      `Voice "${voice}" is not valid for language "${language}"`,
    );
  }

  const rate = clampRate(input.rateScale);
  return { text, language, voice, rate };
}

// ---------------------------------------------------------------------------
// 9. The factory (interfaces.md §4)
// ---------------------------------------------------------------------------

/**
 * Build the local, offline, in-browser TTS adapter (source: 'tts').
 *
 * Pure & synchronous: does NO model I/O and never throws — it returns an adapter whose
 * first `produce` lazily loads Kokoro via kokoro-js (device-negotiated webgpu -> wasm).
 * kokoro-js fetches the model from the HF hub on first use, then the browser caches it
 * (offline after the first run); only the first synthesis needs network (D-039).
 *
 * AUTHORING-ONLY: never called on the playback/offline-render path (D-024/D-028/D-031;
 * arch §6 / design §5). Imports clip-library for types only; the caller stores the draft.
 *
 * The synthesizer is INJECTABLE via `opts.synth` (tests inject a fake; default is the real
 * Kokoro engine in `defaultSynth`). Overlapping `produce` calls are SERIALIZED on an
 * internal promise chain so the single ONNX session is never re-entered (design §7).
 */
export function createTtsAdapter(opts?: TtsAdapterOptions): ClipSourceAdapter<TtsInput> {
  const config = resolveConfig(opts);
  const synth: TtsSynth = opts?.synth ?? defaultSynth(config);

  // Serialized synthesis queue (design §7): overlapping produce synth calls chain so the
  // single session is not re-entered. Validation/hash run BEFORE joining the queue so a
  // bad input rejects immediately without waiting behind an in-flight synth.
  //
  // `gate` is a barrier that ALWAYS resolves (never rejects) once the previous link has
  // settled — so the next link starts after the prior synth finishes, but one failed synth
  // never poisons the queue. The caller-facing promise (`run`) carries the real result/
  // rejection; the gate that advances the queue is a separate, never-rejecting promise so a
  // rejected `run` is never left without its own handler (no spurious unhandled rejection).
  let gate: Promise<void> = Promise.resolve();

  function enqueue<T>(work: () => Promise<T>): Promise<T> {
    const run = gate.then(work);
    gate = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  const source: ClipSource = 'tts';

  return {
    source,
    /**
     * Content hash for `input` WITHOUT loading the model or synthesizing — the same basis
     * produce() stamps (normalized text/voice/language/rate + modelId). Lets clip-library's
     * importVia skip a cache hit before the expensive synth (incremental re-synth). Validation
     * (EMPTY_TEXT / UNSUPPORTED_LANGUAGE / UNKNOWN_VOICE) runs here too, so an invalid input
     * rejects cheaply, exactly as produce() would.
     */
    async hashFor(input: TtsInput): Promise<string> {
      const norm = normalize(input);
      return computeHash(config.modelId, norm.voice, norm.language, norm.text, norm.rate);
    },
    async produce(input: TtsInput): Promise<ClipDraft> {
      // 1. Validate & normalize FIRST — these reject before ANY model work (edge-cases §4,§5).
      const norm = normalize(input);

      // 2. Content hash from the NORMALIZED inputs (design §4). A missing crypto.subtle
      //    surfaces here as a wrapped reject (edge-cases §9), never a silent skip.
      let hash: string;
      try {
        hash = await computeHash(
          config.modelId,
          norm.voice,
          norm.language,
          norm.text,
          norm.rate,
        );
      } catch (cause) {
        throw new TtsError('SYNTHESIS_FAILED', 'content hash failed', cause);
      }

      // 3-7. Engine load + synth + encode + measure run SERIALIZED on the queue so the
      //      single session is not re-entered by overlapping calls (design §7).
      return enqueue(() => synthesizeDraft(synth, norm, hash));
    },
  };
}

/**
 * Run the load -> synth -> encode -> measure -> package pipeline for one normalized input.
 * Every failure path is mapped to a typed TtsError with `.cause` preserved; the duration
 * assertion (finite > 0) is the final guard that no malformed clip leaves produce.
 */
async function synthesizeDraft(
  synth: TtsSynth,
  norm: NormalizedInput,
  hash: string,
): Promise<ClipDraft> {
  // 3. Ensure the engine is loaded. A load failure is MODEL_LOAD_FAILED, except a JA-scoped
  //    G2P failure is PHONEMIZER_UNAVAILABLE (kokoro-js owns G2P).
  try {
    await synth.load(norm.language);
  } catch (cause) {
    if (cause instanceof TtsError) throw cause;
    throw new TtsError(
      norm.language === 'ja' ? 'PHONEMIZER_UNAVAILABLE' : 'MODEL_LOAD_FAILED',
      'voice engine failed to load',
      cause,
    );
  }

  // 4-5. Synthesize Float32 PCM (kokoro-js owns G2P for all languages). A synth throw is
  //      SYNTHESIS_FAILED unless it is already typed (e.g. a JA G2P failure surfaced as
  //      PHONEMIZER_UNAVAILABLE).
  let result: TtsSynthResult;
  try {
    result = await synth.synthesize({
      text: norm.text,
      language: norm.language,
      voice: norm.voice,
      rate: norm.rate,
    });
  } catch (cause) {
    if (cause instanceof TtsError) throw cause;
    throw new TtsError('SYNTHESIS_FAILED', 'speech synthesis failed', cause);
  }

  // Guard against empty / non-finite PCM or a bad sample rate (edge-cases §5).
  const { pcm, sampleRate } = result;
  if (
    !pcm ||
    pcm.length === 0 ||
    !Number.isFinite(sampleRate) ||
    sampleRate <= 0 ||
    !allFinite(pcm)
  ) {
    throw new TtsError('SYNTHESIS_FAILED', 'synthesis produced empty or invalid PCM');
  }

  // 6. Encode to WAV (PCM-16 mono @ model sample rate). The encoder clamps each sample.
  const blob = encodeWav(pcm, sampleRate);

  // 7. Measure duration from the sample count (no decode round-trip). Final guard: finite > 0.
  const durationSec = pcm.length / sampleRate;
  if (!(durationSec > 0) || !Number.isFinite(durationSec)) {
    throw new TtsError('SYNTHESIS_FAILED', 'synthesis produced a non-finite duration');
  }

  // 8. Package the ClipDraft (design §4 / interfaces.md §4).
  const meta: ClipMeta = {
    name: deriveName(norm.text),
    language: norm.language,
    voice: norm.voice,
    text: norm.text,
  };
  return {
    hash,
    blob,
    format: 'audio/wav',
    durationSec,
    source: 'tts',
    meta,
  };
}

/** True iff every sample is finite (no NaN/±Infinity). Bounded single pass. */
function allFinite(pcm: Float32Array): boolean {
  for (let i = 0; i < pcm.length; i++) {
    if (!Number.isFinite(pcm[i])) return false;
  }
  return true;
}
