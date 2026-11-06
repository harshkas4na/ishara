// act-risk.ts: how dangerous is this action, and did the PERSON ask for it? (docs/AGENT-MODE.md principles 3, 4, 5)
// Pure and table-driven so it can be tested to death. It never trusts the model's own opinion of its action: the label,
// the role, the URL and the page text decide. Anything this file cannot place errs towards asking the person.
import type { Action, ActRisk, PageContext } from "./types.ts";
import { INSTRUCTION_TEXT, pageAskedFor } from "./pointer-gate.ts";
import { lookup, parseHttpUrl } from "./act.ts";
import { readerCore } from "./redact.ts";
import { checkReadPath } from "./act-files.ts";

/** `auto`: a HIGH step that is only "might commit something" (an unlabelled button, Enter in a form), never money, deletion or a wallet. Auto mode runs these without a tap. */
export type Classified = { risk: ActRisk; why: string; auto?: true };

/**
 * Auto mode. Harsh, 6 Nov 2026 night: "remove all the approvals on all the computer use steps". So by default NOTHING waits for a
 * tap: his order is the approval for every step the classifier calls HIGH. What is still never done is `refused` (secret fields,
 * secret-looking values he did not give, text a page addressed to an assistant, "don't submit"): those are refusals, not approvals.
 *   ISHARA_AUTO unset or "all"  every HIGH step runs (default)
 *   ISHARA_AUTO=soft            only the soft lane runs; money, delete, send/post, signing and wallet pages still ask
 *   ISHARA_AUTO=0               every HIGH step asks
 */
export type AutoLevel = "all" | "soft" | "off";
export const autoLevel = (): AutoLevel => (process.env.ISHARA_AUTO === "0" ? "off" : process.env.ISHARA_AUTO === "soft" ? "soft" : "all");
export const autoMode = (): boolean => autoLevel() !== "off";
/** True when this classified step runs without a tap at the current level. */
export const runsWithoutTap = (c: { risk: string; auto?: true }): boolean => c.risk === "high" && (autoLevel() === "all" || (autoLevel() === "soft" && c.auto === true));
/** Labels that always wait for a tap, auto mode or not: they move money, destroy data, sign, or hand a site access. */
export const HARD_STOP = /(?<![\p{L}\p{N}])(delete|remove|trash|erase|wipe|deactivate|terminate|revoke|pay|buy|purchase|checkout|check ?out|withdraw|deposit|transfer|send money|swap|bridge|stake|unstake|sell|trade|redeem|cash ?out|donate|place (?:the )?order|sign(?! ?(?:in|on|up)(?![\p{L}]))|approve|authori[sz]e|grant access|connect(?:ing)?(?: (?:your |a )?wallet)?|mint|bid|sign ?out|log ?out|send|post|publish|submit|reply|comment|tweet|repost|retweet|bhejo|bhej do|kharido|khareedo|kharid|bhugtan|paise bhejo|jama karo|hatao|mita do)(?![\p{L}\p{N}])/iu;

