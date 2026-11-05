// Every way the gate can end, including the edges where a wrong move would be a fake decision.
import { test } from "node:test";
import assert from "node:assert/strict";
import { gate, type BrainResult, type LayaResult } from "../src/gate.ts";

const SHORTLIST = ["b17", "b18", "b19"];
const brain = (targetId: string | null): BrainResult => ({ ok: true, targetId, ms: 1800 });
const laya = (choice: string, p: number): LayaResult => ({ ok: true, choice, p, ms: 1100 });

test("point: both agree and laya is sure", () => {
  const d = gate(brain("b17"), laya("b17", 0.9), SHORTLIST);
  assert.equal(d.outcome, "point");
  assert.equal(d.targetId, "b17");
});

test("point at exactly the threshold (0.45 counts)", () => {
  assert.equal(gate(brain("b17"), laya("b17", 0.45), SHORTLIST).outcome, "point");
});

test("ask just below the threshold", () => {
  assert.equal(gate(brain("b17"), laya("b17", 0.4499), SHORTLIST).outcome, "ask");
});

test("ask when laya chooses none, even if the brain is sure", () => {
  const d = gate(brain("b17"), laya("none", 0.95), SHORTLIST);
  assert.equal(d.outcome, "ask");
  assert.equal(d.targetId, undefined);
});

test("ask when laya's choice is outside the shortlist", () => {
  assert.equal(gate(brain("b17"), laya("b99", 0.9), SHORTLIST).outcome, "ask");
});

test("ask when the brain named nothing", () => {
  assert.equal(gate(brain(null), laya("b17", 0.9), SHORTLIST).outcome, "ask");
});

test("ask_which when they disagree, with both candidates", () => {
  const d = gate(brain("b18"), laya("b17", 0.8), SHORTLIST);
  assert.equal(d.outcome, "ask_which");
  assert.deepEqual(d.candidates, ["b17", "b18"]);
});

test("safe_stop when the brain times out, with its cause", () => {
  const d = gate({ ok: false, cause: "timeout" }, laya("b17", 0.9), SHORTLIST);
  assert.equal(d.outcome, "safe_stop");
  assert.equal(d.safeStopCause, "timeout");
});

test("safe_stop on 503 and offline", () => {
  assert.equal(gate({ ok: false, cause: "unavailable" }, laya("b17", 0.9), SHORTLIST).safeStopCause, "unavailable");
  assert.equal(gate({ ok: false, cause: "offline" }, { ok: false, cause: "offline" }, SHORTLIST).safeStopCause, "offline");
});

test("never points on the brain alone when laya fails", () => {
  const d = gate(brain("b17"), { ok: false, cause: "timeout" }, SHORTLIST);
  assert.equal(d.outcome, "ask");
  assert.equal(d.targetId, undefined);
});
