# Desktop adapter

Lets the tutor work on any macOS app, not only the browser: the same streaming tutor as the extension (explain, point,
guide with steps, follow-ups, Hinglish) with spoken answers. `ishara-ax context` turns the frontmost window into a
`PageContext` (docs/TUTOR-INTERFACE.md section 1: `source: "desktop"`, controls `b0..` with state, text blocks `t0..`,
selection, focus, alert text), `helper/src/desktop.ts` redacts it with the browser reader's rules and runs
`tutorTurn`, and `ishara-overlay` draws and the helper's speaker talks while the answer streams.
The old pointing-only path (`ishara-ax outline`, `desktopOutline`, `decisionToOverlay`) is kept for scripts.

Nothing but the question and the redacted context text leaves the machine. No screenshot is ever sent or written to
disk: when the Accessibility tree is thin, the window is captured in memory (that window only, never what is drawn over
it), read by Apple's on-device Vision OCR, and the pixels are dropped; only the recognised text goes into the context.

## Redaction (same rules as the browser)
Everything read from the screen passes `redact`, `neutralize` and `safeText` from `extension/blocks-core.js` before it
leaves the process. **One source of truth, not a port:** `helper/src/redact.ts` evaluates that very file in a `vm`
context (the way `helper/test/blocks.test.ts` does), so the two paths cannot drift; `desktop-tutor.test.ts` proves parity
on the same fixtures. Secure text fields (AXSecureTextField) are never read: the Swift side does not fetch their value,
and the context says only "filled, N chars". Secret-named fields (seed, private key, password, token, cvv...) report
state, not content; secret-shaped text (64 hex, 12/24-word phrases, `sk-`, `ghp_`, JWTs, long base64) becomes
`[redacted]`; `[POINT:`, `[STEP`, `[WAIT]` and the fence markers in screen text are replaced with look-alikes.
The context is trimmed to about 3,000 tokens (headings and in-view blocks first). Ids are stable across re-reads of the
same window (a signature book in `desktop.ts`), so a walkthrough's "next" finds its target by id.

## Browsers belong to the extension
A browser seen through Accessibility is only its own chrome and tab titles (private tabs included), never the page body.
When the frontmost app is one of `BROWSER_BUNDLE_IDS` (Chrome, Brave, Safari, Arc, Edge, Firefox, Opera, Vivaldi and
their variants; one tested constant in `desktop.ts`) the desktop path reads nothing, sends nothing, records nothing for
the model and shows "In the browser, use Option+Space". `ishara-ax front` (no permission, ~30 ms) answers "which app".

## Build
```
npm run desktop:build        # ishara-ax, ishara-overlay, ishara-ptt (swiftc -O -swift-version 5)
swiftc -O desktop/ptt-post.swift -o desktop/ptt-post     # optional: synthetic key poster for tests
```
No dependencies. The binaries are gitignored. `helper/src/desktop.ts` exports `desktopContext()`, `buildContext()`,
`desktopAsk(question, deps)` (browser guard, context, `tutorTurn`, overlay + speech per event), `eventToOverlay()`,
`overlay.send(cmd)` and `warmDesktop()`.

## Permissions (grant to the app that launches it, e.g. Terminal, iTerm, VS Code; or to the binary if you run it directly)
- **Accessibility** (System Settings > Privacy & Security > Accessibility): required. Without it `ishara-ax`
  exits 2 and prints which permission and where; the helper shows that as a readable message.
- **Screen & System Audio Recording**: only for the OCR fallback. Without it OCR is skipped with a warning.
- **Input Monitoring**: required for push-to-talk, so the key tap can see the key. The tap is listen-only; it can not
  change or swallow a key.
- **Microphone**: required for push-to-talk. A missing permission prints
  `{"ev":"error","code":"input-monitoring"|"microphone","fatal":true,...}`, the overlay shows it once, and the daemon is
  not restarted (grant it, then restart the helper). A runtime microphone failure (device vanished) prints
  `"fatal":false`: the overlay says so and the next hold tries again.
The overlay needs no permission.

