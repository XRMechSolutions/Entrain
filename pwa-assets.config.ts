import { defineConfig, minimal2023Preset } from '@vite-pwa/assets-generator/config';

// Deterministic icon generation (design.md §6.1, interfaces.md §7). One source SVG
// (public/favicon.svg, mark in the central 80% safe circle) feeds the official
// minimal-2023 preset. The maskable and apple backgrounds are overridden to opaque
// #0B0F14 so those icons fill to the full edge with no transparent corners (iOS adds
// its own rounded mask; Android applies an adaptive mask). Outputs are committed to
// /public — they are static assets, NOT regenerated at `vite build`.
const OPAQUE_BG = '#0B0F14';

export default defineConfig({
  images: ['public/favicon.svg'],
  preset: {
    ...minimal2023Preset,
    maskable: { ...minimal2023Preset.maskable, resizeOptions: { background: OPAQUE_BG } },
    apple: { ...minimal2023Preset.apple, resizeOptions: { background: OPAQUE_BG } },
  },
});
