// The browser reader's redaction and neutralizer rules, callable from the helper.
// ONE source of truth: extension/blocks-core.js is a classic script (content scripts cannot be modules), so it is
// evaluated here in a vm context exactly as helper/test/blocks.test.ts does. The desktop path therefore gets the same
// rules byte for byte and can never drift from the browser: when the rules change there, they change here. (A port
// would need parity tests forever; this needs only the file to exist, and the test checks that it does.)
import { readFileSync } from "node:fs";
import vm from "node:vm";

const CORE_URL = new URL("../../extension/blocks-core.js", import.meta.url);

type SecretCtx = { type?: string; autocomplete?: string; text?: string };
export type Core = {
  REDACTED: string;
  BLOCK_MAX: number;
  isSecretField(f: SecretCtx): boolean;
  redact(text: string, ctx?: SecretCtx): string;
  neutralize(text: string): string;
  safeText(text: string, max?: number, ctx?: SecretCtx): string;
  estimateTokens(s: string): number;
  blockTokens(b: { text: string }): number;
  buildBlocks(records: any[], opts?: { controlLabels?: string[] }): Array<{ kind: string; text: string; inView: boolean; rect?: any; boiler?: boolean }>;
  trim(blocks: any[], budgetTokens: number): { blocks: any[]; dropped: number };
  number(blocks: any[]): Array<{ id: string; kind: string; text: string; inView: boolean; rect?: any }>;
  contextTokens(ctx: any): number;
};

let core: Core | null = null;
/** The reader core, loaded once. Throws (loudly) if the file is missing: sending unredacted text is never the fallback. */
export function readerCore(): Core {
  if (core) return core;
  const sandbox: any = {};
  vm.createContext(sandbox); // no require, no fs, no network inside the sandbox
  vm.runInContext(readFileSync(CORE_URL, "utf8"), sandbox, { filename: "blocks-core.js" });
  if (!sandbox.IsharaBlocks?.redact) throw new Error("extension/blocks-core.js did not export IsharaBlocks; refusing to build a desktop context without redaction");
  core = sandbox.IsharaBlocks as Core;
  return core;
}
