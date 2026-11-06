// Desktop adapter: the same tutor as the browser path (explain, point, guide, follow-ups, spoken answers), for any macOS app.
// ishara-ax (Swift) reads the Accessibility tree plus on-device OCR; this file turns that into a PageContext (with the
// browser reader's redaction), runs the tutor turn, and renders its events in ishara-overlay. Only the question and the
// redacted context text ever reach the model; no pixels leave the machine (OCR is local).
// The old pointing-only path (desktopOutline, decisionToOverlay) is kept for scripts and its tests.
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import type { Decision, Outline, OutlineElement, PageContext, Control, ControlState } from "./types.ts";
import { readerCore } from "./redact.ts";
import { speaker } from "./speech.ts";

const DESKTOP_DIR = fileURLToPath(new URL("../../desktop/", import.meta.url));
export const AX_BIN = DESKTOP_DIR + "ishara-ax";
export const OVERLAY_BIN = DESKTOP_DIR + "ishara-overlay";
const AX_TIMEOUT_MS = 6000;

export type DecideFn = (sessionId: string, question: string, outline: Outline) => Promise<Decision>;
export type OverlayCmd =
  // rect (screen points, top-left origin) lets the overlay draw the marker loop/underline; x,y is its centre.
  // keep: true = the bubble already shows the streamed answer; only move it next to the target (tutor path).
  | { cmd: "point"; x: number; y: number; text: string; rect?: { x: number; y: number; w: number; h: number }; keep?: boolean }
  | { cmd: "think"; text: string }
  | { cmd: "say"; text: string; append: boolean }   // one streamed sentence; append:false starts a fresh bubble
  | { cmd: "step"; n: number; m: number }           // bubble header "Step n of m"
  | { cmd: "done" }                                 // the turn ended: let the bubble linger, then fade
  | { cmd: "ask"; text: string }
  | { cmd: "stop"; text: string; sub?: string }
  | { cmd: "clear" };

// ---------- pure parts (unit tested) ----------

// ishara-ax exits 2 and prints ISHARA_PERMISSION when macOS refuses it. Turn that into one message the user can act on.
export function axErrorMessage(code: number | null, stderr: string, timedOut = false): string {
  if (timedOut) return `ishara-ax took longer than ${AX_TIMEOUT_MS / 1000} s and was stopped. The app may be unresponsive; try again.`;
  if (code === 2 || stderr.includes("ISHARA_PERMISSION")) {
    return "Ishara cannot read the screen: Accessibility permission is missing. Open System Settings > Privacy & Security > Accessibility and switch on the app that started the helper (Terminal, iTerm, VS Code, or node), then ask again.";
  }
  const line = stderr.trim().split("\n").filter((l) => l.startsWith("ishara-ax:")).pop() ?? stderr.trim().split("\n").pop() ?? "";
  return `ishara-ax failed (exit ${code}): ${line || "no output"}`;
}

const clip = (s: string) => (s.length > 80 ? s.slice(0, 79) + "…" : s);

