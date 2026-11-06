// Agent-mode eval: replays frozen cases (evals/act/*.json) through the REAL act loop (helper/src/act-loop.ts runAct,
// real sealed planner calls) against a SIMULATED executor and approver (evals/act/sim.ts), so no browser is needed.
// Mechanical checks only; one table per class, never a blended score (same rule as scripts/eval-tutor.ts).
//   node scripts/eval-act.ts [--class fill] [--case fill-01] [--limit N] [--concurrency 1]
// Cost: roughly 5 sealed planner calls per case, micro-dollars. Keys are read by helper/src/zg.ts only, never printed here.
// With ISHARA_ROUTER_URL set the run talks to the local fake router: mechanics only, written to a different file and
// shouted about so nothing from it can be mistaken for a measured number (docs/DECISIONS.md decision 8).
import { writeFileSync, mkdirSync } from "node:fs";
import { loadCases, runCase, pool, type Driver } from "../evals/act/run.ts";
import { formatTable } from "../evals/act/checks.ts";

const args = process.argv.slice(2);
const val = (n: string) => { const i = args.indexOf("--" + n); return i >= 0 ? args[i + 1] : undefined; };
const testRouter = !!process.env.ISHARA_ROUTER_URL?.trim();

/** Adapts the product's runAct (helper/src/act-loop.ts ActDeps) to the sim. One function, so a change to the hooks is a one-place fix. */
export async function realDriver(): Promise<Driver> {
  const mod: any = await import("../helper/src/act-loop.ts");
  const base = mod.realBaseDeps();
  return (req, sim) => mod.runAct(req, {
    // "Planner unreachable" is what 0G being down looks like to the loop; the real loop must then end with `refused`.
    askAct: sim.opts.plannerDown ? async () => ({ ok: false, cause: "unavailable" }) : base.askAct,
    checkTarget: base.checkTarget,
    execute: async (action: any) => sim.execute(action),
    approve: async (_n: number, action: any) => sim.answerFor(action),
    stopped: () => sim.stopRequested(),
  });
}

async function main() {
  if (testRouter) console.log("*** TEST ROUTER (not real 0G): numbers may not be quoted ***\n");
  let cases = loadCases();
  const cl = val("class"), one = val("case"), lim = Number(val("limit") ?? 0);
  if (cl) cases = cases.filter((c) => c.class === cl);
  if (one) cases = cases.filter((c) => c.id === one);
  if (lim > 0) cases = cases.slice(0, lim);
  if (!cases.length) { console.error("no cases match"); process.exit(2); }
  const driver = await realDriver();
  const done: Awaited<ReturnType<typeof runCase>>[] = [];
  await pool(cases, Number(val("concurrency") ?? 1), async (c) => {
    const r = await runCase(c, driver);
    done.push(r);
    console.log(`${r.row.err ? "ERR " : r.row.pass ? "PASS" : "FAIL"}  ${c.id.padEnd(13)} ${String(r.row.actions).padStart(2)} acts  ${r.row.fails.join("; ").slice(0, 100)}`);
  });
  const rows = cases.map((c) => done.find((d) => d.row.id === c.id)!.row);
  console.log("\n" + formatTable(rows));
  console.log(`\n(${rows.filter((r) => r.pass).length}/${rows.length} passed overall: for orientation only; read the per-class rows above, never quote this total)`);
  if (testRouter) console.log("TEST ROUTER (not real 0G): numbers may not be quoted");
  mkdirSync("helper/.data", { recursive: true });
  // A filtered run goes to its own file so a partial result can never replace the last full run.
  const partial = !!(cl || one || lim > 0);
  const out = testRouter ? "helper/.data/eval-act-test-router.json" : partial ? "helper/.data/eval-act-partial.json" : "helper/.data/eval-act-latest.json";
  writeFileSync(out, JSON.stringify({ at: new Date().toISOString(), testRouter, ...(testRouter ? { warning: "TEST ROUTER (not real 0G): do not quote" } : {}), rows, raw: done.map((d) => ({ id: d.row.id, events: d.events, world: d.sim.world.applied })) }, null, 2));
  console.log("saved", out);
}
if (import.meta.url === `file://${process.argv[1]}`) await main();
