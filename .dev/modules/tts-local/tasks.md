# Tasks: tts-local
# Planning: .dev/planning/modules/tts-local/
# Architecture: .dev/modules/tts-local/architecture.md
# Standards: security, safety
# Stack: typescript

## Agent Briefing
`tts-local` is the `source: 'tts'` arm of the `ClipSourceAdapter` seam: a single factory,
`createTtsAdapter`, that turns a line of text into a content-addressed `ClipDraft` by running
Kokoro-82M ONNX (dtype `q8`) **entirely in-browser, offline** (kokoro-js, webgpu→wasm; kokoro-js owns
G2P for all languages). It is **authoring-only** — consumed only by `voice-script` (D-034) and the
authoring `ui`, and never imported by `transport`, `renderer`, `mixer`, `layer-engine`, or
`layer-scheduler` (the offline-path firewall, design §5). It depends on `clip-library` for types only
(`ClipSourceAdapter` / `ClipDraft` / `ClipMeta` / `ClipSource`) and produces a draft the caller stores
via `clip-library.add` / `importVia`. The whole module lives in one file:
`src/engine/clip-sources/tts-local.ts`.

## References
- .dev/planning/modules/tts-local/design.md
- .dev/planning/modules/tts-local/interfaces.md
- .dev/planning/modules/tts-local/edge-cases.md
- .dev/planning/modules/tts-local/dependencies.md
- .dev/planning/phase2-audio-architecture.md  (§6 the `createTtsAdapter` contract spine + build order; §5 the offline-path firewall)
- .dev/modules/tts-local/architecture.md

## Dependencies
Before this module starts:
- **session-model schema bump (v3→v4)** must be landed (phase2-audio-architecture §0) — `Clip` /
  `ClipSourceAdapter` / `ClipDraft` / `ClipMeta` / `ClipSource` are defined by `clip-library`, which
  depends on that schema. This module imports those types; it cannot type-check until they exist.
- **`clip-library` interfaces** (`ClipSourceAdapter` / `ClipDraft` / `ClipMeta` / `ClipSource`,
  `importVia`) must exist and be importable from `../clip-library`.
- The bundled model/dictionary/wasm artifacts and their **Workbox precache/runtime-cache policy** are
  owned by `pwa-shell` (D-017); this module's [config] task adds the deps + glob + size-limit hooks,
  but the final precache-vs-runtime-cache decision is a `pwa-shell` / Tier-5 validation item (design §8).

## Tasks

- [x] [config] Add @huggingface/transformers + kuromoji deps, bundle/precache the Kokoro q8 + kuromoji artifacts, and add the Workbox .onnx/.bin glob + maximumFileSizeToCacheInBytes | file: package.json, vite.config.ts, public/models/ | model: T2 [availability]
  - Ref: .dev/planning/modules/tts-local/dependencies.md @ Runtime dependencies (npm) (@huggingface/transformers ^3, kuromoji ^0.1 — pin exact at install)
  - Ref: .dev/planning/modules/tts-local/dependencies.md @ Bundled model / data artifacts (the Kokoro q8 ONNX + voice packs + espeak-ng data + kuromoji IPADIC + onnxruntime-web .wasm — static app assets, NOT runtime-fetched)
  - Ref: .dev/planning/modules/tts-local/dependencies.md @ D-017 PWA precache implication (Workbox) (default ~2 MB maximumFileSizeToCacheInBytes silently excludes the model/dict/wasm — raise it and/or use a CacheFirst runtimeCaching route)
  - Ref: .dev/planning/modules/tts-local/design.md @ 6. Model bundling (truly offline — D-032) (env.allowRemoteModels = false; env.localModelPath; wasmPaths; precache size + install-time implications)
  - Ref: .dev/planning/phase2-audio-architecture.md @ 6. Cross-Module Contract Spine — Build order (authoring lands last; tts-local is L1 authoring-only)
  - Accepts: the project package.json + vite.config.ts (the pwa-shell `VitePWA()` Workbox block) + a place to stage the bundled artifacts (e.g. `public/models/kokoro/`, `public/models/kuromoji/`)
  - Creates: `@huggingface/transformers` (^3, exact pin) and `kuromoji` (^0.1, exact pin) in package.json dependencies; the bundled Kokoro-82M q8 ONNX + config/tokenizer/voice packs, kuromoji IPADIC dictionary, and onnxruntime-web `.wasm` binaries staged as same-origin static assets under `public/models/`; Workbox `globPatterns` extended to include `onnx` and `bin` (and `wasm`/`json`/`txt` for the dict + config) for the model directory; `maximumFileSizeToCacheInBytes` raised to admit the tens-of-MB q8 model and multi-MB dictionary **OR** a `runtimeCaching` `CacheFirst` route for the `public/models/**` glob (cache-on-first-authoring-use) — coordinate the precache-vs-runtime-cache choice with pwa-shell, do not redesign their VitePWA block
  - Behavior: this is the FIRST task — it only adds dependencies, stages assets, and wires the build/precache config; it writes NO module logic. Pin the exact 3.x of @huggingface/transformers that ships the Kokoro pipeline + onnxruntime-web WebGPU backend, confirmed at install (dependencies.md @ Validation; design §8 item 4)
  - Handles: the default Workbox size limit silently dropping large assets from precache (the offline-break bug, dependencies.md @ D-017) — the glob+limit (or CacheFirst route) is the fix; `registerType:'prompt'` (D-017) is unaffected (assets are content-hashed)
  - Tests: `npm install` resolves both packages at the pinned versions; the bundled `kokoro` model `.onnx` + voice config and the kuromoji dictionary files exist under `public/models/` at the app origin; a production build's generated SW precache manifest **includes** the model `.onnx`/`.bin` and dictionary (NOT silently excluded by the default size limit) OR they are covered by a `CacheFirst` runtimeCaching route; `vite dev` still emits no SW; the existing pwa-shell build tests stay green
  - Ripple: pwa-shell owns `vite.config.ts` `VitePWA()`; coordinate the Workbox change with that module — do not duplicate or fork its manifest/registration config

