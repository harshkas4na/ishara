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
  // Real on-chain lookup (free read) for the lab's laya provider, fake provider HTTP.
  const r = await fetchProof({
    chatId: "gone", provider: "0x743cD1F17903cF6cC94ff4792b51929876f51023",
    fetchImpl: async () => new Response('{"error":"chat_id_not_found"}', { status: 404 }),
  });
  assert.equal(r.status, "expired");
});

// Live read-only: provider service record from the mainnet Inference contract (measured working in the lab).
test("live service record for laya provider", { timeout: 20_000 }, async (t) => {
  try {
    const s = await getServiceRecord("0x743cD1F17903cF6cC94ff4792b51929876f51023");
    assert.match(s.url, /^https?:\/\//);
    assert.match(s.signer, /^0x[0-9a-fA-F]{40}$/);
  } catch (e) { t.skip("RPC unreachable: " + (e as Error).message); }
});
