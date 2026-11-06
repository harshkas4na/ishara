// Per-answer proof: fetch the provider's signature for a chat id, recover the signer, compare with the
// on-chain TEE signer. Method = docs "Option C", measured in lab FINDINGS section 9.
//
// LIMIT (say it everywhere this is shown): through the Router the signed text is NOT
// sha256(bytes we sent):sha256(bytes we got), so this proves "a sealed provider answered this chat id",
// not "these exact words".
import { Contract, JsonRpcProvider, getAddress, hashMessage, recoverAddress } from "ethers";

export type Proof = {
  requestId: string; provider: string; recoveredSigner: string; onChainSigner: string;
  match: boolean; fetchedAt: string; note: string;
};

/** Raw material the episode log stores, because the provider only serves it for ~20 minutes. */
export type SignatureMaterial = { chatId: string; provider: string; model: string; url: string; text: string; signature: string };

export type ProofResult =
  | { status: "ok"; proof: Proof; material: SignatureMaterial; ms: number }
  // 404 chat_id_not_found: window is 20 min (served at 19.1 min, gone at 20.9 min, measured).
  | { status: "expired"; requestId: string; detail: string }
  | { status: "error"; requestId: string; cause: "service_lookup" | "network" | "http" | "bad_body" | "unattested"; detail: string };

// Mainnet Inference contract + RPC (docs note section 3, measured). The Router serves mainnet providers.
export const MAINNET_RPC = "https://evmrpc.0g.ai";
export const INFERENCE_CONTRACT = "0x47340d900bdFec2BD393c626E12ea0656F938d84";
// ABI fragment read from the compute SDK's typechain factory (struct field order matters for decoding).
const SERVICE_ABI = [
  "function getService(address provider) view returns (tuple(address provider, string serviceType, string url, uint256 inputPrice, uint256 outputPrice, uint256 updatedAt, string model, string verifiability, string additionalInfo, address teeSignerAddress, bool teeSignerAcknowledged) service)",
];

export const PROOF_NOTE =
  "Proves that a provider whose TEE signer is registered and acknowledged on-chain signed the record it serves for this chat id. " +
  "It does not prove the exact words: through the Router the signed text is a pair of hashes the provider saw " +
  "(\"zg-sig-v1/...\"), not a hash of the bytes we received, and it does not contain the chat id itself.";

export type ServiceRecord = { url: string; model: string; signer: string; acknowledged?: boolean; verifiability?: string };

/** Audit 4: a signer the contract marks as not acknowledged, or a service that does not declare TEE verification, proves nothing sealed. */
export function attestationProblem(svc: ServiceRecord): string | null {
  if (svc.acknowledged === false) return "the provider's TEE signer is not acknowledged on-chain";
  if (svc.verifiability !== undefined && !/tee/i.test(svc.verifiability)) return `the provider does not declare TEE verification (verifiability "${svc.verifiability.slice(0, 30)}")`;
  return null;
}
/** The signed text format seen from the Router on 6 Nov 2026. Anything else is not the record we know how to read. */
export const SIGNED_TEXT = /^zg-sig-v1\/[a-z0-9-]+:[0-9a-f]{64}:[0-9a-f]{64}$/i;

/** Pick the signer per the SDK: teeSignerAddress unless additionalInfo says TargetSeparated (capitalised keys). */
export function pickSigner(teeSignerAddress: string, additionalInfo: string): string {
  try {
    const info = JSON.parse(additionalInfo || "{}");
    if (info.TargetSeparated === true && info.ProviderType !== "centralized" && info.TargetTeeAddress) {
      return getAddress(info.TargetTeeAddress);
    }
  } catch { /* additionalInfo is free text on some providers; fall back to the main signer */ }
  return getAddress(teeSignerAddress);
}

// Service records change rarely; cache so each answer costs one HTTP call, not an RPC call too.
const serviceCache = new Map<string, ServiceRecord>();

