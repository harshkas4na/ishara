// Desktop push-to-talk: hold Right Option anywhere on the Mac, speak, release. The daemon captures from the KEY-DOWN
// (pre-roll) and keeps the take only if the 350 ms hold is confirmed, so the first words are not lost. ishara-ptt (Swift) watches the keys
// and records the mic; this file turns its JSON lines into the same flow the browser has: a live level meter, a refusal
// for silence, Whisper, a noise-phrase filter, then desktopAsk() (read the front window, the streaming tutor turn, draw
// and speak). A new key-down cuts the old answer off (voice and turn) so the user can always interrupt.
// Every outside effect is injected (`PttDeps`) so the pipeline is tested with fakes.
import { spawn } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { desktopAsk, frontApp, isBrowserBundle, overlay, BROWSER_HINT, type FrontApp, type OverlayCmd } from "./desktop.ts";
import { transcribe } from "./whisper.ts";
import { minRms, transcribeGuarded } from "./transcript-guard.ts";
import { interrupt } from "./speech.ts";

export const PTT_BIN = fileURLToPath(new URL("../../desktop/ishara-ptt", import.meta.url));

// Same thresholds as the browser path (extension/background.js, content.js): under 0.25 s is a tap, under 0.006
// RMS is silence that Whisper would turn into a made-up word, and a handful of stock phrases are what it says to noise.
export const MIN_SAMPLES = 0.25 * 16000;
export const MIN_RMS = minRms(); // ISHARA_MIN_RMS overrides; stock phrases and short words are judged by transcript-guard.ts
export const METER_EVERY_MS = 150; // overlay is a JSON line to another process; 8 Hz is smooth enough, 120 ms floods

// Feedback timing. Capture has already started at the key-down; the pill appears FEEDBACK_AFTER_MS later so that a tap or an
// Option+letter keystroke (cancelled within a few ms) flashes nothing. Until the microphone is live it says PREPARING,
// then LISTENING "Speak now" with a soft tick (docs/UI-PILL.md), through the overlay's `state` command.
export const FEEDBACK_AFTER_MS = 120;

export type DaemonHandle = { kill(): void };
export type PttDeps = {
  send: (c: OverlayCmd) => void;
  transcribe: (wav: Uint8Array) => Promise<{ text: string }>;
  ask: (question: string, signal: AbortSignal) => Promise<unknown>;
  front: () => Promise<FrontApp | null>;   // which app is in front, read without reading its window
  spawnDaemon: (onLine: (l: string) => void, onExit: (code: number | null) => void) => DaemonHandle;
  now: () => number;
  interrupt?: () => void;                  // silence the speaker (default: the speech module's); injectable for tests
  tick: () => void;                        // the short soft "speak now" sound (no-op when ISHARA_TICK=0)
  setTimer: (fn: () => void, ms: number) => unknown;
  clearTimer: (t: unknown) => void;
};

export type PttStatus = { running: boolean; chord?: string; lastError?: string };

