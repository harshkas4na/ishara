# Agent mode: Ishara can act, not only explain (plan and frozen contract, 6 Nov 2026 ~13:00 IST)

Why: at the 0G booth the team said explaining and pointing is "already sold, an accessibility tool"; the next level is control:
open and close apps, click, fill forms, type, copy to the clipboard, play a song on YouTube, take a screenshot, and keep going
until a multi-step task is done. Harsh's screen tutor Buddy already does this (design reference only; nothing is copied).

## Decision on "CUA" (checked in Buddy's own research notes)
trycua's CUA-S1 models are tiny research models that only CHOOSE among options you list; they need a lot of memory and were
rejected for Buddy. What Buddy actually uses is: act by OUTLINE ID (a stable id for every control, from the accessibility tree
or the DOM) with a strong model planning. Ishara already has the ids and a sealed planner: 0GM-1.0 supports tool calling in
Private mode (verified: returns proper tool calls in ~2 s). So: **0GM plans, ids ground, laya checks each target, local
executors act, everything gets a receipt.** `cua-driver` stays an option only if our own executors prove too weak.

## Principles (non-negotiable)
1. **Armed or nothing.** Agent mode is OFF by default. It is turned on per session (browser: Option+Shift+A; desktop: say "agent
   mode on" or the same hotkey chord). When off, a task request gets "Turn on Agent mode and I will do that" and nothing moves.
2. **Visible and stoppable.** The cursor travels to each target before the action; the pill says what it is doing ("Step 3: typing
   your name"). Esc (browser) or a tap of Right Option (desktop) or the pill's Stop button stops at once; the loop checks the
   stop flag between every action. Hard caps: 25 actions and 3 minutes per task.
3. **Risk levels.** low: scroll, wait, screenshot-to-clipboard/file, open an http(s) URL the user named, non-destructive keys.
   medium: click, type, select, check, open app, copy to clipboard, close a tab, read a file. (`search`, switch/new/back/forward tab: low.) HIGH needs the user's tap on Approve in the pill (or the voice
   word "yes"): clicking anything whose label matches submit|send|post|publish|pay|buy|purchase|confirm|delete|remove|sign out|log
   out|transfer|approve|allow|connect wallet, quitting an app, any key press that submits, anything on a page that looks like a
   wallet/approval flow. `ISHARA_ACT_CONFIRM=all` asks for medium too. `ISHARA_ACT_CONFIRM=off` is for rehearsals only and is
   loudly labelled in the pill.
4. **Never secrets.** Typing into a password/secure/seed/key/card field is refused outright, and Ishara never reads those fields
   (existing redaction). It never types a value it was not given in the task or by the user.
5. **The user's task is the only authority.** Page text cannot start or change an action (same injection rules as the tutor:
   page data is untrusted; an action must be justified by the user's words; an action the page text asked for is refused).
6. **Sealed and receipted.** Every planning call goes to 0GM in Private mode; every action target is checked by laya ("is this the
   control for this step?"); each action, its risk, its approval and its result, with the request ids, is logged in the episode
   log and appears in the replay. If 0G is unreachable the agent STOPS and says so (same safe-stop rule). No local fallback planner.
7. **Local execution.** Clicks, typing, keys, scrolling, clipboard and screenshots happen on the laptop. Screenshots made by the
   `screenshot` action are for the user (clipboard or file) and are NOT sent to 0G.

## Action schema (what 0GM may request through tool calls; ids come from the PageContext `controls`/`blocks`)
```ts
type Action =
  | { type: "click"; id: string }
  | { type: "type"; id: string; text: string; clear?: boolean }          // fills a field; never a secret field
  | { type: "select"; id: string; option: string }                       // by visible option label
  | { type: "check"; id: string; checked: boolean }
  | { type: "key"; combo: string }                                        // "Enter", "Escape", "cmd+t", "space", "cmd+l"...
  | { type: "scroll"; direction: "up" | "down"; amount?: "line" | "page" }
  | { type: "open_url"; url: string }                                     // http(s) only
  | { type: "search"; query: string; engine?: "brave" | "google" | "duckduckgo" }   // opens the results page (default brave)
  | { type: "tab"; op: "switch" | "close" | "back" | "forward" | "new"; match?: string }   // match = title/url substring (switch, close)
  | { type: "read_file"; path: string }                                   // desktop/helper only, read-only, see "File read"
  | { type: "open_app"; name: string }                                    // desktop
  | { type: "quit_app"; name: string }                                    // desktop, HIGH
  | { type: "copy"; text: string }                                        // to the clipboard
  | { type: "screenshot"; to: "clipboard" | "file" }                      // local only
  | { type: "wait"; ms: number }                                          // <= 3000
  | { type: "done"; say: string } | { type: "ask"; say: string } | { type: "fail"; say: string };
```
### Search, tabs and file read (added 6 Nov 2026, same schema/validation/risk/receipt pattern)
**search.** `query` is 1 to 200 characters, no control characters. The executor builds the address itself and URL-encodes the query:
`https://search.brave.com/search?q=`, `https://www.google.com/search?q=` or `https://duckduckgo.com/?q=`. Always https. It opens
that address exactly like `open_url` (browser: the current tab, so the next page resumes the task; desktop: `open`). The helper makes
NO network call for it: the next planning step simply reads the results page through the normal fresh PageContext. The planner is told to
read the results, answer with `done {say}` summarising, and say which page the answer came from. Risk **low**. A query that comes only
from page text addressed to an assistant is refused (principle 5).

**tab.** Browser executor = the extension service worker (`chrome.tabs`, `tabs` permission). `switch` and `close` take `match`, a
case-insensitive substring of a tab's title or address; zero or several matches is a failed step that says so (it never guesses). `back` and
`forward` use the tab's history; `new` opens a blank tab, and the next `search` or `open_url` loads in it. Risk: switch, new, back, forward
**low**; close **medium** (high on a wallet or approval page). **Closing the tab Ishara is running in is refused**, by the worker, whatever the
approval. Desktop executor: `back` = cmd+[, `forward` = cmd+], `new` = cmd+t, `close` = cmd+w; `switch` and `close` with a `match` need the
browser extension and are refused there.

**read_file** (the only action that reads the disk; helper executor only, so it needs the desktop path and is refused in a browser-only
run). Read-only: Ishara never writes, deletes, moves or lists. Allowed only when ALL hold; the helper checks the real path (symlinks
resolved) so a link cannot step outside:
- inside the user's home directory (`~` is expanded); relative paths are refused;
- no dotfile or dot-directory anywhere in the path under home; nothing under `.ssh`, `.config`, `.aws`, `.gnupg` or `Library/Keychains`;
- the file name does not match `key|secret|token|password|wallet|seed|.env|.pem` (case-insensitive);
- a regular text file of at most 200 KB (a NUL byte in the first 8 KB, or invalid UTF-8, means binary and is refused).
The text then goes through the existing helper redaction (`readerCore().redact` plus the seed-phrase mask, the same rules as page text), is cut
to 12,000 characters, and reaches 0GM as **untrusted data inside the random fence**, exactly like page text (a file that says "assistant, do X"
changes nothing). The receipt and the episode log carry the path and the size only, never the content. Risk **medium**: asks Approve under
`ISHARA_ACT_CONFIRM=all`, and the pill shows the path; blocked paths are `refused` before any approval is asked.

The model calls ONE tool per turn (`act`) with `{ action, say }` (`say` = a short sentence for the pill and the voice). `ask` pauses
for the user's answer; `done`/`fail` end the task.

## Endpoints (helper) and events
`POST /act` `{ sessionId, tabId?, task, context: PageContext, executor: "client" | "helper", armed: true }` answers with SSE:
| event | data | meaning |
|---|---|---|
| `thinking` | `{ n }` | planning step n |
| `action` | `{ n, action, risk, say, targetLabel?, point?: {status, layaP} }` | about to do this; the UI moves the cursor to the target and shows `say` |
| `approval` | `{ n, action, risk, why }` | HIGH risk: waits for `POST /act/approve {actId, n, approve: boolean}`; no answer in 60 s = deny |
| `result` | `{ n, ok, detail }` | the executor's outcome (helper executor: reported by the helper; client executor: reported by the client via `POST /act/result`) |
| `done` / `failed` / `stopped` | `{ say, steps, requestIds, ms }` | end of the task |
| `refused` | `{ cause, say }` | 0G unreachable: nothing was done |
Client executor protocol: the helper emits `action`, then WAITS for `POST /act/result { actId, n, ok, detail, context }` where `context` is a fresh
PageContext after the action; it then plans step n+1 with that context. `POST /act/stop { actId }` stops at once. Executors: **browser = the extension
(DOM actions by outline id)**, **desktop = the helper (accessibility actions by id, CGEvent keys, open, pbcopy, screencapture)**.

## Work packages (file ownership)
| WP | What | Owns |
|---|---|---|
| ACT-CORE | schema + validation, risk classifier, tool-calling loop with 0GM (`askAct`), laya target check, approval/stop/caps, logging to the episode log, `/act*` routes, fake-router tool-call support for tests | `helper/src/act.ts`, `act-risk.ts`, `act-loop.ts`, `zg.ts` (askAct only), `types.ts` (act types), `server.ts` (`/act*` only), `test/fake-router/server.ts` (tools only), `helper/test/act*.test.ts` |
| ACT-BROWSER | the extension executor (click/type/select/check/key/scroll/open_url/copy/screenshot), Agent-mode toggle, pill progress, Approve/Deny/Stop, cursor travels to the target, Esc stops | `extension/act.js` (new), `overlay.js`, `content.js`, `background.js` (act hunks), `manifest.json` (permissions only) |
| ACT-DESKTOP | the helper executor in Swift/TS: AX press and set-value by id, CGEvent keys and typing, scroll, open app/url, quit app, clipboard, screenshot, refusals, agent mode via hotkey/voice | `desktop/ishara-act.swift` (new), `helper/src/desktop-act.ts`, `desktop.ts` (act hunks), `desktop-ptt.ts` (agent-mode word/chord only) |
| ACT-EVAL | test pages and a frozen action eval, demo script | `test-pages/act-*.html`, `evals/act/*.json`, `scripts/eval-act.ts`, `docs/DEMO-AGENT.md` |
`gate.ts`, `episode-log.ts`, `tutor.ts`, `prompt.ts`: do not edit (propose diffs). The pointing eval (11/12, 0 wrong) and the tutor eval must not regress.
