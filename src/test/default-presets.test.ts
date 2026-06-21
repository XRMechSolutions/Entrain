import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from '../engine/session-model';
import type { Preset } from '../engine/session-model';

// The built-in session presets live at the repo root in presets/ — the canonical files
// the library seed imports and anyone can import/share. This guarantees they parse +
// validate as schema v5 (i.e. import without error) and end the way they should.
const PRESETS_DIR = resolve(process.cwd(), 'presets');
const NAPS = ['power-nap-20.json', 'power-nap-40.json', 'power-nap-60.json'];
const SLEEP_FADE = ['8h-sleep-cycles.json'];

// Every shippable/shareable preset file in presets/ — the focus/create/nap/sleep JSON
// anyone can import. The whole directory is held to the "imports without error" bar, so a
// newly added preset can never silently rot the import path.
const ALL_PRESETS = readdirSync(PRESETS_DIR)
  .filter((f) => f.endsWith('.json'))
  .sort();

function load(file: string): Preset {
  const res = parse(readFileSync(resolve(PRESETS_DIR, file), 'utf8'));
  if (!res.ok) {
    console.error(`${file} validation issues:`, JSON.stringify(res.issues, null, 2));
    throw new Error(`${file} did not validate as schema v5`);
  }
  return res.preset;
}

describe('Every preset in presets/ parses + validates as schema v5', () => {
  it('the directory is non-empty (guards against a broken glob)', () => {
    expect(ALL_PRESETS.length).toBeGreaterThan(0);
  });

  for (const file of ALL_PRESETS) {
    it(`${file} imports without error and has a positive duration`, () => {
      expect(load(file).durationSec).toBeGreaterThan(0);
    });
  }
});

describe('Built-in session presets are valid v5 and import cleanly', () => {
  for (const file of [...NAPS, ...SLEEP_FADE]) {
    it(`${file} parses with a positive duration`, () => {
      expect(load(file).durationSec).toBeGreaterThan(0);
    });
  }

  for (const file of NAPS) {
    it(`${file} ends awake (volume up + beta beat — wakes you)`, () => {
      const last = load(file).nodes.at(-1)!;
      expect(last.volume?.value ?? 1).toBeGreaterThan(0);
      expect(last.beat?.value ?? 0).toBeGreaterThanOrEqual(12);
    });
  }

  for (const file of SLEEP_FADE) {
    it(`${file} ends silent (fades out — leaves you asleep)`, () => {
      expect(load(file).nodes.at(-1)!.volume?.value).toBe(0);
    });
  }
});
