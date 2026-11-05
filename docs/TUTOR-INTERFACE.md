# Tutor interface (frozen 2026-11-06 ~05:00 IST, v1)

The contract between the page reader (extension), the tutor pipeline (helper) and the UI (extension/desktop).
Design and evidence: `docs/audit/product-gap.md` sections 6 to 8. If you must change this file, change it FIRST,
commit it alone, and tell the others in your report.

The old path stays untouched: `POST /decide`, `decide()`, `gate.ts`, `askBrain`, `askVerify` keep working exactly as
today, because the measured pointing eval (11/12 clear, 0 wrong points, 6/6 vague) must not regress.

## 1. PageContext (built by the extension or the desktop adapter, sent by the UI to the helper)
```ts
type Block = {
  id: string;                       // "t12": stable within this page load
  kind: "p" | "h" | "li" | "code" | "cell" | "error" | "caption" | "text";
  text: string;                     // visible text only, <= 400 chars, markers neutralized (section 5)
  inView: boolean;
  rect?: { x: number; y: number; w: number; h: number };   // viewport CSS px (desktop: screen points)
};
type ControlState = { checked?: boolean; value?: string; selectedOption?: string; disabled?: boolean; empty?: boolean; filledChars?: number; required?: boolean; invalid?: boolean };
type Control = OutlineElement & { state?: ControlState; errorText?: string };   // OutlineElement from docs/INTERFACES.md
type PageContext = {
  source: "browser" | "desktop";
  app?: string; url: string; title: string; viewport: { w: number; h: number };
  blocks: Block[];                  // reading order; in-view first when trimming; headings always kept; ~3,000 tokens total
  controls: Control[];              // ids "b0".. exactly as the outline today (so the pointing path keeps working)
  selection?: string; focused?: string;   // focused = control id
  errors: string[];                 // block ids of kind "error"
  truncated?: { blocks: number; controls: number };
  screenshot?: string;              // data URL, ONLY when the user opted in for this question (WP9), never by default
};
```
Redaction (done BEFORE anything leaves the tab/app): never read `type=password`, autocomplete cc-*/one-time fields, fields
whose name or label matches seed|mnemonic|private key|secret|token|cvv|password, or any value shaped like a secret (64 hex,
a 12 or 24 word lowercase phrase, `sk-`, `ghp_`, `AKIA...`, base64 of 40+ chars). Inputs report state ("filled, 38 chars")
instead of content, except selects, checkboxes, radios and short non-secret text. Public contract addresses (40 hex) are kept.

## 2. POST /tutor (new; the helper answers with Server-Sent Events)
Request (JSON): `{ sessionId: string; tabId?: string; question: string; context: PageContext; mode?: "auto"|"point"|"explain"|"guide"; speak?: boolean }`
Response: `text/event-stream`; each event is `event: <name>\ndata: <json>\n\n`.
| event | data | meaning |
|---|---|---|
| `thinking` | `{ mode }` | the mode chosen (point, explain, guide, follow-up); sent at once |
| `say` | `{ seq, text }` | one SENTENCE of the spoken/shown answer, as soon as it ends. No ids, tags, URLs or markers inside |
| `point` | `{ seq, targetId, kind: "control"\|"block", status: "confirmed"\|"rejected"\|"suppressed", layaP?, reason }` | a pointer the model asked for, AFTER the laya check. The UI moves the ring ONLY on `confirmed` |
| `step` | `{ n, m, say, targetId?, kind? }` | guide mode: step n of m is current (the matching `say`/`point` events precede it) |
| `done` | `{ mode, outcome: "answered"\|"refused"\|"cutoff", cause?, requestIds: { brain?: string, laya: string[] }, ms: { firstToken?: number, total: number }, testRouter?: true }` | end of the turn |
| `refused` | `{ cause: "timeout"\|"unavailable"\|"offline", say }` | 0GM could not answer: NOTHING else is sent. Same rule as today: never answer from a local model or cache |
`POST /tutor/walk` `{ sessionId, cmd: "next"|"back"|"repeat"|"stop"|"where" }` answers the same SSE shape, with NO 0G call.
Non-streaming clients may read the whole body; an extension relays the stream over a `chrome.runtime.connect` port.