- [x] [impl] Author the module types, the VOICES config table, the TtsError class, and the dependency-free WAV encoder | file: src/engine/clip-sources/tts-local.ts | model: T1Lite
  - Ref: .dev/planning/modules/tts-local/interfaces.md @ 3. Module types (TtsLanguage, TtsInput, TtsAdapterOptions)
  - Ref: .dev/planning/modules/tts-local/interfaces.md @ 5. Errors (TtsErrorCode, TtsError — name:'TtsError', code, optional cause)
  - Ref: .dev/planning/modules/tts-local/interfaces.md @ 2. Imported contracts (from clip-library — import ClipSourceAdapter/ClipDraft/ClipMeta/ClipSource type-only; do NOT redefine)
  - Ref: .dev/planning/modules/tts-local/design.md @ 3.4 Voices & languages (D-033) (the VOICES table maps each language → its allowed Kokoro speaker ids + a default voice — a config constant, not an architectural decision)
  - Ref: .dev/planning/modules/tts-local/design.md @ 3.7 Encoding (D-037 context) (WAV PCM-16 mono @ model sample rate; a few dozen lines writing a RIFF/WAVE header + clamped 16-bit samples; format:'audio/wav')
  - Accepts: nothing at runtime — declarative types, the `VOICES` constant, the `TtsError` class, and a `pure` `encodeWav(pcm: Float32Array, sampleRate: number): Blob` helper
  - Creates: `TtsLanguage`/`TtsInput`/`TtsAdapterOptions` exports; `TtsError extends Error` with `name:'TtsError'`, readonly `code: TtsErrorCode`, optional `cause`; the `VOICES` table (per-language allowed speaker id set + default); `encodeWav` (RIFF/WAVE header + samples clamped to [-1,1] then scaled to 16-bit signed, little-endian, mono, model sample rate) returning a `Blob` with type `'audio/wav'`
  - Behavior: type-only import of the clip-library contracts (no storage functions); `TtsError` always wraps — it never lets a raw library error escape (interfaces.md §5)
  - Handles: WAV encoder clamps out-of-range/NaN samples so a malformed PCM frame never produces invalid 16-bit output (the encoder is the last guard before the duration assertion)
  - Tests: each `TtsErrorCode` constructs a `TtsError` whose `name==='TtsError'`, `code` is set, and `.cause` is preserved when passed; `encodeWav` produces a valid 44-byte-header WAV whose declared sample rate, mono channel count, and PCM-16 sample count match the input Float32 length; samples outside [-1,1] and NaN clamp without overflow; a decoded round-trip of the WAV has the same sample count as the input PCM (duration parity)
  - Stubs expected: the engine loader, G2P, synth, and `produce` are stubbed/absent until the next two tasks resolve them — register a stub for `createTtsAdapter` if this task lands it as a not-yet-functional shell

