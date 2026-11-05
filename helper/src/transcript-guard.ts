// The one place that decides whether a transcript is worth acting on. It runs server-side in /transcribe so the
// browser extension and the desktop push-to-talk share it (they used to carry two copies of a blunt regex that
// dropped "ok" and anything under 3 characters, which are valid Hinglish answers).
import { parseWav, rms } from "./chunk-audio.ts";

// Loudness floor, 0..1 RMS. 0.006 was chosen from the extension's levels; the audit could not measure a real voice.
// Override with ISHARA_MIN_RMS and calibrate with `node scripts/mic-level.ts`. Shown in GET /health.
export function minRms(env: Record<string, string | undefined> = process.env): number {
  const v = Number(env.ISHARA_MIN_RMS);
  return Number.isFinite(v) && v > 0 && v < 1 ? v : 0.006;
}

export type Rejected = "noise" | "blank" | "script" | "silent";
export type Guarded = { text: string; rejected?: Rejected; detail?: string };

// Whisper's stock output on silence or room noise. Matched against the WHOLE normalized transcript only, so a real
// sentence containing "the" or "you" is never touched. Deliberately absent: ok, okay, haan, nahi, kya, ye, yeh, acha,
// theek hai and every other short word a Hinglish speaker says as a complete answer.
const STOCK = new Set([
  "you", "thank you", "thanks", "thanks for watching", "thank you for watching", "bye", "bye bye", "the",
  "uh", "um", "hmm", "mm", "mhm", "nan", "so", "and", "oh",
]);
const STOCK_WORDS = new Set(["you", "thank", "thanks", "bye", "the", "uh", "um", "hmm", "mm", "for", "watching"]);

// [BLANK_AUDIO], (music), (silence), *click*, musical notes. Whisper writes sounds in brackets.
const MARKER = /\[[^\]]*\]|\([^)]*\)|\*[^*]*\*|[♪♫♬🎵🎶]+/g;
const BLANK_MARKER = /\[\s*(blank_audio|silence|no speech)\s*\]|\(\s*silence\s*\)/i;

const isDeva = (c: number) => c >= 0x0900 && c <= 0x097f;
const isLatinLetter = (ch: string) => /[A-Za-zÀ-ɏ]/.test(ch);
const isAnyLetter = (ch: string) => /\p{L}/u.test(ch);

// ---- Devanagari -> Roman Hinglish (APPROXIMATE) --------------------------------------------------------------
// laya vetoes a correctly understood Devanagari question (p=0.22 in the audit), so Devanagari must never reach it.
// The Hinglish model emitted 0 of 23 clips in Devanagari, so this is a safety net, not the main path. It is a plain
// letter-by-letter map: the inherent "a" is dropped at the end of a word and after a virama, and kept elsewhere
// ("कहाँ" -> "kahaan", "यह" -> "yah"). It does not do full schwa deletion, so a few words come out with an extra
// "a" ("कंपाइलर" -> "kanpailar"). That is fine for 0GM, which reads Roman Hinglish happily (6 of 6 in the audit).
const CONS: Record<string, string> = {
  "क": "k", "ख": "kh", "ग": "g", "घ": "gh", "ङ": "n", "च": "ch", "छ": "chh", "ज": "j", "झ": "jh", "ञ": "n",
  "ट": "t", "ठ": "th", "ड": "d", "ढ": "dh", "ण": "n", "त": "t", "थ": "th", "द": "d", "ध": "dh", "न": "n",
  "प": "p", "फ": "f", "ब": "b", "भ": "bh", "म": "m", "य": "y", "र": "r", "ल": "l", "व": "v", "श": "sh",
  "ष": "sh", "स": "s", "ह": "h", "ळ": "l",
};
const VOWEL: Record<string, string> = {
  "अ": "a", "आ": "aa", "इ": "i", "ई": "ee", "उ": "u", "ऊ": "oo", "ऋ": "ri", "ए": "e", "ऐ": "ai", "ओ": "o", "औ": "au", "ऑ": "o", "ऍ": "e",
};
const MATRA: Record<string, string> = {
  "ा": "aa", "ि": "i", "ी": "ee", "ु": "u", "ू": "oo", "ृ": "ri", "े": "e", "ै": "ai", "ो": "o", "ौ": "au", "ॉ": "o", "ॅ": "e",
};
const DIGIT: Record<string, string> = { "०": "0", "१": "1", "२": "2", "३": "3", "४": "4", "५": "5", "६": "6", "७": "7", "८": "8", "९": "9" };

