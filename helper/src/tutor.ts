// tutor.ts: one tutor turn, end to end (docs/TUTOR-INTERFACE.md sections 2 to 4).
// The shape: route the question to a mode, stream 0GM-1.0, parse sentences and pointer tags as they arrive, speak each
// sentence at once, and check each pointer with laya IN PARALLEL so speech never waits on it. The safety rules live here:
//  - 0GM fails before any text: `refused`, nothing local ever answers in its place.
//  - laya unreachable: the explanation continues, every pointer is "suppressed" (never point on 0GM alone).
//  - a pointer moves the ring only on `confirmed` (laya p >= VERIFY_MIN_P about the USER's question).
import { VERIFY_MIN_P } from "./config.ts";
import { askTutorStream, BRAIN_MODEL, LAYA_MODEL } from "./zg.ts";
import { buildTutorMessages } from "./prompt.ts";
import { TutorStreamParser, type ParseEvent } from "./stream-parse.ts";
import { routeQuestion } from "./router.ts";
import { convo as globalConvo, type ConvoStore } from "./convo.ts";
import { walks as globalWalks, lookupTarget, contextIds, type WalkStore, type PlanStep } from "./walk.ts";
import type { Cause, PageContext, PointerVerdict, TutorCallRef, TutorDeps, TutorEvent, TutorMode, TutorRequest, WalkRequest } from "./types.ts";

export type TutorDepsFull = TutorDeps & { convo?: ConvoStore; walks?: WalkStore };

// ---- default deps. The pointer gate is another module; if it is missing, behave as "laya unreachable".
async function defaultCheckPointer(question: string, target: { id: string; kind: "control" | "block"; label: string; role?: string }): Promise<PointerVerdict> {
  try {
    const mod: any = await import("./pointer-gate.ts");
    if (typeof mod.checkPointer !== "function") return { ok: false, cause: "unavailable" };
    return await mod.checkPointer(question, target);
  } catch { return { ok: false, cause: "unavailable" }; }
}
export const realTutorDeps: TutorDeps = { askStream: (m, o) => askTutorStream(m, o), checkPointer: defaultCheckPointer };

export const REFUSAL_SAY: Record<Cause, string> = {
  unavailable: "I can't answer right now. 0G's private model is not reachable.",
  timeout: "I can't answer right now. 0G's private model took too long to respond.",
  offline: "I can't answer right now. There is no connection.",
};
const SUPPRESSED_REASON = "I can explain it, but I can't confirm which control, so I won't point.";

/** A minimal async queue so background laya checks can add events while the stream is still being read. */
class Channel<T> {
  private q: T[] = []; private wake: (() => void) | null = null; private closed = false;
  push(v: T): void { this.q.push(v); this.wake?.(); }
  close(): void { this.closed = true; this.wake?.(); }
  async *[Symbol.asyncIterator](): AsyncGenerator<T> {
    for (;;) {
      if (this.q.length) { yield this.q.shift() as T; continue; }
      if (this.closed) return;
      await new Promise<void>((r) => { this.wake = r; });
      this.wake = null;
    }
  }
}

const verdictStatus = (v: PointerVerdict) => (!v.ok ? "suppressed" : v.p >= VERIFY_MIN_P ? "confirmed" : "rejected") as "confirmed" | "rejected" | "suppressed";

type Ctl = { ch: Channel<TutorEvent>; calls: TutorCallRef[]; layaIds: string[]; pending: Promise<void>[]; testRouter: boolean; pointedLabels: string[] };

/** Check one pointer with laya, then emit its `point` event (and `then`, e.g. a step event). Never throws, never blocks the caller. */
function launchPointer(ctl: Ctl, deps: TutorDeps, question: string, ctx: PageContext, seq: number, id: string, then?: () => void): void {
  const target = lookupTarget(ctx, id);
  if (!target) { then?.(); return; } // cannot happen after parser validation; harmless if it does
  const kind = target.kind;
  const p = (async () => {
    let v: PointerVerdict;
    try { v = await deps.checkPointer(question, { id, kind, label: target.label, ...(target.role ? { role: target.role } : {}) }); }
    catch { v = { ok: false, cause: "unavailable" }; }
    if (v.ok) {
      ctl.calls.push({ role: "laya", model: LAYA_MODEL, requestId: v.requestId, chatId: v.chatId, provider: v.provider });
      if (v.requestId) ctl.layaIds.push(v.requestId);
      if (v.testRouter) ctl.testRouter = true;
    }
    const status = verdictStatus(v);
    if (status === "confirmed") ctl.pointedLabels.push(target.label.slice(0, 80));
    ctl.ch.push({ event: "point", data: {
      seq, targetId: id, kind, status,
      ...(v.ok ? { layaP: v.p } : {}),
      reason: status === "suppressed" ? SUPPRESSED_REASON : status === "confirmed" ? `laya confirmed (p=${(v as { p: number }).p.toFixed(2)})` : `laya doubted it (p=${(v as { p: number }).p.toFixed(2)}, below ${VERIFY_MIN_P})`,
    } });
    then?.();
  })();
  ctl.pending.push(p);
}