- [x] [impl] Implement the lazy engine loader: webgpu→wasm device negotiation, offline Kokoro ONNX load, and lazy kuromoji dictionary | file: src/engine/clip-sources/tts-local.ts | model: T1
  - Ref: .dev/planning/modules/tts-local/design.md @ 3.1 Library & model (D-032, D-033) (Transformers.js + Kokoro-82M ONNX dtype q8 via onnxruntime-web)
  - Ref: .dev/planning/modules/tts-local/design.md @ 3.2 Lazy load, single warm session (module-internal lazily-initialized Promise; first produce awaits, later produce reuses; a FAILED load is NOT cached forever — next produce retries)
  - Ref: .dev/planning/modules/tts-local/design.md @ 3.3 Device negotiation (webgpu → wasm) (probe navigator.gpu + requestAdapter; construct-time fallback re-attempts ONCE on wasm; same PCM either way; COOP/COEP / crossOriginIsolated detected only to inform, never required)
  - Ref: .dev/planning/modules/tts-local/design.md @ 6. Model bundling (truly offline — D-032) (env.allowRemoteModels = false; env.localModelPath → bundled dir; env.backends.onnx.wasm.wasmPaths → app origin; any hub fetch becomes a hard error)
  - Ref: .dev/planning/modules/tts-local/edge-cases.md @ 1. Model load failure (corrupt/missing weights, ORT wasm instantiate fail, OOM → MODEL_LOAD_FAILED with .cause; webgpu construct fail → re-attempt once on wasm; remote-fetch-while-offline → loud MODEL_LOAD_FAILED; failed load promise not cached permanently)
  - Ref: .dev/planning/modules/tts-local/edge-cases.md @ 2. WebGPU unavailable (no navigator.gpu → wasm, NOT an error; crossOriginIsolated false → single-threaded wasm, correct but slower; forced device:'webgpu' on a machine without it → caught + retried on wasm)
  - Ref: .dev/planning/modules/tts-local/edge-cases.md @ 6. Concurrency & lifecycle (concurrent produce during load all await the SAME in-flight promise — no double-load, no GPU thrash)
  - Accepts: `TtsAdapterOptions` (device/dtype/modelPath/modelId resolved to effective values); `self.crossOriginIsolated` / `navigator.gpu`
  - Creates: a closure-local `ensureEngine()` returning a memoized `Promise<Engine>` where `Engine` holds the warm Kokoro pipeline (ONNX session); a separate lazily-memoized `ensureKuromoji()` loaded ONLY on the first `language:'ja'` request; the device-negotiation routine (auto → probe webgpu else wasm; webgpu construct failure → retry once on wasm → else `MODEL_LOAD_FAILED`); `env.allowRemoteModels=false` + `env.localModelPath` + `env.backends.onnx.wasm.wasmPaths` set once before load
  - Behavior: `createTtsAdapter` itself does NO I/O and never throws (design §3.2) — all loading is deferred to the first `produce`. A rejected load promise is discarded so the NEXT `produce` retries (a transient OOM must not brick the adapter for the page lifetime). Concurrent first calls await the single in-flight promise
  - Handles: webgpu probe-pass-then-construct-fail (retry wasm); webgpu absent (wasm, no error); crossOriginIsolated absent (single-threaded wasm, detect-to-inform only); remote-fetch-while-offline (allowRemoteModels=false → MODEL_LOAD_FAILED, never a silent network call — proves the D-032 "never touches the network" invariant); kuromoji dict load failure → `PHONEMIZER_UNAVAILABLE` scoped to JA only (en/es/fr unaffected because the dict loads only on the first JA line)
  - Tests: first `ensureEngine()` loads once and is reused (one load for N concurrent callers — assert single underlying load); a thrown webgpu construction is caught and the wasm path succeeds (mock the runtime); a forced `device:'webgpu'` on a no-GPU mock still resolves via wasm; a load rejection rejects the first `produce` with `MODEL_LOAD_FAILED` (`.cause` preserved) AND the NEXT `produce` retries the load (not cached); with `allowRemoteModels=false`, a simulated hub-resolution attempt surfaces as `MODEL_LOAD_FAILED`, never a network fetch; kuromoji dict failure rejects only `language:'ja'` and leaves en/es/fr loadable
  - Resolves stubs: the engine-load portion of the `createTtsAdapter` shell from the previous task

