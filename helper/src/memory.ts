// Personal memory: what Ishara has seen of how THIS person uses it, kept only on this laptop.
//
// Three small parts, the same shape as a bigger "second brain" but person-sized:
//   1. an append-only EVENT LOG (events.jsonl): one line per ask / accepted / missed, nothing else;
//   2. a deterministic DISTILL step (no model): counts, topics, and the user's own words mapped to the labels
//      they accepted, rebuilt on every append and saved as profile.json;
//   3. RECALL: a few hundred characters about the CURRENT site, for the brain prompt, only if the switch is on.
//
// Why it is built this way: the product's promise is PRIVATE. So the log holds no page text, no form values and
// no secrets; the profile holds only counts, the user's own words, and what they accepted (no invented skill
// levels, no personality guesses); the user can see all of it (GET /memory), pause it, and delete it.
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export type MemKind = "ask" | "accepted" | "missed";
export type MemEvent = {
  t: number;              // ms since epoch
  kind: MemKind;
  host: string;           // hostname only: never the path or query (they can carry ids and tokens)
  question: string;       // redacted
  outcome?: "point" | "ask" | "safe_stop"; // "ask" events only
  label?: string;         // label of the proposed/pointed control (redacted, <= 80 chars)
};

export const MAX_EVENTS = 5000;
export const ACCEPT_WINDOW_MS = 20_000; // the user must click/focus the pointed element within this
export const MISSED_WINDOW_MS = 30_000; // asking again on the same page within this means the first answer did not help
const ACCEPT_GRACE_MS = 5_000;          // the extension's 20 s timer starts a little after the helper's clock
export const MIN_ALIAS_SIGHTINGS = 2;
export const CONTEXT_MAX_CHARS = 440;   // about 110-120 tokens

// ---- redaction ------------------------------------------------------------------------------------------------
// The question is the user's speech and may contain something read out by mistake. Anything that looks like a
// credential is replaced before it is stored; better to lose a word than to keep a secret on disk.
const STOP = new Set(("a an the and or but if of to in on at by for with from as is are was were be been it its this that these those i me my we " +
  "you your he she they them do does did can could should would will shall may might must how what where when which who whom why " +
  "there here so not no yes please just also about into over under up down out off again then than too very s t").split(/\s+/));
const SECRET_PATTERNS: RegExp[] = [
  /\b0x[0-9a-fA-F]{8,}\b/g,                         // addresses, hashes, raw keys
  /\b[0-9a-fA-F]{32,}\b/g,                          // bare hex keys / hashes
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}(?:\.[A-Za-z0-9_-]*)?/g, // JWT
  /\b(?:sk|pk|rk|ghp|gho|ghs|github_pat|xox[abp]|AKIA|AIza|glpat|npm)[-_][A-Za-z0-9_-]{8,}\b/g, // known token prefixes
  /\bAKIA[0-9A-Z]{12,}\b/g,
  /\bbearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  /\b[A-Za-z0-9+/_-]{24,}={0,2}(?=\W|$)/g,          // long opaque blobs (base64/base58/api keys)
  /[\w.+-]+@[\w-]+\.[\w.-]+/g,                      // email addresses
  /\b\d[\d -]{8,}\d\b/g,                            // long digit runs (cards, phone numbers, ids)
];
export function redact(text: string): string {
  let s = String(text ?? "").replace(/\s+/g, " ").trim();
  for (const re of SECRET_PATTERNS) s = s.replace(re, "[redacted]");
  // A seed phrase read aloud: 12+ short lowercase words in a row, with almost no ordinary question words among them.
  const words = s.split(" ");
  const out: string[] = [];
  for (let i = 0; i < words.length;) {
    let j = i, stops = 0;
    while (j < words.length && /^[a-z]{3,8}$/.test(words[j])) { if (STOP.has(words[j])) stops++; j++; }
    if (j - i >= 12 && stops <= 3) { out.push("[redacted]"); i = j; } else { out.push(words[i]); i++; }
  }
  return out.join(" ").replace(/(?:\[redacted\]\s*){2,}/g, "[redacted] ").trim().slice(0, 300);
}

// Host only. The page's own address can carry tokens in its path/query, and the profile is per site, not per page.
export function hostOf(url: string): string {
  try {
    const u = new URL(url);
    return (u.hostname || `${u.protocol}//${u.pathname.split("/").filter(Boolean)[0] ?? ""}`).toLowerCase().slice(0, 80);
  } catch { return "unknown"; }
}

