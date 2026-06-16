// Top-level application entry — the module index.html loads (/src/main.ts).
// It runs the UI composition root (src/ui/main.ts), which injects the real
// virtual:pwa-register registerSW and mounts <App> into #app. All wiring lives
// under src/ui/* and src/engine/* ; this file stays a thin, single-purpose entry.
import { bootstrap } from './ui/main';

bootstrap();
