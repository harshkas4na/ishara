// askAct against the development-only fake router (scripted tool calls). Mechanics only: nothing here says anything about 0GM.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { createFakeRouter, actReply } from "../../test/fake-router/server.ts";
import { askAct } from "../src/zg.ts";
import { actTools, ACT_TOOL_CHOICE, buildActMessages } from "../src/act-prompt.ts";
import { runAct, newState, type ActDeps } from "../src/act-loop.ts";
import { verifyCtx } from "./act-helpers.ts";

process.env.ISHARA_AUTO = "0"; // these tests are about the ask-before-a-risky-step path; act-auto.test.ts covers the default (auto) levels

let server: ReturnType<typeof createFakeRouter>; let base = "";
before(async () => { server = createFakeRouter(); await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r())); base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`; });
after(() => { server.closeAllConnections(); server.close(); for (const k of ["ISHARA_ROUTER_URL", "FAKE_ROUTER_MODE", "FAKE_ACT_STYLE", "ISHARA_ACT_SCHEMA"]) delete process.env[k]; });
const use = (mode = "ok") => { process.env.ISHARA_ROUTER_URL = base; process.env.FAKE_ROUTER_MODE = mode; delete process.env.FAKE_ACT_STYLE; };
const ctx = verifyCtx();
const ask = (task: string, history: Array<{ n: number; action: string; result: string }> = []) =>
  askAct(buildActMessages({ task, context: ctx, history }), { tools: actTools(), toolChoice: ACT_TOOL_CHOICE });

test("tool schemas: both shapes are one function `act` with action + say", () => {
  for (const shape of ["flat", "oneof"] as const) {
    const [t]: any = actTools(shape);
    assert.equal(t.function.name, "act"); assert.deepEqual(t.function.parameters.required, ["action", "say"]);
  }
  assert.equal(((actTools("flat")[0] as any).function.parameters.properties.action.properties.type.enum as string[]).length, 18);
  assert.equal(((actTools("oneof")[0] as any).function.parameters.properties.action.oneOf as unknown[]).length, 18);
});
test("askAct parses a scripted tool call and carries the ids and the test flag", async () => {
  use();
  const r = await ask("fill the contract address 0x1234567890123456789012345678901234567890 please");
  assert.ok(r.ok);
  if (r.ok) {
    assert.deepEqual(r.args?.action, { type: "type", id: "b6", text: "0x1234567890123456789012345678901234567890" });
    assert.equal(r.args?.say, "Typing the contract address");
    assert.ok(r.requestId && r.chatId && r.provider); assert.equal(r.testRouter, true);
  }
});
test("content-style JSON and malformed replies", async () => {
  use(); process.env.FAKE_ACT_STYLE = "content";
  const r = await ask("click the Verify and Publish button");
  assert.ok(r.ok && r.args && (r.args.action as any).id === "b17");
  delete process.env.FAKE_ACT_STYLE;
  const m = await ask("do something malformed");
  assert.ok(m.ok); if (m.ok) assert.equal(m.args, null);
});
test("router down or slow: a cause, never a throw", async () => {
  use("down");
  const r = await ask("click the Verify and Publish button");
  assert.deepEqual([r.ok, !r.ok && r.cause], [false, "unavailable"]);
  use("slow");
  const s = await askAct(buildActMessages({ task: "x", context: ctx, history: [] }), { tools: actTools(), timeoutMs: 100 });
  assert.deepEqual([s.ok, !s.ok && s.cause], [false, "timeout"]);
  process.env.ISHARA_ROUTER_URL = "http://127.0.0.1:1/v1";
  const o = await ask("x"); assert.deepEqual([o.ok, !o.ok && o.cause], [false, "offline"]);
});
test("end to end through the fake router: the form task fills three fields and stops before submit", async () => {
  use();
  const executed: any[] = [];
  const deps: ActDeps = {
    askAct: (m) => askAct(m, { tools: actTools(), toolChoice: ACT_TOOL_CHOICE }),
    checkTarget: async () => ({ ok: true, p: 0.9, ms: 1 }),
    execute: async (a) => { executed.push(a); return { ok: true, detail: "ok", context: ctx }; },
    approve: async () => { throw new Error("no approval expected"); },
    stopped: () => false,
  };
  const task = "fill the contract address 0x1234567890123456789012345678901234567890, choose the compiler version 0.8.26 and tick the terms box, but don't submit";
  const evs = []; for await (const e of runAct({ sessionId: "s", task, context: ctx, executor: "client", armed: true }, deps, newState({ sessionId: "s", task, context: ctx }, "act-fake-0001"))) evs.push(e);
  assert.deepEqual(executed.map((a) => a.type), ["type", "select", "check"]);
  assert.equal(evs.at(-1)!.event, "done"); assert.equal((evs.at(-1)!.data as any).testRouter, true);
});
test("the end-to-end submit click is HIGH and never runs without approval", async () => {
  use();
  const executed: any[] = []; let asked = 0;
  const deps: ActDeps = {
    askAct: (m) => askAct(m, { tools: actTools(), toolChoice: ACT_TOOL_CHOICE }), checkTarget: async () => ({ ok: true, p: 0.9, ms: 1 }),
    execute: async (a) => { executed.push(a); return { ok: true, detail: "ok", context: ctx }; },
    approve: async () => { asked++; return false; }, stopped: () => false,
  };
  const task = "click the Verify and Publish button";
  const evs = []; for await (const e of runAct({ sessionId: "s", task, context: ctx, executor: "client", armed: true }, deps, newState({ sessionId: "s", task, context: ctx }, "act-fake-0002"))) evs.push(e);
  assert.equal(asked, 1); assert.equal(executed.length, 0);
  assert.deepEqual(evs.map((e) => e.event), ["thinking", "action", "approval", "result", "stopped"]);
});
test("unknown tasks get an honest ask from the test router", () => {
  const r: any = actReply("The person's task: dance");
  assert.equal(r.args.action.type, "ask");
});
