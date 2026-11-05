// The receipts, with fakes for the network. The product never uses these fakes; they exist to test the paths that
// are hard to hit for real: an expired signature, a failed upload, a flaky proof fetch.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EpisodeLog, type Deps, type CallRef } from "../src/episode-log.ts";
import { encryptLog } from "../src/storage.ts";
import type { ProofResult } from "../src/proof.ts";

const okProof = (chatId: string): ProofResult => ({
  status: "ok", ms: 5,
  proof: { requestId: chatId, provider: "0xprov", recoveredSigner: "0xaa", onChainSigner: "0xaa", match: true, fetchedAt: "now", note: "n" },
  material: { chatId, provider: "0xprov", model: "m", url: "u", text: "t", signature: "s" },
});

function make(over: Partial<Deps> = {}) {
  const stored = new Map<string, Buffer>();
  const deps: Deps = {
    fetchProof: async (o) => okProof(o.chatId),
    upload: async (b) => { const root = "0x" + "ab".repeat(32); stored.set(root, Buffer.from(b)); return { root, txHash: "0xtx", ms: 1 }; },
    download: async () => { throw new Error("set per test"); },
    recordOnChain: async () => ({ address: "0xcontract", txHash: "0xctx" }),
    retryDelayMs: 1,
    ...over,
  };
  return { log: new EpisodeLog(deps, mkdtempSync(join(tmpdir(), "ishara-log-"))), deps, stored };
}
const call = (n: string): CallRef => ({ role: "brain", model: "0gm", requestId: "req-" + n, chatId: "chat-" + n, provider: "0xprov" });
const rec = (log: EpisodeLog, sid: string, calls: CallRef[]) => log.record(sid, { question: "q", outcome: "point", targetId: "b1", say: "s", reason: "r", calls });

test("a decision's proof is fetched in the background and returned by request id", async () => {
  const { log } = make();
  rec(log, "s1", [call("1")]);
  const p = await log.getProof("req-1");
  assert.equal(p.status, "ok"); assert.equal(p.match, true);
});

test("a call with no chat id is recorded as unavailable, never as proven", async () => {
  const { log } = make();
  rec(log, "s1", [{ role: "laya", model: "laya", requestId: "req-x" }]);
  const p = await log.getProof("req-x");
  assert.equal(p.status, "unavailable"); assert.equal(p.match, false);
});

test("an expired signature is reported as expired", async () => {
  const { log } = make({ fetchProof: async (o) => ({ status: "expired", requestId: o.chatId, detail: "gone" }) });
  rec(log, "s1", [call("1")]);
  assert.equal((await log.getProof("req-1")).status, "expired");
});

test("a flaky fetch is retried and then succeeds", async () => {
  let n = 0;
  const { log } = make({ fetchProof: async (o) => (++n < 3 ? { status: "error", requestId: o.chatId, cause: "network", detail: "blip" } : okProof(o.chatId)) });
  rec(log, "s1", [call("1")]);
  assert.equal((await log.getProof("req-1")).status, "ok");
  assert.equal(n, 3);
});

test("an unknown request id is reported as unknown", async () => {
  const { log } = make();
  assert.equal((await log.getProof("nope")).status, "unknown");
});

test("endSession encrypts before upload and records the root on chain", async () => {
  const { log, stored } = make();
  rec(log, "s1", [call("1")]);
  const r = await log.endSession("s1");
  assert.equal(r.error, undefined); assert.ok(r.root); assert.equal(r.contract?.address, "0xcontract");
  const bytes = [...stored.values()][0].toString("utf8");
  assert.ok(!bytes.includes("req-1") && !bytes.includes("\"question\""), "stored bytes must be ciphertext");
});

test("a failed upload is reported as failed and the local log stays", async () => {
  const { log } = make({ upload: async () => { throw new Error("storage down"); } });
  rec(log, "s1", [call("1")]);
  const r = await log.endSession("s1");
  assert.match(r.error ?? "", /upload to 0G Storage failed/); assert.equal(r.root, undefined);
  assert.equal(log.getLog("s1").entries.length, 1);
});

test("a failed contract write is reported, with the storage root still returned", async () => {
  const { log } = make({ recordOnChain: async () => { throw new Error("no gas"); } });
  rec(log, "s1", [call("1")]);
  const r = await log.endSession("s1");
  assert.ok(r.root); assert.match(r.error ?? "", /contract write failed/);
});

test("ending a session with no decisions says so", async () => {
  const { log } = make();
  assert.match((await log.endSession("empty")).error ?? "", /no decisions/);
});

test("replay refuses a session that was never stored, and reports a failed download instead of faking success", async () => {
  const { log, deps } = make();
  rec(log, "s1", [call("1")]);
  assert.match((await log.replay("s1")).error ?? "", /not been stored/);
  await log.endSession("s1");
  deps.download = async () => { throw new Error("wrong key or altered bytes"); };
  const bad = await log.replay("s1");
  assert.equal(bad.verified, false); assert.match(bad.error ?? "", /wrong key/);
});

test("encryptLog output can never be mistaken for the plaintext", () => {
  const e = encryptLog("hello", Buffer.alloc(32, 1));
  assert.ok(!e.ciphertext.toString("utf8").includes("hello"));
});

test("two End session clicks upload once and write the root once", async () => {
  let uploads = 0, writes = 0;
  const { log } = make({
    upload: async () => { uploads++; await new Promise((r) => setTimeout(r, 20)); return { root: "0x" + "cd".repeat(32), txHash: "0xtx", ms: 20 }; },
    recordOnChain: async () => { writes++; return { address: "0xcontract", txHash: "0xctx" }; },
  });
  rec(log, "s2", [call("2")]);
  const [a, b] = await Promise.all([log.endSession("s2"), log.endSession("s2")]);
  assert.equal(uploads, 1); assert.equal(writes, 1);
  assert.equal(a.root, b.root);
});

test("a slow proof in one session does not hold up another session's proof", async () => {
  const { log } = make({
    fetchProof: async (o) => { if (o.chatId === "chat-slow") await new Promise((r) => setTimeout(r, 300)); return okProof(o.chatId); },
  });
  rec(log, "slow", [call("slow")]);
  rec(log, "fast", [call("fast")]);
  const t0 = Date.now();
  assert.equal((await log.getProof("req-fast")).status, "ok");
  assert.ok(Date.now() - t0 < 200, "waited for the other session");
});
