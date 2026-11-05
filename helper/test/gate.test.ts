// Every way the gate can end, including the edges where a wrong move would be a fake decision.
import { test } from "node:test";
import assert from "node:assert/strict";
import { gate, type BrainResult, type VerifyResult } from "../src/gate.ts";
import { VERIFY_MIN_P } from "../src/config.ts";

const brain = (targetId: string | null): BrainResult => ({ ok: true, targetId, ms: 1800 });
const verify = (p: number): VerifyResult => ({ ok: true, p, ms: 900 });

test("point: 0GM proposes and laya confirms", () => {
  const d = gate(brain("b17"), verify(0.9));
  assert.equal(d.outcome, "point");
  assert.equal(d.targetId, "b17");
});

test("point at exactly the threshold, ask just below it", () => {
  assert.equal(gate(brain("b17"), verify(VERIFY_MIN_P)).outcome, "point");
  assert.equal(gate(brain("b17"), verify(VERIFY_MIN_P - 0.0001)).outcome, "ask");
});

test("ask when laya does not confirm, and never name a target", () => {
  const d = gate(brain("b17"), verify(0.1));
  assert.equal(d.outcome, "ask");
  assert.equal(d.targetId, undefined);
});

test("ask when 0GM named nothing, with no check made", () => {
  assert.equal(gate(brain(null), null).outcome, "ask");
});

test("safe_stop when the brain times out, with its cause", () => {
  const d = gate({ ok: false, cause: "timeout" }, null);
  assert.equal(d.outcome, "safe_stop");
  assert.equal(d.safeStopCause, "timeout");
});

test("safe_stop on 503 and offline", () => {
  assert.equal(gate({ ok: false, cause: "unavailable" }, null).safeStopCause, "unavailable");
  assert.equal(gate({ ok: false, cause: "offline" }, null).safeStopCause, "offline");
});

test("never points on the brain alone when laya fails or is skipped", () => {
  for (const v of [{ ok: false, cause: "timeout" } as VerifyResult, null]) {
    const d = gate(brain("b17"), v);
    assert.equal(d.outcome, "ask");
    assert.equal(d.targetId, undefined);
  }
});
