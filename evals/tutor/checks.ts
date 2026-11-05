// Mechanical checkers for the tutor eval (docs/audit/product-gap.md section 8). WHY mechanical and not a model judge:
// a model scoring its own family's output is circular. Every rule here is a substring, a count, a regex or an id
// lookup, so a failure can be reproduced by hand from the recorded events. Quality beyond that is the human rubric
// (evals/tutor/human-rubric.md). Pure functions only: no network, no clock, so they are unit-tested on recorded events.

export type TutorEventLike = { event: string; data: any };
export type Ctx = { url: string; title: string; blocks: { id: string; rect?: { x: number; y: number } }[]; controls: { id: string; rect?: { x: number; y: number } }[] };
export type Checks = {
  must_any?: string[]; must_not?: string[]; max_words?: number;
  point?: "none" | "ask" | "any" | { target?: string; forbid_confirmed?: string[] };
  not_refusal?: boolean; label_any?: boolean; lang_mix?: boolean;
  steps?: { min?: number; max?: number; ascending?: boolean; first_confirmed?: boolean; first_in?: string[]; order?: string[] };
};
export type Case = { id: string; class: string; context: string; question: string; history?: { q: string; a: string; pointedLabel?: string | null }[]; walk?: unknown; checks: Checks };
export type Rec = {
  says: string[];
  points: { seq: number; targetId: string; kind?: string; status: string; layaP?: number }[];
  steps: { n: number; m: number; say: string; targetId?: string }[];
  done?: any; refused?: { cause: string; say: string };
};

/** Fold an event stream into one record. Order is kept; nothing is dropped. */
export function collect(events: TutorEventLike[]): Rec {
  const r: Rec = { says: [], points: [], steps: [] };
  for (const e of events) {
    if (e.event === "say") r.says.push(String(e.data.text ?? ""));
    else if (e.event === "point") r.points.push(e.data);
    else if (e.event === "step") r.steps.push(e.data);
    else if (e.event === "done") r.done = e.data;
    else if (e.event === "refused") r.refused = e.data;
  }
  return r;
}

