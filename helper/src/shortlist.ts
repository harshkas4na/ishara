import type { OutlineElement } from "./types.ts";

// Words that appear in almost every question and carry no signal about which element is meant.
const STOP = new Set(["the", "a", "an", "i", "do", "does", "to", "of", "in", "on", "my", "me", "is", "it",
  "how", "where", "what", "can", "this", "that", "here", "for", "and", "or", "click", "press", "enter",
  "put", "go", "should", "which", "need", "want", "find", "show", "please", "form", "page", "setting"]);

// General interface vocabulary, not page-specific: how people word an action versus how pages label it.
// Measured miss without it: "submit this for verification" never shortlisted the "Verify and Publish" button.
const SYNONYMS: Record<string, string[]> = {
  submit: ["publish", "verify", "send", "confirm", "save", "apply"],
  send: ["submit", "publish"],
  publish: ["submit", "verify"],
  clear: ["reset", "erase", "cancel"],
  erase: ["reset", "clear"],
  empty: ["reset", "clear"],
  back: ["return", "previous"],
  help: ["guide", "support", "docs"],
  paste: ["code", "source", "text"],
  agree: ["terms", "accept"],
  accept: ["agree", "terms"],
  pick: ["select", "choose"],
  choose: ["select", "pick"],
};
// Words that say "I want to press something", so buttons deserve a boost over fields and links.
const ACTION = new Set(["submit", "send", "publish", "clear", "reset", "verify", "save", "confirm", "apply", "cancel", "erase"]);
const CONTROLS = new Set(["button", "input", "select", "checkbox", "radio", "textarea"]);

export function tokens(s: string): string[] {
  return s.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 1 && !STOP.has(t));
}

// Share a stem: "verify" and "verification" both start with "verif". Four letters is enough to avoid noise.
function sameStem(a: string, b: string): boolean {
  if (a.length < 4 || b.length < 4) return false;
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return i >= Math.min(5, Math.min(a.length, b.length));
}

// Local, instant, and the only thing that decides what laya may choose from, so it must be dumb and predictable:
// score = shared tokens (exact 2, same stem 1, synonym 1); ties keep outline order, controls before links.
// Headings (role "text") are never candidates: a heading cannot be what the pointer lands on.
export function shortlist(question: string, elements: OutlineElement[], n = 3): string[] {
  const q = tokens(question);
  const expanded = [...new Set(q.flatMap((t) => SYNONYMS[t] ?? []))].filter((s) => !q.includes(s));
  const wantsAction = q.some((t) => ACTION.has(t));
  const pool = elements.filter((e) => e.role !== "text");
  const scored = (pool.length >= n ? pool : elements).map((el, i) => {
    const lt = tokens(el.label);
    let score = 0;
    for (const t of q) {
      if (lt.includes(t)) score += 2;
      else if (lt.some((l) => sameStem(l, t))) score += 1;
    }
    for (const s of expanded) if (lt.includes(s) || lt.some((l) => sameStem(l, s))) score += 1;
    if (wantsAction && el.role === "button") score += 1.5;
    const prior = CONTROLS.has(el.role) ? 0.1 : 0; // zero-signal questions should land on controls, not nav links
    return { id: el.id, score: score + prior, i };
  });
  scored.sort((a, b) => b.score - a.score || a.i - b.i);
  return scored.slice(0, n).map((s) => s.id);
}
