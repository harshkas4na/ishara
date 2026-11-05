# Interfaces

Three parts talk through one local helper. The helper listens on `http://127.0.0.1:7777`.
The 0G key is read by the helper from `~/.config/0g/key` and never leaves it.

## Outline (produced by the extension, one format for browser and later desktop)
```ts
type OutlineElement = {
  id: string;            // "b17" (b + index), stable within one compile
  label: string;         // visible text, aria-label, placeholder or nearby label, trimmed to 80 chars
  role: string;          // "button" | "link" | "input" | "select" | "checkbox" | "text" | ...
  rect: { x: number; y: number; w: number; h: number }; // viewport CSS pixels
};
type Outline = {
  url: string;
  viewport: { w: number; h: number };
  elements: OutlineElement[];
  text: string; // model-facing text, one line per element: [b17] input "Contract address" (text)
};
```

## Helper HTTP API
| Method + path | Body | Returns |
|---|---|---|
| `GET /health` | | `{ ok, whisper: boolean, key: boolean }` |
| `POST /transcribe` | raw audio bytes (`audio/wav`, 16 kHz mono), header `x-prompt` = optional vocabulary | `{ text, ms }` |
| `POST /decide` | `{ sessionId, question, outline }` | `Decision` |
| `GET /proof/:requestId` | | `Proof` |
| `POST /session/end` | `{ sessionId }` | `{ entries, root?, storage?, contract? , error? }` |
| `GET /log/:sessionId` | | `{ entries }` (local copy) |
| `GET /test/*` | | static files from `test-pages/` |

CORS: allow origins starting with `chrome-extension://` and `http://127.0.0.1:7777`.

```ts
type Decision = {
  outcome: "point" | "ask" | "ask_which" | "safe_stop";
  targetId?: string;            // set when outcome = "point"
  candidates?: string[];        // set when outcome = "ask_which" (2 ids)
  say: string;                  // short sentence shown in the UI, e.g. "Enter your contract address here."
  reason: string;               // one line for the debug panel
  safeStopCause?: "timeout" | "unavailable" | "offline";
  requestIds: { brain?: string; laya?: string };
  ms: { total: number; brain?: number; laya?: number };
};
type Proof = {
  requestId: string; provider: string; recoveredSigner: string; onChainSigner: string;
  match: boolean; fetchedAt: string; note: string; // note states the limit of the proof
};
```

## Gate input (pure function in `helper/src/gate.ts`)
```ts
type BrainResult = { ok: true; targetId: string | null; requestId?: string; ms: number } | { ok: false; cause: "timeout" | "unavailable" | "offline" };
type LayaResult  = { ok: true; choice: string; p: number; requestId?: string; ms: number } | { ok: false; cause: "timeout" | "unavailable" | "offline" };
function gate(brain: BrainResult, laya: LayaResult, shortlist: string[]): GateDecision;
```
`choice` is a shortlist id or `"none"`.

## Rules for everyone
- No fake or mock decisions in the product path. A test double may exist only under `test/`.
- Comment the why, not the what. Small commits, message says what changed.
- Never print the 0G key. Never commit secrets.
