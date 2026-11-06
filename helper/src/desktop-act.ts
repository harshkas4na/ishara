// Agent mode on the desktop (docs/AGENT-MODE.md, docs/DESKTOP.md "Agent mode"). Three jobs, each with its outside effects
// injected so every rule is tested with fakes:
//   1. the EXECUTOR: one contract Action + the desktop PageContext -> the stable selector ishara-act re-finds the control by ->
//      cursor travels there -> ishara-act does it -> a fresh PageContext. Nothing the model says can skip a refusal here.
//   2. the VOICE and PILL side: "agent mode on/off", task-like sentences, yes/no for an approval, the stop word.
//   3. the TASK RUNNER: POST /act as the helper executor, the SSE events turned into pill commands, approval and stop.
// Never in this file: a screenshot or clipboard text going to 0G (the detail the loop sees says "copied N characters" and a
// path, never the content), a keystroke into a secret field, an action in a browser (the extension owns those).
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import type { Control, PageContext } from "./types.ts";
import {
  desktopContext, frontApp, isBrowserBundle, overlay, desktopAsk, BROWSER_HINT, selectorBook, overlayEventHooks,
  type FrontApp, type OverlayCmd, type ControlSelector,
} from "./desktop.ts";
import { readerCore } from "./redact.ts";
import { parseWalkCommand } from "./router.ts";
import { realSpeech } from "./desktop.ts";
import { HELPER_PORT } from "./config.ts";

export const ACT_BIN = fileURLToPath(new URL("../../desktop/ishara-act", import.meta.url));
export const ACT_TIMEOUT_MS = 5000;     // one action, as the plan says; ishara-act itself answers in well under 300 ms
export const CURSOR_TRAVEL_MS = 700;    // the cursor glides 0.75 s: the person SEES where it is going before it acts
export const SETTLE_MAX_MS = 1200;      // how long to wait for the UI to settle before re-reading it

// ---------- types (the contract's Action, structurally: this file must not depend on the core's modules) ----------
export type DesktopAction =
  | { type: "click"; id: string } | { type: "type"; id: string; text: string; clear?: boolean }
  | { type: "select"; id: string; option: string } | { type: "check"; id: string; checked: boolean }
  | { type: "key"; combo: string } | { type: "scroll"; direction: "up" | "down"; amount?: "line" | "page" }
  | { type: "open_url"; url: string } | { type: "open_app"; name: string } | { type: "quit_app"; name: string }
  | { type: "copy"; text: string } | { type: "screenshot"; to?: "clipboard" | "file" } | { type: "wait"; ms: number }
  | { type: "done"; say: string } | { type: "ask"; say: string } | { type: "fail"; say: string };
export type ActInput = { type: string; [k: string]: unknown };
export type ActRaw = { ok: boolean; detail: string; fallback?: string; x?: number; y?: number; permission?: string; path?: string };
export type ExecOut = { ok: boolean; detail: string; context: PageContext };

// ---------- stop flags ----------
// One desktop task runs at a time, so "stop all" is the normal case (a tap of Right Option, the pill's stop button, the word
// "stop"). requestStop(actId) is the same thing for one task. An executor made BEFORE the stop sees it; a later one does not.
const stoppedIds = new Set<string>();
let stopAllAt = 0;
let taskSince = 0;                            // when the current task began: the "stop all" that counts is one made after it
const activity = new Map<string, number>();   // actId -> last executor call: a task is "running" while it keeps calling us
export const requestStop = (actId: string): void => { stoppedIds.add(actId); };
export const requestStopAll = (now = Date.now()): void => { stopAllAt = now; };
export const clearStop = (actId: string): void => { stoppedIds.delete(actId); activity.delete(actId); };
export const isStopRequested = (actId: string, since: number): boolean => stoppedIds.has(actId) || (stopAllAt !== 0 && stopAllAt >= since);
export const endAct = clearStop;

// ---------- selectors ----------
export type Target = { id: string; role: string; label: string; rect?: { x: number; y: number; w: number; h: number }; control?: Control; selector?: ControlSelector };