// Conjuncts that are one sound in Roman, and consonant+nukta forms (NFC splits U+0958.. into base + U+093C).
const CONJ: Record<string, string> = { "क्ष": "ksh", "ज्ञ": "gy" };
const NUKTA: Record<string, string> = { "ड": "r", "ढ": "rh", "फ": "f", "ज": "z", "क": "q", "ख": "kh", "ग": "g" };

export function devanagariToRoman(s: string): string {
  const t = s.normalize("NFC");
  let out = "";
  for (let i = 0; i < t.length; i++) {
    const ch = t[i];
    let roman = CONJ[t.slice(i, i + 3)], used = 0;
    if (roman) used = 2;
    else if (CONS[ch]) {
      roman = CONS[ch];
      if (t[i + 1] === "\u093C" && NUKTA[ch]) { roman = NUKTA[ch]; used = 1; }
    }
    if (roman) {
      out += roman;
      i += used;
      const nx = t[i + 1];
      if (nx && MATRA[nx]) { out += MATRA[nx]; i++; }
      else if (nx === "\u094D") i++;   // virama: no vowel, the next consonant joins this one
      else out += inherent(t, i);
    } else if (VOWEL[ch]) out += VOWEL[ch];
    else if (ch === "ं" || ch === "ँ") out += "n";
    else if (ch === "ः") out += "h";
    else if (ch === "\u093C" || ch === "\u094D") { /* stray nukta or virama */ }
    else if (ch === "।") out += ".";
    else if (DIGIT[ch]) out += DIGIT[ch];
    else out += ch;
  }
  return out;
}
// "a" after a consonant, except at the end of a word (यह -> yah, not yaha).
function inherent(t: string, i: number): string {
  const nx = t[i + 1];
  return nx && isDeva(nx.charCodeAt(0)) && nx !== "।" ? "a" : "";
}

// ---- the guard ------------------------------------------------------------------------------------------------
export function guardTranscript(raw: string): Guarded {
  const original = String(raw ?? "").trim();
  if (!original) return { text: "", rejected: "blank" };
  const blank = BLANK_MARKER.test(original);
  let s = original.replace(MARKER, " ").replace(/\s+/g, " ").trim();
  if (!s) return { text: "", rejected: blank ? "blank" : "noise", detail: original.slice(0, 60) };

  // Script check on letters only. Latin and Devanagari are fine; CJK, Cyrillic, Arabic and the rest are the
  // decoder hallucinating ("和", "Пока" in the audit).
  let latin = 0, deva = 0, other = 0;
  for (const ch of s) {
    if (isLatinLetter(ch)) latin++;
    else if (isDeva(ch.codePointAt(0)!) && isAnyLetter(ch)) deva++;
    else if (isAnyLetter(ch)) other++;
  }
  if (other > 0 && other >= latin + deva) return { text: "", rejected: "script", detail: s.slice(0, 40) };
  if (other > 0) s = [...s].filter((ch) => !isAnyLetter(ch) || isLatinLetter(ch) || isDeva(ch.codePointAt(0)!)).join("").replace(/\s+/g, " ").trim();
  if (deva > 0) s = devanagariToRoman(s);

  const norm = s.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim();
  if (!norm) return { text: "", rejected: "noise", detail: s.slice(0, 40) };
  if (STOCK.has(norm)) return { text: "", rejected: "noise", detail: norm };
  const words = norm.split(" ");
  if (words.length > 1 && words.every((w) => STOCK_WORDS.has(w))) return { text: "", rejected: "noise", detail: norm }; // "you you you"
  if (!/[\p{L}\p{N}]{2,}/u.test(norm) && !/\d/.test(norm)) return { text: "", rejected: "noise", detail: norm }; // lone letters
  return { text: s };
}

// ---- the route's logic, with the transcriber injected so the test needs no whisper ---------------------------------
export type Transcriber = (wav: Uint8Array, prompt?: string) => Promise<{ text: string; ms: number }>;
export type TranscribeResult = { text: string; ms: number; rejected?: Rejected; detail?: string };

export async function transcribeGuarded(wav: Uint8Array, prompt: string | undefined, run: Transcriber, floor = minRms()): Promise<TranscribeResult> {
  const t0 = Date.now();
  // Server-side loudness check for clients that did not do one (the desktop daemon and extension do, both with 0.006).
  const pcm = parseWav(wav);
  if (pcm && rms(pcm.samples) < floor) return { text: "", ms: Date.now() - t0, rejected: "silent", detail: `rms below ${floor}` };
  const r = await run(wav, prompt);
  const g = guardTranscript(r.text);
  return g.rejected ? { text: "", ms: r.ms, rejected: g.rejected, detail: g.detail } : { text: g.text, ms: r.ms };
}
