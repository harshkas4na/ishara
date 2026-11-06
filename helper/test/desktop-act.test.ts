// Agent mode on the desktop: the action -> selector mapping, the refusals (secret fields, browsers), the stop flag, the voice
// parsers (English and Hinglish, false positives), approval by voice, and the overlay command mapping. All with fakes: no
// Swift process, no overlay, no network.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  executeDesktopAction, toActInput, findTarget, selectorFor, isSecretTarget, actionInWords, desktopExecutorFor,
  requestStop, requestStopAll, agentModeCommand, isTaskUtterance, approvalAnswer, isStopWord, actEventToCmds, createSseParser,
  desktopSay, resetAgentState, agentState, answerApproval, onOverlayAgentLine, type ActDeps, type ActInput, type ActRaw,
} from "../src/desktop-act.ts";
import { buildContext, newIdBook, selectorsFromRaw, selectorBook, type OverlayCmd } from "../src/desktop.ts";
import { agentModeCommand as pttAgentModeCommand } from "../src/desktop-ptt.ts";

beforeEach(() => resetAgentState());

const raw = {
  app: "TextEdit", bundleId: "com.apple.TextEdit", title: "Untitled", viewport: { w: 800, h: 600 }, origin: { x: 0, y: 0 },
  controls: [
    { id: "b0", label: "bold", role: "checkbox", rect: { x: 10, y: 10, w: 20, h: 20 }, selector: { role: "checkbox", axRole: "AXCheckBox", label: "bold", index: 0 } },
    { id: "b1", label: "Save", role: "button", rect: { x: 100, y: 10, w: 60, h: 24 }, selector: { role: "button", axRole: "AXButton", label: "Save", index: 0 } },
    { id: "b2", label: "Save", role: "button", rect: { x: 200, y: 10, w: 60, h: 24 }, selector: { role: "button", axRole: "AXButton", label: "Save", index: 1 } },
    { id: "b3", label: "Notes", role: "input", rect: { x: 10, y: 60, w: 400, h: 200 }, ctl: "text", selector: { role: "input", axRole: "AXTextArea", label: "Notes", index: 0 } },
    { id: "b4", label: "Password", role: "input", rect: { x: 10, y: 300, w: 200, h: 24 }, ctl: "password", selector: { role: "input", axRole: "AXSecureTextField", label: "Password", index: 0, secure: true } },
    { id: "b5", label: "Wallet seed phrase", role: "input", rect: { x: 10, y: 340, w: 200, h: 24 }, ctl: "text", selector: { role: "input", axRole: "AXTextField", label: "Wallet seed phrase", index: 0 } },
  ],
  blocks: [{ kind: "li", text: "Wi-Fi", inView: true, rect: { x: 5, y: 400, w: 100, h: 20 } }],
};
const ctx = () => {
  const c = buildContext(raw, { book: newIdBook() });
  selectorBook.set("com.apple.TextEdit", c, selectorsFromRaw(raw, c));
  return c;
};

// ---- fakes ----
type Rec = { ran: ActInput[]; sent: OverlayCmd[]; slept: number[]; pill: string[]; reads: number };
function fakes(over: Partial<ActDeps> = {}, rawFor: (i: ActInput) => ActRaw = () => ({ ok: true, detail: "ok" }), front = "com.apple.TextEdit") {
  const rec: Rec = { ran: [], sent: [], slept: [], pill: [], reads: 0 };
  const c = ctx();
  const deps: ActDeps = {
    run: async (i) => { rec.ran.push(i); return rawFor(i); },
    send: (cmd) => rec.sent.push(cmd),
    readContext: async () => { rec.reads++; return rec.reads > 1 ? { ...c, title: "After" } : c; },
    front: async () => ({ app: "x", bundleId: front }),
    sleep: async (ms) => { rec.slept.push(ms); },
    stopped: () => false,
    bundleId: () => "com.apple.TextEdit",
    pill: (t) => rec.pill.push(t),
    ...over,
  };
  return { rec, deps, c };
}

