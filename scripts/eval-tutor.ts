// Tutor eval: replays frozen cases (evals/tutor/*.json) over saved page contexts (evals/tutor/contexts/*.json)
// through the real tutor turn (helper/src/tutor.ts runTutorTurn, real sealed calls) and applies mechanical checks.
// It is deliberately NOT a single score: one table per class, with latency beside it (docs/audit/product-gap.md s8).
//   node scripts/eval-tutor.ts [--class explain] [--case explain-03] [--limit N] [--concurrency 2] [--baseline] [--no-sample]
// Cost: about 2 sealed calls per case, micro-dollars. Keys are read by helper/src/zg.ts only and never printed here.
// A run with ISHARA_ROUTER_URL set talks to the local fake router: mechanics only, written to a different file and
// shouted about, so nothing from it can be mistaken for a measured number (docs/DECISIONS.md decision 8).
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { collect, runChecks, formatTable, percentile, type Case, type Ctx, type Row, type TutorEventLike } from "../evals/tutor/checks.ts";

const DIR = "evals/tutor";
const args = process.argv.slice(2);
const flag = (n: string) => args.includes("--" + n);
const val = (n: string) => { const i = args.indexOf("--" + n); return i >= 0 ? args[i + 1] : undefined; };
const testRouter = !!process.env.ISHARA_ROUTER_URL?.trim();

export function loadCases(dir = DIR): Case[] {
  return readdirSync(dir).filter((f) => f.endsWith(".json")).sort().flatMap((f) => JSON.parse(readFileSync(join(dir, f), "utf8")) as Case[]);
}
export const loadContext = (name: string, dir = DIR): any => JSON.parse(readFileSync(join(dir, "contexts", name + ".json"), "utf8"));

type TurnFn = (req: any, deps: any) => AsyncGenerator<TutorEventLike>;

/** Run one case: fresh conversation + walk stores per case so cases cannot leak into each other; history is seeded. */
export async function runCase(c: Case, turn: TurnFn, mk: { convo: () => any; walks: () => any }, deps: any): Promise<{ row: Row; events: TutorEventLike[]; ctx: any }> {
  const ctx = loadContext(c.context);
  const convo = mk.convo(), walks = mk.walks();
  const tabId = "eval-" + c.id;
  for (const h of c.history ?? []) convo.record(tabId, ctx.url, { q: h.q, a: h.a, ...(h.pointedLabel ? { pointedLabel: h.pointedLabel } : {}) });
  const t0 = performance.now();
  const events: TutorEventLike[] = []; let firstSayMs: number | undefined;
  try {
    for await (const e of turn({ sessionId: tabId, tabId, question: c.question, context: ctx }, { ...deps, convo, walks })) {
      events.push(e);
      if (e.event === "say" && firstSayMs === undefined) firstSayMs = Math.round(performance.now() - t0);
    }
  } catch (err) {
    return { row: { id: c.id, class: c.class, pass: false, err: true, fails: ["exception:" + String((err as Error).message).slice(0, 80)], answer: "" }, events, ctx };
  }
  const totalMs = Math.round(performance.now() - t0);
  const rec = collect(events);
  const res = runChecks(c, rec, ctx as Ctx);
  // A refusal means the router could not answer: that is an infrastructure error, not a verdict on the prompt.
  const err = !!rec.refused;
  return { row: { id: c.id, class: c.class, pass: res.pass, err, fails: res.fails, answer: [...rec.says, ...rec.steps.map((s) => s.say)].join(" "), firstSayMs, totalMs }, events, ctx };
}

async function pool<T, R>(items: T[], n: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length); let i = 0;
  await Promise.all(Array.from({ length: Math.max(1, n) }, async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k]); } }));
  return out;
}

