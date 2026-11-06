// Spoken answers. Ishara says its answer aloud, on this laptop, from the helper process, so the browser extension
// and the desktop path both get a voice with no change on their side. Nothing leaves the machine: the voice is
// Kokoro-82M running in a warm child process (voice/kokoro_server.py), and audio is played with macOS afplay.
//
// Shape (the same one whisper.ts uses): a child process kept warm, status that says why it is not working, and
// every outside effect behind `SpeechDeps` so the queue, interrupt and mute logic are tested with fakes.
//
// Engines, first that works: "kokoro" (neural), "system" (macOS `say`, so it is never silent by accident),
// "none" (status.reason says why). ISHARA_VOICE_ENGINE=system forces the macOS voice.
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
export const KOKORO_PY = join(ROOT, "voice/.venv/bin/python");
export const KOKORO_SCRIPT = join(ROOT, "voice/kokoro_server.py");
export const MUTE_FILE = join(ROOT, "helper/.data/speech.json");

// ---------- pure text rules (unit tested) ----------

// An answer is read, not recited: a hard cap of 40 words. The cut falls on a sentence boundary when one exists
// inside the cap; a single sentence longer than the cap is cut at its last comma inside the cap, else at the cap.
// A cut answer ends with a plain full stop (never a spoken "dot dot dot"), so it sounds finished, not broken.
export const MAX_WORDS = 40;
// A first sentence longer than this is also split at commas, so the first words reach the speaker sooner
// (synthesis time grows with length; the clause is made while the person is already listening to the first).
const CLAUSE_OVER = 12;

