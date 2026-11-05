import type { OutlineElement } from "./types.ts";

// Words that appear in almost every question and carry no signal about which element is meant.
const STOP = new Set(["the", "a", "an", "i", "do", "does", "to", "of", "in", "on", "my", "me", "is", "it",
  "how", "where", "what", "can", "this", "that", "here", "for", "and", "or", "click", "press", "enter",
  "put", "go", "should", "which", "need", "want", "find", "show"]);

export function tokens(s: string): string[] {
  return s.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 1 && !STOP.has(t));
}

// Local, instant, and the only thing that decides what laya may choose from, so it must be dumb and predictable:
// score = number of shared tokens (prefix match counts, so "verify" hits "verified"); ties keep outline order.
export function shortlist(question: string, elements: OutlineElement[], n = 3): string[] {
  const q = tokens(question);
  const scored = elements.map((el, i) => {
    const lt = tokens(el.label);
    let score = 0;
    for (const t of q) {
      if (lt.includes(t)) score += 2;
      else if (lt.some((l) => l.length >= 4 && t.length >= 4 && (l.startsWith(t) || t.startsWith(l)))) score += 1;
    }
    return { id: el.id, score, i };
  });
  scored.sort((a, b) => b.score - a.score || a.i - b.i);
  return scored.slice(0, n).map((s) => s.id);
}