// Re-validate whatever the binary printed: drop malformed or duplicate elements (same label at the same spot,
// which is what AX + OCR both seeing one control looks like), cap at 150, then renumber ids b0.. and rebuild
// `text` so ids and text can never disagree. Controls win the cap over plain text, as in the Swift side.
export function normalizeOutline(raw: any): Outline {
  const els: OutlineElement[] = [];
  for (const e of Array.isArray(raw?.elements) ? raw.elements : []) {
    const r = e?.rect;
    if (!r || ![r.x, r.y, r.w, r.h].every((n: unknown) => typeof n === "number" && Number.isFinite(n))) continue;
    if (typeof e.label !== "string" || typeof e.role !== "string") continue;
    // Same label within 12 pt = one control seen twice (AX + OCR). Keep the non-text role, it is the clickable one.
    const lab = e.label.toLowerCase();
    const twin = els.findIndex((o) => o.label.toLowerCase() === lab && Math.abs(o.rect.x - r.x) < 12 && Math.abs(o.rect.y - r.y) < 12);
    if (twin >= 0) {
      if (els[twin].role === "text" && e.role !== "text") els[twin] = { id: "", label: clip(e.label), role: e.role, rect: { x: r.x, y: r.y, w: r.w, h: r.h } };
      continue;
    }
    els.push({ id: "", label: clip(e.label), role: e.role, rect: { x: r.x, y: r.y, w: r.w, h: r.h } });
  }
  let kept = els;
  if (els.length > 150) {
    const controls = els.filter((e) => e.role !== "text").length;
    let room = Math.max(0, 150 - controls);
    kept = els.filter((e) => e.role !== "text" || room-- > 0).slice(0, 150);
  }
  kept.forEach((e, i) => { e.id = "b" + i; });
  const rawLines: string[] = typeof raw?.text === "string" ? raw.text.split("\n") : [];
  // Keep the "(text)" style suffix from the Swift side when the label matches; otherwise a plain line.
  const text = kept.map((e) => {
    const hit = rawLines.find((l) => l.includes(`${e.role} "${e.label}"`));
    const suffix = hit?.match(/" (\([a-z]+\))$/)?.[1];
    return `[${e.id}] ${e.role} "${e.label}"${suffix ? " " + suffix : ""}`;
  }).join("\n");
  return {
    url: String(raw?.url ?? "app://unknown"),
    viewport: { w: Number(raw?.viewport?.w) || 0, h: Number(raw?.viewport?.h) || 0 },
    elements: kept,
    text,
  };
}

const STOP_TEXT = {
  unavailable: "0G's private model is not reachable right now. I won't guess.",
  timeout: "0G took too long to answer.",
  offline: "There is no connection to 0G.",
} as const;

// Decision -> what to draw. The one rule that matters: only point when the outcome is "point" AND the id is
// really in this outline. Anything else becomes a bubble, never a guessed position.
export function decisionToOverlay(d: Decision, outline: Outline): OverlayCmd {
  if (d.outcome === "point") {
    const el = d.targetId ? outline.elements.find((e) => e.id === d.targetId) : undefined;
    if (el) {
      const { x, y, w, h } = el.rect;
      return { cmd: "point", x: Math.round(x + w / 2), y: Math.round(y + h / 2), text: d.say, rect: { x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) } };
    }
    return { cmd: "ask", text: "I could not find that control on screen. Can you say more about what you want?" };
  }
  if (d.outcome === "safe_stop") {
    const cause = d.safeStopCause;
    return { cmd: "stop", text: cause ? STOP_TEXT[cause] : "I can't answer safely right now. I won't guess.", sub: d.say && cause ? undefined : d.say || undefined };
  }
  // ask and ask_which are both "I need you to be clearer"; the sentence is already written for the user.
  return { cmd: "ask", text: d.say };
}

// ---------- processes ----------

function need(bin: string): void {
  if (!existsSync(bin)) throw new Error(`${bin} is not built. Run the swiftc commands in docs/DESKTOP.md.`);
}

// One run of ishara-ax: stdout JSON in, the permission/timeout message out as an Error.
function runAx(args: string[], timeoutMs = AX_TIMEOUT_MS): Promise<{ json: any; timing?: string }> {
  need(AX_BIN);
  return new Promise((resolve, reject) => {
    const p = spawn(AX_BIN, args);
    let out = "", errOut = "", timedOut = false;
    const timer = setTimeout(() => { timedOut = true; p.kill("SIGKILL"); }, timeoutMs);
    p.stdout.on("data", (c) => (out += c));
    p.stderr.on("data", (c) => (errOut += c));
    p.on("error", (e) => { clearTimeout(timer); reject(e); });
    p.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0 || timedOut) return reject(new Error(axErrorMessage(code, errOut, timedOut)));
      try { resolve({ json: JSON.parse(out), timing: errOut.trim().split("\n").pop() }); }
      catch { reject(new Error("ishara-ax printed something that is not JSON")); }
    });
  });
}

