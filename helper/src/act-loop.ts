// act-loop.ts: the sealed planning loop of Agent mode (docs/AGENT-MODE.md).
// One step = ask 0GM for ONE action -> validate -> classify risk (and the injection rule) -> laya checks the target ->
// tell the UI (`action`) -> HIGH waits for the person's tap -> an executor does it -> the fresh screen comes back -> next step.
// Everything the world touches is an injected dep, so the loop is tested end to end with fakes and never with a real screen.
// Safe-stop rule: if 0GM cannot be reached the loop ends with `refused`. There is NO local fallback planner, ever.
import { VERIFY_MIN_P } from "./config.ts";
import { decidePointer, checkPointer, type PointerCheck, type PointerTarget } from "./pointer-gate.ts";
import { validateAction, TERMINAL, lookup } from "./act.ts";
import { classify } from "./act-risk.ts";
import { ACT_TOOL_CHOICE, actTools, buildActMessages, describeAction, type HistoryItem } from "./act-prompt.ts";
import { askAct as realAskAct, askVerifyRef, BRAIN_MODEL, LAYA_MODEL, type AskActResult } from "./zg.ts";
import type { OutlineElement, Action, ActEvent, ActIds, ActRequest, ActRisk, Cause, ChatMessage, PageContext } from "./types.ts";

export const MAX_ACTIONS = 25;
export const MAX_MS = 3 * 60 * 1000;
export const MAX_FAILURES = 3;
export const MAX_PLANS = 40;        // planning calls, including the ones whose proposal was invalid or refused; bounds spend
export const EXEC_TIMEOUT_MS = 15_000;
export const APPROVAL_MS = 60_000;

export type ExecResult = { ok: boolean; detail: string; context?: PageContext; data?: string };
export type CallRec = { role: "brain" | "laya"; model: string; requestId?: string; chatId?: string; provider?: string };
const FIELD_MIN_P = 0.25;
export type ActDeps = {
  askAct: (messages: ChatMessage[]) => Promise<AskActResult>;
  /** laya: is this control the one the step's sentence refers to? */
  checkTarget: (task: string, say: string, target: PointerTarget) => Promise<PointerCheck>;
  /** Runs the action: the browser extension (waits for POST /act/result) or the helper's desktop executor. */
  execute: (action: Action, n: number, ctx: PageContext) => Promise<ExecResult>;
  /** Resolves with the person's answer; false on deny, timeout or stop. */
  approve: (n: number, action: Action, risk: ActRisk, why: string, timeoutMs: number) => Promise<boolean>;
  stopped: () => boolean;
  /** Why the stop happened: "handoff" = the task carried on in the next page or tab (logged as continued, not stopped). */
  stopReason?: () => string | undefined;
  now?: () => number;
  /** One episode-log entry per task. Never throws into the loop. */
  record?: (sessionId: string, d: { question: string; outcome: string; say: string; reason: string; calls: CallRec[]; testRouter?: boolean }) => void;
  /** ISHARA_ACT_CONFIRM: "all" also asks for medium; "off" asks for nothing (rehearsals only, labelled on every action). */
  confirm?: "all" | "off" | undefined;
  limits?: Partial<{ maxActions: number; maxMs: number; maxFailures: number; execTimeoutMs: number; approvalMs: number }>;
};

