import { test } from "node:test";
import assert from "node:assert/strict";
import { validateAction, parseCombo, parseActMessage, jsonFromText, normalizeArgs } from "../src/act.ts";
import { verifyCtx, page } from "./act-helpers.ts";

const ctx = verifyCtx();
const ok = (a: any) => { const r = validateAction(a, ctx); assert.ok(r.ok, JSON.stringify(r)); return (r as any).action; };
const err = (a: any, re: RegExp) => { const r = validateAction(a, ctx); assert.equal(r.ok, false, JSON.stringify(r)); assert.match((r as any).error, re); };

test("click: id must exist; unknown fields are stripped", () => {
  assert.deepEqual(ok({ type: "click", id: "b17", sneaky: "x", __proto__: { a: 1 } }), { type: "click", id: "b17" });
  err({ type: "click", id: "b999" }, /no "b999"/);
  err({ type: "click" }, /needs an "id"/);
  assert.deepEqual(ok({ type: "click", id: "t1" }), { type: "click", id: "t1" }); // a text block may be clicked
});
test("type: target must be a text-like control, text <= 2000", () => {
  assert.deepEqual(ok({ type: "type", id: "b6", text: "0xabc", clear: true }), { type: "type", id: "b6", text: "0xabc", clear: true });
  err({ type: "type", id: "b17", text: "x" }, /not a text field/);       // a button
  err({ type: "type", id: "t1", text: "x" }, /plain text, not a control/);
  err({ type: "type", id: "b6", text: "x".repeat(2001) }, /over 2000/);
  err({ type: "type", id: "b6" }, /needs a "text"/);
  err({ type: "type", id: "b6", text: "a\u0000b" }, /control characters/);
  assert.ok(validateAction({ type: "type", id: "b6", text: "x".repeat(2000) }, ctx).ok);
});
test("select and check need the right kind of control", () => {
  assert.deepEqual(ok({ type: "select", id: "b8", option: " 0.8.26 " }), { type: "select", id: "b8", option: "0.8.26" });
  err({ type: "select", id: "b6", option: "x" }, /not a dropdown/);
  err({ type: "select", id: "b8" }, /needs an "option"/);
  assert.deepEqual(ok({ type: "check", id: "b10", checked: false }), { type: "check", id: "b10", checked: false });
  err({ type: "check", id: "b10", checked: "yes" }, /true or false/);
  err({ type: "check", id: "b6", checked: true }, /not a checkbox/);
});
test("key combos follow the safe grammar", () => {
  for (const [i, o] of [["Enter", "enter"], ["Cmd+T", "cmd+t"], ["ctrl+shift+Tab", "ctrl+shift+tab"], ["F5", "f5"], ["cmd+l", "cmd+l"], [" Escape ", "escape"], ["cmd+,", "cmd+,"]] as const) assert.equal(parseCombo(i), o, i);
  for (const bad of ["", "cmd+", "+t", "cmd+cmd+t", "rm -rf", "cmd+t; ls", "cmd+tt", "meta+x", "f13", "cmd+$(x)", "enter\nenter", "a".repeat(50)]) assert.equal(parseCombo(bad), null, bad);
  err({ type: "key", combo: "cmd+tt" }, /combo/);
  assert.deepEqual(ok({ type: "key", combo: "Cmd+T" }), { type: "key", combo: "cmd+t" });
});
test("scroll, wait, screenshot", () => {
  assert.deepEqual(ok({ type: "scroll", direction: "down" }), { type: "scroll", direction: "down" });
  assert.deepEqual(ok({ type: "scroll", direction: "up", amount: "page" }), { type: "scroll", direction: "up", amount: "page" });
  err({ type: "scroll", direction: "left" }, /up.*down/);
  err({ type: "scroll", direction: "up", amount: "mile" }, /amount/);
  assert.deepEqual(ok({ type: "wait", ms: 3000 }), { type: "wait", ms: 3000 });
  assert.deepEqual(ok({ type: "wait", ms: "500" }), { type: "wait", ms: 500 });
  err({ type: "wait", ms: 3001 }, /between 0 and 3000/);
  err({ type: "wait", ms: -1 }, /between/);
  err({ type: "wait" }, /between/);
  assert.deepEqual(ok({ type: "screenshot", to: "file" }), { type: "screenshot", to: "file" });
  err({ type: "screenshot", to: "cloud" }, /clipboard.*file/);
});
test("open_url: http(s) with a hostname only", () => {
  assert.deepEqual(ok({ type: "open_url", url: "https://example.com/a?b=1" }), { type: "open_url", url: "https://example.com/a?b=1" });
  for (const bad of ["javascript:alert(1)", "file:///etc/passwd", "data:text/html,x", "chrome://settings", "http://", "example.com", "https://user:pw@example.com", "https://exa mple.com", "ftp://example.com", "https://example.com/\u0000"]) err({ type: "open_url", url: bad }, /http or https/);
  err({ type: "open_url" }, /url/);
});
test("open_app / quit_app take a plain name", () => {
  assert.deepEqual(ok({ type: "open_app", name: "Google Chrome" }), { type: "open_app", name: "Google Chrome" });
  for (const bad of ["../x", "a/b", "Notes; rm", "$(id)", "`x`", "", "a".repeat(81), "a|b", 'a"b']) err({ type: "quit_app", name: bad }, /plain application/);
});
test("copy, done, ask, fail", () => {
  assert.deepEqual(ok({ type: "copy", text: "hi" }), { type: "copy", text: "hi" });
  err({ type: "copy", text: "" }, /needs a "text"/);
  err({ type: "copy", text: "y".repeat(2001) }, /over 2000/);
  assert.deepEqual(ok({ type: "done", say: "  All   set. " }), { type: "done", say: "All set." });
  err({ type: "ask" }, /needs a short "say"/);
  err({ type: "fail", say: "  " }, /say/);
  assert.equal((ok({ type: "done", say: "x".repeat(900) }) as any).say.length, 300);
});
test("unknown type and non-objects", () => {
  err({ type: "rm_rf" }, /Unknown action type/);
  err({}, /Unknown action type/);
  err(null, /object/); err("click", /object/); err([], /object/);
});
test("a page with no controls still validates the terminal actions", () => {
  const empty = page([]);
  assert.ok(validateAction({ type: "done", say: "ok" }, empty).ok);
  assert.equal(validateAction({ type: "click", id: "b0" }, empty).ok, false);
});

