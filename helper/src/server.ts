import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { extname } from "node:path";
import { HELPER_PORT } from "./config.ts";
import { decide, recordsFor, tutorTurn, tutorWalk } from "./decide.ts";
import { handleTutorRoute } from "./tutor-route.ts";
import { hasKey, warm, testRouterActive } from "./zg.ts";
import { episodeLog } from "./episode-log.ts";
import { desktopAsk, warmDesktop } from "./desktop.ts";
import { readdirSync, statSync } from "node:fs";
import { join as joinPath } from "node:path";
import { startWhisper, stopWhisper, transcribe, whisperStatus } from "./whisper.ts";
import { minRms, transcribeGuarded } from "./transcript-guard.ts";
import { pttStatus, startPtt, stopPtt } from "./desktop-ptt.ts";
import { startSpeech, stopSpeech, speechStatus, speaker } from "./speech.ts";
import { memory, memoryRoute } from "./memory.ts";
import { allowedOrigin, refuse, staticPath } from "./http-guard.ts";

const TEST_DIR = fileURLToPath(new URL("../../test-pages/", import.meta.url));
const EXT_DIR = fileURLToPath(new URL("../../extension/", import.meta.url));
const WEB_DIR = fileURLToPath(new URL("../../web/", import.meta.url));
const MIME: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png" };

function cors(req: IncomingMessage, res: ServerResponse) {
  const o = req.headers.origin;
  if (o && allowedOrigin(o)) {
    res.setHeader("access-control-allow-origin", o);
    res.setHeader("vary", "origin");
    res.setHeader("access-control-allow-headers", "content-type, x-prompt");
    res.setHeader("access-control-allow-methods", "GET, POST, DELETE, OPTIONS");
  }
}
function send(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}
async function readBody(req: IncomingMessage, limit = 25_000_000): Promise<Buffer> {
  const chunks: Buffer[] = []; let n = 0;
  for await (const c of req) { n += c.length; if (n > limit) throw new Error("body too large"); chunks.push(c); }
  return Buffer.concat(chunks);
}

// Read the file first, then write headers: writing 200 before a failed read made the 404 throw (headers already
// sent), which escaped the handler as an unhandled rejection and stopped the helper.
async function serveStatic(res: ServerResponse, dir: string, rest: string, only?: string[]) {
  const file = staticPath(dir, rest);
  if (!file || (only && !only.includes(extname(file)))) return send(res, 403, { error: "forbidden" });
  let data: Buffer;
  try { data = await readFile(file); } catch { return send(res, 404, { error: "not found" }); }
  res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream" });
  res.end(data);
}

// Proof/session routes belong to another module set; loaded lazily so this server runs before they exist.
async function optional(file: string): Promise<any | null> {
  try { return await import(file); } catch { return null; }
}

// Speech seam for /tutor: speech.ts is loaded lazily so the route works without it. A new request cuts off the
// previous answer; each `say` sentence is queued unless the caller asked for silence or the speaker is muted.
const speechMod: Promise<any | null> = optional("./speech.ts");
// (tutor-route.ts only calls these when the request did not say speak:false.)
const tutorSpeech = {
  onStart: () => { speechMod.then((m) => m?.speaker.interrupt()).catch(() => {}); },
  onSay: (t: string) => { speechMod.then((m) => { if (m && !m.speaker.isMuted()) m.speaker.enqueue(t); }).catch(() => {}); },
  onEnd: () => { speechMod.then((m) => m?.speaker.flush()).catch(() => {}); },
};

