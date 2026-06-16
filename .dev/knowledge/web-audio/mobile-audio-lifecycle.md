---
topic: mobile web audio lifecycle - autoplay, background, mediasession
status: current
last-updated: 2026-06-14
tags: [web-audio, mobile, autoplay, background-audio, mediasession, ios, android]
source-url:
  - https://developer.chrome.com/blog/web-audio-autoplay/
  - https://web.dev/articles/media-session
  - https://developer.chrome.com/blog/media-session/
  - https://bugs.webkit.org/show_bug.cgi?id=276016
---

# Mobile Web Audio Lifecycle

## Start: autoplay policy (verified)

`AudioContext` is created **suspended** outside a user gesture. In the user's Start
tap, call `ctx.resume()` AND `osc.start()` — Chrome auto-resumes once the page has
been interacted with and a source node starts.

## Background / locked-screen survival (best-effort, empirical)

Pure Web Audio does **not** acquire Android audio focus ("for historical reasons"),
so an oscillator-only AudioContext gets no MediaSession and is prone to suspension
when backgrounded. The cited fix:

1. Route the graph through `createMediaStreamDestination()`.
2. Attach `dest.stream` to a hidden `<audio>` via `audio.srcObject`, and `play()` in
   the same gesture → an audible media element that holds audio focus.

**Caveat (verified uncertain):** no authoritative source confirms a MediaStream-backed
`<audio>` reliably keeps persistent media focus with the screen off on Android — it
**must be device-tested**; a looping near-silent audio *file* element is the more
commonly cited anchor if the stream approach fails. Audio focus/notifications need
effective media duration ≥ 5 s. Tell Android users to disable Chrome battery
optimization; it's battery-limited.

## MediaSession (lock-screen controls)

Once a media element is audible: set `navigator.mediaSession.metadata` (title = preset
name, artwork 256/512), `playbackState`, and `setActionHandler` for
`play`/`pause`/`stop` (stop = fade out + teardown + clear metadata). Wrap each in
try/catch; feature-detect. MediaSession does **not** itself sustain audio — the audible
element does.

## Returning to foreground / iOS

- On `visibilitychange` to visible: if `ctx.state !== 'running'`, `resume()`.
- **iOS** Safari moves the context to the non-standard `'interrupted'` state when
  backgrounded/screen-off; `resume()` alone can get stuck (WebKit bug 276016) — use
  `suspend()` then `resume()` on visibilitychange. iOS background audio is unreliable
  regardless; treat as best-effort.
- Note: an audible tab is still "hidden" per the Page Visibility API; audio only
  exempts it from *intensive* timer throttling — it does not make the tab foreground.

## Sources
- Chrome: Web Audio Autoplay Policy; Media Session blog
- web.dev: Media Session API (5 s focus rule)
- MDN BaseAudioContext.state (iOS interrupted); WebKit bug 276016
