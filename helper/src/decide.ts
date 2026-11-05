import { mkdirSync, writeFileSync } from "node:fs";
import { gate } from "./gate.ts";
import { secondCandidate } from "./shortlist.ts";
import { askBrain, askVerify, BRAIN_MODEL, LAYA_MODEL } from "./zg.ts";
import { episodeLog, type CallRef } from "./episode-log.ts";
import { memory, memoryUsed, hostOf } from "./memory.ts";
import { checkPointer } from "./pointer-gate.ts";
import { speak, sayFor } from "./speech.ts";
import type { BrainResult, VerifyResult, Decision, Outline, OutlineElement } from "./types.ts";

export type Deps = {
  brain: (question: string, outlineText: string, context?: string) => Promise<BrainResult>;
  verify: (question: string, element: OutlineElement) => Promise<VerifyResult>;
  speak?: (text: string) => void; // tests inject a recorder; the product uses speech.ts (never under node --test)
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
  // Spoken answer: one call, after the decision is built, never awaited (speech.ts queues and returns at once), so
  // it cannot slow or break the answer. Muted / ISHARA_SPEAK=0 are handled inside speak(). Not under `node --test`.
  const talk = deps.speak ?? (process.env.NODE_TEST_CONTEXT ? undefined : speak);
  try { talk?.(sayFor(decision)); } catch { /* the voice must never break a decision */ }
  return decision;
}

// ---- /tutor (docs/TUTOR-INTERFACE.md) ---------------------------------------------------------------------------
// Loose shapes on purpose: the tutor core (tutor.ts) owns the real types; this layer only needs these fields.
type TEvent = { event?: string; type?: string; [k: string]: any };
export type TutorTurnDeps = {
  run?: (req: any, deps: any) => AsyncGenerator<any>; // tests inject a fake generator; the product loads tutor.ts
  checkPointer?: typeof checkPointer;
  askStream?: unknown;
};

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n) : s);

/** One tutor turn: runs the tutor core with the real 0G deps and yields its events unchanged (minus the internal
 *  `calls` list on `done`). Log and memory are written once per turn, never allowed to break or delay the stream. */
export async function* tutorTurn(req: any, o: TutorTurnDeps = {}): AsyncGenerator<TEvent> {
  let run = o.run;
  const deps: any = { checkPointer: o.checkPointer ?? checkPointer, askStream: o.askStream };
  if (!run) {
    const t = await import("./tutor.ts"); // dynamic: the helper still boots (and /decide still works) if the core is absent
    run = t.runTutorTurn;
    deps.askStream ??= (await import("./zg.ts") as any).askTutorStream;
  }
  const said: string[] = [];
  let pointed: { id: string; kind: string } | undefined, refused: TEvent | undefined;
  {
    for await (const ev of run!(req, deps)) {
      const name = ev.event ?? ev.type; const d = ev.data ?? ev;
      if (name === "say" && typeof d.text === "string") said.push(d.text);
      else if (name === "point" && d.status === "confirmed" && !pointed) pointed = { id: d.targetId, kind: d.kind };
      else if (name === "refused") refused = d;
      else if (name === "done") {
        logTurn(req, said, pointed, d, refused);
        const { calls: _calls, ...wire } = d; // calls are for the receipt log, not for the client
        yield ev.data ? { ...ev, data: wire } : wire;
        continue;
      }
      yield ev;
    }
  }
}

function logTurn(req: any, said: string[], pointed: { id: string; kind: string } | undefined, done: TEvent, refused?: TEvent): void {
  const question = String(req.question ?? "");
  const outcome = refused || done.outcome === "refused" ? "refused" : done.mode === "guide" ? "guide" : pointed ? "point" : "explain";
  const calls: CallRef[] = Array.isArray(done.calls) ? done.calls : [];
  const say = clip(said.join(" "), 600);
  try { // receipts: same call as decide(); only turns with at least one sealed call have anything to prove
    if (calls.length) episodeLog.record(String(req.sessionId ?? "default"), {
      question, outcome, ...(pointed ? { targetId: pointed.id } : {}), say,
      reason: outcome === "explain" ? "explained by 0GM-1.0, not independently checked" : `tutor ${done.mode ?? ""} ${done.outcome ?? ""}`.trim(),
      calls, ...(done.testRouter ? { testRouter: true } : {}),
    });
  } catch (e) { console.error("[episode-log] tutor record failed:", (e as Error).message); }
  try { // memory: question, outcome and the pointed control's label only; never page text. Fake router never teaches it.
    if (!done.testRouter) {
      const ctx = req.context ?? {};
      const label = pointed?.kind === "control" ? (ctx.controls ?? []).find((c: any) => c.id === pointed!.id)?.label : undefined;
      memory().recordAsk(String(req.sessionId ?? "default"), hostOf(String(ctx.url ?? "")), question, outcome === "point" ? "point" : outcome === "refused" ? "safe_stop" : "ask", label);
    }
  } catch (e) { console.error("[memory] tutor record failed:", (e as Error).message); }
  console.log(`[tutor] "${clip(question, 80)}" mode=${done.mode} -> ${outcome}`);
}

/** /tutor/walk: next, back, repeat, stop, where. No 0G call, so nothing to log or prove. */
export async function* tutorWalk(req: any, o: { run?: (req: any, deps: any) => AsyncGenerator<any> } = {}): AsyncGenerator<TEvent> {
  const run = o.run ?? (await import("./tutor.ts")).runWalkCommand;
  for await (const ev of run(req, {})) {
    if ((ev.event ?? ev.type) === "done" && ev.data && "calls" in ev.data) { const { calls: _c, ...wire } = ev.data; yield { ...ev, data: wire }; } // internal list, not for the client
    else yield ev;
  }
}
