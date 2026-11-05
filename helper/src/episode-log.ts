// episode-log.ts: the receipts. For every decision the tutor makes, keep what is needed to prove later that a
// sealed 0G provider made it, and at the end of the session put the whole log on 0G Storage, encrypted, with its
// root written to a contract on Galileo.
//
// The order of work is dictated by one fact: the provider serves its signature for only ~20 minutes (measured
// 19.1-20.9). So the signature is fetched RIGHT AFTER each answer, in the background, and stored in the log
// entry. Waiting for the session to end would lose the early ones.
//
// What the proof does and does not say is in PROOF_NOTE (proof.ts): "a sealed provider with this on-chain signer
// answered this chat id", not "these exact words". Everything shown to a user repeats that limit.
import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Contract, JsonRpcProvider, keccak256, toUtf8Bytes } from "ethers";
import { fetchProof, PROOF_NOTE, type Proof, type ProofResult, type SignatureMaterial } from "./proof.ts";
import {
  encryptLog, decryptLog, newLogKey, uploadToStorage, downloadAndDecrypt, getSigner, sha256Hex,
  GALILEO_RPC, GALILEO_CHAIN_ID, type UploadResult,
} from "./storage.ts";
import { APP_NAME } from "./config.ts";

// Local only, gitignored: holds each session's log key. Under `node --test` a temp dir, so test decisions never show
// up as sessions on the home page (they did: "s", "x1", "sess" were test runs).
const DATA_DIR = process.env.NODE_TEST_CONTEXT ? join(tmpdir(), `ishara-sessions-test-${process.pid}`) : "helper/.data/sessions";
const CONTRACT_DIR = "contracts/out";

export type CallRef = { role: "brain" | "laya"; model: string; requestId?: string; chatId?: string; provider?: string };
export type ProofState =
  | { status: "ok"; proof: Proof; material: SignatureMaterial }
  | { status: "pending" | "expired" | "error" | "unavailable"; detail?: string };
export type Entry = {
  at: string; question: string; outcome: string; targetId?: string; say: string; reason: string;
  calls: Array<CallRef & { proof: ProofState }>;
  testRouter?: true; // dev only: from the fake router, so replay shows a TEST ROUTER chip
};
type Session = {
  sessionId: string; startedAt: string; keyHex: string; entries: Entry[];
  ended?: { root: string; plaintextSha256: string; storage: { txHash: string; ms: number }; contract?: { address: string; txHash: string }; contractError?: string; at: string };
};

// Test seams. The product uses the real ones; tests pass fakes (never in the product path).
export type Deps = {
  fetchProof: (o: { chatId: string; provider: string }) => Promise<ProofResult>;
  upload: (bytes: Uint8Array) => Promise<UploadResult>;
  download: (root: string, key: Uint8Array, sha: string) => Promise<Buffer>;
  recordOnChain: (sessionId: string, root: string) => Promise<{ address: string; txHash: string }>;
  retryDelayMs: number;
};

export type EndResult = { entries: number; root?: string; plaintextSha256?: string; storage?: { txHash: string; ms: number }; contract?: { address: string; txHash: string }; error?: string };

export const sessionKeyId = (sessionId: string): string => keccak256(toUtf8Bytes(sessionId)); // the bytes32 the contract stores

function contractInfo(): { address: string; abi: unknown[] } | null {
  try {
    const dep = JSON.parse(readFileSync(join(CONTRACT_DIR, "deployed.json"), "utf8"));
    const art = JSON.parse(readFileSync(join(CONTRACT_DIR, "SessionRoot.json"), "utf8"));
    return { address: dep.address, abi: art.abi };
  } catch { return null; }
}

async function recordOnChainReal(sessionId: string, root: string): Promise<{ address: string; txHash: string }> {
  const info = contractInfo();
  if (!info) throw new Error("contract not deployed: run `node scripts/deploy-contract.ts`");
  const c = new Contract(info.address, info.abi as never, getSigner());
  const tx = await c.record(sessionKeyId(sessionId), root.startsWith("0x") ? root : "0x" + root);
  await tx.wait();
  return { address: info.address, txHash: tx.hash };
}

const realDeps: Deps = {
  fetchProof: (o) => fetchProof(o),
  upload: (b) => uploadToStorage(b),
  download: (root, key, sha) => downloadAndDecrypt(root, key, sha),
  recordOnChain: recordOnChainReal,
  retryDelayMs: 2000,
};

