import { gate } from "./gate.ts";
import { shortlist as makeShortlist } from "./shortlist.ts";
import { askBrain, askLaya } from "./zg.ts";
import type { BrainResult, LayaResult, Decision, Outline } from "./types.ts";

export type Deps = {
  brain: (question: string, outlineText: string) => Promise<BrainResult>;
  laya: (question: string, ids: string[], elements: Outline["elements"]) => Promise<LayaResult>;
};
// The real 0G calls. Tests inject fakes through Deps; the product never does.
export const realDeps: Deps = { brain: (q, t) => askBrain(q, t), laya: (q, ids, els) => askLaya(q, ids, els) };

export type DecisionRecord = { at: string; sessionId: string; question: string; shortlist: string[]; decision: Decision };
const records: DecisionRecord[] = [];
export function recordsFor(sessionId: string): DecisionRecord[] { return records.filter((r) => r.sessionId === sessionId); }
export function recordByRequestId(id: string): DecisionRecord | undefined {
  return records.find((r) => r.decision.requestIds.brain === id || r.decision.requestIds.laya === id);
}

export async function decide(sessionId: string, question: string, outline: Outline, deps: Deps = realDeps): Promise<Decision> {
  const t0 = Date.now();
  const list = makeShortlist(question, outline.elements, 3);
  // Parallel on purpose: measured wall time 2.1-2.6 s versus ~3.5 s in sequence. Each call is already timeout-bounded.
  const [brain, laya] = await Promise.all([deps.brain(question, outline.text), deps.laya(question, list, outline.elements)]);
  const g = gate(brain, laya, list);
  const decision: Decision = {
    ...g,
    requestIds: {
      ...(brain.ok && brain.requestId ? { brain: brain.requestId } : {}),
      ...(laya.ok && laya.requestId ? { laya: laya.requestId } : {}),
    },
    ms: {
      total: Date.now() - t0,
      ...(brain.ok ? { brain: brain.ms } : {}),
      ...(laya.ok ? { laya: laya.ms } : {}),
    },
  };
  records.push({ at: new Date().toISOString(), sessionId, question, shortlist: list, decision });
  return decision;
}