/** 12 randomly chosen answers with blank scores. Pass/fail is NOT shown, so Harsh scores blind (human-rubric.md). */
export function sampleMarkdown(items: { c: Case; title: string; answer: string }[], n = 12, rnd: () => number = Math.random): string {
  const pick = [...items].sort(() => rnd() - 0.5).slice(0, n);
  const lines = ["# Blind rubric sample", "", "Score each answer 1 to 5 using evals/tutor/human-rubric.md. Do not look at the eval table first.", ""];
  pick.forEach((p, i) => lines.push(`## ${i + 1}. (${p.c.id})`, `Page: ${p.title}`, ...(p.c.history?.length ? [`Earlier: "${p.c.history[0].q}" -> "${p.c.history[0].a}"`] : []), `Question: ${p.c.question}`, `Answer: ${p.answer || "(nothing)"}`, "Score (1-5): ", "Note: ", ""));
  return lines.join("\n");
}

// ---- the "before" suite: the audit's 20 live questions, through the OLD decide() path. Expected: 0 of 20 explained.
const BASELINE: { ctx: string; q: string; kind: string; explains?: string[] }[] = [
  { ctx: "mock-verify", q: "what does the optimizer runs setting mean", kind: "explain", explains: ["execut", "times", "200"] },
  { ctx: "mock-verify", q: "why?", kind: "follow-up", explains: ["execut", "times", "200"] },
  { ctx: "mock-verify", q: "what is this page about", kind: "explain", explains: ["verif", "source code"] },
  { ctx: "mock-verify", q: "which compiler version should I pick", kind: "judgement", explains: ["match", "same version", "compiled"] },
  { ctx: "mock-verify", q: "walk me through filling this form", kind: "walk", explains: ["first", "then"] },
  { ctx: "mock-verify", q: "and then?", kind: "follow-up", explains: ["next", "then"] },
  { ctx: "mock-verify", q: "where do I paste my contract address", kind: "point" },
  { ctx: "mock-verify", q: "what does this error mean", kind: "absent", explains: ["not visible", "don't see", "no error"] },
  { ctx: "mock-verify", q: "show me the license dropdown", kind: "point" },
  { ctx: "wikipedia-ethereum", q: "what is this page about", kind: "explain", explains: ["blockchain", "smart contract"] },
  { ctx: "wikipedia-ethereum", q: "summarize this section", kind: "explain", explains: ["Buterin", "2013", "blockchain"] },
  { ctx: "wikipedia-ethereum", q: "what does proof of stake mean", kind: "explain", explains: ["validator", "stake", "Merge"] },
  { ctx: "wikipedia-ethereum", q: "where is the search box", kind: "point" },
  { ctx: "github-ishara", q: "what is this project and what does it do", kind: "explain", explains: ["tutor", "sealed", "ring"] },
  { ctx: "github-ishara", q: "what do I do next to run it", kind: "walk", explains: ["npm", "extension"] },
  { ctx: "github-ishara", q: "where is the Code button", kind: "point" },
  { ctx: "github-ishara", q: "why does it refuse to answer when the network is down", kind: "explain", explains: ["unreachable", "local model"] },
  { ctx: "solidity-docs", q: "what is this page telling me", kind: "explain", explains: ["Solidity", "smart contract"] },
  { ctx: "solidity-docs", q: "what should I read first as a beginner", kind: "judgement", explains: ["Introduction to Smart Contracts", "Solidity by Example"] },
  { ctx: "solidity-docs", q: "what about the next one", kind: "follow-up", explains: ["Solidity by Example", "Installing"] },
];
async function baseline() {
  const { decide } = await import("../helper/src/decide.ts");
  let explained = 0; const rows: any[] = [];
  for (const [i, b] of BASELINE.entries()) {
    const ctx = loadContext(b.ctx);
    const outline = { url: ctx.url, viewport: ctx.viewport, elements: ctx.controls.map((x: any) => ({ id: x.id, label: x.label, role: x.role, rect: x.rect })), text: ctx.controls.map((x: any) => `[${x.id}] ${x.role} "${x.label}"`).join("\n") };
    const d = await decide("baseline-" + i, b.q, outline as any);
    // "Explained" = the old path's spoken line actually contains a fact an explanation needs. Pointer-only questions are not counted.
    const ok = !!b.explains && b.explains.some((m) => d.say.toLowerCase().includes(m.toLowerCase()));
    if (ok) explained++;
    rows.push({ q: b.q, kind: b.kind, outcome: d.outcome, target: d.targetId ?? "", say: d.say, explained: ok });
    console.log(`${ok ? "EXPLAINED" : "-        "}  ${b.q.padEnd(54)} -> ${d.outcome.padEnd(9)} ${d.say.slice(0, 60)}`);
  }
  const asked = BASELINE.filter((b) => b.explains).length;
  console.log(`\nBASELINE (old decide() path): ${explained} of ${asked} explanation-type questions explained (audit recorded 0 of 20).`);
  mkdirSync("helper/.data", { recursive: true });
  writeFileSync("helper/.data/eval-tutor-baseline" + (testRouter ? "-test-router" : "") + ".json", JSON.stringify({ testRouter, explained, asked, rows }, null, 2));
}

