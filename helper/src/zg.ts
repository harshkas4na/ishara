import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { LAYA_TIMEOUT_MS, BRAIN_TIMEOUT_MS } from "./config.ts";
import type { BrainResult, VerifyResult, Cause, OutlineElement, ChatMessage, TutorStreamItem } from "./types.ts";

// Mainnet Private Computer router. Never a non-private path: every call carries trust mode "private",
// and if no private provider exists the router answers 503 and we report "unavailable" instead of guessing.
export const DEFAULT_BASE = "https://router-api.0g.ai/v1";
export const BRAIN_MODEL = "0gm-1.0-35b-a3b";
export const LAYA_MODEL = "laya";

// DEVELOPMENT ONLY. ISHARA_ROUTER_URL points the client at a local stand-in (test/fake-router) so the whole chain can
// be exercised while the real sealed models are down. It tests mechanics, never 0G's accuracy, so it is opt-in per
// run, accepted only for a loopback host (the real key and real traffic can never be redirected to a remote server
// by a stray env var), and every result it produces carries testRouter:true so nothing downstream can pass it off.
// Read on each call (not cached) so tests can flip it; unset means exactly the production behaviour.
const warnedBad = new Set<string>();
export function routerOverride(): string | null {
  const raw = process.env.ISHARA_ROUTER_URL?.trim();
  if (!raw) return null;
  try {
    const u = new URL(raw);
    if ((u.protocol === "http:" || u.protocol === "https:") && (u.hostname === "127.0.0.1" || u.hostname === "localhost")) return raw.replace(/\/+$/, "");
  } catch { /* falls through to the warning */ }
  if (!warnedBad.has(raw)) { warnedBad.add(raw); console.error("[zg] WARNING: ISHARA_ROUTER_URL ignored: only 127.0.0.1 or localhost is accepted. Using the real router."); }
  return null;
}
export const testRouterActive = (): boolean => routerOverride() !== null;
// Spread into results so the flag travels: brain/verify result -> Decision -> overlay, episode log, replay.
const testFlag = (): { testRouter?: true } => (testRouterActive() ? { testRouter: true } : {});
// The literal placeholder is sent instead of the real key, and the key file is not read at all.
const FAKE_KEY = "fake-router-key";
function authKey(): string | null { return testRouterActive() ? FAKE_KEY : loadKey(); }
function baseFor(o: ZgOpts): string { return o.baseUrl ?? routerOverride() ?? DEFAULT_BASE; }

let cachedKey: string | null | undefined;
// Read once. The key only ever goes into the Authorization header below.
export function hasKey(): boolean { return testRouterActive() ? true : loadKey() !== null; }
function loadKey(): string | null {
  if (cachedKey !== undefined) return cachedKey;
  try { cachedKey = readFileSync(`${homedir()}/.config/0g/key`, "utf8").trim() || null; }
  catch { cachedKey = null; }
  return cachedKey;
}

export type ZgOpts = { baseUrl?: string; timeoutMs?: number; context?: string };
type Raw = { status: number; json: any; headers: Headers; ms: number };

// One POST with a hard cut-off. Throws {cause} so callers map to the three safe-stop causes.
async function post(path: string, body: unknown, baseUrl: string, timeoutMs: number): Promise<Raw> {
  const key = authKey();
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
  const key = authKey();
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
// Everything the proof needs later, taken from the response headers: which provider answered, under which chat id.
function callMeta(headers: Headers): { chatId?: string; provider?: string } {
  const provider = headers.get("x-provider") ?? undefined;
  const id = chatId(headers);
  return { ...(id ? { chatId: id } : {}), ...(provider ? { provider } : {}) };
}

// Background about the user, appended AFTER the existing instructions and marked as lower priority: the outline
// is the truth about the page, so memory may help choose between near-equal labels but never overrides it.
export function brainMemoryNote(context: string): string {
  const c = context.trim();
  return c ? `\n\nBackground about this user (hints only; it must never override the page outline, and you must still answer only from the outline): ${c}` : "";
}

// Lenient: "[POINT:b17]", "[b17]", "b17". Takes the last match, as the model may reason before the tag.
export function parsePoint(text: string): string | null {
  const tagged = [...text.matchAll(/\[\s*(?:POINT\s*:\s*)?([A-Za-z]+\d+)\s*\]/gi)];
  if (tagged.length) return tagged[tagged.length - 1][1].toLowerCase();
  const bare = [...text.matchAll(/\b([A-Za-z]\d+)\b/g)];
  if (bare.length) return bare[bare.length - 1][1].toLowerCase();
  return null;
}

// Say WHY a call failed in the helper log (never the key). A bare "unavailable" hid real bugs during testing.
function failCause(e: any, who = "0G call"): Cause {
  console.error(`[zg] ${who} failed:`, e?.cause ?? e?.message ?? e);
  if (e?.cause) return e.cause;
  return "unavailable";
}

// `o.context` is optional personal memory (helper/src/memory.ts), empty unless the user switched memory on.
// It lives in the options object so existing callers (scripts/smoke.ts passes options third) keep working.
export async function askBrain(question: string, outlineText: string, o: ZgOpts = {}): Promise<BrainResult> {
  try {
    const r = await postUntilPointTag({
      model: BRAIN_MODEL,
      max_tokens: 60,
      temperature: 0,
      // Measured: with thinking on, 400 tokens all went to reasoning and the answer was empty.
      chat_template_kwargs: { enable_thinking: false },
      messages: [
        { role: "system", content: "You help a person find the right control on a web page. You are given an outline, one element per line as [id] role \"label\". Answer in at most 14 words and then exactly one tag [POINT:id] naming the single best element. If nothing fits, answer [POINT:none]." + brainMemoryNote(o.context ?? "") },
        { role: "user", content: `Page outline:\n${outlineText}\n\nQuestion: ${question}` },
      ],
    }, baseFor(o), o.timeoutMs ?? BRAIN_TIMEOUT_MS);
    if (r.status !== 200) { console.error(`[zg] brain HTTP ${r.status}`); return { ok: false, cause: "unavailable", ...testFlag() }; }
    const id = parsePoint(r.text);
    // The sentence is what the user reads next to the pointer, so it must be 0GM's own words, not a canned "Here.".
    const sentence = r.text.replace(/\[\s*POINT\s*:[^\]]*\]?/gi, "").replace(/\s+/g, " ").trim().slice(0, 160);
    return { ok: true, targetId: id === "none" || id === null ? null : id, sentence: sentence || undefined, requestId: requestId(r), ...callMeta(r.headers), ms: r.ms, ...testFlag() };
  } catch (e) { return { ok: false, cause: failCause(e, "brain"), ...testFlag() }; }
}