- [x] [impl] Implement createTtsAdapter.produce: validate/normalize → SHA-256 hash → G2P (espeak en/es/fr, kuromoji ja) → synth Float32 PCM → WAV encode → measure durationSec → ClipDraft, with serialized synthesis | file: src/engine/clip-sources/tts-local.ts | model: T1 [data]
  - Ref: .dev/planning/modules/tts-local/interfaces.md @ 1. Authoritative contract (phase2-audio-architecture.md §6, verbatim) (createTtsAdapter(opts?) → ClipSourceAdapter over { text; voice?; language?; rateScale? }; produce → ClipDraft hash=SHA256(model+voice+lang+text+rate))
  - Ref: .dev/planning/modules/tts-local/interfaces.md @ 4. Factory (the public surface) (returned { source:'tts'; produce }; concrete ClipDraft shape incl. meta.name/language/voice/text)
  - Ref: .dev/planning/modules/tts-local/design.md @ 2. Input, output, and the produce() pipeline (the fixed 8-step pipeline; validate before any model work; duration from sample count; meta.name = first few words)
  - Ref: .dev/planning/modules/tts-local/design.md @ 4. Content hash & ClipDraft (the clip-library contract) (hash = hex(SHA-256(utf8(join(model,voice,lang,text,rate)))) over NORMALIZED inputs; NUL separator; encoding+device excluded; crypto.subtle.digest, no hashing lib; resolved voice, clamped+canonical-formatted rate e.g. '1.00')
  - Ref: .dev/planning/modules/tts-local/design.md @ 3.3 Device negotiation / 3.5 Japanese G2P (D-033, D-037) (Latin G2P via Kokoro espeak-ng; ja via kuromoji → katakana readings → Kokoro JA voice)
  - Ref: .dev/planning/modules/tts-local/design.md @ 3.6 Rate scaling (rateScale clamped to [0.5,2.0], NaN/Infinity → 1.0; part of the hash; default 1.0)
  - Ref: .dev/planning/modules/tts-local/design.md @ 7. Lifecycle, concurrency & performance (serialized synthesis — internal promise chain queues overlapping produce calls so the single ONNX session is not re-entered; each resolves its own draft)
  - Ref: .dev/planning/modules/tts-local/edge-cases.md @ 4. Unsupported / mismatched language & voice (UNSUPPORTED_LANGUAGE + UNKNOWN_VOICE before model work; voice omitted → default; language omitted → 'en')
  - Ref: .dev/planning/modules/tts-local/edge-cases.md @ 5. Empty / degenerate text (EMPTY_TEXT before model work; non-finite/empty PCM → SYNTHESIS_FAILED; duration finite>0 assertion is the guard)
  - Ref: .dev/planning/modules/tts-local/edge-cases.md @ 7. Hash / dedup correctness (same effective request via different inputs hashes identically — normalized basis; model/dtype upgrade changes modelId→hash; device/encoding excluded)
  - Ref: .dev/planning/modules/tts-local/edge-cases.md @ 8. Out-of-range rate / @ 9. Storage & secure-context (clamp not reject; crypto.subtle unavailable → reject wrapped, surfaced not swallowed)
  - Accepts: `TtsInput` `{ text; voice?; language?; rateScale? }`
  - Creates: the `produce(input)` implementation running design §2's 8-step pipeline; returns `ClipDraft{ hash, blob, format:'audio/wav', durationSec, source:'tts', meta:{ name, language, voice, text } }`; an internal synthesis queue (promise chain) serializing overlapping synth calls on the shared session
  - Behavior: validate & normalize FIRST (trim text, resolve default voice/language, clamp rateScale, canonical-format rate as e.g. '1.00') and reject validation failures (EMPTY_TEXT/UNSUPPORTED_LANGUAGE/UNKNOWN_VOICE) **before** `ensureEngine()`; compute the hash from the NORMALIZED inputs (resolved voice, clamped rate, trimmed text) joined with a NUL separator via `crypto.subtle.digest('SHA-256', …)`; route en/es/fr through Kokoro's espeak-ng G2P and ja through `ensureKuromoji()` → readings → Kokoro JA voice; map `rateScale` to Kokoro's speed param; measure `durationSec = pcm.length / sampleRate` and assert finite > 0 before packaging; `meta.name` = the first few words of the normalized text
  - Handles: empty/whitespace text (EMPTY_TEXT); bad language (UNSUPPORTED_LANGUAGE); voice not in the requested language's VOICES set (UNKNOWN_VOICE); kuromoji throw / no usable reading (PHONEMIZER_UNAVAILABLE, JA-scoped); empty/NaN/non-finite PCM or non-finite duration (SYNTHESIS_FAILED); rateScale out of range / NaN / Infinity (clamp, never reject); crypto.subtle absent in an insecure context (reject wrapped, never silently skip the hash); `produce` ALWAYS rejects with a typed `TtsError` (`.cause` preserved), never throws synchronously
  - Tests: a valid en line resolves a ClipDraft with `source:'tts'`, `format:'audio/wav'`, `durationSec` finite>0, and `meta` carrying resolved language/voice/normalized text + a short name; the SAME line at the SAME voice/lang/rate hashes IDENTICALLY, and `voice` omitted vs. explicitly passing the default id hash identically, and `rateScale:1` vs `1.0` hash identically (normalized basis); different rate/voice/lang → different hash; EMPTY_TEXT/UNSUPPORTED_LANGUAGE/UNKNOWN_VOICE reject before any engine load (assert no load triggered); rateScale 5 / -1 / NaN / Infinity clamp into [0.5,2.0] (NaN/Inf → 1.0) and the clamped value is what enters the hash; non-finite/empty mock PCM → SYNTHESIS_FAILED; a JA line routes through kuromoji and a kuromoji failure → PHONEMIZER_UNAVAILABLE while en/es/fr still succeed; overlapping produce calls serialize (queue) and each resolves its own correct draft; every rejection is a `TtsError` (never a raw library error/DOMException)
  - Resolves stubs: the `produce` portion of the `createTtsAdapter` shell — after this task the adapter is fully functional
  - Ripple: `voice-script` (D-034) and the authoring `ui` consume `createTtsAdapter` / the `ClipDraft` shape — they read `meta.name`/`language`/`voice`/`text` and `durationSec`; confirm no field rename relative to interfaces.md §4

