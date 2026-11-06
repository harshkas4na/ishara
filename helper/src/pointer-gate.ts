// The pointer gate for /tutor (docs/TUTOR-INTERFACE.md section 4, rules 2 and 3).
// 0GM may ask to point at something while it explains. laya (the sealed yes/no model) must agree that the target is
// what the USER asked about. The question laya sees is the user's own words; page text only ever appears as the
// label of the proposed target, exactly as in the old decide() path, never as instructions.
import { LAYA_TIMEOUT_MS, VERIFY_MIN_P } from "./config.ts";
import { askVerify, askVerifyRef } from "./zg.ts";
import type { OutlineElement, VerifyResult } from "./types.ts";

export type PointerTarget = { id: string; kind: "control" | "block"; label: string; role?: string; sentence?: string };
export type PointerCheck =
  | { ok: true; p: number; requestId?: string; chatId?: string; provider?: string; testRouter?: true; ms: number }
  | { ok: false; cause: "timeout" | "unavailable" | "offline" };
export type VerifyFn = (question: string, el: OutlineElement) => Promise<VerifyResult>;

/** A block is passed to laya as role "text" with its text clipped, so a long paragraph cannot dominate the prompt. */
export const BLOCK_LABEL_MAX = 120;

// When the tutor's sentence that carries the pointer is known, laya is asked whether the highlighted control is the one
// that SENTENCE refers to (measured on the real router, guide case: right target 0.32 -> 0.91, wrong targets 0.00-0.05).
// Asking only about the user's question vetoed correct pointers in explain/guide, where the question is not about one control.
export async function checkPointer(question: string, target: PointerTarget, verify?: VerifyFn): Promise<PointerCheck> {
  verify ??= target.sentence
    ? (q, el) => askVerifyRef(q, target.sentence as string, el, { timeoutMs: LAYA_TIMEOUT_MS })
    : (q, el) => askVerify(q, el, { timeoutMs: LAYA_TIMEOUT_MS });
  const label = target.kind === "block" ? target.label.replace(/\s+/g, " ").trim().slice(0, BLOCK_LABEL_MAX) : target.label;
  const el: OutlineElement = { id: target.id, role: target.kind === "block" ? "text" : (target.role ?? "control"), label, rect: { x: 0, y: 0, w: 0, h: 0 } };
  let r: VerifyResult;
  try { r = await verify(question, el); } catch { return { ok: false, cause: "unavailable" }; } // a throwing verifier is "laya unreachable"
  if (!r.ok) return { ok: false, cause: r.cause };
  return {
    ok: true, p: r.p, ms: r.ms,
    ...(r.requestId ? { requestId: r.requestId } : {}), ...(r.chatId ? { chatId: r.chatId } : {}), ...(r.provider ? { provider: r.provider } : {}),
    ...(r.testRouter ? { testRouter: true as const } : {}),
  };
}

/** The whole rule in one pure function. laya failing is "suppressed": never point on 0GM alone. */
export function decidePointer(check: PointerCheck, minP: number = VERIFY_MIN_P): "confirmed" | "rejected" | "suppressed" {
  if (!check.ok) return "suppressed";
  return check.p >= minP ? "confirmed" : "rejected";
}