// ---------- action -> selector ----------
test("click maps to press with the stable selector: role, label, index, title, rect, bundle", () => {
  const c = ctx();
  const i = toActInput({ type: "click", id: "b2" }, c, "com.apple.TextEdit") as any;
  assert.equal(i.type, "press");
  assert.deepEqual(i.selector, { role: "button", label: "Save", index: 1, title: "Untitled", rect: { x: 200, y: 10, w: 60, h: 24 }, axRole: "AXButton", bundleId: "com.apple.TextEdit" });
});
test("the sibling index is rebuilt from the context when ishara-ax gave none (earlier controls with the same role and label)", () => {
  const c = buildContext({ ...raw, controls: raw.controls.map(({ selector, ...rest }) => rest) }, { book: newIdBook() });
  const t = findTarget(c, "b2", { get: () => undefined } as any)!;
  assert.equal((selectorFor(c, t) as any).index, 1);
  assert.equal((selectorFor(c, findTarget(c, "b1", { get: () => undefined } as any)!) as any).index, 0);
});
test("every contract action maps to one ishara-act input", () => {
  const c = ctx();
  const m = (a: any) => toActInput(a, c, "com.apple.TextEdit") as any;
  assert.equal(m({ type: "type", id: "b3", text: "hello", clear: true }).type, "setvalue");
  assert.deepEqual([m({ type: "type", id: "b3", text: "hello", clear: true }).text, m({ type: "type", id: "b3", text: "hello" }).clear], ["hello", false]);
  assert.deepEqual([m({ type: "select", id: "b1", option: "Courier" }).type, m({ type: "select", id: "b1", option: "Courier" }).option], ["press", "Courier"]);
  assert.deepEqual(m({ type: "check", id: "b0", checked: true }), { type: "check", checked: true, selector: m({ type: "check", id: "b0", checked: true }).selector });
  assert.deepEqual(m({ type: "key", combo: "cmd+t" }), { type: "key", combo: "cmd+t" });
  assert.deepEqual(m({ type: "scroll", direction: "down" }), { type: "scroll", direction: "down", amount: "line" });
  assert.deepEqual(m({ type: "open_app", name: "TextEdit" }), { type: "open_app", name: "TextEdit" });
  assert.deepEqual(m({ type: "quit_app", name: "TextEdit" }), { type: "quit_app", name: "TextEdit" });
  assert.deepEqual(m({ type: "open_url", url: "https://example.com" }), { type: "open_url", url: "https://example.com" });
  assert.deepEqual(m({ type: "copy", text: "x" }), { type: "copy", text: "x" });
  assert.equal(m({ type: "screenshot", to: "file" }).type, "screenshot");
});
test("a block id (a text row) targets role text with its words and rect", () => {
  const c = ctx();
  const blockId = c.blocks[0].id;
  const i = toActInput({ type: "click", id: blockId }, c, "x") as any;
  assert.equal(i.selector.role, "text"); assert.equal(i.selector.label, "Wi-Fi"); assert.deepEqual(i.selector.rect, { x: 5, y: 400, w: 100, h: 20 });
});
test("an id that is not on this screen is refused, not guessed", () => {
  assert.deepEqual(toActInput({ type: "click", id: "b99" }, ctx(), "x"), { refuse: "there is no control b99 on this screen" });
});