- [!] [test] VALIDATION: measure Kokoro q8 quality + per-line synthesis latency (webgpu vs single-threaded wasm) and confirm kuromoji→Kokoro Japanese G2P quality; record fallback decisions | file: .dev/.task-state/tts-local/q8-ja-validation.md | model: T1Lite
  - STATUS [!] Needs-Attention (2026-06-21): the record `.dev/.task-state/tts-local/q8-ja-validation.md` is written; the desk-verifiable items are RESOLVED (item 4 dep versions §1; item 3 first-run size/precache §2) and the architecture is reconciled to D-039 (kokoro-js + HF-hub fetch, kuromoji NOT on the JA path, WebGPU pinned off). Items 1 & 2 (q8 audible quality + per-line latency on webgpu vs single-threaded WASM; Japanese G2P quality) REQUIRE A USER-MACHINE PASS — the §4 protocol + §5 checklist must be filled (an agent cannot run WebGPU or listen). Provisional verdict: GO on q8 + kokoro-js JA + WASM + hub-fetch. Flip to [x] once §4/§5 are filled and §6 confirmed.
  - Ref: .dev/planning/modules/tts-local/design.md @ 8. Validation tasks (Tier-5, flagged not assumed) (item 1 q8 quality & latency; item 2 Japanese G2P quality; item 3 bundle size / precache; item 4 exact dependency versions)
  - Ref: .dev/planning/modules/tts-local/design.md @ 3.1 Library & model / 3.5 Japanese G2P (the q8 footprint/quality balance D-031/D-037; kuromoji→Kokoro v1 JA path; sherpa-onnx VITS the documented fallback)
  - Ref: .dev/planning/modules/tts-local/design.md @ 7. Lifecycle, concurrency & performance (per-line latency on webgpu and single-threaded WASM sets the authoring progress UX — a measured number, not a Tier-3 assumption)
  - Ref: .dev/planning/modules/tts-local/edge-cases.md @ 3. Japanese phonemizer unavailable (the sherpa-onnx VITS JA-arm swap is behind produce; only JA clips re-synthesize because modelId is in the hash)
  - Ref: .dev/planning/modules/tts-local/dependencies.md @ Bundled model / data artifacts + @ D-017 PWA precache implication (measure the total bundled artifact size to feed the precache-vs-runtime-cache decision with pwa-shell)
  - Accepts: the implemented `createTtsAdapter` (synth path working) + a representative set of authoring lines per language (en/es/fr/ja)
  - Creates: a written measurement record at `.dev/.task-state/tts-local/q8-ja-validation.md` — q8 audible-quality verdict per language, per-line synthesis latency on webgpu and on single-threaded WASM (no COOP/COEP), the total bundled artifact size, and a GO/FALLBACK decision: KEEP q8 or switch dtype to `fp32`/`q4` (a `modelId`/config change, not an architecture change), and KEEP kuromoji→Kokoro for JA or switch the `'ja'` arm to the sherpa-onnx VITS documented fallback
  - Behavior: this is the deferred Tier-5 MEASUREMENT carried out of Tier 3 — it does NOT change the `produce` contract; any fallback it triggers (dtype swap, JA-arm swap) is an internal change behind the same contract because `modelId` is in the hash (only the affected clips re-synthesize). If the verdict is FALLBACK, file a follow-up [config]/[impl] task; do not silently leave the assumption unvalidated
  - Handles: q8 audibly poor → dtype fallback recorded; JA quality poor → sherpa-onnx VITS swap recorded; bundle size too large for precache → feeds the pwa-shell runtime-cache (CacheFirst) decision
  - Tests: the validation record exists and states a concrete verdict per language and a measured latency figure for both backends; if it recommends a fallback, the corresponding follow-up task is filed; the existing module unit tests remain green regardless of the verdict (the contract is unchanged)

