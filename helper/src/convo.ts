// convo.ts: what was just said on this tab+page, so "why?" and "and then?" can be answered (docs/TUTOR-INTERFACE.md
// section 6). RAM only by design: never written to disk, never given to memory.ts, because it holds what the person
// asked about their own screen. Keyed by tab, and reset when the page (origin + path) changes.
import type { TutorMode } from "./types.ts";

export type Turn = { q: string; a: string; pointedLabel?: string; mode?: TutorMode };
export const MAX_TURNS = 4;
export const MAX_TOKENS = 600;
export const IDLE_MS = 10 * 60 * 1000;
const approxTokens = (s: string) => Math.ceil(s.length / 4);

/** origin + path: the query and hash change without the page changing in a way the conversation cares about. */
export function pageKey(url: string): string {
  try { const u = new URL(url); return u.origin + u.pathname; } catch { return url.split(/[?#]/)[0]; }
}

/** Keep the newest turns that fit ~600 tokens; a single huge answer is clipped rather than dropping the turn. */
export function trimTurns(turns: Turn[], maxTokens = MAX_TOKENS): Turn[] {
  let kept = turns.slice(-MAX_TURNS).map((t) => ({ ...t, q: t.q.slice(0, 240), a: t.a.slice(0, 700) }));
  const cost = (t: Turn) => approxTokens(t.q) + approxTokens(t.a) + approxTokens(t.pointedLabel ?? "") + 4;
  while (kept.length > 1 && kept.reduce((n, t) => n + cost(t), 0) > maxTokens) kept = kept.slice(1);
  if (kept.length === 1 && cost(kept[0]) > maxTokens) kept = [{ ...kept[0], a: kept[0].a.slice(0, Math.max(80, (maxTokens - 40) * 4 - kept[0].q.length)) }];
  return kept;
}

const norm = (q: string) => q.toLowerCase().replace(/[^\p{L}\p{N}\s']/gu, " ").replace(/\s+/g, " ").trim();
const FOLLOW_START = /^(why|how come|and|then|so|but|what about|how about|aur|phir|fir|kyun|kyu|kyon|kaise|isse|iska|iski|uska|uski|matlab|explain more|tell me more|more|elaborate|really|ok|okay|go on)\b/;
const FOLLOW_WORD = /\b(it|that|those|them|one|ones|more|next|previous|again|iska|iski|uska|uski|isme|usme|isse|usse|wahi|wo|woh)\b/;
const NEW_TOPIC = /\b(new topic|something else|different question|another question|never ?mind|forget (that|it)|start over|reset|naya sawal|nayi baat|dusra sawal|doosra sawal|chhodo|chodo)\b/;

/** Short, pronoun or ellipsis turns that only make sense after the previous one. Pure; the caller checks there is history. */
export function isFollowUp(question: string): boolean {
  const q = norm(question);
  if (!q) return false;
  const words = q.split(" ");
  if (words.length > 5) return false;
  if (words.length <= 2 && /^(why|how|what|kyun|kyu|kyon|kaise|aur|phir|fir|and|then|so|really|more|matlab)$/.test(words[0])) return true;
  if (/^(where|kahan|kaha|show me|find)\b/.test(q) && words.length > 2 && !FOLLOW_WORD.test(q)) return false; // an explicit new "where is X"
  return FOLLOW_START.test(q) || FOLLOW_WORD.test(q);
}
export function isNewTopic(question: string): boolean { return NEW_TOPIC.test(norm(question)); }

type Slot = { page: string; turns: Turn[]; last: number };
export class ConvoStore {
  private slots = new Map<string, Slot>();
  private now: () => number;
  constructor(now: () => number = Date.now) { this.now = now; }

  /** The live turns for this tab+page. Clears the slot first when the page changed, it went idle, or it is a new topic. */
  turns(tabId: string, url: string, question?: string): Turn[] {
    const s = this.slots.get(tabId);
    if (!s) return [];
    if (s.page !== pageKey(url) || this.now() - s.last > IDLE_MS || (question && isNewTopic(question))) { this.slots.delete(tabId); return []; }
    return s.turns.slice();
  }
  record(tabId: string, url: string, turn: Turn): void {
    // Every page load is a new session id, so idle slots of closed tabs are swept here or they would pile up forever.
    for (const [k, s] of this.slots) if (this.now() - s.last > IDLE_MS) this.slots.delete(k);
    const page = pageKey(url);
    const live = this.turns(tabId, url);
    this.slots.set(tabId, { page, turns: trimTurns([...live, turn]), last: this.now() });
  }
  clear(tabId: string): void { this.slots.delete(tabId); }
  size(): number { return this.slots.size; }
}
export const convo = new ConvoStore();
