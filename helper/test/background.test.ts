// The extension's service worker (extension/background.js) under a fake `chrome`: arming per tab, Stop that wins over a resume,
// approvals only from the approval window, the own-tab close refusal, back/forward reporting, per-tab sessions (audit 4).
import { test } from "node:test";
import assert from "node:assert/strict";

type Listener = (...a: any[]) => any;
const ev = () => { const ls: Listener[] = []; return { addListener: (f: Listener) => ls.push(f), removeListener: (f: Listener) => { const i = ls.indexOf(f); if (i >= 0) ls.splice(i, 1); }, fire: (...a: any[]) => ls.slice().map((f) => f(...a)), ls }; };
const store: Record<string, any> = {};
const posts: Array<{ path: string; body: any }> = [];
const tabMsgs: Array<{ tabId: number; m: any }> = [];
const windows: any[] = [];
let tabUrl = "https://shop.example/a";
const E = { onMessage: ev(), onConnect: ev(), onRemoved: ev(), onUpdated: ev(), onAlarm: ev(), onCommand: ev(), winRemoved: ev(), onClicked: ev() };
const chrome: any = {
  runtime: { id: "ext-id", onMessage: E.onMessage, onConnect: E.onConnect, getURL: (p: string) => "chrome-extension://ext-id/" + p, sendMessage: async () => ({}), getPlatformInfo: () => {}, lastError: undefined, reload: () => {} },
  offscreen: { hasDocument: async () => true, createDocument: async () => {} },
  storage: {
    session: {
      get: async (k: any) => { if (k === null) return { ...store }; const ks = Array.isArray(k) ? k : [k]; const o: any = {}; for (const x of ks) if (x in store) o[x] = store[x]; return o; },
      set: async (o: any) => { Object.assign(store, o); }, remove: async (k: any) => { for (const x of Array.isArray(k) ? k : [k]) delete store[x]; },
    },
    local: { get: async () => ({}), set: async () => {} },
  },
  tabs: {
    onRemoved: E.onRemoved, onUpdated: E.onUpdated, query: async () => [{ id: 1, active: true }, { id: 2 }],
    sendMessage: async (tabId: number, m: any) => { tabMsgs.push({ tabId, m }); }, create: async () => ({ id: 9 }), update: async () => ({}), remove: async () => {},
    goBack: async (id: number) => { if (tabUrl.endsWith("#spa")) setTimeout(() => E.onUpdated.fire(id, { url: "https://shop.example/a" }), 20); },
    goForward: async () => { throw new Error("no forward"); }, reload: async () => {}, get: async () => null, captureVisibleTab: async () => "",
  },
  windows: { create: async (o: any) => { windows.push(o); return { id: 77 }; }, remove: async () => {}, update: async () => {}, onRemoved: E.winRemoved },
  alarms: { create: () => {}, onAlarm: E.onAlarm },
  commands: { onCommand: E.onCommand },
  action: { onClicked: E.onClicked },
  permissions: { contains: async () => true },
  downloads: { download: async () => 1 },
};
(globalThis as any).chrome = chrome;
(globalThis as any).fetch = async (url: string, init: any) => {
  const path = new URL(url).pathname; const body = init?.body ? JSON.parse(init.body) : undefined; posts.push({ path, body });
  const data = path === "/act/approve" ? { ok: true, accepted: body.n === 1 } : { ok: true };
  return new Response(JSON.stringify(data), { status: 200, headers: { "content-type": "application/json" } });
};
await import("../../extension/background.js");
const send = (msg: any, sender: any = { id: "ext-id", tab: { id: 1, url: tabUrl, windowId: 1 }, frameId: 0, url: tabUrl }) =>
  new Promise<any>((res) => { E.onMessage.ls[0](msg, sender, res); });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("arming is per tab and runs out after 10 idle minutes", async () => {
  assert.equal((await send({ type: "act-state", op: "agent-get" })).on, false);
  await send({ type: "act-state", op: "agent-set", on: true });
  assert.equal((await send({ type: "act-state", op: "agent-get" })).on, true);
  assert.equal((await send({ type: "act-state", op: "agent-get" }, { id: "ext-id", tab: { id: 2 } })).on, false, "another tab is not armed");
  store["agent:1"].at = Date.now() - 11 * 60 * 1000;
  assert.equal((await send({ type: "act-state", op: "agent-get" })).on, false);
});
test("a saved task does not resume when unarmed or after a Stop; Agent mode off stops everything everywhere", async () => {
  await send({ type: "act-state", op: "agent-set", on: true });
  await send({ type: "act-state", op: "set", state: { actId: "a1", taskId: "t1", task: "fill it", awaiting: true } });
  assert.ok((await send({ type: "act-state", op: "get" })).state, "armed + saved = resumes");
  await sleep(5);
  E.onCommand.fire("stop-agent");                                      // the browser-level Stop shortcut
  await sleep(20);
  assert.equal((await send({ type: "act-state", op: "get" })).state, null);
  assert.ok(posts.some((p) => p.path === "/act/stop" && p.body.all === true));
  assert.ok(tabMsgs.some((t) => t.m.type === "act-stop-cmd"));
  assert.equal((await send({ type: "act-state", op: "agent-get" })).on, false, "the shortcut also disarms");
});
test("approvals: never through act-post, only from approve.html, and only what the helper accepted runs", async () => {
  assert.match((await send({ type: "act-post", path: "/act/approve", body: { actId: "x", n: 1, approve: true } })).error, /Ishara window/);
  const pending = send({ type: "act-approval", actId: "a2", n: 1, words: "Press “Pay”?", why: "commits", risk: "high" });
  await sleep(10);
  assert.equal(windows.at(-1).type, "popup");
  const token = String(windows.at(-1).url).split("#")[1];
  // a content script (sender.url = the web page) cannot answer
  assert.match((await send({ type: "approval-answer", token, yes: true })).error, /approval window/);
  // the approval window can
  await send({ type: "approval-answer", token, yes: true }, { id: "ext-id", url: "chrome-extension://ext-id/approve.html#" + token, tab: { id: 5 } });
  assert.deepEqual(await pending, { yes: true, accepted: true });
  // the helper refusing (a late tap) means the tab is told NOT to run it
  const p2 = send({ type: "act-approval", actId: "a2", n: 2, words: "Press “Pay”?", why: "", risk: "high" });
  await sleep(10);
  const t2 = String(windows.at(-1).url).split("#")[1];
  await send({ type: "approval-answer", token: t2, yes: true }, { id: "ext-id", url: "chrome-extension://ext-id/approve.html#" + t2 });
  assert.deepEqual(await p2, { yes: true, accepted: false });
  // closing the window is a no
  const p3 = send({ type: "act-approval", actId: "a2", n: 1, words: "x", why: "", risk: "high" });
  await sleep(10); E.winRemoved.fire(77);
  assert.equal((await p3).yes, false);
});
test("the tab Ishara works in is never closed; back reports whether the page changed", async () => {
  assert.equal((await send({ type: "act-tab", cmd: "close_tab" })).ok, false);
  tabUrl = "https://shop.example/a#spa";
  const b = await send({ type: "act-tab", cmd: "back" }, { id: "ext-id", tab: { id: 1, url: tabUrl, windowId: 1 } });
  assert.equal(b.changed, true);
  const f = await send({ type: "act-tab", cmd: "forward" });
  assert.equal(f.ok, false);
});
test("one session per tab across page loads; it is saved to 0G when the tab closes", async () => {
  const a = await send({ type: "session-id" }); const b = await send({ type: "session-id" });
  assert.equal(a.id, b.id);
  await send({ type: "session-touch", sessionId: a.id });
  E.onRemoved.ls.forEach((f) => f(1));
  await sleep(20);
  assert.ok(posts.some((p) => p.path === "/session/end" && p.body.sessionId === a.id));
});
