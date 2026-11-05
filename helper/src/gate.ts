// gate.ts: the product's judgment. Given what the two 0G models said, decide whether the pointer may move.
//
// Why a gate at all: a model alone can be confidently wrong. 0GM-1.0 reads the whole page outline and proposes
// ONE element. laya, a separate sealed decision model, is then asked a yes/no about that element: "is this
// what the user asked for?". The pointer moves only when laya says yes with enough probability. Everything
// else is a question to the user or a refusal. The gate is a pure function: no network, no clock, easy to test.
import { VERIFY_MIN_P } from "./config.ts";

export type Cause = "timeout" | "unavailable" | "offline";

export type BrainResult =
  | { ok: true; targetId: string | null; sentence?: string; requestId?: string; chatId?: string; provider?: string; ms: number } // null: 0GM named nothing usable; sentence is its one-line answer
  | { ok: false; cause: Cause };

// laya's P(yes) that the proposed element is what the user asked for. null when there was nothing to check.
export type VerifyResult =
  | { ok: true; p: number; requestId?: string; chatId?: string; provider?: string; ms: number }
  | { ok: false; cause: Cause };

export type GateDecision = {
  outcome: "point" | "ask" | "ask_which" | "safe_stop";
  targetId?: string;
  candidates?: string[];
  say: string;
  reason: string;
  safeStopCause?: Cause;
};

export function gate(brain: BrainResult, verify: VerifyResult | null): GateDecision {
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

  // 2. The brain answered but named no element: the request is too vague or off the page. Ask.
  if (brain.targetId === null) {
    return { outcome: "ask", say: "Which step do you mean? Tell me a little more.", reason: "0GM named no element" };
  }

  // 3. Never point on the brain alone. If laya could not be reached, ask the user instead.
  if (verify === null || !verify.ok) {
    return {
      outcome: "ask",
      say: "I'm not sure yet. Which step do you mean?",
      reason: verify === null ? "no check was made" : `laya gave no answer (${verify.cause}), so no pointing on 0GM alone`,
    };
  }

  // 4. laya is not convinced that this is what the user meant. Ask rather than point at a guess.
  if (verify.p < VERIFY_MIN_P) {
    return {
      outcome: "ask",
      say: "Which step do you mean? Tell me a little more.",
      reason: `laya p=${verify.p.toFixed(2)} that ${brain.targetId} is right, below ${VERIFY_MIN_P}`,
    };
  }

  // 5. 0GM proposed it and laya confirmed it.
  return {
    outcome: "point",
    targetId: brain.targetId,
    say: "Here.",
    reason: `0GM proposed ${brain.targetId}, laya confirmed (p=${verify.p.toFixed(2)})`,
  };
}
