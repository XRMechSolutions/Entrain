# Entrain

[![License: GPL v3](https://img.shields.io/badge/License-GPLv3-blue.svg)](LICENSE)
[![Deploy to GitHub Pages](https://github.com/XRMech/entrain/actions/workflows/deploy.yml/badge.svg)](https://github.com/XRMech/entrain/actions/workflows/deploy.yml)

**An offline-first web app for binaural beats, isochronic tones, spatial pan, and breath‑paced sessions — with exact‑frequency Web Audio synthesis and full per‑node automation.**

🔊 **Live demo (installable PWA): [xrmech.github.io/entrain](https://xrmech.github.io/entrain/)** — open it on your phone and choose **Install** / **Add to Home Screen**. Headphones recommended for the binaural effect.

Entrain is a Progressive Web App (PWA): it runs in any modern browser, installs to your phone or desktop, and works **fully offline** after the first load. Everything is synthesized live in the browser — no audio files, no account, no tracking, no server.

> ⚠️ **Please read the [Safety & honesty note](#-safety--honesty) below.** Entrain is an experimental relaxation/focus tool, **not** a medical device, and it makes **no** medical or therapeutic claims.

---

## ✨ Features

- **Binaural beats** — two precise tones, one per ear, split symmetrically around a carrier (`L = carrier − beat/2`, `R = carrier + beat/2`) so the perceived pitch stays steady as the beat changes. Needs headphones.
- **Isochronic tones** — a single tone gated on/off in a rhythm (works *without* headphones), with variable duty cycle and click‑free raised‑cosine edges.
- **Spatial pan** — move the sound left↔right; pair it with a breathing rate and the moving "source" becomes a breath pacer you can follow with your eyes closed.
- **Per‑node automation timeline** — define a session as a series of time nodes; *every* parameter (carrier, beat, volume, spatial, waveform) is keyframable, with linear / exponential / hold / smooth interpolation between nodes.
- **Modulators on any parameter** — sine / triangle / square / pulse / **box** (a breath‑shaped trapezoid: inhale‑ramp → hold → exhale‑ramp → hold), so you can warble a frequency or breathe‑pace anything.
- **A live experimentation console** — every setting is a slider on the main page; tweak it, hear it instantly.
- **An advanced node editor** — add/move/remove nodes on a timeline and edit each node with the full control set plus its interpolation.
- **A built‑in session library** — 20 / 40 / 60‑minute power naps (sleep fast → hold → ascend to a gentle wake), plus band/use starters. Import/export your own sessions as JSON.
- **PWA**: installable, offline, with mobile background‑audio handling.

---

## 🚀 Quick start

You need **[Node.js](https://nodejs.org/) 20 or newer** (which includes `npm`). That's the only prerequisite — the project's dependencies are listed in `package.json` and installed with one command.

### Windows (one‑click)

1. Double‑click **`setup.bat`** — it checks for Node.js (and offers to install it via `winget` if it's missing), then runs `npm install`.
2. Double‑click **`start.bat`** — opens the app at `http://localhost:5173`. (It also prints a `Network:` URL you can open on your phone over the same Wi‑Fi.)

For the installable, offline production build, double‑click **`preview.bat`**.

### Any OS (manual)

```bash
git clone https://github.com/XRMech/entrain.git
cd entrain
npm install          # installs the dependencies from package.json
npm run dev          # dev server at http://localhost:5173
```

To build and preview the production PWA:

```bash
npm run build
npm run preview
```

> 📱 **On your phone:** the audio + UI work over plain `http` on your local network (open the `Network:` URL). Installing the PWA and offline mode require a **secure context (https)** — use `localhost` on a desktop, or an https tunnel to your phone.

---

## 🎧 Using it

- Put on **headphones** for the binaural effect (isochronic and monaural‑style content also works on speakers).
- Tap the big **play** button. Adjust **carrier / beat / volume**, the **modulation** panels, **waveform**, **duration**, and **master volume** live on the main page.
- Open **Library** to load a built‑in session, import/export presets, or tap **Restore defaults** to add any built‑in sessions you're missing (non‑destructive — it never touches your own presets).
- Open **Advanced** to build multi‑node sessions on a timeline.
- Install it: your browser's **Add to Home Screen / Install** option turns it into a standalone app.

---

## 🔬 The science (kept honest)

Entrain takes a deliberately **honest, evidence‑graded** stance — a response to how much of this space overclaims. In short, from the literature:

- The **mechanism** of the binaural beat (a neural illusion created in the brainstem) is well established.
- The **modest effects** on relaxation, anxiety, and attention have some support but are mixed and small.
- The popular claim that a given frequency reliably **"induces" a brain state** is **weakly supported** — the brain does not simply lock to whatever beat you play it.
- Physically present rhythmic audio (**isochronic / monaural**) tends to drive *stronger, better‑evidenced* cortical responses than the binaural illusion — and works without headphones.

The app therefore frames bands and sessions as *"commonly used for…"*, never *"induces state X."* The full, sourced write‑up lives in [`.dev/knowledge/binaural-beats/`](.dev/knowledge/binaural-beats/).

---

## 🧱 Tech stack

- **TypeScript** + **[Svelte 5](https://svelte.dev/)** (runes) — a tiny UI shell over a framework‑agnostic engine.
- **[Vite 6](https://vitejs.dev/)** + **[vite-plugin-pwa](https://vite-pwa-org.netlify.app/)** (Workbox) for the build and the offline service worker.
- **Web Audio API** for synthesis + one **AudioWorklet** for the phase‑continuous pulse/isochronic modulator. No DSP library.
- **[Vitest](https://vitest.dev/)** for tests (700+ unit/component tests).

## 🗂️ Project layout

```
src/
  engine/      # framework-agnostic TS: session model, audio graph, automation, transport, persistence
  ui/          # Svelte 5 shell: stores, screens, components, the node editor
  pwa/         # manifest/icon/asset glue
presets/       # the built-in session presets (also the source the library seeds from)
.dev/          # architecture, the binaural-science knowledge base, and module specs
```

## 🛠️ Development

```bash
npm test          # run the test suite (vitest)
npm run check     # type-check (svelte-check)
npm run build     # production build
```

---

## 🤝 Contributing

Issues and pull requests are welcome. This is a hobby project shared in the hope it's useful — please keep the **honesty stance** (no medical/therapeutic claims, evidence framed fairly) intact in any contribution.

## 📜 License

Entrain is free software, licensed under the **[GNU General Public License v3.0 or later](LICENSE)**.

This program is distributed in the hope that it will be useful, but **WITHOUT ANY WARRANTY**; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU General Public License for more details.

Copyright © 2026 XRMech.

---

## ⚕️ Safety & honesty

Entrain is an **experimental** relaxation/focus tool. It is **not a medical device**, is **not intended to diagnose, treat, cure, or prevent any condition**, and makes **no medical or therapeutic claims**. Evidence for audio brainwave entrainment is modest and mixed (see [the science](#-the-science-kept-honest)).

- **Do not** use it while driving or operating machinery — it is designed to alter alertness, relaxation, and sleep.
- If you have **epilepsy or a seizure disorder**, a heart condition, are **pregnant**, or have any neurological or psychiatric condition, **talk to a doctor before using rhythmic audio stimulation.**
- Keep the **volume moderate** to protect your hearing.
- **Stop** if you feel dizzy, anxious, or unwell.
- Not a substitute for sleep, medical care, or professional advice.

You use this software at your own risk.