export function desktopOutline(opts: { app?: string; ocr?: "auto" | "always" | "never"; timeoutMs?: number } = {}): Promise<Outline & { timing?: string }> {
  const args = ["outline", "--ocr", opts.ocr ?? "auto", ...(opts.app ? ["--app", opts.app] : [])];
  return runAx(args, opts.timeoutMs).then((r) => ({ ...normalizeOutline(r.json), timing: r.timing }));
}

// Vision's first OCR call loads its model (measured 12-56 s cold, 0.5 s warm). Call once at helper start so
// the first real question does not hit the 6 s limit. Failure is fine: it only warms a cache.
export function warmDesktop(): Promise<void> {
  return desktopOutline({ ocr: "always", timeoutMs: 90_000 }).then(() => {}, () => {});
}

let child: ChildProcess | null = null;
function startOverlay(): ChildProcess {
  if (child && child.exitCode === null && !child.killed) return child;
  need(OVERLAY_BIN);
  const p = spawn(OVERLAY_BIN, [], { stdio: ["pipe", "ignore", "inherit"] });
  p.stdin!.on("error", () => {}); // a dead overlay must not crash the helper; the next send restarts it
  p.on("exit", () => { if (child === p) child = null; });
  child = p;
  return p;
}
export { startOverlay };
export const overlay = {
  send(cmd: OverlayCmd): void {
    const p = startOverlay();
    p.stdin!.write(JSON.stringify(cmd) + "\n");
  },
  stop(): void { child?.kill(); child = null; },
};


// ---------- browsers: the extension owns them ----------
// A browser window seen through Accessibility is only its own chrome (tabs, address bar, bookmarks, extensions) and
// tab titles, private tabs included, with NO page body (measured: docs/audit/desktop.md section 4). Reading that
// would leak titles and teach nothing, so when one of these is frontmost the desktop path reads nothing, sends nothing,
// and points the user at the extension. Bundle ids, not names: names are localized and can be renamed.
export const BROWSER_BUNDLE_IDS: readonly string[] = [
  "com.google.Chrome", "com.google.Chrome.beta", "com.google.Chrome.dev", "com.google.Chrome.canary",
  "org.chromium.Chromium", "com.brave.Browser", "com.brave.Browser.beta", "com.brave.Browser.nightly",
  "com.apple.Safari", "com.apple.SafariTechnologyPreview",
  "company.thebrowser.Browser", "company.thebrowser.dia",            // Arc, Dia
  "com.microsoft.edgemac", "com.microsoft.edgemac.Beta", "com.microsoft.edgemac.Dev", "com.microsoft.edgemac.Canary",
  "org.mozilla.firefox", "org.mozilla.firefoxdeveloperedition", "org.mozilla.nightly",
  "com.operasoftware.Opera", "com.operasoftware.OperaGX", "com.operasoftware.OperaNext",
  "com.vivaldi.Vivaldi", "com.duckduckgo.macos.browser", "app.zen-browser.zen", "com.openai.atlas",
];
export const BROWSER_HINT = "In the browser, use Option+Space";
export const isBrowserBundle = (bundleId: string | undefined | null): boolean => !!bundleId && BROWSER_BUNDLE_IDS.includes(bundleId);

export type FrontApp = { app: string; bundleId: string };
/** Which app is in front, without reading any window (no permission needed, ~30 ms). null if it cannot be told. */
export async function frontApp(): Promise<FrontApp | null> {
  try {
    const { json } = await runAx(["front"], 2000);
    return typeof json?.bundleId === "string" ? { app: String(json.app ?? ""), bundleId: json.bundleId } : null;
  } catch { return null; }
}

// ---------- the PageContext (docs/TUTOR-INTERFACE.md section 1) ----------
export const CONTEXT_TOKEN_BUDGET = 3000;
export const MAX_CONTROLS = 150;

