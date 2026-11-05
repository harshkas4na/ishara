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
