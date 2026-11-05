// Shared shapes from docs/INTERFACES.md, kept in one file so helper modules agree.
export type OutlineElement = {
  id: string;
  label: string;
  role: string;
  rect: { x: number; y: number; w: number; h: number };
};
export type Outline = {
  url: string;
  viewport: { w: number; h: number };
  elements: OutlineElement[];
  text: string;
};
export type Cause = "timeout" | "unavailable" | "offline";
export type BrainResult =
  | { ok: true; targetId: string | null; requestId?: string; ms: number }
  | { ok: false; cause: Cause };
export type LayaResult =
  | { ok: true; choice: string; p: number; requestId?: string; ms: number }
  | { ok: false; cause: Cause };
export type Decision = {
  outcome: "point" | "ask" | "ask_which" | "safe_stop";
  targetId?: string;
  candidates?: string[];
  say: string;
  reason: string;
  safeStopCause?: Cause;
  requestIds: { brain?: string; laya?: string };
  ms: { total: number; brain?: number; laya?: number };
};
