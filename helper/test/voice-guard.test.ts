import { test } from "node:test";
import assert from "node:assert/strict";
import { guardTranscript, devanagariToRoman, transcribeGuarded, minRms } from "../src/transcript-guard.ts";
import { splitRanges, splitWav, encodeWav, parseWav, CHUNK_SEC } from "../src/chunk-audio.ts";
import { pickModel, HINGLISH_MODEL, TURBO_MODEL, SMALL_EN_MODEL, SMALL_MODEL, serverArgs } from "../src/whisper.ts";

test("guard drops whisper's stock output", () => {
  for (const t of ["[BLANK_AUDIO]", "(music)", "♪♪", "you", "You.", "Thank you.", "Thanks for watching!", "bye", "the", "uh", "Um...", "Hmm.", "...", "nan", "you you you", "[Music] (applause)"]) {
    const g = guardTranscript(t);
    assert.equal(g.text, "", t); assert.ok(g.rejected, t);
  }
  assert.equal(guardTranscript("[BLANK_AUDIO]").rejected, "blank");
});

test("guard keeps short valid Hinglish and English answers", () => {
  for (const t of ["ok", "okay", "Okay.", "haan", "nahi", "kya", "ye", "yeh", "acha", "theek hai", "Haan, theek hai.", "yes", "no", "verify and publish ka button kahan hai"]) {
    const g = guardTranscript(t);
    assert.equal(g.rejected, undefined, t); assert.equal(g.text, t);
  }
});

test("guard strips markers inside real speech and keeps a sentence containing 'you'", () => {
  assert.equal(guardTranscript("where is the button (music) please").text, "where is the button please");
  assert.equal(guardTranscript("thank you for the help, where is it").rejected, undefined);
});

test("guard rejects CJK, Cyrillic, Arabic script garbage", () => {
  for (const t of ["和", "Пока", "شكرا", "ありがとう"]) assert.equal(guardTranscript(t).rejected, "script", t);
  assert.equal(guardTranscript("contract address 和").text, "contract address"); // minority stray letter is trimmed
});

test("Devanagari never leaves the guard", () => {
  const g = guardTranscript("यह कॉन्ट्रैक्ट एड्रेस कहाँ डालना है");
  assert.equal(g.rejected, undefined);
  assert.doesNotMatch(g.text, /[ऀ-ॿ]/);
  assert.match(g.text, /kahaan/); assert.match(g.text, /^yah /);
  assert.equal(devanagariToRoman("इस एरर का मतलब क्या है"), "is erar kaa matalab kyaa hai");
  assert.equal(devanagariToRoman("हाँ"), "haan");
  assert.equal(devanagariToRoman("नहीं"), "naheen");
  assert.equal(devanagariToRoman("फ़ाइल"), "faail");
  assert.equal(guardTranscript("हाँ").text, "haan");
});

test("loudness floor default and override", () => {
  assert.equal(minRms({}), 0.006);
  assert.equal(minRms({ ISHARA_MIN_RMS: "0.02" }), 0.02);
  assert.equal(minRms({ ISHARA_MIN_RMS: "nope" }), 0.006);
});

// ---- chunking ----
function tone(sec: number, rate = 16000, gaps: number[] = []): Int16Array {
  const s = new Int16Array(Math.floor(sec * rate));
  for (let i = 0; i < s.length; i++) s[i] = Math.round(8000 * Math.sin(i / 10));
  for (const g of gaps) for (let i = Math.floor((g - 0.15) * rate); i < Math.floor((g + 0.15) * rate); i++) s[i] = 0;
  return s;
}

test("short clips are not split", () => {
  assert.deepEqual(splitRanges(tone(9.4), 16000), [[0, Math.floor(9.4 * 16000)]]);
  assert.equal(splitWav(encodeWav(tone(3), 16000)).length, 1);
});

