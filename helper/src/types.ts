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

// ---- Tutor types (docs/TUTOR-INTERFACE.md sections 1, 2, 6). Tutor core only; the old pointing types above are untouched.
export type Block = {
  id: string; // "t12"
  kind: "p" | "h" | "li" | "code" | "cell" | "error" | "caption" | "text";
  text: string;
  inView: boolean;
  rect?: { x: number; y: number; w: number; h: number };
};
export type ControlState = { checked?: boolean; value?: string; selectedOption?: string; disabled?: boolean; empty?: boolean; filledChars?: number; required?: boolean; invalid?: boolean };
export type Control = OutlineElement & { state?: ControlState; errorText?: string };
export type PageContext = {
  source: "browser" | "desktop";
  app?: string; url: string; title: string; viewport: { w: number; h: number };
  blocks: Block[];
  controls: Control[];
  selection?: string; focused?: string;
  errors: string[];
  truncated?: { blocks: number; controls: number };
  screenshot?: string;
};
export type TutorMode = "point" | "explain" | "guide" | "follow-up";
export type TutorRequest = { sessionId: string; tabId?: string; question: string; context: PageContext; mode?: "auto" | "point" | "explain" | "guide"; speak?: boolean };
export type WalkCmd = "next" | "back" | "repeat" | "stop" | "where";
export type WalkRequest = { sessionId: string; tabId?: string; cmd: WalkCmd; context?: PageContext };
export type PointStatus = "confirmed" | "rejected" | "suppressed";
export type TutorOutcome = "answered" | "refused" | "cutoff";
export type TutorCallRef = { role: "brain" | "laya"; model: string; requestId?: string; chatId?: string; provider?: string };
export type TutorEvent =
  | { event: "thinking"; data: { mode: TutorMode } }
  | { event: "say"; data: { seq: number; text: string } }
  | { event: "point"; data: { seq: number; targetId: string; kind: "control" | "block"; status: PointStatus; layaP?: number; reason: string } }
  | { event: "step"; data: { n: number; m: number; say: string; targetId?: string; kind?: "control" | "block" } }
  | { event: "done"; data: { mode: TutorMode; outcome: TutorOutcome; cause?: Cause; requestIds: { brain?: string; laya: string[] }; ms: { firstToken?: number; total: number }; testRouter?: true; calls: TutorCallRef[] } }
  | { event: "refused"; data: { cause: Cause; say: string } };
// What a streamed 0GM call yields: text chunks, then exactly one of meta (the stream ended, maybe cut off) or error (nothing usable arrived).
export type TutorStreamItem =
  | { type: "delta"; text: string }
  | { type: "meta"; requestId?: string; chatId?: string; provider?: string; firstTokenMs?: number; totalMs: number; cutoff?: true; testRouter?: true }
  | { type: "error"; cause: Cause; totalMs: number; testRouter?: true };
export type ChatMessage = { role: "system" | "user" | "assistant"; content: string };
// laya's answer about one pointer. Same shape pointer-gate.ts returns, so the default dep is a straight pass-through.
export type PointerVerdict =
  | { ok: true; p: number; requestId?: string; chatId?: string; provider?: string; testRouter?: true; ms?: number }
  | { ok: false; cause: Cause };
export type TutorDeps = {
  askStream: (messages: ChatMessage[], opts?: { timeoutMs?: number }) => AsyncGenerator<TutorStreamItem>;
  checkPointer: (question: string, target: { id: string; kind: "control" | "block"; label: string; role?: string }) => Promise<PointerVerdict>;
  now?: () => number;
};