const ID_BLOCK = /^t\d+$/;
/** The control or text block an id names in THIS context, or null. */
export function findTarget(ctx: PageContext, id: string, book = selectorBook): Target | null {
  if (ID_BLOCK.test(id)) {
    const b = ctx.blocks.find((x) => x.id === id);
    return b ? { id, role: "text", label: b.text, rect: b.rect } : null;
  }
  const c = ctx.controls.find((x) => x.id === id);
  if (!c) return null;
  const sel = book.get(ctx, id);
  return { id, role: c.role, label: c.label, rect: c.rect, control: c, selector: sel ?? undefined };
}

/** The stable selector ishara-act receives. Prefers the one ishara-ax emitted (it knows the raw AX role and the secure flag);
 *  otherwise it is rebuilt from the context: the index is the number of EARLIER controls with the same role and label, which
 *  is how ishara-ax counts (both walk in reading order). */
export function selectorFor(ctx: PageContext, t: Target, bundleId?: string): Record<string, unknown> {
  const title = ctx.title ?? "";
  if (t.role === "text") return { role: "text", label: t.label.slice(0, 80), index: 0, title, rect: t.rect, ...(bundleId ? { bundleId } : {}) };
  const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
  let index = t.selector?.index;
  if (index === undefined) {
    index = 0;
    for (const c of ctx.controls) { if (c.id === t.id) break; if (c.role === t.role && norm(c.label) === norm(t.label)) index++; }
  }
  return {
    role: t.role, label: t.label, index, title, rect: t.rect,
    ...(t.selector?.axRole ? { axRole: t.selector.axRole } : {}),
    ...(t.selector?.secure ? { secure: true } : {}),
    ...(bundleId ? { bundleId } : {}),
  };
}

/** A field that must never be typed into: a secure text field from AX, or one whose name says secret (the browser reader's
 *  own rule, shared through redact.ts, so the two paths cannot disagree). */
export function isSecretTarget(t: Target): boolean {
  if (t.selector?.secure || t.selector?.axRole === "AXSecureTextField") return true;
  const B = readerCore();
  return B.isSecretField({ type: "text", text: t.label }) || /pass(word|code|phrase)|seed|mnemonic|private.?key|secret|cvv|cvc|card.?number|\botp\b/i.test(t.label);
}

/** Contract Action -> the ishara-act input. Pure. Returns a string for a refusal the helper decides on by itself. */
export function toActInput(a: DesktopAction, ctx: PageContext, bundleId?: string): ActInput | { refuse: string } {
  const withTarget = (id: string, extra: ActInput): ActInput | { refuse: string } => {
    const t = findTarget(ctx, id);
    if (!t) return { refuse: `there is no control ${id} on this screen` };
    if ((extra.type === "setvalue" || extra.type === "check" || extra.option !== undefined) && isSecretTarget(t)) return { refuse: "secret field" };
    if (extra.type === "setvalue" && t.role !== "input") return { refuse: `"${t.label}" is not a text field` };
    return { ...extra, selector: selectorFor(ctx, t, bundleId) };
  };
  switch (a.type) {
    case "click": return withTarget(a.id, { type: "press" });
    case "type": return withTarget(a.id, { type: "setvalue", text: a.text, clear: a.clear === true });
    case "select": return withTarget(a.id, { type: "press", option: a.option });
    case "check": return withTarget(a.id, { type: "check", checked: a.checked });
    case "key": return { type: "key", combo: a.combo };
    case "scroll": return { type: "scroll", direction: a.direction, amount: a.amount ?? "line" };
    case "open_url": return { type: "open_url", url: a.url };
    case "open_app": return { type: "open_app", name: a.name };
    case "quit_app": return { type: "quit_app", name: a.name };
    case "copy": return { type: "copy", text: a.text };
    case "screenshot": return { type: "screenshot", scope: "window" };
    default: return { refuse: `${a.type} is not a desktop action` };
  }
}

// Actions the extension owns when the front app is a browser: anything that reads or drives the page.
const DOM_ACTIONS: ReadonlySet<string> = new Set(["click", "type", "select", "check", "scroll"]);
const TARGETED: ReadonlySet<string> = new Set(["click", "type", "select", "check"]);
// Whether the screen is likely to change, so it is worth waiting for it to settle before re-reading.
const CHANGES_SCREEN: ReadonlySet<string> = new Set(["click", "select", "key", "open_app", "open_url", "quit_app", "check"]);

