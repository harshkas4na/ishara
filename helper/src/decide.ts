import { mkdirSync, writeFileSync } from "node:fs";
import { gate } from "./gate.ts";
import { secondCandidate } from "./shortlist.ts";
import { askBrain, askVerify, BRAIN_MODEL, LAYA_MODEL } from "./zg.ts";
import { episodeLog, type CallRef } from "./episode-log.ts";
import { memory, memoryUsed, hostOf } from "./memory.ts";
import type { BrainResult, VerifyResult, Decision, Outline, OutlineElement } from "./types.ts";

export type Deps = {
  brain: (question: string, outlineText: string, context?: string) => Promise<BrainResult>;
  verify: (question: string, element: OutlineElement) => Promise<VerifyResult>;
};
// The real 0G calls. Tests inject fakes through Deps; the product never does.
export const realDeps: Deps = { brain: (q, t, c) => askBrain(q, t, { context: c }), verify: (q, el) => askVerify(q, el) };

export type DecisionRecord = { at: string; sessionId: string; question: string; decision: Decision };
const records: DecisionRecord[] = [];
export function recordsFor(sessionId: string): DecisionRecord[] { return records.filter((r) => r.sessionId === sessionId); }
export function recordByRequestId(id: string): DecisionRecord | undefined {
  return records.find((r) => r.decision.requestIds.brain === id || r.decision.requestIds.laya === id);
}

// Dev aid: keep the last real outline per page so scripts/eval.ts can replay real pages. Gitignored (helper/.data).
function saveOutline(o: Outline): void {
  if (process.env.NODE_TEST_CONTEXT) return; // tests must not overwrite the captured outlines the eval replays
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
  // Personal memory (memory.ts): recorded always, but fed to the sealed prompt only when ISHARA_MEMORY=1 (default
  // off until the eval shows it does not hurt accuracy). Pure local file reads; any failure means "no context".
  const host = hostOf(outline.url);
  let context = "";
  try { if (memoryUsed()) context = memory().context(host); } catch { /* memory must never break a decision */ }
  let brain = await deps.brain(question, outline.text, context);
  // 0GM may name an id that is not on the page. That is the same as naming nothing.
  const el = brain.ok && brain.targetId ? outline.elements.find((e) => e.id === (brain as { targetId: string }).targetId) : undefined;
  if (brain.ok && brain.targetId && !el) brain = { ...brain, targetId: null };
  const verify = el ? await deps.verify(question, el) : null;

  let g = gate(brain, verify);
  // laya doubted 0GM's pick (it answered, but below the bar). If ANOTHER control shares real words with the question,
  // the honest move is to show both and let the person choose, instead of a bare "which step?". Never when laya was
  // unreachable (no evidence either way) and never with no word overlap (a vague "help" has no second candidate).
  if (g.outcome === "ask" && verify?.ok && brain.ok && brain.targetId) {
    const other = secondCandidate(question, outline.elements, brain.targetId);
    if (other) g = { ...g, outcome: "ask_which", candidates: [brain.targetId, other], say: "This one or that one?", reason: `${g.reason}; ${other} also matches the question` };
  }
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
    // Fake-router results are marked at the source (zg.ts); carry the mark to everything that shows or stores this.
    ...(brain.testRouter || verify?.testRouter ? { testRouter: true } : {}),
    ms: {
      total: Date.now() - t0,
      ...(brain.ok ? { brain: brain.ms } : {}),
      ...(verify?.ok ? { laya: verify.ms } : {}),
    },
  };
  // One line per decision so a wrong answer can be traced without a debugger (no secrets in it).
  console.log(`[decide] "${question}" brain=${brain.ok ? brain.targetId : "FAIL:" + brain.cause} laya=${verify === null ? "-" : verify.ok ? verify.p.toFixed(2) : "FAIL:" + verify.cause} -> ${decision.outcome} (${decision.reason})`);
  try { // the label of what was proposed/pointed at: a short control name, never the outline text
    const lab = outline.elements.find((e) => e.id === (decision.targetId ?? decision.proposedId))?.label;
    // Fake-router answers never teach the memory: what it learns can later reach the real sealed prompt.
    if (!decision.testRouter) memory().recordAsk(sessionId, host, question, decision.outcome === "ask_which" ? "ask" : decision.outcome, lab);
  } catch (e) { console.error("[memory] record failed:", (e as Error).message); }
  records.push({ at: new Date().toISOString(), sessionId, question, decision });
  if (records.length > 500) records.splice(0, records.length - 500); // a long-running helper must not grow without bound
  // Receipts: remember which provider answered under which chat id, and start fetching the signatures now
  // (they expire after ~20 minutes). Never allowed to break or delay the answer.
  try {
    const calls: CallRef[] = [];
    if (brain.ok) calls.push({ role: "brain", model: BRAIN_MODEL, requestId: brain.requestId, chatId: brain.chatId, provider: brain.provider });
    if (verify?.ok) calls.push({ role: "laya", model: LAYA_MODEL, requestId: verify.requestId, chatId: verify.chatId, provider: verify.provider });
    if (calls.length) episodeLog.record(sessionId, { question, outcome: decision.outcome, targetId: decision.targetId, say: decision.say, reason: decision.reason, calls, ...(decision.testRouter ? { testRouter: true } : {}) });
  } catch (e) { console.error("[episode-log] record failed:", (e as Error).message); }
  return decision;
}
