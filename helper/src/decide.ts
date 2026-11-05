import { mkdirSync, writeFileSync } from "node:fs";
import { gate } from "./gate.ts";
import { askBrain, askVerify, BRAIN_MODEL, LAYA_MODEL } from "./zg.ts";
import { episodeLog, type CallRef } from "./episode-log.ts";
import type { BrainResult, VerifyResult, Decision, Outline, OutlineElement } from "./types.ts";

export type Deps = {
  brain: (question: string, outlineText: string) => Promise<BrainResult>;
  verify: (question: string, element: OutlineElement) => Promise<VerifyResult>;
};
// The real 0G calls. Tests inject fakes through Deps; the product never does.
export const realDeps: Deps = { brain: (q, t) => askBrain(q, t), verify: (q, el) => askVerify(q, el) };

export type DecisionRecord = { at: string; sessionId: string; question: string; decision: Decision };
const records: DecisionRecord[] = [];
export function recordsFor(sessionId: string): DecisionRecord[] { return records.filter((r) => r.sessionId === sessionId); }
export function recordByRequestId(id: string): DecisionRecord | undefined {
  return records.find((r) => r.decision.requestIds.brain === id || r.decision.requestIds.laya === id);
}

// Dev aid: keep the last real outline per page so scripts/eval.ts can replay real pages. Gitignored (helper/.data).
function saveOutline(o: Outline): void {
  try {
    mkdirSync("helper/.data/outlines", { recursive: true });
    const name = o.url.replace(/[^a-z0-9]+/gi, "_").slice(0, 80);
    writeFileSync(`helper/.data/outlines/${name}.json`, JSON.stringify(o));
  } catch { /* never let a dev aid break a decision */ }
}

// Two sealed calls in sequence: 0GM proposes one element (streamed, ~1.8 s to the tag), then laya checks it
// (~1 s). Sequence rather than parallel because laya can only check what 0GM proposed. Measured trade: the
// earlier parallel "both choose" design vetoed 4 of 12 correct answers on a page with plausible distractors.
export async function decide(sessionId: string, question: string, outline: Outline, deps: Deps = realDeps): Promise<Decision> {
  const t0 = Date.now();
  let brain = await deps.brain(question, outline.text);
  // 0GM may name an id that is not on the page. That is the same as naming nothing.
  const el = brain.ok && brain.targetId ? outline.elements.find((e) => e.id === (brain as { targetId: string }).targetId) : undefined;
  if (brain.ok && brain.targetId && !el) brain = { ...brain, targetId: null };
  const verify = el ? await deps.verify(question, el) : null;

  const g = gate(brain, verify);
  if (g.outcome === "point" && brain.ok && brain.sentence) g.say = brain.sentence; // 0GM's own words next to the pointer
  saveOutline(outline);
  const decision: Decision = {
    ...g,
    ...(brain.ok && brain.targetId ? { proposedId: brain.targetId } : {}),
    ...(verify?.ok ? { layaP: verify.p } : {}),
    requestIds: {
      ...(brain.ok && brain.requestId ? { brain: brain.requestId } : {}),
      ...(verify?.ok && verify.requestId ? { laya: verify.requestId } : {}),
    },
    ms: {
      total: Date.now() - t0,
      ...(brain.ok ? { brain: brain.ms } : {}),
      ...(verify?.ok ? { laya: verify.ms } : {}),
    },
  };
  // One line per decision so a wrong answer can be traced without a debugger (no secrets in it).
  console.log(`[decide] "${question}" brain=${brain.ok ? brain.targetId : "FAIL:" + brain.cause} laya=${verify === null ? "-" : verify.ok ? verify.p.toFixed(2) : "FAIL:" + verify.cause} -> ${decision.outcome} (${decision.reason})`);
  records.push({ at: new Date().toISOString(), sessionId, question, decision });
  // Receipts: remember which provider answered under which chat id, and start fetching the signatures now
  // (they expire after ~20 minutes). Never allowed to break or delay the answer.
  try {
    const calls: CallRef[] = [];
    if (brain.ok) calls.push({ role: "brain", model: BRAIN_MODEL, requestId: brain.requestId, chatId: brain.chatId, provider: brain.provider });
    if (verify?.ok) calls.push({ role: "laya", model: LAYA_MODEL, requestId: verify.requestId, chatId: verify.chatId, provider: verify.provider });
    if (calls.length) episodeLog.record(sessionId, { question, outcome: decision.outcome, targetId: decision.targetId, say: decision.say, reason: decision.reason, calls });
  } catch (e) { console.error("[episode-log] record failed:", (e as Error).message); }
  return decision;
}
