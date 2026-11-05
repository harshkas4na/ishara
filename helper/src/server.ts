import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { extname, join, normalize } from "node:path";
import { HELPER_PORT } from "./config.ts";
import { decide, recordsFor } from "./decide.ts";
import { hasKey, warm } from "./zg.ts";
import { startWhisper, transcribe, whisperStatus } from "./whisper.ts";

const TEST_DIR = fileURLToPath(new URL("../../test-pages/", import.meta.url));
const MIME: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png" };

function cors(req: IncomingMessage, res: ServerResponse) {
  const o = req.headers.origin;
  // Only the extension and our own pages may call the helper; it holds the 0G key.
  if (o && (o.startsWith("chrome-extension://") || o.startsWith("http://127.0.0.1:7777"))) {
    res.setHeader("access-control-allow-origin", o);
    res.setHeader("vary", "origin");
    res.setHeader("access-control-allow-headers", "content-type, x-prompt");
    res.setHeader("access-control-allow-methods", "GET, POST, OPTIONS");
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

// Proof/session routes belong to another module set; loaded lazily so this server runs before they exist.
async function optional(file: string): Promise<any | null> {
  try { return await import(file); } catch { return null; }
}

const server = createServer(async (req, res) => {
  const t0 = Date.now();
  cors(req, res);
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const path = url.pathname;
  res.on("finish", () => console.log(`${req.method} ${path} ${res.statusCode} ${Date.now() - t0}ms`)); // no bodies, no headers
  try {
    if (req.method === "OPTIONS") { res.writeHead(204); return res.end(); }

    if (req.method === "GET" && path === "/health") {
      const w = whisperStatus();
      return send(res, 200, { ok: true, whisper: w.ok, whisperError: w.error, key: hasKey() });
    }
    if (req.method === "POST" && path === "/transcribe") {
      const wav = await readBody(req);
      const prompt = typeof req.headers["x-prompt"] === "string" ? req.headers["x-prompt"] : undefined;
      try { return send(res, 200, await transcribe(wav, prompt)); }
      catch (e: any) { return send(res, 503, { error: `transcription unavailable: ${e.message}` }); }
    }
    if (req.method === "POST" && path === "/decide") {
      const b = JSON.parse((await readBody(req)).toString("utf8"));
      if (typeof b?.question !== "string" || !Array.isArray(b?.outline?.elements) || typeof b?.outline?.text !== "string")
        return send(res, 400, { error: "need { sessionId, question, outline{elements,text} }" });
      return send(res, 200, await decide(String(b.sessionId ?? "default"), b.question, b.outline));
    }
    if (req.method === "GET" && path.startsWith("/test/")) {
      const rel = normalize(decodeURIComponent(path.slice(6))).replace(/^(\.\.[/\\])+/, "");
      const file = join(TEST_DIR, rel || "index.html");
      if (!file.startsWith(TEST_DIR)) return send(res, 403, { error: "forbidden" });
      try {
        const data = await readFile(file);
        res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream" });
        return res.end(data);
      } catch { return send(res, 404, { error: "not found" }); }
    }

    // proof.ts / storage.ts are owned elsewhere. Contract assumed: default or named handler exports; 501 until they exist.
    const m = path.match(/^\/(proof|session\/end|log)(?:\/(.+))?$/);
    if (m) {
      const proof = await optional("./proof.ts");
      const store = await optional("./storage.ts");
      const mod = m[1] === "proof" ? proof : store;
      const fn = mod && (m[1] === "proof" ? mod.getProof : m[1] === "log" ? mod.getLog : mod.endSession);
      if (typeof fn !== "function") return send(res, 501, { error: "not built yet" });
      if (m[1] === "proof" && req.method === "GET") return send(res, 200, await fn(decodeURIComponent(m[2] ?? "")));
      if (m[1] === "log" && req.method === "GET") return send(res, 200, await fn(decodeURIComponent(m[2] ?? ""), recordsFor(m[2] ?? "")));
      if (m[1] === "session/end" && req.method === "POST") {
        const b = JSON.parse((await readBody(req)).toString("utf8"));
        return send(res, 200, await fn(String(b.sessionId), recordsFor(String(b.sessionId))));
      }
    }
    return send(res, 404, { error: "no such route" });
  } catch (e: any) {
    return send(res, 500, { error: String(e?.message ?? e) });
  }
});

server.listen(HELPER_PORT, "127.0.0.1", () => {
  console.log(`helper on http://127.0.0.1:${HELPER_PORT}`);
  startWhisper().then(() => console.log("whisper:", JSON.stringify(whisperStatus())));
  warm();
});