/** Words for the pill or the approval prompt. Never includes the text of a copy or a typed secret beyond a short preview. */
export function actionInWords(a: DesktopAction, ctx?: PageContext): string {
  const lab = (id: string) => (ctx ? findTarget(ctx, id)?.label : "") || id;
  const clipT = (s: string, n = 40) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
  switch (a.type) {
    case "click": return `Click “${lab(a.id)}”`;
    case "type": return `Type “${clipT(a.text)}” into ${lab(a.id) ? `“${lab(a.id)}”` : "the field"}`;
    case "select": return `Choose “${a.option}” in “${lab(a.id)}”`;
    case "check": return `${a.checked ? "Turn on" : "Turn off"} “${lab(a.id)}”`;
    case "key": return `Press ${a.combo}`;
    case "scroll": return `Scroll ${a.direction}`;
    case "open_url": return `Open ${clipT(a.url, 60)}`;
    case "open_app": return `Open ${a.name}`;
    case "quit_app": return `Quit ${a.name}`;
    case "copy": return `Copy ${a.text.length} characters to the clipboard`;
    case "screenshot": return "Take a screenshot";
    case "wait": return "Wait a moment";
    default: return a.type;
  }
}

// ---------- the executor ----------
export type ActDeps = {
  run: (input: ActInput) => Promise<ActRaw>;
  send: (c: OverlayCmd) => void;
  readContext: () => Promise<PageContext>;
  front: () => Promise<FrontApp | null>;
  sleep: (ms: number) => Promise<void>;
  stopped: () => boolean;
  bundleId?: () => string | undefined;
  /** Draw the action in the pill too (the task runner does that from the `action` event; a bare executor can ask for it). */
  pill?: (text: string, step: number) => void;
  step?: number;
};

const homePath = (s: string) => s.split(homedir()).join("~"); // the path of a screenshot is for the person, not for the model's prompt

/** Run ishara-act once with a hard 5 s cut-off. Exit 2 = a macOS permission is missing: the detail says which. */
export function runActBin(input: ActInput, timeoutMs = ACT_TIMEOUT_MS): Promise<ActRaw> {
  return new Promise((resolve) => {
    if (!existsSync(ACT_BIN)) return resolve({ ok: false, detail: "ishara-act is not built. Run npm run desktop:build." });
    const p = spawn(ACT_BIN, [], { stdio: ["pipe", "pipe", "pipe"] });
    let out = "", err = "", timedOut = false;
    const timer = setTimeout(() => { timedOut = true; p.kill("SIGKILL"); }, timeoutMs);
    p.stdout.on("data", (c) => (out += c)); p.stderr.on("data", (c) => (err += c));
    p.on("error", (e) => { clearTimeout(timer); resolve({ ok: false, detail: `could not start ishara-act: ${e.message}` }); });
    p.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) return resolve({ ok: false, detail: "the app did not answer within 5 s, so I stopped" });
      try { const j = JSON.parse(out.trim().split("\n").pop() ?? ""); return resolve(j); }
      catch { resolve({ ok: false, detail: code === 2 || err.includes("ISHARA_PERMISSION") ? err.split("\n")[0] : `ishara-act failed (exit ${code})` }); }
    });
    p.stdin.on("error", () => {});
    p.stdin.end(JSON.stringify(input));
  });
}

const emptyContext = (app = ""): PageContext => ({ source: "desktop", app, url: `app://${app}`, title: "", viewport: { w: 0, h: 0 }, blocks: [], controls: [], errors: [] });
const ctxSig = (c: PageContext) => c.title + "|" + c.controls.map((x) => x.label + (x.state ? JSON.stringify(x.state) : "")).join(",") + "|" + c.blocks.slice(0, 30).map((b) => b.text).join(",");

