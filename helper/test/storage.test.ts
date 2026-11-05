import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { encryptLog, decryptLog, newLogKey, IntegrityError, WALLET_PATH, computeRoot, uploadToStorage, downloadAndDecrypt } from "../src/storage.ts";

const text = JSON.stringify({ q: "where do I paste the address", id: "b17" });

test("round trip", () => {
  const key = newLogKey();
  const { ciphertext, plaintextSha256 } = encryptLog(text, key);
  assert.equal(decryptLog(ciphertext, key, plaintextSha256).toString(), text);
});

test("wrong key is detected", () => {
  const { ciphertext, plaintextSha256 } = encryptLog(text, newLogKey());
  assert.throws(() => decryptLog(ciphertext, newLogKey(), plaintextSha256), IntegrityError);
});

test("tampered ciphertext is detected", () => {
  const key = newLogKey();
  const { ciphertext, plaintextSha256 } = encryptLog(text, key);
  ciphertext[20] ^= 1;
  assert.throws(() => decryptLog(ciphertext, key, plaintextSha256), IntegrityError);
});

test("a hash that does not match the plaintext is detected", () => {
  const key = newLogKey();
  const { ciphertext } = encryptLog(text, key);
  assert.throws(() => decryptLog(ciphertext, key, "00".repeat(32)), /hash mismatch/);
});

test("root is deterministic for the same bytes", async () => {
  const b = encryptLog(text, newLogKey()).ciphertext;
  assert.equal(await computeRoot(b), await computeRoot(b));
});

// Live: costs about 0.001 0G of testnet gas, only when the wallet file exists.
test("live upload and download", { skip: !existsSync(WALLET_PATH) && "wallet file missing", timeout: 180_000 }, async () => {
  const key = newLogKey();
  const { ciphertext, plaintextSha256 } = encryptLog(text, key);
  const up = await uploadToStorage(ciphertext);
  assert.equal(up.root, await computeRoot(ciphertext));
  assert.equal((await downloadAndDecrypt(up.root, key, plaintextSha256)).toString(), text);
});
