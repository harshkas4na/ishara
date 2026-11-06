// Measures how well the voice pipeline hears Hinglish: the same normalized word-error table as
// docs/audit/voice-hinglish.md, so before/after numbers are comparable.
//
//   node scripts/eval-voice.ts                     synthetic set made with `say`, through the RUNNING helper (:7777)
//   node scripts/eval-voice.ts --real              Harsh's own takes from voice-samples/ (see voice-samples/README.md)
//   node scripts/eval-voice.ts --spawn 7861        its own whisper-server on that port, this repo's model choice and
//                                                  chunking, no helper involved (ISHARA_WHISPER_MODEL / _AC / _SNS apply)
//   node scripts/eval-voice.ts --helper http://127.0.0.1:7777
//   --prompt "..."   page-label priming (default: a Etherscan-verify-page vocabulary; "" turns it off)
//   --verbose        print every clip
//
// Scores the text the clients receive (after transcript-guard), so a rejected clip counts as all words wrong.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { devanagariToRoman, transcribeGuarded } from "../helper/src/transcript-guard.ts";
import { parseWav } from "../helper/src/chunk-audio.ts";

const args = process.argv.slice(2);
const flag = (n: string) => args.includes(n);
const opt = (n: string, d?: string) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const verbose = flag("--verbose");
const PROMPT = opt("--prompt", "Etherscan, Verify and Publish, Contract Address, Compiler Version, License Type, Optimizer, Constructor Arguments, Terms of Service, Sign in")!;

type Clip = { id: string; group: string; ref: string; wav: string };

// ---- the test set --------------------------------------------------------------------------------------------
// The audit named most of its sentences and gave only examples for the rest; the unnamed ones are filled in with
// sentences of the same shape. Lekha speaks Hindi-voiced text, Rishi English-voiced text.
const SYNTH: Array<[string, string, string, string]> = [ // id, group, voice, text
  ["h01", "hinglish", "Lekha", "yeh contract address kahan daalna hai"],
  ["h02", "hinglish", "Lekha", "is page pe compiler version kaise choose karte hain"],
  ["h03", "hinglish", "Lekha", "ye error ka matlab kya hai"],
  ["h04", "hinglish", "Lekha", "verify and publish ka button kahan hai"],
  ["h05", "hinglish", "Lekha", "license type mein kaunsa option select karun"],
  ["h06", "hinglish", "Lekha", "terms of service wala checkbox kahan hai"],
  ["h07", "hinglish", "Lekha", "constructor arguments kahan bharne hain"],
  ["h08", "hinglish", "Lekha", "optimizer ke kitne runs rakhne hain"],
  ["h09", "hinglish", "Lekha", "mujhe sign in ka link nahi mil raha"],
  ["h10", "hinglish", "Lekha", "source code yahan paste karna hai kya"],
  ["m02", "hinglish", "Rishi", "yeh compiler version wala dropdown kahan hai"],
  ["d01", "deva", "Lekha", "यह कॉन्ट्रैक्ट एड्रेस कहाँ डालना है"],
  ["d02", "deva", "Lekha", "कंपाइलर वर्शन कैसे चुनते हैं"],
  ["d03", "deva", "Lekha", "इस एरर का मतलब क्या है"],
  ["d04", "deva", "Lekha", "वेरिफाई बटन कहाँ है"],
  ["e01", "english", "Rishi", "where is the constructor arguments box"],
  ["e02", "english", "Rishi", "how do I verify this contract"],
  ["e03", "english", "Rishi", "what does this error mean"],
  ["m01", "english", "Rishi", "where do I paste the contract address"],
  ["m03", "english", "Rishi", "which license should I choose for this contract"],
  ["s01", "short", "Lekha", "haan"],
  ["s02", "short", "Lekha", "kya"],
  ["s03", "short", "Rishi", "ok"],
];
// ~20 s clips of two long sentences each, spoken slowly: they exercise the >9 s chunking.
const LONG: Array<[string, string, string]> = [
  ["L01", "Rishi", "I am on the verify and publish page and I want to know where I should paste the contract address. After that, tell me which compiler version I should choose for this contract."],
  ["L02", "Lekha", "mujhe yeh batao ki contract address kahan daalna hai aur uske baad compiler version kaise choose karte hain. phir optimizer ke kitne runs rakhne hain yeh bhi batao."],
];

