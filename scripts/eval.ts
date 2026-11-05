// Eval: replay a real captured page outline through the real decision path (real 0G calls) with clear and
// vague questions, and print what the gate did. This is where the threshold and the shortlist get tuned from
// evidence, and its table goes in the README.
//   node scripts/eval.ts [--memory] [outline.json]      (default: the captured mock verify page)
// Cost: two sealed calls per case, micro-dollars.
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decide } from "../helper/src/decide.ts";
import { Memory, hostOf } from "../helper/src/memory.ts";
import type { Outline } from "../helper/src/types.ts";

// Memory: the eval ALWAYS uses a throwaway memory dir (never the user's real one). `--memory` seeds it with plausible
// history for the page's host and turns on ISHARA_MEMORY=1, so the same table can be compared with the plain run.
// The env must be set before the first decide() call: the shared memory instance is created lazily.
const useMemory = process.argv.includes("--memory");
const memDir = mkdtempSync(join(tmpdir(), "ishara-eval-mem-"));
process.env.ISHARA_MEMORY_DIR = memDir;
if (useMemory) process.env.ISHARA_MEMORY = "1"; else delete process.env.ISHARA_MEMORY;
const args = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const file = args[0] ?? "helper/.data/outlines/http_127_0_0_1_7777_test_etherscan_verify_html.json";
const outline: Outline = JSON.parse(readFileSync(file, "utf8"));

if (useMemory) {
  // History a real user of this page could have: their own words for controls, each followed twice or more.
  // Labels are taken from the page itself so every seeded alias points at a control that exists.
  const host = hostOf(outline.url);
  const labelOf = (re: RegExp) => outline.elements.find((e) => /input|select|textarea|combobox/.test(e.role) && re.test(e.label))?.label; // form controls only
  let t = Date.now() - 86_400_000;
  const seeder = new Memory(memDir, () => t);
  const seeds: [string, string | undefined][] = [
    ["where do I put the wallet address", labelOf(/contract address/i)],
    ["paste my wallet address here", labelOf(/contract address/i)],
    ["where is the version dropdown", labelOf(/compiler version/i)],
    ["pick the version", labelOf(/compiler version/i)],
    ["where do I paste the code", labelOf(/source code|solidity/i)],
    ["put my code in", labelOf(/source code|solidity/i)],
  ];
  seeds.forEach(([q, label], i) => {
    if (!label) return;
    t += 120_000; seeder.recordAsk("seed" + i, host, q, "point", label);
    t += 3_000; seeder.recordAccepted("seed" + i, host, q);
  });
  console.log(`memory ON (seeded ${seeder.view().counts.accepted} accepted events for ${host}); context: ${seeder.context(host)}\n`);
}
// expect: the element id a clear question must point at, or "ask" for a vague one (ask or ask_which both count).
const CASES: { q: string; expect: string }[] = [
  { q: "where do I put the contract address", expect: "b6" },
  { q: "how do I choose the compiler version", expect: "b8" },
  { q: "where do I pick the compiler type", expect: "b7" },
  { q: "where do I paste my solidity source code", expect: "b11" },
  { q: "how do I select the license", expect: "b9" },
  { q: "where do I accept the terms of service", expect: "b10" },
  { q: "where is the optimizer runs setting", expect: "b13" },
  { q: "where do I add constructor arguments", expect: "b14" },
  { q: "how do I submit this for verification", expect: "b17" },
  { q: "how do I clear the form", expect: "b18" },
  { q: "where is the verification guide", expect: "b16" },
  { q: "how do I turn optimization on", expect: "b12" },
  { q: "help", expect: "ask" },
  { q: "what do I do", expect: "ask" },
  { q: "is my contract safe", expect: "ask" },
  { q: "I am stuck", expect: "ask" },
  { q: "next step", expect: "ask" },
  { q: "where is it", expect: "ask" },
];

const rows: any[] = [];
for (const c of CASES) {
  const d = await decide("eval-" + CASES.indexOf(c), c.q, outline) /* own session per case: no "missed" chaining between cases */;
  const ok = c.expect === "ask" ? d.outcome === "ask" || d.outcome === "ask_which" : d.outcome === "point" && d.targetId === c.expect;
  const wrongPoint = d.outcome === "point" && d.targetId !== c.expect;
  rows.push({ q: c.q, expect: c.expect, outcome: d.outcome, target: d.targetId ?? "", ok, wrongPoint, reason: d.reason, ms: d.ms.total });
  console.log(`${ok ? "PASS" : wrongPoint ? "WRONG-POINT" : "MISS "}  ${c.q.padEnd(44)} -> ${d.outcome.padEnd(9)} ${String(d.targetId ?? "").padEnd(4)} ${d.reason}  [${d.ms.total} ms]`);
}
const clear = rows.filter((r) => r.expect !== "ask");
const vague = rows.filter((r) => r.expect === "ask");
console.log(`\nclear: ${clear.filter((r) => r.ok).length}/${clear.length} pointed correctly, ${clear.filter((r) => r.wrongPoint).length} wrong points`);
console.log(`vague: ${vague.filter((r) => r.ok).length}/${vague.length} asked instead of pointing`);
mkdirSync("helper/.data", { recursive: true });
writeFileSync(useMemory ? "helper/.data/eval-latest-memory.json" : "helper/.data/eval-latest.json", JSON.stringify(rows, null, 2));
