import { test } from "node:test";
import assert from "node:assert/strict";
import { checkPointer, decidePointer } from "../src/pointer-gate.ts";
import { VERIFY_MIN_P } from "../src/config.ts";

test("decidePointer: confirmed, rejected, suppressed, and the boundary", () => {
  const ok = (p: number) => ({ ok: true as const, p, ms: 1 });
  assert.equal(decidePointer(ok(0.9)), "confirmed");
  assert.equal(decidePointer(ok(VERIFY_MIN_P)), "confirmed"); // at the bar counts
  assert.equal(decidePointer(ok(VERIFY_MIN_P - 0.001)), "rejected");
  assert.equal(decidePointer(ok(0.5), 0.6), "rejected");
  for (const cause of ["timeout", "unavailable", "offline"] as const) assert.equal(decidePointer({ ok: false, cause }), "suppressed");
});

test("checkPointer: a block goes to laya as role text, clipped, with the user's question", async () => {
  let seen: any;
  const long = "x".repeat(300);
  const r = await checkPointer("what does this say", { id: "t3", kind: "block", label: long }, async (q, el) => { seen = { q, el }; return { ok: true, p: 0.7, requestId: "r", chatId: "c", provider: "0xp", ms: 5, testRouter: true }; });
  assert.equal(seen.q, "what does this say");
  assert.equal(seen.el.role, "text"); assert.equal(seen.el.label.length, 120);
  assert.deepEqual(r, { ok: true, p: 0.7, ms: 5, requestId: "r", chatId: "c", provider: "0xp", testRouter: true });
});
test("checkPointer: a control keeps its label; laya failure and a throwing verifier are not ok", async () => {
  let el: any;
  await checkPointer("q", { id: "b1", kind: "control", label: "Compiler type", role: "select" }, async (_q, e) => { el = e; return { ok: true, p: 1, ms: 1 }; });
  assert.equal(el.role, "select"); assert.equal(el.label, "Compiler type");
  assert.deepEqual(await checkPointer("q", { id: "b1", kind: "control", label: "x" }, async () => ({ ok: false, cause: "timeout" })), { ok: false, cause: "timeout" });
  assert.deepEqual(await checkPointer("q", { id: "b1", kind: "control", label: "x" }, async () => { throw new Error("boom"); }), { ok: false, cause: "unavailable" });
});