export class EpisodeLog {
  private sessions = new Map<string, Session>();
  private pending = new Map<string, Set<Promise<void>>>(); // proof fetches still running; each removes itself when done
  private ending = new Map<string, Promise<EndResult>>(); // a second "End session" click joins the first upload
  private deps: Deps;
  private dir: string;
  // No parameter properties: Node runs this file by stripping types, which only supports plain syntax.
  constructor(deps: Deps = realDeps, dir = DATA_DIR) { this.deps = deps; this.dir = dir; mkdirSync(this.dir, { recursive: true }); }

  private file(id: string): string { return join(this.dir, id.replace(/[^a-zA-Z0-9_-]/g, "_") + ".json"); }
  private persist(s: Session): void { writeFileSync(this.file(s.sessionId), JSON.stringify(s)); }
  private session(id: string): Session | undefined {
    let s = this.sessions.get(id);
    if (!s && existsSync(this.file(id))) { s = JSON.parse(readFileSync(this.file(id), "utf8")) as Session; this.sessions.set(id, s); }
    return s;
  }

  /** One decision just happened. Store it and start fetching each call's proof in the background. */
  record(sessionId: string, d: { question: string; outcome: string; targetId?: string; say: string; reason: string; calls: CallRef[]; testRouter?: boolean }): Entry {
    let s = this.session(sessionId);
    if (!s) {
      s = { sessionId, startedAt: new Date().toISOString(), keyHex: newLogKey().toString("hex"), entries: [] };
      this.sessions.set(sessionId, s);
    }
    const entry: Entry = {
      at: new Date().toISOString(), question: d.question, outcome: d.outcome,
      ...(d.targetId ? { targetId: d.targetId } : {}), say: d.say, reason: d.reason,
      ...(d.testRouter ? { testRouter: true as const } : {}),
      calls: d.calls.map((c) => ({ ...c, proof: (c.chatId && c.provider ? { status: "pending" } : { status: "unavailable", detail: "the response carried no chat id or provider" }) as ProofState })),
    };
    s.entries.push(entry);
    this.persist(s);
    const jobs = this.pending.get(sessionId) ?? new Set();
    for (const call of entry.calls) if (call.proof.status === "pending") {
      const job: Promise<void> = this.collectProof(s, call).finally(() => jobs.delete(job));
      jobs.add(job);
    }
    this.pending.set(sessionId, jobs);
    return entry;
  }

