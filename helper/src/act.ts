// act.ts: the Action schema's guard rails (docs/AGENT-MODE.md). 0GM proposes, this file decides whether the proposal is even
// well-formed. Pure functions, no network. The error strings are written for the MODEL to read and correct itself with,
// so they say what is wrong and what would be right.
import type { Action, ActionType, Control, PageContext, SearchEngine, TabOp } from "./types.ts";

export type { Action, ActRequest, ActEvent, ActRisk } from "./types.ts";

export const MAX_TEXT = 2000;
export const MAX_SAY = 300;
export const MAX_WAIT_MS = 3000;
export const ACTION_TYPES: readonly ActionType[] = ["click", "type", "select", "check", "key", "scroll", "open_url", "search", "tab", "read_file", "open_app", "quit_app", "copy", "screenshot", "wait", "done", "ask", "fail"];
export const TERMINAL: ReadonlySet<ActionType> = new Set(["done", "ask", "fail"]);

export type Validated = { ok: true; action: Action } | { ok: false; error: string };
const bad = (error: string): Validated => ({ ok: false, error });

// Roles come from the outline (input|select|checkbox|button|link|text) and from aria on the desktop. A type target must be
// something you can put text into; "select-like" is allowed because a combobox is typed into.
const TEXT_ROLE = /^(input|textarea|textbox|searchbox|text ?field|text ?area|edit|combobox|search|select)$/i;
const SELECT_ROLE = /^(select|combobox|listbox|popup ?button|pop ?up|menu ?button|dropdown)$/i;
const CHECK_ROLE = /^(checkbox|radio|switch|toggle|check ?box|menuitemcheckbox)$/i;

export const isTextRole = (role: string): boolean => TEXT_ROLE.test(role.trim());
export const isSelectRole = (role: string): boolean => SELECT_ROLE.test(role.trim());
export const isCheckRole = (role: string): boolean => CHECK_ROLE.test(role.trim());

/** The Control or Block an id points at, or null. Controls are b-ids and blocks t-ids but the lookup does not rely on that. */
export function lookup(ctx: PageContext, id: string): { kind: "control"; control: Control; label: string; role: string } | { kind: "block"; label: string; role: "text" } | null {
  const c = ctx.controls.find((x) => x.id === id);
  if (c) return { kind: "control", control: c, label: c.label, role: c.role };
  const b = ctx.blocks.find((x) => x.id === id);
  if (b) return { kind: "block", label: b.text, role: "text" };
  return null;
}

// Key combos: modifiers joined by "+", then one key. A safe grammar so a model cannot smuggle shell or AppleScript text through
// `combo`: only these words and single printable characters ever reach an executor.
const MODS = new Set(["cmd", "command", "ctrl", "control", "alt", "option", "opt", "shift"]);
const NAMED = new Set(["enter", "return", "escape", "esc", "tab", "space", "backspace", "delete", "up", "down", "left", "right", "pageup", "pagedown", "home", "end"]);
const FKEY = /^f([1-9]|1[0-2])$/;
const PUNCT = new Set([",", ".", "/", "-", "=", "[", "]", ";", "'", "`", "\\"]);
/** Canonical lower-case combo ("Cmd+T" -> "cmd+t") or null when the grammar is not met. */
export function parseCombo(raw: string): string | null {
  const s = raw.trim().toLowerCase();
  if (!s || s.length > 40) return null;
  // "cmd++" would mean cmd and the plus key; the plus key is not offered, so a trailing "+" is simply invalid.
  const parts = s.split("+").map((p) => p.trim());
  if (parts.some((p) => !p)) return null;
  const key = parts[parts.length - 1];
  const mods = parts.slice(0, -1);
  if (mods.some((m) => !MODS.has(m)) || new Set(mods).size !== mods.length) return null;
  const okKey = NAMED.has(key) || FKEY.test(key) || /^[a-z0-9]$/.test(key) || PUNCT.has(key);
  return okKey ? [...mods, key].join("+") : null;
}

const str = (v: unknown): v is string => typeof v === "string";
const clipSay = (v: unknown): string => (str(v) ? v.replace(/\s+/g, " ").trim().slice(0, MAX_SAY) : "");

