// stream-parse.ts: turns the model's streamed text into events as it arrives (docs/TUTOR-INTERFACE.md section 3).
// Why incremental: the first spoken word must start when the first sentence ends, not when the reply ends, and a
// pointer must start its laya check the moment its tag is complete. Why strict about output: the model's text is
// shown and SPOKEN, so ids, tags, URLs and markdown must never get through, and an id that is not on this page is
// dropped silently (a hallucinated or page-injected "[POINT:b0]" is only ever a request, never a fact).
import type { TutorMode } from "./types.ts";

export type ParseEvent =
  | { type: "say"; text: string; seq: number }
  | { type: "point"; targetId: string; kind: "control" | "block"; seq: number }
  | { type: "step"; n: number; m: number }
  | { type: "wait" };

export const MAX_POINTS = 2;       // per answer outside guide mode
export const MAX_GUIDE_POINTS = 6; // one per step
export const MAX_STEPS = 6;
const HOLD_MAX = 40; // an unclosed "[" this far back is plain text, not a split tag

// Words after which a period does not end a sentence.
const ABBREV = /(?:^|[\s(])(?:e\.g|i\.e|vs|dr|mr|mrs|ms|approx|fig|no|st|inc|cf)$/i;

/** Remove everything that must never be spoken or shown: urls, ids, markdown, leftover markers. */
export function cleanSpoken(raw: string): string {
  return raw
    .replace(/\[\s*(?:POINT|STEP|WAIT)[^\]]*\]?/gi, " ")
    .replace(/\bhttps?:\/\/\S+/gi, " ")
    .replace(/\bwww\.\S+/gi, " ")
    .replace(/`+/g, "")
    .replace(/\*{1,3}([^*]+)\*{1,3}/g, "$1")
    .replace(/(^|\s)_{1,2}([^_]+)_{1,2}(?=\s|$)/g, "$1$2")
    .replace(/^\s{0,3}#{1,6}\s+/g, "")
    .replace(/^\s*[-*•]\s+/g, "")
    .replace(/\(\s*\b[bt]\d{1,4}\b\s*\)/gi, " ")
    .replace(/\[\s*[bt]\d{1,4}\s*\]/gi, " ")
    .replace(/\b[bt]\d{1,4}\b/gi, " ")
    .replace(/[*_#]{2,}/g, " ")
    .replace(/\s+([.,!?;:।])/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}
const hasWords = (s: string) => /[\p{L}\p{N}]/u.test(s);

export class TutorStreamParser {
  private valid: Set<string>;
  private guide: boolean;
  private raw = "";
  private cur = "";
  private seq = 0;           // says emitted so far
  private points = 0;
  private pointed = new Set<string>();
  private stopped = false;   // set after step 6: everything later is ignored
  constructor(o: { validIds: Iterable<string>; mode?: TutorMode }) {
    this.valid = new Set([...o.validIds].map((s) => s.toLowerCase()));
    this.guide = o.mode === "guide";
  }

  push(chunk: string): ParseEvent[] {
    this.raw += chunk;
    const out: ParseEvent[] = [];
    this.drain(false, out);
    return out;
  }
  /** Stream finished: flush a trailing sentence (and a trailing unclosed "[" as plain text). */
  end(): ParseEvent[] {
    const out: ParseEvent[] = [];
    this.drain(true, out);
    this.flush(out);
    return out;
  }

  private flush(out: ParseEvent[]): void {
    const text = cleanSpoken(this.cur);
    this.cur = "";
    if (this.stopped || !text || !hasWords(text)) return;
    out.push({ type: "say", text, seq: ++this.seq });
  }

  private drain(final: boolean, out: ParseEvent[]): void {
    const raw = this.raw;
    let i = 0;
    while (i < raw.length) {
      const c = raw[i];
      if (c === "[") {
        const close = raw.indexOf("]", i);
        if (close < 0) {
          if (!final && raw.length - i <= HOLD_MAX) break; // maybe a tag split across chunks: wait for the rest
          this.cur += c; i++; continue;
        }
        const body = raw.slice(i + 1, close).trim();
        const handled = this.tag(body, out);
        if (!handled) this.cur += raw.slice(i, close + 1); // ordinary brackets such as "[1]"; cleanSpoken drops marker-like ones
        i = close + 1;
        continue;
      }
      if (c === "." || c === "!" || c === "?" || c === "。" || c === "।" || c === "\n") {
        const next = raw[i + 1];
        if (next === undefined && !final && c !== "\n") break; // cannot tell "3." from "3.5" yet: wait for one more char
        if (c === "\n") { this.flush(out); i++; continue; }
        if (c === ".") {
          const notEnd =
            (next !== undefined && !/[\s"'”’)\]]/.test(next)) ||           // 3.5, v0.8.1, example.com, "..."
            /^\d{1,2}$/.test(this.cur.trim()) ||                            // "1. Click" numbered step
            ABBREV.test(this.cur);                                          // e.g. i.e. vs.
          if (notEnd) { this.cur += c; i++; continue; }
        }
        this.cur += c; i++;
        // swallow closing marks and repeated terminators: "?!", ".)", '."'
        while (i < raw.length && /[.!?।"'”’)]/.test(raw[i])) { this.cur += raw[i]; i++; }
        if (i >= raw.length && !final) { /* nothing after: the sentence still ends here */ }
        this.flush(out);
        continue;
      }
      this.cur += c; i++;
    }
    this.raw = raw.slice(i);
  }

  // Returns true when `body` was a marker (consumed, even if dropped), false when it is just bracketed text.
  private tag(body: string, out: ParseEvent[]): boolean {
    let m: RegExpMatchArray | null;
    if ((m = body.match(/^POINT\s*:\s*([A-Za-z]+\d*)$/i)) || (m = body.match(/^([bt]\d{1,4})$/i))) {
      if (this.stopped) return true;
      this.point(m[1].toLowerCase(), out);
      return true;
    }
    if (/^POINT\b/i.test(body)) return true; // malformed point tag: swallow, say nothing
    if ((m = body.match(/^STEP\s*(\d+)\s*(?:\/|of)\s*(\d+)$/i))) {
      if (!this.guide) return true;          // outside guide mode a plan marker means nothing
      const n = Number(m[1]), tot = Math.min(Number(m[2]), MAX_STEPS);
      this.flush(out);
      if (n > MAX_STEPS || n < 1) { this.stopped = true; return true; }
      out.push({ type: "step", n, m: Math.max(tot, n) });
      return true;
    }
    if (/^STEP\b/i.test(body)) return true;
    if (/^WAIT$/i.test(body)) {
      if (this.guide && !this.stopped) { this.flush(out); out.push({ type: "wait" }); }
      return true;
    }
    return false;
  }

  private point(id: string, out: ParseEvent[]): void {
    if (!this.valid.has(id)) return;                         // not on this page: dropped silently
    if (this.pointed.has(id)) return;                        // the same target twice is one pointer
    if (this.points >= (this.guide ? MAX_GUIDE_POINTS : MAX_POINTS)) return;
    this.points++; this.pointed.add(id);
    // "Sentence. [POINT:b7]" belongs to the sentence just finished; "Click [POINT:b7] here" to the one in progress.
    const seq = this.cur.trim() === "" && this.seq > 0 ? this.seq : this.seq + 1;
    out.push({ type: "point", targetId: id, kind: id.startsWith("b") ? "control" : "block", seq });
  }
}