// ---------- refusals ----------
test("secret fields: a secure AX field, a password-named field and a seed-phrase field refuse typing before Swift is called", async () => {
  for (const id of ["b4", "b5"]) {
    const { rec, deps, c } = fakes();
    const r = await executeDesktopAction({ type: "type", id, text: "hunter2" }, c, deps);
    assert.equal(r.ok, false); assert.equal(r.detail, "secret field");
    assert.equal(rec.ran.length, 0, "Swift was never started");
    assert.equal(rec.sent.length, 0, "the cursor did not even move");
  }
});
test("secret targets are recognised from the AX role, the secure flag or the label", () => {
  const c = ctx();
  assert.equal(isSecretTarget(findTarget(c, "b4")!), true);
  assert.equal(isSecretTarget(findTarget(c, "b5")!), true);
  assert.equal(isSecretTarget(findTarget(c, "b3")!), false);
});
test("typing into a non-text control is refused", async () => {
  const { deps, c } = fakes();
  const r = await executeDesktopAction({ type: "type", id: "b1", text: "x" }, c, deps);
  assert.equal(r.ok, false); assert.match(r.detail, /not a text field/);
});
test("in a browser, DOM actions say 'use the browser extension' and nothing runs; key, copy, open_app still work", async () => {
  for (const a of [{ type: "click", id: "b1" }, { type: "type", id: "b3", text: "x" }, { type: "check", id: "b0", checked: true }, { type: "scroll", direction: "down" }, { type: "select", id: "b1", option: "x" }] as any[]) {
    const { rec, deps, c } = fakes({}, undefined, "com.google.Chrome");
    const r = await executeDesktopAction(a, c, deps);
    assert.deepEqual([r.ok, r.detail], [false, "use the browser extension"], a.type);
    assert.equal(rec.ran.length, 0);
  }
  for (const a of [{ type: "key", combo: "cmd+t" }, { type: "copy", text: "x" }, { type: "open_app", name: "Notes" }, { type: "open_url", url: "https://a.com" }, { type: "screenshot", to: "file" }, { type: "quit_app", name: "Notes" }] as any[]) {
    const { rec, deps, c } = fakes({ bundleId: () => "com.google.Chrome" }, undefined, "com.google.Chrome"); // screen read from the browser too
    const r = await executeDesktopAction(a, c, deps);
    assert.equal(r.ok, true, a.type); assert.equal(rec.ran.length, 1);
  }
});
test("the AX press failing falls back to a coordinate click, but never for a secret field", async () => {
  const press: ActRaw = { ok: false, detail: "AXPress is not supported", fallback: "click_at", x: 130, y: 22 };
  const a = fakes({}, (i) => (i.type === "press" ? press : { ok: true, detail: "clicked at 130,22" }));
  const r = await executeDesktopAction({ type: "click", id: "b1" }, a.c, a.deps);
  assert.deepEqual(a.rec.ran.map((i) => i.type), ["press", "click_at"]);
  assert.deepEqual(a.rec.ran[1], { type: "click_at", x: 130, y: 22 });
  assert.equal(r.ok, true); assert.match(r.detail, /clicked its position/);
  // a press that fails on a secret field never reaches click_at (type refuses first; a click on the field itself is also blocked)
  const b = fakes({}, () => press);
  const t = findTarget(b.c, "b4")!;
  assert.equal(isSecretTarget(t), true);
  const rr = await executeDesktopAction({ type: "click", id: "b4" }, b.c, b.deps);
  assert.deepEqual(b.rec.ran.map((i) => i.type), ["press"], "no click_at on a secret field");
  assert.equal(rr.ok, false);
});

// ---------- visible, then done, then fresh context ----------
test("the cursor travels to the target BEFORE the action; a non-targeted action only shows the pill", async () => {
  const order: string[] = [];
  const { deps, c } = fakes({ send: (cmd) => order.push(cmd.cmd), sleep: async (ms) => { order.push("sleep" + ms); } }, (i) => { order.push("run:" + i.type); return { ok: true, detail: "ok" }; });
  await executeDesktopAction({ type: "click", id: "b1" }, c, deps);
  assert.deepEqual(order.slice(0, 3), ["point", "sleep700", "run:press"]);
  const second = fakes();
  await executeDesktopAction({ type: "key", combo: "cmd+t" }, second.c, second.deps);
  assert.deepEqual(second.rec.sent, [], "no cursor for a key press");
  assert.deepEqual(second.rec.pill, ["Press cmd+t"]);
});
test("the point command carries the control's rect and its centre", async () => {
  const { rec, deps, c } = fakes();
  await executeDesktopAction({ type: "click", id: "b1" }, c, deps);
  assert.deepEqual(rec.sent[0], { cmd: "point", x: 130, y: 22, text: "", rect: { x: 100, y: 10, w: 60, h: 24 }, keep: true, kind: "control" });
});
test("the result carries a re-read PageContext; an unchanged screen after a click is read once more", async () => {
  const { rec, deps, c } = fakes({ readContext: (() => { let n = 0; return async () => { n++; return n === 1 ? c : { ...c, title: "Changed" }; }; })() });
  const r = await executeDesktopAction({ type: "click", id: "b1" }, c, deps);
  assert.equal(r.context.title, "Changed");
  assert.ok(rec.slept.includes(700) && rec.slept.some((ms) => ms >= 600), "waited for the screen to settle");
});
test("a context that cannot be read after the action (the app quit) still returns an honest result", async () => {
  const { deps, c } = fakes({ readContext: async () => { throw new Error("no window"); } });
  const r = await executeDesktopAction({ type: "quit_app", name: "TextEdit" }, c, deps);
  assert.equal(r.ok, true); assert.deepEqual(r.context.controls, []);
});
test("screenshot and copy: the detail is a count or a path, never the content; the home directory is shortened", async () => {
  const home = process.env.HOME!;
  const s = fakes({}, () => ({ ok: true, detail: `screenshot saved to ${home}/Desktop/Ishara-1.png and copied to the clipboard` }));
  const r1 = await executeDesktopAction({ type: "screenshot", to: "file" }, s.c, s.deps);
  assert.ok(!r1.detail.includes(home)); assert.match(r1.detail, /~\/Desktop\/Ishara-1\.png/);
  const SECRET = "the text I copied";
  const cp = fakes({}, () => ({ ok: true, detail: "copied 17 characters to the clipboard" }));
  const r2 = await executeDesktopAction({ type: "copy", text: SECRET }, cp.c, cp.deps);
  assert.ok(!r2.detail.includes(SECRET));
  assert.ok(!actionInWords({ type: "copy", text: SECRET }).includes(SECRET), "even the pill words say a count, not the text");
});
test("done / ask / fail are not desktop actions: they run nothing", async () => {
  const { rec, deps, c } = fakes();
  assert.equal((await executeDesktopAction({ type: "done", say: "ok" }, c, deps)).ok, true);
  assert.equal(rec.ran.length, 0);
});
test("wait is capped at 3 s", async () => {
  const { rec, deps, c } = fakes();
  await executeDesktopAction({ type: "wait", ms: 99999 }, c, deps);
  assert.equal(rec.slept[0], 3000);
});
test("a Swift failure and a thrown error are reported as failures, never as success", async () => {
  const a = fakes({}, () => ({ ok: false, detail: "could not find \"Save\"" }));
  assert.equal((await executeDesktopAction({ type: "click", id: "b1" }, a.c, a.deps)).ok, false);
  const b = fakes({ run: async () => { throw new Error("boom"); } });
  const r = await executeDesktopAction({ type: "click", id: "b1" }, b.c, b.deps);
  assert.equal(r.ok, false); assert.match(r.detail, /executor error: boom/);
});