/** Parse a URL the way an executor will: http(s) only, a real hostname, no credentials, no control characters. */
export function parseHttpUrl(raw: string): URL | null {
  const s = raw.trim();
  if (!s || s.length > MAX_TEXT || /[\u0000-\u001f\u007f\s]/.test(s)) return null;
  let u: URL;
  try { u = new URL(s); } catch { return null; }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  if (!u.hostname || u.username || u.password) return null;
  return u;
}

export const MAX_QUERY = 200;
export const SEARCH_ENGINES: readonly SearchEngine[] = ["brave", "google", "duckduckgo"];
const ENGINE_URL: Record<SearchEngine, string> = {
  brave: "https://search.brave.com/search?q=",
  google: "https://www.google.com/search?q=",
  duckduckgo: "https://duckduckgo.com/?q=",
};
/** The results address for a search action. https only, the query URL-encoded; pure, so no executor invents its own. */
export function searchUrl(query: string, engine: SearchEngine = "brave"): string {
  return ENGINE_URL[engine] + encodeURIComponent(query.replace(/\s+/g, " ").trim());
}
export const TAB_OPS: readonly TabOp[] = ["switch", "close", "back", "forward", "new"];
export const MAX_MATCH = 100;
export const MAX_PATH = 500;

const needId = (a: Record<string, unknown>, ctx: PageContext, verb: string, want: (role: string) => boolean, wantText: string): Validated | { id: string; label: string; role: string } => {
  if (!str(a.id) || !a.id) return bad(`${verb} needs an "id" taken from the controls list.`);
  const hit = lookup(ctx, a.id);
  if (!hit) return bad(`There is no "${a.id.slice(0, 20)}" on this page. Use only ids from the data, for example ${ctx.controls.slice(0, 3).map((c) => c.id).join(", ") || "none listed"}.`);
  if (hit.kind === "block" && verb !== "click") return bad(`"${a.id}" is plain text, not a control. ${verb} needs ${wantText}.`);
  if (hit.kind === "control" && !want(hit.role)) return bad(`"${a.id}" is a ${hit.role} ("${hit.label.slice(0, 40)}"), not ${wantText}. Pick the right control or use another action.`);
  return { id: a.id, label: hit.label, role: hit.role };
};