/** Survives between POSTs of one task (an `ask` pauses it); the route keeps it in a bounded map. */
export type ActState = {
  actId: string; sessionId: string; task: string; context: PageContext;
  history: HistoryItem[]; steps: number; activeMs: number; failures: number; malformed: number; rejects: number; plans: number; denied: number;
  ids: ActIds; calls: CallRec[]; receipts: string[]; testRouter: boolean; awaitingAnswer: string | null; lastUsed: number;
  /** The person's answers to `ask`. With `task` they are the ONLY words that may lower a risk (audit 4, 1.5). */
  answers: string[];
  /** Notes from earlier pages of the same task (the extension's), shown to the model inside the fence as data. */
  earlier: string[];
};
export function newState(req: Pick<ActRequest, "sessionId" | "task" | "context"> & { history?: string[] }, actId: string, now = Date.now()): ActState {
  return {
    actId, sessionId: req.sessionId, task: req.task, context: req.context, history: [], steps: 0, activeMs: 0, failures: 0, malformed: 0, rejects: 0, plans: 0, denied: 0,
    ids: { brain: [], laya: [] }, calls: [], receipts: [], testRouter: false, awaitingAnswer: null, lastUsed: now, answers: [],
    earlier: (req.history ?? []).filter((h) => typeof h === "string").slice(-12).map((h) => clip(h, 100)),
  };
}
/** The person's own words: the task and every answer they gave. What `classify` may trust. */
export const authorityOf = (s: Pick<ActState, "task" | "answers">): string => [s.task, ...(s.answers ?? [])].join("\n");

/** A receipt line that never carries typed or copied text (it lands in the episode log): only its length. */
export function receiptOf(a: Action): string {
  if (a.type === "type") return `type id=${JSON.stringify(a.id)} text=<${a.text.length} chars>${a.clear ? " clear=true" : ""}`;
  if (a.type === "copy") return `copy text=<${a.text.length} chars>`;
  return describeAction(a);
}

export const confirmFromEnv = (): "all" | "off" | undefined => (process.env.ISHARA_ACT_CONFIRM === "all" ? "all" : process.env.ISHARA_ACT_CONFIRM === "off" ? "off" : undefined);

/** The production deps for everything but the executor and the approval wait, which belong to the route. */
export function realBaseDeps(): Pick<ActDeps, "askAct" | "checkTarget"> {
  return {
    askAct: (messages) => realAskAct(messages, { tools: actTools(), toolChoice: ACT_TOOL_CHOICE }),
    checkTarget: async (task, say, target) => {
      // laya's 4 s cut-off is tuned for the tutor; on a slow router it tripped on correct targets. A step can wait longer, and one retry.
      const verify = (q: string, el: OutlineElement) => askVerifyRef(q, say, el, { timeoutMs: 10000 });
      const first = await checkPointer(task, { ...target, sentence: say }, verify);
      return first.ok ? first : checkPointer(task, { ...target, sentence: say }, verify);
    },
  };
}

const REFUSE_SAY: Record<Cause, string> = {
  unavailable: "I can't do that right now. 0G's private model is not reachable, so I did nothing.",
  timeout: "I can't do that right now. 0G's private model took too long, so I stopped.",
  offline: "I can't do that right now. There is no connection, so I did nothing.",
};

const clip = (s: string, n: number) => s.replace(/\s+/g, " ").trim().slice(0, n);
const TARGETED = new Set<Action["type"]>(["click", "type", "select", "check"]);
const sleepRace = <T>(p: Promise<T>, ms: number, onTimeout: T): Promise<T> => {
  let t: ReturnType<typeof setTimeout>;
  return Promise.race([p, new Promise<T>((r) => { t = setTimeout(() => r(onTimeout), ms); })]).finally(() => clearTimeout(t));
};

/**
 * Runs (or resumes) one task and yields the SSE events of docs/AGENT-MODE.md. Mutates `state`.
 * Ends with exactly one of: done, failed, stopped, ask (paused), refused (0G unreachable).
 */