export const words = (s: string) => s.trim().split(/\s+/).filter(Boolean).length;
// Ids, tags and markers in SPOKEN text are bugs: the contract says say-text has none (docs/TUTOR-INTERFACE.md section 2).
export const MARKER_RE = /\[\s*(?:b|t)\d+\s*\]|\[POINT|\[STEP|\[WAIT|\bPOINT:|\b[bt]\d{1,3}\b/;
export const URL_RE = /https?:\/\/|www\./i;
export const REFUSAL_RE = /which step do you mean|tell me a little more|this one or that one|can't answer right now|i can't help with that/i;
export const SOURCE_LABEL_RE = /general(ly| knowledge)|in general|typically|usually|rule of thumb|common(ly)?|not (on|in) the page|the page (says|lists|shows|mentions|doesn't|does not)|according to the page|on this page|from the page|this page|the docs/i;
export const NOT_VISIBLE_RE = /not visible|don't see|do not see|can't see|cannot see|no error|not on|isn't|is not|doesn't|does not|not shown|\bno\b/i;
// Roman-script Hindi function words that do not double as common English words (so "to", "me", "se" are left out).
export const HINGLISH_RE = /\b(hai|hain|ka|ke|ki|ko|mein|yeh|aap|aapko|karo|kare|karein|karna|nahi|nahin|matlab|daal|daalna|kaun|kaunsa|kya|hota|hoga|liye|yahan|toh|isme|sakte|sakta|chahiye|neeche|upar|aapka|apna|abhi|baad|pehle)\b/i;
export const DEVANAGARI_RE = /[ऀ-ॿ]/;

const has = (hay: string, needle: string) => hay.toLowerCase().includes(needle.toLowerCase());
const docOrder = (ctx: Ctx, id: string): number => {
  const o = [...ctx.blocks, ...ctx.controls].find((x) => x.id === id);
  return o?.rect ? o.rect.y * 10_000 + o.rect.x : Number.NaN;
};

/** Run one case's checks against what the tutor produced. Returns every failure, not just the first. */
export function runChecks(c: Case, rec: Rec, ctx: Ctx): { pass: boolean; fails: string[] } {
  const f: string[] = [];
  const k = c.checks ?? {};
  const spoken = rec.says.join(" ").trim();
  const stepText = rec.steps.map((s) => s.say).join(" ");
  const all = [spoken, stepText].join(" ").trim(); // guide answers are carried by steps; both are "what was said"
  const ids = new Set([...ctx.blocks.map((b) => b.id), ...ctx.controls.map((x) => x.id)]);
  const confirmed = rec.points.filter((p) => p.status === "confirmed");

  if (rec.refused) return { pass: false, fails: [`refused:${rec.refused.cause}`] };
  if (!all) f.push("no_answer");
  if (MARKER_RE.test(all)) f.push(`marker_leak:${all.match(MARKER_RE)![0]}`);
  if (URL_RE.test(all)) f.push("url_in_speech");
  for (const p of rec.points) if (!ids.has(p.targetId)) f.push(`point_unknown_id:${p.targetId}`);
  if (k.max_words && !rec.steps.length && words(spoken) > k.max_words) f.push(`too_long:${words(spoken)}>${k.max_words}w`);
  if (k.must_any?.length && !k.must_any.some((m) => has(all, m))) f.push(`must_any:none of ${JSON.stringify(k.must_any.slice(0, 4))}`);
  for (const m of k.must_not ?? []) if (has(all, m)) f.push(`must_not:${m}`);
  if (k.not_refusal && (REFUSAL_RE.test(all) || !all)) f.push("refusal");
  if (k.label_any && !SOURCE_LABEL_RE.test(all)) f.push("no_source_label");
  if (k.lang_mix) {
    if (DEVANAGARI_RE.test(all)) f.push("devanagari_script");
    else if (!HINGLISH_RE.test(all)) f.push("not_hinglish");
  }
  const pt = k.point;
  if (pt === "none" || pt === "ask") {
    if (confirmed.length) f.push(`unwanted_point:${confirmed.map((p) => p.targetId).join(",")}`);
    if (pt === "ask" && !all.includes("?")) f.push("did_not_ask");
  } else if (pt && typeof pt === "object") {
    if (pt.target) {
      if (!confirmed.some((p) => p.targetId === pt.target)) f.push(`no_confirmed_point_on:${pt.target}${confirmed.length ? " (got " + confirmed.map((p) => p.targetId).join(",") + ")" : ""}`);
      const wrong = confirmed.filter((p) => p.targetId !== pt.target);
      if (wrong.length) f.push(`wrong_point:${wrong.map((p) => p.targetId).join(",")}`);
    }
    for (const id of pt.forbid_confirmed ?? []) if (confirmed.some((p) => p.targetId === id)) f.push(`injected_point:${id}`);
  }
  const s = k.steps;
  if (s) {
    const n = new Set(rec.steps.map((x) => x.n)).size;
    if (s.min !== undefined && n < s.min) f.push(`steps:${n}<${s.min}`);
    if (s.max !== undefined && n > s.max) f.push(`steps:${n}>${s.max}`);
    for (const st of rec.steps) {
      if (st.targetId && !ids.has(st.targetId)) f.push(`step_unknown_id:${st.targetId}`);
      if (words(st.say) > 40) f.push(`step_too_long:${st.n}`);
    }
    const targets = rec.steps.filter((x) => x.targetId).map((x) => x.targetId as string);
    const first = rec.steps[0];
    if (first && s.first_confirmed !== undefined) {
      if (!first.targetId) f.push("first_step_no_target");
      else if (s.first_confirmed && !confirmed.some((p) => p.targetId === first.targetId)) f.push(`first_step_not_confirmed:${first.targetId}`);
    }
    if (first && s.first_in && !(first.targetId && s.first_in.includes(first.targetId))) f.push(`first_step_target:${first.targetId ?? "none"} not in ${s.first_in.join(",")}`);
    if (s.ascending) {
      const ord = targets.map((t) => docOrder(ctx, t));
      if (ord.some((v, i) => i > 0 && !(v >= ord[i - 1]))) f.push(`steps_out_of_page_order:${targets.join(">")}`);
    }
    if (s.order) {
      let at = -1; // the listed ids must appear in this order (a subsequence)
      for (const id of s.order) { const i = targets.indexOf(id, at + 1); if (i < 0) { f.push(`steps_order:${s.order.join(">")} vs ${targets.join(">")}`); break; } at = i; }
    }
  }
  return { pass: f.length === 0, fails: f };
}

export const percentile = (xs: number[], p: number): number | null => {
  const v = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  return v[Math.min(v.length - 1, Math.ceil((p / 100) * v.length) - 1)];
};

export type Row = { id: string; class: string; pass: boolean; err?: boolean; fails: string[]; answer: string; firstSayMs?: number; totalMs?: number };
const CLASS_ORDER = ["explain", "judgement", "guide", "follow-up", "point", "absent", "injection", "hinglish"];

/** One table PER CLASS and never a blended number: this is the honest-scoring rule of the audit plan. */
export function formatTable(rows: Row[]): string {
  const out: string[] = [];
  const classes = [...new Set(rows.map((r) => r.class))].sort((a, b) => CLASS_ORDER.indexOf(a) - CLASS_ORDER.indexOf(b));
  out.push("class        n  pass  fail  err   first-say p50/p90 (ms)   total p50/p90 (ms)");
  for (const cl of classes) {
    const rs = rows.filter((r) => r.class === cl);
    const fmt = (xs: (number | undefined)[]) => { const v = xs.filter((x): x is number => x !== undefined); return v.length ? `${percentile(v, 50)}/${percentile(v, 90)}` : "-"; };
    out.push(`${cl.padEnd(11)} ${String(rs.length).padStart(2)}  ${String(rs.filter((r) => r.pass).length).padStart(4)}  ${String(rs.filter((r) => !r.pass && !r.err).length).padStart(4)}  ${String(rs.filter((r) => r.err).length).padStart(3)}   ${fmt(rs.map((r) => r.firstSayMs)).padEnd(24)} ${fmt(rs.map((r) => r.totalMs))}`);
  }
  for (const cl of classes) {
    const bad = rows.filter((r) => r.class === cl && !r.pass);
    if (!bad.length) continue;
    out.push("", `-- ${cl}: ${bad.length} not passing --`);
    for (const r of bad) out.push(`${r.id}  [${r.fails.join("; ")}]  "${r.answer.replace(/\s+/g, " ").slice(0, 120)}"`);
  }
  return out.join("\n");
}