// ---------- stop flag ----------
test("the stop flag is checked before anything, and again after the cursor arrives, before the action runs", async () => {
  const a = fakes({ stopped: () => true });
  const r = await executeDesktopAction({ type: "click", id: "b1" }, a.c, a.deps);
  assert.deepEqual([r.ok, r.detail, a.rec.ran.length, a.rec.sent.length], [false, "stopped", 0, 0]);
  let calls = 0;
  const b = fakes({ stopped: () => ++calls > 1 }); // not stopped at the start, stopped by the time the cursor has travelled
  const rb = await executeDesktopAction({ type: "click", id: "b1" }, b.c, b.deps);
  assert.deepEqual([rb.ok, rb.detail, b.rec.ran.length, b.rec.sent.length], [false, "stopped", 0, 1], "the cursor moved, the action did not run");
});
test("requestStop(actId) and requestStopAll stop an executor made before them, not one made after", async () => {
  const c = ctx();
  let ran = 0;
  const mk = (id: string) => desktopExecutorFor(id, { run: async () => { ran++; return { ok: true, detail: "ok" }; }, send: () => {}, readContext: async () => c, front: async () => ({ app: "x", bundleId: "com.apple.TextEdit" }), sleep: async () => {} });
  const a = mk("act-1");
  requestStop("act-1");
  assert.equal((await a({ type: "key", combo: "cmd+t" }, c)).detail, "stopped");
  const b = mk("act-2");
  assert.equal((await b({ type: "key", combo: "cmd+t" }, c)).ok, true);
  await new Promise((r) => setTimeout(r, 3));
  requestStopAll();
  assert.equal((await b({ type: "key", combo: "cmd+t" }, c)).detail, "stopped");
  await new Promise((r) => setTimeout(r, 3));
  assert.equal((await mk("act-3")({ type: "key", combo: "cmd+t" }, c)).ok, true, "a task begun after the stop is not blocked by it");
  assert.equal(ran, 2);
});