  // Fetch, and retry a couple of times on a network hiccup: the window is long (20 min) but the signature is the
  // one thing that cannot be recovered later, so a single flaky request must not lose it.
  private async collectProof(s: Session, call: CallRef & { proof: ProofState }): Promise<void> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const r = await this.deps.fetchProof({ chatId: call.chatId!, provider: call.provider! }).catch((e): ProofResult => ({ status: "error", requestId: call.chatId!, cause: "network", detail: String(e?.message ?? e) }));
      if (r.status === "ok") { call.proof = { status: "ok", proof: r.proof, material: r.material }; break; }
      if (r.status === "expired") { call.proof = { status: "expired", detail: r.detail }; break; }
      call.proof = { status: "error", detail: `${r.cause}: ${r.detail}` };
      if (attempt < 2) await new Promise((res) => setTimeout(res, this.deps.retryDelayMs));
    }
    this.persist(s);
  }

  /** For the "How do I know?" button: the proof for one request id (or chat id). Waits for an in-flight fetch. */
  async getProof(requestId: string): Promise<Proof & { status: string; detail?: string }> {
    const find = () => { for (const s of this.sessions.values()) for (const e of s.entries) for (const c of e.calls) if (c.requestId === requestId || c.chatId === requestId) return { s, c }; };
    let hit = find();
    if (!hit) { this.list(); hit = find(); } // sessions from an earlier helper run are on disk, not yet in memory
    if (hit) {
      const { s, c } = hit;
      // Wait only for this session's fetches (at most ~30 s with retries), not every session's.
      if (c.proof.status === "pending") await Promise.allSettled(this.pending.get(s.sessionId) ?? []);
      if (c.proof.status === "ok") return { ...c.proof.proof, requestId, status: "ok" };
      return {
        requestId, provider: c.provider ?? "", recoveredSigner: "", onChainSigner: "", match: false,
        fetchedAt: new Date().toISOString(), status: c.proof.status, detail: c.proof.detail, note: PROOF_NOTE,
      };
    }
    return { requestId, provider: "", recoveredSigner: "", onChainSigner: "", match: false, fetchedAt: new Date().toISOString(), status: "unknown", detail: "no decision with that id in this helper", note: PROOF_NOTE };
  }

  list(): Array<{ sessionId: string; startedAt: string; decisions: number; root?: string; testRouter?: true }> {
    const ids = new Set([...this.sessions.keys()]);
    if (existsSync(this.dir)) for (const f of readdirSync(this.dir)) { try { ids.add(JSON.parse(readFileSync(join(this.dir, f), "utf8")).sessionId); } catch { /* skip */ } }
    return [...ids].map((id) => this.session(id)!).filter(Boolean).map((s) => ({ sessionId: s.sessionId, startedAt: s.startedAt, decisions: s.entries.length, root: s.ended?.root,
      // A session with any fake-router answer is marked in the list too, not only inside the replay.
      ...(s.entries.some((e) => e.testRouter) ? { testRouter: true as const } : {}) }));
  }

  getLog(sessionId: string): { entries: Entry[]; ended?: Session["ended"] } {
    const s = this.session(sessionId);
    return { entries: s?.entries ?? [], ended: s?.ended };
  }

  /**
   * End of session: wait for the proofs still in flight, encrypt the whole log, put it on 0G Storage, write its
   * root to the contract. Each step that fails is reported as failed (never as done); the local copy always stays.
   */
  async endSession(sessionId: string): Promise<EndResult> {
    const running = this.ending.get(sessionId);
    if (running) return running;
    const p = this.endOnce(sessionId).finally(() => this.ending.delete(sessionId));
    this.ending.set(sessionId, p);
    return p;
  }
  private async endOnce(sessionId: string): Promise<EndResult> {
    const s = this.session(sessionId);
    if (!s || s.entries.length === 0) return { entries: 0, error: "no decisions were recorded for this session" };
    if (s.ended) return { entries: s.entries.length, root: s.ended.root, plaintextSha256: s.ended.plaintextSha256, storage: s.ended.storage, contract: s.ended.contract };
    await Promise.race([Promise.allSettled(this.pending.get(sessionId) ?? []), new Promise((r) => setTimeout(r, 15000))]);

    const plaintext = JSON.stringify({ app: APP_NAME, sessionId, startedAt: s.startedAt, endedAt: new Date().toISOString(), note: PROOF_NOTE, entries: s.entries });
    const enc = encryptLog(plaintext, Buffer.from(s.keyHex, "hex"));
    let up: UploadResult;
    try { up = await this.deps.upload(enc.ciphertext); }
    catch (e: any) { return { entries: s.entries.length, error: `upload to 0G Storage failed: ${e?.message ?? e} (the log is kept locally)` }; }

    s.ended = { root: up.root, plaintextSha256: enc.plaintextSha256, storage: { txHash: up.txHash, ms: up.ms }, at: new Date().toISOString() };
    try { s.ended.contract = await this.deps.recordOnChain(sessionId, up.root); }
    catch (e: any) { s.ended.contractError = String(e?.message ?? e); }
    this.persist(s);
    return {
      entries: s.entries.length, root: up.root, plaintextSha256: enc.plaintextSha256, storage: s.ended.storage, contract: s.ended.contract,
      ...(s.ended.contractError ? { error: `stored on 0G Storage, but the contract write failed: ${s.ended.contractError}` } : {}),
    };
  }

  /** Replay: fetch the log back from 0G Storage, decrypt it, check the hash, and compare the root with the chain. */
  async replay(sessionId: string): Promise<{ verified: boolean; entries?: Entry[]; root?: string; plaintextSha256?: string; onChainRootMatches?: boolean | null; error?: string }> {
    const s = this.session(sessionId);
    if (!s?.ended) return { verified: false, error: "this session has not been stored on 0G yet" };
    let pt: Buffer;
    try { pt = await this.deps.download(s.ended.root, Buffer.from(s.keyHex, "hex"), s.ended.plaintextSha256); }
    catch (e: any) { return { verified: false, root: s.ended.root, error: String(e?.message ?? e) }; }
    const parsed = JSON.parse(pt.toString("utf8"));
    let onChain: boolean | null = null;
    const info = contractInfo();
    if (info && s.ended.contract) {
      try {
        const c = new Contract(info.address, info.abi as never, new JsonRpcProvider(GALILEO_RPC, GALILEO_CHAIN_ID));
        onChain = String(await c.rootOf(sessionKeyId(sessionId))).toLowerCase() === (s.ended.root.startsWith("0x") ? s.ended.root : "0x" + s.ended.root).toLowerCase();
      } catch { onChain = null; }
    }
    return { verified: sha256Hex(pt) === s.ended.plaintextSha256, entries: parsed.entries, root: s.ended.root, plaintextSha256: s.ended.plaintextSha256, onChainRootMatches: onChain };
  }
}

export const episodeLog = new EpisodeLog();
export { decryptLog };
