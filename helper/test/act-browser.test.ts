// Agent mode, browser side (extension/act.js): is-it-a-task routing, action validation, key combos and the act stream relay.
// The DOM executor is exercised for real in Chrome (test-pages/act-form.html, docs/TESTING-extension.md); here is what node can prove.
import { test } from "node:test";
import assert from "node:assert/strict";

await import("../../extension/sse.js");
await import("../../extension/act.js"); // a classic script: it registers itself on globalThis.Ishara.act (like sse.js on IsharaSSE)
const act = (globalThis as any).Ishara.act;
const { isTask, validate, parseCombo, browserShortcut, describe, continuation } = act;
const SSE = (globalThis as any).IsharaSSE;

test("isTask: orders in English", () => {
  for (const t of [
    "open YouTube", "go to github.com", "click the Create account button", "fill the form: name Harsh Kasana, email harsh@example.com, country India",
    "type my name in the first box", "scroll down", "copy the second paragraph", "play the first result", "pause the video", "search for lo-fi beats",
    "select India from the country list", "tick the newsletter box", "close this tab", "take a screenshot", "submit the form", "do this", "Do it again",
    "please open the settings page", "can you click Sign up", "could you fill in my email", "enter harsh@example.com in the email field", "press Enter",
    "then scroll down", "hey ishara, take a screenshot",
  ]) assert.equal(isTask(t), true, t);
});

test("isTask: Hinglish orders", () => {
  for (const t of ["youtube kholo", "form bharo", "yahan click karo", "naam likho Harsh", "gaana chalao", "ye tab band karo", "scroll karo", "screenshot le lo kar do", "page khol do"])
    assert.equal(isTask(t), true, t);
});

test("isTask: questions are never tasks", () => {
  for (const t of [
    "where do I click to submit?", "what does this button do?", "how do I fill this form", "why is the page asking for my email", "which option should I select?",
    "is this the right country field?", "can I click this?", "what is gas?", "explain the optimizer runs setting", "kya yeh button submit karta hai", "kaise karu ye",
    "kahan click karo", "does clicking Submit delete my account?", "should I tick the newsletter box", "how can I open a new tab", "", "   ", "check if it is right",
    "tell me what this page is about", "who wrote this",
  ]) assert.equal(isTask(t), false, JSON.stringify(t));
});

test("isTask: very long text and non-strings are not tasks", () => {
  assert.equal(isTask("open ".repeat(200)), false);
  assert.equal(isTask(null), false);
  assert.equal(isTask(undefined), false);
});

test("validate: each action type, good and bad", () => {
  assert.deepEqual(validate({ type: "click", id: "b3" }), { ok: true, action: { type: "click", id: "b3" } });
  assert.equal(validate({ type: "click", id: "x" }).ok, false);
  assert.equal(validate({ type: "click" }).ok, false);
  assert.equal(validate({ type: "click", id: "b3; drop" }).ok, false);
  assert.deepEqual(validate({ type: "type", id: "b1", text: "Harsh", clear: true }).action, { type: "type", id: "b1", text: "Harsh", clear: true });
  assert.equal(validate({ type: "type", id: "b1", text: 5 }).ok, false);
  assert.equal(validate({ type: "type", id: "b1", text: "x".repeat(2001) }).ok, false);
  assert.equal(validate({ type: "select", id: "b2", option: "India" }).ok, true);
  assert.equal(validate({ type: "select", id: "b2", option: " " }).ok, false);
  assert.equal(validate({ type: "check", id: "b4", checked: "yes" }).ok, false);
  assert.equal(validate({ type: "check", id: "b4", checked: false }).ok, true);
  assert.equal(validate({ type: "scroll", direction: "sideways" }).ok, false);
  assert.deepEqual(validate({ type: "scroll", direction: "down" }).action, { type: "scroll", direction: "down", amount: "page" });
  assert.equal(validate({ type: "wait", ms: 99999 }).action.ms, 3000);
  assert.equal(validate({ type: "wait", ms: -1 }).ok, false);
  assert.equal(validate({ type: "copy", text: "" }).ok, false);
  assert.equal(validate({ type: "screenshot" }).action.to, "clipboard");
  assert.equal(validate({ type: "screenshot", to: "cloud" }).ok, false);
  assert.equal(validate(null).ok, false);
  assert.equal(validate([]).ok, false);
  assert.equal(validate({ type: "rm -rf" }).ok, false);
});

