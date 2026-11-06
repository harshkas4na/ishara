// act-risk.ts: how dangerous is this action, and did the PERSON ask for it? (docs/AGENT-MODE.md principles 3, 4, 5)
// Pure and table-driven so it can be tested to death. It never trusts the model's own opinion of its action: the label,
// the role, the URL and the page text decide. Anything this file cannot place errs towards asking the person.
import type { Action, ActRisk, PageContext } from "./types.ts";
import { INSTRUCTION_TEXT, pageAskedFor } from "./pointer-gate.ts";
import { lookup, parseHttpUrl } from "./act.ts";
import { readerCore } from "./redact.ts";

export type Classified = { risk: ActRisk; why: string };

// ---- HIGH: labels that commit something. Word-bounded so "Postal code" is not "post" and "Sender" is not "send".
// Order matters only for the reason text. Icon-only buttons are labelled by the page ("Trash", "Paper plane"), so the
// common icon names are here too. This list is deliberately wide: a needless Approve tap costs a second, a missed one costs money.
export const HIGH_LABEL = new RegExp(String.raw`\b(` + [
  "submit", "send", "post", "publish", "pay", "buy", "purchase", "order", "confirm", "delete", "remove", "sign ?out", "log ?out", "sign ?off",
  "transfer", "approve", "allow", "authori[sz]e", "install", "connect(?:ing)? (?:your |a )?wallet", "checkout", "check ?out", "withdraw",
  "sign (?:the )?(?:transaction|tx|message)", "trash", "paper ?plane", "swap", "place (?:the )?order", "subscribe", "unsubscribe", "grant access",
].join("|") + String.raw`)\b`, "i");

// ("connect wallet" is not here: a dApp's ordinary connect button is already HIGH by its label, and flagging the whole page would make every action on it HIGH.)
// A page that is a wallet signature / approval / seed flow: everything on it that is not reading is HIGH.
export const WALLET_FLOW = new RegExp([
  String.raw`signature request`, String.raw`sign (?:this |the )?message`, String.raw`\bapprove spending\b`, String.raw`spending cap`,
  String.raw`\bspend (?:your|up to)\b`, String.raw`permission to spend`, String.raw`seed phrase`, String.raw`recovery phrase`, String.raw`secret recovery`,
  String.raw`confirm (?:the )?transaction`, String.raw`transaction request`, String.raw`wants to (?:connect|spend|access your)`, String.raw`set approval for all`,
  String.raw`\b(?:eth_sign|personal_sign|eth_signtypeddata)\b`,
].join("|"), "i");
const WALLET_URL = /(^chrome-extension:\/\/)|metamask|walletconnect|\/(approve|sign|signature|permit)(\/|$|\?)/i;
const READ_ONLY: ReadonlySet<Action["type"]> = new Set(["scroll", "wait", "screenshot", "done", "ask", "fail"]);

/** True when the page looks like a wallet signature / approval / seed-phrase flow. */
export function walletFlow(ctx: PageContext): string | null {
  if (WALLET_URL.test(ctx.url)) return "the address looks like a wallet or approval page";
  if (WALLET_FLOW.test(ctx.title)) return "the page title looks like a wallet signature or approval";
  // Only text that is actually showing: a long article that merely mentions a seed phrase is not a wallet prompt, so the
  // block must be short (a prompt line, not an essay) or an h block.
  const hit = ctx.blocks.find((b) => (b.kind === "h" || b.kind === "error" || b.text.length <= 140) && WALLET_FLOW.test(b.text));
  return hit ? "the page text looks like a wallet signature or approval request" : null;
}

// ---- Secret fields and secret-looking values (the redaction module's own rules, so they cannot drift) --------------------
const typeAttr = (c: any): string => String(c?._type ?? c?.type ?? "");
/** True when the control is a password / one-time / seed / key / card field by role, type or name. */
export function secretControl(c: { label: string; role: string }): boolean {
  const B = readerCore();
  return B.isSecretField({ type: typeAttr(c) || (/password|secure/i.test(c.role) ? "password" : ""), text: c.label + " " + c.role }) || /\bsecure\b|\bpassword\b/i.test(c.role);
}
/** True when `value` has the shape of a secret (private key, seed phrase, API key, JWT...) per the shared redaction rules. Public 0x addresses are not secrets. */
export function secretShaped(value: string): boolean {
  const B = readerCore() as ReturnType<typeof readerCore> & { redactShapes?: (s: string) => string; phraseRunMask(t: string[]): boolean[] };
  const v = value.trim();
  if (!v) return false;
  if (B.redact(v) !== v) return true;
  return B.phraseRunMask([v])[0] === true;
}