// ---------- voice: agent mode ----------
test("agent mode on/off, English", () => {
  for (const t of ["agent mode on", "Agent mode on.", "turn on agent mode", "Turn on agent mode please", "enable agent mode", "ishara, agent mode on", "switch on agent mode", "can you turn on agent mode", "start agent mode"]) assert.equal(agentModeCommand(t), "on", t);
  for (const t of ["agent mode off", "Agent Mode Off.", "turn off agent mode", "disable agent mode", "stop agent mode", "hey agent mode off"]) assert.equal(agentModeCommand(t), "off", t);
  assert.equal(pttAgentModeCommand("agent mode on"), "on", "re-exported from desktop-ptt");
});
test("agent mode on/off, Hinglish", () => {
  for (const t of ["agent mode chalu", "agent mode chalu karo", "Agent mode chalu kar do", "agent mode shuru karo", "agent mode on karo"]) assert.equal(agentModeCommand(t), "on", t);
  for (const t of ["agent mode band karo", "Agent mode band karo.", "agent mode band kar do", "agent mode off karo"]) assert.equal(agentModeCommand(t), "off", t);
});
test("agent mode: questions and chatter are not commands (false positives)", () => {
  for (const t of ["what does agent mode do?", "what does agent mode do", "how do I turn on agent mode", "is agent mode on?", "tell me about agent mode", "agent mode is great", "agent mode", "agent mode on the desktop is risky", "why is agent mode off", "can agent mode click buttons", "agent mode kya hai", "turn on the lights", "agent smith mode on"]) assert.equal(agentModeCommand(t), null, t);
});

// ---------- voice: tasks ----------
test("task sentences: English imperatives", () => {
  for (const t of ["open TextEdit and type hello from Ishara", "Open Safari", "go to the downloads folder", "click the save button", "press enter", "fill in my name", "type hello", "enter my email", "scroll down", "copy this to the clipboard", "play some music", "pause the song", "search for ethglobal", "select the second option", "close this window", "quit TextEdit", "take a screenshot", "can you open settings", "please click the blue button", "screenshot"]) assert.equal(isTaskUtterance(t), true, t);
});
test("task sentences: Hinglish verbs", () => {
  for (const t of ["settings kholo", "naam bharo", "yahan likho hello", "gaana chalao", "wifi band karo", "is window ko band karo", "send button dabao"]) assert.equal(isTaskUtterance(t), true, t);
});
test("task sentences: questions, walk words and explanations are not tasks", () => {
  for (const t of ["what does this button do", "where is the save button?", "how do I open settings", "why did it close", "next", "back", "stop", "explain this window", "is this the send button", "kya yeh button save karta hai?", "open", "what is the type of this field", "agent mode on", "hello", ""]) assert.equal(isTaskUtterance(t), false, JSON.stringify(t));
});

// ---------- voice: approvals ----------
test("approval answers: yes and no, English and Hinglish", () => {
  for (const t of ["yes", "Yes.", "yeah", "yep", "haan", "ok do it", "okay", "do it", "go ahead", "approve", "sure", "theek hai", "kar do"]) assert.equal(approvalAnswer(t), "yes", t);
  for (const t of ["no", "No.", "nope", "nahi", "stop", "cancel", "don't", "no stop", "deny", "mat karo", "rehne do"]) assert.equal(approvalAnswer(t), "no", t);
  for (const t of ["maybe", "what will it send", "yes but change the name", "open settings", "tell me more", ""]) assert.equal(approvalAnswer(t), null, t);
});
test("stop words", () => {
  for (const t of ["stop", "Stop.", "cancel", "ruko", "band karo", "enough"]) assert.equal(isStopWord(t), true, t);
  assert.equal(isStopWord("stop sign"), false);
});

