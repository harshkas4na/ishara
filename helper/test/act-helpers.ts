// Shared fixtures for the act tests (fakes only).
import { readFileSync } from "node:fs";
import type { PageContext } from "../src/types.ts";

export const verifyCtx = (): PageContext => JSON.parse(readFileSync(new URL("../../evals/tutor/contexts/mock-verify.json", import.meta.url), "utf8"));
export const canaryCtx = (): PageContext => JSON.parse(readFileSync(new URL("../../evals/tutor/contexts/injection-canary.json", import.meta.url), "utf8"));
const rect = { x: 0, y: 0, w: 1, h: 1 };
/** A small page built by hand: ctl("b1","input","Name") etc. */
export function page(controls: Array<[string, string, string] | [string, string, string, Record<string, unknown>]>, blocks: string[] = [], over: Partial<PageContext> = {}): PageContext {
  return {
    source: "browser", url: "http://127.0.0.1:7777/test/x.html", title: "Test page", viewport: { w: 1000, h: 800 },
    blocks: blocks.map((text, i) => ({ id: "t" + i, kind: "p" as const, text, inView: true })),
    controls: controls.map(([id, role, label, extra]) => ({ id, role, label, rect, ...(extra ?? {}) })),
    errors: [], ...over,
  };
}
