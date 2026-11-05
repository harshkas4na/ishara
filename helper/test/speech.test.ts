import { test } from "node:test";
import assert from "node:assert/strict";
import { cleanForSpeech, splitSentences, prepare, clauses, pickEngine, createSpeaker, sayFor, MAX_WORDS, type Voice, type SpeechDeps, type Playing } from "../src/speech.ts";
import { decide, type Deps } from "../src/decide.ts";

test("cleaning: markdown, ids, urls, test router, bare tags", () => {
  assert.equal(cleanForSpeech("**Click** the `Send` button [b12] (test router)"), "Click the Send button");
  assert.equal(cleanForSpeech("See [the docs](https://x.io/a) or https://x.io/b now"), "See the docs or now");
  assert.equal(cleanForSpeech("# Heading\n- item one\n- item two"), "Heading item one item two");
  assert.equal(cleanForSpeech("[b3]"), "");
  assert.equal(cleanForSpeech("b7"), "");
  assert.equal(cleanForSpeech("▮▮▯▯ …"), "");
  assert.equal(cleanForSpeech("(test router)"), "");
});

test("sentence splitting keeps decimals and abbreviations whole", () => {
  assert.deepEqual(splitSentences("Click Send. Then wait! Is it 3.5 seconds? Yes."), ["Click Send.", "Then wait!", "Is it 3.5 seconds?", "Yes."]);
  assert.deepEqual(splitSentences("Use e.g. the blue one."), ["Use e.g. the blue one."]);
});

test("cap: whole sentences within 40 words, ends cleanly", () => {
  const s = (n: number) => "Word " + Array(n - 1).fill("word").join(" ") + ".";
  const p = prepare(`${s(20)} ${s(15)} ${s(10)}`);
  assert.equal(p.length, 2); // 20 + 15 fit, the third would pass 40
  const long = prepare(Array(60).fill("alpha").join(" ") + ".");
  assert.ok(long.join(" ").split(" ").length <= MAX_WORDS);
  assert.ok(long.join(" ").endsWith("."));
});

test("first long sentence is split into clauses for a faster first sound", () => {
  const c = clauses("Click the blue button at the top, then wait for the green banner to show up, and read it.");
  assert.ok(c.length >= 2 && c[0].split(" ").length < 14);
});

test("engine selection falls back to the system voice, then none", () => {
  assert.equal(pickEngine({ kokoroReady: true, systemAvailable: true }), "kokoro");
  assert.equal(pickEngine({ kokoroReady: false, systemAvailable: true }), "system");
  assert.equal(pickEngine({ kokoroReady: false, systemAvailable: false }), "none");
  assert.equal(pickEngine({ forced: "system", kokoroReady: true, systemAvailable: true }), "system");
});

// ---- fakes: a synthesiser that resolves on demand and a player that records what it was asked to play ----
function rig(opts: { muted?: boolean; voice?: Voice | null } = {}) {
  const log: string[] = [];
  const playing: { what: string; finish: () => void; killed: boolean }[] = [];
  const synthed: string[] = [];
  const voice: Voice = {
    engine: "kokoro",
    synth: async (t) => { synthed.push(t); return `/f/${t}`; },
    play: (what) => {
      let finish!: () => void;
      const done = new Promise<void>((r) => { finish = r; });
      const rec = { what, finish, killed: false };
      playing.push(rec); log.push("play " + what);
      return { done, kill: () => { rec.killed = true; finish(); } } as Playing;
    },
  };
  let stored = opts.muted ?? false;
  const cleaned: string[] = [];
  const deps: SpeechDeps = {
    start: async () => (opts.voice === null ? { voice: null, reason: "none" } : { voice }),
    stop: () => {}, readMuted: () => stored, writeMuted: (m) => { stored = m; },
    cleanup: (p) => cleaned.push(p), now: Date.now, enabled: true,
  };
  return { sp: createSpeaker(deps), playing, synthed, log, cleaned, get stored() { return stored; } };
}
const tick = () => new Promise((r) => setTimeout(r, 10));

