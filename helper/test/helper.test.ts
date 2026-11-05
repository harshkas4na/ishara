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

test("shortlist ranks label matches, then controls before links", () => {
  // No other element shares a word, so after the match the controls (b2, b4) beat the link (b1).
  assert.deepEqual(shortlist("where do I enter the contract address", els), ["b3", "b2", "b4"]);
  assert.equal(shortlist("which compiler", els)[0], "b4");
  assert.equal(shortlist("agree terms", els)[0], "b5");
  assert.equal(shortlist("", els).length, 3);
});

test("shortlist: action words and synonyms reach the right button, headings are never candidates", () => {
  const page = [
    ["b0", "link", "verification guide"], ["b1", "text", "Verify and publish source"],
    ["b2", "input", "Contract address"], ["b3", "button", "Verify and Publish"], ["b4", "button", "Reset"],
  ].map(([id, role, label]) => ({ id, role, label, rect: { x: 0, y: 0, w: 1, h: 1 } }));
  assert.equal(shortlist("how do I submit this for verification", page)[0], "b3"); // not the guide link, not the heading
  assert.equal(shortlist("how do I clear the form", page)[0], "b4");
  assert.ok(!shortlist("verify", page).includes("b1"));
});

const ok = (id: string | null) => async () => ({ ok: true as const, targetId: id, requestId: "r-b", ms: 5 });
const yes = (p: number) => async () => ({ ok: true as const, p, requestId: "r-l", ms: 4 });

test("decide: proposal confirmed points and carries request ids", async () => {
  const d = await decide("s", "enter the contract address", outline, { brain: ok("b3"), verify: yes(0.9) });
  assert.equal(d.outcome, "point"); assert.equal(d.targetId, "b3");
  assert.deepEqual(d.requestIds, { brain: "r-b", laya: "r-l" });
  assert.equal(d.ms.brain, 5);
});
test("decide: an unconfirmed proposal never points", async () => {
  const d = await decide("s", "contract address", outline, { brain: ok("b4"), verify: yes(0.05) });
  assert.equal(d.outcome, "ask");
});
test("decide: an id that is not on the page counts as naming nothing, and laya is not called", async () => {
  let called = false;
  const d = await decide("s", "q", outline, { brain: ok("b99"), verify: async () => { called = true; return { ok: true, p: 1, ms: 1 }; } });
  assert.equal(d.outcome, "ask"); assert.equal(called, false);
});
test("decide: failure becomes safe_stop with its cause", async () => {
  const d = await decide("s", "q", outline, { brain: async () => ({ ok: false, cause: "timeout" }), verify: yes(0.9) });
  assert.equal(d.outcome, "safe_stop"); assert.equal(d.safeStopCause, "timeout");
});
test("decide: laya failing means ask, not point", async () => {
  const d = await decide("s", "q", outline, { brain: ok("b3"), verify: async () => ({ ok: false, cause: "timeout" }) });
  assert.equal(d.outcome, "ask");
});

import { refuse, staticPath } from "../src/http-guard.ts";
test("guard: only our own host, and only the extension or our pages as origin", () => {
  assert.equal(refuse("127.0.0.1:7777", undefined), false);
  assert.equal(refuse("localhost:7777", "chrome-extension://abcdef"), false);
  assert.equal(refuse("127.0.0.1:7777", "http://127.0.0.1:7777"), false);
  assert.equal(refuse("127.0.0.1:7777", "https://evil.example"), true, "cross-site POST must not reach /decide");
  assert.equal(refuse("127.0.0.1:7777", "http://127.0.0.1:77770"), true);
  assert.equal(refuse("evil.example:7777", undefined), true, "DNS rebinding: foreign Host");
  assert.equal(refuse(undefined, undefined), true);
});
test("guard: static paths stay inside their folder", () => {
  const dir = "/srv/web/";
  assert.equal(staticPath(dir, ""), "/srv/web/index.html");
  assert.equal(staticPath(dir, "proof.html"), "/srv/web/proof.html");
  assert.equal(staticPath(dir, "test-fixtures/a.json"), "/srv/web/test-fixtures/a.json");
  assert.equal(staticPath(dir, "../secret"), null);
  assert.equal(staticPath(dir, "%2e%2e/%2e%2e/etc/passwd"), null);
  assert.equal(staticPath(dir, "a/../../x"), null);
  assert.equal(staticPath(dir, "%E0%A4%A"), null, "malformed escape is refused, not a 500");
  assert.equal(staticPath(dir, "a%00.html"), null);
});