// ---- Label normalisation (audit 4, 1.3): a homoglyph, a soft hyphen or spaced-out letters must not dodge the lists below.
const CONFUSABLE: Record<string, string> = {
  "а": "a", "е": "e", "о": "o", "р": "p", "с": "c", "х": "x", "у": "y", "і": "i", "ѕ": "s", "ј": "j", "к": "k", "м": "m", "т": "t", "в": "b", "н": "h",
  "А": "A", "Е": "E", "О": "O", "Р": "P", "С": "C", "Х": "X", "У": "Y", "І": "I", "Ѕ": "S", "Ј": "J", "К": "K", "М": "M", "Т": "T", "В": "B", "Н": "H",
  "α": "a", "ε": "e", "ο": "o", "ρ": "p", "ν": "v", "ι": "i", "κ": "k", "τ": "t", "υ": "u", "Α": "A", "Β": "B", "Ε": "E", "Ζ": "Z", "Η": "H", "Ι": "I", "Κ": "K", "Μ": "M", "Ν": "N", "Ο": "O", "Ρ": "P", "Τ": "T", "Υ": "Y", "Χ": "X",
};
const CONFUSABLE_RE = new RegExp("[" + Object.keys(CONFUSABLE).join("") + "]", "g");
/** NFKC, invisible characters removed, Cyrillic/Greek look-alikes mapped to Latin, "S u b m i t" joined. Pure. */
export function normLabel(raw: string): string {
  let s = String(raw ?? "").normalize("NFKC").replace(/[\u00ad\u034f\u061c\u115f\u1160\u17b4\u17b5\u180e\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/g, "");
  // Only map look-alikes inside words that also contain Latin letters, or are all look-alikes: real Hindi/Russian text keeps its letters.
  s = s.replace(/[\p{L}]+/gu, (w) => (/[a-z]/i.test(w) || [...w].every((ch) => CONFUSABLE[ch]) ? w.replace(CONFUSABLE_RE, (ch) => CONFUSABLE[ch]) : w));
  s = s.replace(/(?:^|(?<=\s))((?:[\p{L}][ .·_-]){2,}[\p{L}])(?=\s|$)/gu, (m) => m.replace(/[ .·_-]/g, ""));
  return s.replace(/\s+/g, " ").trim();
}

// ---- HIGH: labels that commit something. Word-bounded so "Postal code" is not "post" and "Sender" is not "send".
// Order matters only for the reason text. Icon-only buttons are labelled by the page ("Trash", "Paper plane"), so the
// common icon names are here too. This list is deliberately wide: a needless Approve tap costs a second, a missed one costs money.
export const HIGH_LABEL = new RegExp(String.raw`(?<![\p{L}\p{N}])(` + [
  "submit", "send", "post", "publish", "pay", "buy", "purchase", "order", "confirm", "delete", "remove", "sign ?out", "log ?out", "sign ?off",
  "transfer", "approve", "allow", "authori[sz]e", "install", "connect(?:ing)?(?: (?:your |a )?wallet)?", "checkout", "check ?out", "withdraw",
  "sign (?:the )?(?:transaction|tx|message)", "trash", "paper ?plane", "swap", "place (?:the )?order", "subscribe", "unsubscribe", "grant access",
  "create (?:an? |my |your )?account", "sign ?up", "register", "join", "enrol+", "book", "reserve", "apply", "save changes", "update", "upload",
  "continue to payment", "next: ?payment", "donate", "finish", "complete (?:order|purchase|payment)", "go live", "deploy", "mint",
  // commit verbs the first list missed (audit 4, 1.3)
  "sign(?! ?(?:in|on|up)(?![\p{L}]))", "accept", "agree", "i agree", "ok", "okay", "yes", "proceed", "claim", "stake", "unstake", "bridge", "bid", "vote",
  "reply", "comment", "repost", "retweet", "tweet", "merge", "archive", "leave", "block", "unfollow", "follow", "execute", "run", "discard", "deactivate",
  "terminate", "revoke", "reorder", "redeem", "cash ?out", "send money", "deposit", "sell", "trade", "close (?:my |the )?position",
  // destructive verb + an object that matters ("Cancel subscription", "Close account", "Clear all data", "Reset all settings")
  "(?:cancel|close|clear|reset|end|erase|wipe|disable|stop)(?: (?:my|your|the|all|this))* (?:account|subscription|plan|membership|data|history|everything|settings|profile|order|booking|payment|card|wallet|chats?|messages?|conversation|repository|repo|project|workspace|team)",
  // Hinglish, Roman letters: the common commit verbs, plain and polite
  "bhejo", "bhej do", "bhejna", "bhej dijiye", "bhejiye", "jama karo", "jama kare", "jama kijiye", "jama kar dijiye", "kharido", "khareedo", "kharid", "kharidiye", "bhugtan",
  "payment karo", "payment kijiye", "pay karo", "pay kijiye", "hatao", "hata dijiye", "hataiye", "mita do", "mitao", "mita dijiye", "pushti", "panjikaran",
  "register karo", "register kijiye", "sign up karo", "submit karo", "submit kijiye", "submit kar dijiye", "order karo", "order kijiye", "post karo", "post kijiye", "paise bhejo",
  // Other languages a page may be in (German, French, Spanish, Portuguese, Italian)
  "senden", "absenden", "kaufen", "bestellen", "bezahlen", "löschen", "bestätigen", "envoyer", "acheter", "payer", "supprimer", "valider", "confirmer", "commander",
  "enviar", "comprar", "pagar", "eliminar", "borrar", "confirmar", "inviare", "acquista", "paga", "elimina", "conferma",
].join("|") + String.raw`)(?![\p{L}\p{N}])`, "iu");
// Scripts without word spaces or with their own letters: matched as substrings.
export const HIGH_SCRIPT = /(भेज|जमा कर|भुगतान|खरीद|ख़रीद|हटा|मिटा|पुष्टि|सबमिट|पोस्ट कर|ऑर्डर|बुक कर|रजिस्टर|स्वीकार|हस्ताक्षर|पेमेंट|支付|付款|购买|購買|发送|發送|提交|删除|刪除|确认|確認|購入|送信|削除|決済|注文|확인|결제|구매|전송|삭제|отправить|купить|оплатить|удалить|подтвердить)/u;
const highHit = (s: string): string | null => { const n = normLabel(s); const m = n.match(HIGH_LABEL) ?? n.match(HIGH_SCRIPT); return m ? m[0].toLowerCase() : null; };

// Labels that only look around. A button NOT in this list is treated as a possible commit, on any page (audit 4, 1.3).
// The WHOLE label must be a look-around: "Cancel" is safe, "Cancel subscription" is not (audit 4, 1.2).
const SAFE_WORD = String.raw`cancel|close|back|go back|previous|prev|return|reset|clear|show|hide|expand|collapse|menu|search|play|pause|mute|unmute|next|dismiss|toggle|filter|sort|copy|help|home|open|more|less|zoom|skip|tab|view|see|read|load|learn|watch|listen|details|refresh|reload|retry|try again|got it|sign in|log ?in|download|orders|my orders|account|my account|profile|settings|notifications|inbox|cart|explore|browse|scroll|left|right|up|down|first|last|page|edit`;
const SAFE_OBJECT = String.raw`(?:dialog|popup|pop-up|window|menu|panel|sidebar|banner|tab|tabs|step|page|pages|more|less|all|details|results|filters?|options|password|image|video|section|to main|to top|main|top|full screen|fullscreen|comments|replies|answer|preview|code|map|list|grid|\d+)`;
export const SAFE_LABEL = new RegExp(String.raw`^\s*(?:${SAFE_WORD})(?:\s+(?:the |this |a |an )?${SAFE_OBJECT}){0,2}\s*[.!›»>→←‹«<]*\s*$`, "i");
// Media controls name what they play ("Play: Night Train", "Watch the trailer"): any title after the verb is still only playback.
const SAFE_MEDIA = /^\s*(?:play|pause|resume|watch|listen(?: to)?|preview|replay|mute|unmute|skip(?: ad| intro)?)\b/i;
const safeLabel = (label: string): boolean => { const n = normLabel(label); return n.length > 0 && (SAFE_LABEL.test(n) || SAFE_MEDIA.test(n)) && !highHit(n); };
const SUBMIT_FAMILY = /\b(submit|send|post|publish|pay|buy|purchase|order|confirm|create|sign ?up|register|join|book|reserve|apply|save|update|upload|checkout|check ?out|finish|complete|continue|deploy|mint|bhejo|jama|kharid|submit karo|proceed|reply|comment)\b/i;
const DESTRUCTIVE = /\b(delete|remove|sign ?out|log ?out|logout|trash|hatao|mita|close account|cancel subscription|deactivate|erase|wipe)\b/i;
const NO_SUBMIT = /(\b(don'?t|do not|dont|never|without|not to)\b[^.;,]{0,20}\b(submit|submitting|send|sending|post|posting|publish|publishing|pay|paying)\b)|(\bsubmit\b[^.;,]{0,12}\b(mat|nahi|nahin|na)\b)|(\bmat\b[^.;,]{0,12}\bsubmit\b)/i;
export const NO_SUBMIT_SAY = "You said not to submit, so I will not press that.";

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

const BUTTONISH = /^(button|submit|btn|menuitem|push ?button|default button|image)$/i;
const EDITABLE = (c: { role: string }) => /^(input|textarea|textbox|searchbox|text ?field|select|combobox|checkbox|radio|switch)$/i.test(c.role);
/**
 * The structural rule: a button whose label is not a known harmless one may commit something. On a page you can type into it
 * may submit the form; on any other page we simply do not know what it does (a one-click "Claim" or an unlabelled icon), so
 * it asks too (audit 4, 1.1 and 1.3). Only the person naming the control in their own words lowers it.
 */
function structuralHigh(label: string, role: string, ctx: PageContext, task: string): "form" | "unknown" | null {
  if (!BUTTONISH.test(role.trim())) return null;
  if (safeLabel(label)) return null;
  if (taskNames(task, label)) return null;
  return ctx.controls.some(EDITABLE) ? "form" : "unknown";
}
const norm = (s: string): string => normLabel(s).toLowerCase();
/** True when `needle` (non-empty after normalising) appears in `hay`. An empty needle is never "named" (audit 4, 1.1). */
const hasWords = (hay: string, needle: string): boolean => { const n = norm(needle); return n.length > 0 && norm(hay).includes(n); };

/** Content tokens of a label: lower-case words of 3+ letters. */
const words = (s: string): string[] => (norm(s).match(/[\p{L}\p{N}]{3,}/gu) ?? []);

/** The person's task names this target when it says the label, or every content word of it. An empty label is never named. */
export function taskNames(task: string, label: string): boolean {
  if (!norm(label)) return false;
  if (hasWords(task, label)) return true;
  const w = words(label);
  return w.length > 0 && w.every((x) => norm(task).includes(x));
}

/** Share of the content words of `text` that the person said. 1 when there are none to check. */
function ownWordsShare(text: string, authority: string): number {
  const STOP = /^(the|and|for|with|from|this|that|what|how|are|was|you|your|our|its|into|about|near|best|top|new|now|today|2026)$/;
  const w = words(text).filter((x) => !STOP.test(x));
  if (!w.length) return 1;
  const a = norm(authority);
  return w.filter((x) => a.includes(x)).length / w.length;
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
    case "search": {
      // A query is the person's words turned into a search. One that only page text addressed to an assistant supplied is not theirs.
      return action.query.length >= 4 && !hasWords(task, action.query) && tainted(ctx).some((t) => hasWords(t, action.query)) ? `${PAGE_ASKED} (that search comes from page text addressed to an assistant)` : null;
    }
    case "read_file": {
      const base = action.path.split("/").pop() ?? "";
      return base.length >= 3 && !hasWords(task, base) && tainted(ctx).some((t) => hasWords(t, base)) ? `${PAGE_ASKED} (the file is named only in page text addressed to an assistant)` : null;
    }
    case "open_app": case "quit_app": {
      return !hasWords(task, action.name) && tainted(ctx).some((t) => hasWords(t, action.name)) ? `${PAGE_ASKED} (the app is named only in page text addressed to an assistant)` : null;
    }
    default: return null;
  }
}

const LOW_KEYS = new Set(["tab", "shift+tab", "escape", "esc", "up", "down", "left", "right", "pageup", "pagedown", "home", "end", "cmd+l", "cmd+t", "cmd+f", "cmd+a", "cmd+c", "cmd+left", "cmd+right", "cmd+shift+4", "cmd+shift+3"]);
const MOD_ALIAS: Record<string, string> = { command: "cmd", cmd: "cmd", control: "ctrl", ctrl: "ctrl", option: "alt", opt: "alt", alt: "alt", shift: "shift" };
/** "Command+Shift+W" -> { mods: Set{cmd,shift}, key: "w", canon: "cmd+shift+w" } (modifiers in a fixed order). */
function splitCombo(combo: string): { mods: Set<string>; key: string; canon: string } {
  const parts = combo.toLowerCase().split("+");
  const key = parts.pop() ?? "";
  const mods = new Set(parts.map((m) => MOD_ALIAS[m] ?? m));
  const canon = [...["cmd", "ctrl", "alt", "shift"].filter((m) => mods.has(m)), key].join("+");
  return { mods, key, canon };
}

const submitLike = (c: { label: string; role: string }): boolean => /button|submit|link/i.test(c.role) && !!highHit(c.label);
const BUTTON_OR_LINK = /button|link|submit|menuitem|btn/i;
const WALLET_WORDS = /wallet|metamask|walletconnect|phantom|rabby|coinbase|ledger|trezor|approve|approval|signature|permit|confirm/i;

/** Values carried in an address (query and fragment) that the person did not say: how data leaves through a link. */
function urlCarriesOtherData(u: URL, authority: string): boolean {
  const vals: string[] = [];
  u.searchParams.forEach((v) => { if (v) vals.push(v); });
  if (u.hash.length > 1) vals.push(decodeURIComponent(u.hash.slice(1)).replace(/[=&]/g, " "));
  const text = vals.join(" ");
  return words(text).length > 0 && ownWordsShare(text, authority) < 0.6;
}

/**
 * classify(action, context, task) -> { risk, why }.
 * `task` is the PERSON's words only: the original task plus their answers. Never the model's own notes (audit 4, 1.5).
 * refused: never done (secret fields, secret-looking values the person did not give, the page asked for it).
 * high: needs the person's tap. medium: ordinary state-changing actions. low: reading, waiting, safe navigation.
 */
export function classify(action: Action, ctx: PageContext, task: string): Classified {
  const asked = pageAskedAction(action, ctx, task);
  if (asked) return { risk: "refused", why: asked };

  const wallet = walletFlow(ctx);
  const R = (risk: ActRisk, why: string): Classified => ({ risk, why });
  const inWallet = (): Classified | null => (wallet && !READ_ONLY.has(action.type) ? R("high", `${wallet}, so anything but reading needs your OK`) : null);
  const shown = (l: string) => (normLabel(l) ? `"${normLabel(l).slice(0, 40)}"` : "an unlabelled button");

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
      if (action.type === "type" && action.text.trim().length >= 4 && !hasWords(task, action.text) && ownWordsShare(action.text, task) < 0.8) {
        // A page reads every keystroke, so typing is a way out for data the person never gave (audit 4, 1.11).
        return R("high", `you did not give me the text "${normLabel(action.text).slice(0, 30)}", so I ask before typing it`);
      }
      if (action.type === "click") {
        const byLabel = highHit(label) ?? highHit(role);
        const byShape = byLabel ? null : structuralHigh(label, role, ctx, task);
        const nl = normLabel(label);
        // "don't submit": any click that would submit is refused outright, not even approvable. Deleting is a different act.
        if ((byLabel || byShape === "form") && NO_SUBMIT.test(task) && !DESTRUCTIVE.test(nl) && (byShape === "form" || SUBMIT_FAMILY.test(nl) || /submit/i.test(role))) return R("refused", NO_SUBMIT_SAY);
        const soft = !HARD_STOP.test(nl) && !HARD_STOP.test(normLabel(role));
        const A = (c: Classified): Classified => (soft ? { ...c, auto: true } : c);
        if (byShape === "form") return A(R("high", `${shown(label)} is a button on a form and could submit it`));
        if (byShape === "unknown") return A(R("high", `I can't tell what ${shown(label)} does, so I ask first`));
        if (byLabel) return A(R("high", `${shown(label)} commits something (${byLabel})`));
      }
      return R("medium", `${action.type} on "${label.slice(0, 40)}"`);
    }

    case "key": {
      const w = inWallet(); if (w) return w;
      const { mods, key, canon } = splitCombo(action.combo);
      const accel = mods.has("cmd") || mods.has("ctrl") || mods.has("alt");
      if (((key === "w" || key === "q") && (mods.has("cmd") || mods.has("ctrl"))) || (key === "f4" && mods.has("alt"))) {
        // The person said "close this window" / "quit X": their order is the approval in auto mode. Quitting needs the word quit/exit.
        const said = key === "q" ? /\b(quit|exit)\b/i.test(task) : /\bclose\b/i.test(task) && /\b(window|tab|this|it)\b/i.test(task);
        const c = R("high", `${action.combo} closes a window or quits an app`);
        return said ? { ...c, auto: true } : c;
      }
      if (key === "enter" || key === "return" || key === "space") {
        const focused = ctx.focused ? lookup(ctx, ctx.focused) : null;
        const fRole = focused?.kind === "control" ? focused.role : "";
        const isEnter = key !== "space";
        // A multi-line box: plain (or Shift+) Enter is a newline and Space a space. Cmd/Ctrl/Alt+Enter SENDS in most apps.
        if (/textarea|text ?area|contenteditable/i.test(fRole)) {
          if (isEnter && accel) return R(NO_SUBMIT.test(task) ? "refused" : "high", `${action.combo} sends the message in most text boxes`);
          return R("medium", isEnter ? "a new line in a text box" : "typing a space");
        }
        // A focused button or link: the key presses it, whatever modifiers are held, so it is exactly as risky as clicking it.
        if (focused && ctx.focused && BUTTON_OR_LINK.test(fRole)) {
          const c = classify({ type: "click", id: ctx.focused }, ctx, task);
          if (c.risk === "high" || c.risk === "refused") return R(c.risk, `${action.combo} would press ${shown(focused.label)}: ${c.why}`);
          return R("medium", `${action.combo} presses ${shown(focused.label)}`);
        }
        if (!isEnter) return R("medium", focused ? "typing a space" : `${action.combo} key`);
        // Enter in a field submits its form. Any button that is not plainly harmless may be that form's submit button: ask.
        if (ctx.controls.some((c) => submitLike(c) || (BUTTONISH.test(c.role.trim()) && !safeLabel(c.label)))) {
          if (NO_SUBMIT.test(task)) return R("refused", NO_SUBMIT_SAY);
          const hard = ctx.controls.some((c) => BUTTONISH.test(c.role.trim()) && HARD_STOP.test(normLabel(c.label)));
          return hard ? R("high", "Enter could submit the form on this page") : { ...R("high", "Enter could submit the form on this page"), auto: true };
        }
        return R("medium", `${action.combo} key`);
      }
      if (LOW_KEYS.has(canon)) return R("low", `${action.combo} only moves around`);
      return R("medium", `${action.combo} key`);
    }

    case "open_url": {
      const u = parseHttpUrl(action.url);
      if (!u) return R("refused", "not a plain http(s) address");
      const w = inWallet(); if (w) return w;
      if (urlCarriesOtherData(u, task)) return R("high", "the address carries text you did not give me");
      const host = u.hostname.toLowerCase().replace(/^www\./, "");
      if (hasWords(task, host)) return R("low", "an address you named");
      // "play a song on YouTube" names youtube, not youtube.com: the registrable label counts.
      const label = host.split(".").slice(-2, -1)[0] ?? host;
      if (label.length >= 3 && hasWords(task, label)) return R("low", `a site you named (${label})`);
      // An address that is only on the page (never in the task) is where phishing lives: ask.
      if (ctx.blocks.some((b) => hasWords(b.text, host)) || ctx.controls.some((c) => hasWords(c.label, host))) return R("high", "an address that came from the page, not from you");
      return R("medium", `opens ${host}`);
    }

    case "search": {
      // The query leaves the laptop for a search engine: it must be the person's words, not text taken from the page or a file.
      // Search operators the model adds ("site:wikipedia.org", "filetype:pdf") are syntax, not words the person must have said.
      if (ownWordsShare(action.query.replace(/(^|\s)[a-z]+:\S+/gi, " "), task) < 0.6) return R("high", `those search words did not come from you, and a search sends them to ${action.engine ?? "brave"}`);
      return R("low", `searches the web for your words (${action.engine ?? "brave"})`);
    }
    case "tab": {
      if (action.op === "close") {
        const w = inWallet(); if (w) return w;
        if (action.match && WALLET_WORDS.test(action.match)) return R("high", `the tab "${action.match.slice(0, 40)}" may be a wallet or approval page`);
        return R("medium", action.match ? `closes the tab matching "${action.match.slice(0, 40)}"` : "closes a tab");
      }
      return R("low", action.op === "switch" ? `switches to the tab matching "${(action.match ?? "").slice(0, 40)}"` : `tab ${action.op}`);
    }
    case "read_file": {
      const c = checkReadPath(action.path);
      if (!c.ok) return R("refused", c.why);
      return R("medium", `reads ${action.path.slice(0, 60)} (read-only, secrets redacted)`);
    }
    case "open_app": return R("medium", `opens ${action.name}`);
    case "quit_app": {
      const c = R("high", `quits ${action.name}`);
      // "quit Notes" names it; "close this window / quit this app" means the app that is in front, which the screen was read from.
      const isThisApp = /\b(this|it|current)\b/i.test(task) && !!ctx.app && norm(ctx.app) === norm(action.name);
      return /\b(quit|exit|close)\b/i.test(task) && (hasWords(task, action.name) || isThisApp) ? { ...c, auto: true } : c;
    }
    case "copy": {
      if (secretShaped(action.text) && !hasWords(task, action.text)) return R("refused", "that text looks like a secret and you did not give it to me in the task");
      const w = inWallet(); if (w) return w;
      return R("medium", "puts text on your clipboard");
    }
  }
}
