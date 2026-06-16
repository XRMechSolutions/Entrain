import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ICON_FILES } from './icon-files';

// Task [data]: the committed icon set generated from one source SVG (design.md §6.1,
// interfaces.md §7, edge-cases B2/B3). Verified by parsing the PNG IHDR for the declared
// pixel size and scanning chunks for tRNS (palette transparency): the `any` icons keep
// transparent corners, while maskable-512 + apple-touch-180 are fully opaque (no
// transparent corners, so adaptive/iOS masks see the dark brand fill to the edge).

const publicDir = join(process.cwd(), 'public');
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function readPng(name: string): Buffer {
  return readFileSync(join(publicDir, name));
}

function pngSize(buf: Buffer): { width: number; height: number } {
  expect(buf.subarray(0, 8).equals(PNG_SIG)).toBe(true);
  // IHDR data starts at byte 16: width (4 BE), height (4 BE).
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

function hasChunk(buf: Buffer, type: string): boolean {
  let off = 8; // skip signature
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off);
    const chunkType = buf.toString('ascii', off + 4, off + 8);
    if (chunkType === type) return true;
    if (chunkType === 'IEND') break;
    off += 12 + len; // length(4) + type(4) + data(len) + crc(4)
  }
  return false;
}

describe('generated icon pixel sizes', () => {
  const expected: Record<string, number> = {
    [ICON_FILES.pwa64]: 64,
    [ICON_FILES.pwa192]: 192,
    [ICON_FILES.pwa512]: 512,
    [ICON_FILES.maskable512]: 512,
    [ICON_FILES.appleTouch180]: 180,
  };

  for (const [file, px] of Object.entries(expected)) {
    it(`${file} is ${px}x${px}`, () => {
      const { width, height } = pngSize(readPng(file));
      expect(width).toBe(px);
      expect(height).toBe(px);
    });
  }
});

describe('opacity contract (no transparent corners on maskable/apple)', () => {
  it('maskable-512 has no tRNS chunk — fully opaque to the edge (B3)', () => {
    expect(hasChunk(readPng(ICON_FILES.maskable512), 'tRNS')).toBe(false);
  });

  it('apple-touch-180 has no tRNS chunk — opaque background (iOS masks it)', () => {
    expect(hasChunk(readPng(ICON_FILES.appleTouch180), 'tRNS')).toBe(false);
  });

  it('the `any` PWA icons keep transparent corners (tRNS present)', () => {
    expect(hasChunk(readPng(ICON_FILES.pwa192), 'tRNS')).toBe(true);
    expect(hasChunk(readPng(ICON_FILES.pwa512), 'tRNS')).toBe(true);
  });
});

describe('favicon.ico', () => {
  it('is a valid single-image ICO', () => {
    const ico = readPng(ICON_FILES.faviconIco);
    expect(ico.readUInt16LE(0)).toBe(0); // reserved
    expect(ico.readUInt16LE(2)).toBe(1); // type = icon
    expect(ico.readUInt16LE(4)).toBeGreaterThanOrEqual(1); // image count
  });
});
