// Long recordings, split for whisper. The Hinglish model runs with `-ac 512` (a 10.24 s audio window, which is
// what makes it 0.7 s instead of 2.7 s per clip), and behaviour past ~10 s is not trustworthy: it truncates or
// repeats. So anything over MAX_SEC is cut into pieces of at most CHUNK_SEC, each cut placed at the quietest
// moment near the boundary so a word is not sliced in half. Pure functions, no I/O, tested in voice-chunk.test.ts.

export const CHUNK_SEC = 9;     // each piece is at most this long
const SPLIT_ABOVE_SEC = 9.5;    // up to here a recording goes through whole (the window is 10.24 s)
const SEARCH_SEC = 2;           // look this far back from the 9 s mark for a pause
const FRAME_SEC = 0.03;         // energy is measured per 30 ms frame

export type Pcm = { samples: Int16Array; rate: number };

// Reads a canonical RIIFF/WAVE PCM16 mono file (what the extension and the desktop daemon send). Returns null for
// anything else, and the caller then sends the file through unsplit, as before.
export function parseWav(buf: Uint8Array): Pcm | null {
  if (buf.length < 44) return null;
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const tag = (o: number) => String.fromCharCode(buf[o], buf[o + 1], buf[o + 2], buf[o + 3]);
  if (tag(0) !== "RIFF" || tag(8) !== "WAVE") return null;
  let o = 12, rate = 0, channels = 0, bits = 0, fmt = 0;
  while (o + 8 <= buf.length) {
    const id = tag(o), size = dv.getUint32(o + 4, true);
    if (id === "fmt ") { fmt = dv.getUint16(o + 8, true); channels = dv.getUint16(o + 10, true); rate = dv.getUint32(o + 12, true); bits = dv.getUint16(o + 22, true); }
    if (id === "data") {
      if (fmt !== 1 || channels !== 1 || bits !== 16 || !rate) return null;
      const n = Math.min(size, buf.length - (o + 8)) >> 1; // a streamed header may claim more than arrived
      const samples = new Int16Array(n);
      for (let i = 0; i < n; i++) samples[i] = dv.getInt16(o + 8 + i * 2, true);
      return { samples, rate };
    }
    o += 8 + size + (size & 1);
  }
  return null;
}

export function encodeWav(samples: Int16Array, rate: number): Uint8Array {
  const out = new Uint8Array(44 + samples.length * 2);
  const dv = new DataView(out.buffer);
  const w = (o: number, s: string) => { for (let i = 0; i < 4; i++) out[o + i] = s.charCodeAt(i); };
  w(0, "RIFF"); dv.setUint32(4, 36 + samples.length * 2, true); w(8, "WAVE"); w(12, "fmt ");
  dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true);
  dv.setUint32(24, rate, true); dv.setUint32(28, rate * 2, true); dv.setUint16(32, 2, true); dv.setUint16(34, 16, true);
  w(36, "data"); dv.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) dv.setInt16(44 + i * 2, samples[i], true);
  return out;
}

// RMS on the same 0..1 scale the extension reports (float samples in -1..1).
export function rms(samples: Int16Array): number {
  if (!samples.length) return 0;
  let s = 0;
  for (let i = 0; i < samples.length; i++) { const v = samples[i] / 32768; s += v * v; }
  return Math.sqrt(s / samples.length);
}

// Sample ranges [start, end) to transcribe. One range when the clip is short enough.
export function splitRanges(samples: Int16Array, rate: number, chunkSec = CHUNK_SEC): Array<[number, number]> {
  const total = samples.length;
  if (total <= SPLIT_ABOVE_SEC * rate) return [[0, total]];
  const max = Math.floor(chunkSec * rate), frame = Math.max(1, Math.floor(FRAME_SEC * rate));
  const out: Array<[number, number]> = [];
  let start = 0;
  while (total - start > max) {
    const hi = start + max, lo = Math.max(start + Math.floor(max / 2), hi - Math.floor(SEARCH_SEC * rate));
    // quietest frame in [lo, hi): cut in the middle of it
    let best = hi, bestE = Infinity;
    for (let f = lo; f + frame <= hi; f += frame) {
      let e = 0;
      for (let i = f; i < f + frame; i++) e += samples[i] * samples[i];
      if (e < bestE) { bestE = e; best = f + (frame >> 1); }
    }
    out.push([start, best]);
    start = best;
  }
  out.push([start, total]);
  return out;
}

// Convenience: WAV in, WAV pieces out. A file we cannot parse (or a short one) comes back as the single original.
export function splitWav(wav: Uint8Array): Uint8Array[] {
  const pcm = parseWav(wav);
  if (!pcm) return [wav];
  const ranges = splitRanges(pcm.samples, pcm.rate);
  if (ranges.length === 1) return [wav];
  return ranges.map(([a, b]) => encodeWav(pcm.samples.subarray(a, b), pcm.rate));
}