## Push-to-talk (any app except a browser)
**Hold Right Option alone for about a second to talk, release to send.** The daemon starts a take only after Right Option
has been held 350 ms with no other key, click or scroll in between, so a tap, Option+letter (typing a symbol), Left
Option, Option-click and any chord with another modifier do nothing. The pill shows PREPARING ("Getting ready…") until the mic is live,
then LISTENING ("Speak now") with level bars; release, and it shows "Transcribing…", "I heard: “…”", then the sentence being
spoken (cursor, boundary or highlighter, voice). Pressing the key again at any time cuts the voice and the running answer off.
No right Option on your keyboard? `ISHARA_PTT_KEY=ctrl+opt+cmd+space` (any modifiers plus one key; at least one
modifier). Do not use Ctrl+Option+Space: if the macOS input-source shortcuts (System Settings > Keyboard > Keyboard
Shortcuts > Input Sources) are enabled, macOS handles it first.
```
npm run desktop:build
npm run helper:desktop        # ISHARA_DESKTOP=1 ISHARA_DEV=1; starts the key daemon only in this mode
curl 127.0.0.1:7777/desktop/ptt   # {"running":true,"chord":"rightoption"} or lastError
```
Same refusals as the browser: under 0.25 s is "too short", a take quieter than RMS 0.006 is "I could not hear any
sound", and Whisper's stock noise phrases are shown, not sent. Audio lives in memory only, goes to the local Whisper
server, and is never written to disk. `ISHARA_PTT_DEBUG=1` logs key-state changes (never other keys) to stderr.

The microphone engine is built fresh for every take and installed with the input node's real format, so switching input
devices (AirPods connecting, a call app reconfiguring the mic) cannot crash the daemon; a device change during a take
rebuilds the engine and keeps the audio so far. The tap can not swallow keys, so the focused app still sees Right Option
(modifier-only: nothing visible). A walkthrough ("walk me through ...") continues with "next", "back", "repeat", "stop"
spoken as normal questions; its key is `desktop:<frontmost bundle id>`, so it survives turns in the same app and is
dropped for another app or after 10 idle minutes. A window-title change (a new page in Settings) resets follow-up memory.

## Try it
```
node scripts/desktop-demo.ts --context --app "System Settings"          # PageContext summary, no 0G
node scripts/desktop-demo.ts --outline-only --app "System Settings"     # old outline, no 0G
sleep 3; node scripts/desktop-demo.ts "where is the search box"         # real tutor turn: streams, draws, speaks
curl -s 127.0.0.1:7777/desktop/ask -d '{"question":"what is this window for"}'   # same, through the helper
echo '{"cmd":"say","text":"Hello.","append":false}' | desktop/ishara-overlay
```
Overlay commands (one JSON per line on stdin; coordinates are screen points, top-left origin). The design is
docs/UI-PILL.md: the whole answer is NOT drawn, only a pill with the sentence being spoken.
- `state{state,text?,sub?}`: the pill. `preparing` (amber pulse, "Getting ready…"), `listening` (blue bars, "Speak now"),
  `thinking` (dancing dots, text = what was heard; the cursor also traces a figure-eight), `speaking`, `refused` (red,
  `sub` on a second line), `idle` (hide). `level{rms}` moves the listening bars. `speaking{text}`: the voice STARTED this
  sentence, the pill shows exactly it (long sentences are paged, two lines at a time); `text:""` = the voice went quiet.
  `say{text,append}`: a streamed sentence, queued and shown at least 1.5 s each; ignored once `speaking` events arrive
  (muted voice or no events: this is the fallback). `steps{n,m}`: guide chip "n/m" plus the buttons; `m<=1` hides them.
- `point{x,y,rect?,kind?,keep?,text?}`: the cursor glides (0.75 s) to x,y, ripples, then marks `rect`: `kind:"control"`
  (default) a rounded boundary, 2.5 pt #3b82f6 with a glow, drawn like a pen stroke over 0.5 s; `kind:"block"` a #fde047
  band at 35% sweeping in left to right. A second point in the same answer dims the first (two marks at most). The pill
  hops to the top edge when a mark would be under it.
