// FAKE 0G ROUTER. A development stand-in so the whole chain (extension -> helper -> router -> gate -> pointer ->
// memory -> episode log) can be exercised while the real sealed models are down.
//
// It tests MECHANICS ONLY. Its "answers" are token overlap, not a model, so they say NOTHING about 0G's accuracy
// and no number produced against it may be quoted. It is a development tool, not a fallback: the helper talks to
// it only when ISHARA_ROUTER_URL is set to a loopback address (helper/src/zg.ts), and every response it causes is
// marked testRouter:true all the way to the screen. The provider address below is deliberately not a real one.
//
//   node test/fake-router/server.ts            (FAKE_ROUTER_PORT, default 7791; FAKE_ROUTER_MODE=ok|down|slow|flaky)
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

export const FAKE_PROVIDER = "0x00000000000000000000000000000000FA4EF00D";
export type Mode = "ok" | "down" | "slow" | "flaky";

// ---- fresh overlap scoring (not shared with helper/src/shortlist.ts on purpose: the stand-in must not depend on
// the product code it is testing) ----
const STOP = new Set(["the", "a", "an", "i", "do", "does", "to", "of", "in", "on", "my", "me", "is", "it", "how", "where", "what",
  "can", "this", "that", "here", "for", "and", "or", "click", "press", "enter", "put", "go", "should", "which", "need", "want",
  "find", "show", "please", "page", "setting", "are", "be", "you", "your", "us", "we", "at", "up", "with", "from"]);
// Everyday action words versus how pages label them. Small on purpose: this is a stand-in, not a model.
const SYN: Record<string, string[]> = {
  submit: ["publish", "verify", "send", "confirm", "save"], send: ["submit"], clear: ["reset", "erase"], erase: ["reset", "clear"],
  paste: ["code", "source"], pick: ["select", "choose"], choose: ["select"], agree: ["terms", "accept"], accept: ["agree", "terms"],
  find: ["search"], search: ["find"], help: ["guide"],
};
export function toks(s: string): string[] {
  return s.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 1 && !STOP.has(t));
}
// Crude stem: first 5 letters of long words, so "verification" ~ "verify" ~ "verified".
const stem = (t: string) => (t.length > 5 ? t.slice(0, 5) : t);

export type El = { id: string; role: string; label: string };
export function parseOutline(text: string): El[] {
  const out: El[] = [];
  for (const line of text.split("\n")) {
    const m = line.match(/^\s*\[([A-Za-z]+\d+)\]\s+(\S+)\s+"(.*)"/);
    if (m) out.push({ id: m[1], role: m[2], label: m[3] });
  }
  return out;
}
// Returns overlap score 0..1 for how much of the question's content words the label covers.
export function overlap(question: string, label: string): number {
  const q = toks(question);
  if (!q.length) return 0;
  const l = toks(label);
  const ls = new Set(l.map(stem));
  let hit = 0;
  for (const t of q) {
    if (l.includes(t) || ls.has(stem(t))) hit += 1;
    else if ((Object.hasOwn(SYN, t) ? SYN[t] : []).some((s) => l.includes(s) || ls.has(stem(s)))) hit += 0.7;
  }
  return Math.min(1, hit / q.length);
}
export function pick(question: string, els: El[]): { el: El | null; score: number } {
  let best: El | null = null, bs = 0;
  for (const el of els) {
    if (el.role === "text") continue; // headings are never what a pointer lands on
    const s = overlap(question, el.label);
    if (s > bs) { bs = s; best = el; }
  }
  return { el: bs > 0 ? best : null, score: bs };
}
// laya-like probability: strong overlap ~0.9, partial 0.4-0.7, none 0.05.
export function layaP(score: number): number {
  if (score <= 0) return 0.05;
  return Math.round((score >= 0.99 ? 0.9 : score >= 0.5 ? 0.35 + score * 0.5 : 0.1 + score * 0.3) * 100) / 100;
}