test("parseActMessage: tool_calls with a JSON string, an object, content JSON, tags, fences, flat calls", () => {
  const args = { action: { type: "click", id: "b3" }, say: "Pressing it" };
  const want = { action: { type: "click", id: "b3" }, say: "Pressing it" };
  const call = (a: unknown) => ({ tool_calls: [{ function: { name: "act", arguments: a } }] });
  assert.deepEqual(parseActMessage(call(JSON.stringify(args))), want);
  assert.deepEqual(parseActMessage(call(args)), want);
  assert.deepEqual(parseActMessage({ content: JSON.stringify(args) }), want);
  assert.deepEqual(parseActMessage({ content: "Sure!\n```json\n" + JSON.stringify(args) + "\n```" }), want);
  assert.deepEqual(parseActMessage({ content: `<tool_call>{"name":"act","arguments":${JSON.stringify(args)}}</tool_call>` }), want);
  assert.deepEqual(parseActMessage({ content: "I will do it: " + JSON.stringify(args) + " ok?" }), want);
  assert.deepEqual(parseActMessage(call(JSON.stringify({ action: JSON.stringify({ type: "click", id: "b3" }), say: "Pressing it" }))), want); // action as a string
  assert.deepEqual(parseActMessage(call(JSON.stringify({ type: "click", id: "b3", say: "Pressing it" }))), { action: { type: "click", id: "b3" }, say: "Pressing it" }); // flattened
  assert.deepEqual(parseActMessage(call(JSON.stringify({ action: "click", id: "b3", say: "x" }))), { action: { type: "click", id: "b3" }, say: "x" });
});
test("parseActMessage: junk is null, never a guess", () => {
  for (const m of [null, undefined, {}, { content: "I think I should click something" }, { content: "{not json" }, { tool_calls: [] }, { tool_calls: [{ function: { arguments: "garbage" } }] }, { tool_calls: [{ function: { arguments: "[1,2]" } }] }, { content: '{"foo":1}' }])
    assert.equal(parseActMessage(m as any), null, JSON.stringify(m));
  assert.equal(jsonFromText(""), undefined);
  assert.equal(normalizeArgs("x"), null);
  // braces inside strings must not confuse the extractor
  assert.deepEqual(jsonFromText('go {"a":"}{","b":1} end'), { a: "}{", b: 1 });
});