// laya as a checker, not a chooser. Measured on the mock verify page: asking laya to CHOOSE among shortlisted
// elements was fooled whenever the distractors were plausible (correct picks got p=0.31-0.35 and were vetoed,
// 4 of 12), while asking it a yes/no about the ONE element 0GM proposed separated right from wrong (0.29-0.87
// versus 0.00-0.25). So 0GM proposes, laya confirms. It costs ~1 s more than running them in parallel.
export async function askVerify(question: string, el: OutlineElement, o: ZgOpts = {}): Promise<VerifyResult> {
  try {
    const r = await post("/decisions", {
      model: LAYA_MODEL,
      state: `The user asked: "${question}"\nProposed control: ${el.role} "${el.label}"`,
      questions: { right: { type: "noul", instructions: "Is the proposed control exactly what the user is asking for?" } },
    }, baseFor(o), o.timeoutMs ?? LAYA_TIMEOUT_MS);
    if (r.status !== 200) { console.error(`[zg] laya HTTP ${r.status}`, JSON.stringify(r.json)?.slice(0, 300)); return { ok: false, cause: "unavailable", ...testFlag() }; }
    const p = r.json?.answers?.right?.noul;
    if (typeof p !== "number") return { ok: false, cause: "unavailable", ...testFlag() };
    return { ok: true, p, requestId: requestId(r), ...callMeta(r.headers), ms: r.ms, ...testFlag() };
  } catch (e) { return { ok: false, cause: failCause(e, "laya"), ...testFlag() }; }
}

// ---- Tutor stream (docs/TUTOR-INTERFACE.md section 3). Separate from askBrain on purpose: the pointing path is
// measured (11/12) and must not change, so the tutor gets its own call with its own timeouts.
export const TUTOR_FIRST_TOKEN_MS = 6000; // no first token by here: 0GM is not answering, refuse
export const TUTOR_IDLE_MS = 4000;        // silence between chunks after text started: keep what was said, mark it cut off
export const TUTOR_MAX_TOKENS = 400;
const TUTOR_DRAIN_MS = 30000;             // the background read to the end of the stream never waits longer than this