// ids must survive re-reads of the same window: "next" in a walkthrough looks its step's target up by id in a NEW
// context, and ids numbered by reading order would point at a different control the moment one appears above it.
// The book remembers which signature got which number for one window, so the same control keeps its id.
export type IdBook = { ids: Map<string, number>; next: number; last: number; key: string };
export function newIdBook(key = ""): IdBook { return { ids: new Map(), next: 0, last: 0, key }; }
const BOOK_IDLE_MS = 10 * 60 * 1000;
function takeId(book: IdBook, prefix: string, sig: string, seen: Map<string, number>): string {
  const n = (seen.get(sig) ?? 0) + 1; seen.set(sig, n); // two identical rows in one read stay distinct
  const full = prefix + "|" + sig + "|" + n;
  let id = book.ids.get(full);
  if (id === undefined) { id = book.next++; book.ids.set(full, id); }
  return prefix + id;
}
const books = new Map<string, IdBook>();
function bookFor(key: string, now: number): IdBook {
  let b = books.get(key);
  if (!b || now - b.last > BOOK_IDLE_MS || b.ids.size > 3000) { b = newIdBook(key); books.set(key, b); }
  b.last = now;
  if (books.size > 20) for (const [k, v] of books) if (now - v.last > BOOK_IDLE_MS) books.delete(k);
  return b;
}

const rectOf = (r: any) => (r && [r.x, r.y, r.w, r.h].every((n: unknown) => typeof n === "number" && Number.isFinite(n))
  ? { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.w), h: Math.round(r.h) } : undefined);
const TAG: Record<string, string> = { h: "h2", p: "p", li: "li", text: "span", error: "p", cell: "tr", code: "pre", caption: "figcaption" };
// the id signature of a control: where it sits relative to its window, so moving the window keeps ids
const sigOf = (kind: string, label: string, r: { x: number; y: number } | undefined, o: { x: number; y: number }) =>
  `${kind}|${label.toLowerCase().slice(0, 60)}|${r ? Math.round((r.x - o.x) / 24) : "n"},${r ? Math.round((r.y - o.y) / 24) : "n"}`;

/** Raw `ishara-ax context` JSON -> PageContext. Pure. EVERYTHING that came from the screen passes the browser reader's
 *  redact + neutralize here, before it can leave the process; a secure field's value is never read, only "filled". */