- `done`: linger (7 s, 180 s in a guide), a cursor that never pointed goes away. `clear`: hide everything.
- Old commands still work: `think{text}` (= thinking; its "Getting ready…" and "Listening…▮▮" texts map to preparing and
  listening), `ask{text}` (neutral pill), `stop{text,sub}` (= refused), `step{n,m}` (= steps), `point` without `keep`
  (its `text` goes in the pill).

The pill lives in its OWN borderless non-activating panel (never key, never takes focus, all Spaces, above full-screen
chrome); the big drawing window stays `ignoresMouseEvents`. In a guide a second tiny panel covers only the three
buttons ‹ › ✕ (the only place a click is taken). A press prints `{"ev":"walk","cmd":"back|next|stop"}` on the overlay's
stdout; `helper/src/desktop.ts` reads it and runs `desktopAsk("back"|"next"|"stop")`, the same utterance the voice words
produce, so the router's walk for `desktop:<bundle id>` handles it. Voice commands keep working.

Look: needle cursor, pill #1f1147 at 92% (refused #7f1d1d), 15 pt text, 2 lines, up to 520 pt wide, 16 pt corners.
Placement: bottom-centre, about 120 pt above the bottom edge of the screen that holds the target or the frontmost window.
With Reduce Motion on there is no pulse, dance, glide, ripple, pen stroke or sweep: the final state just appears.

## Measured (M-series, macOS 27, 1470x956 points)
- AX walk: System Settings 39 controls in about 0.2 s; context incl. window-only OCR 0.5 s. Finder with no window: 0.
- OCR (accurate): 0.3-0.5 s warm. **First call after boot: 56 s** (model load). `warmDesktop()` runs at helper start.
- OCR runs when AX yields fewer than 25 labelled items or under 300 characters of prose.
- PTT: recorder start 100-130 ms after the 350 ms mark; ten holds in a row and input-device switches (also mid-hold)
  caused no crash.

## Known limits
- Apps with no AX tree (some Electron/canvas/games) fall back to OCR: text blocks only, no controls.
- Several displays: the pill and cursor go on the screen with the target or the frontmost window (code path; not
  tested with two monitors). The overlay window is sized at launch: a display attached later needs an overlay restart.
- Full-screen apps and other Spaces: the overlay joins all Spaces; not tested over every full-screen app.
- Elements outside the visible window, scrolled-off rows and the menu bar are skipped on purpose (text areas keep
  their off-screen paragraphs as `inView:false` blocks).
- Rects are screen points, not window-relative; `viewport` is the window size.

## Listening start (pre-roll, measured)
Capture starts at the **key-down**; the 350 ms hold only decides whether the take is kept. A release or another key/click
inside 350 ms discards the take (`cancel`, audio dropped from memory). Daemon events: `down`, `live {ms}` (first real buffer),
`confirmed`, `cancel`, `level`, `up`. The helper shows nothing for the first 120 ms (so taps flash nothing), then
"Getting ready…" until `live`, then "Speak now" plus a soft tick (`ISHARA_TICK=0` mutes it). The engine is built and
prepared but not started while idle (mic dot off, checked with CoreAudio DeviceIsRunningSomewhere); after a confirmed take it
stays running 8 s (dot on for 8 s) so follow-ups start instantly.
Measured key-down -> `live`, 10 trials each: cold (engine idle) median 140 ms (137-148); warm median 35 ms (1-73). Before: capture
began ~350 ms + 115 ms after the key-down, so about 0.5 s of speech was lost. A Right-Option tap, Option+letter and Right
Option + Space all give `down` then `cancel`; in a browser nothing is shown, no tick, and the voice is not interrupted.
Synthetic check: `desktop/ptt-post roptSpace 600`.

## Agent mode (the desktop does things, not only explains)
Plan and contract: docs/AGENT-MODE.md. On the desktop the executor is `desktop/ishara-act` (Swift) driven by
`helper/src/desktop-act.ts`; the sealed planning loop is `POST /act` with `executor:"helper"`. Browsers stay with the extension.

**Arm it by voice (hold Right Option):** "agent mode on" / "agent mode off", Hinglish "agent mode chalu karo" / "agent mode band karo".
Only a sentence that IS the command counts, so "what does agent mode do?" still reaches the tutor. It is OFF on every helper start
(memory only, nothing is saved: an agent that wakes up armed is a safety bug). While armed the pill carries an "Agent" chip.
Without a mouse over HTTP: `curl 127.0.0.1:7777/desktop/ask -d '{"question":"agent mode on"}'`, then the task the same way.

