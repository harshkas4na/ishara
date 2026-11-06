// act-route.ts: POST /act (SSE), POST /act/result, POST /act/approve, POST /act/stop, GET /act (docs/AGENT-MODE.md).
// Kept out of server.ts like tutor-route.ts so tests can mount it on their own http server with fake deps.
// This file owns the RUN REGISTRY (actId -> state, bounded, forgotten after 10 minutes) and the two waits the loop needs
// from the outside world: "the screen reported its result" and "the person tapped Approve". Both end early on Stop.
import type { IncomingMessage, ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import { refuse } from "./http-guard.ts";
import { MAX_BODY_BYTES, MAX_BLOCKS, MAX_CONTROLS, HEARTBEAT_MS } from "./tutor-route.ts";
import { scrubContext } from "./redact.ts";
import { runAct, newState, confirmFromEnv, type ActDeps, type ActState, type ExecResult } from "./act-loop.ts";
import type { Action, ActEvent, ActExecutor, PageContext } from "./types.ts";

export const MAX_TASK = 2000;
export const MAX_RUNS = 20;
export const RUN_TTL_MS = 10 * 60 * 1000;
const ACT_ID = /^[A-Za-z0-9_-]{8,64}$/;
const json = (res: ServerResponse, status: number, body: unknown) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };

