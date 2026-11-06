# Testing the extension (Chrome)

The helper must be running first (`http://127.0.0.1:7777`, see the helper's README). Check it:
open `http://127.0.0.1:7777/health` and expect `{"ok":true,...}`.

> The manifest pins the extension id (`klblmocbilliepigooglmeaalncfggbg`) so the helper accepts requests from this
> extension only. If you loaded an earlier build, **remove it and Load unpacked again** (the id changed), then allow
> the microphone once more on the setup page.

## 1. Load it
1. Open `chrome://extensions`, switch on **Developer mode** (top right).
2. **Load unpacked**, choose the `extension/` folder of this repo.
3. After any code change press the reload arrow on the Ishara card, then reload the page you test on
   (content scripts only attach to pages loaded after the extension).

## 2. Grant the microphone (once)
Click the Ishara toolbar icon (pin it from the puzzle menu if hidden). A tab "Ishara microphone setup"
opens. Press **Allow microphone**, choose Allow. It says "Microphone allowed". The permission belongs to
the extension, so no per-website prompt follows. If you pressed Block by mistake: `chrome://settings/content/microphone`,
remove the block for the `chrome-extension://...` entry, repeat.

Why this way: a content script asking for the mic would prompt on every website; an offscreen document
inside the extension reuses the single grant.

## 3. Open the test page
`http://127.0.0.1:7777/test/etherscan-verify.html`

## 4. Keys
| Keys | Does |
|---|---|
| Hold **Option+Space** (Alt+Space), speak, release | push-to-talk |
| **Alt+Shift+Space** | type-instead box; type, Enter (Esc closes). Use this if there is no mic. |
| **Alt+Shift+D** | debug panel |
| **Esc** | clear the pointer and bubble |

On macOS the chords are matched on physical keys, so Option typing a special character does not matter.
Hold at least a quarter second of speech or you get "too short".

## 5. What to expect for each outcome
Use the type box first (no mic, no Whisper needed).

- **point**: ask "where do I put the contract address". A purple ring glides to the contract address
  field, the page scrolls if needed, a dark bubble says the sentence. The ring follows the field if you scroll.
- **ask**: ask something vague like "help". Only a bubble with a question. No ring ever appears.
- **ask_which**: ask "where do I choose the version" while two things fit, or "the compiler". Two
  orange boxes surround the candidates and the bubble asks which one.
- **safe_stop**: stop the helper's route to 0G (for example start the helper with no key, or offline). A red
  bubble "I can't decide right now" with the cause (timeout / unavailable / offline). No ring. If the
  helper itself is not running you get a red "Ishara helper problem: helper not reachable", which is an
  extension error and not a decision.

## 6. Debug panel and "How do I know?"
Alt+Shift+D shows the last decision: outcome, target, reason, total / brain / laya milliseconds, outline
compile time and request ids. "How do I know? (brain)" fetches `/proof/:requestId` and lists the Proof
fields, including the note that states the limit of the proof. "End session" calls `/session/end`.

## 7. Voice check
Hold Option+Space, say "where do I paste my source code", release. Debug panel shows the question
(the transcript). If the transcript is wrong the problem is in the helper's Whisper, not the extension.

## Limits (known, by design)
- Iframes and shadow DOM are not walked; controls inside them are invisible to Ishara.
- Elements below the fold are listed but cannot be hit-tested for occlusion; those inside the viewport are.
- At most 150 elements per compile, labels cut at 80 characters.
- Chrome does not run content scripts on `chrome://` pages, the Web Store, or PDFs.
- Some sites capture Option+Space before the extension; use the type box there.

## What was not verified when this was written
Written without a browser: only `node --check` on every file and a node check of the WAV encoder. Loading
in Chrome, mic capture, outline token size and timing, and the overlay were not run.

## Testing without 0G (test router)
If the real models are down, run `npm run fake-router` and, in another terminal, `npm run helper:fake` (stop any other
helper first, both use port 7777). Answers then come from a word-overlap stand-in: the debug panel shows an amber
"TEST ROUTER: not a real 0G answer" banner and the bubble ends with "(test router)". This checks mechanics only.
Rehearse failures with `FAKE_ROUTER_MODE=down|slow|flaky npm run fake-router`. Never quote accuracy or eval numbers
from this mode; they must come from the real router.

## Iframes
Open `http://127.0.0.1:7777/test/iframe-demo.html`, press **Alt+Shift+O**: a numbered box should sit on the controls
inside both embedded forms (one same-origin, one at `localhost:7777`, a different origin). Then ask about a field
inside one ("where do I put my work email") and the pointer lands inside the frame.

How it works: the content script runs in every frame. Only the top frame draws and listens; each child compiles its
own outline, and the top asks it over `postMessage` (250 ms budget, a silent frame is skipped) and translates the
rects. Chords typed while focus is inside a frame are forwarded to the top.

Works: same-origin and cross-origin iframes the extension can inject into (nested ones too), iframes in open shadow
roots, `about:blank` / `srcdoc` frames.
Does not: sandboxed frames without `allow-scripts` (the page's script rules apply to our injection), frames that
block extension injection, closed shadow roots, `chrome://` and Web Store pages, and controls scrolled out of the
frame's own viewport (the frame has to show them). Pointing at a frame control does not record the "accepted" signal.
Privacy note: the messages are visible to the pages involved, so a hostile parent page could ask an embedded frame for
its control labels (never typed values).

## Tutor UI (streaming answers, steps, conversation)
The extension asks `POST /tutor` (SSE, docs/TUTOR-INTERFACE.md) through a port to the service worker; `extension/sse.js`
parses the stream. If the helper has no `/tutor` (404) the old `/decide` path runs unchanged.

| Keys | Does |
|---|---|
| **Alt+Shift+C** | conversation panel: last 10 turns, mode chip, timings, "How do I know?", TEST ROUTER banner |
| **Alt+Shift+P** | toggle CLASSIC (pointing only, `/decide`); stored in `chrome.storage.local.classic`, shown in the panels |
| **Esc** | cancels the stream and speech, clears the bubble |

Without 0G: `http://127.0.0.1:7777/test/tutor-preview.html?state=explain|point|two|guide|refused|cutoff|suppressed|rejected|long|chat|testrouter`
(add `&step=3` to guide). Scripted events, no network. The bottom line of that page runs the SSE parser cases in the browser.
Unit tests: `node --test helper/test/sse.test.ts` (parser: chunks, CRLF, comments, UTF-8 splits; relay: offline, 404, cutoff, abort).

Real flow (helper on 7777, `/test/etherscan-verify.html`): press Alt+Shift+Space with a REAL key event, type a question, Return.
Expect: dancing cursor and "You/I heard" line at once, then sentences fading in, the ring only after a confirmed pointer,
a muted chip for rejected/suppressed pointers, red bubble with the cause when 0G is unreachable, "(cut off, ask again)" on a
cut stream. Guide mode shows "Step n of m", dots and Back / Next / Stop once the helper sends `step` events.

## UI v2: the pill (docs/UI-PILL.md)
The tutor no longer prints the answer on the page. One dark pill sits bottom-centre (it hops to the top edge when the
pointed target is under it) and shows the sentence being spoken; the full answer is in the conversation panel (Alt+Shift+C).
- Dot: amber pulse = getting ready, blue bars = listening (level), dancing dots = thinking (shows "I heard: ..."),
  purple bars = speaking, red = refused. Karaoke: the text changes on each `speaking {seq}` event; with no such event within
  1 s of the first `say` (muted voice) each sentence shows for at least 1.5 s.
- Marks: CONTROLS get a blue rounded boundary drawn like a pen stroke; TEXT gets a yellow highlighter band per line.
  A second pointer in one answer dims the first. Rejected/suppressed pointers get no mark, only a short chip on the pill.
- Guide: the pill shows `n/m` and ‹ › ✕ buttons (the only clickable part). Keys: Option+Shift+Right / Left / Escape.
  Controls appear from the first `step` event, or from `done.plan` when the helper sent no `step`. They are greyed while a
  stream is still in flight (the helper starts the walk only when the stream ends).
- `Ishara.overlay.setListening("preparing" | "listening" | null)` drives the pill for push-to-talk.
- Preview without 0G: `http://127.0.0.1:7777/test/tutor-preview.html?state=preparing|listening|thinking|speaking|boundary|highlight|multiline|hop|two|guide|plan|refused|...`
  plus `&dark=1` (dark host page) and `&novoice=1` (no `speaking` events: tests the 1.5 s fallback).
- Real check: Alt+Shift+Space (a REAL key press), type "walk me through verifying my contract step by step" on
  `/test/etherscan-verify.html`, wait ~8 s, click ›, three times. Expect `1/6`, `2/6`, `3/6` and the sentence changing.
- A tab only renders its own turn: the relay port is per tab and per turn, and the overlay ignores `say`/`speaking`
  without an active turn.