## Follow-ups (filed from the Tier-5 validation, q8-ja-validation.md §7)

- [x] [config] Resolve the unused `kuromoji` dependency | file: package.json | model: T2
  - D-039 removed kuromoji from the JA path (kokoro-js owns G2P); `kuromoji@^0.1.2` is declared but imported nowhere in `src/` (grep hits only test/comment strings). Either REMOVE it (smaller dep tree) or add a one-line note pinning it as the JA-tokenizer hook reserved for the deferred sherpa-onnx VITS fallback (edge-cases §3). Decide + apply.
  - Ref: .dev/.task-state/tts-local/q8-ja-validation.md @ §1 (dep table), §3 (JA path is kokoro-js, not kuromoji)
  - Tests: full suite stays green; if removed, `grep -rn "kuromoji" src/` returns only the existing test/comment occurrences (no import) and `npm install` still resolves.

- [!] [test] Validate WebGPU (`device:'auto'`) on target GPUs | file: .dev/.task-state/tts-local/webgpu-validation.md | model: T1Lite
  - STATUS [!] Needs-Attention (2026-06-21): the record `.dev/.task-state/tts-local/webgpu-validation.md` is written; the DESK-VERIFIABLE half is RESOLVED — `device:'auto'` is already the resolver default (tts-local.ts:308), the probe + webgpu→wasm construct-fallback are in place, and `device` is excluded from the content hash (tts-local.ts:282) so the `wasm`→`auto` flip causes ZERO clip churn and the device-agnostic suite stays green (41 passed). Key finding (§2): the existing fallback catches a construct THROW, not a HANG, which is why the flip cannot ship on faith. The per-GPU "does it hang?" pass REQUIRES A USER-MACHINE GPU+browser session (an agent cannot run WebGPU) — §3 protocol + §4 fill-in table. Flip to [x] once §4 is filled; if all-GO, apply the §5 `bootstrap.ts:110` flip (`device:'wasm'`→`'auto'`) and confirm the full suite stays green.
  - Production pins `device:'wasm'` (bootstrap.ts:110) because WebGPU/JSEP can hang on some GPUs (D-039). Confirm WebGPU does not hang on the target machines, then re-enable `device:'auto'`. This is also the prerequisite for the q8-ja-validation §4 WebGPU latency column.
  - Ref: .dev/.task-state/tts-local/q8-ja-validation.md @ §4 (WebGPU note), §6 (device verdict)
  - Tests: a record stating WebGPU GO/NO-GO per tested GPU; if GO, `bootstrap.ts` flips to `device:'auto'` and the suite stays green (device is excluded from the hash, so no clip churn).

## Behavioral Audit (runs after all tasks above are [x])

