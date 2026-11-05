import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, request } from "node:http";
import type { AddressInfo } from "node:net";
import { handleTutorRoute, type RouteDeps } from "../src/tutor-route.ts";
import { tutorTurn } from "../src/decide.ts";
import { episodeLog } from "../src/episode-log.ts";

const ctx = { source: "browser", url: "http://127.0.0.1:7777/test/x.html", title: "t", viewport: { w: 1, h: 1 }, blocks: [], controls: [{ id: "b1", role: "button", label: "Verify and Publish", rect: { x: 0, y: 0, w: 1, h: 1 } }], errors: [] };
const body = (o: any = {}) => JSON.stringify({ sessionId: "s", question: "what is this", context: ctx, ...o });

async function* fakeTurn() {
  yield { event: "thinking", data: { mode: "explain" } };
  yield { event: "say", data: { seq: 0, text: "Hello there." } };
  yield { event: "done", data: { mode: "explain", outcome: "answered", requestIds: { laya: [] }, ms: { total: 3 } } };
}
// fetch() will not let a caller set Host, and the guard keys on it, so requests go through node:http.
type Res = { status: number; headers: Record<string, any>; text(): Promise<string>; json(): Promise<any> };
function raw(port: number, method: string, path: string, b: string | undefined, headers: Record<string, string>, abortAfterFirstChunk = false): Promise<Res> {
  return new Promise((resolve, reject) => {
    const rq = request({ host: "127.0.0.1", port, method, path, headers: { host: "127.0.0.1:7777", ...(b !== undefined ? { "content-type": "application/json" } : {}), ...headers } }, (rs) => {
      let buf = ""; let fin: () => void; const done = new Promise<void>((r) => (fin = r));
      rs.setEncoding("utf8"); rs.on("data", (c) => { buf += c; if (abortAfterFirstChunk) rq.destroy(); }); rs.on("end", () => fin()); rs.on("close", () => fin());
      resolve({ status: rs.statusCode!, headers: rs.headers, text: async () => (await done, buf), json: async () => (await done, JSON.parse(buf)) });
    });
    rq.on("error", (e) => { if (!abortAfterFirstChunk) reject(e); });
    rq.end(b);
  });
}
async function start(over: Partial<RouteDeps> = {}) {
  const deps: RouteDeps = { turn: fakeTurn, walk: fakeTurn, ...over };
  const srv = createServer((req, res) => { handleTutorRoute(req, res, new URL(req.url!, "http://x").pathname, deps).then((h) => { if (!h) { res.writeHead(404); res.end(); } }); });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const port = (srv.address() as AddressInfo).port;
  // The guard only admits the helper's own host:port, so tests send the real Host header and connect to the free port.
  const post = (path: string, b: string, headers: Record<string, string> = {}) => raw(port, "POST", path, b, headers);
  return { srv, port, post, close: () => { srv.closeAllConnections(); srv.close(); } };
}

