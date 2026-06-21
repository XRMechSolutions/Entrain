// lamejs ships no first-party TypeScript types and there is no `@types/lamejs`
// (dependencies.md @ Types). This minimal local ambient covers ONLY the `Mp3Encoder`
// surface the renderer uses — the pure-JS LAME port, pinned exact at 1.2.1 because it
// is unmaintained. `encodeBuffer`/`flush` return an `Int8Array` (a view over signed
// bytes) which the renderer copies into a `Uint8Array` chunk before assembling the Blob.
declare module 'lamejs' {
  export class Mp3Encoder {
    constructor(channels: number, sampleRate: number, kbps: number);
    encodeBuffer(left: Int16Array, right: Int16Array): Int8Array;
    flush(): Int8Array;
  }
}
