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
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { detectLang, hinglishToDevanagari, pickVoice, voiceConfig, langOfVoice, type VoiceConfig } from "./speech-lang.ts";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
export const KOKORO_PY = join(ROOT, "voice/.venv/bin/python");
export const KOKORO_SCRIPT = join(ROOT, "voice/kokoro_server.py");
export const MUTE_FILE = join(ROOT, "helper/.data/speech.json");

// ---------- pure text rules (unit tested) ----------

// The WHOLE answer is spoken. There used to be a 40-word cap here and it cut every answer after about three
// sentences ("it never completes the response, it always stops before the last line"). The only limit left is a
// sanity ceiling against a runaway model: the 0G reply is already capped near 350 tokens (~260 words), so 400
// words is above anything legitimate, and it is checked per sentence (the sentence that crosses it is still
// spoken to its end, only the sentences after it are dropped, and the status says so).
export const MAX_ANSWER_WORDS = 400;
// Kokoro synthesises best and fastest in sentence-sized pieces. A sentence longer than this is cut at commas
// (then at word boundaries if it has none) into pieces of at most this many words. Nothing is dropped: the
// pieces joined are exactly the sentence.
export const MAX_PIECE_WORDS = 30;
// The first sentence of an answer longer than this is also split at commas, so the first words reach the speaker
// sooner (synthesis time grows with length; the next clause is made while the person listens to the first).
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

// Split on sentence ends (. ! ? the Hindi danda and newlines). Abbreviation-safe enough for short UI answers: a
// full stop only ends a sentence when followed by space and a capital, digit or Devanagari letter, so "e.g. the
// button" and "3.5" stay whole. The danda "।" always ends one.
export function splitSentences(text: string): string[] {
  const out: string[] = [];
  for (const para of text.split(/\n+/)) {
    const parts = para.split(/(?<=[.!?…])["')\]]*\s+(?=[A-Z0-9"'(ऀ-ॿ])|(?<=।)["')\]]*\s*/);
    for (const p of parts) { const t = p.trim(); if (t) out.push(t); }
  }
  return out;
}