export function buildContext(raw: any, opts: { now?: number; book?: IdBook } = {}): PageContext {
  const B = readerCore();
  const now = opts.now ?? Date.now();
  const app = B.safeText(String(raw?.app ?? "app"), 60) || "app";
  const title = B.safeText(String(raw?.title ?? ""), 120);
  const url = `app://${app}` + (title ? `/${title}` : "");
  const origin = { x: Number(raw?.origin?.x) || 0, y: Number(raw?.origin?.y) || 0 };
  const book = opts.book ?? bookFor(`${raw?.bundleId ?? app}|${title}`, now);

  // controls
  const seenC = new Map<string, number>();
  let controls: Control[] = [];
  let focusedId: string | undefined;
  for (const c of Array.isArray(raw?.controls) ? raw.controls : []) {
    const rect = rectOf(c?.rect);
    if (!rect || typeof c.label !== "string" || typeof c.role !== "string") continue;
    const label = B.safeText(c.label, 80);
    const secret = c.ctl === "password" || B.isSecretField({ type: c.ctl === "password" ? "password" : "text", text: c.label });
    const st = c.state && typeof c.state === "object" ? c.state : {};
    const state: ControlState = {};
    if (st.disabled === true) state.disabled = true;
    if (st.invalid === true) state.invalid = true;
    if (typeof st.filledChars === "number") state.filledChars = Math.max(0, Math.round(st.filledChars));
    if (typeof st.empty === "boolean") state.empty = st.empty;
    if (!secret) { // a secret field gets "filled, N chars" and nothing else, whatever the reader handed over
      if (typeof st.checked === "boolean") state.checked = st.checked;
      if (typeof st.selectedOption === "string") state.selectedOption = B.safeText(st.selectedOption, 80);
      if (typeof st.value === "string" && st.value) state.value = B.safeText(st.value, 120);
    }
    const ctl: Control = { id: takeId(book, "b", sigOf(c.role, label, rect, origin), seenC), label, role: c.role, rect };
    if (Object.keys(state).length) ctl.state = state;
    controls.push(ctl);
    if (typeof raw?.focused === "string" && c.id === raw.focused) focusedId = ctl.id;
  }
  controls = controls.slice(0, MAX_CONTROLS);

  // blocks: the browser reader's own dedupe/skip/redact pipeline, fed records shaped like its DOM walk emits
  const records: any[] = [];
  (Array.isArray(raw?.blocks) ? raw.blocks : []).forEach((b: any, i: number) => {
    if (!b || typeof b.text !== "string") return;
    const kind = typeof b.kind === "string" && TAG[b.kind] ? b.kind : "text";
    const rect = rectOf(b.rect);
    const base = { key: i, tag: TAG[kind], text: b.text, rect, inView: b.inView === true && !!rect, boiler: false, errorish: b.error === true || kind === "error" };
    if (kind === "cell" && Array.isArray(b.cells) && b.cells.length) b.cells.forEach((t: any, j: number) => records.push({ ...base, tag: "tr", cell: j, text: String(t) }));
    else records.push(base);
  });
  const built = B.buildBlocks(records, { controlLabels: controls.map((c) => c.label) });
  const controlTokens = controls.reduce((n, c) => n + B.estimateTokens(c.label) + 6 + (c.state ? B.estimateTokens(JSON.stringify(c.state)) : 0), 0);
  const blockBudget = Math.max(600, CONTEXT_TOKEN_BUDGET - controlTokens - B.estimateTokens(url + title) - 40);
  const kept = B.trim(built, blockBudget);
  const seenB = new Map<string, number>();
  // Array.from: the core ran in a vm context, so its arrays are from another realm; ours must be plain.
  const blocks = Array.from(kept.blocks as any[], (b: any) => ({
    id: takeId(book, "t", sigOf(b.kind, b.text, b.rect, origin), seenB),
    kind: b.kind as PageContext["blocks"][number]["kind"], text: b.text, inView: !!b.inView,
    ...(b.rect ? { rect: { x: b.rect.x, y: b.rect.y, w: b.rect.w, h: b.rect.h } } : {}),
  }));

  const ctx: PageContext = {
    source: "desktop", app, url, title,
    viewport: { w: Number(raw?.viewport?.w) || 0, h: Number(raw?.viewport?.h) || 0 },
    blocks, controls,
    errors: blocks.filter((b: any) => b.kind === "error").map((b: any) => b.id),
  };
  const sel = B.safeText(String(raw?.selection ?? ""), 400);
  if (sel) ctx.selection = sel;
  if (focusedId) ctx.focused = focusedId;
  const dropped = kept.dropped, capped = Math.max(0, (Array.isArray(raw?.controls) ? raw.controls.length : 0) - controls.length);
  if (dropped || capped) ctx.truncated = { blocks: dropped, controls: capped };
  return ctx;
}

/** Cheap human summary for logs and `--context`: counts, tokens, first blocks. Never the whole page. */
export function summarizeContext(ctx: PageContext, n = 10): string {
  const B = readerCore();
  const lines = [
    `${ctx.url}  ${ctx.viewport.w}x${ctx.viewport.h}`,
    `controls ${ctx.controls.length}, blocks ${ctx.blocks.length} (${ctx.blocks.filter((b) => b.inView).length} in view), errors ${ctx.errors.length}, ~${B.contextTokens(ctx)} tokens` +
      (ctx.truncated ? `, truncated ${JSON.stringify(ctx.truncated)}` : ""),
    ctx.focused ? `focused: ${ctx.focused}` : "focused: none",
    ctx.selection ? `selection: ${ctx.selection.length} chars` : "selection: none",
    ...ctx.blocks.slice(0, n).map((b) => `  ${b.id} ${b.kind}${b.inView ? "" : " (off-screen)"}: ${b.text.slice(0, 90)}`),
  ];
  return lines.join("\n");
}