// Strip what a voice must not read: "(test router)" suffix, URLs, element ids like b12 or [b12], markdown marks,
// code ticks, emoji and meter glyphs. Returns "" when nothing speakable is left (a bare tag is skipped).
export function cleanForSpeech(raw: string): string {
  let s = String(raw ?? "");
  s = s.replace(/\(\s*test router\s*\)/gi, " ");
  s = s.replace(/\[([^\]]*)\]\((?:https?:\/\/|file:|www\.)[^)]*\)/gi, "$1"); // [label](url) -> label
  s = s.replace(/\b(?:https?:\/\/|file:\/\/|www\.)\S+/gi, " ");
  s = s.replace(/\[\s*[a-z]{1,2}\d+\s*\]/gi, " ");                             // [b12]
  s = s.replace(/\b[a-z]\d{1,4}\b/g, (m) => (/^[bs]\d+$/.test(m) ? " " : m));    // bare ids: b12, s3
  s = s.replace(/```[\s\S]*?```/g, " ").replace(/`([^`]*)`/g, "$1");
  s = s.replace(/^\s{0,3}(?:#{1,6}|>|[-*+]|\d+[.)])\s+/gm, "");                  // heading, quote, list markers
  s = s.replace(/[*_~#>|\\]+/g, " ");
  s = s.replace(/[▀-▟■-◿☀-➿\u{1F000}-\u{1FFFF}]/gu, " "); // blocks, symbols, emoji
  s = s.replace(/\s+/g, " ").trim();
  return /[\p{L}\p{N}]/u.test(s) ? s : ""; // only punctuation left: nothing to say
}

// Split on sentence ends (. ! ? and newlines). Abbreviation-safe enough for short UI answers: a full stop only
// ends a sentence when followed by space and a capital or digit, so "e.g. the button" and "3.5" stay whole.
export function splitSentences(text: string): string[] {
  const out: string[] = [];
  for (const para of text.split(/\n+/)) {
    const parts = para.split(/(?<=[.!?…])["')\]]*\s+(?=[A-Z0-9"'(])/);
    for (const p of parts) { const t = p.trim(); if (t) out.push(t); }
  }
  return out;
}

const words = (s: string) => s.split(/\s+/).filter(Boolean).length;

// Break one long sentence at commas/semicolons/colons into chunks of 4+ words, so the first chunk is short.
export function clauses(sentence: string): string[] {
  if (words(sentence) <= CLAUSE_OVER) return [sentence];
  const pieces = sentence.split(/(?<=[,;:])\s+/);
  const out: string[] = [];
  let cur = "";
  for (const p of pieces) {
    cur = cur ? `${cur} ${p}` : p;
    if (words(cur) >= 4) { out.push(cur); cur = ""; }
  }
  if (cur) { if (out.length) out[out.length - 1] += ` ${cur}`; else out.push(cur); }
  return out;
}

// Clean, cap and split one answer into the pieces that are synthesised one by one.
export function prepare(raw: string, maxWords = MAX_WORDS): string[] {
  const clean = cleanForSpeech(raw);
  if (!clean) return [];
  const out: string[] = [];
  let used = 0;
  for (const sent of splitSentences(clean)) {
    const n = words(sent);
    if (used + n <= maxWords) { out.push(sent); used += n; continue; }
    if (used === 0) { // the very first sentence is already over the cap: keep its head
      const head = sent.split(/\s+/).slice(0, maxWords).join(" ");
      const comma = head.lastIndexOf(",");
      out.push((comma > head.length / 2 ? head.slice(0, comma) : head).replace(/[,;:\s]+$/, "") + ".");
    }
    break; // later sentences are dropped; the screen still has the full text
  }
  return out.flatMap((s, i) => (i === 0 ? clauses(s) : [s]));
}

// ---------- the queue (all outside effects injected) ----------

export type Engine = "kokoro" | "system" | "none";
export type Playing = { done: Promise<void>; kill(): void };
export type Voice = {
  engine: Engine;
  // Synthesise one piece to a WAV file and resolve its path; reject on failure. Absent for the "system" engine.
  synth?: (text: string) => Promise<string>;
  // Play a WAV path (kokoro) or speak text (system) and resolve when it finished.
  play: (what: string) => Playing;
};
export type SpeechDeps = {
  start: () => Promise<{ voice: Voice | null; reason?: string }>;
  stop: () => void;
  readMuted: () => boolean;
  writeMuted: (m: boolean) => void;
  cleanup: (path: string) => void;
  now: () => number;
  enabled: boolean; // false when ISHARA_SPEAK=0
};

export type SpeechStatus = {
  engine: Engine; voice: string; muted: boolean; enabled: boolean; ready: boolean;
  speaking: boolean; queued: number; spoken: number; lastFirstAudioMs?: number; reason?: string; lastError?: string;
};

// The pick rule on its own so it is testable: kokoro if it is installed and came up, else the macOS voice, else none.
export function pickEngine(o: { forced?: string; kokoroReady: boolean; systemAvailable: boolean }): Engine {
  if (o.forced === "system") return o.systemAvailable ? "system" : "none";
  if (o.kokoroReady) return "kokoro";
  return o.systemAvailable ? "system" : "none";
}

export function createSpeaker(d: SpeechDeps, voiceName = "af_heart") {
  let voice: Voice | null = null;
  let reason: string | undefined = d.enabled ? "not started" : "disabled by ISHARA_SPEAK=0";
  let starting: Promise<void> | null = null;
  let muted = false;
  try { muted = d.readMuted(); } catch { /* unreadable mute file: default unmuted */ }
  let gen = 0;                  // bumped by interrupt(); work that belongs to an older generation is discarded
  let pending: string[] = [];   // pieces waiting to be synthesised
  let ready: { text: string; gen: number; file: Promise<string | null> }[] = []; // synthesised or in flight, in order
  let current: Playing | null = null;
  let pumping = false;
  let buf = "";                 // enqueue() text not yet ended by a sentence boundary
  let budget = MAX_WORDS;       // words left for the current answer (reset by flush)
  let spoken = 0, lastError: string | undefined, lastFirst: number | undefined;
  let answerStart = 0, firstDone = true;

  async function ensure(): Promise<void> {
    if (voice || !d.enabled) return;
    starting ??= d.start().then((r) => { voice = r.voice; reason = r.voice ? undefined : r.reason; }).finally(() => { starting = null; });
    await starting;
  }

  function toPieces(text: string): string[] {
    const ps = prepare(text, budget);
    budget -= ps.reduce((n, p) => n + words(p), 0);
    return ps;
  }
  function add(pieces: string[]) {
    if (!pieces.length || muted || !d.enabled) return;
    if (pending.length === 0 && ready.length === 0 && !current) { answerStart = d.now(); firstDone = false; }
    pending.push(...pieces);
    if (pumping) fill(); else void pump();
  }

  // Synthesis runs one piece ahead of playback: while piece N plays, N+1 is made, so there is no gap between
  // sentences. fill() is also called when text arrives mid-playback (streaming), not only between pieces.
  function fill(): void {
    while (pending.length && ready.length < (current ? 1 : 2) && voice) {
      const text = pending.shift()!;
      const v = voice;
      const file = v.synth ? v.synth(text).catch((e) => { lastError = String(e?.message ?? e); return null; }) : Promise.resolve(text);
      ready.push({ text, gen, file });
    }
  }
  async function pump(): Promise<void> {
    if (pumping) return;
    pumping = true;
    try {
      await ensure();
      if (!voice) { pending = []; return; } // no engine: drop the text (status() says why); looping here would spin forever
      const myGen = gen;
      while (myGen === gen && (pending.length || ready.length)) {
        fill();
        const item = ready.shift();
        if (!item) break;
        const f = await item.file;
        if (myGen !== gen) { if (f && voice?.synth) d.cleanup(f); break; } // interrupted while synthesising
        if (f && voice) {
          current = voice.play(f);
          fill(); // start making the next piece now, while this one plays
          if (!firstDone) { firstDone = true; lastFirst = d.now() - answerStart; }
          try { await current.done; spoken++; } catch (e: any) { lastError = String(e?.message ?? e); }
          current = null;
          if (voice.synth) d.cleanup(f);
        }
      }
    } finally { pumping = false; if (pending.length && !muted && voice) void pump(); }
  }

  return {
    // speak(): one whole answer. enqueue()/flush(): the same, streamed: text is cut at sentence ends as it arrives.
    speak(text: string): void { budget = MAX_WORDS; add(toPieces(text)); },
    enqueue(text: string): void {
      buf += text;
      const parts = splitSentences(buf);
      // The last part may be a sentence still arriving; hold it unless it already ends in . ! ?
      const complete = /[.!?…]["')\]]*\s*$/.test(buf) ? parts : parts.slice(0, -1);
      buf = /[.!?…]["')\]]*\s*$/.test(buf) ? "" : (parts[parts.length - 1] ?? "");
      if (complete.length) add(toPieces(complete.join(" ")));
    },
    flush(): void { const t = buf; buf = ""; if (t.trim()) add(toPieces(t)); budget = MAX_WORDS; },
    // Stop talking now and forget the rest. Called on every new question (push-to-talk down, typed ask) so the
    // voice never talks over the person and never leaks into a recording.
    interrupt(): void {
      gen++; pending = []; buf = ""; budget = MAX_WORDS;
      const old = ready; ready = [];
      for (const r of old) void r.file.then((f) => { if (f && voice?.synth) d.cleanup(f); });
      current?.kill(); current = null;
    },
    setMuted(m: boolean): void {
      muted = m;
      try { d.writeMuted(m); } catch (e: any) { lastError = `cannot save mute: ${e?.message ?? e}`; }
      if (m) this.interrupt();
    },
    isMuted: () => muted,
    start: async (): Promise<void> => { await ensure(); },
    stop(): void { this.interrupt(); d.stop(); voice = null; },
    status(): SpeechStatus {
      return {
        engine: voice?.engine ?? "none", voice: voice?.engine === "kokoro" ? voiceName : voice?.engine === "system" ? "macOS" : "-",
        muted, enabled: d.enabled, ready: !!voice, speaking: !!current, queued: pending.length + ready.length, spoken,
        ...(lastFirst !== undefined ? { lastFirstAudioMs: lastFirst } : {}),
        ...(voice ? {} : { reason: reason ?? "not started" }), ...(lastError ? { lastError } : {}),
      };
    },
  };
}

// ---------- the real thing ----------

const VOICE = process.env.ISHARA_VOICE || "af_heart";
let child: ChildProcess | null = null;
let seq = 0;
const waiting = new Map<number, { ok: (p: string) => void; fail: (e: Error) => void; out: string }>();

function afplay(path: string): Playing {
  const p = spawn("/usr/bin/afplay", [path], { stdio: "ignore" });
  const done = new Promise<void>((res, rej) => { p.on("exit", () => res()); p.on("error", rej); });
  return { done, kill: () => p.kill("SIGKILL") }; // SIGKILL: stop at once, not at the end of the buffer
}
function sayCmd(text: string): Playing {
  const p = spawn("/usr/bin/say", [text], { stdio: "ignore" });
  const done = new Promise<void>((res, rej) => { p.on("exit", () => res()); p.on("error", rej); });
  return { done, kill: () => p.kill("SIGKILL") };
}

async function startKokoro(): Promise<Voice | string> {
  if (!existsSync(KOKORO_PY) || !existsSync(KOKORO_SCRIPT)) return "Kokoro is not installed (run scripts/setup-voice.sh)";
  const dir = join(tmpdir(), `ishara-voice-${process.pid}`);
  mkdirSync(dir, { recursive: true });
  const p = spawn(KOKORO_PY, [KOKORO_SCRIPT], { stdio: ["pipe", "pipe", "ignore"], env: { ...process.env, ISHARA_VOICE: VOICE } });
  child = p;
  return await new Promise<Voice | string>((resolve) => {
    let buf = "", ready = false;
    const fail = (why: string) => { if (!ready) { ready = true; resolve(why); } for (const w of waiting.values()) w.fail(new Error(why)); waiting.clear(); child = null; };
    const timer = setTimeout(() => { fail("Kokoro did not become ready in 60 s"); p.kill(); }, 60_000);
    p.on("error", (e) => fail(`cannot start Kokoro: ${e.message}`));
    p.on("exit", (c) => { clearTimeout(timer); fail(`Kokoro exited (${c})`); });
    p.stdout!.on("data", (c) => {
      buf += c; let i: number;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        let m: any; try { m = JSON.parse(line); } catch { continue; }
        if (m.event === "ready" && !ready) {
          ready = true; clearTimeout(timer);
          resolve({
            engine: "kokoro",
            synth: (text) => new Promise<string>((ok, fail2) => {
              const id = ++seq, out = join(dir, `${id}.wav`);
              waiting.set(id, { ok, fail: fail2, out });
              p.stdin!.write(JSON.stringify({ id, text, out }) + "\n");
            }),
            play: afplay,
          });
        } else if (m.event === "error" && !ready) { ready = true; clearTimeout(timer); resolve(String(m.error)); }
        else if (typeof m.id === "number") {
          const w = waiting.get(m.id); waiting.delete(m.id);
          if (w) m.ok ? w.ok(w.out) : w.fail(new Error(m.error ?? "synthesis failed"));
        }
      }
    });
  });
}

const real = createSpeaker({
  enabled: process.env.ISHARA_SPEAK !== "0",
  async start() {
    const forced = process.env.ISHARA_VOICE_ENGINE;
    const systemAvailable = existsSync("/usr/bin/say");
    let why = "";
    if (forced !== "system") {
      const k = await startKokoro();
      if (typeof k !== "string") return { voice: k };
      why = k;
    }
    return pickEngine({ forced, kokoroReady: false, systemAvailable }) === "system"
      ? { voice: { engine: "system", play: sayCmd } as Voice, reason: why }
      : { voice: null, reason: `${why || "no voice"}; macOS say is not available either` };
  },
  stop() { child?.kill("SIGTERM"); child = null; },
  readMuted() { try { return JSON.parse(readFileSync(MUTE_FILE, "utf8")).muted === true; } catch { return false; } },
  writeMuted(m) { mkdirSync(join(ROOT, "helper/.data"), { recursive: true }); writeFileSync(MUTE_FILE, JSON.stringify({ muted: m })); },
  cleanup(p) { try { rmSync(p, { force: true }); } catch { /* temp file */ } },
  now: Date.now,
}, VOICE);

export const speaker = real;
// Only the process that started speech (the helper server) ever speaks. Before this, any script that imported decide()
// (scripts/eval.ts, smoke.ts) started its own Kokoro, read every eval answer aloud, and never exited: the child's pipes
// kept node alive.
let started = false;
export const startSpeech = () => { started = true; return real.start(); };
export const stopSpeech = () => real.stop();
export const speak = (t: string) => { if (started) real.speak(t); };
export const interrupt = () => real.interrupt();
export const setMuted = (m: boolean) => real.setMuted(m);
export const speechStatus = () => real.status();
process.on("exit", () => child?.kill("SIGTERM")); // the voice process must not outlive the helper

// What Ishara says for a decision: its own words for point / ask / ask_which; for a safe stop the plain refusal,
// shortened. Kept here so decide.ts has a one-line hook and the wording is tested in one place.
export function sayFor(d: { outcome: string; say: string; safeStopCause?: string }): string {
  if (d.outcome !== "safe_stop") return d.say;
  const why: Record<string, string> = {
    unavailable: "0G's private model is not reachable.", timeout: "0G took too long to answer.", offline: "There is no connection to 0G.",
  };
  return `I can't decide right now. ${why[d.safeStopCause ?? ""] ?? ""}`.trim();
}