type CoreOpts = { req: TutorRequest; tabId: string; mode: TutorMode; deps: TutorDepsFull; turns: ReturnType<ConvoStore["turns"]>; walkReplan?: { index: number; steps: PlanStep[]; replans: number }; seqBase?: number };

/** The streaming core shared by a normal turn and a walk re-plan. Yields everything except `thinking`. */
async function* turnCore(o: CoreOpts): AsyncGenerator<TutorEvent> {
  const { req, deps, mode } = o;
  const now = deps.now ?? Date.now;
  const walks = deps.walks ?? globalWalks;
  const convo = deps.convo ?? globalConvo;
  const t0 = now();
  const ctx = req.context;
  const messages = buildTutorMessages({ mode, question: req.question, context: ctx, turns: o.turns, ...(o.walkReplan ? { walk: { index: o.walkReplan.index, steps: o.walkReplan.steps, replan: true } } : {}) });
  const parser = new TutorStreamParser({ validIds: contextIds(ctx), mode });
  const ch = new Channel<TutorEvent>();
  const ctl: Ctl = { ch, calls: [], layaIds: [], pending: [], testRouter: false, pointedLabels: [] };
  const spoken: string[] = [];
  let failed: { cause: Cause } | null = null;
  let meta: Extract<import("./types.ts").TutorStreamItem, { type: "meta" }> | null = null;

  // Guide bookkeeping: step 1 is spoken live; later steps are held for the walk. No STEP tag at all means a plain answer.
  const plan: PlanStep[] = [];
  let step: { n: number; m: number; says: string[]; point?: { id: string; kind: "control" | "block" } } | null = null;
  const finishStep = (): void => {
    if (!step) return;
    const s = step; step = null;
    const say = s.says.join(" ").trim();
    plan.push({ n: s.n, m: s.m, say, ...(s.point ? { targetId: s.point.id, kind: s.point.kind } : {}) });
    if (s.n === 1) {
      // step 1's `step` event follows its point event, so the UI sees say, point, step in that order
      const pp = step1Point ?? Promise.resolve();
      ctl.pending.push(pp.then(() => { ch.push({ event: "step", data: { n: 1, m: s.m, say, ...(s.point ? { targetId: s.point.id, kind: s.point.kind } : {}) } }); }));
    }
  };
  let step1Point: Promise<void> | undefined;

  const handle = (events: ParseEvent[]): void => {
    for (const e of events) {
      if (e.type === "step") { finishStep(); step = { n: e.n, m: e.m, says: [] }; continue; }
      if (e.type === "wait") { finishStep(); continue; }
      const held = step !== null && step.n > 1; // steps 2.. wait for the person; nothing is said or checked yet
      if (e.type === "say") {
        if (step) step.says.push(e.text);
        if (held) continue;
        spoken.push(e.text);
        ch.push({ event: "say", data: { seq: e.seq, text: e.text } });
      } else if (e.type === "point") {
        if (step) { if (!step.point) step.point = { id: e.targetId, kind: e.kind }; }
        if (held) continue;
        launchPointer(ctl, deps, req.question, ctx, e.seq, e.targetId);
        if (step && (step as { n: number }).n === 1 && !step1Point) step1Point = ctl.pending[ctl.pending.length - 1];
      }
    }
  };

  const producer = (async () => {
    try {
      for await (const item of deps.askStream(messages)) {
        if (item.type === "delta") handle(parser.push(item.text));
        else if (item.type === "meta") meta = item;
        else { failed = { cause: item.cause }; if (item.testRouter) ctl.testRouter = true; }
      }
      if (!failed) { handle(parser.end()); finishStep(); }
    } catch { failed = failed ?? { cause: "unavailable" }; }
    await Promise.allSettled(ctl.pending);
    ch.close();
  })();

  for await (const ev of ch) yield ev;
  await producer;

  // Safe stop: the brain gave nothing. Say why, plainly, and do not answer from anything local.
  if (failed && spoken.length === 0) {
    yield { event: "refused", data: { cause: (failed as { cause: Cause }).cause, say: REFUSAL_SAY[(failed as { cause: Cause }).cause] } };
    return;
  }
  if (spoken.length === 0 && plan.length === 0) {
    yield { event: "say", data: { seq: 1, text: "I am not sure how to answer that. Could you ask it another way?" } };
    spoken.push("I am not sure how to answer that. Could you ask it another way?");
  }
  const m = meta as (typeof meta);
  if (m?.testRouter) ctl.testRouter = true;
  const cutoff = Boolean(m?.cutoff) || failed !== null;
  if (mode === "guide" && plan.length) {
    const tabId = o.tabId;
    walks.start(tabId, req.question, plan, ctx, o.walkReplan?.replans ?? 0);
  }
  const brainCall: TutorCallRef | null = m ? { role: "brain", model: BRAIN_MODEL, requestId: m.requestId, chatId: m.chatId, provider: m.provider } : null;
  const calls = brainCall ? [brainCall, ...ctl.calls] : ctl.calls;
  const total = now() - t0;
  const outcome = cutoff ? "cutoff" : "answered";
  yield { event: "done", data: {
    mode, outcome, ...(cutoff && failed ? { cause: (failed as { cause: Cause }).cause } : {}),
    requestIds: { ...(m?.requestId ? { brain: m.requestId } : {}), laya: ctl.layaIds },
    ms: { ...(m?.firstTokenMs !== undefined ? { firstToken: m.firstTokenMs } : {}), total },
    ...(ctl.testRouter ? { testRouter: true as const } : {}),
    calls,
  } };
  // Remember the turn for follow-ups (RAM only). What was said is what the person heard, so that is what is stored.
  try { convo.record(o.tabId, ctx.url, { q: req.question, a: spoken.join(" "), mode, ...(ctl.pointedLabels[0] ? { pointedLabel: ctl.pointedLabels[0] } : {}) }); } catch { /* memory never breaks an answer */ }
}