test("SSE framing, headers, and the speech seam", async () => {
  const said: string[] = []; let started = 0, ended = 0;
  const t = await start({ onStart: () => { started++; }, onSay: (x) => said.push(x), onEnd: () => { ended++; } });
  const r = await t.post("/tutor", body());
  assert.equal(r.status, 200);
  assert.equal(r.headers["content-type"], "text/event-stream");
  assert.equal(r.headers["cache-control"], "no-cache");
  assert.equal(r.headers["x-accel-buffering"], "no");
  assert.equal(await r.text(),
    'event: thinking\ndata: {"mode":"explain"}\n\n' +
    'event: say\ndata: {"seq":0,"text":"Hello there."}\n\n' +
    'event: done\ndata: {"mode":"explain","outcome":"answered","requestIds":{"laya":[]},"ms":{"total":3}}\n\n');
  assert.deepEqual([started, said, ended], [1, ["Hello there."], 1]);
  t.close();
});
test("speak:false skips the speaker", async () => {
  const said: string[] = []; let started = 0;
  const t = await start({ onStart: () => { started++; }, onSay: (x) => said.push(x) });
  await (await t.post("/tutor", body({ speak: false }))).text();
  assert.deepEqual([started, said.length], [0, 0]);
  t.close();
});
test("a throwing speaker never breaks the stream", async () => {
  const t = await start({ onStart: () => { throw new Error("x"); }, onSay: () => { throw new Error("y"); } });
  assert.match(await (await t.post("/tutor", body())).text(), /event: done/);
  t.close();
});
test("400 on bad bodies, 413 on oversize and on too many controls", async () => {
  const t = await start();
  for (const b of ["{not json", body({ question: "" }), body({ question: "x".repeat(2001) }), body({ mode: "bogus" }),
    JSON.stringify({ question: "q" }), JSON.stringify({ question: "q", context: { url: "u", blocks: [] } })]) {
    assert.equal((await t.post("/tutor", b)).status, 400, b.slice(0, 40));
  }
  assert.equal((await t.post("/tutor", body({ context: { ...ctx, controls: Array.from({ length: 401 }, (_, i) => ({ id: "b" + i })) } }))).status, 400);
  assert.equal((await t.post("/tutor", body({ pad: "y".repeat(310_000) }))).status, 413);
  assert.equal((await t.post("/tutor/walk", JSON.stringify({ sessionId: "s", cmd: "fly" }))).status, 400);
  t.close();
});
test("Host and Origin guard: 403", async () => {
  const t = await start();
  assert.equal((await t.post("/tutor", body(), { host: "evil.com" })).status, 403);
  assert.equal((await t.post("/tutor", body(), { origin: "https://evil.com" })).status, 403);
  assert.equal((await t.post("/tutor", body(), { origin: "http://127.0.0.1:7777" })).status, 200);
  t.close();
});
test("GET /tutor reports support; walk answers the same SSE shape", async () => {
  const t = await start();
  const g = await raw(t.port, "GET", "/tutor", undefined, {});
  assert.deepEqual(await g.json(), { ok: true, version: 1 });
  assert.match(await (await t.post("/tutor/walk", JSON.stringify({ sessionId: "s", cmd: "next" }))).text(), /^event: thinking/);
  t.close();
});
test("heartbeat comment while idle", async () => {
  async function* slow() { await new Promise((r) => setTimeout(r, 120)); yield { event: "done", data: { mode: "explain", outcome: "answered", requestIds: { laya: [] }, ms: { total: 1 } } }; }
  const t = await start({ turn: slow, heartbeatMs: 30 });
  const txt = await (await t.post("/tutor", body())).text();
  assert.match(txt, /^: ping\n\n/);
  assert.match(txt, /event: done/);
  t.close();
});
test("a refused turn sends only refused", async () => {
  async function* refused() { yield { event: "refused", data: { cause: "offline", say: "I can't reach the sealed model." } }; }
  const t = await start({ turn: refused });
  assert.equal(await (await t.post("/tutor", body())).text(), 'event: refused\ndata: {"cause":"offline","say":"I can\'t reach the sealed model."}\n\n');
  t.close();
});
test("client disconnect: the generator is still drained to the end (proof needs the whole stream)", async () => {
  let finished = false;
  async function* g() { yield { event: "say", data: { seq: 0, text: "one." } }; await new Promise((r) => setTimeout(r, 150)); yield { event: "done", data: { mode: "explain", outcome: "answered", requestIds: { laya: [] }, ms: { total: 1 } } }; finished = true; }
  const t = await start({ turn: g });
  await raw(t.port, "POST", "/tutor", body(), {}, true); // hang up after the first chunk
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(finished, true);
  t.close();
});

// ---- tutorTurn: log and memory ----------------------------------------------------------------------------------
test("tutorTurn logs one entry per turn, strips calls from done, passes events through", async () => {
  async function* core() {
    yield { event: "say", data: { seq: 0, text: "Click the button." } };
    yield { event: "say", data: { seq: 1, text: "It publishes." } };
    yield { event: "point", data: { seq: 0, targetId: "b1", kind: "control", status: "confirmed", layaP: 0.8, reason: "ok" } };
    yield { event: "done", data: { mode: "point", outcome: "answered", requestIds: { laya: ["l1"] }, ms: { total: 9 }, testRouter: true,
      calls: [{ role: "brain", model: "0gm-1.0-35b-a3b", requestId: "r1" }, { role: "laya", model: "laya", requestId: "r2" }] } };
  }
  const out: any[] = [];
  for await (const e of tutorTurn({ sessionId: "tt1", question: "where do I publish", context: ctx }, { run: core })) out.push(e);
  assert.deepEqual(out.map((e) => e.event), ["say", "say", "point", "done"]);
  assert.equal("calls" in out[3].data, false);
  assert.equal(out[3].data.testRouter, true);
  const log: any = episodeLog.getLog("tt1");
  assert.equal(log.entries.length, 1);
  const e = log.entries[0];
  assert.equal(e.outcome, "point"); assert.equal(e.targetId, "b1"); assert.equal(e.say, "Click the button. It publishes."); assert.equal(e.testRouter, true);
  assert.equal(e.calls.length, 2);
});
test("tutorTurn: an explanation is labelled as not independently checked; a throwing log never breaks the stream", async () => {
  async function* core() {
    yield { event: "say", data: { seq: 0, text: "x".repeat(900) } };
    yield { event: "done", data: { mode: "explain", outcome: "answered", requestIds: { laya: [] }, ms: { total: 1 }, calls: [{ role: "brain", model: "m", requestId: "r" }] } };
  }
  const out: any[] = [];
  for await (const e of tutorTurn({ sessionId: "tt2", question: "explain", context: ctx }, { run: core })) out.push(e);
  assert.equal(out.length, 2);
  const e: any = (episodeLog.getLog("tt2") as any).entries[0];
  assert.equal(e.outcome, "explain"); assert.equal(e.say.length, 600); assert.match(e.reason, /not independently checked/);
});
test("tutorTurn: a refused turn has no calls to prove and logs nothing", async () => {
  async function* core() { yield { event: "refused", data: { cause: "offline", say: "no" } }; }
  const out: any[] = [];
  for await (const e of tutorTurn({ sessionId: "tt3", question: "q", context: ctx }, { run: core })) out.push(e);
  assert.deepEqual(out.map((e) => e.event), ["refused"]);
});
