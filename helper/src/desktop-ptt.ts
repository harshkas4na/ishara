// Desktop push-to-talk: hold a chord anywhere on the Mac, speak, release. ishara-ptt (Swift) watches the keys and
// records the mic; this file turns its JSON lines into the same flow the browser has: a live level meter, a refusal
// for silence, Whisper, a noise-phrase filter, then desktopAsk() (read the front window, sealed 0G calls, draw).
// Every outside effect is injected (`PttDeps`) so the pipeline is tested with fakes.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { desktopAsk, overlay, type OverlayCmd } from "./desktop.ts";
import { decide } from "./decide.ts";
import { transcribe } from "./whisper.ts";

export const PTT_BIN = fileURLToPath(new URL("../../desktop/ishara-ptt", import.meta.url));

// Same thresholds as the browser path (extension/background.js, content.js): under 0.25 s is a tap, under 0.006
// RMS is silence that Whisper would turn into a made-up word, and a handful of stock phrases are what it says to noise.
export const MIN_SAMPLES = 0.25 * 16000;
export const MIN_RMS = 0.006;
export const NOISE = /^(you|thank you|thanks|thanks for watching|bye|okay|ok|the|uh|um|hmm|\.+)\W*$/i;
export const METER_EVERY_MS = 150; // overlay is a JSON line to another process; 8 Hz is smooth enough, 120 ms floods

export function meter(rms: number): string {
  const n = Math.max(0, Math.min(10, Math.round(Math.sqrt(rms) * 28)));
  return "Listening…\n" + "▮".repeat(n) + "▯".repeat(10 - n);
}

export type DaemonHandle = { kill(): void };
export type PttDeps = {
  send: (c: OverlayCmd) => void;
  transcribe: (wav: Uint8Array) => Promise<{ text: string }>;
  ask: (question: string) => Promise<unknown>;
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
  let busy = false;         // a take is being transcribed or answered; a second one must not race it

  const stopBubble = (text: string, sub?: string) => d.send({ cmd: "stop", text, sub });

  async function onUp(ev: any): Promise<void> {
    if (busy) return stopBubble("Still answering the last question.", "Ask again when it is done.");
    busy = true;
    try { await take(ev); } finally { busy = false; }
  }
  async function take(ev: any): Promise<void> {
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
    if (text.length < 3 || NOISE.test(text)) return stopBubble(`I heard “${text}”, which is probably noise. Try again.`);
    // Show what was understood before the (slow) sealed calls: a wrong transcript is then visible, not mysterious.
    d.send({ cmd: "think", text: `I heard: “${text}” …thinking` });
    try { await d.ask(text); }
    catch (e: any) { stopBubble("Something went wrong.", String(e?.message ?? e)); } // e.g. the Accessibility message
  }

  function onLine(line: string): void {
    let ev: any;
    try { ev = JSON.parse(line); } catch { return; } // the daemon only prints JSON; anything else is ignorable noise
    switch (ev?.ev) {
      case "ready": ready = true; chord = ev.chord; lastError = undefined; break;
      case "down": lastMeterAt = -Infinity; lastMeterText = ""; d.send({ cmd: "think", text: "Listening… release to send" }); break;
      case "level": {
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
    handle = d.spawnDaemon(onLine, onExit);
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
  transcribe: (wav) => transcribe(wav),
  ask: (q) => desktopAsk(q, decide),
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
