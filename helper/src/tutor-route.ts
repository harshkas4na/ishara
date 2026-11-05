// POST /tutor, POST /tutor/walk, GET /tutor (docs/TUTOR-INTERFACE.md section 2). Kept out of server.ts so tests can
// mount it on their own http server with a fake turn generator; server.ts only forwards to handleTutorRoute().
import type { IncomingMessage, ServerResponse } from "node:http";
import { refuse } from "./http-guard.ts";

export const MAX_BODY_BYTES = 300_000;   // a ~3,000-token page context is ~20 KB; this is generous, not a data path
export const MAX_QUESTION = 2000;
export const MAX_BLOCKS = 600;
export const MAX_CONTROLS = 400;
export const HEARTBEAT_MS = 10_000;
const MODES = new Set(["auto", "point", "explain", "guide"]);
const WALK_CMDS = new Set(["next", "back", "repeat", "stop", "where"]);

export type RouteDeps = {
  turn: (req: any) => AsyncGenerator<any>;
  walk: (req: any) => AsyncGenerator<any>;
  heartbeatMs?: number;
  // Speech seam: no-ops unless server.ts wires speech.ts in. Must never throw into the stream (wrapped below).
  onStart?: () => void;
  onSay?: (text: string) => void;
  onEnd?: () => void;
};

const json = (res: ServerResponse, status: number, body: unknown) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
const safe = (f?: (...a: any[]) => void, ...a: any[]) => { try { f?.(...a); } catch { /* speech must never break an answer */ } };

class TooBig extends Error {}
async function readJson(req: IncomingMessage, limit: number): Promise<any> {
  const chunks: Buffer[] = []; let n = 0;
  for await (const c of req) { n += c.length; if (n > limit) throw new TooBig(); chunks.push(c); }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

/** Returns an error string, or null when the body is a usable /tutor request. */
export function validateTutorBody(b: any): string | null {
  if (!b || typeof b !== "object") return "need a JSON object";
  if (b.sessionId !== undefined && typeof b.sessionId !== "string") return "sessionId must be a string";
  if (typeof b.question !== "string" || !b.question.trim()) return "need a non-empty question";
  if (b.question.length > MAX_QUESTION) return `question over ${MAX_QUESTION} chars`;
  if (b.mode !== undefined && !MODES.has(b.mode)) return "mode must be auto, point, explain or guide";
  const c = b.context;
  if (!c || typeof c !== "object" || !Array.isArray(c.blocks) || !Array.isArray(c.controls)) return "context needs blocks[] and controls[]";
  if (typeof c.url !== "string") return "context needs a url";
  if (c.blocks.length > MAX_BLOCKS || c.controls.length > MAX_CONTROLS) return "context too large (blocks/controls count)";
  return null;
}

/** Handles the /tutor paths; returns false when the path is not ours. Applies the Host/Origin guard itself. */
export async function handleTutorRoute(req: IncomingMessage, res: ServerResponse, path: string, d: RouteDeps): Promise<boolean> {
  if (path !== "/tutor" && path !== "/tutor/walk") return false;
  if (refuse(req.headers.host, req.headers.origin)) { json(res, 403, { error: "forbidden origin" }); return true; }
  if (req.method === "GET" && path === "/tutor") { json(res, 200, { ok: true, version: 1 }); return true; } // feature detect; clients fall back to /decide on 404
  if (req.method !== "POST") { json(res, 405, { error: "POST only" }); return true; }

  let b: any;
  try { b = await readJson(req, MAX_BODY_BYTES); }
  catch (e) { json(res, e instanceof TooBig ? 413 : 400, { error: e instanceof TooBig ? "body too large" : "invalid JSON" }); return true; }
  const walk = path === "/tutor/walk";
  if (walk) {
    if (typeof b?.cmd !== "string" || !WALK_CMDS.has(b.cmd)) { json(res, 400, { error: "cmd must be next, back, repeat, stop or where" }); return true; }
  } else {
    const bad = validateTutorBody(b);
    if (bad) { json(res, 400, { error: bad }); return true; }
  }
  const req2 = { ...b, sessionId: String(b.sessionId ?? "default") };

  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive", "x-accel-buffering": "no" });
  res.socket?.setNoDelay(true); // each event is tiny and latency is the product: no Nagle batching
  res.flushHeaders();
  let open = true;
  res.on("close", () => { open = false; clearInterval(ping); });
  const write = (chunk: string) => { if (open) res.write(chunk); };
  // A comment line every 10 s keeps proxies and the extension port from timing out while 0GM thinks.
  const ping = setInterval(() => write(": ping\n\n"), d.heartbeatMs ?? HEARTBEAT_MS);

  const speak = b.speak !== false && !walk; // the walk repeats text the user already heard; speech is per-question
  if (speak) safe(d.onStart);
  try {
    // On disconnect we keep draining the generator without writing: the 0G stream must be read to the end so the
    // request/chat ids exist for the proof (contract section 3), and the turn gets logged once.
    for await (const ev of (walk ? d.walk : d.turn)(req2)) {
      const name = String(ev.event ?? ev.type);
      const data = ev.data ?? (({ event: _e, type: _t, ...rest }) => rest)(ev);
      if (open) write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
      if (speak && name === "say" && typeof data.text === "string" && open) safe(d.onSay, data.text);
    }
  } catch (e: any) {
    console.error("[tutor] turn failed:", e?.message);
    // The stream already started, so the only honest signal is a refused event: never a made-up answer.
    write(`event: refused\ndata: ${JSON.stringify({ cause: "unavailable", say: "I couldn't reach the sealed model, so I won't guess." })}\n\n`);
  } finally {
    clearInterval(ping);
    if (speak) safe(d.onEnd);
    if (open) res.end();
  }
  return true;
}
