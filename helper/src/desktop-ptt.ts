// Desktop push-to-talk: hold Right Option (350 ms) anywhere on the Mac, speak, release. ishara-ptt (Swift) watches the keys
// and records the mic; this file turns its JSON lines into the same flow the browser has: a live level meter, a refusal
// for silence, Whisper, a noise-phrase filter, then desktopAsk() (read the front window, the streaming tutor turn, draw
// and speak). A new key-down cuts the old answer off (voice and turn) so the user can always interrupt.
// Every outside effect is injected (`PttDeps`) so the pipeline is tested with fakes.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
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

export function meter(rms: number): string {
  const n = Math.max(0, Math.min(10, Math.round(Math.sqrt(rms) * 28)));
  return "Listening…\n" + "▮".repeat(n) + "▯".repeat(10 - n);
}

export type DaemonHandle = { kill(): void };
export type PttDeps = {
  send: (c: OverlayCmd) => void;
  transcribe: (wav: Uint8Array) => Promise<{ text: string }>;
  ask: (question: string, signal: AbortSignal) => Promise<unknown>;
  front: () => Promise<FrontApp | null>;   // which app is in front, read without reading its window
  spawnDaemon: (onLine: (l: string) => void, onExit: (code: number | null) => void) => DaemonHandle;
  now: () => number;
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
  let lastMeterAt = -Infinity, lastMeterText = "";
  let gen = 0;              // bumped on every key-down; a take from an older generation is dropped, never answered late
  let turnAbort: AbortController | null = null;
  let skipTake = false;     // the front app is a browser: the extension owns it, this take is ignored
  let frontCheck: Promise<void> = Promise.resolve();

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
        gen++; turnAbort?.abort(); turnAbort = null;   // cut off the running turn, not only its voice
        interrupt(); /* silence the voice before the mic is live: no echo into the recording */
        lastMeterAt = -Infinity; lastMeterText = ""; skipTake = false;
        d.send({ cmd: "think", text: "Listening… release to send" }); // instant feedback at the 350 ms mark
        // A browser is the extension's: say so and ignore this take. Checked after the bubble so feedback is never late.
        frontCheck = d.front().then((f) => {
          if (f && isBrowserBundle(f.bundleId)) { skipTake = true; d.send({ cmd: "ask", text: BROWSER_HINT }); }
        }, () => {});
        break;
      }
      case "level": {
        if (skipTake) break;
        const t = d.now(), text = meter(Number(ev.rms) || 0);
        // Throttle, and skip repeats: an unchanged bar needs no redraw.
        if (t - lastMeterAt < METER_EVERY_MS || text === lastMeterText) break;
        lastMeterAt = t; lastMeterText = text;
        d.send({ cmd: "think", text });
        break;
      }
      case "up": void onUp(ev); break;
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