export async function* runTutorTurn(req: TutorRequest, deps: TutorDepsFull = realTutorDeps): AsyncGenerator<TutorEvent> {
  const tabId = req.tabId ?? req.sessionId;
  const convo = deps.convo ?? globalConvo;
  const walks = deps.walks ?? globalWalks;
  const turns = convo.turns(tabId, req.context.url, req.question);
  const route = routeQuestion({ question: req.question, requested: req.mode, hasHistory: turns.length > 0, walkActive: walks.active(tabId) });
  if (route.kind === "walk") { yield* runWalkCommand({ sessionId: req.sessionId, tabId, cmd: route.cmd, context: req.context }, deps); return; }
  yield { event: "thinking", data: { mode: route.mode } };
  yield* turnCore({ req, tabId, mode: route.mode, deps, turns });
}

/** next / back / repeat / stop / where. No 0G call, except one fresh plan when a step's target left the page. */
export async function* runWalkCommand(req: WalkRequest, deps: TutorDepsFull = realTutorDeps): AsyncGenerator<TutorEvent> {
  const tabId = req.tabId ?? req.sessionId;
  const walks = deps.walks ?? globalWalks;
  const now = deps.now ?? Date.now;
  const t0 = now();
  yield { event: "thinking", data: { mode: "guide" } };
  const move = walks.command(tabId, req.cmd, req.context);
  const doneEvent = (calls: TutorCallRef[], layaIds: string[], testRouter: boolean): TutorEvent => ({ event: "done", data: {
    mode: "guide", outcome: "answered", requestIds: { laya: layaIds }, ms: { total: now() - t0 }, ...(testRouter ? { testRouter: true as const } : {}), calls } });

  if (move.type === "say" || move.type === "end") {
    yield { event: "say", data: { seq: 1, text: move.text } };
    yield doneEvent([], [], false);
    return;
  }
  if (move.type === "show") {
    const w = walks.get(tabId);
    const question = w?.question ?? "";
    const text = `${move.lead ?? ""}${move.step.say}`;
    yield { event: "say", data: { seq: 1, text } };
    const ctl: Ctl = { ch: new Channel<TutorEvent>(), calls: [], layaIds: [], pending: [], testRouter: false, pointedLabels: [] };
    const stepData = { n: move.step.n, m: move.step.m, say: move.step.say, ...(move.targetId ? { targetId: move.targetId, kind: move.kind } : {}) } as { n: number; m: number; say: string; targetId?: string; kind?: "control" | "block" };
    if (move.targetId && w?.context) {
      launchPointer(ctl, deps, question, w.context, 1, move.targetId);
      await Promise.allSettled(ctl.pending);
      ctl.ch.close();
      for await (const ev of ctl.ch) yield ev;
    }
    yield { event: "step", data: stepData };
    yield doneEvent(ctl.calls, ctl.layaIds, ctl.testRouter);
    return;
  }
  // replan: the target left the page. One fresh call with the current context; the old walk is replaced.
  const w = move.walk;
  w.replans++;
  const ctx = req.context ?? w.context;
  if (!ctx) { walks.stop(tabId); yield { event: "say", data: { seq: 1, text: "The page has changed, so I lost my place. Ask me again and I will start fresh." } }; yield doneEvent([], [], false); return; }
  const fresh: TutorRequest = { sessionId: req.sessionId, tabId, question: w.question, context: ctx, mode: "guide" };
  yield* turnCore({ req: fresh, tabId, mode: "guide", deps, turns: [], walkReplan: { index: w.index, steps: w.steps, replans: w.replans } });
}