// ---- distill --------------------------------------------------------------------------------------------------
// Light stemming: enough to count "verify", "verifying", "verification-ish" forms together, with no dictionary.
export function stem(w: string): string {
  let s = w.toLowerCase();
  for (const suf of ["ication", "ing", "ed", "es", "s"]) if (s.length > suf.length + 3 && s.endsWith(suf)) { s = s.slice(0, -suf.length); break; }
  return s;
}
export function tokens(text: string): string[] {
  return (text.toLowerCase().match(/[a-z][a-z0-9]+/g) ?? []).filter((w) => w.length > 2 && !STOP.has(w) && w !== "redacted");
}

export type Alias = { word: string; label: string; count: number };
export type HostProfile = {
  host: string;
  asked: number; accepted: number; missed: number;
  topics: { word: string; count: number }[];
  aliases: Alias[];
  lastQuestions: string[];  // newest first, distinct
};
export type Profile = {
  updatedAt: number;
  events: number;
  typicalQuestionWords: number; // median words per question: a number, not a label
  hosts: Record<string, HostProfile>;
};

export function distill(events: MemEvent[], now = Date.now()): Profile {
  const hosts: Record<string, HostProfile> = {};
  const lens: number[] = [];
  const topicCount = new Map<string, Map<string, { n: number; surf: Map<string, number> }>>();
  const aliasCount = new Map<string, Map<string, Alias>>();
  for (const e of events) {
    const h = (hosts[e.host] ??= { host: e.host, asked: 0, accepted: 0, missed: 0, topics: [], aliases: [], lastQuestions: [] });
    if (e.kind === "ask") {
      h.asked++;
      const n = e.question.split(/\s+/).filter(Boolean).length;
      if (n) lens.push(n);
      const tc = topicCount.get(e.host) ?? new Map(); topicCount.set(e.host, tc);
      for (const w of new Set(tokens(e.question))) {
        const rec = tc.get(stem(w)) ?? { n: 0, surf: new Map() };
        rec.n++; rec.surf.set(w, (rec.surf.get(w) ?? 0) + 1); tc.set(stem(w), rec);
      }
    } else if (e.kind === "missed") h.missed++;
    else if (e.kind === "accepted") {
      h.accepted++;
      // The user's own word for a control: a question word (not a stop word, not the whole label) seen with the label
      // they accepted. Counted per (word, label); only pairs seen >= MIN_ALIAS_SIGHTINGS times are kept.
      if (e.label) {
        const ac = aliasCount.get(e.host) ?? new Map(); aliasCount.set(e.host, ac);
        for (const w of new Set(tokens(e.question))) {
          const key = stem(w) + "\u0000" + e.label.toLowerCase();
          const a = ac.get(key) ?? { word: w, label: e.label, count: 0 };
          a.count++; ac.set(key, a);
        }
      }
    }
  }
  for (const [host, h] of Object.entries(hosts)) {
    h.topics = [...(topicCount.get(host)?.values() ?? [])]
      .map((r) => ({ word: [...r.surf.entries()].sort((a, b) => b[1] - a[1])[0][0], count: r.n }))
      .sort((a, b) => b.count - a.count || a.word.localeCompare(b.word)).slice(0, 8);
    h.aliases = [...(aliasCount.get(host)?.values() ?? [])].filter((a) => a.count >= MIN_ALIAS_SIGHTINGS)
      .sort((a, b) => b.count - a.count || a.word.localeCompare(b.word)).slice(0, 10);
    const seen = new Set<string>();
    for (let i = events.length - 1; i >= 0 && h.lastQuestions.length < 5; i--) {
      const e = events[i];
      if (e.host !== host || e.kind !== "ask" || !e.question || seen.has(e.question)) continue;
      seen.add(e.question); h.lastQuestions.push(e.question);
    }
  }
  lens.sort((a, b) => a - b);
  return { updatedAt: now, events: events.length, typicalQuestionWords: lens.length ? lens[Math.floor(lens.length / 2)] : 0, hosts };
}