const server = createServer(async (req, res) => {
  const t0 = Date.now();
  cors(req, res);
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const path = url.pathname;
  res.on("finish", () => console.log(`${req.method} ${path} ${res.statusCode} ${Date.now() - t0}ms`)); // no bodies, no headers
  try {
    if (refuse(req.headers.host, req.headers.origin)) return send(res, 403, { error: "forbidden origin" });
    if (req.method === "OPTIONS") { res.writeHead(204); return res.end(); }

    if (req.method === "GET" && path === "/health") {
      const w = whisperStatus();
      // whisper is an object now: { ok, loading, model, hinglish, error? }. minRms is the loudness floor in force.
      return send(res, 200, { ok: true, whisper: w, whisperError: w.error, minRms: minRms(), key: hasKey(), ...(testRouterActive() ? { testRouter: true } : {}) });
    }
    if (req.method === "POST" && path === "/transcribe") {
      const wav = await readBody(req);
      const prompt = typeof req.headers["x-prompt"] === "string" ? req.headers["x-prompt"] : undefined;
      try { return send(res, 200, await transcribeGuarded(wav, prompt, transcribe)); } // shared guard: noise, blank, script, silent
      catch (e: any) { return send(res, 503, { error: `transcription unavailable: ${e.message}` }); }
    }
    if (req.method === "POST" && path === "/decide") {
      const b = JSON.parse((await readBody(req)).toString("utf8"));
      if (typeof b?.question !== "string" || !Array.isArray(b?.outline?.elements) || typeof b?.outline?.text !== "string")
        return send(res, 400, { error: "need { sessionId, question, outline{elements,text} }" });
      return send(res, 200, await decide(String(b.sessionId ?? "default"), b.question, b.outline));
    }
    // Tutor (tutor-route.ts): SSE answer for /tutor, the walkthrough commands, and GET /tutor for feature detection.
    // Behind the same guard (checked above); `speak:false` in the body silences the speaker for this request.
    if (path === "/tutor" || path === "/tutor/walk") {
      return void await handleTutorRoute(req, res, path, { turn: tutorTurn, walk: tutorWalk, ...tutorSpeech });
    }
    // Personal memory (memory.ts): view, pause/resume, forget, and the "accepted" feedback from the extension.
    // Behind the same Host/Origin guard as everything above. DELETE has no body; the others are small JSON.
    if (path === "/memory" || path.startsWith("/memory/")) {
      const body = req.method === "POST" ? (await readBody(req, 100_000)).toString("utf8") : "";
      const r = memoryRoute(memory(), req.method ?? "GET", path, body);
      if (r) return send(res, r.status, r.body);
    }
    // Spoken answers (speech.ts). Same Host/Origin guard as everything here. /speech/say is for tests and the debug panel.
    if (path === "/speech" && req.method === "GET") return send(res, 200, speechStatus());
    if (path === "/speech/stop" && req.method === "POST") { speaker.interrupt(); return send(res, 200, speechStatus()); }
    if (path === "/speech/mute" && req.method === "POST") {
      const b = JSON.parse((await readBody(req, 10_000)).toString("utf8") || "{}");
      if (typeof b?.muted !== "boolean") return send(res, 400, { error: "need { muted: boolean }" });
      speaker.setMuted(b.muted); return send(res, 200, speechStatus());
    }
    if (path === "/speech/say" && req.method === "POST") {
      const b = JSON.parse((await readBody(req, 10_000)).toString("utf8") || "{}");
      if (typeof b?.text !== "string") return send(res, 400, { error: "need { text }" });
      speaker.interrupt(); speaker.speak(b.text); return send(res, 200, speechStatus());
    }
    // Static pages: web/ at /app (proof sheet, replay), test-pages/ at /test, and /ext for the dev panel preview
    // (test-pages/panel-preview.html loads the overlay code from it; scripts and styles only).
    if (req.method === "GET" && path.startsWith("/app/")) return serveStatic(res, WEB_DIR, path.slice(5));
    if (req.method === "GET" && path.startsWith("/test/")) return serveStatic(res, TEST_DIR, path.slice(6));
    // Dev only (ISHARA_DEV=1): a fingerprint of the extension's files. The service worker polls it and reloads itself
    // when it changes, so extension edits take effect without a trip to chrome://extensions. Off by default.
    if (req.method === "GET" && path === "/dev/ext-version") {
      if (process.env.ISHARA_DEV !== "1") return send(res, 200, { dev: false });
      const sig = readdirSync(EXT_DIR).sort().map((f) => { const st = statSync(joinPath(EXT_DIR, f)); return `${f}:${st.size}:${Math.round(st.mtimeMs)}`; }).join("|");
      return send(res, 200, { dev: true, version: sig });
    }
    if (req.method === "GET" && path.startsWith("/ext/")) return serveStatic(res, EXT_DIR, path.slice(5), [".js", ".css"]);

    // Receipts (episode-log.ts): the proof for one answer, the session log, ending a session, and the replay.
    let m: RegExpMatchArray | null;
    if (req.method === "GET" && (m = path.match(/^\/proof\/(.+)$/))) return send(res, 200, await episodeLog.getProof(decodeURIComponent(m[1])));
    if (req.method === "GET" && (m = path.match(/^\/log\/(.+)$/))) return send(res, 200, episodeLog.getLog(decodeURIComponent(m[1])));
    if (req.method === "GET" && path === "/sessions") return send(res, 200, { sessions: episodeLog.list() });
    if (req.method === "GET" && (m = path.match(/^\/replay\/(.+)$/))) return send(res, 200, await episodeLog.replay(decodeURIComponent(m[1])));
    if (req.method === "POST" && path === "/session/end") {
      const b = JSON.parse((await readBody(req)).toString("utf8"));
      return send(res, 200, await episodeLog.endSession(String(b.sessionId)));
    }
    // Desktop path: read the frontmost app's window (accessibility tree + local OCR) into a redacted PageContext, run
    // the same streaming tutor turn as /tutor (explain, point, guide, follow-ups), draw it in a click-through overlay and
    // speak it. Nothing but text leaves the laptop. Body: { question, sessionId?, speak? }. Browsers answer with the hint.
    if (req.method === "POST" && path === "/desktop/ask") {
      const b = JSON.parse((await readBody(req)).toString("utf8"));
      if (typeof b?.question !== "string" || !b.question.trim()) return send(res, 400, { error: "need { question }" });
      try {
        const r = await desktopAsk(b.question.trim(), { sessionId: String(b.sessionId ?? "desktop"), speak: b.speak !== false });
        return send(res, 200, r);
      } catch (e: any) { return send(res, 503, { error: String(e?.message ?? e) }); } // e.g. the Accessibility permission message
    }
    // Push-to-talk daemon state (desktop-ptt.ts): running, the chord, and the last error (e.g. a missing permission).
    if (req.method === "GET" && path === "/desktop/ptt") return send(res, 200, pttStatus());
    return send(res, 404, { error: "no such route" });
  } catch (e: any) {
    if (res.headersSent) return void res.destroy(); // a second writeHead would throw out of this handler and kill the helper
    return send(res, e instanceof SyntaxError ? 400 : 500, { error: String(e?.message ?? e) });
  }
});

server.listen(HELPER_PORT, "127.0.0.1", () => {
  console.log(`helper on http://127.0.0.1:${HELPER_PORT}`);
  startWhisper().then(() => console.log("whisper:", JSON.stringify(whisperStatus())));
  warm();
  startSpeech().then(() => console.log("speech:", JSON.stringify(speechStatus()))); // loads the voice model (~3 s) off the request path
  // Vision loads its OCR model on first use (measured up to 56 s). Opt-in, because warming it reads the screen once.
  if (process.env.ISHARA_DESKTOP === "1") {
    warmDesktop();
    // Global push-to-talk. Same opt-in: starting it is what makes macOS ask for Input Monitoring and Microphone.
    // startPtt() is a no-op when desktop/ishara-ptt is not built.
    if (!startPtt()) console.log("push-to-talk: desktop/ishara-ptt is not built (npm run desktop:build)");
  }
});
// Ctrl-C does not fire "exit", so whisper-server outlived every helper restart (10 orphans found on 5 Nov, each
// holding the model). Stop it on the signals too.
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(sig, () => { stopWhisper(); stopPtt(); stopSpeech(); process.exit(0); });
process.on("exit", stopPtt); // the daemon holds the microphone; never leave it running
