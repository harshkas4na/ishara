// Runs ONE case: builds its world, drives the loop through a `driver`, records the event stream with timestamps and
// scores it. The driver is the only place that knows how to call the product, so the same runner serves the real
// loop (scripts/eval-act.ts) and the scripted fake generator in the unit tests.
import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Sim, type Ev } from "./sim.ts";
import { runChecks, terminal, type ActCase, type Row } from "./checks.ts";

export type Driver = (req: any, sim: Sim, c: ActCase) => AsyncIterable<{ event: string; data: any }>;
const HERE = dirname(fileURLToPath(import.meta.url));

export function loadCases(dir = HERE): ActCase[] {
  return readdirSync(dir).filter((f) => f.endsWith(".json")).sort().flatMap((f) => JSON.parse(readFileSync(join(dir, f), "utf8")) as ActCase[]);
}

const STEP_EVENTS = new Set(["action", "approval", "done", "failed", "stopped", "refused", "ask"]);

export async function runCase(c: ActCase, driver: Driver, now: () => number = () => performance.now()): Promise<{ row: Row; events: Ev[]; sim: Sim }> {
  const sim = new Sim(c.world, { approver: c.approver, stopAfter: c.stop_after, plannerDown: c.planner_down }, c.init ?? {});
  const req = { sessionId: "eval-" + c.id, tabId: "eval-" + c.id, task: c.task, context: sim.context(), executor: "client", armed: true };
  const events: Ev[] = []; const stepMs: number[] = [];
  const t0 = now(); let mark = t0; let threw: string | undefined;
  try {
    for await (const e of driver(req, sim, c)) {
      const t = now() - t0;
      events.push({ event: e.event, data: e.data, t });
      sim.onEvent(events[events.length - 1]);
      if (STEP_EVENTS.has(e.event)) { stepMs.push(Math.round(now() - mark)); }
      mark = now();
    }
  } catch (err) { threw = String((err as Error).message ?? err); }
  const totalMs = Math.round(now() - t0);
  const res = runChecks(c, { events, sim, threw });
  const term = terminal(events);
  // An exception or a refusal that was NOT expected means the router/loop was unavailable: infrastructure, not a verdict.
  const err = !!threw || (term?.kind === "refused" && !c.planner_down);
  return { row: { id: c.id, class: c.class, pass: res.pass && !err, err, fails: err ? [threw ? "exception:" + threw.slice(0, 80) : "router_unavailable (refused): not a product verdict"] : res.fails, say: term?.say ?? "", actions: sim.execCalls, stepMs, totalMs }, events, sim };
}

export async function pool<T, R>(items: T[], n: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length); let i = 0;
  await Promise.all(Array.from({ length: Math.max(1, n) }, async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k]); } }));
  return out;
}