// ---------- the sentence router ----------
const routeDeps = () => {
  const sent: OverlayCmd[] = [], posts: Array<[string, any]> = [], tutor: string[] = [];
  return { sent, posts, tutor, deps: {
    send: (c: OverlayCmd) => sent.push(c),
    post: async (p: string, b: unknown) => { posts.push([p, b]); return { headers: { get: () => null }, body: null }; },
    ask: async (t: string) => { tutor.push(t); },
    front: async () => ({ app: "TextEdit", bundleId: "com.apple.TextEdit" }),
    context: async () => ({ context: ctx(), bundleId: "com.apple.TextEdit" }),
    speak: () => {},
  } };
};
test("a task said to the normal push-to-talk runs without arming first (Harsh, 6 Nov); after 'agent mode off' it gets the hint", async () => {
  const r0 = routeDeps();
  assert.equal(agentState().armed, false);
  assert.equal((await desktopSay("open TextEdit and type hello", r0.deps)).outcome, "task");
  resetAgentState();
  const r = routeDeps();
  await desktopSay("agent mode off", r.deps); r.sent.length = 0;
  const out = await desktopSay("open TextEdit and type hello", r.deps);
  assert.equal(out.outcome, "hint");
  assert.deepEqual(r.sent, [{ cmd: "ask", text: "Turn on Agent mode and I will do that." }]);
  assert.equal(r.posts.length, 0);
});
test("'agent mode on' arms it and tells the overlay; 'agent mode band karo' disarms it; questions still reach the tutor", async () => {
  const r = routeDeps();
  assert.equal((await desktopSay("agent mode on", r.deps)).outcome, "agent-mode");
  assert.equal(agentState().armed, true);
  assert.deepEqual(r.sent.at(-1), { cmd: "agentmode", on: true });
  assert.equal((await desktopSay("what does agent mode do?", r.deps)).outcome, "tutor");
  assert.equal((await desktopSay("where is the save button", r.deps)).outcome, "tutor");
  assert.deepEqual(r.tutor, ["what does agent mode do?", "where is the save button"]);
  await desktopSay("agent mode band karo", r.deps);
  assert.equal(agentState().armed, false);
  assert.deepEqual(r.sent.at(-1), { cmd: "agentmode", on: false });
});
test("armed + a task: POST /act with executor helper, armed true, the desktop context; SSE events become pill commands", async () => {
  const r = routeDeps();
  await desktopSay("agent mode chalu karo", r.deps);
  const frames = `event: thinking\ndata: {"n":1,"actId":"act-abc12345"}\n\nevent: action\ndata: {"n":1,"action":{"type":"open_app","name":"TextEdit"},"risk":"medium","say":"Opening TextEdit","needsApproval":false}\n\nevent: result\ndata: {"n":1,"ok":true,"detail":"x"}\n\nevent: done\ndata: {"say":"All done.","steps":1}\n\n`;
  r.deps.post = async (p: string, b: unknown) => { r.posts.push([p, b]); return { headers: { get: (k: string) => (k === "x-act-id" ? "act-abc12345" : null) }, body: (async function* () { yield frames.slice(0, 40); yield frames.slice(40); })() }; };
  const out: any = await desktopSay("open TextEdit and type hello", r.deps);
  assert.equal(out.outcome, "task"); assert.equal(out.detail.outcome, "done");
  const [path, body] = r.posts[0];
  assert.equal(path, "/act");
  assert.deepEqual([body.executor, body.armed, body.task, body.context.source], ["helper", true, "open TextEdit and type hello", "desktop"]);
  const agentCmds = r.sent.filter((c) => c.cmd === "agent") as any[];
  assert.deepEqual(agentCmds.map((c) => [c.text, c.step]), [["Reading the screen…", 1], ["Thinking…", 1], ["Opening TextEdit", 1], ["All done.", 0]]);
  assert.equal(agentState().running, false);
});
test("a HIGH-risk approval shows the action in words with 'say yes to approve'; 'yes' answers it through /act/approve; 'no' denies", async () => {
  for (const [word, approve] of [["yes", true], ["nahi", false]] as const) {
    resetAgentState();
    const r = routeDeps();
    await desktopSay("agent mode on", r.deps);
    let release!: () => void;
    const gate = new Promise<void>((res) => (release = res));
    const head = `event: thinking\ndata: {"n":1,"actId":"act-abc12345"}\n\nevent: approval\ndata: {"n":1,"action":{"type":"click","id":"b1"},"risk":"high","why":"This looks like a save"}\n\n`;
    r.deps.post = async (p: string, b: unknown) => { r.posts.push([p, b]); return p === "/act" ? { headers: { get: () => "act-abc12345" }, body: (async function* () { yield head; await gate; yield `event: ${approve ? "done" : "stopped"}\ndata: {"say":"x","steps":1}\n\n`; })() } : { headers: { get: () => null }, body: null }; };
    const task = desktopSay("click the save button", r.deps);
    await new Promise((res) => setTimeout(res, 20));
    assert.equal(agentState().approvalPending, true);
    const prompt = r.sent.find((c) => c.cmd === "approval") as any;
    assert.equal(prompt.text, "Click “Save”?"); assert.match(prompt.sub, /Say yes to approve, no to cancel\./);
    assert.equal((await desktopSay("maybe later", r.deps)).outcome, "unclear-approval");
    assert.equal(agentState().approvalPending, true, "an unclear answer leaves it open");
    assert.equal((await desktopSay(word, r.deps)).outcome, "approval");
    assert.deepEqual(r.posts.find(([p]) => p === "/act/approve"), ["/act/approve", { actId: "act-abc12345", n: 1, approve }]);
    assert.equal(agentState().approvalPending, false);
    release(); await task;
  }
});
test("'yes' with no approval waiting is not an approval: it goes to the tutor", async () => {
  const r = routeDeps();
  assert.equal((await desktopSay("yes", r.deps)).outcome, "tutor");
  assert.equal(await answerApproval(true, r.deps), false);
});
test("the stop word and the stop tap end a running task: /act/stop, the pill says Stopped", async () => {
  const r = routeDeps();
  await desktopSay("agent mode on", r.deps);
  let release!: () => void;
  const gate = new Promise<void>((res) => (release = res));
  r.deps.post = async (p: string, b: unknown) => { r.posts.push([p, b]); return p === "/act" ? { headers: { get: () => "act-abc12345" }, body: (async function* () { yield `event: thinking\ndata: {"n":1}\n\n`; await gate; })() } : { headers: { get: () => null }, body: null }; };
  const task = desktopSay("scroll down", r.deps);
  await new Promise((res) => setTimeout(res, 20));
  assert.equal(agentState().running, true);
  const { stopTask } = await import("../src/desktop-act.ts");
  assert.equal(stopTask(r.deps.send, true, r.deps.post as any), true);
  assert.deepEqual(r.posts.find(([p]) => p === "/act/stop"), ["/act/stop", { actId: "act-abc12345" }]);
  assert.deepEqual(r.sent.at(-1), { cmd: "agent", text: "Stopped.", step: 0, risk: "low" });
  release(); await task;
  assert.equal(stopTask(r.deps.send, true, r.deps.post as any), false, "nothing running: a tap is just a tap");
});
test("a browser in front: the desktop task path says use the extension and posts nothing", async () => {
  const r = routeDeps();
  await desktopSay("agent mode on", r.deps);
  const out: any = await desktopSay("open a new tab", { ...r.deps, front: async () => ({ app: "Chrome", bundleId: "com.google.Chrome" }) });
  assert.equal(out.detail.outcome, "browser");
  assert.equal(r.posts.length, 0);
});

