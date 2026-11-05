// Encrypted session log -> 0G Storage (Galileo testnet, Turbo indexer). Lab FINDINGS section 8.
//
// Deviation from the lab, on purpose: the SDK's own encryption is AES-256-CTR (no authentication, a wrong key
// returns garbage silently). We encrypt ourselves with AES-256-GCM (wrong key / tampering throws) and upload the
// already-encrypted bytes. That also makes "wrap then root" trivial: the root is computed over exactly the bytes we
// upload, so it is known before the upload and equals the stored root. We still return the plaintext SHA-256
// separately, because the contract/log keeps it as the integrity anchor and decrypt re-checks it.
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { JsonRpcProvider, Wallet } from "ethers";
import { Indexer, MemData } from "@0gfoundation/0g-storage-ts-sdk";

// Galileo testnet (chain id 16602) and the Turbo indexer (docs note section 6, endpoints measured).
export const GALILEO_RPC = "https://evmrpc-testnet.0g.ai";
export const GALILEO_CHAIN_ID = 16602;
export const TURBO_INDEXER = "https://indexer-storage-testnet-turbo.0g.ai";
export const WALLET_PATH = join(homedir(), ".config", "0g", "wallet");
export const UPLOAD_TIMEOUT_MS = 120_000; // storage never sits on the decision path; cap it anyway

const VERSION = 1; // first ciphertext byte, so the format can change without guessing

/** Thrown when ~/.config/0g/wallet is absent or empty. Callers (and tests) treat it as "skip the live part". */
export class WalletMissingError extends Error {
  constructor(path = WALLET_PATH) { super(`wallet missing: put one private key line in ${path} (this code never creates keys)`); this.name = "WalletMissingError"; }
}
export class IntegrityError extends Error {
  constructor(msg: string) { super(msg); this.name = "IntegrityError"; }
}

/** Fresh random 32-byte AES key for one session. Not a wallet key. */
export const newLogKey = (): Buffer => randomBytes(32);
export const sha256Hex = (b: Uint8Array | string): string => createHash("sha256").update(b).digest("hex");

export type Encrypted = { ciphertext: Buffer; plaintextSha256: string };

/** AES-256-GCM. Layout: [version 1B][iv 12B][ciphertext][tag 16B]. Key must be 32 bytes. */
export function encryptLog(plaintext: Uint8Array | string, key: Uint8Array): Encrypted {
  if (key.length !== 32) throw new Error("key must be 32 bytes");
  const pt = typeof plaintext === "string" ? Buffer.from(plaintext, "utf8") : Buffer.from(plaintext);
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, iv);
  const body = Buffer.concat([c.update(pt), c.final()]);
  return { ciphertext: Buffer.concat([Buffer.from([VERSION]), iv, body, c.getAuthTag()]), plaintextSha256: sha256Hex(pt) };
}

/** Inverse of encryptLog. Throws IntegrityError on a wrong key, tampering, or a plaintext hash mismatch. */
export function decryptLog(ciphertext: Uint8Array, key: Uint8Array, expectedSha256: string): Buffer {
  const ct = Buffer.from(ciphertext);
  if (ct.length < 1 + 12 + 16 || ct[0] !== VERSION) throw new IntegrityError("not an Ishara log blob (bad version or too short)");
  let pt: Buffer;
  try {
    const d = createDecipheriv("aes-256-gcm", key, ct.subarray(1, 13));
    d.setAuthTag(ct.subarray(ct.length - 16));
    pt = Buffer.concat([d.update(ct.subarray(13, ct.length - 16)), d.final()]);
  } catch {
    throw new IntegrityError("decryption failed: wrong key or the stored bytes were altered");
  }
  // GCM already authenticates; the hash check also ties the log to the value recorded elsewhere (contract / proof sheet).
  const got = sha256Hex(pt);
  if (got !== expectedSha256.toLowerCase().replace(/^0x/, "")) {
    throw new IntegrityError(`plaintext hash mismatch: expected ${expectedSha256}, got ${got}`);
  }
  return pt;
}

/** Reads the one-line private key. Never logs it. */
export function readWalletKey(path = WALLET_PATH): string {
  if (!existsSync(path)) throw new WalletMissingError(path);
  const k = readFileSync(path, "utf8").trim().split(/\s+/)[0];
  if (!k) throw new WalletMissingError(path);
  return k.startsWith("0x") ? k : "0x" + k;
}

export function getSigner(path = WALLET_PATH): Wallet {
  return new Wallet(readWalletKey(path), new JsonRpcProvider(GALILEO_RPC, GALILEO_CHAIN_ID));
}

/** Merkle root of the exact bytes (computed locally, ~0.04 s; matched the uploaded root in the lab). */
export async function computeRoot(bytes: Uint8Array): Promise<string> {
  const [tree, err] = await new MemData(bytes).merkleTree();
  if (err || !tree) throw new Error("merkle tree failed: " + err);
  return tree.rootHash() as string;
}

export type UploadResult = { root: string; txHash: string; ms: number };

/** Upload already-encrypted bytes. Resolves when the SDK reports the upload finished; rejects on timeout. */
export async function uploadToStorage(bytes: Uint8Array, signer: Wallet = getSigner()): Promise<UploadResult> {
  const t0 = Date.now();
  const localRoot = await computeRoot(bytes);
  const indexer = new Indexer(TURBO_INDEXER);
  const work = indexer.upload(new MemData(bytes), GALILEO_RPC, signer);
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new Error(`0G Storage upload exceeded ${UPLOAD_TIMEOUT_MS} ms`)), UPLOAD_TIMEOUT_MS); });
  try {
    const [res, err] = await Promise.race([work, timeout]);
    if (err) throw err;
    if (!("rootHash" in res)) throw new Error("unexpected fragmented upload result");
    if (res.rootHash !== localRoot) throw new IntegrityError(`stored root ${res.rootHash} differs from local root ${localRoot}`);
    return { root: res.rootHash, txHash: res.txHash, ms: Date.now() - t0 };
  } finally { clearTimeout(timer); }
}

/** Download with Merkle proof, then decrypt and verify. A wrong key or altered data throws IntegrityError. */
export async function downloadAndDecrypt(root: string, key: Uint8Array, expectedSha256: string): Promise<Buffer> {
  const [blob, err] = await new Indexer(TURBO_INDEXER).downloadToBlob(root, { proof: true });
  if (err || !blob) throw new Error("0G Storage download failed: " + err);
  return decryptLog(new Uint8Array(await blob.arrayBuffer()), key, expectedSha256);
}
