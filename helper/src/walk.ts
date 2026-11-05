// walk.ts: the state of a step-by-step walkthrough, per tab (docs/TUTOR-INTERFACE.md section 6).
// One model call writes the whole plan (at most 6 steps); after that "next / back / repeat / where / stop" are answered
// from this state with NO 0G call. The one thing that can send us back to the model is a step whose target has left
// the page: pointing at a stale id would put the ring on the wrong thing, so we re-plan (at most 3 times) instead.
import type { PageContext, WalkCmd } from "./types.ts";

export const WALK_IDLE_MS = 10 * 60 * 1000;
export const MAX_REPLANS = 3;

export type PlanStep = { n: number; m: number; say: string; targetId?: string; kind?: "control" | "block" };
export type Walk = { question: string; steps: PlanStep[]; index: number; replans: number; last: number; context?: PageContext };

/** What a walk command resolves to; tutor.ts turns it into events. */
export type WalkMove =
  | { type: "show"; step: PlanStep; targetId?: string; kind?: "control" | "block"; label?: string; lead?: string }
  | { type: "say"; text: string }
  | { type: "end"; text: string }
  | { type: "replan"; walk: Walk };

export type Target = { kind: "control" | "block"; label: string; role?: string };
/** Look an id up in the CURRENT context. null means it is not on the page now. */
export function lookupTarget(ctx: PageContext | undefined, id: string): Target | null {
  if (!ctx) return null;
  const c = ctx.controls.find((x) => x.id === id);
  if (c) return { kind: "control", label: c.label, role: c.role };
  const b = ctx.blocks.find((x) => x.id === id);
  if (b) return { kind: "block", label: b.text };
  return null;
}
export function contextIds(ctx: PageContext): string[] { return [...ctx.controls.map((c) => c.id), ...ctx.blocks.map((b) => b.id)]; }

export class WalkStore {
  private walks = new Map<string, Walk>();
  private now: () => number;
  constructor(now: () => number = Date.now) { this.now = now; }

  start(tabId: string, question: string, steps: PlanStep[], context?: PageContext, replans = 0): Walk {
    const m = steps.length;
    const w: Walk = { question, steps: steps.map((s, i) => ({ ...s, n: i + 1, m })), index: 0, replans, last: this.now(), ...(context ? { context } : {}) };
    this.walks.set(tabId, w);
    return w;
  }
  get(tabId: string): Walk | undefined {
    const w = this.walks.get(tabId);
    if (w && this.now() - w.last > WALK_IDLE_MS) { this.walks.delete(tabId); return undefined; }
    return w;
  }
  active(tabId: string): boolean { return this.get(tabId) !== undefined; }
  stop(tabId: string): void { this.walks.delete(tabId); }

  /** Apply one command. `ctx` is the freshest page context the caller has; ids are re-checked against it. */
  command(tabId: string, cmd: WalkCmd, ctx?: PageContext): WalkMove {
    const w = this.get(tabId);
    if (!w) return { type: "say", text: "There is no walkthrough going on right now. Ask me how to do something and I will walk you through it." };
    w.last = this.now();
    if (ctx) w.context = ctx;
    if (cmd === "stop") { this.walks.delete(tabId); return { type: "end", text: "Okay, I have stopped the walkthrough. Ask me whenever you want to continue." }; }
    if (cmd === "where") { const s = w.steps[w.index]; return { type: "say", text: `You are on step ${s.n} of ${s.m}. ${s.say}` }; }
    if (cmd === "next") {
      if (w.index >= w.steps.length - 1) { this.walks.delete(tabId); return { type: "end", text: "That was the last step. You are all set." }; }
      w.index++;
    } else if (cmd === "back") {
      if (w.index === 0) return this.show(tabId, w, "This is the first step already. ");
      w.index--;
    }
    return this.show(tabId, w);
  }

  private show(tabId: string, w: Walk, lead?: string): WalkMove {
    const step = w.steps[w.index];
    if (!step.targetId) return { type: "show", step, ...(lead ? { lead } : {}) };
    const t = lookupTarget(w.context, step.targetId);
    if (t) return { type: "show", step, targetId: step.targetId, kind: t.kind, label: t.kind === "block" ? t.label : (t.role ? `${t.role} "${t.label}"` : t.label), ...(lead ? { lead } : {}) };
    // The target left the page. Re-plan with one fresh call, but only a few times.
    if (w.replans >= MAX_REPLANS) { this.walks.delete(tabId); return { type: "end", text: "The page has changed too much for me to keep following these steps. Ask me again and I will start fresh." }; }
    return { type: "replan", walk: w };
  }
}
export const walks = new WalkStore();