test("queue plays in order, one at a time, and cleans temp files", async () => {
  const r = rig();
  r.sp.speak("First one. Second one. Third one.");
  await tick();
  assert.deepEqual(r.playing.map((p) => p.what), ["/f/First one."]);
  r.playing[0].finish(); await tick();
  r.playing[1].finish(); await tick();
  r.playing[2].finish(); await tick();
  assert.deepEqual(r.playing.map((p) => p.what), ["/f/First one.", "/f/Second one.", "/f/Third one."]);
  assert.equal(r.sp.status().spoken, 3);
  assert.equal(r.cleaned.length, 3);
  assert.equal(r.sp.status().speaking, false);
});

test("synthesis runs one piece ahead of playback", async () => {
  const r = rig();
  r.sp.speak("First one. Second one. Third one.");
  await tick();
  assert.deepEqual(r.synthed, ["First one.", "Second one."]); // third waits
});

test("interrupt stops playback now and drops the queue", async () => {
  const r = rig();
  r.sp.speak("First one. Second one. Third one.");
  await tick();
  r.sp.interrupt(); await tick();
  assert.equal(r.playing[0].killed, true);
  assert.equal(r.playing.length, 1); // nothing else started
  assert.equal(r.sp.status().queued, 0);
  r.sp.speak("After that."); await tick();
  assert.equal(r.playing.at(-1)!.what, "/f/After that.");
});

test("mute drops speech, is persisted, and unmute speaks again", async () => {
  const r = rig();
  r.sp.setMuted(true);
  assert.equal(r.stored, true);
  r.sp.speak("Nothing."); await tick();
  assert.equal(r.playing.length, 0);
  assert.equal(r.sp.status().muted, true);
  r.sp.setMuted(false); r.sp.speak("Hello."); await tick();
  assert.equal(r.playing.length, 1);
  assert.equal(rig({ muted: true }).sp.isMuted(), true); // read back from the file at start
});

test("streaming: enqueue holds a partial sentence until flush or its end", async () => {
  const r = rig();
  r.sp.enqueue("Click the blue"); await tick();
  assert.equal(r.synthed.length, 0);
  r.sp.enqueue(" button. Then wait"); await tick();
  assert.deepEqual(r.synthed, ["Click the blue button."]);
  r.sp.flush(); await tick();
  assert.ok(r.synthed.includes("Then wait.".replace(".", "")));
});

test("no voice: status says why and speak does not throw", async () => {
  const r = rig({ voice: null });
  r.sp.speak("Hello there."); await tick();
  const s = r.sp.status();
  assert.equal(s.engine, "none"); assert.equal(s.ready, false); assert.equal(s.reason, "none");
});

test("system engine has no synth and is reported", async () => {
  const log: string[] = [];
  const sp = createSpeaker({
    start: async () => ({ voice: { engine: "system", play: (t) => { log.push(t); return { done: Promise.resolve(), kill() {} }; } } }),
    stop() {}, readMuted: () => false, writeMuted() {}, cleanup() {}, now: Date.now, enabled: true,
  });
  sp.speak("Use the system voice."); await tick();
  assert.deepEqual(log, ["Use the system voice."]);
  assert.equal(sp.status().engine, "system");
});

test("safe stop wording is the plain refusal, shortened", () => {
  assert.equal(sayFor({ outcome: "safe_stop", say: "long text", safeStopCause: "unavailable" }), "I can't decide right now. 0G's private model is not reachable.");
  assert.equal(sayFor({ outcome: "point", say: "Click here." }), "Click here.");
});

test("decide() speaks exactly once per answer", async () => {
  const said: string[] = [];
  const outline = { url: "https://x.test/", viewport: { w: 1, h: 1 }, elements: [{ id: "b1", label: "Send", role: "button", rect: { x: 0, y: 0, w: 1, h: 1 } }], text: '[b1] button "Send"' };
  const deps: Deps = {
    brain: async () => ({ ok: true, targetId: "b1", sentence: "Click Send.", ms: 1 }),
    verify: async () => ({ ok: true, p: 0.9, ms: 1 }),
    speak: (t) => said.push(t),
  };
  const d = await decide("speech-test", "where is send", outline, deps);
  assert.equal(d.outcome, "point");
  assert.deepEqual(said, ["Click Send."]);
  const stop = await decide("speech-test", "q", outline, { ...deps, brain: async () => ({ ok: false, cause: "unavailable" }), speak: (t) => said.push(t) });
  assert.equal(stop.outcome, "safe_stop");
  assert.equal(said.length, 2);
});
