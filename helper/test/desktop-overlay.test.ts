// The overlay command protocol (docs/UI-PILL.md, docs/DESKTOP.md): every tutor event and push-to-talk event -> commands,
// the pill's button lines -> walk turns, and that the old commands still exist in the Swift overlay. All with fakes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  eventToCmds, eventToOverlay, createPttMapper, parseOverlayLine, createWalkButtons, WALK_UTTERANCE, buildContext, newIdBook,
  decisionToOverlay, desktopAsk, type MapState, type OverlayCmd, type SpeechSeam,
} from "../src/desktop.ts";
import { parseWalkCommand } from "../src/router.ts";

const ctx = () => buildContext({
  app: "Settings", bundleId: "com.x", title: "Main", viewport: { w: 800, h: 600 }, origin: { x: 0, y: 0 },
  controls: [{ id: "b0", label: "Wi-Fi", role: "button", rect: { x: 100, y: 200, w: 80, h: 30 } }],
  blocks: [
    { kind: "p", text: "Connect to a network to get online.", inView: true, rect: { x: 100, y: 300, w: 400, h: 40 } },
    { kind: "p", text: "Hidden paragraph far below", inView: false },
  ],
}, { book: newIdBook() });
const st = (): MapState => ({ ctx: ctx(), heard: "where is wifi", said: 0 });
const ev = (event: string, data: any) => ({ event, data });

test("thinking: the pill shows what was heard; a non-guide mode also hides a stale step chip", () => {
  assert.deepEqual(eventToCmds(ev("thinking", { mode: "explain" }), st()), [
    { cmd: "state", state: "thinking", text: "I heard: “where is wifi”" }, { cmd: "steps", n: 0, m: 0 }]);
  assert.deepEqual(eventToCmds(ev("thinking", { mode: "guide" }), st()), [{ cmd: "state", state: "thinking", text: "I heard: “where is wifi”" }],
    "guide (and every walk command, which says guide) keeps the chip");
  assert.deepEqual(eventToOverlay(ev("thinking", { mode: "guide" }), { ...st(), heard: "" }), { cmd: "state", state: "thinking", text: "Thinking…" });
});
test("say: queued for the pill; blank sentences draw nothing", () => {
  const s = st();
  assert.deepEqual(eventToCmds(ev("say", { seq: 1, text: "Hello." }), s), [{ cmd: "say", text: "Hello.", append: false }]);
  assert.deepEqual(eventToCmds(ev("say", { seq: 2, text: "More." }), s), [{ cmd: "say", text: "More.", append: true }]);
  assert.deepEqual(eventToCmds(ev("say", { seq: 3, text: "  " }), s), []);
});
test("speaking: the sentence being played, and seq null = the voice went quiet", () => {
  assert.deepEqual(eventToCmds(ev("speaking", { seq: 2, text: "Now this." }), st()), [{ cmd: "speaking", text: "Now this." }]);
  assert.deepEqual(eventToCmds(ev("speaking", { seq: null }), st()), [{ cmd: "speaking", text: "" }]);
  assert.deepEqual(eventToCmds(ev("speaking", { seq: 0, text: "Zero is a real seq." }), st()), [{ cmd: "speaking", text: "Zero is a real seq." }]);
});
test("point: control = boundary, block = highlighter (kind rides along); unconfirmed or unknown draws nothing", () => {
  const s = st();
  const c = eventToCmds(ev("point", { targetId: "b0", kind: "control", status: "confirmed" }), s)[0] as any;
  assert.deepEqual(c, { cmd: "point", x: 140, y: 215, text: "", rect: { x: 100, y: 200, w: 80, h: 30 }, keep: true, kind: "control" });
  const p = s.ctx.blocks.find((b) => b.inView)!;
  const b = eventToCmds(ev("point", { targetId: p.id, kind: "block", status: "confirmed" }), s)[0] as any;
  assert.equal(b.kind, "block"); assert.deepEqual(b.rect, { x: 100, y: 300, w: 400, h: 40 });
  for (const status of ["rejected", "suppressed"]) assert.deepEqual(eventToCmds(ev("point", { targetId: "b0", kind: "control", status }), s), []);
  assert.deepEqual(eventToCmds(ev("point", { targetId: "b9", kind: "control", status: "confirmed" }), s), []);
  assert.deepEqual(eventToCmds(ev("point", { targetId: s.ctx.blocks.find((x) => !x.inView)!.id, kind: "block", status: "confirmed" }), s), []);
});
test("step -> steps chip; refused -> the red pill; done -> done; unknown -> nothing", () => {
  assert.deepEqual(eventToCmds(ev("step", { n: 2, m: 6, say: "x" }), st()), [{ cmd: "steps", n: 2, m: 6 }]);
  assert.deepEqual(eventToCmds(ev("step", { m: 6 }), st()), []);
  assert.deepEqual(eventToCmds(ev("refused", { cause: "timeout", say: "0G took too long." }), st()), [{ cmd: "stop", text: "0G took too long." }]);
  assert.deepEqual(eventToCmds(ev("done", { outcome: "answered" }), st()), [{ cmd: "done" }]);
  assert.deepEqual(eventToCmds(ev("whatever", {}), st()), []);
});