const words = (s: string) => s.split(/\s+/).filter(Boolean).length;
const SENTENCE_END = /[.!?…।]["')\]]*\s*$/;

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

// One sentence longer than MAX_PIECE_WORDS becomes several pieces, never fewer words: first at commas, and any
// stretch with no comma at plain word boundaries. Short sentences come back as they are.
export function splitLong(sentence: string, max = MAX_PIECE_WORDS): string[] {
  if (words(sentence) <= max) return [sentence];
  const out: string[] = [];
  let cur = "";
  const push = () => { if (cur) { out.push(cur); cur = ""; } };
  for (const part of sentence.split(/(?<=[,;:])\s+/)) {
    if (words(part) > max) { // a comma-free run: cut it by words
      push();
      const w = part.split(/\s+/).filter(Boolean);
      for (let i = 0; i < w.length; i += max) out.push(w.slice(i, i + max).join(" "));
    } else if (words(cur) + words(part) > max) { push(); cur = part; }
    else cur = cur ? `${cur} ${part}` : part;
  }
  push();
  return out;
}

export type Sentences = { sentences: string[]; clipped: boolean };
// Clean one answer and split it into sentences, applying the runaway ceiling. `used` is how many words of this
// answer were already queued (streaming adds text in several calls).
export function sentencesOf(raw: string, used = 0, ceiling = MAX_ANSWER_WORDS): Sentences {
  const clean = cleanForSpeech(raw);
  const out: string[] = [];
  let clipped = false;
  for (const sent of splitSentences(clean)) {
    if (used >= ceiling) { clipped = true; break; }
    out.push(sent); used += words(sent);
  }
  return { sentences: out, clipped };
}

// Everything above in one call for a whole answer: the pieces that are synthesised one by one, in order. The
// first sentence also gets the faster-first-sound clause split.
export function prepare(raw: string, ceiling = MAX_ANSWER_WORDS): string[] {
  return sentencesOf(raw, 0, ceiling).sentences.flatMap((s, i) => (i === 0 ? clauses(s) : [s]).flatMap((c) => splitLong(c)));
}

// ---------- the queue (all outside effects injected) ----------

export type Engine = "kokoro" | "system" | "none";
// `ms` (optional) is the known length of the audio. afplay keeps running 0.4 to 0.9 s after the sound has ended
// (measured here: a 3.18 s clip takes 3.87 s from spawn to exit), so waiting for it to exit before starting the
// next sentence put an audible half-second hole after every sentence. With `ms`, the next piece is started
// LEAD_MS before the sound ends (afplay needs ~0.2 s to start making sound), and the old process just finishes.
export type Playing = { done: Promise<void>; kill(): void; ms?: number };
export const LEAD_MS = Number(process.env.ISHARA_VOICE_LEAD_MS ?? 250);
export type Voice = {
  engine: Engine;
  // Synthesise one piece to a WAV file and resolve its path; reject on failure. Absent for the "system" engine.
  // `o` names the Kokoro voice and espeak language for this piece (English and Hindi pieces alternate).
  synth?: (text: string, o?: { voice: string; lang: string }) => Promise<string>;
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
  engine: Engine; voice: string; voiceHi: string; muted: boolean; enabled: boolean; ready: boolean;
  speaking: boolean; queued: number; spoken: number; pieces: number; maxGapMs?: number; clipped?: boolean;
  lastFirstAudioMs?: number; reason?: string; lastError?: string;
};

// What the UI is told. Both are optional and replaced per turn (setHooks): the /tutor route installs its own at
// the start of each question, so a late callback can never reach an older stream.
export type SpeechHooks = {
  // Playback of the sentence tagged `tag` (the `say` seq) is starting now. `text` is the cleaned sentence.
  onSentenceStart?: (tag: number, text: string) => void;
  // The answer has been flushed and the voice has gone quiet (or it was interrupted after speaking began).
  onIdle?: () => void;
};
export type SayOpts = { voice?: string; lang?: string; translit?: boolean }; // per-call voice override (the sampler)

// The pick rule on its own so it is testable: kokoro if it is installed and came up, else the macOS voice, else none.
export function pickEngine(o: { forced?: string; kokoroReady: boolean; systemAvailable: boolean }): Engine {
  if (o.forced === "system") return o.systemAvailable ? "system" : "none";
  if (o.kokoroReady) return "kokoro";
  return o.systemAvailable ? "system" : "none";
}

type Piece = { text: string; tag?: number; shown?: string; last: boolean; force?: SayOpts };
type Job = { piece: Piece; file: Promise<string | null> };
const LOOKAHEAD = 2; // pieces synthesised ahead of the one playing: covers a long sentence following a short one

export function createSpeaker(d: SpeechDeps, cfg: VoiceConfig = voiceConfig(), maxPiece = MAX_PIECE_WORDS) {
  let voice: Voice | null = null;
  let reason: string | undefined = d.enabled ? "not started" : "disabled by ISHARA_SPEAK=0";
  let starting: Promise<void> | null = null;
  let muted = false;
  try { muted = d.readMuted(); } catch { /* unreadable mute file: default unmuted */ }
  let gen = 0;                  // bumped by interrupt(); work that belongs to an older generation is discarded
  let pending: Piece[] = [];    // pieces waiting to be synthesised
  let ready: Job[] = [];        // synthesised or in flight, in order
  let current: Playing | null = null;
  const ringing = new Set<Playing>(); // started and not yet exited (a finished sentence can still be winding down)
  let pumping = false;
  let buf = "";                 // enqueue() text not yet ended by a sentence boundary
  let used = 0;                 // words of the current answer already queued (the runaway ceiling)
  let sentNo = 0;               // sentences of the current answer already queued (the first one gets the clause split)
  let clipped = false;
  let spoken = 0, pieces = 0, lastError: string | undefined, lastFirst: number | undefined;
  let answerStart = 0, firstDone = true;
  let lastEnd = 0, maxGap = 0;  // silence between two pieces of one answer, ms
  let hooks: SpeechHooks = {};
  let announced = false;        // a sentence-start was sent this turn, so an idle must follow
  let ending = false;           // flush() was called: the turn is over, report idle when the queue drains
  let waiters: (() => void)[] = [];

  async function ensure(): Promise<void> {
    if (voice || !d.enabled) return;
    starting ??= d.start().then((r) => { voice = r.voice; reason = r.voice ? undefined : r.reason; }).finally(() => { starting = null; });
    await starting;
  }
  const fire = (f: () => void) => { try { f(); } catch { /* a UI callback must never break speech */ } };
  const quiet = () => !current && !ringing.size && !pending.length && !ready.length && !pumping;
  // The voice is silent and the turn is over (or was cut): tell the UI once and release whoever awaits flush().
  function settle() {
    const w = waiters; waiters = []; ending = false;
    if (announced) { announced = false; fire(() => hooks.onIdle?.()); }
    for (const f of w) f();
  }

  function newAnswer() { used = 0; sentNo = 0; clipped = false; }
  // One chunk of text (already complete sentences) -> queued pieces. `tag` marks the first piece of the first
  // sentence so the UI hears about it once, however many pieces it was split into.
  function toPieces(text: string, tag?: number, force?: SayOpts): Piece[] {
    const r = sentencesOf(text, used);
    if (r.clipped) { clipped = true; console.warn(`[speech] answer passed ${MAX_ANSWER_WORDS} words; the rest is not spoken`); }
    const out: Piece[] = [];
    r.sentences.forEach((sent, i) => {
      used += words(sent);
      const cl = (sentNo++ === 0 ? clauses(sent) : [sent]).flatMap((c) => splitLong(c, maxPiece));
      cl.forEach((c, j) => out.push({ text: c, last: j === cl.length - 1, force, ...(tag !== undefined && i === 0 && j === 0 ? { tag, shown: cleanForSpeech(text) } : {}) }));
    });
    return out;
  }
  function add(ps: Piece[]) {
    if (!ps.length || muted || !d.enabled) return;
    if (pending.length === 0 && ready.length === 0 && !current) { answerStart = d.now(); firstDone = false; maxGap = 0; lastEnd = 0; }
    pending.push(...ps);
    if (pumping) fill(); else void pump();
  }

  // Synthesis runs ahead of playback: while piece N plays, N+1 and N+2 are made, so there is no gap between
  // sentences. fill() is also called when text arrives mid-playback (streaming), not only between pieces.
  // The voice and language are chosen per piece, so an English sentence followed by a Hindi one is simply two
  // jobs with different voices, both made before the first one ends.
  function fill(): void {
    while (pending.length && ready.length < (current ? LOOKAHEAD : LOOKAHEAD + 1) && voice) {
      const piece = pending.shift()!;
      const v = voice;
      let file: Promise<string | null>;
      if (v.synth) {
        const f = piece.force;
        const pick = f?.voice ? { voice: f.voice, lang: f.lang ?? langOfVoice(f.voice), text: f.translit === false || detectLang(piece.text) !== "hinglish" ? piece.text : hinglishToDevanagari(piece.text) } : pickVoice(piece.text, cfg);
        file = v.synth(pick.text, { voice: pick.voice, lang: pick.lang }).catch((e) => { lastError = String(e?.message ?? e); return null; });
      } else file = Promise.resolve(piece.text);
      ready.push({ piece, file });
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
          const t = d.now();
          if (lastEnd) maxGap = Math.max(maxGap, t - lastEnd);
          const pl = voice.play(f);
          current = pl; ringing.add(pl);
          const synthesised = !!voice.synth;
          // When it has really exited: forget it, delete its temp file, and report idle if that was the last sound.
          void pl.done.catch((e: any) => { lastError = String(e?.message ?? e); }).then(() => {
            ringing.delete(pl); if (synthesised) d.cleanup(f);
            if (ending && quiet()) settle();
          });
          const p = item.piece;
          if (p.tag !== undefined && !muted) { announced = true; fire(() => hooks.onSentenceStart?.(p.tag!, p.shown ?? p.text)); }
          fill(); // start making the next pieces now, while this one plays
          if (!firstDone) { firstDone = true; lastFirst = d.now() - answerStart; }
          // Wait for the sound to end: by its known length minus the lead when we have one, else for the exit.
          const early = pl.ms !== undefined ? new Promise<void>((r) => setTimeout(r, Math.max(0, pl.ms! - LEAD_MS))) : null;
          try { await (early ? Promise.race([pl.done, early]) : pl.done); pieces++; if (p.last) spoken++; } catch (e: any) { lastError = String(e?.message ?? e); }
          lastEnd = d.now(); // maxGapMs = how late the NEXT piece was started after this one was due (0 = on time)
          if (current === pl) current = null;
        }
      }
    } finally {
      pumping = false;
      if (pending.length && !muted && voice) void pump();
      else if (ending && quiet()) settle();
    }
  }

  return {
    // speak(): one whole answer. enqueue()/flush(): the same, streamed: text is cut at sentence ends as it arrives.
    speak(text: string, o?: SayOpts): void { newAnswer(); add(toPieces(text, undefined, o)); },
    // enqueue(text): untagged streaming text, held until a sentence ends. enqueue(text, tag): one complete sentence
    // (a `say` event) that the UI should hear about when it starts playing; spoken at once, never merged.
    enqueue(text: string, tag?: number): void {
      if (tag !== undefined) { add(toPieces(text, tag)); return; }
      buf += text;
      const parts = splitSentences(buf);
      // The last part may be a sentence still arriving; hold it unless it already ends in . ! ? or the danda
      const ended = SENTENCE_END.test(buf);
      const complete = ended ? parts : parts.slice(0, -1);
      buf = ended ? "" : (parts[parts.length - 1] ?? "");
      if (complete.length) add(toPieces(complete.join(" ")));
    },
    // End of the turn: speak the trailing sentence that has no final punctuation, and resolve once the voice is
    // quiet (immediately when nothing is playing). The /tutor route awaits it to send the final `speaking: idle`.
    flush(): Promise<void> {
      const t = buf; buf = "";
      if (t.trim()) add(toPieces(t));
      newAnswer();
      return new Promise<void>((res) => { waiters.push(res); ending = true; if (quiet()) settle(); });
    },
    // Stop talking now and forget the rest. Called on every new question (push-to-talk down, typed ask) so the
    // voice never talks over the person and never leaks into a recording.
    interrupt(): void {
      gen++; pending = []; buf = ""; newAnswer();
      const old = ready; ready = [];
      for (const r of old) void r.file.then((f) => { if (f && voice?.synth) d.cleanup(f); });
      current = null; for (const r of ringing) r.kill(); // the sentence now playing AND any still winding down
      settle(); // the UI must hear "idle" for the answer that was just cut
    },
    setHooks(h: SpeechHooks): void { hooks = h; },
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
        engine: voice?.engine ?? "none", voice: voice?.engine === "kokoro" ? cfg.en : voice?.engine === "system" ? "macOS" : "-",
        voiceHi: voice?.engine === "kokoro" ? cfg.hi : "-",
        muted, enabled: d.enabled, ready: !!voice, speaking: !!current || ringing.size > 0, queued: pending.length + ready.length, spoken, pieces,
        ...(maxGap ? { maxGapMs: maxGap } : {}), ...(clipped ? { clipped } : {}),
        ...(lastFirst !== undefined ? { lastFirstAudioMs: lastFirst } : {}),
        ...(voice ? {} : { reason: reason ?? "not started" }), ...(lastError ? { lastError } : {}),
      };
    },
  };
}