class TooBig extends Error {}
async function readJson(req: IncomingMessage, limit: number): Promise<any> {
  const chunks: Buffer[] = []; let n = 0;
  for await (const c of req) { n += c.length; if (n > limit) throw new TooBig(); chunks.push(c); }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

// ---- one run: the state that survives an `ask`, plus the waiters of the stream that is currently driving it
export class Run {
  state: ActState;
  executor: ActExecutor = "client";
  stop = false;
  running = false;
  private wakers = new Set<() => void>();
  private approvals = new Map<number, (ok: boolean) => void>();
  private earlyApprovals = new Map<number, boolean>();
  private results = new Map<number, (r: ExecResult) => void>();
  private earlyResults = new Map<number, ExecResult>();
  constructor(state: ActState) { this.state = state; }

  /** Stop at once: every wait the loop is in resolves now (deny / not executed). */
  requestStop(): void { this.stop = true; for (const w of [...this.wakers]) w(); }
  reset(): void { this.stop = false; this.approvals.clear(); this.earlyApprovals.clear(); this.results.clear(); this.earlyResults.clear(); this.wakers.clear(); }

  /** Waits for the person's tap on Approve/Deny for step n; false on deny, 60 s of silence, or Stop. */
  waitApproval(n: number, ms: number): Promise<boolean> {
    if (this.stop) return Promise.resolve(false);
    const early = this.earlyApprovals.get(n);
    if (early !== undefined) { this.earlyApprovals.delete(n); return Promise.resolve(early); }
    return new Promise<boolean>((resolve) => {
      let t: ReturnType<typeof setTimeout>;
      const finish = (v: boolean) => { clearTimeout(t); this.wakers.delete(wake); this.approvals.delete(n); resolve(v); };
      const wake = () => finish(false);
      t = setTimeout(() => finish(false), ms); // no answer is a no
      this.wakers.add(wake);
      this.approvals.set(n, finish);
    });
  }
  answerApproval(n: number, approve: boolean): void {
    const w = this.approvals.get(n);
    if (w) w(approve); else if (n >= 1 && n <= this.state.steps + 2) this.earlyApprovals.set(n, approve); // tapped before the wait began
  }

  /** The client executor: waits for POST /act/result for step n. The caller (the loop) adds the 15 s cut-off. */
  waitResult(n: number): Promise<ExecResult> {
    const early = this.earlyResults.get(n);
    if (early) { this.earlyResults.delete(n); return Promise.resolve(early); }
    return new Promise<ExecResult>((resolve) => {
      const wake = () => { this.results.delete(n); this.wakers.delete(wake); resolve({ ok: false, detail: "stopped" }); };
      this.wakers.add(wake);
      this.results.set(n, (r) => { this.wakers.delete(wake); this.results.delete(n); resolve(r); });
    });
  }
  deliverResult(n: number, r: ExecResult): void {
    const w = this.results.get(n);
    if (w) w(r); else if (n >= 1 && n <= this.state.steps + 2) this.earlyResults.set(n, r); // the screen was faster than the helper
  }
}

export class ActRuns {
  private runs = new Map<string, Run>();
  private now: () => number;
  constructor(now: () => number = Date.now) { this.now = now; }
  private sweep(): void {
    for (const [id, r] of this.runs) if (!r.running && this.now() - r.state.lastUsed > RUN_TTL_MS) this.runs.delete(id);
    while (this.runs.size >= MAX_RUNS) { // bounded: drop the oldest idle run, else the oldest
      const idle = [...this.runs].find(([, r]) => !r.running) ?? [...this.runs][0];
      idle[1].requestStop(); this.runs.delete(idle[0]);
    }
  }
  get(id: string): Run | undefined { this.sweep(); return this.runs.get(id); }
  create(run: Run): Run { this.sweep(); this.runs.set(run.state.actId, run); return run; }
  delete(id: string): void { this.runs.delete(id); }
  size(): number { return this.runs.size; }
}
export const actRuns = new ActRuns();

export type ActRouteDeps = {
  base: Pick<ActDeps, "askAct" | "checkTarget">;
  /** The desktop executor (ACT-DESKTOP). Missing or throwing is a failed action, never a silent success. */
  helperExecute?: (action: Action, ctx: PageContext) => Promise<ExecResult>;
  record?: ActDeps["record"];
  runs?: ActRuns;
  heartbeatMs?: number;
  confirm?: ActDeps["confirm"] | null;   // null = read ISHARA_ACT_CONFIRM
  limits?: ActDeps["limits"];
  now?: () => number;
};

/** An error string, or null when the body is a usable new /act request. */
export function validateActBody(b: any): string | null {
  if (!b || typeof b !== "object") return "need a JSON object";
  if (b.sessionId !== undefined && typeof b.sessionId !== "string") return "sessionId must be a string";
  if (typeof b.task !== "string" || !b.task.trim()) return "need a non-empty task";
  if (b.task.length > MAX_TASK) return `task over ${MAX_TASK} chars`;
  if (b.executor !== "client" && b.executor !== "helper") return 'executor must be "client" or "helper"';
  return validateContext(b.context);
}
function validateContext(c: any): string | null {
  if (!c || typeof c !== "object" || !Array.isArray(c.blocks) || !Array.isArray(c.controls)) return "context needs blocks[] and controls[]";
  if (typeof c.url !== "string") return "context needs a url";
  if (c.blocks.length > MAX_BLOCKS || c.controls.length > MAX_CONTROLS) return "context too large (blocks/controls count)";
  return null;
}
const safeScrub = (c: PageContext): PageContext => scrubContext(c); // the second redaction lock, as for /tutor

export async function handleActRoute(req: IncomingMessage, res: ServerResponse, path: string, d: ActRouteDeps): Promise<boolean> {
  if (path !== "/act" && !path.startsWith("/act/")) return false;
  if (refuse(req.headers.host, req.headers.origin)) { json(res, 403, { error: "forbidden origin" }); return true; }
  const runs = d.runs ?? actRuns;
  if (req.method === "GET" && path === "/act") { json(res, 200, { ok: true, version: 1, armedRequired: true, executors: ["client", "helper"], events: ["thinking", "action", "approval", "result", "done", "failed", "stopped", "ask", "refused"] }); return true; }
  if (req.method !== "POST") { json(res, 405, { error: "POST only" }); return true; }
  if (path !== "/act" && path !== "/act/result" && path !== "/act/approve" && path !== "/act/stop") { json(res, 404, { error: "no such route" }); return true; }

  let b: any;
  try { b = await readJson(req, MAX_BODY_BYTES); }
  catch (e) { json(res, e instanceof TooBig ? 413 : 400, { error: e instanceof TooBig ? "body too large" : "invalid JSON" }); return true; }
  if (!b || typeof b !== "object") { json(res, 400, { error: "need a JSON object" }); return true; }

  // ---- the small control posts
  if (path !== "/act") {
    if (typeof b.actId !== "string") { json(res, 400, { error: "need actId" }); return true; }
    const run = runs.get(b.actId);
    if (path === "/act/stop") {
      if (run) { run.requestStop(); if (!run.running) runs.delete(b.actId); }
      json(res, 200, { ok: true, found: !!run }); return true;
    }
    if (!run) { json(res, 404, { error: "no such task (finished, stopped or expired)" }); return true; }
    if (!Number.isInteger(b.n) || b.n < 1) { json(res, 400, { error: "need n (the step number)" }); return true; }
    if (path === "/act/approve") {
      if (typeof b.approve !== "boolean") { json(res, 400, { error: "need approve: true or false" }); return true; }
      run.answerApproval(b.n, b.approve); json(res, 200, { ok: true }); return true;
    }
    // /act/result
    if (typeof b.ok !== "boolean") { json(res, 400, { error: "need ok: true or false" }); return true; }
    let context: PageContext | undefined;
    if (b.context !== undefined) {
      const bad = validateContext(b.context);
      if (bad) { json(res, 400, { error: bad }); return true; }
      try { context = safeScrub(b.context); } catch { json(res, 500, { error: "could not redact the context; refusing to use it" }); return true; }
    }
    run.deliverResult(b.n, { ok: b.ok, detail: String(b.detail ?? "").slice(0, 300), ...(context ? { context } : {}) });
    json(res, 200, { ok: true }); return true;
  }

  // ---- POST /act: Agent mode must be armed, every time. Off means nothing moves and nothing is planned.
  const stream = (code = 200) => {
    res.writeHead(code, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive", "x-accel-buffering": "no", ...(actId ? { "x-act-id": actId } : {}) });
    res.socket?.setNoDelay(true); res.flushHeaders();
  };
  const frame = (name: string, data: unknown) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
  let actId = typeof b.actId === "string" && ACT_ID.test(b.actId) ? b.actId : "";
  if (b.armed !== true) {
    stream(); res.write(frame("refused", { cause: "disarmed", say: "Turn on Agent mode and I will do that." })); res.end(); return true;
  }
  if (b.actId !== undefined && !actId) { json(res, 400, { error: "actId must be 8 to 64 of A-Z a-z 0-9 _ -" }); return true; }

  let run = actId ? runs.get(actId) : undefined;
  if (run) {
    if (run.running) { json(res, 409, { error: "that task is still running" }); return true; }
    if (run.state.awaitingAnswer === null) { json(res, 409, { error: "that task is not waiting for an answer" }); return true; }
    if (typeof b.answer !== "string" || !b.answer.trim() || b.answer.length > MAX_TASK) { json(res, 400, { error: "need the person's answer" }); return true; }
    const bad = validateContext(b.context);
    if (bad) { json(res, 400, { error: bad }); return true; }
  } else {
    if (b.answer !== undefined) { json(res, 400, { error: "no task is waiting for an answer (it may have expired)" }); return true; }
    const bad = validateActBody(b);
    if (bad) { json(res, 400, { error: bad }); return true; }
    if (!actId) actId = "act-" + randomBytes(8).toString("hex");
    run = runs.create(new Run(newState({ sessionId: String(b.sessionId ?? "default"), task: b.task.trim(), context: b.context }, actId, (d.now ?? Date.now)())));
  }
  const r = run;
  r.executor = b.executor === "helper" ? "helper" : r.executor;
  if (b.executor === "client") r.executor = "client";
  r.running = true; r.reset();
  let ctx: PageContext;
  try { ctx = safeScrub(b.context); } catch { r.running = false; runs.delete(r.state.actId); json(res, 500, { error: "could not redact the context; refusing to use it" }); return true; }
  actId = r.state.actId;

  stream();
  let open = true, finished = false;
  const write = (chunk: string) => { if (open) res.write(chunk); };
  const ping = setInterval(() => write(": ping\n\n"), d.heartbeatMs ?? HEARTBEAT_MS);
  // The screen going away (tab closed, extension restarted) is a stop: an agent must never keep acting for nobody.
  res.on("close", () => { open = false; clearInterval(ping); if (!finished) r.requestStop(); });

  const deps: ActDeps = {
    ...d.base,
    execute: (action, n, c) => r.executor === "client" ? r.waitResult(n)
      : (d.helperExecute ? d.helperExecute(action, c) : Promise.resolve({ ok: false, detail: "the desktop executor is not installed" })),
    approve: (n, _a, _risk, _why, ms) => r.waitApproval(n, ms),
    stopped: () => r.stop,
    ...(d.now ? { now: d.now } : {}),
    ...(d.record ? { record: d.record } : {}),
    confirm: d.confirm === null || d.confirm === undefined ? confirmFromEnv() : d.confirm,
    ...(d.limits ? { limits: d.limits } : {}),
  };
  let last = "";
  try {
    for await (const ev of runAct({ sessionId: r.state.sessionId, task: r.state.task, context: ctx, executor: r.executor, armed: true, actId, ...(typeof b.answer === "string" ? { answer: b.answer } : {}) }, deps, r.state) as AsyncGenerator<ActEvent>) {
      last = ev.event;
      write(frame(ev.event, ev.data));
    }
  } catch (e: any) {
    console.error("[act] task failed:", e?.message);
    last = "refused";
    write(frame("refused", { cause: "unavailable", say: "Something went wrong inside the helper, so I stopped. Nothing more was done." }));
  } finally {
    finished = true;
    clearInterval(ping);
    r.running = false; r.state.lastUsed = (d.now ?? Date.now)();
    if (last !== "ask") runs.delete(actId); // done/failed/stopped/refused are over; ask keeps its state for the answer
    if (open) res.end();
  }
  return true;
}