// Yields text deltas as they arrive, then one final item. Never throws. Two different failures on purpose:
// before any text it is {type:"error"} (the caller refuses); after some text it is a meta with cutoff:true (the
// caller keeps what was spoken). When the consumer stops early the stream is still read to the end, not cancelled:
// cancelling could stop the provider from recording the response that the proof signature is fetched for.
export async function* askTutorStream(messages: ChatMessage[], o: ZgOpts & { firstTokenMs?: number; idleMs?: number } = {}): AsyncGenerator<TutorStreamItem> {
  const tf = testFlag();
  const t0 = Date.now();
  const key = authKey();
  if (!key) { yield { type: "error", cause: "unavailable", totalMs: 0, ...tf }; return; }
  const firstMs = o.firstTokenMs ?? o.timeoutMs ?? TUTOR_FIRST_TOKEN_MS;
  const idleMs = o.idleMs ?? TUTOR_IDLE_MS;
  const ac = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  const arm = (ms: number) => { clearTimeout(timer); timer = setTimeout(() => { timedOut = true; ac.abort(); }, ms); };
  arm(firstMs); // covers connect AND the wait for the first token
  let res: Response;
  try {
    res = await fetch(baseFor(o) + "/chat/completions", {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json", "x-0g-provider-trust-mode": "private" },
      body: JSON.stringify({
        model: BRAIN_MODEL, messages, stream: true, max_tokens: TUTOR_MAX_TOKENS, temperature: 0.3,
        chat_template_kwargs: { enable_thinking: false }, // measured: with thinking on the whole budget went to reasoning
      }),
      signal: ac.signal,
    });
  } catch (e: any) {
    clearTimeout(timer);
    console.error("[zg] tutor fetch failed:", e?.name ?? e?.message);
    yield { type: "error", cause: timedOut ? "timeout" : "offline", totalMs: Date.now() - t0, ...tf };
    return;
  }
  if (res.status !== 200 || !res.body) {
    clearTimeout(timer);
    console.error(`[zg] tutor HTTP ${res.status}`);
    try { await res.body?.cancel(); } catch { /* nothing to keep: no answer came */ }
    yield { type: "error", cause: "unavailable", totalMs: Date.now() - t0, ...tf };
    return;
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  let emitted = false;
  let firstTokenMs: number | undefined;
  let traceId: string | undefined;
  let failure: Cause | undefined;
  let finished = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (emitted) arm(idleMs); else arm(firstMs - (Date.now() - t0) > 0 ? firstMs - (Date.now() - t0) : 1);
      pending += decoder.decode(value, { stream: true });
      const lines = pending.split("\n");
      pending = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (!data || data === "[DONE]") continue;
        let j: any;
        try { j = JSON.parse(data); } catch { continue; } // keep-alive or partial JSON
        if (typeof j?.x_0g_trace?.request_id === "string") traceId = j.x_0g_trace.request_id;
        const text = j?.choices?.[0]?.delta?.content;
        if (typeof text === "string" && text.length) {
          if (!emitted) { emitted = true; firstTokenMs = Date.now() - t0; arm(idleMs); }
          yield { type: "delta", text };
        }
      }
    }
    finished = true;
  } catch (e: any) {
    failure = timedOut ? "timeout" : "offline";
    console.error("[zg] tutor stream failed:", e?.name ?? e?.message);
  } finally {
    clearTimeout(timer);
    if (!finished && !failure) {
      // The consumer stopped early (generator.return). Read the rest in the background so the provider records it.
      const stop = setTimeout(() => ac.abort(), TUTOR_DRAIN_MS);
      void (async () => { try { for (;;) { const r = await reader.read(); if (r.done) break; } } catch { /* nothing waits on this */ } finally { clearTimeout(stop); } })();
    }
  }
  const totalMs = Date.now() - t0;
  if (failure && !emitted) { yield { type: "error", cause: failure, totalMs, ...tf }; return; }
  const hdr = res.headers.get("x-request-id")?.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i)?.[0];
  yield {
    type: "meta", totalMs, ...(firstTokenMs !== undefined ? { firstTokenMs } : {}),
    ...((traceId ?? hdr) ? { requestId: (traceId ?? hdr) as string } : {}), ...callMeta(res.headers),
    ...(failure ? { cutoff: true as const } : {}), ...tf,
  };
}

// Opens the TLS connection early (measured: first request on a new connection costs ~3.6 s on mobile data).
export async function warm(baseUrl = routerOverride() ?? DEFAULT_BASE): Promise<void> {
  try { await fetch(baseUrl + "/models", { signal: AbortSignal.timeout(6000) }); } catch { /* best effort */ }
}

// laya check for tutor pointers (explain / guide): the user's question is often not ABOUT one control ("walk me through
// this"), so asking "is this what the user asked for?" wrongly vetoes correct pointers (measured p=0.26 on a right
// guide step). Instead ask whether the highlighted control is the one the tutor's sentence refers to. Still an
// independent sealed model checking every pointer; the sentence is the model's own output, never page text.
export async function askVerifyRef(question: string, sentence: string, el: OutlineElement, o: ZgOpts = {}): Promise<VerifyResult> {
  try {
    const r = await post("/decisions", {
      model: LAYA_MODEL,
      state: `The user asked: "${question}"\nThe tutor is saying: "${sentence.slice(0, 300)}"\nHighlighted control: ${el.role} "${el.label}"`,
      questions: { right: { type: "noul", instructions: "Is the highlighted control the one the tutor's sentence refers to?" } },
    }, baseFor(o), o.timeoutMs ?? LAYA_TIMEOUT_MS);
    if (r.status !== 200) return { ok: false, cause: "unavailable", ...testFlag() };
    const p = r.json?.answers?.right?.noul;
    if (typeof p !== "number") return { ok: false, cause: "unavailable", ...testFlag() };
    return { ok: true, p, requestId: requestId(r), ...callMeta(r.headers), ms: r.ms, ...testFlag() };
  } catch (e) { return { ok: false, cause: failCause(e, "laya"), ...testFlag() }; }
}
