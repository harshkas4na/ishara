// The extension's SSE parser (extension/sse.js) and the relay's frame handling. The parser is the risky part of
// streaming through the service worker, so every awkward wire shape is here.
import { test } from "node:test";
import assert from "node:assert/strict";

await import("../../extension/sse.js");
const { createParser } = (globalThis as any).IsharaSSE;

function run(chunks: (string | Uint8Array)[]) {
  const out: { event: string; data: string }[] = [];
  const p = createParser((e: any) => out.push(e));
  for (const c of chunks) p.push(c);
  p.end();
  return out;
}
const enc = (s: string) => new TextEncoder().encode(s);

test("one frame", () => {
  assert.deepEqual(run(["event: say\ndata: {\"seq\":1}\n\n"]), [{ event: "say", data: '{"seq":1}' }]);
});

test("a frame split across many chunks, even byte by byte", () => {
  const wire = enc("event: say\ndata: {\"seq\":1,\"text\":\"hello\"}\n\nevent: done\ndata: {}\n\n");
  const chunks = Array.from(wire, (b) => new Uint8Array([b]));
  assert.deepEqual(run(chunks).map((e) => e.event), ["say", "done"]);
  assert.equal(JSON.parse(run(chunks)[0].data).text, "hello");
});

test("CRLF, bare CR, and CRLF split between chunks", () => {
  const want = [{ event: "say", data: "a" }];
  assert.deepEqual(run(["event: say\r\ndata: a\r\n\r\n"]), want);
  assert.deepEqual(run(["event: say\rdata: a\r\r"]), want);
  assert.deepEqual(run(["event: say\r", "\ndata: a\r", "\n\r", "\n"]), want);
});

test("comments are ignored, including keep-alives between frames", () => {
  const got = run([": keep-alive\n\nevent: say\n: mid-frame comment\ndata: x\n\n: ping\n\n"]);
  assert.deepEqual(got, [{ event: "say", data: "x" }]);
});

test("empty data is a frame with an empty string; no data line is no frame", () => {
  assert.deepEqual(run(["event: done\ndata:\n\n"]), [{ event: "done", data: "" }]);
  assert.deepEqual(run(["event: done\n\n"]), []);
});

test("multiple data lines join with a newline; one leading space is stripped, not two", () => {
  assert.deepEqual(run(["data: a\ndata:  b\n\n"]), [{ event: "message", data: "a\n b" }]);
});

test("unknown events and fields pass through for the caller to filter", () => {
  const got = run(["event: weird\nid: 7\nretry: 100\ndata: 1\n\n"]);
  assert.deepEqual(got, [{ event: "weird", data: "1" }]);
});

test("a multi-byte character split across chunks survives", () => {
  const bytes = enc("event: say\ndata: नमस्ते 🙂 ok\n\n");
  for (let cut = 1; cut < bytes.length; cut++) {
    const got = run([bytes.slice(0, cut), bytes.slice(cut)]);
    assert.equal(got.length, 1, "cut at " + cut);
    assert.equal(got[0].data, "नमस्ते 🙂 ok", "cut at " + cut);
  }
});

test("an unfinished frame at the end of the stream is dropped", () => {
  assert.deepEqual(run(["event: say\ndata: ok\n\nevent: say\ndata: half"]), [{ event: "say", data: "ok" }]);
});

test("a BOM at the start is ignored", () => {
  assert.deepEqual(run(["﻿event: say\ndata: 1\n\n"]), [{ event: "say", data: "1" }]);
});

test("the event name resets between frames", () => {
  const got = run(["event: say\ndata: 1\n\ndata: 2\n\n"]);
  assert.deepEqual(got.map((e) => e.event), ["say", "message"]);
});

test("a colon in the data is kept", () => {
  assert.deepEqual(run(['data: {"a":"b:c"}\n\n']), [{ event: "message", data: '{"a":"b:c"}' }]);
});

// ---- relay: the fetch -> parser -> port pipeline, with a fake fetch ----
const { relay } = (globalThis as any).IsharaSSE;
function streamOf(chunks: string[], failAfter = false) {
  let i = 0;
  const body = { getReader: () => ({
    read: async () => { if (i < chunks.length) return { done: false, value: enc(chunks[i++]) }; if (failAfter) throw new Error("reset"); return { done: true }; },
    cancel: async () => { i = chunks.length; },
  }) };
  return { ok: true, status: 200, body };
}
async function relayWith(fetchFn: any, signal?: AbortSignal) {
  const got: any[] = [];
  await relay({ fetchFn, url: "x", init: {}, signal, post: (m: any) => got.push(m) });
  return got;
}
const frame = (e: string, d: unknown) => `event: ${e}\ndata: ${JSON.stringify(d)}\n\n`;

test("relay: events arrive parsed and in order, unknown events are skipped", async () => {
  const got = await relayWith(async () => streamOf([frame("thinking", { mode: "explain" }), frame("zzz", {}), frame("say", { seq: 1, text: "Hi." }), frame("done", { outcome: "answered" })]));
  assert.deepEqual(got.map((m) => m.event), ["thinking", "say", "done"]);
  assert.equal(got[1].data.text, "Hi.");
});

test("relay: network failure becomes refused/offline", async () => {
  const got = await relayWith(async () => { throw new TypeError("fetch failed"); });
  assert.deepEqual(got, [{ event: "refused", data: { cause: "offline", say: "" } }]);
});

test("relay: 404 means no /tutor route (fall back to /decide)", async () => {
  const got = await relayWith(async () => ({ ok: false, status: 404, body: null }));
  assert.deepEqual(got.map((m) => m.event), ["noroute"]);
});

test("relay: 500 is refused/unavailable, not a guess", async () => {
  const got = await relayWith(async () => ({ ok: false, status: 500, body: null }));
  assert.equal(got[0].event, "refused");
  assert.equal(got[0].data.cause, "unavailable");
});

test("relay: a stream that dies mid-answer ends as cutoff, one that dies before any event as offline", async () => {
  const mid = await relayWith(async () => streamOf([frame("say", { seq: 1, text: "Hi." })], true));
  assert.deepEqual(mid.map((m) => m.event), ["say", "done"]);
  assert.equal(mid[1].data.outcome, "cutoff");
  const none = await relayWith(async () => streamOf([], true));
  assert.equal(none[0].data.cause, "offline");
});

test("relay: a bad JSON frame is skipped, the stream goes on", async () => {
  const got = await relayWith(async () => streamOf(["event: say\ndata: {nope\n\n", frame("done", { outcome: "answered" })]));
  assert.deepEqual(got.map((m) => m.event), ["done"]);
});

test("relay: aborting posts nothing more", async () => {
  const ctl = new AbortController();
  const got: any[] = [];
  await relay({ fetchFn: async () => streamOf([frame("say", { seq: 1, text: "A." }), frame("say", { seq: 2, text: "B." })]), url: "x", init: {}, signal: ctl.signal,
    post: (m: any) => { got.push(m); ctl.abort(); } });
  assert.equal(got.length, 1);
});

test("relay: `speaking` is relayed, also after done, and does not end the stream", async () => {
  const got = await relayWith(async () => streamOf([frame("say", { seq: 1, text: "Hi." }), frame("speaking", { seq: 1, text: "Hi." }), frame("done", { outcome: "answered" }), frame("speaking", { seq: null })]));
  assert.deepEqual(got.map((m) => m.event), ["say", "speaking", "done", "speaking"]);
  assert.equal(got[3].data.seq, null);
});