// ---------- overlay mapping ----------
test("SSE events -> overlay commands", () => {
  const t = { ctx: ctx() };
  assert.deepEqual(actEventToCmds({ event: "thinking", data: { n: 2 } }, t), [{ cmd: "agent", text: "Thinking…", step: 2, risk: "low" }]);
  assert.deepEqual(actEventToCmds({ event: "action", data: { n: 3, action: { type: "click", id: "b1" }, risk: "medium", say: "Pressing Save" } }, t), [{ cmd: "agent", text: "Pressing Save", step: 3, risk: "medium" }]);
  assert.deepEqual(actEventToCmds({ event: "action", data: { n: 3, action: { type: "click", id: "b1" }, risk: "low", say: "" } }, t), [{ cmd: "agent", text: "Click “Save”", step: 3, risk: "low" }], "no say: the action in words");
  assert.deepEqual(actEventToCmds({ event: "approval", data: { n: 4, action: { type: "quit_app", name: "TextEdit" }, risk: "high", why: "Quitting an app" } }, t), [{ cmd: "approval", text: "Quit TextEdit?", sub: "Say yes to approve, no to cancel." }]);
  assert.deepEqual(actEventToCmds({ event: "result", data: { n: 1, ok: true, detail: "x" } }, t), []);
  assert.equal((actEventToCmds({ event: "result", data: { n: 1, ok: false, detail: "no such button" } }, t)[0] as any).text, "That did not work: no such button");
  assert.deepEqual(actEventToCmds({ event: "stopped", data: {} }, t), [{ cmd: "agent", text: "Stopped.", step: 0, risk: "low" }]);
  assert.deepEqual(actEventToCmds({ event: "refused", data: { cause: "unavailable", say: "0G is not reachable." } }, t), [{ cmd: "stop", text: "0G is not reachable." }]);
  assert.deepEqual(actEventToCmds({ event: "wat", data: {} }, t), []);
});
test("the overlay's button lines: approve, deny and stop", async () => {
  const r = routeDeps();
  assert.equal(onOverlayAgentLine('{"ev":"walk","cmd":"next"}'), false, "walk buttons are not ours");
  assert.equal(onOverlayAgentLine("garbage"), false);
  assert.equal(onOverlayAgentLine('{"ev":"approve","approve":true}'), true);
  assert.equal(onOverlayAgentLine('{"ev":"agent","cmd":"stop"}'), true);
  void r;
});
test("the SSE parser handles frames split across chunks and ignores broken ones", () => {
  const got: any[] = [];
  const p = createSseParser((e) => got.push(e));
  p('event: a\ndata: {"n"'); p(':1}\n\n: ping\n\nevent: b\ndata: not json\n\nevent: c\ndata: {}\n\n');
  assert.deepEqual(got.map((e) => e.event), ["a", "c"]);
});