// ---- recall ---------------------------------------------------------------------------------------------------
// Only the current host's data, only the user's own words and labels they accepted, never the outline. Trimmed to
// a hard character budget so memory can never crowd out the page outline in the prompt.
export function recall(profile: Profile, host: string): string {
  const h = profile.hosts[host];
  if (!h) return "";
  const clean = (s: string, n: number) => s.replace(/["\n\r]/g, "'").slice(0, n);
  const parts: string[] = [];
  if (h.lastQuestions.length) parts.push("earlier on this site the user asked: " + h.lastQuestions.slice(0, 3).map((q) => `"${clean(q, 70)}"`).join("; "));
  for (const a of h.aliases.slice(0, 3)) parts.push(`they call "${clean(a.word, 20)}" the control "${clean(a.label, 50)}"`);
  while (parts.length) {
    const s = parts.join("; ") + ".";
    if (s.length <= CONTEXT_MAX_CHARS) return s[0].toUpperCase() + s.slice(1);
    parts.pop(); // drop the least useful (last) part until it fits
  }
  return "";
}

// ---- the store ------------------------------------------------------------------------------------------------
type Pending = { t: number; question: string; host: string; outcome: "point" | "ask" | "safe_stop"; label?: string; accepted: boolean; missed: boolean };

export class Memory {
  readonly dir: string;
  private events: MemEvent[] | null = null;
  private profile: Profile | null = null;
  private last = new Map<string, Pending>(); // per session+host: the latest ask, for accepted/missed
  private now: () => number;
  private max: number;
  // No TS parameter properties: node runs this file by type-stripping, which does not support them.
  constructor(dir: string, now: () => number = Date.now, max = MAX_EVENTS) { this.dir = dir; this.now = now; this.max = max; }

  private get evFile() { return join(this.dir, "events.jsonl"); }
  private get profFile() { return join(this.dir, "profile.json"); }
  private get pauseFile() { return join(this.dir, "paused"); }

  paused(): boolean { return existsSync(this.pauseFile); }
  pause(): void { mkdirSync(this.dir, { recursive: true }); writeFileSync(this.pauseFile, "paused\n"); }
  resume(): void { rmSync(this.pauseFile, { force: true }); }

  private load(): MemEvent[] {
    if (this.events) return this.events;
    const out: MemEvent[] = [];
    try {
      for (const line of readFileSync(this.evFile, "utf8").split("\n")) {
        if (!line.trim()) continue;
        try { out.push(JSON.parse(line)); } catch { /* a torn last line must not lose the rest */ }
      }
    } catch { /* no file yet */ }
    return (this.events = out);
  }

  private append(e: MemEvent): void {
    const evs = this.load();
    evs.push(e);
    mkdirSync(this.dir, { recursive: true });
    if (evs.length > this.max) {
      // Over the cap: drop the oldest and rewrite atomically (tmp + rename) so a crash never leaves half a log.
      evs.splice(0, evs.length - this.max);
      const tmp = this.evFile + ".tmp";
      writeFileSync(tmp, evs.map((x) => JSON.stringify(x)).join("\n") + "\n");
      renameSync(tmp, this.evFile);
    } else appendFileSync(this.evFile, JSON.stringify(e) + "\n");
    // Cheap enough to rebuild every time (a few thousand short lines), and it keeps profile.json always current.
    this.profile = distill(evs, this.now());
    writeFileSync(this.profFile, JSON.stringify(this.profile, null, 2));
  }

  getProfile(): Profile { return this.profile ?? (this.profile = distill(this.load(), this.now())); }

  /** Record one decision. Also logs "missed" for the previous ask on this page if it did not help. */
  recordAsk(sessionId: string, host: string, question: string, outcome: "point" | "ask" | "safe_stop", label?: string): void {
    if (this.paused() || !host) return;
    const t = this.now(), q = redact(question);
    if (!q) return;
    const key = sessionId + "\u0000" + host;
    const prev = this.last.get(key);
    // An answer the user did not act on, followed within 30 s by another question on the same page: it probably did
    // not help. A safe_stop is the system refusing, not an answer, so it never counts against the earlier one.
    if (prev && !prev.accepted && !prev.missed && prev.outcome !== "safe_stop" && t - prev.t <= MISSED_WINDOW_MS) {
      prev.missed = true;
      this.append({ t, kind: "missed", host, question: prev.question, ...(prev.label ? { label: prev.label } : {}) });
    }
    const lab = label ? redact(label).slice(0, 80) : undefined;
    this.append({ t, kind: "ask", host, question: q, outcome, ...(lab ? { label: lab } : {}) });
    this.last.set(key, { t, question: q, host, outcome, label: lab, accepted: false, missed: false });
    if (this.last.size > 200) this.last.delete(this.last.keys().next().value as string);
  }

  /** The user clicked or focused the pointed element. Counts once, only for a "point", only inside the window. */
  recordAccepted(sessionId: string, host: string, question: string): boolean {
    if (this.paused()) return false;
    const p = this.last.get(sessionId + "\u0000" + host);
    if (!p || p.outcome !== "point" || p.accepted || p.missed) return false;
    if (p.question !== redact(question)) return false; // feedback for an older question: ignore
    if (this.now() - p.t > ACCEPT_WINDOW_MS + ACCEPT_GRACE_MS) return false;
    p.accepted = true;
    this.append({ t: this.now(), kind: "accepted", host, question: p.question, ...(p.label ? { label: p.label } : {}) });
    return true;
  }

  context(host: string): string { return this.paused() ? "" : recall(this.getProfile(), host); }

  /** What the page shows: the profile, counts, and only the last 20 questions (not the raw log). */
  view() {
    const evs = this.load();
    return {
      paused: this.paused(),
      dir: this.dir,
      cap: this.max,
      counts: {
        events: evs.length,
        asked: evs.filter((e) => e.kind === "ask").length,
        accepted: evs.filter((e) => e.kind === "accepted").length,
        missed: evs.filter((e) => e.kind === "missed").length,
      },
      profile: this.getProfile(),
      recent: evs.filter((e) => e.kind === "ask").slice(-20).reverse().map((e) => ({ t: e.t, host: e.host, question: e.question, outcome: e.outcome })),
    };
  }

  /** Delete everything (log and profile). The pause setting is a preference, not data, so it stays. */
  forget(): void {
    rmSync(this.evFile, { force: true }); rmSync(this.profFile, { force: true });
    this.events = []; this.profile = null; this.last.clear();
  }
}

// ---- default instance -----------------------------------------------------------------------------------------
let shared: Memory | null = null;
export function memory(): Memory {
  if (shared) return shared;
  // ISHARA_MEMORY_DIR lets the eval use a throwaway memory. Under `node --test` (NODE_TEST_CONTEXT is set) the
  // default is a temp dir, so running the tests can never write into the user's real memory.
  const dir = process.env.ISHARA_MEMORY_DIR
    ?? (process.env.NODE_TEST_CONTEXT ? join(tmpdir(), `ishara-mem-test-${process.pid}`) : fileURLToPath(new URL("../.data/memory/", import.meta.url)));
  return (shared = new Memory(dir));
}
/** Only the opt-in switch lets memory reach the sealed prompt; recording does not depend on it. */
export const memoryUsed = (): boolean => process.env.ISHARA_MEMORY === "1";

// ---- HTTP routes ----------------------------------------------------------------------------------------------
// Kept here as a pure function so the routes are testable without a socket. server.ts calls it AFTER the
// Host/Origin guard (http-guard.ts), so every route below inherits that guard.
export function memoryRoute(mem: Memory, method: string, path: string, bodyText: string): { status: number; body: unknown } | null {
  if (path === "/memory" && method === "GET") return { status: 200, body: { ...mem.view(), usedInPrompt: memoryUsed() } };
  if (path === "/memory" && method === "DELETE") { mem.forget(); return { status: 200, body: { ok: true, forgotten: true } }; }
  if (path === "/memory/pause" && method === "POST") { mem.pause(); return { status: 200, body: { ok: true, paused: true } }; }
  if (path === "/memory/resume" && method === "POST") { mem.resume(); return { status: 200, body: { ok: true, paused: false } }; }
  if (path === "/memory/feedback" && method === "POST") {
    let b: any;
    try { b = JSON.parse(bodyText); } catch { return { status: 400, body: { error: "need JSON" } }; }
    if (b?.kind !== "accepted" || typeof b.question !== "string" || typeof b.host !== "string")
      return { status: 400, body: { error: "need { sessionId, question, host, kind: \"accepted\" }" } };
    const ok = mem.recordAccepted(String(b.sessionId ?? "default"), String(b.host).toLowerCase().slice(0, 80), b.question);
    return { status: 200, body: { ok, recorded: ok } };
  }
  return null;
}
