import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

// Plain Svelte 5 single-page PWA (not SvelteKit). vitePreprocess enables
// TypeScript inside <script lang="ts"> blocks. Shared by vite.config.ts (build)
// and vitest.config.ts (tests).
export default {
  preprocess: vitePreprocess(),
};