// All state lives in one object so tests can build as many pipelines as they like.
export function createPtt(d: PttDeps) {
  let handle: DaemonHandle | null = null;
  let wanted = false;       // startPtt() was called and stopPtt() has not
  let ready = false;
  let chord: string | undefined;
  let lastError: string | undefined;
  let fatal = false;        // a permission error: restarting would only repeat it
  let backoff = 1000;
  let startedAt = 0;
  let restartTimer: unknown = null;
  let lastMeterAt = -Infinity;
  let gen = 0;              // bumped on every key-down; a take from an older generation is dropped, never answered late
  let turnAbort: AbortController | null = null;
  let skipTake = false;     // the front app is a browser: the extension owns it, this take is ignored
  let frontCheck: Promise<void> = Promise.resolve();
  let takeActive = false;   // between `down` and `up`/`cancel`
  let liveSeen = false;     // the microphone has delivered its first buffer for this take
  let feedbackDue = false;  // FEEDBACK_AFTER_MS has passed since the key-down
  let pill: "none" | "preparing" | "listening" = "none"; // what the pill shows for this take
  let feedbackTimer: unknown = null;

  // Show the state that is true now: PREPARING until the mic is live, then LISTENING + tick (once per take).
  function showFeedback(mine: number): void {
    if (mine !== gen || !takeActive || skipTake || !feedbackDue) return;
    if (liveSeen) {
      if (pill === "listening") return;
      pill = "listening"; lastMeterAt = -Infinity;
      d.send({ cmd: "state", state: "listening" });
      d.tick();
    } else if (pill === "none") { pill = "preparing"; d.send({ cmd: "state", state: "preparing" }); }
  }
  const stopBubble = (text: string, sub?: string) => d.send({ cmd: "stop", text, sub });

  async function onUp(ev: any): Promise<void> {
    const mine = gen;
    await frontCheck;                 // the browser check started at key-down; it is ~30 ms, usually long done
    if (skipTake) return;             // nothing was recorded for anyone: the hint stays on screen
    await take(ev, mine);
  }
  async function take(ev: any, mine: number): Promise<void> {
    const samples = Number(ev.samples) || 0, maxRms = Number(ev.maxRms) || 0;
    if (samples < MIN_SAMPLES) return stopBubble("Too short.", "Hold the keys while you speak, then release.");
    if (maxRms < MIN_RMS) return stopBubble("I could not hear any sound from the microphone.", "Check the input device and the Microphone permission.");
    d.send({ cmd: "think", text: "Transcribing…" });
    let text: string;
    try {
      text = (await d.transcribe(Buffer.from(String(ev.wavBase64 ?? ""), "base64"))).text.trim();
    } catch (e: any) {
      return stopBubble("I could not transcribe that.", String(e?.message ?? e)); // never fake a transcript
    }
    if (mine !== gen) return;         // the user pressed the key again while this was transcribing: that is the live question now
    if (!text) return stopBubble("I heard nothing. Try again."); // the helper guard returns "" for noise, blank and wrong-script output
    // Show what was understood before the (slow) sealed calls: a wrong transcript is then visible, not mysterious.
    d.send({ cmd: "think", text: `I heard: “${text}” …thinking` });
    turnAbort = new AbortController();
    const mySignal = turnAbort.signal;
    try { await d.ask(text, mySignal); }
    catch (e: any) { if (mine === gen) stopBubble("Something went wrong.", String(e?.message ?? e)); } // e.g. the Accessibility message
  }

  function onLine(line: string): void {
    let ev: any;
    try { ev = JSON.parse(line); } catch { return; } // the daemon only prints JSON; anything else is ignorable noise
    switch (ev?.ev) {
      case "ready": ready = true; chord = ev.chord; lastError = undefined; break;
      case "down": {
        const mine = ++gen; turnAbort?.abort(); turnAbort = null;
        lastMeterAt = -Infinity; skipTake = false;
        takeActive = true; liveSeen = false; feedbackDue = false; pill = "none";
        if (feedbackTimer) d.clearTimer(feedbackTimer);
        feedbackTimer = d.setTimer(() => { feedbackTimer = null; feedbackDue = true; void frontCheck.then(() => showFeedback(mine)); }, FEEDBACK_AFTER_MS);
        // Which app is in front decides everything else. A browser is the extension's: this take is ignored and the daemon
        // must not touch its answer (no interrupt: a stray Right-Option tap in the browser must not cut the extension's voice).
        frontCheck = d.front().then((f) => {
          if (mine !== gen) return;
          if (f && isBrowserBundle(f.bundleId)) skipTake = true;
          else (d.interrupt ?? interrupt)(); /* silence the voice: no echo into the recording */
        }, () => {});
        break;
      }
      case "live": { liveSeen = true; const mine = gen; void frontCheck.then(() => showFeedback(mine)); break; }
      case "confirmed": {
        // A deliberate hold. Only now is the browser hint shown (a tap in a browser must not flash it).
        const mine = gen;
        void frontCheck.then(() => { if (mine === gen && takeActive && skipTake) d.send({ cmd: "ask", text: BROWSER_HINT }); });
        break;
      }
      case "cancel": { // released or interrupted inside the hold: a tap. The daemon dropped the audio; drop the pill.
        takeActive = false;
        if (feedbackTimer) { d.clearTimer(feedbackTimer); feedbackTimer = null; }
        if (pill !== "none") d.send({ cmd: "state", state: "idle" });
        pill = "none";
        break;
      }
      case "level": {
        if (skipTake || pill !== "listening") break; // bars exist only once the pill says "Speak now"
        const t = d.now();
        if (t - lastMeterAt < METER_EVERY_MS) break; // throttle: the overlay is a JSON line to another process
        lastMeterAt = t;
        d.send({ cmd: "level", rms: Math.max(0, Number(ev.rms) || 0) });
        break;
      }
      case "up":
        takeActive = false;
        if (feedbackTimer) { d.clearTimer(feedbackTimer); feedbackTimer = null; }
        void onUp(ev); break;
      case "error":
        lastError = String(ev.message ?? "ishara-ptt failed");
        // A runtime microphone failure (device vanished, engine would not start) says fatal:false: tell the user, keep
        // the daemon, let the next hold try again.
        if (ev.fatal === false) { stopBubble("The microphone did not work.", lastError); break; }
        // Permission errors are final: show once, do not restart (the daemon exits 2 right after this line).
        if (ev.code === "input-monitoring" || ev.code === "microphone" || ev.code === "config") {
          fatal = true;
          stopBubble("Push-to-talk cannot start.", lastError);
        }
        break;
    }
  }

  function onExit(code: number | null): void {
    handle = null; ready = false;
    if (!wanted) return;
    if (code === 2 || fatal) { fatal = true; lastError ??= "ishara-ptt exited with a permission error"; return; }
    // A daemon that lived a while earns a fast restart; one that dies at once backs off up to 30 s.
    if (d.now() - startedAt > 10_000) backoff = 1000;
    lastError = `ishara-ptt exited (${code}); restarting in ${Math.round(backoff / 1000)} s`;
    restartTimer = d.setTimer(launch, backoff);
    backoff = Math.min(backoff * 2, 30_000);
  }

  function launch(): void {
    restartTimer = null;
    if (!wanted || handle) return;
    startedAt = d.now();
    // Events count only while THIS daemon is the current one, and its exit counts once. Before, a daemon that was
    // stopped and replaced reported its exit late, cleared the new handle and launched a second daemon (two key taps,
    // two recorders); and a process can emit both "error" and "exit", which scheduled two restarts.
    let live = true;
    const h: DaemonHandle = d.spawnDaemon((l) => { if (live && handle === h) onLine(l); }, (code) => {
      if (!live) return;
      live = false;
      if (handle === h) onExit(code);
    });
    handle = h;
  }

  return {
    onLine, onExit,
    start(): void { if (wanted) return; wanted = true; fatal = false; launch(); },
    stop(): void {
      wanted = false;
      if (restartTimer) d.clearTimer(restartTimer);
      restartTimer = null; handle?.kill(); handle = null; ready = false;
    },
    status(): PttStatus { return { running: !!handle && ready, chord, lastError }; },
  };
}