- [x] [audit] Module behavioral audit: tts-local | file: .dev/.task-state/tts-local/behavioral-audit.md | model: T1
  - DONE (2026-06-21): PASS. Every public interface (`createTtsAdapter` → `{source:'tts';produce}` → `ClipDraft`, all 6 `TtsErrorCode`s, `encodeWav`) traces input → observable output; `produce` always rejects with a typed `TtsError`, never throws synchronously, never returns a malformed (zero/non-finite-duration) draft. Offline-path firewall verified (no transport/renderer/mixer/layer-engine/layer-scheduler import). Consumer `voice-script` reads `clip.durationSec` via `importVia` with correct field names. Full suite 1294 green; cohesion guardrails green. Two design-doc divergences are INTENTIONAL per D-039 (hub-fetch vs bundled-offline; kokoro-js vs kuromoji G2P) and preserve the observable contract — filed as a doc-reconciliation cleanup below. No CRITICAL/FIX. Report: .dev/.task-state/tts-local/behavioral-audit.md
  - Ref: C:/Projects/.dev-shared/behavioral-audit.md — Module Behavioral Audit checklist
  - Ref: .dev/planning/modules/tts-local/interfaces.md — every public interface (createTtsAdapter, the returned { source:'tts'; produce }, the ClipDraft shape incl. meta, TtsInput/TtsAdapterOptions, TtsError + codes) must trace input → implementation → observable output
  - Ref: .dev/planning/modules/tts-local/design.md — verify intended behavior: pure/synchronous factory, lazy single warm load, webgpu→wasm fallback, normalized-input hash, authoring-only (never on the playback/offline path), serialized synthesis, duration finite>0
  - Ref: .dev/planning/modules/tts-local/edge-cases.md — verify every documented edge case (§1 model load incl. retry-not-cached + remote-fetch-loud-fail, §2 webgpu/COOP-COEP fallbacks, §3 JA phonemizer scoped failure, §4 lang/voice, §5 empty/degenerate text + SYNTHESIS_FAILED, §6 concurrency/lifecycle, §7 hash/dedup, §8 rate clamp, §9 secure-context) has evidence of handling and degrades to a typed TtsError
  - For each public interface: trace input → implementation → observable output (a real synthesized ClipDraft and each TtsError code)
  - For each consumer (`voice-script`, authoring `ui`): verify they read the correct field names/shapes (`meta.name`/`language`/`voice`/`text`, `durationSec`, `hash`, `source:'tts'`) and that nothing on the playback/offline-render path imports this module (the §5 firewall — grep `transport`/`renderer`/`mixer`/`layer-engine`/`layer-scheduler` for any `clip-sources/tts-local` import; must be NONE)
  - Confirm `produce` always rejects with a typed `TtsError` (never a raw library error/DOMException), never throws synchronously, and never returns a malformed (zero/non-finite-duration) ClipDraft
  - Confirm the cohesion guardrail suites (`automation.test.ts`, `audio-engine.test.ts`, `transport-master-gain.test.ts`) are byte-identical and green (this module is additive/authoring-only and must not regress them)
  - Write findings to .dev/.task-state/tts-local/behavioral-audit.md
  - PASS required before marking this module complete

## Cleanup

- [x] [cleanup] Reconcile design.md/edge-cases.md to D-039 (hub-fetch + kokoro-js G2P) | file: .dev/planning/modules/tts-local/design.md, .dev/planning/modules/tts-local/edge-cases.md | model: T2
  - Ref: behavioral audit 2026-06-21 — the implementation deliberately diverges from the as-written planning docs per recorded decision D-039: (1) model source is kokoro-js fetching from the HF hub on first use then browser-caching (offline thereafter), NOT `env.allowRemoteModels=false` bundled-offline (design §6); edge-cases §1 "remote-fetch-while-offline → loud MODEL_LOAD_FAILED" no longer applies as written. (2) kokoro-js owns G2P for all languages, NOT kuromoji (design §3.5 / edge-cases §3) — the observable `PHONEMIZER_UNAVAILABLE` (JA-scoped) contract is preserved. Update design.md §3.1/§3.5/§6 and edge-cases §1/§3 to match the shipped D-039 behavior; the public contract (interfaces.md) is unchanged and needs no edit.
  - DONE 2026-06-21: design.md §3.1 updated to kokoro-js + hub-fetch; §3.5 rewritten (kokoro-js owns G2P, PHONEMIZER_UNAVAILABLE preserved JA-scoped, sherpa-onnx fallback retained); §6 rewritten (hub-fetch first use, browser-cache offline after, no allowRemoteModels/localModelPath). edge-cases §1 third bullet updated (first-use offline failure); §3 rewritten (kokoro-js JA engine, no kuromoji). Remaining stale refs in §1/§2/§3.2/§3.3/§3.4/§8 added as new cleanup task below.

