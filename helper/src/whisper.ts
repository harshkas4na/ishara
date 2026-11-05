import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";

const BIN = "/opt/homebrew/bin/whisper-server";
const MODEL = `${homedir()}/.cache/whisper-models/ggml-small.bin`;
const PORT = 7778; // internal only, bound to 127.0.0.1

let proc: ChildProcess | null = null;
let ready = false;
let starting: Promise<void> | null = null;
let lastError: string | null = null;

export function whisperStatus(): { ok: boolean; error?: string } {
  return ready ? { ok: true } : { ok: false, error: lastError ?? "not started yet" };
}

export function stopWhisper(): void { proc?.kill(); }
process.on("exit", stopWhisper); // once, not once per restart

// Keep one server warm: loading the model costs seconds, a request on a warm one ~0.5 s (measured in the lab).
export function startWhisper(): Promise<void> {
  if (ready) return Promise.resolve();
  if (starting) return starting;
  starting = (async () => {
    if (!existsSync(BIN)) { lastError = `missing ${BIN}`; return; }
    if (!existsSync(MODEL)) { lastError = `missing model ${MODEL}`; return; }
    proc = spawn(BIN, ["-m", MODEL, "-l", "en", "--host", "127.0.0.1", "--port", String(PORT), "-nt"], { stdio: ["ignore", "ignore", "ignore"] });
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

// Returns text exactly as heard; on any failure throws, so the caller reports it instead of faking a transcript.
export async function transcribe(wav: Uint8Array, prompt?: string): Promise<{ text: string; ms: number }> {
  await startWhisper();
  if (!ready) throw new Error(lastError ?? "whisper unavailable");
  const t0 = Date.now();
  const form = new FormData();
  form.set("file", new Blob([wav as BlobPart], { type: "audio/wav" }), "audio.wav");
  form.set("response_format", "json");
  form.set("temperature", "0");
  // Priming with the page's own labels measurably fixed words like "Etherscan" in the lab.
  if (prompt) form.set("prompt", prompt);
  const res = await fetch(`http://127.0.0.1:${PORT}/inference`, { method: "POST", body: form, signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`whisper-server HTTP ${res.status}`);
  const j: any = await res.json();
  return { text: String(j.text ?? "").trim(), ms: Date.now() - t0 };
}