// ---------- the real thing ----------

const CFG = voiceConfig(); // ISHARA_VOICE_EN (or the older ISHARA_VOICE) and ISHARA_VOICE_HI, checked against the installed list
let child: ChildProcess | null = null;
let seq = 0;
const waiting = new Map<number, { ok: (p: string) => void; fail: (e: Error) => void; out: string }>();

function afplay(path: string): Playing {
  const p = spawn("/usr/bin/afplay", [path], { stdio: "ignore" });
  const done = new Promise<void>((res, rej) => { p.on("exit", () => res()); p.on("error", rej); });
  let ms: number | undefined;
  try { ms = Math.max(0, (statSync(path).size - 44) / 48); } catch { /* unknown length: wait for the exit instead */ } // 24 kHz mono 16-bit = 48 bytes per ms
  return { done, ms, kill: () => p.kill("SIGKILL") }; // SIGKILL: stop at once, not at the end of the buffer
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
  const p = spawn(KOKORO_PY, [KOKORO_SCRIPT], { stdio: ["pipe", "pipe", "ignore"], env: { ...process.env, ISHARA_VOICE_EN: CFG.en } });
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
            synth: (text, o) => new Promise<string>((ok, fail2) => {
              const id = ++seq, out = join(dir, `${id}.wav`);
              waiting.set(id, { ok, fail: fail2, out });
              p.stdin!.write(JSON.stringify({ id, text, out, ...(o ? { voice: o.voice, lang: o.lang } : {}) }) + "\n");
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
}, CFG);

export const speaker = real;
// Only the process that started speech (the helper server) ever speaks. Before this, any script that imported decide()
// (scripts/eval.ts, smoke.ts) started its own Kokoro, read every eval answer aloud, and never exited: the child's pipes
// kept node alive.
let started = false;
export const startSpeech = () => { started = true; return real.start(); };
export const stopSpeech = () => real.stop();
export const speak = (t: string, o?: SayOpts) => { if (started) real.speak(t, o); };
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