const norm = (s: string): string => s.toLowerCase().replace(/\s+/g, " ").trim();
const hasWords = (hay: string, needle: string): boolean => norm(hay).includes(norm(needle));

/** Content tokens of a label: lower-case words of 3+ letters. */
const words = (s: string): string[] => (norm(s).match(/[\p{L}\p{N}]{3,}/gu) ?? []);

/** The person's task names this target when it says the label, or every content word of it. */
export function taskNames(task: string, label: string): boolean {
  if (hasWords(task, label)) return true;
  const w = words(label);
  return w.length > 0 && w.every((x) => norm(task).includes(x));
}

const tainted = (ctx: PageContext): string[] =>
  [...ctx.blocks.map((b) => b.text), ...ctx.controls.flatMap((c) => [c.label, c.errorText ?? ""]), ctx.title, ctx.selection ?? ""].filter((t) => t && INSTRUCTION_TEXT.test(t));

export const PAGE_ASKED = "not doing that: the page asked for it, you did not";

/** Principle 5: a reason when only page text (that talks to an assistant) asked for this action, else null. Pure. */
export function pageAskedAction(action: Action, ctx: PageContext, task: string): string | null {
  switch (action.type) {
    case "click": case "select": case "check": case "type": {
      const hit = lookup(ctx, action.id);
      if (!hit) return null;
      const q = taskNames(task, hit.label) ? task + " " + hit.label : task; // naming it in your own words counts
      const r = pageAskedFor(ctx, { id: action.id, kind: hit.kind, label: hit.label }, q);
      if (r) return `${PAGE_ASKED} (${r})`;
      if (action.type === "type" && action.text.length >= 4 && !hasWords(task, action.text)) {
        // typing something the person never gave, which a talking-to-the-assistant paragraph supplied
        if (tainted(ctx).some((t) => hasWords(t, action.text))) return `${PAGE_ASKED} (that text comes from page text addressed to an assistant)`;
      }
      return null;
    }
    case "copy": {
      if (action.text.length >= 4 && !hasWords(task, action.text) && tainted(ctx).some((t) => hasWords(t, action.text))) return `${PAGE_ASKED} (that text comes from page text addressed to an assistant)`;
      return null;
    }
    case "open_url": {
      const u = parseHttpUrl(action.url);
      if (!u) return null;
      const host = u.hostname.toLowerCase();
      if (hasWords(task, host) || hasWords(task, host.replace(/^www\./, ""))) return null;
      return tainted(ctx).some((t) => hasWords(t, host)) ? `${PAGE_ASKED} (the address appears only in page text addressed to an assistant)` : null;
    }
    case "open_app": case "quit_app": {
      return !hasWords(task, action.name) && tainted(ctx).some((t) => hasWords(t, action.name)) ? `${PAGE_ASKED} (the app is named only in page text addressed to an assistant)` : null;
    }
    default: return null;
  }
}

const LOW_KEYS = new Set(["tab", "shift+tab", "escape", "esc", "up", "down", "left", "right", "pageup", "pagedown", "home", "end", "cmd+l", "cmd+t", "cmd+f", "cmd+a", "cmd+c", "cmd+left", "cmd+right", "cmd+shift+4", "cmd+shift+3"]);
const CLOSE_KEYS = new Set(["cmd+w", "cmd+q", "ctrl+w", "ctrl+q", "alt+f4", "cmd+shift+w", "cmd+option+q", "cmd+alt+q"]);

const submitLike = (c: { label: string; role: string }): boolean => /button|submit|link/i.test(c.role) && HIGH_LABEL.test(c.label);

/**
 * classify(action, context, task) -> { risk, why }.
 * refused: never done (secret fields, secret-looking values the person did not give, the page asked for it).
 * high: needs the person's tap. medium: ordinary state-changing actions. low: reading, waiting, safe navigation.
 */
