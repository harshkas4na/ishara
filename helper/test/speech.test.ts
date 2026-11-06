import { test } from "node:test";
import assert from "node:assert/strict";
import { cleanForSpeech, splitSentences, prepare, clauses, splitLong, sentencesOf, pickEngine, createSpeaker, sayFor, MAX_ANSWER_WORDS, MAX_PIECE_WORDS, type Voice, type SpeechDeps, type Playing } from "../src/speech.ts";
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

test("no truncation: every sentence of a long answer is kept, in order", () => {
  const s = (n: number, tag: string) => `${tag} ` + Array(n - 1).fill("word").join(" ") + ".";
  const answer = [s(20, "A"), s(15, "B"), s(10, "C"), s(25, "D"), s(8, "E")].join(" ");
  const p = prepare(answer);
  // the words that go in are exactly the words that come out (first sentence may be cut at commas, never shortened)
  assert.equal(p.join(" ").split(/\s+/).length, 20 + 15 + 10 + 25 + 8);
  assert.ok(p.at(-1)!.startsWith("E "));
  assert.equal(p.filter((x) => /^[A-E] /.test(x)).length, 5);
});

test("a very long sentence is split for synthesis, never shortened", () => {
  const w = Array.from({ length: 95 }, (_, i) => "w" + i);
  const noComma = splitLong(w.join(" ") + ".");
  assert.ok(noComma.every((x) => x.split(" ").length <= MAX_PIECE_WORDS));
  assert.equal(noComma.join(" "), w.join(" ") + ".");
  const commas = splitLong(Array.from({ length: 8 }, (_, i) => w.slice(i * 10, i * 10 + 10).join(" ")).join(", ") + ".");
  assert.ok(commas.length >= 3 && commas.every((x) => x.split(" ").length <= MAX_PIECE_WORDS));
  assert.equal(commas.join(" ").replace(/,/g, "").split(/\s+/).length, 80);
});

test("the runaway ceiling is the only limit: the crossing sentence is finished, later ones are dropped", () => {
  const sent = "Go " + Array(99).fill("go").join(" ") + ".";
  const r = sentencesOf(Array(10).fill(sent).join(" "));
  assert.equal(r.sentences.length, MAX_ANSWER_WORDS / 100); // 4 x 100 words reaches 400, the 5th is not taken
  assert.equal(r.clipped, true);
  assert.equal(sentencesOf("One. Two. Three.").clipped, false);
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

test("synthesis runs ahead of playback by two pieces", async () => {
  const r = rig();
  r.sp.speak("First one. Second one. Third one. Fourth one. Fifth one.");
  await tick();
  assert.deepEqual(r.synthed, ["First one.", "Second one.", "Third one."]); // while the first plays; the rest wait
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
  void r.sp.flush(); await tick();
  assert.ok(r.synthed.includes("Then wait")); // the trailing sentence with no final punctuation is spoken
});

test("a 12-sentence answer streamed in pieces is spoken to its last word, in order, as sentences outpace playback", async () => {
  const r = rig();
  const all = Array.from({ length: 12 }, (_, i) => `Sentence number ${i + 1} is here.`);
  for (const t of all) r.sp.enqueue(t + " ");        // all arrive at once, long before any finishes playing
  void r.sp.flush();
  for (let i = 0; i < 12; i++) { await tick(); r.playing[i]?.finish(); }
  await tick();
  assert.deepEqual(r.playing.map((p) => p.what), all.map((t) => "/f/" + t));
  assert.equal(r.sp.status().spoken, 12);
  assert.equal(r.sp.status().queued, 0);
});

test("interrupt mid-answer cuts every remaining sentence of a long answer", async () => {
  const r = rig();
  for (let i = 0; i < 8; i++) r.sp.enqueue(`Line ${i} is long enough. `);
  await tick();
  r.sp.interrupt(); await tick();
  assert.equal(r.playing.length, 1);
  assert.equal(r.playing[0].killed, true);
  r.playing[0].finish(); await tick();
  assert.equal(r.playing.length, 1); // nothing from the old answer ever starts
});

test("voices: every sentence, English, Hindi or Hinglish, uses the English voice (English only since 6 Nov 2026)", async () => {
  const calls: { text: string; voice?: string; lang?: string }[] = [];
  const playing: { finish: () => void }[] = [];
  const sp = createSpeaker({
    start: async () => ({ voice: {
      engine: "kokoro",
      synth: async (text, o) => { calls.push({ text, ...o }); return "/f/" + calls.length; },
      play: () => { let f!: () => void; const done = new Promise<void>((r) => { f = r; }); playing.push({ finish: f }); return { done, kill: f }; },
    } as Voice }),
    stop() {}, readMuted: () => false, writeMuted() {}, cleanup() {}, now: Date.now, enabled: true,
  }, { en: "af_heart", hi: "hf_alpha" });
  sp.speak("Click the Send button. यह बॉक्स है। Pehle address daalo, phir Send dabao.");
  await tick();
  assert.deepEqual(calls.map((c) => [c.voice, c.lang]), [["af_heart", "en-us"], ["af_heart", "en-us"], ["af_heart", "en-us"]]);
  assert.equal(calls[2].text, "Pehle address daalo, phir Send dabao."); // not converted to Devanagari: the Hindi voice is off
});

test("speaking events: first piece of each tagged sentence, in order, then idle after flush", async () => {
  const r = rig();
  const ev: string[] = [];
  r.sp.setHooks({ onSentenceStart: (t, x) => ev.push(`start ${t} ${x}`), onIdle: () => ev.push("idle") });
  r.sp.enqueue("Click the blue button at the top, then wait for the green banner to show up, and read it.", 0);
  r.sp.enqueue("Then it is done.", 1);
  await tick();
  assert.deepEqual(ev, ["start 0 Click the blue button at the top, then wait for the green banner to show up, and read it."]);
  const done = r.sp.flush(); let released = false; void done.then(() => { released = true; });
  for (let i = 0; i < 6; i++) { r.playing[i]?.finish(); await tick(); }
  assert.equal(ev.length, 3);
  assert.equal(ev[1], "start 1 Then it is done.");   // the split clauses of sentence 0 produced no second start
  assert.equal(ev[2], "idle");
  assert.equal(released, true);
});

test("speaking events: none when muted; idle fires on interrupt only if something was announced", async () => {
  const m = rig({ muted: true }); const ev: string[] = [];
  m.sp.setHooks({ onSentenceStart: () => ev.push("s"), onIdle: () => ev.push("i") });
  m.sp.enqueue("Hello there.", 0); await m.sp.flush();
  assert.deepEqual(ev, []);
  const r = rig(); const ev2: string[] = [];
  r.sp.setHooks({ onSentenceStart: () => ev2.push("s"), onIdle: () => ev2.push("i") });
  r.sp.interrupt(); assert.deepEqual(ev2, []);
  r.sp.enqueue("Hello there.", 0); await tick(); r.sp.interrupt();
  assert.deepEqual(ev2, ["s", "i"]);
});

test("flush with nothing queued resolves at once", async () => {
  const r = rig();
  await r.sp.flush();
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
