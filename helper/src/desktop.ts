// Desktop adapter: the same Outline -> decide -> pointer loop as the browser path, for any macOS app.
// ishara-ax (Swift) produces the Outline from the Accessibility tree plus on-device OCR; ishara-overlay draws.
// Only the question and the outline text ever reach decide(); no pixels leave the machine (OCR is local).
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import type { Decision, Outline, OutlineElement } from "./types.ts";

const DESKTOP_DIR = fileURLToPath(new URL("../../desktop/", import.meta.url));
export const AX_BIN = DESKTOP_DIR + "ishara-ax";
export const OVERLAY_BIN = DESKTOP_DIR + "ishara-overlay";
const AX_TIMEOUT_MS = 6000;

export type DecideFn = (sessionId: string, question: string, outline: Outline) => Promise<Decision>;
export type OverlayCmd =
  | { cmd: "point"; x: number; y: number; text: string }
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
    if (el) return { cmd: "point", x: Math.round(el.rect.x + el.rect.w / 2), y: Math.round(el.rect.y + el.rect.h / 2), text: d.say };
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

export function desktopOutline(opts: { app?: string; ocr?: "auto" | "always" | "never"; timeoutMs?: number } = {}): Promise<Outline & { timing?: string }> {
  need(AX_BIN);
  const args = ["outline", "--ocr", opts.ocr ?? "auto", ...(opts.app ? ["--app", opts.app] : [])];
  return new Promise((resolve, reject) => {
    const p = spawn(AX_BIN, args);
    let out = "", errOut = "", timedOut = false;
    const timer = setTimeout(() => { timedOut = true; p.kill("SIGKILL"); }, opts.timeoutMs ?? AX_TIMEOUT_MS);
    p.stdout.on("data", (c) => (out += c));
    p.stderr.on("data", (c) => (errOut += c));
    p.on("error", (e) => { clearTimeout(timer); reject(e); });
    p.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0 || timedOut) return reject(new Error(axErrorMessage(code, errOut, timedOut)));
      try {
        resolve({ ...normalizeOutline(JSON.parse(out)), timing: errOut.trim().split("\n").pop() });
      } catch { reject(new Error("ishara-ax printed something that is not an outline")); }
    });
  });
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

export type DesktopResult = {
  decision: Decision;
  overlay: OverlayCmd;
  outline: Outline;
  ms: { outline: number; decide: number; total: number };
};

// One desktop question: read the window, decide with the same sealed calls as the browser, draw the answer.
export async function desktopAsk(
  question: string,
  decideFn: DecideFn,
  deps: { outline?: () => Promise<Outline>; send?: (c: OverlayCmd) => void; sessionId?: string } = {},
): Promise<DesktopResult> {
  const t0 = Date.now();
  const outline = await (deps.outline ?? desktopOutline)();
  const t1 = Date.now();
  const decision = await decideFn(deps.sessionId ?? "desktop", question, outline);
  const t2 = Date.now();
  const cmd = decisionToOverlay(decision, outline);
  (deps.send ?? ((c) => overlay.send(c)))(cmd);
  return { decision, overlay: cmd, outline, ms: { outline: t1 - t0, decide: t2 - t1, total: t2 - t0 } };
}