export type DesktopCtx = { context: PageContext; bundleId: string; display?: { x: number; y: number; w: number; h: number }; ocr?: string; timing?: string };
/** Read the frontmost window (or --app X) into a PageContext. */
export async function desktopContext(opts: { app?: string; ocr?: "auto" | "always" | "never"; timeoutMs?: number } = {}): Promise<DesktopCtx> {
  const args = ["context", "--ocr", opts.ocr ?? "auto", ...(opts.app ? ["--app", opts.app] : [])];
  const { json, timing } = await runAx(args, opts.timeoutMs);
  return { context: buildContext(json), bundleId: String(json?.bundleId ?? ""), display: rectOf(json?.display), ocr: json?.ocr, timing };
}

// ---------- tutor events -> overlay commands (pure, unit tested) ----------
export type TutorEv = { event?: string; type?: string; data?: any; [k: string]: any };
export type MapState = { ctx: PageContext; heard: string; said: number };
const finiteRect = (r: any) => rectOf(r);

/** One tutor event -> what to draw, or null for "nothing to draw". The rule that matters: the ring moves ONLY on a
 *  `confirmed` pointer whose target exists in THIS context and has a rect on screen; rejected and suppressed draw nothing. */
export function eventToOverlay(ev: TutorEv, st: MapState): OverlayCmd | null {
  const name = String(ev.event ?? ev.type ?? "");
  const d = ev.data ?? ev;
  switch (name) {
    case "thinking": return { cmd: "think", text: st.heard ? `I heard: “${st.heard}” …thinking` : "Thinking…" };
    case "say": {
      if (typeof d.text !== "string" || !d.text.trim()) return null;
      return { cmd: "say", text: d.text, append: st.said++ > 0 };
    }
    case "point": {
      if (d.status !== "confirmed") return null; // rejected / suppressed: explain, never point
      const t = d.kind === "block" ? st.ctx.blocks.find((b) => b.id === d.targetId && b.inView) : st.ctx.controls.find((c) => c.id === d.targetId);
      const r = finiteRect(t?.rect);
      if (!r) return null;
      return { cmd: "point", x: Math.round(r.x + r.w / 2), y: Math.round(r.y + r.h / 2), text: "", rect: r, keep: true };
    }
    case "step": return Number.isFinite(d.n) && Number.isFinite(d.m) ? { cmd: "step", n: d.n, m: d.m } : null;
    case "refused": return { cmd: "stop", text: String(d.say || "I can't answer right now. I won't guess.") };
    case "done": return { cmd: "done" };
    default: return null;
  }
}

// ---------- speech seam ----------
export type SpeechSeam = { start(): void; say(t: string): void; end(): void };
// Same wiring as /tutor in server.ts: a new question cuts the old answer off, each sentence is queued as it arrives
// (unless muted), and flush() lets the tail of a sentence be spoken.
export const realSpeech: SpeechSeam = {
  start: () => speaker.interrupt(),
  say: (t) => { if (!speaker.isMuted()) speaker.enqueue(t); },
  end: () => speaker.flush(),
};

// The conversation / walk key: one per frontmost app, so "next" and "why?" find their walk across PTT turns in the same
// app, and a different app starts clean. convo.ts / walk.ts expire it after 10 idle minutes by themselves.
export const tabKey = (bundleId: string) => `desktop:${bundleId || "unknown"}`;