async function main() {
  if (testRouter) console.log("*** TEST ROUTER (not real 0G): numbers may not be quoted ***\n");
  if (flag("baseline")) { await baseline(); return; }
  let cases = loadCases();
  const cl = val("class"), one = val("case"), lim = Number(val("limit") ?? 0);
  if (cl) cases = cases.filter((c) => c.class === cl);
  if (one) cases = cases.filter((c) => c.id === one);
  if (lim > 0) cases = cases.slice(0, lim);
  if (!cases.length) { console.error("no cases match"); process.exit(2); }
  const { runTutorTurn, realTutorDeps } = await import("../helper/src/tutor.ts");
  const { ConvoStore } = await import("../helper/src/convo.ts");
  const { WalkStore } = await import("../helper/src/walk.ts");
  const mk = { convo: () => new ConvoStore(), walks: () => new WalkStore() };
  const done: { c: Case; row: Row; events: TutorEventLike[]; title: string }[] = [];
  await pool(cases, Number(val("concurrency") ?? 2), async (c) => {
    const r = await runCase(c, runTutorTurn as TurnFn, mk, realTutorDeps);
    done.push({ c, row: r.row, events: r.events, title: r.ctx.title });
    console.log(`${r.row.err ? "ERR " : r.row.pass ? "PASS" : "FAIL"}  ${c.id.padEnd(14)} ${r.row.fails.join("; ").slice(0, 90)}`);
  });
  const rows = cases.map((c) => done.find((d) => d.c.id === c.id)!.row);
  console.log("\n" + formatTable(rows));
  const tot = rows.length, ok = rows.filter((r) => r.pass).length;
  console.log(`\n(${ok}/${tot} passed overall: for orientation only; read the per-class rows above, never quote this total)`);
  if (testRouter) console.log("TEST ROUTER (not real 0G): numbers may not be quoted");
  mkdirSync("helper/.data", { recursive: true });
  const out = testRouter ? "helper/.data/eval-tutor-test-router.json" : "helper/.data/eval-tutor-latest.json";
  writeFileSync(out, JSON.stringify({ at: new Date().toISOString(), testRouter, ...(testRouter ? { warning: "TEST ROUTER (not real 0G): do not quote" } : {}), rows, raw: done.map((d) => ({ id: d.c.id, question: d.c.question, events: d.events })) }, null, 2));
  console.log("saved", out);
  if (!flag("no-sample") && !testRouter && cases.length >= 12) {
    writeFileSync("helper/.data/eval-tutor-sample.md", sampleMarkdown(done.map((d) => ({ c: d.c, title: d.title, answer: d.row.answer }))));
    console.log("blind sample: helper/.data/eval-tutor-sample.md");
  }
  void percentile;
}
if (import.meta.url === `file://${process.argv[1]}`) await main();
