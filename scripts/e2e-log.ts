// End to end on the real network: real sealed calls through 0G, their proofs, the encrypted log on 0G Storage,
// the root on the Galileo contract, and the replay from storage. Costs micro-dollars and ~0.002 testnet 0G.
//   node scripts/e2e-log.ts
// The full decision (0GM + laya) is tried first. If 0GM's single private provider is down (it returns 502, seen
// 2026-11-05), the receipts are still exercised with real laya calls, and the script says so.
import { readFileSync } from "node:fs";
import { decide } from "../helper/src/decide.ts";
import { episodeLog } from "../helper/src/episode-log.ts";
import { askVerify, LAYA_MODEL } from "../helper/src/zg.ts";
import type { Outline } from "../helper/src/types.ts";

const outline: Outline = JSON.parse(readFileSync("helper/.data/outlines/http_127_0_0_1_7777_test_etherscan_verify_html.json", "utf8"));
const sid = "e2e-" + Date.now();
const q = "where do I put the contract address";

// --storage-only: skip the router entirely (it was down on 2026-11-05) and test the log, 0G Storage, the contract
// and the replay with clearly marked test entries that carry no proofs.
const storageOnly = process.argv.includes("--storage-only");
const d = storageOnly ? { outcome: "storage-only", targetId: undefined, requestIds: {} } : await decide(sid, q, outline);
console.log(`decide: ${d.outcome} ${d.targetId ?? ""} ids=${JSON.stringify(d.requestIds)}`);
if (storageOnly) {
  for (const text of [q, "how do I choose the compiler version"])
    episodeLog.record(sid, { question: text, outcome: "test-entry", say: "", reason: "storage-only e2e, not a model decision", calls: [] });
} else if (d.outcome === "safe_stop") {
  console.log("0GM unavailable: exercising the receipts with real laya calls instead");
  for (const text of [q, "how do I choose the compiler version"]) {
    const el = outline.elements.find((e) => e.id === (text === q ? "b6" : "b8"))!;
    const v = await askVerify(text, el);
    if (!v.ok) { console.error("laya failed too:", v.cause); process.exit(1); }
    episodeLog.record(sid, { question: text, outcome: "laya-check", say: "", reason: "e2e", calls: [{ role: "laya", model: LAYA_MODEL, requestId: v.requestId, chatId: v.chatId, provider: v.provider }] });
  }
}

const log = episodeLog.getLog(sid);
for (const e of log.entries) for (const c of e.calls) console.log(`  call ${c.role} requestId=${c.requestId ? "yes" : "NO"} chatId=${c.chatId ? "yes" : "NO"} provider=${c.provider ? c.provider.slice(0, 8) + "…" : "NO"}`);

for (const e of log.entries) for (const c of e.calls) {
  const p = await episodeLog.getProof(c.requestId!);
  console.log(`proof(${c.role}):`, p.status, "match=" + p.match, p.recoveredSigner ? "signer=" + p.recoveredSigner.slice(0, 10) + "… onChain=" + p.onChainSigner.slice(0, 10) + "…" : "", p.detail ?? "");
}

const end = await episodeLog.endSession(sid);
console.log("endSession:", JSON.stringify(end));
const rep = await episodeLog.replay(sid);
console.log("replay: verified=" + rep.verified, "entries=" + rep.entries?.length, "onChainRootMatches=" + rep.onChainRootMatches, rep.error ?? "");
if (!rep.verified || end.error) process.exit(1);