test("push-to-talk: down = preparing; `live` = listening; until `live` exists the first level switches", () => {
  const m = createPttMapper();
  assert.deepEqual(m.map({ ev: "down" }), [{ cmd: "state", state: "preparing" }]);
  assert.deepEqual(m.map({ ev: "level", rms: 0.02 }), [{ cmd: "state", state: "listening" }, { cmd: "level", rms: 0.02 }]);
  assert.deepEqual(m.map({ ev: "level", rms: 0.03 }), [{ cmd: "level", rms: 0.03 }], "listening is announced once");
  const m2 = createPttMapper();
  m2.map({ ev: "down" });
  assert.deepEqual(m2.map({ ev: "live" }), [{ cmd: "state", state: "listening" }]);
  assert.deepEqual(m2.map({ ev: "level", rms: 0.01 }), [{ cmd: "level", rms: 0.01 }]);
  assert.deepEqual(m2.map({ ev: "down" }), [{ cmd: "state", state: "preparing" }], "a new hold starts over");
  assert.deepEqual(m2.map({ ev: "level", rms: -1 }), [{ cmd: "state", state: "listening" }, { cmd: "level", rms: 0 }]);
  assert.deepEqual(m2.map({ ev: "up" }), []);
});

test("overlay button lines: only a well-formed walk line counts", () => {
  for (const c of ["next", "back", "repeat", "stop"]) assert.equal(parseOverlayLine(JSON.stringify({ ev: "walk", cmd: c })), c);
  for (const bad of ['{"ready":true}', "", "not json", '{"ev":"walk","cmd":"where"}', '{"ev":"walk"}', '{"ev":"other","cmd":"next"}', "null", "[]"])
    assert.equal(parseOverlayLine(bad), null, bad);
});
test("every button word is a walk command the router already knows (the voice path is reused, not a new one)", () => {
  for (const [btn, word] of Object.entries(WALK_UTTERANCE)) assert.equal(parseWalkCommand(word), btn);
});
test("a button press runs desktopAsk's walk turn with the spoken word; a newer press cuts the older one off", async () => {
  const asked: string[] = []; const signals: AbortSignal[] = [];
  const w = createWalkButtons(async (u, s) => { asked.push(u); signals.push(s); });
  assert.equal(w.onLine('{"ready":true}'), null);
  assert.equal(w.onLine('{"ev":"walk","cmd":"next"}'), "next");
  assert.equal(w.onLine('{"ev":"walk","cmd":"back"}'), "back");
  assert.deepEqual(asked, ["next", "back"]);
  assert.equal(signals[0].aborted, true); assert.equal(signals[1].aborted, false);
  const bad = createWalkButtons(async () => { throw new Error("boom"); });
  assert.equal(bad.onLine('{"ev":"walk","cmd":"stop"}'), "stop"); // a failing turn never throws out of the stdout handler
  await new Promise((r) => setImmediate(r));
});
test("a button turn is a normal desktopAsk turn: same walk key, 'stop' also hides the chip", async () => {
  const sent: OverlayCmd[] = []; const reqs: any[] = [];
  const speech: SpeechSeam = { start() {}, say() {}, end() {} };
  await desktopAsk(WALK_UTTERANCE.stop, {
    front: async () => ({ app: "Settings", bundleId: "com.apple.systempreferences" }),
    context: async () => ({ context: ctx(), bundleId: "com.apple.systempreferences" }),
    turn: async function* (r: any) { reqs.push(r); yield ev("thinking", { mode: "guide" }); yield ev("say", { seq: 1, text: "Okay, stopped." }); yield ev("done", { mode: "guide", outcome: "answered" }); },
    send: (c) => sent.push(c), speech,
  });
  assert.equal(reqs[0].tabId, "desktop:com.apple.systempreferences"); assert.equal(reqs[0].question, "stop");
  assert.deepEqual(sent.filter((c) => c.cmd === "steps"), [{ cmd: "steps", n: 0, m: 0 }]);
});

