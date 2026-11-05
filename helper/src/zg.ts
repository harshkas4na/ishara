import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { LAYA_TIMEOUT_MS, BRAIN_TIMEOUT_MS } from "./config.ts";
import type { BrainResult, LayaResult, Cause, OutlineElement } from "./types.ts";

// Mainnet Private Computer router. Never a non-private path: every call carries trust mode "private",
// and if no private provider exists the router answers 503 and we report "unavailable" instead of guessing.
export const DEFAULT_BASE = "https://router-api.0g.ai/v1";
export const BRAIN_MODEL = "0gm-1.0-35b-a3b";
export const LAYA_MODEL = "laya";

let cachedKey: string | null | undefined;
// Read once. The key only ever goes into the Authorization header below.
export function hasKey(): boolean { return loadKey() !== null; }
function loadKey(): string | null {
  if (cachedKey !== undefined) return cachedKey;
  try { cachedKey = readFileSync(`${homedir()}/.config/0g/key`, "utf8").trim() || null; }
  catch { cachedKey = null; }
  return cachedKey;
}

export type ZgOpts = { baseUrl?: string; timeoutMs?: number };
type Raw = { status: number; json: any; headers: Headers; ms: number };

// One POST with a hard cut-off. Throws {cause} so callers map to the three safe-stop causes.
async function post(path: string, body: unknown, baseUrl: string, timeoutMs: number): Promise<Raw> {
  const key = loadKey();
  if (!key) throw { cause: "unavailable" as Cause };
  const t0 = Date.now();
  let res: Response;
  try {
    res = await fetch(baseUrl + path, {
      method: "POST",
      headers: {
        authorization: `Bearer ${key}`,
        "content-type": "application/json",
        "x-0g-provider-trust-mode": "private",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e: any) {
    // AbortSignal.timeout raises TimeoutError; anything else here is DNS/connect/TLS failure.
    throw { cause: (e?.name === "TimeoutError" || e?.name === "AbortError" ? "timeout" : "offline") as Cause };
  }
  let json: any = null;
  try { json = await res.json(); } catch (e: any) {
    if (e?.name === "TimeoutError") throw { cause: "timeout" as Cause };
  }
  return { status: res.status, json, headers: res.headers, ms: Date.now() - t0 };
}

// The pointing tag is the first thing the brain says after one short sentence, so we read the reply as it
// streams and answer the moment the tag is complete. Waiting for the whole reply cost ~2 s in the lab
// (tag at 1.7-1.9 s, done at 2.1-2.4 s) and more when the router was slow to close the stream.
// The rest of the stream is still drained in the background rather than cancelled: cancelling mid-reply
// could stop the provider from recording the response that the proof signature is fetched for.
const POINT_TAG = /\[\s*POINT\s*:\s*([A-Za-z]+\d*)\s*\]/i;

async function postUntilPointTag(body: unknown, baseUrl: string, timeoutMs: number): Promise<Raw & { text: string }> {
  const key = loadKey();
  if (!key) throw { cause: "unavailable" as Cause };
  const t0 = Date.now();
  const signal = AbortSignal.timeout(timeoutMs); // covers connect AND reading the stream
  let res: Response;
  try {
    res = await fetch(baseUrl + "/chat/completions", {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json", "x-0g-provider-trust-mode": "private" },
      body: JSON.stringify({ ...(body as object), stream: true }),
      signal,
    });
  } catch (e: any) {
    throw { cause: (e?.name === "TimeoutError" || e?.name === "AbortError" ? "timeout" : "offline") as Cause };
  }
  if (res.status !== 200 || !res.body) return { status: res.status, json: null, headers: res.headers, ms: Date.now() - t0, text: "" };

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let pending = ""; // a partial SSE line carried over to the next chunk
  let text = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      pending += decoder.decode(value, { stream: true });
      const lines = pending.split("\n");
      pending = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (data === "[DONE]") continue;
        try { text += JSON.parse(data)?.choices?.[0]?.delta?.content ?? ""; } catch { /* keep-alive or partial JSON */ }
      }
      if (POINT_TAG.test(text)) {
        const ms = Date.now() - t0;
        void (async () => { try { for (;;) { const r = await reader.read(); if (r.done) break; } } catch { /* nothing waits on this */ } })();
        return { status: 200, json: null, headers: res.headers, ms, text };
      }
    }
  } catch (e: any) {
    throw { cause: (e?.name === "TimeoutError" || e?.name === "AbortError" ? "timeout" : "offline") as Cause };
  }
  return { status: 200, json: null, headers: res.headers, ms: Date.now() - t0, text }; // stream ended without a tag: parsePoint is lenient
}

