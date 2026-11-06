import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, request } from "node:http";
import type { AddressInfo } from "node:net";
import { handleActRoute, ActRuns, type ActRouteDeps } from "../src/act-route.ts";
import type { AskActResult } from "../src/zg.ts";
import { verifyCtx, page } from "./act-helpers.ts";

const ctx = verifyCtx();
const A = (action: any, say = "Doing it"): AskActResult => ({ ok: true, args: { action, say }, raw: "", requestId: "r-" + Math.random().toString(16).slice(2, 8), ms: 1 });
const body = (o: any = {}) => JSON.stringify({ sessionId: "s", task: "click the Verify and Publish button", context: ctx, executor: "client", armed: true, actId: "act-route-0001", ...o });

type Res = { status: number; headers: Record<string, any>; text(): Promise<string>; json(): Promise<any> };
function raw(port: number, method: string, path: string, b: string | undefined, headers: Record<string, string> = {}, host = "127.0.0.1:7777"): Promise<Res> {
  return new Promise((resolve, reject) => {
    const rq = request({ host: "127.0.0.1", port, method, path, headers: { host, ...(b !== undefined ? { "content-type": "application/json" } : {}), ...headers } }, (rs) => {
      let buf = ""; let fin: () => void; const done = new Promise<void>((r) => (fin = r));
      rs.setEncoding("utf8"); rs.on("data", (c) => (buf += c)); rs.on("end", () => fin()); rs.on("close", () => fin());
      resolve({ status: rs.statusCode!, headers: rs.headers, text: async () => (await done, buf), json: async () => (await done, JSON.parse(buf)) });
    });
    rq.on("error", reject); rq.end(b);
  });
}
const events = (txt: string) => [...txt.matchAll(/event: (\w+)\ndata: (.*)\n\n/g)].map((m) => ({ event: m[1], data: JSON.parse(m[2]) }));

