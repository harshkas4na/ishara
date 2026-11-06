import { test } from "node:test";
import assert from "node:assert/strict";
import { Wallet, hashMessage } from "ethers";
import { verifyMaterial, fetchProof, pickSigner, getServiceRecord } from "../src/proof.ts";

// Fixture signed in-test with a throwaway key: same EIP-191 scheme the provider uses, no network.
const signer = Wallet.createRandom();
const text = "zg-sig-v1/e2ee-ct:" + "ab".repeat(32) + ":" + "cd".repeat(32);
const base = { chatId: "chat-1", provider: signer.address, model: "m", url: "https://x", text };

test("recovers the signer and matches", async () => {
  const p = verifyMaterial({ ...base, signature: await signer.signMessage(text) }, signer.address);
  assert.equal(p.match, true);
  assert.equal(p.recoveredSigner, signer.address);
  assert.match(p.note, /not prove the exact words/);
});

test("a different on-chain signer gives match=false", async () => {
  const p = verifyMaterial({ ...base, signature: await signer.signMessage(text) }, Wallet.createRandom().address);
  assert.equal(p.match, false);
});

test("altered signed text no longer matches", async () => {
  const sig = await signer.signMessage(text);
  assert.equal(verifyMaterial({ ...base, text: text + "x", signature: sig }, signer.address).match, false);
  assert.notEqual(hashMessage(text), hashMessage(text + "x"));
});

test("TargetSeparated picks TargetTeeAddress (capitalised keys)", () => {
  const other = Wallet.createRandom().address;
  assert.equal(pickSigner(signer.address, JSON.stringify({ TargetSeparated: true, TargetTeeAddress: other })), other);
  assert.equal(pickSigner(signer.address, "not json"), signer.address);
});

test("404 is an explicit expired result", async () => {
  // Fake lookup and fake provider HTTP: this test must not depend on a live provider still being registered
  // (on 2026-11-06 the laya provider's on-chain record reverted).
  const r = await fetchProof({
    chatId: "gone", provider: "0x743cD1F17903cF6cC94ff4792b51929876f51023",
    lookup: async () => ({ url: "https://provider.invalid", model: "laya", signer: "0x0000000000000000000000000000000000000001" }),
    fetchImpl: async () => new Response('{"error":"chat_id_not_found"}', { status: 404 }),
  });
  assert.equal(r.status, "expired");
});

// Live read-only: provider service record from the mainnet Inference contract (measured working in the lab).
// Opt-in (ISHARA_LIVE=1, and ISHARA_LAYA_PROVIDER for a provider that is registered today): `npm test` makes no network call.
// A revert is a FAILURE (the provider is gone or changed), never a skip; only a network error skips (audit 4, section 5).
test("live service record for laya provider", { timeout: 20_000, skip: process.env.ISHARA_LIVE !== "1" && "live test: set ISHARA_LIVE=1" }, async (t) => {
  let s;
  try { s = await getServiceRecord(process.env.ISHARA_LAYA_PROVIDER ?? "0x743cD1F17903cF6cC94ff4792b51929876f51023"); }
  catch (e: any) { if (e?.code === "CALL_EXCEPTION") throw e; return t.skip("RPC unreachable: " + e.message); }
  assert.match(s.url, /^https?:\/\//);
  assert.match(s.signer, /^0x[0-9a-fA-F]{40}$/);
  assert.equal(s.acknowledged, true);
});

test("audit 4: an unacknowledged signer or a non-TEE service is 'unattested', never ok", async () => {
  const svc = { url: "https://p.invalid", model: "laya", signer: "0x0000000000000000000000000000000000000001" };
  const never = async () => { throw new Error("must not fetch"); };
  const a = await fetchProof({ chatId: "c", provider: "0x743cD1F17903cF6cC94ff4792b51929876f51023", lookup: async () => ({ ...svc, acknowledged: false }), fetchImpl: never as any });
  assert.equal(a.status, "error"); assert.equal((a as any).cause, "unattested");
  const b = await fetchProof({ chatId: "c", provider: "0x743cD1F17903cF6cC94ff4792b51929876f51023", lookup: async () => ({ ...svc, acknowledged: true, verifiability: "none" }), fetchImpl: never as any });
  assert.equal((b as any).cause, "unattested");
});
test("audit 4: a signed text that is not a zg-sig-v1 record is refused", async () => {
  const r = await fetchProof({ chatId: "c", provider: "0x743cD1F17903cF6cC94ff4792b51929876f51023",
    lookup: async () => ({ url: "https://p.invalid", model: "laya", signer: "0x0000000000000000000000000000000000000001", acknowledged: true, verifiability: "TeeML" }),
    fetchImpl: async () => new Response(JSON.stringify({ text: "anything at all", signature: "0x00" }), { status: 200 }) });
  assert.equal(r.status, "error"); assert.match((r as any).detail, /zg-sig-v1/);
});