test("a 20 s clip is cut at the quiet gap, every piece <= 9 s, nothing lost", () => {
  const s = tone(20, 16000, [8.2, 17.0]);
  const r = splitRanges(s, 16000);
  assert.ok(r.length >= 3);
  assert.equal(r[0][0], 0); assert.equal(r[r.length - 1][1], s.length);
  for (let i = 0; i < r.length; i++) {
    assert.ok(r[i][1] - r[i][0] <= CHUNK_SEC * 16000, `piece ${i}`);
    if (i) assert.equal(r[i][0], r[i - 1][1]); // contiguous
  }
  assert.ok(Math.abs(r[0][1] / 16000 - 8.2) < 0.2, `first cut ${r[0][1] / 16000}`); // landed in the gap
});

test("split WAV pieces parse back and wav round-trips", () => {
  const pieces = splitWav(encodeWav(tone(20, 16000, [8.2]), 16000));
  assert.ok(pieces.length >= 3);
  assert.equal(pieces.reduce((n, p) => n + parseWav(p)!.samples.length, 0), 20 * 16000);
  assert.equal(parseWav(new Uint8Array(10)), null);
});

// ---- route logic ----
test("transcribeGuarded: JSON shape, accepted, rejected, silent", async () => {
  const loud = encodeWav(tone(1), 16000);
  const say = (text: string) => async () => ({ text, ms: 5 });
  assert.deepEqual(await transcribeGuarded(loud, "p", say("ok")), { text: "ok", ms: 5 });
  assert.deepEqual(await transcribeGuarded(loud, "p", say("[BLANK_AUDIO]")), { text: "", ms: 5, rejected: "blank", detail: "[BLANK_AUDIO]" });
  assert.equal((await transcribeGuarded(loud, undefined, say("Пока"))).rejected, "script");
  assert.equal((await transcribeGuarded(loud, undefined, say("Thank you."))).rejected, "noise");
  const quiet = encodeWav(new Int16Array(16000), 16000);
  let called = false;
  const r = await transcribeGuarded(quiet, undefined, async () => { called = true; return { text: "x", ms: 1 }; });
  assert.equal(r.rejected, "silent"); assert.equal(r.text, ""); assert.equal(called, false);
  assert.equal((await transcribeGuarded(quiet, undefined, say("hello"), 0.0)).text, "hello"); // floor 0 -> not silent
  await assert.rejects(transcribeGuarded(loud, undefined, async () => { throw new Error("down"); }), /down/);
});

// ---- model selection ----
test("model order: env, then large-v3-turbo, then small.en, then small, else none; never the Hinglish model", () => {
  const has = (...p: string[]) => (f: string) => p.includes(f);
  assert.deepEqual(pickModel({ ISHARA_WHISPER_MODEL: "/x/m.bin" }, has("/x/m.bin", HINGLISH_MODEL)), { path: "/x/m.bin", hinglish: false });
  assert.equal(pickModel({ ISHARA_WHISPER_MODEL: "/missing.bin" }, has(HINGLISH_MODEL, TURBO_MODEL, SMALL_MODEL))!.path, TURBO_MODEL);
  assert.deepEqual(pickModel({}, has(HINGLISH_MODEL, TURBO_MODEL, SMALL_MODEL)), { path: TURBO_MODEL, hinglish: false });
  assert.deepEqual(pickModel({}, has(HINGLISH_MODEL, SMALL_EN_MODEL, SMALL_MODEL)), { path: SMALL_EN_MODEL, hinglish: false });
  assert.deepEqual(pickModel({}, has(HINGLISH_MODEL, SMALL_MODEL)), { path: SMALL_MODEL, hinglish: false }); // the Hinglish model alone is never used
  assert.deepEqual(pickModel({}, has(SMALL_MODEL)), { path: SMALL_MODEL, hinglish: false });
  assert.equal(pickModel({}, has()), null);
});

test("server flags", () => {
  const a = serverArgs("/m.bin", 7861, {});
  assert.deepEqual(a.slice(0, 7), ["-m", "/m.bin", "-l", "en", "-ac", "512", "-sns"]);
  assert.ok(!serverArgs("/m.bin", 7861, { ISHARA_WHISPER_SNS: "0" }).includes("-sns"));
});
