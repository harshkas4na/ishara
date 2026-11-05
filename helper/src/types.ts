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
  | { ok: true; targetId: string | null; sentence?: string; requestId?: string; chatId?: string; provider?: string; ms: number; testRouter?: boolean }
  | { ok: false; cause: Cause; testRouter?: boolean };
export type VerifyResult =
  | { ok: true; p: number; requestId?: string; chatId?: string; provider?: string; ms: number; testRouter?: boolean } // laya's P(yes): "is this control what the user asked for?"
  | { ok: false; cause: Cause; testRouter?: boolean };
export type Decision = {
  outcome: "point" | "ask" | "ask_which" | "safe_stop";
  targetId?: string;
  candidates?: string[];
  say: string;
  reason: string;
  safeStopCause?: Cause;
  proposedId?: string; // what 0GM proposed, even if laya then rejected it
  layaP?: number;      // laya's P(yes) for that proposal
  requestIds: { brain?: string; laya?: string };
  ms: { total: number; brain?: number; laya?: number };
  testRouter?: boolean; // dev only: answered by the local fake router (test/fake-router), NOT by 0G
};