test("validate: open_url takes http(s) only", () => {
  assert.equal(validate({ type: "open_url", url: "https://www.youtube.com/results?search_query=lofi" }).ok, true);
  assert.equal(validate({ type: "open_url", url: "http://127.0.0.1:7777/test/act-form.html" }).ok, true);
  for (const bad of ["javascript:alert(1)", "file:///etc/passwd", "chrome://settings", "data:text/html,hi", "youtube.com", "", "ftp://x.org"])
    assert.equal(validate({ type: "open_url", url: bad }).ok, false, bad);
  assert.equal(validate({ type: "open_url", url: "https://a.org", newTab: true }).action.newTab, true);
});

test("validate: desktop-only actions are not run by the browser", () => {
  assert.match(validate({ type: "open_app", name: "Notes" }).detail, /desktop/);
  assert.match(validate({ type: "quit_app", name: "Notes" }).detail, /desktop/);
});

test("parseCombo and browserShortcut", () => {
  assert.deepEqual(parseCombo("Enter"), { mods: [], key: "Enter" });
  assert.deepEqual(parseCombo("space"), { mods: [], key: " " });
  assert.deepEqual(parseCombo("cmd+t"), { mods: ["meta"], key: "t" });
  assert.deepEqual(parseCombo("Cmd + Shift + T"), { mods: ["meta", "shift"], key: "t" });
  assert.equal(parseCombo("hyper+x"), null);
  assert.equal(parseCombo("cmd"), null);
  assert.equal(parseCombo("blah"), null);
  const sc = (c: string) => browserShortcut(parseCombo(c));
  assert.equal(sc("cmd+t"), "new_tab");
  assert.equal(sc("ctrl+t"), "new_tab");
  assert.equal(sc("cmd+w"), "close_tab");
  assert.equal(sc("cmd+r"), "reload");
  assert.equal(sc("cmd+["), "back");
  assert.equal(sc("cmd+]"), "forward");
  assert.equal(sc("cmd+l"), "unsupported");
  assert.equal(sc("cmd+q"), "unsupported");
  assert.equal(sc("Enter"), null);
  assert.equal(sc("k"), null);
  assert.equal(sc("shift+a"), null);
});

test("describe: the approval and progress wording", () => {
  assert.equal(describe({ type: "click", id: "b1" }, "Create account", { question: true }), "Press “Create account”?");
  assert.equal(describe({ type: "type", id: "b1", text: "x" }, "Name"), "Typing into “Name”");
  assert.equal(describe({ type: "open_url", url: "https://youtube.com/x" }, "", { question: true }), "Open youtube.com?");
  assert.equal(describe({ type: "check", id: "b1", checked: true }, "Newsletter"), "Ticking “Newsletter”");
});

test("continuation keeps the user's words and lists earlier steps", () => {
  assert.equal(continuation("open youtube", []), "open youtube");
  const c = continuation("open youtube and play the first result", ["Opening youtube.com"]);
  assert.match(c, /^open youtube and play the first result/);
  assert.match(c, /Opening youtube\.com/);
});

// ---- the act stream through the shared relay ----
const enc = new TextEncoder();
function fakeFetch(chunks: string[], status = 200) {
  return async () => ({
    ok: status < 300, status,
    body: { getReader: () => { let i = 0; return { read: async () => (i < chunks.length ? { done: false, value: enc.encode(chunks[i++]) } : { done: true }), cancel: async () => {} }; } },
  });
}
const OPTS = {
  known: ["thinking", "action", "approval", "result", "done", "failed", "stopped", "refused", "ask"], terminals: ["done", "failed", "stopped", "refused", "ask"],
  offlineEvent: (cause: string) => ({ event: "refused", data: { cause, say: "no" } }),
  cutoff: () => ({ event: "failed", data: { say: "cut" } }),
};
async function relay(fetchFn: any, extra: any = {}) {
  const out: any[] = [];
  await SSE.relay({ fetchFn, url: "x", init: {}, post: (m: any) => out.push(m), ...OPTS, ...extra });
  return out;
}

