// Pure parts of the desktop adapter, with fakes. Real AX/OCR can only be checked by running ishara-ax.
import { test } from "node:test";
import assert from "node:assert/strict";
import { axErrorMessage, decisionToOverlay, normalizeOutline, desktopAsk } from "../src/desktop.ts";
import type { Decision, Outline } from "../src/types.ts";

const outline: Outline = {
  url: "app://X", viewport: { w: 800, h: 600 },
  elements: [
    { id: "b0", label: "Save", role: "button", rect: { x: 100, y: 200, w: 60, h: 20 } },
    { id: "b1", label: "Name", role: "input", rect: { x: 10, y: 10, w: 100, h: 30 } },
  ],
  text: '[b0] button "Save"\n[b1] input "Name" (text)',
};
const dec = (o: Partial<Decision>): Decision => ({ outcome: "ask", say: "hi", reason: "", requestIds: {}, ms: { total: 1 }, ...o });

test("point goes to the centre of the element rect", () => {
  assert.deepEqual(decisionToOverlay(dec({ outcome: "point", targetId: "b0", say: "Here." }), outline), { cmd: "point", x: 130, y: 210, text: "Here." });
});
test("never points at an id that is not in the outline", () => {
  assert.equal(decisionToOverlay(dec({ outcome: "point", targetId: "b99" }), outline).cmd, "ask");
  assert.equal(decisionToOverlay(dec({ outcome: "point" }), outline).cmd, "ask");
});
test("ask and ask_which are bubbles, never pointers", () => {
  assert.deepEqual(decisionToOverlay(dec({ outcome: "ask", say: "Which one?" }), outline), { cmd: "ask", text: "Which one?" });
  assert.equal(decisionToOverlay(dec({ outcome: "ask_which", candidates: ["b0", "b1"], targetId: "b0" }), outline).cmd, "ask");
});
test("safe_stop causes use the plain-language text", () => {
  const t = (c: Decision["safeStopCause"]) => (decisionToOverlay(dec({ outcome: "safe_stop", safeStopCause: c, say: "x" }), outline) as any).text;
  assert.equal(t("unavailable"), "0G's private model is not reachable right now. I won't guess.");
  assert.equal(t("timeout"), "0G took too long to answer.");
  assert.equal(t("offline"), "There is no connection to 0G.");
});
test("permission error names what to grant; timeout and other failures are distinct", () => {
  assert.match(axErrorMessage(2, "ISHARA_PERMISSION: Accessibility"), /Accessibility permission is missing.*Terminal/);
  assert.match(axErrorMessage(null, "", true), /took longer than 6 s/);
  assert.match(axErrorMessage(1, "ishara-ax: no readable window\n"), /exit 1\): ishara-ax: no readable window/);
});
test("normalizeOutline drops duplicates, bad rows, renumbers ids and rebuilds text", () => {
  const o = normalizeOutline({
    url: "app://A", viewport: { w: 1, h: 2 },
    elements: [
      { id: "b5", label: "Save", role: "button", rect: { x: 100, y: 200, w: 50, h: 20 } },
      { id: "b6", label: "save", role: "button", rect: { x: 102, y: 201, w: 50, h: 20 } }, // OCR twin
      { id: "b7", label: "Bad", role: "button", rect: { x: "1", y: 2, w: 3, h: 4 } },
      { id: "b8", label: "Name", role: "input", rect: { x: 5, y: 5, w: 5, h: 5 } },
    ],
    text: '[b5] button "Save"\n[b8] input "Name" (text)',
  });
  assert.deepEqual(o.elements.map((e) => e.id), ["b0", "b1"]);
  assert.equal(o.text, '[b0] button "Save"\n[b1] input "Name" (text)');
});
test("normalizeOutline caps at 150 and keeps controls over plain text", () => {
  const els = [
    ...Array.from({ length: 160 }, (_, i) => ({ id: "t", label: "line " + i, role: "text", rect: { x: 0, y: i * 30, w: 10, h: 10 } })),
    { id: "c", label: "Go", role: "button", rect: { x: 500, y: 5000, w: 10, h: 10 } },
  ];
  const o = normalizeOutline({ elements: els });
  assert.equal(o.elements.length, 150);
  assert.ok(o.elements.some((e) => e.label === "Go"));
});
test("desktopAsk wires outline -> decide -> overlay and reports timings", async () => {
  const sent: unknown[] = [];
  const r = await desktopAsk("where is save", async (_s, q, o) => {
    assert.equal(q, "where is save"); assert.equal(o, outline);
    return dec({ outcome: "point", targetId: "b0", say: "Save is here." });
  }, { outline: async () => outline, send: (c) => sent.push(c) });
  assert.deepEqual(sent, [{ cmd: "point", x: 130, y: 210, text: "Save is here." }]);
  assert.ok(r.ms.total >= 0);
});