// ---------- the Swift and overlay sources keep their promises ----------
test("ishara-act.swift refuses secure fields and browsers, never force-terminates, and is built by npm run desktop:build", () => {
  const swift = readFileSync(new URL("../../desktop/ishara-act.swift", import.meta.url), "utf8");
  assert.match(swift, /AXSecureTextField/); assert.match(swift, /fail\("secret field"\)/);
  assert.match(swift, /use the browser extension/);
  assert.doesNotMatch(swift, /forceTerminate/);
  assert.match(swift, /only http\(s\) URLs/);
  assert.match(readFileSync(new URL("../../package.json", import.meta.url), "utf8"), /ishara-act\.swift -o desktop\/ishara-act/);
  assert.match(readFileSync(new URL("../../desktop/.gitignore", import.meta.url), "utf8"), /ishara-act/);
});
test("the overlay implements the agent commands and prints approve / stop lines", () => {
  const sw = readFileSync(new URL("../../desktop/ishara-overlay.swift", import.meta.url), "utf8");
  for (const c of ['case "agentmode"', 'case "agent"', 'case "approval"', '\\"ev\\":\\"approve\\"', '\\"ev\\":\\"agent\\"']) assert.ok(sw.includes(c), c);
});
test("ishara-ax context emits a selector per control", () => {
  const sw = readFileSync(new URL("../../desktop/ishara-ax.swift", import.meta.url), "utf8");
  assert.match(sw, /o\["selector"\]/);
});
test("selectorsFromRaw pairs raw selectors with built control ids, and drops malformed controls consistently", () => {
  const rr = { ...raw, controls: [{ label: "bad", role: "button" }, ...raw.controls] }; // first one has no rect: skipped by buildContext too
  const c = buildContext(rr, { book: newIdBook() });
  const m = selectorsFromRaw(rr, c);
  assert.equal(m.get(c.controls[0].id)?.index, 0);
  assert.equal(m.get(c.controls[2].id)?.index, 1);
  assert.equal(m.get(c.controls[4].id)?.secure, true);
});
test("audit 5: pointing questions and the walk-through are never orders", async () => {
  const A = (await import("../../extension/act.js")).default ?? (globalThis as any).Ishara.act;
  for (const q of ["find the save button", "can you find the license field", "start the walkthrough", "where do I click", "walk me through this page", "read this page to me"]) {
    assert.equal(isTaskUtterance(q), false, "desktop: " + q); assert.equal(A.isTask(q), false, "browser: " + q);
  }
  for (const q of ["Can you open Telegram?", "Opening slack", "fill the name with Harsh", "copy the address", "open the settings page"]) {
    assert.equal(isTaskUtterance(q), true, "desktop: " + q); assert.equal(A.isTask(q), true, "browser: " + q);
  }
});

test("keys are never pressed in a different app than the screen was read from (6 Nov: Cmd+W landed in the Terminal after Calculator quit)", async () => {
  const c = ctx(); let ran = 0;
  const mk = (frontId: string) => desktopExecutorFor("act-front-" + frontId, { run: async () => { ran++; return { ok: true, detail: "ok" }; }, send: () => {}, readContext: async () => c, front: async () => ({ app: "x", bundleId: frontId }), sleep: async () => {}, bundleId: () => "com.apple.calculator" });
  const away = await mk("com.apple.Terminal")({ type: "key", combo: "cmd+w" }, c);
  assert.equal(away.ok, false); assert.match(away.detail, /front app changed/); assert.equal(ran, 0);
  const tabAway = await mk("com.apple.Terminal2")({ type: "tab", op: "close" }, c);
  assert.equal(tabAway.ok, false); assert.equal(ran, 0);
  const same = await mk("com.apple.calculator")({ type: "key", combo: "cmd+w" }, c);
  assert.equal(same.ok, true); assert.equal(ran, 1);
});
