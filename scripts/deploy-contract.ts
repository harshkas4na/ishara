// Compile contracts/SessionRoot.sol with the solc npm package (forge is not installed), write the ABI and
// bytecode next to it, and deploy to Galileo ONLY if the wallet file exists and has a balance.
// Usage: node scripts/deploy-contract.ts
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { ContractFactory, JsonRpcProvider, Wallet } from "ethers";
import { GALILEO_RPC, GALILEO_CHAIN_ID, WALLET_PATH, readWalletKey, WalletMissingError } from "../helper/src/storage.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const solc = createRequire(import.meta.url)("solc");

export function compile(): { abi: unknown[]; bytecode: string } {
  const source = readFileSync(join(root, "contracts", "SessionRoot.sol"), "utf8");
  const input = { language: "Solidity", sources: { "SessionRoot.sol": { content: source } },
    settings: { optimizer: { enabled: true, runs: 200 }, outputSelection: { "*": { "*": ["abi", "evm.bytecode.object"] } } } };
  const out = JSON.parse(solc.compile(JSON.stringify(input)));
  const errors = (out.errors ?? []).filter((e: { severity: string }) => e.severity === "error");
  if (errors.length) throw new Error(errors.map((e: { formattedMessage: string }) => e.formattedMessage).join("\n"));
  const c = out.contracts["SessionRoot.sol"].SessionRoot;
  return { abi: c.abi, bytecode: "0x" + c.evm.bytecode.object };
}

async function main() {
  const { abi, bytecode } = compile();
  mkdirSync(join(root, "contracts", "out"), { recursive: true });
  writeFileSync(join(root, "contracts", "out", "SessionRoot.json"), JSON.stringify({ abi, bytecode }, null, 2));
  console.log("compiled contracts/SessionRoot.sol -> contracts/out/SessionRoot.json");
  console.log("ABI:", JSON.stringify(abi));

  let key: string;
  try { key = readWalletKey(); }
  catch (e) {
    if (e instanceof WalletMissingError) { console.log(`NOT DEPLOYED. Missing: wallet file ${WALLET_PATH} (one private key line). Then fund it with Galileo 0G from the faucet.`); return; }
    throw e;
  }
  const provider = new JsonRpcProvider(GALILEO_RPC, GALILEO_CHAIN_ID);
  const wallet = new Wallet(key, provider);
  const bal = await provider.getBalance(wallet.address);
  if (bal === 0n) { console.log(`NOT DEPLOYED. Missing: balance. Wallet ${wallet.address} holds 0 0G on Galileo; fund it from the faucet.`); return; }
  const c = await new ContractFactory(abi as never, bytecode, wallet).deploy();
  await c.waitForDeployment();
  const address = await c.getAddress();
  writeFileSync(join(root, "contracts", "out", "deployed.json"), JSON.stringify({ chainId: GALILEO_CHAIN_ID, address }, null, 2));
  console.log("DEPLOYED SessionRoot at", address, "(chain 16602); saved to contracts/out/deployed.json");
}
// Only run when invoked directly, so the compile-only test can import compile().
if (process.argv[1] === fileURLToPath(import.meta.url)) main().catch((e) => { console.error(e.message); process.exit(1); });