- [x] [cleanup] Reconcile design.md §1/§2/§3.2/§3.3/§3.4/§8 residual D-039 stale refs | file: .dev/planning/modules/tts-local/design.md | model: T2
  - Ref: doc-reconciliation 2026-06-21 — after updating §3.1/§3.5/§6 these sections still reference the pre-D-039 design: (a) §1 "What it does NOT do" bullet says "not fetch from HF hub; bundled/precached; never touches network"; (b) §2 step 4 says "Japanese via kuromoji.js (D-037, §3.3)"; (c) §3.2 says "The ONNX session and the kuromoji dictionary are expensive to load"; (d) §3.3 says "Transformers.js runs the ONNX graph on a device"; (e) §3.4 table JA row says "kuromoji.js → phonemes | dictionary G2P (§3.3, D-037)" (§3.3 ref is also wrong — JA G2P is §3.5); (f) §8 item 2 says "kuromoji.js → Kokoro Japanese" and item 4 says pin "@huggingface/transformers and kuromoji". Update each to match D-039 (kokoro-js + hub-fetch; kokoro-js G2P for all languages). No contract change.
  - DONE 2026-06-21: all six stale refs corrected — (a) §1 network bullet rewritten to hub-fetch-first-use/cache-after; (b) §2 step 4 updated to kokoro-js owns all-language G2P with §3.5 ref; (c) §3.2 kuromoji-dict mention removed; (d) §3.3 "Transformers.js" → "kokoro-js"; (e) §3.4 JA row updated to kokoro-js G2P / §3.5 / D-039; (f) §8 item 2 updated to kokoro-js / §3.5, item 3 "dictionary" removed, item 4 updated to kokoro-js only.

- [x] [cleanup] Reconcile design.md §7 residual D-039 stale ref — kuromoji dict mention | file: .dev/planning/modules/tts-local/design.md | model: T2
  - Ref: doc-reconciliation 2026-06-21 — §7 "Lazy single load" bullet still reads "the engine (ONNX session + kuromoji dict) loads on first `produce`". D-039 removed kuromoji; kokoro-js owns all G2P. Remove "and the kuromoji dict" / "+ kuromoji dict" to match. No contract change.
  - DONE 2026-06-21: removed "+ kuromoji dict" from §7 "Lazy single load" bullet; now reads "the engine (ONNX session) loads on first `produce`".

- [x] [cleanup] Reconcile tasks.md Agent Briefing residual D-039 stale refs — Transformers.js + kuromoji | file: .dev/modules/tts-local/tasks.md | model: T2
  - Ref: doc-reconciliation 2026-06-21 — Agent Briefing line reads "Kokoro-82M ONNX (dtype `q8`) entirely in-browser, offline (Transformers.js, webgpu→wasm; kuromoji for Japanese G2P)". D-039 replaced Transformers.js with kokoro-js and removed kuromoji from the JA path. Update to "kokoro-js, webgpu→wasm; kokoro-js owns G2P for all languages". No contract change.
  - DONE 2026-06-21: Agent Briefing updated — "(Transformers.js, webgpu→wasm; kuromoji for Japanese G2P)" → "(kokoro-js, webgpu→wasm; kokoro-js owns G2P for all languages)". No contract change.

## Completion Criteria
- [ ] All tasks above marked [x] — zero tasks left [ ] (Pending) or [!] (Needs-Attention) — BLOCKED: q8-ja-validation and webgpu-validation remain [!] pending a USER-MACHINE pass (an agent cannot run WebGPU or judge audible quality)
- [x] Zero active stubs for this module — the `createTtsAdapter` shell stub is resolved (produce fully implemented); the sherpa-onnx JA fallback stays a registered deferral per design §3.5 / edge-cases §3, not an active blocker
- [x] All module tests passing (full suite, not just this module's tests) — `npx vitest run` green: 1294 passed / 59 files (2026-06-21)
- [x] Cohesion guardrails green: `automation.test.ts`, `audio-engine.test.ts`, `transport-master-gain.test.ts` all pass (behavior intact; `automation`/`audio-engine` show git-modified from broader Phase-2 branch churn, not this module — byte-identical claim deferred to the Phase-2 checkpoint)
- [x] Offline-path firewall verified: no `transport` / `renderer` / `mixer` / `layer-engine` / `layer-scheduler` import of `clip-sources/tts-local` (design §5) — grep-confirmed 2026-06-21
- [x] Audit PASS for every task (per-task audits passed; behavioral audit PASS this date)
- [x] last-step-summary.md written for every task with a concrete Observable Verification entry
- [x] Behavioral audit PASS (see the [audit] task above) — .dev/.task-state/tts-local/behavioral-audit.md