export async function* runAct(req: ActRequest, deps: ActDeps, state: ActState = newState(req, req.actId ?? "act")): AsyncGenerator<ActEvent> {
  const now = deps.now ?? Date.now;
  const L = { maxActions: MAX_ACTIONS, maxMs: MAX_MS, maxFailures: MAX_FAILURES, execTimeoutMs: EXEC_TIMEOUT_MS, approvalMs: APPROVAL_MS, ...deps.limits };
  const confirm = deps.confirm;
  const segStart = now();
  let waited = 0; // time spent waiting for the person: not the agent's time, so it does not eat the 3 minutes
  const elapsed = () => state.activeMs + (now() - segStart) - waited;

  state.context = req.context;
  state.lastUsed = now();
  if (state.awaitingAnswer !== null) {
    state.history.push({ n: state.history.length + 1, action: `ask "${clip(state.awaitingAnswer, 80)}"`, result: `the person answered: "${clip(req.answer ?? "", 300)}"` });
    if (req.answer) (state.answers ??= []).push(clip(req.answer, 2000));
    state.awaitingAnswer = null;
    state.failures = 0; state.rejects = 0; state.malformed = 0;
  }
  let note: string | undefined;

  const end = (event: "done" | "failed" | "stopped" | "ask", say: string, outcome: string): ActEvent => {
    state.activeMs = elapsed();
    const data = { say, steps: state.steps, requestIds: state.ids, ms: state.activeMs, ...(state.testRouter ? { testRouter: true as const } : {}) };
    // The receipts: one episode-log entry per task with every action, its risk and its outcome, and every 0G call with its ids.
    try {
      deps.record?.(state.sessionId, {
        question: clip(state.task, 200), outcome, say,
        reason: state.receipts.length ? state.receipts.join("; ").slice(0, 1500) : "no action was taken",
        calls: state.calls, ...(state.testRouter ? { testRouter: true } : {}),
      });
    } catch { /* receipts must never break a task */ }
    return { event, data } as ActEvent;
  };
  const handoff = () => deps.stopReason?.() === "handoff";
  // A stop because the task moved to the next page or tab is not the person stopping it: the receipt says so (audit 4, section 5).
  const stopEnd = () => (handoff() ? end("stopped", "Carried on in the next page.", "act-continued") : end("stopped", "Stopped. I did not do anything more.", "act-stopped"));

  for (;;) {
    if (deps.stopped()) { yield stopEnd(); return; }
    if (state.steps >= L.maxActions) { yield end("failed", `I stopped after ${L.maxActions} actions. This is taking too long, so please take it from here.`, "act-failed"); return; }
    if (elapsed() > L.maxMs) { yield end("failed", "I stopped after 3 minutes. This is taking too long, so please take it from here.", "act-failed"); return; }
    if (state.failures >= L.maxFailures) { yield end("failed", "That did not work three times in a row, so I stopped. Please take it from here.", "act-failed"); return; }
    if (state.plans >= MAX_PLANS) { yield end("failed", "I could not settle on a safe next step, so I stopped.", "act-failed"); return; }

    const n = state.steps + 1;
    yield { event: "thinking", data: { n, actId: state.actId } };
    state.plans++;
    const messages = buildActMessages({ task: state.task, context: state.context, history: state.history, ...(state.earlier?.length ? { earlier: state.earlier } : {}), ...(note ? { note } : {}) });
    note = undefined;
    const r = await deps.askAct(messages);
    if (r.ok) {
      state.calls.push({ role: "brain", model: BRAIN_MODEL, requestId: r.requestId, chatId: r.chatId, provider: r.provider });
      if (r.requestId) state.ids.brain.push(r.requestId);
      if (r.testRouter) state.testRouter = true;
    } else if (r.testRouter) state.testRouter = true;
    if (deps.stopped()) { yield stopEnd(); return; }
    if (!r.ok) {
      // 0GM is the only planner. Nothing local steps in: the task ends here and says so.
      const done = state.steps;
      const say = done ? `${REFUSE_SAY[r.cause]} I had finished ${done} step${done === 1 ? "" : "s"} before that.` : REFUSE_SAY[r.cause];
      state.activeMs = elapsed();
      try { deps.record?.(state.sessionId, { question: clip(state.task, 200), outcome: "act-refused", say, reason: `0G unreachable (${r.cause}); ${state.receipts.join("; ") || "nothing was done"}`.slice(0, 1500), calls: state.calls, ...(state.testRouter ? { testRouter: true } : {}) }); } catch { /* see above */ }
      yield { event: "refused", data: { cause: r.cause, say } };
      return;
    }

    // ---- malformed output: retry once with a nudge, then give up (a model that cannot follow the format must not guess)
    if (!r.args) {
      state.malformed++;
      if (state.malformed >= 2) { yield end("failed", "I could not work out the next step, so I stopped. Please take it from here.", "act-failed"); return; }
      note = "Your last reply was not a valid act call. Call the tool `act` with { action: { type: ... }, say: ... }.";
      continue;
    }
    state.malformed = 0;

    const v = validateAction(r.args.action, state.context);
    if (!v.ok) {
      state.failures++;
      state.history.push({ n: state.history.length + 1, action: clip(JSON.stringify(r.args.action) ?? "?", 100), result: `INVALID, nothing was done: ${v.error}` });
      yield { event: "result", data: { n, ok: false, detail: `invalid: ${v.error}`, refused: true } };
      continue;
    }
    const action = v.action;
    const say = clip(r.args.say || ("say" in action ? action.say : "") || describeAction(action), 160);

    // ---- terminal actions
    if (action.type === "done") { yield end("done", action.say, "act-done"); return; }
    if (action.type === "fail") { yield end("failed", action.say, "act-failed"); return; }
    if (action.type === "ask") { state.awaitingAnswer = action.say; yield end("ask", action.say, "act-asked"); return; }

    // ---- risk and the injection rule
    const c = classify(action, state.context, authorityOf(state));
    if (c.risk === "refused") {
      state.failures++;
      state.receipts.push(`#${n} ${receiptOf(action)} REFUSED (${c.why})`);
      state.history.push({ n: state.history.length + 1, action: describeAction(action), result: `REFUSED, nothing was done: ${c.why}. Do something else, or call ask.` });
      yield { event: "result", data: { n, ok: false, detail: c.why, refused: true } };
      continue;
    }

    // ---- laya checks the target (never act on 0GM alone)
    let point: { status: "confirmed" | "rejected" | "suppressed"; layaP?: number } | undefined;
    let targetLabel: string | undefined;
    if (TARGETED.has(action.type)) {
      const hit = lookup(state.context, (action as { id: string }).id)!; // validateAction proved it exists
      targetLabel = clip(hit.label, 80);
      const chk = await deps.checkTarget(state.task, say, { id: (action as { id: string }).id, kind: hit.kind, label: hit.label, role: hit.role });
      if (chk.ok) {
        state.calls.push({ role: "laya", model: LAYA_MODEL, requestId: chk.requestId, chatId: chk.chatId, provider: chk.provider });
        if (chk.requestId) state.ids.laya.push(chk.requestId);
        if (chk.testRouter) state.testRouter = true;
      }
      if (deps.stopped()) { yield stopEnd(); return; }
      // Measured on the real laya (6 Nov): right text fields score 0.37-0.45 and a wrong text field can score 0.72, so for
      // filling a field laya cannot tell fields apart well. Typing, choosing and ticking are visible and reversible
      // (medium), so they take a lower bar; clicks and anything HIGH keep the full bar.
      const fieldEntry = (action.type === "type" || action.type === "select" || action.type === "check") && c.risk !== "high";
      const status = decidePointer(chk, fieldEntry ? FIELD_MIN_P : VERIFY_MIN_P);
      point = { status, ...(chk.ok ? { layaP: chk.p } : {}) };
      if (status === "suppressed") {
        // laya is the independent check; without it nothing is touched. Ask the person instead of guessing.
        yield { event: "result", data: { n, ok: false, detail: "I can't double-check that control right now", refused: true } };
        yield end("ask", `I can't double-check which control "${targetLabel}" is right now, so I won't touch it. Can you do this step yourself?`, "act-asked");
        return;
      }
      if (status === "rejected") {
        state.rejects++;
        state.receipts.push(`#${n} ${receiptOf(action)} not done: laya doubted the target (p=${chk.ok ? chk.p.toFixed(2) : "?"})`);
        if (state.rejects >= 2) {
          yield { event: "result", data: { n, ok: false, detail: "that control does not look right", refused: true } };
          yield end("ask", `I am not sure "${targetLabel}" is the right control for this. Can you show me which one, or do this step yourself?`, "act-asked");
          return;
        }
        state.history.push({ n: state.history.length + 1, action: describeAction(action), result: "NOT DONE: that control does not look right for this step. Look again at the labels and pick a different control, or call ask." });
        yield { event: "result", data: { n, ok: false, detail: "that control does not look right", refused: true } };
        continue;
      }
    }

    // ---- tell the UI, then approval if needed
    const needsApproval = confirm === "off" ? false : c.risk === "high" || (c.risk === "medium" && confirm === "all");
    yield { event: "action", data: { n, action, risk: c.risk, say, needsApproval, ...(targetLabel ? { targetLabel } : {}), ...(point ? { point } : {}), ...(confirm === "off" ? { rehearsal: true as const } : {}) } };
    state.rejects = 0;
    let approvedNote = "";
    if (needsApproval) {
      yield { event: "approval", data: { n, action, risk: c.risk, why: c.why } };
      const w0 = now();
      const ok = await deps.approve(n, action, c.risk, c.why, L.approvalMs);
      waited += now() - w0;
      if (deps.stopped()) { yield stopEnd(); return; }
      if (!ok) {
        state.denied++;
        state.receipts.push(`#${n} ${receiptOf(action)} (${c.risk}) NOT APPROVED`);
        yield { event: "result", data: { n, ok: false, detail: "not approved" } };
        yield end("stopped", `Okay, I did not do that. I stopped before: ${say}`, "act-stopped");
        return;
      }
      approvedNote = ", approved";
    }

    // ---- execute (client: wait for POST /act/result; helper: call the desktop executor), 15 s per action
    state.steps = n;
    let res: ExecResult;
    try { res = await sleepRace(deps.execute(action, n, state.context), L.execTimeoutMs, { ok: false, detail: "the screen did not answer in time" }); }
    catch (e: any) { res = { ok: false, detail: `executor error: ${clip(String(e?.message ?? e), 100)}` }; }
    if (deps.stopped()) {
      state.receipts.push(`#${n} ${receiptOf(action)} (${c.risk}${approvedNote}) ${handoff() ? "done, the page changed" : "interrupted"}`);
      yield { event: "result", data: { n, ok: res.ok, detail: res.detail } };
      yield stopEnd(); return;
    }
    state.receipts.push(`#${n} ${receiptOf(action)} (${c.risk}${approvedNote}) ${res.ok ? "ok" : "FAILED: " + clip(res.detail, 60)}`);
    // `data` (a file's text) goes to the model inside the fence and nowhere else: not the receipts, not the episode log, not the SSE result.
    if (res.ok && res.data) for (const h of state.history) delete h.data; // only the newest file text is kept
    state.history.push({ n: state.history.length + 1, action: describeAction(action), result: res.ok ? `ok${res.detail ? ": " + clip(res.detail, 120) : ""}` : `FAILED: ${clip(res.detail, 120)}`, ...(res.ok && res.data ? { data: res.data } : {}) });
    yield { event: "result", data: { n, ok: res.ok, detail: res.detail } };
    if (res.ok) state.failures = 0; else state.failures++;
    if (res.context) state.context = res.context;
    else if (res.ok && action.type !== "wait" && action.type !== "screenshot" && action.type !== "copy" && action.type !== "read_file") state.history.push({ n: state.history.length + 1, action: "(screen)", result: "no fresh screen came back; the data above may be out of date" });
  }
}