// ---------- the real thing ----------

// The "speak now" tick: 40 ms of 880 Hz, 10 ms fade in and out, quiet. Played by afplay from a tiny WAV in the temp dir
// (it is a sound we made, not microphone audio; recordings are never written to disk). It plays a moment BEFORE the user
// speaks and a few dB below speech, and the transcript guard drops what Whisper might still make of it (see docs/DESKTOP.md).
let tickPath: string | null = null;
export function tickWav(): Buffer {
  const rate = 16000, n = Math.round(rate * 0.04), fade = Math.round(rate * 0.01);
  const b = Buffer.alloc(44 + n * 2);
  b.write("RIFF", 0); b.writeUInt32LE(36 + n * 2, 4); b.write("WAVEfmt ", 8); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22); b.writeUInt32LE(rate, 24); b.writeUInt32LE(rate * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34);
  b.write("data", 36); b.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) {
    const env = Math.min(1, i / fade, (n - 1 - i) / fade);
    b.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 880 * i) / rate) * env * 0.5 * 32767), 44 + i * 2);
  }
  return b;
}
function playTick(): void {
  if (process.env.ISHARA_TICK === "0") return;
  try {
    if (!tickPath) { tickPath = join(tmpdir(), `ishara-tick-${process.pid}.wav`); writeFileSync(tickPath, tickWav()); }
    spawn("/usr/bin/afplay", ["-v", "0.35", tickPath], { stdio: "ignore" }).on("error", () => {});
  } catch { /* a missing tick must never break a take */ }
}

const real = createPtt({
  send: (c) => overlay.send(c),
  transcribe: (wav) => transcribeGuarded(wav, undefined, transcribe), // same guard as POST /transcribe
  ask: (q, signal) => desktopAsk(q, { signal, alreadyThinking: true }),
  front: frontApp,
  spawnDaemon(onLine, onExit) {
    // stdout carries events; stderr is inherited so the daemon's own diagnostics reach the helper log.
    const p = spawn(PTT_BIN, [], { stdio: ["ignore", "pipe", "inherit"] });
    let buf = "";
    p.stdout!.on("data", (c) => {
      buf += c;
      let i: number;
      while ((i = buf.indexOf("\n")) >= 0) { onLine(buf.slice(0, i)); buf = buf.slice(i + 1); }
    });
    p.on("error", () => onExit(1));
    p.on("exit", onExit);
    return { kill: () => p.kill("SIGTERM") }; // SIGTERM lets the daemon close the mic first
  },
  tick: playTick,
  now: Date.now,
  setTimer: (fn, ms) => setTimeout(fn, ms),
  clearTimer: (t) => clearTimeout(t as any),
});

export function startPtt(): boolean {
  if (!existsSync(PTT_BIN)) return false; // not built: do nothing, never prompt for permissions uninvited
  real.start();
  return true;
}
export const stopPtt = () => real.stop();
export const pttStatus = () => real.status();
