// Eval: replay a real captured page outline through the real decision path (real 0G calls) with clear and
// vague questions, and print what the gate did. This is where the threshold and the shortlist get tuned from
// evidence, and its table goes in the README.
//   node scripts/eval.ts [outline.json]      (default: the captured mock verify page)
// Cost: two sealed calls per case, micro-dollars.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { decide } from "../helper/src/decide.ts";
import type { Outline } from "../helper/src/types.ts";

const file = process.argv[2] ?? "helper/.data/outlines/http_127_0_0_1_7777_test_etherscan_verify_html.json";
const outline: Outline = JSON.parse(readFileSync(file, "utf8"));

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
  const d = await decide("eval", c.q, outline);
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
writeFileSync("helper/.data/eval-latest.json", JSON.stringify(rows, null, 2));
