# BinauralAudio — Project Index

A node-based **binaural-beat instrument** delivered as a mobile-first PWA. A preset
is a timeline of nodes; each node can set every option (carrier, beat, volume,
waveform, and per-parameter warble/pulse modulators), and the engine interpolates
between nodes. See `planning/vision.md` for the full pitch.

## Where to Pick Up

| I want to... | Go to... |
|---|---|
| See what decisions still need to be made | `.dev/planning/decisions-needed.md` |
| Understand the goal and scope | `.dev/planning/vision.md` |
| See the architecture, engine model, and data schema | `.dev/planning/system-design.md` |
| See resolved decisions (with rationale) | `.dev/planning/decisions-log.md` |
| Understand the binaural-beats science (evidence-graded) | `.dev/knowledge/binaural-beats/index.md` |
| Read a module's design | `.dev/planning/modules/<module>/` *(Tier 3 — in progress)* |
| Find implementation tasks | `.dev/tasks.md` + `.dev/modules/<module>/tasks.md` *(Tier 4 — pending)* |

## Status

Planning. Tiers 1–2 and the binaural-science research are complete. The technical
**Research Phase** (Web Audio, mobile background audio, PWA, UI framework) is
running. Per D-012, full Tier 3–5 planning for **all** modules follows once research
lands.

## Modules (planned — see `planning/system-design.md` §2)

| Layer | Module | Purpose |
|-------|--------|---------|
| 0 | `session-model` | Preset/Node schema + JSON (de)serialization |
| 0 | `audio-engine` | Web Audio node graph for one binaural voice |
| 1 | `automation` | Evaluate node timeline + modulators; schedule onto AudioParams |
| 1 | `transport` | Playback clock, fades, AudioContext lifecycle, Wake Lock, MediaSession |
| 1 | `persistence` | localStorage + file import/export; preset library |
| 2 | `ui` | Mobile-first shell + timeline node editor |
| cfg | `pwa-shell` | Manifest, icons, service worker (offline) |
