// The push-to-talk pipeline with fakes: no daemon, no mic, no whisper, no 0G.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createPtt, meter, MIN_SAMPLES, type PttDeps } from "../src/desktop-ptt.ts";
import type { OverlayCmd } from "../src/desktop.ts";

const tick = () => new Promise((r) => setImmediate(r));
const up = (o: Record<string, unknown> = {}) => JSON.stringify({ ev: "up", samples: 32000, maxRms: 0.05, wavBase64: Buffer.from("RIFFx").toString("base64"), ...o });

function rig(over: Partial<PttDeps> = {}) {
  const sent: OverlayCmd[] = [], asked: string[] = [], transcribed: Uint8Array[] = [];
  let clock = 0; const timers: { fn: () => void; ms: number }[] = []; let spawns = 0, killed = 0;
  let line!: (l: string) => void, exit!: (c: number | null) => void;
  const ptt = createPtt({
    send: (c) => sent.push(c),
    transcribe: async (w) => { transcribed.push(w); return { text: "Where is the search box?" }; },
    ask: async (q) => { asked.push(q); },
    spawnDaemon: (l, e) => { spawns++; line = l; exit = e; return { kill: () => { killed++; } }; },
    now: () => clock,
    setTimer: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    clearTimer: () => {},
    ...over,
  });
  ptt.start();
  return { ptt, sent, asked, transcribed, timers, line: (l: string) => line(l), exit: (c: number | null) => exit(c), advance: (ms: number) => { clock += ms; }, spawns: () => spawns, killed: () => killed };
}

test("down shows the listening bubble", () => {
  const r = rig(); r.line('{"ev":"down"}');
  assert.deepEqual(r.sent, [{ cmd: "think", text: "Listening… release to send" }]);
});
test("meter blocks follow sqrt(rms)*28, capped at 10", () => {
  assert.equal(meter(0), "Listening…\n▯▯▯▯▯▯▯▯▯▯");
  assert.equal(meter(0.0123), "Listening…\n▮▮▮▯▯▯▯▯▯▯");
  assert.equal(meter(1), "Listening…\n▮▮▮▮▮▮▮▮▮▮");
});
test("level updates are throttled and unchanged bars are not redrawn", () => {
  const r = rig(); r.line('{"ev":"down"}'); r.sent.length = 0;
  r.line('{"ev":"level","rms":0.0123}');          // first: drawn
  r.advance(120); r.line('{"ev":"level","rms":0.04}'); // 120 ms later: throttled
  r.advance(40); r.line('{"ev":"level","rms":0.04}');  // 160 ms: different bar, drawn
  r.advance(200); r.line('{"ev":"level","rms":0.04}'); // same bar: skipped
  assert.equal(r.sent.length, 2);
  assert.match((r.sent[1] as any).text, /▮▮▮▮▮▮/);
});
test("too short is refused without transcribing", async () => {
  const r = rig(); r.line(up({ samples: MIN_SAMPLES - 1 })); await tick();
  assert.equal(r.sent.at(-1)!.cmd, "stop"); assert.match((r.sent.at(-1) as any).text, /Too short/);
  assert.equal(r.transcribed.length, 0);
});
test("silence is refused with the browser's wording", async () => {
  const r = rig(); r.line(up({ maxRms: 0.004 })); await tick();
  assert.match((r.sent.at(-1) as any).text, /I could not hear any sound from the microphone/);
  assert.equal(r.transcribed.length, 0); assert.equal(r.asked.length, 0);
});
test("a transcript the helper guard rejected (text \"\") never reaches 0G", async () => {
  // The guard itself (transcript-guard.ts) runs inside the real transcribe; its rules are tested in voice-guard.test.ts.
  const r = rig({ transcribe: async () => ({ text: "" }) }); r.line(up()); await tick();
  assert.match((r.sent.at(-1) as any).text, /I heard nothing/);
  assert.equal(r.asked.length, 0);
});
test("short valid answers like ok are asked, not dropped client-side", async () => {
  const r = rig({ transcribe: async () => ({ text: "ok" }) }); r.line(up()); await tick();
  assert.deepEqual(r.asked, ["ok"]);
});
test("a good question shows Transcribing, then the transcript, then asks", async () => {
  const r = rig(); r.line(up()); await tick();
  assert.deepEqual(r.sent.map((c: any) => c.text), ["Transcribing…", "I heard: “Where is the search box?” …thinking"]);
  assert.deepEqual(r.asked, ["Where is the search box?"]);
  assert.equal(Buffer.from(r.transcribed[0]).toString(), "RIFFx"); // the base64 WAV was decoded
});
test("whisper failure is shown, not faked, and 0G is not called", async () => {
  const r = rig({ transcribe: async () => { throw new Error("whisper unavailable"); } }); r.line(up()); await tick();
  assert.deepEqual(r.sent.at(-1), { cmd: "stop", text: "I could not transcribe that.", sub: "whisper unavailable" });
  assert.equal(r.asked.length, 0);
});
test("an ask failure becomes a bubble", async () => {
  const r = rig({ ask: async () => { throw new Error("Accessibility permission is missing"); } }); r.line(up()); await tick();
  assert.match((r.sent.at(-1) as any).sub, /Accessibility/);
});
test("a permission error is shown once and the daemon is not restarted", () => {
  const r = rig();
  r.line('{"ev":"error","code":"input-monitoring","message":"Input Monitoring permission is missing"}');
  r.exit(2);
  assert.equal(r.sent.filter((c) => c.cmd === "stop").length, 1);
  assert.equal(r.timers.length, 0); assert.equal(r.spawns(), 1);
  assert.match(r.ptt.status().lastError!, /Input Monitoring/); assert.equal(r.ptt.status().running, false);
});
test("a crashed daemon restarts with growing backoff", () => {
  const r = rig();
  r.exit(1); assert.equal(r.timers[0].ms, 1000); r.timers[0].fn();
  r.exit(1); assert.equal(r.timers[1].ms, 2000); r.timers[1].fn();
  assert.equal(r.spawns(), 3);
});
test("stop kills the daemon and cancels a pending restart", () => {
  const r = rig(); r.line('{"ev":"ready","chord":"ctrl+opt+space"}');
  assert.equal(r.ptt.status().running, true);
  r.ptt.stop(); assert.equal(r.killed(), 1);
  r.exit(0); assert.equal(r.timers.length, 0); assert.equal(r.ptt.status().running, false);
});

test("a second take while the first is still answering is refused, not raced", async () => {
  let release!: () => void;
  const r = rig({ ask: async (q) => { await new Promise<void>((res) => (release = res)); } });
  r.line(up()); await tick(); await tick();
  r.line(up()); await tick();
  assert.match((r.sent.at(-1) as any).text, /Still answering/);
  release(); await tick(); await tick();
  r.line(up()); await tick(); await tick();
  assert.match((r.sent.at(-1) as any).text, /I heard/, "accepted again once the first answer is done");
});
