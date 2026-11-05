// gate.ts: the product's judgment. Given what the two 0G models said, decide whether the pointer may move.
//
// Why a gate at all: either model alone can be confidently wrong. 0GM-1.0 reads the whole page outline and
// names one element. laya sees only 3 shortlisted candidates (plus "none") and returns a probability.
// The pointer moves only when they independently agree AND laya is sure enough. Everything else is a
// question to the user or a refusal. The gate is a pure function: no network, no clock, easy to test.
import { LAYA_MIN_P } from "./config.ts";

export type Cause = "timeout" | "unavailable" | "offline";

export type BrainResult =
  | { ok: true; targetId: string | null; requestId?: string; ms: number } // null: 0GM named nothing usable
  | { ok: false; cause: Cause };

export type LayaResult =
  | { ok: true; choice: string; p: number; requestId?: string; ms: number } // choice is a shortlist id or "none"
  | { ok: false; cause: Cause };

export type GateDecision = {
  outcome: "point" | "ask" | "ask_which" | "safe_stop";
  targetId?: string;
  candidates?: string[];
  say: string;
  reason: string;
  safeStopCause?: Cause;
};

export function gate(brain: BrainResult, laya: LayaResult, shortlist: string[]): GateDecision {
  // 1. No answer from the brain: we cannot decide. Refuse. Never invent a target (a fake decision would
  //    disqualify us on the Physical AI track, and it would be a lie to the user).
  if (!brain.ok) {
    return {
      outcome: "safe_stop",
      say: "I can't decide right now.",
      reason: `0GM-1.0 gave no answer (${brain.cause})`,
      safeStopCause: brain.cause,
    };
  }

  // 2. The brain answered but laya did not. Never point on the brain alone: ask the user instead.
  if (!laya.ok) {
    return {
      outcome: "ask",
      say: "I'm not sure yet. Which step do you mean?",
      reason: `laya gave no answer (${laya.cause}), so no pointing on 0GM alone`,
    };
  }

  // 3. laya chose "none", chose something outside the shortlist, or is not sure enough: the request is
  //    too vague to act on. Ask. (Lab: vague requests land here, clear ones clear 0.45 easily.)
  if (laya.choice === "none") {
    return { outcome: "ask", say: "Which step do you mean?", reason: "laya chose none" };
  }
  if (!shortlist.includes(laya.choice)) {
    return { outcome: "ask", say: "Which step do you mean?", reason: `laya chose ${laya.choice}, not in the shortlist` };
  }
  if (laya.p < LAYA_MIN_P) {
    return {
      outcome: "ask",
      say: "Which step do you mean?",
      reason: `laya p=${laya.p.toFixed(2)} is below ${LAYA_MIN_P}`,
    };
  }

  // 4. laya is sure. The brain must have named something, and it must be the same element.
  if (brain.targetId === null) {
    return { outcome: "ask", say: "Which step do you mean?", reason: "0GM named no element" };
  }
  if (brain.targetId === laya.choice) {
    return {
      outcome: "point",
      targetId: laya.choice,
      say: "Here.",
      reason: `0GM and laya agree on ${laya.choice} (p=${laya.p.toFixed(2)})`,
    };
  }

  // 5. Both are confident about different elements. Do not pick for the user.
  return {
    outcome: "ask_which",
    candidates: [laya.choice, brain.targetId],
    say: "This one or that one?",
    reason: `0GM said ${brain.targetId}, laya said ${laya.choice}`,
  };
}
