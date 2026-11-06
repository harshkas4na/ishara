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

/** The same redaction, applied again on the helper to a PageContext that arrived over HTTP, before it reaches 0GM.
 *  The extension redacts first; this is the second lock for an older extension build or any other client. Idempotent:
 *  "[redacted]" stays "[redacted]". Returns a new object; ids, kinds, rects and booleans are untouched. */
export function scrubContext<T extends Record<string, any>>(ctx: T): T {
  if (!ctx || typeof ctx !== "object") return ctx;
  const B = readerCore() as Core & { phraseRunMask(texts: string[]): boolean[] };
  const r = (s: unknown) => (typeof s === "string" ? B.redact(s) : s);
  const blocks = Array.isArray(ctx.blocks) ? ctx.blocks.map((b: any) => (b && typeof b === "object" ? { ...b, text: r(b.text) } : b)) : ctx.blocks;
  if (Array.isArray(blocks)) { const m = B.phraseRunMask(blocks.map((b: any) => String(b?.text ?? ""))); blocks.forEach((b: any, i: number) => { if (m[i] && b) b.text = B.REDACTED; }); }
  let controls = Array.isArray(ctx.controls) ? ctx.controls.map((c: any) => {
    if (!c || typeof c !== "object") return c;
    const o: any = { ...c, label: r(c.label) };
    if (typeof c.errorText === "string") o.errorText = r(c.errorText);
    if (c.state && typeof c.state === "object") {
      o.state = { ...c.state };
      if (typeof o.state.value === "string") o.state.value = r(o.state.value);
      if (typeof o.state.selectedOption === "string") o.state.selectedOption = r(o.state.selectedOption);
    }
    return o;
  }) : ctx.controls;
  if (Array.isArray(controls)) {
    const lm = B.phraseRunMask(controls.map((c: any) => String(c?.label ?? "")));
    const vm2 = B.phraseRunMask(controls.map((c: any) => String(c?.state?.value ?? "")));
    controls = controls.map((c: any, i: number) => (!c ? c : { ...c, ...(lm[i] ? { label: B.REDACTED } : {}), ...(vm2[i] ? { state: { ...c.state, value: B.REDACTED } } : {}) }));
  }
  return { ...ctx, title: r(ctx.title), blocks, controls, ...(typeof ctx.selection === "string" ? { selection: r(ctx.selection) } : {}) };
}
