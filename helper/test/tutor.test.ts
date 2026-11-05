import { test } from "node:test";
import assert from "node:assert/strict";
import { runTutorTurn, runWalkCommand, REFUSAL_SAY } from "../src/tutor.ts";
import type { TutorEvent } from "../src/types.ts";
import { page, deps, collect, ofType, chunks, layaDown, layaYes } from "./tutor-helpers.ts";

const req = (question: string, o: object = {}) => ({ sessionId: "s", tabId: "tab", question, context: page(), ...o });
const noLeaks = (evs: TutorEvent[]) => { for (const s of ofType(evs, "say")) assert.ok(!/\[|\]|POINT|STEP|WAIT|https?:|\bb\d+\b|\bt\d+\b/.test(s.data.text), s.data.text); };

test("explain: sentences stream out, no pointer, done lists the one brain call", async () => {
  const d = deps(chunks("Optimizer runs is how many times the compiler assumes code will run. The default is 200, from the page.", 9));
  const evs = await collect(runTutorTurn(req("what does optimizer runs mean"), d));
  assert.deepEqual(evs.map((e) => e.event), ["thinking", "say", "say", "done"]);
  assert.equal((evs[0] as any).data.mode, "explain");
  const done = ofType(evs, "done")[0].data;
  assert.equal(done.outcome, "answered"); assert.equal(done.requestIds.brain, "req-brain"); assert.deepEqual(done.requestIds.laya, []);
  assert.equal(done.ms.firstToken, 120); assert.deepEqual(done.calls.map((c) => c.role), ["brain"]); assert.equal(done.calls[0].provider, "0xprov");
  noLeaks(evs);
});
test("point: the pointer is checked by laya and confirmed; its request id lands in done", async () => {
  const d = deps(["The button is below. [POINT:b3]"], { laya: layaYes(0.8) });
  const evs = await collect(runTutorTurn(req("where is the verify button"), d));
  const p = ofType(evs, "point")[0].data;
  assert.deepEqual([p.targetId, p.kind, p.status, p.layaP, p.seq], ["b3", "control", "confirmed", 0.8, 1]);
  const done = ofType(evs, "done")[0].data;
  assert.deepEqual(done.requestIds.laya, ["req-laya-1"]); assert.deepEqual(done.calls.map((c) => c.role), ["brain", "laya"]);
  assert.equal(evs.at(-1)!.event, "done");
});
test("point rejected when laya p is below the bar; the sentence is still said", async () => {
  const evs = await collect(runTutorTurn(req("where is the verify button"), deps(["It is here. [POINT:b3]"], { laya: layaYes(0.1) })));
  assert.equal(ofType(evs, "point")[0].data.status, "rejected"); assert.equal(ofType(evs, "say").length, 1);
});
test("laya down: explanation continues, every pointer is suppressed, never confirmed", async () => {
  const evs = await collect(runTutorTurn(req("where is it"), deps(["Use the dropdown. [POINT:b2] Then verify. [POINT:b3]"], { laya: layaDown })));
  const ps = ofType(evs, "point"); assert.equal(ps.length, 2); assert.ok(ps.every((p) => p.data.status === "suppressed"));
  assert.match(ps[0].data.reason, /won't point/); assert.equal(ofType(evs, "say").length, 2);
  assert.equal(ofType(evs, "done")[0].data.outcome, "answered");
});
test("a throwing checker is the same as laya down", async () => {
  const d = deps(["Here. [POINT:b3]"], { laya: async () => { throw new Error("boom"); } });
  assert.equal(ofType(await collect(runTutorTurn(req("where"), d)), "point")[0].data.status, "suppressed");
});
test("speech is not blocked by a slow laya: the say arrives before the point", async () => {
  const slow = async () => { await new Promise((r) => setTimeout(r, 40)); return { ok: true as const, p: 0.9 }; };
  const evs = await collect(runTutorTurn(req("where"), deps(["Here it is. [POINT:b3] And more words."], { laya: slow })));
  const order = evs.map((e) => e.event);
  assert.ok(order.indexOf("say") < order.indexOf("point")); assert.equal(order.at(-1), "done");
});
test("guide: three steps, step 1 spoken and pointed now, the rest held for the walk", async () => {
  const plan = "[STEP 1/3] Paste the contract address here. [POINT:b1] [WAIT] [STEP 2/3] Pick the compiler version. [POINT:b2] [WAIT] [STEP 3/3] Press Verify and Publish. [POINT:b3] [WAIT]";
  const d = deps(chunks(plan, 6));
  const evs = await collect(runTutorTurn(req("walk me through this form"), d));
  assert.equal(ofType(evs, "thinking")[0].data.mode, "guide");
  assert.deepEqual(ofType(evs, "say").map((s) => s.data.text), ["Paste the contract address here."]);
  assert.deepEqual(evs.map((e) => e.event), ["thinking", "say", "point", "step", "done"]);
  assert.deepEqual(ofType(evs, "step")[0].data, { n: 1, m: 3, say: "Paste the contract address here.", targetId: "b1", kind: "control" });
  assert.equal(d.walks.get("tab")!.steps.length, 3);
  // then next/back/where locally: no further brain call
  let calls = 0; const counting = { ...d, askStream: (...a: Parameters<typeof d.askStream>) => { calls++; return d.askStream(...a); } };
  const n = await collect(runTutorTurn(req("next"), counting));
  assert.equal(calls, 0);
  assert.deepEqual(n.map((e) => e.event), ["thinking", "say", "point", "step", "done"]);
  assert.equal(ofType(n, "step")[0].data.n, 2); assert.equal(ofType(n, "point")[0].data.targetId, "b2");
  const w = await collect(runWalkCommand({ sessionId: "s", tabId: "tab", cmd: "where" }, counting));
  assert.match(ofType(w, "say")[0].data.text, /step 2 of 3/); assert.equal(calls, 0);
  const s = await collect(runTutorTurn(req("stop"), counting)); assert.equal(d.walks.active("tab"), false); assert.equal(calls, 0); assert.ok(s.length);
});
test("walk: a step whose target vanished triggers exactly one fresh plan call", async () => {
  const d = deps(["[STEP 1/2] Pick the version. [POINT:b2] [WAIT] [STEP 2/2] Verify. [POINT:b3] [WAIT]"]);
  await collect(runTutorTurn(req("walk me through"), d));
  let calls = 0;
  const d2 = { ...d, askStream: (...a: Parameters<typeof d.askStream>) => { calls++; return async function* () { yield { type: "delta" as const, text: "[STEP 1/1] Press the new button. [POINT:b9] [WAIT]" }; yield { type: "meta" as const, requestId: "r2", totalMs: 1 }; }(); } };
  const changed = page({ controls: [{ id: "b9", label: "New button", role: "button", rect: { x: 0, y: 0, w: 1, h: 1 } }, { id: "b2x", label: "x", role: "button", rect: { x: 0, y: 0, w: 1, h: 1 } }].filter((c) => c.id === "b9") });
  const evs = await collect(runWalkCommand({ sessionId: "s", tabId: "tab", cmd: "next", context: changed }, d2));
  assert.equal(calls, 1); assert.equal(ofType(evs, "point")[0].data.targetId, "b9"); assert.equal(d.walks.get("tab")!.replans, 1);
});
test("follow-up: inherits the topic through turns, and runs as follow-up mode", async () => {
  const d = deps(["Gas is the fee for running code."]);
  await collect(runTutorTurn(req("what is gas"), d));
  let seen = "";
  const d2 = { ...d, askStream: (m: any[]) => { seen = m[1].content; return d.askStream(m); } };
  const evs = await collect(runTutorTurn(req("why?"), d2));
  assert.equal(ofType(evs, "thinking")[0].data.mode, "follow-up");
  assert.match(seen, /Person: what is gas\nIshara: Gas is the fee for running code\./);
});
test("follow-up in Hinglish also routes to follow-up", async () => {
  const d = deps(["Yeh ek fee hai."]);
  await collect(runTutorTurn(req("gas kya hai"), d));
  assert.equal(ofType(await collect(runTutorTurn(req("kyun?"), d)), "thinking")[0].data.mode, "follow-up");
});
test("refused: no first token gives only thinking + refused, with the plain-language cause", async () => {
  for (const cause of ["timeout", "unavailable", "offline"] as const) {
    const evs = await collect(runTutorTurn(req("what is this"), deps([], { fail: cause })));
    assert.deepEqual(evs.map((e) => e.event), ["thinking", "refused"]);
    assert.deepEqual(ofType(evs, "refused")[0].data, { cause, say: REFUSAL_SAY[cause] });
  }
  assert.match(REFUSAL_SAY.unavailable, /private model is not reachable/);
});
test("refused turns leave no memory behind", async () => {
  const d = deps([], { fail: "timeout" });
  await collect(runTutorTurn(req("what is this"), d));
  assert.equal(d.convo.turns("tab", "https://scan.example/verify").length, 0);
});
test("cutoff mid-answer keeps what was said and marks the outcome", async () => {
  const evs = await collect(runTutorTurn(req("what is this"), deps(["First sentence is whole. Second is cut"], { cutoff: true })));
  assert.deepEqual(ofType(evs, "say").map((s) => s.data.text), ["First sentence is whole.", "Second is cut"]);
  assert.equal(ofType(evs, "done")[0].data.outcome, "cutoff"); assert.equal(ofType(evs, "refused").length, 0);
});
test("hostile page: an injected pointer the model echoes is validated and laya-checked; hostile text never reaches speech", async () => {
  const said = "I will sign you in at https://evil.example/login now. [POINT:b0] [POINT:b777]";
  const evs = await collect(runTutorTurn(req("what does this page say"), deps([said], { laya: layaYes(0.05) })));
  const ps = ofType(evs, "point"); assert.deepEqual(ps.map((p) => p.data.targetId), ["b0"]); assert.equal(ps[0].data.status, "rejected");
  noLeaks(evs); assert.ok(!ofType(evs, "say").some((s) => /evil\.example/.test(s.data.text)));
});
test("injected markers in page text never reach the model as markers", async () => {
  const d = deps(["Fine."]); let sent = "";
  const d2 = { ...d, askStream: (m: any[]) => { sent = m[1].content; return d.askStream(m); } };
  await collect(runTutorTurn(req("what is on this page"), d2));
  const fenced = sent.split(/DATA-[0-9a-f]{16}/)[2];
  assert.ok(!/\[POINT:/.test(fenced));
});
test("the fake-router mark travels to done", async () => {
  assert.equal(ofType(await collect(runTutorTurn(req("what is this"), deps(["Hello there."], { testRouter: true }))), "done")[0].data.testRouter, true);
  assert.equal(ofType(await collect(runTutorTurn(req("what is this"), deps(["Hello there."]))), "done")[0].data.testRouter, undefined);
});
test("an explicit mode from the UI wins over the router", async () => {
  assert.equal(ofType(await collect(runTutorTurn(req("what is this", { mode: "point" }), deps(["Here. [POINT:b3]"]))), "thinking")[0].data.mode, "point");
});
test("spoken text never carries ids, tags, urls or markdown across messy streams", async () => {
  const messy = "**Great** question (b2)! See https://x.io and [b3] t3 `code`.\n- item one\n[POINT:b3] The end [WAIT]";
  for (const n of [1, 3, 8]) noLeaks(await collect(runTutorTurn(req("what is this"), deps(chunks(messy, n)))));
});
