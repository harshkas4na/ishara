import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { splitWav } from "./chunk-audio.ts";

const BIN = "/opt/homebrew/bin/whisper-server";
// Internal only, bound to 127.0.0.1. Overridable so a test or the voice eval can run a second instance.
const PORT = Number(process.env.ISHARA_WHISPER_PORT) || 7778;

// Model choice, in order of preference. The Hinglish fine-tune (Oriserve Whisper-Hindi2Hinglish-Apex, a large-v3-turbo
// derivative that writes Hindi as Roman letters) is the one that hears Harsh's mixed speech: 29% word error on
// Hinglish against 60-66% for small pinned to English (docs/audit/voice-hinglish.md). Small stays as the fallback so
// a machine without the 874 MB file still has voice, as before.
export const HINGLISH_MODEL = `${homedir()}/.cache/meeting-recorder/models/ggml-hindi2hinglish-apex-q8_0.bin`;
export const SMALL_MODEL = `${homedir()}/.cache/whisper-models/ggml-small.bin`;
// English only (Harsh, 6 Nov 2026: "stop hearing Hindi, only English"). large-v3-turbo is the Hinglish model's own base, so it is as fast
// (-ac 512, warm) and hears Indian-accented English far better than small. The Hinglish files stay on disk but are never chosen.
export const TURBO_MODEL = `${homedir()}/.cache/meeting-recorder/models/ggml-large-v3-turbo.bin`;
export const SMALL_EN_MODEL = `${homedir()}/.cache/whisper-models/ggml-small.en.bin`;

// Pure, with the filesystem lookup injected so the order can be tested without the files.
export function pickModel(env: Record<string, string | undefined>, exists: (p: string) => boolean): { path: string; hinglish: boolean } | null {
  const forced = env.ISHARA_WHISPER_MODEL;
  if (forced && exists(forced)) return { path: forced, hinglish: /hinglish|hindi2/i.test(forced) };
  if (exists(TURBO_MODEL)) return { path: TURBO_MODEL, hinglish: false };
  if (exists(SMALL_EN_MODEL)) return { path: SMALL_EN_MODEL, hinglish: false };
  if (exists(SMALL_MODEL)) return { path: SMALL_MODEL, hinglish: false };
  return null;
}

// Decoder flags (measured, audit section 4):
//  -l en     the Hinglish model writes Roman text under `en` and never Devanagari (0 of 23 clips). `auto`/`hi` put
//            English into Devanagari on the stock models.
//  -ac 512   encode a 10.24 s window instead of 30 s: 2.7 s -> 0.7 s per clip with no accuracy loss. Hence the 9 s
//            chunking in transcribe().
//  -sns      suppress non-speech tokens, so "[BLANK_AUDIO]" / "(music)" are not emitted as text.
export function serverArgs(model: string, port = PORT, env: Record<string, string | undefined> = process.env): string[] {
  const args = ["-m", model, "-l", "en", "-ac", env.ISHARA_WHISPER_AC || "512"];
  if (env.ISHARA_WHISPER_SNS !== "0") args.push("-sns");
  return [...args, "--host", "127.0.0.1", "--port", String(port), "-nt"];
}

let proc: ChildProcess | null = null;
let ready = false;
let starting: Promise<void> | null = null;
let lastError: string | null = null;
let active: { path: string; hinglish: boolean } | null = null;

export function whisperStatus(): { ok: boolean; loading: boolean; model: string | null; hinglish: boolean; error?: string } {
  return {
    ok: ready, loading: !ready && starting !== null,
    model: active ? active.path.split("/").pop()! : null, hinglish: !!active?.hinglish,
    ...(ready ? {} : { error: lastError ?? "not started yet" }),
  };
}

export function stopWhisper(): void { proc?.kill(); }
process.on("exit", stopWhisper); // once, not once per restart

// Keep one server warm: loading the model costs seconds (about 1 s for the 874 MB Hinglish model), a request on a
// warm one ~0.7 s. The helper's own listen does not wait for this; /transcribe does, up to LOAD_WAIT_MS.
export function startWhisper(): Promise<void> {
  if (ready) return Promise.resolve();
  if (starting) return starting;
  starting = (async () => {
    if (!existsSync(BIN)) { lastError = `missing ${BIN}`; return; }
    active = pickModel(process.env, existsSync);
    if (!active) { lastError = `no whisper model found (looked for ${HINGLISH_MODEL} and ${SMALL_MODEL})`; return; }
    proc = spawn(BIN, serverArgs(active.path), { stdio: ["ignore", "ignore", "ignore"] });
    proc.on("exit", (code) => { ready = false; starting = null; lastError = `whisper-server exited (${code})`; proc = null; });
    proc.on("error", (e) => { lastError = `cannot spawn: ${e.message}`; });
    // The server has no health route we rely on; any HTTP answer on the port means the model is loaded.
    for (let i = 0; i < 100 && proc; i++) {
      try { await fetch(`http://127.0.0.1:${PORT}/`, { signal: AbortSignal.timeout(500) }); ready = true; lastError = null; return; }
      catch { await new Promise((r) => setTimeout(r, 300)); }
    }
    lastError ??= "whisper-server did not become ready in 30 s";
  })().finally(() => { starting = null; });
  return starting;
}

const LOAD_WAIT_MS = 20000;

async function one(wav: Uint8Array, prompt?: string): Promise<string> {
  const form = new FormData();
  form.set("file", new Blob([wav as BlobPart], { type: "audio/wav" }), "audio.wav");
  form.set("response_format", "json");
  form.set("temperature", "0");
  // Priming with the page's own labels measurably fixed words like "Etherscan" in the lab (and helped the Hinglish model, 34% -> 29%).
  if (prompt) form.set("prompt", prompt);
  const res = await fetch(`http://127.0.0.1:${PORT}/inference`, { method: "POST", body: form, signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`whisper-server HTTP ${res.status}`);
  const j: any = await res.json();
  return String(j.text ?? "").replace(/\s+/g, " ").trim();
}

// Returns text exactly as heard (the guard in transcript-guard.ts judges it); on any failure throws, so the caller
// reports it instead of faking a transcript. Recordings over ~9 s are cut at pauses and joined.
export async function transcribe(wav: Uint8Array, prompt?: string): Promise<{ text: string; ms: number }> {
  await Promise.race([startWhisper(), new Promise<void>((r) => setTimeout(r, LOAD_WAIT_MS))]);
  if (!ready) throw new Error(whisperStatus().loading ? "whisper is still loading, try again in a moment" : (lastError ?? "whisper unavailable"));
  const t0 = Date.now();
  const parts: string[] = [];
  for (const piece of splitWav(wav)) { const t = await one(piece, prompt); if (t) parts.push(t); } // in order, one server
  return { text: parts.join(" "), ms: Date.now() - t0 };
}
