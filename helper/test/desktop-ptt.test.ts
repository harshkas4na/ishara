// The push-to-talk pipeline with fakes: no daemon, no mic, no whisper, no 0G.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createPtt, MIN_SAMPLES, FEEDBACK_AFTER_MS, type PttDeps } from "../src/desktop-ptt.ts";
import type { OverlayCmd } from "../src/desktop.ts";

const tick = () => new Promise((r) => setImmediate(r));
const up = (o: Record<string, unknown> = {}) => JSON.stringify({ ev: "up", samples: 32000, maxRms: 0.05, wavBase64: Buffer.from("RIFFx").toString("base64"), ...o });

function rig(over: Partial<PttDeps> = {}) {
  const sent: OverlayCmd[] = [], asked: string[] = [], transcribed: Uint8Array[] = [];
  let clock = 0; const timers: { fn: () => void; ms: number; off?: boolean }[] = []; let spawns = 0, killed = 0, ticks = 0;
  let line!: (l: string) => void, exit!: (c: number | null) => void;
  const ptt = createPtt({
    send: (c) => sent.push(c),
    transcribe: async (w) => { transcribed.push(w); return { text: "Where is the search box?" }; },
    ask: async (q) => { asked.push(q); },
    front: async () => ({ app: "Notes", bundleId: "com.apple.Notes" }),
    spawnDaemon: (l, e) => { spawns++; line = l; exit = e; return { kill: () => { killed++; } }; },
    now: () => clock,
    tick: () => { ticks++; },
    setTimer: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    clearTimer: (t) => { const x = timers[(t as number) - 1]; if (x) x.off = true; },
    ...over,
  });
  ptt.start();
  return { ptt, sent, asked, transcribed, timers, line: (l: string) => line(l), exit: (c: number | null) => exit(c), advance: (ms: number) => { clock += ms; }, spawns: () => spawns, killed: () => killed, ticks: () => ticks,
    // fire the pending feedback debounce (the only non-restart timer a take sets)
    feedback: async () => { for (const t of timers) if (!t.off && t.ms === FEEDBACK_AFTER_MS) { t.off = true; t.fn(); } await tick(); } };
}