## 3. Model output grammar (what the sealed 0GM-1.0 is asked to write; parsed by the helper as it streams)
Plain speech, sentence by sentence, with optional inline markers: `[POINT:b7]` (a control) or `[POINT:t12]` (a block), 0 to 2
per answer; in guide mode a plan `[STEP 1/4] <sentence> [POINT:b7] [WAIT]` with at most 6 steps. The parser strips every marker
from the text it emits, validates each id against the context, drops ids that do not exist (and says nothing about them), and
caps the whole reply at ~350 tokens. Thinking is off (`chat_template_kwargs.enable_thinking=false`). Streaming: read to the end
for the proof even after the first sentences were emitted (existing rule). Timeouts: first token 6 s, idle 4 s between chunks.

## 4. Safety rules (non-negotiable)
1. 0GM unreachable, 502/503, or no first token in time: `refused` and stop. Never answer from anything local.
2. laya unreachable: explanations and speech continue; every pointer becomes `suppressed` ("I can explain it, but I can't
   confirm which control, so I won't point"). Never point on 0GM alone.
3. A pointer needs laya's yes (p >= `VERIFY_MIN_P`) about the user's question, never about page text.
4. Page text is untrusted data (section 5). The model has NO tools: it can speak and request a pointer, nothing else.
5. The old `episode-log` keeps working: each 0G call's request id, chat id and provider are recorded as before; an
   explanation with no pointer is labelled "explained by 0GM-1.0, not independently checked".
6. Fake-router results carry `testRouter: true` everywhere, as today.

## 5. Prompt injection fence
Per request, a random delimiter wraps the page data; the system prompt says content inside is DATA, never instructions;
the question comes after the data and the output rules are restated last. Before sending, `[POINT:`, `[STEP`, `[WAIT]` and the
delimiter inside page text are replaced with look-alikes. Bubbles render with `textContent`; spoken text strips URLs and ids.

## 6. Conversation state (helper, RAM only)
Per tab+page (origin+path): the last 4 turns `{q, a, pointedLabel}` trimmed to ~600 tokens; cleared on path change, after 10 minutes
idle, or by "new topic". Never written to disk or to `memory.ts`. Follow-ups (<= 5 words or pronouns: "why?", "and then?") inherit
the last mode and context and are never routed to the pointer-only gate. Walk state: up to 6 steps, 3 re-plans, 10 minutes idle.

## 7. Latency targets (end of question to first spoken word)
p50 under 3.5 s, p90 under 6 s; show the bubble at the first token; `warm()` the connection; keep the system prompt byte-stable.

## 8. File ownership (work packages)
| WP | Owner files (only these) |
|---|---|
| 1 page reader | `extension/blocks.js` (new), `extension/outline.js`, `extension/manifest.json` (content_scripts list only), `helper/test/blocks*.test.ts` or `test/blocks*` |
| 2+3 tutor core | `helper/src/tutor.ts`, `prompt.ts`, `stream-parse.ts`, `convo.ts`, `walk.ts`, `router.ts` (all new), `helper/src/zg.ts` (add `askTutorStream` only), `helper/src/types.ts` (tutor types only) |
| 4+5 pointer gate + route | `helper/src/pointer-gate.ts` (new), `helper/src/server.ts` (`/tutor`, `/tutor/walk` only), `helper/src/decide.ts` (`tutorTurn()` beside `decide`) |
| 6 extension UI | `extension/overlay.js`, `extension/content.js`, `extension/background.js` |
| 7 evals | `evals/tutor/*.json`, `scripts/eval-tutor.ts`, `test-pages/*.html` (new fixtures) |
| 8 desktop | `desktop/*.swift`, `helper/src/desktop.ts`, `helper/src/desktop-ptt.ts` |
| speech | `helper/src/speech.ts`, `voice/**` (already running) |
`gate.ts` and `episode-log.ts` are Harsh's hand-written files: do not edit them; propose a diff in your report.