// ---- server ----
const mode = (): Mode => ((process.env.FAKE_ROUTER_MODE as Mode) || "ok");
let calls = 0;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
function headers(extra: Record<string, string> = {}): Record<string, string> {
  return { "x-request-id": randomUUID(), "zg-res-key": "chatcmpl-fake-" + randomUUID().slice(0, 12), "x-provider": FAKE_PROVIDER, ...extra };
}
async function body(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { return {}; }
}
function json(res: ServerResponse, status: number, obj: unknown, h: Record<string, string> = {}) {
  res.writeHead(status, { "content-type": "application/json", ...h });
  res.end(JSON.stringify(obj));
}

export function createFakeRouter() {
  return createServer(async (req, res) => {
    const t0 = Date.now();
    const path = new URL(req.url ?? "/", "http://x").pathname;
    res.on("finish", () => console.log(`[fake-router] ${req.method} ${path} ${res.statusCode} ${Date.now() - t0}ms mode=${mode()}`)); // no bodies, no auth
    try {
      if (req.method === "GET" && path === "/v1/models")
        return json(res, 200, { object: "list", data: [{ id: "0gm-1.0-35b-a3b", object: "model" }, { id: "laya", object: "model" }], note: "FAKE ROUTER (development only)" });
      if (req.method !== "POST" || (path !== "/v1/chat/completions" && path !== "/v1/decisions")) return json(res, 404, { error: "no such route" });
      const b = await body(req);
      const n = ++calls;
      const m = mode();
      if (m === "slow") await sleep(9000);
      if (m === "down" || (m === "flaky" && n % 3 === 0)) return json(res, 502, { error: { type: "provider_error", message: "FAKE ROUTER: simulated provider outage" } }, headers());

      if (path === "/v1/decisions") {
        const state: string = String(b?.state ?? "");
        const label = state.match(/Proposed control: \S+ "(.*)"/)?.[1] ?? "";
        const q = state.match(/The user asked: "(.*)"/)?.[1] ?? "";
        const p = layaP(overlap(q, label));
        const h = headers();
        return json(res, 200, { answers: { right: { type: "noul", noul: p } }, x_0g_trace: { request_id: h["x-request-id"], tee_verified: false } }, h);
      }

      const user: string = String((b?.messages ?? []).filter((x: any) => x.role === "user").pop()?.content ?? "");
      const question = user.match(/Question:\s*(.*)$/m)?.[1] ?? "";
      const { el } = pick(question, parseOutline(user));
      const text = el ? `That would be the ${el.label.slice(0, 40)} ${el.role}. [POINT:${el.id}]` : "I cannot find that on this page. [POINT:none]";
      if (!b?.stream) {
        const h = headers();
        return json(res, 200, { id: h["zg-res-key"], object: "chat.completion", model: b?.model, choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }], x_0g_trace: { request_id: h["x-request-id"], tee_verified: false } }, h);
      }
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", ...headers() });
      // A few pieces with a short delay, like a real stream; the tag lands in the last piece.
      const words = text.split(" ");
      const pieces = [words.slice(0, 3).join(" "), " " + words.slice(3, -1).join(" "), " " + words[words.length - 1]];
      for (const p of pieces) {
        res.write(`data: ${JSON.stringify({ object: "chat.completion.chunk", choices: [{ index: 0, delta: { content: p } }] })}\n\n`);
        await sleep(60);
      }
      res.write(`data: ${JSON.stringify({ object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`);
      res.write("data: [DONE]\n\n");
      res.end();
    } catch (e: any) {
      console.error("[fake-router] handler error:", e?.message ?? e);
      if (!res.headersSent) json(res, 500, { error: String(e?.message ?? e) }); else res.destroy();
    }
  });
}

// Run only when started directly, so tests can import createFakeRouter.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const port = Number(process.env.FAKE_ROUTER_PORT || 7791);
  createFakeRouter().listen(port, "127.0.0.1", () => {
    console.log(`FAKE 0G ROUTER (development only, not 0G) on http://127.0.0.1:${port}/v1  mode=${mode()}`);
    console.log(`Use it: ISHARA_ROUTER_URL=http://127.0.0.1:${port}/v1 npm run helper:fake`);
  });
}