function sh(cmd: string, a: string[]) { execFileSync(cmd, a, { stdio: "ignore" }); }

function makeSynthetic(dir: string): Clip[] {
  mkdirSync(dir, { recursive: true });
  const clips: Clip[] = [];
  for (const [id, group, voice, text] of SYNTH) {
    const aiff = join(dir, `${id}.aiff`), wav = join(dir, `${id}.wav`);
    if (!existsSync(wav)) { sh("say", ["-v", voice, "-o", aiff, text]); sh("afconvert", ["-f", "WAVE", "-d", "LEI16@16000", "-c", "1", aiff, wav]); }
    clips.push({ id, group, ref: text, wav });
  }
  for (const [id, voice, text] of LONG) {
    const wav = join(dir, `${id}.wav`);
    if (!existsSync(wav)) {
      const aiff = join(dir, `${id}.aiff`);
      sh("say", ["-v", voice, "-r", "125", "-o", aiff, text]);
      sh("afconvert", ["-f", "WAVE", "-d", "LEI16@16000", "-c", "1", aiff, wav]);
    }
    clips.push({ id, group: "long", ref: text, wav });
  }
  return clips;
}

// voice-samples/NN.wav (any format ffmpeg reads: .wav .m4a .mov ...) with voice-samples/lines.txt, one line per file.
function loadReal(): Clip[] {
  const root = new URL("../voice-samples/", import.meta.url).pathname;
  const lines = readFileSync(join(root, "lines.txt"), "utf8").split("\n").map((l) => l.trim()).filter(Boolean);
  const out = join(tmpdir(), "ishara-voice-samples"); mkdirSync(out, { recursive: true });
  const clips: Clip[] = [];
  for (const f of readdirSync(root).sort()) {
    const m = f.match(/^(\d+)([a-z]*)\.(wav|m4a|mp3|mov|mp4|aiff|caf)$/i);
    if (!m) continue;
    const n = Number(m[1]), ref = lines[n - 1];
    if (!ref) { console.error(`skip ${f}: lines.txt has no line ${n}`); continue; }
    const wav = join(out, `${m[1]}${m[2]}.wav`);
    sh("ffmpeg", ["-y", "-loglevel", "error", "-i", join(root, f), "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", wav]); // the extension sends 16 kHz mono
    clips.push({ id: `${m[1]}${m[2]}`, group: m[2] ? `real-${m[2]}` : "real", ref, wav });
  }
  if (!clips.length) throw new Error("voice-samples/ has no recordings: read voice-samples/README.md");
  return clips;
}

// ---- scoring: the audit's consonant skeleton --------------------------------------------------------------------
export function skeleton(w: string): string {
  return w.replace(/ph/g, "f").replace(/[cq]/g, "k").replace(/w/g, "v").replace(/z/g, "j").replace(/[aeiouh]/g, "").replace(/(.)\1+/g, "$1");
}
export function words(s: string): string[] {
  return devanagariToRoman(s).toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter(Boolean).map(skeleton);
}
export function wer(ref: string, hyp: string): { errors: number; n: number } {
  const r = words(ref), h = words(hyp);
  const d: number[][] = Array.from({ length: r.length + 1 }, (_, i) => [i, ...Array(h.length).fill(0)]);
  for (let j = 0; j <= h.length; j++) d[0][j] = j;
  for (let i = 1; i <= r.length; i++) for (let j = 1; j <= h.length; j++)
    d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (r[i - 1] === h[j - 1] ? 0 : 1));
  return { errors: d[r.length][h.length], n: Math.max(1, r.length) };
}