export function classify(action: Action, ctx: PageContext, task: string): Classified {
  const asked = pageAskedAction(action, ctx, task);
  if (asked) return { risk: "refused", why: asked };

  const wallet = walletFlow(ctx);
  const R = (risk: ActRisk, why: string): Classified => ({ risk, why });
  const inWallet = (): Classified | null => (wallet && !READ_ONLY.has(action.type) ? R("high", `${wallet}, so anything but reading needs your OK`) : null);

  switch (action.type) {
    case "done": case "ask": case "fail": return R("low", "ends the task");
    case "scroll": case "wait": case "screenshot": return R("low", action.type === "screenshot" ? "a screenshot for you, kept on this laptop" : "reading only");

    case "type": case "select": case "check": case "click": {
      const hit = lookup(ctx, action.id);
      const label = hit?.label ?? "";
      const role = hit?.role ?? "";
      if (hit && (action.type === "type" || action.type === "check" || action.type === "select") && hit.kind === "control" && secretControl(hit.control)) {
        return R("refused", `"${label.slice(0, 40)}" is a secret field (password, card, key or seed); I never type into or tick those`);
      }
      if (action.type === "type") {
        if (secretShaped(action.text) && !hasWords(task, action.text)) return R("refused", "that value looks like a secret and you did not give it to me in the task");
      }
      const w = inWallet(); if (w) return w;
      if (action.type === "click" && (HIGH_LABEL.test(label) || HIGH_LABEL.test(role))) return R("high", `"${label.slice(0, 40)}" commits something (${(label.match(HIGH_LABEL) ?? role.match(HIGH_LABEL))?.[0].toLowerCase()})`);
      return R("medium", `${action.type} on "${label.slice(0, 40)}"`);
    }

    case "key": {
      const w = inWallet(); if (w) return w;
      if (CLOSE_KEYS.has(action.combo)) return R("high", `${action.combo} closes a window or quits an app`);
      if (action.combo === "enter" || action.combo === "return" || action.combo === "space" || action.combo === "cmd+enter" || action.combo === "cmd+return") {
        const focused = ctx.focused ? lookup(ctx, ctx.focused) : null;
        const fRole = focused?.kind === "control" ? focused.role : "";
        // Enter in a multi-line box is a newline, and space in a text box is a space: neither submits.
        if (/textarea/i.test(fRole) && action.combo !== "cmd+enter" && action.combo !== "cmd+return") return R("medium", "a new line in a text box");
        if (focused && /button|link|submit/i.test(fRole) && HIGH_LABEL.test(focused.label)) return R("high", `${action.combo} would press "${focused.label.slice(0, 40)}"`);
        if (action.combo === "space" && focused && !/button|checkbox|link/i.test(fRole)) return R("medium", "typing a space");
        // Enter in a field submits the form. If the page has a submit-like button we cannot tell which form, so ask.
        if (action.combo !== "space" && ctx.controls.some((c) => submitLike(c))) return R("high", "Enter could submit the form on this page");
        return R("medium", `${action.combo} key`);
      }
      if (LOW_KEYS.has(action.combo)) return R("low", `${action.combo} only moves around`);
      return R("medium", `${action.combo} key`);
    }

    case "open_url": {
      const u = parseHttpUrl(action.url);
      if (!u) return R("refused", "not a plain http(s) address");
      const w = inWallet(); if (w) return w;
      const host = u.hostname.toLowerCase().replace(/^www\./, "");
      if (hasWords(task, host)) return R("low", "an address you named");
      // "play a song on YouTube" names youtube, not youtube.com: the registrable label counts.
      const label = host.split(".").slice(-2, -1)[0] ?? host;
      if (label.length >= 3 && hasWords(task, label)) return R("low", `a site you named (${label})`);
      // An address that is only on the page (never in the task) is where phishing lives: ask.
      if (ctx.blocks.some((b) => hasWords(b.text, host)) || ctx.controls.some((c) => hasWords(c.label, host))) return R("high", "an address that came from the page, not from you");
      return R("medium", `opens ${host}`);
    }

    case "open_app": return R("medium", `opens ${action.name}`);
    case "quit_app": return R("high", `quits ${action.name}`);
    case "copy": {
      if (secretShaped(action.text) && !hasWords(task, action.text)) return R("refused", "that text looks like a secret and you did not give it to me in the task");
      const w = inWallet(); if (w) return w;
      return R("medium", "puts text on your clipboard");
    }
  }
}