/** Check one proposed action against the page. Unknown fields are dropped; the returned action has exactly the schema's keys. */
export function validateAction(raw: unknown, ctx: PageContext): Validated {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return bad('"action" must be an object like {"type":"click","id":"b3"}.');
  const a = raw as Record<string, unknown>;
  const t = a.type;
  if (!str(t) || !(ACTION_TYPES as readonly string[]).includes(t)) return bad(`Unknown action type. Use one of: ${ACTION_TYPES.join(", ")}.`);
  switch (t as ActionType) {
    case "click": {
      const r = needId(a, ctx, "click", () => true, "something to click");
      return "ok" in r ? r : { ok: true, action: { type: "click", id: r.id } };
    }
    case "type": {
      const r = needId(a, ctx, "type", isTextRole, "a text field");
      if ("ok" in r) return r;
      if (!str(a.text)) return bad('type needs a "text" string.');
      if (a.text.length > MAX_TEXT) return bad(`text is over ${MAX_TEXT} characters; type a shorter value.`);
      if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(a.text)) return bad("text contains control characters; plain text only.");
      return { ok: true, action: { type: "type", id: r.id, text: a.text, ...(a.clear === true ? { clear: true } : {}) } };
    }
    case "select": {
      const r = needId(a, ctx, "select", isSelectRole, "a dropdown");
      if ("ok" in r) return r;
      if (!str(a.option) || !a.option.trim()) return bad('select needs an "option": the visible label of the choice.');
      if (a.option.length > 200) return bad("option is too long; use the visible label.");
      return { ok: true, action: { type: "select", id: r.id, option: a.option.trim() } };
    }
    case "check": {
      const r = needId(a, ctx, "check", isCheckRole, "a checkbox or toggle");
      if ("ok" in r) return r;
      if (typeof a.checked !== "boolean") return bad('check needs "checked": true or false.');
      return { ok: true, action: { type: "check", id: r.id, checked: a.checked } };
    }
    case "key": {
      const combo = str(a.combo) ? parseCombo(a.combo) : null;
      if (!combo) return bad('key needs a "combo" such as "Enter", "Escape", "Tab", "cmd+t" or "cmd+l": optional modifiers (cmd, ctrl, alt, shift) joined by + and then one key.');
      return { ok: true, action: { type: "key", combo } };
    }
    case "scroll": {
      if (a.direction !== "up" && a.direction !== "down") return bad('scroll needs "direction": "up" or "down".');
      if (a.amount !== undefined && a.amount !== "line" && a.amount !== "page") return bad('scroll "amount" is "line" or "page".');
      return { ok: true, action: { type: "scroll", direction: a.direction, ...(a.amount ? { amount: a.amount as "line" | "page" } : {}) } };
    }
    case "open_url": {
      const u = str(a.url) ? parseHttpUrl(a.url) : null;
      if (!u) return bad('open_url needs a full http or https "url" with a hostname, for example "https://example.com/page".');
      return { ok: true, action: { type: "open_url", url: u.href } };
    }
    case "search": {
      const q = str(a.query) ? a.query.replace(/\s+/g, " ").trim() : "";
      if (!q) return bad('search needs a "query": the words to search for.');
      if (q.length > MAX_QUERY) return bad(`query is over ${MAX_QUERY} characters; use a shorter one.`);
      if (/[\u0000-\u001f\u007f]/.test(q)) return bad("query contains control characters; plain words only.");
      if (a.engine !== undefined && !(SEARCH_ENGINES as readonly unknown[]).includes(a.engine)) return bad(`engine is one of: ${SEARCH_ENGINES.join(", ")} (default brave).`);
      return { ok: true, action: { type: "search", query: q, ...(a.engine ? { engine: a.engine as SearchEngine } : {}) } };
    }
    case "tab": {
      if (!(TAB_OPS as readonly unknown[]).includes(a.op)) return bad(`tab needs "op": one of ${TAB_OPS.join(", ")}.`);
      const op = a.op as TabOp;
      let match: string | undefined;
      if (a.match !== undefined) {
        match = str(a.match) ? a.match.replace(/\s+/g, " ").trim() : "";
        if (!match || match.length > MAX_MATCH || /[\u0000-\u001f\u007f]/.test(match)) return bad(`match is a short piece of the tab's title or address (at most ${MAX_MATCH} characters).`);
      }
      if (op === "switch" && !match) return bad('tab switch needs "match": part of the title or address of the tab to switch to.');
      return { ok: true, action: { type: "tab", op, ...(match && (op === "switch" || op === "close") ? { match } : {}) } };
    }
    case "read_file": {
      const p = str(a.path) ? a.path.trim() : "";
      if (!p) return bad('read_file needs a "path" to a text file, for example "~/Documents/notes.txt".');
      if (p.length > MAX_PATH || /[\u0000-\u001f\u007f]/.test(p)) return bad("path is too long or has control characters.");
      return { ok: true, action: { type: "read_file", path: p } };
    }
    case "open_app": case "quit_app": {
      const n = str(a.name) ? a.name.trim() : "";
      // An app name is passed to the OS by an executor, so keep it to a plain name: no paths, no shell characters.
      if (!n || n.length > 80 || /[\/\\\u0000-\u001f"`$;|&<>]/.test(n)) return bad(`${t} needs a plain application "name" such as "Notes" or "Google Chrome".`);
      return { ok: true, action: { type: t as "open_app" | "quit_app", name: n } };
    }
    case "copy": {
      if (!str(a.text) || !a.text) return bad('copy needs a "text" to put on the clipboard.');
      if (a.text.length > MAX_TEXT) return bad(`text is over ${MAX_TEXT} characters.`);
      return { ok: true, action: { type: "copy", text: a.text } };
    }
    case "screenshot": {
      if (a.to !== "clipboard" && a.to !== "file") return bad('screenshot needs "to": "clipboard" or "file".');
      return { ok: true, action: { type: "screenshot", to: a.to } };
    }
    case "wait": {
      const ms = typeof a.ms === "number" ? a.ms : Number(a.ms);
      if (!Number.isFinite(ms) || ms < 0 || ms > MAX_WAIT_MS) return bad(`wait needs "ms" between 0 and ${MAX_WAIT_MS}.`);
      return { ok: true, action: { type: "wait", ms: Math.round(ms) } };
    }
    case "done": case "ask": case "fail": {
      const say = clipSay(a.say);
      if (!say) return bad(`${t} needs a short "say" sentence for the person.`);
      return { ok: true, action: { type: t as "done" | "ask" | "fail", say } };
    }
  }
}

// ---- Reading what the model sent back ------------------------------------------------------------------------------
export type ActArgs = { action: unknown; say?: string };

function tryJson(s: string): unknown { try { return JSON.parse(s); } catch { return undefined; } }

/** Pull a JSON object out of free text: the whole string, a fenced block, a <tool_call> tag, or the first balanced {...}. */
export function jsonFromText(text: string): unknown {
  const t = text.trim();
  if (!t) return undefined;
  const direct = tryJson(t);
  if (direct && typeof direct === "object") return direct;
  const tag = t.match(/<tool_call>\s*([\s\S]*?)\s*(?:<\/tool_call>|$)/i)?.[1];
  if (tag) { const j = tryJson(tag); if (j && typeof j === "object") return j; }
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  if (fence) { const j = tryJson(fence.trim()); if (j && typeof j === "object") return j; }
  const start = t.indexOf("{");
  if (start >= 0) {
    let depth = 0, inStr = false, esc = false;
    for (let i = start; i < t.length; i++) {
      const ch = t[i];
      if (inStr) { if (esc) esc = false; else if (ch === "\\") esc = true; else if (ch === '"') inStr = false; continue; }
      if (ch === '"') inStr = true;
      else if (ch === "{") depth++;
      else if (ch === "}" && --depth === 0) { const j = tryJson(t.slice(start, i + 1)); return j && typeof j === "object" ? j : undefined; }
    }
  }
  return undefined;
}

/** Normalise whatever object the model produced into { action, say }. Accepts {action,say}, {name,arguments:{...}}, a flat action, or an action given as a JSON string. */
export function normalizeArgs(v: unknown): ActArgs | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  let o = v as Record<string, unknown>;
  if (o.name === "act" && o.arguments !== undefined) { // a whole tool-call object written into content
    const inner = typeof o.arguments === "string" ? tryJson(o.arguments) : o.arguments;
    if (!inner || typeof inner !== "object") return null;
    o = inner as Record<string, unknown>;
  }
  if (o.function && typeof o.function === "object") return normalizeArgs((o.function as Record<string, unknown>).arguments !== undefined ? { name: "act", arguments: (o.function as Record<string, unknown>).arguments } : null);
  let action: unknown = o.action;
  if (typeof action === "string") { const j = tryJson(action); action = j !== undefined ? j : { type: action, ...(o.id !== undefined ? { id: o.id } : {}) }; }
  if (action === undefined && typeof o.type === "string") { const { say: _s, ...flat } = o; action = flat; } // the model flattened the call
  if (action === undefined) return null;
  const say = str(o.say) ? o.say : str((action as Record<string, unknown>)?.say) ? ((action as Record<string, unknown>).say as string) : undefined;
  return { action, ...(say !== undefined ? { say } : {}) };
}

/** A chat completion's assistant message -> args, or null when nothing usable (the loop retries once, then fails). */
export function parseActMessage(msg: { content?: unknown; tool_calls?: unknown } | null | undefined): ActArgs | null {
  if (!msg) return null;
  const calls = Array.isArray(msg.tool_calls) ? (msg.tool_calls as any[]) : [];
  for (const c of calls) {
    const rawArgs = c?.function?.arguments;
    const parsed = typeof rawArgs === "string" ? (tryJson(rawArgs) ?? jsonFromText(rawArgs)) : rawArgs;
    const n = normalizeArgs(parsed);
    if (n) return n;
  }
  if (typeof msg.content === "string") { const n = normalizeArgs(jsonFromText(msg.content)); if (n) return n; }
  return null;
}