**While armed**, a task sentence (open, go to, click, press, type, enter, fill, scroll, copy, play, pause, search, select, close, quit,
take a screenshot; Hinglish kholo, bharo, likho, chalao, dabao, band karo) goes to the act loop. Questions keep going to the tutor.
While it is OFF, a task sentence gets "Turn on Agent mode and I will do that." and nothing moves.

**What each action does** (`desktop/ishara-act`, one JSON action on stdin, one `{ok, detail}` on stdout):
| action | what happens |
|---|---|
| click | `AXPress` on the control found by its stable selector; if AX cannot press it, ONE coordinate click at its centre (never on a secret field) |
| type | sets `AXValue` of a text field; if AX refuses, focuses it, selects all (when replacing) and types with keyboard events. Secure/password/seed-named fields: refused, `secret field` |
| select | opens the pop-up (`AXShowMenu`) and presses the item with that label |
| check | reads the state and presses only if it differs |
| key | `cmd+t`, `Enter`, `space`, ... as key down/up with the modifiers held, to the front app |
| scroll | wheel event at the window centre, a few lines or a page |
| open_app / quit_app | by name or bundle id; waits up to 5 s for it to be frontmost / `terminate()` only, never force (an unsaved document keeps its own Save sheet) |
| open_url | http(s) only, in the default browser |
| copy | the pasteboard; the loop sees "copied N characters", never the text |
| screenshot | the front window to `~/Desktop/Ishara-<time>.png` AND the pasteboard. Local only, never sent anywhere (needs Screen Recording) |

**How it finds the control.** `ishara-ax context` adds a `selector` per control (role, raw AX role, label, index among same-labelled
controls in reading order, secure flag). The helper sends it with the window title and the rect as a hint; `ishara-act` walks the front
window with the same rules and re-finds it, so nothing relies on a pointer that died between processes. If the front app changed, or
the label is gone, it says so and does nothing.

**Visible and stoppable.** Before each targeted action the overlay cursor travels to the control (about 0.7 s) and the pill shows the step
("Step 3", the model's sentence, a stop button). A tap of **Right Option** while a task runs stops it (the daemon's `cancel` event is the
stop chord), as do the words "stop" / "ruko", the pill's stop button and `POST /act/stop`; the stop flag is checked between every step
and again after the cursor arrives. Caps: 25 actions, 3 minutes.

**Approval.** A HIGH-risk action (quit an app, submit/send/delete/pay clicks, ...) shows the action in words with "Say yes to approve, no to
cancel." and approve/deny buttons. "yes / yeah / haan / ok do it / go ahead" approve, "no / stop / nahi / cancel" deny, anything else leaves
it open; no answer in 60 s is a no. Overlay lines: `{"ev":"approve","approve":true|false}` and `{"ev":"agent","cmd":"stop"}`.

**Overlay commands added:** `agentmode{on}`, `agent{text,step,risk}` (step 0 ends the task), `approval{text,sub}`.

**Permissions.** Accessibility is required (grant it to the app that starts the helper; without it `ishara-act` exits 2 and names it).
Screen Recording is needed only for `screenshot` (and the OCR fallback). `npm run desktop:build` builds `ishara-act`.

**Safety rules.** Armed or nothing. Secret fields are never typed into and never read. Page or window text cannot start an action (only
the user's sentence can; the core checks every target with laya). Actions in a browser are refused here ("use the browser extension").
Clipboard text and screenshots never go to 0G. The loop stops if 0G is unreachable.

**Measured on this Mac (macOS 27).** `press` 150 ms, `key` 85 ms end to end. TextEdit: open, new document, type, select font, toggle bold,
`cmd+a`/`cmd+c`, scroll, screenshot, quit (the Save sheet is answered by the user or a separate `Delete` press); System Settings sidebar
press changed the pane (re-read title Bluetooth, then Wi-Fi). Typing by keyboard events needs the combined-session event source (the HID
source was dropped by TextEdit).
