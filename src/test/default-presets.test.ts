import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from '../engine/session-model';
import type { Preset } from '../engine/session-model';

// The built-in power-nap presets live at the repo root in presets/ — the canonical files
// the library seed imports and anyone can import/share. This guarantees they parse +
// validate as schema v3 (i.e. import without error) and end awake (the ascending wake).
const NAPS = ['power-nap-20.json', 'power-nap-40.json', 'power-nap-60.json'];

function load(file: string): Preset {
  const res = parse(readFileSync(resolve(process.cwd(), 'presets', file), 'utf8'));
  if (!res.ok) {
    console.error(`${file} validation issues:`, JSON.stringify(res.issues, null, 2));
    throw new Error(`${file} did not validate as schema v3`);
  }
  return res.preset;
}

describe('Built-in nap presets are valid v3 and import cleanly', () => {
  for (const file of NAPS) {
    it(`${file} parses and ends awake (volume up + beta beat — wakes you)`, () => {
      const p = load(file);
      expect(p.durationSec).toBeGreaterThan(0);
      const last = p.nodes[p.nodes.length - 1];
      expect(last.volume?.value ?? 1).toBeGreaterThan(0);
      expect(last.beat?.value ?? 0).toBeGreaterThanOrEqual(12);
    });
  }
});
