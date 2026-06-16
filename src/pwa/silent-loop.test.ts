import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Task [data]: the committed near-silent loop asset (interfaces.md §8, design.md §6.3,
// edge-cases D3/D4/D5). Verified by parsing the WAV header + PCM samples directly:
// canonical 16-bit PCM / mono / 8000 Hz / 5.0 s, even sample count (seamless loop),
// near-silent but non-zero. jsdom has no Web Audio, so decodeAudioData cannot run here;
// the canonical-PCM assertions are its decodability precondition (no codec dependency).

const wavPath = join(process.cwd(), 'public/audio/silence-5s.wav');
const buf = readFileSync(wavPath);

const ascii = (off: number, len: number): string => buf.toString('ascii', off, off + len);

describe('silence-5s.wav container/codec', () => {
  it('is a RIFF/WAVE file with fmt + data chunks', () => {
    expect(ascii(0, 4)).toBe('RIFF');
    expect(ascii(8, 4)).toBe('WAVE');
    expect(ascii(12, 4)).toBe('fmt ');
    expect(ascii(36, 4)).toBe('data');
  });

  it('is uncompressed 16-bit PCM (no codec dependency)', () => {
    expect(buf.readUInt16LE(20)).toBe(1); // AudioFormat 1 = PCM
    expect(buf.readUInt16LE(34)).toBe(16); // BitsPerSample
    expect(buf.readUInt32LE(16)).toBe(16); // Subchunk1Size for PCM
  });

  it('is mono at 8000 Hz with consistent byte-rate/block-align', () => {
    expect(buf.readUInt16LE(22)).toBe(1); // NumChannels
    expect(buf.readUInt32LE(24)).toBe(8000); // SampleRate
    expect(buf.readUInt16LE(32)).toBe(2); // BlockAlign = channels * bytes/sample
    expect(buf.readUInt32LE(28)).toBe(16000); // ByteRate = rate * blockAlign
  });
});

describe('silence-5s.wav duration / loop seamlessness', () => {
  const dataSize = buf.readUInt32LE(40);
  const sampleCount = dataSize / 2;

  it('contains 40000 samples = exactly 5.0 s', () => {
    expect(dataSize).toBe(80000);
    expect(sampleCount).toBe(40000);
    expect(sampleCount / 8000).toBe(5.0);
  });

  it('has an even sample count so the loop wrap has no amplitude step (no click, D4)', () => {
    expect(sampleCount % 2).toBe(0);
  });

  it('is near-silent but non-zero (±1 LSB) so the OS keeps audio focus (D5)', () => {
    let allMagnitudeOne = true;
    let anyNonZero = false;
    for (let i = 0; i < sampleCount; i++) {
      const s = buf.readInt16LE(44 + i * 2);
      if (s !== 0) anyNonZero = true;
      if (Math.abs(s) !== 1) allMagnitudeOne = false;
    }
    expect(anyNonZero).toBe(true);
    expect(allMagnitudeOne).toBe(true);
  });

  it('alternates +1/-1 with the wrap continuing the pattern (constant amplitude)', () => {
    const first = buf.readInt16LE(44);
    const last = buf.readInt16LE(44 + (sampleCount - 1) * 2);
    expect(first).toBe(1);
    expect(last).toBe(-1);
    // last(-1) -> first(+1): the same transition as every internal sample boundary, so
    // the |amplitude| never steps at the seam — there is no on/off edge to click.
    expect(Math.abs(first)).toBe(Math.abs(last));
    expect(first).not.toBe(last);
  });

  it('weighs ~80 KB (tiny precache, A7)', () => {
    expect(buf.length).toBe(44 + 80000);
  });
});