test("down alone shows nothing: a tap or an Option keystroke must not flash a pill", async () => {
  const r = rig(); r.line('{"ev":"down"}'); await tick();
  assert.deepEqual(r.sent, []);
});
test("still not live after the debounce: PREPARING; `live` then switches to LISTENING with one tick", async () => {
  const r = rig(); r.line('{"ev":"down"}'); await r.feedback();
  assert.deepEqual(r.sent, [{ cmd: "state", state: "preparing" }]);
  r.line('{"ev":"live","ms":140}'); await tick();
  assert.deepEqual(r.sent.slice(1), [{ cmd: "state", state: "listening" }]);
  assert.equal(r.ticks(), 1);
  r.line('{"ev":"live","ms":150}'); await tick();
  assert.equal(r.ticks(), 1, "one tick per take");
});
test("warm path: live arrives before the debounce, so the pill goes straight to LISTENING (never PREPARING)", async () => {
  const r = rig(); r.line('{"ev":"down"}'); r.line('{"ev":"live","ms":12}'); await tick();
  assert.deepEqual(r.sent, [], "nothing until the debounce, so a 50 ms tap shows nothing");
  await r.feedback();
  assert.deepEqual(r.sent, [{ cmd: "state", state: "listening" }]); assert.equal(r.ticks(), 1);
});
test("levels reach the pill only once it says LISTENING, and are throttled by time", async () => {
  const r = rig(); r.line('{"ev":"down"}'); await r.feedback();
  r.line('{"ev":"level","rms":0.01}'); // PREPARING: no bars yet
  assert.deepEqual(r.sent, [{ cmd: "state", state: "preparing" }]);
  r.line('{"ev":"live"}'); await tick(); r.sent.length = 0;
  r.line('{"ev":"level","rms":0.0123}');
  r.advance(120); r.line('{"ev":"level","rms":0.04}');  // throttled
  r.advance(40); r.line('{"ev":"level","rms":0.04}');   // drawn
  assert.deepEqual(r.sent, [{ cmd: "level", rms: 0.0123 }, { cmd: "level", rms: 0.04 }]);
});
test("cancel (a tap or typing) discards: pill removed if it was shown, nothing transcribed, no tick if cancelled early", async () => {
  const r = rig(); r.line('{"ev":"down"}'); await r.feedback();
  r.line('{"ev":"cancel"}'); await tick();
  assert.deepEqual(r.sent.at(-1), { cmd: "state", state: "idle" });
  assert.equal(r.transcribed.length, 0); assert.deepEqual(r.asked, []); assert.equal(r.ticks(), 0);
  const q = rig(); q.line('{"ev":"down"}'); q.line('{"ev":"live"}'); q.line('{"ev":"cancel"}'); await q.feedback();
  assert.deepEqual(q.sent, [], "cancelled inside the debounce: nothing ever shown, no tick");
  assert.equal(q.ticks(), 0);
});
test("too short is refused without transcribing", async () => {
  const r = rig(); r.line(up({ samples: MIN_SAMPLES - 1 })); await tick();
  assert.equal(r.sent.at(-1)!.cmd, "stop"); assert.match((r.sent.at(-1) as any).text, /Too short/);
  assert.equal(r.transcribed.length, 0);
});
test("silence is refused with the browser's wording", async () => {
  const r = rig(); r.line(up({ maxRms: 0.002 })); await tick(); // below the desktop floor (0.003); room noise measured 0.0006
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

test("a new key-down cuts off the running turn and the old take never answers late", async () => {
  let signal!: AbortSignal; let release!: () => void;
  const r = rig({ ask: async (q, sig) => { signal = sig; await new Promise<void>((res) => (release = res)); } });
  r.line(up()); await tick(); await tick();
  assert.equal(signal.aborted, false);
  r.line('{"ev":"down"}');                              // the user presses again while it is answering
  assert.equal(signal.aborted, true, "the turn is aborted, not just its voice");
  release(); await tick(); await tick();
  r.line(up()); await tick(); await tick();
  assert.match((r.sent.at(-1) as any).text, /I heard/, "the next take is accepted");
});
test("a take that was still transcribing when the key went down again is dropped", async () => {
  let finish!: () => void;
  const r = rig({ transcribe: async () => { await new Promise<void>((res) => (finish = res)); return { text: "old question" }; } });
  r.line(up()); await tick();
  r.line('{"ev":"down"}');
  finish(); await tick(); await tick();
  assert.deepEqual(r.asked, [], "the stale transcript is not asked");
});

// ---- the new key: events as the daemon emits them (the key logic itself is exercised with synthetic CGEvents) ----
test("a 200 ms tap makes the daemon print nothing, so nothing happens at all", async () => {
  const r = rig(); r.line('{"ev":"ready","chord":"rightoption","holdMs":350}'); await tick();
  assert.deepEqual(r.sent, []); assert.deepEqual(r.asked, []); assert.equal(r.transcribed.length, 0);
  assert.equal(r.ptt.status().chord, "rightoption"); assert.equal(r.ptt.status().running, true);
});
test("a 400 ms hold: down at the 350 ms mark, levels, up with audio, then the question is asked", async () => {
  const r = rig(); r.line('{"ev":"ready","chord":"rightoption","holdMs":350}');
  r.line('{"ev":"down"}'); r.line('{"ev":"live","ms":120}'); r.line('{"ev":"confirmed"}'); await r.feedback();
  assert.deepEqual(r.sent, [{ cmd: "state", state: "listening" }]);
  r.line('{"ev":"level","rms":0.02}');
  r.line(up({ samples: 0.4 * 16000 })); await tick(); await tick();
  assert.deepEqual(r.asked, ["Where is the search box?"]);
});
const brave = { front: async () => ({ app: "Brave Browser", bundleId: "com.brave.Browser" }) };
test("in a browser the take is ignored: the hint appears only on a confirmed hold, nothing transcribed or asked", async () => {
  const r = rig(brave);
  r.line('{"ev":"down"}'); r.line('{"ev":"live","ms":30}'); await r.feedback();
  assert.deepEqual(r.sent, [], "no pill, no hint, no tick before the hold is confirmed");
  r.line('{"ev":"confirmed"}'); await tick();
  assert.deepEqual(r.sent, [{ cmd: "ask", text: "In the browser, use Option+Space" }]);
  r.sent.length = 0;
  r.line('{"ev":"level","rms":0.05}'); r.advance(500); r.line('{"ev":"level","rms":0.01}');
  r.line(up()); await tick(); await tick();
  assert.deepEqual(r.sent, [], "the level meter and the transcription bubbles stay off");
  assert.equal(r.transcribed.length, 0); assert.deepEqual(r.asked, []); assert.equal(r.ticks(), 0);
});
test("a Right-Option tap, or Right Option + Space, in a browser: the daemon cancels, nothing at all happens", async () => {
  // Option+Space typed with the RIGHT Option is a key-down inside the hold: the daemon emits cancel, never confirmed.
  const r = rig(brave);
  r.line('{"ev":"down"}'); r.line('{"ev":"live","ms":30}'); r.line('{"ev":"cancel"}'); await r.feedback();
  assert.deepEqual(r.sent, []); assert.equal(r.ticks(), 0); assert.equal(r.transcribed.length, 0); assert.deepEqual(r.asked, []);
});
test("in a browser a key-down never cuts the extension's voice (no interrupt, no turn abort)", async () => {
  // interrupt() is the speech module's global stop: calling it for a browser-front key-down would be the stray
  // /speech/stop the extension's answer does not deserve. The front check runs first; only a non-browser app interrupts.
  const calls: string[] = [];
  const r = rig({ ...brave, interrupt: () => calls.push("interrupt") } as any);
  r.line('{"ev":"down"}'); await tick(); await tick();
  assert.deepEqual(calls, []);
  const n = rig({ interrupt: () => calls.push("interrupt") } as any);
  n.line('{"ev":"down"}'); await tick(); await tick();
  assert.deepEqual(calls, ["interrupt"]);
});
test("a runtime microphone error (fatal:false) is shown but never stops the daemon being restarted", () => {
  const r = rig();
  r.line('{"ev":"error","code":"microphone","fatal":false,"message":"Microphone failed: no usable microphone input"}');
  assert.equal(r.sent.filter((c) => c.cmd === "stop").length, 1);
  assert.match(r.ptt.status().lastError!, /no usable microphone/);
  r.exit(1);                                            // a later crash still earns a restart
  assert.equal(r.timers.length, 1); assert.equal(r.timers[0].ms, 1000);
});

// Audit 3: a replaced daemon's late exit must not clear the new handle and launch a second daemon (two key taps).
test("ptt: a stale daemon's exit and a double error+exit never start an extra daemon", async () => {
  const { createPtt } = await import("../src/desktop-ptt.ts");
  const spawned: Array<{ exit: (c: number | null) => void; killed: boolean }> = [];
  const timers: Array<() => void> = [];
  const p = createPtt({
    send: () => {}, transcribe: async () => ({ text: "" }), ask: async () => {}, front: async () => null,
    spawnDaemon: (_l, onExit) => { const s = { exit: onExit, killed: false }; spawned.push(s); return { kill: () => { s.killed = true; } }; },
    now: () => 0, setTimer: (fn) => { timers.push(fn); return timers.length; }, clearTimer: () => {},
  });
  p.start(); p.stop(); p.start();               // daemon 0 replaced by daemon 1
  assert.equal(spawned.length, 2);
  spawned[0].exit(0);                            // daemon 0's late exit
  assert.equal(timers.length, 0, "no restart for a stale daemon");
  spawned[1].exit(1); spawned[1].exit(1);        // "error" then "exit" for the same process
  assert.equal(timers.length, 1, "one restart, not two");
});
