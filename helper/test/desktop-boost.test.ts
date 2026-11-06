import { test } from "node:test";
import assert from "node:assert/strict";
import { boostQuiet, MIN_RMS } from "../src/desktop-ptt.ts";
import { encodeWav, parseWav } from "../src/chunk-audio.ts";

const peakOf = (w: Uint8Array) => Math.max(...Array.from(parseWav(w)!.samples, Math.abs));
const tone = (amp: number, n = 8000) => encodeWav(Int16Array.from({ length: n }, (_, i) => Math.round(Math.sin(i / 7) * amp)), 16000);

test("a quiet take is raised, at most 8x, to a normal level", () => {
  const out = boostQuiet(tone(400));              // peak 0.012: raised 8x (capped), not to 0.9
  assert.equal(peakOf(out), 3200);
  const mid = boostQuiet(tone(2500));             // peak 0.076: raised toward 0.9 (11.8x, capped at 8x)
  assert.equal(peakOf(mid), 20000);
});
test("a loud take, silence and non-WAV input are left alone", () => {
  const loud = tone(20000); assert.equal(boostQuiet(loud), loud);
  const silent = tone(0); assert.equal(boostQuiet(silent), silent);
  const junk = new Uint8Array([1, 2, 3]); assert.equal(boostQuiet(junk), junk);
});
test("desktop floor is 0.003 unless ISHARA_MIN_RMS is set (room noise measured 0.0006)", () => {
  if (!process.env.ISHARA_MIN_RMS) assert.equal(MIN_RMS, 0.003);
});