// X-Request-ID can come back as "<short>, <uuid>" (measured); the uuid equals x_0g_trace.request_id.
function requestId(r: Raw): string | undefined {
  const t = r.json?.x_0g_trace?.request_id;
  if (typeof t === "string") return t;
  const h = r.headers.get("x-request-id");
  const m = h?.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  return m ? m[0] : undefined;
}
export function chatId(headers: Headers): string | undefined {
  return headers.get("zg-res-key") ?? undefined; // the id the provider signature is fetched by
}

// Lenient: "[POINT:b17]", "[b17]", "b17". Takes the last match, as the model may reason before the tag.
export function parsePoint(text: string): string | null {
  const tagged = [...text.matchAll(/\[\s*(?:POINT\s*:\s*)?([A-Za-z]+\d+)\s*\]/gi)];
  if (tagged.length) return tagged[tagged.length - 1][1].toLowerCase();
  const bare = [...text.matchAll(/\b([A-Za-z]\d+)\b/g)];
  if (bare.length) return bare[bare.length - 1][1].toLowerCase();
  return null;
}

function failCause(e: any, status?: number): Cause {
  if (e?.cause) return e.cause;
  return "unavailable";
}

export async function askBrain(question: string, outlineText: string, o: ZgOpts = {}): Promise<BrainResult> {
  try {
    const r = await postUntilPointTag({
      model: BRAIN_MODEL,
      max_tokens: 60,
      temperature: 0,
      // Measured: with thinking on, 400 tokens all went to reasoning and the answer was empty.
      chat_template_kwargs: { enable_thinking: false },
      messages: [
        { role: "system", content: "You help a person find the right control on a web page. You are given an outline, one element per line as [id] role \"label\". Answer with one short sentence and then exactly one tag [POINT:id] naming the single best element. If nothing fits, answer [POINT:none]." },
        { role: "user", content: `Page outline:\n${outlineText}\n\nQuestion: ${question}` },
      ],
    }, o.baseUrl ?? DEFAULT_BASE, o.timeoutMs ?? BRAIN_TIMEOUT_MS);
    if (r.status !== 200) return { ok: false, cause: "unavailable" };
    const id = parsePoint(r.text);
    return { ok: true, targetId: id === "none" || id === null ? null : id, requestId: requestId(r), ms: r.ms };
  } catch (e) { return { ok: false, cause: failCause(e) }; }
}

export async function askLaya(question: string, shortlistIds: string[], elements: OutlineElement[], o: ZgOpts = {}): Promise<LayaResult> {
  const byId = new Map(elements.map((e) => [e.id, e]));
  const criteria: Record<string, string> = {};
  const lines: string[] = [];
  for (const id of shortlistIds) {
    const el = byId.get(id);
    if (!el) continue;
    criteria[id] = `${el.role} "${el.label}"`;
    lines.push(`[${id}] ${el.role} "${el.label}"`);
  }
  // Explicit none option: measured to separate clear from vague requests (9/10 each) at p >= 0.45.
  criteria["none"] = "No listed element does what the user asked";
  try {
    const r = await post("/decisions", {
      model: LAYA_MODEL,
      state: `User asked: ${question}\nCandidate elements:\n${lines.join("\n")}`,
      questions: { target: { type: "choice", instructions: "Which element should the user use for what they asked?", criteria } },
    }, o.baseUrl ?? DEFAULT_BASE, o.timeoutMs ?? LAYA_TIMEOUT_MS);
    if (r.status !== 200) return { ok: false, cause: "unavailable" };
    const a = r.json?.answers?.target;
    const choice = a?.choice;
    if (typeof choice !== "string") return { ok: false, cause: "unavailable" };
    const p = a?.probabilities?.[choice];
    return { ok: true, choice, p: typeof p === "number" ? p : (typeof a?.confidence === "number" ? a.confidence : 0), requestId: requestId(r), ms: r.ms };
  } catch (e) { return { ok: false, cause: failCause(e) }; }
}

// Opens the TLS connection early (measured: first request on a new connection costs ~3.6 s on mobile data).
export async function warm(baseUrl = DEFAULT_BASE): Promise<void> {
  try { await fetch(baseUrl + "/models", { signal: AbortSignal.timeout(6000) }); } catch { /* best effort */ }
}
