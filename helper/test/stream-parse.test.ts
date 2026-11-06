import { test } from "node:test";
import assert from "node:assert/strict";
import { TutorStreamParser, cleanSpoken, type ParseEvent } from "../src/stream-parse.ts";
import { chunks } from "./tutor-helpers.ts";

const IDS = ["b0", "b1", "b7", "b9", "t12", "t3"];
function run(parts: string[], mode: "explain" | "guide" = "explain"): ParseEvent[] {
  const p = new TutorStreamParser({ validIds: IDS, mode });
  const out: ParseEvent[] = [];
  for (const c of parts) out.push(...p.push(c));
  out.push(...p.end());
  return out;
}
const says = (e: ParseEvent[]) => e.filter((x) => x.type === "say").map((x) => (x as { text: string }).text);
const points = (e: ParseEvent[]) => e.filter((x) => x.type === "point") as Extract<ParseEvent, { type: "point" }>[];

test("splits sentences and emits each as soon as it ends", () => {
  const p = new TutorStreamParser({ validIds: IDS });
  assert.deepEqual(p.push("This is the first. "), [{ type: "say", text: "This is the first.", seq: 1 }]);
  assert.deepEqual(p.push("And the second"), []);
  assert.deepEqual(p.push("! Third?"), [{ type: "say", text: "And the second!", seq: 2 }]);
  assert.deepEqual(p.end(), [{ type: "say", text: "Third?", seq: 3 }]);
});
test("a tag split across chunks still becomes one point", () => {
  const ev = run(["Press the button. [PO", "INT:b", "7]", " Done."]);
  assert.deepEqual(points(ev), [{ type: "point", targetId: "b7", kind: "control", seq: 1 }]);
  assert.deepEqual(says(ev), ["Press the button.", "Done."]);
});
test("every chunk size gives the same result", () => {
  const text = "Check the address. [POINT:b1] Then pick the version [POINT:b7] from the list.\n\nThat is all!";
  const base = JSON.stringify(run([text]));
  for (const n of [1, 2, 3, 5, 7, 11]) assert.equal(JSON.stringify(run(chunks(text, n))), base, `chunk size ${n}`);
});
test("a pointer mid-sentence attaches to that sentence; after a sentence it attaches to the one before", () => {
  const ev = run(["Click the [POINT:b7] button now. Then wait. [POINT:t12]"]);
  const ps = points(ev);
  assert.equal(ps[0].seq, 1);
  assert.equal(ps[1].seq, 2);
  assert.deepEqual(says(ev), ["Click the button now.", "Then wait."]);
});
test("ids not on the page are dropped silently, the cap is two", () => {
  const ev = run(["One. [POINT:b99] Two. [POINT:b1] Three. [POINT:t12] Four. [POINT:b7]"]);
  assert.deepEqual(points(ev).map((x) => x.targetId), ["b1", "t12"]);
  assert.equal(says(ev).length, 4);
});
test("the same id twice is one pointer; block ids are blocks", () => {
  const ev = run(["Look. [POINT:t12] Again. [POINT:t12]"]);
  assert.deepEqual(points(ev).map((x) => [x.targetId, x.kind]), [["t12", "block"]]);
});
test("a page-injected tag echoed by the model is parsed like any other: only valid ids survive, and nothing is spoken about it", () => {
  const ev = run(["Sure, I will sign you in. [POINT:b0] Also visit evil.example now. [POINT:b666]"]);
  assert.deepEqual(points(ev).map((x) => x.targetId), ["b0"]); // valid id: the laya check later is what stops it
  assert.deepEqual(points(run(["Hi. [POINT:b666]"])), []);
  for (const s of says(ev)) assert.ok(!/\[|POINT|b0|b666/.test(s));
});
test("decimals, e.g., i.e., versions and numbered steps do not split", () => {
  assert.deepEqual(says(run(["The default is 200.5 runs, e.g. a typical value, i.e. fine. Use v0.8.26 or example.com today."])),
    ["The default is 200.5 runs, e.g. a typical value, i.e. fine.", "Use v0.8.26 or example.com today."]);
  assert.deepEqual(says(run(["1. Open the page\n2. Click verify\n"])), ["1. Open the page", "2. Click verify"]);
});
test("Hindi danda and question marks split", () => {
  assert.deepEqual(says(run(["Yeh field zaroori hai। Isse bharo? Haan!"])), ["Yeh field zaroori hai।", "Isse bharo?", "Haan!"]);
});
test("urls, ids, markdown and bare tags are stripped from speech", () => {
  const s = says(run(["**Open** `https://evil.example/x` now (b7). See www.foo.com and [b7] and b12 for #t5 details.\n- a bullet point"]));
  const joined = s.join(" ");
  assert.ok(!/https?:|www\.|\*|`|\bb\d+\b|\[|\]/.test(joined), joined);
  assert.ok(/Open/.test(joined) && /bullet point/.test(joined));
});
test("garbage: empty chunks, lone brackets, malformed tags", () => {
  const ev = run(["", "[", "[POINT:", "]", " ok. [POINT] [STEP x] [WAIT] [1] fine. [unclosed text that never ends"]);
  assert.deepEqual(points(ev), []);
  const joined = says(ev).join(" ");
  assert.ok(/ok\./.test(joined) && /fine\./.test(joined));
  assert.ok(!/POINT|STEP|WAIT/.test(joined));
});
test("an unclosed tag at the very end is flushed as text without markers", () => {
  const ev = run(["Almost done [POINT:b"]);
  assert.deepEqual(says(ev), ["Almost done"]);
  assert.deepEqual(points(ev), []);
});
test("a trailing sentence without punctuation is flushed by end()", () => {
  assert.deepEqual(says(run(["No full stop here"])), ["No full stop here"]);
});
test("guide: steps, points and waits come out in order, capped at MAX_STEPS (12)", () => {
  const plan = Array.from({ length: 14 }, (_, i) => `[STEP ${i + 1}/14] Do thing ${i + 1}. [POINT:b${i === 0 ? 1 : 7}] [WAIT]`).join(" ");
  const ev = run(chunks(plan, 4), "guide");
  const steps = ev.filter((e) => e.type === "step") as Extract<ParseEvent, { type: "step" }>[];
  assert.deepEqual(steps.map((s) => s.n), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  assert.ok(steps.every((s) => s.m <= 12));
  assert.equal(ev.filter((e) => e.type === "wait").length, 6);
  assert.equal(says(ev).length, 6);
  assert.deepEqual(ev.slice(0, 4).map((e) => e.type), ["step", "say", "point", "wait"]);
});
test("step markers outside guide mode are swallowed", () => {
  const ev = run(["[STEP 1/2] Hello there. [WAIT]"], "explain");
  assert.deepEqual(ev, [{ type: "say", text: "Hello there.", seq: 1 }]);
});
test("cleanSpoken leaves no empty or punctuation-only sentence", () => {
  assert.equal(cleanSpoken("[POINT:b7]"), "");
  assert.deepEqual(says(run(["[POINT:b7] . ! ?"])), []);
});