test("desktopAsk subscribes to the speaker: playback starts become speaking commands, and it unsubscribes when the voice is quiet", async () => {
  const sent: OverlayCmd[] = []; let cb!: (t: string | null) => void; let off = 0; const log: string[] = [];
  const speech: SpeechSeam = { start: () => log.push("start"), say() {}, end() {}, onPlay: (f) => { cb = f; log.push("sub"); return () => { off++; }; } };
  await desktopAsk("q", {
    front: async () => ({ app: "S", bundleId: "com.x" }), context: async () => ({ context: ctx(), bundleId: "com.x" }),
    turn: async function* () { yield ev("done", { mode: "explain", outcome: "answered" }); }, send: (c) => sent.push(c), speech,
  });
  assert.deepEqual(log, ["start", "sub"], "subscribe after start(): the interrupt must not reach this turn");
  cb("First sentence."); cb(null);
  assert.deepEqual(sent.filter((c) => c.cmd === "speaking"), [{ cmd: "speaking", text: "First sentence." }, { cmd: "speaking", text: "" }]);
  assert.equal(off, 1);
});

test("old commands still produced by the pointing-only path", () => {
  const outline = { url: "app://X", viewport: { w: 1, h: 1 }, elements: [{ id: "b0", label: "Save", role: "button", rect: { x: 10, y: 20, w: 30, h: 40 } }], text: "" };
  const d = (o: any) => ({ outcome: "ask", say: "hi", reason: "", requestIds: {}, ms: { total: 1 }, ...o });
  assert.deepEqual(decisionToOverlay(d({ outcome: "point", targetId: "b0", say: "Here." }) as any, outline), { cmd: "point", x: 25, y: 40, text: "Here.", rect: { x: 10, y: 20, w: 30, h: 40 } });
  assert.equal(decisionToOverlay(d({ outcome: "safe_stop" }) as any, outline).cmd, "stop");
});
test("the Swift overlay still understands every old command and every new one", () => {
  const src = readFileSync(new URL("../../desktop/ishara-overlay.swift", import.meta.url), "utf8");
  for (const c of ["point", "think", "ask", "stop", "clear", "say", "step", "done", "state", "level", "speaking", "steps"])
    assert.match(src, new RegExp(`case ([^\\n]*)"${c}"`), `case "${c}" is handled`);
  for (const s of ["preparing", "listening", "thinking", "speaking", "refused"]) assert.ok(src.includes(`case "${s}"`), `state ${s}`);
  assert.match(src, /"ev":"walk"/, "buttons print walk lines");
  assert.match(src, /ignoresMouseEvents = true/, "the big window stays click-through");
});