/** One contract action, end to end. Never throws and never lies: a refusal, a stop and a failure all say why. */
export async function executeDesktopAction(action: DesktopAction, context: PageContext, deps: ActDeps): Promise<ExecOut> {
  const done = (ok: boolean, detail: string, ctx = context): ExecOut => ({ ok, detail: homePath(detail).slice(0, 300), context: ctx });
  try {
    if (deps.stopped()) return done(false, "stopped");
    if (action.type === "done" || action.type === "ask" || action.type === "fail") return done(true, "");
    if (action.type === "wait") { await deps.sleep(Math.max(0, Math.min(3000, Number(action.ms) || 0))); return done(true, "waited", await deps.readContext().catch(() => context)); }

    // 1. the browser guard: the extension executes DOM actions in browsers, never this path
    const front = await deps.front();
    if (front && isBrowserBundle(front.bundleId) && DOM_ACTIONS.has(action.type)) return done(false, "use the browser extension");

    // 2. map the action (refuses unknown ids and secret fields BEFORE Swift is even started)
    const input = toActInput(action, context, deps.bundleId?.());
    if ("refuse" in input) return done(false, input.refuse);
    const target = TARGETED.has(action.type) ? findTarget(context, (action as any).id) : null;

    // 3. visible: say it, then the cursor goes to the target and we give the person time to see it
    deps.pill?.(actionInWords(action, context), deps.step ?? 0);
    if (target?.rect) {
      const r = target.rect;
      deps.send({ cmd: "point", x: Math.round(r.x + r.w / 2), y: Math.round(r.y + r.h / 2), text: "", rect: r, keep: true, kind: target.role === "text" ? "block" : "control" });
      await deps.sleep(CURSOR_TRAVEL_MS);
    }
    if (deps.stopped()) return done(false, "stopped");

    // 4. do it. AX press first; the coordinate click only when ishara-act says AX could not press it, and never on a secret field
    let raw = await deps.run(input);
    if (!raw.ok && raw.fallback === "click_at" && target && !isSecretTarget(target) && typeof raw.x === "number" && typeof raw.y === "number" && !deps.stopped()) {
      raw = await deps.run({ type: "click_at", x: raw.x, y: raw.y });
      if (raw.ok) raw = { ...raw, detail: `${raw.detail} (AX could not press it, so I clicked its position)` };
    }

    // 5. let the UI settle, then read it again. A screen that read the same may simply not have caught up: one more try.
    const before = ctxSig(context);
    await deps.sleep(CHANGES_SCREEN.has(action.type) ? 350 : 200);
    let fresh = await deps.readContext().catch(() => null);
    if (fresh && CHANGES_SCREEN.has(action.type) && raw.ok && ctxSig(fresh) === before) {
      await deps.sleep(SETTLE_MAX_MS - 350 - 200);
      fresh = (await deps.readContext().catch(() => null)) ?? fresh;
    }
    // the clipboard content and screenshot pixels stay local: the detail is "copied N characters" / a path, nothing else
    return done(raw.ok, raw.detail || (raw.ok ? "ok" : "failed"), fresh ?? emptyContext(context.app));
  } catch (e: any) {
    return done(false, `executor error: ${String(e?.message ?? e).slice(0, 100)}`);
  }
}

const realActDeps = (actId: string, since: number, step: () => number): ActDeps => ({
  run: runActBin,
  send: (c) => overlay.send(c),
  readContext: async () => (await desktopContext()).context,
  front: frontApp,
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  stopped: () => isStopRequested(actId, since),
  step,
  bundleId: () => selectorBook.bundleId || undefined, // the app the context was read from: ishara-act refuses to act if the front app changed
});

/** The executor the core's loop injects for ONE task: `(action, context) => Promise<{ok, detail, context}>`. */
export function desktopExecutorFor(actId: string, over: Partial<ActDeps> = {}) {
  const since = Date.now();
  let n = 0;
  return (action: DesktopAction, context: PageContext): Promise<ExecOut> => {
    activity.set(actId, Date.now());
    n++;
    return executeDesktopAction(action, context, { ...realActDeps(actId, since, () => n), ...over });
  };
}

/** What server.ts's helperExecute calls (it does not know the actId): the single desktop task, stoppable with requestStopAll. */
export const executeAct = (action: DesktopAction, context: PageContext): Promise<ExecOut> => {
  // A task started from outside (curl /act) never went through runDesktopTask: an idle gap means this is a new task.
  if (!taskRecentlyActive(30_000)) taskSince = Date.now();
  activity.set("default", Date.now());
  return executeDesktopAction(action, context, realActDeps("default", taskSince, () => 0));
};
export const taskRecentlyActive = (windowMs = 30_000, now = Date.now()): boolean => [...activity.values()].some((t) => now - t < windowMs);