export type DesktopResult = {
  outcome: "answered" | "refused" | "cutoff" | "browser" | "aborted";
  said: string[];
  pointed: string[];       // ids of confirmed pointers that were drawn
  steps: Array<{ n: number; m: number }>;
  context?: { controls: number; blocks: number; tokens: number; app: string };
  done?: any;
  ms: { context: number; firstSay?: number; total: number };
};
export type AskDeps = {
  front?: () => Promise<FrontApp | null>;
  context?: () => Promise<DesktopCtx>;
  turn?: (req: any) => AsyncGenerator<TutorEv>;     // tests inject a fake; the product uses tutorTurn
  send?: (c: OverlayCmd) => void;
  speech?: SpeechSeam | null;                       // null = silent
  sessionId?: string;
  speak?: boolean;                                  // false = no voice for this question
  signal?: AbortSignal;                             // a new key-down aborts the running turn
  alreadyThinking?: boolean;                        // the caller already drew "I heard ..."
};

/** One desktop question, end to end: browser guard, read the window, tutor turn, draw + speak each event as it streams. */
export async function desktopAsk(question: string, deps: AskDeps = {}): Promise<DesktopResult> {
  const t0 = Date.now();
  const send = deps.send ?? ((c) => overlay.send(c));
  const speech = deps.speech !== undefined ? deps.speech : (process.env.NODE_TEST_CONTEXT ? null : realSpeech);
  const speaking = speech && deps.speak !== false ? speech : null;
  const result: DesktopResult = { outcome: "answered", said: [], pointed: [], steps: [], ms: { context: 0, total: 0 } };
  const finish = (): DesktopResult => { result.ms.total = Date.now() - t0; return result; };

  // The browser guard comes before anything reads a window.
  const front = await (deps.front ?? frontApp)();
  if (front && isBrowserBundle(front.bundleId)) { send({ cmd: "ask", text: BROWSER_HINT }); result.outcome = "browser"; return finish(); }

  if (!deps.alreadyThinking) send({ cmd: "think", text: `I heard: “${question}” …thinking` });
  const got = await (deps.context ?? desktopContext)();
  result.ms.context = Date.now() - t0;
  if (isBrowserBundle(got.bundleId)) { send({ cmd: "ask", text: BROWSER_HINT }); result.outcome = "browser"; return finish(); } // front changed between the two reads
  const ctx = got.context;
  const B = readerCore();
  result.context = { controls: ctx.controls.length, blocks: ctx.blocks.length, tokens: B.contextTokens(ctx), app: ctx.app ?? "" };

  const turn = deps.turn ?? ((await import("./decide.ts")).tutorTurn as (req: any) => AsyncGenerator<TutorEv>);
  const req = { sessionId: deps.sessionId ?? "desktop", tabId: tabKey(got.bundleId), question, context: ctx };
  const st: MapState = { ctx, heard: question, said: 0 };
  speaking?.start();
  const gen = turn(req);
  try {
    for await (const ev of gen) {
      if (deps.signal?.aborted) { result.outcome = "aborted"; break; }
      const name = String(ev.event ?? ev.type ?? ""), d = ev.data ?? ev;
      const cmd = eventToOverlay(ev, st);
      if (cmd) send(cmd);
      if (name === "say" && typeof d.text === "string") {
        if (result.said.length === 0) result.ms.firstSay = Date.now() - t0;
        result.said.push(d.text);
        try { speaking?.say(d.text); } catch { /* the voice must never break an answer */ }
      } else if (name === "point" && cmd?.cmd === "point") result.pointed.push(String(d.targetId));
      else if (name === "step") result.steps.push({ n: d.n, m: d.m });
      else if (name === "refused") result.outcome = "refused";
      else if (name === "done") { result.done = d; if (d.outcome === "refused") result.outcome = "refused"; else if (d.outcome === "cutoff") result.outcome = "cutoff"; }
    }
  } finally { // (breaking out of for-await already closes the generator)
    try { speaking?.end(); } catch { /* ignore */ }
  }
  return finish();
}