// ---- transcribers ---------------------------------------------------------------------------------------------
async function makeRunner(): Promise<{ run: (wav: Uint8Array) => Promise<{ text: string; ms: number; rejected?: string }>; label: string; stop: () => void }> {
  const spawnPort = opt("--spawn");
  if (spawnPort) {
    process.env.ISHARA_WHISPER_PORT = spawnPort; // must be set before whisper.ts is imported
    const w = await import("../helper/src/whisper.ts");
    await w.startWhisper();
    const st = w.whisperStatus();
    if (!st.ok) throw new Error(`whisper did not start: ${st.error}`);
    return { run: (wav) => transcribeGuarded(wav, PROMPT || undefined, w.transcribe), label: `own whisper :${spawnPort}  ${st.model}  ac=${process.env.ISHARA_WHISPER_AC ?? "512"} sns=${process.env.ISHARA_WHISPER_SNS !== "0"}`, stop: w.stopWhisper };
  }
  const base = opt("--helper", "http://127.0.0.1:7777")!;
  const health: any = await fetch(`${base}/health`).then((r) => r.json()).catch(() => null);
  if (!health) throw new Error(`no helper at ${base}: start it, or use --spawn 7861`);
  return {
    run: async (wav) => {
      const r = await fetch(`${base}/transcribe`, { method: "POST", headers: { "content-type": "audio/wav", "x-prompt": PROMPT, origin: "" }, body: wav as BodyInit });
      if (!r.ok) throw new Error(`/transcribe ${r.status} ${await r.text()}`);
      return await r.json() as any;
    },
    label: `helper ${base}  whisper=${JSON.stringify(health.whisper)}`, stop: () => {},
  };
}

const clips = flag("--real") ? loadReal() : makeSynthetic(join(tmpdir(), "ishara-voice-synth"));
const runner = await makeRunner();
console.log(`# ${runner.label}\n# prompt: ${PROMPT ? "on" : "off"}   clips: ${clips.length}\n`);

type Row = { id: string; group: string; ref: string; text: string; ms: number; errors: number; n: number; rejected?: string; deva: boolean; dur: number };
const rows: Row[] = [];
await runner.run(readFileSync(clips[0].wav)).catch(() => {}); // warm-up, not scored
for (const c of clips) {
  const buf = readFileSync(c.wav);
  const pcm = parseWav(buf);
  const r = await runner.run(buf);
  const text = r.text ?? "";
  const s = wer(c.ref, text);
  rows.push({ id: c.id, group: c.group, ref: c.ref, text, ms: r.ms, errors: s.errors, n: s.n, rejected: r.rejected, deva: /[ऀ-ॿ]/.test(text), dur: pcm ? pcm.samples.length / pcm.rate : 0 });
  if (verbose) console.log(`${c.id.padEnd(5)} ${(pcm ? (pcm.samples.length / pcm.rate).toFixed(1) : "?").padStart(5)}s ${String(r.ms).padStart(5)}ms  ${s.errors}/${s.n}  ref: ${c.ref}\n      got: ${text}${r.rejected ? `  [rejected: ${r.rejected}]` : ""}`);
}
runner.stop();

const groups = [...new Set(rows.map((r) => r.group))];
console.log("group      clips  WER    errors/words  s/clip  rejected  devanagari-out");
for (const g of [...groups, "ALL"]) {
  const rs = g === "ALL" ? rows : rows.filter((r) => r.group === g);
  const e = rs.reduce((a, r) => a + r.errors, 0), n = rs.reduce((a, r) => a + r.n, 0);
  const s = rs.reduce((a, r) => a + r.ms, 0) / rs.length / 1000;
  console.log(`${g.padEnd(10)} ${String(rs.length).padStart(5)}  ${(100 * e / n).toFixed(0).padStart(3)}%   ${`${e}/${n}`.padStart(9)}    ${s.toFixed(2).padStart(5)}  ${String(rs.filter((r) => r.rejected).length).padStart(8)}  ${String(rs.filter((r) => r.deva).length).padStart(8)}`);
}
if (!verbose) {
  const bad = rows.filter((r) => r.errors / r.n > 0.5);
  if (bad.length) console.log("\nworst clips (>50% wrong):\n" + bad.map((r) => `  ${r.id}: "${r.ref}"  ->  "${r.text}"${r.rejected ? ` [${r.rejected}]` : ""}`).join("\n"));
}
writeFileSync(join(tmpdir(), "ishara-voice-last.json"), JSON.stringify(rows, null, 1));
process.exit(0);