async function start(script: AskActResult[], over: Partial<ActRouteDeps> = {}) {
  let i = 0; const records: any[] = []; const checks: any[] = [];
  const runs = new ActRuns();
  const deps: ActRouteDeps = {
    base: { askAct: async () => script[i++] ?? A({ type: "fail", say: "end" }), checkTarget: async (_t, _s, tg) => { checks.push(tg); return { ok: true, p: 0.9, ms: 1 }; } },
    record: (sid, d) => records.push({ sid, ...d }), runs, confirm: null, heartbeatMs: 50, ...over,
  };
  const srv = createServer((rq, rs) => { handleActRoute(rq, rs, new URL(rq.url!, "http://x").pathname, deps).then((h) => { if (!h) { rs.writeHead(404); rs.end(); } }); });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const port = (srv.address() as AddressInfo).port;
  return { port, runs, records, checks, post: (p: string, b: string, h: Record<string, string> = {}) => raw(port, "POST", p, b, h), get: (p: string) => raw(port, "GET", p, undefined), close: () => { srv.closeAllConnections(); srv.close(); } };
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("GET /act is the feature detect", async () => {
  const t = await start([]);
  const r = await t.get("/act");
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { ok: true, version: 1, armedRequired: true, executors: ["client", "helper"], events: ["thinking", "action", "approval", "result", "done", "failed", "stopped", "ask", "refused"] });
  t.close();
});
test("armed must be true: otherwise 'refused' and the planner is never called", async () => {
  let planned = 0;
  const t = await start([], { base: { askAct: async () => { planned++; return A({ type: "done", say: "x" }); }, checkTarget: async () => ({ ok: false, cause: "unavailable" }) } });
  for (const armed of [false, undefined, "true", 1]) {
    const r = await t.post("/act", body({ armed }));
    assert.equal(r.status, 200); assert.equal(r.headers["content-type"], "text/event-stream");
    assert.equal(await r.text(), 'event: refused\ndata: {"cause":"disarmed","say":"Turn on Agent mode and I will do that."}\n\n');
  }
  assert.equal(planned, 0); assert.equal(t.runs.size(), 0);
  t.close();
});
test("SSE framing for a one-step task that needs no screen: thinking then done", async () => {
  const t = await start([A({ type: "done", say: "Nothing to do." })]);
  const r = await t.post("/act", body());
  assert.equal(r.status, 200);
  assert.equal(r.headers["content-type"], "text/event-stream"); assert.equal(r.headers["cache-control"], "no-cache"); assert.equal(r.headers["x-accel-buffering"], "no");
  assert.equal(r.headers["x-act-id"], "act-route-0001");
  const txt = await r.text();
  assert.match(txt, /^event: thinking\ndata: \{"n":1,"actId":"act-route-0001"\}\n\nevent: done\ndata: \{"say":"Nothing to do\.","steps":0,/);
  assert.equal(t.runs.size(), 0, "a finished task is forgotten");
  assert.equal(t.records.length, 1); assert.equal(t.records[0].outcome, "act-done");
  t.close();
});
test("client executor: action, then POST /act/result with a fresh context, then the next step; HIGH waits for /act/approve", async () => {
  const t = await start([A({ type: "type", id: "b6", text: "0xabc" }), A({ type: "click", id: "b17" }), A({ type: "done", say: "Pressed it." })]);
  const stream = t.post("/act", body({ task: "enter 0xabc as the contract address then click the Verify and Publish button" }));
  const res = await stream;
  // read the stream live: collect text as it arrives
  let buf = ""; const sawEvents = () => events(buf);
  (async () => { const txt = await res.text(); buf = txt; })();
  // We cannot read the body incrementally through the helper above, so drive the protocol by polling the run registry.
  await sleep(60);
  const fresh = { ...ctx, blocks: [...ctx.blocks, { id: "t99", kind: "text" as const, text: "typed", inView: true }] };
  assert.equal((await t.post("/act/result", JSON.stringify({ actId: "act-route-0001", n: 1, ok: true, detail: "typed 5 chars", context: fresh }))).status, 200);
  await sleep(60);
  // step 2 is HIGH: a result before approval is held; approve first
  assert.equal((await t.post("/act/approve", JSON.stringify({ actId: "act-route-0001", n: 2, approve: true }))).status, 200);
  assert.equal((await t.post("/act/result", JSON.stringify({ actId: "act-route-0001", n: 2, ok: true, detail: "clicked", context: fresh }))).status, 200);
  await sleep(100);
  const evs = sawEvents();
  assert.deepEqual(evs.map((e) => e.event), ["thinking", "action", "result", "thinking", "action", "approval", "result", "thinking", "done"]);
  assert.equal(evs[1].data.risk, "medium"); assert.equal(evs[4].data.risk, "high"); assert.equal(evs[4].data.needsApproval, true);
  assert.equal(evs[2].data.detail, "typed 5 chars");
  // the model was shown the fresh context on step 2
  t.close();
});
test("a result that arrives before the helper starts waiting is not lost", async () => {
  const gate: { release?: () => void } = {};
  const t = await start([A({ type: "click", id: "b0" }), A({ type: "done", say: "ok" })], { base: { askAct: (() => { let i = 0; const s = [A({ type: "click", id: "b0" }), A({ type: "done", say: "ok" })]; return async () => s[i++]; })(), checkTarget: async () => { await new Promise<void>((r) => (gate.release = r)); return { ok: true, p: 0.9, ms: 1 }; } } });
  const pending = t.post("/act", body({ task: "open Home" }));
  await sleep(40);
  // the UI is fast: posts the result for step 1 while laya is still thinking
  assert.equal((await t.post("/act/result", JSON.stringify({ actId: "act-route-0001", n: 1, ok: true, detail: "early" }))).status, 200);
  gate.release!();
  const txt = await (await pending).text();
  assert.deepEqual(events(txt).map((e) => e.event), ["thinking", "action", "result", "thinking", "done"]);
  assert.equal(events(txt)[2].data.detail, "early");
  t.close();
});
test("POST /act/stop ends a task that is waiting on the screen", async () => {
  const t = await start([A({ type: "click", id: "b0" }), A({ type: "click", id: "b1" })]);
  const pending = t.post("/act", body({ task: "open Home" }));
  await sleep(60);
  const s = await t.post("/act/stop", JSON.stringify({ actId: "act-route-0001" }));
  assert.deepEqual(await s.json(), { ok: true, found: true });
  const evs = events(await (await pending).text());
  assert.equal(evs.at(-1)!.event, "stopped");
  assert.equal(evs.filter((e) => e.event === "action").length, 1);
  assert.deepEqual(await (await t.post("/act/stop", JSON.stringify({ actId: "nope-nope-1" }))).json(), { ok: true, found: false });
  t.close();
});
test("approval: deny and silence both mean no (silence shortened for the test)", async () => {
  const t = await start([A({ type: "click", id: "b17" })], { limits: { approvalMs: 80, execTimeoutMs: 200 } });
  const pending = t.post("/act", body());
  const evs = events(await (await pending).text());
  assert.deepEqual(evs.map((e) => e.event), ["thinking", "action", "approval", "result", "stopped"]);
  const t2 = await start([A({ type: "click", id: "b17" })]);
  const p2 = t2.post("/act", body());
  await sleep(60);
  await t2.post("/act/approve", JSON.stringify({ actId: "act-route-0001", n: 1, approve: false }));
  assert.equal(events(await (await p2).text()).at(-1)!.event, "stopped");
  t.close(); t2.close();
});
test("ask keeps the task; the answer resumes it with the same actId; a wrong follow-up is refused", async () => {
  const t = await start([A({ type: "ask", say: "Which address?" }), A({ type: "done", say: "All done." })]);
  const first = events(await (await t.post("/act", body({ task: "fill the form" }))).text());
  assert.equal(first.at(-1)!.event, "ask"); assert.equal(first.at(-1)!.data.say, "Which address?");
  assert.equal(t.runs.size(), 1);
  // a re-POST of a paused task without an answer is refused
  const noAnswer = await t.post("/act", body());
  assert.equal(noAnswer.status, 400);
  const second = events(await (await t.post("/act", body({ answer: "the first one" }))).text());
  assert.equal(second.at(-1)!.event, "done"); assert.equal(t.runs.size(), 0);
  const stale = await t.post("/act", body({ answer: "hello" }));
  assert.equal(stale.status, 400);
  t.close();
});
test("validation: 400s for bad bodies, 413 for huge ones, 403 for foreign Host or Origin", async () => {
  const t = await start([A({ type: "done", say: "x" })]);
  assert.equal((await t.post("/act", "not json")).status, 400);
  assert.equal((await t.post("/act", body({ task: "" }))).status, 400);
  assert.equal((await t.post("/act", body({ task: "x".repeat(2001) }))).status, 400);
  assert.equal((await t.post("/act", body({ executor: "robot" }))).status, 400);
  assert.equal((await t.post("/act", body({ context: { url: "u" } }))).status, 400);
  assert.equal((await t.post("/act", body({ context: { ...ctx, blocks: new Array(601).fill(ctx.blocks[0]) } }))).status, 400);
  assert.equal((await t.post("/act", body({ actId: "short" }))).status, 400);
  assert.equal((await t.post("/act", JSON.stringify({ pad: "x".repeat(310_000) }))).status, 413);
  assert.equal((await t.post("/act/result", JSON.stringify({ actId: "nope-nope-1", n: 1, ok: true }))).status, 404);
  assert.equal((await t.post("/act/approve", JSON.stringify({ n: 1, approve: true }))).status, 400);
  assert.equal((await raw(t.port, "POST", "/act", body(), {}, "evil.example:7777")).status, 403);
  assert.equal((await t.post("/act", body(), { origin: "https://evil.example" })).status, 403);
  assert.equal((await raw(t.port, "GET", "/act", undefined, { origin: "https://evil.example" })).status, 403);
  assert.equal((await raw(t.port, "PUT", "/act", "{}")).status, 405);
  assert.equal((await t.post("/act/bogus", "{}")).status, 404);
  t.close();
});
test("the context is scrubbed again on the helper before it reaches the planner, including contexts returned by /act/result", async () => {
  const seen: string[] = [];
  const key = "0x" + "ab12".repeat(16);
  const t = await start([A({ type: "click", id: "b0" }), A({ type: "done", say: "ok" })], { base: { askAct: (() => { let i = 0; const s = [A({ type: "click", id: "b0" }), A({ type: "done", say: "ok" })]; return async (m: any) => { seen.push(m[1].content); return s[i++]; }; })(), checkTarget: async () => ({ ok: true, p: 0.9, ms: 1 }) } });
  const dirty = (txt: string) => page([["b0", "link", "Home"]], ["your key is " + txt]);
  const pending = t.post("/act", body({ task: "open Home", context: dirty(key) }));
  await sleep(60);
  await t.post("/act/result", JSON.stringify({ actId: "act-route-0001", n: 1, ok: true, detail: "ok", context: dirty(key) }));
  await (await pending).text();
  assert.equal(seen.length, 2);
  for (const s of seen) { assert.ok(!s.includes("ab12ab12"), "key leaked to the planner"); assert.match(s, /\[redacted\]/); }
  t.close();
});
test("a disconnected screen stops the task", async () => {
  const t = await start([A({ type: "click", id: "b0" }), A({ type: "click", id: "b1" })]);
  await new Promise<void>((resolve) => {
    const rq = request({ host: "127.0.0.1", port: t.port, method: "POST", path: "/act", headers: { host: "127.0.0.1:7777", "content-type": "application/json" } }, (rs) => { rs.once("data", () => { rq.destroy(); resolve(); }); });
    rq.on("error", () => {}); rq.end(body({ task: "open Home" }));
  });
  await sleep(150);
  assert.equal(t.runs.size(), 0);
  assert.equal(t.records[0]?.outcome, "act-stopped");
  t.close();
});
test("the registry is bounded and forgets idle runs after 10 minutes", () => {
  let now = 0; const runs = new ActRuns(() => now);
  const mk = (id: string) => { const r = { state: { actId: id, lastUsed: now, steps: 0 }, running: false, requestStop() {} } as any; return runs.create(r); };
  for (let i = 0; i < 30; i++) mk("run-" + i + "-aaaa");
  assert.ok(runs.size() <= 20);
  now += 11 * 60 * 1000;
  assert.equal(runs.get("run-29-aaaa"), undefined);
  assert.equal(runs.size(), 0);
});