test("act relay: action then done, split across chunks", async () => {
  const wire = 'event: thinking\ndata: {"n":1}\n\nevent: action\ndata: {"n":1,"action":{"type":"scroll","direction":"down"},"risk":"low","say":"Scrolling"}\n\nevent: done\ndata: {"say":"ok","steps":1}\n\n';
  const out = await relay(fakeFetch([wire.slice(0, 40), wire.slice(40, 120), wire.slice(120)]));
  assert.deepEqual(out.map((m) => m.event), ["thinking", "action", "done"]);
  assert.equal(out[1].data.action.direction, "down");
});

test("act relay: an unknown event is skipped, the tutor-only events are not let through", async () => {
  const out = await relay(fakeFetch(['event: say\ndata: {"seq":1}\n\nevent: zzz\ndata: {}\n\nevent: stopped\ndata: {"say":"x"}\n\n']));
  assert.deepEqual(out.map((m) => m.event), ["stopped"]);
});

test("act relay: no route, offline, bad status, and a stream that ends without a terminal event", async () => {
  assert.deepEqual((await relay(fakeFetch([], 404))).map((m) => m.event), ["noroute"]);
  assert.deepEqual((await relay(async () => { throw new Error("down"); })).map((m) => [m.event, m.data.cause]), [["refused", "offline"]]);
  assert.deepEqual((await relay(fakeFetch([], 500))).map((m) => [m.event, m.data.cause]), [["refused", "unavailable"]]);
  const cut = await relay(fakeFetch(['event: thinking\ndata: {"n":1}\n\n']));
  assert.deepEqual(cut.map((m) => m.event), ["thinking", "failed"]);
});

test("act relay: ask is terminal (no synthetic cutoff after it)", async () => {
  const out = await relay(fakeFetch(['event: ask\ndata: {"say":"Which one?"}\n\n']));
  assert.deepEqual(out.map((m) => m.event), ["ask"]);
});

test("tutor relay defaults are unchanged", async () => {
  const out: any[] = [];
  await SSE.relay({ fetchFn: fakeFetch(['event: say\ndata: {"seq":1,"text":"hi"}\n\n']), url: "x", init: {}, post: (m: any) => out.push(m) });
  assert.deepEqual(out.map((m) => m.event), ["say", "done"]);
  assert.equal(out[1].data.outcome, "cutoff");
});

test("search / tab / read_file in the browser executor's validator", () => {
  const { validate: v, searchUrl, describe: d } = act;
  assert.deepEqual(v({ type: "search", query: " a  b " }).action, { type: "search", query: "a b", engine: "brave" });
  assert.equal(v({ type: "search", query: "x", engine: "bing" }).ok, false);
  assert.equal(v({ type: "search", query: "x", engine: "__proto__" }).ok, false);
  assert.equal(v({ type: "search", query: "" }).ok, false);
  assert.equal(v({ type: "search", query: "x".repeat(201) }).ok, false);
  assert.equal(searchUrl("a b&c", "google"), "https://www.google.com/search?q=a%20b%26c");
  assert.equal(searchUrl("x"), "https://search.brave.com/search?q=x");
  assert.equal(searchUrl("x", "duckduckgo"), "https://duckduckgo.com/?q=x");
  assert.deepEqual(v({ type: "tab", op: "switch", match: " Docs " }).action, { type: "tab", op: "switch", match: "Docs" });
  assert.deepEqual(v({ type: "tab", op: "back", match: "ignored" }).action, { type: "tab", op: "back", match: "" });
  assert.equal(v({ type: "tab", op: "switch" }).ok, false);
  assert.equal(v({ type: "tab", op: "teleport" }).ok, false);
  assert.match(v({ type: "read_file", path: "~/a.txt" }).detail, /desktop action/);
  assert.equal(d({ type: "tab", op: "close", match: "mail" }, "", { question: true }), "Close the tab “mail”?");
  assert.equal(d({ type: "search", query: "cats" }, ""), "Searching for “cats”");
});