export async function getServiceRecord(provider: string, rpcUrl = MAINNET_RPC): Promise<ServiceRecord> {
  const key = getAddress(provider);
  const hit = serviceCache.get(key);
  if (hit) return hit;
  const c = new Contract(INFERENCE_CONTRACT, SERVICE_ABI, new JsonRpcProvider(rpcUrl));
  const s = await c.getService(key);
  const rec = { url: String(s.url).replace(/\/+$/, ""), model: String(s.model), signer: pickSigner(s.teeSignerAddress, s.additionalInfo), acknowledged: Boolean(s.teeSignerAcknowledged), verifiability: String(s.verifiability ?? "") };
  serviceCache.set(key, rec);
  return rec;
}

/** Pure: EIP-191 recovery + comparison. Split out so it is testable on a fixture with no network. */
export function verifyMaterial(m: SignatureMaterial, onChainSigner: string, now = new Date()): Proof {
  const recovered = recoverAddress(hashMessage(m.text), m.signature);
  return {
    requestId: m.chatId, provider: m.provider, recoveredSigner: recovered, onChainSigner: getAddress(onChainSigner),
    match: recovered.toLowerCase() === onChainSigner.toLowerCase(), fetchedAt: now.toISOString(), note: PROOF_NOTE,
  };
}

/**
 * Fetch and verify the proof for one answer. `chatId` is the ZG-Res-Key header (or data.id), NOT x_0g_trace.request_id.
 * Call it right after the answer, off the decision path; the signature is gone after ~20 minutes.
 */
export async function fetchProof(opts: { chatId: string; provider: string; rpcUrl?: string; timeoutMs?: number; fetchImpl?: typeof fetch; lookup?: (provider: string, rpcUrl?: string) => Promise<ServiceRecord> }): Promise<ProofResult> {
  const { chatId, provider } = opts;
  const f = opts.fetchImpl ?? fetch;
  const t0 = Date.now();
  let svc: ServiceRecord;
  try { svc = await (opts.lookup ?? getServiceRecord)(provider, opts.rpcUrl); } // lookup is a test seam; the product never sets it
  catch (e) { return { status: "error", requestId: chatId, cause: "service_lookup", detail: String((e as Error).message) }; }
  const unatt = attestationProblem(svc);
  if (unatt) return { status: "error", requestId: chatId, cause: "unattested", detail: unatt };

  let res: Response;
  try {
    res = await f(`${svc.url}/v1/proxy/signature/${encodeURIComponent(chatId)}?model=${encodeURIComponent(svc.model)}`,
      { signal: AbortSignal.timeout(opts.timeoutMs ?? 8000) });
  } catch (e) { return { status: "error", requestId: chatId, cause: "network", detail: String((e as Error).message) }; }

  if (res.status === 404) return { status: "expired", requestId: chatId, detail: (await res.text().catch(() => "")).slice(0, 200) };
  if (!res.ok) return { status: "error", requestId: chatId, cause: "http", detail: `HTTP ${res.status}` };

  let body: { text?: unknown; signature?: unknown };
  try { body = await res.json(); } catch { return { status: "error", requestId: chatId, cause: "bad_body", detail: "not JSON" }; }
  if (typeof body.text !== "string" || typeof body.signature !== "string") {
    return { status: "error", requestId: chatId, cause: "bad_body", detail: "missing text or signature" };
  }
  if (!SIGNED_TEXT.test(body.text)) return { status: "error", requestId: chatId, cause: "bad_body", detail: "the signed text is not the zg-sig-v1 record this check knows" };
  const material: SignatureMaterial = { chatId, provider: getAddress(provider), model: svc.model, url: svc.url, text: body.text, signature: body.signature };
  try {
    return { status: "ok", proof: verifyMaterial(material, svc.signer), material, ms: Date.now() - t0 };
  } catch (e) { return { status: "error", requestId: chatId, cause: "bad_body", detail: "signature did not parse: " + (e as Error).message }; }
}