// ======================================================================================================================
// Voice side: agent mode, task sentences, approvals. Pure parsers first.
// ======================================================================================================================

const squash = (t: string) => t.toLowerCase().replace(/[“”"'’.,!?;:()\-]/g, " ").replace(/\s+/g, " ").trim();
const FILLER = /^((hey|ok|okay|please|ishara|now|so|just|can you|could you|would you|will you|i want you to|i want to|let s|lets|zara|ab|bas)\s+)+/;
const stripFiller = (t: string) => t.replace(FILLER, "").replace(/\s+(please|now|ji|na|yaar)$/, "");

// Whole-utterance templates, not a keyword hunt: "what does agent mode do?", "is agent mode on?" and "how do I turn agent mode
// off" must reach the tutor, so only a short sentence that IS the command counts.
const ON_FORMS = new Set([
  "agent mode on", "agent mode chalu", "agent mode chalu karo", "agent mode chalu kar do", "agent mode shuru", "agent mode shuru karo",
  "agent mode on karo", "agent mode on kar do", "agent mode start", "agent mode enable", "agent mode activate",
  "turn on agent mode", "switch on agent mode", "enable agent mode", "start agent mode", "activate agent mode", "agent mode ko on karo",
  "agent mode ko chalu karo", "agent mode chalu kardo", "agent mode on kardo", "chalu karo agent mode", "agent mode chalao",
]);
const OFF_FORMS = new Set([
  "agent mode off", "agent mode band", "agent mode band karo", "agent mode band kar do", "agent mode bandh karo", "agent mode off karo",
  "agent mode off kar do", "agent mode disable", "agent mode stop", "agent mode deactivate", "turn off agent mode", "switch off agent mode",
  "disable agent mode", "stop agent mode", "deactivate agent mode", "agent mode ko band karo", "agent mode ko off karo",
  "agent mode band kardo", "agent mode off kardo", "band karo agent mode", "exit agent mode", "leave agent mode",
]);
/** "on" / "off" when the whole sentence is the command, else null. English and Hinglish. */
export function agentModeCommand(text: string): "on" | "off" | null {
  const q = stripFiller(squash(text));
  if (ON_FORMS.has(q)) return "on";
  if (OFF_FORMS.has(q)) return "off";
  return null;
}

const QUESTION = /^(what|why|how|when|where|who|which|whose|is|are|was|were|does|do|did|can|could|should|would|will|am|kya|kaise|kyun|kyu|kab|kaun|kahan|kidhar|konsa|kaunsa)\b/;
// First-word imperatives, and the Hinglish verbs that END the sentence ("settings kholo", "naam bharo").
const VERBS = /^(open|launch|go to|click|tap|press|hit|fill|fill in|fill out|type|enter|scroll|copy|play|pause|resume|search|select|choose|close|quit|exit|screenshot|take a screenshot|take screenshot|turn on|turn off|switch to|uncheck|toggle|paste)\b/;
const HINGLISH_END = /\b(kholo|khol do|kholiye|bharo|bhar do|likho|likh do|chalao|chala do|dabao|daba do|band karo|band kar do|select karo|click karo|copy karo|search karo|scroll karo|screenshot lo|le lo)$/;
const HINGLISH_MID = /\b(likho|likh do|bharo|bhar do)\b/; // "yahan likho hello": the verb comes before the thing to write
/** A sentence that asks Ishara to DO something (not to explain it). Questions and walk words ("next", "stop") are never tasks. */
export function isTaskUtterance(text: string): boolean {
  const raw = text.trim();
  if (!raw || raw.endsWith("?")) return false;
  const q = stripFiller(squash(raw));
  if (!q || q.split(" ").length < 2 && !/^screenshot$/.test(q)) return false;
  if (parseWalkCommand(raw) || agentModeCommand(raw)) return false;
  // A Hinglish sentence that ends in a verb is a command even when it starts with "is" ("is window ko band karo" = close THIS window).
  if (HINGLISH_END.test(q) && !/^(kya|kaise|kyun|kab|kaun)\b/.test(q)) return true;
  if (QUESTION.test(q)) return false;
  return VERBS.test(q) || HINGLISH_END.test(q) || HINGLISH_MID.test(q);
}

const YES = /^(yes|yeah|yep|yup|yes please|haan|han|haan karo|ha|ji haan|ok|okay|ok do it|okay do it|do it|yes do it|go ahead|approve|approved|sure|theek hai|thik hai|kar do|karo|confirm|yes go ahead|yes approve)$/;
const NO = /^(no|nope|nah|nahi|nahin|no don t|don t|do not|dont|stop|cancel|deny|denied|mat karo|rehne do|ruko|ruk jao|no stop|no cancel|no thanks|na)$/;
/** The answer to a waiting approval, or null when the words are neither (then the approval simply stays open). */
export function approvalAnswer(text: string): "yes" | "no" | null {
  const q = squash(text).replace(/^(ishara|please)\s+/, "");
  if (YES.test(q)) return "yes";
  if (NO.test(q)) return "no";
  return null;
}
const STOP_WORDS = /^(stop|cancel|ruko|ruk jao|ruk ja|band karo|bas|enough|stop it|stop that)$/;
export const isStopWord = (text: string): boolean => STOP_WORDS.test(squash(text));

// ---------- overlay mapping (pure, tested) ----------
export type ActEv = { event: string; data?: any };
export type TaskCtx = { ctx: PageContext };
export const AGENT_OFF_HINT = "Turn on Agent mode and I will do that.";
const RISK_NOTE: Record<string, string> = { high: "Needs your approval", refused: "Not allowed" };

/** One /act SSE event -> the pill commands. The pill text is the model's own short `say`; the step chip carries the number. */
export function actEventToCmds(ev: ActEv, t: TaskCtx): OverlayCmd[] {
  const d = ev.data ?? {};
  switch (ev.event) {
    case "thinking": return [{ cmd: "agent", text: "Thinking…", step: Math.max(1, Number(d.n) || 1), risk: "low" } as OverlayCmd];
    case "action": return [{ cmd: "agent", text: String(d.say || actionInWords(d.action, t.ctx)), step: Math.max(1, Number(d.n) || 1), risk: String(d.risk ?? "low") } as OverlayCmd];
    case "approval": return [{ cmd: "approval", text: `${actionInWords(d.action, t.ctx)}?`, sub: `${String(d.why || RISK_NOTE.high)}. Say yes to approve, no to cancel.` } as OverlayCmd];
    case "result": return d.ok === false ? [{ cmd: "agent", text: `That did not work: ${String(d.detail || "").slice(0, 80)}`, step: Math.max(1, Number(d.n) || 1), risk: "low" } as OverlayCmd] : [];
    case "done": case "ask": return [{ cmd: "agent", text: String(d.say || "Done."), step: 0, risk: "low" } as OverlayCmd];
    case "failed": return [{ cmd: "agent", text: String(d.say || "I could not finish that."), step: 0, risk: "low" } as OverlayCmd];
    case "stopped": return [{ cmd: "agent", text: "Stopped.", step: 0, risk: "low" } as OverlayCmd];
    case "refused": return [{ cmd: "stop", text: String(d.say || "I can't do that right now. I won't guess.") }];
    default: return [];
  }
}

/** Parse an SSE stream into events (also used by the tests). Handles chunks that split a frame. */
export function createSseParser(onEvent: (ev: ActEv) => void) {
  let buf = "";
  return (chunk: string) => {
    buf += chunk;
    let i: number;
    while ((i = buf.indexOf("\n\n")) >= 0) {
      const frame = buf.slice(0, i); buf = buf.slice(i + 2);
      let event = "", data = "";
      for (const line of frame.split("\n")) {
        if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:")) data += line.slice(5).trim();
      }
      if (!event) continue;
      try { onEvent({ event, data: data ? JSON.parse(data) : {} }); } catch { /* a broken frame is dropped, never fatal */ }
    }
  };
}

// ---------- state: armed, the running task, the waiting approval ----------
// Armed is memory only, and starts OFF on every helper start: an agent that wakes up armed is a safety bug.
export const agent = { armed: false };
type Running = { actId?: string; abort: AbortController; step: number };
let running: Running | null = null;
let pendingApproval: { actId: string; n: number } | null = null;
export const agentState = () => ({ armed: agent.armed, running: !!running, approvalPending: !!pendingApproval });
export const taskRunning = (): boolean => !!running;
/** Test hook only: put the module back to its start state. */
export function resetAgentState(): void { taskSince = 0; agent.armed = false; running = null; pendingApproval = null; stoppedIds.clear(); stopAllAt = 0; activity.clear(); }

export type SayDeps = {
  send?: (c: OverlayCmd) => void;
  post?: (path: string, body: unknown, signal?: AbortSignal) => Promise<{ headers: { get(k: string): string | null }; body: AsyncIterable<Uint8Array | string> | null; ok?: boolean }>;
  context?: () => Promise<{ context: PageContext; bundleId: string }>;
  front?: () => Promise<FrontApp | null>;
  ask?: (text: string) => Promise<unknown>;       // the tutor
  speak?: (text: string) => void;
  signal?: AbortSignal;
};
const defaultPost: NonNullable<SayDeps["post"]> = (path, body, signal) =>
  fetch(`http://127.0.0.1:${HELPER_PORT}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal }) as any;
const defaultSpeak = (t: string) => { try { if (!process.env.NODE_TEST_CONTEXT) { realSpeech.start(); realSpeech.say(t, 0); realSpeech.end(); } } catch { /* the voice must never break a task */ } };

export function setAgentMode(on: boolean, send: (c: OverlayCmd) => void = (c) => overlay.send(c)): void {
  agent.armed = on;
  if (!on) stopTask(send, false);
  send({ cmd: "agentmode", on } as OverlayCmd);
}

/** Stop the running task NOW: the local flag (the executor checks it between steps), POST /act/stop, and the stream. */
export function stopTask(send: (c: OverlayCmd) => void = (c) => overlay.send(c), say = true, post: NonNullable<SayDeps["post"]> = defaultPost): boolean {
  const r = running;
  requestStopAll();
  if (!r) return false;
  if (r.actId) { requestStop(r.actId); void post("/act/stop", { actId: r.actId }).catch(() => {}); } else r.abort.abort();
  // The approval wait ends too: no answer is a no, and the core treats Stop as a deny.
  pendingApproval = null;
  if (say) send({ cmd: "agent", text: "Stopped.", step: 0, risk: "low" } as OverlayCmd);
  setTimeout(() => r.abort.abort(), 1500).unref?.(); // the loop ends by itself; the abort is the backstop
  return true;
}

/** Answer the waiting approval (the pill button, or the words yes / no). */
export async function answerApproval(approve: boolean, deps: Pick<SayDeps, "post" | "send"> = {}): Promise<boolean> {
  const p = pendingApproval;
  if (!p) return false;
  pendingApproval = null;
  const send = deps.send ?? ((c: OverlayCmd) => overlay.send(c));
  send({ cmd: "agent", text: approve ? "Approved. Doing it." : "Okay, I will not do that.", step: running?.step ?? 1, risk: "low" } as OverlayCmd);
  try { await (deps.post ?? defaultPost)("/act/approve", { actId: p.actId, n: p.n, approve }); } catch { /* an unanswered approval is a no after 60 s */ }
  return true;
}

// The overlay's own buttons: {"ev":"approve","approve":true|false} and {"ev":"agent","cmd":"stop"} (handled with the walk ones).
export function onOverlayAgentLine(line: string): boolean {
  let o: any; try { o = JSON.parse(line); } catch { return false; }
  if (o?.ev === "approve" && typeof o.approve === "boolean") { void answerApproval(o.approve); return true; }
  if (o?.ev === "agent" && o.cmd === "stop") { stopTask(); return true; }
  return false;
}
overlayEventHooks.push(onOverlayAgentLine);

/** Run one task through POST /act with executor "helper". Resolves when the task ends (done, failed, stopped, refused). */
export async function runDesktopTask(task: string, deps: SayDeps = {}): Promise<{ outcome: string; say?: string }> {
  const send = deps.send ?? ((c: OverlayCmd) => overlay.send(c));
  const front = await (deps.front ?? frontApp)();
  if (front && isBrowserBundle(front.bundleId)) { send({ cmd: "ask", text: BROWSER_HINT }); return { outcome: "browser" }; }
  if (running) { send({ cmd: "ask", text: "I am already doing something. Tap Right Option to stop me first." }); return { outcome: "busy" }; }
  send({ cmd: "agent", text: "Reading the screen…", step: 1, risk: "low" } as OverlayCmd);
  const abort = new AbortController();
  const me: Running = { abort, step: 1 };
  running = me;
  let outcome = "ended", say: string | undefined;
  try {
    const got = await (deps.context ?? (async () => { const r = await desktopContext(); return { context: r.context, bundleId: r.bundleId }; }))();
    if (isBrowserBundle(got.bundleId)) { send({ cmd: "ask", text: BROWSER_HINT }); return { outcome: "browser" }; }
    const t: TaskCtx = { ctx: got.context };
    requestStopAllReset();
    const res = await (deps.post ?? defaultPost)("/act", { sessionId: "desktop", tabId: `desktop:${got.bundleId}`, task, context: got.context, executor: "helper", armed: true }, abort.signal);
    me.actId = res.headers.get("x-act-id") ?? undefined;
    const parse = createSseParser((ev) => {
      if (ev.data?.actId && !me.actId) me.actId = String(ev.data.actId);
      if (ev.event === "thinking" || ev.event === "action") me.step = Math.max(me.step, Number(ev.data?.n) || 1);
      if (ev.event === "approval" && me.actId) pendingApproval = { actId: me.actId, n: Number(ev.data?.n) || 1 };
      if (ev.event === "action") pendingApproval = null;
      if (["done", "failed", "stopped", "refused", "ask"].includes(ev.event)) { outcome = ev.event; say = ev.data?.say; pendingApproval = null; }
      for (const c of actEventToCmds(ev, t)) send(c);
      if ((ev.event === "done" || ev.event === "ask" || ev.event === "failed") && ev.data?.say) (deps.speak ?? defaultSpeak)(String(ev.data.say));
    });
    if (!res.body) throw new Error("the helper sent no stream");
    for await (const chunk of res.body) parse(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
  } catch (e: any) {
    if (abort.signal.aborted) outcome = "stopped";
    else { outcome = "error"; send({ cmd: "stop", text: "I could not run that task.", sub: String(e?.message ?? e).slice(0, 120) }); }
  } finally {
    if (running === me) running = null;
    pendingApproval = null;
  }
  return { outcome, say };
}
// A fresh task must not inherit the previous task's "stop all": executors compare their start time with the stop time, and a
// task that begins now starts after it. This only exists so a stale stop flag from an old task is cleared explicitly.
function requestStopAllReset(): void { stopAllAt = 0; stoppedIds.clear(); taskSince = Date.now(); }

export type SayResult = { outcome: "approval" | "agent-mode" | "task" | "hint" | "stopped" | "tutor" | "unclear-approval"; detail?: unknown };

/** Everything a spoken or typed sentence can mean on the desktop, in the order that keeps Agent mode safe:
 *  an approval answer, then the stop word, then "agent mode on/off", then a task, and only then the tutor. */
export async function desktopSay(text: string, deps: SayDeps = {}): Promise<SayResult> {
  const send = deps.send ?? ((c: OverlayCmd) => overlay.send(c));
  if (pendingApproval) {
    const a = approvalAnswer(text);
    if (a) { await answerApproval(a === "yes", { post: deps.post, send }); return { outcome: "approval" }; }
    send({ cmd: "approval", text: "Say yes to approve, or no to cancel.", sub: "" } as OverlayCmd);
    return { outcome: "unclear-approval" };
  }
  if (running && isStopWord(text)) { stopTask(send, true, deps.post); return { outcome: "stopped" }; }
  const mode = agentModeCommand(text);
  if (mode) { setAgentMode(mode === "on", send); return { outcome: "agent-mode", detail: mode }; }
  if (isTaskUtterance(text)) {
    if (!agent.armed) { send({ cmd: "ask", text: AGENT_OFF_HINT }); return { outcome: "hint" }; }
    return { outcome: "task", detail: await runDesktopTask(text, deps) };
  }
  return { outcome: "tutor", detail: await (deps.ask ?? ((q: string) => desktopAsk(q, { signal: deps.signal, alreadyThinking: true })))(text) };
}
