import { test } from "node:test";
import assert from "node:assert/strict";
import { parsePoint } from "../src/zg.ts";
import { shortlist } from "../src/shortlist.ts";
import { decide } from "../src/decide.ts";
import type { Outline } from "../src/types.ts";

const els = [
  ["b1", "link", "Home"], ["b2", "input", "Search"], ["b3", "input", "Contract address"],
  ["b4", "select", "Compiler type"], ["b5", "checkbox", "Agree to terms"], ["b6", "button", "Continue"],
].map(([id, role, label]) => ({ id, role, label, rect: { x: 0, y: 0, w: 1, h: 1 } }));
const outline: Outline = { url: "x", viewport: { w: 1, h: 1 }, elements: els, text: "" };

test("parsePoint is lenient", () => {
  assert.equal(parsePoint("Start here. [POINT:b17]"), "b17");
  assert.equal(parsePoint("[b17]"), "b17");
  assert.equal(parsePoint("b17"), "b17");
  assert.equal(parsePoint("[point: B9 ]"), "b9");
  assert.equal(parsePoint("[POINT:none]"), null); // no id: the brain call maps null to "named nothing"
  assert.equal(parsePoint("no idea"), null);
});
test("parsePoint takes the last tag", () => assert.equal(parsePoint("maybe [b1] but really [POINT:b3]"), "b3"));

test("shortlist ranks label matches, ties by order", () => {
  assert.deepEqual(shortlist("where do I enter the contract address", els), ["b3", "b1", "b2"]);
  assert.equal(shortlist("which compiler", els)[0], "b4");
  assert.equal(shortlist("agree terms", els)[0], "b5");
  assert.equal(shortlist("", els).length, 3);
});

const ok = (id: string | null) => async () => ({ ok: true as const, targetId: id, requestId: "r-b", ms: 5 });
const lay = (c: string, p: number) => async () => ({ ok: true as const, choice: c, p, requestId: "r-l", ms: 4 });

test("decide: agreement points and carries request ids", async () => {
  const d = await decide("s", "enter the contract address", outline, { brain: ok("b3"), laya: lay("b3", 0.9) });
  assert.equal(d.outcome, "point"); assert.equal(d.targetId, "b3");
  assert.deepEqual(d.requestIds, { brain: "r-b", laya: "r-l" });
  assert.equal(d.ms.brain, 5);
});
test("decide: disagreement never points", async () => {
  const d = await decide("s", "contract address", outline, { brain: ok("b4"), laya: lay("b3", 0.9) });
  assert.notEqual(d.outcome, "point");
});
test("decide: failure becomes safe_stop with its cause", async () => {
  const d = await decide("s", "q", outline, { brain: async () => ({ ok: false, cause: "timeout" }), laya: lay("b3", 0.9) });
  assert.equal(d.outcome, "safe_stop"); assert.equal(d.safeStopCause, "timeout");
});
test("decide: runs both calls in parallel", async () => {
  const slow = (v: any) => async () => { await new Promise((r) => setTimeout(r, 150)); return v; };
  const t = Date.now();
  await decide("s", "q", outline, { brain: slow({ ok: true, targetId: "b3", ms: 150 }), laya: slow({ ok: true, choice: "b3", p: 0.9, ms: 150 }) });
  assert.ok(Date.now() - t < 280);
});
